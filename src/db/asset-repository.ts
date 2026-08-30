/**
 * Sabit kıymet kalıcılığı.
 *
 * AMORTİSMAN AYIRMAK MUHASEBE KAYDI YAZAR. Yalnızca bir tabloya satır
 * eklemek yetmez: gider hesabı borçlanır, birikmiş amortisman
 * alacaklanır ve bu kayıt yevmiyeye düşmezse bilanço ile amortisman
 * tablosu birbirini tutmaz. İkisi AYNI İŞLEMDE yazılır; biri
 * başarısız olursa ikisi de geri alınır.
 */

import type { TenantDb } from "./client.js";
import { JournalRepository } from "./journal-repository.js";
import {
  disposalResult,
  schedule,
  DepreciationError,
  type Method,
} from "../modules/assets/depreciation.js";

export interface AssetView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly acquiredAt: string;
  readonly cost: number;
  readonly usefulLifeYears: number;
  readonly method: Method;
  readonly prorated: boolean;
  readonly assetAccount: string;
  readonly expenseAccount: string;
  readonly status: string;
  /** Bugüne kadar ayrılmış amortisman. */
  readonly accumulated: number;
  /** Net defter değeri = maliyet − birikmiş. */
  readonly bookValue: number;
  readonly disposedAt: string | null;
  readonly serial: string | null;
  readonly note: string | null;
}

export class AssetError extends Error {
  readonly code = "asset";
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

const num = (v: unknown): number => Number(v ?? 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

export class AssetRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async create(input: {
    code: string;
    name: string;
    category: string;
    acquiredAt: Date;
    cost: number;
    usefulLifeYears: number;
    method: Method;
    prorated: boolean;
    assetAccount: string;
    expenseAccount: string;
    serial?: string | null;
    note?: string | null;
  }): Promise<AssetView> {
    // Hesap tablosu kurulmadan kıymet açılamaz: kayıt yazılamayacak
    // bir kıymet, amortismanı sistemin dışında bırakır.
    const existing = await this.#db.fixedAsset.findUnique({ where: { code: input.code } });
    if (existing) throw new AssetError(`${input.code} kodlu kıymet zaten var.`);

    // Hesap tablosunu doğrula — çizelge hesaplanabiliyorsa girdi tutarlıdır.
    schedule({
      cost: input.cost,
      usefulLifeYears: input.usefulLifeYears,
      method: input.method,
      acquiredAt: input.acquiredAt,
      prorated: input.prorated,
    });

    const row = await this.#db.fixedAsset.create({
      data: {
        code: input.code,
        name: input.name,
        category: input.category,
        acquiredAt: input.acquiredAt,
        cost: input.cost,
        usefulLifeYears: input.usefulLifeYears,
        method: input.method,
        prorated: input.prorated,
        assetAccount: input.assetAccount,
        expenseAccount: input.expenseAccount,
        serial: input.serial ?? null,
        note: input.note ?? null,
      },
    });
    return this.#view(row, 0);
  }

  #view(row: Record<string, unknown>, accumulated: number): AssetView {
    const cost = num(row["cost"]);
    return {
      id: String(row["id"]),
      code: String(row["code"]),
      name: String(row["name"]),
      category: String(row["category"]),
      acquiredAt: iso(row["acquiredAt"] as Date),
      cost,
      usefulLifeYears: Number(row["usefulLifeYears"]),
      method: row["method"] as Method,
      prorated: Boolean(row["prorated"]),
      assetAccount: String(row["assetAccount"]),
      expenseAccount: String(row["expenseAccount"]),
      status: String(row["status"]),
      accumulated: round2(accumulated),
      bookValue: round2(cost - accumulated),
      disposedAt: row["disposedAt"] ? iso(row["disposedAt"] as Date) : null,
      serial: (row["serial"] as string | null) ?? null,
      note: (row["note"] as string | null) ?? null,
    };
  }

  /**
   * Sabit kıymet mutabakatı — KAYIT ile DEFTER karşılaştırması.
   *
   * SABİT KIYMET KARTI MUHASEBE KAYDI YAZMAZ. Kıymet, satın alma
   * faturasıyla zaten deftere girmiştir; kart yalnızca amortismanın
   * hesaplanabilmesi için künyeyi tutar. Bu doğru bir ayrımdır ama bir
   * risk taşır: kart açılır, fatura kaydı unutulur (ya da tersi) ve
   * ikisi sessizce ayrışır. Bilanço bir rakam, kıymet listesi başka
   * bir rakam söyler — ve hangisinin doğru olduğu anlaşılamaz.
   *
   * MUHASEBECİNİN HER DÖNEM ELLE YAPTIĞI KONTROL BUDUR. Sistemde
   * olmadığı sürece, olmayan bir kontroldür.
   */
  async reconcile(): Promise<{
    registerCost: number;
    ledgerCost: number;
    costDifference: number;
    registerAccumulated: number;
    ledgerAccumulated: number;
    accumulatedDifference: number;
    matched: boolean;
    byAccount: readonly { account: string; register: number; ledger: number; difference: number }[];
  }> {
    const assets = await this.#db.fixedAsset.findMany({
      where: { status: { not: "elden_cikarildi" } },
      include: { runs: { select: { amount: true } } },
    });

    const registerByAccount = new Map<string, number>();
    let registerCost = 0;
    let registerAccumulated = 0;
    const depAccounts = new Set<string>();

    for (const a of assets) {
      const cost = num(a.cost);
      registerCost += cost;
      registerByAccount.set(a.assetAccount, (registerByAccount.get(a.assetAccount) ?? 0) + cost);
      registerAccumulated += a.runs.reduce((s, r) => s + num(r.amount), 0);
      depAccounts.add(a.depreciationAccount);
    }

    const accounts = [...registerByAccount.keys()];
    const totals = accounts.length === 0 && depAccounts.size === 0
      ? []
      : await this.#db.journalLine.groupBy({
          by: ["accountCode"],
          where: {
            accountCode: { in: [...accounts, ...depAccounts] },
            entry: { status: { not: "draft" } },
          },
          _sum: { debit: true, credit: true },
        });

    const ledger = new Map(
      totals.map((t) => [t.accountCode, num(t._sum.debit) - num(t._sum.credit)]),
    );

    const byAccount = accounts.map((acc) => {
      const register = round2(registerByAccount.get(acc) ?? 0);
      const led = round2(ledger.get(acc) ?? 0);
      return { account: acc, register, ledger: led, difference: round2(register - led) };
    });

    // Birikmiş amortisman ALACAK bakiyelidir; defter değeri negatif
    // çıkar ve kayıtla karşılaştırmak için işareti çevrilir.
    const ledgerAccumulated = round2(
      [...depAccounts].reduce((s, acc) => s - (ledger.get(acc) ?? 0), 0),
    );

    const costDifference = round2(registerCost - byAccount.reduce((s, x) => s + x.ledger, 0));
    const accumulatedDifference = round2(registerAccumulated - ledgerAccumulated);

    return {
      registerCost: round2(registerCost),
      ledgerCost: round2(byAccount.reduce((s, x) => s + x.ledger, 0)),
      costDifference,
      registerAccumulated: round2(registerAccumulated),
      ledgerAccumulated,
      accumulatedDifference,
      // Kuruş toleransı yuvarlamayı susturur, gerçek farkı gizlemez.
      matched: Math.abs(costDifference) < 0.011 && Math.abs(accumulatedDifference) < 0.011,
      byAccount,
    };
  }

  async list(status?: string): Promise<readonly AssetView[]> {
    const rows = await this.#db.fixedAsset.findMany({
      ...(status ? { where: { status } } : {}),
      include: { runs: { select: { amount: true } } },
      orderBy: { code: "asc" },
      take: 500,
    });
    return rows.map((r) =>
      this.#view(r as never, r.runs.reduce((s, x) => s + num(x.amount), 0)),
    );
  }

  async byCode(code: string): Promise<{ asset: AssetView; runs: readonly { year: number; amount: number; accumulated: number; bookValue: number; months: number; documentNo: string | null }[] } | null> {
    const row = await this.#db.fixedAsset.findUnique({
      where: { code },
      include: { runs: { orderBy: { year: "asc" } } },
    });
    if (!row) return null;
    const accumulated = row.runs.reduce((s, x) => s + num(x.amount), 0);
    return {
      asset: this.#view(row as never, accumulated),
      runs: row.runs.map((r) => ({
        year: r.year,
        amount: num(r.amount),
        accumulated: num(r.accumulated),
        bookValue: num(r.bookValue),
        months: r.months,
        documentNo: r.journalDocumentNo,
      })),
    };
  }

  /** Kıymetin ömrü boyunca amortisman tablosu — henüz ayrılmamış yıllar dahil. */
  async scheduleFor(code: string) {
    const row = await this.#db.fixedAsset.findUnique({
      where: { code },
      include: { runs: { select: { year: true } } },
    });
    if (!row) throw new AssetError(`Kıymet bulunamadı: ${code}`);
    const posted = new Set(row.runs.map((r) => r.year));
    return schedule({
      cost: num(row.cost),
      usefulLifeYears: row.usefulLifeYears,
      method: row.method as Method,
      acquiredAt: row.acquiredAt,
      prorated: row.prorated,
    }).map((r) => ({ ...r, posted: posted.has(r.year) }));
  }

  /**
   * Bir yılın amortismanını ayırır ve YEVMİYEYE YAZAR.
   *
   * TEK İŞLEM. Amortisman kaydı yazılıp yevmiye fişi yazılamazsa
   * bilanço ile amortisman tablosu birbirini tutmaz ve hangisinin
   * doğru olduğu anlaşılamaz.
   */
  async run(input: {
    year: number;
    userId: string;
    /** Yalnızca bu kıymet; boşsa aktif olan hepsi. */
    code?: string | null;
  }): Promise<{
    year: number;
    posted: readonly { code: string; name: string; amount: number }[];
    skipped: readonly { code: string; reason: string }[];
    total: number;
    documentNo: string | null;
  }> {
    const assets = await this.#db.fixedAsset.findMany({
      where: {
        status: "aktif",
        ...(input.code ? { code: input.code } : {}),
      },
      include: { runs: true },
      orderBy: { code: "asc" },
    });

    if (assets.length === 0) {
      throw new AssetError(
        input.code ? `Aktif kıymet bulunamadı: ${input.code}` : "Aktif sabit kıymet yok.",
      );
    }

    const posted: { code: string; name: string; amount: number }[] = [];
    const skipped: { code: string; reason: string }[] = [];
    const lines: {
      accountCode: string;
      debit: number;
      credit: number;
      description: string;
    }[] = [];
    const plans: { id: string; row: { year: number; amount: number; accumulated: number; bookValue: number; months: number } }[] = [];

    for (const a of assets) {
      // ZATEN AYRILMIŞSA ATLANIR, hata değildir: toplu koşu her yıl
      // çalıştırılır ve yeni eklenen kıymetler için tekrar çağrılır.
      if (a.runs.some((r) => r.year === input.year)) {
        skipped.push({ code: a.code, reason: `${input.year} için zaten ayrılmış` });
        continue;
      }

      let rows;
      try {
        rows = schedule({
          cost: num(a.cost),
          usefulLifeYears: a.usefulLifeYears,
          method: a.method as Method,
          acquiredAt: a.acquiredAt,
          prorated: a.prorated,
        });
      } catch (e) {
        skipped.push({
          code: a.code,
          reason: e instanceof DepreciationError ? e.message : "hesaplanamadı",
        });
        continue;
      }

      const row = rows.find((r) => r.year === input.year);
      if (!row) {
        skipped.push({
          code: a.code,
          reason:
            input.year < a.acquiredAt.getUTCFullYear()
              ? "iktisap tarihinden önce"
              : "amortisman süresi dolmuş",
        });
        continue;
      }

      // GEÇMİŞ YILLAR ATLANARAK AYRILAMAZ. 2026 ayrılmadan 2027
      // ayrılırsa birikmiş amortisman tablodakiyle tutmaz.
      const missing = rows
        .filter((r) => r.year < input.year && !a.runs.some((x) => x.year === r.year))
        .map((r) => r.year);
      if (missing.length > 0) {
        skipped.push({
          code: a.code,
          reason: `önce ${missing.join(", ")} yılları ayrılmalı`,
        });
        continue;
      }

      posted.push({ code: a.code, name: a.name, amount: row.amount });
      plans.push({ id: a.id, row });
      lines.push({
        accountCode: a.expenseAccount,
        debit: row.amount,
        credit: 0,
        description: `${a.code} ${a.name} amortismanı ${input.year}`,
      });
      lines.push({
        accountCode: a.depreciationAccount,
        debit: 0,
        credit: row.amount,
        description: `${a.code} birikmiş amortisman ${input.year}`,
      });
    }

    if (posted.length === 0) {
      return { year: input.year, posted: [], skipped, total: 0, documentNo: null };
    }

    const total = round2(posted.reduce((s, p) => s + p.amount, 0));

    return this.#db.$transaction(async (tx) => {
      const entry = await JournalRepository.postIn(tx, {
        // Amortisman YIL SONUNDA ayrılır (VUK); tarih 31 Aralık'tır.
        entryDate: new Date(Date.UTC(input.year, 11, 31)),
        description: `${input.year} yılı amortisman kaydı (${posted.length} kıymet)`,
        sourceKind: "manual",
        userId: input.userId,
        lines,
      });

      for (const p of plans) {
        await tx.depreciationRun.create({
          data: {
            assetId: p.id,
            year: p.row.year,
            amount: p.row.amount,
            accumulated: p.row.accumulated,
            bookValue: p.row.bookValue,
            months: p.row.months,
            journalDocumentNo: entry.documentNo,
            postedBy: input.userId,
          },
        });
        // Tam amorti olan kıymet durumunu değiştirir: bir daha
        // koşuya girmez ve listede ayrı görünür.
        if (p.row.bookValue <= 0.005) {
          await tx.fixedAsset.update({
            where: { id: p.id },
            data: { status: "tam_amorti" },
          });
        }
      }

      return { year: input.year, posted, skipped, total, documentNo: entry.documentNo };
    });
  }

  /**
   * Kıymeti elden çıkarır.
   *
   * ÜÇ KAYIT BİRDEN: kıymet hesabı kapanır, birikmiş amortisman
   * kapanır, aradaki fark ile satış bedeli arasındaki tutar kâr ya da
   * zarar yazılır. Yalnızca durum değiştirmek, bilançoda satılmış bir
   * makineyi durur hâlde bırakırdı.
   */
  async dispose(input: {
    code: string;
    disposedAt: Date;
    proceeds: number;
    userId: string;
    counterAccount: string;
  }): Promise<{ bookValue: number; gain: number; documentNo: string }> {
    const a = await this.#db.fixedAsset.findUnique({
      where: { code: input.code },
      include: { runs: true },
    });
    if (!a) throw new AssetError(`Kıymet bulunamadı: ${input.code}`);
    if (a.status === "elden_cikarildi") {
      throw new AssetError(`${input.code} zaten elden çıkarılmış.`);
    }
    if (input.proceeds < 0) throw new AssetError("Satış bedeli negatif olamaz.");

    const accumulated = a.runs.reduce((s, r) => s + num(r.amount), 0);
    const { bookValue, gain } = disposalResult(num(a.cost), accumulated, input.proceeds);

    const lines = [
      // Satış bedeli karşılığı (banka/kasa/alıcılar).
      ...(input.proceeds > 0
        ? [
            {
              accountCode: input.counterAccount,
              debit: input.proceeds,
              credit: 0,
              description: `${a.code} satış bedeli`,
            },
          ]
        : []),
      // Birikmiş amortisman kapanır (borç).
      ...(accumulated > 0
        ? [
            {
              accountCode: a.depreciationAccount,
              debit: round2(accumulated),
              credit: 0,
              description: `${a.code} birikmiş amortisman kapanış`,
            },
          ]
        : []),
      // Kıymet hesabı kapanır (alacak).
      {
        accountCode: a.assetAccount,
        debit: 0,
        credit: num(a.cost),
        description: `${a.code} ${a.name} çıkışı`,
      },
    ];

    // KÂR 600'E YAZILMAZ. Makine satmak ciro değildir; 649/659'a
    // yazılır. 600'e yazılsaydı ciro şişer, brüt kâr marjı bozulurdu.
    if (gain > 0) {
      lines.push({
        accountCode: "649",
        debit: 0,
        credit: gain,
        description: `${a.code} sabit kıymet satış kârı`,
      });
    } else if (gain < 0) {
      lines.push({
        accountCode: "659",
        debit: -gain,
        credit: 0,
        description: `${a.code} sabit kıymet satış zararı`,
      });
    }

    return this.#db.$transaction(async (tx) => {
      const entry = await JournalRepository.postIn(tx, {
        entryDate: input.disposedAt,
        description: `${a.code} ${a.name} elden çıkarma`,
        sourceKind: "manual",
        userId: input.userId,
        lines,
      });
      await tx.fixedAsset.update({
        where: { id: a.id },
        data: {
          status: "elden_cikarildi",
          disposedAt: input.disposedAt,
          disposalProceeds: input.proceeds,
        },
      });
      return { bookValue, gain, documentNo: entry.documentNo };
    });
  }
}
