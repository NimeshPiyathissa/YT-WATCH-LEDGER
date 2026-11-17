// Creates (or resets the password of) the single owner account. There is no registration endpoint:
// this script, run on the server itself, is the only way an owner account comes into existence.
//
//   node scripts/create-owner.js you@example.com             prompts for a password (hidden)
//   node scripts/create-owner.js you@example.com --password-stdin   reads the password from stdin (for provisioning)
//   node scripts/create-owner.js you@example.com --reset     sets a new password for the existing owner and signs out all sessions
//
// The password is never accepted as a command-line argument (it would land in shell history and process listings).
import argon2 from "argon2";
import readline from "node:readline";
import { openDb, migrate } from "../src/db.js";
import { uuid } from "../src/lib/crypto.js";

export const MIN_PASSWORD = 12;

export async function createOwner(db, email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email)) throw new Error("enter a valid email address");
  if (String(password).length < MIN_PASSWORD || String(password).length > 256) throw new Error(`password must be ${MIN_PASSWORD}-256 characters`);
  if (db.prepare("SELECT 1 FROM admins").get()) throw new Error("an owner already exists; use --reset to change the password");
  const id = uuid();
  db.prepare("INSERT INTO admins(id,email,pw_hash,created_at) VALUES (?,?,?,?)").run(id, email, await argon2.hash(password), Date.now());
  return id;
}

export async function resetOwnerPassword(db, password) {
  if (String(password).length < MIN_PASSWORD || String(password).length > 256) throw new Error(`password must be ${MIN_PASSWORD}-256 characters`);
  const owner = db.prepare("SELECT id FROM admins").get();
  if (!owner) throw new Error("no owner exists yet");
  const hash = await argon2.hash(password);
  db.transaction(() => {
    db.prepare("UPDATE admins SET pw_hash=? WHERE id=?").run(hash, owner.id);
    db.prepare("UPDATE refresh_tokens SET revoked=2 WHERE admin_id=? AND revoked=0").run(owner.id); // every existing session is signed out
  })();
  return owner.id;
}

function readPassword(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { let d = ""; process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => resolve(d.replace(/\r?\n$/, ""))); return; }
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    rl._writeToOutput = () => {}; // hide typed characters
    rl.question("", a => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

if (process.argv[1] && process.argv[1].endsWith("create-owner.js")) {
  const args = process.argv.slice(2), email = args.find(a => !a.startsWith("--"));
  const reset = args.includes("--reset");
  const db = openDb(process.env.DB_PATH || "./data/tracker.db");
  migrate(db);
  try {
    if (!reset && !email) throw new Error("usage: node scripts/create-owner.js <email> [--reset] [--password-stdin]");
    const pw = await readPassword("New owner password (min 12 chars): ");
    if (!args.includes("--password-stdin") && process.stdin.isTTY && !reset) {
      const again = await readPassword("Repeat password: ");
      if (again !== pw) throw new Error("passwords do not match");
    }
    if (reset) { await resetOwnerPassword(db, pw); console.log("owner password changed; all sessions signed out"); }
    else { await createOwner(db, email, pw); console.log("owner account created for " + String(email).toLowerCase()); }
  } catch (e) { console.error("error: " + e.message); process.exitCode = 1; }
  db.close();
}
