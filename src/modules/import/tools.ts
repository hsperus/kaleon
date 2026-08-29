/**
 * İçe aktarma tool'ları.
 *
 * SAP'de göç akışı şudur: nesneyi SEÇ → şablonu indir → doldur → yükle →
 * simüle et → hataları gör → kaydet. KAELON aynı disiplini korur ama iki
 * yerde ileri gider:
 *
 *  1. NESNEYİ SİSTEM TANIR. Kullanıcı "bu bir puantaj dosyası" demek
 *     zorunda değil; başlıklara bakılıp anlaşılır. Emin olunamazsa SORULUR.
 *     Tahmin edilebilirken sormak, kullanıcıyı sistemin iç sözlüğünü
 *     öğrenmeye zorlamaktır.
 *
 *  2. YETKİ NESNE BAZINDA. Puantaj dosyasını satın almacı yükleyemez.
 *     Yetkisi olmayan nesne kullanıcıya ÖNERİLMEZ bile — model onu
 *     kataloğunda görmez.
 *
 * ÖNİZLEME L0, YAZMA L2. Model önizlemeyi kendi başına çalıştırıp raporu
 * gösterebilir; yazmayı kullanıcı onayı olmadan yapamaz.
 *
 * DOSYA İÇERİĞİ MODELDEN GEÇMEZ. Model dosyanın KİMLİĞİNİ taşır; ayrıştırma
 * ve doğrulama deterministik koddur ve 4000 satırı modele göndermenin
 * hiçbir faydası yoktur.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { holds } from "../../kernel/rbac.js";
import type { Principal, ToolOk } from "../../kernel/types.js";
import { parseCsv } from "./csv.js";
import { detectObject, type ImportObject } from "./framework.js";
import { IMPORT_OBJECTS, findObject, parseWith } from "./objects.js";
import type { Classification, ImportOutcome } from "../../db/importers.js";

export interface UploadStore {
  get(uploadId: string, tenantId: string): Promise<{ filename: string; content: string } | null>;
}

export interface Importer<T> {
  classify(rows: readonly T[]): Promise<Classification>;
  commit(rows: readonly T[]): Promise<ImportOutcome>;
}

export interface ImportDeps {
  readonly uploads: UploadStore;
  readonly importerFor: (objectId: string, tenantId: string) => Importer<never>;
}

/** Kullanıcının yükleyebileceği nesneler. */
function allowedObjects(principal: Principal): readonly ImportObject<unknown>[] {
  return IMPORT_OBJECTS.filter((o) => holds(principal, o.requires));
}

const MAX_SAMPLES = 5;

interface PreviewSummary {
  readonly filename: string;
  readonly object: string;
  readonly objectLabel: string;
  readonly totalRows: number;
  readonly validCount: number;
  readonly errorCount: number;
  readonly newCount: number;
  readonly updateCount: number;
  readonly detectedColumns: Readonly<Record<string, string | null>>;
  readonly sampleErrors: readonly { line: number; field: string; message: string }[];
  /** Birden çok nesne uyuyorsa kullanıcıya sorulacak seçenekler. */
  readonly ambiguous?: readonly { id: string; label: string }[];
}

export function importTools(deps: ImportDeps) {
  const preview = defineTool({
    name: "preview_import",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Yüklenmiş bir CSV dosyasını OKUR, ne olduğunu (cari, personel, banka, puantaj, sipariş) " +
        "kendisi anlar ve ne olacağını raporlar: kaç satır geçerli, kaç hatalı, kaç yeni kayıt, " +
        "kaç güncelleme. HİÇBİR ŞEY YAZMAZ. Kullanıcı bir dosya eklediğinde ÖNCE bunu çağır.",
      en: "Reads an uploaded CSV, detects what it is, and reports what an import would do. Writes nothing.",
    },
    input: z.strictObject({
      uploadId: z.string().min(1).describe("Yüklenen dosyanın kimliği."),
      object: z
        .string()
        .min(1)
        .nullable()
        .describe(
          "Dosya türü: partners | employees | bank | attendance | sales_orders. " +
            "Bilinmiyorsa null gönder; sistem başlıklardan anlar.",
        ),
    }),
    requires: [],
    async execute(input, ctx): Promise<ToolOk<PreviewSummary>> {
      const file = await deps.uploads.get(input.uploadId, ctx.tenant.tenantId);
      if (!file) throw new Error(`Yüklenmiş dosya bulunamadı: ${input.uploadId}`);

      const table = parseCsv(file.content);
      const allowed = allowedObjects(ctx.principal);
      if (allowed.length === 0) {
        throw new Error("Dosya içe aktarma yetkiniz yok.");
      }

      // Kullanıcı türü söylediyse ona uy; söylemediyse başlıklardan anla.
      let object: ImportObject<unknown> | undefined;
      let ambiguous: { id: string; label: string }[] | undefined;

      if (input.object) {
        object = findObject(input.object);
        if (!object) throw new Error(`Bilinmeyen dosya türü: ${input.object}`);
        if (!allowed.includes(object)) {
          throw new Error(`"${object.label}" içe aktarma yetkiniz yok.`);
        }
      } else {
        const matches = detectObject(table.headers, allowed);
        if (matches.length === 0) {
          throw new Error(
            `Dosya tanınamadı. Sütun başlıkları: ${table.headers.slice(0, 6).join(", ")}. ` +
              `Yükleyebildikleriniz: ${allowed.map((o) => o.label).join(", ")}.`,
          );
        }
        object = matches[0]!.object;
        // BELİRSİZLİK SESSİZCE ÇÖZÜLMEZ: iki tür yakın puan aldıysa yanlış
        // tabloya yazma riski var; kullanıcıya sorulur.
        if (matches.length > 1) {
          ambiguous = matches.map((m) => ({ id: m.object.id, label: m.object.label }));
        }
      }

      const { valid, errors, columns } = parseWith(object, table);
      const counts = await deps
        .importerFor(object.id, ctx.tenant.tenantId)
        .classify(valid as readonly never[]);

      return {
        ok: true,
        data: {
          filename: file.filename,
          object: object.id,
          objectLabel: object.label,
          totalRows: table.rows.length,
          validCount: valid.length,
          errorCount: errors.length,
          newCount: counts.toCreate,
          updateCount: counts.toUpdate,
          detectedColumns: columns,
          sampleErrors: errors.slice(0, MAX_SAMPLES),
          ...(ambiguous ? { ambiguous } : {}),
        },
        sources: [
          {
            system: `Yüklenen dosya: ${file.filename}`,
            kind: "manual",
            recordCount: table.rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...(errors.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${errors.length} satır aktarılamayacak; bu satırlar ATLANIR, dosyanın geri kalanı aktarılabilir.`,
                },
              ]
            : []),
          ...(ambiguous
            ? [
                {
                  severity: "warning" as const,
                  message: `Dosya türü kesin anlaşılamadı: ${ambiguous.map((a) => a.label).join(" veya ")}. Kullanıcıya sorun.`,
                },
              ]
            : []),
        ],
        confidence: ambiguous ? 60 : errors.length === 0 ? 95 : 80,
      };
    },
  });

  const commit = defineTool({
    name: "commit_import",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Önizlemesi yapılmış dosyayı SİSTEME YAZAR. Aynı dosya iki kez çalıştırılsa da mükerrer " +
        "kayıt oluşmaz. Yalnızca kullanıcı önizlemeyi görüp ONAYLADIKTAN sonra çağır. " +
        "Dosya türünü önizlemeden aldığın `object` değeriyle ver.",
      en: "Writes a previewed file. Idempotent. Only call after the user approves the preview.",
    },
    input: z.strictObject({
      uploadId: z.string().min(1).describe("Önizlemesi yapılan dosyanın kimliği."),
      object: z
        .string()
        .min(1)
        .describe("Dosya türü — önizlemenin döndürdüğü `object` değeri."),
    }),
    requires: [],
    async execute(input, ctx) {
      const object = findObject(input.object);
      if (!object) throw new Error(`Bilinmeyen dosya türü: ${input.object}`);

      // YETKİ BURADA DA DOĞRULANIR. Tool'un `requires` listesi boş çünkü
      // gereken izin NESNEYE bağlı; katalog süzgeci bunu bilemez. İkinci
      // kapı olmadan, kataloğu atlayan bir çağrı (eski konuşma, elle istek)
      // yetkisiz yazma yapabilirdi.
      if (!holds(ctx.principal, object.requires)) {
        throw new Error(`"${object.label}" içe aktarma yetkiniz yok.`);
      }

      const file = await deps.uploads.get(input.uploadId, ctx.tenant.tenantId);
      if (!file) throw new Error(`Yüklenmiş dosya bulunamadı: ${input.uploadId}`);

      const { valid, errors } = parseWith(object, parseCsv(file.content));
      // Yazmaya YALNIZCA geçerli satırlar gider; hatalıları da denemek
      // önizlemenin anlamını yok eder.
      const outcome = await deps
        .importerFor(object.id, ctx.tenant.tenantId)
        .commit(valid as readonly never[]);

      return {
        ok: true as const,
        data: {
          filename: file.filename,
          object: object.id,
          objectLabel: object.label,
          ...outcome,
          skippedInvalidRows: errors.length,
        },
        sources: [
          {
            system: `Yüklenen dosya: ${file.filename}`,
            kind: "manual" as const,
            recordCount: valid.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          outcome.failures.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${outcome.failures.length} kayıt yazılamadı. İlk sebepler: ` +
                    outcome.failures
                      .slice(0, 2)
                      .map((f) => `${f.ref} — ${f.message}`)
                      .join(" · "),
                },
              ]
            : [],
        confidence: outcome.failures.length === 0 ? 97 : 75,
      };
    },
  });

  const templates = defineTool({
    name: "list_import_templates",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Kullanıcının yükleyebileceği dosya türlerini ve her biri için beklenen sütun " +
        "başlıklarını listeler. 'Nasıl bir dosya hazırlayayım', 'hangi dosyaları yükleyebilirim' " +
        "sorularında kullan.",
      en: "Lists import templates the user is allowed to upload, with expected column headers.",
    },
    input: z.strictObject({}),
    requires: [],
    async execute(_input, ctx) {
      const allowed = allowedObjects(ctx.principal);
      return {
        ok: true as const,
        data: allowed.map((o) => ({
          id: o.id,
          label: o.label,
          headers: o.templateHeaders,
          required: o.fields.filter((f) => f.required).map((f) => f.label),
        })),
        sources: [
          {
            system: "İçe aktarma tanımları",
            kind: "module" as const,
            recordCount: allowed.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 100,
      };
    },
  });

  return [preview, commit, templates] as const;
}
