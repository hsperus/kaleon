/**
 * Entegratör adaptör sözleşmesi.
 *
 * Mimari v1 §8.1: her dış sistem için bir adapter; hepsi aynı beş yüzeyi
 * uygular. Bu tekdüzelik olmadan her entegratör kendi hata yönetimini,
 * kendi retry mantığını ve kendi idempotency kuralını getirir — ve
 * hiçbiri denetlenemez.
 *
 * ADAPTÖR DÖNÜŞTÜRMEZ, GETİRİR.
 * `fetch` yalnızca ham belgeleri döndürür. Kanonik modele dönüşüm
 * `normalize`'da olur ve pipeline tarafından AYRI bir adımda çağrılır.
 * Ayrım kritik: getirme başarılı olup dönüşüm başarısız olabilir; o durumda
 * ham veri saklanır, kanonik kayıt oluşmaz, insan inceler. Tek adımda
 * yapılsaydı hata durumunda kanıt da kaybolurdu.
 */

import type { Invoice } from "../documents/three-way-match.js";

export type IntegrationSource = "uyumsoft" | "logo" | "foriba" | "garanti" | "pdks";

export type PayloadKind = "einvoice" | "bank_statement" | "attendance";

/** Entegratörden gelen ham belge — hiçbir dönüşüm uygulanmamış. */
export interface RawDocument {
  readonly externalId: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}

/**
 * Hata sınıflandırması — retry politikası buradan türer.
 *
 *  - `network`  : geçici. Üstel geri çekilmeyle tekrar denenir.
 *  - `auth`     : kalıcı. Senkron durur, yönetici bilgilendirilir. Tekrar
 *                 denemek kilitlenmeye yol açar.
 *  - `data`     : belgeye özel. Ham veri saklanır, kanonik yazılmaz, insan
 *                 inceler. Diğer belgelerin akışı DURMAZ.
 *  - `unknown`  : sınıflandırılamadı; data gibi ele alınır.
 */
export type ErrorClass = "network" | "auth" | "data" | "unknown";

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly classification: ErrorClass,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = "IntegrationError";
  }
  get retryable(): boolean {
    return this.classification === "network";
  }
}

export interface FetchWindow {
  readonly since: string;
  readonly until: string;
}

/** Dönüşüm sonucu — kanonik nesne ya da neden dönüştürülemediği. */
export type NormalizeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface IntegrationAdapter<T> {
  readonly source: IntegrationSource;
  readonly kind: PayloadKind;
  /** Kimlik doğrulama el sıkışması. Başarısızsa `auth` hatası fırlatır. */
  connect(): Promise<void>;
  /** Ham belgeleri getirir. DÖNÜŞTÜRMEZ. */
  fetch(window: FetchWindow): Promise<readonly RawDocument[]>;
  /** Ham belgeyi kanonik modele çevirir. Saf fonksiyon — I/O yapmaz. */
  normalize(raw: RawDocument): NormalizeResult<T>;
}

/** İçerik parmak izi — aynı belge değişmiş mi anlamak için. */
export function checksum(payload: unknown): string {
  const text = JSON.stringify(payload, Object.keys(payload as object).sort());
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

export type InvoiceAdapter = IntegrationAdapter<Invoice>;
