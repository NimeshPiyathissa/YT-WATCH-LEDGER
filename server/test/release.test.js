// Release packaging (tools/build-release.mjs): consistent versions, nothing that must not ship, one top-level folder, file modes from
// git, checksums that update.sh and sha256sum accept, reproducible output, and refusal when something is wrong. Builds into temporary
// folders only; nothing is uploaded or tagged. (That update.sh, current and v0.7.0's, accepts the tarball is checked by the installer suite.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./tmpdir.js";
import { checkVersions, forbiddenPath, secretIn, tarGz, readTarGz, buildRelease, verifyRelease, dirtyPaths, ReleaseError } from "../../tools/build-release.mjs";
import { parseVersion, compareVersions, channelOf } from "../src/lib/version.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const hasTar = spawnSync("tar", ["--version"]).status === 0;

test("the version metadata is consistent and names 0.8.0-rc.1, a pre-release that orders between beta and final", () => {
  const v = checkVersions();
  assert.deepEqual(v, { version: "0.8.0-rc.1", tag: "v0.8.0-rc.1", prerelease: true, numeric: "0.8.0" });
  assert.equal(channelOf(v.version), "rc");
  assert.ok(compareVersions(v.version, "0.8.0-beta.1") > 0 && compareVersions(v.version, "0.8.0") < 0 && compareVersions(v.version, "0.7.0") > 0);
  assert.equal(parseVersion(v.tag).text, v.version);
});

function fixtureRepo(over = {}) {
  const d = tmpDir("yt-rel-fix-");
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  const name = over.name ?? "0.9.0-rc.2", num = over.num ?? "0.9.0";
  w("manifest.json", JSON.stringify({ manifest_version: 3, version: num, ...(name === num ? {} : { version_name: name }) }));
  w("server/package.json", JSON.stringify({ version: over.pkg ?? name }));
  w("server/package-lock.json", JSON.stringify({ version: over.lock ?? name, packages: { "": { version: over.lockPkg ?? over.lock ?? name } } }));
  w("lib/sync.js", `const FALLBACK_VERSION = "${over.sync ?? num}";`);
  return { dir: d, w };
}
test("version checks refuse every disagreement between manifest.json, package.json, package-lock.json and lib/sync.js", () => {
  assert.equal(checkVersions(fixtureRepo().dir).version, "0.9.0-rc.2");
  assert.equal(checkVersions(fixtureRepo({ name: "1.0.0", num: "1.0.0" }).dir).prerelease, false);
  for (const [over, re] of [[{ num: "0.8.0" }, /needs 0\.9\.0/], [{ pkg: "0.9.0-rc.1" }, /package\.json says/], [{ lock: "0.9.0-rc.1" }, /package-lock/], [{ lockPkg: "0.9.0" }, /package-lock/],
    [{ sync: "0.8.9" }, /FALLBACK_VERSION/], [{ name: "0.9.0-rc..2" }, /no valid version/], [{ name: "v0.9.0", num: "0.9.0" }, /no valid version/]])
    assert.throws(() => checkVersions(fixtureRepo(over).dir), e => e instanceof ReleaseError && re.test(e.message), JSON.stringify(over));
});

test("what must never ship: secrets, keys, databases, backups, logs, dependencies, git data and build output", () => {
  for (const p of [".env", "server/.env", "server/.env.production", "server/data/tracker.db", "x/tracker.db", "a.db-wal", "b.sqlite", "k.pem", "id_rsa", "tls.key", "key-file.txt",
    "node_modules/a/index.js", "server/node_modules/x.js", ".git/config", "backups/t.db", "dist/release/x.zip", "release-staging/a", "server.log", "a.tmp", "x.bak", "tracker.db.pre-restore-1", ".DS_Store"])
    assert.ok(forbiddenPath(p), p);
  for (const p of ["server/.env.example", "server/src/server.js", "scripts/update.sh", "docs/BACKUP_RECOVERY.md", "server/migrations/009_saved_reports.sql", "assets/thumbnail.png", "server/src/lib/backup.js"])
    assert.equal(forbiddenPath(p), null, p);
  const key = "-----BEGIN " + "PRIVATE KEY-----\nabc", tok = "ghp_" + "a".repeat(36);
  assert.equal(secretIn("lib/x.js", Buffer.from(key)), "a private key");
  assert.equal(secretIn("docs/x.md", Buffer.from("token " + tok)), "a GitHub token");
  assert.equal(secretIn("server/test/updates.test.js", Buffer.from("ghp_secret_should_never_leave")), null, "an obviously fake value is not a token");
  assert.equal(secretIn("server/test/build.test.js", Buffer.from(key)), null, "the scanners' own test fixtures are known");
});

test("the tar writer: ustar with root ownership, the given modes, long paths, and readable by GNU tar", { skip: false }, () => {
  const long = "top/" + "d".repeat(60) + "/" + "e".repeat(50) + "/file.txt";
  const buf = tarGz([{ name: "top", dir: true }, { name: "top/run.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }, { name: long, data: Buffer.from("x".repeat(700)), mode: 0o644 }], 1700000000);
  const e = readTarGz(buf);
  assert.deepEqual(e.map(x => [x.name, x.mode.toString(8), x.type]), [["top/", "755", "5"], ["top/run.sh", "755", "0"], [long, "644", "0"]]);
  assert.equal(e[2].data.length, 700);
  if (hasTar) {
    const d = tmpDir("yt-rel-tar-"), f = path.join(d, "t.tar.gz"); fs.writeFileSync(f, buf);
    const r = spawnSync("tar", ["-tvzf", "t.tar.gz"], { cwd: d, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /-rwxr-xr-x root\/root .* top\/run\.sh/); assert.ok(r.stdout.includes(long));
  }
});

test("a full release build: three assets, correct checksums, one top-level folder, executable scripts, versions, nothing forbidden; reproducible", () => {
  const out = tmpDir("yt-rel-out-"), r = buildRelease({ out, allowDirty: true });
  assert.deepEqual(fs.readdirSync(out).sort(), ["SHA256SUMS", "watch-ledger-v0.8.0-rc.1.tar.gz", "yt-watch-tracker-v0.8.0-rc.1.zip"], "only the assets: the extension staging folder is gone");
  const sums = fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.equal(sums.length, 2);
  for (const l of sums) { const [h, n] = l.split("  "); assert.equal(sha(fs.readFileSync(path.join(out, n))), h, n); }
  const entries = readTarGz(fs.readFileSync(path.join(out, r.tarball)));
  assert.ok(entries.every(e => e.name.startsWith("watch-ledger-v0.8.0-rc.1/")), "one top-level folder");
  assert.ok(!entries.some(e => forbiddenPath(e.name.replace(/^[^/]+\//, "").replace(/\/$/, ""))), "nothing forbidden");
  const mode = n => (entries.find(e => e.name === "watch-ledger-v0.8.0-rc.1/" + n) || {}).mode;
  for (const s of ["install.sh", "scripts/update.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/health-check.sh", "scripts/install.sh"]) assert.equal(mode(s), 0o755, s + " is executable (A30)");
  assert.equal(mode("scripts/lib/common.sh"), 0o644); assert.equal(mode("server/src/server.js"), 0o644);
  for (const must of ["server/migrations/007_device_consents_sync_diagnostics.sql", "server/migrations/008_notifications.sql", "server/migrations/009_saved_reports.sql", "server/web/updates.js", "docs/UPGRADING.md"])
    assert.ok(mode(must), must + " is in the release");
  const again = tmpDir("yt-rel-out2-"); buildRelease({ out: again, allowDirty: true });
  assert.equal(sha(fs.readFileSync(path.join(again, r.tarball))), sha(fs.readFileSync(path.join(out, r.tarball))), "the same tree builds the same tarball, byte for byte");
  // tampering is caught
  fs.appendFileSync(path.join(out, r.zip), "x");
  assert.throws(() => verifyRelease(out, checkVersions()), /checksum mismatch/);
});

test("uncommitted changes are refused unless explicitly allowed (a published release is exactly a commit)", () => {
  assert.deepEqual(dirtyPaths(" M scripts/update.sh\nM  manifest.json\n"), ["scripts/update.sh", "manifest.json"]);
  assert.deepEqual(dirtyPaths(""), []);
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() !== "";
  if (dirty) assert.throws(() => buildRelease({ out: tmpDir("yt-rel-dirty-") }), /uncommitted changes/);
});

test("a tracked file that must never ship, or one holding a private key, stops the build before anything is written", { skip: spawnSync("git", ["--version"]).status !== 0 ? "no git" : false }, () => {
  const g = (d, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: d, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  for (const [file, content, re] of [["server/.env", "MASTER_KEY=x", /must never ship[\s\S]*server\/\.env/], ["lib/creds.js", "-----BEGIN " + "RSA PRIVATE KEY-----", /lib\/creds\.js: contains a private key/]]) {
    const { dir, w } = fixtureRepo(); w(file, content);
    g(dir, "init", "-q"); g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", "fixture");
    const out = path.join(tmpDir("yt-rel-ref-"), "out");
    assert.throws(() => buildRelease({ root: dir, out }), re, file);
    assert.equal(fs.existsSync(out), false, "nothing was written");
  }
});
