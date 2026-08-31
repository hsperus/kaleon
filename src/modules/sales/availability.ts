/**
 * Teslim tarihi taahhüdü (ATP — available to promise).
 *
 * "NE ZAMAN GÖNDEREBİLİRİZ" SORUSU BUGÜNE KADAR TAHMİNLE
 * CEVAPLANIYORDU. Satışçı stoğa bakıyor, üretime soruyor, bir tarih
 * söylüyordu. O tarih siparişe yazılıyor ve gecikince ceza doğuyordu.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * BİLİNMEYEN TARİH VERİLMEZ.
 *
 * Bu modülün en önemli davranışı, cevap VERMEMEYİ bilmesi. Stok
 * yetersizse ve üretim planı yoksa, "tahminen üç hafta" demek bir
 * taahhüttür ve sözleşme cezasına bağlanır. Onun yerine neyin
 * bilinmediği söylenir: "eldeki stok 40 adet, 160 adet için üretim
 * planı yok — temin süresi girilirse tarih hesaplanabilir."
 *
 * ELDEKİ STOK SERBEST STOK DEĞİLDİR. Depodaki 200 adedin 180'i başka
 * siparişlere ayrılmışsa, yeni müşteriye söylenebilecek miktar 20'dir.
 * Bu ayrımı yapmayan bir ATP, aynı stoğu iki müşteriye söz verir ve
 * ikisini de geciktirir.
 */

const GUN = 86_400_000;

export interface StockPosition {
  readonly itemCode: string;
  /** Depodaki fiziksel miktar. */
  readonly onHand: number;
  /** Başka açık siparişlere ayrılmış miktar. */
  readonly committed: number;
  /** Gelecek mal kabulleri — tarih ve miktar. */
  readonly inbound: readonly { readonly date: Date; readonly quantity: number }[];
  /** Malzeme kartındaki temin süresi, gün. null = bilinmiyor. */
  readonly leadTimeDays: number | null;
}

export type AvailabilityBasis = "stock" | "inbound" | "lead-time" | "unknown";

export interface AvailabilityResult {
  readonly itemCode: string;
  readonly requestedQuantity: number;
  /** Bugün gönderilebilecek miktar (serbest stok). */
  readonly availableNow: number;
  /** Taahhüt edilebilecek en erken tarih; null = SÖYLENEMEZ. */
  readonly earliestDate: string | null;
  /** Tarihin neye dayandığı — taahhüdün gücünü bu belirler. */
  readonly basis: AvailabilityBasis;
  /** Tarih verilemiyorsa neyin eksik olduğu. */
  readonly missing: string | null;
  readonly explanation: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function gunEkle(d: Date, n: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + n * GUN,
  );
}

/**
 * Bir kalem için en erken teslim tarihi.
 *
 * SIRAYLA ÜÇ KAYNAK: serbest stok, yoldaki mal, temin süresi. Her
 * kaynak bir öncekinden ZAYIF bir taahhüttür ve `basis` bunu
 * söyler — satışçı hangi tarihe ne kadar güveneceğini bilmeli.
 */
export function checkAvailability(
  asOf: Date,
  requested: number,
  stock: StockPosition,
): AvailabilityResult {
  const bugun = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));

  /*
   * SERBEST STOK = ELDEKİ − AYRILMIŞ.
   *
   * Negatif çıkabilir: söz verilen miktar depodakinden fazlaysa
   * zaten bir gecikme vardır. Sıfıra kırpılıyor çünkü "eksi 40 adet
   * gönderebiliriz" anlamsız; ama durum açıklamada görünür.
   */
  const serbest = Math.max(0, stock.onHand - stock.committed);

  if (requested <= serbest) {
    return {
      itemCode: stock.itemCode,
      requestedQuantity: requested,
      availableNow: serbest,
      earliestDate: iso(bugun),
      basis: "stock",
      missing: null,
      explanation:
        `${requested} adet serbest stoktan bugün gönderilebilir ` +
        `(depoda ${stock.onHand}, ${stock.committed} başka siparişlere ayrılmış).`,
    };
  }

  // Yoldaki mal birikimli sayılır: hangi tarihte toplam yeter?
  let birikim = serbest;
  const sirali = [...stock.inbound].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const g of sirali) {
    birikim += g.quantity;
    if (birikim >= requested) {
      return {
        itemCode: stock.itemCode,
        requestedQuantity: requested,
        availableNow: serbest,
        earliestDate: iso(g.date),
        basis: "inbound",
        missing: null,
        explanation:
          `${serbest} adet serbest stokta; kalan ${requested - serbest} adet ` +
          `${iso(g.date)} tarihinde beklenen mal kabulüyle tamamlanıyor. ` +
          `Bu tarih tedarikçinin taahhüdüne dayanır.`,
      };
    }
  }

  /*
   * TEMİN SÜRESİ BİLİNMİYORSA TARİH VERİLMEZ.
   *
   * Buradaki `null`, bu modülün var olma sebebidir. "Tahminen üç
   * hafta" demek bir taahhüttür ve sözleşme cezasına bağlanır.
   */
  if (stock.leadTimeDays === null) {
    return {
      itemCode: stock.itemCode,
      requestedQuantity: requested,
      availableNow: serbest,
      earliestDate: null,
      basis: "unknown",
      missing: "temin süresi",
      explanation:
        `${serbest} adet serbest stokta, ${requested - serbest} adet EKSİK. ` +
        `Yolda beklenen mal bu açığı kapatmıyor ve malzeme kartında temin ` +
        `süresi yazılı değil — bu yüzden bir tarih SÖYLENEMEZ. Temin süresi ` +
        `girilirse tarih hesaplanır.`,
    };
  }

  const tarih = gunEkle(bugun, stock.leadTimeDays);
  return {
    itemCode: stock.itemCode,
    requestedQuantity: requested,
    availableNow: serbest,
    earliestDate: iso(tarih),
    basis: "lead-time",
    missing: null,
    explanation:
      `${serbest} adet serbest stokta; kalan ${requested - serbest} adet için ` +
      `${stock.leadTimeDays} günlük temin süresi işletiliyor → ${iso(tarih)}. ` +
      `Bu tarih SİPARİŞ VERİLDİĞİ VARSAYIMINA dayanır; henüz sipariş açılmadı.`,
  };
}

/**
 * Çok kalemli bir sipariş için teslim tarihi.
 *
 * EN GEÇ KALEM TARİHİ BELİRLER. Sipariş bir bütün olarak sevk
 * ediliyorsa, dokuz kalemin sekizinin hazır olması hiçbir şey ifade
 * etmez. Bir kalemin tarihi bile bilinmiyorsa siparişin tarihi de
 * bilinmiyordur.
 */
export interface OrderAvailability {
  readonly lines: readonly AvailabilityResult[];
  readonly earliestDate: string | null;
  /** Tarihi belirleyen kalem — darboğaz. */
  readonly bottleneck: string | null;
  readonly basis: AvailabilityBasis;
  readonly unknownItems: readonly string[];
}

export function checkOrderAvailability(
  asOf: Date,
  lines: readonly { itemCode: string; quantity: number; stock: StockPosition }[],
): OrderAvailability {
  const sonuclar = lines.map((l) => checkAvailability(asOf, l.quantity, l.stock));
  const bilinmeyen = sonuclar.filter((r) => r.earliestDate === null);

  if (bilinmeyen.length > 0) {
    return {
      lines: sonuclar,
      earliestDate: null,
      bottleneck: bilinmeyen[0]!.itemCode,
      basis: "unknown",
      unknownItems: bilinmeyen.map((r) => r.itemCode),
    };
  }

  // Zayıf halka: en geç tarih ve en zayıf dayanak birlikte belirlenir.
  const gucSirasi: Record<AvailabilityBasis, number> = {
    stock: 0,
    inbound: 1,
    "lead-time": 2,
    unknown: 3,
  };
  let enGec = sonuclar[0]!;
  for (const r of sonuclar) {
    if (r.earliestDate! > enGec.earliestDate!) enGec = r;
  }
  const enZayif = sonuclar.reduce((a, b) => (gucSirasi[b.basis] > gucSirasi[a.basis] ? b : a));

  return {
    lines: sonuclar,
    earliestDate: enGec.earliestDate,
    bottleneck: enGec.itemCode,
    basis: enZayif.basis,
    unknownItems: [],
  };
}
