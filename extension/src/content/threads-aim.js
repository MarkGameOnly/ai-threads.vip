// threads-aim.js — «прицел»: наведение, скролл и настоящие события мыши.
// window.DST.aim
//
// Зачем отдельный модуль. Threads построен на React и слушает не click,
// а полную цепочку указателя: pointerover → pointerdown → mousedown →
// focus → pointerup → mouseup → click. Голый el.click() часть обработчиков
// не поднимает, поэтому кнопка «Ответить» иногда не срабатывала.
// Плюс элемент за пределами вьюпорта React может вообще не обрабатывать —
// поэтому перед каждым действием цель доводится до центра экрана.
(() => {
  if (window.DST && window.DST.aim) return;
  window.DST = window.DST || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ──────────────────────────────────────────────────────────
  //  СКРОЛЛ
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  //  ВИДИМЫЙ КУРСОР
  // ──────────────────────────────────────────────────────────
  // Автоматизация двигает «мышь» событиями, реального курсора на экране нет —
  // со стороны кажется, что программа замерла. Рисуем свою точку: видно, куда
  // она целится, когда кликает и когда печатает. Как при удалённом доступе.
  let CURSOR = null, CURSOR_ON = true;

  function cursorEl() {
    if (CURSOR && document.body.contains(CURSOR)) return CURSOR;
    const d = document.createElement("div");
    d.id = "dst-cursor";
    d.setAttribute("data-dst-ui", "1");   // свой UI — исключён из всех сканов DOM
    d.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:18px", "height:18px",
      "margin:-9px 0 0 -9px", "border-radius:50%", "pointer-events:none",
      "z-index:2147483647", "background:rgba(255,64,129,.35)",
      "border:2px solid #ff4081", "box-shadow:0 0 12px rgba(255,64,129,.8)",
      "transition:transform .18s ease-out, opacity .2s", "opacity:0",
    ].join(";");
    (document.body || document.documentElement).appendChild(d);
    CURSOR = d;
    return d;
  }

  function cursorTo(x, y, { label = "" } = {}) {
    if (!CURSOR_ON) return;
    try {
      const d = cursorEl();
      d.style.opacity = "1";
      d.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (label) d.title = label;
    } catch {}
  }

  function cursorPulse() {
    if (!CURSOR_ON || !CURSOR) return;
    try {
      const d = CURSOR;
      d.style.background = "rgba(255,64,129,.75)";
      setTimeout(() => { if (d) d.style.background = "rgba(255,64,129,.35)"; }, 220);
    } catch {}
  }

  function cursorHide() { try { if (CURSOR) CURSOR.style.opacity = "0"; } catch {} }
  function cursorEnable(on) { CURSOR_ON = !!on; if (!on) cursorHide(); }

  /** Плавный проезд «мыши» к точке — без телепортации, как у человека. */
  async function cursorGlide(to, steps = 12) {
    if (!CURSOR_ON) return;
    const d = cursorEl();
    const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(d.style.transform || "");
    let x = m ? +m[1] : to.x, y = m ? +m[2] : to.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      cursorTo(x + (to.x - x) * ease, y + (to.y - y) * ease);
      await sleep(rnd(10, 26));
    }
  }

  function centerOffset(el) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    return (r.top + r.height / 2) - vh / 2;
  }

  /** Плавно доводит элемент до центра экрана. Ждёт остановки скролла. */
  // Threads иногда скроллит не окно, а внутренний контейнер. Раньше в этом
  // случае 14 итераций window.scrollBy впустую жгли ~4 секунды на каждый клик.
  function scrollParent(el) {
    let n = el?.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
      n = n.parentElement;
    }
    return null;
  }

  async function scrollToCenter(el, { smooth = false, tolerance = 90 } = {}) {
    if (!el || !document.body.contains(el)) return false;
    const box = scrollParent(el);
    let lastOff = null;
    for (let i = 0; i < 8; i++) {
      const off = centerOffset(el);
      if (Math.abs(off) <= tolerance) break;
      // если прокрутка не двигает цель — выходим, а не крутим вхолостую
      if (lastOff != null && Math.abs(lastOff - off) < 4) break;
      lastOff = off;
      const step = Math.max(-900, Math.min(900, off));
      if (box) box.scrollBy({ top: step, behavior: smooth ? "smooth" : "auto" });
      else window.scrollBy({ top: step, behavior: smooth ? "smooth" : "auto" });
      await sleep(smooth ? rnd(200, 320) : 110);
    }
    await settle(900);
    return Math.abs(centerOffset(el)) <= tolerance * 2.5;
  }

  /** Ждёт, пока страница перестанет скроллиться. */
  async function settle(maxMs = 1800) {
    let last = -1, still = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const y = window.scrollY;
      if (y === last) { if (++still >= 3) return true; }
      else { still = 0; last = y; }
      await sleep(80);
    }
    return false;
  }

  /** Человеческий скролл ленты: неравномерные шаги с микропаузами. */
  async function humanScroll(px) {
    const target = px || (window.innerHeight * rnd(0.7, 1.0));
    let done = 0;
    while (done < target) {
      const step = Math.min(target - done, rnd(90, 260));
      window.scrollBy({ top: step, behavior: "auto" });
      done += step;
      await sleep(rnd(28, 90));
    }
    if (Math.random() < 0.22) {           // иногда чуть назад, как живой человек
      window.scrollBy({ top: -rnd(30, 110), behavior: "auto" });
      await sleep(rnd(150, 400));
    }
    await sleep(rnd(180, 520));
  }

  // ──────────────────────────────────────────────────────────
  //  УКАЗАТЕЛЬ
  // ──────────────────────────────────────────────────────────
  function pointAt(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width * rnd(0.35, 0.65)),
      y: Math.round(r.top + r.height * rnd(0.35, 0.65)),
    };
  }

  function fire(el, type, pt, extra = {}) {
    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
      button: 0, buttons: type.includes("down") ? 1 : 0, ...extra,
    };
    const Ctor = type.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
    try { el.dispatchEvent(new Ctor(type, type.startsWith("pointer") ? { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true } : common)); }
    catch { el.dispatchEvent(new MouseEvent(type, common)); }
  }

  /** Реально ли этот элемент под курсором в данной точке (не перекрыт ли). */
  function hitTest(el, pt) {
    const top = document.elementFromPoint(pt.x, pt.y);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  }

  /**
   * Полноценный «человеческий» клик: наведение, задержка, нажатие, отпускание.
   * Возвращает false, если цель не удалось довести до экрана или она перекрыта.
   */
  async function click(el, { center = true } = {}) {
    if (!el || !document.body.contains(el)) return false;
    // Страховка: движок никогда не должен кликать по собственной разметке.
    // Именно так он раньше попадал в свою кнопку «✦» и запускал вторую
    // генерацию поверх уже открытого композера.
    if (window.DST.ours?.isOurs(el)) return false;
    if (center) await scrollToCenter(el);

    let pt = pointAt(el);
    if (!hitTest(el, pt)) {
      // перекрыто (шапка/липкая панель) — сдвигаем ленту и пробуем ещё раз
      window.scrollBy({ top: -110, behavior: "auto" });
      await sleep(260);
      pt = pointAt(el);
      if (!hitTest(el, pt)) {
        try { el.click(); return true; } catch { return false; }
      }
    }

    await cursorGlide(pt);              // видимый проезд мыши к цели
    fire(el, "pointerover", pt); fire(el, "mouseover", pt);
    fire(el, "pointermove", pt); fire(el, "mousemove", pt);
    await sleep(rnd(60, 190));
    cursorPulse();                      // визуальный «щелчок»
    fire(el, "pointerdown", pt); fire(el, "mousedown", pt);
    try { el.focus?.({ preventScroll: true }); } catch {}
    await sleep(rnd(45, 130));
    fire(el, "pointerup", pt); fire(el, "mouseup", pt);
    fire(el, "click", pt);
    await sleep(rnd(120, 300));
    return true;
  }

  /** Навести курсор без клика — Threads по hover показывает часть кнопок. */
  async function hover(el) {
    if (!el) return false;
    const pt = pointAt(el);
    await cursorGlide(pt);              // видимый проезд мыши к цели
    fire(el, "pointerover", pt); fire(el, "mouseover", pt);
    fire(el, "pointermove", pt); fire(el, "mousemove", pt);
    await sleep(rnd(90, 220));
    return true;
  }

  // ──────────────────────────────────────────────────────────
  //  ВВОД ТЕКСТА
  // ──────────────────────────────────────────────────────────
  /** Печать по символам — для React-полей надёжнее разовой вставки. */
  async function type(el, text, { humanize = true } = {}) {
    await scrollToCenter(el, { tolerance: 140 });
    el.focus?.({ preventScroll: true });
    await sleep(rnd(90, 200));

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (!humanize) {
        setter.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      let acc = "";
      for (const ch of text) {
        acc += ch; setter.call(el, acc);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(rnd(18, 55));
      }
      return true;
    }

    // contenteditable
    try {
      const sel = window.getSelection(); sel.removeAllRanges();
      const r = document.createRange(); r.selectNodeContents(el); sel.addRange(r);
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch {}

    if (!humanize) {
      const ok = document.execCommand("insertText", false, text);
      if (!ok) { el.textContent = text; el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); }
      return true;
    }
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      const ok = document.execCommand("insertText", false, ch);
      // Раньше здесь было el.textContent += ch — это ломало внутреннее
      // состояние Lexical, и кнопка отправки оставалась неактивной.
      if (!ok) el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(rnd(20, 62));
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────
  //  КАЛИБРОВКА
  // ──────────────────────────────────────────────────────────
  /**
   * Проверяет всю цепочку на текущей странице, ничего не отправляя:
   * находится ли пост, кнопка ответа, открывается ли поле ввода,
   * находится ли кнопка отправки. Результат — понятный отчёт.
   */
  async function calibrate(sel) {
    const dom = window.DST.dom, find = window.DST.find, res = window.DST.resolve;
    const out = { page: find.where(), url: location.href, steps: [] };
    const step = (name, ok, note) => out.steps.push({ name, ok, note: note || "" });

    const link = find.visible ? (window.DST.ours.qsa(document, sel.postLink)[0] || null)
                              : document.querySelector(sel.postLink);
    step("Пост найден", !!link, link ? "" : "открой ленту threads.com или страницу поиска");
    if (!link) { out.ok = false; return out; }

    const cont = dom.postContainerFromLink(link);
    const postsInside = cont ? cont.querySelectorAll('a[href*="/post/"]').length : 0;
    step("Карточка поста определена", !!cont && postsInside <= 1,
         cont ? `постов внутри карточки: ${postsInside}` : "");
    if (!cont) { out.ok = false; return out; }

    const post = dom.parseContainer(link, sel);
    step("Текст и метрики прочитаны", !!(post && post.text),
         post ? `@${post.author} · ♥${post.likes} 💬${post.comments} · ${post.text.slice(0, 40)}…` : "");

    const centered = await scrollToCenter(cont);
    step("Скролл до карточки", centered);

    // ВАЖНО: проверяем ровно тот путь, которым ходит движок (resolve.replyTargets).
    // Раньше калибровка звала устаревший replyCandidates и кликала в аватарку —
    // отчёт врал и в плюс, и в минус.
    const targets = res ? await res.replyTargets(cont, sel) : [];
    const named = targets.slice(0, 4).map((t) => {
      const l = (t.el.getAttribute?.("aria-label") || t.el.textContent || "").trim().slice(0, 20);
      return `${t.why}${l ? `«${l}»` : ""}`;
    }).join(", ");
    step("Кнопка ответа найдена", targets.length > 0, named || "целей нет");

    let field = find.replyFieldFor(cont, sel);
    let usedWhy = field ? "already-open" : "";
    for (const t of targets) {
      if (field) break;
      usedWhy = t.why;
      await click(t.el);
      await sleep(1000);
      field = find.replyFieldFor(cont, sel);
      if (!field) await dom.closeStrayPopovers();
    }
    step("Поле ввода открылось", !!field,
         field ? `через: ${usedWhy} · ${field.via}` : "ни одна цель не открыла поле ответа");

    if (field) {
      const btn = res ? await res.sendTarget(field.scope, sel, { allowModel: false, wait: 1200 })
                      : find.submitButton(field.scope, sel);
      step("Кнопка отправки найдена", !!btn,
           btn ? (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 28)
               : "поле пустое — кнопка появится после ввода текста");
      await dom.closeComposer();
    }
    out.ok = out.steps.every((s) => s.ok);
    return out;
  }

  window.DST.aim = {
    scrollToCenter, settle, humanScroll, scrollParent,
    click, hover, type, pointAt, hitTest,
    calibrate, sleep, rnd,
    cursorTo, cursorGlide, cursorPulse, cursorHide, cursorEnable,
  };
})();
