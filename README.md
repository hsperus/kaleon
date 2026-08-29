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

## Kullanıcı yönetimi

Arayüzden (yalnızca **patron** görür — `admin:user.manage` izni jokerle
verilmez): kullanıcı ekleme, rol atama, 2FA açma/kapatma, parola sıfırlama
kodu üretme, oturum düşürme, pasifleştirme.

**Parola yönetici tarafından yazılmaz.** Kullanıcı oluşturulunca tek
kullanımlık bir kod çıkar; kullanıcı kendi parolasını belirler. Yöneticinin
parola yazması, o parolanın bilinmesi demektir — ve pratikte herkese aynısı
verilir.

**Sır bir kez gösterilir.** 2FA sırrı ve sıfırlama kodu yalnızca üretildiği
anda görünür; listede tutulsaydı listeyi gören herkes herkesin ikinci
faktörünü görürdü.

Parolasını unutan kullanıcı giriş ekranındaki **"Parolamı unuttum"** ile
yöneticiden aldığı kodu girer. Kod 1 saat geçerli, tek kullanımlık ve
sıfırlama tüm oturumları düşürür.

## Veri girişi (içe aktarma)

Sohbete CSV eklenir; **sistem dosyanın ne olduğunu başlıklarından anlar**.
Emin olamazsa sorar. Akış SAP'nin göç mantığıyla aynıdır: yükle → **simüle
et** → hataları gör → kaydet. Önizleme hiçbir şey yazmaz.

| Dosya | Yetki | Kim yükler |
|---|---|---|
| Cari listesi | `master-data:partner.write` | patron, satın alma |
| Personel listesi | `master-data:employee.write` | patron, İK |
| Banka bakiyeleri | `finance:bank.write` | patron, CFO |
| Puantaj (PDKS) | `hr:attendance.write` | patron, İK |
| Satış siparişleri | `sales:order.write` | patron, CFO |

Yetkisi olmayan nesne tanıma adayı bile olmaz. Hatalı satır dosyayı
durdurmaz: satır numarasıyla raporlanır, gerisi aktarılır. Aynı dosya iki
kez yüklenirse mükerrer kayıt oluşmaz.

Türkçe Excel çıktısı doğrudan çalışır: noktalı virgül ayırıcı, BOM,
`1.234,56` sayı ve `31.12.2026` tarih biçimi.

## Kurulum komutları

```bash
npm run tenant -- create <slug> "<Şirket Adı>"   # tenant + şema
npm run tenant -- list                            # sürüm ve bekleyen migration
npm run tenant -- migrate --all                   # şema güncellemeleri
npm run user   -- create <e-posta> "<Ad>" <parola>
npm run user   -- grant  <e-posta> <slug> <rol...>
npm run user   -- totp   <e-posta>                # 2FA aç
npm run user   -- reset  <e-posta>                # parola sıfırlama kodu
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

## Denetim kaydı

Her tool çağrısı tenant şemasına yazılır ve **veritabanı seviyesinde
değiştirilemez** (`UPDATE`/`DELETE` tetikleyiciyle reddedilir — doğrudan SQL
ile bile).

```bash
npm run audit -- orthaus                      # son 50 işlem
npm run audit -- orthaus --failed             # reddedilen/başarısız olanlar
npm run audit -- orthaus --writes             # yalnızca veri değiştirenler
npm run audit -- orthaus --user <uuid> --from 2026-05-01 --to 2026-05-31
```

## Yedekleme ve geri yükleme

Kontrol düzlemi ve tenant şemaları **aynı veritabanındadır**; tek bir dump
her şeyi kapsar.

```bash
pg_dump --format=custom --file=kaelon-$(date +%F).dump "$SHARED_DATABASE_URL"
```

Tek bir tenant'ı almak (müşteriye veri teslimi, taşıma):

```bash
pg_dump --format=custom --schema=tenant_orthaus --file=orthaus.dump "$SHARED_DATABASE_URL"
```

Geri yükleme:

```bash
pg_restore --dbname="$SHARED_DATABASE_URL" --clean --if-exists kaelon-2026-05-16.dump
```

**Geri yükleme provası yapılmamış yedek, yedek değildir.** En az üç ayda bir
boş bir veritabanına geri yükleyip `npm run tenant -- list` ile şema
sürümlerini doğrulayın.

**KVKK silme talebi** bir tenant'ın tüm işletmesel verisini kaldırır:

```bash
KAELON_CONFIRM_DROP=orthaus npm run tenant -- drop orthaus
```

Kontrol düzlemindeki kayıt `archived` olarak kalır; denetim izi için gerekli.

## İzleme

Loglar tek satır JSON (üretimde). Her satırda `correlationId` vardır; bir
isteğin tüm izleri o anahtarla toplanır. Parola, token, TOTP kodu, tool
girdisi ve dosya içeriği **asla loglanmaz**.

Kullanıcıya bir hata gösterildiğinde ekranda **destek kodu** çıkar; logda
`ref` alanıyla aranır.

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

- E-posta gönderimi (SMTP). Parola sıfırlama çalışıyor ama kod yönetici
  tarafından elden iletiliyor; SMTP eklendiğinde aynı kod e-postayla gider.
- E-posta doğrulama, OAuth/SSO
- Dağıtık IP sınırı ve dağıtık iş zamanlayıcı (Redis gerekir)
- Banka ve PDKS entegratör adaptörleri (canlı besleme gerekir)
- Vardiya/yoklama beslemesi → `staffOnShift` bilinmiyor
- Zaman damgalı üretim onayı → `actualRatePerHour` bilinmiyor
- Entity resolution'da `pg_trgm` bulanık arama (eklenti kurulumu gerekir);
  şimdilik ilk kelime prefix araması — ilk kelimedeki yazım hatası kaçar
