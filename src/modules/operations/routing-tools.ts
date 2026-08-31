/**
 * Rota, standart maliyet ve raf tool'ları.
 *
 * ALTI TOOL:
 *   create_routing         → ürünün üretim yolu (L2)
 *   get_routing_load       → bir parti kaç dakika sürer
 *   set_standard_cost      → ön maliyet (L2)
 *   get_cost_variance      → standart–gerçekleşen sapması
 *   create_storage_bin     → raf/göz aç (L2)
 *   get_bin_contents       → hangi rafta ne var
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { computeLoad, analyzeVariance, RoutingError } from "./routing.js";
import type { RoutingRepository } from "../../db/routing-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

export function routingTools(repo: RoutingRepository) {
  const create = defineTool({
    name: "create_routing",
    module: "operations",
    authority: 2,
    description: {
      tr:
        "Rota tanımlar: bir ürünün hangi iş merkezlerinde, hangi sırayla, ne kadar " +
        "sürede üretildiği. HAZIRLIK VE İŞLEME SÜRESİ AYRI girilir — hazırlık parti " +
        "başına bir kez, işleme her adet için harcanır. Aynı ürünün birden çok " +
        "rotası olabilir (elde / robotla). 'Rota tanımla', 'üretim adımları' " +
        "isteklerinde kullan.",
      en: "Defines a routing: operations, work centers, setup and run times.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Rota kodu, benzersiz."),
      itemCode: z.string().trim().min(1).max(60).describe("Hangi ürün için."),
      name: z.string().trim().min(2).max(160).describe("Rota adı."),
      operations: z
        .array(
          z.strictObject({
            seq: z.number().int().positive().describe("Operasyon sırası (10, 20, 30…)."),
            workCenterId: z.string().trim().min(1).max(60).describe("İş merkezi kodu."),
            description: z.string().trim().min(1).max(200).describe("Ne yapılıyor."),
            setupMinutes: z.number().min(0).describe("Hazırlık süresi — PARTİ BAŞINA, dakika."),
            runMinutesPerUnit: z.number().min(0).describe("İşleme süresi — ADET BAŞINA, dakika."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Operasyonlar."),
    }),
    requires: ["operations:workorder.write"],
    async execute(input, ctx) {
      const siralar = input.operations.map((o) => o.seq);
      if (new Set(siralar).size !== siralar.length) {
        throw new BusinessRuleError(
          "Aynı sıra numarası iki operasyonda kullanılamaz; sıra belirsiz kalır.",
          "duplicate_seq",
        );
      }
      if (input.operations.every((o) => o.setupMinutes === 0 && o.runMinutesPerUnit === 0)) {
        throw new BusinessRuleError(
          "Bütün operasyonların süresi sıfır. Süresiz bir rota, kapasite yükü " +
            "üretmez ve maliyet hesabına hiçbir şey katmaz.",
          "routing_no_time",
        );
      }

      const res = await repo.createRouting({
        code: input.code,
        itemId: input.itemCode,
        name: input.name,
        operations: input.operations,
        userId: ctx.principal.userId,
      });

      const yuk = computeLoad(input.operations, 100);
      return {
        ok: true as const,
        data: { ...res, itemCode: input.itemCode, minutesPer100: yuk.totalMinutes },
        sources: [kaynak("Rotalar", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.code} rotası açıldı: ${res.operationCount} operasyon. 100 adetlik ` +
              `parti ${yuk.totalMinutes} dakika sürer (darboğaz: ${yuk.bottleneck}).`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const load = defineTool({
    name: "get_routing_load",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "Bir parti için rota yükünü hesaplar: hangi operasyon kaç dakika, toplam " +
        "ne kadar, darboğaz hangisi ve BİRİM BAŞINA kaç dakika. Birim süre parti " +
        "büyüklüğüne göre DEĞİŞİR — 'neden küçük siparişe daha pahalı fiyat " +
        "veriyoruz' sorusunun cevabı budur. 'Bu iş kaç saat sürer', 'kapasite ne " +
        "kadar dolar' sorularında kullan.",
      en: "Computes routing load for a batch: per-operation minutes and bottleneck.",
    },
    input: z.strictObject({
      routingCode: z.string().trim().max(40).nullable().describe("Rota kodu; ürünün varsayılanı için null."),
      itemCode: z.string().trim().max(60).nullable().describe("Malzeme kodu; rota kodu verildiyse null."),
      quantity: z.number().positive().describe("Parti miktarı."),
    }),
    requires: ["operations:workorder.read"],
    async execute(input) {
      if (input.routingCode === null && input.itemCode === null) {
        throw new BusinessRuleError("Rota kodu ya da malzeme kodu verilmelidir.", "missing_key");
      }
      const rota = input.routingCode
        ? await repo.routing(input.routingCode)
        : (await repo.routingsForItem(input.itemCode!))[0] ?? null;

      /*
       * TEK DÖNÜŞ ŞEKLİ — bulundu/bulunamadı için iki farklı şekil
       * döndürmek, çağıranı her seferinde şekil kontrolüne zorlar ve
       * modelin iki ayrı kalıp öğrenmesini gerektirir.
       */
      let yuk: ReturnType<typeof computeLoad> | null = null;
      if (rota) {
        try {
          yuk = computeLoad(rota.operations, input.quantity);
        } catch (e) {
          if (e instanceof RoutingError) throw new BusinessRuleError(e.message, "routing_invalid");
          throw e;
        }
      }

      return {
        ok: true as const,
        data: {
          found: rota !== null,
          message: rota ? "" : "Bu ürün/kod için tanımlı rota yok; süre hesaplanamaz.",
          routingCode: rota?.code ?? input.routingCode,
          itemCode: rota?.itemId ?? input.itemCode,
          load: yuk,
        },
        sources: [kaynak("Rotalar", rota?.operations.length ?? 0)],
        risks:
          yuk === null
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Rota tanımlı değil. Rotasız bir ürünün üretim süresi ancak tahmin " +
                    "edilebilir ve tahmin, teslim tarihi taahhüdüne dayanak olamaz.",
                },
              ]
            : [
                {
                  severity: "info" as const,
                  message:
                    `${input.quantity} adet için ${yuk.totalMinutes} dakika ` +
                    `(${Math.round((yuk.totalMinutes / 60) * 10) / 10} saat). Birim başına ` +
                    `${yuk.minutesPerUnit} dakika; bunun ` +
                    `${Math.round((yuk.setupTotal / yuk.totalMinutes) * 100)}%'i hazırlık. ` +
                    `Darboğaz: ${yuk.bottleneck}.`,
                },
              ],
        confidence: yuk === null ? 90 : 95,
      };
    },
  });

  const setCost = defineTool({
    name: "set_standard_cost",
    module: "operations",
    authority: 2,
    description: {
      tr:
        "Bir ürünün standart (ön) birim maliyetini tanımlar: malzeme, işçilik ve " +
        "genel üretim gideri AYRI AYRI. Üçünü ayrı tutmak, sapma çıktığında " +
        "hangisinde sapıldığını gösterir — malzeme sapması satın almanın, işçilik " +
        "sapması üretimin işidir.",
      en: "Sets standard unit cost split into material, labor and overhead.",
    },
    input: z.strictObject({
      itemCode: z.string().trim().min(1).max(60).describe("Malzeme kodu."),
      year: z.number().int().min(2000).max(2100).describe("Hangi yıl için."),
      materialCost: z.number().min(0).describe("Birim malzeme maliyeti."),
      laborCost: z.number().min(0).describe("Birim işçilik maliyeti."),
      overheadCost: z.number().min(0).describe("Birim genel üretim gideri."),
      currency: z.string().length(3).describe("Para birimi."),
    }),
    requires: ["operations:workorder.write"],
    async execute(input, ctx) {
      const res = await repo.setStandardCost({
        itemId: input.itemCode,
        year: input.year,
        cost: {
          material: input.materialCost,
          labor: input.laborCost,
          overhead: input.overheadCost,
        },
        currency: input.currency.toUpperCase(),
        userId: ctx.principal.userId,
      });
      const toplam = input.materialCost + input.laborCost + input.overheadCost;
      return {
        ok: true as const,
        data: { ...res, itemCode: input.itemCode, year: input.year, unitTotal: toplam },
        sources: [kaynak("Standart maliyetler", 1)],
        risks: [
          {
            severity: "info" as const,
            message: res.created
              ? `${input.itemCode} · ${input.year} standart maliyeti: ` +
                `${TR.format(toplam)} ${input.currency.toUpperCase()}/birim.`
              : `${input.itemCode} · ${input.year} standart maliyeti ` +
                `${TR.format(res.previousTotal ?? 0)} → ${TR.format(toplam)} olarak REVİZE edildi. ` +
                `Revizyon geçmiş sapma raporlarını da değiştirir.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const variance = defineTool({
    name: "get_cost_variance",
    module: "operations",
    authority: 0,
    description: {
      tr:
        "Standart maliyet ile gerçekleşen maliyeti karşılaştırır ve sapmayı " +
        "MALZEME / İŞÇİLİK / GENEL GİDER olarak ayırır. 'Maliyet sapması', " +
        "'bütçelenen maliyeti aştık mı', 'nerede kaybediyoruz' sorularında " +
        "kullan. Standart maliyet tanımlı değilse sapma HESAPLANMAZ — " +
        "karşılaştırılacak bir doğru yoksa fark da yoktur.",
      en: "Compares standard vs actual cost, split by component.",
    },
    input: z.strictObject({
      itemCode: z.string().trim().min(1).max(60).describe("Malzeme kodu."),
      year: z.number().int().min(2000).max(2100).describe("Standart maliyetin yılı."),
      quantity: z.number().positive().describe("Üretilen miktar."),
      actualMaterial: z.number().min(0).describe("Gerçekleşen TOPLAM malzeme maliyeti."),
      actualLabor: z.number().min(0).describe("Gerçekleşen TOPLAM işçilik maliyeti."),
      actualOverhead: z.number().min(0).describe("Gerçekleşen TOPLAM genel üretim gideri."),
    }),
    requires: ["operations:workorder.read"],
    async execute(input) {
      const std = await repo.standardCost(input.itemCode, input.year);
      if (!std) {
        throw new BusinessRuleError(
          `${input.itemCode} için ${input.year} yılı standart maliyeti tanımlı değil. ` +
            `Karşılaştırılacak bir doğru yoksa sapma da yoktur; önce set_standard_cost.`,
          "standard_cost_missing",
        );
      }

      const r = analyzeVariance(input.itemCode, input.quantity, std, {
        material: input.actualMaterial,
        labor: input.actualLabor,
        overhead: input.actualOverhead,
      });

      const kotu = r.components.filter((c) => c.variancePercent !== null && c.variancePercent > 10);
      return {
        ok: true as const,
        data: r,
        sources: [kaynak("Standart maliyetler", 1)],
        risks: [
          {
            severity: r.totalVariance > 0 ? ("warning" as const) : ("info" as const),
            message: r.summary,
          },
          ...(kotu.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `%10'dan fazla sapan bileşenler: ` +
                    kotu.map((c) => `${c.label} (%${c.variancePercent})`).join(", ") +
                    `. Bu büyüklükte bir sapma genelde standardın eskimesinden ya da ` +
                    `süreçte bir değişiklikten gelir.`,
                },
              ]
            : []),
        ],
        confidence: 93,
      };
    },
  });

  const createBin = defineTool({
    name: "create_storage_bin",
    module: "inventory",
    authority: 2,
    description: {
      tr:
        "Bir depoda raf/göz açar: kod, açıklama ve isteğe bağlı kapasite. " +
        "Lokasyon 'hangi depo' sorusunun, raf 'depoda nerede' sorusunun cevabıdır. " +
        "Kapasite bilinmiyorsa null bırakılır — sıfır kapasite 'buraya hiçbir şey " +
        "konamaz' demektir ve o ayrı bir durumdur.",
      en: "Creates a storage bin inside a location.",
    },
    input: z.strictObject({
      locationCode: z.string().trim().min(1).max(60).describe("Depo/lokasyon kodu."),
      code: z.string().trim().min(1).max(40).describe("Raf kodu. Örn. A-01-03."),
      description: z.string().trim().max(200).nullable().describe("Açıklama; yoksa null."),
      capacity: z.number().positive().nullable().describe("Kapasite; bilinmiyorsa null."),
      capacityUom: z.string().trim().max(20).nullable().describe("Kapasite birimi; yoksa null."),
    }),
    requires: ["inventory:movement.write"],
    async execute(input) {
      const res = await repo.createBin(input);
      return {
        ok: true as const,
        data: res,
        sources: [kaynak("Raflar", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.locationCode} · ${res.code} rafı açıldı. Stok hareketlerine raf ` +
              `kodu YAZILDIĞI andan itibaren içeriği birikir; geçmiş hareketler ` +
              `geriye dönük dağıtılmaz.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const binContents = defineTool({
    name: "get_bin_contents",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir depodaki rafların içeriğini ve doluluğunu verir: hangi rafta ne var, " +
        "kapasitenin ne kadarı dolu. Rafı yazılmamış stok AYRICA bildirilir. " +
        "'Bu mal hangi rafta', 'depo doluluk', 'raf durumu' sorularında kullan.",
      en: "Bin-level contents and utilisation for a location.",
    },
    input: z.strictObject({
      locationCode: z.string().trim().min(1).max(60).describe("Depo/lokasyon kodu."),
    }),
    requires: ["inventory:stock.read"],
    async execute(input) {
      const r = await repo.binContents(input.locationCode);
      if (!r) {
        throw new BusinessRuleError(
          `${input.locationCode} kodlu lokasyon yok.`,
          "location_not_found",
        );
      }

      const dolu = r.bins.filter((b) => b.usedPercent !== null && b.usedPercent >= 90);
      return {
        ok: true as const,
        data: r,
        sources: [kaynak("Raflar ve stok hareketleri", r.bins.length)],
        risks: [
          ...(r.bins.length === 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `${input.locationCode} deposunda raf tanımlı değil; stok yalnızca ` +
                    `depo seviyesinde izleniyor.`,
                },
              ]
            : []),
          ...(dolu.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${dolu.length} raf %90'ın üzerinde dolu: ${dolu.map((b) => b.code).join(", ")}.`,
                },
              ]
            : []),
          ...(r.unbinned.itemCount > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${r.unbinned.itemCount} kalem stoğun RAFI YAZILMAMIŞ ` +
                    `(toplam ${r.unbinned.totalQuantity} birim). Bir rafa dağıtılmadı ` +
                    `çünkü dağıtmak uydurma olurdu; fiziksel olarak yerleştirilip ` +
                    `kaydedilmeli.`,
                },
              ]
            : []),
        ],
        confidence: 95,
      };
    },
  });

  return [create, load, setCost, variance, createBin, binContents] as const;
}
