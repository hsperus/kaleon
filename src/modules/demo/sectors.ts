/**
 * Demo sektör profilleri.
 *
 * NEDEN SEKTÖRE GÖRE DEĞİŞİYOR: bir dökümhaneciye "Şasi Profili 60x40"
 * göstermek, ürünün onun işini bilmediğini söyler. Denemeye gelen kişi
 * ilk on saniyede kendi dünyasından bir kelime görmeli — göremezse
 * geri kalanını okumaz.
 *
 * NEYİN DEĞİŞTİĞİ, NEYİN DEĞİŞMEDİĞİ:
 *
 *   DEĞİŞİR — kalem adları, müşteri adı, makine adları, departmanlar.
 *             Yani SÖZLÜK.
 *   DEĞİŞMEZ — açılış bilançosunun iskeleti, amortisman kuralları,
 *             bordro parametreleri, hesap planı. Yani MUHASEBE.
 *
 * Bu ayrım kasıtlı. Mevzuat sektöre göre değişmez; değişseydi demo
 * verisi de test edilmiş sayıları bozar ve her sektör için ayrı
 * doğrulama gerekirdi. Sektör yalnızca vitrindir.
 */

export interface SectorItem {
  readonly code: string;
  readonly name: string;
  readonly uom: string;
  /** hammadde | sarf | hizmet | mamul — siparişe yalnızca mamul girer. */
  readonly type: string;
  readonly price: number;
  readonly vat: number;
}

export interface SectorProfile {
  readonly id: string;
  readonly label: string;
  /** Şirket unvanının sonuna eklenen tür — "… Makina Sanayi ve Ticaret A.Ş." */
  readonly legalSuffix: string;
  /** Örnek müşteri: sektörün gerçek alıcı tipi. */
  readonly customer: { readonly legalName: string; readonly city: string; readonly district: string };
  /** Tam altı kalem; son üçü mamul olmalı — sipariş onları kullanır. */
  readonly items: readonly SectorItem[];
  /** Dört sabit kıymet: iki makine, bir taşıt, bir demirbaş. */
  readonly assets: readonly { readonly name: string; readonly category: string }[];
  /** Beş çalışan; departman ve unvanlar sektörün kendi dili. */
  readonly staff: readonly { readonly department: string; readonly position: string }[];
  /**
   * Boş ekranda önerilen dört soru.
   *
   * NEDEN VAR: yeni kurulan bir şirkette brifing haklı olarak boştur —
   * uyarılacak bir şey yoktur. Ama boş bir ekran, ürünün ne
   * yapabildiğini de göstermez. Uydurma alarm üretmek yerine
   * SORULABİLECEKLERİ gösteriyoruz.
   *
   * SORULAR SEKTÖRÜN DİLİNDE. Bir tekstilciye "kaplin stoğu" sormayı
   * önermek, ürünün onun işini bilmediğini söyler.
   */
  readonly starters: readonly { readonly label: string; readonly question: string }[];
}

/** Her sektörde aynı beş kişi çalışır; unvanları değişir. */
const NAMES = ["Ayşe Yılmaz", "Mehmet Kaya", "Elif Demir", "Burak Şahin", "Zeynep Ak"] as const;

export const SECTORS: readonly SectorProfile[] = [
  {
    id: "makina",
    label: "Makina ve metal işleme",
    legalSuffix: "Makina Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "Daimler Truck Otomotiv Sanayi A.Ş.", city: "İstanbul", district: "Esenyurt" },
    items: [
      { code: "M-1001", name: "Şasi Profili 60x40", uom: "adet", type: "hammadde", price: 250, vat: 20 },
      { code: "M-1002", name: "Kaynak Teli 1.2mm", uom: "kg", type: "sarf", price: 180, vat: 20 },
      { code: "M-1003", name: "Montaj İşçiliği", uom: "saat", type: "hizmet", price: 900, vat: 20 },
      { code: "FR-22", name: "Şasi Profili FR-22", uom: "adet", type: "mamul", price: 4850, vat: 20 },
      { code: "KP-08", name: "Kaplin Grubu KP-08", uom: "adet", type: "mamul", price: 12600, vat: 20 },
      { code: "BR-14", name: "Bağlantı Braketi BR-14", uom: "adet", type: "mamul", price: 940, vat: 10 },
    ],
    assets: [
      { name: "CNC Torna Tezgahı", category: "makine" },
      { name: "Kaynak Robotu", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Ofis Mobilyası", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "CNC Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Üretim", position: "Kaynakçı" },
      { department: "Satış", position: "Satış Temsilcisi" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "Kaplin stoğu ne durumda?", question: "Kaplin Grubu KP-08 stoğu ne durumda?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
  {
    id: "plastik",
    label: "Plastik ve kalıp",
    legalSuffix: "Plastik Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "Arçelik Pazarlama A.Ş.", city: "İstanbul", district: "Beylikdüzü" },
    items: [
      { code: "M-2001", name: "PP Granül Doğal", uom: "kg", type: "hammadde", price: 62, vat: 20 },
      { code: "M-2002", name: "Masterbatch Siyah", uom: "kg", type: "sarf", price: 145, vat: 20 },
      { code: "M-2003", name: "Kalıp Bakım İşçiliği", uom: "saat", type: "hizmet", price: 1100, vat: 20 },
      { code: "EN-31", name: "Enjeksiyon Gövde EN-31", uom: "adet", type: "mamul", price: 385, vat: 20 },
      { code: "KP-77", name: "Kapak Grubu KP-77", uom: "adet", type: "mamul", price: 148, vat: 20 },
      { code: "CN-05", name: "Conta Seti CN-05", uom: "adet", type: "mamul", price: 96, vat: 10 },
    ],
    assets: [
      { name: "Enjeksiyon Makinesi 250 Ton", category: "makine" },
      { name: "Kalıp Erozyon Tezgahı", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Ofis Mobilyası", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "Enjeksiyon Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Kalıphane", position: "Kalıpçı" },
      { department: "Satış", position: "Satış Temsilcisi" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "Granül stoğu yeter mi?", question: "PP Granül Doğal stoğu ne durumda?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
  {
    id: "tekstil",
    label: "Tekstil ve konfeksiyon",
    legalSuffix: "Tekstil Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "LC Waikiki Mağazacılık Hizmetleri Ticaret A.Ş.", city: "İstanbul", district: "Esenyurt" },
    items: [
      { code: "M-3001", name: "Pamuk İplik Ne 30/1", uom: "kg", type: "hammadde", price: 195, vat: 10 },
      { code: "M-3002", name: "Reaktif Boya", uom: "kg", type: "sarf", price: 420, vat: 20 },
      { code: "M-3003", name: "Fason Dikim", uom: "adet", type: "hizmet", price: 48, vat: 20 },
      { code: "TS-10", name: "Süprem T-Shirt TS-10", uom: "adet", type: "mamul", price: 214, vat: 10 },
      { code: "SW-22", name: "Sweatshirt SW-22", uom: "adet", type: "mamul", price: 486, vat: 10 },
      { code: "KM-07", name: "Kumaş Top KM-07", uom: "metre", type: "mamul", price: 132, vat: 10 },
    ],
    assets: [
      { name: "Yuvarlak Örgü Makinesi", category: "makine" },
      { name: "Ram Makinesi", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Ofis Mobilyası", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "Örgü Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Boyahane", position: "Boyacı" },
      { department: "Satış", position: "İhracat Sorumlusu" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "İplik stoğu ne durumda?", question: "Pamuk İplik Ne 30/1 stoğu ne durumda?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
  {
    id: "gida",
    label: "Gıda üretimi",
    legalSuffix: "Gıda Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "Migros Ticaret A.Ş.", city: "İstanbul", district: "Ataşehir" },
    items: [
      { code: "M-4001", name: "Buğday Unu Tip 650", uom: "kg", type: "hammadde", price: 18, vat: 1 },
      { code: "M-4002", name: "Ambalaj Filmi", uom: "kg", type: "sarf", price: 210, vat: 20 },
      { code: "M-4003", name: "Soğuk Zincir Nakliye", uom: "sefer", type: "hizmet", price: 4800, vat: 20 },
      { code: "BS-01", name: "Bisküvi 200g BS-01", uom: "koli", type: "mamul", price: 386, vat: 1 },
      { code: "KR-14", name: "Kraker 100g KR-14", uom: "koli", type: "mamul", price: 264, vat: 1 },
      { code: "GF-09", name: "Gofret 40g GF-09", uom: "koli", type: "mamul", price: 318, vat: 1 },
    ],
    assets: [
      { name: "Paketleme Hattı", category: "makine" },
      { name: "Tünel Fırın", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Ofis Mobilyası", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "Hat Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Kalite", position: "Gıda Mühendisi" },
      { department: "Satış", position: "Satış Temsilcisi" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "Un stoğu ne durumda?", question: "Buğday Unu Tip 650 stoğu ne durumda?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
  {
    id: "kimya",
    label: "Kimya ve boya",
    legalSuffix: "Kimya Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "Ford Otomotiv Sanayi A.Ş.", city: "Kocaeli", district: "Gölcük" },
    items: [
      { code: "M-5001", name: "Titanyum Dioksit", uom: "kg", type: "hammadde", price: 385, vat: 20 },
      { code: "M-5002", name: "Çözücü Tiner", uom: "litre", type: "sarf", price: 96, vat: 20 },
      { code: "M-5003", name: "Laboratuvar Analizi", uom: "adet", type: "hizmet", price: 2400, vat: 20 },
      { code: "AS-12", name: "Astar Boya AS-12", uom: "kg", type: "mamul", price: 640, vat: 20 },
      { code: "SN-30", name: "Son Kat Boya SN-30", uom: "kg", type: "mamul", price: 1180, vat: 20 },
      { code: "SR-04", name: "Sertleştirici SR-04", uom: "kg", type: "mamul", price: 890, vat: 20 },
    ],
    assets: [
      { name: "Dispersiyon Mikseri", category: "makine" },
      { name: "Dolum Hattı", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Laboratuvar Donanımı", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "Üretim Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Ar-Ge", position: "Kimya Mühendisi" },
      { department: "Satış", position: "Teknik Satış" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "Astar boya maliyeti ne?", question: "Astar Boya AS-12 birim maliyeti ne?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
  {
    id: "mobilya",
    label: "Mobilya ve ahşap",
    legalSuffix: "Mobilya Sanayi ve Ticaret A.Ş.",
    customer: { legalName: "Koçtaş Yapı Marketleri A.Ş.", city: "İstanbul", district: "Ümraniye" },
    items: [
      { code: "M-6001", name: "MDF Levha 18mm", uom: "adet", type: "hammadde", price: 940, vat: 20 },
      { code: "M-6002", name: "PVC Kenar Bandı", uom: "metre", type: "sarf", price: 12, vat: 20 },
      { code: "M-6003", name: "Montaj Hizmeti", uom: "saat", type: "hizmet", price: 750, vat: 20 },
      { code: "DL-40", name: "Dolap Modülü DL-40", uom: "adet", type: "mamul", price: 5240, vat: 20 },
      { code: "MS-18", name: "Çalışma Masası MS-18", uom: "adet", type: "mamul", price: 3860, vat: 20 },
      { code: "RF-06", name: "Raf Ünitesi RF-06", uom: "adet", type: "mamul", price: 1420, vat: 20 },
    ],
    assets: [
      { name: "CNC İşleme Merkezi", category: "makine" },
      { name: "Kenar Bantlama Makinesi", category: "makine" },
      { name: "Ford Transit (Binek)", category: "tasit" },
      { name: "Ofis Mobilyası", category: "demirbas" },
    ],
    staff: [
      { department: "Üretim", position: "CNC Operatörü" },
      { department: "Muhasebe", position: "Muhasebe Müdürü" },
      { department: "Montaj", position: "Montaj Ustası" },
      { department: "Satış", position: "Satış Temsilcisi" },
      { department: "Üretim", position: "Vardiya Amiri" },
    ],
    starters: [
      { label: "Bu ay kâr ettik mi?", question: "Bu ay kâr ettik mi?" },
      { label: "Bilançoyu çıkar", question: "31 Aralık itibarıyla bilançoyu çıkar" },
      { label: "MDF stoğu ne durumda?", question: "MDF Levha 18mm stoğu ne durumda?" },
      { label: "Ağustos bordrosu ne tuttu?", question: "Ağustos bordrosu ne tuttu?" },
    ],
  },
] as const;

/** Sektör kimliğinden profil; bilinmeyen kimlikte makina profiline düşer. */
export function sectorProfile(id: string | null | undefined): SectorProfile {
  return SECTORS.find((s) => s.id === id) ?? SECTORS[0]!;
}

/** Çalışan adları sektörden bağımsızdır; unvanlar profilden gelir. */
export function staffNames(): readonly string[] {
  return NAMES;
}

/**
 * Ticari unvanı kurar: şirket adı + sektör eki.
 *
 * SEKTÖR KELİMESİ İKİ KEZ YAZILMAZ. "Yıldız Plastik" + "Plastik Sanayi
 * ve Ticaret A.Ş." = "Yıldız Plastik Plastik Sanayi…" oluyordu ve
 * ürünü ilk gören kişi faturanın antetinde bunu görüyordu. Şirket adı
 * zaten ekin ilk kelimesiyle bitiyorsa o kelime atlanır.
 *
 * ADI ZATEN ŞİRKET TÜRÜ TAŞIYORSA HİÇ EK YAPILMAZ. "Yıldız Plastik
 * A.Ş." yazan birine ikinci bir "A.Ş." eklemek unvanı bozar.
 */
export function legalNameFor(companyName: string, sector: SectorProfile): string {
  const name = companyName.trim();
  const lower = name.toLocaleLowerCase("tr");

  /*
   * Zaten bir şirket türü var mı?
   *
   * `\b` KULLANILAMAZ: "a.ş." nokta ile biter ve nokta zaten sözcük
   * sınırı olmadığı için sondaki `\b` hiçbir zaman eşleşmez. Ayrıca
   * `i` bayrağı Türkçe "ş" için güvenilir değildir. Bu yüzden metin
   * önce noktalamadan arındırılıp kelime kelime bakılıyor.
   */
  // Noktalar BOŞLUKLA DEĞİL, HİÇLE değiştirilir: "a.ş." boşlukla
  // bölününce ["a","ş"] olur ve hiçbir kalıba uymaz; noktasız hâli
  // "aş" olur ve doğru eşleşir.
  const words = lower.replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
  const TYPE_WORDS = ["aş", "a.ş", "as", "ltd", "limited", "şti", "sti", "sanayi", "san", "tic"];
  if (words.some((w) => TYPE_WORDS.includes(w))) return name;

  const parts = sector.legalSuffix.split(" ");
  const head = parts[0]!.toLocaleLowerCase("tr");
  const suffix = lower.endsWith(head) ? parts.slice(1).join(" ") : sector.legalSuffix;

  return `${name} ${suffix}`.replace(/\s+/g, " ").trim();
}
