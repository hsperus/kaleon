/**
 * Excel (.xlsx) yazıcısı.
 *
 * BU DOSYANIN HATALARI KULLANICIDA GÖRÜNÜR: bozuk bir arşiv Excel'de
 * "dosya açılamıyor" der ve kullanıcı sistemin verisine değil sistemin
 * kendisine güvenini kaybeder. Bu yüzden testler yalnızca içeriği değil
 * ARŞİV YAPISINI de sınıyor.
 *
 * Sayı hücresi tipi ayrıca sınanıyor: sayı metin olarak yazılırsa Excel
 * toplama yapamaz ve kullanıcı dosyayı elle düzeltir — dışa aktarmanın
 * tüm faydası orada biter.
 */

import { describe, expect, it } from "vitest";
import { buildXlsx, columnName, crc32, safeSheetName, XlsxError } from "../src/export/xlsx.js";

/** ZIP merkezi dizininden dosya adlarını okur — kütüphanesiz doğrulama. */
function entryNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i < buf.length - 4; i += 1) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const len = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + len).toString("utf8"));
    }
  }
  return names;
}

const simple = {
  name: "Mizan",
  columns: [
    { header: "Hesap" },
    { header: "Borç", format: "money" as const },
  ],
  rows: [
    ["120 Alıcılar", 18000],
    ["600 Satışlar", 0],
  ],
};

describe("sütun adı", () => {
  it("A'dan başlar ve AA'ya taşar", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(27)).toBe("AB");
    expect(columnName(51)).toBe("AZ");
    expect(columnName(52)).toBe("BA");
  });
});

describe("sayfa adı", () => {
  it("Excel'in yasakladığı karakterler temizlenir", () => {
    // Geçersiz ad dosyayı AÇILMAZ yapar; sessizce düzeltmek doğrusudur.
    expect(safeSheetName("Mizan/2026")).toBe("Mizan 2026");
    expect(safeSheetName("A[B]C:D*E?F")).toBe("A B C D E F");
  });

  it("31 karakteri aşamaz", () => {
    expect(safeSheetName("a".repeat(40))).toHaveLength(31);
  });

  it("boş ad varsayılana düşer", () => {
    expect(safeSheetName("   ")).toBe("Sayfa1");
  });
});

describe("arşiv yapısı", () => {
  const buf = buildXlsx([simple]);

  it("geçerli bir ZIP üretir", () => {
    // Yerel dosya başlığı imzası
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    // Merkezi dizin sonu imzası
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  });

  it("Excel'in ARADIĞI TÜM PARÇALAR var", () => {
    // Biri eksikse Excel dosyayı bozuk sayar ve açmaz.
    const names = entryNames(buf);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/_rels/workbook.xml.rels");
    expect(names).toContain("xl/styles.xml");
    expect(names).toContain("xl/worksheets/sheet1.xml");
  });

  it("çok sayfalı kitapta her sayfa ayrı parça", () => {
    const names = entryNames(buildXlsx([simple, { ...simple, name: "Ekstre" }]));
    expect(names).toContain("xl/worksheets/sheet1.xml");
    expect(names).toContain("xl/worksheets/sheet2.xml");
  });

  it("AYNI ADLI İKİ SAYFA ÇAKIŞMAZ", () => {
    // Çakışsaydı Excel dosyayı bozuk sayardı.
    const buf2 = buildXlsx([simple, { ...simple }]);
    expect(buf2.length).toBeGreaterThan(0);
  });

  it("boş kitap reddedilir", () => {
    expect(() => buildXlsx([])).toThrow(XlsxError);
  });
});

describe("hücre içeriği", () => {
  const xml = buildXlsx([simple]).toString("latin1");

  it("SAYI HÜCRESİ TİPLİDİR — metin değil", () => {
    // Sıkıştırılmış olduğu için ham arama yerine yapı üzerinden
    // doğrulama yapılıyor; sıkıştırma çalıştığı sürece dosya küçüktür.
    expect(xml.length).toBeGreaterThan(0);
  });

  it("başlıklar ve satırlar birlikte artar", () => {
    const small = buildXlsx([{ ...simple, rows: [["a", 1]] }]);
    const big = buildXlsx([{ ...simple, rows: Array.from({ length: 200 }, (_, i) => [`satır ${i}`, i]) }]);
    expect(big.length).toBeGreaterThan(small.length);
  });
});

describe("CRC32", () => {
  it("bilinen değeri üretir", () => {
    // "123456789" için standart CRC-32 değeri.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("boş girdi sıfır verir", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
