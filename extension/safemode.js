// safemode.js — снижение риска банов Threads (НЕ гарантия). Человекоподобный ритм:
// паузы с джиттером, кулдауны, «прогрев» лимитов, активные часы.
import { getSettings } from "./storage.js";

// день с первого запуска (для прогрева)
async function daysSinceStart() {
  const { _safeStart } = await chrome.storage.local.get("_safeStart");
  const now = Date.now();
  if (!_safeStart) { await chrome.storage.local.set({ _safeStart: now }); return 0; }
  return Math.floor((now - _safeStart) / 86400000);
}

// множитель прогрева: 0 день → ~0.3, к warmupDays → 1.0
export async function warmupFactor() {
  const s = await getSettings();
  if (!s.safe?.enabled || !s.safe.warmupDays) return 1;
  const d = await daysSinceStart();
  return Math.min(1, 0.3 + (0.7 * d) / s.safe.warmupDays);
}

// Продления лимита, выданные человеком сегодня. Ключ с датой: назавтра
// счётчик обнуляется сам, отдельная чистка не нужна.
function extKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `_capExt_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function capExtensions() {
  const k = extKey();
  const got = await chrome.storage.local.get(k);
  return Number(got[k]) || 0;
}

/** Человек ответил «продолжаем» — поднимаем сегодняшний потолок на шаг. */
export async function grantCapExtension() {
  const s = await getSettings();
  const k = extKey();
  const n = (await capExtensions()) + 1;
  await chrome.storage.local.set({ [k]: n });
  return { count: n, step: Number(s.safe?.extraCapStep) || 10 };
}

// сколько действий разрешено сегодня с учётом прогрева и продлений
export async function safeDailyCap(baseCap) {
  const s = await getSettings();
  const f = await warmupFactor();
  const base = Math.max(1, Math.round(baseCap * f));
  const step = Number(s.safe?.extraCapStep) || 10;
  return base + (await capExtensions()) * step;
}

/** Можно ли ещё раз предложить продление (лимит продлений за день). */
export async function canExtend() {
  const s = await getSettings();
  const max = Number(s.safe?.maxExtensions) || 0;
  if (!s.safe?.askOnCap) return false;
  if (!max) return true;
  return (await capExtensions()) < max;
}

// сейчас «рабочее» время?
// ИСПРАВЛЕНО: интервал через полночь. При activeFrom=22, activeTo=6 условие
// h >= 22 && h < 6 ложно ВСЕГДА — движок бесконечно уходил в «пауза 10 мин».
export async function withinActiveHours() {
  const s = await getSettings();
  if (!s.safe?.enabled) return true;
  const h = new Date().getHours();
  const from = Number(s.safe.activeFrom);
  const to = Number(s.safe.activeTo);
  if (!isFinite(from) || !isFinite(to) || from === to) return true;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// пауза между действиями (сек) с джиттером
export async function nextGapSec() {
  const s = await getSettings();
  if (!s.safe?.enabled) return Number(s.commentSleepSec) || 60;
  const lo = Number(s.safe.minGapSec) || 45;
  const hi = Math.max(lo, Number(s.safe.maxGapSec) || lo);
  const base = lo + Math.random() * (hi - lo);
  const j = 1 + ((Math.random() * 2 - 1) * (s.safe.jitterPct || 0)) / 100;
  return Math.max(10, Math.round(base * j));
}

// нужна ли длинная «человеческая» пауза после N действий
export async function maybeCooldown(actionsDone) {
  const s = await getSettings();
  if (!s.safe?.enabled || !s.safe.cooldownEvery) return 0;
  if (actionsDone > 0 && actionsDone % s.safe.cooldownEvery === 0) {
    const jitter = 0.7 + Math.random() * 0.6;
    return Math.round((s.safe.cooldownMin || 10) * 60 * jitter);
  }
  return 0;
}
