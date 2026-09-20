// ext-events.js — мост «расширение → бэкенд → VIP/Test-бот».
//
// Раньше уведомления (лид, комментарий) шли напрямую в Telegram API своим
// (BotFather) токеном пользователя — см. shared/telegram.js. Это требовало
// от каждого клиента отдельной настройки бота и давало серверу нулевую
// видимость происходящего (ни логов, ни health-панели).
//
// Теперь события идут на бэкенд тем же токеном, что и /api/ext/generate.
// Бэкенд сам знает, в каком боте (VIP/Test) находится пользователь
// (ta_users.bot_kind), и сам решает, что показать сразу пушем, а что
// копить для /health. Личный BotFather-токен (shared/telegram.js) остаётся
// как необязательная ДОПОЛНИТЕЛЬНАЯ отправка для тех, кто уже его настроил
// — ничего не отбираем, просто новый путь больше не требует его вовсе.

import { getSettings } from "./storage.js";

/**
 * Отправить одно операционное событие. Fire-and-forget: событие не должно
 * тормозить или ронять сам цикл хантера/автокомментинга — если бэкенд
 * недоступен, просто теряем это событие (панель здоровья не обязана быть
 * идеальной, а вот комментинг обязан продолжать работать).
 *
 * @param {string} kind - "comment_attempt" | "lead_found" | "reply_received" | ...
 * @param {object} payload - { status, reason, niche, target_username, target_post_id, detail }
 */
export async function extEvent(kind, payload = {}) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken) return; // кабинет не подключён — молча выходим
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/event";
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ext-Token": s.apiToken,
      },
      body: JSON.stringify({ token: s.apiToken, kind, ...payload }),
    });
  } catch {
    // тихо игнорируем — см. комментарий выше
  }
}

/**
 * Живой контроль: попросить подтверждение у человека в Telegram перед
 * отправкой спорного/лидового комментария. Возвращает id запроса на
 * проверку либо null, если кабинет не подключён или запрос не прошёл —
 * вызывающий код в этом случае просто отправляет как раньше, без
 * подтверждения (недоступность живого контроля не должна останавливать
 * обычную автоматику).
 */
export async function createReview(payload) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken) return null;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/review";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ext-Token": s.apiToken },
      body: JSON.stringify({ token: s.apiToken, ...payload }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || null;
  } catch {
    return null;
  }
}

/** Один опрос статуса решения. "pending" | "send" | "rewrite" | "skip" | null (ошибка/не найдено). */
export async function pollReview(id) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken || !id) return null;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/review/" + encodeURIComponent(id);
    const res = await fetch(url, { headers: { "X-Ext-Token": s.apiToken } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status || null;
  } catch {
    return null;
  }
}

/**
 * Постинг из Telegram: очередь постов, поставленных через бота, которые
 * ждут публикации именно этим расширением (движок постинга живёт в
 * браузере, бэкенд только хранит файл и подпись — см. app.py).
 */
export async function listScheduled() {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken) return [];
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/scheduled";
    const res = await fetch(url, { headers: { "X-Ext-Token": s.apiToken } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch {
    return [];
  }
}

/** Скачивает файл поста и отдаёт его в формате, который ждёт dom().createPost: {b64, name, mime}. */
export async function fetchScheduledMedia(id) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken || !id) return null;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/scheduled/" + encodeURIComponent(id) + "/media";
    const res = await fetch(url, { headers: { "X-Ext-Token": s.apiToken } });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const buf = await res.arrayBuffer();
    // Кодируем чанками, чтобы не упереться в лимит аргументов у
    // String.fromCharCode на крупных видеофайлах.
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const ext = mime.includes("video") ? "mp4" : "jpg";
    return { b64: btoa(bin), name: `post.${ext}`, mime };
  } catch {
    return null;
  }
}

export async function claimScheduled(id) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken || !id) return false;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/scheduled/" + encodeURIComponent(id) + "/claim";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ext-Token": s.apiToken },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.claimed;
  } catch {
    return false;
  }
}

export async function reportScheduledResult(id, ok, reason = "") {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken || !id) return;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/scheduled/" + encodeURIComponent(id) + "/result";
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ext-Token": s.apiToken },
      body: JSON.stringify({ token: s.apiToken, ok: !!ok, reason }),
    });
  } catch {
    // fire-and-forget — потеря одного отчёта не критична
  }
}

/** Панель здоровья: агрегат за N часов — для вкладки «Здоровье» в sidepanel. */
export async function fetchHealth(hours = 24) {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken) return null;
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/health?hours=" + encodeURIComponent(hours);
    const res = await fetch(url, { headers: { "X-Ext-Token": s.apiToken } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** История живого контроля — для той же вкладки. */
export async function fetchReviewHistory() {
  try {
    const s = await getSettings();
    if (!s.backendUrl || !s.apiToken) return [];
    const url = s.backendUrl.replace(/\/+$/, "") + "/api/ext/review";
    const res = await fetch(url, { headers: { "X-Ext-Token": s.apiToken } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch {
    return [];
  }
}
