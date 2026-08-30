/**
 * Fatura görünümünün yasal parçaları.
 *
 * KDV kırılımı ve yazıyla tutar, faturanın SÜS DEĞİL ZORUNLU
 * unsurlarıdır; ikisi de yanlış olursa belge geçersizdir.
 */

import { describe, expect, it } from "vitest";
import { amountInWords, vatBreakdown } from "../src/modules/einvoice/invoice-view.js";

describe("KDV kırılımı", () => {
  it("oranları ayırır ve toplar", () => {
    const b = vatBreakdown([
      { netAmount: 1000, vatRate: 20, vatAmount: 200 },
      { netAmount: 500, vatRate: 20, vatAmount: 100 },
      { netAmount: 300, vatRate: 10, vatAmount: 30 },
    ]);
    expect(b).toEqual([
      { rate: 10, base: 300, amount: 30 },
      { rate: 20, base: 1500, amount: 300 },
    ]);
  });

  it("TEK TOPLAMLA YETİNMEZ", () => {
    // İki oranlı faturada tek KDV satırı, alıcının indirimini imkânsız kılar.
    const b = vatBreakdown([
      { netAmount: 100, vatRate: 1, vatAmount: 1 },
      { netAmount: 100, vatRate: 20, vatAmount: 20 },
    ]);
    expect(b).toHaveLength(2);
  });

  it("sıfır oranlı kalem de görünür", () => {
    // İstisna kapsamındaki kalem faturada GÖRÜNMEK zorunda.
    const b = vatBreakdown([{ netAmount: 5000, vatRate: 0, vatAmount: 0 }]);
    expect(b).toEqual([{ rate: 0, base: 5000, amount: 0 }]);
  });

  it("kalem yoksa kırılım da yok", () => {
    expect(vatBreakdown([])).toEqual([]);
  });
});

describe("tutar yazıyla", () => {
  it("temel sayılar", () => {
    expect(amountInWords(1, "TRY")).toBe("birTürkLirası");
    expect(amountInWords(11, "TRY")).toBe("onbirTürkLirası");
    expect(amountInWords(100, "TRY")).toBe("yüzTürkLirası");
    expect(amountInWords(200, "TRY")).toBe("ikiyüzTürkLirası");
  });

  it('"BİRBİN" DEMEZ', () => {
    // 1000 "binbir" değil "bin"dir; "birbin" yazan bir fatura elle yazılmış gibi durur.
    expect(amountInWords(1000, "TRY")).toBe("binTürkLirası");
    expect(amountInWords(2000, "TRY")).toBe("ikibinTürkLirası");
    expect(amountInWords(1_000_000, "TRY")).toBe("birmilyonTürkLirası");
  });

  it("kuruşu ayrı yazar", () => {
    expect(amountInWords(1234.56, "TRY")).toBe("binikiyüzotuzdörtTürkLirasıellialtıKuruş");
  });

  it("KURUŞ YOKSA KURUŞ YAZMAZ", () => {
    // "...TürkLirasısıfırKuruş" hem yanlış hem çirkin.
    expect(amountInWords(500, "TRY")).toBe("beşyüzTürkLirası");
  });

  it("sıfır tutar", () => {
    expect(amountInWords(0, "TRY")).toBe("sıfırTürkLirası");
  });

  it("yuvarlama kuruşa göre yapılır", () => {
    expect(amountInWords(0.005, "TRY")).toBe("sıfırTürkLirasıbirKuruş");
  });

  it("yabancı para birimi", () => {
    expect(amountInWords(25.5, "EUR")).toBe("yirmibeşEuroellisent".replace("sent", "Sent"));
    expect(amountInWords(3, "USD")).toBe("üçABDDoları");
  });

  it("tanınmayan para birimi kodu olduğu gibi kalır", () => {
    // Uydurma bir kelime yazmaktansa kodu bırakmak dürüsttür.
    expect(amountInWords(2, "GBP")).toBe("ikiGBP");
  });

  it("büyük tutar", () => {
    expect(amountInWords(25_200_000, "TRY")).toBe("yirmibeşmilyonikiyüzbinTürkLirası");
  });
});
