/**
 * İçe aktarma tool'ları.
 *
 * NEDEN TOOL, NEDEN AYRI BİR EKRAN DEĞİL:
 * KAELON sohbet tabanlıdır. "Şu dosyadaki carileri sisteme al" cümlesi,
 * dört adımlı bir sihirbazdan hızlıdır. Ama sohbet kolaylığı, yazmadan önce
 * göstermeyi ORTADAN KALDIRMAZ — iki ayrı tool bunu garanti eder.
 *
 * ÖNİZLEME L0, YAZMA L2. Bu ayrım tesadüf değil:
 *   - `preview_partner_import` hiçbir şey yazmaz, okuma yetkisi yeter.
 *   - `commit_partner_import` ana veriyi değiştirir; insan onayı gerektiren
 *     yetki seviyesindedir ve yalnızca yetkili roller çağırabilir.
 * Model önizlemeyi kendi başına çalıştırıp raporu gösterebilir; yazmayı
 * kullanıcının onayı olmadan yapamaz.
 *
 * DOSYA İÇERİĞİ MODELDEN GEÇMEZ. Model dosyanın KİMLİĞİNİ taşır; içerik
 * sunucuda kalır. Dört bin satırlık bir CSV'yi modele göndermek hem çok
 * pahalıdır hem de gereksizdir: ayrıştırma ve doğrulama deterministik
 * koddur, modelin katkısı yoktur.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { ToolOk } from "../../kernel/types.js";
import { parseCsv } from "./csv.js";
import { previewPartnerImport, type ImportPreview } from "./partners.js";

/**
 * Yüklenen dosyaların geçici deposu.
 *
 * Dosya önce yüklenir, sonra konuşulur. Aradaki bekleme sınırlıdır:
 * yüklenmiş ama hiç kullanılmamış dosyalar bellekte birikmemelidir.
 */
export interface UploadStore {
  get(uploadId: string, tenantId: string): Promise<{ filename: string; content: string } | null>;
}

export interface ImportCommitter {
  classify(rows: readonly import("./partners.js").PartnerImportRow[]): Promise<{
    toCreate: readonly import("./partners.js").PartnerImportRow[];
    toUpdate: readonly import("./partners.js").PartnerImportRow[];
  }>;
  commit(
    rows: readonly import("./partners.js").PartnerImportRow[],
  ): Promise<import("../../db/partner-import.js").ImportOutcome>;
}

export interface ImportDeps {
  readonly uploads: UploadStore;
  /** Tenant'a bağlı yazıcıyı üretir. */
  readonly importerFor: (tenantId: string) => ImportCommitter;
}

/** Modele dönen özet — satırların tamamı DEĞİL. */
interface PreviewSummary {
  readonly filename: string;
  readonly totalRows: number;
  readonly validCount: number;
  readonly errorCount: number;
  readonly newCount: number;
  readonly updateCount: number;
  readonly detectedColumns: Readonly<Record<string, string | null>>;
  /** İlk birkaç hata — hepsini modele taşımak gereksiz ve pahalı. */
  readonly sampleErrors: readonly { line: number; field: string; message: string }[];
  readonly sampleRows: readonly { code: string; legalName: string; taxId: string | null }[];
}

const MAX_SAMPLES = 5;

function summarize(
  filename: string,
  preview: ImportPreview,
  counts: { newCount: number; updateCount: number },
): PreviewSummary {
  return {
    filename,
    totalRows: preview.totalRows,
    validCount: preview.valid.length,
    errorCount: preview.errors.length,
    newCount: counts.newCount,
    updateCount: counts.updateCount,
    detectedColumns: preview.detectedColumns,
    sampleErrors: preview.errors.slice(0, MAX_SAMPLES),
    sampleRows: preview.valid.slice(0, MAX_SAMPLES).map((r) => ({
      code: r.code,
      legalName: r.legalName,
      taxId: r.taxId?.value ?? null,
    })),
  };
}

export function importTools(deps: ImportDeps) {
  const preview = defineTool({
    name: "preview_partner_import",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Yüklenmiş bir cari listesi dosyasını (CSV/Excel dışa aktarımı) OKUR ve ne olacağını raporlar: " +
        "kaç satır geçerli, kaç satır hatalı, kaç yeni kart açılacak, kaç mevcut kart güncellenecek. " +
        "HİÇBİR ŞEY YAZMAZ. Kullanıcı 'şu dosyadaki carileri al' dediğinde ÖNCE bunu çağır.",
      en: "Reads an uploaded partner list file and reports what an import would do. Writes nothing.",
    },
    input: z.strictObject({
      uploadId: z.string().min(1).describe("Yüklenen dosyanın kimliği."),
      externalSystem: z
        .string()
        .min(1)
        .nullable()
        .describe("Entegratör kodu sütunu hangi sisteme ait? Bilinmiyorsa null."),
    }),
    requires: ["master-data:partner.read"],
    async execute(input, ctx): Promise<ToolOk<PreviewSummary>> {
      const file = await deps.uploads.get(input.uploadId, ctx.tenant.tenantId);
      if (!file) throw new Error(`Yüklenmiş dosya bulunamadı: ${input.uploadId}`);

      const result = previewPartnerImport(parseCsv(file.content), {
        ...(input.externalSystem ? { externalSystem: input.externalSystem } : {}),
      });
      const { toCreate, toUpdate } = await deps
        .importerFor(ctx.tenant.tenantId)
        .classify(result.valid);

      const summary = summarize(file.filename, result, {
        newCount: toCreate.length,
        updateCount: toUpdate.length,
      });

      return {
        ok: true,
        data: summary,
        sources: [
          {
            system: `Yüklenen dosya: ${file.filename}`,
            kind: "manual",
            recordCount: result.totalRows,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          result.errors.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${result.errors.length} satır içe aktarılamayacak. ` +
                    `Bu satırlar ATLANIR, dosyanın geri kalanı aktarılabilir.`,
                },
              ]
            : [],
        confidence: result.errors.length === 0 ? 95 : 80,
      };
    },
  });

  const commit = defineTool({
    name: "commit_partner_import",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Önizlemesi yapılmış cari listesini SİSTEME YAZAR. Yeni kartları açar, mevcutları günceller. " +
        "Aynı dosya iki kez çalıştırılsa da mükerrer kayıt oluşmaz. " +
        "Yalnızca kullanıcı önizlemeyi görüp ONAYLADIKTAN sonra çağır.",
      en: "Writes a previewed partner list. Idempotent. Only call after the user approves the preview.",
    },
    input: z.strictObject({
      uploadId: z.string().min(1).describe("Önizlemesi yapılan dosyanın kimliği."),
      externalSystem: z.string().min(1).nullable().describe("Entegratör sistemi; yoksa null."),
    }),
    requires: ["master-data:partner.write"],
    async execute(input, ctx) {
      const file = await deps.uploads.get(input.uploadId, ctx.tenant.tenantId);
      if (!file) throw new Error(`Yüklenmiş dosya bulunamadı: ${input.uploadId}`);

      const result = previewPartnerImport(parseCsv(file.content), {
        ...(input.externalSystem ? { externalSystem: input.externalSystem } : {}),
      });

      // Hatalı satırlar zaten `valid` dışında; yazmaya YALNIZCA geçerliler
      // gider. Hatalıları da yazmaya çalışmak, önizlemenin anlamını yok eder.
      const outcome = await deps.importerFor(ctx.tenant.tenantId).commit(result.valid);

      return {
        ok: true as const,
        data: {
          filename: file.filename,
          ...outcome,
          skippedInvalidRows: result.errors.length,
        },
        sources: [
          {
            system: `Yüklenen dosya: ${file.filename}`,
            kind: "manual" as const,
            recordCount: result.valid.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          outcome.failures.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${outcome.failures.length} kayıt yazılamadı: ${outcome.failures
                    .slice(0, 3)
                    .map((f) => f.code)
                    .join(", ")}`,
                },
              ]
            : [],
        confidence: outcome.failures.length === 0 ? 97 : 75,
      };
    },
  });

  return [preview, commit] as const;
}
