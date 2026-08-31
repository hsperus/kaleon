/**
 * Kullanıcı rehberinin RAKAMLARI.
 *
 * NEDEN AYRI BİR DOSYADA VE NEDEN TESTLİ:
 *
 * Bu projede tanıtım sayfalarındaki tool sayıları üç kez eskidi ve
 * her seferinde elle düzeltildi. Rehber çok daha uzun ve çok daha çok
 * rakam içeriyor; aynı yöntemle yazılırsa altı ay içinde tamamı
 * yanlış olur — ve YANLIŞ BİR REHBER, HİÇ REHBER OLMAMASINDAN
 * KÖTÜDÜR: kullanıcı ona güvenerek karar verir.
 *
 * Rakamlar burada TEK YERDE duruyor ve bir test onları canlı
 * registry ile karşılaştırıyor. Yeni bir tool eklendiğinde test
 * düşer ve rehberi güncellemeyi hatırlatır.
 */

/** Rehberde geçen sayılar. `tests/guide-facts.test.ts` doğruluyor. */
export const GUIDE_FACTS = {
  /** Kayıtlı tool sayısı. */
  totalTools: 197,
  /** Okuyan tool sayısı (L0). */
  readTools: 111,
  /** Yazan tool sayısı (L1+) — hepsi onay kapısından geçer. */
  writeTools: 86,
  /** Şema göçü sayısı. */
  migrations: 40,
  /** Rol sayısı. */
  roles: 7,
  /** Rol başına görünen tool sayısı. */
  byRole: {
    patron: 197,
    cfo: 119,
    uretim_muduru: 99,
    satin_alma: 64,
    depo_sorumlusu: 52,
    ik_muduru: 38,
    operator: 17,
  },
} as const;

export type RoleKey = keyof typeof GUIDE_FACTS.byRole;
