/**
 * KDV beyannamesi taslağı (KDV1).
 *
 * TASLAKTIR, BEYAN DEĞİLDİR. Anayasa gereği resmî beyan göndermeyi bu
 * sistem yapmaz ve yapamaz — beyannameyi mali müşavir onaylar ve gönderir.
 * Ama taslağı hazırlamak, ay sonunda dört saatlik bir işi dört dakikaya
 * indirir ve en önemlisi RAKAMLARIN NEREDEN GELDİĞİNİ gösterir.
 *
 * İKİ RAKAM, İKİ HESAP:
 *   391 Hesaplanan KDV   → satışlardan tahsil edilen (devlete borç)
 *   191 İndirilecek KDV  → alışlarda ödenen (devletten alacak)
 * Fark pozitifse ÖDENECEK, negatifse DEVREDEN KDV'dir.
 *
 * DEVREDEN KDV KAYBOLMAZ. Bir ay indirilemeyen KDV sonraki aya devreder;
 * sıfırlanırsa mükellef kendi parasını devlete bağışlamış olur. Önceki
 * dönemden devir bu yüzden girdi olarak alınır.
 */

export class VatReturnError extends Error {
  readonly code = "vat_return";
  constructor(message: string) {
    super(message);
    this.name = "VatReturnError";
  }
}

export interface VatReturnInput {
  readonly year: number;
  readonly month: number;
  /** 600/601 hesaplarının alacak toplamı — matrah. */
  readonly salesBase: number;
  /** 391 Hesaplanan KDV alacak toplamı. */
  readonly outputVat: number;
  /** 191 İndirilecek KDV borç toplamı. */
  readonly inputVat: number;
  /** Önceki dönemden devreden KDV. */
  readonly carriedForward: number;
  /** Mizan denk mi — değilse beyanname güvenilir değildir. */
  readonly ledgerBalanced: boolean;
}

export interface VatReturn {
  readonly period: string;
  readonly salesBase: number;
  readonly outputVat: number;
  readonly inputVat: number;
  readonly carriedForward: number;
  /** Ödenecek KDV. Sıfırdan büyükse ödeme çıkar. */
  readonly payable: number;
  /** Sonraki aya devreden KDV. */
  readonly carryForward: number;
  readonly warnings: readonly string[];
  readonly summary: string;
}

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number) => `${TR.format(n)} TL`;

export function buildVatReturn(input: VatReturnInput): VatReturn {
  const warnings: string[] = [];

  if (!input.ledgerBalanced) {
    warnings.push(
      "MİZAN DENK DEĞİL. Bu beyanname taslağındaki hiçbir rakama güvenilemez; " +
        "önce tek taraflı kayıt bulunmalıdır.",
    );
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const deductible = round(input.inputVat + input.carriedForward);
  const difference = round(input.outputVat - deductible);

  const payable = difference > 0 ? difference : 0;
  const carryForward = difference < 0 ? round(-difference) : 0;

  if (input.outputVat === 0 && input.salesBase > 0) {
    warnings.push(
      "Satış var ama hesaplanan KDV sıfır. İhracat veya istisna değilse, " +
        "faturalarda KDV işlenmemiş olabilir.",
    );
  }
  if (input.inputVat === 0 && input.outputVat > 0) {
    warnings.push(
      "İndirilecek KDV sıfır. Alış faturaları muhasebeleşmemiş olabilir; bu durumda " +
        "ödenecek KDV OLDUĞUNDAN YÜKSEK çıkar.",
    );
  }
  if (carryForward > 0) {
    warnings.push(
      `${money(carryForward)} devreden KDV sonraki aya taşınır. Sıfırlanırsa mükellef ` +
        `kendi parasını devlete bırakmış olur.`,
    );
  }

  return {
    period: `${input.year}/${String(input.month).padStart(2, "0")}`,
    salesBase: round(input.salesBase),
    outputVat: round(input.outputVat),
    inputVat: round(input.inputVat),
    carriedForward: round(input.carriedForward),
    payable,
    carryForward,
    warnings,
    summary:
      payable > 0
        ? `${input.year}/${String(input.month).padStart(2, "0")}: hesaplanan ${money(input.outputVat)}, ` +
          `indirilecek ${money(deductible)} → ÖDENECEK ${money(payable)}.`
        : `${input.year}/${String(input.month).padStart(2, "0")}: hesaplanan ${money(input.outputVat)}, ` +
          `indirilecek ${money(deductible)} → ödenecek KDV yok, ${money(carryForward)} devrediyor.`,
  };
}
