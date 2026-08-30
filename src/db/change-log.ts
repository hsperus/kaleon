/**
 * Değişiklik belgesinde AKTÖRÜ taşıyan oturum değişkeni.
 *
 * Değişikliğin KENDİSİ veritabanı tetikleyicisiyle yakalanır ve hiçbir kod
 * yolu onu atlayamaz. Ama tetikleyici uygulamanın kullanıcısını bilemez;
 * bu yüzden yazma işlemi, işlem başında kullanıcı kimliğini oturum
 * değişkenine koyar.
 *
 * DEĞİŞKEN KURULMAZSA KAYIT YİNE OLUŞUR, aktör null kalır. Bu bilinçli:
 * "kim yaptığı bilinmiyor" demek, sessizce bir kullanıcıya yazmaktan
 * iyidir. Doğrudan SQL ile yapılan bir düzeltme de böyle görünür ve
 * denetimde ayırt edilebilir.
 *
 * `SET LOCAL` KULLANILIR: değer yalnızca o işlem boyunca yaşar. Oturum
 * genelinde kalsaydı, havuzdan gelen bir sonraki bağlantı önceki
 * kullanıcının kimliğiyle yazardı — havuzlu bir sunucuda bu, yanlış
 * kişiye iz bırakmak demektir.
 */

import type { Prisma } from "./generated/tenant/index.js";
import type { TenantDb } from "./client.js";

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** İşlem içinde aktörü kurar. UUID olmayan değer sessizce atlanır. */
export async function setChangeActor(tx: Tx, userId: string | null | undefined): Promise<void> {
  if (!userId || !UUID.test(userId)) return;
  // Parametre olarak geçirilir: kullanıcı kimliği doğrudan SQL'e
  // gömülseydi enjeksiyon yüzeyi açılırdı.
  await tx.$executeRaw`SELECT set_config('kaelon.user_id', ${userId}, true)`;
}

export interface ChangeEntry {
  readonly objectType: string;
  readonly objectCode: string | null;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly operation: string;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

/** İnsan tarafından okunmayacak teknik alanlar — cevaba taşınmaz. */
const HIDDEN_FIELDS = new Set(["id", "tenant_id"]);

export class ChangeLogRepository {
  readonly #db: TenantDb;

  constructor(db: TenantDb) {
    this.#db = db;
  }

  /** Bir kaydın değişiklik geçmişi — en yeni başta. */
  async historyOf(
    objectType: string,
    objectCode: string,
    limit = 50,
  ): Promise<readonly ChangeEntry[]> {
    const rows = await this.#db.masterDataChange.findMany({
      where: { objectType, objectCode },
      orderBy: { seq: "desc" },
      take: Math.min(limit, 200),
    });

    return rows
      .filter((r) => !HIDDEN_FIELDS.has(r.field))
      .map((r) => ({
        objectType: r.objectType,
        objectCode: r.objectCode,
        field: r.field,
        oldValue: r.oldValue,
        newValue: r.newValue,
        operation: r.operation,
        changedBy: r.changedBy,
        changedAt: r.changedAt.toISOString(),
      }));
  }

  /** Belirli bir alanın değişim geçmişi — "bu fiyat neden değişmiş". */
  async fieldHistory(
    objectType: string,
    objectCode: string,
    field: string,
  ): Promise<readonly ChangeEntry[]> {
    const rows = await this.#db.masterDataChange.findMany({
      where: { objectType, objectCode, field },
      orderBy: { seq: "desc" },
      take: 100,
    });
    return rows.map((r) => ({
      objectType: r.objectType,
      objectCode: r.objectCode,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      operation: r.operation,
      changedBy: r.changedBy,
      changedAt: r.changedAt.toISOString(),
    }));
  }

  /** Bir dönemde yapılan tüm ana veri değişiklikleri. */
  async recent(from: Date, to: Date, limit = 100) {
    const rows = await this.#db.masterDataChange.findMany({
      where: { changedAt: { gte: from, lte: to }, operation: "update" },
      orderBy: { seq: "desc" },
      take: Math.min(limit, 500),
    });
    return rows
      .filter((r) => !HIDDEN_FIELDS.has(r.field))
      .map((r) => ({
        objectType: r.objectType,
        objectCode: r.objectCode,
        field: r.field,
        oldValue: r.oldValue,
        newValue: r.newValue,
        changedBy: r.changedBy,
        changedAt: r.changedAt.toISOString(),
      }));
  }

  /**
   * Aktörü bilinmeyen değişiklikler.
   *
   * Bunlar doğrudan SQL ile ya da oturum değişkenini kurmayan bir kod
   * yolundan gelmiştir. SIFIR OLMASI BEKLENMEZ ama SAYISININ BİLİNMESİ
   * gerekir: artıyorsa bir yerde iz bırakmayan bir yazma yolu vardır.
   */
  async unattributed(from: Date, to: Date): Promise<number> {
    return this.#db.masterDataChange.count({
      where: { changedAt: { gte: from, lte: to }, changedBy: null },
    });
  }
}
