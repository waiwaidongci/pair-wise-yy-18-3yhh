// 业务文件二：判定规则（纯函数，不读写数据库）
// 负责：剧目色号标准比对、批次过期判定、试灯偏差分级、初判与复看结论校验。

// 复看前置条件
const MIN_DRY_MINUTES = 240; // 干燥满四小时
const LAMP_TOLERANCE = 2; // 试灯偏差超过 2 级即不合格

// 不通过原因编码
const ISSUE = {
  COLOR_MISMATCH: 'COLOR_MISMATCH', // 色号不符合剧目标准
  STANDARD_MISSING: 'STANDARD_MISSING', // 查无该剧目/行当标准
  BATCH_EXPIRED: 'BATCH_EXPIRED', // 批次已过期
  BATCH_COLOR_MISMATCH: 'BATCH_COLOR_MISMATCH', // 批次登记色号与所用色号不一致
  LAMP_DEVIATION: 'LAMP_DEVIATION' // 试灯偏差超过 2 级
};

const ISSUE_TEXT = {
  COLOR_MISMATCH: '色号不符合剧目标准',
  STANDARD_MISSING: '查无该剧目/行当色号标准，需人工确认',
  BATCH_EXPIRED: '油漆批次已过期',
  BATCH_COLOR_MISMATCH: '批次登记色号与补妆色号不一致',
  LAMP_DEVIATION: '试灯偏差超过2级'
};

// 剧目（可叠加行当）标准色号与试灯基准值（1-9 级，3 为常光基准）
const PLAY_STANDARDS = [
  { play: '火焰山', role: '武生', standardColor: 'WH-12', lampBase: 3 },
  { play: '火焰山', role: '铁扇公主', standardColor: 'TS-07', lampBase: 4 },
  { play: '火焰山', role: '孙悟空', standardColor: 'WK-03', lampBase: 3 },
  { play: '白蛇传', role: '武生', standardColor: 'BS-05', lampBase: 4 },
  { play: '白蛇传', role: '白素贞', standardColor: 'BS-01', lampBase: 5 },
  { play: '霸王别姬', role: '武生', standardColor: 'BW-08', lampBase: 3 },
  { play: '霸王别姬', role: '虞姬', standardColor: 'YJ-02', lampBase: 5 }
];

function findStandard(play, role) {
  return (
    PLAY_STANDARDS.find((item) => item.play === play && item.role === role) ||
    PLAY_STANDARDS.find((item) => item.play === play && !item.role) ||
    null
  );
}

// 批次是否过期：expireDate 为 YYYY-MM-DD，到期当天即视为过期
function isBatchExpired(expireDate, today) {
  if (!expireDate) return false;
  const base = today || new Date().toISOString().slice(0, 10);
  return String(expireDate).slice(0, 10) <= base;
}

function lampDelta(lampBase, lampValue) {
  return Math.abs(Number(lampValue) - Number(lampBase));
}

// 初判：返回 { status, issues:[{code,message}], standard, lampDelta, expired }
function evaluateRegistration(input, { standard, batchInfo, today } = {}) {
  const { play, role, colorNo, batch, lampValue } = input;
  const issues = [];

  if (!standard) {
    issues.push({ code: ISSUE.STANDARD_MISSING, message: ISSUE_TEXT[ISSUE.STANDARD_MISSING] });
  } else if (colorNo !== standard.standardColor) {
    issues.push({
      code: ISSUE.COLOR_MISMATCH,
      message: ISSUE_TEXT.COLOR_MISMATCH,
      detail: '标准色号 ' + standard.standardColor + '，实际色号 ' + colorNo
    });
  }

  if (batchInfo) {
    if (isBatchExpired(batchInfo.expireDate, today)) {
      issues.push({
        code: ISSUE.BATCH_EXPIRED,
        message: ISSUE_TEXT.BATCH_EXPIRED,
        detail: '批次 ' + batch + ' 有效期至 ' + batchInfo.expireDate
      });
    }
    if (batchInfo.colorNo && batchInfo.colorNo !== colorNo) {
      issues.push({
        code: ISSUE.BATCH_COLOR_MISMATCH,
        message: ISSUE_TEXT.BATCH_COLOR_MISMATCH,
        detail: '批次登记色号 ' + batchInfo.colorNo + '，实际色号 ' + colorNo
      });
    }
  }

  let delta = null;
  if (standard && standard.lampBase !== undefined) {
    delta = lampDelta(standard.lampBase, lampValue);
    if (delta > LAMP_TOLERANCE) {
      issues.push({
        code: ISSUE.LAMP_DEVIATION,
        message: ISSUE_TEXT.LAMP_DEVIATION,
        detail: '基准 ' + standard.lampBase + ' 级，实测 ' + arguments[0].lampValue + ' 级，偏差 ' + delta + ' 级'
      });
    }
  }

  return {
    status: issues.length ? '待复检' : '待复看',
    issues,
    standard: standard || null,
    lampDelta: delta,
    minDryMinutes: MIN_DRY_MINUTES
  };
}

// 复看能否“通过”：另一人、干燥满四小时、当前仍处于有效结论位
function checkRecheck(review, { reviewer, dryMinutes }) {
  const errors = [];
  if (!['待复检', '待复看'].includes(review.status)) {
    errors.push('当前结论为「' + review.status + '」，不允许复看');
  }
  if (!reviewer) {
    errors.push('缺少复看人');
  } else if (review.painter && reviewer === review.painter) {
    errors.push('复看人不能与补妆人相同（需另一名化妆师复看）');
  }
  const minutes = Number(dryMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    errors.push('干燥分钟数无效');
  } else if (minutes < MIN_DRY_MINUTES) {
    errors.push('干燥未满四小时（已干燥 ' + minutes + ' 分钟，需满 ' + MIN_DRY_MINUTES + ' 分钟）');
  }
  return { ok: errors.length === 0, errors };
}

// 新登记是否让旧结论失效：色号或批次任一变化即失效
function oldConclusionInvalidated(prev, { colorNo, batch }) {
  if (!prev) return false;
  return prev.colorNo !== colorNo || prev.batch !== batch;
}

module.exports = {
  MIN_DRY_MINUTES,
  LAMP_TOLERANCE,
  ISSUE,
  ISSUE_TEXT,
  PLAY_STANDARDS,
  findStandard,
  isBatchExpired,
  evaluateRegistration,
  checkRecheck,
  oldConclusionInvalidated
};
