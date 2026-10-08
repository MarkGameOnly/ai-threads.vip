#!/usr/bin/env node
/**
 * release.mjs — обвязка выпуска расширений AI Threads VIP.
 *
 * Команды:
 *   node tools/release.mjs check            — проверка деревьев (целостность
 *                                             манифестов, синхронность src/)
 *   node tools/release.mjs bump 5.6.2       — версия во все три манифеста
 *   node tools/release.mjs build            — собрать builds/*.zip и *.crx
 *   node tools/release.mjs release 5.6.2    — check + bump + build разом
 *
 * Зачем это в репозитории. До 5.6.2 выпуск собирался руками: архивы
 * складывались «как получилось» (внутри оказывались чужие .crx и файлы
 * с изуродованными кириллическими именами), а из сборки для iPhone
 * однажды молча выпала половина расширения — панель, настройки и попап,
 * на которые ссылался манифест. Обвязка делает три вещи:
 *   1) ПРОВЕРЯЕТ, что каждый файл, упомянутый в манифесте, существует
 *      (ровно та ошибка, что убила extension-mobile);
 *   2) кладёт во все архивы одинаковый, воспроизводимый состав;
 *   3) подписывает .crx ключом разработчика (tools/keys/, в git не лежит).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeZip } from "./lib/zip.mjs";
import { generateKey, packCrx, verifyCrx, crxId } from "./lib/crx.mjs";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "tools", "dist");
const BUILDS = join(ROOT, "builds");
const KEYS = join(ROOT, "tools", "keys");

// папка в репозитории → имя в выпуске
const VARIANTS = [
  { dir: "extension",         name: "desktop" },
  { dir: "extension-android", name: "android" },
  { dir: "extension-mobile",  name: "mobile"  },
];

const fail = (m) => { console.error("✕ " + m); process.exitCode = 1; };
const ok = (m) => console.log("✓ " + m);

/* ──────────────────────────────────────────────────────────────
   ПРОВЕРКА
   ────────────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** Пути, на которые ссылается HTML-страницка расширения. */
function htmlRefs(file) {
  const html = readFileSync(file, "utf8");
  const out = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)) out.push(m[1]);
  return out.filter((p) => !/^(https?:)?\/\//.test(p));
}

function checkVariant(v) {
  const dir = join(ROOT, v.dir);
  const mPath = join(dir, "manifest.json");
  if (!existsSync(mPath)) { fail(`${v.dir}: нет manifest.json`); return null; }
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  const refs = new Set();

  if (m.background?.service_worker) refs.add(m.background.service_worker);
  for (const s of m.background?.scripts || []) refs.add(s);
  for (const cs of m.content_scripts || []) {
    for (const j of cs.js || []) refs.add(j);
    for (const c of cs.css || []) refs.add(c);
  }
  if (m.action?.default_popup) refs.add(m.action.default_popup);
  if (m.options_page) refs.add(m.options_page);
  if (m.side_panel?.default_path) refs.add(m.side_panel.default_path);
  for (const sizes of Object.values(m.icons || {})) refs.add(sizes);
  for (const sizes of Object.values(m.action?.default_icon || {})) refs.add(sizes);
  for (const w of m.web_accessible_resources || []) {
    for (const r of w.resources || []) {
      if (!r.includes("*")) refs.add(r);
      else {
        // «src/sidepanel/*» — каталог должен существовать
        const d = join(dir, r.replace(/\/?\*.*$/, ""));
        if (!existsSync(d)) fail(`${v.dir}: web_accessible_resources → нет каталога ${r}`);
      }
    }
  }

  let broken = 0;
  for (const r of refs) {
    const p = join(dir, r);
    if (!existsSync(p)) { fail(`${v.dir}: манифест ссылается на отсутствующий ${r}`); broken++; continue; }
    if (r.endsWith(".html")) {
      for (const sub of htmlRefs(p)) {
        const sp = join(dirname(p), sub);
        if (!existsSync(sp)) { fail(`${v.dir}: ${r} ссылается на отсутствующий ${sub}`); broken++; }
      }
    }
  }
  if (!broken) ok(`${v.dir}: манифест целый (файлов по ссылкам: ${refs.size})`);
  return m;
}

function cmdCheck() {
  console.log("── Проверка деревьев ──");
  const manifests = VARIANTS.map((v) => ({ v, m: checkVariant(v) }));

  // версии обязаны совпадать
  const versions = new Set(manifests.map(({ m }) => m?.version).filter(Boolean));
  if (versions.size > 1) fail(`версии расходятся: ${[...versions].join(" vs ")}`);
  else if (versions.size === 1) ok(`версия везде одна: ${[...versions][0]}`);

  // src/ у всех вариантов — один и тот же код; расхождение = тихий баг
  const base = VARIANTS[0].dir;
  const baseFiles = walk(join(ROOT, base, "src")).map((p) => relative(join(ROOT, base), p));
  for (const v of VARIANTS.slice(1)) {
    for (const f of baseFiles) {
      const a = join(ROOT, base, f), b = join(ROOT, v.dir, f);
      if (!existsSync(b)) { fail(`${v.dir}: нет ${f} (есть в ${base})`); continue; }
      if (readFileSync(a).compare(readFileSync(b)) !== 0) fail(`${v.dir}: ${f} разошёлся с ${base}`);
    }
  }
  ok(`src/ синхронен между вариантами (${baseFiles.length} файлов)`);

  // дымяем тесты, чтобы выпуск не уехал на сломанном коде
  return process.exitCode ? false : true;
}

/* ──────────────────────────────────────────────────────────────
   ВЕРСИЯ
   ────────────────────────────────────────────────────────────── */

function cmdBump(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`версия «${version}» не похожа на X.Y.Z`);
    return false;
  }
  console.log(`── Версия → ${version} ──`);
  for (const v of VARIANTS) {
    const p = join(ROOT, v.dir, "manifest.json");
    const raw = readFileSync(p, "utf8");
    const next = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
    if (next === raw) { fail(`${v.dir}: не нашёл "version" в манифесте`); continue; }
    writeFileSync(p, next);
    ok(`${v.dir}: ${version}`);
  }
  return true;
}

/* ──────────────────────────────────────────────────────────────
   СБОРКА
   ────────────────────────────────────────────────────────────── */

/** Ключ разработчика варианта: создаётся один раз и переиспользуется. */
function loadOrCreateKey(name) {
  mkdirSync(KEYS, { recursive: true });
  const keyPath = join(KEYS, `${name}.pem`);
  const metaPath = join(KEYS, `${name}.json`);
  if (existsSync(keyPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      privateKeyPem: readFileSync(keyPath, "utf8"),
      publicKeyDer: Buffer.from(meta.publicKeyDer, "base64"),
      created: false,
    };
  }
  const { privateKeyPem, publicKeyDer } = generateKey();
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(metaPath, JSON.stringify({
    publicKeyDer: publicKeyDer.toString("base64"),
    crxId: crxId(publicKeyDer).toString("hex"),
    chromeId: chromeStyleId(crxId(publicKeyDer)),
    createdAt: new Date().toISOString(),
  }, null, 2) + "\n");
  return { privateKeyPem, publicKeyDer, created: true };
}

/** ID расширения так, как его показывает Chrome (каждый ниббл → a–p). */
function chromeStyleId(idBytes) {
  const abc = "abcdefghijklmnop";
  return [...idBytes].map((b) => abc[b >> 4] + abc[b & 15]).join("");
}

function variantEntries(v) {
  const dir = join(ROOT, v.dir);
  return walk(dir)
    .map((p) => ({ name: "extension/" + relative(dir, p).split("\\").join("/"), data: readFileSync(p) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cmdBuild() {
  console.log("── Сборка выпусков ──");
  const docs = [
    { name: "README.txt", data: readFileSync(join(DIST, "README.txt")) },
    { name: "УСТАНОВКА.txt", data: readFileSync(join(DIST, "УСТАНОВКА.txt")) },
  ];
  mkdirSync(BUILDS, { recursive: true });

  for (const v of VARIANTS) {
    const entries = variantEntries(v);

    // 1) .crx — чистое расширение, подписанное ключом разработчика
    const key = loadOrCreateKey(v.name);
    const crxZip = makeZip(entries);
    const crx = packCrx(crxZip, key.privateKeyPem, key.publicKeyDer);
    const crxPath = join(BUILDS, `extension-${v.name}.crx`);
    writeFileSync(crxPath, crx);
    const probe = verifyCrx(readFileSync(crxPath));
    if (!probe.ok) { fail(`${v.name}: подпись собственного .crx не сошлась`); continue; }

    // 2) .zip — папка extension/ + документы; для телефона и Android
    //    рядом кладём сам .crx (ставится «из файла», распаковывать не надо)
    const zipEntries = [...entries, ...docs];
    const fixesPath = join(ROOT, "FIXES.md");
    if (existsSync(fixesPath)) zipEntries.push({ name: "FIXES.md", data: readFileSync(fixesPath) });
    if (v.name !== "desktop") {
      zipEntries.push({ name: `extension-${v.name}.crx`, data: crx });
    }
    const zip = makeZip(zipEntries);
    const zipPath = join(BUILDS, `extension-${v.name}.zip`);
    writeFileSync(zipPath, zip);

    ok(`${v.name}: zip ${(zip.length / 1024).toFixed(0)} КБ, ` +
       `crx ${(crx.length / 1024).toFixed(0)} КБ, ` +
       `id ${chromeStyleId(crxId(key.publicKeyDer))}${key.created ? " (ключ создан впервые)" : ""}`);
  }

  console.log("\nКлючи подписи лежат в tools/keys/ и в git не попадают.");
  console.log("Смена ключа = новый ID расширения: у пользователей оно");
  console.log("обновится только переустановкой. Берегите ключи.");
  return true;
}

/* ──────────────────────────────────────────────────────────────
   ПРОГОН
   ────────────────────────────────────────────────────────────── */

const [, , cmd, arg] = process.argv;

if (cmd === "check") {
  cmdCheck();
} else if (cmd === "bump" && arg) {
  cmdBump(arg);
} else if (cmd === "build") {
  if (cmdCheck()) cmdBuild();
} else if (cmd === "release" && arg) {
  if (!cmdCheck()) process.exit(1);
  if (!cmdBump(arg)) process.exit(1);
  cmdBuild();
} else {
  console.log(`Использование:
  node tools/release.mjs check          — проверка деревьев
  node tools/release.mjs bump X.Y.Z     — поднять версию в манифестах
  node tools/release.mjs build          — пересобрать builds/
  node tools/release.mjs release X.Y.Z  — проверка + версия + сборка`);
}
