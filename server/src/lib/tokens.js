// Short-lived signed access tokens (owner and device) and cookie options.
// Owner and device tokens are domain-separated ("adm:" / "dev:" signing prefixes) so one can never be replayed as the other.
import { hmac, safeEqual } from "./crypto.js";

export function cookieOpts(ttlSeconds) {
  return { httpOnly: true, secure: true, sameSite: "strict", signed: true, path: "/", maxAge: Number(ttlSeconds) };
}

function sign(prefix, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + hmac(prefix + body);
}
function verifyPayload(prefix, token, now) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !safeEqual(sig, hmac(prefix + body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && p.exp > now ? p : null;
  } catch { return null; }
}
function verify(prefix, token, field, now) {
  const p = verifyPayload(prefix, token, now);
  return p && typeof p[field] === "string" ? p[field] : null;
}

// Owner access token (15 min by default).
export function signAccess(adminId, now = Date.now()) {
  return sign("adm:", { aid: adminId, exp: now + Number(process.env.ACCESS_TTL || 900) * 1000 });
}
export function verifyAccess(token, now = Date.now()) { return verify("adm:", token, "aid", now); }

// Device access token: obtained by exchanging the device's refresh credential (its session); valid for a few minutes only.
// It names both the device and the session, so revoking one session cuts off exactly that session.
export const deviceAccessTtl = () => Number(process.env.DEVICE_ACCESS_TTL || 900);
export function signDeviceAccess(deviceId, sessionId, now = Date.now()) {
  return sign("dev:", { did: deviceId, sid: sessionId, exp: now + deviceAccessTtl() * 1000 });
}
export function verifyDeviceAccess(token, now = Date.now()) { return verify("dev:", token, "did", now); }
// { deviceId, sessionId } or null. Tokens minted before device sessions existed carry no sid and are refused (the device refreshes).
export function verifyDeviceSession(token, now = Date.now()) {
  const p = verifyPayload("dev:", token, now);
  return p && typeof p.did === "string" && typeof p.sid === "string" ? { deviceId: p.did, sessionId: p.sid } : null;
}
