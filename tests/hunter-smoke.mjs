/**
 * Дымовой тест программы «Охотник за клиентами».
 *
 * Запуск:  node tests/hunter-smoke.mjs
 *
 * Зачем он нужен. Охотник вставал на четвёртом шаге («отбор лидов») и не
 * доходил до пятого — до комментариев под выбранными ветками. Причина была
 * не одна, и все они одинаково невидимы глазами: запрос к модели без
 * таймаута, исключение в цикле отбора, вызов программы без catch, мёртвый
 * канал к фоновому скрипту, закрытая вкладка. Тест воспроизводит каждый из
 * этих случаев на заглушках Chrome API и требует одного: программа обязана
 * ЗАВЕРШИТЬСЯ и, если лиды есть, дойти до отправки комментариев.
 *
 * Настоящая сеть и настоящий Threads здесь не участвуют.
 */

const ROOT = new URL("../extension/src/", import.meta.url);
const TIMEOUT_MS = 90000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── заглушки Chrome API ─────────────────────────────────────────── */

let SC = "happy";          // текущий сценарий
let aiCalls = 0;
let tabGone = false;
let tabUrl = "https://www.threads.com/";
const counters = { date: "x", comments: 0, posts: 0 };
const commentedCodes = new Set();
const claims = new Map();
const sentComments = [];

const store = {
  backendUrl: "https://ai-threads.vip",
  apiToken: "test-token",
  brand: "AI Threads",
  brandName: "Mika",
  brandHandle: "",
  niche: "AI-контент",
  telegramToken: "",
  telegramNotifyLeads: false,
  hunter: {
    product: "AI-автоматизация для блогеров", useFeed: true, feedTarget: 6,
    hypotheses: 2, threadsPerQuery: 6, freshnessHours: 0,
    minLikes: 0, minReplies: 0, keepBest: 2,
  },
  safe: { enabled: false },
  commentDelayMinSec: 0,
  commentDelayMaxSec: 0,
  maxCommentsPerDay: 30,
  commentMode: "auto",
};

function reset() {
  aiCalls = 0; tabGone = false; tabUrl = "https://www.threads.com/";
  counters.comments = 0; counters.posts = 0;
  commentedCodes.clear(); claims.clear(); sentComments.length = 0;
}

const posts = Array.from({ length: 8 }, (_, i) => ({
  code: "C" + i,
  author: "user" + i,
  text: `пост №${i} — ищу подрядчика на контент, посоветуйте кого-нибудь надёжного`,
  likes: 10 + i, comments: i, reposts: 0, shares: 0, engagement: 10 + i,
  time: new Date().toISOString(),
  permalink: `https://www.threads.com/@user${i}/post/C${i}`,
}));

function aiReply(messages) {
  aiCalls++;
  const text = messages.map((m) => m.content).join("\n");

  if (/поисковых запросов/i.test(text)) {
    return { ok: true, text: '["ищу подрядчика","нужен контент"]' };
  }
  if (/является ли автор поста/i.test(text)) {
    if (SC === "ai-dies" && aiCalls > 3) {
      return { ok: false, error: "Слишком много запросов подряд", kind: "AIError", status: 429, retryable: true };
    }
    if (SC === "gens-out" && aiCalls > 3) {
      return { ok: false, error: "Генерации закончились", kind: "GensOutError", buyUrl: "https://buy" };
    }
    if (SC === "no-leads") return { ok: true, text: '{"is_lead": false, "score": 0, "reason": "не клиент"}' };
    if (SC === "prose") {
      return { ok: true, text:
        'Вот мой ответ:\n{"is_lead": true, "score": 71, "reason": "ищет подрядчика", "angle": "помочь"}\nНадеюсь, помог.' };
    }
    const n = Number((text.match(/пост №(\d+)/) || [])[1] || 0);
    return { ok: true, text: JSON.stringify({
      is_lead: n % 2 === 0, score: 60 + n, reason: "ищет подрядчика", angle: "мягко предложить" }) };
  }
  if (/комментарий к посту/i.test(text)) {
    return { ok: true, text: "Тут поможет простая автоматизация — сэкономит пару часов в день." };
  }
  return { ok: true, text: "ок" };
}

function bgHandle(msg) {
  switch (msg.type) {
    case "GET_SETTINGS": return { ok: true, settings: store };
    case "GET_COUNTERS": return { ok: true, counters };
    case "BUMP_COUNTER": counters[msg.field]++; return { ok: true, counters };
    case "SAVE_POSTS": case "SAVE_LEADS": case "EXT_EVENT": case "QUEUE_POST": return { ok: true };
    case "PURGE_CLAIMS": return { ok: true, purged: 0 };
    case "CLAIM_POST":
      if (commentedCodes.has(msg.code)) return { ok: true, claimed: false, reason: "commented" };
      if (claims.has(msg.code)) return { ok: true, claimed: false, reason: "working" };
      claims.set(msg.code, 1); return { ok: true, claimed: true };
    case "COMMIT_POST": commentedCodes.add(msg.code); claims.delete(msg.code); return { ok: true };
    case "RELEASE_POST": claims.delete(msg.code); return { ok: true };
    case "AI_CHAT": return aiReply(msg.messages);
    default: return { ok: false, error: "unknown " + msg.type };
  }
}

function tabRpc(type, payload) {
  switch (type) {
    case "RPC_PING": return { ok: true, url: tabUrl };
    case "RPC_HEALTH": return { ok: true, data: { loggedIn: true, postLinks: posts.length } };
    case "RPC_COLLECT": return { ok: true, posts: posts.slice(0, payload.target || 6) };
    case "RPC_WAIT_POST": return { ok: true };
    case "RPC_COMMENT":
      sentComments.push({ code: payload.code, text: payload.text });
      return { ok: true, sent: true, confirmed: "replies+1" };
    default: return { ok: false, error: "unknown rpc " + type };
  }
}

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage: (msg, cb) => {
      if (SC === "bg-dead" && msg.type !== "AI_CHAT") {
        const err = new Error("Could not establish connection. Receiving end does not exist.");
        if (typeof cb === "function") {
          chrome.runtime.lastError = err;
          try { cb(undefined); } finally { chrome.runtime.lastError = undefined; }
          return;
        }
        return Promise.reject(err);
      }
      const r = bgHandle(msg);
      if (typeof cb === "function") { cb(r); return; }
      return Promise.resolve(r);
    },
    openOptionsPage() {},
  },
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return { ...store };
        const ks = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (o) => Object.assign(store, o),
      remove: async () => {},
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    query: async () => [{ id: 1, url: tabUrl, active: true, status: "complete" }],
    get: async (id) => {
      // «Вкладку закрыли посреди прогона» — раньше это роняло всю программу.
      if (SC === "tab-closed" && !tabGone) { tabGone = true; throw new Error("No tab with id: " + id); }
      if (id !== 1) throw new Error("No tab with id: " + id);
      return { id: 1, url: tabUrl, status: "complete" };
    },
    create: async ({ url }) => { tabUrl = url; return { id: 1, url, status: "complete" }; },
    update: async (id, { url }) => { tabUrl = url; return { id, url }; },
    sendMessage: (id, msg, cb) => {
      const r = tabRpc(msg.type, msg);
      if (typeof cb === "function") { cb(r); return; }
      return Promise.resolve(r);
    },
    onRemoved: { addListener() {} },
  },
  scripting: { executeScript: async () => [] },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {} },
};

globalThis.fetch = async () => { throw new Error("прямой fetch в дымовом тесте запрещён"); };

/* ─── сценарии ────────────────────────────────────────────────────── */

const T = await import(new URL("sidepanel/tools.js", ROOT).href);

const SCENARIOS = [
  { id: "happy",      title: "всё работает",                       expect: "commented" },
  { id: "prose",      title: "модель отвечает JSON внутри текста", expect: "commented" },
  { id: "ai-dies",    title: "модель начала отдавать 429",         expect: "commented" },
  { id: "gens-out",   title: "кончились генерации посреди отбора", expect: "commented" },
  { id: "tab-closed", title: "вкладку Threads закрыли",            expect: "commented" },
  { id: "bg-dead",    title: "фоновый скрипт не отвечает",         expect: "commented" },
  { id: "no-leads",   title: "подходящих клиентов нет",            expect: "no-leads" },
  { id: "stop-mid",   title: "нажали «Завершить» во время отбора", expect: "stopped" },
];

let failures = 0;

for (const sc of SCENARIOS) {
  SC = sc.id;
  reset();

  const lines = [];
  const steps = {};
  const t0 = Date.now();

  const res = await Promise.race([
    T.runHunter({ ...store.hunter }, {
      log: (m) => lines.push(m),
      step: (i, st) => { steps[i] = st; },
      isStopped: () => SC === "stop-mid" && lines.length > 9,
      waitIfPaused: async () => {},
    }),
    delay(TIMEOUT_MS).then(() => ({ ok: false, error: "ЗАВИС", hung: true })),
  ]);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  let ok;
  if (res?.hung) ok = false;
  else if (sc.expect === "commented") ok = sentComments.length > 0 && steps[4] === "done";
  else if (sc.expect === "no-leads") ok = res.ok === true && res.leadsCount === 0 && !res.hung;
  else ok = res.stopped === true;

  if (!ok) {
    failures++;
    console.log(`\n✕ ${sc.id} — ${sc.title} (${secs}с)`);
    console.log(lines.map((l) => "    • " + l).join("\n"));
    console.log("    шаги:", JSON.stringify(steps));
    console.log("    результат:", JSON.stringify(res));
  } else {
    console.log(`✓ ${sc.id.padEnd(11)} ${sc.title.padEnd(42)} ` +
                `${secs}с · комментариев: ${sentComments.length}`);
  }
}

console.log(failures
  ? `\n${failures} из ${SCENARIOS.length} сценариев провалены`
  : `\nВсе ${SCENARIOS.length} сценариев прошли: охотник не зависает и доходит до комментариев.`);
process.exit(failures ? 1 : 0);
