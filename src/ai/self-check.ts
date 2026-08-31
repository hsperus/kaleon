/**
 * Öz-doğrulama — cevabın kendi sağlamasını yapması.
 *
 * BU PROJEDE TAM OLARAK BU YÜZDEN BİR HATA CANLIDA KALDI: mizan
 * denkti, bilanço 941 milyon açık veriyordu. Ajan rakamı üretti ve
 * sundu; ikinci bir tool'la sağlamasını yapmadı. Kullanıcı sorana
 * kadar kimse bakmadı.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * SAĞLAMA MODELE BIRAKILMAZ, KODA GÖMÜLÜR.
 *
 * "Cevabını kontrol et" diye bir talimat yazmak, kontrolü modelin o
 * turdaki dikkatine bırakır. Bir mali tablonun denk olup olmadığı
 * dikkat meselesi değildir: tool zaten `balanced` alanını döndürüyor
 * ve o alan false ise cevap ne derse desin güvenilmezdir.
 *
 * KONTROL SESSİZ BAŞARISIZ OLMAZ. Bir tool'un sağlama alanı yoksa
 * "geçti" saymıyoruz — "kontrol edilmedi" diyoruz. İkisi arasındaki
 * fark, yanlış bir güvenle doğru bir belirsizlik arasındaki farktır.
 */

export type CheckStatus = "ok" | "failed" | "unchecked";

export interface SelfCheck {
  readonly tool: string;
  readonly status: CheckStatus;
  /** Kullanıcıya gösterilecek cümle; `ok` durumunda boş. */
  readonly message: string;
}

/**
 * Bir tool sonucundan sağlama çıkarır.
 *
 * Kural TOOL BAZINDA tanımlı çünkü her tablonun sağlaması farklı:
 * mizanda borç=alacak, bilançoda aktif=pasif, nakit akışında
 * hesaplanan değişim=gerçek değişim.
 */
interface Rule {
  /** Sonuç verisinden sağlamayı okur. null = bu veride kontrol yok. */
  readonly read: (data: Record<string, unknown>) => { ok: boolean; detail: string } | null;
}

function sayi(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const TR = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2 });

/**
 * Sağlaması olan tool'lar.
 *
 * Liste kısa ve kısa kalması iyi: her tool'a bir sağlama uydurmak,
 * anlamsız kontroller üretir ve gerçek olanların ciddiyetini düşürür.
 * Buraya yalnızca DENKLİK İDDİASI olan tool'lar giriyor.
 */
const KURALLAR: Record<string, Rule> = {
  get_trial_balance: {
    read: (d) => {
      if (typeof d["balanced"] !== "boolean") return null;
      const borc = sayi(d["totalDebit"]);
      const alacak = sayi(d["totalCredit"]);
      return {
        ok: d["balanced"] === true,
        detail:
          borc !== null && alacak !== null
            ? `borç ${TR.format(borc)} ≠ alacak ${TR.format(alacak)}`
            : "borç ve alacak toplamı tutmuyor",
      };
    },
  },
  get_balance_sheet: {
    read: (d) => {
      if (typeof d["balanced"] !== "boolean") return null;
      const aktif = sayi(d["totalAssets"]);
      const pasif = sayi(d["totalLiabilitiesAndEquity"]);
      return {
        ok: d["balanced"] === true,
        detail:
          aktif !== null && pasif !== null
            ? `aktif ${TR.format(aktif)} ≠ pasif ${TR.format(pasif)}, fark ${TR.format(aktif - pasif)}`
            : "aktif ve pasif toplamı tutmuyor",
      };
    },
  },
  get_cash_flow_statement: {
    read: (d) => {
      if (typeof d["balanced"] !== "boolean") return null;
      const fark = sayi(d["checkDifference"]);
      return {
        ok: d["balanced"] === true,
        detail:
          fark !== null
            ? `hesaplanan net değişim ile nakit hesaplarındaki gerçek değişim ` +
              `arasında ${TR.format(fark)} fark var`
            : "net değişim nakit hesaplarıyla tutmuyor",
      };
    },
  },
  post_journal_entry: {
    read: (d) => {
      // Fiş atıldıysa denk atılmıştır (motor zorluyor); burada
      // kontrol edilen şey belge numarasının gerçekten dönmesi.
      const no = d["documentNo"];
      return typeof no === "string" && no.length > 0
        ? { ok: true, detail: "" }
        : { ok: false, detail: "fiş numarası dönmedi; kaydın oluştuğu doğrulanamıyor" };
    },
  },
};

export interface ToolOutcome {
  readonly tool: string;
  readonly ok: boolean;
  readonly data?: unknown;
}

/**
 * Bir turdaki tool çağrılarının sağlamasını yapar.
 *
 * YALNIZCA SAĞLAMASI OLAN TOOL'LAR DEĞERLENDİRİLİR. Diğerleri
 * listeye hiç girmez — "kontrol edilmedi" damgası, kontrol edilecek
 * bir şeyi olan ama kontrolü çalışmayan tool'lar için ayrılmıştır.
 */
export function verifyOutcomes(outcomes: readonly ToolOutcome[]): readonly SelfCheck[] {
  const sonuc: SelfCheck[] = [];

  for (const o of outcomes) {
    const kural = KURALLAR[o.tool];
    if (!kural) continue;

    if (!o.ok) {
      sonuc.push({
        tool: o.tool,
        status: "failed",
        message: `${o.tool} başarısız oldu; bu cevaptaki ilgili rakamlar eksik olabilir.`,
      });
      continue;
    }

    if (typeof o.data !== "object" || o.data === null) {
      sonuc.push({
        tool: o.tool,
        status: "unchecked",
        message: `${o.tool} sonucu okunamadı; sağlaması YAPILAMADI.`,
      });
      continue;
    }

    const okuma = kural.read(o.data as Record<string, unknown>);
    if (okuma === null) {
      /*
       * SAĞLAMA ALANI YOKSA "GEÇTİ" DEĞİL "KONTROL EDİLMEDİ".
       *
       * Geçti saymak, alanın kaybolduğu bir sürümde kontrolü sessizce
       * kapatırdı — ve kimse fark etmezdi.
       */
      sonuc.push({
        tool: o.tool,
        status: "unchecked",
        message: `${o.tool} sonucunda denklik alanı yok; sağlaması YAPILAMADI.`,
      });
      continue;
    }

    sonuc.push(
      okuma.ok
        ? { tool: o.tool, status: "ok", message: "" }
        : {
            tool: o.tool,
            status: "failed",
            message: `${o.tool} DENK DEĞİL: ${okuma.detail}.`,
          },
    );
  }

  return sonuc;
}

/**
 * Sağlama sonuçlarından kullanıcıya gösterilecek uyarı.
 *
 * BAŞARISIZ SAĞLAMA CEVABI GİZLEMEZ, ÜSTÜNE YAZILIR. Cevabı
 * saklamak, kullanıcıyı hiçbir şey göstermeden bırakır ve o da
 * genellikle soruyu tekrar sorar. Doğru olan, rakamı vermek ve
 * yanında "bu rakam denk değil" demektir.
 */
export function selfCheckRisk(
  checks: readonly SelfCheck[],
): { severity: "critical" | "warning"; message: string } | null {
  const basarisiz = checks.filter((c) => c.status === "failed");
  if (basarisiz.length > 0) {
    return {
      severity: "critical",
      message:
        `ÖZ-DENETİM UYARISI — ${basarisiz.map((c) => c.message).join(" ")} ` +
        `Bu cevaptaki rakamlar mali tablo olarak KULLANILMAMALI; önce fark bulunmalı.`,
    };
  }

  const kontrolsuz = checks.filter((c) => c.status === "unchecked");
  if (kontrolsuz.length > 0) {
    return {
      severity: "warning",
      message:
        `${kontrolsuz.length} mali çıktının sağlaması yapılamadı: ` +
        `${kontrolsuz.map((c) => c.tool).join(", ")}.`,
    };
  }

  return null;
}
