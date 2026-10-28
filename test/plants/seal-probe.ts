// Run in a child by test/seal.test.ts: seal, probe every route, then prove the allowed paths still work.
//   node --permission --allow-fs-read=* --allow-net test/plants/seal-probe.ts <leak url> <database url> [pg lookalike file]
import { requireProcessPermission, sealNetwork } from "../../packages/core/src/seal.ts";

sealNetwork();
// Imported after the seal, like a tool folder: what the probe takes at its own load is the stub.
const { probeRoutes } = await import("./probe.ts");
const report = await probeRoutes(process.argv[2]!, process.argv[4]);
// The Postgres client is imported after the seal too, so its own loads of net, tls and dns go through the hook under the pg allowance.
const { connect } = await import("../../packages/core/src/db.ts");
let postgres: string;
try {
  const db = connect(process.argv[3]!);
  postgres = String((await db.query<{ one: number }>("select 1 as one")).rows[0]!.one);
  await db.end();
} catch (err) {
  postgres = `error: ${err instanceof Error ? err.message : String(err)}`;
}
const fs = await import("node:fs");
console.log(JSON.stringify({ ...report, denied: requireProcessPermission(), postgres, fs: typeof fs.readFileSync }));
