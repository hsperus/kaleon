/**
 * Stok defteri — hareket tipi disiplini.
 *
 * KAELON'da stok bakiyesi SAKLANMAZ, TÜRETİLİR. Bakiye bir alan değil, bir
 * fonksiyondur: hareketlerin toplamı. Bunun üç sonucu var ve üçü de klasik
 * ERP'lerin en sık delinen yerini kapatır:
 *
 *  1. Bakiye elle düzeltilemez — çünkü yazılabilir bir bakiye alanı yoktur.
 *     Düzeltme de bir harekettir, tipi ve gerekçesi vardır.
 *  2. Hiçbir hareket silinmez. İptal, ters yönlü YENİ bir harekettir ve
 *     aslına referans verir. "Kim ne zaman geri aldı" her zaman görünür.
 *  3. Her hareketin bir TİPİ vardır. Tip; yönü, zorunlu referansı, gerekli
 *     yetkiyi ve muhasebe karşılığını belirler. Tipsiz hareket olamaz.
 *
 * Hareket tipi numaraları SAP geleneğini izler (101 mal kabul, 261 iş emrine
 * sarf, 601 sevkiyat...) — çünkü sahadaki kullanıcı ve danışman bu dili zaten
 * biliyor. Tanıdık numara, öğrenme maliyetini düşürür.
 */

import type { AuthorityLevel } from "../../kernel/types.js";
import { BusinessRuleError } from "../../kernel/errors.js";

export type ReferenceKind =
  | "purchase_order"
  | "work_order"
  | "delivery"
  | "transfer"
  | "count"
  | "none";

export interface MovementType {
  readonly code: string;
  readonly label: string;
  /** +1 girdi, -1 çıktı. */
  readonly sign: 1 | -1;
  /** Bu hareket hangi belgeye bağlanmak zorunda? */
  readonly requires: ReferenceKind;
  /** Hangi hareket tipinin iptali? */
  readonly reverses?: string;
  /** Çağırmak için gereken yetki seviyesi. */
  readonly authority: AuthorityLevel;
  /** Gerekçe alanı zorunlu mu? (elle düzeltmelerde evet) */
  readonly requiresReason: boolean;
}

/**
 * Hareket tipi kataloğu.
 *
 * Not: hiçbir tip negatif stoğa izin vermez. Negatif stok bir "esneklik"
 * değil, veri kaybının başladığı yerdir — sayım farkı (701/702) ile
 * düzeltilir, görmezden gelinerek değil.
 */
export const MOVEMENT_TYPES: Record<string, MovementType> = {
  "101": { code: "101", label: "Satın alma mal kabulü", sign: 1, requires: "purchase_order", authority: 1, requiresReason: false },
  "102": { code: "102", label: "Mal kabul iptali", sign: -1, requires: "purchase_order", reverses: "101", authority: 2, requiresReason: true },
  "261": { code: "261", label: "İş emrine malzeme sarfı", sign: -1, requires: "work_order", authority: 1, requiresReason: false },
  "262": { code: "262", label: "İş emri sarf iptali", sign: 1, requires: "work_order", reverses: "261", authority: 2, requiresReason: true },
  "131": { code: "131", label: "Üretimden mamul girişi", sign: 1, requires: "work_order", authority: 1, requiresReason: false },
  "132": { code: "132", label: "Mamul giriş iptali", sign: -1, requires: "work_order", reverses: "131", authority: 2, requiresReason: true },
  "551": { code: "551", label: "Fire / hurda çıkışı", sign: -1, requires: "work_order", authority: 1, requiresReason: true },
  "601": { code: "601", label: "Sevkiyat çıkışı", sign: -1, requires: "delivery", authority: 1, requiresReason: false },
  "602": { code: "602", label: "Sevkiyat iptali", sign: 1, requires: "delivery", reverses: "601", authority: 2, requiresReason: true },
  "311": { code: "311", label: "Depolar arası transfer çıkışı", sign: -1, requires: "transfer", authority: 1, requiresReason: false },
  "312": { code: "312", label: "Depolar arası transfer girişi", sign: 1, requires: "transfer", authority: 1, requiresReason: false },
  "701": { code: "701", label: "Sayım fazlası", sign: 1, requires: "count", authority: 2, requiresReason: true },
  "702": { code: "702", label: "Sayım eksiği", sign: -1, requires: "count", authority: 2, requiresReason: true },
  "541": { code: "541", label: "Fasona malzeme gönderimi", sign: -1, requires: "purchase_order", authority: 1, requiresReason: false },
};

export interface StockMovement {
  readonly id: string;
  readonly at: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly batchId: string | null;
  /** Her zaman POZİTİF. Yön hareket tipinden gelir. */
  readonly quantity: number;
  readonly movementType: string;
  readonly reference: { kind: ReferenceKind; id: string } | null;
  readonly userId: string;
  readonly reason: string | null;
  /** Bu hareket bir iptalse, iptal edilen hareketin kimliği. */
  readonly reversalOf: string | null;
}

export interface StockKey {
  readonly itemId: string;
  readonly locationId: string;
  readonly batchId: string | null;
}

export function stockKey(k: StockKey): string {
  return `${k.itemId}|${k.locationId}|${k.batchId ?? ""}`;
}

/** İşaretli miktar — defterin tek doğru okuma biçimi. */
export function signedQuantity(m: StockMovement): number {
  const type = MOVEMENT_TYPES[m.movementType];
  if (!type) throw new BusinessRuleError(`Tanımsız hareket tipi: ${m.movementType}`, "movement_type_unknown");
  return m.quantity * type.sign;
}

/** Bakiye türetilir, saklanmaz. */
export function balanceOf(ledger: readonly StockMovement[], key: StockKey): number {
  const target = stockKey(key);
  let sum = 0;
  for (const m of ledger) {
    if (stockKey(m) === target) sum += signedQuantity(m);
  }
  return sum;
}

export interface PostMovementInput {
  readonly id: string;
  readonly at: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly batchId?: string | null;
  readonly quantity: number;
  readonly movementType: string;
  readonly reference?: { kind: ReferenceKind; id: string } | null;
  readonly userId: string;
  readonly reason?: string | null;
  readonly reversalOf?: string | null;
}

/**
 * Doğrulama bağlamı.
 *
 * Alan mantığı defteri TARAMAZ — çağıran, kararı vermek için gereken üç şeyi
 * getirir. Bu ayrım kritik: bellek adaptörü bunları diziden hesaplar, Postgres
 * adaptörü tek bir SQL SUM'ı ve indeksli iki sorguyla getirir. Aynı kural,
 * iki farklı erişim biçimi.
 */
export interface MovementContext {
  readonly authority: AuthorityLevel;
  /** Hareketten ÖNCEKİ bakiye — kilit altında okunmuş olmalıdır. */
  readonly currentBalance: number;
  /** İptal ediliyorsa asıl hareket. */
  readonly original: StockMovement | null;
  /** Asıl hareket daha önce iptal edilmiş mi? */
  readonly alreadyReversed: boolean;
}

/**
 * Hareketi doğrular ve kanonik biçimini döndürür. Kaydetmez.
 *
 * Buradaki kuralların hiçbiri çağıranın disiplinine bırakılmaz.
 */
export function validateMovement(
  input: PostMovementInput,
  ctx: MovementContext,
): StockMovement {
  const type = MOVEMENT_TYPES[input.movementType];
  if (!type) {
    throw new BusinessRuleError(
      `Tanımsız hareket tipi: ${input.movementType}. Tipsiz stok hareketi kaydedilemez.`,
      "movement_type_unknown",
    );
  }

  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new BusinessRuleError(
      "Hareket miktarı pozitif olmalıdır; yön hareket tipinden gelir.",
      "quantity_must_be_positive",
    );
  }

  if (ctx.authority < type.authority) {
    throw new BusinessRuleError(
      `"${type.label}" için L${type.authority} yetki gerekir.`,
      "authority_insufficient",
    );
  }

  if (type.requires !== "none") {
    if (!input.reference || input.reference.kind !== type.requires) {
      throw new BusinessRuleError(
        `"${type.label}" hareketi bir ${type.requires} belgesine bağlanmak zorundadır. ` +
          `Belgesiz stok hareketi izlenemez.`,
        "reference_required",
      );
    }
  }

  if (type.requiresReason && !input.reason?.trim()) {
    throw new BusinessRuleError(
      `"${type.label}" için gerekçe zorunludur. Açıklamasız düzeltme kabul edilmez.`,
      "reason_required",
    );
  }

  if (type.reverses) {
    if (!ctx.original) {
      throw new BusinessRuleError(
        "İptal edilecek hareket bulunamadı. İptal, aslına referans vermek zorundadır.",
        "reversal_target_missing",
      );
    }
    if (ctx.original.movementType !== type.reverses) {
      throw new BusinessRuleError(
        `"${type.label}" yalnızca ${type.reverses} tipini iptal edebilir.`,
        "reversal_type_mismatch",
      );
    }
    if (ctx.alreadyReversed) {
      throw new BusinessRuleError(
        "Bu hareket zaten iptal edilmiş. Aynı hareket iki kez iptal edilemez.",
        "already_reversed",
      );
    }
    if (input.quantity > ctx.original.quantity) {
      throw new BusinessRuleError(
        `İptal miktarı aslından büyük olamaz (${input.quantity} > ${ctx.original.quantity}).`,
        "reversal_exceeds_original",
      );
    }
  }

  const movement: StockMovement = {
    id: input.id,
    at: input.at,
    itemId: input.itemId,
    locationId: input.locationId,
    batchId: input.batchId ?? null,
    quantity: input.quantity,
    movementType: input.movementType,
    reference: input.reference ?? null,
    userId: input.userId,
    reason: input.reason ?? null,
    reversalOf: input.reversalOf ?? null,
  };

  // ── En sert değişmez: negatif stok oluşamaz.
  const after = ctx.currentBalance + signedQuantity(movement);
  if (after < 0) {
    throw new BusinessRuleError(
      `Bu hareket stoğu negatife düşürür (mevcut ${ctx.currentBalance}, ` +
        `hareket ${signedQuantity(movement)}). Negatif stok kabul edilmez — ` +
        `eksik varsa sayım farkı (702) ile gerekçeli kaydedilmelidir.`,
      "negative_stock",
    );
  }

  return Object.freeze(movement);
}

/** Bellek adaptörü için ince sarmalayıcı — bağlamı diziden hesaplar. */
export function postMovement(
  ledger: readonly StockMovement[],
  input: PostMovementInput,
  opts: { authority: AuthorityLevel },
): readonly StockMovement[] {
  const original = input.reversalOf ? (ledger.find((m) => m.id === input.reversalOf) ?? null) : null;
  const movement = validateMovement(input, {
    authority: opts.authority,
    currentBalance: balanceOf(ledger, {
      itemId: input.itemId,
      locationId: input.locationId,
      batchId: input.batchId ?? null,
    }),
    original,
    alreadyReversed: original ? ledger.some((m) => m.reversalOf === original.id) : false,
  });
  return [...ledger, movement];
}

/** Defterdeki tüm bakiyeler — sıfır olanlar elenir. */
export function allBalances(
  ledger: readonly StockMovement[],
): readonly { key: StockKey; quantity: number }[] {
  const map = new Map<string, { key: StockKey; quantity: number }>();
  for (const m of ledger) {
    const k = stockKey(m);
    const entry = map.get(k) ?? {
      key: { itemId: m.itemId, locationId: m.locationId, batchId: m.batchId },
      quantity: 0,
    };
    entry.quantity += signedQuantity(m);
    map.set(k, entry);
  }
  return [...map.values()].filter((e) => e.quantity !== 0);
}
