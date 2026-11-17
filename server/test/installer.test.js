// Runs the installer / update / backup / restore / health-check test suite (scripts/tests/test-installer.sh) in a sandbox.
// It needs bash (Linux, macOS, or Git Bash on Windows) and is skipped with a clear message where bash is unavailable.
// What it covers and what it cannot (apt, systemd, nginx, certbot, ufw need a real Ubuntu VPS): see docs/VPS_DEPLOYMENT.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });

test("installer, update, backup, restore and health-check scripts (sandboxed, real database)", { skip: bash.status !== 0 ? "bash is not available" : false, timeout: 500000 }, () => {
  // about 90 s on its own; under the full suite's load (headless Chrome tests alongside) it has taken up to about 4 minutes
  const r = spawnSync("bash", ["scripts/tests/test-installer.sh"], { cwd: ROOT, encoding: "utf8", timeout: 480000, env: { ...process.env, WL_NODE: process.execPath } });
  const failed = (r.stdout.match(/^not ok .*$/gm) || []);
  const summary = (r.stdout.match(/^# (\d+) passed, (\d+) failed/m) || []);
  // Visible in every log (CI included): each update, rollback, release-switch (A29), history and packaging check with its result, so
  // a reader can see that the Linux-only runs really ran. Printed before any assertion, so it is there when something fails too.
  const lines = r.stdout.split("\n");
  const from = lines.findIndex(l => l.startsWith("# --- update.sh version and integrity rules"));
  const shown = lines.slice(Math.max(0, from)).filter(l => /^# ---/.test(l) || /^(not )?ok \d+ - /.test(l) || /^# SKIP/.test(l) || /^# \d+ passed/.test(l));
  console.log(["installer suite: update, rollback, release-switch and packaging checks (" + process.platform + ")", ...shown].join("\n"));
  const symlinkSkips = lines.filter(l => /# SKIP .*needs symbolic links/.test(l));
  console.log(`installer suite: ${lines.filter(l => /^ok \d+ - /.test(l) && !/# SKIP/.test(l)).length} passed, ${lines.filter(l => /# SKIP/.test(l)).length} skipped, ${failed.length} failed; release-switch runs skipped for lack of symbolic links: ${symlinkSkips.length}`);
  // On Linux the real release-switch runs must execute: a skip there would hide them, so it fails the test.
  if (process.platform === "linux") assert.deepEqual(symlinkSkips, [], "on Linux the release-switch runs must run, not be skipped");
  assert.deepEqual(failed, [], failed.join("\n") + "\n" + r.stdout.split("\n").filter(l => l.startsWith("#   ")).join("\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(summary[1]) >= 90, "the suite ran its checks: " + summary[0]);
});
