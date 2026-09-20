/**
 * sheet.js — нижняя шторка: полный интерфейс расширения внутри Threads.
 *
 * Зачем она вообще появилась. На телефоне «Открыть чат» вело в отдельную
 * вкладку: боковой панели в мобильных браузерах нет, а полноэкранный
 * оверлей закрывал ленту целиком. Отдельная вкладка — худший из вариантов
 * не потому, что неудобно переключаться, а потому что вкладка Threads
 * уходит в фон, мобильный браузер её усыпляет, и охотник вместе с
 * комментингом просто останавливается. Человек нажимал «Чат», чтобы
 * запустить охотника, и этим же действием его выключал.
 *
 * Шторка решает это по существу: она живёт в той же вкладке и не забирает
 * её у страницы. Лента остаётся видимой и прокручиваемой над шторкой,
 * вкладка не уходит в фон, движок продолжает работать.
 *
 * Внутри — тот же panel.html, что и в боковой панели на компьютере, в
 * iframe с origin расширения. Не копия интерфейса: копия разошлась бы с
 * оригиналом на первой же правке, и разошлась бы молча.
 *
 * Три высоты вместо свободного растягивания: пальцем точную высоту не
 * поймать, а три понятных положения ловятся с первого раза.
 */
(() => {
  if (window.__dstSheet) return;
  window.__dstSheet = true;

  const ID = "__aithreads_sheet";
  const PILL_ID = "__aithreads_pill";
  const PANEL_URL = "src/sidepanel/panel.html";
  const SNAPS = { peek: 0.34, half: 0.62, full: 0.94 };
  const ORDER = ["peek", "half", "full"];

  let host = null, frame = null, pill = null, snap = "half";

  const narrow = () => {
    try { return Math.min(screen.width, screen.height) <= 820; } catch { return false; }
  };
  const mark = (el) => { try { el.setAttribute("data-dst-ui", "1"); } catch {} return el; };

  function css(el, s) { el.style.cssText = s; return el; }

  function applySnap(next) {
    snap = next;
    if (host) host.style.height = Math.round(innerHeight * SNAPS[snap]) + "px";
    try { chrome.storage.local.set({ _sheetSnap: snap }); } catch {}
  }

  // ── Таблетка «развернуть» ──────────────────────────────────────
  // Свёрнутая шторка должна оставлять след: полностью исчезающий
  // интерфейс человек считает сломавшимся и переустанавливает расширение.
  function buildPill() {
    if (document.getElementById(PILL_ID)) return;
    pill = mark(document.createElement("button"));
    pill.id = PILL_ID;
    pill.textContent = "✦ AI";
    pill.setAttribute("aria-label", "Открыть AI Threads");
    css(pill, "position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));"
      + "z-index:2147483645;min-width:56px;min-height:44px;padding:0 14px;border:0;"
      + "border-radius:999px;background:#fff;color:#000;font:700 12px/1 ui-monospace,monospace;"
      + "letter-spacing:.08em;box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;display:none");
    pill.addEventListener("click", () => open());
    document.documentElement.appendChild(pill);
  }

  function build() {
    if (document.getElementById(ID)) return true;

    host = mark(document.createElement("div"));
    host.id = ID;
    css(host, "position:fixed;left:0;right:0;bottom:0;z-index:2147483646;"
      + "display:flex;flex-direction:column;background:#0b0b0c;"
      + "border-top:1px solid rgba(255,255,255,.14);"
      + "border-radius:16px 16px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.55);"
      + "padding-bottom:env(safe-area-inset-bottom,0px);"
      + "transition:height .18s ease,transform .18s ease");

    // Шапка: ручка потяга + три кнопки. Все цели не меньше 44 пикселей —
    // ниже этого палец промахивается, и человек винит в этом расширение.
    const head = mark(document.createElement("div"));
    css(head, "display:flex;align-items:center;gap:6px;padding:6px 8px 4px;"
      + "border-bottom:1px solid rgba(255,255,255,.08);touch-action:none;flex:0 0 auto");

    const grip = mark(document.createElement("div"));
    css(grip, "flex:1;min-height:44px;display:flex;align-items:center;justify-content:center;cursor:grab");
    const bar = mark(document.createElement("div"));
    css(bar, "width:44px;height:4px;border-radius:99px;background:rgba(255,255,255,.28)");
    grip.appendChild(bar);

    const mkBtn = (label, title, fn) => {
      const b = mark(document.createElement("button"));
      b.textContent = label;
      b.setAttribute("aria-label", title);
      css(b, "min-width:44px;min-height:44px;border:0;background:none;color:#bdbdbd;"
        + "font-size:15px;cursor:pointer;border-radius:10px");
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    head.appendChild(grip);
    head.appendChild(mkBtn("⤢", "Высота панели", cycle));
    head.appendChild(mkBtn("—", "Свернуть", collapse));

    frame = mark(document.createElement("iframe"));
    frame.src = chrome.runtime.getURL(PANEL_URL);
    frame.setAttribute("allow", "clipboard-write");
    css(frame, "flex:1 1 auto;width:100%;border:0;display:block;background:#0b0b0c");

    host.appendChild(head);
    host.appendChild(frame);
    document.documentElement.appendChild(host);

    dragHandle(head);
    buildPill();
    return true;
  }

  // ── Потяг ──────────────────────────────────────────────────────
  // Тянем — высота идёт за пальцем; отпустили — прилипаем к ближайшему
  // из трёх положений. Резкий свайп вниз с высоты peek сворачивает: это
  // то движение, которым закрывают любую шторку, и не поддержать его
  // значит заставлять человека целиться в маленький крестик.
  function dragHandle(el) {
    let startY = 0, startH = 0, dragging = false;

    const down = (y) => {
      dragging = true; startY = y;
      startH = host.getBoundingClientRect().height;
      host.style.transition = "none";
    };
    const move = (y) => {
      if (!dragging) return;
      const h = Math.max(90, Math.min(innerHeight * 0.96, startH - (y - startY)));
      host.style.height = h + "px";
    };
    const up = (y) => {
      if (!dragging) return;
      dragging = false;
      host.style.transition = "height .18s ease,transform .18s ease";
      const h = host.getBoundingClientRect().height;
      if (h < innerHeight * 0.18 || (y - startY) > 120 && snap === "peek") { collapse(); return; }
      let best = ORDER[0], diff = Infinity;
      for (const k of ORDER) {
        const d = Math.abs(innerHeight * SNAPS[k] - h);
        if (d < diff) { diff = d; best = k; }
      }
      applySnap(best);
    };

    el.addEventListener("touchstart", (e) => down(e.touches[0].clientY), { passive: true });
    el.addEventListener("touchmove", (e) => { move(e.touches[0].clientY); e.preventDefault(); },
                        { passive: false });
    el.addEventListener("touchend", (e) => up((e.changedTouches[0] || {}).clientY || 0));
    el.addEventListener("mousedown", (e) => { down(e.clientY); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => move(e.clientY));
    window.addEventListener("mouseup", (e) => up(e.clientY));
  }

  function cycle() {
    applySnap(ORDER[(ORDER.indexOf(snap) + 1) % ORDER.length]);
  }

  function open(which) {
    build();
    host.style.display = "flex";
    if (pill) pill.style.display = "none";
    applySnap(which || snap);
    return { ok: true, mode: "sheet" };
  }

  function collapse() {
    if (host) host.style.display = "none";
    if (pill) pill.style.display = "block";
  }

  chrome.storage.local.get("_sheetSnap", ({ _sheetSnap }) => {
    if (ORDER.includes(_sheetSnap)) snap = _sheetSnap;
    // Сама шторка при загрузке не открывается: человек пришёл читать
    // ленту, а не смотреть на наш интерфейс. Показываем таблетку.
    if (narrow()) buildPill();
    if (narrow() && pill) pill.style.display = "block";
  });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === "SHEET_OPEN") { reply(open(msg.snap)); return true; }
    if (msg?.type === "SHEET_CLOSE") { collapse(); reply({ ok: true }); return true; }
    if (msg?.type === "SHEET_AVAILABLE") { reply({ ok: true, narrow: narrow() }); return true; }
  });

  /* ── Мост «панель в шторке → страница» ───────────────────────
     Панель внутри iframe и страница Threads — одна и та же вкладка.
     Значит команду надо передавать напрямую, а не через chrome.tabs:
     тот выбирает вкладку поиском по всем открытым, и на телефоне с
     несколькими Threads попадал в старую усыплённую. Здесь адресат
     не выбирается вовсе — он один по построению. */
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__aithreads !== "PANEL_ACT") return;
    if (!frame || e.source !== frame.contentWindow) return;   // чужие фреймы не слушаем
    const done = (res) => {
      try { e.source.postMessage({ __aithreads: "PANEL_ACT_RESULT", id: d.id, res }, "*"); } catch {}
    };
    try {
      window.dispatchEvent(new CustomEvent("dst-panel-act", { detail: { action: d.action, reply: done } }));
    } catch (err) {
      done({ ok: false, error: err?.message || String(err) });
    }
  });

  // Логи из движка уходят в панель: на телефоне плавающего окна с логом
  // нет, и без этого вся диагностика пропадала бы молча.
  window.addEventListener("dst-log-out", (e) => {
    try { chrome.runtime.sendMessage({ type: "LOG_LINE", line: e.detail }); } catch {}
  });

  // Высота считается от innerHeight, а адресная строка на телефоне
  // прячется при прокрутке и меняет её. Без пересчёта шторка «отклеивается».
  window.addEventListener("resize", () => { if (host && host.style.display !== "none") applySnap(snap); });

  window.DST = window.DST || {};
  window.DST.sheet = { open, collapse, cycle };
})();
