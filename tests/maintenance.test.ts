/**
 * Bakım yönetimi.
 *
 * Bir imalat KOBİ'sinde duran tezgâh, eksik malzemeden pahalıdır. Bu
 * dosyanın disiplini şudur: ölçülemeyen şey "sıfır" değil "bilinmiyor"
 * sayılır. Devam eden bir arızanın süresini sıfır kabul etmek, en pahalı
 * arızayı raporda hiç göstermemek demektir.
 */

import { describe, expect, it } from "vitest";
import {
  downtime,
  isDue,
  maintenanceKpi,
  MIN_SAMPLES_FOR_KPI,
  type MaintenancePlan,
} from "../src/modules/maintenance/maintenance.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const t = (s: string) => new Date(s);

const plan = (over: Partial<MaintenancePlan> = {}): MaintenancePlan => ({
  machineCode: "MK-01",
  description: "Yağ değişimi",
  intervalDays: null,
  intervalHours: null,
  lastDoneAt: null,
  lastDoneHours: null,
  currentHours: null,
  ...over,
});

describe("bakım zamanı", () => {
  it("SAYAÇ VARSA SAYACA BAKILIR", () => {
    const r = isDue(
      plan({ intervalHours: 500, lastDoneHours: 1000, currentHours: 1400, intervalDays: 90, lastDoneAt: d("2026-01-01") }),
      d("2026-06-15"),
    );
    expect(r.basis).toBe("sayac");
    expect(r.hoursRemaining).toBe(100);
    expect(r.due).toBe(false);
  });

  it("sayaca göre gecikme saatle söylenir", () => {
    const r = isDue(
      plan({ intervalHours: 500, lastDoneHours: 1000, currentHours: 1600 }),
      d("2026-06-15"),
    );
    expect(r.due).toBe(true);
    expect(r.hoursRemaining).toBe(-100);
    expect(r.explanation).toContain("100 saat GEÇTİ");
  });

  it("SAYAÇ YOKSA TAKVİME DÜŞÜLÜR VE SÖYLENİR", () => {
    // "Her 3 ayda bir" kuralı az çalışan tezgâhı gereksiz durdurur.
    const r = isDue(plan({ intervalDays: 90, lastDoneAt: d("2026-01-01") }), d("2026-06-15"));
    expect(r.basis).toBe("takvim");
    expect(r.due).toBe(true);
    expect(r.overdueDays).toBe(75); // 1 Nisan planlıydı, 15 Haziran
    expect(r.explanation).toContain("çalışma saati bilinmediği için takvim");
  });

  it("takvime göre zamanı gelmemişse gecikme yok", () => {
    const r = isDue(plan({ intervalDays: 90, lastDoneAt: d("2026-06-01") }), d("2026-06-15"));
    expect(r.due).toBe(false);
    expect(r.overdueDays).toBe(0);
  });

  it("HİÇ ÖLÇÜ YOKSA 'ZAMANI GELMEDİ' DENMEZ", () => {
    // Sessizce "gelmedi" demek, hiç bakılmayan bir makineyi sorunsuz
    // göstermektir.
    const r = isDue(plan(), d("2026-06-15"));
    expect(r.basis).toBe("bilinmiyor");
    expect(r.explanation).toContain("HESAPLANAMIYOR");
  });

  it("aralık var ama son bakım yoksa hesaplanamaz", () => {
    const r = isDue(plan({ intervalDays: 90 }), d("2026-06-15"));
    expect(r.basis).toBe("bilinmiyor");
  });
});

describe("duruş süresi", () => {
  const b = {
    machineCode: "MK-01",
    reportedAt: t("2026-06-15T08:00:00.000Z"),
    severity: "durdurdu" as const,
    description: "Şanzıman sesi",
  };

  it("kapanmış arızanın süresi hesaplanır", () => {
    const r = downtime({ ...b, resolvedAt: t("2026-06-15T12:30:00.000Z") }, t("2026-06-16T00:00:00.000Z"));
    expect(r.hours).toBe(4.5);
    expect(r.ongoing).toBe(false);
    expect(r.productionStopping).toBe(true);
  });

  it("DEVAM EDEN ARIZANIN SÜRESİ SIFIR DEĞİL", () => {
    // Sıfır sayılsaydı en pahalı arıza raporda hiç görünmezdi.
    const r = downtime(b, t("2026-06-15T18:00:00.000Z"));
    expect(r.ongoing).toBe(true);
    expect(r.hours).toBe(10);
  });

  it("üretimi etkilemeyen arıza ayrı işaretlenir", () => {
    const r = downtime({ ...b, severity: "etkilemedi", resolvedAt: t("2026-06-15T09:00:00.000Z") }, t("2026-06-16"));
    expect(r.productionStopping).toBe(false);
  });
});

describe("bakım göstergeleri", () => {
  const breakdowns = [
    { downtimeHours: 4, productionStopping: true, reportedAt: d("2026-06-01") },
    { downtimeHours: 2, productionStopping: false, reportedAt: d("2026-06-10") },
    { downtimeHours: 6, productionStopping: true, reportedAt: d("2026-06-20") },
  ];

  it("planlı oranı hesaplanır", () => {
    const k = maintenanceKpi({
      orders: [{ kind: "planli" }, { kind: "planli" }, { kind: "ariza" }, { kind: "ariza" }],
      breakdowns,
      periodHours: 720,
    });
    expect(k.plannedRatePercent).toBe(50);
  });

  it("ÜRETİMİ DURDURAN DURUŞ AYRI TOPLANIR", () => {
    const k = maintenanceKpi({ orders: [], breakdowns, periodHours: 720 });
    expect(k.totalDowntimeHours).toBe(12);
    expect(k.productionStoppingHours).toBe(10);
  });

  it("MTBF ve MTTR hesaplanır", () => {
    const k = maintenanceKpi({ orders: [], breakdowns, periodHours: 720 });
    expect(k.mtbfHours).toBe(236); // (720-12)/3
    expect(k.mttrHours).toBe(4); // 12/3
  });

  it(`AZ VERİYLE MTBF/MTTR HESAPLANMAZ (${MIN_SAMPLES_FOR_KPI} altı)`, () => {
    // Üç arızadan eğilim çıkarmak, rastlantıyı eğilim gibi sunmaktır.
    const k = maintenanceKpi({
      orders: [],
      breakdowns: breakdowns.slice(0, 2),
      periodHours: 720,
    });
    expect(k.mtbfHours).toBe(null);
    expect(k.mttrHours).toBe(null);
    expect(k.caveats.some((c) => c.includes("rastlantıyı"))).toBe(true);
  });

  it("SÜRESİ ÖLÇÜLMEMİŞ ARIZA TOPLAMI EKSİK BIRAKIR VE SÖYLENİR", () => {
    const k = maintenanceKpi({
      orders: [],
      breakdowns: [...breakdowns, { downtimeHours: null, productionStopping: true, reportedAt: d("2026-06-25") }],
      periodHours: 720,
    });
    expect(k.totalDowntimeHours).toBe(12);
    expect(k.caveats.some((c) => c.includes("EKSİKTİR"))).toBe(true);
  });

  it("hiç iş yoksa oran null döner", () => {
    const k = maintenanceKpi({ orders: [], breakdowns: [], periodHours: 720 });
    expect(k.plannedRatePercent).toBe(null);
    expect(k.mtbfHours).toBe(null);
  });
});
