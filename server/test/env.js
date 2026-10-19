// Imported first by helpers.js so config is in place before any src/ module runs.
process.env.NODE_ENV = "test";
process.env.MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.COOKIE_SECRET = "test-cookie-secret-0123456789abcdef0123456789abcdef";
process.env.ACCESS_TTL = "900";
process.env.REFRESH_TTL = "2592000";
process.env.ALLOW_REGISTRATION = "false";
process.env.BASE_URL = "https://tracker.test";
process.env.CORS_ORIGIN = "https://tracker.test";
process.env.DEVICE_ACCESS_TTL = "900";
process.env.ENROLL_RATE_MAX = "1000"; // the end-to-end suite pairs many throwaway devices from one IP
