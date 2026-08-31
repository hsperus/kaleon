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
      const available = rows.reduce((s, r) => s + r.available, 0);
      /*
       * TOPLAM DA DÖNÜYOR, YALNIZCA SATIRLAR DEĞİL.
       *
       * "Kasada ne kadar var" sorusunun cevabı toplamdır ama tool
       * yalnızca hesap satırlarını döndürüyordu; toplamı çıkarmak
       * çağırana kalıyordu.
       *
       * Bunun bedeli somut çıktı: "banka bakiyesi 50 milyonun altına
       * düşerse bildir" izlemesi `totalAvailable` alanını izliyordu ve
       * o alan YOKTU. İzleme sessizce hiç çalışmadı — kullanıcı
       * korunduğunu sanarken.
       *
       * Bir alanın var olmaması, onu izleyen kuralın da olmaması
       * demektir; ve olmayan bir koruma, en çok güvenildiği anda
       * yoktur.
       */
      return {
        ok: true,
        data: {
          accounts: rows,
          totalAvailable: Math.round(available * 100) / 100,
          totalBlocked: Math.round(blocked * 100) / 100,
          accountCount: rows.length,
        },
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
