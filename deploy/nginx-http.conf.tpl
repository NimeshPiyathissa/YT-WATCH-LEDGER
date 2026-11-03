# Watch Ledger: nginx, stage 1 (rendered by scripts/install.sh). Plain HTTP only: it answers Let's Encrypt's challenge and
# otherwise redirects to HTTPS. Used until the certificate exists; stage 2 (nginx-https.conf.tpl) replaces it.
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
