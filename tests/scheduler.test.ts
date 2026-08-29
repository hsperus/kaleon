/**
 * Zamanlayıcı testleri.
 *
 * Zamanlama mantığı Redis'ten bağımsızdır ve bu yüzden test edilebilir.
 * En kritik davranış çakışma önleme: 15 dakikada bir çalışan ama 20 dakika
 * süren bir senkron, kendini ezmemeli.
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessScheduler, SYNC_SCHEDULE } from "../src/modules/integration/scheduler.js";

const noSleep = async () => {};

describe("zamanlayıcı", () => {
  it("işi çalıştırır ve geçmişe yazar", async () => {
    const s = new InProcessScheduler({ sleep: noSleep });
    const run = vi.fn(async () => {});
    s.register({ name: "einvoice", everyMs: 1000, run });

    const r = await s.runNow("einvoice");
    expect(run).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    expect(s.history).toHaveLength(1);
  });

  it("ÇAKIŞMA ÖNLEME: koşarken ikinci koşu başlamaz", async () => {
    const s = new InProcessScheduler({ sleep: noSleep });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const run = vi.fn(async () => {
      await gate;
    });
    s.register({ name: "einvoice", everyMs: 1000, run });

    const first = s.runNow("einvoice");
    const second = await s.runNow("einvoice"); // birincisi sürerken

    expect(second.ok).toBe(false);
    expect(second.error).toContain("hâlâ devam ediyor");
    expect(run).toHaveBeenCalledOnce();

    release();
    await first;
    expect(run).toHaveBeenCalledOnce();
  });

  it("bittikten sonra tekrar çalışabilir", async () => {
    const s = new InProcessScheduler({ sleep: noSleep });
    const run = vi.fn(async () => {});
    s.register({ name: "j", everyMs: 1000, run });
    await s.runNow("j");
    await s.runNow("j");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("hata geçmişe yazılır ama zamanlayıcıyı düşürmez", async () => {
    const s = new InProcessScheduler({ sleep: noSleep });
    s.register({
      name: "patlayan",
      everyMs: 1000,
      run: async () => {
        throw new Error("entegratör kapalı");
      },
    });
    const r = await s.runNow("patlayan");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("entegratör kapalı");
    // Zamanlayıcı ayakta, tekrar çalıştırılabilir
    await expect(s.runNow("patlayan")).resolves.toMatchObject({ ok: false });
  });

  it("yeniden deneme üstel geri çekilmeyle çalışır", async () => {
    const sleep = vi.fn(async () => {});
    const s = new InProcessScheduler({ sleep });
    let calls = 0;
    s.register({
      name: "flaky",
      everyMs: 1000,
      maxRetries: 3,
      retryDelayMs: 100,
      run: async () => {
        calls++;
        if (calls < 3) throw new Error("geçici");
      },
    });
    const r = await s.runNow("flaky");
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("tüm denemeler tükenirse başarısız döner", async () => {
    const s = new InProcessScheduler({ sleep: noSleep });
    let calls = 0;
    s.register({
      name: "hep-patlar",
      everyMs: 1000,
      maxRetries: 2,
      run: async () => {
        calls++;
        throw new Error("kalıcı");
      },
    });
    const r = await s.runNow("hep-patlar");
    expect(r.ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("aynı isimde iki iş kaydedilemez", () => {
    const s = new InProcessScheduler();
    s.register({ name: "a", everyMs: 1000, run: async () => {} });
    expect(() => s.register({ name: "a", everyMs: 1000, run: async () => {} })).toThrow(/çakışması/);
  });

  it("tanımsız iş çalıştırılamaz", async () => {
    const s = new InProcessScheduler();
    await expect(s.runNow("yok")).rejects.toThrow(/Tanımsız iş/);
  });

  it("start/stop zamanlayıcıları yönetir", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const s = new InProcessScheduler({ sleep: noSleep });
    s.register({ name: "tick", everyMs: 100, run });
    s.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(3);
    s.stop();
    const after = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(run.mock.calls.length).toBe(after);
    vi.useRealTimers();
  });

  it("senkron periyotları verinin değişme hızına göre", () => {
    expect(SYNC_SCHEDULE.einvoice).toBeLessThan(SYNC_SCHEDULE.bank);
    expect(SYNC_SCHEDULE.bank).toBeLessThan(SYNC_SCHEDULE.attendance);
  });
});
