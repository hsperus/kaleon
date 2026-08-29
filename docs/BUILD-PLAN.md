# KAELON — İnşa Planı

> Ürün Mantığı Raporu §17'deki 12-15 aylık faz planının mühendislik granülaritesinde
> karşılığı. Her aşamanın çıkışı çalışan ve test edilmiş koddur, doküman değil.
>
> v0.1 · Ağustos 2026

## Mimari kararlar (kilitli)

| Karar | Seçim | Gerekçe |
|---|---|---|
| Model | **Tek konuşma modeli: Claude Opus 5** | Önbellek modele özeldir; kademe önbelleği böler, prompt kütüphanesini ve eval matrisini katlar. Kademe yerine `effort` kadranı. |
| İstisna | Haiku 4.5 + Batch API, yalnız gece belge hattı | Ayrı önbellek alanı, konuşmayı bölmez. %50 batch indirimi. |
| Platform | Birinci-parti Anthropic API | `inference_geo` ve Message Batches yalnız burada var; Bedrock/Vertex ikisini de kaybettirir. |
| Kapsam dışı | Claude Fable 5 | Sıfır veri saklama altında kullanılamıyor — veri egemenliği vaadiyle çelişir. |
| Tool disiplini | Her iş kuralı bir tool; UI/AI/mobil/API aynı tool'u çağırır | Tek implementasyon, dört çağrı noktası. |
| L4 | Tool olarak tanımlanamaz | Prompt talimatı değil, tipte yokluk. |
| Veri | PostgreSQL 16, schema-per-tenant, Prisma 6 | Mimari v1 §3.1, §6.2. |
| Uygulama | Next.js 15 App Router + tRPC | Mimari v1 §3.3. |

## Aşamalar

### Aşama 0 — Tool çekirdeği ✅ TAMAM
`defineTool` primitifi, registry, invoker, RBAC, audit, LLM gateway, ajan döngüsü.
30 test, `tsc --noEmit` temiz.

**Neden önce bu:** 240 tool'un hepsi bu primitiften türeyecek. Çekirdek yanlışsa
240 tool yanlış olur; doğruysa gerisi mekanik iş.

### Aşama 1 — Kalıcılık ve kimlik ✅ ÇEKİRDEK TAMAM
- Prisma şeması: `shared` (tenants, users, roles, billing) + `tenant_*` (işletmesel veri)
- Schema-per-tenant yönlendirmesi tek yerde — bağlantı havuzu ve migration stratejisi
- `DataSource` portunun Prisma adaptörü (bellek adaptörü testlerde kalır)
- Better Auth + JWT, oturum yönetimi, 2FA (admin zorunlu)
- Audit sink'in Postgres adaptörü: append-only tablo, `UPDATE`/`DELETE` yetkisi hiçbir role verilmez
- **Çıkış kriteri:** iki tenant'ın verisi birbirini göremediğini kanıtlayan izolasyon testi ✅
- **Kalan:** Better Auth entegrasyonu, oturum/2FA akışı, var olan tenant'lara şema değişikliği uygulayan migration runner

### Aşama 2 — Master Data + Entity Resolution ✅ MOTOR TAMAM
- `partners`, `partner_aliases`, `partner_tax_ids`, `employees`, `items`, `locations`
- Entity Resolution motoru: VKN deterministik eşleşme → alias tablosu → fuzzy unvan → güven skoru
- Belirsiz eşleşmelerde manuel doğrulama akışı ve merge workflow
- Tool'lar: `resolve_partner`, `get_partner`, `list_partners`, `merge_partners` (L2)
- **Çıkış kriteri:** "Burçelik" / "BURÇELİK A.Ş." / VKN / entegratör cari ID'si aynı varlığa çözülür ✅
- **Kalan:** Prisma adaptörü (indeksli ön eleme), merge workflow tool'u (L2), employee/item resolution

### Aşama 3 — Operations Core 🟡 ÇEKİRDEK DEĞİŞMEZLER TAMAM
- Ürün ve revizyon kartları, BOM + revizyon disiplini, configured BOM
- Rota, iş merkezi, kapasite blokları
- **Process-gated iş emri**: kalite kapısından geçmeyen operasyon ilerleyemez — kural
  tool katmanında, kullanıcı katmanında değil
- Stok hareketleri (hareket tipi disiplini), mal kabul, WMS Lite
- Tool'lar: ~45 adet, hepsi `defineTool` ile
- **Çıkış kriteri:** Orthaus'ta 50 gerçek iş emri uçtan uca; negatif stok oluşmaz;
  kalite kapısı atlanamaz
- **Tamam:** hareket tipli stok defteri (negatif stok imkânsız, iptal=ters hareket),
  process-gated iş emri (kapı atlanamaz, override görünür), BOM revizyon dondurma
- **Tamam (devam):** 12 üretim/stok tool'u, repository portu (değişmezler kilit
  altında — eşzamanlı sarf testi mevcut), görevler ayrılığı (üretim müdürü kalite
  kararı verir, kapıyı ATLAYAMAZ)
- **Tamam (devam):** Prisma kalıcılığı — iş emri, operasyon, kalite kararı, BOM
  revizyonu ve stok defteri gerçek veritabanında; bakiye SQL'de toplanıyor;
  eşzamanlılık advisory lock ile korunuyor ve MUTASYON TESTİYLE doğrulandı
- **Kalan:** configured BOM, kapasite blokları, WMS Lite, mal kabul/PO eşleştirme,
  ~25 tool daha

### Aşama 4 — Chat arayüzü 🟡 UÇTAN UCA ÇALIŞIYOR
- Prototipteki ana ekranın gerçek uygulaması: sohbet ana yüzey, üç seviyeli sessizlik,
  panel sistemi ([prototype/ana-ekran.html](../prototype/ana-ekran.html))
- Streaming, tool çağrısı ilerlemesi, kaynak satırı, drilldown
- Boss Mode v1 ekranları: Bugünün Gerçeği, Saklanan Riskler, Fabrika Canlı, Kalite,
  Sevkiyat Riski, Bugün Ne Yapmalıyım
- Rol bazlı ana ekranlar: CFO cockpit, Üretim Müdürü cockpit
- Saha dokunmatik katmanı (operatör/kalite/depo terminalleri)
- **Çıkış kriteri:** patron sorgusundan cevaba p95 < 3 sn
- **Tamam:** Next.js 15 + tRPC iskeleti, chat ana ekranı gerçek uca bağlı,
  rol değiştirici (geliştirme), tool çağrısı rozetleri, kaynak satırı,
  audit uç noktası. Model bağlı değilken senaryo tabanlı completer devreye
  giriyor ve arayüz bunu AÇIKÇA yazıyor
- **Tamam (devam):** NDJSON akış uç noktası, ajan döngüsünden canlı ilerleme
  olayları (tool_start/tool_end/text/done), panel çekmecesi (5 tool için
  yapılandırılmış görünüm), kelime kelime beliriş
- **Kalan:** Boss Mode ekranları, saha dokunmatik katmanı, gerçek oturum
  (Better Auth), gerçek model akışı (API anahtarı gerektirir)

### Aşama 5 — Entegrasyon katmanı (3-4 hafta)
- Adapter deseni: `connect / sync / send / validate / normalize`
- E-Fatura (tek standart entegratör), banka, PDKS, bordro
- Raw Data Layer → Canonical Layer dönüşümü, `source_reference` bağı
- BullMQ kuyrukları, retry politikası, hata sınıflandırması
- Gece belge hattı: Haiku 4.5 + Batch API ile fatura okuma
- **Çıkış kriteri:** e-fatura → kanonik → PO eşleştirme → onay akışı uçtan uca
- **Tamam:** üç yönlü eşleştirme motoru (fiyat/miktar/mal kabul/mükerrer/para birimi),
  çift eşikli tolerans, bulgular parasal etkiye göre sıralı, Prisma kalıcılığı;
  mükerrer fatura VERİTABANI kısıtıyla korunuyor (eşzamanlı kayıt testi mevcut)
- **Kalan:** entegratör adaptörleri (e-fatura, banka, PDKS), BullMQ kuyrukları,
  gece belge hattı (Haiku + Batch API)

### Aşama 6 — Approval Workspace 🟡 DURUM MAKİNESİ TAMAM
- Sekiz durumlu state machine, çoklu onay seviyeleri
- L1 taslak tool'ları: `draft_vat_return`, `draft_termination_calc`, `draft_payment_plan`
- L2: `submit_for_approval`
- Beyanname güven skoru hesabı
- **Çıkış kriteri:** KDV taslağı hazırlanır, riskler işaretlenir, onaya düşer; gönderim yok
- **Tamam:** 8 durumlu makine; hazırlayan onaylayamaz (SoD), onay limiti ve para
  birimi kontrolü, riskler teyit edilmeden onay yok, `submitted_externally`
  yalnızca `job` kanalından — kullanıcı 'gönderildi' işaretleyemez
- **Tamam (devam):** 7 belge/onay tool'u; fatura → eşleştirme → onay kaydı →
  inceleme → onay/düzeltme zinciri uçtan uca; Prisma modelleri hazır
  (mükerrer fatura veritabanı kısıtıyla da korunuyor)
- **Tamam (devam):** Prisma adaptörleri; onay geçmişi append-only (mutasyon
  eski olayları yeniden yazmaz), iyimser kilit eşzamanlı onayı reddediyor
- **Kalan:** L1 taslak tool'ları (KDV, işten çıkış, ödeme planı), eskalasyon zinciri

### Aşama 7 — Evaluation framework 🟡 KOŞUM TAMAM
- Golden question seti: 80 Türkçe soru, beklenen cevap + zorunlu kaynak alanları
- Her prompt/tool değişikliğinde regresyon koşusu
- Halüsinasyon tespiti: sayı doğrulama, kaynak kontrolü
- Maliyet ve gecikme metrikleri, model/effort karşılaştırması
- **Çıkış kriteri:** satışa çıkış eşiği — 80 golden question'da kaynaklı doğru cevap
- **Tamam:** çalıştırılabilir golden fixture'lar (22 soru), kapılı notlandırıcı
  (güvenlik ihlali puan kırmaz, soruyu düşürür), paket raporu
- **Kalan:** 58 soru daha, gerçek modele karşı ilk koşu (API anahtarı gerekli), CI bağlantısı

### Aşama 8 — Pilot sertleştirme (4 hafta)
- Orthaus + Zerey canlı geçiş, veri migrasyonu, çapraz doğrulama dönemi
- Güvenlik sertleştirme, sızma testi, KVKK uyum kontrol listesi
- Implementation Partner Playbook
- **Çıkış kriteri:** Ürün Mantığı §17'deki on satışa çıkış koşulunun tamamı

## Değişmezler — her PR'da denetlenir

1. `tool.execute` doğrudan çağrılmaz; her yol `invokeTool`'dan geçer.
2. Yeni tool → yeni test. RBAC testi olmayan tool merge edilmez.
3. Sistem promptuna değişken veri girmez (önbellek öneki).
4. Tool katalogu deterministik sıralı kalır.
5. Audit'te `UPDATE`/`DELETE` yoktur; migration'da bile.
6. L4 sınırını ima eden tool adı reddedilir.
6b. Değişmezler kilit altında uygulanır — oku-kontrol-et-yaz deseni yasak.
6c. Görevler ayrılığı: bir rol hem işi yapıp hem kendi kontrolünü atlayamaz.
7. `tsc --noEmit` ve testler yeşil olmadan commit yok.
8. Bir koruma yazıldıysa, korumayı KALDIRINCA kırılan bir test de yazılır.
   Yanlış sebepten geçen test, testsizlikten beterdir.

## Ölçüm

| Metrik | Hedef |
|---|---|
| AI maliyeti | < $1 / kullanıcı / ay (uyarı $1,5, cap $2) |
| Önbellek isabet oranı | > %80 (mesai saatlerinde) |
| Sorgu p95 gecikme | < 3 sn |
| Golden question doğruluğu | > %90 |
| Kaynaksız cevap oranı | %0 — tipte imkânsız |
