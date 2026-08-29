/**
 * Parola saklama.
 *
 * scrypt kullanılıyor (Node yerleşik, ek bağımlılık yok). Parametreler
 * OWASP'ın scrypt önerisiyle uyumlu: N=2^16, r=8, p=1 — yaklaşık 64 MB
 * bellek maliyeti. Bellek maliyeti önemlidir çünkü GPU ile paralel kırma
 * saldırısını pahalı kılan şey CPU değil bellektir.
 *
 * KARŞILAŞTIRMA HER ZAMAN SABİT ZAMANLIDIR.
 * `===` ile hash karşılaştırmak, ilk farklı bayta kadar geçen süreyi
 * ölçerek parolanın ön ekini çıkarmaya izin verir. `timingSafeEqual`
 * bunu kapatır.
 *
 * FORMAT: `scrypt$N$r$p$salt$hash` — parametreler hash'in içinde saklanır,
 * böylece maliyet ileride yükseltildiğinde eski parolalar hâlâ doğrulanır
 * ve ilk başarılı girişte yeni maliyetle yeniden yazılabilir.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP önerisi (2024): N=2^16, r=8, p=1. */
export const DEFAULT_PARAMS: ScryptParams = { N: 65_536, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function maxmemFor(p: ScryptParams): number {
  // Node varsayılan 32 MB sınırını aşarız; 128*N*r formülüne pay bırak.
  return 256 * p.N * p.r;
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  if (password.length < 10) {
    throw new Error("Parola en az 10 karakter olmalıdır.");
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export interface VerifyResult {
  readonly valid: boolean;
  /** Hash eski parametrelerle üretildiyse true — girişte yenilenmeli. */
  readonly needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  stored: string,
  current: ScryptParams = DEFAULT_PARAMS,
): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return { valid: false, needsRehash: false };
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { valid: false, needsRehash: false };
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (expected.length !== KEY_LENGTH) return { valid: false, needsRehash: false };

  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: maxmemFor({ N, r, p }),
  });

  // SABİT ZAMANLI karşılaştırma — zamanlama sızıntısına kapalı.
  const valid = timingSafeEqual(derived, expected);
  const needsRehash = valid && (N !== current.N || r !== current.r || p !== current.p);
  return { valid, needsRehash };
}
