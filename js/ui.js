/**
 * js/ui.js — UI 渲染层：ECharts 封装（含表格降级）、结果表渲染、导出、打印
 * 层级：ui（非 Worker 安全：操作 DOM、ECharts）
 */
(function (BDSS) {
  'use strict';

  var ui = (BDSS.ui = BDSS.ui || {});
  var charts = {}; // ECharts 实例缓存

  /* ============================================================
   * 通用：格式化与 DOM 辅助
   * ============================================================ */

  ui.fmt = function (v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    dec = dec === undefined ? 2 : dec;
    var n = Number(v);
    return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };

  /** 金额单位：'yuan'(元,默认) 或 'wan'(万元) */
  ui.amountUnit = 'yuan';

  /**
   * 按当前金额单位格式化
   * @param {number} v - 原始金额（元）
   * @param {number} [dec] - 小数位，默认 2
   * @returns {string} 格式化后的字符串（含单位后缀）
   */
  ui.fmtMoney = function (v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    dec = dec === undefined ? 2 : dec;
    var n = Number(v);
    if (ui.amountUnit === 'wan') {
      return (n / 1e4).toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' 万元';
    }
    return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + ' 元';
  };

  /**
   * 按当前金额单位格式化（无单位后缀，用于表格单元格）
   */
  ui.fmtMoneyVal = function (v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    dec = dec === undefined ? 2 : dec;
    var n = Number(v);
    if (ui.amountUnit === 'wan') {
      return (n / 1e4).toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };

  ui.fmtPct = function (v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return Number(v).toFixed(dec === undefined ? 2 : dec) + '%';
  };

  function $(id) { return document.getElementById(id); }

  /* ResizeObserver：容器尺寸变化（如面板展开/显示）时自动重绘图表 */
  var _ro = null;
  function ensureObserver() {
    if (_ro || typeof ResizeObserver === 'undefined') return;
    _ro = new ResizeObserver(function (entries) {
      entries.forEach(function (en) {
        var id = en.target.id;
        if (id && charts[id] && en.target.clientWidth > 0) {
          try { charts[id].resize(); } catch (e) {}
        }
      });
    });
  }

  /**
   * 确保 ECharts 已加载并获取实例
   * @param {string} id
   * @param {boolean} force - 强制重建
   * @returns {object|null} ECharts 实例或 null（降级）
   */
  function getChart(id, force) {
    var dom = $(id);
    if (!dom) return null;
    if (typeof echarts === 'undefined') return null;
    if (charts[id] && !force) {
      try { charts[id].resize(); return charts[id]; } catch (e) { delete charts[id]; }
    }
    charts[id] = echarts.init(dom, null, { renderer: 'canvas' });
    ensureObserver();
    if (_ro) { try { _ro.observe(dom); } catch (e) {} }
    return charts[id];
  }

  /**
   * 检测当前是否暗黑模式
   */
  function isDarkMode() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  /**
   * 为 ECharts option 注入暗黑模式适配（背景色、文字色、轴线色）
   */
  function applyChartTheme(option) {
    if (!isDarkMode()) return option;
    var darkBg = '#1a2230';
    var darkText = '#d7dfe9';
    var darkAxisLine = '#3a4353';
    var darkSplitLine = '#293241';
    option.backgroundColor = option.backgroundColor || darkBg;
    option.textStyle = option.textStyle || {};
    option.textStyle.color = darkText;
    if (option.title) {
      option.title.textStyle = option.title.textStyle || {};
      option.title.textStyle.color = darkText;
    }
    if (option.legend) {
      option.legend.textStyle = option.legend.textStyle || {};
      option.legend.textStyle.color = darkText;
    }
    function fixAxis(ax) {
      if (!ax) return;
      if (Array.isArray(ax)) { ax.forEach(fixAxis); return; }
      ax.axisLine = ax.axisLine || { lineStyle: { color: darkAxisLine } };
      if (!ax.axisLine.lineStyle) ax.axisLine.lineStyle = { color: darkAxisLine };
      ax.axisLabel = ax.axisLabel || {};
      ax.axisLabel.color = darkText;
      ax.splitLine = ax.splitLine || { lineStyle: { color: darkSplitLine } };
      if (!ax.splitLine.lineStyle) ax.splitLine.lineStyle = { color: darkSplitLine };
    }
    fixAxis(option.xAxis);
    fixAxis(option.yAxis);
    return option;
  }

  /**
   * 格式化金额为紧凑显示（万 / 亿），避免横坐标数字过长被遮挡
   * 图表专用，不随金额单位开关切换
   */
  ui.fmtCompact = function (v) {
    if (v == null || isNaN(v)) return '-';
    var n = Number(v);
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(0) + '万';
    return ui.fmt(n, 0);
  };

  /**
   * 渲染图表（含表格降级）
   * 修复：x-show 隐藏容器宽度为 0 时延迟重试，待容器可见后再初始化
   * @param {string} id - 容器 DOM id
   * @param {object} option - ECharts option
   * @param {object} fallback - {columns:[], rows:[], title} 降级表格数据
   * @param {number} [_retry] - 内部重试计数
   */
  ui.renderChart = function (id, option, fallback, _retry) {
    var dom = $(id);
    if (!dom) return;
    _retry = _retry || 0;
    // 容器尚未可见（x-show / details 未展开）时宽度为 0，延迟重试直至可见
    if (typeof echarts !== 'undefined' && dom.clientWidth === 0 && _retry < 60) {
      setTimeout(function () { ui.renderChart(id, option, fallback, _retry + 1); }, 50);
      return;
    }
    var chart = getChart(id, true);
    if (!chart) {
      // 表格降级
      ui.renderTable(id, fallback.columns, fallback.rows, fallback.title);
      return;
    }
    try {
      applyChartTheme(option);
      chart.setOption(option, true);
      chart.resize();
    } catch (e) {
      console.warn('[BDSS] 图表渲染失败，降级为表格:', e.message);
      ui.renderTable(id, fallback.columns, fallback.rows, fallback.title);
    }
  };

  /**
   * 渲染表格到容器
   * @param {string} id
   * @param {string[]} columns
   * @param {object[]|array[]} rows - 对象数组或二维数组
   * @param {string} title
   */
  /**
   * 检测列是否为数值列
   */
  function isNumericColumn(rows, colKey) {
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i][colKey];
      if (typeof v === 'number') return true;
      if (typeof v === 'string' && v && !isNaN(parseFloat(v.replace(/[%,\s元万亿]/g, '')))) count++;
    }
    return count > rows.length / 2;
  }

  /**
   * 提取单元格中的数值用于排序
   */
  function extractNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var m = v.replace(/[%,\s元万亿]/g, '');
      var n = parseFloat(m);
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  ui.renderTable = function (id, columns, rows, title) {
    var dom = $(id);
    if (!dom) return;
    if (!rows || rows.length === 0) {
      dom.innerHTML = '<div class="fallback">' + (title || '无数据') + '</div>';
      return;
    }

    // 检测哪些列是数值列
    var numericCols = {};
    columns.forEach(function (c) {
      if (isNumericColumn(rows, c)) numericCols[c] = true;
    });

    // 排序状态：null=默认, 'desc'=降序, 'asc'=升序
    if (!dom._sortState) dom._sortState = {};
    if (!dom._sortRows) dom._sortRows = {};
    // 保存原始行数据用于排序
    dom._sortRows[id] = { columns: columns, rows: rows.slice(), title: title, numericCols: numericCols };

    function renderSorted() {
      var state = dom._sortState;
      var data = dom._sortRows[id];
      var sortedRows = data.rows.slice();
      var activeCol = null;
      for (var k in state) { if (state[k]) { activeCol = k; break; } }
      if (activeCol && state[activeCol]) {
        var dir = state[activeCol] === 'desc' ? -1 : 1;
        sortedRows.sort(function (a, b) {
          return dir * (extractNum(a[activeCol]) - extractNum(b[activeCol]));
        });
      }

      var html = data.title ? '<h4 style="margin:0 0 6px;font-size:0.85rem;">' + data.title + '</h4>' : '';
      html += '<table><thead><tr>';
      data.columns.forEach(function (c) {
        var isNum = data.numericCols[c];
        var indicator = '';
        if (isNum) {
          var st = state[c];
          if (st === 'desc') indicator = ' <span class="sort-arrow desc">▼</span>';
          else if (st === 'asc') indicator = ' <span class="sort-arrow asc">▲</span>';
          else indicator = ' <span class="sort-arrow none">↕</span>';
          html += '<th class="sortable" data-col="' + c + '">' + c + indicator + '</th>';
        } else {
          html += '<th>' + c + '</th>';
        }
      });
      html += '</tr></thead><tbody>';
      sortedRows.forEach(function (r) {
        var cls = (r.__best) ? ' class="best-row"' : '';
        html += '<tr' + cls + '>';
        data.columns.forEach(function (c) {
          var val = r[c];
          if (typeof val === 'number') val = ui.fmt(val);
          html += '<td>' + (val === undefined || val === null ? '-' : val) + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      dom.innerHTML = html;

      // 绑定排序点击事件
      var ths = dom.querySelectorAll('th.sortable');
      ths.forEach(function (th) {
        th.addEventListener('click', function () {
          var col = th.getAttribute('data-col');
          var cur = dom._sortState[col];
          // 循环：null → desc → asc → null
          // 先清除其他列的排序状态
          for (var k in dom._sortState) {
            if (k !== col) dom._sortState[k] = null;
          }
          if (!cur) dom._sortState[col] = 'desc';
          else if (cur === 'desc') dom._sortState[col] = 'asc';
          else dom._sortState[col] = null;
          renderSorted();
        });
      });
    }

    renderSorted();
  };

  function clearHost(id) {
    var dom = $(id);
    if (dom) dom.innerHTML = '';
    if (charts[id]) { try { charts[id].dispose(); } catch (e) {} delete charts[id]; }
  }

  /* ============================================================
   * F2-1 单点测算结果渲染
   * ============================================================ */

  ui.renderSinglePoint = function (result, currencySymbol) {
    if (!result) { clearHost('singleTable'); return; }
    var sym = currencySymbol || '¥';
    var labels = result.labels || [];
    var ranks = result.ranks || [];
    var rows = (result.results || []).map(function (r, i) {
      return {
        排名: r.valid ? (ranks[i] || '-') : '-',
        投标人: labels[i] || ('投标人' + (i + 1)),
        报价: ui.fmtMoneyVal(r.bid),
        是否有效: r.valid ? '有效' : '无效',
        得分: r.valid ? r.score : '-',
        失效原因: r.reason || '-',
        __best: i === 0 && r.valid
      };
    });
    var columns = ['排名', '投标人', '报价', '是否有效', '得分', '失效原因'];
    ui.renderTable('singleTable', columns, rows,
      '基准价 B = ' + ui.fmtMoney(result.basePrice) + ' ｜ 我方排名：' + (result.myRank || '-') + ' ｜ 有效家数：' + result.validCount + (result.lowConfidence ? '（低置信）' : ''));
  };

  /* ============================================================
   * F2-2 批量扫描结果渲染
   * ============================================================ */

  ui.renderBatchResults = function (stats, scheme) {
    if (!stats || stats.length === 0) {
      clearHost('chartWinProb'); clearHost('chartScoreDist'); clearHost('chartRankDist'); clearHost('batchTable');
      return;
    }
    var cands = stats.map(function (s) { return s.candidate; });
    var winProbs = stats.map(function (s) { return s.winProb; });
    var expScores = stats.map(function (s) { return s.expectedScore; });
    var best = stats.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];

    // 1) 中标概率曲线（含期望得分副轴）
    ui.renderChart('chartWinProb', {
      title: { text: '中标概率 / 期望得分 vs 报价', left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis', formatter: function (p) {
        var s = '报价：' + p[0].axisValue + '<br/>';
        p.forEach(function (it) { s += it.marker + it.seriesName + '：' + it.value + (it.seriesName.indexOf('概率') >= 0 ? '%' : ' 分') + '<br/>'; });
        return s;
      } },
      legend: { data: ['中标概率', '期望得分'], top: 25 },
      grid: { left: 60, right: 60, top: 55, bottom: 60 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmtCompact(c); }), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: [
        { type: 'value', name: '中标概率(%)', min: 0, max: 100 },
        { type: 'value', name: '得分', position: 'right' }
      ],
      series: [
        { name: '中标概率', type: 'line', smooth: true, data: winProbs, itemStyle: { color: '#2c6bed' }, areaStyle: { opacity: 0.15 }, markPoint: { data: [{ type: 'max', name: '最优点' }] } },
        { name: '期望得分', type: 'line', smooth: true, yAxisIndex: 1, data: expScores, itemStyle: { color: '#6a4bc9' } }
      ]
    }, {
      columns: ['报价', '中标概率(%)', '期望得分'],
      rows: stats.map(function (s) { return { '报价': ui.fmtMoneyVal(s.candidate), '中标概率(%)': s.winProb, '期望得分': s.expectedScore }; }),
      title: '中标概率 / 期望得分 vs 报价'
    });

    // 2) 得分分布（P10/P50/P90 区间）
    ui.renderChart('chartScoreDist', {
      title: { text: '得分分布（P10-P50-P90）', left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis', formatter: function (p) {
        var s = '报价：' + p[0].axisValue + '<br/>';
        p.forEach(function (it) { s += it.marker + it.seriesName + '：' + it.value + ' 分<br/>'; });
        return s;
      } },
      legend: { data: ['P10', 'P50', 'P90'], top: 25 },
      grid: { left: 60, right: 30, top: 55, bottom: 60 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmtCompact(c); }), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value', name: '得分' },
      series: [
        { name: 'P10', type: 'bar', data: stats.map(function (s) { return s.scoreP10; }), itemStyle: { color: '#e8a0a0' } },
        { name: 'P50', type: 'bar', data: stats.map(function (s) { return s.scoreP50; }), itemStyle: { color: '#5b8def' } },
        { name: 'P90', type: 'bar', data: stats.map(function (s) { return s.scoreP90; }), itemStyle: { color: '#a0c8a0' } }
      ]
    }, {
      columns: ['报价', 'P10', 'P50', 'P90'],
      rows: stats.map(function (s) { return { '报价': ui.fmtMoneyVal(s.candidate), 'P10': s.scoreP10, 'P50': s.scoreP50, 'P90': s.scoreP90 }; }),
      title: '得分分布（P10-P50-P90）'
    });

    // 3) 排名分布（堆叠柱）
    var rankKeys = ['1', '2', '3', '4+'];
    var rankSeries = rankKeys.map(function (rk) {
      return {
        name: '第' + rk + '名',
        type: 'bar',
        stack: '排名',
        data: stats.map(function (s) {
          var dist = s.rankDist || {};
          if (rk === '4+') {
            var sum = 0;
            for (var k in dist) { if (Number(k) >= 4) sum += dist[k]; }
            return Math.round(sum * 100) / 100;
          }
          return dist[rk] || 0;
        })
      };
    });
    ui.renderChart('chartRankDist', {
      title: { text: '排名分布（堆叠%，共100%）', left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 25 },
      grid: { left: 60, right: 30, top: 55, bottom: 60 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmtCompact(c); }), axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value', name: '占比(%)', max: 100 },
      series: rankSeries
    }, {
      columns: ['报价', '第1名(%)', '第2名(%)', '第3名(%)', '第4+名(%)'],
      rows: stats.map(function (s) {
        var d = s.rankDist || {};
        var sum4 = 0; for (var k in d) { if (Number(k) >= 4) sum4 += d[k]; }
        return { '报价': ui.fmtMoneyVal(s.candidate), '第1名(%)': d['1'] || 0, '第2名(%)': d['2'] || 0, '第3名(%)': d['3'] || 0, '第4+名(%)': Math.round(sum4 * 100) / 100 };
      }),
      title: '排名分布'
    });

    // 4) 详细统计表
    var bestIdx = stats.indexOf(best);
    var fmtRows = stats.map(function (s, i) {
      return {
        报价: ui.fmtMoneyVal(s.candidate),
        中标概率: s.winProb + '%',
        期望得分: s.expectedScore,
        '期望排名（均值）': s.expectedRank,
        最差排名: s.worstRank,
        P10: s.scoreP10,
        P50: s.scoreP50,
        P90: s.scoreP90,
        标准差: s.scoreStd,
        有效轮数: s.validRounds,
        __best: i === bestIdx
      };
    });
    var columns = ['报价', '中标概率', '期望得分', '期望排名（均值）', '最差排名', 'P10', 'P50', 'P90', '标准差', '有效轮数'];
    ui.renderTable('batchTable', columns, fmtRows, '批量扫描明细（★ 最优候选价）');
  };

  /* ============================================================
   * F2-3 场景对比渲染
   * ============================================================ */

  ui.renderScenarioComparison = function (scenarioStats, scheme) {
    if (!scenarioStats || scenarioStats.length === 0) {
      clearHost('chartScenario'); clearHost('scenarioTable');
      return;
    }
    var cands = BDSS.config.generateCandidates(scheme).map(function (c) { return ui.fmtCompact(c); });
    var series = scenarioStats.map(function (ss) {
      return {
        name: ss.scenario.name,
        type: 'line',
        smooth: true,
        data: ss.stats.map(function (s) { return s.winProb; })
      };
    });
    ui.renderChart('chartScenario', {
      title: { text: '场景对比 · 中标概率', left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis', formatter: function (p) {
        var s = '报价：' + p[0].axisValue + '<br/>';
        p.forEach(function (it) { s += it.marker + it.seriesName + '：' + it.value + '%<br/>'; });
        return s;
      } },
      legend: { top: 25 },
      grid: { left: 60, right: 30, top: 55, bottom: 60 },
      xAxis: { type: 'category', data: cands, axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: { type: 'value', name: '中标概率(%)', min: 0, max: 100 },
      series: series
    }, {
      columns: ['报价'].concat(scenarioStats.map(function (ss) { return ss.scenario.name; })),
      rows: cands.map(function (c, i) {
        var row = { 报价: c };
        scenarioStats.forEach(function (ss) { row[ss.scenario.name] = ss.stats[i] ? ss.stats[i].winProb + '%' : '-'; });
        return row;
      }),
      title: '场景对比 · 中标概率'
    });

    // 最优候选价对比表
    var rows = scenarioStats.map(function (ss) {
      var best = ss.stats.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];
      return {
        场景: ss.scenario.name,
        类型: ss.scenario.type,
        最优报价: ui.fmtMoneyVal(best ? best.candidate : 0),
        中标概率: best ? best.winProb + '%' : '-',
        期望得分: best ? best.expectedScore : '-',
        '期望排名（均值）': best ? best.expectedRank : '-'
      };
    });
    ui.renderTable('scenarioTable', ['场景', '类型', '最优报价', '中标概率', '期望得分', '期望排名（均值）'], rows, '各场景最优候选价对比');
  };

  /* ============================================================
   * F3 智能分析渲染
   * ============================================================ */

  ui.renderConclusions = function (conclusions, scheme) {
    if (!conclusions) return;
    var md = (conclusions.recommendations && conclusions.recommendations.text) || '';
    // 简易 markdown → HTML
    var html = ui.markdownToHtml(md);
    var el = $('conclusionsHtml') || document.querySelector('.concl-card .markdown-body');
    if (el) el.innerHTML = html;

    // 伙伴表回显（行数据键为英文，需映射为中文表头键，否则单元格取值失败显示 '-'）
    if (conclusions.partnerEcho && conclusions.partnerEcho.hasPartners) {
      var methodMap = {};
      (BDSS.defaults.partnerMethods || []).forEach(function (m) { methodMap[m.value] = m.label; });
      var echoRows = conclusions.partnerEcho.rows.map(function (r) {
        return {
          '名称': r.name,
          '启用': r.enabled,
          '设定方式': methodMap[r.method] || r.method,
          '报价/分布': r.quote,
          '强制有效': r.forceValid,
          '置信度': r.confidence
        };
      });
      ui.renderTable('partnerEchoTable',
        ['名称', '启用', '设定方式', '报价/分布', '强制有效', '置信度'],
        echoRows,
        '伙伴假设回显');
    } else {
      clearHost('partnerEchoTable');
    }
  };

  /**
   * 极简 Markdown → HTML（仅供本系统文案使用）
   */
  ui.markdownToHtml = function (md) {
    if (!md) return '';
    var html = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.*)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, function (m) { return '<ul>' + m + '</ul>'; })
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    return '<p>' + html + '</p>';
  };

  /* ============================================================
   * 导出
   * ============================================================ */

  ui.exportCSV = function (stats, scheme, conclusions) {
    if (!stats || stats.length === 0) return;
    var lines = [];
    lines.push('报价,中标概率(%),期望得分,期望排名(均值),最差排名,得分P10,得分P50,得分P90,得分标准差,有效轮数,总轮数');
    stats.forEach(function (s) {
      lines.push([s.candidate, s.winProb, s.expectedScore, s.expectedRank, s.worstRank, s.scoreP10, s.scoreP50, s.scoreP90, s.scoreStd, s.validRounds, s.totalRounds].join(','));
    });
    if (conclusions && conclusions.recommendations) {
      lines.push('');
      lines.push('# 智能分析结论');
      (conclusions.recommendations.text || '').split('\n').forEach(function (l) {
        lines.push('"' + l.replace(/"/g, '""') + '"');
      });
    }
    lines.push('');
    lines.push('# 合规声明');
    lines.push('"' + BDSS.defaults.complianceNotice + '"');
    var csv = '\ufeff' + lines.join('\n');
    BDSS.storage.download(csv, (scheme.meta.name || '方案') + '_批量扫描.csv', 'text/csv;charset=utf-8');
  };

  ui.exportPNG = function () {
    var exported = false;
    for (var id in charts) {
      if (charts[id]) {
        try {
          var url = charts[id].getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
          var a = document.createElement('a');
          a.href = url;
          a.download = id + '.png';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          exported = true;
        } catch (e) {}
      }
    }
    return exported;
  };

  ui.exportMarkdown = function (stats, scheme, conclusions, scenarioStats) {
    if (!stats) return;
    var md = [];
    md.push('# 投标决策分析报告');
    md.push('');
    md.push('**方案**：' + (scheme.meta.name || '未命名') + '  ');
    md.push('**生成时间**：' + new Date().toLocaleString('zh-CN') + '  ');
    md.push('**项目**：' + (scheme.project.name || '-') + '（' + (scheme.project.code || '-') + '）  ');
    md.push('**限价 C_max**：' + ui.fmtMoney(scheme.project.C_max) + '  ');
    md.push('**基准价模型**：' + BDSS.config.getModelReadable(scheme) + '  ');
    md.push('');
    md.push('## 合规声明');
    md.push('');
    md.push('> ' + BDSS.defaults.complianceNotice);
    md.push('>');
    md.push('> 依据：《中华人民共和国招标投标法》第三十二条、第五十三条；《实施条例》第三十九条至第四十一条。本系统不提供、不建议任何与其他投标人协调报价的方案。');
    md.push('');
    md.push('## 批量扫描结果');
    md.push('');
    md.push('| 报价 | 中标概率(%) | 期望得分 | 期望排名（均值） | 最差排名 | P10 | P50 | P90 | 标准差 | 有效轮数 |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    stats.forEach(function (s) {
      md.push('| ' + ui.fmtMoneyVal(s.candidate) + ' | ' + s.winProb + ' | ' + s.expectedScore + ' | ' + s.expectedRank + ' | ' + s.worstRank + ' | ' + s.scoreP10 + ' | ' + s.scoreP50 + ' | ' + s.scoreP90 + ' | ' + s.scoreStd + ' | ' + s.validRounds + ' |');
    });
    md.push('');
    if (conclusions && conclusions.recommendations) {
      md.push(conclusions.recommendations.text);
      md.push('');
    }
    if (conclusions && conclusions.robustness) {
      md.push(conclusions.robustness.text);
      md.push('');
    }
    if (conclusions && conclusions.risks && conclusions.risks.items) {
      md.push('## 风险提示');
      md.push('');
      conclusions.risks.items.forEach(function (r) { md.push('- ' + r); });
      md.push('');
    }
    if (scenarioStats && scenarioStats.length) {
      md.push('## 场景对比');
      md.push('');
      md.push('| 场景 | 类型 | 最优报价 | 中标概率(%) | 期望得分 | 期望排名 |');
      md.push('|---|---|---|---|---|---|');
      scenarioStats.forEach(function (ss) {
        var best = ss.stats.slice().sort(function (a, b) { return b.winProb - a.winProb; })[0];
        md.push('| ' + ss.scenario.name + ' | ' + ss.scenario.type + ' | ' + ui.fmtMoneyVal(best ? best.candidate : 0) + ' | ' + (best ? best.winProb : '-') + ' | ' + (best ? best.expectedScore : '-') + ' | ' + (best ? best.expectedRank : '-') + ' |');
      });
      md.push('');
    }
    if (conclusions && conclusions.partnerEcho && conclusions.partnerEcho.hasPartners) {
      md.push('## 伙伴假设回显');
      md.push('');
      md.push('| 名称 | 启用 | 设定方式 | 报价/分布 | 强制有效 | 置信度 |');
      md.push('|---|---|---|---|---|---|');
      conclusions.partnerEcho.rows.forEach(function (r) {
        md.push('| ' + r.name + ' | ' + r.enabled + ' | ' + r.method + ' | ' + r.quote + ' | ' + r.forceValid + ' | ' + r.confidence + ' |');
      });
      md.push('');
    }
    BDSS.storage.download(md.join('\n'), (scheme.meta.name || '方案') + '_报告.md', 'text/markdown;charset=utf-8');
  };

  ui.printReport = function () {
    // 浏览器原生打印，依赖 @media print 样式
    window.print();
  };

  /* ============================================================
   * 自检结果渲染
   * ============================================================ */

  ui.renderSelfTest = function (result) {
    var html = ui.markdownToHtml(result.text);
    return html;
  };

  /* ============================================================
   * 窗口尺寸变化时重绘图表
   * ============================================================ */
  window.addEventListener('resize', function () {
    for (var id in charts) {
      if (charts[id]) { try { charts[id].resize(); } catch (e) {} }
    }
  });

})(window.BDSS = window.BDSS || {});
