"use strict"; global.self = global;
require("../lib/syncpolicy.js"); require("../lib/popupmodel.js"); const M = global.YTPopupModel;
let p = 0, f = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`)); };
const t = (n, c) => eq(n, !!c, true);
const NOW = Date.UTC(2026, 10, 4, 6, 0, 0), MIN = 60000;
const base = { enrolled: true, sync_status: "active", sync_server: "https://tracker.example.com/x", enrolled_label: "Studio laptop", session_id: "abcdef1234567890", sync_last_ok: NOW - 3 * MIN,
  sync_last_error: "", sync_last_error_kind: "", sync_retry: null, rt_state: "online", tracking_enabled: true, live_view: false, session_request: null, queue: { sessions: 0, events: 0, dropped: 0 }, browserOnline: true };
const m = o => M.build(Object.assign({}, base, o), NOW);

eq("relative times", [M.relative(0, NOW), M.relative(NOW - 4000, NOW), M.relative(NOW - 30000, NOW), M.relative(NOW - 5 * MIN, NOW), M.relative(NOW - 3 * 3600000, NOW), M.relative(NOW - 2 * 86400000, NOW)], ["never", "just now", "30 s ago", "5 min ago", "3 h ago", "2 d ago"]);
eq("in words", [M.inWords(900), M.inWords(45000), M.inWords(90000), M.inWords(2 * 3600000)], ["1 s", "45 s", "2 min", "2 h"]);
eq("host of a url, and of junk", [M.hostOf("https://tracker.example.com/x"), M.hostOf("junk")], ["tracker.example.com", "junk"]);

const un = m({ enrolled: false });
eq("not paired", [un.key, un.tone, un.title, un.canReconnect, un.live.available, un.pairing], ["unpaired", "idle", "Not connected", false, false, "Not paired"]);

const pend = m({ sync_status: "pending", confirm_code: "5841-BB6A" });
eq("waiting for approval says nothing is uploaded and shows the confirmation code", [pend.key, /Nothing is uploaded/.test(pend.sub), pend.rows.find(r => r[0] === "Confirm code")[1], pend.live.available], ["pending", true, "5841-BB6A", false]);

const ok = m({});
eq("healthy and live", [ok.key, ok.tone, ok.title, ok.sub, ok.error, ok.retry], ["live", "ok", "Connected", "Last sync 3 min ago.", "", ""]);
eq("healthy but polling", m({ rt_state: "offline" }).key, "connected");
eq("identity rows: device, server host, pairing, last sync, channel, short session", ok.rows, [["Device", "Studio laptop"], ["Server", "tracker.example.com"], ["Pairing", "Paired"], ["Last sync", "3 min ago"], ["Channel", "Live"], ["Session", "abcdef12"]]);
eq("never synced yet", [m({ sync_last_ok: 0 }).sub, m({ sync_last_ok: 0 }).rows.find(r => r[0] === "Last sync")[1]], ["Waiting for the first sync.", "Not yet"]);

const paused = m({ tracking_enabled: false });
eq("tracking paused outranks a healthy connection", [paused.key, paused.tone, paused.tracking], ["paused", "warn", false]);

const off = m({ sync_last_error: "TypeError: Failed to fetch", sync_last_error_kind: "network", sync_retry: { attempt: 2, at: NOW + 45000, kind: "network" }, queue: { sessions: 2, events: 30, dropped: 0, oldestAt: NOW - 10 * MIN } });
eq("offline: says saving locally, explains in plain words, shows the retry countdown and the queue", [off.key, off.tone, off.title, /internet connection/.test(off.error), off.retry, off.queue.text], ["offline", "warn", "Offline: saving on this device", true, "Retrying in 45 s.", "2 viewing updates and 30 events waiting to upload · oldest 10 min ago"]);
eq("the browser reporting no network is offline even before an error", m({ browserOnline: false }).key, "offline");
const srv = m({ sync_last_error: "push 503", sync_last_error_kind: "server", sync_retry: { attempt: 1, at: NOW + 3000, kind: "server" } });
eq("a server problem is a sync problem, not offline, and reassures", [srv.key, srv.tone, /saved on this device/.test(srv.sub), /try again automatically/.test(srv.error), srv.retry], ["error", "bad", true, true, "Retrying in 3 s."]);
eq("after the quick retries it says it will try again later", m({ sync_last_error: "x", sync_last_error_kind: "server", sync_retry: { attempt: 7, at: null, kind: "server" } }).retry, "Will try again automatically in a few minutes.");
t("raw error text never reaches the screen", !/push 503/.test(JSON.stringify(srv)));
eq("auth problems tell the person what to do", /Ask the owner/.test(m({ sync_last_error: "token 403", sync_last_error_kind: "auth" }).error), true);
eq("a pending device never shows an error or retry", [m({ sync_status: "pending", sync_last_error: "x" }).error, m({ sync_status: "pending", sync_retry: { attempt: 1, at: NOW + 1000 } }).retry], ["", ""]);

eq("queue figures and limit", [ok.queue.text, ok.queue.limit, ok.queue.waiting, ok.queue.warn], ["Nothing waiting", 20000, false, false]);
const dropped = m({ queue: { sessions: 0, events: 8, dropped: 3 } });
eq("dropped events are flagged", [dropped.queue.warn, /3 events kept on this device only/.test(dropped.queue.text)], [true, true]);

eq("live viewing: off by default, available when paired and approved", [ok.live.available, ok.live.on, ok.live.indicator], [true, false, "Live viewing is off"]);
const on = m({ live_view: true });
eq("live viewing ON is announced with the server's name", [on.live.on, on.live.indicator, /tracker\.example\.com can see which video is playing/.test(on.live.detail) || /owner of tracker\.example\.com can see/.test(on.live.detail), /Turn it off any time/.test(on.live.detail)], [true, "Live viewing is ON", true, true]);
eq("only a real boolean true counts as on", [m({ live_view: "true" }).live.on, m({ live_view: 1 }).live.on], [false, false]);
eq("deletion request states", [m({ session_request: { status: "pending" } }).deletion, m({ session_request: { status: "denied" } }).deletion, ok.deletion], ["waiting", "denied", ""]);
eq("reconnect is offered whenever the device is paired", [ok.canReconnect, off.canReconnect, pend.canReconnect], [true, true, true]);

console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
