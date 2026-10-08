/**
 * crx.mjs — упаковка .crx (формат CRX₃) без внешних зависимостей.
 *
 * Формат (см. components/crx_file/crx3.proto в Chromium):
 *   "Cr24" + версия(3) + длина заголовка + заголовка + ZIP-архив.
 *
 * Подпись считается по значению
 *   "CRX3 SignedData\x00" + uint32le(длина signed_header_data)
 *   + signed_header_data + байты ZIP-архива,
 * где signed_header_data — сериализованный SignedData{ crx_id },
 * а crx_id — первые 16 байт SHA-256 от публичного ключа (SPKI DER).
 *
 * Протобуферы здесь кодируются вручную: сообщения крошечные
 * (три поля), тянуть ради них protobuf-библиотеку незачем.
 */
import crypto from "node:crypto";

const SIG_CONTEXT = Buffer.concat([Buffer.from("CRX3 SignedData", "utf8"), Buffer.from([0])]);

/** Varint (LEB128) — базовая сериализация целых в protobuf. */
function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

/** Поле вида «длина + байты»: тег поля + длина + содержимое. */
function lenField(fieldNo, bytes) {
  const tag = varint((fieldNo << 3) | 2);
  return Buffer.concat([tag, varint(bytes.length), bytes]);
}

/** SignedData { crx_id = 1 } */
function signedData(crxId) {
  return lenField(1, crxId);
}

/** AsymmetricKeyProof { public_key = 1, signature = 2 } */
function keyProof(publicKey, signature) {
  return Buffer.concat([lenField(1, publicKey), lenField(2, signature)]);
}

/** CrxFileHeader { sha256_with_rsa = 2, signed_header_data = 10000 } */
function crxFileHeader(proof, shd) {
  return Buffer.concat([lenField(2, proof), lenField(10000, shd)]);
}

/** ID расширения из публичного ключа: первые 16 байт SHA-256. */
export function crxId(publicKeyDer) {
  return crypto.createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
}

/**
 * Сгенерировать пару ключей разработчика.
 * @returns {{ privateKeyPem: string, publicKeyDer: Buffer }}
 */
export function generateKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyDer: publicKey };
}

/**
 * Упаковать ZIP-байты в подписанный .crx.
 * @param zipBytes Buffer — готовый ZIP
 * @param privateKeyPem string — PEM-ключ разработчика (создаётся один раз)
 * @param publicKeyDer Buffer — соответствующий публичный ключ (SPKI DER)
 * @returns Buffer — файл .crx
 */
export function packCrx(zipBytes, privateKeyPem, publicKeyDer) {
  const id = crxId(publicKeyDer);
  const shd = signedData(id);

  // Подписываемое значение строго по спецификации (см. шапку файла).
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(shd.length, 0);
  const toSign = Buffer.concat([SIG_CONTEXT, sizeBuf, shd, zipBytes]);

  const signature = crypto.sign("sha256", toSign, {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  const header = crxFileHeader(keyProof(publicKeyDer, signature), shd);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zipBytes]);
}

/** Проверка: подпись собственного .crx обязана сходиться. */
export function verifyCrx(crxBytes) {
  if (crxBytes.toString("ascii", 0, 4) !== "Cr24") return { ok: false, error: "не та сигнатура" };
  if (crxBytes.readUInt32LE(4) !== 3) return { ok: false, error: "ожидался CRX3" };
  const headerLen = crxBytes.readUInt32LE(8);
  const header = crxBytes.subarray(12, 12 + headerLen);
  const zip = crxBytes.subarray(12 + headerLen);
  // грубый разбор: ищем поля вручную (заголовок всегда один и тот же)
  let off = 0;
  let proof = null, shd = null;
  while (off < header.length) {
    const [fieldNo, wireType, valLen, consumed] = readField(header, off);
    if (wireType !== 2) return { ok: false, error: "неожиданный тип поля" };
    const body = header.subarray(off + consumed, off + consumed + valLen);
    if (fieldNo === 2) proof = body;
    if (fieldNo === 10000) shd = body;
    off += consumed + valLen;
  }
  if (!proof || !shd) return { ok: false, error: "в заголовке нет подписи" };
  let p = 0, pub = null, sig = null;
  while (p < proof.length) {
    const [fn, wt, vl, c] = readField(proof, p);
    if (wt !== 2) return { ok: false, error: "плохое поле proof" };
    const body = proof.subarray(p + c, p + c + vl);
    if (fn === 1) pub = body;
    if (fn === 2) sig = body;
    p += c + vl;
  }
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(shd.length, 0);
  const toSign = Buffer.concat([SIG_CONTEXT, sizeBuf, shd, zip]);
  const ok = crypto.verify("sha256", toSign, {
    key: crypto.createPublicKey({ key: pub, format: "der", type: "spki" }),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, sig);
  return { ok, publicKeyDer: pub, crxId: crxId(pub).toString("hex"), error: ok ? "" : "подпись не сошлась" };
}

/** Прочитать одно поле: номер, тип, длина, сколько байт занял тег+длина. */
function readField(buf, off) {
  let n = 0, shift = 0, key = 0, consumed = 0;
  do { n = buf[off + consumed]; key |= (n & 0x7f) << shift; shift += 7; consumed++; } while (n & 0x80);
  const fieldNo = key >>> 3, wireType = key & 7;
  let len = 0; shift = 0;
  do { n = buf[off + consumed]; len |= (n & 0x7f) << shift; shift += 7; consumed++; } while (n & 0x80);
  return [fieldNo, wireType, len, consumed];
}
