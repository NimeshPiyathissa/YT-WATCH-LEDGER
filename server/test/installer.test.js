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
  assert.deepEqual(failed, [], failed.join("\n") + "\n" + r.stdout.split("\n").filter(l => l.startsWith("#   ")).join("\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Number(summary[1]) >= 90, "the suite ran its checks: " + summary[0]);
});
