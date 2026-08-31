/**
 * Ana veri oluşturma ve güncelleme.
 *
 * BOŞLUK ÖLÇÜLDÜ: kayıtlı 151 tool içinde tek bir `update_*` yoktu ve
 * `create_partner` ile `create_employee` de yoktu. Yani kullanıcı yeni
 * bir müşteri EKLEYEMİYOR, bir carinin adresini DÜZELTEMİYOR, bir
 * çalışanın ücretini DEĞİŞTİREMİYORDU. Toplu içe aktarma vardı ama
 * "şu müşterinin vergi numarası yanlış girilmiş" demek için bile
 * dosya yüklemek gerekiyordu.
 *
 * Bir ERP'nin en sık yapılan işi budur. Eksikliği, ürünü "rapor
 * okuyucu" seviyesinde bırakıyordu.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * GÜNCELLEME KISMİDİR. Verilmeyen alan DEĞİŞMEZ. Tamamını isteyen bir
 * tasarımda kullanıcı yalnızca telefonu düzeltmek isterken adresi
 * yanlışlıkla siler — ve bunu aylar sonra fark eder.
 *
 * DEĞİŞİKLİK İZİ OTOMATİKTİR. `partners`, `items` ve `employees`
 * tablolarında veritabanı tetikleyicisi her alan değişimini eski ve
 * yeni değeriyle kaydediyor. Bu yüzden burada elle iz yazılmıyor —
 * elle yazılan iz, unutulabilen izdir.
 *
 * HEPSİ L2. Yazan her işlem onay formundan geçer; kullanıcı neyin
 * neye döneceğini görmeden kayıt oluşmaz.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { BusinessRuleError } from "../../kernel/errors.js";
import { setChangeActor } from "../../db/change-log.js";
import { normalizeName } from "./normalize.js";
import type { TenantDb } from "../../db/client.js";

/**
 * Vergi numarası doğrulaması.
 *
 * VKN ON HANE, TCKN ON BİR. Şahıs şirketleri TCKN ile fatura keser,
 * bu yüzden ikisi de kabul edilir. Yanlış uzunluktaki bir numara
 * e-Faturayı GİB'de reddettirir ve hata faturayı kesen kişiye değil,
 * üç gün sonra muhasebeye döner.
 */
const VergiNo = z
  .string()
  .trim()
  .regex(/^\d{10,11}$/, "Vergi numarası 10 hane (VKN) ya da 11 hane (TCKN) olmalı.")
  .nullable();

/** Boş metni null'a çevirir — "" ile null aynı şey değil ama girdide öyle gelir. */
const bos = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? "";
  return t.length === 0 ? null : t;
};

function kaynak(system: string, n: number) {
  return [{ system, kind: "module" as const, recordCount: n, syncedAt: new Date().toISOString() }];
}

export function masterDataCrudTools(db: TenantDb) {
  // ── CARİ OLUŞTUR ──
  const createPartner = defineTool({
    name: "create_partner",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Yeni cari (müşteri ya da tedarikçi) kartı açar: kod, unvan, vergi numarası, " +
        "adres ve e-Fatura mükellefiyeti. 'Yeni müşteri ekle', 'tedarikçi kaydı aç' " +
        "isteklerinde kullan. Aynı kodla ikinci kart açılmaz.",
      en: "Creates a new business partner (customer or supplier).",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Cari kodu, benzersiz. Örn. C-1005."),
      legalName: z.string().trim().min(2).max(200).describe("Ticari unvan — faturada görünen ad."),
      isCustomer: z.boolean().describe("Müşteri mi?"),
      isSupplier: z.boolean().describe("Tedarikçi mi? Bir cari ikisi birden olabilir."),
      taxId: VergiNo.describe("VKN (10) ya da TCKN (11). Bilinmiyorsa null."),
      taxOffice: z.string().trim().max(60).nullable().describe("Vergi dairesi."),
      city: z.string().trim().max(40).nullable().describe("Şehir."),
      district: z.string().trim().max(40).nullable().describe("İlçe."),
      addressLine: z.string().trim().max(200).nullable().describe("Açık adres."),
      email: z.string().trim().max(160).nullable().describe("E-posta."),
      phone: z.string().trim().max(40).nullable().describe("Telefon."),
      einvoiceUser: z.boolean().describe("e-Fatura mükellefi mi?"),
    }),
    requires: ["master-data:partner.write"],
    async execute(input, ctx) {
      if (!input.isCustomer && !input.isSupplier) {
        throw new BusinessRuleError(
          "Cari en az bir taraf olmalı: müşteri ya da tedarikçi. İkisi de değilse " +
            "kart hiçbir belgeye bağlanamaz ve ölü kayıt olur.",
          "partner_role_required",
        );
      }
      if (await db.partner.findUnique({ where: { code: input.code } })) {
        throw new BusinessRuleError(
          `${input.code} kodlu cari zaten var. Mevcut kartı güncellemek için ` +
            `update_partner kullanın; ikinci kart, cari bakiyesini ikiye böler.`,
          "partner_exists",
        );
      }

      const row = await db.$transaction(async (tx) => {
        await setChangeActor(tx, ctx.principal.userId);
        return tx.partner.create({
          data: {
            code: input.code,
            legalName: input.legalName,
            // İçe aktarma ile AYNI alan kullanılıyor (`core`): iki farklı
            // normalleştirme, aynı carinin iki kez açılmasına yol açar.
            normalized: normalizeName(input.legalName).core,
            isCustomer: input.isCustomer,
            isSupplier: input.isSupplier,
            country: "TR",
            taxOffice: bos(input.taxOffice),
            city: bos(input.city),
            district: bos(input.district),
            addressLine: bos(input.addressLine),
            email: bos(input.email),
            phone: bos(input.phone),
            einvoiceUser: input.einvoiceUser,
            ...(input.taxId
              ? {
                  taxIds: {
                    create: [{ kind: input.taxId.length === 11 ? "tckn" : "vkn", value: input.taxId }],
                  },
                }
              : {}),
          },
        });
      });

      return {
        ok: true as const,
        data: { code: row.code, legalName: row.legalName, id: row.id },
        sources: kaynak("Cari kartları", 1),
        risks: input.taxId
          ? []
          : [
              {
                severity: "warning" as const,
                message:
                  "Vergi numarası girilmedi. Bu cariye e-Fatura kesilemez; " +
                  "fatura kesmeden önce numara tamamlanmalı.",
              },
            ],
        confidence: 99,
      };
    },
  });

  // ── CARİ GÜNCELLE ──
  const updatePartner = defineTool({
    name: "update_partner",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Var olan cari kartını günceller: unvan, vergi numarası, adres, iletişim, " +
        "e-Fatura mükellefiyeti ve aktiflik. YALNIZCA VERİLEN ALANLAR değişir; " +
        "verilmeyen alana dokunulmaz. 'Şu müşterinin adresini düzelt', 'vergi " +
        "numarası yanlış girilmiş' isteklerinde kullan.",
      en: "Updates an existing partner. Only provided fields change.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Güncellenecek carinin kodu."),
      legalName: z.string().trim().min(2).max(200).nullable().describe("Yeni unvan. Değişmeyecekse null."),
      taxId: VergiNo.describe("Yeni vergi numarası. Değişmeyecekse null."),
      taxOffice: z.string().trim().max(60).nullable().describe("Yeni vergi dairesi. Değişmeyecekse null."),
      city: z.string().trim().max(40).nullable().describe("Yeni şehir. Değişmeyecekse null."),
      district: z.string().trim().max(40).nullable().describe("Yeni ilçe. Değişmeyecekse null."),
      addressLine: z.string().trim().max(200).nullable().describe("Yeni adres. Değişmeyecekse null."),
      email: z.string().trim().max(160).nullable().describe("Yeni e-posta. Değişmeyecekse null."),
      phone: z.string().trim().max(40).nullable().describe("Yeni telefon. Değişmeyecekse null."),
      einvoiceUser: z.boolean().nullable().describe("e-Fatura mükellefiyeti. Değişmeyecekse null."),
      isActive: z.boolean().nullable().describe("Aktiflik. Pasifleştirmek için false; değişmeyecekse null."),
    }),
    requires: ["master-data:partner.write"],
    async execute(input, ctx) {
      const mevcut = await db.partner.findUnique({
        where: { code: input.code },
        include: { taxIds: true },
      });
      if (!mevcut) {
        throw new BusinessRuleError(
          `${input.code} kodlu cari bulunamadı. Yeni kart açmak için create_partner kullanın.`,
          "partner_not_found",
        );
      }

      /*
       * KISMİ GÜNCELLEME. `null` "değiştirme" demek, "boşalt" demek
       * değil. Boşaltma ayrı bir istektir ve bu tool onu yapmaz —
       * yanlışlıkla silinen bir vergi numarası, aylar sonra bir
       * e-Fatura reddiyle ortaya çıkar.
       */
      const veri: Record<string, unknown> = {};
      if (input.legalName !== null) {
        veri["legalName"] = input.legalName;
        veri["normalized"] = normalizeName(input.legalName).core;
      }
      for (const [alan, deger] of [
        ["taxOffice", input.taxOffice],
        ["city", input.city],
        ["district", input.district],
        ["addressLine", input.addressLine],
        ["email", input.email],
        ["phone", input.phone],
      ] as const) {
        if (deger !== null) veri[alan] = deger;
      }
      if (input.einvoiceUser !== null) veri["einvoiceUser"] = input.einvoiceUser;
      if (input.isActive !== null) veri["isActive"] = input.isActive;

      const degisenAlanlar = Object.keys(veri).filter((k) => k !== "normalized");
      if (degisenAlanlar.length === 0 && input.taxId === null) {
        throw new BusinessRuleError(
          "Değiştirilecek alan verilmedi. En az bir alan dolu olmalı.",
          "no_change",
        );
      }

      await db.$transaction(async (tx) => {
        await setChangeActor(tx, ctx.principal.userId);
        if (Object.keys(veri).length > 0) {
          await tx.partner.update({ where: { id: mevcut.id }, data: veri });
        }
        if (input.taxId !== null) {
          // Vergi numarası ayrı tabloda ve TEK OLMALI: ikinci bir kayıt
          // hangisinin geçerli olduğunu belirsizleştirir.
          await tx.partnerTaxId.deleteMany({ where: { partnerId: mevcut.id } });
          await tx.partnerTaxId.create({
            data: {
              partnerId: mevcut.id,
              kind: input.taxId.length === 11 ? "tckn" : "vkn",
              value: input.taxId,
            },
          });
        }
      });

      return {
        ok: true as const,
        data: {
          code: mevcut.code,
          changed: [...degisenAlanlar, ...(input.taxId !== null ? ["taxId"] : [])],
          previous: {
            legalName: mevcut.legalName,
            taxId: mevcut.taxIds[0]?.value ?? null,
            city: mevcut.city,
            phone: mevcut.phone,
          },
        },
        sources: kaynak("Cari kartları", 1),
        risks: [],
        confidence: 99,
      };
    },
  });

  // ── ÇALIŞAN OLUŞTUR ──
  const createEmployee = defineTool({
    name: "create_employee",
    module: "hr",
    authority: 2,
    description: {
      tr:
        "Yeni personel kartı açar: kod, ad soyad, departman, unvan, işe giriş tarihi " +
        "ve brüt ücret. 'İşe alım kaydı', 'yeni personel ekle' isteklerinde kullan. " +
        "Kart açmak bordroya girmesini sağlar; ilk bordro işe giriş tarihinden itibaren " +
        "hesaplanır.",
      en: "Creates a new employee record.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Personel kodu, benzersiz. Örn. P-009."),
      fullName: z.string().trim().min(3).max(120).describe("Ad soyad."),
      department: z.string().trim().min(2).max(60).describe("Departman."),
      position: z.string().trim().min(2).max(80).describe("Unvan."),
      hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("İşe giriş tarihi (YYYY-AA-GG)."),
      grossSalary: z.number().positive().max(100_000_000).describe("Aylık brüt ücret (TL)."),
      birthDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .describe(
          "Doğum tarihi. Bilinmiyorsa null — ama o zaman 18 yaş altı / 50 yaş üstü " +
            "izin kademesi uygulanamaz.",
        ),
    }),
    requires: ["master-data:employee.write"],
    async execute(input, ctx) {
      if (await db.employee.findUnique({ where: { code: input.code } })) {
        throw new BusinessRuleError(
          `${input.code} kodlu personel zaten var. Mevcut kartı güncellemek için ` +
            `update_employee kullanın.`,
          "employee_exists",
        );
      }

      const row = await db.$transaction(async (tx) => {
        await setChangeActor(tx, ctx.principal.userId);
        return tx.employee.create({
          data: {
            code: input.code,
            fullName: input.fullName,
            normalized: input.fullName.toLocaleLowerCase("tr"),
            department: input.department,
            position: input.position,
            hiredAt: new Date(`${input.hiredAt}T00:00:00.000Z`),
            grossSalary: input.grossSalary,
            ...(input.birthDate ? { birthDate: new Date(`${input.birthDate}T00:00:00.000Z`) } : {}),
            isActive: true,
          },
        });
      });

      return {
        ok: true as const,
        data: { code: row.code, fullName: row.fullName, department: row.department },
        sources: kaynak("Personel kartları", 1),
        risks: input.birthDate
          ? []
          : [
              {
                severity: "info" as const,
                message:
                  "Doğum tarihi girilmedi. 18 yaş altı ve 50 yaş üstü çalışana kıdemden " +
                  "bağımsız en az 20 gün izin verilir (İş Kanunu 53); bu kademe " +
                  "uygulanamaz ve izin hakkı eksik hesaplanabilir.",
              },
            ],
        confidence: 99,
      };
    },
  });

  // ── ÇALIŞAN GÜNCELLE ──
  const updateEmployee = defineTool({
    name: "update_employee",
    module: "hr",
    authority: 2,
    description: {
      tr:
        "Personel kartını günceller: departman, unvan, brüt ücret, doğum tarihi, " +
        "aktiflik ve işten çıkış tarihi. YALNIZCA VERİLEN ALANLAR değişir. 'Zam yap', " +
        "'departman değiştir', 'işten ayrıldı' isteklerinde kullan. Ücret değişikliği " +
        "sonraki bordroya yansır; geçmiş bordroları DEĞİŞTİRMEZ.",
      en: "Updates an employee record. Only provided fields change.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Güncellenecek personelin kodu."),
      department: z.string().trim().min(2).max(60).nullable().describe("Yeni departman. Değişmeyecekse null."),
      position: z.string().trim().min(2).max(80).nullable().describe("Yeni unvan. Değişmeyecekse null."),
      grossSalary: z.number().positive().max(100_000_000).nullable().describe("Yeni brüt ücret. Değişmeyecekse null."),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe("Doğum tarihi. Değişmeyecekse null."),
      terminatedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .describe("İşten çıkış tarihi. Ayrılmadıysa null."),
    }),
    requires: ["master-data:employee.write"],
    async execute(input, ctx) {
      const mevcut = await db.employee.findUnique({ where: { code: input.code } });
      if (!mevcut) {
        throw new BusinessRuleError(
          `${input.code} kodlu personel bulunamadı. Yeni kart için create_employee kullanın.`,
          "employee_not_found",
        );
      }

      const veri: Record<string, unknown> = {};
      if (input.department !== null) veri["department"] = input.department;
      if (input.position !== null) veri["position"] = input.position;
      if (input.grossSalary !== null) veri["grossSalary"] = input.grossSalary;
      if (input.birthDate !== null) veri["birthDate"] = new Date(`${input.birthDate}T00:00:00.000Z`);
      if (input.terminatedAt !== null) {
        veri["terminatedAt"] = new Date(`${input.terminatedAt}T00:00:00.000Z`);
        // ÇIKIŞ TARİHİ VERİLDİYSE KART PASİFLEŞİR. İkisini ayrı
        // bırakmak, "ayrıldı ama hâlâ bordroda" durumunu doğurur.
        veri["isActive"] = false;
      }

      if (Object.keys(veri).length === 0) {
        throw new BusinessRuleError(
          "Değiştirilecek alan verilmedi. En az bir alan dolu olmalı.",
          "no_change",
        );
      }

      await db.$transaction(async (tx) => {
        await setChangeActor(tx, ctx.principal.userId);
        await tx.employee.update({ where: { id: mevcut.id }, data: veri });
      });

      const ucretDegisti = input.grossSalary !== null;
      return {
        ok: true as const,
        data: {
          code: mevcut.code,
          fullName: mevcut.fullName,
          changed: Object.keys(veri),
          previous: {
            department: mevcut.department,
            position: mevcut.position,
            grossSalary: mevcut.grossSalary === null ? null : Number(mevcut.grossSalary),
          },
        },
        sources: kaynak("Personel kartları", 1),
        risks: ucretDegisti
          ? [
              {
                severity: "info" as const,
                message:
                  "Ücret değişikliği yalnızca SONRAKİ bordrolara yansır. Çalıştırılmış " +
                  "bir dönemi düzeltmek gerekiyorsa o dönem yeniden çalıştırılmalıdır.",
              },
            ]
          : [],
        confidence: 99,
      };
    },
  });

  // ── MALZEME GÜNCELLE ──
  const updateItem = defineTool({
    name: "update_item",
    module: "master-data",
    authority: 2,
    description: {
      tr:
        "Malzeme kartını günceller: ad, tür, parti/seri takibi ve aktiflik. YALNIZCA " +
        "VERİLEN ALANLAR değişir. Ölçü birimi ve değerleme yöntemi BURADAN " +
        "DEĞİŞTİRİLEMEZ: ikisi de geçmiş stok hareketlerinin anlamını değiştirir.",
      en: "Updates an item master record. Only provided fields change.",
    },
    input: z.strictObject({
      code: z.string().trim().min(1).max(40).describe("Güncellenecek malzemenin kodu."),
      name: z.string().trim().min(2).max(200).nullable().describe("Yeni ad. Değişmeyecekse null."),
      type: z
        .enum(["hammadde", "yari_mamul", "mamul", "sarf", "hizmet"])
        .nullable()
        .describe("Yeni tür. Değişmeyecekse null."),
      batchManaged: z.boolean().nullable().describe("Parti takibi açık mı? Değişmeyecekse null."),
      serialManaged: z.boolean().nullable().describe("Seri takibi açık mı? Değişmeyecekse null."),
      isActive: z.boolean().nullable().describe("Aktiflik. Değişmeyecekse null."),
    }),
    requires: ["master-data:item.write"],
    async execute(input, ctx) {
      const mevcut = await db.item.findUnique({ where: { code: input.code } });
      if (!mevcut) {
        throw new BusinessRuleError(
          `${input.code} kodlu malzeme bulunamadı.`,
          "item_not_found",
        );
      }

      const veri: Record<string, unknown> = {};
      if (input.name !== null) {
        veri["name"] = input.name;
        veri["normalized"] = input.name.toLocaleLowerCase("tr");
      }
      if (input.type !== null) veri["type"] = input.type;
      if (input.batchManaged !== null) veri["batchManaged"] = input.batchManaged;
      if (input.serialManaged !== null) veri["serialManaged"] = input.serialManaged;
      if (input.isActive !== null) veri["isActive"] = input.isActive;

      if (Object.keys(veri).length === 0) {
        throw new BusinessRuleError("Değiştirilecek alan verilmedi.", "no_change");
      }

      /*
       * PARTİ TAKİBİNİ KAPATMAK GEÇMİŞİ BOZAR. Hareketleri partiye
       * bağlı bir malzemede takibi kapatmak, o bağların anlamını
       * ortadan kaldırır ve izlenebilirlik kalıcı olarak kaybolur.
       */
      if (input.batchManaged === false && mevcut.batchManaged) {
        const bagli = await db.batch.count({ where: { itemId: mevcut.code } });
        if (bagli > 0) {
          throw new BusinessRuleError(
            `${mevcut.code} için ${bagli} parti kaydı var; parti takibi kapatılamaz. ` +
              `Kapatılırsa mevcut partilerin izlenebilirliği kalıcı olarak kaybolur.`,
            "batch_history_exists",
          );
        }
      }

      await db.$transaction(async (tx) => {
        await setChangeActor(tx, ctx.principal.userId);
        await tx.item.update({ where: { id: mevcut.id }, data: veri });
      });

      return {
        ok: true as const,
        data: {
          code: mevcut.code,
          changed: Object.keys(veri).filter((k) => k !== "normalized"),
          previous: { name: mevcut.name, type: mevcut.type, isActive: mevcut.isActive },
        },
        sources: kaynak("Malzeme kartları", 1),
        risks: [],
        confidence: 99,
      };
    },
  });

  return [createPartner, updatePartner, createEmployee, updateEmployee, updateItem] as const;
}
