# Installation overview

Watch Ledger has two parts: a **server** you run (dashboard + API + encrypted database) and a **Chrome extension** on each browser you want recorded. Pick the path that fits you.

| I want to… | Use | Time |
|---|---|---|
| Run it for real on an Ubuntu VPS with my own domain and HTTPS | **[VPS deployment](VPS_DEPLOYMENT.md)** (guided installer `scripts/install.sh`) | ~15 min |
| Understand what the installer does, or deploy by hand (Caddy, other OS) | [Manual deployment](DEPLOYMENT.md) | ~45 min |
| Try it on my own computer first | [`DEMO.md`](DEMO.md) (throwaway local server) or [`server/README-server.md`](../server/README-server.md) | ~10 min |
| Put the extension in a browser | [Extension setup](EXTENSION_SETUP.md) | ~5 min |
| Connect a browser to the server | [Device pairing](DEVICE_PAIRING.md) | ~2 min |

Before you start, read the ground rules in the [README](../README.md#responsible-use): use it only on devices you own, or with the informed agreement of everyone it records.

## What you need for the VPS path

- An **Ubuntu 22.04 or 24.04 LTS** server with a public IPv4 address, root (sudo) access, and about 1 GB RAM / 5 GB disk. Any provider works.
- A **domain or subdomain** you control (for example `tracker.example.com`). Beginner walkthrough: [Domain setup](DOMAIN_SETUP.md).
- A real email address (Let's Encrypt sends certificate-expiry notices there) and a **strong admin password**.

## After installing

1. Open `https://your.domain` and sign in with the admin account you chose.
2. Install the extension ([Extension setup](EXTENSION_SETUP.md)) and pair it ([Device pairing](DEVICE_PAIRING.md)).
3. Make a first backup and **store `MASTER_KEY` somewhere safe** ([Backup & recovery](BACKUP_RECOVERY.md)).
4. Skim the [security checklist](../SECURITY.md).

Problems? [Troubleshooting](TROUBLESHOOTING.md).
