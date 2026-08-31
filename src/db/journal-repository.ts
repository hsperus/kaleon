/**
 * Yevmiye deposu.
 *
 * FİŞ BELGEYLE AYNI İŞLEMDE OLUŞUR. Ayrı bir işlemde ya da sonradan
 * toplu olarak oluşsaydı, aradaki bir çökme faturayı muhasebesiz
 * bırakırdı: operasyonda satış var, mizanda yok. İki gerçeğin arasındaki
 * fark ay sonunda mali müşavirin sorusuyla ortaya çıkar ve kimse
 * hangisinin doğru olduğunu söyleyemez.
 *
 * AYNI BELGE İKİ KEZ MUHASEBELEŞMEZ. `(sourceKind, sourceId)` benzersizdir
 * ve bu kısıt veritabanındadır; uygulama kontrolü yarışa açıktır.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import { assertPeriodOpen } from "./period-repository.js";
import {
  balance,
  balanceSheet as buildBalanceSheet,
  incomeSummary,
  reverseLines,
  trialBalance,
  JournalError,
  type DraftLine,
  type JournalSource,
} from "../modules/accounting/journal.js";
import { account } from "../modules/accounting/accounts.js";
import { buildCashFlowStatement } from "../modules/accounting/cash-flow-statement.js";
import { buildKebirXml, buildYevmiyeXml } from "../modules/accounting/edefter.js";

type Tx = Prisma.TransactionClient;

export interface PostInput {
  readonly entryDate: Date;
  readonly description: string;
  readonly sourceKind: JournalSource;
  readonly sourceId?: string | null;
  readonly lines: readonly DraftLine[];
  readonly userId: string;
}

export class JournalRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Fişi çağıranın işlemi İÇİNDE yazar.
   *
   * `tx` alması zorunlu: belge ve fiş aynı işlemde olmazsa, biri yazılıp
   * diğeri yazılmayabilir.
   */
  static async postIn(tx: Tx, input: PostInput): Promise<{ documentNo: string; id: string }> {
    const balanced = balance(input.lines);
    await assertPeriodOpen(tx, input.entryDate, "Yevmiye fişi");

    const documentNo = await nextDocumentNo(tx, "journal", input.entryDate.getUTCFullYear());

    try {
      const entry = await tx.journalEntry.create({
        data: {
          documentNo,
          entryDate: input.entryDate,
          description: input.description,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId ?? null,
          status: "posted",
          totalDebit: new Prisma.Decimal(balanced.totalDebit),
          totalCredit: new Prisma.Decimal(balanced.totalCredit),
          createdBy: input.userId,
          lines: {
            create: balanced.lines.map((l) => ({
              lineNo: l.lineNo,
              accountCode: l.accountCode,
              debit: new Prisma.Decimal(l.debit),
              credit: new Prisma.Decimal(l.credit),
              description: l.description,
              partnerId: l.partnerId ?? null,
              costCenterCode: l.costCenterCode ?? null,
              // Döviz tarafı `balance` içinde `settleFx` tarafından
              // tamamlanır ve doğrulanır; burada varsayılan yok —
              // varsayılan olsaydı doğrulama atlanabilirdi.
              currency: l.currency,
              fxDebit: new Prisma.Decimal(l.fxDebit),
              fxCredit: new Prisma.Decimal(l.fxCredit),
              fxRate: new Prisma.Decimal(l.fxRate),
            })),
          },
        },
      });
      return { documentNo, id: entry.id };
    } catch (e) {
      // HANGİ KISIT ÇAKIŞTI, ONU SÖYLE. Her benzersizlik hatasını "zaten
      // muhasebeleşmiş" diye çevirmek, belge numarası çakışmasında
      // operatörü tamamen yanlış yere yönlendirir: var olmayan bir fişi
      // arar ve asıl sorun olan bozuk sayacı hiç görmez.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
        if (target.includes("source")) {
          throw new JournalError(
            `${input.sourceKind}/${input.sourceId} belgesi zaten muhasebeleşmiş; ` +
              `ikinci fiş oluşturulamaz. İkinci kez yazılsaydı ciro iki katına çıkardı.`,
          );
        }
        if (target.includes("document_no")) {
          throw new JournalError(
            `${documentNo} numarası zaten kullanılmış. Yevmiye sayacı ile mevcut ` +
              `fişler tutarsız; sayaç son fiş numarasının gerisinde kalmış olabilir.`,
          );
        }
        throw new JournalError(`Yevmiye fişi yazılamadı: benzersizlik çakışması (${target}).`);
      }
      throw e;
    }
  }

  /** Kendi işlemini açar — elle fiş girişi ve tekil kullanımlar için. */
  async post(input: PostInput): Promise<{ documentNo: string; id: string }> {
    return this.#db.$transaction((tx) => JournalRepository.postIn(tx, input));
  }

  /**
   * Ters kayıt.
   *
   * FİŞ SİLİNMEZ, TERSİ YAZILIR ve ikisi birbirine bağlanır. Silinseydi
   * "o gün ne oldu" sorusunun cevabı yok olurdu; ters kayıt hem bakiyeyi
   * düzeltir hem olayın olduğunu ve geri alındığını saklar.
   */
  async reverse(
    documentNo: string,
    userId: string,
    reason: string,
    on: Date,
  ): Promise<{ documentNo: string }> {
    if (reason.trim().length < 5) {
      throw new JournalError("Ters kayıt gerekçesi yazılmalıdır.");
    }

    return this.#db.$transaction(async (tx) => {
      const original = await tx.journalEntry.findUnique({
        where: { documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!original) throw new JournalError(`Fiş bulunamadı: ${documentNo}`);
      if (original.status !== "posted") {
        throw new JournalError(`${documentNo} ${original.status} durumunda; ters kaydı atılamaz.`);
      }

      const lines = reverseLines(
        original.lines.map((l) => ({
          accountCode: l.accountCode,
          debit: Number(l.debit),
          credit: Number(l.credit),
          description: l.description,
          partnerId: l.partnerId,
        })),
      );

      const rev = await JournalRepository.postIn(tx, {
        entryDate: on,
        description: `${documentNo} iptali — ${reason}`,
        sourceKind: "manual",
        // Ters fişin kaynağı yoktur: kaynak alanı doldurulsaydı, aynı
        // belgeden ikinci fiş kısıtına takılırdı.
        sourceId: null,
        lines,
        userId,
      });

      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: "reversed", reversedBy: rev.id },
      });
      await tx.journalEntry.update({
        where: { id: rev.id },
        data: { reversalOf: original.id },
      });

      return { documentNo: rev.documentNo };
    });
  }

  /**
   * Mizan.
   *
   * TERS KAYITLI FİŞLER DE TOPLAMA GİRER: hem asıl fiş hem tersi
   * sayılır ve birbirini götürür. Asıl fiş dışarıda bırakılsaydı, ters
   * kaydı tek başına kalır ve mizan bozulurdu.
   */
  async trialBalance(from: Date, to: Date) {
    const rows = await this.#db.journalLine.groupBy({
      by: ["accountCode"],
      where: { entry: { entryDate: { gte: from, lte: to }, status: { not: "draft" } } },
      _sum: { debit: true, credit: true },
    });

    return trialBalance(
      rows.map((r) => ({
        accountCode: r.accountCode,
        debit: Number(r._sum.debit ?? 0),
        credit: Number(r._sum.credit ?? 0),
      })),
    );
  }

  /**
   * Bilanço — belirli bir TARİH İTİBARIYLA.
   *
   * DÖNEM ARALIĞI DEĞİL, BİRİKİMLİ. Bilanço "şu an neye sahibiz"
   * sorusunun cevabıdır; sadece bu ayın hareketleriyle kurulursa
   * geçmiş yılların sermayesi ve stoğu yok görünür. Bu yüzden
   * başlangıçtan `asOf` tarihine kadar HER ŞEY toplanır.
   *
   * Dönem sonucu ise MALİ YIL BAŞINDAN itibaren hesaplanır: gelir
   * tablosu hesapları yıl sonunda kapanır ve birikimli okunmaları
   * geçmiş yılların kârını bu yıla eklerdi.
   */
  async balanceSheet(asOf: Date) {
    const yearStart = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
    // 1970 öncesi kayıt olmaz; "başlangıç" için güvenli alt sınır.
    const dawn = new Date(Date.UTC(1900, 0, 1));

    /*
     * ÜÇ SORGU, ÜÇÜ DE GEREKLİ.
     *
     * `cumulative` bilanço hesaplarının o güne kadarki bakiyesi.
     * `thisYear` cari dönem sonucu. `prior` ise CARİ YILDAN ÖNCEKİ
     * tüm dönemlerin toplam sonucu — bu üçüncüsü eksikti ve bilanço,
     * geçmiş yılların sonucu kadar açık veriyordu.
     */
    const dayBeforeYear = new Date(yearStart.getTime() - 86_400_000);
    const [cumulative, thisYear, prior] = await Promise.all([
      this.trialBalance(dawn, asOf),
      this.trialBalance(yearStart, asOf),
      this.trialBalance(dawn, dayBeforeYear),
    ]);

    const result = incomeSummary(thisYear.rows);
    const priorResult = incomeSummary(prior.rows);
    return {
      sheet: buildBalanceSheet(cumulative.rows, result.netProfit, priorResult.netProfit),
      periodFrom: yearStart.toISOString().slice(0, 10),
      trialBalanced: cumulative.balanced,
    };
  }

  async income(from: Date, to: Date) {
    const tb = await this.trialBalance(from, to);
    return { ...incomeSummary(tb.rows), balanced: tb.balanced };
  }

  /**
   * Nakit akış tablosu — DOLAYLI YÖNTEM.
   *
   * ÜÇ SORGU: dönem başı birikimli bakiyeler, dönem sonu birikimli
   * bakiyeler, ve dönemin kâr/zararı. Bakiyeler BİRİKİMLİ olmak
   * zorunda — sadece dönem hareketleriyle kurulan bir "değişim",
   * geçmişten devreden stoğu ve alacağı yok sayar.
   *
   * HAM `debit - credit` KULLANILIYOR, `balance` DEĞİL.
   *
   * `trialBalance` satırındaki `balance`, hesabın KENDİ normal
   * yönüne göre işaretli: bir satıcı borcu alacak bakiyeliyken
   * POZİTİF döner. Nakit akış tablosu ise tek bir işaret dünyası
   * ister (borç +, alacak −); aksi hâlde "borç arttı mı azaldı mı"
   * sorusu hesap türüne göre farklı yanıt verir ve işaret hatası
   * tabloyu denk ama YANLIŞ yapar.
   */
  async cashFlowStatement(from: Date, to: Date) {
    const dawn = new Date(Date.UTC(1900, 0, 1));
    const dayBefore = new Date(from.getTime() - 86_400_000);

    const [acilis, kapanis, sonuc] = await Promise.all([
      this.trialBalance(dawn, dayBefore),
      this.trialBalance(dawn, to),
      this.income(from, to),
    ]);

    const harita = (rows: readonly { accountCode: string; debit: number; credit: number }[]) =>
      new Map(rows.map((r) => [r.accountCode, Math.round((r.debit - r.credit) * 100) / 100]));

    return {
      statement: buildCashFlowStatement(
        from,
        to,
        sonuc.netProfit,
        harita(acilis.rows),
        harita(kapanis.rows),
      ),
      netProfit: sonuc.netProfit,
      trialBalanced: kapanis.balanced,
    };
  }

  /**
   * Cari hesap ekstresi.
   *
   * BAKİYE SATIR SATIR YÜRÜTÜLÜR. Yalnızca son bakiye verilseydi,
   * "bu rakam nereden geldi" sorusunun cevabı olmazdı; mutabakat tam
   * olarak bu yürüyen bakiyeyi karşılaştırmaktır.
   */
  async partnerStatement(partnerId: string, from: Date, to: Date) {
    const [opening, rows] = await Promise.all([
      this.#db.journalLine.aggregate({
        where: {
          partnerId,
          entry: { entryDate: { lt: from }, status: { not: "draft" } },
        },
        _sum: { debit: true, credit: true },
      }),
      this.#db.journalLine.findMany({
        where: {
          partnerId,
          entry: { entryDate: { gte: from, lte: to }, status: { not: "draft" } },
        },
        include: { entry: { select: { documentNo: true, entryDate: true, description: true } } },
        orderBy: [{ entry: { entryDate: "asc" } }, { lineNo: "asc" }],
        take: 500,
      }),
    ]);

    let running =
      Number(opening._sum.debit ?? 0) - Number(opening._sum.credit ?? 0);
    const openingBalance = Math.round(running * 100) / 100;

    const movements = rows.map((r) => {
      running += Number(r.debit) - Number(r.credit);
      return {
        date: r.entry.entryDate.toISOString().slice(0, 10),
        documentNo: r.entry.documentNo,
        description: r.description,
        accountCode: r.accountCode,
        debit: Number(r.debit),
        credit: Number(r.credit),
        balance: Math.round(running * 100) / 100,
      };
    });

    // CARİNİN ADI EKSTRENİN PARÇASIDIR. Mutabakat mektubu karşı tarafa
    // gider; üzerinde yalnızca bir kimlik numarası olan bir kâğıt,
    // kimin hesabı olduğunu söylemez.
    const partner = await this.#db.partner
      .findUnique({
        where: { id: partnerId },
        select: { legalName: true, code: true, addressLine: true, district: true, city: true, taxOffice: true },
      })
      .catch(() => null);

    return {
      partnerId,
      partnerName: partner?.legalName ?? partnerId,
      partnerCode: partner?.code ?? null,
      partnerAddress: partner
        ? [partner.addressLine, [partner.district, partner.city].filter(Boolean).join(" / ")]
            .filter(Boolean)
            .join("\n")
        : null,
      partnerTaxOffice: partner?.taxOffice ?? null,
      openingBalance,
      movements,
      closingBalance: Math.round(running * 100) / 100,
    };
  }

  /**
   * Alacak yaşlandırması — vadesi geçen alacaklar.
   *
   * TEK BİR "TOPLAM ALACAK" RAKAMI KARAR VERDİRMEZ. 4.000.000 TL alacağın
   * ne kadarı 90 günü geçmiş sorusu, tahsilat riskinin kendisidir.
   */
  async receivablesAging(on: Date, accountCode = "120") {
    account(accountCode);
    const rows = await this.#db.journalLine.findMany({
      where: { accountCode, entry: { status: { not: "draft" } } },
      include: { entry: { select: { entryDate: true } } },
      take: 5000,
    });

    const byPartner = new Map<
      string,
      { balance: number; buckets: [number, number, number, number] }
    >();

    for (const r of rows) {
      if (!r.partnerId) continue;
      const cur = byPartner.get(r.partnerId) ?? {
        balance: 0,
        buckets: [0, 0, 0, 0] as [number, number, number, number],
      };
      const net = Number(r.debit) - Number(r.credit);
      cur.balance += net;

      // Yalnızca BORÇ satırları yaşlandırılır: alacak satırı bir tahsilattır
      // ve tahsilatın yaşı yoktur.
      if (net > 0) {
        const days = Math.floor(
          (on.getTime() - r.entry.entryDate.getTime()) / 86_400_000,
        );
        const idx = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
        cur.buckets[idx] += net;
      }
      byPartner.set(r.partnerId, cur);
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return [...byPartner.entries()]
      .filter(([, v]) => Math.abs(v.balance) > 0.005)
      .map(([partnerId, v]) => ({
        partnerId,
        balance: round(v.balance),
        current: round(v.buckets[0]),
        days31to60: round(v.buckets[1]),
        days61to90: round(v.buckets[2]),
        over90: round(v.buckets[3]),
      }))
      .sort((a, b) => b.over90 - a.over90 || b.balance - a.balance);
  }

  /**
   * Defter başlığında görünecek şirket kimliği.
   *
   * e-Defter mükellef adına düzenlenir; unvan ve VKN olmadan dosya
   * kimliksizdir ve GİB tarafından reddedilir.
   */
  async companyForDefter(): Promise<{ legalName: string; taxId: string }> {
    const row = await this.#db.companyProfile.findUnique({ where: { id: "singleton" } });
    if (!row) {
      throw new JournalError(
        "Şirket kimliği tanımlı değil. e-Defter mükellef adına düzenlenir; unvan ve " +
          "vergi numarası olmadan dosya kimliksiz kalır ve GİB reddeder.",
      );
    }
    return { legalName: row.legalName, taxId: row.taxId };
  }

  /**
   * Bir dönemin e-Defter (XBRL-GL) yevmiye ve kebir dosyaları.
   *
   * DÖNEM KAPALI OLMALIDIR. Açık bir aydan defter üretmek, yarın
   * değişebilecek bir beyanı imzalamaktır; GİB'e yüklenen berat geri
   * alınamaz.
   */
  async buildEDefter(
    year: number,
    month: number,
    company: { legalName: string; taxId: string },
  ): Promise<{ yevmiye: string; kebir: string; entryCount: number }> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    const rows = await this.#db.journalEntry.findMany({
      where: { entryDate: { gte: from, lte: to }, status: { not: "draft" } },
      include: { lines: { orderBy: { lineNo: "asc" } } },
      orderBy: [{ entryDate: "asc" }, { documentNo: "asc" }],
      take: 20_000,
    });

    const entries = rows.map((r) => ({
      documentNo: r.documentNo,
      entryDate: r.entryDate,
      description: r.description,
      lines: r.lines.map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description,
      })),
    }));

    const tb = await this.trialBalance(from, to);

    return {
      yevmiye: buildYevmiyeXml({ company, period: { year, month }, entries }),
      kebir: buildKebirXml({
        company,
        period: { year, month },
        totals: tb.rows.map((r) => ({
          accountCode: r.accountCode,
          debit: r.debit,
          credit: r.credit,
        })),
      }),
      entryCount: entries.length,
    };
  }

  /**
   * KDV beyannamesi taslağı için hesap toplamları.
   *
   * Önceki dönemin devreden KDV'si de hesaplanır: devir kaybolursa
   * mükellef kendi parasını devlete bırakmış olur.
   */
  async vatFigures(year: number, month: number) {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    const tb = await this.trialBalance(from, to);
    const of = (code: string, side: "debit" | "credit") =>
      tb.rows.find((r) => r.accountCode === code)?.[side] ?? 0;

    // Devreden KDV: dönem başına kadarki tüm 191/391 farkı.
    const before = new Date(Date.UTC(year, month - 1, 1) - 1);
    const prior = await this.trialBalance(new Date(Date.UTC(2000, 0, 1)), before);
    const priorOut = prior.rows.find((r) => r.accountCode === "391")?.credit ?? 0;
    const priorIn = prior.rows.find((r) => r.accountCode === "191")?.debit ?? 0;
    const carriedForward = Math.max(0, Math.round((priorIn - priorOut) * 100) / 100);

    return {
      year,
      month,
      salesBase: of("600", "credit") + of("601", "credit"),
      outputVat: of("391", "credit"),
      inputVat: of("191", "debit"),
      carriedForward,
      ledgerBalanced: tb.balanced,
    };
  }

  /** Bir belgeden doğan fiş — "bu fatura nasıl muhasebeleşti". */
  async entryFor(sourceKind: JournalSource, sourceId: string) {
    const row = await this.#db.journalEntry.findFirst({
      where: { sourceKind, sourceId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!row) return null;
    return {
      documentNo: row.documentNo,
      entryDate: row.entryDate.toISOString().slice(0, 10),
      description: row.description,
      status: row.status,
      totalDebit: Number(row.totalDebit),
      lines: row.lines.map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        accountName: account(l.accountCode).name,
        debit: Number(l.debit),
        credit: Number(l.credit),
        description: l.description,
        partnerId: l.partnerId,
      })),
    };
  }
}
