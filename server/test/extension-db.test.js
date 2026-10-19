// The extension's IndexedDB layer (lib/db.js) against fake-indexeddb: schema upgrade and the outbox's own rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "db.js"), "utf8");
const loadDb = indexedDB => { const sb = { indexedDB, IDBKeyRange }; sb.self = sb; vm.runInNewContext(SRC, sb); return sb.YTDB; };
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Builds the database exactly as extension v0.3 (IndexedDB version 2) left it on a user's machine.
async function v2Database(sessions) {
  const idb = new IDBFactory();
  const db = await new Promise((res, rej) => {
    const o = idb.open("yt_watch_tracker", 2);
    o.onupgradeneeded = () => {
      const d = o.result;
      d.createObjectStore("videos", { keyPath: "videoId" });
      const s = d.createObjectStore("sessions", { keyPath: "sessionId" });
      s.createIndex("videoId", "videoId"); s.createIndex("updatedAt", "updatedAt");
    };
    o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
  });
  const t = db.transaction(["sessions", "videos"], "readwrite");
  sessions.forEach(s => t.objectStore("sessions").put(s));
  t.objectStore("videos").put({ videoId: "v1", title: "Kept video", totalMs: 5000 });
  await new Promise(r => { t.oncomplete = r; });
  db.close();
  return idb;
}

test("upgrading an existing v2 database to v3 keeps every session and video, and starts with an empty outbox", async () => {
  const idb = await v2Database([
    { sessionId: "s1", videoId: "v1", startTs: 1000, watchedMs: 5000, updatedAt: 2000, rev: 4 },
    { sessionId: "s2", videoId: "v1", startTs: 3000, watchedMs: 9000, updatedAt: 4000, rev: 2 }
  ]);
  const DB = loadDb(idb);
  assert.deepEqual((await DB.getAllSessions()).map(s => s.sessionId).sort(), ["s1", "s2"]);
  assert.equal((await DB.getAllSessions()).find(s => s.sessionId === "s1").watchedMs, 5000);
  assert.equal((await DB.getAllVideos())[0].title, "Kept video");
  assert.equal(await DB.outboxCount(), 0, "nothing is queued for upload on an install that never paired");
  const db = await new Promise(r => { const o = idb.open("yt_watch_tracker"); o.onsuccess = () => r(o.result); });
  assert.equal(db.version, 3);
  assert.ok(db.objectStoreNames.contains("outbox"));
  db.close();
});

test("queued sessions are written atomically with the session, and survive reopening the database", async () => {
  const idb = new IDBFactory();
  const DB = loadDb(idb);
  await DB.putSession({ sessionId: "a", videoId: "v", startTs: 1, rev: 1, updatedAt: 1 }, true);
  await DB.putSession({ sessionId: "b", videoId: "v", startTs: 2, rev: 1, updatedAt: 2 }, false);   // not paired: not queued
  assert.deepEqual((await DB.outboxAll()).map(r => r.sessionId), ["a"]);
  const again = loadDb(idb);                                                                          // browser restart: new module instance, same storage
  assert.deepEqual((await again.outboxAll()).map(r => r.sessionId), ["a"]);
  await again.putSession({ sessionId: "a", videoId: "v", startTs: 1, rev: 5, updatedAt: 9 }, true);  // update coalesces into one row
  const rows = await again.outboxAll();
  assert.deepEqual(rows.map(r => [r.sessionId, r.rev]), [["a", 5]]);
});

test("deleting sessions also removes their queue rows, so nothing is uploaded for data that no longer exists", async () => {
  const DB = loadDb(new IDBFactory());
  for (const [id, vid] of [["a", "v1"], ["b", "v1"], ["c", "v2"]]) await DB.putSession({ sessionId: id, videoId: vid, startTs: 10, rev: 1, updatedAt: 1 }, true);
  await DB.deleteVideo("v1");
  assert.deepEqual((await DB.outboxAll()).map(r => r.sessionId), ["c"]);
  await DB.clearAll();
  assert.equal(await DB.outboxCount(), 0);
});

test("retention skips protected (still queued) sessions and removes their rows when it does delete", async () => {
  const DB = loadDb(new IDBFactory());
  await DB.putSession({ sessionId: "old-queued", videoId: "v", startTs: 5, rev: 1, updatedAt: 1 }, true);
  await DB.putSession({ sessionId: "old-sent", videoId: "v", startTs: 5, rev: 1, updatedAt: 1 }, false);
  const removed = await DB.deleteSessionsBefore(1000, new Set(["old-queued"]));
  assert.equal(removed.join(), "v");
  assert.deepEqual((await DB.getAllSessions()).map(s => s.sessionId), ["old-queued"]);
});

test("acknowledging removes a row only when the acknowledged revision covers it", async () => {
  const DB = loadDb(new IDBFactory());
  await DB.putSession({ sessionId: "x", videoId: "v", startTs: 1, rev: 3, updatedAt: 1 }, true);
  assert.equal(await DB.outboxAck([{ sessionId: "x", rev: 2 }]), 0);
  assert.equal(await DB.outboxCount(), 1);
  assert.equal(await DB.outboxAck([{ sessionId: "x", rev: 3 }, { sessionId: "nope", rev: 1 }]), 1);
  assert.equal(await DB.outboxCount(), 0);
});
