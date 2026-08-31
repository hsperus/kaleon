/**
 * Banka mutabakatı — ekstre satırını ödemeyle eşleştirme.
 *
 * SİSTEM ÖNERİR, İNSAN KAPATIR. Burada tek bir otomatik kapatma yok
 * ve olmayacak: tutarı ve tarihi tutan iki ayrı ödeme bulunabilir ve
 * yanlış olanı kapatmak cari hesabı sessizce bozar. Mutabakat hatası
 * aylar sonra, kimsenin hatırlamadığı bir farkta ortaya çıkar.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * SKOR NEDEN TEK SAYI DEĞİL DE BİLEŞENLERİYLE DÖNÜYOR:
 *
 * "%86 eşleşme" diyen bir sistem, kullanıcıya karar verecek hiçbir
 * şey vermez. "Tutar tam, tarih 2 gün farklı, cari adı benziyor,
 * referans tutmuyor" diyen bir sistem, kullanıcının kendi kararını
 * vermesini sağlar. Skor sıralama içindir; gerekçe karar içindir.
 *
 * TUTAR EŞLEŞMESİ ŞARTTIR, İSTEĞE BAĞLI DEĞİL. Tutarı tutmayan bir
 * öneri, öneri değildir: mutabakatın tanımı tutarın tutmasıdır. Tarih
 * ve isim yalnızca ayırt etmeye yarar.
 */

/** Kuruş yuvarlaması — para her yerde iki hane. */
function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

const GUN = 86_400_000;

/**
 * Tutar eşleşmesinde tolerans: yarım kuruş.
 *
 * Sıfır tolerans, float aritmetiğinden gelen 0,004'lük farkları
 * "eşleşmiyor" sayardı. Daha geniş bir tolerans ise gerçek bir kuruş
 * farkını gizlerdi — ve kuruş farkı çoğu zaman masraf kesintisidir,
 * yani görülmesi gereken bir şeydir.
 */
const TUTAR_TOLERANSI = 0.005;

/** Tarih farkı bu günden fazlaysa aday sayılmaz. */
const AZAMI_GUN_FARKI = 10;

export interface StatementLine {
  readonly id: string;
  readonly lineNo: number;
  readonly valueDate: Date;
  /** İşaretli: pozitif giriş, negatif çıkış. */
  readonly amount: number;
  readonly description: string;
  readonly counterparty: string | null;
  readonly reference: string | null;
}

export interface PaymentCandidate {
  readonly id: string;
  readonly documentNo: string;
  /** outgoing (tedarikçiye) | incoming (müşteriden) */
  readonly direction: string;
  readonly partnerName: string;
  /** Her zaman pozitif; yönü `direction` söyler. */
  readonly amount: number;
  readonly currency: string;
  readonly paidAt: Date;
  readonly reference: string | null;
  /** Zaten eşleşmiş bir ödeme yeniden önerilmez. */
  readonly alreadyMatched: boolean;
}

export interface MatchReason {
  /** Tutar tam mı — aday olabilmenin ön şartı. */
  readonly amountExact: boolean;
  /** Kaç gün fark var (mutlak). */
  readonly dayGap: number;
  /** Referans/dekont numarası ekstre metninde geçiyor mu. */
  readonly referenceHit: boolean;
  /** Cari adı ekstre metninde geçiyor mu. */
  readonly nameHit: boolean;
}

export interface MatchSuggestion {
  readonly lineId: string;
  readonly paymentId: string;
  readonly documentNo: string;
  readonly partnerName: string;
  /** 0–100. Yalnızca SIRALAMA için; karar gerekçeye bakar. */
  readonly score: number;
  readonly reason: MatchReason;
  /** Kullanıcıya gösterilecek tek cümlelik gerekçe. */
  readonly explanation: string;
}

/**
 * Türkçe duyarlı normalleştirme.
 *
 * Ekstre metni bankadan büyük harfle ve çoğu zaman Türkçe karakter
 * bozulmuş gelir ("ÇELIK" yerine "CELIK"). Küçültme `toLocaleLowerCase("tr")`
 * ile yapılır — İngilizce küçültme "I" harfini "i" yapar ve Türkçede
 * bu yanlıştır.
 */
function normalize(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/[ğ]/g, "g")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ç]/g, "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Cari adının ekstrede geçip geçmediği.
 *
 * TAM METİN ARAMASI DEĞİL, ANLAMLI KELİME ARAMASI. "A.Ş.", "Ltd",
 * "Sanayi", "Ticaret" gibi ekler neredeyse her unvanda var; onlara
 * bakarak eşleştirmek her cariyi her satıra bağlardı.
 */
const TUZEL_EK = new Set([
  "as", "a s", "ltd", "sti", "s t i", "san", "sanayi", "tic", "ticaret",
  "ve", "limited", "anonim", "sirketi", "sirket", "kollektif", "koll",
]);

function anlamliKelimeler(ad: string): string[] {
  return normalize(ad)
    .split(" ")
    .filter((w) => w.length >= 3 && !TUZEL_EK.has(w));
}

function adGeciyorMu(partnerName: string, metin: string): boolean {
  const kelimeler = anlamliKelimeler(partnerName);
  if (kelimeler.length === 0) return false;
  const n = normalize(metin);
  // TEK KELİME YETER: banka açıklaması unvanın tamamını taşımaz,
  // çoğu zaman ilk kelimeyi kısaltır ("ORTHAUS MAK. SAN.").
  return kelimeler.some((k) => n.includes(k));
}

function referansGeciyorMu(ref: string | null, ...metinler: (string | null)[]): boolean {
  if (!ref) return false;
  const r = normalize(ref);
  // Çok kısa referans (1-2 hane) tesadüfen her yerde geçer.
  if (r.length < 4) return false;
  return metinler.some((m) => m !== null && normalize(m).includes(r));
}

/**
 * Bir ekstre satırı için aday ödemeler.
 *
 * ÖNCE YÖN, SONRA TUTAR, SONRA TARİH. Yön filtresi en ucuz ve en
 * kesin olanı: müşteriden gelen para tedarikçiye yapılan ödemeyle
 * eşleşemez, tutarı ne kadar tutarsa tutsun.
 */
export function suggestMatches(
  line: StatementLine,
  payments: readonly PaymentCandidate[],
  currency = "TRY",
): readonly MatchSuggestion[] {
  const giris = line.amount > 0;
  const mutlak = Math.abs(line.amount);

  const adaylar = payments.filter((p) => {
    if (p.alreadyMatched) return false;
    if (p.currency.toUpperCase() !== currency.toUpperCase()) return false;
    // Giriş → tahsilat (incoming), çıkış → ödeme (outgoing).
    if (giris !== (p.direction === "incoming")) return false;
    if (Math.abs(p.amount - mutlak) > TUTAR_TOLERANSI) return false;
    const gun = Math.abs(gunFarki(line.valueDate, p.paidAt));
    return gun <= AZAMI_GUN_FARKI;
  });

  return adaylar
    .map((p) => {
      const gun = Math.abs(gunFarki(line.valueDate, p.paidAt));
      const reason: MatchReason = {
        amountExact: true,
        dayGap: gun,
        referenceHit: referansGeciyorMu(p.reference, line.description, line.reference),
        nameHit: adGeciyorMu(p.partnerName, `${line.description} ${line.counterparty ?? ""}`),
      };
      return {
        lineId: line.id,
        paymentId: p.id,
        documentNo: p.documentNo,
        partnerName: p.partnerName,
        score: skorla(reason),
        reason,
        explanation: aciklama(reason),
      };
    })
    .sort((a, b) => b.score - a.score || a.reason.dayGap - b.reason.dayGap);
}

function gunFarki(a: Date, b: Date): number {
  const g = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((g(a) - g(b)) / GUN);
}

/**
 * Skor.
 *
 * Tutar zaten şart olduğu için puana girmiyor — her adayda aynı.
 * Ayırt eden şey referans, isim ve tarih yakınlığı.
 */
function skorla(r: MatchReason): number {
  let s = 40; // tutar tuttu: taban
  if (r.referenceHit) s += 35;
  if (r.nameHit) s += 20;
  // Aynı gün 5 puan, her gün uzaklık yarım puan götürür.
  s += Math.max(0, 5 - r.dayGap * 0.5);
  return Math.round(Math.min(100, s));
}

function aciklama(r: MatchReason): string {
  const p: string[] = ["tutar tam"];
  p.push(r.dayGap === 0 ? "aynı gün" : `${r.dayGap} gün fark`);
  if (r.referenceHit) p.push("dekont no eşleşti");
  if (r.nameHit) p.push("cari adı geçiyor");
  if (!r.referenceHit && !r.nameHit) p.push("ad ve referans tutmuyor — dikkatle bakın");
  return p.join(", ");
}

/**
 * Ekstrenin kendi içinde tutarlı olup olmadığı.
 *
 * AÇILIŞ + HAREKETLER = KAPANIŞ. Tutmuyorsa ekstre eksik ayrıştırılmış
 * demektir ve o ekstreyle yapılan mutabakat baştan yanlıştır. Bu
 * kontrol, eşleştirmeye başlamadan ÖNCE yapılmalı; sonra yapılırsa
 * kullanıcı saatlerce eşleştirdikten sonra hepsini çöpe atar.
 */
export interface StatementIntegrity {
  readonly ok: boolean;
  readonly opening: number;
  readonly closing: number;
  readonly movement: number;
  /** Beklenen kapanış ile bildirilen kapanış farkı. */
  readonly difference: number;
}

export function checkStatement(
  opening: number,
  closing: number,
  lines: readonly { amount: number }[],
): StatementIntegrity {
  const hareket = kurusla(lines.reduce((s, l) => s + l.amount, 0));
  const beklenen = kurusla(opening + hareket);
  const fark = kurusla(closing - beklenen);
  return {
    ok: Math.abs(fark) <= TUTAR_TOLERANSI,
    opening: kurusla(opening),
    closing: kurusla(closing),
    movement: hareket,
    difference: fark,
  };
}
