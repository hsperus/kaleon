/**
 * Yüklenen dosya deposu — Postgres adaptörü.
 *
 * NEDEN VERİTABANI, NEDEN BELLEK DEĞİL:
 * Süreç belleğindeki bir depo, yüklemeyi alan sunucu ile soruyu alan
 * sunucunun aynı olmasını varsayar. Bu varsayım iki yerde kırılır ve
 * ikincisi tarayıcı testinde GERÇEKTEN yaşandı:
 *   - çok örnekli üretimde yükleme A'ya, soru B'ye gider;
 *   - geliştirmede modül yeniden yüklendiğinde depo sıfırlanır —
 *     yükleme "başarılı" der, önizleme "dosya bulunamadı" der.
 *
 * KALICI DEĞİL, SÜRELİ. Süresi geçmiş kayıt okunmaz ve fırsat buldukça
 * silinir. Yüklenen dosya henüz KAELON'un verisi değildir; kullanıcı
 * önizlemeyi görüp vazgeçebilir ve onaylanmamış müşteri verisini süresiz
 * tutmak KVKK açısından savunulamaz.
 *
 * TENANT SINIRI BAĞLANTIDA: her tenant kendi şemasına yazar, bu yüzden
 * "başka tenant'ın dosyası" diye bir durum oluşamaz — sorgu onu görmez.
 */

import type { TenantDb } from "./client.js";
import { UPLOAD_TTL_MS } from "../modules/import/uploads.js";

export class PrismaUploadStore {
  readonly #db: TenantDb;
  readonly #now: () => Date;

  constructor(db: TenantDb, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async put(input: {
    filename: string;
    content: string;
    userId: string;
  }): Promise<string> {
    const row = await this.#db.fileUpload.create({
      data: {
        userId: input.userId,
        filename: input.filename,
        content: input.content,
        byteSize: Buffer.byteLength(input.content, "utf8"),
        expiresAt: new Date(this.#now().getTime() + UPLOAD_TTL_MS),
      },
      select: { id: true },
    });

    // Temizlik yazma anında yapılır: ayrı bir zamanlanmış iş kurmak, bu
    // kadar basit bir bakım için gereksiz altyapı olurdu.
    await this.#purgeExpired();
    return row.id;
  }

  async get(uploadId: string, _tenantId: string): Promise<{ filename: string; content: string } | null> {
    const row = await this.#db.fileUpload.findUnique({
      where: { id: uploadId },
      select: { filename: true, content: true, expiresAt: true },
    });
    if (!row) return null;
    // Süresi geçmişse YOKMUŞ GİBİ davran; silinmesini beklemeye gerek yok.
    if (row.expiresAt <= this.#now()) return null;
    return { filename: row.filename, content: row.content };
  }

  async #purgeExpired(): Promise<void> {
    await this.#db.fileUpload
      .deleteMany({ where: { expiresAt: { lt: this.#now() } } })
      .catch(() => undefined);
  }
}
