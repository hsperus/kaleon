/**
 * Malzeme İhtiyaç Planlaması (MRP).
 *
 * MRP TEK BİR SORUYU CEVAPLAR: "bu siparişleri zamanında teslim etmek için
 * NEYİ, NE KADAR, NE ZAMAN sipariş etmem veya üretmem gerekiyor?"
 *
 * Hesap üç girdiden çıkar:
 *   TALEP     — müşteri siparişleri ve bunların termin tarihleri
 *   ARZ       — eldeki stok ve yoldaki siparişler
 *   YAPI      — ürün ağacı (hangi mamul neyden yapılır) ve tedarik süreleri
 *
 * KADEME KADEME İNİLİR. Mamulün ihtiyacı bulunur, ürün ağacı patlatılır,
 * yarı mamulün ihtiyacı bulunur, o da patlatılır. Sıra karışırsa bir
 * bileşenin ihtiyacı, onu kullanan üst kalem hesaplanmadan bulunur ve
 * eksik çıkar. Bu yüzden her malzemeye DÜŞÜK SEVİYE KODU verilir ve
 * hesap o sırayla yapılır.
 *
 * MRP'NİN EN DEĞERLİ ÇIKTISI "YETİŞMİYOR" LİSTESİDİR. SAP bunu binlerce
 * satırlık bir istisna listesine gömer ve kimse okumaz. Burada ayrı
 * döner: geçmişe düşen bir planlı sipariş, o siparişin GEÇ KALACAĞI
 * demektir ve bu, planın kendisinden daha önemli bir bilgidir.
 */

export class MrpError extends Error {
  readonly code = "mrp";
  constructor(message: string) {
    super(message);
    this.name = "MrpError";
  }
}

export interface BomComponent {
  readonly componentCode: string;
  readonly quantityPer: number;
  readonly scrapPercent: number;
}

export interface ItemPlanningData {
  readonly code: string;
  readonly type: string;
  /** satin_alma | uretim | her_ikisi */
  readonly procurementType: string;
  /** Gün. BİLİNMİYORSA null — sıfır "aynı gün gelir" demektir. */
  readonly leadTimeDays: number | null;
  readonly safetyStock: number | null;
  readonly onHand: number;
  /** Ürün ağacı; satın alınan malzemede boş. */
  readonly components: readonly BomComponent[];
}

export interface Demand {
  readonly itemCode: string;
  readonly quantity: number;
  /** Malın hazır olması gereken tarih. */
  readonly neededBy: Date;
  readonly source: string;
}

export interface ScheduledReceipt {
  readonly itemCode: string;
  readonly quantity: number;
  readonly expectedAt: Date;
  readonly source: string;
}

export interface PlannedOrder {
  readonly itemCode: string;
  readonly quantity: number;
  /** Malın hazır olması gereken tarih. */
  readonly dueDate: string;
  /** Siparişin/üretimin BAŞLAMASI gereken tarih — teslim eksi tedarik süresi. */
  readonly startDate: string;
  readonly kind: "satin_alma" | "uretim";
  readonly level: number;
  /** Bu ihtiyacı doğuran üst kalem veya sipariş. */
  readonly drivenBy: string;
  /**
   * Başlama tarihi bugünden geriye düşüyorsa GEÇ KALINACAK.
   * Kaç gün geç kalınacağı yazılır; "geç" demek yetmez.
   */
  readonly lateByDays: number;
  /** Tedarik süresi bilinmiyorsa plan tarihleri güvenilir değildir. */
  readonly leadTimeKnown: boolean;
}

export interface MrpResult {
  readonly plannedOrders: readonly PlannedOrder[];
  /** Zamanında yetişmeyecek olanlar — ayrı listelenir, gömülmez. */
  readonly late: readonly PlannedOrder[];
  readonly caveats: readonly string[];
}

/** Kademe sınırı: döngüsel ürün ağacı sonsuz patlamayı önler. */
export const MAX_BOM_LEVEL = 15;

const DAY_MS = 86_400_000;

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Net ihtiyaç: brütten eldeki ve yoldaki düşülür, emniyet stoğu eklenir.
 *
 * EMNİYET STOĞU İHTİYACA EKLENİR, ELDEKİNDEN DÜŞÜLMEZ. İkisi aynı sonucu
 * verir gibi görünür ama düşüldüğünde eldeki negatife inebilir ve
 * sonraki hesaplar bozulur.
 */
export function netRequirement(input: {
  gross: number;
  onHand: number;
  scheduled: number;
  safetyStock: number | null;
}): number {
  const available = input.onHand + input.scheduled - (input.safetyStock ?? 0);
  return round4(Math.max(0, input.gross - available));
}

/**
 * Ürün ağacı bileşen ihtiyacı — fire dahil.
 *
 * 100 adet üretmek için %2 fireli bir bileşenden 102 adet gerekir. Fireyi
 * hesaba katmamak, üretimin ortasında malzeme bitmesi demektir.
 */
export function componentRequirement(
  parentQuantity: number,
  component: BomComponent,
): number {
  return round4(
    parentQuantity * component.quantityPer * (1 + component.scrapPercent / 100),
  );
}

/**
 * Düşük seviye kodu: bir malzemenin ürün ağacındaki EN DERİN yeri.
 *
 * Aynı vida hem mamulde hem yarı mamulde geçiyorsa, ihtiyacı ikisinin de
 * hesabı bittikten sonra toplanmalıdır. En derin seviyeye göre sıralamak
 * bunu garanti eder.
 */
export function lowLevelCodes(
  items: ReadonlyMap<string, ItemPlanningData>,
): Map<string, number> {
  const codes = new Map<string, number>();

  const walk = (code: string, level: number, path: readonly string[]): void => {
    if (level > MAX_BOM_LEVEL) {
      throw new MrpError(
        `Ürün ağacı ${MAX_BOM_LEVEL} kademeyi aştı: ${[...path, code].join(" → ")}. ` +
          `Büyük ihtimalle DÖNGÜSEL bir ağaç var; bir malzeme kendi bileşeni olamaz.`,
      );
    }
    if (path.includes(code)) {
      throw new MrpError(
        `Ürün ağacı DÖNGÜSEL: ${[...path, code].join(" → ")}. Bir malzeme, doğrudan ` +
          `ya da dolaylı olarak kendi bileşeni olamaz.`,
      );
    }

    codes.set(code, Math.max(codes.get(code) ?? 0, level));
    const item = items.get(code);
    if (!item) return;
    for (const c of item.components) {
      walk(c.componentCode, level + 1, [...path, code]);
    }
  };

  for (const code of items.keys()) {
    if (!codes.has(code)) walk(code, 0, []);
  }
  return codes;
}

/**
 * MRP çalıştırır.
 *
 * `today` dışarıdan verilir: geç kalma hesabı bugüne göre yapılır ve
 * deterministik olmalıdır — testte de üretimde de aynı girdi aynı planı
 * üretmelidir.
 */
export function runMrp(input: {
  items: ReadonlyMap<string, ItemPlanningData>;
  demands: readonly Demand[];
  scheduled: readonly ScheduledReceipt[];
  today: Date;
}): MrpResult {
  const caveats: string[] = [];
  const levels = lowLevelCodes(input.items);

  // Brüt ihtiyaçlar seviyeye göre işlenmek üzere biriktirilir.
  const gross = new Map<string, { quantity: number; neededBy: Date; drivenBy: string }[]>();
  for (const d of input.demands) {
    if (!input.items.has(d.itemCode)) {
      caveats.push(
        `"${d.itemCode}" malzeme kartı yok; ${d.source} talebi PLANA GİRMEDİ. ` +
          `Planlanmayan bir ihtiyaç, hiç görülmeyen bir ihtiyaçtır.`,
      );
      continue;
    }
    const list = gross.get(d.itemCode) ?? [];
    list.push({ quantity: d.quantity, neededBy: d.neededBy, drivenBy: d.source });
    gross.set(d.itemCode, list);
  }

  const scheduledByItem = new Map<string, number>();
  for (const s of input.scheduled) {
    scheduledByItem.set(s.itemCode, (scheduledByItem.get(s.itemCode) ?? 0) + s.quantity);
  }

  const planned: PlannedOrder[] = [];
  const ordered = [...levels.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code);

  for (const code of ordered) {
    const demands = gross.get(code);
    if (!demands || demands.length === 0) continue;

    const item = input.items.get(code);
    if (!item) continue;

    const totalGross = round4(demands.reduce((s, d) => s + d.quantity, 0));
    const net = netRequirement({
      gross: totalGross,
      onHand: item.onHand,
      scheduled: scheduledByItem.get(code) ?? 0,
      safetyStock: item.safetyStock,
    });

    if (net <= 0) continue;

    // EN ERKEN İHTİYAÇ TARİHİ ESAS ALINIR. Ortalama ya da en geç tarih
    // alınsaydı, ilk sipariş geç kalır ve plan sessizce yanlış olurdu.
    const dueDate = demands.reduce(
      (min, d) => (d.neededBy < min ? d.neededBy : min),
      demands[0]!.neededBy,
    );
    const drivenBy = demands.map((d) => d.drivenBy).join(", ");

    const leadTimeKnown = item.leadTimeDays !== null;
    const lead = item.leadTimeDays ?? 0;
    const startDate = addDays(dueDate, -lead);
    const lateByDays = Math.max(
      0,
      Math.ceil((input.today.getTime() - startDate.getTime()) / DAY_MS),
    );

    if (!leadTimeKnown) {
      caveats.push(
        `"${code}" için tedarik süresi girilmemiş; başlama tarihi teslim tarihiyle aynı ` +
          `alındı. Gerçekte daha erken başlanması gerekebilir.`,
      );
    }

    const kind: "satin_alma" | "uretim" =
      item.procurementType === "uretim" || item.components.length > 0 ? "uretim" : "satin_alma";

    planned.push({
      itemCode: code,
      quantity: net,
      dueDate: iso(dueDate),
      startDate: iso(startDate),
      kind,
      level: levels.get(code) ?? 0,
      drivenBy,
      lateByDays,
      leadTimeKnown,
    });

    // ÜRETİLECEKSE BİLEŞENLERİNİN İHTİYACI DOĞAR ve o ihtiyacın tarihi,
    // üretimin BAŞLAMA tarihidir — bitiş tarihi değil. Bitiş tarihi
    // alınsaydı hammadde, üretim bittikten sonra gelirdi.
    if (kind === "uretim") {
      for (const c of item.components) {
        const need = componentRequirement(net, c);
        const list = gross.get(c.componentCode) ?? [];
        list.push({ quantity: need, neededBy: startDate, drivenBy: `${code} üretimi` });
        gross.set(c.componentCode, list);
      }
    }
  }

  const late = planned.filter((p) => p.lateByDays > 0);
  if (late.length > 0) {
    caveats.push(
      `${late.length} planlı siparişin başlama tarihi GEÇMİŞTE kalıyor; bu kalemler ` +
        `zamanında yetişmeyecek.`,
    );
  }

  return {
    plannedOrders: planned.sort(
      (a, b) => a.level - b.level || a.startDate.localeCompare(b.startDate),
    ),
    late: late.sort((a, b) => b.lateByDays - a.lateByDays),
    caveats,
  };
}
