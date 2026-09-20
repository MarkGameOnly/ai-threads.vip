// threads-engine.js — движок комментинга. window.DST.engine
//
// Два режима:
//   auto   — сам находит посты (лента + поиск), пишет и ОТПРАВЛЯЕТ комментарий
//   manual — находит и генерирует, кладёт в очередь; отправка по кнопке в панели
//
// Состояние живёт в chrome.storage (см. storage.js → getEngine): при переходе
// на страницу поиска вкладка перезагружается и content-script умирает. После
// загрузки движок сам поднимается и продолжает с того же места.
//
// ЗАЩИТА ОТ ПОВТОРНЫХ КОММЕНТАРИЕВ (главное изменение).
// Раньше пост помечался «прокомментировано» ДО отправки: если отправка не
// подтверждалась, пост сгорал навсегда, а при ретрае через пермалинк —
// наоборот, мог получить второй комментарий. Теперь работает двухфазная
// схема через service-worker:
//   CLAIM_POST   — атомарно занять пост (никакая другая вкладка его не возьмёт)
//   COMMIT_POST  — пометить окончательно, ТОЛЬКО после подтверждённой отправки
//   RELEASE_POST — отпустить с кулдауном, если отправить не вышло
// Плюс лок вкладки: одновременно комментирует ровно одна вкладка Threads.
(() => {
  if (window.DST && window.DST.engine) return;
  window.DST = window.DST || {};

  const dom = () => window.DST.dom;
  const find = () => window.DST.find;

  const num = (v, d) => { const n = Number(v); return isFinite(n) && n > 0 ? n : d; };

  const SRC_DEFAULT = {
    feed: true, search: true, queries: [], searchFilter: "recent",
    postsPerQuery: 25, rotateEveryMin: 12,
  };

  // Настройки могут прийти в обход merge (аварийное чтение storage при
  // спящем service worker), поэтому все числа страхуем дефолтами здесь же —
  // иначе rnd(undefined, undefined) даёт NaN и sleep(NaN) вырождается в 0 мс.
  function norm(s) {
    const o = { ...s };
    o.source = { ...SRC_DEFAULT, ...(s.source || {}) };
    if (!Array.isArray(o.source.queries)) o.source.queries = [];
    o.source.rotateEveryMin = num(o.source.rotateEveryMin, 12);
    o.commentMaxChars  = num(o.commentMaxChars, 130);
    o.commentMaxWords  = num(o.commentMaxWords, 22);
    o.commentMinWords  = num(o.commentMinWords, 4);
    o.commentEmoji     = o.commentEmoji || "auto";
    o.stopKeywords     = Array.isArray(o.stopKeywords) ? o.stopKeywords : [];
    o.maxCommentsPerDay = num(o.maxCommentsPerDay, 30);
    o.commentSleepSec  = num(o.commentSleepSec, 160);
    o.sel = { ...(window.DST.DEFAULT_SEL || {}), ...(s.sel || {}) };
    if (!o.sel.postLink) o.sel.postLink = 'a[href*="/post/"]';
    if (!o.sel.editable) o.sel.editable = 'div[contenteditable="true"], textarea';
    return o;
  }

  const log = (msg, kind) =>
    window.dispatchEvent(new CustomEvent("dst-log", { detail: { msg, kind } }));

  function sw(type, payload = {}) {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (r) =>
          res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r || { ok: false, error: "нет ответа от фона" })));
      } catch (e) { res({ ok: false, error: e.message }); }
    });
  }
  const getSettings = () => sw("GET_SETTINGS").then((r) => norm(r.settings || {}));
  const aiChat = (messages) => sw("AI_CHAT", { messages });
  // Панель здоровья/уведомления в боте: fire-and-forget, никогда не должно
  // тормозить или ронять сам цикл комментинга — см. shared/ext-events.js.
  const reportEvent = (kind, payload) => sw("EXT_EVENT", { kind, payload }).catch(() => {});

  // ── Пост-фактум сигнал: вырос ли счётчик ответов под нашим постом ──
  // Список наблюдения хранится прямо в chrome.storage.local (как _diag,
  // _engine и другие временные вещи в этом файле) — отдельный бэкенд-стор
  // тут не нужен, бэкенд получает только готовый результат через
  // reportEvent("reply_received", …).
  const WATCH_MIN_WAIT = 10 * 60 * 1000;   // раньше 10 минут проверять рано
  const WATCH_MAX_WAIT = 3 * 60 * 60 * 1000; // позже 3 часов — снимаем с наблюдения

  async function watchAdd(entry) {
    try {
      const { _replyWatch } = await chrome.storage.local.get("_replyWatch");
      const list = Array.isArray(_replyWatch) ? _replyWatch : [];
      list.push(entry);
      await chrome.storage.local.set({ _replyWatch: list.slice(-200) }); // не растим бесконечно
    } catch {}
  }

  /**
   * Проверяет только то, что СЕЙЧАС видно на экране — никаких
   * дополнительных переходов по ссылкам ради проверки. Это осознанное
   * ограничение первой версии: специальный обход постов только за тем,
   * чтобы проверить ответы, — это лишняя навигация по Threads, а лишняя
   * навигация — это то, чего Safe Mode как раз избегает. Пост попадёт
   * под проверку сам, когда естественно снова окажется на экране
   * (лента/поиск его покажут повторно, как уже бывает в логах).
   */
  async function watchCheckDue() {
    try {
      const { _replyWatch } = await chrome.storage.local.get("_replyWatch");
      const list = Array.isArray(_replyWatch) ? _replyWatch : [];
      if (!list.length) return;
      const now = Date.now();
      const rest = [];
      for (const w of list) {
        const age = now - w.sentAt;
        if (age < WATCH_MIN_WAIT) { rest.push(w); continue; }
        if (age > WATCH_MAX_WAIT) continue; // просрочено, тихо снимаем
        const n = dom().countReplies ? dom().countReplies(w.code) : null;
        if (n == null) { rest.push(w); continue; } // поста сейчас не видно — попробуем позже
        if (n > w.commentsBefore) {
          reportEvent("reply_received", { target_username: w.author,
            target_post_id: w.code, niche: w.niche || "" });
          continue; // сигнал получен — снимаем с наблюдения
        }
        rest.push(w);
      }
      await chrome.storage.local.set({ _replyWatch: rest });
    } catch {}
  }

  let loop = null;          // текущий цикл в этой вкладке
  let STOP = false;         // мгновенная остановка внутри вкладки
  let heartbeat = null;     // таймер лока вкладки

  // ── Прерываемое ожидание ──────────────────────────────────
  // Раньше движок спал одним sleep(160_000) и «Стоп» не действовал до конца
  // паузы (а вне активных часов — до 10 минут).
  async function stillRunning() {
    if (STOP) return false;
    try {
      const { _engine } = await chrome.storage.local.get("_engine");
      return !!(_engine && _engine.running);
    } catch { return !STOP; }
  }
  async function idle(ms) {
    const end = Date.now() + Math.max(0, Number(ms) || 0);
    while (Date.now() < end) {
      await dom().sleep(Math.min(1000, end - Date.now()));
      if (!(await stillRunning())) return false;
    }
    return true;
  }

  // ── Лок вкладки ───────────────────────────────────────────
  // Две открытые вкладки Threads поднимали по движку каждая: гонка за
  // _engine.qi, дублирующиеся комментарии и двойной расход дневного лимита.
  async function claimTab() {
    const r = await sw("ENGINE_CLAIM_TAB");
    return r && r.ok ? !!r.mine : true;   // фон не ответил — не блокируем работу
  }
  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(() => sw("ENGINE_CLAIM_TAB"), 10000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    sw("ENGINE_RELEASE_TAB");
  }

  // ════════════════════════════════════════════════════════
  //  ТЕКСТ КОММЕНТАРИЯ
  // ════════════════════════════════════════════════════════
  function stripMd(t) {
    return (t || "")
      .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/[*`]/g, "").trim();
  }

  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}]/gu;

  const DANGLING = ["а","и","но","или","да","же","ли","бы","не","ни","что","чтобы","как",
    "когда","если","потому","так","то","это","этот","эта","эти","в","во","на","за","по","из",
    "от","до","к","ко","с","со","у","о","об","про","для","при","над","под","без","через",
    "между","мой","моя","твой","его","её","их","наш","ваш","свой",
    "a","an","the","and","or","but","if","so","to","of","in","on","at","for","with","from",
    "that","this","is","are","was","were"];

  function dropDangling(t) {
    let s = t.replace(/[\s,;:—–-]+$/, "");
    for (let i = 0; i < 6; i++) {
      const m = s.match(/(?:^|\s)([^\s]+)$/);
      if (!m) break;
      const last = m[1].toLowerCase().replace(/[.,;:!?…"»«]+$/g, "");
      if (!DANGLING.includes(last)) break;
      s = s.slice(0, m.index).replace(/[\s,;:—–-]+$/, "");
    }
    return s.trim();
  }

  function sentences(t) {
    const o = (t.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || []).map((x) => x.trim()).filter(Boolean);
    return o.length ? o : [t];
  }

  /**
   * Приводит текст к лимитам, НЕ обрывая мысль. Многоточие ставится только
   * как крайняя мера и потом отбраковывается в acceptable() — раньше такие
   * огрызки («Начни с бытовых мелочей — они…») спокойно уходили в ленту.
   */
  function shape(text, s) {
    let t = stripMd(text)
      .replace(/^[\s"«»'\-—]+|[\s"«»'\-—]+$/g, "")
      .replace(/#\S+/g, "").replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ").trim();

    const found = t.match(EMOJI_RE) || [];
    let bare = t.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
    const nw = (x) => x.split(/\s+/).filter(Boolean).length;
    const max = num(s.commentMaxChars, 130), maxW = num(s.commentMaxWords, 22);

    if (bare.length > max || (maxW && nw(bare) > maxW)) {
      let acc = "";
      for (const p of sentences(bare)) {
        const next = acc ? acc + " " + p : p;
        if (next.length > max || (maxW && nw(next) > maxW)) break;
        acc = next;
      }
      if (acc) bare = acc;
      else {
        let cut = bare.split(/\s+/).filter(Boolean).slice(0, maxW || 99).join(" ");
        while (cut.length > max && cut.includes(" ")) cut = cut.replace(/\s+\S*$/, "");
        // Пробуем закончить на границе клаузы (запятая/тире) — это читается
        // как законченная мысль, в отличие от обрыва посреди фразы.
        const clause = cut.match(/^[\s\S]*[^\s,;—–-](?=\s*[,;—–-])/);
        if (clause && clause[0].split(/\s+/).length >= Math.max(4, (s.commentMinWords || 4))) {
          bare = dropDangling(clause[0]);
          if (bare && !/[.!?]$/.test(bare)) bare += ".";
        } else {
          bare = dropDangling(cut);
          if (bare && !/[.!?…]$/.test(bare)) bare += "…";
        }
      }
    }
    bare = bare.replace(/\s+([,.!?;:…])/g, "$1").trim();

    let emoji = "";
    if (s.commentEmoji === "always") emoji = found[0] || pickEmoji();
    else if (s.commentEmoji === "auto") emoji = found[0] || "";
    const out = emoji ? `${bare} ${emoji}` : bare;
    return out.length > max + 4 ? bare : out.trim();
  }

  function pickEmoji() {
    const set = ["🔥", "👀", "💡", "🙌", "⚡", "✨", "🤝"];
    return set[Math.floor(Math.random() * set.length)];
  }

  /** Достаточно ли ответ похож на реплику, а не на отписку/огрызок. */
  function acceptable(t, s) {
    if (!t) return false;
    const bare = t.replace(EMOJI_RE, "").trim();
    const words = bare.split(/\s+/).filter(Boolean);
    if (words.length < Math.max(3, num(s.commentMinWords, 4) - 1)) return false;
    if (bare.length < 14) return false;
    if (!/[а-яёa-z]{3}/i.test(bare)) return false;
    // Оборванная мысль: многоточие в конце — это результат жёсткой обрезки,
    // публиковать такое нельзя.
    if (/(…|\.\.\.)\s*$/.test(bare)) return false;
    const last = words[words.length - 1].toLowerCase().replace(/[.,;:!?…"»«]+$/g, "");
    if (DANGLING.includes(last)) return false;
    if (/^(отличн|класс|супер|круто|согласен|интересно)\W*$/i.test(t)) return false;
    if (/(нейросет|искусственн|как ии|as an ai|ассистент)/i.test(t)) return false;
    return true;
  }

  async function generate(post, s) {
    const persona = s.commentPrompt || "";
    const rules = window.DST.MIKA_RULES || (
      "ПРАВИЛА ОТВЕТА:\n" +
      `• ${s.commentMinWords}–${s.commentMaxWords} слов, до ${s.commentMaxChars} символов.\n` +
      "• По сути конкретного поста, без общих фраз.\n" +
      "• Мысль ЗАКОНЧЕННАЯ: не обрывайся на союзе, предлоге или многоточии. " +
      "Лучше короче, но до конца.\n" +
      "• Без хэштегов, ссылок, кавычек и звёздочек.\n" +
      "• Не упоминай ИИ, нейросети или что ты ассистент.\n" +
      "• Верни ТОЛЬКО текст комментария."
    );
    const emojiRule =
      s.commentEmoji === "always" ? "Обязательно закончи одним уместным эмодзи."
      : s.commentEmoji === "never" ? "Без эмодзи."
      : "Эмодзи — только если оно правда к месту.";

    const prompt =
      `${persona}\n\n${rules}\n• ${emojiRule}\n\n` +
      `Пост от @${post.author}:\n${post.text}\n\nКомментарий:`;

    const r = await aiChat([{ role: "user", content: prompt }]);
    if (!r.ok) throw new Error(r.error);
    return shape(r.text, s);
  }

  /** Сгенерировать пригодный комментарий: до 3 попыток. */
  async function generateAcceptable(post, s, onNote) {
    let last = "";
    for (let i = 0; i < 3; i++) {
      last = await generate(post, s);
      if (acceptable(last, s)) return last;
      onNote?.(`ответ #${i + 1} не прошёл проверку («${last.slice(0, 30)}») — переспрашиваю`);
      await dom().sleep(900);
    }
    return acceptable(last, s) ? last : "";
  }

  async function buildQueries(s) {
    const manual = (s.source.queries || []).map((q) => String(q).trim()).filter(Boolean);
    if (manual.length) return manual;

    const about = [s.hunter?.product, s.niche, s.brand].filter(Boolean).join(". ")
      || "автоматизация соцсетей и ИИ для бизнеса";
    const prompt =
      "Дай 6 коротких поисковых запросов для соцсети Threads, по которым можно найти " +
      "посты потенциальных клиентов. Это описание бизнеса: " + about + "\n" +
      "Запросы — 2–4 слова, разговорные, как реально пишут люди. " +
      "Верни СТРОГО JSON-массив строк без пояснений.";
    try {
      const r = await aiChat([{ role: "user", content: prompt }]);
      if (!r.ok) throw new Error(r.error);
      const m = (r.text || "").match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : r.text);
      const out = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 8);
      if (out.length) return out;
    } catch (e) {
      log("Не удалось собрать запросы автоматически: " + e.message, "err");
    }
    return ["ищу подрядчика", "нужна автоматизация", "посоветуйте сервис"];
  }

  // ════════════════════════════════════════════════════════
  //  ФИЛЬТРЫ
  // ════════════════════════════════════════════════════════
  function passes(p, s) {
    const t = (p.text || "").toLowerCase();
    if (!t || t.length < 20) return false;
    if (p.author && s.brandHandle && p.author === String(s.brandHandle).replace(/^@/, "")) return false;
    if ((s.stopKeywords || []).some((k) => k && t.includes(String(k).toLowerCase()))) return false;
    if (s.minLikes && p.likes < s.minLikes) return false;
    if (s.minReplies && p.comments < s.minReplies) return false;
    if (/\b(мне|я)\s*(всего\s*)?(9|10|11|12|13|14|15|16|17)\s*(лет|год|года)\b/i.test(p.text)) return false;
    if (/\b(i'?m|im|i am)\s*(9|1[0-7])\s*(years old|yo)\b/i.test(p.text)) return false;
    return true;
  }

  /**
   * Похож ли пост на лид — тот же список ключевых слов, что уже
   * используется хантером в sidepanel/tools.js (passesFilters). Дёшево,
   * без обращения к модели: живой контроль не должен спрашивать
   * подтверждение на каждый рядовой комментарий, только на те, что
   * реально похожи на потенциального клиента.
   */
  function isLeadLike(postText, s) {
    const kws = s.leadKeywords || [];
    if (!kws.length) return false;
    const t = (postText || "").toLowerCase();
    return kws.some((k) => k && t.includes(String(k).toLowerCase()));
  }

  /**
   * Живой контроль: создать запрос на бэкенде и ждать решения из
   * Telegram-кнопок (Отправить/Переписать/Пропустить).
   *
   * Осознанный выбор безопасного отказа: если бэкенд недоступен или
   * решение не пришло за отведённое время — ПРОПУСКАЕМ пост, а не
   * отправляем втихую как обычно. Иначе включённая галка «живой
   * контроль» ничего бы не гарантировала в тот момент, когда она нужнее
   * всего (сбой связи).
   */
  async function liveControlGate(p, draftText, s) {
    const payload = {
      post_author: p.author, post_text: (p.text || "").slice(0, 700),
      draft_text: draftText, permalink: p.permalink || "", niche: s.niche || "",
    };
    const r = await sw("EXT_REVIEW_CREATE", { payload });
    const id = r && r.id;
    if (!id) {
      log("⚠ Живой контроль недоступен (нет связи с сервером) — пропускаю пост на всякий случай", "err");
      return "skip";
    }
    log("⏳ Похоже на лида — жду решения в Telegram (Отправить / Переписать / Пропустить)…");
    const POLL_MS = 4000, MAX_WAIT_MS = 5 * 60 * 1000; // до 5 минут на решение
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (!(await idle(POLL_MS))) return "skip"; // остановили движок прямо во время ожидания
      const pr = await sw("EXT_REVIEW_POLL", { id });
      const status = pr && pr.status;
      if (status === "send" || status === "rewrite" || status === "skip") return status;
      // "pending" или сбой опроса — ждём дальше, попытки не тратим
    }
    log("⌛ Решение не пришло за 5 минут — пропускаю пост", "err");
    return "skip";
  }

  // ════════════════════════════════════════════════════════
  //  ЦИКЛ
  // ════════════════════════════════════════════════════════
  async function start(mode) {
    const s = await getSettings();
    if (!(s.backendUrl && s.apiToken)) {
      log("🔌 Подключи кабинет: ⚙️ → «Подключение», ID + ключ из @aithreads50_bot.", "err");
      return { ok: false, error: "не подключён кабинет" };
    }
    if (!(await claimTab())) {
      log("Комментинг уже идёт в другой вкладке Threads. Останови его там или закрой вкладку.", "err");
      return { ok: false, error: "занято другой вкладкой" };
    }
    STOP = false;
    const queries = await buildQueries(s);
    await sw("ENGINE_SET", {
      patch: {
        running: true, mode: mode || s.commentMode, src: s.source.feed ? "feed" : "search",
        qi: 0, queries, rotatedAt: Date.now(), startedAt: Date.now(),
        retry: "", retryCount: 0,
        stats: { seen: 0, generated: 0, sent: 0, skipped: 0 },
      },
    });
    startHeartbeat();
    log(`▶️ Режим «${mode === "manual" ? "вручную" : "авто"}». Запросов: ${queries.length}`, "ok");
    run();
    return { ok: true };
  }

  async function stop() {
    STOP = true;
    await sw("ENGINE_SET", { patch: { running: false } });
    stopHeartbeat();
    log("⏹ Остановлено");
    return { ok: true };
  }

  /** Подъём после перезагрузки страницы. */
  async function resume() {
    const e = (window.DST?.rpc?.engineState ? await window.DST.rpc.engineState() : ((await sw("ENGINE_GET"))?.engine || { running: false, stats: {} }));
    if (!e?.running) return;
    if (!(await claimTab())) return;          // работает другая вкладка — молчим
    STOP = false;
    startHeartbeat();
    log(`↻ Продолжаю (${e.src === "search" ? "поиск: " + (e.queries?.[e.qi] || "") : "лента"})`);
    run();
  }

  /**
   * Вопрос «продолжаем или стоп?». Движок живёт в content-script, кнопки —
   * в боковой панели, поэтому общаемся через storage: сюда кладём запрос,
   * оттуда прилетает ответ. Ждём до 10 минут; молчание считаем за «стоп»,
   * потому что вкладку могли просто закрыть, и продолжать без человека
   * было бы ровно тем поведением, от которого мы уходим.
   */
  function askContinue(done, cap, step) {
    return new Promise(async (resolve) => {
      const id = "cap_" + Date.now();
      await chrome.storage.local.set({ _capAsk: { id, done, cap, step, at: Date.now() } });
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        chrome.storage.onChanged.removeListener(onChange);
        clearTimeout(timer);
        chrome.storage.local.remove(["_capAsk", "_capAnswer"]);
        resolve(v);
      };
      function onChange(ch, area) {
        if (area !== "local" || !ch._capAnswer) return;
        const a = ch._capAnswer.newValue;
        if (a && a.id === id) finish(a.answer === "go" ? "go" : "stop");
      }
      chrome.storage.onChanged.addListener(onChange);
      const timer = setTimeout(() => {
        log("Ответа не было 10 минут — останавливаюсь.");
        finish("stop");
      }, 600000);
      // Остановка кнопкой «Стоп» во время вопроса тоже закрывает его.
      const poll = setInterval(async () => {
        if (STOP || !(await stillRunning())) { clearInterval(poll); finish("stop"); }
      }, 3000);
    });
  }

  async function run() {
    if (loop) return;
    loop = (async () => {
      try {
        while (true) {
          if (!(await stillRunning())) break;
          const e = (window.DST?.rpc?.engineState ? await window.DST.rpc.engineState() : ((await sw("ENGINE_GET"))?.engine || { running: false, stats: {} }));
          if (!e || !e.running) break;
          const s = await getSettings();

          // дневной лимит с учётом «прогрева» Safe Mode
          const c = (await sw("GET_COUNTERS")).counters || { comments: 0 };
          const capR = await sw("SAFE_CAP");
          const cap = num(capR?.cap, s.maxCommentsPerDay);
          if (c.comments >= cap) {
            // Раньше здесь была безусловная остановка: работа обрывалась на
            // «9 из 9 — на сегодня хватит», и вернуться в неё можно было
            // только перезапуском. Лимит Safe Mode — наша собственная
            // рекомендация, а не запрет платформы, поэтому решение о
            // продолжении принимает человек. Спрашиваем и ждём ответа.
            if (!capR?.canExtend) {
              log(`Дневной лимит исчерпан (${c.comments}/${cap}). Останавливаюсь.`, "err");
              await stop(); break;
            }
            const step = num(capR?.step, 10);
            log(`Дневной лимит: ${c.comments} из ${cap}. Продолжаем работу или стоп?`, "err");
            const ans = await askContinue(c.comments, cap, step);
            if (ans !== "go") {
              log("Остановлено по вашему решению. Лимит вернётся к норме завтра.");
              await stop(); break;
            }
            const ex = await sw("SAFE_EXTEND");
            log(`↻ Продолжаю. Лимит поднят на ${num(ex?.step, step)} — продление №${num(ex?.count, 1)} за сегодня.`);
            continue;
          }
          // активные часы
          if (!(await sw("SAFE_ACTIVE")).ok) {
            log("Вне активных часов — пауза 10 мин.");
            if (!(await idle(600000))) break;
            continue;
          }

          if (await maybeRotate(e, s)) return;   // страница уйдёт на перезагрузку

          const acted = await pass(e, s);
          if (!acted) {
            log("Целей нет — листаю ленту…");
            await window.DST.aim.humanScroll();
            await sw("ENGINE_SET", { patch: { rotatedAt: 0 } });
            // страховка от плотного цикла, если оба источника выключены
            if (!(await idle(4000))) break;
          }
        }
      } catch (err) {
        log("Движок упал: " + (err.message || err), "err");
      } finally {
        loop = null;
        stopHeartbeat();
      }
    })();
  }

  /** Смена ленты/запроса. Возвращает true, если инициировали навигацию. */
  async function maybeRotate(e, s) {
    const page = find().where();
    const queries = e.queries || [];
    const wantSearch = s.source.search && queries.length;
    const wantFeed = s.source.feed;
    if (!wantSearch && !wantFeed) {
      log("Ни лента, ни поиск не включены в настройках — останавливаюсь.", "err");
      await stop();
      return true;
    }
    const dueMs = num(s.source.rotateEveryMin, 12) * 60000;
    const due = !e.rotatedAt || Date.now() - e.rotatedAt > dueMs;

    if (e.src === "search" && page !== "search" && wantSearch) {
      if (find().goSearch(queries[e.qi] || "", s.source.searchFilter)) return true;
    }
    if (e.src === "feed" && page !== "feed" && wantFeed) {
      if (find().goFeed()) return true;
    }
    if (!due) return false;

    if (e.src === "feed" && wantSearch) {
      const qi = (e.qi + 1) % queries.length;
      await sw("ENGINE_SET", { patch: { src: "search", qi, rotatedAt: Date.now() } });
      log(`🔎 Поиск: «${queries[qi]}»`);
      if (find().goSearch(queries[qi], s.source.searchFilter)) return true;
      return false;
    }
    if (e.src === "search" && wantFeed) {
      await sw("ENGINE_SET", { patch: { src: "feed", rotatedAt: Date.now() } });
      log("🏠 Возврат в ленту");
      if (find().goFeed()) return true;
      return false;
    }
    await sw("ENGINE_SET", { patch: { rotatedAt: Date.now() } });
    return false;
  }

  /** Уйти со страницы поста обратно к источнику. */
  function backToSource(e, s) {
    if (e.src === "search" && (e.queries || [])[e.qi]) {
      return find().goSearch(e.queries[e.qi], s.source.searchFilter);
    }
    return find().goFeed();
  }

  /** Один проход: найти пост → сгенерировать → отправить или в очередь. */
  async function pass(e, s) {
    // Постов на экране уже достаточно, чтобы заодно бесплатно проверить,
    // не появился ли ответ под кем-то из ранее прокомментированных —
    // никакой лишней навигации ради этого не делаем (см. комментарий
    // у watchCheckDue).
    watchCheckDue();

    let posts = dom().parseVisiblePosts(s.sel).filter((p) => passes(p, s));

    // На странице поста в ленте видны ещё и ответы. Работаем только с целью.
    if (/\/post\//.test(location.pathname)) {
      const want = e.retry || (location.pathname.match(/\/post\/([A-Za-z0-9_\-]+)/) || [])[1];
      posts = posts.filter((p) => p.code === want);
      if (!posts.length) {
        log("↩︎ В этой ветке делать нечего — возвращаюсь");
        if (e.retry) await sw("RELEASE_POST", { code: e.retry, cooldownMin: 180 });
        await sw("ENGINE_SET", { patch: { retry: "", retryCount: 0 } });
        backToSource(e, s);
        return true;
      }
    }

    // Считаем только НОВЫЕ увиденные посты: раньше seen рос на весь экран
    // при каждом проходе и цифра в панели ничего не значила.
    if (!posts.length) {
      // Пустой проход — не ошибка, но молчать о нём нельзя: именно так
      // выглядит «лента не прогрузилась» и «все посты отфильтрованы».
      const raw = dom().parseVisiblePosts(s.sel).length;
      NOWORK++;
      if (NOWORK % 5 === 1) {
        log(raw
          ? `⏭ На экране ${raw} постов, но под фильтры не подошёл ни один`
          : "⏭ На экране не видно постов — жду прогрузку ленты");
      }
    } else NOWORK = 0;

    const fresh = posts.filter((p) => !SEEN.has(p.code));
    fresh.forEach((p) => SEEN.add(p.code));
    if (fresh.length) {
      await sw("BUMP_STAT", { field: "seen", by: fresh.length });
    }

    for (const p of posts) {
      if (!(await stillRunning())) return true;
      const isRetry = e.retry && e.retry === p.code;

      // ── Занять пост (атомарно, на уровне фона) ──
      if (!isRetry) {
        const claim = await sw("CLAIM_POST", { code: p.code });
        if (!claim.ok || !claim.claimed) {
          // Раньше здесь стоял молчаливый continue: движок мог крутиться
          // по ленте, где все посты уже заняты, и в панели не появлялось
          // ни строки — со стороны «не понимает, где комментировать».
          const why = {
            commented: "уже комментировали",
            cooldown: "пауза после неудачи",
            queued: "ждёт подтверждения",
            working: "занят другой вкладкой",
          }[claim.reason] || claim.reason || "занят";
          SKIPPED[why] = (SKIPPED[why] || 0) + 1;
          if (SKIPPED[why] % 10 === 1) log(`⏭ Пропускаю посты — ${why} (${SKIPPED[why]})`);
          continue;
        }
      }

      const release = async (cooldownMin) => {
        if (!isRetry || cooldownMin) await sw("RELEASE_POST", { code: p.code, cooldownMin });
      };

      let text;
      try {
        text = await generateAcceptable(p, s, (m) => log("⤼ " + m));
      } catch (err) {
        const m = err.message || String(err);
        await release(30);
        if (/не подключ|подключи|Telegram ID|закончил/i.test(m)) {
          log("🔌 " + m, "err"); await stop(); return true;
        }
        log("Модель: " + m, "err");
        await idle(3000);
        continue;
      }

      if (!text) {
        log(`⤼ Слабый ответ, пропускаю @${p.author}`);
        await sw("BUMP_STAT", { field: "skipped" });
        await release(360);                     // вернёмся к посту не скоро
        continue;
      }
      await sw("BUMP_STAT", { field: "generated" });

      if (e.mode === "manual") {
        await sw("PENDING_ADD", { item: { code: p.code, author: p.author, post: p.text.slice(0, 240), text, permalink: p.permalink } });
        await sw("QUEUE_POST", { code: p.code });
        log(`📝 В очередь: @${p.author} — «${text}»`, "ok");
        await idle(dom().rnd(4000, 9000));
        return true;
      }

      // ── Живой контроль: спорный/лидовый комментарий ждёт решения человека ──
      if (s.liveControlEnabled && isLeadLike(p.text, s)) {
        const decision = await liveControlGate(p, text, s);
        if (decision === "skip") {
          await sw("BUMP_STAT", { field: "skipped" });
          await release(360);
          continue;
        }
        if (decision === "rewrite") {
          log("✏️ Переписываю по просьбе из Telegram…");
          let text2 = "";
          try {
            text2 = await generateAcceptable(p, s, (m) => log("⤼ " + m));
          } catch { text2 = ""; }
          if (!text2) {
            await sw("BUMP_STAT", { field: "skipped" });
            await release(360);
            continue;
          }
          text = text2;
          // Дальше отправляем без второго раунда вопросов — иначе можно
          // зациклиться на «переписать» бесконечно. Хочет ещё раз
          // переписать — попросит уже после публикации через /support.
        }
        // decision === "send" (или "rewrite", успешно переписанный) — идём отправлять
      }

      // ── АВТО: пишем и отправляем ──
      log(`💬 @${p.author}: «${text}»`);
      const onPostPage = /\/post\//.test(location.pathname);
      const r = await dom().commentOnPost(p.code, text, s.sel, "auto", {
        like: s.likeOnComment,
        onStep: (m) => log("· " + m),
      });

      if (r.ok && r.sent) {
        // Пометка ставится ТОЛЬКО после подтверждённой отправки.
        await sw("COMMIT_POST", { code: p.code });
        await sw("BUMP_COUNTER", { field: "comments" });
        await sw("BUMP_STAT", { field: "sent" });
        await sw("ENGINE_SET", { patch: { retry: "", retryCount: 0 } });
        log(`Отправлено ✅ (подтверждение: ${r.confirmed || "?"})` + (r.liked ? " ❤" : ""), "ok");
        reportEvent("comment_attempt", { status: "ok", target_username: p.author,
          target_post_id: p.code, niche: s.niche || "", detail: text.slice(0, 200) });
        {
          const n0 = dom().countReplies ? dom().countReplies(p.code) : null;
          if (n0 != null) {
            watchAdd({ code: p.code, author: p.author, niche: s.niche || "",
              commentsBefore: n0, sentAt: Date.now() });
          }
        }
        if (s.telegramNotifyLeads) {
          sw("TG_SEND", { text: `💬 Комментарий @${p.author}\n${text}\n${p.permalink}` });
        }
      } else if (r.risky) {
        // Поле опустело, подтверждения нет: комментарий МОГ уйти.
        // Второй раз не пишем — именно так раньше появлялись дубли.
        await sw("COMMIT_POST", { code: p.code });
        await sw("ENGINE_SET", { patch: { retry: "", retryCount: 0 } });
        await sw("BUMP_STAT", { field: "skipped" });
        log("⚠ Отправка не подтвердилась, но поле очистилось — повторять не буду (риск дубля)", "err");
        reportEvent("comment_attempt", { status: "fail", reason: "SUBMIT_UNCONFIRMED",
          target_username: p.author, target_post_id: p.code, niche: s.niche || "" });
      } else if (!onPostPage && p.permalink && (e.retryCount || 0) < 1
                 && r.retry !== "no-retry" && r.retry !== "never") {
        // Одна повторная попытка на пермалинке: в ленте карточка уезжает
        // из-за догрузки, а на странице поста цель стоит на месте.
        //
        // Но повторять теперь можно не всё. Если целей ответа не нашлось
        // вовсе или редактор не принял ни один способ ввода — на
        // пермалинке будет ровно то же самое. Слепой повтор здесь не
        // «вторая попытка», а второй одинаковый промах и лишняя
        // подозрительная активность на аккаунте.
        log("↻ В ленте не подтвердилось — открываю пост и пробую один раз");
        await sw("ENGINE_SET", { patch: { retry: p.code, retryCount: 1, returnTo: location.href } });
        location.assign(p.permalink);
        return true;
      } else {
        await sw("BUMP_STAT", { field: "skipped" });
        await sw("ENGINE_SET", { patch: { retry: "", retryCount: 0 } });
        // 720 минут сжигали пост на полсуток из-за случайной осечки вёрстки.
        // Реальная причина почти всегда временная (композер не открылся,
        // кнопка не успела стать активной) — часа достаточно.
        //
        // Но когда причина не временная (вёрстка ветки другая), возвращаться
        // через час незачем: получим тот же отказ. Такие посты откладываем
        // надолго — до обновления селекторов.
        const permanent = r.retry === "no-retry";
        await release(permanent ? 720 : 60);
        log("Не отправилось: " + (r.error || "поле ответа не найдено")
            + (r.reason ? ` [${r.reason}]` : ""), "err");
        reportEvent("comment_attempt", { status: "fail", reason: r.reason || "UNKNOWN",
          target_username: p.author, target_post_id: p.code, niche: s.niche || "",
          detail: r.error || "" });
      }

      // Пауза ПЕРЕД следующим постом — обязательна и при успехе, и при ошибке.
      const gap = num((await sw("SAFE_GAP")).sec, s.commentSleepSec);
      log(`Пауза ${gap}с…`);
      if (!(await idle(gap * 1000))) return true;

      // Длинный «человеческий» перерыв раз в N действий (Safe Mode)
      const cool = num((await sw("SAFE_COOLDOWN")).sec, 0);
      if (cool) {
        log(`🧊 Длинная пауза ${Math.round(cool / 60)} мин (Safe Mode)…`);
        if (!(await idle(cool * 1000))) return true;
      }

      if (/\/post\//.test(location.pathname)) {
        log("↩︎ Возвращаюсь к ленте/поиску");
        backToSource(e, s);
        return true;
      }
      return true;
    }
    return false;
  }

  // посты, уже посчитанные в статистике этой вкладкой
  const SEEN = new Set();
  // причины пропусков — чтобы не спамить лог одинаковыми строками,
  // но и не молчать совсем
  const SKIPPED = {};
  let NOWORK = 0;

  /** Отправить конкретный элемент из очереди подтверждения. */
  async function sendPending(code, text) {
    const s = await getSettings();
    await dom().waitFor(() => dom().containerByCode(code), 6000);
    const r = await dom().commentOnPost(code, text, s.sel, "auto", {
      like: s.likeOnComment,
      onStep: (m) => log("· " + m),
    });
    if (r.ok && r.sent) {
      await sw("COMMIT_POST", { code });
      await sw("BUMP_COUNTER", { field: "comments" });
      await sw("BUMP_STAT", { field: "sent" });
      await sw("PENDING_REMOVE", { code });
      log(`Отправлено ✅ (${r.confirmed || "?"})`, "ok");
      return { ok: true, sent: true };
    }
    if (r.risky) {
      await sw("COMMIT_POST", { code });
      await sw("PENDING_REMOVE", { code });
      log("⚠ Подтверждения нет, но поле очистилось — убрал из очереди, чтобы не отправить дважды", "err");
      return { ok: false, risky: true, error: "отправка не подтверждена, повтор запрещён" };
    }
    return { ok: false, error: r.error || "не удалось отправить" };
  }

  window.DST.engine = {
    start, stop, resume, run, sendPending,
    generate, generateAcceptable, shape, acceptable, buildQueries, passes,
    idle, stillRunning,
  };

  // авто-подъём после навигации
  if (document.readyState === "complete") setTimeout(resume, 1800);
  else window.addEventListener("load", () => setTimeout(resume, 1800));
  window.addEventListener("pagehide", () => { try { stopHeartbeat(); } catch {} });
})();
