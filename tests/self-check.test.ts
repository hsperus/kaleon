/**
 * Öz-doğrulama.
 *
 * BU MODÜL SOMUT BİR OLAYDAN DOĞDU: mizan denkti, bilanço 941 milyon
 * açık veriyordu ve ajan rakamı sundu. Sağlamayı modelin dikkatine
 * bırakmak yerine koda gömmek, tam olarak o hatayı yakalamak için.
 */

import { describe, expect, it } from "vitest";
import { verifyOutcomes, selfCheckRisk } from "../src/ai/self-check.js";

describe("öz-doğrulama", () => {
  it("denk mizan geçer", () => {
    const c = verifyOutcomes([
      { tool: "get_trial_balance", ok: true, data: { balanced: true, totalDebit: 100, totalCredit: 100 } },
    ]);
    expect(c[0]!.status).toBe("ok");
    expect(selfCheckRisk(c)).toBeNull();
  });

  it("DENK OLMAYAN BİLANÇO YAKALANIR ve fark rakamla söylenir", () => {
    const c = verifyOutcomes([
      {
        tool: "get_balance_sheet",
        ok: true,
        data: { balanced: false, totalAssets: 21_433_316, totalLiabilitiesAndEquity: 20_492_316 },
      },
    ]);
    expect(c[0]!.status).toBe("failed");
    expect(c[0]!.message).toContain("941.000");
    const risk = selfCheckRisk(c)!;
    expect(risk.severity).toBe("critical");
    expect(risk.message).toContain("KULLANILMAMALI");
  });

  it("nakit akış tablosunun kontrol farkı okunur", () => {
    const c = verifyOutcomes([
      { tool: "get_cash_flow_statement", ok: true, data: { balanced: false, checkDifference: -250_000 } },
    ]);
    expect(c[0]!.status).toBe("failed");
    expect(c[0]!.message).toContain("250.000");
  });

  it("SAĞLAMA ALANI YOKSA 'GEÇTİ' DEĞİL 'KONTROL EDİLMEDİ'", () => {
    /*
     * Geçti saymak, alanın kaybolduğu bir sürümde kontrolü sessizce
     * kapatırdı — ve kimse fark etmezdi.
     */
    const c = verifyOutcomes([{ tool: "get_trial_balance", ok: true, data: { totalDebit: 100 } }]);
    expect(c[0]!.status).toBe("unchecked");
    expect(selfCheckRisk(c)!.severity).toBe("warning");
  });

  it("başarısız tool sağlamada da başarısız sayılır", () => {
    const c = verifyOutcomes([{ tool: "get_balance_sheet", ok: false }]);
    expect(c[0]!.status).toBe("failed");
  });

  it("SAĞLAMASI OLMAYAN TOOL LİSTEYE HİÇ GİRMEZ", () => {
    // Her tool'a bir sağlama uydurmak, anlamsız kontroller üretir ve
    // gerçek olanların ciddiyetini düşürür.
    const c = verifyOutcomes([{ tool: "search_employees", ok: true, data: { total: 5 } }]);
    expect(c).toHaveLength(0);
    expect(selfCheckRisk(c)).toBeNull();
  });

  it("okunamayan veri 'kontrol edilmedi' üretir", () => {
    const c = verifyOutcomes([{ tool: "get_trial_balance", ok: true, data: "bozuk" }]);
    expect(c[0]!.status).toBe("unchecked");
  });

  it("birden fazla başarısızlık tek uyarıda toplanır", () => {
    const c = verifyOutcomes([
      { tool: "get_trial_balance", ok: true, data: { balanced: false, totalDebit: 1, totalCredit: 2 } },
      { tool: "get_balance_sheet", ok: true, data: { balanced: false, totalAssets: 5, totalLiabilitiesAndEquity: 3 } },
    ]);
    const risk = selfCheckRisk(c)!;
    expect(risk.severity).toBe("critical");
    expect(risk.message).toContain("get_trial_balance");
    expect(risk.message).toContain("get_balance_sheet");
  });

  it("BAŞARISIZLIK KRİTİK, KONTROLSÜZLÜK UYARI — ikisi karışmaz", () => {
    const c = verifyOutcomes([
      { tool: "get_trial_balance", ok: true, data: { balanced: false, totalDebit: 1, totalCredit: 2 } },
      { tool: "get_balance_sheet", ok: true, data: {} },
    ]);
    // Gerçek bir denklik hatası varken "kontrol edilmedi" uyarısı
    // onu bastırmamalı.
    expect(selfCheckRisk(c)!.severity).toBe("critical");
  });

  it("fiş numarası dönmeyen kayıt doğrulanamaz sayılır", () => {
    const c = verifyOutcomes([{ tool: "post_journal_entry", ok: true, data: { documentNo: "" } }]);
    expect(c[0]!.status).toBe("failed");
    expect(c[0]!.message).toContain("doğrulanamıyor");
  });
});
