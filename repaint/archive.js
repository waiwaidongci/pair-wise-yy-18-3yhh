// 档案：补妆请求与留档的持久化，直接读写 SQLite，与通用 records 引擎共用同一个库文件。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('../project.config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return execFileSync('sqlite3', [DB_FILE], {
    input: sql,
    encoding: 'utf8'
  });
}

function select(sql) {
  const output = runSql('.mode json\n' + sql);
  if (!output.trim()) return [];
  return JSON.parse(output);
}

function now() {
  return new Date().toISOString();
}

const REQUEST_COLUMNS = {
  puppetHeadId: 'puppet_head_id',
  play: 'play',
  role: 'role',
  colorCode: 'color_code',
  paintBatch: 'paint_batch',
  dryingMinutes: 'drying_minutes',
  testLightValue: 'test_light_value',
  painter: 'painter',
  reviewer: 'reviewer',
  status: 'status',
  reasons: 'reasons',
  revision: 'revision',
  note: 'note'
};

function initTables() {
  runSql(`
CREATE TABLE IF NOT EXISTS repaint_requests (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  play TEXT NOT NULL,
  role TEXT,
  color_code TEXT NOT NULL,
  paint_batch TEXT NOT NULL,
  drying_minutes REAL NOT NULL,
  test_light_value REAL NOT NULL,
  painter TEXT NOT NULL,
  reviewer TEXT,
  status TEXT NOT NULL,
  reasons TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repaint_requests_head ON repaint_requests(puppet_head_id);
CREATE INDEX IF NOT EXISTS idx_repaint_requests_status ON repaint_requests(status);
CREATE TABLE IF NOT EXISTS repaint_archives (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  note TEXT,
  values_json TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repaint_archives_request ON repaint_archives(request_id);
`);
}

function toRequest(row) {
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    play: row.play,
    role: row.role || '',
    colorCode: row.color_code,
    paintBatch: row.paint_batch,
    dryingMinutes: row.drying_minutes,
    testLightValue: row.test_light_value,
    painter: row.painter,
    reviewer: row.reviewer || '',
    status: row.status,
    reasons: JSON.parse(row.reasons || '[]'),
    revision: row.revision,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createRequest(fields) {
  const id = randomUUID();
  const createdAt = now();
  runSql(
    'INSERT INTO repaint_requests (id, puppet_head_id, play, role, color_code, paint_batch, drying_minutes, test_light_value, painter, reviewer, status, reasons, revision, note, created_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(fields.puppetHeadId),
      sqlValue(fields.play),
      sqlValue(fields.role || ''),
      sqlValue(fields.colorCode),
      sqlValue(fields.paintBatch),
      sqlValue(fields.dryingMinutes),
      sqlValue(fields.testLightValue),
      sqlValue(fields.painter),
      sqlValue(fields.reviewer || ''),
      sqlValue(fields.status),
      sqlValue(JSON.stringify(fields.reasons || [])),
      sqlValue(fields.revision || 1),
      sqlValue(fields.note || ''),
      sqlValue(createdAt),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
  return getRequest(id);
}

function getRequest(id) {
  const rows = select('SELECT * FROM repaint_requests WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? toRequest(rows[0]) : null;
}

function listRequests(query) {
  let sql = 'SELECT * FROM repaint_requests';
  const conditions = [];
  if (query.status) conditions.push('status = ' + sqlValue(query.status));
  if (query.puppetHeadId) conditions.push('puppet_head_id = ' + sqlValue(query.puppetHeadId));
  if (query.play) conditions.push('play = ' + sqlValue(query.play));
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY updated_at DESC;';
  return select(sql).map(toRequest);
}

function updateRequest(id, fields) {
  const sets = [];
  for (const [key, column] of Object.entries(REQUEST_COLUMNS)) {
    if (fields[key] === undefined) continue;
    const value = key === 'reasons' ? JSON.stringify(fields[key]) : fields[key];
    sets.push(column + ' = ' + sqlValue(value));
  }
  sets.push('updated_at = ' + sqlValue(now()));
  runSql('UPDATE repaint_requests SET ' + sets.join(', ') + ' WHERE id = ' + sqlValue(id) + ';');
  return getRequest(id);
}

// 留档：每次判定结论、复看结论、变更失效都追加一条，永不改写。
function appendArchive({ requestId, type, actor, note, values, conclusion }) {
  runSql(
    'INSERT INTO repaint_archives (id, request_id, type, actor, note, values_json, conclusion, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(requestId),
      sqlValue(type),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(values || {})),
      sqlValue(conclusion || ''),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function listArchives(requestId) {
  return select(
    'SELECT * FROM repaint_archives WHERE request_id = ' + sqlValue(requestId) + ' ORDER BY created_at ASC;'
  ).map((row) => ({
    id: row.id,
    requestId: row.request_id,
    type: row.type,
    actor: row.actor || '',
    note: row.note || '',
    values: JSON.parse(row.values_json || '{}'),
    conclusion: row.conclusion,
    createdAt: row.created_at
  }));
}

// ---- 偶头档案联动（通用 records 表）----

function headTitle(data) {
  const fields = config.collections.puppetHeads.titleFields || [];
  return fields.map((field) => data[field]).filter(Boolean).join(' / ');
}

function getPuppetHead(id) {
  const rows = select(
    "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  const data = JSON.parse(rows[0].data || '{}');
  return { id: rows[0].id, status: rows[0].status, ...data };
}

function updatePuppetHead(id, { status, fields, actor, action, note }) {
  const rows = select(
    "SELECT * FROM records WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ' LIMIT 1;'
  );
  if (!rows[0]) return null;
  const data = { ...JSON.parse(rows[0].data || '{}'), ...(fields || {}) };
  const nextStatus = status || rows[0].status;
  data.status = nextStatus;
  runSql(
    'UPDATE records SET status = ' + sqlValue(nextStatus) +
    ', title = ' + sqlValue(headTitle(data)) +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    " WHERE collection = 'puppetHeads' AND id = " + sqlValue(id) + ';'
  );
  runSql(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(id),
      sqlValue('puppetHeads'),
      sqlValue(action || '补妆流转'),
      sqlValue(nextStatus),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(fields || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
  return getPuppetHead(id);
}

initTables();

module.exports = {
  createRequest,
  getRequest,
  listRequests,
  updateRequest,
  appendArchive,
  listArchives,
  getPuppetHead,
  updatePuppetHead
};
