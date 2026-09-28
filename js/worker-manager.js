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
  wm.runBatch = function (scheme, candidates, opts, onProgress, onDone, onError) {
    wm.initPool();

    var jobId = ++jobCounter;
    var aborted = false;
    var abortFlag = { aborted: false };

    // 无 Worker → 主线程降级
    if (workers.length === 0) {
      return wm._runMainThread(scheme, candidates, opts, onProgress, onDone, onError, abortFlag);
    }

    // 有 Worker → 单 Worker 执行（保证种子确定性）
    var worker = workers[0];
    var handler = function (e) {
      var msg = e.data;
      if (msg.jobId !== jobId) return;

      if (msg.type === 'progress' && onProgress) {
        onProgress(msg.done, msg.total, msg.elapsedMs, msg.etaMs);
      } else if (msg.type === 'done') {
        worker.removeEventListener('message', handler);
        if (!aborted && onDone) onDone(msg.results);
      } else if (msg.type === 'aborted') {
        worker.removeEventListener('message', handler);
      } else if (msg.type === 'error') {
        worker.removeEventListener('message', handler);
        if (onError) onError(msg.message);
      }
    };
    worker.addEventListener('message', handler);

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
        worker.postMessage({ type: 'abort', jobId: jobId });
      }
    };
  };

  /**
   * 主线程降级执行
   */
  wm._runMainThread = function (scheme, candidates, opts, onProgress, onDone, onError, abortFlag) {
    try {
      var results = BDSS.simulator.runBatch(
        scheme, candidates, opts, onProgress, abortFlag
      );
      if (!abortFlag.aborted && onDone) onDone(results);
    } catch (e) {
      if (onError) onError(e.message);
    }
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
