// threads-rpc.js — исполнитель команд от side-panel/service-worker + локальный движок.
(() => {
  if (window.DST && window.DST.rpc) return;
  window.DST = window.DST || {};
  const dom = () => window.DST.dom;

  const log = (msg, kind) =>
    window.dispatchEvent(new CustomEvent("dst-log", { detail: { msg, kind } }));

  function once(type, payload) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (r) => {
          const err = chrome.runtime.lastError;
          res(err ? { ok: false, error: err.message, _dead: true } : (r || { ok: false, error: "пустой ответ" }));
        });
      } catch (e) { res({ ok: false, error: e.message, _dead: true }); }
    });
  }

  // Service worker в MV3 засыпает. Первое сообщение после сна будит его,
  // но иногда теряется — поэтому две попытки с паузой.
  async function sw(type, payload = {}) {
    let r = await once(type, payload);
    if (r._dead) { await new Promise((x) => setTimeout(x, 400)); r = await once(type, payload); }
    // Третья попытка появилась после Android. Там фон — не service worker,
    // а event page, и просыпается он заметно медленнее: двух попыток с
    // паузой 400 мс на слабом телефоне не хватало, ответ приходил пустым,
    // и вызывающий код падал на разборе несуществующего объекта.
    if (r._dead) { await new Promise((x) => setTimeout(x, 1200)); r = await once(type, payload); }
    return r;
  }

  /**
   * Состояние движка, которое всегда есть.
   *
   * Раньше писали `(await sw("ENGINE_GET")).engine` и сразу читали
   * `.running`. Когда фон спал, `engine` приходил undefined — отсюда
   * «Cannot read properties of undefined (reading 'running')» в логах.
   * Ошибка выглядела как поломка движка, хотя движок был ни при чём:
   * не доехал ответ.
   *
   * Состояние движка целиком лежит в chrome.storage.local._engine, а
   * content script читает storage напрямую. Значит фон здесь — удобство,
   * а не необходимость, и падать из-за его сна незачем.
   */
  const ENGINE_FALLBACK = { running: false, mode: "auto", stats: {} };
  async function engineState() {
    const r = await sw("ENGINE_GET");
    if (r?.engine) return r.engine;
    try {
      const { _engine } = await chrome.storage.local.get("_engine");
      return { ...ENGINE_FALLBACK, ...(_engine || {}) };
    } catch {
      return { ...ENGINE_FALLBACK };
    }
  }

  // Настройки читаем напрямую из storage, если фон не ответил:
  // content-script имеет доступ к chrome.storage, и это убирает
  // единственную точку отказа для всех кнопок панели.
  let _selCache = null;
  async function getSettings() {
    const r = await sw("GET_SETTINGS");
    if (r?.settings) { _selCache = r.settings; return r.settings; }
    try {
      const raw = await chrome.storage.local.get(null);
      const s = { ...(window.DST.DEFAULTS || {}), ...raw };
      s.sel = { ...(window.DST.DEFAULTS?.sel || {}), ...(raw.sel || {}) };
      s.source = { feed: true, search: true, queries: [], searchFilter: "recent",
                   postsPerQuery: 25, rotateEveryMin: 12, ...(raw.source || {}) };
      if (!s.sel.postLink) throw new Error("нет селекторов");
      log("⚠ Фон не отвечает — работаю на локальных настройках", "err");
      _selCache = s;
      return s;
    } catch (e) {
      if (_selCache) return _selCache;
      throw new Error("Не удалось получить настройки: " + (r?.error || e.message) +
                      ". Перезагрузи расширение на chrome://extensions.");
    }
  }
  const aiChat = (messages) => sw("AI_CHAT", { messages });
  const tgSend = (text) => sw("TG_SEND", { text });
  const fill = (tpl, v) => String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));
  const num = (v, d) => { const n = Number(v); return isFinite(n) && n > 0 ? n : d; };

  function stripMd(t){return (t||"").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/__([^_]+)__/g,"$1").replace(/\*([^*\n]+)\*/g,"$1").replace(/`([^`]+)`/g,"$1").replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/\*\*/g,"").replace(/`/g,"").trim();}
  function clampComment(t, max) {
    t = stripMd(t).replace(/^["«»\s]+|["«»\s]+$/g, "");
    // оставляем одно предложение
    const m = t.match(/^[\s\S]*?[.!?…](?=\s|$)/);
    if (m && m[0].length >= 20) t = m[0].trim();
    if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "").trim();
    return t;
  }

  // Единый генератор — в threads-engine.js, чтобы формат комментария
  // (5–6 слов, эмодзи, фильтры) не расходился между ручным и авто-режимом.
  async function generateComment(post, s, preset) {
    if (window.DST.engine) {
      const s2 = preset ? { ...s, commentPrompt: preset } : s;
      return window.DST.engine.generate(post, s2);
    }
    const prompt = `${preset || s.commentPrompt}\n\nПост от @${post.author}:\n${post.text}\n\n` +
      `Ровно ${s.commentMinWords}–${s.commentMaxWords} слов. Только текст комментария.`;
    const r = await aiChat([{ role: "user", content: prompt }]);
    if (!r.ok) throw new Error(r.error);
    return clampComment(r.text, s.commentMaxChars);
  }

  // ---- RPC (команды извне) ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        const s = await getSettings();
        switch (msg?.type) {
          case "RPC_PING":
            sendResponse({ ok: true, url: location.href });
            break;
          case "RPC_COLLECT": {
            const want = msg.target || s.parseTarget;
            const posts = await dom().collectPosts(
              s.sel, want, s.parseMaxScrolls,
              (n, t) => log(`Собрано ${n}/${t}`)
            );
            if (posts.length < want) {
              log(`Лента отдала ${posts.length} из ${want} — дальше постов нет`, "err");
            }
            sendResponse({ ok: true, posts, requested: want,
                           reached: posts.length, url: location.href });
            break;
          }
          // Здоровье вкладки: авторизованы ли мы и видит ли расширение посты.
          case "RPC_HEALTH": {
            const q = (sel2) => document.querySelector(sel2);
            const bodyTxt = (document.body?.innerText || "").toLowerCase();
            const loginWall =
              /(^|\n)\s*(войти|log in|login|sign up|зарегистрироваться)\s*($|\n)/i.test(bodyTxt) &&
              !q('a[href^="/@"]');
            // признаки залогиненного интерфейса
            const hasComposer = !!dom().findButtonByLabels(document.body, s.sel.composerTriggerLabels);
            const hasProfile = !!q('a[href*="/@"]');
            const postLinks = document.querySelectorAll(s.sel.postLink).length;
            const replyBtn = !!dom().findButtonByLabels(document.body, s.sel.replyButtonLabels);
            sendResponse({ ok: true, data: {
              url: location.href,
              loggedIn: !loginWall && (hasComposer || hasProfile),
              hasComposer, postLinks, replyControls: replyBtn,
              editables: document.querySelectorAll(s.sel.editable).length,
            } });
            break;
          }
          // Дождаться, пока карточка нужного поста реально отрисуется.
          // Без этого панель отправляла RPC_COMMENT в скелетон страницы.
          case "RPC_WAIT_POST": {
            const cont = await dom().waitFor(
              () => dom().containerByCode(msg.code), msg.timeout || 12000);
            if (!cont) {
              // ветка могла не догрузиться — подтолкнём её скроллом
              window.scrollBy(0, 400);
              await dom().sleep(1200);
            }
            const ok = !!dom().containerByCode(msg.code);
            sendResponse({ ok, url: location.href,
                           error: ok ? "" : "ветка не отрисовалась" });
            break;
          }
          case "RPC_COMMENT": {
            const like = msg.like != null ? msg.like : s.likeOnComment;
            const r = await dom().commentOnPost(msg.code, msg.text, s.sel, msg.mode || s.commentMode, { like });
            sendResponse(r);
            break;
          }
          case "RPC_LIKE": {
            const cont = dom().containerByCode(msg.code) || document.body;
            sendResponse({ ok: true, result: dom().likePost(cont, s.sel) });
            break;
          }
          case "RPC_GEN_COMMENT": {
            const c = await generateComment(msg.post, s, msg.preset);
            sendResponse({ ok: true, text: c });
            break;
          }
          case "RPC_POST": {
            const r = await dom().createPost(msg.text, s.sel, msg.mode || "review", msg.file || null);
            sendResponse(r);
            break;
          }
          case "RPC_DM_SCAN":
            sendResponse({ ok: true, convs: dom().dmScan(s.sel) }); break;
          case "RPC_DM_OPEN":
            sendResponse(await dom().dmOpen(msg.index, s.sel, msg.href)); break;
          case "RPC_DM_READ":
            sendResponse({ ok: true, text: dom().dmReadLast() }); break;
          case "RPC_DM_HISTORY": {
            const hist = await dom().dmWaitHistory(msg.timeout || 10000);
            sendResponse({ ok: true, history: hist, needsReply: dom().dmNeedsReply() });
            break;
          }
          // Диагностика ролей: видно, какая реплика чья и почему. Нужна,
          // когда агент снова начнёт «читать и пропускать» — гадать по
          // логу «последнее слово за мной» бесполезно.
          case "RPC_DM_ROLES":
            sendResponse({ ok: true, data: dom().dmRolesDebug() }); break;
          case "RPC_DM_SEND":
            sendResponse(await dom().dmSend(msg.text, s.sel)); break;
          case "RPC_DM_DRAFT":
            sendResponse(await dom().dmDraft(msg.text, s.sel)); break;
          case "RPC_DM_FROM_PROFILE":
            sendResponse(await dom().dmFromProfile()); break;
          case "RPC_DM_BACK":
            sendResponse(await dom().dmBack()); break;
          case "RPC_DIAGNOSE":
            sendResponse({ ok: true, data: dom().diagnose(s.sel) });
            break;
          case "START_COMMENTING":
            sendResponse(await window.DST.engine.start(msg.mode || s.commentMode));
            break;
          case "STOP_COMMENTING":
            sendResponse(await window.DST.engine.stop());
            break;
          case "RPC_SEND_PENDING":
            sendResponse(await window.DST.engine.sendPending(msg.code, msg.text));
            break;
          case "RPC_REPORT":
            sendResponse({ ok: true, data: window.DST.find.report(s.sel) });
            break;
          case "START_POSTING":
            // Раньше результат не ждали и отвечали ok:true даже когда
            // автопост уже шёл или падал на первом же шаге.
            sendResponse(await startPosting());
            break;
          case "STOP_POSTING":
            stop.post = true; sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false, error: "unknown rpc" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  });

  // ---- Постинг (комментингом заведует threads-engine.js) ----
  const stop = { post: false };
  const running = { post: false };

  function passesFilters(p, s) {
    const t = (p.text || "").toLowerCase();
    if (!t) return false;
    if ((s.stopKeywords || []).some((k) => k && t.includes(k.toLowerCase()))) return false;
    if (s.minLikes && p.likes < s.minLikes) return false;
    if (s.minReplies && p.comments < s.minReplies) return false;
    return true;
  }

  /** Прерываемое ожидание: «Стоп» больше не ждёт конца 40-минутной паузы. */
  async function idlePost(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      if (stop.post) return false;
      await dom().sleep(Math.min(1000, end - Date.now()));
    }
    return !stop.post;
  }

  async function startPosting() {
    if (running.post) return { ok: false, error: "автопост уже идёт" };
    running.post = true; stop.post = false;
    log("▶️ Автопостинг запущен", "ok");
    try {
      while (!stop.post) {
        const s = await getSettings();
        const c = (await sw("GET_COUNTERS")).counters;
        if (!c) { log("Фон не отвечает — останавливаюсь", "err"); break; }
        if (c.posts >= s.maxPostsPerDay) { log(`Лимит постов/день (${s.maxPostsPerDay})`, "err"); break; }

        const topics = s.postTopics || [];
        if (!topics.length) { log("Очередь тем пуста — добавь темы в настройках.", "err"); break; }
        const topic = topics[0];

        const prompt = fill(s.postPrompt, { brandName: s.brandName, niche: s.niche, topic });
        const r0 = await aiChat([{ role: "user", content: prompt }]);
        if (!r0.ok) { log("Модель: " + r0.error, "err"); if (!(await idlePost(5000))) break; continue; }

        const text = stripMd(r0.text || "").trim();
        // Модель иногда отдаёт огрызок («О», «Да»). Публиковать такое нельзя —
        // пост уходил в ленту как одна буква. Пробуем ещё раз, потом пропускаем.
        const badPost = !text || text.length < 40 || text.split(/\s+/).filter(Boolean).length < 6;
        if (badPost) {
          log(`Модель вернула огрызок («${text.slice(0, 20)}») — повтор`, "err");
          if (!(await idlePost(2000))) break;
          const r1 = await aiChat([{ role: "user", content: prompt }]);
          const t1 = stripMd((r1 && r1.text) || "").trim();
          if (!t1 || t1.length < 40) { log("Тема пропущена — модель не дала текст", "err"); await sw("SHIFT_TOPIC"); continue; }
          r0.text = t1;
        }
        const finalText = stripMd(r0.text || "").trim();
        log(`📝 «${topic}»:\n${finalText}`);

        const mode = s.commentMode === "manual" ? "manual" : "auto";
        const r = await dom().createPost(finalText, s.sel, mode);
        await sw("SHIFT_TOPIC");

        if (r.sent) {
          await sw("BUMP_COUNTER", { field: "posts" });
          log(`Опубликовано ✅ (подтверждение: ${r.confirmed || "?"})`, "ok");
        } else if (r.risky) {
          // Публикация могла пройти — повторять нельзя, иначе будет дубль.
          await sw("BUMP_COUNTER", { field: "posts" });
          log("⚠ Публикация не подтвердилась, но композер закрылся — повтор не делаю", "err");
        } else if (r.ok) {
          log("Черновик вставлен — подтверди отправку.", "ok");
        } else {
          log("Не вышло: " + (r.error || "?"), "err");
        }

        // Защита от NaN: если настройки пришли аварийным путём и полей нет,
        // rnd(undefined, undefined) давал NaN → sleep(NaN) → setTimeout(0) →
        // плотный цикл платных запросов к модели.
        const lo = num(s.postDelayMinSec, 900);
        const hi = Math.max(lo, num(s.postDelayMaxSec, 2400));
        const w = dom().rnd(lo, hi) * 1000;
        log(`Пауза ${(w / 60000).toFixed(1)} мин…`);
        if (!(await idlePost(w))) break;
      }
    } catch (e) {
      log("Автопостинг упал: " + (e.message || e), "err");
    } finally { running.post = false; log("⏹ Автопостинг остановлен"); }
    return { ok: true };
  }

  window.DST.rpc = {
    startPosting, stopPosting: () => (stop.post = true),
    isRunning: () => ({ ...running }),
    generateComment, getSettings,
    // Наружу — чтобы панель и шторка не заводили свои копии с другим
    // числом попыток и без запасного чтения из storage.
    sw, engineState,
  };
})();
