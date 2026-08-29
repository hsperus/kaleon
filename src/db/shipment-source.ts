/**
 * Sevkiyat riski — Postgres adaptörü.
 *
 * EN ÖNEMLİ KARAR: "BİLMİYORUM" İLE "RİSK YOK" AYRI ŞEYLERDİR.
 *
 * Bir siparişin kalemleri iş emrine bağlanmamışsa veya iş emrinin planlanan
 * bitişi girilmemişse, o siparişin sevkiyat tarihi BİLİNMEZ. Bu durumda
 * sistem tahmin uydurmaz ve siparişi "riskli değil" diye de saymaz —
 * ayrı bir listede "riski bilinmiyor" olarak döndürür. Bir ERP'nin
 * verebileceği en tehlikeli cevap, bilmediği şeye "sorun yok" demektir:
 * kimse bakmaz, sipariş gecikir, ceza kesilir.
 *
 * CEZA RİSKİ HESAPLANIRKEN ÜÇ AYRIM:
 *   - günlük ceza null      → sözleşmede yazmıyor; risk TUTARI bilinmez,
 *                             gecikme yine de raporlanır (tutar 0 yazılır
 *                             ama gecikme günü görünür)
 *   - günlük ceza 0         → sözleşmede ceza yok; farklı bir bilgidir
 *   - tavan (cap) var       → hesaplanmazsa risk olduğundan büyük çıkar
 *
 * SİPARİŞİN TARİHİ, EN GEÇ BİTEN KALEMİNİN TARİHİDİR. Sipariş bir bütün
 * olarak sevk edilir; kalemlerden biri geç kalırsa sipariş geç kalır.
 */

import type { ShipmentRisk, WithFreshness } from "../data/port.js";
import type { TenantDb } from "./client.js";

/** Tarihi bilinemeyen sipariş — sessizce "risksiz" sayılmaz. */
export interface UnknownShipment {
  readonly salesOrder: string;
  readonly customer: string;
  readonly committedDate: string;
  readonly reason: "iş emri bağlanmamış" | "planlanan bitiş girilmemiş";
}

export interface ShipmentAnalysis {
  readonly risks: readonly ShipmentRisk[];
  readonly unknown: readonly UnknownShipment[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tam gün farkı — saat/dakika taşımaz, tarihler zaten gün hassasiyetinde. */
export function slipDays(committed: Date, estimated: Date): number {
  return Math.round((estimated.getTime() - committed.getTime()) / DAY_MS);
}

/**
 * Gecikme cezası.
 *
 * Tavan uygulanır; uygulanmazsa 40 günlük gecikme sözleşmenin izin verdiği
 * tutarın kat kat üstünde bir "risk" üretir ve tüm rapor güvenilmez olur.
 */
export function penaltyFor(
  days: number,
  perDay: number | null,
  cap: number | null,
): number {
  if (days <= 0 || perDay === null) return 0;
  const raw = days * perDay;
  return cap === null ? raw : Math.min(raw, cap);
}

export class PrismaShipmentSource {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  async analyze(): Promise<ShipmentAnalysis & { freshness: { syncedAt: string } }> {
    const orders = await this.#db.salesOrder.findMany({
      where: { status: "open" },
      include: {
        partner: { select: { legalName: true } },
        lines: {
          include: {
            workOrder: { select: { plannedEndDate: true, status: true } },
          },
        },
      },
      orderBy: { committedDate: "asc" },
    });

    const risks: ShipmentRisk[] = [];
    const unknown: UnknownShipment[] = [];
    let newest: Date | null = null;

    for (const order of orders) {
      if (order.updatedAt > (newest ?? new Date(0))) newest = order.updatedAt;

      const common = {
        salesOrder: order.orderNo,
        customer: order.partner.legalName,
        committedDate: iso(order.committedDate),
      };

      // Kalemi olmayan sipariş de tarihi bilinemeyen siparştir.
      if (order.lines.length === 0) {
        unknown.push({ ...common, reason: "iş emri bağlanmamış" });
        continue;
      }

      const unlinked = order.lines.some((l) => l.workOrder === null);
      if (unlinked) {
        unknown.push({ ...common, reason: "iş emri bağlanmamış" });
        continue;
      }

      const missingPlan = order.lines.some((l) => l.workOrder?.plannedEndDate == null);
      if (missingPlan) {
        unknown.push({ ...common, reason: "planlanan bitiş girilmemiş" });
        continue;
      }

      // Sipariş bir bütün sevk edilir: en geç biten kalem tarihi belirler.
      const estimated = order.lines
        .map((l) => l.workOrder!.plannedEndDate!)
        .reduce((max, d) => (d > max ? d : max));

      const days = slipDays(order.committedDate, estimated);
      if (days <= 0) continue; // zamanında — risk listesine girmez

      risks.push({
        ...common,
        estimatedDate: iso(estimated),
        slipDays: days,
        penaltyRiskTry: penaltyFor(
          days,
          order.penaltyPerDay === null ? null : Number(order.penaltyPerDay),
          order.penaltyCap === null ? null : Number(order.penaltyCap),
        ),
      });
    }

    // En büyük gecikme başta — cevabın ilk satırı en acil olan olsun.
    risks.sort((a, b) => b.slipDays - a.slipDays);

    return {
      risks,
      unknown,
      freshness: { syncedAt: (newest ?? new Date()).toISOString() },
    };
  }

  async shipmentRisks(): Promise<WithFreshness<readonly ShipmentRisk[]>> {
    const { risks, unknown, freshness } = await this.analyze();
    return {
      rows: risks,
      freshness: { ...freshness, recordCount: risks.length },
      // Tarihi bilinemeyen siparişler cevabın parçasıdır, dipnotu değil.
      caveats: unknown.length === 0 ? [] : [describeUnknown(unknown)],
    };
  }
}

function describeUnknown(rows: readonly UnknownShipment[]): string {
  const byReason = new Map<string, string[]>();
  for (const r of rows) {
    byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.salesOrder]);
  }
  const parts = [...byReason.entries()].map(
    ([reason, orders]) => `${orders.join(", ")} (${reason})`,
  );
  return `${rows.length} siparişin sevkiyat tarihi hesaplanamadı, riski BİLİNMİYOR: ${parts.join("; ")}`;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
