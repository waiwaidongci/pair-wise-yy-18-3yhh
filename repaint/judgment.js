// 判定：补妆登记与复看的业务规则，纯函数，不接触数据库。

function findStandard(standards, play, role) {
  return (
    standards.find((item) => item.play === play && role && item.role === role) ||
    standards.find((item) => item.play === play && !item.role) ||
    null
  );
}

// 登记判定：色号须符合剧目标准、批次未过期、试灯偏差不超过上限。
function judgeIntake(request, rules, now) {
  const checkedAt = now || new Date();
  const reasons = [];
  const standard = findStandard(rules.colorStandards || [], request.play, request.role);
  if (!standard) {
    reasons.push('未找到剧目「' + request.play + '」的色号标准');
  } else {
    if (request.colorCode !== standard.colorCode) {
      reasons.push('色号「' + request.colorCode + '」不符合剧目标准色号「' + standard.colorCode + '」');
    }
    const deviation = Math.abs(Number(request.testLightValue) - Number(standard.lightValue));
    if (deviation > rules.maxLightDeviation) {
      reasons.push('试灯偏差' + deviation + '级，超过' + rules.maxLightDeviation + '级上限');
    }
  }
  const batch = (rules.paintBatches || []).find((item) => item.batchNo === request.paintBatch);
  if (!batch) {
    reasons.push('油漆批次「' + request.paintBatch + '」未登记');
  } else if (new Date(batch.expiresAt).getTime() < checkedAt.getTime()) {
    reasons.push('油漆批次「' + request.paintBatch + '」已于' + batch.expiresAt + '过期');
  }
  return { pass: reasons.length === 0, reasons };
}

// 复看前提：状态为待复看、由另一名化妆师进行、干燥满四小时。
function reviewErrors(request, reviewer, rules) {
  const errors = [];
  if (request.status !== '待复看') {
    errors.push('当前状态为「' + request.status + '」，不可复看');
  }
  if (!reviewer) {
    errors.push('缺少复看化妆师');
  } else if (reviewer === request.painter) {
    errors.push('复看须由另一名化妆师进行，不能是登记人「' + request.painter + '」');
  }
  if (Number(request.dryingMinutes) < rules.minDryingMinutes) {
    errors.push(
      '干燥仅' + request.dryingMinutes + '分钟，未满' + rules.minDryingMinutes + '分钟（四小时），不得复看'
    );
  }
  return errors;
}

// 更换色号或批次会让旧结论失效。
function isConclusionInvalidated(request, changes) {
  return (
    (changes.colorCode !== undefined && changes.colorCode !== request.colorCode) ||
    (changes.paintBatch !== undefined && changes.paintBatch !== request.paintBatch)
  );
}

module.exports = { findStandard, judgeIntake, reviewErrors, isConclusionInvalidated };
