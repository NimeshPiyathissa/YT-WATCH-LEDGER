// Builds the installable Chrome extension: dist/extension/ (for "Load unpacked") and dist/yt-watch-tracker-v<version>.zip.
//   node tools/build-extension.mjs [--out dist] [--server https://tracker.example.com] [--key-file public-key.pem]
//
//   --server    bakes one server address into the build, so the person installing it only needs a pairing code.
//               Without it, the extension asks for the address when pairing.
//   --key-file  a PUBLIC key (PEM or bare base64) to add as manifest "key": gives the extension a stable ID across
//               machines and rebuilds. Private keys are refused. Without it Chrome derives the ID from the folder path.
//
// Only an allowlist of extension files is packaged (never server/, tests/, docs/, data, .env, or anything else), the
// manifest and every file it references are checked, and the output is scanned for secrets. The ZIP is reproducible:
// same sources and options give the same bytes (sorted entries, fixed timestamps).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "background.js", "content", "lib", "popup", "dashboard", "settings", "admin", "icons"];
const EXT_OK = new Set([".js", ".css", ".html", ".png", ".woff2", ".txt", ".json"]);
const ZIP_TIME = { dos: (0 << 11) | (0 << 5) | 0, date: ((2020 - 1980) << 9) | (1 << 5) | 1 }; // 2020-01-01 00:00, always

export class BuildError extends Error {}
const fail = m => { throw new BuildError(m); };

function args(argv) {
  const o = { out: "dist", server: "", keyFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i] ?? fail(`${a} needs a value`);
    if (a === "--out") o.out = next(); else if (a === "--server") o.server = next(); else if (a === "--key-file") o.keyFile = next();
    else fail(`unknown option ${a}`);
  }
  return o;
}

// Same rule as lib/sync.js normalizeServerUrl: https only (plain http just for localhost), no credentials in the URL.
function serverOrigin(input) {
  let u; try { u = new URL(input); } catch { fail(`--server is not a valid URL: ${input}`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) fail("--server must be https:// (http:// only for localhost)");
  if (u.username || u.password) fail("--server must not contain credentials");
  return u.origin;
}

// Accepts a PEM "PUBLIC KEY" or bare base64 DER; returns { base64, id }. The extension ID is derived from the key.
function readPublicKey(file) {
  const text = fs.readFileSync(file, "utf8");
  if (/PRIVATE KEY/i.test(text)) fail("--key-file contains a PRIVATE key. Never put a private key in the build; pass the public key only.");
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || der.length < 90) fail("--key-file is not a base64 or PEM public key");
  try { crypto.createPublicKey({ key: der, format: "der", type: "spki" }); } catch { fail("--key-file is not a valid SPKI public key"); }
  const id = [...crypto.createHash("sha256").update(der).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
  return { base64: der.toString("base64"), id };
}

function walk(rel, files, skipped) {
  const abs = path.join(ROOT, rel), st = fs.statSync(abs);
  if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(rel + "/" + n, files, skipped); return; }
  if (EXT_OK.has(path.extname(rel).toLowerCase())) files.push(rel); else skipped.push(rel);
}

// Everything a loaded extension needs must be in the package, or Chrome fails at runtime: check it now.
function checkReferences(dir, manifest) {
  const has = rel => fs.existsSync(path.join(dir, rel));
  const need = new Set([manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(c => c.js || [])]);
  const bg = fs.readFileSync(path.join(dir, manifest.background.service_worker), "utf8");
  for (const m of bg.matchAll(/importScripts\(([^)]*)\)/g)) for (const f of m[1].matchAll(/"([^"]+)"/g)) need.add(f[1]);
  const pages = [...walkDir(dir)].filter(f => f.endsWith(".html"));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(dir, page), "utf8");
    for (const m of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|data:|#)/.test(m[1])) continue;
      need.add(path.posix.normalize(path.posix.join(path.posix.dirname(page), m[1])));
    }
  }
  const missing = [...need].filter(f => f && !has(f));
  if (missing.length) fail("files referenced but not packaged: " + missing.join(", "));
  return need.size;
}
function* walkDir(dir, rel = "") {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) yield* walkDir(dir, r); else yield r;
  }
}

// The packaged build must carry no credentials, local data or development leftovers.
const BAD_NAME = /(^|\/)(\.env.*|.*\.(db|sqlite|pem|key|log|map|zip)|.*-wal|.*-shm|sim-devices\.json)$/i;
const BAD_TEXT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(MASTER_KEY|COOKIE_SECRET)\s*=\s*\S{8,}/, /\bsk-[A-Za-z0-9]{20,}/, /"device_refresh"\s*:\s*"[^"]{16,}"/, /Bearer [A-Za-z0-9_-]{30,}/];
export function scan(dir) {
  const hits = [];
  for (const f of walkDir(dir)) {
    if (BAD_NAME.test(f)) hits.push(f + " (file name)");
    if (/\.(js|css|html|json|txt)$/.test(f)) { const t = fs.readFileSync(path.join(dir, f), "utf8"); for (const re of BAD_TEXT) if (re.test(t)) hits.push(f + " (matches " + re + ")"); }
  }
  if (hits.length) fail("secret scan failed:\n  " + hits.join("\n  "));
}

// ---- ZIP writer (deflate, sorted, fixed timestamps, no extra fields) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(entries) { // entries: [{ name, data: Buffer }] already sorted
  const locals = [], central = []; let offset = 0;
  for (const { name, data } of entries) {
    const nm = Buffer.from(name, "utf8"), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(ZIP_TIME.dos, 10); lh.writeUInt16LE(ZIP_TIME.date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(ZIP_TIME.dos, 12); ch.writeUInt16LE(ZIP_TIME.date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); central.push(ch, nm); offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function build(argv = process.argv.slice(2)) {
  const o = args(argv), outDir = path.resolve(process.cwd(), o.out), stage = path.join(outDir, "extension");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail("manifest version must be 1-4 dot-separated integers, got " + manifest.version);
  // The version the extension reports to the server (lib/sync.js) must match the manifest it ships with.
  const fallback = /FALLBACK_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "lib/sync.js"), "utf8"));
  if (!fallback || fallback[1] !== manifest.version) fail(`version mismatch: manifest ${manifest.version} vs lib/sync.js FALLBACK_VERSION ${fallback && fallback[1]}`);

  const files = [], skipped = [];
  for (const p of INCLUDE) walk(p, files, skipped);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(stage, f)); }

  const out = { ...manifest };
  let id = null;
  if (o.keyFile) { const k = readPublicKey(o.keyFile); out.key = k.base64; id = k.id; }
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(out, null, 2) + "\n");
  if (o.server) {
    const origin = serverOrigin(o.server);
    fs.writeFileSync(path.join(stage, "lib/build-config.js"), `/* Generated by tools/build-extension.mjs: this build is for one server. */\n(function (root) {\n  "use strict";\n  root.YTBuildConfig = { server: ${JSON.stringify(origin)}, builtAt: null };\n})(typeof self !== "undefined" ? self : this);\n`);
  }

  const refs = checkReferences(stage, out);
  scan(stage);

  const entries = [...walkDir(stage)].sort().map(name => ({ name, data: fs.readFileSync(path.join(stage, name)) }));
  const zipName = `yt-watch-tracker-v${manifest.version}.zip`, zipPath = path.join(outDir, zipName), buf = zip(entries);
  fs.writeFileSync(zipPath, buf);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(zipPath + ".sha256", `${sha}  ${zipName}\n`);
  return { version: manifest.version, stage, zipPath, sha256: sha, files: entries.map(e => e.name), bytes: buf.length, refs, skipped, extensionId: id, server: o.server ? serverOrigin(o.server) : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = build();
    console.log(`Built v${r.version}: ${r.files.length} files, ${(r.bytes / 1024).toFixed(0)} KB`);
    console.log(`  folder  ${r.stage}\n  zip     ${r.zipPath}\n  sha256  ${r.sha256}`);
    console.log(`  server  ${r.server || "(entered in the extension when pairing)"}`);
    console.log(`  id      ${r.extensionId || "(no --key-file: Chrome derives the ID from the install folder; see docs/EXTENSION.md)"}`);
    console.log(`  checks  manifest v3 OK · ${r.refs} referenced files present · secret scan clean${r.skipped.length ? ` · skipped ${r.skipped.length} non-extension file(s)` : ""}`);
  } catch (e) {
    if (e instanceof BuildError) { console.error("Build failed: " + e.message); process.exit(1); }
    throw e;
  }
}
