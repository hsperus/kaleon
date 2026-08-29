/**
 * CSV okuyucu — Türkçe Excel gerçeğine karşı.
 *
 * Buradaki her test, hazır bir kütüphanenin SESSİZCE bozacağı bir durumu
 * temsil eder. İçe aktarmada sessiz bozulma en kötü hata sınıfıdır: dosya
 * "başarıyla aktarıldı" der, rakamlar yanlıştır ve kimse aylarca fark etmez.
 */

import { describe, expect, it } from "vitest";
import {
  detectDelimiter,
  parseCsv,
  parseTurkishDate,
  parseTurkishNumber,
  stripBom,
  toRecords,
} from "../src/modules/import/csv.js";

describe("BOM", () => {
  it("Excel'in yazdığı BOM temizlenir", () => {
    // Temizlenmezse ilk sütun başlığı hiçbir eşlemeye uymaz ve kullanıcı
    // "ilk sütunu neden görmüyor" diye sorar.
    const t = parseCsv("﻿Unvan;VKN\nBurçelik;1234567890");
    expect(t.headers).toEqual(["Unvan", "VKN"]);
  });

  it("stripBom BOM'suz metni bozmaz", () => {
    expect(stripBom("Unvan")).toBe("Unvan");
  });
});

describe("ayırıcı tahmini", () => {
  it("Türkçe Excel'in noktalı virgülünü bulur", () => {
    expect(detectDelimiter("Unvan;VKN;Şehir")).toBe(";");
  });

  it("virgüllü dosyayı da bulur", () => {
    expect(detectDelimiter("name,taxId,city")).toBe(",");
  });

  it("sekme ile ayrılmış dosyayı bulur", () => {
    expect(detectDelimiter("Unvan\tVKN\tŞehir")).toBe("\t");
  });

  it("TIRNAK İÇİNDEKİ AYIRICI SAYILMAZ", () => {
    // "Burçelik A.Ş., Bursa" tek hücredir; içindeki virgül ayırıcı sanılırsa
    // tahmin tamamen şaşar.
    expect(detectDelimiter('"Burçelik A.Ş., Bursa";1234567890')).toBe(";");
  });

  it("tek sütunlu dosyada varsayılan noktalı virgül", () => {
    expect(detectDelimiter("Unvan")).toBe(";");
  });
});

describe("ayrıştırma", () => {
  it("temel tablo", () => {
    const t = parseCsv("Unvan;VKN\nBurçelik;1234567890\nGürateş;4444444444");
    expect(t.headers).toEqual(["Unvan", "VKN"]);
    expect(t.rows).toEqual([
      ["Burçelik", "1234567890"],
      ["Gürateş", "4444444444"],
    ]);
  });

  it("tırnaklı hücre içindeki ayırıcı korunur", () => {
    const t = parseCsv('Unvan;Adres\n"Burçelik A.Ş.";"Bursa; Nilüfer"');
    expect(t.rows[0]).toEqual(["Burçelik A.Ş.", "Bursa; Nilüfer"]);
  });

  it("TIRNAK İÇİNDEKİ SATIR SONU TABLOYU KAYDIRMAZ", () => {
    // Satır satır okuyan bir ayrıştırıcı burada tabloyu bozar.
    const t = parseCsv('Unvan;Adres\nBurçelik;"Bursa\nNilüfer"\nGürateş;İzmir');
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]![1]).toBe("Bursa\nNilüfer");
    expect(t.rows[1]![0]).toBe("Gürateş");
  });

  it("kaçırılmış tırnak karakteri korunur", () => {
    const t = parseCsv('Unvan\n"Ali ""Usta"" Metal"');
    expect(t.rows[0]![0]).toBe('Ali "Usta" Metal');
  });

  it("Windows satır sonları desteklenir", () => {
    const t = parseCsv("Unvan;VKN\r\nBurçelik;123\r\n");
    expect(t.rows).toEqual([["Burçelik", "123"]]);
  });

  it("dosya sonundaki boş satırlar rapora karışmaz", () => {
    const t = parseCsv("Unvan;VKN\nBurçelik;123\n\n\n;\n");
    expect(t.rows).toEqual([["Burçelik", "123"]]);
  });

  it("eksik hücreli satır çökertmez", () => {
    const t = parseCsv("Unvan;VKN;Şehir\nBurçelik;123");
    expect(toRecords(t)[0]).toEqual({ Unvan: "Burçelik", VKN: "123", Şehir: "" });
  });

  it("boş dosya boş tablo verir", () => {
    const t = parseCsv("");
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([]);
  });
});

describe("Türkçe sayı", () => {
  it("bin ayırıcılı ondalık", () => {
    expect(parseTurkishNumber("1.234,56")).toBe(1234.56);
    expect(parseTurkishNumber("12.400.000,00")).toBe(12_400_000);
  });

  it("yalnızca ondalık virgül", () => {
    expect(parseTurkishNumber("1234,56")).toBe(1234.56);
  });

  it("İNGİLİZCE BİÇİM DE OKUNUR", () => {
    // Entegratörden gelen dosyalar sık sık İngilizce biçimdedir.
    expect(parseTurkishNumber("1,234.56")).toBe(1234.56);
    expect(parseTurkishNumber("1234.56")).toBe(1234.56);
  });

  it("nokta bin ayırıcısı olarak yorumlanır", () => {
    // "1.234" Türkçe bağlamda 1234'tür.
    expect(parseTurkishNumber("1.234")).toBe(1234);
  });

  it("tek haneli kuyruk bin ayırıcısı OLAMAZ", () => {
    expect(parseTurkishNumber("1.5")).toBe(1.5);
  });

  it("negatif ve boşluklu değerler", () => {
    expect(parseTurkishNumber("-1.234,56")).toBe(-1234.56);
    expect(parseTurkishNumber(" 42 ")).toBe(42);
  });

  it("boş ve anlamsız değer null döner — sıfır DEĞİL", () => {
    // Sıfır bir iddiadır; "hücre boş" ile aynı şey değildir.
    expect(parseTurkishNumber("")).toBe(null);
    expect(parseTurkishNumber("   ")).toBe(null);
    expect(parseTurkishNumber("yok")).toBe(null);
  });
});

describe("Türkçe tarih", () => {
  it("nokta ile ayrılmış tarih", () => {
    expect(parseTurkishDate("31.12.2026")).toBe("2026-12-31");
  });

  it("eğik çizgi ve tek haneli gün/ay", () => {
    expect(parseTurkishDate("3/4/2026")).toBe("2026-04-03");
  });

  it("ISO biçimi olduğu gibi", () => {
    expect(parseTurkishDate("2026-12-31")).toBe("2026-12-31");
  });

  it("GÜN ÖNCE GELİR — ay/gün takası yapılmaz", () => {
    // Sessizce takas yapmak teslim tarihlerini aylarca kaydırır.
    expect(parseTurkishDate("03.04.2026")).toBe("2026-04-03");
  });

  it("OLMAYAN TARİH KAYDIRILMAZ, REDDEDİLİR", () => {
    // Date nesnesi 31 Şubat'ı 3 Mart'a kaydırır; sessizce kabul edilirse
    // veri bozulur.
    expect(parseTurkishDate("31.02.2026")).toBe(null);
    expect(parseTurkishDate("32.01.2026")).toBe(null);
    expect(parseTurkishDate("01.13.2026")).toBe(null);
  });

  it("artık yıl doğru", () => {
    expect(parseTurkishDate("29.02.2028")).toBe("2028-02-29");
    expect(parseTurkishDate("29.02.2026")).toBe(null);
  });

  it("anlamsız değer null", () => {
    expect(parseTurkishDate("")).toBe(null);
    expect(parseTurkishDate("yakında")).toBe(null);
  });
});
