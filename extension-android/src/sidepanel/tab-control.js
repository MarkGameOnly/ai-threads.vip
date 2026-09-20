// tab-control.js — управление активной вкладкой Threads из боковой панели.
const THREADS_RE = /https:\/\/([a-z0-9-]+\.)?threads\.(com|net)\//i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function findThreadsTab() {
  const tabs = (await chrome.tabs.query({})).filter((t) => THREADS_RE.test(t.url || ""));
  if (!tabs.length) return null;

  // Выгруженные вкладки в списке выглядят как обычные, но content script
  // там не поднят: сообщение падает с «Receiving end does not exist».
  // На телефоне с несколькими открытыми Threads именно такая вкладка
  // регулярно оказывалась первой в выдаче — и все инструменты «не
  // работали» при живой странице перед глазами.
  const live = tabs.filter((t) => !t.discarded && t.status !== "unloaded");
  const pool = live.length ? live : tabs;
  return pool.find((t) => t.active) || pool[0];
}

export async function ensureThreadsTab(url = "https://www.threads.com/") {
  let tab = await findThreadsTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url });
    await waitComplete(tab.id);
    await waitReady(tab.id);
  }
  return tab;
}

export function rpc(tabId, type, payload = {}, timeout = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "timeout" }); } }, timeout);
    chrome.tabs.sendMessage(tabId, { type, ...payload }, (res) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: "no response" });
    });
  });
}

// Файлы content-script'а — порядок важен, он повторяет manifest.json.
const CONTENT_FILES = [
  "src/content/threads-resolve.js",
  "src/content/threads-dom.js",
  "src/content/threads-aim.js",
  "src/content/threads-find.js",
  "src/content/threads-engine.js",
  "src/content/threads-rpc.js",
  "src/content/sheet.js",
  "src/content/threads-panel.js",
];

/**
 * Убедиться, что во вкладке живёт content-script.
 *
 * Chrome не всегда переинжектит скрипты после навигации, а Threads —
 * SPA с собственными переходами. Если скрипт умер, любое сообщение
 * падает с «Could not establish connection. Receiving end does not exist»
 * или «message channel closed before a response was received». Раньше это
 * трактовалось как провал лида; теперь мы просто вставляем скрипт заново.
 */
export async function ensureContentScript(tabId) {
  const ping = await rpc(tabId, "RPC_PING", {}, 2500);
  if (ping.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch (e) {
    return false;
  }
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const p = await rpc(tabId, "RPC_PING", {}, 2000);
    if (p.ok) return true;
  }
  return false;
}

const DEAD_RE = /Receiving end does not exist|message channel closed|Could not establish connection|Extension context invalidated/i;

/**
 * RPC, который сам чинит мёртвую вкладку. Один повтор после переинжекта —
 * повторяются только вызовы, которые ТОЧНО не выполнились (соединения не было).
 */
export async function rpcSafe(tabId, type, payload = {}, timeout = 60000) {
  let r = await rpc(tabId, type, payload, timeout);
  if (r.ok || !DEAD_RE.test(r.error || "")) return r;
  const alive = await ensureContentScript(tabId);
  if (!alive) return { ok: false, error: "вкладка Threads не отвечает — открой threads.com заново" };
  return rpc(tabId, type, payload, timeout);
}

export async function waitComplete(tabId, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t && t.status === "complete") return true;
    await sleep(300);
  }
  return false;
}

export async function waitReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await rpc(tabId, "RPC_PING", {}, 2000);
    if (r.ok) return true;
    await sleep(400);
  }
  return false;
}

// Навигировать вкладку и дождаться готовности контент-скрипта.
export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitComplete(tabId);
  // Threads — SPA, дадим ленте прогрузиться
  await sleep(1500);
  // Раньше здесь было просто waitReady(): если скрипт не поднялся, функция
  // всё равно возвращала true, и следующий же RPC падал с «Receiving end
  // does not exist». Теперь при неудаче скрипт вставляется принудительно.
  const ok = await waitReady(tabId);
  if (!ok) return ensureContentScript(tabId);
  return true;
}

export { sleep, THREADS_RE };
