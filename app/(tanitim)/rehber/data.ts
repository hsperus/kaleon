/**
 * Rehberin içeriği — veri olarak.
 *
 * METİN JSX'İN İÇİNE GÖMÜLMÜYOR, KASITLI. Rehber uzun ve büyük kısmı
 * aynı biçimde tekrarlanan bloklardan oluşuyor: bir süreç, adımları,
 * örnek cümleler. Bunları JSX'e gömmek, aynı düzeni otuz kez elle
 * yazmak demekti — ve otuz kopyadan biri er ya da geç ötekilerden
 * ayrışırdı.
 *
 * Ayrıca içerik burada durunca, sayfanın kendisi yalnızca BİÇİMLE
 * ilgileniyor ve ikisi ayrı ayrı okunabiliyor.
 */

export interface Adim {
  readonly no: string;
  readonly baslik: string;
  readonly metin: string;
  /** Kullanıcının yazacağı cümle. */
  readonly ornek?: string;
  /** Bu adımda çalışan tool — kullanıcı adını görmese de biz yazıyoruz. */
  readonly tool?: string;
  /** Onay kapısından geçer mi. */
  readonly onay?: boolean;
}

export interface Surec {
  readonly kod: string;
  readonly ad: string;
  readonly ozet: string;
  readonly adimlar: readonly Adim[];
  /** Bu süreçte en sık yapılan hata. */
  readonly tuzak?: string;
}

/*
 * SÜREÇLER, BELGE ZİNCİRİ SIRASIYLA.
 *
 * ERP rehberleri genellikle MODÜL sırasıyla yazılır (önce FI, sonra
 * MM, sonra SD) çünkü yazılım öyle bölünmüştür. Ama kullanıcı
 * modülde çalışmaz, SÜREÇTE çalışır: teklif verir, sipariş alır, mal
 * gönderir, fatura keser, parayı tahsil eder. Sıra burada odur.
 */
export const SURECLER: readonly Surec[] = [
  {
    kod: "S1",
    ad: "Müşteriden paraya: satış zinciri",
    ozet:
      "Teklif → sipariş → sevkiyat → fatura → e-Fatura → tahsilat. Her halka bir " +
      "öncekine bağlı; zincirin ortasından başlanamaz ve bu kasıtlıdır: sevk " +
      "edilmemiş malın faturası, mutabakatta çözülemeyen bir farktır.",
    adimlar: [
      {
        no: "1",
        baslik: "Müşteri kartı",
        metin:
          "Cari yoksa önce açılır. Vergi numarası e-Fatura için zorunludur; " +
          "girilmezse kart açılır ama fatura kesilemez ve sistem bunu kart " +
          "açılırken söyler.",
        ornek: "Kuehne + Nagel diye yeni müşteri aç, vergi no 5810012345, İstanbul Tuzla",
        tool: "create_partner",
        onay: true,
      },
      {
        no: "2",
        baslik: "Kredi limiti",
        metin:
          "Müşteriye limit tanımlanır. Limit yoksa sistem 'belirlenmemiş' der ve " +
          "uyarır — sınırsız saymaz. Risk üç parçadan oluşur: vadesi geçmiş " +
          "alacak, açık fatura ve SEVK EDİLMEMİŞ SİPARİŞ.",
        ornek: "Kuehne + Nagel'e 2 milyon TL kredi limiti tanımla",
        tool: "set_credit_limit",
        onay: true,
      },
      {
        no: "3",
        baslik: "Teklif",
        metin:
          "Fiyat, miktar ve geçerlilik süresiyle teklif hazırlanır. Teklif " +
          "kabul edilince siparişe dönüşür; dönüşüm izlenir, kaç teklifin kaçı " +
          "siparişe döndü sorulabilir.",
        ornek: "Kuehne + Nagel'e 40 ton genel kargo için teklif hazırla",
        tool: "create_sales_quotation",
        onay: true,
      },
      {
        no: "4",
        baslik: "Teslim tarihi taahhüdü",
        metin:
          "Söz vermeden önce sorulur. Sistem serbest stoğa, yoldaki mala ve " +
          "temin süresine bakar. TEMİN SÜRESİ BİLİNMİYORSA TARİH VERMEZ — " +
          "'tahminen üç hafta' demek bir taahhüttür ve sözleşme cezasına bağlanır.",
        ornek: "500 adet FR-22'yi ne zaman gönderebiliriz",
        tool: "check_availability",
      },
      {
        no: "5",
        baslik: "Sipariş",
        metin:
          "Teklif siparişe dönüşür ya da doğrudan sipariş girilir. Gecikme " +
          "cezası ve tavanı burada tanımlanır; termin riski bu sayılardan " +
          "hesaplanır.",
        ornek: "TKF-2026-0012 numaralı teklifi siparişe çevir",
        tool: "convert_quotation_to_order",
        onay: true,
      },
      {
        no: "6",
        baslik: "Sevkiyat",
        metin:
          "Mal çıkışı yapılır; stok düşer, irsaliye oluşur. Kısmi sevkiyat " +
          "normaldir ve kalan miktar takip edilir — imalatta kısmi sevkiyat " +
          "istisna değil kuraldır.",
        ornek: "SIP-2026-0044 için 200 adet sevk et, plaka 34 ABC 123",
        tool: "post_delivery",
        onay: true,
      },
      {
        no: "7",
        baslik: "Fatura",
        metin:
          "Sevk edilen miktar faturalanır. Dövizli faturada KUR AÇIKÇA " +
          "VERİLİR, sistem aramaz: faturaya yazılan kur bir karardır, belgeye " +
          "basılır ve sonradan değişmez.",
        ornek: "İRS-2026-0031'i faturalandır",
        tool: "issue_sales_invoice",
        onay: true,
      },
      {
        no: "8",
        baslik: "e-Fatura",
        metin:
          "UBL-TR 1.2 belgesi üretilir. Alıcı e-Fatura mükellefiyse e-Fatura, " +
          "değilse e-Arşiv. Yanlış seçim belgeyi geçersiz kılar; sistem " +
          "mükellefiyet bilinmiyorsa belge üretmez.",
        ornek: "FTR2026000012 için e-Fatura belgesi üret",
        tool: "build_einvoice_document",
        onay: true,
      },
      {
        no: "9",
        baslik: "Tahsilat",
        metin:
          "Gelen para faturalara dağıtılır. Dağıtılmayan tutar hiçbir faturaya " +
          "bağlanmaz ve mutabakatta çözülemez; bu yüzden tutarın TAMAMI " +
          "dağıtılmak zorundadır.",
        ornek: "Kuehne + Nagel'den 250.000 TL tahsilat, FTR2026000012'ye",
        tool: "post_payment",
        onay: true,
      },
    ],
    tuzak:
      "En sık hata: sevk edilmeden fatura kesmek. Sistem buna izin vermez ve " +
      "sebebi şu — sevk edilmemiş malın faturası, cari mutabakatında hiçbir " +
      "belgeyle eşleşmeyen bir bakiye bırakır.",
  },

  {
    kod: "S2",
    ad: "Talepten ödemeye: satın alma zinciri",
    ozet:
      "Talep → onay → teklif toplama → sipariş → mal kabul → fatura → üç yönlü " +
      "mutabakat → ödeme. Kontrol noktaları burada yoğunlaşır çünkü para bu " +
      "zincirde çıkar.",
    adimlar: [
      {
        no: "1",
        baslik: "Satın alma talebi",
        metin:
          "İhtiyaç sahibi talep açar. Tahmini tutar onay seviyesini belirler; " +
          "tutar arttıkça onaylayan makam yükselir.",
        ornek: "Eylül uçuş programı için 1.400.000 litre Jet A-1 talebi aç",
        tool: "create_purchase_requisition",
        onay: true,
      },
      {
        no: "2",
        baslik: "Onay",
        metin:
          "Talebi açan onaylayamaz. Bu bir yetki meselesi değil GÖREVLER " +
          "AYRILIĞIDIR: aynı kişi hem isteyip hem onaylarsa kontrol diye bir " +
          "şey kalmaz.",
        ornek: "TLP-2026-0007'yi onayla",
        tool: "approve_purchase_requisition",
        onay: true,
      },
      {
        no: "3",
        baslik: "Teklif toplama",
        metin:
          "En az iki tedarikçiden teklif istenir. Tek teklifle sipariş vermek " +
          "bir karar değil bir alışkanlıktır; iki teklif olduğunda fiyat farkı " +
          "görünür hâle gelir.",
        ornek: "Jet A-1 için üç tedarikçiden teklif iste",
        tool: "create_purchase_rfq",
        onay: true,
      },
      {
        no: "4",
        baslik: "Teklif karşılaştırma ve seçim",
        metin:
          "Teklifler yan yana konur. EN UCUZ SEÇİLMEDİYSE GEREKÇE ZORUNLUDUR — " +
          "gerekçesiz bir tercih, altı ay sonra kimsenin hatırlamadığı bir " +
          "tercihtir.",
        ornek: "RFQ-2026-0003 tekliflerini karşılaştır",
        tool: "compare_supplier_quotes",
      },
      {
        no: "5",
        baslik: "Sipariş ve termin",
        metin:
          "Sipariş açılır ve tedarikçinin verdiği TERMİN yazılır. Termin " +
          "yazılmazsa o mal teslim taahhüdüne giremez: 'yolda 500 adet var' " +
          "cümlesi, ne zaman geleceği bilinmiyorsa müşteriye söylenemez.",
        ornek: "TLP-2026-0007'yi Petrol Ofisi'ne sipariş et",
        tool: "convert_requisition_to_order",
        onay: true,
      },
      {
        no: "6",
        baslik: "Mal kabul",
        metin:
          "Gelen mal sayılır ve stoğa alınır. Muhasebe kaydı burada oluşur; " +
          "stok değeri hareketli ortalamayla güncellenir.",
        ornek: "SAS-2026-0011 için 1.400.000 litre mal kabul yap",
        tool: "post_goods_receipt",
        onay: true,
      },
      {
        no: "7",
        baslik: "Üç yönlü mutabakat",
        metin:
          "Sipariş, irsaliye ve fatura karşılaştırılır. Fark varsa fatura " +
          "BLOKE edilir ve bloke fatura ödenemez. Blokeyi çözmek, farkı " +
          "açıklamak demektir.",
        ornek: "GF-2026-4488 faturasını siparişle eşleştir",
        tool: "match_invoice",
        onay: true,
      },
      {
        no: "8",
        baslik: "Ödeme koşusu",
        metin:
          "Eldeki nakitle hangi faturaların ödeneceği sıralanır: en çok " +
          "gecikmiş önce. Bloke fatura önerilmez, kısmi ödeme yapılmaz, kasa " +
          "tabanının altına inilmez. BU BİR ÖNERİDİR — bankaya talimat gitmez.",
        ornek: "Elimizdeki parayla kime ödeyelim, kasada 15 milyon kalsın",
        tool: "plan_payment_run",
      },
    ],
    tuzak:
      "En sık hata: bloke faturayı 'acil' diye ödemek. Sistem engeller. Blokenin " +
      "sebebi çözülmeden yapılan ödeme, üç yönlü mutabakatın tamamını boşa " +
      "çıkarır — kontrolü bir kez atlarsanız bir daha hiç bakmazsınız.",
  },

  {
    kod: "S3",
    ad: "Üretim ve kalite",
    ozet:
      "Rota → iş emri → operasyon → kalite → maliyet. Rota, iş emrinin " +
      "doğrusudur: onsuz bir süre yanlış girildiğinde karşılaştırılacak bir " +
      "şey olmaz.",
    adimlar: [
      {
        no: "1",
        baslik: "Rota",
        metin:
          "Ürünün hangi iş merkezlerinde, hangi sürelerde üretildiği tanımlanır. " +
          "HAZIRLIK PARTİ BAŞINA, İŞLEME ADET BAŞINA girilir — bu ayrım, küçük " +
          "siparişin neden pahalı olduğunu açıklar.",
        ornek: "FR-22 için rota tanımla: testere 15 dk hazırlık, CNC 45 dk hazırlık",
        tool: "create_routing",
        onay: true,
      },
      {
        no: "2",
        baslik: "Süre ve kapasite",
        metin:
          "Bir parti için toplam süre ve darboğaz hesaplanır. Birim süre parti " +
          "büyüklüğüne göre değişir; 10 adet ile 1000 adet aynı birim süreye " +
          "sahip değildir.",
        ornek: "500 adet FR-22 kaç saat sürer",
        tool: "get_routing_load",
      },
      {
        no: "3",
        baslik: "İş emri",
        metin:
          "Üretim emri açılır ve serbest bırakılır. Malzeme rezerve edilir, " +
          "kapasite yüklenir.",
        ornek: "FR-22'den 500 adet için iş emri aç",
        tool: "release_work_order",
        onay: true,
      },
      {
        no: "4",
        baslik: "Operasyon onayı",
        metin:
          "Operatör yaptığı işi bildirir: kaç adet, kaç dakika, ne kadar fire. " +
          "Gerçekleşen maliyet buradan birikir.",
        ornek: "İE-2026-0044 CNC operasyonunu 480 adet olarak onayla",
        tool: "confirm_operation",
        onay: true,
      },
      {
        no: "5",
        baslik: "Kalite kontrolü",
        metin:
          "Kontrol planındaki her özellik ölçülür. GEÇTİ/KALDI KARARI ELLE " +
          "GİRİLMEZ, toleranstan türetilir. Kritik bir özellik saparsa parti " +
          "reddedilir; kritik olmayanda şartlı kabul mümkündür.",
        ornek: "HYD-2026-0412 partisini muayene et: viskozite 13.4, su 85 ppm",
        tool: "record_inspection_result",
        onay: true,
      },
      {
        no: "6",
        baslik: "Uygunsuzluk",
        metin:
          "Sapma çıkarsa sistem uygunsuzluk kaydını KENDİSİ açar. Kök neden ve " +
          "düzeltici faaliyet yazılmadan kapatılamaz — sebebini yazmadan " +
          "kapatmak, aynı hatanın üç ay sonra tekrarını garanti eder.",
        ornek: "UYG-2026-0002'yi kapat: conta hatası, tedarikçiden nem raporu istenecek",
        tool: "close_nonconformance",
        onay: true,
      },
      {
        no: "7",
        baslik: "Maliyet sapması",
        metin:
          "Standart maliyetle gerçekleşen karşılaştırılır ve sapma MALZEME / " +
          "İŞÇİLİK / GENEL GİDER olarak ayrılır. Malzeme sapması satın almanın, " +
          "işçilik sapması üretimin işidir.",
        ornek: "FR-22'nin bu partideki maliyet sapması ne",
        tool: "get_cost_variance",
      },
    ],
    tuzak:
      "En sık hata: muayeneyi eksik yapmak. Planda beş özellik varsa beşi de " +
      "ölçülmeli; sistem dördüyle 'geçti' demez. Ölçülmeyen bir özelliğin " +
      "sapmadığını varsaymak, muayenenin kendisini boşa çıkarır.",
  },

  {
    kod: "S4",
    ad: "Muhasebe ve dönem kapama",
    ozet:
      "Fiş → mizan → mali tablolar → mutabakat → kapama. Rakamlar buradan " +
      "çıkar; bu yüzden en çok kontrol burada.",
    adimlar: [
      {
        no: "1",
        baslik: "Yevmiye fişi",
        metin:
          "Elle fiş atılır. Borç ve alacak eşit olmak zorunda; 120/320 gibi " +
          "cari hesaplarda hangi cariye ait olduğu ZORUNLUDUR. Gider " +
          "hesabında masraf merkezi yazılır.",
        ornek: "Ağustos yakıt giderini 730'a yaz, masraf merkezi UCS-YKT",
        tool: "post_journal_entry",
        onay: true,
      },
      {
        no: "2",
        baslik: "Mizan",
        metin:
          "Borç ve alacak toplamları karşılaştırılır. MİZANIN DENK OLMASI " +
          "BİLANÇONUN DENK OLDUĞU ANLAMINA GELMEZ — mizan fişleri denetler, " +
          "bilanço dönemi.",
        ornek: "Ağustos mizanını çıkar",
        tool: "get_trial_balance",
      },
      {
        no: "3",
        baslik: "Banka mutabakatı",
        metin:
          "Ekstre yüklenir, sistem aday ödemeler ÖNERİR, kapatan insandır. " +
          "Tutarı tutmayan ödeme aday bile sayılmaz. Eşleşmemiş hareket, " +
          "defterdeki bakiyenin gerçekten saptığı anlamına gelir.",
        ornek: "Ağustos ekstresini yükle ve eşleşmeyenleri göster",
        tool: "import_bank_statement",
        onay: true,
      },
      {
        no: "4",
        baslik: "Mali tablolar",
        metin:
          "Bilanço, gelir tablosu ve nakit akış tablosu. Üçü de denklik " +
          "kontrolünden geçer; tutmuyorsa sistem rakamı verir ama 'bu tablo " +
          "kullanılmamalı' der.",
        ornek: "2026 nakit akış tablosunu çıkar",
        tool: "get_cash_flow_statement",
      },
      {
        no: "5",
        baslik: "Bütçe–gerçekleşme",
        metin:
          "Masraf merkezi bazında bütçe ile harcama karşılaştırılır. Bütçesi " +
          "girilmemiş gider 'aşım' sayılmaz, ayrıca bildirilir; merkezi " +
          "yazılmamış gider rapora hiç girmez ve tutarı söylenir.",
        ornek: "Bütçeyi aşan departman var mı",
        tool: "get_budget_vs_actual",
      },
      {
        no: "6",
        baslik: "Kur değerlemesi",
        metin:
          "VUK 280 gereği dövizli bakiyeler dönem sonunda değerlenir. Kur " +
          "bilinmiyorsa değerleme YAPILMAZ — eksik kurla yapılan değerleme, " +
          "yanlış bir kâr/zarar üretir.",
        ornek: "Ağustos sonu kur değerlemesini önizle",
        tool: "preview_fx_revaluation",
      },
      {
        no: "7",
        baslik: "Dönem kapama",
        metin:
          "Ay kapanır ve o aya kayıt girilemez. KURAL HERKESE AÇIKTIR, patron " +
          "dahil: 'patron kapalı aya yazabilsin' demek, kuralı hiç koymamakla " +
          "aynı şeydir.",
        ornek: "Ağustos dönemini kapat",
        tool: "close_period",
        onay: true,
      },
    ],
    tuzak:
      "En sık hata: mizan denk diye bilançoya bakmamak. Bu projede tam olarak " +
      "bu yüzden bir hata canlıda kaldı — mizan denkti, bilanço 941 milyon açık " +
      "veriyordu. Sistem artık her mali çıktının sağlamasını kendisi yapıyor.",
  },

  {
    kod: "S5",
    ad: "Stok, depo ve izlenebilirlik",
    ozet:
      "Hareket → sayım → parti/seri → raf. Stok, üzerinde en çok konuşulan ve " +
      "en az güvenilen sayıdır; buradaki kurallar onu güvenilir kılmak için.",
    adimlar: [
      {
        no: "1",
        baslik: "Stok hareketi",
        metin:
          "Giriş, çıkış ve transfer kaydedilir. Her hareket bir belgeye bağlıdır; " +
          "belgesiz hareket, sonradan kimsenin açıklayamadığı bir farktır.",
        ornek: "IST-TEK'ten IST-KRG'ye 50 adet ULD transfer et",
        tool: "post_stock_movement",
        onay: true,
      },
      {
        no: "2",
        baslik: "Raf yönetimi",
        metin:
          "Lokasyon 'hangi depo', raf 'depoda nerede' sorusunun cevabıdır. Rafı " +
          "yazılmamış stok ayrıca bildirilir — bir rafa dağıtmak uydurma olurdu.",
        ornek: "IST-TEK deposunda hangi rafta ne var",
        tool: "get_bin_contents",
      },
      {
        no: "3",
        baslik: "Sayım",
        metin:
          "Sayım açılır, sayılır, fark raporlanır. Fark otomatik düzeltilmez: " +
          "önce bakılır, sonra düzeltme fişi atılır ve o fişin bir gerekçesi olur.",
        ornek: "IST-KRG'de ULD sayımı aç",
        tool: "open_stock_count",
        onay: true,
      },
      {
        no: "4",
        baslik: "Parti ve seri takibi",
        metin:
          "Raf ömürlü malzeme partiyle, rotable parça seriyle izlenir. Geriye " +
          "ve ileriye izleme: bir parti nereden geldi, nerelere gitti.",
        ornek: "HYD-2026-0412 partisi hangi iş emirlerinde kullanıldı",
        tool: "trace_batch_forward",
      },
      {
        no: "5",
        baslik: "Analiz sertifikası",
        metin:
          "Müşteri sertifika isterse ölçüm değerleriyle üretilir. MUAYENE KAYDI " +
          "YOKSA SERTİFİKA ÜRETİLMEZ — ölçüm olmadan sertifika, imzalanmış bir " +
          "varsayımdır.",
        ornek: "HYD-2026-0412 için analiz sertifikası hazırla",
        tool: "build_certificate_of_analysis",
      },
    ],
    tuzak:
      "En sık hata: sayım farkını 'düzeltip geçmek'. Fark bir bilgidir: fire mi, " +
      "hırsızlık mı, yanlış kayıt mı? Düzeltme fişi sebebini taşımıyorsa aynı " +
      "fark her sayımda tekrar eder.",
  },

  {
    kod: "S6",
    ad: "İnsan kaynakları ve bordro",
    ozet:
      "Kadro → izin/vardiya → puantaj → bordro. Mevzuat burada en yoğun ve " +
      "hata en pahalı: yanlış bordro, hem çalışana hem SGK'ya karşı sorumluluk " +
      "doğurur.",
    adimlar: [
      {
        no: "1",
        baslik: "Personel kartı",
        metin:
          "Çalışan tanımlanır. Doğum tarihi girilmezse sistem uyarır: 18 yaş " +
          "altı ve 50 yaş üstü izin kademesi buna bağlıdır ve eksik tarih hakkı " +
          "eksik hesaplatır.",
        ornek: "Serkan Aydın'ı kaptan pilot olarak kaydet, brüt 485.000",
        tool: "create_employee",
        onay: true,
      },
      {
        no: "2",
        baslik: "İzin",
        metin:
          "Talep girilir, bakiyeden düşülür. İK kendi talebini onaylayamaz. " +
          "Yıllık izin hakkı kıdeme ve yaşa göre İş Kanunu 4857'ye uygun " +
          "hesaplanır.",
        ornek: "Serkan Aydın 5 gün yıllık izin talep ediyor",
        tool: "request_leave",
        onay: true,
      },
      {
        no: "3",
        baslik: "Vardiya ve mesai",
        metin:
          "Vardiya planlanır, PDKS kayıtları okunur. Fazla mesai hafta içi ve " +
          "hafta sonu AYRI tutulur çünkü çarpanları farklıdır.",
        ornek: "Bu haftanın vardiya planını göster",
        tool: "get_weekly_shift_plan",
      },
      {
        no: "4",
        baslik: "Bordro provası",
        metin:
          "Bordro önce SİMÜLE edilir: kim ne alacak, ne kesilecek. Çalıştırmadan " +
          "önce görülür çünkü çalıştırılan bordro muhasebe kaydı yazar ve ödeme " +
          "yükümlülüğü doğurur.",
        ornek: "Ağustos bordrosunu simüle et",
        tool: "simulate_payroll",
      },
      {
        no: "5",
        baslik: "Bordro",
        metin:
          "2026 parametreleriyle çalıştırılır: asgari ücret istisnası, SGK " +
          "taban–tavan, kümülatif gelir vergisi matrahı ve damga vergisi. " +
          "Kümülatif matrah yüzünden net maaş yıl içinde DÜŞER; bu bir hata " +
          "değil, mevzuatın kendisidir.",
        ornek: "Ağustos bordrosunu çalıştır",
        tool: "run_payroll",
        onay: true,
      },
    ],
    tuzak:
      "En sık hata: bir ayın net maaşını 12 ile çarpıp yıllık gelir sanmak. " +
      "Gelir vergisi kümülatif matraha göre hesaplanır: Ocak'ta %15'ten kesilen " +
      "bir çalışan Aralık'ta %27'ye gelmiş olabilir.",
  },
];

/* ── SORGULAMA ÖRNEKLERİ ── */

export interface Ornek {
  readonly soru: string;
  readonly ne: string;
}

export interface OrnekGrup {
  readonly baslik: string;
  readonly aciklama: string;
  readonly ornekler: readonly Ornek[];
}

/*
 * ÖRNEKLER GERÇEK CÜMLELER.
 *
 * ERP rehberlerindeki örnekler genellikle "MM03 işlem kodunu girin"
 * biçimindedir — yani yazılımın diliyle. Burada kullanıcının kendi
 * cümlesi yazılı, çünkü sistem onu bekliyor.
 */
export const SORGULAR: readonly OrnekGrup[] = [
  {
    baslik: "Patronun günlük soruları",
    aciklama: "Rapor beklemeden, ekran gezmeden sorulabilenler.",
    ornekler: [
      { soru: "Bu ay kâr ettik mi?", ne: "Gelir tablosu; ciro, maliyet, brüt ve net kâr." },
      { soru: "Önümüzdeki ay nakit sıkışır mıyız?", ne: "Haftalık nakit projeksiyonu ve açık haftası." },
      { soru: "Kâr var ama para yok, nereye gitti?", ne: "Nakit akış tablosu — dolaylı yöntem." },
      { soru: "Bütçeyi aşan departman var mı?", ne: "Masraf merkezi bazında bütçe–gerçekleşme." },
      { soru: "Kime ne kadar borcumuz var?", ne: "Açık tedarikçi faturaları, vadesine göre." },
      { soru: "En çok hangi müşteriden alacağımız var?", ne: "Alacak yaşlandırma, cari kırılımıyla." },
      { soru: "Hangi tedarikçi geciktiriyor?", ne: "Tedarikçi karnesi: termin, miktar, fiyat." },
    ],
  },
  {
    baslik: "Mali müşavirin istedikleri",
    aciklama: "Beyanname ve denetim için gereken belgeler.",
    ornekler: [
      { soru: "Ağustos mizanını çıkar", ne: "TDHP hesap bazında borç/alacak ve bakiye." },
      { soru: "Bilanço ve gelir tablosu", ne: "Denklik kontrolüyle birlikte." },
      { soru: "e-Defter dosyalarını hazırla", ne: "Yevmiye ve kebir XBRL-GL, GİB biçiminde." },
      { soru: "KDV beyannamesi taslağı", ne: "Hesaplanan ve indirilecek KDV, dönem bazında." },
      { soru: "Şu carinin ekstresi", ne: "Yürüyen bakiyeyle satır satır hareket." },
      { soru: "Amortismanı çalıştır", ne: "VUK 315/320, kıst amortisman dahil." },
    ],
  },
  {
    baslik: "Üretim ve depo",
    aciklama: "Sahadan gelen sorular.",
    ornekler: [
      { soru: "Hangi siparişler gecikecek?", ne: "Gerçek üretim akışından hesaplanan risk." },
      { soru: "Hangi makineler duruyor?", ne: "Anlık makine durumu ve arıza kayıtları." },
      { soru: "Bu malzemeden ne kadar var?", ne: "Lokasyon ve raf kırılımıyla stok." },
      { soru: "Neyi ne zaman sipariş etmeliyiz?", ne: "MRP: emniyet stoğu, temin süresi, fire." },
      { soru: "Raf ömrü dolmak üzere olan partiler", ne: "Kalan gün sayısıyla parti listesi." },
      { soru: "Bu parti nerelere gitti?", ne: "İleri izleme: iş emirleri ve sevkiyatlar." },
    ],
  },
  {
    baslik: "Belge üretimi",
    aciklama:
      "İstediğiniz biçimi söyleyin: Excel, Word ya da yazdırılabilir belge. " +
      "Belge şirketinizin antediyle ve A4 dikey çıkar.",
    ornekler: [
      { soru: "Çalışan listesini Excel olarak ver", ne: "Sayı sütunları gerçek sayı olarak." },
      { soru: "Bilançoyu Word'e al", ne: "Antetli, A4 dikey, mali müşavirin düzeninde." },
      { soru: "Bu tabloyu yazdırılabilir yap", ne: "A4 önizleme; Ctrl+P ile PDF." },
      { soru: "Bordro pusulalarını hazırla", ne: "Kişi bazında, kesinti kırılımıyla." },
    ],
  },
  {
    baslik: "Geçmişe atıf",
    aciklama: "Sistem geçmiş konuşmalarınızda arayabilir.",
    ornekler: [
      { soru: "Geçen ay yakıt maliyetini konuşmuştuk, ne demiştik?", ne: "Geçmiş konuşmada arama ve alıntı." },
      { soru: "Bunu daha önce sormuş muydum?", ne: "Başlık ve içerikte arama." },
    ],
  },
];

/* ── SINIRLAR ── */

export interface Sinir {
  readonly baslik: string;
  readonly metin: string;
}

/*
 * BİR REHBERİN EN DÜRÜST BÖLÜMÜ, YAPAMADIKLARINI YAZDIĞI YERDİR.
 *
 * Kullanıcı bunları er ya da geç keşfeder. Rehberde yazılıysa bir
 * sınırdır; yazılı değilse bir hayal kırıklığı — ve ürünün geri
 * kalanına duyulan güveni de götürür.
 */
export const SINIRLAR: readonly Sinir[] = [
  {
    baslik: "Veri yoksa sayı uydurmaz",
    metin:
      "Bilinmeyen sıfır sayılmaz. Kur girilmemişse değerleme yapılmaz, temin " +
      "süresi yoksa teslim tarihi verilmez, vade yoksa fatura ödeme koşusuna " +
      "girmez. Her seferinde neyin eksik olduğu söylenir.",
  },
  {
    baslik: "Yazan hiçbir işlem onaysız çalışmaz",
    metin:
      "Fatura, ödeme, bordro, stok hareketi — hepsi önünüze gelir ve siz " +
      "onaylamadan kayıt oluşmaz. Çok adımlı bir işte tek onay alınır ama " +
      "onayladığınız adımların listesi size gösterilir ve sunucu o listenin " +
      "gerçek olduğunu doğrular.",
  },
  {
    baslik: "Göremediğiniz veriyi yapay zekâ da göremez",
    metin:
      "Yetkiniz olmayan araç modele hiç gönderilmez. Bu bir ekran gizleme " +
      "değildir: uydurabileceği bir şey kalmaz. Depo sorumlusuna maaş " +
      "sorulduğunda cevap 'yetkiniz yok' olur çünkü bakacak bir yer yoktur.",
  },
  {
    baslik: "Kapalı döneme kayıt girilmez",
    metin:
      "Ay kapandıysa o aya kimse yazamaz — patron dahil. Yazılması " +
      "gerekiyorsa dönem AÇILIR ve açılma işlemi iz bırakır.",
  },
  {
    baslik: "Denetim kaydı silinmez",
    metin:
      "Her işlem kim, ne zaman, hangi veriyle sorularının cevabıyla yazılır. " +
      "Kayıt veritabanı seviyesinde değiştirilemez; uygulama katmanındaki bir " +
      "söz değil, motorun reddettiği bir işlemdir.",
  },
  {
    baslik: "Bankaya talimat göndermez",
    metin:
      "Ödeme koşusu bir öneridir, ödeme kaydı bir kayıttır. Paranın gerçekten " +
      "gönderilmesi bankacılık kanalınızdan yapılır.",
  },
  {
    baslik: "Henüz yapmadıklarımız",
    metin:
      "Çok şirketli konsolidasyon, çok ülkeli vergi motoru, proje bazlı " +
      "maliyetlendirme (PS) ve el terminali/barkod akışı kapsam dışında. " +
      "Mevzuat Türkiye'ye gömülüdür ve bu bilinçlidir: genel bir vergi " +
      "motoru, TDHP ve VUK'taki keskinliği kaybettirir.",
  },
];
