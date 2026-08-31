/**
 * Word çıktısı — antet ve sayfa yönü.
 *
 * BU DOSYALAR DIŞARI ÇIKIYOR: mali müşavire, bankaya, tedarikçiye.
 * Test edilen şey biçimin güzelliği değil, belgenin KİMLİĞİNİ taşıyıp
 * taşımadığı ve yanlış yönde basılıp basılmadığı.
 */

import { describe, expect, it } from "vitest";
import { buildWord } from "../src/export/word.js";
import { letterheadFrom } from "../src/modules/documents/letterhead.js";

const SAYFA = [
  {
    name: "Kadro",
    columns: [{ header: "Ad" }, { header: "Brüt", format: "money" as const }],
    rows: [["Serkan Aydın", 485_000]],
  },
];

const ANTET = letterheadFrom(
  {
    legalName: "ULS Havayolları Kargo A.Ş.",
    taxOffice: "Büyük Mükellefler",
    taxId: "9010203040",
    addressLine: "İstanbul Havalimanı",
    district: "Arnavutköy",
    city: "İstanbul",
    postalCode: null,
    phone: "+90 212 000 00 00",
    email: null,
    mersisNo: null,
    tradeRegistryNo: "123456-5",
  },
  "ULS",
);

function metin(b: Buffer): string {
  // BOM atlanır; geri kalanı UTF-8 HTML.
  return b.subarray(3).toString("utf8");
}

describe("Word çıktısı", () => {
  it("HER ZAMAN A4 DİKEY — yatay değil", () => {
    const html = metin(buildWord("Kadro listesi", SAYFA, ANTET));
    expect(html).toContain("size: A4 portrait");
    expect(html).not.toContain("landscape");
  });

  it("Türkçe karakterler için BOM taşır", () => {
    const b = buildWord("Kadro", SAYFA, ANTET);
    expect([b[0], b[1], b[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("anteti basar: unvan, adres, vergi dairesi ve numara", () => {
    const html = metin(buildWord("Kadro listesi", SAYFA, ANTET));
    expect(html).toContain("ULS Havayolları Kargo A.Ş.");
    expect(html).toContain("İstanbul Havalimanı · Arnavutköy/İstanbul");
    expect(html).toContain("Büyük Mükellefler V.D. 9010203040");
    expect(html).toContain("Tic. Sic. No: 123456-5");
  });

  it("belge başlığı antedin sağında durur", () => {
    const html = metin(buildWord("Kadro listesi", SAYFA, ANTET));
    expect(html).toContain('class="doctitle">Kadro listesi');
  });

  it("BOŞ ALAN İÇİN AYRAÇ BIRAKMAZ", () => {
    // E-posta yok: telefon satırı yalnız kalmalı, " · " ile bitmemeli.
    const html = metin(buildWord("X", SAYFA, ANTET));
    expect(html).toContain('<div class="org-line">+90 212 000 00 00</div>');
  });

  it("antet verilmezse belge yine üretilir — ad başlıkta kalır", () => {
    const html = metin(buildWord("Kadro listesi", SAYFA, null));
    expect(html).toContain("<h1>Kadro listesi</h1>");
    expect(html).toContain("size: A4 portrait");
  });

  it("hücre içeriği kaçırılır — belge kod taşımaz", () => {
    const kotu = [
      {
        name: "S",
        columns: [{ header: "Ad" }],
        rows: [['<script>alert(1)</script>']],
      },
    ];
    const html = metin(buildWord("X", kotu, ANTET));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
