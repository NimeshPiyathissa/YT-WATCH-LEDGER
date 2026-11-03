import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, createCpuSampler } from "../src/lib/health.js";

const GB = 1024 ** 3;
const base = () => ({
  database: { ok: true }, disk: { totalBytes: 100 * GB, freeBytes: 50 * GB }, memory: { totalBytes: 8 * GB, freeBytes: 4 * GB },
  backups: { status: "ok" }, sync: { devicesWithErrors: 0 }
});

test("a healthy server has no warnings", () => assert.deepEqual(evaluate(base()), []));

test("each threshold raises exactly its own warning with the right level", () => {
  const w = (mut) => { const h = base(); mut(h); return evaluate(h); };
  assert.deepEqual(w(h => { h.database.ok = false; }).map(x => x.code + ":" + x.level), ["database:critical"]);
  assert.deepEqual(w(h => { h.disk.freeBytes = 8 * GB; }).map(x => x.code + ":" + x.level), ["disk_low:warn"], "8% free");
  assert.deepEqual(w(h => { h.disk.freeBytes = 3 * GB; }).map(x => x.code + ":" + x.level), ["disk_full:critical"], "3% free");
  assert.deepEqual(w(h => { h.disk.totalBytes = 10 * GB; h.disk.freeBytes = 0.4 * GB; }).map(x => x.code), ["disk_full"], "under 0.5 GB");
  assert.deepEqual(w(h => { h.memory.freeBytes = 0.3 * GB; }).map(x => x.code), ["memory_low"]);
  assert.deepEqual(w(h => { h.backups.status = "none"; }).map(x => x.code), ["backup_none"]);
  assert.deepEqual(w(h => { h.backups.status = "stale"; }).map(x => x.code), ["backup_stale"]);
  assert.deepEqual(w(h => { h.sync.devicesWithErrors = 2; }).map(x => x.code), ["sync_errors"]);
  assert.deepEqual(w(h => { h.disk = null; }), [], "a disk that cannot be read is not reported as full");
});

test("the CPU sampler reports use between two readings, clamps, and does not recompute within a second", () => {
  let now = 0, idle = 0, busy = 0;
  const cpus = () => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
  const s = createCpuSampler(cpus, () => now);
  now = 2000; busy = 500; idle = 500;           // half busy
  assert.equal(s.percent(), 50);
  now = 2300; busy = 1000;                       // within a second of the last reading: the old value is returned
  assert.equal(s.percent(), 50);
  now = 4000; busy = 2500; idle = 500;           // since the last full reading: 2000 busy, 0 idle
  assert.equal(s.percent(), 100);
});
