/**
 * Finance Core tool'ları.
 *
 * Bu modül RBAC sınırını kanıtlar: `get_bank_balance` CFO ve patronda görünür,
 * üretim müdürü ve depo sorumlusunda tool listesine HİÇ girmez.
 */

import { z } from "zod";
import { caveatRisks, confidenceWithCaveats } from "../../data/caveats.js";
import { defineTool } from "../../kernel/tool.js";
import type { DataSource } from "../../data/port.js";

export function financeTools(db: DataSource) {
  const getBankBalance = defineTool({
    name: "get_bank_balance",
    module: "finance",
    authority: 0,
    deferLoading: false,
    description: {
      tr: "Banka hesap bakiyelerini döndürür; para birimine göre filtrelenebilir. Kullanılabilir ve blokeli tutarları ayrı verir. 'Kasada ne kadar var', 'Euro bakiyesi', 'nakit pozisyonu' sorularında kullan.",
      en: "Bank account balances with available and blocked amounts, optionally filtered by currency.",
    },
    input: z.strictObject({
      currency: z
        .string()
        .length(3)
        .nullable()
        .describe("ISO para birimi kodu (TRY, EUR, USD). Tümü için null gönder."),
    }),
    requires: ["finance:bank.read"],
    async execute(input, ctx) {
      const { rows, freshness, caveats } = await db.bankBalances(ctx.tenant.tenantId, input.currency);
      const blocked = rows.reduce((s, r) => s + r.blocked, 0);
      return {
        ok: true,
        data: rows,
        sources: [
          { system: "Banka entegratörü", kind: "integrator", recordCount: rows.length, syncedAt: freshness.syncedAt },
        ],
        risks: [
          ...(blocked > 0
            ? [
                {
                  severity: "info" as const,
                  message: `Toplam ${blocked.toLocaleString("tr-TR")} blokeli bakiye var; kullanılabilir tutara dahil değil.`,
                },
              ]
            : []),
          ...caveatRisks(caveats),
        ],
        confidence: confidenceWithCaveats(95, caveats),
      };
    },
  });

  return [getBankBalance] as const;
}
