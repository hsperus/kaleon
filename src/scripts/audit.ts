/**
 * Denetim kaydı sorgulama.
 *
 * DENETİM KAYDININ DEĞERİ OKUNABİLMESİNDEDİR.
 * Kayıt yazılıyordu, veritabanı seviyesinde değiştirilemez hâle
 * getirilmişti — ama onu okuyacak hiçbir araç yoktu. Vergi denetiminde,
 * bir iç soruşturmada veya "bu stok düzeltmesini kim yaptı" sorusunda
 * elimizde yalnızca psql vardı. Yazılan ama okunamayan bir kayıt,
 * mevzuata karşı bir belge değil, sadece disk tüketimidir.
 *
 *   npm run audit -- <tenant-slug> [--user <uuid>] [--tool <ad>]
 *                                  [--from 2026-05-01] [--to 2026-05-31]
 *                                  [--failed] [--writes] [--limit 50]
 *
 * ÇIKTI SATIR BAZLI: grep, awk ve tablo görüntüleyicilerle çalışsın diye.
 * Denetçi Excel'e yapıştırır; geliştirici grep'ler.
 */

import { sharedClient, tenantClient, disconnectAll } from "../db/client.js";

interface Filters {
  readonly userId?: string;
  readonly tool?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly onlyFailed: boolean;
  readonly onlyWrites: boolean;
  readonly limit: number;
}

function parseArgs(argv: readonly string[]): { slug: string; filters: Filters } | null {
  const [slug, ...rest] = argv;
  if (!slug || slug.startsWith("--")) return null;

  const get = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i === -1 ? undefined : rest[i + 1];
  };

  const from = get("--from");
  const to = get("--to");
  const limitRaw = get("--limit");

  return {
    slug,
    filters: {
      ...(get("--user") ? { userId: get("--user")! } : {}),
      ...(get("--tool") ? { tool: get("--tool")! } : {}),
      ...(from ? { from: new Date(from) } : {}),
      // Bitiş tarihi GÜNÜN SONUNU kapsar: "--to 2026-05-31" diyen kişi
      // 31 Mayıs'ı dışarıda bırakmayı kastetmez.
      ...(to ? { to: new Date(`${to}T23:59:59.999Z`) } : {}),
      onlyFailed: rest.includes("--failed"),
      onlyWrites: rest.includes("--writes"),
      limit: limitRaw ? Math.min(Number(limitRaw), 1000) : 50,
    },
  };
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.log(
      [
        "Kullanım:",
        "  npm run audit -- <tenant-slug> [seçenekler]",
        "",
        "Seçenekler:",
        "  --user <uuid>     yalnızca bu kullanıcının işlemleri",
        "  --tool <ad>       yalnızca bu tool",
        "  --from <YYYY-AA-GG>",
        "  --to   <YYYY-AA-GG>",
        "  --failed          yalnızca başarısız/reddedilen çağrılar",
        "  --writes          yalnızca yetki seviyesi 1+ (veri değiştirenler)",
        "  --limit <n>       varsayılan 50, en fazla 1000",
      ].join("\n"),
    );
    return;
  }

  const { slug, filters } = parsed;
  const shared = sharedClient();
  const tenant = await shared.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant yok: ${slug}`);
    process.exitCode = 1;
    return;
  }

  const db = tenantClient(tenant.schemaName);
  const rows = await db.auditEntry.findMany({
    where: {
      ...(filters.userId ? { userId: filters.userId } : {}),
      ...(filters.tool ? { toolName: filters.tool } : {}),
      // Sonuç değerleri: success | denied | invalid | failed (kernel/audit.ts)
      ...(filters.onlyFailed ? { outcome: { not: "success" } } : {}),
      ...(filters.onlyWrites ? { authority: { gt: 0 } } : {}),
      ...(filters.from || filters.to
        ? {
            at: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { at: "desc" },
    take: filters.limit,
  });

  if (rows.length === 0) {
    console.log("Kayıt bulunamadı.");
    await disconnectAll();
    return;
  }

  console.log("");
  console.log(
    [
      pad("ZAMAN", 20),
      pad("KULLANICI", 10),
      pad("ROL", 14),
      pad("TOOL", 26),
      pad("L", 2),
      pad("SONUÇ", 9),
      pad("SÜRE", 7),
      "KORELASYON",
    ].join(" "),
  );
  console.log("─".repeat(110));

  for (const r of rows) {
    console.log(
      [
        pad(r.at.toLocaleString("tr-TR"), 20),
        // Tam UUID satırı okunmaz yapar; ilk 8 hane ayırt etmeye yeter ve
        // tam değeri --user ile aramak için zaten elde olur.
        pad(r.userId.slice(0, 8), 10),
        pad((r.roles ?? []).join(","), 14),
        pad(r.toolName, 26),
        pad(String(r.authority), 2),
        pad(r.outcome === "success" ? "başarılı" : (r.errorCode ?? r.outcome), 9),
        pad(`${r.durationMs}ms`, 7),
        r.correlationId.slice(0, 8),
      ].join(" "),
    );
  }

  // Özet, denetçinin ilk bakacağı şey: kaç işlem, kaçı reddedildi.
  const failed = rows.filter((r) => r.outcome !== "success").length;
  const writes = rows.filter((r) => r.authority > 0).length;
  console.log("─".repeat(110));
  console.log(
    `${rows.length} kayıt · ${writes} veri değiştiren · ${failed} başarısız/reddedilen` +
      (rows.length === filters.limit ? `  ⚠ sınıra dayanıldı, daha eski kayıtlar var` : ""),
  );
  console.log("");

  await disconnectAll();
}

await main();
