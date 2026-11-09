// Update Manager in a real headless Chrome: the owner's clicks. Status, the check switched off and on (a failure, then a release found),
// copying a command, verifying a pre-update backup, the empty history and the phone layout. Throwaway server, database and fake
// installation; GitHub is replaced by a stand-in (no network). Skipped where there is no Chrome.
import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, migrate } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { createBackup } from "../src/lib/backup.js";
import { addOwner, OWNER, PW } from "./helpers.js";
import { tmpDir } from "./tmpdir.js";

const { findChrome, launch } = await import("../../scripts/lib/chrome-ext.mjs");
const REPO_PAGE = "https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER/releases/";

test("Update Manager: status, release check, copyable commands, backups and history work in a real browser", { skip: findChrome() ? false : "no Chrome or Chromium found", timeout: 150000 }, async () => {
  const base = tmpDir("yt-updui-"), rel = path.join(base, "opt", "releases"), backupDir = path.join(base, "backups"), pre = path.join(backupDir, "pre-update");
  for (const v of ["0.8.0-beta.1", "0.7.0"]) { fs.mkdirSync(path.join(rel, v, "server"), { recursive: true }); fs.writeFileSync(path.join(rel, v, "server", "package.json"), JSON.stringify({ version: v })); fs.writeFileSync(path.join(rel, v, ".install-complete"), v); }
  fs.mkdirSync(pre, { recursive: true });
  const historyFile = path.join(base, "update-history.jsonl");
  const h = o => JSON.stringify({ v: 1, at: "2026-11-01T10:00:00Z", from: "0.7.0", to: "0.8.0-beta.1", result: "success", stage: "verifying", source: "github", backup: "tracker-20261101T095900Z.db", previous: "0.7.0", exitCode: 0, ...o });
  fs.writeFileSync(historyFile, [h({}), h({ at: "2026-11-05T10:00:00Z", from: "0.8.0-beta.1", to: "0.8.0-beta.2", result: "rolled_back", stage: "migrating and switching", exitCode: 1 })].join("\n") + "\n");
  let mode = "limited";
  const fetch = async () => mode === "limited"
    ? new Response(JSON.stringify({ message: "rate limit" }), { status: 403, headers: { "content-type": "application/json" } })
    : new Response(JSON.stringify([{ tag_name: "v0.8.0", draft: false, prerelease: false, name: "Big <img src=x onerror=window.__pwned=1> release", html_url: REPO_PAGE + "tag/v0.8.0", published_at: "2026-11-20T00:00:00Z" }]), { headers: { "content-type": "application/json" } });
  const db = openDb(); migrate(db); await addOwner(db);
  await createBackup(db, pre, 1000);
  const app = await buildApp({ db, config: { backupDir, backupKeep: 3, updateHistoryFile: historyFile, serverRoot: path.join(rel, "0.8.0-beta.1", "server"), fetch } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = "http://127.0.0.1:" + app.server.address().port;
  const savedBase = process.env.BASE_URL; process.env.BASE_URL = url;
  const chrome = await launch({ extensionDir: null });
  const steps = [];
  const check = (name, ok, detail = "") => { steps.push({ name, ok: !!ok }); console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  (" + detail + ")" : "")); };
  try {
    const tab = await chrome.openTab(url + "/"), sid = await chrome.attach(tab);
    await chrome.send("Browser.grantPermissions", { origin: url, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    const ev = expr => chrome.evalIn(tab, expr, { userGesture: true });
    const until = (expr, ms = 10000) => chrome.waitFor(() => ev(expr), { timeout: ms, step: 150 });
    const text = id => ev(`(document.getElementById(${JSON.stringify(id)}) || {}).textContent || ""`);
    await until("!!document.getElementById('app')");
    check("sign-in", await ev(`fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:${JSON.stringify(OWNER)},password:${JSON.stringify(PW)}})}).then(r=>r.status)`) === 200);
    const go = async hash => {
      if ((await ev("location.hash")) === hash) { await ev("location.hash='#/audit'; 1"); await until("location.hash === '#/audit' && !!document.querySelector('#app h1')"); } // the same address fires no hashchange
      await ev(`document.getElementById('app').innerHTML=''; location.hash=${JSON.stringify(hash)}; 1`);
      return until("!!document.getElementById('umBody') && !document.getElementById('umBody').hasAttribute('aria-busy')", 30000); // a cold browser under the full suite's load can be slow
    };

    // ---- status ----
    check("the sidebar has an Updates entry under System", await ev("!!document.querySelector('#nav a[data-nav=\"updates\"]')"));
    check("the page draws", await go("#/updates"));
    check("the installed version and its channel", (await text("umVerH")) === "0.8.0-beta.1" && /Beta channel/.test(await text("umBody")));
    check("Node.js version and uptime", (await ev("document.querySelector('.um-facts').textContent")).includes(process.versions.node) && /Running for/.test(await text("umBody")));
    check("installer layout and the installed date from the history", /Installer layout/.test(await text("umBody")) && /installed November 1, 2026/.test(await text("umBody")));

    // ---- history and backups ----
    check("history lists both attempts, newest first, with their results", await ev("[...document.querySelectorAll('.um-event .pill')].map(p => p.textContent).join('|') === 'Rolled back|Updated'"));
    check("...explaining that the previous release was switched back", /previous release \(0\.7\.0\) was switched back/.test(await ev("document.querySelector('.um-event').textContent")));
    check("the pre-update backup is listed", await ev("document.querySelectorAll('.um-backups tbody tr').length === 1"));
    await ev("document.querySelector('[data-verify]').click(); 1");
    check("Verify checks it and says it is restorable", await until("/Restorable: intact/.test(document.querySelector('[data-vres]').textContent)"));

    // ---- the check, off ----
    check("the check is off by default: Check now is disabled and Settings is offered", await ev("document.getElementById('umCheck').disabled && /Check is off/.test(document.querySelector('.um-check').textContent) && !!document.querySelector('.um-check a[href=\"#/settings\"]')"));
    check("the instructions use a placeholder version while nothing was found", await ev("[...document.querySelectorAll('.um-cmd code')].some(c => c.textContent === 'sudo ./scripts/update.sh --version vX.Y.Z')"));
    check("the rollback commands name the previous installed release", await ev("[...document.querySelectorAll('.um-cmd code')].some(c => c.textContent === 'sudo ln -sfn /opt/watch-ledger/releases/0.7.0 /opt/watch-ledger/current')"));

    // ---- copy ----
    await ev("document.querySelector('[data-copy=\"umU3\"]').click(); 1");
    check("Copy says so", await until("/Copied/.test(document.getElementById('toast').textContent)"));
    const clip = await ev("navigator.clipboard.readText()");
    check("...and the clipboard holds exactly the command", clip === "sudo ./scripts/update.sh --version vX.Y.Z", clip);

    // ---- the check, on: a failure, then a release ----
    const put = await ev(`fetch("/api/settings/studio",{method:"PUT",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({changes:{update_check_enabled:true}})}).then(r=>r.status)`);
    check("(setup) switch the check on in Settings", put === 200);
    await go("#/updates");
    check("with the check on, Check now is enabled", await ev("!document.getElementById('umCheck').disabled && /Check is on/.test(document.querySelector('.um-check').textContent)"));
    await ev("document.getElementById('umCheck').click(); 1");
    check("a refused check says why", await until("/limiting requests/.test(document.getElementById('umResultBox').textContent)"));
    mode = "ok";
    await ev("document.getElementById('umCheck').click(); 1");
    check("a new release is announced", await until("/0\\.8\\.0 is available/.test(document.getElementById('umResultBox').textContent)"));
    check("...its name is shown as text, not run", await ev("!window.__pwned && !document.querySelector('#umResultBox img') && /<img src=x/.test(document.getElementById('umResultBox').textContent)"));
    check("...with a safe link to the release notes", await ev("(() => { const a = document.querySelector('#umResultBox a'); return !!a && a.href.startsWith('https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER/releases/') && a.rel.includes('noopener') && a.rel.includes('noreferrer') && a.target === '_blank'; })()"));
    check("...and the commands are filled in for 0.8.0", await ev("[...document.querySelectorAll('.um-cmd code')].some(c => c.textContent === 'sudo ./scripts/update.sh --version v0.8.0')"));

    // ---- empty history, phone ----
    fs.renameSync(historyFile, historyFile + ".away");
    await go("#/updates");
    check("no history yet: a clear empty state", /No update recorded yet/.test(await text("umBody")));
    fs.renameSync(historyFile + ".away", historyFile);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sid);
    await go("#/updates");
    check("phone width: no sideways scroll", await ev("document.documentElement.scrollWidth <= window.innerWidth"), await ev("document.documentElement.scrollWidth + ' > ' + window.innerWidth"));
    check("the page never offered a button that installs or rolls back", await ev("![...document.querySelectorAll('#umBody button')].some(b => /install|roll ?back|update now|restore/i.test(b.textContent))"));
  } finally {
    await chrome.close(); process.env.BASE_URL = savedBase; await app.close();
  }
  const failed = steps.filter(s => !s.ok).map(s => s.name);
  assert.deepEqual(failed, [], failed.length + " of " + steps.length + " steps failed");
  assert.ok(steps.length >= 25, "ran " + steps.length + " steps");
});
