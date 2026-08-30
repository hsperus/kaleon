# KAELON — sunucuya kurulum

> **Bu kurulum canlıda:** https://scragentx.com
> Sunucu adresi `KAELON_HOST` ortam değişkeninden gelir · uygulama
> `/opt/kaelon` · port 4310
>
> ADRES BU DOSYADA YAZMAZ. Açık bir depoda üretim sunucusunun IP'si,
> yanında "SSH kök ile bağlanılır" cümlesiyle birlikte durursa tarama
> yapan biri için hazır bir hedef listesi olur. Betikler adresi zaten
> ortamdan alıyor:
>
> ```bash
> KAELON_HOST=<sunucu-adresi> ./deploy/deploy.sh
> ```
> Veritabanı: `kaelon-postgres` kapsayıcısı, `127.0.0.1:5433`, birim `kaelon_pg_data`
>
> Sunucu PAYLAŞIMLIDIR: üzerinde başka siteler ve bir mail servisi
> çalışıyor. Aşağıdaki betikler onlara DOKUNMAZ; her adım önce bakar,
> sonra gerekiyorsa yapar. (Hangi projelerin çalıştığı burada yazmaz:
> açık bir depoda üçüncü tarafların altyapısını ifşa etmek bize ait
> bir karar değildir.)

Bu dizin, KAELON'u kendi sunucunuza kurmak için gereken her şeyi içerir.
Dört adım; her biri tek komut.

## Önce: erişim anahtarı

Sunucuya parolayla değil **anahtarla** bağlanılır. Parola tabanlı root
girişi, parolayı bilen herkese sunucunun tamamını verir; anahtar hem daha
güvenlidir hem de her komutta parola sormaz.

Kendi makinenizden **bir kez**:

```bash
ssh-copy-id -i ~/.ssh/kaelon_deploy.pub root@SUNUCU_IP
```

Parolayı bu komut soracak. Sonrasında parola bir daha gerekmez.

## 1. Sunucu hazırlığı (tek sefer)

Node, PostgreSQL, nginx, güvenlik duvarı ve ayrıcalıksız uygulama
kullanıcısı kurulur. Veritabanı parolası sunucuda üretilir ve ekrana
basılmaz.

```bash
scp -i ~/.ssh/kaelon_deploy deploy/bootstrap.sh root@SUNUCU_IP:/tmp/
ssh -i ~/.ssh/kaelon_deploy root@SUNUCU_IP 'bash /tmp/bootstrap.sh'
```

## 2. Uygulamayı gönderin

```bash
export KAELON_HOST=SUNUCU_IP
./deploy/deploy.sh
```

Betik önce **yerelde testleri koşturur**; testler geçmezse hiçbir şey
gönderilmez. Sonra kodu kopyalar, derler, veritabanı göçlerini uygular
ve servisi yeniden başlatır. Sağlık kontrolü geçmezse son 40 satır log'u
gösterip hata verir.

## 3. Model anahtarını girin

```bash
ssh -i ~/.ssh/kaelon_deploy root@SUNUCU_IP 'nano /opt/kaelon/.env'
```

`ANTHROPIC_API_KEY` ve — kimliğe bağlı anahtar kullanıyorsanız —
`ANTHROPIC_WORKSPACE_ID` satırlarını doldurun. Ardından:

```bash
ssh -i ~/.ssh/kaelon_deploy root@SUNUCU_IP 'systemctl restart kaelon'
```

**Anahtarı yerel `.env` dosyanızdan kopyalamayın.** Bir sırrın iki yerde
yaşaması, iki kat sızma riski demektir.

## 4. Alan adı ve TLS

DNS A kaydını sunucunun IP'sine yönlendirdikten sonra:

```bash
./deploy/tls.sh alanadi.com you@alanadi.com
```

HTTP üzerinden çalıştırmayın: oturum çerezi ve model cevapları düz metin
gider.

---

## İlk tenant ve kullanıcı

```bash
ssh -i ~/.ssh/kaelon_deploy root@SUNUCU_IP
cd /opt/kaelon
sudo -u kaelon npm run tenant -- create firma-slug "Firma Adı"
sudo -u kaelon npm run user -- create patron@firma.com "Ad Soyad" "en-az-10-karakter"
sudo -u kaelon npm run user -- grant patron@firma.com firma-slug patron
sudo -u kaelon npm run user -- totp patron@firma.com   # 2FA (önerilir)
```

## Günlük işler

| İş | Komut |
|---|---|
| Log izle | `journalctl -u kaelon -f` |
| Sağlık | `curl -s localhost:4310/api/health` |
| AI harcaması | `sudo -u kaelon npm run usage` |
| Denetim kaydı | `sudo -u kaelon npm run audit -- firma-slug` |
| Tenant listesi | `sudo -u kaelon npm run tenant -- list` |
| Yeni sürüm | yerelden `./deploy/deploy.sh` |

## Yedekleme

Veritabanı **tek gerçek kaynaktır**; kod yeniden kurulabilir, veri
kurulamaz. Günlük yedek için sunucuda:

```bash
cat > /etc/cron.daily/kaelon-backup <<'CRON'
#!/bin/sh
set -e
DIR=/var/backups/kaelon
mkdir -p "$DIR"
sudo -u postgres pg_dump -Fc kaelon > "$DIR/kaelon-$(date +%F).dump"
# 14 günden eskiyi sil — yer dolunca yedek de alınamaz.
find "$DIR" -name 'kaelon-*.dump' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/kaelon-backup
```

Yedeği **başka bir makineye** de kopyalayın: sunucu diski giderse
üzerindeki yedek de gider.

## scragentx.com devri (29.08.2026)

Bu alan adı önce Limra Tech / "Revival Rota" statik sitesini sunuyordu.
KAELON'a devredildi. **Hiçbir şey kalıcı olarak silinmedi:**

- Tam yedek: `/var/backups/scragentx-devir-20260829-163412/`
  (kaynak kod, git deposu, arayüz dosyaları, systemd birimleri, eski
  nginx yapılandırmaları ve `OKU.txt` içinde geri alma adımları)
- `limra-api` servisi durduruldu ve devre dışı bırakıldı — **1,2 milyon
  kez** yeniden başlamış bir çökme döngüsündeydi (`.env` dosyası yoktu).
- `limra-backup.timer` devre dışı bırakıldı.
- `api.scragentx.com` nginx sitesi kapatıldı (arka ucu 8080'de hiç
  çalışmıyordu, KAELON'dan önce de 502 veriyordu).

Kalıcı silmek isterseniz adımlar arşivdeki `OKU.txt` içinde.

## Güvenlik notları

- **Root parolasını değiştirin.** Kuruluma başlarken kullandığınız
  parola artık güvenilir sayılmamalıdır.
- Anahtar kurulduktan sonra parola girişini kapatın:
  `/etc/ssh/sshd_config` içinde `PasswordAuthentication no` → `systemctl restart ssh`
- `.env` dosyası `600` modundadır ve yalnızca `kaelon` kullanıcısı okur.
- Uygulama root olarak çalışmaz; systemd birimi dosya sistemine
  yalnızca gerekli iki dizin için yazma izni verir.
