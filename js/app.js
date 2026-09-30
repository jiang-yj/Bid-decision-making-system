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

      // 护眼（暗黑）模式：默认常规白色，选择持久化到 localStorage
      darkMode: false,

      // 左侧配置标签页（①~⑨）
      configTab: 'info',

      // 金额显示单位：'yuan'(元,默认) 或 'wan'(万元)
      amountUnit: 'yuan',

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
        return done + ' / ' + total + '（' + elapsed + 's，剩余 ' + eta + '）';
      },

      /* ------------------------------------------------------
       * 初始化
       * ------------------------------------------------------ */
      init() {
        var self = this;
        // 监听 toast 事件
        BDSS.bus.on('toast', function (msg) { self.showToast(msg); });

        // 恢复主题偏好（默认常规模式）
        try { this.darkMode = localStorage.getItem('bdss_theme') === 'dark'; } catch (e) { this.darkMode = false; }
        this._applyTheme();

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
          this.conclusionsHtml = (this.conclusions && this.conclusions.recommendations)
            ? BDSS.ui.markdownToHtml(this.conclusions.recommendations.text) : '';
          // 重新渲染缓存结果（图表内部会在容器可见后自动重试初始化）
          BDSS.ui.renderBatchResults(this.batchStats, s);
          if (this.conclusions) BDSS.ui.renderConclusions(this.conclusions, s);
        } else {
          this.batchStats = null;
          this.conclusions = null;
          this.conclusionsHtml = '';
        }
        this.singleResult = s.results && s.results.single ? s.results.single : null;
        this.scenarioStats = s.results && s.results.scenarios ? s.results.scenarios : null;
        if (this.singleResult) {
          var cur0 = BDSS.defaults.currencies.find(function (c) { return c.code === s.project.currency; });
          BDSS.ui.renderSinglePoint(this.singleResult, cur0 ? cur0.symbol : '¥');
        }
        if (this.scenarioStats && this.scenarioStats.length) {
          BDSS.ui.renderScenarioComparison(this.scenarioStats, s);
        }
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

        // 为单点测算结果补充投标人和排名信息
        var labels = ['我方'];
        for (var pi = 0; pi < partners.length; pi++) {
          labels.push(partners[pi].name || ('伙伴' + (pi + 1)));
        }
        for (var oi = 0; oi < oppBids.length; oi++) {
          labels.push('对手' + (oi + 1));
        }
        result.labels = labels;

        // 计算所有有效投标人的排名（分数降序，同分报价低者优先）
        var validIdx = [];
        for (var ri = 0; ri < (result.results || []).length; ri++) {
          if (result.results[ri].valid) validIdx.push(ri);
        }
        var ranks = new Array((result.results || []).length).fill(0);
        validIdx.sort(function (a, b) {
          var sa = result.results[a].score, sb = result.results[b].score;
          if (Math.abs(sa - sb) > 1e-9) return sb - sa; // 分数降序
          return result.results[a].bid - result.results[b].bid; // 同分报价低者优先
        });
        for (var rk = 0; rk < validIdx.length; rk++) {
          ranks[validIdx[rk]] = rk + 1;
        }
        result.ranks = ranks;

        this.singleResult = result;
        var cur = BDSS.defaults.currencies.find(function (c) { return c.code === s.project.currency; });
        BDSS.ui.renderSinglePoint(result, cur ? cur.symbol : '¥');
        this.showToast('单点测算完成（候选价 ' + BDSS.ui.fmtMoney(myBid, 0) + '）');
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

        function onProgress(done, total, elapsed, eta) {
          self.progress = { done: done, total: total, elapsedMs: elapsed, etaMs: eta };
        }
        function onDone(rawResults) {
          self.running = false;
          self._abortHandle = null;
          var stats = BDSS.analyzer.aggregateBatch(rawResults);
          self.batchStats = stats;
          var conclusions = BDSS.analyzer.autoConclusions(stats, scheme, {});
          // 防御：所有候选价有效轮次为 0 时 recommendations 为 null，给出可操作的降级文案
          if (!conclusions.recommendations) {
            conclusions.recommendations = {
              best: null, conservative: null, neutral: null, aggressive: null, range: null,
              text: '## 分析结论\n\n' +
                '⚠ 当前参数下有效模拟轮次为 0，无法生成建议价。可能原因：\n\n' +
                '1. 随机对手分布参数非法（如均匀分布 min ≥ max，或参数与分布类型不匹配）；\n' +
                '2. 我方折扣区间全部超限价或低于成本警戒线；\n' +
                '3. 有效投标家数始终不足（检查对手数量与最少有效家数）。\n\n' +
                '请调整左侧配置后重新扫描。'
            };
          }
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

        // 统一交由 workerManager：内部自动处理 Worker / file:// / 降级，
        // 且所有路径均为分块异步，绝不冻结主线程
        this._abortHandle = BDSS.workerManager.runBatch(scheme, cands, opts, onProgress, onDone, onError);
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
        var scenarioAbort = false;
        var scenarioTotal = cands.length * this.s.simulation.iterations * enabledScenarios.length;
        var scenarioStartMs = Date.now();

        function next() {
          if (scenarioAbort) return;
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
            // 局部（单场景）进度换算为全局累计：已完成场景 + 当前场景内进度
            var globalDone = (idx - 1) * total + done;
            // 全局 ETA：基于全局已用时间和已完成量计算，避免单场景切换时 ETA 重置
            var globalElapsed = Date.now() - scenarioStartMs;
            var globalEta = 0;
            if (globalDone > 0 && globalElapsed > 0) {
              var rate = globalDone / globalElapsed; // items per ms
              globalEta = (scenarioTotal - globalDone) / rate;
            }
            self.progress = { done: globalDone, total: scenarioTotal, elapsedMs: globalElapsed, etaMs: globalEta };
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
          // 统一走 workerManager（内部异步分块，不冻结 UI）
          var inner = BDSS.workerManager.runBatch(scheme, cands, opts, onProgress, onDone, onError);
          // 场景级中止：标记后阻止后续场景继续启动
          self._abortHandle = {
            abort: function () {
              scenarioAbort = true;
              try { inner.abort(); } catch (e) {}
            }
          };
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
       * 护眼（暗黑）模式
       * ------------------------------------------------------ */
      toggleTheme() {
        this.darkMode = !this.darkMode;
        try { localStorage.setItem('bdss_theme', this.darkMode ? 'dark' : 'light'); } catch (e) {}
        this._applyTheme();
        // 重新渲染已有图表，使主题立即生效
        var self = this;
        this.$nextTick(function () {
          if (self.batchStats) BDSS.ui.renderBatchResults(self.batchStats, self.s);
          if (self.conclusions) BDSS.ui.renderConclusions(self.conclusions, self.s);
          if (self.scenarioStats && self.scenarioStats.length) BDSS.ui.renderScenarioComparison(self.scenarioStats, self.s);
        });
        this.showToast(this.darkMode ? '已切换到护眼模式' : '已切换到常规模式');
      },

      _applyTheme() {
        if (this.darkMode) document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
      },

      /* ------------------------------------------------------
       * 金额单位切换
       * ------------------------------------------------------ */
      setAmountUnit(unit) {
        this.amountUnit = unit;
        BDSS.ui.amountUnit = unit;
        // 重新渲染表格类结果（图表不随金额开关切换）
        var self = this;
        this.$nextTick(function () {
          if (self.singleResult) {
            var cur = BDSS.defaults.currencies.find(function (c) { return c.code === self.s.project.currency; });
            BDSS.ui.renderSinglePoint(self.singleResult, cur ? cur.symbol : '¥');
          }
          // 批量表格随单位切换重渲染（图表保持不变）
          if (self.batchStats) {
            var bs = self.batchStats;
            var bestIdx = bs.indexOf(bs.slice().sort(function(a,b){return b.winProb-a.winProb;})[0]);
            BDSS.ui.renderTable('batchTable',
              ['报价', '中标概率', '期望得分', '期望排名（均值）', '最差排名', 'P10', 'P50', 'P90', '标准差', '有效轮数'],
              bs.map(function (s, i) {
                return {
                  报价: BDSS.ui.fmtMoneyVal(s.candidate),
                  中标概率: s.winProb + '%',
                  期望得分: s.expectedScore,
                  '期望排名（均值）': s.expectedRank,
                  最差排名: s.worstRank,
                  P10: s.scoreP10, P50: s.scoreP50, P90: s.scoreP90,
                  标准差: s.scoreStd, 有效轮数: s.validRounds,
                  __best: i === bestIdx
                };
              }), '批量扫描明细（★ 最优候选价）');
          }
          if (self.conclusions) BDSS.ui.renderConclusions(self.conclusions, self.s);
        });
      },

      /* ------------------------------------------------------
       * 工具方法
       * ------------------------------------------------------ */
      fmt(v, dec) { return BDSS.ui.fmt(v, dec); },
      fmtMoney(v, dec) {
        // 直接引用 this.amountUnit 确保 Alpine 响应式依赖追踪
        dec = dec === undefined ? 2 : dec;
        if (v == null || v === undefined || isNaN(v)) return '-';
        var n = Number(v);
        if (this.amountUnit === 'wan') {
          return (n / 1e4).toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' 万元';
        }
        return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' 元';
      },
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
