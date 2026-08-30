/**
 * Test yardımcısı: hazırla → onayla.
 *
 * Üretimde her yazma tool'u insan onayından geçer. Testlerin bu adımı
 * atlayabilmesi, kapının kapalı olduğunu doğrulayan `confirmation.test.ts`
 * dışındaki her dosyada gürültü olurdu — ama ATLAMAK da yanlış olurdu:
 * o zaman testler üretimde çalışmayan bir yolu doğrulardı.
 *
 * Bu yardımcı ONAYLAYAN BİR KULLANICIYI TAKLİT EDER: tool onay isterse
 * formu olduğu gibi kabul edip gönderir. Yani testler gerçek akıştan
 * geçer, yalnızca "kullanıcı düğmeye bastı" adımı otomatiktir.
 */

import { confirmPendingAction, invokeTool, type InvokeOptions } from "../../src/kernel/invoke.js";
import { InMemoryPendingStore } from "../../src/db/pending-store.js";
import { isConfirmationRequired } from "../../src/kernel/pending.js";

/**
 * Tool'u çağırır; onay gerekiyorsa kullanıcı adına onaylar.
 *
 * `pending` verilmezse her çağrı için taze bir bellek deposu kurulur.
 */
export async function invokeConfirmed(
  toolName: string,
  input: unknown,
  opts: Omit<InvokeOptions, "pending"> & { pending?: InvokeOptions["pending"] },
): Promise<Awaited<ReturnType<typeof invokeTool>>> {
  const pending = opts.pending ?? new InMemoryPendingStore();
  const full = { ...opts, pending };

  const first = await invokeTool(toolName, input, full);
  if (!isConfirmationRequired(first.outcome)) return first;

  const pendingId = (first.outcome as unknown as { pendingId: string }).pendingId;
  return confirmPendingAction(pendingId, undefined, full);
}
