/**
 * Banka mutabakatı ve ihtar tool'ları.
 *
 * ALTI TOOL, BİR SÜREÇ:
 *   import_bank_statement   → ekstreyi al, bütünlüğünü kontrol et
 *   list_unreconciled       → kapanmamış satırlar ve yaşları
 *   suggest_reconciliation  → aday öner (KAPATMAZ)
 *   post_reconciliation     → insan onayıyla kapat
 *   plan_dunning_run        → hangi cariye hangi kademe
 *   issue_dunning_notice    → ihtarı kaydet
 *
 * İKİSİ ARASINDAKİ AYRIM BİLİNÇLİ: öneren tool L0 (okuma), kapatan
 * tool L2 (onay kapısı). Sistem sıralamayı yapar, kararı insan verir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { suggestMatches, checkStatement } from "./reconciliation.js";
import { planDunning, DunningError } from "./dunning.js";
import type { ReconciliationRepository } from "../../db/reconciliation-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

function kaynak(system: string, n: number) {
  return { system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() };
}

/** ISO tarih; geçersizse anlaşılır hata. */
function tarih(s: string, alan: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BusinessRuleError(`${alan}: "${s}" geçerli bir tarih değil.`, "invalid_date");
  }
  return d;
}

export function reconciliationTools(repo: ReconciliationRepository) {
  const importStatement = defineTool({
    name: "import_bank_statement",
    module: "finance",
    authority: 2,
    description: {
      tr:
        "Banka ekstresini sisteme alır: hesap, dönem, açılış/kapanış bakiyesi ve " +
        "hareket satırları. Yüklemeden önce ekstrenin kendi içinde tutarlı olup " +
        "olmadığını KONTROL EDER (açılış + hareketler = kapanış); tutmuyorsa " +
        "uyarır çünkü eksik ayrıştırılmış bir ekstreyle yapılan mutabakat baştan " +
        "yanlıştır. Aynı ekstre iki kez yüklenemez.",
      en: "Imports a bank statement with integrity check.",
    },
    input: z.strictObject({
      accountExternalId: z.string().trim().min(1).max(64).describe("Banka hesabının sistemdeki dış kimliği."),
      currency: z.string().length(3).describe("Hesabın para birimi (TRY, USD, EUR)."),
      statementNo: z.string().trim().min(1).max(64).describe("Bankanın verdiği ekstre numarası."),
      fromDate: z.string().describe("Dönem başı (ISO 8601)."),
      toDate: z.string().describe("Dönem sonu (ISO 8601)."),
      openingBalance: z.number().describe("Dönem başı bakiye."),
      closingBalance: z.number().describe("Dönem sonu bakiye."),
      lines: z
        .array(
          z.strictObject({
            lineNo: z.number().int().positive(),
            valueDate: z.string().describe("Valör tarihi (ISO 8601)."),
            amount: z.number().describe("İŞARETLİ tutar: pozitif giriş, negatif çıkış. Sıfır olamaz."),
            description: z.string().max(400).describe("Banka açıklaması, olduğu gibi."),
            counterparty: z.string().max(200).nullable().describe("Karşı taraf adı; yoksa null."),
            reference: z.string().max(120).nullable().describe("Dekont/referans no; yoksa null."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Ekstre hareketleri."),
    }),
    requires: ["finance:bank.read", "finance:payment.write"],
    async execute(input, ctx) {
      if (input.lines.some((l) => l.amount === 0)) {
        throw new BusinessRuleError(
          "Sıfır tutarlı ekstre satırı olamaz; bankadan geliyorsa bir ayrıştırma " +
            "hatasıdır ve sessizce 'eşleşmemiş' listesinde birikirdi.",
          "zero_amount_line",
        );
      }

      const butunluk = checkStatement(input.openingBalance, input.closingBalance, input.lines);

      const res = await repo.importStatement({
        accountExternalId: input.accountExternalId,
        currency: input.currency,
        statementNo: input.statementNo,
        fromDate: tarih(input.fromDate, "fromDate"),
        toDate: tarih(input.toDate, "toDate"),
        openingBalance: input.openingBalance,
        closingBalance: input.closingBalance,
        lines: input.lines.map((l) => ({
          lineNo: l.lineNo,
          valueDate: tarih(l.valueDate, `satır ${l.lineNo} valör`),
          amount: l.amount,
          description: l.description,
          counterparty: l.counterparty,
          reference: l.reference,
        })),
        userId: ctx.principal.userId,
      });

      return {
        ok: true as const,
        data: { ...res, integrity: butunluk },
        sources: [kaynak("Banka ekstreleri", res.lineCount)],
        risks: butunluk.ok
          ? [
              {
                severity: "info" as const,
                message:
                  `${res.statementNo}: ${res.lineCount} hareket alındı. Açılış + hareketler = ` +
                  `kapanış doğrulandı.`,
              },
            ]
          : [
              {
                severity: "critical" as const,
                message:
                  `EKSTRE TUTARSIZ: açılış ${TR.format(butunluk.opening)} + hareketler ` +
                  `${TR.format(butunluk.movement)} = ${TR.format(butunluk.opening + butunluk.movement)}, ` +
                  `ama kapanış ${TR.format(butunluk.closing)} bildirilmiş. Fark ` +
                  `${TR.format(butunluk.difference)}. Ekstre eksik ayrıştırılmış olabilir; ` +
                  `bu ekstreyle yapılacak mutabakat baştan yanlıştır.`,
              },
            ],
        confidence: butunluk.ok ? 97 : 40,
      };
    },
  });

  const listOpen = defineTool({
    name: "list_unreconciled",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Banka ekstresinde kapanmamış (eşleştirilmemiş) hareketleri listeler; en " +
        "eski başta. 'Mutabakat yapılmamış hareketler', 'banka farkı', 'hangi " +
        "hareketler eşleşmedi' sorularında kullan.",
      en: "Lists unreconciled bank statement lines, oldest first.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("Kaç satır döndürülsün."),
    }),
    requires: ["finance:bank.read"],
    async execute(input, ctx) {
      const rows = await repo.openLines(input.limit);
      const bugun = ctx.now();
      const yas = (d: Date) => Math.floor((bugun.getTime() - d.getTime()) / 86_400_000);

      const satirlar = rows.map((r) => ({
        lineId: r.id,
        statementNo: r.statementNo,
        lineNo: r.lineNo,
        valueDate: r.valueDate.toISOString().slice(0, 10),
        amount: r.amount,
        currency: r.currency,
        description: r.description,
        ageDays: yas(r.valueDate),
      }));

      const giris = satirlar.filter((s) => s.amount > 0).reduce((s, x) => s + x.amount, 0);
      const cikis = satirlar.filter((s) => s.amount < 0).reduce((s, x) => s + x.amount, 0);

      return {
        ok: true as const,
        data: {
          total: satirlar.length,
          inflowUnmatched: Math.round(giris * 100) / 100,
          outflowUnmatched: Math.round(cikis * 100) / 100,
          lines: satirlar,
        },
        sources: [kaynak("Banka ekstreleri", satirlar.length)],
        risks:
          satirlar.length === 0
            ? []
            : [
                {
                  severity: satirlar[0]!.ageDays > 30 ? ("warning" as const) : ("info" as const),
                  message:
                    `${satirlar.length} hareket eşleşmemiş; en eskisi ${satirlar[0]!.ageDays} günlük. ` +
                    `Eşleşmemiş hareket, defterdeki banka bakiyesinin gerçek bakiyeden ` +
                    `saptığı anlamına gelir.`,
                },
              ],
        confidence: 97,
      };
    },
  });

  const suggest = defineTool({
    name: "suggest_reconciliation",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "Bir ekstre satırı için aday ödemeleri önerir ve HER ADAYIN GEREKÇESİNİ " +
        "yazar (tutar, gün farkı, dekont no, cari adı). Hiçbir şey kapatmaz — " +
        "kapatmak için post_reconciliation gerekir. Tutarı tutmayan ödeme aday " +
        "sayılmaz; mutabakatın tanımı tutarın tutmasıdır.",
      en: "Suggests candidate payments for a bank statement line, with reasons.",
    },
    input: z.strictObject({
      lineId: z.string().min(1).describe("Ekstre satırının kimliği (list_unreconciled'dan)."),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .describe("Valör tarihinin kaç gün öncesi/sonrası taransın. Genelde 15."),
    }),
    requires: ["finance:bank.read"],
    async execute(input) {
      /*
       * TEK DÖNÜŞ ŞEKLİ — `get_employee`deki kuralın aynısı.
       *
       * Bulundu/bulunamadı için iki farklı şekil döndürmek, çağıranı
       * her seferinde şekil kontrolüne zorlar ve modelin iki ayrı
       * kalıp öğrenmesini gerektirir. Aynı alanlar hep var; olmayan
       * null.
       */
      const acik = await repo.openLines(500);
      const line = acik.find((l) => l.id === input.lineId) ?? null;

      const ms = input.windowDays * 86_400_000;
      const adaylar = line
        ? await repo.paymentCandidates(
            new Date(line.valueDate.getTime() - ms),
            new Date(line.valueDate.getTime() + ms),
          )
        : [];
      const oneriler = line ? suggestMatches(line, adaylar, line.currency) : [];

      return {
        ok: true as const,
        data: {
          found: line !== null,
          lineId: input.lineId,
          message: line ? "" : "Bu kimlikle kapanmamış bir ekstre satırı yok.",
          line: line
            ? {
                statementNo: line.statementNo,
                lineNo: line.lineNo,
                valueDate: line.valueDate.toISOString().slice(0, 10),
                amount: line.amount,
                description: line.description,
              }
            : null,
          suggestions: oneriler,
        },
        sources: [kaynak("Ödemeler", adaylar.length)],
        risks:
          line === null
            ? []
            : oneriler.length === 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `Bu harekete uyan ödeme kaydı YOK. İki ihtimal var: ödeme sisteme ` +
                    `hiç girilmemiş, ya da tutar farklı (banka masrafı kesmiş olabilir). ` +
                    `İkisi de elle bakılmayı gerektirir.`,
                },
              ]
            : oneriler.length > 1
              ? [
                  {
                    severity: "warning" as const,
                    message:
                      `${oneriler.length} aday var ve hepsinin tutarı tutuyor. Yanlış olanı ` +
                      `kapatmak cari hesabı sessizce bozar — gerekçeleri okuyup seçin.`,
                  },
                ]
              : [],
        confidence: line === null ? 95 : oneriler.length === 1 && oneriler[0]!.score >= 75 ? 88 : 65,
      };
    },
  });

  const postMatch = defineTool({
    name: "post_reconciliation",
    module: "finance",
    authority: 2,
    description: {
      tr:
        "Bir ekstre satırını bir ödemeyle eşleştirir ve satırı kapatır. Tutarlar " +
        "tutmuyorsa reddeder. Bir satır bir kez, bir ödeme bir kez eşleşir — aynı " +
        "ödemeyi iki satıra bağlamak, aynı parayı iki kez tahsil edilmiş göstermek " +
        "demektir.",
      en: "Matches a bank statement line to a payment and closes the line.",
    },
    input: z.strictObject({
      lineId: z.string().min(1).describe("Ekstre satırı kimliği."),
      paymentId: z.string().min(1).describe("Ödeme kimliği (suggest_reconciliation'dan)."),
      score: z.number().int().min(0).max(100).nullable().describe("Kabul edilen önerinin skoru; elle eşleştirmede null."),
      note: z.string().max(300).nullable().describe("Gerekçe/not; yoksa null."),
    }),
    requires: ["finance:payment.write"],
    async execute(input, ctx) {
      const res = await repo.postMatch({
        lineId: input.lineId,
        paymentId: input.paymentId,
        userId: ctx.principal.userId,
        score: input.score,
        note: input.note,
      });
      return {
        ok: true as const,
        data: res,
        sources: [kaynak("Mutabakat", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `Ekstre satırı ${res.lineNo} ile ${res.documentNo} ödemesi eşleştirildi ` +
              `(${TR.format(res.amount)}). Satır kapandı.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  const planDun = defineTool({
    name: "plan_dunning_run",
    module: "finance",
    authority: 0,
    description: {
      tr:
        "İhtar planı çıkarır: hangi müşteriye hangi kademe ihtar gidecek, ne kadar " +
        "borç için ve kaç gün gecikmeyle. Bir cariye BİR mektup — faturaları tek " +
        "ihtarda toplar ve kademeyi en eski gecikmeye göre seçer. Daha önce " +
        "gönderilmiş kademe tekrarlanmaz. 'Kime ihtar çekelim', 'gecikmiş " +
        "alacaklar', 'borç hatırlatması' isteklerinde kullan.",
      en: "Plans a dunning run: which customer gets which reminder level.",
    },
    input: z.strictObject({
      asOf: z.string().describe("Hangi tarihe göre (ISO 8601). Bugün için bugünün tarihi."),
    }),
    requires: ["finance:payment.read"],
    async execute(input) {
      const asOf = tarih(input.asOf, "asOf");
      const [kademeler, gecikmis, oncekiler] = await Promise.all([
        repo.dunningLevels(),
        repo.overdueReceivables(asOf),
        repo.previousDunningLevels(),
      ]);

      if (kademeler.length === 0) {
        throw new BusinessRuleError(
          "Hiç ihtar kademesi tanımlı değil. Kaç günde ne yazılacağı işletmenin " +
            "kararıdır: bir makina imalatçısı 30 günde nazik bir hatırlatma yazar, " +
            "bir nakliyeci 7 günde keser. Önce kademeler tanımlanmalı.",
          "no_dunning_levels",
        );
      }

      let plan;
      try {
        plan = planDunning(asOf, gecikmis, kademeler, oncekiler);
      } catch (e) {
        if (e instanceof DunningError) {
          throw new BusinessRuleError(e.message, "dunning_config");
        }
        throw e;
      }

      const riskler: { severity: "warning" | "info"; message: string }[] = [
        {
          severity: "info",
          message:
            `${plan.candidates.length} cariye ihtar önerisi, toplam ` +
            `${TR.format(plan.totalAmount)} ₺. BU BİR PLANDIR: hiçbir mektup ` +
            `gönderilmedi, hiçbir kayıt oluşmadı.`,
        },
      ];
      const sonKademe = plan.candidates.filter((c) => c.level === Math.max(...kademeler.map((k) => k.level)));
      if (sonKademe.length > 0) {
        riskler.push({
          severity: "warning",
          message:
            `${sonKademe.length} cari SON KADEMEDE (${TR.format(
              sonKademe.reduce((s, c) => s + c.totalAmount, 0),
            )} ₺). Bunlar hukuki takip eşiğindedir; göndermeden önce ticari ` +
            `ilişkiyi değerlendirin.`,
        });
      }
      if (plan.tooEarly.count > 0) {
        riskler.push({
          severity: "info",
          message:
            `${plan.tooEarly.count} fatura vadesi geçmiş ama henüz ilk kademeye ` +
            `girmedi (${TR.format(plan.tooEarly.amount)} ₺).`,
        });
      }

      return {
        ok: true as const,
        data: plan,
        sources: [kaynak("Satış faturaları", gecikmis.length), kaynak("İhtar kademeleri", kademeler.length)],
        risks: riskler,
        confidence: 95,
      };
    },
  });

  const issueNotice = defineTool({
    name: "issue_dunning_notice",
    module: "finance",
    authority: 2,
    description: {
      tr:
        "Bir cariye ihtar kaydı oluşturur ve belge numarası verir. plan_dunning_run " +
        "çıktısından çağrılır. Kayıt, bir sonraki koşunun aynı kademeyi tekrar " +
        "önermemesini sağlar.",
      en: "Records a dunning notice for one partner.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Cari kimliği."),
      level: z.number().int().min(1).max(9).describe("İhtar kademesi."),
      issuedAt: z.string().describe("İhtar tarihi (ISO 8601)."),
      totalAmount: z.number().positive().describe("İhtara konu toplam borç."),
      currency: z.string().length(3).describe("Para birimi."),
      oldestOverdueDays: z.number().int().min(1).describe("En eski gecikme, gün."),
      invoiceNos: z.array(z.string().min(1).max(64)).min(1).describe("Kapsanan fatura numaraları."),
    }),
    requires: ["finance:payment.write"],
    async execute(input, ctx) {
      const issuedAt = tarih(input.issuedAt, "issuedAt");
      const no = await repo.nextNoticeNo(issuedAt.getUTCFullYear());
      const res = await repo.recordNotice({
        documentNo: no,
        partnerId: input.partnerId,
        level: input.level,
        issuedAt,
        totalAmount: input.totalAmount,
        currency: input.currency.toUpperCase(),
        oldestOverdueDays: input.oldestOverdueDays,
        invoiceNos: input.invoiceNos,
        userId: ctx.principal.userId,
      });
      return {
        ok: true as const,
        data: { ...res, level: input.level, invoiceCount: input.invoiceNos.length },
        sources: [kaynak("İhtarlar", 1)],
        risks: [
          {
            severity: "info" as const,
            message:
              `${res.documentNo} · ${input.level}. kademe ihtar kaydedildi ` +
              `(${TR.format(input.totalAmount)} ${input.currency.toUpperCase()}, ` +
              `${input.invoiceNos.length} fatura). Mektup ayrıca yazdırılmalıdır; ` +
              `bu kayıt gönderimi değil KARARI belgeler.`,
          },
        ],
        confidence: 99,
      };
    },
  });

  return [importStatement, listOpen, suggest, postMatch, planDun, issueNotice] as const;
}
