/**
 * LLM Gateway — tüm model çağrılarının geçtiği tek kapı.
 *
 * Hiçbir modül doğrudan Anthropic SDK'sını çağırmaz (Mimari v1 §7.1).
 * Gateway şunları merkezîleştirir: model seçimi, effort politikası,
 * prompt önbelleği, maliyet defteri, bütçe kapısı, tipli hata yönetimi
 * ve red (refusal) durumunda sunucu tarafı yedekleme.
 */

import Anthropic from "@anthropic-ai/sdk";
import { box } from "../server/singleton.js";
import { log } from "../server/log.js";
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
  /**
   * Model yeni tool çağırmasın.
   *
   * TOOL LİSTESİNİ BOŞALTMAK ÇÖZÜM DEĞİLDİR — VE BUNU CANLI KOŞUM
   * ÖĞRETTİ. Onay bekleyen bir işlem varken runner, tool listesini boş
   * gönderiyordu. Ama konuşma geçmişinde deferred yüklemeyle gelmiş
   * tool referansları duruyor ve sağlayıcı, listede olmayan bir
   * referans görünce İSTEĞİN TAMAMINI reddediyor:
   *
   *   "Tool reference 'create_serial_number' not found in available tools"
   *
   * Sonuç: onay formu açıldıktan sonraki tur çöküyor ve kullanıcı
   * "İstek tamamlanamadı" görüyor — hazırladığı işlem ekranda dururken.
   *
   * Doğrusu listeyi olduğu gibi göndermek ve ÇAĞRIYI KAPATMAKTIR:
   * referanslar geçerli kalır, model yeni bir şey hazırlayamaz.
   */
  readonly noToolCalls?: boolean;
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

    // BÜTÇE KAPISI — İKİ KADEMELİ VE İKİSİ DE GERÇEKTEN KAPATIR.
    //
    // Önceki hâlinde tavan yalnızca "lookup olmayan" işler için
    // geçerliydi; sohbetin tamamı lookup olarak gittiği için TAVAN HİÇ
    // DEVREYE GİRMİYORDU. Koruma kodda duruyor ama çalışmıyordu ve
    // okununca çalışıyor gibi görünüyordu — en tehlikelisi budur.
    if (spent >= budget.capUsd) {
      throw new BudgetExceededError(spent, budget.capUsd);
    }
    // Yumuşak eşik: pahalı işler durur, okuma sürer.
    if (spent >= budget.softCapUsd && req.task !== "lookup") {
      throw new BudgetExceededError(spent, budget.softCapUsd);
    }

    const hasDeferred = req.tools.some((t) => t.defer_loading === true);
    const tools = hasDeferred
      ? [...capStrict(req.tools), TOOL_SEARCH]
      : [...capStrict(req.tools)];

    /**
     * Gramer hatası ölümcül olmamalı.
     *
     * DÖRT KEZ AYNI ŞEY OLDU: `exclusiveMinimum`, `minItems: 2`,
     * "compiled grammar is too large", "Schema is too complex". Her
     * seferinde tek bir tool'un şeması yüzünden İSTEĞİN TAMAMI
     * reddedildi ve kullanıcı "İstek tamamlanamadı" gördü — 139
     * tool'un tamamı kullanılamaz hâle geldi.
     *
     * Strict gramerin faydası bir tur tasarruf; bedeli oturumun
     * ölmesi. Bu oran kabul edilemez. Gramer reddedilirse istek
     * STRICT'SİZ bir kez daha denenir: model geçersiz argüman
     * üretebilir ama zod onu yakalar ve düzeltme turu çalışır.
     *
     * Eşiği ayarlayarak bu hatayı kovalamak işe yaramaz — güvenli
     * sayı role ve hangi tool'ların listeye düştüğüne bağlıdır ve her
     * yeni tool'da değişir. Tek sağlam çözüm, hatayı yumuşak
     * düşüşe çevirmektir.
     */
    const isGrammarError = (e: unknown): boolean => {
      const msg = e instanceof Error ? e.message : String(e);
      return (
        msg.includes("grammar") ||
        msg.includes("Schema is too complex") ||
        msg.includes("too large")
      );
    };

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
        tools,
        ...(req.noToolCalls ? { tool_choice: { type: "none" as const } } : {}),
        messages: req.messages,
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT_POLICY[req.task] },
        fallbacks: "default",
        betas: [FALLBACK_BETA],
      }, WORKSPACE_HEADER);
    } catch (e) {
      if (isGrammarError(e)) {
        // Strict'siz tekrar: tool listesi aynı, gramer kısıtı yok.
        const relaxed = req.tools.map((t) => ({ ...t, strict: false }));
        const retryTools = hasDeferred
          ? [...(relaxed as unknown as Anthropic.Beta.BetaToolUnion[]), TOOL_SEARCH]
          : (relaxed as unknown as Anthropic.Beta.BetaToolUnion[]);
        log.warn("strict gramer reddedildi, strict'siz tekrar deneniyor", {
          tenantId: req.tenantId,
          userId: req.userId,
          correlationId: req.correlationId,
          toolCount: req.tools.length,
          error: e instanceof Error ? e.message : String(e),
        });
        message = await this.#deps.client.beta.messages.create(
          {
            model: CONVERSATION_MODEL,
            max_tokens: MAX_TOKENS[req.task],
            system: [
              {
                type: "text",
                text: this.#deps.systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            tools: retryTools,
            ...(req.noToolCalls ? { tool_choice: { type: "none" as const } } : {}),
            messages: req.messages,
            thinking: { type: "adaptive" },
            output_config: { effort: EFFORT_POLICY[req.task] },
            fallbacks: "default",
            betas: [FALLBACK_BETA],
          },
          WORKSPACE_HEADER,
        );
        // Buradan sonra normal yol işler: kullanım kaydı, maliyet,
        // bütçe uyarısı. Ayrı bir dönüş yolu açmak, defterin
        // tutulmadığı bir istek türü yaratırdı.
      } else {
        const err = translateApiError(e);
      // YAPILANDIRMA HATASI HATIRLANIR. Anahtar geçerli ama istek her
      // seferinde reddediliyorsa (eksik çalışma alanı, kapatılmış model,
      // yanlış bölge) her soru aynı hatayla döner ve kullanıcı sistemin
      // bozuk olduğunu sanır. Sağlık uç noktası bunu görebilmeli;
      // "bağlı" demek yetmez, "bağlı ama çalışmıyor" ayrı bir durumdur.
        if (!err.retryable && (err.code === "bad_request" || err.code === "auth")) {
          configErrorBox.set({
            at: new Date().toISOString(),
            code: err.code,
            message: err.message,
          });
        } else if (err.retryable) {
          configErrorBox.set(null);
        }
        throw err;
      }
    }

    // Başarılı istek, önceki yapılandırma hatasını geçersiz kılar.
    configErrorBox.set(null);

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

/**
 * Çalışma alanı (workspace) başlığı.
 *
 * KİMLİĞE BAĞLI API ANAHTARLARI bu başlığı ZORUNLU tutar: anahtar tek
 * başına hangi çalışma alanında işlem yapıldığını söylemez ve sunucu
 * isteği 400 ile reddeder. Hata mesajı ("anthropic-workspace-id is
 * required") anlaşılır ama isteğin nerede kurulduğunu bilmeyen biri için
 * kaybolmuş bir ayardır; burada açıkça duruyor.
 *
 * Normal (kimliğe bağlı olmayan) anahtarlarda değişken boş kalır ve
 * hiçbir başlık gönderilmez.
 */
const WORKSPACE_ID = process.env["ANTHROPIC_WORKSPACE_ID"]?.trim();
const WORKSPACE_HEADER = WORKSPACE_ID
  ? { headers: { "anthropic-workspace-id": WORKSPACE_ID } }
  : undefined;

/**
 * Son yapılandırma hatası — sağlık uç noktası için.
 *
 * SÜREÇ GENELİNDE tutulur: hatayı `/api/ask` yazar, `/api/health` okur ve
 * Next.js bu ikisini ayrı paketleyebildiği için modül değişkeni yetmez.
 * Başarılı bir istekle temizlenir.
 */
type ConfigError = { at: string; code: string; message: string } | null;
const configErrorBox = box<ConfigError>("model.configError", null);

export function modelConfigError(): ConfigError {
  return configErrorBox.get();
}

/**
 * `strict` tool sınırları — İKİSİ BİRDEN GEÇERLİ.
 *
 * Sağlayıcı iki ayrı sınır koyuyor ve ikisi de aşıldığında istek TÜMDEN
 * reddediliyor; yani tek bir fazlalık, o istekteki bütün tool'ları
 * kullanılamaz hâle getiriyor:
 *
 *   1. SAYI  — en fazla 20 strict tool.
 *   2. GRAMER BÜYÜKLÜĞÜ — strict şemalardan derlenen gramer bir eşiği
 *      aşamaz. Bizim yazma şemalarımız iç içe dizi içeriyor
 *      (`post_delivery.lines`, `post_journal_entry.lines`), bu yüzden
 *      20 tool bile gramer sınırını aşabiliyor. Sayıya bakmak yetmez;
 *      BÜYÜKLÜĞE bakmak gerekir.
 *
 * Bütçe muhafazakâr seçildi: sınırı deneme yanılmayla bulmak her
 * denemede para harcatır.
 */
/**
 * Strict gramere alınacak en fazla tool sayısı.
 *
 * MÜTEVAZI TUTULUYOR ÇÜNKÜ FAYDASI MÜTEVAZI. Strict gramer, modelin
 * geçersiz argüman üretmesini engeller — ama girdi zaten SUNUCUDA zod
 * ile doğrulanıyor; strict yalnızca bir tur tasarruf ettirir. Buna
 * karşılık dört kez İSTEĞİN TAMAMINI düşürdü. Aşağıdaki geri düşme
 * mekanizması olmasaydı burası 0 olurdu.
 */
export const MAX_STRICT_TOOLS = 5;
/**
 * Strict gramer bütçesi — YAPISAL AĞIRLIK biriminde, bayt değil.
 *
 * Değer ölçülerek seçildi: bu bütçeyle her rolde istek geçiyor,
 * iki katına çıkarıldığında üretim müdürü rolünde "Schema is too
 * complex" hatası dönüyor.
 */
export const STRICT_GRAMMAR_BUDGET = 55;

/**
 * Strict işaretini sınıra sığdırır.
 *
 * NEDEN YAZMA TOOL'LARI ÖNCELİKLİ: `strict` modda model şemaya UYMAK
 * ZORUNDADIR; uymadığı durumda istek baştan reddedilir ve yeniden
 * denenir. Okuma tool'unda hatalı bir argüman ucuzdur — zod reddeder,
 * model düzeltir. Yazma tool'unda ise hatalı argüman, kullanıcının
 * önüne yanlış doldurulmuş bir onay formu koyar; oradaki hata daha
 * pahalıdır ve fark edilmesi daha zordur.
 *
 * Strict KALDIRILMASI GÜVENLİĞİ ZAYIFLATMAZ: doğrulama zaten sunucuda
 * zod ile yapılıyor. Strict yalnızca modelin ilk denemede doğru yazma
 * olasılığını artırır.
 */
export function capStrict(
  tools: readonly AnthropicToolSchema[],
): Anthropic.Beta.BetaToolUnion[] {

  // Yetki seviyesi tool tanımında değil açıklamasında taşınıyor
  // ("[modül: … · yetki: L2]"); katalog metnini bozmamak için oradan okunur.
  const authorityOf = (t: AnthropicToolSchema): number => {
    const m = /yetki: L(\d)/.exec(t.description);
    return m ? Number(m[1]) : 0;
  };

  /*
   * GRAMER MALİYETİ BAYTA DEĞİL YAPIYA BAĞLIDIR.
   *
   * İlk sürüm şemanın JSON uzunluğunu ölçüyordu. Yanlış bir vekildi:
   * aynı bayt sayısındaki iki şemadan biri düz bir nesne, diğeri
   * nesne dizisi olabilir ve ikincisinin derlenmiş grameri kat kat
   * büyüktür (dizi, alt yapının tekrarı demektir).
   *
   * CANLI KOŞUMDA PATLADI: bayt bütçesi 4.000'in altında kalmasına
   * rağmen sağlayıcı "Schema is too complex" diyerek İSTEĞİN TAMAMINI
   * reddetti — yani tek bir tool'un iç içe şeması yüzünden o roldeki
   * bütün tool'lar kullanılamaz hâle geldi. Bu, `exclusiveMinimum` ve
   * `minItems` hatalarıyla aynı sınıf: gramerin sınırını zorlayınca
   * kaybedilen tek alan değil, bütün oturum.
   *
   * Buradaki ağırlık, derlenen gramere daha yakın bir tahmindir:
   * her alan bir birim, iç içe her katman çarpan, nesne dizileri
   * tekrar ettikleri için ağır cezalı.
   */
  const weightOf = (t: AnthropicToolSchema): number => {
    const walk = (node: unknown, depth: number): number => {
      if (depth > 6 || node === null || typeof node !== "object") return 1;
      const o = node as Record<string, unknown>;

      if (o["type"] === "array") {
        // Dizi, alt şemayı tekrar ettirir; nesne dizisi en pahalısıdır.
        const items = o["items"];
        const inner = walk(items, depth + 1);
        const isObjectArray =
          typeof items === "object" &&
          items !== null &&
          (items as Record<string, unknown>)["type"] === "object";
        return inner * (isObjectArray ? 4 : 2);
      }

      const props = o["properties"];
      if (props && typeof props === "object") {
        let total = 1;
        for (const v of Object.values(props as Record<string, unknown>)) {
          total += walk(v, depth + 1) * (1 + depth * 0.5);
        }
        return total;
      }

      // enum, her seçenek gramere ayrı bir dal ekler.
      const en = o["enum"];
      if (Array.isArray(en)) return 1 + en.length * 0.5;

      return 1;
    };
    return Math.round(walk(t.input_schema, 0));
  };

  const ranked = [...tools].sort((a, b) => authorityOf(b) - authorityOf(a));

  const strictNames = new Set<string>();
  let budget = STRICT_GRAMMAR_BUDGET;
  for (const t of ranked) {
    if (strictNames.size >= MAX_STRICT_TOOLS) break;
    const w = weightOf(t);
    if (w > budget) continue;
    budget -= w;
    strictNames.add(t.name);
  }

  return tools.map((t) =>
    strictNames.has(t.name) ? t : { ...t, strict: false },
  ) as unknown as Anthropic.Beta.BetaToolUnion[];
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
    // SEBEBİ MESAJA TAŞI. "AI isteği geçersiz" cümlesi tek başına hiçbir
    // şey anlatmaz; sunucunun söylediği sebep, sorunu çözecek tek bilgidir.
    const detail = detailOf(e);
    return new GatewayError(
      detail ? `AI isteği geçersiz: ${detail}` : "AI isteği geçersiz.",
      "bad_request",
      false,
      { cause: e },
    );
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

/** Sağlayıcının gönderdiği hata açıklaması — varsa. */
function detailOf(e: unknown): string | null {
  const body = (e as { error?: { error?: { message?: unknown } } }).error?.error?.message;
  return typeof body === "string" ? body : null;
}
