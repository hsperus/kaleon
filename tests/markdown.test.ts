/**
 * Cevap metni ayrıştırıcısı.
 *
 * BURADAKİ HATALAR SESSİZDİR. Bir tablo yanlış ayrıştırılırsa ekranda
 * boru işaretleriyle dolu bir yığın çıkar ve kimse "ayrıştırıcı bozuk"
 * demez — "model kötü cevap verdi" der. Bu yüzden testler modelin
 * gerçekte ürettiği biçimleri sınıyor.
 */

import { describe, expect, it } from "vitest";
import { isNumericValue, parseBlocks, parseInline } from "../src/ui/markdown.js";

describe("satır içi biçimler", () => {
  it("kalın ayrıştırılır", () => {
    expect(parseInline("Toplam **25.200.000 TL** var")).toEqual([
      { kind: "text", value: "Toplam " },
      { kind: "bold", value: "25.200.000 TL" },
      { kind: "text", value: " var" },
    ]);
  });

  it("KOD İÇİNDEKİ YILDIZ İTALİK SAYILMAZ", () => {
    // `a * b` içindeki yıldız biçim değildir; kod önce ayrılmalı.
    const t = parseInline("Hesap `a * b` şeklinde");
    expect(t.some((x) => x.kind === "italic")).toBe(false);
    expect(t.find((x) => x.kind === "code")?.value).toBe("a * b");
  });

  it("italik ve kalın karışmaz", () => {
    const t = parseInline("**kalın** ve *italik*");
    expect(t.filter((x) => x.kind === "bold")).toHaveLength(1);
    expect(t.filter((x) => x.kind === "italic")).toHaveLength(1);
  });

  it("biçimsiz metin tek parça kalır", () => {
    expect(parseInline("düz metin")).toEqual([{ kind: "text", value: "düz metin" }]);
  });

  it("boş metin çökmez", () => {
    expect(parseInline("")).toEqual([{ kind: "text", value: "" }]);
  });
});

describe("blok ayrıştırma", () => {
  it("başlık seviyesiyle ayrıştırılır", () => {
    expect(parseBlocks("## Mizan")).toEqual([{ kind: "heading", level: 2, text: "Mizan" }]);
  });

  it("sırasız liste", () => {
    const b = parseBlocks("- Garanti 12.400.000\n- İş Bankası 8.600.000");
    expect(b[0]).toMatchObject({ kind: "list", ordered: false });
    expect((b[0] as unknown as { items: string[] }).items).toHaveLength(2);
  });

  it("sıralı liste ayrı türdür", () => {
    const b = parseBlocks("1. Birinci\n2. İkinci");
    expect(b[0]).toMatchObject({ kind: "list", ordered: true });
  });

  it("paragraf satırları birleşir", () => {
    const b = parseBlocks("İlk satır\nikinci satır");
    expect(b).toEqual([{ kind: "paragraph", text: "İlk satır ikinci satır" }]);
  });

  it("boş satır blokları ayırır", () => {
    const b = parseBlocks("Birinci paragraf\n\nİkinci paragraf");
    expect(b).toHaveLength(2);
  });

  it("kod bloğu olduğu gibi korunur", () => {
    const b = parseBlocks("```\nSELECT 1;\nSELECT 2;\n```");
    expect(b[0]).toEqual({ kind: "code", text: "SELECT 1;\nSELECT 2;" });
  });

  it("alıntı", () => {
    expect(parseBlocks("> Dikkat edilmeli")).toEqual([
      { kind: "quote", text: "Dikkat edilmeli" },
    ]);
  });
});

describe("tablo", () => {
  const md = [
    "| Hesap | Borç | Alacak |",
    "|-------|------|--------|",
    "| 120 Alıcılar | 18.000,00 | 0,00 |",
    "| 600 Satışlar | 0,00 | 15.000,00 |",
  ].join("\n");

  it("başlık ve satırlar ayrışır", () => {
    const b = parseBlocks(md)[0] as unknown as { kind: string; head: string[]; rows: string[][] };
    expect(b.kind).toBe("table");
    expect(b.head).toEqual(["Hesap", "Borç", "Alacak"]);
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0]).toEqual(["120 Alıcılar", "18.000,00", "0,00"]);
  });

  it("SAYISAL SÜTUN İŞARETLENİR", () => {
    // Sayılar sola yaslanırsa basamaklar hizalanmaz ve mizan
    // karşılaştırma için kullanılamaz.
    const b = parseBlocks(md)[0] as unknown as { numeric: boolean[] };
    expect(b.numeric).toEqual([false, true, true]);
  });

  it("AYRAÇ SATIRI OLMADAN TABLO SAYILMAZ", () => {
    // "a|b" içeren normal bir cümle tabloya çevrilmemeli.
    const b = parseBlocks("Şu ya da bu | belki de o");
    expect(b[0]!.kind).toBe("paragraph");
  });

  it("EKSİK HÜCRE SATIRI KAYDIRMAZ", () => {
    // Kaydırsaydı rakamlar yanlış sütuna düşer ve kimse fark etmezdi.
    const short = "| A | B | C |\n|---|---|---|\n| 1 | 2 |";
    const b = parseBlocks(short)[0] as unknown as { rows: string[][] };
    expect(b.rows[0]).toEqual(["1", "2", ""]);
  });

  it("fazla hücre atılır", () => {
    const long = "| A | B |\n|---|---|\n| 1 | 2 | 3 |";
    const b = parseBlocks(long)[0] as unknown as { rows: string[][] };
    expect(b.rows[0]).toEqual(["1", "2"]);
  });

  it("dış boru işaretleri olmadan da çalışır", () => {
    const b = parseBlocks("A | B\n--- | ---\n1 | 2")[0] as unknown as { head: string[] };
    expect(b.head).toEqual(["A", "B"]);
  });
});

describe("sayısal değer tanıma", () => {
  it("para birimi taşıyan değer sayıdır", () => {
    expect(isNumericValue("156.000 TL")).toBe(true);
    expect(isNumericValue("12.400.000,00")).toBe(true);
    expect(isNumericValue("%24")).toBe(false); // önde yüzde: metin
    expect(isNumericValue("24%")).toBe(true);
    expect(isNumericValue("411.200 EUR")).toBe(true);
  });

  it("metin sayı değildir", () => {
    expect(isNumericValue("Garanti BBVA")).toBe(false);
    expect(isNumericValue("")).toBe(false);
    expect(isNumericValue("SO-2026-0418")).toBe(false);
  });

  it("negatif ve birim taşıyan değerler sayıdır", () => {
    expect(isNumericValue("-1.500,00")).toBe(true);
    expect(isNumericValue("40 adet")).toBe(true);
    expect(isNumericValue("7,5 saat")).toBe(true);
  });
});

describe("gerçek model cevabı", () => {
  // Canlıda alınan gerçek cevap — yıldızlar ekranda görünüyordu.
  const real = [
    "Toplam kullanılabilir: **25.200.000 TL** ve **411.200 EUR**.",
    "",
    "- TRY: Garanti 12.400.000, İş Bankası 8.600.000",
    "- EUR: Garanti 198.400, İş Bankası 126.050",
    "",
    "Kaynak: Banka entegratörü, 6 kayıt.",
  ].join("\n");

  it("paragraf, liste ve paragraf olarak ayrışır", () => {
    const b = parseBlocks(real);
    expect(b.map((x) => x.kind)).toEqual(["paragraph", "list", "paragraph"]);
  });

  it("KALIN TUTARLAR BİÇİM OLARAK TANINIR — yıldız görünmez", () => {
    const first = parseBlocks(real)[0] as unknown as { text: string };
    const tokens = parseInline(first.text);
    const bold = tokens.filter((t) => t.kind === "bold").map((t) => t.value);
    expect(bold).toEqual(["25.200.000 TL", "411.200 EUR"]);
    expect(tokens.some((t) => t.kind === "text" && t.value.includes("**"))).toBe(false);
  });
});
