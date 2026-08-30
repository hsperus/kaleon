/**
 * AI harcama raporu.
 *
 * "Ne kadar harcadım" sorusunun cevabı konsolda değil, kendi
 * defterimizde olmalıdır: konsol gecikmeli günceller ve tenant/kullanıcı
 * kırılımı vermez.
 */

import { sharedClient, disconnectAll } from "../db/client.js";
import { DEFAULT_BUDGET } from "../ai/ledger.js";

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main(): Promise<void> {
  const shared = sharedClient();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [total, byTenant, recent] = await Promise.all([
    shared.aiUsage.aggregate({
      where: { createdAt: { gte: from } },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    }),
    shared.aiUsage.groupBy({
      by: ["tenantId", "userId"],
      where: { createdAt: { gte: from } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    shared.aiUsage.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { createdAt: true, model: true, costUsd: true, inputTokens: true, outputTokens: true },
    }),
  ]);

  const spent = Number(total._sum.costUsd ?? 0);
  console.log(`\nBu ay (${from.toISOString().slice(0, 7)}) toplam: ${usd(spent)}`);
  console.log(`  ${total._count._all} çağrı · ${total._sum.inputTokens ?? 0} girdi · ${total._sum.outputTokens ?? 0} çıktı token`);
  console.log(
    `  Eşikler — uyarı ${usd(DEFAULT_BUDGET.warnUsd)} · yumuşak ${usd(DEFAULT_BUDGET.softCapUsd)} · TAVAN ${usd(DEFAULT_BUDGET.capUsd)} (kullanıcı başına)`,
  );

  if (byTenant.length > 0) {
    console.log("\nKullanıcı başına:");
    const tenants = await shared.tenant.findMany({ select: { id: true, slug: true } });
    const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));
    for (const r of byTenant.sort((a, b) => Number(b._sum.costUsd ?? 0) - Number(a._sum.costUsd ?? 0))) {
      const c = Number(r._sum.costUsd ?? 0);
      const overCap = c >= DEFAULT_BUDGET.capUsd ? "  ⛔ TAVAN DOLDU" : c >= DEFAULT_BUDGET.softCapUsd ? "  ⚠ yumuşak eşik" : "";
      console.log(
        `  ${(slugOf.get(r.tenantId) ?? r.tenantId).padEnd(10)} ${r.userId.slice(0, 8)}… ${usd(c).padStart(10)} (${r._count._all} çağrı)${overCap}`,
      );
    }
  }

  if (recent.length > 0) {
    console.log("\nSon çağrılar:");
    for (const r of recent) {
      console.log(
        `  ${r.createdAt.toISOString().slice(0, 19).replace("T", " ")}  ${usd(Number(r.costUsd)).padStart(10)}  ${r.inputTokens}→${r.outputTokens}  ${r.model}`,
      );
    }
  }
  console.log();
  await disconnectAll();
}

await main();
