/* security.js: the Security Center page (#/security) of Watch Ledger. Reads GET /api/security/overview and the owner's sign-ins
   (GET /api/auth/sessions); changes the password and ends sign-ins. Every value is a count, a time or the owner's own email and goes
   through esc(). No inline styles or scripts. Passwords are only ever held in the form fields and sent once. */
(function () {
  "use strict";
  const WL = new Proxy({}, { get: (_t, k) => window.WL[k] }), U = window.YTUtil, esc = U.escapeHtml, ic = window.YTIcons.icon;
  const $ = id => document.getElementById(id);
  let seq = 0;
  const LEVEL = { warn: ["warn", "Needs attention"], info: ["info", "For your information"], bad: ["bad", "Urgent"] };
  const ERR = { wrong_password: "That is not your current password.", weak_password: "The new password must be 12 to 256 characters.", same_password: "The new password must differ from the current one.", rate_limited: "Too many attempts. Wait a few minutes." };
  const pill = (cls, text) => `<span class="pill ${cls}"><span class="dot"></span><span>${esc(text)}</span></span>`;
  const tile = (k, v, s) => `<div class="tile"><div class="meta"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>${s ? `<span class="s">${esc(s)}</span>` : ""}</div></div>`;

  function view(o, sessions) {
    const d = o.devices;
    const findings = o.findings.length
      ? `<ul class="checks">${o.findings.map(f => `<li>${pill((LEVEL[f.level] || LEVEL.info)[0], (LEVEL[f.level] || LEVEL.info)[1])} <span>${esc(f.message)}</span></li>`).join("")}</ul>`
      : `<p class="muted">${pill("on", "Nothing to review")} No pending devices, no repeated failed sign-ins, no copied tokens.</p>`;
    return `
      <div class="tiles">
        ${tile("Signed in", String(sessions.length), sessions.length === 1 ? "browser or computer" : "browsers or computers")}
        ${tile("Failed sign-ins", String(o.last24h.failedLogins), "last 24 hours")}
        ${tile("Wrong pairing codes", String(o.last24h.failedPairings), "last 24 hours")}
        ${tile("Devices", String(d.active), d.pending ? d.pending + " waiting for approval" : d.revoked + " revoked")}
        ${tile("Live viewing on", String(d.liveViewOn), "set on the device, not by you")}
      </div>
      <section class="card stack"><div class="card-head"><h3>What to review</h3></div>${findings}</section>
      <section class="card flush"><div class="card-head"><h3>Where you are signed in</h3>
        <div class="row"><button class="btn" type="button" id="scOthers"${sessions.length < 2 ? " disabled" : ""}>${ic("log-out")}Sign out everywhere else</button><button class="btn btn-danger" type="button" id="scAll">Sign out everywhere</button></div></div>
        <table class="table rtable"><thead><tr><th>Last renewed</th><th>Expires</th><th></th></tr></thead><tbody>
        ${sessions.map(s => `<tr><td data-primary class="num">${esc(U.fmtDateTime(s.renewedAt))}</td><td class="num" data-label="Expires">${esc(U.fmtDateTime(s.expiresAt))}</td><td data-label="This one">${s.current ? pill("on", "This browser") : ""}</td></tr>`).join("")}
        </tbody></table></section>
      <section class="card stack"><div class="card-head"><h3>Change password</h3></div>
        <p class="muted">Signed in as <b>${esc(o.owner.email || "")}</b>. Changing the password signs out every other browser. Pages already open elsewhere stop working within about 15 minutes.</p>
        <form id="scForm" class="stack" autocomplete="off">
          <label class="field">Current password<input class="input" id="scCur" type="password" autocomplete="current-password" required /></label>
          <label class="field">New password (12 or more characters)<input class="input" id="scNew" type="password" autocomplete="new-password" minlength="12" maxlength="256" required /></label>
          <label class="field">New password again<input class="input" id="scNew2" type="password" autocomplete="new-password" minlength="12" maxlength="256" required /></label>
          <div class="err" id="scErr" role="alert" hidden></div>
          <div><button class="btn btn-accent" id="scGo" type="submit">Change password</button></div>
        </form></section>
      <section class="card stack"><div class="card-head"><h3>How this server protects you</h3></div>
        <ul class="checks"><li>${pill("on", "On")} <span>Watch history is encrypted on the server with your key. Backups stay encrypted.</span></li>
        <li>${pill("on", "On")} <span>A new device needs a one-time pairing code that you create. It expires in 15 minutes and works once.</span></li>
        <li>${pill("on", "On")} <span>Live viewing is off for every device until the person at that device turns it on.</span></li>
        <li>${pill(o.trustProxy ? "on" : "info", o.trustProxy ? "On" : "Not set")} <span>Behind a reverse proxy, TRUST_PROXY=true makes the lock-outs apply to each visitor, not to everybody at once.</span></li></ul>
        <p class="caption">The full history is in the <a href="#/audit">Audit log</a>.</p></section>`;
  }

  async function render(app) {
    const mine = ++seq;
    app.innerHTML = WL.head("Security Center", "Who can get in, which devices are connected, and what happened recently. Only you can see this page.", `<button class="btn" type="button" id="scNow">${ic("refresh-cw")}Check now</button>`) +
      `<div id="scBody" class="stack" aria-live="polite"><div class="tiles"><span class="skel h-card"></span><span class="skel h-card"></span><span class="skel h-card"></span></div></div>`;
    const load = async () => {
      const box = $("scBody");
      try {
        const [o, sessions] = await Promise.all([WL.api("GET", "/api/security/overview"), WL.api("GET", "/api/auth/sessions")]);
        if (mine !== seq || !document.body.contains(box)) return;
        box.innerHTML = view(o, sessions);
        wire(load);
      } catch (e) {
        if (e.message === "unauthorized" || e.message === "navigated" || mine !== seq) return;
        box.innerHTML = `<section class="card">${WL.empty("shield-check", "Security Center could not load", WL.errText(e), `<button class="btn btn-accent" type="button" id="scRetry">${ic("refresh-cw")}Try again</button>`, "bad")}</section>`;
        $("scRetry").onclick = () => load();
      }
    };
    $("scNow").onclick = WL.guarded(load);
    await load();
  }

  function wire(reload) {
    $("scOthers").onclick = WL.guarded(async () => {
      if (!(await WL.confirmDialog({ title: "Sign out everywhere else?", body: "Every other browser or computer signed in as you is signed out. This one stays signed in.", ok: "Sign out the others" }))) return;
      const r = await WL.api("POST", "/api/auth/sign-out-others", {});
      WL.toast(r.signedOut ? `Signed out ${r.signedOut} other sign-in${r.signedOut === 1 ? "" : "s"}.` : "There was nothing else to sign out."); await reload();
    });
    $("scAll").onclick = WL.guarded(async () => {
      if (!(await WL.confirmDialog({ title: "Sign out everywhere?", body: "Every browser, including this one, is signed out. You will need your password to come back.", ok: "Sign out everywhere", danger: true }))) return;
      await WL.api("POST", "/api/auth/sign-out-all", {}); location.hash = "#/login";
    });
    $("scForm").onsubmit = WL.guarded(async ev => {
      ev.preventDefault();
      const bad = m => { $("scErr").textContent = m; $("scErr").hidden = false; };
      $("scErr").hidden = true;
      if ($("scNew").value !== $("scNew2").value) return bad("The two new passwords do not match.");
      $("scGo").disabled = true;
      try {
        const r = await WL.api("POST", "/api/auth/password", { current: $("scCur").value, next: $("scNew").value });
        WL.toast(r.signedOut ? `Password changed. ${r.signedOut} other sign-in${r.signedOut === 1 ? "" : "s"} ended.` : "Password changed.");
        $("scForm").reset(); await reload();
      } catch (e) { bad(ERR[e.message] || WL.errText(e)); } finally { const g = $("scGo"); if (g) g.disabled = false; }
    });
  }

  window.WLSecurity = { render, view };
})();
