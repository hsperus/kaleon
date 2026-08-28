/**
 * Model ve effort politikası.
 *
 * KAELON tek konuşma modeli kullanır: Claude Opus 5. Model kademesi yerine
 * `effort` kademesi vardır — aynı model, aynı önbellek alanı, farklı derinlik.
 * Model kademesi önbelleği bölerdi (önbellekler modele özeldir) ve prompt
 * kütüphanesini/eval matrisini modeller kadar katlardı.
 *
 * Tek istisna: gece belge hattı (fatura okuma) Haiku 4.5 + Batch API ile
 * çalışır. O hat ayrı bir önbellek alanıdır, konuşma önbelleğini bölmez.
 */

export const CONVERSATION_MODEL = "claude-opus-5" as const;
export const BATCH_EXTRACTION_MODEL = "claude-haiku-4-5" as const;

export type TaskKind =
  /** Tek metrik okuma, basit varlık sorgusu. */
  | "lookup"
  /** Çok kaynaklı özet, kırılım, karşılaştırma. */
  | "analysis"
  /** Boss Mode strateji, kök neden, senaryo. */
  | "strategy"
  /** Taslak üretimi (KDV, işten çıkış, ödeme planı). */
  | "draft";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Görev tipi → effort. Maliyetin ana kadranı budur.
 * Ölçmeden değiştirmeyin: golden set üzerinde doğruluk/maliyet ölçülür.
 */
export const EFFORT_POLICY: Record<TaskKind, Effort> = {
  lookup: "low",
  analysis: "medium",
  strategy: "high",
  draft: "high",
};

export const MAX_TOKENS: Record<TaskKind, number> = {
  lookup: 2_000,
  analysis: 4_000,
  strategy: 8_000,
  draft: 8_000,
};

/** Ajan döngüsünün tek konuşmada atabileceği en fazla tur. */
export const MAX_TOOL_ITERATIONS = 8;

/** USD / 1M token. Maliyet defterinin referansı. */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Önbellek çarpanları: okuma ~0,1× girdi, yazma 1,25× girdi (5 dk TTL). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
