/* ══════════════════════════════════════════════════════════════
   AI Threads — язык интерфейса расширения
   ══════════════════════════════════════════════════════════════
   Язык общий с ботом: где бы человек его ни выбрал — в Telegram
   командой /lang или здесь в настройках — вторая половина продукта
   подхватит то же значение.

   Порядок определения:
     1) явный выбор пользователя (chrome.storage.local);
     2) язык, пришедший с бэкенда вместе с профилем (выбор в боте);
     3) язык браузера;
     4) русский.

   Разметка: элемент с data-i18n="ключ" получает текст, data-i18n-ph —
   плейсхолдер, data-i18n-title — подсказку. Русский текст остаётся в
   HTML как есть, поэтому при сбое скрипта интерфейс не пустеет.
   ══════════════════════════════════════════════════════════════ */

const KEY = "ui_lang";

export const DICT = {
  ru: {
    // шапка и вкладки
    settings: "Настройки",
    tab_chat: "💬 Чат",
    tab_leads: "🎯 Клиенты",
    tab_queue: "✓ Очередь",
    tab_posts: "📄 Посты",
    st_mode: "режим",
    st_seen: "найдено",
    st_sent: "отправлено",

    // чат
    model_title: "Модель генерации",
    btn_hunter: "🕵️ Охотник",
    btn_post: "📎 Пост",
    btn_dm: "✉️ Директ",
    input_ph: "Спросите AI Threads VIP…",

    // очередь
    mode_auto: "Авто",
    mode_manual: "Вручную",

    // посты
    only_viral: "Только залетевшие",
    sort_engagement: "По вовлечённости",
    sort_likes: "По лайкам",
    sort_comments: "По комментам",
    sort_reposts: "По репостам",

    // модалка поста
    post_new: "📎 Новый пост",
    post_text_l: "Текст поста (коротко!)",
    post_text_ph: "Короткий живой пост…",
    post_attach: "📎 Прикрепить фото/видео",
    post_when: "Когда опубликовать",
    slot_now: "Сейчас",
    slot_morning: "Утром",
    slot_day: "Днём",
    slot_evening: "Вечером",
    slot_night: "Ночью",
    post_publish: "Опубликовать / в очередь",
    post_draft: "Только черновик",
    post_hint: "Пост вставляется как «живой» — при режиме «черновик» ты подтверждаешь отправку сам.",

    // охотник
    hunt_title: "🕵️ AI-охотник за клиентами",
    hunt_s1: "Построить поисковые гипотезы",
    hunt_s2: "Собрать главную ленту и поисковую выдачу",
    hunt_s3: "Оставить свежие уникальные возможности",
    hunt_s4: "Строгая AI-квалификация лидов",
    hunt_s5: "Начать полезные диалоги в выбранных ветках",
    hunt_product_l: "Продукт, услуга и идеальный клиент *",
    hunt_product_ph: "Например: продаю AI-контент и автоматизацию для блогеров…",
    hunt_tip_sum: "ⓘ Как заполнить (пример)",
    hunt_order_l: "Порядок выдачи",
    hunt_order_fresh: "Сначала свежие",
    hunt_order_rel: "По релевантности",
    hunt_lang_l: "Язык поиска",
    hunt_lang_auto: "Авто — по описанию",
    hunt_usefeed: "Искать и в главной ленте, не только в поиске",
    hunt_feed: "Веток из ленты",
    hunt_hyp: "Поисковых гипотез",
    hunt_per_query: "Веток на один запрос",
    hunt_fresh_h: "Свежесть, часов",
    hunt_min_likes: "Минимум лайков",
    hunt_min_replies: "Минимум комментариев",
    hunt_keep: "Оставить лучших",
    hunt_run: "Запустить программу",
    hunt_purge: "↺ Сбросить брони лидов",

    // настройки языка
    lang_label: "🌐 Язык / Language",
    lang_note: "Выбор общий с Telegram-ботом.",
    lang_saved: "Язык сохранён",
    chat_hello: "Я AI Threads VIP.",
    chat_hello2: "Скажите, что сделать:",

    // прогресс и одобрение ответов
    prog_stop: "■ Остановить",
    prog_resume: "▶ Продолжить",
    prog_finish: "✕ Завершить",
    prog_running: "идёт",
    prog_stopped: "остановлено",
    prog_stop_hint: "■ Остановлено. Нажмите «Продолжить» — вернусь к тому же месту.",
    prog_resume_hint: "▶ Продолжаю.",
    prog_finish_hint: "Завершаю после текущего шага…",
    dm_send: "Отправить",
    dm_skip: "Пропустить",
    dm_stop: "Остановить",
    dm_sending: "отправляю…",
    dm_skipped: "пропущено — сутки не вернусь",
    dm_stopped: "остановлено",
    dm_nothing: "Новых диалогов нет: везде последнее слово за вами или уже отвечено.",

    // третий шаг знакомства
    onb3_h: "Готово. Вот что дальше",
    onb3_sub: "Три минуты на настройку — и всё остальное работает само.",
    onb3_s1t: "Настройте под нишу",
    onb3_s1: "В боте нажмите «🎯 Настроить под нишу» — четыре вопроса, и промпты соберутся под ваш продукт. Потом здесь: ⚙️ → «Синхронизировать промпты».",
    onb3_s2t: "Бот для лидов (по желанию)",
    onb3_s2: "Хотите получать найденных клиентов себе в Telegram — создайте своего бота у @BotFather (команда /newbot), скопируйте токен вида 123456:AA… и вставьте в ⚙️ → «Telegram». Свой ID узнайте у @userinfobot. Без этого лиды всё равно видны во вкладке «Клиенты».",
    onb3_s3t: "Что умеет расширение",
    onb3_s3: "«Охотник» ищет клиентов по вашему описанию, «Директ» отвечает в личке, «Посты» показывают, что залетело у других, и переписывают под вас, планировщик публикует по расписанию.",
    onb3_s4t: "Авто или вручную",
    onb3_s4: "Во вкладке «Очередь» переключатель на две позиции: «Авто» — ИИ пишет и отправляет сам, «Вручную» — показывает текст и ждёт вашего подтверждения.",
    onb3_go: "Начать работу",
    onb3_hint: "Эту памятку всегда можно открыть заново: спросите помощника «как настроить» прямо в чате.",

    // планировщик постов
    post_ideas: "✨ Предложить варианты",
    post_ideas_busy: "Придумываю…",
    post_ideas_fail: "модель не вернула варианты",
    slot_exact: "Точное время…",
    post_mode: "Как публиковать",
    post_mode_auto: "Авто",
    post_mode_manual: "Вручную",
    post_mode_hint_auto: "Авто: расширение само откроет Threads и опубликует в назначенное время.",
    post_mode_hint_manual: "Вручную: в нужное время откроется композер с готовым текстом — публикуете вы.",
    plan_title: "🗓 Запланировано",
    plan_empty: "Пока ничего не запланировано.",
    plan_now: "Опубликовать сейчас",
    plan_del: "Убрать",
    plan_today: "сегодня",
    plan_tomorrow: "завтра",
    plan_ok: "Пост запланирован:",
    plan_note: "Chrome должен быть открыт с вкладкой Threads в это время.",
    plan_need_time: "Укажите дату и время публикации.",
    plan_past: "Это время уже прошло.",
    plan_published: "Опубликовано ✅",
    plan_failed: "Не получилось опубликовать",
    post_busy: "Публикую пост",
    post_done: "Пост опубликован ✅",
    post_draft_done: "Черновик вставлен в композер — проверьте и опубликуйте.",
    post_attached: "Вложение добавлено.",

    // режимы директа и комментирования
    mode_hint_auto: "Авто: ИИ пишет в вашем стиле и отправляет сам.",
    mode_hint_manual: "Вручную: ИИ готовит текст, вы правите и подтверждаете отправку.",

    // вкладка «Посты»
    ps_total: "всего",
    ps_viral: "залетевших",
    ps_median: "медиана",
    ps_talk: "обсуждение",
    ps_talk_t: "какая доля отклика — это комментарии",
    ps_spread: "разлёт",
    ps_spread_t: "репосты и пересылки в личные",
    ps_open: "Открыть ↗",
    ps_rewrite: "✍ Переписать под меня",
    ps_comment: "💬 Прокомментировать",
    ps_dm: "✉ Написать в директ",
    ps_empty: "Постов нет. Скажите «спарси ленту» или нажмите 🔎 на панели Threads.",

    // действия по посту
    act_comment_busy: "Готовлю комментарий к ветке",
    act_comment_confirm: "Отправить этот комментарий?",
    act_comment_sent: "Комментарий отправлен:",
    act_comment_draft: "Комментарий вставлен — подтвердите отправку в Threads.",
    act_dm_busy: "Открываю Директ и готовлю сообщение",
    act_dm_sent: "Отправлено в директ:",
    act_dm_draft: "Текст вставлен в переписку — отправьте вручную:",
    act_send: "Отправить",
    act_cancel: "Отмена",
    act_cancelled: "Отменено.",
  },

  en: {
    settings: "Settings",
    tab_chat: "💬 Chat",
    tab_leads: "🎯 Leads",
    tab_queue: "✓ Queue",
    tab_posts: "📄 Posts",
    st_mode: "mode",
    st_seen: "found",
    st_sent: "sent",

    model_title: "Generation model",
    btn_hunter: "🕵️ Hunter",
    btn_post: "📎 Post",
    btn_dm: "✉️ DM",
    input_ph: "Ask AI Threads VIP…",

    mode_auto: "Auto",
    mode_manual: "Manual",

    only_viral: "Only high performers",
    sort_engagement: "By engagement",
    sort_likes: "By likes",
    sort_comments: "By replies",
    sort_reposts: "By reposts",

    post_new: "📎 New post",
    post_text_l: "Post text (keep it short)",
    post_text_ph: "A short, human post…",
    post_attach: "📎 Attach photo/video",
    post_when: "When to publish",
    slot_now: "Now",
    slot_morning: "Morning",
    slot_day: "Midday",
    slot_evening: "Evening",
    slot_night: "Night",
    post_publish: "Publish / add to queue",
    post_draft: "Draft only",
    post_hint: "The post is inserted as written — in draft mode you confirm sending yourself.",

    hunt_title: "🕵️ AI lead hunter",
    hunt_s1: "Build search hypotheses",
    hunt_s2: "Collect the main feed and search results",
    hunt_s3: "Keep only fresh, unique opportunities",
    hunt_s4: "Strict AI lead qualification",
    hunt_s5: "Start useful conversations in the chosen threads",
    hunt_product_l: "Product, service and ideal customer *",
    hunt_product_ph: "For example: I sell AI content and automation to creators…",
    hunt_tip_sum: "ⓘ How to fill this in (example)",
    hunt_order_l: "Result order",
    hunt_order_fresh: "Freshest first",
    hunt_order_rel: "By relevance",
    hunt_lang_l: "Search language",
    hunt_lang_auto: "Auto — from your description",
    hunt_usefeed: "Search the main feed too, not only search results",
    hunt_feed: "Threads from feed",
    hunt_hyp: "Search hypotheses",
    hunt_per_query: "Threads per query",
    hunt_fresh_h: "Freshness, hours",
    hunt_min_likes: "Minimum likes",
    hunt_min_replies: "Minimum replies",
    hunt_keep: "Keep best",
    hunt_run: "Run program",
    hunt_purge: "↺ Reset lead claims",

    lang_label: "🌐 Language / Язык",
    lang_note: "Shared with the Telegram bot.",
    lang_saved: "Language saved",
    chat_hello: "I am AI Threads VIP.",
    chat_hello2: "Tell me what to do:",

    // progress and reply approval
    prog_stop: "■ Stop",
    prog_resume: "▶ Continue",
    prog_finish: "✕ Finish",
    prog_running: "running",
    prog_stopped: "stopped",
    prog_stop_hint: "■ Stopped. Press “Continue” and I resume from the same place.",
    prog_resume_hint: "▶ Continuing.",
    prog_finish_hint: "Finishing after the current step…",
    dm_send: "Send",
    dm_skip: "Skip",
    dm_stop: "Stop",
    dm_sending: "sending…",
    dm_skipped: "skipped — I will not return for a day",
    dm_stopped: "stopped",
    dm_nothing: "Nothing new: in every conversation you spoke last, or it is already answered.",

    // third onboarding step
    onb3_h: "You are in. Here is what to do next",
    onb3_sub: "Three minutes of setup — everything after that runs on its own.",
    onb3_s1t: "Tune it to your niche",
    onb3_s1: "In the bot press “🎯 Tune to my niche” — four questions and your prompts are built around your product. Then here: ⚙️ → “Sync prompts”.",
    onb3_s2t: "Your own lead bot (optional)",
    onb3_s2: "Want the leads delivered to your own Telegram — create a bot with @BotFather (command /newbot), copy the token that looks like 123456:AA… and paste it into ⚙️ → “Telegram”. Get your own ID from @userinfobot. Without this the leads still appear in the “Clients” tab.",
    onb3_s3t: "What the extension does",
    onb3_s3: "Client Hunter finds people from your description, Direct answers in DMs, Posts shows what took off for others and rewrites it in your voice, and the scheduler publishes on a timetable.",
    onb3_s4t: "Auto or manual",
    onb3_s4: "The “Queue” tab has a two-way switch: “Auto” — the AI writes and sends by itself, “Manual” — it shows you the text and waits for your confirmation.",
    onb3_go: "Start working",
    onb3_hint: "You can bring this back any time: ask the assistant “how do I set this up” right in the chat.",

    // post scheduler
    post_ideas: "✨ Suggest options",
    post_ideas_busy: "Thinking…",
    post_ideas_fail: "the model returned no options",
    slot_exact: "Exact time…",
    post_mode: "How to publish",
    post_mode_auto: "Auto",
    post_mode_manual: "Manual",
    post_mode_hint_auto: "Auto: the extension opens Threads and publishes at the chosen time by itself.",
    post_mode_hint_manual: "Manual: at that time the composer opens with the text ready — you publish it.",
    plan_title: "🗓 Scheduled",
    plan_empty: "Nothing scheduled yet.",
    plan_now: "Publish now",
    plan_del: "Remove",
    plan_today: "today",
    plan_tomorrow: "tomorrow",
    plan_ok: "Post scheduled:",
    plan_note: "Chrome must be open with a Threads tab at that time.",
    plan_need_time: "Please set the date and time.",
    plan_past: "That time has already passed.",
    plan_published: "Published ✅",
    plan_failed: "Could not publish",
    post_busy: "Publishing the post",
    post_done: "Post published ✅",
    post_draft_done: "Draft inserted into the composer — check it and publish.",
    post_attached: "Attachment added.",

    // direct and comment modes
    mode_hint_auto: "Auto: the AI writes in your voice and sends it itself.",
    mode_hint_manual: "Manual: the AI drafts, you edit and confirm before it goes out.",

    // posts tab
    ps_total: "total",
    ps_viral: "took off",
    ps_median: "median",
    ps_talk: "discussion",
    ps_talk_t: "how much of the response is comments",
    ps_spread: "spread",
    ps_spread_t: "reposts and shares to DMs",
    ps_open: "Open ↗",
    ps_rewrite: "✍ Rewrite for me",
    ps_comment: "💬 Reply in thread",
    ps_dm: "✉ Send a DM",
    ps_empty: "No posts yet. Say “collect the feed” or press 🔎 on the Threads panel.",

    // per-post actions
    act_comment_busy: "Drafting a reply for this thread",
    act_comment_confirm: "Send this reply?",
    act_comment_sent: "Reply sent:",
    act_comment_draft: "Reply inserted — confirm sending inside Threads.",
    act_dm_busy: "Opening the DM and drafting a message",
    act_dm_sent: "Sent as a DM:",
    act_dm_draft: "Text inserted into the conversation — send it yourself:",
    act_send: "Send",
    act_cancel: "Cancel",
    act_cancelled: "Cancelled.",
  },
};

let current = "ru";

export function lang() {
  return current;
}

export function t(key, fallback = "") {
  const d = DICT[current] || DICT.ru;
  return d[key] != null ? d[key] : (DICT.ru[key] != null ? DICT.ru[key] : fallback || key);
}

function browserLang() {
  const l = (navigator.language || "ru").toLowerCase();
  return l.startsWith("ru") || l.startsWith("kk") || l.startsWith("be") ? "ru" : "en";
}

/** Прочитать сохранённый язык. serverLang — то, что выбрано в боте. */
export async function resolve(serverLang = "") {
  let stored = "";
  try {
    const got = await chrome.storage.local.get(KEY);
    stored = got[KEY] || "";
  } catch (e) { /* storage недоступен — останемся на дефолте */ }

  if (stored === "ru" || stored === "en") current = stored;
  else if (serverLang === "ru" || serverLang === "en") current = serverLang;
  else current = browserLang();
  return current;
}

/** Записать выбор пользователя. */
export async function set(l) {
  if (l !== "ru" && l !== "en") return current;
  current = l;
  try { await chrome.storage.local.set({ [KEY]: l }); } catch (e) { /* ignore */ }
  return current;
}

/**
 * Язык, пришедший с сервера (выбран в боте). Перебивает локальное значение,
 * только если человек не менял язык прямо в расширении — иначе выбор,
 * сделанный здесь и сейчас, молча откатывался бы после каждой синхронизации.
 */
export async function syncFromServer(serverLang) {
  if (serverLang !== "ru" && serverLang !== "en") return current;
  let stored = "";
  try {
    const got = await chrome.storage.local.get(KEY);
    stored = got[KEY] || "";
  } catch (e) { /* ignore */ }
  if (stored) return current;
  current = serverLang;
  return current;
}

/** Применить перевод к документу. Безопасно вызывать повторно. */
export function apply(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = t(el.getAttribute("data-i18n"), el.textContent);
    if (v) el.textContent = v;
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    const v = t(el.getAttribute("data-i18n-ph"), el.placeholder);
    if (v) el.placeholder = v;
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const v = t(el.getAttribute("data-i18n-title"), el.title);
    if (v) el.title = v;
  });
  if (root === document) document.documentElement.lang = current;
}
