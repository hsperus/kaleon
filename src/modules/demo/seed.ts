/**
 * Demo tenant'ını gerçek iş akışıyla doldurur.
 *
 * VERİ ZİNCİRDEN GEÇEREK ÜRETİLİR. Fatura satırlarını doğrudan
 * veritabanına yazmak daha kısa olurdu ama demo verisi o zaman
 * gerçeğe benzemezdi: sevkiyata bağlı olmayan bir fatura üç yönlü
 * eşleştirmeden geçmez, belge akışında görünmez ve muhasebe kaydıyla
 * bağlanmaz. Burada sipariş → sevkiyat → fatura sırası gerçek iş
 * akışının kendisiyle işletiliyor.
 *
 * SEKTÖR YALNIZCA SÖZLÜĞÜ DEĞİŞTİRİR. Kalem adları, müşteri, makineler
 * ve unvanlar profilden gelir; açılış bilançosu, amortisman kuralları
 * ve bordro parametreleri her sektörde aynıdır. Mevzuat sektöre göre
 * değişmez — değişseydi her sektör için ayrı doğrulama gerekirdi.
 *
 * HER ADIM YENİDEN ÇALIŞTIRILABİLİR. Var olan kaydı bulunca atlar;
 * yarıda kalan bir kurulum baştan çalıştırılabilsin diye.
 */

import { AssetRepository } from "../../db/asset-repository.js";
import { PayrollRepository } from "../../db/payroll-repository.js";
import { JournalRepository } from "../../db/journal-repository.js";
import { SalesRepository } from "../../db/sales-repository.js";
import type { TenantDb } from "../../db/client.js";
import { legalNameFor, sectorProfile, staffNames } from "./sectors.js";

/** Tohumlamayı yazan sistem kullanıcısı — gerçek bir kişi değildir. */
export const SEED_USER = "00000000-0000-0000-0000-0000000000de";

export interface DemoProfile {
  /** Şirketin görünen adı; unvan buna sektörün ekiyle kurulur. */
  readonly companyName: string;
  /** Sektör kimliği; bilinmiyorsa makina profiline düşer. */
  readonly sector?: string | null;
}

export async function seedDemoTenant(db: TenantDb, p: DemoProfile): Promise<void> {
  const sector = sectorProfile(p.sector);
  const sales = new SalesRepository(db as never);

  // ── 1. Şirket kimliği ── e-Fatura düzenleyeni. Bu olmadan hiçbir
  // belge üretilemez ve faturanın anteti boş kalır.
  await db.companyProfile.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      legalName: legalNameFor(p.companyName, sector),
      taxId: "1234567890",
      taxOffice: "Beşiktaş",
      addressLine: "Organize Sanayi Bölgesi 4. Cadde No: 12",
      district: "Beşiktaş",
      city: "İstanbul",
      postalCode: "34349",
      country: "TR",
      email: "muhasebe@example.com",
      phone: "+90 212 000 00 00",
      mersisNo: "0123456789000015",
      tradeRegistryNo: "123456-5",
    },
    update: {},
  });

  // ── 2. Müşteri ── e-Fatura mükellefi ve TÜM zorunlu alanları dolu:
  // eksik bir alan bırakılsaydı demo, ürünün belge üretemediğini
  // gösterirdi.
  const partner = await db.partner.upsert({
    where: { code: "C-1001" },
    create: {
      code: "C-1001",
      legalName: sector.customer.legalName,
      normalized: sector.customer.legalName.toLocaleLowerCase("tr"),
      isCustomer: true,
      country: "TR",
      taxOffice: "Büyük Mükellefler",
      addressLine: "Mercedes Caddesi No: 1",
      district: sector.customer.district,
      city: sector.customer.city,
      postalCode: "34510",
      email: "tedarik@example.com",
      phone: "+90 212 111 11 11",
      einvoiceUser: true,
      einvoiceAlias: "urn:mail:defaultpk@example.com",
      taxIds: { create: [{ kind: "vkn", value: "2960033525" }] },
    },
    update: {},
  });

  // ── 3. Depo ──
  const location = await db.location.upsert({
    where: { code: "MERKEZ" },
    create: { code: "MERKEZ", name: "Merkez Depo", kind: "warehouse" },
    update: {},
  });

  // ── 4. Kalemler ── ürün kartı yoksa sipariş kalemi bağlanamaz.
  const items = sector.items;
    for (const it of items) {
    await db.item.upsert({
      where: { code: it.code },
      create: {
        code: it.code,
        name: it.name,
        normalized: it.name.toLocaleLowerCase("tr"),
        type: it.type,
        baseUom: it.uom,
      },
      update: {},
    });
  }

  // ── 4b. Açılış kaydı ──
  //
  // BİLANÇO OLMADAN ERP GÖSTERİLEMEZ. Yalnızca satış faturasının
  // doğurduğu kayıtla bir bilanço çıkarılabilir ama içi neredeyse
  // boştur: sermaye yok, banka yok, stok yok, demirbaş yok. Açılış
  // kaydı bunları kurar ve bilanço gerçek bir işletmeninki gibi görünür.
  const journal = new JournalRepository(db as never);
  const opening = await db.journalEntry.findFirst({ where: { description: { contains: "Açılış" } } });
  if (!opening) {
    await journal.post({
      entryDate: new Date("2026-01-01"),
      description: "Açılış bilançosu kaydı",
      sourceKind: "manual",
      userId: SEED_USER,
      /*
       * KIYMET HESAPLARI SABİT KIYMET KAYDIYLA BİREBİR TUTAR.
       *
       * İlk sürümde hepsi 255'e yazılmıştı ve sabit kıymet mutabakatı
       * 1.670.000 TL fark verdi: kayıt 253/254/255'e dağılmışken
       * defter tek hesapta duruyordu. Demo verisi bile mutabık
       * olmalıdır — aksi hâlde ürünü ilk gören kişi, kendi kurduğumuz
       * uyarıyla karşılaşır.
       *
       * Taşıt burada YOK: 18 Nisan'da alınıyor ve kendi kaydıyla
       * giriyor (kıst amortismanı da o yüzden çalışıyor).
       */
      lines: [
        { accountCode: "100", debit: 250_000, credit: 0, description: "Kasa açılış" },
        { accountCode: "102", debit: 12_400_000, credit: 0, description: "Banka açılış" },
        { accountCode: "150", debit: 3_200_000, credit: 0, description: "Hammadde stoğu" },
        { accountCode: "152", debit: 1_800_000, credit: 0, description: "Mamul stoğu" },
        { accountCode: "253", debit: 4_000_000, credit: 0, description: "Tesis, makine ve cihazlar" },
        { accountCode: "255", debit: 320_000, credit: 0, description: "Demirbaşlar" },
        {
          accountCode: "320",
          debit: 0,
          credit: 2_900_000,
          description: "Satıcılara borç",
          partnerId: partner.id,
        },
        { accountCode: "500", debit: 0, credit: 19_070_000, description: "Ödenmiş sermaye" },
      ],
    });
  }

  // Taşıt alımı — yıl ortasında, kıst amortismanın çalıştığı örnek.
  const vehicle = await db.journalEntry.findFirst({
    where: { description: { contains: "Taşıt alımı" } },
  });
  if (!vehicle) {
    await journal.post({
      entryDate: new Date("2026-04-18"),
      description: "Taşıt alımı (SK-003)",
      sourceKind: "manual",
      userId: SEED_USER,
      lines: [
        { accountCode: "254", debit: 1_850_000, credit: 0, description: "Ford Transit" },
        { accountCode: "102", debit: 0, credit: 1_850_000, description: "Taşıt bedeli ödemesi" },
      ],
    });
  }

  // ── 4c. Sabit kıymetler ──
  //
  // Amortisman her işletmede vardır ve bilançonun duran varlık
  // tarafını o kurar. Demoda hiç kıymet olmasaydı "Maddi Duran
  // Varlıklar" satırı yalnızca açılış kaydından gelir ve amortisman
  // hiç çalışmazdı.
  const assets = new AssetRepository(db as never);
  const demoAssets = sector.assets.map((a, i) => ({
    code: `SK-00${i + 1}`,
    name: a.name,
    category: a.category,
    cost: [2_400_000, 1_600_000, 1_850_000, 320_000][i]!,
    life: [10, 8, 5, 5][i]!,
    method: (i === 1 ? "azalan" : "normal") as "azalan" | "normal",
  }));
    for (const a of demoAssets) {
    const has = await db.fixedAsset.findUnique({ where: { code: a.code } });
    if (has) continue;
    await assets.create({
      code: a.code,
      name: a.name,
      category: a.category,
      acquiredAt: new Date(a.code === "SK-003" ? "2026-04-18" : "2026-01-05"),
      cost: a.cost,
      usefulLifeYears: a.life,
      method: a.method,
      // Kıst yalnızca binek otomobilde (VUK 320).
      prorated: a.category === "tasit",
      assetAccount: a.category === "makine" ? "253" : a.category === "tasit" ? "254" : "255",
      expenseAccount: a.category === "makine" ? "730" : "770",
    });
  }

  // ── 5. Sipariş ──
  const orderNo = "SO-2026-0427";
  const existing = await db.salesOrder.findUnique({ where: { orderNo } });
  if (!existing) {
    await db.salesOrder.create({
      data: {
        orderNo,
        partnerId: partner.id,
        committedDate: new Date("2026-09-15"),
        penaltyPerDay: 31200,
        penaltyCap: 156000,
        currency: "TRY",
        status: "open",
        lines: {
          // Siparişe yalnızca mamuller girer; hammadde ve sarf satılmaz.
          create: items
            .filter((it) => it.type === "mamul")
            .map((it, i) => ({
              lineNo: (i + 1) * 10,
              itemId: it.code,
              quantity: [40, 12, 120][i]!,
              uom: it.uom,
              unitPrice: it.price,
              discountPercent: i === 2 ? 5 : 0,
              vatRate: it.vat,
            })),
        },
      },
    });
  }

  // ── 6. Sevkiyat ── kısmi: gerçek imalatta sevkiyat çoğunlukla kısmidir.
  const already = await db.delivery.findFirst({ where: { salesOrder: { orderNo } } });
  let deliveryId = already?.id ?? null;
  if (!already) {
    const d = await sales.postDelivery({
      orderNo,
      locationId: location.id,
      shippedAt: new Date("2026-08-20"),
      userId: SEED_USER,
      carrierName: "Aras Kargo",
      plateNo: "34 ABC 123",
      lines: [
        { orderLineNo: 10, quantity: 25 },
        { orderLineNo: 20, quantity: 12 },
        { orderLineNo: 30, quantity: 120 },
      ],
    });
    deliveryId = (await db.delivery.findUnique({ where: { documentNo: d.documentNo } }))!.id;
  }

  // ── 7. Fatura ──
  const invoiced = await db.salesInvoice.findFirst({ where: { partnerId: partner.id } });
  if (!invoiced && deliveryId) {
    const lines = await db.deliveryLine.findMany({
      where: { deliveryId },
      orderBy: { lineNo: "asc" },
    });
    const inv = await sales.issueInvoice({
      sources: lines.map((l) => ({ deliveryId, deliveryLineNo: l.lineNo })),
      issuedAt: new Date("2026-08-22"),
      dueDate: new Date("2026-09-21"),
      userId: SEED_USER,
    });
  } else if (invoiced) {
  }

  // ── 8. Amortisman ──
  // Kıymetler açıldı ama amortisman ayrılmazsa bilanço duran
  // varlıkları olduğundan büyük gösterir.
  const anyRun = await db.depreciationRun.findFirst();
  if (!anyRun) {
    const r = await assets.run({ year: 2026, userId: SEED_USER });
  }

  // ── 9. Personel ve bordro ──
  //
  // Bordro işletmenin en büyük ikinci gider kalemidir ve her ay
  // tekrar eder. Demoda personel olmasaydı "bu ay maaşlar ne tuttu"
  // sorusu cevapsız kalırdı.
  const staff = sector.staff.map((s, i) => ({
    code: `P-00${i + 1}`,
    name: staffNames()[i]!,
    dep: s.department,
    pos: s.position,
    gross: [42_000, 135_000, 38_500, 66_000, 33_030][i]!,
  }));
    for (const e of staff) {
    const has = await db.employee.findUnique({ where: { code: e.code } });
    if (has) continue;
    await db.employee.create({
      data: {
        code: e.code,
        fullName: e.name,
        normalized: e.name.toLocaleLowerCase("tr"),
        department: e.dep,
        position: e.pos,
        hiredAt: new Date("2024-02-01"),
        grossSalary: e.gross,
        isActive: true,
      },
    });
  }

  const payroll = new PayrollRepository(db as never);
  // Ocak–Ağustos: kümülatif matrahın yürüdüğü ve vergi diliminin
  // yükseldiği gerçek bir tablo çıksın.
  for (let m = 0; m < 8; m += 1) {
    const period = new Date(Date.UTC(2026, m, 1));
    const done = await db.payrollRun.findUnique({ where: { period } });
    if (done) continue;
    const r = await payroll.run({ period, userId: SEED_USER });
    if (m === 7) {
    }
  }

}
