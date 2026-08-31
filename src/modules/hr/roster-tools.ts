/**
 * Kadro tool'ları — kim çalışıyor, kim ne yapıyor.
 *
 * NEDEN SONRADAN EKLENDİ, VE NEDEN GECİKMESİ BİR KUSURDU:
 *
 * İK modülünde kişi bazlı her şey vardı — izin bakiyesi, mesai, vardiya,
 * kart geçmişi — ama hepsi PERSONEL KODU ya da departman adı istiyordu.
 * Kadro listesi çıkaran hiçbir tool yoktu.
 *
 * Sonucu şuydu: patron "mevcut çalışanlarımız kimler" diye soruyor ve
 * "böyle bir yetenek yok, personel kodunu verirseniz..." cevabını
 * alıyordu. Kodu bilmek için önce listeyi görmek gerekir; liste
 * olmayınca hiçbir kişi sorgusuna da başlanamıyordu. Zincirin ilk
 * halkası eksikti.
 *
 * Malzeme tarafında `search_items` ilk günden vardı. Aynı ihtiyacın
 * personel tarafında da olduğu gözden kaçmış.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * MAAŞ ALAN SEVİYESİNDE MASKELENİR. Tool seviyesi izin burada
 * yetmez: üretim müdürü kendi ekibinin listesini görmeli ama
 * ücretlerini görmemeli. `redactFields` ücreti "[yetki dışı]" yapar
 * ve model o alanı ne okuyabilir ne de uydurabilir.
 *
 * İŞTEN AYRILANLAR VARSAYILAN OLARAK GELMEZ. "Kaç kişiyiz" sorusuna
 * ayrılmış personeli katmak, kadro sayısını sistematik olarak yanlış
 * gösterir. İstenirse açıkça istenir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import { redactFields } from "../../kernel/rbac.js";
import type { TenantDb } from "../../db/client.js";

/** Ücret yalnızca bordro yetkisi olana açık. */
const UCRET_KURALI = [{ field: "grossSalary" as const, requires: "hr:payroll.read" as const }];

/** Kıdemi yıl olarak — "ne zamandır burada" sorusunun cevabı. */
function kidemYili(hiredAt: Date, on: Date): number {
  return Math.floor((on.getTime() - hiredAt.getTime()) / (365.25 * 86_400_000));
}

export function rosterTools(db: TenantDb) {
  const search = defineTool({
    name: "search_employees",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Çalışan listesini döndürür: ad, personel kodu, departman, unvan, işe giriş " +
        "tarihi ve kıdem. Ada göre arama, departmana göre filtreleme yapılır; filtre " +
        "verilmezse TÜM aktif kadro gelir. 'Çalışanlarımız kimler', 'kaç kişiyiz', " +
        "'üretimde kimler var' sorularında bunu kullan. Ücret yalnızca bordro " +
        "yetkisi olan rollere görünür.",
      en: "Lists employees with code, department, position, hire date and tenure.",
    },
    input: z.strictObject({
      nameQuery: z
        .string()
        .min(2)
        .nullable()
        .describe("Adın bir bölümü. Tüm kadro için null gönder."),
      department: z
        .string()
        .min(2)
        .nullable()
        .describe("Departman adı ile filtre. Filtresiz liste için null gönder."),
      includeTerminated: z
        .boolean()
        .describe("İşten ayrılanlar da gelsin mi? Kadro sayımında false gönder."),
    }),
    requires: ["hr:roster.read"],
    async execute(input, ctx) {
      const rows = await db.employee.findMany({
        where: {
          ...(input.includeTerminated ? {} : { isActive: true, terminatedAt: null }),
          ...(input.nameQuery
            ? { normalized: { contains: input.nameQuery.toLocaleLowerCase("tr") } }
            : {}),
          ...(input.department
            ? { department: { contains: input.department, mode: "insensitive" as const } }
            : {}),
        },
        orderBy: [{ department: "asc" }, { fullName: "asc" }],
        take: 200,
      });

      const bugun = new Date();
      const employees = rows.map((e) =>
        redactFields(
          {
            code: e.code,
            fullName: e.fullName,
            department: e.department,
            position: e.position,
            hiredAt: e.hiredAt.toISOString().slice(0, 10),
            tenureYears: kidemYili(e.hiredAt, bugun),
            grossSalary: e.grossSalary === null ? null : Number(e.grossSalary),
            isActive: e.isActive && e.terminatedAt === null,
            terminatedAt: e.terminatedAt?.toISOString().slice(0, 10) ?? null,
          },
          UCRET_KURALI,
          ctx.principal,
        ),
      );

      // Departman kırılımı: "kaç kişiyiz" sorusunun ikinci yarısı hep
      // "nerede kaç kişi" olur.
      const byDepartment = [...new Set(rows.map((e) => e.department))]
        .sort()
        .map((d) => ({ department: d, count: rows.filter((e) => e.department === d).length }));

      return {
        ok: true as const,
        data: { total: employees.length, byDepartment, employees },
        sources: [
          {
            system: "Personel kartları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          rows.length === 200
            ? [
                {
                  severity: "warning" as const,
                  message:
                    "Liste 200 kayıtta kesildi. Departman ya da ad filtresiyle daraltın; " +
                    "kesilen listeden çıkarılan bir toplam yanlış olur.",
                },
              ]
            : [],
        confidence: 97,
      };
    },
  });

  const one = defineTool({
    name: "get_employee",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Tek bir çalışanın kartını döndürür: personel kodu, departman, unvan, işe " +
        "giriş, kıdem ve durum. Personel KODU ya da ADI ile çağrılabilir — ad " +
        "birden fazla kişiyle eşleşirse hangileri olduğu söylenir ve kart " +
        "döndürülmez. Ücret yalnızca bordro yetkisi olan rollere görünür.",
      en: "Returns one employee card by code or name.",
    },
    input: z.strictObject({
      query: z.string().min(2).describe("Personel kodu (örn. P-001) ya da adın bir bölümü."),
    }),
    requires: ["hr:roster.read"],
    async execute(input, ctx) {
      const q = input.query.trim();
      const rows = await db.employee.findMany({
        where: {
          OR: [
            { code: { equals: q, mode: "insensitive" } },
            { normalized: { contains: q.toLocaleLowerCase("tr") } },
          ],
        },
        take: 10,
      });

      /*
       * TEK BİR DÖNÜŞ ŞEKLİ.
       *
       * Bulundu/bulunamadı için iki farklı şekil döndürmek, çağıranı
       * her seferinde şekil kontrolüne zorlar ve modelin de iki ayrı
       * kalıp öğrenmesini gerektirir. Aynı alanlar hep var; olmayan
       * null.
       */
      const bulundu = rows.length === 1;
      const e = bulundu ? rows[0]! : null;

      return {
        ok: true as const,
        data: {
          found: bulundu,
          /*
           * BELİRSİZ EŞLEŞMEDE KART DÖNDÜRÜLMEZ.
           *
           * İki "Mehmet" varsa birini seçip döndürmek, yanlış kişinin
           * maaşını ya da izin bakiyesini göstermek demektir. Hangileri
           * olduğu söylenir, seçim kullanıcıya bırakılır.
           */
          matches: bulundu
            ? []
            : rows.map((r) => ({
                code: r.code,
                fullName: r.fullName,
                department: r.department,
              })),
          message: bulundu
            ? ""
            : rows.length === 0
              ? `"${q}" ile eşleşen çalışan yok.`
              : `"${q}" ${rows.length} kişiyle eşleşiyor. Personel kodunu verin.`,
          employee: e
            ? redactFields(
                {
                  code: e.code,
                  fullName: e.fullName,
                  department: e.department,
                  position: e.position,
                  hiredAt: e.hiredAt.toISOString().slice(0, 10),
                  tenureYears: kidemYili(e.hiredAt, new Date()),
                  // Doğum tarihi bilinmiyorsa TAHMİN EDİLMEZ: 18 yaş altı
                  // ve 50 yaş üstü izin kademesi buna bağlı ve yanlış bir
                  // tarih hakkı eksik hesaplatır.
                  birthDate: e.birthDate?.toISOString().slice(0, 10) ?? null,
                  grossSalary: e.grossSalary === null ? null : Number(e.grossSalary),
                  isActive: e.isActive && e.terminatedAt === null,
                  terminatedAt: e.terminatedAt?.toISOString().slice(0, 10) ?? null,
                },
                UCRET_KURALI,
                ctx.principal,
              )
            : null,
        },
        sources: [
          {
            system: "Personel kartları",
            kind: "module" as const,
            recordCount: rows.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          e && e.birthDate === null
            ? [
                {
                  severity: "info" as const,
                  message:
                    "Doğum tarihi kayıtlı değil; 18 yaş altı / 50 yaş üstü izin kademesi " +
                    "uygulanamaz ve yıllık izin hakkı eksik hesaplanabilir.",
                },
              ]
            : [],
        confidence: bulundu ? 97 : 95,
      };
    },
  });

  /*
   * DEMET OLARAK DÖNÜYOR (`as const`), dizi olarak değil.
   *
   * Dizi dönseydi çağıran taraf iki tool'un BİRLEŞİM tipini görür ve
   * `execute` parametreleri kesişime düşerdi — her çağrıda iki tool'un
   * girdilerinin toplamı istenirdi. Demet her elemanın kendi tipini
   * korur.
   */
  return [search, one] as const;
}
