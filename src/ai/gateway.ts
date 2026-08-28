/**
 * LLM Gateway — tüm model çağrılarının geçtiği tek kapı.
 *
 * Hiçbir modül doğrudan Anthropic SDK'sını çağırmaz (Mimari v1 §7.1).
 * Gateway şunları merkezîleştirir: model seçimi, effort politikası,
 * prompt önbelleği, maliyet defteri, bütçe kapısı, tipli hata yönetimi
 * ve red (refusal) durumunda sunucu tarafı yedekleme.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicToolSchema } from "../kernel/tool.js";
import {
  CONVERSATION_MODEL,
  EFFORT_POLICY,
  MAX_TOKENS,
  type TaskKind,
} from "./model.js";
import {
  BudgetExceededError,
  costOf,
  DEFAULT_BUDGET,
  type BudgetPolicy,
  type UsageLedger,
  type UsageSample,
} from "./ledger.js";

/** Tool arama sunucu tool'u — defer_loading'in çalışması için gerekli. */
const TOOL_SEARCH = {
  type: "tool_search_tool_regex_20251119",
  name: "tool_search_tool_regex",
} as const;

/** Red (refusal) hâlinde sunucu tarafı yedek modele düşürür. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface GatewayDeps {
  readonly client: Anthropic;
  readonly ledger: UsageLedger;
  readonly budget?: BudgetPolicy;
  readonly systemPrompt: string;
}

export interface CompleteRequest {
  readonly messages: Anthropic.Beta.BetaMessageParam[];
  readonly tools: readonly AnthropicToolSchema[];
  readonly task: TaskKind;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
}

export interface CompleteResult {
  readonly message: Anthropic.Beta.BetaMessage;
  readonly usage: UsageSample;
  readonly costUsd: number;
  /** Bütçe uyarı eşiği aşıldıysa dolu gelir. */
  readonly budgetWarning?: string;
}

/**
 * Gateway sözleşmesi. Runner somut sınıfa değil buna bağlıdır —
 * ajan döngüsü model çağrısı yapmadan test edilebilsin diye.
 */
export interface Completer {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export class LlmGateway implements Completer {
  readonly #deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const budget = this.#deps.budget ?? DEFAULT_BUDGET;
    const spent = await this.#deps.ledger.monthToDate(req.tenantId, req.userId);

    // Bütçe kapısı: strateji/taslak gibi premium işler kapanır, okuma sürer.
    if (spent >= budget.capUsd && req.task !== "lookup") {
      throw new BudgetExceededError(spent, budget.capUsd);
    }

    const hasDeferred = req.tools.some((t) => t.defer_loading === true);
    const tools = hasDeferred ? [...req.tools, TOOL_SEARCH] : [...req.tools];

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await this.#deps.client.beta.messages.create({
        model: CONVERSATION_MODEL,
        max_tokens: MAX_TOKENS[req.task],
        // Sabit önek: tools → system sırasıyla render edilir; buradaki
        // cache_control ikisini birden önbelleğe alır.
        system: [
          {
            type: "text",
            text: this.#deps.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: tools as Anthropic.Beta.BetaToolUnion[],
        messages: req.messages,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT_POLICY[req.task] },
        fallbacks: "default",
        betas: [FALLBACK_BETA],
      });
    } catch (e) {
      throw translateApiError(e);
    }

    const usage: UsageSample = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    const costUsd = costOf(CONVERSATION_MODEL, usage);

    await this.#deps.ledger.record({
      at: new Date().toISOString(),
      tenantId: req.tenantId,
      userId: req.userId,
      correlationId: req.correlationId,
      model: CONVERSATION_MODEL,
      costUsd,
      ...usage,
    });

    const total = spent + costUsd;
    const result: CompleteResult = { message, usage, costUsd };
    return total >= budget.warnUsd
      ? {
          ...result,
          budgetWarning: `AI kullanımı ${total.toFixed(2)} USD — uyarı eşiği ${budget.warnUsd} USD.`,
        }
      : result;
  }
}

/** SDK hatalarını tipli, anlamlı hatalara çevirir. String eşleştirme yok. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = "GatewayError";
  }
}

export function translateApiError(e: unknown): GatewayError {
  if (e instanceof Anthropic.AuthenticationError) {
    return new GatewayError("AI sağlayıcı kimlik doğrulaması başarısız.", "auth", false, {
      cause: e,
    });
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new GatewayError("AI sağlayıcı hız sınırı; tekrar denenecek.", "rate_limit", true, {
      cause: e,
    });
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new GatewayError("AI isteği geçersiz.", "bad_request", false, { cause: e });
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new GatewayError("AI sağlayıcıya ulaşılamadı.", "connection", true, { cause: e });
  }
  if (e instanceof Anthropic.APIError) {
    return new GatewayError(`AI sağlayıcı hatası (${e.status}).`, "api_error", (e.status ?? 0) >= 500, {
      cause: e,
    });
  }
  return new GatewayError("Beklenmeyen AI hatası.", "unknown", false, { cause: e });
}
