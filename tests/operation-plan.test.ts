/**
 * Çok adımlı işlem planı.
 *
 * TEST EDİLEN ŞEY ADIMLARI SIRAYLA KOŞTURMAK DEĞİL — o kolay. Test
 * edilen şey, YARIDA KALAN bir planın ne söylediği: hangi adım
 * yapıldı, hangisi düştü, hangisi hiç denenmedi ve hangisi hâlâ
 * yapılabilir.
 */

import { describe, expect, it } from "vitest";
import {
  assertSteps,
  requiredAuthority,
  planAfterFailure,
  buildReport,
  assertRunnable,
  assertConfirmationMatches,
  PlanError,
  type PlanStep,
  type StepOutcome,
} from "../src/modules/planning/operation-plan.js";

const ADIMLAR: PlanStep[] = [
  { seq: 1, tool: "issue_sales_invoice", input: {}, description: "Kuehne + Nagel faturası" },
  { seq: 2, tool: "build_einvoice_document", input: {}, description: "e-Fatura üret" },
  { seq: 3, tool: "post_payment", input: {}, description: "Tahsilat kaydı" },
];

const YETKI: Record<string, number> = {
  issue_sales_invoice: 2,
  build_einvoice_document: 1,
  post_payment: 3,
};
const yetkiOf = (t: string) => YETKI[t] ?? null;

describe("plan doğrulama", () => {
  it("boş plan reddedilir", () => {
    expect(() => assertSteps([])).toThrow(/hiçbir şey yapmaz/);
  });

  it("ÇOK UZUN PLAN REDDEDİLİR — okunmadan onaylanan plan onay değildir", () => {
    const uzun = Array.from({ length: 26 }, (_, i) => ({ ...ADIMLAR[0]!, seq: i + 1 }));
    expect(() => assertSteps(uzun)).toThrow(PlanError);
  });

  it("mükerrer sıra numarası reddedilir", () => {
    expect(() =>
      assertSteps([ADIMLAR[0]!, { ...ADIMLAR[1]!, seq: 1 }]),
    ).toThrow(/koşum sırası belirsiz/);
  });

  it("sıfır ve negatif sıra reddedilir", () => {
    expect(() => assertSteps([{ ...ADIMLAR[0]!, seq: 0 }])).toThrow(/1'den başlayan/);
  });
});

describe("yetki", () => {
  it("PLAN YETKİ YÜKSELTMEZ: gereken yetki adımların EN YÜKSEĞİDİR", () => {
    /*
     * Bir L3 ödeme adımı, L2 onaylanmış bir planın içine gizlenerek
     * onay kapısını aşamamalı.
     */
    expect(requiredAuthority(ADIMLAR, yetkiOf)).toBe(3);
    expect(requiredAuthority(ADIMLAR.slice(0, 2), yetkiOf)).toBe(2);
  });

  it("yalnızca okuma adımları L0 kalır", () => {
    expect(requiredAuthority([{ seq: 1, tool: "x", input: {}, description: "" }], () => 0)).toBe(0);
  });

  it("KAYITLI OLMAYAN TOOL PLANI REDDETTİRİR", () => {
    // Yetkisi bilinmeyen bir adım, yetkisi bilinmeyen bir plan demektir.
    expect(() =>
      requiredAuthority([{ seq: 1, tool: "olmayan_tool", input: {}, description: "" }], yetkiOf),
    ).toThrow(/kayıtlı bir tool yok/);
  });
});

describe("başarısızlık sonrası", () => {
  it("düşen adımdan SONRAKİLER atlanır", () => {
    expect(planAfterFailure(ADIMLAR, 1).skipped).toEqual([2, 3]);
  });

  it("son adım düşerse atlanan olmaz", () => {
    expect(planAfterFailure(ADIMLAR, 3).skipped).toEqual([]);
  });
});

function sonuc(seq: number, status: StepOutcome["status"], extra: Partial<StepOutcome> = {}): StepOutcome {
  return {
    seq,
    tool: ADIMLAR[seq - 1]!.tool,
    description: ADIMLAR[seq - 1]!.description,
    status,
    summary: null,
    errorCode: null,
    ...extra,
  };
}

describe("rapor", () => {
  it("hepsi tamamlandıysa completed", () => {
    const r = buildReport("PLN-1", [sonuc(1, "done"), sonuc(2, "done"), sonuc(3, "done")]);
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("3 adımın tamamı tamamlandı.");
    expect(r.resumable).toEqual([]);
  });

  it("YARIDA KALAN PLAN NE OLDUĞUNU SÖYLER", () => {
    const r = buildReport("PLN-1", [
      sonuc(1, "done"),
      sonuc(2, "failed", { errorCode: "einvoice_missing_taxid" }),
      sonuc(3, "skipped"),
    ]);
    expect(r.status).toBe("failed");
    expect(r.doneCount).toBe(1);
    expect(r.failedCount).toBe(1);
    expect(r.skippedCount).toBe(1);
    expect(r.summary).toContain("1 adım tamamlandı");
    expect(r.summary).toContain("hiç DENENMEDİ");
    expect(r.summary).toContain("einvoice_missing_taxid");
  });

  it("DEVAM EDİLEBİLİR ADIMLAR YALNIZCA ATLANANLARDIR", () => {
    /*
     * Başarısız adım listeye girmez: denendi ve düştü, önce sebebi
     * düzeltilmeli. Atlanan adım hiç denenmedi ve sebep kalkarsa
     * doğrudan koşabilir.
     */
    const r = buildReport("PLN-1", [
      sonuc(1, "done"),
      sonuc(2, "failed"),
      sonuc(3, "skipped"),
    ]);
    expect(r.resumable).toEqual([3]);
  });

  it("rapor sıra numarasına göre döner", () => {
    const r = buildReport("PLN-1", [sonuc(3, "skipped"), sonuc(1, "done"), sonuc(2, "failed")]);
    expect(r.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
  });
});

/*
 * PLANIN GÜVENLİK DAYANAĞI.
 *
 * `run_operation_plan` tek tıklamayla N yazma işlemi yetkilendiriyor.
 * O tıklamanın geçerli olması için kullanıcının NE onayladığını
 * gerçekten görmüş olması gerekiyor — ve gördüğü listeyle koşacak
 * listenin aynı olduğunu SUNUCU kanıtlamalı.
 */
describe("onay eşleştirmesi", () => {
  const adimlar = [
    { seq: 1, description: "Kuehne + Nagel faturası" },
    { seq: 2, description: "e-Fatura üret" },
  ];

  it("birebir aynı liste geçer", () => {
    expect(() =>
      assertConfirmationMatches(adimlar, ["1. Kuehne + Nagel faturası", "2. e-Fatura üret"]),
    ).not.toThrow();
  });

  it("baştaki/sondaki boşluk sorun değil", () => {
    expect(() =>
      assertConfirmationMatches(adimlar, ["  1. Kuehne + Nagel faturası ", "2. e-Fatura üret"]),
    ).not.toThrow();
  });

  it("UYDURMA LİSTE REDDEDİLİR", () => {
    // Model zararsız bir liste gösterip başka adımlar koşturamaz.
    expect(() => assertConfirmationMatches(adimlar, ["1. Zararsız bir şey", "2. e-Fatura üret"])).toThrow(
      PlanError,
    );
  });

  it("EKSİK LİSTE REDDEDİLİR — gizlenen adım olmaz", () => {
    expect(() => assertConfirmationMatches(adimlar, ["1. Kuehne + Nagel faturası"])).toThrow(
      /tutmuyor/,
    );
  });

  it("FAZLA SATIR DA REDDEDİLİR", () => {
    expect(() =>
      assertConfirmationMatches(adimlar, [
        "1. Kuehne + Nagel faturası",
        "2. e-Fatura üret",
        "3. Uydurma adım",
      ]),
    ).toThrow(PlanError);
  });

  it("SIRA DEĞİŞTİRİLEMEZ", () => {
    // Sıra, hangi adımın hangisinden önce koşacağını belirliyor.
    expect(() =>
      assertConfirmationMatches(adimlar, ["2. e-Fatura üret", "1. Kuehne + Nagel faturası"]),
    ).toThrow(PlanError);
  });

  it("hata mesajı GERÇEK adımları yazar — kullanıcı farkı görsün", () => {
    try {
      assertConfirmationMatches(adimlar, ["1. Yanlış"]);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("Kuehne + Nagel faturası");
      expect((e as Error).message).toContain("e-Fatura üret");
    }
  });
});

describe("durum makinesi", () => {
  it("yalnızca onaylanmış plan koşar", () => {
    expect(() => assertRunnable("approved")).not.toThrow();
  });

  it("KOŞMUŞ PLAN TEKRAR KOŞMAZ", () => {
    // Yeniden çalıştırmak aynı faturaları ikinci kez keser.
    expect(() => assertRunnable("completed")).toThrow(/ikinci kez/);
  });

  it("TASLAK KOŞAR — onay koşum anında veriliyor", () => {
    /*
     * Ayrı bir "onayla" adımı hiçbir şey eklemiyordu:
     * `run_operation_plan` zaten onay kapısından geçiyor. İki ayrı
     * onay, kullanıcıyı iki kez tıklatıp planın çözdüğü sorunu geri
     * getirirdi.
     */
    expect(() => assertRunnable("draft")).not.toThrow();
  });

  it("başarısız plan düzeltilmeden koşmaz", () => {
    expect(() => assertRunnable("failed")).toThrow(/sebebi düzeltilmeli/);
  });

  it("iptal edilmiş ve koşan plan da reddedilir", () => {
    expect(() => assertRunnable("cancelled")).toThrow(PlanError);
    expect(() => assertRunnable("running")).toThrow(/zaten koşuyor/);
  });
});
