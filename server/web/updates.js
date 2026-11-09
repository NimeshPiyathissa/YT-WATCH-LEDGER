/* updates.js: the Update Manager page (#/updates) of Watch Ledger (window.WLUpdates).
   Shows the installed version and its release channel, the update history written by scripts/update.sh, the pre-update backups (with
   Verify), the releases still installed, and copyable commands to update or roll back. The dashboard never runs an update or a rollback:
   those commands are run on the server. The release check is off unless switched on in Settings, and runs only when asked.
   Every value shown goes through esc(). No inline styles or scripts. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  let seq = 0;
  const RESULT = { success: ["on", "Updated"], rolled_back: ["warn", "Rolled back"], failed: ["bad", "Failed"], cancelled: ["", "Cancelled"] };
  const CHANNEL = { stable: "on", rc: "info", beta: "warn", alpha: "warn", prerelease: "warn", unknown: "bad" };
  const CHECK_ERR = { rate_limited: "GitHub is limiting requests from this server for now. Try again in an hour.", no_releases: "No release has been published yet.",
    timeout: "GitHub did not answer within 10 seconds.", unreachable: "GitHub could not be reached from this server (no internet, DNS or firewall).",
    bad_status: "GitHub answered with an error.", bad_response: "GitHub's answer was not a release list.", too_large: "GitHub's answer was larger than expected and was not read." };
  const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span><span>${esc(text)}</span></span>`;
  const bytes = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const uptime = s => window.WLHealth.uptime(s);
  const safeLink = u => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(u || "") ? u : "");

  const step = (s, i, key) => `<li class="um-step"><p>${esc(s.text)}</p><div class="um-cmd"><code id="${key}${i}">${esc(s.cmd)}</code><button class="btn btn-sm btn-ghost" type="button" data-copy="${key}${i}" aria-label="Copy: ${esc(s.cmd)}">${ic("copy")}Copy</button></div></li>`;
  const steps = (list, key) => `<ol class="um-steps">${list.map((s, i) => step(s, i, key)).join("")}</ol>`;

  function statusCard(d) {
    const v = d.installed;
    const warn = !v.consistent ? `<div class="alert warn" role="status">${ic("triangle-alert")}<span>The server reports ${esc(v.version)} but the release files say ${esc(v.manifestVersion)}. Run <span class="mono">sudo ./scripts/health-check.sh</span>; reinstall the release if they still differ.</span></div>` : "";
    return `<section class="card um-status" aria-labelledby="umVerH">
      <div class="um-status-main"><p class="eyebrow">Installed version</p><h2 id="umVerH" class="um-version">${esc(v.version)}</h2>
        <div class="row">${pill(CHANNEL[v.channel] || "", v.channelLabel + " channel")}${v.installedAt ? `<span class="caption">installed ${esc(U.fmtDateTime(v.installedAt))}</span>` : ""}</div></div>
      <dl class="um-facts">
        <div><dt>Node.js</dt><dd class="mono">${esc(v.node)}</dd></div>
        <div><dt>Running for</dt><dd>${esc(uptime(v.uptimeSec))}</dd><dd class="caption">since ${esc(U.fmtDateTime(v.startedAt))}</dd></div>
        <div><dt>Installation</dt><dd>${v.layout === "installer" ? "Installer layout" : "Development checkout"}</dd>${v.layout === "installer" ? "" : `<dd class="caption">history and installed releases appear on a server set up with install.sh</dd>`}</div>
      </dl>${warn}</section>`;
  }

  function checkCard(d) {
    const c = d.check, last = c.last;
    if (!c.enabled) {
      return `<section class="card um-check" aria-labelledby="umChkH"><div class="card-head"><h3 id="umChkH">${ic("refresh-cw")}New releases</h3>${pill("", "Check is off")}</div>
        <p class="muted">Checking is switched off, so this server never contacts GitHub. Switch on <b>Check GitHub for new releases</b> in Settings to be able to look for new releases from here. Nothing is ever installed from the dashboard.</p>
        <div class="row"><a class="btn" href="#/settings">${ic("settings")}Open Settings</a><button class="btn btn-accent" type="button" id="umCheck" disabled aria-disabled="true">${ic("refresh-cw")}Check now</button></div></section>`;
    }
    let result = `<p class="muted" id="umResult">Not checked yet.</p>`;
    if (last) {
      const when = `<span class="caption">Checked ${esc(U.fmtDateTime(last.at))}${last.stale ? " (with different settings; check again)" : ""}</span>`;
      if (!last.ok) result = `<div class="alert bad" id="umResult" role="status">${ic("triangle-alert")}<span><b>The check did not work.</b> ${esc(CHECK_ERR[last.error] || "Unknown problem.")}<br>${when}</span></div>`;
      else if (!last.recommended) result = `<div class="alert ok" id="umResult" role="status">${ic("circle-check")}<span><b>You are up to date.</b> No newer ${c.includePrereleases && c.prereleaseApplies ? "stable release or pre-release" : "stable release"} than ${esc(d.installed.version)}.<br>${when}</span></div>`;
      else {
        const r = last.recommended, link = safeLink(r.url);
        const other = last.latestStable && last.latestPrerelease && last.latestStable.version !== r.version ? `<br>Newest stable release: ${esc(last.latestStable.version)}.` : "";
        result = `<div class="alert info" id="umResult" role="status">${ic("download")}<span><b>${esc(r.version)} is available</b>${r.prerelease ? " (pre-release)" : ""}${r.name && r.name !== r.tag ? `: ${esc(r.name)}` : ""}.${r.publishedAt ? ` Published ${esc(U.fmtDate(r.publishedAt))}.` : ""}${other}
          ${link ? `<br><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${ic("external-link")}Read the release notes on GitHub</a>` : ""}<br>The commands below are filled in for ${esc(r.version)}.<br>${when}</span></div>`;
      }
    }
    const pre = c.prereleaseApplies ? (c.includePrereleases ? "Stable releases and newer pre-releases of this release line are offered." : "Only stable releases are offered. This server runs a pre-release: newer pre-releases can be included in Settings.") : "Only stable releases are offered.";
    return `<section class="card um-check" aria-labelledby="umChkH"><div class="card-head"><h3 id="umChkH">${ic("refresh-cw")}New releases</h3>${pill("on", "Check is on")}</div>
      <p class="muted">Asks GitHub's public release list, only when you press the button. No account, token or data of yours is sent. ${esc(pre)} A downgrade is never offered.</p>
      <div id="umResultBox">${result}</div>
      <div class="row"><button class="btn btn-accent" type="button" id="umCheck">${ic("refresh-cw")}Check now</button></div></section>`;
  }

  function historyCard(d) {
    const h = d.history;
    const body = h.items.length ? `<ol class="um-timeline">${h.items.map(e => {
      const [cls, label] = RESULT[e.result] || ["", e.result];
      return `<li class="um-event ${esc(e.result)}"><div class="um-event-head">${pill(cls, label)}<b class="mono">${esc(e.from || "?")} → ${esc(e.to || "?")}</b><time class="caption">${esc(U.fmtDateTime(e.at))}</time></div>
        <p class="caption">${e.result === "success" ? "Backed up, installed, migrated and healthy." : e.result === "rolled_back" ? `Stopped while ${esc(e.stage)}; the previous release${e.previous ? " (" + esc(e.previous) + ")" : ""} was switched back and is running.` : e.result === "cancelled" ? "Not confirmed; nothing was changed." : !e.changed ? `Stopped while ${esc(e.stage)}, before anything was changed.` : `Stopped while ${esc(e.stage)}. Check the service, and see Roll back below.`}
        ${e.backup ? ` Pre-update backup: <span class="mono">${esc(e.backup)}</span>.` : ""}${e.source ? ` Source: ${esc(e.source)}.` : ""}</p></li>`;
    }).join("")}</ol>` : WL.empty("history", "No update recorded yet", h.available ? "The history file exists but holds no update yet." : "Updates run with scripts/update.sh from v0.8.0 on are listed here, with their result and pre-update backup.");
    return `<section class="card" aria-labelledby="umHistH"><div class="card-head"><h3 id="umHistH">${ic("history")}Update history</h3><span class="sub">${h.items.length ? h.items.length + " recorded" : ""}</span></div>${body}
      ${h.skipped ? `<p class="caption">${h.skipped} unreadable line${h.skipped === 1 ? " was" : "s were"} skipped.</p>` : ""}</section>`;
  }

  function backupsCard(d) {
    const b = d.backups.items;
    return `<section class="card flush" aria-labelledby="umBkH"><div class="card-head"><h3 id="umBkH">${ic("hard-drive")}Pre-update backups</h3><span class="sub">taken by update.sh before every update · never deleted automatically</span></div>
      ${b.length ? `<div class="table-wrap"><table class="table rtable um-backups"><thead><tr><th>Backup</th><th>Taken</th><th class="right">Size</th><th>Check</th></tr></thead><tbody>${b.map(x => `<tr>
        <td data-primary class="cell-primary mono">${esc(x.name)}</td><td data-label="Taken">${esc(U.fmtDateTime(x.createdAt))}</td><td class="num right" data-label="Size">${esc(bytes(x.size))}</td>
        <td data-label="Check"><button class="btn btn-sm" type="button" data-verify="${esc(x.name)}">${ic("shield-check")}Verify</button><div class="um-verify caption" data-vres="${esc(x.name)}" role="status"></div></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="um-pad">${WL.empty("hard-drive", "No pre-update backup", "update.sh writes one into backups/pre-update before it changes anything. None has been taken on this server yet.")}</div>`}</section>`;
  }

  function instructionsCard(d) {
    const i = d.instructions;
    return `<section class="card" aria-labelledby="umUpdH"><div class="card-head"><h3 id="umUpdH">${ic("terminal")}How to update</h3><span class="sub">${i.target ? "filled in for " + esc(i.target) : "replace vX.Y.Z with the release you want"}</span></div>
        <p class="muted">Run these on the server over SSH. The dashboard never installs anything.</p>${steps(i.update, "umU")}</section>
      <section class="card" aria-labelledby="umRbH"><div class="card-head"><h3 id="umRbH">${ic("history")}How to roll back</h3></div>
        ${d.releases.length ? `<p class="muted">Installed releases (update.sh keeps the last three):</p><ul class="um-releases">${d.releases.map(r => `<li><span class="mono">${esc(r.version)}</span>${r.current ? pill("on", "running") : ""}</li>`).join("")}</ul>` : `<p class="muted">The releases kept for rollback are listed here on a server set up with install.sh.</p>`}
        <h4>Code only (the usual case)</h4><p class="muted">If the update failed its health check, update.sh already did this. Migrations only ever add to the database, so the previous release normally runs on it.</p>${steps(i.rollbackCode, "umR")}
        <h4>Database too (only if the data must go back)</h4>${steps(i.rollbackData, "umD")}
        <p class="caption">Paths are the installer's standard locations. Full guide: docs/UPDATES.md.</p></section>`;
  }

  async function copy(text) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
    const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.className = "um-offscreen"; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; } t.remove(); return ok;
  }

  function wire(d, load) {
    const root = $("umBody");
    root.onclick = WL.guarded(async e => {
      const c = e.target.closest("[data-copy]");
      if (c) { const code = $(c.dataset.copy); const ok = await copy(code.textContent); WL.toast(ok ? "Copied to the clipboard." : "Select the command and copy it by hand."); if (ok) { c.classList.add("done"); setTimeout(() => c.classList.remove("done"), 1500); } return; }
      const v = e.target.closest("[data-verify]");
      if (v) {
        const out = root.querySelector(`[data-vres="${CSS.escape(v.dataset.verify)}"]`); v.disabled = true; out.textContent = "Checking…";
        try {
          const r = await WL.api("POST", "/api/updates/backups/" + encodeURIComponent(v.dataset.verify) + "/verify");
          out.innerHTML = r.restorable ? `${ic("circle-check")}Restorable: intact, ${esc(r.schema.state === "same" ? "same release" : r.schema.state + " release")}, readable with this server's key.` : `${ic("triangle-alert")}Not restorable: ${esc((r.problems || []).join("; ") || "see the Backup Manager")}`;
          out.className = "um-verify caption " + (r.restorable ? "ok" : "bad");
        } catch (err) { out.textContent = WL.errText(err); out.className = "um-verify caption bad"; }
        v.disabled = false; return;
      }
      if (e.target.closest("#umCheck")) {
        const b = $("umCheck"); if (b.disabled) return; b.disabled = true; b.setAttribute("aria-busy", "true"); const old = b.innerHTML; b.innerHTML = `${ic("refresh-cw")}Checking…`;
        try { await WL.api("POST", "/api/updates/check"); await load(); }
        catch (err) { if (err.message !== "unauthorized") { WL.toast(err.message === "check_disabled" ? "The check is switched off in Settings." : WL.errText(err)); b.disabled = false; b.removeAttribute("aria-busy"); b.innerHTML = old; } }
      }
    });
  }

  async function render(app) {
    const mine = ++seq;
    app.innerHTML = WL.head("Updates", "Which version this server runs, how its updates went, and exactly how to update or roll back. Updates and rollbacks are run on the server with scripts/update.sh; this page never changes the installation.") +
      `<div id="umBody" aria-live="polite" aria-busy="true"><div class="stack" role="status" aria-label="Loading"><span class="skel h-card"></span><div class="grid g2"><span class="skel h-block"></span><span class="skel h-block"></span></div></div></div>`;
    const load = async () => {
      const box = $("umBody"); if (!box) return;
      try {
        const d = await WL.api("GET", "/api/updates");
        if (mine !== seq || !document.body.contains(box)) return;
        box.removeAttribute("aria-busy");
        box.innerHTML = `<div class="stack">${statusCard(d)}<div class="grid g2 um-top">${checkCard(d)}${historyCard(d)}</div>${backupsCard(d)}<div class="grid g2 um-howto">${instructionsCard(d)}</div></div>`;
        wire(d, load);
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        box.removeAttribute("aria-busy");
        box.innerHTML = `<section class="card">${WL.empty("triangle-alert", "Updates could not load", WL.errText(e), `<button class="btn btn-accent" type="button" id="umRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
        $("umRetry").onclick = () => load();
      }
    };
    await load();
  }

  window.WLUpdates = { render };
})();
