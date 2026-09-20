// threads-find.js — поиск постов (лента + поиск) и надёжный поиск полей ввода.
// window.DST.find (классический скрипт, грузится после threads-dom.js).
(() => {
  if (window.DST && window.DST.find) return;
  window.DST = window.DST || {};
  const dom = () => window.DST.dom;
  const qsa = (r, sel) => (window.DST.ours ? window.DST.ours.qsa(r, sel)
                                           : Array.from((r || document).querySelectorAll(sel)));
  const qs = (r, sel) => qsa(r, sel)[0] || null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ──────────────────────────────────────────────────────────
  //  ГДЕ МЫ СЕЙЧАС
  // ──────────────────────────────────────────────────────────
  const ORIGIN = "https://www.threads.com";

  function where() {
    const p = location.pathname || "";
    if (p.startsWith("/search")) return "search";
    if (p.startsWith("/messages")) return "dm";
    if (/\/post\//.test(p)) return "post";
    if (p === "/" || p.startsWith("/?")) return "feed";
    return "other";
  }

  function currentQuery() {
    try { return new URL(location.href).searchParams.get("q") || ""; }
    catch { return ""; }
  }

  function searchUrl(query, filter = "recent") {
    const u = new URL(ORIGIN + "/search");
    u.searchParams.set("q", query);
    // recent = свежие; на них меньше конкуренции в комментариях
    if (filter) u.searchParams.set("filter", filter);
    u.searchParams.set("serp_type", "default");
    return u.toString();
  }

  // Переход выгружает content-script. Состояние движка живёт в storage,
  // поэтому после загрузки страницы работа продолжится сама.
  function goSearch(query, filter) {
    const url = searchUrl(query, filter);
    if (location.href === url) return false;
    location.assign(url);
    return true;
  }
  // Возвращает true, если навигация действительно инициирована. Раньше
  // вызывающий считал переход состоявшимся всегда, и на самой ленте движок
  // «возвращался домой» вхолостую, крутя цикл без пауз.
  function goFeed() {
    if (where() === "feed") return false;
    location.assign(ORIGIN + "/");
    return true;
  }

  // ──────────────────────────────────────────────────────────
  //  СБОР ПОСТОВ
  // ──────────────────────────────────────────────────────────
  // Собирает с текущей страницы — работает одинаково и в ленте, и в выдаче,
  // потому что разметка карточки поста у Threads общая.
  async function harvest(sel, target, onProgress) {
    return dom().collectPosts(sel, target, Math.max(12, Math.ceil(target / 1.2)), onProgress);
  }

  // Свежесть поста по атрибуту time
  function ageHours(post) {
    if (!post.time) return null;
    const t = Date.parse(post.time);
    if (isNaN(t)) return null;
    return (Date.now() - t) / 3600000;
  }

  // ──────────────────────────────────────────────────────────
  //  ПОЛЯ ВВОДА
  // ──────────────────────────────────────────────────────────
  /**
   * ОТРИСОВАНО ЛИ ПОЛЕ.
   *
   * Раньше здесь была ещё и проверка попадания во вьюпорт
   * (`r.bottom > 0 && r.top < innerHeight`). На странице поста форма ответа
   * стоит ПОД веткой — то есть почти всегда ниже экрана. Поле физически
   * есть, но отбрасывалось этой строкой, и охотник получал «не нашёл поле
   * ответа» на каждом лиде подряд.
   *
   * Вьюпорт больше не требуется: перед любым действием цель всё равно
   * доводится до центра экрана (aim.scrollToCenter).
   */
  function visible(el) {
    if (!el || !document.body.contains(el)) return false;
    if (window.DST.ours?.isOurs(el)) return false;   // поле нашей панели — не цель
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || +st.opacity === 0) return false;
    return true;
  }

  /** Отдельно — реально ли элемент сейчас на экране (только для диагностики). */
  function inViewport(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || 800);
  }

  const isEditable = (el) =>
    !!el && (el.getAttribute?.("contenteditable") === "true" ||
             el.tagName === "TEXTAREA" || el.tagName === "INPUT");

  /**
   * Поле ответа именно для этого поста. Порядок важен: сначала диалог
   * (Threads открывает ответ модалкой), потом поле внутри карточки,
   * потом ближайшее видимое к карточке.
   */
  // Подсказки поля ответа на разных языках (Threads пишет их в placeholder)
  const REPLY_HINT = /(ответ|reply|коммент|comment|responder|répond|antwort|rispondi|yanıt)/i;

  function hintOf(el) {
    return (el.getAttribute?.("aria-placeholder") || el.getAttribute?.("data-placeholder") ||
            el.getAttribute?.("placeholder") || el.getAttribute?.("aria-label") || "");
  }

  /**
   * Выбрать поле ответа среди нескольких. В модалке Threads их бывает два:
   * поле ответа и «Дополнить ветку» — раньше расширение попадало во второе,
   * текст «не вставлялся», а кнопка «Опубликовать» оставалась неактивной.
   * Приоритет: подсказка про ответ → первое видимое сверху.
   */
  function pickEditable(list) {
    const vis = list.filter(visible);
    if (!vis.length) return null;
    const hinted = vis.find((e) => REPLY_HINT.test(hintOf(e)));
    if (hinted) return hinted;
    return vis.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  }

  function replyFieldFor(container, sel) {
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) {
      const e = pickEditable(qsa(dlg, sel.editable));
      if (e) return { el: e, scope: dlg, via: "dialog" };
    }
    if (container) {
      const inside = pickEditable(qsa(container, sel.editable));
      if (inside) return { el: inside, scope: container, via: "inline" };
    }
    const a = document.activeElement;
    if (isEditable(a) && visible(a)) return { el: a, scope: document.body, via: "focused" };

    const all = qsa(document, sel.editable).filter(visible);
    if (!all.length) return null;
    if (container) {
      const cy = container.getBoundingClientRect().top;
      all.sort((x, y) =>
        Math.abs(x.getBoundingClientRect().top - cy) - Math.abs(y.getBoundingClientRect().top - cy));
    }
    return { el: all[0], scope: all[0].closest('[role="dialog"]') || document.body, via: "nearest" };
  }

  /** Поле для нового поста (композер). */
  function composerField(sel) {
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) {
      const e = qsa(dlg, sel.editable).find(visible);
      if (e) return { el: e, scope: dlg };
    }
    const e = qsa(document, sel.editable).find(visible);
    return e ? { el: e, scope: e.closest('[role="dialog"]') || document.body } : null;
  }

  /** input[type=file] для картинки/видео — в открытом диалоге приоритетно. */
  function fileField(scope, sel) {
    const pool = [];
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) pool.push(...qsa(dlg, sel.fileInput));
    if (scope && scope !== dlg) pool.push(...qsa(scope, sel.fileInput));
    pool.push(...qsa(document, sel.fileInput));
    // input[type=file] обычно скрыт — visible() к нему неприменим
    return pool.find((i) => i && !i.disabled) || null;
  }

  /** Кнопка отправки в пределах scope. */
  function submitButton(scope, sel) {
    return dom().findButtonByLabels(scope || document.body, sel.sendButtonLabels);
  }

  /** Диагностика: что движок реально видит на странице. */
  function report(sel) {
    const first = qs(document, sel.postLink);
    const cont = first ? dom().postContainerFromLink(first) : null;
    const rf = replyFieldFor(cont, sel);
    return {
      page: where(),
      url: location.href,
      query: currentQuery(),
      posts: qsa(document, sel.postLink).length,
      editablesTotal: qsa(document, sel.editable).length,
      editablesVisible: qsa(document, sel.editable).filter(visible).length,
      replyField: rf ? rf.via : null,
      fileInputs: qsa(document, sel.fileInput).length,
      submitFound: !!submitButton(rf?.scope, sel),
      dialogOpen: !!document.querySelector('[role="dialog"]'),
    };
  }

  window.DST.find = {
    where, currentQuery, searchUrl, goSearch, goFeed,
    harvest, ageHours,
    replyFieldFor, composerField, fileField, submitButton, pickEditable, qsa, qs,
    visible, inViewport, report, sleep,
  };
})();
