/**
 * Organizasyon yapısı tool'ları.
 *
 * ÇOK TESİSLİ İŞLETMEDE "STOK 4.200" CÜMLESİ HİÇBİR İŞE YARAMAZ.
 * Hangi tesiste olduğu bilinmeden mal bir tesiste birikirken diğeri
 * durur ve kimse fark etmez.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { OrganizationRepository } from "../../db/organization-repository.js";
import { LOCATION_KINDS } from "./organization.js";

export function organizationTools(repo: OrganizationRepository) {
  const tree = defineTool({
    name: "get_organization_tree",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Tesis, depo ve depo yeri hiyerarşisini döndürür. BAĞLANTISIZ LOKASYONLAR " +
        "ayrıca listelenir — bu liste boş olmalıdır; dolu olması, o lokasyondaki " +
        "stoğun tesis raporlarında hiç görünmediği anlamına gelir.",
      en: "Returns the plant/warehouse/storage hierarchy and any orphan locations.",
    },
    input: z.strictObject({}),
    requires: ["master-data:location.read"],
    async execute(_input, _ctx) {
      const t = await repo.tree();
      return {
        ok: true as const,
        data: t,
        sources: [
          {
            system: "Organizasyon yapısı",
            kind: "module" as const,
            recordCount: t.total,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          t.orphans.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${t.orphans.length} lokasyon hiçbir tesise bağlı değil ` +
                    `(${t.orphans.join(", ")}). Buradaki stok tesis raporlarında ` +
                    `GÖRÜNMEZ ve eksikliği ancak sayımda anlaşılır.`,
                },
              ]
            : [],
        confidence: 96,
      };
    },
  });

  const create = defineTool({
    name: "create_location",
    module: "master-data",
    authority: 1,
    description: {
      tr:
        "Tesis, depo veya depo yeri açar. KADEME ATLANAMAZ: depo bir tesise, depo " +
        "yeri bir depoya bağlanmalıdır. Doğrudan tesise bağlanmış bir depo yeri, " +
        "depo bazlı raporlarda hiç görünmez.",
      en: "Creates a plant, warehouse or storage location with hierarchy validation.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(64).describe("Lokasyon kodu — benzersiz."),
      name: z.string().min(2).max(120).describe("Lokasyon adı."),
      kind: z.enum(LOCATION_KINDS).describe("plant | warehouse | storage_location"),
      parentCode: z
        .string()
        .max(64)
        .nullable()
        .describe("Üst lokasyon kodu. Tesiste null olmalıdır."),
    }),
    requires: ["master-data:location.write"],
    async execute(input, _ctx) {
      const n = await repo.create(input);
      return {
        ok: true as const,
        data: n,
        sources: [
          {
            system: "Organizasyon yapısı",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${n.code} açıldı` + (n.parentCode ? ` (${n.parentCode} altında).` : " (tesis)."),
          },
        ],
        confidence: 97,
      };
    },
  });

  const byPlant = defineTool({
    name: "get_stock_by_plant",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir malzemenin TESİS BAZINDA stok bakiyesini döndürür. Tek bir toplam " +
        "rakam, çok tesisli bir işletmede karar verdirmez: mal bir tesiste " +
        "birikirken diğeri durabilir. Tesise bağlanamayan hareketler AYRI sayılır.",
      en: "Returns stock balance broken down by plant.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
    }),
    requires: ["inventory:stock.read"],
    async execute(input, _ctx) {
      const r = await repo.stockByPlant(input.itemCode);
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "Stok hareketleri",
            kind: "module" as const,
            recordCount: r.byPlant.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          r.unassignedQuantity !== 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${r.unassignedQuantity} birim hiçbir tesise bağlanamadı; hareketin ` +
                    `deposu organizasyon yapısında tanımlı değil. Bu miktar tesis ` +
                    `dağılımında GÖRÜNMÜYOR.`,
                },
              ]
            : [],
        confidence: r.unassignedQuantity !== 0 ? 75 : 94,
      };
    },
  });

  return [tree, create, byPlant] as const;
}
