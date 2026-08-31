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
 *
 * DAYANIKLILIK — bir tool'un patlaması konuşmayı öldürmez:
 *
 *  1. TOOL ZAMAN AŞIMI. Asılı kalan bir sorgu, isteği sonsuza kadar bekletir.
 *     Süre dolduğunda model bir hata sonucu görür ve toparlanabilir; kullanıcı
 *     boş ekranda beklemez.
 *
 *  2. BEKLENMEYEN İSTİSNA YUTULMAZ AMA ÖLDÜRMEZ. Tool'dan fırlayan hata,
 *     modele `is_error` sonucu olarak döner. Tek istisna DENETİM YAZMA
 *     HATASIDIR: denetim kaydı yazılamıyorsa yetkili işlem yapılamaz ve
 *     konuşma durur. Denetimsiz iş yapmak, hiç iş yapmamaktan kötüdür.
 *
 *  3. TOPLAM SÜRE SINIRI. Sekiz tur × yavaş tool = dakikalarca bekleyen
 *     kullanıcı. Süre dolduğunda döngü elindeki bilgiyle biter.
 *
 *  4. İPTAL EDİLEBİLİR. Kullanıcı sekmeyi kapattığında model turu ve tool'lar
 *     boşuna çalışmaya devam etmez.
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
import { isConfirmationRequired, type PendingStore } from "../kernel/pending.js";
import { AuditWriteError } from "../kernel/errors.js";

/** Tek tool çağrısı için üst sınır. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
/** Konuşmanın tamamı için üst sınır. */
export const DEFAULT_DEADLINE_MS = 90_000;

const DEADLINE_ANSWER =
  "Bu soru ayrılan sürede tamamlanamadı. Soruyu daraltıp tekrar sorabilirsiniz.";

export interface RunRequest {
  readonly question: string;
  readonly principal: Principal;
  readonly tenant: TenantContext;
  readonly correlationId: string;
  readonly channel: Channel;
  readonly task: TaskKind;
  readonly display: {
    name: string;
    roleLabel: string;
    companyName: string;
    /** Sektör ve öncelikler — cevabın tonunu belirler, rakamını değil. */
    sector?: string | null;
    goals?: string | null;
    /** Sektör–sistem kelime köprüsü. */
    glossary?: readonly { sektor: string; sistem: string }[] | null;
  };
  readonly now?: () => Date;
  /** İlerleme olayları. Verilmezse döngü sessiz çalışır. */
  readonly onEvent?: (event: RunEvent) => void;
  /** Tek bir tool çağrısı için üst sınır. */
  readonly toolTimeoutMs?: number;
  /** Konuşmanın tamamı için üst sınır. */
  readonly deadlineMs?: number;
  /** Kullanıcı vazgeçtiğinde döngüyü durdurur. */
  readonly signal?: AbortSignal;
  /**
   * Önceki turlar — yalnızca soru ve nihai cevap metinleri.
   *
   * TOOL SONUÇLARI GEÇMİŞE YAZILMAZ. İki sebep:
   *   - Bayat veri taze gibi okunur. Dünkü banka bakiyesi bugünkü cevaba
   *     karışırsa, sistem yanlış rakam söyler ve nereden geldiği anlaşılmaz.
   *   - Geçmiş sınırsız büyür; her tur bir öncekinin tüm tool çıktısını
   *     taşırsa maliyet ve gecikme katlanır.
   * Model bilgiye yine ihtiyaç duyarsa tool'u TEKRAR çağırır ve güncelini alır.
   */
  readonly history?: readonly ConversationTurn[];
  /**
   * Onay bekleyen işlem deposu.
   *
   * Yazma tool'ları bunsuz çalışmaz — insan onayı yapılandırmaya bağlı
   * bir seçenek değil, sistemin çalışma şartıdır.
   */
  readonly pending?: PendingStore;
  readonly conversationId?: string | null;
}

export interface ConversationTurn {
  readonly question: string;
  readonly answer: string;
}

export interface ToolCallRecord {
  readonly tool: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly durationMs: number;
}

/**
 * Ajan döngüsünün ilerleme olayları.
 *
 * Neden var: bir tool çağrısı yüz milisaniyeler, model turu saniyeler sürer.
 * Kullanıcının bu süre boyunca boş ekrana bakması, sistemin donduğu izlenimi
 * verir. Olaylar akarken arayüz "şu an ne yapılıyor"u gösterebilir.
 *
 * Olaylar döngünün GERÇEK adımlarıdır; süsleme değildir. `tool_start`
 * gerçekten o tool çağrılmadan hemen önce yayınlanır.
 */
export type RunEvent =
  | { readonly type: "tool_start"; readonly tool: string }
  | {
      readonly type: "tool_end";
      readonly tool: string;
      readonly ok: boolean;
      readonly code?: string;
      readonly durationMs: number;
      /** Panelde gösterilebilecek yapılandırılmış sonuç. */
      readonly data?: unknown;
      readonly sources?: readonly { system: string; syncedAt: string; recordCount?: number }[];
      readonly risks?: readonly { severity: string; message: string }[];
    }
  | { readonly type: "text"; readonly text: string }
  /**
   * Bir yazma işlemi hazırlandı ve ONAY BEKLİYOR — henüz çalışmadı.
   *
   * Arayüz bunu alınca formu açar. `tool_end` olarak yayınlansaydı
   * arayüz onu başarısız bir çağrı sanar ve kullanıcıya hata gösterirdi;
   * oysa bu akışın normal bir adımıdır.
   */
  | {
      readonly type: "pending";
      readonly tool: string;
      readonly pendingId: string;
      readonly input: unknown;
      readonly authority: number;
      readonly expiresAt: string;
    }
  | { readonly type: "done"; readonly result: RunResult };

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
  const toolTimeoutMs = req.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const deadline = Date.now() + (req.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    // Geçmiş turlar: yalnızca metin. Tool çıktısı taşınmaz.
    ...(req.history ?? []).flatMap((t): Anthropic.Beta.BetaMessageParam[] => [
      { role: "user", content: t.question },
      { role: "assistant", content: t.answer },
    ]),
    { role: "user", content: req.question },
    {
      // Konuşma ortası sistem mesajı: önbelleklenmiş öneki bozmadan oturum
      // bağlamını taşır ve prompt injection'a kapalı operatör kanalıdır.
      role: "system",
      content: sessionContext({
        displayName: req.display.name,
        roleLabel: req.display.roleLabel,
        companyName: req.display.companyName,
        sector: req.display.sector ?? null,
        goals: req.display.goals ?? null,
        glossary: req.display.glossary ?? null,
        localDate: now().toLocaleDateString("tr-TR"),
        visibleTools: catalog.names,
      }),
    },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let costUsd = 0;
  let budgetWarning: string | undefined;
  /**
   * Bir işlem onay bekliyor mu.
   *
   * Bir kez true olunca turun geri kalanında tool listesi BOŞ gönderilir:
   * kullanıcı karar verene kadar sistem yeni bir şey hazırlamaz.
   */
  let awaitingConfirmation = false;
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    if (req.signal?.aborted) {
      return finish({
        answer: "İstek iptal edildi.",
        toolCalls,
        iterations,
        costUsd,
        stopReason: "aborted",
        refused: false,
        ...(budgetWarning ? { budgetWarning } : {}),
      });
    }

    if (Date.now() > deadline) {
      return finish({
        answer: DEADLINE_ANSWER,
        toolCalls,
        iterations,
        costUsd,
        stopReason: "deadline",
        refused: false,
        ...(budgetWarning ? { budgetWarning } : {}),
      });
    }

    // ONAY BEKLENİYORSA MODEL ARTIK TOOL ÇAĞIRAMAZ.
    //
    // Çağırabilseydi — ki betikli tamamlayıcıda ve gerçek modelde de olur —
    // aynı işlem için ikinci, üçüncü form açılırdı: kullanıcının önüne
    // birbirinin aynı beş fatura onayı çıkar ve hangisinin gerçek olduğu
    // anlaşılmazdı. Konuşma kullanıcıya kilitlenmiştir; modelin yapacağı
    // tek şey ne hazırladığını anlatmaktır.
    const { message, costUsd: turnCost, budgetWarning: warn } = await deps.gateway.complete({
      messages,
      /*
       * ONAY BEKLERKEN LİSTE BOŞALTILMAZ, ÇAĞRI KAPATILIR.
       *
       * Boşaltmak, geçmişteki deferred tool referanslarını geçersiz
       * kılıyor ve sağlayıcı isteğin tamamını reddediyordu; kullanıcı
       * onay formunu görüyor ama arkasından "İstek tamamlanamadı"
       * yazısı geliyordu.
       */
      tools: catalog.all,
      noToolCalls: awaitingConfirmation,
      task: req.task,
      tenantId: req.tenant.tenantId,
      userId: req.principal.userId,
      correlationId: req.correlationId,
    });
    costUsd += turnCost;
    if (warn) budgetWarning = warn;

    if (message.stop_reason === "refusal") {
      return finish({
        answer:
          "Bu isteği güvenlik nedeniyle işleyemiyorum. Soruyu farklı biçimde sorabilir " +
          "veya yetkili bir kullanıcıdan destek isteyebilirsiniz.",
        toolCalls,
        iterations,
        costUsd,
        stopReason: message.stop_reason,
        refused: true,
        ...(budgetWarning ? { budgetWarning } : {}),
      });
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
      const finalText = textOf(message);
      req.onEvent?.({ type: "text", text: finalText });
      return finish({
        answer: finalText,
        toolCalls,
        iterations,
        costUsd,
        stopReason: message.stop_reason,
        refused: false,
        ...(budgetWarning ? { budgetWarning } : {}),
      });
    }

    messages.push({ role: "assistant", content: message.content });

    // Paralel tool kullanımı varsayılan olarak açık — hepsini eşzamanlı çalıştır.
    const results = await Promise.all(
      toolUses.map(async (use) => {
        req.onEvent?.({ type: "tool_start", tool: use.name });
        const invoked = await safeInvoke(
          use,
          {
            registry: deps.registry,
            audit: deps.audit,
            principal: req.principal,
            tenant: req.tenant,
            correlationId: req.correlationId,
            channel: req.channel,
            now,
            ...(req.pending ? { pending: req.pending } : {}),
            ...(req.conversationId !== undefined
              ? { conversationId: req.conversationId }
              : {}),
            aiContext: {
              model: CONVERSATION_MODEL,
              promptVersion: PROMPT_VERSION,
              toolUseId: use.id,
            },
          },
          toolTimeoutMs,
        );
        toolCalls.push({
          tool: use.name,
          ok: invoked.outcome.ok,
          durationMs: invoked.durationMs,
          ...(invoked.outcome.ok ? {} : { code: invoked.outcome.code }),
        });

        // ONAY BEKLEYEN İŞLEM HATA DEĞİLDİR. `is_error` işaretlenseydi model
        // "işlem başarısız" diye özür dilerdi; oysa işlem hazırlandı ve
        // kullanıcının önünde duruyor.
        const awaiting = isConfirmationRequired(invoked.outcome);

        if (awaiting) {
          awaitingConfirmation = true;
          const p = invoked.outcome as unknown as {
            pendingId: string;
            input: unknown;
            authority: number;
            expiresAt: string;
          };
          req.onEvent?.({
            type: "pending",
            tool: use.name,
            pendingId: p.pendingId,
            input: p.input,
            authority: p.authority,
            expiresAt: p.expiresAt,
          });
        } else {
          req.onEvent?.({
            type: "tool_end",
            tool: use.name,
            ok: invoked.outcome.ok,
            durationMs: invoked.durationMs,
            ...(invoked.outcome.ok
              ? {
                  data: invoked.outcome.data,
                  sources: invoked.outcome.sources,
                  ...(invoked.outcome.risks ? { risks: invoked.outcome.risks } : {}),
                }
              : { code: invoked.outcome.code }),
          });
        }

        const block: Anthropic.Beta.BetaToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: use.id,
          content: awaiting
            ? JSON.stringify({
                status: "onay_bekliyor",
                message:
                  "İşlem hazırlandı ve kullanıcının önüne ONAY FORMU olarak kondu. " +
                  "HENÜZ ÇALIŞMADI. Kullanıcıya ne hazırladığını rakamlarla bir " +
                  "cümlede özetle ve onayını beklediğini söyle. Aynı işlemi TEKRAR " +
                  "ÇAĞIRMA — ikinci bir form açılır.",
                tool: use.name,
                input: (invoked.outcome as unknown as { input: unknown }).input,
              })
            : JSON.stringify(invoked.outcome),
          ...(invoked.outcome.ok || awaiting ? {} : { is_error: true }),
        };
        return block;
      }),
    );

    // KRİTİK: tüm tool_result blokları TEK user mesajında dönmeli.
    messages.push({ role: "user", content: results });
  }

  return finish({
    answer:
      "Bu soruyu verilen adım sınırı içinde tamamlayamadım. Soruyu daraltıp tekrar sorabilirsiniz.",
    toolCalls,
    iterations,
    costUsd,
    stopReason: "max_iterations",
    refused: false,
    ...(budgetWarning ? { budgetWarning } : {}),
  });

  function finish(result: RunResult): RunResult {
    req.onEvent?.({ type: "done", result });
    return result;
  }
}

/** Tek tool çağrısı: zaman aşımı ve beklenmeyen istisnaya karşı korunmuş. */
async function safeInvoke(
  use: Anthropic.Beta.BetaToolUseBlock,
  opts: Parameters<typeof invokeTool>[2],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof invokeTool>>> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      invokeTool(use.name, use.input, opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(use.name, timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (e) {
    // DENETİM YAZILAMIYORSA KONUŞMA DURUR. Yetkili bir işlemin izi
    // tutulamıyorsa o işlem yapılmamalıdır; hatayı yutmak, iz bırakmadan
    // iş yapmayı mümkün kılardı.
    if (e instanceof AuditWriteError) throw e;

    const timedOut = e instanceof ToolTimeoutError;
    return {
      toolName: use.name,
      durationMs: Date.now() - t0,
      outcome: {
        ok: false,
        code: timedOut ? "tool_timeout" : "tool_crashed",
        message: timedOut
          ? `${use.name} ${timeoutMs} ms içinde yanıt vermedi.`
          : `${use.name} beklenmeyen bir hatayla durdu: ${(e as Error).message}`,
        // Kullanıcıya gösterilebilir: teknik ayrıntı yok, sistem içi bilgi
        // sızdırmıyor ve modelin durumu açıklamasına izin veriyor.
        userFacing: true,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`${tool} zaman aşımına uğradı (${ms} ms)`);
    this.name = "ToolTimeoutError";
  }
}
