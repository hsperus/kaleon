/**
 * Entegrasyon katmanı testleri.
 *
 * En önemli iddia: HAM VERİ KANONİK DÖNÜŞÜMDEN ÖNCE SAKLANIR. Dönüşüm
 * patlasa bile kanıt duruyor. Klasik entegrasyonlarda hata anında elde
 * hiçbir şey kalmaz ve "entegratör ne gönderdi" sorusu cevapsız kalır.
 */

import { describe, expect, it, vi } from "vitest";
import {
  IntegrationError,
  checksum,
  type FetchWindow,
  type RawDocument,
} from "../src/modules/integration/adapter.js";
import { runSync, type IntegrationStore, type StoredRaw } from "../src/modules/integration/pipeline.js";
import {
  UyumsoftInvoiceAdapter,
  classifyHttp,
  type UyumsoftTransport,
} from "../src/modules/integration/adapters/uyumsoft.js";

const WINDOW: FetchWindow = { since: "2026-05-01", until: "2026-05-31" };

function ublInvoice(over: Record<string, unknown> = {}) {
  return {
    UUID: "u-1",
    ID: "BRC-2026-4892",
    IssueDate: "2026-05-15",
    DocumentCurrencyCode: "TRY",
    AccountingSupplierParty: {
      PartyIdentification: { ID: "1234567890", schemeID: "VKN" },
      PartyName: { Name: "Burçelik Bursa Çelik Döküm Sanayi A.Ş." },
    },
    InvoiceLine: [
      {
        ID: 1,
        InvoicedQuantity: 200,
        Item: { SellersItemIdentification: { ID: "DINGIL-22310" } },
        Price: { PriceAmount: 1870, currencyID: "TRY" },
        OrderLineReference: { OrderReference: { ID: "PO-118" }, LineID: 1 },
      },
    ],
    ...over,
  };
}

/** Bellekte çalışan store — boru hattının değişmezlerini gözlemlemek için. */
class MemoryStore implements IntegrationStore {
  readonly raws = new Map<string, StoredRaw & { payload: unknown }>();
  readonly canonicals: { rawId: string; value: unknown }[] = [];
  readonly errors: { rawPayloadId: string; stage: string; code: string }[] = [];
  readonly runs: { id: string; status?: string }[] = [];
  /** Kanonik yazımı bilerek patlatmak için. */
  failCanonical = false;

  async putRaw(i: {
    source: string;
    kind: string;
    externalId: string;
    receivedAt: string;
    payload: unknown;
    checksum: string;
  }) {
    const key = `${i.source}:${i.externalId}`;
    const existing = this.raws.get(key);
    if (existing) return { raw: existing, alreadyExisted: true };
    const raw = {
      id: `raw-${this.raws.size + 1}`,
      source: i.source,
      externalId: i.externalId,
      checksum: i.checksum,
      status: "pending" as const,
      payload: i.payload,
    };
    this.raws.set(key, raw);
    return { raw, alreadyExisted: false };
  }
  async markRawStatus(id: string, status: "transformed" | "failed") {
    for (const [k, v] of this.raws) this.raws.set(k, v.id === id ? { ...v, status } : v);
  }
  async recordError(i: { rawPayloadId: string; stage: string; code: string; message: string; at: string }) {
    this.errors.push({ rawPayloadId: i.rawPayloadId, stage: i.stage, code: i.code });
  }
  async writeCanonical(rawId: string, value: unknown) {
    if (this.failCanonical) throw new Error("kanonik yazım hatası");
    if (this.canonicals.some((c) => c.rawId === rawId)) return false;
    this.canonicals.push({ rawId, value });
    return true;
  }
  async startRun(i: { source: string; kind: string; startedAt: string }) {
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ id });
    return id;
  }
  async finishRun(id: string, i: { status: string }) {
    const r = this.runs.find((x) => x.id === id)!;
    r.status = i.status;
  }
}

function transport(docs: unknown[], hooks: Partial<UyumsoftTransport> = {}): UyumsoftTransport {
  return {
    authenticate: hooks.authenticate ?? (async () => {}),
    list:
      hooks.list ??
      (async () =>
        docs.map((d, i) => ({
          id: (d as { ID?: string }).ID ?? `doc-${i}`,
          receivedAt: "2026-05-16T08:00:00.000Z",
          document: d,
        }))),
  };
}

// ─────────────────────── dönüştürücü ───────────────────────

describe("UBL dönüştürücü — eksiği fark etmek asıl iş", () => {
  const adapter = new UyumsoftInvoiceAdapter(transport([]));
  const raw = (payload: unknown): RawDocument => ({
    externalId: "x",
    receivedAt: "2026-05-16T08:00:00.000Z",
    payload,
  });

  it("geçerli belgeyi kanonik modele çevirir", () => {
    const r = adapter.normalize(raw(ublInvoice()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.documentNo).toBe("BRC-2026-4892");
      expect(r.value.partnerId).toBe("1234567890");
      expect(r.value.lines[0]).toMatchObject({
        itemId: "DINGIL-22310",
        quantity: 200,
        unitPrice: 1870,
        poId: "PO-118",
        poLineNo: 1,
      });
    }
  });

  it("Türk sayı biçimini (1.870,50) doğru okur", () => {
    const r = adapter.normalize(
      raw(
        ublInvoice({
          InvoiceLine: [
            {
              ID: 1,
              InvoicedQuantity: "200",
              Item: { SellersItemIdentification: { ID: "X" } },
              Price: { PriceAmount: "1.870,50" },
            },
          ],
        }),
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0]?.unitPrice).toBe(1870.5);
  });

  it("PARA BİRİMİ YOKSA varsayılan UYDURMAZ", () => {
    const r = adapter.normalize(raw(ublInvoice({ DocumentCurrencyCode: undefined })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_currency");
  });

  it("sipariş referansı yoksa null bırakır — eşleştirme bloklasın diye", () => {
    const r = adapter.normalize(
      raw(
        ublInvoice({
          InvoiceLine: [
            {
              ID: 1,
              InvoicedQuantity: 5,
              Item: { SellersItemIdentification: { ID: "X" } },
              Price: { PriceAmount: 100 },
            },
          ],
        }),
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines[0]?.poId).toBeNull();
      expect(r.value.lines[0]?.poLineNo).toBeNull();
    }
  });

  it("eksik alanlar açık hata kodu üretir", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ID: undefined }, "missing_document_no"],
      [{ AccountingSupplierParty: {} }, "missing_supplier"],
      [{ IssueDate: "bozuk" }, "invalid_issue_date"],
      [{ InvoiceLine: [] }, "no_lines"],
    ];
    for (const [over, code] of cases) {
      const r = adapter.normalize(raw(ublInvoice(over)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(code);
    }
  });

  it("kalem seviyesi hatalar da yakalanır", () => {
    const bad = (line: unknown) => adapter.normalize(raw(ublInvoice({ InvoiceLine: [line] })));
    expect(bad({ ID: 1, InvoicedQuantity: 0, Item: { SellersItemIdentification: { ID: "X" } }, Price: { PriceAmount: 1 } })).toMatchObject({ code: "invalid_quantity" });
    expect(bad({ ID: 1, InvoicedQuantity: 1, Item: { SellersItemIdentification: { ID: "X" } }, Price: {} })).toMatchObject({ code: "invalid_price" });
    expect(bad({ ID: 1, InvoicedQuantity: 1, Item: {}, Price: { PriceAmount: 1 } })).toMatchObject({ code: "missing_item" });
  });

  it("gövde nesne değilse çökmez", () => {
    expect(adapter.normalize(raw(null))).toMatchObject({ code: "payload_not_object" });
    expect(adapter.normalize(raw("metin"))).toMatchObject({ code: "payload_not_object" });
  });
});

// ─────────────────────── boru hattı ───────────────────────

describe("boru hattı — ham veri önce", () => {
  it("geçerli belge: ham saklanır, kanonik yazılır", async () => {
    const store = new MemoryStore();
    const s = await runSync(new UyumsoftInvoiceAdapter(transport([ublInvoice()])), store, { window: WINDOW });
    expect(s).toMatchObject({ status: "success", fetched: 1, created: 1, failed: 0 });
    expect(store.raws.size).toBe(1);
    expect(store.canonicals).toHaveLength(1);
    expect([...store.raws.values()][0]?.status).toBe("transformed");
  });

  it("DÖNÜŞÜM PATLASA BİLE HAM VERİ DURUYOR", async () => {
    const store = new MemoryStore();
    const bozuk = ublInvoice({ DocumentCurrencyCode: undefined });
    const s = await runSync(new UyumsoftInvoiceAdapter(transport([bozuk])), store, { window: WINDOW });

    expect(s.failed).toBe(1);
    expect(s.created).toBe(0);
    // Kanıt duruyor:
    expect(store.raws.size).toBe(1);
    expect([...store.raws.values()][0]?.payload).toEqual(bozuk);
    expect([...store.raws.values()][0]?.status).toBe("failed");
    // Kanonik kayıt oluşmadı:
    expect(store.canonicals).toHaveLength(0);
    // İnsanın inceleyeceği hata kaydı var:
    expect(store.errors[0]).toMatchObject({ stage: "normalize", code: "missing_currency" });
  });

  it("BİR BOZUK BELGE DİĞERLERİNİ DURDURMAZ", async () => {
    const store = new MemoryStore();
    const docs = [
      ublInvoice({ ID: "A-1" }),
      ublInvoice({ ID: "A-2", DocumentCurrencyCode: undefined }),
      ublInvoice({ ID: "A-3" }),
    ];
    const s = await runSync(new UyumsoftInvoiceAdapter(transport(docs)), store, { window: WINDOW });
    expect(s).toMatchObject({ status: "partial", fetched: 3, created: 2, failed: 1 });
    expect(store.canonicals).toHaveLength(2);
  });

  it("IDEMPOTENCY: aynı belge iki kez işlenmez", async () => {
    const store = new MemoryStore();
    const adapter = new UyumsoftInvoiceAdapter(transport([ublInvoice()]));
    await runSync(adapter, store, { window: WINDOW });
    const second = await runSync(adapter, store, { window: WINDOW });
    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(store.canonicals).toHaveLength(1);
    expect(store.raws.size).toBe(1);
  });

  it("kanonik yazım hatası da ham veriyi korur", async () => {
    const store = new MemoryStore();
    store.failCanonical = true;
    const s = await runSync(new UyumsoftInvoiceAdapter(transport([ublInvoice()])), store, { window: WINDOW });
    expect(s.failed).toBe(1);
    expect(store.raws.size).toBe(1);
    expect(store.errors[0]?.stage).toBe("canonical_write");
  });
});

describe("hata sınıflandırması ve retry", () => {
  it("AUTH hatası tekrar DENENMEZ — kilitlenmeye yol açar", async () => {
    const store = new MemoryStore();
    const authenticate = vi.fn(async () => {
      throw classifyHttp(401, "");
    });
    const s = await runSync(
      new UyumsoftInvoiceAdapter(transport([], { authenticate })),
      store,
      { window: WINDOW, sleep: async () => {} },
    );
    expect(s.status).toBe("failed");
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("AĞ hatası üstel geri çekilmeyle tekrar denenir", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const list = vi.fn(async () => {
      calls++;
      if (calls < 3) throw classifyHttp(503, "");
      return [{ id: "A-1", receivedAt: "2026-05-16T08:00:00.000Z", document: ublInvoice() }];
    });
    const s = await runSync(
      new UyumsoftInvoiceAdapter(transport([], { list })),
      store,
      { window: WINDOW, sleep: async () => {}, maxRetries: 3 },
    );
    expect(calls).toBe(3);
    expect(s.created).toBe(1);
  });

  it("VERİ hatası tekrar denenmez", async () => {
    const store = new MemoryStore();
    const list = vi.fn(async () => {
      throw classifyHttp(400, "geçersiz istek");
    });
    await runSync(new UyumsoftInvoiceAdapter(transport([], { list })), store, {
      window: WINDOW,
      sleep: async () => {},
    });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("HTTP durumları doğru sınıflandırılır", () => {
    expect(classifyHttp(401, "").classification).toBe("auth");
    expect(classifyHttp(403, "").classification).toBe("auth");
    expect(classifyHttp(429, "").classification).toBe("network");
    expect(classifyHttp(503, "").classification).toBe("network");
    expect(classifyHttp(422, "").classification).toBe("data");
    expect(classifyHttp(429, "").retryable).toBe(true);
    expect(classifyHttp(401, "").retryable).toBe(false);
  });

  it("normalize içinde beklenmeyen hata akışı düşürmez", async () => {
    const store = new MemoryStore();
    const adapter = new UyumsoftInvoiceAdapter(transport([ublInvoice({ ID: "A-1" }), ublInvoice({ ID: "A-2" })]));
    let first = true;
    const original = adapter.normalize.bind(adapter);
    adapter.normalize = (raw) => {
      if (first) {
        first = false;
        throw new Error("beklenmeyen");
      }
      return original(raw);
    };
    const s = await runSync(adapter, store, { window: WINDOW });
    expect(s).toMatchObject({ failed: 1, created: 1 });
    expect(store.errors[0]?.code).toBe("normalize_threw");
  });
});

describe("checksum", () => {
  it("aynı içerik aynı parmak izini üretir", () => {
    expect(checksum({ a: 1, b: 2 })).toBe(checksum({ a: 1, b: 2 }));
  });
  it("değişen içerik farklı parmak izi üretir", () => {
    expect(checksum({ a: 1 })).not.toBe(checksum({ a: 2 }));
  });
});

describe("IntegrationError", () => {
  it("yalnızca ağ hataları retryable", () => {
    expect(new IntegrationError("x", "network", "c").retryable).toBe(true);
    expect(new IntegrationError("x", "auth", "c").retryable).toBe(false);
    expect(new IntegrationError("x", "data", "c").retryable).toBe(false);
  });
});
