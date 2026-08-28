/**
 * Audit log — KAELON'un en kritik güvenlik özelliği.
 *
 * Kurallar (Mimari v1 §9.4):
 *  - Sadece INSERT. UPDATE ve DELETE yoktur, arayüzde bile tanımlı değildir.
 *  - Her tool çağrısı — başarılı ya da başarısız — kayda düşer.
 *  - Yetkisiz girişimler de düşer; reddedilen istek de bir olaydır.
 *
 * Yazma başarısızlığı politikası:
 *  - L1+ (yazan) tool'larda audit yazılamazsa işlem İPTAL edilir.
 *  - L0 (okuyan) tool'larda uyarı üretilir ama okuma engellenmez.
 * Gerekçe: iz bırakmayan bir değişiklik kabul edilemez; iz bırakmayan bir
 * okuma ise kullanıcıyı sistemsiz bırakmaktan iyidir.
 */

import type { AuthorityLevel, Channel, Principal } from "./types.js";

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly channel: Channel;
  readonly correlationId: string;
  readonly toolName: string;
  readonly authority: AuthorityLevel;
  readonly outcome: "success" | "denied" | "invalid" | "failed";
  /** Girdi — hassas alanlar maskelenmiş hâliyle. */
  readonly input: unknown;
  /** Çıktı özeti; ham veri değil, boyut ve kaynak bilgisi. */
  readonly resultSummary?: unknown;
  readonly errorCode?: string;
  readonly durationMs: number;
  /** Çağrı AI tarafından yapıldıysa hangi model ve hangi prompt sürümü. */
  readonly aiContext?: { model: string; promptVersion: string; toolUseId: string };
}

/** Append-only sink. Bilerek `update` ve `delete` yoktur. */
export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

/** Bellekte tutan sink — test ve geliştirme içindir. */
export class InMemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async append(entry: AuditEntry): Promise<void> {
    Object.freeze(entry);
    this.entries.push(entry);
  }
}

/** Girdideki hassas alanları audit'e yazmadan önce maskeler. */
const SENSITIVE_KEYS = /(password|secret|token|iban|tckn|tc_no|card|cvv)/i;

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[derinlik sınırı]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "[maskelendi]" : redactForAudit(v, depth + 1);
  }
  return out;
}

export function buildEntry(args: {
  id: string;
  principal: Principal;
  channel: Channel;
  correlationId: string;
  toolName: string;
  authority: AuthorityLevel;
  outcome: AuditEntry["outcome"];
  input: unknown;
  durationMs: number;
  at: Date;
  resultSummary?: unknown;
  errorCode?: string;
  aiContext?: AuditEntry["aiContext"];
}): AuditEntry {
  const base: AuditEntry = {
    id: args.id,
    at: args.at.toISOString(),
    tenantId: args.principal.tenantId,
    userId: args.principal.userId,
    roles: [...args.principal.roles],
    channel: args.channel,
    correlationId: args.correlationId,
    toolName: args.toolName,
    authority: args.authority,
    outcome: args.outcome,
    input: redactForAudit(args.input),
    durationMs: args.durationMs,
  };
  return {
    ...base,
    ...(args.resultSummary !== undefined ? { resultSummary: args.resultSummary } : {}),
    ...(args.errorCode !== undefined ? { errorCode: args.errorCode } : {}),
    ...(args.aiContext !== undefined ? { aiContext: args.aiContext } : {}),
  };
}
