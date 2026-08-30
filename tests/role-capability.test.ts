/**
 * Rol yetenek matrisi.
 *
 * İKİ YÖNLÜ BİR SÖZLEŞME: her rol işini YAPABİLMELİ ve yapmaması
 * gerekeni GÖREMEMELİ. İkisi de sessizce bozulabilir — yeni bir izin
 * eklenince depo sorumlusu nakit görebilir, bir izin adı değişince
 * operatör iş emrini göremez olur. İkisinin de belirtisi yoktur:
 * kimse "acaba fazla mı görüyorum" diye sormaz, eksik gören de
 * sistemin bozuk olduğunu düşünür.
 *
 * Bu dosya, elle yapılan bir denetimin kalıcı hâlidir.
 */

import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/app.js";
import { InMemoryDataSource } from "../src/data/memory.js";
import { createPrincipal } from "../src/kernel/rbac.js";
import type { RoleId } from "../src/kernel/types.js";

function stub(): unknown {
  return new Proxy(function () {} as unknown as object, { get: () => stub(), apply: () => stub() });
}

function registry() {
  const repos = new Proxy({} as Record<string, unknown>, { get: () => stub(), has: () => true });
  return buildRegistry(new InMemoryDataSource("t"), repos as never);
}

const reg = registry();
const seenBy = (role: string): ReadonlySet<string> =>
  new Set(
    reg.catalogFor(createPrincipal({ userId: "u", tenantId: "t", roles: [role as RoleId] })).names,
  );

/** Rolün İŞİNİ YAPABİLMESİ için gereken tool'lar. */
const JOB: Record<string, readonly string[]> = {
  depo_sorumlusu: [
    "post_goods_receipt", "post_delivery", "get_stock_balance",
    "open_stock_count", "record_stock_count", "list_stock_movements",
  ],
  operator: [
    "start_operation", "confirm_operation", "report_breakdown",
    "get_work_order", "list_work_orders",
  ],
  ik_muduru: [
    "get_leave_balance", "approve_leave", "assign_shift",
    "get_payslip", "get_payroll_summary", "get_overtime",
  ],
  satin_alma: [
    "create_purchase_requisition", "create_purchase_rfq", "record_supplier_quote",
    "compare_supplier_quotes", "convert_requisition_to_order", "match_invoice",
  ],
  uretim_muduru: [
    "get_factory_wip", "release_work_order", "run_mrp",
    "get_capacity_load", "list_work_orders", "get_material_requirement",
  ],
  cfo: [
    "get_balance_sheet", "get_income_statement", "get_trial_balance",
    "post_payment", "run_payroll", "get_receivables_aging", "close_period",
  ],
};

/** Rolün GÖRMEMESİ gereken tool'lar. */
const FORBIDDEN: Record<string, readonly string[]> = {
  operator: [
    "get_bank_balance", "get_payslip", "get_income_statement",
    "get_balance_sheet", "run_payroll", "list_open_payables",
  ],
  depo_sorumlusu: [
    "get_bank_balance", "get_payslip", "run_payroll", "post_payment", "get_income_statement",
  ],
  uretim_muduru: ["get_bank_balance", "get_payslip", "run_payroll", "post_payment"],
  satin_alma: ["get_bank_balance", "get_payslip", "run_payroll", "post_payment"],
  // İK maaş GÖRÜR (işi budur) ama bordroyu ÇALIŞTIRAMAZ ve ödeme yapamaz:
  // görevler ayrılığı — personel kartını yöneten, o karttan doğan ödemeyi
  // tek başına tahakkuk ettiremez.
  ik_muduru: ["get_bank_balance", "post_payment", "run_payroll", "get_income_statement"],
};

describe("her rol işini yapabiliyor", () => {
  for (const [role, needed] of Object.entries(JOB)) {
    it(`${role} kritik tool'larının hepsini görüyor`, () => {
      const seen = seenBy(role);
      const missing = needed.filter((t) => !seen.has(t));
      expect(
        missing,
        `${role} bu tool'ları göremiyor ve işini yapamaz: ${missing.join(", ")}`,
      ).toEqual([]);
    });
  }
});

describe("hiçbir rol görmemesi gerekeni görmüyor", () => {
  for (const [role, forbidden] of Object.entries(FORBIDDEN)) {
    it(`${role} yasak tool'ları görmüyor`, () => {
      const seen = seenBy(role);
      const leaked = forbidden.filter((t) => seen.has(t));
      expect(leaked, `${role} bunları GÖRMEMELİ: ${leaked.join(", ")}`).toEqual([]);
    });
  }
});

describe("yetki hiyerarşisi", () => {
  it("PATRON HER ŞEYİ GÖRÜR", () => {
    // Patron göremezse o tool hiçbir yerde denenmemiş demektir.
    const seen = seenBy("patron");
    const invisible = reg.all().filter((t) => !seen.has(t.name));
    expect(
      invisible.map((t) => t.name),
      "patronun göremediği tool var; hiçbir rolde test edilmemiş olabilir",
    ).toEqual([]);
  });

  it("HİÇBİR ROL PATRONDAN FAZLASINI GÖRMEZ", () => {
    // Görseydi yetki hiyerarşisi değil, birbirinden bağımsız izin
    // yığınları olurdu ve "kim neyi görüyor" sorusu cevaplanamazdı.
    const patron = seenBy("patron");
    for (const role of Object.keys({ ...JOB, ...FORBIDDEN })) {
      const extra = [...seenBy(role)].filter((n) => !patron.has(n));
      expect(extra, `${role} patronun görmediğini görüyor: ${extra.join(", ")}`).toEqual([]);
    }
  });

  it("ROLLER DARALARAK GİDER — operatör en dar, patron en geniş", () => {
    const sizes = ["operator", "ik_muduru", "depo_sorumlusu", "satin_alma", "uretim_muduru", "cfo", "patron"]
      .map((r) => seenBy(r).size);
    // Operatör en dar olmalı; patron en geniş.
    expect(sizes[0]).toBeLessThan(sizes[sizes.length - 1]!);
    expect(sizes[sizes.length - 1]).toBe(reg.all().length);
  });

  it("YAZMA YETKİSİ OKUMADAN AZ — her rolde", () => {
    // Bir rolde yazma tool'u okumadan çoksa, o rol veri üreten değil
    // veri değiştiren bir role dönüşmüş demektir; kasıtlı olmalıdır.
    const all = reg.all();
    for (const role of ["operator", "depo_sorumlusu", "satin_alma", "ik_muduru"]) {
      const seen = seenBy(role);
      const tools = all.filter((t) => seen.has(t.name));
      const writes = tools.filter((t) => t.authority > 0).length;
      expect(writes, `${role} yazma=${writes} okuma=${tools.length - writes}`).toBeLessThan(
        tools.length - writes,
      );
    }
  });
});
