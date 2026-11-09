import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "../lib/helpers.js";
import { readSettings } from "../lib/settings.js";
import { listBackups, inspectBackup, isBackupName } from "../lib/backup.js";
import { readVersion } from "../lib/health.js";
import { parseVersion, channelOf, CHANNEL_LABEL, selectUpdates } from "../lib/version.js";
import { defaultHistoryFile, readHistory, installedReleases, fetchReleases, instructionsFor, RELEASES_API } from "../lib/updates.js";

// Update Manager. Owner-only and read-only: it shows the installed version, the update history written by scripts/update.sh, the
// pre-update backups and the releases still installed, and the commands to update or roll back. It never runs them: no route here
// starts a process or changes a file outside the settings table (server/test/updates.test.js checks the source for that).
// The release check is off unless the owner switches it on in Settings, runs only when asked, and sends no credentials.
const SERVER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_KEY = "update.last_check", CACHE_MS = 10 * 60 * 1000;

export default async function (app, { db, config }) {
  app.addHook("preHandler", app.authAdmin);
  const serverRoot = config.serverRoot || SERVER_ROOT, appRoot = path.dirname(path.resolve(serverRoot));
  const version = config.appVersion || readVersion(serverRoot);
  const historyFile = () => (config.updateHistoryFile !== undefined ? config.updateHistoryFile : defaultHistoryFile(config.dbPath));
  const preUpdateDir = () => config.preUpdateDir || path.join(config.backupDir, "pre-update");
  const manifestVersion = (() => { try { const m = JSON.parse(fs.readFileSync(path.join(appRoot, "manifest.json"), "utf8")); return m.version_name || m.version || null; } catch { return null; } })();
  const lastCheck = () => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(CHECK_KEY); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const flags = () => { const v = readSettings(db).values; return { enabled: v.update_check_enabled === true, includePrereleases: v.update_include_prereleases === true }; };

  app.get("/api/updates", () => {
    const parsed = parseVersion(version), channel = channelOf(version), f = flags();
    const history = readHistory(historyFile());
    let backups = [];
    try { backups = fs.existsSync(preUpdateDir()) ? listBackups(preUpdateDir()) : []; } catch { backups = []; }
    const releases = installedReleases(appRoot, parsed ? parsed.text : version);
    const last = lastCheck();
    const previous = releases.items.find(r => !r.current) || null;
    const lastSuccess = history.items.find(h => h.result === "success" && parsed && h.to === parsed.text);
    return {
      installed: { version: parsed ? parsed.text : version, valid: !!parsed, channel, channelLabel: CHANNEL_LABEL[channel], manifestVersion, consistent: !manifestVersion || manifestVersion === version,
        node: process.version, uptimeSec: Math.round(process.uptime()), startedAt: Date.now() - Math.round(process.uptime() * 1000), layout: releases.layout, installedAt: lastSuccess ? lastSuccess.at : null },
      history,
      backups: { items: backups.map(b => ({ name: b.name, size: b.size, createdAt: b.createdAt })) },
      releases: releases.items,
      check: { ...f, prereleaseApplies: channel !== "stable", last: last ? { ...last, stale: last.includePrereleases !== f.includePrereleases || last.installed !== version } : null },
      instructions: instructionsFor({ installed: version, target: last && last.ok && last.installed === version && last.recommended ? last.recommended.version : null, previous: previous ? previous.version : null, backup: backups[0] ? backups[0].name : null })
    };
  });

  app.post("/api/updates/check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const f = flags();
    if (!f.enabled) return reply.code(409).send({ error: "check_disabled" });
    const prev = lastCheck(), now = Date.now();
    if (prev && prev.ok && prev.includePrereleases === f.includePrereleases && prev.installed === version && now - prev.at < CACHE_MS) return { ...prev, cached: true };
    const r = await fetchReleases({ url: config.updateCheckUrl || RELEASES_API, fetchImpl: config.fetch || globalThis.fetch, ...(config.updateRepoPage ? { repoPage: config.updateRepoPage } : {}), timeoutMs: config.updateCheckTimeoutMs || 10000 });
    const result = { at: now, installed: version, includePrereleases: f.includePrereleases, ok: r.ok, error: r.ok ? null : r.error, releasesSeen: r.ok ? r.releases.length : 0, latestStable: null, latestPrerelease: null, recommended: null };
    if (r.ok) Object.assign(result, selectUpdates(version, r.releases, { includePrereleases: f.includePrereleases }));
    db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(CHECK_KEY, JSON.stringify(result));
    audit(db, req.admin.id, null, "update_check", req.ip, { ok: result.ok, error: result.error, recommended: result.recommended ? result.recommended.version : null });
    return { ...result, cached: false };
  });

  app.post("/api/updates/backups/:name/verify", (req, reply) => {
    const name = req.params.name;
    if (!isBackupName(name)) return reply.code(400).send({ error: "bad_name" }); // also rules out any path separator
    const file = path.join(preUpdateDir(), name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not_found" });
    const info = inspectBackup(file);
    audit(db, req.admin.id, null, "backup_verified", req.ip, { name, folder: "pre-update", restorable: info.restorable, schema: info.schema.state, keyOk: info.keyOk });
    return info;
  });
}
