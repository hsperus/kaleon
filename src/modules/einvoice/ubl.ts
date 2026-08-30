/**
 * UBL-TR 1.2 e-Fatura / e-Arşiv belgesi üretimi.
 *
 * TÜRKİYE'DE FATURA ARTIK BİR XML BELGESİDİR. 3 milyon TL üstü cirolu
 * her mükellef e-Fatura kullanmak zorundadır; kâğıt fatura kesme imkânı
 * yoktur. Bu yüzden "fatura kesme" özelliği, geçerli UBL-TR üretmeden
 * TAMAMLANMIŞ SAYILMAZ.
 *
 * GÖNDERİM BURADA YAPILMAZ. Belge üretilir ve entegratöre teslim
 * edilmeye hazır hâle gelir; gönderim ve GİB'den gelen cevap ayrı bir
 * adımdır. Anayasanın "AI hazırlar, entegratör gönderir" ayrımı tam
 * olarak burada durur.
 *
 * EKSİK ALANLA BELGE ÜRETİLMEZ. Üretilseydi entegratör onu reddeder ve
 * kullanıcı, kendi sisteminde görünmeyen bir hatayı anlamaya çalışırdı.
 * Eksikler burada, Türkçe ve alan alan söylenir.
 *
 * e-FATURA MI e-ARŞİV Mİ: alıcı e-Fatura mükellefiyse e-Fatura,
 * değilse e-Arşiv. Yanlış seçim belgeyi geçersiz kılar; bu yüzden
 * "bilinmiyor" ayrı bir durumdur ve tahmin edilmez.
 */

export const UBL_VERSION = "2.1";
export const CUSTOMIZATION_ID = "TR1.2";

/** Fatura profilleri. */
export const PROFILES = {
  /** e-Fatura, alıcı yanıtı beklenmez. */
  temel: "TEMELFATURA",
  /** e-Fatura, alıcı kabul/ret yanıtı verebilir. */
  ticari: "TICARIFATURA",
  /** e-Arşiv — alıcı e-Fatura mükellefi değil. */
  earsiv: "EARSIVFATURA",
} as const;
export type Profile = (typeof PROFILES)[keyof typeof PROFILES];

export class EInvoiceError extends Error {
  readonly code = "einvoice";
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "EInvoiceError";
    this.missing = missing;
  }
}

export interface Party {
  readonly legalName: string;
  /** VKN (10 hane) veya TCKN (11 hane). */
  readonly taxId: string | null;
  readonly taxOffice: string | null;
  readonly addressLine: string | null;
  readonly district: string | null;
  readonly city: string | null;
  readonly postalCode?: string | null;
  readonly country?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface InvoiceLineInput {
  readonly lineNo: number;
  readonly itemName: string;
  readonly quantity: number;
  readonly uom: string;
  readonly unitPrice: number;
  readonly discountAmount: number;
  readonly netAmount: number;
  readonly vatRate: number;
  readonly vatAmount: number;
}

export interface InvoiceInput {
  readonly ettn: string;
  readonly documentNo: string;
  readonly issueDate: Date;
  readonly currency: string;
  readonly exchangeRate?: number;
  readonly supplier: Party;
  readonly customer: Party;
  readonly lines: readonly InvoiceLineInput[];
  readonly netAmount: number;
  readonly discountAmount: number;
  readonly vatAmount: number;
  readonly totalAmount: number;
  readonly note?: string | null;
}

/** UBL birim kodları (UN/ECE Rec 20) — Türkçe birimlerin karşılığı. */
const UOM_CODES: Readonly<Record<string, string>> = {
  adet: "C62",
  kg: "KGM",
  gr: "GRM",
  ton: "TNE",
  lt: "LTR",
  m: "MTR",
  m2: "MTK",
  m3: "MTQ",
  paket: "PK",
  koli: "BX",
  kutu: "BX",
  saat: "HUR",
  gun: "DAY",
};

export function uomCode(uom: string): string {
  return UOM_CODES[uom.toLocaleLowerCase("tr")] ?? "C62";
}

/** Vergi kimliğinin biçimi doğru mu — GİB reddetmeden önce biz yakalayalım. */
export function validateTaxId(taxId: string): { valid: boolean; kind: "vkn" | "tckn" | null } {
  const digits = taxId.trim();
  if (/^\d{10}$/.test(digits)) return { valid: true, kind: "vkn" };
  if (/^\d{11}$/.test(digits)) return { valid: true, kind: "tckn" };
  return { valid: false, kind: null };
}

/**
 * Belgeyi üretmeden ÖNCE eksikleri toplar.
 *
 * TEK TEK DEĞİL TOPLU SÖYLENİR. Her seferinde bir eksik söylenseydi
 * kullanıcı beş kez deneyip beş kez farklı hata alırdı; hepsi bir arada
 * verilince bir kerede tamamlanır.
 */
export function missingFields(input: InvoiceInput): readonly string[] {
  const missing: string[] = [];

  const checkParty = (p: Party, who: string): void => {
    if (!p.legalName?.trim()) missing.push(`${who}: unvan`);
    if (!p.taxId?.trim()) missing.push(`${who}: vergi/TC kimlik numarası`);
    else if (!validateTaxId(p.taxId).valid) {
      missing.push(`${who}: vergi numarası 10 hane (VKN) veya 11 hane (TCKN) olmalı — "${p.taxId}"`);
    }
    if (!p.taxOffice?.trim()) missing.push(`${who}: vergi dairesi`);
    if (!p.addressLine?.trim()) missing.push(`${who}: adres`);
    if (!p.district?.trim()) missing.push(`${who}: ilçe`);
    if (!p.city?.trim()) missing.push(`${who}: il`);
  };

  checkParty(input.supplier, "Satıcı");
  checkParty(input.customer, "Alıcı");

  if (input.lines.length === 0) missing.push("Fatura kalemi yok");
  if (!input.ettn?.trim()) missing.push("ETTN");
  if (input.currency !== "TRY" && !input.exchangeRate) {
    missing.push("Yabancı para faturada kur");
  }

  return missing;
}

/** XML'de özel karakterler kaçırılır; aksi hâlde belge bozulur. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Tutarlar UBL'de iki ondalıkla ve nokta ayırıcıyla yazılır. */
function amt(n: number): string {
  return n.toFixed(2);
}

function qty(n: number): string {
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function dateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function timeOf(d: Date): string {
  return d.toISOString().slice(11, 19);
}

function partyXml(p: Party, tag: "AccountingSupplierParty" | "AccountingCustomerParty"): string {
  const kind = p.taxId && validateTaxId(p.taxId).kind === "tckn" ? "TCKN" : "VKN";
  return `  <cac:${tag}>
    <cac:Party>
      <cbc:WebsiteURI/>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${kind}">${esc(p.taxId ?? "")}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>${esc(p.legalName)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${esc(p.addressLine ?? "")}</cbc:StreetName>
        <cbc:CitySubdivisionName>${esc(p.district ?? "")}</cbc:CitySubdivisionName>
        <cbc:CityName>${esc(p.city ?? "")}</cbc:CityName>
${p.postalCode ? `        <cbc:PostalZone>${esc(p.postalCode)}</cbc:PostalZone>\n` : ""}        <cac:Country>
          <cbc:Name>${esc(p.country ?? "Türkiye")}</cbc:Name>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cac:TaxScheme>
          <cbc:Name>${esc(p.taxOffice ?? "")}</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
${
  p.email || p.phone
    ? `      <cac:Contact>
${p.phone ? `        <cbc:Telephone>${esc(p.phone)}</cbc:Telephone>\n` : ""}${p.email ? `        <cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail>\n` : ""}      </cac:Contact>
`
    : ""
}    </cac:Party>
  </cac:${tag}>`;
}

function lineXml(l: InvoiceLineInput, currency: string): string {
  return `  <cac:InvoiceLine>
    <cbc:ID>${l.lineNo}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${uomCode(l.uom)}">${qty(l.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${amt(l.netAmount)}</cbc:LineExtensionAmount>
${
  l.discountAmount > 0
    ? `    <cac:AllowanceCharge>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:Amount currencyID="${currency}">${amt(l.discountAmount)}</cbc:Amount>
    </cac:AllowanceCharge>
`
    : ""
}    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${currency}">${amt(l.vatAmount)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${amt(l.netAmount)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${amt(l.vatAmount)}</cbc:TaxAmount>
        <cbc:Percent>${l.vatRate.toFixed(2)}</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme>
            <cbc:Name>KDV</cbc:Name>
            <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(l.itemName)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${amt(l.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
}

/** KDV oranına göre kırılım — fatura üzerinde gösterilmesi zorunludur. */
function taxTotalXml(input: InvoiceInput): string {
  const byRate = new Map<number, { base: number; tax: number }>();
  for (const l of input.lines) {
    const b = byRate.get(l.vatRate) ?? { base: 0, tax: 0 };
    b.base += l.netAmount;
    b.tax += l.vatAmount;
    byRate.set(l.vatRate, b);
  }

  const subtotals = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([rate, v]) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${input.currency}">${amt(v.base)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${input.currency}">${amt(v.tax)}</cbc:TaxAmount>
      <cbc:Percent>${rate.toFixed(2)}</cbc:Percent>
      <cac:TaxCategory>
        <cac:TaxScheme>
          <cbc:Name>KDV</cbc:Name>
          <cbc:TaxTypeCode>0015</cbc:TaxTypeCode>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join("\n");

  return `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${amt(input.vatAmount)}</cbc:TaxAmount>
${subtotals}
  </cac:TaxTotal>`;
}

/**
 * UBL-TR fatura XML'i üretir.
 *
 * `profile` alıcının mükellefiyetinden gelir ve TAHMİN EDİLMEZ: bilinmiyorsa
 * çağıran karar vermelidir. Yanlış profil, belgenin GİB tarafından
 * reddedilmesi demektir.
 */
export function buildInvoiceXml(input: InvoiceInput, profile: Profile): string {
  const missing = missingFields(input);
  if (missing.length > 0) {
    throw new EInvoiceError(
      `e-Fatura üretilemedi; ${missing.length} zorunlu alan eksik:\n— ` + missing.join("\n— "),
      missing,
    );
  }

  const lines = input.lines.map((l) => lineXml(l, input.currency)).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>${UBL_VERSION}</cbc:UBLVersionID>
  <cbc:CustomizationID>${CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${profile}</cbc:ProfileID>
  <cbc:ID>${esc(input.documentNo)}</cbc:ID>
  <cbc:CopyIndicator>false</cbc:CopyIndicator>
  <cbc:UUID>${esc(input.ettn)}</cbc:UUID>
  <cbc:IssueDate>${dateOf(input.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${timeOf(input.issueDate)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
${input.note ? `  <cbc:Note>${esc(input.note)}</cbc:Note>\n` : ""}  <cbc:DocumentCurrencyCode>${input.currency}</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>
${
  input.currency !== "TRY" && input.exchangeRate
    ? `  <cac:PricingExchangeRate>
    <cbc:SourceCurrencyCode>${input.currency}</cbc:SourceCurrencyCode>
    <cbc:TargetCurrencyCode>TRY</cbc:TargetCurrencyCode>
    <cbc:CalculationRate>${input.exchangeRate.toFixed(6)}</cbc:CalculationRate>
  </cac:PricingExchangeRate>
`
    : ""
}${partyXml(input.supplier, "AccountingSupplierParty")}
${partyXml(input.customer, "AccountingCustomerParty")}
${taxTotalXml(input)}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${amt(input.netAmount + input.discountAmount)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${amt(input.netAmount)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${amt(input.totalAmount)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${input.currency}">${amt(input.discountAmount)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${amt(input.totalAmount)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>
`;
}

/**
 * Alıcının mükellefiyetine göre profil seçer.
 *
 * BİLİNMİYORSA SEÇİLMEZ. "e-Arşiv varsayalım" demek, e-Fatura mükellefi
 * bir alıcıya yanlış belge göndermek ve faturayı geçersiz kılmaktır.
 */
export function profileFor(einvoiceUser: boolean | null): Profile {
  if (einvoiceUser === null) {
    throw new EInvoiceError(
      "Alıcının e-Fatura mükellefi olup olmadığı bilinmiyor. e-Fatura mükellefine " +
        "e-Arşiv göndermek belgeyi geçersiz kılar; mükellefiyet durumu GİB'den " +
        "sorgulanıp cari kartına işlenmelidir.",
      ["Alıcı: e-Fatura mükellefiyeti"],
    );
  }
  return einvoiceUser ? PROFILES.temel : PROFILES.earsiv;
}
