/**
 * UBL-TR e-Fatura belgesi.
 *
 * Türkiye'de fatura artık bir XML belgesidir; 3 milyon TL üstü cirolu
 * mükellefin kâğıt fatura kesme imkânı yoktur. Bu yüzden "fatura kesme"
 * özelliği, geçerli UBL üretmeden tamamlanmış sayılmaz.
 *
 * Buradaki testlerin çoğu EKSİK VERİYİ yakalar: geçersiz bir belgeyi
 * entegratöre gönderip anlaşılmaz bir hata almak, kullanıcıyı kendi
 * sisteminde göremediği bir sorunu çözmeye zorlar.
 */

import { describe, expect, it } from "vitest";
import {
  buildInvoiceXml,
  missingFields,
  profileFor,
  uomCode,
  validateTaxId,
  EInvoiceError,
  PROFILES,
  type InvoiceInput,
  type Party,
} from "../src/modules/einvoice/ubl.js";

const supplier: Party = {
  legalName: "Orthaus Makina Sanayi A.Ş.",
  taxId: "1234567890",
  taxOffice: "Nilüfer",
  addressLine: "Organize Sanayi Bölgesi 3. Cadde No:12",
  district: "Nilüfer",
  city: "Bursa",
  postalCode: "16140",
  email: "muhasebe@orthaus.com",
};

const customer: Party = {
  legalName: "Volvo Group Sweden AB",
  taxId: "1000000018",
  taxOffice: "Beşiktaş",
  addressLine: "Levent Mahallesi 5. Sokak No:3",
  district: "Beşiktaş",
  city: "İstanbul",
};

const invoice: InvoiceInput = {
  ettn: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  documentNo: "FTR2026000431",
  issueDate: new Date("2026-06-25T10:30:00.000Z"),
  currency: "TRY",
  supplier,
  customer,
  lines: [
    {
      lineNo: 1,
      itemName: "Şasi Grubu",
      quantity: 10,
      uom: "adet",
      unitPrice: 900,
      discountAmount: 0,
      netAmount: 9000,
      vatRate: 20,
      vatAmount: 1800,
    },
  ],
  netAmount: 9000,
  discountAmount: 0,
  vatAmount: 1800,
  totalAmount: 10800,
};

describe("vergi kimliği", () => {
  it("VKN 10, TCKN 11 hanedir", () => {
    expect(validateTaxId("1234567890")).toEqual({ valid: true, kind: "vkn" });
    expect(validateTaxId("12345678901")).toEqual({ valid: true, kind: "tckn" });
  });

  it("GEÇERSİZ BİÇİM GİB'DEN ÖNCE YAKALANIR", () => {
    expect(validateTaxId("123").valid).toBe(false);
    expect(validateTaxId("ABC1234567").valid).toBe(false);
  });
});

describe("birim kodları", () => {
  it("Türkçe birimler UN/ECE koduna çevrilir", () => {
    expect(uomCode("adet")).toBe("C62");
    expect(uomCode("kg")).toBe("KGM");
    expect(uomCode("KG")).toBe("KGM");
    expect(uomCode("lt")).toBe("LTR");
  });

  it("bilinmeyen birim adet sayılır", () => {
    expect(uomCode("çuval")).toBe("C62");
  });
});

describe("eksik alan denetimi", () => {
  it("tam belge eksiksizdir", () => {
    expect(missingFields(invoice)).toEqual([]);
  });

  it("EKSİKLER TOPLU SÖYLENİR — tek tek değil", () => {
    // Her seferinde bir eksik söylenseydi kullanıcı beş kez denerdi.
    const missing = missingFields({
      ...invoice,
      customer: { ...customer, taxId: null, taxOffice: null, city: null },
    });
    expect(missing).toHaveLength(3);
    expect(missing.join(" ")).toContain("vergi/TC kimlik");
    expect(missing.join(" ")).toContain("vergi dairesi");
    expect(missing.join(" ")).toContain("il");
  });

  it("satıcı eksiği de yakalanır", () => {
    const missing = missingFields({ ...invoice, supplier: { ...supplier, addressLine: null } });
    expect(missing).toContain("Satıcı: adres");
  });

  it("BOZUK VERGİ NUMARASI SEBEBİYLE BİRLİKTE SÖYLENİR", () => {
    const missing = missingFields({ ...invoice, customer: { ...customer, taxId: "123" } });
    expect(missing[0]).toContain("10 hane");
    expect(missing[0]).toContain("123");
  });

  it("yabancı para faturada kur zorunludur", () => {
    expect(missingFields({ ...invoice, currency: "EUR" })).toContain(
      "Yabancı para faturada kur",
    );
  });

  it("kalemsiz fatura reddedilir", () => {
    expect(missingFields({ ...invoice, lines: [] })).toContain("Fatura kalemi yok");
  });
});

describe("profil seçimi", () => {
  it("mükellefe e-Fatura, mükellef olmayana e-Arşiv", () => {
    expect(profileFor(true)).toBe(PROFILES.temel);
    expect(profileFor(false)).toBe(PROFILES.earsiv);
  });

  it("BİLİNMİYORSA TAHMİN EDİLMEZ", () => {
    // "e-Arşiv varsayalım" demek, mükellef bir alıcıya yanlış belge
    // göndermek ve faturayı geçersiz kılmaktır.
    expect(() => profileFor(null)).toThrow(EInvoiceError);
    expect(() => profileFor(null)).toThrow(/GİB'den/);
  });
});

describe("XML üretimi", () => {
  const xml = buildInvoiceXml(invoice, PROFILES.temel);

  it("UBL-TR 1.2 başlıkları doğru", () => {
    expect(xml).toContain("<cbc:UBLVersionID>2.1</cbc:UBLVersionID>");
    expect(xml).toContain("<cbc:CustomizationID>TR1.2</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:ProfileID>TEMELFATURA</cbc:ProfileID>");
  });

  it("belge numarası ve ETTN yazılır", () => {
    expect(xml).toContain("<cbc:ID>FTR2026000431</cbc:ID>");
    expect(xml).toContain("<cbc:UUID>3fa85f64-5717-4562-b3fc-2c963f66afa6</cbc:UUID>");
  });

  it("VKN ve TCKN AYRI ŞEMA İLE İŞARETLENİR", () => {
    expect(xml).toContain('schemeID="VKN">1234567890');
    const withTckn = buildInvoiceXml(
      { ...invoice, customer: { ...customer, taxId: "12345678901" } },
      PROFILES.earsiv,
    );
    expect(withTckn).toContain('schemeID="TCKN">12345678901');
  });

  it("KDV KIRILIMI ORANA GÖRE YAZILIR", () => {
    // Fatura üzerinde oran kırılımı göstermek mevzuat gereğidir.
    const multi = buildInvoiceXml(
      {
        ...invoice,
        lines: [
          invoice.lines[0]!,
          {
            lineNo: 2,
            itemName: "Nakliye",
            quantity: 1,
            uom: "adet",
            unitPrice: 500,
            discountAmount: 0,
            netAmount: 500,
            vatRate: 10,
            vatAmount: 50,
          },
        ],
        netAmount: 9500,
        vatAmount: 1850,
        totalAmount: 11350,
      },
      PROFILES.temel,
    );
    expect(multi).toContain("<cbc:Percent>10.00</cbc:Percent>");
    expect(multi).toContain("<cbc:Percent>20.00</cbc:Percent>");
  });

  it("tutarlar iki ondalık ve nokta ayırıcıyla yazılır", () => {
    expect(xml).toContain('<cbc:PayableAmount currencyID="TRY">10800.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="TRY">9000.00</cbc:TaxExclusiveAmount>');
  });

  it("ÖZEL KARAKTERLER KAÇIRILIR — belge bozulmaz", () => {
    const risky = buildInvoiceXml(
      {
        ...invoice,
        customer: { ...customer, legalName: 'Test & Co <Ltd> "A"' },
      },
      PROFILES.temel,
    );
    expect(risky).toContain("Test &amp; Co &lt;Ltd&gt; &quot;A&quot;");
    expect(risky).not.toContain("<Ltd>");
  });

  it("EKSİK ALANLA XML ÜRETİLMEZ", () => {
    // Üretilseydi entegratör reddeder ve kullanıcı kendi sisteminde
    // göremediği bir hatayı çözmeye çalışırdı.
    expect(() =>
      buildInvoiceXml({ ...invoice, customer: { ...customer, taxId: null } }, PROFILES.temel),
    ).toThrow(/zorunlu alan eksik/);
  });

  it("hata eksik alan listesini TAŞIR", () => {
    try {
      buildInvoiceXml({ ...invoice, customer: { ...customer, city: null } }, PROFILES.temel);
      throw new Error("beklenmedik");
    } catch (e) {
      expect((e as EInvoiceError).missing).toContain("Alıcı: il");
    }
  });

  it("yabancı para faturada kur bloğu yazılır", () => {
    const fx = buildInvoiceXml(
      { ...invoice, currency: "EUR", exchangeRate: 36.55 },
      PROFILES.temel,
    );
    expect(fx).toContain("<cbc:CalculationRate>36.550000</cbc:CalculationRate>");
    expect(fx).toContain("<cbc:TargetCurrencyCode>TRY</cbc:TargetCurrencyCode>");
  });

  it("kalem iskontosu ayrı blokta yazılır", () => {
    const disc = buildInvoiceXml(
      {
        ...invoice,
        lines: [{ ...invoice.lines[0]!, discountAmount: 900, netAmount: 8100, vatAmount: 1620 }],
        netAmount: 8100,
        discountAmount: 900,
        vatAmount: 1620,
        totalAmount: 9720,
      },
      PROFILES.temel,
    );
    expect(disc).toContain("<cbc:ChargeIndicator>false</cbc:ChargeIndicator>");
    expect(disc).toContain('<cbc:AllowanceTotalAmount currencyID="TRY">900.00</cbc:AllowanceTotalAmount>');
  });

  it("e-Arşiv profili de üretilebilir", () => {
    const ea = buildInvoiceXml(invoice, PROFILES.earsiv);
    expect(ea).toContain("<cbc:ProfileID>EARSIVFATURA</cbc:ProfileID>");
  });

  it("XML tek kök elemanla başlar ve biter", () => {
    expect(xml.trimStart().startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.trimEnd().endsWith("</Invoice>")).toBe(true);
    expect(xml.match(/<Invoice[\s>]/g)).toHaveLength(1);
  });
});
