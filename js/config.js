/**
 * js/config.js — Scheme schema、默认方案、校验、版本迁移
 * 层级：config（Worker 安全：纯函数，零 DOM 依赖）
 */
(function (BDSS) {
  'use strict';

  var config = (BDSS.config = BDSS.config || {});
  var D = BDSS.defaults;

  /**
   * 生成唯一 ID
   * @returns {string}
   */
  config.uid = function () {
    return 'id_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
  };

  /**
   * 创建默认 Scheme（新建方案时调用）
   * @returns {object}
   */
  config.createDefaultScheme = function () {
    var now = new Date().toISOString();
    return {
      meta: { id: config.uid(), name: '新建方案', createdAt: now, updatedAt: now, pinned: false, version: 1 },

      project: {
        name: '',
        code: '',
        section: '',
        C_max: 1000000,
        costWarningLine: 0,
        currency: 'CNY'
      },

      pricingModel: {
        type: 'A',
        params: {}
      },

      scoring: {
        S_max: 60,
        mode: 'linear',
        a: 1,
        b: 1,
        segments: [
          { lo: -1, hi: 0, per: 1, cap: 60 },
          { lo: 0, hi: 1, per: 1, cap: 60 }
        ],
        rounding: 'round',
        roundDecimals: 2,
        floorScore: 0
      },

      invalidRules: {
        overCmaxInvalid: true,
        belowCost: 'invalid',
        p_reject: 0,
        minValidBidders: 3
      },

      partners: [],

      opponents: {
        count: 5,
        distributions: [
          {
            id: config.uid(),
            type: 'uniform',
            params: { min: 0.85, max: 0.99 },
            group: 'A'
          }
        ],
        csv: ''
      },

      strategy: {
        candidateMode: 'range',
        range: { discountMin: 85, discountMax: 99, step: 0.5, relativeTo: 'C_max' },
        list: []
      },

      simulation: {
        iterations: D.simulation.iterations,
        seed: D.simulation.seed,
        useWorker: D.simulation.useWorker,
        progressEvery: D.simulation.progressEvery
      },

      scenarios: [],

      results: { single: null, batch: null, scenarios: null, updatedAt: null }
    };
  };

  /**
   * 创建默认伙伴
   * @param {string} name
   * @returns {object}
   */
  config.createDefaultPartner = function (name) {
    return {
      id: config.uid(),
      name: name || '伙伴',
      enabled: true,
      method: 'fixed',
      fixedQuote: 950000,
      narrow: { center: 95, spread: 1, dist: 'normal' },
      samples: [],
      forceValid: false
    };
  };

  /**
   * 创建默认对手分布
   * @returns {object}
   */
  config.createDefaultDist = function () {
    return {
      id: config.uid(),
      type: 'uniform',
      params: { min: 0.85, max: 0.99 },
      group: 'A'
    };
  };

  /**
   * 创建默认场景
   * @returns {object}
   */
  config.createDefaultScenario = function () {
    return {
      id: config.uid(),
      name: '场景',
      type: 'noPartner',
      params: {},
      enabled: true
    };
  };

  /**
   * 校验 Scheme，返回 {ok, errors, warnings}
   * @param {object} s - Scheme
   * @returns {{ok:boolean, errors:string[], warnings:string[]}}
   */
  config.validate = function (s) {
    var errors = [];
    var warnings = [];

    if (!s || !s.project) {
      errors.push('方案数据不完整');
      return { ok: false, errors: errors, warnings: warnings };
    }

    // 项目信息
    if (!s.project.C_max || s.project.C_max <= 0) {
      errors.push('最高投标限价 C_max 必须大于 0');
    }
    if (s.project.costWarningLine && s.project.costWarningLine >= s.project.C_max) {
      warnings.push('成本警戒线不应高于最高限价');
    }

    // 得分规则
    if (!s.scoring) {
      errors.push('得分规则缺失');
    } else {
      if (s.scoring.S_max <= 0) errors.push('商务标满分 S_max 必须 > 0');
      if (s.scoring.mode === 'linear') {
        if (s.scoring.a < 0) errors.push('高于基准扣分系数 a 不能为负');
        if (s.scoring.b < 0) errors.push('低于基准扣分系数 b 不能为负');
      }
    }

    // 报价模型
    if (!s.pricingModel || !s.pricingModel.type) {
      errors.push('报价模型类型缺失');
    } else if (s.pricingModel.type === 'C' && (!s.pricingModel.params.K || s.pricingModel.params.K <= 0)) {
      errors.push('模型C下浮系数 K 必须 > 0');
    } else if (s.pricingModel.type === 'D') {
      var comps = s.pricingModel.params.components;
      if (!comps || comps.length === 0) errors.push('模型D复合权重组件不能为空');
    }

    // 伙伴
    if (s.partners) {
      s.partners.forEach(function (p, i) {
        if (!p.enabled) return;
        if (p.method === 'fixed') {
          if (!p.fixedQuote || p.fixedQuote <= 0)
            errors.push('伙伴[' + p.name + ']固定报价无效');
          if (p.fixedQuote > s.project.C_max)
            warnings.push('伙伴[' + p.name + ']报价超限价，将导致无效标');
          if (s.project.costWarningLine && p.fixedQuote < s.project.costWarningLine)
            warnings.push('伙伴[' + p.name + ']报价低于成本警戒线');
        }
      });
    }

    // 对手
    if (!s.opponents || s.opponents.count < 0) {
      errors.push('随机对手数量无效');
    }

    // 有效家数
    var partnerCount = (s.partners || []).filter(function (p) { return p.enabled; }).length;
    var total = 1 + partnerCount + (s.opponents ? s.opponents.count : 0);
    if (total < (s.invalidRules ? s.invalidRules.minValidBidders : 3)) {
      warnings.push('总投标家数 ' + total + ' 不足，有效投标人不足将导致置信度低');
    }

    // 策略
    if (!s.strategy) {
      errors.push('我方策略配置缺失');
    } else if (s.strategy.candidateMode === 'range') {
      if (s.strategy.range.discountMin >= s.strategy.range.discountMax)
        errors.push('折扣率下限应小于上限');
      if (s.strategy.range.step <= 0) errors.push('步长必须 > 0');
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  };

  /**
   * 版本迁移 — 将旧版本 Scheme 迁移到当前版本
   * @param {object} s
   * @returns {object}
   */
  config.migrate = function (s) {
    if (!s) return config.createDefaultScheme();
    s.meta = s.meta || {};
    if (!s.meta.version) s.meta.version = 1;

    // v1 → 当前：补全缺失字段
    var def = config.createDefaultScheme();
    def.meta = s.meta;
    def.meta.id = s.meta.id || config.uid();
    def.meta.version = 1;

    // 深度合并缺失字段
    def.project = Object.assign(def.project, s.project || {});
    def.pricingModel = Object.assign(def.pricingModel, s.pricingModel || {});
    def.pricingModel.params = s.pricingModel && s.pricingModel.params ? s.pricingModel.params : {};
    def.scoring = Object.assign(def.scoring, s.scoring || {});
    if (s.scoring && s.scoring.segments) def.scoring.segments = s.scoring.segments;
    def.invalidRules = Object.assign(def.invalidRules, s.invalidRules || {});
    def.partners = s.partners || [];
    def.opponents = Object.assign(def.opponents, s.opponents || {});
    if (s.opponents && s.opponents.distributions) def.opponents.distributions = s.opponents.distributions;
    def.strategy = Object.assign(def.strategy, s.strategy || {});
    if (s.strategy && s.strategy.range) def.strategy.range = Object.assign(def.strategy.range, s.strategy.range);
    if (s.strategy && s.strategy.list) def.strategy.list = s.strategy.list;
    def.simulation = Object.assign(def.simulation, s.simulation || {});
    def.scenarios = s.scenarios || [];
    def.results = s.results || { single: null, batch: null, scenarios: null, updatedAt: null };

    return def;
  };

  /**
   * 生成候选报价列表
   * @param {object} s - Scheme
   * @returns {number[]} 绝对值报价数组
   */
  config.generateCandidates = function (s) {
    var C = s.project.C_max;
    var st = s.strategy;
    var result = [];

    if (st.candidateMode === 'list') {
      result = (st.list || []).map(function (r) { return r * C; });
    } else {
      var r = st.range;
      var lo = r.discountMin / 100;
      var hi = r.discountMax / 100;
      var step = r.step / 100;
      for (var v = lo; v <= hi + 1e-9; v += step) {
        result.push(Math.round(v * C * 100) / 100);
      }
    }
    return result;
  };

  /**
   * 获取当前报价模型的可读展开文案
   * @param {object} s - Scheme
   * @returns {string}
   */
  config.getModelReadable = function (s) {
    var pm = s.pricingModel;
    switch (pm.type) {
      case 'A':
        return '基准价 = 有效报价的算术平均值 = mean(Q₁..Qₙ)';
      case 'B':
        return '基准价 = 去掉1个最高+1个最低后的算术平均值（≤2家时全量平均）';
      case 'C':
        return '基准价 = 有效报价平均值 × K(' + (pm.params.K || 0.98) + ')';
      case 'D':
        var comps = pm.params.components || [];
        var parts = comps.map(function (c) {
          return c.w + '×' + c.src;
        });
        return '基准价 = ' + (parts.join(' + ') || '未配置') + '（权重归一）';
      case 'custom':
        return '基准价 = ' + (pm.params.formula || '（未输入）');
      default:
        return '未知模型';
    }
  };
})(window.BDSS = window.BDSS || {});
