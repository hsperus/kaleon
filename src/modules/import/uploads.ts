/**
 * Yüklenen dosyaların geçici deposu.
 *
 * DOSYA VERİTABANINA YAZILMAZ, BELLEKTE VE SÜRELİ TUTULUR.
 *
 * Sebep: yüklenen dosya henüz KAELON'un verisi değildir. Kullanıcı yükler,
 * önizlemeyi görür, vazgeçebilir. Kalıcı olarak saklamak, hiç onaylanmamış
 * müşteri verisini süresiz tutmak demektir — KVKK açısından savunulamaz.
 * Onaylanan içerik zaten kanonik tablolara yazılır ve orada kalır.
 *
 * ÜÇ SINIR:
 *   1. BOYUT — çok büyük dosya belleği doldurur.
 *   2. SÜRE — yüklenip unutulan dosya sonsuza kadar durmaz.
 *   3. TENANT — bir tenant'ın dosyası başka tenant'tan okunamaz. Yükleme
 *      kimliği tahmin edilemez olsa da, "kimliği bilen okuyabilir" bir
 *      yetkilendirme değildir.
 */

export interface StoredUpload {
  readonly filename: string;
  readonly content: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

/** Tek dosya için üst sınır — 5 MB yaklaşık 40 bin satır cari listesi. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Yüklenen dosya bu süre sonunda silinir. */
export const UPLOAD_TTL_MS = 30 * 60 * 1000;

export class InMemoryUploadStore {
  readonly #items = new Map<string, StoredUpload>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  put(input: {
    filename: string;
    content: string;
    tenantId: string;
    userId: string;
  }): string {
    this.#sweep();
    const id = crypto.randomUUID();
    this.#items.set(id, { ...input, expiresAt: this.#now() + UPLOAD_TTL_MS });
    return id;
  }

  async get(uploadId: string, tenantId: string): Promise<{ filename: string; content: string } | null> {
    const item = this.#items.get(uploadId);
    if (!item) return null;
    // Süresi dolmuşsa yokmuş gibi davran ve temizle.
    if (item.expiresAt <= this.#now()) {
      this.#items.delete(uploadId);
      return null;
    }
    // TENANT SINIRI: kimliği bilmek yetki değildir.
    if (item.tenantId !== tenantId) return null;
    return { filename: item.filename, content: item.content };
  }

  #sweep(): void {
    const t = this.#now();
    for (const [id, item] of this.#items) {
      if (item.expiresAt <= t) this.#items.delete(id);
    }
  }

  get size(): number {
    return this.#items.size;
  }
}
