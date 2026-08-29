/**
 * Yapılandırılmış log.
 *
 * ÖNCESİ: hiç log yoktu. Üretimde bir kullanıcı "sistem cevap vermedi"
 * dediğinde elimizde HİÇBİR ŞEY olmuyordu — hangi istek, hangi tenant,
 * hangi tool, ne kadar sürdü, nerede patladı. Bir ERP'de bu kabul edilemez.
 *
 * NEDEN KÜTÜPHANE DEĞİL:
 * pino/winston güçlüdür ama burada gereken şey basit: tek satır JSON,
 * sabit alanlar, sıfır bağımlılık. Log toplayıcılar (CloudWatch, Loki,
 * Datadog) JSON satırını olduğu gibi yer.
 *
 * ÜÇ KURAL:
 *
 *  1. HER SATIRDA correlationId. Bir isteğin tüm izleri tek anahtarla
 *     toplanabilmeli; olmadan log yığını okunmaz bir gürültüdür.
 *
 *  2. GİZLİ VERİ LOGLANMAZ. Parola, token, TOTP kodu, tool girdisi ve
 *     dosya içeriği ASLA. Bir ERP logu maaş ve bakiye görebilecek kişilerin
 *     erişemediği bir yerde durur; oraya iş verisi yazmak, yetkilendirmeyi
 *     arkadan dolaşmaktır.
 *
 *  3. GELİŞTİRMEDE OKUNABİLİR, ÜRETİMDE MAKİNE OKUNUR. Aynı olay, iki
 *     biçim. Geliştiricinin JSON ayıklamak zorunda kalması onu loga
 *     bakmamaya iter.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly route?: string;
  readonly tool?: string;
  readonly durationMs?: number;
  readonly status?: number;
  readonly code?: string;
  readonly [key: string]: unknown;
}

const IS_PROD = process.env["NODE_ENV"] === "production";

/** Üretimde `debug` susar; gürültü, önemli satırı gizler. */
const MIN_LEVEL: LogLevel = IS_PROD ? "info" : "debug";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Log'a asla girmemesi gereken alan adları.
 *
 * Beyaz liste değil kara liste olması bilinçli: log alanları serbest
 * biçimli, kara liste bilinen tehlikeleri kesin olarak durdurur ve yeni
 * bir alan eklemek için kimseyi listeye dokunmaya zorlamaz.
 */
const REDACTED = new Set([
  "password",
  "parola",
  "token",
  "tokenHash",
  "secret",
  "totpSecret",
  "totpCode",
  "passwordHash",
  "authorization",
  "cookie",
  "content",
  "input",
  "payload",
  "apiKey",
]);

function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACTED.has(k)) {
      out[k] = "[gizlendi]";
      continue;
    }
    // Uzun metinler kırpılır: tek bir hata mesajı log satırını megabaytlara
    // çıkarabilir ve toplayıcı satırı tamamen düşürür.
    out[k] = typeof v === "string" && v.length > 512 ? `${v.slice(0, 512)}…` : v;
  }
  return out;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (ORDER[level] < ORDER[MIN_LEVEL]) return;

  const clean = sanitize(fields);
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (IS_PROD) {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...clean }));
    return;
  }

  const tail = Object.entries(clean)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  sink(`[${level}] ${message}${tail ? ` · ${tail}` : ""}`);
}

export const log = {
  debug: (m: string, f?: LogFields) => emit("debug", m, f),
  info: (m: string, f?: LogFields) => emit("info", m, f),
  warn: (m: string, f?: LogFields) => emit("warn", m, f),
  error: (m: string, f?: LogFields) => emit("error", m, f),

  /**
   * Hatayı loglar ve kullanıcıya gösterilecek REFERANS döner.
   *
   * Kullanıcıya yığın izi gösterilmez ama "bir şeyler ters gitti" de tek
   * başına işe yaramaz: destek araması geldiğinde logdaki satırı bulmanın
   * bir yolu olmalı. Referans o köprüdür.
   */
  fail(message: string, error: unknown, fields: LogFields = {}): string {
    const ref = crypto.randomUUID().slice(0, 8);
    emit("error", message, {
      ...fields,
      ref,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
    });
    return ref;
  },
};
