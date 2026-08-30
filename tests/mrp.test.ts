/**
 * Malzeme İhtiyaç Planlaması.
 *
 * MRP'nin sessiz hatası şudur: plan üretir, plan makul görünür, ama bir
 * kademe eksik hesaplanmıştır ve üretimin ortasında malzeme biter.
 * Buradaki testler o kademeleri tek tek zorluyor — özellikle aynı
 * malzemenin iki farklı seviyede kullanıldığı durumu.
 */

import { describe, expect, it } from "vitest";
import {
  componentRequirement,
  lowLevelCodes,
  netRequirement,
  runMrp,
  MrpError,
  MAX_BOM_LEVEL,
  type ItemPlanningData,
} from "../src/modules/planning/mrp.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function item(over: Partial<ItemPlanningData> & { code: string }): ItemPlanningData {
  return {
    type: "mamul",
    procurementType: "uretim",
    leadTimeDays: 0,
    safetyStock: null,
    onHand: 0,
    components: [],
    ...over,
  };
}

const map = (...xs: ItemPlanningData[]) => new Map(xs.map((x) => [x.code, x]));

describe("net ihtiyaç", () => {
  it("eldeki ve yoldaki düşülür", () => {
    expect(netRequirement({ gross: 100, onHand: 30, scheduled: 20, safetyStock: null })).toBe(50);
  });

  it("EMNİYET STOĞU İHTİYACA EKLENİR", () => {
    // 100 lazım, 30 var, 20 emniyet → 20'yi hiç kullanmadan 90 almak gerekir.
    expect(netRequirement({ gross: 100, onHand: 30, scheduled: 0, safetyStock: 20 })).toBe(90);
  });

  it("yeterli stok varsa ihtiyaç doğmaz", () => {
    expect(netRequirement({ gross: 50, onHand: 80, scheduled: 0, safetyStock: null })).toBe(0);
  });

  it("İHTİYAÇ NEGATİF OLMAZ", () => {
    expect(netRequirement({ gross: 10, onHand: 500, scheduled: 0, safetyStock: null })).toBe(0);
  });
});

describe("bileşen ihtiyacı", () => {
  it("FİRE HESABA KATILIR", () => {
    // Katılmasaydı üretimin ortasında malzeme biterdi.
    expect(
      componentRequirement(100, { componentCode: "x", quantityPer: 1, scrapPercent: 2 }),
    ).toBe(102);
  });

  it("çoklu bileşen çarpılır", () => {
    expect(
      componentRequirement(50, { componentCode: "x", quantityPer: 4, scrapPercent: 0 }),
    ).toBe(200);
  });
});

describe("düşük seviye kodu", () => {
  it("kademeler doğru numaralanır", () => {
    const items = map(
      item({ code: "MAMUL", components: [{ componentCode: "YARI", quantityPer: 1, scrapPercent: 0 }] }),
      item({ code: "YARI", components: [{ componentCode: "HM", quantityPer: 2, scrapPercent: 0 }] }),
      item({ code: "HM", procurementType: "satin_alma" }),
    );
    const codes = lowLevelCodes(items);
    expect(codes.get("MAMUL")).toBe(0);
    expect(codes.get("YARI")).toBe(1);
    expect(codes.get("HM")).toBe(2);
  });

  it("AYNI MALZEME İKİ SEVİYEDEYSE EN DERİNİ ALINIR", () => {
    // Vida hem mamulde hem yarı mamulde geçiyor. Sığ seviye alınsaydı
    // vidanın ihtiyacı, yarı mamulün hesabı bitmeden toplanır ve
    // eksik çıkardı.
    const items = map(
      item({
        code: "MAMUL",
        components: [
          { componentCode: "YARI", quantityPer: 1, scrapPercent: 0 },
          { componentCode: "VIDA", quantityPer: 4, scrapPercent: 0 },
        ],
      }),
      item({ code: "YARI", components: [{ componentCode: "VIDA", quantityPer: 2, scrapPercent: 0 }] }),
      item({ code: "VIDA", procurementType: "satin_alma" }),
    );
    expect(lowLevelCodes(items).get("VIDA")).toBe(2);
  });

  it("DÖNGÜSEL AĞAÇ YAKALANIR", () => {
    const items = map(
      item({ code: "A", components: [{ componentCode: "B", quantityPer: 1, scrapPercent: 0 }] }),
      item({ code: "B", components: [{ componentCode: "A", quantityPer: 1, scrapPercent: 0 }] }),
    );
    expect(() => lowLevelCodes(items)).toThrow(MrpError);
    expect(() => lowLevelCodes(items)).toThrow(/DÖNGÜSEL/);
  });

  it("kendi bileşeni olan malzeme reddedilir", () => {
    const items = map(
      item({ code: "A", components: [{ componentCode: "A", quantityPer: 1, scrapPercent: 0 }] }),
    );
    expect(() => lowLevelCodes(items)).toThrow(/DÖNGÜSEL/);
  });

  it(`ağaç ${MAX_BOM_LEVEL} kademeyi aşamaz`, () => {
    const items = new Map<string, ItemPlanningData>();
    for (let i = 0; i < MAX_BOM_LEVEL + 3; i += 1) {
      items.set(
        `L${i}`,
        item({
          code: `L${i}`,
          components: [{ componentCode: `L${i + 1}`, quantityPer: 1, scrapPercent: 0 }],
        }),
      );
    }
    expect(() => lowLevelCodes(items)).toThrow(MrpError);
  });
});

describe("MRP çalıştırma", () => {
  const items = map(
    item({
      code: "MM-500",
      procurementType: "uretim",
      leadTimeDays: 5,
      components: [
        { componentCode: "YM-200", quantityPer: 1, scrapPercent: 0 },
        { componentCode: "SF-001", quantityPer: 4, scrapPercent: 5 },
      ],
    }),
    item({
      code: "YM-200",
      procurementType: "uretim",
      leadTimeDays: 3,
      components: [{ componentCode: "HM-100", quantityPer: 2, scrapPercent: 0 }],
    }),
    item({ code: "HM-100", procurementType: "satin_alma", leadTimeDays: 21 }),
    item({ code: "SF-001", procurementType: "satin_alma", leadTimeDays: 7 }),
  );

  const demand = [
    { itemCode: "MM-500", quantity: 100, neededBy: d("2026-08-01"), source: "SO-1" },
  ];

  it("KADEME KADEME PATLAR", () => {
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-06-01") });
    const byCode = new Map(r.plannedOrders.map((p) => [p.itemCode, p]));

    expect(byCode.get("MM-500")!.quantity).toBe(100);
    expect(byCode.get("YM-200")!.quantity).toBe(100);
    // 100 mamul × 2 hammadde = 200
    expect(byCode.get("HM-100")!.quantity).toBe(200);
    // 100 × 4 vida × %5 fire = 420
    expect(byCode.get("SF-001")!.quantity).toBe(420);
  });

  it("BİLEŞEN İHTİYACI ÜST KALEMİN BAŞLAMA TARİHİNDE DOĞAR", () => {
    // Bitiş tarihi alınsaydı hammadde üretim bittikten sonra gelirdi.
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-06-01") });
    const byCode = new Map(r.plannedOrders.map((p) => [p.itemCode, p]));

    // Mamul 1 Ağustos'ta hazır olmalı, 5 gün üretim → 27 Temmuz başlar.
    expect(byCode.get("MM-500")!.startDate).toBe("2026-07-27");
    // Yarı mamul o gün hazır olmalı, 3 gün → 24 Temmuz başlar.
    expect(byCode.get("YM-200")!.dueDate).toBe("2026-07-27");
    expect(byCode.get("YM-200")!.startDate).toBe("2026-07-24");
    // Hammadde 24 Temmuz'da hazır olmalı, 21 gün tedarik → 3 Temmuz sipariş.
    expect(byCode.get("HM-100")!.dueDate).toBe("2026-07-24");
    expect(byCode.get("HM-100")!.startDate).toBe("2026-07-03");
  });

  it("ELDEKİ STOK İHTİYACI DÜŞÜRÜR VE AĞACA YANSIR", () => {
    const withStock = new Map(items);
    withStock.set("YM-200", { ...items.get("YM-200")!, onHand: 40 });
    const r = runMrp({ items: withStock, demands: demand, scheduled: [], today: d("2026-06-01") });
    const byCode = new Map(r.plannedOrders.map((p) => [p.itemCode, p]));

    expect(byCode.get("YM-200")!.quantity).toBe(60);
    // Yarı mamulün ihtiyacı düşünce hammadde de düşer: 60 × 2 = 120.
    expect(byCode.get("HM-100")!.quantity).toBe(120);
  });

  it("YETERLİ STOK VARSA PLANLI SİPARİŞ ÜRETİLMEZ", () => {
    const withStock = new Map(items);
    withStock.set("MM-500", { ...items.get("MM-500")!, onHand: 150 });
    const r = runMrp({ items: withStock, demands: demand, scheduled: [], today: d("2026-06-01") });
    expect(r.plannedOrders).toEqual([]);
  });

  it("YOLDAKİ SİPARİŞ İHTİYACI DÜŞÜRÜR", () => {
    const r = runMrp({
      items,
      demands: demand,
      scheduled: [
        { itemCode: "HM-100", quantity: 150, expectedAt: d("2026-07-01"), source: "SAT-1" },
      ],
      today: d("2026-06-01"),
    });
    expect(r.plannedOrders.find((p) => p.itemCode === "HM-100")!.quantity).toBe(50);
  });

  it("GEÇ KALANLAR AYRI LİSTELENİR — gömülmez", () => {
    // 20 Temmuz'da çalıştırılırsa hammadde siparişi 3 Temmuz'da verilmiş
    // olmalıydı; 17 gün geç kalınmış demektir.
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-07-20") });
    expect(r.late.length).toBeGreaterThan(0);
    const hm = r.late.find((p) => p.itemCode === "HM-100")!;
    expect(hm.lateByDays).toBe(17);
    expect(r.caveats.some((c) => c.includes("zamanında yetişmeyecek"))).toBe(true);
  });

  it("zamanında olan plan geç listesine girmez", () => {
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-06-01") });
    expect(r.late).toEqual([]);
  });

  it("TEDARİK SÜRESİ BİLİNMİYORSA SÖYLENİR", () => {
    // Sıfır kabul etmek "aynı gün gelir" demektir ve plan yalan söyler.
    const unknown = new Map(items);
    unknown.set("HM-100", { ...items.get("HM-100")!, leadTimeDays: null });
    const r = runMrp({ items: unknown, demands: demand, scheduled: [], today: d("2026-06-01") });
    expect(r.caveats.some((c) => c.includes("tedarik süresi girilmemiş"))).toBe(true);
    expect(r.plannedOrders.find((p) => p.itemCode === "HM-100")!.leadTimeKnown).toBe(false);
  });

  it("MALZEME KARTI OLMAYAN TALEP SESSİZCE ATLANMAZ", () => {
    const r = runMrp({
      items,
      demands: [{ itemCode: "YOK-1", quantity: 5, neededBy: d("2026-08-01"), source: "SO-9" }],
      scheduled: [],
      today: d("2026-06-01"),
    });
    expect(r.plannedOrders).toEqual([]);
    expect(r.caveats[0]).toContain("PLANA GİRMEDİ");
  });

  it("AYNI MALZEMEYE İKİ TALEP TOPLANIR, EN ERKEN TARİH ALINIR", () => {
    // En geç tarih alınsaydı ilk sipariş geç kalırdı.
    const r = runMrp({
      items,
      demands: [
        { itemCode: "MM-500", quantity: 60, neededBy: d("2026-09-01"), source: "SO-2" },
        { itemCode: "MM-500", quantity: 40, neededBy: d("2026-08-01"), source: "SO-1" },
      ],
      scheduled: [],
      today: d("2026-06-01"),
    });
    const mm = r.plannedOrders.find((p) => p.itemCode === "MM-500")!;
    expect(mm.quantity).toBe(100);
    expect(mm.dueDate).toBe("2026-08-01");
    expect(mm.drivenBy).toContain("SO-1");
  });

  it("satın alınan ve üretilen ayrı işaretlenir", () => {
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-06-01") });
    const byCode = new Map(r.plannedOrders.map((p) => [p.itemCode, p]));
    expect(byCode.get("MM-500")!.kind).toBe("uretim");
    expect(byCode.get("HM-100")!.kind).toBe("satin_alma");
  });

  it("plan seviyeye göre sıralanır — önce üst kalem", () => {
    const r = runMrp({ items, demands: demand, scheduled: [], today: d("2026-06-01") });
    expect(r.plannedOrders.map((p) => p.level)).toEqual([...r.plannedOrders.map((p) => p.level)].sort());
  });

  it("emniyet stoğu ağaca yansır", () => {
    const withSafety = new Map(items);
    withSafety.set("HM-100", { ...items.get("HM-100")!, safetyStock: 100 });
    const r = runMrp({ items: withSafety, demands: demand, scheduled: [], today: d("2026-06-01") });
    expect(r.plannedOrders.find((p) => p.itemCode === "HM-100")!.quantity).toBe(300);
  });
});
