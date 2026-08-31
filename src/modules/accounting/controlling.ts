/**
 * Maliyet muhasebesi (CO) — masraf merkezi ve bütçe.
 *
 * PATRONUN EN SIK SORDUĞU SORU BURADAYDI VE CEVABI YOKTU: "hangi
 * departman ne harcadı, bütçeyi aştık mı?" Gider yevmiyeye yazılıyor
 * ama bir departmana bağlanmıyordu; bilanço şirketin tamamını
 * gösteriyor, kimin harcadığını göstermiyordu.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * BÜTÇE AŞIMI İKİ FARKLI ŞEYDİR VE KARIŞTIRILMAMALI:
 *
 *   · YILLIK aşım — yılın bütçesi bitti. Gerçek bir sorun.
 *   · DÖNEMSEL aşım — bu ay fazla harcandı ama yıl geneli normal.
 *     Bir bakım masrafı Mart'ta çıkmış olabilir; bu bir sapma değil,
 *     mevsimselliktir.
 *
 * İkisini tek bir "aşıldı" bayrağına indirgemek, her yıl birkaç kez
 * yanlış alarm üretir ve birkaç yanlış alarmdan sonra kimse bakmaz.
 *
 * BÜTÇESİ OLMAYAN GİDER "SIFIR BÜTÇE" DEĞİLDİR. Bütçe girilmemiş bir
 * merkez, %∞ aşmış görünmemeli — bütçesiz olduğunu söylemeli. İlki
 * yanlış bir alarm, ikincisi doğru bir eksiklik bildirimi.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export class ControllingError extends Error {
  readonly code = "controlling";
  constructor(message: string) {
    super(message);
    this.name = "ControllingError";
  }
}

/** TDHP'de gider hesapları 6 ve 7 ile başlar. */
export function isExpenseAccount(code: string): boolean {
  return code.startsWith("6") || code.startsWith("7");
}

/** Hesap grubu — ilk üç hane. Bütçe grup seviyesinde tutulur. */
export function accountGroup(code: string): string {
  return code.slice(0, 3);
}

export interface CostCenterNode {
  readonly code: string;
  readonly name: string;
  readonly parentCode: string | null;
  readonly isActive: boolean;
}

/**
 * Masraf merkezi ağacını doğrular.
 *
 * DÖNGÜ SESSİZ BİR FELAKETTİR: A'nın üstü B, B'nin üstü A ise rapor
 * sonsuza kadar döner ve sunucu yanıt vermez. Kısıt kendi kendinin
 * üstü olmayı engelliyor ama iki adımlı döngüyü engelleyemez —
 * o kontrol burada.
 */
export function assertNoCycle(nodes: readonly CostCenterNode[]): void {
  const ustler = new Map(nodes.map((n) => [n.code, n.parentCode]));
  for (const n of nodes) {
    const gorulen = new Set<string>([n.code]);
    let p = n.parentCode;
    while (p !== null && p !== undefined) {
      if (gorulen.has(p)) {
        throw new ControllingError(
          `Masraf merkezi ağacında döngü var: ${[...gorulen, p].join(" → ")}. ` +
            `Döngülü bir ağaçta rapor sonsuza kadar döner.`,
        );
      }
      gorulen.add(p);
      p = ustler.get(p) ?? null;
    }
  }
}

/**
 * Bir merkezin kendisi ve altındaki tüm merkezler.
 *
 * Üst merkez raporu alt merkezleri TOPLAR: "Üretim" sorulduğunda
 * kaynakhane ve montaj da gelir. Aksi hâlde ağaç yalnızca bir
 * etiketleme olurdu.
 */
export function descendantsOf(
  code: string,
  nodes: readonly CostCenterNode[],
): readonly string[] {
  assertNoCycle(nodes);
  const cocuklar = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentCode === null) continue;
    const liste = cocuklar.get(n.parentCode) ?? [];
    liste.push(n.code);
    cocuklar.set(n.parentCode, liste);
  }
  const sonuc: string[] = [];
  const kuyruk = [code];
  while (kuyruk.length > 0) {
    const c = kuyruk.shift()!;
    sonuc.push(c);
    kuyruk.push(...(cocuklar.get(c) ?? []));
  }
  return sonuc;
}

export interface ActualLine {
  readonly costCenterCode: string;
  readonly accountCode: string;
  /** Dönem içi gider tutarı (borç − alacak). */
  readonly amount: number;
  readonly month: number;
}

export interface BudgetLine {
  readonly costCenterCode: string;
  readonly accountGroup: string;
  readonly year: number;
  /** null = yıllık bütçe. */
  readonly month: number | null;
  readonly amount: number;
}

export interface VarianceRow {
  readonly costCenterCode: string;
  readonly costCenterName: string;
  readonly accountGroup: string;
  readonly budget: number | null;
  readonly actual: number;
  /** Bütçe − gerçekleşen. Negatif = aşım. null = bütçesiz. */
  readonly variance: number | null;
  /** Gerçekleşen / bütçe, yüzde. null = bütçesiz. */
  readonly usedPercent: number | null;
  /** none | watch | over | unbudgeted */
  readonly status: "none" | "watch" | "over" | "unbudgeted";
}

export interface BudgetReport {
  readonly year: number;
  /** null = yılın tamamı. */
  readonly month: number | null;
  readonly rows: readonly VarianceRow[];
  readonly totalBudget: number;
  readonly totalActual: number;
  readonly overCount: number;
  /** Bütçesi hiç girilmemiş merkez-grup çiftleri. */
  readonly unbudgetedCount: number;
  readonly unbudgetedAmount: number;
}

/** Aşıma yaklaşma eşiği: bütçenin %90'ı. */
const IZLEME_ESIGI = 0.9;

/**
 * Bütçe–gerçekleşme karşılaştırması.
 *
 * @param month null verilirse yılın tamamı; sayı verilirse o ay.
 *   Aylık sorulduğunda yıllık bütçe 12'ye BÖLÜNMEZ — bölmek,
 *   mevsimsel bir gideri her ay aşmış gösterirdi. Yıllık bütçe
 *   yalnızca yıllık sorguda karşılaştırılır.
 */
export function budgetVsActual(
  year: number,
  month: number | null,
  centers: readonly CostCenterNode[],
  budgets: readonly BudgetLine[],
  actuals: readonly ActualLine[],
): BudgetReport {
  const adlar = new Map(centers.map((c) => [c.code, c.name]));

  // Gerçekleşen: merkez × grup.
  const gercek = new Map<string, number>();
  for (const a of actuals) {
    if (month !== null && a.month !== month) continue;
    const k = `${a.costCenterCode}|${accountGroup(a.accountCode)}`;
    gercek.set(k, kurusla((gercek.get(k) ?? 0) + a.amount));
  }

  // Bütçe: aylık sorguda yalnızca o ayın bütçesi; yıllık sorguda
  // yıllık bütçe + o yılın aylık bütçelerinin toplamı.
  const butce = new Map<string, number>();
  for (const b of budgets) {
    if (b.year !== year) continue;
    if (month !== null && b.month !== month) continue;
    const k = `${b.costCenterCode}|${b.accountGroup}`;
    butce.set(k, kurusla((butce.get(k) ?? 0) + b.amount));
  }

  const anahtarlar = new Set([...gercek.keys(), ...butce.keys()]);
  const rows: VarianceRow[] = [];

  for (const k of anahtarlar) {
    const [merkez, grup] = k.split("|") as [string, string];
    const b = butce.get(k) ?? null;
    const g = kurusla(gercek.get(k) ?? 0);

    /*
     * BÜTÇESİ OLMAYAN GİDER AYRI BİR DURUMDUR.
     *
     * Sıfır bütçe sayılıp %∞ aşım göstermek, tabloyu kırmızıya
     * boyar ve gerçek aşımları görünmez kılar.
     */
    if (b === null) {
      rows.push({
        costCenterCode: merkez,
        costCenterName: adlar.get(merkez) ?? "(tanımsız merkez)",
        accountGroup: grup,
        budget: null,
        actual: g,
        variance: null,
        usedPercent: null,
        status: "unbudgeted",
      });
      continue;
    }

    const fark = kurusla(b - g);
    // Sıfır bütçede oran tanımsızdır; harcama varsa aşımdır.
    const oran = b === 0 ? (g > 0 ? null : 0) : Math.round((g / b) * 1000) / 10;
    rows.push({
      costCenterCode: merkez,
      costCenterName: adlar.get(merkez) ?? "(tanımsız merkez)",
      accountGroup: grup,
      budget: b,
      actual: g,
      variance: fark,
      usedPercent: oran,
      status: fark < 0 ? "over" : b > 0 && g / b >= IZLEME_ESIGI ? "watch" : "none",
    });
  }

  // En kötü durum başta: aşanlar, sonra izlemedekiler, sonra gerisi.
  const sira = { over: 0, unbudgeted: 1, watch: 2, none: 3 } as const;
  rows.sort(
    (a, b) =>
      sira[a.status] - sira[b.status] ||
      (a.variance ?? 0) - (b.variance ?? 0) ||
      b.actual - a.actual,
  );

  const butcesiz = rows.filter((r) => r.status === "unbudgeted");

  return {
    year,
    month,
    rows,
    totalBudget: kurusla(rows.reduce((s, r) => s + (r.budget ?? 0), 0)),
    totalActual: kurusla(rows.reduce((s, r) => s + r.actual, 0)),
    overCount: rows.filter((r) => r.status === "over").length,
    unbudgetedCount: butcesiz.length,
    unbudgetedAmount: kurusla(butcesiz.reduce((s, r) => s + r.actual, 0)),
  };
}
