/**
 * Duman testinin kör noktası.
 *
 * `smoke.ts` depoları ELLE bağlıyor. Yeni bir depo eklendiğinde oraya
 * eklenmezse, o depoya bağlı tool'lar kayda hiç girmez ve duman testi
 * "hepsi çalışıyor" der — oysa bakmadığı yerler vardır.
 *
 * GERÇEKTEN OLDU: kur değerlemesi, kadro ve içe aktarma tool'ları
 * eklendiğinde smoke.ts güncellenmedi. Yedi tool sınanmadan duruyordu
 * ve bunlardan üçü kullanıcının en çok kullanacağı veri girişi yoluydu.
 *
 * Bu test kaynak dosyaları karşılaştırıyor: `Repositories` içinde
 * tanımlı her isteğe bağlı bağımlılık, smoke.ts içinde de geçmeli.
 * Kaba bir kontrol ama tam da o hatayı yakalıyor — ve kaçırılması
 * imkânsız, çünkü test paketiyle birlikte koşuyor.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/app.ts", "utf8");
const smoke = readFileSync("src/scripts/smoke.ts", "utf8");

/** `Repositories` içindeki isteğe bağlı bağımlılık adları. */
function optionalDeps(): readonly string[] {
  const bas = app.indexOf("export interface Repositories");
  const son = app.indexOf("export function buildRegistry");
  // Sınır bulunamazsa boş dizi döner ve aşağıdaki ikinci test bunu
  // yakalar — sessizce geçen bir kontrol, hiç olmayandan kötüdür.
  if (bas < 0 || son < 0 || son <= bas) return [];
  return [...app.slice(bas, son).matchAll(/readonly (\w+)\?:/g)].map((m) => m[1]!);
}

describe("duman testi kapsamı", () => {
  it("Repositories içindeki her bağımlılık smoke.ts'te de bağlanır", () => {
    /*
     * İKİ YAZIM DA GEÇERLİ: `audit: x` ve kısayol `audit,`. İlk
     * yazımda yalnızca iki noktalı biçimi arıyordum ve kısayolla
     * bağlanmış iki depoyu "eksik" sandı — kontrolün kendisi yanlış
     * alarm veriyordu.
     */
    const eksik = optionalDeps().filter(
      (d) => !new RegExp(`\\b${d}\\s*[:,]`).test(smoke),
    );
    expect(
      eksik,
      `smoke.ts şu bağımlılıkları bağlamıyor: ${eksik.join(", ")}. ` +
        `Bağlanmayan her depo, tool'larını duman testinin dışında bırakır.`,
    ).toEqual([]);
  });

  it("kontrol edilecek bağımlılık gerçekten bulunuyor — test boşa koşmasın", () => {
    // Ayrıştırma bozulursa liste boşalır ve test hep geçer; o sessiz
    // başarı, kontrolün hiç olmamasından kötüdür.
    expect(optionalDeps().length).toBeGreaterThan(15);
    expect(optionalDeps()).toContain("journal");
  });
});
