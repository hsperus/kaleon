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
  get_item: "Malzeme kartı okundu",
  search_items: "Malzemeler arandı",
  get_sales_order: "Sipariş görüntülendi",
  post_delivery: "Sevk irsaliyesi kesildi",
  cancel_delivery: "İrsaliye iptal edildi",
  issue_sales_invoice: "Satış faturası kesildi",
  get_item_cost: "Malzeme maliyeti okundu",
  get_inventory_value: "Envanter değeri hesaplandı",
  get_exchange_rate: "Döviz kuru okundu",
  set_exchange_rate: "Döviz kuru kaydedildi",
  post_goods_receipt: "Mal kabulü kaydedildi",
  get_period_status: "Dönem durumu okundu",
  close_period: "Dönem kapatıldı",
  search_employees: "Çalışan listesi okundu",
  list_partners: "Cari listesi okundu",
  create_partner: "Cari kartı açıldı",
  update_partner: "Cari kartı güncellendi",
  create_employee: "Personel kartı açıldı",
  update_employee: "Personel kartı güncellendi",
  update_item: "Malzeme kartı güncellendi",
  list_sales_orders: "Satış siparişleri okundu",
  list_sales_invoices: "Satış faturaları okundu",
  list_stock_counts: "Stok sayımları okundu",
  list_purchase_requisitions: "Satın alma talepleri okundu",
  list_payroll_runs: "Bordro dönemleri okundu",
  list_sales_quotations: "Teklifler okundu",
  list_batches: "Parti listesi okundu",
  get_employee: "Personel kartı okundu",
  preview_fx_revaluation: "Kur değerlemesi hesaplandı",
  post_fx_revaluation: "Kur değerlemesi yevmiyeye yazıldı",
  reopen_period: "Dönem yeniden açıldı",
  get_batch: "Parti kartı okundu",
  trace_batch_forward: "Parti ileri izlendi",
  trace_batch_backward: "Parti geri izlendi",
  set_batch_status: "Parti durumu değiştirildi",
  list_expiring_batches: "Raf ömrü kontrol edildi",
  create_purchase_requisition: "Satın alma talebi açıldı",
  get_purchase_requisition: "Talep görüntülendi",
  approve_purchase_requisition: "Talep onaylandı",
  convert_requisition_to_order: "Talep siparişe dönüştü",
  list_open_payables: "Ödenmemiş faturalar listelendi",
  post_payment: "Ödeme kaydedildi",
  get_leave_balance: "İzin bakiyesi okundu",
  request_leave: "İzin talebi oluşturuldu",
  approve_leave: "İzin onaylandı",
  define_shift: "Vardiya tanımlandı",
  assign_shift: "Vardiya atandı",
  get_weekly_shift_plan: "Haftalık vardiya planı okundu",
  get_change_history: "Değişiklik geçmişi okundu",
  list_recent_master_data_changes: "Ana veri değişiklikleri listelendi",
  get_trial_balance: "Mizan çıkarıldı",
  get_income_statement: "Gelir tablosu hesaplandı",
  get_partner_statement: "Cari ekstre çıkarıldı",
  get_receivables_aging: "Alacak yaşlandırması yapıldı",
  get_document_journal_entry: "Belgenin muhasebe kaydı okundu",
  list_chart_of_accounts: "Hesap planı listelendi",
  post_journal_entry: "Yevmiye fişi kesildi",
  reverse_journal_entry: "Yevmiye fişi ters kaydedildi",
  open_stock_count: "Sayım açıldı",
  get_stock_count: "Sayım listesi okundu",
  record_stock_count: "Sayım miktarları girildi",
  get_stock_count_differences: "Sayım farkları hesaplandı",
  post_stock_count: "Sayım kaydedildi",
  run_mrp: "Malzeme ihtiyaç planı çalıştırıldı",
  get_material_requirement: "Malzeme ihtiyacı hesaplandı",
  check_einvoice_readiness: "e-Fatura hazırlığı kontrol edildi",
  get_invoice_document: "Fatura belgesi okundu",
  get_balance_sheet: "Bilanço çıkarıldı",
  list_fixed_assets: "Sabit kıymetler listelendi",
  get_fixed_asset: "Sabit kıymet okundu",
  create_fixed_asset: "Sabit kıymet kartı açıldı",
  run_depreciation: "Amortisman ayrıldı",
  dispose_fixed_asset: "Sabit kıymet elden çıkarıldı",
  get_credit_note: "İade/dekont okundu",
  list_invoice_credit_notes: "Faturanın iadeleri listelendi",
  issue_credit_note: "İade/dekont kesildi",
  simulate_payroll: "Bordro simüle edildi",
  plan_annual_payroll: "Yıllık bordro planı çıkarıldı",
  get_payslip: "Bordro pusulası okundu",
  get_payroll_summary: "Bordro özeti okundu",
  run_payroll: "Bordro çalıştırıldı",
  get_payroll_parameters: "Bordro parametreleri okundu",
  list_watchable_fields: "İzlenebilir alanlar listelendi",
  create_watch: "İzleme kuruldu",
  list_watches: "İzlemeler listelendi",
  delete_watch: "İzleme kaldırıldı",
  pause_watch: "İzleme durumu değişti",
  get_despatch_document: "İrsaliye belgesi okundu",
  build_einvoice_document: "e-Fatura belgesi üretildi",
  list_pending_einvoices: "Bekleyen e-Faturalar listelendi",
  set_company_profile: "Şirket kimliği kaydedildi",
  get_work_order_cost: "İş emri maliyeti hesaplandı",
  build_edespatch_document: "e-İrsaliye belgesi üretildi",
  list_deliveries_without_edespatch: "Belgesiz sevkiyatlar listelendi",
  list_pending_edespatches: "Bekleyen e-İrsaliyeler listelendi",
  draft_vat_return: "KDV beyannamesi taslağı hazırlandı",
  build_edefter: "e-Defter dosyaları üretildi",
  get_price: "Fiyat hesaplandı",
  set_price_condition: "Fiyat koşulu tanımlandı",
  create_sales_quotation: "Satış teklifi hazırlandı",
  get_sales_quotation: "Teklif görüntülendi",
  convert_quotation_to_order: "Teklif siparişe dönüştü",
  set_quotation_status: "Teklif durumu güncellendi",
  get_quotation_conversion: "Teklif dönüşüm oranı hesaplandı",
  create_purchase_rfq: "Teklif talebi açıldı",
  record_supplier_quote: "Tedarikçi teklifi kaydedildi",
  compare_supplier_quotes: "Teklifler karşılaştırıldı",
  award_purchase_rfq: "Tedarikçi seçildi",
  list_due_maintenance: "Bakım zamanı gelenler listelendi",
  set_maintenance_plan: "Bakım planı tanımlandı",
  report_breakdown: "Arıza bildirildi",
  resolve_breakdown: "Arıza kapatıldı",
  list_open_breakdowns: "Açık arızalar listelendi",
  create_maintenance_order: "Bakım iş emri açıldı",
  complete_maintenance_order: "Bakım tamamlandı",
  get_machine_maintenance_history: "Makine bakım geçmişi okundu",
  get_maintenance_kpi: "Bakım göstergeleri hesaplandı",
  get_document_flow: "Belge zinciri izlendi",
  get_organization_tree: "Organizasyon yapısı okundu",
  create_location: "Lokasyon açıldı",
  get_stock_by_plant: "Tesis bazında stok okundu",
  get_capacity_load: "Kapasite yükü hesaplandı",
  create_serial_number: "Seri numarası açıldı",
  trace_serial_number: "Seri numarası izlendi",
  set_serial_state: "Seri durumu değiştirildi",
  list_customer_serials: "Müşteri serileri listelendi",
  list_expiring_warranties: "Garanti bitişleri listelendi",
  draft_termination_settlement: "İşten çıkış taslağı hazırlandı",
  create_item: "Malzeme kartı açıldı",
  preview_import: "Dosya okundu, önizleme hazırlandı",
  commit_import: "Dosya sisteme yazıldı",
  list_import_templates: "Yüklenebilir dosya türleri listelendi",

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

/**
 * Yazma tool'larının EMİR KİPİNDEKİ adı — onay formunun başlığı.
 *
 * `TOOL_LABELS` geçmiş zamandır ("Satış faturası kesildi") çünkü orası
 * OLMUŞ BİR ŞEYİ anlatır: tool çağrı listesi. Onay formu ise HENÜZ
 * OLMAMIŞ bir şeyi anlatır; başlığında "kesildi" yazması, kullanıcıya
 * işlemin bittiğini söyler ve onay düğmesini anlamsız kılar.
 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  create_item: "Malzeme kartı aç",
  create_fixed_asset: "Sabit kıymet kartı aç",
  issue_credit_note: "İade/dekont kes",
  run_payroll: "Bordro çalıştır",
  create_watch: "İzleme kur",
  delete_watch: "İzlemeyi kaldır",
  pause_watch: "İzlemeyi sustur/aç",
  run_depreciation: "Amortisman ayır",
  dispose_fixed_asset: "Sabit kıymeti elden çıkar",
  post_delivery: "Sevk irsaliyesi kes",
  cancel_delivery: "İrsaliyeyi iptal et",
  issue_sales_invoice: "Satış faturası kes",
  post_goods_receipt: "Mal kabulü kaydet",
  set_exchange_rate: "Döviz kuru kaydet",
  close_period: "Dönemi kapat",
  create_partner: "Cari kartı aç",
  update_partner: "Cari kartını güncelle",
  create_employee: "Personel kartı aç",
  update_employee: "Personel kartını güncelle",
  update_item: "Malzeme kartını güncelle",
  post_fx_revaluation: "Kur değerlemesini yaz",
  reopen_period: "Dönemi yeniden aç",
  set_batch_status: "Parti durumunu değiştir",
  create_purchase_requisition: "Satın alma talebi aç",
  approve_purchase_requisition: "Talebi onayla",
  convert_requisition_to_order: "Talebi siparişe dönüştür",
  post_payment: "Ödeme kaydet",
  post_journal_entry: "Yevmiye fişi kes",
  reverse_journal_entry: "Fişin ters kaydını at",
  open_stock_count: "Sayım aç",
  record_stock_count: "Sayım miktarlarını gir",
  post_stock_count: "Sayımı kaydet",
  build_einvoice_document: "e-Fatura belgesi üret",
  set_company_profile: "Şirket kimliğini kaydet",
  build_edespatch_document: "e-İrsaliye belgesi üret",
  build_edefter: "e-Defter dosyalarını üret",
  set_price_condition: "Fiyat koşulu tanımla",
  create_sales_quotation: "Satış teklifi hazırla",
  convert_quotation_to_order: "Teklifi siparişe dönüştür",
  set_quotation_status: "Teklif durumunu güncelle",
  create_purchase_rfq: "Teklif talebi aç",
  record_supplier_quote: "Tedarikçi teklifini kaydet",
  award_purchase_rfq: "Tedarikçiyi seç",
  set_maintenance_plan: "Bakım planı tanımla",
  report_breakdown: "Arıza bildir",
  resolve_breakdown: "Arızayı kapat",
  create_maintenance_order: "Bakım iş emri aç",
  complete_maintenance_order: "Bakımı tamamla",
  create_location: "Lokasyon aç",
  create_serial_number: "Seri numarası aç",
  set_serial_state: "Seri durumunu değiştir",
  draft_termination_settlement: "İşten çıkış taslağı hazırla",
  request_leave: "İzin talebi oluştur",
  approve_leave: "İzni onayla",
  define_shift: "Vardiya tanımla",
  assign_shift: "Vardiya ata",
  post_stock_movement: "Stok hareketi kaydet",
  post_stock_correction: "Sayım farkı kaydet",
  reverse_stock_movement: "Stok hareketini ters kaydet",
  release_work_order: "İş emrini serbest bırak",
  start_operation: "Operasyonu başlat",
  confirm_operation: "Operasyonu tamamla",
  record_quality_decision: "Kalite kararı kaydet",
  override_quality_gate: "Kalite kapısını atla",
  commit_import: "Dosyayı sisteme aktar",
  open_approval: "Onay kaydı aç",
  submit_approval: "Onaya gönder",
  decide_approval: "Onay kararı ver",
};

/** Form başlığı: emir kipi varsa o, yoksa geçmiş zaman etiketi. */
export function actionLabel(tool: string): string {
  return ACTION_LABELS[tool] ?? TOOL_LABELS[tool] ?? tool;
}
