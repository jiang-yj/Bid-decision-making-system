/**
 * js/rng.js — 伪随机数生成器 + 分布采样
 * 层级：rng（Worker 安全：纯函数，零 DOM 依赖）
 *
 * 所有函数均为纯函数，可被 .toString() 注入 Blob Worker。
 * 严禁使用 Math.random()，必须使用传入的 rng 实例。
 */
(function (BDSS) {
  'use strict';

  var rng = (BDSS.rng = BDSS.rng || {});

  /**
   * mulberry32 PRNG — 种子可控、快速、均匀分布
   * @param {number} seed - 整数种子
   * @returns {function(): number} 返回 [0, 1) 浮点数
   */
  rng.mulberry32 = function mulberry32(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /**
   * xorshift128+ PRNG — 周期更长，备用
   * @param {number} seed
   * @returns {function(): number}
   */
  rng.xorshift128plus = function xorshift128plus(seed) {
    var s0 = seed >>> 0 || 1;
    var s1 = 0x6d2b79f5;
    return function () {
      s1 ^= s0;
      s0 = ((Math.imul(s0, 0x80038001) ^ (s0 >>> 9)) >>> 0);
      s1 = (Math.imul(s1, 0x80038001) ^ (s1 >>> 9) ^ (s1 << 21)) >>> 0;
      var r = ((s0 + s1) >>> 0) / 4294967296;
      return r;
    };
  };

  /**
   * 将字符串种子哈希为 32 位整数
   * @param {string|number} str
   * @returns {number}
   */
  rng.hashSeed = function hashSeed(str) {
    if (typeof str === 'number') return str >>> 0;
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };

  /**
   * 组合种子：用基础种子 + 索引生成确定性子种子
   * 保证不同 candidate 用不同种子但同种子同参数可复现
   * @param {number} baseSeed
   * @param {number} index
   * @returns {number}
   */
  rng.deriveSeed = function deriveSeed(baseSeed, index) {
    var s = (baseSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    return s;
  };

  /**
   * Box-Muller 正态分布采样
   * @param {function(): number} rngFunc - [0,1) 均匀 PRNG
   * @param {number} mu - 均值
   * @param {number} sigma - 标准差
   * @returns {number}
   */
  rng.boxMuller = function boxMuller(rngFunc, mu, sigma) {
    var u1 = rngFunc();
    if (u1 < 1e-12) u1 = 1e-12;
    var u2 = rngFunc();
    var mag = Math.sqrt(-2 * Math.log(u1));
    var z = mag * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  };

  /**
   * 截断正态分布采样 — 钳制在 [lo, hi] 范围内
   * @param {function()} rngFunc
   * @param {number} mu
   * @param {number} sigma
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  rng.truncatedNormal = function truncatedNormal(rngFunc, mu, sigma, lo, hi) {
    var v = rng.boxMuller(rngFunc, mu, sigma);
    // 钳制（简单截断，非精确截断正态，满足工程需求）
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
  };

  /**
   * 三角分布采样 — (a=min, b=mode, c=max)
   * @param {function()} rngFunc
   * @param {number} a - 最小值
   * @param {number} b - 众数
   * @param {number} c - 最大值
   * @returns {number}
   */
  rng.triangular = function triangular(rngFunc, a, b, c) {
    var u = rngFunc();
    var fc = (b - a) / (c - a);
    if (u < fc) {
      return a + Math.sqrt(u * (c - a) * (b - a));
    }
    return c - Math.sqrt((1 - u) * (c - a) * (c - b));
  };

  /**
   * 均匀分布采样 [lo, hi]
   * @param {function()} rngFunc
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  rng.uniform = function uniform(rngFunc, lo, hi) {
    return lo + rngFunc() * (hi - lo);
  };

  /**
   * 经验样本有放回采样
   * @param {function()} rngFunc
   * @param {number[]} samples
   * @returns {number}
   */
  rng.sampleEmpirical = function sampleEmpirical(rngFunc, samples) {
    if (!samples || samples.length === 0) return 0;
    var idx = Math.floor(rngFunc() * samples.length);
    if (idx >= samples.length) idx = samples.length - 1;
    return samples[idx];
  };

  /**
   * 从分布配置采样一个值
   * @param {function()} rngFunc
   * @param {object} dist - {type, params}
   * @param {number} lo - 钳制下限（成本警戒线）
   * @param {number} hi - 钳制上限（限价）
   * @returns {number}
   */
  rng.sampleFromDist = function sampleFromDist(rngFunc, dist, lo, hi) {
    var v;
    switch (dist.type) {
      case 'uniform':
        v = rng.uniform(rngFunc, dist.params.min, dist.params.max);
        break;
      case 'normal':
        v = rng.truncatedNormal(
          rngFunc, dist.params.mean, dist.params.std, lo, hi
        );
        break;
      case 'triangular':
        v = rng.triangular(
          rngFunc, dist.params.a, dist.params.b, dist.params.c
        );
        v = Math.max(lo, Math.min(hi, v));
        break;
      case 'empirical':
        v = rng.sampleEmpirical(rngFunc, dist.params.samples);
        v = Math.max(lo, Math.min(hi, v));
        break;
      default:
        v = rng.uniform(rngFunc, lo, hi);
    }
    return v;
  };
})(window.BDSS = window.BDSS || {});
