# Aliquot: core design

This began as the design sketch for the harness. The sections from **Implementation reconciliation** on record, unit by unit, where the code differs from the sketch and why. "The spec" means the product spec the design was written against; it is not published, so its section numbers are left out. P1 to P4 are build phases; `SLICE.md` lists the P1 units.

## Problem

We need an open-source agent harness for research labs. It must do everything Sanity's @s does: agents as documents edited by non-developers, one front door with a classifier router, durable runs, Slack and Teams, knowledge bases, tools, skills. It must also do what a lab needs: studies that freeze an agent version, a run record for every answer, data classes where restricted (D3) and review-confidential (R) content never leaves lab hardware, reviewer replay, and IRB and consent fields.

Constraints from the spec and task that shape everything below:

- One server. App plus Postgres. `docker compose up` on a laptop runs it all with a local model and no hosted service.
- D3 and R never reach a hosted model or hosted workflow history, enforced at one choke point.
- A frozen version is a content hash over the fully resolved agent. Freeze, run records, cards and replay all derive from that one type.
- Every model call, retrieval and tool call is in the run record as it happens. A crashed run has a complete record up to the crash.
- A lab contributor who is not a full-time engineer can add a tool (v0.3; see DESIGN-v02) or read the run loop.
- Sanity's runtime defaults: 3 attempts, stream fallback, stop means stop, limits between steps (40 steps, 1M tokens, 10 min; background 200 steps, 1 h), idempotent by thread.

The non-obvious part: Sanity has two histories (Temporal's workflow history and whatever they log), and it encrypts Temporal's before it leaves the cluster because that history "holds whole conversations and whatever the tools return". A lab has a third requirement on top: the run record is a research artifact. Three copies of the same conversation, each with its own retention, redaction and egress story, is the shape to avoid.

## Usage (caller's view)

### Operator quickstart (README)

```sh
git clone <repo> labh && cd labh
cp lab.example.toml lab.toml        # endpoints, placements, policy
docker compose up                    # postgres, app (studio + web + webhooks), worker, ollama
open http://localhost:3000/studio    # make an agent, press Test, press Publish
open http://localhost:3000/chat      # talk to it
```

`lab.toml` is where a lab says what is where. Every outbound destination has a placement, and the placement decides which data classes may go there.

```toml
[endpoints.local]
base_url = "http://ollama:11434/v1"
placement = "lab"                     # lab hardware: up to D3

[endpoints.openrouter]
base_url = "https://openrouter.ai/api/v1"
placement = "zdr"                     # up to D1
api_key_env = "OPENROUTER_API_KEY"
provider = { zdr = true, data_collection = "deny", allow_fallbacks = false, only = ["anthropic"] }

[surfaces.slack]
placement = "approved"                # up to D2; D3 answers become a link to /chat
[surfaces.web]
placement = "lab"

[policy]
review_confidential = "refuse"        # or "lab-only"
```

### Contributor: adding a tool

v0.2 changes this section: it loads no tool folder, and every binary refuses a `lab.toml` with a `[tools]` table. Its seven tools are built into `packages/core/src/tools.ts`, and each tool's version is the hash of its spec. Contributed tools are planned for v0.3, behind an OS-level boundary. See "Research tools" in `DESIGN-v02.md`. The sketch below is the original plan, kept for the shape of `defineTool`.

One folder, one file, one test. No registry to edit. The folder's content hash becomes part of every agent version that uses it.

```ts
// tools/openalex_search/tool.ts
import { defineTool, z } from "@labh/core/tool-kit";

export default defineTool({
  name: "openalex_search",
  description: "Search OpenAlex for papers. Use for literature questions. Not for full text.",
  input: z.object({ query: z.string().max(500), limit: z.number().int().max(25).default(10) }),
  reads: "D0",                         // the class of what this tool returns
  effects: "read",                     // read | lab-write | external-send
  egress: ["api.openalex.org"],        // ctx.fetch refuses any other host
  idempotent: true,
  async run({ query, limit }, ctx) {
    const res = await ctx.fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`);
    return (await res.json()).results.map((w: any) => ({ id: w.id, title: w.title, year: w.publication_year }));
  },
});
```

If the run's conversation is D3, `ctx.fetch` refuses, because the query was written from D3 context and `api.openalex.org` is placement `public`. The tool author does nothing to get that.

### Contributor: reading the run loop

The whole run policy is one pure function. The rest is a shell that executes what it returns.

```ts
// core/src/loop.ts (shape)
for (;;) {
  const state = fold(await journal.events());         // everything known about the run
  const action = next(state, agent, clock.now());     // pure: what to do now
  if (action.t === "finish") return finish(action);
  await execute(action);                              // one model call, one tool call, or one post
}
```

A crash anywhere means the next worker folds the same events and gets the same `next` action. There is no workflow determinism rule to learn, because nothing is replayed except data.

### Lab layer call sites

```ts
// Study owner freezes the version that answered in the pilot.
const f = await studies.freeze("STUDY-12", "codebook-coder", hash, actor, "prereg osf.io/abcd");

// Methods section.
const card = await studies.card(f.hash);              // markdown + JSON, same data

// Reviewer, cleared to D1, checks the pipeline without participant data.
const bundle = await replay.exportBundle({ study: "STUDY-12" }, { clearance: "D1" });
const report = await replay.reexecute(runId, { tools: "recorded" });   // agreement, divergences
```

### Front door call site (webhook handler)

```ts
// The only thing a front-door adapter does with an inbound message.
const outcome = await intake(inboundFromChatSdk(event));   // gate -> study pin or router -> enqueue (idempotent)
```

## Shape

### Module map

```
packages/core            the harness. Public surface: src/index.ts and ./studio only (package.json "exports").
  hash.ts                canonical JSON, sha256, branded hash types
  dataclass.ts           DataClass lattice, Placement, Destination, decideEgress()  <- the one egress decision
  record.ts              RunEvent, fenced append, payload store, fold(), PROV export, redaction
  loop.ts                next() (pure run policy), drive() (shell), limits, retries
  queue.ts               one jobs table: enqueue (idempotent key), claim (SKIP LOCKED), lease fence, worker
  gateway.ts             the only module that talks to models. complete(), choose(). Calls decideEgress.
  agent.ts               AgentDocument, ResolvedAgent, resolve(), versionHash(), validateAgentDraft(), card
  kb.ts                  KbSnapshot, outline/read/search, bm25-v1, compile
  skills.ts              SkillVersion, catalog, skill_read
  tools.ts               defineTool, ToolContext (egress-checked fetch), the registry and the seven built-ins
  gate.ts                identity, audience, message classification (local detector, fails closed)
  router.ts              route(), shouldReply(), overlapReport(); backends behind gateway.choose()
  frontdoor.ts           Surface port, intake(), reply posting through decideEgress
  publish.ts             publish checks (validation, evals, overlap) and the head pointer
  study.ts               Study, freeze, unfreeze, pinFor
  replay.ts              audit, re-execute, counterfactual, bundle export
  seal.ts                the runtime half of the choke point: the platform fetch, sealNetwork(), the permission-model check
  migrations/            ordered schema migrations; db.ts applies each once, in order, recorded in schema_migrations
packages/studio          Payload CMS config (collections, custom Publish and Test panels). Imports @labh/core.
```

Studio depends on core. Core never imports studio. The package `exports` field makes core internals unimportable from the studio, per the importable-internals red flag.

### Data structures first

**Content-addressed everything.** Agent versions, skill versions, KB snapshots, KB entries, tool specs and run payloads are all addressed by sha256 of canonical JSON or bytes. This one decision buys several features at once:

- Freeze is a row binding a study to a hash. Edits make new hashes. A study cannot see an edit because it never looks anything up by name.
- KB snapshot diff is a diff of two `{path -> entryHash}` maps. Unchanged entries dedupe for free.
- Run records hold hashes. Payload bodies live in one `payloads` table, encrypted at rest. Reviewer redaction is "drop bodies above clearance, keep hashes". Retention is "delete bodies older than the class's retention, keep hashes". Withdrawal flagging is a join on entry hashes.

**`ResolvedAgent` is the behavior type.** It holds exactly the fields the run loop reads: instructions and their class, exact model target, KB snapshot ids with their class, tool hashes, sandbox image digest, limits, retrieval algorithm and read cap, and the loop contract version. `versionHash = sha256(canonicalJson(resolved))`. Routing and governance fields (description, audience, channels, owner, sample questions, ceiling, provenance policy, IRB protocol) live in `AgentListing`, which is not hashed. Editing a description therefore does not invalidate a frozen version, which is correct because study channels bypass the router. Rule for contributors: if `loop.ts` reads it, it goes in `ResolvedAgent`; otherwise it does not. The type is the definition, and `test/agent.test.ts` pins it. Two fields return to the hash with the unit that makes the loop read them: skill version hashes with skills, and `provenancePolicy` with `toProv`, which changes what the record holds. What a frozen study reported about governance cannot drift either: a freeze stores the `AgentListing` as it was in `freezes.listing`, and the card renders that snapshot as `listingAtFreeze`, so a republish that raises a ceiling or loosens a provenance policy changes the live listing and nothing the study cites.

**Unfrozen agents float, frozen agents do not.** The published head stores the `AgentDocument` with unpinned references. Intake resolves it against the current catalog for every new run and upserts the resolved row by hash (idempotent). So a skill or KB publish reaches unfrozen agents on the next message, matching Sanity's "instantly available", and every run still names an exact hash. A study channel skips resolution and runs its frozen hash. There is no other way to start a run: `enqueueRun` takes an `AgentVersionHash`, never a document.

**The run record is the workflow history.** This is the load-bearing decision. A run is an append-only, hash-chained list of `RunEvent`s in `run_events`, with large or sensitive bodies in `payloads`. The durable loop has no other state. Resume is `fold(events)` then `next(state)`. Consequences:

- The spec's "a crashed run still has a complete record up to the crash" is not a feature. It is how the runtime works. A step that is not in the record did not happen.
- No second copy of the conversation exists anywhere, so there is no hosted history to encrypt and no second retention policy.
- Continue-as-new is unnecessary. That was a Temporal Cloud history-size limit. Our event count is bounded by the step limit (200 steps times a few events).

**Fencing instead of locks.** One worker holds a run's lease, with an epoch. `append` inserts `(run_id, seq)` with a unique constraint and a check that the run's lease epoch still matches. A zombie worker that lost its lease fails its next append and stops. Exactly one `run.finished` per run follows from the unique `seq` plus `next()` returning `finish` only once per fold.

**Per-actor inboxes, merged at the read boundary.** Front doors never write `run_events`. Stop, steer and confirm go to `run_inbox`. The lease holder consumes inbox rows between steps and journals what it consumed (`inbox.consumed`). One writer per stream, per separate-before-serializing. Stop also fires a Postgres NOTIFY so an in-flight model call aborts through its `AbortSignal`.

### The egress choke point

`decideEgress(payloadClass, destination, policy)` in `dataclass.ts` is the only function that answers "may data of class C go to D". It is pure and total over a closed `Destination` union: model endpoint, tool HTTP host, chat surface, storage, export. Five callers, each a single call site:

| Destination | Caller | Effect of refusal |
|---|---|---|
| model | `gateway.complete` / `gateway.choose` | `egress.refused` event, no network call |
| http | `ToolContext.fetch` | tool call fails with a refusal the agent can explain |
| chat | `frontdoor.postReply` | posts a link to the lab-hosted web page instead of the answer |
| store | `PayloadStore.put` | refuses to persist (startup also checks the DB placement) |
| export | `replay.exportBundle` | body replaced by hash |

Where the class comes from: every piece of content enters a run as a `RunEvent` with a class set at its origin. The gate sets the message class (`max(channel floor, detector)`). A KB snapshot carries the max class of its sources. A tool output carries `max(tool.reads, conversation class)`. Instructions carry the document's content class (D1 by default; the same detector runs at publish). The prompt's class is the join of every part in it, computed by `fold`, not by the caller. A conversation can only go up in class. There is no declassify operation in v1.

Two consequences worth stating, because they will look like bugs:

- An agent with a D3 KB is D3 on every call, because its outline is in the system prompt. The studio rule "a D3 ceiling needs a lab model" is the early, friendly version of what the gateway enforces anyway.
- Chat surfaces are destinations. Slack is a hosted service. A D3 answer posted into a Slack thread is egress even though the question came from Slack. The harness posts "This answer contains restricted data. Open it here" with a link to `/chat/runs/<id>` behind university sign-on.

The gateway is also the only module holding provider base URLs and keys. Refuse-not-swap lives there too: the gateway compares the provider's returned model id with the requested exact id and returns `refused-model-mismatch` instead of the answer. For OpenRouter it sends `provider.zdr = true`, `data_collection = "deny"`, `allow_fallbacks = false` and `only` from config (parameters checked in OpenRouter's docs on 2026-10-22).

Every gateway call takes a `CallRecorder`. Inside a run it is the run journal; outside a run (KB compile, publish checks, router calls before a run exists) it is the audit stream. There is no way to call a model without writing a record, and refusals are recorded in exactly one place.

An in-process tool that reaches for `node:http` or the global `fetch` would bypass `ctx.fetch`, so the tool path is closed by three layers, each proven by a planted route. Statically, `scripts/boundaries.ts` builds a TypeScript program over `packages`, `scripts` and `bin` and reads bound symbols, not text: a network global by any spelling, a computed or aliased use of the global object, `eval` and `Function`, and every static, dynamic, re-exported or required load of a network builtin or socket-opening package are reported against an allowance keyed by path from the repository root. At runtime, `seal.ts` takes the platform `fetch` when it loads (the gateway and the tool runner import it, nothing else may) and `sealNetwork()`, called by each binary before it boots and before any tool is imported, replaces the network globals with non-configurable throwing stubs, refuses the network modules in the loader for every importer but the web server and `pg`, and wraps `process.getBuiltinModule`. At the process level, the binaries refuse to start unless Node's permission model is on with child processes, worker threads and addons denied. What stays open is the network itself, because `--allow-net` is all or nothing and the worker needs Postgres and the model endpoints; the sandbox runs with no network for the code it executes.

### The run loop

`next(state, agent, now): Action` is the entire runtime policy, and it is pure:

1. Stop requested and confirmed (or before the first step) -> `finish(stopped)`. An unconfirmed stop after step 1 -> `ask-stop-confirm` while the run continues.
2. An open call (requested, no result) -> retry it if attempts < 3 and the call is safe to repeat. A model call is always safe. A tool call is safe if the tool is `idempotent` or `effects: "read"`. Otherwise -> record `tool.outcome-unknown` and tell the agent the outcome is unknown.
3. A pending external-send tool call without confirmation -> `ask-confirm`, then `wait`. Waiting releases the lease. No worker is held while a human decides.
4. Limits (steps, tokens, wall time since `run.started`) hit -> one `call-model` with `final: true` and no tools, so the agent stops with an answer. Checked between steps only.
5. Last model output has tool calls -> `call-tool` for the first unresolved one.
6. Last model output is an answer -> `post-reply`, then `finish(answered)`.
7. Otherwise -> `call-model`.

Retries use the attempt count from the journal, so a crash does not reset it. Three attempts is the cap for both model and tool calls. A tool that fails three times becomes a tool error message to the agent, which tells the user, as Sanity does.

Stream fallback: deltas stream live to the surface and are not journaled per token. The final answer is journaled, then `surface.finalize(runId, text)` is called. `finalize` is idempotent by run id: if the stream was confirmed closed it does nothing, otherwise it posts or edits to the full answer. `reply.posted` records which.

Background runs are the same loop with the background limit profile. A reply in a thread that has an active background run becomes a `steer` inbox item. A reply in a thread with an active interactive run queues the next run; runs in one thread are serialized by the claim query.

Schedules are rows. The worker inserts jobs keyed `sched:<id>:<fireTime>` with `ON CONFLICT DO NOTHING`, so two workers or a restart cannot double-fire.

### One queue, two execution styles

`jobs` is the only durable queue. Kinds: `run`, `publish-check`, `kb-compile`, `eval-batch`. Runs are journaled and resume mid-run. Every other kind is idempotent by its content key (a publish check is keyed by draft hash, a compile by source hashes plus compiler hash, and per-entry compile results are cached by the same key), so restarting it from the top is correct and cheap. Evals are not a separate engine: each eval case is a `run` job with trigger `eval` on the draft's resolved hash, so evals have full run records and answer diffs come from comparing two runs.

### Router

`route()` is Sanity's design with its defaults: message up to 8,000 characters plus up to the last 20 thread messages; options are routable published agents the user may reach plus `harness:self`; top probability wins; under the low-confidence threshold the user picks from the top three; the current thread agent is passed in so follow-ups stay put. `shouldReply()` is the watched-channel yes or no gate. Study channels never reach the router.

The backend sits behind `gateway.choose(target, request)`, so a hosted decision model is just another endpoint with a placement, and D3 messages cannot reach it. Two backends:

- `logprob-choice`: any OpenAI-compatible chat endpoint that returns logprobs. Options become single-token labels; probabilities are a softmax over the labels' top logprobs. Ollama's OpenAI-compatible layer returns logprobs (checked in its source on 2026-10-22). Default for local.
- `decision-api`: a hosted decision model (Jev-like). Wire format unverified; P2.

The 0.4 threshold is Jev's scale. A local classifier's confidence is not on that scale, so `RouterProfile.lowConfidence` is per backend and is calibrated on the lab's labelled question set. Every decision (probs, confidence, backend, router version) is the first event of the run it starts.

### Knowledge bases

A snapshot is immutable: `{id, kbId, cls, purpose, entries: path -> entryHash, sources, compiler: {target, promptHash}, coverage}`. Search is our own `bm25-v1` (BM25 with a title weight, NFKC lowercase tokenizer, no stemming), built in memory per snapshot id on first use and cached. Snapshots are small and immutable, so the index needs no storage and no invalidation. We own the scorer because search results are part of what a frozen study reproduces; a library upgrade must not reorder hits. `retrieval: "bm25-v1"` is in `ResolvedAgent`. The read cap is 15k tokens, estimated as 4 characters per token so it is deterministic across models. The outline of each attached snapshot goes in the system prompt, as Sanity does, so it is inside the recorded prompt payload. Every `kb_read` and `kb_search` writes the returned entry hashes to the run record, cited or not.

### Studio

Payload CMS owns drafts and revisions (versions on, Payload drafts off, so every save is a revision with diff and restore). Core owns published heads and immutable versions. Payload's own "published" notion is not used, so there is one owner of "what is live". Field validation in Payload calls `validateAgentDraft` from core, the same function publish and MCP use, so the lab rules have one source. Publish is a button in a custom panel that calls `requestPublish`, shows check results (validation, evals with answer diffs, router overlap), and then `confirmPublish` moves the head pointer in one transaction and appends to the audit stream.

### Interface depth

The deep modules are `gateway` (two methods hide providers, egress, refuse-not-swap, provider routing flags, streaming and recording), `loop` (`drive(job)` hides retries, limits, stop, steering, confirmation, fallback) and `record` (`append`, `put`, `fold` hide hashing, fencing, encryption and redaction). Public callers see `intake`, `studies.*` (including `card`), `replay.*`, `defineTool`. Wire types (Slack events, Payload JSON, OpenAI chat payloads) are parsed at the edge into domain types and never cross into `next()`.

### What it deliberately does not do

No declassification. No hosted workflow engine, ever, so there is no hosted history path to secure. No per-token journaling. No vector search in v1 (BM25 plus outline is Sanity's design and is reproducible). No agents that talk to participants (spec 4.5). No old tool versions kept loadable for frozen studies (see open questions).

## Synthesis decision

Four candidate designs were written independently from the same task and scored against one rubric. This design was candidate 1, and the base. The others are referred to by number below.

**Base: candidate 1.** Every invariant is a type or a table, not a habit. A new egress kind is a new `Destination` member that breaks an exhaustive switch. A new behavior field goes into `ResolvedAgent` by the rule "if `loop.ts` reads it, it is hashed". A new job kind is a content key in the one `jobs` table. `next()` is pure, so loop edits never break resume.

**Convergence.** Three of four candidates (1, 2, 3) independently made the run record the durable journal on Postgres with no workflow engine. All four chose TypeScript, the Vercel Chat SDK behind our own port, and in-house BM25 over immutable snapshots. That agreement is the strongest signal in the bakeoff, so those choices are not revisited.

**Grafts, each folded into the base by hand:**

| From | What | Why |
|---|---|---|
| 3 | `Labelled<T>` with a private constructor, built only by `stamp` (at an origin) and `derive` (joins its inputs). Replaces the base's plain `Classified` interface. | The base's class label could be forged by any caller. This makes "a caller cannot name a lower class than the content has" a compile error. |
| 3 | `test/boundaries.test.ts` as a build gate: fails if `fetch(`, `node:http(s)`, `node:net`, or any vendor SDK import appears outside the gateway, tool context and surface adapters. | Turns "one choke point" from a convention into a failing test. Replaces the base's tools-only lint rule. |
| 3 | The class a destination may receive is derived from its kind and flags (`local`, `institution`, `hosted` with `zdr` and `institutionApproved`), never configured beside it. | Config cannot say "hosted, D3"; the type has no field for it. |
| 3 | A model-free `lexical` router backend (BM25 over descriptions and sample questions, calibrated softmax). | Routes at every data class with no model, and is the baseline the logprob router must beat (spec R6). |
| 2 | Typed `EgressRefusal` codes instead of `reason: string`. | Refusals are counted on the console and tested by code. |
| 2 | A D3 sandbox mount requires `sandbox.host = "lab-controlled"` in lab config. | A laptop compose refuses D3 mounts by construction. |
| 2 | Script tools: a Python or R contributor writes the same manifest with `{ kind: "script", language, entry }` and it runs in the sandbox. | Lab contributors live in Python and R; this gives them a path on day one without a second core language. |
| 2 | Slice checks for stop and for "no hosted credentials at all". | Both are spec acceptance rows the base slice did not test. |
| 4 | `AuthorizedRoute`, a branded type that only the egress decision produces and that the provider client accepts. | The model path is unavoidable in the types, not only in the module layout. |
| 4 | `eligibleOptions`: the router only sees published, routable agents whose ceiling covers the message class and whose audience includes the sender. | The base router did not filter options by ceiling. |
| 4 | `agent_versions` is insert-only at the database level (`REVOKE UPDATE, DELETE`). | A frozen version cannot change even through a bug or a manual query. |

**The one contested choice: studio.** Candidates 1, 2 and 4 chose Payload CMS. Candidate 3 chose a custom server-rendered studio generated from zod schemas. Payload wins on non-developer authoring: validation, drafts, revisions, restore and roles come with the package, and candidate 3's own risk note says a custom studio may cost three rounds and still look worse. Candidate 3's real point survives as a graft: a Payload collection written by hand is a second definition of the agent document. So **Payload collection fields are generated from the zod schema in core**, and the schema is the one definition of type, validator and form. Payload stays quarantined in `packages/studio`; core never imports it.

**Rejected:** DBOS Transact as the engine (candidate 4). It is a good library, but its step outputs would be a second copy of every call beside the run record, with a second retention story for restricted data. It stays the named fallback if the kill test cannot pass on our own journal. The AI SDK as the model layer (candidate 2) is rejected for now: the gateway is the egress choke point and must own the wire call, and one OpenAI-compatible protocol covers OpenRouter, Ollama, vLLM and institutional servers.

**Biggest risk and its falsifier.** The hand-rolled lease fence. "Exactly one `run.finished` and one reply" rests on a unique `(run_id, seq)` plus a lease epoch. Falsifier, built into slice 1: two workers on one Postgres, `kill -9` worker A after `tool.requested`, start B, then let A's stale epoch attempt one append and one `finalize`. Two `run.finished` rows or two posts and the design goes back to Phase B.

## Tradeoffs accepted

- We accept owning about 500 lines of durable-execution code (lease, fence, fold, inbox) in exchange for the run record and the workflow history being one thing, with no second copy of D3 data and no framework rules for contributors to learn.
- We accept TypeScript in exchange for one language across studio, chat adapters and core, and the two libraries that save the most rounds (Payload, Chat SDK). Lab members are more fluent in Python and R; they write documents and skills, and agents write their R and Python in the sandbox.
- We accept Payload's weight (Next.js, React) in the studio package in exchange for non-developer forms, revisions, diff, restore and roles we would otherwise build. It is quarantined in `packages/studio`; core and tools never see it.
- We accept that an agent with any D3 KB runs every call on a lab model, even for a question that would not touch the KB, in exchange for an egress rule with no exceptions to reason about.
- We accept that a D3 answer never appears inline in Slack in exchange for Slack not being treated as lab storage.
- We accept retrying a model call after a crash (paying for tokens twice) in exchange for not needing exactly-once model calls.
- We accept an in-memory BM25 per snapshot in exchange for zero extensions in Postgres and stable rankings across upgrades.
- We accept that unconfirmed side effects after a crash are reported as unknown rather than retried.

## Alternatives considered

- **DBOS Transact as the engine, run record as a separate table.** Strong library, Postgres only, MIT. It loses on depth for this problem: step outputs would live in DBOS's system tables and again in our run record, two copies of D3 content with two retention stories, or else our run record reads DBOS's internal schema, which is information leakage. Contributors would also have to learn workflow determinism rules that `next()` does not need.
- **Temporal self-hosted.** What Sanity used. Fails "one dependency department IT will run": it is a separate server cluster with its own persistence schema, and its history is a second copy of every conversation.
- **Agent loop as replayed code (durable function style) instead of a fold over data.** Hides less: every contributor edit to the loop must stay deterministic or old runs break on resume. A fold over events has no such rule; changing `next()` only changes future decisions, and the loop contract version in `ResolvedAgent` pins behavior for frozen studies.
- **Custom form studio on Postgres.** One less framework, and drafts would sit in core tables. Loses on rounds: forms, revisions, diff, restore and roles for three document types is two or more rounds, and non-developer authoring quality is the HCI bet of the whole project.
- **Per-caller egress checks (router checks, tool checks, KB compile checks).** Rejected as the spec says. Kept one function and five single call sites, and put the model-path call inside the gateway, which is the only holder of provider credentials.

## Open questions and risks

- Frozen studies pin tool hashes. When someone edits a tool a frozen study uses, should CI block the merge until the study owner acknowledges, or should the deployment keep old tool versions runnable? This design refuses the run and proposes the CI check (`frozenDependents(tool)`).
- Can a local model be pinned by weights digest? Ollama tags move. Does the lab accept "tag plus recorded digest, refuse on digest change" as the frozen contract? Digest exposure by Ollama and vLLM is unverified.
- Is Slack placement `approved` (D2) right as the default for a university lab, or should the default be `public` until the lab's IT says otherwise?
- Does the sandbox's Docker socket access pass a department IT review? Rootless Docker or Podman would help; neither is checked.
- Background token limit: the spec gives 200 steps and 1 h but no token number. This design uses 1M until the lab says otherwise.
- University sign-on is usually SAML (Shibboleth). Payload auth plus an SSO bridge is unverified. Which identity provider will the pilot lab use?
- Chat SDK has its own dedupe and locks (state-pg). Our jobs key is the source of truth. Is running both acceptable, or should we pass a no-op state adapter?

## Next implementation step

Write `record.ts` (fenced append, payloads, fold) and `next()` with tests that replay hand-written event lists, then the kill-9 slice test in SLICE.md.

## Implementation reconciliation

Slice 1 (`pnpm slice1`) built the sketch above against Postgres, two fake OpenAI-compatible endpoints and Ollama. Where the code differs from the sketch, the difference and its reason are here. Everything not listed matches the sketch.

- **Placements stay five names.** The graft from candidate 3 derived a destination's ceiling from structural flags (`local`, `institution`, `hosted` with `zdr` and `institutionApproved`). The code keeps the five placement names that `lab.toml` and this document use, and derives the ceiling from `(kind, placement)` in the `CEILINGS` constant in `dataclass.ts`. `EgressPolicy` lost its `ceilings` field, so a config file has no field in which to name a ceiling. That is the property the graft was for.
- **`agent_versions` is insert-only by trigger as well as by revoke.** `REVOKE UPDATE, DELETE ... FROM PUBLIC` does not bind the table owner, and compose connects as the owner. A `before update or delete` trigger refuses the change for every role. `test/record.test.ts` proves an `UPDATE` and a `DELETE` both raise.
- **The worker opens the journal, not the queue.** `openJournal(db, store, lease)` takes the lease the worker claimed. The fence is unchanged, inside the insert. The record tests prove a stale epoch cannot append and that two holders of one seq get one row.
- **`model.completed` carries its tool calls.** `fold` cannot read bodies, so the event holds `toolCalls: [{id, name, args: PayloadRef}]`, one payload per call. `tool.requested.input` is the same ref, so replay can match a call by its input hash.
- **Three events were added.** `stop.asked` records that the confirmation question was posted. `stop` with `sinceStartMs` records that the run stopped; check 7 reads it and the "stops within 5 s" view will. `limit.hit` is written by its own `limit` action, so `next()` stays pure.
- **`next()` posts an answer in hand before it checks limits.** The sketch checked limits first, so a run that answered at exactly `maxSteps` would have recorded a limit hit instead of posting. Limits gate new calls only. `test/loop.test.ts` has the case.
- **A provider that serves a different model id produces `model.failed` with `retryable: false`.** There is no separate event. The gateway returns `refused-model-mismatch` and the run fails with a notice.
- **`tool.completed.retrieved` is a list**, one entry per snapshot the call touched, because `kb_search` searches every attached knowledge base.
- **`kb_search` returns bodies.** It searches, reads the hits up to 2,000 tokens, and journals every entry from both steps. `kb_read` with the 15k cap arrives with the KB unit.
- **The KB reader loads snapshots from JSON fixtures in memory** (`snapshotFromFixture`, `createKbReader(loaded)`), not from the payload store. The store-backed loader comes with compile. A snapshot id is still the hash of its manifest.
- **`Labelled.stamp` has an allowlist in the boundary scanner** (gate, kb, tools, record, agent, loop). The graft required only a private constructor. The allowlist makes the set of origins a build failure too, and the scanner resolves the receiver, so an alias of the class is caught.
- **The payload store takes one master key**, `key_id` `k1`, read from the env var `lab.toml` names, and derives its address and cipher subkeys from it (third round below). Per-class keys and retention are later units.
- **Fault injection lives in the worker binary.** `--fault kill-after:<event>` sends the process SIGKILL right after that event commits. `--fault stop-before:<event>` sends SIGSTOP right before. Checks 1 and 2 use them against separate worker processes, because a kill sent from outside cannot land between a 2 ms tool call and the next append.
- **Intake takes its dependencies as a parameter and serves one agent.** `intake(msg, deps)` with `deps.agentFor(channel)`. No router, no study pin, no steer, and `history` is empty, so a follow-up in the same thread does not yet see earlier turns.
- **The draft validator refuses a D3-ceiling agent on a zdr endpoint**, as the sketch's rule says. Check 4 therefore runs a D1-ceiling agent on the hosted endpoint and sends a D3 message. The gateway refuses it with zero hosted requests.
- **`Prompt` is a class with a private constructor**, like `Labelled`, so a caller cannot set its class.
- **Node runs the TypeScript directly** (type stripping), so the sources use no enums, parameter properties or namespaces. `exactOptionalPropertyTypes` is off because zod 4's `.optional()` yields `T | undefined`.
- **compose uses `postgres:17-alpine` with port 5432 published**, so host-run workers and `pnpm slice1` reach it.
- **Not built in this slice, left as stubs that throw a message naming the unit.** `toProv`, `sweepRetention`, `loadRegistry`, `renderAgentCard`, `gateway.choose`, and everything in `router.ts`, `study.ts`, `replay.ts` and `skills.ts`.

### Fix round after the independent review

- **Every error in `drive()` converges on one `run.finished` and one reply.** Errors are classed in `loop.ts faultOf`. Terminal classes (`StoreRefused`, `PayloadUnavailable`, `SurfaceUnknown`, `AgentUnavailable`, `UnrunnableAgent`) are journaled as `run.faulted` with a typed `FailureReason`; `next()` then allows only the failure notice and the finish, so a crash between the two resumes into the same end. Every other error is transient: the worker gets `retry`, the job goes back to `queued` with `attempts + 1` and a backoff (`JOB_RETRY` in `queue.ts`: 1 s, 4 s, 10 s), and the third failure is journaled as `retries-exhausted` with the message stored as a payload at the run's class, never as text in the event. `run.finished` carries `reason` for `failed` and `unrunnable`. Two bounded exceptions: a job whose payload does not parse (`MalformedJob`) has no run to finish and is marked failed, and a job that keeps hitting transient errors while settling its own failure is marked failed by the worker after `JOB_RETRY.hardCap` attempts, with a log line. Check 10 injects a Postgres blip and a `StoreRefused` through `--fault throw-before:<event>:<pg-blip|store-refused>`.
- **A stop aborts an in-flight call only when it ends the run.** The NOTIFY payload is `<runId>:<confirmed|unconfirmed>`. The worker holds no sticky abort controller: `drive()` takes a fresh signal per call through `LoopDeps.callSignal(abortsOn)` and releases it after the call. `stopAborts(state)` in `loop.ts` is the pure rule, the same one `fold` applies when the stop is consumed: confirmed, or before the first step, or a second stop after the question. An unconfirmed stop after step 1 therefore lets the call finish, is asked about between steps, and the run goes on. `POST /stop` takes `confirmed` (default false) so the web page's second click confirms. Check 11 covers both stops during step 2. Each loop iteration registers its stop listener before it reads the inbox: a notice that lands before the read is in the inbox and is consumed, one that lands after it reaches the listener. Registering after the read left a few-millisecond gap in which a confirmed stop was seen by neither until the call ended (caught by check 11 one run in three).
- **A body read back carries the class in its address.** The class is part of the payload address (third round below), so a ref from a hash-chained event names a row at exactly that class, and `buildPrompt` reads it back at that class.
- **`Labelled` and `Prompt` are nominal, at compile time and at run time.** A private constructor alone leaves a class structural in TypeScript, so an object literal with the same fields typechecked as a `Labelled`. Both classes carry an ES private field (`#brand`), which no literal can supply. `test/compile-fail/forge.ts` holds the forgeries and `test/nominal.test.ts` runs `tsc` over it, asserting an error on exactly those lines. The same field is the runtime check (third round below). `Labelled.derive` takes either a non-empty tuple of inputs or an explicit floor class (overloads), so `derive(x, [])` no longer mints D0; the gateway passes `prompt.cls` as the floor for everything it derives from a prompt. `Prompt.of` takes a non-empty tuple of parts for the same reason.
- **The run record cannot be rewritten, and its head is anchored.** `run_events` is insert-only by trigger and revoke, like `agent_versions`. `payloads` rows change in exactly two ways, a class raise and a redaction that nulls the body and keeps the hash; a trigger refuses everything else, including delete. The fenced append is one statement that inserts the event and moves `jobs.head_seq` and `jobs.head_hash` to it, so the job row always names the chain head. `openJournal` recomputes the chain and checks that it ends at the anchor before any append, and throws `RecordCorrupt` otherwise; the worker then fails the job without touching the record, which is the one case besides a malformed payload where a job fails with no `run.finished`. The anchor is defense in depth inside one database; an external anchor is a later unit.
- **No error text in event JSON.** `model.failed` and `tool.failed` carry a `CallFailure`: a code (`aborted`, `network`, `http`, `unparseable`, `model-mismatch`, `invalid-input`, `unknown-tool`, `egress-refused`, `declined`, `thrown`), the HTTP status when there is one, and `detail`, a payload ref for the free text or null. The gateway stores a provider error body at the prompt's class (a body can echo the prompt); the tool runner stores a thrown or validation message at the input's class. The event's class is the detail's class. `buildPrompt` reads the detail back for the agent's tool-error message.
- **The version hash covers exactly what the loop reads.** `ResolvedAgent` (`schema: 2`) lost `ceiling`, `provenancePolicy`, `irbProtocol`, `tools[].scopes`, `skills` and `model.fallback`, none of which the loop read in this build; the first three moved to `AgentListing`, scopes and skills return with their units, and refuse-not-swap is the gateway's only behavior so a field saying so added nothing. `loopContract` and `retrieval.algorithm` are now read: `verifyRunnable` compares them with the deployment's `LOOP_CONTRACT` and the KB reader's algorithm, and `drive()` calls it at every run start through `LoopDeps.deployed()`, finishing `unrunnable` with the problems as the reason. `kb_search` reads up to `retrieval.readCapTokens` (through `ToolContext.retrieval`) instead of its own 2,000-token constant. A built-in's hash is `toolSpecHash`: the name, description, input JSON schema, reads, effects, egress and idempotent fields, so an edit to what the model sees moves every agent version that uses it; the glue code around a built-in is core, pinned by the loop contract. `test/agent.test.ts` pins the field rule.
- **Payload addresses are keyed.** `PayloadStore.put` names a body by HMAC-SHA256 under a key, not by plain sha256. Addresses sit in events that leave the store (the run record, `GET /runs/:id/events`), and an unkeyed digest would let a reader confirm a guessed body such as a participant id against them. Dedupe by content holds within one store and one class; two stores with different keys address the same bytes differently, which is the point. KB entry hashes and snapshot ids are still plain content hashes and are also exposed through `tool.completed.retrieved`; that is the same class of leak for KB content and is left for the KB unit, which owns those hashes.
- **The web surface validates at the edge and never echoes a database error.** Bodies over 64 KiB get 413 before parsing, non-JSON bodies 400, a non-uuid `runId` 400 on `/replies` and 404 on `/runs/:id/events`, a stop for an unknown run 404. Any other error is logged with its stack and answered `{"error":"internal error"}`. **Known gap, deferred to the identity unit:** none of the four routes authenticates the caller, and none authorizes the caller for the run. `POST /message` trusts the `user` field it is sent; `POST /stop` stops any run whose id the caller knows; `GET /replies?runId=` returns the answer text, which may be D3, to anyone with the id; `GET /runs/:id/events` returns the record (refs, no bodies) to anyone with the id. Until that unit lands, the web surface is for the slice checks and a laptop, not a deployment.
- **The fence locks the job row, and one run per thread is an index.** The fenced append's existence check read its own snapshot, so a stale holder whose statement was in flight while a new claim committed still landed its event (the record test reproduces the interleaving with the claim held open in a transaction). The append now takes `FOR UPDATE` on the lease row first, so the fence is evaluated after any claim in flight commits and the stale holder gets `LeaseLost` with nothing written; the new holder's first append never collides. Two claims of two jobs in one thread could both lease (each saw the other's job as queued); `one_leased_run_per_thread`, a unique partial index on `jobs (thread_key) where status = 'leased'`, makes the loser's update fail and its claim return nothing.
- **Three worker and surface nits.** A heartbeat that throws is logged and retried on the next tick, not treated as a lost lease and not left as an unhandled rejection (which killed the worker process). `askConfirm` on the web surface is idempotent by `(run_id, key)` with the call id or `stop` as the key, through a unique partial index, so a resumed run that asks again posts nothing new. `--fault` is honored only when `LABH_FAULTS=1` is set, which only the slice harness does, and never when `NODE_ENV=production`; the worker binary refuses it before reading any config.
- **Three checks were made to bite.** Check 2 moved the lease epoch by hand with nothing else changed, so the stale worker's next seq is free and only the epoch condition can refuse it (with that condition neutralized, the stale worker finishes the run and the check fails). The web surface records every `finalize` call in `web_finalize_attempts`, so check 1 asserts one call and check 2 asserts two calls for one reply; the unique index on replies alone could not tell a double post from a single one. Check 8 reads the hosted fake's counter around every check and asserts it moved only for check 4's D1 control.
- **The boundary scanner was a line scanner.** It read text with regular expressions and was replaced in the third round, after a second review found routes it missed; the section below records what replaced it and why.

### Third round: the choke point holds structurally

Two fixes to "one choke point" had failed the same gate. Both assumed that a text check over the sources could prove there is no second route to the network and that a compile-time brand proves a `Labelled` is genuine. The census before the third round: the regex scanner reported 22 of the 43 routes now planted in `scripts/boundaries.ts`, and an unsealed process reached the hosted fake through 20 of 23 runtime routes. The premise was wrong in both halves, so the guarantees were rebuilt to hold without it.

- **Network, three layers, each with a planted census.** The static layer is the TypeScript program described under the egress choke point, with 43 planted routes and 5 controls in `test/boundaries.test.ts` and slice check 9. The runtime layer is `seal.ts`: `platformFetch` taken at module load, `sealNetwork()` called by each binary before `boot()`, so a tool imported afterwards that takes `fetch` at its own top level takes the stub; `test/seal.test.ts` runs the 23 runtime routes in a sealed child (0 leak, `pg` still connects) and slice check 12 runs a planted `kb_search` whose body calls a `fetch` it took at module load, with the scanner not run, and sees three `tool.failed` with "network is sealed" and the hosted counter unchanged. The process layer is Node's permission model. Measured on Node 26.10: `--permission` denies child processes, worker threads, addons, wasi, ffi and `process.binding` by default; `--allow-net` exists but is all or nothing (no host list), and without it `pg` fails with `getaddrinfo ERR_ACCESS_DENIED`; `module.registerHooks` works under it. The binaries therefore run under `node --permission --allow-fs-read=* --allow-net`, refuse to start otherwise (`requireProcessPermission`), and the network itself stays open for Postgres and the model endpoints. `compose.yaml` and the README carry the flags.
- **Labels verified at run time.** `Labelled.is()` and `Prompt.is()` ask `#brand in x`, which no `JSON.parse` result, literal or `Object.create(prototype)` satisfies. `decideEgress` takes the `Labelled` itself, never a bare class, and refuses anything else with the code `unlabelled`; the gateway refuses a non-`Prompt` the same way and records the payload as `unverified`; `derive` and `Prompt.of` throw `Unlabelled` for a forged input; the store refuses with `StoreRefused`, which is terminal for the run; `postReply` takes a `Labelled<string>`. Tests forge both ways at every one of those points.
- **The class is in the payload address.** Identical bytes shared one row across classes, so "thanks" stored by a D3 channel made a D0 user's "thanks" read back D3 and be refused at a hosted model, and the refusal revealed that the bytes exist at D3. The address is now HMAC-SHA256 of `(class, plaintext)`, one row never spans two classes, a row's class never changes, and a read refuses a row whose class is not the ref's. The two concurrent class raises that could trip the old trigger no longer exist.
- **Keys and rotation.** One master key per store (`key_id`), from which HKDF-SHA256 derives an address subkey (info `labh:payload:address:v1`) and a cipher subkey (`labh:payload:cipher:v1`); neither the master nor one subkey ever serves both purposes. The rotation story, written before any data exists: a rotation introduces a new master under a new `key_id`; the cipher side rotates by a sweep that reads each row under the old key and writes `ciphertext`, `nonce` and `key_id` together, which is the one rewrite the `payloads` trigger allows (a redaction is the other, and a redacted body cannot come back); the store reads rows under the current key and, once the sweep lands, under the previous one too, so rows are readable throughout. **Not built yet:** the sweep and the previous-key read do not exist. Today the store holds one key and refuses a row whose `key_id` differs (`key-mismatch`), so rotating the master before they are built makes every older payload unreadable. Do not rotate until they land; this is tracked as a known gap. The address side does not rotate: the address subkey derives from the master and addresses sit in hash-chained events, so after a master rotation new puts of old bytes make new rows (no dedupe across keys), old refs keep resolving, and nothing is rewritten. If a lab needs addresses stable across rotations, the address subkey moves to its own never-rotated master; that is the only change the scheme would need, and the info strings are fixed for the life of the data either way.
- **Network packages are one list, judged by where an import lands.** A review of this round found that the runtime hook blocked only builtins, so a tool could open a socket through core's copy of `pg`, by a file path or through core's resolver, while the static scanner kept its own package list. `seal.ts` now owns `NETWORK_PACKAGES` and `networkModule()`, the scanner imports them, and the hook checks the specifier's name before resolving and the resolved URL's last `node_modules` package after, so a path into `node_modules/pg` is still `pg`. Only `db.ts`, `surfaces/web.ts` and the allowed packages themselves may load one. The census has 25 runtime routes; before the fix the two `pg` routes reached out. A follow-up review found the package allowance was a substring test (`/node_modules/pg/` anywhere in the importer's path) and the resolved-URL match was case-sensitive. The allowance is now anchored to the real directory of core's copy, and the match is lowercased. Neither was reachable from a tool: any file whose resolved path sits under `node_modules/pg/` is already refused by the resolved-URL check, so the lookalike and upper-case routes added to the census are refused one layer earlier, and their red could not be shown. They stay as defense in depth, and the census asserts every route it tries is refused.
- **Migrations.** `db.ts` applies `packages/core/migrations/NNNN_name.sql` in order, once each, recorded in `schema_migrations`, all pending ones in one transaction under an advisory lock; a database from before the ledger existed has its first migration recorded rather than reapplied. `0001_initial.sql` is the former `schema.sql`; `0002` changes the payloads trigger and adds `freezes.listing`.
- **The loop contract is guarded.** `test/loop-contract.test.ts` fingerprints `next()` over 201,600 generated run states and pins it under `LOOP_CONTRACT` in `test/loop-contract.json`; a change to the loop or its retry table fails the suite until the name is bumped and pinned (checked by mutation). The contract is `loop-v2`, since the semantics moved after `loop-v1` was named.
- **Errors and ordering.** A blip while opening the journal hands the job back like a blip inside the loop (check 10, third leg); the handback bound counts consecutive handbacks with no progress, so a claim that journaled something before it blipped starts the count over (`retry-after-progress`); `consumeInbox` rolls back from memory only what it pushed, and a `LeaseLost` with the lease still held (the in-memory record fell behind) hands the job back instead of leaving it leased until expiry; the claim serializes a thread behind earlier jobs that are queued or waiting, not only leased ones; a tool's error text is stored at the join of everything the tool touched, like its output.

### KB compile and retrieval (P1 unit 3)

`pnpm unit3`. Where the code differs from the sketch above or from slice 1:

- **`kb_search` returns hits, `kb_read` returns entries.** Slice 1's `kb_search` read the hits' bodies itself. Now `kb_search` returns `{kb, path, title, score}` and `kb_read` returns whole entries in the order asked, stopping before the first one that would pass the cap, and lists the omitted and missing paths. Both journal every returned entry hash in `tool.completed.retrieved`. Each built-in's version is its `toolSpecHash`, the slice 1 rule; `kb_search`'s description changed with its output, so its hash moved. The tools read the cap through `ToolEnv.retrieval`, the hashed `RetrievalSettings`.
- **The read cap is an agent document field.** `readCapTokens` on the document resolves into `ResolvedAgent.retrieval.readCapTokens`, default 15,000, so a cap change is a behavior change and changes the hash. The estimate stays 4 characters per token over title and body.
- **Compile lives in `kb-compile.ts`**, beside `kb.ts`, which keeps snapshots, the reader, `bm25-v1` and diff. `kb-compile.ts` joins the `Labelled.stamp` allowlist because source and definition text enter a prompt there.
- **An entry's hash is its payload hash, and both are keyed.** The slice 1 fix round made payload addresses HMAC-SHA256 under the store key and left KB names to this unit. Entry hashes, snapshot ids and `SourceRef.contentHash` now come from `PayloadStore.address` (`keyedAddresser` in `hash.ts`), the same function `put` uses, so the manifest still addresses the store directly and a reader of `tool.completed.retrieved` or a manifest cannot confirm a guessed entry, manifest or source. Fixture snapshots are keyed too (`snapshotFromFixture(json, address)`), so one fixture has a different snapshot id under each store key. Loading a snapshot rechecks the manifest id and every entry hash under the key. Each entry is stored at the join of the sources it came from, which can be below the snapshot class; the reader still stamps everything it returns with the snapshot class.
- **Paths are sorted everywhere.** jsonb reorders object keys, so outline, index and reads take paths in sorted order. A snapshot read back from Postgres behaves exactly like the one written, and the fixture loader's outline order changed to match.
- **The manifest gained `title`, and `SourceRef` gained `location`.** Source kinds are `file` and `url` only, and `participantKey` is gone until dataset sources exist.
- **Keys.** The job key hashes the whole definition (title, purpose, questions, IRB and consent fields, compiler target), the source refs and the prompt hash, not only source hashes plus compiler: the purpose is in every compile prompt and the questions drive coverage. A source result is cached under (source id, content hash, purpose, compiler target, prompt hash). A coverage verdict is cached under (question, candidate entry hashes, compiler target, prompt hash), so editing one source re-judges only the questions whose candidates include a changed entry. The cache is the `kb_compile_cache` table, with result bodies in the payload store.
- **`createdAt` is the job's request time**, so one job always yields one snapshot id however often it restarts.
- **Coverage is bm25 candidates plus one judge call per question,** through the gateway and the audit stream. A question with no bm25 candidate is a gap without a call. `publishSnapshot` refuses a snapshot with any gap and records `kb.publish-refused`, unless the publisher passes an override with a non-blank note (`kb publish --override-gaps <note> --actor <publisher>`; the command refuses an override without `--actor`, since `cli` names no one). The manifest is immutable, so the override is kept beside it: one transaction appends `kb.published` with `override: {note, gaps}`, inserts a `kb_coverage_overrides` row (insert-only by trigger, pointing at that audit seq) and moves `kb_heads`. `renderCoverage` lists each override under the gaps. An override on a snapshot with no gaps is an error. Who may publish is the identity unit's; until then the publisher is the name the caller gives.
- **The audit stream exists now** (`audit.ts`): `audit_events` hash-chained under one advisory lock, with `call` events wrapping the `RunEvent` a gateway call or a URL source read recorded plus its context (`kb-compile` with the job and step, or `kb-source` with the source), and `kb.compiled`, `kb.compile-failed`, `kb.published`, `kb.publish-refused`. `appendAudit` takes a callback that runs inside its transaction, so a state change commits with its audit row.
- **Retries and refusals.** Each compile call gets up to 3 attempts, and a reply that does not parse counts as one. An egress refusal ends the job at once as `failed`. A compile interrupted by a lost lease or a worker stop returns `lease-lost`, so the next claim resumes from the cache. Asking again for a key whose job failed queues that job again (`Queue.retryFailed`), because a transient failure should not pin the key.
- **A compile's class is fixed before its first call.** `compileKb` joins the source classes first and derives every compile and coverage prompt with that class as its floor, so a compiler that may not see the snapshot's class sees none of its sources: the gateway refuses the first call and the job fails as `snapshot class <C> refused by egress`, with zero requests sent. Placement checks stay in the gateway. The refused call's audit context names whichever source or question came first, and its `payload` is the snapshot class. Cached source results and verdicts keep the class of what they were made from; the floor is policy, not content, so a D1 source compiled for a D3 KB is not cached as D3.
- **URL sources are one GET at request time, in the requesting process, through the HTTP choke point.** `HttpEgress` in `tools.ts` is the `http` destination's one caller of `decideEgress`; `ToolContext.fetch` (after its declared-host check) and `readSources` both use it, and `boot` builds one per process from `[policy]` and `[hosts]`. The request carries the URL, which is definition text, so it leaves at `DEFINITION_CLASS` (D1) to `placementOfHost(host)`. An unlisted host is public, ceiling D0, so a URL source needs its host listed at a placement that admits D1, typically the lab wiki at `lab`; a public article cannot be a URL source without declassifying the definition, which v1 does not do. A refusal is a `call` event with an `egress.refused` in the audit stream, the command fails with `EgressRefused`, and no job is queued. The boundary scanner now fails on `typeof fetch` outside `gateway.ts` and `tools.ts`, which is how a module receives the network without naming the global; the planted case is the old `readSources` signature. `boot` lost its optional fetch parameter, which the rule caught and no caller used. HTML is reduced to text by a few regular expressions. PDF sources are refused: text extraction without a dependency is not trivial.
- **The definition's own text (title, purpose, questions) is D1** (`DEFINITION_CLASS`), as instructions default to D1, unless the gate's detectors or the lab's patterns find something in it (rebase section below).
- **Published KB heads are read per message.** `Core.catalog` and `IntakeDeps.catalog` are functions that read `kb_heads` on every call, and intake calls one per message, so the next message after a publish resolves to the new snapshot with no restart and no NOTIFY. The worker asks per run which of the version's pinned snapshots the store holds (`LoopDeps.deployed(agent)` is async and per agent; `KbReader.has`), replacing slice 1's set of fixture ids built at boot. unit3 check 9 publishes from a separate process while web and worker run.
- **The compiler's default `maxOutputTokens` is 8,192.** Ollama returns qwen3's reasoning in a separate field that still spends the token budget, and a small budget yields an empty reply.
- **Postgres's host port is `LABH_PG_PORT`** (default 5432) in compose and in the checks.
- **The check scripts share `scripts/procs.ts`.** `checker(ps, {only, counter})` keeps slice 1's `--only` filter and per-check hosted request count.


### The KB unit on the sealed core

The KB unit was written before the network seal and the run-time labels landed. When it joined them, each conflict was settled so the seal ends at least as strict as before:

- **`boot()` keeps the sealed core's signature.** The KB unit passed a `fetch` into `boot` and from there into the tool runner and gateway; the sealed core's `boot(configPath, env, options)` takes planted tools and no fetch. Kept the sealed core's, and added the KB unit's first store-backed snapshots, published heads and `HttpEgress` beside it. No caller can hand core a network function.
- **`HttpEgress` defaults to `platformFetch`, not the global.** The KB unit's first `createHttpEgress` defaulted to the global `fetch`, which the core's seal replaces. It now takes the fetch the seal captured, as the sealed core's tool runner did, and `tools.ts` stays one of the two files that may import it.
- **`HttpEgress.request` takes the `Labelled` payload, not a class.** The sealed core's `decideEgress` takes a `Labelled` and checks its brand at run time; the KB unit's first request passed a bare class. `ToolContext.fetch` passes the input body, and a KB URL source passes its URL stamped at `DEFINITION_CLASS`. The refusal event still records the class.
- **The boundary scanner is the sealed core's symbol scanner; the KB unit's first regex rules are not ported.** The KB unit's first two rule changes become entries in the sealed core's `ALLOWED` table: `kb-compile.ts` may stamp (it was on the KB unit's first stamp list). `scripts/procs.ts` gets what `scripts/slice1.ts` already had (network globals, `child_process`), because slice 1's process helpers moved there. `scripts/unit3.ts` gets `module:http` for its fake wiki. The KB unit's first "fetch passed in" rule (`typeof fetch` outside the network files) is not ported. Main lists a `typeof fetch` type position as a legitimate control, because a passed-in value can only start as `platformFetch`, whose import only the gateway and the tool runner have, or as the global, which the scanner reports anywhere else and the seal replaces. The KB unit's goal for that rule, URL sources through the choke point, is met by `readSources` calling `HttpEgress`.
- **The kb command seals itself.** `bin/kb.ts` now starts like `web.ts` and `worker.ts`: `requireProcessPermission()`, then `sealNetwork()`, so it refuses to run without `--permission`, and `scripts/procs.ts` passes `PERMISSION_FLAGS` to every child it starts (slice 1's own helper did; the moved one did not).
- **Addresses commit to the class (sealed core), and KB names follow them.** The sealed core's payload address is HMAC-SHA256 of the class, a newline and the plaintext, under an HKDF address subkey. The KB unit's first `Addresser` hashed the value alone under the master key, so an entry hash would no longer equal its payload hash. `keyedAddresser` in `hash.ts` now implements the sealed core's address exactly (same subkey info, same bytes, so existing payload addresses do not move), takes `(cls, value)`, and `PayloadStore.put` uses it. Source content hashes are at the source's class. Entry hashes and snapshot ids are at the snapshot's class.
- **KB entries are stored at the snapshot's class.** The KB unit stored each entry at its own (possibly lower) class but loaded every entry with the snapshot's class. The sealed core's store refuses a ref whose class is not the row's, and the manifest names only the snapshot's class. Entries now go in at the snapshot's class, which is at least each entry's own, so nothing reads lower than before. The reader already labelled every hit at the snapshot's class. The cost: an entry shared by two snapshots of different classes is two rows, and a diff between such snapshots shows every entry as changed. The coverage judge still sees each candidate at its own class.

- **A declared class is a floor at compile (review fix).** Before this, a compile took the steward's declared source classes as the snapshot class and stamped the definition's text at D1, and nothing in compile ran `classifyText`. So a D1-declared document quoting a participant id, or a purpose naming one, went to whatever compiler the definition named, and its entries were served at D1. Main had no compile path, so this was a new route to a hosted model, outside the seal and inside the class policy. Now `readSources` raises each source's class with `classifyText(text, declared, lab patterns)`, and a URL source's request is labelled the same way. `compileKb` classifies the title, purpose and coverage questions together (`definitionClass`) and floors the snapshot class with it, so either case compiles at D3 and a hosted compiler refuses the first call. This covers what the gate's detectors and the lab's `participant_id_patterns` can see. An identifier no pattern matches is still trusted at its declared class.
- **The `kb-compile.ts` stamp allowance is what lets definition and source text enter a prompt with a class**, so it carries policy weight: those stamps now take the classified class, not a constant.
- **Open, not fixed here: the prompt text is not pinned by the version hash.** The KB unit changed the system prompt (the outline names the KB id, and the retrieval contract was added) while `LOOP_CONTRACT` stays at its value, and `test/loop-contract.test.ts` fingerprints only `next()`. Two runs of one version hash on builds either side of such a change get different prompts. This predates the rebase; the fix is a prompt-format version in the resolved agent or in the loop contract.


#### Check script fixes

The first full run of the checks found bugs in the check scripts, not in the harness:

- **unit3 read kb output with a bare `JSON.parse`.** The process helpers in `scripts/procs.ts` merge stderr into a process's output, and node 26 prints an ExperimentalWarning for `--allow-net` (with the child's PID) before the JSON. Checks 1, 3 and 8 failed on the parse and 4, 5 and 9 failed on their dependence on 1 and 5 (3/9). unit3 now reads the last JSON line, as lab0 already did since review 1, and compares the two search processes by parsed hits rather than by raw text, since the warning line carries a different PID per process.
- **lab0 check F asserted `{ ok: true }` for a publish with an override note.** The kb CLI answers an override with `{ ok: true, overridden: [...] }` (unit3 check 8 pins that contract), so check F failed at its setup step, not at its rule. prereg-v2 F says the roster is published "with an override note if coverage has gaps"; the publish result is not part of the rule, which is the hosted counter and the run outcome. The setup assertion now expects the overridden list equal to the compile's gaps. The first run's check F is recorded as a FAIL in that run's results; questions.json and prereg-v2.json are unchanged.
- **unit3 check 5 compared `kb diff` text exactly**, and failed on the same warning line once checks 1 and 5 could run (second run: 8/9, lab0 9/9). unit3's `kb()` now drops node's own warning lines (`(node:PID) ...` and the `--trace-warnings` hint) before any check reads the output.

- **lab0 check F passed whatever class the roster KB had.** Its hosted agent inherited ceiling D3 from `fixtures/agent.json`, so intake refused it for the ceiling alone. The agent now has ceiling D1 and a protocol, and F asserts a 403 whose message says the KB is D3, above the agent's ceiling D1. `prereg-v2.json` is unchanged.

### Unit 2: studio and publish

`pnpm unit2`. Payload CMS 3.92.0 on Next.js 16.3.3, quarantined in `packages/studio`. Where the code differs from the sketch:

- **The studio runs outside the permission model and outside the seal, and builds no model gateway and no tool runner.** Next starts child processes and worker threads and loads native addons, which is exactly what `--permission` denies, so Next cannot run under it: `next dev` under `node --permission --allow-fs-read=* --allow-fs-write=* --allow-net` exits at start with `ERR_ACCESS_DENIED` (`ChildProcess`) when it forks its server, and allowing child processes, workers and addons would leave the model nothing to deny. The seal's module hook would also refuse Next's own server and Postgres client. So the studio is an unsealed process by design, and the decision is what it may hold. It reaches core through one entry, `@labh/core/studio` (`studio.ts`), whose `bootStudio` boots from `boot-shared.ts`: config, Postgres, the payload store, the queue, the HTTP choke point, the catalog and intake. `boot.ts` adds the gateway, the KB reader, the tool runner and the surfaces for the sealed binaries. `test/boundaries.test.ts` fails if anything the studio entry loads calls `createGateway` or `createToolRunner`. The modules `gateway.ts` and `tools.ts` are still loaded, for prompt types, tool manifests and `HttpEgress`; nothing in the studio constructs a gateway or a runner from them. A test message and a KB compile are queued there and run by a sealed worker under the permission model, so every model call and every tool still runs in a sealed process. The boundary scanner refuses any other import of core under `packages/studio`, including `.tsx` files. It resolves each studio specifier the way the bundler does, through the `node_modules` symlink to the real file, so a relative path, a path through `node_modules/@labh/core` and an absolute path into `packages/core` are all caught; each has a planted case in `PLANTS`. What the studio process does run is the publish code, intake for test messages, `readSources` and KB publish, the same functions the web door and the `kb` command run. A URL source in a KB definition is fetched by the studio process, through the same HTTP choke point (`HttpEgress`, which decides egress from `[policy]` and `[hosts]`), so policy is unchanged; the seal does not back it there. A URL source is fetched with `redirect: "manual"` and a 3xx is refused, because the redirect target never went through the egress decision. The core binaries' seal is unchanged.
- **The studio process holds the payload key and must not hold provider keys.** It needs `LABH_PAYLOAD_KEY` to put source text and test messages in the encrypted store, and that key decrypts every payload, D3 included. It has unrestricted global `fetch`. So start it from an environment without any endpoint's `api_key_env` variable; only the sealed worker needs those.
- **Publish is synchronous and keeps no ticket.** With validation as the only check, `requestPublish(deps, doc, actor)` returns the report at once, with the draft's content hash. `confirmPublish(deps, doc, draftHash, actor, changelog)` refuses a document that no longer hashes to what was checked (`stale`), an empty changelog, an invalid draft, or a role that may not publish, then inserts the version, moves `agent_heads` and appends the audit row in one transaction. Confirming the same draft twice is a no-op. The `publish-check` job, evals with answer diffs and router overlap join the report with their units; `PublishTicket` and `report()` were removed until then.
- **`agent_heads` has `version` and `draft_hash`** (migration 0003). `version` is what the document resolved to at publish, for the record and the panel. Intake still resolves the stored document per run, so a skill or KB publish floats to unfrozen agents. No head was written before 0003, so its NOT NULL columns need no default.
- **`agent.published` is an event in the audit stream.** `confirmPublish` reads the previous head under its own lock and appends with `appendAuditInTx`, inside its transaction, under the same advisory lock as every other append.
- **Roles follow the spec: member, author, publisher, data steward and PI** (`roles.ts`). A member uses agents and tests drafts below D3. An author drafts. A publisher publishes to the lab below D3. D3 and R need the data steward or the PI: an agent by its ceiling, a KB by its snapshot class. One table serves both. The spec names the PI for restricted agents and the steward for restricted KBs; either may publish either here, because a lab often has one person in both seats and the publish is recorded under the person's own id. The PI manages studio accounts and roles, and the first studio account becomes the PI. The study owner joins with the freeze unit. Roles live on the Payload user for now; the studio maps the signed-in user to core's `Actor` (email as member id) and core enforces the rule. Because the email is the id every publish, audit row and test run is recorded under, only the PI changes an email; a user editing their own account cannot. University sign-on replaces both. The `kb` command still names its publisher with `--actor` and checks no role: it is the steward's path from the repository.
- **A publish needs the role for everything it moves, not only the new document.** For an agent, the class checked is the join of the draft's ceiling, the ceiling of the head it replaces, and the ceiling of every head on a channel the draft binds (`publishClass` in `publish.ts`, read again inside the publish transaction). For a KB, it is the join of the snapshot's class and the current head's class (`kbPublishClass`). Without this, a publisher could lower a steward's D3 agent to D1 and take its head, publish a D1 snapshot over a D3 KB, or bind a new agent to a channel a D3 agent serves (newest publish wins the channel).
- **Previewing restricted drafts needs the same people as publishing them** (`mayPreview` in `roles.ts`). Below D3 any signed-in member tests a draft and reads a compile report, which is what the studio is for. A test of a draft whose ceiling is D3 or R, and the result of a compile whose sources join to D3 or R, need the steward or the PI. Otherwise the test thread would be a route to restricted data under an agent no steward or PI approved. A test run's replies are readable only by the member who started it (`isTestRunOf`, from the job's trigger), and a compile result for a missing job or snapshot is a 404.
- **Lab-rule errors block publish, not save.** A save needs a document that parses (required fields, formats), because a test run and the publish checks need a document. The lab rules (`validateAgentDraft`: the description's "Use when" and "Not for", an exact model id, an endpoint that may receive the ceiling, KB classes) do not block the save; the publish panel lists them, there is no publish button while any fails, and `confirmPublish` refuses past them. A draft whose rules fail still runs in the test thread up to intake, which refuses it with the same message.
- **Intake runs the head bound to the channel.** `agentFor` is async and returns the most recently published head whose `channels` list names `surface:channel`, else the fixture agent. The router replaces this for unbound channels.
- **Test runs go through `intakeTest`**, the same gate, resolution, version upsert and queue as `intake`, with trigger `test` and key `test:<surface>:<channel>:<thread>:<message>`. The studio's thread is a web thread in channel `studio`, so replies land in `web_messages`.
- **Form fields are generated in `packages/studio/fields.ts`**, for agents from `agentDocumentSchema` and for KB definitions from `kbDefinitionSchema`. Labels and help text come from zod `.meta()` in core. A discriminated union becomes a group whose control is a select labelled "Type" (or a checkbox labelled by the `true` branch) with each branch's fields shown by condition. Presentation that is not about the document's meaning (textareas, unique ids) is a small map in the collection, checked against the generated paths. The generator declares the slice of Payload's field types it writes instead of importing them, because Payload's types load Next's `ProcessEnv` augmentation into the core test program. `test/studio-fields.test.ts` fails if a schema path of either schema has no generated field.
- **KB authoring in the studio calls the `kb` command's functions.** The KB form is generated from `kbDefinitionSchema`, which `parseKbDefinition` also parses definition files with. Its panel compiles the saved definition (`parseKbDefinition`, `readSources`, `requestCompile`; a sealed worker runs the job), shows the coverage report (`compileResult`, `renderCoverage`), and publishes (`publishSnapshot`), over the gaps when the publisher writes a note. The studio adds only the role checks (preview for the report, publish for the head) and a check that the snapshot is a compile of this definition. The class floor (declared class raised by the detectors and `participant_id_patterns`, the URL label, the definition's text) applies unchanged, because it lives in `readSources` and `compileKb`.
- **Source files are attached at compile time and never stored in Payload's tables or on the studio's disk.** The browser reads the attached `.md` and `.txt` files and posts their text. `readSources` takes a `SourceFiles` reader rather than a directory: the studio passes `attachedFiles`, which serves the posted text from memory, and the `kb` command passes `filesIn(dir)`. `requestCompile` then puts the text in the encrypted payload store. A file source's location is a bare file name: `kbDefinitionSchema` refuses a `/`, `\`, `:`, `.` or `..` location and two file sources with the same name, and `filesIn` refuses a path again. Before this, the studio wrote attachments to a temporary directory but `readSources` read `location` resolved against it, so an absolute or `../` location read any `.md` file on the studio host at whatever class the author declared.
- **Studio tables hold definitions and instructions in plaintext, so they must hold no D3.** Agent names, descriptions and instructions, and KB titles, purposes and coverage questions, are stored in `studio.*` with up to 100 revisions each, unencrypted. No detector runs on them at save. A lab that needs participant-level detail in an instruction or a coverage question keeps it out of the studio; the KB's sources, which may be D3, go through the encrypted store as above.
- **Payload's own compare view does the revision diff and restore.** Verified in `pnpm unit2` check 3: the newest revision compares against the previous one field by field, and "Restore this version" makes a new revision with the old content. Its pills read "Revision", because with drafts off Payload calls every revision "published".
- **Payload's document lock is off for agents and KB definitions.** It blocked members who only read and test. Concurrent saves stay safe: each save is a revision, publish refuses a stale draft hash, and a compile reads the saved definition.
- **Payload's tables are in schema `studio`** through the adapter's `schemaName`, which Payload marks experimental. Tables are pushed by Payload in dev mode; `pnpm unit2` runs `next dev`. A production build with committed migrations is not built yet.
- **Next bundles core into the studio's server code.** Turbopack bundles a workspace package whatever `serverExternalPackages` says (the built chunks hold core's source), so the studio runs the same core source as the worker, compiled by Next. Core keeps that working by reading its migrations through a file path rather than `new URL("../migrations/", import.meta.url)`, which the bundler tries to resolve as an asset.
- **No check-script process outlives its script.** `scripts/procs.ts` starts `next dev` in its own process group and stops the group. Its exit and signal handlers are registered once per script, at module load, and when the script exits on an uncaught error or is sent SIGINT, SIGTERM or SIGHUP they kill every group it started and every other direct child, such as the browser Playwright launches. `test/procs.test.ts` fails without each part, and `pnpm unit2` ends by counting what is left.
- **The studio does not keep a failed boot.** If Postgres is down at the first request, the cached boot promise is cleared and the next request boots again.
