// Клиент Telegram Bot API. Всё через https://api.telegram.org/bot<token>/<method>

import { getSettings } from "./storage.js";

const API = "https://api.telegram.org";

async function call(method, params = {}, tokenOverride) {
  const s = await getSettings();
  const token = tokenOverride ?? s.telegramToken;
  if (!token) throw new Error("Не задан токен Telegram-бота");

  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  }
  return data.result;
}

// Отправить сообщение. По умолчанию — админу.
export async function sendMessage(text, opts = {}) {
  const s = await getSettings();
  const chatId = opts.chatId ?? s.telegramAdminId;
  if (!chatId) throw new Error("Не задан chat_id / Admin ID");

  // Telegram лимит 4096 символов — режем на части.
  const parts = splitText(String(text), 4000);
  let last;
  for (const part of parts) {
    last = await call("sendMessage", {
      chat_id: chatId,
      text: part,
      parse_mode: opts.parseMode, // 'HTML' | 'Markdown' | undefined
      disable_web_page_preview: opts.noPreview ?? true,
    });
  }
  return last;
}

export async function getMe(tokenOverride) {
  return call("getMe", {}, tokenOverride);
}

// Long polling. offset — id последнего обработанного апдейта + 1.
export async function getUpdates(offset, timeout = 25) {
  return call("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message"],
  });
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}
