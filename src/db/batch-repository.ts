/**
 * Parti izleme deposu.
 *
 * ŞECERE ÖZYİNELEMELİ SQL İLE OKUNUR. Uygulama tarafında adım adım
 * gezilseydi, beş kademeli bir ürün ağacında yüzlerce gidiş-dönüş olurdu
 * ve geri çağırma sorgusu dakikalar sürerdi — tam da hızın en çok
 * gerektiği anda.
 *
 * DERİNLİK SINIRI VARDIR VE AŞILDIĞINDA SÖYLENİR. Sessizce kesilen bir
 * izleme, "başka yere gitmemiş" cevabı verir ve bu cevap yanlıştır.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import {
  assertShippable,
  expiringBatches,
  expiryFrom,
  BatchError,
  type BackwardTrace,
  type BatchStatus,
  type ExpiryWarning,
  type ForwardTrace,
  type TraceNode,
} from "../modules/inventory/batch.js";

/** Şecere kaç kademe geriye/ileriye gezilir. */
export const MAX_TRACE_DEPTH = 20;

export interface BatchRecord {
  readonly id: string;
  readonly itemCode: string;
  readonly batchNo: string;
  readonly status: BatchStatus;
  readonly origin: string;
  readonly producedAt: string;
  readonly expiryDate: string | null;
  readonly supplierBatchNo: string | null;
}

export class BatchRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async byNo(itemCode: string, batchNo: string): Promise<BatchRecord | null> {
    const row = await this.#db.batch.findUnique({
      where: { itemId_batchNo: { itemId: itemCode, batchNo } },
    });
    return row ? toRecord(row) : null;
  }

  /**
   * Parti açar. Son kullanma tarihi RAF ÖMRÜNDEN hesaplanır, elle girilmez.
   *
   * Elle girilseydi, aynı malzemenin iki partisi farklı raf ömrü taşır ve
   * hangisinin doğru olduğu bilinmezdi.
   */
  async create(input: {
    itemCode: string;
    batchNo: string;
    origin: "satin_alma" | "uretim";
    producedAt: Date;
    supplierBatchNo?: string | null;
    supplierId?: string | null;
    workOrderId?: string | null;
    status?: BatchStatus;
  }): Promise<BatchRecord> {
    const item = await this.#db.item.findUnique({
      where: { code: input.itemCode },
      select: { batchManaged: true, shelfLifeDays: true },
    });
    if (!item) {
      throw new BatchError(`Malzeme bulunamadı: ${input.itemCode}`);
    }
    // PARTİ TAKİPSİZ MALZEMEYE PARTİ AÇILMAZ. Açılsaydı, bazı hareketleri
    // partili bazıları partisiz olurdu ve izleme yarım kalırdı — yarım
    // izleme, izleme olmamasından daha tehlikelidir çünkü tam sanılır.
    if (!item.batchManaged) {
      throw new BatchError(
        `"${input.itemCode}" parti takipli değil; parti açılamaz. ` +
          `Gerekiyorsa önce malzeme kartında parti takibi açılmalıdır.`,
      );
    }

    try {
      const row = await this.#db.batch.create({
        data: {
          itemId: input.itemCode,
          batchNo: input.batchNo,
          origin: input.origin,
          producedAt: input.producedAt,
          expiryDate: expiryFrom(input.producedAt, item.shelfLifeDays),
          supplierBatchNo: input.supplierBatchNo ?? null,
          supplierId: input.supplierId ?? null,
          workOrderId: input.workOrderId ?? null,
          status: input.status ?? "available",
        },
      });
      return toRecord(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new BatchError(`"${input.itemCode}" için "${input.batchNo}" partisi zaten var.`);
      }
      throw e;
    }
  }

  /** Sevkiyat öncesi kontrol: karantina, bloke ve son kullanma. */
  async assertShippable(itemCode: string, batchNo: string, on: Date): Promise<void> {
    const row = await this.#db.batch.findUnique({
      where: { itemId_batchNo: { itemId: itemCode, batchNo } },
    });
    if (!row) {
      throw new BatchError(
        `"${itemCode}" için "${batchNo}" partisi sistemde yok. Kayıtsız parti sevk edilemez; ` +
          `edilirse izlenebilirlik zinciri o noktada kopar.`,
      );
    }
    assertShippable(
      { batchNo: row.batchNo, status: row.status as BatchStatus, expiryDate: row.expiryDate },
      on,
    );
  }

  /** Şecere bağı yazar — üretim anında. */
  async linkGenealogy(input: {
    outputItemCode: string;
    outputBatchNo: string;
    inputs: readonly { itemCode: string; batchNo: string; quantity: number }[];
    workOrderId?: string | null;
    at: Date;
  }): Promise<number> {
    return this.#db.$transaction(async (tx) => {
      const output = await tx.batch.findUnique({
        where: { itemId_batchNo: { itemId: input.outputItemCode, batchNo: input.outputBatchNo } },
      });
      if (!output) {
        throw new BatchError(
          `Çıktı partisi bulunamadı: ${input.outputItemCode} / ${input.outputBatchNo}`,
        );
      }

      let written = 0;
      for (const i of input.inputs) {
        const inp = await tx.batch.findUnique({
          where: { itemId_batchNo: { itemId: i.itemCode, batchNo: i.batchNo } },
        });
        if (!inp) {
          throw new BatchError(`Girdi partisi bulunamadı: ${i.itemCode} / ${i.batchNo}`);
        }
        // `workOrderId` null olabildiği için bileşik anahtarla upsert
        // yapılamaz: SQL'de NULL hiçbir şeye eşit değildir ve Prisma da
        // null'lu bileşik anahtarı kabul etmez. Önce aranır, sonra yazılır.
        const existing = await tx.batchGenealogy.findFirst({
          where: {
            inputBatchId: inp.id,
            outputBatchId: output.id,
            workOrderId: input.workOrderId ?? null,
          },
          select: { id: true },
        });

        if (existing) {
          await tx.batchGenealogy.update({
            where: { id: existing.id },
            data: { quantity: new Prisma.Decimal(i.quantity) },
          });
        } else {
          await tx.batchGenealogy.create({
            data: {
              inputBatchId: inp.id,
              outputBatchId: output.id,
              quantity: new Prisma.Decimal(i.quantity),
              workOrderId: input.workOrderId ?? null,
              at: input.at,
            },
          });
        }
        written += 1;
      }
      return written;
    });
  }

  /**
   * İLERİ İZLEME — "bu parti nereye gitti?"
   *
   * Hem alt partilere hem müşteriye kadar gider. Yalnızca müşteriye
   * bakılsaydı, hammadde partisi için cevap boş çıkardı: hammadde
   * müşteriye gitmez, mamulün içinde gider.
   */
  async traceForward(itemCode: string, batchNo: string): Promise<ForwardTrace> {
    const root = await this.byNo(itemCode, batchNo);
    if (!root) throw new BatchError(`Parti bulunamadı: ${itemCode} / ${batchNo}`);

    const nodes = await this.#db.$queryRaw<
      { batch_no: string; item_id: string; depth: number; quantity: string | null }[]
    >`
      WITH RECURSIVE tree AS (
        SELECT b."id", b."batch_no", b."item_id", 0 AS depth, NULL::DECIMAL AS quantity
          FROM "batches" b WHERE b."id" = ${root.id}::uuid
        UNION ALL
        SELECT c."id", c."batch_no", c."item_id", t.depth + 1, g."quantity"
          FROM tree t
          JOIN "batch_genealogy" g ON g."input_batch_id" = t."id"
          JOIN "batches" c ON c."id" = g."output_batch_id"
         WHERE t.depth < ${MAX_TRACE_DEPTH}
      )
      SELECT DISTINCT "batch_no", "item_id", depth, quantity FROM tree ORDER BY depth, "batch_no"`;

    const batchNos = nodes.map((n) => n.batch_no);

    // Sevkiyat, kök partiden VE türeyen partilerden yapılmış olabilir.
    const shipments = await this.#db.deliveryLine.findMany({
      where: { batchId: { in: batchNos }, delivery: { status: "posted" } },
      include: {
        delivery: {
          select: { documentNo: true, shippedAt: true, partnerId: true },
        },
      },
      orderBy: { delivery: { shippedAt: "asc" } },
    });

    const partnerIds = [...new Set(shipments.map((s) => s.delivery.partnerId))];
    const partners = await this.#db.partner.findMany({
      where: { id: { in: partnerIds } },
      select: { id: true, legalName: true },
    });
    const nameOf = new Map(partners.map((p) => [p.id, p.legalName]));

    const caveats: string[] = [];
    const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
    if (maxDepth >= MAX_TRACE_DEPTH) {
      caveats.push(
        `İzleme ${MAX_TRACE_DEPTH} kademede kesildi; zincir daha derin olabilir ve ` +
          `bu liste EKSİK olabilir.`,
      );
    }
    if (nodes.length === 1 && shipments.length === 0) {
      caveats.push(
        "Bu partiden türeyen alt parti ve sevkiyat kaydı yok. Parti hâlâ depoda " +
          "olabilir; ya da üretim tüketimi parti bağı yazılmadan kaydedilmiştir.",
      );
    }

    return {
      root: batchNo,
      derivedBatches: nodes
        .filter((n) => n.depth > 0)
        .map(
          (n): TraceNode => ({
            batchNo: n.batch_no,
            itemCode: n.item_id,
            depth: n.depth,
            quantity: n.quantity === null ? null : Number(n.quantity),
          }),
        ),
      shipments: shipments.map((s) => ({
        deliveryNo: s.delivery.documentNo,
        customer: nameOf.get(s.delivery.partnerId) ?? s.delivery.partnerId,
        shippedAt: s.delivery.shippedAt.toISOString().slice(0, 10),
        quantity: Number(s.quantity),
        viaBatch: s.batchId ?? batchNo,
      })),
      caveats,
    };
  }

  /** GERİ İZLEME — "bu parti neyden yapıldı?" Hatanın kaynağına doğru. */
  async traceBackward(itemCode: string, batchNo: string): Promise<BackwardTrace> {
    const root = await this.byNo(itemCode, batchNo);
    if (!root) throw new BatchError(`Parti bulunamadı: ${itemCode} / ${batchNo}`);

    const nodes = await this.#db.$queryRaw<
      { id: string; batch_no: string; item_id: string; depth: number; quantity: string | null }[]
    >`
      WITH RECURSIVE tree AS (
        SELECT b."id", b."batch_no", b."item_id", 0 AS depth, NULL::DECIMAL AS quantity
          FROM "batches" b WHERE b."id" = ${root.id}::uuid
        UNION ALL
        SELECT p."id", p."batch_no", p."item_id", t.depth + 1, g."quantity"
          FROM tree t
          JOIN "batch_genealogy" g ON g."output_batch_id" = t."id"
          JOIN "batches" p ON p."id" = g."input_batch_id"
         WHERE t.depth < ${MAX_TRACE_DEPTH}
      )
      SELECT DISTINCT "id", "batch_no", "item_id", depth, quantity FROM tree ORDER BY depth, "batch_no"`;

    // Zincirin ucundaki satın alınmış partiler: tedarikçi tarafı.
    const purchased = await this.#db.batch.findMany({
      where: { id: { in: nodes.map((n) => n.id) }, origin: "satin_alma" },
    });
    const supplierIds = [...new Set(purchased.map((p) => p.supplierId).filter(Boolean))] as string[];
    const suppliers = await this.#db.partner.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, legalName: true },
    });
    const nameOf = new Map(suppliers.map((p) => [p.id, p.legalName]));

    const caveats: string[] = [];
    const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
    if (maxDepth >= MAX_TRACE_DEPTH) {
      caveats.push(`İzleme ${MAX_TRACE_DEPTH} kademede kesildi; liste EKSİK olabilir.`);
    }
    if (nodes.length === 1 && root.origin === "uretim") {
      caveats.push(
        "Üretilmiş bir parti ama hiçbir girdi partisine bağlı değil. Üretim tüketimi " +
          "parti bağı yazılmadan kaydedilmiş; kaynağı BU KAYITLARDAN BULUNAMAZ.",
      );
    }

    return {
      root: batchNo,
      sourceBatches: nodes
        .filter((n) => n.depth > 0)
        .map(
          (n): TraceNode => ({
            batchNo: n.batch_no,
            itemCode: n.item_id,
            depth: n.depth,
            quantity: n.quantity === null ? null : Number(n.quantity),
          }),
        ),
      receipts: purchased.map((p) => ({
        batchNo: p.batchNo,
        itemCode: p.itemId,
        supplier: p.supplierId ? (nameOf.get(p.supplierId) ?? p.supplierId) : null,
        supplierBatchNo: p.supplierBatchNo,
        receivedAt: p.producedAt.toISOString().slice(0, 10),
      })),
      caveats,
    };
  }

  /**
   * Partinin durumunu değiştirir — karantina, bloke, serbest.
   *
   * BLOKE ETMEK GERİ ÇAĞIRMANIN İLK ADIMIDIR: şüpheli parti önce durdurulur,
   * sonra nereye gittiği araştırılır. Sıra tersine dönerse, araştırma
   * sürerken mal sevk edilmeye devam eder.
   */
  async setStatus(
    itemCode: string,
    batchNo: string,
    status: BatchStatus,
  ): Promise<BatchRecord> {
    const row = await this.#db.batch.update({
      where: { itemId_batchNo: { itemId: itemCode, batchNo } },
      data: { status },
    });
    return toRecord(row);
  }

  /** Süresi dolmuş/dolacak partiler. */
  async expiring(on: Date, withinDays: number): Promise<readonly ExpiryWarning[]> {
    const limit = new Date(on.getTime() + withinDays * 86_400_000);
    const rows = await this.#db.batch.findMany({
      where: {
        expiryDate: { not: null, lte: limit },
        status: { in: ["available", "quarantine"] },
      },
      orderBy: { expiryDate: "asc" },
      take: 200,
    });

    // Kalan miktar stok hareketlerinden gelir; parti tükenmişse uyarmak
    // gürültüdür ve gerçek uyarıları görünmez kılar.
    // Bakiye yönlü toplanır: `direction` çarpanı olmadan giriş ve çıkış
    // aynı işaretle toplanır ve tükenmiş parti dolu görünür.
    const signed = new Map<string, number>();
    for (const r of rows) signed.set(r.batchNo, 0);
    const movements = await this.#db.stockMovement.findMany({
      where: { batchId: { in: rows.map((r) => r.batchNo) } },
      select: { batchId: true, quantity: true, direction: true },
    });
    for (const m of movements) {
      if (!m.batchId) continue;
      signed.set(m.batchId, (signed.get(m.batchId) ?? 0) + m.direction * Number(m.quantity));
    }

    return expiringBatches(
      rows.map((r) => ({
        batchNo: r.batchNo,
        itemCode: r.itemId,
        expiryDate: r.expiryDate,
        quantity: signed.get(r.batchNo) ?? 0,
      })),
      on,
      withinDays,
    );
  }
}

function toRecord(row: {
  id: string;
  itemId: string;
  batchNo: string;
  status: string;
  origin: string;
  producedAt: Date;
  expiryDate: Date | null;
  supplierBatchNo: string | null;
}): BatchRecord {
  return {
    id: row.id,
    itemCode: row.itemId,
    batchNo: row.batchNo,
    status: row.status as BatchStatus,
    origin: row.origin,
    producedAt: row.producedAt.toISOString(),
    expiryDate: row.expiryDate?.toISOString().slice(0, 10) ?? null,
    supplierBatchNo: row.supplierBatchNo,
  };
}
