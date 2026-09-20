/**
 * Попап. На телефоне это главный (а часто и единственный) экран расширения,
 * поэтому вход живёт прямо здесь, а не за ссылкой «открой настройки».
 *
 * Два состояния и никаких промежуточных: не подключён — форма входа;
 * подключён — четыре кнопки действий. Всё остальное ушло в настройки.
 */
import { openPanel } from "../shared/panel-host.js";
import { getSettings } from "../shared/storage.js";
import { connect, parsePasted, refreshMe, logout } from "../shared/auth.js";

const $ = (id) => document.getElementById(id);
const CHANNEL_URL = "https://t.me/ai_threads_vip";

function show(which) {
  $("login").classList.toggle("hidden", which !== "login");
  $("home").classList.toggle("hidden", which !== "home");
}

function say(text, ok) {
  const m = $("msg");
  m.textContent = text || "";
  m.className = "msg" + (text ? (ok ? " ok" : " err") : "");
}

function paintHome(s) {
  $("plan").textContent = s.plan ? `Тариф ${s.plan}` : "Подключено";
  $("gens").textContent = s.gensLeft === null || s.gensLeft === undefined
    ? "∞" : `${s.gensLeft} генераций`;
}

async function boot() {
  const s = await getSettings();
  if (s.apiToken) {
    show("home");
    paintHome(s);
    // Остаток мог измениться с прошлого открытия — обновляем в фоне,
    // не блокируя показ экрана.
    refreshMe().then((j) => { if (j) paintHome({ ...s, ...{ plan: j.plan, gensLeft: j.gens_left } }); });
  } else {
    show("login");
    $("tgUserId").value = s.tgUserId || "";
    $("pin").value = s.pin || "";
  }
}
boot();

// ── Вход ──────────────────────────────────────────────────────
// Кнопка «вставить из буфера» разбирает сообщение бота целиком: человеку
// не нужно выделять ID и ключ по отдельности, а на телефоне выделение
// внутри чужого сообщения — самое неудобное действие из возможных.
$("paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    const { tgUserId, key } = parsePasted(text);
    if (tgUserId) $("tgUserId").value = tgUserId;
    if (key) $("pin").value = key;
    if (!tgUserId && !key) say("В буфере не нашлось ни ID, ни ключа", false);
    else say("Подставил из буфера — проверьте и войдите", true);
  } catch {
    say("Браузер не дал доступ к буферу — вставьте вручную", false);
  }
});

// Вставка ключа в любое из полей: если человек вставил туда всё сообщение,
// раскладываем его сами, а не ругаемся на формат.
["tgUserId", "pin"].forEach((id) => {
  $(id).addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const p = parsePasted(text);
    if (p.tgUserId && p.key) {
      e.preventDefault();
      $("tgUserId").value = p.tgUserId;
      $("pin").value = p.key;
      say("Подставил ID и ключ", true);
    }
  });
});

async function doLogin() {
  $("go").disabled = true;
  say("Подключаю…", true);
  const r = await connect({
    backendUrl: (await getSettings()).backendUrl,
    tgUserId: $("tgUserId").value,
    key: $("pin").value,
  });
  $("go").disabled = false;
  if (!r.ok) { say("✖ " + r.error, false); return; }
  const s = await getSettings();
  paintHome(s);
  show("home");
}

$("go").addEventListener("click", doLogin);
$("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

// ── Действия ──────────────────────────────────────────────────
$("chat").addEventListener("click", async () => {
  // Прямой вызов chrome.sidePanel.open здесь был бы ошибкой: в Lemur,
  // Orion и Firefox для Android этого API нет, и кнопка молча ничего бы
  // не делала. openPanel сам выбирает панель → оверлей → вкладку.
  const win = await chrome.windows.getCurrent().catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    .catch(() => [null]);
  const res = await openPanel({ windowId: win?.id ?? null, tabId: tab?.id ?? null });
  if (res && res.ok === false) { say("✖ " + res.error, false); return; }
  window.close();
});

$("threads").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.threads.com/" });
  window.close();
});

$("opts").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$("channel").addEventListener("click", () => {
  chrome.tabs.create({ url: CHANNEL_URL });
  window.close();
});

$("out").addEventListener("click", async () => {
  await logout();
  const s = await getSettings();
  $("tgUserId").value = s.tgUserId || "";
  $("pin").value = "";
  say("", true);
  show("login");
});
