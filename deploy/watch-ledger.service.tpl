# Watch Ledger: systemd unit (rendered by scripts/install.sh, which fills in the values written between @ signs).
# The service runs as an unprivileged system user, can write only to its own data directory, and cannot gain privileges.
[Unit]
Description=Watch Ledger (YouTube Watch Tracker server) - Powered by SciLink Project
Documentation=https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=@USER@
Group=@USER@
WorkingDirectory=@PREFIX@/current/server
# MASTER_KEY, COOKIE_SECRET and the other settings live here (mode 640, root:@USER@). They are never passed on a command line.
EnvironmentFile=@ETC@/watch-ledger.env
ExecStart=@NODE@ src/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077

# Hardening
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=@VAR@
ReadOnlyPaths=@PREFIX@ @ETC@

[Install]
WantedBy=multi-user.target
