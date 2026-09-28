/**
 * data/examples.js — 2~3 个内置示例方案（至少一个含伙伴）+ 历史 CSV 样本
 * 层级：data（纯数据）
 */
(function (BDSS) {
  'use strict';

  var now = new Date().toISOString();

  BDSS.examples = [
    /* ============================================================
     * 示例1：基础算术平均法（无伙伴）— 对应用例A手算
     * ============================================================ */
    {
      meta: { id: 'ex_basic_arithmetic', name: '示例1：算术平均法（3家固定）', createdAt: now, updatedAt: now, pinned: false, version: 1 },
      project: { name: '市政道路工程', code: 'ZB-2024-001', section: '一标段', C_max: 10000000, costWarningLine: 0, currency: 'CNY' },
      pricingModel: { type: 'A', params: {} },
      scoring: {
        S_max: 60, mode: 'linear', a: 1, b: 1,
        segments: [], rounding: 'round', roundDecimals: 2, floorScore: 0
      },
      invalidRules: { overCmaxInvalid: true, belowCost: 'invalid', p_reject: 0, minValidBidders: 3 },
      partners: [],
      opponents: { count: 2, distributions: [{ id: 'opp1', type: 'uniform', params: { min: 0.92, max: 0.98 }, group: 'A' }], csv: '' },
      strategy: { candidateMode: 'range', range: { discountMin: 88, discountMax: 98, step: 1, relativeTo: 'C_max' }, list: [] },
      simulation: { iterations: 5000, seed: 12345, useWorker: true, progressEvery: 500 },
      scenarios: [],
      results: { single: null, batch: null, scenarios: null, updatedAt: null }
    },

    /* ============================================================
     * 示例2：去极值平均法（4家）— 对应用例B
     * ============================================================ */
    {
      meta: { id: 'ex_trimmed_mean', name: '示例2：去极值平均法（4家）', createdAt: now, updatedAt: now, pinned: false, version: 1 },
      project: { name: '设备采购项目', code: 'ZB-2024-002', section: '二标段', C_max: 5000000, costWarningLine: 0, currency: 'CNY' },
      pricingModel: { type: 'B', params: { trimLow: 1, trimHigh: 1 } },
      scoring: {
        S_max: 60, mode: 'linear', a: 1, b: 1,
        segments: [], rounding: 'round', roundDecimals: 2, floorScore: 0
      },
      invalidRules: { overCmaxInvalid: true, belowCost: 'invalid', p_reject: 0, minValidBidders: 3 },
      partners: [],
      opponents: { count: 3, distributions: [{ id: 'opp2', type: 'uniform', params: { min: 0.90, max: 0.98 }, group: 'A' }], csv: '' },
      strategy: { candidateMode: 'range', range: { discountMin: 90, discountMax: 98, step: 1, relativeTo: 'C_max' }, list: [] },
      simulation: { iterations: 5000, seed: 12345, useWorker: true, progressEvery: 500 },
      scenarios: [],
      results: { single: null, batch: null, scenarios: null, updatedAt: null }
    },

    /* ============================================================
     * 示例3：含伙伴配置 + 下浮系数法 — 对应用例C/D
     * ============================================================ */
    {
      meta: { id: 'ex_with_partners', name: '示例3：下浮系数法（含伙伴2家+对手3家）', createdAt: now, updatedAt: now, pinned: true, version: 1 },
      project: { name: '智慧城市信息系统', code: 'ZB-2024-003', section: '全标段', C_max: 8000000, costWarningLine: 5600000, currency: 'CNY' },
      pricingModel: { type: 'C', params: { K: 0.98 } },
      scoring: {
        S_max: 60, mode: 'linear', a: 1, b: 1.5,
        segments: [], rounding: 'round', roundDecimals: 2, floorScore: 0
      },
      invalidRules: { overCmaxInvalid: true, belowCost: 'flag', p_reject: 2, minValidBidders: 3 },
      partners: [
        {
          id: 'p1', name: '伙伴A', enabled: true, method: 'fixed', fixedQuote: 7600000,
          narrow: { center: 95, spread: 1, dist: 'normal' }, samples: [], forceValid: false
        },
        {
          id: 'p2', name: '伙伴B', enabled: true, method: 'fixed', fixedQuote: 7600000,
          narrow: { center: 95, spread: 1, dist: 'normal' }, samples: [], forceValid: false
        }
      ],
      opponents: {
        count: 3,
        distributions: [
          { id: 'opp3a', type: 'uniform', params: { min: 0.88, max: 0.96 }, group: 'A' },
          { id: 'opp3b', type: 'normal', params: { mean: 0.93, std: 0.02 }, group: 'B' }
        ],
        csv: ''
      },
      strategy: { candidateMode: 'range', range: { discountMin: 88, discountMax: 99, step: 0.5, relativeTo: 'C_max' }, list: [] },
      simulation: { iterations: 10000, seed: 42, useWorker: true, progressEvery: 500 },
      scenarios: [
        { id: 'sc1', name: '无伙伴纯随机', type: 'noPartner', params: {}, enabled: true },
        { id: 'sc2', name: '含伙伴（基准）', type: 'withPartner', params: {}, enabled: true },
        { id: 'sc3', name: '伙伴上移2%', type: 'partnerShift', params: { shiftPct: 2 }, enabled: true },
        { id: 'sc4', name: '伙伴下移2%', type: 'partnerShift', params: { shiftPct: -2 }, enabled: true }
      ],
      results: { single: null, batch: null, scenarios: null, updatedAt: null }
    }
  ];

  /** 历史 CSV 样本数据（供对手经验分布导入使用） */
  BDSS.historicalCSV =
    '项目编号,投标单位,报价,限价,报价率\n' +
    'ZB-2023-001,单位A,9650000,10000000,0.965\n' +
    'ZB-2023-001,单位B,9480000,10000000,0.948\n' +
    'ZB-2023-001,单位C,9710000,10000000,0.971\n' +
    'ZB-2023-001,单位D,9350000,10000000,0.935\n' +
    'ZB-2023-002,单位A,4620000,5000000,0.924\n' +
    'ZB-2023-002,单位B,4850000,5000000,0.970\n' +
    'ZB-2023-002,单位C,4510000,5000000,0.902\n' +
    'ZB-2023-002,单位D,4780000,5000000,0.956\n' +
    'ZB-2023-003,单位A,7720000,8000000,0.965\n' +
    'ZB-2023-003,单位B,7450000,8000000,0.931\n' +
    'ZB-2023-003,单位C,7680000,8000000,0.960\n' +
    'ZB-2023-003,单位D,7510000,8000000,0.939';
})(window.BDSS = window.BDSS || {});
