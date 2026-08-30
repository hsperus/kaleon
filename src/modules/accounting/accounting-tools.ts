/**
 * Muhasebe tool'ları.
 *
 * MİZAN L0'DIR AMA HERKESE AÇIK DEĞİLDİR. Okuma bir onay gerektirmez;
 * ama bir şirketin mizanı, cirosunu ve kârını gösterir — depo
 * sorumlusunun görmesi gereken bir şey değildir. Sınır yetkiyle çizilir.
 *
 * ELLE FİŞ L3'TÜR. Kayıtların çoğunun elle girildiği bir sistemde muhasebe
 * operasyondan kopar; elle fiş İSTİSNADIR (açılış kaydı, amortisman,
 * düzeltme) ve istisna olduğu yetki seviyesinden anlaşılmalıdır.
 *
 * DENKSİZ MİZAN SESSİZ GEÇMEZ. Rapor her seferinde denkliği söyler;
 * denk olmayan bir mizanı sessizce göstermek, ona güvenilmesine yol açar.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { JournalRepository } from "../../db/journal-repository.js";
import { CHART } from "./accounts.js";
import { buildVatReturn } from "./vat-return.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number) => `${TR.format(n)} TL`;

/** Mizanda gösterilecek en fazla satır — hesap planı zaten sınırlı. */
const MAX_ROWS = 200;

export function accountingTools(repo: JournalRepository) {
  const trialBalance = defineTool({
    name: "get_trial_balance",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Mizan: verilen tarih aralığındaki tüm yevmiye kayıtlarının hesap bazında " +
        "borç, alacak ve bakiye toplamı. Tek Düzen Hesap Planı kodlarıyla döner. " +
        "Mizanın DENK OLUP OLMADIĞI da bildirilir — denk olmayan mizan hiçbir " +
        "soruya cevap veremez. 'Mizan çıkar', 'hesaplar ne durumda' sorularında kullan.",
      en: "Trial balance for a date range, by account, with a balance check.",
    },
    input: z.strictObject({
      from: z.string().describe("Başlangıç tarihi (ISO 8601)."),
      to: z.string().describe("Bitiş tarihi (ISO 8601), dahil."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const tb = await repo.trialBalance(new Date(input.from), new Date(input.to));
      const rows = tb.rows.slice(0, MAX_ROWS);
      return {
        ok: true as const,
        data: {
          from: input.from,
          to: input.to,
          rows,
          totalDebit: tb.totalDebit,
          totalCredit: tb.totalCredit,
          balanced: tb.balanced,
        },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: tb.rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: tb.balanced
          ? []
          : [
              {
                severity: "critical" as const,
                message:
                  `MİZAN DENK DEĞİL: borç ${money(tb.totalDebit)}, alacak ` +
                  `${money(tb.totalCredit)}. Bu tablodan çıkacak hiçbir rakama ` +
                  `güvenilemez; tek taraflı bir kayıt aranmalıdır.`,
              },
            ],
        confidence: tb.balanced ? 96 : 30,
      };
    },
  });

  /**
   * Bilanço.
   *
   * GELİR TABLOSU VARDI, BİLANÇO YOKTU — ikisi birlikte "mali tablo"dur.
   * Bankaya, mali müşavire ve ortağa verilen tablo budur.
   */
  const balance = defineTool({
    name: "get_balance_sheet",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Bilanço: belirli bir tarih itibarıyla aktif (varlıklar) ve pasif (kaynaklar), " +
        "Tek Düzen Hesap Planı gruplarıyla. Dönem net kârı özkaynağa taşınmış hâlde " +
        "gelir. 'Mali durumumuz ne', 'bilanço', 'varlıklarımız ne kadar', 'bankaya " +
        "verilecek tablo' sorularında kullan. Gelir tablosundan FARKLIDIR: gelir " +
        "tablosu dönemde ne kazanıldığını, bilanço o an neye sahip olunduğunu söyler.",
      en: "Balance sheet as of a date: assets and liabilities by Turkish chart-of-accounts groups.",
    },
    input: z.strictObject({
      asOf: z.string().describe("Hangi tarih itibarıyla (ISO 8601)."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const r = await repo.balanceSheet(new Date(input.asOf));
      const b = r.sheet;

      const risks: { severity: "info" | "warning" | "critical"; message: string }[] = [];

      // DENK OLMAYAN BİLANÇO YAYIMLANMAMALI. Sessizce vermek, kullanıcının
      // onu bankaya götürmesi demektir.
      if (!b.balanced) {
        risks.push({
          severity: "critical",
          message:
            `Bilanço DENK DEĞİL: aktif ${money(b.totalAssets)}, pasif ` +
            `${money(b.totalLiabilities)}, fark ${money(b.difference)}. Bu tablo ` +
            `kullanılmamalı; önce yevmiye kayıtları incelenmeli.`,
        });
      }
      if (!r.trialBalanced) {
        risks.push({
          severity: "critical",
          message: "Mizan denk değil; tek taraflı kayıt var. Tüm mali tablolar şüpheli.",
        });
      }
      const unclassified = [...b.assets, ...b.liabilities].filter((g) => g.code === "Z");
      if (unclassified.length > 0) {
        risks.push({
          severity: "warning",
          message:
            "Bilanço grubuna girmeyen hesap var: " +
            unclassified.flatMap((g) => g.lines.map((l) => l.code)).join(", ") +
            ". Ayrı başlıkta gösterildi.",
        });
      }

      return {
        ok: true as const,
        data: {
          kind: "balance-sheet" as const,
          asOf: input.asOf,
          periodFrom: r.periodFrom,
          assets: b.assets,
          liabilities: b.liabilities,
          totalAssets: b.totalAssets,
          totalLiabilities: b.totalLiabilities,
          periodResult: b.periodResult,
          balanced: b.balanced,
          difference: b.difference,
          summary:
            `Aktif toplamı ${money(b.totalAssets)}, pasif toplamı ` +
            `${money(b.totalLiabilities)}` +
            (b.balanced ? " — denk." : ` — DENK DEĞİL, fark ${money(b.difference)}.`),
        },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: b.assets.length + b.liabilities.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks,
        confidence: b.balanced ? 96 : 40,
      };
    },
  });

  const income = defineTool({
    name: "get_income_statement",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Gelir tablosu özeti: ciro, satılan malın maliyeti, brüt kâr, giderler ve " +
        "net kâr. GERÇEK KÂRLILIK budur — satış fiyatından değil, maliyetten çıkar. " +
        "'Kâr ettik mi', 'bu ay ne kazandık' sorularında kullan.",
      en: "Income statement summary: revenue, COGS, gross and net profit.",
    },
    input: z.strictObject({
      from: z.string().describe("Başlangıç tarihi (ISO 8601)."),
      to: z.string().describe("Bitiş tarihi (ISO 8601), dahil."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const s = await repo.income(new Date(input.from), new Date(input.to));
      const margin = s.revenue > 0 ? Math.round((s.grossProfit / s.revenue) * 1000) / 10 : null;
      return {
        ok: true as const,
        data: {
          from: input.from,
          to: input.to,
          revenue: s.revenue,
          cogs: s.cogs,
          grossProfit: s.grossProfit,
          grossMarginPercent: margin,
          expenses: s.expenses,
          netProfit: s.netProfit,
          summary:
            `Ciro ${money(s.revenue)}, maliyet ${money(s.cogs)}, brüt kâr ` +
            `${money(s.grossProfit)}${margin !== null ? ` (%${margin})` : ""}.`,
        },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(s.balanced
            ? []
            : [
                {
                  severity: "critical" as const,
                  message: "Mizan denk değil; bu gelir tablosu güvenilir DEĞİLDİR.",
                },
              ]),
          ...(s.cogs === 0 && s.revenue > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Satılan malın maliyeti sıfır görünüyor. Stok maliyeti girilmemiş " +
                    "olabilir; bu durumda brüt kâr OLDUĞUNDAN YÜKSEK çıkar.",
                },
              ]
            : []),
        ],
        confidence: s.balanced ? 94 : 30,
      };
    },
  });

  const statement = defineTool({
    name: "get_partner_statement",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Cari hesap ekstresi: bir müşteri veya tedarikçinin açılış bakiyesi, dönem " +
        "içi hareketleri ve YÜRÜYEN BAKİYESİ. Mutabakat tam olarak bu yürüyen " +
        "bakiyeyi karşılaştırmaktır. 'Bu müşteriden ne kadar alacağımız var', " +
        "'ekstre çıkar' sorularında kullan.",
      en: "Partner account statement with opening balance and running balance.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Cari kimliği."),
      from: z.string().describe("Başlangıç tarihi (ISO 8601)."),
      to: z.string().describe("Bitiş tarihi (ISO 8601), dahil."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const st = await repo.partnerStatement(
        input.partnerId,
        new Date(input.from),
        new Date(input.to),
      );
      return {
        ok: true as const,
        data: {
          // Arayüz bunu MUTABAKAT MEKTUBU olarak gösterir.
          kind: "statement" as const,
          from: input.from,
          to: input.to,
          ...st,
          openingLabel: money(st.openingBalance),
          closingLabel: money(st.closingBalance),
        },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: st.movements.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          st.movements.length === 0 && st.openingBalance === 0
            ? [
                {
                  severity: "info" as const,
                  message: "Bu cari için kayıtlı hareket yok.",
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  const aging = defineTool({
    name: "get_receivables_aging",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Alacak yaşlandırması: her müşterinin bakiyesi ve bunun ne kadarının " +
        "0-30, 31-60, 61-90 ve 90+ gün olduğu. TEK BİR TOPLAM ALACAK RAKAMI " +
        "KARAR VERDİRMEZ; tahsilat riski yaşta gizlidir. 90 günü geçen alacağı " +
        "en çok olan başta listelenir.",
      en: "Receivables aging by partner with 30/60/90+ day buckets.",
    },
    input: z.strictObject({
      on: z.string().describe("Hangi tarihe göre yaşlandırılsın (ISO 8601)."),
      supplier: z
        .boolean()
        .describe("true ise borçlar (320), false ise alacaklar (120) yaşlandırılır."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const rows = await repo.receivablesAging(new Date(input.on), input.supplier ? "320" : "120");
      const total = rows.reduce((s, r) => s + r.balance, 0);
      const overdue = rows.reduce((s, r) => s + r.over90, 0);

      return {
        ok: true as const,
        data: {
          on: input.on,
          kind: input.supplier ? "borclar" : "alacaklar",
          rows,
          total: Math.round(total * 100) / 100,
          over90Total: Math.round(overdue * 100) / 100,
        },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          overdue > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${money(overdue)} tutarındaki ${input.supplier ? "borç" : "alacak"} ` +
                    `90 GÜNÜ GEÇMİŞ (toplamın %${Math.round((overdue / (total || 1)) * 100)}'i).`,
                },
              ]
            : [],
        confidence: 93,
      };
    },
  });

  const documentEntry = defineTool({
    name: "get_document_journal_entry",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Bir belgenin muhasebe kaydını döndürür: hangi hesaba ne yazıldı. " +
        "'Bu fatura nasıl muhasebeleşti', 'bu kayıt neden böyle' sorularında kullan.",
      en: "Returns the journal entry generated by a business document.",
    },
    input: z.strictObject({
      sourceKind: z
        .enum(["sales_invoice", "purchase_invoice", "delivery", "goods_receipt", "payment"])
        .describe("Belge türü."),
      sourceId: z.string().min(1).describe("Belge kimliği."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const entry = await repo.entryFor(input.sourceKind, input.sourceId);
      return {
        ok: true as const,
        data: entry,
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: entry ? entry.lines.length : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: entry
          ? []
          : [
              {
                severity: "warning" as const,
                message:
                  "Bu belge için muhasebe kaydı yok. Belge muhasebeleşmemiş olabilir; " +
                  "bu durumda mizanda görünmez.",
              },
            ],
        confidence: entry ? 96 : 85,
      };
    },
  });

  const chart = defineTool({
    name: "list_chart_of_accounts",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Tek Düzen Hesap Planındaki kullanılan hesapları listeler: kod, ad, normal " +
        "bakiye yönü ve bilanço/gelir tablosu ayrımı.",
      en: "Lists the chart of accounts in use.",
    },
    input: z.strictObject({}),
    requires: ["accounting:ledger.read"],
    async execute(_input, _ctx) {
      return {
        ok: true as const,
        data: {
          accounts: CHART.map((a) => ({
            code: a.code,
            name: a.name,
            normal: a.normal,
            statement: a.statement,
          })),
        },
        sources: [
          {
            system: "Tek Düzen Hesap Planı",
            kind: "module" as const,
            recordCount: CHART.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 99,
      };
    },
  });

  const manualEntry = defineTool({
    name: "post_journal_entry",
    module: "accounting",
    authority: 3,
    description: {
      tr:
        "ELLE yevmiye fişi keser. Borç ve alacak toplamları EŞİT olmak zorundadır; " +
        "denk olmayan fiş kaydedilmez. Hesap kodları Tek Düzen Hesap Planından " +
        "olmalıdır. Bu bir İSTİSNADIR: açılış kaydı, amortisman ve düzeltme için " +
        "kullanılır — normal işlemler belgelerinden kendiliğinden muhasebeleşir. " +
        "KESİLEN FİŞ DEĞİŞTİRİLEMEZ; yanlışsa ters kayıt atılır.",
      en: "Posts a manual journal entry. Debits must equal credits.",
    },
    input: z.strictObject({
      entryDate: z.string().describe("Fiş tarihi (ISO 8601)."),
      description: z.string().min(3).max(300).describe("Fiş açıklaması."),
      lines: z
        .array(
          z.strictObject({
            accountCode: z.string().min(3).max(3).describe("TDHP hesap kodu: 100, 120, 600…"),
            debit: z.number().nonnegative().describe("Borç tutarı. Alacak satırında 0."),
            credit: z.number().nonnegative().describe("Alacak tutarı. Borç satırında 0."),
            description: z.string().min(1).max(200),
            partnerId: z
              .string()
              .nullable()
              .describe("120/320 gibi cari hesaplarda ZORUNLU. Diğerlerinde null."),
          }),
        )
        .min(2)
        .describe("En az iki satır; borç toplamı alacak toplamına eşit olmalı."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const res = await repo.post({
        entryDate: new Date(input.entryDate),
        description: input.description,
        sourceKind: "manual",
        lines: input.lines,
        userId: ctx.principal.userId,
      });
      const total = input.lines.reduce((s, l) => s + l.debit, 0);
      return {
        ok: true as const,
        data: { documentNo: res.documentNo, totalDebit: total },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: input.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${res.documentNo} kesildi (${money(total)}). Fiş artık DEĞİŞTİRİLEMEZ; ` +
              `hatalıysa ters kayıt atılmalıdır.`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const reverse = defineTool({
    name: "reverse_journal_entry",
    module: "accounting",
    authority: 3,
    description: {
      tr:
        "Yevmiye fişinin TERS KAYDINI atar. Fiş silinmez; borç ve alacak yer " +
        "değiştirerek yeni bir fiş oluşur ve ikisi birbirine bağlanır. " +
        "Gerekçe zorunludur.",
      en: "Posts a reversing entry. The original is kept and linked.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Ters kaydı atılacak fiş numarası."),
      reason: z.string().min(5).max(300).describe("Neden ters kaydediliyor?"),
      entryDate: z.string().describe("Ters kaydın tarihi (ISO 8601)."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const res = await repo.reverse(
        input.documentNo,
        ctx.principal.userId,
        input.reason,
        new Date(input.entryDate),
      );
      return {
        ok: true as const,
        data: { original: input.documentNo, reversal: res.documentNo },
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${input.documentNo} ters kaydedildi (${res.documentNo}). Asıl fiş ` +
              `defterde kalır; iki kayıt birbirini götürür.`,
          },
        ],
        confidence: 97,
      };
    },
  });

  const vatReturn = defineTool({
    name: "draft_vat_return",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "KDV beyannamesi TASLAĞI hazırlar: hesaplanan KDV (391), indirilecek KDV " +
        "(191), önceki dönemden devreden ve ödenecek/devreden tutar. BEYAN DEĞİL " +
        "TASLAKTIR — beyannameyi mali müşavir onaylar ve gönderir; bu sistem resmî " +
        "beyan göndermez. 'Bu ay ne kadar KDV ödeyeceğiz' sorusunda kullan.",
      en: "Drafts a VAT return from ledger balances. A draft only; never filed.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Ay."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const figures = await repo.vatFigures(input.year, input.month);
      const r = buildVatReturn(figures);
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Yevmiye defteri",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...r.warnings.map((w) => ({ severity: "warning" as const, message: w })),
          {
            severity: "info" as const,
            message:
              "Bu bir TASLAKTIR. Beyanname mali müşavir tarafından kontrol edilip " +
              "gönderilmelidir; sistem resmî beyan göndermez.",
          },
        ],
        confidence: figures.ledgerBalanced ? 88 : 25,
      };
    },
  });

  const edefter = defineTool({
    name: "build_edefter",
    module: "accounting",
    authority: 2,
    description: {
      tr:
        "Bir ayın e-Defter (XBRL-GL) yevmiye ve kebir dosyalarını üretir. " +
        "1 OCAK 2027'DEN İTİBAREN ZORUNLUDUR. Denk olmayan fiş veya plan dışı " +
        "hesap varsa üretilmez — GİB böyle bir defteri reddeder. Dosyalar " +
        "İMZALANMAZ VE GÖNDERİLMEZ; mali mühür ve GİB yüklemesi mali müşavirin işidir.",
      en: "Builds XBRL-GL journal and ledger files for a period. Not signed or filed.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).describe("Yıl."),
      month: z.number().int().min(1).max(12).describe("Ay."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, _ctx) {
      const company = await repo.companyForDefter();
      const d = await repo.buildEDefter(input.year, input.month, company);
      return {
        ok: true as const,
        data: {
          period: `${input.year}/${String(input.month).padStart(2, "0")}`,
          entryCount: d.entryCount,
          yevmiyeBytes: Buffer.byteLength(d.yevmiye, "utf8"),
          kebirBytes: Buffer.byteLength(d.kebir, "utf8"),
          yevmiyePreview: d.yevmiye.slice(0, 300),
        },
        sources: [
          {
            system: "e-Defter (XBRL-GL)",
            kind: "module" as const,
            recordCount: d.entryCount,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "warning" as const,
            message:
              `${d.entryCount} yevmiye maddesi için defter üretildi. Dosyalar " +
              "İMZALANMADI ve GÖNDERİLMEDİ; mali mühürle imzalanıp berat GİB'e " +
              "yüklenmelidir.`,
          },
        ],
        confidence: 92,
      };
    },
  });

  return [
    vatReturn,
    edefter,
    trialBalance,
    balance,
    income,
    statement,
    aging,
    documentEntry,
    chart,
    manualEntry,
    reverse,
  ] as const;
}
