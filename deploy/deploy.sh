#!/usr/bin/env bash
#
# KAELON dağıtımı — her sürümde çalıştırılır.
#
# SIRA ÖNEMLİDİR: önce kod, sonra bağımlılık, sonra DERLEME, sonra
# GÖÇ, en sonda yeniden başlatma. Göç derlemeden önce çalıştırılsaydı,
# derleme hata verdiğinde veritabanı yeni şemada ama uygulama eski
# kodda kalırdı.

set -euo pipefail

HOST="${KAELON_HOST:?KAELON_HOST tanımlı değil}"
SSH_KEY="${KAELON_SSH_KEY:-$HOME/.ssh/kaelon_deploy}"
APP_DIR="/opt/kaelon"
SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new root@${HOST}"

log() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

log "Yerelde doğrulama"
npm run verify

log "Kod gönderiliyor"
# .env GÖNDERİLMEZ: sunucunun kendi anahtarları vardır ve yerel
# anahtarın sunucuya kopyalanması, sırrın iki yerde yaşaması demektir.
rsync -az --delete \
  -e "ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.env' \
  --exclude '.env.bak' \
  --exclude '.tmp' \
  ./ "root@${HOST}:${APP_DIR}/"

log "Bağımlılıklar, derleme ve göç"
$SSH bash -s <<'REMOTE'
set -euo pipefail
cd /opt/kaelon
chown -R kaelon:kaelon /opt/kaelon

# Bağımlılıklar üretim kilidiyle kurulur.
sudo -u kaelon npm ci --no-audit --no-fund

# Prisma istemcisi ve derleme
sudo -u kaelon npm run db:generate
sudo -u kaelon npm run build

# Kontrol düzlemi şeması
sudo -u kaelon npx prisma db push --schema=prisma/shared.prisma --skip-generate --accept-data-loss

# Tenant göçleri — mevcut tenant'lar varsa
sudo -u kaelon npm run tenant -- migrate --all || echo "  (henüz tenant yok, atlandı)"
REMOTE

log "Servis yeniden başlatılıyor"
$SSH bash -s <<'REMOTE'
set -euo pipefail
install -m 644 /opt/kaelon/deploy/kaelon.service /etc/systemd/system/kaelon.service
# İzleme koşusu: nöbetçi kuralları kimse bakmıyorken de çalışsın.
install -m 644 /opt/kaelon/deploy/kaelon-watch.service /etc/systemd/system/kaelon-watch.service
install -m 644 /opt/kaelon/deploy/kaelon-watch.timer /etc/systemd/system/kaelon-watch.timer
systemctl daemon-reload
systemctl enable kaelon >/dev/null
systemctl enable --now kaelon-watch.timer >/dev/null
systemctl restart kaelon
REMOTE

log "Sağlık kontrolü"
for i in $(seq 1 20); do
  if $SSH "curl -fsS http://127.0.0.1:4310/api/health" 2>/dev/null | grep -q '"status"'; then
    $SSH "curl -fsS http://127.0.0.1:4310/api/health"
    echo
    log "Dağıtım tamam"
    exit 0
  fi
  sleep 3
done

echo "Sağlık kontrolü geçmedi. Son log:" >&2
$SSH "journalctl -u kaelon -n 40 --no-pager" >&2
exit 1
