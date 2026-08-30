/**
 * Ana veri değişiklik belgesi tool'ları.
 *
 * "BU FİYAT NEDEN DEĞİŞMİŞ" SORUSUNUN CEVABI BURADADIR. KAELON'un iddiası
 * kurumsal hafıza olmaktır; hafıza, değişimin kendisini değil DEĞİŞİMİN
 * HİKÂYESİNİ tutmaktır — neyin neye, ne zaman, kim tarafından.
 *
 * AKTÖRÜ BİLİNMEYEN DEĞİŞİKLİKLER AYRICA SAYILIR. Sıfır olması beklenmez
 * (doğrudan SQL ile yapılan bir düzeltme de meşrudur), ama sayısının
 * artması, iz bırakmayan bir yazma yolu olduğunun işaretidir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { ChangeLogRepository } from "../../db/change-log.js";

/** Kullanıcıya gösterilen alan adları — kolon adı değil. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Ad",
  legal_name: "Unvan",
  type: "Tür",
  base_uom: "Temel birim",
  valuation_method: "Değerleme yöntemi",
  standard_cost: "Standart maliyet",
  moving_avg_cost: "Hareketli ortalama maliyet",
  batch_managed: "Parti takibi",
  serial_managed: "Seri takibi",
  shelf_life_days: "Raf ömrü (gün)",
  lead_time_days: "Tedarik süresi (gün)",
  procurement_type: "Tedarik türü",
  reorder_point: "Sipariş noktası",
  safety_stock: "Emniyet stoğu",
  is_active: "Aktif",
  gross_salary: "Brüt ücret",
  department: "Departman",
  position: "Görev",
  hired_at: "İşe giriş",
  terminated_at: "İşten çıkış",
  birth_date: "Doğum tarihi",
  is_customer: "Müşteri",
  is_supplier: "Tedarikçi",
  "*": "Kaydın tamamı",
};

const OBJECT_TYPES = ["items", "partners", "employees"] as const;

function label(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function changeTools(repo: ChangeLogRepository) {
  const history = defineTool({
    name: "get_change_history",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Bir ana veri kaydının değişiklik geçmişini döndürür: hangi alan, neyden " +
        "neye, ne zaman ve kim tarafından. Malzeme, cari ve personel kartları " +
        "izlenir. 'Bu fiyat neden değişmiş', 'vergi numarasını kim düzeltmiş' " +
        "sorularında kullan.",
      en: "Returns the change history of a master data record (field, old, new, who, when).",
    },
    input: z.strictObject({
      objectType: z.enum(OBJECT_TYPES).describe("items | partners | employees"),
      objectCode: z.string().min(1).max(64).describe("Kaydın kodu."),
      field: z
        .string()
        .max(64)
        .nullable()
        .describe("Yalnızca bir alanın geçmişi isteniyorsa alan adı. Tümü için null."),
    }),
    requires: ["master-data:change.read"],
    async execute(input, _ctx) {
      const rows = input.field
        ? await repo.fieldHistory(input.objectType, input.objectCode, input.field)
        : await repo.historyOf(input.objectType, input.objectCode);

      const unattributed = rows.filter((r) => r.changedBy === null).length;

      return {
        ok: true as const,
        data: {
          objectType: input.objectType,
          objectCode: input.objectCode,
          changes: rows.map((r) => ({
            field: r.field,
            fieldLabel: label(r.field),
            from: r.oldValue,
            to: r.newValue,
            operation: r.operation,
            changedBy: r.changedBy,
            changedAt: r.changedAt,
          })),
        },
        sources: [
          {
            system: "Ana veri değişiklik belgesi",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(rows.length === 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `"${input.objectCode}" için değişiklik kaydı yok. Kayıt hiç ` +
                    `değişmemiş olabilir ya da izleme başlamadan önce oluşmuş olabilir.`,
                },
              ]
            : []),
          ...(unattributed > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${unattributed} değişikliğin kimin yaptığı bilinmiyor; doğrudan ` +
                    `veritabanı üzerinden yapılmış olabilir.`,
                },
              ]
            : []),
        ],
        confidence: 96,
      };
    },
  });

  const recent = defineTool({
    name: "list_recent_master_data_changes",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Belirli bir tarih aralığında yapılan tüm ana veri değişikliklerini listeler. " +
        "Dönem kapanışında ve denetimde 'bu ay ana veride ne değişti' sorusuna cevap verir.",
      en: "Lists all master data changes within a date range.",
    },
    input: z.strictObject({
      from: z.string().describe("Başlangıç (ISO 8601)."),
      to: z.string().describe("Bitiş (ISO 8601)."),
      limit: z.number().int().positive().max(500).describe("Kaç kayıt döndürülsün."),
    }),
    requires: ["master-data:change.read"],
    async execute(input, _ctx) {
      const from = new Date(input.from);
      const to = new Date(input.to);
      const [rows, unknown] = await Promise.all([
        repo.recent(from, to, input.limit),
        repo.unattributed(from, to),
      ]);

      return {
        ok: true as const,
        data: {
          from: input.from,
          to: input.to,
          changes: rows.map((r) => ({
            objectType: r.objectType,
            objectCode: r.objectCode,
            field: r.field,
            fieldLabel: label(r.field),
            from: r.oldValue,
            to: r.newValue,
            changedBy: r.changedBy,
            changedAt: r.changedAt,
          })),
        },
        sources: [
          {
            system: "Ana veri değişiklik belgesi",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          unknown > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `Bu aralıkta ${unknown} değişikliğin aktörü bilinmiyor. Sayının ` +
                    `artması, iz bırakmayan bir yazma yolu olduğunun işaretidir.`,
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  return [history, recent] as const;
}
