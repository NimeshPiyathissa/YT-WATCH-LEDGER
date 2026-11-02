(function () {
  "use strict";
  const U = window.YTUtil, DB = window.YTDB, S = window.YTStats, SYNC = window.YTSync, IC = window.YTIcons;
  const $ = id => document.getElementById(id), esc = U.escapeHtml;
  const open = path => { chrome.tabs.create({ url: chrome.runtime.getURL(path) }); window.close(); };
  const local = k => new Promise(r => chrome.storage.local.get(k, r));
  const baked = (window.YTBuildConfig && window.YTBuildConfig.server) || ""; // set by a release build for one server
  let confirming = false, busy = false;

  $("openDash").addEventListener("click", () => open("dashboard/dashboard.html"));
  $("openSettings").addEventListener("click", () => open("settings/settings.html"));
  $("openAdmin").addEventListener("click", () => open("admin/admin.html"));
  $("version").textContent = "Version " + chrome.runtime.getManifest().version;

  /* ---- small UI helpers ---- */
  function showError(msg) { const e = $("error"); e.textContent = msg || ""; e.hidden = !msg; }
  function banner(kind, icon, text, dismiss) {
    const b = $("banner");
    if (!text) { b.hidden = true; b.innerHTML = ""; return; }
    b.className = "banner " + kind; b.hidden = false;
    b.innerHTML = (icon === "spin" ? '<span class="spin" aria-hidden="true"></span>' : IC.icon(icon)) + "<span>" + esc(text) + "</span>" + (dismiss ? '<button class="x" id="bnX" type="button" aria-label="Dismiss">' + IC.icon("x") + "</button>" : "");
    if (dismiss) $("bnX").onclick = dismiss;
  }
  function pill(on, text) { $("state").className = "pill " + (on ? "on" : "off"); $("state").lastElementChild.textContent = text; }
  const hostOf = u => { try { return new URL(u).host; } catch (_e) { return u || ""; } };
  const row = (k, v) => "<dt>" + k + "</dt><dd>" + v + "</dd>";

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
    finally { busy = false; btn.removeAttribute("aria-busy"); render(); }
  }

  function viewDisconnected(card, c, draft) {
    card.className = "card conn";
    card.innerHTML = `<div class="conn-head"><h2>${IC.icon("unlink")}Not connected</h2></div>
      <p class="muted small">Get a pairing code from the admin dashboard (Devices → Generate pairing code) and enter it here.</p>
      <form class="stack-sm" id="pForm" autocomplete="off">
        ${baked ? `<p class="small">Server: <span class="mono">${esc(hostOf(baked))}</span></p>` : `<label class="field">Server address<input class="input" id="pServer" placeholder="https://tracker.example.com" inputmode="url" spellcheck="false" value="${esc(draft.server || "")}" /></label>`}
        <label class="field">Pairing code<input class="input code-in" id="pCode" placeholder="XXXX-XXXX" maxlength="9" spellcheck="false" autocapitalize="characters" value="${esc(draft.code || "")}" /></label>
        <button class="btn btn-accent btn-block" id="pGo" type="submit">${IC.icon("link")}Connect</button>
      </form>
      <p class="caption">Connecting sends this browser's YouTube watch history (titles, channels, watch time) to that server. Nothing is sent before you pair.</p>`;
    card.querySelector("#pForm").addEventListener("submit", e => { e.preventDefault(); connect(card); });
    if (!card.contains(document.activeElement)) (baked || draft.server ? card.querySelector("#pCode") : card.querySelector("#pServer")).focus();
  }

  /* ---- delete session: only ever a REQUEST; the session stays connected until the admin approves ---- */
  async function askDeletion(card) {
    if (busy) return;
    busy = true; showError(""); const btn = card.querySelector("#dYes"); if (btn) btn.setAttribute("aria-busy", "true");
    try { await SYNC.requestSessionDeletion(""); }
    catch (e) { showError(e.message || "The request failed."); }
    finally { busy = false; confirming = false; render(); }
  }

  async function viewConnected(card, c, extra) {
    const pending = c.sync_status === "pending", req = c.session_request, waiting = !!(req && req.status === "pending");
    card.className = "card conn " + (pending ? "is-wait" : "is-on");
    const rows = [
      row("Server", `<span class="mono">${esc(hostOf(c.sync_server))}</span>`),
      row("Device", esc(c.enrolled_label || "This browser")),
      row("Session", c.session_id ? `<span class="mono" title="${esc(c.session_id)}">${esc(c.session_id.slice(0, 8))}</span>` : "—"),
      ...(pending ? [row("Confirm code", `<span class="mono">${esc(c.confirm_code || "—")}</span>`)] : [row("Channel", extra.rt === "online" ? "Live" : "Polling"), row("Last sync", c.sync_last_ok ? esc(U.fmtDateTime(c.sync_last_ok)) : "Not yet"), row("Pending uploads", String(extra.queued))]),
      ...(c.sync_last_error ? [row("Last error", `<span class="small">${esc(c.sync_last_error)}</span>`)] : [])
    ].join("");
    card.innerHTML = `<div class="conn-head"><h2>${IC.icon(pending ? "clock" : "circle-check")}${pending ? "Waiting for approval" : "Connected"}</h2><button class="btn btn-sm" id="cSync" type="button" ${pending ? "disabled" : ""}>${IC.icon("refresh-cw")}Sync</button></div>
      <dl class="kv">${rows}</dl>
      ${confirming ? `<div class="confirm-box" role="group" aria-label="Confirm session deletion"><p><b>Ask the admin to delete this session?</b> It stays connected and keeps syncing until the admin approves.</p><div class="btns"><button class="btn btn-danger" id="dYes" type="button">Send request</button><button class="btn" id="dNo" type="button">Cancel</button></div></div>`
        : `<div class="btns"><button class="btn btn-danger" id="dAsk" type="button" ${waiting ? "disabled" : ""}>${IC.icon("trash-2")}${waiting ? "Waiting for Admin Approval" : "Delete session"}</button></div>`}`;
    card.querySelector("#cSync").onclick = () => { showError(""); chrome.runtime.sendMessage({ type: "SYNC_NOW" }, r => { void chrome.runtime.lastError; if (r && r.error) showError("Sync failed: " + r.error); }); };
    if (card.querySelector("#dAsk")) card.querySelector("#dAsk").onclick = () => { confirming = true; render(); };
    if (card.querySelector("#dNo")) card.querySelector("#dNo").onclick = () => { confirming = false; render(); };
    if (card.querySelector("#dYes")) { card.querySelector("#dYes").onclick = () => askDeletion(card); card.querySelector("#dYes").focus(); }
  }

  /* ---- one render for every state; it re-runs whenever storage changes (decisions, revocation, approval) ---- */
  async function render() {
    if (busy) return;
    const c = await SYNC.cfg(), x = await local({ rt_state: "offline", tracking_enabled: true, pair_draft: null });
    const card = $("conn"), enrolled = SYNC.isEnrolled(c), req = c.session_request;
    pill(x.tracking_enabled !== false, x.tracking_enabled !== false ? "Tracking on" : "Tracking off");
    $("localNote").hidden = enrolled;

    if (!enrolled) {
      confirming = false;
      banner(c.sync_notice ? "bad" : "", "info", c.sync_notice || "", c.sync_notice ? () => SYNC.setCfg({ sync_notice: "" }) : null);
      return viewDisconnected(card, c, x.pair_draft || {});
    }
    if (c.sync_status === "pending") banner("wait", "clock", "Waiting for the admin to approve this device.");
    else if (req && req.status === "pending") banner("wait", "spin", "Waiting for Admin Approval");
    else if (req && req.status === "denied") banner("bad", "circle-alert", "Your deletion request was denied. The session stays connected.");
    else if (c.just_connected && Date.now() - c.just_connected < 60000) banner("ok", "circle-check", "Connected Successfully");
    else banner("", "", "");
    const queued = await DB.outboxCount().catch(() => 0);
    return viewConnected(card, c, { rt: x.rt_state, queued });
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || busy) return;
    if (["sync_server", "sync_status", "session_request", "just_connected", "sync_notice", "rt_state", "sync_last_ok", "sync_pending", "enrolled_label", "tracking_enabled"].some(k => k in ch)) render();
  });

  render();
  IC.hydrate(document);
  Promise.all([DB.getAllVideos(), DB.getAllSessions()]).then(r => {
    const s = S.summarize(r[0], r[1], Date.now(), U.dayKey);
    $("today").textContent = U.fmtDuration(s.todayMs);
    $("week").textContent = U.fmtDuration(s.last7Ms);
  });
})();
