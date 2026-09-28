/**
 * js/storage.js — localStorage 方案管理、导入导出、示例加载
 * 层级：storage（非 Worker 安全：操作 localStorage）
 */
(function (BDSS) {
  'use strict';

  var storage = (BDSS.storage = BDSS.storage || {});
  var KEY = BDSS.defaults.storageKey;
  var CACHE_KEY = BDSS.defaults.cacheKey;
  var memStore = null; // localStorage 不可用时降级

  /**
   * 安全读取 localStorage
   */
  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      if (!memStore) memStore = {};
      return memStore[key] || null;
    }
  }

  function lsSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      if (!memStore) memStore = {};
      memStore[key] = val;
    }
  }

  function lsDel(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      if (memStore) delete memStore[key];
    }
  }

  /* ============================================================
   * 方案 CRUD
   * ============================================================ */

  /**
   * 获取所有方案列表
   * @returns {{id,name,updatedAt,pinned,summary:object}[]}
   */
  storage.list = function () {
    var raw = lsGet(KEY);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return arr.map(function (s) {
        return {
          id: s.meta.id,
          name: s.meta.name,
          updatedAt: s.meta.updatedAt,
          pinned: s.meta.pinned,
          summary: {
            C_max: s.project ? s.project.C_max : 0,
            model: s.pricingModel ? s.pricingModel.type : 'A',
            partners: (s.partners || []).length,
            opponents: s.opponents ? s.opponents.count : 0
          }
        };
      }).sort(function (a, b) {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
    } catch (e) {
      console.error('[BDSS] 方案列表解析失败:', e);
      return [];
    }
  };

  /**
   * 获取所有方案完整数据
   * @returns {object[]}
   */
  storage.listFull = function () {
    var raw = lsGet(KEY);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  };

  /**
   * 保存方案（新建或更新）
   * @param {object} scheme
   */
  storage.save = function (scheme) {
    var all = storage.listFull();
    var idx = -1;
    for (var i = 0; i < all.length; i++) {
      if (all[i].meta.id === scheme.meta.id) { idx = i; break; }
    }
    scheme.meta.updatedAt = new Date().toISOString();
    if (idx >= 0) {
      all[idx] = scheme;
    } else {
      all.push(scheme);
    }
    lsSet(KEY, JSON.stringify(all));
  };

  /**
   * 加载单个方案
   * @param {string} id
   * @returns {object|null}
   */
  storage.load = function (id) {
    var all = storage.listFull();
    for (var i = 0; i < all.length; i++) {
      if (all[i].meta.id === id) return BDSS.config.migrate(all[i]);
    }
    return null;
  };

  /**
   * 复制方案
   * @param {string} id
   * @returns {object|null}
   */
  storage.copy = function (id) {
    var s = storage.load(id);
    if (!s) return null;
    s.meta.id = BDSS.config.uid();
    s.meta.name = s.meta.name + ' (副本)';
    s.meta.pinned = false;
    s.meta.createdAt = new Date().toISOString();
    s.meta.updatedAt = s.meta.createdAt;
    storage.save(s);
    return s;
  };

  /**
   * 重命名方案
   * @param {string} id
   * @param {string} name
   */
  storage.rename = function (id, name) {
    var s = storage.load(id);
    if (!s) return;
    s.meta.name = name;
    storage.save(s);
  };

  /**
   * 删除方案
   * @param {string} id
   */
  storage.del = function (id) {
    var all = storage.listFull();
    all = all.filter(function (s) { return s.meta.id !== id; });
    lsSet(KEY, JSON.stringify(all));
  };

  /**
   * 置顶/取消置顶
   * @param {string} id
   */
  storage.togglePin = function (id) {
    var s = storage.load(id);
    if (!s) return;
    s.meta.pinned = !s.meta.pinned;
    storage.save(s);
  };

  /* ============================================================
   * 导入导出
   * ============================================================ */

  /**
   * 导出方案为 JSON 字符串
   * @param {object} scheme
   * @returns {string}
   */
  storage.exportJSON = function (scheme) {
    return JSON.stringify(scheme, null, 2);
  };

  /**
   * 从 JSON 字符串导入方案
   * @param {string} jsonStr
   * @returns {{ok:boolean, scheme:object, error:string}}
   */
  storage.importJSON = function (jsonStr) {
    try {
      var obj = JSON.parse(jsonStr);
      var s = BDSS.config.migrate(obj);
      s.meta.id = BDSS.config.uid(); // 新 ID 避免冲突
      s.meta.createdAt = new Date().toISOString();
      s.meta.updatedAt = s.meta.createdAt;
      storage.save(s);
      return { ok: true, scheme: s, error: '' };
    } catch (e) {
      return { ok: false, scheme: null, error: e.message };
    }
  };

  /**
   * 从文件读取并导入
   * @param {File} file
   * @param {function} callback - (result)
   */
  storage.importFile = function (file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      callback(storage.importJSON(e.target.result));
    };
    reader.onerror = function () {
      callback({ ok: false, scheme: null, error: '文件读取失败' });
    };
    reader.readAsText(file);
  };

  /**
   * 触发文件下载
   * @param {string} content
   * @param {string} filename
   * @param {string} mime
   */
  storage.download = function (content, filename, mime) {
    mime = mime || 'application/octet-stream';
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 100);
  };

  /* ============================================================
   * 结果缓存
   * ============================================================ */

  storage.cacheResult = function (result) {
    try {
      lsSet(CACHE_KEY, JSON.stringify(result));
    } catch (e) {
      console.warn('[BDSS] 结果缓存失败:', e.message);
    }
  };

  storage.loadCache = function () {
    var raw = lsGet(CACHE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  /* ============================================================
   * 示例方案
   * ============================================================ */

  /**
   * 加载内置示例方案列表
   * @returns {object[]}
   */
  storage.loadExamples = function () {
    if (BDSS.examples) return BDSS.examples;
    return [];
  };

  /**
   * 将示例方案写入 localStorage
   */
  storage.installExamples = function () {
    var examples = storage.loadExamples();
    var all = storage.listFull();
    var existingIds = all.map(function (s) { return s.meta.id; });

    examples.forEach(function (ex) {
      if (existingIds.indexOf(ex.meta.id) < 0) {
        all.push(ex);
      }
    });

    lsSet(KEY, JSON.stringify(all));
  };

  /**
   * 重置为默认方案
   */
  storage.createDefault = function () {
    return BDSS.config.createDefaultScheme();
  };
})(window.BDSS = window.BDSS || {});
