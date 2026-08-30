/**
 * İzleme tool'ları.
 *
 * AJANI PROAKTİF YAPAN YER BURASI. "Kasa 500 binin altına düşerse
 * haber ver" cümlesi, koda dokunmadan kalıcı bir izlemeye dönüşür ve
 * her açılışta kendiliğinden çalışır. SAP'de bunun karşılığı bir
 * danışmanın yazacağı ABAP raporu ve bir zamanlanmış iştir.
 *
 * İZLEME KURMAK L1'DİR. Kendi başına mali sonuç doğurmaz ama
 * kullanıcının ekranına kalıcı bir şey ekler ve yanlış kurulmuş bir
 * izleme her gün gürültü üretir; onaydan geçer.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import type { ToolRegistry } from "../../kernel/registry.js";
import type { WatchRepository } from "../../db/watch-repository.js";
import { describeWatch, numericPaths, readPath } from "./watch.js";
import { invokeTool } from "../../kernel/invoke.js";
import type { AuditSink } from "../../kernel/audit.js";

const LEVEL_LABEL = ["sessiz", "not", "kritik"] as const;

/**
 * İzleme kurulum hatası — çekirdeğin iş kuralı hatası olarak taşınır.
 *
 * Düz `Error` fırlatılsaydı kullanıcı "Tool çalıştırılamadı" gibi
 * hiçbir şey anlatmayan bir cümle görürdü ve izlemesini neden
 * kuramadığını bilemezdi. `BusinessRuleError` kullanıcıya görünür
 * (`userFacing`) ve mesaj olduğu gibi ekrana çıkar.
 */
class WatchSetupError extends BusinessRuleError {
  constructor(message: string) {
    super(message, "watch_setup");
  }
}

export function watchTools(
  repo: WatchRepository,
  registry: () => ToolRegistry,
  /**
   * Denetim kaydı.
   *
   * İZLEME KURULURKEN TOOL BİR KEZ ÇALIŞTIRILIR ve o çalıştırma da
   * kayda düşmelidir. Doğrudan `execute` çağırmak daha kolay olurdu
   * ama nöbetçiler için konan kuralı bozardı: "izleme için ayrıcalıklı
   * bir yol yoktur".
   */
  auditFor: () => AuditSink,
) {
  const create = defineTool({
    name: "create_watch",
    module: "briefing",
    authority: 1,
    confirm: "always",
    description: {
      tr:
        "Kalıcı bir İZLEME kurar: bir okuma tool'unun sonucundaki bir değer eşiği " +
        "aşarsa açılış ekranında uyarı çıkar. 'Kasa 500 binin altına düşerse haber " +
        "ver', 'bekleyen onay 5'i geçerse söyle', 'bilanço denk değilse uyar' gibi " +
        "isteklerde kullan. Yalnızca OKUMA tool'ları izlenebilir. ÖNCE " +
        "list_watchable_fields ÇAĞIR: izlenecek alanın yolunu ve şu anki değerini " +
        "oradan öğren, sonra bu tool'u o yolla çağır. Yolu tahmin etme; yanlış yol " +
        "kabul edilmez.",
      en: "Creates a persistent watch that raises a briefing alert when a threshold is crossed.",
    },
    input: z.strictObject({
      name: z.string().min(3).max(60).describe("İzlemenin adı; listede bu görünür."),
      tool: z.string().min(3).max(64).describe("İzlenecek okuma tool'unun adı."),
      toolInput: z
        .record(z.string(), z.unknown())
        .describe("Tool'a verilecek girdi; gerekmiyorsa boş nesne."),
      path: z
        .string()
        .min(1)
        .max(120)
        .describe("Sonuçtaki değerin yolu: 'total', 'rows[0].amount', 'items.length'."),
      operator: z
        .enum(["gt", "gte", "lt", "lte", "eq", "neq", "changed"])
        .describe("Karşılaştırma; 'changed' değer her değiştiğinde tetikler."),
      threshold: z.number().nullable().describe("Eşik; 'changed' için null."),
      level: z.number().int().describe("0 sessiz, 1 not, 2 kritik."),
      message: z
        .string()
        .min(5)
        .max(300)
        .describe("Tetiklenince gösterilecek cümle. {deger} ve {esik} yerine konur."),
    }),
    requires: ["briefing:watch.write"],
    async execute(input, ctx) {
      const reg = registry();
      const target = reg.get(input.tool);

      // OLMAYAN TOOL İZLENEMEZ: kurulan izleme her koşuda sessizce
      // düşerdi ve kullanıcı uyarı beklerken hiçbir şey almazdı.
      if (!target) {
        throw new WatchSetupError(
          `"${input.tool}" adında bir tool yok; izleme kurulamaz. Önce hangi tool'un ` +
            `bu veriyi verdiğini belirleyin.`,
        );
      }

      /*
       * YALNIZCA OKUMA TOOL'U İZLENİR.
       *
       * Yazan bir tool'u izlemeye bağlamak, arka planda kendiliğinden
       * çalışan bir yazma işlemi demektir: kullanıcı ekranı açar,
       * fatura kesilir. Hiç kimsenin istemediği şey budur.
       */
      if (target.authority > 0) {
        throw new WatchSetupError(
          `${input.tool} bir işlem tool'udur (L${target.authority}) ve izlenemez. ` +
            `İzleme yalnızca okuma tool'larına (L0) kurulabilir; aksi hâlde arka planda ` +
            `kendiliğinden çalışan bir işlem olurdu.`,
        );
      }

      // KULLANICI GÖREMEDİĞİ VERİYİ İZLEYEMEZ.
      const missing = reg.missingFor(ctx.principal, input.tool);
      if (missing.length > 0) {
        throw new WatchSetupError(
          `${input.tool} tool'unu çalıştırma yetkiniz yok; göremediğiniz veriyi ` +
            `izleyemezsiniz.`,
        );
      }

      /*
       * GİRDİ KURULUM ANINDA DOĞRULANIR.
       *
       * BU HATA GERÇEKTEN YAŞANDI: `get_bank_balance` için boş girdiyle
       * bir izleme kuruldu, kaydedildi ve her koşuda `invalid_input`
       * ile düştü. Kullanıcı açısından görünen şey şuydu — izleme
       * listede duruyor, "aktif" yazıyor ve hiçbir zaman uyarı
       * vermiyor. Yani izlediğini sandığı şey hiç izlenmiyordu.
       *
       * Çalışma anında yakalamak yetmez: o an kullanıcı ekranda
       * değildir ve uyarıyı zaten beklemiyordur. Kurulum anında
       * reddetmek, tek dürüst davranıştır.
       */
      // `registry.get` Tool<never, unknown> döndürür; zod şemasına
      // erişmek için dar bir cast gerekiyor. Şema her tool'da vardır.
      const schema = target.input as unknown as {
        safeParse: (v: unknown) =>
          | { success: true; data: unknown }
          | { success: false; error: { issues: readonly { path: readonly (string | number)[]; message: string }[] } };
      };
      const parsed = schema.safeParse(input.toolInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "girdi"}: ${i.message}`)
          .join("; ");
        throw new WatchSetupError(
          `${input.tool} için verilen girdi geçersiz (${issues}). Girdisi geçersiz bir ` +
            `izleme kaydedilirse listede "aktif" görünür ama hiçbir zaman çalışmaz.`,
        );
      }

      /*
       * İZLEME KURULMADAN ÖNCE BİR KEZ ÇALIŞTIRILIR.
       *
       * Girdi doğrulaması yolun DOĞRU olduğunu göstermez: `total`
       * alanı hiç olmayan bir sonuçta izleme her koşuda "alan
       * bulunamadı" der ve kullanıcı bunu ancak aylar sonra fark eder.
       * Tool okuma tool'udur ve kullanıcının zaten yetkisi vardır;
       * bir kez çalıştırmanın yan etkisi yoktur.
       *
       * YANLIŞ YOLDA DOĞRULARI SÖYLENİR. Ajan böylece kendini
       * düzeltebilir; kullanıcıya alan adı sordurmak "native" değildir.
       */
      const probe = await invokeTool(input.tool, parsed.data, {
        registry: reg,
        audit: auditFor(),
        principal: ctx.principal,
        tenant: ctx.tenant,
        correlationId: ctx.correlationId,
        channel: ctx.channel,
      });

      if (!probe.outcome.ok) {
        throw new WatchSetupError(
          `${input.tool} şu anda çalıştırılamadı (${probe.outcome.code}); izleme ` +
            `kurulmadı. Çalışmayan bir tool üzerine izleme kurmak, hiç uyarı ` +
            `vermeyecek bir izleme kurmaktır.`,
        );
      }

      if (readPath(probe.outcome.data, input.path) === null) {
        const available = numericPaths(probe.outcome.data).slice(0, 12);
        throw new WatchSetupError(
          `"${input.path}" alanı ${input.tool} sonucunda yok. İzlenebilecek sayısal ` +
            `alanlar: ${available.length > 0 ? available.join(", ") : "(bu sonuçta sayısal alan bulunamadı)"}.`,
        );
      }

      const level = Math.min(2, Math.max(0, input.level)) as 0 | 1 | 2;
      const w = await repo.create({
        name: input.name,
        tool: input.tool,
        toolInput: parsed.data,
        path: input.path,
        operator: input.operator,
        threshold: input.threshold,
        level,
        message: input.message,
        ownerUserId: ctx.principal.userId,
      });

      return {
        ok: true as const,
        data: {
          watch: { name: w.name, tool: w.tool, path: w.path, level: w.level },
          description: describeWatch(w),
          summary: `"${w.name}" izlemesi kuruldu (${LEVEL_LABEL[level]}).`,
        },
        sources: [
          {
            system: "İzlemeler",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `İzleme her açılışta çalışacak. İlk sonucu bir sonraki brifingte ` +
              `görünür; ${input.operator === "changed" ? "değişim izlemesi ilk koşuda tetiklenmez." : "eşik aşılmadıkça sessiz kalır."}`,
          },
        ],
        confidence: 96,
      };
    },
  });

  /**
   * İzlenebilir alanları keşfeder.
   *
   * BU TOOL, KOŞUMUN ORTAYA ÇIKARDIĞI BİR TASARIM KUSURUNU KAPATIYOR.
   *
   * `create_watch`, izlenecek alanın YOLUNU istiyor ("total",
   * "items.length"). Model bunu bilemez — tool'un çıktısını hiç
   * görmemiştir. Hata mesajı doğru yolları söylüyordu ama bu, modelin
   * ÖNCE BAŞARISIZ OLMASINI gerektiriyordu. Canlı koşumda sonuç şu
   * oldu: aynı soruya iki farklı davranış; bir koşuda iki kez deneyip
   * ikisinde de düştü, diğerinde hiç denemedi.
   *
   * Deneyip yanılmak bir keşif yöntemi değildir. Ajan, taahhüt
   * etmeden önce bakabilmelidir.
   */
  const describe = defineTool({
    name: "list_watchable_fields",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Bir okuma tool'unun sonucundaki İZLENEBİLİR SAYISAL ALANLARI ve şu anki " +
        "değerlerini listeler. İzleme kurmadan ÖNCE çağır: create_watch'un istediği " +
        "'path' değerini buradan öğrenirsin. Örnek: get_bank_balance için " +
        "'length', '[0].available' gibi yollar döner.",
      en: "Lists watchable numeric fields (and current values) in a read tool's result.",
    },
    input: z.strictObject({
      tool: z.string().min(3).max(64).describe("İncelenecek okuma tool'unun adı."),
      toolInput: z
        .record(z.string(), z.unknown())
        .describe("Tool'a verilecek girdi; gerekmiyorsa boş nesne."),
    }),
    requires: ["briefing:watch.read"],
    async execute(input, ctx) {
      const reg = registry();
      const target = reg.get(input.tool);
      if (!target) {
        throw new WatchSetupError(`"${input.tool}" adında bir tool yok.`);
      }
      if (target.authority > 0) {
        throw new WatchSetupError(
          `${input.tool} bir işlem tool'udur (L${target.authority}); izlenemez ve ` +
            `incelenmez. Yalnızca okuma tool'ları (L0) izlenebilir.`,
        );
      }
      if (reg.missingFor(ctx.principal, input.tool).length > 0) {
        throw new WatchSetupError(
          `${input.tool} tool'unu çalıştırma yetkiniz yok; göremediğiniz veriyi ` +
            `izleyemezsiniz.`,
        );
      }

      const schema = target.input as unknown as {
        safeParse: (v: unknown) =>
          | { success: true; data: unknown }
          | { success: false; error: { issues: readonly { path: readonly (string | number)[]; message: string }[] } };
      };
      const parsed = schema.safeParse(input.toolInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "girdi"}: ${i.message}`)
          .join("; ");
        throw new WatchSetupError(`${input.tool} için girdi geçersiz (${issues}).`);
      }

      const probe = await invokeTool(input.tool, parsed.data, {
        registry: reg,
        audit: auditFor(),
        principal: ctx.principal,
        tenant: ctx.tenant,
        correlationId: ctx.correlationId,
        channel: ctx.channel,
      });
      if (!probe.outcome.ok) {
        throw new WatchSetupError(
          `${input.tool} çalıştırılamadı (${probe.outcome.code}); alanlar okunamadı.`,
        );
      }

      // ŞU ANKİ DEĞER DE VERİLİR: eşik belirlemek için gerekli.
      // "Kasa 500 binin altına düşerse" diyen kullanıcıya, kasanın
      // şu an ne olduğunu bilmeden makul bir eşik önerilemez.
      const result = probe.outcome.data;
      const fields = numericPaths(result)
        .slice(0, 25)
        .map((path) => ({ path, currentValue: readPath(result, path) }));

      return {
        ok: true as const,
        data: {
          tool: input.tool,
          fields,
          summary:
            fields.length === 0
              ? `${input.tool} sonucunda izlenebilecek sayısal alan yok.`
              : `${fields.length} izlenebilir alan: ` +
                fields.slice(0, 5).map((f) => `${f.path}=${f.currentValue}`).join(", ") +
                (fields.length > 5 ? " …" : ""),
        },
        sources: [
          {
            system: "İzlemeler",
            kind: "module" as const,
            recordCount: fields.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 96,
      };
    },
  });

  const list = defineTool({
    name: "list_watches",
    module: "briefing",
    authority: 0,
    description: {
      tr:
        "Kurduğunuz izlemeleri listeler: ne izlediği, eşiği, en son ne zaman " +
        "çalıştığı ve kaç kez tetiklendiği. Hiç tetiklenmemiş bir izleme, ya her " +
        "şey yolunda demektir ya da yanlış kurulmuştur — ikisini ayırmak için " +
        "son kontrol zamanına bakın.",
      en: "Lists your watches with their thresholds and firing history.",
    },
    input: z.strictObject({}),
    requires: ["briefing:watch.read"],
    async execute(_input, ctx) {
      const rows = await repo.listFor(ctx.principal.userId);
      return {
        ok: true as const,
        data: {
          watches: rows.map((w) => ({
            name: w.name,
            description: describeWatch(w),
            tool: w.tool,
            level: LEVEL_LABEL[w.level],
            active: w.isActive,
            lastCheckedAt: w.lastCheckedAt,
            lastFiredAt: w.lastFiredAt,
            fireCount: w.fireCount,
            lastValue: w.lastValue,
          })),
          count: rows.length,
          summary:
            rows.length === 0
              ? "Kurulu izlemeniz yok."
              : `${rows.length} izleme kurulu, ${rows.filter((w) => w.isActive).length} tanesi aktif.`,
        },
        sources: [
          {
            system: "İzlemeler",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        // HİÇ ÇALIŞMAMIŞ İZLEME BİLDİRİLİR: kullanıcı uyarı beklerken
        // izlemenin hiç koşmadığını fark etmelidir.
        risks: rows.some((w) => w.isActive && w.lastCheckedAt === null)
          ? [
              {
                severity: "warning" as const,
                message:
                  "Bazı izlemeler henüz hiç çalışmadı: " +
                  rows
                    .filter((w) => w.isActive && w.lastCheckedAt === null)
                    .map((w) => w.name)
                    .join(", ") +
                  ". İlk koşu bir sonraki açılışta olur.",
              },
            ]
          : [],
        confidence: 97,
      };
    },
  });

  const remove = defineTool({
    name: "delete_watch",
    module: "briefing",
    authority: 1,
    confirm: "always",
    description: {
      tr:
        "Bir izlemeyi kaldırır. Kaldırılan izleme bir daha uyarı üretmez; geçici " +
        "olarak susturmak için pause_watch kullanılır.",
      en: "Removes a watch permanently.",
    },
    input: z.strictObject({
      name: z.string().min(1).max(60).describe("Kaldırılacak izlemenin adı."),
    }),
    requires: ["briefing:watch.write"],
    async execute(input, ctx) {
      const ok = await repo.remove(ctx.principal.userId, input.name);
      return {
        ok: true as const,
        data: {
          removed: ok,
          summary: ok
            ? `"${input.name}" izlemesi kaldırıldı.`
            : `"${input.name}" adında bir izlemeniz yok.`,
        },
        sources: [
          {
            system: "İzlemeler",
            kind: "module" as const,
            recordCount: ok ? 1 : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const pause = defineTool({
    name: "pause_watch",
    module: "briefing",
    authority: 1,
    confirm: "always",
    description: {
      tr:
        "Bir izlemeyi geçici olarak susturur ya da yeniden açar. Silmez: eşiği ve " +
        "geçmişi korunur. Bilinen bir sorun düzeltilene kadar gürültüyü kesmek için.",
      en: "Pauses or resumes a watch without deleting it.",
    },
    input: z.strictObject({
      name: z.string().min(1).max(60).describe("İzlemenin adı."),
      active: z.boolean().describe("true açar, false susturur."),
    }),
    requires: ["briefing:watch.write"],
    async execute(input, ctx) {
      const ok = await repo.setActive(ctx.principal.userId, input.name, input.active);
      return {
        ok: true as const,
        data: {
          changed: ok,
          summary: ok
            ? `"${input.name}" izlemesi ${input.active ? "yeniden açıldı" : "susturuldu"}.`
            : `"${input.name}" adında bir izlemeniz yok.`,
        },
        sources: [
          {
            system: "İzlemeler",
            kind: "module" as const,
            recordCount: ok ? 1 : 0,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: ok && !input.active
          ? [
              {
                severity: "warning" as const,
                message:
                  `"${input.name}" artık uyarı üretmeyecek. Susturulmuş bir izleme, ` +
                  `olmayan bir izlemedir; sorun çözülünce yeniden açın.`,
              },
            ]
          : [],
        confidence: 97,
      };
    },
  });

  return [describe, create, list, remove, pause] as const;
}
