/**
 * Tool adlarının insan karşılıkları.
 *
 * Ekranda `get_bank_balance · 8ms` yazıyordu. Fabrika müdürü bunu okumaz;
 * okusa da bir şey ifade etmez. Artık "Banka bakiyesi okundu · 8 ms" yazıyor.
 *
 * HAM AD KAYBOLMUYOR: arayüz onu `title` özniteliğinde taşıyor. Hata
 * ararken hangi tool'un çağrıldığını bilmek gerekir; kullanıcıya
 * göstermemekle elimizden çıkarmak farklı şeylerdir.
 *
 * KARŞILIĞI OLMAYAN TOOL HAM ADIYLA GÖSTERİLİR. Boş bırakmak veya
 * "işlem yapıldı" gibi genel bir şey yazmak, yeni eklenen bir tool'u
 * görünmez kılardı — ve bu listenin güncellenmediğini kimse fark etmezdi.
 *
 * FİİL KİPİ BİLİNÇLİ: okuma tool'ları GEÇMİŞ ZAMAN ("okundu"), yazma
 * tool'ları da geçmiş zaman ama EYLEM belirtir ("kaydedildi"). Kullanıcı
 * bir şeyin olup bittiğini görmeli; "okunuyor" belirsizlik yaratır.
 */

const LABELS: Readonly<Record<string, string>> = {
  // ── Operasyon ──
  get_factory_wip: "Fabrika durumu okundu",
  get_shipment_risk: "Sevkiyat riski hesaplandı",
  get_work_order: "İş emri okundu",
  list_work_orders: "İş emirleri listelendi",
  release_work_order: "İş emri serbest bırakıldı",
  start_operation: "Operasyon başlatıldı",
  confirm_operation: "Operasyon onaylandı",

  // ── Kalite ──
  record_quality_decision: "Kalite kapısı kararı işlendi",
  override_quality_gate: "Kalite kapısı atlandı",

  // ── Stok ──
  get_stock_balance: "Stok bakiyesi hesaplandı",
  list_stock_movements: "Stok hareketleri listelendi",
  post_stock_movement: "Stok hareketi kaydedildi",
  post_stock_correction: "Stok düzeltmesi kaydedildi",
  reverse_stock_movement: "Stok hareketi ters kaydedildi",

  // ── Finans ──
  get_bank_balance: "Banka bakiyesi okundu",

  // ── İK ──
  get_overtime: "Mesai kayıtları okundu",

  // ── Ana veri ──
  resolve_partner: "Cari çözümlendi",
  preview_partner_import: "Dosya okundu, önizleme hazırlandı",
  commit_partner_import: "Cariler sisteme yazıldı",

  // ── Belge ──
  match_invoice: "Fatura eşleştirildi",
  list_blocked_invoices: "Bloke faturalar listelendi",

  // ── Onay ──
  open_approval_for_invoice: "Onay dosyası açıldı",
  get_approval: "Onay kaydı okundu",
  list_pending_approvals: "Onay kuyruğu listelendi",
  approve_document: "Belge onaylandı",
  return_for_correction: "Düzeltme için geri gönderildi",
};

/** Ekranda gösterilecek ad. Karşılığı yoksa ham ad. */
export function toolLabel(name: string): string {
  return LABELS[name] ?? name;
}

/** Bu tool'un insan karşılığı tanımlı mı? (Kapsam raporu için.) */
export function hasToolLabel(name: string): boolean {
  return name in LABELS;
}

/** Tanımlı tüm karşılıklar — test ve kapsam kontrolü için. */
export const TOOL_LABELS = LABELS;

/**
 * Süreyi insan gözüne göre biçimler.
 *
 * "8ms" yerine "8 ms": boşluksuz birim teknik çıktı gibi okunur.
 * Saniyeyi aşan süreler milisaniye olarak yazılmaz — "4200 ms" kimsenin
 * kafasında bir şeye karşılık gelmez, "4,2 sn" gelir.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sn`;
}
