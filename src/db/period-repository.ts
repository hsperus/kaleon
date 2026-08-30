/**
 * Muhasebe dönemi deposu.
 *
 * DÖNEM KONTROLÜ YAZMA İŞLEMİNİN İÇİNDE YAPILIR, çağıranın iyi niyetine
 * bırakılmaz. Ayrı bir "önce kontrol et" çağrısı olsaydı, bir gün birisi
 * onu atlar ve kapalı aya kayıt girerdi — üstelik atladığı hiçbir yerde
 * görünmezdi.
 */

import type { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import {
  assertPostable,
  assertTransition,
  closeBlockers,
  periodOf,
  periodOrdinal,
  PeriodError,
  type CloseBlocker,
  type PeriodStatus,
} from "../modules/finance/period.js";

type Tx = Prisma.TransactionClient;

export interface PeriodView {
  readonly year: number;
  readonly month: number;
  readonly status: PeriodStatus;
  readonly closedAt: string | null;
}

/**
 * Bir tarihin döneminin yazılabilir olduğunu doğrular.
 *
 * `tx` alır: kontrol, yazmayla AYNI işlemde olmalıdır. Ayrı bir bağlantıda
 * yapılsaydı, kontrolle yazma arasında dönem kapanabilirdi.
 */
export async function assertPeriodOpen(
  tx: Tx,
  date: Date,
  what: string,
): Promise<void> {
  const p = periodOf(date);
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "accounting_periods" WHERE "year" = ${p.year} AND "month" = ${p.month}`;
  assertPostable(date, (rows[0]?.status as PeriodStatus | undefined) ?? null, what);
}

export class PeriodRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async statusOf(date: Date): Promise<PeriodView> {
    const p = periodOf(date);
    const row = await this.#db.accountingPeriod.findUnique({
      where: { year_month: { year: p.year, month: p.month } },
    });
    return {
      year: p.year,
      month: p.month,
      status: (row?.status as PeriodStatus) ?? "open",
      closedAt: row?.closedAt?.toISOString() ?? null,
    };
  }

  async list(year: number): Promise<readonly PeriodView[]> {
    const rows = await this.#db.accountingPeriod.findMany({
      where: { year },
      orderBy: { month: "asc" },
    });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    return Array.from({ length: 12 }, (_, i) => {
      const row = byMonth.get(i + 1);
      return {
        year,
        month: i + 1,
        status: (row?.status as PeriodStatus) ?? "open",
        closedAt: row?.closedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Kapamayı engelleyen kalemleri sayar. YAZMA YAPMAZ — kapamadan önce
   * kullanıcıya gösterilir.
   */
  async blockersFor(year: number, month: number): Promise<readonly CloseBlocker[]> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));

    const [draftInvoices, unvaluedMovements, deliveries, previous] = await Promise.all([
      this.#db.salesInvoice.count({
        where: { status: "draft", issuedAt: { gte: from, lt: to } },
      }),
      this.#db.stockMovement.count({
        where: { at: { gte: from, lt: to }, unitCost: null },
      }),
      this.#db.delivery.findMany({
        where: { status: "posted", shippedAt: { gte: from, lt: to } },
        select: { id: true },
      }),
      this.#previousPeriodOpen(year, month),
    ]);

    // Faturalanmamış sevkiyat = hiçbir fatura satırının işaret etmediği irsaliye.
    let uninvoiced = 0;
    if (deliveries.length > 0) {
      const invoiced = await this.#db.salesInvoiceLine.findMany({
        where: { deliveryId: { in: deliveries.map((d) => d.id) } },
        select: { deliveryId: true },
        distinct: ["deliveryId"],
      });
      const seen = new Set(invoiced.map((i) => i.deliveryId));
      uninvoiced = deliveries.filter((d) => !seen.has(d.id)).length;
    }

    return closeBlockers({
      draftInvoices,
      unvaluedMovements,
      openDeliveriesUninvoiced: uninvoiced,
      previousPeriodOpen: previous,
    });
  }

  async #previousPeriodOpen(year: number, month: number): Promise<boolean> {
    const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

    // İLK DÖNEMDEN ÖNCESİ SORULMAZ. Hiç kayıt yoksa sistem henüz
    // kullanılmamıştır ve "önceki dönem açık" demek anlamsızdır.
    const anyEarlier = await this.#db.accountingPeriod.findFirst({
      where: { OR: [{ year: { lt: prev.year } }, { year: prev.year, month: { lte: prev.month } }] },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
    if (!anyEarlier) return false;

    return periodOrdinal({ year: anyEarlier.year, month: anyEarlier.month }) ===
      periodOrdinal(prev)
      ? anyEarlier.status === "open"
      : // Aradaki bir dönemin kaydı yoksa o dönem açıktır.
        true;
  }

  /**
   * Dönemi kapatır.
   *
   * ENGELLER ZORLA AŞILABİLİR AMA SESSİZCE DEĞİL: `force` verilirse engel
   * listesi kapama kaydına yazılır. Hiç aşılamasaydı, gerçekten kapatılması
   * gereken bir dönem tek bir eski hareket yüzünden sonsuza dek açık kalırdı.
   */
  async close(input: {
    year: number;
    month: number;
    userId: string;
    force?: boolean;
  }): Promise<{ status: PeriodStatus; blockers: readonly CloseBlocker[] }> {
    const blockers = await this.blockersFor(input.year, input.month);
    if (blockers.length > 0 && !input.force) {
      return { status: "open", blockers };
    }

    const current = await this.#db.accountingPeriod.findUnique({
      where: { year_month: { year: input.year, month: input.month } },
    });
    assertTransition((current?.status as PeriodStatus) ?? "open", "closed");

    await this.#db.accountingPeriod.upsert({
      where: { year_month: { year: input.year, month: input.month } },
      create: {
        year: input.year,
        month: input.month,
        status: "closed",
        closedAt: new Date(),
        closedBy: input.userId,
      },
      update: { status: "closed", closedAt: new Date(), closedBy: input.userId },
    });

    return { status: "closed", blockers };
  }

  /** Kapalı dönemi yeniden açar — SEBEP ZORUNLUDUR ve kayda geçer. */
  async reopen(input: {
    year: number;
    month: number;
    userId: string;
    reason: string;
  }): Promise<void> {
    if (input.reason.trim().length < 5) {
      throw new PeriodError(
        "Dönem yeniden açma sebebi yazılmalıdır; sebepsiz açılan dönem denetlenemez.",
      );
    }

    const current = await this.#db.accountingPeriod.findUnique({
      where: { year_month: { year: input.year, month: input.month } },
    });
    if (!current) {
      throw new PeriodError(`${input.year}/${input.month} dönemi zaten açık.`);
    }
    assertTransition(current.status as PeriodStatus, "open");

    await this.#db.accountingPeriod.update({
      where: { id: current.id },
      data: {
        status: "open",
        reopenReason: input.reason,
        reopenedAt: new Date(),
        reopenedBy: input.userId,
      },
    });
  }

  /** Yılı kilitler — geri alınamaz. */
  async lock(year: number, month: number): Promise<void> {
    const current = await this.#db.accountingPeriod.findUnique({
      where: { year_month: { year, month } },
    });
    assertTransition((current?.status as PeriodStatus) ?? "open", "locked");
    await this.#db.accountingPeriod.update({
      where: { id: current!.id },
      data: { status: "locked" },
    });
  }
}
