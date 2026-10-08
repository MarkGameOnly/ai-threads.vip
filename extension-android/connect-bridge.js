/**
 * Вход одним касанием: мост между ссылкой из бота и расширением.
 *
 * Бот присылает ссылку вида
 *     https://ai-threads.vip/x#id=123456789&k=TAI-XXXX-XXXX-XXXX
 * Человек открывает её в том же браузере, где стоит расширение, — и всё.
 * Ни копирования, ни двух полей, ни перехода в настройки.
 *
 * Почему данные во фрагменте (#), а не в query (?): фрагмент браузер на
 * сервер не отправляет. Ключ активации не попадает ни в логи веб-сервера,
 * ни в реферер, ни в аналитику. Для нас он читается здесь, на странице.
 *
 * Это обычный content script, а не модуль: MV3 не даёт content-скриптам
 * import. Поэтому всю работу делает фоновый воркер, а здесь — только
 * разбор адреса и отрисовка результата.
 */
(() => {
  const box = () => document.getElementById("x-status");

  function paint(text, kind) {
    const el = box();
    if (el) {
      el.textContent = text;
      el.dataset.kind = kind;
    }
  }

  function parseHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    const q = new URLSearchParams(raw);
    const id = (q.get("id") || "").trim();
    const key = (q.get("k") || q.get("key") || "").trim().toUpperCase();
    return { id, key };
  }

  async function run() {
    const { id, key } = parseHash();
    if (!id || !key) {
      paint("Ссылка неполная. Вернитесь в бота и нажмите «Кабинет» ещё раз.", "err");
      return;
    }
    paint("Подключаю кабинет…", "wait");
    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: "CONNECT_FROM_LINK", tgUserId: id, key,
      });
    } catch {
      paint("Расширение не отвечает. Переустановите его и откройте ссылку снова.", "err");
      return;
    }
    if (!r || !r.ok) {
      paint("✖ " + ((r && r.error) || "не удалось подключить"), "err");
      return;
    }
    const left = (r.gensLeft === null || r.gensLeft === undefined) ? "∞" : r.gensLeft;
    paint(`Готово. Тариф ${r.plan || "FREE"}, генераций: ${left}. `
          + "Откройте threads.com и нажмите значок расширения.", "ok");

    // Убираем ключ из адресной строки: дальше он не нужен, а в истории
    // браузера и в списке вкладок ему делать нечего.
    try { history.replaceState(null, "", location.pathname); } catch {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
