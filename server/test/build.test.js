// The extension build (tools/build-extension.mjs): contents, reproducibility, manifest/version checks, and refusal of
// unsafe inputs. Builds go to temp folders; nothing in the project is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { build, scan, BuildError } from "../../tools/build-extension.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "yt-build-"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// Minimal ZIP reader (central directory), so the test does not trust the writer it is checking.
function readZip(file) {
  const b = fs.readFileSync(file), eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(eocd + 10); let p = b.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16), csize = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24);
    const nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nl), lo = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const raw = b.subarray(lo, lo + csize), data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, size, name + " size");
    assert.equal(zlib.crc32 ? zlib.crc32(data) : crc, crc, name + " crc");
    out[name] = data; p += 46 + nl + el + cl;
  }
  return out;
}

test("the build is a valid MV3 package: manifest, version consistency, every referenced file, only allowlisted content", () => {
  const out = tmp(), r = build(["--out", out]);
  const z = readZip(r.zipPath), m = JSON.parse(z["manifest.json"]);
  assert.deepEqual([m.manifest_version, m.version], [3, manifest.version]);
  assert.match(path.basename(r.zipPath), new RegExp(`^yt-watch-tracker-v${(manifest.version_name || manifest.version).replace(/\./g, "\\.")}\\.zip$`));
  assert.deepEqual(m.permissions, ["storage", "alarms"], "no permissions beyond the existing two");
  assert.equal("key" in m, false, "no custom key unless one is supplied");
  for (const f of ["background.js", "popup/popup.html", "popup/popup.js", "lib/sync.js", "lib/realtime.js", "lib/build-config.js", "icons/icon16.png", "icons/icon48.png", "icons/icon128.png", "content/tracker.js", "admin/admin.html"])
    assert.ok(f in z, f + " is packaged");
  const bad = Object.keys(z).filter(n => /^(server|tests|docs|tools|dist|\.git|node_modules)\b/.test(n) || /\.(db|env|pem|key|log|md|map|zip)$/.test(n) || /(^|\/)\.env/.test(n));
  assert.deepEqual(bad, [], "nothing but extension files");
  assert.match(fs.readFileSync(r.zipPath + ".sha256", "utf8"), /^[0-9a-f]{64}  yt-watch-tracker-v/);
  assert.equal(z["icons/icon128.png"].subarray(1, 4).toString(), "PNG");
  assert.equal(String(z["lib/build-config.js"]).includes('server: ""'), true, "source build has no baked server");
  assert.equal(fs.existsSync(path.join(r.stage, "manifest.json")), true, "the unpacked folder is there for Load unpacked");
});

test("the build is reproducible: the same sources give byte-identical ZIPs", () => {
  const a = build(["--out", tmp()]), b = build(["--out", tmp()]);
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(fs.readFileSync(a.zipPath), fs.readFileSync(b.zipPath));
});

test("--server bakes one https address into the build; unsafe or malformed addresses are refused", () => {
  const r = build(["--out", tmp(), "--server", "https://tracker.example.com/some/path"]);
  assert.equal(r.server, "https://tracker.example.com");
  assert.match(String(readZip(r.zipPath)["lib/build-config.js"]), /server: "https:\/\/tracker\.example\.com"/);
  assert.equal(build(["--out", tmp(), "--server", "http://localhost:8443"]).server, "http://localhost:8443", "plain http only for localhost");
  for (const bad of ["http://tracker.example.com", "not a url", "https://user:pw@tracker.example.com", "ftp://x.example.com"])
    assert.throws(() => build(["--out", tmp(), "--server", bad]), BuildError, bad);
});

test("--key-file: a public key gives a stable extension id; a private key or junk is refused", () => {
  const dir = tmp(), { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pubPem = publicKey.export({ type: "spki", format: "pem" }), privPem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(path.join(dir, "pub.pem"), pubPem); fs.writeFileSync(path.join(dir, "priv.pem"), privPem); fs.writeFileSync(path.join(dir, "junk.txt"), "hello world");
  const r1 = build(["--out", path.join(dir, "o1"), "--key-file", path.join(dir, "pub.pem")]), r2 = build(["--out", path.join(dir, "o2"), "--key-file", path.join(dir, "pub.pem")]);
  assert.match(r1.extensionId, /^[a-p]{32}$/);
  assert.equal(r1.extensionId, r2.extensionId, "same key, same id");
  const m = JSON.parse(readZip(r1.zipPath)["manifest.json"]);
  assert.equal(m.key, publicKey.export({ type: "spki", format: "der" }).toString("base64"));
  assert.throws(() => build(["--out", path.join(dir, "o3"), "--key-file", path.join(dir, "priv.pem")]), /PRIVATE key/);
  assert.throws(() => build(["--out", path.join(dir, "o4"), "--key-file", path.join(dir, "junk.txt")]), BuildError);
  assert.equal(fs.existsSync(path.join(dir, "o3", "yt-watch-tracker-v" + (manifest.version_name || manifest.version) + ".zip")), false, "a refused build writes no ZIP");
});

test("the manifest, the version the extension reports, and the server's real-time cut-off agree", () => {
  const sync = fs.readFileSync(path.join(ROOT, "lib", "sync.js"), "utf8");
  assert.equal(/FALLBACK_VERSION = "([^"]+)"/.exec(sync)[1], manifest.version);
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, "WebSocket keep-alive for the service worker needs Chrome 116+");
  for (const s of [16, 48, 128]) assert.equal(manifest.icons[String(s)], `icons/icon${s}.png`);
  for (const s of [16, 48, 128]) { const png = fs.readFileSync(path.join(ROOT, manifest.icons[String(s)])); assert.equal(png.readUInt32BE(16), s); assert.equal(png.readUInt32BE(20), s); }
});

test("the secret scan fails on credentials, data files and key material, and passes on a clean tree", () => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "lib", "ok.js"), "const x = 1; // password is a word, not a secret");
  assert.doesNotThrow(() => scan(dir));
  const cases = { ".env": "A=1", "data.db": "x", "k.pem": "x", "lib/a.js": "-----BEGIN PRIVATE KEY-----", "lib/b.js": "MASTER_KEY=abcdefghijklmnop", "lib/c.js": 'x={"device_refresh":"' + "a".repeat(40) + '"}', "lib/d.js": "Authorization: Bearer " + "A".repeat(40) };
  for (const [name, text] of Object.entries(cases)) {
    const d = tmp(); fs.mkdirSync(path.join(d, "lib")); fs.writeFileSync(path.join(d, name), text);
    assert.throws(() => scan(d), /secret scan failed/, name);
  }
});
