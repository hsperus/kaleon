#!/usr/bin/env bash
#
# KAELON sunucu hazırlığı — TEK SEFER, ama TEKRAR ÇALIŞTIRILABİLİR.
#
# BU BETİK BOŞ SUNUCU VARSAYMAZ. Gerçek sunucularda zaten başka siteler,
# mail servisi ve veritabanları çalışır; "kur ve üzerine yaz" mantığıyla
# yazılmış bir kurulum betiği, çalışan bir mail sunucusunu kapatabilir ya
# da başka bir sitenin nginx yapılandırmasını silebilir. Buradaki her
# adım önce BAKAR, sonra gerekiyorsa yapar.
#
# ÜÇ ŞEYE ASLA DOKUNULMAZ:
#   - mevcut nginx siteleri ve sertifikaları
#   - güvenlik duvarı kuralları (mail portları buradan geçer)
#   - başka uygulamaların veritabanı ve kapsayıcıları
#
# KAELON kendi PostgreSQL kapsayıcısını, kendi biriminde, kendi portunda
# çalıştırır. Var olan bir veritabanını paylaşmak cazip ama tehlikelidir:
# o yığın `docker compose down -v` ile silindiğinde KAELON'un verisi de
# gider ve bunu silen kişi haberdar bile olmaz.

set -euo pipefail

APP_USER="kaelon"
APP_DIR="/opt/kaelon"
NODE_MAJOR="22"

DB_CONTAINER="kaelon-postgres"
DB_VOLUME="kaelon_pg_data"
DB_PORT="5433"
DB_NAME="kaelon"
DB_USER="kaelon"
PG_IMAGE="postgres:16-alpine"

log()  { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
skip() { printf '   \033[2m· %s\033[0m\n' "$1"; }
warn() { printf '   \033[33m! %s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "root olarak çalıştırılmalı." >&2; exit 1; }

# ─────────────────────────── Node ───────────────────────────
log "Node ${NODE_MAJOR}+"
if command -v node >/dev/null && [ "$(node -v | cut -d. -f1 | tr -d v)" -ge "$NODE_MAJOR" ]; then
  skip "zaten kurulu: $(node -v)"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
  echo "   kuruldu: $(node -v)"
fi

# ─────────────────────── Docker (varsa dokunma) ───────────────────────
log "Docker"
if command -v docker >/dev/null; then
  skip "zaten kurulu: $(docker --version | cut -d, -f1)"
else
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker
fi

# ─────────────────────── KAELON'a özel PostgreSQL ───────────────────────
log "KAELON PostgreSQL kapsayıcısı"
if docker ps -a --format '{{.Names}}' | grep -qx "${DB_CONTAINER}"; then
  skip "kapsayıcı zaten var"
  docker start "${DB_CONTAINER}" >/dev/null 2>&1 || true
  # Parola daha önce üretilmiş; .env'den okunur.
  if [ -f "${APP_DIR}/.env" ]; then
    DB_PASS="$(grep -oP 'postgresql://[^:]+:\K[^@]+' "${APP_DIR}/.env" | head -1)"
  fi
  : "${DB_PASS:?Kapsayıcı var ama .env okunamadı; parola bulunamıyor}"
else
  # PAROLA SUNUCUDA ÜRETİLİR VE EKRANA BASILMAZ. Betiğe gömülü bir
  # parola, betiği okuyan herkese verilmiş demektir.
  DB_PASS="$(openssl rand -hex 24)"
  docker volume create "${DB_VOLUME}" >/dev/null
  docker run -d \
    --name "${DB_CONTAINER}" \
    --restart unless-stopped \
    -e POSTGRES_USER="${DB_USER}" \
    -e POSTGRES_PASSWORD="${DB_PASS}" \
    -e POSTGRES_DB="${DB_NAME}" \
    -p "127.0.0.1:${DB_PORT}:5432" \
    -v "${DB_VOLUME}:/var/lib/postgresql/data" \
    "${PG_IMAGE}" >/dev/null
  echo "   kuruldu: ${DB_CONTAINER} → 127.0.0.1:${DB_PORT}"
fi

log "Veritabanı hazır mı"
for i in $(seq 1 30); do
  if docker exec "${DB_CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    echo "   hazır"
    break
  fi
  [ "$i" -eq 30 ] && { echo "   veritabanı açılmadı" >&2; exit 1; }
  sleep 2
done
# Şema başına tenant kullanılıyor; uuid üretimi için gerekli.
docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
  -qc "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

# ─────────────────────── Uygulama kullanıcısı ───────────────────────
log "Uygulama kullanıcısı ve dizini"
if id -u "${APP_USER}" >/dev/null 2>&1; then
  skip "kullanıcı zaten var"
else
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
  echo "   ${APP_USER} açıldı"
fi
mkdir -p "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ─────────────────────────── Ortam dosyası ───────────────────────────
log "Ortam dosyası"
ENV_FILE="${APP_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
  skip "${ENV_FILE} zaten var — DOKUNULMADI (model anahtarı korunur)"
else
  cat > "${ENV_FILE}" <<ENV
# KAELON üretim ortamı. Yalnızca ${APP_USER} okuyabilir (mod 600).
SHARED_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${DB_PORT}/${DB_NAME}?schema=shared"
TENANT_DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${DB_PORT}/${DB_NAME}?schema=tenant_template"

# Model anahtarı — BU SUNUCUDA ELLE DOLDURULUR, hiçbir yerden kopyalanmaz.
ANTHROPIC_API_KEY=""
ANTHROPIC_WORKSPACE_ID=""

# AI harcama tavanı — kullanıcı başına, aylık, USD.
KAELON_AI_WARN_USD="1.0"
KAELON_AI_SOFT_CAP_USD="2.0"
KAELON_AI_CAP_USD="3.0"

NODE_ENV="production"
PORT="4310"
ENV
  chown "${APP_USER}:${APP_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "   oluşturuldu (mod 600)"
fi

# ─────────────────────── nginx (varsa dokunma) ───────────────────────
log "nginx"
if command -v nginx >/dev/null; then
  skip "zaten kurulu — mevcut siteler ve sertifikalar KORUNDU"
  ls -1 /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/   · /'
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq nginx
  systemctl enable --now nginx
fi

# ─────────────────── Güvenlik duvarı: SADECE BAK ───────────────────
log "Güvenlik duvarı"
if command -v ufw >/dev/null && ufw status 2>/dev/null | head -1 | grep -q active; then
  # KURAL EKLENMEZ, SİLİNMEZ. Bu sunucuda mail portları da bu duvardan
  # geçiyor; "temiz kurulum" adına yazılan bir kural mail'i kesebilir.
  for port in 80 443; do
    if ufw status | grep -q "^${port}/tcp"; then
      skip "${port}/tcp zaten açık"
    else
      warn "${port}/tcp KAPALI görünüyor — web erişimi için açılmalı: ufw allow ${port}/tcp"
    fi
  done
else
  skip "ufw aktif değil, dokunulmadı"
fi

log "Hazırlık tamam"
cat <<DONE

  Veritabanı : 127.0.0.1:${DB_PORT} (kapsayıcı ${DB_CONTAINER}, birim ${DB_VOLUME})
  Uygulama   : ${APP_DIR} (kullanıcı ${APP_USER}, port 4310)

  Sıradaki:
    1. Kodu gönder:            ./deploy/deploy.sh
    2. Model anahtarını gir:   nano ${ENV_FILE}
    3. Alan adı + TLS:         ./deploy/tls.sh alt.alanadi.com

DONE
