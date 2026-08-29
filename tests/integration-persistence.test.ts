/**
 * Entegrasyon kalıcılığı — gerçek Postgres'e karşı.
 *
 * En önemli iddia: dönüşüm patladığında HAM VERİ VERİTABANINDA KALIR.
 * Bellek adaptörü bunu "mantık doğru" diye gösterir; burada gerçekten
 * satırın orada durduğu doğrulanır.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient as SharedPrisma } from "../src/db/generated/shared/index.js";
import { PrismaClient as TenantPrisma } from "../src/db/generated/tenant/index.js";
import { dropTenantSchema, provisionTenantSchema } from "../src/db/provision.js";
import { urlForSchema } from "../src/db/client.js";
import { PrismaIntegrationStore } from "../src/db/integration-store.js";
import { runSync } from "../src/modules/integration/pipeline.js";
import { UyumsoftInvoiceAdapter, type UyumsoftTransport } from "../src/modules/integration/adapters/uyumsoft.js";
import type { FetchWindow } from "../src/modules/integration/adapter.js";

const SHARED_URL = process.env["SHARED_DATABASE_URL"];
const TENANT_URL = process.env["TENANT_DATABASE_URL"];
const enabled = Boolean(SHARED_URL && TENANT_URL);
const SCHEMA = "tenant_it_intg";
const WINDOW: FetchWindow = { since: "2026-05-01", until: "2026-05-31" };

function ubl(over: Record<string, unknown> = {}) {
  return {
    UUID: `u-${(over["ID"] as string) ?? "1"}`,
    ID: "BRC-4892",
    IssueDate: "2026-05-15",
    DocumentCurrencyCode: "TRY",
    AccountingSupplierParty: {
      PartyIdentification: { ID: "1234567890" },
      PartyName: { Name: "Burçelik" },
    },
    InvoiceLine: [
      {
        ID: 1,
        InvoicedQuantity: 200,
        Item: { SellersItemIdentification: { ID: "DINGIL-22310" } },
        Price: { PriceAmount: 1870 },
        OrderLineReference: { OrderReference: { ID: "PO-118" }, LineID: 1 },
      },
    ],
    ...over,
  };
}

function transport(docs: unknown[]): UyumsoftTransport {
  return {
    authenticate: async () => {},
    list: async () =>
      docs.map((d) => ({
        id: (d as { ID: string }).ID,
        receivedAt: "2026-05-16T08:00:00.000Z",
        document: d,
      })),
  };
}

describe.skipIf(!enabled)("entegrasyon kalıcılığı", () => {
  let shared: SharedPrisma;
  let db: TenantPrisma;
  let store: PrismaIntegrationStore;

  beforeAll(async () => {
    shared = new SharedPrisma();
    await dropTenantSchema(shared, SCHEMA);
    await provisionTenantSchema(shared, SCHEMA);
    db = new TenantPrisma({ datasources: { db: { url: urlForSchema(TENANT_URL!, SCHEMA) } } });
    store = new PrismaIntegrationStore(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (shared) {
      await dropTenantSchema(shared, SCHEMA);
      await shared.$disconnect();
    }
  });

  beforeEach(async () => {
    await db.integrationError.deleteMany();
    await db.invoiceLine.deleteMany();
    await db.invoice.deleteMany();
    await db.rawPayload.deleteMany();
    await db.syncRun.deleteMany();
  });

  it("geçerli belge: ham + kanonik yazılır ve BAĞLANIR", async () => {
    const s = await runSync(new UyumsoftInvoiceAdapter(transport([ubl()])), store, { window: WINDOW });
    expect(s).toMatchObject({ status: "success", created: 1 });

    const raw = await db.rawPayload.findFirstOrThrow();
    const inv = await db.invoice.findFirstOrThrow({ include: { lines: true } });

    expect(raw.status).toBe("transformed");
    expect(inv.documentNo).toBe("BRC-4892");
    // KAYNAK ZİNCİRİ: kanonik kayıt ham belgeye bağlı
    expect(inv.rawPayloadId).toBe(raw.id);
    expect(inv.lines[0]?.itemId).toBe("DINGIL-22310");
    // Ham veri DEĞİŞTİRİLMEDEN saklanmış
    expect((raw.payload as { ID: string }).ID).toBe("BRC-4892");
  });

  it("DÖNÜŞÜM PATLADIĞINDA HAM VERİ VERİTABANINDA KALIR", async () => {
    const bozuk = ubl({ DocumentCurrencyCode: undefined });
    const s = await runSync(new UyumsoftInvoiceAdapter(transport([bozuk])), store, { window: WINDOW });
    expect(s.failed).toBe(1);

    const raw = await db.rawPayload.findFirstOrThrow();
    expect(raw.status).toBe("failed");
    expect(await db.invoice.count()).toBe(0);

    const err = await db.integrationError.findFirstOrThrow();
    expect(err.code).toBe("missing_currency");
    expect(err.stage).toBe("normalize");
    expect(err.rawPayloadId).toBe(raw.id);
  });

  it("düzeltilmiş dönüştürücü ham veriden yeniden üretebilir", async () => {
    // 1) Bozuk gelir, ham saklanır
    await runSync(new UyumsoftInvoiceAdapter(transport([ubl({ DocumentCurrencyCode: undefined })])), store, { window: WINDOW });
    expect(await db.invoice.count()).toBe(0);
    const raw = await db.rawPayload.findFirstOrThrow();

    // 2) Ham veri elde olduğu için dönüşüm yeniden denenebilir —
    //    entegratöre tekrar sormaya gerek yok.
    const adapter = new UyumsoftInvoiceAdapter(transport([]));
    const retry = adapter.normalize({
      externalId: raw.externalId,
      receivedAt: raw.receivedAt.toISOString(),
      payload: { ...(raw.payload as object), DocumentCurrencyCode: "TRY" },
    });
    expect(retry.ok).toBe(true);
  });

  it("IDEMPOTENCY: ikinci koşu yeni kayıt üretmez", async () => {
    const adapter = new UyumsoftInvoiceAdapter(transport([ubl()]));
    await runSync(adapter, store, { window: WINDOW });
    const second = await runSync(adapter, store, { window: WINDOW });

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(await db.rawPayload.count()).toBe(1);
    expect(await db.invoice.count()).toBe(1);
  });

  it("EŞZAMANLI iki senkron koşusu belgeyi çoğaltmaz", async () => {
    const adapter = new UyumsoftInvoiceAdapter(transport([ubl()]));
    await Promise.allSettled([
      runSync(adapter, store, { window: WINDOW }),
      runSync(adapter, store, { window: WINDOW }),
    ]);
    expect(await db.rawPayload.count()).toBe(1);
    expect(await db.invoice.count()).toBe(1);
  });

  it("senkron koşusu kayda geçer", async () => {
    await runSync(new UyumsoftInvoiceAdapter(transport([ubl(), ubl({ ID: "BRC-4893" })])), store, { window: WINDOW });
    const run = await db.syncRun.findFirstOrThrow();
    expect(run.status).toBe("success");
    expect(run.fetched).toBe(2);
    expect(run.created).toBe(2);
    expect(run.finishedAt).not.toBeNull();
  });

  it("açık hatalar insan incelemesi için listelenir", async () => {
    await runSync(
      new UyumsoftInvoiceAdapter(transport([ubl({ ID: "A", DocumentCurrencyCode: undefined })])),
      store,
      { window: WINDOW },
    );
    const open = await store.openErrors();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ code: "missing_currency", source: "uyumsoft", externalId: "A" });
  });

  it("bir bozuk belge diğerini engellemez — veritabanında da", async () => {
    await runSync(
      new UyumsoftInvoiceAdapter(
        transport([ubl({ ID: "A" }), ubl({ ID: "B", DocumentCurrencyCode: undefined }), ubl({ ID: "C" })]),
      ),
      store,
      { window: WINDOW },
    );
    expect(await db.rawPayload.count()).toBe(3);
    expect(await db.invoice.count()).toBe(2);
    expect(await db.integrationError.count()).toBe(1);
  });
});
