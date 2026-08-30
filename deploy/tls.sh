#!/usr/bin/env bash
#
# Alan adı ve TLS sertifikası.
#
# HTTP ÜZERİNDEN ÇALIŞTIRMAYIN: oturum çerezi ve model cevapları düz
# metin gider. Let's Encrypt ücretsizdir ve kurulumu tek komuttur;
# bunu atlamak için hiçbir gerekçe yok.

set -euo pipefail

DOMAIN="${1:?Kullanım: ./deploy/tls.sh alanadi.com [eposta]}"
EMAIL="${2:-admin@${DOMAIN}}"
HOST="${KAELON_HOST:?KAELON_HOST tanımlı değil}"
SSH_KEY="${KAELON_SSH_KEY:-$HOME/.ssh/kaelon_deploy}"
SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new root@${HOST}"

$SSH bash -s "$DOMAIN" "$EMAIL" <<'REMOTE'
set -euo pipefail
DOMAIN="$1"; EMAIL="$2"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq certbot python3-certbot-nginx

sed "s/SUNUCU_ADI/${DOMAIN}/" /opt/kaelon/deploy/nginx.conf > /etc/nginx/sites-available/kaelon
ln -sf /etc/nginx/sites-available/kaelon /etc/nginx/sites-enabled/kaelon
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect

systemctl reload nginx
echo "TLS kuruldu: https://${DOMAIN}"
REMOTE
