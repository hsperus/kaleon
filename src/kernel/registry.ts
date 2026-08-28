/**
 * Tool registry.
 *
 * İki görevi var ve ikisi de önbellek/güvenlik açısından kritiktir:
 *
 *  1. **Deterministik sıralama.** Anthropic prompt önbelleği önek eşleşmesidir;
 *     tool listesinin sırası değişirse önek bozulur ve önbellek sessizce ıskalar.
 *     Registry her zaman ada göre sıralı, donmuş bir katalog üretir.
 *
 *  2. **Rol filtresi.** Kullanıcının izni olmayan tool modele hiç gönderilmez.
 *     Bu hem güvenlik sınırı hem token tasarrufudur.
 */

import type { Permission, Principal } from "./types.js";
import type { AnthropicToolSchema, Tool } from "./tool.js";
import { missingPermissions } from "./rbac.js";

export interface ToolCatalog {
  /** Her isteğe konan çekirdek tool'lar (deferLoading: false). */
  readonly core: readonly AnthropicToolSchema[];
  /** Tool arama ile bulunacaklar (defer_loading: true). */
  readonly deferred: readonly AnthropicToolSchema[];
  /** core + deferred, deterministik sırada. */
  readonly all: readonly AnthropicToolSchema[];
  /** Bu principal için görünür tool adları. */
  readonly names: readonly string[];
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool<never, unknown>>();

  register(...tools: readonly Tool<never, unknown>[]): this {
    for (const t of tools) {
      if (this.#tools.has(t.name)) {
        throw new Error(`Tool adı çakışması: "${t.name}" zaten kayıtlı.`);
      }
      this.#tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): Tool<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  /** Tüm tool'lar, ada göre sıralı. */
  all(): readonly Tool<never, unknown>[] {
    return [...this.#tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Principal'ın çağırabileceği tool'lar — izin VE yetki tavanı süzgeci. */
  visibleTo(principal: Principal): readonly Tool<never, unknown>[] {
    return this.all().filter(
      (t) =>
        t.authority <= principal.maxAuthority &&
        missingPermissions(principal, t.requires).length === 0,
    );
  }

  /**
   * Modele gönderilecek katalog.
   * Sıra deterministiktir; aynı principal için aynı çıktıyı verir.
   */
  catalogFor(principal: Principal): ToolCatalog {
    const visible = this.visibleTo(principal);
    const core = visible.filter((t) => !t.deferLoading).map((t) => t.schema);
    const deferred = visible.filter((t) => t.deferLoading).map((t) => t.schema);
    return Object.freeze({
      core: Object.freeze(core),
      deferred: Object.freeze(deferred),
      all: Object.freeze([...core, ...deferred]),
      names: Object.freeze(visible.map((t) => t.name)),
    });
  }

  /** Bir tool için karşılanmayan izinler — hata mesajı üretmek için. */
  missingFor(principal: Principal, toolName: string): readonly Permission[] {
    const tool = this.#tools.get(toolName);
    if (!tool) return [];
    return missingPermissions(principal, tool.requires);
  }
}
