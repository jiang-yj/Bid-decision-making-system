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

  ui.fmtPct = function (v, dec) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return Number(v).toFixed(dec === undefined ? 2 : dec) + '%';
  };

  function $(id) { return document.getElementById(id); }

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
    return charts[id];
  }

  /**
   * 渲染图表（含表格降级）
   * @param {string} id - 容器 DOM id
   * @param {object} option - ECharts option
   * @param {object} fallback - {columns:[], rows:[], title} 降级表格数据
   */
  ui.renderChart = function (id, option, fallback) {
    var dom = $(id);
    if (!dom) return;
    var chart = getChart(id, true);
    if (!chart) {
      // 表格降级
      ui.renderTable(id, fallback.columns, fallback.rows, fallback.title);
      return;
    }
    try {
      chart.setOption(option, true);
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
  ui.renderTable = function (id, columns, rows, title) {
    var dom = $(id);
    if (!dom) return;
    if (!rows || rows.length === 0) {
      dom.innerHTML = '<div class="fallback">' + (title || '无数据') + '</div>';
      return;
    }
    var html = title ? '<h4 style="margin:0 0 6px;font-size:0.85rem;">' + title + '</h4>' : '';
    html += '<table><thead><tr>';
    columns.forEach(function (c) { html += '<th>' + c + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (r, idx) {
      var cls = (r.__best) ? ' class="best-row"' : '';
      html += '<tr' + cls + '>';
      columns.forEach(function (c) {
        var val = (typeof r === 'object' && !Array.isArray(r)) ? r[c] : r[columns.indexOf(c)];
        if (typeof val === 'number') val = ui.fmt(val);
        html += '<td>' + (val === undefined || val === null ? '-' : val) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    dom.innerHTML = html;
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
    var rows = (result.results || []).map(function (r, i) {
      return {
        序号: i + 1,
        报价: r.bid,
        是否有效: r.valid ? '有效' : '无效',
        得分: r.valid ? r.score : '-',
        失效原因: r.reason || '-',
        __best: i === 0 && r.valid
      };
    });
    var columns = ['序号', '报价', '是否有效', '得分', '失效原因'];
    ui.renderTable('singleTable', columns, rows,
      '基准价 B = ' + ui.fmt(result.basePrice) + ' ' + sym + ' ｜ 我方排名：' + (result.myRank || '-') + ' ｜ 有效家数：' + result.validCount + (result.lowConfidence ? '（低置信）' : ''));
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
        var s = '报价：' + ui.fmt(p[0].axisValue) + '<br/>';
        p.forEach(function (it) { s += it.marker + it.seriesName + '：' + it.value + (it.seriesName.indexOf('概率') >= 0 ? '%' : ' 分') + '<br/>'; });
        return s;
      } },
      legend: { data: ['中标概率', '期望得分'], top: 25 },
      grid: { left: 60, right: 60, top: 55, bottom: 40 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmt(c, 0); }), axisLabel: { rotate: 35 } },
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
      rows: stats.map(function (s) { return { '报价': ui.fmt(s.candidate), '中标概率(%)': s.winProb, '期望得分': s.expectedScore }; }),
      title: '中标概率 / 期望得分 vs 报价'
    });

    // 2) 得分分布（P10/P50/P90 区间）
    ui.renderChart('chartScoreDist', {
      title: { text: '得分分布（P10-P50-P90）', left: 'center', textStyle: { fontSize: 13 } },
      tooltip: { trigger: 'axis', formatter: function (p) {
        var s = '报价：' + ui.fmt(p[0].axisValue) + '<br/>';
        p.forEach(function (it) { s += it.marker + it.seriesName + '：' + it.value + ' 分<br/>'; });
        return s;
      } },
      legend: { data: ['P10', 'P50', 'P90'], top: 25 },
      grid: { left: 60, right: 30, top: 55, bottom: 40 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmt(c, 0); }), axisLabel: { rotate: 35 } },
      yAxis: { type: 'value', name: '得分' },
      series: [
        { name: 'P10', type: 'bar', data: stats.map(function (s) { return s.scoreP10; }), itemStyle: { color: '#e8a0a0' } },
        { name: 'P50', type: 'bar', data: stats.map(function (s) { return s.scoreP50; }), itemStyle: { color: '#5b8def' } },
        { name: 'P90', type: 'bar', data: stats.map(function (s) { return s.scoreP90; }), itemStyle: { color: '#a0c8a0' } }
      ]
    }, {
      columns: ['报价', 'P10', 'P50', 'P90'],
      rows: stats.map(function (s) { return { '报价': ui.fmt(s.candidate), 'P10': s.scoreP10, 'P50': s.scoreP50, 'P90': s.scoreP90 }; }),
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
      grid: { left: 60, right: 30, top: 55, bottom: 40 },
      xAxis: { type: 'category', data: cands.map(function (c) { return ui.fmt(c, 0); }), axisLabel: { rotate: 35 } },
      yAxis: { type: 'value', name: '占比(%)', max: 100 },
      series: rankSeries
    }, {
      columns: ['报价', '第1名(%)', '第2名(%)', '第3名(%)', '第4+名(%)'],
      rows: stats.map(function (s) {
        var d = s.rankDist || {};
        var sum4 = 0; for (var k in d) { if (Number(k) >= 4) sum4 += d[k]; }
        return { '报价': ui.fmt(s.candidate), '第1名(%)': d['1'] || 0, '第2名(%)': d['2'] || 0, '第3名(%)': d['3'] || 0, '第4+名(%)': Math.round(sum4 * 100) / 100 };
      }),
      title: '排名分布'
    });

    // 4) 详细统计表
    var bestIdx = stats.indexOf(best);
    var rows = stats.map(function (s, i) {
      return {
        报价: s.candidate,
        中标概率: s.winProb,
        期望得分: s.expectedScore,
        期望排名: s.expectedRank,
        最差排名: s.worstRank,
        P10: s.scoreP10,
        P50: s.scoreP50,
        P90: s.scoreP90,
        标准差: s.scoreStd,
        有效轮数: s.validRounds,
        __best: i === bestIdx
      };
    });
    var columns = ['报价', '中标概率', '期望得分', '期望排名', '最差排名', 'P10', 'P50', 'P90', '标准差', '有效轮数'];
    // 表格需要数值格式化，重新构造
    var fmtRows = stats.map(function (s, i) {
      return {
        报价: ui.fmt(s.candidate),
        中标概率: s.winProb + '%',
        期望得分: s.expectedScore,
        期望排名: s.expectedRank,
        最差排名: s.worstRank,
        P10: s.scoreP10,
        P50: s.scoreP50,
        P90: s.scoreP90,
        标准差: s.scoreStd,
        有效轮数: s.validRounds,
        __best: i === bestIdx
      };
    });
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
    var cands = BDSS.config.generateCandidates(scheme).map(function (c) { return ui.fmt(c, 0); });
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
      grid: { left: 60, right: 30, top: 55, bottom: 40 },
      xAxis: { type: 'category', data: cands, axisLabel: { rotate: 35 } },
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
        最优报价: ui.fmt(best ? best.candidate : 0),
        中标概率: best ? best.winProb + '%' : '-',
        期望得分: best ? best.expectedScore : '-',
        期望排名: best ? best.expectedRank : '-'
      };
    });
    ui.renderTable('scenarioTable', ['场景', '类型', '最优报价', '中标概率', '期望得分', '期望排名'], rows, '各场景最优候选价对比');
  };

  /* ============================================================
   * F3 智能分析渲染
   * ============================================================ */

  ui.renderConclusions = function (conclusions, scheme) {
    if (!conclusions || !conclusions.recommendations) return;
    var md = conclusions.recommendations.text || '';
    // 简易 markdown → HTML
    var html = ui.markdownToHtml(md);
    var el = $('conclusionsHtml') || document.querySelector('.concl-card .markdown-body');
    if (el) el.innerHTML = html;

    // 伙伴表回显
    if (conclusions.partnerEcho && conclusions.partnerEcho.hasPartners) {
      ui.renderTable('partnerEchoTable',
        ['名称', '启用', '设定方式', '报价/分布', '强制有效', '置信度'],
        conclusions.partnerEcho.rows,
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
    lines.push('报价,中标概率(%),期望得分,期望排名,最差排名,得分P10,得分P50,得分P90,得分标准差,有效轮数,总轮数');
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
    md.push('**限价 C_max**：' + ui.fmt(scheme.project.C_max) + '  ');
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
    md.push('| 报价 | 中标概率(%) | 期望得分 | 期望排名 | 最差排名 | P10 | P50 | P90 | 标准差 | 有效轮数 |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    stats.forEach(function (s) {
      md.push('| ' + ui.fmt(s.candidate) + ' | ' + s.winProb + ' | ' + s.expectedScore + ' | ' + s.expectedRank + ' | ' + s.worstRank + ' | ' + s.scoreP10 + ' | ' + s.scoreP50 + ' | ' + s.scoreP90 + ' | ' + s.scoreStd + ' | ' + s.validRounds + ' |');
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
        md.push('| ' + ss.scenario.name + ' | ' + ss.scenario.type + ' | ' + ui.fmt(best ? best.candidate : 0) + ' | ' + (best ? best.winProb : '-') + ' | ' + (best ? best.expectedScore : '-') + ' | ' + (best ? best.expectedRank : '-') + ' |');
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
