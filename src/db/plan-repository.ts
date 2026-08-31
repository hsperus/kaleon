/**
 * İşlem planı veri erişimi.
 *
 * DURUM GEÇİŞLERİ ATOMİK. Planı "koşuyor" yapan güncelleme, yalnızca
 * hâlâ "onaylı" olan bir planı yakalar (`updateMany` + koşul). İki
 * eşzamanlı koşum isteğinden yalnızca biri geçer; aksi hâlde aynı
 * plan iki kez koşar ve aynı faturalar iki kez kesilir.
 *
 * Bu, `pending-store`daki "işlemi tüket" kuralının aynısı — orada bir
 * işlem için geçerliydi, burada bir plan için.
 */

import { BusinessRuleError } from "../kernel/errors.js";
import type { TenantDb } from "./client.js";
import type { PlanStatus, PlanStep, StepStatus } from "../modules/planning/operation-plan.js";

export interface StoredPlan {
  readonly id: string;
  readonly documentNo: string;
  readonly title: string;
  readonly question: string | null;
  readonly status: PlanStatus;
  readonly requiredAuthority: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly steps: readonly {
    readonly seq: number;
    readonly tool: string;
    readonly input: unknown;
    readonly description: string;
    readonly status: StepStatus;
    readonly resultSummary: string | null;
    readonly errorCode: string | null;
  }[];
}

export class PlanRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async nextNo(year: number): Promise<string> {
    const n = await this.#db.operationPlan.count({
      where: { documentNo: { startsWith: `PLN-${year}-` } },
    });
    return `PLN-${year}-${String(n + 1).padStart(4, "0")}`;
  }

  async create(input: {
    documentNo: string;
    title: string;
    question: string | null;
    requiredAuthority: number;
    steps: readonly PlanStep[];
    userId: string;
    conversationId: string | null;
  }): Promise<{ documentNo: string; id: string }> {
    const row = await this.#db.operationPlan.create({
      data: {
        documentNo: input.documentNo,
        title: input.title,
        question: input.question,
        requiredAuthority: input.requiredAuthority,
        createdBy: input.userId,
        conversationId: input.conversationId,
        steps: {
          create: input.steps.map((s) => ({
            seq: s.seq,
            tool: s.tool,
            input: s.input as never,
            description: s.description,
          })),
        },
      },
    });
    return { documentNo: row.documentNo, id: row.id };
  }

  async find(documentNo: string, userId: string): Promise<StoredPlan | null> {
    const p = await this.#db.operationPlan.findUnique({
      where: { documentNo },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
    /*
     * BAŞKASININ PLANI GÖRÜNMEZ.
     *
     * Plan, sahibinin yetkisiyle koşacak işlemler taşıyor; başkasının
     * planını okumak, o kişinin ne yapmaya hazırlandığını görmek
     * demektir. Bulunamadı ile yetkisiz aynı cevabı veriyor: hangi
     * belge numaralarının VAR OLDUĞU da bir bilgidir.
     */
    if (!p || p.createdBy !== userId) return null;

    return {
      id: p.id,
      documentNo: p.documentNo,
      title: p.title,
      question: p.question,
      status: p.status as PlanStatus,
      requiredAuthority: p.requiredAuthority,
      createdBy: p.createdBy,
      createdAt: p.createdAt.toISOString(),
      approvedAt: p.approvedAt?.toISOString() ?? null,
      steps: p.steps.map((s) => ({
        seq: s.seq,
        tool: s.tool,
        input: s.input,
        description: s.description,
        status: s.status as StepStatus,
        resultSummary: s.resultSummary,
        errorCode: s.errorCode,
      })),
    };
  }

  async listFor(userId: string, limit = 20) {
    const rows = await this.#db.operationPlan.findMany({
      where: { createdBy: userId },
      include: { steps: { select: { status: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((p) => ({
      documentNo: p.documentNo,
      title: p.title,
      status: p.status,
      stepCount: p.steps.length,
      doneCount: p.steps.filter((s) => s.status === "done").length,
      failedCount: p.steps.filter((s) => s.status === "failed").length,
      createdAt: p.createdAt.toISOString().slice(0, 10),
    }));
  }

  /** Onaylar: draft → approved. Yarışa kapalı. */
  async approve(documentNo: string, userId: string, at: Date): Promise<boolean> {
    const r = await this.#db.operationPlan.updateMany({
      where: { documentNo, createdBy: userId, status: "draft" },
      data: { status: "approved", approvedBy: userId, approvedAt: at },
    });
    return r.count === 1;
  }

  /**
   * Koşumu başlatır: approved → running.
   *
   * YARIŞA KAPALI. `updateMany` yalnızca hâlâ "approved" olan planı
   * yakalar; iki eşzamanlı istekten biri false alır ve durur. Kontrol
   * uygulama katmanında `find` + `update` ile yapılsaydı, iki istek
   * de "onaylı" görür ve ikisi de koşardı.
   */
  async begin(documentNo: string, userId: string, at: Date): Promise<boolean> {
    const r = await this.#db.operationPlan.updateMany({
      where: { documentNo, createdBy: userId, status: { in: ["draft", "approved"] } },
      /*
       * ONAY BURADA MÜHÜRLENİYOR.
       *
       * Koşum tool'u onay kapısından geçtiği için, koşumu başlatan
       * tıklama planın onayıdır. `approved_by` boş bırakılsaydı
       * veritabanı kısıtı da reddederdi: onaysız bir "running" kaydı,
       * kimin sorumlu olduğu bilinmeyen bir işlem demektir.
       */
      data: { status: "running", approvedBy: userId, approvedAt: at },
    });
    return r.count === 1;
  }

  async recordStep(input: {
    planId: string;
    seq: number;
    status: StepStatus;
    summary: string | null;
    errorCode: string | null;
    at: Date;
  }): Promise<void> {
    await this.#db.operationPlanStep.updateMany({
      where: { planId: input.planId, seq: input.seq },
      data: {
        status: input.status,
        resultSummary: input.summary,
        errorCode: input.errorCode,
        ranAt: input.at,
      },
    });
  }

  async finish(planId: string, status: PlanStatus, at: Date): Promise<void> {
    await this.#db.operationPlan.update({
      where: { id: planId },
      data: { status, finishedAt: at },
    });
  }

  async cancel(documentNo: string, userId: string): Promise<boolean> {
    const r = await this.#db.operationPlan.updateMany({
      // Koşan bir plan iptal edilemez: yarısı yazılmış olabilir ve
      // "iptal" demek onu geri almaz.
      where: { documentNo, createdBy: userId, status: { in: ["draft", "approved"] } },
      data: { status: "cancelled" },
    });
    if (r.count === 0) {
      throw new BusinessRuleError(
        `${documentNo} iptal edilemedi: plan bulunamadı ya da artık iptal edilebilir ` +
          `durumda değil. Koşmuş bir planı iptal etmek yapılanı geri almaz.`,
        "plan_not_cancellable",
      );
    }
    return true;
  }
}
