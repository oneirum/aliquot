import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeModel } from "./fake-model.ts";

const hosted = await startFakeModel("hosted-2", "answer");
after(() => hosted.close());

test("the hosted counter counts every request, whatever its path or body", async () => {
  await fetch(`${hosted.url}/models`);
  await fetch(`${hosted.url}/embeddings`, { method: "POST", body: "{}" });
  const bad = await fetch(`${hosted.url}/chat/completions`, { method: "POST", body: "not json" });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${hosted.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "hosted-2", messages: [{ role: "user", content: "When is lab meeting?" }] }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { id: string }).id, "cmpl-1", "reply ids count completions, not requests");
  assert.equal(hosted.requests, 4);
  assert.deepEqual(hosted.paths, ["GET /v1/models", "POST /v1/embeddings", "POST /v1/chat/completions", "POST /v1/chat/completions"]);
  assert.equal(hosted.bodies.length, 1);
});
