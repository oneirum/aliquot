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

## 0.5: install it on a lab machine

- **For:** research IT.
- **After it:** one `docker compose up` starts Postgres, the worker, the web door and a production studio build with committed migrations, on Linux. PDF sources, parsed inside the no-network sandbox container, so an untrusted file never parses in the worker. `aliquot init` writes a `lab.toml` from a few questions and tests the lab's participant id pattern against a sample. Backup and restore of the database and the payload key, documented and checked.
- **Done when:** a CI job brings the stack up on a clean Ubuntu runner and gets a cited answer from the lab0 handbook, and a PDF fixture set passes (a Word export, a LaTeX paper, and a scanned page that fails with a clear message).
- **Leaves out:** Kubernetes, high availability, OCR.

## 0.6: ask where the lab already talks

- **For:** the members who will ask questions every day.
- **After it:** a Slack door with the same intake, data-class gate and record link in the thread (Teams after a lab asks for it), and a router across several agents, so one channel reaches both the handbook agent and the methods agent.
- **Done when:** a check through a fake Slack API gets a cited answer, refuses a participant id with zero hosted requests, and resolves the record link.

## 0.7: studies an IRB can cite

- **For:** the PI and the IRB.
- **After it:** freeze an agent version for a study, export an agent card (model, tools, knowledge base snapshots, data ceilings), replay a run against its frozen inputs, and export PROV. The system prompt text the core builds joins the version hash. The research IT and IRB sheet is generated from `lab.toml`, so it matches the deployment.
- **Done when:** a replay test reproduces a recorded run's tool sequence from its frozen inputs, and the card validates against a schema.

## 0.8: keys, retention and sign-on

- **For:** research IT and the data steward.
- **After it:** key rotation, per-class keys, a retention sweep that redacts payloads past a lab's window while the chain still verifies, and university sign-on (SAML or OIDC) for the studio and the chat page.
- **Done when:** a rotation test reads old and new payloads, a sweep test verifies the chain after redaction, and a sign-on test passes against a local OIDC provider.

## Later

- Agent CLI confinement on Linux, so Claude Code and Codex agents run on a campus VM.
- Tools a lab adds itself, each behind an OS-level boundary (a separate user, a container or a VM).
- One repair attempt when a model returns a malformed tool call.
- Consent checks against knowledge base sources; skills; scheduled runs.

## Interface track

Runs beside the releases.

| Surface | Next |
|---|---|
| Chat page | The agent's name and knowledge base in the header; a stop button; sources taken from the record's `kb_read` calls rather than the model's own "Source:" line; the thread kept across a reload. |
| Record page | A model call grouped with the tool calls it asked for; a filter for refusals; a printable view for an IRB file. |
| Studio | An empty lab says what to do first; coverage questions suggested from the documents; a side-by-side diff of two snapshots' entries. |
| Terminal | `aliquot init`; colour that respects `NO_COLOR`; `aliquot kb` merged into `aliquot`. |
| Docs | A tutorial from a lab's handbook to a published agent, with a screenshot at each step; a deployment page for research IT. |
