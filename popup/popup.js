(function () {
  "use strict";
  const U = window.YTUtil, DB = window.YTDB, S = window.YTStats, SYNC = window.YTSync, IC = window.YTIcons, M = window.YTPopupModel;
  const $ = id => document.getElementById(id), esc = U.escapeHtml;
  const open = path => { chrome.tabs.create({ url: chrome.runtime.getURL(path) }); window.close(); };
  const local = k => new Promise(r => chrome.storage.local.get(k, r));
  const baked = (window.YTBuildConfig && window.YTBuildConfig.server) || ""; // set by a release build for one server
  const msg = m => new Promise(r => chrome.runtime.sendMessage(m, x => { void chrome.runtime.lastError; r(x); }));
  let confirming = false, confirmingLive = false, busy = false, lastKey = "";

  $("openDash").addEventListener("click", () => open("dashboard/dashboard.html"));
  $("openSettings").addEventListener("click", () => open("settings/settings.html"));
  $("openAdmin").addEventListener("click", () => open("admin/admin.html"));
  $("version").textContent = "Version " + chrome.runtime.getManifest().version;

  // The user's own control: pausing or resuming tracking is always theirs to do from here.
  $("trackToggle").addEventListener("change", () => { chrome.storage.local.set({ tracking_enabled: $("trackToggle").checked }); });

  // Anything an administrator has done to this device is shown, never silent (see lib/status.js REMOTE).
  async function showRemote(x) {
    const el = $("remote"), cmd = x.last_remote_command, text = cmd && window.YTStatus.REMOTE[cmd.type];
    if (!text || !cmd.t || Date.now() - cmd.t > 86400000 || (x.remote_cmd_seen || 0) >= cmd.t) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = IC.icon("info") + "<span>" + esc(text) + " (" + esc(U.fmtDateTime(cmd.t)) + ").</span>" + '<button class="x" id="rmX" type="button" aria-label="Dismiss">' + IC.icon("x") + "</button>";
    $("rmX").onclick = () => chrome.storage.local.set({ remote_cmd_seen: cmd.t });
  }

  /* ---- small UI helpers ---- */
  function showError(text) { const e = $("error"); e.textContent = text || ""; e.hidden = !text; }
  function banner(kind, icon, text, dismiss) {
    const b = $("banner");
    if (!text) { b.hidden = true; b.innerHTML = ""; return; }
    b.className = "banner " + kind; b.hidden = false;
    b.innerHTML = (icon === "spin" ? '<span class="spin" aria-hidden="true"></span>' : IC.icon(icon)) + "<span>" + esc(text) + "</span>" + (dismiss ? '<button class="x" id="bnX" type="button" aria-label="Dismiss">' + IC.icon("x") + "</button>" : "");
    if (dismiss) $("bnX").onclick = dismiss;
  }
  function pill(tone, text) { $("state").className = "pill " + tone; $("state").lastElementChild.textContent = text; }
  const hostOf = M.hostOf;
  // Replace an element's content only when it really changed, so a periodic refresh never steals keyboard focus or resets a control.
  const setHTML = (el, html) => { if (el._h === html) return false; el._h = html; el.innerHTML = html; return true; };
  const row = (k, v) => "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>";

  /* ---- state -> the model the popup draws (all wording lives in lib/popupmodel.js) ---- */
  async function gather() {
    const c = await SYNC.cfg();
    const x = await local({ rt_state: "offline", tracking_enabled: true, pair_draft: null, last_remote_command: null, remote_cmd_seen: 0, live_view: false, sync_retry: null, sync_queue_dropped: 0 });
    const enrolled = SYNC.isEnrolled(c);
    let queue = { sessions: 0, events: 0, dropped: x.sync_queue_dropped || 0, oldestAt: null };
    if (enrolled) {
      const [s, e, os, oe] = await Promise.all([DB.outboxCount().catch(() => 0), DB.evOutboxCount().catch(() => 0), DB.outboxOldest().catch(() => null), DB.evOutboxOldest().catch(() => null)]);
      queue = { sessions: s, events: e, dropped: x.sync_queue_dropped || 0, oldestAt: [os, oe].filter(Boolean).sort((a, b) => a - b)[0] || null };
    }
    const state = {
      enrolled, sync_status: c.sync_status, sync_server: c.sync_server, enrolled_label: c.enrolled_label, session_id: c.session_id, confirm_code: c.confirm_code,
      sync_last_ok: c.sync_last_ok, sync_last_error: c.sync_last_error, sync_last_error_kind: c.sync_last_error_kind, sync_retry: x.sync_retry, rt_state: x.rt_state,
      tracking_enabled: x.tracking_enabled, live_view: x.live_view, session_request: c.session_request, queue, browserOnline: navigator.onLine
    };
    return { c, x, state, model: M.build(state, Date.now()) };
  }

  /* ---- the status hero: what is happening, why, and the way out ---- */
  const ICON = { ok: "circle-check", warn: "clock", bad: "triangle-alert", idle: "unlink" };
  function renderHero(g) {
    const m = g.model, el = $("hero");
    el.className = "hero tone-" + m.tone;
    const changed = setHTML(el, `<div class="hero-main"><span class="hero-ic" aria-hidden="true">${IC.icon(m.key === "offline" ? "clock" : ICON[m.tone] || "info")}</span>
      <div class="hero-txt"><h2>${esc(m.title)}</h2><p>${esc(m.sub)}</p></div></div>
      ${m.error ? `<p class="hero-err">${esc(m.error)}${m.retry ? " " + esc(m.retry) : ""}</p>` : m.retry ? `<p class="hero-err soft">${esc(m.retry)}</p>` : ""}
      ${g.state.enrolled ? `<div class="hero-queue ${m.queue.warn ? "warn" : ""}"><span>${IC.icon(m.queue.waiting ? "refresh-cw" : "check")}</span><span>${esc(m.queue.text)}</span></div>
        ${m.queue.events > 0 ? `<svg class="qbar" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${m.queue.events} of ${m.queue.limit} queued events"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${Math.max(1, Math.min(100, m.queue.events / m.queue.limit * 100))}" height="4" rx="2"/></svg>` : ""}
        <div class="hero-actions"><button class="btn btn-sm ${m.tone === "ok" ? "" : "btn-accent"}" id="reconnect" type="button" title="Get a fresh connection and sync now">${IC.icon("refresh-cw")}Reconnect</button></div>` : ""}`);
    const rc = $("reconnect");
    if (changed && rc) rc.onclick = async () => {
      if (busy) return; busy = true; rc.setAttribute("aria-busy", "true"); showError("");
      const r = await msg({ type: "RECONNECT" });
      busy = false;
      if (r && r.error) showError(window.YTSyncPolicy.friendlyError(r.error, r.kind));
      refresh();
    };
  }

  /* ---- pairing ---- */
  async function connect(card) {
    if (busy) return;
    showError("");
    const server = baked || card.querySelector("#pServer").value, code = SYNC.formatPairingCode(card.querySelector("#pCode").value);
    const origin = SYNC.normalizeServerUrl(server);
    if (!origin) return showError("Enter a valid https:// server address.");
    if (code.replace("-", "").length < 8) return showError("Enter the 8-character pairing code from the dashboard.");
    busy = true; const btn = card.querySelector("#pGo"); btn.setAttribute("aria-busy", "true");
    // Chrome may close this popup while it asks for permission, so keep what was typed; it is restored on reopening.
    await new Promise(r => chrome.storage.local.set({ pair_draft: { server: baked ? "" : server, code } }, r));
    try {
      // First await on purpose: the click must still count as a user gesture for the permission prompt.
      let granted = false;
      try { granted = await chrome.permissions.request({ origins: [origin + "/*"] }); } catch (_e) { throw new Error("Could not ask for permission to contact that server."); }
      if (!granted) throw new Error("Permission to contact that server was not granted.");
      try { await SYNC.enroll(origin, code, {}); }
      catch (e) { chrome.permissions.remove({ origins: [origin + "/*"] }, () => void chrome.runtime.lastError); throw e; }
      await new Promise(r => chrome.storage.local.remove("pair_draft", r));
      chrome.runtime.sendMessage({ type: "PAIRED" }, () => void chrome.runtime.lastError);
    } catch (e) { showError(e.message || "Pairing failed."); }
    finally { busy = false; btn.removeAttribute("aria-busy"); refresh(true); }
  }

  function viewDisconnected(card, draft) {
    card.className = "card conn";
    card.innerHTML = `<div class="conn-head"><h2>${IC.icon("link")}Pair this browser</h2></div>
      <p class="muted small">Get a pairing code from the admin dashboard (Devices → Generate pairing code) and enter it here.</p>
      <form class="stack-sm" id="pForm" autocomplete="off">
        ${baked ? `<p class="small">Server: <span class="mono">${esc(hostOf(baked))}</span></p>` : `<label class="field">Server address<input class="input" id="pServer" placeholder="https://tracker.example.com" inputmode="url" spellcheck="false" value="${esc(draft.server || "")}" /></label>`}
        <label class="field">Pairing code<input class="input code-in" id="pCode" placeholder="XXXX-XXXX" maxlength="9" spellcheck="false" autocapitalize="characters" value="${esc(draft.code || "")}" /></label>
        <button class="btn btn-accent btn-block" id="pGo" type="submit">${IC.icon("link")}Connect</button>
      </form>
      <p class="caption">Connecting sends this browser's YouTube watch history (titles, channels, watch time) to that server. Nothing is sent before you pair. Live viewing stays off until you turn it on here.</p>`;
    card.querySelector("#pForm").addEventListener("submit", e => { e.preventDefault(); connect(card); });
    if (!card.contains(document.activeElement)) (baked || draft.server ? card.querySelector("#pCode") : card.querySelector("#pServer")).focus();
  }

  /* ---- delete session: only ever a REQUEST; the session stays connected until the admin approves ---- */
  async function askDeletion(card) {
    if (busy) return;
    busy = true; showError(""); const btn = card.querySelector("#dYes"); if (btn) btn.setAttribute("aria-busy", "true");
    try { await SYNC.requestSessionDeletion(""); }
    catch (e) { showError(e.message || "The request failed."); }
    finally { busy = false; confirming = false; refresh(true); }
  }

  function viewConnected(card, g) {
    const m = g.model, c = g.c, pending = c.sync_status === "pending", waiting = m.deletion === "waiting";
    card.className = "card conn " + (pending ? "is-wait" : "is-on");
    const wasOpen = !!(card.querySelector("details.more") && card.querySelector("details.more").open);
    const changed = setHTML(card, `<details class="more"${confirming || wasOpen ? " open" : ""}><summary><span>${IC.icon("laptop")}Connection details</span><span class="chev">${IC.icon("chevron-right")}</span></summary>
      <dl class="kv">${m.rows.map(r => row(r[0], r[0] === "Server" || r[0] === "Session" || r[0] === "Confirm code" ? `<span class="mono">${esc(r[1])}</span>` : esc(r[1]))).join("")}</dl></details>
      ${confirming ? `<div class="confirm-box" role="group" aria-label="Confirm session deletion"><p><b>Ask the admin to delete this session?</b> It stays connected and keeps syncing until the admin approves.</p><div class="btns"><button class="btn btn-danger" id="dYes" type="button">${IC.icon("trash-2")}Send request</button><button class="btn" id="dNo" type="button">Cancel</button></div></div>`
        : `<div class="btns"><button class="btn btn-danger btn-sm" id="dAsk" type="button" ${waiting ? "disabled" : ""}>${IC.icon("trash-2")}${waiting ? "Waiting for Admin Approval" : "Delete session"}</button></div>`}`);
    if (!changed) return;
    if (card.querySelector("#dAsk")) card.querySelector("#dAsk").onclick = () => { confirming = true; refresh(true); };
    if (card.querySelector("#dNo")) card.querySelector("#dNo").onclick = () => { confirming = false; refresh(true); };
    if (card.querySelector("#dYes")) { card.querySelector("#dYes").onclick = () => askDeletion(card); card.querySelector("#dYes").focus(); }
  }

  /* ---- live viewing: the person at this device decides, and sees it whenever it is on ---- */
  function renderLive(g) {
    const m = g.model, el = $("liveCard");
    el.hidden = !m.live.available;
    if (el.hidden) return;
    el.className = "card live" + (m.live.on ? " is-on" : "");
    if (!setHTML(el, `<div class="live-row"><div class="what"><b>${m.live.on ? '<span class="live-dot" aria-hidden="true"></span>' : ""}${esc(m.live.indicator)}</b><span>${esc(m.live.detail)}</span></div>
      <label class="switch"><input type="checkbox" id="liveToggle" aria-label="Live viewing" ${m.live.on ? "checked" : ""}><span class="slider"></span></label></div>
      ${confirmingLive ? `<div class="confirm-box" role="group" aria-label="Confirm live viewing"><p><b>Turn on live viewing?</b> The owner of <span class="mono">${esc(hostOf(g.c.sync_server))}</span> will be able to see which video is playing on this device right now, and updates will reach them within seconds. The toolbar badge shows <b>LIVE</b> while it is on. You can turn it off at any time.</p>
        <div class="btns"><button class="btn btn-accent" id="liveYes" type="button">Turn on</button><button class="btn" id="liveNo" type="button">Cancel</button></div></div>` : ""}`)) return;
    const tg = $("liveToggle");
    tg.onchange = async () => {
      if (tg.checked) { tg.checked = false; confirmingLive = true; renderLive(g); const y = $("liveYes"); if (y) y.focus(); return; }
      await msg({ type: "SET_LIVE_VIEW", on: false }); refresh(true);
    };
    if ($("liveYes")) { $("liveYes").onclick = async () => { confirmingLive = false; $("liveYes").setAttribute("aria-busy", "true"); await msg({ type: "SET_LIVE_VIEW", on: true }); refresh(true); }; $("liveNo").onclick = () => { confirmingLive = false; renderLive(g); }; }
  }

  /* ---- one render for every state; it re-runs whenever storage changes (decisions, revocation, approval) and every few seconds ---- */
  let refreshSeq = 0;
  async function refresh(force) {
    if (busy && !force) return;
    const my = ++refreshSeq;
    const g = await gather();
    if (my !== refreshSeq) return; // a newer refresh started while this one was reading: drawing this one now would show stale state
    const c = g.c, x = g.x, m = g.model, req = c.session_request;
    const card = $("conn");
    const tone = !g.state.enrolled ? "off" : m.key === "paused" ? "off" : m.tone === "bad" ? "bad" : m.tone === "warn" ? "warn" : "on";
    pill(tone, !g.state.enrolled ? (x.tracking_enabled !== false ? "Tracking on" : "Tracking paused") : m.key === "live" || m.key === "connected" ? (x.tracking_enabled !== false ? "Tracking on" : "Tracking paused") : m.title);
    $("trackToggle").checked = x.tracking_enabled !== false;
    $("trackHint").textContent = x.tracking_enabled !== false ? "Recording YouTube watch time on this device." : "Paused: nothing is being recorded.";
    showRemote(x);
    $("localNote").hidden = g.state.enrolled;
    renderHero(g);

    if (!g.state.enrolled) {
      confirming = false; confirmingLive = false;
      banner(c.sync_notice ? "bad" : "", "info", c.sync_notice || "", c.sync_notice ? () => SYNC.setCfg({ sync_notice: "" }) : null);
      $("liveCard").hidden = true;
      // never rebuild the pairing form while the person is typing in it
      if (lastKey !== "unpaired" || force) { viewDisconnected(card, x.pair_draft || {}); }
      lastKey = "unpaired"; return;
    }
    if (c.sync_status === "pending") banner("", "", ""); // the status card above already says it
    else if (req && req.status === "pending") banner("wait", "spin", "Waiting for Admin Approval");
    else if (req && req.status === "denied") banner("bad", "circle-alert", "Your deletion request was denied. The session stays connected.");
    else if (c.just_connected && Date.now() - c.just_connected < 60000) banner("ok", "circle-check", "Connected Successfully");
    else banner("", "", "");
    if (!(confirming || confirmingLive) || lastKey !== "paired" || force) viewConnected(card, g);
    renderLive(g);
    lastKey = "paired";
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || busy) return;
    if (["sync_server", "sync_status", "session_request", "just_connected", "sync_notice", "rt_state", "sync_last_ok", "sync_last_error", "sync_last_error_kind", "sync_retry", "sync_pending", "sync_queue_dropped", "enrolled_label", "tracking_enabled", "live_view", "last_remote_command", "remote_cmd_seen"].some(k => k in ch)) refresh();
  });
  window.addEventListener("online", () => refresh());
  window.addEventListener("offline", () => refresh());
  setInterval(() => { if (!busy && !document.hidden) refresh(); }, 5000); // relative times and the retry countdown

  refresh(true);
  IC.hydrate(document);
  Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
    const s = S.summarize(r[0], r[1], Date.now(), U.dayKey);
    $("today").textContent = U.fmtDuration(s.todayMs);
    $("week").textContent = U.fmtDuration(s.last7Ms);
  });
})();
