"use client";

/**
 * İşlem formu — şemadan üretilir, elle yazılmaz.
 *
 * NEDEN AYRI BİR FORM TANIMI YOK: her tool'un zod girdi şeması zaten
 * alanları, tiplerini, zorunluluklarını ve Türkçe açıklamalarını içeriyor.
 * İkinci bir tanım tutulsaydı, tool değişip form değişmediğinde kullanıcı
 * olmayan bir alanı doldurmaya çalışır ya da yeni bir alanı hiç görmezdi.
 * 58 tool'un 58'i birden bu bileşenden faydalanır ve yeni tool eklendiğinde
 * formu kendiliğinden gelir.
 *
 * FORM AYNI ZAMANDA ONAY EKRANIDIR. İki ayrı yüzey olsaydı — biri veri
 * girişi, biri onay — kullanıcı aynı işlemi iki kez okurdu. Burada tek bir
 * yüzey var: ne yazılacağı önünüzde durur, düzeltebilirsiniz, gönderene
 * kadar hiçbir kayıt oluşmaz.
 *
 * MODEL ALANLARI DOLDURMUŞ HÂLDE GELİR. Kullanıcının işi sıfırdan yazmak
 * değil, KONTROL ETMEK ve düzeltmektir. Depo sorumlusu için fark budur:
 * cümle kurmak yerine üç alana bakıp Enter'a basar.
 */

import { useEffect, useMemo, useRef, useState } from "react";

/** JSON Schema'nın kullandığımız alt kümesi. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface PendingAction {
  readonly pendingId: string;
  readonly tool: string;
  readonly label: string;
  readonly description?: string | null;
  readonly input: unknown;
  readonly authority: number;
  readonly schema: JsonSchema | null;
}

/** Yetki seviyesinin kullanıcıya ne anlattığı. */
const AUTHORITY_NOTE: Record<number, string> = {
  1: "Bu işlem kayıt oluşturur.",
  2: "Bu işlem stok veya belge durumunu değiştirir; geri alınabilir ama iz bırakır.",
  3: "GERİ ALINAMAZ İŞLEM. Kesildikten sonra yalnızca iptal edilebilir ve iptal de kayda geçer.",
};

/**
 * Alan adı → Türkçe etiket.
 *
 * ŞEMADAN TÜRETİLEMEZ. Şemadaki alan adları İngilizce ("referenceKind")
 * ve açıklamalar cümledir ("Her zaman pozitif; yön hareket tipinden
 * gelir."); ikisi de etiket değildir. Etiket bir ARAYÜZ METNİDİR ve yeri
 * burasıdır — bir depo sorumlusuna "Reference Kind" yazan bir form,
 * Türkçe bir ürün değildir.
 *
 * Listede olmayan alan, adından okunabilir hâle getirilir; bu bir
 * eksikliktir ve görüldüğü yerde listeye eklenmelidir.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  // Ortak
  itemId: "Malzeme",
  itemCode: "Malzeme kodu",
  locationId: "Depo",
  batchId: "Parti no",
  batchNo: "Parti no",
  quantity: "Miktar",
  uom: "Birim",
  reason: "Gerekçe",
  currency: "Para birimi",
  partnerId: "Cari",
  status: "Durum",
  year: "Yıl",
  month: "Ay",
  limit: "Kayıt sayısı",
  query: "Arama",
  code: "Kod",
  name: "Ad",
  type: "Tür",
  // Stok hareketi
  movementType: "Hareket tipi",
  referenceKind: "Belge tipi",
  referenceId: "Belge no",
  // Satış zinciri
  orderNo: "Sipariş no",
  documentNo: "Belge no",
  shippedAt: "Sevk tarihi",
  carrierName: "Taşıyıcı",
  plateNo: "Plaka",
  lines: "Kalemler",
  orderLineNo: "Sipariş kalemi",
  deliveryId: "İrsaliye",
  deliveryLineNo: "İrsaliye kalemi",
  sources: "Kaynak irsaliye kalemleri",
  issuedAt: "Fatura tarihi",
  dueDate: "Vade",
  exchangeRate: "Kur",
  // Malzeme
  baseUom: "Temel birim",
  procurementType: "Tedarik türü",
  batchManaged: "Parti takibi",
  shelfLifeDays: "Raf ömrü (gün)",
  leadTimeDays: "Tedarik süresi (gün)",
  units: "Alternatif birimler",
  factor: "Çevrim katsayısı",
  // Değerleme
  unitCost: "Birim maliyet",
  receivedAt: "Giriş tarihi",
  rate: "Kur",
  quotedAt: "Kur tarihi",
  source: "Kaynak",
  // Satın alma
  justification: "Gerekçe",
  department: "Departman",
  estimatedPrice: "Tahmini birim fiyat",
  neededBy: "Ne zamana gerekiyor",
  // Ödeme
  direction: "Yön",
  amount: "Tutar",
  method: "Ödeme şekli",
  paidAt: "Ödeme tarihi",
  reference: "Dekont / çek no",
  allocations: "Fatura dağıtımı",
  invoiceNo: "Fatura no",
  // İzin ve vardiya
  employeeCode: "Personel",
  startDate: "Başlangıç",
  endDate: "Bitiş",
  holidays: "Resmî tatiller",
  saturdayIsOff: "Cumartesi tatil mi",
  requestId: "Talep",
  shiftCode: "Vardiya",
  workDate: "Tarih",
  startsAt: "Başlangıç saati",
  endsAt: "Bitiş saati",
  breakMinutes: "Ara dinlenme (dk)",
  isNight: "Gece vardiyası",
  weekStart: "Hafta başlangıcı",
  // Dönem
  force: "Engellere rağmen kapat",
  // İçe aktarma
  uploadId: "Yüklenen dosya",
  objectId: "Dosya türü",
  // Üretim
  workOrderId: "İş emri",
  operationSeq: "Operasyon",
  withinDays: "Kaç gün içinde",
};

/** Alan adından okunabilir etiket — sözlükte yoksa son çare. */
function humanize(key: string): string {
  return (
    FIELD_LABELS[key] ??
    key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

/** `anyOf` içindeki null'ı ayıklar: "x veya null" → x, isteğe bağlı. */
function unwrap(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  if (!schema.anyOf) {
    const t = schema.type;
    const nullable = Array.isArray(t) && t.includes("null");
    return { schema, nullable };
  }
  const nonNull = schema.anyOf.filter((s) => s.type !== "null");
  const nullable = schema.anyOf.length !== nonNull.length;
  return { schema: nonNull[0] ?? schema, nullable };
}

function hintFor(description: string | null, label: string): string | null {
  if (!description) return null;
  const bare = description.replace(/[.:]$/, "").trim();
  return bare.toLocaleLowerCase("tr") === label.toLocaleLowerCase("tr") ? null : description;
}

/**
 * Kod değerlerinin Türkçe karşılığı.
 *
 * "101" ve "purchase_order" sistemin iç dilidir. Depo sorumlusuna bu
 * kodları ezberletmek, SAP'nin işlem kodlarını ezberletmesiyle aynı
 * şeydir; ürünün iddiası tam olarak bunu ortadan kaldırmaktır.
 */
const ENUM_LABELS: Readonly<Record<string, string>> = {
  // Stok hareket tipleri
  "101": "101 · Satın alma mal kabulü",
  "261": "261 · İş emrine sarf",
  "131": "131 · Üretimden mamul girişi",
  "551": "551 · Fire",
  "601": "601 · Sevkiyat",
  "311": "311 · Depolar arası çıkış",
  "312": "312 · Depolar arası giriş",
  "541": "541 · Fasona gönderim",
  // Belge tipleri
  purchase_order: "Satın alma siparişi",
  work_order: "İş emri",
  delivery: "İrsaliye",
  transfer: "Transfer",
  // Ödeme
  outgoing: "Giden ödeme (tedarikçiye)",
  incoming: "Gelen tahsilat (müşteriden)",
  havale: "Havale",
  eft: "EFT",
  cek: "Çek",
  senet: "Senet",
  nakit: "Nakit",
  kredi_karti: "Kredi kartı",
  // Malzeme
  hammadde: "Hammadde",
  yari_mamul: "Yarı mamul",
  mamul: "Mamul",
  ticari_mal: "Ticari mal",
  hizmet: "Hizmet",
  sarf: "Sarf malzemesi",
  satin_alma: "Satın alma",
  uretim: "Üretim",
  her_ikisi: "Her ikisi",
  // Parti
  available: "Serbest",
  quarantine: "Karantina",
  blocked: "Bloke",
  consumed: "Tüketilmiş",
  // İzin
  yillik: "Yıllık izin",
  mazeret: "Mazeret izni",
  hastalik: "Hastalık izni",
  ucretsiz: "Ücretsiz izin",
  dogum: "Doğum izni",
  babalik: "Babalık izni",
  evlilik: "Evlilik izni",
  olum: "Ölüm izni",
};

function optionLabel(value: unknown): string {
  const key = String(value);
  return ENUM_LABELS[key] ?? key;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

export function ActionForm({
  action,
  onConfirm,
  onCancel,
  busy,
}: {
  action: PendingAction;
  onConfirm: (input: unknown) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(
    () => ({ ...(action.input as Record<string, unknown>) }),
  );
  const [touched, setTouched] = useState(false);
  const firstField = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(null);

  // İLK ALANA ODAKLAN. Formu klavyeyle dolduran biri fareye uzanmak
  // zorunda kalmamalı; günde 40 irsaliye kesen için fark budur.
  useEffect(() => {
    firstField.current?.focus();
  }, [action.pendingId]);

  const fields = useMemo(() => {
    const props = action.schema?.properties ?? {};
    const required = new Set(action.schema?.required ?? []);
    return Object.entries(props).map(([key, raw]) => {
      const { schema, nullable } = unwrap(raw);
      return {
        key,
        schema,
        // ZORUNLULUK ŞEMADAN GELİR: "null olabilir" bir alan, listede
        // zorunlu görünse bile boş bırakılabilir.
        required: required.has(key) && !nullable,
        nullable,
        label: humanize(key),
        // İPUCU ETİKETİ TEKRARLAMAZ. "Hareket tipi / Hareket tipi" iki satır
        // yer kaplar, hiçbir şey eklemez ve formu uzatır.
        hint: hintFor(raw.description ?? schema.description ?? null, humanize(key)),
      };
    });
  }, [action.schema]);

  const missing = fields.filter((f) => f.required && isBlank(draft[f.key]));

  function set(key: string, value: unknown) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function submit() {
    setTouched(true);
    if (missing.length > 0) return;
    onConfirm(draft);
  }

  const danger = action.authority >= 3;

  return (
    <form
      className={`action-form${danger ? " danger" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // ESC ile vazgeçilir: yanlışlıkla açılan bir formdan çıkmak için
      // fareyle düğme aramak gerekmemeli.
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
      aria-label={`${action.label} onayı`}
    >
      <header className="af-head">
        <div>
          <span className="af-eyebrow">Onayınızı bekliyor</span>
          <h3>{action.label}</h3>
        </div>
        <span className="af-level">L{action.authority}</span>
      </header>

      {AUTHORITY_NOTE[action.authority] && (
        <p className={`af-note${danger ? " danger" : ""}`}>{AUTHORITY_NOTE[action.authority]}</p>
      )}

      <div className="af-fields">
        {fields.map((f, i) => (
          <Field
            key={f.key}
            field={f}
            value={draft[f.key]}
            onChange={(v) => set(f.key, v)}
            invalid={touched && f.required && isBlank(draft[f.key])}
            {...(i === 0 ? { inputRef: firstField } : {})}
          />
        ))}
        {fields.length === 0 && <p className="af-empty">Bu işlem alan istemiyor.</p>}
      </div>

      {touched && missing.length > 0 && (
        <p className="af-error">
          Eksik alan: {missing.map((f) => f.label).join(", ")}
        </p>
      )}

      <footer className="af-foot">
        <button type="button" className="af-cancel" onClick={onCancel} disabled={busy}>
          Vazgeç
        </button>
        <button type="submit" className="af-ok" disabled={busy}>
          {busy ? "Kaydediliyor…" : danger ? "Onaylıyorum, kes" : "Onayla"}
        </button>
      </footer>
    </form>
  );
}

interface FieldSpec {
  key: string;
  schema: JsonSchema;
  required: boolean;
  nullable: boolean;
  label: string;
  hint: string | null;
}

function Field({
  field,
  value,
  onChange,
  invalid,
  inputRef,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  invalid: boolean;
  inputRef?: React.Ref<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> | undefined;
}) {
  const { schema } = field;
  const id = `af-${field.key}`;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  const label = (
    <label htmlFor={id}>
      {field.label}
      {field.required && <span className="af-req" aria-hidden="true"> *</span>}
    </label>
  );

  // Seçenekli alan — modelin uydurabileceği bir değer kalmaz.
  if (schema.enum) {
    return (
      <div className={`af-field${invalid ? " invalid" : ""}`}>
        {label}
        <select
          id={id}
          ref={inputRef as React.Ref<HTMLSelectElement>}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
        >
          {field.nullable && <option value="">—</option>}
          {schema.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
        {field.hint && <small>{field.hint}</small>}
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <div className="af-field af-check">
        <input
          id={id}
          type="checkbox"
          ref={inputRef as React.Ref<HTMLInputElement>}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
        {field.hint && <small>{field.hint}</small>}
      </div>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <div className={`af-field${invalid ? " invalid" : ""}`}>
        {label}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={type === "integer" ? 1 : "any"}
          ref={inputRef as React.Ref<HTMLInputElement>}
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => {
            // BOŞ ALAN SIFIR DEĞİLDİR. Sıfıra çevirmek, "fiyat girilmedi"yi
            // "bedava" hâline getirirdi.
            const raw = e.target.value;
            onChange(raw === "" ? null : Number(raw));
          }}
        />
        {field.hint && <small>{field.hint}</small>}
      </div>
    );
  }

  // Dizi alanları: satır satır JSON. Karmaşık kalemler için tek tek alan
  // üretmek yerine, modelin doldurduğunu okunur biçimde gösterip
  // düzeltmeye izin veriyoruz — boş bırakılan bir kalem listesinden iyidir.
  if (type === "array") {
    return (
      <div className={`af-field${invalid ? " invalid" : ""}`}>
        {label}
        <textarea
          id={id}
          rows={Math.min(10, Math.max(3, JSON.stringify(value ?? [], null, 1).split("\n").length))}
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          value={JSON.stringify(value ?? [], null, 1)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              // Yazma sırasında geçici olarak geçersiz JSON normaldir;
              // metni tutup değeri değiştirmiyoruz.
            }
          }}
          spellCheck={false}
        />
        {field.hint && <small>{field.hint}</small>}
      </div>
    );
  }

  const long = (schema.maxLength ?? 0) > 120;
  return (
    <div className={`af-field${invalid ? " invalid" : ""}`}>
      {label}
      {long ? (
        <textarea
          id={id}
          rows={3}
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || (field.nullable ? null : ""))}
        />
      ) : (
        <input
          id={id}
          type="text"
          ref={inputRef as React.Ref<HTMLInputElement>}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || (field.nullable ? null : ""))}
        />
      )}
      {field.hint && <small>{field.hint}</small>}
    </div>
  );
}
