import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendAudit, auditRecorder, loadAudit, verifyAudit } from "../packages/core/src/audit.ts";
import { DEFAULT_POLICY, Labelled } from "../packages/core/src/dataclass.ts";
import { createGateway, Prompt, type ExactModelId } from "../packages/core/src/gateway.ts";
import type { SnapshotId } from "../packages/core/src/hash.ts";
import { createPayloadStore } from "../packages/core/src/record.ts";
import { freshDatabase } from "./db.ts";
import { startFakeModel } from "./fake-model.ts";

const { db } = await freshDatabase("labh_test_audit");
const hosted = await startFakeModel("hosted-2", "answer");
after(async () => {
  await hosted.close();
  await db.end();
});
const store = createPayloadStore(db, { placement: "lab", policy: DEFAULT_POLICY, key: randomBytes(32), keyId: "k1" });

test("a refused out-of-run gateway call lands in the audit stream, and no request leaves", async () => {
  const gateway = createGateway([{ id: "hosted", baseUrl: hosted.url, placement: "zdr", supportsLogprobs: false }], DEFAULT_POLICY, fetch);
  const rec = auditRecorder(db, store, "kb-compiler", { t: "kb-compile", job: "j1", kbId: "kb", step: { t: "source", sourceId: "s1" } });
  const prompt = Prompt.of([{ role: "user", content: Labelled.stamp("participant P-12345", "D3", "test") }], []);
  const out = await gateway.complete({ endpointId: "hosted", modelId: "hosted-2" as ExactModelId, params: { temperature: 0, maxOutputTokens: 8 } }, prompt, rec, { signal: new AbortController().signal, step: 1, attempt: 1, final: false });
  assert.equal(out.ok, false);
  assert.equal(hosted.requests, 0);
  const rows = await loadAudit(db);
  assert.deepEqual(
    rows.map((r) => r.event),
    [
      {
        t: "call",
        context: { t: "kb-compile", job: "j1", kbId: "kb", step: { t: "source", sourceId: "s1" } },
        event: { t: "egress.refused", destination: "model:hosted", payload: "D3", refusal: { code: "class-above-ceiling", payload: "D3", ceiling: "D1" } },
      },
    ],
  );
});

test("concurrent appends form one unbroken chain, and an edited row breaks it", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => appendAudit(db, `writer-${i % 3}`, { t: "kb.published", kbId: `kb-${i}`, snapshot: "s".repeat(64) as SnapshotId })));
  const rows = await loadAudit(db);
  assert.equal(rows.length, 13);
  assert.equal(verifyAudit(rows), null);
  await db.query("update audit_events set actor = 'someone-else' where seq = $1", [rows[5]!.seq]);
  assert.equal(verifyAudit(await loadAudit(db)), rows[5]!.seq);
});
