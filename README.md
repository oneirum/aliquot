<h1 align="center">Aliquot</h1>

<p align="center">
An open-source agent harness for research labs.<br>
Lab members build agents and knowledge bases in a browser. Participant data stays on lab hardware.<br>
Every answer leaves a record you can check.
</p>

<p align="center">
<a href="#quickstart">Quickstart</a> ·
<a href="#what-it-does-for-a-lab">What it does</a> ·
<a href="#the-studio">Studio</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#status-and-roadmap">Status</a> ·
<a href="docs/design/DESIGN.md">Design</a>
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/studio-kb-coverage-dark.png">
  <img alt="The Aliquot studio: a knowledge base built from three lab documents, its coverage report naming one question the documents do not answer, and the note a publisher wrote to publish over that gap" src="docs/images/studio-kb-coverage-light.png">
</picture>
</p>

## What it does for a lab

A lab answers the same questions every week. Where the freezer log is, how a variable is coded, what the SOP says about a sample that came in late. The answers live in documents nobody has time to search. Aliquot turns those documents into agents the lab owns.

- **Answers from your own documents.** A steward compiles SOPs, codebooks and onboarding notes into a knowledge base. Agents search it and cite the entry they used. Members reach an agent through the web door, an HTTP endpoint (`POST /message`); the chat front ends are on the roadmap.
- **Built by the people who know the work.** Agents and knowledge bases are forms in a web studio, with revisions, diff, restore, a test thread and a publish button. No git, no deploy.
- **Restricted data does not leave.** Every piece of content carries a data class. Participant identifiers are restricted, and restricted content never reaches a hosted model. The harness refuses the call and records the refusal.
- **Coverage before publish.** A knowledge base lists the questions it must answer. If the documents do not support one, publish is refused and names the gap, unless a publisher overrides it with a written note.
- **Roles that match a lab.** Members, authors, publishers, a data steward and the PI. Anything at the restricted level needs the steward or the PI to publish.
- **A record for every answer.** Each run is an append-only, hash-chained log of every model call, search and tool call. A crashed run resumes from its record, and the record is what a reviewer reads later.
- **Pinned versions.** Each run names the hash of the agent version that answered. Change one character of the instructions and the hash changes.
- **Runs on a laptop.** Postgres, plus a local model through Ollama. No hosted service is required.

## Quickstart

You need Node 26 or later, pnpm 10 and Docker. The checks use scripted fake models, so you need no model download and no API key.

	git clone https://github.com/oneirum/aliquot.git
	cd aliquot
	pnpm install
	docker compose up -d postgres
	pnpm typecheck
	pnpm test
	pnpm lab0

`pnpm lab0` runs the first-use check on a synthetic lab. It prints one `PASS` or `FAIL` line per check and ends with `9/9 checks passed`.

If port 5432 is taken, set `LABH_PG_PORT` for every command, for example `export LABH_PG_PORT=55433` before `docker compose up -d postgres`.

## The studio

The studio is where lab members write agents and knowledge bases, with no repository access. It is Payload CMS in `packages/studio`, on the same Postgres in its own schema.

<table>
<tr>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/studio-agent-checks-dark.png">
  <img alt="An agent draft in the studio. The publish panel lists the lab rules the draft breaks, so there is no Publish button yet" src="docs/images/studio-agent-checks-light.png">
</picture>
</td>
<td width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/studio-revision-diff-dark.png">
  <img alt="Two revisions of an agent compared field by field, with the changed instructions highlighted" src="docs/images/studio-revision-diff-light.png">
</picture>
</td>
</tr>
<tr>
<td>A draft saves even when it breaks a lab rule. Publish waits until the rules pass.</td>
<td>Every save is a revision. Compare any two, and restore an old one.</td>
</tr>
</table>

To run it by hand after the quickstart:

	cp lab.example.toml lab.toml
	export DATABASE_URL=postgres://postgres:labh@localhost:5432/labh
	export LABH_PAYLOAD_KEY=$(openssl rand -hex 32) PAYLOAD_SECRET=$(openssl rand -hex 24) LABH_CONFIG=$PWD/lab.toml
	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/worker.ts &
	pnpm --filter @labh/studio dev --port 3001

Open `http://localhost:3001/admin` and create the first account before anyone else can reach the port: the first account is the PI. The PI adds the others and gives each a role. Keep `LABH_PAYLOAD_KEY`, because the payload store is encrypted with it. The worker answers the test thread and compiles knowledge bases. Point `[endpoints.local]` in `lab.toml` at Ollama or another OpenAI-compatible server for real answers.

The studio process runs outside Node's permission model, because Next.js starts child processes. It holds no model gateway and no tool runner: every model call happens in the sealed worker. It does hold the payload key, so do not give it provider API keys. [`DESIGN.md`](docs/design/DESIGN.md#unit-2-studio-and-publish) has the details.

## Knowledge bases from the command line

A steward with repository access can compile and publish without the studio. A definition file names the purpose, the sources, 5 to 10 coverage questions and the compiler model (see `fixtures/kb-lab/kb.json`):

	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts compile --definition fixtures/kb-lab/kb.json --wait
	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts publish --snapshot <id>

The example definitions name the scripted test model, so for real use set the compiler to a model your `lab.toml` serves, and start the worker first: `--wait` waits for it to finish the compile. `kb` also has `coverage`, `diff` and `search`, and `publish --override-gaps "<note>" --actor <publisher>` to publish over gaps. The command checks no role: it is the steward's tool, for whoever holds the repository. A URL source is fetched only from a host that `[hosts]` in `lab.toml` allows for lab documents. Any other host is refused before a request is sent.

## How it works

```mermaid
flowchart LR
    member([Lab member]) -->|question| door[Web door]
    author([Author]) -->|edit, test, publish| studio[Studio]
    studio --> heads[(Published agents<br/>and KB snapshots)]
    door --> gate{Gate<br/>classifies the message}
    gate -->|enqueue| jobs[(Jobs)]
    studio -->|tests and compiles| jobs
    jobs --> worker[Sealed worker<br/>durable run loop]
    heads --> worker
    worker --> record[(Run record<br/>hash-chained, encrypted)]
    worker --> egress{decideEgress}
    egress -->|class allowed| local[Local model<br/>Ollama, vLLM]
    egress -->|D0 to D2 only| hosted[Hosted model]
    egress -.->|refused, recorded| record
```

Three ideas carry the design.

**One place decides where data may go.** Content gets a data class where it enters. The gate classifies each message, a snapshot carries the highest class of its sources, and a tool result carries the class of what the tool reads. `lab.toml` gives every destination a placement, and the placement decides the highest class it may receive. `decideEgress` in `packages/core/src/dataclass.ts` is the only function that answers "may this go there", and each kind of destination has one call site. A static scanner and a runtime seal close the routes around it, such as a tool that calls `fetch` directly.

| Class | Meaning | Highest model placement it may reach |
|---|---|---|
| D0 | Public | `public`, any endpoint |
| D1 | Lab documents that are fine to share with a vetted provider | `zdr`, a hosted model with zero data retention |
| D2 | Internal to the lab or institution | `approved`, a service the institution approved |
| D3 | Restricted, such as participant identifiers | `lab` or `institution` hardware only |
| R | Review-confidential | Nowhere by default |

**The run record is the workflow.** A run has no state outside its append-only event log. To resume after a crash, a worker folds the events and asks one pure function, `next()` in `loop.ts`, what to do. A step that is not in the record did not happen. A lease epoch fences off a worker that lost its claim, so each run finishes exactly once.

**Everything is addressed by content.** Agent versions, knowledge base snapshots, entries and payloads are named by their hash. A snapshot diff is a diff of two maps. A run names the agent version that answered, so a later edit cannot change what an old run did.

The full design, with the trade-offs and the alternatives considered, is in [`docs/design/DESIGN.md`](docs/design/DESIGN.md). It was first sketched from Sanity's write-up of their company agent harness, [How we built our company agent harness](https://www.sanity.io/engineering/how-we-built-our-company-agent-harness), and then changed for what a lab needs.

## What is checked

Each check script starts real worker and web processes (and, for `unit2`, the studio) against Postgres and scripted fake models, and prints one line per check.

| Command | What it proves |
|---|---|
| `pnpm test` | Unit and integration tests for the core and the studio fields. |
| `pnpm slice1` | The run loop: crash and resume exactly once, a zombie worker fenced off, idempotent intake, restricted data refused with zero hosted requests, limits, stop, and the network seal against planted routes. |
| `pnpm unit3` | Knowledge bases: compile, coverage gaps blocking publish, a restart mid-compile, `kb_search` and `kb_read` in a run, snapshot diff, refused URL hosts, publish with an override note. |
| `pnpm lab0` | The first-use check on a synthetic lab, described below. |
| `pnpm unit2` | The studio in a headless browser: author, test and publish an agent, diff and restore, roles, a knowledge base built in the form and published over a gap, and a restricted knowledge base refused on a hosted agent. |

`slice1` and `unit3` end with one live smoke call to Ollama serving `qwen3:8b`. Add `--skip-ollama` to leave it out. `unit2` needs Chromium: run `pnpm exec playwright install chromium` once, or set `LABH_CHROMIUM` to a Chromium on disk. `pnpm unit2 --shots docs/images` regenerates the screenshots in this README.

### The synthetic lab

`fixtures/lab0` is a made-up lab with three documents (a freezer SOP, a sleep-diary codebook and an onboarding note for research assistants) and a roster of participant ids. Twenty member questions, each with the entry that should answer it, were written down before the first run and have not been edited since. At the last run:

| What was checked | Result |
|---|---|
| 20 member questions through the web door cite the entry written down for them | 20 of 20, ranked first in 20 of 20 |
| 4 questions the documents do not answer | 4 of 4 retrieve nothing, and publish is refused naming all 4 |
| A roster of participant ids compiled on a hosted model, and a message with a roster id | Both refused, 0 requests reach the hosted endpoint |
| A roster id hidden in a document declared as lab documents, or in the purpose | The class is raised to restricted, and the compile is refused |
| A restricted knowledge base attached to an agent on a hosted model | Refused at intake |
| Every run | 26 of 26 run records verify, each naming its agent version |
| The hosted endpoint over the whole check | 1 request, the planned control message |

The fake models are scripted, so this checks retrieval, orchestration, provenance and egress control. It does not measure answer quality, and it does not show that a real lab wants this. That needs a pilot.

## Status and roadmap

Aliquot is early. It has been tested on a synthetic lab, not used by a real one.

**Built**

- The durable run loop: crash and resume, lease fencing, stop with confirmation, step, token and time limits.
- Data classes, the single egress decision, the static boundary scanner and the runtime network seal.
- Knowledge bases: compile through the gateway, the coverage gate, `kb_search` and `kb_read`, snapshot diff, URL sources from listed lab hosts.
- The studio: agent and knowledge base forms, revisions with diff and restore, a test thread, publish checks and five roles.
- The web door, the encrypted payload store and the hash-chained audit stream.

**Not built yet, roughly in order**

- Slack and Teams front doors, and a chat page for members. Today the web door is an HTTP endpoint.
- A router across several agents. Today a channel is bound to one agent.
- Contributed tools discovered from `tools/`, and skills. Today the only tools are the built-in `kb_search` and `kb_read`; `tools/openalex_search` is an example of the format.
- A sandbox for R and Python, and scheduled runs.
- Studies: freeze an agent version, export an agent card, reviewer replay and PROV export. The types exist; the functions are stubs.
- IRB and consent checks against knowledge base sources.
- Key rotation, per-class keys and a retention sweep.
- University sign-on, a production studio build with committed migrations, and container images.
- PDF sources. Today a source is Markdown, text or a page on a listed host.

**Known limits**

- The version hash covers what the run loop reads, but not yet the system prompt text the core builds around it.
- Detection of restricted text is pattern-based. A lab must give its own patterns in `lab.toml`, and text no pattern matches keeps its declared class.
- The studio runs unsealed, as described above.
- The web door has no sign-in and does not check an agent's audience yet. It listens on `127.0.0.1` only. Do not expose it beyond the machine until sign-on lands.

## Repository layout

	packages/core      the harness: gate, run loop, record, gateway, knowledge bases, publish
	packages/studio    the authoring studio (Payload CMS on Next.js)
	tools/             an example contributed tool (discovery is not built yet)
	scripts/           the check scripts and the boundary scanner
	fixtures/          synthetic agents, knowledge bases and the lab0 lab
	docs/design/       the design, the first slice, and the stack decisions

## Working with a coding agent

[`AGENTS.md`](AGENTS.md) tells a coding agent how to set up the repo, which checks to run and which boundaries the checks enforce. Point your agent at it.

## License

[Apache-2.0](LICENSE).
