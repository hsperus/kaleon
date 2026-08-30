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
  /**
   * Kullanıcı onayı gerekir mi.
   *
   * Belirtilmezse yetki seviyesinden türer: OKUMA (L0) onay istemez, YAZMANIN
   * TAMAMI (L1+) ister. `"never"` yalnızca kendi onay akışını taşıyan
   * tool'lar içindir; koymadan önce iki kez düşünülmelidir — bu alan,
   * insan onayını devre dışı bırakmanın tek yoludur.
   */
  readonly confirm?: "always" | "never";
}

export interface Tool<S extends z.ZodType = z.ZodType, R = unknown>
  extends ToolSpec<S, R> {
  readonly deferLoading: boolean;
  /** Anthropic tool tanımı — deterministik, önbellek güvenli. */
  readonly schema: AnthropicToolSchema;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Sayısal aralık anahtarları — `strict: true` tool şemasında DESTEKLENMEZ.
 *
 * zod, `.int().positive()` için `exclusiveMinimum`, `.max(12)` için
 * `maximum` üretir; sağlayıcı bunları reddeder ve İSTEK TÜMDEN
 * BAŞARISIZ OLUR. Yani tek bir tool'daki bir aralık kısıtı, o istekteki
 * bütün tool'ları kullanılamaz hâle getirir.
 *
 * Anahtarlar ATILIR AMA BİLGİ KAYBOLMAZ: kısıt açıklamaya yazılır, böylece
 * model sınırı yine bilir. Doğrulama zaten sunucuda zod ile yapılıyor;
 * şema modele YOL GÖSTERİR, güvenliği o sağlamaz.
 */
const RANGE_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;

/**
 * Dizi uzunluğu kısıtları.
 *
 * `minItems` 0 VE 1 DIŞINDA DESTEKLENMİYOR. Model API'si `minItems: 2`
 * gören bir tool şemasını reddediyor ve reddettiğinde İSTEĞİN TAMAMI
 * düşüyor — tek bir tool yüzünden 118 tool birden kullanılamaz hâle
 * geliyor. Bu, sayı aralıklarında yaşanan hatanın aynısı: şema
 * gramerin sınırlarını zorladığında kaybedilen tek bir alan değil,
 * bütün oturum.
 *
 * KISIT KAYBOLMUYOR. Şemadan çıkarılan sınır açıklamaya yazılıyor ve
 * asıl doğrulama zaten SUNUCUDA, zod ile yapılıyor: modele gönderilen
 * şema bir gramer ipucudur, güvenlik sınırı değil.
 */
const ITEM_KEYS = ["minItems", "maxItems"] as const;

/**
 * Sağlayıcının desteklemediği şema anahtarları.
 *
 * ÜÇÜNCÜ KEZ AYNI SINIF. Önce `exclusiveMinimum`, sonra `minItems: 2`,
 * şimdi `propertyNames` — `z.record()` bunu üretiyor ve sağlayıcı
 * "For 'object' type, property 'propertyNames' is not supported"
 * diyerek İSTEĞİN TAMAMINI reddediyor. Yani tek bir tool'un tek bir
 * anahtarı, o roldeki bütün tool'ları kullanılamaz hâle getiriyor.
 *
 * Tek tek kovalamak işe yaramadı; artık desteklenmeyen anahtarlar
 * burada toplu hâlde çıkarılıyor ve `tests/tool-schema-guard.test.ts`
 * registry'nin tamamını izin listesine karşı tarıyor.
 */
const UNSUPPORTED_KEYS = [
  "propertyNames",
  "patternProperties",
  "unevaluatedProperties",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
] as const;

/** Dizi uzunluğu kısıtını cümleye çevirir. */
function itemsNote(src: Record<string, unknown>): string {
  const min = src["minItems"];
  const max = src["maxItems"];
  const hasMin = typeof min === "number" && min > 1;
  const hasMax = typeof max === "number";
  if (hasMin && hasMax) return `en az ${min}, en fazla ${max} eleman`;
  if (hasMin) return `en az ${min} eleman`;
  if (hasMax) return `en fazla ${max} eleman`;
  return "";
}

/** Kısıtı insanın (ve modelin) okuyacağı bir cümleye çevirir. */
function rangeNote(src: Record<string, unknown>): string {
  const parts: string[] = [];
  const num = (v: unknown): string => String(v);

  if (typeof src["exclusiveMinimum"] === "number") {
    parts.push(`${num(src["exclusiveMinimum"])} değerinden büyük`);
  } else if (typeof src["minimum"] === "number") {
    parts.push(`en az ${num(src["minimum"])}`);
  }
  if (typeof src["exclusiveMaximum"] === "number") {
    parts.push(`${num(src["exclusiveMaximum"])} değerinden küçük`);
  } else if (typeof src["maximum"] === "number") {
    parts.push(`en fazla ${num(src["maximum"])}`);
  }
  if (typeof src["multipleOf"] === "number") {
    parts.push(`${num(src["multipleOf"])} katı`);
  }
  return parts.join(", ");
}

/**
 * JSON Schema'yı Anthropic `strict: true` şartlarına uydurur:
 * her nesne için `additionalProperties: false` ve `required` tam liste;
 * desteklenmeyen sayısal aralık anahtarları açıklamaya taşınır.
 */
function harden(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(harden);
  if (node === null || typeof node !== "object") return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const isNumeric = src["type"] === "integer" || src["type"] === "number";
  const isArray = src["type"] === "array";
  // minItems yalnızca 0 ya da 1 olabildiği için, 2 ve üzeri kısıtın
  // TAMAMI şemadan çıkarılır; yarısını bırakmak grameri yine bozardı.
  const stripItems = isArray && typeof src["minItems"] === "number" && src["minItems"] > 1;
  const note = isNumeric ? rangeNote(src) : stripItems ? itemsNote(src) : "";

  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema") continue;
    if (isNumeric && (RANGE_KEYS as readonly string[]).includes(k)) continue;
    if (stripItems && (ITEM_KEYS as readonly string[]).includes(k)) continue;
    // Desteklenmeyen anahtar HER DÜĞÜMDEN çıkarılır: kalırsa istek
    // tümden reddedilir ve hata tek bir alanı değil oturumu düşürür.
    if ((UNSUPPORTED_KEYS as readonly string[]).includes(k)) continue;
    out[k] = harden(v);
  }

  if (note) {
    const existing = typeof out["description"] === "string" ? out["description"] : "";
    const label = isNumeric ? "Değer aralığı" : "Uzunluk";
    out["description"] = existing ? `${existing} (${note})` : `${label}: ${note}.`;
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
