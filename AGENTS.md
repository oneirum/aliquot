# AGENTS.md

Instructions for a coding agent working in this repository.

## Set up

1. Check the tools: `node -v` must print v26 or later, `pnpm -v` must print 10, and `docker info` must succeed.
2. Install dependencies: `pnpm install --frozen-lockfile`.
3. Start Postgres: `docker compose up -d postgres`. If port 5432 is taken, export `LABH_PG_PORT=55433` (any free port) before this command and before every `pnpm` command below.
4. Verify: `pnpm typecheck`, then `pnpm test`, then `pnpm lab0`. Each must pass before you change anything.

No API key is needed. The checks use scripted fake models. Only the last check of `pnpm slice1` and `pnpm unit3` calls Ollama; pass `--skip-ollama` when Ollama is not running.

## Run the checks

| Command | When to run it |
|---|---|
| `pnpm typecheck` | After any change. |
| `pnpm test` | After any change. Runs `node --test` over `test/`. |
| `pnpm slice1 --skip-ollama` | After a change to the run loop, queue, record, gateway, gate or seal. |
| `pnpm unit3 --skip-ollama` | After a change to knowledge bases, compile or publish. |
| `pnpm lab0` | Before you finish. The first-use check on the synthetic lab. |
| `pnpm unit2` | After a change to `packages/studio`, publish or roles. Needs Chromium: `pnpm exec playwright install chromium` once, or `LABH_CHROMIUM` set to a Chromium on disk. `--proof <dir>` also saves the agent and knowledge base pages in both themes, at 1440 and 390 wide, for a UI change. |

Each check script creates its own database (`labh_slice1`, `labh_unit3`, `labh_lab0`, `labh_unit2`) and writes logs to a dot folder of the same name.

## Rules that the checks enforce

- `decideEgress` in `packages/core/src/dataclass.ts` is the only egress decision. Do not call it from a new file. `test/boundaries.test.ts` fails when a file outside the allowed set calls it.
- Do not import `node:http`, `node:net`, `fetch`, `undici`, `ws`, `pg` or a vendor SDK outside the files allowed in `scripts/boundaries.ts`. A tool reaches the network only through `ctx.fetch`.
- The binaries run under Node's permission model (`node --permission --allow-fs-read=* --allow-net`). They refuse to start without it.
- `ResolvedAgent` in `packages/core/src/agent.ts` holds exactly what the run loop reads, and its hash is the agent version. If `loop.ts` reads a field, the field belongs in `ResolvedAgent`.
- Data classes only go up. There is no declassify.
- The studio (`packages/studio`) imports core only through `@labh/core/studio`. The scanner fails on any other import. The studio never calls a model; it enqueues jobs for the sealed worker. Sidebar panels use the classes in `packages/studio/components/styles.ts` (`PanelStyle`) and `Status.tsx` for busy, done and error states. A new panel that calls the studio's API from the browser needs its own `network-globals` line in `scripts/boundaries.ts`.
- The files in `fixtures/lab0/` that hold pre-registered questions and pass rules (`questions.json`, `prereg-v2.json`) are fixed. Do not edit them to make a check pass.

## Tools

Aliquot runs eleven built-in tools. `packages/core/src/tools.ts` defines `kb_search`, `kb_read`, `dataset_list`, `run_code`, `openalex_search`, `pubmed_search` and `arxiv_search`. `packages/core/src/literature.ts` defines `europepmc_search`, `europepmc_fulltext`, `doi_lookup` and `citation_walk`; `jats.ts` reads Europe PMC's article XML. `builtinTools()` lists all eleven. A lab cannot add its own tool: every binary refuses a `lab.toml` with a `[tools]` table, and nothing loads a tool folder. Contributed tools are planned, behind an OS-level boundary. Each tool is `defineTool({...})` and declares `reads` (the class of what it returns), `effects` and the `egress` hosts `ctx.fetch` may reach. A tool's version is the hash of its spec (`toolSpecHash`): the description, the input schema and those policy fields. A redirect is followed only to a host in `egress`, and each hop passes `decideEgress`. Each tool has a test that runs it through the tool runner, the literature tools against a fake API (`test/tool-harness.ts`) serving the recorded responses in `test/literature-fixtures/`. Every literature host is public, so a literature tool sends nothing for a question above D0; each test file checks that. Do not add a source that needs a key or an account, or whose terms limit use to individuals; `docs/design/DESIGN-v03.md` says why alphaXiv is not built in. `--plant-tool` on the worker binaries loads a test module as a tool, and only under `LABH_FAULTS=1`, which only a test harness sets.

`run_code` needs the image: `docker build -t aliquot-sandbox sandbox`, then pin `docker image inspect --format '{{.Id}}' aliquot-sandbox` as `[sandbox] image`. `test/run-code.test.ts` skips when no daemon answers or the image is not built. A dataset directory must be readable by uid 65534, the container's user.

## Agent backends

An agent may run on Claude Code or Codex instead of a model endpoint (`[agent_backends.<id>]` in `lab.toml`). The code is in `packages/core/src/agents/`. The CLI is one hosted model destination: its task prompt and every bridge reply pass `gateway.admit()`, so the egress call sites stay at five.

- `confine.ts` builds the macOS seatbelt profile, which starts from `(deny default)`. Each allowance names the CLI that needed it. Add one only after a probe under `(deny default)` shows the CLI fails without it, and say which CLI in the comment.
- `backends.ts` holds one `KindSpec` per CLI: argv, the line parser and the self-check. A tool call outside the bridge ends the run as `agent-not-confined`.
- `test/agent-confinement.test.ts` runs a probe under the real profile and asserts one denial per gap. It skips off macOS.
- `pnpm demo:agent --backend claude-code` (or `--backend codex --model <id>`) runs a real CLI on the operator's own login through `dev_shared_login`. That login is a public placement, so the agent sees D0 only. It is a developer's smoke test, not a lab deployment. See "Live smoke resolution" in `docs/design/DESIGN-v02.md`.

## Where things are

- `packages/core/src/loop.ts` holds `next()`, the whole run policy as one pure function.
- `packages/core/src/record.ts` holds the run record: fenced append, encrypted payloads and `fold()`.
- `packages/core/src/gateway.ts` is the only module that talks to models.
- `packages/core/src/kb.ts` holds snapshots, `kb_read` and BM25 search. `kb-compile.ts` holds compile and the coverage check.
- `docs/design/DESIGN.md` explains why each of these is shaped the way it is.
