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
function verify(prefix, token, field, now) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !safeEqual(sig, hmac(prefix + body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && typeof p[field] === "string" && p.exp > now ? p[field] : null;
  } catch { return null; }
}

// Owner access token (15 min by default).
export function signAccess(adminId, now = Date.now()) {
  return sign("adm:", { aid: adminId, exp: now + Number(process.env.ACCESS_TTL || 900) * 1000 });
}
export function verifyAccess(token, now = Date.now()) { return verify("adm:", token, "aid", now); }

// Device access token: obtained by exchanging the device's refresh credential; valid for a few minutes only.
export const deviceAccessTtl = () => Number(process.env.DEVICE_ACCESS_TTL || 900);
export function signDeviceAccess(deviceId, now = Date.now()) {
  return sign("dev:", { did: deviceId, exp: now + deviceAccessTtl() * 1000 });
}
export function verifyDeviceAccess(token, now = Date.now()) { return verify("dev:", token, "did", now); }
