/**
 * İçerik Güvenlik Politikası (CSP) — nonce tabanlı.
 *
 * NEDEN `unsafe-inline` DEĞİL:
 * KAELON'un ekranında maaş, banka bakiyesi ve sözleşme cezası var. Script
 * için `unsafe-inline` açmak, tek bir XSS'in bunların hepsini dışarı
 * taşıyabilmesi demektir. En kolay yol oydu; doğru yol bu.
 *
 * NEDEN MIDDLEWARE:
 * Next.js kendi önyükleme script'lerini satır içi gömer. Nonce her istekte
 * YENİDEN üretilmelidir — sabit bir nonce, nonce olmamakla aynı şeydir.
 * Statik bir başlık dosyası bunu yapamaz; middleware her istekte çalışır.
 * Next.js, istek başlığındaki CSP'den nonce'u okuyup kendi script'lerine
 * uygular; bizim ayrıca bir şey yapmamız gerekmez.
 *
 * `strict-dynamic`: nonce'lu bir script'in yüklediği script'ler de güvenilir
 * sayılır. Next.js'in parça parça yüklenen bundle'ları ancak böyle çalışır.
 *
 * Geliştirmede `unsafe-eval` açıktır (HMR onsuz çalışmaz), üretimde KAPALI.
 * Geliştirme kolaylığı üretim güvenliğine sızmaz.
 */

import { NextResponse, type NextRequest } from "next/server";

const isProd = process.env.NODE_ENV === "production";

export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    // Stil için satır içi kaçınılmaz: Next.js kritik CSS'i gömer. Asıl
    // tehlike script'tir ve orada taviz yok.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Geliştirmede HMR WebSocket'i gerekir.
    isProd ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Clickjacking: KAELON hiçbir sitenin içine gömülemez.
    "frame-ancestors 'none'",
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  // Next.js nonce'u İSTEK başlığındaki CSP'den okur.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Statik varlıklar hariç her istek. Onlar script çalıştırmaz ve her
     * birine nonce üretmek boşuna iş olur.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
