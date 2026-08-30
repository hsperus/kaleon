/**
 * UBL-TR e-İrsaliye.
 *
 * 1 Temmuz 2026'dan itibaren zorunlu. İrsaliyede asıl bilgi tutar değil
 * TAŞIMADIR: hangi araç, kimin sürücülüğünde, ne zaman. Bu yüzden
 * buradaki testlerin ağırlığı taşıma bilgisinin eksikliğinde — plakasız
 * bir irsaliye, yol denetiminde belgesiz mal demektir.
 */

import { describe, expect, it } from "vitest";
import {
  buildDespatchXml,
  missingDespatchFields,
  DESPATCH_PROFILES,
  type DespatchInput,
} from "../src/modules/einvoice/despatch.js";
import { EInvoiceError, type Party } from "../src/modules/einvoice/ubl.js";

const supplier: Party = {
  legalName: "Orthaus Makina Sanayi A.Ş.",
  taxId: "1234567890",
  taxOffice: "Nilüfer",
  addressLine: "OSB 3. Cadde No:12",
  district: "Nilüfer",
  city: "Bursa",
};

const customer: Party = {
  legalName: "Volvo Group Sweden AB",
  taxId: "1000000018",
  taxOffice: "Beşiktaş",
  addressLine: "Levent Mahallesi 5. Sokak No:3",
  district: "Beşiktaş",
  city: "İstanbul",
};

const despatch: DespatchInput = {
  ettn: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  documentNo: "IRS2026000431",
  issueDate: new Date("2026-06-20T08:00:00.000Z"),
  actualDespatchDate: new Date("2026-06-20T09:30:00.000Z"),
  supplier,
  customer,
  shipment: {
    carrierName: "Orthaus Lojistik",
    plateNo: "16 ABC 123",
    driverTckn: "12345678901",
    driverName: "Hasan Turan",
  },
  lines: [
    { lineNo: 1, itemName: "Şasi Grubu", quantity: 10, uom: "adet", batchNo: "P-2026-04" },
  ],
  orderReference: "SO-2026-0418",
};

describe("eksik alan denetimi", () => {
  it("tam belge eksiksizdir", () => {
    expect(missingDespatchFields(despatch)).toEqual([]);
  });

  it("PLAKA ZORUNLUDUR", () => {
    // Plakasız irsaliye, yol denetiminde belgesiz mal demektir.
    const m = missingDespatchFields({
      ...despatch,
      shipment: { ...despatch.shipment, plateNo: null },
    });
    expect(m.join(" ")).toContain("araç plakası");
  });

  it("taşıyıcı unvanı zorunludur", () => {
    const m = missingDespatchFields({
      ...despatch,
      shipment: { ...despatch.shipment, carrierName: null },
    });
    expect(m.join(" ")).toContain("taşıyıcı unvanı");
  });

  it("SÜRÜCÜ TC KİMLİK NUMARASI 11 HANE OLMALI", () => {
    const m = missingDespatchFields({
      ...despatch,
      shipment: { ...despatch.shipment, driverTckn: "123" },
    });
    expect(m.join(" ")).toContain("11 hane");
  });

  it("sürücü bilgisi opsiyoneldir", () => {
    const m = missingDespatchFields({
      ...despatch,
      shipment: { carrierName: "X Lojistik", plateNo: "16 A 1" },
    });
    expect(m).toEqual([]);
  });

  it("alıcı adresi eksikse yakalanır", () => {
    const m = missingDespatchFields({
      ...despatch,
      customer: { ...customer, city: null },
    });
    expect(m).toContain("Alıcı: il");
  });

  it("kalemsiz irsaliye reddedilir", () => {
    expect(missingDespatchFields({ ...despatch, lines: [] })).toContain("İrsaliye kalemi yok");
  });
});

describe("XML üretimi", () => {
  const xml = buildDespatchXml(despatch);

  it("UBL-TR e-İrsaliye başlıkları doğru", () => {
    expect(xml).toContain("<cbc:CustomizationID>TR1.2</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:ProfileID>TEMELIRSALIYE</cbc:ProfileID>");
    expect(xml).toContain("<cbc:DespatchAdviceTypeCode>SEVK</cbc:DespatchAdviceTypeCode>");
  });

  it("TAŞIMA BİLGİSİ BELGEDE YER ALIR", () => {
    expect(xml).toContain("<cbc:LicensePlateID>16 ABC 123</cbc:LicensePlateID>");
    expect(xml).toContain("Orthaus Lojistik");
    expect(xml).toContain('schemeID="TCKN">12345678901');
    expect(xml).toContain("Hasan Turan");
  });

  it("FİİLİ SEVK ANI YAZILIR — düzenleme anından farklı olabilir", () => {
    expect(xml).toContain("<cbc:ActualDeliveryDate>2026-06-20</cbc:ActualDeliveryDate>");
    expect(xml).toContain("<cbc:ActualDeliveryTime>09:30:00</cbc:ActualDeliveryTime>");
    // Düzenleme saati ayrı.
    expect(xml).toContain("<cbc:IssueTime>08:00:00</cbc:IssueTime>");
  });

  it("PARTİ NUMARASI İRSALİYEDE GÖRÜNÜR", () => {
    // Parti takipli malzemede geri çağırma bu numaradan yürür.
    expect(xml).toContain("<cbc:LotNumberID>P-2026-04</cbc:LotNumberID>");
  });

  it("sipariş referansı taşınır", () => {
    expect(xml).toContain("<cbc:ID>SO-2026-0418</cbc:ID>");
  });

  it("İRSALİYEDE FİYAT YOKTUR", () => {
    // Fatura değil sevk belgesi; tutar bilgisi taşımaz.
    expect(xml).not.toContain("PriceAmount");
    expect(xml).not.toContain("PayableAmount");
    expect(xml).not.toContain("TaxTotal");
  });

  it("miktar ve birim kodu yazılır", () => {
    expect(xml).toContain('<cbc:DeliveredQuantity unitCode="C62">10</cbc:DeliveredQuantity>');
  });

  it("EKSİK TAŞIMA BİLGİSİYLE BELGE ÜRETİLMEZ", () => {
    expect(() =>
      buildDespatchXml({
        ...despatch,
        shipment: { ...despatch.shipment, plateNo: null },
      }),
    ).toThrow(/zorunlu alan eksik/);
  });

  it("hata eksik alan listesini taşır", () => {
    try {
      buildDespatchXml({ ...despatch, shipment: { carrierName: null, plateNo: null } });
      throw new Error("beklenmedik");
    } catch (e) {
      expect((e as EInvoiceError).missing.length).toBe(2);
    }
  });

  it("özel karakterler kaçırılır", () => {
    const risky = buildDespatchXml({
      ...despatch,
      customer: { ...customer, legalName: "A & B <Ltd>" },
    });
    expect(risky).toContain("A &amp; B &lt;Ltd&gt;");
  });

  it("XML tek kök elemanla başlar ve biter", () => {
    expect(xml.trimStart().startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml.trimEnd().endsWith("</DespatchAdvice>")).toBe(true);
  });

  it("profil sabiti dışarı açık", () => {
    expect(DESPATCH_PROFILES.temel).toBe("TEMELIRSALIYE");
  });
});
