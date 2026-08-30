/**
 * e-Defter ve KDV beyannamesi taslağı.
 *
 * İkisi de BEYAN DEĞİL, BEYANIN HAZIRLIĞIDIR. Anayasa gereği resmî beyan
 * göndermeyi bu sistem yapmaz; ama taslağı hazırlamak, ay sonunda dört
 * saatlik bir işi dört dakikaya indirir.
 *
 * En kritik testler "üretme" testleri değil, "ÜRETME" testleridir: denksiz
 * fiş içeren bir defter GİB tarafından reddedilir ve reddedilen defter,
 * hiç üretilmemiş defterden kötüdür — çünkü üretildiği sanılır.
 */

import { describe, expect, it } from "vitest";
import {
  buildKebirXml,
  buildYevmiyeXml,
  validateDefter,
  EDefterError,
  type DefterEntry,
} from "../src/modules/accounting/edefter.js";
import { buildVatReturn } from "../src/modules/accounting/vat-return.js";

const company = { legalName: "Orthaus Makina Sanayi A.Ş.", taxId: "1234567890" };
const period = { year: 2026, month: 6 };

const entry = (over: Partial<DefterEntry> = {}): DefterEntry => ({
  documentNo: "YEV2026000001",
  entryDate: new Date("2026-06-15T00:00:00.000Z"),
  description: "Satış faturası",
  lines: [
    { lineNo: 1, accountCode: "120", debit: 1200, credit: 0, description: "Alıcı" },
    { lineNo: 2, accountCode: "600", debit: 0, credit: 1000, description: "Satış" },
    { lineNo: 3, accountCode: "391", debit: 0, credit: 200, description: "KDV" },
  ],
  ...over,
});

describe("defter denetimi", () => {
  it("geçerli fiş sorunsuz geçer", () => {
    expect(validateDefter([entry()], period)).toEqual([]);
  });

  it("BOŞ DEFTER ÜRETİLMEZ", () => {
    // Boş defter, o ay hiç işlem olmadığını beyan etmektir.
    const p = validateDefter([], period);
    expect(p[0]).toContain("hiç yevmiye kaydı yok");
  });

  it("DÖNEM DIŞI FİŞ DEFTERE GİREMEZ", () => {
    const p = validateDefter([entry({ entryDate: new Date("2026-07-02") })], period);
    expect(p[0]).toContain("bu dönemin defterine giremez");
  });

  it("DENKSİZ FİŞ DEFTERİ REDDETTİRİR", () => {
    const p = validateDefter(
      [
        entry({
          lines: [
            { lineNo: 1, accountCode: "120", debit: 1200, credit: 0, description: "a" },
            { lineNo: 2, accountCode: "600", debit: 0, credit: 900, description: "b" },
          ],
        }),
      ],
      period,
    );
    expect(p[0]).toContain("denk değil");
    expect(p[0]).toContain("GİB tarafından reddedilir");
  });

  it("plan dışı hesap yakalanır", () => {
    const p = validateDefter(
      [
        entry({
          lines: [
            { lineNo: 1, accountCode: "999", debit: 10, credit: 0, description: "a" },
            { lineNo: 2, accountCode: "600", debit: 0, credit: 10, description: "b" },
          ],
        }),
      ],
      period,
    );
    expect(p[0]).toContain("plan dışı hesap");
  });
});

describe("yevmiye defteri XML", () => {
  const xml = buildYevmiyeXml({ company, period, entries: [entry(), entry({ documentNo: "YEV2026000002" })] });

  it("XBRL-GL yapısı doğru", () => {
    expect(xml).toContain("<gl-cor:entriesType>journal</gl-cor:entriesType>");
    expect(xml).toContain("<gl-bus:defterTuru>Y</gl-bus:defterTuru>");
  });

  it("MADDE NUMARASI 1'DEN BAŞLAR VE ATLAMAZ", () => {
    // Atlama, GİB kontrolünde "kayıp madde" sorusunu doğurur.
    expect(xml).toContain("<gl-cor:entryNumber>1</gl-cor:entryNumber>");
    expect(xml).toContain("<gl-cor:entryNumber>2</gl-cor:entryNumber>");
    expect(xml).not.toContain("<gl-cor:entryNumber>3</gl-cor:entryNumber>");
  });

  it("fiş belge numarası ayrıca taşınır", () => {
    // Madde numarası ile belge numarası farklı şeylerdir.
    expect(xml).toContain("<gl-bus:entryNumberCounter>YEV2026000001</gl-bus:entryNumberCounter>");
  });

  it("BORÇ VE ALACAK KODLA AYRILIR", () => {
    expect(xml).toContain("<gl-cor:debitCreditCode>D</gl-cor:debitCreditCode>");
    expect(xml).toContain("<gl-cor:debitCreditCode>C</gl-cor:debitCreditCode>");
  });

  it("hesap adı da yazılır — kod tek başına okunmaz", () => {
    expect(xml).toContain("<gl-cor:accountMainDescription>Alıcılar</gl-cor:accountMainDescription>");
  });

  it("mükellef kimliği başlıkta", () => {
    expect(xml).toContain("<gl-cor:organizationIdentifier>1234567890</gl-cor:organizationIdentifier>");
  });

  it("dönem aralığı doğru", () => {
    expect(xml).toContain("<gl-cor:periodCoveredStart>2026-06-01</gl-cor:periodCoveredStart>");
    expect(xml).toContain("<gl-cor:periodCoveredEnd>2026-06-30</gl-cor:periodCoveredEnd>");
  });

  it("SORUNLU DEFTER ÜRETİLMEZ", () => {
    expect(() => buildYevmiyeXml({ company, period, entries: [] })).toThrow(EDefterError);
    expect(() =>
      buildYevmiyeXml({
        company,
        period,
        entries: [entry({ entryDate: new Date("2026-08-01") })],
      }),
    ).toThrow(/sorun var/);
  });
});

describe("kebir defteri XML", () => {
  const xml = buildKebirXml({
    company,
    period,
    totals: [
      { accountCode: "120", debit: 1200, credit: 0 },
      { accountCode: "600", debit: 0, credit: 1000 },
    ],
  });

  it("kebir türü ayrı işaretlenir", () => {
    expect(xml).toContain("<gl-cor:entriesType>ledger</gl-cor:entriesType>");
    expect(xml).toContain("<gl-bus:defterTuru>K</gl-bus:defterTuru>");
  });

  it("hesap bazında toplamlar yazılır", () => {
    expect(xml).toContain("<gl-bus:totalDebit>1200.00</gl-bus:totalDebit>");
    expect(xml).toContain("<gl-bus:totalCredit>1000.00</gl-bus:totalCredit>");
  });
});

describe("KDV beyannamesi taslağı", () => {
  const base = {
    year: 2026,
    month: 6,
    salesBase: 100_000,
    outputVat: 20_000,
    inputVat: 12_000,
    carriedForward: 0,
    ledgerBalanced: true,
  };

  it("ödenecek KDV hesaplanır", () => {
    const r = buildVatReturn(base);
    expect(r.payable).toBe(8_000);
    expect(r.carryForward).toBe(0);
    expect(r.summary).toContain("ÖDENECEK");
  });

  it("DEVREDEN KDV İNDİRİME EKLENİR", () => {
    // Devir kaybolursa mükellef kendi parasını devlete bırakır.
    const r = buildVatReturn({ ...base, carriedForward: 5_000 });
    expect(r.payable).toBe(3_000);
  });

  it("İNDİRİM FAZLAYSA SONRAKİ AYA DEVREDER", () => {
    const r = buildVatReturn({ ...base, inputVat: 30_000 });
    expect(r.payable).toBe(0);
    expect(r.carryForward).toBe(10_000);
    expect(r.warnings.some((w) => w.includes("devreden"))).toBe(true);
  });

  it("MİZAN DENK DEĞİLSE BEYANNAME GÜVENİLMEZ", () => {
    const r = buildVatReturn({ ...base, ledgerBalanced: false });
    expect(r.warnings[0]).toContain("MİZAN DENK DEĞİL");
  });

  it("SATIŞ VARKEN KDV SIFIRSA UYARIR", () => {
    const r = buildVatReturn({ ...base, outputVat: 0 });
    expect(r.warnings.some((w) => w.includes("KDV işlenmemiş"))).toBe(true);
  });

  it("İNDİRİLECEK KDV SIFIRSA UYARIR", () => {
    // Alış faturaları muhasebeleşmemişse ödenecek KDV fazla çıkar.
    const r = buildVatReturn({ ...base, inputVat: 0 });
    expect(r.warnings.some((w) => w.includes("OLDUĞUNDAN YÜKSEK"))).toBe(true);
  });

  it("dönem etiketi iki haneli aydır", () => {
    expect(buildVatReturn({ ...base, month: 3 }).period).toBe("2026/03");
  });
});
