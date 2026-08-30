/**
 * Malzeme kartı tool'ları.
 *
 * OKUMA L0, YAZMA L1. Malzeme açmak yıkıcı bir işlem değil ama ana veriyi
 * değiştirir; iz bırakması ve yetki istemesi gerekir.
 *
 * ÇEVRİM BİLGİSİ CEVABIN PARÇASI. Bir malzemenin kaç birimi olduğu ve
 * çevrim katsayıları, "10 koli kaç adet" sorusunun cevabıdır — kullanıcı
 * bunu ayrıca sormak zorunda kalmamalı.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { ToolOk } from "../../kernel/types.js";
import type { ItemRecord } from "../../db/item-repository.js";
import { ITEM_TYPES, isStocked } from "./item.js";

export interface ItemRepository {
  byCode(code: string): Promise<ItemRecord | null>;
  search(query: string, limit?: number): Promise<readonly ItemRecord[]>;
  create(
    draft: {
      code: string;
      name: string;
      type: string;
      baseUom: string;
      valuationMethod?: string;
      procurementType?: string;
      batchManaged?: boolean;
      shelfLifeDays?: number | null;
      leadTimeDays?: number | null;
    },
    units?: readonly { uom: string; factor: number }[],
    userId?: string,
  ): Promise<ItemRecord>;
}

/** Modele ve ekrana giden biçim — iç kimlik taşınmaz. */
function present(item: ItemRecord) {
  return {
    code: item.code,
    name: item.name,
    type: item.type,
    baseUom: item.baseUom,
    stocked: isStocked(item.type),
    units: item.units.map((u) => ({ uom: u.uom, baseEquivalent: u.factor })),
    batchManaged: item.batchManaged,
    serialManaged: item.serialManaged,
    shelfLifeDays: item.shelfLifeDays,
    procurementType: item.procurementType,
    leadTimeDays: item.leadTimeDays,
    valuationMethod: item.valuationMethod,
    // Maliyet BİLİNMİYORSA null kalır; sıfır maliyet "bedava" demektir.
    unitCost: item.valuationMethod === "standart" ? item.standardCost : item.movingAvgCost,
    costCurrency: item.costCurrency,
  };
}

export function itemTools(repo: ItemRepository) {
  const getItem = defineTool({
    name: "get_item",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Bir malzemenin kartını döndürür: türü, temel ölçü birimi, alternatif birimler ve " +
        "çevrim katsayıları, parti/seri takibi, raf ömrü, tedarik süresi ve birim maliyeti. " +
        "'Bu malzeme nedir', 'kaç adet bir koli', 'parti takipli mi' sorularında kullan.",
      en: "Returns a material master record with units of measure and conversion factors.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Malzeme kodu."),
    }),
    requires: ["master-data:item.read"],
    async execute(input, _ctx): Promise<ToolOk<ReturnType<typeof present> | null>> {
      const item = await repo.byCode(input.code);
      return {
        ok: true,
        data: item ? present(item) : null,
        sources: [
          {
            system: "Malzeme ana verisi",
            kind: "module",
            recordCount: item ? 1 : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: item
          ? []
          : [
              {
                severity: "warning" as const,
                message: `"${input.code}" kodlu malzeme sistemde yok.`,
              },
            ],
        confidence: item ? 98 : 90,
      };
    },
  });

  const searchItems = defineTool({
    name: "search_items",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Malzemeleri koda veya ada göre arar. Türkçe karakter ve büyük/küçük harf farkı " +
        "engel değildir. 'Hangi malzemeler var', 'profil diye ne var' sorularında kullan.",
      en: "Searches materials by code or name (Turkish-aware).",
    },
    input: z.strictObject({
      query: z.string().min(1).max(80).describe("Kod veya adın bir bölümü."),
    }),
    requires: ["master-data:item.read"],
    async execute(input, _ctx) {
      const rows = await repo.search(input.query, 25);
      return {
        ok: true as const,
        data: rows.map(present),
        sources: [
          {
            system: "Malzeme ana verisi",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length === 0
            ? [
                {
                  severity: "info" as const,
                  message: `"${input.query}" için malzeme bulunamadı.`,
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  const createItem = defineTool({
    name: "create_item",
    module: "master-data",
    authority: 1,
    description: {
      tr:
        "Yeni malzeme kartı açar. Temel ölçü birimi ZORUNLUDUR ve sonradan değiştirilemez — " +
        "stok bakiyesi hep o birimdedir. Alternatif birimler çevrim katsayısıyla verilir " +
        "(1 koli = 24 adet ise koli için katsayı 24).",
      en: "Creates a material master record. Base unit is mandatory and immutable.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Malzeme kodu — benzersiz."),
      name: z.string().min(2).max(200).describe("Malzeme adı."),
      type: z
        .enum(ITEM_TYPES)
        .describe("hammadde | yari_mamul | mamul | ticari_mal | hizmet | sarf"),
      baseUom: z.string().min(1).max(16).describe("Temel ölçü birimi: adet, kg, m, lt…"),
      procurementType: z
        .enum(["satin_alma", "uretim", "her_ikisi"])
        .describe("Nasıl tedarik edilir?"),
      batchManaged: z.boolean().describe("Parti (lot) takibi yapılsın mı?"),
      shelfLifeDays: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("Raf ömrü (gün). Yoksa null. Parti takibi gerektirir."),
      leadTimeDays: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe("Tedarik süresi (gün). Bilinmiyorsa null."),
      units: z
        .array(
          z.strictObject({
            uom: z.string().min(1).max(16),
            factor: z.number().positive().describe("1 bu birim = kaç temel birim."),
          }),
        )
        .describe("Alternatif ölçü birimleri. Yoksa boş dizi."),
    }),
    requires: ["master-data:item.write"],
    async execute(input, ctx) {
      const item = await repo.create(
        {
          code: input.code,
          name: input.name,
          type: input.type,
          baseUom: input.baseUom,
          procurementType: input.procurementType,
          batchManaged: input.batchManaged,
          shelfLifeDays: input.shelfLifeDays,
          leadTimeDays: input.leadTimeDays,
        },
        input.units,
        // DEĞİŞİKLİĞİ KİMİN YAPTIĞI KAYDA GEÇER. Geçmezse "bu kartı kim
        // açmış" sorusunun cevabı olmaz.
        ctx.principal.userId,
      );

      return {
        ok: true as const,
        data: present(item),
        sources: [
          {
            system: "Malzeme ana verisi",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `"${item.code}" açıldı. Temel birim "${item.baseUom}" ARTIK DEĞİŞTİRİLEMEZ; ` +
              `stok bakiyesi her zaman bu birimdedir.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  return [getItem, searchItems, createItem] as const;
}
