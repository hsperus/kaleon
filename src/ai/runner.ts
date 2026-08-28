/**
 * Ajan döngüsü.
 *
 * SDK'nın hazır tool runner'ı yerine elle döngü kullanıyoruz — çünkü her tool
 * çağrısının KAELON invoker'ından geçmesi gerekiyor: tenant izolasyonu, RBAC,
 * yetki tavanı, iş kuralı doğrulaması ve audit kaydı. Hazır runner bu bağlamı
 * bilmez ve `execute`'u doğrudan çağırırdı.
 *
 * Döngünün değişmezleri:
 *  - Paralel tool çağrılarının sonuçları TEK user mesajında döner. Bölünürse
 *    model paralel çağırmayı bırakır.
 *  - Modelin uydurduğu tool adı hata olarak geri döner, sessizce yutulmaz.
 *  - `pause_turn` sunucu tool'u sürerken gelir; asistan turu geri itilip devam
 *    edilir, yoksa cevap sessizce yarıda kalır.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Completer } from "./gateway.js";
import { MAX_TOOL_ITERATIONS, type TaskKind } from "./model.js";
import { PROMPT_VERSION, sessionContext } from "./system-prompt.js";
import { CONVERSATION_MODEL } from "./model.js";
import type { ToolRegistry } from "../kernel/registry.js";
import type { AuditSink } from "../kernel/audit.js";
import type { Channel, Principal, TenantContext } from "../kernel/types.js";
import { invokeTool } from "../kernel/invoke.js";

export interface RunRequest {
  readonly question: string;
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly task: TaskKind;
  readonly display: { name: string; roleLabel: string; companyName: string };
  readonly now?: () => Date;
}

export interface ToolCallRecord {
  readonly tool: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly durationMs: number;
}

export interface RunResult {
  readonly answer: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly iterations: number;
  readonly costUsd: number;
  readonly stopReason: string | null;
  readonly budgetWarning?: string;
  /** Model güvenlik nedeniyle reddettiyse true. */
  readonly refused: boolean;
}

export interface RunnerDeps {
  readonly gateway: Completer;
  readonly registry: ToolRegistry;
  readonly audit: AuditSink;
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function runConversation(
  deps: RunnerDeps,
  req: RunRequest,
): Promise<RunResult> {
  const now = req.now ?? (() => new Date());
  const catalog = deps.registry.catalogFor(req.principal);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: req.question },
    {
      // Konuşma ortası sistem mesajı: önbelleklenmiş öneki bozmadan oturum
      // bağlamını taşır ve prompt injection'a kapalı operatör kanalıdır.
      role: "system",
      content: sessionContext({
        displayName: req.display.name,
        roleLabel: req.display.roleLabel,
        companyName: req.display.companyName,
        localDate: now().toLocaleDateString("tr-TR"),
        visibleTools: catalog.names,
      }),
    },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let costUsd = 0;
  let budgetWarning: string | undefined;
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const { message, costUsd: turnCost, budgetWarning: warn } = await deps.gateway.complete({
      messages,
      tools: catalog.all,
      task: req.task,
      tenantId: req.tenant.tenantId,
      userId: req.principal.userId,
      correlationId: req.correlationId,
    });
    costUsd += turnCost;
    if (warn) budgetWarning = warn;

    if (message.stop_reason === "refusal") {
      return {
        answer:
          "Bu isteği güvenlik nedeniyle işleyemiyorum. Soruyu farklı biçimde sorabilir " +
          "veya yetkili bir kullanıcıdan destek isteyebilirsiniz.",
        toolCalls,
        iterations,
        costUsd,
        stopReason: message.stop_reason,
        refused: true,
        ...(budgetWarning ? { budgetWarning } : {}),
      };
    }

    // Sunucu tool'u (tool arama) sürüyor — asistan turunu geri it ve devam et.
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      return {
        answer: textOf(message),
        toolCalls,
        iterations,
        costUsd,
        stopReason: message.stop_reason,
        refused: false,
        ...(budgetWarning ? { budgetWarning } : {}),
      };
    }

    messages.push({ role: "assistant", content: message.content });

    // Paralel tool kullanımı varsayılan olarak açık — hepsini eşzamanlı çalıştır.
    const results = await Promise.all(
      toolUses.map(async (use) => {
        const invoked = await invokeTool(use.name, use.input, {
          registry: deps.registry,
          audit: deps.audit,
          principal: req.principal,
          tenant: req.tenant,
          correlationId: req.correlationId,
          channel: req.channel,
          now,
          aiContext: {
            model: CONVERSATION_MODEL,
            promptVersion: PROMPT_VERSION,
            toolUseId: use.id,
          },
        });
        toolCalls.push({
          tool: use.name,
          ok: invoked.outcome.ok,
          durationMs: invoked.durationMs,
          ...(invoked.outcome.ok ? {} : { code: invoked.outcome.code }),
        });
        const block: Anthropic.Beta.BetaToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(invoked.outcome),
          ...(invoked.outcome.ok ? {} : { is_error: true }),
        };
        return block;
      }),
    );

    // KRİTİK: tüm tool_result blokları TEK user mesajında dönmeli.
    messages.push({ role: "user", content: results });
  }

  return {
    answer:
      "Bu soruyu verilen adım sınırı içinde tamamlayamadım. Soruyu daraltıp tekrar sorabilirsiniz.",
    toolCalls,
    iterations,
    costUsd,
    stopReason: "max_iterations",
    refused: false,
    ...(budgetWarning ? { budgetWarning } : {}),
  };
}
