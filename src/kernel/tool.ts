/**
 * `defineTool` — KAELON'un tek yazma primitifi.
 *
 * Ürün Mantığı Raporu §9'daki yedi katmanlı tool anatomisi burada tipe dönüşür:
 *
 *   1. Metadata      → name, module, description (TR + EN)
 *   2. Input Schema  → input (zod → strict JSON Schema)
 *   3. Authorization → requires + authority + tenant eşleşmesi
 *   4. Validation    → validate()  (iş kuralı)
 *   5. Execution     → execute()   (ACID transaction içinde)
 *   6. Audit Log     → invoker tarafından otomatik
 *   7. Response      → ToolOk<T> (kaynak zorunlu)
 *
 * Bir UI butonu eklemek için önce buradan bir tool yazılır. UI, AI, mobil ve
 * API aynı tool'u çağırır — tek implementasyon, dört çağrı noktası.
 */

import { z } from "zod";
import type {
  AuthorityLevel,
  ModuleId,
  Permission,
  Principal,
  ToolContext,
  ToolOk,
} from "./types.js";
import { assertNotL4 } from "./authority.js";

/** Anthropic'e gönderilecek tool tanımı (custom tool varyantı). */
export interface AnthropicToolSchema {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly strict: true;
  readonly defer_loading?: boolean;
}

export interface ToolSpec<S extends z.ZodType, R> {
  /** Kalıcı kimlik. Değiştirilirse audit geçmişi kopar. `[a-z0-9_]{1,64}` */
  readonly name: string;
  readonly module: ModuleId;
  readonly authority: AuthorityLevel;
  /** Modelin tool'u doğru bağlamda seçmesi için — TR birincil. */
  readonly description: { readonly tr: string; readonly en: string };
  readonly input: S;
  /** Hepsi karşılanmalı (AND). Boş dizi = herkese açık (nadir). */
  readonly requires: readonly Permission[];
  /**
   * `true` (varsayılan) → tool aramayla yüklenir, her isteğe konmaz.
   * Çekirdek/sık kullanılan birkaç tool `false` olmalı.
   */
  readonly deferLoading?: boolean;
  /** İş kuralı doğrulaması. Hata fırlatarak reddeder. */
  readonly validate?: (input: z.output<S>, ctx: ToolContext) => Promise<void> | void;
  /** Asıl iş. Transaction sınırı burada başlar ve biter. */
  readonly execute: (input: z.output<S>, ctx: ToolContext) => Promise<ToolOk<R>>;
  /** Alan seviyesi maskeleme — rol bazlı. */
  readonly redact?: (data: R, principal: Principal) => R;
}

export interface Tool<S extends z.ZodType = z.ZodType, R = unknown>
  extends ToolSpec<S, R> {
  readonly deferLoading: boolean;
  /** Anthropic tool tanımı — deterministik, önbellek güvenli. */
  readonly schema: AnthropicToolSchema;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * JSON Schema'yı Anthropic `strict: true` şartlarına uydurur:
 * her nesne için `additionalProperties: false` ve `required` tam liste.
 */
function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (node === null || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema") continue;
    out[k] = harden(v);
  }
  if (out["type"] === "object") {
    out["additionalProperties"] = false;
    const props = out["properties"];
    if (props && typeof props === "object" && !Array.isArray(props)) {
      // strict mode tüm anahtarların `required` içinde olmasını ister;
      // "opsiyonel" alanlar zod tarafında `.nullable()` ile ifade edilmelidir.
      out["required"] = Object.keys(props as Record<string, unknown>);
    }
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  return harden(raw) as Record<string, unknown>;
}

export function defineTool<S extends z.ZodType, R>(spec: ToolSpec<S, R>): Tool<S, R> {
  if (!NAME_RE.test(spec.name)) {
    throw new Error(
      `Geçersiz tool adı "${spec.name}". Kural: küçük harf, rakam ve alt çizgi, 3-64 karakter.`,
    );
  }
  // L4 sınırı: bir tool adı resmî gönderim / ödeme / yetki yükseltme ima
  // ediyorsa kayıt anında reddedilir.
  assertNotL4(spec.name);

  const description =
    `${spec.description.tr}\n(EN) ${spec.description.en}\n` +
    `[modül: ${spec.module} · yetki: L${spec.authority}]`;

  const deferLoading = spec.deferLoading ?? true;

  const schema: AnthropicToolSchema = {
    name: spec.name,
    description,
    input_schema: toStrictJsonSchema(spec.input),
    strict: true,
    ...(deferLoading ? { defer_loading: true } : {}),
  };

  return Object.freeze({ ...spec, deferLoading, schema });
}
