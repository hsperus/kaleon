/**
 * Uyumsoft e-Fatura adaptörü.
 *
 * Gelen yapı UBL-TR'nin sadeleştirilmiş hâlidir. `normalize` SAF bir
 * fonksiyondur: I/O yapmaz, ağa çıkmaz, veritabanı bilmez. Bu yüzden
 * bozuk belge senaryolarının hepsi birim testiyle sınanabilir — gerçek
 * entegratöre bağlanmadan.
 *
 * DÖNÜŞTÜRÜCÜNÜN TEMEL SORUMLULUĞU EKSİĞİ FARK ETMEKTİR.
 * Bir alan yoksa varsayılan uydurmak, hatayı sessizce ileri taşır ve
 * ay sonunda tutmayan bir mizan olarak geri döner. Burada eksik alan
 * açık bir dönüşüm hatasıdır; ham veri saklanır, insan inceler.
 */

import type { Invoice, InvoiceLine } from "../../documents/three-way-match.js";
import {
  IntegrationError,
  type FetchWindow,
  type InvoiceAdapter,
  type NormalizeResult,
  type RawDocument,
} from "../adapter.js";

/** Entegratörden gelen belge yapısı (UBL-TR sadeleştirilmiş). */
export interface UyumsoftInvoice {
  readonly UUID?: string;
  readonly ID?: string;
  readonly IssueDate?: string;
  readonly DocumentCurrencyCode?: string;
  readonly AccountingSupplierParty?: {
    readonly PartyIdentification?: { readonly ID?: string; readonly schemeID?: string };
    readonly PartyName?: { readonly Name?: string };
  };
  readonly InvoiceLine?: readonly {
    readonly ID?: string | number;
    readonly InvoicedQuantity?: number | string;
    readonly Item?: { readonly SellersItemIdentification?: { readonly ID?: string } };
    readonly Price?: { readonly PriceAmount?: number | string; readonly currencyID?: string };
    readonly OrderLineReference?: {
      readonly OrderReference?: { readonly ID?: string };
      readonly LineID?: number | string;
    };
  }[];
}

/** Ağ katmanı — test edilebilirlik için dışarıdan verilir. */
export interface UyumsoftTransport {
  authenticate(): Promise<void>;
  list(window: FetchWindow): Promise<readonly { id: string; receivedAt: string; document: unknown }[]>;
}

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    // Türk biçimi (1.750,00) ve nokta biçimi (1750.00) birlikte desteklenir.
    const normalized = /,\d{1,2}$/.test(v) ? v.replace(/\./g, "").replace(",", ".") : v;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export class UyumsoftInvoiceAdapter implements InvoiceAdapter {
  readonly source = "uyumsoft" as const;
  readonly kind = "einvoice" as const;
  readonly #transport: UyumsoftTransport;

  constructor(transport: UyumsoftTransport) {
    this.#transport = transport;
  }

  async connect(): Promise<void> {
    await this.#transport.authenticate();
  }

  async fetch(window: FetchWindow): Promise<readonly RawDocument[]> {
    const rows = await this.#transport.list(window);
    return rows.map((r) => ({
      externalId: r.id,
      receivedAt: r.receivedAt,
      payload: r.document,
    }));
  }

  normalize(raw: RawDocument): NormalizeResult<Invoice> {
    const doc = raw.payload as UyumsoftInvoice | null;
    if (!doc || typeof doc !== "object") {
      return { ok: false, code: "payload_not_object", message: "Belge gövdesi okunamadı." };
    }

    const documentNo = doc.ID?.trim();
    if (!documentNo) {
      return { ok: false, code: "missing_document_no", message: "Fatura numarası (ID) yok." };
    }

    const vkn = doc.AccountingSupplierParty?.PartyIdentification?.ID?.trim();
    const supplierName = doc.AccountingSupplierParty?.PartyName?.Name?.trim();
    if (!vkn && !supplierName) {
      return {
        ok: false,
        code: "missing_supplier",
        message: `${documentNo}: tedarikçi kimliği de unvanı da yok; varlık çözümlenemez.`,
      };
    }

    const currency = doc.DocumentCurrencyCode?.trim();
    if (!currency) {
      return {
        ok: false,
        code: "missing_currency",
        message: `${documentNo}: para birimi yok. Varsayılan atamak tutar hatasına yol açar.`,
      };
    }

    if (!doc.IssueDate || Number.isNaN(Date.parse(doc.IssueDate))) {
      return { ok: false, code: "invalid_issue_date", message: `${documentNo}: düzenleme tarihi geçersiz.` };
    }

    const rawLines = doc.InvoiceLine ?? [];
    if (rawLines.length === 0) {
      return { ok: false, code: "no_lines", message: `${documentNo}: fatura kalemi yok.` };
    }

    const lines: InvoiceLine[] = [];
    for (const [index, l] of rawLines.entries()) {
      const lineNo = Number(l.ID ?? index + 1);
      const quantity = toNumber(l.InvoicedQuantity);
      const unitPrice = toNumber(l.Price?.PriceAmount);
      const itemId = l.Item?.SellersItemIdentification?.ID?.trim();

      if (quantity === null || quantity <= 0) {
        return {
          ok: false,
          code: "invalid_quantity",
          message: `${documentNo} kalem ${lineNo}: miktar okunamadı veya pozitif değil.`,
        };
      }
      if (unitPrice === null || unitPrice < 0) {
        return {
          ok: false,
          code: "invalid_price",
          message: `${documentNo} kalem ${lineNo}: birim fiyat okunamadı.`,
        };
      }
      if (!itemId) {
        return {
          ok: false,
          code: "missing_item",
          message: `${documentNo} kalem ${lineNo}: malzeme kodu yok; stok eşleşmesi kurulamaz.`,
        };
      }

      const poId = l.OrderLineReference?.OrderReference?.ID?.trim() ?? null;
      const poLineRaw = l.OrderLineReference?.LineID;
      const poLineNo = poLineRaw === undefined || poLineRaw === null ? null : Number(poLineRaw);

      lines.push({
        lineNo,
        // Sipariş referansı YOKSA null bırakılır — uydurulmaz.
        // Üç yönlü eşleştirme bunu "siparişsiz kalem" olarak bloklayacak,
        // ki doğrusu budur: siparişsiz fatura onaya gidemez.
        poId,
        poLineNo: poId && Number.isFinite(poLineNo) ? poLineNo : null,
        itemId,
        quantity,
        unitPrice,
        currency: l.Price?.currencyID?.trim() ?? currency,
      });
    }

    return {
      ok: true,
      value: {
        id: doc.UUID?.trim() || `${this.source}:${documentNo}`,
        // Varlık çözümlemesi ayrı bir adımdır; burada entegratörün verdiği
        // kimlik taşınır. Partner eşleştirmesi Entity Resolution'ın işi.
        partnerId: vkn ?? supplierName!,
        documentNo,
        issuedAt: new Date(doc.IssueDate).toISOString(),
        currency,
        lines,
      },
    };
  }
}

/** Ağ hatalarını sınıflandırılmış hataya çeviren yardımcı. */
export function classifyHttp(status: number, body: string): IntegrationError {
  if (status === 401 || status === 403) {
    return new IntegrationError(
      `Entegratör kimlik doğrulaması reddetti (${status}). Senkron durduruldu.`,
      "auth",
      "unauthorized",
    );
  }
  if (status === 429 || status >= 500) {
    return new IntegrationError(`Entegratör geçici hata (${status}).`, "network", `http_${status}`);
  }
  if (status >= 400) {
    return new IntegrationError(`Entegratör isteği reddetti (${status}): ${body}`, "data", `http_${status}`);
  }
  return new IntegrationError(`Beklenmeyen durum (${status})`, "unknown", `http_${status}`);
}
