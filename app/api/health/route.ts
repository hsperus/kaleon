/**
 * Sağlık kontrolü.
 *
 * YÜZEYSEL SAĞLIK KONTROLÜ YALAN SÖYLER. Yalnızca "sunucu ayakta" diyen bir
 * uç nokta, veritabanı düşmüşken de 200 döner; yük dengeleyici trafiği
 * bozuk sunucuya yollamaya devam eder. Bu yüzden gerçek bir sorgu atılır.
 *
 * İKİ AYRI SORU, İKİ AYRI CEVAP:
 *   /api/health        → hazır mıyım? (bağımlılıklar dahil)  200 / 503
 *   /api/health?live=1 → ayakta mıyım? (yalnızca süreç)      200
 * Canlılık kontrolü bağımlılıklara bakmaz: veritabanı geçici düşünce
 * konteyneri yeniden başlatmak sorunu çözmez, uzatır.
 */

import { sharedClient } from "../../../src/db/client.js";
import { checkEnv } from "../../../src/server/env.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STARTED_AT = Date.now();
/** Sağlık kontrolü asılı kalmamalı; kendi zaman aşımı var. */
const DB_TIMEOUT_MS = 3_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.searchParams.get("live") === "1") {
    return Response.json({ status: "live", uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000) });
  }

  const env = checkEnv(process.env);
  const db = await checkDatabase();

  const ok = db.ok && env.ok;
  return Response.json(
    {
      status: ok ? "ready" : "degraded",
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      checks: {
        database: db,
        // Ayrıntılı hata metni dışarı verilmez; sağlık uç noktası çoğu
        // kurulumda kimlik doğrulaması olmadan erişilebilirdir.
        env: { ok: env.ok, errorCount: env.errors.length, warningCount: env.warnings.length },
        model: { connected: Boolean(process.env["ANTHROPIC_API_KEY"]) },
      },
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    await Promise.race([
      sharedClient().$queryRawUnsafe("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${DB_TIMEOUT_MS} ms içinde yanıt yok`)), DB_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
  }
}
