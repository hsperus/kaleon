/**
 * Kredi limiti ve teslim tarihi taahhüdü.
 *
 * İKİ MODÜL, TEK PRENSİP: bilinmeyeni uydurmamak. Kredi tarafında
 * "limit yok" sonsuz sayılmıyor; ATP tarafında temin süresi
 * bilinmiyorsa tarih verilmiyor. İkisinde de sessiz bir varsayılan,
 * imzalanmış bir sözleşmeye dönüşürdü.
 */

import { describe, expect, it } from "vitest";
import { buildExposure, checkCredit } from "../src/modules/sales/credit.js";
import {
  checkAvailability,
  checkOrderAvailability,
  type StockPosition,
} from "../src/modules/sales/availability.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const BUGUN = d("2026-08-31");

function risk(o: Partial<Parameters<typeof buildExposure>[0]> = {}) {
  return buildExposure({
    partnerId: "c1",
    partnerName: "Kuehne + Nagel",
    currency: "TRY",
    overdue: 0,
    openInvoices: 200_000,
    openOrders: 0,
    limit: 1_000_000,
    blocked: false,
    blockReason: null,
    ...o,
  });
}

describe("kredi riski", () => {
  it("RİSK ÜÇ PARÇADAN OLUŞUR", () => {
    const r = risk({ overdue: 50_000, openInvoices: 200_000, openOrders: 300_000 });
    expect(r.total).toBe(550_000);
    expect(r.headroom).toBe(450_000);
  });

  it("SEVK EDİLMEMİŞ SİPARİŞ DE RİSKTİR", () => {
    /*
     * Yalnızca faturaya bakan bir kontrol, aynı müşteriye arka arkaya
     * beş sipariş açtırır: hiçbiri faturalanmadığı için risk "sıfır"
     * görünür ve limit ancak mallar gittikten sonra dolar.
     */
    const r = risk({ openInvoices: 0, openOrders: 900_000 });
    expect(r.total).toBe(900_000);
    expect(checkCredit(r, 200_000).decision).toBe("block");
  });

  it("limit içinde kalan sipariş geçer", () => {
    expect(checkCredit(risk(), 300_000).decision).toBe("ok");
  });

  it("limiti aşan sipariş ENGELLENİR, uyarılmaz", () => {
    const c = checkCredit(risk(), 900_000);
    expect(c.decision).toBe("block");
    expect(c.projectedTotal).toBe(1_100_000);
    expect(c.reason).toContain("Aşım 100000");
  });

  it("%90'ı geçen sipariş UYARIR ama geçer", () => {
    const c = checkCredit(risk(), 750_000);
    expect(c.decision).toBe("warn");
    expect(c.reason).toContain("dolmak üzere");
  });

  it("LİMİT YOKSA 'SINIRSIZ' DEĞİL 'BELİRSİZ'", () => {
    // Sonsuz saymak kontrolü anlamsız kılar, sıfır saymak her
    // siparişi bloke eder. İkisi de sessiz bir varsayılandır.
    const c = checkCredit(risk({ limit: null }), 5_000_000);
    expect(c.decision).toBe("warn");
    expect(c.exposure.headroom).toBeNull();
    expect(c.reason).toContain("BELİRLENMEMİŞ");
  });

  it("ELLE KONAN BLOK LİMİTTEN ÖNCE GELİR", () => {
    // Limiti bomboş ama bloklu bir cariye satış yapılmamalı.
    const c = checkCredit(
      risk({ openInvoices: 0, blocked: true, blockReason: "Hukuki takip" }),
      1_000,
    );
    expect(c.decision).toBe("block");
    expect(c.reason).toContain("Hukuki takip");
  });

  it("aşım mesajı vadesi geçmiş kısmı ayrıca söyler", () => {
    const c = checkCredit(risk({ overdue: 400_000, openInvoices: 700_000 }), 100_000);
    expect(c.decision).toBe("block");
    expect(c.reason).toContain("VADESİ GEÇMİŞ");
  });
});

function stok(o: Partial<StockPosition> = {}): StockPosition {
  return { itemCode: "FR-22", onHand: 200, committed: 0, inbound: [], leadTimeDays: null, ...o };
}

describe("teslim tarihi taahhüdü", () => {
  it("serbest stok yetiyorsa BUGÜN", () => {
    const r = checkAvailability(BUGUN, 150, stok());
    expect(r.earliestDate).toBe("2026-08-31");
    expect(r.basis).toBe("stock");
  });

  it("ELDEKİ STOK SERBEST STOK DEĞİLDİR", () => {
    /*
     * Depodaki 200'ün 180'i başka siparişlere ayrılmışsa yeni
     * müşteriye söylenebilecek miktar 20'dir. Bu ayrımı yapmayan bir
     * ATP aynı stoğu iki müşteriye söz verir.
     */
    const r = checkAvailability(BUGUN, 150, stok({ committed: 180, leadTimeDays: 10 }));
    expect(r.availableNow).toBe(20);
    expect(r.basis).toBe("lead-time");
  });

  it("yoldaki mal açığı kapatıyorsa O TARİH verilir", () => {
    const r = checkAvailability(
      BUGUN,
      300,
      stok({ inbound: [{ date: d("2026-09-10"), quantity: 150 }] }),
    );
    expect(r.earliestDate).toBe("2026-09-10");
    expect(r.basis).toBe("inbound");
  });

  it("yoldaki mallar BİRİKİMLİ sayılır", () => {
    const r = checkAvailability(
      BUGUN,
      400,
      stok({
        inbound: [
          { date: d("2026-09-10"), quantity: 100 },
          { date: d("2026-09-20"), quantity: 150 },
        ],
      }),
    );
    // 200 + 100 = 300 yetmez; 200 + 100 + 150 = 450 yeter.
    expect(r.earliestDate).toBe("2026-09-20");
  });

  it("TEMİN SÜRESİ BİLİNMİYORSA TARİH VERİLMEZ", () => {
    /*
     * Bu modülün var olma sebebi. "Tahminen üç hafta" demek bir
     * taahhüttür ve sözleşme cezasına bağlanır.
     */
    const r = checkAvailability(BUGUN, 500, stok());
    expect(r.earliestDate).toBeNull();
    expect(r.basis).toBe("unknown");
    expect(r.missing).toBe("temin süresi");
    expect(r.explanation).toContain("SÖYLENEMEZ");
  });

  it("temin süresi varsa tarih hesaplanır ve VARSAYIMI söylenir", () => {
    const r = checkAvailability(BUGUN, 500, stok({ leadTimeDays: 21 }));
    expect(r.earliestDate).toBe("2026-09-21");
    expect(r.basis).toBe("lead-time");
    expect(r.explanation).toContain("henüz sipariş açılmadı");
  });

  it("aşırı taahhüt edilmiş stokta serbest miktar sıfırdır, negatif değil", () => {
    const r = checkAvailability(BUGUN, 10, stok({ onHand: 100, committed: 140, leadTimeDays: 5 }));
    expect(r.availableNow).toBe(0);
  });
});

describe("çok kalemli sipariş", () => {
  it("EN GEÇ KALEM TARİHİ BELİRLER", () => {
    const r = checkOrderAvailability(BUGUN, [
      { itemCode: "A", quantity: 10, stock: stok({ itemCode: "A" }) },
      { itemCode: "B", quantity: 500, stock: stok({ itemCode: "B", leadTimeDays: 30 }) },
    ]);
    expect(r.earliestDate).toBe("2026-09-30");
    expect(r.bottleneck).toBe("B");
  });

  it("BİR KALEM BİLİNMİYORSA SİPARİŞİN TARİHİ DE BİLİNMİYORDUR", () => {
    // Dokuz kalemin sekizinin hazır olması hiçbir şey ifade etmez.
    const r = checkOrderAvailability(BUGUN, [
      { itemCode: "A", quantity: 10, stock: stok({ itemCode: "A" }) },
      { itemCode: "B", quantity: 500, stock: stok({ itemCode: "B" }) },
    ]);
    expect(r.earliestDate).toBeNull();
    expect(r.unknownItems).toEqual(["B"]);
  });

  it("dayanak EN ZAYIF halkaya göre bildirilir", () => {
    const r = checkOrderAvailability(BUGUN, [
      { itemCode: "A", quantity: 10, stock: stok({ itemCode: "A" }) },
      {
        itemCode: "B",
        quantity: 250,
        stock: stok({ itemCode: "B", inbound: [{ date: d("2026-09-05"), quantity: 100 }] }),
      },
    ]);
    expect(r.basis).toBe("inbound");
  });
});
