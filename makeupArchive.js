// 业务文件三：档案
// 负责：补妆复核档案、油漆批次档案的建表与读写；
//       新登记时旧结论留档失效；同步偶头主档状态与时间线。
const { randomUUID } = require('crypto');
const { exec, query, sqlValue } = require('./db');
const rules = require('./makeupRules');

function now() {
  return new Date().toISOString();
}

// 档案中仍生效（会占用偶头可演出状态）的结论
const ACTIVE_STATUSES = ['待复检', '待复看', '已通过'];

const INITIAL_BATCHES = [
  { batchNo: 'P2026-01', colorNo: 'WH-12', name: '武生油彩·焰山白', expireDate: '2027-03-31' },
  { batchNo: 'P2025-08', colorNo: 'BS-05', name: '武生油彩·白蛇青底', expireDate: '2026-08-31' },
  { batchNo: 'P2026-02', colorNo: 'WK-03', name: '悟空金底', expireDate: '2027-06-30' }
];

function initMakeupArchive() {
  exec(`
CREATE TABLE IF NOT EXISTS makeup_reviews (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  status TEXT NOT NULL,
  painter TEXT NOT NULL,
  play TEXT NOT NULL,
  role TEXT NOT NULL,
  color_no TEXT NOT NULL,
  batch TEXT NOT NULL,
  dry_minutes INTEGER NOT NULL,
  lamp_value INTEGER,
  lamp_base INTEGER,
  lamp_delta INTEGER,
  issues TEXT NOT NULL,
  painted_at TEXT NOT NULL,
  eligible_recheck_at TEXT NOT NULL,
  reviewer TEXT,
  rechecked_at TEXT,
  recheck_note TEXT,
  superseded_by TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_makeup_head ON makeup_reviews(puppet_head_id);
CREATE INDEX IF NOT EXISTS idx_makeup_status ON makeup_reviews(status);
CREATE INDEX IF NOT EXISTS idx_makeup_archived ON makeup_reviews(archived);
CREATE TABLE IF NOT EXISTS paint_batches (
  batch_no TEXT PRIMARY KEY,
  color_no TEXT NOT NULL,
  name TEXT,
  expire_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);
  const count = query('SELECT COUNT(*) AS count FROM paint_batches;')[0].count;
  if (count === 0) {
    for (const batch of INITIAL_BATCHES) createBatch(batch, true);
  }
}

function rowToReview(row) {
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    status: row.status,
    painter: row.painter,
    play: row.play,
    role: row.role,
    colorNo: row.color_no,
    batch: row.batch,
    dryMinutes: row.dry_minutes,
    lampValue: row.lamp_value,
    lampBase: row.lamp_base,
    lampDelta: row.lamp_delta,
    issues: JSON.parse(row.issues || '[]'),
    paintedAt: row.painted_at,
    eligibleRecheckAt: row.eligible_recheck_at,
    reviewer: row.reviewer,
    recheckedAt: row.rechecked_at,
    recheckNote: row.recheck_note,
    supersededBy: row.superseded_by,
    archived: !!row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToBatch(row) {
  return {
    batchNo: row.batch_no,
    colorNo: row.color_no,
    name: row.name,
    expireDate: row.expire_date,
    createdAt: row.created_at
  };
}

// ---- 油漆批次档案 ----

function listBatches() {
  return query('SELECT * FROM paint_batches ORDER BY batch_no;').map(rowToBatch);
}

function getBatch(batchNo) {
  const row = query(
    'SELECT * FROM paint_batches WHERE batch_no = ' + sqlValue(batchNo) + ' LIMIT 1;'
  )[0];
  return row ? rowToBatch(row) : null;
}

function createBatch({ batchNo, colorNo, name, expireDate }) {
  if (!batchNo || !colorNo || !expireDate) {
    const error = new Error('批次档案缺少必填项：batchNo、colorNo、expireDate');
    error.status = 400;
    throw error;
  }
  if (getBatch(batchNo)) {
    const error = new Error('批次已存在：' + batchNo);
    error.status = 409;
    throw error;
  }
  exec(
    'INSERT INTO paint_batches (batch_no, color_no, name, expire_date, created_at) VALUES (' +
    [
      sqlValue(batchNo),
      sqlValue(colorNo),
      sqlValue(name || ''),
      sqlValue(expireDate),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
  return getBatch(batchNo);
}

// ---- 补妆复核档案 ----

function listReviews(filter = {}) {
  const clauses = [];
  if (filter.puppetHeadId) clauses.push('puppet_head_id = ' + sqlValue(filter.puppetHeadId));
  if (filter.status) clauses.push('status = ' + sqlValue(filter.status));
  if (String(filter.archived) === '1') clauses.push('archived = 1');
  if (String(filter.active) === '1') {
    clauses.push("archived = 0 AND status IN ('待复检','待复看','已通过')");
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  return query('SELECT * FROM makeup_reviews' + where + ' ORDER BY created_at DESC;').map(rowToReview);
}

function getReview(id) {
  const row = query('SELECT * FROM makeup_reviews WHERE id = ' + sqlValue(id) + ' LIMIT 1;')[0];
  return row ? rowToReview(row) : null;
}

// 该偶头最近一份“仍然生效、会影响演出状态”的档案：
// 待复检/待复看（未结）或已通过（当前可演出依据）；已失效/已覆盖/驳回不再占位。
function activeReviewFor(puppetHeadId) {
  const row = query(
    'SELECT * FROM makeup_reviews WHERE puppet_head_id = ' +
      sqlValue(puppetHeadId) +
      " AND archived = 0 AND status IN ('待复检','待复看','已通过') ORDER BY created_at DESC LIMIT 1;"
  )[0];
  return row ? rowToReview(row) : null;
}

// 新补妆登记：判定 → 旧结论留档失效 → 写新档案 → 联动偶头
// puppetHeadService 由入口通过 setPuppetHeadService 注入
function registerReview(input) {
  if (!puppetHeadService) throw new Error('puppetHeadService 未注入');
  const head = puppetHeadService.getHead(input.puppetHeadId);
  if (!head) {
    const error = new Error('偶头不存在：' + input.puppetHeadId);
    error.status = 404;
    throw error;
  }

  const standard = rules.findStandard(input.play, input.role);
  const batchInfo = getBatch(input.batch);
  const verdict = rules.evaluateRegistration(input, { standard, batchInfo });
  const paintedAt = input.paintedAt || now();
  const eligibleAt = new Date(
    new Date(paintedAt).getTime() + rules.MIN_DRY_MINUTES * 60000
  ).toISOString();

  // 同一偶头上一份仍生效（占位）的档案：未结的待复检/待复看，或作为可演出依据的已通过
  const prev = activeReviewFor(input.puppetHeadId);
  let prevArchivedId = null;
  if (prev) {
    const invalid = rules.oldConclusionInvalidated(prev, input);
    let markStatus;
    let note;
    if (prev.status === '已通过') {
      // 只有换色号/批次才让已通过结论失效；同色同批的补妆登记不影响已通过依据
      if (!invalid) {
        markStatus = null; // 不处理旧档，仅新建登记
      } else {
        markStatus = '已失效';
        note = '更换色号或批次，旧复核结论失效，原值留档';
      }
    } else {
      markStatus = invalid ? '已失效' : '已覆盖';
      note = invalid
        ? '更换色号或批次，旧复核结论失效，原值留档'
        : '同色号同批次重新登记，旧待结档案被覆盖留档';
    }
    if (markStatus) {
      prevArchivedId = prev.id;
      archiveReview(prev.id, {
        status: markStatus,
        supersededBy: null, // 新 id 尚未生成，落库后回填
        note,
        actor: input.painter
      });
    }
  }

  const id = randomUUID();
  exec(
    'INSERT INTO makeup_reviews (id, puppet_head_id, status, painter, play, role, color_no, batch, ' +
    'dry_minutes, lamp_value, lamp_base, lamp_delta, issues, painted_at, eligible_recheck_at, ' +
    'reviewer, rechecked_at, recheck_note, superseded_by, archived, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(input.puppetHeadId),
      sqlValue(verdict.status),
      sqlValue(input.painter),
      sqlValue(input.play),
      sqlValue(input.role),
      sqlValue(input.colorNo),
      sqlValue(input.batch),
      sqlValue(input.dryMinutes),
      input.lampValue === undefined || input.lampValue === null ? 'NULL' : sqlValue(input.lampValue),
      standard && standard.lampBase !== undefined ? sqlValue(standard.lampBase) : 'NULL',
      verdict.lampDelta === null ? 'NULL' : sqlValue(verdict.lampDelta),
      sqlValue(JSON.stringify(verdict.issues)),
      sqlValue(paintedAt),
      sqlValue(eligibleAt),
      'NULL',
      'NULL',
      'NULL',
      'NULL',
      0,
      sqlValue(paintedAt),
      sqlValue(paintedAt)
    ].join(', ') +
    ');'
  );

  if (prevArchivedId) {
    exec(
      'UPDATE makeup_reviews SET superseded_by = ' + sqlValue(id) +
      ' WHERE id = ' + sqlValue(prevArchivedId) + ';'
    );
  }

  // 待复检/待复看期间偶头一律不可演出
  puppetHeadService.syncStatus(input.puppetHeadId, verdict.status, {
    action: '补妆登记',
    actor: input.painter,
    note:
      verdict.issues.map((item) => item.message).join('；') ||
      '初判通过，等待干燥满四小时后复看',
    data: { reviewId: id, verdict: verdict.status }
  });

  return getReview(id);
}

function archiveReview(id, { status, supersededBy, note, actor }) {
  const review = getReview(id);
  if (!review) return;
  exec(
    'UPDATE makeup_reviews SET status = ' + sqlValue(status) +
    ', archived = 1' +
    (supersededBy ? ', superseded_by = ' + sqlValue(supersededBy) : '') +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE id = ' + sqlValue(id) + ';'
  );
  exec(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(id),
      sqlValue('makeupReviews'),
      sqlValue('留档'),
      sqlValue(status),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify({ previous: review })),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

// 复看结论：pass=true 通过恢复可演出；false 维持待复检
function resolveReview(id, { pass, reviewer, dryMinutes, note, lampValue }) {
  const review = getReview(id);
  if (!review) {
    const error = new Error('复核档案不存在：' + id);
    error.status = 404;
    throw error;
  }
  const check = rules.checkRecheck(review, { reviewer, dryMinutes });
  if (!check.ok) {
    const error = new Error(check.errors.join('；'));
    error.status = 400;
    throw error;
  }

  const recheckedAt = now();
  if (pass) {
    exec(
      'UPDATE makeup_reviews SET status = ' + sqlValue('已通过') +
      ', reviewer = ' + sqlValue(reviewer) +
      ', rechecked_at = ' + sqlValue(recheckedAt) +
      ', recheck_note = ' + sqlValue(note || '') +
      (lampValue !== undefined ? ', lamp_value = ' + sqlValue(lampValue) : '') +
      ', updated_at = ' + sqlValue(recheckedAt) +
      ' WHERE id = ' + sqlValue(id) + ';'
    );
    puppetStatusFromRoute(id, '可演出', {
      action: '复看通过',
      actor: reviewer,
      note: note || '干燥满四小时复看通过，恢复可演出',
      data: { reviewId: id }
    });
  } else {
    exec(
      'UPDATE makeup_reviews SET status = ' + sqlValue('待复检') +
      ', reviewer = ' + sqlValue(reviewer) +
      ', rechecked_at = ' + sqlValue(recheckedAt) +
      ', recheck_note = ' + sqlValue(note || '') +
      (lampValue !== undefined ? ', lamp_value = ' + sqlValue(lampValue) : '') +
      ', updated_at = ' + sqlValue(recheckedAt) +
      ' WHERE id = ' + sqlValue(id) + ';'
    );
    puppetStatusFromRoute(id, '待复检', {
      action: '复看未通过',
      actor: reviewer,
      note: note || '复看未通过，维持待复检',
      data: { reviewId: id }
    });
  }
  return getReview(id);
}

// resolveReview 通过 puppetHeadService 操作（由 setPuppetHeadService 注入）
let puppetHeadService = null;
function setPuppetHeadService(service) {
  puppetHeadService = service;
}
function puppetStatusFromRoute(reviewId, status, event) {
  const review = getReview(reviewId);
  if (review && puppetHeadService) {
    puppetHeadService.syncStatus(review.puppetHeadId, status, event);
  }
}

module.exports = {
  ACTIVE_STATUSES,
  initMakeupArchive,
  listBatches,
  getBatch,
  createBatch,
  listReviews,
  getReview,
  activeReviewFor,
  registerReview,
  resolveReview,
  setPuppetHeadService
};
