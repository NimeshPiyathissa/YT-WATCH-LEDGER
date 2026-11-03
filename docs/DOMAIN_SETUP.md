# Domain setup (beginner guide)

HTTPS needs a domain name that points at your server. You can use a whole domain (`example.com`) or, better, a subdomain (`tracker.example.com`) so your main site is unaffected.

## 1. Buy or choose a domain

Any registrar works (Namecheap, Cloudflare, Porkbun, and so on). A subdomain of a domain you already own costs nothing.

## 2. Find your server's public IP

On the VPS: `curl -4 ifconfig.me` (IPv4) and, if you have IPv6, `curl -6 ifconfig.me`. Your provider's control panel also shows it.

## 3. Add the DNS record

In your registrar's (or DNS provider's) DNS page:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| **A** | `tracker` (for `tracker.example.com`), or `@` for the bare domain | your server's IPv4 | 300 or "Auto" |
| **AAAA** *(only if the server has IPv6)* | same name | your server's IPv6 | 300 or "Auto" |

Rules of thumb:

- Use **A/AAAA**, not a CNAME, for the name the installer checks.
- **Cloudflare:** set the record to **DNS only** (grey cloud) until the certificate is issued. You can enable the proxy afterwards with SSL mode "Full (strict)".
- Remove old A/AAAA records for the same name that point elsewhere. A stale AAAA record is the most common reason certificates fail.

## 4. Wait for propagation

Usually 1–15 minutes, occasionally hours. Check from any computer:

```bash
nslookup tracker.example.com          # Windows / macOS / Linux
dig +short A tracker.example.com      # Linux / macOS
```

It must print your server's IP. Online checkers such as dnschecker.org show whether it has spread worldwide.

## 5. Run the installer

The installer re-checks the record itself before asking Let's Encrypt for a certificate. If the name does not resolve to this server it **stops with an explanation** (exit code 3) instead of failing halfway; fix DNS and run `sudo ./scripts/install.sh --resume`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "does not resolve" | The record is missing, misspelled, or not propagated yet. Wait and re-check with `nslookup`. |
| "resolves to a different address" | The record points elsewhere (old server, Cloudflare proxy, stale AAAA). Fix or delete it. |
| Resolves, but the certificate still fails | Port 80 is blocked: open it in your provider's firewall / security group (the installer opens it in `ufw`). |
| Works by IP but not by name | You typed the domain wrongly in the wizard; start again with the right name (the existing database and keys are kept). |
