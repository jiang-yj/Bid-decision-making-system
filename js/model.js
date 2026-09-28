/**
 * js/model.js — 基准价模型、得分计算、废标规则、自定义公式沙箱
 * 层级：model（Worker 安全：纯函数，零 DOM 依赖）
 *
 * 所有函数为纯函数，可被 .toString() 注入 Blob Worker。
 * 禁止引用 window、document、BDSS 等外部作用域。
 */
(function (BDSS) {
  'use strict';

  var model = (BDSS.model = BDSS.model || {});

  /* ============================================================
   * 辅助数学函数（纯函数，内联以减少跨层依赖）
   * ============================================================ */

  function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function median(arr) {
    if (!arr || arr.length === 0) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    return n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
  }

  function minArr(arr) {
    if (!arr || arr.length === 0) return 0;
    var m = arr[0];
    for (var i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
  }

  function maxArr(arr) {
    if (!arr || arr.length === 0) return 0;
    var m = arr[0];
    for (var i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  /* ============================================================
   * 基准价计算 — 5 种模型
   * ============================================================ */

  /**
   * 计算基准价
   * @param {number[]} Q - 有效报价数组（绝对值）
   * @param {object} pricingModel - {type, params}
   * @param {number} C_max - 最高限价（模型D需要）
   * @returns {number} 基准价
   */
  model.basePrice = function (Q, pricingModel, C_max) {
    if (!Q || Q.length === 0) return 0;
    var type = pricingModel.type;
    var p = pricingModel.params || {};

    switch (type) {
      case 'A':
        return mean(Q);
      case 'B':
        return model.basePrice_B(Q, p);
      case 'C':
        return mean(Q) * (p.K || 0.98);
      case 'D':
        return model.basePrice_D(Q, p, C_max);
      case 'custom':
        return model.basePrice_custom(Q, p, C_max);
      default:
        return mean(Q);
    }
  };

  /**
   * 模型B 去极值平均法
   * 去掉 1 个最高 + 1 个最低；有效家数 ≤ 2 时不退化，全量平均
   */
  model.basePrice_B = function (Q, p) {
    var trimLow = (p && p.trimLow) || 1;
    var trimHigh = (p && p.trimHigh) || 1;
    var n = Q.length;
    if (n <= 2) return mean(Q); // 不退化
    var s = Q.slice().sort(function (a, b) { return a - b; });
    var lo = Math.min(trimLow, n);
    var hi = Math.min(trimHigh, n);
    var remaining = s.slice(lo, n - hi);
    if (remaining.length === 0) return mean(Q);
    return mean(remaining);
  };

  /**
   * 模型D 复合基准价
   * 基准价 = Σ(comp.value × comp.w) / Σ(comp.w)
   * comp.src: 'avg' | 'C_max' | 'min' | 'max' | 'median'
   */
  model.basePrice_D = function (Q, p, C_max) {
    var comps = p.components || [];
    var num = 0;
    var den = 0;
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      var w = c.w || 1;
      var val;
      switch (c.src) {
        case 'avg': val = mean(Q); break;
        case 'C_max': val = C_max; break;
        case 'min': val = minArr(Q); break;
        case 'max': val = maxArr(Q); break;
        case 'median': val = median(Q); break;
        default: val = mean(Q);
      }
      num += val * w;
      den += w;
    }
    return den > 0 ? num / den : mean(Q);
  };

  // ============================================================
  // 自定义公式沙箱 — Shunting-Yard 递归下降求值器
  // 白名单：数字、四则运算、幂、取模、括号
  // 函数：abs / min / max / round / floor / ceil / sqrt / log / exp / pow
  // 标识符：Q / n / C_max / mean / min / max / median / K
  // 禁用 eval / new Function
  // ============================================================

  var SANDBOX_FUNCS = {
    abs: Math.abs, min: Math.min, max: Math.max,
    round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sqrt: Math.sqrt, log: Math.log, exp: Math.exp, pow: Math.pow
  };
  var SANDBOX_VARS = ['Q', 'n', 'C_max', 'mean', 'min', 'max', 'median', 'K'];

  /**
   * Tokenize 表达式
   * @param {string} expr
   * @returns {{type:string, value:*}[]}
   */
  function tokenize(expr) {
    var tokens = [];
    var i = 0;
    while (i < expr.length) {
      var ch = expr[i];
      if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
      if (ch >= '0' && ch <= '9' || ch === '.') {
        var num = '';
        while (i < expr.length && (expr[i] >= '0' && expr[i] <= '9' || expr[i] === '.')) {
          num += expr[i]; i++;
        }
        tokens.push({ type: 'num', value: parseFloat(num) });
        continue;
      }
      if (ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch === '_') {
        var id = '';
        while (i < expr.length && (expr[i] >= 'a' && expr[i] <= 'z' || expr[i] >= 'A' && expr[i] <= 'Z' || expr[i] === '_' || expr[i] >= '0' && expr[i] <= '9')) {
          id += expr[i]; i++;
        }
        tokens.push({ type: 'id', value: id });
        continue;
      }
      if ('+-*/^%(),'.indexOf(ch) >= 0) {
        tokens.push({ type: 'op', value: ch }); i++; continue;
      }
      throw new Error('非法字符: ' + ch + ' (位置 ' + i + ')');
    }
    return tokens;
  }

  /**
   * Shunting-Yard 转后缀表达式
   */
  function toRPN(tokens) {
    var output = [];
    var stack = [];
    var prec = { '^': 4, '*': 3, '/': 3, '%': 3, '+': 2, '-': 2 };
    var rightAssoc = { '^': true };

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'num' || t.type === 'id') {
        output.push(t);
      } else if (t.value === '(') {
        stack.push(t);
      } else if (t.value === ')') {
        while (stack.length > 0 && stack[stack.length - 1].value !== '(') {
          output.push(stack.pop());
        }
        if (stack.length === 0) throw new Error('括号不匹配');
        stack.pop(); // 弹出 '('
        // 如果栈顶是函数，弹出到输出
        if (stack.length > 0 && stack[stack.length - 1].type === 'func') {
          output.push(stack.pop());
        }
      } else if (t.type === 'op') {
        // 检查是否是一元负号
        var prev = i > 0 ? tokens[i - 1] : null;
        if (t.value === '-' && (!prev || prev.value === '(' || prev.type === 'op')) {
          // 一元负号 → 用特殊标记
          output.push({ type: 'num', value: 0 });
          while (stack.length > 0 && stack[stack.length - 1].type === 'op' &&
            prec[stack[stack.length - 1].value] > prec[t.value]) {
            output.push(stack.pop());
          }
          stack.push(t);
        } else {
          while (stack.length > 0 && stack[stack.length - 1].type === 'op') {
            var top = stack[stack.length - 1];
            if (rightAssoc[t.value] ? prec[top.value] > prec[t.value] : prec[top.value] >= prec[t.value]) {
              output.push(stack.pop());
            } else break;
          }
          stack.push(t);
        }
      }
    }
    while (stack.length > 0) {
      var s = stack.pop();
      if (s.value === '(' || s.value === ')') throw new Error('括号不匹配');
      output.push(s);
    }
    return output;
  }

  /**
   * 求值后缀表达式
   */
  function evalRPN(rpn, ctx) {
    var stack = [];
    for (var i = 0; i < rpn.length; i++) {
      var t = rpn[i];
      if (t.type === 'num') {
        stack.push(t.value);
      } else if (t.type === 'id') {
        var name = t.value;
        // 检查是否是函数调用（下一个 token 是 func 标记）
        if (SANDBOX_FUNCS[name]) {
          // 函数标识符在 RPN 中应已标记为 func
          // 但我们简化处理：如果 id 后面有 func，它会是 func 类型
          // 这里 id 直接作为变量
        }
        if (name in ctx) {
          stack.push(ctx[name]);
        } else {
          throw new Error('未定义变量: ' + name);
        }
      } else if (t.type === 'func') {
        // 弹出参数个数（简化：函数固定参数数量由 arity 决定）
        var fn = SANDBOX_FUNCS[t.value];
        if (!fn) throw new Error('未定义函数: ' + t.value);
        var arity = fn.length;
        var args = [];
        for (var j = 0; j < arity; j++) {
          if (stack.length === 0) throw new Error('函数 ' + t.value + ' 参数不足');
          args.push(stack.pop());
        }
        args.reverse();
        stack.push(fn.apply(null, args));
      } else if (t.type === 'op') {
        var b = stack.pop();
        var a = stack.length > 0 ? stack.pop() : 0;
        switch (t.value) {
          case '+': stack.push(a + b); break;
          case '-': stack.push(a - b); break;
          case '*': stack.push(a * b); break;
          case '/': stack.push(a / b); break;
          case '%': stack.push(a % b); break;
          case '^': stack.push(Math.pow(a, b)); break;
        }
      }
    }
    return stack.length === 1 ? stack[0] : 0;
  }

  /**
   * 预处理 tokens：将函数名标识为 func 类型
   */
  function markFunctions(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'id' && SANDBOX_FUNCS[tokens[i].value] && i + 1 < tokens.length && tokens[i + 1].value === '(') {
        tokens[i].type = 'func';
      }
    }
    return tokens;
  }

  /**
   * 沙箱求值自定义公式
   * @param {number[]} Q - 有效报价
   * @param {object} p - {formula}
   * @param {number} C_max
   * @returns {number}
   */
  model.basePrice_custom = function (Q, p, C_max) {
    var formula = p.formula || '';
    if (!formula.trim()) throw new Error('自定义公式为空');
    var tokens = tokenize(formula);
    // 校验标识符白名单
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'id') {
        var name = tokens[i].value;
        if (!SANDBOX_VARS.includes(name) && !SANDBOX_FUNCS[name]) {
          throw new Error('非法标识符: ' + name + '（允许: ' + SANDBOX_VARS.join(', ') + ')');
        }
      }
    }
    tokens = markFunctions(tokens);
    var rpn = toRPN(tokens);
    var ctx = {
      Q: Q, n: Q.length, C_max: C_max,
      mean: mean(Q), min: minArr(Q), max: maxArr(Q),
      median: median(Q), K: p.K || 1
    };
    var result = evalRPN(rpn, ctx);
    if (!isFinite(result) || isNaN(result)) throw new Error('公式计算结果无效');
    return result;
  };

  /**
   * 校验自定义公式（不计算，只检查语法）
   * @param {string} formula
   * @returns {{ok:boolean, error:string}}
   */
  model.validateFormula = function (formula) {
    try {
      if (!formula || !formula.trim()) return { ok: false, error: '公式为空' };
      var tokens = tokenize(formula);
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'id') {
          var name = tokens[i].value;
          if (!SANDBOX_VARS.includes(name) && !SANDBOX_FUNCS[name]) {
            return { ok: false, error: '非法标识符: ' + name };
          }
        }
      }
      tokens = markFunctions(tokens);
      toRPN(tokens);
      return { ok: true, error: '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  /* ============================================================
   * 得分计算
   * ============================================================ */

  /**
   * 计算单个投标人的得分
   * @param {number} qi - 投标报价
   * @param {number} B - 基准价
   * @param {object} scoring - 得分规则
   * @returns {number} 得分
   */
  model.score = function (qi, B, scoring) {
    if (!B || B <= 0) return scoring.floorScore || 0;
    var d = (qi - B) / B; // 有符号偏离率
    var absDevPct = Math.abs(d) * 100; // 百分比
    var off;

    if (scoring.mode === 'segmented') {
      // 分段扣分
      var segs = scoring.segments || [];
      off = 0;
      // 简化：找到偏离率所在区间
      var seg = null;
      for (var i = 0; i < segs.length; i++) {
        if (d >= segs[i].lo && d < segs[i].hi) { seg = segs[i]; break; }
        if (i === segs.length - 1 && d >= segs[i].hi) { seg = segs[i]; break; }
      }
      if (seg) {
        off = Math.min(seg.cap || scoring.S_max, seg.per * absDevPct);
      } else {
        off = scoring.S_max;
      }
    } else {
      // 线性扣分
      var rate = d >= 0 ? (scoring.a || 1) : (scoring.b || 1);
      off = rate * absDevPct;
    }

    var score = (scoring.S_max || 60) - off;
    score = Math.max(scoring.floorScore || 0, score);

    // 舍入
    var rd = scoring.rounding || 'round';
    var dec = scoring.roundDecimals || 2;
    if (rd === 'round') score = Math.round(score * Math.pow(10, dec)) / Math.pow(10, dec);
    else if (rd === 'floor') score = Math.floor(score * Math.pow(10, dec)) / Math.pow(10, dec);
    else if (rd === 'ceil') score = Math.ceil(score * Math.pow(10, dec)) / Math.pow(10, dec);

    return score;
  };

  /* ============================================================
   * 废标 / 无效标规则
   * ============================================================ */

  /**
   * 判断单个报价是否有效
   * @param {number} qi - 报价
   * @param {object} rules - 废标规则
   * @param {function} rngFunc - PRNG
   * @returns {{valid:boolean, flagged:boolean, reason:string}}
   */
  model.checkBid = function (qi, rules, rngFunc) {
    // 超过最高限价 → 无效
    if (rules.overCmaxInvalid && qi > rules._C_max) {
      return { valid: false, flagged: false, reason: '超过最高限价' };
    }
    // 低于成本警戒线
    if (rules._costLine > 0 && qi < rules._costLine) {
      if (rules.belowCost === 'invalid') {
        return { valid: false, flagged: false, reason: '低于成本警戒线' };
      } else {
        // 标记为异常低价但仍有效
        return { valid: true, flagged: true, reason: '异常低价' };
      }
    }
    // 随机废标概率
    if (rules.p_reject > 0 && rngFunc && rngFunc() < rules.p_reject) {
      return { valid: false, flagged: false, reason: '随机废标' };
    }
    return { valid: true, flagged: false, reason: '' };
  };

  /**
   * 过滤有效报价列表
   * @param {number[]} bids - 所有报价
   * @param {object} rules - 废标规则（含 _C_max, _costLine）
   * @param {function} rngFunc - PRNG
   * @param {boolean[]} forceValidMask - 强制有效掩码（partner forceValid）
   * @returns {{validBids:number[], flagged:number[]}}
   */
  model.filterValid = function (bids, rules, rngFunc, forceValidMask) {
    var validBids = [];
    var flagged = [];
    for (var i = 0; i < bids.length; i++) {
      var force = forceValidMask && forceValidMask[i];
      var r;
      if (force) {
        r = { valid: true, flagged: false, reason: '强制有效' };
      } else {
        r = model.checkBid(bids[i], rules, rngFunc);
      }
      if (r.valid) {
        validBids.push(bids[i]);
        if (r.flagged) flagged.push(bids[i]);
      }
    }
    return { validBids: validBids, flagged: flagged };
  };

  /* ============================================================
   * 排名计算
   * ============================================================ */

  /**
   * 计算排名（得分最高第1名，同分报价低者优先）
   * @param {number[]} bids - 有效报价
   * @param {number[]} scores - 对应得分
   * @param {number} myIndex - 我方在 bids 中的索引
   * @returns {number} 排名（1开始）
   */
  model.calcRank = function (bids, scores, myIndex) {
    var n = bids.length;
    if (n === 0) return 0;
    var myScore = scores[myIndex];
    var myBid = bids[myIndex];
    var rank = 1;
    for (var i = 0; i < n; i++) {
      if (i === myIndex) continue;
      if (scores[i] > myScore + 1e-9) {
        rank++;
      } else if (Math.abs(scores[i] - myScore) < 1e-9 && bids[i] < myBid) {
        // 同分报价低者优先 → 对手报价更低则排名比我方靠前
        rank++;
      }
    }
    return rank;
  };

  /**
   * 准备废标规则（将 Scheme 中的规则转为内部格式，附带限价和成本线）
   * @param {object} s - Scheme
   * @returns {object}
   */
  model.prepareRules = function (s) {
    return {
      overCmaxInvalid: s.invalidRules.overCmaxInvalid,
      belowCost: s.invalidRules.belowCost,
      p_reject: (s.invalidRules.p_reject || 0) / 100,
      minValidBidders: s.invalidRules.minValidBidders || 3,
      _C_max: s.project.C_max,
      _costLine: s.project.costWarningLine || 0
    };
  };

  /* ============================================================
   * Worker 注入辅助：暴露闭包私有函数与常量，供 Blob Worker 重建上下文
   * ============================================================ */
  model._h = {
    mean: mean, median: median, minArr: minArr, maxArr: maxArr,
    tokenize: tokenize, toRPN: toRPN, evalRPN: evalRPN, markFunctions: markFunctions,
    SANDBOX_VARS: SANDBOX_VARS, SANDBOX_FUNC_NAMES: Object.keys(SANDBOX_FUNCS)
  };
})(window.BDSS = window.BDSS || {});
