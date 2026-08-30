/**
 * e-Fatura tool'ları.
 *
 * BELGE ÜRETMEK L2'DİR, GÖNDERMEK YOKTUR. Üretim geri alınabilir (belge
 * kullanılmazsa bir şey olmaz), ama gönderim geri alınamaz ve vergi
 * dairesine yansır — o yüzden bu sistemde GÖNDERİM TOOL'U YOKTUR ve
 * olmayacaktır. Anayasa: "AI hazırlar. Sistem doğrular. İnsan onaylar.
 * ENTEGRATÖR GÖNDERİR."
 *
 * HAZIRLIK KONTROLÜ L0'DIR ve fatura kesilmeden ÖNCE çalıştırılabilir:
 * eksik cari bilgisiyle kesilen fatura iptal edilip yeniden kesilmek
 * zorunda kalır, iptal de mevzuata yansır.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { EInvoiceRepository } from "../../db/einvoice-repository.js";

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

export function einvoiceTools(repo: EInvoiceRepository) {
  const readiness = defineTool({
    name: "check_einvoice_readiness",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir cariye e-Fatura kesilebilir mi kontrol eder ve EKSİK ALANLARI listeler: " +
        "vergi numarası, vergi dairesi, adres ve e-Fatura mükellefiyeti. Fatura " +
        "KESİLMEDEN ÖNCE çağrılmalıdır; eksik bilgiyle kesilen fatura iptal edilip " +
        "yeniden kesilmek zorunda kalır ve iptal vergi dairesine yansır.",
      en: "Checks whether an e-invoice can be issued for a partner and lists missing fields.",
    },
    input: z.strictObject({
      partnerId: z.string().min(1).describe("Cari kimliği."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const r = await repo.readiness(input.partnerId);
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "e-Fatura hazırlık",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: r.ready
          ? []
          : [
              {
                severity: "warning" as const,
                message:
                  `Bu cariye e-Fatura kesilemez; ${r.missing.length} alan eksik: ` +
                  r.missing.join(", ") + ".",
              },
            ],
        confidence: 96,
      };
    },
  });

  const build = defineTool({
    name: "build_einvoice_document",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Kesilmiş bir satış faturası için UBL-TR 1.2 e-Fatura/e-Arşiv XML belgesi " +
        "üretir ve ETTN atar. Alıcı e-Fatura mükellefiyse e-Fatura, değilse e-Arşiv " +
        "profili kullanılır; mükellefiyet BİLİNMİYORSA belge üretilmez — yanlış " +
        "profil faturayı geçersiz kılar. BELGE GÖNDERİLMEZ: gönderim entegratörün " +
        "işidir ve bu sistemde gönderim tool'u YOKTUR.",
      en: "Builds a UBL-TR 1.2 e-invoice XML for an issued sales invoice. Does not send.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Satış faturası numarası."),
    }),
    requires: ["documents:einvoice.write"],
    async execute(input, _ctx) {
      const doc = await repo.buildFor(input.documentNo);
      return {
        ok: true as const,
        data: {
          documentNo: doc.documentNo,
          ettn: doc.ettn,
          profile: doc.profile,
          byteLength: doc.byteLength,
          // XML'in tamamı cevaba konmaz: 200 kalemlik bir fatura modelin
          // bağlamını doldurur ve hiçbir işe yaramaz. Belge saklanır,
          // özeti döner.
          preview: doc.xml.slice(0, 400),
        },
        sources: [
          {
            system: "e-Fatura (UBL-TR 1.2)",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${doc.documentNo} için ${doc.profile} belgesi üretildi (ETTN ${doc.ettn}). ` +
              `Belge GÖNDERİLMEDİ; entegratöre teslim edilmeye hazır.`,
          },
        ],
        confidence: 96,
      };
    },
  });

  const pending = defineTool({
    name: "list_pending_einvoices",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Belgesi üretilmiş ama entegratöre henüz gönderilmemiş faturaları listeler. " +
        "Gönderim kuyruğudur.",
      en: "Lists issued invoices whose e-invoice document is generated but not yet sent.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const rows = await repo.pendingDocuments(input.limit);
      const total = rows.reduce((s, r) => s + r.totalAmount, 0);
      return {
        ok: true as const,
        data: { invoices: rows, total: Math.round(total * 100) / 100 },
        sources: [
          {
            system: "e-Fatura kuyruğu",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `${rows.length} fatura (${TR.format(total)} TL) entegratöre gönderilmeyi ` +
                    `bekliyor; en eskisi ${rows[0]!.issuedAt} tarihli.`,
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  const setCompany = defineTool({
    name: "set_company_profile",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Şirketin e-Fatura kimliğini kaydeder: unvan, vergi numarası, vergi dairesi " +
        "ve adres. Bu bilgiler olmadan hiçbir e-Fatura belgesi üretilemez.",
      en: "Saves the company's legal identity used as the e-invoice supplier.",
    },
    input: z.strictObject({
      legalName: z.string().min(3).max(200).describe("Şirketin tam ticaret unvanı."),
      taxId: z.string().min(10).max(11).describe("VKN (10 hane) veya TCKN (11 hane)."),
      taxOffice: z.string().min(2).max(80).describe("Vergi dairesi."),
      addressLine: z.string().min(5).max(300).describe("Açık adres."),
      district: z.string().min(2).max(80).describe("İlçe."),
      city: z.string().min(2).max(80).describe("İl."),
      postalCode: z.string().max(10).nullable().describe("Posta kodu. Yoksa null."),
      email: z.string().max(120).nullable().describe("E-posta. Yoksa null."),
      phone: z.string().max(40).nullable().describe("Telefon. Yoksa null."),
      mersisNo: z.string().max(20).nullable().describe("MERSİS numarası. Yoksa null."),
      tradeRegistryNo: z.string().max(30).nullable().describe("Ticaret sicil no. Yoksa null."),
    }),
    requires: ["master-data:company.write"],
    async execute(input, _ctx) {
      await repo.saveCompanyProfile(input);
      return {
        ok: true as const,
        data: { legalName: input.legalName, taxId: input.taxId },
        sources: [
          {
            system: "Şirket kimliği",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `Şirket kimliği kaydedildi. Bundan sonra kesilen e-Faturalarda ` +
              `düzenleyen "${input.legalName}" (${input.taxId}) olarak görünecek.`,
          },
        ],
        confidence: 98,
      };
    },
  });

  const buildDespatch = defineTool({
    name: "build_edespatch_document",
    module: "documents",
    authority: 2,
    description: {
      tr:
        "Bir sevk irsaliyesi için UBL-TR e-İrsaliye XML belgesi üretir ve ETTN atar. " +
        "1 TEMMUZ 2026'DAN İTİBAREN ZORUNLUDUR. Taşıyıcı ve PLAKA olmadan belge " +
        "üretilmez — plakasız irsaliye, yol denetiminde belgesiz mal demektir. " +
        "Belge GÖNDERİLMEZ; entegratöre teslim edilmeye hazır hâle gelir.",
      en: "Builds a UBL-TR e-despatch advice for a posted delivery. Does not send.",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("İrsaliye numarası."),
    }),
    requires: ["documents:einvoice.write"],
    async execute(input, _ctx) {
      const doc = await repo.buildDespatchFor(input.documentNo);
      return {
        ok: true as const,
        data: {
          documentNo: doc.documentNo,
          ettn: doc.ettn,
          profile: doc.profile,
          byteLength: doc.byteLength,
          preview: doc.xml.slice(0, 400),
        },
        sources: [
          {
            system: "e-İrsaliye (UBL-TR 1.2)",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${doc.documentNo} için e-İrsaliye belgesi üretildi (ETTN ${doc.ettn}). ` +
              `Belge GÖNDERİLMEDİ; entegratöre teslim edilmeye hazır.`,
          },
        ],
        confidence: 96,
      };
    },
  });

  const undocumented = defineTool({
    name: "list_deliveries_without_edespatch",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "e-İrsaliye belgesi ÜRETİLMEMİŞ sevkiyatları listeler. BU LİSTE BOŞ " +
        "OLMALIDIR: dolu olması, belgesiz mal sevk edildiği anlamına gelir ve " +
        "yol denetiminde özel usulsüzlük cezası doğurur (1 Temmuz 2026'dan " +
        "itibaren zorunlu).",
      en: "Lists posted deliveries with no e-despatch document — should be empty.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const rows = await repo.despatchesWithoutDocument(input.limit);
      return {
        ok: true as const,
        data: { deliveries: rows },
        sources: [
          {
            system: "e-İrsaliye kuyruğu",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length > 0
            ? [
                {
                  severity: "critical" as const,
                  message:
                    `${rows.length} sevkiyatın e-İrsaliyesi YOK; en eskisi ${rows[0]!.shippedAt} ` +
                    `tarihli (${rows[0]!.documentNo}). Belgesiz sevkiyat, yol denetiminde ` +
                    `özel usulsüzlük cezası doğurur.`,
                },
              ]
            : [],
        confidence: 96,
      };
    },
  });

  const pendingDespatch = defineTool({
    name: "list_pending_edespatches",
    module: "documents",
    authority: 0,
    description: {
      tr: "Belgesi üretilmiş ama entegratöre gönderilmemiş e-İrsaliyeleri listeler.",
      en: "Lists e-despatch documents generated but not yet sent.",
    },
    input: z.strictObject({
      limit: z.number().int().positive().max(200).describe("En fazla kaç kayıt."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const rows = await repo.pendingDespatches(input.limit);
      return {
        ok: true as const,
        data: { despatches: rows },
        sources: [
          {
            system: "e-İrsaliye kuyruğu",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length > 0
            ? [
                {
                  severity: "warning" as const,
                  message: `${rows.length} e-İrsaliye entegratöre gönderilmeyi bekliyor.`,
                },
              ]
            : [],
        confidence: 95,
      };
    },
  });

  /**
   * Faturayı okunabilir belge olarak döndürür.
   *
   * XML'İN İNSAN HÂLİ. `build_einvoice_document` entegratöre gidecek
   * UBL'i üretir; onu kimse okuyamaz. Bu tool aynı faturayı ekrana ve
   * kâğıda basılabilir biçimde verir — müşteriye gönderilecek,
   * imzalanacak, dosyalanacak olan budur.
   *
   * L0 ÇÜNKÜ HİÇBİR ŞEY YAZMAZ. Belge üretimi (ETTN atama) L2'dir ve
   * ayrı durur; okumak için o yetkiyi istemek, faturayı görmek isteyen
   * herkesi gereksiz yere yetkilendirmek olurdu.
   */
  const view = defineTool({
    name: "get_invoice_document",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir satış faturasını okunabilir BELGE olarak döndürür: satıcı ve alıcı " +
        "bilgileri, kalemler, KDV oran kırılımı, toplamlar ve tutarın yazıyla hâli. " +
        "Kullanıcı faturayı görmek, yazdırmak ya da müşteriye göndermek istediğinde " +
        "bu tool çağrılır. TASLAK fatura da okunur; durumu belgenin üzerinde yazar. " +
        "Hiçbir şey değiştirmez, ETTN atamaz.",
      en: "Returns a sales invoice as a human-readable document (parties, lines, VAT breakdown, totals).",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Satış faturası numarası."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const inv = await repo.readInvoice(input.documentNo);
      const risks: { severity: "info" | "warning"; message: string }[] = [];

      // Taslak fatura BELGE DEĞİLDİR. Ekranda gösterilir ama bunun
      // müşteriye gönderilebilir bir fatura olmadığı yazılı olarak
      // söylenir; aksi hâlde yazdırılıp elden verilir.
      if (inv.status === "draft") {
        risks.push({
          severity: "warning",
          message:
            `${inv.documentNo} henüz KESİLMEMİŞ (taslak). Bu görüntü kontrol içindir; ` +
            `müşteriye verilecek fatura değildir.`,
        });
      }
      if (inv.status === "cancelled") {
        risks.push({
          severity: "warning",
          message: `${inv.documentNo} İPTAL EDİLMİŞ bir faturadır.`,
        });
      }
      if (!inv.supplier) {
        risks.push({
          severity: "warning",
          message:
            "Şirket kimliği tanımlı değil; belgenin anteti boş. e-Fatura üretilemez.",
        });
      }
      if (inv.ettn === null && inv.status === "issued") {
        risks.push({
          severity: "info",
          message:
            `${inv.documentNo} için e-Fatura belgesi henüz üretilmemiş (ETTN yok).`,
        });
      }

      return {
        ok: true as const,
        // Arayüz bu biçimi tanır ve faturayı belge olarak gösterir.
        data: { kind: "invoice" as const, invoice: inv },
        sources: [
          {
            system: "Satış faturası",
            kind: "module" as const,
            recordCount: inv.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks,
        confidence: 98,
      };
    },
  });

  /** İrsaliyenin insan hâli — araca konan kâğıt budur. */
  const despatchView = defineTool({
    name: "get_despatch_document",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Bir sevk irsaliyesini okunabilir BELGE olarak döndürür: satıcı ve alıcı, " +
        "sevk edilen kalemler, taşıyıcı, plaka, sürücü ve sevk zamanı. Kullanıcı " +
        "irsaliyeyi görmek ya da yazdırmak istediğinde çağrılır. TUTAR TAŞIMAZ — " +
        "mal bedeli faturada beyan edilir. Hiçbir şey değiştirmez.",
      en: "Returns a despatch note as a human-readable document (parties, lines, carrier, plate).",
    },
    input: z.strictObject({
      documentNo: z.string().min(1).max(64).describe("Sevk irsaliyesi numarası."),
    }),
    requires: ["documents:einvoice.read"],
    async execute(input, _ctx) {
      const d = await repo.readDespatch(input.documentNo);
      const risks: { severity: "info" | "warning"; message: string }[] = [];

      // TASLAK İRSALİYE STOK DÜŞMEZ ve mal yola çıkmamıştır.
      if (d.status === "draft") {
        risks.push({
          severity: "warning",
          message:
            `${d.documentNo} taslak durumda; stok düşülmedi ve mal sevk edilmiş sayılmaz.`,
        });
      }
      if (d.status === "cancelled") {
        risks.push({
          severity: "warning",
          message: `${d.documentNo} İPTAL EDİLMİŞ bir irsaliyedir.`,
        });
      }
      // Plakasız irsaliye yol denetiminde sorun çıkarır; eksikliği
      // belgeyi bastırmadan ÖNCE söylenir.
      const missing = [
        d.carrierName ? null : "taşıyıcı",
        d.plateNo ? null : "plaka",
      ].filter((x): x is string => x !== null);
      if (missing.length > 0 && d.status !== "cancelled") {
        risks.push({
          severity: "warning",
          message:
            `${d.documentNo} belgesinde ${missing.join(" ve ")} bilgisi yok; ` +
            `e-İrsaliyede bu alanlar zorunludur.`,
        });
      }

      return {
        ok: true as const,
        data: { kind: "despatch" as const, despatch: d },
        sources: [
          {
            system: "Sevk irsaliyesi",
            kind: "module" as const,
            recordCount: d.lines.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks,
        confidence: 98,
      };
    },
  });

  return [
    readiness,
    view,
    despatchView,
    build,
    pending,
    setCompany,
    buildDespatch,
    undocumented,
    pendingDespatch,
  ] as const;
}
