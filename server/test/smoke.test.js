// The release smoke test (scripts/smoke-test.mjs) run against a disposable in-process server over real HTTP. This is the same
// script the installer uses for its final verification, so a green run here means the installer's checks work.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeApp, addOwner, PW, OWNER } from "./helpers.js";

const run = promisify(execFile), ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let ctx, url;
before(async () => {
  ctx = await makeApp(); await addOwner(ctx.db);
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  url = "http://127.0.0.1:" + ctx.app.server.address().port;
  process.env.BASE_URL = url; // the server compares a request's Origin with BASE_URL; in production they are the same https address
});
after(async () => { await ctx.app.close(); });
const smoke = (extra = [], env = {}) => run(process.execPath, [path.join(ROOT, "scripts", "smoke-test.mjs"), "--url", url, "--quiet", ...extra],
  { env: { ...process.env, WL_ADMIN_EMAIL: OWNER, WL_ADMIN_PASSWORD: PW, ...env }, timeout: 60000 }).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test("production-safe checks pass and leave no pairing code behind", async () => {
  const r = await smoke();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM enroll_codes WHERE revoked_at IS NULL AND used_at IS NULL").get().n, 0, "the test pairing code was cancelled");
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM devices").get().n, 0, "nothing was paired");
});

test("--full: pairs a simulated device, uploads ten pause/resume cycles, checks Video Details and exports, then cleans up", async () => {
  const r = await smoke(["--full"]);
  assert.equal(r.code, 0, r.stderr);
  for (const t of ["devices", "video_playback_events", "video_sessions", "video_pause_intervals", "sessions", "videos"]) assert.equal(ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t + " is empty again");
});

test("a wrong password is reported as a failed check and a non-zero exit code", async () => {
  const r = await smoke([], { WL_ADMIN_PASSWORD: "definitely not the password" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /administrator login succeeds/);
});

test("missing credentials and a missing URL are usage errors (exit 2), and no password is accepted on the command line", async () => {
  assert.equal((await smoke([], { WL_ADMIN_EMAIL: "", WL_ADMIN_PASSWORD: "" })).code, 2);
  const bare = await run(process.execPath, [path.join(ROOT, "scripts", "smoke-test.mjs")]).then(() => 0, e => e.code);
  assert.equal(bare, 2);
});
