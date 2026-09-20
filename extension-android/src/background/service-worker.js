import {
  getSettings, setSettings, getCounters, bumpCounter,
  getEngine, setEngine, bumpStat, resetEngine,
  pendingList, pendingAdd, pendingRemove,
} from "../shared/storage.js";
import { chat, AIError } from "../shared/ai.js";
import { openPanel } from "../shared/panel-host.js";
import { nextGapSec, withinActiveHours, safeDailyCap, maybeCooldown,
         canExtend, capExtensions, grantCapExtension } from "../shared/safemode.js";
import { sendMessage, getMe } from "../shared/telegram.js";
import { connect as authConnect } from "../shared/auth.js";
import { extEvent, createReview, pollReview,
         listScheduled, fetchScheduledMedia, claimScheduled, reportScheduledResult,
         fetchHealth, fetchReviewHistory } from "../shared/ext-events.js";

chrome.runtime.onInstalled.addListener(() => {
  // Опциональная цепочка обязательна: в браузерах без sidePanel обращение
  // к chrome.sidePanel.setPanelBehavior роняет service worker на старте, и
  // расширение молча перестаёт работать целиком.
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("dst_posts", { periodInMinutes: 1 });
});
chrome.runtime.onStartup?.addListener(() => chrome.alarms.create("dst_posts", { periodInMinutes: 1 }));

// вычислить ближайшее время слота ("HH:MM") в будущем
async function slotTime(slot) {
  const s = await getSettings();
  const conf = s.schedule?.[slot];
  const hhmm = (conf?.time || "09:00").split(":");
  const now = new Date();
  const t = new Date(now);
  t.setHours(+hhmm[0] || 9, +hhmm[1] || 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

async function publishScheduled(item) {
  const s = await getSettings();
  const THREADS_RE = /https:\/\/([a-z0-9-]+\.)?threads\.(com|net)\//i;
  let tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => THREADS_RE.test(t.url || ""));
  if (!tab) tab = await chrome.tabs.create({ url: "https://www.threads.com/", active: false });
  // дождаться готовности
  for (let i = 0; i < 30; i++) {
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t && t.status === "complete") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));
  // Режим хранится в самой записи: человек мог поставить один пост на
  // автопубликацию, а другой — на ручную. Раньше брался общий режим
  // комментирования, и выбор в планировщике игнорировался.
  //
  // Посты из Telegram (item.serverId) — всегда "auto": весь смысл
  // постинга из бота ночью без компьютера в том, чтобы он ушёл сам, а
  // не лёг черновиком, который некому подтвердить.
  const mode = item.serverId ? "auto"
    : (item.mode || (s.commentMode === "auto" ? "auto" : "manual")) === "auto" ? "auto" : "manual";
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "RPC_POST", text: item.text, file: item.file || null, mode }, (r) => resolve(r || { ok: false }));
  });
}

/**
 * Синхронизация очереди постов, поставленных через Telegram-бота.
 * Бэкенд только хранит файл и подпись — сам постинг делает расширение,
 * тем же движком (dom().createPost), что и обычный планировщик; сервер
 * не открывает браузер и не видит сессию Threads (см. решение не
 * переносить движок на сервер).
 *
 * Идёт от той же минутной сигнализации, что и обычный планировщик —
 * отдельный алярм не нужен, а сама проверка дешёвая (обычно очередь
 * пуста, один короткий GET).
 */
async function syncScheduledFromBot() {
  const items = await listScheduled();
  if (!items.length) return;
  const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
  const known = new Set(scheduled_posts.map((p) => p.serverId).filter(Boolean));
  let changed = false;
  for (const item of items) {
    if (known.has(item.id)) continue; // уже подхвачен раньше — не дублируем
    const claimed = await claimScheduled(item.id);
    if (!claimed) continue; // забрала другая вкладка/синхронизация раньше нас
    const file = await fetchScheduledMedia(item.id);
    if (!file) {
      await reportScheduledResult(item.id, false, "не удалось скачать файл с сервера");
      continue;
    }
    const at = await slotTime(item.slot);
    scheduled_posts.push({ at, text: item.caption || "", file, mode: "auto", serverId: item.id });
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ scheduled_posts });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "dst_posts") return;
  syncScheduledFromBot().catch(() => {});
  const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
  if (!scheduled_posts.length) return;
  const now = Date.now();
  const due = scheduled_posts.filter((p) => p.at <= now);
  const rest = scheduled_posts.filter((p) => p.at > now);
  if (!due.length) return;
  await chrome.storage.local.set({ scheduled_posts: rest });
  for (const item of due) {
    try {
      const r = await publishScheduled(item);
      if (item.serverId) {
        await reportScheduledResult(item.serverId, !!(r && r.ok && (r.sent || r.drafted)),
          (r && r.error) || "");
      }
    } catch (e) {
      if (item.serverId) await reportScheduledResult(item.serverId, false, String(e?.message || e));
    }
  }
});

async function loadArr(k) { const o = await chrome.storage.local.get(k); return Array.isArray(o[k]) ? o[k] : []; }
async function saveArr(k, a) { await chrome.storage.local.set({ [k]: a }); }

async function savePosts(posts) {
  const cur = await loadArr("threads_posts");
  const map = new Map(cur.map((p) => [p.code, p]));
  for (const p of posts) map.set(p.code, { ...map.get(p.code), ...p });
  const merged = Array.from(map.values()).slice(-2000);
  await saveArr("threads_posts", merged);
  return merged.length;
}
async function saveLeads(leads) {
  const cur = await loadArr("threads_leads");
  const map = new Map(cur.map((p) => [p.code, p]));
  for (const p of leads) map.set(p.code, { ...map.get(p.code), ...p });
  const merged = Array.from(map.values()).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 800);
  await saveArr("threads_leads", merged);
  return merged.length;
}
async function isCommented(code) { return (await loadArr("threads_commented")).includes(code); }
async function markCommented(code) {
  const s = await loadArr("threads_commented");
  if (!s.includes(code)) { s.push(code); await saveArr("threads_commented", s.slice(-4000)); }
}

// ══════════════════════════════════════════════════════════════
//  ДВУХФАЗНАЯ ПОМЕТКА ПОСТОВ — защита от повторных комментариев
// ══════════════════════════════════════════════════════════════
// Раньше пост помечался «прокомментировано» ДО отправки: при неудаче он
// сгорал навсегда, а при ретрае через пермалинк мог получить второй
// комментарий. Теперь пост сначала ЗАНИМАЕТСЯ (claim), и только
// подтверждённая отправка переводит его в окончательный список.
//
// Все операции идут в service-worker, который однопоточен — значит две
// вкладки Threads физически не могут занять один и тот же пост.
const CLAIM_TTL_MS = 10 * 60 * 1000;      // сколько живёт «взят в работу»
const QUEUE_TTL_MS = 7 * 24 * 3600 * 1000; // сколько ждёт подтверждения в очереди

async function loadClaims() {
  const { threads_claims } = await chrome.storage.local.get("threads_claims");
  return (threads_claims && typeof threads_claims === "object") ? threads_claims : {};
}
async function saveClaims(map) {
  const now = Date.now();
  const live = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && v.until > now) live[k] = v;
  }
  // страховка от разрастания
  const keys = Object.keys(live);
  if (keys.length > 3000) {
    keys.sort((a, b) => (live[a].at || 0) - (live[b].at || 0));
    for (const k of keys.slice(0, keys.length - 3000)) delete live[k];
  }
  await chrome.storage.local.set({ threads_claims: live });
  return live;
}

/** Занять пост. Возвращает claimed:false, если он уже обработан или занят. */
async function claimPost(code) {
  if (!code) return { claimed: false, reason: "no-code" };
  if (await isCommented(code)) return { claimed: false, reason: "commented" };
  const map = await loadClaims();
  const now = Date.now();
  const cur = map[code];
  if (cur && cur.until > now) return { claimed: false, reason: cur.state || "busy" };
  map[code] = { state: "working", at: now, until: now + CLAIM_TTL_MS };
  await saveClaims(map);
  return { claimed: true };
}

/**
 * Снять брони, оставшиеся от прерванных прогонов.
 *
 * what="working"  — только «взят в работу» (прогон умер, бронь висит до 10 мин);
 * what="cooldown" — паузы после неудач;
 * what="all"      — и то, и другое. Список «уже прокомментировано» НЕ трогаем
 * никогда: это единственная защита от повторного комментария.
 */
async function purgeClaims(what = "working") {
  const map = await loadClaims();
  const kill = what === "all" ? ["working", "cooldown"] : [what];
  let n = 0;
  for (const [code, v] of Object.entries(map)) {
    if (v && kill.includes(v.state)) { delete map[code]; n++; }
  }
  await saveClaims(map);
  return { purged: n };
}

/** Пост обработан окончательно — комментарий подтверждён (или мог уйти). */
async function commitPost(code) {
  if (!code) return;
  await markCommented(code);
  const map = await loadClaims();
  delete map[code];
  await saveClaims(map);
}

/** Отпустить пост. cooldownMin > 0 — не трогать его столько минут. */
async function releasePost(code, cooldownMin = 0) {
  if (!code) return;
  const map = await loadClaims();
  const mins = Number(cooldownMin) || 0;
  if (mins > 0) map[code] = { state: "cooldown", at: Date.now(), until: Date.now() + mins * 60000 };
  else delete map[code];
  await saveClaims(map);
}

/** Пост ушёл в очередь ручного подтверждения — держим бронь долго. */
async function queuePost(code) {
  if (!code) return;
  const map = await loadClaims();
  map[code] = { state: "queued", at: Date.now(), until: Date.now() + QUEUE_TTL_MS };
  await saveClaims(map);
}

// ── Лок вкладки: комментирует ровно одна вкладка Threads ──
const TAB_LOCK_TTL = 30000;
async function claimEngineTab(tabId) {
  const { _engineLock } = await chrome.storage.local.get("_engineLock");
  const now = Date.now();
  if (_engineLock && _engineLock.tabId !== tabId && now - (_engineLock.at || 0) < TAB_LOCK_TTL) {
    return { mine: false, owner: _engineLock.tabId };
  }
  await chrome.storage.local.set({ _engineLock: { tabId, at: now } });
  return { mine: true };
}
async function releaseEngineTab(tabId) {
  const { _engineLock } = await chrome.storage.local.get("_engineLock");
  if (_engineLock && _engineLock.tabId === tabId) await chrome.storage.local.remove("_engineLock");
}
chrome.tabs.onRemoved.addListener((tabId) => { releaseEngineTab(tabId).catch(() => {}); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "GET_SETTINGS": sendResponse({ ok: true, settings: await getSettings() }); break;

        // Вход по ссылке из бота. Приходит из моста на ai-threads.vip:
        // content script не может импортировать модули и не должен знать
        // про эндпоинты — он только передаёт сюда пару «ID + ключ».
        case "CONNECT_FROM_LINK": {
          const r = await authConnect({
            backendUrl: msg.backendUrl || (await getSettings()).backendUrl,
            tgUserId: msg.tgUserId,
            key: msg.key,
          });
          sendResponse(r);
          break;
        }
        case "SET_SETTINGS": sendResponse({ ok: true, settings: await setSettings(msg.patch || {}) }); break;
        case "GET_COUNTERS": sendResponse({ ok: true, counters: await getCounters() }); break;
        case "BUMP_COUNTER": sendResponse({ ok: true, counters: await bumpCounter(msg.field, msg.by || 1) }); break;

        case "DS_CHAT":   // старое имя — совместимость со сборками 3.x
        case "AI_CHAT": {
          const text = await chat(msg.messages || [{ role: "user", content: msg.prompt || "" }], msg.opts || {});
          sendResponse({ ok: true, text }); break;
        }

        // ── Движок комментинга ──
        case "ENGINE_GET":    sendResponse({ ok: true, engine: await getEngine() }); break;
        case "ENGINE_SET":    sendResponse({ ok: true, engine: await setEngine(msg.patch || {}) }); break;
        case "ENGINE_RESET":  await resetEngine(); sendResponse({ ok: true }); break;
        case "BUMP_STAT":     sendResponse({ ok: true, engine: await bumpStat(msg.field, msg.by || 1) }); break;

        // ── Очередь подтверждения (ручной режим) ──
        case "PENDING_LIST":   sendResponse({ ok: true, list: await pendingList() }); break;
        case "PENDING_ADD":    sendResponse({ ok: true, list: await pendingAdd(msg.item) }); break;
        case "PENDING_REMOVE": sendResponse({ ok: true, list: await pendingRemove(msg.code) }); break;

        // ── Безопасный режим ──
        case "SAFE_GAP":    sendResponse({ ok: true, sec: await nextGapSec() }); break;
        case "SAFE_ACTIVE": sendResponse({ ok: await withinActiveHours() }); break;
        case "SAFE_CAP": {
          const s2 = await getSettings();
          sendResponse({
            ok: true,
            cap: await safeDailyCap(s2.maxCommentsPerDay),
            canExtend: await canExtend(),
            extensions: await capExtensions(),
            step: Number(s2.safe?.extraCapStep) || 10,
          });
          break;
        }
        // Человек в панели нажал «Продолжаем» на вопросе о дневном лимите.
        case "SAFE_EXTEND": {
          const r = await grantCapExtension();
          sendResponse({ ok: true, ...r });
          break;
        }
        // Длинный «человеческий» перерыв раз в N действий. Раньше функция
        // maybeCooldown существовала, но её никто не вызывал.
        case "SAFE_COOLDOWN": {
          const c3 = await getCounters();
          sendResponse({ ok: true, sec: await maybeCooldown(c3.comments || 0) }); break;
        }
        case "TG_SEND": await sendMessage(msg.text, msg.opts || {}); sendResponse({ ok: true }); break;
        // Событие для панели здоровья/уведомлений в VIP-Test-боте — см.
        // shared/ext-events.js. Content-script не модуль и не умеет import,
        // поэтому шлёт сюда через sendMessage, а сам fetch к бэкенду
        // делает уже здесь, в фоне (у него есть доступ к ES-импортам).
        case "EXT_EVENT":
          extEvent(msg.kind, msg.payload || {}).catch(() => {});
          sendResponse({ ok: true });
          break;
        case "EXT_REVIEW_CREATE":
          sendResponse({ ok: true, id: await createReview(msg.payload || {}) });
          break;
        case "EXT_REVIEW_POLL":
          sendResponse({ ok: true, status: await pollReview(msg.id) });
          break;
        case "EXT_HEALTH":
          sendResponse({ ok: true, data: await fetchHealth(msg.hours || 24) });
          break;
        case "EXT_REVIEW_HISTORY":
          sendResponse({ ok: true, items: await fetchReviewHistory() });
          break;
        case "EXT_SCHEDULED_LIST":
          sendResponse({ ok: true, items: await listScheduled() });
          break;
        case "TG_TEST": sendResponse({ ok: true, me: await getMe(msg.token) }); break;

        case "SAVE_POSTS": sendResponse({ ok: true, total: await savePosts(msg.posts || []) }); break;
        case "SAVE_LEADS": sendResponse({ ok: true, total: await saveLeads(msg.leads || []) }); break;
        case "IS_COMMENTED": sendResponse({ ok: true, yes: await isCommented(msg.code) }); break;
        case "MARK_COMMENTED": await markCommented(msg.code); sendResponse({ ok: true }); break;

        // ── Двухфазная пометка (защита от дублей) ──
        case "CLAIM_POST":   sendResponse({ ok: true, ...(await claimPost(msg.code)) }); break;
        case "PURGE_CLAIMS": sendResponse({ ok: true, ...(await purgeClaims(msg.what)) }); break;
        case "COMMIT_POST":  await commitPost(msg.code); sendResponse({ ok: true }); break;
        case "RELEASE_POST": await releasePost(msg.code, msg.cooldownMin); sendResponse({ ok: true }); break;
        case "QUEUE_POST":   await queuePost(msg.code); sendResponse({ ok: true }); break;

        // ── Лок вкладки ──
        case "ENGINE_CLAIM_TAB": {
          const id = sender.tab?.id;
          if (id == null) { sendResponse({ ok: true, mine: true }); break; }
          sendResponse({ ok: true, ...(await claimEngineTab(id)) }); break;
        }
        case "ENGINE_RELEASE_TAB": {
          const id = sender.tab?.id;
          if (id != null) await releaseEngineTab(id);
          sendResponse({ ok: true }); break;
        }
        case "SHIFT_TOPIC": {
          const s = await getSettings(); const t = [...(s.postTopics || [])]; t.shift();
          await setSettings({ postTopics: t }); sendResponse({ ok: true, topics: t }); break;
        }
        case "SCHEDULE_POST": {
          // msg.at — точное время из планировщика; если его нет, берём
          // ближайшее время выбранного слота, как раньше.
          const at = msg.at ? Number(msg.at) : await slotTime(msg.slot);
          const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
          scheduled_posts.push({
            id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            text: msg.text, file: msg.file || null, slot: msg.slot, at,
            mode: msg.mode === "manual" ? "manual" : "auto",
          });
          scheduled_posts.sort((a, b) => a.at - b.at);
          await chrome.storage.local.set({ scheduled_posts });
          chrome.alarms.create("dst_posts", { periodInMinutes: 1 });
          sendResponse({ ok: true, at }); break;
        }
        case "UNSCHEDULE_POST": {
          const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
          const rest = scheduled_posts.filter((p) => p.id !== msg.id);
          await chrome.storage.local.set({ scheduled_posts: rest });
          sendResponse({ ok: true, left: rest.length }); break;
        }
        case "RESCHEDULE_POST": {
          const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
          const item = scheduled_posts.find((p) => p.id === msg.id);
          if (item) { item.at = Number(msg.at) || item.at; scheduled_posts.sort((a, b) => a.at - b.at); }
          await chrome.storage.local.set({ scheduled_posts });
          sendResponse({ ok: !!item }); break;
        }
        case "PUBLISH_NOW": {
          const { scheduled_posts = [] } = await chrome.storage.local.get("scheduled_posts");
          const item = scheduled_posts.find((p) => p.id === msg.id);
          if (!item) { sendResponse({ ok: false, error: "пост не найден" }); break; }
          await chrome.storage.local.set({
            scheduled_posts: scheduled_posts.filter((p) => p.id !== msg.id) });
          const r = await publishScheduled(item);
          sendResponse(r || { ok: false }); break;
        }
        case "OPEN_PANEL": {
          const r = await openPanel({ windowId: sender.tab?.windowId ?? null,
                                      tabId: sender.tab?.id ?? null });
          sendResponse(r); break;
        }
        case "OPEN_OPTIONS": chrome.runtime.openOptionsPage(); sendResponse({ ok: true }); break;

        default: sendResponse({ ok: false, error: "unknown: " + msg?.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e), status: e instanceof AIError ? e.status : undefined });
    }
  })();
  return true;
});
