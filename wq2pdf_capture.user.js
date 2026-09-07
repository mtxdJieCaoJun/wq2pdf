// ==UserScript==
// @name         文泉切片捕获 wq2pdf_capture
// @namespace    wq2pdf_capture
// @version      1.0.1
// @description  静默捕获文泉书局阅读页切片图片，CSV 记录变换方式，同步捕获目录写 <bid>_toc.json，左下角一键打包 zip；还原 PDF 请用配套 wq2pdf_reconstruct.py
// @author       mtxdJieCaoJun vibe by WorkBuddy
// @match        *://wqbook.wqxuetang.com/deep/read/*
// @run-at       document-idle
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * ============================ 使用说明 ============================
 *
 * 1. 打开阅读页自动静默捕获，正常阅读/滚动即可；想整本抓开启「自动滚动」；
 * 2. 切片取自浏览器 HTTP 缓存，失败回退 canvas 转 JPEG(q0.95)；
 * 3. 「打包下载」得 <bid>.zip：<bid>.csv（页码,变换） + img/pNNNN_MM.jpg（显示序） + <bid>_toc.json（目录快照） + 异常时 WARNING.txt。
 * 4. 暂停/清空缓存后捕获挂起（显示 ⏸），点 ▶ 或开自动滚动恢复；页面打开即抓目录；暂停期间不主动抓目录，但暂停中打包仍会抓目录（保证 zip 带书签）。
 * 5. 仅支持同时捕获一本书籍，地址栏 bid 变化即换书，各书记录/目录独立保留；
 * 6. 默认最后激活的标签页；切走的标签自动暂停、切回自动恢复（手动/清缓存的暂停除外）。非主标签显示「待命（点此接管）」；
 * 7. 清空按钮第一次只清当前书；当前书无缓存时，改为两步确认清全部：首点变「⚠再次点击清除全部缓存」再点才清；鼠标移开按钮即复原。
 *
 * 获取<bid>.zip后使用配套 wq2pdf_reconstruct.py 还原带目录书签的 PDF。
 *
 * 仅供本人已合法取得访问权限的内容做离线备份，请勿传播产物。
 * ================================================================
 */

(function () {
  'use strict';

  // ---------------- 配置 ----------------
  const CFG = {
    scanInterval: 700,          // 兜底全量扫描间隔 ms
    scanQuietAfterScroll: 300,  // 滚动后静默多久才做兜底扫描
    jpegQuality: 0.95,          // canvas 回退时的 JPEG 质量
    fpWarnThreshold: 15,        // 同指纹出现超过该次数 → 疑似限速占位图
    autoScrollStepRatio: 0.8,   // 每步滚动距离 / 视口高
    autoScrollInterval: 900,    // 自动滚动 tick 间隔 ms
    autoScrollWaitMax: 8,       // 等待图片就绪的最大 tick 数
  };

  const BID = (new URLSearchParams(location.search).get('bid') || '').trim();
  let BOOK = BID; // 记录归属的书号（取 URL bid，缺省时回退到图片路径里的编号）

  // ---------------- 状态 ----------------
  const captured = new Set();     // 已入库 key: bid/page/left*10
  const inflight = new Set();     // 处理中 key
  const pageSlices = new Map();   // page -> Set(left)
  const pageExpected = new Map(); // page -> 观测到的切片总数（最大值）
  const fpCounts = new Map();     // 指纹 -> 次数
  const stats = { cache: 0, canvas: 0, failed: 0, lastExported: 0 };
  let captureChain = Promise.resolve();
  let lastScroll = 0;
  let exporting = false;
  let autoTimer = null, autoWait = 0, autoStuck = 0;
  let paused = false; // 捕获挂起（手动暂停/清空缓存后，或切到后台自动暂停）
  let pausedAuto = false; // 暂停是否因「切到后台」自动引起：切回前台自动恢复；手动暂停不受影响
  let epoch = 0;      // 清空缓存/换书时 +1，作废已在队列中的旧捕获任务
  let lastUrlBid = BID;      // 轮询跟踪的 URL bid（检测同一标签页内换书）
  let pendingSwitchBid = null; // 打包进行中请求换书则等导出结束再切

  // 多标签页：IndexedDB 同源共享，只允许一个标签页捕获，避免多页同时抓同一本书
  const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let standby = false; // 本页不是捕获主标签页（锁被别的标签页持有）

  // 目录快照（catatree 响应原样保存，随 zip 输出 <bid>_toc.json 供离线还原写书签）
  const tocState = { payload: null, bid: '', ok: false, err: '', ts: 0 };
  let tocBusy = null; // 进行中的目录抓取 Promise（防并发）
  let tocDeferred = false; // 暂停期间被挂起的目录抓取请求，恢复捕获后补抓

  // ---------------- 存储层：IndexedDB（失败降级内存 Map） ----------------
  const Store = {
    db: null,
    mem: null,
    init() {
      return new Promise((resolve) => {
        let idbf = (typeof indexedDB !== 'undefined' && indexedDB) || (window && window.indexedDB);
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow && !idbf) idbf = unsafeWindow.indexedDB;
        if (!idbf) { this.mem = new Map(); return resolve(); }
        let rq;
        try { rq = idbf.open('wq2pdf', 2); } catch (e) { this.mem = new Map(); return resolve(); }
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains('shots')) {
            const s = d.createObjectStore('shots', { keyPath: 'k' });
            s.createIndex('bid', 'bid', { unique: false });
          }
          if (!d.objectStoreNames.contains('toc')) {
            d.createObjectStore('toc', { keyPath: 'bid' }); // 每书一条目录快照
          }
        };
        rq.onsuccess = () => { this.db = rq.result; resolve(); };
        rq.onerror = () => { this.mem = new Map(); resolve(); };
        rq.onblocked = () => { this.mem = new Map(); resolve(); };
      });
    },
    put(rec) {
      if (this.mem) { this.mem.set(rec.k, rec); return Promise.resolve(); }
      return new Promise((res, rej) => {
        const tx = this.db.transaction('shots', 'readwrite');
        tx.objectStore('shots').put(rec);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    // 注意：index('bid').openCursor() 不带 KeyRange 会遍历全部书，必须限定 bid，
    // 否则不同书（多标签页各自打开的书）的切片会互相混入统计/打包/清空。
    keysByBid(bid) { // 只取主键，轻量
      if (this.mem) return Promise.resolve([...this.mem.keys()].filter((k) => k.indexOf(bid + '/') === 0));
      return new Promise((res, rej) => {
        const out = [];
        const tx = this.db.transaction('shots', 'readonly');
        const range = onlyRange(bid);
        const cur = range ? tx.objectStore('shots').index('bid').openKeyCursor(range)
                          : tx.objectStore('shots').index('bid').openKeyCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            const k = c.primaryKey;
            if (range || String(k).indexOf(bid + '/') === 0) out.push(k); // 无 KeyRange 时兜底过滤
            c.continue();
          } else res(out);
        };
        tx.onerror = () => rej(tx.error);
      });
    },
    allByBid(bid) {
      if (this.mem) return Promise.resolve([...this.mem.values()].filter((r) => r.bid === bid));
      return new Promise((res, rej) => {
        const out = [];
        const tx = this.db.transaction('shots', 'readonly');
        const range = onlyRange(bid);
        const cur = range ? tx.objectStore('shots').index('bid').openCursor(range)
                          : tx.objectStore('shots').index('bid').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            if (c.value && c.value.bid === bid) out.push(c.value);
            c.continue();
          } else res(out);
        };
        tx.onerror = () => rej(tx.error);
      });
    },
    clearByBid(bid) { // 只清这一本，绝不能清到别的书
      if (this.mem) { for (const k of [...this.mem.keys()]) if (k.indexOf(bid + '/') === 0) this.mem.delete(k); return Promise.resolve(); }
      return new Promise((res, rej) => {
        const tx = this.db.transaction('shots', 'readwrite');
        const range = onlyRange(bid);
        const cur = range ? tx.objectStore('shots').index('bid').openCursor(range)
                          : tx.objectStore('shots').index('bid').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            if (!range && c.value && c.value.bid !== bid) { c.continue(); return; } // 无 KeyRange 时兜底跳过他书
            c.delete();
            c.continue();
          } else res();
        };
        tx.onerror = () => rej(tx.error);
      });
    },
    clearAll() { // 清空全部书籍的切片与目录（当前书无缓存时由「清空缓存」按钮触发）
      if (this.mem) { this.mem.clear(); return Promise.resolve(); }
      return new Promise((res, rej) => {
        const tx = this.db.transaction(['shots', 'toc'], 'readwrite');
        tx.objectStore('shots').clear();
        tx.objectStore('toc').clear();
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    putToc(bid, payload) { // 目录快照持久化（与切片缓存独立：清空切片不影响已抓目录）
      if (this.mem) return Promise.resolve();
      return new Promise((res, rej) => {
        const tx = this.db.transaction('toc', 'readwrite');
        tx.objectStore('toc').put({ bid, payload, ts: Date.now() });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    getToc(bid) {
      if (this.mem) return Promise.resolve(null);
      return new Promise((res, rej) => {
        const tx = this.db.transaction('toc', 'readonly');
        const rq = tx.objectStore('toc').get(bid);
        rq.onsuccess = () => res(rq.result || null);
        tx.onerror = () => rej(tx.error);
      });
    },
  };

  // IDBKeyRange.only(bid)：限定只处理当前这本书（多标签页/多书同库时避免串数据）
  // 沙箱里可能取不到 IDBKeyRange，返回 null 时由调用方兜底过滤。
  function onlyRange(bid) {
    try {
      const KB = (typeof IDBKeyRange !== 'undefined' && IDBKeyRange) ||
                 (window && window.IDBKeyRange) ||
                 (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.IDBKeyRange);
      return (KB && KB.only) ? KB.only(bid) : null;
    } catch (e) { return null; }
  }

  // ---------------- 工具 ----------------
  function parsePx(v) {
    const m = /^(-?[\d.]+)px$/.exec(String(v || '').trim());
    return m ? parseFloat(m[1]) : NaN;
  }
  function readLeft(img) {
    let l = parsePx(img.style.left);
    if (isFinite(l)) return l;
    l = parseFloat(getComputedStyle(img).left);
    return isFinite(l) ? l : NaN;
  }
  function extOf(type) {
    type = String(type || '').toLowerCase();
    if (type.indexOf('png') >= 0) return 'png';
    if (type.indexOf('webp') >= 0) return 'webp';
    return 'jpg';
  }
  function pad(n, w) { return String(n).padStart(w, '0'); }

  // 解析切片 img：/deep/page/lmg/<bid>/<page>?k=...
  function parseSliceImg(img) {
    const src = img.getAttribute('src') || '';
    const m = /page\/lmg\/(\d+)\/(\d+)/i.exec(src);
    if (!m) return null;
    const page = parseInt(m[2], 10);
    const left = readLeft(img);
    if (!isFinite(left)) return null;
    const bid = m[1];
    if (!BOOK) { BOOK = bid; ensureToc(); }
    return { src, pathBid: bid, page, left, key: BOOK + '/' + page + '/' + Math.round(left * 10) };
  }

  // ---------------- 换书（URL bid 变化 → 记为新书，互不混淆） ----------------
  function urlBid() {
    return (new URLSearchParams(location.search).get('bid') || '').trim();
  }
  // 把记录归属切到新书：作废旧任务、重置内存统计，再从 IndexedDB 恢复该书历史计数
  async function switchBook(newBid) {
    if (newBid === BOOK) return;
    if (exporting) { pendingSwitchBid = newBid; toast('打包进行中，结束后自动切换到 ' + newBid); return; }
    BOOK = newBid;
    epoch++; // 作废旧书未执行的捕获任务
    captured.clear(); inflight.clear(); pageSlices.clear(); pageExpected.clear(); fpCounts.clear();
    stats.cache = stats.canvas = stats.failed = stats.lastExported = 0;
    tocState.payload = null; tocState.bid = ''; tocState.ok = false; tocState.err = ''; tocState.ts = 0;
    paused = false; pausedAuto = false; // 新书视为新会话，立即恢复捕获当前视口
    tocDeferred = false; // 换书后旧书的目录挂起请求作废
    await hydrateFromDb();
    scheduleScan(60);
    ensureToc();
    if (el.panel) { el.bid.textContent = BOOK; updatePanel(); }
    toast('书籍已切换 → ' + BOOK + '（旧书记录保留在缓存中）');
  }

  // ---------------- 多标签页：单页捕获锁（localStorage 心跳） ----------------
  const LOCK_KEY = 'wq2pdf:capture-owner';
  const LOCK_TTL = 6000; // 持有者超过 6s 未心跳（关页/崩溃）即可被抢占
  const LOCK_OK = (() => {
    try { localStorage.setItem('wq2pdf:probe', '1'); localStorage.removeItem('wq2pdf:probe'); return true; }
    catch (e) { return false; }
  })();
  function lockRead() {
    if (!LOCK_OK) return null;
    try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch (e) { return null; }
  }
  function lockWrite() {
    if (!LOCK_OK) return;
    try { localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: TAB_ID, ts: Date.now(), bid: BOOK })); }
    catch (e) { /* ignore */ }
  }
  function releaseLock() { // 关页时立即释放，让其它标签页尽快接管
    if (!LOCK_OK) return;
    try { const o = lockRead(); if (o && o.tab === TAB_ID) localStorage.removeItem(LOCK_KEY); }
    catch (e) { /* ignore */ }
  }
  // 本页是否处于「前台且被激活」：标签页可见 + 窗口有焦点
  function isFrontTab() {
    try { return document.visibilityState !== 'hidden' && !!document.hasFocus(); }
    catch (e) { return true; }
  }
  // 每 2s 心跳（也在 focus / visibilitychange 时立即调用）：
  //   激活的前台页 → 直接持有锁（后激活者覆盖先前的持有者，即「最后激活的前台页」捕获）；
  //   隐藏的标签页 → 立即让位；可见但未聚焦 → 若无人抢占则继续持有（避免点 DevTools 就停）。
  function refreshCaptureLock() {
    if (!LOCK_OK) { setStandby(false); return; } // 存储不可用 → 退化各抓各的（数据已按 bid 隔离）
    const cur = lockRead();
    const mine = !!(cur && cur.tab === TAB_ID);
    const fresh = !!(cur && Date.now() - (cur.ts || 0) < LOCK_TTL);
    let hidden = false;
    try { hidden = document.visibilityState === 'hidden'; } catch (e) { /* ignore */ }
    if (isFrontTab()) lockWrite();          // 激活页：无条件持有（抢占/续期）
    else if (hidden) { if (mine) releaseLock(); } // 转入后台：立刻让位给前台页
    else if (mine || !fresh) lockWrite();   // 可见未聚焦：没被别人抢占就继续持有
    const after = lockRead();
    setStandby(!(after && after.tab === TAB_ID));
  }
  // 捕获主/待命切换时联动暂停：
  //   失去主位（切到后台/被别的前台页接管）→ 若正在捕获则自动暂停（pausedAuto），
  //   重新成为主（切回前台/手动接管）→ 由切换引起的自动暂停直接恢复，手动暂停保留。
  function setStandby(v) {
    if (standby === v) return;
    const lost = standby && !v; // 从待命 → 主
    const demoted = !standby && v; // 从主 → 待命（让位）
    standby = v;
    if (demoted) {
      if (!paused) { paused = true; pausedAuto = true; }
    } else if (lost || v === false) {
      if (paused && pausedAuto) {
        paused = false; pausedAuto = false;
        notifyResumed(); // 恢复捕获：补抓暂停期间挂起的目录
      }
    }
    if (!standby) scheduleScan(60); // 接管后立刻抓当前视口
    updatePanel();
  }
  function takeOverCapture() { // 手动接管：立即抢占锁
    lockWrite();
    setStandby(false);
    toast('本页已接管捕获（其它标签页将待命）');
  }

  // ---------------- 目录（catatree 快照，随 zip 输出 <bid>_toc.json） ----------------
  function tocRootCount(payload) {
    const data = (payload && Array.isArray(payload.data)) ? payload.data : (Array.isArray(payload) ? payload : []);
    return data.length;
  }
  async function fetchCatalog(bid) {
    const r = await fetch('/deep/book/v1/catatree?bid=' + encodeURIComponent(bid), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('目录接口 HTTP ' + r.status);
    const payload = await r.json();
    const nodes = (payload && Array.isArray(payload.data)) ? payload.data : (Array.isArray(payload) ? payload : null);
    if (!nodes) throw new Error('目录响应缺少 data 数组');
    return payload; // 原样保留 {code,data:[...]}，还原脚本 extract_nodes 直接可读
  }
  // 保证 BOOK 对应的目录快照可用：内存 → IndexedDB → 网络（永不 reject）。
  // 暂停（paused）时不发起抓取，置 tocDeferred；恢复捕获后由 notifyResumed() 补抓。
  async function ensureToc(force) {
    const bid = BOOK;
    if (!bid) return;
    if (tocState.bid === bid && tocState.ok) { tocDeferred = false; return; } // 本会话已就绪
    if (paused && !force) { tocDeferred = true; return; } // 暂停中不主动抓；force=用户主动打包兜底
    if (tocBusy) { try { await tocBusy; } catch (e) { /* ignore */ } return; }
    tocBusy = (async () => {
      try {
        // 1) 持久化快照优先（刷新/重开页面不重复请求）
        const rec = await Store.getToc(bid).catch(() => null);
        if (rec && rec.payload) {
          tocState.payload = rec.payload; tocState.bid = bid;
          tocState.ok = true; tocState.err = ''; tocState.ts = rec.ts || Date.now();
          tocDeferred = false;
          updatePanel();
          return;
        }
        // 2) 网络抓取并落库
        const payload = await fetchCatalog(bid);
        tocState.payload = payload; tocState.bid = bid;
        tocState.ok = true; tocState.err = ''; tocState.ts = Date.now();
        tocDeferred = false;
        Store.putToc(bid, payload).catch(() => { /* 持久化失败不影响本次 */ });
        updatePanel();
      } catch (e) {
        tocState.err = (e && e.message) ? e.message : String(e);
        updatePanel();
      } finally {
        tocBusy = null;
      }
    })();
    try { await tocBusy; } catch (e) { /* ignore */ }
  }
  // 捕获恢复（paused→false）后调用：补抓暂停期间被挂起的目录
  function notifyResumed() {
    if (tocDeferred) { tocDeferred = false; ensureToc(); }
  }

  // ---------------- 取字节（零网络请求） ----------------
  function canvasBlob(img) {
    return new Promise((res) => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => res(b), 'image/jpeg', CFG.jpegQuality);
      } catch (e) { res(null); }
    });
  }
  function fingerprint(img) { // 16×16 缩略图 FNV-1a，用于识别重复占位图
    try {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, 16, 16);
      const d = x.getImageData(0, 0, 16, 16).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      return h >>> 0;
    } catch (e) { return 0; }
  }

  // ---------------- 捕获引擎 ----------------
  function enqueue(job) {
    job.epoch = epoch;
    inflight.add(job.key);
    captureChain = captureChain.then(() => captureOne(job)).catch((err) => {
      console.warn('[wq2pdf] capture failed:', job.key, err);
      inflight.delete(job.key);
    });
  }

  async function captureOne(job) {
    if (job.epoch !== epoch) return; // 清空缓存后作废的旧任务
    const img = job.img;
    if (!(img.complete && img.naturalWidth > 0)) { inflight.delete(job.key); return; } // 未就绪，等下轮扫描

    // 1) 只读 HTTP 缓存（从不发包，命中即无损原始字节）
    let blob = null, ext = null, via = '';
    try {
      const r = await fetch(job.src, { cache: 'only-if-cached', mode: 'same-origin' });
      if (r && r.ok) {
        const b = await r.blob();
        if (b && b.size > 256) { blob = b; ext = extOf(b.type); via = 'cache'; }
      }
    } catch (e) { /* 缓存不可用（no-store 等），走 canvas */ }

    // 2) canvas 兜底
    if (!blob) {
      blob = await canvasBlob(img);
      if (blob && blob.size > 256) { ext = 'jpg'; via = 'canvas'; } else blob = null;
    }
    if (!blob) { inflight.delete(job.key); stats.failed++; updatePanel(); return; }

    const fp = fingerprint(img);
    const rec = {
      k: job.key, bid: BOOK, page: job.page, left: job.left,
      transform: job.transform, sliceCount: job.sliceCount, fp,
      w: img.naturalWidth, h: img.naturalHeight, ext, blob, ts: Date.now(),
    };
    try { await Store.put(rec); }
    catch (e) { inflight.delete(job.key); stats.failed++; updatePanel(); return; }

    inflight.delete(job.key);
    captured.add(job.key);
    stats[via]++;
    if (!pageSlices.has(job.page)) pageSlices.set(job.page, new Set());
    pageSlices.get(job.page).add(job.left);
    if (job.sliceCount > (pageExpected.get(job.page) || 0)) pageExpected.set(job.page, job.sliceCount);
    if (fp) fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
    updatePanel();
  }

  function tryCapture(img) {
    if (paused || standby) return; // standby：锁被别的标签页持有，本页不捕获
    const info = parseSliceImg(img);
    if (!info) return;
    if (!(img.complete && img.naturalWidth > 0)) return; // 未加载完，等 load/下轮
    if (captured.has(info.key) || inflight.has(info.key)) return;

    // 变换方式：优先 .plg 内联 transform；缺省按 .page_sl 宽高比推断
    const plg = img.closest('.plg');
    let transform = (plg && plg.style && plg.style.transform) || '';
    if (!transform) {
      const psl = img.closest('.page_sl');
      if (psl && psl.style) {
        const w = parseFloat(psl.style.width) || 0, h = parseFloat(psl.style.height) || 0;
        if (w && h) transform = w > h ? 'matrix(0, -1, 1, 0, 0, 0)' : 'matrix(-1, 0, 0, -1, 0, 0)';
      }
    }
    const sliceCount = plg ? plg.querySelectorAll('img[src*="page/lmg/"]').length : 0;
    enqueue({
      img, src: info.src, key: info.key, page: info.page,
      left: info.left, transform, sliceCount,
    });
  }

  function scan() {
    const imgs = document.querySelectorAll('img[src*="page/lmg/"]');
    for (const img of imgs) tryCapture(img);
    updatePanel();
  }

  // MutationObserver：节点一出现就抓（切片会随滚动被销毁，必须抢时间）
  let scanTimer = null;
  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, delay);
  }
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { scheduleScan(60); return; }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG' || (n.querySelector && n.querySelector('img[src*="page/lmg/"]'))) { scheduleScan(60); return; }
      }
    }
  });

  window.addEventListener('scroll', () => {
    lastScroll = performance.now();
    // 暂停后滚动不自动恢复（与手动暂停一致），需点 ▶ 或开启自动滚动
  }, { passive: true, capture: true });
  // 图片 load 完成（不触发 MutationObserver），立刻安排补抓
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && (t.getAttribute('src') || '').indexOf('page/lmg/') >= 0) scheduleScan(60);
  }, true);

  // ---------------- UI 面板 ----------------
  let el = {};
  function mountPanel() {
    if (document.getElementById('wq2pdf-panel')) return;
    const style = document.createElement('style');
    style.textContent = [
      '#wq2pdf-panel{position:fixed;left:12px;bottom:12px;z-index:2147483000;font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e8eaf0;background:rgba(22,25,32,.93);border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.45);padding:8px 10px;min-width:216px;user-select:none}',
      '#wq2pdf-panel .hd{display:flex;align-items:center;gap:6px;font-weight:600}',
      '#wq2pdf-panel .bid{color:#7aa2ff;font-weight:400;font-size:11px}',
      '#wq2pdf-panel .fold{margin-left:auto;cursor:pointer;padding:0 4px;color:#9aa3b2}',
      '#wq2pdf-panel .stats{margin-top:6px;font-size:11px;color:#c3cad6}',
      '#wq2pdf-panel .warn{margin-top:4px;font-size:11px;color:#ffd166}',
      '#wq2pdf-panel .paused{margin-top:4px;font-size:11px;color:#9aa3b2}',
      '#wq2pdf-panel .standby{margin-top:4px;font-size:11px;color:#9aa3b2;cursor:pointer;text-decoration:underline dotted}',
      '#wq2pdf-panel .standby:hover{color:#c3cad6}',
      '#wq2pdf-panel .row{display:flex;align-items:center;gap:6px;margin-top:8px}',
      '#wq2pdf-panel .row button{flex:1 0 auto;white-space:nowrap}',
      '#wq2pdf-panel button{font:inherit;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;color:#fff;background:#3b4354}',
      '#wq2pdf-panel button:hover{background:#49536a}',
      '#wq2pdf-panel button.primary{background:#2f6fed}',
      '#wq2pdf-panel button.primary:disabled{opacity:.6;cursor:wait}',
      '#wq2pdf-panel button.toggle.on{background:#2e9e5b}',
      '#wq2pdf-panel button.clear{background:#6b3a45}',
      '#wq2pdf-panel button.clear:hover{background:#824450}',
      '#wq2pdf-panel button.clear.armed{background:#6e1020;color:#ffd7dc}',
      '#wq2pdf-panel button.clear.armed:hover{background:#8c1b2e}',
      // 暂停/继续按钮：运行(继续)态为圆角方形双竖线；暂停态为圆形 ▶（仅形状切换，颜色一致）
      '#wq2pdf-panel button.pause{flex:0 0 auto;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center}',
      '#wq2pdf-panel button.pause::before{content:\'\';display:block;width:10px;height:12px;background:linear-gradient(90deg,#fff 0 3px,transparent 3px 7px,#fff 7px)}',
      '#wq2pdf-panel button.pause.round{border-radius:50%}',
      '#wq2pdf-panel button.pause.round::before{content:\'\';width:0;height:0;margin-left:3px;background:none;border:7px solid transparent;border-left:11px solid #fff;border-right:0}',
      '#wq2pdf-panel.folded .bd{display:none}',
    ].join('\n');
    document.head.appendChild(style);

    const p = document.createElement('div');
    p.id = 'wq2pdf-panel';
    p.innerHTML = [
      '<div class="hd">📚 wq2pdf<span class="bid"></span><span class="fold" title="折叠/展开">—</span></div>',
      '<div class="bd">',
      '  <div class="stats">已捕获 <b class="pv">0</b> 页 / <b class="sv">0</b> 片<span class="mode"></span></div>',
      '  <div class="warn" style="display:none"></div>',
      '  <div class="paused" style="display:none">⏸ 捕获已暂停</div>',
      '  <div class="standby" style="display:none" title="点击由本页接管捕获">⏳ 另有标签页正在捕获，本页待命（点此接管）</div>',
      '  <div class="row">',
      '    <button class="pause" title="暂停捕获"></button>',
      '    <button class="primary">📦 打包下载</button>',
      '  </div>',
      '  <div class="row">',
      '    <button class="clear">🧹 清空缓存</button>',
      '    <button class="toggle">⏬ 自动滚动</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(p);

    el = {
      panel: p,
      bid: p.querySelector('.bid'),
      pv: p.querySelector('.pv'),
      sv: p.querySelector('.sv'),
      mode: p.querySelector('.mode'),
      warn: p.querySelector('.warn'),
      pausedEl: p.querySelector('.paused'),
      standbyEl: p.querySelector('.standby'),
      fold: p.querySelector('.fold'),
      exportBtn: p.querySelector('.primary'),
      autoBtn: p.querySelector('.toggle'),
      clearBtn: p.querySelector('.clear'),
      pauseBtn: p.querySelector('.pause'),
    };
    el.bid.textContent = BOOK || '…';
    el.fold.addEventListener('click', () => {
      p.classList.toggle('folded');
      el.fold.textContent = p.classList.contains('folded') ? '+' : '—';
    });
    el.exportBtn.addEventListener('click', () => doExport());
    el.autoBtn.addEventListener('click', () => setAutoScroll(!autoTimer));
    el.clearBtn.addEventListener('click', () => onClearClick());
    el.clearBtn.addEventListener('mouseleave', () => disarmClear()); // armed 提示后移开鼠标 → 恢复
    el.pauseBtn.addEventListener('click', () => togglePause());
    el.standbyEl.addEventListener('click', () => takeOverCapture());
    updatePanel();
  }

  function updatePanel() {
    if (!el.panel) return;
    let slices = 0;
    for (const s of pageSlices.values()) slices += s.size;
    el.pv.textContent = pageSlices.size;
    el.sv.textContent = slices;
    const parts = [];
    if (stats.cache) parts.push('缓存×' + stats.cache);
    if (stats.canvas) parts.push('canvas×' + stats.canvas);
    if (stats.failed) parts.push('失败×' + stats.failed);
    if (tocState.ok) parts.push('目录' + tocRootCount(tocState.payload) + '项');
    else if (tocBusy) parts.push('目录获取中…');
    else if (tocState.err) parts.push('目录获取失败');
    el.mode.textContent = parts.length ? ' · ' + parts.join(' ') : '';

    let susp = 0;
    for (const c of fpCounts.values()) if (c > CFG.fpWarnThreshold) susp += c;
    let incomplete = 0;
    for (const [pg, set] of pageSlices) {
      const exp = pageExpected.get(pg) || 0;
      if (exp > set.size) incomplete++;
    }
    if (susp || incomplete) {
      el.warn.style.display = '';
      el.warn.textContent = '⚠' + (susp ? ' 疑似限速占位图 ' + susp + ' 片' : '') + (incomplete ? ' · ' + incomplete + ' 页缺片' : '');
    } else {
      el.warn.style.display = 'none';
    }
    const showPaused = paused && !standby; // 自动暂停（切走）随待命行展示，避免两行重复
    el.pausedEl.style.display = showPaused ? '' : 'none';
    el.pausedEl.textContent = showPaused ? '⏸ 已暂停捕获：点 ▶ 或开启自动滚动恢复' : '';
    if (el.standbyEl) el.standbyEl.style.display = standby ? '' : 'none';
    refreshPauseBtn();
  }

  // 暂停/继续捕获：暂停后点 ▶ 恢复（并立刻抓当前视口）；手动操作即非「切走自动暂停」
  function togglePause() {
    if (standby) { takeOverCapture(); return; } // 待命时点 ▶ = 由本页接管
    if (paused) {
      paused = false; pausedAuto = false;
      notifyResumed(); // 恢复捕获：补抓暂停期间挂起的目录
      scheduleScan(60); // 恢复后立刻抓当前视口
      toast('已恢复捕获');
    } else {
      paused = true; pausedAuto = false;
      toast('已暂停捕获（点 ▶ 继续）');
    }
    updatePanel();
  }

  function refreshPauseBtn() {
    if (!el.pauseBtn) return;
    el.pauseBtn.classList.toggle('round', paused); // 暂停→圆形 ▶；继续→圆角方形 ⏸（CSS 图标）
    el.pauseBtn.title = paused ? '继续捕获' : '暂停捕获';
  }

  function setExportBtn(text, disabled) {
    if (!el.exportBtn) return;
    el.exportBtn.disabled = !!disabled;
    el.exportBtn.textContent = text || '📦 打包下载';
  }

  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483000;background:rgba(22,25,32,.95);color:#e8eaf0;padding:8px 14px;border-radius:8px;font:13px/1.4 -apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);max-width:80vw';
    document.body.appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; }, 2400);
    setTimeout(() => d.remove(), 2900);
  }

  // ---------------- 自动滚动 ----------------
  function getScroller() {
    const cand = [
      document.querySelector('#scroll'),
      document.querySelector('.page-m'),
      document.scrollingElement,
      document.documentElement,
    ].filter(Boolean);
    for (const c of cand) if (c.scrollHeight > c.clientHeight + 40) return c;
    return document.scrollingElement || document.documentElement;
  }

  function setAutoScroll(on, msg) {
    if (on && !autoTimer) {
      if (paused) { // 开启自动滚动即恢复捕获（任何暂停来源）
        paused = false; pausedAuto = false;
        notifyResumed(); // 恢复捕获：补抓暂停期间挂起的目录
        updatePanel();
      }
      autoTimer = setInterval(autoTick, CFG.autoScrollInterval);
      if (el.autoBtn) { el.autoBtn.classList.add('on'); el.autoBtn.textContent = '⏸ 停止滚动'; }
    } else if (!on && autoTimer) {
      clearInterval(autoTimer); autoTimer = null;
      if (el.autoBtn) { el.autoBtn.classList.remove('on'); el.autoBtn.textContent = '⏬ 自动滚动'; }
      if (msg) toast(msg);
    }
    autoWait = 0; autoStuck = 0;
  }

  function autoTick() {
    if (standby) return; // 待命标签页不滚动（避免白滚且干扰主标签页）
    const sc = getScroller();
    if (!sc) return;
    const imgs = document.querySelectorAll('img[src*="page/lmg/"]');
    let ready = true, handled = true;
    for (const img of imgs) {
      if (img.complete && img.naturalWidth > 0) {
        const info = parseSliceImg(img);
        if (info && !captured.has(info.key) && !inflight.has(info.key)) handled = false;
      } else ready = false;
    }
    if (!(ready && handled)) {
      if (++autoWait > CFG.autoScrollWaitMax) autoWait = 0; // 等太久就硬滚，防止卡死
      else return;
    }
    autoWait = 0;
    const before = sc.scrollTop;
    const step = Math.round(sc.clientHeight * CFG.autoScrollStepRatio);
    try { sc.scrollBy({ top: step, behavior: 'smooth' }); }
    catch (e) { sc.scrollTop = before + step; }
    setTimeout(() => {
      if (Math.abs(sc.scrollTop - before) < 4) {
        if (++autoStuck >= 3) setAutoScroll(false, '已滚动到底，自动停止');
      } else autoStuck = 0;
      scan();
    }, 700);
  }

  // ---------------- ZIP（自写 STORE 模式，无依赖） ----------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // entries: [{name, data: Blob|Uint8Array}]
  async function buildZip(entries, onProgress) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const data = (e.data instanceof Uint8Array) ? e.data : new Uint8Array(await e.data.arrayBuffer());
      const name = enc.encode(e.name);
      const crc = crc32(data);

      const lh = new Uint8Array(30 + name.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);  // local file header signature
      dv.setUint16(4, 20, true);          // version needed
      dv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
      dv.setUint16(8, 0, true);           // method: STORE
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true); // compressed size
      dv.setUint32(22, data.length, true); // uncompressed size
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);           // extra len
      lh.set(name, 30);
      chunks.push(lh, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);  // central directory signature
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);      // flags: UTF-8
      cv.setUint16(10, 0, true);          // method: STORE
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);          // extra len
      cv.setUint16(32, 0, true);          // comment len
      cv.setUint16(34, 0, true);          // disk start
      cv.setUint16(36, 0, true);          // internal attrs
      cv.setUint32(38, 0, true);          // external attrs
      cv.setUint32(42, offset, true);     // local header offset
      cd.set(name, 46);
      central.push(cd);

      offset += lh.length + data.length;
      if (onProgress && (i % 20 === 0 || i === entries.length - 1)) onProgress(i + 1, entries.length);
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);   // EOCD signature
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...chunks, ...central, eocd], { type: 'application/zip' });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    // 大 zip（可能数百 MB）下载耗时，10 分钟后再回收
    const cleanup = () => setTimeout(() => URL.revokeObjectURL(url), 600000);
    const anchor = () => {
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      cleanup();
    };
    if (typeof GM_download === 'function') {
      try {
        GM_download({ url, name, saveAs: false, onerror: () => anchor(), ontimeout: () => anchor() });
        cleanup(); // GM 侧已接管则回收；失败回退会重新创建，无需额外处理
        return;
      } catch (e) { /* 落回 anchor */ }
    }
    anchor();
  }

  // ---------------- 导出 ----------------
  async function doExport() {
    if (exporting) return;
    if (!BOOK) { toast('未识别到书籍编号（bid）'); return; }
    const recs = await Store.allByBid(BOOK);
    if (!recs.length) { toast('还没有捕获到切片，先滚动几页'); return; }

    exporting = true;
    setExportBtn('打包中…', true);
    try {
      // 按页分组
      const pages = new Map();
      for (const r of recs) {
        if (!pages.has(r.page)) pages.set(r.page, []);
        pages.get(r.page).push(r);
      }
      const pageNos = [...pages.keys()].sort((a, b) => a - b);

      const enc = new TextEncoder();
      const csv = ['\uFEFF页码,变换方式'];
      const entries = [];
      const warnLines = [];

      for (const p of pageNos) {
        const arr = pages.get(p).slice().sort((a, b) => a.left - b.left); // left 升序 = 显示序
        const N = arr.length;
        arr.forEach((r, i) => { r.d = i + 1; }); // 显示序 = left 升序 rank，用于文件名后缀
        csv.push(p + ',"' + (arr[0].transform || 'none') + '"');
        for (const r of arr) {
          entries.push({
            name: 'img/p' + pad(p, 4) + '_' + pad(r.d, 2) + '.' + (r.ext || 'jpg'),
            data: r.blob,
          });
        }
        // 缺片检测：观测到的切片总数 vs 实际捕获数
        const expected = Math.max(0, ...arr.map((r) => r.sliceCount || 0));
        if (expected > N) warnLines.push('第 ' + p + ' 页疑似缺片：已捕获 ' + N + ' / 观测到 ' + expected + ' 片');
      }

      // 限速占位图检测：同一指纹出现过多
      const cnt = new Map();
      for (const r of recs) if (r.fp) cnt.set(r.fp, (cnt.get(r.fp) || 0) + 1);
      const bad = new Set([...cnt.entries()].filter(([, c]) => c > CFG.fpWarnThreshold).map(([f]) => f));
      if (bad.size) {
        warnLines.push('以下切片内容高度重复，疑似被限速返回的占位图（建议放慢滚动后重抓）：');
        for (const p of pageNos) for (const r of pages.get(p)) {
          if (bad.has(r.fp)) warnLines.push('  img/p' + pad(p, 4) + '_' + pad(r.d, 2) + '.' + (r.ext || 'jpg'));
        }
      }

      if (warnLines.length) {
        entries.push({ name: 'WARNING.txt', data: enc.encode('wq2pdf 导出提示\r\n\r\n' + warnLines.join('\r\n') + '\r\n') });
      }
      await ensureToc(true); // 打包兜底：用户主动打包，暂停中也抓目录（保证 zip 带书签数据）
      if (tocState.ok && tocState.bid === BOOK && tocState.payload) {
        // 与还原脚本缓存文件同名 <bid>_toc.json，解压即被优先采用
        entries.unshift({ name: BOOK + '_toc.json', data: enc.encode(JSON.stringify(tocState.payload)) });
      }
      entries.unshift({ name: BOOK + '.csv', data: enc.encode(csv.join('\r\n') + '\r\n') });

      const zip = await buildZip(entries, (i, t) => setExportBtn('打包中 ' + i + '/' + t, true));
      downloadBlob(zip, BOOK + '.zip');
      stats.lastExported = recs.length;
      const tocNote = tocState.ok
        ? '，目录 ' + tocRootCount(tocState.payload) + ' 项'
        : (paused
          ? '，⚠ 暂停中未抓目录（zip 无 ' + BOOK + '_toc.json；恢复捕获后重新打包即有书签）'
          : (tocState.err ? '，⚠ 目录未获取到（zip 无 ' + BOOK + '_toc.json，PDF 将无书签）' : ''));
      toast('已打包 ' + pageNos.length + ' 页 / ' + recs.length + ' 片 → ' + BOOK + '.zip' + tocNote);
    } catch (e) {
      console.error('[wq2pdf] export failed:', e);
      toast('打包失败：' + (e && e.message ? e.message : e));
    } finally {
      exporting = false;
      setExportBtn(null, false);
      if (pendingSwitchBid && pendingSwitchBid !== BOOK) {
        const b = pendingSwitchBid; pendingSwitchBid = null;
        switchBook(b); // 导出期间请求的换书，结束后补执行
      }
    }
  }

  // ---------------- 清空缓存 ----------------
  // 「清全部」走按钮内两步确认：第一步点击进入 armed（文字提示 + 颜色加深），
  // 第二步点击才真正执行；鼠标移开自动解除 armed 恢复原状（防误触）。
  function setClearArmed(v) {
    if (!el.clearBtn) return;
    el.clearBtn.classList.toggle('armed', v);
    el.clearBtn.textContent = v ? '⚠ 再次点击清除全部缓存' : '🧹 清空缓存';
  }
  function disarmClear() { setClearArmed(false); }

  async function onClearClick() {
    if (!BOOK) { toast('未识别到书籍编号（bid）'); return; }
    if (el.clearBtn && el.clearBtn.classList.contains('armed')) {
      // 第二次点击：确认执行「清除全部」
      setClearArmed(false);
      await doClearCache(true);
      return;
    }
    // 当前书没有缓存 → 进入 armed（不执行）；有缓存则保持原 confirm 弹窗只清本书
    let keys = [];
    try { keys = await Store.keysByBid(BOOK); } catch (e) { keys = []; }
    if (keys.length === 0) { setClearArmed(true); return; }
    if (!confirm('确定清空 ' + BOOK + ' 已捕获的切片缓存？此操作不可恢复')) return;
    await doClearCache(false);
  }

  async function doClearCache(all) {
    setAutoScroll(false);
    if (all) {
      await Store.clearAll();
      tocState.payload = null; tocState.bid = ''; tocState.ok = false; tocState.err = ''; tocState.ts = 0;
    } else {
      await Store.clearByBid(BOOK);
    }
    captured.clear(); inflight.clear(); pageSlices.clear(); pageExpected.clear(); fpCounts.clear();
    stats.cache = stats.canvas = stats.failed = stats.lastExported = 0;
    epoch++;   // 作废队列中未执行的旧捕获任务
    paused = true; // 挂起捕获（与手动暂停一致）：点 ▶ 或开启自动滚动才恢复
    pausedAuto = false;
    updatePanel();
    if (all) ensureToc(); // 目录快照也被清掉了；若处于暂停则延后，恢复捕获后自动补抓
    toast(all
      ? '已清空全部书籍的捕获缓存；点 ▶ 或开启自动滚动后恢复捕获'
      : '已清空 ' + BOOK + ' 的捕获缓存；点 ▶ 或开启自动滚动后恢复捕获');
  }

  // 油猴菜单入口：没有按钮 hover 语义，清全部仍用 confirm 弹窗确认
  async function clearFromMenu() {
    if (!BOOK) { toast('未识别到书籍编号（bid）'); return; }
    let keys = [];
    try { keys = await Store.keysByBid(BOOK); } catch (e) { keys = []; }
    const all = keys.length === 0;
    const msg = all
      ? '当前书籍（' + BOOK + '）没有缓存。是否清空全部书籍的捕获缓存与目录？此操作不可恢复'
      : '确定清空 ' + BOOK + ' 已捕获的切片缓存？此操作不可恢复';
    if (!confirm(msg)) return;
    await doClearCache(all);
  }

  // ---------------- 初始化 ----------------
  async function hydrateFromDb() { // 从 IndexedDB 恢复计数（跨刷新）
    try {
      const keys = await Store.keysByBid(BOOK);
      for (const k of keys) {
        const seg = k.split('/');
        const page = parseInt(seg[1], 10);
        const left = parseInt(seg[2], 10) / 10;
        if (!isFinite(page)) continue;
        if (!pageSlices.has(page)) pageSlices.set(page, new Set());
        pageSlices.get(page).add(left);
        captured.add(k);
      }
    } catch (e) { console.warn('[wq2pdf] hydrate failed:', e); }
  }

  async function init() {
    await Store.init();
    if (BOOK) await hydrateFromDb();
    if (BOOK) ensureToc(); // 页面打开即同步抓目录；URL 无 bid 时由首个切片回填后触发

    // 轮询 URL bid：同一标签页内换书（pushState/replaceState 不触发整页刷新）→ 切换记录归属
    setInterval(() => {
      const b = urlBid();
      if (b && b !== lastUrlBid) {
        lastUrlBid = b;
        if (b !== BOOK) switchBook(b);
      }
    }, 1000);

    // SPA：等 #pb / .page-img-box 挂载后再放面板
    const mountPoll = setInterval(() => {
      if (document.querySelector('.page-img-box') || document.querySelector('#pb')) {
        clearInterval(mountPoll);
        mountPanel();
      }
    }, 500);
    setTimeout(() => clearInterval(mountPoll), 120000);

    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

    // 兜底定时扫描（滚动刚发生后跳过，避免拖垮渲染）
    setInterval(() => {
      if (document.hidden) return;
      if (performance.now() - lastScroll < CFG.scanQuietAfterScroll) return;
      if (el.panel && !el.panel.isConnected && document.body) document.body.appendChild(el.panel); // SPA 重渲染后补挂
      scan();
    }, CFG.scanInterval);

    // 多标签页：单页捕获锁（2s 心跳；关页立即释放，让其它标签页接管）
    refreshCaptureLock();
    setInterval(refreshCaptureLock, 2000);
    // 切标签页/切窗口：最后激活的前台页立即接管捕获（不等心跳）
    const onActiveChange = () => refreshCaptureLock();
    document.addEventListener('visibilitychange', onActiveChange);
    window.addEventListener('focus', onActiveChange);
    window.addEventListener('blur', onActiveChange);

    // 有未导出的捕获时，关页前提醒
    window.addEventListener('beforeunload', (e) => {
      releaseLock();
      let total = 0;
      for (const s of pageSlices.values()) total += s.size;
      if (total > 0 && total !== stats.lastExported) { e.preventDefault(); e.returnValue = ''; }
    });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('📦 立即打包下载', () => doExport());
      GM_registerMenuCommand('🧹 清空本书捕获缓存', () => clearFromMenu());
    }
  }

  // 控制台调试句柄：__wq2pdf.info() / await __wq2pdf.magics()
  // 注意：@grant 模式下 window 是沙箱代理，必须挂 unsafeWindow（真页面 window）控制台才可见
  try {
    const dbg = {
      version: '1.0.1',
      bid: () => BOOK,
      info() {
        return {
          version: this.version, bid: BOOK, pages: pageSlices.size, slices: captured.size, via: { ...stats },
          tab: TAB_ID.slice(-4), standby, lockOk: LOCK_OK,
          toc: tocState.ok ? { ok: true, items: tocRootCount(tocState.payload), ts: tocState.ts }
                           : { ok: false, err: tocState.err || (tocBusy ? 'fetching' : 'not started') },
        };
      },
      // 魔数识别：统计缓存切片的真实容器格式（webp/png/jpeg/gif/other）
      async magics() {
        if (!BOOK) return { error: '未识别到 bid' };
        const recs = await Store.allByBid(BOOK);
        const m = { webp: 0, png: 0, jpeg: 0, gif: 0, other: 0, total: recs.length, samples: [] };
        for (const r of recs) {
          const u8 = new Uint8Array(await r.blob.arrayBuffer());
          const hex = (n) => Array.from(u8.slice(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          let k;
          if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) k = 'webp';
          else if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) k = 'png';
          else if (u8[0] === 0xFF && u8[1] === 0xD8) k = 'jpeg';
          else if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) k = 'gif';
          else k = 'other';
          m[k]++;
          if (m.samples.length < 5 && (k === 'other' || m.samples.length === 0)) {
            m.samples.push('p' + r.page + ' ' + k + ' ' + u8.length + 'B [' + hex(12) + ']');
          }
        }
        m.ct = recs.length ? recs[0].type || '' : '';
        return m;
      },
    };
    const target = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    target.__wq2pdf = dbg;
    if (target !== window) window.__wq2pdf = dbg; // 沙箱内也能用
  } catch (e) { /* 调试句柄失败不影响主功能 */ }

  init();
})();
