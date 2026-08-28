/**
 * Tool invoker — yedi katmanın sırayla ve İSTİSNASIZ çalıştığı tek yer.
 *
 * UI, AI, mobil ve API bu fonksiyondan geçer. Başka bir giriş yoktur;
 * `tool.execute` doğrudan çağrılmaz. Bu disiplin sayesinde yetki kontrolü,
 * doğrulama ve audit kaydı atlanamaz.
 */

import type { z } from "zod";
import type { Channel, Principal, TenantContext, ToolContext, ToolOutcome } from "./types.js";
import type { Tool } from "./tool.js";
import type { ToolRegistry } from "./registry.js";
import type { AuditSink } from "./audit.js";
import { buildEntry } from "./audit.js";
import { assertAuthority } from "./authority.js";
import { missingPermissions } from "./rbac.js";
import {
  AuditWriteError,
  InputValidationError,
  KaelonError,
  PermissionDeniedError,
  TenantMismatchError,
  ToolExecutionError,
  UnknownToolError,
  isKaelonError,
} from "./errors.js";

export interface InvokeOptions {
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly aiContext?: { model: string; promptVersion: string; toolUseId: string };
}

export interface InvokeResult {
  readonly outcome: ToolOutcome<unknown>;
  readonly durationMs: number;
  readonly toolName: string;
}

/** Audit özeti — ham veri değil, boyut ve kaynak bilgisi. */
function summarize(outcome: ToolOutcome<unknown>): unknown {
  if (!outcome.ok) return { ok: false, code: outcome.code };
  const data = outcome.data;
  return {
    ok: true,
    shape: Array.isArray(data) ? `array(${data.length})` : typeof data,
    sources: outcome.sources.map((s) => s.system),
    riskCount: outcome.risks?.length ?? 0,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
  };
}

export async function invokeTool(
  toolName: string,
  rawInput: unknown,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => globalThis.crypto.randomUUID());
  const startedAt = now();
  const t0 = Date.now();

  const tool = opts.registry.get(toolName) as Tool<z.ZodType, unknown> | undefined;

  // Audit her yoldan yazılır; bu closure tek yazma noktasıdır.
  const write = async (
    outcome: Parameters<typeof buildEntry>[0]["outcome"],
    extra: { resultSummary?: unknown; errorCode?: string },
  ): Promise<void> => {
    const entry = buildEntry({
      id: newId(),
      principal: opts.principal,
      channel: opts.channel,
      correlationId: opts.correlationId,
      toolName,
      authority: tool?.authority ?? 0,
      outcome,
      input: rawInput,
      durationMs: Date.now() - t0,
      at: startedAt,
      ...extra,
      ...(opts.aiContext ? { aiContext: opts.aiContext } : {}),
    });
    try {
      await opts.audit.append(entry);
    } catch (cause) {
      // Yazan tool'da audit hatası işlemi düşürür; okuyanda geçilir.
      if ((tool?.authority ?? 0) > 0) throw new AuditWriteError(cause);
    }
  };

  const fail = async (e: KaelonError, kind: "denied" | "invalid" | "failed") => {
    await write(kind, { errorCode: e.code });
    return {
      outcome: { ok: false as const, code: e.code, message: e.message, userFacing: e.userFacing },
      durationMs: Date.now() - t0,
      toolName,
    };
  };

  // ── 1. Tool var mı?
  if (!tool) return fail(new UnknownToolError(toolName), "failed");

  // ── 2. Tenant izolasyonu
  if (opts.principal.tenantId !== opts.tenant.tenantId) {
    return fail(
      new TenantMismatchError(opts.tenant.tenantId, opts.principal.tenantId),
      "denied",
    );
  }

  // ── 3. Authorization: izin + yetki tavanı
  const missing = missingPermissions(opts.principal, tool.requires);
  if (missing.length > 0) {
    return fail(new PermissionDeniedError(toolName, missing), "denied");
  }
  try {
    assertAuthority(toolName, tool.authority, opts.principal);
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "denied");
    throw e;
  }

  // ── 4. Girdi şeması
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(kök)"}: ${i.message}`);
    return fail(new InputValidationError(toolName, issues), "invalid");
  }

  const ctx: ToolContext = {
    principal: opts.principal,
    tenant: opts.tenant,
    correlationId: opts.correlationId,
    channel: opts.channel,
    now,
  };

  // ── 5. İş kuralı doğrulaması
  try {
    await tool.validate?.(parsed.data, ctx);
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "denied");
    return fail(new ToolExecutionError(toolName, e), "failed");
  }

  // ── 6. Çalıştırma
  let outcome: ToolOutcome<unknown>;
  try {
    const ok = await tool.execute(parsed.data, ctx);
    const data = tool.redact ? tool.redact(ok.data, opts.principal) : ok.data;
    outcome = { ...ok, data };
  } catch (e) {
    if (isKaelonError(e)) return fail(e, "failed");
    return fail(new ToolExecutionError(toolName, e), "failed");
  }

  // ── 7. Audit + cevap
  await write("success", { resultSummary: summarize(outcome) });
  return { outcome, durationMs: Date.now() - t0, toolName };
}
