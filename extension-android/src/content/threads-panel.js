// threads-panel.js — плавающая панель + кнопка «✦» на каждом посте.
//
// ВАЖНО. Вся разметка расширения помечается data-dst-ui="1" (см.
// threads-resolve.js → window.DST.ours). Без этой пометки движок принимал
// собственную кнопку «✦ Сгенерировать комментарий» за кнопку «Ответить»
// (в подписи есть «коммент»), кликал по ней, запускал вторую генерацию
// поверх открытого композера и терял поле — отсюда «Не отправилось: поле
// исчезло» и посторонние черновики в ленте.
(() => {
  if (window.__dst2Panel) return;
  window.__dst2Panel = true;

  let panel, logBox, minimized = false;
  const OURS = () => window.DST?.ours;
  const markOurs = (el) => { try { el.setAttribute("data-dst-ui", "1"); } catch {} return el; };

  // На телефоне плавающая панель не показывается: её роль берёт на себя
  // нижняя шторка (sheet.js), у которой те же кнопки, но она не закрывает
  // ленту и не теряется за краем экрана. Две конкурирующие панели на
  // экране шириной 380 пикселей — это не выбор, а беспорядок.
  const NARROW = (() => {
    try { return Math.min(screen.width, screen.height) <= 820; } catch { return false; }
  })();

  chrome.storage.local.get("panelEnabled", ({ panelEnabled }) => {
    if (panelEnabled === false) return;
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", init);
    else init();
  });

  function init() {
    build(); observePosts(); refresh();
    if (NARROW && panel) panel.style.display = "none";
    const missing = ["dom", "aim", "find", "engine", "rpc", "ours"].filter((n) => !window.DST?.[n]);
    if (missing.length) {
      addLog({ msg: "✕ Не загрузились модули: " + missing.join(", "), kind: "err" });
      addLog({ msg: "Обнови расширение на chrome://extensions и нажми F5", kind: "err" });
    } else {
      addLog({ msg: "AI Threads готов. Начни с «Калибровки».", kind: "ok" });
    }
    chrome.storage.onChanged.addListener((c, a) => {
      if (a === "local" && (c._engine || c.commentMode)) refresh();
    });
    // Раньше здесь стоял setInterval(refresh, 5000): два сообщения в
    // service-worker каждые 5 секунд не давали MV3-воркеру заснуть.
    // Основной источник обновлений — storage.onChanged выше, интервал
    // оставлен как редкий фолбэк.
    setInterval(refresh, 30000);
  }

  function build() {
    panel = document.createElement("div");
    panel.className = "dst-panel";
    markOurs(panel);
    panel.innerHTML = `
      <div class="dst-head">
        <span class="dst-dot" id="dst-dot"></span><b>AI Threads</b><span class="dst-sp"></span>
        <button data-a="min">–</button>
      </div>
      <div class="dst-body">
        <div class="dst-row">
          <button data-a="chat" class="dst-primary">Открыть чат</button>
        </div>
        <div class="dst-row">
          <button data-a="parse">Парсинг</button>
          <button data-a="leads">Клиенты</button>
        </div>
        <div class="dst-modes">
          <button data-a="mode-auto"   data-m="auto">Авто</button>
          <button data-a="mode-manual" data-m="manual">Вручную</button>
        </div>
        <div class="dst-stat">
          <span>найдено <b id="dst-s-seen">0</b></span>
          <span>готово <b id="dst-s-gen">0</b></span>
          <span>отправлено <b id="dst-s-sent">0</b></span>
        </div>
        <div class="dst-row">
          <button data-a="comment" class="dst-primary">▶ Запустить</button>
        </div>
        <div class="dst-row">
          <button data-a="post" class="dst-primary">Автопост</button>
        </div>
        <div class="dst-row dst-small">
          <button data-a="diag" title="Калибровка">Калибровка</button><button data-a="opts" title="Настройки">⚙</button>
        </div>
        <div class="dst-log" id="dst-log"></div>
      </div>`;
    // помечаем всё поддерево, чтобы ни один сканер DOM его не увидел
    panel.querySelectorAll("*").forEach(markOurs);
    document.documentElement.appendChild(panel);
    logBox = panel.querySelector("#dst-log");
    drag(panel, panel.querySelector(".dst-head"));
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      const a = btn?.dataset.a;
      if (!a) return;
      Promise.resolve(act(a, btn)).catch((err) => {
        addLog({ msg: "✕ " + (err?.message || err), kind: "err" });
        console.error("[AI Threads]", err);
      });
    });
    window.addEventListener("dst-log", (e) => addLog(e.detail));

    // Шторка и боковая панель не повторяют логику кнопок, а вызывают ту
    // же act(). Дублировать её было бы худшим из решений: расхождение
    // между «Запустить» на телефоне и на компьютере обнаружилось бы уже
    // у пользователя, а не здесь.
    // Тот же обработчик доступен изнутри страницы, без chrome.tabs.
    // Панель в шторке живёт в iframe в ЭТОЙ же вкладке, и слать команды
    // через chrome.tabs.sendMessage было ошибкой: адресат выбирался
    // поиском по всем вкладкам и на телефоне с несколькими открытыми
    // Threads попадал в старую усыплённую вкладку. Отсюда «Страница
    // Threads не отвечает» при живой странице прямо под шторкой.
    window.addEventListener("dst-panel-act", (e) => {
      const { action, reply } = e.detail || {};
      if (!action) return;
      runAct(action).then(reply || (() => {}));
    });

    async function runAct(action) {
      const real = panel?.querySelector(`[data-a="${action}"]`);
      const btn = real || Object.assign(document.createElement("button"), { dataset: {} });
      try {
        await act(action, btn);
        return { ok: true, label: btn.textContent, busy: btn.dataset.busy === "1" };
      } catch (err) {
        addLog({ msg: "✕ " + (err?.message || err), kind: "err" });
        return { ok: false, error: err?.message || String(err) };
      }
    }

    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg?.type !== "RPC_PANEL_ACT") return;
      const real = panel?.querySelector(`[data-a="${msg.action}"]`);
      // Если кнопки в разметке нет (панель скрыта), подсовываем пустышку:
      // act() пишет в неё состояние busy и подпись, но наружу это не идёт.
      const btn = real || Object.assign(document.createElement("button"), { dataset: {} });
      Promise.resolve(act(msg.action, btn))
        .then(() => reply({ ok: true, label: btn.textContent, busy: btn.dataset.busy === "1" }))
        .catch((err) => {
          addLog({ msg: "✕ " + (err?.message || err), kind: "err" });
          reply({ ok: false, error: err?.message || String(err) });
        });
      return true;
    });
  }

  const R = () => window.DST?.rpc;
  const E = () => window.DST?.engine;
  const dom = () => window.DST?.dom;

  // Через общий слой из threads-rpc: там три попытки разбудить фон и
  // чтение из storage, если он так и не ответил. Своя однократная
  // отправка была здесь единственной причиной пустых ответов на Android.
  const sendSW = (m) => {
    const rpc = window.DST?.rpc;
    if (rpc?.sw) {
      const { type, ...rest } = m;
      return rpc.sw(type, rest);
    }
    return new Promise((res) => chrome.runtime.sendMessage(m, (r) => {
      void chrome.runtime.lastError; res(r || {});
    }));
  };
  const engineState = () => (window.DST?.rpc?.engineState
    ? window.DST.rpc.engineState()
    : sendSW({ type: "ENGINE_GET" }).then((r) => r?.engine || { running: false, stats: {} }));

  async function refresh() {
    if (!panel) return;
    const [engine, { settings } = {}] = await Promise.all([
      engineState(),
      sendSW({ type: "GET_SETTINGS" }),
    ]);
    // Настроек может не быть, состояние движка есть всегда: оно читается
    // из storage напрямую, если фон спит.
    const mode = engine.running ? engine.mode : (settings?.commentMode || "auto");
    panel.querySelectorAll("[data-m]").forEach((b) =>
      b.classList.toggle("on", b.dataset.m === mode));
    const run = panel.querySelector('[data-a="comment"]');
    if (run) {
      run.textContent = engine.running ? "⏹ Остановить" : "▶ Запустить";
      run.classList.toggle("on", engine.running);
    }
    panel.querySelector("#dst-dot")?.classList.toggle("run", !!engine.running);
    const st = engine.stats || {};
    const set = (id, v) => { const el = panel.querySelector(id); if (el) el.textContent = v || 0; };
    set("#dst-s-seen", st.seen); set("#dst-s-gen", st.generated); set("#dst-s-sent", st.sent);
  }

  function requireModules(names) {
    const missing = names.filter((n) => !window.DST || !window.DST[n]);
    if (missing.length) {
      throw new Error(
        `Не загрузился модуль: ${missing.join(", ")}. ` +
        "Открой chrome://extensions → «Обновить», затем перезагрузи вкладку Threads (F5)."
      );
    }
  }

  // Парсинг можно прервать: раньше кнопка на 90 секунд становилась «мёртвой».
  let parseStop = false;

  async function act(a, btn) {
    requireModules(["dom", "aim", "find", "engine", "rpc", "ours"]);
    const r = R();
    switch (a) {
      case "min":
        minimized = !minimized;
        panel.querySelector(".dst-body").style.display = minimized ? "none" : "block";
        btn.textContent = minimized ? "+" : "–"; break;
      case "chat": {
        // Результат раньше игнорировался, и при неудаче кнопка выглядела
        // мёртвой: нажал — ничего. Молчащая кнопка хуже ошибки, потому
        // что человек не знает, что чинить.
        const res = await sendSW({ type: "OPEN_PANEL" });
        if (res && res.ok === false) addLog({ msg: "✕ " + (res.error || "панель не открылась"), kind: "err" });
        break;
      }
      case "opts": chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }); break;
      case "parse": {
        if (btn.dataset.busy === "1") { parseStop = true; addLog({ msg: "Останавливаю парсинг…" }); break; }
        btn.dataset.busy = "1"; btn.textContent = "⏹ Стоп"; parseStop = false;
        try {
          addLog({ msg: "Парсю ленту…" });
          const s = await r.getSettings();
          const posts = await dom().collectPosts(s.sel, s.parseTarget, s.parseMaxScrolls,
            (n, t) => addLog({ msg: `Собрано ${n}/${t}` }), () => parseStop);
          if (!posts.length) { addLog({ msg: "Ничего не нашлось — пролистай ленту и повтори", kind: "err" }); break; }
          const saved = await sendSW({ type: "SAVE_POSTS", posts });
          addLog({ msg: `Готово: ${posts.length} постов (всего в базе ${saved?.total ?? "?"})`, kind: "ok" });
        } finally { btn.dataset.busy = "0"; btn.textContent = "Парсинг"; parseStop = false; }
        break;
      }
      case "leads": {
        const s = await r.getSettings();
        addLog({ msg: "Собираю посты для оценки…" });
        const posts = await dom().collectPosts(s.sel, Math.min(30, s.parseTarget), 14,
          (n, t) => addLog({ msg: `Собрано ${n}/${t}` }));
        if (!posts.length) { addLog({ msg: "Постов не нашлось — пролистай ленту", kind: "err" }); break; }
        addLog({ msg: `Оцениваю ${posts.length} авторов…` });
        const leads = [];
        for (const p of posts) {
          if (!E().passes(p, s)) continue;
          const prompt = s.leadPrompt
            .replace("{brand}", s.hunter?.product || s.brand || "AI Threads")
            .replace("{author}", p.author).replace("{post}", p.text.slice(0, 700));
          const resp = await sendSW({ type: "AI_CHAT", messages: [{ role: "user", content: prompt }] });
          if (!resp?.ok) { addLog({ msg: "Модель: " + (resp?.error || "?"), kind: "err" }); break; }
          try {
            const m = (resp.text || "").match(/\{[\s\S]*\}/);
            const j = JSON.parse(m ? m[0] : resp.text);
            if (j.is_lead) {
              leads.push({ ...p, score: j.score || 0, reason: j.reason || "", angle: j.angle || "" });
              addLog({ msg: `🎯 @${p.author} — ${j.score}/100 · ${j.reason}`, kind: "ok" });
            }
          } catch {}
        }
        if (leads.length) {
          await sendSW({ type: "SAVE_LEADS", leads });
          addLog({ msg: `Готово: ${leads.length} клиентов. Смотри вкладку «Клиенты».`, kind: "ok" });
        } else addLog({ msg: "Подходящих клиентов не нашлось на этом экране." });
        break;
      }
      case "mode-auto":
      case "mode-manual": {
        const mode = btn.dataset.m;
        await sendSW({ type: "SET_SETTINGS", patch: { commentMode: mode } });
        await sendSW({ type: "ENGINE_SET", patch: { mode } });
        await refresh();
        addLog({
          msg: mode === "auto"
            ? "Режим «Авто»: сам находит посты и отправляет комментарии."
            : "Режим «Вручную»: находит и пишет, отправка — после подтверждения в боковой панели.",
          kind: "ok",
        });
        break;
      }
      case "comment": {
        const e = await engineState();
        if (e.running) { await E().stop(); }
        else {
          const s = await r.getSettings();
          const res = await E().start(s.commentMode || "auto");
          if (res && res.ok === false && res.error) addLog({ msg: "✕ " + res.error, kind: "err" });
        }
        await refresh();
        break;
      }
      case "post": {
        if (!r?.startPosting) throw new Error("Модуль постинга не загрузился — обнови страницу");
        const run = r.isRunning();
        if (run.post) { r.stopPosting(); btn.textContent = "Автопост"; btn.classList.remove("on"); }
        else {
          btn.textContent = "⏹ Стоп"; btn.classList.add("on");
          const res = await r.startPosting();
          if (res && res.ok === false) {
            addLog({ msg: "✕ " + (res.error || "не удалось запустить"), kind: "err" });
          }
          btn.textContent = "Автопост"; btn.classList.remove("on");
        }
        break;
      }
      case "diag": {
        const s = await r.getSettings();
        addLog({ msg: "Калибровка: прохожу всю цепочку без отправки…" });
        const res = await window.DST.aim.calibrate(s.sel);
        for (const st of res.steps) {
          addLog({ msg: `${st.ok ? "✓" : "✕"} ${st.name}${st.note ? " — " + st.note : ""}`,
                   kind: st.ok ? "ok" : "err" });
        }
        addLog({ msg: "Проверяю способы ввода текста…" });
        const ins = await window.DST.dom.diagnoseInsertion(s.sel);
        if (ins.error) {
          addLog({ msg: "✕ " + ins.error, kind: "err" });
        } else {
          for (const t of ins.tried) {
            addLog({ msg: `${t.ok ? "✓" : "✕"} ввод «${t.name}»`, kind: t.ok ? "ok" : "err" });
          }
          addLog({
            msg: ins.ok
              ? `Рабочий способ ввода: ${ins.working.join(", ")} — запомнил его.`
              : "Ни один способ ввода не принят. Пришли этот лог — подберу приём под твою сборку Threads.",
            kind: ins.ok ? "ok" : "err",
          });
        }
        addLog({ msg: res.ok && ins.ok ? "Всё найдено — можно запускать." :
                              "Часть шагов не прошла: смотри ✕ выше.", kind: (res.ok && ins.ok) ? "ok" : "err" });
        console.log("[AI Threads] calibrate", res, ins);
        break;
      }
    }
  }

  function addLog({ msg, kind }) {
    // Раньше лог был только внутри плавающей панели. На телефоне она
    // скрыта, и вся диагностика — «нашлось столько-то», «не вставилось» —
    // уходила в никуда: человек видел неподвижную кнопку и не знал,
    // работает что-то или нет. Теперь строка сначала уходит наружу.
    try {
      window.dispatchEvent(new CustomEvent("dst-log-out", { detail: { msg, kind, at: Date.now() } }));
    } catch {}
    if (!logBox) return;
    const l = document.createElement("div");
    l.className = "dst-line " + (kind || "");
    markOurs(l);
    l.textContent = `[${new Date().toLocaleTimeString().slice(0, 8)}] ${msg}`;
    logBox.appendChild(l); logBox.scrollTop = logBox.scrollHeight;
    while (logBox.children.length > 150) logBox.removeChild(logBox.firstChild);
  }

  // --- кнопка ✦ на каждом посте (генерация коммента) ---
  //
  // Раньше MutationObserver звал injectButtons() на каждый батч мутаций без
  // троттлинга, а сама вставка меняла React-дерево и вызывала новый батч.
  // Теперь: debounce + requestIdleCallback, и в один контейнер кнопка
  // ставится ровно один раз (маркер data-dst-host).
  let injectTimer = null;
  function scheduleInject() {
    if (injectTimer) return;
    injectTimer = setTimeout(() => {
      injectTimer = null;
      const go = () => { try { injectButtons(); } catch {} };
      if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 800 });
      else go();
    }, 400);
  }

  function observePosts() {
    const obs = new MutationObserver((records) => {
      // мутации внутри нашей же разметки игнорируем — иначе сами себя будим
      for (const r of records) {
        if (!OURS()?.isOurs(r.target)) { scheduleInject(); return; }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scheduleInject();
  }

  function injectButtons() {
    const links = OURS().qsa(document, 'a[href*="/post/"]');
    const done = new Set();
    for (const a of links) {
      const m = (a.getAttribute("href") || "").match(/\/post\/([A-Za-z0-9_\-]+)/);
      if (!m) continue;
      const code = m[1];
      if (done.has(code)) continue;
      const cont = dom()?.postContainerFromLink(a);
      if (!cont || OURS().isOurs(cont)) continue;
      // карточка должна описывать ровно один пост — иначе получались
      // дублирующиеся «✦» на вложенных контейнерах
      if (cont.querySelectorAll('a[href*="/post/"]').length > 1) continue;
      done.add(code);
      if (cont.dataset.dstHost === code) continue;
      if (cont.querySelector('.dst-gen')) continue;

      const b = document.createElement("button");
      b.className = "dst-gen";
      markOurs(b);
      b.textContent = "✦";
      b.title = "Сгенерировать комментарий (AI Threads)";
      b.setAttribute("aria-hidden", "true");
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        genForPost(code, cont, b);
      });
      try {
        cont.dataset.dstHost = code;
        if (!cont.style.position) cont.style.position = "relative";
        cont.appendChild(b);
      } catch {}
    }
  }

  async function genForPost(code, cont, btn) {
    const r = R(); const d = dom();
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.textContent = "…";
    try {
      const a = cont.querySelector('a[href*="/post/' + code + '"]');
      const s = await r.getSettings();
      const post = d.parseContainer(a, s.sel);
      if (!post) throw new Error("не удалось прочитать пост");
      const text = await r.generateComment(post, s);
      addLog({ msg: `✦ @${post.author}: ${text}`, kind: "ok" });
      // Всегда только черновик: отправку подтверждает человек.
      const res = await d.commentOnPost(code, text, s.sel, "manual");
      btn.textContent = res.ok ? "✓" : "✕";
      if (!res.ok) addLog({ msg: "Не вставилось: " + res.error, kind: "err" });
    } catch (e) {
      btn.textContent = "✕"; addLog({ msg: e.message, kind: "err" });
    } finally {
      btn.dataset.busy = "0";
      setTimeout(() => (btn.textContent = "✦"), 2500);
    }
  }

  function drag(box, handle) {
    let sx, sy, ox, oy, on = false; handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!on) return; box.style.left = ox + (e.clientX - sx) + "px";
      box.style.top = oy + (e.clientY - sy) + "px"; box.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (on = false));
  }
})();
