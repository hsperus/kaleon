/**
 * Satış zinciri deposu — sipariş, sevkiyat, fatura.
 *
 * HER BELGE TEK BİR VERİTABANI İŞLEMİNDE OLUŞUR. Bir sevkiyat kaydı üç şey
 * yapar: irsaliye satırlarını yazar, sipariş kalemlerinin sevk edilen
 * miktarını artırır ve stok hareketi üretir. Bunlar ayrı işlemlerde
 * yapılsaydı, aradaki bir çökme depoyu "mal çıktı ama sipariş hâlâ açık"
 * ya da tam tersi bir durumda bırakırdı — ve bu iki durum arasındaki fark,
 * müşteriye ikinci kez mal göndermektir.
 *
 * MİKTAR ARTIRMA OKUNAN DEĞERE DAYANMAZ. `delivered_qty = delivered_qty + x`
 * biçiminde, veritabanının kendi içinde artırılır. Okuyup JS'te toplayıp
 * geri yazmak, iki eşzamanlı sevkiyatta birinin artışını kaybettirir.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { toMoney, toQuantity } from "./decimal.js";
import {
  DEFAULT_SERIES,
  formatDocumentNo,
  type DocumentKind,
} from "../modules/sales/numbering.js";
import {
  assertDeliverable,
  assertDeliveryCancellable,
  assertInvoiceable,
  deriveOrderStatus,
  isClosed,
  DocumentFlowError,
  type LineProgress,
  type OrderStatus,
} from "../modules/sales/o2c.js";
import {
  documentTotals,
  fromKurus,
  priceLine,
  type LineAmounts,
} from "../modules/sales/pricing.js";
import { ValuationRepository } from "./valuation-repository.js";
import { assertPeriodOpen } from "./period-repository.js";
import { JournalRepository } from "./journal-repository.js";
import { cogsLines, salesInvoiceLines } from "../modules/accounting/posting-rules.js";
import { BatchRepository } from "./batch-repository.js";

type Tx = Prisma.TransactionClient;

export interface OrderLineView extends LineProgress {
  readonly unitPrice: number;
  readonly discountPercent: number;
  readonly vatRate: number;
  readonly workOrderId: string | null;
}

export interface OrderView {
  readonly id: string;
  readonly orderNo: string;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly committedDate: string;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly overDeliveryTolerance: number;
  readonly lines: readonly OrderLineView[];
  readonly netAmount: number;
  readonly vatAmount: number;
  readonly totalAmount: number;
}

export interface DeliveryLineInput {
  readonly orderLineNo: number;
  readonly quantity: number;
  readonly batchId?: string | null;
}

export interface InvoiceLineSource {
  readonly deliveryId: string;
  readonly deliveryLineNo: number;
}

/**
 * Sıradaki belge numarasını verir — çağıran işlemin İÇİNDE.
 *
 * `tx` parametresi zorunludur: numara belgeyle aynı işlemde alınmazsa,
 * belge yazılamadığında seride delik kalır.
 */
export async function nextDocumentNo(
  tx: Tx,
  kind: DocumentKind,
  year: number,
): Promise<string> {
  const def = DEFAULT_SERIES[kind];

  // Tek ifadede kilitle-ve-artır. İki eşzamanlı belge sıraya girer;
  // ikisi de aynı numarayı alamaz.
  const rows = await tx.$queryRaw<{ last_number: number; series: string; padding: number }[]>`
    INSERT INTO "document_number_ranges" ("id", "kind", "series", "year", "last_number", "padding", "updated_at")
    VALUES (gen_random_uuid(), ${kind}, ${def.series}, ${year}, 1, ${def.padding}, NOW())
    ON CONFLICT ("kind", "series", "year")
    DO UPDATE SET "last_number" = "document_number_ranges"."last_number" + 1, "updated_at" = NOW()
    RETURNING "last_number", "series", "padding"
  `;

  const row = rows[0];
  if (!row) throw new Error(`Belge numarası alınamadı: ${kind}/${year}`);

  return formatDocumentNo(
    { kind, series: row.series, year, padding: row.padding },
    row.last_number,
  );
}

/**
 * Sipariş satırını KİLİTLER ve kimliğini döndürür.
 *
 * OKU-KONTROL ET-YAZ ARASINDA YARIŞ VARDIR. İki sevkiyat aynı anda
 * gelirse ikisi de "sevk edilen 0" okur, ikisi de 60 adedi onaylar ve
 * 100'lük siparişten 120 adet çıkar. Kural doğrudur ama iki okumanın
 * arasında uygulanmamıştır — bir ERP'de en pahalı hata sınıfı budur.
 *
 * Kilit SİPARİŞ BAŞINADIR, kalem başına değil: aynı siparişin iki kalemi
 * eşzamanlı sevk edilse bile durum türetmesi bütün kalemleri okur, o
 * yüzden bütünün tek elden ilerlemesi gerekir. Farklı siparişler
 * birbirini beklemez.
 */
async function lockOrder(tx: Tx, where: { orderNo?: string; id?: string }): Promise<string | null> {
  const rows = where.orderNo
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "sales_orders" WHERE "order_no" = ${where.orderNo} FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "sales_orders" WHERE "id" = ${where.id}::uuid FOR UPDATE`;
  return rows[0]?.id ?? null;
}

export class SalesRepository {
  readonly #db: TenantDb;
  /**
   * Değerleme İÇERİDE kurulur, dışarıdan verilmez.
   *
   * Opsiyonel olsaydı, bir çağrı yerinde unutulur ve o sevkiyatlar
   * maliyetsiz kalırdı — sonra "bu ürünün maliyeti neden bilinmiyor"
   * sorusunun cevabı aylar sonra aranırdı. Her sevkiyat değerlenir.
   */
  readonly #valuation: ValuationRepository;
  /** Parti kontrolü de aynı gerekçeyle içeride: atlanabilir olmamalı. */
  readonly #batches: BatchRepository;

  constructor(db: TenantDb) {
    this.#db = db;
    this.#valuation = new ValuationRepository(db);
    this.#batches = new BatchRepository(db);
  }

  async orderByNo(orderNo: string): Promise<OrderView | null> {
    const row = await this.#db.salesOrder.findUnique({
      where: { orderNo },
      include: { lines: { orderBy: { lineNo: "asc" } }, partner: { select: { legalName: true } } },
    });
    return row ? toOrderView(row) : null;
  }

  /**
   * Sevkiyat kaydeder ve stoktan düşer.
   *
   * TASLAK AŞAMASI YOK — kayıt tek adımdır ve tamamı doğrulanır. Yarım
   * kalmış irsaliye, depoda "çıktı mı çıkmadı mı" belirsizliği demektir.
   */
  async postDelivery(input: {
    orderNo: string;
    locationId: string;
    shippedAt: Date;
    userId: string;
    carrierName?: string | null;
    plateNo?: string | null;
    lines: readonly DeliveryLineInput[];
  }): Promise<{ documentNo: string; orderStatus: OrderStatus; lines: number }> {
    if (input.lines.length === 0) {
      throw new DocumentFlowError("Sevkiyat en az bir kalem içermelidir.");
    }

    return this.#db.$transaction(async (tx) => {
      // KİLİT HER OKUMADAN ÖNCE. Sipariş kaydını okuyup sonra kilitlemek
      // yarışı kapatmaz; okunan değer zaten eskimiş olur.
      const lockedId = await lockOrder(tx, { orderNo: input.orderNo });
      if (!lockedId) throw new DocumentFlowError(`Sipariş bulunamadı: ${input.orderNo}`);

      const order = await tx.salesOrder.findUnique({
        where: { id: lockedId },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!order) throw new DocumentFlowError(`Sipariş bulunamadı: ${input.orderNo}`);

      const status = order.status as OrderStatus;
      if (isClosed(status)) {
        throw new DocumentFlowError(
          `${input.orderNo} siparişi ${status === "cancelled" ? "iptal edilmiş" : "tamamlanmış"}; ` +
            `yeni sevkiyat kaydedilemez.`,
        );
      }

      const byLineNo = new Map(order.lines.map((l) => [l.lineNo, l]));
      const tolerance = Number(order.overDeliveryTolerance);

      // AYNI KALEM İKİ KEZ YAZILAMAZ. İki satır aynı kalemi gösterirse
      // her biri ayrı ayrı kontrolü geçer ama toplamda aşırı sevkiyat olur.
      const seen = new Set<number>();
      for (const l of input.lines) {
        if (seen.has(l.orderLineNo)) {
          throw new DocumentFlowError(
            `Kalem ${l.orderLineNo} sevkiyatta iki kez geçiyor; miktarlar birleştirilmelidir.`,
          );
        }
        seen.add(l.orderLineNo);
      }

      for (const l of input.lines) {
        const orderLine = byLineNo.get(l.orderLineNo);
        if (!orderLine) {
          throw new DocumentFlowError(
            `${input.orderNo} siparişinde ${l.orderLineNo} numaralı kalem yok.`,
          );
        }
        assertDeliverable(
          {
            lineNo: orderLine.lineNo,
            itemCode: orderLine.itemId,
            uom: orderLine.uom,
            orderedQty: Number(orderLine.quantity),
            deliveredQty: Number(orderLine.deliveredQty),
            invoicedQty: Number(orderLine.invoicedQty),
            overDeliveryTolerance: tolerance,
          },
          l.quantity,
        );
      }

      // DÖNEM KONTROLÜ NUMARADAN ÖNCE. Sonra yapılsaydı, reddedilen bir
      // sevkiyat için numara yanar ve seride delik kalırdı.
      await assertPeriodOpen(tx, input.shippedAt, "Sevk irsaliyesi");

      // PARTİ KONTROLÜ NUMARADAN ÖNCE. Karantinadaki veya süresi dolmuş
      // bir parti sevk edilmeye çalışılırsa numara yanmamalıdır.
      for (const l of input.lines) {
        if (!l.batchId) continue;
        const orderLine = byLineNo.get(l.orderLineNo)!;
        await this.#batches.assertShippable(orderLine.itemId, l.batchId, input.shippedAt);
      }

      const year = input.shippedAt.getUTCFullYear();
      const documentNo = await nextDocumentNo(tx, "delivery", year);

      const delivery = await tx.delivery.create({
        data: {
          documentNo,
          salesOrderId: order.id,
          partnerId: order.partnerId,
          locationId: input.locationId,
          shippedAt: input.shippedAt,
          status: "posted",
          carrierName: input.carrierName ?? null,
          plateNo: input.plateNo ?? null,
          postedAt: new Date(),
          postedBy: input.userId,
        },
      });

      let lineNo = 0;
      const costedLines: { itemId: string; value: number | null }[] = [];
      for (const l of input.lines) {
        lineNo += 1;
        const orderLine = byLineNo.get(l.orderLineNo)!;

        // ÇIKIŞ DEĞERİ HAREKETLE BİRLİKTE YAZILIR. Sonradan hesaplansaydı,
        // bugünkü ortalamayla geçmiş bir sevkiyat değerlenir ve geçmiş
        // kârlılık raporları her gün değişirdi.
        const cost = await this.#valuation.valueIssue(tx, orderLine.itemId, l.quantity);
        costedLines.push({ itemId: orderLine.itemId, value: cost.value });

        // Stok hareketi ÖNCE yazılır ki irsaliye satırı ona işaret edebilsin;
        // iptalde ters kayıt bu bağdan bulunur.
        const movement = await tx.stockMovement.create({
          data: {
            at: input.shippedAt,
            itemId: orderLine.itemId,
            locationId: input.locationId,
            batchId: l.batchId ?? null,
            quantity: new Prisma.Decimal(l.quantity),
            direction: -1,
            movementType: "sevkiyat",
            referenceKind: "delivery",
            referenceId: delivery.id,
            userId: input.userId,
            unitCost: cost.unitCost === null ? null : new Prisma.Decimal(cost.unitCost),
            value: cost.value === null ? null : new Prisma.Decimal(cost.value),
          },
        });

        await tx.deliveryLine.create({
          data: {
            deliveryId: delivery.id,
            lineNo,
            orderLineNo: l.orderLineNo,
            itemId: orderLine.itemId,
            quantity: new Prisma.Decimal(l.quantity),
            uom: orderLine.uom,
            batchId: l.batchId ?? null,
            movementId: movement.id,
          },
        });

        // ARTIŞ VERİTABANINDA YAPILIR — okunan değere geri yazılmaz.
        await tx.salesOrderLine.update({
          where: { id: orderLine.id },
          data: { deliveredQty: { increment: new Prisma.Decimal(l.quantity) } },
        });
      }

      // SATILAN MALIN MALİYETİ SEVKİYATLA AYNI DÖNEME YAZILIR.
      // Faturada yazılsaydı, mal bu ay çıkıp fatura gelecek ay kesildiğinde
      // maliyet yanlış döneme düşer ve iki dönemin kârı da bozulurdu
      // (dönemsellik ilkesi).
      const costLines = [];
      for (const l of costedLines) {
        const item = await tx.item.findUnique({
          where: { code: l.itemId },
          select: { type: true },
        });
        costLines.push(
          ...cogsLines({
            documentNo,
            itemType: item?.type ?? "mamul",
            value: l.value,
          }),
        );
      }
      if (costLines.length > 0) {
        await JournalRepository.postIn(tx, {
          entryDate: input.shippedAt,
          description: `${documentNo} satılan malın maliyeti`,
          sourceKind: "delivery",
          sourceId: delivery.id,
          lines: costLines,
          userId: input.userId,
        });
      }

      const orderStatus = await refreshOrderStatus(tx, order.id);
      return { documentNo, orderStatus, lines: lineNo };
    });
  }

  /**
   * Sevkiyatı iptal eder: stok hareketini TERS KAYITLA geri alır.
   *
   * Hareket SİLİNMEZ, tersi yazılır. Silmek, "o gün depoda ne oldu"
   * sorusunun cevabını yok eder; ters kayıt hem bakiyeyi düzeltir hem
   * olayın olduğunu ve geri alındığını saklar.
   */
  async cancelDelivery(documentNo: string, userId: string, reason: string): Promise<OrderStatus> {
    return this.#db.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({
        where: { documentNo },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
      if (!delivery) throw new DocumentFlowError(`İrsaliye bulunamadı: ${documentNo}`);
      if (delivery.status !== "posted") {
        throw new DocumentFlowError(`${documentNo} zaten ${delivery.status} durumunda.`);
      }

      await lockOrder(tx, { id: delivery.salesOrderId });

      // İPTAL DE BİR HAREKETTİR. Kapalı döneme ters kayıt yazmak, kapalı
      // döneme kayıt yazmaktır; iptal bugünün tarihine yazılır ama iptal
      // edilen sevkiyatın dönemi kapalıysa bakiye geçmişe dokunur.
      await assertPeriodOpen(tx, delivery.shippedAt, "Sevkiyat iptali");

      const orderLines = await tx.salesOrderLine.findMany({
        where: { salesOrderId: delivery.salesOrderId },
      });
      const byLineNo = new Map(orderLines.map((l) => [l.lineNo, l]));

      // FATURALANMIŞ MİKTAR SEVKİYATIN ALTINA DÜŞEMEZ. Düşerse fatura
      // dayanaksız kalır; kural kalem kalem kontrol edilir.
      for (const dl of delivery.lines) {
        const ol = byLineNo.get(dl.orderLineNo);
        if (!ol) continue;
        const remainingAfter = Number(ol.deliveredQty) - Number(dl.quantity);
        if (Number(ol.invoicedQty) > remainingAfter + 1e-9) {
          assertDeliveryCancellable(Number(ol.invoicedQty));
        }
      }

      for (const dl of delivery.lines) {
        // TERS KAYIT ÖZGÜN MALİYETİ TAŞIR, güncel ortalamayı değil. Güncel
        // ortalamayla geri alınsaydı, aradaki her alım iptali kâra veya
        // zarara çevirirdi — oysa iptal bir değer olayı değildir.
        const origin = dl.movementId
          ? await tx.stockMovement.findUnique({
              where: { id: dl.movementId },
              select: { unitCost: true, value: true },
            })
          : null;

        await tx.stockMovement.create({
          data: {
            at: new Date(),
            itemId: dl.itemId,
            locationId: delivery.locationId,
            batchId: dl.batchId,
            quantity: dl.quantity,
            direction: 1,
            movementType: "sevkiyat_iptal",
            referenceKind: "delivery",
            referenceId: delivery.id,
            userId,
            reason,
            reversalOf: dl.movementId,
            unitCost: origin?.unitCost ?? null,
            value: origin?.value ?? null,
          },
        });

        await this.#valuation.reverseIssue(tx, dl.itemId, Number(dl.quantity));

        const ol = byLineNo.get(dl.orderLineNo);
        if (ol) {
          await tx.salesOrderLine.update({
            where: { id: ol.id },
            data: { deliveredQty: { decrement: dl.quantity } },
          });
        }
      }

      await tx.delivery.update({
        where: { id: delivery.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });

      return refreshOrderStatus(tx, delivery.salesOrderId);
    });
  }

  /**
   * Sevkiyatlardan fatura keser.
   *
   * Fatura SEVKİYATTAN doğar, siparişten değil. Kaynak sevkiyat satırları
   * verilir; miktar ve malzeme oradan, fiyat sipariş kaleminden gelir.
   */
  async issueInvoice(input: {
    sources: readonly InvoiceLineSource[];
    issuedAt: Date;
    dueDate?: Date | null;
    userId: string;
    exchangeRate?: number;
  }): Promise<{ documentNo: string; totalAmount: number; orderStatus: OrderStatus }> {
    if (input.sources.length === 0) {
      throw new DocumentFlowError("Fatura en az bir sevkiyat kalemine dayanmalıdır.");
    }

    return this.#db.$transaction(async (tx) => {
      const deliveryIds = [...new Set(input.sources.map((s) => s.deliveryId))];
      const deliveries = await tx.delivery.findMany({
        where: { id: { in: deliveryIds } },
        include: { lines: true, salesOrder: { include: { lines: true } } },
      });

      if (deliveries.length !== deliveryIds.length) {
        throw new DocumentFlowError("Faturaya kaynak gösterilen irsaliyelerden biri bulunamadı.");
      }

      // TEK MÜŞTERİ, TEK SİPARİŞ. Farklı müşterilerin sevkiyatını tek
      // faturada birleştirmek, borcu yanlış cariye yazmaktır.
      const partnerIds = new Set(deliveries.map((d) => d.partnerId));
      if (partnerIds.size > 1) {
        throw new DocumentFlowError(
          "Farklı müşterilere ait sevkiyatlar tek faturada birleştirilemez.",
        );
      }
      const orderIds = new Set(deliveries.map((d) => d.salesOrderId));
      if (orderIds.size > 1) {
        throw new DocumentFlowError(
          "Farklı siparişlere ait sevkiyatlar tek faturada birleştirilemez; " +
            "fiyat koşulları sipariş bazındadır.",
        );
      }

      for (const d of deliveries) {
        if (d.status !== "posted") {
          throw new DocumentFlowError(
            `${d.documentNo} irsaliyesi ${d.status} durumunda; faturaya dayanak olamaz.`,
          );
        }
      }

      // Fatura da sipariş kalemlerinin `invoiced_qty` alanını artırır;
      // sevkiyatla aynı kilide girmesi gerekir.
      await lockOrder(tx, { id: deliveries[0]!.salesOrderId });
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id: deliveries[0]!.salesOrderId },
        include: { lines: true },
      });
      const currency = order.currency;
      if (currency !== "TRY" && (input.exchangeRate ?? 0) <= 0) {
        throw new DocumentFlowError(
          `${currency} faturada TL karşılığı için kur zorunludur; kur bilinmeden fatura kesilemez.`,
        );
      }

      const orderLineByNo = new Map(order.lines.map((l) => [l.lineNo, l]));
      const pending = new Map<number, number>(); // orderLineNo → bu faturada toplanan

      const drafts: {
        deliveryId: string;
        deliveryLineNo: number;
        orderLineNo: number;
        itemId: string;
        quantity: number;
        uom: string;
        unitPrice: number;
        discountPercent: number;
        vatRate: number;
        amounts: LineAmounts;
      }[] = [];

      for (const src of input.sources) {
        const delivery = deliveries.find((d) => d.id === src.deliveryId)!;
        const dl = delivery.lines.find((l) => l.lineNo === src.deliveryLineNo);
        if (!dl) {
          throw new DocumentFlowError(
            `${delivery.documentNo} irsaliyesinde ${src.deliveryLineNo} numaralı kalem yok.`,
          );
        }

        // AYNI İRSALİYE SATIRI İKİ KEZ FATURALANAMAZ.
        const already = await tx.salesInvoiceLine.findFirst({
          where: { deliveryId: dl.deliveryId, deliveryLineNo: dl.lineNo },
          select: { id: true, invoice: { select: { documentNo: true, status: true } } },
        });
        if (already && already.invoice.status !== "cancelled") {
          throw new DocumentFlowError(
            `${delivery.documentNo} / ${dl.lineNo}. kalem zaten ` +
              `${already.invoice.documentNo} faturasında; ikinci kez faturalanamaz.`,
          );
        }

        const ol = orderLineByNo.get(dl.orderLineNo);
        if (!ol) {
          throw new DocumentFlowError(
            `İrsaliye kalemi ${dl.lineNo}, siparişte bulunmayan ${dl.orderLineNo}. kaleme bağlı.`,
          );
        }

        const qty = Number(dl.quantity);
        const runningInvoiced = Number(ol.invoicedQty) + (pending.get(ol.lineNo) ?? 0);
        assertInvoiceable(
          {
            lineNo: ol.lineNo,
            itemCode: ol.itemId,
            uom: ol.uom,
            orderedQty: Number(ol.quantity),
            deliveredQty: Number(ol.deliveredQty),
            invoicedQty: runningInvoiced,
          },
          qty,
        );
        pending.set(ol.lineNo, (pending.get(ol.lineNo) ?? 0) + qty);

        const unitPrice = Number(ol.unitPrice);
        if (unitPrice <= 0) {
          throw new DocumentFlowError(
            `Kalem ${ol.lineNo} (${ol.itemId}) için sipariş fiyatı girilmemiş; ` +
              `fiyatsız fatura kesilemez.`,
          );
        }

        drafts.push({
          deliveryId: dl.deliveryId,
          deliveryLineNo: dl.lineNo,
          orderLineNo: ol.lineNo,
          itemId: ol.itemId,
          quantity: qty,
          uom: dl.uom,
          unitPrice,
          discountPercent: Number(ol.discountPercent),
          vatRate: ol.vatRate,
          amounts: priceLine({
            quantity: qty,
            unitPrice,
            discountPercent: Number(ol.discountPercent),
            vatRate: ol.vatRate,
          }),
        });
      }

      await assertPeriodOpen(tx, input.issuedAt, "Satış faturası");

      const totals = documentTotals(drafts);
      const year = input.issuedAt.getUTCFullYear();
      const documentNo = await nextDocumentNo(tx, "sales_invoice", year);

      const invoice = await tx.salesInvoice.create({
        data: {
          documentNo,
          partnerId: order.partnerId,
          salesOrderId: order.id,
          issuedAt: input.issuedAt,
          dueDate: input.dueDate ?? null,
          currency,
          exchangeRate: new Prisma.Decimal(input.exchangeRate ?? 1),
          netAmount: new Prisma.Decimal(fromKurus(totals.netKurus)),
          discountAmount: new Prisma.Decimal(fromKurus(totals.discountKurus)),
          vatAmount: new Prisma.Decimal(fromKurus(totals.vatKurus)),
          totalAmount: new Prisma.Decimal(fromKurus(totals.totalKurus)),
          status: "draft",
          issuedBy: input.userId,
        },
      });

      // FATURADA MALIN CİNSİ YAZAR, KODU DEĞİL. Vergi Usul Kanunu
      // faturanın "satılan malın cinsini" taşımasını ister; "FR-22"
      // yazan bir satır bunu karşılamaz ve müşteri ne aldığını
      // faturadan okuyamaz. Ürün kartı yoksa kod kalır — kod, hiç
      // yoktan iyidir ve uydurma bir ad yazmaktan çok daha iyidir.
      const itemNames = new Map<string, string>();
      const codes = [...new Set(drafts.map((d) => d.itemId))];
      if (codes.length > 0) {
        const cards = await tx.item.findMany({
          where: { code: { in: codes } },
          select: { code: true, name: true },
        });
        for (const c of cards) itemNames.set(c.code, c.name);
      }

      let lineNo = 0;
      for (const d of drafts) {
        lineNo += 1;
        await tx.salesInvoiceLine.create({
          data: {
            invoiceId: invoice.id,
            lineNo,
            deliveryId: d.deliveryId,
            deliveryLineNo: d.deliveryLineNo,
            orderLineNo: d.orderLineNo,
            itemId: d.itemId,
            description: itemNames.get(d.itemId) ?? d.itemId,
            quantity: new Prisma.Decimal(d.quantity),
            uom: d.uom,
            unitPrice: new Prisma.Decimal(d.unitPrice),
            discountPercent: new Prisma.Decimal(d.discountPercent),
            vatRate: d.vatRate,
            netAmount: new Prisma.Decimal(fromKurus(d.amounts.netKurus)),
            vatAmount: new Prisma.Decimal(fromKurus(d.amounts.vatKurus)),
            totalAmount: new Prisma.Decimal(fromKurus(d.amounts.totalKurus)),
          },
        });

        const ol = orderLineByNo.get(d.orderLineNo)!;
        await tx.salesOrderLine.update({
          where: { id: ol.id },
          data: { invoicedQty: { increment: new Prisma.Decimal(d.quantity) } },
        });
      }

      // Kalemler yazıldıktan SONRA kesilir; taslak aşamasında kalem
      // yazmak tetikleyicinin izin verdiği tek sıradır.
      await tx.salesInvoice.update({
        where: { id: invoice.id },
        data: { status: "issued" },
      });

      // FATURA MUHASEBELEŞİR: 120 Alıcılar / 600 Satışlar + 391 KDV.
      // Muhasebeleşmeseydi ciro mizanda görünmez, "kâr ettik mi" sorusu
      // cevapsız kalırdı.
      await JournalRepository.postIn(tx, {
        entryDate: input.issuedAt,
        description: `${documentNo} satış faturası`,
        sourceKind: "sales_invoice",
        sourceId: invoice.id,
        lines: salesInvoiceLines({
          documentNo,
          partnerId: order.partnerId,
          netAmount: fromKurus(totals.netKurus),
          vatAmount: fromKurus(totals.vatKurus),
          totalAmount: fromKurus(totals.totalKurus),
          export: currency !== "TRY",
        }),
        userId: input.userId,
      });

      const orderStatus = await refreshOrderStatus(tx, order.id);
      return { documentNo, totalAmount: fromKurus(totals.totalKurus), orderStatus };
    });
  }
}

/** Sipariş durumunu kalemlerden yeniden türetip yazar. */
async function refreshOrderStatus(tx: Tx, orderId: string): Promise<OrderStatus> {
  const order = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { lines: true },
  });

  const status = deriveOrderStatus(
    order.lines.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemId,
      uom: l.uom,
      orderedQty: Number(l.quantity),
      deliveredQty: Number(l.deliveredQty),
      invoicedQty: Number(l.invoicedQty),
    })),
    order.cancelledAt !== null,
  );

  if (status !== order.status) {
    await tx.salesOrder.update({ where: { id: orderId }, data: { status } });
  }
  return status;
}

function toOrderView(row: {
  id: string;
  orderNo: string;
  partnerId: string;
  committedDate: Date;
  currency: string;
  status: string;
  overDeliveryTolerance: unknown;
  partner: { legalName: string };
  lines: {
    lineNo: number;
    itemId: string;
    uom: string;
    quantity: unknown;
    unitPrice: unknown;
    discountPercent: unknown;
    vatRate: number;
    deliveredQty: unknown;
    invoicedQty: unknown;
    workOrderId: string | null;
  }[];
}): OrderView {
  const tolerance = Number(row.overDeliveryTolerance);
  const lines = row.lines.map((l) => ({
    lineNo: l.lineNo,
    itemCode: l.itemId,
    uom: l.uom,
    orderedQty: toQuantity(l.quantity as never) ?? 0,
    deliveredQty: toQuantity(l.deliveredQty as never) ?? 0,
    invoicedQty: toQuantity(l.invoicedQty as never) ?? 0,
    overDeliveryTolerance: tolerance,
    unitPrice: toMoney(l.unitPrice as never) ?? 0,
    discountPercent: Number(l.discountPercent),
    vatRate: l.vatRate,
    workOrderId: l.workOrderId,
  }));

  // Fiyatı girilmemiş kalem toplamı BOZMAZ: sıfır fiyatlı kalem
  // hesaplanamaz, atlanır ve tutarı eksik gösterir — uydurulmaz.
  const priced = lines
    .filter((l) => l.unitPrice > 0 && l.orderedQty > 0)
    .map((l) => ({
      vatRate: l.vatRate,
      amounts: priceLine({
        quantity: l.orderedQty,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent,
        vatRate: l.vatRate,
      }),
    }));
  const totals = documentTotals(priced);

  return {
    id: row.id,
    orderNo: row.orderNo,
    partnerId: row.partnerId,
    partnerName: row.partner.legalName,
    committedDate: row.committedDate.toISOString().slice(0, 10),
    currency: row.currency,
    status: row.status as OrderStatus,
    overDeliveryTolerance: tolerance,
    lines,
    netAmount: fromKurus(totals.netKurus),
    vatAmount: fromKurus(totals.vatKurus),
    totalAmount: fromKurus(totals.totalKurus),
  };
}
