#!/usr/bin/env node
// Builds the release assets that scripts/update.sh --version and the install guide download from a GitHub release:
//
//   node tools/build-release.mjs [--out dist/release] [--allow-dirty]
//
//   watch-ledger-v<version>.tar.gz   the application: every file git tracks, under ONE top-level folder watch-ledger-v<version>/
//                                    (update.sh unpacks it with --strip-components=1)
//   yt-watch-tracker-v<version>.zip  the Chrome extension (tools/build-extension.mjs; not tied to a server)
//   SHA256SUMS                       "<sha256>  <file>" for both, read by update.sh and by `sha256sum -c SHA256SUMS`
//
// The tarball is written here (POSIX ustar + gzip), not by the system tar, so it is the same whatever machine builds it: file modes
// come from git (0755 for files git marks executable, 0644 otherwise), owner root (0/0), timestamps from the HEAD commit.
// It refuses to build when: the versions in manifest.json, server/package.json and server/package-lock.json disagree; a tracked file
// is one that must never ship (secrets, keys, databases, backups, logs, node_modules, build output); a file holds a private key or an
// access token; or tracked files have uncommitted changes (unless --allow-dirty, for tests). Nothing is uploaded or tagged.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as buildExtension } from "./build-extension.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
export class ReleaseError extends Error {}
const fail = m => { throw new ReleaseError(m); };

/* ---- versions ---- */
// The release version is manifest.json's version_name (or version), and every other place must agree with it.
export function checkVersions(root = ROOT) {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(root, f), "utf8")); } catch { return fail(`cannot read ${f}`); } };
  const m = read("manifest.json"), pkg = read("server/package.json"), lock = read("server/package-lock.json");
  const name = m.version_name || m.version;
  if (typeof name !== "string" || !SEMVER.test(name)) fail(`manifest.json names no valid version (${name})`);
  const core = name.split("-")[0];
  if (m.version !== core) fail(`manifest.json "version" is ${m.version}, but "version_name" ${name} needs ${core} (Chrome allows only numbers there)`);
  if (pkg.version !== name) fail(`server/package.json says ${pkg.version}, manifest.json says ${name}`);
  if (lock.version !== name || !lock.packages || !lock.packages[""] || lock.packages[""].version !== name) fail(`server/package-lock.json does not say ${name} (run npm install --package-lock-only in server/)`);
  const sync = /FALLBACK_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(root, "lib/sync.js"), "utf8"));
  if (!sync || sync[1] !== m.version) fail(`lib/sync.js FALLBACK_VERSION is ${sync && sync[1]}, manifest.json "version" is ${m.version}`);
  return { version: name, tag: "v" + name, prerelease: name.includes("-"), numeric: m.version };
}

/* ---- what may ship ---- */
// A path that must never be in a release, whatever git says.
export function forbiddenPath(p) {
  const parts = p.split("/"), base = parts[parts.length - 1].toLowerCase();
  if (parts.some(s => ["node_modules", ".git", "backups", "dist", "release-staging", ".npm", ".cache"].includes(s))) return "build output, dependencies, git data or backups";
  if (parts.length > 1 && parts[0] === "server" && parts[1] === "data") return "server data";
  if (/^\.env($|\.)/.test(base) && base !== ".env.example") return "an environment file (secrets)";
  if (/\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|sqlite-wal|sqlite-shm|pem|key|p12|pfx|crt|log|tmp|bak|swp|orig|rej)$/.test(base) || /\.db\.pre-restore-/.test(base)) return "a database, key, log or temporary file";
  if (/^(key-file|id_rsa|id_ed25519)/.test(base) || base === ".ds_store" || base === "thumbs.db") return "a key or system file";
  return null;
}
// File contents that must never ship. A file may say on purpose that it is a test fixture of exactly this kind of content.
const SECRET_PATTERNS = [[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"], [/\bghp_[A-Za-z0-9]{36}\b/, "a GitHub token"], [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "a GitHub token"], [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an API key"]];
const FIXTURES = new Set(["server/test/build.test.js", "tools/build-release.mjs", "server/test/release.test.js"]); // they contain such patterns to test the scanners
export function secretIn(p, buf) {
  if (FIXTURES.has(p)) return null;
  const text = buf.toString("latin1");
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

/* ---- git ---- */
function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${String(r.stderr || "").trim()}`);
  return r.stdout;
}
// [{ path, mode }] for every tracked file that exists, from the index (mode 100755 = executable).
export function trackedFiles(root = ROOT) {
  return git(root, ["ls-files", "-s", "-z"]).toString("utf8").split("\0").filter(Boolean).map(l => {
    const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(l); if (!m) fail("unexpected git ls-files line: " + l);
    return { path: m[2], mode: m[1] };
  }).filter(f => f.mode !== "120000" && f.mode !== "160000" && fs.existsSync(path.join(root, f.path))).sort((a, b) => (a.path < b.path ? -1 : 1));
}
// "porcelain" lines of tracked files with uncommitted changes -> the paths, or [].
export const dirtyPaths = porcelain => porcelain.split("\n").filter(l => l.trim()).map(l => l.slice(3));
export const headTime = (root = ROOT) => Number(git(root, ["log", "-1", "--format=%ct"]).toString().trim()) || 0;

/* ---- tar (POSIX ustar) + gzip ---- */
function header(name, { size = 0, mode, mtime, type }) {
  const h = Buffer.alloc(512);
  let prefix = "", nm = name;
  if (Buffer.byteLength(nm) > 100) { const i = nm.lastIndexOf("/", nm.length - 1 - (type === "5" ? 1 : 0)); prefix = nm.slice(0, i); nm = nm.slice(i + 1); }
  if (Buffer.byteLength(nm) > 100 || Buffer.byteLength(prefix) > 155) fail("path too long for a tar header: " + name);
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(nm, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8); put(oct(size, 12), 124, 12); put(oct(mtime, 12), 136, 12);
  h.fill(" ", 148, 156); put(type, 156, 1); put("ustar\0", 257, 6); put("00", 263, 2); put("root", 265, 32); put("root", 297, 32); put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
// entries: [{ name, data?: Buffer, mode, dir?: true }]; returns the .tar.gz bytes.
export function tarGz(entries, mtime) {
  const parts = [];
  for (const e of entries) {
    if (e.dir) { parts.push(header(e.name.endsWith("/") ? e.name : e.name + "/", { mode: 0o755, mtime, type: "5" })); continue; }
    parts.push(header(e.name, { size: e.data.length, mode: e.mode, mtime, type: "0" }), e.data);
    const pad = (512 - (e.data.length % 512)) % 512; if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}
// Reads a .tar.gz written by tarGz (or any plain ustar): [{ name, mode, type, data }].
export function readTarGz(buf) {
  const t = zlib.gunzipSync(buf), out = [];
  for (let off = 0; off + 512 <= t.length;) {
    const h = t.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, l) => h.subarray(a, a + l).toString("utf8").replace(/\0.*$/s, "");
    const name = (str(345, 155) ? str(345, 155) + "/" : "") + str(0, 100), size = parseInt(str(124, 12).trim() || "0", 8), type = str(156, 1) || "0";
    out.push({ name, mode: parseInt(str(100, 8).trim(), 8), type, data: t.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

/* ---- build ---- */
export function buildRelease({ root = ROOT, out = path.join(ROOT, "dist", "release"), allowDirty = false } = {}) {
  const v = checkVersions(root);
  const dirty = dirtyPaths(git(root, ["status", "--porcelain", "--untracked-files=no"]).toString("utf8"));
  if (dirty.length && !allowDirty) fail(`tracked files have uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}); commit them first, so the release is exactly a commit`);
  const files = trackedFiles(root), problems = [];
  for (const f of files) { const why = forbiddenPath(f.path); if (why) problems.push(`${f.path}: ${why}`); }
  if (problems.length) fail("these tracked files must never ship:\n  " + problems.join("\n  "));
  const top = `watch-ledger-${v.tag}`, mtime = headTime(root), dirs = new Set([top]), entries = [];
  for (const f of files) {
    const data = fs.readFileSync(path.join(root, f.path)), secret = secretIn(f.path, data);
    if (secret) problems.push(`${f.path}: contains ${secret}`);
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) { const d = top + "/" + parts.slice(0, i).join("/"); if (!dirs.has(d)) { dirs.add(d); entries.push({ name: d, dir: true }); } }
    entries.push({ name: `${top}/${f.path}`, data, mode: f.mode === "100755" ? 0o755 : 0o644 });
  }
  if (problems.length) fail("refusing to package:\n  " + problems.join("\n  "));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  fs.mkdirSync(out, { recursive: true });
  const tgzName = `${top}.tar.gz`, tgz = tarGz([{ name: top, dir: true }, ...entries], mtime);
  fs.writeFileSync(path.join(out, tgzName), tgz);
  // the extension: built into a staging folder inside out/, then only the ZIP is kept next to the tarball
  const stage = path.join(out, ".extension-build");
  const ext = buildExtension(["--out", stage]);
  const zipName = path.basename(ext.zipPath);
  if (zipName !== `yt-watch-tracker-${v.tag}.zip`) fail(`the extension build is ${zipName}, expected yt-watch-tracker-${v.tag}.zip`);
  fs.copyFileSync(ext.zipPath, path.join(out, zipName));
  fs.rmSync(stage, { recursive: true, force: true }); // only the staging folder this run created
  const sums = [tgzName, zipName].sort().map(n => `${sha256(fs.readFileSync(path.join(out, n)))}  ${n}`).join("\n") + "\n";
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
  return { ...v, out, tarball: tgzName, zip: zipName, files: files.length, executables: files.filter(f => f.mode === "100755").map(f => f.path), dirty, sums, ...verifyRelease(out, v) };
}

// Checks what is in out/: the checksums, one top-level folder, nothing that must not ship, and the versions inside the tarball.
export function verifyRelease(out, v) {
  const sums = fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8").trim().split("\n").map(l => { const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); if (!m) fail("bad SHA256SUMS line: " + l); return { hash: m[1], name: m[2] }; });
  for (const s of sums) if (sha256(fs.readFileSync(path.join(out, s.name))) !== s.hash) fail("checksum mismatch: " + s.name);
  const tgz = sums.find(s => s.name.endsWith(".tar.gz")), entries = readTarGz(fs.readFileSync(path.join(out, tgz.name)));
  const top = `watch-ledger-${v.tag}`;
  const bad = entries.filter(e => !(e.name === top + "/" || e.name.startsWith(top + "/")) || forbiddenPath(e.name.slice(top.length + 1).replace(/\/$/, "")));
  if (bad.length) fail("unexpected entries in the tarball: " + bad.slice(0, 5).map(e => e.name).join(", "));
  const file = n => entries.find(e => e.name === `${top}/${n}`);
  for (const must of ["manifest.json", "install.sh", "scripts/update.sh", "scripts/lib/common.sh", "server/package.json", "server/package-lock.json", "server/src/server.js", "tools/build-extension.mjs"])
    if (!file(must)) fail("the tarball has no " + must);
  const m = JSON.parse(file("manifest.json").data.toString()), pkg = JSON.parse(file("server/package.json").data.toString());
  if ((m.version_name || m.version) !== v.version || pkg.version !== v.version) fail("the tarball's versions do not say " + v.version);
  return { verified: true, entries: entries.length, top };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), at = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  for (const a of argv) if (a.startsWith("--") && !["--out", "--allow-dirty"].includes(a)) { console.error("Unknown option: " + a); process.exit(2); }
  try {
    const r = buildRelease({ out: path.resolve(process.cwd(), at("--out") || path.join(ROOT, "dist", "release")), allowDirty: argv.includes("--allow-dirty") });
    console.log(`Release ${r.tag}${r.prerelease ? " (pre-release: publish it as a GitHub pre-release)" : " (stable: publish it as a full release, not a pre-release)"}`);
    console.log(`  ${r.tarball}  ${r.files} files, top-level folder ${r.top}/, ${r.executables.length} executable`);
    console.log(`  ${r.zip}\n  SHA256SUMS\n${r.sums.replace(/^/gm, "    ").trimEnd()}\n  in ${r.out}`);
    if (r.dirty.length) console.log(`  WARNING: built with uncommitted changes in ${r.dirty.length} tracked file(s) (--allow-dirty); do not publish this build.`);
  } catch (e) {
    if (e instanceof ReleaseError) { console.error("Release build refused: " + e.message); process.exit(1); }
    throw e;
  }
}
