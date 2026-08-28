# SAP Kapsam Haritası — KAELON Referansı

> Amaç: "SAP'de ne var?" sorusunun eksiksiz cevabı. KAELON'un neyi karşılayacağı, neyi
> bilinçli olarak yapmayacağı ve nerede SAP'nin yapamadığını yapacağı bu haritanın üstüne
> kurulur. Prompt yazarken ve kapsam tartışmalarında referans alınacak doküman.
>
> v1.0 · Ağustos 2026 · KAELON / ULS Group

---

## 0. Nasıl okunmalı

SAP tek bir ürün değil, bir ürün ailesidir. "SAP'de şu var" cümlesi çoğu zaman üç farklı
şeyi kastedebilir: ECC'nin klasik modülü, S/4HANA'nın line-of-business'ı, ya da ayrı
satılan bir bulut ürünü (Ariba, SuccessFactors...). Bu haritada üçü ayrı ayrı işaretlenir.

Ölçek referansı — KAELON'un neye karşı konumlandığını somutlaştırmak için:

| Ölçü | Değer |
|---|---|
| S/4HANA Cloud hazır süreç paketi (scope item) | **~850** |
| SAP Fiori uygulaması (2013'te 25 idi) | **7.500+** |
| Gömülü AI use-case (SAP beyanı, 2025 sonu) | **400+** |
| Joule ajanı / beceri (2026) | ~40 ajan, ~2.400 beceri |
| Tipik bir kurumsal implementasyonda kullanılan modül | 15–20 |
| Klasik ERP implementasyon süresi | 6–18 ay (üretimde daha uzun) |

Buradaki asıl ders sayıların büyüklüğü değil: **SAP'nin gücü fonksiyon sayısında, zayıflığı
ise bu fonksiyonlara erişim biçiminde.** 7.500 uygulama demek, kullanıcının aradığını
bulamaması demektir. KAELON'un tezi tam buraya oturur.

---

## 1. SAP ürün ailesi — evrenin haritası

### 1.1 Çekirdek ERP

| Ürün | Konum | Not |
|---|---|---|
| **SAP R/3 → ECC 6.0** | Klasik on-prem ERP | 2027/2030 destek sonu; Türkiye'de hâlâ yaygın |
| **SAP S/4HANA (on-prem)** | Yeni nesil, HANA in-memory | Tam özelleştirilebilir |
| **S/4HANA Cloud, Private Edition** | Tek kiracı bulut | ECC'den geçiş için ana yol |
| **S/4HANA Cloud, Public Edition** | Çok kiracı SaaS | ~850 scope item, sınırlı özelleştirme |
| **SAP Business One (B1)** | KOBİ, 10–100 kullanıcı | 15 modül — KAELON'un en yakın fiyat rakibi |
| **SAP Business ByDesign** | Orta ölçek SaaS | Yeni satış durduruldu, B1 + S/4 Public'e yönlendirme |

### 1.2 Çevre bulut ürünleri (ayrı lisans, ayrı veri modeli)

| Ürün | Alan |
|---|---|
| **SAP Ariba** | Tedarik ağı, kaynak bulma, sözleşme, tedarikçi risk |
| **SAP Fieldglass** | Dış kaynak işgücü, taşeron, hizmet satın alma |
| **SAP Concur** | Seyahat ve masraf yönetimi |
| **SAP SuccessFactors** | İK bulutu (Employee Central, Recruiting, LMS, Performance, Comp) |
| **SAP Customer Experience (C/4)** | Sales/Service/Marketing/Commerce Cloud, CDP |
| **SAP IBP** | Entegre iş planlama (talep, arz, S&OP, envanter optimizasyonu) |
| **SAP EWM / TM / GTS / Yard Logistics** | Depo, taşıma, dış ticaret, saha lojistiği |
| **SAP APO (eski) → PP/DS + IBP** | İleri planlama ve çizelgeleme |
| **SAP DMC / ME / MII / PEO** | MES — üretim yürütme ve saha entegrasyonu |
| **SAP Asset Performance Management** | Kestirimci bakım, varlık stratejisi |
| **SAP Analytics Cloud (SAC)** | BI, planlama, tahminleme |
| **SAP Signavio** | Süreç madenciliği, süreç modelleme, Process Navigator |
| **SAP BTP** | Uygulama platformu: CAP, ABAP env., Integration Suite, Build, AI Core |
| **SAP Joule / Joule Studio** | Gömülü AI asistanı ve ajan geliştirme ortamı |
| **SAP GRC / Governance** | Access Control, Process Control, Risk Management |
| **SAP MDG** | Master Data Governance |

> **KAELON çıkarımı:** SAP'nin "tek sistem" imajı yanıltıcıdır. Gerçek bir SAP müşterisi
> 5–12 ayrı ürünü entegrasyonlarla birbirine bağlar. KAELON'un "tek kurumsal hafıza" tezi
> tam olarak bu parçalanmanın karşı-tezidir ve satışta en güçlü kozdur.

---

## 2. Organizasyon yapısı (Enterprise Structure)

SAP'nin gerçek karmaşıklığı modüllerde değil, **kurgu (org yapısı) katmanındadır.** Bir
implementasyonun ilk 2 ayı burada geçer ve yanlış kurulursa geri dönüşü yoktur.

### 2.1 Finansal organizasyon
- **Client (Mandant)** — en üst teknik ayrım; veri izolasyonu burada başlar
- **Company Code** — yasal tüzel kişilik; bilanço ve gelir tablosu bu seviyede
- **Business Area** — (eski) segment raporlama
- **Segment / Profit Center** — yönetsel raporlama birimi
- **Controlling Area** — maliyet muhasebesi alanı; birden çok company code'u kapsayabilir
- **Operating Concern** — kârlılık analizi (CO-PA) alanı
- **Credit Control Area** — kredi limiti yönetim alanı
- **Financial Management Area (FM)** — bütçe/ödenek yönetimi
- **Chart of Accounts** — operatif / grup / ülke hesap planı (Türkiye'de Tek Düzen)
- **Ledger** — paralel defterler (0L lider, IFRS, vergi, yerel)
- **Fiscal Year Variant, Posting Period Variant, Field Status Variant**

### 2.2 Lojistik organizasyon
- **Plant (Werk)** — fabrika/depo/şantiye; MRP, üretim, stok değerleme burada
- **Storage Location** — depo alanı (fiziksel değil, mantıksal)
- **Warehouse Number / Storage Type / Storage Section / Storage Bin** — WM/EWM hiyerarşisi
- **Purchasing Organization / Purchasing Group** — satın alma sorumluluk yapısı
- **Sales Organization / Distribution Channel / Division** → **Sales Area**
- **Sales Office / Sales Group / Sales District**
- **Shipping Point / Loading Point / Transportation Planning Point**
- **Valuation Area / Valuation Level** — stok değerlemenin yapıldığı seviye
- **Work Center / Resource / Production Line / Production Version**
- **Maintenance Plant / Planning Plant / Planner Group / Work Center (PM)**

### 2.3 İK organizasyonu
- **Personnel Area / Personnel Subarea**
- **Employee Group / Employee Subgroup**
- **Organizational Unit / Position / Job / Task** (OM nesne modeli: O, S, C, P, K)
- **Payroll Area, Pay Scale Structure**

> **KAELON çıkarımı:** Bu katmanın tamamını taşımak KAELON'u SAP'ye çevirir. Ama tamamen
> atlamak da hata olur — çünkü **çok tesisli / çok tüzel kişilikli müşteri ilk yılda gelir.**
> Minimum taşınması gerekenler: tenant → legal entity (company code) → plant → storage
> location → work center, ve sales area yerine sadeleştirilmiş satış kanalı. Controlling
> area, operating concern, credit control area gibi katmanlar KAELON'da **ayrı nesne
> olmamalı**, mevcut nesnelerin nitelikleri olmalıdır.

---

## 3. Ana veri (Master Data) envanteri

### 3.1 Malzeme (Material Master) — SAP'nin en büyük nesnesi
Yaklaşık **20 görünüm (view)**, her biri farklı departmanın alanı:

Basic Data 1/2 · Classification · Sales Org 1/2 · Sales General/Plant · Foreign Trade
Export/Import · Sales Text · Purchasing · Purchase Order Text · MRP 1/2/3/4 · Forecasting ·
Work Scheduling · General Plant Data/Storage 1/2 · Warehouse Management 1/2 · Quality
Management · Accounting 1/2 · Costing 1/2 · Plant Stock · Storage Location Stock

Kritik alanlar: Material Type (FERT/HALB/ROH/HAWA/DIEN...), Industry Sector, Base UoM,
Alternative UoM, Material Group, MRP Type (PD/VB/ND...), Lot Size, Procurement Type,
Special Procurement, Safety Stock, Reorder Point, Planned/GR Processing Time, Strategy
Group, Availability Check, Batch Management flag, Serial Number Profile, Valuation Class,
Price Control (S/V), Standard/Moving Price, Costing Lot Size.

### 3.2 İş ortağı
- **Business Partner (BP)** — S/4HANA'da tek nesne; Customer ve Vendor artık BP rolüdür
- Roller: FLCU00/FLCU01 (müşteri), FLVN00/FLVN01 (tedarikçi), FLBP01 (çalışan), vb.
- **Customer Master:** General / Company Code / Sales Area görünümleri; partner functions
  (SP sold-to, SH ship-to, BP bill-to, PY payer), incoterms, ödeme koşulu, vergi sınıfı,
  kredi limiti, teslimat toleransları
- **Vendor Master:** General / Company Code / Purchasing Org; ödeme koşulu, banka bilgisi,
  vergi no, tedarikçi değerlendirme profili
- **Partner Determination** — hangi rolün hangi belgeye otomatik geleceği

### 3.3 Üretim ana verisi
- **BOM (Stückliste)** — çok seviyeli, alternatif, tarih geçerlilikli, mühendislik/üretim
  ayrımı, phantom assembly, item category (L stok, N stok dışı, D metin, T metin)
- **Routing / Master Recipe / Rate Routing** — operasyonlar, standart değerler, PRT'ler
- **Work Center / Resource** — kapasite, formül, maliyet merkezi bağı, aktivite tipleri
- **Production Version** — BOM + routing kombinasyonu
- **PRT (Production Resource/Tool)** — kalıp, aparat, ölçüm cihazı
- **Variant Configuration (VC/AVC)** — karakteristik, sınıf, konfigürasyon profili, kısıt
  ağı, seçim koşulu, prosedür — **müşteriye göre üretimin (MTO) kalbi**
- **Engineering Change Management (ECM)** — değişiklik numarası, geçerlilik tarihi/parametresi

### 3.4 Satın alma ana verisi
- Purchasing Info Record · Source List · Quota Arrangement · Contract (miktar/değer) ·
  Scheduling Agreement + delivery schedule · Vendor Evaluation kriterleri · Approved
  Manufacturer Parts List (AMPL)

### 3.5 Fiyat ve koşul tekniği (Condition Technique)
SAP'nin en güçlü ve en zor mekanizması. Satış fiyatı, satın alma fiyatı, indirim, navlun,
vergi, çıktı belirleme, hesap belirleme — hepsi aynı motoru kullanır:

**Condition Table → Access Sequence → Condition Type → Pricing Procedure → Determination**

Kalemler: PR00 (fiyat), K004/K005 (indirim), KF00 (navlun), MWST (vergi), EK01 (maliyet),
VPRS (stok maliyeti), rebate koşulları, scale (kademeli fiyat), condition exclusion.

### 3.6 Finans / kontrol ana verisi
GL Account (operatif + grup) · Cost Element (S/4'te GL ile birleşti) · Cost Center ·
Profit Center · Internal Order · WBS Element · Activity Type · Statistical Key Figure ·
Asset Master + Asset Class + Depreciation Area · House Bank + Bank Account · Tax Code ·
Payment Term · Dunning Procedure

### 3.7 Kalite / bakım / depo
Inspection Plan · Master Inspection Characteristic · Sampling Procedure · Catalog & Code
Group · Quality Info Record · Certificate Profile · Batch Master + Batch Class ·
Functional Location · Equipment · Measuring Point/Counter · Maintenance Item/Plan/Strategy ·
Task List (PM) · Storage Bin · Handling Unit · Packaging Material

---

## 4. Uçtan uca süreçler (End-to-End) ve belge akışları

SAP kendi resmî çerçevesinde beş ana E2E süreç tanımlar. Aşağıda her biri **gerçek belge
akışıyla** açılmıştır — KAELON'un karşılık üretmesi gereken şey budur.

### 4.1 Source-to-Pay (Satın Alma)

```
İhtiyaç → Purchase Requisition (PR) → [Release Strategy: çok kademeli onay]
  → RFQ (teklif isteme) → Quotation (tedarikçi teklifi) → Fiyat karşılaştırma
  → Purchase Order (PO) → [PO onay stratejisi]
  → Order Confirmation (tedarikçi teyidi)
  → Goods Receipt (GR, 101) → [Kalite: inspection lot açılır → UD]
  → Invoice Receipt (IR/LIV) → 3-Way Match (PO ↔ GR ↔ Fatura)
  → Payment Proposal (F110) → Ödeme → Banka mutabakatı
```

Varyantlar ve özel akışlar:
- **Fason (Subcontracting)** — PO item cat. L, komponent sağlama (541/543), çıktı GR
- **Konsinye (Consignment)** — tedarikçi stoku, tüketimde borç doğar (411/K)
- **Pipeline** — sayaçlı tüketim (elektrik, gaz)
- **STO (Stock Transport Order)** — tesisler/şirketler arası transfer, intercompany fatura
- **Hizmet satın alma** — service master, service entry sheet (SES), onaylı hizmet kabulü
- **Third-party (üçlü)** — müşteri siparişi doğrudan tedarikçiden sevk
- **Evaluated Receipt Settlement (ERS)** — faturasız otomatik ödeme
- **Invoice Blocking** — fiyat/miktar/tarih sapmasında otomatik ödeme bloğu
- **Vendor Evaluation** — teslim performansı, fiyat, kalite, hizmet skorları

Ariba katmanı: kaynak bulma etkinliği, e-ihale, sözleşme yaşam döngüsü, tedarikçi risk,
tedarikçi ağ katalogları.

### 4.2 Lead-to-Cash / Order-to-Cash (Satış)

```
Lead → Opportunity (CRM) → Inquiry → Quotation
  → Sales Order [ATP kontrolü + Credit Check + Pricing + VC konfigürasyon]
  → Delivery (teslimat belgesi) → Picking (WM/EWM transfer order)
  → Packing (Handling Unit) → Post Goods Issue (PGI, 601 — muhasebe belgesi doğar)
  → Billing (fatura) → Muhasebeleştirme → Tahsilat → Dunning (ihtar) → Kapama
```

Varyantlar:
- **MTS / MTO / ATO / ETO** — stoğa, siparişe, siparişe montaj, siparişe mühendislik
- **Consignment (müşteri)** — fill-up, issue, return, pick-up
- **Returns & Credit/Debit Memo** — iade siparişi, iade teslimatı, alacak dekontu
- **Rebate / Settlement Management** — ciro primi, geriye dönük indirim
- **Intercompany Sales & Billing** — şirketler arası satış ve fatura
- **Contract / Scheduling Agreement** — çerçeve sözleşme, teslimat planı (otomotiv JIT/JIS)
- **Availability Check (ATP / aATP)** — backorder processing, product allocation
- **Credit Management (FSCM)** — kredi limiti, skorlama, blokaj
- **Output Determination** — sipariş teyidi, irsaliye, fatura çıktısı (form + kanal)

### 4.3 Plan-to-Produce / Design-to-Operate (Üretim)

```
Satış Planı (SOP) / IBP → Demand Management (PIR) → MRP (MD01/MD02, S/4'te MRP Live)
  → Planned Order → Production Order (discrete) / Process Order (proses) / Run Schedule (repetitive)
  → Availability Check (malzeme + kapasite + PRT) → Order Release (CO02)
  → Malzeme çekme (GI 261) → Operasyon Confirmation (CO11N: miktar, fire, süre)
  → [Her operasyon sonrası: Inspection Lot → Results Recording → Usage Decision]
  → Goods Receipt (GR 101) → Order Settlement (KO88) → Varyans analizi → Kapama (TECO/CLSD)
```

Üretim tipleri:
- **Discrete** — üretim emri, seri/parti izleme, montaj hattı
- **Repetitive** — üretim versiyonu + backflush, emirsiz üretim
- **Process (PP-PI)** — master recipe, proses emri, control recipe, PI sheet, batch
- **KANBAN** — çekme sistemi, kanban kartı, kontrol döngüsü
- **Lean / Takt** — hat dengeleme
- **PP/DS (APS)** — sonlu kapasite, sıralama optimizasyonu, kurulum matrisi
- **Capacity Planning** — kapasite yükü, tesviye (leveling), planlama tablosu
- **Costing** — ürün maliyet planlama (CK11N), maliyet tahmini, WIP, varyans kategorileri
  (girdi miktarı, fiyat, kaynak kullanımı, hurda, hurda oranı, verimlilik)
- **Batch Management & Derivation** — parti oluşturma, sınıflandırma, seçim, FIFO/FEFO
- **Serial Number Management** — seri numaralı izlenebilirlik
- **MES entegrasyonu** — SAP DMC / ME / MII / PEO ile saha bağı, makine telemetrisi

### 4.4 Record-to-Report (Finans ve Muhasebe)

**FI alt alanları:**
- **FI-GL** — Universal Journal (ACDOCA: S/4'ün tek satır tablosu), paralel defter, döviz
  tipleri (10/30/40), tekrarlayan kayıtlar, tahakkuk motoru, dönem kapama
- **FI-AP** — satıcı borçları, ödeme programı (F110), ödeme aracı, ihtar
- **FI-AR** — müşteri alacakları, tahsilat, ihtar, kredi yönetimi, alacak yaşlandırma
- **FI-AA** — sabit kıymet, amortisman alanları (yerel/IFRS/vergi), yatırım emri, kısmi
  kullanımdan kaldırma, düşük değerli kıymet
- **FI-BL** — banka defteri, ekstre okuma (MT940/CAMT), otomatik mutabakat, çek defteri
- **FI-TV** — seyahat yönetimi (veya Concur)
- **FI-SL** — özel defterler
- **FI-TX** — vergi hesaplama, KDV, tevkifat, vergi raporlama

**CO alt alanları:**
- **CO-OM-CEL** — masraf türü muhasebesi (S/4'te GL ile birleşti)
- **CO-OM-CCA** — masraf merkezi, dağıtım (distribution/assessment), aktivite fiyatı
- **CO-OM-OPA** — iç emirler (yatırım, tanıtım, bakım)
- **CO-ABC** — faaliyet tabanlı maliyetleme
- **CO-PC** — ürün maliyetleme: planlama (CO-PC-PCP), emir bazlı (CO-PC-OBJ), gerçek
  maliyet/malzeme defteri (CO-PC-ACT / Material Ledger, aktüel maliyet katmanları)
- **CO-PA** — kârlılık analizi (hesap bazlı / kalkülasyon bazlı), karakteristik ve değer alanı
- **EC-PCA** — kâr merkezi muhasebesi

**Diğer:**
- **Treasury & Risk (TRM)** — nakit yönetimi, likidite tahmini, para piyasası, döviz,
  türev, hedge muhasebesi, in-house cash
- **Group Reporting / Consolidation** — konsolidasyon, eliminasyon, para birimi çevrimi
- **Advanced Compliance Reporting (ACR)** — ülke bazlı yasal raporlama, e-belge
- **Financial Closing Cockpit** — kapama görev listesi ve takvimi
- **Document Splitting** — segment/kâr merkezi bazlı bilanço

### 4.5 Recruit-to-Retire / Hire-to-Retire (İK)

- **PA** — personel yönetimi, infotype yapısı (0000 aksiyon, 0001 org atama, 0002 kişisel,
  0006 adres, 0008 temel ücret, 0009 banka, 0014/0015 tekrarlayan/tek seferlik ödemeler...)
- **OM** — organizasyon yönetimi (O/S/C/P nesneleri, ilişkiler, org şeması)
- **PT** — zaman yönetimi: vardiya planı, çalışma takvimi, devamsızlık/mevcudiyet tipleri,
  zaman değerlendirme (RPTIME00), fazla mesai kuralları, izin tahakkuku
- **PY** — bordro: şema/kural motoru (PCR), ücret türleri, retroaktif hesaplama, yasal
  kesintiler, bordro sonrası muhasebeye aktarım
- **E-Recruiting / Learning / Performance / Compensation / Succession** — (bugün ağırlıklı
  olarak SuccessFactors)
- **ESS / MSS** — çalışan ve yönetici self servis
- **Türkiye lokalizasyonu:** SGK, e-bildirge, kıdem/ihbar tazminatı, AGİ, asgari geçim,
  gelir vergisi dilimleri, İşkur bildirimleri

### 4.6 Acquire-to-Decommission (Varlık ve Bakım — EAM/PM)

```
Arıza/İhtiyaç → Maintenance Notification (bildirim)
  → Maintenance Order (iş emri) → Planlama (operasyon, malzeme, kapasite, dış hizmet)
  → Release → Malzeme çekme + zaman kaydı → Confirmation
  → Teknik kapama (TECO) → Settlement → Ticari kapama
```
- **Preventive Maintenance** — bakım planı (zaman/sayaç/çoklu sayaç), strateji, paket
- **Condition-based / Predictive** — ölçüm noktası, sayaç, APM entegrasyonu
- **Refurbishment / Kalibrasyon (QM-PM)** — ölçüm cihazı doğrulama
- **Spare parts / Warranty / Service contract**
- **Linear Asset Management, GIS entegrasyonu**
- **Mobile maintenance** — saha uygulamaları

### 4.7 Idea-to-Market (Ar-Ge / PLM)
Portfolio & Project Management (PPM) · Document Management (DMS) · Engineering Change
Management · Recipe Development (proses endüstrileri) · Specification Management ·
Product Compliance · Variant Configuration · Handover to Manufacturing · Product
Lifecycle Costing

### 4.8 Depo (WM / EWM)
Inbound: teslimat bildirimi → mal kabul → putaway stratejisi → depolama
Outbound: dalga planlama (wave) → pick task → packing → staging → yükleme → PGI
Diğer: Handling Unit yönetimi, RF/mobil işlem, resource & task yönetimi, slotting,
rearrangement, sayım (cycle counting, annual), yard yönetimi, labor management,
kalite entegrasyonu, kit oluşturma, cross-docking, VAS (katma değerli hizmetler)

### 4.9 Taşıma (TM)
Freight unit oluşturma → yük planlama/konsolidasyon → taşıyıcı seçimi ve ihale (tendering)
→ freight order → yürütme ve takip → freight settlement (navlun mutabakatı) → maliyet dağıtımı

### 4.10 Dış Ticaret (GTS)
Compliance: taraf sınırlama listesi taraması (SPL), ambargo, ihracat lisansı
Customs: ihracat/ithalat beyanı, gümrük ambarı, transit (NCTS), Intrastat
Trade Preference: menşe hesabı, tedarikçi beyanı, serbest ticaret anlaşmaları

### 4.11 Proje (PS)
Proje tanımı → WBS hiyerarşisi → Network/aktivite → Milestone → Bütçe ve ödenek →
Satın alma/malzeme bağı → Zaman ve maliyet kaydı → Milestone/resource-related billing →
Result Analysis (RA) / POC → Settlement → Kapama

### 4.12 Servis (Customer Service / S/4 Service)
Servis sözleşmesi → Servis bildirimi → Servis siparişi → Saha ekibi planlama →
Yedek parça → Onarım siparişi (repair order) → Garanti kontrolü → Servis faturası →
Müşteri şikayeti / geri çağırma

---

## 5. Yatay (cross-cutting) yetenekler

Bunlar modül değildir ama SAP'yi "kurumsal" yapan şeydir. **KAELON için taklit edilmesi
zorunlu olan katman burasıdır.**

| Yetenek | SAP'de nasıl | KAELON karşılığı |
|---|---|---|
| **Yetkilendirme** | Rol → profil → yetki nesnesi → alan değeri; SU01/PFCG; SoD kuralları | Tool katmanında RBAC + field/metric-level |
| **Onay akışı** | Release strategy (PR/PO), SAP Business Workflow, Flexible Workflow | Approval Workspace, 8 durumlu state machine |
| **Görev ayrılığı (SoD)** | GRC Access Control kural seti | Tool authorization katmanı |
| **Değişiklik izi** | Change documents (CDHDR/CDPOS), tablo log | Immutable audit log |
| **Belge akışı** | Document flow (VBFA), belge zinciri | source_reference + document_links |
| **Çıktı yönetimi** | NAST/Output Management, Adobe Forms, SmartForms | Belge şablonları |
| **Entegrasyon** | IDoc, ALE, BAPI, RFC, OData, CPI/Integration Suite | Integration Adapter Layer |
| **Genişletme** | User-exit, BAdI, enhancement spot, key user extensibility, CDS | Capability Pack + Workshop |
| **Taşıma/versiyon** | Transport request, STMS, 3 sistemli manzara (DEV/QAS/PRD) | CI/CD + prompt versiyonlama |
| **Analitik** | CDS view, embedded analytics, SAC, BW | Semantic Metrics Layer |
| **Arşivleme** | ILM, veri arşivleme nesneleri | Raw layer + saklama politikası |
| **Toplu işler** | SM36/SM37 job planlama | BullMQ kuyruk |
| **Lokalizasyon** | Ülke versiyonları, ACR, e-belge çerçevesi | Ülke Capability Pack |

---

## 6. Endüstri çözümleri

SAP'nin 25+ sektör paketi vardır. KAELON'un hedef sektörlerine karşılık gelenler:

| SAP çözümü | Kapsam | KAELON'daki karşılığı |
|---|---|---|
| **IS-Auto (DIMP)** | JIT/JIS çağrıları, tedarikçi teslimat planı, konsinye, uzun dönem tedarik | Otomotiv/Treyler Capability Pack |
| **AFS / FMS (Fashion)** | Beden×renk matrisi, sezon, tahsis (allocation), varyant | Tekstil Capability Pack |
| **IS-Mill / Mill Products** | Boyut karakteristikli stok, çok boyutlu ölçü | — |
| **IS-Retail** | Ürün grubu, asortiman, mağaza, promosyon, ikmal | — |
| **Process Industries (PP-PI)** | Reçete, parti, HACCP izlenebilirliği, raf ömrü | Gıda Capability Pack |
| **EHS / Product Compliance** | Tehlikeli madde, MSDS, mevzuat uyumu | v3+ |
| **IS-Oil, IS-U, IS-H, DFPS...** | Petrol, enerji, sağlık, savunma | Kapsam dışı |

**Kritik gözlem:** SAP'de yeni bir sektör paketi 2–3 yıl sürer. KAELON'un Capability Pack
tezi bunu 4–8 haftaya indirmeyi hedefliyor. Bu iddianın tek şartı çekirdeğin gerçekten
%90 ortak olmasıdır — Vizyon v4'teki 8 adımlı evrensel akış (sipariş kararı → hammadde →
mal kabul → üretim → ara gate → final kalite → sevkiyat → finansal kapanış) bu iddianın
temelidir ve doğrudur.

---

## 7. SAP'nin AI katmanı (2026 itibarıyla)

- **Joule** — S/4HANA, BTP, SuccessFactors, Ariba, Sales/Service Cloud'a gömülü asistan;
  doğal dil sorgu, navigasyon, işlem başlatma
- **400+ gömülü AI use-case** (SAP beyanı, 2025 sonu)
- **~40 Joule ajanı / ~2.400 beceri** (2026)
- **Joule Studio** — müşterinin kendi ajanını tasarlaması için ortam
- **Joule for Developers** — ABAP kod üretimi, entegrasyon akışı, Build otomasyonu
- Örnek ajanlar: fatura eşleştirme, alacak tahsilat, masraf fişi okuma, varyans analizi,
  tedarik önerisi

> **KAELON için acımasız gerçek:** SAP'nin AI'ı "sonradan eklendi" argümanı 2024'te
> geçerliydi, 2026'da giderek zayıflıyor. Joule artık işlem başlatabiliyor. KAELON'un
> savunulabilir farkı **AI'ın varlığı değil**, üç şeyin birleşimidir: (1) chat-first tek
> arayüz — Joule hâlâ 7.500 Fiori uygulamasının yanında duran bir yardımcı, (2) dışa kapalı
> veri egemenliği, (3) Türkiye mevzuatı + üretim sahası derinliği + $15/kullanıcı fiyat.

---

## 8. KAELON ↔ SAP kapsam eşleştirmesi

| SAP alanı | KAELON v1 | v2–v3 | Bilinçli kapsam dışı |
|---|---|---|---|
| Org yapısı (company code, plant, sloc) | ✅ sadeleştirilmiş | çok tesis/tüzel kişilik | controlling area, operating concern |
| Material master (20 view) | ✅ tek nesne, rol bazlı alan grupları | sektörel alanlar | — |
| BP / Customer / Vendor | ✅ + Entity Resolution | — | MDG düzeyi yönetişim |
| BOM / Routing / Work Center | ✅ (Configured BOM dahil) | rate routing, PRT | — |
| Variant Configuration | ✅ configurator (basit) | kısıt ağı, AVC | 3D konfigüratör |
| MRP | ⚠️ malzeme eksikliği uyarısı | MRP Live eşdeğeri | sonlu kapasite (PP/DS) |
| Üretim emri + kalite gate | ✅ **çekirdek fark** | proses emri, KANBAN | — |
| Repetitive / backflush | — | ✅ | — |
| Ürün maliyetleme (CO-PC) | ⚠️ gerçek maliyet izleme | tam standart+aktüel | Material Ledger derinliği |
| CO-PA kârlılık | ⚠️ Boss Mode gerçek kârlılık | ✅ | çok boyutlu operating concern |
| WM / EWM | ✅ WMS Lite | raf/parti/seri, sayım | dalga planlama, slotting, labor mgmt |
| QM (inspection lot, UD) | ✅ Quality Gate Lite | sertifika, NCR, denetim | stabilite, kalibrasyon |
| PM / EAM | — | ✅ Maintenance Core | linear asset, GIS |
| SD (order-to-cash) | ✅ teklif→sipariş | sevkiyat, rebate, konsinye | intercompany, allocation |
| MM (source-to-pay) | ✅ PR→PO→GR→IR 3-way | fason, konsinye, STO | Ariba düzeyi kaynak bulma |
| FI-GL / AP / AR | ⚠️ görünürlük | mizan, cari, fiş taslağı | tam muhasebe motoru |
| FI-AA | — | — | ✅ kapsam dışı |
| CO-OM (masraf merkezi) | ⚠️ temel | dağıtım | assessment/distribution döngüleri |
| Treasury / TRM | ⚠️ banka+çek+kredi görünürlük | nakit projeksiyon | türev, hedge muhasebesi |
| Bordro (PY) | — partner | veri alışverişi | ✅ kapsam dışı (partner) |
| Zaman yönetimi (PT) | ✅ puantaj, mesai, izin | vardiya optimizasyonu | — |
| PS (proje) | — | ✅ proje bazlı üretim | tam PS/network |
| TM (taşıma) | — | sevkiyat planı | tam TM |
| GTS (dış ticaret) | — | ✅ Foreign Trade Core | SPL taraması |
| Group Reporting | — | — | ✅ kapsam dışı |
| Workflow / onay | ✅ Approval Workspace | esnek workflow tasarımcısı | — |
| Audit / değişiklik izi | ✅ immutable log | — | — |
| Analitik | ✅ Semantic Metrics | — | BW/SAC düzeyi |
| **Boss Mode** | ✅ | — | **SAP'de karşılığı yok** |
| **Veri güven skoru** | ✅ | — | **SAP'de karşılığı yok** |
| **Chat-first tek arayüz** | ✅ | — | **SAP'de karşılığı yok** |
| **Open Exit** | ✅ | — | **SAP'de karşılığı yok** |

---

## 9. SAP'den alınacak dersler — KAELON kararları

**Taklit edilmesi zorunlu (bunlar olmadan "kurumsal" olunmuyor):**
1. Belge akışı (document flow) — her belgenin öncesi ve sonrası zincirle bağlı
2. Koşul tekniği mantığı — fiyat/indirim/vergi tek motorla, kural olarak
3. Hareket tipi (movement type) disiplini — her stok hareketinin tipi ve muhasebe karşılığı
4. Release strategy — çok kademeli, tutar/tip bazlı onay
5. Org yapısı — en azından tüzel kişilik + tesis + depo
6. Parti/seri izlenebilirliği — ileri ve geri iz sürme
7. Dönem kapama disiplini — açık/kapalı dönem, geriye kayıt kontrolü
8. Değişiklik belgeleri — kim neyi ne zaman değiştirdi

**Bilinçli olarak yapılmayacaklar (SAP'nin ağırlığı buradan geliyor):**
1. 20 görünümlü malzeme kartı → rol bazlı kademeli açılan tek kart
2. Controlling area / operating concern / credit control area gibi ayrı org katmanları
3. Customizing (IMG) ağacı → Workshop no-code/low-code katmanı
4. Transaction code ezberi → doğal dil
5. Kullanıcıyı forma uydurma → niyeti akışa çevirme
6. Modül lisansı → tek fiyat, kullanıcı başı

**SAP'nin yapamadığı ve KAELON'un yapacağı:**
1. Tek soru = tek cevap (SAP'de 4 kişiye sor, 10 ekran aç, 2 saat)
2. Patron-yüzü gerçeklik katmanı (Boss Mode)
3. Verinin ne kadar güvenilir olduğunu söylemek (Data Quality Score)
4. Sahaya yayılabilir fiyat → gerçek saha verisi
5. Sektör paketi 2–3 yıl yerine 4–8 hafta
6. Veriyi rehin tutmamak (Open Exit)

---

## 10. Kaynaklar

- ERP Research — SAP S/4HANA Modules: https://www.erpresearch.com/en-us/sap-s/4-hana-modules
- Wikipedia — SAP ERP: https://en.wikipedia.org/wiki/SAP_ERP
- SAP Learning — Understanding SAP's End-to-End Business Processes: https://learning.sap.com/courses/introducing-sap-s-core-business-processes-sap-for-industries-and-the-sap-partner-network/understanding-sap-s-end-to-end-business-processes
- Scheer IDS — S/4HANA Cloud Best Practices Scope Details (850 scope item): https://scheer-ids-netherlands.com/s4hc-explained-best-practices-scope-details/
- SAP Fiori Apps Reference Library: https://fal.cloud.sap/
- SAVIC — SAP Joule Agentic Platform 2026: https://www.savictech.com/insights/sap-joule-agentic-platform-40-agents-2026/
- TechTarget — SAP S/4HANA modules and LOBs: https://www.techtarget.com/searchsap/tip/A-short-guide-to-primary-SAP-S-4HANA-modules-and-LOBs
- Tipalti — SAP Business One Modules: https://tipalti.com/blog/sap-business-one-modules/
- SAP Signavio Process Navigator (scope item kataloğu, giriş gerektirir): https://me.sap.com/processnavigator
