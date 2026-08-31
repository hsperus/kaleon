/**
 * Rol → izin çözümü ve alan seviyesi maskeleme.
 *
 * KAELON'da yetki iki yerde uygulanır ve ikisi de gereklidir:
 *
 *  1. **Tool listesi filtresi** — kullanıcının izni yoksa tool modele HİÇ
 *     gönderilmez. Anayasa: "Kullanıcı göremiyorsa, KAELON da göremez."
 *     Bu, güvenlik sınırının birinci ve en güçlü katmanıdır: model olmayan
 *     bir şeyi çağıramaz.
 *  2. **Çağrı anında yeniden kontrol** — model listeyi görmese bile uydurabilir
 *     (halüsinasyon) veya istek elle imal edilebilir. Invoker her çağrıda izni
 *     yeniden doğrular.
 *
 * Tek katman yeterli değildir: (1) olmadan token israfı ve sızıntı riski,
 * (2) olmadan jailbreak yüzeyi doğar.
 */

import type { Permission, Principal, RoleId } from "./types.js";
import { ROLE_AUTHORITY_CEILING } from "./authority.js";
import type { AuthorityLevel } from "./types.js";

/**
 * Rol → izin matrisi. Ürün Mantığı Raporu §10 RBAC tablosunun kod karşılığı.
 * `*` yalnızca modül içinde joker: "finance:*" finance'ın tüm izinleri demektir.
 */
export const ROLE_PERMISSIONS: Record<RoleId, readonly Permission[]> = {
  patron: [
    "master-data:*",
    "documents:*",
    "finance:*",
    "accounting:*",
    "operations:*",
    "inventory:*",
    "maintenance:*",
    "hr:*",
    "sales:*",
    "quality:*",
    "approval:*",
    "briefing:*",
    // Kullanıcı ve rol yönetimi YALNIZCA patronda. Joker verilmiyor:
    // ileride "admin:billing" gibi izinler eklendiğinde patronun onlara da
    // otomatik erişmesi ayrı bir karar olmalı.
    "admin:user.manage",
  ],
  cfo: [
    /*
     * İZLEME HERKESİN HAKKIDIR — ama yalnızca KENDİ GÖREBİLDİĞİ veri
     * üzerinde. İzleme kurulurken hedef tool'un izni ayrıca kontrol
     * edilir; bu izin, kişinin kendine kalıcı uyarı kurup
     * kuramayacağını belirler, neyi izleyebileceğini değil.
     */
    "briefing:watch.read",
    "briefing:watch.write",
    "master-data:partner.read",
    "master-data:change.read",
    "master-data:location.read",
    // Banka ekstresini sisteme alan roldür; nakit pozisyonundan sorumlu.
    "finance:bank.write",
    "documents:invoice.read",
    "finance:*",
    "accounting:*",
    "operations:cost.read",
    "inventory:valuation.read",
    // KUR MALİ BİR ANA VERİDİR. Yanlış girilmiş bir kur, o güne ait bütün
    // yabancı para işlemlerini bozar; sahibi nakit pozisyonundan sorumlu
    // olan roldür.
    "finance:fx.read",
    "finance:fx.write",
    // DÖNEM KAPAMA MALİ MÜŞAVİRLİK İŞİDİR; sahibi CFO'dur. Kapama, o aya
    // artık kimsenin kayıt giremeyeceği anlamına gelir — patron dahil.
    "accounting:period.read",
    "accounting:period.close",
    // MİZAN VE GELİR TABLOSU MALİ BİLGİDİR. CFO'nun asli işi; patron
    // joker izinle zaten görür. Diğer rollere açılmaz: bir şirketin
    // kârını herkesin görmesi gerekmez.
    "accounting:ledger.read",
    "inventory:count.read",
    "operations:planning.read",
    // Elle fiş İSTİSNADIR (açılış, amortisman, düzeltme) ve mali
    // sorumluluğu taşıyan roldedir.
    "accounting:ledger.write",
    /*
     * BORDRO ÇALIŞTIRMAK MALİ BİR İŞLEMDİR, İK İŞLEMİ DEĞİL.
     *
     * İK müdürü bordroyu GÖRÜR (`hr:payroll.read`) ve ücretleri
     * tanımlar, ama çalıştırmak muhasebe kaydı yazar ve ödeme
     * yükümlülüğü doğurur. Görevler ayrılığı: personel kartını yöneten
     * kişi, o kartlardan doğan ödemeyi tek başına tahakkuk ettiremez.
     */
    "hr:payroll.read",
    "hr:payroll.run",
    // Bordro çalıştıran, kimin bordroya gireceğini görebilmeli.
    "hr:roster.read",
    // ÖDEME MALİ İŞLEMDİR VE TALEBİ AÇANLA AYNI ELDE OLAMAZ.
    "finance:payment.read",
    "finance:payment.write",
    "documents:requisition.read",
    "approval:procurement.approve",
    "sales:order.read",
    // FATURA KESMEK MALİ BİR İŞLEMDİR VE SEVK EDENİN İŞİ DEĞİLDİR.
    // Görevler ayrılığı: malı gönderen kişi aynı zamanda borcu yazamaz.
    // Depo yanlış miktar sevk edip aynı miktarı faturalayabilseydi, hata
    // hiçbir yerde çakışmaz ve fark hiç görünmezdi.
    "sales:invoice.read",
    "sales:invoice.write",
    "documents:flow.read",
    // e-FATURA BELGESİ FATURAYI KESENİN İŞİDİR. Ayrı bir role verilseydi,
    // kesilen fatura ile gönderilen belge arasında bir el değiştirme
    // doğar ve uyuşmazlık kimsenin sorumluluğunda olmazdı.
    "documents:einvoice.read",
    "documents:einvoice.write",
    "master-data:company.write",
    "sales:delivery.read",
    // Sevkiyatın geri alınması mali sonucu olan bir düzeltmedir.
    "sales:delivery.cancel",
    // Satış siparişini sisteme alma yetkisi CFO'da: sipariş bir TAAHHÜTTÜR
    // ve gecikme cezasının mali sonucunu taşıyan roldür. Ayrı bir "satış"
    // rolü eklenene kadar doğru sahip budur — üretim müdürüne vermek,
    // üretimin kendi terminini belirlemesi anlamına gelirdi.
    "sales:order.write",
    // FİYAT KOŞULU TANIMLAMAK MALİ BİR KARARDIR: liste fiyatı ve iskonto
    // politikası marjı doğrudan belirler. Satışçı fiyatı GÖRÜR, koşulu
    // KOYAMAZ — koyabilseydi kendi iskontosunu kendi tanımlardı.
    "sales:price.read",
    "sales:price.write",
    "sales:quotation.read",
    "sales:quotation.write",
    "approval:read",
    "approval:finance.submit",
  ],
  ik_muduru: [
    /*
     * İZLEME HERKESİN HAKKIDIR — ama yalnızca KENDİ GÖREBİLDİĞİ veri
     * üzerinde. İzleme kurulurken hedef tool'un izni ayrıca kontrol
     * edilir; bu izin, kişinin kendine kalıcı uyarı kurup
     * kuramayacağını belirler, neyi izleyebileceğini değil.
     */
    "briefing:watch.read",
    "briefing:watch.write",
    "master-data:employee.read",
    // KİM DEĞİŞTİRDİ SORUSU ANA VERİYİ GÖREN ROLE AÇIKTIR: geçmişi
    // göremeyen biri, gördüğü değere neden güveneceğini bilemez.
    "master-data:change.read",
    // Personel kartlarını ve PDKS çıktısını sisteme alan roldür.
    "master-data:employee.write",
    "hr:attendance.write",
    "hr:attendance.read",
    /*
     * KADRO LİSTESİ AYRI BİR İZİNDİR.
     *
     * Mesai kaydını okumakla "kim çalışıyor" listesini görmek aynı şey
     * değil. Ayrılmasının sebebi somut: CFO'nun mesai kaydına ihtiyacı
     * yok ama bordro çalıştırdığı için kadroyu görmesi gerekiyor;
     * operatörün ise kendi devamı dışında hiçbir kadro bilgisine
     * ihtiyacı yok. Tek izinde toplansaydı biri fazla, biri eksik
     * görürdü.
     *
     * ÜCRET BU İZNE BAĞLI DEĞİL: liste herkese açık olsa da ücret
     * alanı `hr:payroll.read` ile ayrıca maskeleniyor.
     */
    "hr:roster.read",
    "hr:leave.read",
    // İK izin talebi girer ve vardiya tanımlar; ONAYLAYAN AYRI OLABİLİR
    // ama İK kendi talebini yine onaylayamaz — kural kimlik
    // karşılaştırmasıyla korunur, izinle değil.
    "hr:leave.write",
    "hr:leave.approve",
    "hr:shift.read",
    "hr:shift.write",
    "hr:overtime.read",
    "hr:payroll.read",
    "hr:termination.draft",
    "approval:read",
    "approval:hr.submit",
  ],
  uretim_muduru: [
    /*
     * İZLEME HERKESİN HAKKIDIR — ama yalnızca KENDİ GÖREBİLDİĞİ veri
     * üzerinde. İzleme kurulurken hedef tool'un izni ayrıca kontrol
     * edilir; bu izin, kişinin kendine kalıcı uyarı kurup
     * kuramayacağını belirler, neyi izleyebileceğini değil.
     */
    "briefing:watch.read",
    "briefing:watch.write",
    "master-data:item.read",
    // Üretim maliyeti bilmeden fire ve rota kararı veremez.
    "inventory:valuation.read",
    "finance:fx.read",
    // Üretim müdürü mamul ve yarı mamul kartı açar; ürün ağacının sahibi odur.
    "master-data:item.write",
    "master-data:partner.read",
    "operations:*",
    // GÖREVLER AYRILIĞI (SoD): üretim müdürüne "quality:*" jokeri VERİLMEZ.
    // Üretimden sorumlu kişinin kendi kalite kapısını atlayabilmesi, sistemin
    // engellemesi gereken çıkar çatışmasının kendisidir. Kapı kararı verebilir
    // (release), ama kapıyı ATLAYAMAZ (override) — o yetki patrondadır.
    "quality:result.write",
    "quality:gate.release",
    "quality:hold.write",
    // Üretim kendi hammaddesini talep eder; onaylayan başkasıdır.
    "documents:requisition.read",
    "documents:requisition.draft",
    // PARTİYİ BLOKE ETMEK KALİTE KARARIDIR. Şüpheli partiyi durdurmak,
    // kalite kapısını serbest bırakmakla aynı sorumluluk sınıfındadır.
    "inventory:batch.read",
    "inventory:batch.write",
    "inventory:serial.read",
    "inventory:serial.write",
    // Sayım farkını kaydeden, sayandan başkasıdır.
    "inventory:count.read",
    "inventory:count.write",
    "inventory:count.post",
    "sales:order.read",
    "sales:delivery.read",
    "documents:flow.read",
    "inventory:stock.read",
    "inventory:movement.write",
    "inventory:adjustment.write",
    "maintenance:machine.read",
    // BAKIM ÜRETİMİN İŞİDİR: duran tezgâh üretim müdürünün problemidir.
    "maintenance:plan.read",
    "maintenance:plan.write",
    "maintenance:order.write",
    "maintenance:breakdown.report",
    "hr:attendance.department",
    // Kendi hattındaki ekibi görmesi gerekir; ücreti yine göremez.
    "hr:roster.read",
    // Üretim müdürü kendi ekibinin vardiyasını planlar ve izin onaylar;
    // kapasite planı buna bağlıdır.
    "hr:leave.read",
    "hr:leave.approve",
    "hr:shift.read",
    "hr:shift.write",
    // Departman mesai özeti görür; maaş alanı `redact` ile maskelenir
    // çünkü "hr:payroll.read" izni yoktur.
    "hr:overtime.read",
    "approval:read",
    "approval:operations.submit",
  ],
  satin_alma: [
    /*
     * İZLEME HERKESİN HAKKIDIR — ama yalnızca KENDİ GÖREBİLDİĞİ veri
     * üzerinde. İzleme kurulurken hedef tool'un izni ayrıca kontrol
     * edilir; bu izin, kişinin kendine kalıcı uyarı kurup
     * kuramayacağını belirler, neyi izleyebileceğini değil.
     */
    "briefing:watch.read",
    "briefing:watch.write",
    "master-data:partner.read",
    "master-data:change.read",
    // Cari kartı açmak/güncellemek satın almanın işidir; tedarikçiyi tanıyan
    // ve listeyi elinde tutan roldür. Patron da yapabilir (joker izinle).
    "master-data:partner.write",
    // Cari kartındaki e-Fatura alanlarını satın alma/satış tarafı doldurur;
    // eksikliği görebilmeleri gerekir.
    "documents:einvoice.read",
    "master-data:item.read",
    // Hammadde ve ticari mal kartını satın alma açar.
    "master-data:item.write",
    "documents:invoice.read",
    "documents:flow.read",
    "documents:po.read",
    "documents:po.draft",
    // Teklif toplamak satın almanın asli işidir; seçim (award) onay
    // yetkisi ister ve o ayrı bir izindir.
    "sales:price.read",
    "documents:po.read",
    // Satın almacı neyi ne zaman sipariş edeceğini MRP'den öğrenir;
    // planı göremeyen bir satın almacı, siparişi tahminle verir.
    "operations:planning.read",
    "documents:requisition.read",
    "documents:requisition.draft",
    // TALEBİ AÇAN ONAYLAYAMAZ. Satın almacı hem talep açar hem küçük
    // tutarlı talepleri onaylar; ama KENDİ talebini onaylayamaz — bu
    // ayrım izinle değil, kimlik karşılaştırmasıyla korunur.
    "approval:procurement.approve",
    "finance:payment.read",
    "inventory:stock.read",
    // Alım fiyatını karşılaştırabilmek için mevcut maliyeti görmelidir.
    "inventory:valuation.read",
    "finance:fx.read",
    "approval:read",
    "approval:procurement.submit",
  ],
  depo_sorumlusu: [
    /*
     * İZLEME HERKESİN HAKKIDIR — ama yalnızca KENDİ GÖREBİLDİĞİ veri
     * üzerinde. İzleme kurulurken hedef tool'un izni ayrıca kontrol
     * edilir; bu izin, kişinin kendine kalıcı uyarı kurup
     * kuramayacağını belirler, neyi izleyebileceğini değil.
     */
    "briefing:watch.read",
    "briefing:watch.write",
    "master-data:item.read",
    // CARİ ANA VERİSİ DEPOYA AÇILMAZ. Sevkiyatta müşteri adı zaten sipariş
    // üzerinden görünür; tüm cari listesine erişim buna gerekmez ve
    // gereksiz genişletilmiş her yetki, sızıntının başladığı yerdir.
    "inventory:stock.read",
    "inventory:movement.write",
    "documents:receipt.read",
    "operations:shipment.read",
    "maintenance:machine.read",
    "maintenance:breakdown.report",
    // SAYIMI DEPO YAPAR AMA KAYDEDEMEZ. Sayan kişinin farkı tek başına
    // kalıcı hâle getirebilmesi, sayımın denetim değerini yok eder:
    // eksik çıkan malı "sayım farkı" diye kapatmak mümkün olurdu.
    "inventory:count.read",
    "inventory:count.write",
    "accounting:period.read",
    // Depo eksilen sarf malzemesini talep eder; onaylayan başkasıdır.
    "documents:requisition.read",
    "documents:requisition.draft",
    // Depo hangi partiyi sevk edeceğini bilmelidir: bloke veya süresi
    // dolmuş partiyi eline almadan görmesi gerekir.
    "inventory:batch.read",
    // MALI FİİLEN GÖNDEREN ROL İRSALİYEYİ KESER. Sevkiyatı depoya
    // kaydettirmek, kaydın olayla aynı anda oluşmasını sağlar; sonradan
    // bir başkasının girdiği irsaliye her zaman tahmine dayanır.
    "sales:order.read",
    "sales:delivery.read",
    "sales:delivery.write",
    "documents:flow.read",
    // İPTAL YETKİSİ DEPODA DEĞİLDİR. Hatayı yapanın onu tek başına geri
    // alabilmesi, `reverse_stock_movement` için de reddedilen bir
    // düzendir: ters kayıt bir seviye yukarıdan atılır.
  ],
  operator: [
    "operations:workorder.read",
    "operations:workorder.own",
    // ARIZA BİLDİRİMİ OPERATÖRE AÇIKTIR. Yüksek yetki istenseydi
    // operatör arızayı sözlü söyler, kayıt hiç oluşmaz ve "bu tezgâh
    // ayda kaç kez duruyor" sorusu cevapsız kalırdı. Bildirimi
    // zorlaştırmak, bildirimi yok etmektir.
    "maintenance:breakdown.report",
    "maintenance:machine.read",
    "quality:result.write",
    "hr:attendance.own",
    // Operatör KENDİ izin bakiyesini görür ve KENDİ talebini girer.
    // Onaylayamaz: `hr:leave.approve` yoktur ve olmayacaktır.
    "hr:leave.read",
    "hr:leave.write",
    "hr:shift.read",
  ],
};

/** Rollerden izin kümesi çözer. */
export function resolvePermissions(roles: readonly RoleId[]): ReadonlySet<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
  }
  return set;
}

/** Rollerden yetki tavanı çözer (en yükseği kazanır). */
export function resolveAuthorityCeiling(roles: readonly RoleId[]): AuthorityLevel {
  let ceiling: AuthorityLevel = 0;
  for (const role of roles) {
    const c = ROLE_AUTHORITY_CEILING[role] ?? 0;
    if (c > ceiling) ceiling = c as AuthorityLevel;
  }
  return ceiling;
}

/** Principal kurucu — izinler ve tavan her zaman rollerden türetilir. */
export function createPrincipal(input: {
  userId: string;
  tenantId: string;
  roles: readonly RoleId[];
  approvalLimit?: { amount: number; currency: string };
}): Principal {
  const base = {
    userId: input.userId,
    tenantId: input.tenantId,
    roles: [...input.roles],
    permissions: resolvePermissions(input.roles),
    maxAuthority: resolveAuthorityCeiling(input.roles),
  };
  return input.approvalLimit ? { ...base, approvalLimit: input.approvalLimit } : base;
}

/** Tek bir iznin karşılanıp karşılanmadığı (modül jokeri dahil). */
export function holds(principal: Principal, required: Permission): boolean {
  if (principal.permissions.has(required)) return true;
  const colon = required.indexOf(":");
  if (colon === -1) return false;
  const wildcard = `${required.slice(0, colon)}:*` as Permission;
  return principal.permissions.has(wildcard);
}

/** Karşılanmayan izinleri döndürür — boş dizi = yetkili. */
export function missingPermissions(
  principal: Principal,
  required: readonly Permission[],
): readonly Permission[] {
  return required.filter((p) => !holds(principal, p));
}

/**
 * Alan seviyesi maskeleme.
 *
 * Tool seviyesi izin "bu tool'u çağırabilir misin"i çözer; bazı durumlarda
 * aynı kaydın bazı alanları bazı rollere kapalıdır (örn. çalışan kartında
 * maaş yalnızca İK ve patrona açıktır). `redactFields` bunu uygular.
 */
export function redactFields<T extends Record<string, unknown>>(
  row: T,
  rules: readonly { field: keyof T & string; requires: Permission }[],
  principal: Principal,
): T {
  let out: T | null = null;
  for (const rule of rules) {
    if (!holds(principal, rule.requires) && rule.field in row) {
      out ??= { ...row };
      (out as Record<string, unknown>)[rule.field] = REDACTED;
    }
  }
  return out ?? row;
}

/** Maskelenmiş alanların yerine konan işaret — modele "yetkin yok" der. */
export const REDACTED = "[yetki dışı]" as const;
