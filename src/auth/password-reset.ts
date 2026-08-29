/**
 * Parola sıfırlama — yönetici başlatır.
 *
 * NEDEN E-POSTA YOK:
 * E-posta altyapısı kurulu değil. Olmayan altyapıya karşı kod yazmak, test
 * edilemeyen ve ilk gerçek kurulumda yanlış çıkan kod yazmaktır. Akış Türk
 * KOBİ gerçeğine göre kuruldu: kullanıcı yöneticiyi arar, yönetici tek
 * kullanımlık bir kod üretir ve telefonla iletir. SMTP eklendiğinde aynı
 * kod e-postayla gönderilir — akış değişmez, yalnızca iletim kanalı eklenir.
 *
 * BEŞ GÜVENLİK KARARI:
 *
 *  1. KOD HASH'LENEREK SAKLANIR. Veritabanı sızarsa saklanan değerle parola
 *     sıfırlanamaz. Parolayı hash'leyip sıfırlama kodunu düz saklamak,
 *     ön kapıyı kilitleyip arka kapıyı açık bırakmaktır.
 *
 *  2. TEK KULLANIMLIK. Kullanılan kod ikinci kez çalışmaz; `usedAt`
 *     damgalanır. Aksi hâlde telefonla iletilmiş bir kod, iletildiği
 *     kanalda kaldığı sürece geçerli bir arka kapıdır.
 *
 *  3. KISA ÖMÜR (1 saat). Sıfırlama kodu bir kolaylık değil, geçici bir
 *     yetkidir.
 *
 *  4. YENİ KOD ESKİLERİ İPTAL EDER. Aynı kullanıcı için birden çok geçerli
 *     kod dolaşması, hangisinin kimde olduğunu takip edilemez kılar.
 *
 *  5. SIFIRLAMA TÜM OTURUMLARI DÜŞÜRÜR. Parola değişiminin sebebi çoğu
 *     zaman "birileri girmiş olabilir" şüphesidir; eski oturumlar açık
 *     kalırsa sıfırlamanın hiçbir anlamı olmaz.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { hashPassword } from "./password.js";

/** Kod ömrü. */
export const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * İnsan tarafından telefonda okunabilir kod.
 *
 * Karışan karakterler (0/O, 1/I/L) YOK: kod sözlü iletiliyor ve "sıfır mı
 * O mu" diye sorulan her kod, yanlış girilen bir koddur.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateResetCode(): string {
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  // Okunurluk için gruplanır: "ABCD-EFGH-JK"
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

export function hashResetCode(code: string): string {
  // Büyük/küçük ve tire farkı önemsiz: telefonda "tire var mıydı" diye
  // sorulmasın.
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  return createHash("sha256").update(normalized).digest("base64url");
}

export interface ResetRecord {
  readonly id: string;
  readonly userId: string;
  readonly codeHash: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

export interface PasswordResetStore {
  /** Kullanıcının bekleyen tüm kodlarını iptal eder. */
  invalidateAll(userId: string, at: string): Promise<void>;
  create(input: {
    userId: string;
    codeHash: string;
    expiresAt: string;
    issuedBy: string | null;
  }): Promise<void>;
  findByHash(codeHash: string): Promise<ResetRecord | null>;
  markUsed(id: string, at: string): Promise<void>;
  /** Parolayı değiştirir ve kullanıcının tüm oturumlarını düşürür. */
  applyNewPassword(userId: string, passwordHash: string, at: string): Promise<void>;
}

export interface IssueResult {
  readonly code: string;
  readonly expiresAt: string;
}

/** Yönetici bir sıfırlama kodu üretir. */
export async function issueResetCode(
  store: PasswordResetStore,
  input: { userId: string; issuedBy: string | null; now?: () => Date },
): Promise<IssueResult> {
  const now = input.now ?? (() => new Date());
  const at = now().toISOString();

  // Yeni kod eskileri iptal eder.
  await store.invalidateAll(input.userId, at);

  const code = generateResetCode();
  const expiresAt = new Date(now().getTime() + RESET_TTL_MS).toISOString();
  await store.create({
    userId: input.userId,
    codeHash: hashResetCode(code),
    expiresAt,
    issuedBy: input.issuedBy,
  });
  return { code, expiresAt };
}

export type ResetOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: "invalid" | "expired" | "used" | "weak_password" };

/**
 * Kullanıcı kodu ve yeni parolayı verir.
 *
 * HATA SEBEPLERİ AYRILMAZ HÂLE GETİRİLİR: uç nokta hepsine aynı cevabı
 * döner. "Kod geçersiz" ile "kodun süresi dolmuş" ayrımı, saldırgana kod
 * denemesinin ne kadar yaklaştığını söyler.
 */
export async function redeemResetCode(
  store: PasswordResetStore,
  input: { code: string; newPassword: string; now?: () => Date },
): Promise<ResetOutcome> {
  const now = input.now ?? (() => new Date());

  const hash = hashResetCode(input.code);
  const record = await store.findByHash(hash);
  if (!record) return { ok: false, reason: "invalid" };

  // Sabit zamanlı karşılaştırma: kayıt bulunduktan sonra bile hash
  // eşitliği zamanlama sızdırmamalı.
  const a = Buffer.from(record.codeHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }

  if (record.usedAt) return { ok: false, reason: "used" };
  if (new Date(record.expiresAt) <= now()) return { ok: false, reason: "expired" };

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(input.newPassword);
  } catch {
    // Parola politikası (en az 10 karakter) `hashPassword` içinde.
    return { ok: false, reason: "weak_password" };
  }

  const at = now().toISOString();
  // Sıra önemli: önce kodu tüket, sonra parolayı değiştir. Ters sırada
  // parola değişip kod tüketilmezse, aynı kod ikinci kez kullanılabilirdi.
  await store.markUsed(record.id, at);
  await store.applyNewPassword(record.userId, passwordHash, at);

  return { ok: true, userId: record.userId };
}
