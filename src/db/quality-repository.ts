/**
 * Kalite yönetimi veri erişimi.
 *
 * MUAYENE VE UYGUNSUZLUK TEK İŞLEMDE YAZILIR.
 *
 * Tolerans dışı bir ölçüm kaydedilip uygunsuzluk açılmazsa, sapma
 * kayda geçer ama kimse bakmaz — ve "kaydedildi" olması onu
 * çözülmüş gibi gösterir. İkisi aynı transaction'da: ya ikisi de
 * olur ya hiçbiri.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import type { Characteristic } from "../modules/quality/inspection.js";

export interface PlanWithCharacteristics {
  readonly id: string;
  readonly code: string;
  readonly itemId: string;
  readonly name: string;
  readonly stage: string;
  readonly characteristics: readonly Characteristic[];
}

function karakter(r: {
  id: string;
  seq: number;
  name: string;
  kind: string;
  uom: string | null;
  lowerLimit: unknown;
  upperLimit: unknown;
  isCritical: boolean;
}): Characteristic {
  return {
    id: r.id,
    seq: r.seq,
    name: r.name,
    kind: r.kind,
    uom: r.uom,
    lowerLimit: r.lowerLimit === null ? null : Number(r.lowerLimit),
    upperLimit: r.upperLimit === null ? null : Number(r.upperLimit),
    isCritical: r.isCritical,
  };
}

export class QualityRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async createPlan(input: {
    code: string;
    itemId: string;
    name: string;
    stage: string;
    characteristics: readonly {
      seq: number;
      name: string;
      kind: string;
      uom: string | null;
      lowerLimit: number | null;
      upperLimit: number | null;
      method: string | null;
      isCritical: boolean;
    }[];
    userId: string;
  }): Promise<{ code: string; characteristicCount: number }> {
    if (await this.#db.inspectionPlan.findUnique({ where: { code: input.code } })) {
      throw new BusinessRuleError(`${input.code} kodlu kontrol planı zaten var.`, "plan_exists");
    }
    if (!(await this.#db.item.findUnique({ where: { code: input.itemId } }))) {
      throw new BusinessRuleError(
        `${input.itemId} kodlu malzeme yok. Var olmayan bir ürün için kontrol ` +
          `planı, hiç çağrılmayacak bir plandır.`,
        "item_not_found",
      );
    }

    const row = await this.#db.inspectionPlan.create({
      data: {
        code: input.code,
        itemId: input.itemId,
        name: input.name,
        stage: input.stage,
        createdBy: input.userId,
        characteristics: { create: input.characteristics.map((c) => ({ ...c })) },
      },
    });
    return { code: row.code, characteristicCount: input.characteristics.length };
  }

  async plan(code: string): Promise<PlanWithCharacteristics | null> {
    const p = await this.#db.inspectionPlan.findUnique({
      where: { code },
      include: { characteristics: { orderBy: { seq: "asc" } } },
    });
    if (!p) return null;
    return {
      id: p.id,
      code: p.code,
      itemId: p.itemId,
      name: p.name,
      stage: p.stage,
      characteristics: p.characteristics.map(karakter),
    };
  }

  async plansForItem(itemId: string): Promise<readonly PlanWithCharacteristics[]> {
    const rows = await this.#db.inspectionPlan.findMany({
      where: { itemId, isActive: true },
      include: { characteristics: { orderBy: { seq: "asc" } } },
      orderBy: { stage: "asc" },
    });
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      itemId: p.itemId,
      name: p.name,
      stage: p.stage,
      characteristics: p.characteristics.map(karakter),
    }));
  }

  async nextLotNo(year: number): Promise<string> {
    const n = await this.#db.inspectionLot.count({
      where: { documentNo: { startsWith: `MUY-${year}-` } },
    });
    return `MUY-${year}-${String(n + 1).padStart(4, "0")}`;
  }

  async nextNcrNo(year: number): Promise<string> {
    const n = await this.#db.nonconformance.count({
      where: { documentNo: { startsWith: `UYG-${year}-` } },
    });
    return `UYG-${year}-${String(n + 1).padStart(4, "0")}`;
  }

  /**
   * Muayeneyi ve — gerekiyorsa — uygunsuzluğu birlikte yazar.
   *
   * UYGUNSUZLUK OTOMATİK AÇILIR. Elle açılmaya bırakılsaydı, sapan
   * ölçümlerin bir kısmı için hiç açılmazdı; en yoğun günlerde en çok
   * unutulan şey budur.
   */
  async recordInspection(input: {
    documentNo: string;
    planId: string;
    itemId: string;
    batchNo: string | null;
    serialNo: string | null;
    referenceDoc: string | null;
    quantity: number;
    inspectedAt: Date;
    userId: string;
    result: string;
    note: string | null;
    results: readonly {
      characteristicId: string;
      measured: number | null;
      conforms: boolean;
      note: string | null;
    }[];
    ncr: { documentNo: string; description: string; severity: string } | null;
  }): Promise<{ documentNo: string; ncrNo: string | null }> {
    return this.#db.$transaction(async (tx) => {
      const lot = await tx.inspectionLot.create({
        data: {
          documentNo: input.documentNo,
          planId: input.planId,
          itemId: input.itemId,
          batchNo: input.batchNo,
          serialNo: input.serialNo,
          referenceDoc: input.referenceDoc,
          quantity: input.quantity,
          inspectedAt: input.inspectedAt,
          inspectedBy: input.userId,
          result: input.result,
          note: input.note,
          results: { create: input.results.map((r) => ({ ...r })) },
        },
      });

      if (input.ncr === null) return { documentNo: lot.documentNo, ncrNo: null };

      const ncr = await tx.nonconformance.create({
        data: {
          documentNo: input.ncr.documentNo,
          source: "inspection",
          lotId: lot.id,
          itemId: input.itemId,
          batchNo: input.batchNo,
          description: input.ncr.description,
          quantity: input.quantity,
          severity: input.ncr.severity,
          /*
           * AÇILIŞ TARİHİ MUAYENE TARİHİDİR, "ŞİMDİ" DEĞİL.
           *
           * `now()` bırakılmıştı ve geriye dönük girilen bir muayene
           * (dün ölçüldü, bugün girildi) uygunsuzluğu BUGÜN açıyordu.
           * Sonuç: uygunsuzluk, doğduğu sapmadan sonra açılmış
           * görünüyor ve dünkü tarihle kapatılırsa yaşı NEGATİF
           * çıkıyordu. Ölçüldü: ageDays -2.
           */
          openedAt: input.inspectedAt,
          openedBy: input.userId,
        },
      });
      return { documentNo: lot.documentNo, ncrNo: ncr.documentNo };
    });
  }

  async openNonconformances(limit = 100) {
    const rows = await this.#db.nonconformance.findMany({
      where: { status: { not: "closed" } },
      orderBy: [{ severity: "desc" }, { openedAt: "asc" }],
      take: limit,
    });
    return rows.map((r) => ({
      documentNo: r.documentNo,
      source: r.source,
      itemId: r.itemId,
      batchNo: r.batchNo,
      description: r.description,
      severity: r.severity,
      status: r.status,
      quantity: r.quantity === null ? null : Number(r.quantity),
      costAmount: r.costAmount === null ? null : Number(r.costAmount),
      openedAt: r.openedAt.toISOString().slice(0, 10),
      ageDays: Math.floor((Date.now() - r.openedAt.getTime()) / 86_400_000),
    }));
  }

  /**
   * Uygunsuzluğu kapatır.
   *
   * KÖK NEDEN VE DÜZELTİCİ FAALİYET ZORUNLU — veritabanı kısıtı da
   * bunu tutuyor. Sebebini yazmadan kapatmak, aynı hatanın üç ay
   * sonra tekrar etmesini garanti eder.
   */
  async closeNonconformance(input: {
    documentNo: string;
    rootCause: string;
    correctiveAction: string;
    costAmount: number | null;
    userId: string;
    at: Date;
  }): Promise<{ documentNo: string; ageDays: number }> {
    const n = await this.#db.nonconformance.findUnique({
      where: { documentNo: input.documentNo },
    });
    if (!n) {
      throw new BusinessRuleError(
        `${input.documentNo} numaralı uygunsuzluk bulunamadı.`,
        "ncr_not_found",
      );
    }
    /*
     * KAPANIŞ AÇILIŞTAN ÖNCE OLAMAZ.
     *
     * Olabilseydi "kaç gün açık kaldı" ölçüsü negatife düşer ve
     * kalite performansı raporu sessizce yanlış olurdu.
     */
    if (input.at < n.openedAt) {
      throw new BusinessRuleError(
        `Kapanış tarihi (${input.at.toISOString().slice(0, 10)}) açılış tarihinden ` +
          `(${n.openedAt.toISOString().slice(0, 10)}) önce olamaz.`,
        "ncr_closed_before_opened",
      );
    }
    if (n.status === "closed") {
      throw new BusinessRuleError(
        `${input.documentNo} zaten kapatılmış (${n.closedAt?.toISOString().slice(0, 10)}). ` +
          `Yeniden kapatmak ilk kaydın izini siler.`,
        "ncr_already_closed",
      );
    }
    await this.#db.nonconformance.update({
      where: { id: n.id },
      data: {
        status: "closed",
        rootCause: input.rootCause,
        correctiveAction: input.correctiveAction,
        costAmount: input.costAmount,
        closedBy: input.userId,
        closedAt: input.at,
      },
    });
    return {
      documentNo: n.documentNo,
      ageDays: Math.floor((input.at.getTime() - n.openedAt.getTime()) / 86_400_000),
    };
  }

  /** Bir parti/serinin muayene geçmişi — sertifika bunun üzerine kurulur. */
  async lotsFor(input: { batchNo?: string; serialNo?: string; itemId?: string }) {
    const rows = await this.#db.inspectionLot.findMany({
      where: {
        ...(input.batchNo ? { batchNo: input.batchNo } : {}),
        ...(input.serialNo ? { serialNo: input.serialNo } : {}),
        ...(input.itemId ? { itemId: input.itemId } : {}),
      },
      include: {
        plan: { select: { code: true, name: true, stage: true } },
        results: { include: { characteristic: true } },
      },
      orderBy: { inspectedAt: "desc" },
      take: 50,
    });

    return rows.map((l) => ({
      documentNo: l.documentNo,
      planCode: l.plan.code,
      planName: l.plan.name,
      stage: l.plan.stage,
      itemId: l.itemId,
      batchNo: l.batchNo,
      serialNo: l.serialNo,
      quantity: Number(l.quantity),
      inspectedAt: l.inspectedAt.toISOString().slice(0, 10),
      result: l.result,
      measurements: l.results
        .slice()
        .sort((a, b) => a.characteristic.seq - b.characteristic.seq)
        .map((r) => ({
          name: r.characteristic.name,
          uom: r.characteristic.uom,
          measured: r.measured === null ? null : Number(r.measured),
          lowerLimit: r.characteristic.lowerLimit === null ? null : Number(r.characteristic.lowerLimit),
          upperLimit: r.characteristic.upperLimit === null ? null : Number(r.characteristic.upperLimit),
          conforms: r.conforms,
        })),
    }));
  }
}
