/**
 * Дымовой тест режима «Пост», комментирования ветки и разбора профиля.
 *
 * Запуск:  node tests/post-smoke.mjs
 *
 * Что он держит (каждый пункт — реально случившаяся поломка):
 *
 *  1. «не появился композер (диалогов 0, полей ввода 0)». Автопост шёл
 *     следом за Директом, вкладка стояла на /messages, композера там нет
 *     вовсе. Агент обязан сам уйти на ленту — переходом внутри SPA, не
 *     перезагрузкой: перезагрузка убила бы content script посреди RPC.
 *
 *  2. «✕ unknown rpc» на каждое переключение Авто/Вручную. В одной
 *     вкладке четыре слушателя onMessage, и threads-rpc.js отвечал на
 *     чужие сообщения тоже. Его отказ приходил первым и затирал ответ
 *     настоящего адресата.
 *
 *  3. Кнопка «ПОСТ» в боковой панели зависала навсегда: ответ на RPC
 *     отдавался только после ОКОНЧАНИЯ цикла автопостинга, то есть через
 *     часы.
 *
 *  4. «Прокомментировать» открывало ветку и выходило из неё. Виноват был
 *     жёсткий шлюз RPC_WAIT_POST: у главного поста на его же странице
 *     ссылки на себя часто нет, карточку «не видно» — и агент уходил, ни
 *     разу не попробовав написать.
 *
 *  5. «Разбери мой профиль …» → ОШИБКА timeout. Сбор постов не
 *     укладывался в общий таймаут 60 с, и уже собранное выбрасывалось.
 *
 *  6. «Разворот туда-обратно» при комментировании из ленты (5.6.2).
 *     Без кнопки ответа расширение кликало ссылку на пост, уходило на
 *     него и возвращалось обратно. Теперь адрес вкладки не трогается:
 *     поле открылось на месте — работаем, нет — честный отказ.
 *
 * Настоящего браузера здесь нет: DOM — минимальная заглушка ниже,
 * ровно под те селекторы, которыми пользуется продукт.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../extension/src/", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
function check(name, ok, note = "") {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

/* ══════════════════════════════════════════════════════════════
   МИНИМАЛЬНЫЙ DOM

   Поддерживает ровно то, чем пользуется threads-dom.js: группы через
   запятую, теги, [attr], [attr="val"] и один потомковый комбинатор.
   Больше не нужно, а меньше — не хватит.
   ══════════════════════════════════════════════════════════════ */

function parseSimple(sel) {
  const parts = [];
  let tag = null;
  const re = /\[([a-zA-Z0-9_-]+)(?:([~^|*$]?=)"([^"]*)")?\]|([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[4]) tag = m[4].toUpperCase();
    else parts.push({ name: m[1], op: m[2] || null, val: m[3] });
  }
  return { tag, parts };
}

function matchSimple(el, simple) {
  if (!el || !el.tagName) return false;
  if (simple.tag && el.tagName !== simple.tag) return false;
  for (const p of simple.parts) {
    const v = el.getAttribute(p.name);
    if (v == null) return false;
    if (p.op === "=" && v !== p.val) return false;
    if (p.op === "*=" && !v.includes(p.val)) return false;
    if (p.op === "^=" && !v.startsWith(p.val)) return false;
  }
  return true;
}

function matches(el, selector) {
  for (const group of String(selector).split(",")) {
    const chain = group.trim().split(/\s+(?![^[]*\])/).filter(Boolean).map(parseSimple);
    if (!chain.length) continue;
    if (!matchSimple(el, chain[chain.length - 1])) continue;
    let node = el.parentElement, i = chain.length - 2, ok = true;
    while (i >= 0) {
      while (node && !matchSimple(node, chain[i])) node = node.parentElement;
      if (!node) { ok = false; break; }
      node = node.parentElement; i--;
    }
    if (ok) return true;
  }
  return false;
}

class El {
  constructor(tag, attrs = {}, kids = [], text = "") {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentElement = null;
    this._text = text;
    this.style = {};
    this.rect = { top: 120, left: 0, width: 420, height: 44 };
    this.clicks = 0;
    this.onclick = null;
    for (const k of kids) this.appendChild(k);
  }
  appendChild(k) { k.parentElement = this; this.childNodes.push(k); return k; }
  removeChild(k) { this.childNodes = this.childNodes.filter((c) => c !== k); }
  remove() { this.parentElement?.removeChild(this); this.parentElement = null; }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] || null; }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  get textContent() {
    return this.childNodes.length
      ? this.childNodes.map((c) => c.textContent).join("")
      : this._text;
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get innerText() { return this.textContent; }
  get value() { return this._text; }
  set value(v) { this._text = String(v); }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, bottom: r.top + r.height, right: r.left + r.width };
  }
  contains(el) { let n = el; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
  closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentElement; } return null; }
  matches(sel) { return matches(this, sel); }
  all() { const out = []; const walk = (n) => { for (const c of n.childNodes) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter((e) => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // Клик всплывает, как в настоящем DOM: Threads вешает обработчик на
  // контейнер строки, а кликаем мы по самому глубокому узлу с текстом.
  click() { this.clicks++; let n = this; while (n) { if (n.onclick) n.onclick(n); n = n.parentElement; } }
  focus() {}
  blur() {}
  dispatchEvent() { return true; }
  addEventListener() {}
  scrollIntoView() {}
  get dataset() {
    const self = this;
    return new Proxy({}, {
      get: (_t, k) => self.getAttribute("data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())) ?? undefined,
      set: (_t, k, v) => { self.setAttribute("data-" + String(k), v); return true; },
    });
  }
}

/** Страница: <html><body>…</body></html> плюс управление адресом. */
function makePage(pathname) {
  const html = new El("html");
  const body = new El("body");
  html.appendChild(body);
  const doc = {
    body,
    documentElement: html,
    readyState: "complete",
    activeElement: null,
    querySelector: (s) => html.querySelector(s),
    querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new El(t),
    getElementById: (id) => html.querySelector(`[id="${id}"]`),
    addEventListener() {},
    dispatchEvent() { return true; },
  };
  return { doc, body, html, pathname };
}

/** Лента: строка «Что нового?» обычным div — как в живом Threads. */
function buildFeed(body) {
  const row = new El("div", {}, [], "Что нового?");
  row.rect = { top: 150, left: 0, width: 520, height: 48 };
  body.appendChild(new El("div", {}, [row]));
  return row;
}

/** Навигация с ссылкой «Главная». */
function buildNav(body) {
  const home = new El("a", { href: "/", role: "link", "aria-label": "Главная" });
  home.rect = { top: 20, left: 0, width: 60, height: 60 };
  body.appendChild(home);
  return home;
}

/* ══════════════════════════════════════════════════════════════
   ЗАГРУЗКА КЛАССИЧЕСКОГО CONTENT-SCRIPT В ПЕСОЧНИЦУ
   ══════════════════════════════════════════════════════════════ */

function makeSandbox(page, extra = {}) {
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Promise, Array, Object, String, Number, Boolean,
    RegExp, Map, Set, Error, isFinite, isNaN, parseInt, parseFloat,
    document: page.doc,
    location: { href: "https://www.threads.com" + page.pathname, pathname: page.pathname, search: "" },
    screen: { width: 1440, height: 900 },
    innerHeight: 900, innerWidth: 1440,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    scrollBy() {}, scrollTo() {},
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o); this.type = t; } },
    Event: class { constructor(t) { this.type = t; } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestIdleCallback: (fn) => setTimeout(fn, 0),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    ...extra,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

/* ══════════════════════════════════════════════════════════════
   1. КОМПОЗЕР: находит поле поста сам, в том числе с /messages
   ══════════════════════════════════════════════════════════════ */

async function composerCase(title, { pathname, feed, nav, expectReady, expectHome }) {
  const page = makePage(pathname);
  const feedRow = feed ? buildFeed(page.body) : null;
  const home = nav ? buildNav(page.body) : null;

  const ctx = makeSandbox(page, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(read("content/threads-dom.js"), ctx);

  // Клик по «Главной» в настоящем Threads — переход внутри SPA: адрес
  // меняется, страница перерисовывается, скрипт остаётся живым.
  if (home) {
    home.onclick = () => {
      ctx.location.pathname = "/";
      page.body.childNodes = [];
      buildNav(page.body);
      const row = buildFeed(page.body);
      row.onclick = () => openDialog(page.body);
    };
  }
  if (feedRow) feedRow.onclick = () => openDialog(page.body);

  const sel = {
    editable: 'div[contenteditable="true"], textarea',
    composerTriggerLabels: ["start a thread", "начните ветку", "new thread", "создать", "что нового"],
  };
  const steps = [];
  const r = await ctx.window.DST.dom.ensureComposer(sel, { open: true, onStep: (m) => steps.push(m) });

  const ok = !!r.ready === expectReady && (expectHome == null || !!r.wentHome === expectHome);
  check(title, ok,
    ok ? `${r.ready ? "композер открыт" : "честный отказ"}${r.wentHome ? ", через ленту" : ""}`
       : `получено ${JSON.stringify({ ready: r.ready, wentHome: r.wentHome, error: r.error })}`);
}

function openDialog(body) {
  const field = new El("div", { contenteditable: "true" });
  field.rect = { top: 200, left: 0, width: 500, height: 120 };
  const dlg = new El("div", { role: "dialog" }, [field]);
  dlg.rect = { top: 100, left: 0, width: 600, height: 400 };
  body.appendChild(dlg);
}

/* ══════════════════════════════════════════════════════════════
   1б. КОММЕНТАРИЙ НЕ УХОДИТ В СТРОКУ ПОИСКА

   Живой случай. Агент открыл ветку, но в строке действий поста
   кликнул по чипу «Поиск публикаций от sonya.goroshki». Ссылки у чипа
   нет (role="button"), поэтому проверка «уведёт ли со страницы» его
   пропустила: Threads ушёл на /search средствами приложения. Карточка
   исчезла, единственным полем на новой странице осталась строка
   поиска — туда и лёг комментарий.
   ══════════════════════════════════════════════════════════════ */

function buildSearchPage(page) {
  // Строка поиска Threads — contenteditable (внутри живёт чип «Из автора»),
  // поэтому обычный селектор редактируемых полей её видит.
  const box = new El("div", { contenteditable: "true", "aria-label": "Поиск" });
  box.rect = { top: 20, left: 200, width: 540, height: 40 };
  page.body.appendChild(new El("div", { role: "search" }, [box]));
  return box;
}

async function searchTrapCase() {
  const page = makePage("/@lev_009__/post/ABC");
  const ctx = makeSandbox(page, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(read("content/threads-dom.js"), ctx);
  const D = ctx.window.DST.dom;

  const chip = new El("div", { role: "button" }, [], "Поиск публикаций от sonya.goroshki");
  chip.rect = { top: 400, left: 0, width: 120, height: 32 };
  page.body.appendChild(chip);

  const wrong = D.looksWrongTarget(chip);
  check("чип «Поиск публикаций от …» опознаётся как не-ответ", wrong === true);

  // Переход внутри SPA: адрес сменился, карточка исчезла, осталась строка поиска.
  ctx.location.pathname = "/search";
  ctx.location.search = "?from_author=sonya.goroshki";
  page.body.childNodes = [];
  const searchBox = buildSearchPage(page);

  check("строка поиска никогда не считается полем для письма",
    D.isSearchField(searchBox) === true && D.isWritableField(searchBox) === false,
    `isSearchField=${D.isSearchField(searchBox)}`);

  // Настоящее поле ответа в модалке — его писать можно.
  const dlgField = new El("div", { contenteditable: "true", "aria-placeholder": "Ответьте пользователю lev_009__" });
  dlgField.rect = { top: 300, left: 0, width: 500, height: 100 };
  page.body.appendChild(new El("div", { role: "dialog" }, [dlgField]));
  check("настоящее поле ответа при этом остаётся доступным",
    D.isWritableField(dlgField) === true);

  // И обратная проверка: поиск не подсовывается вместо композера поста.
  const triggers = D.composerTriggers({
    editable: 'div[contenteditable="true"], textarea',
    composerTriggerLabels: ["что нового"],
  });
  check("строка поиска не предлагается как поле нового поста",
    !triggers.some((t) => t.el === searchBox),
    `целей: ${triggers.map((t) => t.why).join(", ") || "нет"}`);
}

/* ══════════════════════════════════════════════════════════════
   1в. КОММЕНТИРОВАНИЕ ИЗ ЛЕНТЫ БЕЗ «РАЗВОРОТА ТУДА-ОБРАТНО»

   Живой случай 5.6.2. В ленте у поста не опознали кнопку ответа,
   и последней запасной целью оставалась ссылка на сам пост:
   расширение кликало её, уходило на страницу поста, там не
   находило поле, жало history.back() — и возвращалось в ленту.
   Два захода подряд, и каждый раз лента «разворачивалась
   туда-обратно» на глазах у человека.

   Теперь цели, уводящие со страницы, в открытии ответа не
   участвуют вовсе: комментарий из ленты либо открывает поле на
   месте, либо честно отказывает — адрес вкладки не трогается.
   ══════════════════════════════════════════════════════════════ */

async function feedRoundTripCase() {
  const page = makePage("/");
  const mem = {};
  const ctx = makeSandbox(page, {
    chrome: {
      runtime: { lastError: undefined, onMessage: { addListener() {} } },
      storage: { local: {
        get: (keys, cb) => {
          const ks = Array.isArray(keys) ? keys
                  : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const out = {};
          for (const k of ks) if (k in mem) out[k] = mem[k];
          if (typeof cb === "function") { cb(out); return; }
          return Promise.resolve(out);
        },
        set: (o, cb) => { Object.assign(mem, o); if (typeof cb === "function") cb(); return Promise.resolve(); },
        remove: () => Promise.resolve(),
      } },
    },
  });
  ctx.window.document.createTreeWalker = () => ({ nextNode: () => null });
  ctx.window.NodeFilter = { SHOW_TEXT: 4 };
  vm.runInContext(read("content/threads-dom.js"), ctx);
  const D = ctx.window.DST.dom;

  // Карточка поста в ленте: автор, текст, ссылка на пост — и ни одной
  // кнопки ответа. Единственная цель, которую способен найти запасной
  // путь, — сама ссылка на пост (увела бы на /@someone/post/XYZ).
  const cont = new El("div", {}, []);
  const author = new El("a", { href: "/@someone" }, [], "@someone");
  const text = new El("div", {}, [],
    "Текст поста достаточной длины, чтобы карточка определилась однозначно.");
  const link = new El("a", { href: "/@someone/post/XYZ" }, [], "XYZ");
  // Эмуляция SPA-перехода: клик по ссылке меняет адрес.
  link.onclick = () => { ctx.location.pathname = "/@someone/post/XYZ"; };
  cont.appendChild(new El("div", {}, [author]));
  cont.appendChild(text);
  cont.appendChild(link);
  page.body.appendChild(cont);

  const sel = {
    postLink: 'a[href*="/post/"]', authorLink: 'a[href^="/@"]',
    editable: 'div[contenteditable="true"], textarea', replyButtonLabels: [],
  };
  const t0 = Date.now();
  const r = await D.commentOnPost("XYZ", "проверочный комментарий", sel, "manual");
  const spent = Date.now() - t0;

  check("из ленты: ссылка на пост не кликается ради открытия ответа",
    link.clicks === 0, `кликов: ${link.clicks}`);
  check("из ленты: адрес не меняется (нет разворота туда-обратно)",
    ctx.location.pathname === "/", `адрес: ${ctx.location.pathname}`);
  check("из ленты: честный отказ вместо ухода на пост и обратно",
    r.ok === false && /пропущена \(увела бы со страницы\)/.test(r.error || ""),
    (r.error || "").slice(0, 80));
  check("из ленты: отказ быстрый, без выжидания на чужой странице",
    spent < 5000, `${(spent / 1000).toFixed(1)} с`);
}

/* ══════════════════════════════════════════════════════════════
   2. СБОР ПОСТОВ УКЛАДЫВАЕТСЯ В БЮДЖЕТ
   ══════════════════════════════════════════════════════════════ */

async function collectBudgetCase() {
  const page = makePage("/@someone");
  const ctx = makeSandbox(page, { chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(read("content/threads-dom.js"), ctx);

  const sel = { postLink: 'a[href*="/post/"]', authorLink: 'a[href^="/@"]', editable: "textarea" };
  const t0 = Date.now();
  // Пустая страница = худший случай: ни одного поста, цикл досиживает
  // «расшевеливающие» приёмы с паузами до 4,5 с.
  const posts = await ctx.window.DST.dom.collectPosts(sel, 40, 0, null, null, 3000);
  const spent = Date.now() - t0;

  check("сбор постов уважает бюджет времени",
    posts.length === 0 && spent < 12000,
    `вышел за ${(spent / 1000).toFixed(1)} с (бюджет 3 с, потолок 12 с)`);
}

/* ══════════════════════════════════════════════════════════════
   3. МАРШРУТИЗАЦИЯ СООБЩЕНИЙ: чужое не трогаем
   ══════════════════════════════════════════════════════════════ */

async function rpcRoutingCase() {
  const page = makePage("/");
  const listeners = [];
  const settings = {
    sel: { editable: "textarea", postLink: 'a[href*="/post/"]' },
    postTopics: [], maxPostsPerDay: 5, commentMode: "auto",
  };
  const chromeMock = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        const r = msg.type === "GET_SETTINGS" ? { ok: true, settings }
                : msg.type === "GET_COUNTERS" ? { ok: true, counters: { posts: 0 } }
                : { ok: true };
        cb?.(r);
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  const ctx = makeSandbox(page, { chrome: chromeMock });
  ctx.window.DST = { dom: { sleep: (ms) => delay(ms), rnd: () => 1, collectPosts: async () => [] } };
  vm.runInContext(read("content/threads-rpc.js"), ctx);

  const ask = (type, extra = {}) => new Promise((resolve) => {
    let answered = false;
    const kept = listeners.map((fn) => fn({ type, ...extra }, {}, (r) => { answered = true; resolve(r); }));
    // Слушатель, который не свой, обязан вернуть undefined и не отвечать.
    if (!kept.some((v) => v === true)) setTimeout(() => { if (!answered) resolve(null); }, 50);
    setTimeout(() => { if (!answered) resolve(null); }, 1500);
  });

  const foreign = await ask("RPC_PANEL_ACT", { action: "mode-auto" });
  check("чужое сообщение не получает «unknown rpc»",
    foreign === null,
    foreign === null ? "RPC_PANEL_ACT пропущен молча" : `ответил: ${JSON.stringify(foreign)}`);

  const mine = await ask("RPC_PING");
  check("своё сообщение по-прежнему обрабатывается",
    !!mine?.ok, mine?.ok ? "RPC_PING отвечает" : `ответ: ${JSON.stringify(mine)}`);

  const sheet = await ask("SHEET_OPEN");
  check("сообщение шторки тоже не перехватывается", sheet === null);

  /* ── автопост отвечает сразу, а не через часы ── */
  const started = Date.now();
  const empty = await ctx.window.DST.rpc.startPosting();
  check("автопост без тем отказывает внятно",
    empty.ok === false && /тем/i.test(empty.error || ""),
    JSON.stringify(empty));

  settings.postTopics = ["тема"];
  let loopRuns = 0;
  ctx.window.DST.dom.createPost = async () => { loopRuns++; return { ok: true, sent: true, confirmed: "test" }; };
  const r = await ctx.window.DST.rpc.startPosting();
  const answerMs = Date.now() - started;
  check("кнопка «ПОСТ» получает ответ сразу",
    r.ok === true && r.started === true && answerMs < 3000,
    `${answerMs} мс, ответ ${JSON.stringify(r)}`);
  check("цикл автопостинга при этом действительно идёт",
    ctx.window.DST.rpc.isRunning().post === true);
  ctx.window.DST.rpc.stopPosting();
  await delay(300);
}

/* ══════════════════════════════════════════════════════════════
   4. ИНСТРУМЕНТЫ ПАНЕЛИ: комментарий и разбор профиля
   ══════════════════════════════════════════════════════════════ */

const store = {
  backendUrl: "https://ai-threads.vip", apiToken: "t",
  brandName: "Mika", niche: "AI", commentMode: "auto",
  parseTarget: 40, hunterMaxChars: 190,
};
const calls = [];
let waitPostOk = true;
let collectDelayMs = 0;
let tabUrl = "https://www.threads.com/messages";

const profilePosts = Array.from({ length: 12 }, (_, i) => ({
  code: "P" + i, author: "evaluxamazon", text: "пост " + i,
  likes: i, comments: 0, reposts: 0, shares: 0,
  permalink: `https://www.threads.com/@evaluxamazon/post/P${i}`,
}));

function bgHandle(msg) {
  switch (msg.type) {
    case "GET_SETTINGS": return { ok: true, settings: store };
    case "GET_COUNTERS": return { ok: true, counters: { comments: 0, posts: 0 } };
    default: return { ok: true };
  }
}

async function tabRpc(type, payload) {
  calls.push({ type, payload });
  switch (type) {
    case "RPC_PING": return { ok: true, url: tabUrl };
    case "RPC_COMPOSER_READY":
      return { ok: true, ready: /threads\.com\/$/.test(tabUrl), url: tabUrl };
    case "RPC_COLLECT": {
      if (collectDelayMs) await delay(collectDelayMs);
      return { ok: true, posts: profilePosts, requested: payload.target, reached: profilePosts.length };
    }
    case "RPC_WAIT_POST":
      return waitPostOk ? { ok: true } : { ok: false, error: "ветка не отрисовалась" };
    case "RPC_COMMENT": return { ok: true, sent: true, confirmed: "replies+1" };
    case "RPC_POST": return { ok: true, sent: true, confirmed: "composer-gone" };
    default: return { ok: false, error: "unknown rpc" };
  }
}

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage: (msg, cb) => {
      const r = bgHandle(msg);
      if (typeof cb === "function") { cb(r); return; }
      return Promise.resolve(r);
    },
    openOptionsPage() {},
  },
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        const ks = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (o) => Object.assign(store, o),
      remove: async () => {},
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    query: async () => [{ id: 1, url: tabUrl, active: true, status: "complete" }],
    get: async () => ({ id: 1, url: tabUrl, status: "complete" }),
    create: async ({ url }) => { tabUrl = url; return { id: 1, url, status: "complete" }; },
    update: async (id, { url }) => { tabUrl = url; return { id, url }; },
    sendMessage: (id, msg, cb) => {
      tabRpc(msg.type, msg).then((r) => cb?.(r));
    },
    onRemoved: { addListener() {} },
  },
  scripting: { executeScript: async () => [] },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {} },
};
globalThis.fetch = async () => { throw new Error("прямой fetch в дымовом тесте запрещён"); };

const T = await import(new URL("sidepanel/tools.js", ROOT).href);

async function toolsCases() {
  /* ── комментарий не бросает ветку, даже если карточка не опознана ── */
  calls.length = 0;
  waitPostOk = false;
  const lead = {
    code: "P1", author: "evaluxamazon",
    permalink: "https://www.threads.com/@evaluxamazon/post/P1",
  };
  const logs = [];
  const r = await T.commentOnLead(lead, "коротко по делу", "auto", (m) => logs.push(m));
  check("комментарий пишется, даже когда карточка поста не опознана",
    r.ok === true && r.sent === true && calls.some((c) => c.type === "RPC_COMMENT"),
    r.ok ? "дошло до RPC_COMMENT" : `вышел из ветки: ${JSON.stringify(r)}`);

  waitPostOk = true;

  /* ── публикация сама уводит вкладку на ленту ── */
  calls.length = 0;
  tabUrl = "https://www.threads.com/messages";
  const steps = [];
  const p = await T.createPostWithMedia("Текст поста для проверки", null, "auto", (m) => steps.push(m));
  const probed = calls.filter((c) => c.type === "RPC_COMPOSER_READY").length;
  check("перед постом вкладка проверяется и уводится на ленту",
    p.ok === true && probed >= 1 && /threads\.com\/$/.test(tabUrl),
    `проверок композера: ${probed}, адрес в конце: ${tabUrl}`);

  /* ── сбор постов получает бюджет, а таймаут RPC — больше бюджета ── */
  calls.length = 0;
  collectDelayMs = 0;
  const pr = await T.parseProfile("evaluxamazon", 40, () => {});
  const collectCall = calls.find((c) => c.type === "RPC_COLLECT");
  check("разбор профиля передаёт бюджет времени в страницу",
    pr.ok === true && collectCall?.payload?.budgetMs >= 60000,
    `budgetMs=${collectCall?.payload?.budgetMs}`);

  /* ── медленная страница больше не роняет разбор ── */
  calls.length = 0;
  collectDelayMs = 2500;
  const slow = await T.parseProfile("evaluxamazon", 40, () => {});
  collectDelayMs = 0;
  check("медленный сбор не превращается в «ОШИБКА timeout»",
    slow.ok === true && slow.posts.length === profilePosts.length,
    slow.ok ? `собрано ${slow.posts.length}` : `ошибка: ${slow.error}`);
}

/* ══════════════════════════════════════════════════════════════
   ПРОГОН
   ══════════════════════════════════════════════════════════════ */

await composerCase("композер находится на ленте",
  { pathname: "/", feed: true, nav: true, expectReady: true, expectHome: false });

await composerCase("с /messages агент сам уходит на ленту",
  { pathname: "/messages", feed: false, nav: true, expectReady: true, expectHome: true });

await composerCase("без ленты и навигации — честный отказ с адресом",
  { pathname: "/messages", feed: false, nav: false, expectReady: false });

await searchTrapCase();
await feedRoundTripCase();
await collectBudgetCase();
await rpcRoutingCase();
await toolsCases();

for (const r of results) {
  console.log(`${r.ok ? "✓" : "✕"} ${r.name.padEnd(56)}${r.note ? " · " + r.note : ""}`);
}
console.log(failures
  ? `\n${failures} из ${results.length} проверок провалены`
  : `\nВсе ${results.length} проверок прошли: пост публикуется, ветка комментируется, ` +
    "режимы переключаются без «unknown rpc», профиль разбирается без timeout.");
process.exit(failures ? 1 : 0);
