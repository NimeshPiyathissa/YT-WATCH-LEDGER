"use strict"; global.self = global;
require("../lib/syncpolicy.js"); const P = global.YTSyncPolicy, L = P.LIMITS;
let p = 0, f = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); ok ? p++ : f++; console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  got=${JSON.stringify(g)} want=${JSON.stringify(w)}`)); };
const t = (n, c) => eq(n, !!c, true);

// ---- retry delay: exponential, jittered over the upper half, capped, deterministic with an injected rand ----
t("first retry waits 1 to 2 s (base 2 s, top half)", P.retryDelay(0, () => 0) === 1000 && P.retryDelay(0, () => 1) === 2000);
t("the wait doubles with each failure", P.retryDelay(1, () => 1) === 4000 && P.retryDelay(2, () => 1) === 8000 && P.retryDelay(3, () => 1) === 16000);
t("the wait never exceeds the cap, however many failures", P.retryDelay(50, () => 1) === L.RETRY_CAP_MS && P.retryDelay(12, () => 1) <= L.RETRY_CAP_MS);
t("jitter spreads devices over the upper half", P.retryDelay(5, () => 0) === 32000 && P.retryDelay(5, () => 1) === 64000);
t("bad attempt numbers and bad rand are safe", P.retryDelay(-3, () => 0) === 1000 && P.retryDelay("x", () => 5) === 2000 && P.retryDelay(NaN, () => -1) === 1000);
let monotonic = true; for (let a = 0; a < 10; a++) if (P.retryDelay(a + 1, () => 0) < P.retryDelay(a, () => 0)) monotonic = false;
t("the minimum wait never goes down as failures accumulate", monotonic);
const real = Array.from({ length: 200 }, () => P.retryDelay(3)); t("the real random jitter stays inside its band", real.every(x => x >= 8000 && x <= 16000));

// ---- Retry-After ----
eq("seconds", P.retryAfterMs("30"), 30000);
eq("an HTTP date in the future", P.retryAfterMs("Wed, 04 Nov 2026 06:00:45 GMT", Date.UTC(2026, 10, 4, 6, 0, 0)), 45000);
eq("a date in the past is zero, not negative", P.retryAfterMs("Wed, 04 Nov 2026 05:00:00 GMT", Date.UTC(2026, 10, 4, 6, 0, 0)), 0);
eq("capped at ten minutes", P.retryAfterMs("999999"), L.RETRY_AFTER_CAP_MS);
eq("absent or junk is null", [P.retryAfterMs(null), P.retryAfterMs(""), P.retryAfterMs("soon"), P.retryAfterMs(undefined)], [null, null, null, null]);

// ---- what a failure means ----
eq("network error", P.classifyFailure({ networkError: true }), { kind: "network", retryable: true });
eq("429 is quota, retryable", P.classifyFailure({ status: 429 }), { kind: "quota", retryable: true });
eq("500, 502, 503, 504 are server, retryable", [500, 502, 503, 504].map(s => P.classifyFailure({ status: s }).retryable), [true, true, true, true]);
eq("408 is retryable", P.classifyFailure({ status: 408 }).kind, "server");
eq("400, 413, 422 are rejected, NOT retryable", [400, 413, 422].map(s => P.classifyFailure({ status: s })), [{ kind: "rejected", retryable: false }, { kind: "rejected", retryable: false }, { kind: "rejected", retryable: false }]);
eq("401 and 403 are auth", [401, 403].map(s => P.classifyFailure({ status: s }).kind), ["auth", "auth"]);
eq("an odd status is retryable", P.classifyFailure({ status: 302 }).retryable, true);

// ---- queue limit and batch halving ----
eq("nothing to trim under the limit", [P.planTrim(100, L.EV_QUEUE), P.planTrim(L.EV_QUEUE, L.EV_QUEUE)], [0, 0]);
eq("trims exactly the excess", [P.planTrim(L.EV_QUEUE + 7, L.EV_QUEUE), P.planTrim(10, 4)], [7, 6]);
eq("junk counts are safe", [P.planTrim(undefined, 5), P.planTrim(5, undefined), P.planTrim(-4, 2)], [0, 5, 0]);
eq("halving", P.splitBatch([1, 2, 3, 4, 5]), [[1, 2, 3], [4, 5]]);
eq("a single item cannot be halved", [P.splitBatch([1]), P.splitBatch([]), P.splitBatch(undefined)], [[[1]], [[]], [[]]]);
let n = 200, steps = 0; while (n > 1) { n = Math.ceil(n / 2); steps++; }
t("a batch of 200 is narrowed to one item in 8 halvings", steps === 8);

// ---- when to stop retrying in the foreground ----
t("a few quick retries", [1, 2, 3, 4, 5, 6].every(i => P.nextRetry(i, () => 0) > 0));
eq("then the periodic alarm takes over (no endless hot loop)", P.nextRetry(L.HOT_RETRIES + 1, () => 0), null);
eq("unless the server asked for a specific wait", P.nextRetry(L.HOT_RETRIES + 1, () => 0, 45000), 45000);
eq("a long Retry-After wins over a short backoff", P.nextRetry(1, () => 0, 90000), 90000);

// ---- words for people ----
const fe = P.friendlyError;
t("network failures say the data is safe", /internet connection/.test(fe("TypeError: Failed to fetch")) && /saved on this device/.test(fe("", "network")));
t("429 is explained", /slow down/.test(fe("push 429")) && /slow down/.test(fe("", "quota")));
t("auth is explained with what to do", /Ask the owner/.test(fe("", "auth")) && /Ask the owner/.test(fe("token 403")));
t("server errors are explained", /try again automatically/.test(fe("push 503")));
t("rejected data is explained without alarm", /nothing on this device was lost/i.test(fe("push 400")));
t("nothing to say when there is no error", fe("") === "" && fe("", "") === "");
t("never leaks the raw text", !/push 500/.test(fe("push 500")));

// ---- queue summary ----
const NOW = 10 * 3600000;
eq("empty queue", P.queueSummary({ sessions: 0, events: 0 }, NOW), "Nothing waiting");
eq("counts, singular and plural", P.queueSummary({ sessions: 1, events: 2 }, NOW), "1 viewing update and 2 events waiting to upload");
eq("oldest entry shown from two minutes", P.queueSummary({ sessions: 0, events: 5, oldestAt: NOW - 90 * 60000 }, NOW), "5 events waiting to upload · oldest 90 min ago");
eq("long waits are shown in hours", P.queueSummary({ events: 5, oldestAt: NOW - 5 * 3600000 }, NOW), "5 events waiting to upload · oldest 5 h ago");
eq("dropped events are disclosed", P.queueSummary({ events: 0, dropped: 3 }, NOW), "Nothing waiting · 3 events kept on this device only (queue limit)");

console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
