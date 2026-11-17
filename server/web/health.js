/* health.js: the Health Center page (#/health) of Watch Ledger. Reads GET /api/system/health (owner only). Everything shown is a
   size, a count or a time; nothing from a device is rendered except through esc(). No inline styles or scripts. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const REFRESH_MS = 15000;
  let timer = null, seq = 0;

  const bytes = n => { n = Number(n) || 0; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n >= 100 ? 0 : 1) : n) + " " + u[i]; };
  const uptime = s => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m " + (s % 60) + "s"; };
  const ago = ts => { if (!ts) return "never"; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
  const FIX = {
    database: "Restart the service (sudo systemctl restart watch-ledger) and read its log (journalctl -u watch-ledger -n 80). If it persists, restore the newest backup.",
    disk_full: "Free space now: remove old files or enlarge the disk. A full disk stops backups and can corrupt writes.",
    disk_low: "Plan to free or add disk space. Copy old backups elsewhere before removing anything.",
    memory_low: "Check what else runs on this machine (free -m). A 1 GB server is enough for Watch Ledger alone.",
    backup_none: "Open Data & backups and press Back up now, then copy a backup off the server.",
    backup_stale: "Look for BACKUP FAILED in journalctl -u watch-ledger, and check that the disk is not full.",
    queue_overflow: "Open Devices, choose the device, and read its diagnostics. Reconnecting it clears the queue; the events are still on that device.",
    sync_errors: "Open Devices and look at the device marked with an error; the extension's Device info page shows the same message."
  };
  // A ring that fills to pct (0 to 100); the warn / bad colour comes from thresholds on what is USED.
  function ring(pct, cls) {
    const r = 36, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, pct)) / 100 * c;
    return `<svg class="ring ${cls}" viewBox="0 0 100 100" role="img" aria-label="${Math.round(pct)} percent"><circle class="track" cx="50" cy="50" r="${r}"/><circle class="val" cx="50" cy="50" r="${r}" stroke-dasharray="${f.toFixed(1)} ${c.toFixed(1)}"/></svg>`;
  }
  const lvl = (p, w, b) => (p >= b ? "bad" : p >= w ? "warn" : "");
  const tile = (k, v, s, vis) => `<div class="tile">${vis || ""}<div class="meta"><span class="k">${esc(k)}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ""}</div></div>`;

  function view(h) {
    const memUsed = h.memory.totalBytes ? (1 - h.memory.freeBytes / h.memory.totalBytes) * 100 : 0;
    const diskUsed = h.disk ? (1 - h.disk.freeBytes / h.disk.totalBytes) * 100 : null;
    const cpu = h.cpu.percent;
    const title = { ok: "Everything looks healthy", warn: "Needs attention", critical: "Action needed now" }[h.status] || "Status unknown";
    const lede = h.status === "ok" ? "All checks passed " + ago(h.checkedAt) + "." : h.warnings.length + " issue" + (h.warnings.length === 1 ? "" : "s") + " found. Details below.";
    return `
      <section class="hc-banner ${esc(h.status)}" aria-label="Overall status"><span class="ico">${ic(h.status === "ok" ? "circle-check" : "triangle-alert")}</span><div><h2>${esc(title)}</h2><p>${esc(lede)}</p></div></section>
      ${h.warnings.length ? `<section class="stack-sm" aria-label="Issues">${h.warnings.map(w => `<div class="hc-warn ${esc(w.level)}"><span class="ic">${ic("triangle-alert")}</span><div><b>${esc(w.message)}</b><span class="fix">${esc(FIX[w.code] || "")}</span></div></div>`).join("")}</section>` : ""}
      <section class="tiles" aria-label="Resources">
        ${tile("CPU", cpu === null ? "n/a" : cpu + "%", h.cpu.cores + " core" + (h.cpu.cores === 1 ? "" : "s") + (h.cpu.load ? " · load " + h.cpu.load.join(" / ") : ""), cpu === null ? "" : ring(cpu, lvl(cpu, 80, 95)))}
        ${tile("Memory", Math.round(memUsed) + "% used", bytes(h.memory.totalBytes - h.memory.freeBytes) + " of " + bytes(h.memory.totalBytes) + " · this app " + bytes(h.memory.processRssBytes), ring(memUsed, lvl(memUsed, 85, 95)))}
        ${tile("Disk", diskUsed === null ? "n/a" : Math.round(diskUsed) + "% used", h.disk ? bytes(h.disk.freeBytes) + " free of " + bytes(h.disk.totalBytes) : "could not be read", diskUsed === null ? "" : ring(diskUsed, lvl(diskUsed, 90, 95)))}
        ${tile("Database", h.database.ok ? "Connected" : "Not responding", h.database.ok ? bytes(h.database.sizeBytes) + " · answered in " + h.database.latencyMs + " ms" : "the query failed")}
      </section>
      <section class="tiles" aria-label="Application">
        ${tile("Uptime", esc(uptime(h.uptimeSec)), "since " + esc(U.fmtDateTime(h.startedAt)))}
        ${tile("Version", esc(h.version), "Node.js " + esc(h.node))}
        ${tile("Devices", h.devices.online + " online", h.devices.active + " active · " + h.devices.pending + " pending · " + h.devices.revoked + " revoked")}
        ${tile("Sync", h.sync.devicesWithErrors ? h.sync.devicesWithErrors + " with errors" : "No errors", h.sync.pendingUploads + " upload" + (h.sync.pendingUploads === 1 ? "" : "s") + " waiting · last upload " + esc(ago(h.sync.lastPushAt)))}
        ${tile("Backups", h.backups.count ? esc(ago(h.backups.lastBackupAt)) : "None yet", h.backups.count + " kept" + (h.backups.status === "stale" ? " · overdue" : ""))}
        ${tile("Live connections", String(h.realtime ? h.realtime.deviceSockets : 0), (h.realtime ? h.realtime.adminListeners : 0) + " dashboard listener" + (h.realtime && h.realtime.adminListeners === 1 ? "" : "s"))}
      </section>
      <p class="caption"><span class="live-dot" aria-hidden="true"></span>Refreshes every ${REFRESH_MS / 1000} seconds while this page is open. Last check ${esc(U.fmtTime(h.checkedAt))} (SLST).</p>`;
  }

  function dispose() { clearTimeout(timer); timer = null; seq++; }

  async function render(app) {
    dispose();
    const mine = seq;
    app.innerHTML = WL.head("Health Center", "How this server is doing right now. Only you can see this page.", `<button class="btn" type="button" id="hcNow">${ic("refresh-cw")}Check now</button>`) +
      `<div id="hcBody" class="stack" aria-live="polite"><div class="tiles"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div></div>`;
    const load = async first => {
      const box = $("hcBody");
      if (!box || mine !== seq) return;
      try {
        const h = await WL.api("GET", "/api/system/health");
        if (mine !== seq || !document.body.contains(box)) return;
        box.innerHTML = view(h);
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        if (first) box.innerHTML = `<section class="card">${WL.empty("server", "Health could not load", WL.errText(e), "", "bad")}</section>`;
      }
      if (mine === seq) timer = setTimeout(() => load(false), REFRESH_MS);
    };
    $("hcNow").onclick = () => { clearTimeout(timer); load(false); };
    await load(true);
  }

  window.WLHealth = { render, dispose, view, bytes, uptime };
})();
