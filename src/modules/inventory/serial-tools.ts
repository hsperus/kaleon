/**
 * Seri numarası tool'ları.
 *
 * Müşteri "benim aldığım cihaz" der; parti numarası onu göstermez.
 * Seri izleme, tek bir nesnenin geçmişini tek sorguyla verir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { SerialRepository } from "../../db/serial-repository.js";
import { SERIAL_STATES } from "./serial.js";

export function serialTools(repo: SerialRepository) {
  const create = defineTool({
    name: "create_serial_number",
    module: "inventory",
    authority: 1,
    description: {
      tr:
        "Seri numarası açar. SERİ TAKİPSİZ MALZEMEYE SERİ AÇILMAZ; açılsaydı bazı " +
        "ürünler serili bazıları serisiz olur ve izleme yarım kalırdı. Garanti " +
        "süresi burada tanımlanır ve sevk tarihinden itibaren işler.",
      en: "Registers a serial number for a serial-managed item.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      serial: z.string().min(3).max(64).describe("Seri numarası."),
      batchId: z.string().max(64).nullable().describe("Hangi partiden çıktı. Yoksa null."),
      producedAt: z.string().nullable().describe("Üretim tarihi (ISO 8601). Yoksa null."),
      warrantyMonths: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("Garanti süresi (ay). Yoksa null — kapsam belirlenemez."),
    }),
    requires: ["inventory:serial.write"],
    async execute(input, _ctx) {
      const r = await repo.create({
        itemCode: input.itemCode,
        serial: input.serial,
        batchId: input.batchId,
        producedAt: input.producedAt ? new Date(input.producedAt) : null,
        warrantyMonths: input.warrantyMonths,
      });
      return {
        ok: true as const,
        data: { itemCode: input.itemCode, serial: r.serial },
        sources: [
          {
            system: "Seri numaraları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          input.warrantyMonths === null
            ? [
                {
                  severity: "info" as const,
                  message:
                    "Garanti süresi tanımlanmadı; bu ürün için garanti kapsamı " +
                    "belirlenemeyecek.",
                },
              ]
            : [],
        confidence: 97,
      };
    },
  });

  const trace = defineTool({
    name: "trace_serial_number",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir seri numarasının TAM GEÇMİŞİNİ döndürür: üretim tarihi, hangi partiden " +
        "çıktı, hangi irsaliyeyle kime gitti ve GARANTİ DURUMU. Servis çağrısında " +
        "ilk bakılacak yer burasıdır. Sevk tarihi bilinmiyorsa garanti 'yok' değil " +
        "'bilinmiyor' der.",
      en: "Returns the full history of a serial number including warranty status.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      serial: z.string().min(1).max(64).describe("Seri numarası."),
    }),
    requires: ["inventory:serial.read"],
    async execute(input, ctx) {
      const t = await repo.trace(input.itemCode, input.serial, ctx.now());
      return {
        ok: true as const,
        data: t,
        sources: [
          {
            system: "Seri numaraları",
            kind: "module" as const,
            recordCount: t ? 1 : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: !t
          ? [
              {
                severity: "warning" as const,
                message: `"${input.itemCode}" için "${input.serial}" seri numarası kayıtlı değil.`,
              },
            ]
          : t.warranty.covered === null
            ? [{ severity: "warning" as const, message: t.warranty.explanation }]
            : t.warranty.covered === false
              ? [{ severity: "info" as const, message: t.warranty.explanation }]
              : [],
        confidence: t ? 96 : 90,
      };
    },
  });

  const setState = defineTool({
    name: "set_serial_state",
    module: "inventory",
    authority: 1,
    description: {
      tr:
        "Seri numarasının durumunu değiştirir: stokta, sevk edildi, serviste, hurda. " +
        "HURDAYA AYRILAN SERİ GERİ DÖNEMEZ. Sevk edilmiş seri doğrudan stoğa " +
        "dönemez; iade ediliyorsa önce servise alınmalıdır.",
      en: "Changes a serial number's state with transition validation.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).max(64).describe("Malzeme kodu."),
      serial: z.string().min(1).max(64).describe("Seri numarası."),
      state: z.enum(SERIAL_STATES).describe("Yeni durum."),
      note: z.string().max(300).nullable().describe("Açıklama. Yoksa null."),
    }),
    requires: ["inventory:serial.write"],
    async execute(input, _ctx) {
      await repo.setState(input.itemCode, input.serial, input.state, input.note);
      return {
        ok: true as const,
        data: { itemCode: input.itemCode, serial: input.serial, state: input.state },
        sources: [
          {
            system: "Seri numaraları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          input.state === "hurda"
            ? [
                {
                  severity: "warning" as const,
                  message: "Hurdaya ayrıldı; bu seri numarası bir daha kullanılamaz.",
                },
              ]
            : [],
        confidence: 97,
      };
    },
  });

  const byCustomer = defineTool({
    name: "list_customer_serials",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Bir müşteriye giden tüm seri numaralarını listeler. Servis çağrısında " +
        "'bu müşteride hangi cihazlarımız var' sorusunun cevabıdır.",
      en: "Lists all serial numbers shipped to a customer.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Müşteri kimliği."),
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["inventory:serial.read"],
    async execute(input, _ctx) {
      const rows = await repo.byPartner(input.partnerId, input.limit);
      return {
        ok: true as const,
        data: { partnerId: input.partnerId, serials: rows },
        sources: [
          {
            system: "Seri numaraları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 95,
      };
    },
  });

  const expiring = defineTool({
    name: "list_expiring_warranties",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Garantisi bitmek üzere olan veya biten serileri listeler. Garanti bitimi " +
        "bir satış fırsatıdır (bakım anlaşması) ve bir risktir (garanti sonrası " +
        "ücretlendirme tartışması).",
      en: "Lists serials whose warranty is expiring or expired.",
    },
    input: z.strictObject({
      withinDays: z.number().int().max(3650).describe("Kaç gün içinde bitecekler. Bitenler için negatif verilebilir."),
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["inventory:serial.read"],
    async execute(input, ctx) {
      const rows = await repo.warrantyExpiring(ctx.now(), input.withinDays, input.limit);
      const expired = rows.filter((r) => (r.daysRemaining ?? 0) <= 0);
      return {
        ok: true as const,
        data: { serials: rows, expiredCount: expired.length },
        sources: [
          {
            system: "Seri numaraları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length > 0
            ? [
                {
                  severity: "info" as const,
                  message:
                    `${rows.length} ürünün garantisi ${input.withinDays} gün içinde ` +
                    `bitiyor veya bitti (${expired.length} tanesi geçmiş). Bakım anlaşması ` +
                    `için fırsat, ücretlendirme tartışması için risk.`,
                },
              ]
            : [],
        confidence: 94,
      };
    },
  });

  return [create, trace, setState, byCustomer, expiring] as const;
}
