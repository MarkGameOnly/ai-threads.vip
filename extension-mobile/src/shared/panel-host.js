/**
 * Открытие панели там, где нет chrome.sidePanel.
 *
 * chrome.sidePanel — API только для Chrome. Ни Orion на iOS, ни Firefox для
 * Android его не реализуют, и не собираются: боковой панели как сущности в
 * этих браузерах нет. А наша панель — это весь интерфейс расширения, так что
 * без запасного пути мобильная версия просто не открывается.
 *
 * Два запасных варианта, в порядке предпочтения:
 *
 * 1. Панель как оверлей внутри страницы Threads. На телефоне это
 *    единственный удобный вариант: переключение вкладок на мобильном стоит
 *    дороже, чем на десктопе, и уводить человека со страницы, с которой он
 *    работает, — значит ломать сценарий.
 *
 * 2. Отдельная вкладка. Нужна, когда мы не на threads.com (там нет нашего
 *    content script и вставлять оверлей некуда).
 *
 * Определяем возможности, а не браузер. Проверка «если Safari — то так» врёт
 * при первом же обновлении: Orion представляется как Safari, но ведёт себя
 * иначе, а Firefox для Android умеет не то же, что Firefox для десктопа.
 */

export const PANEL_URL = "src/sidepanel/panel.html";
const OVERLAY_ID = "__aithreads_panel_host";

/** Есть ли настоящая боковая панель. */
export function hasSidePanel() {
  return typeof chrome !== "undefined"
    && !!chrome.sidePanel
    && typeof chrome.sidePanel.open === "function";
}

/** Мобильный ли экран — по размеру, а не по user-agent. */
export function isNarrow() {
  try {
    return Math.min(screen.width, screen.height) <= 820;
  } catch {
    return false;
  }
}

/**
 * Открыть панель наилучшим доступным способом.
 * Вызывается из popup и из service worker, поэтому windowId и tabId
 * приходят снаружи — в service worker нет доступа к window.
 */
export async function openPanel({ windowId = null, tabId = null } = {}) {
  // Настоящая боковая панель — только на десктопе в Chrome.
  if (hasSidePanel() && windowId != null && !isNarrow()) {
    try {
      await chrome.sidePanel.open({ windowId });
      return { ok: true, mode: "sidepanel" };
    } catch (e) {
      // Проваливаемся в запасной путь, а не показываем ошибку: для
      // пользователя важно, что панель открылась, а не каким API.
    }
  }

  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const onThreads = /https:\/\/([a-z0-9-]+\.)?threads\.(com|net)\//i.test(tab?.url || "");

  if (tabId != null) {
    // Нижняя шторка — основной путь на телефоне.
    const r = await ask(tabId, { type: "SHEET_OPEN" });
    if (r?.ok) return { ok: true, mode: "sheet" };

    // Content script мог не успеть подняться (или страница открыта до
    // установки). Вкалываем его и пробуем ещё раз — это дешевле, чем
    // отправлять человека в новую вкладку.
    if (onThreads && chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["src/content/sheet.js"],
        });
        const again = await ask(tabId, { type: "SHEET_OPEN" });
        if (again?.ok) return { ok: true, mode: "sheet" };
      } catch (e) { /* нет прав на эту вкладку — идём дальше */ }
    }

    // Оверлей как второй запасной путь (десктопные браузеры без sidePanel).
    const ov = await ask(tabId, { type: "PANEL_OVERLAY_OPEN" });
    if (ov?.ok) return { ok: true, mode: "overlay" };
  }

  // Новая вкладка — только когда мы НЕ на Threads. На узком экране это
  // не «менее удобно», а прямо ломает работу: вкладка Threads уходит в
  // фон, мобильный браузер её усыпляет, и охотник с комментингом
  // останавливаются. Человек нажимал «Чат», чтобы запустить охотника, и
  // этим же нажатием его выключал.
  if (onThreads && isNarrow()) {
    return { ok: false, mode: "none",
             error: "Панель не открылась. Обновите страницу Threads (потяните ленту вниз) "
                    + "и нажмите ещё раз — уводить вас с Threads нельзя, иначе "
                    + "остановится охотник." };
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(PANEL_URL) });
  return { ok: true, mode: "tab" };
}

/** Сообщение во вкладку без выброса исключения на отсутствующий приёмник. */
function ask(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        void chrome.runtime.lastError;   // «receiving end does not exist» — не ошибка, а ответ
        resolve(r || null);
      });
    } catch { resolve(null); }
  });
}

/**
 * Оверлей внутри страницы. Живёт в content script.
 *
 * Панель грузится в iframe с extension-происхождением: тот же panel.html,
 * что и в боковой панели, без дублирования кода и с доступом к chrome.*.
 * Вставлять её напрямую в DOM страницы нельзя — там нет доступа к API
 * расширения, а стили Threads поедут поверх наших.
 */
export function mountOverlay() {
  if (document.getElementById(OVERLAY_ID)) {
    document.getElementById(OVERLAY_ID).style.display = "block";
    return true;
  }
  const narrow = isNarrow();
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.cssText = [
    "position:fixed", "z-index:2147483646", "background:#0b0b0c",
    "box-shadow:0 0 0 1px rgba(255,255,255,.14), 0 18px 60px rgba(0,0,0,.6)",
    narrow ? "inset:0" : "top:0;right:0;bottom:0;width:400px",
    narrow ? "" : "border-left:1px solid rgba(255,255,255,.12)",
  ].filter(Boolean).join(";");

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
    + "padding:10px 12px;font:600 12px/1 ui-monospace,monospace;color:#eee;"
    + "border-bottom:1px solid rgba(255,255,255,.10)";
  bar.innerHTML = "<span>AI THREADS</span>";

  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Закрыть панель");
  close.style.cssText = "background:none;border:0;color:#aaa;font-size:16px;cursor:pointer;"
    + "padding:4px 8px;min-width:44px;min-height:44px";
  close.onclick = () => { host.style.display = "none"; };
  bar.appendChild(close);

  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL(PANEL_URL);
  frame.style.cssText = "width:100%;height:calc(100% - 40px);border:0;display:block";
  // allow-same-origin нужен, чтобы внутри iframe работали chrome.storage и
  // обмен сообщениями: без него панель откроется пустой.
  frame.setAttribute("allow", "clipboard-write");

  host.appendChild(bar);
  host.appendChild(frame);
  document.documentElement.appendChild(host);
  return true;
}

export function unmountOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}
