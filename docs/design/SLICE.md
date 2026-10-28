# First vertical slice (P1 unit 1)

## What it is

The thinnest path from a message to an answer that exercises the load-bearing decisions: the run record as the workflow history, the egress choke point, and the hashed resolved agent.

```
web page POST /chat  ->  intake (gate with the local detector, no router: one agent)
                     ->  jobs (idempotent key)
worker               ->  claim -> drive: fold -> next -> execute
                     ->  gateway -> Ollama (placement lab)          one builtin tool: kb_search over a seeded snapshot
                     ->  run_events + payloads
                     ->  surface.finalize (web)
```

In scope: `hash.ts`, `dataclass.ts` (decideEgress, full table), `record.ts` (fenced append, payloads with AES-256-GCM, fold, verifyChain), `queue.ts`, `loop.ts` (`next()` complete, including retries, limits with the final call, stop via inbox), `gateway.ts` (complete only, non-streaming plus SSE), `agent.ts` (`resolveAgent`, `versionHash`, `parseExactModelId`), `kb.ts` (bm25-v1 and reader over a snapshot loaded from a JSON fixture), `gate.ts` (`classifyText`), and a web surface. The agent comes from `fixtures/agent.json`, with no studio yet.

Out of scope: studio, router, Slack, compile, sandbox, studies.

## Definition of done (falsifiable)

`pnpm slice1` runs against `docker compose up` with Postgres and two fake OpenAI-compatible endpoints. One is a scripted model at placement `lab`, which returns a fixed sequence such as "call kb_search, then answer" so the assertions do not depend on model behavior. The other is a hosted endpoint at placement `zdr` that only counts requests. A seventh smoke check sends one real question through Ollama and expects a non-empty answer with a complete record. The slice passes only if all six assertions and the smoke check hold:

1. **Crash and resume, exactly once.** The test sends a question that needs a `kb_search` and then an answer. It `kill -9`s the worker right after the first `tool.requested` is committed, then starts a fresh worker. The run then has exactly one `run.finished` with outcome `answered`, and the web surface got exactly one reply from exactly one `finalize` call (`web_finalize_attempts` counts calls, which the unique index on replies would otherwise hide). `seq` runs from 0 with no gaps, `verifyChain` returns null, and every `*.requested` attempt has exactly one terminal event, except the one cut by the kill, which has a retry with `attempt` 2.
2. **Zombie fence.** The worker is paused right before it appends `reply.posted`. The job's lease epoch is moved by one with nothing else changed: no new holder, no event written, so the worker's next `seq` is free and only the epoch condition in the fence can refuse it. The worker wakes, gets `LeaseLost`, and the event count does not change. A second worker then claims the run, calls `finalize` again (two attempts, one reply) and finishes it. Neutralizing the epoch condition makes this check fail: the stale worker finishes the run.
3. **Idempotent intake.** The same `(surface, channel, thread, message)` posted twice gives one job and one run.
4. **D3 never leaves.** The agent's model points at the fake hosted endpoint (placement `zdr`). A message containing a pattern from lab.toml (for example `P-\d{5}`) is classified D3. The run ends with `refused`, `run_events` has an `egress.refused` event, and the fake hosted endpoint's request counter is **0**.
5. **Hash pins behavior.** The run's `run.started.agent` equals `versionHash(resolveAgent(fixture))`. Changing one character of the instructions changes the hash. Changing the description does not.
6. **Limits between steps.** With `maxSteps: 2` and a scripted model that always asks for another search, the run ends with `limit.hit` steps, one `model.requested` with `final: true`, and an answer posted.

## Next five units, in order

1. **Studio and publish (P1 unit 2).** Payload agent collection, `parseAgentDocument`, `validateAgentDraft` wired to fields, `agent_heads` with `requestPublish` and `confirmPublish` (validation-only checks for now), and a test thread on the draft hash. Done when a scripted non-developer flow publishes an agent with no repo access, and the next web message runs the new hash (spec rows 2 and 4).
2. **KB compile and retrieval tools (P1 unit 3).** The `kb-compile` job through the gateway, snapshots with a manifest and entries in payloads, the coverage check, outlines in the system prompt, `kb_read` (15k cap) and `kb_search` as built-in tools journaling `retrieved`. Done when a D3 source compile aimed at a hosted compiler is refused with zero hosted requests, and a restart mid-compile redoes only unfinished sources.
3. **Slack front door (P1 unit 4).** A Chat SDK Slack adapter calling `intake`, a `Surface` with streaming, `finalize` fallback, stop through the inbox with NOTIFY abort and confirmation after step 1, the chat egress call site with the link-only reply, and the background profile with steering. Done when killing the stream mid-answer still leaves one full answer in the thread, and a D3 answer in Slack is a link.
4. **Tools and skills (P1 unit 5).** `loadRegistry` folder discovery and hashing, `ToolContext.fetch` with the host allowlist and `decideEgress`, the external-send confirmation, the outcome-unknown path, skill versions, catalog and `skill_read`, and the network-import lint rule. Done when a tool with 3 failed attempts produces a user-visible error, and a D1 run calling a public-host tool is refused at `ctx.fetch`.
5. **Sandbox and schedules (P1 unit 6).** `run_code` through the Docker Engine API with no network and class-checked mounts, the per-thread workspace, and schedule ticks with keyed fires. Done when a D3 mount is refused for an agent with a D2 mount ceiling, and two workers ticking the same minute create one run.

After these, P1 is complete. P2 starts with the router (`logprob-choice`, follow-ups, watched channels, overlap at publish), because it is the largest remaining Sanity-parity piece.

## Added at synthesis (from candidate 2)

7. **Stop.** A stop sent within one second of the message ends the run `stopped`, with a `stop` event whose `sinceStartMs` is under 5000, a "stopped" reply and no answer reply.
8. **No hosted egress on a laptop.** With no hosted credentials in the environment and no hosted endpoint in `lab.toml`, checks 1 to 3, 5 and 6 still pass, and the hosted fake's request counter, read before and after every check, moved only during check 4 and only by its one D1 control message.
9. **Boundary gate.** `scripts/boundaries.ts` reports nothing over the checked-out `packages`, `tools`, `scripts` and `bin`, and every planted route in its `PLANTS` table (a reference to `fetch`, `WebSocket`, `EventSource` or `XMLHttpRequest` by any spelling, including an alias, a shorthand property, a computed or aliased use of `globalThis`, `eval` and `Function`; a static, side-effect, re-exported, dynamic or `require`d load of `node:http(s)`, `net`, `tls`, `dns`, `dgram`, `child_process`, `worker_threads`, `undici`, `ws`, `pg` or a vendor SDK; a builtin lookup; `createRequire`; `process.binding`; a computed specifier; the same in a `.mjs`, a `.cjs`, a tool folder, a script and the bin directory; a file named `gateway.ts` in another directory; a brand by cast, a stamp through an alias and a `decideEgress` call elsewhere) is reported on its line under its rule, with nothing else reported.

## Added by the fix round

10. **Errors converge.** A worker whose journal throws a Postgres connection error once before `model.requested` hands the job back; the retried job ends `answered` with `jobs.attempts` 1, one `run.finished` and one reply. A worker whose journal raises `StoreRefused` before `tool.completed` ends the run with `run.faulted`, one failure reply and one `run.finished` whose outcome is `failed` and whose reason is `store-refused`. A worker that hits the connection error while opening the journal, before any append, hands the job back the same way: `jobs.attempts` 1, status `done`, `answered`, one reply.
11. **Stop after step 1.** With a model that takes 2 s per call, an unconfirmed stop sent while step 2 is in flight produces `stop.asked` and the confirmation notice, aborts nothing (no `model.failed`, two `model.completed`), and the run ends `answered`. A confirmed stop sent at the same point aborts the step 2 call (`model.failed` aborted) and the run ends `stopped` with the single reply "Stopped.".

## Added by the third round

12. **Runtime seal.** A worker started with `--plant-tool test/plants/fetch-tool.ts` runs a `kb_search` whose body calls a `fetch` it took at module load, aimed at the hosted fake. The scanner is not run on it. The call throws `NetworkSealed`, so the run has three `tool.failed` with code `thrown` (the detail payload says "network is sealed"), no `tool.completed`, ends `answered`, and the hosted fake's counter does not move. A second worker with `test/plants/probe-tool.ts` tries every runtime route (`fetch` by name, by capture, by computed key, through `Reflect`, the property descriptor, `new Function` and indirect `eval`; `WebSocket`; `import()` of each network builtin with and without the `node:` prefix, `undici` and `ws`; `process.getBuiltinModule`; `createRequire`; `process.binding`; `process.dlopen`) and reports 23 refused, 0 leaked, and the permission model denying `child`, `worker` and `addon`.
