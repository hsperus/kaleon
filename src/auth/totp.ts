/**
 * TOTP (RFC 6238) — yönetici hesapları için zorunlu ikinci faktör.
 *
 * Mimari v1 §9.1: "2FA (TOTP) — admin için zorunlu."
 *
 * ÜÇ GÜVENLİK AYRINTISI:
 *
 *  1. PENCERE DAR TUTULUR. ±1 adım (±30 sn) kabul edilir. Geniş pencere
 *     çalınmış bir kodun kullanım ömrünü uzatır; dar pencere saat kaymasına
 *     karşı hâlâ toleranslıdır.
 *
 *  2. KOD TEKRAR KULLANILAMAZ. Doğrulanan adım kaydedilir; aynı kod ikinci
 *     kez kabul edilmez. Bu olmadan, omuz üstünden okunan veya ağdan
 *     yakalanan bir kod 30 saniye boyunca geçerli kalır.
 *
 *  3. KARŞILAŞTIRMA SABİT ZAMANLI. Kod kısa olduğu için zamanlama saldırısı
 *     zordur ama imkânsız değildir; ucuz olan korumayı atlamak için sebep yok.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Kabul edilen adım kayması. ±1 = ±30 saniye. */
const WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Belirli bir zaman adımı için kod üretir. */
export function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

export interface TotpVerifyInput {
  readonly secret: string;
  readonly code: string;
  readonly now: Date;
  /** Bu kullanıcı için daha önce kullanılmış adım. Tekrar kullanımı engeller. */
  readonly lastUsedStep?: number | null;
}

export type TotpResult =
  | { readonly valid: true; readonly step: number }
  | { readonly valid: false; readonly reason: "format" | "mismatch" | "replayed" };

export function verifyTotp(input: TotpVerifyInput): TotpResult {
  const code = input.code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return { valid: false, reason: "format" };

  const now = currentStep(input.now);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = now + offset;
    const expected = totpAt(input.secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      // TEKRAR KULLANIM KORUMASI
      if (input.lastUsedStep !== undefined && input.lastUsedStep !== null && step <= input.lastUsedStep) {
        return { valid: false, reason: "replayed" };
      }
      return { valid: true, step };
    }
  }
  return { valid: false, reason: "mismatch" };
}

/** Kimlik doğrulayıcı uygulamalara verilecek URI. */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
