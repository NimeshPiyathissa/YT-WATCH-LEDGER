// Data-at-rest encryption (AES-256-GCM) and token helpers.
import crypto from "node:crypto";

let KEY = null;
function key() { // read lazily so tests can set MASTER_KEY before first use
  if (KEY) return KEY;
  const k = Buffer.from(process.env.MASTER_KEY || "", "base64");
  if (k.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64-encoded");
  return (KEY = k);
}

export function encryptJSON(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), "utf8")), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // store as BLOB: iv(12) | tag(16) | ciphertext
}
export function decryptJSON(buf) {
  const d = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}
// device/refresh tokens are high-entropy random, so a fast hash is fine
export function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
// Pairing code: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX.
// 31^8 ~ 8.5e11 combinations against a 15-minute life, single use, and per-IP rate limits and lockout.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function randomCode() {
  let s = "";
  while (s.length < 8) { const b = crypto.randomBytes(1)[0]; if (b < 248) s += CODE_ALPHABET[b % 31]; } // 248 = 8*31: no modulo bias
  return s.slice(0, 4) + "-" + s.slice(4);
}
export const uuid = () => crypto.randomUUID();
export function hmac(data) {
  return crypto.createHmac("sha256", process.env.COOKIE_SECRET || "").update(data).digest("base64url");
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
