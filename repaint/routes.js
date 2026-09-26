// 请求入口：补妆登记、复看、变更与档案查询的 HTTP 接口。
const express = require('express');
const config = require('../project.config');
const judgment = require('./judgment');
const archive = require('./archive');

const router = express.Router();
const rules = config.repaint;

const REQUIRED_FIELDS = ['puppetHeadId', 'play', 'colorCode', 'paintBatch', 'dryingMinutes', 'testLightValue', 'painter'];
const CHANGEABLE_FIELDS = ['play', 'role', 'colorCode', 'paintBatch', 'dryingMinutes', 'testLightValue', 'note'];
const JUDGMENT_INPUTS = ['play', 'role', 'colorCode', 'paintBatch', 'testLightValue'];

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function snapshot(request) {
  return {
    play: request.play,
    role: request.role,
    colorCode: request.colorCode,
    paintBatch: request.paintBatch,
    dryingMinutes: request.dryingMinutes,
    testLightValue: request.testLightValue
  };
}

function conclusionOf(request) {
  const reasons = request.reasons && request.reasons.length ? '：' + request.reasons.join('；') : '';
  return request.status + reasons;
}

// 同步偶头档案：补妆期间不可演出，复看通过后才恢复可演出。
function markHead(request, actor) {
  const usable = request.status === '已通过';
  archive.updatePuppetHead(request.puppetHeadId, {
    status: usable ? '可演出' : '修补中',
    fields: {
      currentUsable: usable,
      paintStatus: usable
        ? '补妆复检通过（' + request.colorCode + '）'
        : '补妆' + request.status + '（' + request.colorCode + '）'
    },
    actor,
    action: '补妆流转',
    note: '补妆单 ' + request.id + ' → ' + request.status
  });
}

// 登记：油漆时登记偶头、剧目、色号、批次、干燥分钟和试灯值，判定不合格先转待复检。
router.post('/requests', (req, res) => {
  const body = req.body || {};
  const missing = REQUIRED_FIELDS.filter((field) => body[field] === undefined || body[field] === '');
  if (missing.length) return badRequest(res, 'missing required fields: ' + missing.join(', '));
  if (!(Number(body.dryingMinutes) >= 0)) return badRequest(res, 'dryingMinutes 必须是非负数字');
  if (!Number.isFinite(Number(body.testLightValue))) return badRequest(res, 'testLightValue 必须是数字');

  const head = archive.getPuppetHead(body.puppetHeadId);
  if (!head) return res.status(404).json({ error: '偶头不存在: ' + body.puppetHeadId });

  const role = body.role || head.role || '';
  const result = judgment.judgeIntake({ ...body, role }, rules, new Date());
  const request = archive.createRequest({
    puppetHeadId: body.puppetHeadId,
    play: body.play,
    role,
    colorCode: body.colorCode,
    paintBatch: body.paintBatch,
    dryingMinutes: Number(body.dryingMinutes),
    testLightValue: Number(body.testLightValue),
    painter: body.painter,
    status: result.pass ? '待复看' : '待复检',
    reasons: result.reasons,
    note: body.note || ''
  });
  archive.appendArchive({
    requestId: request.id,
    type: '登记判定',
    actor: body.painter,
    note: body.note || '',
    values: snapshot(request),
    conclusion: conclusionOf(request)
  });
  markHead(request, body.painter);
  res.status(201).json(request);
});

router.get('/requests', (req, res) => {
  res.json(archive.listRequests(req.query));
});

router.get('/requests/:id', (req, res) => {
  const request = archive.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'not found' });
  res.json(request);
});

// 档案：该补妆单的全部留档（判定结论、复看结论、变更失效原值）。
router.get('/requests/:id/archives', (req, res) => {
  const request = archive.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'not found' });
  res.json({ request, archives: archive.listArchives(request.id) });
});

// 复看：另一名化妆师在干燥满四小时后复看，通过后才恢复可演出。
router.post('/requests/:id/review', (req, res) => {
  const request = archive.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const errors = judgment.reviewErrors(request, body.reviewer, rules);
  if (typeof body.pass !== 'boolean') errors.push('pass 必须是布尔值');
  if (errors.length) return badRequest(res, errors.join('；'));

  const updated = archive.updateRequest(request.id, {
    status: body.pass ? '已通过' : '待复检',
    reviewer: body.reviewer,
    reasons: body.pass ? [] : [body.note ? '复看未通过：' + body.note : '复看未通过']
  });
  archive.appendArchive({
    requestId: request.id,
    type: '复看结论',
    actor: body.reviewer,
    note: body.note || '',
    values: snapshot(updated),
    conclusion: body.pass ? '复看通过，恢复可演出' : '复看未通过，转待复检'
  });
  markHead(updated, body.reviewer);
  res.json(updated);
});

// 变更：更换色号或批次会让旧结论失效，原值留档后重新判定。
router.post('/requests/:id/change', (req, res) => {
  const request = archive.getRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'not found' });
  if (request.status === '已通过') {
    return res.status(409).json({ error: '已恢复可演出，如需再次补妆请重新登记' });
  }
  const body = req.body || {};
  const fields = {};
  for (const key of CHANGEABLE_FIELDS) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  if (!Object.keys(fields).length) return badRequest(res, '没有需要变更的字段');
  if (fields.dryingMinutes !== undefined && !(Number(fields.dryingMinutes) >= 0)) {
    return badRequest(res, 'dryingMinutes 必须是非负数字');
  }
  if (fields.testLightValue !== undefined && !Number.isFinite(Number(fields.testLightValue))) {
    return badRequest(res, 'testLightValue 必须是数字');
  }
  if (fields.dryingMinutes !== undefined) fields.dryingMinutes = Number(fields.dryingMinutes);
  if (fields.testLightValue !== undefined) fields.testLightValue = Number(fields.testLightValue);

  const invalidated = judgment.isConclusionInvalidated(request, fields);
  if (invalidated) {
    archive.appendArchive({
      requestId: request.id,
      type: '变更失效',
      actor: body.actor || '',
      note: body.note || '更换色号或批次，旧结论失效',
      values: snapshot(request),
      conclusion: conclusionOf(request)
    });
  }

  const patch = { ...fields };
  const inputsChanged = JUDGMENT_INPUTS.some((key) => fields[key] !== undefined && fields[key] !== request[key]);
  // 结论失效后重新判定；待复检中修正判定输入也重新判定，给出回到待复看的通路。
  if (invalidated || (inputsChanged && request.status === '待复检')) {
    const result = judgment.judgeIntake({ ...request, ...fields }, rules, new Date());
    patch.status = result.pass ? '待复看' : '待复检';
    patch.reasons = result.reasons;
    patch.reviewer = '';
    patch.revision = request.revision + 1;
  }

  const updated = archive.updateRequest(request.id, patch);
  if (patch.status) {
    archive.appendArchive({
      requestId: request.id,
      type: '变更判定',
      actor: body.actor || '',
      note: body.note || '',
      values: snapshot(updated),
      conclusion: conclusionOf(updated)
    });
    markHead(updated, body.actor || '');
  }
  res.json(updated);
});

module.exports = router;
