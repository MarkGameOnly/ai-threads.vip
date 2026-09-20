import { getSettings } from "../shared/storage.js";
import { chat, GensOutError } from "../shared/ai.js";
import * as T from "./tools.js";
import * as I18N from "../shared/i18n.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fileToB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });

let settings = null;
let history = [];
let hunterCfg = null;
let stopFlag = false;
// Пауза отличается от остановки: программа замирает на месте и может
// продолжить с того же лида. Раньше была только кнопка «Остановить»,
// после неё приходилось запускать охотника заново с первого шага.
let pauseFlag = false;
/** Ждать, пока пауза снята. Возвращает управление и при полной остановке. */
async function waitIfPaused() {
  while (pauseFlag && !stopFlag) await new Promise((r) => setTimeout(r, 400));
}
let pendingDM = null; // {resolve} для одобрения ответа в директе

init();

async function init() {
  settings = await getSettings();
  // Язык применяем до первой отрисовки, иначе интерфейс успевает мигнуть
  // русским. Значение с сервера (выбор в боте) подтягиваем следом.
  await I18N.resolve();
  I18N.apply();
  syncLangFromServer();
  await renderModelPick();
  hunterCfg = { ...settings.hunter };
  renderHunterSteppers();
  // Первый запуск: пока нет токена, показываем экран входа вместо
  // сообщения в чат — раньше человек читал «открой настройки» и должен
  // был сам догадаться, где они и что туда вставлять.
  if (!settings.apiToken) {
    showOnboarding(1);
  } else {
    emptyChat();
  }
  wire();
  wireOnboarding();
  renderLeads(); renderPosts();
  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local") return;
    if (c.threads_leads) renderLeads();
    if (c.threads_posts) renderPosts();
  });
}

/* ---------------- ЧАТ ---------------- */
function emptyChat() {
  $("messages").innerHTML =
    `<div class="empty">${I18N.t("chat_hello", "Я AI Threads VIP.")}<br>${I18N.t("chat_hello2", "Скажи, что сделать:")}<br>
    «спарси ленту», «найди клиентов», «разбери автора @nickname»,<br>
    «запусти комментинг», «сгенери пост про…», «запусти охотника».</div>`;
}
function userMsg(t) { addMsg("user", t, "Вы"); }
function activeModelLabel() {
  const m = (settings.modelCatalog || []).find((x) => x.id === settings.aiModel);
  return m ? m.label : (settings.modelLabel || "AI Threads");
}
function botMsg(t) { return addMsg("bot", t, activeModelLabel()); }

/**
 * Выбор модели прямо в панели: список приходит с сервера
 * (/api/ext/models), недоступные показываем, но не даём выбрать —
 * так видно, что именно откроется на PRO.
 */
async function renderModelPick() {
  const sel = $("modelPick");
  if (!sel) return;
  let models = settings.modelCatalog || [];
  if (!models.length && settings.backendUrl && settings.apiToken) {
    try {
      const r = await fetch(settings.backendUrl.replace(/\/+$/, "") + "/api/ext/models",
                            { headers: { "X-Ext-Token": settings.apiToken } });
      if (r.ok) {
        const d = await r.json();
        models = d.models || [];
        await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { modelCatalog: models } });
        settings.modelCatalog = models;
        if (!settings.aiModel && d.default) settings.aiModel = d.default;
      }
    } catch {}
  }
  if (!models.length) {
    sel.innerHTML = '<option value="">AI Threads Core</option>';
    return;
  }
  sel.innerHTML = '<option value="">Модель по умолчанию</option>' +
    models.map((m) => `<option value="${m.id}" ${m.allowed ? "" : "disabled"}>` +
      `${m.label}${m.allowed ? "" : " 🔒"}</option>`).join("");
  sel.value = settings.aiModel || "";
}
function errMsg(t) { addMsg("err", t, "Ошибка"); }

function isConnected() { return !!(settings && settings.apiToken && settings.backendUrl); }

/**
 * Забрать язык, выбранный в Telegram-боте. Тихо и не блокируя интерфейс:
 * если сети нет или токен протух, остаёмся на том языке, что уже показан.
 */
async function syncLangFromServer() {
  if (!isConnected()) return;
  try {
    const r = await fetch(settings.backendUrl.replace(/\/+$/, "") + "/api/ext/me",
      { headers: { "X-Ext-Token": settings.apiToken } });
    if (!r.ok) return;
    const j = await r.json();
    const before = I18N.lang();
    const after = await I18N.syncFromServer(j.lang);
    if (after !== before) I18N.apply();
  } catch (e) { /* офлайн — не мешаем работе панели */ }
}
let _connectShown = false;
function needConnect() {
  if (_connectShown) return;         // не спамим — показываем один раз
  _connectShown = true;
  const m = $("messages");
  const card = document.createElement("div");
  card.className = "prog";
  card.innerHTML = `<div class="ph">🔌 Сначала подключись</div>
    <div class="plog">Открой ⚙️ Настройки → «Подключение», введи <b>Telegram ID</b> и <b>ключ</b> из бота
    <a href="https://t.me/aithreads50_bot" target="_blank">@aithreads50_bot</a> → «Кабинет», и нажми «Подключить».</div>
    <button class="buybtn" id="goConnect">Открыть настройки</button>`;
  m.appendChild(card); m.scrollTop = m.scrollHeight;
  const b = card.querySelector("#goConnect");
  if (b) b.onclick = () => chrome.runtime.openOptionsPage();
}

function handleErr(e) {
  if (e instanceof GensOutError || e?.name === "GensOutError") {
    const m = $("messages");
    const card = document.createElement("div");
    card.className = "prog";
    card.innerHTML = `<div class="ph">💎 Бесплатные генерации закончились</div>
      <div class="plog">Оформи VIP — безлимитные генерации, программы и Директ.</div>
      <a class="buybtn" href="${esc(e.buyUrl || "https://t.me/tribute/app?startapp=pBAc")}" target="_blank">Оформить VIP</a>`;
    m.appendChild(card); m.scrollTop = m.scrollHeight;
    return;
  }
  // ошибка «не подключён» → дружелюбная карточка, без спама
  const msg = e?.message || String(e);
  if (/не подключ|подключи|not connected|Telegram ID/i.test(msg)) { needConnect(); return; }
  errMsg(msg);
}
function addMsg(cls, text, who) {
  const m = $("messages"); const e = m.querySelector(".empty"); if (e) e.remove();
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.innerHTML = `<div class="who">${esc(who)}</div>${esc(text)}`;
  m.appendChild(d); m.scrollTop = m.scrollHeight;
  return d;
}

// карточка-программа (шаги + лог) прямо в чате
function progCard(title, steps) {
  const m = $("messages"); const e = m.querySelector(".empty"); if (e) e.remove();
  const card = document.createElement("div");
  card.className = "prog";
  card.innerHTML = `
    <div class="ph">🕵️ ${esc(title)} <span class="badge">идёт</span></div>
    ${steps.map((s, i) => `<div class="st" data-i="${i}"><span class="dot"></span>${esc(s)}</div>`).join("")}
    <div class="plog"></div>
    <div class="progbtns">
      <button class="pausebtn">${esc(I18N.t("prog_stop", "■ Остановить"))}</button>
      <button class="stopbtn">${esc(I18N.t("prog_finish", "✕ Завершить"))}</button>
    </div>`;
  m.appendChild(card); m.scrollTop = m.scrollHeight;
  const stEls = card.querySelectorAll(".st");
  const plog = card.querySelector(".plog");
  const pauseBtn = card.querySelector(".pausebtn");
  pauseFlag = false;
  // «Остановить» — обратимая остановка: программа замирает и ждёт, а не
  // теряет место. «Завершить» — окончательный выход из прогона.
  pauseBtn.onclick = () => {
    pauseFlag = !pauseFlag;
    pauseBtn.textContent = pauseFlag ? I18N.t("prog_resume", "▶ Продолжить")
                                     : I18N.t("prog_stop", "■ Остановить");
    pauseBtn.classList.toggle("resume", pauseFlag);
    card.querySelector(".badge").textContent = pauseFlag ? I18N.t("prog_stopped", "остановлено")
                                                         : I18N.t("prog_running", "идёт");
    log(pauseFlag
      ? I18N.t("prog_stop_hint", "■ Остановлено. Нажмите «Продолжить» — вернусь к тому же месту.")
      : I18N.t("prog_resume_hint", "▶ Продолжаю."));
  };
  card.querySelector(".stopbtn").onclick = () => {
    stopFlag = true; pauseFlag = false;
    log(I18N.t("prog_finish_hint", "Завершаю после текущего шага…"));
  };
  function step(i, state) {
    const el = stEls[i]; if (!el) return;
    el.classList.remove("run", "done", "err"); el.classList.add(state === "run" ? "run" : state);
  }
  function log(msg) { const l = document.createElement("div"); l.textContent = "• " + msg; plog.appendChild(l); plog.scrollTop = plog.scrollHeight; m.scrollTop = m.scrollHeight; }
  function finish(txt) {
    card.querySelector(".badge").textContent = txt || "готово";
    card.querySelector(".progbtns")?.remove();
  }
  return { step, log, finish };
}

// простой лог-бокс для не-пошаговых инструментов
function busyCard(title) {
  const m = $("messages"); const e = m.querySelector(".empty"); if (e) e.remove();
  const card = document.createElement("div"); card.className = "prog";
  card.innerHTML = `<div class="ph">⏳ ${esc(title)}</div><div class="plog"></div>`;
  m.appendChild(card); m.scrollTop = m.scrollHeight;
  const plog = card.querySelector(".plog");
  return {
    log: (msg) => { const l = document.createElement("div"); l.textContent = "• " + msg; plog.appendChild(l); plog.scrollTop = plog.scrollHeight; m.scrollTop = m.scrollHeight; },
    done: () => card.querySelector(".ph").textContent = "✓ " + title,
  };
}

const SYSTEM = () =>
  `Ты — AI Threads VIP, ассистент для сети Threads, встроенный в браузер. Бренд владельца: ${settings.brandName} (${settings.brandProfile}). Ниша: ${settings.niche}.
Тебе доступны ИНСТРУМЕНТЫ. Если запрос пользователя требует действия на Threads — верни СТРОГО один JSON-объект и НИЧЕГО больше:
{"action":"ИМЯ","args":{...},"say":"короткая фраза, что ты делаешь"}
Доступные action:
- parse_feed {target?}            — спарсить ленту (target постов)
- parse_profile {handle,target?}  — спарсить профиль
- parse_search {query,target?}    — поиск по ключевой фразе
- analyze_author {handle}         — глубокий разбор автора (взлёты/падения, боли, триггеры, время, регулярность)
- find_leads {target?}            — найти потенциальных клиентов в ленте
- start_commenting {}             — запустить авто-комментинг
- stop_commenting {}              — остановить комментинг
- start_posting {}                — запустить автопостинг из очереди тем
- generate_post {topic}           — сгенерировать текст поста
- run_hunter {product?}           — запустить «Охотник за клиентами» (5 шагов)
- run_direct {}                   — ответить в Директ как живой человек (с одобрением)
Если действие НЕ нужно (обычный вопрос/совет) — ответь обычным текстом, без JSON.
Handle пиши без @. Отвечай кратко и по делу.
` + (I18N.lang() === "en"
      ? "\nВАЖНО: пользователь выбрал английский язык интерфейса. Все обычные ответы, "
        + "поле say в JSON и любые пояснения пиши ТОЛЬКО по-английски."
      : "\nПользователь выбрал русский язык интерфейса — отвечай по-русски.");

async function onSend() {
  const text = $("input").value.trim();
  if (!text) return;
  if (!isConnected()) { userMsg(text); $("input").value = ""; needConnect(); return; }
  $("input").value = ""; $("input").style.height = "auto";
  userMsg(text);
  history.push({ role: "user", content: text });

  let reply;
  try {
    reply = await chat([{ role: "system", content: SYSTEM() }, ...history], { temperature: 0.4 });
  } catch (e) { handleErr(e); return; }

  const action = extractAction(reply);
  if (!action) {
    history.push({ role: "assistant", content: reply });
    botMsg(reply);
    return;
  }
  if (action.say) botMsg(action.say);
  history.push({ role: "assistant", content: JSON.stringify(action) });
  await runTool(action.action, action.args || {});
}

function extractAction(text) {
  const m = text && text.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); return o.action ? o : null; } catch { return null; }
}

async function summarize(toolName, result) {
  try {
    const r = await chat([
      { role: "system", content: "Ты кратко и по-русски резюмируешь результат инструмента для пользователя. 1–3 предложения, по делу." },
      { role: "user", content: `Инструмент: ${toolName}\nРезультат(JSON): ${JSON.stringify(result).slice(0, 1500)}` },
    ], { temperature: 0.4 });
    botMsg(r);
  } catch { /* тихо */ }
}

async function runTool(name, args) {
  try {
    switch (name) {
      case "parse_feed": {
        const c = busyCard("Парсинг ленты");
        const r = await T.parseFeed(args.target, c.log); c.done();
        if (!r.ok) return errMsg(r.error);
        botMsg(`Спарсил ${r.posts.length} постов. Открой вкладку «Посты», чтобы посмотреть цифры.`);
        break;
      }
      case "parse_profile": {
        const c = busyCard("Парсинг профиля");
        const r = await T.parseProfile(args.handle, args.target, c.log); c.done();
        if (!r.ok) return errMsg(r.error);
        botMsg(`Собрал ${r.posts.length} постов профиля @${r.handle}.`);
        break;
      }
      case "parse_search": {
        const c = busyCard("Поиск по фразе");
        const r = await T.parseSearch(args.query, args.target, c.log); c.done();
        if (!r.ok) return errMsg(r.error);
        botMsg(`По «${args.query}» собрал ${r.posts.length} постов.`);
        break;
      }
      case "analyze_author": {
        const c = busyCard("Разбор автора @" + (args.handle || ""));
        const r = await T.analyzeAuthor(args.handle, c.log); c.done();
        if (!r.ok) return errMsg(r.error);
        botMsg(r.report);
        break;
      }
      case "find_leads": {
        const c = busyCard("Поиск клиентов");
        const r = await T.findLeads(args.target, c.log); c.done();
        if (!r.ok) return errMsg(r.error);
        botMsg(`Нашёл клиентов: ${r.leads.length}. Смотри вкладку «Клиенты».`);
        break;
      }
      case "start_commenting":
        await runCommentingProgram(); break;
      case "stop_commenting":
        stopFlag = true; await T.stopCommenting(); botMsg("Останавливаю комментинг."); break;
      case "run_direct":
        await runDirectProgram(); break;
      case "start_posting":
        await T.startPosting(); botMsg("Запустил автопостинг из очереди тем."); break;
      case "generate_post": {
        const r = await T.generatePost(args.topic || settings.niche);
        botMsg(r.text); break;
      }
      case "run_hunter":
        await runHunterProgram({ ...hunterCfg, product: args.product || hunterCfg.product }); break;
      default:
        botMsg("Не знаю такого действия: " + name);
    }
  } catch (e) { handleErr(e); }
}

/* ---------------- ОХОТНИК ---------------- */
async function runHunterProgram(cfg) {
  if (!isConnected()) { needConnect(); return; }
  if (!cfg.product) { openHunter(); return; }
  stopFlag = false; pauseFlag = false;
  botMsg("Запускаю программу «AI-охотник за клиентами».");
  const card = progCard("AI-охотник за клиентами", [
    "Построить поисковые гипотезы",
    "Собрать поисковую выдачу по всем запросам",
    "Оставить свежие уникальные возможности",
    "Строгая AI-квалификация лидов",
    "Начать полезные диалоги в выбранных ветках",
  ]);
  const res = await T.runHunter(cfg, {
    step: card.step, log: card.log, isStopped: () => stopFlag,
    waitIfPaused,
  });
  if (res.stopped) { card.finish("остановлено"); botMsg("Программа остановлена."); return; }
  if (!res.ok) { card.finish("ошибка"); errMsg(res.error || "не удалось"); return; }
  card.finish("готово");
  botMsg(`Готово. Гипотез: ${res.queries.length}, лидов: ${res.leadsCount}, диалогов начато: ${res.commented}. Клиенты — во вкладке «Клиенты».`);
}

/* ---------------- КОММЕНТИНГ (панель) ---------------- */
async function runCommentingProgram() {
  if (!isConnected()) { needConnect(); return; }
  stopFlag = false; pauseFlag = false;
  const card = progCard("Авто-комментинг", ["Идёт комментирование лент…"]);
  card.step(0, "run");
  const res = await T.runCommenting({ log: card.log, isStopped: () => stopFlag });
  card.step(0, res.ok ? "done" : "err");
  card.finish(res.ok ? "готово" : "ошибка");
  if (!res.ok) return errMsg(res.error || "не удалось");
  botMsg(`Комментинг завершён. Отправлено: ${res.commented}. (Если режим «черновик» — подтверждай отправку в окне Threads.)`);
}

/* ---------------- ДИРЕКТ ---------------- */
async function runDirectProgram() {
  if (!isConnected()) { needConnect(); return; }
  stopFlag = false; pauseFlag = false;
  botMsg("Открываю Директ и готовлю ответы (живой тон).");
  // Пошаговая карточка — как у «Охотника»: видно, на чём именно программа
  // сейчас находится и где именно спотыкается.
  const card = progCard("Ответы в Директ", [
    "Считать список диалогов",
    "Открыть диалог с непрочитанным",
    "Прочитать переписку целиком",
    "Обдумать ответ по смыслу",
    "Отправить и вернуться к списку",
  ]);
  const res = await T.runDirect({
    log: card.log,
    step: (i, st) => card.step(i, st),
    isStopped: () => stopFlag,
    waitIfPaused,
    propose: (conv, text, last) => askApproveDM(conv, text, last),
  });
  card.finish(res.ok ? "готово" : "ошибка");
  if (!res.ok) return errMsg(res.error || "не удалось (проверь, что открыт /messages и селекторы 🩺)");
  if (res.nothing) return botMsg(I18N.t("dm_nothing",
    "Новых диалогов нет: везде последнее слово за вами или уже отвечено."));
  botMsg(`Директ готов. Отвечено: ${res.sent}, пропущено: ${res.skipped || 0}, ошибок: ${res.failed || 0}.`);
}

/**
 * Вопрос о дневном лимите. Движок кладёт запрос в storage и ждёт ответа —
 * панель показывает карточку с двумя кнопками. Карточка появляется только
 * тогда, когда лимит действительно упёрся, и висит до ответа: молчание
 * движок через 10 минут трактует как «стоп».
 */
function wireCapAsk() {
  const shown = new Set();
  const render = (ask) => {
    if (!ask || !ask.id || shown.has(ask.id)) return;
    shown.add(ask.id);
    const m = $("messages");
    const card = document.createElement("div");
    card.className = "prog";
    card.innerHTML = `
      <div class="ph">⏱ ${esc(I18N.t("cap_title", "Дневной лимит"))}</div>
      <div class="plog">${esc(I18N.t("cap_body",
        "Сделано " + ask.done + " из " + ask.cap + " действий за сегодня. " +
        "Это наша собственная норма Safe Mode, а не запрет Threads — " +
        "решение за вами. Продолжим ещё " + ask.step + " действий?"))}</div>
      <div class="dm-actions">
        <button class="ok">${esc(I18N.t("cap_go", "Продолжаем"))}</button>
        <button class="halt">${esc(I18N.t("cap_stop", "На сегодня хватит"))}</button>
      </div>`;
    m.appendChild(card); m.scrollTop = m.scrollHeight;
    const answer = (v, txt) => {
      card.querySelector(".dm-actions").textContent = txt;
      chrome.storage.local.set({ _capAnswer: { id: ask.id, answer: v } });
    };
    card.querySelector(".ok").onclick = () =>
      answer("go", "▶ " + I18N.t("cap_going", "продолжаю…"));
    card.querySelector(".halt").onclick = () =>
      answer("stop", "■ " + I18N.t("cap_stopped", "остановлено"));
  };
  chrome.storage.local.get("_capAsk").then((g) => render(g._capAsk));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch._capAsk) render(ch._capAsk.newValue);
  });
}
wireCapAsk();

// карточка одобрения ответа в директе → возвращает 'approve'|'skip'|<edited>
function askApproveDM(conv, suggested, last) {
  return new Promise((resolve) => {
    const m = $("messages");
    const card = document.createElement("div");
    card.className = "prog";
    card.innerHTML = `
      <div class="ph">✉️ ${esc(conv.name || "Диалог")}</div>
      <div class="plog">Последнее: «${esc((last || "").slice(0, 160))}»</div>
      <textarea class="dm-edit">${esc(suggested)}</textarea>
      <div class="dm-actions">
        <button class="ok">${esc(I18N.t("dm_send", "Отправить"))}</button>
        <button class="skip">${esc(I18N.t("dm_skip", "Пропустить"))}</button>
        <button class="halt">${esc(I18N.t("dm_stop", "Остановить"))}</button>
      </div>`;
    m.appendChild(card); m.scrollTop = m.scrollHeight;
    const ta = card.querySelector(".dm-edit");
    const close = (txt) => { card.querySelector(".dm-actions").textContent = txt; };
    card.querySelector(".ok").onclick = () => {
      close("✔ " + I18N.t("dm_sending", "отправляю…"));
      resolve(ta.value.trim() || suggested);
    };
    // Пропуск теперь запоминается на сутки — раньше тот же диалог
    // открывался снова при следующем запуске.
    card.querySelector(".skip").onclick = () => {
      close("⏭ " + I18N.t("dm_skipped", "пропущено — сутки не вернусь"));
      resolve("skip");
    };
    card.querySelector(".halt").onclick = () => {
      close("■ " + I18N.t("dm_stopped", "остановлено"));
      resolve("stop");
    };
  });
}

/* ---------------- ПОСТ С МЕДИА (скрепка + расписание) ---------------- */
function openPostModal() {
  $("postModal").classList.remove("hidden");
  renderPlanned();          // список запланированного обновляем при каждом открытии
}
function closePostModal() { $("postModal").classList.add("hidden"); }
let postFile = null;

/* ---------------- ПЛАНИРОВЩИК ПОСТОВ ---------------- */
let postMode = "auto";          // как публиковать запланированное

/** Момент публикации по выбранному слоту. Точное время — из полей формы. */
function plannedAt(slot) {
  if (slot === "now") return Date.now();
  if (slot === "exact") {
    const d = $("p_date").value, t = $("p_time").value;
    if (!d || !t) return null;
    const at = new Date(`${d}T${t}`).getTime();
    return Number.isFinite(at) ? at : null;
  }
  const H = { morning: 9, day: 14, evening: 19, night: 23 }[slot] ?? 9;
  const conf = settings?.schedule?.[slot]?.time;
  const [hh, mm] = (conf || `${String(H).padStart(2, "0")}:00`).split(":");
  const at = new Date();
  at.setHours(+hh || H, +mm || 0, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(ts); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const dayName = diff === 0 ? I18N.t("plan_today", "сегодня")
                : diff === 1 ? I18N.t("plan_tomorrow", "завтра")
                : d.toLocaleDateString(I18N.lang() === "en" ? "en-GB" : "ru-RU",
                                       { day: "2-digit", month: "2-digit" });
  return `${dayName} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderPlanned() {
  const box = $("p_plan");
  if (!box) return;
  const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
  const list = scheduled_posts.slice().sort((a, b) => a.at - b.at);
  $("p_planCount").textContent = String(list.length);
  box.innerHTML = list.length
    ? list.map((p) => `
      <div class="pitem" data-id="${esc(p.id)}">
        <div class="pw">🕒 <b>${esc(fmtWhen(p.at))}</b>
          <span class="pm2">${p.mode === "manual" ? I18N.t("post_mode_manual", "Вручную")
                                                  : I18N.t("post_mode_auto", "Авто")}</span></div>
        <div class="ptx">${esc((p.text || "").slice(0, 180))}</div>
        <div class="pa">
          <button class="pnow">${esc(I18N.t("plan_now", "Опубликовать сейчас"))}</button>
          <button class="pdel">${esc(I18N.t("plan_del", "Убрать"))}</button>
        </div>
      </div>`).join("")
    : `<div class="empty">${esc(I18N.t("plan_empty", "Пока ничего не запланировано."))}</div>`;

  box.querySelectorAll(".pdel").forEach((b) => b.addEventListener("click", async () => {
    await sw({ type: "UNSCHEDULE_POST", id: b.closest(".pitem").dataset.id });
    renderPlanned();
  }));
  box.querySelectorAll(".pnow").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".pitem").dataset.id;
    b.disabled = true;
    const r = await sw({ type: "PUBLISH_NOW", id });
    renderPlanned();
    botMsg(r?.ok ? I18N.t("plan_published", "Опубликовано ✅")
                 : (r?.error || I18N.t("plan_failed", "Не получилось опубликовать")));
  }));
}

/** Несколько коротких вариантов поста — человек выбирает, а не правит с нуля. */
async function suggestPostIdeas() {
  const btn = $("p_ideas"), box = $("p_ideaList");
  const seed = $("p_text").value.trim();
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = I18N.t("post_ideas_busy", "Придумываю…");
  try {
    const en = I18N.lang() === "en";
    const prompt =
      (en ? "Write 4 different short posts for Threads" : "Напиши 4 разных коротких поста для Threads") +
      `. ${en ? "Niche" : "Ниша"}: ${settings.niche || "—"}. ` +
      `${en ? "Brand" : "Бренд"}: ${settings.brandName || "—"}. ` +
      (seed ? `${en ? "Topic" : "Тема"}: ${seed}. ` : "") +
      (en
        ? "Each 1–3 sentences, lively, ending in something worth replying to. No hashtags, no quotes. Answer in English. Return a JSON array of strings and nothing else."
        : "Каждый 1–3 предложения, живой, заканчивается тем, на что хочется ответить. Без хэштегов и кавычек. Ответь по-русски. Верни JSON-массив строк и ничего больше.");
    const raw = await chat([{ role: "user", content: prompt }], { temperature: 0.95 });
    let ideas = [];
    const m = String(raw || "").match(/\[[\s\S]*\]/);
    if (m) { try { ideas = JSON.parse(m[0]); } catch { /* разберём построчно */ } }
    if (!ideas.length) {
      ideas = String(raw || "").split(/\n{2,}|\n\s*[-–•\d]+[.)]\s*/)
        .map((x) => x.trim()).filter((x) => x.length > 15).slice(0, 4);
    }
    ideas = ideas.map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
    if (!ideas.length) throw new Error(I18N.t("post_ideas_fail", "модель не вернула варианты"));
    box.innerHTML = ideas.map((x) => `<button>${esc(x)}</button>`).join("");
    box.classList.remove("hidden");
    box.querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => {
      $("p_text").value = ideas[i];
      box.classList.add("hidden");
    }));
  } catch (e) {
    errMsg(e.message || String(e));
  } finally {
    btn.disabled = false; btn.textContent = was;
  }
}

async function publishPost(draftOnly) {
  const text = $("p_text").value.trim();
  if (!text) { $("p_text").focus(); return; }
  const slot = $("p_slot").value;

  if (slot !== "now") {
    const at = plannedAt(slot);
    if (!at) { errMsg(I18N.t("plan_need_time", "Укажите дату и время публикации.")); return; }
    if (at <= Date.now()) { errMsg(I18N.t("plan_past", "Это время уже прошло.")); return; }
    await sw({ type: "SCHEDULE_POST", text, file: postFile, slot, at, mode: postMode });
    botMsg(`${I18N.t("plan_ok", "Пост запланирован:")} ${fmtWhen(at)} · ` +
           (postMode === "manual" ? I18N.t("post_mode_manual", "Вручную")
                                  : I18N.t("post_mode_auto", "Авто")) + ". " +
           I18N.t("plan_note", "Chrome должен быть открыт с вкладкой Threads в это время."));
    resetPostForm(); renderPlanned();
    return;
  }

  closePostModal();
  const c = busyCard(I18N.t("post_busy", "Публикую пост") + (postFile ? " …" : ""));
  const mode = draftOnly || postMode === "manual" ? "review" : "auto";
  const r = await T.createPostWithMedia(text, postFile, mode);
  c.done();
  if (!r.ok) return errMsg(r.error || "не удалось");
  botMsg(r.sent
    ? I18N.t("post_done", "Пост опубликован ✅")
    : I18N.t("post_draft_done", "Черновик вставлен в композер — проверьте и опубликуйте.") +
      (r.attached ? " " + I18N.t("post_attached", "Вложение добавлено.") : ""));
  resetPostForm();
}

function resetPostForm() {
  $("p_text").value = ""; $("p_file").value = ""; postFile = null;
  $("p_fileName").textContent = "";
  $("p_ideaList")?.classList.add("hidden");
}

/* ---------------- КЛИЕНТЫ ---------------- */
async function renderLeads() {
  const { threads_leads = [] } = await chrome.storage.local.get("threads_leads");
  $("leads").innerHTML = threads_leads.length
    ? threads_leads.map((p) => `
      <div class="item">
        <div class="top"><span class="au">@${esc(p.author)}</span><span class="sc">${p.score || 0}</span></div>
        <div class="rs">${esc(p.reason || "")}${p.angle ? " · заход: " + esc(p.angle) : ""}</div>
        <div class="tx">${esc((p.text || "").slice(0, 220))}</div>
        <div class="row"><a href="${esc(p.permalink)}" target="_blank">Открыть пост ↗</a>
          <button data-code="${esc(p.code)}" class="gc">💬 Коммент</button></div>
      </div>`).join("")
    : '<div class="empty">Клиентов пока нет.<br>Скажи в чате «найди клиентов» или запусти охотника.</div>';
  $("leads").querySelectorAll(".gc").forEach((b) =>
    b.addEventListener("click", () => genLeadComment(b.dataset.code)));
}

/**
 * «💬 Коммент» у клиента.
 *
 * Раньше кнопка только печатала черновик в чат — с припиской «открой пост и
 * вставь вручную». Для пользователя это выглядело как «кнопка не работает».
 * Теперь она делает всю работу: генерирует текст, открывает пост и вставляет
 * комментарий; в режиме «авто» ещё и отправляет.
 */
async function genLeadComment(code) {
  const { threads_leads = [] } = await chrome.storage.local.get("threads_leads");
  const lead = threads_leads.find((x) => String(x.code) === String(code));
  if (!lead) { errMsg("Клиент не найден — обнови список."); return; }
  const c = busyCard("Комментарий для @" + lead.author);
  try {
    const s = await getSettings();
    const prompt = s.hunterCommentPrompt
      .replace(/\{brandName\}/g, s.brandName).replace(/\{brand\}/g, s.brand)
      .replace(/\{author\}/g, lead.author).replace(/\{post\}/g, lead.text)
      .replace(/\{angle\}/g, lead.angle || "");
    c.log("Генерирую текст…");
    const draft = await chat([{ role: "user", content: prompt }], { temperature: 0.8 });
    const text = T.fitLeadComment(draft, s);
    c.log(`Текст: «${text}»`);

    const mode = s.commentMode === "manual" ? "manual" : "auto";
    c.log(mode === "auto" ? "Открываю пост и отправляю…" : "Открываю пост и вставляю черновик…");
    const r = await T.commentOnLead(lead, text, mode, (m) => c.log(m));

    if (r.ok && r.sent) {
      c.log("Отправлено ✅");
      botMsg(`💬 Комментарий для @${lead.author} отправлен:\n${text}`);
    } else if (r.ok) {
      c.log("Черновик вставлен — подтверди в окне Threads.");
      botMsg(`📝 Черновик для @${lead.author} вставлен в пост:\n${text}`);
    } else {
      c.log("Не вышло: " + (r.error || "?"));
      botMsg(`Не удалось прокомментировать @${lead.author}: ${r.error || "неизвестная ошибка"}\n\n` +
             `Текст, если захочешь вставить вручную:\n${text}`);
    }
    c.done();
  } catch (e) { errMsg(e.message); }
}


/* ---------------- ПЕРВЫЙ ЗАПУСК: ключ → язык ---------------- */
function showOnboarding(step) {
  const box = $("onb");
  if (!box) return;
  box.classList.remove("hidden");
  [1, 2, 3].forEach((n) => $("onb" + n)?.classList.toggle("hidden", step !== n));
}

function hideOnboarding() {
  $("onb")?.classList.add("hidden");
  emptyChat();
}

function wireOnboarding() {
  const go = $("onb_go");
  if (go) {
    go.addEventListener("click", connectFromOnboarding);
    ["onb_id", "onb_key"].forEach((id) =>
      $(id)?.addEventListener("keydown", (e) => { if (e.key === "Enter") connectFromOnboarding(); }));
  }
  document.querySelectorAll(".onb-lang").forEach((b) =>
    b.addEventListener("click", async () => {
      await applyLang(b.dataset.l);
      // Памятка идёт третьим шагом и уже на выбранном языке —
      // до выбора её показывать было бы не на чем.
      showOnboarding(3);
    }));
  $("onb_done")?.addEventListener("click", hideOnboarding);

  // Кнопка языка в шапке — переключение в одно нажатие в любой момент.
  const lb = $("langBtn");
  if (lb) {
    lb.textContent = I18N.lang().toUpperCase();
    lb.addEventListener("click", async () => {
      await applyLang(I18N.lang() === "ru" ? "en" : "ru");
    });
  }
}

async function applyLang(l) {
  await I18N.set(l);
  I18N.apply();                       // включая памятку третьего шага
  const lb = $("langBtn");
  if (lb) lb.textContent = I18N.lang().toUpperCase();
  renderPosts();
  renderModeHint();
}

async function connectFromOnboarding() {
  const err = $("onb_err");
  const id = $("onb_id").value.trim();
  const key = $("onb_key").value.trim();
  err.textContent = "";
  if (!id || !key) {
    err.textContent = "Заполните оба поля · Fill in both fields";
    return;
  }
  const btn = $("onb_go");
  btn.disabled = true;
  btn.textContent = "Проверяю · Checking…";
  try {
    const url = (settings.backendUrl || "https://ai-threads.vip").replace(/\/+$/, "");
    const r = await fetch(url + "/api/ext/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: Number(id) || id, key }),
    });
    const j = await r.json();
    if (!r.ok || !j.token) throw new Error(j.detail || "неверные ID или ключ · wrong ID or key");
    await sw({ type: "SET_SETTINGS", patch: {
      backendUrl: url, tgUserId: id, pin: key, apiToken: j.token,
      plan: j.plan, gensLeft: j.gens_left, commercialMode: true } });
    settings = await getSettings();
    // Язык, выбранный в боте, предлагаем сразу — но шаг выбора всё равно
    // показываем: человек может хотеть в расширении другой.
    if (j.lang === "ru" || j.lang === "en") {
      document.querySelectorAll(".onb-lang").forEach((b) =>
        b.classList.toggle("suggested", b.dataset.l === j.lang));
    }
    showOnboarding(2);
  } catch (e) {
    let m = e.message || String(e);
    if (/Failed to fetch|NetworkError|load failed/i.test(m)) {
      m = "Сервер недоступен · Server unreachable";
    }
    err.textContent = "✖ " + m;
  } finally {
    btn.disabled = false;
    btn.textContent = "Продолжить · Continue";
  }
}

function renderModeHint() {
  const el = $("modeHint");
  if (!el) return;
  const manual = settings?.commentMode === "manual";
  const k = manual ? "mode_hint_manual" : "mode_hint_auto";
  el.setAttribute("data-i18n", k);
  el.textContent = I18N.t(k, el.textContent);
}

/* ---------------- ТАБЛИЦА ПОСТОВ (viral) ---------------- */
let onlyViral = false, sortBy = "engagement";
async function renderPosts() {
  const { threads_posts = [] } = await chrome.storage.local.get("threads_posts");
  let posts = threads_posts.slice();
  const med = median(posts.map((p) => p.engagement || 0));
  const viralThreshold = Math.max(med * 3, 50);

  // Три показателя, по которым видно не просто «много лайков», а что
  // именно сработало: во сколько раз пост обошёл медиану ниши, насколько
  // охотно под ним пишут и насколько его разносят дальше.
  posts.forEach((p) => {
    const e = p.engagement || 0;
    p._viral = e >= viralThreshold;
    p._x = med > 0 ? e / med : 0;                       // во сколько раз выше медианы
    p._talk = e > 0 ? (p.comments || 0) / e : 0;        // доля обсуждения
    p._spread = e > 0 ? ((p.reposts || 0) + (p.shares || 0)) / e : 0;
  });

  if (onlyViral) posts = posts.filter((p) => p._viral);
  const key = { talk: "_talk", spread: "_spread" }[sortBy] || sortBy;
  posts.sort((a, b) => (b[key] || 0) - (a[key] || 0));
  posts = posts.slice(0, 200);

  const st = $("postStats");
  if (st) {
    const viralCount = threads_posts.filter((x) => (x.engagement || 0) >= viralThreshold).length;
    st.innerHTML = threads_posts.length
      ? `<span>${I18N.t("ps_total", "всего")} <b>${threads_posts.length}</b></span>` +
        `<span>${I18N.t("ps_viral", "залетевших")} <b>${viralCount}</b></span>` +
        `<span>${I18N.t("ps_median", "медиана")} <b>${Math.round(med)}</b></span>`
      : "";
  }

  const T_ = (k, d) => I18N.t(k, d);
  $("posts").innerHTML = posts.length
    ? posts.map((p) => `
      <div class="prow ${p._viral ? "viral" : ""}">
        <span class="au">@${esc(p.author)}${p._viral ? " 🔥" : ""}${
          p._x >= 2 ? `<i class="xmul">×${p._x.toFixed(1)}</i>` : ""}</span>
        <div class="m"><span>♥ <b>${p.likes || 0}</b></span><span>💬 <b>${p.comments || 0}</b></span>
          <span>🔁 <b>${p.reposts || 0}</b></span><span>✈ <b>${p.shares || 0}</b></span></div>
        <div class="bars">
          <span title="${esc(T_("ps_talk_t", "доля обсуждения"))}">${T_("ps_talk", "обсуждение")}
            <i style="width:${Math.min(100, Math.round(p._talk * 300))}%"></i></span>
          <span title="${esc(T_("ps_spread_t", "репосты и пересылки"))}">${T_("ps_spread", "разлёт")}
            <i style="width:${Math.min(100, Math.round(p._spread * 300))}%"></i></span>
        </div>
        <div class="tx">${esc((p.text || "").slice(0, 220))}</div>
        <div class="row">
          <a href="${esc(p.permalink)}" target="_blank" rel="noopener">${T_("ps_open", "Открыть ↗")}</a>
          <button data-code="${esc(p.code)}" class="rw">${T_("ps_rewrite", "✍ Переписать под меня")}</button>
          <button data-code="${esc(p.code)}" class="cm">${T_("ps_comment", "💬 Прокомментировать")}</button>
          <button data-code="${esc(p.code)}" class="dm">${T_("ps_dm", "✉ Написать в директ")}</button>
        </div>
      </div>`).join("")
    : `<div class="empty">${T_("ps_empty", "Постов нет.<br>Скажи «спарси ленту» или нажми 🔎 на панели Threads.")}</div>`;

  $("posts").querySelectorAll(".rw").forEach((b) =>
    b.addEventListener("click", () => rewritePost(b.dataset.code)));
  $("posts").querySelectorAll(".cm").forEach((b) =>
    b.addEventListener("click", () => commentOnPost(b.dataset.code)));
  $("posts").querySelectorAll(".dm").forEach((b) =>
    b.addEventListener("click", () => dmPostAuthor(b.dataset.code)));
}

/** Найти пост в хранилище по коду. */
async function postByCode(code) {
  const { threads_posts = [] } = await chrome.storage.local.get("threads_posts");
  return threads_posts.find((x) => x.code === code) || null;
}

/**
 * Комментарий под чужой веткой прямо из таблицы постов.
 * В ручном режиме текст показывается в чате и отправляется только
 * после подтверждения — так же, как в очереди.
 */
async function commentOnPost(code) {
  const p = await postByCode(code);
  if (!p) return;
  switchTab("chat");
  const c = busyCard(I18N.t("act_comment_busy", "Готовлю комментарий к ветке"));
  try {
    const draft = await T.commentFor(p);
    const text = T.fitLeadComment(draft, settings);
    c.done();
    const manual = settings?.commentMode === "manual";
    if (manual) {
      const ok = await confirmText(I18N.t("act_comment_confirm", "Отправить этот комментарий?"), text);
      if (!ok) { botMsg(I18N.t("act_cancelled", "Отменено.")); return; }
    }
    const r = await T.commentOnLead({ ...p, permalink: p.permalink, code: p.code },
                                    text, manual ? "draft" : "auto");
    if (r.ok && r.sent) botMsg(I18N.t("act_comment_sent", "Комментарий отправлен:") + "\n\n" + text);
    else if (r.ok) botMsg(I18N.t("act_comment_draft", "Комментарий вставлен — подтвердите отправку в Threads."));
    else errMsg(r.error || "не получилось");
  } catch (e) { c.done?.(); errMsg(e.message || String(e)); }
}

/** Открыть переписку с автором поста и подготовить первое сообщение. */
async function dmPostAuthor(code) {
  const p = await postByCode(code);
  if (!p?.author) return;
  switchTab("chat");
  const c = busyCard(I18N.t("act_dm_busy", "Открываю Директ и готовлю сообщение"));
  try {
    const r = await T.dmToAuthor(p, settings?.commentMode !== "manual");
    c.done();
    if (r.ok && r.sent) botMsg(I18N.t("act_dm_sent", "Отправлено в директ:") + "\n\n" + r.text);
    else if (r.ok) botMsg(I18N.t("act_dm_draft", "Текст вставлен в переписку — отправьте вручную:") + "\n\n" + r.text);
    else errMsg(r.error || "не получилось");
  } catch (e) { c.done?.(); errMsg(e.message || String(e)); }
}

/** Показать текст и дождаться «Отправить» / «Отмена». */
function confirmText(title, text) {
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "msg bot confirm";
    box.innerHTML = `<div class="ct">${esc(title)}</div><div class="cx">${esc(text)}</div>
      <div class="cb"><button class="ok">${esc(I18N.t("act_send", "Отправить"))}</button>
      <button class="no">${esc(I18N.t("act_cancel", "Отмена"))}</button></div>`;
    $("messages").appendChild(box);
    $("messages").scrollTop = $("messages").scrollHeight;
    box.querySelector(".ok").onclick = () => { box.remove(); resolve(true); };
    box.querySelector(".no").onclick = () => { box.remove(); resolve(false); };
  });
}

async function rewritePost(code) {
  const { threads_posts = [] } = await chrome.storage.local.get("threads_posts");
  const p = threads_posts.find((x) => x.code === code);
  if (!p) return;
  $("messages") && switchTab("chat");
  const c = busyCard("Переписываю залетевший пост под тебя");
  try {
    const r = await T.rewriteLikeViral(p, "");
    c.done();
    botMsg(`Новый пост в твоём стиле (по образцу ♥${p.likes} 💬${p.comments}):\n\n${r.text}`);
  } catch (e) { errMsg(e.message); }
}

function median(arr) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

/* ---------------- ОБЩЕЕ / WIRING ---------------- */
const TABS = ["chat", "leads", "queue", "posts", "work", "health", "log"];
function switchTab(tab) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  TABS.forEach((t) => $("view-" + t)?.classList.toggle("hidden", t !== tab));
  if (tab === "queue") renderQueue();
  if (tab === "work") renderWork();
  if (tab === "health") renderHealth();
  if (tab === "log") renderDiag();
}

/* ---------------- РАБОТА ----------------
   Кнопки не повторяют логику движка, а вызывают те же обработчики в
   content script (RPC_PANEL_ACT). Копия разошлась бы с оригиналом на
   первой же правке, и разошлась бы молча — здесь это невозможно. */
/* Панель работает в двух местах: боковой панелью на компьютере (отдельный
   контекст) и в iframe нижней шторки на телефоне (внутри самой страницы
   Threads). Это разные адресаты, и путь до них разный.

   Раньше был один путь — chrome.tabs.sendMessage по вкладке, найденной
   поиском среди ВСЕХ открытых. На телефоне с несколькими вкладками Threads
   он попадал в старую усыплённую: content script там не поднят, ответа нет,
   и панель писала «Страница Threads не отвечает» — при живой странице прямо
   под собой. Ни одна кнопка «Работы» из-за этого не срабатывала. */
const EMBEDDED = (() => { try { return window.parent !== window; } catch { return false; } })();

let actSeq = 0;
const actWaiters = new Map();
if (EMBEDDED) {
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__aithreads !== "PANEL_ACT_RESULT") return;
    const w = actWaiters.get(d.id);
    if (w) { actWaiters.delete(d.id); w(d.res); }
  });
}

/** Команда странице-хозяину. Адресата выбирать не нужно — он один. */
function actViaHost(action) {
  return new Promise((res) => {
    const id = ++actSeq;
    actWaiters.set(id, res);
    try { window.parent.postMessage({ __aithreads: "PANEL_ACT", id, action }, "*"); }
    catch { actWaiters.delete(id); res(null); }
    setTimeout(() => { if (actWaiters.delete(id)) res(null); }, 20000);
  });
}

async function workAct(action, btn) {
  if (btn) btn.disabled = true;
  try {
    let r;
    if (EMBEDDED) {
      r = await actViaHost(action);
    } else {
      const tab = await activeThreadsTab();
      if (!tab) {
        pushLog({ msg: "Откройте вкладку threads.com — работать не с чем.", kind: "err" });
        return;
      }
      r = await new Promise((res) => {
        chrome.tabs.sendMessage(tab.id, { type: "RPC_PANEL_ACT", action }, (x) => {
          void chrome.runtime.lastError; res(x || null);
        });
      });
    }
    if (!r) {
      pushLog({ msg: "Страница Threads не отвечает — обновите её и повторите.", kind: "err" });
    } else if (r.ok === false) {
      pushLog({ msg: "✕ " + (r.error || "не выполнилось"), kind: "err" });
    }
  } finally {
    if (btn) btn.disabled = false;
    renderWork();
  }
}

/* Запасной выбор вкладки для компьютера. Первая попавшаяся из
   chrome.tabs.query({}) — плохой адресат: список не упорядочен, а
   выгруженная браузером вкладка выглядит в нём как обычная, хотя
   content script там не поднят. */
async function bestThreadsTab() {
  const isT = (t) => /https:\/\/([a-z0-9-]+\.)?threads\.(com|net)\//i.test(t.url || "");
  const all = (await chrome.tabs.query({})).filter(isT);
  if (!all.length) return null;
  const live = all.filter((t) => !t.discarded && t.status !== "unloaded");
  const pool = live.length ? live : all;
  return pool.find((t) => t.active) || pool[0];
}

async function renderWork() {
  const engine = await askEngine();
  const { settings: st } = await sw({ type: "GET_SETTINGS" });
  const mode = engine.running ? engine.mode : (st?.commentMode || "auto");
  document.querySelectorAll("[data-wmode]").forEach((b) =>
    b.classList.toggle("on", b.dataset.wmode === mode));
  const hint = $("workModeHint");
  if (hint) hint.textContent = mode === "auto"
    ? "Авто: сам находит посты, пишет и отправляет."
    : "Вручную: находит и пишет, отправка — после подтверждения во вкладке «Очередь».";
  const run = $("wComment");
  if (run) {
    run.textContent = engine.running ? "⏹ Остановить комментинг" : "▶ Запустить комментинг";
    run.classList.toggle("on", !!engine.running);
  }
  const s = engine.stats || {};
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v || 0; };
  set("wSeen", s.seen); set("wGen", s.generated); set("wSent", s.sent);
}

/** Копирование с двумя запасными путями. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  // Старый execCommand работает там, где Clipboard API закрыт политикой
  // iframe, — а это ровно наш случай на телефоне.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch {}
  return false;
}

/** Последний рубеж: показать текст готовым к выделению. */
function showCopyFallback(text) {
  const box = $("logBox");
  if (!box) return;
  const wrap = document.createElement("div");
  wrap.className = "copyfall";
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  const hint = document.createElement("p");
  hint.className = "whint";
  hint.textContent = "Браузер закрыл доступ к буферу. Текст уже выделен — "
    + "долгое нажатие → «Копировать».";
  const close = document.createElement("button");
  close.className = "mini";
  close.textContent = "Убрать";
  close.addEventListener("click", () => wrap.remove());
  wrap.append(hint, ta, close);
  box.prepend(wrap);
  ta.focus();
  ta.select();
  try { ta.setSelectionRange(0, text.length); } catch {}
}

/* ---------------- ДИАГНОСТИКА ЦЕПОЧКИ ----------------
   Шесть стадий, через которые проходит каждый комментарий. Таблица
   отвечает на единственный вопрос: где теряются попытки. «Дошло» —
   сколько попыток добралось до стадии, «сорвалось» — сколько на ней
   и закончилось. */
const STAGE_RU = {
  post:    "Пост найден",
  target:  "Есть куда отвечать",
  field:   "Поле открылось",
  input:   "Текст вставлен",
  submit:  "Отправка нажата",
  confirm: "Подтверждено",
};
const REASON_RU = {
  POST_NOT_FOUND:         "карточка поста не отрисовалась",
  CONTAINER_MISSING:      "не нашлась карточка поста",
  REPLY_TARGET_NOT_FOUND: "нет цели ответа — вёрстка ветки другая",
  FIELD_NOT_FOUND:        "поле ответа не появилось",
  FIELD_LOST:             "поле исчезло во время ввода",
  INPUT_REJECTED:         "редактор не принял ни один способ ввода",
  NAV_LOST:               "страница ушла из-под ног",
  SUBMIT_NOT_FOUND:       "не нашлась кнопка отправки",
  SUBMIT_UNCONFIRMED:     "отправка не подтвердилась",
  RISKY_CONSUMED:         "текст ушёл без подтверждения (повтор запрещён)",
};

async function renderDiag() {
  const box = $("diagBox");
  if (!box) return;
  const { _diag: d } = await chrome.storage.local.get("_diag");
  if (!d || !d.attempts) {
    box.innerHTML = '<p class="whint">Пока нет ни одной попытки комментирования. '
      + 'Запустите комментинг — здесь появится, на какой стадии теряются посты.</p>';
    return;
  }
  const rows = ["post", "target", "field", "input", "submit", "confirm"].map((s) => {
    const st = d.stages[s] || { reached: 0, lost: 0 };
    return `<tr><td>${STAGE_RU[s]}</td><td>${st.reached}</td>`
         + `<td class="${st.lost ? "bad" : ""}">${st.lost || ""}</td></tr>`;
  }).join("");
  const reasons = Object.entries(d.reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li><b>${n}</b> — ${REASON_RU[k] || k}</li>`).join("");
  const pct = Math.round((d.sent / d.attempts) * 100);
  box.innerHTML =
    `<div class="diaghead">Попыток ${d.attempts} · отправлено ${d.sent} (${pct}%)</div>`
    + `<table class="diagtable"><thead><tr><th>Стадия</th><th>дошло</th><th>сорвалось</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + (reasons ? `<div class="diaghead">Причины отказов</div><ul class="diaglist">${reasons}</ul>` : "");
}

/* ---------------- ЛОГИ ----------------
   Единый поток: строки движка приходят из content script, строки панели
   пишутся здесь же. Раньше лог жил только в плавающем окне, а на телефоне
   его нет — и вся диагностика пропадала молча. */
const LOG = [];
function pushLog(line) {
  LOG.push({ ...line, at: line.at || Date.now() });
  while (LOG.length > 400) LOG.shift();
  const box = $("logBox");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "logline " + (line.kind || "");
  el.textContent = "[" + new Date(line.at || Date.now()).toLocaleTimeString().slice(0, 8) + "] " + line.msg;
  box.appendChild(el);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  const badge = document.querySelector('.tabs button[data-tab="log"]');
  if (badge && $("view-log")?.classList.contains("hidden") && line.kind === "err") {
    badge.classList.add("hasErr");
  }
}

function renderHunterSteppers() {
  ["hypotheses", "threadsPerQuery", "feedTarget", "freshnessHours",
   "minLikes", "minReplies", "keepBest"].forEach((k) => {
    const el = $("h_" + k); if (el) el.textContent = hunterCfg[k] ?? 0;
  });
  const uf = $("h_useFeed");
  if (uf) uf.checked = hunterCfg.useFeed !== false;
}
function openHunter() { $("h_product").value = hunterCfg.product || ""; $("hunter").classList.remove("hidden"); }
function closeHunter() { $("hunter").classList.add("hidden"); }

function wire() {
  $("send").addEventListener("click", onSend);
  const input = $("input");
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } });
  $("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      b.classList.remove("hasErr");
      switchTab(b.dataset.tab);
    }));

  // ── Работа ──
  document.querySelectorAll("#view-work [data-act]").forEach((b) =>
    b.addEventListener("click", () => workAct(b.dataset.act, b)));
  document.querySelectorAll("[data-wmode]").forEach((b) =>
    b.addEventListener("click", () => workAct("mode-" + b.dataset.wmode, b)));

  // ── Логи ──
  $("logClear")?.addEventListener("click", () => { LOG.length = 0; $("logBox").innerHTML = ""; });
  $("healthRefresh")?.addEventListener("click", () => renderHealth());
  // Счётчики отдельно от лога: лог чистят часто, а статистику копят
  // неделями — сбрасывать её заодно означало бы терять её каждый раз.
  $("diagReset")?.addEventListener("click", async () => {
    await chrome.storage.local.remove("_diag");
    renderDiag();
    pushLog({ msg: "Счётчики диагностики сброшены.", kind: "ok" });
  });
  $("logCopy")?.addEventListener("click", async () => {
    const { _diag: d } = await chrome.storage.local.get("_diag");
    const head = d?.attempts
      ? "ДИАГНОСТИКА: попыток " + d.attempts + ", отправлено " + d.sent + "\n"
        + Object.entries(d.stages || {}).map(([s, v]) => `  ${s}: дошло ${v.reached}, сорвалось ${v.lost}`).join("\n")
        + "\nПричины: " + Object.entries(d.reasons || {}).map(([k, n]) => `${k}=${n}`).join(", ")
        + "\nПоследние: " + (d.last || []).map((l) => `${l.ok ? "ok" : l.fail}@${l.stage}`).join(", ")
        + "\n\n"
      : "";
    const text = head + LOG.map((l) => "[" + new Date(l.at).toLocaleTimeString().slice(0, 8) + "] " + l.msg).join("\n");
    // navigator.clipboard в iframe на мобильных браузерах часто закрыт
    // политикой. Раньше на этом всё и заканчивалось: «выделите вручную» —
    // а выделить лог пальцем в прокручивающемся блоке практически нельзя,
    // то есть диагностику было физически не достать.
    if (await copyText(text)) {
      pushLog({ msg: "Лог скопирован — можно прислать в /support.", kind: "ok" });
    } else {
      showCopyFallback(text);
    }
  });

  // Строки движка приходят из content script и попадают в тот же поток.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "LOG_LINE" && msg.line) pushLog(msg.line);
  });

  $("onlyViral").addEventListener("change", (e) => { onlyViral = e.target.checked; renderPosts(); });
  $("sortBy").addEventListener("change", (e) => { sortBy = e.target.value; renderPosts(); });

  $("huntBtn").addEventListener("click", openHunter);
  $("huntClose").addEventListener("click", closeHunter);

  // Пост с медиа
  $("postBtn").addEventListener("click", openPostModal);
  $("postClose").addEventListener("click", closePostModal);
  $("postModal").addEventListener("click", (e) => { if (e.target.id === "postModal") closePostModal(); });
  $("p_file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) { postFile = null; $("p_fileName").textContent = ""; return; }
    $("p_fileName").textContent = f.name + " · " + Math.round(f.size / 1024) + "KB";
    const b64 = await fileToB64(f);
    postFile = { b64, name: f.name, mime: f.type };
  });
  $("p_publish").addEventListener("click", () => publishPost(false));
  $("p_draft").addEventListener("click", () => publishPost(true));
  $("p_ideas").addEventListener("click", suggestPostIdeas);
  $("p_slot").addEventListener("change", (e) => {
    const exact = e.target.value === "exact";
    $("p_exactRow").classList.toggle("hidden", !exact);
    if (exact && !$("p_date").value) {
      const d = new Date();
      $("p_date").value = d.toISOString().slice(0, 10);
      $("p_time").value = String(d.getHours() + 1).padStart(2, "0") + ":00";
    }
  });
  document.querySelectorAll("[data-pmode]").forEach((b) =>
    b.addEventListener("click", () => {
      postMode = b.dataset.pmode;
      document.querySelectorAll("[data-pmode]").forEach((x) =>
        x.classList.toggle("on", x === b));
      const k = postMode === "manual" ? "post_mode_hint_manual" : "post_mode_hint_auto";
      const h = $("p_modeHint");
      h.setAttribute("data-i18n", k);
      h.textContent = I18N.t(k, h.textContent);
    }));

  // Директ
  $("dmBtn").addEventListener("click", () => { switchTab("chat"); runDirectProgram(); });
  document.querySelectorAll(".stepper button").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.s, d = parseInt(b.dataset.d, 10);
      hunterCfg[k] = Math.max(0, (hunterCfg[k] || 0) + d);
      $("h_" + k).textContent = hunterCfg[k];
    }));
  $("huntPurge")?.addEventListener("click", async () => {
    const c = busyCard("Сброс броней");
    try {
      const r = await chrome.runtime.sendMessage({ type: "PURGE_CLAIMS", what: "all" });
      const n = r?.purged || 0;
      c.log(n ? `Снято броней и пауз: ${n} — эти лиды снова доступны.`
              : "Зависших броней не было.");
      c.log("Список уже прокомментированных постов не тронут: повторов не будет.");
    } catch (e) {
      c.log("Не вышло: " + (e.message || e));
    }
    c.done();
  });
  $("hunter").addEventListener("click", (e) => { if (e.target.id === "hunter") closeHunter(); });
  ["order", "lang"].forEach((k) => $("h_" + k)?.addEventListener("change", (e) => (hunterCfg[k] = e.target.value)));
  $("modelPick")?.addEventListener("change", async (e) => {
    settings.aiModel = e.target.value;
    await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { aiModel: e.target.value } });
    botMsg(e.target.value ? `Переключилась на модель: ${activeModelLabel()}` : "Вернулась на модель по умолчанию.");
  });

  $("h_useFeed")?.addEventListener("change", (e) => (hunterCfg.useFeed = e.target.checked));

  $("huntRun").addEventListener("click", async () => {
    hunterCfg.product = $("h_product").value.trim();
    hunterCfg.mode = (settings.commentMode === "manual") ? "manual" : "auto";
    if (!hunterCfg.product) { $("h_product").focus(); return; }
    await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { hunter: hunterCfg } });
    closeHunter(); switchTab("chat");
    runHunterProgram({ ...hunterCfg });
  });
}


/* ══════════════════════════════════════════════════════════
   ОЧЕРЕДЬ ПОДТВЕРЖДЕНИЯ (ручной режим)
   Движок кладёт сюда сгенерированные комментарии; отправка —
   только после нажатия «Отправить» здесь.
   ══════════════════════════════════════════════════════════ */
const sw = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => {
  void chrome.runtime.lastError;   // фон спит — это ответ, а не исключение
  r(x || {});
}));

/**
 * Состояние движка, которое всегда есть.
 *
 * Панель живёт и внутри шторки на телефоне, где фон — event page и
 * просыпается медленно. Ответ на ENGINE_GET мог прийти пустым, и вкладка
 * «Работа» тихо показывала «режим —», как будто движка нет вовсе.
 * Состояние целиком лежит в chrome.storage.local._engine, читаем оттуда.
 */
async function askEngine() {
  const r = await sw({ type: "ENGINE_GET" });
  if (r?.engine) return r.engine;
  try {
    const { _engine } = await chrome.storage.local.get("_engine");
    return { running: false, mode: "auto", stats: {}, ...(_engine || {}) };
  } catch {
    return { running: false, mode: "auto", stats: {} };
  }
}

async function activeThreadsTab() {
  return bestThreadsTab();
}

function wordCount(t) {
  return (t || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .trim().split(/\s+/).filter(Boolean).length;
}

const SLOT_LABEL_RU = { morning: "🌅 Утро", day: "☀️ День", evening: "🌆 Вечер", night: "🌙 Ночь" };
const REVIEW_STATUS_RU = { pending: "⏳ ждёт", send: "✅ отправлено", rewrite: "✏️ переписано",
  skip: "⏭ пропущено", expired: "⌛ истекло" };

async function renderHealth() {
  const statsBox = document.getElementById("healthStats");
  const reasonsBox = document.getElementById("healthReasons");
  const reviewsBox = document.getElementById("healthReviews");
  const queueBox = document.getElementById("healthQueue");
  if (!statsBox) return;
  statsBox.innerHTML = '<span class="empty">Загружаю…</span>';
  reasonsBox.innerHTML = "";
  reviewsBox.innerHTML = "";
  queueBox.innerHTML = "";

  const [{ data: h }, { items: reviews = [] }, { items: queue = [] }] = await Promise.all([
    sw({ type: "EXT_HEALTH", hours: 24 }),
    sw({ type: "EXT_REVIEW_HISTORY" }),
    sw({ type: "EXT_SCHEDULED_LIST" }),
  ]);

  if (!h) {
    statsBox.innerHTML =
      '<div class="empty">Кабинет не подключён.<br/>⚙️ → «Подключение», ID и ключ из бота.</div>';
    return;
  }

  const rate = h.rate == null ? "—" : h.rate + "%";
  statsBox.innerHTML = `
    <span>отправлено <b>${h.ok}</b></span>
    <span>провалов <b>${h.fail}</b></span>
    <span>успех <b>${rate}</b></span>
    <span>лидов <b>${h.leads}</b></span>
    <span>ответов <b>${h.replies}</b></span>`;

  const reasons = Object.entries(h.by_reason || {}).sort((a, b) => b[1] - a[1]);
  reasonsBox.innerHTML = reasons.length
    ? reasons.map(([r, n]) => `<div class="item"><span>${esc(r)}</span><b>${n}</b></div>`).join("")
    : '<div class="empty">За 24 часа провалов нет.</div>';

  reviewsBox.innerHTML = reviews.length
    ? reviews.slice(0, 10).map((r) => `<div class="item">
        <div class="top"><span class="au">@${esc(r.post_author || "")}</span>
          <span class="sc">${REVIEW_STATUS_RU[r.status] || esc(r.status)}</span></div>
        <div class="pend-src">${esc((r.draft_text || "").slice(0, 160))}</div>
      </div>`).join("")
    : '<div class="empty">Живой контроль ещё не запускался.</div>';

  queueBox.innerHTML = queue.length
    ? queue.map((q) => `<div class="item">
        <div class="top"><span class="au">${q.media_type === "video" ? "🎬" : "🖼"} ${SLOT_LABEL_RU[q.slot] || esc(q.slot)}</span></div>
        <div class="pend-src">${esc((q.caption || "без подписи").slice(0, 160))}</div>
      </div>`).join("")
    : '<div class="empty">Очередь пуста — пришлите фото/видео боту, чтобы поставить пост.</div>';
}

async function renderQueue() {
  const box = document.getElementById("queue");
  if (!box) return;
  const { list = [] } = await sw({ type: "PENDING_LIST" });
  const badge = document.getElementById("qBadge");
  if (badge) badge.textContent = list.length ? `(${list.length})` : "";

  if (!list.length) {
    box.innerHTML =
      '<div class="empty">Очередь пуста.<br/>Включи режим «Вручную» и запусти комментинг —<br/>' +
      "найденные посты появятся здесь на подтверждение.</div>";
    return;
  }

  box.innerHTML = list.map((it) => {
    const n = wordCount(it.text);
    return `<div class="item" data-code="${it.code}">
      <div class="top"><span class="au">@${esc(it.author || "")}</span>
        <span class="sc">${n} сл.</span></div>
      <div class="pend-src">${esc(it.post || "")}</div>
      <textarea class="pend-text" rows="2">${esc(it.text || "")}</textarea>
      <div class="wcount${n < 3 || n > 8 ? " bad" : ""}">слов: ${n}</div>
      <div class="row">
        <a href="${esc(it.permalink || "#")}" target="_blank">Открыть пост</a>
        <button data-act="skip">Пропустить</button>
        <button data-act="send" class="ok">Отправить</button>
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll(".pend-text").forEach((ta) => {
    ta.addEventListener("input", () => {
      const n = wordCount(ta.value);
      const c = ta.parentElement.querySelector(".wcount");
      c.textContent = "слов: " + n;
      c.classList.toggle("bad", n < 3 || n > 8);
    });
  });

  box.querySelectorAll("[data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const card = b.closest(".item");
      const code = card.dataset.code;
      if (b.dataset.act === "skip") {
        await sw({ type: "PENDING_REMOVE", code });
        return renderQueue();
      }
      const text = card.querySelector(".pend-text").value.trim();
      if (!text) return;
      const tab = await activeThreadsTab();
      if (!tab) { b.textContent = "нет вкладки Threads"; return; }
      b.textContent = "…"; b.disabled = true;

      // Пост почти никогда не открыт на текущей странице — раньше отправка
      // из очереди тихо не срабатывала именно поэтому. Сначала открываем
      // пермалинк и ждём загрузки, только потом просим вкладку ответить.
      const item = list.find((x) => x.code === code);
      const link = item && item.permalink;
      try {
        if (link) {
          await chrome.tabs.update(tab.id, { url: link });
          for (let i = 0; i < 40; i++) {
            const t = await chrome.tabs.get(tab.id).catch(() => null);
            if (t && t.status === "complete") break;
            await new Promise((r) => setTimeout(r, 400));
          }
          await new Promise((r) => setTimeout(r, 1800));
        }
      } catch {}

      chrome.tabs.sendMessage(tab.id, { type: "RPC_SEND_PENDING", code, text }, async (r) => {
        const err = chrome.runtime.lastError;
        if (!err && r?.ok) { await sw({ type: "PENDING_REMOVE", code }); renderQueue(); }
        else if (!err && r?.risky) {
          // Композер очистился без подтверждения: комментарий мог уйти.
          // Убираем из очереди — повтор создал бы дубль.
          await sw({ type: "PENDING_REMOVE", code });
          renderQueue();
        } else {
          b.disabled = false; b.textContent = "не вышло";
          card.querySelector(".wcount").textContent =
            (err && err.message) || r?.error || "страница не ответила — обнови вкладку Threads";
        }
      });
    });
  });
}

async function renderEngineStats() {
  const engine = await askEngine();
  const { settings: st } = await sw({ type: "GET_SETTINGS" });
  // «режим —» в шапке был следствием того же пустого ответа: строка
  // молча не рисовалась и выглядела как «движка нет».
  const mode = engine.running ? engine.mode : (st?.commentMode || "auto");
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("stMode", (mode === "manual" ? "вручную" : "авто") + (engine.running ? " · идёт" : ""));
  set("stSeen", engine.stats?.seen || 0);
  set("stSent", engine.stats?.sent || 0);
  document.querySelectorAll("[data-mode]").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === mode));
}

function wireQueue() {
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.addEventListener("click", async () => {
      const mode = b.dataset.mode;
      // Один переключатель на комментарии и на директ. Раньше режим
      // директа жил отдельным флагом в настройках, и человек, выбравший
      // «Вручную», всё равно получал автоматическую отправку в личку.
      const s0 = await getSettings();
      await sw({ type: "SET_SETTINGS", patch: {
        commentMode: mode,
        dm: { ...s0.dm, mode, approve: mode === "manual" },
      } });
      await sw({ type: "ENGINE_SET", patch: { mode } });
      settings = await getSettings();
      renderModeHint();
      renderEngineStats();
    });
  });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local") return;
    if (c.pending) renderQueue();
    if (c._engine || c.commentMode) renderEngineStats();
  });
  renderQueue(); renderEngineStats(); renderModeHint();
  // Не будим MV3 service worker каждые 5 секунд: основной источник —
  // storage.onChanged выше, интервал оставлен редким фолбэком.
  setInterval(renderEngineStats, 30000);
}

document.addEventListener("DOMContentLoaded", wireQueue);
if (document.readyState !== "loading") wireQueue();
