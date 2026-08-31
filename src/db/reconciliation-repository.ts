/**
 * Banka mutabakatı ve ihtar veri erişimi.
 *
 * EŞLEŞTİRME TEK İŞLEMDE VE İKİ KISITLA KORUNUYOR: bir ekstre satırı
 * bir kez, bir ödeme bir kez eşleşir. İkisi de veritabanı seviyesinde
 * benzersiz; uygulama kontrolü yalnızca ANLAMLI HATA MESAJI vermek
 * için var, tek savunma değil. Aynı ödemeyi iki satıra bağlamak, aynı
 * parayı iki kez tahsil edilmiş göstermek demektir.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import type { StatementLine, PaymentCandidate } from "../modules/finance/reconciliation.js";
import type { DunningLevel, OverdueInvoice } from "../modules/finance/dunning.js";

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ImportedStatement {
  readonly id: string;
  readonly statementNo: string;
  readonly lineCount: number;
}

export interface StatementLineInput {
  readonly lineNo: number;
  readonly valueDate: Date;
  readonly amount: number;
  readonly description: string;
  readonly counterparty: string | null;
  readonly reference: string | null;
}

export class ReconciliationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Ekstreyi yükler.
   *
   * MÜKERRER YÜKLEME EN SIK HATADIR ve sessiz kalırsa aynı hareketler
   * iki kez görünür. Benzersizlik kısıtı yakalar; burada erken ve
   * anlaşılır bir mesaj veriliyor.
   */
  async importStatement(input: {
    accountExternalId: string;
    currency: string;
    statementNo: string;
    fromDate: Date;
    toDate: Date;
    openingBalance: number;
    closingBalance: number;
    lines: readonly StatementLineInput[];
    userId: string;
  }): Promise<ImportedStatement> {
    const account = await this.#db.bankAccount.findUnique({
      where: {
        externalId_currency: {
          externalId: input.accountExternalId,
          currency: input.currency.toUpperCase(),
        },
      },
    });
    if (!account) {
      throw new BusinessRuleError(
        `${input.accountExternalId} (${input.currency}) hesabı sistemde tanımlı değil. ` +
          `Ekstre bir hesaba bağlanmadan yüklenemez; bağlanmayan hareket hiçbir ` +
          `bakiyeyi denetlemez.`,
        "bank_account_unknown",
      );
    }

    const varMi = await this.#db.bankStatement.findUnique({
      where: {
        accountId_statementNo: { accountId: account.id, statementNo: input.statementNo },
      },
    });
    if (varMi) {
      throw new BusinessRuleError(
        `${input.statementNo} numaralı ekstre bu hesap için zaten yüklenmiş. ` +
          `İkinci kez yüklenirse aynı hareketler iki kez görünür ve mutabakat ` +
          `tutmaz.`,
        "statement_exists",
      );
    }

    const row = await this.#db.bankStatement.create({
      data: {
        accountId: account.id,
        statementNo: input.statementNo,
        fromDate: input.fromDate,
        toDate: input.toDate,
        openingBalance: input.openingBalance,
        closingBalance: input.closingBalance,
        currency: input.currency.toUpperCase(),
        importedBy: input.userId,
        lines: {
          create: input.lines.map((l) => ({
            lineNo: l.lineNo,
            valueDate: l.valueDate,
            amount: l.amount,
            description: l.description,
            counterparty: l.counterparty,
            reference: l.reference,
          })),
        },
      },
    });

    return { id: row.id, statementNo: row.statementNo, lineCount: input.lines.length };
  }

  /** Kapanmamış ekstre satırları — en eski önce. */
  async openLines(limit = 200): Promise<
    readonly (StatementLine & { statementNo: string; currency: string })[]
  > {
    const rows = await this.#db.bankStatementLine.findMany({
      where: { status: "open" },
      include: { statement: { select: { statementNo: true, currency: true } } },
      orderBy: [{ valueDate: "asc" }, { lineNo: "asc" }],
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      lineNo: r.lineNo,
      valueDate: r.valueDate,
      amount: Number(r.amount),
      description: r.description,
      counterparty: r.counterparty,
      reference: r.reference,
      statementNo: r.statement.statementNo,
      currency: r.statement.currency,
    }));
  }

  /** Eşleştirme adayı ödemeler — bir tarih penceresinde. */
  async paymentCandidates(from: Date, to: Date): Promise<readonly PaymentCandidate[]> {
    const rows = await this.#db.payment.findMany({
      where: { paidAt: { gte: from, lte: to } },
      orderBy: { paidAt: "asc" },
      take: 1000,
    });

    const eslesmis = new Set(
      (
        await this.#db.reconciliationMatch.findMany({
          where: { paymentId: { in: rows.map((r) => r.id) } },
          select: { paymentId: true },
        })
      ).map((m) => m.paymentId),
    );

    const cariler = new Map(
      (
        await this.#db.partner.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
          select: { id: true, legalName: true },
        })
      ).map((p) => [p.id, p.legalName]),
    );

    return rows.map((r) => ({
      id: r.id,
      documentNo: r.documentNo,
      direction: r.direction,
      partnerName: cariler.get(r.partnerId) ?? "(cari kartı bulunamadı)",
      amount: Number(r.amount),
      currency: r.currency,
      paidAt: r.paidAt,
      reference: r.reference,
      alreadyMatched: eslesmis.has(r.id),
    }));
  }

  /** Eşleştirmeyi kaydeder ve satırı kapatır. */
  async postMatch(input: {
    lineId: string;
    paymentId: string;
    userId: string;
    score: number | null;
    note: string | null;
  }): Promise<{ lineNo: number; documentNo: string; amount: number }> {
    return this.#db.$transaction(async (tx) => {
      const line = await tx.bankStatementLine.findUnique({
        where: { id: input.lineId },
        include: { match: true },
      });
      if (!line) {
        throw new BusinessRuleError("Ekstre satırı bulunamadı.", "line_not_found");
      }
      if (line.match) {
        throw new BusinessRuleError(
          `Bu satır zaten eşleştirilmiş. Yanlış eşleştiyse önce mevcut ` +
            `eşleşme kaldırılmalı — üzerine yazmak izi siler.`,
          "line_already_matched",
        );
      }

      const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
      if (!payment) {
        throw new BusinessRuleError("Ödeme bulunamadı.", "payment_not_found");
      }

      const baskaSatir = await tx.reconciliationMatch.findUnique({
        where: { paymentId: input.paymentId },
      });
      if (baskaSatir) {
        throw new BusinessRuleError(
          `${payment.documentNo} ödemesi başka bir ekstre satırıyla zaten ` +
            `eşleşmiş. Aynı ödemeyi iki satıra bağlamak, aynı parayı iki kez ` +
            `tahsil edilmiş göstermek demektir.`,
          "payment_already_matched",
        );
      }

      /*
       * TUTAR KONTROLÜ BURADA DA YAPILIR.
       *
       * Öneri motoru zaten tutarı tutmayanı aday saymıyor; ama bu
       * tool elle de çağrılabiliyor ve o yolda hiçbir kontrol
       * olmasaydı, mutabakatın tanımı ihlal edilirdi.
       */
      const beklenen = Math.abs(Number(line.amount));
      if (Math.abs(Number(payment.amount) - beklenen) > 0.005) {
        throw new BusinessRuleError(
          `Tutarlar tutmuyor: ekstre satırı ${beklenen}, ödeme ${Number(payment.amount)}. ` +
            `Mutabakatın tanımı tutarın tutmasıdır.`,
          "amount_mismatch",
        );
      }

      await tx.reconciliationMatch.create({
        data: {
          lineId: input.lineId,
          paymentId: input.paymentId,
          matchedBy: input.userId,
          suggestedScore: input.score,
          note: input.note,
        },
      });
      await tx.bankStatementLine.update({
        where: { id: input.lineId },
        data: { status: "matched" },
      });

      return {
        lineNo: line.lineNo,
        documentNo: payment.documentNo,
        amount: kurusla(Number(payment.amount)),
      };
    });
  }

  // ── İhtar ──

  async dunningLevels(): Promise<readonly DunningLevel[]> {
    const rows = await this.#db.dunningLevel.findMany({ orderBy: { level: "asc" } });
    return rows.map((r) => ({
      level: r.level,
      minOverdueDays: r.minOverdueDays,
      label: r.label,
      interestRate: r.interestRate === null ? null : Number(r.interestRate),
    }));
  }

  /** Cari kimliği → daha önce gönderilen en yüksek kademe. */
  async previousDunningLevels(): Promise<ReadonlyMap<string, number>> {
    const rows = await this.#db.dunningNotice.groupBy({
      by: ["partnerId"],
      _max: { level: true },
    });
    return new Map(rows.map((r) => [r.partnerId, r._max.level ?? 0]));
  }

  /** Vadesi geçmiş satış faturaları — açık tutarıyla. */
  async overdueReceivables(asOf: Date): Promise<readonly OverdueInvoice[]> {
    const invoices = await this.#db.salesInvoice.findMany({
      where: { status: "issued", cancelledAt: null, dueDate: { not: null, lt: asOf } },
      select: {
        documentNo: true,
        partnerId: true,
        totalAmount: true,
        currency: true,
        dueDate: true,
      },
      take: 1000,
    });

    const paid = new Map(
      (
        await this.#db.paymentAllocation.groupBy({
          by: ["invoiceNo"],
          _sum: { amount: true },
        })
      ).map((p) => [p.invoiceNo, Number(p._sum.amount ?? 0)]),
    );

    const cariler = new Map(
      (
        await this.#db.partner.findMany({
          where: { id: { in: [...new Set(invoices.map((i) => i.partnerId))] } },
          select: { id: true, legalName: true },
        })
      ).map((p) => [p.id, p.legalName]),
    );

    return invoices
      .map((i) => ({
        documentNo: i.documentNo,
        partnerId: i.partnerId,
        partnerName: cariler.get(i.partnerId) ?? "(cari kartı bulunamadı)",
        openAmount: kurusla(Number(i.totalAmount) - (paid.get(i.documentNo) ?? 0)),
        currency: i.currency,
        dueDate: i.dueDate!,
      }))
      .filter((i) => i.openAmount > 0.005);
  }

  /** İhtarı kaydeder. Mektup metni ayrıca üretilir; burada iz kalır. */
  async recordNotice(input: {
    documentNo: string;
    partnerId: string;
    level: number;
    issuedAt: Date;
    totalAmount: number;
    currency: string;
    oldestOverdueDays: number;
    invoiceNos: readonly string[];
    userId: string;
  }): Promise<{ documentNo: string }> {
    const row = await this.#db.dunningNotice.create({
      data: {
        documentNo: input.documentNo,
        partnerId: input.partnerId,
        level: input.level,
        issuedAt: input.issuedAt,
        totalAmount: input.totalAmount,
        currency: input.currency,
        oldestOverdueDays: input.oldestOverdueDays,
        invoiceNos: [...input.invoiceNos],
        issuedBy: input.userId,
      },
    });
    return { documentNo: row.documentNo };
  }

  /** Bir sonraki ihtar belge numarası. */
  async nextNoticeNo(year: number): Promise<string> {
    const n = await this.#db.dunningNotice.count({
      where: { documentNo: { startsWith: `IHT-${year}-` } },
    });
    return `IHT-${year}-${String(n + 1).padStart(4, "0")}`;
  }
}
