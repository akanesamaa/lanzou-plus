// ==UserScript==
// @name         Lanzou++
// @namespace    https://github.com/akanesamaa/lanzou-plus
// @version      1.0.1
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

  /* =========================================================
   * 0. 常量
   * ======================================================= */
  const NAME = 'Lanzou++';
  // 改版本时和文件头的 @version 一起改（管理器只认 @version，VERSION 只用于显示）
  const VERSION = '1.0.1';
  const DOWNLOAD_GAP = 1500;   // 普通下载间隔；Chromium 单窗口会放宽到 3.5s
  const WIN_CLOSE_DELAY = 10000; // 单窗口整批发完后，等 10s 再关

  /**
   * 直链带 token / sign / time，绑会话、时间、IP，过一阵就失效（服务器直接回
   * 400 Error : Time Out）。所以拿到手之后不能永久当缓存用 —— 超过这个时长
   * 就重新解析一遍。
   *
   * 10 分钟是保守值：同一轮下载里复用的直链不会太旧，同时给慢速批量留足余量。
   */
  const DIRECT_TTL = 10 * 60 * 1000;

  const ACCENT = '#0a5fbf';
  const ACCENT_SOFT = '#e8f3fd';

  /* 密码框的写法各模板不一样：有的只有 id，有的只有 type。
     统一放这里，密码页判定、取密码、回车提交都用同一份，别再各写一套 */
  const PWD_INPUT_SEL = '#pwd, input[name="pwd"], input.passwdinput, input[type="password"]';

  // 纯触摸设备（无 hover）不再支持，只保留桌面
  const isTouch = (function () {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
    catch (e) { return false; }
  })();

  // 有 hover 说明还有鼠标（触屏笔记本、平板外接键鼠），按桌面处理
  const canHover = (function () {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches); }
    catch (e) { return false; }
  })();

  /** 触摸且没有 hover = 手机/纯触屏：脚本直接停用，不注入任何 UI */
  const DISABLE_ON_TOUCH = isTouch && !canHover;

  /**
   * 浏览器内核。用来决定「静默下载」到底走哪条路。
   *
   * 直链域（lanrar.com）有一道反爬挑战页，它只在**顶层窗口**里执行。
   * 2026-10-28 实测：
   *   · Firefox 内核（Floorp）：iframe 里也能过，文件正常下下来
   *   · Chromium 内核（Chrome / Edge / Helium / Via）：iframe 里挑战页不执行、
   *     不 reload，只加载一张 4321 字节的挑战页就停住 —— 一个文件都下不来。
   *
   * 最坑的是 Chromium 上这个失败**完全静默**：跨域读不到、下载不报错、也没有
   * 任何事件，页面照样报「已发起 N」。试过「先在顶层过一次挑战把 cookie 种上
   * 再走 iframe」，也没用（挑战页每次请求都验上下文）。
   *
   * 所以 Chromium 上只能开一个顶层窗口导航过去 —— 会被用户看见，但能下下来。
   */
  const IS_GECKO = /Firefox\//.test(navigator.userAgent || '');

  /**
   * 认得的扩展名。
   *  · `part\d+\.rar` 和 `\d{3}` 是分卷压缩包：`.part1.rar`、`.zip.001`、`.7z.001`。
   *    不认这类名字的话，整条会被判成「不是文件」直接跳过。
   *  · 其余是常见的文档/媒体/安装包类型。
   */
  const FILE_EXT = 'zip|rar|7z|tar|gz|bz2|xz|zst|tgz|cab|part\\d+\\.rar|\\d{3}|' +
    'apk|exe|msi|dmg|iso|img|txt|pdf|docx?|xlsx?|pptx?|epub|mobi|azw3?|' +
    'mp[34]|m4a|flac|wav|mkv|avi|flv|wmv|mov|heic|avif|' +
    'jpg|jpeg|png|gif|webp|svg|psd|ai|c4d|blend|fbx|obj|' +
    'bin|ipa|deb|rpm|jar|whl|py|html?|ttf|otf|woff2?|json|xml|csv|md|torrent|chm';
  const FILE_NAME_RE = new RegExp('\\.(' + FILE_EXT + ')$', 'i');

  /**
   * 页面上「时间」有好几种写法，少认一种移动版就整页认不出文件：
   *   昨天23:43 / 前天 / 今天 / 刚刚        —— 近两天
   *   3 天前 / 5分钟前 / 2小时前 / 1年前    —— 更早的，蓝奏云按相对时间显示
   *   2026-10-25 / 10-25                    —— 再早或跨年
   * 移动版整行文字都在 <a> 里，尾巴剥不干净的话 `xxx.zip18.5 M3 天前`
   * 就过不了「必须以 .zip 结尾」这一关，表现是一个文件都识别不出来。
   */
  const TIME_SRC = '昨天|前天|今天|刚刚|\\d{1,2}:\\d{2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-\\d{1,2}|' +
    '\\d+\\s*(?:秒|分钟|小时|天|周|个?月|年)\\s*前';

  // 行内出现「大小」或「时间」是判断"这是一条文件记录"的关键证据。
  // 大小后面不能用 \b 收尾：移动版两个 span 的 textContent 直接拼在一起，
  // 「18.5 M」后面紧跟「3 天前」的 3，M3 之间没有词边界，\b 会判失败。
  // 数字部分要允许**多个**分隔符：真实存在「1,022.6 K」这种千分位 + 小数点
  // 的写法，只认一个的话会从中间开始匹配，只剥掉「022.6 K」
  const SIZE_RE = /\d+(?:[.,]\d+)*\s*[KMGT]B?(?![A-Za-z])/i;
  const TIME_RE = new RegExp('(?:' + TIME_SRC + ')');

  // 移动版把大小 / 时间也塞进同一个 <a> 里，判断文件名前要先剥掉尾巴。
  // 两段之间可能一个空格都没有，所以每次剥完都要再来一轮，直到不再变化
  const TAIL_TIME_RE = new RegExp('\\s*(?:(?:' + TIME_SRC + ')\\s*)+$');
  const TAIL_SIZE_RE = /\s*\d+(?:[.,]\d+)*\s*[KMGT]B?\s*$/i;

  // 「一键转存到我的网盘」不是文件，永远排除
  const BLOCK_TEXT_RE = /(一键转存|转存到|保存到.*网盘|存到网盘|我的网盘)/;
  const BLOCK_HREF_RE = /(ilanzou\.com|\/unproved\/|pd\/url)/i;

  /* =========================================================
   * 1. 工具
   * ======================================================= */
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

  /* =========================================================
   * 3. 状态
   * ======================================================= */
  const items = new Map();          // key -> { key,label,checked,anchor,row,cb,size,direct,directAt,error }
  const cbItem = new WeakMap();     // 复选框 -> 条目（事件委托用，不占 item 字段）
  const anchorItem = new WeakMap(); // 锚点 -> 条目（href 后填 / 换文件时迁移 key）
  const state = {
    running: false, stop: false, lastTp: '',
    prog: { done: 0, total: 0 },
    loading: false,      // 正在「加载全部」
    loadPending: false,  // 等待自动加载启动的 800ms
    loadStop: false,     // 点了「停止加载」
    autoLoadTried: false, // 这次进入文件夹已经自动发起过「加载全部」
    noMore: false,       // 已经确认过「没有更多了」
    lastPage: null,      // 站点自己那次 /filemoreajax.php 的回执（见 watchFilemore）
    pagePending: false,  // 站点的翻页请求还在飞（这时绝不能补点同一页）
    pageGap: 1800,       // 「加载全部」的自适应间隔（见 PAGE_GAP_MIN/MAX），跨轮保留
  };

  /* =========================================================
   * 4. 文件行识别
   * ======================================================= */
  /**
   * 从链接文字里取出文件名。
   * 桌面版：<a>name.zip</a>，大小和时间是兄弟节点；
   * 移动版：<a class="mlink">name.zip<div class="mmr"><span>11.2 M</span><span>昨天23:43</span></div></a>
   *        —— 整行都在 <a> 里，所以要把尾巴上的大小 / 时间剥掉再判断。
   */
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

  /**
   * 从 <a> 里取「名字」那一段，只读直属的文字节点。
   *
   * 移动版把大小和时间塞在同一个 <a> 里的 `.mmr` 里，直接读 textContent 会
   * 糊成「Purple.zip1,022.6 K2020-07-22」，只能靠正则往回剥。剥不干净的
   * 例子是真实存在的：`1,022.6 K` 既有千分位逗号又有小数点，而大小正则
   * 只认一个分隔符，于是只剥掉「022.6 K」，留下「Purple.zip1,」——
   * 扩展名对不上，1785 个文件里就这么漏了 3 个。
   *
   * 名字本来就是一个独立的文本节点，只取它就不会有这个问题。
   * 别的模板把名字包进 <span> 的，直属文字为空，退回 textContent 走原来那套剥离。
   */
  function nameTextOf(a) {
    let s = '';
    for (let n = a.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) s += n.nodeValue;
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s || (a.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 名字太长时站点自己截断成「xxx...」，扩展名跟着没了 */
  const TRUNC_RE = /(?:\.\.\.|…)\s*$/;

  /** 这一行确实是个文件吗（有文件类型图标，或者地址就是 /iXXXX 这种文件页） */
  function hasFileIcon(a) {
    const img = a.querySelector('img');
    if (img && /filetype\//i.test(img.getAttribute('src') || '')) return true;
    return /^\/?i[0-9A-Za-z_-]{5,}$/.test((a.getAttribute('href') || '').trim());
  }

  /**
   * 一个 <a> 到底代表哪个文件（不是文件就返回空串）。
   *
   * 必须**只在这一处**判断，别的地方一律调它。曾经 scan() 认得被截断的名字、
   * 而 countFileAnchors() 另用一套更严的判据，结果那一行的 .mbx 被判成
   * 「0 个文件」，pickRow 一路往上爬到整个列表容器，把 #infos 当成这一行 ——
   * 大小取成了列表里第一个文件的，后面几行还会因为「这个容器已经用过了」被丢掉。
   */
  // anchor -> { raw, name }：名字文字没变就不必再跑一遍那串正则。
  // 只缓存「认出来的」，认不出的（导航链接之类）照旧每次重算，
  // 免得站点晚一步才把地址 / 图标填上时被旧结论卡住
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
    // 名字被站点截断成「xxx...」时扩展名跟着没了，FILE_NAME_RE 必然不认。
    // 但这一行确实是文件：有文件类型图标、地址就是 /iXXXX。用截断后的文字
    // 当标签照样能下 —— 下载靠的是地址，不是名字。
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
        // 调用方只关心「是不是恰好 1 个」，数到 2 就没必要再解析剩下的锚点了
        if (cap && n > cap) return n;
      }
    }
    return n;
  }

  /**
   * 整行文字规范化。只压空白，不做别的加工。
   *
   * 单看它分不出「站点重复加载的行」和「两个真的一模一样的文件」——
   * 实测这个文件夹里就有两行文字完全相同、却是两个不同文件的情况，
   * 所以它只能和文件地址一起用（见 scan 里的去重判据）。
   */
  function normRowText(row) {
    return String((row && row.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  /** 「整格就是一个大小 / 时间」——不能只判「文字里出现 K/M/G」，
      文件名里常有 `(40k 16X16)` 这种，会把名字单元格误认成整行 */
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

  /**
   * 从文件名链接向上找"行"容器：
   * 该容器里恰好只有 1 个文件名链接，且带有大小 / 时间信息。
   */
  const rowCache = new WeakMap();   // anchor -> 它所属的行容器

  function pickRow(anchor) {
    // 快路径：上一轮已经找到过。只认「这行还装着这个链接」的缓存 ——
    // 站点重绘会把整行换成新节点，旧行 contains 不到链接，自动重新找
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

    /* 兜底：万一碰到还没见过的模板，把大小/时间写成**裸文字**（没有独立
       节点），hasMeta 一个都找不到。这时退回老的「文字里出现大小/时间」
       判据 —— 宁可个别行大小不准，也不要把整页文件都漏掉。
       已知模板（桌面版 #size、移动版 .mmr）都会在上面那一轮命中，
       走不到这里。 */
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

  /**
   * 从一行文字里抠出文件大小（字节）。蓝奏云「11.2 M」和「1.2 MB」两种写法都有。
   * 收尾用 (?![A-Za-z]) 而不是 \b：移动版里大小后面紧跟着时间，`18.5 M3 天前` 的
   * M3 之间没有词边界，用 \b 会整条判失败、大小显示不出来。
   */
  function sizeOf(text) {
    const m = String(text || '').match(SIZE_RE);
    if (!m) return 0;
    /* 分隔符要分开处理：真实数据里有「1,022.6 K」这种千分位 + 小数点混着的，
       直接 replace(',', '.') 会变成 1.0226。判断依据是「最后一个分隔符是小数点」 */
    let s = m[0].replace(/[^\d.,]/g, '');
    const ci = s.lastIndexOf(',');
    const di = s.lastIndexOf('.');
    if (ci > -1 && di > -1) {
      s = ci > di ? s.replace(/\./g, '').replace(/,/g, '.')   // 1.022,6（欧式）
                  : s.replace(/,/g, '');                       // 1,022.6（英式）
    } else if (ci > -1) {
      // 只有一个逗号：三位一组当千分位，否则当小数点
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

  /**
   * 从「一整行」里取大小。
   *
   * 不能直接 sizeOf(row.textContent)：那用的是**第一个**匹配，而文件名里
   * 经常出现大小样的字串 —— 实测这个文件夹里的
   * `§b§lSpreenDMC mashz V3 (40k 16X16).rar`，真实大小是 12.5 M，
   * 老逻辑抓到的却是名字里的「40k」，命令条上显示 40K。
   *
   * 优先用「只装大小」的那个格子（桌面版 #size / 移动版 .mmr 里的 span），
   * 取不到再退回整行里**最后一个**匹配：真正的大小一定在文件名后面、
   * 时间前面，而时间不带 K/M/G 单位。
   */
  function sizeOfRow(row) {
    const cell = row && row.querySelector
      ? row.querySelector('#size, .mmr span, .files span')
      : null;
    const cellText = cell ? (cell.textContent || '') : '';
    if (/^\s*\d+(?:[.,]\d+)*\s*[KMGT]B?\s*$/i.test(cellText)) return sizeOf(cellText);

    const all = String((row && row.textContent) || '').match(new RegExp(SIZE_RE.source, 'gi')) || [];
    return sizeOf(all.length ? all[all.length - 1] : '');
  }

  /** 字节数 → 命令条上那一小截：860K / 128M / 1.4G */
  function fmtSize(bytes) {
    if (!bytes) return '';
    const k = 1024;
    if (bytes < k * k) return Math.round(bytes / k) + 'K';
    if (bytes < k * k * k) return +(bytes / (k * k)).toFixed(1) + 'M';
    return +(bytes / (k * k * k)).toFixed(1) + 'G';
  }

  /* =========================================================
   * 5. 扫描 & 注入复选框
   * ======================================================= */
  function scan() {
    dropBlocked();

    // 单文件页 /iXXXX 整页只有一个文件，没有「批量」可言，
    // 连复选框都不该往里插。
    // 推广位在上面已经清掉了，和文件夹页保持一致
    if (isSingleFilePath()) return;

    const anchors = $$('a');
    const usedRows = new Set();
    const seenName = new Map();   // 同名文件在这一轮里是第几个，用来给 key 加序号
    const seenRow = new Set();    // 已经见过的「整行文字 + 地址」，用来认出站点重复加载的行
    const seenKeys = new Set();   // 这一轮扫到的 key，清理时用来保命
    let added = 0;
    let dup = 0;

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      // 广告行：站点会给推广条目的名字后面塞 <span class="s_ad">推广</span>，
      // 地址也不是文件页。它永远不是文件，别给它插复选框
      if (a.querySelector('.s_ad')) continue;

      const name = nameOfAnchor(a);
      if (!name) continue;

      // 找不到独立的行容器就退化为链接本身 —— 别退到 parentElement，
      // 否则多个文件共用同一个"行"，第二个起就全被当成重复项丢掉了
      const row = pickRow(a) || a;
      if (!row || usedRows.has(row)) continue;
      usedRows.add(row);

      // —— 先看这一行是不是站点重复加载出来的 ——
      //
      // 站点连点「显示更多文件」时自己不防抖，同一页会被请求两次，列表里就长出
      // 两行一模一样的文件（实测间隔 80ms 连点 3 次，新增 150 行里有 52 行重复）。
      // 这种行要是各算一条，全选就会把同一个文件下两次。
      //
      // 判据必须「整行文字 + 文件地址」两个都一样，少一个都不行：
      //   · 只看文字会把真文件并掉。这个文件夹里就有两行文字完全相同、却是两个
      //     不同文件的（`! §bApxXDnt V3 §f[Revamp] §4RED.zip`，10.9 M，2020-08-11，
      //     地址分别是 /iw9CHfijq9c 和 /iTv5mfij6xg）。并掉就是少下一个文件，
      //     而且少下比多下更难被发现。
      //   · 只看地址也不行，有的模板先给 javascript:;，那样所有行地址都一样。
      //
      // 地址取不到时干脆不做去重判断，宁可多算一条。
      const href = itemUrl({ anchor: a });
      if (href) {
        const fp = href + '\u0001' + normRowText(row);
        if (seenRow.has(fp)) { dup++; continue; }
        seenRow.add(fp);
      }

      // —— 再算 key ——
      //
      // 优先用文件地址：同一个文件夹里确实会有同名文件（实测 110 组、最多 3 份），
      // 只用名字会互相抢复选框；而 /iXXXX 是稳定的，删行、筛选、换页都不会变。
      //
      // 但有的模板先给 javascript:;，等页面 JS 跑完才填真实地址。所以：
      //   · 拿得到地址 → 'u:' + 地址
      //   · 拿不到     → 退回 'f:' + 文件名 + 这一轮里第几个同名
      // 同一个锚点上一轮用的是什么 key 记在 anchorItem 里：站点晚一步填地址、
      // 或者把这一行换成别的文件时，直接把旧条目迁到新 key，不会变出两条。
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
        // 站点重绘后行节点会换人，缓存的着色/显示状态跟着作废，
        // 否则会把上一个节点的状态带到新节点上
        if (item.row !== row) {
          item.row = row;
          item._paints = undefined;
          item._disp = undefined;
          item._painted = undefined;   // 新节点要重新刷一次底色
          rowChanged = true;
        }
      }
      // 大小跟着行一起更新：页面重新渲染后节点会换，但文件名不变。
      // 量到过一次就不再量（同一 key 的文件大小是常量，而 textContent
      // 序列化 1785 行是 scan() 里除了正则以外最贵的一步）；
      // 换行节点时才重量，免得过滤 / 换页后把旧大小留在新行上
      if (rowChanged || !item.size) item.size = sizeOfRow(row) || item.size || 0;
      item._href = href;
      anchorItem.set(a, item);
      injectCheckbox(item);
    }

    // 这一轮真认出了文件，才敢清理「已经不在页面上」的旧条目。
    // 站点重绘时会有一瞬间列表是空的，那会儿要是照清不误，
    // 每次重绘都会把用户的勾选清掉。
    if (usedRows.size > 0) pruneGone(seenKeys);

    if (added > 0) log('新增 ' + added + ' 个文件，当前共 ' + items.size + ' 项');
    if (dup > 0) log('跳过 ' + dup + ' 个重复行（站点重复加载同一页造成的）');
    render();
  }

  /* =========================================================
   * 5.5 加载全部
   * ---------------------------------------------------------
   * 站点一页 50 条，1785 个文件要点 35 次「显示更多文件」。
   * 这个功能就是替用户点：点一下按钮，脚本连着点到底。
   *
   * 判据分两层：
   *   ① 站点自己的回执（watchFilemore 在 XHR 上读到的 zt / text 条数）：
   *      `zt:1` 且这一页不足 50 条 = 真正的最后一页。
   *   ② 读不到回执（老模板 / 没走 XHR）时，退回「点完行数涨不涨」+ pgs。
   *
   * 2026-10-28 把站点自己的 more() 扒出来看过：
   *
   *     $('#filemore').text('文件获取中...');          // 发请求前先把文字改掉
   *     success: if (msg.zt == '1') {
   *                if (data.length < 50) filemore.style.display = 'none';   // 藏
   *                else $('#filemore').text('显示更多文件');                 // 恢复
   *              } else filemore.style.display = 'none';                    // 藏
   *     error:   $('filemore').text('获取失败，请重试');   // ← 选择器少了 #
   *
   * 于是：
   *   · 「文件获取中...」不是加载中的标志，是**请求没回来**的标志 ——
   *     成功会改回去，失败（error 分支选择器写错，改不动）就永远卡在这。
   *   · `display:none` 不等于「没有更多」！实测第 30 页被服务端拒了一次
   *     （zt != '1'），站点当场把按钮藏了，可后面还有 285 个文件。
   *     藏起来的按钮照样能 click()，行数照样涨。
   *   · 总数正好是 50 的整数倍时，最后一页返回整 50 条，按钮一直是 block，
   *     再点一次才会拿到「不足 50」的回执 —— 那一次不能当失败。
   *
   * `zt:4` 尤其不能当结束：2026-11-14 在 1785 个文件（36 页）的真实文件夹上，
   * 请求稍快就会拿到 `{zt:4, info:"请刷新，重试0", text:0}`，隔一两秒再请求
   * 同样的页码却能正常返回 50 条 —— 它是限流，不是「到头」。把它当结束，
   * 列表会直接截断在第一页。
   *
   * 所以失败（含 zt=4）一律递增退避重试，连续几次都不成才停成「加载未完成」。
   * 不再提供「继续加载」按钮：打开文件夹后默认自动跑一次，退避和限流
   * 处理都在；用户点「停止」后本轮不再自动重试。
   * ======================================================= */

  /**
   * 单页最多等多久。
   *
   * 平时 100~200ms 就回来，但**会慢**：实测有一轮某页超过 1.5 秒才到，
   * 限流时更久。等太短会把它判成失败、补发一个重复请求，反而更慢，
   * 还会让站点把同一页追加两遍、页码多跳一页（实测丢过 50 个文件）。
   * 4 秒 + 下面「退避后再确认」是实测能稳住的值。
   */
  const PAGE_WAIT = 4000;

  /**
   * 两次点击之间的间隔：自适应。
   *
   * 2026-11-14 在真实 Helium 上跑这个 1785 页的文件夹：固定 700ms 大约到
   * 第 10 页就被限流，连点 4 次都失败后停在「加载未完成」，只加载到 500 个。
   * 但同一台机器上 1~2.6 秒的间隔能连续翻几十页 —— 说明它是按请求速度限的，
   * 不是「到第 N 页就断」。
   *
   * 所以：每成功一页就把间隔收一点（最低 1.2s），每失败一次就放宽 0.6s
   * （最高 4s）。跑长了会自己停在站点能接受的速度上。
   */
  const PAGE_GAP_MIN = 1200;
  const PAGE_GAP_MAX = 4000;

  /** 失败（含 zt=4 限流）后第 n 次重试前等多久：3s → 6s → 12s → 24s → 30s 封顶 */
  function backoffMs(n) {
    return Math.min(30000, 3000 * Math.pow(2, n - 1));
  }

  /** 连续几次都没成（含限流）就停成「加载未完成」 */
  const STRIKES = 6;

  /**
   * 站点那个「显示更多文件」还在不在。
   *
   * 故意不看 display —— 上面那段注释里写了，它藏起来不代表没得点了。
   */
  function moreBtn() {
    return document.getElementById('filemore');
  }

  /**
   * 站点自己的页码计数器（`window.pgs`）。
   *
   * 这是判断「这一页请求到底成没成」唯一客观的东西。站点 `file()` 里
   * `pgs++` 只写在 success 分支里，而且是**在** `data.length<50 → 藏按钮`
   * 之后才执行；被服务端拒（`zt != '1'`）和网络报错都不涨。
   *
   * 为什么非要用它：站点在「返回不足 50 条」和「请求被拒」两种情况下做的
   * 事一模一样 —— 都是 `display:none` + 文字卡在「文件获取中...」，光看
   * DOM 分不出来。以前只能靠「点之前按钮是露着的」这种间接推断，推断错了
   * 就会出现「明明还有几百个文件，自动加载却没反应」。
   *
   * 别的模板没有这个变量就返回 null，调用方退回原来那套判据。
   */
  function sitePg() {
    const v = window.pgs;
    return typeof v === 'number' ? v : null;
  }

  /**
   * 把站点自己那次 /filemoreajax.php 的原始回执读下来。
   *
   * 注意：**`zt:4` 不是「到头」**。实测在 1785 个文件的文件夹上，请求稍快
   * （连续点、间隔不到 1 秒）就会拿到 `{zt:4, info:"请刷新，重试0", text:0}`，
   * 隔一会儿再请求同样的页码却能正常返回 50 条。它更像限流 / 需要缓一下，
   * 把它当结束会把列表截断在第一页。
   *
   * 唯一可靠的「最后一页」是：`zt:1` 且这一页不足 50 条。
   * `zt:4` 只用来触发退避重试；`zt` 是别的值就当普通失败。
   *
   * jQuery 走的是 XMLHttpRequest，所以在原型上挂一次就够（见 boot）。
   */
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
        // 网络层失败也要清掉，不然 loadAll 会一直以为还有请求在飞
        ['error', 'abort', 'timeout'].forEach(function (ev) {
          self.addEventListener(ev, finish);
        });
      }
      return send.apply(this, arguments);
    };
    X.prototype.__lzppHooked = true;
  }

  /**
   * 站点自己说「没有更多了」了吗。
   *
   * 只在**这一页确实加载出新行之后**才可信：站点在「返回不足 50 条」时
   * 会把按钮藏起来，那是真到头了。而请求被服务端拒掉时它也藏，那种情况
   * 行数不涨，不能当数（实测藏起来之后还能再翻 285 个文件）。
   */
  function siteSaysDone() {
    const b = moreBtn();
    if (!b) return true;
    try {
      return getComputedStyle(b).display === 'none';
    } catch (e) {
      return false;
    }
  }

  /**
   * 列表里现在有多少行。
   * 用 DOM 行数而不是 items.size：万一新加载的行格式不认识，items 不涨，
   * 会被误判成「没有更多了」。DOM 行数是客观的。
   */
  function rowCount() {
    const n = document.querySelectorAll('#infos > div[id=ready]').length;
    return n || items.size;
  }

  /** 等行数真的涨上去 */
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

  /* 站点「显示更多文件」不再替换成我们的按钮；自动加载直接点它，视觉上隐藏。 */

  async function loadAll() {
    if (state.loading) { state.loadStop = true; return; }   // 再点一次 = 停止
    if (state.running || state.noMore || !moreBtn()) return;

    state.loading = true;
    state.loadPending = false;
    state.loadStop = false;
    updateUI();   // 命令条立刻切成「加载中」
    setStatus('加载中');

    const startRows = items.size;   // 拿条目数，跟最后报的数同一把尺子
    let miss = 0;       // 连续几次点下去行数没涨
    let pages = 0;
    let ended = '';     // 'gone' 站点说没了 / 'stall' 点不动了

    // 服务端抽风能持续十几秒，一两次点不动就收手，用户只会拿到一部分文件
    // 还以为下完了。连续几次都不成才停成「加载未完成」
    const strikes = STRIKES;

    while (!state.loadStop) {
      const btn = moreBtn();
      if (!btn) { ended = 'gone'; break; }

      const before = rowCount();
      const pg0 = sitePg();
      state.lastPage = null;   // 别把上一页 / 解锁那次的回执当成本次结果
      // 点之前站点那个按钮是露着的吗？藏起来之后站点自己不会再恢复，
      // 所以只有「点之前露着、点完之后藏了」才能认定是这一页干的
      const wasShown = !siteSaysDone();
      try { btn.click(); }
      catch (e) { ended = 'gone'; break; }

      const grew0 = await waitRowsGrow(before, PAGE_WAIT);
      if (state.loadStop) break;
      let grew = grew0;

      /* 请求还在飞的时候绝对不能补点：站点会把同一页追加两遍、页码多跳一格，
         行数看着没问题，实际整页文件被跳过（实测 1785 行只认出 1735 条）。
         最多再等 8 秒；真挂了才当失败。 */
      if (!grew && state.pagePending) {
        const tPending = Date.now();
        while (state.pagePending && !state.loadStop && Date.now() - tPending < 8000) {
          await sleep(200);
        }
        grew = rowCount() > before;
        if (state.loadStop) break;
      }

      /* 有回执就先信回执（见 parsePageReply）：只有「zt=1 且不足 50 条」
         才是真的最后一页。zt=4 是限流，必须退避重试，不能当结束 —— 实测
         1785 个文件的文件夹，连续请求会被拒，隔一两秒再请求同样页码就正常。
         没有回执（老模板 / 拦截不到 XHR）才退回原来那套判据。 */
      const reply = state.lastPage;
      const pg1 = sitePg();
      const known = pg0 !== null && pg1 !== null;
      const ok = reply ? reply.ok : (known ? pg1 > pg0 : grew);

      if (grew) {
        miss = 0;
        pages++;
        setStatus('加载中');
        updateUI();
        // 这一页真加载出了新行，同时站点把按钮藏了 —— 是这一页的响应藏的，
        // 说明「返回不足 50 条」，真到头了。
        // 必须要求「点之前露着」：站点藏了之后不会自己恢复（success 分支
        // 只在 >=50 条时改文字，不动 display），被拒过一次之后按钮一直是藏的，
        // 那样每次成功都会被误判成到头
        if (reply ? reply.end : (wasShown && siteSaysDone())) { ended = 'gone'; break; }
        // 这一页顺利，间隔往回收一点；连着失败时会放宽（见下面的 else）
        state.pageGap = Math.max(PAGE_GAP_MIN, state.pageGap - 100);
        await sleep(state.pageGap);
      } else if (ok) {
        /* 请求成功了，却一条新行都没回来 —— 服务端返回 0 条。
           这才是「真到头」，可以放心收。 */
        ended = 'gone';
        break;
      } else {
        /* 请求没成：限流（zt=4）、网络抖、或者站点那个 error 分支。
           这**不代表到头**。先把间隔放宽，再递增退避重试：瞬时限流通常
           一两秒就恢复，固定 700ms 在 1785 个文件（36 页）时大约第 10 页
           就会撞上，一停用户就只拿到 500 个文件还以为下完了。 */
        state.pageGap = Math.min(PAGE_GAP_MAX, state.pageGap + 600);
        miss++;
        if (miss >= strikes) { ended = 'stall'; break; }
        await sleep(backoffMs(miss));

        /* 退避这段时间里，刚才那一页可能才回来。先确认再决定要不要补点：
           直接再点一次的话，站点会把同一页追加两遍、页码多跳一格，
           行数看着一样，实际整页文件被跳过（实测 1785 行只认出 1735 条）。 */
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

    /* 有的响应会晚到 —— 实测慢的时候要两三秒，比判定超时还晚，
       那样行数会在状态行写好之后又涨一截。先等它落定，再一次性更新
       加载状态和行数。这期间 state.loading 还是 true，界面一直显示加载中。
       停止与否在等之前就定下来：这 700ms 里再点一下不该把已经跑完的
       这一轮报成「已停止」 */
    const stopped = state.loadStop;
    await sleep(700);

    state.loading = false;
    state.loadStop = false;

    /* 判定到底了。只有「站点说没了」才算数 —— 那是 pgs 涨了、服务端明确
       返回不足一页，可以放心收起来。
       'stall' 只是「点不动」，多半是服务端在拒，后面往往还有几百个文件。
       所以这里不把 noMore 设成 true，页面重进/重新加载时还能继续尝试。 */
    if (ended === 'gone') state.noMore = true;

    scan();   // 把最后一批也扫进来

    /* 报数用 items.size，不用 rowCount()。
       rowCount() 数的是 DOM 行数，站点重复渲染出来的同一行也会算进去；
       用户真正能勾、能下的是 items 里那些。两边报不一样的数（「共 1785 个」
       配着「已选 0 / 1782」）会让人以为丢了三个文件。 */
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

  /**
   * 删掉已经不在页面上的条目。
   *
   * 什么时候会需要：站点在同一页里换页 / 筛选（ajax 换掉整个列表）。
   * 不清的话条目会跨页累积，全选会选到上一页的文件，统计也不对。
   *
   * 判据用 anchor.isConnected：节点真被移出文档才算消失。
   * 被 display:none 藏起来的不算 —— 那种情况文件还在，勾选也该留着。
   */
  function pruneGone(seen) {
    let gone = 0;
    items.forEach(function (it, key) {
      // 这一轮又扫到了 → 文件还在页面上，别动。哪怕它换了节点
      // （站点重绘会把整行换掉，旧锚点就 disconnected 了），只要文件名还在，
      // 条目就得留着 —— 不然 1785 个文件里会莫名其妙少几条
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

    // 快路径：item 上记着的框还挂在这个容器里，就什么 DOM 都不用查。
    // 重扫时 1785 行每行都会走一遍这里，慢路径那几次查询 / textContent
    // 序列化叠起来才是 scan() 的大头
    let cb = (item.cb && item.cb.parentElement === host) ? item.cb : null;
    if (!cb) {
      // 这个父容器是不是"就管一行"（移动版是 .mbx，桌面版是文件名单元格）。
      // 不是的话（锚点直接挂在列表容器下）就不能动它的 display，
      // 也不能按容器找已有复选框，否则多行会共用一个框、整页被压成一行。
      const rowScoped = countFileAnchors(host, 1) === 1;

      // 先看这个容器里是不是已经插过了。一行一个容器时这么找最稳 ——
      // 站点重绘、同名文件、重复扫描都不会再插第二个。
      // 多行共用一个容器时不能这么找（会抓到别的行的框），只能认 item 上记的那个。
      cb = (rowScoped && host.querySelector('input.lzpp-cb')) || null;
      if (!cb) cb = buildCheckbox(item, host, rowScoped);
    }

    cb.checked = item.checked;
    item.cb = cb;
    cbItem.set(cb, item);   // 事件委托靠它找回条目
    paint(item);
  }

  /** 真正造一个复选框。只在「这一行还没有框」时才走到，每行最多一次 */
  function buildCheckbox(item, host, rowScoped) {
    // 移动版整个文件行都包在 <a> 里（图标 + 文件名 + 大小 + 时间），
    // 复选框只能插到 <a> 外面，再把行容器改成 flex，才能跟文件并排。
    // 判据是「<a> 里有没有独立的大小 / 时间节点」，不是「文字里有没有 K/M/G」——
    // 后者会被文件名里的 (40k 16X16) 骗到，把桌面版的名字单元格也改成 flex
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

    // 一行一个容器时放在最前面（在图标之前），视觉上就是"文件前面"；
    // 多行共用一个容器时只能紧贴自己的链接插，免得几个框挤到列表顶部
    if (rowScoped) host.insertBefore(cb, host.firstChild);
    else host.insertBefore(cb, item.anchor);

    return cb;
  }

  /**
   * 复选框的事件统一在这里委托，而不是每行挂 7 个。
   *
   * 1785 行就是 12,495 个监听器（实测首次扫描 addEventListener 调用 12,522 次），
   * 站点每次重绘还要重挂一遍。捕获阶段拦一下，站点祖先节点上的点击逻辑同样
   * 收不到（默认的勾选行为和 change 事件不受影响）。
   */
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
    // 状态没变就别碰样式：每轮重扫都会调到这里，1785 行写一遍是白费的
    if (item._painted === item.checked) return;
    item._painted = item.checked;

    const row = item.row;
    if (!row || !row.style) return;

    /* 桌面模板的 #ready 子元素全是 float，容器本身高度是 0（实测 0px，
       子列各 43px）。只刷 row 的背景等于什么都没画，所以把行和它的直接
       子元素一起刷，各自记住原色。 */
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

  /* =========================================================
   * 6. 清理推广位
   * ======================================================= */

  /** 「一键转存到我的网盘」这类推广位，永远不当作文件 */
  function isBlockedLink(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const href = el.getAttribute ? (el.getAttribute('href') || '') : '';
    return BLOCK_TEXT_RE.test(text) || BLOCK_HREF_RE.test(href);
  }

  /** 把推广位从页面上摘掉（电脑版本来就不显示，手机版有） */
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

  /* =========================================================
   * 7. 批量下载（直链解析）
   *
   * 蓝奏云的下载页结构（2026-10 实测）：
   *   文件页 /iXXXX  ── 内含 <iframe class="ifr2" src="/fn?token">
   *   /fn 页        ── 内联 JS 带 wp_sign / ajaxdata，POST 到
   *                    https://apifile.woozooo.com/ajaxfile.php
   *                    返回 {zt:1, dom, url}，真实直链 = dom + "/file/" + url
   *
   * 注意：文件页里有 `if (window!=top) top.location.href = ...` 的防嵌套代码。
   * 所以要么只 fetch 文本（不渲染），要么放进 **sandbox 且不给
   * allow-top-navigation** 的 iframe —— 后者它顶不掉父页面，安全。
   * ======================================================= */

  const API_HOSTS = [
    'https://apifile.woozooo.com/ajaxfile.php',
    'https://apifile.lanzouw.com/ajaxfile.php'
  ];

  function pick(re, s) {
    const m = String(s || '').match(re);
    return m ? m[1] : '';
  }

  /** 蓝奏云的反爬挑战页（acw_sc__v2）：一段混淆 JS，跑完才给真页面 */
  function looksLikeChallenge(html) {
    return /arg1\s*=/.test(html) && /acw_sc__v2|function\s*\(a,\s*c\)/.test(html);
  }

  /**
   * 用隐藏 iframe 真把页面加载一遍，直到 until(doc) 返回真值。
   *
   * 为什么要这一步：挑战页（acw_sc__v2）必须执行里面的混淆 JS，
   * 它算好 cookie 再 location.reload()，服务器才肯给真页面。
   * fetch() 只拿到那段文本、不会执行，所以重试多少次都是同一段挑战页。
   *
   * sandbox 里故意不给 allow-top-navigation：
   * 文件页里有 `if (window != top) top.location.href = ...` 的防嵌套代码，
   * 不给这个权限它就顶不掉我们的页面，只会自己抛个错。
   *
   * 返回 { hit, html }：命中时 hit 是 until 的返回值；超时则 hit 为 null，
   * 但 html 里带着最后一次看到的页面内容，调用方还能拿去做指纹诊断。
   */
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

      // 只用一条轮询链：以前 load 回调和初始 setTimeout 各自续 tick，
      // 同一个 iframe 上会同时跑 2~3 条，纯属白费
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

  /**
   * 把一页 HTML 拿到手。
   *
   * 顺序：fetch → 命中挑战页就用 iframe 让浏览器自己把 cookie 种上 →
   * 再回头 fetch 一次（这次带上了新 cookie，通常就过了）。
   * 不再依赖 iframe 自己刷新成功，两条路都能走通。
   */
  async function fetchText(url) {
    let first = null;
    try {
      first = await tryFetch(url);
      if (!looksLikeChallenge(first.text)) return first;
    } catch (e) {
      log('fetch 失败，改用隐藏 iframe：' + url + ' · ' + ((e && e.message) || e));
    }

    if (first) log('碰到反爬挑战页，先用隐藏 iframe 过验证：' + url);

    // ① 让浏览器真加载一遍：挑战页会自己算 cookie、自己刷新
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

    // ② iframe 没刷新成也没关系：cookie 已经种上了，再 fetch 一次
    try {
      const again = await tryFetch(url);
      if (!looksLikeChallenge(again.text)) return again;
    } catch (e) {}

    // ③ 还是挑战页：把拿到的东西交回上层，让它带着指纹报错
    if (snap.html) return { text: snap.html, url: url };
    throw new Error('被反爬拦住了，刷新页面后再试');
  }

  /** 调下链接口，拿到真实文件地址 */
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

  /** 页面上已经填过的分享密码（文件夹解锁 / 单文件密码页都可能是同一个） */
  function currentPassword() {
    const el = document.querySelector(PWD_INPUT_SEL);
    return el && el.value ? el.value : '';
  }

  /**
   * 移动版链路：文件页 → /tp/<id>?webtp=<token>。
   * 这个页面有两种形态：
   *   ① 直链形态（从文件夹列表点进去，链接带 ?webpage= 时）：
   *        var vkjxld = 'https://xxx.lanrar.com/file/';
   *        var hyggid = '?BmBb...';   // 自带问号，拼起来就是直链
   *   ② 密码形态：var vidksek = '...' + ajaxfile.php?file=<fid>，
   *        POST 参数是 action / sign / p / kd（和桌面版那套 websign 不同）
   */
  async function resolveViaTp(tpUrl) {
    const tp = await fetchText(tpUrl);
    state.lastTp = tp.text;   // 出问题时可在控制台看 LZPP.lastTp
    return await parseTpPage(tp.text);
  }

  /** 解析移动版下载页（/tp）的 HTML，两种形态都认 */
  async function parseTpPage(html) {
    state.lastTp = html;

    // ① 页面上已经拼好的完整直链
    const full = pick(/(https?:\/\/[^"'\s<>]+\/file\/\?[^\s"'<>]{20,})/i, html);
    if (full) return full;

    // ② 密码形态：var vidksek + ajaxfile.php?file=<fid>
    //    先判它，因为它的特征最硬；直链形态那套特征在密码页里也可能零散出现
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

    // ③ 直链形态：var vkjxld = '.../file/'  +  var hyggid = '?BmBb...'
    //    变量名每次请求都会变，所以只认值的形状，引号单双都吃。
    //    hyggid 是一段 base64，字符里可能出现 / 和 + 和 =，
    //    所以千万别用字符白名单（之前就栽在漏了 / 上，导致时好时坏），
    //    直接「引号之间、以 ? 开头、不夹引号和空白」就算数。
    const base = pick(/(https?:\/\/[^"'\s<>]+\/file\/)/i, html);
    const qs = pick(/["'](\?[^"'\s]{16,})["']/, html);
    if (base && qs) return base + qs;

    // 带上指纹，方便定位是哪种没见过的页面
    throw new Error('移动版结构变了（页长 ' + html.length +
      ' · 挑战页 ' + (looksLikeChallenge(html) ? '是' : '否') +
      ' · base ' + (base ? '有' : '无') +
      ' · token ' + (qs ? '有' : '无') +
      ' · sign ' + (sign ? '有' : '无') + '）');
  }

  /** 新模板链路：/fn?token 页里带 wp_sign / ajaxdata */
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

  /** 在 iframe 里真加载出来的文件页 DOM 上找下载入口 */
  function probeFileDoc(doc) {
    // 移动版：<a id="ddown"> 的 href 被页面 JS 改成了 /tp/<id>?webtp=<token>
    // 初始值是 /tp/#<文件号>，带 # 的说明 JS 还没跑，不能要
    const a = doc.getElementById('ddown') || doc.querySelector('a[href*="/tp/"]');
    const h = a ? (a.getAttribute('href') || '') : '';
    if (/\/tp\/[A-Za-z0-9_\-]{4,}/.test(h)) return { tp: h };

    // 桌面版：<iframe class="ifr2" src="/fn?token">
    const f = doc.querySelector('iframe[src*="/fn?"]');
    if (f) {
      const src = f.getAttribute('src') || '';
      if (src) return { fn: src };
    }
    return null;
  }

  /** 把一个文件页解析成真实直链 */
  async function resolveDirect(fileUrl) {
    const page = await fetchText(fileUrl);
    const html = page.text;

    // ⓪ 有的情况下服务器直接把文件页重定向到 /tp 下载页，
    //    这时拿到的就是下载页本身，别再当文件页去解析
    if (/\/tp\//i.test(page.url)) {
      return await parseTpPage(html);
    }

    // ① 新模板：文件页里嵌着 /fn?token
    const fnPath = pick(/<iframe[^>]+src="([^"]*\/fn\?[^"]+)"/i, html) ||
      pick(/(\/fn\?[A-Za-z0-9_\-]+)/i, html);
    if (fnPath) return await resolveViaFn(new URL(fnPath, page.url).href);

    // ② 移动模板：文件页里是 /tp/<id>?webtp=token
    //    token 的字符集不确定，别用白名单卡死，直接吃到分隔符为止
    const tpPath = pick(/(\/tp\/[A-Za-z0-9_\-]+(?:\?webtp=[^\s"'&<>\\]+)?)/i, html);
    if (tpPath) return await resolveViaTp(new URL(tpPath, page.url).href);

    // ③ 旧模板：页面里直接有 isngis（需要分享密码）
    const sign2 = pick(/isngis\s*=\s*'([^']+)'/i, html);
    const fid2 = pick(/ajaxfile\.php\?file=(\d+)/i, html);
    if (sign2 && fid2) {
      const pwd = currentPassword();
      if (!pwd) throw new Error('该文件需要分享密码，请先在页面上输入密码');
      return await postDown(fid2, { action: 'downprocess', sign: sign2, kd: '1', p: pwd });
    }

    // ④ 文本里什么都没认出来（页面靠 JS 现场拼链接、或又换了模板）：
    //    把文件页丢进隐藏 iframe 真加载一遍，看它自己把链接拼成了什么
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

    // 全都没命中，把指纹带上，方便下次直接定位
    throw new Error('未识别的下载页结构（页长 ' + html.length +
      ' · 挑战页 ' + (looksLikeChallenge(html) ? '是' : '否') +
      ' · fn ' + (/\/fn\?/.test(html) ? '有' : '无') +
      ' · tp ' + (/\/tp\//.test(html) ? '有' : '无') +
      ' · isngis ' + (/isngis/.test(html) ? '有' : '无') + '）');
  }

  /* ---------- 触发下载 ---------- */

  // 只开一个窗口，后面所有文件都用它自己导航过去。
  // 一次点击里连续 window.open 会被当成「连串弹窗」，从第二个起全被丢掉 ——
  // 这就是「勾 5 个文件只下载了 1 个」的真正原因。
  // 换成「固定窗口名 + 复用」之后：第一次开窗，之后只是让那个窗口跳转，
  // 既不算弹窗，也不会一次开几十个标签页。
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

  /**
   * 这一轮会不会用到「复用同一个窗口」。
   *
   * Chromium 桌面的挑战页不认 iframe，只能用一个窗口；
   * Gecko 桌面的静默模式还是 iframe，真的不弹窗。
   */
  function willUseWin() {
    return !IS_GECKO;
  }

  /**
   * 趁「开始下载」这次点击的用户手势，先把下载窗口开出来。
   * 解析直链要几秒，等解析完再 window.open 的话手势已经过期，会被弹窗拦截。
   * 窗口先放一句占位文案，之后由 fireDirect 逐个导航过去。
   */
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
    try { window.focus(); } catch (e) {}   // 把焦点还回来，让本页继续跑队列
  }

  /** 这类错误再跑下去也没意义（弹窗被拦 / 窗口被关），run 里会直接中止 */
  function fatalError(msg) {
    const e = new Error(msg);
    e.fatal = true;
    return e;
  }

  /** 把文件交给那个固定的下载窗口。跨域窗口只能写 location，不能读别的。 */
  function fireIntoWin(url) {
    // 用户把下载窗口关了：后面每个文件都会失败，直接中止，别再一个个试
    if (dlWin && dlWin.closed) {
      dlWin = null;
      throw fatalError('下载窗口被关闭了，已中止');
    }
    if (dlWin) {
      try { dlWin.location.href = url; return; }
      catch (e) { dlWin = null; }
    }
    dlWin = window.open(url, 'lzpp-dl');           // 固定名字，下次直接复用
    if (!dlWin) {
      throw fatalError('浏览器拦掉了下载窗口，请允许本页弹窗后重试');
    }
  }

  function fireDirect(url) {
    // Chromium 上 iframe 过不了挑战页（见 IS_GECKO 那段），只能走窗口
    if (!IS_GECKO) {
      fireIntoWin(url);
      return;
    }

    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;border:0;';
    f.src = url;
    document.body.appendChild(f);
    removeLater(f, 90000);   // 直链域还有一道反爬挑战页，留足时间让它跳完
  }

  function removeLater(f, ms) {
    setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, ms);
  }

  /** 文件行对应的可访问地址 */
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

  /**
   * 解析并发数。
   *
   * 解析一个文件要发两三个请求、0.7~1s，串行跑 1785 个就是 20 多分钟。
   * 3 个 worker 足够把这段时间压到 1/3，又不至于把站点打急。
   */
  const RESOLVE_CONCURRENCY = 3;

  /** 解析失败后等多久再试一次 */
  const RESOLVE_RETRY_WAIT = 1500;

  /**
   * 解析一个条目的直链：TTL 内复用 + 失败重试一次。
   *
   * 重试只针对「解析」这一步；下载窗口被关、弹窗被拦这类错误不重试
   * （重试也会失败，还会把用户晾在原地）。
   */
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

  /**
   * @param {Array} [only] 只跑这一批（「重试失败」用）；不传就按勾选来
   */
  async function run(only) {
    const picked = (only && only.length)
      ? only.slice()
      : Array.from(items.values()).filter((i) => i.checked);
    if (!picked.length) {
      setStatus('请先勾选文件');
      return;
    }
    cancelWinClose();
    // 这一批的旧结论先清掉，重试成功的才会从失败名单里消失
    picked.forEach(function (it) { it.error = ''; });

    state.running = true;
    state.stop = false;
    state.prog = { done: 0, total: picked.length };
    updateUI();

    let okCount = 0, failCount = 0;
    let fatalMsg = '';

    // 解析预取：当前文件在等下载窗口时，后面几个已经在解析了
    const pending = new Map();
    function startResolve(it) {
      let p = pending.get(it);
      if (!p) {
        p = resolveItem(it);
        p.catch(function () {});   // 预取失败不产生 unhandled rejection
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

      // 窗口模式要给直链域的挑战页留足时间：它得先跑完 JS 再 reload 才吐文件，
      // 实测 2 秒不够、3.5 秒才稳。Gecko 的 iframe 走的是另一条路，按用户设的间隔来。
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
          it.error = msg;      // 记在条目上，「重试失败」靠它找人
        log('下载失败：' + it.label + ' —— ' + msg);
        // 下载窗口被关 / 弹窗被拦：后面每一个都会失败，直接中止
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

    // 措辞用「已发起」而不是「成功」：静默模式是往隐藏 iframe 里塞一次导航，
    // 下载到底有没有真起来，页面这边看不见（响应头、反爬挑战页都可能拦下）。
    // 说「成功」是在替浏览器打包票，说「已发起」才是我们确实做到的那一步。
    let text;
    if (fatalMsg) {
      text = '已中止 已发起 ' + okCount;
    } else {
      text = (state.stop ? '已停止 ' : '') + '已发起 ' + okCount;
      if (failCount) text += ' 失败 ' + failCount;
    }
    setStatus(text);

    // 一个都没发出去就把占位窗口关掉，别留个空白标签页给用户
    if (willUseWin() && dlWin && !dlWin.closed) {
      if (okCount === 0) {
        try { dlWin.close(); } catch (e) {}
        dlWin = null;
      } else {
        scheduleWinClose();
      }
    }
  }

  /** 把页面命令条里的勾选状态同步回复选框 */
  function syncAll() {
    items.forEach((i) => {
      if (i.cb) i.cb.checked = i.checked;
      paint(i);
    });
  }

  /* =========================================================
   * 9. 渲染
   * ======================================================= */
  /* =========================================================
   * 10. 页面搜索 + 自动加载全部
   * ---------------------------------------------------------
   * 搜索条：白底、方角、细边框，左边放大镜、右边清除。过滤只改行的
   * display，不动 items，所以勾选、直链、下载都不受影响。
   *
   * 精确和模糊同时生效：normalize 后先看子串，没命中再看
   * 子序列（字符按顺序出现即可）。§x 这类控制码在两边都
   * 会被剥掉，所以直接打 demo / alpha 也能搜到。
   * ======================================================= */
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

    /* 蓝奏云固定 top bar：从奶油底 + 蓝色渐变条改成纯白 */
    .top .d1 {
      background: #fff !important;
      border-bottom-color: transparent !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .08) !important;
      opacity: 1 !important;
      filter: none !important;
    }
    /* .pc 是 .top 的兄弟节点；它下面那条细线也去掉 */
    div.pc.bgimg {
      background: #fff !important;
      background-image: none !important;
      border-bottom-color: transparent !important;
    }

    .d2 {
      position: sticky;
      top: calc(49px + var(--lzpp-barh, 36px));
      z-index: 5;
      min-height: 43px;              /* 站点 .d2 元素实际只有 16px，子列 float 撑不起来 */
      background: #fff !important;
      border-top: 0 !important;
      border-bottom: 0 !important;
      padding: 0 10px !important;      /* 站点原来的上下留白会变成灰色/白色空带 */
      color: #3f3f3f !important;
      font-size: 12px;
    }
    #infos { border-top-color: transparent !important; }
    /* 不再提供「继续加载」按钮；站点这个仍留在 DOM 里给自动加载点，但看不见 */
    #filemore { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }
    /* 选中行是浅蓝底，文件名/大小/时间改成深色，别再叠站点蓝 */
    #ready.lzpp-on #name, #ready.lzpp-on #name a { color: #1a1a1a !important; }
    /* #ready 本身高度是 0（子列 float），背景只能靠子列画；给 #name 补 10px
       左侧投影，让选中色从行左边缘开始，而不是从复选框左边缘开始 */
    #ready.lzpp-on #name { box-shadow: -10px 0 0 #e8f3fd; }
    #ready.lzpp-on #size, #ready.lzpp-on #time { color: #3f3f3f !important; }

    /* 方角搜索框 */
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

    /* 方角命令条按钮 */
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

    /* 表头全选：方角 checkbox */
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

  function mountSearch() {
    if (isSingleFilePath()) return;
    if (!items.size) return;
    ensureSearchStyle();

    let wrap = document.getElementById('lzpp-search');
    if (!wrap) {
      let anchor = document.getElementById('infos');
      if (anchor) {
        // 真实页面里 #infos 前面是 .d2（文件名/大小/时间那一栏），
        // 搜索框要插到它前面，而不是插到 #infos 前面变成表头下面。
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
    // jsdom 回归里没有真实的「加载更多」节奏，自动跑会把测试的主动点击搅乱
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

  /** 单文件页 /iXXXX：整页一个文件，没有批量可言 */
  function isSingleFilePath() {
    return /^\/i[0-9A-Za-z_-]{5,}\/?$/.test(location.pathname);
  }

  /**
   * 该不该显示命令条：只有文件夹分享页才有意义。
   * 单文件页（/iXXXX）整页就一个文件、底下几条下载线路，勾不了也没有"批量"可言；
   * 首页、登录页之类更是跟脚本没关系。
   *
   * 两条并列判断：真的识别出了文件行，或者地址是 /bXXXX。
   * 后者是兜底 —— 文件夹页还没渲染完（或换了模板没认出来）时，
   * 命令条得留着，不然用户看不到「未识别到文件列表」那句提示。
   */
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

  /* =========================================================
   * 9.5 密码页：回车即确认
   * ---------------------------------------------------------
   * 两种模板的差别（都实测过）：
   *   文件夹密码页 /bXXXX —— 只有 #sub 上的 onclick="file();"，
   *     站点没绑回车，敲完密码必须去点那个"确认"按钮；
   *   单文件密码页 /iXXXX —— 自带 $(document).keyup → down_p()。
   * 所以这里只在「密码框里按回车」时接管一次，并在紧接着的
   * keyup 上做一次拦截，免得站点自己的 keyup 再提交一遍。
   * ======================================================= */
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

    // 兜底：就近往上找带 onclick 或写着"确认"的按钮
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

  function bindPasswordEnter() {
    let handledAt = 0;

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;

      const t = e.target;
      if (!t) return;

      // 只在密码框里按回车才管，别的地方保持原样
      const pwd = document.querySelector(PWD_INPUT_SEL);
      if (!pwd || t !== pwd) return;

      const btn = findPwdSubmit(pwd);
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();
      handledAt = Date.now();
      btn.click();
    }, true);

    // 这一次回车我们已经提交过了，拦掉站点自己的 keyup，避免重复提交
    window.addEventListener('keyup', function (e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (!handledAt || Date.now() - handledAt > 800) return;
      handledAt = 0;
      e.stopPropagation();
    }, true);
  }

  /* =========================================================
   * 10. 启动
   * ======================================================= */
  function boot() {
    if (window.__lanzouPlusPlus__) return;

    if (!document.body) {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    window.__lanzouPlusPlus__ = true;

    // 手机/纯触摸设备不再支持：不注入命令条、不扫描、不自动加载
    if (DISABLE_ON_TOUCH) {
      log('手机端已停用，请在桌面浏览器使用');
      return;
    }

    log(NAME + ' v' + VERSION + ' 已加载');
    if (isFolderPage()) ensureSearchStyle();   // top bar 先白，别等文件加载完再变
    bindPasswordEnter();
    bindCheckboxEvents(); // 复选框事件委托，只挂这一次
    watchFilemore();      // 「加载全部」靠它读站点回执（zt / 本页条数）
    scan();

    // 页面整体重绘时重新扫描
    const mo = new MutationObserver(debounce(function () {
      scan();
    }, 400));
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 兜底补扫（文件列表常由 ajax 渲染）
    [600, 1500, 3000, 6000, 12000].forEach(function (t) { setTimeout(scan, t); });

    // 调试入口：控制台执行 LZPP.debug() 可查看识别结果
    window.LZPP = {
      version: VERSION,
      items: items,
      scan: scan,
      resolve: resolveDirect,       // 只解析、不触发下载，方便排查
      setStatus: setStatus,         // 调试加载/下载状态文案
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

