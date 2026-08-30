/**
 * Bordro hesabı.
 *
 * BURADAKİ HATA İNSANIN MAAŞINDAN ÇIKAR. Eksik kesilen vergi yıl
 * sonunda çalışandan geri istenir; fazla kesilen, hakkı olan parayı
 * alamaması demektir. İşveren tarafında ise eksik prim, gecikme
 * zammıyla birlikte cezaya döner.
 *
 * Testler mevzuatın dört kuralını hedefliyor: kümülatif matrah, SGK
 * tavanının yalnızca prime uygulanması, asgari ücret istisnasının
 * tavan oluşu ve SGK tabanı.
 */

import { describe, expect, it } from "vitest";
import {
  annualPlan,
  calculate,
  marginalRateFor,
  minimumWageTaxFor,
  taxOn,
  PayrollError,
} from "../src/modules/payroll/payroll.js";
import {
  parametersFor,
  PARAMETERS_2026,
  PayrollParameterError,
} from "../src/modules/payroll/parameters.js";

const P = PARAMETERS_2026;
const B = P.brackets.value;
const jan = new Date(Date.UTC(2026, 0, 15));

describe("gelir vergisi tarifesi", () => {
  it("GİB 2026 ücret tarifesini birebir uygular", () => {
    // Resmi tarifedeki kümülatif tutarlar.
    expect(taxOn(190_000, B)).toBe(28_500);
    expect(taxOn(400_000, B)).toBe(70_500);
    expect(taxOn(1_500_000, B)).toBe(367_500);
    expect(taxOn(5_300_000, B)).toBe(1_697_500);
  });

  it("ÜCRET DIŞI TARİFE KULLANILMAZ", () => {
    // Ücret dışı gelirlerde 3. dilim 1.000.000'de biter ve 1.000.000
    // matrahın vergisi 232.500 olurdu. Ücrette 270.000'dir.
    expect(taxOn(1_000_000, B)).toBe(232_500 + 0); // ücret dışı değeri
    // Ücret tarifesinde: 70.500 + (1.000.000−400.000)×0,27 = 232.500
    // İki tarife bu noktada çakışıyor; ayrım 1.000.000 SONRASINDA çıkar.
    expect(taxOn(1_200_000, B)).toBe(70_500 + 800_000 * 0.27);
  });

  it("dilim GEÇİŞİ kademelidir — tamamı üst orandan değil", () => {
    // 200.000 matrah: ilk 190.000 %15, kalan 10.000 %20.
    expect(taxOn(200_000, B)).toBe(28_500 + 2_000);
  });

  it("sıfır ve negatif matrahta vergi yok", () => {
    expect(taxOn(0, B)).toBe(0);
    expect(taxOn(-5_000, B)).toBe(0);
  });

  it("marjinal dilim doğru okunur", () => {
    expect(marginalRateFor(100_000, B)).toBe(15);
    expect(marginalRateFor(300_000, B)).toBe(20);
    expect(marginalRateFor(1_000_000, B)).toBe(27);
    expect(marginalRateFor(6_000_000, B)).toBe(40);
  });
});

describe("asgari ücret bordrosu", () => {
  const r = calculate({ grossSalary: 33_030, period: jan, cumulativeBase: 0 });

  it("NET ASGARİ ÜCRET 28.075,50 ÇIKAR", () => {
    // Resmi rakam. Tutmuyorsa oranlardan biri yanlıştır.
    expect(r.netSalary).toBe(28_075.5);
  });

  it("asgari ücretten GELİR VE DAMGA VERGİSİ KESİLMEZ", () => {
    // İstisna tam olarak bu kesintileri sıfırlar.
    expect(r.incomeTax).toBe(0);
    expect(r.stampDuty).toBe(0);
  });

  it("kesintiler yalnızca SGK ve işsizlik", () => {
    expect(r.employeeSgk).toBe(4_624.2);
    expect(r.employeeUnemployment).toBe(330.3);
    expect(r.totalDeductions).toBe(4_954.5);
  });
});

describe("kümülatif matrah", () => {
  it("AYLIK BAĞIMSIZ HESAPLANMAZ — dilim yıl içinde yükselir", () => {
    /*
     * Bordronun en pahalı hatası budur: her ay bağımsız hesaplansaydı
     * herkes yıl boyunca %15'te kalır ve yıl sonunda devasa bir vergi
     * farkı çıkardı.
     */
    const plan = annualPlan(120_000, 2026);
    const ocak = plan[0]!;
    const aralik = plan[11]!;
    expect(aralik.incomeTax).toBeGreaterThan(ocak.incomeTax);
    expect(aralik.marginalRate).toBeGreaterThan(ocak.marginalRate);
    // Net maaş yıl içinde DÜŞER; işveren maliyeti sabit kalır.
    expect(aralik.netSalary).toBeLessThan(ocak.netSalary);
    expect(aralik.employerCost).toBe(ocak.employerCost);
  });

  it("kümülatif matrah her ay birikir", () => {
    const plan = annualPlan(120_000, 2026);
    expect(plan[0]!.cumulativeBaseBefore).toBe(0);
    expect(plan[1]!.cumulativeBaseBefore).toBe(plan[0]!.cumulativeBaseAfter);
    expect(plan[11]!.cumulativeBaseAfter).toBeCloseTo(plan[0]!.taxBase * 12, 1);
  });

  it("YIL ORTASINDA SIFIR KÜMÜLATİF ÇEKİNCE ÜRETİR", () => {
    // Doğru olabilir (yıl içi işe giriş) ama sessiz kalmamalı:
    // yanlışsa gelir vergisi eksik kesilir.
    const r = calculate({
      grossSalary: 120_000,
      period: new Date(Date.UTC(2026, 6, 15)),
      cumulativeBase: 0,
    });
    expect(r.caveats.some((c) => c.includes("EKSİK"))).toBe(true);
  });

  it("ocak ayında sıfır kümülatif çekince üretmez", () => {
    const r = calculate({ grossSalary: 120_000, period: jan, cumulativeBase: 0 });
    expect(r.caveats.some((c) => c.includes("Kümülatif matrah sıfır"))).toBe(false);
  });
});

describe("SGK taban ve tavan", () => {
  it("TAVANI AŞAN KAZANÇTAN PRİM KESİLMEZ", () => {
    const r = calculate({ grossSalary: 400_000, period: jan, cumulativeBase: 0 });
    expect(r.sgkBase).toBe(P.sgkCeiling.value);
    expect(r.employeeSgk).toBe(297_270 * 0.14);
  });

  it("TAVANI AŞAN KAZANÇTAN GELİR VERGİSİ KESİLİR", () => {
    /*
     * Tavan vergiye de uygulansaydı yüksek maaşlılar eksik
     * vergilendirilirdi — bu, bordro yazılımlarında sık görülen bir
     * hatadır.
     */
    const r = calculate({ grossSalary: 400_000, period: jan, cumulativeBase: 0 });
    // Matrah TOPLAM brütten hesaplanır, SGK matrahından değil.
    expect(r.taxBase).toBe(round2(400_000 - r.employeeSgk - r.employeeUnemployment));
    expect(r.taxBase).toBeGreaterThan(P.sgkCeiling.value * 0.85);
  });

  it("tavan aşımı ÇEKİNCE olarak bildirilir", () => {
    const r = calculate({ grossSalary: 400_000, period: jan, cumulativeBase: 0 });
    expect(r.caveats.some((c) => c.includes("tavan"))).toBe(true);
  });

  it("TABAN ALTINDA KAZANÇ OLMAZ", () => {
    // Yarım gün çalışanda bile prim taban üzerinden hesaplanır.
    const r = calculate({ grossSalary: 20_000, period: jan, cumulativeBase: 0 });
    expect(r.sgkBase).toBe(P.sgkFloor.value);
    expect(r.employeeSgk).toBe(round2(33_030 * 0.14));
  });
});

describe("asgari ücret istisnası", () => {
  it("İSTİSNA VERGİYİ NEGATİFE DÜŞÜREMEZ", () => {
    // Asgari ücretin altında bir matrahta istisna, hesaplanan vergiyle
    // sınırlıdır; sınırsız olsaydı bordro çalışana vergi ÖDERDİ.
    const r = calculate({ grossSalary: 20_000, period: jan, cumulativeBase: 0 });
    expect(r.incomeTax).toBeGreaterThanOrEqual(0);
    expect(r.stampDuty).toBeGreaterThanOrEqual(0);
  });

  it("İSTİSNA SABİT DEĞİL — yıl içinde büyür", () => {
    /*
     * Asgari ücretlinin kümülatif matrahı da dilim atlar; istisna
     * sabit tutulsaydı yılın ikinci yarısında eksik kalır ve
     * herkesten fazla vergi kesilirdi.
     */
    const ocak = minimumWageTaxFor(0, P);
    const aralik = minimumWageTaxFor(11, P);
    expect(aralik.incomeTax).toBeGreaterThan(ocak.incomeTax);
  });

  it("istisnasız bordroda vergi kesilir", () => {
    const withExemption = calculate({ grossSalary: 33_030, period: jan, cumulativeBase: 0 });
    const without = calculate({
      grossSalary: 33_030,
      period: jan,
      cumulativeBase: 0,
      minimumWageExemption: false,
    });
    expect(withExemption.incomeTax).toBe(0);
    expect(without.incomeTax).toBeGreaterThan(0);
    expect(without.netSalary).toBeLessThan(withExemption.netSalary);
  });
});

describe("işveren maliyeti", () => {
  it("brütün üzerine SGK ve işsizlik işveren payı eklenir", () => {
    /*
     * TOPLAM, YUVARLANMIŞ SATIRLARIN TOPLAMIDIR — ham çarpımların
     * toplamının yuvarlanması DEĞİL. Aradaki bir kuruşluk fark
     * önemsiz görünür ama bordro pusulasında satırlar alt alta yazılır
     * ve toplam onlarla uyuşmazsa muhasebeci her ay elle kontrol
     * etmek zorunda kalır.
     */
    const r = calculate({ grossSalary: 33_030, period: jan, cumulativeBase: 0 });
    // round2 dışarıda: 33.030 + 6.853,73 + 660,60 ikili kayan noktada
    // 40544.329999999994 verir ve bordro rakamı iki hane olmalıdır.
    expect(r.employerCost).toBe(
      round2(33_030 + r.employerSgk + r.employerUnemployment),
    );
  });

  it("BORDRO PUSULASI KENDİ İÇİNDE TUTARLIDIR", () => {
    // Net = brüt − kesintiler ve kesintiler = satırların toplamı.
    for (const gross of [33_030, 60_000, 120_000, 400_000]) {
      const r = calculate({ grossSalary: gross, period: jan, cumulativeBase: 0 });
      expect(r.totalDeductions).toBe(
        round2(r.employeeSgk + r.employeeUnemployment + r.incomeTax + r.stampDuty),
      );
      expect(r.netSalary).toBe(round2(r.totalGross - r.totalDeductions));
      expect(r.employerCost).toBe(
        round2(r.totalGross + r.employerSgk + r.employerUnemployment),
      );
    }
  });

  it("İŞVEREN ORANI TEYİDE MUHTAÇ OLARAK İŞARETLENİR", () => {
    // Oran teşvike ve tehlike sınıfına göre gerçekten değişir;
    // kesinmiş gibi sunmak yanlış bir maliyet rakamı üretir.
    const r = calculate({ grossSalary: 33_030, period: jan, cumulativeBase: 0 });
    expect(r.caveats.some((c) => c.includes("İşveren SGK oranı"))).toBe(true);
  });
});

describe("ek kazanç", () => {
  it("prim SGK ve vergiye tabidir", () => {
    const base = calculate({ grossSalary: 60_000, period: jan, cumulativeBase: 0 });
    const withBonus = calculate({
      grossSalary: 60_000,
      period: jan,
      cumulativeBase: 0,
      bonus: 40_000,
    });
    expect(withBonus.totalGross).toBe(100_000);
    expect(withBonus.employeeSgk).toBeGreaterThan(base.employeeSgk);
    expect(withBonus.incomeTax).toBeGreaterThan(base.incomeTax);
  });
});

describe("parametreler", () => {
  it("TANIMSIZ YIL İÇİN HESAP YAPILMAZ", () => {
    // Geçen yılın oranlarıyla bu yılın bordrosunu üretmek, sessizce
    // yanlış maaş ödemektir.
    expect(() => parametersFor(new Date(Date.UTC(2030, 0, 1)))).toThrow(
      PayrollParameterError,
    );
  });

  it("2026 parametreleri bulunur", () => {
    expect(parametersFor(jan).year).toBe(2026);
  });

  it("her parametrenin KAYNAĞI yazılıdır", () => {
    const params = [
      P.minimumWage, P.sgkFloor, P.sgkCeiling, P.employeeSgkRate,
      P.employeeUnemploymentRate, P.employerSgkRate, P.employerUnemploymentRate,
      P.stampDutyRate, P.brackets, P.severanceCap,
    ];
    for (const p of params) {
      expect(p.source.length).toBeGreaterThan(15);
      expect(["resmi", "teyit_gerekli"]).toContain(p.confidence);
    }
  });
});

describe("geçersiz girdi", () => {
  it("negatif brüt reddedilir", () => {
    expect(() => calculate({ grossSalary: -1, period: jan, cumulativeBase: 0 })).toThrow(
      PayrollError,
    );
  });
  it("negatif kümülatif matrah reddedilir", () => {
    expect(() =>
      calculate({ grossSalary: 50_000, period: jan, cumulativeBase: -1 }),
    ).toThrow(PayrollError);
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

describe("asgari ücret altı brüt", () => {
  /**
   * DUMAN TESTİNDE ÇIKTI. `plan_annual_payroll` düşük bir brütle
   * çağrıldığında "Kümülatif matrah negatif olamaz" diyerek çöküyordu:
   * SGK primi TABAN üzerinden hesaplandığı için kesinti brütü aşıyor,
   * matrah eksiye düşüyor ve bir sonraki aya taşınıyordu.
   */
  it("VERGİ MATRAHI NEGATİFE DÜŞMEZ", () => {
    const r = calculate({ grossSalary: 1_000, period: jan, cumulativeBase: 0 });
    expect(r.taxBase).toBe(0);
    expect(r.incomeTax).toBe(0);
  });

  it("YILLIK PLAN DÜŞÜK BRÜTTE ÇÖKMEZ", () => {
    // Eksi matrah kümülatife taşınıyordu ve ikinci ay patlıyordu.
    expect(() => annualPlan(1_000, 2026)).not.toThrow();
    const plan = annualPlan(1_000, 2026);
    expect(plan).toHaveLength(12);
    expect(plan.every((m) => m.cumulativeBaseAfter >= 0)).toBe(true);
  });

  it("SGK PRİMİ YİNE TABAN ÜZERİNDEN KESİLİR", () => {
    // Matrahın sıfırlanması primi değiştirmez: prim tabana bağlıdır.
    const r = calculate({ grossSalary: 1_000, period: jan, cumulativeBase: 0 });
    expect(r.sgkBase).toBe(PARAMETERS_2026.sgkFloor.value);
    expect(r.employeeSgk).toBeGreaterThan(0);
  });
});
