# Security Center

The **Security** page of the dashboard (owner only) shows what to review, where you are signed in, and lets you change your password. The full history is in the **Audit log**.

## What it shows

- **What to review**, in plain words: devices waiting for approval, a sign-in token that was used twice, five or more failed sign-ins or wrong pairing codes in 24 hours, pairing codes still valid, devices not seen for 30 days, and `TRUST_PROXY` not set on an HTTPS server.
- **Where you are signed in**: every browser that can still renew its sign-in, with the one you are using marked. **Sign out everywhere else** keeps this browser; **Sign out everywhere** ends all of them.
- **Change password**: needs your current password, 12 to 256 characters, and signs out every other browser. A browser that was signed out and tries again is simply refused; it is not treated as theft and does not end your current session.

## Things to know

- Pages already open in another browser keep working for up to the access-cookie lifetime (15 minutes by default) after you sign it out, because the short-lived cookie is not stored on the server. Its next renewal is refused.
- Failed sign-ins are written to the audit log as `login_failed` (never with the password). Owner password changes appear as `password_changed`; the command-line reset signs everything out but is not audited, because it runs outside the server.
- The audit log is kept for a year and capped at 100,000 rows, newest kept, because anyone on the internet can add a row by trying a wrong pairing code. The Audit log API accepts `?action=`, `?before=` and `?limit=` (at most 500), so a flood of one kind cannot hide the rest.
- Device permissions are not changed from here. Live viewing is switched only on the device (see [LIVE_MONITORING.md](LIVE_MONITORING.md)); the owner can see it and can revoke a device at any time.
