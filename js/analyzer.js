/**
 * js/analyzer.js — 聚合统计、敏感度分析、智能文案生成
 * 层级：analyzer（Worker 安全：纯函数，零 DOM 依赖）
 */
(function (BDSS) {
  'use strict';

  var an = (BDSS.analyzer = BDSS.analyzer || {});

  /* ============================================================
   * 统计辅助
   * ============================================================ */

  function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function std(arr) {
    if (!arr || arr.length < 2) return 0;
    var m = mean(arr);
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }

  function percentile(sorted, p) {
    if (!sorted || sorted.length === 0) return 0;
    var idx = (sorted.length - 1) * p / 100;
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  /* ============================================================
   * F3 聚合统计
   * ============================================================ */

  /**
   * 聚合单次批量扫描的原始数据，输出统计指标
   * @param {object} rawBatch - runBatch 返回的单个候选价结果
   * @returns {object} 聚合指标
   */
  an.aggregate = function (rawBatch) {
    var scores = rawBatch.scores;
    var ranks = rawBatch.ranks;
    var validRounds = rawBatch.validRounds;

    if (validRounds === 0) {
      return {
        candidate: rawBatch.candidate,
        validRounds: 0,
        expectedScore: 0,
        expectedRank: 0,
        winProb: 0,
        scoreP10: 0, scoreP50: 0, scoreP90: 0,
        scoreStd: 0,
        rankDist: {},
        worstRank: 0,
        bestRank: 0
      };
    }

    // 得分统计
    var sortedScores = scores.slice().sort(function (a, b) { return a - b; });
    var expectedScore = mean(scores);
    var scoreP10 = percentile(sortedScores, 10);
    var scoreP50 = percentile(sortedScores, 50);
    var scoreP90 = percentile(sortedScores, 90);
    var scoreStd = std(scores);

    // 排名统计
    var rankDist = {};
    var worstRank = 0, bestRank = 999;
    for (var i = 0; i < ranks.length; i++) {
      var r = ranks[i];
      rankDist[r] = (rankDist[r] || 0) + 1;
      if (r > worstRank) worstRank = r;
      if (r < bestRank) bestRank = r;
    }
    // 转百分比
    var rankDistPct = {};
    for (var k in rankDist) {
      rankDistPct[k] = round2((rankDist[k] / validRounds) * 100);
    }

    var expectedRank = mean(ranks);
    var winProb = (rawBatch.winCount / validRounds) * 100;

    return {
      candidate: rawBatch.candidate,
      validRounds: validRounds,
      totalRounds: rawBatch.totalRounds,
      expectedScore: round2(expectedScore),
      expectedRank: round2(expectedRank),
      winProb: round2(winProb),
      scoreP10: round2(scoreP10),
      scoreP50: round2(scoreP50),
      scoreP90: round2(scoreP90),
      scoreStd: round2(scoreStd),
      rankDist: rankDistPct,
      worstRank: worstRank,
      bestRank: bestRank,
      detailSamples: rawBatch.detailSamples || []
    };
  };

  /**
   * 聚合整个批量扫描的所有候选价
   * @param {object[]} batchResults - runBatch 返回的数组
   * @returns {object[]} 每个候选价的聚合指标
   */
  an.aggregateBatch = function (batchResults) {
    return batchResults.map(function (r) { return an.aggregate(r); });
  };

  /**
   * 场景矩阵结果聚合
   * @param {object[]} scenarioResults - runScenarios 返回值
   * @returns {object[]} 每个场景的聚合结果
   */
  an.aggregateScenarios = function (scenarioResults) {
    return scenarioResults.map(function (sr) {
      return {
        scenario: sr.scenario,
        stats: an.aggregateBatch(sr.batchResult)
      };
    });
  };

  /* ============================================================
   * F3 智能分析文案
   * ============================================================ */

  /**
   * 生成智能分析结论
   * @param {object[]} stats - aggregateBatch 返回的聚合统计
   * @param {object} scheme - 原始方案（用于回显参数）
   * @param {object} opts - {winProbThreshold}
   * @returns {object} {recommendations, robustness, risks}
   */
  an.autoConclusions = function (stats, scheme, opts) {
    opts = opts || {};
    var threshold = opts.winProbThreshold || 40; // 中标概率阈值

    var recommendations = an._genRecommendations(stats, threshold);
    var robustness = an._genRobustness(stats);
    var risks = an._genRisks(stats, scheme);
    var partnerEcho = an._echoPartners(scheme);

    return {
      recommendations: recommendations,
      robustness: robustness,
      risks: risks,
      partnerEcho: partnerEcho
    };
  };

  /**
   * 生成三档建议价
   */
  an._genRecommendations = function (stats, threshold) {
    if (!stats || stats.length === 0) return null;

    // 按中标概率降序排列
    var sorted = stats.slice().sort(function (a, b) { return b.winProb - a.winProb; });

    // 最优点（中标概率最高）
    var best = sorted[0];

    // 满足阈值的候选价范围
    var meetThreshold = sorted.filter(function (s) { return s.winProb >= threshold; });
    var range = null;
    if (meetThreshold.length > 0) {
      var cands = meetThreshold.map(function (s) { return s.candidate; });
      range = {
        min: Math.min.apply(null, cands),
        max: Math.max.apply(null, cands)
      };
    }

    // 三档：保守（期望排名最优）、中性（中标概率最高）、激进（报价最低且胜率仍可接受）
    var byRank = stats.slice().sort(function (a, b) { return a.expectedRank - b.expectedRank; });
    var conservative = byRank[0]; // 期望排名最小 = 最保守

    // 激进：报价低于中位点且中标概率 > 20%
    var midPrice = stats[ Math.floor(stats.length / 2) ].candidate;
    var aggressive = stats.slice()
      .filter(function (s) { return s.candidate < midPrice && s.winProb > 20; })
      .sort(function (a, b) { return a.candidate - b.candidate; });
    aggressive = aggressive.length > 0 ? aggressive[0] : sorted[sorted.length - 1];

    var neutral = best;

    return {
      best: { candidate: best.candidate, winProb: best.winProb, expectedScore: best.expectedScore, expectedRank: best.expectedRank, worstRank: best.worstRank },
      conservative: { candidate: conservative.candidate, winProb: conservative.winProb, expectedScore: conservative.expectedScore, expectedRank: conservative.expectedRank, worstRank: conservative.worstRank },
      neutral: { candidate: neutral.candidate, winProb: neutral.winProb, expectedScore: neutral.expectedScore, expectedRank: neutral.expectedRank, worstRank: neutral.worstRank },
      aggressive: { candidate: aggressive.candidate, winProb: aggressive.winProb, expectedScore: aggressive.expectedScore, expectedRank: aggressive.expectedRank, worstRank: aggressive.worstRank },
      range: range,
      text: an._buildRecText(best, conservative, neutral, aggressive, range, threshold)
    };
  };

  an._buildRecText = function (best, cons, neut, aggr, range, threshold) {
    var lines = [];
    lines.push('## 建议报价分析');
    lines.push('');
    lines.push('**最优报价点**：' + best.candidate.toFixed(2) + ' 元，中标概率 ' + best.winProb + '%，期望得分 ' + best.expectedScore + ' 分，期望排名 ' + best.expectedRank + '。');
    lines.push('');
    lines.push('**三档建议价**：');
    lines.push('- 保守档：' + cons.candidate.toFixed(2) + ' 元（期望排名 ' + cons.expectedRank + '，最差排名 ' + cons.worstRank + '，胜率 ' + cons.winProb + '%）');
    lines.push('- 中性档：' + neut.candidate.toFixed(2) + ' 元（期望排名 ' + neut.expectedRank + '，最差排名 ' + neut.worstRank + '，胜率 ' + neut.winProb + '%）');
    lines.push('- 激进档：' + aggr.candidate.toFixed(2) + ' 元（期望排名 ' + aggr.expectedRank + '，最差排名 ' + aggr.worstRank + '，胜率 ' + aggr.winProb + '%）');
    lines.push('');
    if (range) {
      lines.push('**可接受区间**（中标概率 ≥ ' + threshold + '%）：' + range.min.toFixed(2) + ' ~ ' + range.max.toFixed(2) + ' 元。');
    } else {
      lines.push('**注意**：当前无候选价满足中标概率 ≥ ' + threshold + '% 阈值，建议调整参数或扩大候选区间。');
    }
    return lines.join('\n');
  };

  /**
   * 稳健性三问
   */
  an._genRobustness = function (stats) {
    if (!stats || stats.length === 0) return {};
    var best = stats.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];
    var bestIdx = stats.indexOf(best);

    // 漂移幅度：左右各一档的胜率变化
    var left = bestIdx > 0 ? stats[bestIdx - 1] : best;
    var right = bestIdx < stats.length - 1 ? stats[bestIdx + 1] : best;
    var drift = Math.max(Math.abs(best.winProb - left.winProb), Math.abs(best.winProb - right.winProb));

    // 最差假设下仍可接受的报价带：胜率 > 20% 的最宽区间
    var acceptable = stats.filter(function (s) { return s.winProb > 20; });
    var worstAcceptable = null;
    if (acceptable.length > 0) {
      var cands = acceptable.map(function (s) { return s.candidate; });
      worstAcceptable = { min: Math.min.apply(null, cands), max: Math.max.apply(null, cands) };
    }

    var isStable = drift < 10;
    return {
      isStable: isStable,
      drift: drift,
      worstAcceptable: worstAcceptable,
      text: '**稳健性分析**：' + (isStable
        ? '最优点稳定，相邻报价档位胜率漂移 ' + drift.toFixed(1) + '%。'
        : '最优点不够稳定，相邻档位胜率漂移达 ' + drift.toFixed(1) + '%，建议关注参数敏感性。') +
        (worstAcceptable
          ? '最差假设下仍可接受的报价带：' + worstAcceptable.min.toFixed(2) + ' ~ ' + worstAcceptable.max.toFixed(2) + ' 元。'
          : '当前无报价带在最差假设下仍保持可接受胜率。')
    };
  };

  /**
   * 风险提示
   */
  an._genRisks = function (stats, scheme) {
    var risks = [];

    // 有效投标人不足
    var lowValidCount = 0;
    stats.forEach(function (s) {
      if (s.validRounds < s.totalRounds * 0.5) lowValidCount++;
    });
    if (lowValidCount > stats.length * 0.3) {
      risks.push('⚠ 有效投标人不足：超过 ' + Math.round(lowValidCount / stats.length * 100) + '% 的候选价在模拟中出现有效投标人家数不足，置信度低，可能触发重新招标。');
    }

    // 异常低价风险
    if (scheme.project.costWarningLine > 0) {
      risks.push('⚠ 异常低价风险：成本警戒线为 ' + scheme.project.costWarningLine.toFixed(2) + ' 元，低于此值的报价将被' + (scheme.invalidRules.belowCost === 'invalid' ? '判定为无效标' : '标记为异常低价') + '。');
    }

    // 对手集体压价风险
    var minOpponent = 999;
    scheme.opponents.distributions.forEach(function (d) {
      if (d.type === 'uniform' && d.params.min < minOpponent) minOpponent = d.params.min;
      if (d.type === 'normal' && d.params.mean < minOpponent) minOpponent = d.params.mean;
    });
    if (minOpponent < 0.9) {
      risks.push('⚠ 对手压价风险：对手报价分布偏低（最低约限价 ' + (minOpponent * 100).toFixed(1) + '%），可能导致基准价下移，我方最优报价需相应下移。');
    }

    // 伙伴偏离风险
    var activePartners = (scheme.partners || []).filter(function (p) { return p.enabled; });
    if (activePartners.length > 0) {
      var partnerInfo = activePartners.map(function (p) {
        return p.name + '(' + (p.method === 'fixed' ? p.fixedQuote.toFixed(0) + '元' : p.narrow.center + '%') + (p.forceValid ? ',强制有效' : '') + ')';
      }).join(', ');
      risks.push('⚠ 伙伴偏离风险：当前伙伴假设为 [' + partnerInfo + ']，若实际偏离预期，胜率将显著变化。标记"强制有效"的伙伴假设置信度低。');
    }

    return { items: risks, text: risks.join('\n') };
  };

  /**
   * 伙伴表回显
   */
  an._echoPartners = function (scheme) {
    var partners = scheme.partners || [];
    if (partners.length === 0) return { hasPartners: false, rows: [], text: '无伙伴配置' };

    var rows = partners.map(function (p) {
      return {
        name: p.name,
        enabled: p.enabled ? '是' : '否',
        method: p.method,
        quote: p.method === 'fixed' ? p.fixedQuote.toFixed(2) + ' 元' :
               p.method === 'narrow' ? '中心' + p.narrow.center + '% ±' + p.narrow.spread + '%' :
               p.method === 'sample' ? '样本' + (p.samples || []).length + '条' : '-',
        forceValid: p.forceValid ? '是（置信度低）' : '否',
        confidence: p.forceValid ? '低' : '中'
      };
    });

    return { hasPartners: true, rows: rows, text: '已配置 ' + rows.length + ' 个伙伴' };
  };

  /* ============================================================
   * F3 敏感度分析
   * ============================================================ */

  /**
   * 敏感度龙卷风图数据
   * 对 K / α / a / b / 对手均值 / 对手下界 / 伙伴数 / 伙伴均值 做 ±基准变动
   * @param {object} scheme - 基准方案
   * @param {object[]} baseStats - 基准方案的聚合统计
   * @param {object} opts - 模拟选项
   * @returns {object[]} 敏感度数据
   */
  an.sensitivityTornado = function (scheme, baseStats, opts) {
    // 基准胜率（最优候选价的胜率）
    var baseBest = baseStats.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];
    var baseWinProb = baseBest ? baseBest.winProb : 0;

    var factors = [
      { key: 'K', label: '下浮系数 K', delta: 0.01, path: 'pricingModel.params.K' },
      { key: 'a', label: '高于基准扣分 a', delta: 0.5, path: 'scoring.a' },
      { key: 'b', label: '低于基准扣分 b', delta: 0.5, path: 'scoring.b' },
      { key: 'oppMean', label: '对手均值', delta: 0.01, path: 'opponents.distributions[0].params.mean' },
      { key: 'oppMin', label: '对手下界', delta: 0.01, path: 'opponents.distributions[0].params.min' },
      { key: 'partnerCount', label: '伙伴数', delta: 1, path: 'partners' },
      { key: 'partnerMean', label: '伙伴均值', delta: 1, path: 'partners[0].narrow.center' }
    ];

    var results = [];
    // 简化：仅返回因素列表和基准值，实际敏感度由 UI 调用 runBatch 两次（+delta, -delta）计算
    // 这里返回数据结构，UI 层负责执行模拟
    factors.forEach(function (f) {
      results.push({
        key: f.key,
        label: f.label,
        delta: f.delta,
        baseWinProb: baseWinProb
      });
    });

    return { baseWinProb: baseWinProb, factors: results };
  };

  /**
   * 风险雷达：使胜率下降最快的三个因素
   * @param {object[]} sensitivityData - 敏感度结果
   * @returns {object[]}
   */
  an.riskRadar = function (sensitivityData) {
    if (!sensitivityData || !sensitivityData.factors) return [];
    return sensitivityData.factors
      .map(function (f) {
        var impact = (f.upWinProb !== undefined && f.downWinProb !== undefined)
          ? Math.max(Math.abs(f.upWinProb - f.baseWinProb), Math.abs(f.downWinProb - f.baseWinProb))
          : 0;
        return { label: f.label, impact: impact, direction: f.upWinProb < f.downWinProb ? '↑' : '↓' };
      })
      .filter(function (f) { return f.impact > 0; })
      .sort(function (a, b) { return b.impact - a.impact; })
      .slice(0, 3);
  };
})(window.BDSS = window.BDSS || {});
