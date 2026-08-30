/**
 * Sabit kıymet tool'ları.
 *
 * AMORTİSMAN AYIRMAK L2'DİR. Vergi matrahını doğrudan değiştirir ve
 * yevmiyeye kayıt yazar; geri alınması ters kayıt gerektirir. Elden
 * çıkarma da L2: bilançodan bir varlık silinir.
 *
 * KIYMET AÇMAK L1. Kendi başına mali sonuç doğurmaz ama yanlış
 * faydalı ömür ya da yanlış yöntem, sonraki her yılın amortismanını
 * bozar — o yüzden onaydan geçer.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { AssetRepository } from "../../db/asset-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });
const money = (n: number): string => `${TR.format(n)} TL`;

/**
 * Kategoriye göre varsayılan hesaplar.
 *
 * Kullanıcıya hesap kodu sordurmak, hesap planını bilmeyen bir
 * kullanıcıyı yanlış hesaba yazmaya iter. Kategori seçilir, hesap
 * buradan gelir — ve istenirse üzerine yazılır.
 */
const ACCOUNTS: Record<string, { asset: string; expense: string; prorated: boolean }> = {
  // Üretim makinesi gideri 730 Genel Üretim Giderleri'ne yazılır:
  // 770'e yazılırsa mamul maliyeti eksik, genel yönetim gideri fazla çıkar.
  makine: { asset: "253", expense: "730", prorated: false },
  // Binek otomobil KIST amortismana tabidir (VUK 320).
  tasit: { asset: "254", expense: "770", prorated: true },
  demirbas: { asset: "255", expense: "770", prorated: false },
  bilgisayar: { asset: "255", expense: "770", prorated: false },
  bina: { asset: "252", expense: "770", prorated: false },
  diger: { asset: "255", expense: "770", prorated: false },
};

export function assetTools(repo: AssetRepository) {
  const list = defineTool({
    name: "list_fixed_assets",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Sabit kıymetleri listeler: maliyet, birikmiş amortisman ve NET DEFTER DEĞERİ. " +
        "'Makinelerimiz ne kadar', 'demirbaş listesi', 'amortisman durumu' sorularında " +
        "kullan. Durum süzgeci: aktif, tam_amorti, elden_cikarildi.",
      en: "Lists fixed assets with cost, accumulated depreciation and net book value.",
    },
    input: z.strictObject({
      status: z
        .enum(["aktif", "tam_amorti", "elden_cikarildi", "hepsi"])
        .describe("Durum süzgeci; 'hepsi' tümünü getirir."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const rows = await repo.list(input.status === "hepsi" ? undefined : input.status);
      const cost = rows.reduce((s, r) => s + r.cost, 0);
      const book = rows.reduce((s, r) => s + r.bookValue, 0);
      // MUTABAKAT HER LİSTEDE ÇALIŞIR. Ayrı bir tool olsaydı kimse
      // çağırmaz ve kayıt ile defter yıllarca sessizce ayrışırdı.
      const rec = await repo.reconcile();
      return {
        ok: true as const,
        data: {
          assets: rows,
          count: rows.length,
          totalCost: Math.round(cost * 100) / 100,
          totalBookValue: Math.round(book * 100) / 100,
          reconciliation: rec,
          summary:
            `${rows.length} kıymet, toplam maliyet ${money(cost)}, net defter değeri ` +
            `${money(book)}.`,
        },
        sources: [
          {
            system: "Sabit kıymet kayıtları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: rec.matched
          ? []
          : [
              {
                severity: "warning" as const,
                message:
                  "Sabit kıymet kaydı ile muhasebe defteri UYUŞMUYOR: " +
                  (Math.abs(rec.costDifference) >= 0.011
                    ? `maliyet farkı ${money(rec.costDifference)} (kayıt ${money(rec.registerCost)}, defter ${money(rec.ledgerCost)})`
                    : "") +
                  (Math.abs(rec.costDifference) >= 0.011 &&
                  Math.abs(rec.accumulatedDifference) >= 0.011
                    ? "; "
                    : "") +
                  (Math.abs(rec.accumulatedDifference) >= 0.011
                    ? `birikmiş amortisman farkı ${money(rec.accumulatedDifference)}`
                    : "") +
                  ". Bilanço ile kıymet listesi farklı rakam söyler; hangisinin doğru " +
                  "olduğu araştırılmalı.",
              },
            ],
        confidence: 97,
      };
    },
  });

  const detail = defineTool({
    name: "get_fixed_asset",
    module: "accounting",
    authority: 0,
    description: {
      tr:
        "Bir sabit kıymetin künyesi ve AMORTİSMAN TABLOSU: ömrü boyunca yıl yıl ne " +
        "kadar ayrılacağı, hangilerinin ayrıldığı ve net defter değerinin nasıl " +
        "azaldığı. 'Bu makine ne zaman biter', 'kalan amortismanı ne kadar' " +
        "sorularının cevabı budur.",
      en: "Returns one fixed asset with its full depreciation schedule.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Kıymet kodu."),
    }),
    requires: ["accounting:ledger.read"],
    async execute(input, _ctx) {
      const found = await repo.byCode(input.code);
      if (!found) {
        // BULUNAMAMAK HATA DEĞİLDİR: kullanıcı yanlış kod yazmış
        // olabilir ve konuşma devam etmeli.
        return {
          ok: true as const,
          data: null,
          sources: [
            {
              system: "Sabit kıymet kayıtları",
              kind: "module" as const,
              recordCount: 0,
              syncedAt: new Date().toISOString(),
            },
          ],
          risks: [
            {
              severity: "warning" as const,
              message: `"${input.code}" kodlu sabit kıymet bulunamadı.`,
            },
          ],
          confidence: 90,
        };
      }
      const plan = await repo.scheduleFor(input.code);
      const pending = plan.filter((r) => !r.posted);
      return {
        ok: true as const,
        data: {
          asset: found.asset,
          schedule: plan,
          postedRuns: found.runs,
          remainingYears: pending.length,
          summary:
            `${found.asset.name}: maliyet ${money(found.asset.cost)}, birikmiş ` +
            `${money(found.asset.accumulated)}, net defter değeri ` +
            `${money(found.asset.bookValue)}.`,
        },
        sources: [
          {
            system: "Sabit kıymet kayıtları",
            kind: "module" as const,
            recordCount: plan.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          pending.length > 0 && pending[0]!.year < new Date().getUTCFullYear()
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${pending[0]!.year} yılı amortismanı henüz ayrılmamış; ` +
                    `mali tablolar eksik gider gösteriyor.`,
                },
              ]
            : [],
        confidence: 97,
      };
    },
  });

  const create = defineTool({
    name: "create_fixed_asset",
    module: "accounting",
    authority: 1,
    confirm: "always",
    description: {
      tr:
        "Yeni sabit kıymet kartı açar. Kategori seçilince muhasebe hesapları ve kıst " +
        "amortisman kuralı OTOMATİK gelir: taşıt 254/kıst, makine 253/730, demirbaş " +
        "255/770. Faydalı ömür Maliye Bakanlığı listesinden alınmalıdır; yanlış ömür " +
        "sonraki her yılın amortismanını bozar.",
      en: "Creates a fixed asset card with accounts derived from its category.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Kıymet kodu, örn. SK-001."),
      name: z.string().min(2).max(200).describe("Kıymetin adı."),
      category: z
        .enum(["makine", "tasit", "demirbas", "bilgisayar", "bina", "diger"])
        .describe("Kıymet türü; hesaplar buna göre belirlenir."),
      acquiredAt: z.string().describe("İktisap tarihi (ISO 8601)."),
      cost: z.number().describe("Amortismana esas bedel, KDV hariç."),
      usefulLifeYears: z.number().int().describe("Faydalı ömür, yıl."),
      method: z.enum(["normal", "azalan"]).describe("Amortisman yöntemi."),
      serial: z.string().max(80).nullable().describe("Seri numarası; yoksa null."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, _ctx) {
      const acc = ACCOUNTS[input.category]!;
      const a = await repo.create({
        code: input.code,
        name: input.name,
        category: input.category,
        acquiredAt: new Date(input.acquiredAt),
        cost: input.cost,
        usefulLifeYears: input.usefulLifeYears,
        method: input.method,
        prorated: acc.prorated,
        assetAccount: acc.asset,
        expenseAccount: acc.expense,
        serial: input.serial,
      });
      return {
        ok: true as const,
        data: { asset: a, summary: `${a.code} ${a.name} kaydedildi.` },
        sources: [
          {
            system: "Sabit kıymet kayıtları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: acc.prorated
          ? [
              {
                severity: "info" as const,
                message:
                  `${a.code} binek otomobil kabul edildi ve KIST amortismana tabi ` +
                  `(VUK 320): iktisap yılında yalnızca ${12 - new Date(input.acquiredAt).getUTCMonth()} ay ayrılacak.`,
              },
            ]
          : [],
        confidence: 97,
      };
    },
  });

  const run = defineTool({
    name: "run_depreciation",
    module: "accounting",
    authority: 2,
    confirm: "always",
    description: {
      tr:
        "Bir yılın amortismanını ayırır ve YEVMİYEYE KAYIT YAZAR: gider hesabı " +
        "borçlanır, birikmiş amortisman alacaklanır. Vergi matrahını doğrudan " +
        "değiştirir. Aynı yıl İKİ KEZ ayrılamaz; zaten ayrılmış kıymetler atlanır " +
        "ve geçmiş yılı eksik olan kıymetler ayrılmaz. Geri almak ters kayıt ister.",
      en: "Posts a year's depreciation for all active assets, writing journal entries.",
    },
    input: z.strictObject({
      year: z.number().int().describe("Amortismanın ayrılacağı yıl."),
      code: z
        .string()
        .max(64)
        .nullable()
        .describe("Yalnızca bu kıymet için; hepsi için null."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const r = await repo.run({
        year: input.year,
        userId: ctx.principal.userId,
        code: input.code,
      });
      return {
        ok: true as const,
        data: {
          ...r,
          summary:
            r.posted.length === 0
              ? `${input.year} için ayrılacak amortisman bulunamadı.`
              : `${r.posted.length} kıymet için ${money(r.total)} amortisman ayrıldı ` +
                `(${r.documentNo}).`,
        },
        sources: [
          {
            system: "Sabit kıymet kayıtları",
            kind: "module" as const,
            recordCount: r.posted.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        // ATLANANLAR SESSİZ KALMAZ: kullanıcı "hepsini ayırdım" sanıp
        // eksik gider ile kapanış yapmasın.
        risks: r.skipped.length > 0
          ? [
              {
                severity: "warning" as const,
                message:
                  `${r.skipped.length} kıymet atlandı: ` +
                  r.skipped.map((s) => `${s.code} (${s.reason})`).join(", "),
              },
            ]
          : [],
        confidence: 96,
      };
    },
  });

  const dispose = defineTool({
    name: "dispose_fixed_asset",
    module: "accounting",
    authority: 2,
    confirm: "always",
    description: {
      tr:
        "Sabit kıymeti elden çıkarır (satış, hurda, devir) ve muhasebe kaydını yazar: " +
        "kıymet hesabı ve birikmiş amortisman kapanır, aradaki fark ile satış bedeli " +
        "arasındaki tutar KÂR ya da ZARAR yazılır. Kâr 649'a yazılır, 600'e DEĞİL — " +
        "makine satmak ciro değildir.",
      en: "Disposes a fixed asset and posts the closing journal entry with gain or loss.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Kıymet kodu."),
      disposedAt: z.string().describe("Çıkış tarihi (ISO 8601)."),
      proceeds: z.number().describe("Satış bedeli; hurdaya ayrıldıysa 0."),
      counterAccount: z
        .enum(["100", "102", "120"])
        .describe("Bedelin geldiği hesap: 100 kasa, 102 banka, 120 alıcılar."),
    }),
    requires: ["accounting:ledger.write"],
    async execute(input, ctx) {
      const r = await repo.dispose({
        code: input.code,
        disposedAt: new Date(input.disposedAt),
        proceeds: input.proceeds,
        userId: ctx.principal.userId,
        counterAccount: input.counterAccount,
      });
      return {
        ok: true as const,
        data: {
          ...r,
          summary:
            `${input.code} elden çıkarıldı. Net defter değeri ${money(r.bookValue)}, ` +
            `${r.gain >= 0 ? "kâr" : "zarar"} ${money(Math.abs(r.gain))} (${r.documentNo}).`,
        },
        sources: [
          {
            system: "Sabit kıymet kayıtları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `Sabit kıymet satış ${r.gain >= 0 ? "kârı" : "zararı"} ` +
              `${money(Math.abs(r.gain))} olarak ${r.gain >= 0 ? "649" : "659"} hesabına ` +
              `yazıldı; satış hasılatına (600) girmez.`,
          },
        ],
        confidence: 96,
      };
    },
  });

  return [list, detail, create, run, dispose] as const;
}
