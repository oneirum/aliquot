# Changelog

Each release is tagged on `main`. Dates are in US Central time.

## Unreleased

- The chat and record pages show the lab's name at the top right, from a new `[lab] name` in `lab.toml` (`aliquot init` asks for it), or the machine's hostname when it is unset. The header labels "Runs on this machine" and "Read only", the chat page's footer line and its intro paragraph are gone.
- The README demo is a new recording of the current pages, and the chat and record stills are retaken in light and dark.

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
