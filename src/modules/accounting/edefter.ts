/**
 * e-Defter (XBRL-GL) — yevmiye ve kebir defteri.
 *
 * 1 OCAK 2027'DEN İTİBAREN ZORUNLU: e-Fatura kapsamındaki her mükellef
 * defterlerini elektronik tutmak zorunda. Kâğıt yevmiye defteri tasdik
 * ettirme dönemi bitiyor.
 *
 * e-DEFTER BİR RAPOR DEĞİL, DEFTERİN KENDİSİDİR. Ay bittikten sonra
 * yevmiye ve kebir XBRL-GL biçiminde üretilir, imzalanır ve BERAT
 * dosyası GİB'e yüklenir. Bu yüzden içeriği DEĞİŞTİRİLEMEZ olmalıdır —
 * yevmiye fişlerinin dokunulmazlığı tam olarak bunun için var.
 *
 * BURADA ÜRETİLİR, İMZALANMAZ VE GÖNDERİLMEZ. Mali mühür ve GİB
 * yüklemesi mali müşavirin ya da entegratörün işidir; anayasadaki
 * "resmî beyan göndermeyi sistem yapmaz" kuralı burada da geçerlidir.
 *
 * NUMARALANDIRMA KESİNTİSİZ OLMALIDIR. Yevmiye madde numarası bir defter
 * içinde 1'den başlar ve atlamaz; atlama, GİB kontrolünde defterin
 * reddedilmesi demektir.
 */

import { account } from "./accounts.js";

export class EDefterError extends Error {
  readonly code = "edefter";
  constructor(message: string) {
    super(message);
    this.name = "EDefterError";
  }
}

export interface DefterEntry {
  readonly documentNo: string;
  readonly entryDate: Date;
  readonly description: string;
  readonly lines: readonly {
    lineNo: number;
    accountCode: string;
    debit: number;
    credit: number;
    description: string;
  }[];
}

export interface DefterParty {
  readonly legalName: string;
  readonly taxId: string;
}

export interface DefterPeriod {
  readonly year: number;
  readonly month: number;
}

/** Ay içindeki fişleri kontrol eder — defter üretilmeden önce. */
export function validateDefter(
  entries: readonly DefterEntry[],
  period: DefterPeriod,
): readonly string[] {
  const problems: string[] = [];

  if (entries.length === 0) {
    problems.push(
      `${period.year}/${String(period.month).padStart(2, "0")} döneminde hiç yevmiye kaydı yok. ` +
        `Boş defter üretmek, o ay hiç işlem olmadığını beyan etmektir.`,
    );
    return problems;
  }

  const from = new Date(Date.UTC(period.year, period.month - 1, 1));
  const to = new Date(Date.UTC(period.year, period.month, 1));

  let index = 0;
  for (const e of entries) {
    index += 1;

    // DÖNEM DIŞI FİŞ DEFTERE GİRMEZ.
    if (e.entryDate < from || e.entryDate >= to) {
      problems.push(
        `${e.documentNo} fişi ${e.entryDate.toISOString().slice(0, 10)} tarihli; ` +
          `bu dönemin defterine giremez.`,
      );
    }

    const debit = e.lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
    const credit = e.lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
    if (debit !== credit) {
      problems.push(
        `${e.documentNo} fişi denk değil (${debit / 100} / ${credit / 100}); ` +
          `denksiz fiş içeren defter GİB tarafından reddedilir.`,
      );
    }

    for (const l of e.lines) {
      try {
        account(l.accountCode);
      } catch {
        problems.push(
          `${e.documentNo} fişinde plan dışı hesap: ${l.accountCode}. e-Defterde ` +
            `Tek Düzen Hesap Planı dışında hesap kullanılamaz.`,
        );
      }
    }
  }
  void index;

  return problems;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amt(n: number): string {
  return n.toFixed(2);
}

function dateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * YEVMİYE DEFTERİ (XBRL-GL).
 *
 * Madde numarası defter içinde 1'den başlar ve ATLAMAZ. Fişin kendi
 * belge numarası ayrıca taşınır; ikisi farklı şeylerdir ve karıştırmak
 * denetimde "kayıp madde" sorusunu doğurur.
 */
export function buildYevmiyeXml(input: {
  company: DefterParty;
  period: DefterPeriod;
  entries: readonly DefterEntry[];
}): string {
  const problems = validateDefter(input.entries, input.period);
  if (problems.length > 0) {
    throw new EDefterError(
      `e-Defter üretilemedi; ${problems.length} sorun var:\n— ` + problems.join("\n— "),
    );
  }

  const sorted = [...input.entries].sort(
    (a, b) => a.entryDate.getTime() - b.entryDate.getTime() || a.documentNo.localeCompare(b.documentNo),
  );

  const from = new Date(Date.UTC(input.period.year, input.period.month - 1, 1));
  const to = new Date(Date.UTC(input.period.year, input.period.month, 0));

  const entries = sorted
    .map((e, i) => {
      const lines = e.lines
        .map(
          (l) => `        <gl-cor:entryDetail>
          <gl-cor:lineNumberCounter>${l.lineNo}</gl-cor:lineNumberCounter>
          <gl-cor:accountMainID>${esc(l.accountCode)}</gl-cor:accountMainID>
          <gl-cor:accountMainDescription>${esc(account(l.accountCode).name)}</gl-cor:accountMainDescription>
          <gl-cor:amount>${amt(l.debit > 0 ? l.debit : l.credit)}</gl-cor:amount>
          <gl-cor:debitCreditCode>${l.debit > 0 ? "D" : "C"}</gl-cor:debitCreditCode>
          <gl-cor:postingDate>${dateOf(e.entryDate)}</gl-cor:postingDate>
          <gl-cor:detailComment>${esc(l.description)}</gl-cor:detailComment>
        </gl-cor:entryDetail>`,
        )
        .join("\n");

      return `      <gl-cor:entryHeader>
        <gl-cor:entryNumber>${i + 1}</gl-cor:entryNumber>
        <gl-cor:entryComment>${esc(e.description)}</gl-cor:entryComment>
        <gl-cor:enteredDate>${dateOf(e.entryDate)}</gl-cor:enteredDate>
        <gl-bus:entryNumberCounter>${esc(e.documentNo)}</gl-bus:entryNumberCounter>
${lines}
      </gl-cor:entryHeader>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
            xmlns:gl-cor="http://www.xbrl.org/int/gl/cor/2006-10-25"
            xmlns:gl-bus="http://www.xbrl.org/int/gl/bus/2006-10-25"
            xmlns:edefter="http://www.edefter.gov.tr">
  <gl-cor:accountingEntries>
    <gl-cor:documentInfo>
      <gl-cor:entriesType>journal</gl-cor:entriesType>
      <gl-cor:uniqueID>${input.company.taxId}-${input.period.year}${String(input.period.month).padStart(2, "0")}-Y-0000</gl-cor:uniqueID>
      <gl-cor:creationDate>${dateOf(to)}</gl-cor:creationDate>
      <gl-cor:periodCoveredStart>${dateOf(from)}</gl-cor:periodCoveredStart>
      <gl-cor:periodCoveredEnd>${dateOf(to)}</gl-cor:periodCoveredEnd>
      <gl-bus:defterTuru>Y</gl-bus:defterTuru>
    </gl-cor:documentInfo>
    <gl-cor:entityInformation>
      <gl-cor:organizationIdentifiers>
        <gl-cor:organizationIdentifier>${esc(input.company.taxId)}</gl-cor:organizationIdentifier>
        <gl-cor:organizationDescription>${esc(input.company.legalName)}</gl-cor:organizationDescription>
      </gl-cor:organizationIdentifiers>
    </gl-cor:entityInformation>
${entries}
  </gl-cor:accountingEntries>
</xbrli:xbrl>
`;
}

/**
 * KEBİR DEFTERİ — hesap bazında toplamlar.
 *
 * Yevmiye "ne zaman ne oldu"yu, kebir "hangi hesapta ne birikti"yi
 * gösterir. GİB ikisini birlikte ister; yalnızca biri yüklenirse defter
 * eksik sayılır.
 */
export function buildKebirXml(input: {
  company: DefterParty;
  period: DefterPeriod;
  totals: readonly { accountCode: string; debit: number; credit: number }[];
}): string {
  const from = new Date(Date.UTC(input.period.year, input.period.month - 1, 1));
  const to = new Date(Date.UTC(input.period.year, input.period.month, 0));

  const rows = [...input.totals]
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
    .map(
      (t) => `      <gl-cor:entryHeader>
        <gl-cor:accountMainID>${esc(t.accountCode)}</gl-cor:accountMainID>
        <gl-cor:accountMainDescription>${esc(account(t.accountCode).name)}</gl-cor:accountMainDescription>
        <gl-bus:totalDebit>${amt(t.debit)}</gl-bus:totalDebit>
        <gl-bus:totalCredit>${amt(t.credit)}</gl-bus:totalCredit>
      </gl-cor:entryHeader>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
            xmlns:gl-cor="http://www.xbrl.org/int/gl/cor/2006-10-25"
            xmlns:gl-bus="http://www.xbrl.org/int/gl/bus/2006-10-25">
  <gl-cor:accountingEntries>
    <gl-cor:documentInfo>
      <gl-cor:entriesType>ledger</gl-cor:entriesType>
      <gl-cor:uniqueID>${input.company.taxId}-${input.period.year}${String(input.period.month).padStart(2, "0")}-K-0000</gl-cor:uniqueID>
      <gl-cor:periodCoveredStart>${dateOf(from)}</gl-cor:periodCoveredStart>
      <gl-cor:periodCoveredEnd>${dateOf(to)}</gl-cor:periodCoveredEnd>
      <gl-bus:defterTuru>K</gl-bus:defterTuru>
    </gl-cor:documentInfo>
    <gl-cor:entityInformation>
      <gl-cor:organizationIdentifiers>
        <gl-cor:organizationIdentifier>${esc(input.company.taxId)}</gl-cor:organizationIdentifier>
        <gl-cor:organizationDescription>${esc(input.company.legalName)}</gl-cor:organizationDescription>
      </gl-cor:organizationIdentifiers>
    </gl-cor:entityInformation>
${rows}
  </gl-cor:accountingEntries>
</xbrli:xbrl>
`;
}
