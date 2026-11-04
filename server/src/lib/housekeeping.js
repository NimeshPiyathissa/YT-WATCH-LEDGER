// The hourly clean-up, in one place so the server and the tests run the same thing and every limit comes from the owner's settings.
import { purgeAll, expirePending, purgeHousekeeping } from "./retention.js";
import { pruneAudit, purgeExpiredTokens } from "./security.js";
import { pruneNotifications, getPrefs } from "./notifications.js";
import { readSettings } from "./settings.js";

export function runHousekeeping(db, { now = Date.now() } = {}) {
  const { values } = readSettings(db);
  const auditDays = values.audit_retention_days;
  purgeAll(db, now); expirePending(db, now);
  purgeHousekeeping(db, now, auditDays);          // also trims pairing history; takes the audit window from the setting instead of a fixed year
  pruneAudit(db, { days: auditDays, now });       // and caps the audit log's size
  purgeExpiredTokens(db, now);
  pruneNotifications(db, { days: getPrefs(db).retentionDays, now });
}
