# Watch Ledger: nginx, stage 2 (rendered by scripts/install.sh once the certificate exists).
# nginx terminates TLS and forwards to the app on loopback. The app is told the real client address through X-Forwarded-For,
# which is OVERWRITTEN here (never appended), so a visitor cannot forge it to dodge the login and pairing rate limits.

map $http_upgrade $wl_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name @DOMAIN@;

    location ^~ /.well-known/acme-challenge/ {
        root @WEBROOT@;
        default_type "text/plain";
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name @DOMAIN@;

    ssl_certificate     /etc/letsencrypt/live/@DOMAIN@/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/@DOMAIN@/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:WLSSL:10m;
    ssl_session_tickets off;

    # The app sends its own security headers (HSTS, CSP, ...); nginx adds none, so they are never duplicated.
    client_max_body_size 3m;
    server_tokens off;

    # Live dashboard updates (Server-Sent Events): do not buffer, allow a long-lived connection.
    location = /api/events {
        proxy_pass http://127.0.0.1:@PORT@;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    # The extension's real-time channel (WebSocket).
    location = /api/device/ws {
        proxy_pass http://127.0.0.1:@PORT@;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $wl_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:@PORT@;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
