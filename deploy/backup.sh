#!/usr/bin/env bash
#
# KAELON günlük yedeği.
#
# YEDEĞİ OLMAYAN MUHASEBE VERİSİ, OLMAYAN VERİDİR. Bu sistemde
# değiştirilemez yevmiye kayıtları, kesilmiş faturalar ve çalıştırılmış
# bordrolar var — hiçbiri yeniden üretilemez. Disk arızası ya da yanlış
# bir DROP, işletmenin mali geçmişini siler ve geri getirilemez.
#
# YEDEK DOĞRULANIR. Alınmış ama açılamayan bir yedek, yedek olmadığını
# ancak felaket anında gösterir; `pg_restore --list` her dosyayı okuma
# testinden geçirir.
#
# DİSK PAYLAŞIMLIDIR. Sunucuda başka siteler ve bir mail sunucusu var;
# yedek dosyaları sınırsız birikirse diski doldurup HEPSİNİ düşürür.
# 14 günden eski dosyalar silinir.

set -euo pipefail

DB="${KAELON_DB:-kaelon}"
CONTAINER="${KAELON_PG_CONTAINER:-kaelon-postgres}"
# KULLANICI SABİT YAZILMAZ, KONTEYNERDEN OKUNUR. "postgres" varsayıldığında
# yedek ilk koşuda "role does not exist" ile düştü — ve düşen bir yedek
# betiği, kurulmuş görünüp hiç çalışmadığı için yedeksizlikten daha
# tehlikelidir: yedek olduğu sanılır.
PGUSER_IN_CONTAINER="${KAELON_PG_USER:-$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)}"
DIR="${KAELON_BACKUP_DIR:-/var/backups/kaelon}"
KEEP_DAYS="${KAELON_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%F-%H%M)"
FILE="$DIR/kaelon-$STAMP.dump"

mkdir -p "$DIR"
chmod 700 "$DIR"

# Yedek KONTEYNERİN İÇİNDEN alınır: host'taki pg_dump sürümü
# konteynerdeki sunucudan eski olabilir ve o durumda dump reddedilir.
docker exec "$CONTAINER" pg_dump -U "$PGUSER_IN_CONTAINER" -Fc "$DB" > "$FILE"

# BOŞ DOSYA BAŞARI SAYILMAZ. `set -o pipefail` yönlendirmeyi
# yakalamaz; dosyanın gerçekten dolu olduğu ayrıca kontrol edilir.
SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
if [ "$SIZE" -lt 10000 ]; then
  echo "HATA: yedek çok küçük ($SIZE bayt) — alınmamış sayılıyor: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

# OKUNABİLİRLİK TESTİ: açılamayan yedek, yedek değildir.
if ! pg_restore --list "$FILE" > /dev/null 2>&1; then
  echo "HATA: yedek okunamıyor, bozuk: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

chmod 600 "$FILE"

# Eskiler silinir; en az bir yedek HER ZAMAN kalır.
find "$DIR" -name 'kaelon-*.dump' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

COUNT=$(find "$DIR" -name 'kaelon-*.dump' | wc -l)
echo "$(date -Is) yedek alındı: $FILE ($((SIZE / 1024)) KB) · toplam $COUNT dosya"
