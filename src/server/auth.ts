/**
 * İstekten kimlik çözümleme.
 *
 * BURADA İKİ AYRI YOL VAR VE KARIŞTIRILMAMALARI ÖNEMLİ:
 *
 *  A. GERÇEK OTURUM — çerezdeki token, veritabanındaki oturum kaydına
 *     çözülür; roller o kullanıcının o tenant'taki üyeliğinden okunur.
 *     Üretimde YALNIZCA bu yol vardır.
 *
 *  B. GELİŞTİRME ROLÜ — `x-kaelon-dev-role` başlığı. Demo verisiyle rol
 *     davranışını göstermek için var. `NODE_ENV=production` olduğunda bu
 *     kod yolu ÇALIŞMAZ; açan bir bayrak da yoktur. Bayrak olsaydı, bir gün
 *     biri onu üretimde açardı.
 *
 * Çerez ayarları: HttpOnly (JavaScript okuyamaz — XSS token çalamaz),
 * SameSite=Lax (CSRF'e karşı temel koruma), Secure (üretimde yalnız HTTPS).
 */

import { PrismaAuthStore } from "../db/auth-store.js";
import { sharedClient } from "../db/client.js";
import { resolveSession, type AuthStore } from "../auth/session.js";
import type { Principal } from "../kernel/types.js";

export const SESSION_COOKIE = "kaelon_session";
const IS_PROD = process.env["NODE_ENV"] === "production";

let storeSingleton: AuthStore | null = null;

export function authStore(): PrismaAuthStore {
  storeSingleton ??= new PrismaAuthStore(sharedClient());
  return storeSingleton as PrismaAuthStore;
}

/** Test ve özel kurulum için store'u değiştirir. */
export function setAuthStore(store: PrismaAuthStore): void {
  storeSingleton = store;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (IS_PROD) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (IS_PROD) parts.push("Secure");
  return parts.join("; ");
}

export interface AuthenticatedIdentity {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly source: "session";
}

/**
 * Çerezdeki oturumu principal'a çevirir. Oturum yoksa/geçersizse `null`.
 * Veritabanına ulaşılamıyorsa da `null` döner — bu bilinçlidir: kimlik
 * çözülemediğinde istek KİMLİKSİZ sayılır, "herhalde geçerlidir" denmez.
 */
export async function principalFromSession(req: Request): Promise<AuthenticatedIdentity | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const result = await resolveSession(authStore(), token);
    if (!result.ok) return null;
    return { principal: result.principal, sessionId: result.sessionId, source: "session" };
  } catch {
    return null;
  }
}
