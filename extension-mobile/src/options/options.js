import { getSettings, setSettings, DEFAULTS, PROMPT_PRESETS,
         NICHE_PRESETS, nichePatch } from "../shared/storage.js";
import { getMe, sendMessage } from "../shared/telegram.js";
import * as I18N from "../shared/i18n.js";

const $ = (id) => document.getElementById(id);
const TEXT = ["backendUrl","tgUserId","pin",
  "brandName","brandHandle","brandProfile","brand","niche",
  "commentPrompt","commentMode","postPrompt","leadPrompt","hunterCommentPrompt",
  "telegramToken","telegramAdminId"];
const NUM = ["commentMaxChars","parseTarget","parseMaxScrolls","minLikes","minReplies",
  "commentDelayMinSec","commentDelayMaxSec","maxCommentsPerDay","maxPostsPerDay","postDelayMinSec","postDelayMaxSec"];
const BOOL = ["telegramNotifyLeads", "likeOnComment", "commercialMode", "liveControlEnabled"];
const NUM2 = ["commentSleepSec", "commentSleepJitter"];
const CSV = ["leadKeywords","stopKeywords"];
const SEL = ["postLink","authorLink","editable","replyButtonLabels","sendButtonLabels","composerTriggerLabels"];

function buildPresets(active) {
  const sel = $("presetSelect");
  sel.innerHTML = Object.entries(PROMPT_PRESETS)
    .map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("") +
    `<option value="custom">Свой промпт</option>`;
  sel.value = active in PROMPT_PRESETS ? active : "custom";
  sel.addEventListener("change", () => {
    if (sel.value !== "custom") $("commentPrompt").value = PROMPT_PRESETS[sel.value].text;
  });
}

// ── Каталог моделей: приходит с сервера, кэшируется в настройках ──
async function loadModels(force = false) {
  const s = await getSettings();
  const sel = $("aiModel");
  if (!sel) return;

  let models = s.modelCatalog || [];
  if ((force || !models.length) && s.backendUrl && s.apiToken) {
    try {
      const r = await fetch(s.backendUrl.replace(/\/+$/, "") + "/api/ext/models", {
        headers: { "X-Ext-Token": s.apiToken },
      });
      if (r.ok) {
        const d = await r.json();
        models = d.models || [];
        await setSettings({ modelCatalog: models });
        if (!s.aiModel && d.default) await setSettings({ aiModel: d.default });
      }
    } catch {}
  }

  if (!models.length) {
    sel.innerHTML = '<option value="">Модель по умолчанию (с сервера)</option>';
    $("modelHint").textContent = "Подключи кабинет — и список моделей появится здесь.";
    return;
  }

  sel.innerHTML = '<option value="">Модель по умолчанию (с сервера)</option>' +
    models.map((m) => {
      const lock = m.allowed ? "" : ` — ${m.locked_reason}`;
      return `<option value="${m.id}" ${m.allowed ? "" : "disabled"}>` +
             `${m.label} · ${m.provider_label}${lock}</option>`;
    }).join("");
  const cur = (await getSettings()).aiModel;
  if (cur && models.some((m) => m.id === cur && m.allowed)) sel.value = cur;

  const active = models.find((m) => m.id === sel.value);
  $("modelHint").textContent = active
    ? `${active.hint} (${active.speed}, тариф ${active.plan})`
    : "Сервер сам подставит базовую модель.";
}

function buildNiches(active) {
  const sel = $("nicheSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">— не выбрана —</option>' +
    Object.entries(NICHE_PRESETS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
  if (active) sel.value = active;
}

async function initLang() {
  await I18N.resolve();
  I18N.apply();
  const sel = $("uiLang");
  if (!sel) return;
  sel.value = I18N.lang();
  sel.addEventListener("change", async () => {
    const l = sel.value;
    await I18N.set(l);
    I18N.apply();
    flash("langStatus", I18N.t("lang_saved"), true);
    // Пробрасываем выбор на сервер, чтобы бот заговорил на том же языке.
    // Не критично: если не дошло, локально язык уже переключён.
    const s = await getSettings();
    if (s.backendUrl && s.apiToken) {
      try {
        await fetch(s.backendUrl.replace(/\/+$/, "") + "/api/ext/lang", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Ext-Token": s.apiToken },
          body: JSON.stringify({ lang: l }),
        });
      } catch (e) { /* офлайн — долетит при следующем изменении */ }
    }
  });
}


async function load() {
  const s = await getSettings();
  await initLang();
  TEXT.forEach((f) => $(f) && ($(f).value = s[f] ?? ""));
  NUM.forEach((f) => $(f) && ($(f).value = s[f] ?? ""));
  NUM2.forEach((f) => $(f) && ($(f).value = s[f] ?? ""));
  BOOL.forEach((f) => $(f) && ($(f).checked = !!s[f]));
  // dm
  $("dm_enabled").checked = !!s.dm.enabled; $("dm_approve").checked = !!s.dm.approve;
  $("dm_delayMinSec").value = s.dm.delayMinSec; $("dm_delayMaxSec").value = s.dm.delayMaxSec;
  $("dm_maxPerRun").value = s.dm.maxPerRun; $("dm_prompt").value = s.dm.prompt;
  // Род задаётся отдельным полем, а не внутри промпта: пользователь правит
  // промпт под нишу и эту деталь теряет, а собеседник замечает её первой.
  if ($("dm_persona")) $("dm_persona").value = s.dm.persona || "auto";
  if ($("dm_personaName")) $("dm_personaName").value = s.dm.personaName || "";
  // safe mode
  const SF = ["enabled","minGapSec","maxGapSec","jitterPct","cooldownEvery","cooldownMin","warmupDays","activeFrom","activeTo"];
  SF.forEach((k) => { const el = $("safe_" + k); if (!el) return; if (k === "enabled") el.checked = !!s.safe[k]; else el.value = s.safe[k]; });
  // schedule
  $("sch_enabled").checked = !!s.schedule.enabled;
  ["morning", "day", "evening", "night"].forEach((k) => {
    $("sch_" + k + "_on").checked = !!s.schedule[k].on;
    $("sch_" + k + "_time").value = s.schedule[k].time;
  });
  CSV.forEach((f) => $(f) && ($(f).value = (s[f] || []).join(", ")));
  $("postTopics").value = (s.postTopics || []).join("\n");
  SEL.forEach((k) => { const el = $("sel_" + k); if (el) { const v = s.sel[k]; el.value = Array.isArray(v) ? v.join(", ") : (v || ""); } });
  buildPresets(s.activeCommentPreset);
  buildNiches(s.activeNiche);
  await loadModels();
}

async function save() {
  const patch = {};
  TEXT.forEach((f) => (patch[f] = $(f).value.trim()));
  NUM.forEach((f) => (patch[f] = parseFloat($(f).value) || DEFAULTS[f]));
  NUM2.forEach((f) => (patch[f] = parseFloat($(f).value) || DEFAULTS[f]));
  BOOL.forEach((f) => (patch[f] = $(f).checked));
  patch.dm = {
    enabled: $("dm_enabled").checked, approve: $("dm_approve").checked,
    delayMinSec: parseInt($("dm_delayMinSec").value) || 60,
    delayMaxSec: parseInt($("dm_delayMaxSec").value) || 180,
    maxPerRun: parseInt($("dm_maxPerRun").value) || 10,
    prompt: $("dm_prompt").value.trim(),
    persona: ($("dm_persona") ? $("dm_persona").value : "auto"),
    personaName: ($("dm_personaName") ? $("dm_personaName").value.trim() : ""),
  };
  patch.safe = {
    enabled: $("safe_enabled").checked,
    minGapSec: parseInt($("safe_minGapSec").value) || 45,
    maxGapSec: parseInt($("safe_maxGapSec").value) || 150,
    jitterPct: parseInt($("safe_jitterPct").value) || 25,
    cooldownEvery: parseInt($("safe_cooldownEvery").value) || 8,
    cooldownMin: parseInt($("safe_cooldownMin").value) || 12,
    warmupDays: parseInt($("safe_warmupDays").value) || 7,
    activeFrom: parseInt($("safe_activeFrom").value) || 8,
    activeTo: parseInt($("safe_activeTo").value) || 24,
    typingSim: true,
  };
  patch.schedule = { enabled: $("sch_enabled").checked };
  ["morning", "day", "evening", "night"].forEach((k) => {
    patch.schedule[k] = { on: $("sch_" + k + "_on").checked, time: $("sch_" + k + "_time").value || "09:00" };
  });
  CSV.forEach((f) => (patch[f] = csv($(f).value)));
  patch.postTopics = $("postTopics").value.split("\n").map((x) => x.trim()).filter(Boolean);
  patch.activeCommentPreset = $("presetSelect").value;
  if ($("aiModel")) patch.aiModel = $("aiModel").value;
  const sel = {}; SEL.forEach((k) => { const raw = $("sel_" + k).value.trim(); sel[k] = k.endsWith("Labels") ? csv(raw) : raw; });
  patch.sel = sel;
  await setSettings(patch);
  flash("saveStatus", "Сохранено ✅", true);
}
const csv = (v) => v.split(",").map((x) => x.trim()).filter(Boolean);
function flash(id, t, ok) { const e = $(id); e.textContent = t; e.className = "status " + (ok ? "ok" : "err"); setTimeout(() => { e.textContent = ""; e.className = "status"; }, 4000); }

document.querySelectorAll("[data-reveal]").forEach((b) => b.addEventListener("click", () => { const i = $(b.dataset.reveal); i.type = i.type === "password" ? "text" : "password"; }));
$("save").addEventListener("click", save);
$("testTg").addEventListener("click", async () => {
  flash("tgStatus", "Проверяю…", true);
  try { const me = await getMe($("telegramToken").value.trim()); flash("tgStatus", `@${me.username} ✅`, true); }
  catch (e) { flash("tgStatus", "✖ " + (e.message || e), false); }
});
$("sendTg").addEventListener("click", async () => {
  await save();
  try { await sendMessage("Тест ✅ AI Threads на связи."); flash("tgStatus", "Отправлено ✅", true); }
  catch (e) { flash("tgStatus", "✖ " + (e.message || e), false); }
});

async function fetchAndApplyPrompts(url, token) {
  try {
    const r = await fetch(url + "/api/ext/prompts?token=" + encodeURIComponent(token));
    if (!r.ok) return false;
    const p = await r.json();
    const patch = {};
    if (p.niche) patch.niche = p.niche;
    if (p.brand) patch.brand = p.brand;
    if (p.comment_prompt) patch.commentPrompt = p.comment_prompt;
    if (p.post_prompt) patch.postPrompt = p.post_prompt;
    if (p.lead_prompt) patch.leadPrompt = p.lead_prompt;
    if (p.dm_prompt) { const s = await getSettings(); patch.dm = { ...s.dm, prompt: p.dm_prompt }; }
    await setSettings(patch);
    // обновим поля на странице
    ["niche", "brand", "commentPrompt", "postPrompt", "leadPrompt"].forEach((f) => { if ($(f) && patch[f]) $(f).value = patch[f]; });
    return true;
  } catch { return false; }
}

$("connectBackend").addEventListener("click", async () => {
  const url = $("backendUrl").value.trim().replace(/\/+$/, "");
  const tgUserId = $("tgUserId").value.trim();
  const key = $("pin").value.trim();
  if (!url || !tgUserId || !key) { flash("beStatus", "Заполни адрес, ID и ключ", false); return; }
  flash("beStatus", "Подключаю…", true);
  try {
    const r = await fetch(url + "/api/ext/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: Number(tgUserId) || tgUserId, key }),
    });
    const j = await r.json();
    if (!r.ok || !j.token) throw new Error(j.detail || "неверные ID/ключ");
    await setSettings({ backendUrl: url, tgUserId, pin: key, apiToken: j.token, plan: j.plan, gensLeft: j.gens_left, commercialMode: true });
    $("commercialMode").checked = true;
    // При первом подключении подхватываем язык, выбранный в боте.
    if (await I18N.syncFromServer(j.lang) === j.lang) {
      const sel = $("uiLang");
      if (sel) sel.value = I18N.lang();
      I18N.apply();
    }
    await fetchAndApplyPrompts(url, j.token);
    flash("beStatus", `Подключено ✅ Тариф ${j.plan}, генераций: ${j.gens_left === null ? "∞" : j.gens_left}. Промпты синхронизированы.`, true);
  } catch (e) {
    let m = e.message || String(e);
    if (/Failed to fetch|NetworkError|load failed/i.test(m)) m = "Сервер недоступен. Проверь интернет и адрес сервера (в «расширенных»).";
    flash("beStatus", "✖ " + m, false);
  }
});

$("syncPrompts").addEventListener("click", async () => {
  const s = await getSettings();
  if (!s.backendUrl || !s.apiToken) { flash("beStatus", "Сначала подключись", false); return; }
  flash("beStatus", "Синхронизирую…", true);
  const ok = await fetchAndApplyPrompts(s.backendUrl, s.apiToken);
  flash("beStatus", ok ? "Промпты обновлены ✅" : "Не удалось", ok);
});

$("reloadModels")?.addEventListener("click", async () => {
  $("modelHint").textContent = "Обновляю список…";
  await loadModels(true);
});

$("aiModel")?.addEventListener("change", async () => {
  await setSettings({ aiModel: $("aiModel").value });
  await loadModels();
});

$("applyNiche")?.addEventListener("click", async () => {
  const key = $("nicheSelect").value;
  if (!key) { flash("nicheStatus", "Сначала выбери нишу", false); return; }
  const cur = await getSettings();
  const patch = nichePatch(key, cur);
  await setSettings(patch);
  // подтянуть изменения в открытые поля
  if ($("niche")) $("niche").value = patch.niche;
  if ($("commentPrompt")) $("commentPrompt").value = patch.commentPrompt;
  if ($("postPrompt")) $("postPrompt").value = patch.postPrompt;
  if ($("dm_prompt")) $("dm_prompt").value = patch.dm.prompt;
  if ($("presetSelect")) $("presetSelect").value = "custom";
  flash("nicheStatus", `Промпты «${NICHE_PRESETS[key].name}» применены ✅`, true);
});

load();
