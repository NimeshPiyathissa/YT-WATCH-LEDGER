// A simulated browser-extension device for end-to-end tests.
// Each device is an isolated VM context that runs the REAL background.js, lib/db.js, lib/sync.js (and the other lib
// files background.js imports) against its own fake chrome.storage and its own IndexedDB, and talks to the real server
// over real HTTP. Only the browser APIs, the network (so failures can be injected) and timers are faked.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

// realtime: true gives the device a real WebSocket, so lib/realtime.js connects to the server like it does in Chrome.
export function makeDevice({ server, name, clockSkewMs = 0, realtime = false }) {
  // State that survives a "browser restart": storage, IndexedDB and the (injectable) network conditions.
  const store = { install_id: "inst-" + name };
  const idb = new IDBFactory();
  const net = { offline: false, loseResponses: 0, expireAccessOnce: false, log: [] };
  let ctx = null, onMessage = null, startups = [];
  const alarms = {};

  function boot() {
    startups = [];
    const chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            if (keys == null) Object.assign(out, store);
            else if (typeof keys === "string") { if (keys in store) out[keys] = store[keys]; }
            else if (Array.isArray(keys)) keys.forEach(k => { if (k in store) out[k] = store[k]; });
            else for (const k of Object.keys(keys)) out[k] = k in store ? structuredClone(store[k]) : keys[k];
            cb(out);
          },
          set(o, cb) { Object.assign(store, structuredClone(o)); cb && cb(); }
        },
        onChanged: { addListener() {} }
      },
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener(f) { startups.push(f); } }, onMessage: { addListener(f) { onMessage = f; } } },
      alarms: { get(n, cb) { cb(alarms[n]); }, create(n, info) { alarms[n] = info; }, onAlarm: { addListener() {} } },
      action: { setBadgeBackgroundColor() {}, setBadgeText() { return Promise.resolve(); } }
    };
    const skew = clockSkewMs;
    class SkewedDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(Date.now() + skew); }
      static now() { return Date.now() + skew; }
    }
    const fetchWrapped = async (url, opts) => {
      const p = new URL(url).pathname;
      if (net.offline) { net.log.push([p, "offline"]); throw new TypeError("fetch failed (offline)"); }
      if (net.expireAccessOnce && p === "/api/sync/push") {
        net.expireAccessOnce = false; net.log.push([p, 401]);
        return new Response(JSON.stringify({ error: "token_invalid" }), { status: 401 });
      }
      const res = await fetch(url, opts);
      net.log.push([p, res.status]);
      // The server processed the request but the device never sees the answer (connection dropped mid-response).
      if (net.loseResponses > 0 && p === "/api/sync/push") { net.loseResponses--; throw new TypeError("connection reset"); }
      return res;
    };
    const sandbox = {
      chrome, indexedDB: idb, IDBKeyRange, fetch: fetchWrapped, URL, URLSearchParams, AbortController, console, crypto: globalThis.crypto,
      Date: SkewedDate, navigator: { platform: "TestOS" }, ...(realtime ? { WebSocket: globalThis.WebSocket } : {}),
      setTimeout: () => 0, clearTimeout: () => {}, // no background timers: tests trigger syncs explicitly
      setInterval: () => 0, clearInterval: () => {},
      importScripts: (...files) => files.forEach(f => vm.runInContext(read(f), sandbox, { filename: f }))
    };
    sandbox.self = sandbox;
    ctx = vm.createContext(sandbox);
    vm.runInContext(read("background.js"), ctx, { filename: "background.js" });
  }
  boot();

  const send = (msg, sender = {}) => new Promise(res => { const r = onMessage(msg, sender, res); if (r !== true) res(undefined); });
  const dev = {
    name, store, net, alarms,
    // The tracker content script's snapshot, delivered like a real SESSION_FLUSH message.
    flush: snapshot => send({ type: "SESSION_FLUSH", snapshot: { ...snapshot } }),
    sync: () => send({ type: "SYNC_NOW" }),
    pair: (code, opts) => ctx.YTSync.enroll(server, code, opts),
    cfg: () => ctx.YTSync.cfg(),
    connect: () => ctx.YTRealtime.connect(),
    disconnect: () => ctx.YTRealtime.stop(),
    isLive: () => ctx.YTRealtime.isOpen(),
    requestDeletion: reason => ctx.YTSync.requestSessionDeletion(reason),
    outboxCount: () => ctx.YTDB.outboxCount(),
    outbox: () => ctx.YTDB.outboxAll(),
    sessions: () => ctx.YTDB.getAllSessions(),
    db: () => ctx.YTDB,
    now: () => Date.now() + clockSkewMs,
    // Simulates closing and reopening the browser: memory (token cache, timers, the service worker) is lost,
    // storage and IndexedDB survive.
    restart: async () => { boot(); startups.forEach(f => f()); await new Promise(r => setTimeout(r, 200)); },
    // A snapshot as content/tracker.js would send it.
    snap: (sessionId, videoId, over = {}) => ({
      sessionId, videoId, kind: "watch", url: "https://www.youtube.com/watch?v=" + videoId, title: "Title " + videoId, channel: "Chan",
      startTs: Date.now() + clockSkewMs - 60000, endTs: null, watchedMs: 30000, duration: 600,
      startSec: 0, positionSec: 30, furthestSec: 30, seeks: 0, rewinds: 0, pauses: 0, completed: false, rev: 1, ...over
    })
  };
  return dev;
}
