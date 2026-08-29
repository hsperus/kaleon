/**
 * Kullanıcı yönetimi — sunucu tarafı.
 *
 * ÜÇ KAPI, HER İŞLEMDE:
 *
 *  1. YETKİ. `admin:user.manage` yoksa hiçbir şey. Bu izin yalnızca
 *     patrondadır ve joker DEĞİLDİR — yetkiyi kendi kendine yükseltebilen
 *     bir rol, rol sistemini anlamsız kılar.
 *
 *  2. KİRACI SINIRI. Yönetici YALNIZCA kendi tenant'ındaki kullanıcıları
 *     görür ve değiştirir. Kullanıcı tablosu kontrol düzlemindedir ve tüm
 *     tenant'ları kapsar; sorguya üyelik koşulu konmazsa bir patron başka
 *     bir şirketin kullanıcılarını yönetebilirdi. En pahalı çok kiracılı
 *     hata sınıfı budur.
 *
 *  3. KENDİ AYAĞINA SIKMA KORUMASI. Yönetici kendi patron rolünü alamaz,
 *     kendini pasifleştiremez. Sistemde patronsuz kalan bir tenant, artık
 *     kimsenin kullanıcı ekleyemediği bir tenant'tır.
 */

import { sharedClient } from "../db/client.js";
import { PrismaAuthStore } from "../db/auth-store.js";
import { holds, ROLE_PERMISSIONS } from "../kernel/rbac.js";
import type { Principal, RoleId } from "../kernel/types.js";
import { issueResetCode } from "../auth/password-reset.js";
import { generateSecret, otpauthUri } from "../auth/totp.js";
import { hashPassword } from "../auth/password.js";
import { log } from "./log.js";

export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminError";
  }
}

function assertAdmin(principal: Principal): void {
  if (!holds(principal, "admin:user.manage")) {
    throw new AdminError("Kullanıcı yönetimi yetkiniz yok.");
  }
}

/** Hedef kullanıcının BU tenant'ta üyeliği var mı? */
async function assertSameTenant(tenantId: string, userId: string): Promise<void> {
  const membership = await sharedClient().membership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: { id: true },
  });
  // "Bulunamadı" denir, "başka tenant'ta" denmez: bir kullanıcının başka
  // bir şirkette var olduğunu doğrulamak da bilgidir.
  if (!membership) throw new AdminError("Kullanıcı bulunamadı.");
}

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly isActive: boolean;
  readonly membershipActive: boolean;
  readonly twoFactor: boolean;
  readonly activeSessions: number;
  readonly createdAt: string;
}

export async function listUsers(
  principal: Principal,
  tenantId: string,
): Promise<readonly AdminUser[]> {
  assertAdmin(principal);

  const rows = await sharedClient().membership.findMany({
    where: { tenantId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          isActive: true,
          totpSecret: true,
          createdAt: true,
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: new Date() } },
            select: { id: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  return rows.map((m) => ({
    id: m.user.id,
    email: m.user.email,
    displayName: m.user.displayName,
    roles: m.roles,
    isActive: m.user.isActive,
    membershipActive: m.isActive,
    // Sırrın KENDİSİ değil, VARLIĞI döner. 2FA sırrı bir kez gösterilir
    // (kurulum anında) ve bir daha asla — listede taşımak, listeyi gören
    // herkese herkesin ikinci faktörünü vermek olurdu.
    twoFactor: m.user.totpSecret !== null,
    activeSessions: m.user.sessions.length,
    createdAt: m.user.createdAt.toISOString(),
  }));
}

export const ASSIGNABLE_ROLES = Object.keys(ROLE_PERMISSIONS) as readonly RoleId[];

export async function createUser(
  principal: Principal,
  tenantId: string,
  input: { email: string; displayName: string; roles: readonly string[] },
): Promise<{ userId: string; resetCode: string }> {
  assertAdmin(principal);

  const email = input.email.trim().toLocaleLowerCase("tr");
  const roles = validateRoles(input.roles);
  const db = sharedClient();

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    const already = await db.membership.findUnique({
      where: { userId_tenantId: { userId: existing.id, tenantId } },
      select: { id: true },
    });
    if (already) throw new AdminError("Bu e-posta bu şirkette zaten kayıtlı.");
  }

  /**
   * PAROLA YÖNETİCİ TARAFINDAN BELİRLENMEZ.
   *
   * Yöneticinin kullanıcı için parola yazması, o parolanın yönetici
   * tarafından bilinmesi demektir — ve çoğu yönetici herkese aynı parolayı
   * verir. Bunun yerine hesap rastgele bir parolayla açılır ve kullanıcı
   * tek kullanımlık kodla kendi parolasını belirler.
   */
  const throwaway = await hashPassword(crypto.randomUUID() + crypto.randomUUID());

  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { isActive: true } })
    : await db.user.create({
        data: { email, displayName: input.displayName.trim(), passwordHash: throwaway },
      });

  await db.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId } },
    create: { userId: user.id, tenantId, roles: [...roles] },
    update: { roles: [...roles], isActive: true },
  });

  const { code } = await issueResetCode(new PrismaAuthStore(db), {
    userId: user.id,
    issuedBy: principal.userId,
  });

  log.info("kullanıcı oluşturuldu", {
    tenantId,
    userId: user.id,
    by: principal.userId,
    roles: roles.join(","),
  });
  return { userId: user.id, resetCode: code };
}

function validateRoles(roles: readonly string[]): readonly RoleId[] {
  if (roles.length === 0) throw new AdminError("En az bir rol seçilmeli.");
  const unknown = roles.filter((r) => !(r in ROLE_PERMISSIONS));
  if (unknown.length > 0) throw new AdminError(`Bilinmeyen rol: ${unknown.join(", ")}`);
  return roles as readonly RoleId[];
}

export async function setRoles(
  principal: Principal,
  tenantId: string,
  input: { userId: string; roles: readonly string[] },
): Promise<void> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, input.userId);
  const roles = validateRoles(input.roles);

  // KENDİ PATRON ROLÜNÜ ALAMAZ. Patronsuz kalan bir tenant, artık kimsenin
  // kullanıcı ekleyemediği bir tenant'tır — ve bunu geri almak için
  // veritabanına elle girmek gerekir.
  if (input.userId === principal.userId && !roles.includes("patron")) {
    throw new AdminError("Kendi patron rolünüzü kaldıramazsınız.");
  }

  await sharedClient().membership.update({
    where: { userId_tenantId: { userId: input.userId, tenantId } },
    data: { roles: [...roles] },
  });
  log.info("roller değiştirildi", { tenantId, userId: input.userId, by: principal.userId });
}

export async function setActive(
  principal: Principal,
  tenantId: string,
  input: { userId: string; active: boolean },
): Promise<void> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, input.userId);

  if (input.userId === principal.userId && !input.active) {
    throw new AdminError("Kendinizi pasifleştiremezsiniz.");
  }

  const db = sharedClient();
  // Üyelik pasifleştirilir, KULLANICI DEĞİL: aynı kişi başka bir şirkette
  // çalışmaya devam ediyor olabilir. Kullanıcıyı komple kapatmak, bir
  // şirketten çıkışın diğerini de kesmesi demektir.
  await db.membership.update({
    where: { userId_tenantId: { userId: input.userId, tenantId } },
    data: { isActive: input.active },
  });

  if (!input.active) {
    // Pasifleştirme ANINDA etkili olmalı: açık oturumlar düşürülür.
    await new PrismaAuthStore(db).revokeAllForUser(input.userId, new Date().toISOString());
  }
  log.info("üyelik durumu değişti", {
    tenantId,
    userId: input.userId,
    active: input.active,
    by: principal.userId,
  });
}

export async function issueReset(
  principal: Principal,
  tenantId: string,
  userId: string,
): Promise<{ code: string; expiresAt: string }> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, userId);
  const result = await issueResetCode(new PrismaAuthStore(sharedClient()), {
    userId,
    issuedBy: principal.userId,
  });
  log.info("parola sıfırlama kodu üretildi", { tenantId, userId, by: principal.userId });
  return result;
}

export async function revokeSessions(
  principal: Principal,
  tenantId: string,
  userId: string,
): Promise<{ revoked: number }> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, userId);
  const revoked = await new PrismaAuthStore(sharedClient()).revokeAllForUser(
    userId,
    new Date().toISOString(),
  );
  log.info("oturumlar düşürüldü", { tenantId, userId, revoked, by: principal.userId });
  return { revoked };
}

export async function enableTwoFactor(
  principal: Principal,
  tenantId: string,
  userId: string,
): Promise<{ secret: string; uri: string }> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, userId);

  const db = sharedClient();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const secret = generateSecret();

  // `lastTotpStep` sıfırlanır: eski sırla üretilmiş bir adım kaydı, yeni
  // sırın ilk kodunu "tekrar kullanılmış" sayıp reddedebilirdi.
  await db.user.update({ where: { id: userId }, data: { totpSecret: secret, lastTotpStep: null } });

  log.info("2FA açıldı", { tenantId, userId, by: principal.userId });
  // Sır YALNIZCA BU CEVAPTA döner ve bir daha okunamaz.
  return { secret, uri: otpauthUri({ secret, account: user.email, issuer: "KAELON" }) };
}

export async function disableTwoFactor(
  principal: Principal,
  tenantId: string,
  userId: string,
): Promise<void> {
  assertAdmin(principal);
  await assertSameTenant(tenantId, userId);
  await sharedClient().user.update({
    where: { id: userId },
    data: { totpSecret: null, lastTotpStep: null },
  });
  log.warn("2FA kapatıldı", { tenantId, userId, by: principal.userId });
}
