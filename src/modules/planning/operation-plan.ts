/**
 * Çok adımlı işlem planı.
 *
 * ÖLÇÜLEN DAVRANIŞ: "şu üç müşteriye fatura kes ve e-Fatura gönder"
 * dendiğinde her adım ayrı bir onay turuna giriyordu. Kullanıcı altı
 * kez onaylıyor, ara adımlardan biri hata verirse geri kalanı SESSİZCE
 * düşüyordu — ne yapıldığını, ne yapılmadığını söyleyen hiçbir şey
 * yoktu.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * ÜÇ KURAL, ÜÇÜ DE ACIDAN ÖĞRENİLMİŞ CİNSTEN:
 *
 * 1. PLAN YETKİ YÜKSELTMEZ. Planın gerektirdiği yetki, adımlarının
 *    EN YÜKSEĞİdir. Aksi hâlde bir L3 ödeme adımı, L2 onaylanmış bir
 *    planın içine gizlenerek onay kapısını aşardı.
 *
 * 2. BAŞARISIZ ADIM PLANI DURDURUR. İmalatta adım 3 genelde adım 2'ye
 *    bağlıdır (fatura → e-Fatura). Hata sonrası devam etmek yarı
 *    tutarlı veri üretir — ve o veri, hangi yarısının doğru olduğu
 *    bilinmediği için tamamen kullanılamaz.
 *
 * 3. ATLANAN ADIM, BAŞARISIZ ADIMDAN FARKLIDIR. Önceki adım düştüğü
 *    için hiç denenmemiş bir adım, denenip başarısız olmuş bir
 *    adımla aynı şey değildir: birincisi hâlâ yapılabilir, ikincisi
 *    önce düzeltilmeli. Tek duruma indirgemek kullanıcıya ne
 *    yapacağını söylemez.
 */

export type PlanStatus = "draft" | "approved" | "running" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "done" | "failed" | "skipped";

export class PlanError extends Error {
  readonly code = "operation_plan";
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface PlanStep {
  readonly seq: number;
  readonly tool: string;
  readonly input: unknown;
  readonly description: string;
}

export interface StepOutcome {
  readonly seq: number;
  readonly tool: string;
  readonly description: string;
  readonly status: StepStatus;
  readonly summary: string | null;
  readonly errorCode: string | null;
}

export interface PlanReport {
  readonly documentNo: string;
  readonly status: PlanStatus;
  readonly steps: readonly StepOutcome[];
  readonly doneCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  /** Kullanıcıya tek cümlede ne olduğu. */
  readonly summary: string;
  /**
   * Yarıda kalan plan için: hangi adımlar hâlâ yapılabilir.
   * Boşsa ya plan tamamlandı ya da devam edilemez.
   */
  readonly resumable: readonly number[];
}

/** Adım sıralarının geçerliliği. */
export function assertSteps(steps: readonly PlanStep[]): void {
  if (steps.length === 0) {
    throw new PlanError("Planda hiç adım yok; boş bir plan hiçbir şey yapmaz.");
  }
  if (steps.length > 25) {
    throw new PlanError(
      `Planda ${steps.length} adım var. Yirmi beşten uzun bir planı kullanıcı ` +
        `okumadan onaylar — ve okunmadan onaylanan bir plan, onay değildir.`,
    );
  }
  const siralar = steps.map((s) => s.seq);
  if (new Set(siralar).size !== siralar.length) {
    throw new PlanError("Aynı sıra numarası iki adımda kullanılamaz; koşum sırası belirsiz kalır.");
  }
  for (const s of steps) {
    if (!Number.isInteger(s.seq) || s.seq < 1) {
      throw new PlanError(`Geçersiz sıra numarası: ${s.seq}. Sıra 1'den başlayan tam sayıdır.`);
    }
  }
}

/**
 * Planın gerektirdiği yetki — adımların en yükseği.
 *
 * @param authorityOf Tool adından yetki seviyesi; tool kayıtlı
 *   değilse null döner ve plan REDDEDİLİR. Kayıtlı olmayan bir
 *   tool'un yetkisi bilinmiyorsa, planın yetkisi de bilinmiyordur.
 */
export function requiredAuthority(
  steps: readonly PlanStep[],
  authorityOf: (tool: string) => number | null,
): number {
  let en = 0;
  for (const s of steps) {
    const a = authorityOf(s.tool);
    if (a === null) {
      throw new PlanError(
        `"${s.tool}" diye kayıtlı bir tool yok (adım ${s.seq}). Yetkisi bilinmeyen ` +
          `bir adım, yetkisi bilinmeyen bir plan demektir.`,
      );
    }
    if (a > en) en = a;
  }
  return en;
}

/**
 * Koşumun bir adımdan sonraki durumu.
 *
 * SAF FONKSİYON: koşum sırasını ve durum geçişlerini burada tutmak,
 * onları veritabanı işlemlerinden bağımsız test edilebilir kılıyor.
 * Sıra mantığı repository'nin içinde olsaydı, "üçüncü adım düşerse
 * dördüncü atlanır mı" sorusunu ancak gerçek bir veritabanıyla
 * yanıtlayabilirdik.
 */
export function planAfterFailure(
  steps: readonly PlanStep[],
  failedSeq: number,
): { readonly skipped: readonly number[] } {
  return {
    skipped: steps
      .filter((s) => s.seq > failedSeq)
      .map((s) => s.seq)
      .sort((a, b) => a - b),
  };
}

/** Sonuçlardan rapor. */
export function buildReport(
  documentNo: string,
  outcomes: readonly StepOutcome[],
): PlanReport {
  const done = outcomes.filter((o) => o.status === "done");
  const failed = outcomes.filter((o) => o.status === "failed");
  const skipped = outcomes.filter((o) => o.status === "skipped");

  const status: PlanStatus = failed.length > 0 ? "failed" : "completed";

  const summary =
    failed.length === 0
      ? `${done.length} adımın tamamı tamamlandı.`
      : `${done.length} adım tamamlandı, ${failed.length} adım BAŞARISIZ oldu` +
        (skipped.length > 0
          ? `, ${skipped.length} adım hiç DENENMEDİ (önceki adım düştüğü için).`
          : ".") +
        ` Düşen adım: ${failed[0]!.seq} — ${failed[0]!.description}` +
        (failed[0]!.errorCode ? ` (${failed[0]!.errorCode})` : "") +
        `.`;

  return {
    documentNo,
    status,
    steps: [...outcomes].sort((a, b) => a.seq - b.seq),
    doneCount: done.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    summary,
    /*
     * DEVAM EDİLEBİLİR ADIMLAR yalnızca ATLANANLARDIR.
     *
     * Başarısız adım listeye girmez: o adım denendi ve düştü, önce
     * sebebi düzeltilmeli. Atlanan adımlar ise hiç denenmedi ve
     * sebep ortadan kalkarsa doğrudan koşabilirler.
     */
    resumable: skipped.map((s) => s.seq),
  };
}

/**
 * Onay listesi ile kayıtlı adımlar aynı mı.
 *
 * BU FONKSİYON, PLANIN GÜVENLİK DAYANAĞIDIR.
 *
 * `run_operation_plan` tek tıklamayla N yazma işlemi yetkilendiriyor —
 * feature'ın amacı bu. Ama o tıklama, kullanıcının NE onayladığını
 * gerçekten gördüğü anlamına gelmeli.
 *
 * Onay formu tool'un GİRDİSİNİ gösteriyor. Girdi yalnızca belge
 * numarası taşısaydı, kullanıcı "PLN-2026-0001'i çalıştır" yazısını
 * onaylar ve içindekileri hiç görmezdi.
 *
 * Bu yüzden adım listesi girdiye giriyor ve burada kayıtlı planla
 * KARŞILAŞTIRILIYOR: model uydurma bir liste gösterip başka adımlar
 * koşturamaz. Kullanıcı ne gördüyse o koşar.
 */
export function assertConfirmationMatches(
  steps: readonly { seq: number; description: string }[],
  confirmSteps: readonly string[],
): void {
  const beklenen = [...steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => `${s.seq}. ${s.description}`);
  const gelen = confirmSteps.map((x) => x.trim());

  if (beklenen.length !== gelen.length || !beklenen.every((b, i) => b === gelen[i])) {
    throw new PlanError(
      `Onay listesi plandaki adımlarla tutmuyor; koşum reddedildi. Kullanıcının ` +
        `gördüğü liste ile koşacak adımlar aynı olmak zorunda. Plandaki adımlar: ` +
        beklenen.join(" | "),
    );
  }
}

/**
 * Durum geçişinin geçerliliği.
 *
 * KOŞMUŞ PLAN TEKRAR KOŞMAZ. Koşan bir planı yeniden çalıştırmak
 * aynı faturaları ikinci kez keser. Durum makinesi bunu tek yerde
 * engelliyor; her çağıranın hatırlaması gereken bir kural olsaydı,
 * biri unuturdu.
 */
export function assertRunnable(status: PlanStatus): void {
  /*
   * TASLAK DA KOŞABİLİR — ÇÜNKÜ ONAY KOŞUM ANINDA VERİLİYOR.
   *
   * Önce ayrı bir "onayla" adımı vardı ve hiçbir şey eklemiyordu:
   * `run_operation_plan` zaten onay kapısından geçiyor. İki ayrı onay,
   * kullanıcıyı iki kez tıklatıp güvenliği bir arpa boyu artırmıyordu
   * — ve bu tam olarak plandan kurtulmak istediğimiz şeydi.
   */
  if (status === "approved" || status === "draft") return;
  const sebep: Record<Exclude<PlanStatus, "approved" | "draft">, string> = {
    running: "Plan zaten koşuyor.",
    completed: "Plan zaten tamamlandı; yeniden koşmak aynı kayıtları ikinci kez üretir.",
    failed: "Plan başarısız oldu; yeniden koşmadan önce düşen adımın sebebi düzeltilmeli.",
    cancelled: "Plan iptal edildi.",
  };
  throw new PlanError(sebep[status as Exclude<PlanStatus, "approved" | "draft">]);
}
