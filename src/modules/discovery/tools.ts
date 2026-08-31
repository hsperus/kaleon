/**
 * Keşif tool'ları — "hangi kayıt?" sorusunun cevabı.
 *
 * SİSTEMİK BİR BOŞLUKTU. Ayrıntı tool'ları belge numarası ya da kod
 * istiyor: `get_stock_count(documentNo)`, `get_sales_order(orderNo)`,
 * `get_purchase_requisition(documentNo)`. Ama o numarayı bulmanın hiçbir
 * yolu yoktu.
 *
 * Sonucu somut: kullanıcı "stok sayımında fark var mı" diye sordu ve
 * ajan "sayım belge numarasını verir misiniz, açık sayımları listeleyen
 * bir yetenek yok" dedi. Numarayı bilmek için önce listeyi görmek
 * gerekir; liste olmayınca zincir hiç başlamıyordu.
 *
 * Aynı hata kadro tarafında da vardı ve `search_employees` ile
 * kapatılmıştı. Bu dosya kalan yedi yeri kapatıyor — çünkü tek tek
 * değil, DESEN olarak eksikti.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * HEPSİ OKUMADIR (L0) ve hepsi VARSAYILAN OLARAK AÇIK/GÜNCEL kaydı
 * getirir. "Kaç açık siparişim var" sorusuna iptal edilmişleri katmak,
 * sayıyı sistematik olarak yanlış gösterir; kapalıları isteyen açıkça
 * ister.
 *
 * ÜST SINIR VE UYARI. Liste kesildiğinde bunu söylemek zorunludur:
 * kesilmiş bir listeden çıkarılan toplam yanlıştır ve kullanıcı
 * kesildiğini bilmezse o yanlışa güvenir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { TenantDb } from "../../db/client.js";

const LIMIT = 100;

/** Kesilmiş liste uyarısı — sessiz kesme, yanlış toplamın kaynağıdır. */
function kesikUyari(n: number) {
  return n < LIMIT
    ? []
    : [
        {
          severity: "warning" as const,
          message:
            `Liste ${LIMIT} kayıtta kesildi. Filtre daraltın; kesilmiş bir ` +
            `listeden çıkarılan toplam yanlış olur.`,
        },
      ];
}

function kaynak(system: string, recordCount: number) {
  return [{ system, kind: "module" as const, recordCount, syncedAt: new Date().toISOString() }];
}

const gun = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

export function discoveryTools(db: TenantDb) {
  // ── Cariler ── "müşterilerimiz kimler" sorusunun cevabı.
  const partners = defineTool({
    name: "list_partners",
    module: "master-data",
    authority: 0,
    description: {
      tr:
        "Cari listesini döndürür: müşteriler, tedarikçiler ya da hepsi. Kod, unvan, " +
        "vergi numarası, şehir ve e-Fatura mükellefiyeti. 'Müşterilerimiz kimler', " +
        "'kaç tedarikçimiz var', 'hangi carilerle çalışıyoruz' sorularında kullan. " +
        "Tek bir cariyi ada göre bulmak için resolve_partner daha uygundur.",
      en: "Lists business partners: customers, suppliers or both.",
    },
    input: z.strictObject({
      kind: z.enum(["musteri", "tedarikci", "hepsi"]).describe("Hangi taraf listelensin."),
      nameQuery: z.string().min(2).nullable().describe("Unvanın bir bölümü. Filtresiz için null."),
    }),
    requires: ["master-data:partner.read"],
    async execute(input) {
      const rows = await db.partner.findMany({
        where: {
          ...(input.kind === "musteri" ? { isCustomer: true } : {}),
          ...(input.kind === "tedarikci" ? { isSupplier: true } : {}),
          ...(input.nameQuery
            ? { normalized: { contains: input.nameQuery.toLocaleLowerCase("tr") } }
            : {}),
          mergedInto: null,
        },
        orderBy: { legalName: "asc" },
        take: LIMIT,
        include: { taxIds: { take: 1 } },
      });
      return {
        ok: true as const,
        data: {
          total: rows.length,
          partners: rows.map((p) => ({
            code: p.code,
            legalName: p.legalName,
            taxId: p.taxIds[0]?.value ?? null,
            city: p.city,
            isCustomer: p.isCustomer,
            isSupplier: p.isSupplier,
            einvoiceUser: p.einvoiceUser,
          })),
        },
        sources: kaynak("Cari kartları", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Satış siparişleri ──
  const salesOrders = defineTool({
    name: "list_sales_orders",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Satış siparişlerini listeler: sipariş no, müşteri, taahhüt tarihi, para birimi " +
        "ve durum. Varsayılan olarak AÇIK siparişler gelir. 'Hangi siparişlerim açık', " +
        "'kaç sipariş var', 'X müşterisinin siparişleri' sorularında kullan.",
      en: "Lists sales orders with customer, committed date and status.",
    },
    input: z.strictObject({
      status: z.enum(["acik", "hepsi"]).describe("Yalnızca açık siparişler mi, hepsi mi."),
      partnerCode: z.string().min(1).nullable().describe("Cari kodu ile filtre. Filtresiz için null."),
    }),
    requires: ["sales:order.read"],
    async execute(input) {
      const partner = input.partnerCode
        ? await db.partner.findUnique({ where: { code: input.partnerCode } })
        : null;
      const rows = await db.salesOrder.findMany({
        where: {
          ...(input.status === "acik" ? { status: "open", cancelledAt: null } : {}),
          ...(partner ? { partnerId: partner.id } : {}),
        },
        orderBy: { committedDate: "asc" },
        take: LIMIT,
        include: { lines: true },
      });
      const adlar = new Map(
        (
          await db.partner.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
            select: { id: true, legalName: true, code: true },
          })
        ).map((p) => [p.id, p]),
      );
      return {
        ok: true as const,
        data: {
          total: rows.length,
          orders: rows.map((o) => ({
            orderNo: o.orderNo,
            partnerCode: adlar.get(o.partnerId)?.code ?? null,
            partner: adlar.get(o.partnerId)?.legalName ?? null,
            committedDate: gun(o.committedDate),
            currency: o.currency,
            status: o.cancelledAt ? "iptal" : o.status,
            lineCount: o.lines.length,
          })),
        },
        sources: kaynak("Satış siparişleri", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Satış faturaları ──
  const invoices = defineTool({
    name: "list_sales_invoices",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Kesilmiş satış faturalarını listeler: belge no, müşteri, tarih, vade ve tutar. " +
        "'Bu ay hangi faturaları kestik', 'son faturalar', 'X müşterisine kesilen " +
        "faturalar' sorularında kullan. Faturanın kendisini görmek için " +
        "get_invoice_document kullan.",
      en: "Lists issued sales invoices.",
    },
    input: z.strictObject({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe("Başlangıç tarihi (YYYY-AA-GG). Sınırsız için null."),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().describe("Bitiş tarihi. Sınırsız için null."),
      partnerCode: z.string().min(1).nullable().describe("Cari kodu ile filtre."),
    }),
    requires: ["sales:invoice.read"],
    async execute(input) {
      const partner = input.partnerCode
        ? await db.partner.findUnique({ where: { code: input.partnerCode } })
        : null;
      const rows = await db.salesInvoice.findMany({
        where: {
          ...(input.from || input.to
            ? {
                issuedAt: {
                  ...(input.from ? { gte: new Date(`${input.from}T00:00:00.000Z`) } : {}),
                  ...(input.to ? { lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
                },
              }
            : {}),
          ...(partner ? { partnerId: partner.id } : {}),
        },
        orderBy: { issuedAt: "desc" },
        take: LIMIT,
      });
      const adlar = new Map(
        (
          await db.partner.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
            select: { id: true, legalName: true },
          })
        ).map((p) => [p.id, p.legalName]),
      );
      return {
        ok: true as const,
        data: {
          total: rows.length,
          invoices: rows.map((f) => ({
            documentNo: f.documentNo,
            partner: adlar.get(f.partnerId) ?? null,
            issuedAt: gun(f.issuedAt),
            dueDate: gun(f.dueDate),
            currency: f.currency,
            totalAmount: Number(f.totalAmount),
          })),
        },
        sources: kaynak("Satış faturaları", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Stok sayımları ── "sayımda fark var mı" burada başlar.
  const stockCounts = defineTool({
    name: "list_stock_counts",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Stok sayımlarını listeler: belge no, depo, tarih, durum (açık/kapandı) ve " +
        "sayılmış satır sayısı. 'Sayımda fark var mı', 'açık sayım var mı', " +
        "'son sayım ne zamandı' sorularında ÖNCE bunu çağır; farkları görmek için " +
        "dönen belge numarasıyla get_stock_count_differences kullan.",
      en: "Lists stock counts with location, date and status.",
    },
    input: z.strictObject({
      status: z.enum(["acik", "hepsi"]).describe("Yalnızca açık sayımlar mı, hepsi mi."),
    }),
    requires: ["inventory:count.read"],
    async execute(input) {
      const rows = await db.stockCount.findMany({
        where: input.status === "acik" ? { postedAt: null } : {},
        orderBy: { countDate: "desc" },
        take: LIMIT,
        include: { lines: true },
      });
      const depolar = new Map(
        (
          await db.location.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.locationId))] } },
            select: { id: true, code: true, name: true },
          })
        ).map((l) => [l.id, l]),
      );
      return {
        ok: true as const,
        data: {
          total: rows.length,
          counts: rows.map((c) => ({
            documentNo: c.documentNo,
            location: depolar.get(c.locationId)?.name ?? null,
            countDate: gun(c.countDate),
            status: c.postedAt ? "kapandı" : "açık",
            postedAt: gun(c.postedAt),
            lineCount: c.lines.length,
            // Sayılmamış satır varsa sayım henüz bitmemiştir; farkı
            // "eksik" diye okumak yanlış olur.
            countedLineCount: c.lines.filter((l) => l.countedAt !== null).length,
          })),
        },
        sources: kaynak("Stok sayımları", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Satın alma talepleri ──
  const requisitions = defineTool({
    name: "list_purchase_requisitions",
    module: "documents",
    authority: 0,
    description: {
      tr:
        "Satın alma taleplerini listeler: belge no, departman, durum (taslak/onaylı/" +
        "reddedilmiş), tahmini tutar. 'Bekleyen talep var mı', 'hangi talepler onay " +
        "bekliyor' sorularında kullan.",
      en: "Lists purchase requisitions with status and estimated total.",
    },
    input: z.strictObject({
      status: z.enum(["bekleyen", "hepsi"]).describe("Yalnızca onay bekleyenler mi, hepsi mi."),
    }),
    requires: ["documents:requisition.read"],
    async execute(input) {
      const rows = await db.purchaseRequisition.findMany({
        where: input.status === "bekleyen" ? { approvedAt: null, status: { not: "rejected" } } : {},
        orderBy: { createdAt: "desc" },
        take: LIMIT,
        include: { lines: true },
      });
      return {
        ok: true as const,
        data: {
          total: rows.length,
          requisitions: rows.map((t) => ({
            documentNo: t.documentNo,
            department: t.department,
            status: t.status,
            estimatedTotal: t.estimatedTotal === null ? null : Number(t.estimatedTotal),
            currency: t.currency,
            approvedAt: gun(t.approvedAt),
            lineCount: t.lines.length,
          })),
        },
        sources: kaynak("Satın alma talepleri", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Bordro koşuları ──
  const payrollRuns = defineTool({
    name: "list_payroll_runs",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Çalıştırılmış bordro dönemlerini listeler: dönem, çalışan sayısı, toplam brüt " +
        "ve net, muhasebe fiş numarası. 'Hangi aylar bordrolandı', 'bordro çalıştı mı' " +
        "sorularında kullan. Bir dönemin ayrıntısı için get_payroll_summary.",
      en: "Lists executed payroll runs by period.",
    },
    input: z.strictObject({
      year: z.number().int().min(2000).max(2100).nullable().describe("Yıl ile filtre. Hepsi için null."),
    }),
    requires: ["hr:payroll.read"],
    async execute(input) {
      const rows = await db.payrollRun.findMany({
        where: input.year
          ? {
              period: {
                gte: new Date(Date.UTC(input.year, 0, 1)),
                lt: new Date(Date.UTC(input.year + 1, 0, 1)),
              },
            }
          : {},
        orderBy: { period: "desc" },
        take: LIMIT,
      });
      return {
        ok: true as const,
        data: {
          total: rows.length,
          runs: rows.map((r) => ({
            period: r.period.toISOString().slice(0, 7),
            status: r.status,
            employeeCount: r.employeeCount,
            totalGross: Number(r.totalGross),
            totalNet: Number(r.totalNet),
            totalEmployerCost: Number(r.totalEmployerCost),
            journalDocumentNo: r.journalDocumentNo,
          })),
        },
        sources: kaynak("Bordro koşuları", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 98,
      };
    },
  });

  // ── Teklifler ──
  const quotations = defineTool({
    name: "list_sales_quotations",
    module: "sales",
    authority: 0,
    description: {
      tr:
        "Satış tekliflerini listeler: belge no, müşteri, geçerlilik tarihi ve durum. " +
        "'Hangi teklifler açık', 'süresi dolan teklif var mı' sorularında kullan.",
      en: "Lists sales quotations with validity and status.",
    },
    input: z.strictObject({
      status: z.enum(["acik", "hepsi"]).describe("Yalnızca açık teklifler mi, hepsi mi."),
    }),
    requires: ["sales:quotation.read"],
    async execute(input) {
      const rows = await db.salesQuotation.findMany({
        where: input.status === "acik" ? { status: { in: ["draft", "sent", "open"] } } : {},
        orderBy: { quotedAt: "desc" },
        take: LIMIT,
      });
      const adlar = new Map(
        (
          await db.partner.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.partnerId))] } },
            select: { id: true, legalName: true },
          })
        ).map((p) => [p.id, p.legalName]),
      );
      const bugun = new Date();
      return {
        ok: true as const,
        data: {
          total: rows.length,
          quotations: rows.map((t) => ({
            documentNo: t.documentNo,
            partner: adlar.get(t.partnerId) ?? null,
            quotedAt: gun(t.quotedAt),
            validUntil: gun(t.validUntil),
            expired: t.validUntil < bugun,
            status: t.status,
            convertedToOrder: t.salesOrderNo,
          })),
        },
        sources: kaynak("Satış teklifleri", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  // ── Partiler ──
  const batches = defineTool({
    name: "list_batches",
    module: "inventory",
    authority: 0,
    description: {
      tr:
        "Parti kayıtlarını listeler: malzeme, parti no, üretim/giriş tarihi, durum ve " +
        "son kullanma. 'Hangi partilerim var', 'X malzemesinin partileri' sorularında " +
        "kullan. Yalnızca raf ömrü dolmak üzere olanlar için list_expiring_batches.",
      en: "Lists batches with item, status and expiry.",
    },
    input: z.strictObject({
      itemCode: z.string().min(1).nullable().describe("Malzeme kodu ile filtre. Hepsi için null."),
    }),
    requires: ["inventory:batch.read"],
    async execute(input) {
      const rows = await db.batch.findMany({
        where: input.itemCode ? { itemId: input.itemCode } : {},
        orderBy: { producedAt: "desc" },
        take: LIMIT,
      });
      return {
        ok: true as const,
        data: {
          total: rows.length,
          batches: rows.map((b) => ({
            itemCode: b.itemId,
            batchNo: b.batchNo,
            producedAt: gun(b.producedAt),
            expiryDate: gun(b.expiryDate),
            status: b.status,
            origin: b.origin,
            supplierBatchNo: b.supplierBatchNo,
          })),
        },
        sources: kaynak("Parti kayıtları", rows.length),
        risks: kesikUyari(rows.length),
        confidence: 97,
      };
    },
  });

  return [
    partners,
    salesOrders,
    invoices,
    stockCounts,
    requisitions,
    payrollRuns,
    quotations,
    batches,
  ] as const;
}
