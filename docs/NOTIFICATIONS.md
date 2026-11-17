# Notification Center

The **Notifications** page (owner only) lists things that need your attention. Notifications appear **in the dashboard only**, as a list and as a count on the sidebar. Nothing is emailed, pushed or sent to any other service.

## What can notify you

| Kind | When | Setting |
|---|---|---|
| A device is waiting for approval | a device paired with an approval-required code | on / off |
| A device has not been seen for a while | an approved device with a session has not contacted the server for N hours | on / off, hours (1 to 720, default 24) |
| A device could not queue all of its events | it stayed offline so long that its queue limit was reached | on / off |
| A device reports a sync error | its last upload failed with an error | on / off |
| No backup, or the newest one is old | none exists, or older than the backup interval plus two hours | on / off |
| Disk or database problems | under 10% (warning) or 5% (urgent) of the disk free, or the database does not answer | on / off |
| Failed sign-ins, wrong pairing codes, a copied token | N or more in 24 hours (default 5); a sign-in token used twice in 7 days | on / off, attempts (1 to 100) |
| A device asked for its session to be deleted | a request is waiting under Devices | on / off |

There is also a master switch and the number of days resolved notifications are kept (7 to 365, default 90). Settings are validated by the server, saved in the database and every change is written to the audit log.

## How it behaves

- **Once per problem.** A condition creates one notification while it lasts, however often the server checks. When it ends (a device is approved, a backup is made) the notification is marked *resolved* and moves to **History**. If the problem comes back it is a new notification.
- **Dismiss** hides a notification and it stays hidden while the same problem continues; it does not reappear on the next check. **Mark read** only removes the "new" marker.
- **Switching a kind off** resolves its open notifications; changing a threshold applies at once.
- **Freshness.** The server checks when the page or the sidebar asks, at most every 30 seconds; the sidebar asks once a minute while the dashboard is open and the tab is visible. There is no background timer to keep alive.
- **Privacy.** A notification contains counts, device names you chose and the device's own sync error text (shortened to 280 characters). Never a token, key, password or hash.

## API (owner session required)

`GET /api/notifications?status=active|all|resolved&kind=&limit=&before=`, `GET /api/notifications/summary`, `POST /api/notifications/:id/read`, `/dismiss`, `POST /api/notifications/read-all`, `POST /api/notifications/evaluate`, `GET|PUT /api/notifications/preferences`. Migration `008_notifications.sql` adds one table and changes nothing existing.
