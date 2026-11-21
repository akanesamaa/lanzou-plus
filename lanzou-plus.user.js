// ==UserScript==
// @name         Lanzou++
// @namespace    https://github.com/akanesamaa/lanzou-plus
// @version      1.0.2
// @description  蓝奏云文件夹批量下载：顶部命令条、全选/搜索、自动加载全部；桌面专用
// @author       akanesamaa
// @license      MIT
// @homepageURL  https://github.com/akanesamaa/lanzou-plus
// @supportURL   https://github.com/akanesamaa/lanzou-plus/issues
// @downloadURL  https://raw.githubusercontent.com/akanesamaa/lanzou-plus/main/lanzou-plus.user.js
// @updateURL    https://raw.githubusercontent.com/akanesamaa/lanzou-plus/main/lanzou-plus.user.js
// @include      *://*.lanzou*/*
// @include      *://lanzou*/*
// @include      *://*.lanzt.com/*
// @include      *://lanzt.com/*
// @include      *://*.lanzn.com/*
// @include      *://lanzn.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Implementation notes: docs/internals.md



  // Core constants
  const NAME = 'Lanzou++';

  const VERSION = '1.0.2';
  const DOWNLOAD_GAP = 1500;
  const WIN_CLOSE_DELAY = 10000;



  // Direct URLs expire quickly; reuse only within a short window
  const DIRECT_TTL = 10 * 60 * 1000;

  const ACCENT = '#0a5fbf';
  const ACCENT_SOFT = '#e8f3fd';



  const PWD_INPUT_SEL = '#pwd, input[name="pwd"], input.passwdinput, input[type="password"]';


  const isTouch = (function () {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
    catch (e) { return false; }
  })();


  const canHover = (function () {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches); }
    catch (e) { return false; }
  })();


  const DISABLE_ON_TOUCH = isTouch && !canHover;



  const IS_GECKO = /Firefox\//.test(navigator.userAgent || '');



  const FILE_EXT = 'zip|rar|7z|tar|gz|bz2|xz|zst|tgz|cab|part\\d+\\.rar|\\d{3}|' +
    'apk|exe|msi|dmg|iso|img|txt|pdf|docx?|xlsx?|pptx?|epub|mobi|azw3?|' +
    'mp[34]|m4a|flac|wav|mkv|avi|flv|wmv|mov|heic|avif|' +
    'jpg|jpeg|png|gif|webp|svg|psd|ai|c4d|blend|fbx|obj|' +
    'bin|ipa|deb|rpm|jar|whl|py|html?|ttf|otf|woff2?|json|xml|csv|md|torrent|chm';
  const FILE_NAME_RE = new RegExp('\\.(' + FILE_EXT + ')$', 'i');



  const TIME_SRC = '昨天|前天|今天|刚刚|\\d{1,2}:\\d{2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-\\d{1,2}|' +
    '\\d+\\s*(?:秒|分钟|小时|天|周|个?月|年)\\s*前';






  const SIZE_RE = /\d+(?:[.,]\d+)*\s*[KMGT]B?(?![A-Za-z])/i;
  const TIME_RE = new RegExp('(?:' + TIME_SRC + ')');



  const TAIL_TIME_RE = new RegExp('\\s*(?:(?:' + TIME_SRC + ')\\s*)+$');
  const TAIL_SIZE_RE = /\s*\d+(?:[.,]\d+)*\s*[KMGT]B?\s*$/i;


  const BLOCK_TEXT_RE = /(一键转存|转存到|保存到.*网盘|存到网盘|我的网盘)/;
  const BLOCK_HREF_RE = /(ilanzou\.com|\/unproved\/|pd\/url)/i;



  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debounce = (fn, wait) => {
    let timer = 0;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };
  const log = (...args) => console.log('%c[' + NAME + ']', 'color:#5f6368;font-weight:700', ...args);



  const items = new Map();          // key -> { key,label,checked,anchor,row,cb,size,direct,directAt,error }
  const cbItem = new WeakMap();
  const anchorItem = new WeakMap();
  const state = {
    running: false, stop: false, lastTp: '',
    prog: { done: 0, total: 0 },
    loading: false,
    loadPending: false,
    loadStop: false,
    autoLoadTried: false,
    noMore: false,
    lastPage: null,
    pagePending: false,
    pageGap: 1800,
  };





  function fileNameOf(text) {
    let t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 200) return '';
    for (let i = 0; i < 4; i++) {
      const before = t;
      t = t.replace(TAIL_TIME_RE, '').replace(TAIL_SIZE_RE, '').trim();
      if (t === before) break;
    }
    return FILE_NAME_RE.test(t) ? t : '';
  }



  function nameTextOf(a) {
    let s = '';
    for (let n = a.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) s += n.nodeValue;
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s || (a.textContent || '').replace(/\s+/g, ' ').trim();
  }


  const TRUNC_RE = /(?:\.\.\.|…)\s*$/;


  function hasFileIcon(a) {
    const img = a.querySelector('img');
    if (img && /filetype\//i.test(img.getAttribute('src') || '')) return true;
    return /^\/?i[0-9A-Za-z_-]{5,}$/.test((a.getAttribute('href') || '').trim());
  }






  const nameCache = new WeakMap();

  function nameOfAnchor(a) {
    const raw = nameTextOf(a);
    const hit = nameCache.get(a);
    if (hit && hit.raw === raw) return hit.name;
    const n = fileNameOf(raw);
    if (n) {
      nameCache.set(a, { raw: raw, name: n });
      return n;
    }



    if (TRUNC_RE.test(raw) && raw.length > 4 && hasFileIcon(a)) {
      nameCache.set(a, { raw: raw, name: raw });
      return raw;
    }
    return '';
  }

  function countFileAnchors(el, cap) {
    const list = el.querySelectorAll('a');
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (nameOfAnchor(list[i])) {
        n++;

        if (cap && n > cap) return n;
      }
    }
    return n;
  }



  function normRowText(row) {
    return String((row && row.textContent) || '').replace(/\s+/g, ' ').trim();
  }



  const FULL_SIZE_RE = /^\d+(?:[.,]\d+)*\s*[KMGT]B?$/i;
  const FULL_TIME_RE = new RegExp('^(?:' + TIME_SRC + ')$');

  function hasMeta(el) {
    const list = el.querySelectorAll ? el.querySelectorAll('span, div, em, i, b') : [];
    for (let i = 0; i < list.length; i++) {
      const t = (list[i].textContent || '').trim();
      if (!t || t.length > 32) continue;
      if (FULL_SIZE_RE.test(t) || FULL_TIME_RE.test(t)) return true;
    }
    return false;
  }



  const rowCache = new WeakMap();

  function pickRow(anchor) {


    const hit = rowCache.get(anchor);
    if (hit && hit.contains(anchor)) return hit;

    let el = anchor.parentElement;
    let hops = 0;
    while (el && el !== document.body && hops < 6) {
      const txt = el.textContent || '';
      if (txt.length > 600) break;
      if (countFileAnchors(el, 1) === 1 && hasMeta(el)) {
        rowCache.set(anchor, el);
        return el;
      }
      el = el.parentElement;
      hops++;
    }



    let el2 = anchor.parentElement;
    let hops2 = 0;
    while (el2 && el2 !== document.body && hops2 < 6) {
      const txt = el2.textContent || '';
      if (txt.length > 600) break;
      if (countFileAnchors(el2, 1) === 1 && (SIZE_RE.test(txt) || TIME_RE.test(txt))) {
        rowCache.set(anchor, el2);
        return el2;
      }
      el2 = el2.parentElement;
      hops2++;
    }
    return null;
  }



  function sizeOf(text) {
    const m = String(text || '').match(SIZE_RE);
    if (!m) return 0;


    let s = m[0].replace(/[^\d.,]/g, '');
    const ci = s.lastIndexOf(',');
    const di = s.lastIndexOf('.');
    if (ci > -1 && di > -1) {
      s = ci > di ? s.replace(/\./g, '').replace(/,/g, '.')
                  : s.replace(/,/g, '');
    } else if (ci > -1) {

      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
    }
    const num = parseFloat(s);
    if (!isFinite(num) || num <= 0) return 0;
    const u = (/[KMGT]/i.exec(m[0]) || [''])[0].toUpperCase();
    const mul = u === 'K' ? 1024
      : u === 'M' ? 1024 * 1024
      : u === 'G' ? 1024 * 1024 * 1024
      : u === 'T' ? 1024 * 1024 * 1024 * 1024 : 1;
    return Math.round(num * mul);
  }



  function sizeOfRow(row) {
    const cell = row && row.querySelector
      ? row.querySelector('#size, .mmr span, .files span')
      : null;
    const cellText = cell ? (cell.textContent || '') : '';
    if (/^\s*\d+(?:[.,]\d+)*\s*[KMGT]B?\s*$/i.test(cellText)) return sizeOf(cellText);

    const all = String((row && row.textContent) || '').match(new RegExp(SIZE_RE.source, 'gi')) || [];
    return sizeOf(all.length ? all[all.length - 1] : '');
  }


  function fmtSize(bytes) {
    if (!bytes) return '';
    const k = 1024;
    if (bytes < k * k) return Math.round(bytes / k) + 'K';
    if (bytes < k * k * k) return +(bytes / (k * k)).toFixed(1) + 'M';
    return +(bytes / (k * k * k)).toFixed(1) + 'G';
  }



  // Scan rows and inject checkboxes
  function scan() {
    dropBlocked();




    if (isSingleFilePath()) return;

    const anchors = $$('a');
    const usedRows = new Set();
    const seenName = new Map();
    const seenRow = new Set();
    const seenKeys = new Set();
    let added = 0;
    let dup = 0;

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];


      if (a.querySelector('.s_ad')) continue;

      const name = nameOfAnchor(a);
      if (!name) continue;



      const row = pickRow(a) || a;
      if (!row || usedRows.has(row)) continue;
      usedRows.add(row);


      //



      //






      //

      const href = itemUrl({ anchor: a });
      if (href) {
        const fp = href + '\u0001' + normRowText(row);
        if (seenRow.has(fp)) { dup++; continue; }
        seenRow.add(fp);
      }


      //


      //





      const nth = (seenName.get(name) || 0) + 1;
      seenName.set(name, nth);
      const key = href ? 'u:' + href : 'f:' + name + '\u0001' + nth;
      seenKeys.add(key);

      let item = items.get(key);
      const prev = anchorItem.get(a);
      if (!item && prev && prev.key !== key && items.get(prev.key) === prev) {
        items.delete(prev.key);
        prev.key = key;
        items.set(key, prev);
        item = prev;
      }
      let rowChanged = false;
      if (!item) {
        item = { key: key, label: name, checked: false, anchor: a, row: row, _href: href };
        items.set(key, item);
        added++;
      } else {
        item.anchor = a;


        if (item.row !== row) {
          item.row = row;
          item._paints = undefined;
          item._disp = undefined;
          item._painted = undefined;
          rowChanged = true;
        }
      }




      if (rowChanged || !item.size) item.size = sizeOfRow(row) || item.size || 0;
      item._href = href;
      anchorItem.set(a, item);
      injectCheckbox(item);
    }




    if (usedRows.size > 0) pruneGone(seenKeys);

    if (added > 0) log('新增 ' + added + ' 个文件，当前共 ' + items.size + ' 项');
    if (dup > 0) log('跳过 ' + dup + ' 个重复行（站点重复加载同一页造成的）');
    render();
  }





  const PAGE_WAIT = 4000;



  const PAGE_GAP_MIN = 1200;
  const PAGE_GAP_MAX = 4000;


  function backoffMs(n) {
    return Math.min(30000, 3000 * Math.pow(2, n - 1));
  }


  const STRIKES = 6;



  function moreBtn() {
    return document.getElementById('filemore');
  }



  function sitePg() {
    const v = window.pgs;
    return typeof v === 'number' ? v : null;
  }



  function parsePageReply(xhr) {
    let data;
    try { data = JSON.parse(xhr.responseText); } catch (e) { return null; }
    if (!data) return null;
    const zt = String(data.zt);
    const n = Array.isArray(data.text) ? data.text.length : -1;
    return {
      zt: zt,
      ok: zt === '1',
      end: zt === '1' && n > -1 && n < 50,
      throttled: zt === '4',
      n: n,
    };
  }

  function watchFilemore() {
    const X = window.XMLHttpRequest;
    if (!X || !X.prototype || X.prototype.__lzppHooked) return;
    const open = X.prototype.open;
    const send = X.prototype.send;

    X.prototype.open = function (method, url) {
      try { this.__lzppUrl = String(url || ''); } catch (e) {}
      return open.apply(this, arguments);
    };
    X.prototype.send = function () {
      const self = this;
      if (/filemoreajax\.php/i.test(self.__lzppUrl || '')) {
        state.pagePending = true;
        const finish = function () { state.pagePending = false; };
        self.addEventListener('load', function () {
          state.lastPage = parsePageReply(self);
          finish();
        });

        ['error', 'abort', 'timeout'].forEach(function (ev) {
          self.addEventListener(ev, finish);
        });
      }
      return send.apply(this, arguments);
    };
    X.prototype.__lzppHooked = true;
  }



  function siteSaysDone() {
    const b = moreBtn();
    if (!b) return true;
    try {
      return getComputedStyle(b).display === 'none';
    } catch (e) {
      return false;
    }
  }



  function rowCount() {
    const n = document.querySelectorAll('#infos > div[id=ready]').length;
    return n || items.size;
  }


  function waitRowsGrow(before, timeout) {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      (function tick() {
        if (state.loadStop) return resolve(false);
        if (rowCount() > before) return resolve(true);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, 120);
      })();
    });
  }



  // Auto-load every page
  async function loadAll() {
    if (state.loading) { state.loadStop = true; return; }
    if (state.running || state.noMore || !moreBtn()) return;

    state.loading = true;
    state.loadPending = false;
    state.loadStop = false;
    updateUI();
    setStatus('加载中');

    const startRows = items.size;
    let miss = 0;
    let pages = 0;
    let ended = '';



    const strikes = STRIKES;

    while (!state.loadStop) {
      const btn = moreBtn();
      if (!btn) { ended = 'gone'; break; }

      const before = rowCount();
      const pg0 = sitePg();
      state.lastPage = null;


      const wasShown = !siteSaysDone();
      try { btn.click(); }
      catch (e) { ended = 'gone'; break; }

      const grew0 = await waitRowsGrow(before, PAGE_WAIT);
      if (state.loadStop) break;
      let grew = grew0;



      if (!grew && state.pagePending) {
        const tPending = Date.now();
        while (state.pagePending && !state.loadStop && Date.now() - tPending < 8000) {
          await sleep(200);
        }
        grew = rowCount() > before;
        if (state.loadStop) break;
      }



      const reply = state.lastPage;
      const pg1 = sitePg();
      const known = pg0 !== null && pg1 !== null;
      const ok = reply ? reply.ok : (known ? pg1 > pg0 : grew);

      if (grew) {
        miss = 0;
        pages++;
        setStatus('加载中');
        updateUI();





        if (reply ? reply.end : (wasShown && siteSaysDone())) { ended = 'gone'; break; }

        state.pageGap = Math.max(PAGE_GAP_MIN, state.pageGap - 100);
        await sleep(state.pageGap);
      } else if (ok) {


        ended = 'gone';
        break;
      } else {


        state.pageGap = Math.min(PAGE_GAP_MAX, state.pageGap + 600);
        miss++;
        if (miss >= strikes) { ended = 'stall'; break; }
        await sleep(backoffMs(miss));



        await sleep(300);
        if (state.loadStop) break;
        if (rowCount() > before || (known && sitePg() !== null && sitePg() > pg0)) {
          miss = 0;
          pages++;
          setStatus('加载中');
          updateUI();
          state.pageGap = Math.max(PAGE_GAP_MIN, state.pageGap - 100);
          await sleep(state.pageGap);
        }
      }
    }



    const stopped = state.loadStop;
    await sleep(700);

    state.loading = false;
    state.loadStop = false;



    if (ended === 'gone') state.noMore = true;

    scan();



    const total = items.size;
    const rowsNow = rowCount();
    const got = total - startRows;
    if (rowsNow !== total) log('页面 ' + rowsNow + ' 行，认出来 ' + total + ' 条，差 ' + (rowsNow - total) + ' 行（重复或格式不认识）');

    if (stopped) setStatus('已停止加载');
    else if (ended === 'gone') setStatus('加载完成');
    else if (got > 0) setStatus('加载未完成');
    else setStatus('没有加载出新文件，可以再点一次');
    if (pages > 0) log('加载全部：点了 ' + pages + ' 页，' + startRows + ' → ' + total);
  }



  function pruneGone(seen) {
    let gone = 0;
    items.forEach(function (it, key) {



      if (seen && seen.has(key)) return;
      if (it.anchor && !it.anchor.isConnected) {
        items.delete(key);
        gone++;
      }
    });
    if (gone) log('移除 ' + gone + ' 个已不在页面上的条目');
  }

  function injectCheckbox(item) {
    const host = item.anchor.parentElement;
    if (!host) return;




    let cb = (item.cb && item.cb.parentElement === host) ? item.cb : null;
    if (!cb) {



      const rowScoped = countFileAnchors(host, 1) === 1;




      cb = (rowScoped && host.querySelector('input.lzpp-cb')) || null;
      if (!cb) cb = buildCheckbox(item, host, rowScoped);
    }

    cb.checked = item.checked;
    item.cb = cb;
    cbItem.set(cb, item);
    paint(item);
  }


  function buildCheckbox(item, host, rowScoped) {




    const wrapped = hasMeta(item.anchor);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lzpp-cb';
    cb.style.cssText =
      'width:15px;height:15px;margin:0 6px 0 0;vertical-align:-2px;cursor:pointer;' +
      'accent-color:' + ACCENT + ';flex:none;display:inline-block;';

    if (wrapped && rowScoped && host.style) {
      host.style.display = 'flex';
      host.style.alignItems = 'flex-start';
      host.style.gap = '0';
      if (item.anchor.style) {
        item.anchor.style.flex = '1';
        item.anchor.style.minWidth = '0';
      }
    }



    if (rowScoped) host.insertBefore(cb, host.firstChild);
    else host.insertBefore(cb, item.anchor);

    return cb;
  }



  function bindCheckboxEvents() {
    const EVENTS = ['click', 'mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup'];
    function stop(e) {
      const t = e.target;
      if (t && t.classList && t.classList.contains('lzpp-cb')) e.stopPropagation();
    }
    EVENTS.forEach(function (ev) { document.addEventListener(ev, stop, true); });

    document.addEventListener('change', function (e) {
      const it = cbItem.get(e.target);
      if (!it) return;
      it.checked = e.target.checked;
      paint(it);
      updateUI();
    }, true);
  }

  function paint(item) {

    if (item._painted === item.checked) return;
    item._painted = item.checked;

    const row = item.row;
    if (!row || !row.style) return;



    if (!item._paints) {
      const els = [row].concat(Array.from(row.children || []));
      item._paints = els.map(function (el) {
        return { el: el, bg: el.style.backgroundColor || '' };
      });
      item._paints.forEach(function (p) {
        p.el.style.transition = 'background-color .15s ease';
      });
    }
    item._paints.forEach(function (p) {
      p.el.style.backgroundColor = item.checked ? ACCENT_SOFT : p.bg;
    });
    if (row.classList) row.classList.toggle('lzpp-on', !!item.checked);
  }




  function isBlockedLink(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const href = el.getAttribute ? (el.getAttribute('href') || '') : '';
    return BLOCK_TEXT_RE.test(text) || BLOCK_HREF_RE.test(href);
  }


  // Remove promo rows
  function dropBlocked() {
    const sels = '#save, [id^="mh_save"], a[href*="ilanzou.com"], a[href*="/unproved/"]';
    $$(sels).forEach(function (el) {
      if (!isBlockedLink(el) && el.id !== 'save' && el.id.indexOf('mh_save') !== 0) return;
      const box = el.closest('#save, [id^="mh_save"]') || el;
      if (box.style && box.style.display !== 'none') {
        box.style.display = 'none';
        log('已移除推广位：转存到我的网盘');
      }
    });
  }



  const API_HOSTS = [
    'https://apifile.woozooo.com/ajaxfile.php',
    'https://apifile.lanzouw.com/ajaxfile.php'
  ];

  function pick(re, s) {
    const m = String(s || '').match(re);
    return m ? m[1] : '';
  }


  function looksLikeChallenge(html) {
    return /arg1\s*=/.test(html) && /acw_sc__v2|function\s*\(a,\s*c\)/.test(html);
  }



  function frameLoad(url, opt) {
    const o = opt || {};
    const limit = o.timeout || 12000;

    return new Promise(function (resolve, reject) {
      const fr = document.createElement('iframe');
      fr.setAttribute('aria-hidden', 'true');
      fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      fr.style.cssText = 'position:fixed;left:-9999px;top:0;width:360px;height:300px;' +
        'opacity:0;pointer-events:none;border:0;';
      let settled = false;
      let lastHtml = '';
      let timer = 0;
      const t0 = Date.now();

      function done(val) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        try { if (fr.parentNode) fr.parentNode.removeChild(fr); } catch (e) {}
        resolve(val);
      }

      function tick() {
        if (settled) return;
        let doc = null;
        try { doc = fr.contentDocument; } catch (e) { doc = null; }
        if (doc && doc.readyState === 'complete' && doc.documentElement) {
          try { lastHtml = doc.documentElement.outerHTML || lastHtml; } catch (e) {}
          let hit = null;
          try { hit = o.until(doc); } catch (e) { hit = null; }
          if (hit) return done({ hit: hit, html: lastHtml });
        }
        if (Date.now() - t0 > limit) {
          if (lastHtml) return done({ hit: null, html: lastHtml });
          settled = true;
          clearInterval(timer);
          try { if (fr.parentNode) fr.parentNode.removeChild(fr); } catch (e) {}
          return reject(new Error('页面加载超时'));
        }
      }



      fr.src = url;
      (document.body || document.documentElement).appendChild(fr);
      timer = setInterval(tick, 150);
      tick();
    });
  }

  async function tryFetch(url) {
    const res = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { text: await res.text(), url: res.url || url };
  }



  async function fetchText(url) {
    let first = null;
    try {
      first = await tryFetch(url);
      if (!looksLikeChallenge(first.text)) return first;
    } catch (e) {
      log('fetch 失败，改用隐藏 iframe：' + url + ' · ' + ((e && e.message) || e));
    }

    if (first) log('碰到反爬挑战页，先用隐藏 iframe 过验证：' + url);


    let snap = { hit: null, html: '' };
    try {
      snap = await frameLoad(url, {
        timeout: 9000,
        until: function (doc) {
          const h = doc.documentElement.outerHTML || '';
          return (h.length > 300 && !looksLikeChallenge(h)) ? h : null;
        }
      });
    } catch (e) {
      snap = { hit: null, html: '' };
    }
    if (snap.hit) return { text: snap.hit, url: url };


    try {
      const again = await tryFetch(url);
      if (!looksLikeChallenge(again.text)) return again;
    } catch (e) {}


    if (snap.html) return { text: snap.html, url: url };
    throw new Error('被反爬拦住了，刷新页面后再试');
  }


  async function postDown(fid, fields) {
    const body = new URLSearchParams();
    Object.keys(fields).forEach(function (k) { body.append(k, fields[k]); });

    let lastErr = null;
    for (let i = 0; i < API_HOSTS.length; i++) {
      try {
        const res = await fetch(API_HOSTS[i] + '?file=' + encodeURIComponent(fid), {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        const data = await res.json();
        if (String(data.zt) !== '1') throw new Error(data.inf || '解析失败');
        const dom = data.dom || '';
        const u = data.url || '';
        if (!dom || !u) throw new Error('解析结果为空');
        return dom + '/file/' + u;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('解析失败');
  }


  function currentPassword() {
    const el = document.querySelector(PWD_INPUT_SEL);
    return el && el.value ? el.value : '';
  }



  async function resolveViaTp(tpUrl) {
    const tp = await fetchText(tpUrl);
    state.lastTp = tp.text;
    return await parseTpPage(tp.text);
  }


  async function parseTpPage(html) {
    state.lastTp = html;


    const full = pick(/(https?:\/\/[^"'\s<>]+\/file\/\?[^\s"'<>]{20,})/i, html);
    if (full) return full;

    const sign = pick(/vidksek\s*=\s*['"]([^'"]+)['"]/i, html);
    const fid = pick(/ajaxfile\.php\?file=(\d+)/i, html);
    const kdns = pick(/var\s+kdns\s*=\s*(\d+)/i, html) || '1';
    if (sign && fid) {
      return await postDown(fid, {
        action: 'downprocess',
        sign: sign,
        p: currentPassword(),
        kd: kdns
      });
    }

    const base = pick(/(https?:\/\/[^"'\s<>]+\/file\/)/i, html);
    const qs = pick(/["'](\?[^"'\s]{16,})["']/, html);
    if (base && qs) return base + qs;


    throw new Error('移动版结构变了（页长 ' + html.length +
      ' · 挑战页 ' + (looksLikeChallenge(html) ? '是' : '否') +
      ' · base ' + (base ? '有' : '无') +
      ' · token ' + (qs ? '有' : '无') +
      ' · sign ' + (sign ? '有' : '无') + '）');
  }


  async function resolveViaFn(fnUrl) {
    const fn = await fetchText(fnUrl);
    const sign = pick(/wp_sign\s*=\s*'([^']+)'/i, fn.text);
    const ajaxdata = pick(/ajaxdata\s*=\s*'([^']*)'/i, fn.text);
    const fid = pick(/ajaxfile\.php\?file=(\d+)/i, fn.text);
    const kdns = pick(/var\s+kdns\s*=\s*(\d+)/i, fn.text) || '1';
    if (!sign || !fid) throw new Error('下载页结构变了（没取到 sign / 文件号）');
    return await postDown(fid, {
      action: 'downprocess',
      websignkey: ajaxdata,
      signs: ajaxdata,
      sign: sign,
      websign: '2',
      kd: kdns,
      ves: '1'
    });
  }


  function probeFileDoc(doc) {


    const a = doc.getElementById('ddown') || doc.querySelector('a[href*="/tp/"]');
    const h = a ? (a.getAttribute('href') || '') : '';
    if (/\/tp\/[A-Za-z0-9_\-]{4,}/.test(h)) return { tp: h };


    const f = doc.querySelector('iframe[src*="/fn?"]');
    if (f) {
      const src = f.getAttribute('src') || '';
      if (src) return { fn: src };
    }
    return null;
  }


  async function resolveDirect(fileUrl) {
    const page = await fetchText(fileUrl);
    const html = page.text;



    if (/\/tp\//i.test(page.url)) {
      return await parseTpPage(html);
    }


    const fnPath = pick(/<iframe[^>]+src="([^"]*\/fn\?[^"]+)"/i, html) ||
      pick(/(\/fn\?[A-Za-z0-9_\-]+)/i, html);
    if (fnPath) return await resolveViaFn(new URL(fnPath, page.url).href);



    const tpPath = pick(/(\/tp\/[A-Za-z0-9_\-]+(?:\?webtp=[^\s"'&<>\\]+)?)/i, html);
    if (tpPath) return await resolveViaTp(new URL(tpPath, page.url).href);

    const sign2 = pick(/isngis\s*=\s*'([^']+)'/i, html);
    const fid2 = pick(/ajaxfile\.php\?file=(\d+)/i, html);
    if (sign2 && fid2) {
      const pwd = currentPassword();
      if (!pwd) throw new Error('该文件需要分享密码，请先在页面上输入密码');
      return await postDown(fid2, { action: 'downprocess', sign: sign2, kd: '1', p: pwd });
    }

    let guess = null;
    try {
      const snap = await frameLoad(fileUrl, { timeout: 9000, until: probeFileDoc });
      guess = snap.hit;
    } catch (e) {
      guess = null;
    }
    if (guess && guess.tp) {
      log('iframe 里拿到的下载页：' + guess.tp);
      return await resolveViaTp(new URL(guess.tp, fileUrl).href);
    }
    if (guess && guess.fn) {
      return await resolveViaFn(new URL(guess.fn, fileUrl).href);
    }

    throw new Error('未识别的下载页结构（页长 ' + html.length +
      ' · 挑战页 ' + (looksLikeChallenge(html) ? '是' : '否') +
      ' · fn ' + (/\/fn\?/.test(html) ? '有' : '无') +
      ' · tp ' + (/\/tp\//.test(html) ? '有' : '无') +
      ' · isngis ' + (/isngis/.test(html) ? '有' : '无') + '）');
  }

  let dlWin = null;
  let winCloseTimer = 0;

  function cancelWinClose() {
    if (winCloseTimer) {
      clearTimeout(winCloseTimer);
      winCloseTimer = 0;
    }
  }

  function scheduleWinClose() {
    if (!willUseWin() || !dlWin || dlWin.closed) return;
    cancelWinClose();
    const win = dlWin;
    winCloseTimer = setTimeout(function () {
      winCloseTimer = 0;
      if (state.running || dlWin !== win) return;
      if (win && !win.closed) {
        try { win.close(); } catch (e) {}
      }
      if (dlWin === win) dlWin = null;
    }, WIN_CLOSE_DELAY);
  }

  function willUseWin() {
    return !IS_GECKO;
  }

  function primeDownloadWindow() {
    if (!willUseWin()) return;
    cancelWinClose();
    if (dlWin && !dlWin.closed) return;
    try { dlWin = window.open('about:blank', 'lzpp-dl'); } catch (e) { dlWin = null; }
    if (!dlWin) return;
    try {
      dlWin.document.title = NAME + ' 下载';
      dlWin.document.body.innerHTML =
        '<div style="font:14px/1.6 system-ui,-apple-system,sans-serif;color:#5f6368;padding:28px">' +
        '正在解析直链，稍后自动开始下载…</div>';
    } catch (e) {}
    try { window.focus(); } catch (e) {}
  }

  function fatalError(msg) {
    const e = new Error(msg);
    e.fatal = true;
    return e;
  }

  function fireIntoWin(url) {

    if (dlWin && dlWin.closed) {
      dlWin = null;
      throw fatalError('下载窗口被关闭了，已中止');
    }
    if (dlWin) {
      try { dlWin.location.href = url; return; }
      catch (e) { dlWin = null; }
    }
    dlWin = window.open(url, 'lzpp-dl');
    if (!dlWin) {
      throw fatalError('浏览器拦掉了下载窗口，请允许本页弹窗后重试');
    }
  }

  function fireDirect(url) {

    if (!IS_GECKO) {
      fireIntoWin(url);
      return;
    }

    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;border:0;';
    f.src = url;
    document.body.appendChild(f);
    removeLater(f, 90000);
  }

  function removeLater(f, ms) {
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, ms);
  }

  function itemUrl(item) {
    const a = item.anchor;
    if (!a) return '';
    const href = a.getAttribute('href') || '';
    if (!href || /^(javascript:|#)/i.test(href)) return '';
    let abs;
    try { abs = new URL(href, location.href).href; } catch (e) { return ''; }
    if (abs.split('#')[0] === location.href.split('#')[0]) return '';
    return abs;
  }

  const RESOLVE_CONCURRENCY = 3;

  const RESOLVE_RETRY_WAIT = 1500;

  // Resolve a file page to a direct URL
  async function resolveItem(it) {
    if (it.direct && (Date.now() - (it.directAt || 0)) < DIRECT_TTL) {
      log('直链复用：' + it.label);
      return it.direct;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const href = itemUrl(it);
        if (!href) throw new Error('没有可访问的文件页地址');
        const direct = await resolveDirect(href);
        it.direct = direct;
        it.directAt = Date.now();
        log('直链：' + it.label + ' -> ' + direct);
        return direct;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await sleep(RESOLVE_RETRY_WAIT);
      }
    }
    throw lastErr || new Error('解析失败');
  }

  // Download queue
  async function run(only) {
    const picked = (only && only.length)
      ? only.slice()
      : Array.from(items.values()).filter((i) => i.checked);
    if (!picked.length) {
      setStatus('请先勾选文件');
      return;
    }
    cancelWinClose();

    picked.forEach(function (it) { it.error = ''; });

    state.running = true;
    state.stop = false;
    state.prog = { done: 0, total: picked.length };
    updateUI();

    let okCount = 0, failCount = 0;
    let fatalMsg = '';

    const pending = new Map();
    function startResolve(it) {
      let p = pending.get(it);
      if (!p) {
        p = resolveItem(it);
        p.catch(function () {});
        pending.set(it, p);
      }
      return p;
    }

    for (let i = 0; i < picked.length; i++) {
      if (state.stop) break;
      const it = picked[i];

      for (let k = i + 1; k < picked.length && k <= i + RESOLVE_CONCURRENCY; k++) {
        startResolve(picked[k]);
      }

      const gap = willUseWin() ? Math.max(DOWNLOAD_GAP, 3500) : DOWNLOAD_GAP;
      const etaMin = Math.max(1, Math.round((picked.length - i) * (gap + 500) / 60000));
      setStatus('已发起 ' + okCount + ' / ' + picked.length + ' 约 ' + etaMin + ' 分钟 ' + it.label);

      try {
        const direct = await startResolve(it);
        fireDirect(direct);
        okCount++;
        it.error = '';
      } catch (e) {
        failCount++;
        const msg = (e && e.message) || String(e);
          it.error = msg;
        log('下载失败：' + it.label + ' —— ' + msg);

        if (e && e.fatal) {
          fatalMsg = msg;
          state.stop = true;
        }
      } finally {
        pending.delete(it);
      }

      state.prog.done = i + 1;
      updateUI();
      if (fatalMsg) break;
      if (i < picked.length - 1 && !state.stop) await sleep(gap);
    }

    state.running = false;
    updateUI();

    let text;
    if (fatalMsg) {
      text = '已中止 已发起 ' + okCount;
    } else {
      text = (state.stop ? '已停止 ' : '') + '已发起 ' + okCount;
      if (failCount) text += ' 失败 ' + failCount;
    }
    setStatus(text);

    if (willUseWin() && dlWin && !dlWin.closed) {
      if (okCount === 0) {
        try { dlWin.close(); } catch (e) {}
        dlWin = null;
      } else {
        scheduleWinClose();
      }
    }
  }

  function syncAll() {
    items.forEach((i) => {
      if (i.cb) i.cb.checked = i.checked;
      paint(i);
    });
  }

  const SEARCH_STYLE_ID = 'lzpp-search-style';
  const SEARCH_CSS = `    .lzpp-search {
      box-sizing: border-box;
      position: sticky;
      top: 49px;
      z-index: 6;
      width: 100%;
      margin: 0 auto;
      padding: 0;
      background: transparent;
      border-bottom: 0;
      font-family: "Manrope", "Noto Sans SC", "Microsoft YaHei UI", "Segoe UI", sans-serif;
      color: #1a1a1a;
    }
    .lzpp-search.is-stuck {
      background: #fff;
      box-shadow: 0 1px 0 #e4e4e4;
    }
    .lzpp-search *, .lzpp-search *::before, .lzpp-search *::after { box-sizing: border-box; }
    .lzpp-barrow {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 4px 0;
      background: transparent;
      border-bottom: 0;
    }

    .top .d1 {
      background: #fff !important;
      border-bottom-color: transparent !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .08) !important;
      opacity: 1 !important;
      filter: none !important;
    }

    div.pc.bgimg {
      background: #fff !important;
      background-image: none !important;
      border-bottom-color: transparent !important;
    }

    .d2 {
      position: sticky;
      top: calc(49px + var(--lzpp-barh, 36px));
      z-index: 5;
      min-height: 43px;
      background: #fff !important;
      border-top: 0 !important;
      border-bottom: 0 !important;
      padding: 0 10px !important;
      color: #3f3f3f !important;
      font-size: 12px;
    }
    #infos { border-top-color: transparent !important; }

    #filemore { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }

    #ready.lzpp-on #name, #ready.lzpp-on #name a { color: #1a1a1a !important; }

    #ready.lzpp-on #name { box-shadow: -10px 0 0 #e8f3fd; }
    #ready.lzpp-on #size, #ready.lzpp-on #time { color: #3f3f3f !important; }

    .lzpp-urlbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      max-width: 820px;
      height: 28px;
      margin: 0;
      padding: 2px 2px 2px 8px;
      background: #fff;
      border: 1px solid #adadad;
      border-radius: 0;
      box-shadow: none;
      transition: border-color .1s ease;
    }
    .lzpp-urlbar:focus-within { border-color: #0a5fbf; box-shadow: inset 0 0 0 1px #0a5fbf; }
    .lzpp-sicon { flex: none; display: grid; place-items: center; color: #6b6b6b; }
    .lzpp-sicon svg { display: block; width: 14px; height: 14px; }
    .lzpp-sinput {
      flex: 1;
      min-width: 0;
      border: 0;
      outline: 0;
      background: transparent;
      padding: 3px 2px;
      font: inherit;
      font-size: 12px;
      line-height: 1.4;
      color: #1a1a1a;
    }
    .lzpp-sinput::placeholder { color: #8a8a8a; }
    .lzpp-sinput::-webkit-search-cancel-button { display: none; }
    .lzpp-sclear {
      flex: none;
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 0;
      display: grid;
      place-items: center;
      background: transparent;
      color: #333;
      font: inherit;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    .lzpp-sclear:hover { background: #e5f1fb; }

    .lzpp-actions {
      position: relative;
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      border-radius: 0;
      background: transparent;
    }
    .lzpp-slot {
      flex: none;
      width: 4.8em;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .lzpp-sel {
      width: 100%;
      color: #3f3f3f;
      font-size: 12px;
      white-space: nowrap;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .lzpp-sel span { color: #6b6b6b; }
    .lzpp-loadnote {
      width: 100%;
      min-width: 0;
      padding: 0;
      color: #0a5fbf;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      white-space: nowrap;
    }
    .lzpp-loadnote.done { color: #0f7b0f; font-weight: 700; }
    .lzpp-loadnote.fail { color: #b42318; font-weight: 600; }
    .lzpp-loadnote[hidden], .lzpp-sel[hidden] { display: none; }
    .lzpp-main, .lzpp-stop, .lzpp-mini, .lzpp-retry {
      height: 26px;
      border: 1px solid #adadad;
      border-radius: 0;
      background: linear-gradient(180deg, #fdfdfd, #f0f0f0);
      color: #1a1a1a;
      font-family: inherit;
      font-size: 12px;
      font-weight: 400;
      cursor: pointer;
      white-space: nowrap;
    }
    .lzpp-main { padding: 0 12px; }
    .lzpp-main:hover { background: linear-gradient(180deg, #f0f0f0, #e4e4e4); }
    .lzpp-main:disabled { background: #f0f0f0; color: #9a9a9a; border-color: #d4d4d4; cursor: not-allowed; }
    .lzpp-main:not(:disabled) {
      border-color: #0a5fbf;
      background: linear-gradient(180deg, #2c7fd6, #0a5fbf);
      color: #fff;
    }
    .lzpp-main:not(:disabled):hover { background: linear-gradient(180deg, #2072c6, #084c9a); }
    .lzpp-stop { padding: 0 10px; }
    .lzpp-stop:hover { background: linear-gradient(180deg, #f0f0f0, #e4e4e4); }
    .lzpp-mini { padding: 0 10px; }
    .lzpp-mini:hover { background: linear-gradient(180deg, #f0f0f0, #e4e4e4); }
    .lzpp-mini:disabled { color: #9a9a9a; border-color: #d4d4d4; background: #f0f0f0; cursor: not-allowed; }
    .lzpp-retry { height: 24px; padding: 0 8px; font-size: 11.5px; }

    .lzpp-smeta {
      margin: 2px 0 0;
      color: #6b6b6b;
      font-size: 11px;
      text-align: left;
    }
    .lzpp-smeta[hidden], .lzpp-sclear[hidden] { display: none; }

    .lzpp-statusrow {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .lzpp-statusrow[hidden], .lzpp-progress[hidden], .lzpp-status[hidden], .lzpp-retry[hidden] { display: none; }
    .lzpp-progress { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 160px; }
    .lzpp-track { flex: 1; height: 4px; overflow: hidden; border-radius: 0; background: #c8c8c8; }
    .lzpp-fill { display: block; height: 100%; width: 0; border-radius: 0; background: #0a5fbf; transition: width .2s ease; }
    .lzpp-num { color: #3f3f3f; font-family: "Cascadia Mono", Consolas, monospace; font-size: 10.5px; font-variant-numeric: tabular-nums; }
    .lzpp-status {
      max-width: 100%;
      overflow: hidden;
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: #3f3f3f;
      font-size: 11.5px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .d2 .nameh { position: relative; box-sizing: border-box; padding-left: 21px; }
    input.lzpp-cb {
      -webkit-appearance: none !important;
      appearance: none !important;
      border: 1px solid #7a7a7a !important;
      border-radius: 0 !important;
      background-color: #fff !important;
      background-repeat: no-repeat !important;
      background-position: center !important;
      background-size: 10px 10px !important;
      cursor: pointer;
    }
    input.lzpp-cb { width: 15px !important; height: 15px !important; margin: 0 6px 0 0 !important; vertical-align: middle !important; flex: none; }
    input.lzpp-cb:checked {
      border-color: #0a5fbf !important;
      background-color: #0a5fbf !important;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 6.4l2.6 2.6L10 3' fill='none' stroke='%23fff' stroke-width='2'/%3E%3C/svg%3E") !important;
    }

    @media (max-width: 600px) {
      .lzpp-search { padding: 0; }
      .lzpp-barrow { gap: 4px; padding: 4px 0; }
      .lzpp-urlbar { flex: 1 0 100%; max-width: none; height: 30px; margin: 0; padding: 2px 2px 2px 7px; }
      .lzpp-actions { width: 100%; margin-left: 0; padding: 0 6px; }
      .lzpp-sel { flex: 1; font-size: 12px; }
      .lzpp-main, .lzpp-stop, .lzpp-mini { height: 28px; }
      .lzpp-sinput { font-size: 13px; padding: 4px 2px; }
      .lzpp-sclear { width: 26px; height: 26px; }
      .lzpp-status { white-space: normal; }
    }
`;

  let searchInput = null;
  let searchMeta = null;
  let searchClear = null;
  let searchTimer = 0;
  let searchQuery = '';
  let barUI = null;
  let stuckBound = false;
  let stuckTimer = 0;
  let loadNote = { text: '', until: 0, timer: 0 };

  function syncSearchStuck() {
    const bar = document.getElementById('lzpp-search');
    if (!bar) return;
    document.documentElement.style.setProperty('--lzpp-barh', bar.offsetHeight + 'px');
    bar.classList.toggle('is-stuck', bar.getBoundingClientRect().top <= 49.5);
  }

  function bindStuckWatch() {
    if (stuckBound) return;
    stuckBound = true;
    const schedule = function () {
      clearTimeout(stuckTimer);
      stuckTimer = setTimeout(syncSearchStuck, 16);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
  }

  function ensureSearchStyle() {
    if (document.getElementById(SEARCH_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SEARCH_STYLE_ID;
    style.textContent = SEARCH_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .replace(/§[0-9a-z]/gi, '')
      .replace(/§/g, '')
      .replace(/[\s\-_.·•()（）\[\]【】,，。;；:：'"“”‘’]+/g, '')
      .toLowerCase();
  }

  function fuzzySubsequence(hay, query) {
    let i = 0;
    for (let j = 0; j < hay.length && i < query.length; j++) {
      if (hay.charAt(j) === query.charAt(i)) i++;
    }
    return i === query.length;
  }

  function setRowVisible(item, show) {
    const row = item.row;
    if (!row || !row.style) return;
    if (item._disp === undefined) item._disp = row.style.display || '';
    const want = show ? item._disp : 'none';
    if (row.style.display !== want) row.style.display = want;
  }

  function applySearch() {
    const query = normalizeSearchText(searchQuery);
    if (!query) {
      items.forEach(function (item) { setRowVisible(item, true); });
      if (searchMeta) searchMeta.hidden = true;
      return;
    }

    let hits = 0;
    items.forEach(function (item) {
      const hay = normalizeSearchText(item.label);
      const hit = hay.indexOf(query) !== -1 || fuzzySubsequence(hay, query);
      if (hit) hits++;
      setRowVisible(item, hit);
    });

    if (searchMeta) {
      searchMeta.hidden = false;
      searchMeta.textContent = hits ? hits + ' 个匹配' : '没有匹配的文件';
    }
  }

  function showLoadNote(text, ms) {
    clearTimeout(loadNote.timer);
    loadNote.text = text || '';
    loadNote.until = ms ? Date.now() + ms : 0;
    if (ms) {
      loadNote.timer = setTimeout(function () {
        loadNote.text = '';
        loadNote.until = 0;
        syncBar();
      }, ms);
    }
    syncBar();
  }

  function clearLoadNote() {
    clearTimeout(loadNote.timer);
    loadNote.text = '';
    loadNote.until = 0;
  }

  function bindBar(wrap) {
    const ref = function (name) { return wrap.querySelector('[data-ref="' + name + '"]'); };
    barUI = {
      go: ref('barGo'),
      stop: ref('barStop'),
      all: ref('barAll'),
      clear: ref('barClear'),
      size: ref('barSize'),
      loadNote: ref('barLoadNote'),
      sel: ref('barSel'),
      prog: ref('barProg'),
      fill: ref('barFill'),
      num: ref('barNum'),
      status: ref('barStatus'),
      retry: ref('barRetry'),
      statusRow: ref('barStatusRow'),
    };

    barUI.go.addEventListener('click', function () {
      if (state.running) return;
      primeDownloadWindow();
      run();
    });

    barUI.stop.addEventListener('click', function () {
      if (!state.running) return;
      state.stop = true;
      setStatus('正在停止…');
    });

    barUI.retry.addEventListener('click', function () {
      if (state.running) return;
      const failed = Array.from(items.values()).filter(function (it) { return it.error; });
      if (!failed.length) return;
      primeDownloadWindow();
      run(failed);
    });

    barUI.all.addEventListener('click', function () {
      items.forEach(function (it) { it.checked = true; });
      syncAll();
      updateUI();
    });

    barUI.clear.addEventListener('click', function () {
      items.forEach(function (it) { it.checked = false; });
      syncAll();
      updateUI();
    });

    bindStuckWatch();
    syncSearchStuck();
    syncBar();
  }

  // UI state
  function syncBar() {
    if (!barUI || !document.contains(barUI.go)) return;

    const arr = Array.from(items.values());
    const n = arr.filter(function (it) { return it.checked; }).length;
    const bytes = arr.reduce(function (sum, it) { return sum + (it.checked ? (it.size || 0) : 0); }, 0);
    const sizeText = fmtSize(bytes);

    barUI.size.textContent = sizeText;

    const note = state.loading ? '加载中'
      : (loadNote.text && (!loadNote.until || Date.now() < loadNote.until) ? loadNote.text : '');
    if (barUI.loadNote) {
      barUI.loadNote.hidden = !note;
      barUI.loadNote.textContent = note;
      barUI.loadNote.classList.toggle('done', note === '加载完成');
      barUI.loadNote.classList.toggle('fail', note === '加载失败');
    }
    if (barUI.sel) barUI.sel.hidden = !!note;

    barUI.go.hidden = !!state.running;
    barUI.stop.hidden = !state.running;
    barUI.all.disabled = state.loading || state.loadPending || (n > 0 && n === arr.length);
    barUI.clear.disabled = n === 0;
    barUI.go.disabled = n === 0;
    barUI.go.textContent = n === 0 ? '下载' : '下载 (' + n + ')';

    if (state.running) {
      const p = state.prog || { done: 0, total: 0 };
      barUI.prog.hidden = false;
      barUI.fill.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 0) + '%';
      barUI.num.textContent = p.done + ' / ' + p.total;
    } else {
      barUI.prog.hidden = true;
    }

    const failed = arr.filter(function (it) { return it.error; });
    barUI.retry.hidden = !failed.length || !!state.running;
    if (failed.length) barUI.retry.textContent = '重试';

    const hasStatus = barUI.status && barUI.status.textContent && !barUI.status.hidden;
    barUI.statusRow.hidden = !(state.running || hasStatus || (barUI.retry && !barUI.retry.hidden));

    if (barUI.sel) barUI.sel.hidden = !!note || n === 0 || !sizeText;

    const barEl = document.getElementById('lzpp-search');
    if (barEl) document.documentElement.style.setProperty('--lzpp-barh', barEl.offsetHeight + 'px');
  }

  // Search
  function mountSearch() {
    if (isSingleFilePath()) return;
    if (!items.size) return;
    ensureSearchStyle();

    let wrap = document.getElementById('lzpp-search');
    if (!wrap) {
      let anchor = document.getElementById('infos');
      if (anchor) {


        const header = anchor.previousElementSibling;
        if (header && (header.classList.contains('d2') || header.querySelector('.nameh'))) anchor = header;
      }
      if (!anchor) {
        items.forEach(function (item) {
          if (!anchor && item.row && item.row.parentNode) anchor = item.row.parentNode;
        });
      }
      if (!anchor || !anchor.parentNode) return;

      wrap = document.createElement('div');
      wrap.id = 'lzpp-search';
      wrap.className = 'lzpp-search';
      wrap.innerHTML =
        '<div class="lzpp-barrow">' +
          '<div class="lzpp-urlbar">' +
            '<span class="lzpp-sicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg></span>' +
            '<input class="lzpp-sinput" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-label="搜索文件名" placeholder="搜索文件名">' +
            '<button class="lzpp-sclear" type="button" aria-label="清空搜索" hidden>×</button>' +
          '</div>' +
          '<div class="lzpp-actions">' +
            '<span class="lzpp-slot" data-ref="barSlot">' +
              '<span class="lzpp-loadnote" data-ref="barLoadNote" hidden></span>' +
              '<span class="lzpp-sel" data-ref="barSel"><span data-ref="barSize"></span></span>' +
            '</span>' +
            '<button class="lzpp-mini" data-ref="barAll" type="button">全选</button>' +
            '<button class="lzpp-mini" data-ref="barClear" type="button" disabled>清空已选</button>' +
            '<button class="lzpp-main" data-ref="barGo" type="button" disabled>下载</button>' +
            '<button class="lzpp-stop" data-ref="barStop" type="button" hidden>停止</button>' +
          '</div>' +
        '</div>' +
        '<div class="lzpp-smeta" hidden></div>' +
        '<div class="lzpp-statusrow" data-ref="barStatusRow" hidden>' +
          '<div class="lzpp-progress" data-ref="barProg" hidden>' +
            '<span class="lzpp-track"><span class="lzpp-fill" data-ref="barFill"></span></span>' +
            '<span class="lzpp-num" data-ref="barNum">0 / 0</span>' +
          '</div>' +
          '<span class="lzpp-status" data-ref="barStatus" hidden></span>' +
          '<button class="lzpp-retry" data-ref="barRetry" type="button" hidden>重试</button>' +
        '</div>';
      anchor.parentNode.insertBefore(wrap, anchor);
    }

    if (searchInput && !document.contains(searchInput)) {
      searchInput = null;
      searchMeta = null;
      searchClear = null;
      barUI = null;
    }
    if (searchInput) {
      if (!barUI || !document.contains(barUI.go)) bindBar(wrap);
      return;
    }
    searchInput = wrap.querySelector('.lzpp-sinput');
    searchMeta = wrap.querySelector('.lzpp-smeta');
    searchClear = wrap.querySelector('.lzpp-sclear');
    searchInput.value = searchQuery;
    searchClear.hidden = !searchQuery;

    searchInput.addEventListener('input', function () {
      searchClear.hidden = !searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchQuery = searchInput.value;
        applySearch();
      }, 80);
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      searchInput.value = '';
      searchQuery = '';
      searchClear.hidden = true;
      clearTimeout(searchTimer);
      applySearch();
    });

    searchClear.addEventListener('click', function () {
      searchInput.value = '';
      searchQuery = '';
      searchClear.hidden = true;
      clearTimeout(searchTimer);
      applySearch();
      searchInput.focus();
    });

    bindBar(wrap);
  }

  function maybeAutoLoadAll() {
    if (state.autoLoadTried) return;
    if (window.__LZPP_DISABLE_AUTO_LOAD__) return;

    if (/jsdom/i.test(navigator.userAgent || '')) return;
    if (state.loading || state.running || state.noMore) return;
    if (!items.size || !moreBtn()) return;

    state.autoLoadTried = true;
    state.loadPending = true;
    syncBar();
    setTimeout(function () {
      if (state.loading || state.running || state.noMore) { state.loadPending = false; syncBar(); return; }
      if (!moreBtn()) { state.loadPending = false; syncBar(); return; }
      state.loadPending = false;
      loadAll();
    }, 800);
  }

  function render() {
    updateUI();
    mountSearch();
    applySearch();
    maybeAutoLoadAll();
  }

  function updateUI() {
    syncBar();
  }


  function isSingleFilePath() {
    return /^\/i[0-9A-Za-z_-]{5,}\/?$/.test(location.pathname);
  }



  function isFolderPage() {
    if (isSingleFilePath()) return false;
    if (items.size > 0) return true;
    return /^\/b[0-9A-Za-z_-]{5,}\/?$/.test(location.pathname);
  }

  function setStatus(text) {
    const loadText = text === '加载中' || text === '加载完成' ||
      text === '加载失败' ||
      text === '已停止加载' || text === '加载未完成' ||
      text === '没有加载出新文件，可以再点一次';

    if (loadText) {
      if (text === '加载中') showLoadNote('加载中', 0);
      else if (text === '加载完成') showLoadNote('加载完成', 1200);
      else showLoadNote('加载失败', 2400);
      if (!state.running && barUI && barUI.status) {
        barUI.status.textContent = '';
        barUI.status.hidden = true;
      }
      if (!state.running && barUI && barUI.statusRow) barUI.statusRow.hidden = true;
      return;
    }

    clearLoadNote();
    if (!barUI || !barUI.status) return;
    barUI.status.textContent = text || '';
    barUI.status.hidden = !text;
    if (barUI.statusRow) {
      barUI.statusRow.hidden = !(text || state.running || (barUI.retry && !barUI.retry.hidden));
    }
    syncBar();
  }



  const PWD_BTN_SELS = ['#sub', '#passBtn', '.passwddiv-btn', '.btnpwd'];
  const PWD_BTN_TEXT_RE = /(确认|确定|提交|进入|继续|下载)/;

  function findPwdSubmit(input) {
    for (let i = 0; i < PWD_BTN_SELS.length; i++) {
      const el = document.querySelector(PWD_BTN_SELS[i]);
      if (el) return el;
    }

    const form = input && input.form;
    if (form) {
      const sb = form.querySelector('[type="submit"], button');
      if (sb) return sb;
    }


    let box = input && input.parentElement;
    for (let i = 0; i < 4 && box && box !== document.body; i++) {
      const cands = $$('button, [type="submit"], [onclick], a', box);
      const hit = cands.filter(function (el) {
        return el.hasAttribute('onclick') || PWD_BTN_TEXT_RE.test((el.textContent || '') + (el.value || ''));
      })[0];
      if (hit) return hit;
      box = box.parentElement;
    }
    return null;
  }

  // Password page
  function bindPasswordEnter() {
    let handledAt = 0;

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;

      const t = e.target;
      if (!t) return;


      const pwd = document.querySelector(PWD_INPUT_SEL);
      if (!pwd || t !== pwd) return;

      const btn = findPwdSubmit(pwd);
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();
      handledAt = Date.now();
      btn.click();
    }, true);


    window.addEventListener('keyup', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (!handledAt || Date.now() - handledAt > 800) return;
      handledAt = 0;
      e.stopPropagation();
    }, true);
  }



  // Boot
  function boot() {
    if (window.__lanzouPlusPlus__) return;

    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    window.__lanzouPlusPlus__ = true;


    if (DISABLE_ON_TOUCH) {
      log('手机端已停用，请在桌面浏览器使用');
      return;
    }

    log(NAME + ' v' + VERSION + ' 已加载');
    if (isFolderPage()) ensureSearchStyle();
    bindPasswordEnter();
    bindCheckboxEvents();
    watchFilemore();
    scan();


    const mo = new MutationObserver(debounce(function () {
      scan();
    }, 400));
    mo.observe(document.documentElement, { childList: true, subtree: true });


    [600, 1500, 3000, 6000, 12000].forEach(function (t) { setTimeout(scan, t); });


    window.LZPP = {
      version: VERSION,
      items: items,
      scan: scan,
      resolve: resolveDirect,
      setStatus: setStatus,
      get lastTp() { return state.lastTp; },
      debug: function () {
        const arr = Array.from(items.values());
        console.table(arr.map((i) => ({ 文件名: i.label, 直链: !!i.direct, 已选: i.checked, 行标签: i.row ? i.row.tagName : '-' })));
        return arr;
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

