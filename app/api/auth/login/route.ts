/**
 * Giriş uç noktası.
 *
 * CEVAP TASARIMI BİLİNÇLİDİR: hatalı kimlik bilgisinde tek bir genel mesaj
 * döner. "Kullanıcı bulunamadı" ile "parola yanlış" ayrımı, saldırgana
 * hangi e-postaların kayıtlı olduğunu söyler. Tek istisna `totp_required`:
 * bu bilgi zaten parolayı doğru bilen birine veriliyor.
 */

import { z } from "zod";
import { login } from "../../../../src/auth/session.js";
import { FixedWindowThrottle, LOGIN_THROTTLE } from "../../../../src/auth/throttle.js";
import { authStore, sessionCookie } from "../../../../src/server/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
  tenantId: z.string().min(1).max(64),
  totpCode: z.string().max(16).optional(),
});

const throttle = new FixedWindowThrottle(LOGIN_THROTTLE);

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const gate = throttle.check(clientIp(req));
  if (!gate.allowed) {
    return Response.json(
      { error: "Çok fazla deneme. Lütfen biraz bekleyin." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) } },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Geçersiz istek." }, { status: 400 });
  }

  const ua = req.headers.get("user-agent");
  const result = await login(authStore(), {
    email: parsed.data.email,
    password: parsed.data.password,
    tenantId: parsed.data.tenantId,
    ...(parsed.data.totpCode ? { totpCode: parsed.data.totpCode } : {}),
    ip: clientIp(req),
    ...(ua ? { userAgent: ua } : {}),
  });

  if (!result.ok) {
    if (result.reason === "totp_required") {
      return Response.json({ error: "totp_required" }, { status: 401 });
    }
    if (result.reason === "locked") {
      return Response.json(
        { error: "Hesap geçici olarak kilitlendi. Lütfen daha sonra deneyin." },
        { status: 423 },
      );
    }
    // invalid_credentials, totp_invalid ve no_membership AYNI cevabı verir.
    return Response.json({ error: "E-posta veya parola hatalı." }, { status: 401 });
  }

  return Response.json(
    {
      user: { id: result.principal.userId, roles: result.principal.roles },
      expiresAt: result.expiresAt,
    },
    { status: 200, headers: { "Set-Cookie": sessionCookie(result.token, result.expiresAt) } },
  );
}
