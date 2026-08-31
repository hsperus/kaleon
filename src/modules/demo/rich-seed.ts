/**
 * Zengin tohumlama — her modülde denenecek bir şey bırakır.
 *
 * TEMEL TOHUMLAMA SATIŞ ZİNCİRİNİ KURAR: sipariş → sevkiyat → fatura,
 * artı açılış bilançosu, amortisman ve bordro. Bu, ürünü ANLATMAK için
 * yeterli ama DENEMEK için değil: satın alma, kalite, bakım, parti
 * takibi, sayım, iade ve izleme modülleri bomboş kalıyor ve o modüllere
 * ait bir soru sorulduğunda "kayıt yok" cevabı geliyor.
 *
 * "Kayıt yok" doğru bir cevaptır ama ürünü değerlendiren kişiye
 * çalışmıyormuş gibi görünür.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * VERİ ZİNCİRDEN GEÇEREK ÜRETİLİR — burada da. Doğrudan tabloya yazmak
 * çok daha kısa olurdu ama o kayıtlar gerçek iş akışının bıraktığı ize
 * benzemezdi: onaysız bir sipariş, harekete bağlanmamış bir parti,
 * mizanla tutmayan bir sayım farkı. Denemeye gelen kişi tam da bu
 * bağları arıyor.
 *
 * HER ADIM KENDİ HATASINI YUTAR. Bir modülün tohumlaması patlarsa
 * diğerleri devam eder ve sonda hangilerinin kurulduğu raporlanır.
 * "Hepsi ya da hiçbiri" burada yanlış olurdu: tek bir modülün eksik
 * verisi yüzünden bütün ortamı kaybetmek, kazandığından çoğunu
 * kaybettirir.
 */

import { ProcurementRepository } from "../../db/procurement-repository.js";
import { BatchRepository } from "../../db/batch-repository.js";
import { StockCountRepository } from "../../db/stock-count-repository.js";
import { MaintenanceRepository } from "../../db/maintenance-repository.js";
import { LeaveRepository } from "../../db/leave-repository.js";
import { CreditNoteRepository } from "../../db/credit-note-repository.js";
import { WatchRepository } from "../../db/watch-repository.js";
import type { TenantDb } from "../../db/client.js";
import { SEED_USER } from "./seed.js";
import { sectorProfile } from "./sectors.js";

export interface RichResult {
  readonly done: readonly string[];
  readonly failed: readonly { module: string; reason: string }[];
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

export async function seedRichTenant(
  db: TenantDb,
  opts: { sector?: string | null; ownerUserId?: string } = {},
): Promise<RichResult> {
  const sector = sectorProfile(opts.sector);
  const owner = opts.ownerUserId ?? SEED_USER;
  const done: string[] = [];
  const failed: { module: string; reason: string }[] = [];

  /** Bir modülü dener; patlarsa yutar ve raporlar. */
  async function step(name: string, fn: () => Promise<string>): Promise<void> {
    try {
      done.push(await fn());
    } catch (e) {
      failed.push({ module: name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const location = await db.location.findFirst({ where: { code: "MERKEZ" } });
  const partner = await db.partner.findFirst({ where: { isCustomer: true } });
  const hammadde = sector.items.find((i) => i.type === "hammadde")!;
  const mamul = sector.items.filter((i) => i.type === "mamul");

  // ── Tedarikçi ── satın alma zincirinin karşı tarafı.
  const tedarikci = await db.partner.upsert({
    where: { code: "S-2001" },
    create: {
      code: "S-2001",
      legalName: "Anadolu Tedarik Sanayi Ltd. Şti.",
      normalized: "anadolu tedarik sanayi",
      isSupplier: true,
      country: "TR",
      taxOffice: "Kozyatağı",
      city: "İstanbul",
      district: "Kadıköy",
      addressLine: "Sanayi Caddesi No: 44",
      taxIds: { create: [{ kind: "vkn", value: "1112223334" }] },
    },
    update: {},
  });

  /*
   * ── İŞ MERKEZİ VE MAKİNELER ──
   *
   * Fabrika ekranı, bakım planı ve kapasite doluluğu bunlara bağlı.
   * Olmadan "hangi makine duruyor" sorusu boş dönüyordu.
   *
   * HEDEF HIZ TANIMLI: tanımsız bırakılsaydı doluluk hesaplanamaz ve
   * ürün haklı olarak "kapasite tanımlı değil" derdi — ama denemeye
   * gelen kişi bunu eksiklik sanardı.
   */
  const isMerkezi = await db.workCenter.upsert({
    where: { code: "WC-01" },
    create: {
      code: "WC-01",
      name: "Talaşlı İmalat",
      concurrentCapacity: 3,
      targetRatePerHour: 38,
    },
    update: {},
  });
  for (const m of [
    { code: "MK-01", name: sector.assets[0]!.name },
    { code: "MK-02", name: sector.assets[1]!.name },
  ]) {
    await db.machine.upsert({
      where: { code: m.code },
      create: { code: m.code, name: m.name, workCenterId: isMerkezi.id },
      update: {},
    });
  }

  // ── 1. SATIN ALMA ZİNCİRİ ──
  // Talep → onay → sipariş. Onaysız bir siparişin nasıl bloke olduğunu
  // görebilmek için TALEPTEN başlıyor; doğrudan sipariş açmak o kontrolü
  // hiç göstermezdi.
  await step("satin-alma", async () => {
    if (await db.purchaseRequisition.count() > 0) return "satın alma: zaten var, atlandı";
    const proc = new ProcurementRepository(db as never);
    /*
     * TALEBİ BAŞKASI AÇAR, PATRON ONAYLAR.
     *
     * İlk yazımda ikisi de `owner`'dı ve sistem haklı olarak
     * reddetti: "Kendi talebinizi onaylayamazsınız." Görevler
     * ayrılığı tam da bunun için var. Tohumlama bu kuralı aşmaya
     * çalışmamalı — ona UYMALI, yoksa kurduğu veri gerçek bir iş
     * akışının bırakacağı iz olmaz.
     */
    const talep = await proc.createRequisition({
      requestedBy: SEED_USER,
      department: "Üretim",
      justification: "Ağustos üretim planı için hammadde ihtiyacı",
      at: d("2026-08-04"),
      lines: [
        {
          itemCode: hammadde.code,
          quantity: 2_400,
          uom: hammadde.uom,
          estimatedPrice: hammadde.price,
          neededBy: d("2026-08-20"),
        },
      ],
    });

    await proc.approveRequisition({
      documentNo: talep.documentNo,
      approverId: owner,
      approverRoles: ["patron"],
    });

    const siparis = await proc.convertToOrder({
      documentNo: talep.documentNo,
      partnerId: tedarikci.id,
      orderedAt: d("2026-08-06"),
      currency: "TRY",
    });

    const po = await db.purchaseOrder.findUnique({ where: { id: siparis.purchaseOrderId } });
    return `satın alma: talep ${talep.documentNo} → sipariş ${po?.id.slice(0, 8) ?? "?"} (${siparis.lines} satır)`;
  });

  // ── 2. PARTİ TAKİBİ ──
  // Gıda ve kimyada zorunlu, diğerlerinde şart değil ama izlenebilirlik
  // her sektörde soruluyor. Biri raf ömrü dolmak üzere: "hangi partim
  // bitiyor" sorusunun cevabı boş çıkmasın.
  await step("parti", async () => {
    const batches = new BatchRepository(db as never);
    // PARTİ TAKİBİ ÖNCE AÇILIR. Kapalı bir malzemede parti açılamaz
    // ve bu doğru: parti takipsiz bir kalemde parti numarası,
    // hiçbir yere bağlanmayan bir etikettir.
    await db.item.update({ where: { code: hammadde.code }, data: { batchManaged: true } });

    // VAR OLANI ATLA. Sistem aynı partiyi ikinci kez açtırmıyor — doğru
    // davranış. Tohumlama buna takılıp durmamalı, temel tohumlama gibi
    // yeniden çalıştırılabilir olmalı.
    const partiler = [
      { batchNo: "LOT-2026-0812", producedAt: d("2026-08-12"), supplierBatchNo: "AT-88213" },
      { batchNo: "LOT-2026-0603", producedAt: d("2026-06-03"), supplierBatchNo: "AT-77104" },
    ];
    let acilan = 0;
    for (const b of partiler) {
      if (await batches.byNo(hammadde.code, b.batchNo)) continue;
      await batches.create({
        itemCode: hammadde.code,
        origin: "satin_alma",
        supplierId: tedarikci.id,
        ...b,
      });
      acilan += 1;
    }
    return `parti: ${partiler.length} parti (${acilan} yeni)`;
  });

  // ── 3. STOK SAYIMI ──
  // FARK BIRAKILIYOR, KAPATILMIYOR. Sayım farkının nasıl göründüğü ve
  // muhasebeye nasıl bağlandığı ürünün en çok sorulan tarafı; sıfır
  // farklı bir sayım hiçbir şey göstermez.
  await step("sayim", async () => {
    if (!location) throw new Error("MERKEZ deposu yok");
    if (await db.stockCount.count() > 0) return "sayım: zaten var, atlandı";
    const counts = new StockCountRepository(db as never);
    const sayim = await counts.open({
      locationId: location.id,
      countDate: d("2026-08-28"),
      userId: owner,
      blind: false,
      note: "Ağustos sonu dönem sayımı",
    });

    const view = await counts.byNo(sayim.documentNo);
    const satirlar = (view?.lines ?? []).slice(0, 3).map((l, i) => ({
      lineNo: l.lineNo,
      // Küçük eksi farklar: gerçek sayımda olan şey. Tam tutan bir
      // sayım, sayım yapılmadığının işaretidir.
      countedQty: Math.max(0, Number(l.systemQty) - [3, 0, 7][i]!),
    }));
    if (satirlar.length > 0) await counts.record(sayim.documentNo, satirlar);

    return `sayım: ${sayim.documentNo} açık, ${satirlar.length} satır sayıldı (fark var)`;
  });

  // ── 4. BAKIM ──
  // Biri planlı ve vadesi gelmiş, biri arıza. İkisi de olmalı: planlı
  // bakım "ne zaman" sorusunu, arıza "şu an ne duruyor" sorusunu
  // cevaplıyor ve bunlar farklı ekranlar.
  await step("bakim", async () => {
    const maint = new MaintenanceRepository(db as never);
    const makine = await db.machine.findFirst();
    if (!makine) throw new Error("makine kaydı yok");
    if (await db.breakdown.count() > 0) return `bakım: ${makine.code} — zaten var, atlandı`;

    await maint.savePlan({
      machineCode: makine.code,
      description: "3 aylık periyodik bakım — yağ ve filtre",
      intervalDays: 90,
      lastDoneAt: d("2026-05-10"),
    });
    await maint.reportBreakdown({
      machineCode: makine.code,
      severity: "durdurdu",
      description: "Spindle sıcaklık alarmı, hat durdu",
      reportedAt: d("2026-08-29"),
      userId: owner,
    });
    return `bakım: ${makine.code} planlı bakım vadesi geçti + açık arıza`;
  });

  // ── 5. İZİN ──
  // Onay bekleyen bir talep bırakılıyor: onay akışının kendisi
  // denenebilsin. Hepsi onaylanmış olsaydı denenecek bir şey kalmazdı.
  await step("izin", async () => {
    const leave = new LeaveRepository(db as never);
    const emp = await db.employee.findFirst({ orderBy: { code: "asc" } });
    if (!emp) throw new Error("personel yok");

    const mevcut = await leave.listFor(emp.code, 2026);
    if (mevcut.length > 0) return `izin: ${emp.fullName} — zaten var, atlandı`;

    const req = await leave.request({
      employeeCode: emp.code,
      type: "yillik",
      startDate: d("2026-09-14"),
      endDate: d("2026-09-18"),
      reason: "Yıllık izin",
      requestedBy: owner,
    });
    return `izin: ${emp.fullName} 5 gün, onay bekliyor (${req.id.slice(0, 8)})`;
  });

  // ── 6. İADE DEKONTU ──
  // Satış zincirinin geri yönü. Fatura kesildi ama malın bir kısmı
  // döndü — muhasebede ters kayıt, stokta geri giriş.
  await step("iade", async () => {
    const notes = new CreditNoteRepository(db as never);
    if (await db.salesCreditNote.count() > 0) return "iade: zaten var, atlandı";
    const inv = await db.salesInvoice.findFirst({ include: { lines: true } });
    if (!inv || inv.lines.length === 0) throw new Error("satış faturası yok");
    const line = inv.lines[0]!;

    const note = await notes.issue({
      kind: "iade",
      invoiceNo: inv.documentNo,
      issuedAt: d("2026-08-27"),
      reason: "Ölçü toleransı dışında; müşteri iade etti",
      withGoods: true,
      locationId: location?.id ?? null,
      userId: owner,
      lines: [{ invoiceLineNo: line.lineNo, quantity: 2 }],
    });
    return `iade: ${note.documentNo} (${inv.documentNo} faturasından 2 adet)`;
  });

  // ── 7. İZLEMELER ──
  // Ürünün "sormadan haber verme" tarafı. Üçü de gerçek eşiklerle
  // kuruluyor; biri kesinlikle tetiklenecek durumda ki denemeye gelen
  // kişi brifingde bir şey görsün.
  await step("izleme", async () => {
    const watches = new WatchRepository(db as never);
    const kurulacak = [
      {
        name: "Banka bakiyesi düşerse",
        tool: "get_bank_balance",
        toolInput: {},
        path: "totalAvailable",
        operator: "lt" as const,
        threshold: 500_000,
        level: 2 as const,
        message: "Kullanılabilir banka bakiyesi 500.000 ₺ altına düştü.",
      },
      {
        name: "Geciken sevkiyat",
        tool: "get_shipment_risk",
        toolInput: {},
        path: "atRiskCount",
        operator: "gt" as const,
        threshold: 0,
        level: 2 as const,
        message: "Taahhüt tarihi riske giren sipariş var.",
      },
      {
        name: "Üretim hızı hedefin altında",
        tool: "get_factory_wip",
        toolInput: {},
        path: "actualRatePerHour",
        operator: "lt" as const,
        threshold: 30,
        level: 1 as const,
        message: "Üretim hızı saatte 30 birimin altında.",
      },
    ];
    const mevcut = new Set((await watches.listFor(owner)).map((w) => w.name));
    let kurulan = 0;
    for (const w of kurulacak) {
      if (mevcut.has(w.name)) continue;
      await watches.create({ ...w, ownerUserId: owner });
      kurulan += 1;
    }
    return `izleme: ${kurulacak.length} kural (${kurulan} yeni)`;
  });

  // ── 8. İKİNCİ MÜŞTERİ VE AÇIK SİPARİŞ ──
  // Tek müşterili bir sistemde "en çok hangi müşteriden alacağım var"
  // sorusunun cevabı anlamsız olur.
  await step("ikinci-musteri", async () => {
    const ikinci = await db.partner.upsert({
      where: { code: "C-1002" },
      create: {
        code: "C-1002",
        legalName: "Marmara Sanayi Ticaret A.Ş.",
        normalized: "marmara sanayi ticaret",
        isCustomer: true,
        country: "TR",
        taxOffice: "Gebze",
        city: "Kocaeli",
        district: "Gebze",
        addressLine: "GOSB 2. Cadde No: 7",
        taxIds: { create: [{ kind: "vkn", value: "4445556667" }] },
      },
      update: {},
    });

    const orderNo = "SO-2026-0518";
    const varMi = await db.salesOrder.findUnique({ where: { orderNo } });
    if (!varMi) {
      await db.salesOrder.create({
        data: {
          orderNo,
          partnerId: ikinci.id,
          // GEÇMİŞ TARİH: taahhüt riski nöbetçisi bunu yakalasın.
          committedDate: d("2026-08-25"),
          penaltyPerDay: 18_000,
          penaltyCap: 90_000,
          currency: "TRY",
          status: "open",
          lines: {
            create: mamul.slice(0, 2).map((it, i) => ({
              lineNo: (i + 1) * 10,
              itemId: it.code,
              quantity: [30, 18][i]!,
              uom: it.uom,
              unitPrice: it.price,
              discountPercent: 0,
              vatRate: it.vat,
            })),
          },
        },
      });
    }
    return `ikinci müşteri: ${ikinci.legalName} + geciken sipariş ${orderNo}`;
  });

  return { done, failed };
}
