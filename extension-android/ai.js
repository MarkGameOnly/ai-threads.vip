// ai.js — клиент модели AI Threads.
// Генерации идут только через бэкенд ai-threads.vip: ключ провайдера
// живёт на сервере, в расширение он не попадает. Наружу — «AI Threads».

import { getSettings } from "./storage.js";

export class AIError extends Error {
  constructor(message, status, opts = {}) {
    super(message);
    this.name = "AIError";
    this.status = status;
    // Можно ли осмысленно повторить запрос: 429 и 5xx — да, 400/403 — нет.
    this.retryable = !!opts.retryable;
  }
}

export class GensOutError extends Error {
  constructor(buyUrl) {
    super("Генерации закончились");
    this.name = "GensOutError";
    this.buyUrl = buyUrl;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Потолок ожидания одного ответа модели.
 *
 * Раньше fetch шёл без таймаута вообще. Если бэкенд (или провайдер за ним)
 * подвисал, промис не завершался НИКОГДА — и вызывающий цикл замирал
 * насмерть. Именно так «охотник» вставал на шаге отбора лидов: запрос по
 * одному посту уходил в никуда, а программа продолжала его ждать.
 */
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_RETRIES = 2;

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new AIError(
        `AI Threads не ответил за ${Math.round(timeoutMs / 1000)}с — попробую ещё раз.`,
        0, { retryable: true });
    }
    // Сеть отвалилась / бэкенд недоступен — это повторяемый случай.
    throw new AIError("Нет связи с AI Threads: " + (e?.message || e), 0, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(s, messages, opts, timeoutMs) {
  const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/generate";
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // токен в заголовке — не утекает в логи прокси и Referer
      "X-Ext-Token": s.apiToken,
    },
    body: JSON.stringify({
      token: s.apiToken, // совместимость со старым бэкендом
      messages,
      temperature: opts.temperature ?? s.temperature,
      model: opts.model ?? s.aiModel,
    }),
  }, timeoutMs);

  // 403 с кодом onboarding — не «кончились генерации», а «воронка не
  // дойдена». Раньше сервер отвечал на это тем же 402, и человек видел
  // предложение купить VIP там, где надо было просто дописать /start.
  if (res.status === 403) {
    const j = await res.json().catch(() => ({}));
    const d = j.detail || j;
    if (d && d.error === "onboarding") throw new AIError(d.message, 403);
    throw new AIError("Кабинет отключён. Войдите заново: значок расширения → ID и ключ.", 403);
  }
  if (res.status === 402) {
    const j = await res.json().catch(() => ({}));
    const d = j.detail || j;
    throw new GensOutError((d && d.buy_url) || "");
  }
  if (res.status === 429) {
    // Сервер может подсказать, сколько ждать. Уважаем подсказку —
    // иначе цикл охотника колотится в стену и сжигает попытки впустую.
    const ra = Number(res.headers.get("retry-after"));
    const e = new AIError("Слишком много запросов подряд — подожди минуту.", 429, { retryable: true });
    if (isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra, 60) * 1000;
    throw e;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new AIError(`AI Threads ${res.status}: ${t || res.statusText}`,
                      res.status, { retryable: res.status >= 500 });
  }

  const data = await res.json();
  if (typeof data.gens_left !== "undefined") {
    chrome.storage.local.set({ gensLeft: data.gens_left });
  }
  return (data.text || "").trim();
}

/**
 * Запрос к модели с таймаутом и повторами.
 *
 * opts.timeoutMs — потолок на одну попытку (по умолчанию 90 с);
 * opts.retries   — сколько раз повторить при 429/5xx/обрыве сети (по умолчанию 2).
 * «Генерации закончились» и ошибки доступа не повторяются никогда:
 * повтор тут бессмыслен и только тратит время прогона.
 */
async function backendGenerate(s, messages, opts) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(Number(opts.retries)) ? Math.max(0, Number(opts.retries)) : DEFAULT_RETRIES;

  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce(s, messages, opts, timeoutMs);
    } catch (e) {
      last = e;
      if (e instanceof GensOutError) throw e;
      if (!(e instanceof AIError) || !e.retryable) throw e;
      if (attempt === retries) break;
      const wait = e.retryAfterMs || Math.min(15000, 1500 * Math.pow(2, attempt));
      await sleep(wait);
    }
  }
  throw last;
}

export async function chat(messages, opts = {}) {
  const s = await getSettings();
  if (s.backendUrl && s.apiToken) return backendGenerate(s, messages, opts);
  throw new AIError(
    "Не подключён личный кабинет. Открой ⚙️ → «Подключение», введи Telegram ID и ключ из @aithreads50_bot.",
    0
  );
}

export async function chatStream(messages, onDelta, opts = {}) {
  const text = await chat(messages, opts);
  if (text) onDelta?.(text);
  return text;
}
