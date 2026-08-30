/**
 * Parti (lot) izleme.
 *
 * BU MODÜLÜN VARLIK SEBEBİ GERİ ÇAĞIRMADIR. Bir müşteriden şikâyet gelir:
 * "bu parti bozuk". O partiden başka kime ne gitti? Ve o parti hangi
 * hammaddelerden yapıldı — aynı hammadde başka hangi partilere girdi?
 * Bu iki soruya saatler içinde cevap verememek, gıda ve kimyada geri
 * çağırmayı tüm üretime yaymak demektir.
 *
 * İKİ YÖN, İKİ FARKLI SORU:
 *   İLERİ  — "bu parti nereye gitti?" Müşteriye ve alt partilere doğru.
 *            Geri çağırmanın KAPSAMINI belirler.
 *   GERİ   — "bu parti neyden yapıldı?" Hammaddeye doğru. Hatanın
 *            KAYNAĞINI belirler.
 *
 * ŞECERE ÜRETİM ANINDA YAZILIR, SONRADAN ÇIKARILMAZ. Sonradan "o gün
 * depoda hangi parti vardı" diye tahmin etmek, iki parti aynı anda
 * açıkken imkânsızdır — ve tam da o durumda soruya cevap gerekir.
 */

export const BATCH_STATUSES = ["available", "quarantine", "blocked", "consumed"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const BATCH_ORIGINS = ["satin_alma", "uretim"] as const;

export class BatchError extends Error {
  readonly code = "batch";
  constructor(message: string) {
    super(message);
    this.name = "BatchError";
  }
}

/**
 * Son kullanma tarihini raf ömründen hesaplar.
 *
 * RAF ÖMRÜ YOKSA TARİH DE YOKTUR. "Sonsuz" veya çok ileri bir tarih
 * yazmak, süresi dolmuş malı süresi dolmamış göstermekle aynı şeydir.
 */
export function expiryFrom(producedAt: Date, shelfLifeDays: number | null): Date | null {
  if (shelfLifeDays === null || shelfLifeDays <= 0) return null;
  const d = new Date(producedAt.getTime());
  d.setUTCDate(d.getUTCDate() + shelfLifeDays);
  return d;
}

/** Parti sevk edilebilir mi. */
export function assertShippable(
  batch: { batchNo: string; status: BatchStatus; expiryDate: Date | null },
  on: Date,
): void {
  if (batch.status === "quarantine") {
    throw new BatchError(
      `"${batch.batchNo}" partisi KARANTİNADA; kalite kararı verilmeden sevk edilemez.`,
    );
  }
  if (batch.status === "blocked") {
    throw new BatchError(`"${batch.batchNo}" partisi BLOKELİ; sevk edilemez.`);
  }
  if (batch.expiryDate && batch.expiryDate.getTime() < on.getTime()) {
    throw new BatchError(
      `"${batch.batchNo}" partisinin son kullanma tarihi ` +
        `${batch.expiryDate.toISOString().slice(0, 10)}; süresi dolmuş mal sevk edilemez.`,
    );
  }
}

export interface ExpiryWarning {
  readonly batchNo: string;
  readonly itemCode: string;
  readonly expiryDate: string;
  readonly daysLeft: number;
  readonly quantity: number;
}

/**
 * Raf ömrü uyarı eşiği.
 *
 * SON GÜN UYARMAK GEÇ KALMAKTIR: mal o gün satılamaz hâle gelir ve
 * yapılabilecek hiçbir şey kalmaz. Eşik, malın hâlâ satılabileceği bir
 * pencere bırakır.
 */
export const EXPIRY_WARNING_DAYS = 30;

/** Süresi dolan/dolacak partileri sıralar — en acili başta. */
export function expiringBatches(
  batches: readonly {
    batchNo: string;
    itemCode: string;
    expiryDate: Date | null;
    quantity: number;
  }[],
  on: Date,
  withinDays = EXPIRY_WARNING_DAYS,
): readonly ExpiryWarning[] {
  const out: ExpiryWarning[] = [];
  for (const b of batches) {
    if (!b.expiryDate || b.quantity <= 0) continue;
    const daysLeft = Math.round((b.expiryDate.getTime() - on.getTime()) / 86_400_000);
    if (daysLeft > withinDays) continue;
    out.push({
      batchNo: b.batchNo,
      itemCode: b.itemCode,
      expiryDate: b.expiryDate.toISOString().slice(0, 10),
      daysLeft,
      quantity: b.quantity,
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

export interface TraceNode {
  readonly batchNo: string;
  readonly itemCode: string;
  /** Kök partiden kaç adım uzakta. 0 = sorulan partinin kendisi. */
  readonly depth: number;
  readonly quantity: number | null;
}

export interface ForwardTrace {
  readonly root: string;
  /** Bu partiden üretilen alt partiler. */
  readonly derivedBatches: readonly TraceNode[];
  /** Bu partinin gittiği müşteriler ve irsaliyeler. */
  readonly shipments: readonly {
    readonly deliveryNo: string;
    readonly customer: string;
    readonly shippedAt: string;
    readonly quantity: number;
    readonly viaBatch: string;
  }[];
  /** Zincir eksikse söylenir; sessiz bir "temiz" cevabı en tehlikelisidir. */
  readonly caveats: readonly string[];
}

export interface BackwardTrace {
  readonly root: string;
  readonly sourceBatches: readonly TraceNode[];
  readonly receipts: readonly {
    readonly batchNo: string;
    readonly itemCode: string;
    readonly supplier: string | null;
    readonly supplierBatchNo: string | null;
    readonly receivedAt: string;
  }[];
  readonly caveats: readonly string[];
}
