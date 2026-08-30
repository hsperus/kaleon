import { sharedClient, tenantClient, disconnectAll } from "../src/db/client.js";
(async () => {
  const t = await sharedClient().tenant.findUnique({ where: { slug: "demo" } });
  const db = tenantClient(t!.schemaName);
  const rows = await db.watch.findMany({ select: { name: true, tool: true, path: true, operator: true, threshold: true } });
  console.log("izleme sayısı:", rows.length);
  for (const r of rows) console.log("  ", JSON.stringify(r));
  await disconnectAll();
})();
