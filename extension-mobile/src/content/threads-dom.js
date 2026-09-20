// threads-dom.js — работа с DOM Threads. window.DST.dom (классический скрипт).
(() => {
  if (window.DST && window.DST.dom) return;
  window.DST = window.DST || {};

  const O = () => window.DST.ours || {
    isOurs: () => false,
    qsa: (r, s) => Array.from((r || document).querySelectorAll(s)),
    qs: (r, s) => (r || document).querySelector(s),
    textWithoutOurs: (r) => (r || document.body)?.innerText || "",
    mark: (e) => e,
  };
  const isOurs = (el) => O().isOurs(el);
  const qsa = (r, s) => O().qsa(r, s);
  const qs = (r, s) => O().qs(r, s);
  const pageText = (r) => O().textWithoutOurs(r);

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
  const rnd = (a, b) => {
    a = Number(a); b = Number(b);
    if (!isFinite(a)) a = 0;
    if (!isFinite(b) || b < a) b = a;
    return Math.floor(a + Math.random() * (b - a));
  };

  // --- числа вида 94, 1.2K, 12тыс, 1 234 ---
  function parseNum(s) {
    if (s == null) return 0;
    s = String(s).toLowerCase().replace(/[\u00a0\u202f\u2009]/g, " ").trim();
    const m = s.match(/(\d[\d\s.,]*)\s*(k|к|тыс|m|млн)?/);
    if (!m) return 0;
    let n = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
    if (isNaN(n)) return 0;
    const suf = m[2] || "";
    if (suf === "k" || suf === "к" || suf === "тыс") n *= 1000;
    if (suf === "m" || suf === "млн") n *= 1000000;
    return Math.round(n);
  }
  function firstNum(s) {
    if (!s) return 0;
    const m = String(s).match(/\d[\d\s.,]*\s*(?:k|к|тыс|m|млн)?/i);
    return m ? parseNum(m[0]) : 0;
  }

  /**
   * КАРТОЧКА ОДНОГО ПОСТА.
   *
   * Раньше подъём шёл до первого предка «есть автор и >25 символов текста».
   * На странице ветки это сразу весь список: контейнер содержал 21 автора и
   * 9 постов, строка действий бралась от чужого ответа, тексты склеивались.
   *
   * Теперь: поднимаемся, пока в предке ровно ОДНА ссылка на пост. Как только
   * их стало больше — возвращаем предыдущий уровень. Плюс приоритет отдан
   * атрибуту data-pressable-container, которым Threads помечает карточку.
   */
  function postContainerFromLink(a) {
    if (!a) return null;
    const pressable = a.closest?.("[data-pressable-container]");
    if (pressable && pressable.querySelectorAll('a[href*="/post/"]').length >= 1 &&
        !isOurs(pressable)) {
      // у вложенных pressable берём тот, где уже есть автор
      let p = pressable;
      for (let i = 0; i < 3 && p; i++) {
        if (p.querySelector('a[href^="/@"]')) return p;
        p = p.parentElement?.closest?.("[data-pressable-container]");
      }
      return pressable;
    }

    let el = a, prev = a;
    for (let i = 0; i < 10 && el && el.parentElement; i++) {
      prev = el;
      el = el.parentElement;
      if (isOurs(el)) return prev;
      const posts = el.querySelectorAll('a[href*="/post/"]').length;
      if (posts > 1) return prev;                 // ← вышли за пределы своего поста
      if (el.querySelector('a[href^="/@"]') && visText(el).trim().length > 25) return el;
    }
    return a.closest("article") || a.parentElement;
  }

  // Метрики: like / comment / repost / share.
  // ИСПРАВЛЕНО: категория ищется в aria-label ИЛИ в тексте кнопки.
  // Раньше число брали из текста, а категорию проверяли только по пустому
  // aria-label — основной путь не срабатывал никогда, и всегда включался
  // аварийный «первые числа из контейнера» (у поста в 56 символов
  // получалось 26 153 лайка).
  function readMetrics(container, sel) {
    const map = { likes: 0, comments: 0, reposts: 0, shares: 0 };
    if (!container) return map;
    const controls = qsa(container, 'a[role="link"], div[role="button"], button, [aria-label]');
    const catRe = {
      likes: /(^|\W)(like|нрав)/i,
      comments: /(comment|repl|коммент|ответ)/i,
      reposts: /(repost|репост)/i,
      shares: /(share|поделит|отправ)/i,
    };
    for (const b of controls) {
      const lab = (b.getAttribute("aria-label") || "").toLowerCase();
      const txt = (b.innerText || "").trim();
      const hay = (lab + " " + txt).toLowerCase();
      const num = firstNum(lab) || firstNum(txt);
      if (!num) continue;
      for (const k of Object.keys(catRe)) {
        if (catRe[k].test(hay)) { map[k] = Math.max(map[k], num); break; }
      }
    }
    if (!map.likes && !map.comments && !map.reposts) {
      const nums = orderedActionNumbers(container);
      map.likes = nums[0] || 0;
      map.comments = nums[1] || 0;
      map.reposts = nums[2] || 0;
      map.shares = nums[3] || 0;
    }
    return map;
  }

  // Собрать «одиночные» числа (не внутри текста поста), в порядке DOM.
  function orderedActionNumbers(container) {
    const out = [];
    if (!container) return out;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (isOurs(node.parentElement)) continue;          // свой UI не считаем
      const t = node.nodeValue.trim();
      if (/^\d[\d\s.,]*\s*(?:k|к|тыс|m|млн)?$/i.test(t)) out.push(parseNum(t));
      if (out.length >= 8) break;
    }
    return out;
  }

  // Служебные подписи интерфейса. Сравнение по ЦЕЛОЙ строке, а не по
  // началу с \b: в JS \b — граница ASCII-слова, поэтому «Подписаться»,
  // «Нравится», «Ответить», «Ещё», «15 ч.» не отсекались вообще, и весь
  // этот мусор уходил в промпт вместе с текстом поста.
  const UI_WORDS = [
    "подписаться", "подписки", "подписан", "follow", "following", "followed",
    "нравится", "like", "liked", 'поставить "нравится"', 'убрать "нравится"',
    "ответ", "ответы", "ответить", "reply", "replies", "comment", "comments",
    "репост", "repost", "reposted", "сделать репост",
    "поделиться", "share", "отправить", "send",
    "ещё", "еще", "more", "перевести", "translate", "смотреть перевод",
    "показать больше", "show more", "see more", "перевод", "автор", "закреплено",
    "популярные", "смотреть действия", "рекомендовано для вас", "верифицирован",
  ];
  const TIME_RE = /^\d+\s*(ч|мин|сек|д|нед|мес|г|h|m|s|d|w|mo|y)\.?( назад| ago)?$/i;

  function isUiLine(l) {
    const s = l.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.:,]+$/, "");
    if (!s) return true;
    if (TIME_RE.test(s)) return true;
    if (UI_WORDS.includes(s)) return true;
    if (/^\d+\s*(просмотр|view)/i.test(s)) return true;
    return false;
  }

  /**
   * ТЕКСТ ПОСТА.
   * Берём строки карточки, выкидываем служебные подписи (по полному
   * совпадению — см. isUiLine), имя автора и «голые» числа-счётчики,
   * и склеиваем то, что осталось, сохраняя переносы.
   */
  function extractPostText(container, author) {
    if (!container) return "";
    const au = (author || "").toLowerCase().trim();
    const lines = pageText(container)
      .split("\n")
      .map((s) => s.trim())
      .filter((l) => {
        if (!l || l.length < 2) return false;
        if (au && l.toLowerCase() === au) return false;
        if (au && l.toLowerCase() === "@" + au) return false;
        if (/^[\d\s.,]+\s*(k|к|тыс|m|млн)?$/i.test(l)) return false;
        if (isUiLine(l)) return false;
        return true;
      });
    // дедуп подряд идущих одинаковых строк (Threads дублирует alt-тексты)
    const uniq = [];
    for (const l of lines) if (uniq[uniq.length - 1] !== l) uniq.push(l);
    return uniq.join("\n").slice(0, 1800).trim();
  }

  function parseContainer(a, sel) {
    if (!a || isOurs(a)) return null;
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/post\/([A-Za-z0-9_\-]+)/);
    if (!m) return null;
    const code = m[1];
    const container = postContainerFromLink(a);
    if (!container) return null;
    const authorEl = qs(container, sel.authorLink);
    const author = authorEl
      ? (authorEl.getAttribute("href") || "").replace(/^\/@?/, "").split(/[/?]/)[0]
      : "";
    const text = extractPostText(container, author);
    const metrics = readMetrics(container, sel);
    const timeEl = qs(container, sel.timeEl);
    const time =
      timeEl?.getAttribute("datetime") || timeEl?.getAttribute("title") || "";
    const permalink =
      "https://www.threads.com" + (href.startsWith("/") ? href : "/" + href);
    const engagement =
      metrics.likes + metrics.comments * 2 + metrics.reposts * 3 + metrics.shares * 2;
    return { code, author, text, ...metrics, engagement, time, permalink, ts: Date.now() };
  }

  function parseVisiblePosts(sel) {
    if (!sel || !sel.postLink) return [];
    const links = qsa(document, sel.postLink);
    const seen = new Set();
    const posts = [];
    for (const a of links) {
      const p = parseContainer(a, sel);
      if (!p || seen.has(p.code)) continue;
      seen.add(p.code);
      posts.push(p);
    }
    return posts;
  }

  /**
   * СБОР ПОСТОВ ДО ЗАДАННОГО ЧИСЛА.
   * Лимит прокруток считается от цели; при застое пауза растёт; ленту
   * «расшевеливаем» прыжком вниз и кнопкой догрузки. Сдаёмся после 8
   * безрезультатных попыток и честно сообщаем, сколько собрали.
   */
  async function collectPosts(sel, target = 50, maxScrolls = 0, onProgress, shouldStop) {
    const byCode = new Map();
    target = Math.max(1, Number(target) || 50);
    const cap = Math.max(60, Number(maxScrolls) || 0, target * 3);
    let stagnation = 0;
    let scrolls = 0;
    const stop = () => { try { return !!(shouldStop && shouldStop()); } catch { return false; } };

    const soak = () => {
      for (const p of parseVisiblePosts(sel)) if (!byCode.has(p.code)) byCode.set(p.code, p);
    };

    soak();
    onProgress?.(byCode.size, target);

    while (byCode.size < target && scrolls < cap && !stop()) {
      const before = byCode.size;
      scrolls++;

      if (window.DST.aim) await window.DST.aim.humanScroll(window.innerHeight * 0.9);
      else window.scrollBy(0, window.innerHeight * 0.9);

      await sleep(stagnation ? Math.min(1000 + stagnation * 700, 4500) : rnd(650, 1200));
      soak();

      if (byCode.size === before) {
        stagnation++;
        if (stagnation === 2) {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
          await sleep(1500); soak();
        }
        if (stagnation === 4) {
          window.scrollBy(0, -window.innerHeight * 1.5);
          await sleep(700);
          window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
          await sleep(1800); soak();
        }
        if (stagnation === 6) {
          const more = findButtonByLabels(document.body,
            ["показать ещё", "показать еще", "show more", "load more", "see more"]);
          if (more) { try { more.click(); } catch {} await sleep(2200); soak(); }
        }
        if (stagnation >= 8) break;
      } else {
        stagnation = 0;
      }
      onProgress?.(byCode.size, target);
    }

    const all = Array.from(byCode.values());
    // Кастомные свойства массива теряются при structured clone
    // (chrome.runtime.sendMessage), поэтому счётчики отдаём отдельно —
    // см. RPC_COLLECT. Здесь оставлены только для локальных вызовов.
    const out = all.slice(0, target);
    Object.defineProperty(out, "reached", { value: out.length, enumerable: false });
    Object.defineProperty(out, "requested", { value: target, enumerable: false });
    return out;
  }

  function findButtonByLabels(root, labels) {
    const c = qsa(root || document, '[role="button"], button, a[role="link"], [aria-label]');
    for (const b of c) {
      const lbl = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase().trim();
      if (labels.some((l) => lbl.includes(String(l).toLowerCase()))) return b;
    }
    return null;
  }

  // Выбрать именно кнопку отправки: точное совпадение важнее, отключённые пропускаем.
  function findSubmitButton(scope, labels) {
    const cands = qsa(scope || document, '[role="button"],button,[aria-label]');
    let best = null, bestScore = 0;
    for (const b of cands) {
      if (b.getAttribute("aria-disabled") === "true" || b.disabled) continue;
      const txt = (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase();
      if (!txt || txt.length > 24) continue;
      for (const l of labels || []) {
        const ll = String(l).toLowerCase();
        const score = txt === ll ? 4 : txt.startsWith(ll) ? 3 : txt.endsWith(ll) ? 2 : txt.includes(ll) ? 1 : 0;
        if (score > bestScore) { bestScore = score; best = b; }
      }
    }
    return best;
  }

  /**
   * ОБЛАСТЬ КОМПОЗЕРА — где искать кнопку отправки.
   *
   * Раньше сюда передавался document.body, если ответ пишется не в модалке,
   * а прямо в ветке. Словарь кнопки отправки (WORDS.send) содержит «ответить»
   * и «reply», поэтому на странице поста лучшим совпадением оказывалась
   * кнопка «Ответить» ЧУЖОГО поста ниже по ветке: клик по ней открывал новый
   * композер вместо отправки. Внешне это и выглядело как «кнопка отправки не
   * срабатывает».
   *
   * Теперь ищем в самой узкой области, которая содержит поле ввода и хотя бы
   * одну кнопку рядом с ним.
   */
  function composerScope(editable) {
    if (!editable) return document.body;
    const dlg = editable.closest?.('[role="dialog"]');
    if (dlg) return dlg;
    const form = editable.closest?.("form");
    if (form) return form;
    let node = editable.parentElement, hops = 0;
    while (node && hops < 8) {
      let n = 0;
      for (const b of qsa(node, '[role="button"], button')) {
        if (!b.contains(editable)) n++;
      }
      if (n >= 1) return node;
      node = node.parentElement; hops++;
    }
    return document.body;
  }

  /**
   * Кнопка отправки не может стоять далеко от поля ввода. Отсекает кнопки
   * соседних постов, если область поиска всё-таки оказалась широкой.
   */
  function nearEditable(editable, btn, maxGap = 320) {
    try {
      if (!editable || !btn) return false;
      const a = editable.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      if (!b.width || !b.height) return false;
      const gap = b.top > a.bottom ? b.top - a.bottom
                : a.top > b.bottom ? a.top - b.bottom : 0;
      return gap <= maxGap;
    } catch { return true; }
  }

  function composerGone(editable) {
    if (!document.body.contains(editable)) return true;
    return fieldText(editable).trim().length === 0;
  }

  // Нормализация для сравнения: Threads может подменить кавычки/пробелы.
  function normText(t) {
    return (t || "").toLowerCase().replace(/[«»"'`’]/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * Есть ли наш текст в поле ввода прямо сейчас.
   * Читаем и innerText, и textContent, и value: ошибиться здесь опасно —
   * ложное «поле опустело» переводит отправку в статус risky и запрещает
   * повтор, а ложное «текст ещё в поле» блокирует подтверждение.
   */
  function fieldText(el) {
    if (!el) return "";
    if (typeof el.value === "string" && el.value) return el.value;
    if (typeof el.innerText === "string" && el.innerText) return el.innerText;
    return el.textContent || "";
  }
  /** Видимый текст узла. innerText есть не у всех узлов — падаем на textContent. */
  function visText(el) {
    if (!el) return "";
    const t = typeof el.innerText === "string" ? el.innerText : "";
    return t || el.textContent || "";
  }

  function textStillInField(editable, want) {
    if (!editable || !document.body.contains(editable)) return false;
    return normText(fieldText(editable)).includes(want);
  }

  /**
   * Наш текст ОПУБЛИКОВАН: он есть в дереве страницы, но не внутри
   * редактора и не внутри нашей же панели. Именно это и есть факт
   * появления комментария в ветке.
   */
  function textPublished(want, editable) {
    if (!want || want.length < 8) return false;
    const nodes = document.querySelectorAll('div[dir="auto"], span[dir="auto"], p');
    for (const n of nodes) {
      if (isOurs(n)) continue;
      if (editable && (n === editable || editable.contains(n) || n.contains(editable))) continue;
      if (n.getAttribute?.("contenteditable") === "true") continue;
      if (n.closest?.('[contenteditable="true"]')) continue;
      const t = normText(n.textContent);
      if (t && t.length < 2000 && t.includes(want)) return true;
    }
    return false;
  }

  /**
   * ПОДТВЕРЖДЕНИЕ ОТПРАВКИ.
   *
   * Успех засчитывается ТОЛЬКО по факту:
   *   • наш текст виден в ветке (не в редакторе и не в панели), ЛИБО
   *   • счётчик ответов вырос, ЛИБО
   *   • композер закрылся и текст исчез, и это состояние держится.
   * Ничего из этого — «не отправлено».
   *
   * Возвращает ещё и `emptied` — был ли момент, когда поле опустело.
   * Это нужно вызывающему, чтобы НЕ бить повторно по Ctrl+Enter: иначе
   * получался второй комментарий.
   */
  async function verifySent(editable, scope, container, text, repliesBefore, timeout = 15000) {
    const want = normText(text).slice(0, 60);
    const probe = want.slice(0, Math.min(40, want.length));
    const deadline = Date.now() + timeout;
    let emptied = false;
    let closedSince = 0;

    while (Date.now() < deadline) {
      await sleep(400);

      if (textStillInField(editable, probe.slice(0, 25))) { closedSince = 0; continue; }
      emptied = true;

      if (textPublished(probe, editable)) return { sent: true, how: "text-visible", emptied };

      if (container && repliesBefore != null) {
        const now = readMetrics(container, {}).comments;
        if (now > repliesBefore) return { sent: true, how: "counter", emptied };
      }

      const dialogGone = !document.querySelector('[role="dialog"]');
      const fieldGone = !document.body.contains(editable);
      if (fieldGone && dialogGone) {
        if (!closedSince) closedSince = Date.now();
        // держим состояние полторы секунды: мгновенное исчезновение бывает и при
        // перерисовке React, а не только при успешной публикации
        else if (Date.now() - closedSince > 1500) return { sent: true, how: "composer-closed", emptied };
      } else {
        closedSince = 0;
      }
    }
    return { sent: false, how: "no-confirmation", emptied };
  }

  /**
   * ОТПРАВКА С ПОДТВЕРЖДЕНИЕМ — без риска отправить дважды.
   *
   * Порядок: клик по кнопке (надёжнее всего), затем горячие клавиши.
   * ГЛАВНОЕ ПРАВИЛО: как только поле хотя бы раз опустело — новых попыток
   * НЕ делаем. Раньше после клика шли ещё Ctrl+Enter и Cmd+Enter, и каждая
   * могла отправить второй комментарий.
   */
  async function submitComposer(editable, scope, sel, opts = {}) {
    const { container = null, text = "", repliesBefore = null, onStep = null } = opts;
    const aim = window.DST.aim;
    const res = window.DST.resolve;
    const step = onStep || (() => {});

    // Кнопку ищем заново перед КАЖДОЙ попыткой: Lexical держит её
    // aria-disabled, пока не зарегистрирует текст, а React перемонтирует
    // панель композера после первого клика. Один поиск заранее давал
    // либо null, либо мёртвую ссылку.
    const pickSendButton = async () => {
      const b = (res ? await res.sendTarget(scope, sel) : null)
        || findSubmitButton(scope, sel.sendButtonLabels)
        || findButtonByLabels(scope, sel.sendButtonLabels);
      if (!b) return null;
      // Проверка близости нужна ТОЛЬКО когда область пришлось угадывать.
      // В модалке кнопка «Опубликовать» стоит в шапке и от высокого поля
      // ввода легко отстоит на пол-экрана — там ограничение только мешает.
      const guessed = !scope || scope === document.body ||
                      !(scope.getAttribute?.("role") === "dialog" ||
                        scope.tagName === "FORM");
      if (guessed && !nearEditable(editable, b)) return null;
      return b;
    };

    const btn = await pickSendButton();

    const attempts = [];
    if (btn) {
      const lbl = (btn.getAttribute?.("aria-label") || btn.textContent || "").trim().slice(0, 24);
      attempts.push({
        name: `кнопка «${lbl || "?"}»`,
        run: async () => {
          const live = (await pickSendButton()) || btn;
          if (!document.body.contains(live)) throw new Error("кнопка исчезла");
          if (aim) await aim.click(live, { center: false }); else live.click();
        },
      });
    }
    for (const [name, mods] of [["Ctrl+Enter", { ctrlKey: true }], ["Cmd+Enter", { metaKey: true }]]) {
      attempts.push({
        name,
        run: async () => {
          try { editable.focus(); } catch {}
          const opt = { key: "Enter", code: "Enter", keyCode: 13, which: 13,
                        bubbles: true, cancelable: true, ...mods };
          editable.dispatchEvent(new KeyboardEvent("keydown", opt));
          editable.dispatchEvent(new KeyboardEvent("keyup", opt));
        },
      });
    }

    if (!attempts.length) return { ok: false, how: "no-send-button" };

    for (let i = 0; i < attempts.length; i++) {
      const act = attempts[i];
      step(`отправляю: ${act.name}`);
      try { await act.run(); } catch { continue; }

      const v = await verifySent(editable, scope, container, text, repliesBefore,
                                 i === 0 ? 15000 : 8000);
      if (v.sent) return { ok: true, how: v.how, via: act.name };

      // Поле опустело, но подтверждения нет. Повторять НЕЛЬЗЯ: велик риск,
      // что комментарий всё-таки ушёл, и вторая попытка создаст дубль.
      if (v.emptied || !document.body.contains(editable)) {
        return { ok: false, how: "unconfirmed-but-consumed", risky: true };
      }
    }
    return { ok: false, how: "unconfirmed" };
  }

  /**
   * ВСТАВКА ТЕКСТА В ПОЛЕ THREADS — несколько стратегий с проверкой.
   * Редактор Lexical принимает не любой способ ввода, поэтому пробуем по
   * очереди и ПОСЛЕ КАЖДОЙ проверяем результат.
   */
  const TYPING_STRATEGIES = [
    {
      name: "keyboard",
      async run(el, text) {
        el.focus({ preventScroll: true });
        for (const ch of text) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
          el.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
          document.execCommand("insertText", false, ch);
          el.dispatchEvent(new InputEvent("input", {
            bubbles: true, inputType: "insertText", data: ch }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          if (Math.random() < 0.08) await sleep(rnd(30, 90));
          else await sleep(rnd(6, 20));
        }
      },
    },
    {
      name: "paste",
      async run(el, text) {
        el.focus({ preventScroll: true });
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        el.dispatchEvent(new ClipboardEvent("paste", {
          bubbles: true, cancelable: true, clipboardData: dt }));
        await sleep(400);
      },
    },
    {
      name: "beforeinput",
      async run(el, text) {
        el.focus({ preventScroll: true });
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: text }));
        await sleep(350);
      },
    },
    {
      name: "execCommand",
      async run(el, text) {
        el.focus({ preventScroll: true });
        document.execCommand("insertText", false, text);
        await sleep(300);
      },
    },
    {
      name: "textContent",
      async run(el, text) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        await sleep(300);
      },
    },
  ];

  // Рабочая стратегия хранится в storage, а не в памяти вкладки: движок
  // постоянно перезагружает страницу (ротация лента↔поиск, переход на
  // пермалинк), и найденный способ ввода терялся при каждой навигации.
  let PREFERRED_STRATEGY = "";
  try {
    chrome.storage.local.get("_typeStrategy", (o) => {
      if (o && typeof o._typeStrategy === "string") PREFERRED_STRATEGY = o._typeStrategy;
    });
  } catch {}
  function rememberStrategy(name) {
    if (!name || name === PREFERRED_STRATEGY) return;
    PREFERRED_STRATEGY = name;
    try { chrome.storage.local.set({ _typeStrategy: name }); } catch {}
  }

  /** Поле живо: в документе и всё ещё редактируемое. */
  function editableAlive(el) {
    return !!el && document.body.contains(el) &&
      (el.getAttribute?.("contenteditable") === "true" ||
       el.tagName === "TEXTAREA" || el.tagName === "INPUT");
  }

  /**
   * Дождаться, пока редактор ПЕРЕСТАНЕТ пересоздаваться.
   *
   * На свежезагруженной странице поста Lexical монтируется 1–3 раза подряд
   * (гидратация React, подмена инлайн-поля модалкой, догрузка ветки). Узел,
   * найденный через 200 мс после клика по «Ответить», к моменту вставки уже
   * заменён другим — и любая работа с ним падала как «поле исчезло».
   *
   * Здесь мы держим поле под наблюдением: пока оно живо stableMs подряд —
   * считаем, что редактор устоялся. Если умерло — берём новое через
   * reacquire() и отсчёт начинается заново.
   */
  async function waitEditableStable(el, opts = {}) {
    const stableMs = Number(opts.stableMs) || 600;
    const timeout = Number(opts.timeout) || 7000;
    const reacquire = typeof opts.reacquire === "function" ? opts.reacquire : null;
    let cur = editableAlive(el) ? el : null;
    let since = Date.now();
    const t0 = Date.now();

    while (Date.now() - t0 < timeout) {
      if (editableAlive(cur)) {
        if (Date.now() - since >= stableMs) return cur;
        await sleep(120);
        continue;
      }
      cur = reacquire ? await reacquire().catch(() => null) : null;
      since = Date.now();
      if (!cur) await sleep(200);
    }
    return editableAlive(cur) ? cur : null;
  }

  /**
   * ВСТАВКА С ВОССТАНОВЛЕНИЕМ ПОЛЯ.
   *
   * Раньше первым же действием шёл clearEditable() по ПУСТОМУ полю:
   * selectAll + execCommand("delete") по пустому Lexical-редактору Threads
   * заставляет его схлопнуться и перемонтироваться. Следующая же строка
   * (`document.body.contains(el)`) видела мёртвый узел и возвращала
   * «поле исчезло» — на первом же лиде, до единой попытки ввода.
   *
   * Теперь: пустое поле не чистим вовсе, а если узел всё-таки умер —
   * берём поле заново (reacquire) и повторяем, до 3 кругов.
   */
  async function setEditableText(el, text, opts = {}) {
    const reacquire = typeof opts.reacquire === "function" ? opts.reacquire : null;
    const step = opts.onStep || (() => {});

    let target = editableAlive(el) ? el : (reacquire ? await reacquire().catch(() => null) : null);
    if (!target) return { ok: false, how: "", error: "нет поля" };

    // ждём, пока редактор устоится — до ввода, а не после
    const stable = await waitEditableStable(target, {
      reacquire, stableMs: Number(opts.stableMs) || 600, timeout: 7000 });
    if (stable) target = stable;

    for (let round = 0; round < 3; round++) {
      if (!editableAlive(target)) {
        if (!reacquire) return { ok: false, how: "", error: "поле исчезло" };
        step("поле пересоздалось — беру его заново");
        target = await waitEditableStable(null, { reacquire, stableMs: 500, timeout: 6000 });
        if (!target) {
          return { ok: false, how: "", error: "поле исчезло и не появилось снова" };
        }
      }

      const r = await typeInto(target, text, opts);
      if (r.ok || r.alreadySent) return r;
      if (r.lost) { target = null; continue; }   // ещё круг, уже с новым полем
      return r;
    }
    return { ok: false, how: "",
             error: "поле ответа постоянно пересоздаётся — Threads не даёт вставить текст" };
  }

  /** Один заход по всем стратегиям в конкретное (живое) поле. */
  async function typeInto(el, text, opts = {}) {
    if (window.DST.aim) await window.DST.aim.scrollToCenter(el, { tolerance: 160 });
    try { el.focus({ preventScroll: true }); } catch {}
    await sleep(rnd(120, 260));
    if (!editableAlive(el)) return { ok: false, how: "", lost: true };

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true, how: "native-setter" };
    }

    const order = TYPING_STRATEGIES.slice().sort(
      (a, b) => (b.name === PREFERRED_STRATEGY) - (a.name === PREFERRED_STRATEGY));

    for (const st of order) {
      // Чистим ТОЛЬКО если в поле реально что-то есть.
      if (fieldText(el).trim()) {
        await clearEditable(el);
        if (!editableAlive(el)) return { ok: false, how: st.name, lost: true };
      }

      try { await st.run(el, text); } catch { continue; }
      await sleep(220);

      if (!editableAlive(el)) {
        // Поле умерло уже ПОСЛЕ ввода. Такое бывает, когда Threads сам
        // отправил ответ по Enter. Повторять вслепую нельзя — сначала
        // проверяем, не висит ли наш текст уже в ветке.
        const probe = normText(text).slice(0, 40);
        if (textPublished(probe, null)) {
          rememberStrategy(st.name);
          opts.onStep?.("текст ушёл в ветку прямо при вводе — повтор не делаю");
          return { ok: false, how: st.name, alreadySent: true };
        }
        return { ok: false, how: st.name, lost: true };
      }

      if (editableHas(el, text)) {
        const weak = st.name === "textContent";
        if (!weak) rememberStrategy(st.name);
        opts.onStep?.(weak
          ? "текст вставлен запасным способом — отправка может не пройти"
          : `текст вставлен (способ: ${st.name})`);
        return { ok: true, how: st.name, weak, el };
      }
      opts.onStep?.(`способ «${st.name}» не сработал, пробую следующий`);
    }
    return { ok: false, how: "", error: "ни один способ ввода не принят редактором Threads" };
  }

  /**
   * Очистить contenteditable.
   * Раньше при неудаче шёл цикл до 400 синхронных Backspace + execCommand —
   * это подвешивало вкладку на секунды. Теперь максимум 3 подхода с паузой.
   */
  async function clearEditable(el) {
    try {
      el.focus({ preventScroll: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = fieldText(el).trim();
        if (!cur) return;
        const s = window.getSelection();
        if (s) {
          s.removeAllRanges();
          const r = document.createRange(); r.selectNodeContents(el); s.addRange(r);
        }
        document.execCommand("selectAll", false, null);
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true, cancelable: true, inputType: "deleteContentBackward" }));
        document.execCommand("delete", false, null);
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "deleteContentBackward" }));
        await sleep(120);
      }
      // последний шанс — короткая серия Backspace, но не 400 итераций
      if ((el.innerText || "").trim()) {
        for (let i = 0; i < 40; i++) {
          el.dispatchEvent(new KeyboardEvent("keydown",
            { key: "Backspace", keyCode: 8, which: 8, bubbles: true, cancelable: true }));
          document.execCommand("delete", false, null);
          if (i % 10 === 9) await sleep(30);
          if (!(el.innerText || "").trim()) break;
        }
      }
    } catch {}
  }

  /** Виден ли наш текст в поле (или в его контейнере — Lexical рисует в детях). */
  function editableHas(el, text) {
    const want = normText(text).slice(0, 24);
    if (!want) return true;
    const here = normText(fieldText(el));
    if (here.includes(want)) return true;
    const box = el && (el.closest('[role="dialog"]') || el.parentElement);
    return !!box && normText(box.innerText).includes(want);
  }

  /** Диагностика ввода для «Калибровки». Ничего не отправляет. */
  async function diagnoseInsertion(sel) {
    const out = [];
    const f = window.DST.find?.replyFieldFor(null, sel);
    const el = (f && f.el) || qs(document, sel.editable);
    if (!el) return { ok: false, error: "поле ввода не открыто — открой пост и нажми «Ответить»" };
    const probe = "проверка ввода 12345";
    // Поле может пересоздаваться между стратегиями — берём его заново,
    // иначе калибровка показывала «не работает ничего» на живом редакторе.
    const grab = async () => {
      const f2 = window.DST.find?.replyFieldFor(null, sel);
      if (f2 && f2.el && isVisibleEl(f2.el)) return f2.el;
      return findActiveEditable(sel);
    };
    let cur = el;
    for (const st of TYPING_STRATEGIES) {
      if (!editableAlive(cur)) cur = await waitEditableStable(null, { reacquire: grab, stableMs: 400, timeout: 4000 });
      if (!cur) { out.push({ name: st.name, ok: false, note: "поле пропало" }); continue; }
      if (fieldText(cur).trim()) await clearEditable(cur);
      let ok = false;
      try { await st.run(cur, probe); await sleep(250); ok = editableAlive(cur) && editableHas(cur, probe); } catch {}
      out.push({ name: st.name, ok });
    }
    if (editableAlive(cur)) await clearEditable(cur);
    const good = out.filter((x) => x.ok).map((x) => x.name);
    if (good.length) rememberStrategy(good[0]);
    return { ok: !!good.length, tried: out, working: good };
  }

  function containerByCode(code) {
    if (!code) return null;
    const a = qsa(document, `a[href*="/post/${code}"]`)[0];
    if (a) {
      const c = postContainerFromLink(a);
      // Слишком узкий контейнер (одна шапка карточки) бесполезен: в нём нет
      // строки действий, и лестница «открыть ответ» оставалась пустой.
      if (c && visText(c).trim().length > 25) return c;
    }
    // На странице самой ветки у главного поста ссылки на себя может не быть
    // вовсе. Тогда целевой пост — первая содержательная карточка сверху.
    if (location.pathname.includes(`/post/${code}`) || /\/post\//.test(location.pathname)) {
      const cards = qsa(document, "[data-pressable-container]")
        .filter((el) => el.querySelector('a[href^="/@"]') &&
                        visText(el).trim().length > 25);
      if (cards.length) {
        // самая верхняя из них и есть пост, ради которого открыли страницу
        return cards.reduce((best, el) =>
          !best || el.getBoundingClientRect().top < best.getBoundingClientRect().top ? el : best, null);
      }
      const art = qsa(document, "article")[0];
      if (art) return art;
    }
    return a ? postContainerFromLink(a) : null;
  }

  function detectContext() {
    const path = location.pathname || "";
    if (path.startsWith("/messages")) return "dm";
    if (document.querySelector('[role="dialog"] [contenteditable="true"], [role="dialog"] textarea')) return "compose";
    if (/\/post\//.test(path)) return "post";
    return "feed";
  }

  function findActiveEditable(sel) {
    const isEditable = (el) => el && !isOurs(el) &&
      (el.getAttribute?.("contenteditable") === "true" || el.tagName === "TEXTAREA");
    // Вьюпорт не требуется: форма ответа на странице поста стоит ниже ветки,
    // и проверка «на экране» отбрасывала её вместе со всем остальным.
    const vis = (el) => {
      if (!el || !document.body.contains(el)) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 40 && r.height > 12)) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && +st.opacity !== 0;
    };
    const a = document.activeElement;
    if (isEditable(a) && vis(a)) return a;
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) {
      const e = qsa(dlg, '[contenteditable="true"], textarea')[0];
      if (vis(e)) return e;
    }
    const all = qsa(document, sel.editable).filter(vis);
    if (all.length) {
      const cy = (window.innerHeight || 800) / 2;
      all.sort((x, y) => Math.abs(x.getBoundingClientRect().top - cy) - Math.abs(y.getBoundingClientRect().top - cy));
      return all[0];
    }
    return null;
  }

  function likePost(container, sel) {
    try {
      const res = window.DST.resolve;
      if (res) {
        const t = res.likeTarget(container || document.body);
        if (!t) return "nofind";
        if (t.already) return "already";
        if (window.DST.aim) window.DST.aim.click(t.el, { center: false });
        else t.el.click();
        return "liked";
      }
      const btns = qsa(container || document, '[aria-label],[role="button"],button,svg');
      for (const b of btns) {
        const host = b.closest('[role="button"],button,a') || b;
        if (isOurs(host)) continue;
        const lab = (host.getAttribute?.("aria-label") || host.textContent || "").toLowerCase();
        if ((sel.unlikeLabels || []).some((l) => lab.includes(l.toLowerCase()))) return "already";
        if ((sel.likeButtonLabels || []).some((l) => lab.includes(l.toLowerCase()))) {
          window.DST.aim ? window.DST.aim.click(host, { center: false }) : host.click();
          return "liked";
        }
      }
    } catch {}
    return "nofind";
  }

  /** Устаревший путь. Оставлен как запасной; калибровка его больше не использует. */
  function replyCandidates(scope, sel) {
    const out = [];
    const push = (el) => { if (el && !isOurs(el) && !out.includes(el)) out.push(el); };
    qsa(scope || document, '[aria-label],[role="button"],button,a[role="link"]').forEach((b) => {
      const lab = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase().trim();
      if ((sel.replyButtonLabels || []).some((l) => lab.includes(String(l).toLowerCase()))) push(b);
    });
    const res = window.DST.resolve;
    if (res) { const row = res.actionRow(scope || document); if (row[1]) push(row[1].el); }
    const link = qs(scope || document, sel.postLink);
    if (link) push(link);
    return out;
  }

  /**
   * ЛЕСТНИЦА ТАКТИК «ОТКРЫТЬ ОТВЕТ».
   *
   * Порядок от самого надёжного к самому грубому. Каждая тактика
   * подписана — в логе видно, какая сработала, а какая нет.
   *
   * Главное отличие от прежней версии: цели, которые УВОДЯТ СО СТРАНИЦЫ,
   * на странице поста исключены полностью. Раньше последней целью в списке
   * шла ссылка на сам пост; клик по ней перезагружал вкладку прямо посреди
   * RPC — отсюда «Could not establish connection» и «message channel closed».
   */
  function navigatesAway(el) {
    const href = el?.getAttribute?.("href") || "";
    if (!href || href.startsWith("#")) return false;
    try {
      const u = new URL(href, location.href);
      return u.pathname !== location.pathname;
    } catch { return true; }
  }

  /**
   * Форма ответа под веткой: «Ответьте lunora.ru…», «Reply to …».
   *
   * ПОЧЕМУ ПЕРЕПИСАНО. Раньше кандидаты брались только из
   * '[role="button"], button, [contenteditable], textarea, [aria-placeholder]'.
   * На странице ветки Threads рисует эту строку ОБЫЧНЫМ <div> без role и без
   * placeholder-атрибутов — она не попадала в список вовсе. В логе это
   * выглядело как «целей не нашлось вовсе. Редакторов на странице: 0», хотя
   * поле «Ответьте …» было прямо на экране.
   *
   * Теперь ищем по тексту среди всех узлов, а кликаем по ближайшему
   * кликабельному предку.
   */
  const REPLY_PROMPT_RE =
    /^(ответьте|ответить|ответ\b|напишите ответ|reply to|reply\b|responder a|répondre à|antworte|rispondi a|balas|回复|返信)/i;
  const REPLY_HINT_RE = /(ответ|reply|коммент|comment|responder|répond|antwort)/i;

  /** Ближайший предок, по которому имеет смысл кликать. */
  function clickableHost(el) {
    const host = el.closest?.('[role="button"], button, [contenteditable="true"], textarea, [role="textbox"], form');
    if (host && !isOurs(host)) return host;
    // Threads вешает обработчик на контейнер строки — поднимаемся немного вверх
    let n = el, hops = 0;
    while (n && hops < 3) {
      const r = n.getBoundingClientRect?.();
      if (r && r.width >= 200 && r.height >= 28) return n;
      n = n.parentElement; hops++;
    }
    return el;
  }

  function replyPromptTargets(sel) {
    const found = new Map();
    const add = (el, why, score) => {
      if (!el || isOurs(el) || !document.body.contains(el)) return;
      if (navigatesAway(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 14) return;
      if (!isVisibleEl(el)) return;
      const prev = found.get(el);
      if (!prev || score > prev.score) found.set(el, { el, why, y: r.top, score });
    };

    // 1) Явные подсказки в атрибутах — самый чистый сигнал.
    for (const el of qsa(document, "[aria-placeholder], [data-placeholder], [placeholder], [aria-label]")) {
      const hint = el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") ||
                   el.getAttribute("placeholder") || el.getAttribute("aria-label") || "";
      if (REPLY_HINT_RE.test(hint)) add(clickableHost(el), "reply-placeholder", 3);
    }

    // 2) Текст «Ответьте …» на любом узле, не только на кнопке.
    //    Берём САМЫЙ ГЛУБОКИЙ узел с этим текстом, иначе под условие
    //    подходит и <body>, и половина дерева.
    for (const el of qsa(document, "div, span, p")) {
      if (isOurs(el)) continue;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 80) continue;
      if (!REPLY_PROMPT_RE.test(t)) continue;
      // только листья: если у потомка тот же текст, цель — потомок
      let deepest = el, guard = 0;
      while (guard++ < 5) {
        const kid = Array.prototype.find.call(deepest.children || [],
          (c) => (c.textContent || "").trim() === t);
        if (!kid) break;
        deepest = kid;
      }
      add(clickableHost(deepest), "reply-prompt", 2);
    }

    // 3) Кнопки со словом «ответ» — как было раньше.
    for (const el of qsa(document, '[role="button"], button, [contenteditable="true"], textarea')) {
      const txt = (el.innerText || "").trim().slice(0, 60);
      if (REPLY_HINT_RE.test(txt)) add(el, "reply-button", 1);
    }

    // Форма ответа на сам пост стоит НИЖЕ поста и ВЫШЕ чужих ответов.
    // Сортируем по убыванию уверенности, затем сверху вниз.
    return Array.from(found.values())
      .sort((a, b) => b.score - a.score || a.y - b.y)
      .slice(0, 4);
  }

  /** Уже отрисованный редактор где угодно на странице (даже ниже экрана). */
  function bareEditableTargets(sel) {
    return qsa(document, sel.editable)
      .filter((e) => !isOurs(e) && document.body.contains(e) && isVisibleEl(e))
      .map((el) => ({ el, why: "bare-editable" }));
  }

  /* ══════════════════════════════════════════════════════════
     ТЕЛЕМЕТРИЯ ОТКАЗОВ

     «Автокомментинг иногда не срабатывает» — это не одна поломка, а
     минимум шесть разных, и лечатся они по-разному. Отчёт об отказе у
     нас был и раньше, но жил одной строкой в логе и никуда не
     складывался: через сто попыток мы всё так же не знали, что именно
     ломается чаще.

     Теперь каждая попытка проходит по стадиям, и на каждой пишется
     исход. Счётчики лежат в chrome.storage.local._diag — не на сервере
     и не в памяти страницы: перезагрузка их не теряет, а спящий фон
     не мешает записи.
     ══════════════════════════════════════════════════════════ */
  const STAGES = ["post", "target", "field", "input", "submit", "confirm"];

  // Что делать с отказом, решает причина, а не счётчик попыток.
  // Три слепых повтора по посту, где нет кнопки отправки, — это три
  // одинаковых промаха и втрое больше подозрительной активности.
  const RETRY_POLICY = {
    POST_NOT_FOUND:        "retry",
    CONTAINER_MISSING:     "retry",
    REPLY_TARGET_NOT_FOUND:"no-retry",   // сборка Threads другая — повтор не поможет
    FIELD_NOT_FOUND:       "retry",
    FIELD_LOST:            "retry",
    INPUT_REJECTED:        "no-retry",   // ни один способ ввода не принят
    NAV_LOST:              "retry",
    SUBMIT_NOT_FOUND:      "no-retry",
    SUBMIT_UNCONFIRMED:    "retry",
    RISKY_CONSUMED:        "never",      // текст мог уйти — повтор даст дубль
  };

  function newTrace(code) {
    return {
      code, at: Date.now(),
      reached: [],                 // докуда дошли
      fail: null, detail: "",
    };
  }
  function reach(tr, stage) { if (tr && !tr.reached.includes(stage)) tr.reached.push(stage); }

  /** Закрыть попытку и записать её в счётчики. Возвращает результат как есть. */
  async function seal(tr, result, failCode, detail) {
    if (!tr) return result;
    if (failCode) { tr.fail = failCode; tr.detail = detail || result?.error || ""; }
    if (result?.ok) reach(tr, "confirm");
    try { await recordAttempt(tr); } catch {}
    if (failCode) {
      result.stage = tr.reached[tr.reached.length - 1] || "post";
      result.reason = failCode;
      result.retry = RETRY_POLICY[failCode] || "no-retry";
    }
    return result;
  }

  async function recordAttempt(tr) {
    const { _diag } = await chrome.storage.local.get("_diag");
    const d = _diag || { since: Date.now(), attempts: 0, sent: 0, stages: {}, reasons: {}, last: [] };
    d.attempts++;
    if (!tr.fail) d.sent++;
    for (const s of STAGES) {
      d.stages[s] = d.stages[s] || { reached: 0, lost: 0 };
      if (tr.reached.includes(s)) d.stages[s].reached++;
    }
    if (tr.fail) {
      d.reasons[tr.fail] = (d.reasons[tr.fail] || 0) + 1;
      const lostAt = tr.reached[tr.reached.length - 1] || "post";
      d.stages[lostAt] = d.stages[lostAt] || { reached: 0, lost: 0 };
      d.stages[lostAt].lost++;
    }
    // Последние двадцать попыток целиком — чтобы можно было посмотреть
    // не только «сколько», но и «как именно» ломалось.
    d.last.unshift({ code: tr.code, at: tr.at, ok: !tr.fail,
                     fail: tr.fail, stage: tr.reached[tr.reached.length - 1] || "post",
                     detail: (tr.detail || "").slice(0, 200) });
    d.last = d.last.slice(0, 20);
    await chrome.storage.local.set({ _diag: d });
  }

  async function commentOnPost(code, text, sel, mode, opts = {}) {
    const tr = newTrace(code);
    const aim = window.DST.aim;
    const res = window.DST.resolve;
    const step = opts.onStep || (() => {});

    // Ждём саму карточку поста. Раньше на свежезагруженном пермалинке
    // containerByCode() возвращал null (ветка ещё скелетон), container
    // становился document.body — и кнопка «Ответить» бралась от чужого
    // поста в рекомендациях либо не находилась вовсе.
    let container = containerByCode(code);
    if (!container) {
      step("жду загрузку ветки…");
      container = await waitFor(() => containerByCode(code), 9000);
    }
    if (!container) {
      step("карточка поста не отрисовалась — работаю по странице целиком");
      container = document.body;
    } else reach(tr, "post");

    if (aim && container !== document.body) await aim.scrollToCenter(container);

    const repliesBefore = container !== document.body
      ? readMetrics(container, sel).comments : null;

    let liked = false;
    if (opts.like) { const r = likePost(container, sel); liked = r === "liked"; }

    // Как заново найти поле ответа, если React его перемонтировал.
    // Контейнер тоже переспрашиваем: при догрузке ветки карточка поста
    // пересоздаётся вместе с полем.
    const reacquire = async () => {
      const cont = containerByCode(code) || container;
      const f = window.DST.find?.replyFieldFor(cont, sel);
      if (f && f.el && isVisibleEl(f.el)) return f.el;
      const any = qs(document, sel.editable);
      if (any && isVisibleEl(any)) return any;
      return findActiveEditable(sel);
    };

    let editable = null;
    const already = window.DST.find?.replyFieldFor(container, sel);
    // Открытое поле берём ТОЛЬКО если оно пустое. Иначе можно дописать свой
    // комментарий к чужому недописанному черновику — так в ленте оставались
    // склейки вида «… 😊 😊».
    if (already && already.el && isVisibleEl(already.el) &&
        !fieldText(already.el).trim()) {
      editable = already.el;
    } else if (document.querySelector('[role="dialog"]')) {
      await closeComposer();          // подчищаем чужой/старый композер
      await sleep(300);
    }

    let usedWhy = "already-open";

    // Открыть ответ: тактики по убыванию надёжности, с отчётом в лог.
    const onPostPage = /\/post\//.test(location.pathname);
    const tried = [];

    const openReply = async () => {
      const cont = containerByCode(code) || container;

      // 1) уже открытое пустое поле
      // 2) кнопка «Ответить» в строке действий поста
      // 3) форма «Ответьте пользователю …» под веткой
      // 4) любой отрисованный редактор на странице
      const ladder = [];
      ladder.push(...bareEditableTargets(sel).map((t) => ({ ...t, direct: true })));
      const rowTargets = res
        ? await res.replyTargets(cont, sel)
        : replyCandidates(cont, sel).map((el) => ({ el, why: "legacy" }));
      ladder.push(...rowTargets);
      ladder.push(...replyPromptTargets(sel));

      // ЗАПАСНОЙ ПРОХОД ПО ВСЕЙ СТРАНИЦЕ.
      // containerByCode() ищет карточку по ссылке a[href*="/post/CODE"].
      // На странице самой ветки у главного поста такой ссылки часто нет
      // вовсе, и контейнером становился либо крошечный кусок разметки, либо
      // document.body. В первом случае replyTargets() возвращал пустоту —
      // отсюда «целей не нашлось вовсе» при живом поле «Ответьте …».
      if (!ladder.length && res) {
        ladder.push(...(await res.replyTargets(document, sel)));
        step("целей у карточки нет — ищу по всей странице");
      }

      for (const t of ladder) {
        if (!t.el || isOurs(t.el) || !document.body.contains(t.el)) continue;

        // Клик, уводящий со страницы, убивает content-script посреди RPC.
        // На странице поста такие цели не трогаем вообще.
        if (onPostPage && navigatesAway(t.el)) {
          tried.push(`${t.why}: пропущена (увела бы со страницы)`);
          continue;
        }

        usedWhy = t.why;

        // Уже готовое поле — кликать по нему не нужно, только сфокусировать.
        if (t.direct && !fieldText(t.el).trim()) {
          if (aim) await aim.scrollToCenter(t.el, { tolerance: 160 });
          try { t.el.focus({ preventScroll: true }); } catch {}
          tried.push(`${t.why}: взято готовое поле`);
          return t.el;
        }

        const lbl = (t.el.getAttribute?.("aria-label") || t.el.textContent || "").trim().slice(0, 24);
        step(`открываю ответ: ${t.why}${lbl ? ` «${lbl}»` : ""}`);
        if (aim) await aim.click(t.el);
        else { try { t.el.click(); } catch {} }

        const got = await waitFor(async () => {
          const el2 = await reacquire();
          return el2 && isVisibleEl(el2) ? el2 : null;
        }, 4500);
        if (got) { tried.push(`${t.why}: сработала`); return got; }

        tried.push(`${t.why}: поле не появилось`);
        await closeStrayPopovers();
        await sleep(400);
      }
      return findActiveEditable(sel);
    };

    // Два полных захода: если поле умерло насмерть, закрываем композер,
    // жмём «Ответить» заново и пробуем ещё раз. Раньше первая же осечка
    // сжигала лид на 12 часов.
    let ins = null, live = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!editable || !editableAlive(editable)) editable = await openReply();
      if (!editable) {
        if (attempt === 0) { await closeStrayPopovers(); await sleep(600); continue; }
        // Внятный отчёт вместо «попробуй калибровку»: видно, что именно
        // было испробовано и на чём остановилось.
        const diag = [
          `редакторов: ${qsa(document, sel.editable).length}`,
          `кнопок: ${qsa(document, '[role="button"],button').length}`,
          `форм ответа: ${replyPromptTargets(sel).length}`,
          `карточка поста: ${containerByCode(code) ? "найдена" : "НЕ найдена"}`,
          `url: ${location.pathname}`,
        ].join(", ");
        // Цели не нашлись вовсе и поле не нашлось — разные диагнозы.
        // Первое означает, что вёрстка Threads другая (повтор бесполезен),
        // второе — что поле не успело подняться (повтор осмыслен).
        const noTargets = tried.length === 0;
        if (!noTargets) reach(tr, "target");
        return await seal(tr,
          { ok: false, liked,
            error: "не нашёл поле ответа. Испробовано → " +
                   (tried.length ? tried.join("; ") : "целей не нашлось вовсе") +
                   `. На странице: ${diag}` },
          noTargets ? "REPLY_TARGET_NOT_FOUND" : "FIELD_NOT_FOUND", diag);
      }

      step("поле ответа найдено");
      reach(tr, "target"); reach(tr, "field");
      ins = await setEditableText(editable, text, { onStep: step, reacquire });
      await sleep(rnd(400, 900));

      // Threads отправил текст сам при вводе — считаем пост занятым,
      // повторять нельзя.
      if (ins.alreadySent) {
        return await seal(tr,
          { ok: false, liked, via: usedWhy, risky: true,
            error: "текст ушёл при вводе без подтверждения — повтор запрещён (риск дубля)" },
          "RISKY_CONSUMED");
      }

      if (ins.ok) { live = ins.el || editable; break; }

      step(`не вышло вставить: ${ins.error || "?"}`);
      await closeComposer();
      await sleep(700);
      editable = null;
    }

    if (!ins || !ins.ok) {
      await closeComposer();
      return await seal(tr,
        { ok: false, liked, error: (ins && ins.error) || "текст не вставился в поле ответа" },
        ins?.lost ? "FIELD_LOST" : "INPUT_REJECTED");
    }
    step(`текст введён (${ins.how})`);
    reach(tr, "input");

    // Ручной режим: черновик оставлен человеку, отправки не было —
    // это не «дошли до конца», и в статистику успехов это не идёт.
    if (mode !== "auto") return { ok: true, drafted: true, liked, via: usedWhy };

    const dialog = composerScope(live);
    const r = await submitComposer(live, dialog, sel,
                                   { container: containerByCode(code) || container,
                                     text, repliesBefore, onStep: step });
    reach(tr, "submit");
    if (r.ok) return await seal(tr, { ok: true, sent: true, liked, via: usedWhy, confirmed: r.how });

    await closeComposer();
    return await seal(tr,
      { ok: false, liked, via: usedWhy, risky: !!r.risky,
        error: r.risky
          ? "поле очистилось, но подтверждения нет — считаю пост обработанным, чтобы не отправить дважды"
          : "отправка не подтвердилась — комментарий не ушёл" },
      r.risky ? "RISKY_CONSUMED"
              : (r.how === "no-send-button" ? "SUBMIT_NOT_FOUND" : "SUBMIT_UNCONFIRMED"));
  }

  /** Закрыть случайно открытую карточку профиля / меню. */
  async function closeStrayPopovers() {
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      await sleep(250);
    } catch {}
  }

  /** Закрыть открытый композер и снять черновик. */
  async function closeComposer() {
    try {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return;
      document.body.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      await sleep(600);
      if (!document.querySelector('[role="dialog"]')) return;
      const cancel = findButtonByLabels(document.body,
        ["отмена", "отменить", "discard", "cancel", "удалить", "не сохранять"]);
      if (cancel) { try { cancel.click(); } catch {} await sleep(500); }
    } catch {}
  }

  function isVisibleEl(el) {
    if (!el || isOurs(el) || !document.body.contains(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 10) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && +st.opacity !== 0;
  }

  async function attachFile(dialog, sel, file) {
    if (!file) return false;
    try {
      const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
      const f = new File([bytes], file.name || "upload", { type: file.mime || "application/octet-stream" });
      let input = qs(dialog || document, sel.fileInput);
      if (!input) {
        const attach = findButtonByLabels(dialog || document.body, sel.attachLabels);
        if (attach?.click) attach.click();
        input = await waitFor(() => qs(dialog || document, sel.fileInput), 2500);
      }
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1500);
      return true;
    } catch (e) { return false; }
  }

  /**
   * Поле ввода именно того композера, который сейчас открыт.
   *
   * Раньше здесь стоял qs(document, sel.editable) — то есть ПЕРВОЕ
   * contenteditable на странице. На профиле и в ленте таких полей два:
   * модальное окно «Новая ветка» и строка «Что нового?» под шапкой.
   * Скрипт брал строку из-под шапки, вставлял туда текст, и Lexical его
   * не принимал — отсюда «ни один способ ввода не принят редактором».
   * Приоритет теперь обратный: сначала верхний открытый диалог.
   */
  function composerField(sel) {
    const dialogs = qsa(document, '[role="dialog"]').filter(isVisibleEl);
    // самый «верхний» диалог — последний в DOM
    for (let i = dialogs.length - 1; i >= 0; i--) {
      const e = qsa(dialogs[i], '[contenteditable="true"], textarea')
        .filter((x) => isVisibleEl(x) && !window.DST.ours?.isOurs(x))[0];
      if (e) return e;
    }
    const found = window.DST.find?.composerField(sel);
    if (found?.el && isVisibleEl(found.el)) return found.el;
    const page = qsa(document, sel.editable)
      .filter((x) => isVisibleEl(x) && !window.DST.ours?.isOurs(x));
    // из полей страницы берём самое крупное: у настоящего композера
    // площадь заметно больше, чем у однострочной заглушки
    page.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return page[0] || findActiveEditable(sel);
  }

  async function createPost(text, sel, mode, file) {
    const trigger = findButtonByLabels(document.body, sel.composerTriggerLabels);
    if (trigger?.click) {
      if (window.DST.aim) await window.DST.aim.click(trigger);
      else trigger.click();
    }

    // Ждём именно открытия диалога, а не появления любого поля: поле
    // «Что нового?» на странице есть всегда, и ожидание завершалось
    // мгновенно ещё до того, как окно композера успевало открыться.
    await waitFor(() => qsa(document, '[role="dialog"]').filter(isVisibleEl)[0] || null, 5000);

    let editable = await waitFor(() => {
      const e = composerField(sel);
      return e && isVisibleEl(e) ? e : null;
    }, 6000) || composerField(sel);

    if (!editable) {
      const dl = qsa(document, '[role="dialog"]').filter(isVisibleEl).length;
      const ed = qsa(document, sel.editable).filter(isVisibleEl).length;
      return { ok: false,
               error: `не появился композер (диалогов на странице ${dl}, полей ввода ${ed}). ` +
                      "Откройте threads.com и попробуйте ещё раз." };
    }

    // Lexical принимает ввод только в сфокусированное поле. Один клик по
    // самому полю снимает большую часть отказов «ввод не принят».
    try {
      if (window.DST.aim) await window.DST.aim.click(editable, { center: false });
      else editable.focus?.();
      await sleep(rnd(150, 320));
    } catch (e) { /* фокус не критичен, пробуем вставлять как есть */ }

    const grabComposer = async () => composerField(sel);
    const insP = await setEditableText(editable, text, { reacquire: grabComposer });
    if (insP.alreadySent) return { ok: false, risky: true, error: "пост ушёл при вводе — повтор запрещён" };
    if (!insP.ok) { await closeComposer(); return { ok: false, error: insP.error || "текст поста не вставился" }; }
    editable = insP.el || editable;

    const dialog = editable.closest('[role="dialog"]') || document.body;
    let attached = false;
    if (file) attached = await attachFile(dialog, sel, file);
    await sleep(rnd(600, 1100));
    if (mode !== "auto") return { ok: true, drafted: true, attached };

    const sent = await submitComposer(editable, dialog, sel, { text });
    if (sent.ok) return { ok: true, sent: true, attached, confirmed: sent.how };
    await closeComposer();
    return { ok: false, drafted: true, attached, risky: !!sent.risky,
             error: sent.risky ? "публикация не подтвердилась (возможно, пост всё же ушёл)"
                               : "не удалось нажать публикацию" };
  }

  // ══════════════════════════════════════════════════════════
  //  ДИРЕКТ (messages)
  // ══════════════════════════════════════════════════════════
  /**
   * Строки списка диалогов.
   *
   * Раньше здесь искались только ссылки a[href*="/messages/"]. В текущем
   * Threads строка диалога — это обычный <div> с обработчиком клика, а не
   * ссылка, поэтому список получался пустым и режим Директ «не находил,
   * куда нажать». Теперь ссылки — только быстрый путь, а основной способ
   * структурный: ищем колонку, в которой лежит несколько похожих строк
   * с аватаркой и двумя строками текста.
   */
  function dmRows() {
    // 1) Быстрый путь: настоящие ссылки на переписку.
    const links = qsa(document, 'a[href*="/messages/"]')
      .filter((a) => /\/messages\/(t\/)?[^/]+/.test(a.getAttribute("href") || ""))
      .filter((a) => (a.getAttribute("href") || "") !== "/messages")
      .filter(isVisibleEl);
    if (links.length >= 2) return links;

    // 2) Явная семантика списка, если разметка её отдаёт.
    const items = qsa(document, '[role="listitem"], [role="row"], [role="option"]')
      .filter(isVisibleEl)
      .filter((r) => (r.innerText || r.textContent || "").trim().length > 2);
    if (items.length >= 2) return items;

    // 3) Структурный разбор. Кандидат в строку диалога: видимый блок
    //    высотой примерно с аватарку, внутри картинка или кружок-заглушка
    //    и хотя бы одна строка текста. Настоящий список — тот, где таких
    //    соседей подряд больше всего.
    const cand = [];
    qsa(document, "div, li").forEach((el) => {
      if (window.DST.ours?.isOurs(el)) return;
      if (!isVisibleEl(el)) return;
      const r = el.getBoundingClientRect();
      if (r.height < 44 || r.height > 130 || r.width < 180) return;
      const txt = (el.innerText || el.textContent || "").trim();
      if (txt.length < 2 || txt.length > 300) return;
      const hasAvatar = !!el.querySelector('img, [role="img"], svg, [data-visualcompletion="ignore-dynamic"]');
      if (!hasAvatar) return;
      // вложенные обёртки одной и той же строки отсекаем: берём тот блок,
      // у которого родитель заметно выше (то есть это элемент списка)
      const pr = el.parentElement?.getBoundingClientRect();
      if (pr && pr.height < r.height * 1.6) return;
      cand.push(el);
    });
    if (!cand.length) return [];

    // группируем по родителю — у настоящего списка родитель общий
    const byParent = new Map();
    cand.forEach((el) => {
      const key = el.parentElement;
      if (!key) return;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(el);
    });
    let best = [];
    byParent.forEach((arr) => { if (arr.length > best.length) best = arr; });
    if (best.length < 2) return cand.slice(0, 50);
    // сверху вниз, как их видит человек
    return best.sort((a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top).slice(0, 50);
  }

  /**
   * По какому именно узлу кликать, чтобы диалог открылся.
   * Клик по внешнему контейнеру строки Threads часто игнорирует —
   * обработчик висит на внутреннем элементе. Идём от имени собеседника
   * наружу до первого узла, который выглядит кликабельным.
   */
  function dmClickTarget(row) {
    if (!row) return null;
    const link = row.matches?.('a[href*="/messages/"]') ? row
               : row.querySelector?.('a[href*="/messages/"]');
    if (link) return link;
    const pressable = row.querySelector?.('[role="button"], [role="link"], [tabindex]');
    if (pressable && isVisibleEl(pressable)) return pressable;
    // имя собеседника — самый надёжный «живой» узел строки
    const texts = qsa(row, 'span[dir="auto"], div[dir="auto"], span')
      .filter((e) => isVisibleEl(e) && (e.innerText || e.textContent || "").trim().length > 1);
    if (texts.length) return texts[0];
    return row;
  }

  function dmScan(sel) {
    const rows = dmRows().slice(0, 50);
    const convs = [];
    const seen = new Set();
    rows.forEach((r, i) => {
      const href = r.getAttribute?.("href") || "";
      const lines = visText(r).split("\n").map((s) => s.trim()).filter(Boolean);
      if (!lines.length) {
        // Разметка без переносов: имя и превью лежат отдельными узлами.
        const parts = qsa(r, 'span[dir="auto"], div[dir="auto"]')
          .map((e) => visText(e).trim()).filter(Boolean);
        lines.push(...parts);
      }
      const name = (lines[0] || "").slice(0, 60);
      const preview = (lines.slice(1).join(" ") || lines[0] || "").replace(/\s+/g, " ").slice(0, 160);
      const key = href || name + preview;
      if (!name || seen.has(key)) return;
      seen.add(key);

      const aria = (r.getAttribute("aria-label") || "").toLowerCase();
      const unread =
        !!r.querySelector('[aria-label*="epoch" i], [data-unread]') ||
        /(^|\s)(new|новое|непрочит|unread)/i.test(aria) ||
        // синяя точка непрочитанного: маленький закрашенный кружок в строке
        qsa(r, "div, span").some((d) => {
          const st = getComputedStyle(d);
          const b = d.getBoundingClientRect();
          return b.width >= 6 && b.width <= 14 && Math.abs(b.width - b.height) <= 2 &&
                 parseFloat(st.borderRadius) >= b.width / 2 - 1 &&
                 st.backgroundColor && st.backgroundColor !== "rgba(0, 0, 0, 0)" &&
                 st.backgroundColor !== "transparent";
        });

      // Кто написал последним. Threads помечает превью словом «Вы:» / «You:»
      // когда последнее сообщение ваше. Определить это ПО СПИСКУ важнее, чем
      // кажется: без такой проверки программа открывала подряд все диалоги —
      // включая те, где ответа ждём мы, а не собеседник.
      const mine = /^\s*(вы|ты|you)\s*[:：]/i.test(preview) ||
                   /(^|\s)(вы|you)\s*[:：]/i.test(lines[1] || "");

      convs.push({ i, name, preview, href, unread, mine });
    });
    return convs;
  }

  async function dmOpen(index, sel, href) {
    const aim = window.DST.aim;
    let target = null;

    // CSS.escape: раньше href подставлялся в селектор как есть, и любая
    // кавычка или скобка роняли querySelector исключением.
    if (href) {
      try {
        const esc = window.CSS && CSS.escape ? CSS.escape(href) : null;
        target = esc ? document.querySelector(`a[href="${esc}"]`) : null;
      } catch {}
      if (!target) target = dmRows().find((a) => (a.getAttribute("href") || "") === href) || null;
    }
    const rows = dmRows();
    if (!target) target = rows[index];
    if (!target) {
      // Диагностика вместо глухого «не найден»: по этим цифрам сразу
      // видно, пустой ли список или проблема в конкретной строке.
      return { ok: false,
               error: `диалог не найден: строк в списке ${rows.length}, искали №${index + 1}` +
                      (href ? `, href «${href}»` : "") };
    }

    const urlBefore = location.pathname;

    // Клик может не сработать по внешнему контейнеру — пробуем несколько
    // точек входа подряд, пока диалог не откроется. Раньше была одна
    // попытка, и на текущей разметке Threads она молча промахивалась.
    const attempts = [];
    const primary = dmClickTarget(target);
    if (primary) attempts.push(primary);
    if (primary !== target) attempts.push(target);
    const inner = target.querySelector?.('a, [role="button"], img');
    if (inner && attempts.indexOf(inner) === -1) attempts.push(inner);

    let opened = false;
    for (const el of attempts) {
      if (!el || !document.body.contains(el)) continue;
      if (aim) await aim.click(el);
      else { try { el.click(); } catch {} }

      opened = await waitFor(() => {
        const changed = location.pathname !== urlBefore && /\/messages\/.+/.test(location.pathname);
        const input = qs(document, sel.dmInput);
        return (changed || (input && isVisibleEl(input))) ? true : null;
      }, 3500);
      if (opened) break;
      await sleep(rnd(250, 500));
    }

    if (!opened) {
      return { ok: false,
               error: `диалог не открылся (проб кликов: ${attempts.length}). ` +
                      "Откройте раздел «Сообщения» и убедитесь, что список диалогов виден." };
    }
    await sleep(rnd(900, 1600));
    const h = await dmWaitHistory(10000);
    return { ok: true, url: location.href, messages: h.length };
  }

  /**
   * История переписки. «Своё/чужое» определяем по краю ПАНЕЛИ переписки,
   * а не по доле окна: при открытой боковой панели Chrome или узком окне
   * порог vw*0.72 съезжал и роли путались.
   */
  function dmPane() {
    const input = qs(document, 'div[contenteditable="true"], textarea');
    let pane = input ? input.closest('[role="main"], main') : null;
    if (!pane) pane = document.querySelector('[role="main"], main');
    return pane || document.body;
  }

  /**
   * Границы КОЛОНКИ переписки — не всей страницы.
   *
   * Здесь была причина того, что агент читал диалоги и пропускал их со
   * словами «последнее слово за мной». Роли определялись по доле ширины
   * элемента [role="main"], а в Threads этот элемент охватывает и список
   * диалогов слева, и саму переписку. Входящее сообщение оказывалось около
   * середины такой широкой области, порог 0.58 срабатывал непредсказуемо,
   * и чужая реплика считалась нашей. Итог из лога: «Отвечено: 0,
   * пропущено: 9».
   *
   * Опора — поле ввода сообщения: оно стоит внизу колонки переписки и
   * занимает её ширину. Это устойчивее любого порога, потому что не
   * зависит ни от ширины окна, ни от открытой боковой панели.
   */
  function dmColumn() {
    const input = qs(document, 'div[contenteditable="true"], textarea');
    if (input) {
      const r = input.getBoundingClientRect();
      if (r.width > 120) return { left: r.left, right: r.right, width: r.width };
    }
    const box = dmPane().getBoundingClientRect();
    const w = box.width || window.innerWidth || 1200;
    return { left: box.left || 0, right: (box.left || 0) + w, width: w };
  }

  function dmHistory(limit = 10) {
    const pane = dmPane();
    const col = dmColumn();
    const nodes = qsa(pane, 'div[dir="auto"], span[dir="auto"]').filter((e) => {
      const t = (e.textContent || "").trim();
      if (t.length < 2 || t.length > 1200) return false;
      if (e.querySelector('div[dir="auto"], span[dir="auto"]')) return false;
      const r = e.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) return false;
      if (/^(входящие|запросы|поиск|сообщения|inbox|requests|search|messages)$/i.test(t)) return false;
      if (/^\d+\s*(мин|ч|д|мес|m|h|d)\.?$/i.test(t)) return false;
      return true;
    });

    const out = [];
    for (const e of nodes) {
      const r = e.getBoundingClientRect();
      // Реплики за пределами колонки переписки — это список диалогов слева
      // или наша собственная панель поверх страницы. В историю они попадать
      // не должны: именно из-за них роли и путались.
      if (r.right < col.left - 12 || r.left > col.right + 12) continue;
      const text = (e.textContent || "").trim();
      if (out.length && out[out.length - 1].text === text) continue;
      // Сравниваем отступы, а не долю ширины: пузырь прижат либо к левому
      // краю колонки, либо к правому. Порога, который можно не угадать,
      // здесь нет вовсе.
      const distLeft = Math.max(0, r.left - col.left);
      const distRight = Math.max(0, col.right - r.right);
      const mine = distRight < distLeft;
      out.push({ role: mine ? "me" : "them", text, dl: Math.round(distLeft),
                 dr: Math.round(distRight) });
    }
    return out.slice(-limit);
  }

  async function dmWaitHistory(timeout = 10000) {
    const t0 = Date.now();
    let last = -1, stable = 0;
    while (Date.now() - t0 < timeout) {
      const h = dmHistory(12);
      if (h.length) {
        if (h.length === last) { if (++stable >= 2) return h; }
        else { stable = 0; last = h.length; }
      }
      await sleep(400);
    }
    return dmHistory(12);
  }

  function dmReadLast() {
    const h = dmHistory(12);
    for (let i = h.length - 1; i >= 0; i--) if (h[i].role === "them") return h[i].text;
    return h.length ? h[h.length - 1].text : "";
  }

  function dmNeedsReply() {
    const h = dmHistory(6);
    if (!h.length) return false;
    const last = h[h.length - 1];
    // Если пузырь почти по центру колонки (широкое сообщение), отступы
    // близки, и «кто написал» по геометрии не определить. Считаем, что
    // ответить нужно: пропустить чужое сообщение хуже, чем лишний раз
    // подумать над своим.
    if (Math.abs((last.dl || 0) - (last.dr || 0)) < 24) return true;
    return last.role === "them";
  }

  /** Диагностика ролей — видно, почему реплика отнесена к своей или чужой. */
  function dmRolesDebug() {
    const col = dmColumn();
    return { column: col, messages: dmHistory(8) };
  }

  /**
   * Отправка в директ — с НАСТОЯЩИМ подтверждением.
   * Прежняя версия писала `if (mine || cleared) return {ok:true}`, а до этой
   * строки доходила только при cleared===true — то есть рапортовала успех
   * всегда, даже когда сообщение не уходило.
   */
  /**
   * Открыть переписку прямо со страницы профиля автора.
   * Нужно для первого сообщения: диалога ещё нет, и в списке /messages
   * человека не найти. Кнопка подписана по-разному в зависимости от
   * языка интерфейса Threads, поэтому ищем по набору подписей.
   */
  async function dmFromProfile() {
    const LABELS = ["сообщение", "написать", "message", "send message", "mesaj"];
    const urlBefore = location.pathname;

    const btn = qsa(document, 'div[role="button"], button, a')
      .filter(isVisibleEl)
      .filter((b) => !window.DST.ours?.isOurs(b))
      .find((b) => {
        const t = (visText(b) + " " + (b.getAttribute("aria-label") || "")).toLowerCase().trim();
        return t && t.length < 40 && LABELS.some((l) => t.includes(l));
      });

    if (!btn) return { ok: false, error: "на профиле нет кнопки «Сообщение» (закрытый аккаунт?)" };

    if (window.DST.aim) await window.DST.aim.click(btn);
    else { try { btn.click(); } catch {} }

    const opened = await waitFor(() => {
      const changed = location.pathname !== urlBefore && /\/messages\//.test(location.pathname);
      const input = qs(document, 'div[contenteditable="true"], textarea');
      return (changed || (input && isVisibleEl(input))) ? true : null;
    }, 8000);

    return opened ? { ok: true, url: location.href }
                  : { ok: false, error: "переписка не открылась с профиля" };
  }

  /**
   * Вставить текст в поле переписки и НЕ отправлять.
   * Ручной режим: последнее слово остаётся за человеком.
   */
  async function dmDraft(text, sel) {
    const grab = async () => {
      const el = qs(document, sel.dmInput);
      if (el && isVisibleEl(el)) return el;
      return findActiveEditable(sel);
    };
    const input = await waitFor(grab, 6000) || (await grab());
    if (!input) return { ok: false, error: "не нашёл поле ввода в переписке" };
    const ins = await setEditableText(input, text, { reacquire: grab });
    if (ins.alreadySent) return { ok: false, risky: true, error: "текст ушёл при вводе" };
    if (!ins.ok) return { ok: false, error: ins.error || "текст не вставился" };
    return { ok: true, drafted: true };
  }

  /**
   * Назад к списку диалогов без перезагрузки страницы.
   * Порядок: кнопка «назад» в шапке переписки → history.back() →
   * отказ (тогда снаружи сработает обычная навигация).
   */
  async function dmBack() {
    const before = location.pathname;
    const LABELS = ["назад", "back", "закрыть", "close"];
    const btn = qsa(document, 'div[role="button"], button, a[role="link"]')
      .filter(isVisibleEl)
      .filter((b) => !window.DST.ours?.isOurs(b))
      .filter((b) => b.getBoundingClientRect().top < 160)
      .find((b) => {
        const t = ((b.getAttribute("aria-label") || "") + " " + visText(b)).toLowerCase().trim();
        return t && t.length < 30 && LABELS.some((l) => t.includes(l));
      });
    if (btn) {
      if (window.DST.aim) await window.DST.aim.click(btn);
      else { try { btn.click(); } catch {} }
      const ok = await waitFor(() => location.pathname !== before ? true : null, 3000);
      if (ok) return { ok: true, how: "button" };
    }
    try { history.back(); } catch {}
    const ok2 = await waitFor(() => location.pathname !== before ? true : null, 3000);
    return ok2 ? { ok: true, how: "history" } : { ok: false, error: "не вышло вернуться назад" };
  }

  async function dmSend(text, sel) {
    const grab = async () => {
      const el = qs(document, sel.dmInput);
      if (el && isVisibleEl(el)) return el;
      return findActiveEditable(sel);
    };
    const input = await waitFor(grab, 5000) || (await grab());
    if (!input) return { ok: false, error: "не нашёл поле ввода в переписке" };

    const insD = await setEditableText(input, text, { reacquire: grab });
    if (insD.alreadySent) return { ok: false, risky: true, error: "текст ушёл при вводе — повтор запрещён" };
    if (!insD.ok) return { ok: false, error: insD.error || "текст не вставился в поле директа" };
    await sleep(rnd(400, 900));

    // setEditableText мог взять поле заново — дальше работаем с живым узлом
    const field = insD.el || input;

    const res = window.DST.resolve;
    const scope = field.closest('[role="dialog"]') || dmPane();
    const btn = (res ? await res.sendTarget(scope, { sendButtonLabels: sel.dmSendLabels }) : null)
      || findButtonByLabels(scope, sel.dmSendLabels);

    if (btn) {
      if (window.DST.aim) await window.DST.aim.click(btn, { center: false });
      else { try { btn.click(); } catch {} }
    } else {
      field.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      field.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    }

    const want = normText(text).slice(0, 40);
    const probe = want.slice(0, 25);
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (textStillInField(field, probe.slice(0, 20))) continue;   // ещё в поле — не ушло
      // подтверждение только по факту появления реплики от нас
      const mine = dmHistory(8).some((m) => m.role === "me" && normText(m.text).includes(probe));
      if (mine) return { ok: true, sent: true, confirmed: "history" };
      if (textPublished(probe, field)) return { ok: true, sent: true, confirmed: "text-visible" };
    }
    return { ok: false, error: "отправка в директ не подтвердилась" };
  }

  async function waitFor(fn, timeout = 3000, step = 150) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      // await — предикат может быть асинхронным (например, повторный поиск
      // поля ответа). Без него возвращался бы сам Promise, всегда «истинный».
      let v = null;
      try { v = await fn(); } catch {}
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function diagnose(sel) {
    const first = qs(document, sel.postLink);
    const cont = first ? postContainerFromLink(first) : null;
    return {
      url: location.href,
      postLinks: qsa(document, sel.postLink).length,
      editables: qsa(document, sel.editable).length,
      sampleMetrics: cont ? readMetrics(cont, sel) : null,
      sampleText: cont ? extractPostText(cont, "").slice(0, 120) : null,
      ariaLabels: qsa(document, "[aria-label]")
        .slice(0, 30)
        .map((b) => (b.getAttribute("aria-label") || "").trim())
        .filter(Boolean),
    };
  }

  /**
   * ПОСТ-ФАКТУМ СИГНАЛ: сколько ответов сейчас видно под постом.
   *
   * Честно: это НЕ «ответил ли именно автор поста именно на наш
   * комментарий» — такого точного сигнала в разметке Threads мы пока
   * надёжно не вычленяем (это отдельная, более хрупкая задача, как
   * INPUT_REJECTED в своё время). Это прирост общего счётчика ответов
   * под постом с момента нашего комментария — тот же метод, что уже
   * проверенно работает в verifySent (подтверждение "counter"). Слабее,
   * чем «ответил автор», но не даёт ложных иллюзий там, где реального
   * сигнала ещё нет.
   *
   * Возвращает null, если карточка поста сейчас не на экране — в этом
   * случае проверяющий код должен просто отложить проверку, а не считать
   * это отсутствием ответа.
   */
  function countReplies(code) {
    const container = containerByCode(code);
    if (!container) return null;
    return readMetrics(container, {}).comments;
  }

  window.DST.dom = {
    sleep, rnd, parseNum,
    parseVisiblePosts, collectPosts, parseContainer,
    commentOnPost, createPost, likePost, findButtonByLabels, setEditableText,
    containerByCode, postContainerFromLink, diagnose, detectContext, findActiveEditable,
    dmScan, dmOpen, dmRows, dmClickTarget, dmReadLast, dmSend, dmDraft, dmBack,
    dmFromProfile, dmHistory, dmNeedsReply, dmRolesDebug, dmWaitHistory,
    diagnoseInsertion, TYPING_STRATEGIES,
    clearEditable, editableHas, closeComposer, closeStrayPopovers,
    replyCandidates, findSubmitButton, waitFor, verifySent, normText, isVisibleEl,
    readMetrics, extractPostText, textPublished, composerGone, submitComposer, fieldText,
    editableAlive, waitEditableStable, typeInto,
    composerScope, composerField, nearEditable, replyPromptTargets, bareEditableTargets,
    countReplies,
  };
})();


/* ── Панель внутри страницы ────────────────────────────────────
   Нужна там, где нет chrome.sidePanel: Orion на iOS, Firefox для
   Android. Слушатель регистрируется всегда — на десктопе он просто
   никогда не срабатывает, потому что туда уходит настоящая боковая
   панель. */
(function () {
  const OVERLAY_ID = "__aithreads_panel_host";
  const PANEL_URL = "src/sidepanel/panel.html";

  function narrow() {
    try { return Math.min(screen.width, screen.height) <= 820; } catch { return false; }
  }

  function mount() {
    const was = document.getElementById(OVERLAY_ID);
    if (was) { was.style.display = "block"; return true; }
    const n = narrow();
    const host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.style.cssText = "position:fixed;z-index:2147483646;background:#0b0b0c;"
      + "box-shadow:0 0 0 1px rgba(255,255,255,.14),0 18px 60px rgba(0,0,0,.6);"
      + (n ? "inset:0" : "top:0;right:0;bottom:0;width:400px;border-left:1px solid rgba(255,255,255,.12)");

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;justify-content:space-between;align-items:center;"
      + "padding:10px 12px;font:600 12px/1 ui-monospace,monospace;color:#eee;"
      + "border-bottom:1px solid rgba(255,255,255,.10)";
    bar.innerHTML = "<span>AI THREADS</span>";
    const close = document.createElement("button");
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "Закрыть панель");
    // 44 пиксела — минимальная цель для пальца; на телефоне крестик
    // меньше этого промахивается.
    close.style.cssText = "background:none;border:0;color:#aaa;font-size:16px;"
      + "cursor:pointer;min-width:44px;min-height:44px";
    close.onclick = () => { host.style.display = "none"; };
    bar.appendChild(close);

    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL(PANEL_URL);
    frame.style.cssText = "width:100%;height:calc(100% - 40px);border:0;display:block";

    host.appendChild(bar);
    host.appendChild(frame);
    document.documentElement.appendChild(host);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === "PANEL_OVERLAY_OPEN") { reply({ ok: mount() }); return true; }
    if (msg?.type === "PANEL_OVERLAY_CLOSE") {
      document.getElementById(OVERLAY_ID)?.remove(); reply({ ok: true }); return true;
    }
  });
})();
