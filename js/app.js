/**
 * js/app.js — 应用接线层：BDSS.state、BDSS.bus、Alpine 组件、演算编排
 * 层级：app（顶层，依赖所有下层模块）
 */
(function (BDSS) {
  'use strict';

  /* ============================================================
   * BDSS.bus — 简易事件总线
   * ============================================================ */
  BDSS.bus = (function () {
    var subs = {};
    return {
      on: function (evt, fn) { (subs[evt] = subs[evt] || []).push(fn); },
      off: function (evt, fn) { if (subs[evt]) subs[evt] = subs[evt].filter(function (f) { return f !== fn; }); },
      emit: function (evt, payload) { (subs[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error('[BDSS.bus]', evt, e); } }); }
    };
  })();

  /* ============================================================
   * Alpine 根组件
   *  — 暴露给 index.html 的 x-data="bdssApp()"
   *  — 通过闭包持有当前 scheme、UI 状态、缓存结果
   * ============================================================ */
  window.bdssApp = function () {
    return {
      // ====== 响应式状态 ======
      defaults: BDSS.defaults,
      complianceNotice: BDSS.defaults.complianceNotice,
      s: BDSS.config.createDefaultScheme(), // 当前编辑中的方案
      currentSchemeId: '',
      schemeList: [],
      showManager: false,
      showSelfTest: false,
      selfTestHtml: '',

      // UI 杂项状态
      ui: { complianceDismissed: false },
      sampleText: {},          // 伙伴样本输入文本（按索引）
      distParamText: {},       // 对手分布参数文本（按索引）
      strategyListText: '',
      formulaStatus: '',

      // 运行状态
      running: false,
      progress: { done: 0, total: 0, elapsedMs: 0, etaMs: 0 },
      _abortHandle: null,

      // 缓存结果
      singleResult: null,
      batchStats: null,
      scenarioStats: null,
      conclusions: null,
      conclusionsHtml: '',

      // Toast
      toast: { show: false, text: '' },

      /* ------------------------------------------------------
       * 计算属性（getter 形式，Alpine 模板直接访问）
       * ------------------------------------------------------ */
      get modelReadable() { return BDSS.config.getModelReadable(this.s); },

      get validation() { return BDSS.config.validate(this.s); },

      get candidates() { return BDSS.config.generateCandidates(this.s); },

      get progressPct() {
        var p = this.progress;
        if (!p.total) return 0;
        return Math.min(100, Math.round((p.done / p.total) * 100));
      },

      get progressText() {
        var p = this.progress;
        if (!this.running && p.done === 0) return '';
        var done = p.done || 0, total = p.total || 0;
        var elapsed = (p.elapsedMs / 1000).toFixed(1);
        var eta = p.etaMs ? (p.etaMs / 1000).toFixed(1) + 's' : '--';
        return done + ' / ' + total + '（' + elapsed + 's，ETA ' + eta + '）';
      },

      /* ------------------------------------------------------
       * 初始化
       * ------------------------------------------------------ */
      init() {
        var self = this;
        // 监听 toast 事件
        BDSS.bus.on('toast', function (msg) { self.showToast(msg); });

        // 载入方案列表
        this.refreshSchemeList();

        // 若本地无任何方案，自动安装示例并载入第一个
        if (this.schemeList.length === 0) {
          BDSS.storage.installExamples();
          this.refreshSchemeList();
        }
        if (this.schemeList.length > 0) {
          var first = this.schemeList[0];
          this.loadScheme(first.id);
        }

        // 初始化默认分布/策略文本
        this.syncParamTexts();

        // 监听窗口关闭前销毁 Worker
        window.addEventListener('beforeunload', function () {
          try { BDSS.workerManager.destroyPool(); } catch (e) {}
        });
      },

      /* ------------------------------------------------------
       * 方案管理
       * ------------------------------------------------------ */
      refreshSchemeList() {
        this.schemeList = BDSS.storage.list();
      },

      newScheme() {
        this.s = BDSS.config.createDefaultScheme();
        this.currentSchemeId = this.s.meta.id;
        this.singleResult = null;
        this.batchStats = null;
        this.scenarioStats = null;
        this.conclusions = null;
        this.conclusionsHtml = '';
        this.syncParamTexts();
        this.showToast('已新建方案，记得保存');
      },

      loadScheme(id) {
        var s = BDSS.storage.load(id);
        if (!s) { this.showToast('方案加载失败'); return; }
        this.s = s;
        this.currentSchemeId = id;
        // 恢复缓存的结果（如有）
        if (s.results && s.results.batch) {
          this.batchStats = s.results.batch;
          this.conclusions = s.results.conclusions;
          this.conclusionsHtml = this.conclusions ? BDSS.ui.markdownToHtml(this.conclusions.recommendations.text) : '';
        } else {
          this.batchStats = null;
          this.conclusions = null;
          this.conclusionsHtml = '';
        }
        this.singleResult = s.results && s.results.single ? s.results.single : null;
        this.scenarioStats = s.results && s.results.scenarios ? s.results.scenarios : null;
        this.syncParamTexts();
        this.showToast('已载入：' + s.meta.name);
      },

      saveScheme() {
        var v = this.validation;
        if (!v.ok) {
          this.showToast('校验失败：' + v.errors[0]);
          return;
        }
        // 把当前结果写入 scheme.results
        this.s.results = {
          single: this.singleResult,
          batch: this.batchStats,
          scenarios: this.scenarioStats,
          conclusions: this.conclusions,
          updatedAt: new Date().toISOString()
        };
        BDSS.storage.save(this.s);
        this.refreshSchemeList();
        this.currentSchemeId = this.s.meta.id;
        this.showToast('已保存：' + this.s.meta.name);
      },

      copyScheme() {
        if (!this.currentSchemeId) return;
        var s = BDSS.storage.copy(this.currentSchemeId);
        if (s) {
          this.refreshSchemeList();
          this.loadScheme(s.meta.id);
        }
      },

      copySchemeById(id) {
        var s = BDSS.storage.copy(id);
        if (s) { this.refreshSchemeList(); this.showToast('已复制方案'); }
      },

      renameScheme(id) {
        var name = prompt('请输入新名称：', BDSS.storage.load(id).meta.name);
        if (name) {
          BDSS.storage.rename(id, name.trim());
          this.refreshSchemeList();
          if (this.currentSchemeId === id) this.s.meta.name = name.trim();
          this.showToast('已重命名');
        }
      },

      deleteScheme(id) {
        if (!confirm('确认删除该方案？此操作不可撤销。')) return;
        BDSS.storage.del(id);
        this.refreshSchemeList();
        if (this.currentSchemeId === id) {
          if (this.schemeList.length > 0) this.loadScheme(this.schemeList[0].id);
          else this.newScheme();
        }
        this.showToast('已删除');
      },

      togglePin(id) {
        BDSS.storage.togglePin(id);
        this.refreshSchemeList();
      },

      exportJSON() {
        var scheme = this.s;
        scheme.results = {
          single: this.singleResult, batch: this.batchStats,
          scenarios: this.scenarioStats, conclusions: this.conclusions,
          updatedAt: new Date().toISOString()
        };
        BDSS.storage.download(BDSS.storage.exportJSON(scheme),
          (scheme.meta.name || '方案') + '.json', 'application/json');
        this.showToast('JSON 已导出');
      },

      importJSON(event) {
        var self = this;
        var file = event.target.files[0];
        if (!file) return;
        BDSS.storage.importFile(file, function (res) {
          if (res.ok) {
            self.refreshSchemeList();
            self.loadScheme(res.scheme.meta.id);
            self.showToast('导入成功');
          } else {
            self.showToast('导入失败：' + res.error);
          }
          event.target.value = '';
        });
      },

      installExamples() {
        BDSS.storage.installExamples();
        this.refreshSchemeList();
        this.showToast('内置示例已载入');
      },

      loadCSVExample() {
        this.s.opponents.csv = BDSS.historicalCSV;
        this.showToast('历史CSV已填入对手配置');
      },

      /* ------------------------------------------------------
       * 动态表单项管理
       * ------------------------------------------------------ */
      addPartner() {
        this.s.partners.push(BDSS.config.createDefaultPartner('伙伴' + (this.s.partners.length + 1)));
      },

      addDist() {
        this.s.opponents.distributions.push(BDSS.config.createDefaultDist());
      },

      addScenario() {
        this.s.scenarios.push(BDSS.config.createDefaultScenario());
      },

      addComposite() {
        if (!this.s.pricingModel.params.components) this.s.pricingModel.params.components = [];
        this.s.pricingModel.params.components.push({ w: 1, src: 'avg' });
      },

      onPricingModelChange() {
        var pm = this.s.pricingModel;
        if (pm.type === 'D' && (!pm.params.components || pm.params.components.length === 0)) {
          pm.params.components = [{ w: 0.5, src: 'C_max' }, { w: 0.5, src: 'avg' }];
        }
        if (pm.type === 'C' && !pm.params.K) pm.params.K = 0.98;
        if (pm.type === 'custom' && !pm.params.formula) pm.params.formula = 'mean(Q)*0.98';
      },

      validateFormula() {
        var pm = this.s.pricingModel;
        var r = BDSS.model.validateFormula(pm.params.formula || '');
        this.formulaStatus = r.ok ? '✓ 公式合法' : '✗ ' + r.error;
      },

      /* ------------------------------------------------------
       * 文本 ↔ 数据双向辅助
       * ------------------------------------------------------ */
      syncParamTexts() {
        var self = this;
        this.sampleText = {};
        this.s.partners.forEach(function (p, i) {
          if (p.samples && p.samples.length) self.sampleText[i] = p.samples.join(',');
        });
        this.distParamText = {};
        this.s.opponents.distributions.forEach(function (d, i) {
          self.distParamText[i] = self._distParamsToString(d);
        });
        if (this.s.strategy.candidateMode === 'list' && this.s.strategy.list) {
          this.strategyListText = this.s.strategy.list.join(',');
        }
      },

      _distParamsToString(d) {
        var p = d.params || {};
        if (d.type === 'uniform') return 'min=' + p.min + ',max=' + p.max;
        if (d.type === 'normal') return 'mean=' + p.mean + ',std=' + p.std;
        if (d.type === 'triangular') return 'a=' + p.a + ',b=' + p.b + ',c=' + p.c;
        if (d.type === 'empirical') return 'samples=' + ((p.samples || []).slice(0, 5).join(';')) + (p.samples && p.samples.length > 5 ? '...' : '');
        return '';
      },

      parseSamples(i) {
        var txt = (this.sampleText[i] || '').trim();
        if (!txt) { this.s.partners[i].samples = []; return; }
        this.s.partners[i].samples = txt.split(/[,，\s]+/).filter(Boolean).map(Number).filter(function (n) { return !isNaN(n); });
      },

      parseDistParams(i) {
        var txt = (this.distParamText[i] || '').trim();
        var d = this.s.opponents.distributions[i];
        if (!d || !txt) return;
        // 解析 key=value,key2=value2
        var kv = {};
        txt.split(/[,，\s]+/).forEach(function (pair) {
          var m = pair.split('=');
          if (m.length === 2) kv[m[0].trim()] = isNaN(Number(m[1])) ? m[1].trim() : Number(m[1]);
        });
        var p = d.params || (d.params = {});
        for (var k in kv) p[k] = kv[k];
        if (d.type === 'empirical' && typeof kv.samples === 'string') {
          p.samples = kv.samples.split(';').map(Number).filter(function (n) { return !isNaN(n); });
        }
      },

      parseStrategyList() {
        var txt = (this.strategyListText || '').trim();
        if (!txt) { this.s.strategy.list = []; return; }
        this.s.strategy.list = txt.split(/[,，\s]+/).filter(Boolean).map(Number).filter(function (n) { return !isNaN(n); });
      },

      /* ------------------------------------------------------
       * 演算编排
       * ------------------------------------------------------ */
      _buildRunOpts(scenarioOverride) {
        var sim = this.s.simulation;
        return {
          iterations: sim.iterations,
          seed: sim.seed,
          progressEvery: sim.progressEvery,
          useWorker: sim.useWorker,
          scenarioOverride: scenarioOverride || null
        };
      },

      runSinglePoint() {
        var v = this.validation;
        if (!v.ok) { this.showToast('校验失败：' + v.errors[0]); return; }
        var s = this.s;
        var cands = this.candidates;
        if (cands.length === 0) { this.showToast('无候选报价，请检查策略'); return; }
        // 取中间候选价做单点测算
        var myBid = cands[Math.floor(cands.length / 2)];
        var partners = (s.partners || []).filter(function (p) { return p.enabled; });
        var rngFunc = BDSS.rng.mulberry32(s.simulation.seed);
        var costLine = s.project.costWarningLine || 0;
        var pRes = BDSS.simulator.samplePartners(partners, rngFunc, s.project.C_max, costLine);
        var oppBids = BDSS.simulator.sampleOpponents(s.opponents, rngFunc, s.project.C_max, costLine);
        var allBids = [myBid].concat(pRes.bids).concat(oppBids);
        var fullMask = [false].concat(pRes.forceValidMask).concat(oppBids.map(function () { return false; }));
        var result = BDSS.simulator.singlePoint(s, allBids, fullMask);
        this.singleResult = result;
        var cur = BDSS.defaults.currencies.find(function (c) { return c.code === s.project.currency; });
        BDSS.ui.renderSinglePoint(result, cur ? cur.symbol : '¥');
        this.showToast('单点测算完成（候选价 ' + BDSS.ui.fmt(myBid, 0) + '）');
      },

      runBatch() {
        var self = this;
        var v = this.validation;
        if (!v.ok) { this.showToast('校验失败：' + v.errors[0]); return; }
        var cands = this.candidates;
        if (cands.length === 0) { this.showToast('无候选报价'); return; }
        if (cands.length > 50) { this.showToast('候选价过多（>50），请缩小步长或区间'); return; }

        this.running = true;
        this.progress = { done: 0, total: cands.length * this.s.simulation.iterations, elapsedMs: 0, etaMs: 0 };
        var opts = this._buildRunOpts();
        var scheme = this.s;

        var useWorker = scheme.simulation.useWorker && (typeof Worker !== 'undefined');

        function onProgress(done, total, elapsed, eta) {
          self.progress = { done: done, total: total, elapsedMs: elapsed, etaMs: eta };
        }
        function onDone(rawResults) {
          self.running = false;
          self._abortHandle = null;
          var stats = BDSS.analyzer.aggregateBatch(rawResults);
          self.batchStats = stats;
          var conclusions = BDSS.analyzer.autoConclusions(stats, scheme, {});
          self.conclusions = conclusions;
          self.conclusionsHtml = BDSS.ui.markdownToHtml(conclusions.recommendations.text);
          // 渲染
          BDSS.ui.renderBatchResults(stats, scheme);
          BDSS.ui.renderConclusions(conclusions, scheme);
          // 缓存
          var cache = { batch: stats, conclusions: conclusions, schemeId: scheme.meta.id, updatedAt: new Date().toISOString() };
          BDSS.storage.cacheResult(cache);
          self.showToast('批量扫描完成（' + stats.length + ' 候选价 × ' + scheme.simulation.iterations + ' 次）');
        }
        function onError(msg) {
          self.running = false;
          self._abortHandle = null;
          self.showToast('模拟失败：' + msg);
          console.error('[BDSS] runBatch error:', msg);
        }

        if (useWorker) {
          this._abortHandle = BDSS.workerManager.runBatch(scheme, cands, opts, onProgress, onDone, onError);
        } else {
          // 主线程降级
          var abortFlag = { aborted: false };
          this._abortHandle = { abort: function () { abortFlag.aborted = true; } };
          try {
            var raw = BDSS.simulator.runBatch(scheme, cands, opts, onProgress, abortFlag);
            onDone(raw);
          } catch (e) { onError(e.message); }
        }
      },

      runScenarios() {
        var self = this;
        var v = this.validation;
        if (!v.ok) { this.showToast('校验失败：' + v.errors[0]); return; }
        var enabledScenarios = this.s.scenarios.filter(function (sc) { return sc.enabled; });
        if (enabledScenarios.length === 0) { this.showToast('无启用的场景'); return; }
        var cands = this.candidates;
        if (cands.length === 0) { this.showToast('无候选报价'); return; }

        this.running = true;
        this.progress = { done: 0, total: cands.length * this.s.simulation.iterations * enabledScenarios.length, elapsedMs: 0, etaMs: 0 };
        var scheme = this.s;
        var idx = 0;
        var results = [];

        function next() {
          if (idx >= enabledScenarios.length) {
            self.running = false;
            self._abortHandle = null;
            var scStats = BDSS.analyzer.aggregateScenarios(results);
            self.scenarioStats = scStats;
            BDSS.ui.renderScenarioComparison(scStats, scheme);
            self.showToast('场景对比完成（' + scStats.length + ' 个场景）');
            return;
          }
          var sc = enabledScenarios[idx++];
          var opts = self._buildRunOpts(sc);
          function onProgress(done, total, elapsed, eta) {
            self.progress = { done: done, total: total, elapsedMs: elapsed, etaMs: eta };
          }
          function onDone(raw) {
            results.push({ scenario: sc, batchResult: raw });
            next();
          }
          function onError(msg) {
            self.running = false;
            self._abortHandle = null;
            self.showToast('场景 [' + sc.name + '] 失败：' + msg);
          }
          if (scheme.simulation.useWorker && typeof Worker !== 'undefined') {
            self._abortHandle = BDSS.workerManager.runBatch(scheme, cands, opts, onProgress, onDone, onError);
          } else {
            var abortFlag = { aborted: false };
            self._abortHandle = { abort: function () { abortFlag.aborted = true; } };
            try {
              onDone(BDSS.simulator.runBatch(scheme, cands, opts, onProgress, abortFlag));
            } catch (e) { onError(e.message); }
          }
        }
        next();
      },

      abortRun() {
        if (this._abortHandle) {
          this._abortHandle.abort();
          this.running = false;
          this._abortHandle = null;
          this.showToast('已中止');
        }
      },

      /* ------------------------------------------------------
       * 导出
       * ------------------------------------------------------ */
      exportCSV() {
        if (!this.batchStats) return;
        BDSS.ui.exportCSV(this.batchStats, this.s, this.conclusions);
        this.showToast('CSV 已导出');
      },

      exportPNG() {
        if (BDSS.ui.exportPNG()) {
          this.showToast('图表 PNG 已导出');
        } else {
          this.showToast('无可用图表（可能 ECharts 未加载）');
        }
      },

      exportMarkdown() {
        if (!this.batchStats) return;
        BDSS.ui.exportMarkdown(this.batchStats, this.s, this.conclusions, this.scenarioStats);
        this.showToast('Markdown 报告已导出');
      },

      printReport() {
        BDSS.ui.printReport();
      },

      /* ------------------------------------------------------
       * 自检
       * ------------------------------------------------------ */
      runSelfTest() {
        var self = this;
        this.showToast('正在运行自检…');
        // 用 setTimeout 让 UI 先刷新
        setTimeout(function () {
          var result = BDSS.selftest.runAll();
          self.selfTestHtml = BDSS.ui.renderSelfTest(result);
          self.showSelfTest = true;
          if (result.failed === 0) {
            self.showToast('自检全部通过（' + result.passed + '/' + result.total + '）');
          } else {
            self.showToast('自检：' + result.passed + ' 通过，' + result.failed + ' 失败');
          }
        }, 50);
      },

      /* ------------------------------------------------------
       * 工具方法
       * ------------------------------------------------------ */
      fmt(v, dec) { return BDSS.ui.fmt(v, dec); },
      fmtDate(iso) {
        if (!iso) return '-';
        try { return new Date(iso).toLocaleString('zh-CN'); } catch (e) { return iso; }
      },

      showToast(text) {
        var self = this;
        this.toast.text = text;
        this.toast.show = true;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(function () { self.toast.show = false; }, 2500);
      }
    };
  };

  /* ============================================================
   * 兼容：Alpine 启动前注册组件
   * Alpine 通过 CDN defer 自动启动；这里监听 alpine:init 做兜底
   * bdssApp 已是全局函数，Alpine 可直接解析 x-data="bdssApp()"
   * ============================================================ */
  document.addEventListener('alpine:init', function () {
    console.log('[BDSS] Alpine 已就绪，BDSS 模块：', Object.keys(BDSS));
  });

})(window.BDSS = window.BDSS || {});
