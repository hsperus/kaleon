/**
 * Operations repository portu.
 *
 * KRİTİK TASARIM KARARI: değişmezler burada, KİLİT ALTINDA uygulanır.
 *
 * Naif yaklaşım şudur: tool bakiyeyi okur, yeterli mi diye bakar, sonra
 * hareketi yazar. Bu, kitap gibi bir yarış hatasıdır — iki operatör aynı anda
 * son 10 adedi sarf ederse ikisi de "yeterli" görür, ikisi de yazar ve stok
 * −10'a düşer. Negatif stok değişmezi, oku-ve-yaz arasındaki boşluktan sızar.
 *
 * Bu yüzden mutasyon repository'nin içindedir: yükle → alan mantığını uygula →
 * kaydet, hepsi tek atomik işlem olarak. Bellek adaptöründe anahtar başına
 * kuyruk, Prisma adaptöründe `SELECT ... FOR UPDATE` içeren transaction.
 * Tool katmanı bu ayrıntıyı bilmez ve yanlış yapamaz.
 */

import type { AuthorityLevel } from "../../kernel/types.js";
import type { PostMovementInput, StockMovement } from "./stock-ledger.js";
import { balanceOf, postMovement, type StockKey } from "./stock-ledger.js";
import type { WorkOrder } from "./work-order.js";

export interface WorkOrderFilter {
  readonly status?: WorkOrder["status"];
  readonly workCenter?: string;
}

export interface OperationsRepository {
  getWorkOrder(tenantId: string, id: string): Promise<WorkOrder | null>;
  listWorkOrders(tenantId: string, filter: WorkOrderFilter): Promise<readonly WorkOrder[]>;
  /**
   * İş emrini atomik olarak dönüştürür. `mutate` saf alan fonksiyonudur;
   * fırlattığı hata kaydı değiştirmeden yukarı çıkar.
   */
  mutateWorkOrder(
    tenantId: string,
    id: string,
    mutate: (wo: WorkOrder) => WorkOrder,
  ): Promise<WorkOrder>;
  saveWorkOrder(tenantId: string, wo: WorkOrder): Promise<void>;

  /** Ürünün o anki aktif BOM revizyonu. */
  activeBomRevision(tenantId: string, itemId: string): Promise<string>;

  balance(tenantId: string, key: StockKey): Promise<number>;
  movements(tenantId: string, key: Partial<StockKey>): Promise<readonly StockMovement[]>;
  /** Hareketi kilit altında doğrular ve yazar. Negatif stok burada engellenir. */
  postMovement(
    tenantId: string,
    input: PostMovementInput,
    opts: { authority: AuthorityLevel },
  ): Promise<StockMovement>;
}

/** Anahtar başına sıralı kuyruk — bellek adaptöründeki kilit. */
class KeyedMutex {
  readonly #chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Zincir hatayı yutmamalı ama sıradakini de bloklamamalı.
    this.#chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

export class InMemoryOperationsRepository implements OperationsRepository {
  readonly #workOrders = new Map<string, WorkOrder>();
  readonly #ledger: StockMovement[] = [];
  readonly #bomRevisions = new Map<string, string>();
  readonly #mutex = new KeyedMutex();
  #sequence = 0;

  constructor(seed?: { workOrders?: readonly WorkOrder[]; bomRevisions?: Record<string, string> }) {
    for (const wo of seed?.workOrders ?? []) this.#workOrders.set(wo.id, wo);
    for (const [item, rev] of Object.entries(seed?.bomRevisions ?? {})) {
      this.#bomRevisions.set(item, rev);
    }
  }

  async getWorkOrder(_tenantId: string, id: string): Promise<WorkOrder | null> {
    return this.#workOrders.get(id) ?? null;
  }

  async listWorkOrders(_tenantId: string, filter: WorkOrderFilter): Promise<readonly WorkOrder[]> {
    return [...this.#workOrders.values()]
      .filter((wo) => (filter.status ? wo.status === filter.status : true))
      .filter((wo) =>
        filter.workCenter ? wo.operations.some((o) => o.workCenter === filter.workCenter) : true,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async saveWorkOrder(_tenantId: string, wo: WorkOrder): Promise<void> {
    this.#workOrders.set(wo.id, wo);
  }

  async mutateWorkOrder(
    tenantId: string,
    id: string,
    mutate: (wo: WorkOrder) => WorkOrder,
  ): Promise<WorkOrder> {
    return this.#mutex.run(`wo:${tenantId}:${id}`, async () => {
      const current = this.#workOrders.get(id);
      if (!current) throw new Error(`İş emri bulunamadı: ${id}`);
      const next = mutate(current);
      this.#workOrders.set(id, next);
      return next;
    });
  }

  async activeBomRevision(_tenantId: string, itemId: string): Promise<string> {
    return this.#bomRevisions.get(itemId) ?? "R1";
  }

  async balance(_tenantId: string, key: StockKey): Promise<number> {
    return balanceOf(this.#ledger, key);
  }

  async movements(_tenantId: string, key: Partial<StockKey>): Promise<readonly StockMovement[]> {
    return this.#ledger.filter(
      (m) =>
        (key.itemId === undefined || m.itemId === key.itemId) &&
        (key.locationId === undefined || m.locationId === key.locationId) &&
        (key.batchId === undefined || m.batchId === key.batchId),
    );
  }

  async postMovement(
    tenantId: string,
    input: PostMovementInput,
    opts: { authority: AuthorityLevel },
  ): Promise<StockMovement> {
    // Kilit anahtarı stok anahtarıdır: aynı kalem+lokasyon+parti üzerindeki
    // hareketler sıraya girer, farklı kalemler paralel akar.
    const lockKey = `stock:${tenantId}:${input.itemId}|${input.locationId}|${input.batchId ?? ""}`;
    return this.#mutex.run(lockKey, async () => {
      const withId: PostMovementInput = {
        ...input,
        id: input.id || `mov-${++this.#sequence}`,
      };
      const next = postMovement(this.#ledger, withId, opts);
      const created = next[next.length - 1]!;
      this.#ledger.length = 0;
      this.#ledger.push(...next);
      return created;
    });
  }

  /** Test kolaylığı — defterin tamamı. */
  get ledger(): readonly StockMovement[] {
    return this.#ledger;
  }
}
