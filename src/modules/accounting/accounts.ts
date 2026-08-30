/**
 * Tek Düzen Hesap Planı (TDHP).
 *
 * TÜRKİYE'DE HESAP PLANI SERBEST DEĞİLDİR. Muhasebe Sistemi Uygulama
 * Genel Tebliği hesap kodlarını ve adlarını belirler; mali müşavir, vergi
 * dairesi ve bağımsız denetim bu kodları bekler. SAP'de hesap planı
 * kurulumda tanımlanır ve her projede yeniden yapılır; burada HAZIR GELİR
 * ve doğru gelir. Bu, yerelleşmenin en somut kazancıdır.
 *
 * KOD YAPISI ANLAMLIDIR:
 *   1xx  Dönen varlıklar        2xx  Duran varlıklar
 *   3xx  Kısa vadeli borçlar    4xx  Uzun vadeli borçlar
 *   5xx  Özkaynaklar            6xx  Gelir tablosu
 *   7xx  Maliyet hesapları
 * İlk hane sınıfı, ilk iki hane grubu verir. Mizan bu kırılımdan çıkar.
 *
 * BORÇ/ALACAK YÖNÜ HESABIN DOĞASIDIR, işlemin değil. Varlık hesabı borçla
 * artar, kaynak hesabı alacakla. Bu yön burada TANIMLI olmasaydı, her
 * kayıtta "artı mı eksi mi" kararı çağırana kalır ve er ya da geç biri
 * ters yazardı — üstelik mizan yine denk çıkardı.
 */

/** Hesabın normal bakiye yönü. */
export type Normal = "borc" | "alacak";

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly normal: Normal;
  /** Bilanço mu gelir tablosu mu — dönem sonunda kapanan hesaplar 6xx/7xx. */
  readonly statement: "bilanco" | "gelir";
  /** Cari (alıcı/satıcı) kırılımı tutulur mu. */
  readonly subledger?: "partner";
}

/**
 * Kullanılan hesaplar.
 *
 * TAM TDHP DEĞİL, KULLANILAN KESİT. Yüzlerce hesabın tamamını koymak,
 * hiçbirine kayıt atmayan bir liste üretirdi; buradaki her hesaba bu
 * sistemde en az bir yerden kayıt düşüyor. Yeni bir süreç eklendiğinde
 * hesabı da eklenir.
 */
export const CHART: readonly Account[] = [
  // ── 1 Dönen varlıklar ──
  { code: "100", name: "Kasa", normal: "borc", statement: "bilanco" },
  { code: "102", name: "Bankalar", normal: "borc", statement: "bilanco" },
  { code: "120", name: "Alıcılar", normal: "borc", statement: "bilanco", subledger: "partner" },
  { code: "121", name: "Alacak Senetleri", normal: "borc", statement: "bilanco", subledger: "partner" },
  { code: "150", name: "İlk Madde ve Malzeme", normal: "borc", statement: "bilanco" },
  { code: "151", name: "Yarı Mamuller — Üretim", normal: "borc", statement: "bilanco" },
  { code: "152", name: "Mamuller", normal: "borc", statement: "bilanco" },
  { code: "153", name: "Ticari Mallar", normal: "borc", statement: "bilanco" },
  { code: "157", name: "Diğer Stoklar", normal: "borc", statement: "bilanco" },
  { code: "159", name: "Verilen Sipariş Avansları", normal: "borc", statement: "bilanco" },
  { code: "191", name: "İndirilecek KDV", normal: "borc", statement: "bilanco" },

  // ── 2 Duran varlıklar ──
  //
  // KIYMET TÜRÜ AYRI HESAPLARDA DURUR. Hepsi 255'e yazılsaydı bilanço
  // "demirbaş 12 milyon" derdi ve içinde fabrika binası da, üç
  // bilgisayar da olurdu; amortisman oranları farklı olan kıymetler
  // tek satırda toplanamaz.
  { code: "252", name: "Binalar", normal: "borc", statement: "bilanco" },
  { code: "253", name: "Tesis, Makine ve Cihazlar", normal: "borc", statement: "bilanco" },
  { code: "254", name: "Taşıtlar", normal: "borc", statement: "bilanco" },
  { code: "255", name: "Demirbaşlar", normal: "borc", statement: "bilanco" },
  { code: "257", name: "Birikmiş Amortismanlar", normal: "alacak", statement: "bilanco" },
  { code: "260", name: "Haklar", normal: "borc", statement: "bilanco" },
  { code: "268", name: "Birikmiş Amortismanlar (Maddi Olmayan)", normal: "alacak", statement: "bilanco" },

  // ── 3 Kısa vadeli yabancı kaynaklar ──
  { code: "320", name: "Satıcılar", normal: "alacak", statement: "bilanco", subledger: "partner" },
  { code: "321", name: "Borç Senetleri", normal: "alacak", statement: "bilanco", subledger: "partner" },
  { code: "335", name: "Personele Borçlar", normal: "alacak", statement: "bilanco" },
  { code: "360", name: "Ödenecek Vergi ve Fonlar", normal: "alacak", statement: "bilanco" },
  { code: "361", name: "Ödenecek Sosyal Güvenlik Kesintileri", normal: "alacak", statement: "bilanco" },
  { code: "391", name: "Hesaplanan KDV", normal: "alacak", statement: "bilanco" },
  { code: "340", name: "Alınan Sipariş Avansları", normal: "alacak", statement: "bilanco" },

  // ── 5 Özkaynaklar ──
  { code: "500", name: "Sermaye", normal: "alacak", statement: "bilanco" },
  { code: "590", name: "Dönem Net Kârı", normal: "alacak", statement: "bilanco" },
  { code: "591", name: "Dönem Net Zararı", normal: "borc", statement: "bilanco" },

  // ── 6 Gelir tablosu ──
  { code: "600", name: "Yurtiçi Satışlar", normal: "alacak", statement: "gelir" },
  { code: "601", name: "Yurtdışı Satışlar", normal: "alacak", statement: "gelir" },
  { code: "610", name: "Satıştan İadeler", normal: "borc", statement: "gelir" },
  { code: "611", name: "Satış İskontoları", normal: "borc", statement: "gelir" },
  { code: "620", name: "Satılan Mamuller Maliyeti", normal: "borc", statement: "gelir" },
  { code: "621", name: "Satılan Ticari Mallar Maliyeti", normal: "borc", statement: "gelir" },
  { code: "630", name: "Araştırma ve Geliştirme Giderleri", normal: "borc", statement: "gelir" },
  { code: "631", name: "Pazarlama, Satış ve Dağıtım Giderleri", normal: "borc", statement: "gelir" },
  { code: "632", name: "Genel Yönetim Giderleri", normal: "borc", statement: "gelir" },
  { code: "642", name: "Faiz Gelirleri", normal: "alacak", statement: "gelir" },
  { code: "646", name: "Kambiyo Kârları", normal: "alacak", statement: "gelir" },
  // Sabit kıymet satış kârı/zararı buraya yazılır; satış hasılatı
  // (600) DEĞİLDİR — makine satmak ciro değildir.
  { code: "649", name: "Diğer Olağan Gelir ve Kârlar", normal: "alacak", statement: "gelir" },
  { code: "656", name: "Kambiyo Zararları", normal: "borc", statement: "gelir" },
  { code: "659", name: "Diğer Gider ve Zararlar", normal: "borc", statement: "gelir" },
  { code: "689", name: "Diğer Olağandışı Gider ve Zararlar", normal: "borc", statement: "gelir" },

  // ── 7 Maliyet hesapları ──
  { code: "710", name: "Direkt İlk Madde ve Malzeme Giderleri", normal: "borc", statement: "gelir" },
  { code: "720", name: "Direkt İşçilik Giderleri", normal: "borc", statement: "gelir" },
  { code: "730", name: "Genel Üretim Giderleri", normal: "borc", statement: "gelir" },
  { code: "770", name: "Genel Yönetim Giderleri (7/A)", normal: "borc", statement: "gelir" },
];

const BY_CODE = new Map(CHART.map((a) => [a.code, a]));

export class AccountError extends Error {
  readonly code = "account";
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export function account(code: string): Account {
  const a = BY_CODE.get(code);
  if (!a) {
    throw new AccountError(
      `"${code}" hesap planında yok. Tek Düzen Hesap Planı dışında hesap kullanılamaz; ` +
        `mali müşavir ve vergi dairesi bu kodları bekler.`,
    );
  }
  return a;
}

export function accountExists(code: string): boolean {
  return BY_CODE.has(code);
}

/** Hesap sınıfı: 1..7. Mizan kırılımı buradan çıkar. */
export function accountClass(code: string): number {
  return Number(code[0]);
}

/** Bakiye, hesabın normal yönüne göre işaretlenir. */
export function signedBalance(a: Account, debit: number, credit: number): number {
  return a.normal === "borc" ? debit - credit : credit - debit;
}

/**
 * Stok hesabı — malzeme türüne göre.
 *
 * Hammadde 150, mamul 152, ticari mal 153'e girer. Hepsini tek hesaba
 * atmak mizanı denk bırakır ama bilançoyu anlamsız kılar: "stoklarımız
 * ne kadar" sorusunun cevabı, neyin ne kadar olduğunu göstermelidir.
 */
export function stockAccountFor(itemType: string): string {
  switch (itemType) {
    case "hammadde":
      return "150";
    case "yari_mamul":
      return "151";
    case "mamul":
      return "152";
    case "ticari_mal":
      return "153";
    case "sarf":
      return "150";
    default:
      return "157";
  }
}

/** Satılan malın maliyeti hesabı — üretilen mi, alınıp satılan mı. */
export function cogsAccountFor(itemType: string): string {
  return itemType === "ticari_mal" ? "621" : "620";
}
