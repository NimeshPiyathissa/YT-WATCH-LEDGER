/* device-center.js: the Device Control Center panel on a device's page (#/device/<id>): Diagnostics, Activity and Permissions.
   Everything that originates from a device (labels, errors, versions) is untrusted and goes through esc(). No inline styles or scripts.
   The consent states shown under Permissions are REPORTED BY THE DEVICE: this page has no control that changes them, on purpose. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  const REFRESH_MS = 15000;
  const TABS = [["diag", "Diagnostics"], ["activity", "Activity"], ["perm", "Permissions"]];
  const LEVEL = { ok: ["circle-check", "on", "Good"], info: ["info", "info", "Note"], warn: ["triangle-alert", "warn", "Check"], bad: ["circle-alert", "bad", "Problem"] };
  const GROUP_ICON = { consent: "eye", security: "shield-check", pairing: "link", settings: "sliders-horizontal", command: "terminal", error: "triangle-alert", other: "info" };
  let st = null, timer = null;

  const ago = ts => { if (!ts) return "never"; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
  const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span><span>${esc(text)}</span></span>`;
  const alive = s => st === s && document.body.contains($("dcBody"));
  function dispose() { clearTimeout(timer); timer = null; st = null; }

  /* ---------- diagnostics ---------- */
  function diagView(d) {
    const top = { ok: ["circle-check", "ok", "All checks passed"], warn: ["triangle-alert", "warn", "Something needs a look"], bad: ["circle-alert", "critical", "This device is not working"] }[d.level] || ["info", "ok", "Checked"];
    const live = d.consents.liveView ? `<span class="live-chip" title="The person at the device allowed it">${ic("eye")}Live viewing ON</span>` : "";
    return `<div class="hc-banner ${top[1]} dc-top"><span class="ico">${ic(top[0])}</span><div><h2>${esc(top[2])}</h2><p>Checked ${esc(ago(d.checkedAt))} · connection ${esc(d.connection)}${d.realtime ? " (live channel open)" : ""} ${live}</p></div></div>
      <ul class="dc-checks">${d.checks.map(c => { const L = LEVEL[c.level] || LEVEL.info; return `<li class="dc-check ${esc(c.level)}"><span class="ic">${ic(L[0])}</span><div><b>${esc(c.title)}</b><span class="d">${esc(c.detail)}</span>${c.fix ? `<span class="fix">${ic("arrow-left")}${esc(c.fix)}</span>` : ""}</div>${pill(L[1], L[2])}</li>`; }).join("")}</ul>
      ${d.errors.length ? `<h4 class="dc-h">Recent errors reported by the device</h4><div class="table-wrap"><table class="table rtable"><thead><tr><th>When</th><th>Kind</th><th>Message</th></tr></thead><tbody>${d.errors.map(e => `<tr><td data-label="When" title="${esc(U.fmtDateTime(e.at))}">${esc(ago(e.at))}</td><td data-label="Kind"><span class="mono">${esc(e.kind)}</span></td><td data-primary class="cell-primary">${esc(e.message)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <dl class="kv dc-facts"><dt>Extension</dt><dd class="num">${d.clientVersion ? "v" + esc(d.clientVersion) : "unknown"} <span class="muted small">(server v${esc(d.serverVersion)})</span></dd>
        <dt>Last upload</dt><dd>${esc(ago(d.lastPushAt))}</dd><dt>Last playback events</dt><dd>${esc(ago(d.lastEventsAt))}</dd>
        <dt>Waiting on the device</dt><dd class="num">${d.queue.sessions} session update(s) · ${d.queue.events} event(s)${d.queue.dropped ? ` · <span class="warn-t">${d.queue.dropped} kept on the device only (queue limit)</span>` : ""}</dd></dl>`;
  }
  async function loadDiag(s) {
    const d = await WL.api("GET", `/api/devices/${encodeURIComponent(s.id)}/diagnostics`);
    if (!alive(s)) return;
    s.diag = d; $("dcBody").innerHTML = diagView(d);
  }

  /* ---------- activity ---------- */
  function actItem(i) {
    const det = i.detail && i.detail.message ? i.detail.message : i.detail && i.detail.changes ? Object.entries(i.detail.changes).map(([k, v]) => k.replace(/_/g, " ") + ": " + (v && typeof v === "object" ? (v.from === null ? "not set" : v.from) + " → " + (v.to === null ? "not set" : v.to) : v)).join(", ") + (i.detail.by ? " (by " + i.detail.by + ")" : "") : i.detail ? Object.entries(i.detail).map(([k, v]) => k + ": " + v).join(", ") : "";
    return `<li class="dc-act g-${esc(i.group)}"><span class="ic">${ic(GROUP_ICON[i.group] || "info")}</span><div><b>${esc(i.title)}</b>${det ? `<span class="d">${esc(det)}</span>` : ""}</div><time datetime="${new Date(i.at).toISOString()}" title="${esc(U.fmtDateTime(i.at))}">${esc(ago(i.at))}</time></li>`;
  }
  async function loadActivity(s, more) {
    const q = more && s.act && s.act.next ? "&before=" + s.act.next : "";
    const r = await WL.api("GET", `/api/devices/${encodeURIComponent(s.id)}/activity?limit=30${q}`);
    if (!alive(s)) return;
    s.act = { items: (more && s.act ? s.act.items : []).concat(r.items), next: r.next };
    const seen = new Set(), items = s.act.items.filter(i => { const k = i.at + "|" + i.action + "|" + i.title; if (seen.has(k)) return false; seen.add(k); return true; });
    $("dcBody").innerHTML = items.length ? `<p class="muted small">Newest first. Times are Sri Lanka time (SLST). Includes what you did, what the device reported, and problems it hit.</p><ol class="dc-acts">${items.map(actItem).join("")}</ol>${s.act.next ? `<div class="row"><button class="btn" id="dcMore" type="button">Show older</button></div>` : ""}`
      : WL.empty("history", "No activity recorded yet", "Pairing, approvals, settings changes and sync problems for this device appear here.");
    if ($("dcMore")) $("dcMore").onclick = WL.guarded(() => loadActivity(s, true));
  }

  /* ---------- permissions (consent is the device's; the owner's controls are listed separately) ---------- */
  const tri = v => (v === null || v === undefined ? ["", "Not reported"] : v ? ["on", "On"] : ["warn", "Off"]);
  function permView(s) {
    const d = s.diag, c = d ? d.consents : { liveView: !!s.dev.live_view, tracking: s.dev.consent_tracking === null ? null : !!s.dev.consent_tracking, detail: s.dev.consent_detail === null ? null : !!s.dev.consent_detail };
    const live = c.liveView ? ["info", "On" + (c.liveViewSince ? " since " + U.fmtDateTime(c.liveViewSince) : "")] : ["", "Off"];
    const track = tri(c.tracking), det = tri(c.detail);
    const active = s.dev.status === "active";
    const rowOf = (name, who, [cls, txt], what) => `<tr><td data-primary class="cell-primary">${esc(name)}</td><td data-label="Controlled by">${esc(who)}</td><td data-label="Now">${pill(cls, txt)}</td><td data-label="What it means" class="cell-sub-block">${esc(what)}</td></tr>`;
    return `<div class="alert info dc-note">${ic("lock")}<span><b>You cannot switch a device's privacy settings.</b> Live viewing, tracking and the detail level are decided by the person at the device and reported here. You only ever see them; every change they make is written to the activity list.</span></div>
      <div class="table-wrap"><table class="table rtable"><thead><tr><th>Permission</th><th>Controlled by</th><th>Now</th><th>What it means</th></tr></thead><tbody>
        ${rowOf("Live viewing", "The person at the device", live, "Lets you see which video is playing right now, and makes updates arrive within seconds. Off: you see history after each sync (every few minutes). The extension shows a LIVE badge while it is on.")}
        ${rowOf("Tracking", "The person at the device", track, "Whether watch time is recorded at all. You can ask to pause or resume from Controls; the device shows that it happened.")}
        ${rowOf("Collect watch detail", "The person at the device", det, "Whether every pause, resume and seek is recorded, or only the viewing summary.")}
        ${rowOf("Keep history for / Sync every", "You", active ? ["on", "Available"] : ["", "Needs an approved device"], "Bounded settings you can change below under Configuration; the device validates and confirms each change.")}
        ${rowOf("Remote commands", "You", active ? ["on", "Available"] : ["", "Needs an approved device"], "Pause or resume tracking, delete history on the device. Each one is visible on the device. (Known limitation: resume can override a pause the person chose; see Known issues.)")}
        ${rowOf("Ending the pairing", "The person asks, you decide", ["info", "Request → approval"], "The device can only request deletion of its session; it stays connected until you approve.")}
      </tbody></table></div>`;
  }

  /* ---------- the panel ---------- */
  async function show(s, tab) {
    s.tab = tab;
    document.querySelectorAll("#dcTabs [data-tab]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === tab)));
    $("dcBody").innerHTML = `<div class="stack"><span class="skel h-card"></span><span class="skel h-card"></span></div>`;
    try {
      if (tab === "diag") await loadDiag(s); else if (tab === "activity") await loadActivity(s, false);
      else { try { if (!s.diag) await loadDiag(s); } catch (_e) { /* the table still renders from the device list */ } if (alive(s)) $("dcBody").innerHTML = permView(s); }
    } catch (e) {
      if (e.message === "unauthorized" || e.message === "navigated" || !alive(s)) return;
      $("dcBody").innerHTML = WL.empty("triangle-alert", "Could not load", WL.errText(e), `<button class="btn btn-accent" id="dcRetry" type="button">Try again</button>`, "bad");
      if ($("dcRetry")) $("dcRetry").onclick = () => show(s, tab);
    }
    schedule(s);
  }
  // While the Diagnostics tab is open the checks are re-run every 15 seconds; any other tab, or leaving the page, stops it.
  function schedule(s) {
    clearTimeout(timer);
    if (s.tab !== "diag") return;
    timer = setTimeout(async () => { if (!alive(s) || s.tab !== "diag") return; try { await loadDiag(s); } catch (_e) { /* the next round retries */ } schedule(s); }, REFRESH_MS);
  }

  function mount(el, dev) {
    dispose();
    const s = st = { id: dev.id, dev, tab: "diag", diag: null, act: null };
    el.innerHTML = `<section class="card stack dc" aria-labelledby="dcT"><div class="card-head"><h3 id="dcT">${ic("activity")}Device Control Center</h3>
        <div class="tabs" id="dcTabs" role="group" aria-label="Device Control Center">${TABS.map(([v, t]) => `<button type="button" data-tab="${v}" aria-pressed="${v === "diag"}">${t}</button>`).join("")}</div></div>
      <div id="dcBody" aria-live="polite"></div></section>`;
    document.querySelectorAll("#dcTabs [data-tab]").forEach(b => b.onclick = () => show(s, b.dataset.tab));
    show(s, "diag");
  }

  window.WLDeviceCenter = { mount, dispose, diagView, permView };
})();
