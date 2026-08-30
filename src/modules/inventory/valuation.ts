/**
 * Stok değerleme.
 *
 * "GERÇEK KÂRLILIK" VAADİ BURAYA DAYANIR. Bir siparişin kârlı olup
 * olmadığı, satış fiyatından değil, o malın MALİYETİNDEN çıkar. Maliyet
 * bilinmiyorsa kârlılık da bilinmiyordur — ve sistemin bu durumda
 * yapabileceği en kötü şey sıfır maliyetle %100 kâr göstermektir.
 *
 * İKİ YÖNTEM, İKİ FARKLI SORU:
 *
 *   HAREKETLİ ORTALAMA — "bu malı ortalama kaça mal ettik?" Her girişte
 *   yeniden hesaplanır. Ticarette ve alım fiyatı oynayan hammaddede
 *   doğrudur; maliyet piyasayı takip eder.
 *
 *   STANDART MALİYET — "bu malı kaça mal etmeyi planlamıştık?" Sabittir;
 *   gerçekle farkı FİYAT FARKI olarak ayrı yazılır. Üretimde doğrudur:
 *   maliyet her alımda oynarsa mamul maliyeti de oynar ve hiçbir
 *   karşılaştırma yapılamaz.
 *
 * EKSİ STOK DEĞERLEMEYİ BOZAR. Bakiye eksiye düşmüşse ortalama maliyet
 * matematiksel olarak anlamsızlaşır (negatife bölme). Bu durumda hesap
 * yapılmaz; sistem "stok eksi, önce sayım gerekiyor" der.
 */

export class ValuationError extends Error {
  readonly code = "valuation";
  constructor(message: string) {
    super(message);
    this.name = "ValuationError";
  }
}

export interface CostState {
  /** Eldeki miktar — temel birimde. */
  readonly quantityOnHand: number;
  /** Birim maliyet. BİLİNMİYORSA null — sıfır değil. */
  readonly unitCost: number | null;
}

export interface ReceiptInput {
  readonly quantity: number;
  /** Girişin birim maliyeti — TL cinsinden, kur çevrimi YAPILMIŞ olarak. */
  readonly unitCost: number;
}

export interface MovingAverageResult {
  readonly quantityOnHand: number;
  readonly unitCost: number;
  /** Bu girişin toplam değeri. */
  readonly valueIn: number;
  /** Ortalama güvenilir değilse sebebi — cevaba taşınır. */
  readonly caveat: string | null;
}

/** Maliyet dört haneye yuvarlanır: birim maliyette kuruş altı anlamlıdır. */
function roundCost(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Hareketli ortalama maliyeti günceller.
 *
 * FİZİKSEL OLAY REDDEDİLMEZ. Mal gerçekten geldiyse kaydı reddetmek
 * gerçeği değiştirmez, yalnızca sistemi gerçeğin gerisinde bırakır —
 * çıkışta uyguladığımız kuralın aynısı girişte de geçerlidir. Ama
 * ortalama hesaplanamıyorsa bu SÖYLENİR.
 *
 * ORTALAMA İKİ DURUMDA HESAPLANAMAZ:
 *   bakiye ≤ 0        — negatife bölme; ortalamanın matematiksel anlamı yok
 *   önceki maliyet ?  — bilinmeyen bir değerle ortalama almak uydurmaktır
 * İkisinde de girişin kendi maliyeti YENİ TABAN olur ve kayıt işaretlenir.
 */
export function applyReceipt(state: CostState, receipt: ReceiptInput): MovingAverageResult {
  if (!(receipt.quantity > 0)) {
    throw new ValuationError("Giriş miktarı sıfırdan büyük olmalıdır.");
  }
  if (receipt.unitCost < 0) {
    throw new ValuationError("Birim maliyet negatif olamaz.");
  }

  const newQty = roundCost(state.quantityOnHand + receipt.quantity);
  const valueIn = roundCost(receipt.quantity * receipt.unitCost);
  const base = roundCost(receipt.unitCost);

  if (state.quantityOnHand < 0) {
    return {
      quantityOnHand: newQty,
      unitCost: base,
      valueIn,
      caveat:
        `Giriş öncesi bakiye eksiydi (${state.quantityOnHand}); ortalama hesaplanamadı ve ` +
        `bu girişin maliyeti yeni taban alındı. Sayım yapılmadan maliyet güvenilir değildir.`,
    };
  }

  // Elde stok yok: ortalama, girişin maliyetidir.
  if (state.quantityOnHand === 0) {
    return { quantityOnHand: newQty, unitCost: base, valueIn, caveat: null };
  }

  if (state.unitCost === null) {
    return {
      quantityOnHand: newQty,
      unitCost: base,
      valueIn,
      caveat:
        `Elde ${state.quantityOnHand} birim vardı ama maliyeti bilinmiyordu; ortalama ` +
        `alınamadı ve bu girişin maliyeti yeni taban oldu. Mevcut stoğun açılış ` +
        `maliyeti girilmelidir.`,
    };
  }

  const oldValue = state.quantityOnHand * state.unitCost;
  return {
    quantityOnHand: newQty,
    unitCost: roundCost((oldValue + valueIn) / newQty),
    valueIn,
    caveat: null,
  };
}

export interface IssueResult {
  readonly quantityOnHand: number;
  /** Çıkışın maliyeti. Maliyet bilinmiyorsa null — sıfır değil. */
  readonly valueOut: number | null;
  readonly unitCost: number | null;
}

/**
 * Çıkışı değerler. Hareketli ortalamada çıkış maliyeti ORTALAMAYI DEĞİŞTİRMEZ.
 *
 * Değiştirseydi, aynı malı satmak maliyetini oynatırdı; maliyet yalnızca
 * ALIMLA oluşur.
 */
export function applyIssue(state: CostState, quantity: number): IssueResult {
  if (!(quantity > 0)) {
    throw new ValuationError("Çıkış miktarı sıfırdan büyük olmalıdır.");
  }

  const newQty = roundCost(state.quantityOnHand - quantity);

  // EKSİYE DÜŞEN ÇIKIŞ ENGELLENMEZ AMA İŞARETLENİR: fiziksel olarak mal
  // çıkmış olabilir ve kaydı reddetmek gerçeği değiştirmez. Değerleme ise
  // bu noktadan sonra güvenilmezdir ve öyle söylenir.
  return {
    quantityOnHand: newQty,
    valueOut: state.unitCost === null ? null : roundCost(quantity * state.unitCost),
    unitCost: state.unitCost,
  };
}

/**
 * Standart maliyet farkı (fiyat farkı).
 *
 * Standart 100 TL, fiili alım 112 TL ise 12 TL'lik fark stok değerine
 * DEĞİL, ayrı bir fark hesabına yazılır. Stok değerine yazılsaydı standart
 * maliyet standart olmaktan çıkardı.
 */
export function purchasePriceVariance(
  quantity: number,
  standardCost: number,
  actualCost: number,
): { standardValue: number; actualValue: number; variance: number } {
  const standardValue = roundCost(quantity * standardCost);
  const actualValue = roundCost(quantity * actualCost);
  return { standardValue, actualValue, variance: roundCost(actualValue - standardValue) };
}

export interface StockValue {
  readonly quantity: number;
  readonly unitCost: number | null;
  readonly value: number | null;
  /** Değer hesaplanamadıysa sebebi — cevaba taşınır. */
  readonly caveat: string | null;
}

/**
 * Eldeki stoğun değeri.
 *
 * MALİYETİ OLMAYAN KALEM SIFIR DEĞERLE TOPLANMAZ. Toplansaydı, 40 kalemden
 * 6'sının maliyeti bilinmediğinde envanter değeri olduğundan düşük çıkar
 * ve bilanço yanlış olurdu. Bilinmeyen ayrı raporlanır.
 */
export function valueOnHand(quantity: number, unitCost: number | null): StockValue {
  if (unitCost === null) {
    return {
      quantity,
      unitCost: null,
      value: null,
      caveat: "Birim maliyet bilinmiyor; bu kalemin değeri toplama DAHİL EDİLMEDİ.",
    };
  }
  if (quantity < 0) {
    return {
      quantity,
      unitCost,
      value: roundCost(quantity * unitCost),
      caveat: "Stok bakiyesi eksi; değerleme güvenilir değil, sayım gerekiyor.",
    };
  }
  return { quantity, unitCost, value: roundCost(quantity * unitCost), caveat: null };
}
