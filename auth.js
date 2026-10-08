/**
 * Вход в кабинет — одно место на всё расширение.
 *
 * Раньше логика жила только в options.js, и попап мог лишь показать надпись
 * «открой настройки». На телефоне это стоило дорого: страница настроек — это
 * километр полей, а человеку в этот момент нужны ровно два.
 *
 * Теперь вход умеют вызывать трое: попап (руками), страница настроек (как
 * раньше) и мост на ai-threads.vip (по ссылке из бота, без ввода вообще).
 * Код один — расхождений в поведении быть не может.
 */
import { getSettings, setSettings } from "./storage.js";

/** Ключ активации из произвольного текста: TAI-XXXX-XXXX-XXXX. */
export function pickKey(text) {
  const m = String(text || "").toUpperCase().match(/TAI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  return m ? m[0] : "";
}

/** Telegram ID из произвольного текста: первое число из 6–12 цифр. */
export function pickId(text) {
  const m = String(text || "").match(/\b\d{6,12}\b/);
  return m ? m[0] : "";
}

/**
 * Разбор одной строки вида «123456789 TAI-....» или «id:123 key:TAI-...».
 * Нужно, чтобы человек мог вставить из буфера всё сообщение бота целиком,
 * а не выковыривать из него два значения по отдельности — на телефоне это
 * самая частая точка отвала.
 */
export function parsePasted(text) {
  return { tgUserId: pickId(text), key: pickKey(text) };
}

/** Промпты из кабинета в локальные настройки. Не критично, если не дошло. */
export async function syncPrompts(url, token) {
  try {
    const r = await fetch(url.replace(/\/+$/, "") + "/api/ext/prompts?token=" +
                          encodeURIComponent(token));
    if (!r.ok) return false;
    const p = await r.json();
    const patch = {};
    if (p.niche) patch.niche = p.niche;
    if (p.brand) patch.brand = p.brand;
    if (p.comment_prompt) patch.commentPrompt = p.comment_prompt;
    if (p.post_prompt) patch.postPrompt = p.post_prompt;
    if (p.lead_prompt) patch.leadPrompt = p.lead_prompt;
    if (p.dm_prompt) {
      const s = await getSettings();
      patch.dm = { ...s.dm, prompt: p.dm_prompt };
    }
    await setSettings(patch);
    return true;
  } catch { return false; }
}

/**
 * Подключить кабинет.
 * Возвращает { ok, plan, gensLeft, lang } либо { ok:false, error }.
 * Сообщения об ошибке — человеческие: «Failed to fetch» пользователю
 * ничего не говорит, а «сервер недоступен» говорит.
 */
export async function connect({ backendUrl, tgUserId, key }) {
  const url = (backendUrl || "https://ai-threads.vip").trim().replace(/\/+$/, "");
  const id = String(tgUserId || "").trim();
  const k = String(key || "").trim().toUpperCase();
  if (!id || !k) return { ok: false, error: "Нужны Telegram ID и ключ активации" };

  try {
    const r = await fetch(url + "/api/ext/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: Number(id) || id, key: k }),
    });
    let j = {};
    try { j = await r.json(); } catch { /* сервер вернул не JSON */ }
    if (!r.ok || !j.token) {
      return { ok: false, error: j.detail || "Неверный ID или ключ" };
    }
    await setSettings({
      backendUrl: url, tgUserId: id, pin: k, apiToken: j.token,
      plan: j.plan, gensLeft: j.gens_left, commercialMode: true,
    });
    await syncPrompts(url, j.token);
    return { ok: true, plan: j.plan, gensLeft: j.gens_left, lang: j.lang };
  } catch (e) {
    const m = String(e?.message || e);
    return {
      ok: false,
      error: /Failed to fetch|NetworkError|load failed/i.test(m)
        ? "Сервер недоступен — проверьте интернет"
        : m,
    };
  }
}

/** Уже подключены? */
export async function isConnected() {
  const s = await getSettings();
  return !!s.apiToken;
}

/** Обновить остаток генераций. Тихо: это фон, а не действие человека. */
export async function refreshMe() {
  const s = await getSettings();
  if (!s.apiToken) return null;
  try {
    const r = await fetch(s.backendUrl.replace(/\/+$/, "") + "/api/ext/me", {
      headers: { "X-Ext-Token": s.apiToken },
    });
    if (!r.ok) return null;
    const j = await r.json();
    await setSettings({ plan: j.plan, gensLeft: j.gens_left });
    return j;
  } catch { return null; }
}

export async function logout() {
  await setSettings({ apiToken: "", pin: "", plan: "", gensLeft: null });
}
