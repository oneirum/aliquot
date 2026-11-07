# Changelog

Each release is tagged on `main`. Dates are in US Central time.

## Unreleased

- Payload keys by id. `lab.toml` can name keys in `[store.keys]` (`k1 = "LABH_PAYLOAD_KEY"`, `k2 = "LABH_PAYLOAD_KEY_2"`) with `[store] current`; `key_env` alone still works and means `k1`. New payloads go under the current key, each stored payload is read with the key whose id it carries, and `aliquot keys reencrypt` moves old payloads to the current key in batches that each commit, so it resumes and a second run does nothing. Payload hashes never change: the address key is the lab's for life, kept wrapped under each key in a new `payload_keys` table (migration 0005), and a key whose value does not match its id refuses to start. `aliquot keys status` prints each key, its env var, whether this process holds it, how many payloads it holds and how many wait to move; `aliquot keys rotate` records the rotation in the audit stream. `docs/install.md` has "Rotate the key".
- Per-class keys. `[store.class_keys]` (for example `D3 = "k3"`) puts a class under its own key. A web door or worker that is not given that key lists those bodies on the record page as unavailable, under `k3`, and the chain still verifies. The record page and `aliquot record` gain a Bodies table: each body's hash, class, size and whether it is stored, unavailable here or redacted, never its text.
- Retention. `[policy.retention]` sets `keep_min_days` (the floor the lab's records rules set) and `purge_payload_after_days` lab-wide or per class; a purge shorter than its class's floor refuses to start. `aliquot retention --dry-run` lists each run past the window and changes nothing; `--apply` deletes those bodies, keeps a tombstone (hash, class, size, when, why), clears the web door's plaintext copy of the reply, checks every chain it touched and writes a `retention.swept` audit event. The record page shows "Redacted on <date> by the lab's retention window" with the hash. `--as-of` judges the window at another date. `docs/install.md` has "Retention", and the IRB doc's key and retention lines now say what a lab can configure.
- `scripts/backup.sh` carries every payload key that holds bodies (`payload-key`, `key-ids`) and refuses, naming the id, when one is missing from `.env`. `scripts/restore.sh` refuses a backup whose keys are not all supplied and names the missing id; a backup from before key ids restores as before. `compose.yaml` passes `LABH_PAYLOAD_KEY_2` and `LABH_PAYLOAD_KEY_3` to the worker and the web door, and still none to the studio.
- `pnpm walk:keys` walks a steward through rotation, re-encryption, a D3 key, a reader without it, and a retention sweep on a synthetic lab, with a PASS line per step.
- The studio holds no payload key. Every read and write it made of core's state goes to the web door's new `/studio` routes with the token of a new `[surfaces.studio]` (kind `studio`): KB compiles (the door reads the sources and stores them encrypted, then queues the worker job), compile results, KB and agent publishes, test messages, test-run replies, and an entry preview for authors that never shows a D3 entry. Each route checks the member's role and the data's class in the door. Test threads now run on the `studio` surface, so their run keys and record pages say `studio`. `compose.yaml` gives the studio its own environment with `ALIQUOT_STUDIO_TOKEN` and `LABH_DOOR_URL` and no `LABH_PAYLOAD_KEY`, and `scripts/compose-check.sh` asserts it. `aliquot init` writes `[surfaces.studio]` and the token. An existing lab adds the table from `lab.example.toml` and `ALIQUOT_STUDIO_TOKEN=$(openssl rand -hex 32)` to `.env`; without them the studio says what is missing. `test/boundaries.test.ts` fails when anything the studio loads reads the key.

## 0.5.1 (2026-11-04)

- Security: `next` 16.4.5 fixes the 11 Next.js advisories open against 16.3.3 (GHSA-vcvr-r3jv-pc5j, GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr critical; GHSA-cjq9-62q9-8jv4 and GHSA-p3m5-59mp-jv5r high; six medium or low). Overrides lift `dompurify` (from monaco-editor) to 3.4.17 and drizzle-kit's old `esbuild` to 0.25. `deepmerge` has no fixed release, so `vendor/deepmerge` is 4.3.1 with the GHSA-gcqx-w48m-w2h4 fix and a test. `.github/dependabot.yml` turns on weekly grouped npm updates.
- Agent backends take a key the lab owns: `api_key_env` reaches Claude Code as `ANTHROPIC_API_KEY` and Codex as `CODEX_API_KEY`. `auth_env`, a personal subscription's OAuth token, now parses only at `placement = "public"` and runs only under `agent-worker --dev-shared-login`; a `lab.toml` with `auth_env` at `approved` or `zdr` fails to start. The README and the IRB doc no longer suggest `claude setup-token`; the install guide says which model accounts Aliquot may use, and the IRB doc gains a "Model accounts" section.
- `lab.example.toml`'s OpenRouter example routes Claude to `amazon-bedrock` and `google-vertex`, the providers with zero-retention Claude endpoints; `only = ["anthropic"]` with `zdr = true` matched none.
- The roadmap puts sign-on, keys and retention (now 0.7) before studies an IRB can cite (now 0.8).
- `aliquot ask` asks a question through the web door from a terminal or a script. `--json` prints one line per step (`started`, `tool`, `finished`, `refused`), each with the run's record link, and the exit code says whether it was answered. `--ceiling` withholds an answer above a class from a caller that keeps its own copy. `pnpm lab0` gains check G: `aliquot ask --json` gets the same cited answer as the chat page, and a record whose chain verifies.
- `aliquot acp` speaks the Agent Client Protocol on stdin and stdout, so T3 Code (as a local ACP command), Zed and other ACP clients run Aliquot agents as threads. One session is one Aliquot thread. The tools the run used appear as steps, a refusal ends the turn as `refusal`, and cancelling stops the run.
- `scripts/tmux.sh` (`pnpm up:tmux`) lays out the worker, the web door, the studio and an `ask` shell as one tmux session. A window whose process exits keeps its last lines. [`docs/harnesses.md`](docs/harnesses.md) covers all three.

- The chat and record pages show the lab's name at the top right, from a new `[lab] name` in `lab.toml` (`aliquot init` asks for it), or the machine's hostname when it is unset. The header labels "Runs on this machine" and "Read only", the chat page's footer line and its intro paragraph are gone.
- The README demo is a new recording of the current pages, and the chat and record stills are retaken in light and dark.
- **Runs** (`/runs`) lists the newest 100 runs with their outcome and how many refusals each had, and shows only the runs with a refusal, or only the failed ones, at a click. Each row opens its record. A PI no longer needs a terminal to find a refused run.
- The chat thread is kept in the browser tab, so opening a record and coming back, or reloading, no longer loses it. **New thread** starts over. A dropped connection while an answer is pending says to reload, and the reload picks the answer up.
- The record page has **Only refusals** when a run refused anything, prints cleanly for an IRB file, and arrives with its data in the page instead of a second request. Pages are gzipped: each is one request of about 6 KB, down from up to two requests and 16 KB.
- Every control on the chat, runs and record pages shows where focus is, and asking, opening a record, downloading it and finding a refused run all work from the keyboard alone. The studio's status lines mark their kind by shape (a check, a triangle, a square, a dot), not only by colour.

## 0.5.0 (2026-11-03)

- One `docker compose up` on Linux starts Postgres, the worker, the web door and a production build of the studio. The studio applies committed Payload migrations at start, and CI fails when the collections change without one. Ports are published on `127.0.0.1` unless `.env` sets `LABH_BIND`. [`docs/install.md`](docs/install.md) is the guide for research IT.
- PDF sources for knowledge bases, from the `kb` command. poppler reads them inside the sandbox container (no network, read-only root, uid 65534), never in a Node process. A page that is only an image fails the whole file with a message naming the page, because Aliquot does no OCR. `compose.sandbox.yaml` gives the Docker socket to the worker only. The studio gets no socket, so PDFs compile with the `kb` command.
- `aliquot init` (`pnpm aliquot:init`, or `docker compose run --rm init` on a machine with only Docker) writes `config/lab.toml` and `.env`. It tests the lab's participant id patterns against ids you paste, with a PASS or FAIL line for each, refuses a pattern that matches ordinary words, and never rewrites an existing `.env`.
- `scripts/backup.sh` and `scripts/restore.sh` back up and restore the database and the payload key. Restore refuses a key the backup was not made with, and ends by checking every run's hash chain.
- `scripts/compose-check.sh` runs all of it on a machine with only Docker, and CI runs it on a clean Ubuntu runner: a cited answer from the lab0 handbook, a LaTeX PDF and a Word PDF read in the sandbox, a scanned page that must fail, then a backup, wipe and restore that ends with the same run verifying and decrypting again.
- The web door takes `--host`, so it can listen inside a container. The `kb` command prints a source it cannot read as one line instead of a stack trace.

## 0.4.0 (2026-11-03)

- Word (.docx) sources for knowledge bases, from the `kb` command and the studio. Core reads them to Markdown with no new dependency: headings by style name, list items, tables, tabs and line breaks; deleted tracked changes, images, comments, headers and footers are dropped. The lab's participant id patterns see the Word text. A `.pdf` or `.doc` source gets a message saying to save it as `.docx`.
- Every record opens with a summary: outcome, time, model calls, tokens, tool calls by name, knowledge base entries retrieved, and refusals. It is in the record page, in `aliquot record` (a `summary` line) and in `--json`.
- The record page downloads the record as JSON, and marks each event's kind by shape (run, model call, tool call, refused) with a legend, so meaning never rests on colour.
- Chat answers render paragraphs, lists, headings and code blocks, still without parsing model text as HTML, and say what each run read and how long it took.
- The docs say `pnpm run doctor`. pnpm 10 has a built-in `doctor` command, so the `pnpm doctor` that 0.3.1 documented ran pnpm's check and printed nothing of Aliquot's. A test keeps the docs from saying it again.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): the next releases, who each serves and how it is checked.

## 0.3.1 (2026-10-30)

- `pnpm doctor`: a read-only preflight. It checks Node, pnpm, the installed dependencies, Docker, the Postgres port, ports 3000 and 3001, the `aliquot-sandbox` image, the agent CLIs and `lab.toml`, and prints the fix for each problem. It exits 1 when something `pnpm demo` needs is missing.
- `pnpm aliquot runs [--limit n]` lists the newest runs with their start time, agent version, outcome, event count and chain check, so a run id no longer has to come from the browser.
- `--json` on `aliquot record` and `aliquot runs` prints the same view as JSON, for scripts.
- `aliquot` prints one line for setup problems (`DATABASE_URL` unset, Postgres down, a missing database, a refused password) instead of a stack trace, and never prints the password. Exit codes are documented in `--help`.
- `pnpm aliquot` no longer prints Node's ExperimentalWarning for `--allow-net`.
- The `[tools]` refusal no longer says "not supported in v0.2, planned for v0.3": v0.3 shipped without contributed tools, and the message and docs now say so without a version.

## 0.3.0 (2026-10-30)

Four more literature tools, all built into core, all public (D0) hosts:

- `europepmc_search`: PubMed, PubMed Central and preprints, with which hits are open access.
- `europepmc_fulltext`: an open-access article's full text section by section, with its license.
- `doi_lookup`: Crossref's record for a DOI, plus a legal open copy from Unpaywall when the lab set a contact email.
- `citation_walk`: references or citing works of one paper, through OpenAlex.

The studio gained a read-only Tools panel, and its panels and the record page got empty, loading, error and phone layouts. Design: [`docs/design/DESIGN-v03.md`](docs/design/DESIGN-v03.md).

## 0.2.0 (2026-10-28)

- Claude Code and Codex as confined agent engines on macOS, behind a bridge to Aliquot's own tools and a host-pinned proxy.
- Built-in research tools: OpenAlex, PubMed and arXiv search, datasets by class, and `run_code` for R and Python in a container with no network.
- Native Anthropic Messages and OpenAI Responses clients, and per-class model routing.
- A chat page for members, a record page for each run, `pnpm aliquot record` in a terminal, and `pnpm demo`, which runs the synthetic lab0 lab in one command.

Design: [`docs/design/DESIGN-v02.md`](docs/design/DESIGN-v02.md).

## 0.1.0 (2026-10-28)

The first public release: the durable run loop, data classes and the single egress decision, the boundary scanner and the runtime network seal, knowledge bases with a coverage gate, the authoring studio with five roles, the web door, the encrypted payload store and the hash-chained audit stream. Design: [`docs/design/DESIGN.md`](docs/design/DESIGN.md).
