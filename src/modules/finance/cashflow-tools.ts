/**
 * Nakit akışı ve ödeme koşusu tool'ları.
 *
 * ÜÇ SORUYA CEVAP VERİRLER, VE ÜÇÜ DE SİSTEMDE CEVAPSIZDI:
 *   1. Önümüzdeki haftalarda nakit sıkışır mıyız?   → project_cash_flow
 *   2. Elimizdeki parayla kime ödeyelim?            → plan_payment_run
 *   3. Bu faturanın vadesi ne?                      → set_payable_due_date
 *
 * Üçüncüsü ilk ikisinin ön şartıdır: vade girilmemişse fatura ne
 * projeksiyona ne sıraya girer, ve bunu söyleyen bir yol olmalıdır.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { projectCashFlow, type CashItem } from "./cashflow.js";
import { planPaymentRun } from "./payment-run.js";
import type { CashFlowRepository, OpenDocument } from "../../db/cashflow-repository.js";
import type { DataSource } from "../../data/port.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

/** Projeksiyona giren kalem — belge tipinden bağımsız sade biçim. */
function kalem(d: OpenDocument): CashItem {
  return {
    documentNo: d.documentNo,
    partnerName: d.partnerName,
    amount: d.openAmount,
    dueDate: d.dueDate,
  };
}

/** Yalnızca bu para birimindeki belgeler; gerisi çağıranda raporlanır. */
function ayni(rows: readonly OpenDocument[], currency: string): readonly OpenDocument[] {
  return rows.filter((r) => r.currency.toUpperCase() === currency.toUpperCase());
}

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

export function cashFlowTools(repo: CashFlowRepository, source: DataSource) {
  /**
   * Eldeki nakit. Kullanıcı vermezse banka entegratöründen okunur;
   * ikisi de yoksa TAHMİN EDİLMEZ — açıkça reddedilir.
   */
  async function nakit(
    tenantId: string,
    verilen: number | null,
    currency: string,
  ): Promise<number> {
    if (verilen !== null) return verilen;
    const { rows } = await source.bankBalances(tenantId, currency);
    if (rows.length === 0) {
      throw new BusinessRuleError(
        `${currency} banka bakiyesi okunamadı ve elde nakit verilmedi. ` +
          "Projeksiyonun her satırı açılış bakiyesine dayanır; bilinmeyen bir " +
          "açılışı sıfır saymak tüm tabloyu yanlış yapar. `openingCash` alanına " +
          "güncel nakdi girin.",
        "opening_cash_unknown",
      );
    }
    return Math.round(rows.reduce((s, r) => s + r.available, 0) * 100) / 100;
  }

  const project = defineTool({
    name: "project_cash_flow",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Haftalık nakit akış projeksiyonu çıkarır: her hafta ne kadar tahsilat, " +
        "ne kadar ödeme, hafta sonunda ne kadar nakit kalıyor ve nakit ilk hangi " +
        "hafta eksiye düşüyor. 'Nakit sıkışır mıyız', 'önümüzdeki ay nakit " +
        "durumumuz', 'nakit akış tablosu', 'para yeter mi' sorularında kullan. " +
        "Vadesi geçmiş ALACAK projeksiyona dahil EDİLMEZ (gelmemiş paradır); " +
        "vadesi geçmiş BORÇ ilk haftaya yazılır. Vadesi bilinmeyen belgeler ayrı " +
        "raporlanır. Her koşu TEK PARA BİRİMİDİR: TL akışı ile USD akışı ayrı " +
        "sorulur, aralarına kur konmaz.",
      en: "Weekly cash flow projection with shortfall week detection.",
    },
    input: z.strictObject({
      weeks: z
        .number()
        .int()
        .min(1)
        .max(52)
        .describe("Kaç hafta ileriye bakılsın. Aylık soru için 4-5, çeyrek için 13."),
      currency: z
        .string()
        .length(3)
        .describe(
          "Para birimi (TRY, USD, EUR). Kullanıcı belirtmediyse TRY gönder. " +
            "Diğer para birimlerindeki belgeler bu tabloya GİRMEZ, ayrı raporlanır.",
        ),
      openingCash: z
        .number()
        .nullable()
        .describe("Eldeki nakit, seçilen para biriminde. null: banka bakiyesinden okunur."),
    }),
    requires: ["finance:bank.read"],
    async execute(input, ctx) {
      const para = input.currency.toUpperCase();
      const acilis = await nakit(ctx.tenant.tenantId, input.openingCash, para);
      const [alacak, borc] = await Promise.all([repo.openReceivables(), repo.openPayables()]);

      /*
       * BLOKE FATURA NAKİT ÇIKIŞIDIR.
       *
       * Ödeme koşusu onu önermez (fark çözülmeden ödenmemeli), ama
       * projeksiyon onu çıkarırsa nakit olduğundan bol görünür. Bloke
       * bir borç ödenmeyecek borç değildir; geciktirilecek borçtur.
       */
      const p = projectCashFlow(
        ctx.now(),
        acilis,
        ayni(alacak.rows, para).map(kalem),
        ayni(borc.rows, para).map(kalem),
        input.weeks,
      );

      const yabanciAlacak = alacak.rows.length - ayni(alacak.rows, para).length;
      const yabanciBorc = borc.rows.length - ayni(borc.rows, para).length;

      const riskler: { severity: "warning" | "info"; message: string }[] = [];

      if (p.shortfallWeek !== null) {
        const h = p.weeks[p.shortfallWeek - 1]!;
        riskler.push({
          severity: "warning",
          message:
            `NAKİT AÇIĞI: ${p.shortfallWeek}. hafta (${h.from} – ${h.to}) sonunda ` +
            `${TR.format(p.shortfallAmount)} ${para} açık oluşuyor. Tahsilatı öne çekmek ` +
            `ya da ödemeyi ertelemek gerekir.`,
        });
      }
      if (p.overdueReceivables.count > 0) {
        riskler.push({
          severity: "warning",
          message:
            `${p.overdueReceivables.count} adet, toplam ` +
            `${TR.format(p.overdueReceivables.amount)} ${para} vadesi geçmiş ALACAK var ve ` +
            `bu tutar projeksiyona DAHİL DEĞİL. Tahsil edilirse tablo bu kadar iyileşir; ` +
            `edilmezse tablo zaten doğrudur.`,
        });
      }
      if (p.undated.receivableCount > 0 || p.undated.payableCount > 0) {
        riskler.push({
          severity: "warning",
          message:
            `Vadesi girilmemiş belgeler projeksiyon DIŞINDA: ` +
            `${p.undated.receivableCount} alacak (${TR.format(p.undated.receivableAmount)} ${para}), ` +
            `${p.undated.payableCount} borç (${TR.format(p.undated.payableAmount)} ${para}). ` +
            `Vade girilirse tablo tamamlanır.`,
        });
      }
      if (yabanciAlacak > 0 || yabanciBorc > 0) {
        riskler.push({
          severity: "info",
          message:
            `${yabanciAlacak + yabanciBorc} adet ${para} DIŞI belge tabloya alınmadı. ` +
            `Karşılığı için kur kararı gerekir; bu tablo yalnızca ${para} akışıdır. ` +
            `Diğer para birimini ayrı sorun.`,
        });
      }
      if (alacak.truncated || borc.truncated) {
        riskler.push({
          severity: "warning",
          message:
            "Açık belge sayısı tarama sınırını aştı; projeksiyon EKSİKTİR. " +
            "Kapanmış belgelerin arşivlenmesi gerekir.",
        });
      }

      return {
        ok: true as const,
        data: { currency: para, ...p },
        sources: [
          kaynak("Satış faturaları", alacak.rows.length),
          kaynak("Gelen faturalar", borc.rows.length),
          kaynak("Banka bakiyeleri", 1),
        ],
        risks: riskler,
        // Vadesiz belge varsa tablo eksiktir ve güven bunu yansıtmalı.
        confidence:
          p.undated.receivableCount + p.undated.payableCount > 0
            ? 78
            : alacak.truncated || borc.truncated
              ? 60
              : 94,
      };
    },
  });

  const plan = defineTool({
    name: "plan_payment_run",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Ödeme önerisi çıkarır: eldeki nakitle hangi tedarikçi faturalarının " +
        "ödeneceğini vadeye göre sıralar. En çok gecikmiş önce. 'Kime ödeyelim', " +
        "'ödeme planı', 'bu hafta hangi faturaları ödeyeceğiz', 'ödeme listesi " +
        "hazırla' isteklerinde kullan. BLOKE faturalar önerilmez, kısmi ödeme " +
        "yapılmaz, kasa tabanının altına inilmez. BU BİR ÖNERİDİR — ödeme " +
        "kaydetmez, bankaya talimat göndermez; kaydetmek için post_payment.",
      en: "Proposes which supplier invoices to pay with available cash, oldest due first.",
    },
    input: z.strictObject({
      currency: z
        .string()
        .length(3)
        .describe("Para birimi (TRY, USD, EUR). Kullanıcı belirtmediyse TRY gönder."),
      availableCash: z
        .number()
        .nullable()
        .describe("Ödemede kullanılacak nakit. null gönderilirse banka bakiyesinden okunur."),
      cashFloor: z
        .number()
        .min(0)
        .describe(
          "Kasada bırakılacak asgari tutar (maaş, vergi, acil gider için). " +
            "Bilinmiyorsa 0 gönder; ama 0 göndermek 'her kuruşu dağıt' demektir.",
        ),
    }),
    requires: ["finance:payment.read"],
    async execute(input, ctx) {
      const para = input.currency.toUpperCase();
      const eldeki = await nakit(ctx.tenant.tenantId, input.availableCash, para);
      const borc = await repo.openPayables();

      const p = planPaymentRun(
        ctx.now(),
        eldeki,
        input.cashFloor,
        borc.rows.map((d) => ({
          documentNo: d.documentNo,
          partnerId: d.partnerId,
          partnerName: d.partnerName,
          openAmount: d.openAmount,
          currency: d.currency,
          dueDate: d.dueDate,
          matchStatus: d.matchStatus,
        })),
        para,
      );

      const riskler: { severity: "warning" | "info"; message: string }[] = [
        {
          severity: "info",
          message:
            `${p.proposed.length} fatura, toplam ${TR.format(p.proposedTotal)} ${para} öneriliyor. ` +
            `BU BİR ÖNERİDİR: hiçbir ödeme kaydedilmedi, bankaya talimat gönderilmedi.`,
        },
      ];

      const gecikmis = p.proposed.filter((x) => x.overdueDays > 0);
      if (gecikmis.length > 0) {
        riskler.push({
          severity: "warning",
          message:
            `Önerilenlerin ${gecikmis.length} tanesi vadesi geçmiş; en eskisi ` +
            `${gecikmis[0]!.overdueDays} gün gecikmiş (${gecikmis[0]!.partnerName}).`,
        });
      }
      if (p.deferred.length > 0) {
        riskler.push({
          severity: "warning",
          message:
            `${p.deferred.length} fatura nakit yetmediği için ertelendi ` +
            `(${TR.format(p.deferredTotal)} ${para}). Bunların ödenmesi için ek nakit gerekir.`,
        });
      }
      if (p.blocked.length > 0) {
        const t = p.blocked.reduce((s, b) => s + b.amount, 0);
        riskler.push({
          severity: "warning",
          message:
            `${p.blocked.length} fatura BLOKE (${TR.format(t)} ${para}) ve öneriye alınmadı. ` +
            `Mutabakat farkı çözülmeden ödenmemeli — ama borç ortadan kalkmıyor.`,
        });
      }
      if (p.undated.length > 0) {
        const t = p.undated.reduce((s, b) => s + b.amount, 0);
        riskler.push({
          severity: "warning",
          message:
            `${p.undated.length} faturanın VADESİ GİRİLMEMİŞ (${TR.format(t)} ${para}) ve sıraya ` +
            `girmedi. Vade girilmezse bu faturalar hiçbir ödeme koşusunda görünmez. ` +
            `set_payable_due_date ile girilebilir.`,
        });
      }
      if (p.foreignCurrency.length > 0) {
        riskler.push({
          severity: "info",
          message:
            `${p.foreignCurrency.length} adet ${para} dışı fatura ayrı değerlendirilmeli; ` +
            `${para} sırasına karıştırılmadı. Diğer para birimini ayrı sorun.`,
        });
      }

      return {
        ok: true as const,
        data: { currency: para, ...p },
        sources: [kaynak("Gelen faturalar", borc.rows.length)],
        risks: riskler,
        confidence: borc.truncated ? 60 : 95,
      };
    },
  });

  const setDue = defineTool({
    name: "set_payable_due_date",
    module: "finance",
    authority: 2,
    description: {
      tr:
        "Bir tedarikçi faturasına ödeme vadesi yazar. Vadesi olmayan fatura ne " +
        "nakit projeksiyonuna ne ödeme koşusuna girer — sessizce ödenmeden kalır. " +
        "'Şu faturanın vadesi 30 gün', 'vade tarihi gir' isteklerinde kullan. " +
        "Vade, fatura tarihinden önce olamaz.",
      en: "Sets the payment due date on a supplier invoice.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(64).describe("Gelen fatura belge numarası."),
      dueDate: z.string().describe("Vade tarihi, ISO 8601 (YYYY-AA-GG)."),
    }),
    requires: ["finance:payment.write"],
    async execute(input) {
      const d = new Date(input.dueDate);
      if (Number.isNaN(d.getTime())) {
        throw new BusinessRuleError(
          `"${input.dueDate}" geçerli bir tarih değil. YYYY-AA-GG biçiminde girin.`,
          "invalid_date",
        );
      }
      const res = await repo.setPayableDueDate(input.documentNo, d);
      return {
        ok: true as const,
        data: {
          documentNo: input.documentNo,
          dueDate: d.toISOString().slice(0, 10),
          partnerId: res.partnerId,
        },
        sources: [kaynak("Gelen faturalar", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${input.documentNo} faturasının vadesi ${d.toISOString().slice(0, 10)} olarak ` +
              `yazıldı. Fatura artık ödeme koşusuna ve nakit projeksiyonuna giriyor.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  return [project, plan, setDue] as const;
}
