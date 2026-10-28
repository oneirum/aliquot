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
| `pnpm unit2` | After a change to `packages/studio`, publish or roles. Needs Chromium: `pnpm exec playwright install chromium` once, or `LABH_CHROMIUM` set to a Chromium on disk. |

Each check script creates its own database (`labh_slice1`, `labh_unit3`, `labh_lab0`, `labh_unit2`) and writes logs to a dot folder of the same name.

## Rules that the checks enforce

- `decideEgress` in `packages/core/src/dataclass.ts` is the only egress decision. Do not call it from a new file. `test/boundaries.test.ts` fails when a file outside the allowed set calls it.
- Do not import `node:http`, `node:net`, `fetch`, `undici`, `ws`, `pg` or a vendor SDK outside the files allowed in `scripts/boundaries.ts`. A tool reaches the network only through `ctx.fetch`.
- The binaries run under Node's permission model (`node --permission --allow-fs-read=* --allow-net`). They refuse to start without it.
- `ResolvedAgent` in `packages/core/src/agent.ts` holds exactly what the run loop reads, and its hash is the agent version. If `loop.ts` reads a field, the field belongs in `ResolvedAgent`.
- Data classes only go up. There is no declassify.
- The studio (`packages/studio`) imports core only through `@labh/core/studio`. The scanner fails on any other import. The studio never calls a model; it enqueues jobs for the sealed worker.
- The files in `fixtures/lab0/` that hold pre-registered questions and pass rules (`questions.json`, `prereg-v2.json`) are fixed. Do not edit them to make a check pass.

## Tools

Folder discovery is not built yet: `loadRegistry` in `packages/core/src/tools.ts` throws, and runs use only the built-in `kb_search` and `kb_read`. A tool written now follows the format in `tools/openalex_search/tool.ts`: a default export of `defineTool({...})` from `@labh/core/tool-kit` that declares `reads` (the class of what it returns), `effects` and the `egress` hosts it may reach. Wiring discovery is the tools unit in `docs/design/SLICE.md`.

## Where things are

- `packages/core/src/loop.ts` holds `next()`, the whole run policy as one pure function.
- `packages/core/src/record.ts` holds the run record: fenced append, encrypted payloads and `fold()`.
- `packages/core/src/gateway.ts` is the only module that talks to models.
- `packages/core/src/kb.ts` holds snapshots, `kb_read` and BM25 search. `kb-compile.ts` holds compile and the coverage check.
- `docs/design/DESIGN.md` explains why each of these is shaped the way it is.
