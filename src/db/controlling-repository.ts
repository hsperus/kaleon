/**
 * Masraf merkezi ve bütçe veri erişimi.
 *
 * GERÇEKLEŞEN GİDER YEVMİYEDEN OKUNUR, AYRI BİR TABLODAN DEĞİL.
 *
 * Bir "gider özeti" tablosu tutup oraya yazmak daha hızlı olurdu ve
 * zamanla defterden ayrışırdı: bir düzeltme fişi deftere girer,
 * özete girmez ve iki rakam birbirini tutmaz. Hangisinin doğru
 * olduğunu söyleyecek kimse kalmaz. Tek kaynak defterdir.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import {
  isExpenseAccount,
  type ActualLine,
  type BudgetLine,
  type CostCenterNode,
} from "../modules/accounting/controlling.js";

function kurusla(n: number): number {
  return Math.round(n * 100) / 100;
}

export class ControllingRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async centers(includeInactive = false): Promise<readonly CostCenterNode[]> {
    const rows = await this.#db.costCenter.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { code: "asc" },
    });
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      parentCode: r.parentCode,
      isActive: r.isActive,
    }));
  }

  async createCenter(input: {
    code: string;
    name: string;
    parentCode: string | null;
    managerEmployeeCode: string | null;
  }): Promise<{ code: string }> {
    if (await this.#db.costCenter.findUnique({ where: { code: input.code } })) {
      throw new BusinessRuleError(
        `${input.code} kodlu masraf merkezi zaten var.`,
        "cost_center_exists",
      );
    }
    if (input.parentCode !== null) {
      const ust = await this.#db.costCenter.findUnique({ where: { code: input.parentCode } });
      if (!ust) {
        throw new BusinessRuleError(
          `Üst merkez ${input.parentCode} bulunamadı. Var olmayan bir üste ` +
            `bağlanan merkez, hiçbir üst raporunda görünmez.`,
          "parent_not_found",
        );
      }
    }
    const row = await this.#db.costCenter.create({
      data: {
        code: input.code,
        name: input.name,
        parentCode: input.parentCode,
        managerEmployeeCode: input.managerEmployeeCode,
      },
    });
    return { code: row.code };
  }

  async budgets(year: number): Promise<readonly BudgetLine[]> {
    const rows = await this.#db.budget.findMany({ where: { year } });
    return rows.map((r) => ({
      costCenterCode: r.costCenterCode,
      accountGroup: r.accountGroup,
      year: r.year,
      month: r.month,
      amount: Number(r.amount),
    }));
  }

  /**
   * Bütçe girer ya da günceller.
   *
   * ÜZERİNE YAZMA BİLİNÇLİ: bütçe revize edilir, bu normaldir. Ama
   * revizyon iz bırakmalı — `set_by` ve `updated_at` kimin ne zaman
   * değiştirdiğini tutuyor.
   */
  async setBudget(input: {
    costCenterCode: string;
    accountGroup: string;
    year: number;
    month: number | null;
    amount: number;
    currency: string;
    note: string | null;
    userId: string;
  }): Promise<{ created: boolean; previous: number | null }> {
    const merkez = await this.#db.costCenter.findUnique({
      where: { code: input.costCenterCode },
    });
    if (!merkez) {
      throw new BusinessRuleError(
        `${input.costCenterCode} kodlu masraf merkezi yok. Önce merkez açılmalı.`,
        "cost_center_not_found",
      );
    }

    const mevcut = await this.#db.budget.findFirst({
      where: {
        costCenterCode: input.costCenterCode,
        accountGroup: input.accountGroup,
        year: input.year,
        month: input.month,
      },
    });

    if (mevcut) {
      await this.#db.budget.update({
        where: { id: mevcut.id },
        data: { amount: input.amount, note: input.note, setBy: input.userId },
      });
      return { created: false, previous: Number(mevcut.amount) };
    }

    await this.#db.budget.create({
      data: {
        costCenterCode: input.costCenterCode,
        accountGroup: input.accountGroup,
        year: input.year,
        month: input.month,
        amount: input.amount,
        currency: input.currency,
        note: input.note,
        setBy: input.userId,
      },
    });
    return { created: true, previous: null };
  }

  /**
   * Gerçekleşen giderler — yevmiyeden, ay kırılımıyla.
   *
   * YALNIZCA GİDER HESAPLARI ve yalnızca masraf merkezi YAZILMIŞ
   * satırlar. Merkezi boş olan bir gider bilerek dışarıda: onu bir
   * merkeze dağıtmak uydurma olurdu. Kaç tanesi olduğu ayrıca
   * raporlanır (`unassigned`).
   */
  async actuals(year: number): Promise<{
    readonly lines: readonly ActualLine[];
    readonly unassigned: { count: number; amount: number };
  }> {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    const rows = await this.#db.journalLine.findMany({
      where: {
        entry: { entryDate: { gte: from, lte: to }, status: { not: "draft" } },
        OR: [{ accountCode: { startsWith: "6" } }, { accountCode: { startsWith: "7" } }],
      },
      select: {
        accountCode: true,
        costCenterCode: true,
        debit: true,
        credit: true,
        entry: { select: { entryDate: true } },
      },
      take: 20_000,
    });

    const lines: ActualLine[] = [];
    let bosAdet = 0;
    let bosTutar = 0;

    for (const r of rows) {
      // Gider hesabında bakiye borç yönlüdür; iade/düzeltme alacaklı.
      const tutar = kurusla(Number(r.debit) - Number(r.credit));
      if (!isExpenseAccount(r.accountCode)) continue;
      if (r.costCenterCode === null) {
        bosAdet += 1;
        bosTutar = kurusla(bosTutar + tutar);
        continue;
      }
      lines.push({
        costCenterCode: r.costCenterCode,
        accountCode: r.accountCode,
        amount: tutar,
        month: r.entry.entryDate.getUTCMonth() + 1,
      });
    }

    return { lines, unassigned: { count: bosAdet, amount: bosTutar } };
  }
}
