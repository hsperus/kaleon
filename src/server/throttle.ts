/**
 * Sunucu tarafı istek sınırları.
 *
 * Model çağrısı PARA HARCAR. Bütçe kapısı aylık toplamı korur ama tek bir
 * kullanıcının dakikada yüz soru sorması, kapı devreye girmeden önce hem
 * maliyeti hem gecikmeyi patlatır. Bu sınır o boşluğu kapatır.
 *
 * SINIR KULLANICI BAZINDA, IP BAZINDA DEĞİL: aynı fabrikadaki herkes tek bir
 * NAT arkasından çıkar; IP sınırı bütün vardiyayı birlikte cezalandırırdı.
 * Giriş uç noktası bunun tersini yapar (orada kullanıcı henüz belli değildir).
 */

import { FixedWindowThrottle } from "../auth/throttle.js";

/** Kullanıcı başına dakikada 20 soru — normal kullanımın çok üstünde. */
export const askThrottle = new FixedWindowThrottle({ limit: 20, windowMs: 60_000 });

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}
