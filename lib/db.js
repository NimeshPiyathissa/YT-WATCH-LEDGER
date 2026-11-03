/* lib/db.js — IndexedDB wrapper (self.YTDB). DB "yt_watch_tracker", version 4.
   Stores: videos (key videoId), sessions (key sessionId; indexes videoId, updatedAt),
           outbox (key sessionId): sessions waiting for the server to acknowledge them, {sessionId, rev, queuedAt},
           events (key id "<sessionId>:e<seq>"; indexes sessionId, videoId): playback events (v4),
           evoutbox (key id): events waiting for the server to acknowledge them, {id, sessionId, seq, queuedAt} (v4).
   A session snapshot is the sync event; its id is "<sessionId>:<rev>". The outbox row is written in the same
   transaction as the session, and removed only after the server acknowledges that revision or a newer one. */
(function (root) {
  "use strict";
  const DB_NAME = "yt_watch_tracker", DB_VERSION = 4;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // Additive upgrades only: every step is guarded so v1 -> v2 keeps existing data.
      req.onupgradeneeded = e => {
        const db = req.result;
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "sessionId" });
        if (!db.objectStoreNames.contains("videos")) db.createObjectStore("videos", { keyPath: "videoId" });
        // v4: playback events. Created next to the existing stores; nothing already stored is read or rewritten.
        if (!db.objectStoreNames.contains("evoutbox")) db.createObjectStore("evoutbox", { keyPath: "id" });
        if (!db.objectStoreNames.contains("events")) {
          const ev = db.createObjectStore("events", { keyPath: "id" });
          ev.createIndex("sessionId", "sessionId"); ev.createIndex("videoId", "videoId");
        }
        const sessions = db.objectStoreNames.contains("sessions")
          ? req.transaction.objectStore("sessions")
          : db.createObjectStore("sessions", { keyPath: "sessionId" });
        if (!sessions.indexNames.contains("videoId")) sessions.createIndex("videoId", "videoId");
        if (!sessions.indexNames.contains("updatedAt")) sessions.createIndex("updatedAt", "updatedAt");
        if (e.oldVersion > 0 && e.oldVersion < 2) {
          // v1 sessions have no updatedAt, so they'd be invisible to the sync index; stamp them.
          const cur = sessions.openCursor();
          cur.onsuccess = () => {
            const c = cur.result; if (!c) return;
            const s = c.value;
            if (!s.updatedAt) { s.updatedAt = s.endTs || s.startTs || Date.now(); c.update(s); }
            c.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function reqToPromise(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }
  function tx(stores, mode) {
    return open().then(db => db.transaction(stores, mode));
  }
  function txDone(t) {
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }

  const getAllVideos = () => tx("videos", "readonly").then(t => reqToPromise(t.objectStore("videos").getAll()));
  const getAllSessions = () => tx("sessions", "readonly").then(t => reqToPromise(t.objectStore("sessions").getAll()));
  const getSession = id => tx("sessions", "readonly").then(t => reqToPromise(t.objectStore("sessions").get(id)));
  const getSessionsByVideo = vid => tx("sessions", "readonly").then(t => reqToPromise(t.objectStore("sessions").index("videoId").getAll(vid)));
  // enqueue=true (device is enrolled) also queues the session for upload, atomically with the write.
  const putSession = (s, enqueue) => tx(["sessions", "outbox"], "readwrite").then(t => {
    t.objectStore("sessions").put(s);
    if (enqueue) t.objectStore("outbox").put({ sessionId: s.sessionId, rev: s.rev || 0, queuedAt: Date.now() });
    return txDone(t);
  });
  const putVideo = v => tx("videos", "readwrite").then(t => { t.objectStore("videos").put(v); return txDone(t); });

  // Deletes the video rollup and every session that belongs to it.
  function deleteVideo(videoId) {
    return tx(["videos", "sessions", "outbox", "events", "evoutbox"], "readwrite").then(t => {
      t.objectStore("videos").delete(videoId);
      const idx = t.objectStore("sessions").index("videoId");
      const cur = idx.openKeyCursor(IDBKeyRange.only(videoId));
      cur.onsuccess = () => { const c = cur.result; if (c) { t.objectStore("sessions").delete(c.primaryKey); t.objectStore("outbox").delete(c.primaryKey); c.continue(); } };
      const ec = t.objectStore("events").index("videoId").openKeyCursor(IDBKeyRange.only(videoId));
      ec.onsuccess = () => { const c = ec.result; if (c) { t.objectStore("events").delete(c.primaryKey); t.objectStore("evoutbox").delete(c.primaryKey); c.continue(); } };
      return txDone(t);
    });
  }
  // Removes sessions that started before `ts`; resolves to the affected videoIds.
  // protectIds (optional Set of sessionIds): sessions still waiting in the outbox are kept, so retention
  // never deletes data that hasn't been uploaded yet.
  function deleteSessionsBefore(ts, protectIds) {
    return getAllSessions().then(all => {
      const old = all.filter(s => (s.startTs || 0) < ts && !(protectIds && protectIds.has(s.sessionId)));
      if (!old.length) return [];
      return tx(["sessions", "outbox", "events", "evoutbox"], "readwrite").then(t => {
        old.forEach(s => {
          t.objectStore("sessions").delete(s.sessionId); t.objectStore("outbox").delete(s.sessionId);
          const ec = t.objectStore("events").index("sessionId").openKeyCursor(IDBKeyRange.only(s.sessionId));
          ec.onsuccess = () => { const c = ec.result; if (c) { t.objectStore("events").delete(c.primaryKey); t.objectStore("evoutbox").delete(c.primaryKey); c.continue(); } };
        });
        return txDone(t).then(() => Array.from(new Set(old.map(s => s.videoId))));
      });
    });
  }
  function clearAll() {
    return tx(["videos", "sessions", "outbox", "events", "evoutbox"], "readwrite").then(t => {
      for (const n of ["videos", "sessions", "outbox", "events", "evoutbox"]) t.objectStore(n).clear();
      return txDone(t);
    });
  }
  function counts() {
    return tx(["videos", "sessions"], "readonly").then(t => Promise.all([
      reqToPromise(t.objectStore("videos").count()), reqToPromise(t.objectStore("sessions").count())
    ])).then(r => ({ videos: r[0], sessions: r[1] }));
  }

  /* ---- outbox ---- */
  const outboxAll = () => tx("outbox", "readonly").then(t => reqToPromise(t.objectStore("outbox").getAll()))
    .then(rows => rows.sort((a, b) => a.queuedAt - b.queuedAt || (a.sessionId < b.sessionId ? -1 : 1)));
  const outboxCount = () => tx("outbox", "readonly").then(t => reqToPromise(t.objectStore("outbox").count()));
  // Queues the given sessions (all of them by default; used for "also upload history recorded before pairing").
  function outboxEnqueue(list) {
    return (list ? Promise.resolve(list) : getAllSessions()).then(all => tx("outbox", "readwrite").then(t => {
      const now = Date.now();
      all.forEach((s, i) => t.objectStore("outbox").put({ sessionId: s.sessionId, rev: s.rev || 0, queuedAt: now + i }));
      return txDone(t).then(() => all.length);
    }));
  }
  const outboxEnqueueAll = () => outboxEnqueue();
  // Server acknowledged these {sessionId, rev}. A row is removed only if it hasn't been re-queued at a newer
  // revision since the batch was built (compare-and-delete), so an update made mid-upload is never lost.
  function outboxAck(acks) {
    if (!acks.length) return Promise.resolve(0);
    return tx("outbox", "readwrite").then(t => {
      const st = t.objectStore("outbox"); let n = 0;
      acks.forEach(a => {
        const g = st.get(a.sessionId);
        g.onsuccess = () => { const row = g.result; if (row && (row.rev || 0) <= (a.rev || 0)) { st.delete(a.sessionId); n++; } };
      });
      return txDone(t).then(() => n);
    });
  }
  /* ---- playback events (v4) ---- */
  // Stores events and, when the device is paired (enqueue), queues them for upload in the same transaction. put() by id makes a
  // retried delivery from the content script a no-op.
  const putEvents = (list, enqueue) => tx(["events", "evoutbox"], "readwrite").then(t => {
    const now = Date.now();
    list.forEach(e => {
      t.objectStore("events").put(e);
      if (enqueue) t.objectStore("evoutbox").put({ id: e.id, sessionId: e.sessionId, seq: e.seq, queuedAt: now });
    });
    return txDone(t);
  });
  const getEventsBySession = sid => tx("events", "readonly").then(t => reqToPromise(t.objectStore("events").index("sessionId").getAll(sid)))
    .then(a => a.sort((x, y) => x.seq - y.seq));
  const getEventsByVideo = vid => tx("events", "readonly").then(t => reqToPromise(t.objectStore("events").index("videoId").getAll(vid)))
    .then(a => a.sort((x, y) => x.ts - y.ts || x.seq - y.seq));
  const eventCount = () => tx("events", "readonly").then(t => reqToPromise(t.objectStore("events").count()));
  // Oldest first, then per session in sequence order, so a session's events always leave in the order they happened.
  const evOutboxAll = () => tx("evoutbox", "readonly").then(t => reqToPromise(t.objectStore("evoutbox").getAll()))
    .then(rows => rows.sort((a, b) => a.queuedAt - b.queuedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.seq - b.seq)));
  const evOutboxCount = () => tx("evoutbox", "readonly").then(t => reqToPromise(t.objectStore("evoutbox").count()));
  const getEventsByIds = ids => tx("events", "readonly").then(t => Promise.all(ids.map(id => reqToPromise(t.objectStore("events").get(id)))));
  const evOutboxAck = ids => ids.length ? tx("evoutbox", "readwrite").then(t => { ids.forEach(id => t.objectStore("evoutbox").delete(id)); return txDone(t).then(() => ids.length); }) : Promise.resolve(0);
  const evOutboxClear = () => tx("evoutbox", "readwrite").then(t => { t.objectStore("evoutbox").clear(); return txDone(t); });
  // "Also upload history recorded before pairing": queue every stored event.
  const evOutboxEnqueueAll = () => tx(["events", "evoutbox"], "readwrite").then(t => {
    const now = Date.now(); let n = 0;
    const cur = t.objectStore("events").openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { const e = c.value; t.objectStore("evoutbox").put({ id: e.id, sessionId: e.sessionId, seq: e.seq, queuedAt: now }); n++; c.continue(); } };
    return txDone(t).then(() => n);
  });

  const outboxClear = () => tx("outbox", "readwrite").then(t => { t.objectStore("outbox").clear(); return txDone(t); });
  const getSessionsByIds = ids => tx("sessions", "readonly").then(t => Promise.all(ids.map(id => reqToPromise(t.objectStore("sessions").get(id)))));

  // Sessions changed after `ts`, via the v2 updatedAt index (scan fallback if it's missing).
  function getSessionsSince(ts) {
    return tx("sessions", "readonly").then(t => {
      const store = t.objectStore("sessions");
      if (store.indexNames.contains("updatedAt")) return reqToPromise(store.index("updatedAt").getAll(IDBKeyRange.lowerBound(ts, true)));
      return reqToPromise(store.getAll()).then(all => all.filter(s => (s.updatedAt || 0) > ts));
    });
  }
  function deleteByRange(fromTs, toTs) {
    return getAllVideos().then(vids => {
      const hit = vids.filter(v => (v.lastWatched || 0) >= fromTs && (v.lastWatched || 0) <= toTs);
      return Promise.all(hit.map(v => deleteVideo(v.videoId))).then(() => hit.length);
    });
  }
  function deleteByChannel(channel) {
    return getAllVideos().then(vids => {
      const hit = vids.filter(v => (v.channel || "") === channel);
      return Promise.all(hit.map(v => deleteVideo(v.videoId))).then(() => hit.length);
    });
  }

  root.YTDB = { getAllVideos, getAllSessions, getSession, getSessionsByVideo, putSession, putVideo, deleteVideo,
    deleteSessionsBefore, clearAll, counts, getSessionsSince, deleteByRange, deleteByChannel,
    outboxAll, outboxCount, outboxEnqueue, outboxEnqueueAll, outboxAck, outboxClear, getSessionsByIds,
    putEvents, getEventsBySession, getEventsByVideo, eventCount, evOutboxAll, evOutboxCount, getEventsByIds, evOutboxAck, evOutboxClear, evOutboxEnqueueAll };
})(typeof self !== "undefined" ? self : this);
