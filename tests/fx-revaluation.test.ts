/**
 * Dönem sonu kur değerlemesi.
 *
 * Asıl iddia: DÖVİZLİ BAKİYE DÖNEM SONUNDA GERÇEK DEĞERİNİ GÖSTERİR.
 * İhracatçı bir firmada kur farkı çoğu zaman esas faaliyet kârından
 * büyüktür; değerlenmemiş bir bilanço milyonlarca lira eksik gösterir.
 *
 * Testlerin çoğu "yanlış hesaplamasın" değil, "SESSİZCE yanlış
 * hesaplamasın" üzerine: kuru bulunamayan bir satırı atlamak, hatalı
 * bir toplamı doğru gibi sunmaktır.
 */

import { describe, expect, it } from "vitest";
import {
  RevaluationError,
  revalue,
  revaluationEntry,
  type OpenFxBalance,
} from "../src/modules/finance/revaluation.js";
import type { RateQuote } from "../src/modules/finance/exchange.js";

const ASOF = new Date("2026-12-31T00:00:00.000Z");

function quote(currency: string, rate: number): RateQuote {
  return { currency, rate, quotedAt: "2026-12-31", ageDays: 0, source: "TCMB" };
}

/** 10.000 EUR alacak, Ocak'ta 38 kurdan yazılmış. */
const ALACAK: OpenFxBalance = {
  accountCode: "120",
  partnerId: "p1",
  partnerName: "Daimler AG",
  currency: "EUR",
  fxBalance: 10_000,
  bookBalance: 380_000,
};

/** 5.000 USD borç, 32 kurdan yazılmış. */
const BORC: OpenFxBalance = {
  accountCode: "320",
  partnerId: "p2",
  partnerName: "Bosch",
  currency: "USD",
  fxBalance: -5_000,
  bookBalance: -160_000,
};

describe("kur değerlemesi", () => {
  describe("hesap", () => {
    it("ALACAK KUR YÜKSELİNCE ARTAR — fark kâr yazılır", () => {
      const r = revalue([ALACAK], { EUR: quote("EUR", 46) }, ASOF);

      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]!.currentValue).toBe(460_000);
      expect(r.lines[0]!.difference).toBe(80_000);
      expect(r.gain).toBe(80_000);
      expect(r.loss).toBe(0);
      expect(r.difference).toBe(80_000);
    });

    it("BORÇ KUR YÜKSELİNCE BÜYÜR — fark zarar yazılır", () => {
      const r = revalue([BORC], { USD: quote("USD", 42) }, ASOF);

      // 5.000 × 42 = 210.000 borç; defterde 160.000. 50.000 daha borçluyuz.
      expect(r.lines[0]!.currentValue).toBe(-210_000);
      expect(r.lines[0]!.difference).toBe(-50_000);
      expect(r.loss).toBe(50_000);
      expect(r.gain).toBe(0);
    });

    it("KÂR VE ZARAR NETLEŞTİRİLMEZ — ikisi de ayrı görünür", () => {
      const r = revalue([ALACAK, BORC], { EUR: quote("EUR", 46), USD: quote("USD", 42) }, ASOF);

      expect(r.gain).toBe(80_000);
      expect(r.loss).toBe(50_000);
      expect(r.difference).toBe(30_000);
    });

    it("KUR DÜŞERSE ALACAK ERİR — yön simetriktir", () => {
      const r = revalue([ALACAK], { EUR: quote("EUR", 35) }, ASOF);
      expect(r.lines[0]!.difference).toBe(-30_000);
      expect(r.loss).toBe(30_000);
    });

    it("kuruş taşması yuvarlanır", () => {
      const b: OpenFxBalance = { ...ALACAK, fxBalance: 1_000, bookBalance: 38_000 };
      const r = revalue([b], { EUR: quote("EUR", 46.1234) }, ASOF);
      // 1000 × 46.1234 = 46123.40 — kayan noktalı çarpımda 46123.399999
      expect(r.lines[0]!.currentValue).toBe(46_123.4);
      expect(r.lines[0]!.difference).toBe(8_123.4);
    });
  });

  describe("sessizce yanlış hesaplamama", () => {
    it("KUR YOKSA DEĞERLEME YAPILMAZ — atlanmaz, HATA verir", () => {
      // Atlansaydı toplam 80.000 çıkar ve doğru görünürdü; oysa GBP
      // bakiyesi hiç değerlenmemiş olurdu.
      const gbp: OpenFxBalance = { ...ALACAK, partnerId: "p3", currency: "GBP", fxBalance: 4_000 };
      expect(() => revalue([ALACAK, gbp], { EUR: quote("EUR", 46) }, ASOF)).toThrow(
        RevaluationError,
      );
    });

    it("eksik kur hatası HANGİ para birimi olduğunu söyler", () => {
      const gbp: OpenFxBalance = { ...ALACAK, currency: "GBP" };
      const chf: OpenFxBalance = { ...ALACAK, currency: "CHF" };
      try {
        revalue([gbp, chf], {}, ASOF);
        expect.unreachable("hata bekleniyordu");
      } catch (e) {
        expect((e as Error).message).toContain("CHF");
        expect((e as Error).message).toContain("GBP");
        expect((e as Error).message).toContain("2026-12-31");
      }
    });

    it("TL BAKİYE DEĞERLENMEZ — kendi kuru yoktur", () => {
      const tl: OpenFxBalance = { ...ALACAK, currency: "TRY", fxBalance: 500_000, bookBalance: 500_000 };
      const r = revalue([tl], {}, ASOF);
      expect(r.lines).toHaveLength(0);
      expect(r.difference).toBe(0);
    });

    it("KAPANMIŞ BAKİYE DEĞERLENMEZ — risk taşımıyor", () => {
      const kapali: OpenFxBalance = { ...ALACAK, fxBalance: 0, bookBalance: 0 };
      const r = revalue([kapali], { EUR: quote("EUR", 46) }, ASOF);
      expect(r.lines).toHaveLength(0);
    });

    it("KULLANILAN KURLAR KAYDA GEÇER — denetimde sorulur", () => {
      const r = revalue([ALACAK], { EUR: quote("EUR", 46) }, ASOF);
      expect(r.rates["EUR"]).toEqual({ rate: 46, quotedAt: "2026-12-31" });
    });
  });

  describe("yevmiye fişi", () => {
    it("FİŞ DENKTİR — borç ve alacak eşit", () => {
      const r = revalue([ALACAK, BORC], { EUR: quote("EUR", 46), USD: quote("USD", 42) }, ASOF);
      const lines = revaluationEntry(r);

      const debit = lines.reduce((s, l) => s + l.debit, 0);
      const credit = lines.reduce((s, l) => s + l.credit, 0);
      expect(debit).toBe(credit);
      expect(debit).toBeGreaterThan(0);
    });

    it("ALACAK FARKI 120 (B) / 646 (A) YAZAR", () => {
      const lines = revaluationEntry(revalue([ALACAK], { EUR: quote("EUR", 46) }, ASOF));

      const cari = lines.find((l) => l.accountCode === "120")!;
      expect(cari.debit).toBe(80_000);
      expect(cari.partnerId).toBe("p1");

      const kar = lines.find((l) => l.accountCode === "646")!;
      expect(kar.credit).toBe(80_000);
      // Kambiyo kârının cari kırılımı yoktur.
      expect(kar.partnerId).toBeNull();
    });

    it("BORÇ FARKI 656 (B) / 320 (A) YAZAR", () => {
      const lines = revaluationEntry(revalue([BORC], { USD: quote("USD", 42) }, ASOF));

      expect(lines.find((l) => l.accountCode === "320")!.credit).toBe(50_000);
      expect(lines.find((l) => l.accountCode === "656")!.debit).toBe(50_000);
    });

    it("KÂR VE ZARAR AYRI SATIRDA — gelir tablosunda karışmasın", () => {
      const lines = revaluationEntry(
        revalue([ALACAK, BORC], { EUR: quote("EUR", 46), USD: quote("USD", 42) }, ASOF),
      );
      expect(lines.filter((l) => l.accountCode === "646")).toHaveLength(1);
      expect(lines.filter((l) => l.accountCode === "656")).toHaveLength(1);
    });

    it("CARİ FARKI CARİ BAZINDA YAZILIR — ekstre mizanı tutsun", () => {
      const ikinci: OpenFxBalance = { ...ALACAK, partnerId: "p9", partnerName: "MAN" };
      const lines = revaluationEntry(revalue([ALACAK, ikinci], { EUR: quote("EUR", 46) }, ASOF));

      const cariler = lines.filter((l) => l.accountCode === "120");
      expect(cariler.map((l) => l.partnerId).sort()).toEqual(["p1", "p9"]);
    });

    it("FARK SIFIRSA SATIR YAZILMAZ — defter şişmesin", () => {
      // Kur değişmemiş: 380.000 / 10.000 = 38.
      const r = revalue([ALACAK], { EUR: quote("EUR", 38) }, ASOF);
      expect(r.lines).toHaveLength(1); // listede görünür
      expect(revaluationEntry(r)).toHaveLength(0); // fişte yok
    });

    it("SATIR AÇIKLAMASI KURU VE TUTARI TAŞIR — denetim izi", () => {
      const lines = revaluationEntry(revalue([ALACAK], { EUR: quote("EUR", 46) }, ASOF));
      const cari = lines.find((l) => l.accountCode === "120")!;
      expect(cari.description).toContain("Daimler AG");
      expect(cari.description).toContain("EUR");
      expect(cari.description).toContain("46");
      expect(cari.description).toContain("2026-12-31");
    });
  });
});
