// ai.js — клиент модели AI Threads.
// Генерации идут только через бэкенд ai-threads.vip: ключ провайдера
// живёт на сервере, в расширение он не попадает. Наружу — «AI Threads».

import { getSettings } from "./storage.js";

export class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AIError";
    this.status = status;
  }
}

export class GensOutError extends Error {
  constructor(buyUrl) {
    super("Генерации закончились");
    this.name = "GensOutError";
    this.buyUrl = buyUrl;
  }
}

async function backendGenerate(s, messages, opts) {
  const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/generate";
  const res = await fetch(url, {
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
  });

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
    throw new AIError("Слишком много запросов подряд — подожди минуту.", 429);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new AIError(`AI Threads ${res.status}: ${t || res.statusText}`, res.status);
  }

  const data = await res.json();
  if (typeof data.gens_left !== "undefined") {
    chrome.storage.local.set({ gensLeft: data.gens_left });
  }
  return (data.text || "").trim();
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
