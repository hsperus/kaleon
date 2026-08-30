/**
 * Malzeme kartı iş kuralları.
 *
 * ÖLÇÜ BİRİMİ ÇEVRİMİ NEDEN BU KADAR ÖNEMLİ:
 * Sipariş "koli" ile gelir, stok "adet" tutulur, üretim "kg" ile çalışır.
 * Çevrim olmadan 10 koli ile 240 adet toplanır ve 250 çıkar — kimse fark
 * etmez, envanter sayımına kadar. Bu yüzden stok bakiyesi HER ZAMAN temel
 * birimdedir ve her miktar girişi sınırda çevrilir.
 *
 * ÇEVRİM KAYIPSIZ OLMALI. Ondalıklı bir katsayıyla (1 kg = 2.20462 lb)
 * ileri geri çevirmek kayan nokta artığı bırakır. Çevrim TEK YÖNLÜ yapılır:
 * girişte temel birime çevrilir, saklanır; gösterimde tekrar çevrilir ama
 * saklanan değer hiç bozulmaz.
 */

import { normalizeName } from "./normalize.js";

/** Malzeme türleri — davranışı belirler. */
export const ITEM_TYPES = [
  "hammadde",
  "yari_mamul",
  "mamul",
  "ticari_mal",
  "hizmet",
  "sarf",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Stok tutulan türler. Hizmet stoklanmaz. */
const STOCKED: ReadonlySet<string> = new Set([
  "hammadde",
  "yari_mamul",
  "mamul",
  "ticari_mal",
  "sarf",
]);

export function isStocked(type: string): boolean {
  return STOCKED.has(type);
}

export const VALUATION_METHODS = ["standart", "hareketli_ortalama"] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

export const PROCUREMENT_TYPES = ["satin_alma", "uretim", "her_ikisi"] as const;

/** Bir malzemenin ölçü birimi tanımı. */
export interface UnitDefinition {
  readonly uom: string;
  /** 1 `uom` kaç temel birim eder. */
  readonly factor: number;
}

export class UnitConversionError extends Error {
  readonly code = "unit_conversion";
  constructor(message: string) {
    super(message);
    this.name = "UnitConversionError";
  }
}

/**
 * Miktarı temel birime çevirir.
 *
 * BİLİNMEYEN BİRİM SESSİZCE KABUL EDİLMEZ. "Belki temel birimdir" varsayımı,
 * 10 koliyi 10 adet olarak kaydeder ve stok 230 adet eksik kalır.
 */
export function toBaseQuantity(
  quantity: number,
  uom: string,
  baseUom: string,
  units: readonly UnitDefinition[],
): number {
  if (uom === baseUom) return quantity;

  const unit = units.find((u) => u.uom === uom);
  if (!unit) {
    throw new UnitConversionError(
      `"${uom}" birimi tanımlı değil. Temel birim "${baseUom}"; tanımlı birimler: ` +
        (units.length > 0 ? units.map((u) => u.uom).join(", ") : "yok"),
    );
  }
  if (!(unit.factor > 0)) {
    throw new UnitConversionError(`"${uom}" için çevrim katsayısı geçersiz: ${unit.factor}`);
  }
  return quantity * unit.factor;
}

/** Temel birimden gösterim birimine — yalnızca GÖSTERİM için. */
export function fromBaseQuantity(
  baseQuantity: number,
  uom: string,
  baseUom: string,
  units: readonly UnitDefinition[],
): number {
  if (uom === baseUom) return baseQuantity;
  const unit = units.find((u) => u.uom === uom);
  if (!unit || !(unit.factor > 0)) {
    throw new UnitConversionError(`"${uom}" birimi tanımlı değil.`);
  }
  return baseQuantity / unit.factor;
}

export interface ItemDraft {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly baseUom: string;
  readonly valuationMethod?: string;
  readonly procurementType?: string;
  readonly batchManaged?: boolean;
  readonly serialManaged?: boolean;
  readonly shelfLifeDays?: number | null;
  readonly leadTimeDays?: number | null;
}

export interface ValidatedItem extends ItemDraft {
  readonly normalized: string;
}

export class ItemValidationError extends Error {
  readonly code = "item_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ItemValidationError";
  }
}

/**
 * Malzeme kartı doğrulaması.
 *
 * Buradaki kuralların her biri bir tutarsızlığı önler; hiçbiri keyfî değil.
 */
export function validateItem(draft: ItemDraft): ValidatedItem {
  const code = draft.code.trim();
  const name = draft.name.trim();

  if (!code) throw new ItemValidationError("Malzeme kodu boş olamaz.");
  if (!name) throw new ItemValidationError("Malzeme adı boş olamaz.");
  if (!draft.baseUom.trim()) throw new ItemValidationError("Temel ölçü birimi zorunludur.");

  if (!(ITEM_TYPES as readonly string[]).includes(draft.type)) {
    throw new ItemValidationError(
      `Geçersiz malzeme türü: "${draft.type}". Geçerli: ${ITEM_TYPES.join(", ")}`,
    );
  }

  const valuation = draft.valuationMethod ?? "hareketli_ortalama";
  if (!(VALUATION_METHODS as readonly string[]).includes(valuation)) {
    throw new ItemValidationError(`Geçersiz değerleme yöntemi: "${valuation}"`);
  }

  const procurement = draft.procurementType ?? "satin_alma";
  if (!(PROCUREMENT_TYPES as readonly string[]).includes(procurement)) {
    throw new ItemValidationError(`Geçersiz tedarik türü: "${procurement}"`);
  }

  // HİZMET STOKLANMAZ. Parti veya seri takibi işaretlenmişse bu bir veri
  // hatasıdır: hizmetin partisi olmaz ve stok bakiyesi anlamsızdır.
  if (!isStocked(draft.type) && (draft.batchManaged || draft.serialManaged)) {
    throw new ItemValidationError(
      `"${draft.type}" türü stoklanmaz; parti veya seri takibi işaretlenemez.`,
    );
  }

  // RAF ÖMRÜ PARTİ TAKİBİ GEREKTİRİR. Parti yoksa son kullanma tarihi
  // hangi mala ait olduğu bilinemez ve raf ömrü uygulanamaz.
  if (draft.shelfLifeDays != null && draft.shelfLifeDays > 0 && !draft.batchManaged) {
    throw new ItemValidationError(
      "Raf ömrü tanımlamak için parti takibi açık olmalıdır; son kullanma tarihi partiye bağlanır.",
    );
  }

  // PARTİ VE SERİ AYNI ANDA OLMAZ. Parti bir yığını, seri tek bir nesneyi
  // tanımlar; ikisini birden açmak "hangi birim" sorusunu belirsiz bırakır.
  if (draft.batchManaged && draft.serialManaged) {
    throw new ItemValidationError(
      "Parti ve seri takibi aynı anda açılamaz: parti bir yığını, seri tek bir nesneyi tanımlar.",
    );
  }

  if (draft.leadTimeDays != null && draft.leadTimeDays < 0) {
    throw new ItemValidationError("Tedarik süresi negatif olamaz.");
  }

  return {
    ...draft,
    code,
    name,
    normalized: normalizeName(name).full,
    valuationMethod: valuation,
    procurementType: procurement,
  };
}

/**
 * Ölçü birimi tanımı doğrulaması.
 *
 * Temel birim ALTERNATİF OLARAK TANIMLANAMAZ: "1 adet = 2 adet" gibi bir
 * kayıt, çevrimi belirsiz ve bozuk hâle getirir.
 */
export function validateUnit(
  unit: UnitDefinition,
  baseUom: string,
): UnitDefinition {
  if (unit.uom === baseUom) {
    throw new UnitConversionError(
      `Temel birim "${baseUom}" alternatif birim olarak tanımlanamaz (katsayısı her zaman 1'dir).`,
    );
  }
  if (!(unit.factor > 0)) {
    throw new UnitConversionError("Çevrim katsayısı sıfırdan büyük olmalıdır.");
  }
  return unit;
}

/**
 * BOM satırının brüt ihtiyacı — fire dahil.
 *
 * 100 adet üretmek için %2 fireli bir bileşenden 102 adet gerekir. Fireyi
 * hesaba katmamak, üretimin ortasında malzeme bitmesi demektir.
 */
export function grossRequirement(
  quantityPerUnit: number,
  outputQuantity: number,
  scrapPercent: number,
): number {
  const net = quantityPerUnit * outputQuantity;
  return net * (1 + scrapPercent / 100);
}
