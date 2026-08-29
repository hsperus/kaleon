/**
 * Çıkış — oturum SUNUCUDA iptal edilir, sadece çerez silinmez.
 *
 * Yalnızca çerezi silmek, çalınmış bir token'ı hâlâ geçerli bırakır.
 * Kaydın `revoked_at` alanı, tarayıcı ne yaparsa yapsın o token'ı öldürür.
 */

import { authStore, clearedSessionCookie, readCookie, SESSION_COOKIE } from "../../../../src/server/auth.js";
import { hashToken } from "../../../../src/auth/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const store = authStore();
    const session = await store.findSessionByHash(hashToken(token)).catch(() => null);
    if (session) await store.revokeSession(session.id, new Date().toISOString());
  }
  return Response.json(
    { ok: true },
    { status: 200, headers: { "Set-Cookie": clearedSessionCookie() } },
  );
}
