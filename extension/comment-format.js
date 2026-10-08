// comment-format.js — приведение комментария к нужной длине.
//
// Главное правило: НИКОГДА не резать посреди мысли.
// Старый код делал text.slice(0, max) и получалось
// «…это то, что реально продаёт, а не» — обрыв на союзе.
//
// Здесь длина уменьшается только по границам предложений, а если
// целого предложения не остаётся — по границе слова с обязательным
// удалением «висящих» служебных слов в конце.

export const DANGLING = [
  // русские союзы/предлоги/частицы, на которых нельзя заканчивать
  "а", "и", "но", "или", "да", "же", "ли", "бы", "не", "ни", "что", "чтобы",
  "как", "когда", "если", "потому", "так", "то", "это", "этот", "эта", "эти",
  "в", "во", "на", "за", "по", "из", "от", "до", "к", "ко", "с", "со", "у",
  "о", "об", "про", "для", "при", "над", "под", "без", "через", "между",
  "мой", "моя", "твой", "его", "её", "их", "наш", "ваш", "свой",
  // английские
  "a", "an", "the", "and", "or", "but", "if", "so", "to", "of", "in", "on",
  "at", "for", "with", "from", "that", "this", "is", "are", "was", "were",
];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}]/gu;

export function stripMd(t) {
  return (t || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*`]/g, "")
    .replace(/^["«»\s]+|["«»\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Разбивает на предложения, сохраняя знак препинания. */
export function sentences(t) {
  const out = (t.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || []).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : [t];
}

/** Убирает служебные слова, повисшие в конце обрезанной фразы. */
export function dropDangling(t) {
  let s = t.replace(/[\s,;:—–-]+$/, "");
  for (let i = 0; i < 6; i++) {
    const m = s.match(/(?:^|\s)([^\s]+)$/);
    if (!m) break;
    const last = m[1].toLowerCase().replace(/[.,;:!?…"»«]+$/g, "");
    if (!DANGLING.includes(last)) break;
    s = s.slice(0, m.index).replace(/[\s,;:—–-]+$/, "");
  }
  return s.trim();
}

/**
 * Приводит текст к лимитам, не обрывая мысль.
 * @param {string} raw       ответ модели
 * @param {object} o
 * @param {number} o.maxChars  максимум символов
 * @param {number} [o.maxWords] максимум слов (эмодзи не считаются)
 * @param {string} [o.emoji]   "auto" | "always" | "never"
 * @returns {{text:string, complete:boolean}} complete=false, если пришлось резать
 */
export function fitComment(raw, o = {}) {
  const maxChars = o.maxChars || 160;
  const maxWords = o.maxWords || 0;
  const emojiMode = o.emoji || "auto";

  let t = stripMd(raw)
    .replace(/#\S+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const found = t.match(EMOJI_RE) || [];
  let bare = t.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
  let complete = true;

  // 1) по границам предложений — набираем столько целых, сколько влезает
  const parts = sentences(bare);
  if (bare.length > maxChars || (maxWords && words(bare) > maxWords)) {
    let acc = "";
    for (const p of parts) {
      const next = acc ? acc + " " + p : p;
      if (next.length > maxChars || (maxWords && words(next) > maxWords)) break;
      acc = next;
    }
    if (acc) {
      bare = acc;
    } else {
      // 2) даже одно предложение не влезло — режем по словам
      complete = false;
      const w = bare.split(/\s+/).filter(Boolean);
      const limit = maxWords ? Math.min(maxWords, w.length) : w.length;
      let cut = w.slice(0, limit).join(" ");
      while (cut.length > maxChars) {
        cut = cut.replace(/\s+\S*$/, "");
        if (!cut.includes(" ")) break;
      }
      bare = dropDangling(cut);
      // осмысленное завершение вместо обрыва
      if (bare && !/[.!?…]$/.test(bare)) bare += "…";
    }
  }

  bare = bare.replace(/\s+([,.!?;:…])/g, "$1").trim();

  let emoji = "";
  if (emojiMode === "always") emoji = found[0] || "🔥";
  else if (emojiMode === "auto") emoji = found[0] || "";

  let text = emoji ? `${bare} ${emoji}` : bare;
  if (text.length > maxChars + 4) text = bare; // эмодзи не должно ломать лимит
  return { text: text.trim(), complete };
}

export function words(t) {
  return (t || "").replace(EMOJI_RE, "").trim().split(/\s+/).filter(Boolean).length;
}

/** Инструкция для модели — чтобы она сразу писала законченную мысль. */
export function lengthRule(o = {}) {
  const parts = [];
  if (o.maxWords) parts.push(`Ровно ${o.minWords || Math.max(2, o.maxWords - 1)}–${o.maxWords} слов.`);
  if (o.maxChars) parts.push(`Не длиннее ${o.maxChars} символов.`);
  parts.push("Мысль должна быть ЗАКОНЧЕННОЙ: не обрывайся на союзе или предлоге.");
  parts.push("Уложись в лимит сразу — текст обрезается, а не досказывается.");
  if (o.emoji === "always") parts.push("Закончи одним уместным эмодзи.");
  else if (o.emoji === "never") parts.push("Без эмодзи.");
  return parts.join(" ");
}
