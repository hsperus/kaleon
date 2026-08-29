# KAELON

Türk imalat sanayii için AI-native operasyonel işletim sistemi.
Sohbet tabanlı arayüz, rol sınırlı tool'lar, kiracı başına ayrı şema.

---

## Hızlı başlangıç

```bash
npm install
npm run db:generate          # Prisma client'larını üret
cp .env.example .env         # ve doldurun
npm run db:push              # kontrol düzlemi + tenant şablonu
npm run tenant -- create demo "Demo A.Ş."
npm run dev                  # http://localhost:4310
```

Geliştirmede oturum açmadan da çalışır: `x-kaelon-dev-role` başlığıyla rol
değiştirilebilir. **Bu yol `NODE_ENV=production` olduğunda tamamen kapalıdır**
ve açan bir bayrak yoktur.

## Ortam değişkenleri

| Değişken | Zorunlu | Ne işe yarar |
|---|---|---|
| `SHARED_DATABASE_URL` | evet | Kontrol düzlemi: tenant, kullanıcı, oturum, kullanım defteri |
| `TENANT_DATABASE_URL` | evet | Tenant şemaları (işletmesel veri) |
| `ANTHROPIC_API_KEY` | üretimde evet | Model bağlantısı |
| `KAELON_ALLOW_DEMO_MODE` | hayır | `1` ise üretimde model olmadan açılmaya AÇIK İZİN verir |

Ortam açılışta doğrulanır (`instrumentation.ts`). **Üretimde eksik veya bozuk
ayar sunucuyu başlatmaz.** Yarı çalışan bir sunucu, çalışmayan sunucudan
tehlikelidir: sağlık kontrolünü geçer, trafik alır ve isteklerin bir kısmını
sessizce bozar.

`ANTHROPIC_API_KEY` yoksa üretim açılmaz. Modelsiz çalışmak isteniyorsa
`KAELON_ALLOW_DEMO_MODE=1` açıkça verilmelidir — sistem sessizce demo moduna
*düşmez*, operatör bilerek *seçer* ve bu her açılışta loglanır.

## Kurulum komutları

```bash
npm run tenant -- create <slug> "<Şirket Adı>"   # tenant + şema
npm run tenant -- list                            # sürüm ve bekleyen migration
npm run tenant -- migrate --all                   # şema güncellemeleri
npm run user   -- create <e-posta> "<Ad>" <parola>
npm run user   -- grant  <e-posta> <slug> <rol...>
npm run user   -- totp   <e-posta>                # 2FA aç
npm run user   -- revoke <e-posta>                # tüm oturumlarını düşür
```

Roller: `patron` · `cfo` · `ik_muduru` · `uretim_muduru` · `satin_alma` ·
`depo_sorumlusu` · `operator`

**İlk yönetici hesabı web formundan değil buradan kurulur.** Kurulum formu,
kapatılmayı unutulan bir arka kapıdır.

## Şema değişikliği

Tenant şemaları numaralı SQL migration'larıyla güncellenir
(`prisma/tenant-migrations/`).

1. `prisma/tenant.prisma` dosyasını düzenleyin
2. `npm run db:generate && npm run db:ddl`
3. `prisma/tenant-migrations/NNN_ad.sql` yazın (yalnızca **fark**)
4. `npm run tenant -- migrate --all`

**Uygulanmış bir migration dosyası ASLA düzenlenmez.** Checksum doğrulaması
bunu yakalar ve hata verir; sessizce atlansaydı geliştirici makinesindeki şema
ile müşterideki şema farklılaşır, fark aylar sonra açıklanamayan bir hata
olarak ortaya çıkardı.

## Dağıtım

```bash
npm run verify:full     # tip kontrolü + testler + üretim derlemesi
npm run build
npm run start
```

Sağlık kontrolü:

| Uç nokta | Soru | Kod |
|---|---|---|
| `/api/health` | Hazır mıyım? (veritabanı dahil) | 200 / 503 |
| `/api/health?live=1` | Ayakta mıyım? (yalnız süreç) | 200 |

Yük dengeleyici **hazırlık** kontrolünü kullanmalıdır. Canlılık kontrolü
bağımlılıklara bakmaz: veritabanı geçici düştüğünde konteyneri yeniden
başlatmak sorunu çözmez, uzatır.

### Ölçekleme notu

Uygulama durumsuzdur; birden çok örnek çalıştırılabilir. İki istisna
**yazılıdır ve tek düğümde doğru çalışır**:

- Giriş denemesi IP sınırı süreç içidir; çok düğümde etkin sınır düğüm
  sayısıyla çarpılır. (Hesap bazlı kilit veritabanındadır ve etkilenmez.)
- İş zamanlayıcı süreç içidir; çok düğümlü kurulumda Redis kilidi gerekir.

Her tenant kendi bağlantı havuzunu açar. Yüzlerce tenant'ta PgBouncer veya
row-level security'ye geçilmelidir.

## Mimari — üç değişmez

**1. Her yazma bir tool'dan geçer.** UI, AI, mobil ve API aynı tool'u çağırır.
Tek implementasyon, dört çağrı noktası; iş kuralı tek yerde.

**2. L4 diye bir yetki seviyesi YOKTUR.** `AuthorityLevel = 0|1|2|3`. Resmî
beyan gönderme, ödeme talimatı, yetki yükseltme ve denetim kaydı silme
*tanımlanamaz* — tip sisteminde yokturlar. Yasaklamak yerine var etmemek,
unutulabilecek bir kontrol bırakmaz.

**3. Bilinmeyen sayı uydurulmaz.** Veri eksikse `null` döner ve gerekçesi
(`caveat`) cevaba kadar taşınır; güven puanı da düşer. "0 makine çalışıyor"
ile "makine bilgisi gelmiyor" aynı ekranda aynı görünürse, ya fabrika durmuş
sanılır ya da gerçek duruş fark edilmez.

### Yetkilendirme iki katmanlıdır

Yetkisiz tool modele **hiç gönderilmez** (katalog süzgeci) *ve* çağrıldığında
invoker tarafından **yeniden doğrulanır**. Tek katman yeterli değildir:
kataloğu atlayan bir çağrı (eski konuşma, elle istek) ikinci kapıya çarpar.

### Görevler ayrılığı

Üretim müdürüne `quality:*` jokeri verilmez. Kalite kapısı kararı verebilir
(`gate.release`) ama kapıyı **atlayamaz** (`gate.override`) — üretimden sorumlu
kişinin kendi kalite kapısını atlaması, sistemin engellemesi gereken çıkar
çatışmasının kendisidir.

## Testler

```bash
npm test                    # tümü
npm run verify              # tip kontrolü + testler
npm run verify:full         # + üretim derlemesi
npm run eval                # altın soru seti (model gerektirir)
```

Veritabanı gerektiren testler `SHARED_DATABASE_URL` yoksa atlanır.

**Değişmez:** bir koruma yazıldıysa, korumayı *kaldırınca kırılan* bir test de
yazılır. Test edilmeyen koruma, ilk yeniden düzenlemede sessizce kaybolur —
bu proje sırasında eşzamanlılık testlerinin kilit KAPALIYKEN de geçtiği
görüldü.

## Bilinçli olarak yapılmayanlar

Bunlar unutulmuş değil, ertelenmiş işlerdir:

- Parola sıfırlama akışı, e-posta doğrulama, OAuth/SSO
- Dağıtık IP sınırı ve dağıtık iş zamanlayıcı (Redis gerekir)
- Banka ve PDKS entegratör adaptörleri (canlı besleme gerekir)
- Vardiya/yoklama beslemesi → `staffOnShift` bilinmiyor
- Zaman damgalı üretim onayı → `actualRatePerHour` bilinmiyor
- Entity resolution'da `pg_trgm` bulanık arama (eklenti kurulumu gerekir);
  şimdilik ilk kelime prefix araması — ilk kelimedeki yazım hatası kaçar
