// 数据访问层：优先使用系统 sqlite3 CLI，缺失时回退到 sql.js(WASM) 内存库并落盘。
// 业务代码统一使用 exec / query，不直接接触具体实现。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

function hasSqliteCli() {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

const useCli = hasSqliteCli();
let wasmDb = null;

async function ensureWasm() {
  if (wasmDb) return wasmDb;
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buffer = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : undefined;
  wasmDb = new SQL.Database(buffer);
  return wasmDb;
}

function flushWasm() {
  if (!wasmDb) return;
  fs.writeFileSync(DB_FILE, Buffer.from(wasmDb.export()));
}

// 同步入口：sql.js 初始化在模块加载时完成（见 initDatabase）。
function exec(sql) {
  if (useCli) {
    execFileSync('sqlite3', [DB_FILE], { input: sql, encoding: 'utf8' });
    return;
  }
  wasmDb.run(sql);
  flushWasm();
}

function query(sql) {
  if (useCli) {
    const output = execFileSync('sqlite3', [DB_FILE], {
      input: '.mode json\n' + sql,
      encoding: 'utf8'
    });
    if (!output.trim()) return [];
    return JSON.parse(output);
  }
  const result = [];
  const stmt = wasmDb.prepare(sql);
  while (stmt.step()) result.push(stmt.getAsObject());
  stmt.free();
  return result;
}

async function initDatabase() {
  if (!useCli) await ensureWasm();
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

module.exports = { DB_FILE, exec, query, initDatabase, useCli, sqlValue };
