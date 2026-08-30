/**
 * Demo satış zinciri verisi.
 *
 * ÜRÜNÜ GÖREN KİŞİ FATURAYI GÖRMELİ. Demo tenant'ında hiç satış
 * faturası yoktu; "şu faturayı göster" diyen bir kullanıcı boş bir
 * cevap alıyordu ve ürünün e-Fatura zinciri — mevzuat açısından en
 * ayırt edici parçası — görünmez kalıyordu.
 *
 * VERİ ZİNCİRDEN GEÇEREK ÜRETİLİR. Fatura satırlarını doğrudan
 * veritabanına yazmak daha kısa olurdu ama demo verisi o zaman
 * gerçeğe benzemezdi: sevkiyata bağlı olmayan bir fatura, üç yönlü
 * eşleştirmeden geçmez, belge akışında görünmez ve muhasebe
 * kaydıyla bağlanmaz. Burada sipariş → sevkiyat → fatura sırası
 * gerçek iş akışının kendisiyle işletiliyor.
 *
 *   npm run demo:data -- <slug>
 */

import { disconnectAll, sharedClient, tenantClient } from "../db/client.js";
import { AssetRepository } from "../db/asset-repository.js";
import { PayrollRepository } from "../db/payroll-repository.js";
import { JournalRepository } from "../db/journal-repository.js";
import { SalesRepository } from "../db/sales-repository.js";

const SYSTEM_USER = "00000000-0000-0000-0000-0000000000de";

async function main(): Promise<void> {
  const slug = process.argv[2] ?? "demo";
  const shared = sharedClient();
  const tenant = await shared.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`Tenant bulunamadı: ${slug}`);
    process.exitCode = 1;
    return;
  }

  const db = tenantClient(tenant.schemaName);
  const sales = new SalesRepository(db as never);

  // ── 1. Şirket kimliği ── e-Fatura düzenleyeni. Bu olmadan hiçbir
  // belge üretilemez ve faturanın anteti boş kalır.
  await db.companyProfile.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      legalName: `${tenant.name} Makina Sanayi ve Ticaret A.Ş.`,
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
      legalName: "Daimler Truck Otomotiv Sanayi A.Ş.",
      normalized: "daimler truck otomotiv sanayi",
      isCustomer: true,
      country: "TR",
      taxOffice: "Büyük Mükellefler",
      addressLine: "Mercedes Caddesi No: 1",
      district: "Esenyurt",
      city: "İstanbul",
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
  const items = [
    // Eski demo kartları — başka akışların bağlandığı kodlar korunuyor.
    { code: "M-1001", name: "Şasi Profili 60x40", uom: "adet", type: "hammadde", price: 250, vat: 20 },
    { code: "M-1002", name: "Kaynak Teli 1.2mm", uom: "kg", type: "sarf", price: 180, vat: 20 },
    { code: "M-1003", name: "Montaj İşçiliği", uom: "saat", type: "hizmet", price: 900, vat: 20 },
    { code: "FR-22", name: "Şasi Profili FR-22", uom: "adet", type: "mamul", price: 4850, vat: 20 },
    { code: "KP-08", name: "Kaplin Grubu KP-08", uom: "adet", type: "mamul", price: 12600, vat: 20 },
    { code: "BR-14", name: "Bağlantı Braketi BR-14", uom: "adet", type: "mamul", price: 940, vat: 10 },
  ];
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
      userId: SYSTEM_USER,
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
    console.log("açılış kaydı yazıldı");
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
      userId: SYSTEM_USER,
      lines: [
        { accountCode: "254", debit: 1_850_000, credit: 0, description: "Ford Transit" },
        { accountCode: "102", debit: 0, credit: 1_850_000, description: "Taşıt bedeli ödemesi" },
      ],
    });
    console.log("taşıt alım kaydı yazıldı");
  }

  // ── 4c. Sabit kıymetler ──
  //
  // Amortisman her işletmede vardır ve bilançonun duran varlık
  // tarafını o kurar. Demoda hiç kıymet olmasaydı "Maddi Duran
  // Varlıklar" satırı yalnızca açılış kaydından gelir ve amortisman
  // hiç çalışmazdı.
  const assets = new AssetRepository(db as never);
  const demoAssets = [
    { code: "SK-001", name: "CNC Torna Tezgahı", category: "makine", cost: 2_400_000, life: 10, method: "normal" as const },
    { code: "SK-002", name: "Kaynak Robotu", category: "makine", cost: 1_600_000, life: 8, method: "azalan" as const },
    { code: "SK-003", name: "Ford Transit (Binek)", category: "tasit", cost: 1_850_000, life: 5, method: "normal" as const },
    { code: "SK-004", name: "Ofis Mobilyası", category: "demirbas", cost: 320_000, life: 5, method: "normal" as const },
  ];
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
    console.log(`sabit kıymet: ${a.code} ${a.name}`);
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
    console.log(`sipariş kuruldu: ${orderNo}`);
  }

  // ── 6. Sevkiyat ── kısmi: gerçek imalatta sevkiyat çoğunlukla kısmidir.
  const already = await db.delivery.findFirst({ where: { salesOrder: { orderNo } } });
  let deliveryId = already?.id ?? null;
  if (!already) {
    const d = await sales.postDelivery({
      orderNo,
      locationId: location.id,
      shippedAt: new Date("2026-08-20"),
      userId: SYSTEM_USER,
      carrierName: "Aras Kargo",
      plateNo: "34 ABC 123",
      lines: [
        { orderLineNo: 10, quantity: 25 },
        { orderLineNo: 20, quantity: 12 },
        { orderLineNo: 30, quantity: 120 },
      ],
    });
    console.log(`sevkiyat kesildi: ${d.documentNo}`);
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
      userId: SYSTEM_USER,
    });
    console.log(`fatura kesildi: ${inv.documentNo} · ${inv.totalAmount} TRY`);
  } else if (invoiced) {
    console.log(`fatura zaten var: ${invoiced.documentNo}`);
  }

  // ── 8. Amortisman ──
  // Kıymetler açıldı ama amortisman ayrılmazsa bilanço duran
  // varlıkları olduğundan büyük gösterir.
  const anyRun = await db.depreciationRun.findFirst();
  if (!anyRun) {
    const r = await assets.run({ year: 2026, userId: SYSTEM_USER });
    console.log(`2026 amortismanı ayrıldı: ${r.posted.length} kıymet, ${r.total} TL`);
  }

  // ── 9. Personel ve bordro ──
  //
  // Bordro işletmenin en büyük ikinci gider kalemidir ve her ay
  // tekrar eder. Demoda personel olmasaydı "bu ay maaşlar ne tuttu"
  // sorusu cevapsız kalırdı.
  const staff = [
    { code: "P-001", name: "Ayşe Yılmaz", dep: "Üretim", pos: "CNC Operatörü", gross: 42_000 },
    { code: "P-002", name: "Mehmet Kaya", dep: "Muhasebe", pos: "Muhasebe Müdürü", gross: 135_000 },
    { code: "P-003", name: "Elif Demir", dep: "Üretim", pos: "Kaynakçı", gross: 38_500 },
    { code: "P-004", name: "Burak Şahin", dep: "Satış", pos: "Satış Temsilcisi", gross: 66_000 },
    { code: "P-005", name: "Zeynep Ak", dep: "Üretim", pos: "Vardiya Amiri", gross: 33_030 },
  ];
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
    const r = await payroll.run({ period, userId: SYSTEM_USER });
    if (m === 7) {
      console.log(
        `bordro ${r.period.slice(0, 7)}: ${r.employeeCount} çalışan, net ${r.totalNet} TL`,
      );
    }
  }

  await disconnectAll();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
  await disconnectAll();
});
