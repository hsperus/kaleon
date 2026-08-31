/**
 * Kalite yönetimi tool'ları.
 *
 * ALTI TOOL:
 *   create_inspection_plan     → hangi özellik, hangi toleransla
 *   get_inspection_plan        → planı oku
 *   record_inspection_result   → ölç, karar TÜRETİLİR (L2)
 *   list_open_nonconformances  → açık uygunsuzluklar
 *   close_nonconformance       → kök neden + DÖF ile kapat (L2)
 *   build_certificate_of_analysis → müşteriye giden CoA
 *
 * `open_nonconformance` AYRI BİR TOOL DEĞİL: muayene sapınca sistem
 * kendisi açıyor. Elle açmaya bırakılsaydı en yoğun günlerde
 * unutulurdu — ve en çok sapan günler en yoğun günlerdir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { evaluateLot, InspectionError } from "./inspection.js";
import type { QualityRepository } from "../../db/quality-repository.js";

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

function tarih(s: string, alan: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BusinessRuleError(`${alan}: "${s}" geçerli bir tarih değil.`, "invalid_date");
  }
  return d;
}

export function inspectionTools(repo: QualityRepository) {
  const createPlan = defineTool({
    name: "create_inspection_plan",
    module: "quality",
    authority: 2,
    description: {
      tr:
        "Kontrol planı oluşturur: bir ürün için hangi özelliğin, hangi toleransla, " +
        "hangi aşamada (mal kabul / üretim içi / sevkiyat öncesi) ölçüleceğini " +
        "tanımlar. Sayısal özellikte en az bir sınır zorunlu; tek yönlü tolerans " +
        "olabilir ('en az 45 HRC'). KRİTİK işaretlenen özellik saparsa parti " +
        "reddedilir, şartlı kabul edilemez.",
      en: "Creates an inspection plan with characteristics and tolerances.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Plan kodu, benzersiz."),
      itemCode: z.string().trim().min(1).max(60).describe("Hangi malzeme için."),
      name: z.string().trim().min(2).max(160).describe("Plan adı."),
      stage: z
        .enum(["incoming", "in-process", "final"])
        .describe("incoming: mal kabul · in-process: üretim içi · final: sevkiyat öncesi."),
      characteristics: z
        .array(
          z.strictObject({
            seq: z.number().int().positive().describe("Sıra numarası."),
            name: z.string().trim().min(1).max(120).describe("Özellik adı. Örn. Sertlik."),
            kind: z.enum(["numeric", "attribute"]).describe("numeric: ölçülür · attribute: bakılır."),
            uom: z.string().trim().max(20).nullable().describe("Birim (HRC, mm, µm); nitelikte null."),
            lowerLimit: z.number().nullable().describe("Alt sınır; yoksa null."),
            upperLimit: z.number().nullable().describe("Üst sınır; yoksa null."),
            method: z.string().trim().max(160).nullable().describe("Ölçüm yöntemi/cihaz; yoksa null."),
            isCritical: z.boolean().describe("Kritik mi? Kritikte şartlı kabul YOKTUR."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Ölçülecek özellikler."),
    }),
    requires: ["quality:decision.write"],
    async execute(input, ctx) {
      for (const c of input.characteristics) {
        if (c.kind === "numeric" && c.lowerLimit === null && c.upperLimit === null) {
          throw new BusinessRuleError(
            `"${c.name}" sayısal bir özellik ama hiç sınırı yok. İkisi de boş olan ` +
              `bir özellik hiçbir şey ölçmez; kontrol planında yer kaplamaktan ` +
              `başka bir şey yapmaz.`,
            "characteristic_no_limits",
          );
        }
        if (c.lowerLimit !== null && c.upperLimit !== null && c.lowerLimit > c.upperLimit) {
          throw new BusinessRuleError(
            `"${c.name}": alt sınır (${c.lowerLimit}) üst sınırdan (${c.upperLimit}) büyük. ` +
              `Ters girilmiş bir tolerans her ölçümü "kaldı" yapar ve kimse sebebini anlamaz.`,
            "characteristic_range_inverted",
          );
        }
      }

      const res = await repo.createPlan({
        code: input.code,
        itemId: input.itemCode,
        name: input.name,
        stage: input.stage,
        characteristics: input.characteristics,
        userId: ctx.principal.userId,
      });

      const kritik = input.characteristics.filter((c) => c.isCritical).length;
      return {
        ok: true as const,
        data: { ...res, itemCode: input.itemCode, stage: input.stage, criticalCount: kritik },
        sources: [kaynak("Kontrol planları", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.code} kontrol planı açıldı: ${res.characteristicCount} özellik` +
              (kritik > 0 ? `, ${kritik} tanesi KRİTİK.` : "."),
          },
        ],
        confidence: 99,
      };
    },
  });

  const getPlan = defineTool({
    name: "get_inspection_plan",
    module: "quality",
    authority: 0,
    description: {
      tr:
        "Bir kontrol planını ya da bir ürünün tüm planlarını döndürür: özellikler, " +
        "toleranslar ve hangi aşamada uygulandığı. 'Bu ürünü nasıl kontrol " +
        "ediyoruz', 'kontrol planı', 'tolerans nedir' sorularında kullan.",
      en: "Returns an inspection plan or all plans for an item.",
    },
    input: z.strictObject({
      planCode: z.string().trim().max(40).nullable().describe("Plan kodu; ürünün tüm planları için null."),
      itemCode: z.string().trim().max(60).nullable().describe("Malzeme kodu; tek plan sorgusunda null."),
    }),
    requires: ["quality:decision.read"],
    async execute(input) {
      if (input.planCode === null && input.itemCode === null) {
        throw new BusinessRuleError(
          "Plan kodu ya da malzeme kodundan biri verilmelidir.",
          "missing_key",
        );
      }
      const planlar = input.planCode
        ? [await repo.plan(input.planCode)].filter((p) => p !== null)
        : await repo.plansForItem(input.itemCode!);

      return {
        ok: true as const,
        data: {
          found: planlar.length > 0,
          total: planlar.length,
          message: planlar.length === 0 ? "Bu ürün/kod için kontrol planı tanımlı değil." : "",
          plans: planlar,
        },
        sources: [kaynak("Kontrol planları", planlar.length)],
        risks:
          planlar.length === 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Kontrol planı yok. Planı olmayan bir ürün için muayene kaydı " +
                    "açılamaz ve sertifika üretilemez.",
                },
              ]
            : [],
        confidence: 96,
      };
    },
  });

  const record = defineTool({
    name: "record_inspection_result",
    module: "quality",
    authority: 2,
    description: {
      tr:
        "Muayene sonucunu kaydeder: her özellik için ölçülen değer. GEÇTİ/KALDI " +
        "KARARI ELLE GİRİLMEZ, toleranstan TÜRETİLİR. Planda kaç özellik varsa " +
        "hepsi ölçülmelidir. Tolerans dışı bir sonuç çıkarsa sistem UYGUNSUZLUK " +
        "KAYDINI KENDİSİ AÇAR. Kritik özellik saparsa parti reddedilir; kritik " +
        "olmayan sapmada şartlı kabul mümkündür.",
      en: "Records inspection measurements; the pass/fail verdict is derived from tolerances.",
    },
    input: z.strictObject({
      planCode: z.string().trim().min(1).max(40).describe("Kontrol planı kodu."),
      batchNo: z.string().trim().max(64).nullable().describe("Parti numarası; yoksa null."),
      serialNo: z.string().trim().max(64).nullable().describe("Seri numarası; yoksa null."),
      referenceDoc: z.string().trim().max(64).nullable().describe("İlgili belge (irsaliye, iş emri); yoksa null."),
      quantity: z.number().positive().describe("Muayene edilen miktar."),
      inspectedAt: z.string().describe("Muayene tarihi (ISO 8601)."),
      note: z.string().max(300).nullable().describe("Genel not; yoksa null."),
      measurements: z
        .array(
          z.strictObject({
            characteristicName: z.string().trim().min(1).max(120).describe("Özelliğin adı (plandaki gibi)."),
            measured: z.number().nullable().describe("Ölçülen değer; nitelik özelliğinde null."),
            conforms: z.boolean().nullable().describe("Nitelik özelliğinde uygun mu; sayısalda null."),
            note: z.string().max(200).nullable().describe("Satır notu; yoksa null."),
          }),
        )
        .min(1)
        .max(50)
        .describe("Her özellik için bir satır."),
    }),
    requires: ["quality:decision.write"],
    async execute(input, ctx) {
      const plan = await repo.plan(input.planCode);
      if (!plan) {
        throw new BusinessRuleError(
          `${input.planCode} kodlu kontrol planı yok.`,
          "plan_not_found",
        );
      }
      if (input.batchNo === null && input.serialNo === null && input.referenceDoc === null) {
        throw new BusinessRuleError(
          "Muayene bir şeye bağlanmalı: parti, seri ya da belge numarası. Hiçbirine " +
            "bağlanmayan bir sonuç, sonradan hangi mala ait olduğu bilinemeyen bir kayıttır.",
          "inspection_target_required",
        );
      }

      // Ad → kimlik: kullanıcı UUID değil özellik adı yazar.
      const adaGore = new Map(plan.characteristics.map((c) => [c.name.toLocaleLowerCase("tr"), c]));
      const olcumler = input.measurements.map((m) => {
        const c = adaGore.get(m.characteristicName.toLocaleLowerCase("tr"));
        if (!c) {
          throw new BusinessRuleError(
            `"${m.characteristicName}" bu planda yok. Plandaki özellikler: ` +
              `${plan.characteristics.map((x) => x.name).join(", ")}.`,
            "characteristic_not_found",
          );
        }
        return { characteristicId: c.id, measured: m.measured, conforms: m.conforms, note: m.note };
      });

      let sonuc;
      try {
        sonuc = evaluateLot(plan.characteristics, olcumler);
      } catch (e) {
        if (e instanceof InspectionError) {
          throw new BusinessRuleError(e.message, "inspection_incomplete");
        }
        throw e;
      }

      const at = tarih(input.inspectedAt, "inspectedAt");
      const no = await repo.nextLotNo(at.getUTCFullYear());

      /*
       * SAPMA VARSA UYGUNSUZLUK OTOMATİK AÇILIR.
       *
       * Şiddet sapmanın türünden geliyor: kritik özellik → critical,
       * birden çok sapma → major, tek sapma → minor. Kullanıcıya
       * sorulsaydı en yoğun günde en düşük şiddet seçilirdi.
       */
      const ncr =
        sonuc.failedCount === 0
          ? null
          : {
              documentNo: await repo.nextNcrNo(at.getUTCFullYear()),
              description: sonuc.results
                .filter((r) => !r.conforms)
                .map((r) => r.deviation)
                .join(" · "),
              severity:
                sonuc.criticalFailedCount > 0 ? "critical" : sonuc.failedCount > 1 ? "major" : "minor",
            };

      const res = await repo.recordInspection({
        documentNo: no,
        planId: plan.id,
        itemId: plan.itemId,
        batchNo: input.batchNo,
        serialNo: input.serialNo,
        referenceDoc: input.referenceDoc,
        quantity: input.quantity,
        inspectedAt: at,
        userId: ctx.principal.userId,
        result: sonuc.result,
        note: input.note,
        results: sonuc.results.map((r) => ({
          characteristicId: r.characteristicId,
          measured: r.measured,
          conforms: r.conforms,
          note: r.deviation,
        })),
        ncr,
      });

      return {
        ok: true as const,
        data: {
          documentNo: res.documentNo,
          result: sonuc.result,
          nonconformanceNo: res.ncrNo,
          measurements: sonuc.results,
          summary: sonuc.summary,
        },
        sources: [kaynak("Muayeneler", 1)],
        risks: [
          {
            severity:
              sonuc.result === "failed"
                ? ("critical" as const)
                : sonuc.result === "conditional"
                  ? ("warning" as const)
                  : ("info" as const),
            message:
              `${res.documentNo}: ${sonuc.summary}` +
              (res.ncrNo ? ` Uygunsuzluk kaydı ${res.ncrNo} açıldı.` : ""),
          },
        ],
        confidence: 98,
      };
    },
  });

  const listNcr = defineTool({
    name: "list_open_nonconformances",
    module: "quality",
    authority: 0,
    description: {
      tr:
        "Açık uygunsuzlukları listeler: en ağır ve en eski başta. 'Açık kalite " +
        "sorunları', 'uygunsuzluklar', 'DÖF' sorularında kullan.",
      en: "Lists open nonconformances, most severe and oldest first.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(100).describe("Kaç kayıt döndürülsün."),
    }),
    requires: ["quality:decision.read"],
    async execute(input) {
      const rows = await repo.openNonconformances(input.limit);
      const kritik = rows.filter((r) => r.severity === "critical");
      const eski = rows.filter((r) => r.ageDays > 30);

      return {
        ok: true as const,
        data: { total: rows.length, criticalCount: kritik.length, nonconformances: rows },
        sources: [kaynak("Uygunsuzluklar", rows.length)],
        risks: [
          ...(kritik.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${kritik.length} KRİTİK uygunsuzluk açık. En eskisi ` +
                    `${kritik[0]!.ageDays} günlük: ${kritik[0]!.description.slice(0, 100)}`,
                },
              ]
            : []),
          ...(eski.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${eski.length} uygunsuzluk 30 günden uzun süredir açık. Kapanmayan ` +
                    `bir uygunsuzluk, çözülmemiş bir sorundur — kayıt onu çözmez.`,
                },
              ]
            : []),
        ],
        confidence: 97,
      };
    },
  });

  const closeNcr = defineTool({
    name: "close_nonconformance",
    module: "quality",
    authority: 2,
    description: {
      tr:
        "Bir uygunsuzluğu kapatır. KÖK NEDEN VE DÜZELTİCİ FAALİYET ZORUNLUDUR: " +
        "sebebini yazmadan kapatmak, aynı hatanın üç ay sonra tekrar etmesini " +
        "garanti eder. Maliyet (hurda, yeniden işleme) girilirse kalite maliyeti " +
        "raporlanabilir.",
      en: "Closes a nonconformance; root cause and corrective action are mandatory.",
    },
    input: z.strictObject({
      documentNo: z.string().trim().min(1).max(40).describe("Uygunsuzluk belge numarası."),
      rootCause: z.string().trim().min(10).max(1000).describe("KÖK NEDEN — neden oldu, belirtisi değil sebebi."),
      correctiveAction: z.string().trim().min(10).max(1000).describe("Düzeltici faaliyet — tekrarı nasıl önlenecek."),
      costAmount: z.number().min(0).nullable().describe("Uygunsuzluğun maliyeti; bilinmiyorsa null."),
      closedAt: z.string().describe("Kapanış tarihi (ISO 8601)."),
    }),
    requires: ["quality:decision.write"],
    async execute(input, ctx) {
      const res = await repo.closeNonconformance({
        documentNo: input.documentNo,
        rootCause: input.rootCause,
        correctiveAction: input.correctiveAction,
        costAmount: input.costAmount,
        userId: ctx.principal.userId,
        at: tarih(input.closedAt, "closedAt"),
      });
      return {
        ok: true as const,
        data: { ...res, costAmount: input.costAmount },
        sources: [kaynak("Uygunsuzluklar", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.documentNo} kapatıldı (${res.ageDays} gün açık kaldı). Kök neden ve ` +
              `düzeltici faaliyet kayda geçti.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const coa = defineTool({
    name: "build_certificate_of_analysis",
    module: "quality",
    authority: 0,
    description: {
      tr:
        "Analiz sertifikası (CoA) verisi üretir: bir parti ya da serinin muayene " +
        "ölçümleri, toleransları ve sonucu. Müşteri sertifika istediğinde kullan. " +
        "Muayene kaydı yoksa sertifika ÜRETİLMEZ — ölçüm olmadan sertifika, " +
        "imzalanmış bir varsayımdır.",
      en: "Builds certificate-of-analysis data from recorded inspections.",
    },
    input: z.strictObject({
      batchNo: z.string().trim().max(64).nullable().describe("Parti numarası."),
      serialNo: z.string().trim().max(64).nullable().describe("Seri numarası."),
    }),
    requires: ["quality:decision.read"],
    async execute(input) {
      if (input.batchNo === null && input.serialNo === null) {
        throw new BusinessRuleError(
          "Parti ya da seri numarasından biri verilmelidir.",
          "missing_key",
        );
      }
      const lots = await repo.lotsFor({
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
        ...(input.serialNo ? { serialNo: input.serialNo } : {}),
      });

      return {
        ok: true as const,
        data: {
          found: lots.length > 0,
          message:
            lots.length === 0
              ? "Bu parti/seri için muayene kaydı yok; sertifika üretilemez."
              : "",
          batchNo: input.batchNo,
          serialNo: input.serialNo,
          inspections: lots,
        },
        sources: [kaynak("Muayeneler", lots.length)],
        risks:
          lots.length === 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Muayene kaydı bulunamadı. Ölçüm olmadan sertifika üretmek, " +
                    "imzalanmış bir varsayım üretmektir.",
                },
              ]
            : lots.some((l) => l.result !== "passed")
              ? [
                  {
                    severity: "warning" as const,
                    message:
                      "Bu parti/serinin muayenelerinden en az biri TAM GEÇMEDİ. " +
                      "Sertifikada sapma görünecektir; müşteriye gönderilmeden önce " +
                      "okunmalı.",
                  },
                ]
              : [],
        confidence: lots.length > 0 ? 97 : 90,
      };
    },
  });

  return [createPlan, getPlan, record, listNcr, closeNcr, coa] as const;
}
