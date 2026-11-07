# Roadmap

Aliquot has been tested on a synthetic lab, not used by a real one. The releases below are ordered by what stops a real lab from adopting it, not by how easy they are. Each names who it is for, what they can do after it, and the check that says it is done.

## Who adopts it, in the order they meet it

| Who | What they need before saying yes |
|---|---|
| A grad student or lab manager | Load the lab's real handbook and get a cited answer soon after cloning. |
| The PI | A short view of what an answer used and cost, and confidence that participant data does not leave. |
| Research IT | Install it on a lab machine or a campus VM, keep it running, back it up, sign in with university accounts. |
| The IRB or a data steward | A record of a run they can read and keep without running anything, and a frozen agent version a study can cite. |

## 0.4: the lab's own documents, and a record a reader can keep (released)

- Word (.docx) sources for knowledge bases, read to Markdown in core with no new dependency.
- A summary at the top of every record (time, model calls, tokens, tool calls, entries retrieved, refusals), in the page, `aliquot record` and `--json`, and a JSON download from the record page.
- Chat answers keep their lists, headings and code blocks, and say what each run read and how long it took.
- `pnpm run doctor` in the docs, because pnpm's built-in `doctor` command shadows a bare `pnpm doctor`.

## 0.5: install it on a lab machine (released)

- One `docker compose up` on Linux starts Postgres, the worker, the web door and a production studio build that applies committed migrations. [`docs/install.md`](install.md) is the guide for research IT.
- PDF sources, read by poppler inside the no-network sandbox container, never in a Node process. A scanned page fails with a clear message, since there is no OCR.
- `aliquot init` (or `docker compose run --rm init`) writes `lab.toml` and `.env`, and tests the lab's participant id patterns against ids you paste.
- `scripts/backup.sh` and `scripts/restore.sh` for the database and the payload key.
- Checked by `scripts/compose-check.sh`, which CI runs on a clean Ubuntu runner: a cited answer from the lab0 handbook, the PDF fixtures (a Word PDF, a LaTeX PDF, a scanned page that must fail), and a backup, wipe and restore that ends with the same run verifying again.

## 0.5.1: reach it from other harnesses (released)

- **For:** whoever already works in a terminal, tmux, T3 Code, an editor, or a lab's own orchestrator.
- **After it:** one contract with no adapter per tool. `aliquot ask --json` prints a JSON line per step, each with the record link. `aliquot acp` speaks the Agent Client Protocol, so T3 Code, Zed and JetBrains run Aliquot agents as threads. `scripts/tmux.sh` lays the processes out in one tmux session. `--ceiling` keeps an answer above a class out of a client that stores its own copy. [`docs/harnesses.md`](harnesses.md) is the guide.
- **Why here:** it needs only the web door, and nothing after it depends on it. A door reachable from another machine waits for sign-on in 0.7.
- **Done when:** a test drives the real binary against a fake door, `pnpm lab0` gets a cited answer and a verified record through `aliquot ask --json`, a test lays out the tmux session on a private tmux server, and the official ACP SDK parses every message `aliquot acp` sends.
- **Not planned:** a fork of T3 Code. Its license allows one, but it would carry about a million lines of developer tooling into the trust base. Its thread store would sit outside the record, and its device pairing grants a shell on the host. Aliquot runs inside T3 as an ACP agent instead.

## 0.6: ask where the lab already talks (released in 0.8.0)

- **For:** the members who will ask questions every day.
- **After it:** a Slack door and a Teams door with the same intake, data-class gate and record link in the thread (both built), and a router across several agents, so one channel reaches both the handbook agent and the methods agent.
- **Done when:** a check through a fake Slack API gets a cited answer, refuses a participant id with zero hosted requests, and resolves the record link.

## 0.7: keys, retention and sign-on (released in 0.8.0)

- **For:** research IT and the data steward.
- **After it:** key rotation, per-class keys, a retention sweep that redacts payloads past a lab's window while the chain still verifies, and university sign-on (SAML or OIDC) for the studio and the chat page.
- **Done when:** a rotation test reads old and new payloads, a sweep test verifies the chain after redaction, and a sign-on test passes against a local OIDC provider.
- **Shipped:** all three, with OpenID Connect sign-on on the web door and the chat page. The studio keeps its own accounts, and SAML goes through a campus OIDC bridge; studio sign-on moved to Later.

## 0.8: studies an IRB can cite (released)

- **For:** the PI and the IRB.
- **After it:** freeze an agent version for a study, export an agent card (model, tools, knowledge base snapshots, data ceilings), replay a run against its frozen inputs, and export PROV. The system prompt text the core builds joins the version hash. The research IT and IRB sheet is generated from `lab.toml`, so it matches the deployment.
- **Done when:** a replay test reproduces a recorded run's tool sequence from its frozen inputs, and the card validates against a schema.

## Later

- Sign-on for the studio, and `ask` and `acp` tokens minted from a signed-in session.
- Harness doors off the machine, after sign-on: an `acp` surface in the door with its own placement, so the server enforces the ceiling, and `ask` and `acp` against a signed-in remote door.
- Agent CLI confinement on Linux, so Claude Code and Codex agents run on a campus VM.
- Tools a lab adds itself, each behind an OS-level boundary (a separate user, a container or a VM).
- One repair attempt when a model returns a malformed tool call.
- Consent checks against knowledge base sources; skills; scheduled runs.

## Interface track

Runs beside the releases.

| Surface | Next |
|---|---|
| Chat page | The agent's name and knowledge base in the header; a stop button; sources taken from the record's `kb_read` calls rather than the model's own "Source:" line; a source entry readable from the chat for members allowed to see its class. |
| Record page | A model call grouped with the tool calls it asked for; the runs list filtered by agent and date. |
| Studio | An empty lab says what to do first; coverage questions suggested from the documents; a side-by-side diff of two snapshots' entries. |
| Terminal | `aliquot init`; colour that respects `NO_COLOR`; `aliquot kb` merged into `aliquot`. |
| Docs | A tutorial from a lab's handbook to a published agent, with a screenshot at each step; a deployment page for research IT. |
