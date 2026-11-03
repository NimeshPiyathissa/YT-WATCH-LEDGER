// Small shared helpers for route modules.
import { uuid, sha256 } from "./crypto.js";

export function audit(db, adminId, deviceId, action, ip, detail = null) {
  db.prepare("INSERT INTO audit_log(id,admin_id,device_id,action,detail,ip,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(uuid(), adminId, deviceId, action, detail == null ? null : JSON.stringify(detail), ip || null, Date.now());
}

export function counts(db, deviceId) {
  return {
    videos: db.prepare("SELECT COUNT(*) n FROM videos WHERE device_id=?").get(deviceId).n,
    sessions: db.prepare("SELECT COUNT(*) n FROM sessions WHERE device_id=?").get(deviceId).n
  };
}

// Loads device :id and enforces ownership: 404 if missing, 403 if it belongs to another admin.
// (There is only ever one owner now; the check stays as defence in depth.)
export function ownDevice(db, req, reply, fn) {
  const d = db.prepare("SELECT * FROM devices WHERE id=?").get(req.params.id);
  if (!d) return reply.code(404).send({ error: "not_found" });
  if (d.admin_id !== req.admin.id) return reply.code(403).send({ error: "forbidden" });
  return fn(d);
}

// Pairing codes are hashed without separators or case, so "abcd-efgh", "ABCD EFGH" and "ABCDEFGH" are the same code.
export function normalizePairingCode(code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length >= 6 && c.length <= 32 ? c : null;
}

// A short code both the device and the owner's dashboard show, derived from the device id, so the owner can
// confirm the device in front of them is the one asking for approval.
export function confirmCodeFor(device) {
  const h = sha256(device.id + ":" + (device.install_id || "")).slice(0, 8).toUpperCase();
  return h.slice(0, 4) + "-" + h.slice(4);
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
// Only canonical YouTube links are stored (and later rendered as links), so a hostile value can't smuggle in a javascript: URL.
const ytUrl = v => (typeof v === "string" && /^https:\/\/www\.youtube\.com\/(watch\?v=|shorts\/)[\w-]{1,32}$/.test(v) ? v : "");

// A channel link is stored only in one of YouTube's own shapes (/@handle, /channel/UC..., /c/name, /user/name).
const ytChannelUrl = v => (typeof v === "string" && /^https:\/\/www\.youtube\.com\/(@[\w.\-%]{1,100}|channel\/UC[\w-]{22}|c\/[\w.\-%]{1,100}|user\/[\w.\-%]{1,100})$/.test(v) ? v : "");

// Whitelist + bound a session sent by a device; returns null if unusable.
export function cleanSession(s) {
  if (!s || typeof s.sessionId !== "string" || !/^[\w-]{1,64}$/.test(s.sessionId)) return null;
  if (typeof s.videoId !== "string" || !/^[\w-]{1,32}$/.test(s.videoId)) return null;
  return {
    sessionId: s.sessionId, videoId: s.videoId, kind: s.kind === "shorts" ? "shorts" : "watch", url: ytUrl(s.url),
    title: str(s.title, 300), channel: str(s.channel, 200),
    startTs: num(s.startTs), endTs: s.endTs ? num(s.endTs) : null,
    watchedMs: num(s.watchedMs), duration: num(s.duration),
    channelUrl: ytChannelUrl(s.channelUrl), channelId: typeof s.channelId === "string" && /^UC[\w-]{22}$/.test(s.channelId) ? s.channelId : "",
    startSec: s.startSec == null ? null : num(s.startSec), positionSec: num(s.positionSec), furthestSec: num(s.furthestSec),
    seeks: num(s.seeks), rewinds: num(s.rewinds), pauses: num(s.pauses), completed: s.completed === true,
    rev: num(s.rev), updatedAt: num(s.updatedAt) || Date.now()
  };
}

export const COMMANDS = ["pause_tracking", "resume_tracking", "set_retention", "delete_all", "delete_range"];
// Returns a cleaned payload object, or null if the command/payload is invalid.
export function cleanCommand(type, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (!COMMANDS.includes(type)) return null;
  if (type === "set_retention") {
    const d = Number(p.days);
    return Number.isInteger(d) && d >= 0 && d <= 3650 ? { days: d } : null;
  }
  if (type === "delete_range") {
    const from = Number(p.from), to = Number(p.to);
    return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from <= to ? { from, to } : null;
  }
  return {};
}
