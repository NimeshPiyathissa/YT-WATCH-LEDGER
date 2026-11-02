/* lib/sync.js — private device sync (self.YTSync).
   Pure core (unit-tested in Node) + a thin client that only touches chrome.*, fetch and YTDB when called.
   Nothing here runs unless the device is paired.

   Model
   - A session snapshot is the sync event; its id is "<sessionId>:<rev>". Rows wait in the IndexedDB outbox
     (written atomically with the session) and are removed only when the server acknowledges that revision.
   - The device stores one long-lived *refresh credential* (issued once at pairing). Every sync run exchanges
     it for a short-lived access token; the credential itself is sent only to /api/device/token.
   - Each pairing is a *device session*. A pairing code connects the device at once, unless the owner generated it
     with "require approval": then it is "pending" and nothing is uploaded until approval (events stay in the outbox).
   - The person at the device cannot end the session: "Delete session" files a request that the owner approves or
     denies in the dashboard, and the session keeps working until then. */
(function (root){
  "use strict";
  const BATCH = 200, MAX_BATCHES = 20, TIMEOUT_MS = 20000, FALLBACK_VERSION = "0.5.0";
  const COMMANDS = ["pause_tracking","resume_tracking","set_retention","delete_all","delete_range"];

  // ---- pure core (unit-tested) ----
  const eventId = s => s.sessionId + ":" + (s.rev || 0);
  function backoff(attempt){ return Math.min(60000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random()*500); }

  // Oldest-queued first. Rows whose session no longer exists are returned separately so they can be dropped.
  function buildBatch(rows, sessionsById, limit){
    const send = [], gone = [];
    for(const r of rows){
      if(send.length >= limit) break;
      const s = sessionsById[r.sessionId];
      if(s) send.push(s); else gone.push({sessionId: r.sessionId, rev: r.rev});
    }
    return {send: send, gone: gone};
  }
  // What an HTTP failure means for this device. refresh: access token expired (get a new one and retry);
  // pending: paired but not approved yet; revoked / removed: the owner cut this device off;
  // deleted: the owner approved this device's own request to delete its session.
  function classifyAuth(status, error){
    if(status === 401 && error === "token_invalid") return "refresh";
    if(status === 401) return "removed";
    if(status === 403 && error === "pending_approval") return "pending";
    if(status === 403 && error === "session_deleted") return "deleted";
    if(status === 403) return "revoked";
    return null;
  }
  // A real-time "session_revoked" reason, mapped onto the same kinds.
  function revokeKind(reason){ return reason === "session_deleted" ? "deleted" : reason === "removed" ? "removed" : "revoked"; }
  // "abcd efgh" -> "ABCD-EFGH" (the server ignores separators and case anyway).
  function formatPairingCode(input){
    const c = String(input||"").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    return c.length === 8 ? c.slice(0,4) + "-" + c.slice(4) : c;
  }

  // Returns the server origin to use, or null. https only (plain http just for local development).
  function normalizeServerUrl(input){
    let u; try { u = new URL(String(input||"").trim()); } catch(_e){ return null; }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if(!(u.protocol === "https:" || (u.protocol === "http:" && local))) return null;
    if(u.username || u.password) return null;
    return u.origin;
  }
  // Same rules the server applies; the device never trusts a command it can't validate.
  function validateCommand(cmd){
    if(!cmd || COMMANDS.indexOf(cmd.type) < 0) return null;
    const p = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};
    if(cmd.type === "set_retention"){
      const d = Number(p.days);
      return Number.isInteger(d) && d >= 0 && d <= 3650 ? {type:cmd.type, payload:{days:d}} : null;
    }
    if(cmd.type === "delete_range"){
      const from = Number(p.from), to = Number(p.to);
      return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from <= to ? {type:cmd.type, payload:{from:from, to:to}} : null;
    }
    return {type:cmd.type, payload:{}};
  }
  function isEnrolled(c){ return !!(c && c.sync_server && c.device_refresh); }
  // The line every UI surface shows while data may leave the device.
  function syncNoticeText(c){
    if(!isEnrolled(c)) return "";
    let host = c.sync_server; try { host = new URL(c.sync_server).host; } catch(_e){}
    if(c.sync_status === "pending") return "Waiting for the owner to approve this device on " + host + ". Nothing is sent until then.";
    return "Syncing YouTube watch data to " + host + ".";
  }

  // ---- client (browser only) ----
  const DEFAULTS = {sync_server:"",device_refresh:"",device_id:"",session_id:"",sync_status:"",confirm_code:"",enrolled_label:"",
                    paired_at:0,just_connected:0,session_request:null,
                    sync_last_ok:0,sync_last_error:"",sync_notice:"",sync_pending:0,last_remote_command:null,
                    device_token:"" /* legacy long-lived bearer from v0.3: no longer accepted by the server */};
  let hooks = {}, tokenCache = null;
  function init(h){ hooks = h || {}; }
  function cfg(){ return new Promise(r=>chrome.storage.local.get(DEFAULTS, r)); }
  function setCfg(o){ return new Promise(r=>chrome.storage.local.set(o, r)); }
  function diag(level, msg, extra){ try { if(root.YTDiag) root.YTDiag[level](msg, extra); } catch(_e){} }
  // The version the dashboard shows is the installed manifest's, so a rebuilt extension reports itself correctly.
  function clientVersion(){
    try { if(root.chrome && chrome.runtime && chrome.runtime.getManifest) return chrome.runtime.getManifest().version; } catch(_e){}
    return FALLBACK_VERSION;
  }

  async function fetchJson(url, opts){
    const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({}, opts, {signal: ctl.signal}));
      let body = null; try { body = await res.json(); } catch(_e){}
      return {status: res.status, ok: res.ok, body: body || {}};
    } finally { clearTimeout(t); }
  }

  // Thrown to stop a sync run when the owner has cut this device off or not yet approved it.
  class AccessError extends Error { constructor(kind){ super(kind); this.kind = kind; } }

  async function loseAccess(kind){
    tokenCache = null;
    if(kind === "pending"){ await setCfg({sync_status:"pending"}); return; }
    await unenrollLocal(kind); // revoked | removed | deleted
  }

  // Exchange the refresh credential for an access token (cached in memory until shortly before expiry).
  async function accessToken(c, force){
    // Only an approved device's token is reused; a pending one must ask again so approval is noticed at once.
    if(!force && tokenCache && tokenCache.status === "active" && tokenCache.key === c.device_refresh && tokenCache.exp > Date.now() + 30000) return tokenCache;
    const r = await fetchJson(c.sync_server + "/api/device/token", {method:"POST", headers:{"Authorization":"Bearer "+c.device_refresh, "X-Client-Version": clientVersion()}});
    if(!r.ok){
      const kind = classifyAuth(r.status, r.body.error);
      if(kind && kind !== "refresh"){ await loseAccess(kind); throw new AccessError(kind); }
      throw new Error("token "+r.status);
    }
    tokenCache = {key: c.device_refresh, token: r.body.accessToken, exp: Date.now() + (Number(r.body.expiresIn)||900)*1000,
                  status: r.body.status, confirmCode: r.body.confirmCode, sessionId: r.body.sessionId};
    if(r.body.sessionId && r.body.sessionId !== c.session_id) await setCfg({session_id: r.body.sessionId});
    return tokenCache;
  }
  function dropToken(){ tokenCache = null; }

  // Authenticated request; on an expired access token, refresh once and retry.
  async function api(c, path, opts){
    for(let attempt = 0; attempt < 2; attempt++){
      const t = await accessToken(c, attempt > 0);
      const r = await fetchJson(c.sync_server + path, Object.assign({}, opts, {
        headers: Object.assign({"Content-Type":"application/json","Authorization":"Bearer "+t.token}, opts && opts.headers)}));
      const kind = classifyAuth(r.status, r.body.error);
      if(kind === "refresh") continue;
      if(kind){ await loseAccess(kind); throw new AccessError(kind); }
      return r;
    }
    throw new Error("token refresh failed");
  }

  // v0.3 devices hold a long-lived token that the server stores as a hash, which is exactly what a refresh credential
  // is. Adopt it as one (no re-pairing) and queue whatever the old timestamp cursor had not uploaded yet.
  async function migrateLegacy(c, DB){
    const old = await new Promise(r=>chrome.storage.local.get({sync_cursor:0}, r));
    const unsent = await DB.getSessionsSince(old.sync_cursor || 0);
    if(unsent.length) await DB.outboxEnqueue(unsent);
    await setCfg({device_refresh:c.device_token, device_token:"", sync_status:"active", sync_cursor:0});
    diag("info", "migrated from v0.3 sync", {queued: unsent.length});
  }

  // One sync run: confirm status, upload the outbox in batches, apply commands, refresh the session's state. `DB` defaults to YTDB.
  async function pushOnce(DB){
    DB = DB || root.YTDB;
    let c = await cfg();
    if(!isEnrolled(c) && c.sync_server && c.device_token){ await migrateLegacy(c, DB); c = await cfg(); }
    if(!isEnrolled(c)) return {skipped:true};
    try {
      const t = await accessToken(c);
      if(t.status === "pending"){
        await setCfg({sync_status:"pending", confirm_code:t.confirmCode||c.confirm_code, sync_last_error:"", sync_pending: await DB.outboxCount()});
        return {pending:true};
      }
      // Approved while we were waiting: that is the moment this device became connected.
      if(c.sync_status !== "active") await setCfg({sync_status:"active", confirm_code:"", just_connected: c.sync_status === "pending" ? Date.now() : c.just_connected});

      let pushed = 0, first = true;
      for(let i = 0; i < MAX_BATCHES; i++){
        const rows = await DB.outboxAll();
        if(!rows.length && !first) break;
        const head = rows.slice(0, BATCH);
        const sessions = (await DB.getSessionsByIds(head.map(r=>r.sessionId))).filter(Boolean);
        const byId = {}; sessions.forEach(s=>{ byId[s.sessionId] = s; });
        const b = buildBatch(head, byId, BATCH);
        if(b.gone.length) await DB.outboxAck(b.gone);
        const remaining = rows.length - head.length;
        const res = await api(c, "/api/sync/push", {method:"POST", body: JSON.stringify({
          sessions: b.send, clientNow: Date.now(), pending: remaining, lastError: c.sync_last_error || "", clientVersion: clientVersion()})});
        if(!res.ok) throw new Error("push "+res.status);
        // Remove only what the server explicitly acknowledged (or told us it will never accept).
        await DB.outboxAck([].concat(res.body.acked||[], res.body.rejected||[]));
        pushed += (res.body.acked||[]).length;
        first = false;
        if(head.length < BATCH) break;
      }
      const applied = await pullCommands(c);
      await refreshSession(c);
      await setCfg({sync_last_ok: Date.now(), sync_last_error:"", sync_pending: await DB.outboxCount()});
      return {pushed: pushed, applied: applied};
    } catch(e){
      if(e instanceof AccessError) return e.kind === "pending" ? {pending:true} : {revoked:true, kind:e.kind};
      await setCfg({sync_last_error: String(e && e.message || e), sync_pending: await DB.outboxCount().catch(()=>0)});
      throw e;
    }
  }

  async function pullCommands(c){
    const r = await api(c, "/api/sync/commands", {method:"GET"});
    if(!r.ok) throw new Error("commands "+r.status);
    const acks = [];
    for(const cmd of (r.body.commands||[])) acks.push({id: cmd.id, result: await applyCommand(cmd)});
    if(acks.length){
      const a = await api(c, "/api/sync/commands/ack", {method:"POST", body: JSON.stringify({acks: acks})});
      if(!a.ok) throw new Error("ack "+a.status);
    }
    return acks.length;
  }

  async function applyCommand(cmd){
    const v = validateCommand(cmd);
    if(!v){ diag("warn", "remote command rejected", {type: cmd && cmd.type}); return {status:"error", error:"invalid_command"}; }
    try {
      switch(v.type){
        case "pause_tracking":  await setCfg({tracking_enabled:false}); break;
        case "resume_tracking": await setCfg({tracking_enabled:true}); break;
        case "set_retention":
          await setCfg({retention_days: v.payload.days});
          if(hooks.enforceRetention) await hooks.enforceRetention();
          break;
        case "delete_all":   await root.YTDB.clearAll(); break;
        case "delete_range": await root.YTDB.deleteByRange(v.payload.from, v.payload.to); break;
      }
      await setCfg({last_remote_command: {t: Date.now(), type: v.type}});
      diag("info", "remote command applied", {type: v.type});
      return {status:"ok"};
    } catch(e){
      diag("error", "remote command failed", {type: v.type, error: String(e)});
      return {status:"error", error:String(e && e.message || e)};
    }
  }

  // Pair with the server using the one-time code from the owner's dashboard.
  // opts.uploadHistory=false (default): only activity recorded after pairing is queued. opts.deviceName: optional name
  // (the name the owner typed when generating the code wins).
  async function enroll(serverInput, code, opts){
    const server = normalizeServerUrl(serverInput);
    if(!server) throw new Error("Enter a valid https:// server address.");
    const installId = await new Promise(r=>chrome.storage.local.get({install_id:""}, o=>r(o.install_id)));
    let res;
    try {
      const name = (opts && opts.deviceName) || "";
      res = await fetchJson(server + "/api/enroll", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({code: formatPairingCode(code), installId: installId, label: String(name).slice(0, 80) || undefined,
                              platform: (typeof navigator !== "undefined" && navigator.platform) || "", clientVersion: clientVersion()})});
    } catch(e){ throw new Error("Could not reach the server."); }
    if(res.status === 400) throw new Error("That code is invalid, expired or already used.");
    if(res.status === 429) throw new Error("Too many attempts. Wait a few minutes and try again.");
    if(!res.ok) throw new Error("Pairing failed ("+res.status+").");
    const j = res.body;
    tokenCache = null;
    const now = Date.now();
    await setCfg({sync_server: server, device_refresh: j.refreshToken, device_id: j.deviceId, session_id: j.sessionId || "", enrolled_label: j.label||"",
                  sync_status: j.status || "pending", confirm_code: j.confirmCode || "", device_token:"", paired_at: now,
                  just_connected: j.status === "active" ? now : 0, session_request: null,
                  sync_notice:"", sync_last_error:"", sync_last_ok:0, sync_pending:0});
    if(opts && opts.uploadHistory && root.YTDB) await root.YTDB.outboxEnqueueAll();
    diag("info", "paired", {server: server, status: j.status, uploadHistory: !!(opts && opts.uploadHistory)});
    return j;
  }

  // Forget this pairing on the device. Only ever because the server said the session is over (revoked, removed, or its
  // deletion approved): the device has no way to end a session by itself.
  async function unenrollLocal(reason){
    tokenCache = null;
    await setCfg({sync_server:"", device_refresh:"", device_token:"", device_id:"", session_id:"", sync_status:"", confirm_code:"", enrolled_label:"",
      sync_pending:0, sync_last_error:"", paired_at:0, just_connected:0, session_request:null,
      sync_notice: reason === "revoked" ? "The owner revoked this device. Nothing is being sent any more."
                 : reason === "removed" ? "The owner removed this device. Nothing is being sent any more."
                 : reason === "deleted" ? "Session deleted: the admin approved your request. Nothing is being sent any more." : ""});
    if(root.YTDB && root.YTDB.outboxClear) await root.YTDB.outboxClear();
    diag("warn", "unenrolled", {reason: reason||"user"});
  }
  // The server pushed "session_revoked" over the real-time channel.
  async function revoked(reason){ await loseAccess(revokeKind(reason)); }

  // The deletion request as stored for the UI; kept in step with the server (decisions made while offline arrive here too).
  const requestView = r => r ? {id: r.id, status: r.status, requestedAt: r.requestedAt, decidedAt: r.decidedAt || null, decisionNote: r.decisionNote || null} : null;
  function storeRequest(r){ return setCfg({session_request: requestView(r)}); }
  async function refreshSession(c){
    const r = await api(c, "/api/device/session", {method:"GET"});
    if(!r.ok) return null;
    const cur = (await cfg()).session_request, next = requestView(r.body.deletionRequest);
    if(JSON.stringify(cur) !== JSON.stringify(next)) await setCfg({session_request: next});
    if(r.body.device && r.body.device.label && r.body.device.label !== c.enrolled_label) await setCfg({enrolled_label: r.body.device.label});
    return r.body;
  }

  // "Delete session": asks the owner. The session stays active (and keeps syncing) until the owner approves; asking
  // again while a request is open returns the same request.
  async function requestSessionDeletion(reason){
    const c = await cfg();
    if(!isEnrolled(c)) throw new Error("This device is not connected.");
    let r;
    try { r = await api(c, "/api/device/session/deletion-request", {method:"POST", body: JSON.stringify({reason: reason || ""})}); }
    catch(e){
      if(e instanceof AccessError) throw new Error("This session has already ended.");
      throw new Error("Could not reach the server. Try again when you are online.");
    }
    if(r.status === 429) throw new Error("Too many requests. Try again later.");
    if(!r.ok) throw new Error("The request failed ("+r.status+").");
    await storeRequest(r.body.request);
    diag("info", "session deletion requested", {duplicate: !!r.body.duplicate});
    return r.body.request;
  }

  root.YTSync = { eventId, buildBatch, classifyAuth, revokeKind, formatPairingCode, backoff, normalizeServerUrl, validateCommand, isEnrolled, syncNoticeText,
                  init, cfg, setCfg, pushOnce, enroll, unenrollLocal, revoked, requestSessionDeletion, refreshSession, storeRequest,
                  accessToken, dropToken, clientVersion };
  if(typeof module !== "undefined" && module.exports) module.exports = root.YTSync;
})(typeof self!=="undefined"?self:this);
