/**
 * UBL-TR e-İrsaliye (Despatch Advice).
 *
 * 1 TEMMUZ 2026'DAN İTİBAREN ZORUNLU: e-Fatura kayıtlı ve cirosu 10
 * milyon TL üstü mükellef, sevk irsaliyesini kâğıt olarak düzenleyemez.
 * Yani "sevkiyat" özelliği, geçerli e-İrsaliye üretmeden tamamlanmış
 * sayılmaz — mal yolda ve belgesi yoksa araç durdurulur.
 *
 * e-FATURADAN FARKI TUTAR DEĞİL TAŞIMADIR. İrsaliyede fiyat yoktur;
 * asıl bilgi MALIN NEREDEN NEREYE, HANGİ ARAÇLA, KİMİN SÜRÜCÜLÜĞÜNDE
 * gittiğidir. Taşıyıcı ve plaka bilgisi bu yüzden zorunludur ve
 * eksikse belge üretilmez.
 *
 * FİİLİ SEVK ZAMANI ZORUNLUDUR. e-İrsaliye, malın araca yüklendiği anı
 * belgeler; sonradan girilen bir saat, yol denetiminde belgeyi geçersiz
 * kılar.
 */

import { EInvoiceError, uomCode, validateTaxId, type Party } from "./ubl.js";

export const DESPATCH_PROFILES = {
  /** Standart e-İrsaliye. */
  temel: "TEMELIRSALIYE",
} as const;
export type DespatchProfile = (typeof DESPATCH_PROFILES)[keyof typeof DESPATCH_PROFILES];

export interface DespatchLineInput {
  readonly lineNo: number;
  readonly itemName: string;
  readonly quantity: number;
  readonly uom: string;
  /** Parti numarası — parti takipli malzemede irsaliyede görünmelidir. */
  readonly batchNo?: string | null;
}

export interface Shipment {
  /** Taşıyıcı firma unvanı. Kendi aracımızsa kendi unvanımız. */
  readonly carrierName: string | null;
  readonly plateNo: string | null;
  /** Sürücü TC kimlik numarası — yol denetiminde sorulur. */
  readonly driverTckn?: string | null;
  readonly driverName?: string | null;
  /** Malın çıktığı adres; şirket adresinden farklı olabilir. */
  readonly despatchAddress?: string | null;
}

export interface DespatchInput {
  readonly ettn: string;
  readonly documentNo: string;
  /** Belgenin düzenlendiği an. */
  readonly issueDate: Date;
  /** Malın FİİLEN araca yüklendiği an. */
  readonly actualDespatchDate: Date;
  readonly supplier: Party;
  readonly customer: Party;
  readonly shipment: Shipment;
  readonly lines: readonly DespatchLineInput[];
  /** Bu irsaliyenin dayandığı sipariş numarası. */
  readonly orderReference?: string | null;
  readonly note?: string | null;
}

/**
 * Eksik alanları toplar.
 *
 * TAŞIMA BİLGİSİ İRSALİYENİN ÖZÜDÜR ve eksikliği faturadakinden daha
 * ağırdır: plakasız bir irsaliye, yol denetiminde belgesiz mal demektir.
 */
export function missingDespatchFields(input: DespatchInput): readonly string[] {
  const missing: string[] = [];

  const checkParty = (p: Party, who: string): void => {
    if (!p.legalName?.trim()) missing.push(`${who}: unvan`);
    if (!p.taxId?.trim()) missing.push(`${who}: vergi/TC kimlik numarası`);
    else if (!validateTaxId(p.taxId).valid) {
      missing.push(`${who}: vergi numarası 10 veya 11 hane olmalı — "${p.taxId}"`);
    }
    if (!p.addressLine?.trim()) missing.push(`${who}: adres`);
    if (!p.district?.trim()) missing.push(`${who}: ilçe`);
    if (!p.city?.trim()) missing.push(`${who}: il`);
  };

  checkParty(input.supplier, "Gönderici");
  checkParty(input.customer, "Alıcı");

  if (!input.shipment.plateNo?.trim()) {
    missing.push("Taşıma: araç plakası (yol denetiminde zorunlu)");
  }
  if (!input.shipment.carrierName?.trim()) {
    missing.push("Taşıma: taşıyıcı unvanı");
  }
  if (input.shipment.driverTckn && !/^\d{11}$/.test(input.shipment.driverTckn)) {
    missing.push("Taşıma: sürücü TC kimlik numarası 11 hane olmalı");
  }
  if (input.lines.length === 0) missing.push("İrsaliye kalemi yok");
  if (!input.ettn?.trim()) missing.push("ETTN");

  return missing;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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

function partyXml(
  p: Party,
  tag: "DespatchSupplierParty" | "DeliveryCustomerParty",
): string {
  const kind = p.taxId && validateTaxId(p.taxId).kind === "tckn" ? "TCKN" : "VKN";
  return `  <cac:${tag}>
    <cac:Party>
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
        <cac:Country>
          <cbc:Name>${esc(p.country ?? "Türkiye")}</cbc:Name>
        </cac:Country>
      </cac:PostalAddress>
${
  p.taxOffice
    ? `      <cac:PartyTaxScheme>
        <cac:TaxScheme>
          <cbc:Name>${esc(p.taxOffice)}</cbc:Name>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
`
    : ""
}    </cac:Party>
  </cac:${tag}>`;
}

/** Taşıma bloğu — irsaliyenin özü. */
function shipmentXml(s: Shipment, actualDespatch: Date): string {
  return `  <cac:Shipment>
    <cbc:ID>1</cbc:ID>
    <cac:Delivery>
      <cbc:ActualDeliveryDate>${dateOf(actualDespatch)}</cbc:ActualDeliveryDate>
      <cbc:ActualDeliveryTime>${timeOf(actualDespatch)}</cbc:ActualDeliveryTime>
      <cac:CarrierParty>
        <cac:PartyName>
          <cbc:Name>${esc(s.carrierName ?? "")}</cbc:Name>
        </cac:PartyName>
      </cac:CarrierParty>
      <cac:Shipment>
        <cbc:ID>1</cbc:ID>
        <cac:ShipmentStage>
          <cac:TransportMeans>
            <cac:RoadTransport>
              <cbc:LicensePlateID>${esc(s.plateNo ?? "")}</cbc:LicensePlateID>
            </cac:RoadTransport>
          </cac:TransportMeans>
${
  s.driverTckn
    ? `          <cac:DriverPerson>
            <cbc:FirstName>${esc(s.driverName ?? "")}</cbc:FirstName>
            <cbc:NationalityID schemeID="TCKN">${esc(s.driverTckn)}</cbc:NationalityID>
          </cac:DriverPerson>
`
    : ""
}        </cac:ShipmentStage>
      </cac:Shipment>
    </cac:Delivery>
  </cac:Shipment>`;
}

function lineXml(l: DespatchLineInput): string {
  return `  <cac:DespatchLine>
    <cbc:ID>${l.lineNo}</cbc:ID>
    <cbc:DeliveredQuantity unitCode="${uomCode(l.uom)}">${qty(l.quantity)}</cbc:DeliveredQuantity>
    <cac:Item>
      <cbc:Name>${esc(l.itemName)}</cbc:Name>
${
  l.batchNo
    ? `      <cac:ItemInstance>
        <cac:LotIdentification>
          <cbc:LotNumberID>${esc(l.batchNo)}</cbc:LotNumberID>
        </cac:LotIdentification>
      </cac:ItemInstance>
`
    : ""
}    </cac:Item>
  </cac:DespatchLine>`;
}

/**
 * UBL-TR e-İrsaliye XML'i üretir.
 *
 * Fatura gibi burada da EKSİK ALANLA BELGE ÜRETİLMEZ: geçersiz bir
 * irsaliyeyle yola çıkan araç, denetimde belgesiz sayılır.
 */
export function buildDespatchXml(
  input: DespatchInput,
  profile: DespatchProfile = DESPATCH_PROFILES.temel,
): string {
  const missing = missingDespatchFields(input);
  if (missing.length > 0) {
    throw new EInvoiceError(
      `e-İrsaliye üretilemedi; ${missing.length} zorunlu alan eksik:\n— ` + missing.join("\n— "),
      missing,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"
                xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
                xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>${profile}</cbc:ProfileID>
  <cbc:ID>${esc(input.documentNo)}</cbc:ID>
  <cbc:CopyIndicator>false</cbc:CopyIndicator>
  <cbc:UUID>${esc(input.ettn)}</cbc:UUID>
  <cbc:IssueDate>${dateOf(input.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${timeOf(input.issueDate)}</cbc:IssueTime>
  <cbc:DespatchAdviceTypeCode>SEVK</cbc:DespatchAdviceTypeCode>
${input.note ? `  <cbc:Note>${esc(input.note)}</cbc:Note>\n` : ""}  <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>
${
  input.orderReference
    ? `  <cac:OrderReference>
    <cbc:ID>${esc(input.orderReference)}</cbc:ID>
  </cac:OrderReference>
`
    : ""
}${partyXml(input.supplier, "DespatchSupplierParty")}
${partyXml(input.customer, "DeliveryCustomerParty")}
${shipmentXml(input.shipment, input.actualDespatchDate)}
${input.lines.map(lineXml).join("\n")}
</DespatchAdvice>
`;
}
