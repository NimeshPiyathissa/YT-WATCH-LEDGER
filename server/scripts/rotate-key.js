// Re-encrypts all watch data from OLD_MASTER_KEY to MASTER_KEY in one transaction.
//   OLD_MASTER_KEY=<current> MASTER_KEY=<new> DB_PATH=./data/tracker.db node scripts/rotate-key.js
// Stop the server and back up the database first; see SECURITY.md.
import crypto from "node:crypto";
import { openDb } from "../src/db.js";

function keyOf(b64, name) {
  const k = Buffer.from(b64 || "", "base64");
  if (k.length !== 32) throw new Error(name + " must be 32 bytes, base64-encoded");
  return k;
}
function dec(key, buf) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
function enc(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// Throws (and rolls back) if any row can't be decrypted with the old key, so a wrong key changes nothing.
export function rotate(db, oldB64, newB64) {
  const oldKey = keyOf(oldB64, "OLD_MASTER_KEY"), newKey = keyOf(newB64, "MASTER_KEY");
  if (oldKey.equals(newKey)) throw new Error("old and new keys are identical");
  let n = 0;
  db.transaction(() => {
    for (const [table, pk] of [["videos", ["device_id", "video_id"]], ["sessions", ["device_id", "session_id"]]]) {
      const upd = db.prepare(`UPDATE ${table} SET enc=? WHERE ${pk[0]}=? AND ${pk[1]}=?`);
      for (const r of db.prepare(`SELECT ${pk[0]},${pk[1]},enc FROM ${table}`).all()) {
        upd.run(enc(newKey, dec(oldKey, r.enc)), r[pk[0]], r[pk[1]]); n++;
      }
    }
  })();
  return n;
}

if (process.argv[1] && process.argv[1].endsWith("rotate-key.js")) {
  const db = openDb(process.env.DB_PATH || "./data/tracker.db");
  try { console.log("re-encrypted " + rotate(db, process.env.OLD_MASTER_KEY, process.env.MASTER_KEY) + " records"); }
  catch (e) { console.error("rotation failed, nothing changed: " + e.message); process.exit(1); }
  db.close();
}
