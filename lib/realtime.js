/* lib/realtime.js — the device's real-time channel to its server (self.YTRealtime). Runs in the service worker.
   One WebSocket while the device is paired. The server only sends hints ("you have commands", "your request was
   decided", "your session was revoked"); everything they imply is fetched or applied through the normal API.
   - Auth: the first message carries a short-lived access token (browsers can't set headers on a WebSocket).
   - Keepalive: a ping every 20 s. Since Chrome 116, WebSocket traffic keeps an extension service worker alive.
   - Reconnect: exponential backoff (1 s .. 60 s); the background's 1-minute alarm also calls connect(), so a worker that
     was stopped comes back on its own.
   - State for the UI: chrome.storage.local rt_state = "online" | "connecting" | "offline". */
(function (root) {
  "use strict";
  const PING_MS = 20000, MAX_BACKOFF_MS = 60000;
  let ws = null, pingT = null, retryT = null, attempt = 0, wanted = false, connecting = false, onEvent = null, lastState = "";

  function setState(s) {
    if (s === lastState) return Promise.resolve();
    lastState = s;
    return new Promise(r => chrome.storage.local.set({ rt_state: s, rt_since: Date.now() }, r));
  }
  const wsUrl = server => server.replace(/^http/, "ws") + "/api/device/ws";
  function stopPing() { clearInterval(pingT); pingT = null; }
  function schedule() {
    clearTimeout(retryT);
    if (!wanted) return;
    attempt++;
    retryT = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(attempt, 6))) + Math.floor(Math.random() * 1000));
  }

  async function connect() {
    if (typeof WebSocket === "undefined") return; // not in a browser (unit tests) — sync still works by polling
    const S = root.YTSync, c = await S.cfg();
    if (!S.isEnrolled(c)) return stop();
    if (connecting || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
    wanted = true; connecting = true; clearTimeout(retryT);
    let t;
    try { t = await S.accessToken(c); }
    catch (_e) { connecting = false; await setState("offline"); if (S.isEnrolled(await S.cfg())) schedule(); else stop(); return; }
    await setState("connecting");
    let sock;
    try { sock = new WebSocket(wsUrl(c.sync_server)); } catch (_e) { connecting = false; await setState("offline"); return schedule(); }
    ws = sock; connecting = false;
    sock.onopen = () => sock.send(JSON.stringify({ type: "auth", token: t.token }));
    sock.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (_e) { return; }
      if (m.type === "ready") {
        attempt = 0; setState("online");
        stopPing(); pingT = setInterval(() => { if (sock.readyState === 1) sock.send('{"type":"ping"}'); }, PING_MS);
      }
      if (m.type !== "pong" && onEvent) Promise.resolve(onEvent(m)).catch(() => {});
    };
    sock.onclose = ev => {
      if (ws === sock) ws = null;
      stopPing(); setState("offline");
      if (ev.code === 4401) S.dropToken(); // token was refused: mint a fresh one on the next attempt
      if (ev.code === 4403 || ev.code === 4001) return; // revoked / deleted: the session_revoked event handles it
      schedule();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  function stop() {
    wanted = false; clearTimeout(retryT); stopPing();
    if (ws) { const s = ws; ws = null; try { s.close(1000, "bye"); } catch (_e) { /* already closed */ } }
    return setState("offline");
  }
  function init(handler) { onEvent = handler; }
  const isOpen = () => !!(ws && ws.readyState === 1);

  root.YTRealtime = { init, connect, stop, isOpen };
})(typeof self !== "undefined" ? self : this);
