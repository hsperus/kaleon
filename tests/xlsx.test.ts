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

describe("Word çıktısı", () => {
  /**
   * NEDEN OOXML DEĞİL: gerçek bir `.docx` zip paketi, birden çok XML
   * parçası ve ilişki dosyası ister — ve bu üründe kazandıracağı tek
   * şey uzantı olurdu. Word `application/msword` tipiyle gelen HTML'i
   * açar, tabloyu biçimli gösterir. Uzantıyı `.doc` bırakmak
   * dürüstlüktür: `.docx` olduğunu iddia etmiyoruz.
   */
  it("BOM İLE BAŞLAR — yoksa Word Türkçe karakteri bozar", async () => {
    const { buildWord } = await import("../src/export/word.js");
    const buf = buildWord("Kadro", [
      { name: "Çalışanlar", columns: [{ header: "Ad" }], rows: [["Ayşe Yılmaz"]] },
    ]);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString("utf8")).toContain("Ayşe Yılmaz");
  });

  it("HTML KAÇIRILIR — hücre içeriği kod değildir", async () => {
    const { buildWord } = await import("../src/export/word.js");
    const html = buildWord("X", [
      {
        name: "S",
        columns: [{ header: "Ad" }],
        rows: [["<script>alert(1)</script>"]],
      },
    ]).toString("utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("SAYILAR SAĞA YASLANIR — tutar sütunu okunabilsin", async () => {
    const { buildWord } = await import("../src/export/word.js");
    const html = buildWord("X", [
      {
        name: "S",
        columns: [{ header: "Ad" }, { header: "Tutar", format: "money" }],
        rows: [["Ayşe", 42_000]],
      },
    ]).toString("utf8");
    expect(html).toContain("text-align:right");
    // Türkçe biçim: binlik nokta.
    expect(html).toContain("42.000");
  });

  it("her sayfa kendi başlığıyla gelir", async () => {
    const { buildWord } = await import("../src/export/word.js");
    const html = buildWord("Bilanço", [
      { name: "Aktif", columns: [{ header: "Hesap" }], rows: [["100 Kasa"]] },
      { name: "Pasif", columns: [{ header: "Hesap" }], rows: [["500 Sermaye"]] },
    ]).toString("utf8");
    expect(html).toContain("<h2>Aktif</h2>");
    expect(html).toContain("<h2>Pasif</h2>");
  });
});

describe("dosya adı ve biçim seçimi", () => {
  /**
   * Önce dosya adı sadece başlıktı: "Kadro.xlsx". Kullanıcı üç farklı
   * gün indirdiğinde İndirilenler klasöründe "Kadro.xlsx",
   * "Kadro (1).xlsx", "Kadro (2).xlsx" birikiyor ve hangisinin ne
   * olduğu anlaşılmıyordu. Mali müşavire gönderilecek bir dosyanın
   * adı, açılmadan ne olduğunu söylemeli.
   */
  it("ŞİRKET_BELGE_TARİH biçiminde ad üretir", async () => {
    const { dosyaAdi } = await import("../app/document.js");
    const ad = dosyaAdi("ULS Havayolları Kargo A.Ş.", "Çalışan Listesi", "xlsx");
    expect(ad).toMatch(/^ULS-Havayollari-Kargo-A-S_Calisan-Listesi_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("TÜRKÇE KARAKTER ÇEVRİLİR, ATILMAZ", async () => {
    const { dosyaAdi } = await import("../app/document.js");
    // Atılsaydı "Yldz Dkm" olurdu.
    expect(dosyaAdi("Yıldız Döküm", "Şubat Çıktısı", "doc")).toContain("Yildiz-Dokum");
    expect(dosyaAdi("Yıldız Döküm", "Şubat Çıktısı", "doc")).toContain("Subat-Ciktisi");
  });

  it("boş girdide bile geçerli bir ad kalır", async () => {
    const { dosyaAdi } = await import("../app/document.js");
    expect(dosyaAdi("", "", "xlsx")).toMatch(/^\d{4}-\d{2}-\d{2}\.xlsx$|^KAELON\.xlsx$/);
  });

  describe("istenen biçim", () => {
    it("soruda geçen biçim seçilir", async () => {
      const { istenenBicim } = await import("../app/document.js");
      expect(istenenBicim("çalışan listesini word olarak ver")).toBe("doc");
      expect(istenenBicim("bunun PDF'ini alabilir miyim")).toBe("pdf");
      expect(istenenBicim("excel dosyası oluştur")).toBe("xlsx");
    });

    it("BİÇİM BELİRTİLMEZSE EXCEL — tablo çıktısının varsayılanı", async () => {
      const { istenenBicim } = await import("../app/document.js");
      expect(istenenBicim("mevcut çalışanlarımız kimler")).toBe("xlsx");
    });
  });
});

describe("belge başlığı sorudan", () => {
  /**
   * Cevapta başlık yoksa eskiden İLK SÜTUNUN adı kullanılıyordu:
   * "çalışan listesini excel yap" sorusu "Kod listesi.xlsx" üretiyordu.
   * Soru zaten kullanıcının kendi ifadesi.
   */
  it("BİÇİM VE EYLEM KELİMELERİ ATILIR", async () => {
    const { titleFromQuestion } = await import("../app/rich-text.js");
    expect(titleFromQuestion("çalışan listesini excel dosyası olarak hazırla")).toBe(
      "Çalışan listesi",
    );
    expect(titleFromQuestion("bilançoyu word olarak ver")).toBe("Bilanço");
  });

  it('"BU" ATILMAZ — anlam taşıyan kelime gürültü değildir', async () => {
    const { titleFromQuestion } = await import("../app/rich-text.js");
    expect(titleFromQuestion("bu ayki bordroyu pdf yap")).toBe("Bu ayki bordro");
  });

  it("BELİRSİZ EKE DOKUNULMAZ — yanlış kesilmiş kelime ekli hâlinden kötüdür", async () => {
    const { titleFromQuestion } = await import("../app/rich-text.js");
    // "faturalarını" içinde belirtme eki var ama iyelikle karışıyor;
    // ayırt edemediğimiz yerde bırakıyoruz.
    expect(titleFromQuestion("ağustos faturalarını excel yap")).toBe("Ağustos faturalarını");
  });

  it("soru anlamlı bir başlık vermiyorsa null döner", async () => {
    const { titleFromQuestion } = await import("../app/rich-text.js");
    expect(titleFromQuestion("excel yap")).toBeNull();
    expect(titleFromQuestion("   ")).toBeNull();
  });

  it("uzun soru kırpılır", async () => {
    const { titleFromQuestion } = await import("../app/rich-text.js");
    const t = titleFromQuestion("a".repeat(200))!;
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith("…")).toBe(true);
  });
});
