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
// Everything is packaged from the COMMIT (HEAD), not from the working tree: every file's bytes are read from git, exactly as committed
// (BUG_FIX_REPORT A31: a Windows checkout with core.autocrlf turns LF into CRLF in the working tree, so a working-tree build did not match
// the commit and was not reproducible). The extension ZIP is built from an export of the same commit. The tarball is written here (POSIX
// ustar + gzip), not by the system tar: file modes come from git (0755 for files git marks executable, 0644 otherwise), owner root (0/0),
// timestamps from the HEAD commit. So the same commit gives the same bytes on any machine.
// It refuses to build when: the versions in manifest.json, server/package.json and server/package-lock.json disagree; a tracked file
// is one that must never ship (secrets, keys, databases, backups, logs, node_modules, build output); a file holds a private key or an
// access token; or tracked files have uncommitted changes (unless --allow-dirty, for tests). Nothing is uploaded or tagged.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
export class ReleaseError extends Error {}
const fail = m => { throw new ReleaseError(m); };

/* ---- versions ---- */
// The release version is manifest.json's version_name (or version), and every other place must agree with it.
// `readFile(path) -> string` reads a file; by default from the working tree, and from the commit when building a release.
export function checkVersions(root = ROOT, readFile = f => fs.readFileSync(path.join(root, f), "utf8")) {
  const read = f => { try { return JSON.parse(readFile(f)); } catch { return fail(`cannot read ${f}`); } };
  const m = read("manifest.json"), pkg = read("server/package.json"), lock = read("server/package-lock.json");
  const name = m.version_name || m.version;
  if (typeof name !== "string" || !SEMVER.test(name)) fail(`manifest.json names no valid version (${name})`);
  const core = name.split("-")[0];
  if (m.version !== core) fail(`manifest.json "version" is ${m.version}, but "version_name" ${name} needs ${core} (Chrome allows only numbers there)`);
  if (pkg.version !== name) fail(`server/package.json says ${pkg.version}, manifest.json says ${name}`);
  if (lock.version !== name || !lock.packages || !lock.packages[""] || lock.packages[""].version !== name) fail(`server/package-lock.json does not say ${name} (run npm install --package-lock-only in server/)`);
  let syncSrc = ""; try { syncSrc = readFile("lib/sync.js"); } catch { syncSrc = ""; }
  const sync = /FALLBACK_VERSION = "([^"]+)"/.exec(syncSrc);
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
// [{ path, mode, data }] for every file in a commit, with its exact committed bytes (mode 100755 = executable). Symbolic links and
// submodules are not packaged. Reads the blobs with one `git cat-file --batch`, so line endings are what git stores, on every OS.
export function committedFiles(root = ROOT, rev = "HEAD") {
  const list = git(root, ["ls-tree", "-r", "-z", "--full-tree", rev]).toString("utf8").split("\0").filter(Boolean).map(l => {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(l); if (!m) fail("unexpected git ls-tree line: " + l);
    return { mode: m[1], type: m[2], oid: m[3], path: m[4] };
  }).filter(f => f.type === "blob" && f.mode !== "120000").sort((a, b) => (a.path < b.path ? -1 : 1));
  const r = spawnSync("git", ["cat-file", "--batch"], { cwd: root, input: list.map(f => f.oid).join("\n") + "\n", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) fail("git cat-file failed: " + String(r.stderr || "").trim());
  const buf = r.stdout; let off = 0;
  for (const f of list) {
    const nl = buf.indexOf(10, off), head = buf.subarray(off, nl).toString("utf8").split(" ");
    if (head[0] !== f.oid || head[1] !== "blob") fail("unexpected git cat-file output for " + f.path);
    const size = Number(head[2]); f.data = buf.subarray(nl + 1, nl + 1 + size); off = nl + 1 + size + 1;
    delete f.type; delete f.oid;
  }
  return list;
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
// The gzip header every release tarball has: magic, deflate, no flags (no file name or comment), MTIME 0, XFL 2 (level 9), OS 3 (Unix).
// zlib writes the OS it was built for into the last byte (10 on Windows), so the same tar gave a different .tar.gz, and a different
// SHA256SUMS, on Windows and on Linux (BUG_FIX_REPORT A32); it is set here, and the rest of the file depends only on the tar bytes.
export const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3]);
// entries: [{ name, data?: Buffer, mode, dir?: true }]; returns the .tar.gz bytes.
export function tarGz(entries, mtime) {
  const parts = [];
  for (const e of entries) {
    if (e.dir) { parts.push(header(e.name.endsWith("/") ? e.name : e.name + "/", { mode: 0o755, mtime, type: "5" })); continue; }
    parts.push(header(e.name, { size: e.data.length, mode: e.mode, mtime, type: "0" }), e.data);
    const pad = (512 - (e.data.length % 512)) % 512; if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  if (Buffer.compare(gz.subarray(0, 9), GZIP_HEADER.subarray(0, 9)) !== 0) fail("unexpected gzip header from zlib: " + gz.subarray(0, 10).toString("hex"));
  gz[9] = GZIP_HEADER[9];
  return gz;
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
// Checks the committed files and returns the tarball bytes for them under one top-level folder `top`.
export function makeTarball(files, top, mtime) {
  const problems = [];
  for (const f of files) { const why = forbiddenPath(f.path); if (why) problems.push(`${f.path}: ${why}`); }
  if (problems.length) fail("these tracked files must never ship:\n  " + problems.join("\n  "));
  const dirs = new Set([top]), entries = [];
  for (const f of files) {
    const secret = secretIn(f.path, f.data);
    if (secret) problems.push(`${f.path}: contains ${secret}`);
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) { const d = top + "/" + parts.slice(0, i).join("/"); if (!dirs.has(d)) { dirs.add(d); entries.push({ name: d, dir: true }); } }
    entries.push({ name: `${top}/${f.path}`, data: f.data, mode: f.mode === "100755" ? 0o755 : 0o644 });
  }
  if (problems.length) fail("refusing to package:\n  " + problems.join("\n  "));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return tarGz([{ name: top, dir: true }, ...entries], mtime);
}

export function buildRelease({ root = ROOT, out = path.join(ROOT, "dist", "release"), allowDirty = false } = {}) {
  const dirty = dirtyPaths(git(root, ["status", "--porcelain", "--untracked-files=no"]).toString("utf8"));
  if (dirty.length && !allowDirty) fail(`tracked files have uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}); commit them first, so the release is exactly a commit`);
  const files = committedFiles(root), byPath = new Map(files.map(f => [f.path, f]));
  const readCommitted = p => { const f = byPath.get(p); if (!f) throw new Error("not in the commit: " + p); return f.data.toString("utf8"); };
  const v = checkVersions(root, readCommitted);
  const top = `watch-ledger-${v.tag}`;
  const tgz = makeTarball(files, top, headTime(root)); // checks paths and contents before anything is written
  fs.mkdirSync(out, { recursive: true });
  const tgzName = `${top}.tar.gz`;
  fs.writeFileSync(path.join(out, tgzName), tgz);
  // the extension: built by the committed tools/build-extension.mjs from an export of the commit (never the working tree), in staging
  // folders inside out/ that this run creates and removes; only the ZIP is kept next to the tarball
  const src = path.join(out, ".source"), stage = path.join(out, ".extension-build");
  fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(stage, { recursive: true, force: true });
  for (const f of files) { const t = path.join(src, f.path); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, f.data); }
  const ext = spawnSync(process.execPath, [path.join(src, "tools", "build-extension.mjs"), "--out", stage], { cwd: src, encoding: "utf8" });
  if (ext.status !== 0) fail("the extension build failed: " + (ext.stderr || ext.stdout).trim());
  const zipName = `yt-watch-tracker-${v.tag}.zip`;
  if (!fs.existsSync(path.join(stage, zipName))) fail(`the extension build did not write ${zipName}`);
  fs.copyFileSync(path.join(stage, zipName), path.join(out, zipName));
  fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); // only the staging folders this run created
  const sums = [tgzName, zipName].sort().map(n => `${sha256(fs.readFileSync(path.join(out, n)))}  ${n}`).join("\n") + "\n";
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
  return { ...v, out, tarball: tgzName, zip: zipName, files: files.length, executables: files.filter(f => f.mode === "100755").map(f => f.path), dirty, sums, ...verifyRelease(out, v, files) };
}

/* ---- zip (the extension) ---- */
// Reads a ZIP written by tools/build-extension.mjs (stored or deflated entries): [{ name, data }].
export function readZip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) fail("not a zip file");
  const n = buf.readUInt16LE(e + 10); let off = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) fail("bad zip central directory");
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString("utf8");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), raw = buf.subarray(start, start + csize);
    out.push({ name, data: method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : fail("unsupported zip method " + method) });
    off += 46 + nlen + xlen + clen;
  }
  return out;
}

// Checks what is in out/: the checksums, one top-level folder, nothing that must not ship, the versions inside the tarball and, when the
// committed files are given, that every tarball entry and every extension file is byte-for-byte the committed one (and nothing else is there).
export function verifyRelease(out, v, committed = null) {
  const sums = fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8").trim().split("\n").map(l => { const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l); if (!m) fail("bad SHA256SUMS line: " + l); return { hash: m[1], name: m[2] }; });
  for (const s of sums) if (sha256(fs.readFileSync(path.join(out, s.name))) !== s.hash) fail("checksum mismatch: " + s.name);
  const tgz = sums.find(s => s.name.endsWith(".tar.gz")), tgzBuf = fs.readFileSync(path.join(out, tgz.name)), entries = readTarGz(tgzBuf);
  if (Buffer.compare(tgzBuf.subarray(0, 10), GZIP_HEADER) !== 0) fail("the tarball's gzip header is not the fixed one (A32): " + tgzBuf.subarray(0, 10).toString("hex"));
  const top = `watch-ledger-${v.tag}`;
  const bad = entries.filter(e => !(e.name === top + "/" || e.name.startsWith(top + "/")) || forbiddenPath(e.name.slice(top.length + 1).replace(/\/$/, "")));
  if (bad.length) fail("unexpected entries in the tarball: " + bad.slice(0, 5).map(e => e.name).join(", "));
  const file = n => entries.find(e => e.name === `${top}/${n}`);
  for (const must of ["manifest.json", "install.sh", "scripts/update.sh", "scripts/lib/common.sh", "server/package.json", "server/package-lock.json", "server/src/server.js", "tools/build-extension.mjs"])
    if (!file(must)) fail("the tarball has no " + must);
  const m = JSON.parse(file("manifest.json").data.toString()), pkg = JSON.parse(file("server/package.json").data.toString());
  if ((m.version_name || m.version) !== v.version || pkg.version !== v.version) fail("the tarball's versions do not say " + v.version);
  let zipFiles = 0;
  if (committed) {
    const byPath = new Map(committed.map(f => [f.path, f])), seen = new Set();
    for (const e of entries.filter(x => x.type === "0")) {
      const p = e.name.slice(top.length + 1), f = byPath.get(p);
      if (!f) fail("the tarball holds a file that is not in the commit: " + p);
      if (Buffer.compare(f.data, e.data) !== 0) fail("the tarball's copy differs from the commit: " + p);
      if ((f.mode === "100755") !== (e.mode === 0o755)) fail("the tarball's file mode differs from the commit: " + p);
      seen.add(p);
    }
    const missing = committed.filter(f => !seen.has(f.path));
    if (missing.length) fail("the tarball lacks committed files: " + missing.slice(0, 5).map(f => f.path).join(", "));
    const zip = sums.find(s => s.name.endsWith(".zip"));
    if (zip) for (const z of readZip(fs.readFileSync(path.join(out, zip.name)))) {
      const f = byPath.get(z.name);
      if (!f) fail("the extension holds a file that is not in the commit: " + z.name);
      // manifest.json is rewritten by the extension build (same content, its own formatting); every other file is copied as committed
      const same = z.name === "manifest.json" ? JSON.stringify(JSON.parse(z.data.toString())) === JSON.stringify(JSON.parse(f.data.toString())) : Buffer.compare(z.data, f.data) === 0;
      if (!same) fail("the extension's copy differs from the commit: " + z.name);
      zipFiles++;
    }
  }
  return { verified: true, entries: entries.length, top, zipFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), at = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  for (const a of argv) if (a.startsWith("--") && !["--out", "--allow-dirty"].includes(a)) { console.error("Unknown option: " + a); process.exit(2); }
  try {
    const r = buildRelease({ out: path.resolve(process.cwd(), at("--out") || path.join(ROOT, "dist", "release")), allowDirty: argv.includes("--allow-dirty") });
    console.log(`Release ${r.tag}${r.prerelease ? " (pre-release: publish it as a GitHub pre-release)" : " (stable: publish it as a full release, not a pre-release)"}`);
    console.log(`  ${r.tarball}  ${r.files} files, top-level folder ${r.top}/, ${r.executables.length} executable`);
    console.log(`  ${r.zip}\n  SHA256SUMS\n${r.sums.replace(/^/gm, "    ").trimEnd()}\n  in ${r.out}`);
    console.log(`  verified: every file is byte-for-byte the committed one (${r.files} in the tarball, ${r.zipFiles} in the extension)`);
    if (r.dirty.length) console.log(`  WARNING: ${r.dirty.length} tracked file(s) have uncommitted changes (--allow-dirty); they are NOT in this build, which is the last commit. Do not publish it.`);
  } catch (e) {
    if (e instanceof ReleaseError) { console.error("Release build refused: " + e.message); process.exit(1); }
    throw e;
  }
}
