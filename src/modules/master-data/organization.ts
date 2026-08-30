/**
 * Organizasyon yapısı — tesis, depo ve depo yeri.
 *
 * BİR TENANT = BİR ŞİRKET VARSAYIMI ÇOK TESİSLİ MÜŞTERİYİ DIŞARIDA
 * BIRAKIR. Bursa'da döküm, Kocaeli'de montaj yapan bir imalatçı için
 * "stok 4.200 adet" cümlesi hiçbir işe yaramaz: hangi tesiste olduğu
 * sorusunun cevabı yoksa, mal bir tesiste birikirken diğeri durur.
 *
 * ÜÇ KADEME, ÜÇ FARKLI SORU:
 *   TESİS (plant)          — üretim ve maliyet burada oluşur
 *   DEPO (warehouse)       — stok bakiyesi burada tutulur
 *   DEPO YERİ (storage)    — malın fiziksel yeri; sayımda buraya bakılır
 * Kademeler karıştırılırsa "depoda 500 var ama bulamıyoruz" durumu doğar.
 *
 * KADEME ATLANAMAZ. Bir depo yerinin üstünde depo, deponun üstünde tesis
 * olmalıdır; aksi hâlde tesis bazlı toplama bazı stoklar hiç girmez ve
 * toplam sessizce eksik çıkar.
 */

export const LOCATION_KINDS = ["plant", "warehouse", "storage_location"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export class OrganizationError extends Error {
  readonly code = "organization";
  constructor(message: string) {
    super(message);
    this.name = "OrganizationError";
  }
}

export interface LocationNode {
  readonly code: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly parentCode: string | null;
  readonly isActive: boolean;
}

/** Hangi kademe hangi kademenin altında olabilir. */
const ALLOWED_PARENT: Readonly<Record<LocationKind, readonly LocationKind[]>> = {
  plant: [],
  warehouse: ["plant"],
  storage_location: ["warehouse"],
};

/**
 * Hiyerarşi kuralını doğrular.
 *
 * KADEME ATLAMAK EN SİNSİ HATA: doğrudan tesise bağlanmış bir depo yeri,
 * depo bazlı raporlarda hiç görünmez ve orada duran mal yokmuş sayılır.
 */
export function assertHierarchy(
  kind: LocationKind,
  parent: LocationNode | null,
): void {
  const allowed = ALLOWED_PARENT[kind];

  if (allowed.length === 0) {
    if (parent !== null) {
      throw new OrganizationError(
        `Tesis en üst kademedir; "${parent.code}" altına bağlanamaz.`,
      );
    }
    return;
  }

  if (parent === null) {
    throw new OrganizationError(
      `${label(kind)} bir ${allowed.map(label).join(" veya ")} altında olmalıdır. ` +
        `Bağlantısız bir kayıt, üst kademe raporlarında hiç görünmez ve orada duran ` +
        `mal yokmuş sayılır.`,
    );
  }

  if (!allowed.includes(parent.kind)) {
    throw new OrganizationError(
      `${label(kind)} bir ${label(parent.kind)} altına bağlanamaz; ` +
        `${allowed.map(label).join(" veya ")} altında olmalıdır. Kademe atlamak, ` +
        `ara kademe raporlarını sessizce eksik bırakır.`,
    );
  }
}

export function label(kind: LocationKind): string {
  switch (kind) {
    case "plant":
      return "Tesis";
    case "warehouse":
      return "Depo";
    default:
      return "Depo yeri";
  }
}

/**
 * Bir düğümün tesisini bulur — hiyerarşiyi yukarı yürüyerek.
 *
 * Maliyet ve üretim tesis bazındadır; bir depo yerindeki hareketin hangi
 * tesise ait olduğu bilinmezse tesis kârlılığı hesaplanamaz.
 */
export function plantOf(
  code: string,
  nodes: ReadonlyMap<string, LocationNode>,
  maxDepth = 10,
): string | null {
  let current = nodes.get(code);
  let depth = 0;

  while (current && depth < maxDepth) {
    if (current.kind === "plant") return current.code;
    if (current.parentCode === null) return null;
    current = nodes.get(current.parentCode);
    depth += 1;
  }

  if (depth >= maxDepth) {
    throw new OrganizationError(
      `"${code}" için tesis bulunurken ${maxDepth} kademe aşıldı; hiyerarşide ` +
        `DÖNGÜ var. Bir lokasyon kendi üstü olamaz.`,
    );
  }
  return null;
}

/** Bir tesisin altındaki tüm depo ve depo yerleri. */
export function descendantsOf(
  plantCode: string,
  nodes: ReadonlyMap<string, LocationNode>,
): readonly string[] {
  const out: string[] = [];
  const byParent = new Map<string, LocationNode[]>();
  for (const n of nodes.values()) {
    if (!n.parentCode) continue;
    const list = byParent.get(n.parentCode) ?? [];
    list.push(n);
    byParent.set(n.parentCode, list);
  }

  const walk = (code: string, depth: number): void => {
    if (depth > 10) return;
    for (const child of byParent.get(code) ?? []) {
      out.push(child.code);
      walk(child.code, depth + 1);
    }
  };
  walk(plantCode, 0);
  return out;
}

/**
 * Bağlantısız (yetim) lokasyonlar.
 *
 * BU LİSTE BOŞ OLMALIDIR. Dolu olması, o lokasyondaki stoğun tesis
 * raporlarında hiç görünmediği anlamına gelir — ve eksik olduğu ancak
 * envanter sayımında anlaşılır.
 */
export function orphans(nodes: ReadonlyMap<string, LocationNode>): readonly string[] {
  const out: string[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "plant") continue;
    if (!n.parentCode || !nodes.has(n.parentCode)) {
      out.push(n.code);
      continue;
    }
    if (plantOf(n.code, nodes) === null) out.push(n.code);
  }
  return out;
}
