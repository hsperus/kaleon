/**
 * Bakım işleri — veritabanına dokunur, bu yüzden AYRI DOSYADA.
 *
 * `instrumentation.ts` hem Node hem edge için derlendiğinden, oradan
 * Prisma'ya uzanan bir import zinciri uygulamayı hiç açılmaz hâle getirir.
 * Bu dosya yalnızca istek yolundan (Node) çağrılır.
 *
 * SÜRESİ DOLMUŞ OTURUMLAR HİÇ SİLİNMİYORDU. `pruneExpiredSessions` yazılmış
 * ama çağrılmıyordu: tablo sonsuza kadar büyür ve KVKK açısından gereksiz
 * kişisel veri saklanır.
 *
 * ÇOK ÖRNEKLİ KURULUMDA her örnek aynı temizliği yapar; sorun değil, iş
 * idempotenttir — ikinci örnek silinecek satır bulamaz.
 */

import { disconnectAll, sharedClient } from "../db/client.js";
import { PrismaAuthStore } from "../db/auth-store.js";
import { log } from "./log.js";
import { onShutdown } from "./lifecycle.js";

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

let started = false;

/** Süresi dolmuş oturumları siler. Dönen sayı silinen satırdır. */
export async function runMaintenance(now: Date = new Date()): Promise<{ prunedSessions: number }> {
  const prunedSessions = await new PrismaAuthStore(sharedClient()).pruneExpiredSessions(now);
  if (prunedSessions > 0) {
    log.info("bakım: süresi dolmuş oturumlar silindi", { prunedSessions });
  }
  return { prunedSessions };
}

/** İlk istekte bir kez başlar. Tekrar çağrılması zararsızdır. */
export function startMaintenance(): void {
  if (started) return;
  started = true;

  onShutdown(disconnectAll);

  const timer = setInterval(() => {
    void runMaintenance().catch((e) => {
      // Bakım hatası isteği etkilemez; sessiz kalmak da doğru değil.
      log.error("bakım işi başarısız", { error: (e as Error).message });
    });
  }, MAINTENANCE_INTERVAL_MS);
  // Bakım tiki sürecin kapanmasını geciktirmemeli.
  timer.unref?.();

  // Uzun süre kapalı kalmış bir kurulumda birikmiş oturumlar bir sonraki
  // tiki beklememeli.
  void runMaintenance().catch(() => undefined);
}
