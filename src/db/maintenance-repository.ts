/**
 * Bakım deposu.
 *
 * ARIZA BİLDİRİMİ İŞ EMRİ DEĞİLDİR. Bildirim bir gözlemdir ("tezgâh
 * durdu"), iş emri bir karardır ("şu kişi şu parçayla bakacak"). İkisini
 * tek kayıtta birleştirmek, bildirimi geciktirir: operatör form doldurmak
 * zorunda kalırsa arızayı ustabaşına sözlü söyler ve kayıt hiç oluşmaz.
 */

import { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";
import { nextDocumentNo } from "./sales-repository.js";
import {
  downtime,
  isDue,
  maintenanceKpi,
  MaintenanceError,
  type BreakdownSeverity,
  type MaintenanceKind,
} from "../modules/maintenance/maintenance.js";

export class MaintenanceRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async savePlan(input: {
    machineCode: string;
    description: string;
    intervalDays?: number | null;
    intervalHours?: number | null;
    lastDoneAt?: Date | null;
    lastDoneHours?: number | null;
  }): Promise<{ id: string }> {
    if (input.intervalDays == null && input.intervalHours == null) {
      throw new MaintenanceError(
        "Bakım planına takvim veya sayaç aralığı verilmelidir. Aralıksız bir plan " +
          "hiçbir zaman tetiklenmez ve 'bakım planımız var' yanılsaması yaratır.",
      );
    }
    const row = await this.#db.maintenancePlan.create({
      data: {
        machineCode: input.machineCode,
        description: input.description,
        intervalDays: input.intervalDays ?? null,
        intervalHours:
          input.intervalHours == null ? null : new Prisma.Decimal(input.intervalHours),
        lastDoneAt: input.lastDoneAt ?? null,
        lastDoneHours:
          input.lastDoneHours == null ? null : new Prisma.Decimal(input.lastDoneHours),
      },
    });
    return { id: row.id };
  }

  /**
   * Zamanı gelen bakımlar.
   *
   * Makinenin çalışma saati `machine_status_snapshots` içinde tutuluyorsa
   * sayaç yolu, yoksa takvim yolu kullanılır — hangisinin kullanıldığı
   * cevapta yazar.
   */
  async duePlans(on: Date) {
    const plans = await this.#db.maintenancePlan.findMany({
      where: { isActive: true },
      take: 500,
    });

    // Çalışma saati anlık görüntüden okunur; yoksa null kalır ve
    // takvim yoluna düşülür.
    const hoursOf = new Map<string, number>();
    for (const p of plans) {
      const snap = await this.#db.machineStatusSnapshot.findFirst({
        where: { machineId: p.machineCode },
        orderBy: { asOf: "desc" },
        select: { runningHours: true },
      });
      if (snap?.runningHours != null) hoursOf.set(p.machineCode, Number(snap.runningHours));
    }

    return plans
      .map((p) => {
        const result = isDue(
          {
            machineCode: p.machineCode,
            description: p.description,
            intervalDays: p.intervalDays,
            intervalHours: p.intervalHours === null ? null : Number(p.intervalHours),
            lastDoneAt: p.lastDoneAt,
            lastDoneHours: p.lastDoneHours === null ? null : Number(p.lastDoneHours),
            currentHours: hoursOf.get(p.machineCode) ?? null,
          },
          on,
        );
        return {
          planId: p.id,
          machineCode: p.machineCode,
          description: p.description,
          ...result,
        };
      })
      .sort((a, b) => Number(b.due) - Number(a.due) || b.overdueDays - a.overdueDays);
  }

  /** Bakım iş emri açar. */
  async createOrder(input: {
    machineCode: string;
    kind: MaintenanceKind;
    description: string;
    planId?: string | null;
    scheduledFor?: Date | null;
    userId: string;
    at: Date;
  }): Promise<{ documentNo: string; id: string }> {
    return this.#db.$transaction(async (tx) => {
      const documentNo = await nextDocumentNo(tx, "maintenance_order", input.at.getUTCFullYear());
      const row = await tx.maintenanceOrder.create({
        data: {
          documentNo,
          machineCode: input.machineCode,
          planId: input.planId ?? null,
          kind: input.kind,
          status: "planned",
          description: input.description,
          scheduledFor: input.scheduledFor ?? null,
          createdBy: input.userId,
        },
      });
      return { documentNo, id: row.id };
    });
  }

  /**
   * Arıza bildirir ve gerekiyorsa iş emri açar.
   *
   * ÜRETİMİ DURDURAN ARIZA HEMEN İŞ EMRİ DOĞURUR. Beklemesi gerekseydi,
   * en pahalı arıza için en yavaş yol izlenmiş olurdu.
   */
  async reportBreakdown(input: {
    machineCode: string;
    severity: BreakdownSeverity;
    description: string;
    reportedAt: Date;
    userId: string;
  }): Promise<{ breakdownId: string; orderNo: string | null }> {
    return this.#db.$transaction(async (tx) => {
      let orderId: string | null = null;
      let orderNo: string | null = null;

      if (input.severity === "durdurdu") {
        const documentNo = await nextDocumentNo(
          tx,
          "maintenance_order",
          input.reportedAt.getUTCFullYear(),
        );
        const order = await tx.maintenanceOrder.create({
          data: {
            documentNo,
            machineCode: input.machineCode,
            kind: "ariza",
            status: "released",
            description: input.description,
            createdBy: input.userId,
          },
        });
        orderId = order.id;
        orderNo = documentNo;
      }

      const b = await tx.breakdown.create({
        data: {
          machineCode: input.machineCode,
          reportedAt: input.reportedAt,
          reportedBy: input.userId,
          severity: input.severity,
          description: input.description,
          orderId,
        },
      });

      return { breakdownId: b.id, orderNo };
    });
  }

  async resolveBreakdown(input: {
    breakdownId: string;
    resolvedAt: Date;
    rootCause: string;
  }): Promise<{ downtimeHours: number | null }> {
    if (input.rootCause.trim().length < 5) {
      throw new MaintenanceError(
        "Kök neden yazılmalıdır. Aynı arıza tekrar ettiğinde ilk bakılacak yer " +
          "burasıdır; boş bırakılırsa her seferinde sıfırdan aranır.",
      );
    }
    const b = await this.#db.breakdown.findUnique({ where: { id: input.breakdownId } });
    if (!b) throw new MaintenanceError("Arıza kaydı bulunamadı.");
    if (b.resolvedAt) throw new MaintenanceError("Bu arıza zaten kapatılmış.");
    if (input.resolvedAt < b.reportedAt) {
      throw new MaintenanceError(
        "Giderilme zamanı bildirim zamanından önce olamaz; negatif duruş süresi " +
          "ortalamaları bozar.",
      );
    }

    await this.#db.breakdown.update({
      where: { id: b.id },
      data: { resolvedAt: input.resolvedAt, rootCause: input.rootCause },
    });

    const d = downtime(
      {
        machineCode: b.machineCode,
        reportedAt: b.reportedAt,
        severity: b.severity as BreakdownSeverity,
        description: b.description,
        resolvedAt: input.resolvedAt,
      },
      input.resolvedAt,
    );
    return { downtimeHours: d.hours };
  }

  /**
   * Bakım iş emrini tamamlar ve planın son bakım bilgisini günceller.
   *
   * PLAN GÜNCELLENMEZSE BAKIM SONSUZA KADAR "GECİKMİŞ" GÖRÜNÜR ve
   * bir süre sonra kimse listeye bakmaz.
   */
  async completeOrder(input: {
    documentNo: string;
    completedAt: Date;
    laborHours?: number | null;
    partsCost?: number | null;
    findings: string;
    currentHours?: number | null;
  }): Promise<{ documentNo: string; planUpdated: boolean }> {
    return this.#db.$transaction(async (tx) => {
      const order = await tx.maintenanceOrder.findUnique({
        where: { documentNo: input.documentNo },
      });
      if (!order) throw new MaintenanceError(`Bakım iş emri bulunamadı: ${input.documentNo}`);
      if (order.status === "completed") {
        throw new MaintenanceError(`${input.documentNo} zaten tamamlanmış.`);
      }
      if (order.status === "cancelled") {
        throw new MaintenanceError(`${input.documentNo} iptal edilmiş.`);
      }

      await tx.maintenanceOrder.update({
        where: { id: order.id },
        data: {
          status: "completed",
          completedAt: input.completedAt,
          laborHours:
            input.laborHours == null ? null : new Prisma.Decimal(input.laborHours),
          partsCost: input.partsCost == null ? null : new Prisma.Decimal(input.partsCost),
          findings: input.findings,
        },
      });

      let planUpdated = false;
      if (order.planId) {
        await tx.maintenancePlan.update({
          where: { id: order.planId },
          data: {
            lastDoneAt: input.completedAt,
            ...(input.currentHours != null
              ? { lastDoneHours: new Prisma.Decimal(input.currentHours) }
              : {}),
          },
        });
        planUpdated = true;
      }

      return { documentNo: input.documentNo, planUpdated };
    });
  }

  /** Bakım göstergeleri: planlı oranı, duruş, MTBF, MTTR. */
  async kpi(from: Date, to: Date) {
    const [orders, breakdowns] = await Promise.all([
      this.#db.maintenanceOrder.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { kind: true },
        take: 5000,
      }),
      this.#db.breakdown.findMany({
        where: { reportedAt: { gte: from, lte: to } },
        select: { reportedAt: true, resolvedAt: true, severity: true },
        take: 5000,
      }),
    ]);

    const periodHours = (to.getTime() - from.getTime()) / 3_600_000;

    return maintenanceKpi({
      orders: orders.map((o) => ({ kind: o.kind as MaintenanceKind })),
      breakdowns: breakdowns.map((b) => {
        const d = downtime(
          {
            machineCode: "",
            reportedAt: b.reportedAt,
            severity: b.severity as BreakdownSeverity,
            description: "",
            resolvedAt: b.resolvedAt,
          },
          to,
        );
        return {
          // DEVAM EDEN ARIZANIN SÜRESİ ÖLÇÜLMEMİŞ SAYILIR: bugüne kadar
          // geçen süre gerçek tamir süresi değildir.
          downtimeHours: b.resolvedAt ? d.hours : null,
          productionStopping: d.productionStopping,
          reportedAt: b.reportedAt,
        };
      }),
      periodHours,
    });
  }

  /** Açık arızalar — devam edenler başta. */
  async openBreakdowns(limit = 50) {
    const rows = await this.#db.breakdown.findMany({
      where: { resolvedAt: null },
      orderBy: [{ severity: "asc" }, { reportedAt: "asc" }],
      take: limit,
      include: { order: { select: { documentNo: true, status: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      machineCode: b.machineCode,
      severity: b.severity,
      description: b.description,
      reportedAt: b.reportedAt.toISOString(),
      orderNo: b.order?.documentNo ?? null,
      orderStatus: b.order?.status ?? null,
    }));
  }

  /** Bir makinenin bakım geçmişi — sonraki arızada ilk bakılacak yer. */
  async machineHistory(machineCode: string, limit = 30) {
    const [orders, breakdowns] = await Promise.all([
      this.#db.maintenanceOrder.findMany({
        where: { machineCode },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          documentNo: true,
          kind: true,
          status: true,
          description: true,
          completedAt: true,
          findings: true,
          laborHours: true,
          partsCost: true,
        },
      }),
      this.#db.breakdown.findMany({
        where: { machineCode },
        orderBy: { reportedAt: "desc" },
        take: limit,
        select: { reportedAt: true, severity: true, description: true, rootCause: true, resolvedAt: true },
      }),
    ]);

    return {
      machineCode,
      orders: orders.map((o) => ({
        documentNo: o.documentNo,
        kind: o.kind,
        status: o.status,
        description: o.description,
        completedAt: o.completedAt?.toISOString().slice(0, 10) ?? null,
        findings: o.findings,
        laborHours: o.laborHours === null ? null : Number(o.laborHours),
        partsCost: o.partsCost === null ? null : Number(o.partsCost),
      })),
      breakdowns: breakdowns.map((b) => ({
        reportedAt: b.reportedAt.toISOString().slice(0, 10),
        severity: b.severity,
        description: b.description,
        rootCause: b.rootCause,
        resolved: b.resolvedAt !== null,
      })),
    };
  }
}
