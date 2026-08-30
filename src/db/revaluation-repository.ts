/**
 * Kur değerlemesi — kalıcılık katmanı.
 *
 * İKİ İŞ YAPAR: açık dövizli bakiyeleri bulur, ve onaylanan değerlemeyi
 * fiş olarak yazar.
 *
 * BAKİYE SORGUSU NEDEN HAM SQL: hesap + cari + para birimi kırılımında
 * toplam istiyoruz ve Prisma'nın `groupBy`'ı üç alanlı gruplamada
 * `having` ile birlikte kullanılamıyor. Kırılımı bellekte yapmak da
 * seçenek değil — yüz bin satırlık bir defteri belleğe almak, ay sonu
 * kapanışında sunucuyu düşürür.
 *
 * SIFIRA KAPANMIŞ BAKİYELER SORGUDA ELENİR, sonradan değil. Ödenmiş
 * yüzlerce fatura kur riski taşımaz ve listeyi okunmaz yapar.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { JournalRepository } from "./journal-repository.js";
import type { OpenFxBalance, Revaluation } from "../modules/finance/revaluation.js";
import { revaluationEntry } from "../modules/finance/revaluation.js";

/**
 * Kur riski taşıyan hesaplar.
 *
 * NEDEN LİSTE, NEDEN "DÖVİZLİ OLAN HER HESAP" DEĞİL: gelir ve gider
 * hesapları (600, 770) değerlenmez — onlar bir tarihte gerçekleşmiş
 * olaylardır ve geçmişe dönük değişmezler. Değerlenen şey AÇIK
 * POZİSYONDUR: alacak, borç, kasa, banka.
 */
const RISKLI_HESAPLAR = [
  "100", // Kasa
  "102", // Bankalar
  "120", // Alıcılar
  "121", // Alacak senetleri
  "320", // Satıcılar
  "321", // Borç senetleri
] as const;

export class RevaluationRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /**
   * Verilen tarihe kadarki açık dövizli bakiyeler.
   *
   * TERS KAYITLI FİŞLER SAYILMAZ. İptal edilmiş bir fatura kur riski
   * taşımaz; sayılsaydı iptal edilen her belge dönem sonunda yeniden
   * canlanırdı.
   */
  async openBalances(asOf: Date): Promise<readonly OpenFxBalance[]> {
    const rows = await this.#db.$queryRaw<
      {
        account_code: string;
        partner_id: string | null;
        currency: string;
        fx_balance: Prisma.Decimal;
        book_balance: Prisma.Decimal;
      }[]
    >`
      SELECT l.account_code,
             l.partner_id,
             l.currency,
             SUM(l.fx_debit - l.fx_credit) AS fx_balance,
             SUM(l.debit    - l.credit)    AS book_balance
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.currency <> 'TRY'
         AND e.entry_date <= ${asOf}
         AND e.status = 'posted'
         AND l.account_code = ANY(${[...RISKLI_HESAPLAR]}::text[])
       GROUP BY l.account_code, l.partner_id, l.currency
      HAVING SUM(l.fx_debit - l.fx_credit) <> 0
       ORDER BY l.account_code, l.currency
    `;

    // Cari adları ayrı okunur: SQL'e join eklemek sorguyu tenant
    // şemasındaki tablo adına bağlar ve okunurluğu düşürür.
    const ids = [...new Set(rows.map((r) => r.partner_id).filter((v): v is string => v !== null))];
    const partners = ids.length
      ? await this.#db.partner.findMany({ where: { id: { in: ids } }, select: { id: true, legalName: true } })
      : [];
    const nameById = new Map(partners.map((p) => [p.id, p.legalName]));

    return rows.map((r) => ({
      accountCode: r.account_code,
      partnerId: r.partner_id,
      partnerName: r.partner_id ? (nameById.get(r.partner_id) ?? null) : null,
      currency: r.currency,
      fxBalance: Number(r.fx_balance),
      bookBalance: Number(r.book_balance),
    }));
  }

  /** Değerlemeye giren para birimleri — kurları bunlar için aranır. */
  static currenciesOf(balances: readonly OpenFxBalance[]): readonly string[] {
    return [...new Set(balances.filter((b) => b.currency !== "TRY").map((b) => b.currency))].sort();
  }

  /**
   * Değerlemeyi fiş olarak yazar ve koşuyu kaydeder.
   *
   * TEK İŞLEMDE: fiş yazılıp koşu kaydı yazılmazsa, aynı döneme ikinci
   * kez değerleme yapılabilir ve kambiyo kârı iki katına çıkar. Koşu
   * yazılıp fiş yazılmazsa dönem değerlenmiş sanılır ama defter boştur.
   */
  async post(r: Revaluation, userId: string): Promise<{ documentNo: string; entryId: string }> {
    const lines = revaluationEntry(r);
    if (lines.length === 0) {
      throw new Error(
        `${r.asOf} tarihinde değerlenecek fark yok. Kurlar defterdeki ` +
          `kurlarla aynı; yazılacak bir fiş oluşmadı.`,
      );
    }

    const asOfDate = new Date(`${r.asOf}T00:00:00.000Z`);

    return this.#db.$transaction(async (tx) => {
      const entry = await JournalRepository.postIn(tx, {
        entryDate: asOfDate,
        description: `Dönem sonu kur değerlemesi — ${r.asOf}`,
        sourceKind: "fx_revaluation",
        sourceId: r.asOf,
        lines: lines.map((l) => ({
          accountCode: l.accountCode,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          partnerId: l.partnerId,
        })),
        userId,
      });

      await tx.fxRevaluation.create({
        data: {
          asOf: asOfDate,
          entryId: entry.id,
          difference: new Prisma.Decimal(r.difference),
          lineCount: r.lines.length,
          rates: r.rates as Prisma.InputJsonValue,
          createdBy: userId,
        },
      });

      return { documentNo: entry.documentNo, entryId: entry.id };
    });
  }

  /** Bu tarih zaten değerlendi mi? */
  async existing(asOf: Date): Promise<{ asOf: string; difference: number } | null> {
    const row = await this.#db.fxRevaluation.findFirst({
      where: { asOf, entryId: { not: null } },
    });
    if (!row) return null;
    return { asOf: row.asOf.toISOString().slice(0, 10), difference: Number(row.difference) };
  }
}
