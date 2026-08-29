/**
 * Rol → izin çözümü ve alan seviyesi maskeleme.
 *
 * KAELON'da yetki iki yerde uygulanır ve ikisi de gereklidir:
 *
 *  1. **Tool listesi filtresi** — kullanıcının izni yoksa tool modele HİÇ
 *     gönderilmez. Anayasa: "Kullanıcı göremiyorsa, KAELON da göremez."
 *     Bu, güvenlik sınırının birinci ve en güçlü katmanıdır: model olmayan
 *     bir şeyi çağıramaz.
 *  2. **Çağrı anında yeniden kontrol** — model listeyi görmese bile uydurabilir
 *     (halüsinasyon) veya istek elle imal edilebilir. Invoker her çağrıda izni
 *     yeniden doğrular.
 *
 * Tek katman yeterli değildir: (1) olmadan token israfı ve sızıntı riski,
 * (2) olmadan jailbreak yüzeyi doğar.
 */

import type { Permission, Principal, RoleId } from "./types.js";
import { ROLE_AUTHORITY_CEILING } from "./authority.js";
import type { AuthorityLevel } from "./types.js";

/**
 * Rol → izin matrisi. Ürün Mantığı Raporu §10 RBAC tablosunun kod karşılığı.
 * `*` yalnızca modül içinde joker: "finance:*" finance'ın tüm izinleri demektir.
 */
export const ROLE_PERMISSIONS: Record<RoleId, readonly Permission[]> = {
  patron: [
    "master-data:*",
    "documents:*",
    "finance:*",
    "accounting:*",
    "operations:*",
    "inventory:*",
    "maintenance:*",
    "hr:*",
    "sales:*",
    "quality:*",
    "approval:*",
  ],
  cfo: [
    "master-data:partner.read",
    "documents:invoice.read",
    "finance:*",
    "accounting:*",
    "operations:cost.read",
    "inventory:valuation.read",
    "sales:order.read",
    "approval:read",
    "approval:finance.submit",
  ],
  ik_muduru: [
    "master-data:employee.read",
    "hr:attendance.read",
    "hr:leave.read",
    "hr:overtime.read",
    "hr:payroll.read",
    "hr:termination.draft",
    "approval:read",
    "approval:hr.submit",
  ],
  uretim_muduru: [
    "master-data:item.read",
    "master-data:partner.read",
    "operations:*",
    // GÖREVLER AYRILIĞI (SoD): üretim müdürüne "quality:*" jokeri VERİLMEZ.
    // Üretimden sorumlu kişinin kendi kalite kapısını atlayabilmesi, sistemin
    // engellemesi gereken çıkar çatışmasının kendisidir. Kapı kararı verebilir
    // (release), ama kapıyı ATLAYAMAZ (override) — o yetki patrondadır.
    "quality:result.write",
    "quality:gate.release",
    "quality:hold.write",
    "inventory:stock.read",
    "inventory:movement.write",
    "inventory:adjustment.write",
    "maintenance:machine.read",
    "hr:attendance.department",
    // Departman mesai özeti görür; maaş alanı `redact` ile maskelenir
    // çünkü "hr:payroll.read" izni yoktur.
    "hr:overtime.read",
    "approval:read",
    "approval:operations.submit",
  ],
  satin_alma: [
    "master-data:partner.read",
    // Cari kartı açmak/güncellemek satın almanın işidir; tedarikçiyi tanıyan
    // ve listeyi elinde tutan roldür. Patron da yapabilir (joker izinle).
    "master-data:partner.write",
    "master-data:item.read",
    "documents:invoice.read",
    "documents:po.read",
    "documents:po.draft",
    "inventory:stock.read",
    "approval:read",
    "approval:procurement.submit",
  ],
  depo_sorumlusu: [
    "master-data:item.read",
    "inventory:stock.read",
    "inventory:movement.write",
    "documents:receipt.read",
    "operations:shipment.read",
  ],
  operator: [
    "operations:workorder.read",
    "operations:workorder.own",
    "quality:result.write",
    "hr:attendance.own",
  ],
};

/** Rollerden izin kümesi çözer. */
export function resolvePermissions(roles: readonly RoleId[]): ReadonlySet<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
  }
  return set;
}

/** Rollerden yetki tavanı çözer (en yükseği kazanır). */
export function resolveAuthorityCeiling(roles: readonly RoleId[]): AuthorityLevel {
  let ceiling: AuthorityLevel = 0;
  for (const role of roles) {
    const c = ROLE_AUTHORITY_CEILING[role] ?? 0;
    if (c > ceiling) ceiling = c as AuthorityLevel;
  }
  return ceiling;
}

/** Principal kurucu — izinler ve tavan her zaman rollerden türetilir. */
export function createPrincipal(input: {
  userId: string;
  tenantId: string;
  roles: readonly RoleId[];
  approvalLimit?: { amount: number; currency: string };
}): Principal {
  const base = {
    userId: input.userId,
    tenantId: input.tenantId,
    roles: [...input.roles],
    permissions: resolvePermissions(input.roles),
    maxAuthority: resolveAuthorityCeiling(input.roles),
  };
  return input.approvalLimit ? { ...base, approvalLimit: input.approvalLimit } : base;
}

/** Tek bir iznin karşılanıp karşılanmadığı (modül jokeri dahil). */
export function holds(principal: Principal, required: Permission): boolean {
  if (principal.permissions.has(required)) return true;
  const colon = required.indexOf(":");
  if (colon === -1) return false;
  const wildcard = `${required.slice(0, colon)}:*` as Permission;
  return principal.permissions.has(wildcard);
}

/** Karşılanmayan izinleri döndürür — boş dizi = yetkili. */
export function missingPermissions(
  principal: Principal,
  required: readonly Permission[],
): readonly Permission[] {
  return required.filter((p) => !holds(principal, p));
}

/**
 * Alan seviyesi maskeleme.
 *
 * Tool seviyesi izin "bu tool'u çağırabilir misin"i çözer; bazı durumlarda
 * aynı kaydın bazı alanları bazı rollere kapalıdır (örn. çalışan kartında
 * maaş yalnızca İK ve patrona açıktır). `redactFields` bunu uygular.
 */
export function redactFields<T extends Record<string, unknown>>(
  row: T,
  rules: readonly { field: keyof T & string; requires: Permission }[],
  principal: Principal,
): T {
  let out: T | null = null;
  for (const rule of rules) {
    if (!holds(principal, rule.requires) && rule.field in row) {
      out ??= { ...row };
      (out as Record<string, unknown>)[rule.field] = REDACTED;
    }
  }
  return out ?? row;
}

/** Maskelenmiş alanların yerine konan işaret — modele "yetkin yok" der. */
export const REDACTED = "[yetki dışı]" as const;
