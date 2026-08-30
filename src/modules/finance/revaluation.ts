/**
 * Dönem sonu kur değerlemesi (VUK 280).
 *
 * NE YAPAR: dövizli alacak ve borçlar dönem sonunda o günün kuruyla
 * yeniden değerlenir. Defterdeki TL tutar ile bugünkü karşılığı
 * arasındaki fark kambiyo kârı (646) veya zararı (656) olarak yazılır.
 *
 * NEDEN ZORUNLU: 126.000 EUR'luk bir alacak Ocak'ta 38 kurdan
 * 4.788.000 TL yazıldıysa ve Aralık'ta kur 46 olduysa, o alacak artık
 * 5.796.000 TL eder. Fark 1.008.000 TL'dir ve BEYAN EDİLİR. Değerleme
 * yapılmazsa bilanço bir milyon TL eksik gösterir; ihracatçı bir
 * firmada bu rakam kârın tamamından büyük olabilir.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * ÜÇ KURAL, ÜÇÜ DE "SESSİZCE YANLIŞ HESAPLAMA" ÜZERİNE:
 *
 * 1. KUR YOKSA DEĞERLEME YAPILMAZ. Bulunamayan kuru 1 kabul etmek,
 *    126.000 EUR'u 126.000 TL'ye çevirir. Eksik kur bir HATA'dır,
 *    atlanacak bir satır değil — çünkü atlanan satır toplamdan
 *    düşer ve kimse fark etmez.
 *
 * 2. TL SATIRLAR DEĞERLENMEZ. Kendi para biriminin kuru 1'dir ve
 *    değişmez. Ayrı bir dal gerekmiyor: TL satırların kuru zaten 1
 *    olduğu için farkları matematiksel olarak sıfır çıkar — ama yine
 *    de baştan eleniyor, çünkü sıfır farklı bin satırı fişe yazmak
 *    defteri okunmaz hâle getirir.
 *
 * 3. KAPANMIŞ BAKİYE DEĞERLENMEZ. Ödenmiş bir fatura artık kur riski
 *    taşımaz; ödeme anındaki kur farkı zaten o gün yazılmıştır.
 *    Değerleme yalnızca AÇIK bakiyeye bakar.
 */

import type { RateQuote } from "./exchange.js";

/**
 * Değerlenecek açık bakiye.
 *
 * Hesap + cari + para birimi kırılımında tek satır. Bu üçlü, kur
 * farkının hangi hesaba yazılacağını da belirler: 120'nin farkı 120'ye,
 * 320'nin farkı 320'ye gider.
 */
export interface OpenFxBalance {
  readonly accountCode: string;
  readonly partnerId: string | null;
  readonly partnerName: string | null;
  readonly currency: string;
  /**
   * Açık döviz tutarı. Pozitif borç, negatif alacak bakiyesi —
   * hesabın kendi doğal yönünde değil, MATEMATİKSEL yönde.
   */
  readonly fxBalance: number;
  /** Defterdeki TL karşılığı, aynı işaret kuralıyla. */
  readonly bookBalance: number;
}

export interface RevaluedLine extends OpenFxBalance {
  /** Değerleme tarihindeki kur. */
  readonly rate: number;
  /** Kurun ilan tarihi — sorulan tarihten farklı olabilir. */
  readonly quotedAt: string;
  /** Bugünkü karşılık: fxBalance × rate. */
  readonly currentValue: number;
  /** currentValue − bookBalance. Pozitif lehte, negatif aleyhte. */
  readonly difference: number;
}

export interface Revaluation {
  readonly asOf: string;
  readonly lines: readonly RevaluedLine[];
  /** Toplam fark. Pozitif net kâr, negatif net zarar. */
  readonly difference: number;
  readonly gain: number;
  readonly loss: number;
  /** Kullanılan kurlar — denetim izi. */
  readonly rates: Readonly<Record<string, { rate: number; quotedAt: string }>>;
}

export class RevaluationError extends Error {
  readonly code = "fx_revaluation";
  constructor(message: string) {
    super(message);
    this.name = "RevaluationError";
  }
}

/** Kuruşa yuvarlar. Kayan noktalı toplamlar aksi hâlde 0.0000001 taşır. */
function kurus(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Açık bakiyeleri verilen kurlarla değerler.
 *
 * `quotes` para birimi başına TEK kur içerir — değerleme tarihinde
 * geçerli olan. Kur seçimi (hafta sonu, tatil, en son ilan) bu
 * fonksiyonun işi değil; `pickRate` orada karar verir ve sonucu buraya
 * gelir. Böylece değerleme mantığı kur kaynağından bağımsız test
 * edilebilir.
 */
export function revalue(
  balances: readonly OpenFxBalance[],
  quotes: Readonly<Record<string, RateQuote>>,
  asOf: Date,
): Revaluation {
  const lines: RevaluedLine[] = [];
  const rates: Record<string, { rate: number; quotedAt: string }> = {};
  const missing = new Set<string>();

  for (const b of balances) {
    // Kural 2: TL'nin kuru yoktur.
    if (b.currency === "TRY") continue;
    // Kural 3: kapanmış bakiye risk taşımaz.
    if (b.fxBalance === 0) continue;

    const q = quotes[b.currency];
    if (!q) {
      missing.add(b.currency);
      continue;
    }

    const currentValue = kurus(b.fxBalance * q.rate);
    const difference = kurus(currentValue - b.bookBalance);

    rates[b.currency] = { rate: q.rate, quotedAt: q.quotedAt };

    // Farkı sıfır çıkan satır fişe girmez ama LİSTEDE KALIR: kullanıcı
    // "bu cari niye değerlenmedi" diye sorduğunda cevabı görmeli.
    lines.push({ ...b, rate: q.rate, quotedAt: q.quotedAt, currentValue, difference });
  }

  // Kural 1: eksik kur bir hatadır, atlanacak satır değil.
  if (missing.size > 0) {
    const list = [...missing].sort().join(", ");
    throw new RevaluationError(
      `${list} için ${asOf.toISOString().slice(0, 10)} tarihinde kur bulunamadı. ` +
        `Değerleme yapılmadı: kuru bilinmeyen bir tutarı değerlemek, onu ` +
        `sessizce yanlış hesaplamaktır. Önce kuru girin.`,
    );
  }

  const gain = kurus(lines.filter((l) => l.difference > 0).reduce((s, l) => s + l.difference, 0));
  const loss = kurus(lines.filter((l) => l.difference < 0).reduce((s, l) => s - l.difference, 0));

  return {
    asOf: asOf.toISOString().slice(0, 10),
    lines,
    difference: kurus(gain - loss),
    gain,
    loss,
    rates,
  };
}

/**
 * Değerlemeyi yevmiye satırlarına çevirir.
 *
 * HER CARİ KENDİ SATIRINI ALIR, KARŞILIĞI TEK KALEMDE TOPLANIR.
 * 120'nin farkı cari bazında yazılmalı — yoksa cari ekstresi ile
 * mizan birbirini tutmaz. Ama 646/656 tarafı tek satır olur: kambiyo
 * kârının cari kırılımı yoktur ve elli satır yazmak defteri şişirir.
 *
 * TL karşılığı yazılır ama DÖVİZ TARAFI YAZILMAZ (fx alanları 0).
 * Kur farkı bir TL olayıdır: cariye yeni bir döviz borcu doğmaz,
 * yalnızca mevcut borcun TL karşılığı değişir. Döviz tutarı da
 * yazılsaydı, sonraki değerleme aynı riski ikinci kez sayardı.
 */
export interface RevaluationLine {
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly description: string;
  readonly partnerId: string | null;
}

export function revaluationEntry(r: Revaluation): readonly RevaluationLine[] {
  const lines: RevaluationLine[] = [];

  for (const l of r.lines) {
    if (l.difference === 0) continue;
    const amount = Math.abs(l.difference);
    const who = l.partnerName ?? l.partnerId ?? l.accountCode;
    const desc = `Kur değerlemesi ${r.asOf} · ${who} · ${l.currency} ${l.fxBalance} @ ${l.rate}`;
    lines.push({
      accountCode: l.accountCode,
      debit: l.difference > 0 ? amount : 0,
      credit: l.difference > 0 ? 0 : amount,
      description: desc,
      partnerId: l.partnerId,
    });
  }

  if (lines.length === 0) return [];

  // Karşı kalem: net değil, KÂR VE ZARAR AYRI. Netleştirilseydi
  // gelir tablosunda kambiyo kârı ve zararı tek bir rakama karışır,
  // "ne kadar kazandık ne kadar kaybettik" sorusu cevapsız kalırdı.
  if (r.gain > 0) {
    lines.push({
      accountCode: "646",
      debit: 0,
      credit: r.gain,
      description: `Kur değerlemesi ${r.asOf} — kambiyo kârı`,
      partnerId: null,
    });
  }
  if (r.loss > 0) {
    lines.push({
      accountCode: "656",
      debit: r.loss,
      credit: 0,
      description: `Kur değerlemesi ${r.asOf} — kambiyo zararı`,
      partnerId: null,
    });
  }

  return lines;
}
