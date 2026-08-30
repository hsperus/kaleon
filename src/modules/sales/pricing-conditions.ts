/**
 * Fiyat ve koşul tekniği.
 *
 * FİYAT BİR ALAN DEĞİL, BİR HESAPTIR. "Bu müşteriye bu ürün kaça?"
 * sorusunun cevabı liste fiyatı, müşteriye özel anlaşma, miktar kademesi,
 * kampanya ve para birimine göre değişir. Sipariş kalemine elle fiyat
 * yazmak, bu hesabı satışçının kafasına bırakmaktır — ve her satışçının
 * kafasındaki hesap farklıdır.
 *
 * SAP'NİN KOŞUL TEKNİĞİ DOĞRU BİR MODELDİR ama kurulumu bir projedir:
 * erişim sırası, koşul tablosu ve şema tanımlamak günler alır. Burada
 * model aynı, kurulum yok: koşullar ÖZGÜLLÜK SIRASINA göre kendiliğinden
 * değerlendirilir.
 *
 * EN ÖZGÜL KOŞUL KAZANIR. "Bu müşteriye bu üründe 850 TL" kaydı, "bu
 * üründe liste 900 TL" kaydını ezer. Sıralama keyfî değil, tanımlıdır;
 * aksi hâlde aynı sipariş iki kez hesaplandığında iki farklı fiyat çıkar.
 *
 * FİYAT BULUNAMAZSA UYDURULMAZ. Sıfır fiyat "bedava" demektir ve
 * faturayı sıfır tutarlı yapar. Bulunamadığında bu SÖYLENİR.
 */

export const CONDITION_KINDS = ["fiyat", "iskonto_yuzde", "iskonto_tutar", "ek_ucret"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export class PricingConditionError extends Error {
  readonly code = "pricing_condition";
  constructor(message: string) {
    super(message);
    this.name = "PricingConditionError";
  }
}

export interface Condition {
  readonly id: string;
  readonly kind: ConditionKind;
  /** null = tüm müşteriler. */
  readonly partnerId: string | null;
  /** null = tüm malzemeler. */
  readonly itemCode: string | null;
  /** null = tüm müşteri grupları. */
  readonly partnerGroup: string | null;
  /** Bu miktardan itibaren geçerli — miktar kademesi. */
  readonly minQuantity: number;
  readonly currency: string;
  readonly value: number;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly priority?: number;
}

/**
 * Koşulun ÖZGÜLLÜK PUANI.
 *
 * Yüksek puan daha özgül demektir ve önce uygulanır. Puanlar keyfî
 * değil, kapsam daralmasına göre ağırlıklı: müşteri+malzeme eşleşmesi,
 * yalnızca malzeme eşleşmesinden daha dardır.
 */
export function specificity(c: Condition): number {
  let score = 0;
  if (c.partnerId) score += 100;
  if (c.itemCode) score += 50;
  if (c.partnerGroup) score += 25;
  // Miktar kademesi: yüksek eşik daha özgüldür.
  if (c.minQuantity > 0) score += 10;
  return score + (c.priority ?? 0);
}

export interface PricingRequest {
  readonly itemCode: string;
  readonly partnerId: string;
  readonly partnerGroup?: string | null;
  readonly quantity: number;
  readonly currency: string;
  readonly on: Date;
}

/** Koşul bu isteğe uyuyor mu. */
export function matches(c: Condition, req: PricingRequest): boolean {
  if (c.partnerId !== null && c.partnerId !== req.partnerId) return false;
  if (c.itemCode !== null && c.itemCode !== req.itemCode) return false;
  if (c.partnerGroup !== null && c.partnerGroup !== (req.partnerGroup ?? null)) return false;
  if (req.quantity < c.minQuantity) return false;
  if (c.currency !== req.currency) return false;
  if (c.validFrom > req.on) return false;
  if (c.validTo !== null && c.validTo < req.on) return false;
  return true;
}

export interface PriceResult {
  readonly unitPrice: number | null;
  readonly discountPercent: number;
  readonly discountAmount: number;
  readonly surcharge: number;
  /** Fiyatın hangi koşuldan geldiği — "bu fiyat nereden çıktı" sorusu. */
  readonly appliedConditions: readonly {
    id: string;
    kind: ConditionKind;
    value: number;
    reason: string;
  }[];
  readonly caveat: string | null;
}

function describe(c: Condition): string {
  const parts: string[] = [];
  if (c.partnerId) parts.push("müşteriye özel");
  if (c.itemCode) parts.push("malzemeye özel");
  if (c.partnerGroup) parts.push(`${c.partnerGroup} grubu`);
  if (c.minQuantity > 0) parts.push(`${c.minQuantity}+ miktar kademesi`);
  return parts.length > 0 ? parts.join(", ") : "genel";
}

/**
 * Fiyatı hesaplar.
 *
 * HER TÜRDEN EN ÖZGÜL BİR KOŞUL UYGULANIR. İki fiyat koşulu birden
 * uygulansaydı sonuç sıraya bağlı olur ve aynı sipariş iki kez
 * hesaplandığında iki farklı fiyat çıkardı. İskontolar ise TOPLANIR:
 * kampanya iskontosu ile müşteri iskontosu birlikte geçerlidir.
 */
export function priceFor(
  conditions: readonly Condition[],
  req: PricingRequest,
): PriceResult {
  const applicable = conditions
    .filter((c) => matches(c, req))
    .sort((a, b) => specificity(b) - specificity(a));

  const applied: PriceResult["appliedConditions"] = [];

  const priceCondition = applicable.find((c) => c.kind === "fiyat");
  const unitPrice = priceCondition ? priceCondition.value : null;
  if (priceCondition) {
    (applied as { id: string; kind: ConditionKind; value: number; reason: string }[]).push({
      id: priceCondition.id,
      kind: "fiyat",
      value: priceCondition.value,
      reason: describe(priceCondition),
    });
  }

  let discountPercent = 0;
  let discountAmount = 0;
  let surcharge = 0;

  for (const c of applicable) {
    if (c.kind === "iskonto_yuzde") discountPercent += c.value;
    else if (c.kind === "iskonto_tutar") discountAmount += c.value;
    else if (c.kind === "ek_ucret") surcharge += c.value;
    else continue;

    (applied as { id: string; kind: ConditionKind; value: number; reason: string }[]).push({
      id: c.id,
      kind: c.kind,
      value: c.value,
      reason: describe(c),
    });
  }

  // TOPLAM İSKONTO %100'Ü AŞAMAZ. Aşsaydı negatif fiyat doğar ve fatura
  // müşteriye para öder hâle gelirdi.
  if (discountPercent >= 100) {
    throw new PricingConditionError(
      `Toplam iskonto %${discountPercent} — %100'e ulaşıyor. Üst üste binen koşullar ` +
        `negatif fiyat üretir; koşullar gözden geçirilmelidir.`,
    );
  }

  return {
    unitPrice,
    discountPercent: Math.round(discountPercent * 100) / 100,
    discountAmount: Math.round(discountAmount * 100) / 100,
    surcharge: Math.round(surcharge * 100) / 100,
    appliedConditions: applied,
    caveat:
      unitPrice === null
        ? `"${req.itemCode}" için ${req.currency} cinsinden geçerli fiyat koşulu yok. ` +
          `Fiyat UYDURULMAZ; liste fiyatı tanımlanmalı ya da elle girilmelidir.`
        : null,
  };
}
