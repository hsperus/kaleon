/**
 * Parola sıfırlama — kodu kullanma adımı.
 *
 * HATA SEBEPLERİ AYRILMAZ. "Kod geçersiz", "süresi dolmuş", "kullanılmış"
 * için tek cevap döner: ayrım, saldırgana kod denemesinde ne kadar
 * yaklaştığını söyler. Tek istisna zayıf paroladır — o kullanıcının
 * düzeltebileceği bir şeydir ve söylenmezse ne yapacağını bilemez.
 */

import { z } from "zod";
import { redeemResetCode } from "../../../../src/auth/password-reset.js";
import { authStore } from "../../../../src/server/auth.js";
import { FixedWindowThrottle } from "../../../../src/auth/throttle.js";
import { log } from "../../../../src/server/log.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().min(6).max(32),
  newPassword: z.string().min(1).max(1024),
});

/** Kod deneme sınırı: 10 sütunlu alfabede 10 hane, kaba kuvvet zaten zor —
 *  ama sınırsız deneme onu mümkün kılar. */
const throttle = new FixedWindowThrottle({ limit: 8, windowMs: 10 * 60 * 1000 });

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

  const result = await redeemResetCode(authStore(), parsed.data);

  if (!result.ok) {
    if (result.reason === "weak_password") {
      return Response.json(
        { error: "Parola en az 10 karakter olmalıdır." },
        { status: 400 },
      );
    }
    // invalid | expired | used → aynı cevap.
    return Response.json(
      { error: "Kod geçersiz veya süresi dolmuş. Yöneticinizden yeni kod isteyin." },
      { status: 400 },
    );
  }

  log.info("parola sıfırlandı", { userId: result.userId, route: "/api/auth/reset" });
  return Response.json({ ok: true });
}
