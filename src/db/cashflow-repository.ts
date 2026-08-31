/**
 * Nakit akışı ve ödeme koşusu için açık belge listeleri.
 *
 * NEDEN AYRI BİR REPOSITORY: mevcut `openPayables` bloke faturaları
 * baştan eliyordu ve cari adını getirmiyordu. Ödeme koşusu ikisine de
 * ihtiyaç duyar — bloke faturayı ÖNERMEZ ama kullanıcıya "şu kadar
 * tutar bloke, çözülmesi gerekiyor" demek zorundadır. Görünmeyen bir
 * bloke, çözülmeyen bir blokedir.
 *
 * AÇIK TUTAR = TUTAR − DAĞITILMIŞ ÖDEME. Faturanın üzerinde "ödendi"
 * diye bir bayrak tutulmuyor; bayrak ile dağıtım zamanla ayrışır ve
 * hangisinin doğru olduğu belirsizleşir. Tek kaynak dağıtım kayıtları.
 *
 * SATIŞ FATURASINDA TUTAR BAŞLIKTA, ALIŞ FATURASINDA SATIRLARDA.
 * Satış faturası kendi toplamını taşıyor (`total_amount`); gelen
 * fatura entegratörden satır satır geliyor ve toplamı satırlardan
 * hesaplanıyor. Asimetri veri modelinden geliyor, burada gizlenmiyor.
 */

import type { TenantDb } from "./client.js";

/** Kuruş yuvarlaması — para her yerde iki hane. */
function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface OpenDocument {
  readonly documentNo: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly openAmount: number;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly dueDate: Date | null;
  /** Gelen faturada mutabakat durumu; satış faturasında hep "matched". */
  readonly matchStatus: string;
}

/**
 * Kapanmamış belgeler tarandığında bu sınıra kadar bakılır.
 *
 * Sınır sessiz değildir: çağıran taraf `truncated` bayrağını görür ve
 * kullanıcıya bildirir. Kesilmiş bir listeden çıkarılan nakit
 * projeksiyonu, kesildiği söylenmezse yalandır.
 */
const TARAMA_SINIRI = 2000;

export class CashFlowRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** Belge no → dağıtılmış ödeme toplamı. */
  async #paidByInvoice(): Promise<Map<string, number>> {
    const rows = await this.#db.paymentAllocation.groupBy({
      by: ["invoiceNo"],
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.invoiceNo, Number(r._sum.amount ?? 0)]));
  }

  /** Cari kimliği → unvan. Rakamın yanında isim olmayınca kimse bakmaz. */
  async #partnerNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.#db.partner.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, legalName: true },
    });
    return new Map(rows.map((p) => [p.id, p.legalName]));
  }

  /** Tahsil edilmemiş satış faturaları. İptal ve taslak hariç. */
  async openReceivables(): Promise<{ rows: readonly OpenDocument[]; truncated: boolean }> {
    const invoices = await this.#db.salesInvoice.findMany({
      where: { status: "issued", cancelledAt: null },
      select: {
        documentNo: true,
        partnerId: true,
        totalAmount: true,
        currency: true,
        issuedAt: true,
        dueDate: true,
      },
      orderBy: { issuedAt: "asc" },
      take: TARAMA_SINIRI + 1,
    });

    const truncated = invoices.length > TARAMA_SINIRI;
    const kesilmis = truncated ? invoices.slice(0, TARAMA_SINIRI) : invoices;

    const paid = await this.#paidByInvoice();
    const names = await this.#partnerNames(kesilmis.map((i) => i.partnerId));

    const rows = kesilmis
      .map((i) => ({
        documentNo: i.documentNo,
        partnerId: i.partnerId,
        partnerName: names.get(i.partnerId) ?? "(cari kartı bulunamadı)",
        openAmount: kurusla(Number(i.totalAmount) - (paid.get(i.documentNo) ?? 0)),
        currency: i.currency,
        issuedAt: i.issuedAt,
        dueDate: i.dueDate,
        matchStatus: "matched",
      }))
      // Yarım kuruşun altı kapanmış sayılır: küsurat farkı yüzünden
      // faturayı "açık" göstermek mutabakatta gereksiz tartışma yaratır.
      .filter((r) => r.openAmount > 0.005);

    return { rows, truncated };
  }

  /**
   * Ödenmemiş tedarikçi faturaları — BLOKE OLANLAR DA DAHİL.
   *
   * Ödeme koşusu bunları önermez ama saymak ve göstermek zorundadır.
   */
  async openPayables(): Promise<{ rows: readonly OpenDocument[]; truncated: boolean }> {
    const invoices = await this.#db.invoice.findMany({
      select: {
        documentNo: true,
        partnerId: true,
        currency: true,
        issuedAt: true,
        dueDate: true,
        matchStatus: true,
        lines: { select: { quantity: true, unitPrice: true } },
      },
      orderBy: { issuedAt: "asc" },
      take: TARAMA_SINIRI + 1,
    });

    const truncated = invoices.length > TARAMA_SINIRI;
    const kesilmis = truncated ? invoices.slice(0, TARAMA_SINIRI) : invoices;

    const paid = await this.#paidByInvoice();
    const names = await this.#partnerNames(kesilmis.map((i) => i.partnerId));

    const rows = kesilmis
      .map((i) => {
        const total = kurusla(
          i.lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unitPrice), 0),
        );
        return {
          documentNo: i.documentNo,
          partnerId: i.partnerId,
          partnerName: names.get(i.partnerId) ?? "(cari kartı bulunamadı)",
          openAmount: kurusla(total - (paid.get(i.documentNo) ?? 0)),
          currency: i.currency,
          issuedAt: i.issuedAt,
          dueDate: i.dueDate,
          matchStatus: i.matchStatus,
        };
      })
      .filter((r) => r.openAmount > 0.005);

    return { rows, truncated };
  }

  /**
   * Bir gelen faturaya vade yazar.
   *
   * Vade sonradan girilebilmelidir: fatura entegratörden vadesiz gelir,
   * vadeyi satın alma sözleşmesi bilir. Girilemeseydi o fatura ödeme
   * koşusuna hiç giremez ve sessizce ödenmeden kalırdı.
   */
  async setPayableDueDate(documentNo: string, dueDate: Date): Promise<{ partnerId: string }> {
    const inv = await this.#db.invoice.findFirst({
      where: { documentNo },
      select: { id: true, partnerId: true, issuedAt: true },
    });
    if (!inv) {
      throw new Error(`${documentNo} numaralı gelen fatura bulunamadı.`);
    }
    const gun = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (gun(dueDate) < gun(inv.issuedAt)) {
      throw new Error(
        `${documentNo}: vade (${dueDate.toISOString().slice(0, 10)}) fatura tarihinden ` +
          `(${inv.issuedAt.toISOString().slice(0, 10)}) önce olamaz.`,
      );
    }
    await this.#db.invoice.update({ where: { id: inv.id }, data: { dueDate } });
    return { partnerId: inv.partnerId };
  }
}
