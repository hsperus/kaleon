/**
 * ULS Havayolları Kargo — gerçek operasyona uygun demo verisi.
 *
 * GENEL TOHUMLAMA BURADA YETMEZ. Sektör profilleri imalatçı için
 * yazıldı: hammadde alınır, mamul üretilir, adet satılır. Hava kargoda
 * satılan şey bir NESNE DEĞİL, KAPASİTEDİR — kilogram-kilometre. Stok
 * ürün değil yakıt ve yedek parçadır; makine tezgâh değil uçaktır;
 * bakım periyodu güne değil UÇUŞ SAATİNE bağlıdır.
 *
 * Bu dosya o farkları kuruyor. Amaç ürünü güzel göstermek değil,
 * ULS'nin kendi işini tanıyabileceği bir veri kümesi bırakmak — her
 * tool'un üzerinde çalışacağı gerçek bir kayıt olsun diye.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * FİLO GERÇEK: 3× A310-300F (ikisi 2027 ve 2029'da emekli olacak),
 * 2× A330-300P2F, merkez İstanbul Havalimanı. Tescil işaretleri DEMO
 * değeridir — gerçek kuyruk numaraları kullanılmadı, çünkü başka bir
 * operatöre ait bir işareti bu şirketin defterine yazmak yanlış olur.
 *
 * PARA BİRİMİ USD: hava kargo navlunu dolarla fiyatlanır ve
 * forwarder'lar dolarla öder. Bu, kur değerlemesini dekoratif bir
 * özellik olmaktan çıkarıp ayın kapanışındaki asıl kaleme dönüştürür.
 */

import { AssetRepository } from "../../db/asset-repository.js";
import { PayrollRepository } from "../../db/payroll-repository.js";
import { JournalRepository } from "../../db/journal-repository.js";
import { SalesRepository } from "../../db/sales-repository.js";
import { BatchRepository } from "../../db/batch-repository.js";
import { SerialRepository } from "../../db/serial-repository.js";
import { MaintenanceRepository } from "../../db/maintenance-repository.js";
import { ProcurementRepository } from "../../db/procurement-repository.js";
import { StockCountRepository } from "../../db/stock-count-repository.js";
import { LeaveRepository } from "../../db/leave-repository.js";
import { CreditNoteRepository } from "../../db/credit-note-repository.js";
import { WatchRepository } from "../../db/watch-repository.js";
import type { TenantDb } from "../../db/client.js";
import { SEED_USER } from "./seed.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** ISO hafta numarası — perşembe kuralı. */
function isoHafta(t: Date): number {
  const g = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  g.setUTCDate(g.getUTCDate() + 4 - (g.getUTCDay() || 7));
  const yilBasi = new Date(Date.UTC(g.getUTCFullYear(), 0, 1));
  return Math.ceil(((g.getTime() - yilBasi.getTime()) / 86_400_000 + 1) / 7);
}

/** Kur: 2026 için makul bir seyir. Değerleme bunların farkını yazar. */
const USD = { mart: 34.8, aralik: 41.2 } as const;
const EUR = { mart: 37.6, aralik: 44.9 } as const;

/**
 * Filo. Maliyetler dönüşüm (P2F) sonrası piyasa değerleri; TL karşılığı
 * alım günündeki kurla sabitlenmiş kabul ediliyor.
 *
 * FAYDALI ÖMÜR HEPSİNDE 10 YIL. İlk yazımda A310'ların ömrünü
 * emeklilik tarihlerine göre kısaltmıştım (4, 6, 8 yıl) — ve bu YANLIŞ.
 * VUK'ta faydalı ömür VARLIK SINIFINA göre belirlenir, operatörün
 * filo planına göre değil. Erken emeklilik ömrü kısaltmaz; kalan net
 * defter değeri üzerinden bir ELDEN ÇIKARMA olayıdır.
 *
 * Hatanın bedeli de görünürdü: kısa ömürle üç uçak 2026'dan önce
 * tamamen itfa olmuş sayılıyor ve yıllık amortisman beş uçak yerine
 * bir uçaktan geliyordu — gelir tablosu yüz milyonlarca lira yanlış.
 */
const FILO = [
  { code: "TC-ULA", name: "A310-300F · TC-ULA", cost: 392_000_000, life: 10, acquired: "2019-06-12" },
  { code: "TC-ULB", name: "A310-300F · TC-ULB", cost: 408_000_000, life: 10, acquired: "2020-03-04" },
  { code: "TC-ULC", name: "A310-300F · TC-ULC", cost: 421_000_000, life: 10, acquired: "2021-09-18" },
  { code: "TC-ULD", name: "A330-300P2F · TC-ULD", cost: 1_640_000_000, life: 10, acquired: "2025-03-20" },
  { code: "TC-ULE", name: "A330-300P2F · TC-ULE", cost: 1_712_000_000, life: 10, acquired: "2026-04-18" },
] as const;

/**
 * Kalemler.
 *
 * SATILAN ŞEY KAPASİTEDİR. "Hava kargo taşıma" kilogram bazında bir
 * HİZMET kalemidir; stoktan düşmez, üretilmez. Bu yüzden `type` alanı
 * "hizmet" — mamul deseydik envanter değeri uçar ve maliyet hesabı
 * anlamsızlaşırdı.
 */
const KALEMLER = [
  // Satılan hizmetler — navlun USD üzerinden fiyatlanır.
  { code: "FRT-GEN", name: "Genel Kargo Taşıma", uom: "kg", type: "hizmet", price: 2.85, vat: 0 },
  { code: "FRT-EXP", name: "Ekspres Kargo Taşıma", uom: "kg", type: "hizmet", price: 4.40, vat: 0 },
  { code: "FRT-DGR", name: "Tehlikeli Madde (DGR) Taşıma", uom: "kg", type: "hizmet", price: 6.20, vat: 0 },
  { code: "CHT-A330", name: "A330 Tam Charter", uom: "sefer", type: "hizmet", price: 268_000, vat: 0 },
  { code: "ULD-KIRA", name: "ULD Kiralama", uom: "gün", type: "hizmet", price: 42, vat: 20 },

  // Stok — yakıt ve sarf.
  { code: "JETA1", name: "Jet A-1 Yakıt", uom: "litre", type: "sarf", price: 38.4, vat: 20 },
  { code: "HYD-5606", name: "Hidrolik Akışkan MIL-H-5606", uom: "litre", type: "sarf", price: 1_240, vat: 20, batch: true },
  { code: "OXY-BTL", name: "Oksijen Tüpü (Taşınabilir)", uom: "adet", type: "sarf", price: 18_600, vat: 20, batch: true },
  { code: "DEICE", name: "Buz Çözücü Tip-I", uom: "litre", type: "sarf", price: 96, vat: 20 },

  // Rotable — seri takipli, tamir edilip tekrar takılır.
  { code: "APU-331", name: "APU Honeywell 331-350", uom: "adet", type: "hammadde", price: 24_800_000, vat: 20, serial: true },
  { code: "LGR-MAIN", name: "Ana İniş Takımı", uom: "adet", type: "hammadde", price: 41_200_000, vat: 20, serial: true },
  { code: "ULD-AKE", name: "AKE Konteyner", uom: "adet", type: "hammadde", price: 186_000, vat: 20 },
  { code: "ULD-PMC", name: "PMC Palet", uom: "adet", type: "hammadde", price: 94_000, vat: 20 },
] as const;

/** Müşteriler: hava kargonun alıcısı forwarder'dır, nihai gönderici değil. */
const MUSTERILER = [
  { code: "F-1001", name: "Kuehne + Nagel Nakliyat Ltd. Şti.", vkn: "5810012345", city: "İstanbul", district: "Tuzla" },
  { code: "F-1002", name: "DSV Hava ve Deniz Taşımacılığı A.Ş.", vkn: "3010023456", city: "İstanbul", district: "Arnavutköy" },
  { code: "F-1003", name: "Ekol Lojistik A.Ş.", vkn: "3250034567", city: "İstanbul", district: "Sancaktepe" },
  { code: "F-1004", name: "Expeditors Uluslararası Taşımacılık A.Ş.", vkn: "3900045678", city: "İzmir", district: "Gaziemir" },
] as const;

const TEDARIKCILER = [
  { code: "S-2001", name: "Petrol Ofisi Havacılık A.Ş.", vkn: "7250056789", city: "İstanbul", district: "Arnavutköy" },
  { code: "S-2002", name: "Çelebi Hava Servisi A.Ş.", vkn: "2160067890", city: "İstanbul", district: "Arnavutköy" },
  { code: "S-2003", name: "Turkish Technic A.Ş.", vkn: "8720078901", city: "İstanbul", district: "Pendik" },
  { code: "S-2004", name: "DHMİ Genel Müdürlüğü", vkn: "2940089012", city: "İstanbul", district: "Arnavutköy" },
  { code: "S-2005", name: "Anadolu Sigorta A.Ş.", vkn: "0680090123", city: "İstanbul", district: "Şişli" },
] as const;

/**
 * Cari vadeleri. Havacılıkta vade tedarikçi gücüne göre değişir:
 * yakıtçı ve havalimanı otoritesi kısa vade dayatır, MRO uzun verir.
 * Bu sayı yeni faturanın vadesini türetir; uydurulmaz, girilir.
 */
const VADELER: Record<string, number> = {
  "S-2001": 15,
  "S-2002": 30,
  "S-2003": 60,
  "S-2004": 7,
  "S-2005": 45,
  "F-1001": 45,
  "F-1002": 30,
  "F-1003": 45,
  "F-1004": 30,
};

/**
 * Açık tedarikçi faturaları — ödeme koşusunun ve nakit akışının konusu.
 *
 * KASITLI OLARAK ÇEŞİTLİ: gecikmiş, yaklaşan, bloke, vadesi girilmemiş
 * ve dövizli faturalar bir arada. Hepsi "temiz" olsaydı, ödeme koşusu
 * yalnızca kolay hâlini gösterirdi ve asıl işini — neyi ELEDİĞİNİ —
 * hiç göstermezdi.
 */
const GELEN_FATURALAR = [
  // Gecikmiş: yer hizmeti faturası, 22 gün önce vadesi dolmuş.
  { no: "GF-2026-4471", cari: "S-2002", kesim: "2026-07-10", vade: "2026-08-09",
    kalem: "ULD-KIRA", miktar: 1_240, fiyat: 42, para: "TRY", durum: "matched" },
  // Gecikmiş ve büyük: temmuz yakıt ikmali.
  { no: "GF-2026-4488", cari: "S-2001", kesim: "2026-07-18", vade: "2026-08-02",
    kalem: "JETA1", miktar: 620_000, fiyat: 38.4, para: "TRY", durum: "matched" },
  // Yaklaşan: havalimanı konma ve park ücretleri.
  { no: "GF-2026-4502", cari: "S-2004", kesim: "2026-08-25", vade: "2026-09-01",
    kalem: "ULD-KIRA", miktar: 5_600, fiyat: 42, para: "TRY", durum: "matched" },
  // Yaklaşan: ağustos yakıt.
  { no: "GF-2026-4515", cari: "S-2001", kesim: "2026-08-20", vade: "2026-09-04",
    kalem: "JETA1", miktar: 1_400_000, fiyat: 38.4, para: "TRY", durum: "matched" },
  // İleri vadeli: gövde ve sorumluluk sigortası primi.
  { no: "GF-2026-4520", cari: "S-2005", kesim: "2026-08-12", vade: "2026-09-26",
    kalem: "OXY-BTL", miktar: 92, fiyat: 18_600, para: "TRY", durum: "matched" },
  // BLOKE: sayılan miktar irsaliyeden düşük, üç yönlü mutabakat tuttu.
  { no: "GF-2026-4530", cari: "S-2002", kesim: "2026-08-14", vade: "2026-09-13",
    kalem: "DEICE", miktar: 24_000, fiyat: 96, para: "TRY", durum: "blocked" },
  // VADESİ GİRİLMEMİŞ: entegratörden vadesiz geldi, kimse girmedi.
  { no: "GF-2026-4544", cari: "S-2002", kesim: "2026-08-18", vade: null,
    kalem: "ULD-KIRA", miktar: 3_100, fiyat: 42, para: "TRY", durum: "matched" },
  // DÖVİZLİ: motor borescope bakımı, MRO faturaları USD kesilir.
  { no: "GF-2026-4551", cari: "S-2003", kesim: "2026-08-08", vade: "2026-10-07",
    kalem: "HYD-5606", miktar: 210, fiyat: 118, para: "USD", durum: "matched" },
] as const;

/**
 * Kadro. Havacılıkta ücret bandı imalattan farklıdır: kaptan pilot
 * bir fabrika müdüründen pahalıdır ve bu bordroyu şekillendirir.
 */
const KADRO = [
  { code: "P-001", name: "Serkan Aydın", dep: "Uçuş Ekibi", pos: "Kaptan Pilot", gross: 485_000 },
  { code: "P-002", name: "Deniz Korkmaz", dep: "Uçuş Ekibi", pos: "İkinci Pilot", gross: 268_000 },
  { code: "P-003", name: "Murat Şen", dep: "Uçuş Ekibi", pos: "Yük Ustabaşı (Loadmaster)", gross: 124_000 },
  { code: "P-004", name: "Elif Yıldırım", dep: "Teknik", pos: "Uçak Bakım Teknisyeni (B1)", gross: 158_000 },
  { code: "P-005", name: "Burak Çetin", dep: "Teknik", pos: "Aviyonik Teknisyeni (B2)", gross: 146_000 },
  { code: "P-006", name: "Zeynep Arslan", dep: "Operasyon", pos: "Uçuş Harekât Uzmanı", gross: 96_000 },
  { code: "P-007", name: "Can Doğan", dep: "Operasyon", pos: "Kargo Terminal Şefi", gross: 88_000 },
  { code: "P-008", name: "Merve Aksoy", dep: "Mali İşler", pos: "Mali İşler Müdürü", gross: 172_000 },
] as const;

/** Hatlar — sipariş ve sevkiyat bunlar üzerinden kurulur. */
const HATLAR = [
  { awb: "AWB-2026-08114", musteri: "F-1001", rota: "IST–TLL", kg: 41_200, kalem: "FRT-GEN", tarih: "2026-08-11" },
  { awb: "AWB-2026-08207", musteri: "F-1002", rota: "IST–HKG", kg: 58_600, kalem: "FRT-EXP", tarih: "2026-08-20" },
  { awb: "AWB-2026-08251", musteri: "F-1003", rota: "IST–DXB", kg: 22_400, kalem: "FRT-DGR", tarih: "2026-08-25" },
] as const;

export interface UlsResult {
  readonly done: readonly string[];
  readonly failed: readonly { adim: string; sebep: string }[];
}

export async function seedUls(
  db: TenantDb,
  /** İzlemelerin sahibi — kiracının gerçek kullanıcısı. */
  watchOwnerUserId: string | null = null,
): Promise<UlsResult> {
  const done: string[] = [];
  const failed: { adim: string; sebep: string }[] = [];

  async function step(adim: string, fn: () => Promise<string>): Promise<void> {
    try {
      done.push(await fn());
    } catch (e) {
      failed.push({ adim, sebep: e instanceof Error ? e.message : String(e) });
    }
  }

  const journal = new JournalRepository(db as never);
  const sales = new SalesRepository(db as never);
  const assets = new AssetRepository(db as never);

  // ── 1. Şirket kimliği ──
  await step("kimlik", async () => {
    await db.companyProfile.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        legalName: "ULS Havayolları Kargo A.Ş.",
        taxId: "8790123456",
        taxOffice: "Arnavutköy",
        addressLine: "İstanbul Havalimanı Kargo Terminali A Blok",
        district: "Arnavutköy",
        city: "İstanbul",
        postalCode: "34283",
        country: "TR",
        email: "muhasebe@ulsairlines.example",
        phone: "+90 212 000 00 00",
        mersisNo: "0879012345600011",
        tradeRegistryNo: "879012-5",
      },
      update: {},
    });
    return "kimlik: ULS Havayolları Kargo A.Ş. · İstanbul Havalimanı";
  });

  // ── 2. Cariler ──
  await step("cariler", async () => {
    for (const m of MUSTERILER) {
      await db.partner.upsert({
        where: { code: m.code },
        create: {
          code: m.code, legalName: m.name, normalized: m.name.toLocaleLowerCase("tr"),
          isCustomer: true, country: "TR", taxOffice: m.district, city: m.city,
          district: m.district, addressLine: `${m.district} Serbest Bölge`,
          einvoiceUser: true, einvoiceAlias: `urn:mail:${m.code.toLowerCase()}@example`,
          taxIds: { create: [{ kind: "vkn", value: m.vkn }] },
        },
        update: {},
      });
    }
    for (const t of TEDARIKCILER) {
      await db.partner.upsert({
        where: { code: t.code },
        create: {
          code: t.code, legalName: t.name, normalized: t.name.toLocaleLowerCase("tr"),
          isSupplier: true, country: "TR", taxOffice: t.district, city: t.city,
          district: t.district, addressLine: `${t.district} OSB`,
          taxIds: { create: [{ kind: "vkn", value: t.vkn }] },
        },
        update: {},
      });
    }
    return `cari: ${MUSTERILER.length} forwarder + ${TEDARIKCILER.length} tedarikçi`;
  });

  // ── 3. Lokasyonlar ── kargo terminali ve teknik depo ayrı sayılır.
  await step("lokasyon", async () => {
    for (const l of [
      { code: "IST-KRG", name: "İstanbul Kargo Terminali", kind: "warehouse" as const },
      { code: "IST-TEK", name: "Teknik Malzeme Deposu", kind: "warehouse" as const },
      { code: "IST-YKT", name: "Yakıt Tankı", kind: "warehouse" as const },
    ]) {
      await db.location.upsert({ where: { code: l.code }, create: l, update: {} });
    }
    return "lokasyon: kargo terminali, teknik depo, yakıt tankı";
  });

  // ── 4. Kalemler ──
  await step("kalemler", async () => {
    for (const k of KALEMLER) {
      await db.item.upsert({
        where: { code: k.code },
        create: {
          code: k.code, name: k.name, normalized: k.name.toLocaleLowerCase("tr"),
          type: k.type, baseUom: k.uom,
          batchManaged: "batch" in k && k.batch === true,
          serialManaged: "serial" in k && k.serial === true,
        },
        update: {
          batchManaged: "batch" in k && k.batch === true,
          serialManaged: "serial" in k && k.serial === true,
        },
      });
    }
    return `kalem: ${KALEMLER.length} (5 hizmet, 4 sarf, 4 rotable/ULD)`;
  });

  // ── 5. Kurlar ── navlun USD, bazı giderler EUR.
  await step("kur", async () => {
    for (const [cur, tarih, oran] of [
      ["USD", "2026-03-16", USD.mart], ["USD", "2026-12-31", USD.aralik],
      ["USD", "2026-08-11", 36.9], ["USD", "2026-08-20", 37.4], ["USD", "2026-08-25", 37.6],
      ["EUR", "2026-03-16", EUR.mart], ["EUR", "2026-12-31", EUR.aralik],
    ] as const) {
      await db.exchangeRate.upsert({
        where: { currency_quotedAt: { currency: cur, quotedAt: d(tarih) } },
        create: { currency: cur, rate: oran, quotedAt: d(tarih), source: "TCMB" },
        update: {},
      });
    }
    return "kur: USD ve EUR, mart–aralık seyri";
  });

  /*
   * ── 6. ŞİRKETİN TARİHİ ──
   *
   * İLK KURGUM YANLIŞTI VE BİLANÇO 894 MİLYON AÇIK VERİYORDU.
   *
   * Açılış bilançosunu 2026'ya koymuş, uçakları o kayda brüt maliyetle
   * yazmış, sonra amortismanı 2019'dan başlatmıştım. Sonuç: 2019–2025
   * yıllarının amortisman gideri hiçbir öz kaynak kalemine bağlanmıyor
   * ve bilanço tutmuyordu. Mizan yine denkti — her fiş kendi içinde
   * denk çünkü — ama BİLANÇO denk değildi. İkisinin farkı tam da bu:
   * mizan fişleri, bilanço zamanı denetler.
   *
   * Doğrusu şirketin geçmişini gerçekten kurmak. Açılış 2019'da
   * sermaye ve nakitle başlıyor; her uçak KENDİ ALIM TARİHİNDE deftere
   * giriyor; amortisman yıl yıl işliyor. Böylece sabit kıymet kaydı
   * ile defter birbirini tutuyor ve geçmiş yıl sonuçları öz kaynakta
   * kendiliğinden birikiyor.
   */
  await step("acilis", async () => {
    if (await db.journalEntry.findFirst({ where: { description: { contains: "Açılış" } } })) {
      return "açılış: zaten var, atlandı";
    }
    // Sermaye filonun tamamını ve işletme sermayesini karşılamalı;
    // aksi hâlde banka bakiyesi eksiye düşer ve demo "iflas etmiş bir
    // şirket" gösterir.
    const sermaye = 5_240_000_000;
    await journal.post({
      entryDate: d("2019-01-02"),
      description: "Açılış — kuruluş sermayesi",
      sourceKind: "manual",
      userId: SEED_USER,
      lines: [
        { accountCode: "102", debit: sermaye, credit: 0, description: "Bankalar" },
        { accountCode: "500", debit: 0, credit: sermaye, description: "Ödenmiş sermaye" },
      ],
    });
    return `açılış: 2019 kuruluş, ${(sermaye / 1e9).toFixed(2)} milyar ₺ sermaye`;
  });

  // ── 7. Filo ── her uçak KENDİ ALIM TARİHİNDE deftere girer.
  await step("filo", async () => {
    const hangar = await db.workCenter.upsert({
      where: { code: "IST-HGR" },
      create: { code: "IST-HGR", name: "İstanbul Bakım Hangarı", concurrentCapacity: 2, targetRatePerHour: 1 },
      update: {},
    });

    for (const f of FILO) {
      if (!(await db.fixedAsset.findUnique({ where: { code: f.code } }))) {
        await assets.create({
          code: f.code, name: f.name, category: "tasit",
          acquiredAt: d(f.acquired), cost: f.cost, usefulLifeYears: f.life,
          method: "normal",
          // KIST YALNIZCA BİNEK OTOMOBİLDE (VUK 320). Hava taşıtı
          // binek otomobil değildir; tam yıl amortisman ayrılır.
          prorated: false,
          assetAccount: "254", expenseAccount: "730",
        });
      }
      // Alım fişi: kıymet kaydı ile defter birbirini tutmalı. Yoksa
      // sabit kıymet mutabakatı ilk çalıştırmada fark verir.
      const kaynak = `ACQ-${f.code}`;
      if (!(await db.journalEntry.findFirst({ where: { sourceId: kaynak } }))) {
        await journal.post({
          entryDate: d(f.acquired),
          description: `Uçak alımı — ${f.name}`,
          sourceKind: "manual",
          sourceId: kaynak,
          userId: SEED_USER,
          lines: [
            { accountCode: "254", debit: f.cost, credit: 0, description: f.name },
            { accountCode: "102", debit: 0, credit: f.cost, description: `${f.code} alım bedeli` },
          ],
        });
      }
      await db.machine.upsert({
        where: { code: f.code },
        create: { code: f.code, name: f.name, workCenterId: hangar.id },
        update: {},
      });
    }
    return `filo: ${FILO.length} uçak, her biri kendi alım fişiyle`;
  });

  // ── 7b. Yer ekipmanı ve ULD yatırımı ──
  await step("ekipman", async () => {
    const kaynak = "ACQ-GSE";
    if (await db.journalEntry.findFirst({ where: { sourceId: kaynak } })) {
      return "ekipman: zaten var, atlandı";
    }
    await journal.post({
      entryDate: d("2019-03-15"),
      description: "Yer destek ekipmanı ve ULD yatırımı",
      sourceKind: "manual",
      sourceId: kaynak,
      userId: SEED_USER,
      lines: [
        { accountCode: "255", debit: 68_000_000, credit: 0, description: "GSE, forklift, ULD seti" },
        { accountCode: "102", debit: 0, credit: 68_000_000, description: "Ekipman bedeli" },
      ],
    });
    if (!(await db.fixedAsset.findUnique({ where: { code: "GSE-01" } }))) {
      await assets.create({
        code: "GSE-01", name: "Yer Destek Ekipmanı ve ULD Seti", category: "demirbas",
        acquiredAt: d("2019-03-15"), cost: 68_000_000, usefulLifeYears: 10,
        method: "normal", prorated: false,
        assetAccount: "255", expenseAccount: "770",
      });
    }
    return "ekipman: 68 milyon ₺ GSE ve ULD";
  });

  // ── 8. AWB'ler ── sipariş → sevkiyat → fatura, USD navlunla.
  await step("awb", async () => {
    let kesilen = 0;
    for (const h of HATLAR) {
      if (await db.salesOrder.findUnique({ where: { orderNo: h.awb } })) continue;
      const musteri = await db.partner.findUnique({ where: { code: h.musteri } });
      const kalem = KALEMLER.find((k) => k.code === h.kalem)!;
      if (!musteri) continue;

      await db.salesOrder.create({
        data: {
          orderNo: h.awb,
          partnerId: musteri.id,
          committedDate: d(h.tarih),
          // Hava kargoda gecikme cezası navlunun yüzdesi olarak işler.
          penaltyPerDay: Math.round(h.kg * kalem.price * 0.02),
          penaltyCap: Math.round(h.kg * kalem.price * 0.15),
          currency: "USD",
          status: "open",
          lines: {
            create: [
              {
                lineNo: 10,
                itemId: kalem.code,
                quantity: h.kg,
                uom: kalem.uom,
                unitPrice: kalem.price,
                discountPercent: 0,
                vatRate: kalem.vat,
              },
            ],
          },
        },
      });
      kesilen += 1;
    }
    return `AWB: ${kesilen} yeni sevkiyat emri (IST–TLL, IST–HKG, IST–DXB)`;
  });

  // ── 9. Dövizli alacak ── ihracat navlunu, kur değerlemesinin konusu.
  await step("doviz-alacak", async () => {
    const musteri = await db.partner.findUnique({ where: { code: "F-1002" } });
    if (!musteri) throw new Error("F-1002 yok");
    if (await db.journalEntry.findFirst({ where: { sourceId: "INV-AWB-08207" } })) {
      return "dövizli alacak: zaten var, atlandı";
    }
    const usd = 218_400;
    await journal.post({
      entryDate: d("2026-03-16"),
      description: "IST–HKG navlun faturası (USD)",
      sourceKind: "sales_invoice",
      sourceId: "INV-AWB-08207",
      userId: SEED_USER,
      lines: [
        {
          accountCode: "120", debit: Math.round(usd * USD.mart), credit: 0,
          description: "DSV — IST–HKG navlun", partnerId: musteri.id,
          currency: "USD", fxDebit: usd, fxCredit: 0, fxRate: USD.mart,
        },
        {
          // 601: yurtdışı satış. Uluslararası taşımacılık KDV'den
          // istisnadır (KDVK 14) — bu yüzden 391 satırı yok.
          accountCode: "601", debit: 0, credit: Math.round(usd * USD.mart),
          description: "Yurtdışı navlun geliri",
        },
      ],
    });
    return `dövizli alacak: ${usd.toLocaleString("tr-TR")} USD açık (kur değerlemesi çalışır)`;
  });

  // ── 10. Bakım ── uçuş saatine bağlı A-check, aya bağlı C-check.
  await step("bakim", async () => {
    const m = new MaintenanceRepository(db as never);
    if (await db.maintenancePlan.count() > 0) return "bakım: zaten var, atlandı";

    for (const f of FILO) {
      // A-check her 750 uçuş saati, C-check her 24 ay. Havacılıkta
      // periyot güne DEĞİL, uçuş saatine bağlıdır — sistem ikisini de
      // destekliyor.
      await m.savePlan({
        machineCode: f.code,
        description: "A-Check · 750 uçuş saati",
        intervalHours: 750,
        lastDoneHours: 0,
      });
      await m.savePlan({
        machineCode: f.code,
        description: "C-Check · 24 ay",
        intervalDays: 730,
        lastDoneAt: d("2024-11-05"),
      });
    }
    // AOG: uçak yerde, uçamıyor. Havacılıkta en pahalı kelime.
    await m.reportBreakdown({
      machineCode: "TC-ULB",
      severity: "durdurdu",
      description: "AOG — sol motor titreşim limiti aşıldı, uçuş iptal",
      reportedAt: d("2026-08-29"),
      userId: SEED_USER,
    });
    return `bakım: ${FILO.length} uçakta A/C-check planı + TC-ULB AOG`;
  });

  // ── 11. Parti ve seri ── raf ömürlü sarf, seri takipli rotable.
  await step("parti-seri", async () => {
    const b = new BatchRepository(db as never);
    const s = new SerialRepository(db as never);
    const tedarikci = await db.partner.findUnique({ where: { code: "S-2003" } });

    for (const p of [
      { itemCode: "HYD-5606", batchNo: "HYD-2026-0412", producedAt: d("2026-04-12") },
      { itemCode: "OXY-BTL", batchNo: "OXY-2025-1130", producedAt: d("2025-11-30") },
    ]) {
      if (await b.byNo(p.itemCode, p.batchNo)) continue;
      await b.create({ ...p, origin: "satin_alma", supplierId: tedarikci?.id ?? null });
    }

    for (const r of [
      { itemCode: "APU-331", serial: "APU-SN-44182" },
      { itemCode: "APU-331", serial: "APU-SN-44207" },
      { itemCode: "LGR-MAIN", serial: "LGR-SN-90114" },
    ]) {
      if (await s.byNumber(r.itemCode, r.serial)) continue;
      await s.create({ ...r, producedAt: d("2023-07-01"), warrantyMonths: 60 });
    }
    return "parti/seri: 2 raf ömürlü sarf partisi + 3 seri takipli rotable";
  });

  // ── 12. Yakıt alımı ── satın almanın en büyük kalemi.
  await step("satin-alma", async () => {
    if (await db.purchaseRequisition.count() > 0) return "satın alma: zaten var, atlandı";
    const proc = new ProcurementRepository(db as never);
    const po = await db.partner.findUnique({ where: { code: "S-2001" } });
    if (!po) throw new Error("Petrol Ofisi carisi yok");

    const talep = await proc.createRequisition({
      requestedBy: SEED_USER,
      department: "Operasyon",
      justification: "Eylül uçuş programı için Jet A-1 ikmali",
      at: d("2026-08-22"),
      lines: [
        { itemCode: "JETA1", quantity: 1_400_000, uom: "litre", estimatedPrice: 38.4, neededBy: d("2026-09-01") },
      ],
    });
    // Talebi açan ile onaylayan aynı kişi olamaz (görevler ayrılığı);
    // onay patron kimliğiyle atılır.
    await proc.approveRequisition({
      documentNo: talep.documentNo,
      approverId: "00000000-0000-0000-0000-0000000000aa",
      approverRoles: ["patron"],
    });
    await proc.convertToOrder({
      documentNo: talep.documentNo,
      partnerId: po.id,
      orderedAt: d("2026-08-23"),
      currency: "TRY",
    });
    return `satın alma: ${talep.documentNo} · 1.400.000 L Jet A-1`;
  });

  /*
   * ── 12b. MAL KABULÜ ── stok olmadan sayım da olmaz.
   *
   * Hava kargoda satılan şey hizmet olduğu için satış zinciri stok
   * hareketi ÜRETMİYOR. İlk denemede sayım "sayılacak kalem
   * bulunamadı" ile düştü ve bu doğru bir hataydı: boş depoda sayım
   * açmak anlamsız.
   *
   * Yakıt, ULD ve sarf gerçekten depoya giriyor — mal kabulü
   * zincirden geçerek, muhasebe kaydıyla birlikte.
   */
  await step("mal-kabul", async () => {
    const { ValuationRepository } = await import("../../db/valuation-repository.js");
    const val = new ValuationRepository(db as never);
    const teknik = await db.location.findUnique({ where: { code: "IST-TEK" } });
    const kargo = await db.location.findUnique({ where: { code: "IST-KRG" } });
    const yakit = await db.location.findUnique({ where: { code: "IST-YKT" } });
    if (!teknik || !kargo || !yakit) throw new Error("lokasyonlar eksik");

    const girisler = [
      { itemId: "JETA1", locationId: yakit.id, quantity: 1_400_000, unitCost: 38.4 },
      { itemId: "HYD-5606", locationId: teknik.id, quantity: 640, unitCost: 1_240 },
      { itemId: "OXY-BTL", locationId: teknik.id, quantity: 48, unitCost: 18_600 },
      { itemId: "DEICE", locationId: teknik.id, quantity: 24_000, unitCost: 96 },
      { itemId: "ULD-AKE", locationId: kargo.id, quantity: 186, unitCost: 186_000 },
      { itemId: "ULD-PMC", locationId: kargo.id, quantity: 94, unitCost: 94_000 },
    ];

    let yazilan = 0;
    for (const g of girisler) {
      const varMi = await db.stockMovement.findFirst({
        where: { itemId: g.itemId, locationId: g.locationId },
      });
      if (varMi) continue;
      await val.postReceipt({ ...g, at: d("2026-08-05"), userId: SEED_USER });
      yazilan += 1;
    }
    return `mal kabul: ${girisler.length} kalem depoda (${yazilan} yeni)`;
  });

  // ── 13. Sayım ── ULD sayımı, farkıyla.
  await step("sayim", async () => {
    if (await db.stockCount.count() > 0) return "sayım: zaten var, atlandı";
    const loc = await db.location.findUnique({ where: { code: "IST-KRG" } });
    if (!loc) throw new Error("kargo terminali yok");
    const counts = new StockCountRepository(db as never);
    const sayim = await counts.open({
      locationId: loc.id, countDate: d("2026-08-28"), userId: SEED_USER,
      blind: false, note: "ULD envanteri — istasyonlarda kalan konteynerler",
    });
    const view = await counts.byNo(sayim.documentNo);
    const satirlar = (view?.lines ?? []).slice(0, 3).map((l, i) => ({
      lineNo: l.lineNo,
      // ULD'ler istasyonlarda kalır ve eksik çıkar. Sektörün klasik
      // problemi; sıfır farklı bir ULD sayımı gerçekçi değildir.
      countedQty: Math.max(0, Number(l.systemQty) - [4, 0, 2][i]!),
    }));
    if (satirlar.length > 0) await counts.record(sayim.documentNo, satirlar);
    return `sayım: ${sayim.documentNo} · ULD envanteri, fark var`;
  });

  // ── 14. Kadro ve bordro ──
  await step("kadro", async () => {
    for (const k of KADRO) {
      if (await db.employee.findUnique({ where: { code: k.code } })) continue;
      await db.employee.create({
        data: {
          code: k.code, fullName: k.name, normalized: k.name.toLocaleLowerCase("tr"),
          department: k.dep, position: k.pos,
          hiredAt: d("2023-04-01"), grossSalary: k.gross, isActive: true,
        },
      });
    }
    const payroll = new PayrollRepository(db as never);
    let kosan = 0;
    for (let m = 0; m < 8; m += 1) {
      const period = new Date(Date.UTC(2026, m, 1));
      if (await db.payrollRun.findUnique({ where: { period } })) continue;
      await payroll.run({ period, userId: SEED_USER });
      kosan += 1;
    }
    return `kadro: ${KADRO.length} kişi (pilot, teknisyen, harekât) · ${kosan} ay bordro`;
  });

  // ── 15. Amortisman ──
  await step("amortisman", async () => {
    /*
     * YILLAR SIRAYLA AYRILIR — ATLANAMAZ.
     *
     * İlk yazımda yalnızca 2026 koşuluyordu ve dört uçak
     * "önce 2019, 2020… yılları ayrılmalı" diye atlanıyordu. Sistem
     * haklıydı: bir yılı atlayıp sonrakini ayırmak, birikmiş
     * amortismanı kalıcı olarak eksik bırakır ve net defter değeri bir
     * daha asla doğru olmaz.
     *
     * Gerçek bir şirkette bu yıllar zaten sırayla ayrılmıştır; demo
     * verisi de o geçmişi kurmalı.
     */
    const ilkYil = Math.min(2019, ...FILO.map((f) => Number(f.acquired.slice(0, 4))));
    let toplam = 0;
    let yazilan = 0;
    for (let y = ilkYil; y <= 2026; y += 1) {
      const r = await assets.run({ year: y, userId: SEED_USER }).catch(() => null);
      if (!r) continue;
      toplam += Number(r.total);
      yazilan += r.posted.length;
    }
    return `amortisman: ${ilkYil}–2026 arası ${yazilan} kayıt, toplam ${(toplam / 1e9).toFixed(2)} milyar ₺`;
  });

  // ── 16. İzin ──
  await step("izin", async () => {
    const leave = new LeaveRepository(db as never);
    const emp = await db.employee.findUnique({ where: { code: "P-003" } });
    if (!emp) throw new Error("P-003 yok");
    if ((await leave.listFor(emp.code, 2026)).length > 0) return "izin: zaten var, atlandı";
    await leave.request({
      employeeCode: emp.code, type: "yillik",
      startDate: d("2026-09-14"), endDate: d("2026-09-20"),
      reason: "Yıllık izin", requestedBy: SEED_USER,
    });
    return `izin: ${emp.fullName} 7 gün, onay bekliyor`;
  });

  // ── 17. İzlemeler ── havacılığın kendi eşikleri.
  /*
   * İZLEME SAHİBİ GERÇEK BİR KULLANICI OLMALI.
   *
   * Kurallar `SEED_USER` ile açılıyordu — o bir yer tutucu, gerçek
   * bir üyelik değil. Sonucu şuydu: zamanlanmış koşu her saat
   * "sahibi bu şirkette aktif değil" diyerek ikisini de atlıyordu.
   * Yani nöbetçi kuruluydu ve hiç nöbete çıkmıyordu.
   *
   * Sahip parametre olarak geliyor; çağıran, kiracının gerçek
   * kullanıcısını verir. Bulunamazsa kurallar HİÇ AÇILMAZ —
   * sahipsiz bir izleme, kurulmuş görünen ama çalışmayan bir
   * korumadır ve o, hiç kurulmamış olandan kötüdür.
   */
  await step("izleme", async () => {
    const w = new WatchRepository(db as never);
    if (watchOwnerUserId === null) {
      return "izleme: kiracının kullanıcısı yok, kural açılmadı";
    }
    const mevcut = new Set((await w.listFor(watchOwnerUserId)).map((x) => x.name));
    /*
     * TOOL GİRDİLERİ GERÇEKTEN GEÇERLİ OLMALI.
     *
     * Önce ikisi de `toolInput: {}` ile açılmıştı ve zamanlanmış koşum
     * eklenince ortaya çıktı: `get_bank_balance` para birimi,
     * `get_shipment_risk` hafta numarası istiyor — ikisi de
     * "invalid_input" ile düşüyordu.
     *
     * Hiç fark edilmemişti çünkü izlemeler HİÇ KOŞMAMIŞTI. Ve kök
     * neden şu: `create_watch` tool'u girdiyi tool'un şemasıyla
     * DOĞRULUYOR, ama tohumlama tool'u değil repository'yi çağırıp o
     * doğrulamayı atlıyor.
     */
    const kurallar = [
      {
        name: "Banka bakiyesi kritik", tool: "get_bank_balance",
        toolInput: { currency: "TRY" },
        path: "totalAvailable", operator: "lt" as const, threshold: 50_000_000,
        level: 2 as const, message: "Kullanılabilir banka bakiyesi 50 milyon ₺ altına düştü.",
      },
      {
        name: "Taahhüt riski", tool: "get_shipment_risk",
        // ISO hafta zorunlu; içinde bulunulan hafta hesaplanıyor.
        toolInput: { isoWeek: isoHafta(new Date()) },
        path: "atRiskCount", operator: "gt" as const, threshold: 0,
        level: 2 as const, message: "Taahhüt tarihi riske giren AWB var.",
      },
    ];
    let kurulan = 0;
    for (const k of kurallar) {
      if (mevcut.has(k.name)) continue;
      await w.create({ ...k, ownerUserId: watchOwnerUserId });
      kurulan += 1;
    }
    return `izleme: ${kurallar.length} kural (${kurulan} yeni)`;
  });

  /*
   * ── 17b. SEVKİYAT VE FATURA ──
   *
   * AWB'nin muhasebe karşılığı: yük uçağa yüklendiğinde sevkiyat,
   * ardından navlun faturası. Hizmet kalemi olduğu için stoktan
   * düşmez ama belge zinciri aynıdır — ve iade dekontu bu faturaya
   * bağlanır.
   */
  await step("fatura", async () => {
    if (await db.salesInvoice.findFirst()) return "fatura: zaten var, atlandı";
    const h = HATLAR[0]!;
    const kargo = await db.location.findUnique({ where: { code: "IST-KRG" } });
    if (!kargo) throw new Error("kargo terminali yok");

    const sevk = await sales.postDelivery({
      orderNo: h.awb,
      locationId: kargo.id,
      shippedAt: d(h.tarih),
      userId: SEED_USER,
      carrierName: "ULS Airlines Cargo",
      plateNo: "TC-ULD",
      lines: [{ orderLineNo: 10, quantity: h.kg }],
    });

    const teslim = await db.delivery.findUnique({ where: { documentNo: sevk.documentNo } });
    const satirlar = await db.deliveryLine.findMany({
      where: { deliveryId: teslim!.id },
      orderBy: { lineNo: "asc" },
    });
    /*
     * KUR AÇIKÇA VERİLİR, ARANMAZ.
     *
     * `issueInvoice` dövizli faturada kuru zorunlu tutuyor ve kendi
     * aramıyor — doğru bir tercih: faturaya yazılan kur bir KARARDIR,
     * belgeye basılır ve sonradan değişmez. Sistemin arka planda bir
     * kur "bulup" koyması, o kararı görünmez yapardı.
     */
    const { ValuationRepository } = await import("../../db/valuation-repository.js");
    const kur = await new ValuationRepository(db as never).rateFor("USD", d("2026-08-13"));

    const fat = await sales.issueInvoice({
      sources: satirlar.map((l) => ({ deliveryId: teslim!.id, deliveryLineNo: l.lineNo })),
      issuedAt: d("2026-08-13"),
      dueDate: d("2026-09-12"),
      userId: SEED_USER,
      exchangeRate: kur.rate,
    });
    return `fatura: ${sevk.documentNo} → ${fat.documentNo} (${h.rota}, ${h.kg.toLocaleString("tr-TR")} kg)`;
  });

  /*
   * ── 16a. MASRAF MERKEZLERİ VE BÜTÇE ──
   *
   * Bir havayolunun gider yapısı departmana göre keskin ayrışır:
   * yakıt uçuşun, bakım tekniğin, yer hizmeti harekâtın. Merkez
   * olmadan hepsi tek bir "gider" yığınıdır ve hangi tarafın
   * pahalılaştığı görülmez.
   */
  await step("masraf-merkezi", async () => {
    const merkezler = [
      { code: "UCS", name: "Uçuş Operasyonu", parentCode: null, managerEmployeeCode: "P-001" },
      { code: "UCS-YKT", name: "Yakıt", parentCode: "UCS", managerEmployeeCode: null },
      { code: "UCS-EKP", name: "Uçuş Ekibi", parentCode: "UCS", managerEmployeeCode: "P-001" },
      { code: "TEK", name: "Teknik / Bakım", parentCode: null, managerEmployeeCode: "P-004" },
      { code: "YER", name: "Yer Hizmetleri", parentCode: null, managerEmployeeCode: null },
      { code: "IDR", name: "İdari ve Mali", parentCode: null, managerEmployeeCode: null },
    ];
    let yeni = 0;
    for (const m of merkezler) {
      const varMi = await db.costCenter.findUnique({ where: { code: m.code } });
      if (varMi) continue;
      await db.costCenter.create({ data: m });
      yeni += 1;
    }

    /*
     * BÜTÇE YILLIK GİRİLİYOR, AYA BÖLÜNMÜYOR.
     *
     * Havacılıkta gider mevsimseldir: bakım kışın yoğunlaşır, yakıt
     * yaz tarifesinde artar. Aylık bütçe uydurmak, her ay yanlış bir
     * "aşım" alarmı üretirdi.
     */
    const butceler = [
      { costCenterCode: "UCS-YKT", accountGroup: "730", amount: 620_000_000 },
      { costCenterCode: "UCS-EKP", accountGroup: "770", amount: 42_000_000 },
      { costCenterCode: "TEK", accountGroup: "730", amount: 185_000_000 },
      { costCenterCode: "YER", accountGroup: "760", amount: 48_000_000 },
      { costCenterCode: "IDR", accountGroup: "770", amount: 26_000_000 },
    ];
    let butceYeni = 0;
    for (const b of butceler) {
      const varMi = await db.budget.findFirst({
        where: { costCenterCode: b.costCenterCode, accountGroup: b.accountGroup, year: 2026, month: null },
      });
      if (varMi) continue;
      await db.budget.create({
        data: { ...b, year: 2026, month: null, currency: "TRY", setBy: SEED_USER },
      });
      butceYeni += 1;
    }
    return `masraf merkezi: ${merkezler.length} merkez (${yeni} yeni) · ${butceYeni} yeni bütçe`;
  });

  /*
   * ── 16b. İHTAR KADEMELERİ ──
   *
   * Kademeler KONFİGÜRASYONDUR, demo verisi değil — ama tanımlı
   * değilken `plan_dunning_run` hiçbir şey yapamaz ve kullanıcı
   * "bozuk" sanır. Makul bir başlangıç kurulur; işletme değiştirir.
   *
   * Faiz oranları ilk kademede YOK: ilk hatırlatmada faiz istemek,
   * çoğu zaman unutulmuş bir ödemeyi ticari bir soruna çevirir.
   */
  await step("ihtar-kademe", async () => {
    const kademeler = [
      { level: 1, minOverdueDays: 15, label: "Hatırlatma", interestRate: null,
        body: "Vadesi geçmiş bakiyenizi hatırlatmak isteriz. Ödemenizi yaptıysanız bu yazıyı dikkate almayınız." },
      { level: 2, minOverdueDays: 45, label: "İkinci ihtar", interestRate: 36,
        body: "Vadesi geçen borcunuz için ikinci kez bildirimde bulunuyoruz. Gecikme faizi işletilmektedir." },
      { level: 3, minOverdueDays: 90, label: "Son ihtar", interestRate: 48,
        body: "Bu son bildirimdir. Ödeme yapılmadığı takdirde hukuki yollara başvurma hakkımız saklıdır." },
    ];
    let yeni = 0;
    for (const k of kademeler) {
      const r = await db.dunningLevel.upsert({
        where: { level: k.level },
        create: k,
        update: {},
      });
      if (r) yeni += 1;
    }
    return `ihtar: ${yeni} kademe (15/45/90 gün)`;
  });

  /*
   * ── 17a. BANKA HESAPLARI ──
   *
   * NAKİT PROJEKSİYONUNUN AÇILIŞ SATIRI. Hesap yoksa `openingCash`
   * elle verilmek zorunda kalıyor ve tool "banka bakiyesi okunamadı"
   * diyor — doğru davranış ama kullanılabilir bir demo değil.
   *
   * Hem TL hem USD hesap var: navlun geliri USD, yakıt ve yer
   * hizmeti gideri TL. Tek para birimli bir havayolu yoktur.
   */
  await step("banka", async () => {
    const hesaplar = [
      { bank: "Garanti BBVA", externalId: "ULS-TRY-001", currency: "TRY",
        iban: "TR33 0006 2000 0000 0012 3456 78", available: 84_600_000, blocked: 0 },
      { bank: "İş Bankası", externalId: "ULS-TRY-002", currency: "TRY",
        iban: "TR64 0006 4000 0011 2345 6789 01", available: 21_350_000, blocked: 6_200_000 },
      { bank: "Garanti BBVA", externalId: "ULS-USD-001", currency: "USD",
        iban: "TR12 0006 2000 0000 0098 7654 32", available: 3_180_000, blocked: 0 },
      { bank: "Yapı Kredi", externalId: "ULS-EUR-001", currency: "EUR",
        iban: "TR90 0006 7010 0000 0055 4433 22", available: 412_000, blocked: 0 },
    ];
    let yeni = 0;
    for (const h of hesaplar) {
      const acc = await db.bankAccount.upsert({
        where: { externalId_currency: { externalId: h.externalId, currency: h.currency } },
        create: { bank: h.bank, externalId: h.externalId, iban: h.iban, currency: h.currency },
        update: {},
      });
      // Bakiye anlık görüntüdür: bankanın bildirdiği AN yazılır, bizim
      // yazdığımız an değil. Aynı an ikinci kez yazılmaz.
      const anda = d("2026-08-31");
      const varMi = await db.bankBalanceSnapshot.findUnique({
        where: { accountId_asOf: { accountId: acc.id, asOf: anda } },
      });
      if (varMi) continue;
      await db.bankBalanceSnapshot.create({
        data: { accountId: acc.id, asOf: anda, available: h.available, blocked: h.blocked },
      });
      yeni += 1;
    }
    return `banka: ${hesaplar.length} hesap (TRY/USD/EUR) · ${yeni} yeni bakiye`;
  });

  /*
   * ── 17b. AÇIK BORÇLAR VE VADELER ──
   *
   * ÖDEME KOŞUSUNUN VE NAKİT AKIŞININ HAM MADDESİ. Bunlar olmadan
   * `plan_payment_run` boş liste, `project_cash_flow` düz çizgi
   * döndürür — tool çalışır görünür ama hiçbir şey göstermez.
   *
   * Faturalar doğrudan yazılıyor: gerçek hayatta gelen fatura
   * entegratörden düşer, satın alma zincirinden geçmez. Vadesi
   * `vade` alanında AÇIKÇA duruyor; carinin vadesinden hesaplanıp
   * yazılsaydı, seed uydurma bir tarihi gerçek gibi kaydederdi.
   */
  await step("vade", async () => {
    let vadeYazilan = 0;
    for (const [kod, gun] of Object.entries(VADELER)) {
      const r = await db.partner.updateMany({
        where: { code: kod, paymentTermsDays: null },
        data: { paymentTermsDays: gun },
      });
      vadeYazilan += r.count;
    }

    let yeni = 0;
    for (const f of GELEN_FATURALAR) {
      if (await db.invoice.findFirst({ where: { documentNo: f.no } })) continue;
      const cari = await db.partner.findUnique({ where: { code: f.cari } });
      if (!cari) continue;
      await db.invoice.create({
        data: {
          partnerId: cari.id,
          documentNo: f.no,
          issuedAt: d(f.kesim),
          dueDate: f.vade === null ? null : d(f.vade),
          currency: f.para,
          matchStatus: f.durum,
          // Bloke faturanın farkı kayıtlı olmalı: "neden bloke" sorusunun
          // cevabı belgede durmazsa bloke çözülemez.
          totalVariance: f.durum === "blocked" ? 184_320 : null,
          lines: {
            create: [
              {
                lineNo: 10,
                itemId: f.kalem,
                quantity: f.miktar,
                unitPrice: f.fiyat,
                currency: f.para,
              },
            ],
          },
        },
      });
      yeni += 1;
    }
    return `vade: ${yeni} gelen fatura (1 bloke, 1 vadesiz, 1 dövizli) · ${vadeYazilan} cariye vade`;
  });

  /*
   * ── 17c. ÖDEME VE BANKA EKSTRESİ ──
   *
   * MUTABAKATIN GÖSTERİLEBİLMESİ İÇİN ÖNCE ÖDEME GEREKİR. Ekstre
   * satırı tek başına bir şey anlatmaz; anlamı, karşısında duran
   * ödemeyle eşleşip eşleşmemesinde.
   *
   * Ekstre KASITLI OLARAK ÜÇ SATIRLI: biri ödemeyle tam eşleşir,
   * biri hiçbir kayda uymaz (banka masrafı — sistemde karşılığı yok),
   * biri ise tutarı tutan ama başka bir tarihte olan bir hareket.
   * Hepsi eşleşseydi mutabakat aracı yalnızca kolay hâlini gösterirdi.
   */
  await step("tahsilat", async () => {
    if (await db.payment.count() > 0) return "tahsilat: zaten var, atlandı";
    const yakit = await db.partner.findUnique({ where: { code: "S-2001" } });
    if (!yakit) return "tahsilat: cari yok, atlandı";

    // Temmuz yakıt faturasının ödemesi — 23.808.000 ₺.
    const odeme = await db.payment.create({
      data: {
        documentNo: "ODM-2026-0001",
        direction: "outgoing",
        partnerId: yakit.id,
        amount: 23_808_000,
        currency: "TRY",
        method: "eft",
        paidAt: d("2026-08-14"),
        reference: "DK20260814",
        createdBy: SEED_USER,
        allocations: { create: [{ invoiceNo: "GF-2026-4488", amount: 23_808_000 }] },
      },
    });

    const hesap = await db.bankAccount.findUnique({
      where: { externalId_currency: { externalId: "ULS-TRY-001", currency: "TRY" } },
    });
    if (!hesap) return `tahsilat: ${odeme.documentNo} (banka hesabı yok, ekstre atlandı)`;

    const varMi = await db.bankStatement.findUnique({
      where: { accountId_statementNo: { accountId: hesap.id, statementNo: "EK-2026-08" } },
    });
    if (varMi) return `tahsilat: ${odeme.documentNo} · ekstre zaten var`;

    // Açılış + hareketler = kapanış olacak şekilde kuruluyor; tutarsız
    // bir ekstre tohumlamak, aracın uyarısını yalancı çıkarırdı.
    const hareketler = [
      { lineNo: 1, valueDate: d("2026-08-14"), amount: -23_808_000,
        description: "EFT DK20260814 PETROL OFISI HAVACILIK", counterparty: "PETROL OFISI HAVACILIK A.S.",
        reference: "DK20260814" },
      { lineNo: 2, valueDate: d("2026-08-14"), amount: -175,
        description: "EFT MASRAFI", counterparty: null, reference: null },
      { lineNo: 3, valueDate: d("2026-08-26"), amount: 412_000,
        description: "GELEN HAVALE MUHTELIF", counterparty: null, reference: null },
    ];
    const hareket = hareketler.reduce((t, h) => t + h.amount, 0);
    await db.bankStatement.create({
      data: {
        accountId: hesap.id,
        statementNo: "EK-2026-08",
        fromDate: d("2026-08-01"),
        toDate: d("2026-08-31"),
        openingBalance: 84_600_000,
        closingBalance: 84_600_000 + hareket,
        currency: "TRY",
        importedBy: SEED_USER,
        lines: { create: hareketler },
      },
    });
    return `tahsilat: ${odeme.documentNo} + EK-2026-08 (3 hareket, 1'i eşleşir)`;
  });

  // ── 18. İade dekontu ── navlun düzeltmesi.
  await step("iade", async () => {
    if (await db.salesCreditNote.count() > 0) return "iade: zaten var, atlandı";
    const inv = await db.salesInvoice.findFirst({ include: { lines: true } });
    if (!inv || inv.lines.length === 0) return "iade: fatura yok, atlandı";
    const notes = new CreditNoteRepository(db as never);
    const note = await notes.issue({
      kind: "iade", invoiceNo: inv.documentNo, issuedAt: d("2026-08-27"),
      reason: "Tartı farkı — çıkış ağırlığı fatura ağırlığından düşük",
      withGoods: false, userId: SEED_USER,
      lines: [{ invoiceLineNo: inv.lines[0]!.lineNo, quantity: 400 }],
    });
    return `iade: ${note.documentNo} · tartı farkı düzeltmesi`;
  });

  return { done, failed };
}
