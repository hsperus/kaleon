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

export interface BudgetPolicy {
  /** Uyarı eşiği (USD / kullanıcı / ay). */
  readonly warnUsd: number;
  /** Sert kapatma eşiği. */
  readonly capUsd: number;
}

export const DEFAULT_BUDGET: BudgetPolicy = { warnUsd: 1.5, capUsd: 2.0 };

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
