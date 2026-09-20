// threads-resolve.js — адаптивное распознавание элементов Threads.
// window.DST.resolve + window.DST.ours (защита от собственного UI)
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ.
// Threads регулярно переписывает aria-label и структуру кнопок: сегодня
// «Ответить», завтра «Reply», послезавтра «Ответ» — только svg.
// Раньше расширение искало кнопку по фиксированному списку строк, и при
// каждой такой правке авто-режим начинал промахиваться мимо цели.
//
// КАК РЕШЕНО.
//   1) СВОЁ — НЕ ТРОГАЕМ. Любой узел расширения помечен data-dst-ui и
//      исключается из всех сканов. Раньше движок кликал по собственной
//      кнопке «✦ Сгенерировать комментарий» (в подписи есть «коммент»),
//      запускал вторую генерацию и терял композер.
//   2) ГЕОМЕТРИЯ И РОЛЬ. Кнопки действий у поста всегда лежат одной строкой
//      под текстом, в порядке: лайк, ответ, репост, поделиться.
//   3) СЛОВАРЬ. Подписи проверяются по расширенному многоязычному словарю.
//   4) МОДЕЛЬ. Если первые способы не дали ответа, компактный снимок
//      кандидатов уходит в модель. Ответ кэшируется по «отпечатку» разметки.
(() => {
  if (window.DST && window.DST.resolve) return;
  window.DST = window.DST || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ──────────────────────────────────────────────────────────
  //  СВОЙ UI: пометка и исключение
  // ──────────────────────────────────────────────────────────
  // Всё, что рисует расширение, помечается data-dst-ui="1". Ни один
  // сканер DOM не имеет права вернуть такой узел как цель на странице.
  const OURS_ATTR = "data-dst-ui";
  const OURS_SEL = "[" + OURS_ATTR + "]";

  function mark(el) {
    try { el && el.setAttribute && el.setAttribute(OURS_ATTR, "1"); } catch {}
    return el;
  }
  function isOurs(el) {
    if (!el || !el.closest) return false;
    try { return !!el.closest(OURS_SEL); } catch { return false; }
  }
  /** Отфильтровать собственные узлы из любого списка. */
  function notOurs(list) {
    return Array.prototype.filter.call(list || [], (e) => !isOurs(e));
  }
  /** querySelectorAll, который никогда не вернёт наши элементы. */
  function qsa(root, sel) {
    try { return notOurs((root || document).querySelectorAll(sel)); }
    catch { return []; }
  }
  function qs(root, sel) {
    const a = qsa(root, sel);
    return a.length ? a[0] : null;
  }
  /**
   * Текст области БЕЗ нашей разметки — нужен для подтверждения отправки:
   * иначе собственный лог с текстом комментария считался бы «комментарий
   * появился в ветке».
   */
  const rawText = (el) =>
    (typeof el.innerText === "string" && el.innerText) || el.textContent || "";

  function textWithoutOurs(root) {
    const el = root || document.body;
    if (!el) return "";
    if (isOurs(el)) return "";
    if (!el.querySelector || !el.querySelector(OURS_SEL)) return rawText(el);
    let out = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { out += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      if (isOurs(node)) continue;
      out += "\n" + textWithoutOurs(node);
    }
    return out;
  }

  window.DST.ours = { ATTR: OURS_ATTR, SEL: OURS_SEL, mark, isOurs, notOurs, qsa, qs, textWithoutOurs };

  // ──────────────────────────────────────────────────────────
  //  СЛОВАРИ ПОДПИСЕЙ (много языков — интерфейс зависит от локали)
  // ──────────────────────────────────────────────────────────
  // ВАЖНО: «коммент» убран из reply — он ловил и счётчик «3 комментария»,
  // и подпись собственной кнопки. «ответ» добавлен: именно так подписана
  // кнопка ответа в актуальном русском Threads.
  const WORDS = {
    reply: ["reply", "replies", "comment", "comments", "ответ", "ответы", "ответить",
            "комментировать", "оставить комментарий", "responder", "commenter",
            "répondre", "antworten", "rispondi", "yanıtla", "balas", "回复", "返信", "답글"],
    like:  ["like", "нравится", "лайк", "me gusta", "j'aime", "gefällt", "mi piace", "beğen"],
    unlike:["unlike", "убрать", "не нравится", "liked", "вам нравится", "ya no me gusta"],
    send:  ["опубликовать", "публикация", "post", "reply", "ответить", "отправить", "send", "publish",
            "publicar", "envoyer", "senden", "invia", "gönder", "kirim", "发布", "投稿"],
    dmSend:["send", "отправить", "enviar", "envoyer", "senden", "invia"],
  };

  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // Подпись элемента. Threads часто вешает aria-label не на сам
  // div[role="button"], а на вложенный <svg> — тогда labelOf(host) возвращал
  // только счётчик («26 153»), и распознавание лайка/ответа разваливалось.
  function labelOf(el) {
    if (!el) return "";
    const own = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
    if (own) return norm(own);
    let inner = "";
    try {
      const kid = el.querySelector?.("[aria-label], [title]");
      if (kid) inner = kid.getAttribute("aria-label") || kid.getAttribute("title") || "";
    } catch {}
    const txt = el.textContent || "";
    return norm(inner ? inner + " " + txt : txt);
  }

  function matches(el, kind) {
    if (isOurs(el)) return false;
    const l = labelOf(el);
    if (!l || l.length > 40) return false;
    return WORDS[kind].some((w) => l.includes(w));
  }

  function visible(el) {
    if (!el || !document.body.contains(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && +st.opacity !== 0;
  }

  // ──────────────────────────────────────────────────────────
  //  КЭШ РЕШЕНИЙ
  // ──────────────────────────────────────────────────────────
  const MEM = new Map();

  async function cacheGet(key) {
    if (MEM.has(key)) return MEM.get(key);
    try {
      const { _resolveCache = {} } = await chrome.storage.local.get("_resolveCache");
      const v = _resolveCache[key];
      if (v && Date.now() - v.at < 14 * 86400000) { MEM.set(key, v.val); return v.val; }
    } catch {}
    return null;
  }

  async function cacheSet(key, val) {
    MEM.set(key, val);
    try {
      const { _resolveCache = {} } = await chrome.storage.local.get("_resolveCache");
      _resolveCache[key] = { val, at: Date.now() };
      // выбрасываем самые старые, а не «первый попавшийся ключ»
      const keys = Object.keys(_resolveCache);
      if (keys.length > 60) {
        keys.sort((a, b) => (_resolveCache[a]?.at || 0) - (_resolveCache[b]?.at || 0));
        for (const k of keys.slice(0, keys.length - 60)) delete _resolveCache[k];
      }
      await chrome.storage.local.set({ _resolveCache });
    } catch {}
  }

  // ──────────────────────────────────────────────────────────
  //  КАНДИДАТЫ
  // ──────────────────────────────────────────────────────────
  /** Все кликабельные элементы внутри области, с их геометрией и подписью. */
  function candidates(scope) {
    const root = scope || document;
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(
        '[role="button"], button, a[role="link"], [aria-label][tabindex], svg'
      ));
    } catch { return []; }
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      if (isOurs(n)) continue;                      // ← свой UI не кандидат
      const host = n.closest('[role="button"], button, a[role="link"]') || n;
      if (isOurs(host) || seen.has(host) || !visible(host)) continue;
      seen.add(host);
      const r = host.getBoundingClientRect();
      out.push({
        el: host,
        label: labelOf(host),
        tag: host.tagName.toLowerCase(),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        href: host.getAttribute?.("href") || "",
        disabled: host.getAttribute?.("aria-disabled") === "true" || !!host.disabled,
      });
    }
    return out;
  }

  /**
   * Строка действий поста: группа мелких кнопок примерно на одной высоте,
   * в нижней части карточки. Именно она переживает смену подписей.
   *
   * Если в области несколько строк действий (страница ветки, где под постом
   * идут ответы), берём ПЕРВУЮ — она принадлежит целевому посту. Раньше
   * бралась последняя, то есть кнопки чужого ответа.
   */
  function actionRow(container, { pick = "first" } = {}) {
    const cands = candidates(container).filter(
      (c) => c.w >= 16 && c.w <= 110 && c.h >= 16 && c.h <= 70 && !c.href.includes("/@")
    );
    if (cands.length < 2) return [];
    const rows = [];
    for (const c of cands.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r[0].y - c.y) <= 14);
      if (row) row.push(c); else rows.push([c]);
    }
    // строка действий = там, где есть лайк ИЛИ >= 3 кнопок в ряд
    // внутри строки оставляем только кнопки с общим родителем: «Ещё» из
    // шапки карточки нередко стоит на той же высоте и ломала нумерацию
    const compact = rows.map((r) => {
      if (r.length < 3) return r;
      const byParent = new Map();
      for (const c of r) {
        const key = c.el.parentElement || c.el;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(c);
      }
      let bestGroup = r;
      for (const g of byParent.values()) if (g.length > 1 && g.length > bestGroup.length - 1) bestGroup = g;
      let biggest = r;
      for (const g of byParent.values()) if (g.length > (biggest === r ? 1 : biggest.length)) biggest = g;
      return biggest.length >= 2 ? biggest : r;
    });
    const good = compact.filter((r) => r.length >= 2);
    if (!good.length) return [];
    const withLike = good.filter((r) =>
      r.some((c) => matches(c.el, "like") || matches(c.el, "unlike")));
    const pool = withLike.length ? withLike : good;
    const row = pick === "last" ? pool[pool.length - 1] : pool[0];
    return row.slice().sort((a, b) => a.x - b.x);
  }

  function fingerprint(row) {
    return "row:" + row.length + ":" + row.map((c) => c.label.slice(0, 14) || c.tag).join("|");
  }

  // ──────────────────────────────────────────────────────────
  //  РАСПОЗНАВАНИЕ ЧЕРЕЗ МОДЕЛЬ
  // ──────────────────────────────────────────────────────────
  function sw(type, payload = {}) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (r) =>
          res(chrome.runtime.lastError ? { ok: false } : (r || { ok: false })));
      } catch { res({ ok: false }); }
    });
  }

  async function askModel(row, kind) {
    const what = {
      reply: "кнопка «ответить/комментировать» под постом (открывает поле ответа)",
      like: "кнопка «нравится/лайк» под постом",
      send: "кнопка отправки уже написанного комментария или поста",
    }[kind] || kind;

    const snapshot = row.map((c, i) =>
      `${i}: подпись="${c.label || "(без подписи)"}" тег=${c.tag} размер=${c.w}x${c.h} позиция_x=${c.x}`
    ).join("\n");

    const prompt =
      "Это кнопки интерфейса соцсети Threads, перечисленные слева направо " +
      "в порядке их расположения на экране.\n\n" + snapshot + "\n\n" +
      `Какая из них — ${what}?\n` +
      "Учти обычный порядок кнопок под постом в Threads: лайк, ответ, репост, поделиться.\n" +
      'Верни СТРОГО JSON без пояснений: {"index": число, "confidence": 0-100}. ' +
      'Если подходящей кнопки нет — {"index": -1, "confidence": 0}.';

    const r = await sw("AI_CHAT", { messages: [{ role: "user", content: prompt }] });
    if (!r.ok || !r.text) return null;
    try {
      const m = r.text.match(/\{[\s\S]*\}/);
      const d = JSON.parse(m ? m[0] : r.text);
      const i = Number(d.index);
      if (Number.isInteger(i) && i >= 0 && i < row.length && Number(d.confidence) >= 50) return i;
    } catch {}
    return null;
  }

  // ──────────────────────────────────────────────────────────
  //  ПУБЛИЧНОЕ: НАЙТИ КНОПКУ ОТВЕТА
  // ──────────────────────────────────────────────────────────
  /**
   * Возвращает список целей «открыть ответ» по убыванию уверенности.
   * Приоритет отдан геометрии строки действий: она стабильнее подписей и
   * не зависит от локали. Никогда не пустой — последней целью идёт ссылка
   * на сам пост.
   */
  async function replyTargets(container, sel, { allowModel = true } = {}) {
    const out = [];
    const push = (el, why) => {
      if (!el || isOurs(el)) return;
      if (!document.body.contains(el)) return;
      if (out.some((o) => o.el === el)) return;
      out.push({ el, why });
    };

    const row = actionRow(container);

    // 1) позиция в строке действий: ответ — кнопка сразу после лайка.
    //    Самый надёжный путь: не зависит от языка интерфейса.
    if (row.length) {
      const likeIdx = row.findIndex((c) => matches(c.el, "like") || matches(c.el, "unlike"));
      if (likeIdx >= 0 && row[likeIdx + 1]) push(row[likeIdx + 1].el, "after-like");
      // 2) явная подпись внутри той же строки действий
      for (const c of row) if (!c.disabled && matches(c.el, "reply")) push(c.el, "row-label");
      if (!out.length && row[1]) push(row[1].el, "second-in-row");
    }

    // 3) прямое совпадение по словарю в пределах карточки
    for (const c of candidates(container)) {
      if (!c.disabled && matches(c.el, "reply")) push(c.el, "label");
    }

    // 4) модель — только если ничего не нашли
    if (!out.length && allowModel && row.length) {
      const fp = fingerprint(row);
      let idx = await cacheGet(fp);
      if (idx == null) {
        idx = await askModel(row, "reply");
        if (idx != null) await cacheSet(fp, idx);
      }
      if (idx != null && row[idx]) push(row[idx].el, "model");
    }

    // 5) запасной путь — открыть пост по ссылке
    const link = qs(container || document, sel.postLink);
    if (link) push(link, "permalink");
    return out;
  }

  /** Кнопка отправки в пределах области, с проверкой «не выключена». */
  async function sendTarget(scope, sel, { allowModel = true, wait = 4000 } = {}) {
    // Кнопка «Опубликовать» остаётся aria-disabled, пока редактор не
    // зарегистрирует текст. Ждём, а не решаем сразу «кнопки нет».
    const deadline = Date.now() + wait;
    const words = (sel?.sendButtonLabels || []).concat(WORDS.send).map(norm);
    let best = null, score = 0, cands = [];

    while (Date.now() < deadline) {
      cands = candidates(scope).filter((c) => !c.disabled && c.label && c.label.length <= 24);
      best = null; score = 0;
      for (const c of cands) {
        for (const ww of words) {
          const sc = c.label === ww ? 5 : c.label.startsWith(ww) ? 4
                   : c.label.endsWith(ww) ? 3 : c.label.includes(ww) ? 2 : 0;
          if (sc > score) { score = sc; best = c.el; }
        }
      }
      if (best && score >= 3) return best;     // уверенное совпадение — берём сразу
      await sleep(200);
    }
    if (best) return best;
    if (!allowModel || !cands.length) return null;

    const fp = "send:" + cands.length + ":" + cands.map((c) => c.label.slice(0, 12)).join("|");
    let idx = await cacheGet(fp);
    if (idx == null) {
      idx = await askModel(cands, "send");
      if (idx != null) await cacheSet(fp, idx);
    }
    return idx != null && cands[idx] ? cands[idx].el : null;
  }

  /** Кнопка лайка (или признак, что уже стоит). */
  function likeTarget(container) {
    for (const c of candidates(container)) {
      if (matches(c.el, "unlike")) return { el: c.el, already: true };
    }
    for (const c of candidates(container)) {
      if (matches(c.el, "like")) return { el: c.el, already: false };
    }
    const row = actionRow(container);
    if (row[0]) return { el: row[0].el, already: false };
    return null;
  }

  window.DST.resolve = {
    replyTargets, sendTarget, likeTarget,
    candidates, actionRow, labelOf, matches, visible, WORDS,
    _askModel: askModel, _fingerprint: fingerprint, sleep,
    isOurs, mark, qsa, qs, textWithoutOurs,
  };
})();
