# SSL / HTTPS

The dashboard **requires HTTPS** (its cookies are `Secure`, and the server refuses to start in production without TLS or a trusting proxy). The installer sets this up with nginx and a free Let's Encrypt certificate.

## How the installer does it

1. Starts nginx on port 80 with a small site that only serves the ACME challenge.
2. Verifies your domain's DNS (see [Domain setup](DOMAIN_SETUP.md)).
3. Runs `certbot certonly --webroot` for your domain.
4. Switches nginx to the HTTPS site: TLS 1.2/1.3, HTTP→HTTPS redirect, and pass-through for the dashboard's live updates (Server-Sent Events) and the extension's WebSocket.
5. Confirms the certbot renewal timer is active and runs `certbot renew --dry-run`.

The app itself listens only on `127.0.0.1:8787`; only nginx faces the internet.

## Renewal

Certificates last 90 days and renew automatically (certbot's systemd timer; nginx is reloaded by a deploy hook). Check any time:

```bash
sudo certbot certificates
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

Renewal needs port 80 open and the DNS record unchanged.

## Testing without burning rate limits

`sudo ./scripts/install.sh --staging-cert` issues an untrusted *staging* certificate (browsers will warn). Re-run without the flag for the real one.

## Problems

| Symptom | Fix |
|---|---|
| Certbot "unauthorized" / "connection refused" | Port 80 closed, or DNS not pointing here. |
| "too many certificates" | Let's Encrypt rate limit; wait, or use `--staging-cert` while testing. |
| Browser says "not secure" after install | The certificate was not issued; re-run `sudo ./scripts/install.sh --resume`. |
| Login works then fails with `bad_origin` | Open the dashboard at exactly the `BASE_URL` in the configuration (same scheme, host and port). |

Using Caddy or another proxy instead of nginx? See [manual deployment](DEPLOYMENT.md#6-https-with-caddy) and the [reverse-proxy notes](ADMIN_DASHBOARD.md#reverse-proxy-notes).
