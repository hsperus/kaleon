/**
 * Kaynak uyarılarının cevaba taşınması.
 *
 * Bir veri kaynağı "3 siparişin tarihi bilinmiyor" dediğinde, bu bilgi
 * tool'un cevabında GÖRÜNMELİDİR. Görünmezse kullanıcı 2 riskli sipariş
 * okur ve 3 tanesine hiç bakılmadığını asla öğrenmez — sistem ona eksik
 * bir tabloyu tam tablo gibi göstermiş olur.
 *
 * GÜVEN DE DÜŞER. Eksik veriyle verilen cevap, tam veriyle verilen cevapla
 * aynı güveni taşıyamaz. Güven puanı bunu yansıtmazsa, puan süs olur.
 */

export interface CaveatRisk {
  readonly severity: "warning";
  readonly message: string;
}

export function caveatRisks(caveats: readonly string[] | undefined): readonly CaveatRisk[] {
  if (!caveats || caveats.length === 0) return [];
  return caveats.map((message) => ({ severity: "warning" as const, message }));
}

/** Eksik veri varsa güveni düşür — alt sınır 40, sıfıra indirmek anlamsız. */
export function confidenceWithCaveats(base: number, caveats: readonly string[] | undefined): number {
  if (!caveats || caveats.length === 0) return base;
  return Math.max(40, base - 20 * caveats.length);
}
