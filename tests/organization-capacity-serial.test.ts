/**
 * Organizasyon yapısı, kapasite planlama ve seri izleme.
 *
 * Üçünün ortak disiplini: TANIMSIZ OLAN SIFIR SAYILMAZ. Kapasitesi
 * tanımsız bir tezgâh "%0 dolu" gösterilirse oraya iş yığılır; sevk
 * tarihi bilinmeyen bir ürün "garantisi yok" sayılırsa hakkı olan
 * müşteriye ücret çıkarılır.
 */

import { describe, expect, it } from "vitest";
import {
  assertHierarchy,
  descendantsOf,
  orphans,
  plantOf,
  OrganizationError,
  type LocationNode,
} from "../src/modules/master-data/organization.js";
import {
  loadProfile,
  requiredHours,
  type WorkCenterCapacity,
} from "../src/modules/planning/capacity.js";
import {
  assertTransition,
  normalizeSerial,
  warrantyStatus,
  SerialError,
} from "../src/modules/inventory/serial.js";
import {
  draftTermination,
  earnsSeverance,
  employerOwesNotice,
  noticeWeeks,
} from "../src/modules/hr/termination.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// ─────────────── Organizasyon ───────────────

const node = (
  code: string,
  kind: LocationNode["kind"],
  parentCode: string | null = null,
): LocationNode => ({ code, name: code, kind, parentCode, isActive: true });

const tree = new Map<string, LocationNode>([
  ["BURSA", node("BURSA", "plant")],
  ["KOCAELI", node("KOCAELI", "plant")],
  ["B-DEPO", node("B-DEPO", "warehouse", "BURSA")],
  ["B-RAF-1", node("B-RAF-1", "storage_location", "B-DEPO")],
  ["K-DEPO", node("K-DEPO", "warehouse", "KOCAELI")],
]);

describe("organizasyon hiyerarşisi", () => {
  it("tesis en üst kademedir", () => {
    expect(() => assertHierarchy("plant", null)).not.toThrow();
    expect(() => assertHierarchy("plant", tree.get("BURSA")!)).toThrow(/en üst kademedir/);
  });

  it("KADEME ATLANAMAZ", () => {
    // Doğrudan tesise bağlanmış bir depo yeri, depo bazlı raporlarda
    // hiç görünmez ve orada duran mal yokmuş sayılır.
    expect(() => assertHierarchy("storage_location", tree.get("BURSA")!)).toThrow(
      /Depo altında olmalıdır/,
    );
    expect(() => assertHierarchy("storage_location", tree.get("B-DEPO")!)).not.toThrow();
  });

  it("bağlantısız depo reddedilir", () => {
    expect(() => assertHierarchy("warehouse", null)).toThrow(OrganizationError);
  });

  it("bir lokasyonun tesisi yukarı yürüyerek bulunur", () => {
    expect(plantOf("B-RAF-1", tree)).toBe("BURSA");
    expect(plantOf("K-DEPO", tree)).toBe("KOCAELI");
    expect(plantOf("BURSA", tree)).toBe("BURSA");
  });

  it("tesisin altındaki her şey listelenir", () => {
    expect([...descendantsOf("BURSA", tree)].sort()).toEqual(["B-DEPO", "B-RAF-1"]);
  });

  it("YETİM LOKASYON YAKALANIR", () => {
    // Buradaki stok tesis raporlarında görünmez ve eksikliği ancak
    // sayımda anlaşılır.
    const withOrphan = new Map(tree);
    withOrphan.set("YETIM", node("YETIM", "warehouse", "YOK-1"));
    expect(orphans(withOrphan)).toContain("YETIM");
  });

  it("DÖNGÜSEL HİYERARŞİ YAKALANIR", () => {
    const loop = new Map<string, LocationNode>([
      ["A", node("A", "warehouse", "B")],
      ["B", node("B", "warehouse", "A")],
    ]);
    expect(() => plantOf("A", loop)).toThrow(/DÖNGÜ/);
  });
});

// ─────────────── Kapasite ───────────────

const centers: WorkCenterCapacity[] = [
  { code: "KESIM", name: "Kesim", dailyHours: 16, concurrent: 2 },
  { code: "KAYNAK", name: "Kaynak", dailyHours: 8, concurrent: 1 },
  { code: "BOYA", name: "Boya", dailyHours: null, concurrent: null },
];

describe("kapasite yükleme", () => {
  it("doluluk oranı hesaplanır", () => {
    const r = loadProfile({
      centers,
      demands: [{ workCenter: "KESIM", hours: 8, dueDate: d("2026-07-01"), source: "WO-1" }],
    });
    expect(r.buckets[0]!.loadPercent).toBe(50);
    expect(r.buckets[0]!.overloaded).toBe(false);
  });

  it("AYNI GÜNE İKİ İŞ TOPLANIR", () => {
    const r = loadProfile({
      centers,
      demands: [
        { workCenter: "KAYNAK", hours: 5, dueDate: d("2026-07-01"), source: "WO-1" },
        { workCenter: "KAYNAK", hours: 6, dueDate: d("2026-07-01"), source: "WO-2" },
      ],
    });
    expect(r.buckets[0]!.requiredHours).toBe(11);
    expect(r.buckets[0]!.overloaded).toBe(true);
    expect(r.overloaded).toHaveLength(1);
  });

  it("KAPASİTESİ TANIMSIZ TEZGÂH '%0 DOLU' GÖSTERİLMEZ", () => {
    // Sıfır doluluk boş bir tezgâh demektir ve oraya iş yığdırır.
    const r = loadProfile({
      centers,
      demands: [{ workCenter: "BOYA", hours: 20, dueDate: d("2026-07-01"), source: "WO-1" }],
    });
    expect(r.buckets[0]!.loadPercent).toBe(null);
    expect(r.buckets[0]!.overloaded).toBe(false);
    expect(r.caveats.some((c) => c.includes("HESAPLANAMADI"))).toBe(true);
  });

  it("TANIMSIZ İŞ MERKEZİ SESSİZCE ATLANMAZ", () => {
    const r = loadProfile({
      centers,
      demands: [{ workCenter: "YOK", hours: 5, dueDate: d("2026-07-01"), source: "WO-9" }],
    });
    expect(r.buckets).toEqual([]);
    expect(r.caveats[0]).toContain("PLANA GİRMEDİ");
  });

  it("HEDEF HIZ TANIMSIZSA SÜRE HESAPLANMAZ", () => {
    expect(requiredHours(100, 20)).toBe(5);
    expect(requiredHours(100, null)).toBe(null);
    expect(requiredHours(100, 0)).toBe(null);
  });

  it("aşan günler en sıkışıktan sıralanır", () => {
    const r = loadProfile({
      centers,
      demands: [
        { workCenter: "KAYNAK", hours: 9, dueDate: d("2026-07-01"), source: "A" },
        { workCenter: "KAYNAK", hours: 20, dueDate: d("2026-07-02"), source: "B" },
      ],
    });
    expect(r.overloaded[0]!.date).toBe("2026-07-02");
  });
});

// ─────────────── Seri numarası ───────────────

describe("seri numarası", () => {
  it("boşluk ve harf farkı temizlenir", () => {
    expect(normalizeSerial(" sn-001 ")).toBe("SN-001");
    expect(normalizeSerial("sn 001")).toBe("SN001");
  });

  it("çok kısa seri reddedilir", () => {
    expect(() => normalizeSerial("A1")).toThrow(SerialError);
  });

  it("HURDAYA AYRILAN SERİ GERİ DÖNEMEZ", () => {
    expect(() => assertTransition("hurda", "stokta")).toThrow(/yeniden kullanılamaz/);
  });

  it("SEVK EDİLMİŞ SERİ DOĞRUDAN STOĞA DÖNEMEZ", () => {
    // İade ediliyorsa önce kontrol edilmelidir.
    expect(() => assertTransition("sevk_edildi", "stokta")).toThrow(/servise alınmalı/);
    expect(() => assertTransition("sevk_edildi", "serviste")).not.toThrow();
  });

  it("aynı duruma geçiş reddedilir", () => {
    expect(() => assertTransition("stokta", "stokta")).toThrow(SerialError);
  });
});

describe("garanti", () => {
  it("süre hesaplanır", () => {
    const w = warrantyStatus({
      shippedAt: d("2026-01-15"),
      warrantyMonths: 24,
      on: d("2026-06-15"),
    });
    expect(w.covered).toBe(true);
    expect(w.expiresAt).toBe("2028-01-15");
  });

  it("SEVK TARİHİ YOKSA 'GARANTİ YOK' DENMEZ", () => {
    // "Garanti yok" demek, hakkı olan müşteriye ücret çıkarmaktır.
    const w = warrantyStatus({ shippedAt: null, warrantyMonths: 24, on: d("2026-06-15") });
    expect(w.covered).toBe(null);
    expect(w.explanation).toContain("HESAPLANAMIYOR");
  });

  it("garanti süresi tanımsızsa kapsam belirlenemez", () => {
    const w = warrantyStatus({
      shippedAt: d("2026-01-15"),
      warrantyMonths: null,
      on: d("2026-06-15"),
    });
    expect(w.covered).toBe(null);
  });

  it("süresi geçmiş garanti kaç gün geçtiğini söyler", () => {
    const w = warrantyStatus({
      shippedAt: d("2023-01-15"),
      warrantyMonths: 24,
      on: d("2026-06-15"),
    });
    expect(w.covered).toBe(false);
    expect(w.explanation).toContain("gün önce");
  });
});

// ─────────────── İşten çıkış ───────────────

describe("işten çıkış hesabı", () => {
  it("İHBAR SÜRESİ KIDEME GÖRE DEĞİŞİR — md. 17", () => {
    expect(noticeWeeks(3)).toBe(2);
    expect(noticeWeeks(12)).toBe(4);
    expect(noticeWeeks(24)).toBe(6);
    expect(noticeWeeks(48)).toBe(8);
  });

  it("İSTİFA KIDEM KAZANDIRMAZ", () => {
    expect(earnsSeverance("isci_istifasi", 5)).toBe(false);
    expect(earnsSeverance("isveren_feshi", 5)).toBe(true);
  });

  it("ASKERLİK, EVLİLİK VE EMEKLİLİK İSTİSNADIR", () => {
    // Bu istisnaları bilmeyen bir sistem, hakkı olan çalışana
    // "hakkın yok" der.
    expect(earnsSeverance("askerlik", 3)).toBe(true);
    expect(earnsSeverance("evlilik", 3)).toBe(true);
    expect(earnsSeverance("emeklilik", 3)).toBe(true);
  });

  it("bir yılı doldurmayan kıdem alamaz", () => {
    expect(earnsSeverance("isveren_feshi", 0)).toBe(false);
  });

  it("HAKLI FESİHTE İHBAR ÖDENMEZ", () => {
    expect(employerOwesNotice("isveren_hakli_fesih")).toBe(false);
    expect(employerOwesNotice("isci_istifasi")).toBe(false);
    expect(employerOwesNotice("isveren_feshi")).toBe(true);
  });

  it("kıdem, ihbar ve izin birlikte hesaplanır", () => {
    const r = draftTermination({
      hiredAt: d("2020-06-15"),
      terminatedAt: d("2026-06-15"),
      reason: "isveren_feshi",
      dailyGrossWage: 1_000,
      severanceCeilingPerYear: null,
      unusedLeaveDays: 8,
    });
    expect(r.seniorityYears).toBe(6);
    // 6 yıl × 30 gün × 1000 ≈ 180.000
    expect(r.severanceGross).toBeGreaterThan(179_000);
    expect(r.noticeWeeks).toBe(8);
    expect(r.noticeGross).toBe(56_000); // 8 hafta × 7 gün × 1000
    expect(r.unusedLeaveGross).toBe(8_000);
  });

  it("TAVAN UYGULANIR", () => {
    // Tavansız hesap, yüksek ücretlilerde kat kat fazla çıkar ve fazla
    // ödenen geri alınamaz.
    const r = draftTermination({
      hiredAt: d("2020-06-15"),
      terminatedAt: d("2026-06-15"),
      reason: "isveren_feshi",
      dailyGrossWage: 5_000,
      severanceCeilingPerYear: 50_000,
      unusedLeaveDays: 0,
    });
    expect(r.severanceCapped).toBe(true);
    expect(r.severanceGross).toBeLessThan(310_000);
  });

  it("TAVAN GİRİLMEZSE UYARIR", () => {
    const r = draftTermination({
      hiredAt: d("2020-06-15"),
      terminatedAt: d("2026-06-15"),
      reason: "isveren_feshi",
      dailyGrossWage: 5_000,
      severanceCeilingPerYear: null,
      unusedLeaveDays: 0,
    });
    expect(r.unknowns.some((u) => u.includes("TAVANI"))).toBe(true);
  });

  it("ÜCRET BİLİNMİYORSA TUTAR HESAPLANMAZ", () => {
    // Sıfır yazılsaydı bordroya sıfır geçer ve çalışan hakkını alamazdı.
    const r = draftTermination({
      hiredAt: d("2020-06-15"),
      terminatedAt: d("2026-06-15"),
      reason: "isveren_feshi",
      dailyGrossWage: null,
      severanceCeilingPerYear: null,
      unusedLeaveDays: 5,
    });
    expect(r.severanceGross).toBe(null);
    expect(r.totalGross).toBe(null);
    expect(r.unknowns[0]).toContain("HESAPLANAMADI");
  });

  it("HUKUKİ DAYANAK HER ZAMAN YAZILIR", () => {
    const r = draftTermination({
      hiredAt: d("2020-06-15"),
      terminatedAt: d("2026-06-15"),
      reason: "isci_istifasi",
      dailyGrossWage: 1_000,
      severanceCeilingPerYear: null,
      unusedLeaveDays: 0,
    });
    expect(r.legalBasis.join(" ")).toContain("md. 14");
    expect(r.legalBasis.join(" ")).toContain("md. 17");
    expect(r.earnsSeverance).toBe(false);
  });

  it("çıkış tarihi girişten önce olamaz", () => {
    expect(() =>
      draftTermination({
        hiredAt: d("2026-06-15"),
        terminatedAt: d("2020-06-15"),
        reason: "isveren_feshi",
        dailyGrossWage: 1_000,
        severanceCeilingPerYear: null,
        unusedLeaveDays: 0,
      }),
    ).toThrow(/önce olamaz/);
  });
});
