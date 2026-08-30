/**
 * e-Fatura belgesi üretimi — gerçek fatura verisinden.
 *
 * BELGE ÜRETİLİR, GÖNDERİLMEZ. Gönderim entegratörün işidir ve ayrı bir
 * yetki ister; burada üretilen XML, gönderilmeye HAZIR hâldedir.
 * Anayasadaki "AI hazırlar, entegratör gönderir" ayrımı budur.
 *
 * ETTN BİR KEZ ÜRETİLİR VE SAKLANIR. Her çağrıda yeniden üretilseydi,
 * aynı fatura için iki farklı ETTN'li belge çıkar ve biri gönderildikten
 * sonra diğeri "farklı bir fatura" sayılırdı.
 */

import type { TenantDb } from "./client.js";
import {
  buildInvoiceXml,
  missingFields,
  profileFor,
  EInvoiceError,
  type InvoiceInput,
  type Party,
  type Profile,
} from "../modules/einvoice/ubl.js";
import { amountInWords, vatBreakdown } from "../modules/einvoice/invoice-view.js";
import {
  buildDespatchXml,
  DESPATCH_PROFILES,
  type DespatchProfile,
} from "../modules/einvoice/despatch.js";

export interface EInvoiceDocument {
  readonly documentNo: string;
  readonly ettn: string;
  readonly profile: Profile;
  readonly xml: string;
  readonly byteLength: number;
}


/**
 * Faturanın okunabilir hâli — ekrana ve kâğıda basmak için.
 *
 * XML'DEN AYRI BİR YOL. UBL belgesi entegratör içindir; insan onu
 * okuyamaz. Aynı veriyi ikinci kez üretmek yerine XML'i ayrıştırmak
 * mümkündü ama yanlış olurdu: ayrıştırıcı, belgenin kendisinden
 * sapabilir ve ekranda gösterilen fatura ile gönderilen fatura
 * birbirinden farklı olabilirdi. İkisi de AYNI veritabanı satırından
 * okunuyor.
 */
export interface InvoiceView {
  readonly documentNo: string;
  readonly issuedAt: string;
  readonly status: string;
  readonly currency: string;
  readonly exchangeRate: number | null;
  /** Belge üretilmişse ETTN; üretilmemişse null — uydurulmaz. */
  readonly ettn: string | null;
  readonly einvoiceKind: string | null;
  readonly supplier: Party | null;
  readonly customer: Party;
  readonly lines: readonly {
    lineNo: number;
    description: string;
    quantity: number;
    uom: string;
    unitPrice: number;
    discountPercent: number;
    netAmount: number;
    vatRate: number;
    vatAmount: number;
  }[];
  /** KDV oranı kırılımı — faturanın yasal olarak taşıması gereken özet. */
  readonly vatBreakdown: readonly { rate: number; base: number; amount: number }[];
  readonly netAmount: number;
  readonly discountAmount: number;
  readonly vatAmount: number;
  readonly totalAmount: number;
  /** Tutarın yazıyla hâli — Türk fatura teamülü. */
  readonly totalInWords: string;
}


/**
 * Sevk irsaliyesinin okunabilir hâli.
 *
 * İRSALİYE FATURA DEĞİLDİR ve fatura formunda gösterilemez: üzerinde
 * tutar YOKTUR (mal bedeli faturada söylenir), buna karşılık faturada
 * bulunmayan alanlar taşır — taşıyıcı, plaka, sürücü ve malın FİİLEN
 * araca yüklendiği an. Yol denetiminde sorulan bunlardır.
 */
export interface DespatchView {
  readonly documentNo: string;
  readonly orderNo: string | null;
  readonly shippedAt: string;
  readonly actualDespatchAt: string | null;
  readonly status: string;
  readonly ettn: string | null;
  readonly edespatchStatus: string | null;
  readonly carrierName: string | null;
  readonly plateNo: string | null;
  readonly driverName: string | null;
  /** Deponun ADI — kimliği değil. Kâğıda UUID basılmaz. */
  readonly location: string;
  readonly supplier: Party | null;
  readonly customer: Party;
  readonly lines: readonly {
    lineNo: number;
    itemId: string;
    description: string;
    quantity: number;
    uom: string;
    batchId: string | null;
  }[];
}

export class EInvoiceRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** Şirketin kendi kimliği; yoksa fatura düzenlenemez. */
  async companyProfile(): Promise<Party> {
    const row = await this.#db.companyProfile.findUnique({ where: { id: "singleton" } });
    if (!row) {
      throw new EInvoiceError(
        "Şirket kimliği tanımlı değil. e-Fatura düzenleyenin unvanı, vergi numarası, " +
          "vergi dairesi ve adresi olmadan belge üretilemez.",
        ["Şirket kimliği"],
      );
    }
    return {
      legalName: row.legalName,
      taxId: row.taxId,
      taxOffice: row.taxOffice,
      addressLine: row.addressLine,
      district: row.district,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      email: row.email,
      phone: row.phone,
    };
  }

  async saveCompanyProfile(input: {
    legalName: string;
    taxId: string;
    taxOffice: string;
    addressLine: string;
    district: string;
    city: string;
    postalCode?: string | null;
    email?: string | null;
    phone?: string | null;
    mersisNo?: string | null;
    tradeRegistryNo?: string | null;
  }): Promise<void> {
    await this.#db.companyProfile.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...input },
      update: input,
    });
  }

  /**
   * Bir satış faturası için UBL-TR belgesi üretir.
   *
   * TASLAK FATURA İÇİN ÜRETİLMEZ: henüz kesilmemiş bir belgeyi
   * entegratöre göndermeye hazır hâle getirmek, kesilmemiş faturayı
   * göndermeye giden yolu açar.
   */
  async buildFor(documentNo: string): Promise<EInvoiceDocument> {
    const invoice = await this.#db.salesInvoice.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new EInvoiceError(`Fatura bulunamadı: ${documentNo}`);
    if (invoice.status === "draft") {
      throw new EInvoiceError(
        `${documentNo} henüz kesilmemiş (taslak). Kesilmemiş fatura için e-Fatura ` +
          `belgesi üretilmez.`,
      );
    }
    if (invoice.status === "cancelled") {
      throw new EInvoiceError(`${documentNo} iptal edilmiş; belge üretilemez.`);
    }

    const [company, partner] = await Promise.all([
      this.companyProfile(),
      this.#db.partner.findUnique({
        where: { id: invoice.partnerId },
        include: { taxIds: true },
      }),
    ]);
    if (!partner) {
      throw new EInvoiceError(`Fatura carisi bulunamadı: ${invoice.partnerId}`);
    }

    const customer: Party = {
      legalName: partner.legalName,
      // VKN varsa o, yoksa TCKN — ikisi de yoksa eksik alan listesine düşer.
      taxId:
        partner.taxIds.find((t) => t.kind === "vkn")?.value ??
        partner.taxIds.find((t) => t.kind === "tckn")?.value ??
        null,
      taxOffice: partner.taxOffice,
      addressLine: partner.addressLine,
      district: partner.district,
      city: partner.city,
      postalCode: partner.postalCode,
      country: partner.country === "TR" ? "Türkiye" : partner.country,
      email: partner.email,
      phone: partner.phone,
    };

    // ETTN BİR KEZ ÜRETİLİR. Yeniden üretilseydi aynı fatura için iki
    // farklı belge çıkar ve biri gönderildikten sonra diğeri "başka bir
    // fatura" sayılırdı.
    const ettn = invoice.ettn ?? globalThis.crypto.randomUUID();

    const input: InvoiceInput = {
      ettn,
      documentNo: invoice.documentNo,
      issueDate: invoice.issuedAt,
      currency: invoice.currency,
      ...(invoice.currency !== "TRY" ? { exchangeRate: Number(invoice.exchangeRate) } : {}),
      supplier: company,
      customer,
      lines: invoice.lines.map((l) => ({
        lineNo: l.lineNo,
        itemName: l.description,
        quantity: Number(l.quantity),
        uom: l.uom,
        unitPrice: Number(l.unitPrice),
        discountAmount:
          Math.round(
            Number(l.quantity) * Number(l.unitPrice) * (Number(l.discountPercent) / 100) * 100,
          ) / 100,
        netAmount: Number(l.netAmount),
        vatRate: l.vatRate,
        vatAmount: Number(l.vatAmount),
      })),
      netAmount: Number(invoice.netAmount),
      discountAmount: Number(invoice.discountAmount),
      vatAmount: Number(invoice.vatAmount),
      totalAmount: Number(invoice.totalAmount),
    };

    const profile = profileFor(partner.einvoiceUser);
    const xml = buildInvoiceXml(input, profile);

    // ETTN ve tür faturaya işlenir: belge yeniden üretilse bile aynı
    // kimlikle çıkar.
    if (!invoice.ettn) {
      await this.#db.salesInvoice.update({
        where: { id: invoice.id },
        data: {
          ettn,
          einvoiceKind: partner.einvoiceUser ? "e-fatura" : "e-arsiv",
          einvoiceStatus: "pending",
        },
      });
    }

    return {
      documentNo: invoice.documentNo,
      ettn,
      profile,
      xml,
      byteLength: Buffer.byteLength(xml, "utf8"),
    };
  }


  /**
   * Faturayı okunabilir biçimde döndürür — hiçbir şey yazmaz.
   *
   * TASLAK FATURA DA OKUNUR. Belge üretimi taslakta yasaktır (gönderime
   * giden yolu açar), ama taslağı EKRANDA görmek gerekir: kesilmeden
   * önce kontrol edilmesi gereken şey tam olarak odur. Durum belgenin
   * üzerinde açıkça yazar.
   */
  async readInvoice(documentNo: string): Promise<InvoiceView> {
    const invoice = await this.#db.salesInvoice.findUnique({
      where: { documentNo },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new EInvoiceError(`Fatura bulunamadı: ${documentNo}`);

    const partner = await this.#db.partner.findUnique({
      where: { id: invoice.partnerId },
      include: { taxIds: true },
    });
    if (!partner) throw new EInvoiceError(`Fatura carisi bulunamadı: ${invoice.partnerId}`);

    // Şirket kimliği eksikse belge ÜRETİLEMEZ ama fatura yine okunur;
    // antet boş kalır ve eksiklik ekranda görünür.
    const supplier = await this.companyProfile().catch(() => null);

    const lines = invoice.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      quantity: Number(l.quantity),
      uom: l.uom,
      unitPrice: Number(l.unitPrice),
      discountPercent: Number(l.discountPercent),
      netAmount: Number(l.netAmount),
      vatRate: l.vatRate,
      vatAmount: Number(l.vatAmount),
    }));

    return {
      documentNo: invoice.documentNo,
      // Tarih ISO metne çevrilir: arayüze Date nesnesi gitmez.
      issuedAt:
        invoice.issuedAt instanceof Date ? invoice.issuedAt.toISOString() : invoice.issuedAt,
      status: invoice.status,
      currency: invoice.currency,
      exchangeRate: invoice.currency === "TRY" ? null : Number(invoice.exchangeRate),
      ettn: invoice.ettn,
      einvoiceKind: invoice.einvoiceKind,
      supplier,
      customer: {
        legalName: partner.legalName,
        taxId:
          partner.taxIds.find((t) => t.kind === "vkn")?.value ??
          partner.taxIds.find((t) => t.kind === "tckn")?.value ??
          null,
        taxOffice: partner.taxOffice,
        addressLine: partner.addressLine,
        district: partner.district,
        city: partner.city,
        postalCode: partner.postalCode,
        country: partner.country === "TR" ? "Türkiye" : partner.country,
        email: partner.email,
        phone: partner.phone,
      },
      lines,
      vatBreakdown: vatBreakdown(lines),
      netAmount: Number(invoice.netAmount),
      discountAmount: Number(invoice.discountAmount),
      vatAmount: Number(invoice.vatAmount),
      totalAmount: Number(invoice.totalAmount),
      totalInWords: amountInWords(Number(invoice.totalAmount), invoice.currency),
    };
  }


  /**
   * Sevk irsaliyesini okunabilir biçimde döndürür — hiçbir şey yazmaz.
   *
   * TUTAR TAŞIMAZ. İrsaliyeye fiyat yazmak yaygın bir hatadır: mal
   * bedeli faturada beyan edilir ve irsaliyedeki bir tutar, fatura
   * tutarından saparsa denetimde açıklanması gereken bir çelişki
   * bırakır.
   */
  async readDespatch(documentNo: string): Promise<DespatchView> {
    const d = await this.#db.delivery.findUnique({
      where: { documentNo },
      include: {
        lines: { orderBy: { lineNo: "asc" } },
        salesOrder: { select: { orderNo: true } },
      },
    });
    if (!d) throw new EInvoiceError(`İrsaliye bulunamadı: ${documentNo}`);

    const partner = await this.#db.partner.findUnique({
      where: { id: d.partnerId },
      include: { taxIds: true },
    });
    if (!partner) throw new EInvoiceError(`İrsaliye carisi bulunamadı: ${d.partnerId}`);

    const supplier = await this.companyProfile().catch(() => null);

    // DEPO ADIYLA YAZILIR. `locationId` bir UUID'dir; belgeye
    // "fb0271ee-2712-…" basmak, malın nereden çıktığını okuyan kişiye
    // hiçbir şey söylemez. Kayıt bulunamazsa kimlik kalır — boş
    // bırakmak, yanlış bir depo yazmaktan iyi ama hiç yazmamaktan
    // kötüdür.
    const loc = await this.#db.location
      .findUnique({ where: { id: d.locationId }, select: { code: true, name: true } })
      .catch(() => null);

    // İRSALİYEDE DE MALIN CİNSİ YAZAR. Kod, malı taşıyan aracın
    // yanındaki kâğıtta ne olduğunu söylemez.
    const codes = [...new Set(d.lines.map((l) => l.itemId))];
    const names = new Map<string, string>();
    if (codes.length > 0) {
      const cards = await this.#db.item.findMany({
        where: { code: { in: codes } },
        select: { code: true, name: true },
      });
      for (const c of cards) names.set(c.code, c.name);
    }

    const iso = (v: Date | string | null): string | null =>
      v === null ? null : v instanceof Date ? v.toISOString() : v;

    return {
      documentNo: d.documentNo,
      orderNo: d.salesOrder?.orderNo ?? null,
      shippedAt: iso(d.shippedAt)!,
      actualDespatchAt: iso(d.actualDespatchAt),
      status: d.status,
      ettn: d.ettn,
      edespatchStatus: d.edespatchStatus,
      carrierName: d.carrierName,
      plateNo: d.plateNo,
      driverName: d.driverName,
      location: loc ? `${loc.name} (${loc.code})` : d.locationId,
      supplier,
      customer: {
        legalName: partner.legalName,
        taxId:
          partner.taxIds.find((t) => t.kind === "vkn")?.value ??
          partner.taxIds.find((t) => t.kind === "tckn")?.value ??
          null,
        taxOffice: partner.taxOffice,
        addressLine: partner.addressLine,
        district: partner.district,
        city: partner.city,
        postalCode: partner.postalCode,
        country: partner.country === "TR" ? "Türkiye" : partner.country,
        email: partner.email,
        phone: partner.phone,
      },
      lines: d.lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        description: names.get(l.itemId) ?? l.itemId,
        quantity: Number(l.quantity),
        uom: l.uom,
        batchId: l.batchId,
      })),
    };
  }

  /**
   * Belge üretmeden önce eksikleri listeler.
   *
   * Faturayı kesmeden ÖNCE çağrılabilir: eksik cari bilgisiyle kesilen
   * bir fatura, iptal edilip yeniden kesilmek zorunda kalır ve iptal de
   * vergi dairesine yansır.
   */
  async readiness(partnerId: string): Promise<{ ready: boolean; missing: readonly string[] }> {
    const missing: string[] = [];

    const company = await this.#db.companyProfile.findUnique({ where: { id: "singleton" } });
    if (!company) missing.push("Şirket kimliği tanımlı değil (unvan, VKN, vergi dairesi, adres)");

    const partner = await this.#db.partner.findUnique({
      where: { id: partnerId },
      include: { taxIds: true },
    });
    if (!partner) {
      return { ready: false, missing: ["Cari bulunamadı"] };
    }

    if (partner.taxIds.length === 0) missing.push("Alıcı: vergi/TC kimlik numarası");
    if (!partner.taxOffice) missing.push("Alıcı: vergi dairesi");
    if (!partner.addressLine) missing.push("Alıcı: adres");
    if (!partner.district) missing.push("Alıcı: ilçe");
    if (!partner.city) missing.push("Alıcı: il");
    if (partner.einvoiceUser === null) {
      missing.push(
        "Alıcı: e-Fatura mükellefiyeti bilinmiyor (e-Fatura mı e-Arşiv mi belirlenemez)",
      );
    }

    return { ready: missing.length === 0, missing };
  }

  /**
   * Bir sevk irsaliyesi için UBL-TR e-İrsaliye belgesi üretir.
   *
   * İPTAL EDİLMİŞ İRSALİYE İÇİN ÜRETİLMEZ: yola çıkmamış bir mal için
   * belge hazırlamak, denetimde açıklanamayan bir kayıt bırakır.
   */
  async buildDespatchFor(documentNo: string): Promise<{
    documentNo: string;
    ettn: string;
    profile: DespatchProfile;
    xml: string;
    byteLength: number;
  }> {
    const delivery = await this.#db.delivery.findUnique({
      where: { documentNo },
      include: {
        lines: { orderBy: { lineNo: "asc" } },
        salesOrder: { select: { orderNo: true } },
      },
    });
    if (!delivery) throw new EInvoiceError(`İrsaliye bulunamadı: ${documentNo}`);
    if (delivery.status !== "posted") {
      throw new EInvoiceError(
        `${documentNo} ${delivery.status} durumunda; e-İrsaliye belgesi üretilmez.`,
      );
    }

    const [company, partner] = await Promise.all([
      this.companyProfile(),
      this.#db.partner.findUnique({
        where: { id: delivery.partnerId },
        include: { taxIds: true },
      }),
    ]);
    if (!partner) throw new EInvoiceError(`İrsaliye carisi bulunamadı: ${delivery.partnerId}`);

    // Malzeme adları irsaliyede görünmelidir; kod tek başına
    // yol denetiminde "ne taşıyorsun" sorusuna cevap değildir.
    const items = await this.#db.item.findMany({
      where: { code: { in: delivery.lines.map((l) => l.itemId) } },
      select: { code: true, name: true },
    });
    const nameOf = new Map(items.map((i) => [i.code, i.name]));

    const ettn = delivery.ettn ?? globalThis.crypto.randomUUID();

    const xml = buildDespatchXml({
      ettn,
      documentNo: delivery.documentNo,
      issueDate: delivery.postedAt ?? delivery.shippedAt,
      // FİİLİ SEVK ANI ayrıca tutulur; girilmemişse sevk tarihi kullanılır
      // ve bu bir varsayımdır — belgede saat 00:00 görünür.
      actualDespatchDate: delivery.actualDespatchAt ?? delivery.shippedAt,
      supplier: company,
      customer: {
        legalName: partner.legalName,
        taxId:
          partner.taxIds.find((t) => t.kind === "vkn")?.value ??
          partner.taxIds.find((t) => t.kind === "tckn")?.value ??
          null,
        taxOffice: partner.taxOffice,
        addressLine: partner.addressLine,
        district: partner.district,
        city: partner.city,
        postalCode: partner.postalCode,
        country: partner.country === "TR" ? "Türkiye" : partner.country,
      },
      shipment: {
        carrierName: delivery.carrierName,
        plateNo: delivery.plateNo,
        driverTckn: delivery.driverTckn,
        driverName: delivery.driverName,
      },
      lines: delivery.lines.map((l) => ({
        lineNo: l.lineNo,
        itemName: nameOf.get(l.itemId) ?? l.itemId,
        quantity: Number(l.quantity),
        uom: l.uom,
        batchNo: l.batchId,
      })),
      orderReference: delivery.salesOrder.orderNo,
    });

    if (!delivery.ettn) {
      await this.#db.delivery.update({
        where: { id: delivery.id },
        data: { ettn, edespatchStatus: "pending" },
      });
    }

    return {
      documentNo: delivery.documentNo,
      ettn,
      profile: DESPATCH_PROFILES.temel,
      xml,
      byteLength: Buffer.byteLength(xml, "utf8"),
    };
  }

  /** e-İrsaliye gönderim kuyruğu. */
  async pendingDespatches(limit = 50) {
    const rows = await this.#db.delivery.findMany({
      where: { status: "posted", edespatchStatus: "pending" },
      orderBy: { shippedAt: "asc" },
      take: limit,
      select: { documentNo: true, ettn: true, shippedAt: true, plateNo: true },
    });
    return rows.map((r) => ({
      documentNo: r.documentNo,
      ettn: r.ettn,
      shippedAt: r.shippedAt.toISOString().slice(0, 10),
      plateNo: r.plateNo,
    }));
  }

  /**
   * e-İrsaliye kesilmemiş sevkiyatlar.
   *
   * BU LİSTE BOŞ OLMALIDIR. Dolu olması, belgesiz mal sevk edildiği
   * anlamına gelir ve yol denetiminde özel usulsüzlük cezası doğurur.
   */
  async despatchesWithoutDocument(limit = 50) {
    const rows = await this.#db.delivery.findMany({
      where: { status: "posted", ettn: null },
      orderBy: { shippedAt: "asc" },
      take: limit,
      select: { documentNo: true, shippedAt: true, plateNo: true, carrierName: true },
    });
    return rows.map((r) => ({
      documentNo: r.documentNo,
      shippedAt: r.shippedAt.toISOString().slice(0, 10),
      plateNo: r.plateNo,
      carrierName: r.carrierName,
    }));
  }

  /** Belge üretilmiş faturalar — entegratöre gönderim kuyruğu. */
  async pendingDocuments(limit = 50) {
    const rows = await this.#db.salesInvoice.findMany({
      where: { status: "issued", einvoiceStatus: "pending" },
      orderBy: { issuedAt: "asc" },
      take: limit,
      select: {
        documentNo: true,
        ettn: true,
        einvoiceKind: true,
        issuedAt: true,
        totalAmount: true,
      },
    });
    return rows.map((r) => ({
      documentNo: r.documentNo,
      ettn: r.ettn,
      kind: r.einvoiceKind,
      issuedAt: r.issuedAt.toISOString().slice(0, 10),
      totalAmount: Number(r.totalAmount),
    }));
  }
}

export { missingFields };
