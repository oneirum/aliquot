/**
 * Runs one tool the way a run does, through the tool runner, against a fake API on loopback. The fetch the runner is
 * given sends every request to the fake server and keeps the URL the tool asked for, so a test asserts both what the
 * tool sent and what it returned.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import { createKbReader, memorySnapshots } from "../packages/core/src/kb.ts";
import { createHttpEgress, createToolRunner, registryOf, type ToolManifest } from "../packages/core/src/tools.ts";
import type { CallFailure, RunEvent, RunId } from "../packages/core/src/record.ts";
import type { ToolHash } from "../packages/core/src/hash.ts";
import { memoryJournal } from "./recorder.ts";

export interface Route {
  readonly file: URL;
  readonly type: string;
}

export interface FakeApi {
  /** Every URL the tool fetched, as the tool wrote it. */
  readonly requests: URL[];
  invoke(tool: unknown, input: unknown, opts?: { readonly contact?: string | null; readonly inputClass?: DataClass }): Promise<{ readonly events: readonly RunEvent["t"][]; readonly output: unknown; readonly failure: { code: CallFailure["code"]; detail: unknown } | null }>;
  close(): Promise<void>;
}

/** Serves each route's fixture file by request path. */
export async function fakeApi(routes: Readonly<Record<string, Route>>): Promise<FakeApi> {
  const server = createServer(async (req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://x").pathname];
    if (!route) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": route.type }).end(await readFile(route.file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requests: URL[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    requests.push(u);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  };
  return {
    requests,
    async invoke(tool, input, opts = {}) {
      const manifest = tool as ToolManifest<unknown, unknown>;
      const runner = createToolRunner(registryOf([{ manifest, hash: "t".repeat(64) as ToolHash, owner: "test" }]), {
        http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {}, fetchImpl }),
        kb: createKbReader(memorySnapshots([])),
        contact: opts.contact ?? null,
      });
      const j = memoryJournal("00000000-0000-4000-8000-0000000000aa" as RunId);
      const ref = await j.put(Labelled.stamp(input, opts.inputClass ?? "D0", "test"));
      await runner.invoke(j, { callId: "c1", tool: manifest.name, attempt: 1, input: ref }, { knowledgeBases: [], retrieval: { algorithm: "bm25-v1", readCapTokens: 1000 }, sandbox: null }, new AbortController().signal);
      const last = j.log.at(-1)!;
      return {
        events: j.log.map((e) => e.t),
        output: last.t === "tool.completed" ? j.body(last.output) : null,
        failure: last.t === "tool.failed" ? { code: last.failure.code, detail: last.failure.detail ? j.body(last.failure.detail) : null } : null,
      };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
