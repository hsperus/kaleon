/**
 * Antet — belgenin kime ait olduğunu söyleyen blok.
 *
 * NEDEN ŞİRKET ADI YETMİYOR: bu belgeler dışarı çıkıyor. Mali
 * müşavire, tedarikçiye, bankaya, vergi dairesine. Üzerinde yalnızca
 * "ULS Group" yazan bir tablo, alan kişi için kaynağı belirsiz bir
 * kâğıttır — hangi tüzel kişilik, hangi vergi dairesi, hangi numara?
 *
 * TÜRKİYE'DE TİCARİ BELGENİN TAŞIDIĞI ASGARİ KİMLİK bellidir: ticari
 * unvan, adres, vergi dairesi ve numarası. Ticaret sicil ve Mersis
 * numarası ticari yazışmada zorunludur (TTK 39). Bunlar profilde
 * varsa basılır; YOKSA UYDURULMAZ ve satır hiç görünmez — boş bir
 * "Vergi No: —" satırı, bilgi eksikliğini gizlemek yerine belgeyi
 * yarım gösterir.
 */

export interface Letterhead {
  readonly legalName: string;
  readonly taxOffice: string | null;
  readonly taxId: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly mersisNo: string | null;
  readonly tradeRegistryNo: string | null;
}

/** Boş metin null'dır: "" ile "bilinmiyor" aynı şey değil ama girdide öyle gelir. */
function bos(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  return t.length === 0 ? null : t;
}

/**
 * Profil satırından antet üretir.
 *
 * Adres tek satıra iner: açık adres, ilçe, şehir, posta kodu. Belgede
 * dört ayrı satır kaplaması, antedin kendisini içerikten daha uzun
 * yapardı.
 */
export function letterheadFrom(
  profile: {
    legalName: string;
    taxOffice: string | null;
    taxId: string | null;
    addressLine: string | null;
    district: string | null;
    city: string | null;
    postalCode: string | null;
    phone: string | null;
    email: string | null;
    mersisNo: string | null;
    tradeRegistryNo: string | null;
  } | null,
  fallbackName: string,
): Letterhead {
  if (!profile) {
    // Profil hiç kurulmamış olabilir (yeni kiracı). Ad yine de yazılır;
    // gerisi boş kalır ve belge "kimliği eksik" olduğunu kendisi gösterir.
    return {
      legalName: fallbackName,
      taxOffice: null,
      taxId: null,
      address: null,
      phone: null,
      email: null,
      mersisNo: null,
      tradeRegistryNo: null,
    };
  }

  const adres = [
    bos(profile.addressLine),
    [bos(profile.district), bos(profile.city)].filter(Boolean).join("/"),
    bos(profile.postalCode),
  ]
    .filter((p) => p && p.length > 0)
    .join(" · ");

  return {
    legalName: bos(profile.legalName) ?? fallbackName,
    taxOffice: bos(profile.taxOffice),
    taxId: bos(profile.taxId),
    address: adres.length > 0 ? adres : null,
    phone: bos(profile.phone),
    email: bos(profile.email),
    mersisNo: bos(profile.mersisNo),
    tradeRegistryNo: bos(profile.tradeRegistryNo),
  };
}

/**
 * Antedin tek satırlık hukuki dipnotu.
 *
 * Sayfa altına basılır. Vergi dairesi ve numara burada TEKRAR eder:
 * belge çok sayfalıysa ve yalnızca ikinci sayfa fotokopilenirse,
 * o sayfa da kime ait olduğunu söylemelidir.
 */
export function legalFooter(l: Letterhead): string {
  const parcalar = [
    l.legalName,
    l.taxOffice && l.taxId ? `${l.taxOffice} V.D. ${l.taxId}` : (l.taxId ?? null),
    l.tradeRegistryNo ? `Tic. Sic. No: ${l.tradeRegistryNo}` : null,
    l.mersisNo ? `Mersis: ${l.mersisNo}` : null,
  ].filter((p): p is string => Boolean(p));
  return parcalar.join(" · ");
}
