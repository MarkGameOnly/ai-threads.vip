// tools.js — инструменты, которыми пользуется чат-мозг. Все работают через активную вкладку Threads.
import { fitComment, lengthRule } from "../shared/comment-format.js";
import { ensureThreadsTab, navigate, rpc, rpcSafe, ensureContentScript, sleep } from "./tab-control.js";
import { chat as directChat, GensOutError, AIError } from "../shared/ai.js";

/**
 * Событие для панели здоровья/уведомлений в боте — см. shared/ext-events.js.
 * Идёт через фон (EXT_EVENT), а не прямым fetch из side-panel: прямой fetch
 * отсюда иногда падает с «Failed to fetch» (см. комментарий у chat() ниже),
 * а событие — fire-and-forget, ронять сам инструмент из-за него нельзя.
 */
function reportEvent(kind, payload = {}) {
  try {
    chrome.runtime.sendMessage({ type: "EXT_EVENT", kind, payload }, () => void chrome.runtime.lastError);
  } catch {}
}

/**
 * Страховочный дедлайн поверх любого ожидания.
 *
 * Таймаут внутри ai.js закрывает подвисший fetch, но мост «панель → фон»
 * — отдельная точка отказа: если service worker умрёт ровно в момент
 * ответа, промис sendMessage может не завершиться ни успехом, ни
 * ошибкой. Для генерации это безопасно: повторный запрос ничего не
 * ломает, а вот бесконечное ожидание останавливает всю программу.
 */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new AIError(`${label} не ответил за ${Math.round(ms / 1000)}с`, 0, { retryable: true })),
        ms);
    }),
  ]);
}

/**
 * Генерация через фоновый service worker.
 *
 * Прямой fetch из side-panel иногда падает с «Failed to fetch» (именно это
 * ломало «Переписать пост»). Фон работает в другом контексте и таких
 * проблем не имеет; прямой вызов оставлен запасным путём.
 */
async function chat(messages, opts = {}) {
  const budget = (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 90000) *
                 ((Number.isFinite(Number(opts.retries)) ? Math.max(0, Number(opts.retries)) : 2) + 1) + 20000;
  try {
    const r = await withDeadline(
      chrome.runtime.sendMessage({ type: "AI_CHAT", messages, opts }), budget, "AI Threads");
    if (r && r.ok && typeof r.text === "string") return r.text;
    if (r && r.error) throw reviveError(r);
  } catch (e) {
    // Ошибку САМОЙ модели (кончились генерации, 429, 403) пробрасываем как
    // есть: запасной прямой путь упрётся ровно в то же самое, только
    // потратит ещё один таймаут. Повторяем локально лишь обрыв канала
    // между панелью и фоном.
    if (e instanceof GensOutError || e instanceof AIError || e?.name === "GensOutError") throw e;
    const m = String(e && e.message || e);
    if (!/Failed to fetch|Could not establish|receiving end|message port|Extension context/i.test(m)) throw e;
  }
  return directChat(messages, opts);
}

/** Восстановить класс ошибки, потерянный при передаче через sendMessage. */
function reviveError(r) {
  if (r.kind === "GensOutError") return new GensOutError(r.buyUrl || "");
  if (r.kind === "AIError") return new AIError(r.error, r.status, { retryable: !!r.retryable });
  const e = new Error(r.error);
  e.status = r.status;
  return e;
}

/**
 * Сообщение фону, которое не роняет прогон.
 *
 * MV3-фон засыпает, а при перезагрузке расширения канал к нему умирает
 * навсегда. Прежний код писал `(await chrome.runtime.sendMessage(...)).counters`
 * — и на мёртвом канале это не «ошибка фона», а исключение прямо посреди
 * цикла охотника: программа обрывалась без единой строки в логе.
 */
async function bg(msg, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (r) return r;
    } catch { /* фон спит или контекст перезагружен — пробуем ещё */ }
    if (i < tries - 1) await sleep(300 + i * 500);
  }
  return { ok: false, _bgFailed: true };
}
import { sendMessage } from "../shared/telegram.js";

const enc = encodeURIComponent;
const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));

import { getSettings } from "../shared/storage.js";
import * as I18N from "../shared/i18n.js";
import { withinActiveHours, nextGapSec, maybeCooldown, safeDailyCap } from "../shared/safemode.js";
async function savePosts(posts) { await bg({ type: "SAVE_POSTS", posts }); }
async function saveLeads(leads) { await bg({ type: "SAVE_LEADS", leads }); }

/**
 * Достать JSON из ответа модели.
 *
 * Прежняя версия брала одну жадную регулярку «от первой скобки до
 * последней». Стоило модели добавить фразу до или после объекта (а на
 * шаге квалификации она это делает регулярно), как JSON.parse падал,
 * и совершенно нормальный лид молча терялся: `is_lead` не прочитан —
 * значит не клиент. Теперь пробуем по очереди: чистый текст, блок ```json,
 * затем первый СБАЛАНСИРОВАННЫЙ объект/массив.
 */
function safeJson(t) {
  if (!t) return null;
  const raw = String(t).trim();

  const tryParse = (x) => { try { return JSON.parse(x); } catch { return null; } };

  let v = tryParse(raw);
  if (v && typeof v === "object") return v;

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    v = tryParse(fence[1].trim());
    if (v && typeof v === "object") return v;
  }

  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    let start = -1, depth = 0, inStr = false, esc = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) { if (depth === 0) start = i; depth++; }
      else if (c === close && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          v = tryParse(raw.slice(start, i + 1));
          if (v && typeof v === "object") return v;
          start = -1;
        }
      }
    }
  }
  return null;
}

// ---- Парсинг ленты ----
export async function parseFeed(target, onLog) {
  const s = await getSettings();
  const tab = await ensureThreadsTab("https://www.threads.com/");
  onLog?.("Собираю ленту…");
  const r = await rpcSafe(tab.id, "RPC_COLLECT", { target: target || s.parseTarget });
  if (!r.ok) return { ok: false, error: r.error };
  await savePosts(r.posts);
  return { ok: true, posts: r.posts };
}

// ---- Парсинг профиля ----
export async function parseProfile(handle, target, onLog) {
  handle = String(handle || "").replace(/^@/, "").trim();
  const s = await getSettings();
  const tab = await ensureThreadsTab();
  onLog?.(`Открываю профиль @${handle}…`);
  await navigate(tab.id, `https://www.threads.com/@${enc(handle)}`);
  onLog?.("Собираю посты профиля…");
  const r = await rpcSafe(tab.id, "RPC_COLLECT", { target: target || 40 });
  if (!r.ok) return { ok: false, error: r.error };
  const posts = r.posts.map((p) => ({ ...p, author: p.author || handle }));
  await savePosts(posts);
  return { ok: true, posts, handle };
}

// ---- Парсинг поиска ----
// filter=recent — ключевой параметр. Без него Threads отдаёт вкладку «Топ»:
// посты недельной и месячной давности. Охотник потом резал их фильтром
// свежести (24 ч) и из 250 собранных оставалось 5 — ровно то, что было в логах.
export async function parseSearch(query, target, onLog, filter) {
  const s = await getSettings();
  const tab = await ensureThreadsTab();
  const f = filter || s.source?.searchFilter || "recent";
  onLog?.(`Поиск: «${query}» (${f === "recent" ? "свежие" : "топ"})…`);
  const url = `https://www.threads.com/search?q=${enc(query)}&serp_type=default` +
              (f ? `&filter=${enc(f)}` : "");
  await navigate(tab.id, url);
  const r = await rpcSafe(tab.id, "RPC_COLLECT", { target: target || 50 });
  if (!r.ok) return { ok: false, error: r.error, posts: [] };
  await savePosts(r.posts);
  return { ok: true, posts: r.posts };
}

// ---- Анализ автора ----
export async function analyzeAuthor(handle, onLog) {
  const res = await parseProfile(handle, 50, onLog);
  if (!res.ok) return res;
  const posts = res.posts;
  if (!posts.length) return { ok: false, error: "не удалось собрать посты профиля" };
  onLog?.(`Анализирую ${posts.length} постов через AI Threads…`);

  const compact = posts.slice(0, 40).map((p, i) =>
    `#${i + 1} [${p.time || "?"}] ♥${p.likes} 💬${p.comments} 🔁${p.reposts} ✈${p.shares}\n${(p.text || "").slice(0, 220)}`
  ).join("\n---\n");

  const prompt =
    `Ты — аналитик контента Threads. Разбери автора @${res.handle} по его постам ниже.\n` +
    `Дай структурированный разбор на русском:\n` +
    `1) Взлёты и падения: какие посты залетели, какие провалились (по цифрам) и ПОЧЕМУ.\n` +
    `2) На какие боли аудитории давит автор.\n` +
    `3) Какие триггеры/приёмы сработали лучше всего, а какие — нет.\n` +
    `4) Структура постов (крючок, тело, финал), длина, формат.\n` +
    `5) Даты/время и регулярность публикаций — привычки автора.\n` +
    `6) Что бы ты улучшил. Коротко, по пунктам, без воды.\n\n` +
    `ПОСТЫ:\n${compact}`;

  const r = await chat([{ role: "user", content: prompt }], { temperature: 0.4 });
  return { ok: true, report: r, posts, handle: res.handle };
}

// ---- Поиск клиентов (лиды из ленты) ----
export async function findLeads(target, onLog) {
  const s = await getSettings();
  const fr = await parseFeed(target, onLog);
  if (!fr.ok) return fr;
  const cands = fr.posts.filter((p) => passesFilters(p, s)).slice(0, s.hunter.keepBest);
  onLog?.(`Кандидатов: ${cands.length}. Квалифицирую…`);
  const leads = [];
  let fails = 0;
  for (let i = 0; i < cands.length; i++) {
    const p = cands[i];
    onLog?.(`🔍 ${i + 1}/${cands.length} @${p.author || "?"}`);
    let data = null;
    try {
      const prompt = fill(s.leadPrompt, { brand: s.brand, author: p.author, post: (p.text || "").slice(0, 1200), niche: s.niche });
      const r = await chat([{ role: "user", content: prompt }],
                           { temperature: 0.3, timeoutMs: 45000, retries: 1 });
      data = safeJson(r);
      fails = 0;
    } catch (e) {
      // Один сбой модели не должен обрывать весь поиск клиентов:
      // раньше исключение вылетало наружу и терялись уже найденные лиды.
      if (e?.name === "GensOutError") { onLog?.("💎 Генерации закончились — останавливаюсь."); break; }
      fails++;
      onLog?.(`   ⚠ модель: ${e?.message || e} (${fails}/4)`);
      if (fails >= 4) { onLog?.("Модель не отвечает — прекращаю отбор."); break; }
      await sleep(1500 * fails);
      continue;
    }
    if (data?.is_lead) {
      const lead = { ...p, score: data.score || 0, reason: data.reason || "", angle: data.angle || "" };
      leads.push(lead);
      await saveLeads([lead]);
      onLog?.(`🎯 @${p.author} (${lead.score}) — ${lead.reason}`);
      await sendLeadToTg(lead, s);
    }
    await sleep(700);
  }
  return { ok: true, leads };
}

function passesFilters(p, s) {
  const t = (p.text || "").toLowerCase();
  if (!t) return false;
  if (s.stopKeywords.some((k) => k && t.includes(k.toLowerCase()))) return false;
  if (s.leadKeywords.length && !s.leadKeywords.some((k) => k && t.includes(k.toLowerCase()))) return false;
  if (s.minLikes && p.likes < s.minLikes) return false;
  if (s.minReplies && p.comments < s.minReplies) return false;
  return true;
}

// ---- Комментинг / постинг (запуск на вкладке) ----
export async function startCommenting() {
  const tab = await ensureThreadsTab(); return rpc(tab.id, "START_COMMENTING");
}
export async function stopCommenting() {
  const tab = await ensureThreadsTab(); return rpc(tab.id, "STOP_COMMENTING");
}
export async function startPosting() {
  const tab = await ensureThreadsTab(); return rpc(tab.id, "START_POSTING");
}
// Убрать markdown, который Threads не рендерит (**, *, __, `, #) + лишние пустые строки.
function stripMd(t) {
  return (t || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "").replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^["«»\s]+|["«»\s]+$/g, "")
    .trim();
}

export async function generatePost(topic) {
  const s = await getSettings();
  const prompt = fill(s.postPrompt, { brandName: s.brandName, niche: s.niche, topic }) +
    "\n\nВАЖНО: коротко (1–3 коротких предложения/строки), живо, со смайлами где уместно. " +
    "НЕ используй markdown и звёздочки ** ** (Threads их не форматирует, будут видны как символы). " +
    "Без хэштегов. Только текст поста.";
  let text = await chat([{ role: "user", content: prompt }], { temperature: s.temperature });
  return { ok: true, text: stripMd(text) };
}

/** Ужать пост до формата ленты: не длиннее limit, без обрыва мысли. */
function capPost(t, limit = 350) {
  let x = (t || "").trim()
    .replace(/^["«»]+|["«»]+$/g, "")
    .replace(/^(вот|держи|готово)[^\n]{0,20}:\s*/i, "")   // срезаем преамбулу
    .replace(/\n{3,}/g, "\n\n");
  if (x.length <= limit) return x;
  const cut = x.slice(0, limit);
  const dot = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"),
                       cut.lastIndexOf("?"), cut.lastIndexOf("\n"));
  return (dot > limit * 0.5 ? cut.slice(0, dot + 1) : cut).trim();
}

// Переписать пост под «залетевший» образец.
/**
 * Языковая директива для любой генерации.
 *
 * Промпты в настройках написаны по-русски, и модель по инерции отвечала
 * по-русски даже при английском интерфейсе. Человек, выбравший English,
 * должен получать по-английски всё: комментарии, посты, сообщения в
 * директ — а не только подписи кнопок.
 */
function langRule() {
  return I18N.lang() === "en"
    ? "\n\nIMPORTANT: write the result in ENGLISH. Natural, native English — " +
      "not a translation from Russian. Ignore the language these instructions " +
      "are written in."
    : "\n\nВАЖНО: пиши результат на РУССКОМ языке.";
}

export async function rewriteLikeViral(viralPost, topic) {
  const s = await getSettings();
  const prompt =
    `Вот пост, который залетел в Threads (♥${viralPost.likes} 💬${viralPost.comments}):\n"${viralPost.text}"\n\n` +
    `Разбери его структуру и триггеры и напиши НОВЫЙ пост от лица ${s.brandName} ` +
    `(ниша: ${s.niche}) на тему: "${topic || s.niche}", повторяя рабочую структуру и энергетику, ` +
    `но полностью своим содержанием.\n\n` +
    `ЖЁСТКИЕ ТРЕБОВАНИЯ К ФОРМАТУ:\n` +
    `• 2–4 коротких строки, максимум 350 символов. Threads — не блог.\n` +
    `• Первая строка — крючок, дальше суть. Коротко и по делу.\n` +
    `• Без вступлений вроде «Вот мой пост», без разбора и пояснений.\n` +
    `• Без хэштегов, без markdown и звёздочек. Уместный смайлик можно.\n` +
    `• Верни ТОЛЬКО текст поста.` + langRule();
  let text = stripMd(await chat([{ role: "user", content: prompt }], { temperature: 0.9 }));
  // Модель любит расписывать — подрезаем до формата ленты.
  text = capPost(text, 350);
  return { ok: true, text };
}

// ---- ОХОТНИК ЗА КЛИЕНТАМИ (5 шагов) ----

/** Потолок ожидания одного ответа модели на шаге квалификации. */
const QUALIFY_TIMEOUT_MS = 45000;
/**
 * Потолок на ВЕСЬ шаг отбора. Дошли до него — прекращаем квалификацию и
 * идём комментировать то, что уже отобрано. Раньше шаг не был ограничен
 * ничем: 40–60 запросов к модели подряд на медленном бэкенде легко
 * растягивались на десятки минут, и со стороны это было неотличимо от
 * зависания — тем более что шаг не писал в лог ни строки.
 */
const QUALIFY_BUDGET_MS = 7 * 60 * 1000;
/**
 * Сколько ошибок модели подряд терпим, прежде чем закончить отбор.
 * Три — потому что каждая «ошибка» это уже исчерпанный таймаут с повтором
 * (около полутора минут): дальше ждать бессмысленно, лучше пойти писать
 * комментарии тем, кто уже отобран.
 */
const QUALIFY_MAX_FAILS = 3;
/**
 * Больше стольких кандидатов за один прогон модели не показываем.
 * Каждый кандидат — отдельная платная генерация; при «оставить лучших =
 * 30» это 60 запросов, и бесплатный пакет сгорал за один запуск ещё до
 * того, как охотник успевал что-то написать.
 */
const MAX_QUALIFY = 60;

/**
 * Грубая локальная оценка «похоже на клиента» — без модели.
 * Нужна как страховка: если AI-квалификация не состоялась (кончились
 * генерации, таймауты, мусорные ответы), охотник всё равно должен дойти
 * до пятого шага, а не закончиться на «Отобрано лидов: 0».
 */
function localLeadScore(p, s) {
  const t = (p.text || "").toLowerCase();
  if (!t) return 0;
  const kws = (s.leadKeywords || []).filter(Boolean);
  const hits = kws.filter((k) => t.includes(String(k).toLowerCase())).length;
  if (!hits) return 0;
  return Math.min(95, hits * 20 + Math.min(20, Math.round((p.engagement || 0) / 10)));
}

/** Человеческий текст ошибки модели для лога программы. */
function aiErrText(e) {
  if (e?.name === "GensOutError") return "генерации закончились";
  return e?.message || String(e);
}

export async function runHunter(cfg, hooks) {
  // Внешняя обёртка: что бы ни случилось внутри, наружу уходит объект, а
  // не отклонённый промис. Обработчик кнопки «Запустить программу»
  // вызывал runHunter без catch — любое исключение превращалось в
  // unhandled rejection, и карточка прогресса навсегда замирала в
  // состоянии «идёт» на том шаге, где её застала ошибка. Именно так
  // выглядело «зависает на отборе лидов».
  try {
    return await runHunterInner(cfg, hooks);
  } catch (e) {
    hooks?.log?.("✕ Сбой программы: " + (e?.message || e));
    return { ok: false, crashed: true, error: e?.message || String(e) };
  }
}

async function runHunterInner(cfg, hooks) {
  const s = await getSettings();
  const H = { ...s.hunter, ...cfg };
  const step = hooks?.step || (() => {});
  const log = hooks?.log || (() => {});
  const isStopped = hooks?.isStopped || (() => false);
  // Пауза: программа замирает, но не теряет очередь лидов.
  const hold = hooks?.waitIfPaused || (async () => {});

  // Шаг 1 — гипотезы
  step(0, "run");
  const hypPrompt =
    `Бизнес/продукт и идеальный клиент: "${H.product}". Ниша: ${s.niche}.\n` +
    `Составь ${H.hypotheses} коротких поисковых запросов (на языке аудитории), по которым в Threads ` +
    `сидят потенциальные клиенты этого бизнеса. Верни СТРОГО JSON-массив строк.`;
  let queries = [];
  try {
    const hypRaw = await chat([{ role: "user", content: hypPrompt }],
                              { temperature: 0.7, timeoutMs: 60000, retries: 2 });
    queries = (safeJson(hypRaw) || [])
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim())
      .slice(0, Math.max(1, Number(H.hypotheses) || 5));
  } catch (e) {
    if (e?.name === "GensOutError") { step(0, "err"); throw e; }
    log("Гипотезы не построились: " + aiErrText(e));
  }
  if (!queries.length) {
    // Запасной путь вместо полного отказа: ищем по самому описанию
    // продукта. Прежде программа здесь просто заканчивалась с ошибкой.
    queries = String(H.product || s.niche || "")
      .split(/[.,;\n]|\sи\s/)
      .map((x) => x.trim())
      .filter((x) => x.length > 3)
      .slice(0, 3);
    if (queries.length) log("Иду по описанию продукта — гипотезы не построились.");
  }
  if (!queries.length) { step(0, "err"); return { ok: false, error: "не удалось построить гипотезы" }; }
  log("Гипотезы: " + queries.join(" · "));
  step(0, "done");
  if (isStopped()) return { ok: false, stopped: true };

  // Шаг 2 — сбор выдачи: поиск + ГЛАВНАЯ ЛЕНТА
  step(1, "run");
  let all = [];

  // Проверка вкладки ДО работы. «Главная лента: +0» почти всегда означает
  // не пустую ленту, а разлогиненную вкладку или стену входа — и тогда
  // дальше бессмысленно: поле ответа не появится ни на одном посте.
  try {
    const t0 = await ensureThreadsTab("https://www.threads.com/");
    const hp = await rpcSafe(t0.id, "RPC_HEALTH", {}, 15000);
    if (hp.ok && hp.data && !hp.data.loggedIn) {
      step(1, "err");
      return { ok: false,
               error: "вкладка Threads не авторизована (видна стена входа). " +
                      "Залогинься в threads.com в этой же вкладке и запусти охотника заново." };
    }
    if (hp.ok && hp.data && hp.data.postLinks === 0) {
      log("⚠ На странице не видно ни одного поста — лента может не прогрузиться");
    }
  } catch {}

  // Лента идёт первой: там сидят авторы, которых поиск не отдаёт вовсе —
  // выдача Threads показывает в основном крупные аккаунты, а живые запросы
  // клиентов чаще всплывают именно в общей ленте.
  if (H.useFeed !== false) {
    try {
      const fr = await parseFeed(H.feedTarget || H.threadsPerQuery || 50, (m) => log(m));
      const got = (fr.posts || []).length;
      log(`🏠 Главная лента: +${got}`);
      all = all.concat((fr.posts || []).map((p) => ({ ...p, _q: "лента" })));
    } catch (e) {
      log("Лента недоступна: " + (e.message || e));
    }
  }

  for (const q of queries) {
    await hold();
    if (isStopped()) return { ok: false, stopped: true };
    try {
      const r = await parseSearch(q, H.threadsPerQuery, (m) => log(m), "recent");
      log(`«${q}»: +${r.posts?.length || 0}`);
      all = all.concat((r.posts || []).map((p) => ({ ...p, _q: q })));
    } catch (e) {
      // Одна сорвавшаяся страница поиска не повод терять весь прогон.
      log(`«${q}»: не собралось — ${e.message || e}`);
    }
  }
  step(1, all.length ? "done" : "err");
  if (!all.length) {
    return { ok: false, error: "не удалось собрать ни одного поста — проверь, что вкладка Threads открыта и залогинена" };
  }

  // Шаг 3 — свежесть/уникальность
  step(2, "run");
  const seen = new Set(); let uniq = [];
  for (const p of all) { if (!seen.has(p.code)) { seen.add(p.code); uniq.push(p); } }
  const beforeFresh = uniq.length;
  if (H.freshnessHours) uniq = uniq.filter((p) => withinHours(p.time, H.freshnessHours));
  if (beforeFresh && uniq.length < beforeFresh * 0.2) {
    log(`⚠ Фильтр свежести (${H.freshnessHours} ч) отсёк ${beforeFresh - uniq.length} из ${beforeFresh}. ` +
        `Если лидов мало — увеличь окно свежести в настройках охотника.`);
  }
  uniq = uniq.filter((p) => (p.likes >= (H.minLikes || 0)) && (p.comments >= (H.minReplies || 0)));
  log(`Уникальных свежих: ${uniq.length}`);
  step(2, uniq.length ? "done" : "err");
  if (!uniq.length) {
    return { ok: false,
             error: "после фильтров не осталось ни одной ветки. Увеличь окно свежести " +
                    "или снизь минимум лайков/комментариев в настройках охотника." };
  }

  // ─────────────────────────────────────────────────────────────────
  // Шаг 4 — квалификация
  // ─────────────────────────────────────────────────────────────────
  step(3, "run");
  uniq.sort((a, b) => (b.engagement || 0) - (a.engagement || 0));

  // Дешёвый предфильтр ДО модели. Пустые тексты, собственные посты и
  // стоп-слова раньше честно уезжали в модель и жгли генерации впустую:
  // на 60 кандидатов это 60 платных запросов, из которых часть заведомо
  // мусорная. Каждый сэкономленный запрос — это ещё и минус несколько
  // секунд к шагу, который и так читался как зависание.
  const own = String(s.brandHandle || "").replace(/^@/, "").toLowerCase();
  const prelim = uniq.filter((p) => {
    const t = (p.text || "").trim();
    if (t.length < 15) return false;
    if (own && String(p.author || "").toLowerCase() === own) return false;
    const low = t.toLowerCase();
    if ((s.stopKeywords || []).some((k) => k && low.includes(String(k).toLowerCase()))) return false;
    return true;
  });
  if (prelim.length < uniq.length) {
    log(`Предфильтр (пустые / свои / стоп-слова): ${uniq.length} → ${prelim.length}`);
  }

  const keepBest = Math.max(1, Number(H.keepBest) || 10);
  const pool = prelim.slice(0, Math.min(Math.max(keepBest * 2, 40), MAX_QUALIFY));
  const leads = [];
  let qFails = 0, qUnparsed = 0, qStopReason = "";
  const deadline = Date.now() + QUALIFY_BUDGET_MS;

  log(`Квалифицирую: ${pool.length} кандидатов (потолок ${MAX_QUALIFY} за прогон), ` +
      `нужно лучших — ${keepBest}`);

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    await hold();
    if (isStopped()) { qStopReason = "stopped"; break; }
    if (leads.length >= keepBest) { qStopReason = "enough"; break; }
    if (Date.now() > deadline) {
      qStopReason = "deadline";
      log(`⏱ Отбор идёт дольше ${Math.round(QUALIFY_BUDGET_MS / 60000)} мин — ` +
          `останавливаю его и иду комментировать то, что уже отобрано.`);
      break;
    }

    // Прогресс пишем ВСЕГДА. Раньше шаг молчал, пока не попадётся лид, —
    // при сорока кандидатах панель стояла без единой строки по несколько
    // минут, и это читалось как «программа повисла».
    log(`🔍 ${i + 1}/${pool.length} @${p.author || "?"} · проверяю`);

    let d = null;
    try {
      const prompt = fill(s.leadPrompt, {
        brand: [s.brand, H.product].filter(Boolean).join(" | "),
        author: p.author,
        post: (p.text || "").slice(0, 1200),
        niche: s.niche,
      });
      const r = await chat([{ role: "user", content: prompt }],
                           { temperature: 0.3, timeoutMs: QUALIFY_TIMEOUT_MS, retries: 1 });
      d = safeJson(r);
      qFails = 0;
      if (!d) { qUnparsed++; log("   ↷ ответ модели не разобрался — пропускаю"); }
    } catch (e) {
      if (e?.name === "GensOutError") {
        qStopReason = "gens";
        log("💎 Генерации закончились. Отбор остановлен — комментирую тех, кого уже отобрала.");
        break;
      }
      qFails++;
      log(`   ⚠ модель: ${aiErrText(e)} (сбой ${qFails}/${QUALIFY_MAX_FAILS})`);
      if (qFails >= QUALIFY_MAX_FAILS) {
        qStopReason = "ai-down";
        log("Модель не отвечает несколько раз подряд — прекращаю отбор и перехожу к комментариям.");
        break;
      }
      await sleep(1500 * qFails);
      continue;
    }

    if (d?.is_lead) {
      const lead = { ...p, score: d.score || 0, reason: d.reason || "", angle: d.angle || "" };
      leads.push(lead);
      await saveLeads([lead]);
      await sendLeadToTg(lead, s, `Программа: охотник · «${H.product}»`);
      log(`🎯 @${p.author} (${lead.score}) — ${lead.reason || "подходит"}`);
    }
    await sleep(400);
  }

  // Ни одного лида, но отбор не доработал честно (кончились генерации,
  // модель молчала, вышло время, ответы не разобрались) — берём лучших
  // по ключевым словам. Если же модель осмотрела всех и всех отвергла,
  // её решение уважаем и ничего не придумываем.
  const qualificationBroke = ["gens", "ai-down", "deadline"].includes(qStopReason) || qUnparsed > 0;
  if (!leads.length && pool.length && qualificationBroke && !isStopped()) {
    const picked = pool
      .map((p) => ({ p, sc: localLeadScore(p, s) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, Math.min(5, keepBest));
    for (const { p, sc } of picked) {
      const lead = { ...p, score: sc, reason: "по ключевым словам (без AI-оценки)", angle: "" };
      leads.push(lead);
      await saveLeads([lead]);
    }
    if (picked.length) {
      log(`AI-оценка не состоялась — отобрала ${picked.length} по ключевым словам.`);
    }
  }

  log(`Отобрано лидов: ${leads.length}`);
  // Красным помечаем только настоящий сбой отбора. «Проверили всех и
  // никто не подошёл» — нормально отработавший шаг, а не ошибка.
  step(3, (!leads.length && ["gens", "ai-down"].includes(qStopReason)) ? "err" : "done");

  if (isStopped()) {
    return { ok: false, stopped: true, queries, leadsCount: leads.length, commented: 0 };
  }
  if (!leads.length) {
    step(4, "err");
    return { ok: true, queries, leadsCount: 0, commented: 0, failed: 0, skipped: 0, bySkip: {},
             note: "подходящих клиентов не нашлось — смягчи фильтры или опиши продукт конкретнее" };
  }

  // ─────────────────────────────────────────────────────────────────
  // Шаг 5 — диалоги (комментарии)
  // ─────────────────────────────────────────────────────────────────
  step(4, "run");
  // Брони «в работе» от прогонов, которые не доработали до конца (стоп,
  // закрытая вкладка, перезагрузка), живут до 10 минут и молча съедали
  // те же самые лиды при повторном запуске. Снимаем их перед стартом —
  // список «уже прокомментировано» при этом не трогается.
  const pg = await bg({ type: "PURGE_CLAIMS", what: "working" });
  if (pg?.purged) log(`Снято зависших броней: ${pg.purged}`);

  let tab;
  try {
    tab = await ensureThreadsTab();
  } catch (e) {
    step(4, "err");
    return { ok: false, error: "не удалось открыть вкладку Threads: " + (e.message || e),
             queries, leadsCount: leads.length, commented: 0 };
  }

  /**
   * Живой id вкладки. Человек может закрыть Threads посреди прогона —
   * тогда chrome.tabs.update отклоняет промис, и исключение убивало всю
   * программу на полуслове (карточка так и оставалась «идёт»).
   */
  const liveTabId = async () => {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t) return t.id;
    } catch {}
    tab = await ensureThreadsTab();
    log("Вкладка Threads была закрыта — открыла новую.");
    return tab.id;
  };

  let commented = 0, failed = 0, actions = 0, skipped = 0;
  const bySkip = {};

  // Один автор — один заход. Дедуп шёл только по code, поэтому у автора
  // с двумя подходящими постами (в логах — @anneta.producer 75 и 78)
  // охотник писал дважды подряд. Для Threads это выглядит как спам.
  const byAuthor = new Set();
  const targets = leads.filter((l) => {
    const a = String(l.author || "").toLowerCase();
    if (!a || byAuthor.has(a)) return false;
    byAuthor.add(a);
    return true;
  });
  if (targets.length < leads.length) {
    log(`Свернула дубли авторов: ${leads.length} → ${targets.length}`);
  }

  const cap = await safeDailyCap(s.maxCommentsPerDay).catch(() => s.maxCommentsPerDay || 30);
  log(`Начинаю диалоги: ${targets.length} веток · лимит на сегодня ${cap}`);

  for (const lead of targets) {
    if (isStopped()) break;
    await hold();
    if (isStopped()) break;
    if (!(await withinActiveHours().catch(() => true))) {
      log("⏸ Вне активных часов — стоп (Safe Mode). Измени «активные часы» в настройках, " +
          "если хочешь работать сейчас.");
      break;
    }
    const c = (await bg({ type: "GET_COUNTERS" })).counters || { comments: 0 };
    if (c.comments >= cap) { log(`Достигнут дневной лимит комментов (${cap}).`); break; }
    // Атомарно занимаем пост: пометка «прокомментировано» ставится
    // ТОЛЬКО после подтверждённой отправки (см. COMMIT_POST ниже).
    //
    // Пропуск ОБЯЗАТЕЛЬНО пишем в лог. Раньше здесь стоял молчаливый
    // `continue`, и охотник, отобрав восемь лидов, мог не написать ни
    // одного — без единой строки о причине. Со стороны это выглядело как
    // «нашёл, но не комментирует».
    const claim = await bg({ type: "CLAIM_POST", code: lead.code });
    if (claim._bgFailed) {
      // Фон недоступен. Лучше написать без брони (и потенциально
      // повториться при следующем прогоне), чем молча не сделать ничего.
      log("⚠ Фон не ответил на бронь поста — продолжаю без неё.");
    } else if (!claim.claimed) {
      skipped++;
      const why = {
        commented: "уже комментировали раньше",
        cooldown: "пауза после прошлой неудачи",
        queued: "ждёт ручного подтверждения",
        working: "занят другим прогоном",
        busy: "занят",
        "no-code": "нет кода поста",
      }[claim?.reason] || claim?.reason || "неизвестно";
      bySkip[why] = (bySkip[why] || 0) + 1;
      log(`⏭ @${lead.author}: пропуск — ${why}`);
      continue;
    }

    let text = "";
    try {
      const cprompt = fill(s.hunterCommentPrompt, {
        brandName: s.brandName, brand: [s.brand, H.product].filter(Boolean).join(" | "),
        author: lead.author, post: (lead.text || "").slice(0, 1200), angle: lead.angle || "",
      });
      const draft = await chat([{ role: "user", content: cprompt }],
                               { temperature: 0.8, timeoutMs: 60000, retries: 1 });
      // fitComment режет по границам предложений и снимает висящие союзы —
      // раньше здесь был slice() и заход обрывался на «а не»
      const fit = fitComment(draft, { maxChars: s.hunterMaxChars || 190, emoji: s.commentEmoji });
      text = fit.text;
      if (!fit.complete) log(`⚠ Ответ по @${lead.author} пришлось укоротить`);
    } catch (e) {
      // Текст не сгенерировался — это не повод ронять весь прогон.
      // Отпускаем лид с короткой паузой и идём дальше.
      failed++;
      await bg({ type: "RELEASE_POST", code: lead.code, cooldownMin: 30 });
      log(`✕ @${lead.author}: текст не сгенерировался — ${aiErrText(e)}`);
      if (e?.name === "GensOutError") { log("Дальше писать нечем — останавливаюсь."); break; }
      continue;
    }

    if (!text || text.length < 12) {
      skipped++;
      bySkip["слабый текст"] = (bySkip["слабый текст"] || 0) + 1;
      await bg({ type: "RELEASE_POST", code: lead.code, cooldownMin: 60 });
      log(`⤼ @${lead.author}: модель вернула огрызок — пропускаю`);
      continue;
    }

    // Режим берём из настроек охотника: раньше здесь всегда стоял
    // s.commentMode, и в «авто» комментарий оставался черновиком.
    const mode = (H.mode || s.commentMode) === "manual" ? "manual" : "auto";

    /**
     * Один заход на пермалинк. Ключевое отличие от прежней версии:
     * не «открыли и через 1.5с шлём», а ждём, пока карточка ПОСТА реально
     * отрисуется. Пока её нет, расширение комментировало вслепую — отсюда
     * и «поле исчезло» на первом же лиде.
     */
    const tryComment = async () => {
      try {
        const id = await liveTabId();
        await navigate(id, lead.permalink);
        if (!(await ensureContentScript(id))) {
          return { ok: false, error: "content-script не поднялся на странице поста" };
        }
        const ready = await rpcSafe(id, "RPC_WAIT_POST", { code: lead.code, timeout: 12000 }, 20000);
        if (!ready.ok) return { ok: false, error: ready.error || "ветка не открылась" };
        await sleep(900);
        // 60с не хватало: посимвольный ввод + до трёх подтверждений отправки
        // легко перешагивают минуту, а «timeout» трактовался как провал —
        // при том что комментарий мог уже уйти.
        // rpcSafe НЕ используем: этот вызов меняет состояние, и слепой повтор
        // после обрыва связи мог бы отправить второй комментарий.
        return await rpc(id, "RPC_COMMENT", { code: lead.code, text, mode }, 180000);
      } catch (e) {
        // Вкладку закрыли, расширение перезагрузили и т.п. Возвращаем
        // ошибку объектом, а не исключением: иначе падает весь прогон.
        return { ok: false, error: "вкладка: " + (e?.message || e) };
      }
    };

    let r = await tryComment();

    // Повтор ровно один и только когда отправка ТОЧНО не проходила:
    // ok / risky / timeout / оборванный канал повторять нельзя — получим дубль.
    // «message channel closed» означает, что вкладка приняла команду и умерла
    // уже в процессе: комментарий мог уйти.
    const unclear = /timeout|message channel closed|Receiving end does not exist/i.test(r.error || "");
    const retryable = !r.ok && !r.risky && !unclear;
    if (retryable && !isStopped()) {
      log(`↻ @${lead.author}: ${r.error || "не вышло"} — пробую ещё раз`);
      try {
        await navigate(await liveTabId(), "https://www.threads.com/");
      } catch {}
      await sleep(1500);
      r = await tryComment();
    }

    if (r.ok && r.sent) {
      await bg({ type: "COMMIT_POST", code: lead.code });
      await bg({ type: "BUMP_COUNTER", field: "comments" });
      commented++; log(`💬 @${lead.author}: отправлено ✅ «${text}»`);
    } else if (r.risky) {
      // Композер очистился без подтверждения — комментарий мог уйти.
      await bg({ type: "COMMIT_POST", code: lead.code });
      log(`⚠ @${lead.author}: подтверждения нет, повтор не делаю (риск дубля)`);
    } else if (unclear) {
      // Вкладка не ответила вовремя. Отправка могла состояться —
      // помечаем как обработанный, но в счётчик не пишем.
      await bg({ type: "COMMIT_POST", code: lead.code });
      log(`⚠ @${lead.author}: связь с вкладкой оборвалась (${r.error}) — повтор не делаю`);
    } else if (r.ok) {
      await bg({ type: "QUEUE_POST", code: lead.code });
      log(`💬 @${lead.author}: черновик вставлен (режим «вручную»)`);
    } else {
      failed++;
      // 720 мин сжигало лид на полсуток из-за случайной осечки вёрстки.
      await bg({ type: "RELEASE_POST", code: lead.code, cooldownMin: 90 });
      log(`✕ @${lead.author}: ${r.error || "не отправилось"}`);
    }

    // Выходим из ветки к ленте — иначе следующий лид открывался поверх старой
    // страницы и охотник «залипал» в одном обсуждении.
    try { await navigate(await liveTabId(), "https://www.threads.com/"); } catch {}
    await sleep(1200);

    if (isStopped()) break;

    // Пауза берётся из Safe Mode, как в остальных режимах: раньше охотник
    // жил по своим правилам и разгонялся быстрее автокомментинга.
    actions++;
    // Защита от NaN: при аварийно прочитанных настройках выражение
    // min + random*(max-min) давало NaN, а sleep(NaN) — нулевую паузу,
    // то есть охотник начинал строчить комментарии без передышки.
    const secs = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
    const lo = secs(s.commentDelayMinSec, 45);
    const hi = Math.max(lo, secs(s.commentDelayMaxSec, lo));
    const base = lo + Math.random() * (hi - lo);
    const wait = s.safe?.enabled ? await nextGapSec().catch(() => base) : base;
    log(`Пауза ${wait | 0}с перед следующим лидом…`);
    for (let t = 0; t < wait && !isStopped(); t += 5) { await sleep(5000); await hold(); }

    const cool = await maybeCooldown(actions).catch(() => 0);
    if (cool) {
      log(`🧊 Длинная пауза ${Math.round(cool / 60)} мин (Safe Mode)…`);
      for (let t = 0; t < cool && !isStopped(); t += 5) { await sleep(5000); await hold(); }
    }
  }
  // Итог по шагу 5 — всегда, даже когда не написали никому. Молчащий
  // охотник без объяснения причины — главная жалоба по прежней версии.
  if (skipped) {
    const parts = Object.entries(bySkip).map(([k, v]) => `${k}: ${v}`).join(", ");
    log(`⏭ Пропущено лидов: ${skipped} (${parts})`);
  }
  log(`Итог: отправлено ${commented}, не вышло ${failed}, пропущено ${skipped} из ${targets.length}`);
  if (!commented && skipped === targets.length && targets.length) {
    log("ℹ Все лиды были заняты или уже обработаны. Если это повтор прогона — " +
        "подожди окончания паузы или нажми «Сбросить брони» в настройках.");
  }
  step(4, failed && !commented ? "err" : "done");
  return { ok: true, queries, leadsCount: targets.length, commented, failed, skipped, bySkip,
           stopped: isStopped() };
}

// короткий коммент (1 предложение)
async function genComment(post, s) {
  const rule = lengthRule({
    maxWords: s.commentMaxWords, minWords: s.commentMinWords,
    maxChars: s.commentMaxChars, emoji: s.commentEmoji,
  });
  const prompt =
    `${s.commentPrompt}\n\nНиша: ${s.niche}\nПост от @${post.author}:\n${post.text}\n\n` +
    `${rule} Без кавычек и хэштегов. Только текст комментария.` + langRule();
  const r = await chat([{ role: "user", content: prompt }], { temperature: s.temperature });
  return fitComment(r, {
    maxChars: s.commentMaxChars, maxWords: s.commentMaxWords, emoji: s.commentEmoji,
  }).text;
}

function sleepJitter(base, jitter) {
  return Math.max(5, base + Math.round((Math.random() * 2 - 1) * (jitter || 0)));
}

async function sendLeadToTg(lead, s, extra = "") {
  reportEvent("lead_found", {
    target_username: lead.author, target_post_id: lead.code || "",
    niche: s.niche || "",
    detail: `score ${lead.score}${lead.reason ? " — " + lead.reason : ""}`,
  });
  if (!s.telegramNotifyLeads || !s.telegramToken) return;
  const msg =
    `🎯 Потенциальный клиент @${lead.author} (score ${lead.score})\n` +
    `Почему подходит: ${lead.reason || "—"}\n` +
    (lead.angle ? `Как зайти: ${lead.angle}\n` : "") +
    (extra ? extra + "\n" : "") +
    `${lead.permalink}\n\n«${(lead.text || "").slice(0, 220)}»`;
  sendMessage(msg).catch(() => {});
}

// ---- Комментинг из панели (надёжно: пермалинк → лайк → коммент → сон) ----
export async function runCommenting(hooks) {
  const s = await getSettings();
  const stop = hooks?.isStopped || (() => false);
  const hold = hooks?.waitIfPaused || (async () => {});
  const log = hooks?.log || (() => {});
  const tab = await ensureThreadsTab("https://www.threads.com/");
  log("Собираю ленту…");
  const r = await rpcSafe(tab.id, "RPC_COLLECT", { target: s.parseTarget });
  if (!r.ok) return { ok: false, error: r.error };
  await savePosts(r.posts);
  const targets = r.posts.filter((p) => passesFilters(p, s));
  const cap = await safeDailyCap(s.maxCommentsPerDay);
  log(`Целей после фильтра: ${targets.length}. Лимит на сегодня (с прогревом): ${cap}`);
  let done = 0;
  for (const p of targets) {
    if (stop()) break;
    if (!(await withinActiveHours())) { log("⏸ Вне активных часов — стоп (Safe Mode)."); break; }
    const c = (await bg({ type: "GET_COUNTERS" })).counters || { comments: 0 };
    if (c.comments >= cap) { log(`Дневной лимит (${cap}) достигнут.`); break; }
    const claim2 = await bg({ type: "CLAIM_POST", code: p.code });
    if (!claim2._bgFailed && !claim2.claimed) continue;
    let text;
    try { text = await genComment(p, s); }
    catch (e) {
      log("AI Threads: " + e.message);
      await bg({ type: "RELEASE_POST", code: p.code, cooldownMin: 30 });
      continue;
    }
    if (!text || text.length < 12) {
      log(`⤼ @${p.author}: слабый ответ, пропускаю`);
      await bg({ type: "RELEASE_POST", code: p.code, cooldownMin: 360 });
      continue;
    }
    log(`Открываю пост @${p.author}…`);
    await navigate(tab.id, p.permalink);
    const res = await rpcSafe(tab.id, "RPC_COMMENT", { code: p.code, text, mode: s.commentMode, like: s.likeOnComment });
    if (res.ok && res.sent) {
      await bg({ type: "COMMIT_POST", code: p.code });
      await bg({ type: "BUMP_COUNTER", field: "comments" });
      done++; log(`💬 @${p.author}: «${text}» — отправлено ✅`);
    } else if (res.risky) {
      await bg({ type: "COMMIT_POST", code: p.code });
      log(`⚠ @${p.author}: подтверждения нет, но поле очистилось — повтор не делаю`);
    } else if (res.ok) {
      await bg({ type: "QUEUE_POST", code: p.code });
      log(`💬 @${p.author}: «${text}» — черновик (подтверди в окне)`);
    } else {
      await bg({ type: "RELEASE_POST", code: p.code, cooldownMin: 720 });
      log(`✕ @${p.author}: ${res.error || "не отправилось"}`);
    }
    // всегда возвращаемся в ленту, чтобы не остаться внутри ветки
    await navigate(tab.id, "https://www.threads.com/");
    await sleep(1200);
    // Прерываемые паузы: раньше «Стоп» не действовал до конца сна.
    const naps = async (sec) => {
      for (let t = 0; t < sec && !stop(); t += 5) await sleep(Math.min(5, sec - t) * 1000);
      return !stop();
    };
    const cool = await maybeCooldown(done);
    if (cool) { log(`🧊 Длинная пауза ${Math.round(cool / 60)} мин (Safe Mode)…`); if (!(await naps(cool))) break; }
    const w = await nextGapSec();
    log(`Сон ${w}с…`);
    if (!(await naps(w))) break;
  }
  return { ok: true, commented: done };
}

// ---- Пост с вложением (скрепка) ----
export async function createPostWithMedia(text, file, mode) {
  const s = await getSettings();
  const tab = await ensureThreadsTab("https://www.threads.com/");
  return rpc(tab.id, "RPC_POST", { text, file, mode: mode || s.commentMode }, 90000);
}

// ---- ДИРЕКТ: ответы в личке (с одобрением) ----
/**
 * Ответ в директе с учётом ВСЕЙ переписки, а не только последней реплики.
 * Без истории агент здоровается по третьему кругу и переспрашивает то, что
 * человек уже написал, — именно это выдаёт бота.
 */
async function genDM(history, conv, s) {
  const dialogue = (history || [])
    .map((m) => `${m.role === "me" ? "Я" : conv.name || "Собеседник"}: ${m.text}`)
    .join("\n")
    .slice(-2500);

  // Род и имя подставляем отдельной строкой, а не просим встроить в
  // основной промпт: пользователь правит промпт под свою нишу и легко
  // потеряет эту деталь, а собеседник замечает её первой.
  const P = { female: "Ты — девушка. Пиши о себе в женском роде.",
              male: "Ты — парень. Пиши о себе в мужском роде." };
  const persona = P[s.dm.persona] || "";
  const named = s.dm.personaName ? `Тебя зовут ${s.dm.personaName}.` : "";

  const prompt =
    `${s.dm.prompt}\n\n` +
    (persona ? persona + " " + named + "\n" : (named ? named + "\n" : "")) +
    (s.niche ? `Твоя ниша: ${s.niche}\n` : "") +
    (s.brand ? `Что ты предлагаешь: ${s.brand}\n` : "") +
    "\nВОТ ПЕРЕПИСКА (последние сообщения, снизу — самое новое):\n" +
    dialogue +
    "\n\nНапиши следующий ответ от моего лица. Требования:\n" +
    "• ПО СМЫСЛУ последнего сообщения — отвечай именно на то, что человек написал.\n" +
    "• Длина: от 5 до 40 слов. Не длиннее.\n" +
    "• Живая устная речь: как пишет реальный человек в мессенджере. Можно " +
    "короткие фразы, уместный смайлик, лёгкий юмор.\n" +
    "• Никаких признаков нейросети: без «Как ИИ», без канцелярита, без " +
    "маркированных списков, без markdown и звёздочек, без хэштегов.\n" +
    "• Не здоровайся повторно и не переспрашивай уже сказанное.\n" +
    (persona ? "• Следи за родом глаголов о себе — он задан выше.\n" : "") +
    "• Двигай диалог вперёд: ответь по сути и, если уместно, задай один вопрос.\n" +
    "• Верни ТОЛЬКО текст ответа, без кавычек и пояснений." + langRule();

  const r = await chat([{ role: "user", content: prompt }], { temperature: 0.9 });
  return stripMd(r).replace(/^["«»\s]+|["«»\s]+$/g, "").slice(0, 400);
}

/** Кому уже отвечали — переживает перезапуск, защищает от дублей в директе. */
async function dmAnswered() {
  try {
    const { _dmAnswered = {} } = await chrome.storage.local.get("_dmAnswered");
    return _dmAnswered;
  } catch { return {}; }
}
/**
 * Диалоги, где последнее слово за нами и мы ждём ответа. В отличие от
 * «отвечено», метка живёт час: как только собеседник напишет, диалог снова
 * попадёт в очередь. Раньше такой случай писался в «отвечено» на 3 суток.
 */
async function dmWaiting() {
  try {
    const { _dmWaiting = {} } = await chrome.storage.local.get("_dmWaiting");
    return _dmWaiting;
  } catch { return {}; }
}
async function dmMarkWaiting(key) {
  try {
    const map = await dmWaiting();
    map[key] = Date.now();
    const cut = Date.now() - 6 * 3600000;
    for (const k of Object.keys(map)) if (map[k] < cut) delete map[k];
    await chrome.storage.local.set({ _dmWaiting: map });
  } catch {}
}

/** Диалоги, которые человек пропустил вручную. Держим сутки. */
async function dmSkipped() {
  try {
    const { _dmSkipped = {} } = await chrome.storage.local.get("_dmSkipped");
    return _dmSkipped;
  } catch { return {}; }
}
async function dmMarkSkipped(key) {
  try {
    const map = await dmSkipped();
    map[key] = Date.now();
    const cut = Date.now() - 2 * 86400000;
    for (const k of Object.keys(map)) if (map[k] < cut) delete map[k];
    await chrome.storage.local.set({ _dmSkipped: map });
  } catch { /* не критично */ }
}

async function dmMarkAnswered(key) {
  try {
    const map = await dmAnswered();
    map[key] = Date.now();
    // чистим записи старше 3 суток, чтобы диалог снова стал доступен
    const cut = Date.now() - 3 * 86400000;
    for (const k of Object.keys(map)) if (map[k] < cut) delete map[k];
    await chrome.storage.local.set({ _dmAnswered: map });
  } catch {}
}

/**
 * ДИРЕКТ КАК ЖИВОЙ ЧЕЛОВЕК.
 *
 * Цикл на каждый диалог:
 *   считать список → открыть непрочитанный → дождаться загрузки переписки →
 *   «прочитать» (пауза) → написать ответ по смыслу (5–40 слов) →
 *   подтвердить отправку → пометить как отвеченный → вернуться к списку →
 *   пауза 160 секунд → следующий диалог.
 *
 * Отвеченные диалоги запоминаются, поэтому второй раз в них агент не пишет.
 */
export async function runDirect(hooks) {
  const s = await getSettings();
  const stop = hooks?.isStopped || (() => false);
  const log = hooks?.log || (() => {});
  const step = hooks?.step || (() => {});
  const propose = hooks?.propose; // (conv,text,last) => 'approve'|'skip'|<editedText>
  // Ожидание снятой паузы. Раньше строки не было: ниже в цикле стоял
  // await hold(), и на первом же диалоге программа падала с
  // «hold is not defined» — сразу после того, как пересчитала диалоги.
  // Снаружи это выглядело так, будто Директ молча ничего не делает.
  const hold = hooks?.waitIfPaused || (async () => {});
  const PAUSE_SEC = s.dm.cycleSleepSec || 160;

  const tab = await ensureThreadsTab("https://www.threads.com/messages");
  await navigate(tab.id, "https://www.threads.com/messages");
  await sleep(2000);

  step(0, "run");
  // Раньше здесь и ниже стоял голый rpc(). На разделе /messages Threads
  // делает собственные SPA-переходы, content-script умирает, и вызов падал
  // с «Receiving end does not exist» / «message channel closed» — диалог
  // засчитывался в ошибки. rpcSafe переинжектит скрипт и повторяет вызов;
  // все три вызова — только чтение, повтор безопасен.
  const sc = await rpcSafe(tab.id, "RPC_DM_SCAN");
  if (!sc.ok) return { ok: false, error: sc.error };
  const convs = sc.convs || [];
  if (!convs.length) return { ok: false, error: "не нашла ни одного диалога — открыт ли раздел «Сообщения»?" };
  step(0, "done");

  const answered = await dmAnswered();
  const skippedMap = await dmSkipped();
  const waiting = await dmWaiting();
  const key = (c) => c.href || c.name;

  // Режим работы. «manual» — каждый ответ показывается на подтверждение,
  // «auto» — отправка без вопроса. Раньше отдельного поля не было: режим
  // выводился из dm.approve, и назвать его в интерфейсе было нечем.
  const MODE = s.dm.mode || (s.dm.approve === false ? "auto" : "manual");
  log(MODE === "auto"
    ? "Режим: автоматический — отвечаю сам, без подтверждения."
    : "Режим: ручной — каждый ответ показываю перед отправкой.");

  // ── Кого вообще берём в работу ───────────────────────────────
  // Программа отвечает там, где последнее слово за собеседником: он
  // написал и ждёт, либо я ему ещё ни разу не ответил. Раньше отбора
  // по списку не было вовсе — открывались подряд все диалоги, включая
  // те, где мы сами ждём ответа, и каждый приходилось читать целиком.
  const stats = { mine: 0, answered: 0, skipped: 0, waiting: 0 };
  const queue = convs
    .filter((c) => {
      // Непрочитанное сообщение перебивает любые метки: собеседник написал
      // после нашего ответа, значит диалог снова требует внимания. Раньше
      // фильтр стоял до этой проверки, и новые сообщения в уже отвеченных
      // диалогах не обрабатывались до истечения трёх суток.
      if (c.unread) return true;
      if (answered[key(c)]) { stats.answered++; return false; }
      if (waiting[key(c)] && Date.now() - waiting[key(c)] < 3600000) {
        stats.waiting++; return false;
      }
      // «Пропустить» держится сутки: иначе следующий запуск сразу же
      // снова открывал тот же диалог.
      if (skippedMap[key(c)] && Date.now() - skippedMap[key(c)] < 86400000) {
        stats.skipped++; return false;
      }
      // Последнее сообщение моё и непрочитанного нет — отвечать нечего.
      if (c.mine && !c.unread) { stats.mine++; return false; }
      return true;
    })
    .sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0))
    .slice(0, s.dm.maxPerRun);

  const parts = [`Диалогов всего: ${convs.length}`, `беру в работу: ${queue.length}`];
  if (stats.mine) parts.push(`последнее слово моё: ${stats.mine}`);
  if (stats.answered) parts.push(`уже отвечено: ${stats.answered}`);
  if (stats.skipped) parts.push(`пропущено ранее: ${stats.skipped}`);
  if (stats.waiting) parts.push(`жду ответа: ${stats.waiting}`);
  log(parts.join(" · "));
  if (!queue.length) {
    return { ok: true, sent: 0, skipped: 0, failed: 0, nothing: true };
  }

  let sent = 0, skipped = 0, failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const conv = queue[i];
    if (stop()) break;
    await hold();
    if (stop()) break;

    step(1, "run");
    log(`▸ [${i + 1}/${queue.length}] Открываю диалог: ${conv.name}`);
    await ensureContentScript(tab.id);
    const op = await rpcSafe(tab.id, "RPC_DM_OPEN", { index: conv.i, href: conv.href });
    if (!op.ok) {
      failed++; step(1, "err");
      log(`✕ ${conv.name}: ${op.error || "не открылся"}`);
      await backToList(tab, log);
      continue;
    }
    step(1, "done");

    // 2) читаем переписку целиком
    step(2, "run");
    // После открытия диалога Threads перерисовывает панель целиком —
    // даём ей осесть и убеждаемся, что скрипт пережил переход.
    await sleep(1200);
    await ensureContentScript(tab.id);
    const h = await rpcSafe(tab.id, "RPC_DM_HISTORY");
    const history = h.history || [];
    if (!history.length) {
      skipped++; step(2, "err");
      log(`⏭ ${conv.name}: переписка не прогрузилась`);
      await backToList(tab, log);
      continue;
    }
    if (!h.needsReply) {
      // Одна перепроверка: сразу после перехода в панели ещё может висеть
      // предыдущая переписка, и «последнее слово за мной» относится не к
      // этому диалогу. Раньше такой диалог помечался отвеченным навсегда.
      await sleep(1500);
      const h2 = await rpcSafe(tab.id, "RPC_DM_HISTORY");
      if (h2.ok && h2.needsReply) {
        Object.assign(h, h2);
      } else {
        skipped++; step(2, "done");
        log(`⏭ ${conv.name}: последнее слово за мной — жду ответа собеседника`);
        // Здесь стоял dmMarkAnswered — и это была причина того, что агент
        // «открывает диалог, читает и уходит к следующему». Диалог, в котором
        // мы всего лишь ждём ответа, помечался отвеченным на трое суток.
        // Собеседник писал через час — а диалог был уже исключён из очереди
        // фильтром answered, и агент до него не доходил вообще. Помечаем
        // мягко, на час: столько живёт ситуация «я написал, он ещё молчит».
        await dmMarkWaiting(key(conv));
        await backToList(tab, log);
        continue;
      }
    }
    const history2 = h.history || history;
    const last = history2.filter((m) => m.role === "them").slice(-1)[0]?.text || conv.preview;
    log(`  прочитано реплик: ${history2.length} · последнее: «${(last || "").slice(0, 60)}»`);
    step(2, "done");

    // 3) обдумывание — человек не отвечает мгновенно
    step(3, "run");
    const think = 6 + Math.random() * 9;
    log(`  ✍️ Обдумываю ответ (${think | 0}с)…`);
    await sleep(think * 1000);

    let reply;
    try {
      // Раньше сюда уходила переменная history — снимок переписки из ПЕРВОГО
      // чтения. А когда срабатывала перепроверка (h2), актуальные реплики
      // попадали только в history2, и модель получала переписку предыдущего
      // диалога. Ответ выходил не по теме или пустым, и агент писал «не
      // получилось сформулировать» — со стороны это и выглядело как «читает,
      // но не отвечает». Передаём то, что реально прочитано.
      reply = await genDM(history2, conv, s);
    } catch (e) {
      failed++; step(3, "err");
      log(`✕ ${conv.name}: модель — ${e.message || e}`);
      await backToList(tab, log);
      continue;
    }
    const raw1 = reply;
    reply = trimWords(reply, 3, 40);
    if (!reply) {
      // Вторая причина молчания: нижняя граница в 5 слов отбрасывала
      // нормальные короткие ответы вроде «Да, напишу вечером». В мессенджере
      // это живая реплика, а не брак. Опустили до 3 и даём одну повторную
      // попытку — модель часто возвращает пустое из-за температуры, а не
      // потому, что отвечать нечего.
      log(`  ↻ Ответ не прошёл проверку («${(raw1 || "").slice(0, 40)}») — пробую ещё раз`);
      try {
        reply = trimWords(await genDM(history2, conv, s), 3, 40);
      } catch (e) {
        reply = "";
      }
    }
    if (!reply) {
      skipped++; step(3, "err");
      log(`⏭ ${conv.name}: модель дважды вернула пустой ответ. `
        + `Проверьте промпт директа в настройках.`);
      await backToList(tab, log);
      continue;
    }
    step(3, "done");

    // 4) подтверждение (если включено) и отправка
    let decision = "approve";
    if (MODE === "manual" && propose) decision = await propose(conv, reply, last);
    if (decision === "skip") {
      skipped++;
      // Запоминаем отказ, иначе тот же диалог откроется на следующем
      // запуске — и так по кругу.
      await dmMarkSkipped(key(conv));
      log(`⏭ ${conv.name} — пропущен, к нему не вернусь сутки`);
      await backToList(tab, log);
      continue;
    }
    if (decision === "stop") {
      log("■ Остановлено. Нажмите «Продолжить» — продолжу со следующего диалога.");
      break;
    }
    const text = (typeof decision === "string" && decision !== "approve") ? decision : reply;

    step(4, "run");
    const r = await rpcSafe(tab.id, "RPC_DM_SEND", { text });
    if (r.ok && r.sent) {
      sent++; step(4, "done");
      await dmMarkAnswered(key(conv));
      log(`✉ ${conv.name}: «${text}»`);
    } else {
      failed++; step(4, "err");
      log(`✕ ${conv.name}: ${r.error || "отправка не подтвердилась"}`);
    }

    // 5) назад ко всем диалогам и пауза перед следующим
    await backToList(tab, log);
    if (i < queue.length - 1 && !stop()) {
      log(`⏳ Пауза ${PAUSE_SEC}с перед следующим диалогом…`);
      for (let t = 0; t < PAUSE_SEC && !stop(); t += 5) await sleep(5000);
    }
  }

  log(`Готово. Отвечено: ${sent}, пропущено: ${skipped}, ошибок: ${failed}`);
  return { ok: true, sent, skipped, failed };
}

/** Обрезать ответ до живого объёма: не короче min слов, не длиннее max. */
function trimWords(t, min, max) {
  const clean = stripMd(t || "").replace(/^["«»\s]+|["«»\s]+$/g, "").trim();
  if (!clean) return "";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < min) return "";
  if (words.length <= max) return clean;
  // режем по границе предложения, чтобы мысль не обрывалась
  const cut = words.slice(0, max).join(" ");
  const dot = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return dot > 40 ? cut.slice(0, dot + 1) : cut.replace(/[,;:\-–—]\s*$/, "") + ".";
}

/** Вернуться к списку переписок — иначе следующий диалог не откроется. */
/**
 * Вернуться к списку диалогов.
 *
 * Раньше здесь была полная перезагрузка /messages после КАЖДОГО диалога —
 * страница мигала, список собирался заново, а весь прогресс Threads
 * (позиция прокрутки, уже подгруженные строки) терялся. Сначала пробуем
 * штатную кнопку «назад» внутри страницы: это обычный SPA-переход, без
 * перезагрузки. Полная навигация остаётся запасным вариантом.
 */
async function backToList(tab, log) {
  try {
    const r = await rpcSafe(tab.id, "RPC_DM_BACK", {}, 12000);
    if (r?.ok) { await sleep(700); return; }
  } catch (e) { /* уходим в запасной путь */ }
  try {
    await navigate(tab.id, "https://www.threads.com/messages");
    await sleep(1200);
  } catch (e) { log?.("не удалось вернуться к списку: " + (e.message || e)); }
}

function clamp(t, max) {
  t = stripMd(t);
  const m = t.match(/^[\s\S]*?[.!?…](?=\s|$)/);
  if (m && m[0].length >= 20) t = m[0].trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "").trim() : t;
}
function withinHours(timeStr, hours) {
  if (!timeStr) return true; // если время не спарсилось — не отбрасываем
  const d = new Date(timeStr);
  if (isNaN(d)) return true;
  return Date.now() - d.getTime() <= hours * 3600 * 1000;
}

/**
 * Один комментарий к конкретному лиду — тот же путь, что у охотника
 * (открыть пермалинк → дождаться карточки → вставить → отправить).
 * Вынесен отдельно, чтобы кнопка «💬 Коммент» в «Клиентах» делала ровно
 * то же самое, а не печатала черновик в чат.
 */
export function fitLeadComment(draft, s) {
  const fit = fitComment(draft, { maxChars: s.hunterMaxChars || 190, emoji: s.commentEmoji });
  return fit.text;
}

export async function commentOnLead(lead, text, mode = "auto", log = () => {}) {
  if (!lead?.permalink || !lead?.code) return { ok: false, error: "у клиента нет ссылки на пост" };
  const tab = await ensureThreadsTab();
  await navigate(tab.id, lead.permalink);
  if (!(await ensureContentScript(tab.id))) {
    return { ok: false, error: "content-script не поднялся на странице поста" };
  }
  const ready = await rpcSafe(tab.id, "RPC_WAIT_POST", { code: lead.code, timeout: 12000 }, 20000);
  if (!ready.ok) return { ok: false, error: ready.error || "ветка не открылась" };
  await sleep(900);
  log("ветка открыта, вставляю комментарий");
  // Состояние меняется — слепой повтор запрещён, поэтому rpc, а не rpcSafe:
  // rpcSafe повторяет и при «message channel closed», а это значит, что
  // вкладка команду приняла и умерла уже в процессе — комментарий мог уйти,
  // и повтор оставил бы второй такой же под тем же постом.
  const r = await rpc(tab.id, "RPC_COMMENT", { code: lead.code, text, mode }, 180000);
  if (r.ok && r.sent) {
    await bg({ type: "COMMIT_POST", code: lead.code });
    await bg({ type: "BUMP_COUNTER", field: "comments" });
  } else if (r.ok) {
    await bg({ type: "QUEUE_POST", code: lead.code });
  }
  return r;
}

/* ══════════════════════════════════════════════════════════════
   ДЕЙСТВИЯ ПО КОНКРЕТНОМУ ПОСТУ (вкладка «Посты»)
   ══════════════════════════════════════════════════════════════ */

/** Комментарий под конкретный пост — теми же промптами, что и у движка. */
export async function commentFor(post) {
  const s = await getSettings();
  return genComment(post, s);
}

/** Первое сообщение автору поста: повод — сам пост, а не пустое «привет». */
async function genFirstDM(post, s) {
  const prompt =
    `${s.dm.prompt}\n\nНиша: ${s.niche || "—"}\n` +
    `Ты пишешь первым в личные сообщения автору поста @${post.author}.\n` +
    `Его пост:\n${(post.text || "").slice(0, 600)}\n\n` +
    "Напиши короткое первое сообщение: зацепись за конкретную мысль из поста, " +
    "задай уместный вопрос. Не продавай, не представляйся длинно, без хэштегов. " +
    "1–2 коротких предложения." + langRule();
  const r = await directChat([{ role: "user", content: prompt }], { temperature: s.temperature });
  return String(r || "").trim().replace(/^["«]|["»]$/g, "");
}

/**
 * Открыть переписку с автором поста и подготовить первое сообщение.
 *
 * auto = true  — отправляем сами;
 * auto = false — вставляем текст в поле и оставляем отправку человеку.
 *
 * Переписки может ещё не существовать, поэтому идём через профиль автора:
 * это единственный путь, который работает и для новых собеседников.
 */
export async function dmToAuthor(post, auto = true) {
  const s = await getSettings();
  if (!post?.author) return { ok: false, error: "у поста нет автора" };

  let text;
  try { text = await genFirstDM(post, s); }
  catch (e) { return { ok: false, error: "модель: " + (e.message || e) }; }
  if (!text) return { ok: false, error: "не получилось сформулировать сообщение" };

  const tab = await ensureThreadsTab();
  await navigate(tab.id, `https://www.threads.com/@${post.author}`);
  await sleep(1800);
  if (!(await ensureContentScript(tab.id))) {
    return { ok: false, error: "content-script не поднялся на профиле" };
  }

  const op = await rpcSafe(tab.id, "RPC_DM_FROM_PROFILE", {}, 30000);
  if (!op.ok) return { ok: false, error: op.error || "не удалось открыть переписку с автора профиля", text };

  await sleep(1200);
  if (!auto) {
    const put = await rpcSafe(tab.id, "RPC_DM_DRAFT", { text }, 30000);
    return put.ok ? { ok: true, drafted: true, text }
                  : { ok: false, error: put.error || "не удалось вставить текст", text };
  }
  const r = await rpcSafe(tab.id, "RPC_DM_SEND", { text }, 60000);
  return r.ok && r.sent ? { ok: true, sent: true, text }
                        : { ok: false, error: r.error || "отправка не подтвердилась", text };
}

