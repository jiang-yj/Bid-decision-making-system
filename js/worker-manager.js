/**
 * js/worker-manager.js — Blob Worker 构建、池化、中止信号、主线程降级
 * 层级：worker-manager（非 Worker 安全：操作 DOM/Worker API）
 *
 * 核心思路：将 rng/model/simulator 的纯函数 .toString() 注入 Blob Worker，
 * 并重建闭包上下文（私有 helper、SANDBOX 常量、rng/model/sim 别名），
 * 使 Worker 中函数内部对 rng.x / model.x / sim.x 的引用可正确解析。
 * file:// 下可靠运行。无 Worker 时降级为主线程同步执行。
 */
(function (BDSS) {
  'use strict';

  var wm = (BDSS.workerManager = BDSS.workerManager || {});

  var jobCounter = 0;
  var workers = [];
  var poolSize = Math.min(navigator.hardwareConcurrency || 4, 4);

  /**
   * 注入一个函数为 BDSS.<ns>.<name> = <func>
   */
  function assign(ns, name, fn) {
    return 'BDSS.' + ns + '.' + name + ' = ' + fn.toString() + ';\n';
  }

  /**
   * 注入一个顶层函数声明（用于闭包私有 helper）
   */
  function declare(name, fn) {
    return 'var ' + name + ' = ' + fn.toString() + ';\n';
  }

  /**
   * 构建 Worker 源代码（拼接纯函数字符串 + 闭包上下文 + Worker 主函数）
   * @returns {string}
   */
  wm.buildWorkerSource = function () {
    var src = '';
    src += '"use strict";\n';
    src += 'var BDSS = { rng: {}, model: {}, simulator: {} };\n';

    // ---- rng 层（无闭包私有依赖，互相通过 BDSS.rng.* 调用）----
    src += assign('rng', 'mulberry32', BDSS.rng.mulberry32);
    src += assign('rng', 'xorshift128plus', BDSS.rng.xorshift128plus);
    src += assign('rng', 'hashSeed', BDSS.rng.hashSeed);
    src += assign('rng', 'deriveSeed', BDSS.rng.deriveSeed);
    src += assign('rng', 'boxMuller', BDSS.rng.boxMuller);
    src += assign('rng', 'truncatedNormal', BDSS.rng.truncatedNormal);
    src += assign('rng', 'triangular', BDSS.rng.triangular);
    src += assign('rng', 'uniform', BDSS.rng.uniform);
    src += assign('rng', 'sampleEmpirical', BDSS.rng.sampleEmpirical);
    src += assign('rng', 'sampleFromDist', BDSS.rng.sampleFromDist);

    // ---- model 层闭包私有 helper（顶层声明，使 model.* 函数体可解析）----
    var h = BDSS.model._h || {};
    src += declare('mean', h.mean);
    src += declare('median', h.median);
    src += declare('minArr', h.minArr);
    src += declare('maxArr', h.maxArr);
    src += declare('tokenize', h.tokenize);
    src += declare('toRPN', h.toRPN);
    src += declare('evalRPN', h.evalRPN);
    src += declare('markFunctions', h.markFunctions);

    // SANDBOX 常量
    src += 'var SANDBOX_VARS = ' + JSON.stringify(h.SANDBOX_VARS || []) + ';\n';
    src += 'var SANDBOX_FUNCS = { abs: Math.abs, min: Math.min, max: Math.max, ' +
           'round: Math.round, floor: Math.floor, ceil: Math.ceil, ' +
           'sqrt: Math.sqrt, log: Math.log, exp: Math.exp, pow: Math.pow };\n';

    // ---- model 层函数（内部引用 model.*/mean/median/SANDBOX_*）----
    src += assign('model', 'basePrice', BDSS.model.basePrice);
    src += assign('model', 'basePrice_B', BDSS.model.basePrice_B);
    src += assign('model', 'basePrice_D', BDSS.model.basePrice_D);
    src += assign('model', 'basePrice_custom', BDSS.model.basePrice_custom);
    src += assign('model', 'score', BDSS.model.score);
    src += assign('model', 'checkBid', BDSS.model.checkBid);
    src += assign('model', 'filterValid', BDSS.model.filterValid);
    src += assign('model', 'calcRank', BDSS.model.calcRank);
    src += assign('model', 'prepareRules', BDSS.model.prepareRules);

    // ---- simulator 层（内部引用 sim.*/BDSS.rng.*/BDSS.model.*）----
    src += assign('simulator', 'samplePartners', BDSS.simulator.samplePartners);
    src += assign('simulator', 'sampleOpponents', BDSS.simulator.sampleOpponents);
    src += assign('simulator', 'runBatch', BDSS.simulator.runBatch);
    src += assign('simulator', 'applyScenarioOverride', BDSS.simulator.applyScenarioOverride);

    // ---- 闭包别名：使函数体中 rng.x/model.x/sim.x 引用可解析 ----
    src += 'var rng = BDSS.rng;\n';
    src += 'var model = BDSS.model;\n';
    src += 'var sim = BDSS.simulator;\n';

    // ---- 暴露到 self 以便 _workerMain 内的 self.BDSS 解析到已填充对象 ----
    src += 'self.BDSS = BDSS;\n';

    // ---- Worker 主函数（IIFE 立即执行）----
    src += '(' + wm._workerMain.toString() + ')();\n';

    return src;
  };

  /**
   * Worker 主函数（在 Worker 上下文执行）
   * 接收消息 → 调用 BDSS.simulator.runBatch → 发回进度/完成/中止
   */
  wm._workerMain = function _workerMain() {
    var BDSS = self.BDSS || (self.BDSS = {});
    var abortFlags = {};

    self.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'abort') {
        if (abortFlags[msg.jobId]) abortFlags[msg.jobId].aborted = true;
        return;
      }

      if (msg.type !== 'run') return;
      var jobId = msg.jobId;
      var abortFlag = { aborted: false };
      abortFlags[jobId] = abortFlag;

      try {
        var results = BDSS.simulator.runBatch(
          msg.scheme,
          msg.candidates,
          {
            iterations: msg.iterations,
            seed: msg.seed,
            progressEvery: msg.progressEvery,
            scenarioOverride: msg.scenarioOverride || null
          },
          function (done, total, elapsed, eta) {
            self.postMessage({
              type: 'progress',
              jobId: jobId,
              done: done,
              total: total,
              elapsedMs: elapsed,
              etaMs: eta
            });
          },
          abortFlag
        );

        if (abortFlag.aborted) {
          self.postMessage({ type: 'aborted', jobId: jobId });
        } else {
          self.postMessage({ type: 'done', jobId: jobId, results: results });
        }
        delete abortFlags[jobId];
      } catch (err) {
        self.postMessage({
          type: 'error',
          jobId: jobId,
          message: err.message,
          stack: err.stack || ''
        });
        delete abortFlags[jobId];
      }
    };
  };

  /**
   * 创建 Blob Worker
   * @returns {Worker|null}
   */
  wm.createWorker = function () {
    try {
      var src = wm.buildWorkerSource();
      var blob = new Blob([src], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      var worker = new Worker(url);
      // 绑定 onerror 兜底：脚本加载失败时标记为不可用，让上层降级主线程
      worker._bdssFailed = false;
      worker.onerror = function (e) {
        worker._bdssFailed = true;
        console.warn('[BDSS] Worker 加载/执行失败:', (e && e.message) || e);
      };
      return worker;
    } catch (e) {
      console.warn('[BDSS] Blob Worker 创建失败，将降级为主线程执行:', e.message);
      return null;
    }
  };

  /**
   * 初始化 Worker 池
   */
  wm.initPool = function () {
    if (workers.length > 0) return;
    var w = wm.createWorker();
    if (w) workers.push(w);
    if (workers.length === 0) {
      console.warn('[BDSS] 无可用 Worker，将使用主线程降级模式');
    }
  };

  /**
   * 执行批量模拟（自动选择 Worker 或主线程）
   * @param {object} scheme
   * @param {number[]} candidates
   * @param {object} opts - {iterations, seed, progressEvery, scenarioOverride}
   * @param {function} onProgress - (done, total, elapsedMs, etaMs)
   * @param {function} onDone - (results)
   * @param {function} onError - (message)
   * @returns {{abort:function}} 控制句柄
   */
  /**
   * 是否处于 file:// 环境（该环境下 Blob Worker 可靠性差，直接走主线程分块）
   */
  function isFileProtocol() {
    try { return typeof location !== 'undefined' && location && location.protocol === 'file:'; }
    catch (e) { return false; }
  }

  wm.runBatch = function (scheme, candidates, opts, onProgress, onDone, onError) {
    // file:// 下跳过 Worker，直接主线程分块异步执行（最可靠，不冻结 UI）
    if (isFileProtocol()) {
      return wm._runMainThread(scheme, candidates, opts, onProgress, onDone, onError, { aborted: false });
    }

    wm.initPool();

    var jobId = ++jobCounter;
    var aborted = false;
    var fallbacked = false;
    var gotResponse = false;

    // 无可用 Worker → 主线程分块异步降级（不冻结 UI）
    if (workers.length === 0) {
      return wm._runMainThread(scheme, candidates, opts, onProgress, onDone, onError, { aborted: false });
    }

    // 有 Worker → 单 Worker 执行（保证种子确定性）
    var worker = workers[0];

    function startFallback(reason) {
      if (fallbacked || aborted) return;
      fallbacked = true;
      clearTimeout(watchdog);
      try { worker.removeEventListener('message', handler); } catch (e) {}
      // 销毁坏 Worker，避免后续任务复用；下次任务会重建
      try { worker.terminate(); } catch (e) {}
      workers.length = 0;
      console.warn('[BDSS] Worker 不可用（' + reason + '），降级主线程分块执行');
      wm._runMainThread(scheme, candidates, opts, onProgress, onDone, onError, abortFlag);
    }

    // 无条件看门狗：400ms 内未收到 Worker 任何回应（加载失败/静默/异常），
    // 一律降级主线程分块执行，避免永久卡死
    var watchdog = setTimeout(function () {
      if (!gotResponse) startFallback('超时无响应');
    }, 400);

    // 本任务期望总量（候选价 × 迭代次数），Worker done 消息不携带 total，用它补齐进度
    var expectedTotal = candidates.length * (opts.iterations || 0);

    var abortFlag = { aborted: false };
    var handler = function (e) {
      var msg = e.data;
      if (msg.jobId !== jobId) return;

      if (msg.type === 'progress') {
        gotResponse = true;
        if (onProgress) onProgress(msg.done, msg.total, msg.elapsedMs, msg.etaMs);
      } else if (msg.type === 'done') {
        gotResponse = true;
        clearTimeout(watchdog);
        worker.removeEventListener('message', handler);
        // 进度补齐到 total（simulator 内部 done 只计有效轮，可能 < total）
        if (onProgress) onProgress(expectedTotal, expectedTotal, msg.elapsedMs || 0, 0);
        if (!aborted && onDone) onDone(msg.results);
      } else if (msg.type === 'aborted') {
        clearTimeout(watchdog);
        worker.removeEventListener('message', handler);
      } else if (msg.type === 'error') {
        clearTimeout(watchdog);
        worker.removeEventListener('message', handler);
        if (onError) onError(msg.message);
      }
    };
    worker.addEventListener('message', handler);

    // Worker onerror：加载失败时立即降级（不再等看门狗）
    worker.onerror = function (e) {
      worker._bdssFailed = true;
      if (!gotResponse) startFallback((e && e.message) || 'onerror');
    };

    worker.postMessage({
      type: 'run',
      jobId: jobId,
      scheme: scheme,
      candidates: candidates,
      iterations: opts.iterations,
      seed: opts.seed,
      progressEvery: opts.progressEvery || 500,
      scenarioOverride: opts.scenarioOverride || null
    });

    return {
      abort: function () {
        aborted = true;
        abortFlag.aborted = true;
        clearTimeout(watchdog);
        try { worker.postMessage({ type: 'abort', jobId: jobId }); } catch (e) {}
      }
    };
  };

  /**
   * 主线程降级执行 — 小块异步：按候选价 × 迭代小块（默认200迭代/块）推进，
   * 每块后 setTimeout(0) 让出 UI 重绘；中止信号在块间与块内均生效。
   * 各小块使用确定性派生种子（同参数+种子可复现），统计上 i.i.d. 等价。
   */
  wm._runMainThread = function (scheme, candidates, opts, onProgress, onDone, onError, abortFlag) {
    var BLOCK = 200; // 每块迭代数（约 10~50ms，保证 UI 流畅）
    var iterations = opts.iterations || 5000;
    var seed = opts.seed || 12345;
    var scenarioOverride = opts.scenarioOverride || null;
    var totalAll = candidates.length * iterations;
    var itrProcessed = 0;
    var startTime = Date.now();
    var ci = 0;

    function mergedResult(cand, ciIndex, blocks) {
      var scores = [];
      var ranks = [];
      var validRounds = 0;
      var winCount = 0;
      var detailSamples = [];
      blocks.forEach(function (b) {
        Array.prototype.push.apply(scores, Array.prototype.slice.call(b.scores));
        Array.prototype.push.apply(ranks, Array.prototype.slice.call(b.ranks));
        validRounds += b.validRounds;
        winCount += b.winCount;
        if (detailSamples.length < 5 && b.detailSamples) {
          b.detailSamples.forEach(function (d) { if (detailSamples.length < 5) detailSamples.push(d); });
        }
      });
      return {
        candidate: cand,
        candidateIndex: ciIndex,
        scores: Float64Array.from(scores),
        ranks: Int32Array.from(ranks),
        validRounds: validRounds,
        totalRounds: iterations,
        winCount: winCount,
        detailSamples: detailSamples
      };
    }

    function runCandidate() {
      if (abortFlag.aborted) { finish(); return; }
      // 全部候选价已处理 → 结束（防止 ci 越界后无限空转）
      if (ci >= candidates.length) { finish(); return; }
      var cand = candidates[ci];
      var blocks = [];
      var remaining = iterations;
      var blockIndex = 0;

      function runBlock() {
        if (abortFlag.aborted) { finish(); return; }
        var n = Math.min(BLOCK, remaining);
        // 确定性块种子：候选种子再按块派生
        var blockSeed = BDSS.rng.deriveSeed(BDSS.rng.deriveSeed(seed, ci), blockIndex);
        try {
          var partial = BDSS.simulator.runBatch(
            scheme, [cand],
            { iterations: n, seed: blockSeed, progressEvery: n + 1, scenarioOverride: scenarioOverride },
            null, abortFlag
          );
          if (partial && partial.length) blocks.push(partial[0]);
        } catch (e) {
          if (onError) onError(e.message);
          return;
        }
        remaining -= n;
        itrProcessed += n;
        blockIndex++;
        var elapsed = Date.now() - startTime;
        var eta = itrProcessed > 0 ? (elapsed / itrProcessed) * (totalAll - itrProcessed) : 0;
        if (onProgress) onProgress(itrProcessed, totalAll, elapsed, eta);
        if (remaining > 0) {
          setTimeout(runBlock, 0); // 块间让出 UI
        } else {
          _collected.push(mergedResult(cand, ci, blocks));
          ci++;
          setTimeout(runCandidate, 0); // 候选间让出 UI
        }
      }
      setTimeout(runBlock, 0);
    }

    var _collected = [];
    function finish() {
      // 中止时进度补齐已处理量；完成时补齐 total
      if (!abortFlag.aborted && onProgress) onProgress(totalAll, totalAll, Date.now() - startTime, 0);
      if (onDone) onDone(_collected);
    }

    setTimeout(runCandidate, 0);
    return { abort: function () { abortFlag.aborted = true; } };
  };

  /**
   * 销毁所有 Worker
   */
  wm.destroyPool = function () {
    workers.forEach(function (w) { try { w.terminate(); } catch (e) {} });
    workers = [];
  };
})(window.BDSS = window.BDSS || {});
