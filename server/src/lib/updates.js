// Update Manager: read-only facts about this installation, and the opt-in release check. Nothing here changes the installation: it
// never starts a process, never writes outside the settings table, and never touches the release folders. Updates and rollbacks are
// run on the server by scripts/update.sh (see docs/UPDATES.md); the dashboard only shows how.
import fs from "node:fs";
import path from "node:path";
import { parseVersion, compareVersions } from "./version.js";

export const REPO = "NimeshPiyathissa/YT-WATCH-LEDGER";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/`;
const MAX_HISTORY_BYTES = 256 * 1024, MAX_HISTORY = 200, MAX_RESPONSE_BYTES = 1024 * 1024, MAX_RELEASES = 100;
const RESULTS = ["success", "rolled_back", "failed", "cancelled"];
const SAFE = /^[A-Za-z0-9._ -]{0,100}$/;
const NOTHING_CHANGED = ["start", "verifying the target release"]; // stages before the pre-update backup: the installation was not touched

// Where the installer's update.sh writes its history: ${WL_VAR}/update-history.jsonl, and DB_PATH is ${WL_VAR}/data/tracker.db.
// UPDATE_HISTORY_FILE overrides it. null for an in-memory database (tests, development).
export function defaultHistoryFile(dbPath, env = process.env) {
  if (env.UPDATE_HISTORY_FILE) return env.UPDATE_HISTORY_FILE;
  if (!dbPath || dbPath === ":memory:") return null;
  return path.join(path.dirname(path.dirname(path.resolve(dbPath))), "update-history.jsonl");
}

// The newest entries first. Reads at most the last 256 KB; a line that is not a well-formed entry is skipped (counted in `skipped`),
// never shown and never fatal. Every field is re-validated: the file lives in a folder the service can write to.
export function readHistory(file) {
  const out = { items: [], skipped: 0, available: false };
  if (!file) return out;
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return out;
    out.available = true;
    const fd = fs.openSync(file, "r"), len = Math.min(st.size, MAX_HISTORY_BYTES), buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    text = buf.toString("utf8");
    if (st.size > len) text = text.slice(text.indexOf("\n") + 1); // the first line may be cut in half
  } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = parseEntry(line);
    if (e) out.items.push(e); else out.skipped++;
  }
  out.items.reverse();
  out.items = out.items.slice(0, MAX_HISTORY);
  return out;
}
function parseEntry(line) {
  let x;
  try { x = JSON.parse(line); } catch { return null; }
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const str = k => (typeof x[k] === "string" && SAFE.test(x[k]) ? x[k] : null);
  const at = Date.parse(x.at);
  if (!Number.isFinite(at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(x.at))) return null;
  if (!RESULTS.includes(x.result)) return null;
  const from = str("from"), to = str("to"), stage = str("stage");
  if (from === null || to === null || stage === null) return null;
  return {
    at, from: parseVersion(from) ? parseVersion(from).text : from, to: parseVersion(to) ? parseVersion(to).text : to, result: x.result, stage,
    changed: !NOTHING_CHANGED.includes(stage), source: str("source") || "", backup: /^tracker-[\w-]+\.db$/.test(str("backup") || "") ? x.backup : "",
    previous: parseVersion(str("previous") || "") ? parseVersion(x.previous).text : "", exitCode: Number.isInteger(x.exitCode) && x.exitCode >= 0 && x.exitCode < 256 ? x.exitCode : null
  };
}

// The installer keeps each release in <prefix>/releases/<version> and points <prefix>/current at one. The app runs from inside one of
// them, so its own folder tells where the others are. Outside that layout (a git checkout) there are none to list.
export function installedReleases(appRoot, currentVersion) {
  const dir = path.dirname(appRoot);
  if (path.basename(dir) !== "releases") return { layout: "checkout", items: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { layout: "installer", items: [] }; }
  const items = names.map(n => parseVersion(n) && n === parseVersion(n).text ? n : null).filter(Boolean)
    .filter(n => { try { return fs.statSync(path.join(dir, n, ".install-complete")).isFile(); } catch { return false; } })
    .sort((a, b) => compareVersions(b, a))
    .map(v => {
      // what the folder really holds: v0.7.0's update.sh named every 0.8.0 pre-release "0.8.0" (A29; repaired by the next update)
      let holds = null;
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, v, "manifest.json"), "utf8")); const h = parseVersion(String(m.version_name || m.version || "")); holds = h ? h.text : null; } catch { holds = null; }
      return { version: v, current: v === currentVersion || v === path.basename(appRoot), ...(holds && holds !== v ? { holds } : {}) };
    });
  return { layout: "installer", items };
}

// One published release from the GitHub API, or null. Only what the page needs, each field checked: a tag that is a real version, a
// link that points at this repository's releases page, a short plain-text name. Release notes are not taken (they are never rendered).
export function normalizeRelease(r, repoPage = RELEASE_PAGE) {
  if (!r || typeof r !== "object" || r.draft !== false) return null;
  const v = parseVersion(typeof r.tag_name === "string" ? r.tag_name : "");
  if (!v || !/^v?\d/.test(r.tag_name)) return null;
  const url = typeof r.html_url === "string" && r.html_url.startsWith(repoPage) && /^[\w./%-]+$/.test(r.html_url.slice(repoPage.length)) ? r.html_url : repoPage + "tag/" + encodeURIComponent(r.tag_name);
  const published = Date.parse(r.published_at);
  const name = typeof r.name === "string" ? r.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
  return { version: v.text, tag: r.tag_name, prerelease: r.prerelease === true, name, url, publishedAt: Number.isFinite(published) ? published : null };
}

// Asks the releases API for the published releases. No credentials of any kind: no token is read or sent, no cookie, a fixed URL.
// Bounded: 10 s timeout, 1 MB, no redirects to anywhere else. Returns { ok: true, releases } or { ok: false, error }.
export async function fetchReleases({ url = RELEASES_API, fetchImpl = globalThis.fetch, timeoutMs = 10000, userAgent = "watch-ledger-update-check", repoPage = RELEASE_PAGE } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "error", signal: ctl.signal, credentials: "omit",
      headers: { Accept: "application/vnd.github+json", "User-Agent": userAgent, "X-GitHub-Api-Version": "2022-11-28" } });
    if (res.status === 403 || res.status === 429) return { ok: false, error: "rate_limited" };
    if (res.status === 404) return { ok: false, error: "no_releases" };
    if (!res.ok) return { ok: false, error: "bad_status" };
    if (!/application\/(vnd\.github\+)?json/i.test(res.headers.get("content-type") || "")) return { ok: false, error: "bad_response" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return { ok: false, error: "too_large" };
    const text = await readLimited(res, MAX_RESPONSE_BYTES);
    if (text === null) return { ok: false, error: "too_large" };
    let data; try { data = JSON.parse(text); } catch { return { ok: false, error: "bad_response" }; }
    if (!Array.isArray(data)) return { ok: false, error: "bad_response" };
    const releases = data.slice(0, MAX_RELEASES).map(r => normalizeRelease(r, repoPage)).filter(Boolean);
    return { ok: true, releases };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "timeout" : "unreachable" };
  } finally { clearTimeout(timer); }
}
// Copyable, version-specific commands for the installer's standard layout. Built only from values that were validated as versions or
// backup file names, so nothing from the network or from the history file can end up in a shell command. Each command names a script
// and options that exist (server/test/updates.test.js checks them against scripts/*.sh). Scripts are run with `bash` so the commands also
// work where a release was unpacked without executable bits (every v0.7.0 install: BUG_FIX_REPORT A30).
export const LAYOUT = { prefix: "/opt/watch-ledger", var: "/var/lib/watch-ledger", service: "watch-ledger" };
const BACKUP_NAME = /^tracker-\d{8}T\d{6}(\d{3})?Z(-\d+)?\.db$/;
export function instructionsFor({ installed, target = null, previous = null, backup = null }) {
  const cur = parseVersion(installed || ""), tgt = parseVersion(target || ""), prev = parseVersion(previous || "");
  const inCurrent = `cd ${LAYOUT.prefix}/current`;
  const tag = tgt ? "v" + tgt.text : "vX.Y.Z";
  const update = [
    { text: "Open the installed release (the scripts live there).", cmd: inCurrent },
    { text: "Optional: ask the script which release is the newest stable one.", cmd: "sudo bash scripts/update.sh --check" },
    { text: "Preview what would happen, without changing anything.", cmd: `sudo bash scripts/update.sh --version ${tag} --dry-run` },
    { text: `Update${tgt ? " to " + tgt.text : ""}. The script verifies the download checksum, backs up the database into backups/pre-update, installs beside the current release, migrates, switches and checks health; if the health check fails it switches the code back by itself.`, cmd: `sudo bash scripts/update.sh --version ${tag}` },
    { text: "Check the result.", cmd: "sudo bash scripts/health-check.sh" }
  ];
  const prevDir = prev ? `${LAYOUT.prefix}/releases/${prev.text}` : `${LAYOUT.prefix}/releases/<previous version>`;
  const rollbackCode = [
    { text: "List the releases that are still installed.", cmd: `ls ${LAYOUT.prefix}/releases` },
    { text: `Point the server back at ${prev ? prev.text : "the previous release"}.`, cmd: `sudo ln -sfn ${prevDir} ${LAYOUT.prefix}/current` },
    { text: "Restart the service.", cmd: `sudo systemctl restart ${LAYOUT.service}` },
    { text: "Check it is healthy.", cmd: `${inCurrent} && sudo bash scripts/health-check.sh` }
  ];
  const file = backup && BACKUP_NAME.test(backup) ? backup : "<pre-update backup>";
  const rollbackData = [
    { text: "Only if the data must return to exactly how it was before the update (this discards everything recorded since). Roll the code back first, then:", cmd: `${inCurrent} && sudo bash scripts/restore.sh ${LAYOUT.var}/backups/pre-update/${file}` }
  ];
  return { installed: cur ? cur.text : null, target: tgt ? tgt.text : null, previous: prev ? prev.text : null, backup: file === "<pre-update backup>" ? null : file, update, rollbackCode, rollbackData };
}

async function readLimited(res, max) {
  if (!res.body || !res.body.getReader) { const t = await res.text(); return Buffer.byteLength(t) > max ? null : t; }
  const reader = res.body.getReader(), chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* closed */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
