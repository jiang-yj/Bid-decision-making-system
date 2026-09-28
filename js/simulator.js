/**
 * js/simulator.js — 单点测算、批量蒙特卡洛、场景执行
 * 层级：simulator（Worker 安全：纯函数，零 DOM 依赖）
 *
 * 所有函数为纯函数，可被 .toString() 注入 Blob Worker。
 * 禁止引用 window、document 等外部作用域。
 */
(function (BDSS) {
  'use strict';

  var sim = (BDSS.simulator = BDSS.simulator || {});

  /* ============================================================
   * 采样辅助函数
   * ============================================================ */

  /**
   * 采样伙伴报价
   * @param {object[]} partners - 伙伴列表
   * @param {function} rngFunc - PRNG
   * @param {number} C_max
   * @param {number} costLine
   * @returns {{bids:number[], forceValidMask:boolean[]}}
   */
  sim.samplePartners = function (partners, rngFunc, C_max, costLine) {
    var bids = [];
    var mask = [];
    var lo = Math.min(costLine, C_max);
    var hi = C_max;

    for (var i = 0; i < partners.length; i++) {
      var p = partners[i];
      if (!p.enabled) continue;
      var bid;
      switch (p.method) {
        case 'fixed':
          bid = p.fixedQuote;
          break;
        case 'narrow':
          var center = p.narrow.center;
          var spread = p.narrow.spread;
          var mu = center; // 百分比形式
          // 转绝对值
          if (p.narrow.dist === 'normal') {
            bid = BDSS.rng.truncatedNormal(rngFunc, mu * C_max / 100, spread * C_max / 100, lo, hi);
          } else if (p.narrow.dist === 'uniform') {
            bid = BDSS.rng.uniform(rngFunc, (mu - spread) * C_max / 100, (mu + spread) * C_max / 100);
            bid = Math.max(lo, Math.min(hi, bid));
          } else {
            bid = BDSS.rng.triangular(rngFunc, (mu - spread) * C_max / 100, mu * C_max / 100, (mu + spread) * C_max / 100);
            bid = Math.max(lo, Math.min(hi, bid));
          }
          break;
        case 'sample':
          bid = BDSS.rng.sampleEmpirical(rngFunc, p.samples || []);
          bid = Math.max(lo, Math.min(hi, bid));
          break;
        default:
          bid = p.fixedQuote;
      }
      bids.push(bid);
      mask.push(p.forceValid);
    }
    return { bids: bids, forceValidMask: mask };
  };

  /**
   * 采样随机对手报价
   * @param {object} opponents - 对手配置
   * @param {function} rngFunc
   * @param {number} C_max
   * @param {number} costLine
   * @returns {number[]}
   */
  sim.sampleOpponents = function (opponents, rngFunc, C_max, costLine) {
    var count = opponents.count || 0;
    var dists = opponents.distributions || [];
    var bids = [];
    var lo = Math.min(costLine, C_max);
    var hi = C_max;

    for (var i = 0; i < count; i++) {
      var dist;
      if (dists.length === 0) {
        dist = { type: 'uniform', params: { min: lo, max: hi } };
      } else {
        dist = dists[i % dists.length];
      }
      // 参数从百分比转绝对值
      var d = JSON.parse(JSON.stringify(dist));
      if (d.type === 'uniform') {
        if (d.params.min <= 1) d.params = { min: d.params.min * C_max, max: d.params.max * C_max };
      } else if (d.type === 'normal') {
        if (d.params.mean <= 1) d.params = { mean: d.params.mean * C_max, std: d.params.std * C_max };
      } else if (d.type === 'triangular') {
        if (d.params.a <= 1) d.params = { a: d.params.a * C_max, b: d.params.b * C_max, c: d.params.c * C_max };
      }
      bids.push(BDSS.rng.sampleFromDist(rngFunc, d, lo, hi));
    }
    return bids;
  };

  /* ============================================================
   * F2-1 单点测算
   * ============================================================ */

  /**
   * 单点测算：给定一组确定报价，计算基准价、各家得分、排名
   * @param {object} s - Scheme
   * @param {number[]} allBids - 所有报价（含我方，我方在 index 0）
   * @param {boolean[]} forceValidMask - 强制有效掩码（对应 partners）
   * @returns {{basePrice:number, results:object[], myRank:number, validCount:number, lowConfidence:boolean}}
   */
  sim.singlePoint = function (s, allBids, forceValidMask) {
    var rules = BDSS.model.prepareRules(s);
    var rngFunc = BDSS.rng.mulberry32(12345); // 单点用固定种子（只影响随机废标）

    var filtered = BDSS.model.filterValid(allBids, rules, rngFunc, forceValidMask);
    var validBids = filtered.validBids;
    var validCount = validBids.length;
    var lowConfidence = validCount < rules.minValidBidders;

    // 如果有效报价为空，返回空结果
    if (validCount === 0) {
      return { basePrice: 0, results: [], myRank: 0, validCount: 0, lowConfidence: true, reasons: ['所有报价均无效'] };
    }

    // 计算基准价
    var B = BDSS.model.basePrice(validBids, s.pricingModel, s.project.C_max);

    // 计算各家得分
    var results = [];
    var myValidIndex = -1;
    for (var i = 0; i < allBids.length; i++) {
      var bid = allBids[i];
      var r = BDSS.model.checkBid(bid, rules, rngFunc);
      var force = forceValidMask && forceValidMask[i];
      if (!r.valid && !force) {
        results.push({ bid: bid, score: 0, valid: false, reason: r.reason });
        continue;
      }
      var score = BDSS.model.score(bid, B, s.scoring);
      results.push({ bid: bid, score: score, valid: true, reason: r.reason });
      if (i === 0) myValidIndex = results.length - 1;
    }

    // 计算我方排名
    var validScores = results.filter(function (r) { return r.valid; }).map(function (r) { return r.score; });
    var validBidsForRank = results.filter(function (r) { return r.valid; }).map(function (r) { return r.bid; });
    var myRank = myValidIndex >= 0 ? BDSS.model.calcRank(validBidsForRank, validScores, myValidIndex) : 0;

    return {
      basePrice: B,
      results: results,
      myRank: myRank,
      validCount: validCount,
      lowConfidence: lowConfidence
    };
  };

  /* ============================================================
   * F2-2 批量扫描（蒙特卡洛）
   * ============================================================ */

  /**
   * 批量蒙特卡洛扫描：对每个候选价跑 N 次模拟
   * @param {object} s - Scheme
   * @param {number[]} candidates - 候选报价列表
   * @param {object} opts - {iterations, seed, progressEvery, scenarioOverride}
   * @param {function} onProgress - (done, total, elapsedMs) 调用
   * @param {object} abortFlag - {aborted:boolean} 中止信号
   * @returns {object[]} 每个候选价的原始统计数据
   */
  sim.runBatch = function (s, candidates, opts, onProgress, abortFlag) {
    var iterations = opts.iterations || 5000;
    var seed = opts.seed || 12345;
    var progressEvery = opts.progressEvery || 500;
    var scenarioOverride = opts.scenarioOverride || null;

    var results = [];
    var total = candidates.length * iterations;
    var done = 0;
    var startTime = Date.now();

    // 应用场景覆盖（如 noPartner / partnerShift）
    var scheme = scenarioOverride ? sim.applyScenarioOverride(s, scenarioOverride) : s;
    var rules = BDSS.model.prepareRules(scheme);
    var C_max = scheme.project.C_max;
    var costLine = scheme.project.costWarningLine || 0;
    var partners = (scheme.partners || []).filter(function (p) { return p.enabled; });

    for (var ci = 0; ci < candidates.length; ci++) {
      if (abortFlag && abortFlag.aborted) break;

      var myBid = candidates[ci];
      var candSeed = BDSS.rng.deriveSeed(seed, ci);
      var rngFunc = BDSS.rng.mulberry32(candSeed);

      // 预分配 TypedArray 以提升性能
      var scoresArr = new Float64Array(iterations);
      var ranksArr = new Int32Array(iterations);
      var validRounds = 0;
      var winCount = 0; // 第1名次数
      var flaggedRounds = 0;
      var detailSamples = []; // 抽样明细

      for (var it = 0; it < iterations; it++) {
        if (abortFlag && abortFlag.aborted) break;

        // 采样伙伴
        var pRes = sim.samplePartners(partners, rngFunc, C_max, costLine);
        // 采样对手
        var oppBids = sim.sampleOpponents(scheme.opponents, rngFunc, C_max, costLine);
        // 组合报价（我方在 index 0）
        var allBids = [myBid].concat(pRes.bids).concat(oppBids);
        var fullMask = [false].concat(pRes.forceValidMask).concat(oppBids.map(function () { return false; }));

        // 过滤有效
        var filtered = BDSS.model.filterValid(allBids, rules, rngFunc, fullMask);
        var validBids = filtered.validBids;

        // 找我方是否在有效报价中
        var myValidIndex = -1;
        var myInValid = false;
        for (var k = 0; k < allBids.length; k++) {
          if (allBids[k] === myBid && (fullMask[k] || BDSS.model.checkBid(myBid, rules, null).valid)) {
            myInValid = true;
            break;
          }
        }

        if (validBids.length < rules.minValidBidders || !myInValid) {
          // 有效家数不足或我方被废，跳过本轮
          continue;
        }

        // 找我方在 validBids 中的索引
        for (var m = 0; m < validBids.length; m++) {
          if (Math.abs(validBids[m] - myBid) < 1e-6) { myValidIndex = m; break; }
        }
        if (myValidIndex < 0) continue;

        validRounds++;

        // 基准价
        var B = BDSS.model.basePrice(validBids, scheme.pricingModel, C_max);

        // 得分
        var myScore = BDSS.model.score(myBid, B, scheme.scoring);
        scoresArr[validRounds - 1] = myScore;

        // 排名
        var allScores = [];
        for (var j = 0; j < validBids.length; j++) {
          allScores.push(BDSS.model.score(validBids[j], B, scheme.scoring));
        }
        var myRank = BDSS.model.calcRank(validBids, allScores, myValidIndex);
        ranksArr[validRounds - 1] = myRank;
        if (myRank === 1) winCount++;

        // 抽样明细（前5轮）
        if (detailSamples.length < 5) {
          detailSamples.push({
            iteration: it,
            seed: candSeed,
            basePrice: B,
            myBid: myBid,
            myScore: myScore,
            myRank: myRank,
            validBids: Array.prototype.slice.call(validBids),
            allBids: allBids.slice()
          });
        }

        done++;
        if (it % progressEvery === 0 && onProgress) {
          var elapsed = Date.now() - startTime;
          var eta = total > 0 ? (elapsed / done) * (total - done) : 0;
          onProgress(done, total, elapsed, eta);
        }
      }

      // 收集该候选价的原始数据
      results.push({
        candidate: myBid,
        candidateIndex: ci,
        scores: scoresArr.slice(0, validRounds),
        ranks: ranksArr.slice(0, validRounds),
        validRounds: validRounds,
        totalRounds: iterations,
        winCount: winCount,
        detailSamples: detailSamples
      });
    }

    return results;
  };

  /* ============================================================
   * F2-3 场景执行
   * ============================================================ */

  /**
   * 应用场景覆盖，返回修改后的 Scheme 副本
   * @param {object} s - 原始 Scheme
   * @param {object} scenario - 场景定义
   * @returns {object} 修改后的 Scheme 副本
   */
  sim.applyScenarioOverride = function (s, scenario) {
    var copy = JSON.parse(JSON.stringify(s));

    switch (scenario.type) {
      case 'noPartner':
        // 无伙伴：禁用所有伙伴
        copy.partners.forEach(function (p) { p.enabled = false; });
        break;
      case 'withPartner':
        // 基准假设，不修改
        break;
      case 'partnerShift':
        // 伙伴集体偏移
        var pct = scenario.params.shiftPct || 0;
        copy.partners.forEach(function (p) {
          if (p.method === 'fixed') {
            p.fixedQuote = p.fixedQuote * (1 + pct / 100);
          } else if (p.method === 'narrow') {
            p.narrow.center = p.narrow.center + pct;
          }
        });
        break;
      case 'rejectPartner':
        // 指定伙伴废标
        var pid = scenario.params.partnerId;
        var partner = copy.partners.find(function (p) { return p.id === pid; });
        if (partner) partner.enabled = false;
        break;
    }
    return copy;
  };

  /**
   * 执行场景矩阵
   * @param {object} s - Scheme
   * @param {object[]} scenarios - 场景列表
   * @param {object} opts - 模拟选项
   * @param {function} onProgress
   * @param {object} abortFlag
   * @returns {object[]} 每个场景的结果
   */
  sim.runScenarios = function (s, scenarios, opts, onProgress, abortFlag) {
    var results = [];
    var candidates = BDSS.config.generateCandidates(s);

    for (var i = 0; i < scenarios.length; i++) {
      if (abortFlag && abortFlag.aborted) break;
      var sc = scenarios[i];
      if (!sc.enabled) continue;

      var scenarioOpts = Object.assign({}, opts, { scenarioOverride: sc });
      var batchResult = sim.runBatch(s, candidates, scenarioOpts, onProgress, abortFlag);

      results.push({
        scenario: sc,
        batchResult: batchResult
      });
    }
    return results;
  };
})(window.BDSS = window.BDSS || {});
