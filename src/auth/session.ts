/**
 * Oturum yönetimi ve giriş akışı.
 *
 * DÖRT GÜVENLİK KARARI:
 *
 *  1. TOKEN VERİTABANINDA SAKLANMAZ — HASH'İ SAKLANIR.
 *     Veritabanı sızarsa saklanan değerlerle oturum açılamaz. Parolayı
 *     hash'leyip token'ı düz saklamak yaygın ve tutarsız bir hatadır:
 *     ikisi de aynı şeyi yapar, oturum açar.
 *
 *  2. KULLANICI NUMARALANDIRMASI ENGELLENİR.
 *     Var olmayan e-posta ile var olan e-posta aynı süreyi alır ve aynı
 *     mesajı döner. Aksi hâlde giriş formu bir kullanıcı listesi olur.
 *
 *  3. GİRİŞ DENEMESİ SINIRLIDIR.
 *     Hesap bazlı sayaç; eşik aşılınca kilitlenir. Sınırsız deneme, güçlü
 *     parola politikasını anlamsız kılar.
 *
 *  4. PRINCIPAL ROLLERDEN TÜRETİLİR, İSTEKTEN DEĞİL.
 *     Oturum yalnızca "kim" bilgisini taşır. Yetki, o kullanıcının o
 *     tenant'taki ÜYELİĞİNDEN okunur. İstemcinin gönderdiği hiçbir alan
 *     yetkiyi etkilemez.
 *
 * KAPSAM DIŞI (bilinçli, ve karışmasın diye yazılı):
 * parola sıfırlama akışı, e-posta doğrulama, OAuth/SSO, cihaz hatırlama.
 * Bunlar ayrı iş; burada yokluklarının bilinmesi gerekiyor.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createPrincipal } from "../kernel/rbac.js";
import type { Principal, RoleId } from "../kernel/types.js";
import { verifyPassword } from "./password.js";
import { verifyTotp } from "./totp.js";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string | null;
  readonly totpSecret: string | null;
  readonly isActive: boolean;
}

export interface MembershipRecord {
  readonly tenantId: string;
  readonly roles: readonly RoleId[];
  readonly isActive: boolean;
}

/** Kullanıcıya şirket seçtirmek için gereken en az bilgi. */
export interface TenantChoice {
  readonly tenantId: string;
  readonly name: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  findMembership(userId: string, tenantId: string): Promise<MembershipRecord | null>;
  /**
   * Kullanıcının etkin üyelikleri.
   *
   * ŞİRKET LİSTESİ GİRİŞ EKRANINDA GÖSTERİLMEZ: tüm tenant'ları listeleyen
   * bir açık uç nokta, müşteri listesini herkese verirdi. Seçim ancak parola
   * (ve varsa 2FA) doğrulandıktan SONRA, yalnızca o kullanıcının kendi
   * şirketleriyle sunulur.
   */
  listMemberships(userId: string): Promise<readonly (MembershipRecord & { name: string })[]>;
  createSession(input: Omit<SessionRecord, "revokedAt">): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(id: string, at: string): Promise<void>;
  /** Başarısız deneme sayacı. */
  failedAttempts(email: string): Promise<{ count: number; lockedUntil: string | null }>;
  recordFailure(email: string, at: string): Promise<void>;
  clearFailures(email: string): Promise<void>;
  /**
   * TOTP tekrar kullanım koruması. AYRI BİR ÇAĞRI olması bilinçlidir:
   * kullanıcı kaydının bir alanı olsaydı, o alanı doldurmayı unutan bir
   * adaptör korumayı sessizce kapatırdı — hata vermeden, testler geçerek.
   */
  lastTotpStep(userId: string): Promise<number | null>;
  recordTotpStep(userId: string, step: number): Promise<void>;
}

/** Token asla düz saklanmaz. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function issueToken(): string {
  return randomBytes(32).toString("base64url");
}

export type LoginResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
      readonly principal: Principal;
      readonly displayName: string;
      readonly tenantId: string;
    }
  /** Kimlik doğru ama kullanıcı birden çok şirkette — hangisi? */
  | { readonly ok: false; readonly reason: "tenant_choice"; readonly tenants: readonly TenantChoice[] }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_credentials"
        | "locked"
        | "totp_required"
        | "totp_invalid"
        | "no_membership";
    };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** Verilmezse tek üyelik otomatik seçilir, birden çoksa seçim istenir. */
  readonly tenantId?: string;
  readonly totpCode?: string;
  readonly now?: () => Date;
  readonly ip?: string;
  readonly userAgent?: string;
}

/** Kullanıcı yokken de gerçekçi süre harcamak için sahte hash. */
const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function login(store: AuthStore, input: LoginInput): Promise<LoginResult> {
  const now = input.now ?? (() => new Date());
  const email = input.email.trim().toLocaleLowerCase("tr");

  // ── Kilit kontrolü
  const attempts = await store.failedAttempts(email);
  if (attempts.lockedUntil && new Date(attempts.lockedUntil) > now()) {
    return { ok: false, reason: "locked" };
  }

  const user = await store.findUserByEmail(email);

  // ── KULLANICI NUMARALANDIRMA KORUMASI: kullanıcı yoksa da doğrulama
  //    yapılır, böylece süre farkı kullanıcı varlığını ele vermez.
  const hash = user?.passwordHash ?? DUMMY_HASH;
  const check = await verifyPassword(input.password, hash);

  if (!user || !user.isActive || !user.passwordHash || !check.valid) {
    await store.recordFailure(email, now().toISOString());
    return { ok: false, reason: "invalid_credentials" };
  }

  // ── İkinci faktör
  if (user.totpSecret) {
    if (!input.totpCode) return { ok: false, reason: "totp_required" };
    const totp = verifyTotp({
      secret: user.totpSecret,
      code: input.totpCode,
      now: now(),
      lastUsedStep: await store.lastTotpStep(user.id),
    });
    if (!totp.valid) {
      await store.recordFailure(email, now().toISOString());
      return { ok: false, reason: "totp_invalid" };
    }
    await store.recordTotpStep(user.id, totp.step);
  }

  // ── YETKİ ÜYELİKTEN GELİR, İSTEKTEN DEĞİL
  const usable = (await store.listMemberships(user.id)).filter(
    (m) => m.isActive && m.roles.length > 0,
  );
  if (usable.length === 0) {
    await store.recordFailure(email, now().toISOString());
    return { ok: false, reason: "no_membership" };
  }

  let membership: (MembershipRecord & { name: string }) | undefined;
  if (input.tenantId) {
    membership = usable.find((m) => m.tenantId === input.tenantId);
    // İstenen şirkette üyelik yok: kimlik doğru olsa da erişim yok.
    if (!membership) {
      await store.recordFailure(email, now().toISOString());
      return { ok: false, reason: "no_membership" };
    }
  } else if (usable.length === 1) {
    membership = usable[0]!;
  } else {
    // Parola doğrulandı; artık KENDİ şirketlerini görmesi güvenli.
    await store.clearFailures(email);
    return {
      ok: false,
      reason: "tenant_choice",
      tenants: usable.map((m) => ({ tenantId: m.tenantId, name: m.name })),
    };
  }

  await store.clearFailures(email);

  const token = issueToken();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS).toISOString();
  await store.createSession({
    id: crypto.randomUUID(),
    userId: user.id,
    tenantId: membership.tenantId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  return {
    ok: true,
    token,
    expiresAt,
    displayName: user.displayName,
    tenantId: membership.tenantId,
    principal: createPrincipal({
      userId: user.id,
      tenantId: membership.tenantId,
      roles: membership.roles,
    }),
  };
}

export type SessionResolution =
  | {
      readonly ok: true;
      readonly principal: Principal;
      readonly sessionId: string;
      readonly displayName: string;
    }
  | { readonly ok: false; readonly reason: "not_found" | "expired" | "revoked" | "no_membership" | "inactive" };

/** Token'dan principal çözer. Her istekte çağrılır. */
export async function resolveSession(
  store: AuthStore,
  token: string,
  now: () => Date = () => new Date(),
): Promise<SessionResolution> {
  const session = await store.findSessionByHash(hashToken(token));
  if (!session) return { ok: false, reason: "not_found" };
  if (session.revokedAt) return { ok: false, reason: "revoked" };
  if (new Date(session.expiresAt) <= now()) return { ok: false, reason: "expired" };

  const user = await store.findUserById(session.userId);
  if (!user || !user.isActive) return { ok: false, reason: "inactive" };

  // Yetki HER İSTEKTE üyelikten yeniden okunur. Rolü alınan bir kullanıcının
  // eski oturumu, eski yetkiyle çalışmaya devam etmemelidir.
  const membership = await store.findMembership(session.userId, session.tenantId);
  if (!membership || !membership.isActive || membership.roles.length === 0) {
    return { ok: false, reason: "no_membership" };
  }

  return {
    ok: true,
    sessionId: session.id,
    displayName: user.displayName,
    principal: createPrincipal({
      userId: user.id,
      tenantId: session.tenantId,
      roles: membership.roles,
    }),
  };
}

/** Sabit zamanlı token karşılaştırması gereken yerler için. */
export function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
