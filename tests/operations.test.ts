/**
 * Üretim çekirdeği değişmezleri.
 *
 * Bu dosya KAELON'un SAP'den üstün olma iddiasının kanıtıdır. Klasik ERP'de
 * bu kuralların hepsi "vardır" ama bypass edilebilir. Burada bypass yolu yok;
 * override var, ve override görünür.
 */

import { describe, expect, it } from "vitest";
import { createPrincipal } from "../src/kernel/rbac.js";
import {
  allBalances,
  balanceOf,
  postMovement,
  type StockMovement,
} from "../src/modules/operations/stock-ledger.js";
import {
  completeWorkOrder,
  confirmOperation,
  createWorkOrder,
  nextAction,
  overrideGate,
  recordGateDecision,
  releaseWorkOrder,
  startOperation,
  type RoutingOperation,
} from "../src/modules/operations/work-order.js";

const T = "t-orthaus";
const patron = createPrincipal({ userId: "u-patron", tenantId: T, roles: ["patron"] });
const uretim = createPrincipal({ userId: "u-uretim", tenantId: T, roles: ["uretim_muduru"] });
const operator = createPrincipal({ userId: "u-op", tenantId: T, roles: ["operator"] });
const depo = createPrincipal({ userId: "u-depo", tenantId: T, roles: ["depo_sorumlusu"] });

const AT = "2026-05-16T08:00:00.000Z";
const KEY = { itemId: "ITEM-DINGIL", locationId: "DEPO-01", batchId: null };

function post(
  ledger: readonly StockMovement[],
  over: Partial<Parameters<typeof postMovement>[1]> & { movementType: string },
  authority = 2,
) {
  return postMovement(
    ledger,
    {
      id: `m-${ledger.length + 1}`,
      at: AT,
      itemId: KEY.itemId,
      locationId: KEY.locationId,
      quantity: 10,
      userId: "u-depo",
      reference: { kind: "purchase_order", id: "PO-1" },
      ...over,
    },
    { authority: authority as 0 | 1 | 2 | 3 },
  );
}

describe("Stok defteri — bakiye saklanmaz, türetilir", () => {
  it("mal kabul bakiyeyi artırır", () => {
    const l = post([], { movementType: "101", quantity: 200 });
    expect(balanceOf(l, KEY)).toBe(200);
  });

  it("NEGATİF STOK OLUŞAMAZ", () => {
    const l = post([], { movementType: "101", quantity: 50 });
    expect(() =>
      post(l, {
        movementType: "261",
        quantity: 80,
        reference: { kind: "work_order", id: "WO-1" },
      }),
    ).toThrow(/negatife düşürür/);
    // defter değişmedi
    expect(balanceOf(l, KEY)).toBe(50);
  });

  it("tipsiz hareket kaydedilemez", () => {
    expect(() => post([], { movementType: "999" })).toThrow(/Tanımsız hareket tipi/);
  });

  it("negatif veya sıfır miktar reddedilir — yön tipten gelir", () => {
    expect(() => post([], { movementType: "101", quantity: -5 })).toThrow(/pozitif olmalıdır/);
    expect(() => post([], { movementType: "101", quantity: 0 })).toThrow(/pozitif olmalıdır/);
  });

  it("belgesiz hareket kaydedilemez", () => {
    expect(() => post([], { movementType: "101", reference: null })).toThrow(
      /belgesine bağlanmak zorundadır/,
    );
    expect(() =>
      post([], { movementType: "261", reference: { kind: "purchase_order", id: "PO-1" } }),
    ).toThrow(/work_order belgesine/);
  });

  it("elle düzeltme gerekçesiz yapılamaz", () => {
    const l = post([], { movementType: "101", quantity: 100 });
    expect(() =>
      post(l, {
        movementType: "702",
        quantity: 5,
        reference: { kind: "count", id: "SAY-1" },
      }),
    ).toThrow(/gerekçe zorunludur/);

    const ok = post(l, {
      movementType: "702",
      quantity: 5,
      reference: { kind: "count", id: "SAY-1" },
      reason: "Sayımda 5 adet eksik çıktı, raf 3B",
    });
    expect(balanceOf(ok, KEY)).toBe(95);
  });

  it("düzeltme yetki ister — depo sorumlusu tek başına yapamaz", () => {
    const l = post([], { movementType: "101", quantity: 100 });
    expect(() =>
      post(
        l,
        {
          movementType: "702",
          quantity: 5,
          reference: { kind: "count", id: "SAY-1" },
          reason: "eksik",
        },
        1,
      ),
    ).toThrow(/L2 yetki gerekir/);
  });

  it("iptal silme değildir — ters hareket olarak kaydedilir", () => {
    const l1 = post([], { movementType: "101", quantity: 100 });
    const l2 = post(l1, { movementType: "102", quantity: 100, reversalOf: "m-1", reason: "Yanlış kalem" });
    expect(balanceOf(l2, KEY)).toBe(0);
    // asıl hareket hâlâ defterde
    expect(l2).toHaveLength(2);
    expect(l2[0]?.movementType).toBe("101");
  });

  it("aynı hareket iki kez iptal edilemez", () => {
    const l1 = post([], { movementType: "101", quantity: 100 });
    const l2 = post(l1, { movementType: "102", quantity: 100, reversalOf: "m-1", reason: "hata" });
    expect(() =>
      post(l2, { movementType: "102", quantity: 100, reversalOf: "m-1", reason: "tekrar" }),
    ).toThrow(/zaten iptal edilmiş/);
  });

  it("iptal aslından fazla olamaz ve tipi tutmalı", () => {
    const l1 = post([], { movementType: "101", quantity: 100 });
    expect(() =>
      post(l1, { movementType: "102", quantity: 150, reversalOf: "m-1", reason: "x" }),
    ).toThrow(/aslından büyük olamaz/);
    const l2 = post(l1, {
      movementType: "261",
      quantity: 10,
      reference: { kind: "work_order", id: "WO-1" },
    });
    expect(() =>
      post(l2, { movementType: "102", quantity: 5, reversalOf: "m-2", reason: "x" }),
    ).toThrow(/yalnızca 101 tipini iptal edebilir/);
  });

  it("iptal edilecek hareket yoksa reddedilir", () => {
    expect(() =>
      post([], { movementType: "102", quantity: 5, reversalOf: "yok", reason: "x" }),
    ).toThrow(/İptal edilecek hareket bulunamadı/);
  });

  it("bakiye lokasyon ve parti bazında ayrışır", () => {
    let l = post([], { movementType: "101", quantity: 100 });
    l = post(l, { movementType: "101", quantity: 40, locationId: "DEPO-02" });
    l = post(l, { movementType: "101", quantity: 25, batchId: "B-2401" });
    expect(balanceOf(l, KEY)).toBe(100);
    expect(balanceOf(l, { ...KEY, locationId: "DEPO-02" })).toBe(40);
    expect(balanceOf(l, { ...KEY, batchId: "B-2401" })).toBe(25);
    expect(allBalances(l)).toHaveLength(3);
  });
});

// ── Üretim rotası: kesim → kaynak (kapılı) → boya (kapılı) → montaj
const ROUTING: readonly RoutingOperation[] = [
  { seq: 10, workCenter: "KESIM", description: "Profil kesimi", gate: null },
  {
    seq: 20,
    workCenter: "KAYNAK",
    description: "Şasi kaynağı",
    gate: { characteristic: "Kaynak penetrasyonu", decidedBy: "quality:gate.release" },
  },
  {
    seq: 30,
    workCenter: "BOYA",
    description: "Boya",
    gate: {
      characteristic: "Boya kalınlığı",
      decidedBy: "quality:gate.release",
      tolerance: { min: 80, max: 120, unit: "µm" },
    },
  },
  { seq: 40, workCenter: "MONTAJ", description: "Montaj", gate: null },
];

function released() {
  const wo = createWorkOrder({ id: "WO-2026-0612", itemId: "FR-22", quantity: 10, routing: ROUTING });
  return releaseWorkOrder(wo, { activeBomRevision: "R3", at: AT, principal: uretim });
}

describe("İş emri — kalite kapısı atlanamaz", () => {
  it("serbest bırakılmadan operasyon başlatılamaz", () => {
    const wo = createWorkOrder({ id: "W1", itemId: "X", quantity: 1, routing: ROUTING });
    expect(() => startOperation(wo, 10)).toThrow(/serbest bırakın/);
  });

  it("KAPI GEÇMEDEN SONRAKİ OPERASYON BAŞLATILAMAZ", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    // 20 numaralı operasyon kalite kararı bekliyor
    expect(wo.operations.find((o) => o.seq === 20)?.state).toBe("gate_hold");

    expect(() => startOperation(wo, 30)).toThrow(/kalite kapısında bekliyor/);
    expect(() => startOperation(wo, 30)).toThrow(/quality_gate_blocked|kalite kapısı geçilmeden/);
  });

  it("kalite kapısından geçilince sonraki operasyon açılır", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    wo = recordGateDecision(wo, 20, { decision: "pass", principal: uretim, at: AT });
    expect(() => startOperation(wo, 30)).not.toThrow();
  });

  it("FAIL sonrası sonraki operasyon hâlâ kapalıdır", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    wo = recordGateDecision(wo, 20, {
      decision: "fail",
      principal: uretim,
      at: AT,
      reason: "Penetrasyon yetersiz, 3 numunede kök hatası",
    });
    expect(() => startOperation(wo, 30)).toThrow(/GEÇEMEDİ/);
  });

  it("PASS yetkisi olmayan kapıyı açamaz", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    // operatörün yalnızca quality:result.write izni var, gate.release yok
    expect(() =>
      recordGateDecision(wo, 20, { decision: "pass", principal: operator, at: AT }),
    ).toThrow(/PASS yetkisi olmayan/);
  });

  it("FAIL kararı gerekçesiz verilemez", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    expect(() =>
      recordGateDecision(wo, 20, { decision: "fail", principal: uretim, at: AT }),
    ).toThrow(/neden zorunludur/);
  });
});

describe("Ölçüm toleransı", () => {
  function atBoya() {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    wo = recordGateDecision(wo, 20, { decision: "pass", principal: uretim, at: AT });
    wo = startOperation(wo, 30);
    return confirmOperation(wo, 30, { confirmedQty: 10 });
  }

  it("tolerans tanımlıysa ölçüm zorunludur", () => {
    expect(() =>
      recordGateDecision(atBoya(), 30, { decision: "pass", principal: uretim, at: AT }),
    ).toThrow(/ölçüm değeri zorunludur/);
  });

  it("TOLERANS DIŞI ÖLÇÜMLE PASS VERİLEMEZ", () => {
    expect(() =>
      recordGateDecision(atBoya(), 30, {
        decision: "pass",
        principal: uretim,
        at: AT,
        measurement: 140,
      }),
    ).toThrow(/tolerans dışı/);
  });

  it("tolerans içi ölçümle PASS verilir ve ölçüm saklanır", () => {
    const wo = recordGateDecision(atBoya(), 30, {
      decision: "pass",
      principal: uretim,
      at: AT,
      measurement: 95,
    });
    const op = wo.operations.find((o) => o.seq === 30);
    expect(op?.state).toBe("gate_passed");
    expect(op?.gateDecision?.measurement).toBe(95);
    expect(op?.gateDecision?.overridden).toBe(false);
  });
});

describe("Override — yasak değil, görünür", () => {
  function held() {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    return confirmOperation(wo, 20, { confirmedQty: 10 });
  }

  it("L2 altı yetki kapı atlayamaz", () => {
    expect(() =>
      overrideGate(held(), 20, { principal: operator, at: AT, reason: "acele" }),
    ).toThrow(/L2 yetki gerektirir/);
  });

  it("gerekçesiz atlanamaz", () => {
    expect(() => overrideGate(held(), 20, { principal: patron, at: AT, reason: "  " })).toThrow(
      /gerekçe zorunludur/,
    );
  });

  it("atlanan kapı iş emrinde KALICI iz bırakır", () => {
    const wo = overrideGate(held(), 20, {
      principal: patron,
      at: AT,
      reason: "Volvo sevkiyatı kritik; müşteri sapma onayı e-posta ile alındı",
    });
    expect(wo.operations.find((o) => o.seq === 20)?.gateDecision?.overridden).toBe(true);
    expect(wo.overrideCount).toBe(1);
    // ve akış devam edebilir
    expect(() => startOperation(wo, 30)).not.toThrow();
  });
});

describe("BOM revizyon disiplini", () => {
  it("serbest bırakma revizyonu dondurur", () => {
    const wo = released();
    expect(wo.bomRevision).toBe("R3");
    expect(wo.bomFrozenAt).toBe(AT);
  });

  it("eski revizyonla açmak L2 yetki ister", () => {
    const wo = createWorkOrder({ id: "W2", itemId: "X", quantity: 1, routing: ROUTING });
    expect(() =>
      releaseWorkOrder(wo, {
        activeBomRevision: "R3",
        requestedRevision: "R2",
        at: AT,
        principal: operator,
        reason: "müşteri eski tip istedi",
      }),
    ).toThrow(/L2 yetki gerektirir/);
  });

  it("eski revizyonla açmak gerekçe ister", () => {
    const wo = createWorkOrder({ id: "W3", itemId: "X", quantity: 1, routing: ROUTING });
    expect(() =>
      releaseWorkOrder(wo, {
        activeBomRevision: "R3",
        requestedRevision: "R2",
        at: AT,
        principal: uretim,
      }),
    ).toThrow(/gerekçe zorunludur/);
  });

  it("yetki + gerekçe varsa eski revizyon kullanılabilir ve iz kalır", () => {
    const wo = createWorkOrder({ id: "W4", itemId: "X", quantity: 1, routing: ROUTING });
    const rel = releaseWorkOrder(wo, {
      activeBomRevision: "R3",
      requestedRevision: "R2",
      at: AT,
      principal: uretim,
      reason: "Volvo sözleşmesi R2 şartnamesine bağlı",
    });
    expect(rel.bomRevision).toBe("R2");
  });
});

describe("İş emri kapanışı ve sonraki adım", () => {
  it("eksik operasyonla kapatılamaz", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    expect(() => completeWorkOrder(wo)).toThrow(/operasyon tamamlanmadı/);
  });

  it("teyit + fire iş emri miktarını aşamaz", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    expect(() => confirmOperation(wo, 10, { confirmedQty: 9, scrapQty: 5 })).toThrow(
      /miktarını \(10\) aşamaz/,
    );
  });

  it("tam akış uçtan uca tamamlanır", () => {
    let wo = released();
    wo = startOperation(wo, 10);
    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    wo = recordGateDecision(wo, 20, { decision: "pass", principal: uretim, at: AT });
    wo = startOperation(wo, 30);
    wo = confirmOperation(wo, 30, { confirmedQty: 9, scrapQty: 1 });
    wo = recordGateDecision(wo, 30, { decision: "pass", principal: uretim, at: AT, measurement: 100 });
    wo = startOperation(wo, 40);
    wo = confirmOperation(wo, 40, { confirmedQty: 9 });
    wo = completeWorkOrder(wo);
    expect(wo.status).toBe("completed");
    expect(wo.overrideCount).toBe(0);
  });

  it("nextAction her durumda kullanıcıya ne yapacağını söyler", () => {
    const created = createWorkOrder({ id: "W9", itemId: "X", quantity: 1, routing: ROUTING });
    expect(nextAction(created)).toContain("serbest bırakılmalı");

    let wo = released();
    expect(nextAction(wo)).toContain("Sıradaki operasyon 10");

    wo = startOperation(wo, 10);
    expect(nextAction(wo)).toContain("çalışıyor");

    wo = confirmOperation(wo, 10, { confirmedQty: 10 });
    wo = startOperation(wo, 20);
    wo = confirmOperation(wo, 20, { confirmedQty: 10 });
    expect(nextAction(wo)).toContain("Kaynak penetrasyonu");
  });
});

describe("depo sorumlusu üretim kapısına dokunamaz", () => {
  it("stok hareketi yapabilir ama düzeltme yapamaz", () => {
    expect(depo.maxAuthority).toBe(1);
    const l = post([], { movementType: "101", quantity: 10 }, 1);
    expect(balanceOf(l, KEY)).toBe(10);
  });
});
