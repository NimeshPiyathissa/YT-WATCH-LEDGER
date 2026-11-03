# Device pairing

Pairing links one browser to your server. It is deliberate and visible on both ends.

1. **Dashboard → Devices → name the device → Generate pairing code.** A code like `K7Q2-M9XD` appears (single use, expires in 15 minutes, stored hashed). Tick *Require my approval* if you want to approve the device yourself.
2. **On the browser:** click the extension icon → enter your server address (skipped if the ZIP was built for your domain) and the code → **Connect** → accept Chrome's permission prompt for that one address.
3. The popup shows **Connected Successfully** and the dashboard shows the device **Online**. With *Require my approval* the popup shows **Waiting for approval** and a confirmation code; check it matches the device card, then **Approve device**. Nothing is uploaded until then.

## Safeguards

- Five wrong codes lock the sender's address out for 15 minutes.
- Each pairing is its own **session**; revoke one without affecting the others. Revoking takes effect on the device's very next request.
- The person at the device always sees the connection in the popup and can pause tracking; they cannot end the session themselves, only **request** deletion, which you approve or deny.
- Only one owner exists; there is no sign-up page.

## Remove a device

Devices → **Revoke access** (cuts it off, keeps its data) or **Remove device** (also deletes its synced data).

Troubleshooting: [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Full behaviour: [ADMIN_DASHBOARD.md](ADMIN_DASHBOARD.md).
