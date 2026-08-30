/**
 * Tablodan grafik çıkarma kararları.
 *
 * ZORLANMIŞ GRAFİK YALAN SÖYLER. Ara toplamı parçalarıyla yan yana
 * çizmek, TL ile EUR'yu tek eksene koymak ya da fatura numarasını
 * çubuk yapmak — üçü de teknik olarak "çalışır" ve üçü de yanlış
 * bilgi verir. Testler bu üç durumu hedefliyor.
 */

import { describe, expect, it } from "vitest";
import { parseBlocks } from "../src/ui/markdown.js";
import {
  isTotalRow,
  looksLikeIdentifier,
  looksLikeTimeSeries,
  planFrom,
  toNumber,
  unitOf,
} from "../src/ui/chart-from-table.js";

function table(md: string) {
  const b = parseBlocks(md).find((x) => x.kind === "table");
  if (!b || b.kind !== "table") throw new Error("tablo yok");
  return b;
}

describe("ara toplam satırı", () => {
  it("tanınır", () => {
    expect(isTotalRow(["Toplam", "100"])).toBe(true);
    expect(isTotalRow(["**TRY Toplam**", "100"])).toBe(true);
    expect(isTotalRow(["Genel toplam", "100"])).toBe(true);
    expect(isTotalRow(["EUR Toplam", "100"])).toBe(true);
  });

  it("normal satır ara toplam sayılmaz", () => {
    expect(isTotalRow(["Garanti BBVA", "100"])).toBe(false);
    // "Toplama" bir yer adı olabilir; kelime sınırı aranıyor.
    expect(isTotalRow(["Toplamacı Ltd.", "100"])).toBe(false);
  });
});

describe("kimlik sütunu", () => {
  it("ölçü olmayan sayısal sütunlar ayıklanır", () => {
    expect(looksLikeIdentifier("Fatura No")).toBe(true);
    expect(looksLikeIdentifier("VKN")).toBe(true);
    expect(looksLikeIdentifier("Hesap")).toBe(true);
    expect(looksLikeIdentifier("Tutar")).toBe(false);
    expect(looksLikeIdentifier("Miktar")).toBe(false);
  });
});

describe("zaman serisi", () => {
  it("ay adları tanınır", () => {
    expect(looksLikeTimeSeries(["Ocak", "Şubat", "Mart", "Nisan"])).toBe(true);
  });
  it("yıl-ay biçimi tanınır", () => {
    expect(looksLikeTimeSeries(["2026-01", "2026-02", "2026-03"])).toBe(true);
  });
  it("firma adları zaman serisi değildir", () => {
    expect(looksLikeTimeSeries(["Garanti", "İş Bankası", "Yapı Kredi"])).toBe(false);
  });
});

describe("birim", () => {
  it("hücreden okunur", () => {
    expect(unitOf("156.000 TL")).toBe("TL");
    expect(unitOf("2.400 EUR")).toBe("EUR");
    expect(unitOf("18 %")).toBe("%");
    expect(unitOf("12.400")).toBeNull();
  });
});

describe("sayıya çevirme", () => {
  it("kalın ve birimli değeri okur", () => {
    expect(toNumber("**25.200.000 TL**")).toBe(25200000);
  });
  it("çevrilemeyeni uydurmaz", () => {
    expect(toNumber("bilinmiyor")).toBeNull();
  });
});

describe("grafik planı", () => {
  it("basit tablodan çubuk grafik çıkar", () => {
    const t = table("| Banka | Bakiye |\n| --- | --- |\n| Garanti | 12.400.000 |\n| İş Bankası | 8.600.000 |\n| Yapı Kredi | 4.200.000 |\n| Ziraat | 1.000.000 |\n| Akbank | 900.000 |\n| Denizbank | 800.000 |\n| Vakıf | 700.000 |");
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.specs[0]!.kind).toBe("bar");
    expect(plan.specs[0]!.points).toHaveLength(7);
  });

  it("az satırlı pozitif veri PAY GRAFİĞİ olur", () => {
    const t = table("| Banka | Bakiye |\n| --- | --- |\n| Garanti | 12.400.000 |\n| İş Bankası | 8.600.000 |\n| Yapı Kredi | 4.200.000 |");
    const plan = planFrom(t, "Banka");
    expect(plan.ok && plan.specs[0]!.kind).toBe("donut");
  });

  it("ay etiketleri ÇİZGİ GRAFİK olur", () => {
    const t = table("| Ay | Ciro |\n| --- | --- |\n| Ocak | 100 |\n| Şubat | 120 |\n| Mart | 90 |");
    const plan = planFrom(t, "Ciro");
    expect(plan.ok && plan.specs[0]!.kind).toBe("line");
  });

  it("ARA TOPLAM SATIRI GRAFİĞE GİRMEZ", () => {
    // Girseydi kendi parçalarının iki katı bir çubuk çıkardı.
    const t = table(
      "| Banka | Bakiye |\n| --- | --- |\n| Garanti | 12.400.000 |\n| İş Bankası | 8.600.000 |\n| **Toplam** | **21.000.000** |",
    );
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.specs[0]!.points.map((p) => p.label)).toEqual(["Garanti", "İş Bankası"]);
    expect(plan.specs[0]!.excluded).toContain("Toplam");
  });

  it("KARIŞIK PARA BİRİMİ ÇİZİLMEZ", () => {
    // 411.200 EUR, 12.400.000 TL'nin yanında "küçük" görünürdü.
    const t = table(
      "| Banka | Bakiye |\n| --- | --- |\n| Garanti | 12.400.000 TL |\n| Garanti EUR | 198.400 EUR |",
    );
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("para birim");
  });

  it("KİMLİK SÜTUNU GRAFİĞE GİRMEZ", () => {
    const t = table("| Müşteri | Fatura No | Tutar |\n| --- | --- | --- |\n| A | 1001 | 500 |\n| B | 1002 | 700 |");
    const plan = planFrom(t, "Fatura");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // "Fatura No" atlandı, yalnızca "Tutar" çizildi.
    expect(plan.specs).toHaveLength(1);
    expect(plan.specs[0]!.points.map((p) => p.value)).toEqual([500, 700]);
  });

  it("her sayısal sütun AYRI grafiktir", () => {
    const t = table("| Kalem | Net | KDV |\n| --- | --- | --- |\n| A | 100 | 20 |\n| B | 200 | 40 |");
    const plan = planFrom(t, "Fatura");
    expect(plan.ok && plan.specs.length).toBe(2);
  });

  it("SEBEBİ SÖYLER — sessizce boş kutu göstermez", () => {
    const t = table("| Müşteri | Şehir |\n| --- | --- |\n| A | İstanbul |\n| B | Ankara |");
    const plan = planFrom(t, "Müşteri");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason.length).toBeGreaterThan(20);
  });

  it("çok satırlı tablo reddedilir", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| Kalem ${i} | ${i} |`).join("\n");
    const t = table(`| Kalem | Değer |\n| --- | --- |\n${rows}`);
    const plan = planFrom(t, "x");
    expect(plan.ok).toBe(false);
  });

  it("bilinmeyen değerli satır grafikte YER TUTAR", () => {
    const t = table("| Ay | Ciro |\n| --- | --- |\n| Ocak | 100 |\n| Şubat | bilinmiyor |\n| Mart | 90 |");
    const plan = planFrom(t, "Ciro");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.specs[0]!.points[1]!.value).toBeNull();
    expect(plan.specs[0]!.points).toHaveLength(3);
  });
});

describe("birim sütunu — gerçek cevapta yakalanan hata", () => {
  it("PARA BİRİMİ AYRI SÜTUNDAYSA GRAFİK BÖLÜNÜR", () => {
    // Bu tam olarak canlı bir cevapta çıktı: hücrede birim yazmadığı
    // için 198.400 EUR, 12.400.000 TL'nin yanında "küçük" görünüyordu.
    const t = table(
      "| Banka | Para Birimi | Kullanılabilir |\n| --- | --- | --- |\n" +
        "| Garanti | TRY | 12.400.000 |\n| İş Bankası | TRY | 8.600.000 |\n" +
        "| Garanti | EUR | 198.400 |\n| İş Bankası | EUR | 126.050 |",
    );
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.specs).toHaveLength(2);
    expect(plan.specs.map((s) => s.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("TRY"), expect.stringContaining("EUR")]),
    );
    // Hiçbir grafikte iki para birimi buluşmuyor.
    for (const s of plan.specs) expect(s.points).toHaveLength(2);
  });

  it("tek para birimi varsa bölme yapılmaz", () => {
    const t = table(
      "| Banka | Para Birimi | Bakiye |\n| --- | --- | --- |\n| A | TRY | 100 |\n| B | TRY | 200 |",
    );
    const plan = planFrom(t, "Banka");
    expect(plan.ok && plan.specs).toHaveLength(1);
  });

  it("ŞEHİR SÜTUNU BİRİM SANILMAZ", () => {
    // Grafiği şehirlere bölmek, karışık birim çizmek kadar yanlış olurdu.
    const t = table(
      "| Müşteri | Şehir | Ciro |\n| --- | --- | --- |\n| A | İstanbul | 100 |\n| B | Ankara | 200 |",
    );
    const plan = planFrom(t, "Ciro");
    expect(plan.ok && plan.specs).toHaveLength(1);
  });
});

describe("boş sütun", () => {
  it("TAMAMI SIFIR SÜTUN ÇİZİLMEZ", () => {
    // Canlı cevapta "Blokeli" sütunu her satırda sıfırdı ve ekranı boş
    // bir eksen kaplıyordu.
    const t = table("| Banka | Bakiye | Blokeli |\n| --- | --- | --- |\n| A | 100 | 0 |\n| B | 200 | 0 |");
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.specs).toHaveLength(1);
  });

  it("hepsi sıfırsa SEBEBİ söylenir", () => {
    const t = table("| Banka | Blokeli |\n| --- | --- |\n| A | 0 |\n| B | 0 |");
    const plan = planFrom(t, "Banka");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain("sıfır");
  });

  it("tek satırı sıfır olan sütun çizilir", () => {
    const t = table("| Banka | Bakiye |\n| --- | --- |\n| A | 0 |\n| B | 200 |");
    expect(planFrom(t, "x").ok).toBe(true);
  });
});
