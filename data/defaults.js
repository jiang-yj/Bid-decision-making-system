/**
 * data/defaults.js — 全局默认常量、币种列表、分布预设
 * 层级：data（Worker 安全：纯数据，无 DOM 依赖）
 */
(function (BDSS) {
  'use strict';

  BDSS.defaults = {
    /** 合规提示文案（首页 + 报告页均须展示，不可永久关闭） */
    complianceNotice:
      '本系统仅基于用户自行输入的假设进行敏感性分析，不提供、不建议任何与其他投标人协调报价的方案；' +
      '模拟结果不构成对评标结果的承诺，实际以招标文件与评标委员会结论为准。',

    /** 币种列表 */
    currencies: [
      { code: 'CNY', symbol: '¥', name: '人民币·元' },
      { code: 'USD', symbol: '$', name: '美元' },
      { code: 'EUR', symbol: '€', name: '欧元' },
      { code: 'JPY', symbol: '¥', name: '日元' }
    ],

    /** 报价模型选项 */
    pricingModelTypes: [
      { value: 'A', label: '模型A 算术平均法', desc: '基准价 = 有效投标报价的算术平均值' },
      { value: 'B', label: '模型B 去极值平均法', desc: '基准价 = 去掉一个最高和一个最低后的算术平均值（≤2家时不退化）' },
      { value: 'C', label: '模型C 下浮系数法', desc: '基准价 = 有效报价平均值 × K' },
      { value: 'D', label: '模型D 复合基准价', desc: '基准价 = 控制价 × α + 平均报价 × (1−α)' },
      { value: 'custom', label: '自定义公式', desc: '白名单函数 + 安全求值沙箱' }
    ],

    /** 得分规则模式 */
    scoringModes: [
      { value: 'linear', label: '线性扣分（高于每1%扣a，低于每1%扣b）' },
      { value: 'segmented', label: '分段扣分（不同偏离区间不同扣分率）' }
    ],

    /** 舍入方式 */
    roundingModes: [
      { value: 'round', label: '四舍五入' },
      { value: 'floor', label: '向下取整' },
      { value: 'ceil', label: '向上取整' },
      { value: 'none', label: '不舍入' }
    ],

    /** 低于成本警戒线处理方式 */
    belowCostActions: [
      { value: 'invalid', label: '视为无效标' },
      { value: 'flag', label: '标记为异常低价（仍有效）' }
    ],

    /** 伙伴报价设定方式 */
    partnerMethods: [
      { value: 'fixed', label: '固定值' },
      { value: 'narrow', label: '窄分布（均值±偏差）' },
      { value: 'sample', label: '样本驱动（历史报价拟合）' }
    ],

    /** 窄分布类型 */
    narrowDistTypes: [
      { value: 'normal', label: '截断正态' },
      { value: 'uniform', label: '截断均匀' },
      { value: 'triangular', label: '三角分布' }
    ],

    /** 对手分布类型 */
    opponentDistTypes: [
      { value: 'uniform', label: '均匀 [L, U]' },
      { value: 'normal', label: '正态 N(μ, σ)' },
      { value: 'triangular', label: '三角 (min, mode, max)' },
      { value: 'empirical', label: '经验样本列表' }
    ],

    /** 场景类型 */
    scenarioTypes: [
      { value: 'noPartner', label: '①无伙伴纯随机' },
      { value: 'withPartner', label: '②含伙伴（基准假设）' },
      { value: 'partnerShift', label: '③伙伴集体偏移' },
      { value: 'rejectPartner', label: '④指定伙伴废标' }
    ],

    /** 蒙特卡洛默认参数 */
    simulation: {
      iterations: 5000,
      iterationsMin: 1000,
      iterationsMax: 50000,
      seed: 12345,
      progressEvery: 500,
      useWorker: true
    },

    /** 我方策略默认 */
    strategy: {
      discountMin: 85,
      discountMax: 99,
      step: 0.5
    },

    /** 性能基线 */
    perfBaseline: {
      maxBidders: 8,
      maxCandidates: 30,
      targetIterations: 10000,
      targetMs: 3000
    },

    /** localStorage 键前缀 */
    storageKey: 'bdss_schemes_v1',
    cacheKey: 'bdss_last_result_v1'
  };
})(window.BDSS = window.BDSS || {});
