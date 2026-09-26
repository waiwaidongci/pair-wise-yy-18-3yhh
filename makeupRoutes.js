// 业务文件一：请求入口
// 负责：补妆登记 / 复看结论 / 复核档案查询 / 油漆批次档案的 HTTP 入口、参数校验、
//       装配偶头主档服务并串联判定与档案两个业务文件。
const express = require('express');
const { query, exec, sqlValue } = require('./db');
const rules = require('./makeupRules');
const archive = require('./makeupArchive');

const router = express.Router();

// ---- 偶头主档服务（读写通用 records 表中的 puppetHeads） ----

const puppetHeadService = {
  getHead(id) {
    const row = query(
      "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " +
        sqlValue(id) +
        ' LIMIT 1;'
    )[0];
    if (!row) return null;
    const data = JSON.parse(row.data || '{}');
    return { id: row.id, status: row.status, role: data.role, play: data.play, data };
  },
  syncStatus(id, makeupStatus, event) {
    // 补妆复核状态直接映射为偶头主档状态；只有复看通过才回到「可演出」
    const headStatus = makeupStatus === '可演出' ? '可演出' : makeupStatus;
    const head = this.getHead(id);
    if (!head) return;
    const data = { ...head.data, status: headStatus, currentUsable: headStatus === '可演出' };
    const title = [data.role, data.play].filter(Boolean).join(' / ') || data.name || data.code || '';
    exec(
      'UPDATE records SET status = ' + sqlValue(headStatus) +
      ', title = ' + sqlValue(title) +
      ', data = ' + sqlValue(JSON.stringify(data)) +
      ', updated_at = ' + sqlValue(new Date().toISOString()) +
      ' WHERE id = ' + sqlValue(id) + ';'
    );
    exec(
      'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
      [
        sqlValue(require('crypto').randomUUID()),
        sqlValue(id),
        sqlValue('puppetHeads'),
        sqlValue(event.action),
        sqlValue(headStatus),
        sqlValue(event.actor || ''),
        sqlValue(event.note || ''),
        sqlValue(JSON.stringify(event.data || {})),
        sqlValue(new Date().toISOString())
      ].join(', ') +
      ');'
    );
  }
};
archive.setPuppetHeadService(puppetHeadService);

// ---- 参数校验 ----

function requireFields(body, fields) {
  const missing = fields.filter(
    (field) => body[field] === undefined || body[field] === null || body[field] === ''
  );
  if (missing.length) {
    const error = new Error('缺少必填字段：' + missing.join('、'));
    error.status = 400;
    throw error;
  }
}

function toInt(value, field, { allowNull = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (allowNull) return null;
    const error = new Error(field + ' 必须是整数');
    error.status = 400;
    throw error;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    const error = new Error(field + ' 必须是整数');
    error.status = 400;
    throw error;
  }
  return n;
}

// ---- 1. 补妆登记入口 ----
// POST /api/makeupReviews
// body: puppetHeadId, play, role, colorNo, batch, dryMinutes, lampValue, painter[, paintedAt, note]
router.post('/makeupReviews', (req, res, next) => {
  try {
    requireFields(req.body, [
      'puppetHeadId',
      'play',
      'role',
      'colorNo',
      'batch',
      'dryMinutes',
      'lampValue',
      'painter'
    ]);
    const dryMinutes = toInt(req.body.dryMinutes, 'dryMinutes');
    if (dryMinutes < 0) {
      return res.status(400).json({ error: '干燥分钟数不能为负' });
    }
    const lampValue = toInt(req.body.lampValue, 'lampValue');

    const head = puppetHeadService.getHead(req.body.puppetHeadId);
    if (!head) return res.status(404).json({ error: '偶头不存在：' + req.body.puppetHeadId });

    // 批次必须先入批次档案
    const batchInfo = archive.getBatch(req.body.batch);
    if (!batchInfo) {
      return res
        .status(400)
        .json({ error: '油漆批次未登记，请先通过 /api/paintBatches 建档：' + req.body.batch });
    }

    const input = {
      puppetHeadId: req.body.puppetHeadId,
      play: String(req.body.play),
      role: String(req.body.role),
      colorNo: String(req.body.colorNo),
      batch: String(req.body.batch),
      dryMinutes,
      lampValue,
      painter: String(req.body.painter),
      paintedAt: req.body.paintedAt
    };

    const standard = rules.findStandard(input.play, input.role);
    // 再次用入参核对标准（档案层也会判一次，这里提前给出可读提示）
    const review = archive.registerReview(input);

    res.status(201).json({
      review,
      headStatus: puppetHeadService.getHead(input.puppetHeadId).status,
      verdict: {
        standard: standard
          ? { play: standard.play, role: standard.role, standardColor: standard.standardColor, lampBase: standard.lampBase }
          : null,
        hint:
          review.status === '待复检'
            ? '初判不通过，已转待复检；需修正后由另一名化妆师复看'
            : '初判通过，待干燥满四小时（' + review.eligibleRecheckAt + '）后由另一名化妆师复看'
      }
    });
  } catch (error) {
    next(error);
  }
});

// ---- 2. 复看结论入口（另一名化妆师） ----
// POST /api/makeupReviews/:id/recheck
// body: reviewer(必填且不同于补妆人), pass, dryMinutes(>=240), note?, lampValue?
router.post('/makeupReviews/:id/recheck', (req, res, next) => {
  try {
    requireFields(req.body, ['reviewer', 'pass', 'dryMinutes']);
    const review = archive.getReview(req.params.id);
    if (!review) return res.status(404).json({ error: '复核档案不存在：' + req.params.id });

    const dryMinutes = toInt(req.body.dryMinutes, 'dryMinutes');
    const pass = req.body.pass === true || req.body.pass === 'true';
    const lampValue =
      req.body.lampValue === undefined || req.body.lampValue === ''
        ? undefined
        : toInt(req.body.lampValue, 'lampValue');

    // 复看人必须是另一名化妆师
    if (review.painter && String(req.body.reviewer) === review.painter) {
      return res.status(400).json({
        error: '复看人不能与补妆人相同，需另一名化妆师复看',
        painter: review.painter
      });
    }
    if (dryMinutes < rules.MIN_DRY_MINUTES) {
      return res.status(400).json({
        error: '干燥未满四小时，暂不能复看',
        dryMinutes,
        required: rules.MIN_DRY_MINUTES,
        eligibleRecheckAt: review.eligibleRecheckAt
      });
    }

    const updated = archive.resolveReview(review.id, {
      pass,
      reviewer: String(req.body.reviewer),
      dryMinutes,
      note: req.body.note,
      lampValue
    });
    const head = puppetHeadService.getHead(updated.puppetHeadId);
    res.json({
      review: updated,
      headStatus: head ? head.status : null,
      result: pass ? '通过，偶头恢复可演出' : '未通过，维持待复检'
    });
  } catch (error) {
    next(error);
  }
});

// ---- 3. 复核档案查询 ----
// GET /api/makeupReviews?status=&puppetHeadId=&active=1
router.get('/makeupReviews', (req, res, next) => {
  try {
    res.json(
      archive.listReviews({
        status: req.query.status,
        puppetHeadId: req.query.puppetHeadId,
        active: req.query.active,
        archived: req.query.archived
      })
    );
  } catch (error) {
    next(error);
  }
});

// GET /api/makeupReviews/archive —— 留档（含失效/覆盖/通过的历史原值）
router.get('/makeupReviews/archive', (req, res, next) => {
  try {
    res.json(archive.listReviews({ archived: '1' }));
  } catch (error) {
    next(error);
  }
});

router.get('/makeupReviews/:id', (req, res, next) => {
  try {
    const review = archive.getReview(req.params.id);
    if (!review) return res.status(404).json({ error: '复核档案不存在' });
    res.json(review);
  } catch (error) {
    next(error);
  }
});

// ---- 4. 油漆批次档案入口 ----
// GET /api/paintBatches
router.get('/paintBatches', (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    res.json(
      archive.listBatches().map((batch) => ({
        ...batch,
        expired: rules.isBatchExpired(batch.expireDate, today)
      }))
    );
  } catch (error) {
    next(error);
  }
});

// POST /api/paintBatches  body: batchNo, colorNo, expireDate, name?
router.post('/paintBatches', (req, res, next) => {
  try {
    requireFields(req.body, ['batchNo', 'colorNo', 'expireDate']);
    const batch = archive.createBatch({
      batchNo: String(req.body.batchNo),
      colorNo: String(req.body.colorNo),
      expireDate: String(req.body.expireDate).slice(0, 10),
      name: req.body.name ? String(req.body.name) : ''
    });
    res.status(201).json(batch);
  } catch (error) {
    next(error);
  }
});

// ---- 5. 剧目色号标准只读入口 ----
router.get('/makeupStandards', (req, res) => {
  const list = rules.PLAY_STANDARDS.map((item) => ({ ...item }));
  const filtered = req.query.play ? list.filter((item) => item.play === req.query.play) : list;
  res.json({ minDryMinutes: rules.MIN_DRY_MINUTES, lampTolerance: rules.LAMP_TOLERANCE, standards: filtered });
});

module.exports = router;
