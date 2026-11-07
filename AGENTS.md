# AGENTS.md

Instructions for a coding agent working in this repository.

## Set up

1. Check the tools: `node -v` must print v26 or later, `pnpm -v` must print 10, and `docker info` must succeed.
2. Install dependencies: `pnpm install --frozen-lockfile`. Then `pnpm run doctor` repeats step 1 and checks the ports and the sandbox image; it prints `FAIL` lines with a fix and exits 1 if one is missing.
3. For a lab install, not the checks: `pnpm aliquot:init` writes `config/lab.toml` from a few questions and `.env` with new secrets when it is missing. It never rewrites `.env`. `pnpm aliquot:init --yes --sample <id>` takes the defaults without asking. It is the one binary command with write access, and only to those two files.
4. Start Postgres: `docker compose up -d postgres`. If port 5432 is taken, export `LABH_PG_PORT=55433` (any free port) before this command and before every `pnpm` command below.
5. Verify: `pnpm typecheck`, then `pnpm test`, then `pnpm lab0`. Each must pass before you change anything.

No API key is needed. The checks use scripted fake models. Only the last check of `pnpm slice1` and `pnpm unit3` calls Ollama; pass `--skip-ollama` when Ollama is not running.

## Run the checks

| Command | When to run it |
|---|---|
| `pnpm typecheck` | After any change. |
| `pnpm test` | After any change. Runs `node --test` over `test/`. |
| `pnpm slice1 --skip-ollama` | After a change to the run loop, queue, record, gateway, gate or seal. |
| `pnpm unit3 --skip-ollama` | After a change to knowledge bases, compile or publish. |
| `pnpm lab0` | Before you finish. The first-use check on the synthetic lab. |
| `pnpm walk:data` | After a change to `data_query`, `tables.ts`, `table-engine.py` or `Sandbox.aggregate`. Needs the sandbox image. |
| `scripts/compose-check.sh` | After a change to `Dockerfile`, `compose*.yaml`, `deploy/`, the studio's collections or migrations, `scripts/backup.sh` or `restore.sh`, or PDF reading. Needs only Docker; builds the images, so it takes a few minutes. |
| `pnpm unit2` | After a change to `packages/studio`, publish or roles. Needs Chromium: `pnpm exec playwright install chromium` once, or `LABH_CHROMIUM` set to a Chromium on disk. `--proof <dir>` also saves the agent and knowledge base pages in both themes, at 1440 and 390 wide, for a UI change. |

Each check script creates its own database (`labh_slice1`, `labh_unit3`, `labh_lab0`, `labh_unit2`) and writes logs to a dot folder of the same name.

## Rules that the checks enforce

- `decideEgress` in `packages/core/src/dataclass.ts` is the only egress decision. Do not call it from a new file. `test/boundaries.test.ts` fails when a file outside the allowed set calls it.
- Do not import `node:http`, `node:net`, `fetch`, `undici`, `ws`, `pg` or a vendor SDK outside the files allowed in `scripts/boundaries.ts`. A tool reaches the network only through `ctx.fetch`.
- The binaries run under Node's permission model (`node --permission --allow-fs-read=* --allow-net`). They refuse to start without it.
- `ResolvedAgent` in `packages/core/src/agent.ts` holds exactly what the run loop reads, and its hash is the agent version. If `loop.ts` reads a field, the field belongs in `ResolvedAgent`.
- Data classes only go up. There is no declassify.
- The studio (`packages/studio`) imports core only through `@labh/core/studio`. The scanner fails on any other import. The studio holds no payload key and core gives it no database handle: every read and write of core is a `/studio` route on the web door (`packages/core/src/surfaces/studio-door.ts`, one op per entry in `STUDIO_OPS` in `door-client.ts`), called with `[surfaces.studio]`'s token, and the door makes the role and class checks. `test/boundaries.test.ts` fails when anything the studio's entry loads reads the key. The studio never calls a model; the door queues jobs for the sealed worker. Sidebar panels use the classes in `packages/studio/components/styles.ts` (`PanelStyle`) and `Status.tsx` for busy, done and error states. A new panel that calls the studio's API from the browser needs its own `network-globals` line in `scripts/boundaries.ts`.
- The files in `fixtures/lab0/` that hold pre-registered questions and pass rules (`questions.json`, `prereg-v2.json`) are fixed. Do not edit them to make a check pass.

## Tools

Aliquot runs twelve built-in tools. `packages/core/src/tools.ts` defines `kb_search`, `kb_read`, `dataset_list`, `run_code`, `data_query`, `openalex_search`, `pubmed_search` and `arxiv_search`. `packages/core/src/literature.ts` defines `europepmc_search`, `europepmc_fulltext`, `doi_lookup` and `citation_walk`; `jats.ts` reads Europe PMC's article XML. `builtinTools()` lists all twelve. A lab cannot add its own tool: every binary refuses a `lab.toml` with a `[tools]` table, and nothing loads a tool folder. Contributed tools are planned, behind an OS-level boundary. Each tool is `defineTool({...})` and declares `reads` (the class of what it returns), `effects` and the `egress` hosts `ctx.fetch` may reach. A tool's version is the hash of its spec (`toolSpecHash`): the description, the input schema and those policy fields. A redirect is followed only to a host in `egress`, and each hop passes `decideEgress`. Each tool has a test that runs it through the tool runner, the literature tools against a fake API (`test/tool-harness.ts`) serving the recorded responses in `test/literature-fixtures/`. Every literature host is public, so a literature tool sends nothing for a question above D0; each test file checks that. Do not add a source that needs a key or an account, or whose terms limit use to individuals; `docs/design/DESIGN-v03.md` says why alphaXiv is not built in. `--plant-tool` on the worker binaries loads a test module as a tool, and only under `LABH_FAULTS=1`, which only a test harness sets.

`data_query` reads the tables in `lab.toml` `[tables]` (a CSV or a REDCap project) that an agent lists in `tables`. `packages/core/src/tables.ts` holds the column check, the REDCap reader and `executeQuery`; `table-engine.py` runs inside the sandbox through `Sandbox.aggregate`, and its output is parsed against a fixed shape before anything enters the run. Never return rows, a restricted column, the engine's stderr, or the size of a cell under `min_cell`. `test/data-query.test.ts` checks each of these, and `pnpm walk:data` runs the member's loop on lab0 with `scripts/fake-redcap.ts`.

`run_code` needs the image: `docker build -t aliquot-sandbox sandbox`, then pin `docker image inspect --format '{{.Id}}' aliquot-sandbox` as `[sandbox] image`. `test/run-code.test.ts` skips when no daemon answers or the image is not built. A dataset directory must be readable by uid 65534, the container's user.

## Sources

A knowledge base file source is `.md`, `.markdown`, `.txt`, `.docx` or `.pdf` (`readSources` in `kb-compile.ts`). `docx.ts` reads Word files in core. A PDF is never parsed in a Node process: `Sandbox.readPdf` in `sandbox.ts` uploads it into a container from the same image (no network, read-only root, uid 65534, label `aliquot.read_pdf`), runs `pdftotext` and `pdfimages -list`, and `pdf.ts` turns their output into text. A page with an image and no text is a scanned page and fails the file, because Aliquot does not do OCR. Only the `kb` command passes a PDF reader, and only when `lab.toml` has `[sandbox]`; the studio gets none. `test/pdf.test.ts` runs the fixtures in `test/pdf-fixtures/` through the real container and skips like `test/run-code.test.ts`.

## Agent backends

An agent may run on Claude Code or Codex instead of a model endpoint (`[agent_backends.<id>]` in `lab.toml`). The code is in `packages/core/src/agents/`. The CLI is one hosted model destination: its task prompt and every bridge reply pass `gateway.admit()`, so the egress call sites stay at five.

- `confine.ts` builds the macOS seatbelt profile, which starts from `(deny default)`. Each allowance names the CLI that needed it. Add one only after a probe under `(deny default)` shows the CLI fails without it, and say which CLI in the comment.
- `backends.ts` holds one `KindSpec` per CLI: argv, the line parser and the self-check. A tool call outside the bridge ends the run as `agent-not-confined`.
- `test/agent-confinement.test.ts` runs a probe under the real profile and asserts one denial per gap. It skips off macOS.
- `pnpm demo:agent --backend claude-code` (or `--backend codex --model <id>`) runs a real CLI on the operator's own login through `dev_shared_login`. That login is a public placement, so the agent sees D0 only. It is a developer's smoke test, not a lab deployment. See "Live smoke resolution" in `docs/design/DESIGN-v02.md`.

## Other harnesses

Sign-on for the web door is `packages/core/src/surfaces/signon.ts` (OpenID Connect, PKCE, ID token checks with `node:crypto`, the signed session cookie with its idle timeout) and `signon-wire.ts`, the one file that reaches the provider: it is in the seal's allowance and `scripts/boundaries.ts` allows it `http` and `https` only. Do not add another. `web.ts` turns a session into a viewer (`open` without `[auth]`, `member`, or a token `surface`); every run route goes through `requireVisible` or `requireOwnRun`, which answer 404 for a run the viewer may not see. With sign-on on, a body `user` is never read. `test/fake-oidc.ts` is the provider for tests and `pnpm walk:signon`; nothing signs in to a real provider.

`aliquot ask` and `aliquot acp` (Agent Client Protocol for T3 Code and other ACP clients) are clients of the web door's HTTP routes. `packages/core/src/door-client.ts` is the only file they add to the seal, and `scripts/boundaries.ts` allows it `http` and `https` only. They decide no egress: the door does. `packages/core/src/acp.ts` is the protocol, with no network of its own. `scripts/tmux.sh` lays the processes out in tmux. Its test (`test/tmux.test.ts`) uses a private tmux server (`ALIQUOT_TMUX_SOCKET`), never the default one, and skips without tmux. `docs/harnesses.md` is the user guide.

## Where things are

- `packages/core/src/policy.ts` holds the data classes a lab declares (`[classes.<id>]`), the detectors and `classify()`. A class sits at one lattice level, and the level is what `decideEgress` reads; a class adds rules (tier none, residency) and never loosens the lattice. `test/policy.test.ts` holds the pre-classes detectors as the oracle the default policy must match.
- `packages/core/src/loop.ts` holds `next()`, the whole run policy as one pure function.
- `packages/core/src/record.ts` holds the run record: fenced append, encrypted payloads and `fold()`.
- `packages/core/src/gateway.ts` is the only module that talks to models.
- `packages/core/src/kb.ts` holds snapshots, `kb_read` and BM25 search. `kb-compile.ts` holds compile and the coverage check.
- `docs/design/DESIGN.md` explains why each of these is shaped the way it is.
