/**
 * AI Usage Ledger — her çağrının token ve maliyet kaydı.
 *
 * Ürün Mantığı §16: kullanıcı başı premium AI hedefi ≈ 1 USD/ay,
 * alarm 1,5 USD, hard cap 2 USD. Bu dosya o kapıyı uygulanabilir kılar.
 */

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  PRICING,
} from "./model.js";

export interface UsageSample {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LedgerEntry extends UsageSample {
  readonly at: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly model: string;
  readonly costUsd: number;
}

export function costOf(model: string, u: UsageSample): number {
  const p = PRICING[model];
  if (!p) return 0;
  const inRate = p.input / 1_000_000;
  const outRate = p.output / 1_000_000;
  return (
    u.inputTokens * inRate +
    u.cacheReadTokens * inRate * CACHE_READ_MULTIPLIER +
    u.cacheWriteTokens * inRate * CACHE_WRITE_MULTIPLIER +
    u.outputTokens * outRate
  );
}

export interface UsageLedger {
  record(entry: LedgerEntry): Promise<void>;
  /** Bu ay bu kullanıcının harcadığı USD. */
  monthToDate(tenantId: string, userId: string): Promise<number>;
}

export class InMemoryLedger implements UsageLedger {
  readonly entries: LedgerEntry[] = [];
  async record(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
  }
  async monthToDate(tenantId: string, userId: string): Promise<number> {
    const prefix = new Date().toISOString().slice(0, 7);
    return this.entries
      .filter(
        (e) =>
          e.tenantId === tenantId && e.userId === userId && e.at.startsWith(prefix),
      )
      .reduce((sum, e) => sum + e.costUsd, 0);
  }
}

/**
 * Bütçe politikası — İKİ KADEMELİ.
 *
 * TEK KADEMELİ BİR TAVAN YA ÇOK ERKEN KAPATIR YA HİÇ KAPATMAZ. Önceki
 * hâlinde tavan yalnızca "lookup olmayan" işler için geçerliydi ve
 * sohbetin tamamı lookup olarak gittiği için TAVAN HİÇ DEVREYE GİRMİYORDU:
 * koruma vardı ama çalışmıyordu, üstelik kod okununca çalışıyor gibi
 * duruyordu.
 *
 *   softCapUsd — pahalı işler (strateji, taslak) durur, okuma sürer
 *   capUsd     — HER ŞEY durur; para gerçekten bitmiştir
 */
export interface BudgetPolicy {
  /** Uyarı eşiği (USD / kullanıcı / ay). */
  readonly warnUsd: number;
  /** Sert kapatma eşiği. */
  /** Pahalı işlerin durduğu eşik. Okuma bu eşikten sonra da sürer. */
  readonly softCapUsd: number;
  /** Mutlak tavan: aşıldığında hiçbir model çağrısı yapılmaz. */
  readonly capUsd: number;
}

/** Ortamdan okunan sayı; geçersizse varsayılan kullanılır. */
function envUsd(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Varsayılan bütçe — kullanıcı başına, aylık.
 *
 * Ortam değişkenleriyle ayarlanabilir: kredisi sınırlı bir kurulumda
 * tavanı düşürmek, kodu değiştirmeyi gerektirmemelidir.
 */
export const DEFAULT_BUDGET: BudgetPolicy = {
  warnUsd: envUsd("KAELON_AI_WARN_USD", 1.5),
  softCapUsd: envUsd("KAELON_AI_SOFT_CAP_USD", 2.0),
  capUsd: envUsd("KAELON_AI_CAP_USD", 5.0),
};

export class BudgetExceededError extends Error {
  readonly code = "budget_exceeded";
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(
      `Aylık AI bütçesi aşıldı (${spentUsd.toFixed(2)} / ${capUsd.toFixed(2)} USD). ` +
        `Operasyonel sorgular çalışmaya devam eder; premium analiz kapatıldı.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Kalıcı defter — kontrol düzlemindeki `ai_usage` tablosuna yazar.
 *
 * BELLEKTE TUTULAN BİR DEFTER BÜTÇEYİ KORUMAZ. Sunucu her yeniden
 * başladığında harcama sıfırlanır; geliştirme sırasında bu dakikada bir
 * olur ve tavan hiçbir zaman dolmaz. Tablo zaten vardı ama kimse
 * yazmıyordu — koruma görünüyor, çalışmıyordu.
 */
/**
 * Defterin ihtiyaç duyduğu asgari veritabanı yüzeyi.
 *
 * Prisma istemcisinin tamamını istemek yerine yalnızca kullanılan iki
 * metodu istemek, bu sınıfı test edilebilir ve şema değişikliklerine
 * dayanıklı kılar.
 */
export interface UsageDb {
  aiUsage: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    aggregate(args: never): Promise<{ _sum: { costUsd: unknown } }>;
  };
}

export class PostgresLedger implements UsageLedger {
  readonly #db: UsageDb;

  constructor(db: UsageDb) {
    this.#db = db;
  }

  async record(entry: LedgerEntry): Promise<void> {
    await this.#db.aiUsage.create({
      data: {
        tenantId: entry.tenantId,
        userId: entry.userId,
        correlationId: entry.correlationId,
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
        costUsd: entry.costUsd,
      },
    });
  }

  async monthToDate(tenantId: string, userId: string): Promise<number> {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const agg = await this.#db.aiUsage.aggregate({
      where: { tenantId, userId, createdAt: { gte: from } },
      _sum: { costUsd: true },
    } as never);
    return Number(agg._sum.costUsd ?? 0);
  }
}
