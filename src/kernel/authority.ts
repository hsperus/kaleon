/**
 * Yetki merdiveni (L0–L3) ve L4 sınırı.
 *
 * L4 işlemleri — resmî beyanname gönderimi, ödeme talimatı, kullanıcı yetki
 * yükseltme, audit silme, resmî kurum bildirimi — KAELON'da **tool olarak
 * tanımlanamaz**. `AuthorityLevel` tipi 4'ü içermediği için bir L4 tool'u
 * derleme zamanında reddedilir.
 *
 * Bu dosya o sınırı hem tipte hem de çalışma zamanında kayıt altına alır:
 * `L4_FORBIDDEN` listesi dokümante edilmiş yasak eylemlerdir ve
 * `assertNotL4()` bir tool adının bu eylemleri ima edip etmediğini kayıt
 * anında denetler — yanlışlıkla `send_vat_declaration` gibi bir tool
 * yazılmasını erkenden yakalamak için.
 */

import type { AuthorityLevel, Principal } from "./types.js";
import { AuthorityExceededError } from "./errors.js";

export const MAX_AUTHORITY: AuthorityLevel = 3;

/**
 * Hiçbir koşulda tool'a dönüşemeyecek eylemler.
 * Bunlar yetkili insan + entegratör üzerinden yürür.
 */
export const L4_FORBIDDEN = [
  "resmî beyanname gönderimi (GİB, e-Defter, e-Beyan)",
  "banka ödeme talimatı gönderimi",
  "kullanıcı yetki yükseltme",
  "audit log silme veya değiştirme",
  "resmî kurum bildirimi (SGK, gümrük)",
  "müşteri/tedarikçi sözleşmesi imzalama",
] as const;

/** Tool adında L4 sinyali arayan yasak fiil/nesne çiftleri. */
const L4_NAME_SIGNALS: readonly (readonly [RegExp, string])[] = [
  [/^(send|submit|file|transmit)_.*(declaration|beyanname|beyan|edefter|ebeyan)/, "resmî beyanname gönderimi"],
  [/^(send|execute|issue|release)_.*(payment|odeme|transfer|remittance)/, "ödeme talimatı"],
  [/(grant|elevate|escalate)_.*(permission|role|authority|yetki)/, "yetki yükseltme"],
  [/(delete|purge|rewrite|amend)_.*(audit|log)/, "audit müdahalesi"],
  [/^sign_.*(contract|agreement|sozlesme)/, "sözleşme imzalama"],
];

/**
 * Bir tool adının L4 sınırını ihlal edip etmediğini denetler.
 * Registry kayıt anında çağırır; ihlal derleme değil kayıt hatasıdır.
 */
export function assertNotL4(toolName: string): void {
  for (const [pattern, label] of L4_NAME_SIGNALS) {
    if (pattern.test(toolName)) {
      throw new Error(
        `L4 sınırı: "${toolName}" ${label} anlamına geliyor. ` +
          `Bu eylem tool olarak tanımlanamaz — KAELON hazırlar, yetkili insan ve ` +
          `entegratör gönderir. Taslak üreten bir L1 tool'u yazın (örn. draft_${toolName}).`,
      );
    }
  }
}

/** Principal'ın tavanı tool'un gerektirdiği seviyeyi karşılıyor mu? */
export function assertAuthority(
  toolName: string,
  required: AuthorityLevel,
  principal: Principal,
): void {
  if (required > principal.maxAuthority) {
    throw new AuthorityExceededError(toolName, required, principal.maxAuthority);
  }
}

/** Rol bazlı varsayılan yetki tavanları. */
export const ROLE_AUTHORITY_CEILING: Record<string, AuthorityLevel> = {
  patron: 3,
  cfo: 3,
  ik_muduru: 2,
  uretim_muduru: 2,
  satin_alma: 2,
  depo_sorumlusu: 1,
  operator: 1,
};
