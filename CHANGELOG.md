# Changelog

Each release is tagged on `main`. Dates are in US Central time.

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
