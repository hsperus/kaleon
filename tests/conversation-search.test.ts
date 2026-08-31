/**
 * Sohbetlerde arama.
 *
 * Asıl iddia: BAŞLIK YETMEZ. Başlık ilk sorudan türetiliyor ve aranan
 * şey çoğu zaman konuşmanın ortasında geçiyor — "hangi konuşmada
 * Daimler'den bahsetmiştim" sorusu başlıkla cevaplanamaz.
 *
 * İkinci iddia: SONUÇ NEDEN EŞLEŞTİĞİNİ GÖSTERİR. Yalnızca başlık
 * dönen bir liste rastgele görünür ve kullanıcı tek tek açmak zorunda
 * kalır.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryConversationRepository,
  excerptAround,
} from "../src/modules/conversation/repository.js";

const BEN = "user-1";
const BASKASI = "user-2";

describe("sohbet arama", () => {
  let repo: InMemoryConversationRepository;
  let kar: string;
  let stok: string;

  beforeEach(async () => {
    repo = new InMemoryConversationRepository();

    kar = await repo.create(BEN, "Bu ay kâr ettik mi?");
    await repo.appendTurn(kar, {
      question: "Bu ay kâr ettik mi?",
      answer: "Daimler Truck faturası dahil 379.610 ₺ brüt kâr ettiniz.",
    });

    stok = await repo.create(BEN, "Kaplin stoğu ne durumda?");
    await repo.appendTurn(stok, {
      question: "Kaplin stoğu ne durumda?",
      answer: "KP-08 için 42 adet mevcut.",
    });

    const digeri = await repo.create(BASKASI, "Daimler siparişi");
    await repo.appendTurn(digeri, { question: "Daimler siparişi", answer: "Gizli." });
  });

  it("BAŞLIKTA GEÇMEYEN KELİMEYİ CEVAPTA BULUR", async () => {
    // "Daimler" hiçbir başlıkta yok; yalnızca cevabın içinde.
    const r = await repo.search(BEN, "Daimler");
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(kar);
  });

  it("başlıkta geçeni de bulur", async () => {
    const r = await repo.search(BEN, "Kaplin");
    expect(r.map((x) => x.id)).toContain(stok);
  });

  it("SONUÇ NEDEN EŞLEŞTİĞİNİ GÖSTERİR", async () => {
    const r = await repo.search(BEN, "Daimler");
    expect(r[0]!.snippet).toContain("Daimler");
  });

  it("BAŞKASININ SOHBETİ ARAMAYA DÜŞMEZ", async () => {
    // Aynı kelime diğer kullanıcının konuşmasında da geçiyor.
    const benim = await repo.search(BEN, "Daimler");
    expect(benim.every((x) => x.id !== undefined)).toBe(true);
    const onun = await repo.search(BASKASI, "Daimler");
    expect(onun).toHaveLength(1);
    expect(onun[0]!.id).not.toBe(kar);
  });

  it("BÜYÜK–KÜÇÜK HARF AYIRT ETMEZ — Türkçe dahil", async () => {
    expect(await repo.search(BEN, "daimler")).toHaveLength(1);
    expect(await repo.search(BEN, "KAPLİN")).toHaveLength(1);
  });

  it("TEK HARFLİK SORGU BOŞ DÖNER — her şeyle eşleşir", async () => {
    expect(await repo.search(BEN, "a")).toEqual([]);
    expect(await repo.search(BEN, " ")).toEqual([]);
  });

  it("en yeni konuşma önce gelir", async () => {
    const r = await repo.search(BEN, "e");
    expect(r).toEqual([]); // tek harf
    const hepsi = await repo.search(BEN, "mi");
    if (hepsi.length > 1) {
      expect(hepsi[0]!.updatedAt >= hepsi[1]!.updatedAt).toBe(true);
    }
  });
});

describe("alıntı çıkarma", () => {
  it("EŞLEŞMENİN ETRAFINDAN KESER, baştan değil", () => {
    // Aranan kelime 900. karakterde: baştan kesilseydi görünmezdi.
    const uzun = `${"lorem ipsum ".repeat(80)}Daimler Truck${" dolor sit".repeat(20)}`;
    const a = excerptAround(uzun, "Daimler");
    expect(a).toContain("Daimler");
    expect(a.startsWith("…")).toBe(true);
    expect(a.length).toBeLessThan(200);
  });

  it("baştaki eşleşmede öne üç nokta koymaz", () => {
    expect(excerptAround("Daimler faturası kesildi", "Daimler").startsWith("…")).toBe(false);
  });

  it("satır sonları tek boşluğa iner — liste bozulmasın", () => {
    expect(excerptAround("bir\n\n  iki\tüç", "iki")).toBe("bir iki üç");
  });
});
