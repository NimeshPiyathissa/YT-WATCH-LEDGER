// Real-time fan-out, in process (the server is single-node, like its SQLite database).
// The owner's dashboard listens over Server-Sent Events; devices listen over a WebSocket opened by the extension's
// service worker. Events are hints that something changed: listeners re-read the API, so a missed event costs a little
// latency (the polling fallback catches up), never correctness.
//
// Owner events: device_connected, device_disconnected, device_presence, pairing_completed, device_updated,
//               session_deletion_requested, session_request_approved, session_request_denied, session_revoked
// Device events: device_status, session_request, session_revoked, commands
export function createHub() {
  const admins = new Map();  // adminId  -> Set<fn(type, data)>
  const devices = new Map(); // deviceId -> Set<{ sessionId, send(type, data), close(code, reason) }>

  const add = (map, key, v) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(v); };
  const del = (map, key, v) => { const s = map.get(key); if (s) { s.delete(v); if (!s.size) map.delete(key); } };
  const safe = fn => { try { fn(); } catch { /* a broken listener never breaks the request that emitted */ } };

  return {
    subscribeAdmin(adminId, fn) { add(admins, adminId, fn); return () => del(admins, adminId, fn); },
    toAdmin(adminId, type, data = {}) {
      for (const fn of admins.get(adminId) || []) safe(() => fn(type, { ...data, at: Date.now() }));
    },

    // conn: { sessionId, send(type, data), close(code, reason) }
    subscribeDevice(deviceId, conn) { add(devices, deviceId, conn); return () => del(devices, deviceId, conn); },
    toDevice(deviceId, type, data = {}, { sessionId } = {}) {
      for (const c of devices.get(deviceId) || []) if (!sessionId || c.sessionId === sessionId) safe(() => c.send(type, { ...data, at: Date.now() }));
    },
    // Drops live connections of one session (or of every session of a device) after the device has been told why.
    disconnect(deviceId, { sessionId, code = 4001, reason = "revoked" } = {}) {
      for (const c of [...(devices.get(deviceId) || [])]) if (!sessionId || c.sessionId === sessionId) safe(() => c.close(code, reason));
    },
    isOnline: deviceId => devices.has(deviceId),
    liveSessions: deviceId => new Set([...(devices.get(deviceId) || [])].map(c => c.sessionId)),
    stats: () => ({ adminListeners: [...admins.values()].reduce((n, s) => n + s.size, 0), deviceSockets: [...devices.values()].reduce((n, s) => n + s.size, 0) })
  };
}
