/**
 * Ödeme koşusu — "elimizdeki parayla kime ödeyelim".
 *
 * SİSTEMDE TEK TEK ÖDEME VARDI, SIRALAMA YOKTU. `post_payment` bir
 * faturayı kapatıyordu; ama hangi faturaların önce ödeneceğine karar
 * veren hiçbir şey yoktu. Karar Excel'de veriliyordu ve Excel'de
 * verilen karar, bloke faturayı, mükerrer ödemeyi ve kasayı sıfıra
 * indirmeyi göremez.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * BU BİR ÖNERİDİR, ÖDEME DEĞİLDİR. Hiçbir kayıt yazmaz, bankaya
 * talimat göndermez. Önerilen faturalar `post_payment` ile tek tek
 * ve onay kapısından geçerek ödenir. Ayrım bilinçli: parayı gönderen
 * karar insanın olmalı, sıralamayı yapan işin makinenin.
 *
 * BLOKE FATURA ÖNERİLMEZ. Üç yönlü mutabakat bir farkı bloke etmişse,
 * o farkın çözülmesi ödemeden önce gelir. Öneriye girseydi, kontrolün
 * tamamı bir tıkla aşılırdı.
 *
 * KASA TABANI KORUNUR. Eldeki nakdin tamamını dağıtan bir öneri,
 * ertesi gün maaş ya da vergi çıkacağını bilmez. Kullanıcı bir taban
 * verir; öneri o tabanın altına inmez.
 *
 * VADESİ BİLİNMEYEN FATURA SIRAYA SOKULMAZ. Sırayı vade belirliyor;
 * vadesi olmayanı "en acil" ya da "en sonda" saymak, ikisi de
 * uydurmadır. Ayrı listede, kullanıcının kararına bırakılır.
 */

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

const GUN = 86_400_000;

export class PaymentRunError extends Error {
  readonly code = "payment_run";
  constructor(message: string) {
    super(message);
    this.name = "PaymentRunError";
  }
}

export interface PayableCandidate {
  readonly documentNo: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly openAmount: number;
  readonly currency: string;
  readonly dueDate: Date | null;
  /** matched | blocked | pending */
  readonly matchStatus: string;
}

export interface ProposedPayment {
  readonly documentNo: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly amount: number;
  readonly dueDate: string | null;
  /** Pozitif: bu kadar gün gecikmiş. Negatif: vadesine bu kadar gün var. */
  readonly overdueDays: number;
}

export interface DeferredPayment extends ProposedPayment {
  /** Neden bu koşuda ödenmiyor. */
  readonly reason: string;
}

export interface PaymentRunPlan {
  readonly asOf: string;
  readonly availableCash: number;
  readonly cashFloor: number;
  readonly spendable: number;
  readonly proposed: readonly ProposedPayment[];
  readonly proposedTotal: number;
  readonly remainingCash: number;
  readonly deferred: readonly DeferredPayment[];
  readonly deferredTotal: number;
  /** Bloke oldukları için hiç değerlendirilmeyenler. */
  readonly blocked: readonly { documentNo: string; partnerName: string; amount: number }[];
  /** Vadesi bilinmediği için sıraya girmeyenler. */
  readonly undated: readonly { documentNo: string; partnerName: string; amount: number }[];
  /**
   * Yabancı para faturalar — sıraya GİRMEZ.
   *
   * TL kasayla EUR faturayı aynı sırada karşılaştırmak, araya bir kur
   * koymak demektir. O kur bugünün mü, faturanın mı, ödeme gününün mü
   * olacağı bir karardır ve burada sessizce verilemez. Ayrı listelenir.
   */
  readonly foreignCurrency: readonly {
    documentNo: string;
    partnerName: string;
    amount: number;
    currency: string;
  }[];
}

/**
 * Ödeme önerisi üretir.
 *
 * SIRALAMA: en çok gecikmiş önce. Eşit gecikmede büyük tutar önce —
 * çünkü gecikmenin maliyeti tutarla orantılıdır ve tedarikçi ilişkisi
 * en çok orada zorlanır.
 *
 * KISMİ ÖDEME YAPILMAZ. Kalan para bir faturaya yetmiyorsa o fatura
 * atlanır ve sıradaki denenir. Kısmi ödeme faturayı kapatmaz, cari
 * mutabakatını karmaşıklaştırır ve tedarikçiyi memnun etmez.
 */
export function planPaymentRun(
  asOf: Date,
  availableCash: number,
  cashFloor: number,
  candidates: readonly PayableCandidate[],
  currency = "TRY",
): PaymentRunPlan {
  if (cashFloor < 0) {
    throw new PaymentRunError("Kasa tabanı negatif olamaz.");
  }
  if (availableCash < 0) {
    throw new PaymentRunError(
      "Eldeki nakit negatif verildi. Banka bakiyesi eksideyse ödeme koşusu " +
        "yapılmaz; önce finansman kararı gerekir.",
    );
  }

  const bugun = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const gunFarki = (d: Date) => Math.floor((bugun.getTime() - d.getTime()) / GUN);

  const bloke = candidates.filter((c) => c.matchStatus === "blocked");
  const yabanci = candidates.filter(
    (c) => c.matchStatus !== "blocked" && c.currency.toUpperCase() !== currency.toUpperCase(),
  );
  const kalanlar = candidates.filter(
    (c) => c.matchStatus !== "blocked" && c.currency.toUpperCase() === currency.toUpperCase(),
  );
  const vadesiz = kalanlar.filter((c) => c.dueDate === null);

  const sirali = kalanlar
    .filter((c) => c.dueDate !== null && c.openAmount > 0)
    .sort((a, b) => {
      const fa = gunFarki(a.dueDate!);
      const fb = gunFarki(b.dueDate!);
      return fb - fa || b.openAmount - a.openAmount;
    });

  const harcanabilir = kurusla(Math.max(0, availableCash - cashFloor));
  let kasa = harcanabilir;

  const onerilen: ProposedPayment[] = [];
  const ertelenen: DeferredPayment[] = [];

  for (const c of sirali) {
    const satir: ProposedPayment = {
      documentNo: c.documentNo,
      partnerId: c.partnerId,
      partnerName: c.partnerName,
      amount: kurusla(c.openAmount),
      dueDate: c.dueDate!.toISOString().slice(0, 10),
      overdueDays: gunFarki(c.dueDate!),
    };

    if (c.openAmount <= kasa) {
      onerilen.push(satir);
      kasa = kurusla(kasa - c.openAmount);
    } else {
      ertelenen.push({
        ...satir,
        reason:
          satir.overdueDays > 0
            ? `Nakit yetmiyor; ${satir.overdueDays} gündür gecikmiş.`
            : "Nakit yetmiyor.",
      });
    }
  }

  const topla = (xs: readonly { amount: number }[]) =>
    kurusla(xs.reduce((s, x) => s + x.amount, 0));

  return {
    asOf: bugun.toISOString().slice(0, 10),
    availableCash: kurusla(availableCash),
    cashFloor: kurusla(cashFloor),
    spendable: harcanabilir,
    proposed: onerilen,
    proposedTotal: topla(onerilen),
    remainingCash: kurusla(availableCash - topla(onerilen)),
    deferred: ertelenen,
    deferredTotal: topla(ertelenen),
    blocked: bloke.map((c) => ({
      documentNo: c.documentNo,
      partnerName: c.partnerName,
      amount: kurusla(c.openAmount),
    })),
    undated: vadesiz.map((c) => ({
      documentNo: c.documentNo,
      partnerName: c.partnerName,
      amount: kurusla(c.openAmount),
    })),
    foreignCurrency: yabanci.map((c) => ({
      documentNo: c.documentNo,
      partnerName: c.partnerName,
      amount: kurusla(c.openAmount),
      currency: c.currency.toUpperCase(),
    })),
  };
}
