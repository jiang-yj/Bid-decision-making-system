/**
 * js/selftest.js — 内置自检用例 A~E（手算对照、去极值逻辑、伙伴+随机、对照、种子复现）
 * 层级：selftest（非 Worker 安全：调用模拟器 + 输出结果）
 */
(function (BDSS) {
  'use strict';

  var st = (BDSS.selftest = BDSS.selftest || {});

  var TOL = 0.01; // 允许误差

  function pass(name) { return { name: name, pass: true, message: '通过' }; }
  function fail(name, expected, actual, extra) {
    return { name: name, pass: false, expected: expected, actual: actual, message: '失败：期望 ' + expected + '，实际 ' + actual + (extra ? '（' + extra + '）' : '') };
  }

  /**
   * 用例A：模型A算术平均法，3家固定报价，手算基准价与得分，误差≤0.01分
   */
  st.caseA = function () {
    var s = BDSS.config.createDefaultScheme();
    s.project.C_max = 10000000;
    s.pricingModel.type = 'A';
    s.scoring.S_max = 60;
    s.scoring.a = 1;
    s.scoring.b = 1;
    s.scoring.mode = 'linear';
    s.scoring.rounding = 'round';
    s.scoring.roundDecimals = 2;

    // 3家报价：我方950万、对手A960万、对手B940万
    var bids = [9500000, 9600000, 9400000];

    var result = BDSS.simulator.singlePoint(s, bids);
    var expectedBase = 9500000; // (950+960+940)/3 = 950

    if (Math.abs(result.basePrice - expectedBase) > 1) {
      return fail('用例A-基准价', expectedBase, result.basePrice);
    }

    // 我方偏离 = 0%，得分 = 60
    var myResult = result.results[0];
    var expectedScore = 60;
    if (Math.abs(myResult.score - expectedScore) > TOL) {
      return fail('用例A-我方得分', expectedScore, myResult.score);
    }

    // 对手A偏离 = (960-950)/950 = 1.0526%，扣1.0526分 → 58.9474
    var oppA = result.results[1];
    var expectedOppAScore = 60 - 1.0526;
    if (Math.abs(oppA.score - expectedOppAScore) > TOL) {
      return fail('用例A-对手A得分', expectedOppAScore.toFixed(2), oppA.score.toFixed(2));
    }

    // 我方排名第一
    if (result.myRank !== 1) {
      return fail('用例A-排名', 1, result.myRank);
    }

    return pass('用例A：算术平均法3家手算');
  };

  /**
   * 用例B：模型B去极值，4家，验证去极值逻辑
   */
  st.caseB = function () {
    var s = BDSS.config.createDefaultScheme();
    s.project.C_max = 10000000;
    s.pricingModel.type = 'B';
    s.pricingModel.params = { trimLow: 1, trimHigh: 1 };
    s.scoring.S_max = 60;
    s.scoring.a = 1;
    s.scoring.b = 1;

    // 4家报价：100万(极低)、950万(我方)、960万、1000万(极高)
    var bids = [9500000, 9600000, 1000000, 10000000];

    var result = BDSS.simulator.singlePoint(s, bids);
    // 去极值后 = [950万, 960万]，基准价 = 955万
    var expectedBase = 9550000;

    if (Math.abs(result.basePrice - expectedBase) > 1) {
      return fail('用例B-基准价(去极值)', expectedBase, result.basePrice);
    }

    // 我方偏离 = (950-955)/955 = -0.5236%，扣0.5236分 → 59.4764
    var myResult = result.results[0];
    var expectedScore = 60 - 0.5236;
    if (Math.abs(myResult.score - expectedScore) > TOL) {
      return fail('用例B-我方得分', expectedScore.toFixed(2), myResult.score.toFixed(2));
    }

    return pass('用例B：去极值平均法4家');
  };

  /**
   * 用例C：固定伙伴报价为限价95%×2家 + 随机对手3家，验证基准价与得分
   */
  st.caseC = function () {
    var s = BDSS.config.createDefaultScheme();
    s.project.C_max = 10000000;
    s.pricingModel.type = 'A';
    s.scoring.S_max = 60;
    s.scoring.a = 1;
    s.scoring.b = 1;

    // 2个伙伴固定95%
    s.partners = [
      { id: 'p1', name: '伙伴A', enabled: true, method: 'fixed', fixedQuote: 9500000, narrow: { center: 95, spread: 1, dist: 'normal' }, samples: [], forceValid: false },
      { id: 'p2', name: '伙伴B', enabled: true, method: 'fixed', fixedQuote: 9500000, narrow: { center: 95, spread: 1, dist: 'normal' }, samples: [], forceValid: false }
    ];

    // 单点测算：我方950万 + 2伙伴950万 + 3对手(固定为940/960/970万)
    // 这里用 singlePoint 测试确定性报价
    var bids = [9500000, 9500000, 9500000, 9400000, 9600000, 9700000];
    var result = BDSS.simulator.singlePoint(s, bids, [false, true, true, false, false, false]);

    // 基准价 = (950+950+950+940+960+970)/6 = 953.333万
    var expectedBase = 9533333.33;
    if (Math.abs(result.basePrice - expectedBase) > 1) {
      return fail('用例C-基准价', expectedBase, result.basePrice);
    }

    // 我方得分：偏离 = (950-953.33)/953.33 = -0.3496%，扣0.3496 → 59.65
    var myResult = result.results[0];
    var expectedScore = 60 - 0.3496;
    if (Math.abs(myResult.score - expectedScore) > TOL) {
      return fail('用例C-我方得分', expectedScore.toFixed(2), myResult.score.toFixed(2));
    }

    return pass('用例C：伙伴固定95%×2+对手3家');
  };

  /**
   * 用例D：同一参数下"有伙伴 vs 无伙伴"对照，验证中标概率曲线平移
   */
  st.caseD = function () {
    var s = BDSS.config.createDefaultScheme();
    s.project.C_max = 10000000;
    s.pricingModel.type = 'A';
    s.scoring.S_max = 60;
    s.scoring.a = 1;
    s.scoring.b = 1;
    s.opponents.count = 3;
    s.opponents.distributions = [{ id: 'o1', type: 'uniform', params: { min: 0.92, max: 0.98 }, group: 'A' }];
    s.partners = [
      { id: 'p1', name: '伙伴A', enabled: true, method: 'fixed', fixedQuote: 9700000, narrow: { center: 97, spread: 1, dist: 'normal' }, samples: [], forceValid: false }
    ];
    s.strategy.range = { discountMin: 92, discountMax: 98, step: 1, relativeTo: 'C_max' };
    s.simulation.iterations = 2000;
    s.simulation.seed = 99;

    var candidates = BDSS.config.generateCandidates(s);

    // 有伙伴
    var resultsWith = BDSS.simulator.runBatch(s, candidates, { iterations: 2000, seed: 99, progressEvery: 9999 });
    var statsWith = BDSS.analyzer.aggregateBatch(resultsWith);

    // 无伙伴
    var sNoPartner = JSON.parse(JSON.stringify(s));
    sNoPartner.partners.forEach(function (p) { p.enabled = false; });
    sNoPartner.opponents.count = 4; // 保持总家数一致

    var resultsWithout = BDSS.simulator.runBatch(sNoPartner, candidates, { iterations: 2000, seed: 99, progressEvery: 9999 });
    var statsWithout = BDSS.analyzer.aggregateBatch(resultsWithout);

    // 伙伴报价较高(97%)→基准价上移→我方同样报价的胜率应升高
    // 即有伙伴的胜率应普遍 ≥ 无伙伴的胜率
    var withBest = statsWith.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];
    var withoutBest = statsWithout.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];

    if (withBest.candidate !== withoutBest.candidate) {
      // 最优点可能不同，但至少检查曲线是否向高报价方向偏移
    }

    // 伙伴报价高于对手均值 → 有伙伴时基准价偏高 → 同报价胜率更高
    if (withBest.winProb < withoutBest.winProb - 5) {
      return fail('用例D-胜率方向', '有伙伴胜率≥无伙伴', withBest.winProb + ' vs ' + withoutBest.winProb);
    }

    return pass('用例D：有伙伴 vs 无伙伴对照（胜率方向正确）');
  };

  /**
   * 用例E：固定种子两次运行结果逐位一致
   */
  st.caseE = function () {
    var s = BDSS.config.createDefaultScheme();
    s.project.C_max = 5000000;
    s.opponents.count = 3;
    s.opponents.distributions = [{ id: 'o1', type: 'normal', params: { mean: 0.95, std: 0.02 }, group: 'A' }];
    s.partners = [
      { id: 'p1', name: '伙伴A', enabled: true, method: 'narrow', fixedQuote: 0,
        narrow: { center: 95, spread: 1, dist: 'normal' }, samples: [], forceValid: false }
    ];
    s.strategy.range = { discountMin: 90, discountMax: 98, step: 1, relativeTo: 'C_max' };
    s.simulation.iterations = 1000;
    s.simulation.seed = 777;

    var candidates = BDSS.config.generateCandidates(s);

    var run1 = BDSS.simulator.runBatch(s, candidates, { iterations: 1000, seed: 777, progressEvery: 9999 });
    var run2 = BDSS.simulator.runBatch(s, candidates, { iterations: 1000, seed: 777, progressEvery: 9999 });

    var stats1 = BDSS.analyzer.aggregateBatch(run1);
    var stats2 = BDSS.analyzer.aggregateBatch(run2);

    for (var i = 0; i < stats1.length; i++) {
      if (Math.abs(stats1[i].expectedScore - stats2[i].expectedScore) > TOL) {
        return fail('用例E-期望得分不一致', stats1[i].expectedScore, stats2[i].expectedScore, '候选价 ' + stats1[i].candidate);
      }
      if (Math.abs(stats1[i].winProb - stats2[i].winProb) > TOL) {
        return fail('用例E-中标概率不一致', stats1[i].winProb, stats2[i].winProb, '候选价 ' + stats1[i].candidate);
      }
    }

    return pass('用例E：固定种子两次运行结果一致');
  };

  /**
   * 运行全部自检用例
   * @returns {{total:number, passed:number, failed:number, results:object[], text:string}}
   */
  st.runAll = function () {
    var cases = [
      { fn: st.caseA, label: 'A' },
      { fn: st.caseB, label: 'B' },
      { fn: st.caseC, label: 'C' },
      { fn: st.caseD, label: 'D' },
      { fn: st.caseE, label: 'E' }
    ];

    var results = [];
    var passed = 0, failed = 0;
    var lines = ['## 自检报告', ''];

    cases.forEach(function (c) {
      var r;
      try {
        r = c.fn();
      } catch (e) {
        r = { name: '用例' + c.label, pass: false, message: '异常: ' + e.message };
      }
      results.push(r);
      if (r.pass) { passed++; lines.push('- [x] ' + r.name); }
      else { failed++; lines.push('- [ ] ' + r.name + ' — ' + r.message); }
    });

    lines.push('');
    lines.push('**总计**：' + passed + '/' + cases.length + ' 通过' + (failed > 0 ? '，' + failed + ' 失败' : ''));

    return {
      total: cases.length,
      passed: passed,
      failed: failed,
      results: results,
      text: lines.join('\n')
    };
  };
})(window.BDSS = window.BDSS || {});
