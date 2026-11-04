// Regression (BUG_FIX_REPORT A7): when the 15-minute access cookie expires, a page that reads several endpoints at once gets several
// 401s. Each used to call /api/auth/refresh with the SAME refresh cookie; the server rotates on the first and treats the second as a
// replayed (leaked) token, revoking every session, so the owner was signed out. The browser side must share one refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApp, addOwner, cookieNamed, OWNER, PW } from "./helpers.js";

globalThis.window = {}; vm.runInThisContext(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "session.js"), "utf8"), { filename: "session.js" });
const S = globalThis.window.WLSession; delete globalThis.window;

test("simultaneous callers share one refresh request", async () => {
  let calls = 0;
  const refresh = S.createRefresher(async () => { calls++; await new Promise(r => setTimeout(r, 20)); return true; });
  const results = await Promise.all([refresh(), refresh(), refresh(), refresh()]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [true, true, true, true]);
});

test("a refresh that starts after the previous one finished is a new request", async () => {
  let calls = 0;
  const refresh = S.createRefresher(async () => { calls++; return true; });
  await refresh(); await refresh();
  assert.equal(calls, 2);
});

test("a failed refresh is shared, reports false, and does not stick", async () => {
  let calls = 0, ok = false;
  const refresh = S.createRefresher(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return ok; });
  assert.deepEqual(await Promise.all([refresh(), refresh()]), [false, false]);
  assert.equal(calls, 1);
  ok = true; assert.equal(await refresh(), true);
});

test("a network error counts as a failed refresh and does not stick", async () => {
  let n = 0;
  const refresh = S.createRefresher(async () => { if (n++ === 0) throw new Error("offline"); return true; });
  assert.equal(await refresh(), false);
  assert.equal(await refresh(), true);
});

test("server contract this guards: a replayed refresh cookie signs the owner out everywhere", async () => {
  const { app, db } = await makeApp(); await addOwner(db);
  const l = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER, password: PW } });
  const rt = cookieNamed(l, "rt"), h = { cookie: "rt=" + encodeURIComponent(rt.value) };
  const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/auth/refresh", headers: h })));
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 401]);
  const fresh = [a, b].find(x => x.statusCode === 200);
  const next = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: "rt=" + encodeURIComponent(cookieNamed(fresh, "rt").value) } });
  assert.equal(next.statusCode, 401, "the freshly issued token was revoked too");
});
