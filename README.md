<h1 align="center">Aliquot</h1>

<p align="center">
Agents that answer a lab's questions from its own SOPs, datasets and papers.<br>
Data the lab marks restricted, such as participant ids, is refused before it reaches a hosted model.<br>
Every answer leaves a record you can check. Open source, and it runs on a laptop.
</p>

<p align="center">
<a href="https://github.com/oneirum/aliquot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oneirum/aliquot/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
</p>

<p align="center">
<a href="#quickstart">Quickstart</a> ·
<a href="#what-it-does-for-a-lab">What it does</a> ·
<a href="#agents-on-claude-code-or-codex">Agent CLIs</a> ·
<a href="#research-tools">Research tools</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#what-is-checked">What is checked</a> ·
<a href="#status-and-roadmap">Status</a>
</p>

<p align="center">
<img alt="The Aliquot chat page with Claude Code as the agent. A question about thawing samples is answered from the lab handbook with its sources named. A research question is answered by listing the datasets, running Python over a synthetic sleep diary in a container and searching OpenAlex. A question naming participant LAB0-0003 is refused before anything is sent, and the run record shows every step with its data class and a verified hash chain" src="docs/images/demo.gif" width="900">
</p>

<p align="center"><sub>A scripted browser capture of <code>pnpm demo:agent --backend claude-code --research</code>: a live run of Claude Code (<code>claude-haiku-5-5</code>) on a developer's own login, in real time. <a href="docs/images/demo.mp4">Full-size MP4</a>, easier to read on a phone.</sub></p>

## Quickstart

You need Node 26 or later, pnpm 10 and Docker. The demo and the checks use scripted fake models, so you need no model download and no API key.

	git clone https://github.com/oneirum/aliquot.git
	cd aliquot
	pnpm install
	pnpm demo

`pnpm demo` starts Postgres in Docker if it is not running, seeds the synthetic lab0 lab, compiles and publishes its handbook from three documents, and starts the worker and the web door. It prints a link to the chat page with two questions to try:

1. **"Which freezer rack holds the aliquots?"** The agent searches the handbook, quotes the entry and names its path.
2. **"Is LAB0-0003 still pending for wave 1?"** `LAB0-0003` matches the lab's participant id format, so the message is restricted (D3). The demo agent's model stands in for a hosted vendor that may receive at most D1, so nothing is sent, and the page says why.

Under each answer, **Record** opens the run's record: every model call, tool call and refusal, and a check that the hash chain is intact. `pnpm aliquot record <run-id>` prints the same record in a terminal. The demo prints the full command, with its database.

The demo's model is a scripted fake that searches, reads the top entry and quotes it. It shows the harness, not answer quality. Add `--studio` to start the authoring studio as well.

To run the checks:

	docker compose up -d postgres
	pnpm typecheck
	pnpm test
	pnpm lab0

`pnpm lab0` runs the first-use check on a synthetic lab. It prints one `PASS` or `FAIL` line per check and ends with `9/9 checks passed`.

If port 5432 is taken, set `LABH_PG_PORT` for every command, for example `export LABH_PG_PORT=55433` before `docker compose up -d postgres`.

### With a real agent

On a Mac where Claude Code or Codex is logged in, the same lab runs on the real CLI:

	docker build -t aliquot-sandbox sandbox     # once, for --research
	pnpm demo:agent --backend claude-code --research
	pnpm demo:agent --backend codex --model <a model id your login serves>

`--research` adds a third question that needs data, code and literature: how mean sleep time changed between two waves of a made-up sleep diary, and one paper comparing actigraphy with sleep diaries. The agent lists the datasets, runs Python over the CSV in the sandbox and searches OpenAlex.

This uses your own CLI login (`dev_shared_login`), so it is for a developer's machine only, and the agent sees public (D0) data alone. A lab uses a dedicated service login; see [Agents on Claude Code or Codex](#agents-on-claude-code-or-codex).

## What it does for a lab

A lab answers the same questions every week. Where the freezer log is, how a variable is coded, what the SOP says about a sample that came in late, what the literature says about a measure. The answers live in documents, datasets and papers nobody has time to search. Aliquot turns them into agents the lab owns.

- **Answers from your own documents.** A steward compiles SOPs, codebooks and onboarding notes into a knowledge base. Agents search it and cite the entry they used.
- **Research tools.** Agents can search OpenAlex, PubMed, arXiv and Europe PMC, read open-access papers in full, look up a DOI and where a legal open copy is, and walk citations. They can also list the lab's datasets and run R or Python over them in a container with no network.
- **Claude Code or Codex as the agent.** An agent can run on one of these CLIs instead of a model endpoint. The CLI is confined: it has no tools of its own, and it reaches only Aliquot and its vendor's API.
- **Restricted data does not leave.** Every piece of content carries a data class. Participant identifiers are restricted, and restricted content never reaches a hosted model or a hosted agent CLI: the harness refuses the call and records the refusal. One agent can send public questions to a hosted model (Anthropic, OpenAI) and restricted ones to a lab model (Ollama or any OpenAI-compatible server).
- **Built by the people who know the work.** Agents and knowledge bases are forms in a web studio, with revisions, diff, restore, a test thread and a publish button. No git, no deploy.
- **Coverage before publish.** A knowledge base lists the questions it must answer. If the documents do not support one, publish is refused and names the gap, unless a publisher overrides it with a written note.
- **A record for every answer.** Each run is an append-only, hash-chained log of every model call, tool call, CLI session and refusal. A crashed run resumes from its record, and the record is what a reviewer reads later. Each run names the hash of the agent version that answered.

## The studio

The studio is where lab members write agents and knowledge bases, with no repository access. It is Payload CMS in `packages/studio`, on the same Postgres in its own schema. Beside an agent's form, the Tools panel lists every built-in tool with what it does, the hosts it reaches, and which ones the agent already uses.

<p align="center"><img alt="The coverage panel of a knowledge base in the studio. Six of seven questions have a supporting entry, the parking permit question is named as a gap, and the knowledge base is published over it with a written note" src="docs/images/studio-kb-coverage.png" width="420"></p>
<p align="center"><sub>A knowledge base names the question its documents do not answer. Publishing over the gap takes a written note.</sub></p>

<p align="center"><img alt="The publish panel of an agent draft. It lists the three lab rules the draft breaks, so there is no Publish button yet" src="docs/images/studio-agent-checks.png" width="420"></p>
<p align="center"><sub>A draft saves even when it breaks a lab rule. Publish waits until the rules pass. Every save is a revision you can compare and restore.</sub></p>


<details>
<summary>Run the studio by hand</summary>

	cp lab.example.toml lab.toml
	export DATABASE_URL=postgres://postgres:labh@localhost:5432/labh
	export LABH_PAYLOAD_KEY=$(openssl rand -hex 32) PAYLOAD_SECRET=$(openssl rand -hex 24) LABH_CONFIG=$PWD/lab.toml
	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/worker.ts &
	pnpm --filter @labh/studio dev --port 3001

Open `http://localhost:3001/admin` and create the first account before anyone else can reach the port: the first account is the PI. The PI adds the others and gives each a role. Keep `LABH_PAYLOAD_KEY`, because the payload store is encrypted with it. The worker answers the test thread and compiles knowledge bases. Point `[endpoints.local]` in `lab.toml` at Ollama or another OpenAI-compatible server for real answers.

The studio process runs outside Node's permission model, because Next.js starts child processes. It holds no model gateway and no tool runner: every model call happens in the sealed worker. The Tools panel reads a plain-data list (name, first sentence, class, hosts), not the tools themselves. It does hold the payload key, so do not give it provider API keys. [`DESIGN.md`](docs/design/DESIGN.md#unit-2-studio-and-publish) has the details.

</details>

<details>
<summary>Knowledge bases from the command line</summary>

A steward with repository access can compile and publish without the studio. A definition file names the purpose, the sources, 5 to 10 coverage questions and the compiler model (see `fixtures/kb-lab/kb.json`):

	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts compile --definition fixtures/kb-lab/kb.json --wait
	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts publish --snapshot <id>

The example definitions name the scripted test model, so for real use set the compiler to a model your `lab.toml` serves, and start the worker first: `--wait` waits for it to finish the compile. `kb` also has `coverage`, `diff` and `search`, and `publish --override-gaps "<note>" --actor <publisher>` to publish over gaps. The command checks no role: it is the steward's tool, for whoever holds the repository. A URL source is fetched only from a host that `[hosts]` in `lab.toml` allows for lab documents. Any other host is refused before a request is sent.

</details>

## Agents on Claude Code or Codex

An agent can use Claude Code or Codex as its engine, declared in `lab.toml`:

	[agent_backends.claude]
	kind = "claude-code"        # or "codex"
	placement = "approved"      # what the institution approved this account for: approved, zdr or public

Aliquot treats the CLI as one hosted model. Its task prompt, and every tool result sent back to it, pass the same egress check as any model call, so a CLI with placement `approved` never sees D3. The CLI runs under a macOS sandbox profile that denies by default:

- It has no tools of its own: no shell, no file edits, no web search. Its only tools are the agent's Aliquot tools, served over a local MCP bridge.
- Its network reaches the bridge and a proxy that tunnels only to its vendor's API hosts, checking the TLS server name.
- Outside its session folder it may read only the CLI's own install and the system libraries a process needs. It writes only inside that folder.
- A tool call that does not come through the bridge ends the run as `agent-not-confined`.

Each run records an `agent.session` event: the CLI version, exit code, tool calls and tunnels. A tool result above the agent's ceiling is withheld from the CLI and recorded as `tool.withheld`. The confinement test runs a probe under the real profile and checks one denial per gap. Confinement exists on macOS only for now. On any other platform a run on a CLI agent is refused before the CLI starts, as `agent-confinement-missing`.

A lab gives each CLI a dedicated service login: a token from `claude setup-token`, or a dedicated Codex `auth.json`. Use a placement your institution actually approved for that account. A personal subscription is `public`.

## Research tools

	[datasets.sleep-diary]
	path = "/srv/lab/data/sleep-diary"
	class = "D2"
	description = "Nightly sleep diary, one row per participant and night"
	
	[sandbox]
	image = "aliquot-sandbox@sha256:<the digest docker build printed>"

- **Literature.** Seven literature tools are built into core:
  - `openalex_search`, `pubmed_search` and `arxiv_search` find papers by keyword;
  - `europepmc_search` searches PubMed, PubMed Central and bioRxiv, medRxiv and other preprints, with abstracts, and says which hits are open access;
  - `europepmc_fulltext` reads an open-access article as headed sections, with its license, up to 24,000 characters a call;
  - `doi_lookup` gives Crossref's record for a DOI and Unpaywall's legal open copy;
  - `citation_walk` lists the works one paper cites, or the works that cite it, most cited first, through OpenAlex.

  None needs a key or an account. Each declares the hosts it may reach, and a redirect is followed only to a declared host, with each hop checked at the class of everything the call has read. With `[research] contact_email_env` set, they send that address as the polite-pool contact. Unpaywall requires one, so without it `doi_lookup` returns the Crossref record and says the open-access check was skipped. All of these hosts are public, so a literature call is refused, and nothing is sent, when the conversation holds anything above D0.
- **Datasets by class.** A data steward lists folders in `lab.toml`, each with a class. An agent mounts only datasets at or below its sandbox ceiling. A mount ceiling of D3 needs an IRB protocol on the agent, as a D3 knowledge base does.
- **`run_code`.** R or Python, one container per call, through the Docker Engine API. There is no network, no `/dev/shm`, and the root filesystem is read-only, with every capability dropped and no new privileges. It runs as user 65534, with CPU, memory, process and time limits, and with datasets mounted read-only. Its output carries the class of every dataset it mounted. `test/run-code.test.ts` checks each of these against the real container.
- **Built-in tools only.** All eleven tools are defined in core (`packages/core/src/tools.ts` and `literature.ts`), each with the class it reads, its effects and its egress hosts. A tool's requests are checked at the class of everything it has read. A lab cannot add its own tool: a `lab.toml` with a `[tools]` table stops every binary at startup. Lab tools are planned, each behind an OS-level boundary.

## Model providers

Ollama, vLLM or any OpenAI-compatible server, plus native Anthropic Messages and OpenAI Responses clients. An agent can send each data class to a different model.

<details>
<summary>Protocols, sampling and per-class routing</summary>

An endpoint in `lab.toml` speaks one of three protocols: `openai-chat` (the default, for Ollama, vLLM and other compatible servers), `anthropic-messages` or `openai-responses`. Model ids are exact: a provider that serves a different snapshot than the one pinned is a mismatch, not an answer. On the two native protocols Aliquot sends no `temperature` or `top_p` unless the endpoint sets `sampling = true`, because current reasoning models reject them. A tool turn's provider output, such as Anthropic thinking blocks or Responses reasoning items, is sent back unchanged, and only to the model that wrote it.

An agent can route by class with `modelsByClass`. For example, D0 and D1 go to a hosted model, and anything above goes to `model`, the top band, on lab hardware. When a tool result raises a run's class, the next call moves to the band that admits it.

</details>

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
    worker --> tools[Tools<br/>KB, literature, datasets]
    tools --> sandbox[run_code<br/>container, no network]
    worker --> record[(Run record<br/>hash-chained, encrypted)]
    worker --> egress{decideEgress}
    egress -->|class allowed| local[Local model<br/>Ollama, vLLM]
    egress -->|up to the placement's class| hosted[Hosted model<br/>Anthropic, OpenAI]
    egress -->|up to the placement's class| cli[Claude Code or Codex<br/>confined, tools via a bridge]
    egress -.->|refused, recorded| record
```

Three ideas carry the design.

**One place decides where data may go.** Content gets a data class where it enters. The gate classifies each message, a snapshot carries the highest class of its sources, and a tool result carries the class of what the tool reads. `lab.toml` gives every destination a placement, and the placement decides the highest class it may receive. `decideEgress` in `packages/core/src/dataclass.ts` is the only function that answers "may this go there", and each kind of destination has one call site. A static scanner over Aliquot's own source and a runtime seal in the sealed processes close the routes around it, such as a module that calls `fetch` directly. The model gateway never follows a redirect, so a prompt and a key reach only the endpoint `lab.toml` names.

| Class | Meaning | Highest model placement it may reach |
|---|---|---|
| D0 | Public | `public`, any endpoint |
| D1 | Internal: lab documents, such as SOPs, that are fine to share with a vetted provider | `zdr`, a hosted model with zero data retention |
| D2 | Confidential, such as contact details or unpublished results | `approved`, a service the institution approved |
| D3 | Restricted, such as participant identifiers | `lab` or `institution` hardware only |
| R | Review-confidential | Nowhere by default |

**The run record is the workflow.** A run has no state outside its append-only event log. To resume after a crash, a worker folds the events and asks one pure function, `next()` in `loop.ts`, what to do. A step that is not in the record did not happen. A lease epoch fences off a worker that lost its claim, so each run finishes exactly once.

**Everything is addressed by content.** Agent versions, knowledge base snapshots, entries and payloads are named by their hash. A snapshot diff is a diff of two maps. A run names the agent version that answered, so a later edit cannot change what an old run did.

The full design, with the trade-offs and the alternatives considered, is in [`docs/design/DESIGN.md`](docs/design/DESIGN.md). It was first sketched from Sanity's write-up of their company agent harness, [How we built our company agent harness](https://www.sanity.io/engineering/how-we-built-our-company-agent-harness), and then changed for what a lab needs.

## What is checked

Each check script starts real worker and web processes (and, for `unit2`, the studio) against Postgres and scripted fake models, and prints one line per check.

| Command | What it proves |
|---|---|
| `pnpm test` | Unit and integration tests: the core, the studio fields, the agent CLI bridge, proxy and sandbox profile (macOS), the provider wire formats against fake servers, the built-in tools and the seal, and `run_code` against Docker when the sandbox image is built. |
| `pnpm slice1` | The run loop: crash and resume exactly once, a zombie worker fenced off, idempotent intake, restricted data refused with zero hosted requests, limits, stop, and the network seal against planted routes. |
| `pnpm unit3` | Knowledge bases: compile, coverage gaps blocking publish, a restart mid-compile, `kb_search` and `kb_read` in a run, snapshot diff, refused URL hosts, publish with an override note. |
| `pnpm lab0` | The first-use check on a synthetic lab, described below. |
| `pnpm unit2` | The studio in a headless browser: author, test and publish an agent, diff and restore, roles, a knowledge base built in the form and published over a gap, and a restricted knowledge base refused on a hosted agent. |

The tests that need macOS or the sandbox image skip elsewhere, each with its reason; CI runs on Linux.

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

### What ran live

Everything above runs on scripted fakes. These ran against the real thing, on a developer's Mac, through `pnpm demo:agent`:

| What | How | Result |
|---|---|---|
| Claude Code 2.1.303, `claude-haiku-5-5` | The developer's own login, through `dev_shared_login`, as a `public` placement | Handbook questions answered with the entry cited. A research question ran `dataset_list`, `run_code` and `openalex_search`, and its wave means matched the CSV. The participant-id question was refused before anything was sent. Tunnels went only to `api.anthropic.com`. |
| Codex 0.155.1, `gpt-5.6-luna` | The same, with a copy of the developer's `auth.json` | Handbook question answered through the bridge, participant-id question refused. Tunnels went only to `chatgpt.com`; its analytics host was refused. |
| OpenAlex, PubMed, arXiv | One probe each, repeated once later | The tool fixtures are trimmed from the first responses. The repeat returned every field the fixtures hold. |
| Europe PMC, Crossref, Unpaywall, OpenAlex citations | One call of each v0.3 literature tool through the tool runner, plus the refusals: a closed-access article, an unknown DOI, and a D3 question that sent nothing | The fixtures are those exact responses, whole. |

Not yet run live: the Anthropic and OpenAI API clients. They are tested against fake servers built from the published API references, with no API key. A dedicated service login for either CLI has not been tried either.

## Status and roadmap

Aliquot is early. It has been tested on a synthetic lab, not used by a real one.

**Built**

- The durable run loop: crash and resume, lease fencing, stop with confirmation, step, token and time limits.
- Data classes, the single egress decision, the static boundary scanner and the runtime network seal.
- Knowledge bases: compile through the gateway, the coverage gate, `kb_search` and `kb_read`, snapshot diff, URL sources from listed lab hosts.
- The studio: agent and knowledge base forms, revisions with diff and restore, a test thread, publish checks, a list of the deployed tools and five roles.
- A chat page for members, a record page for each run, and `pnpm aliquot record` in a terminal.
- Claude Code and Codex as confined agent engines, on macOS.
- Research tools, built into core: OpenAlex, PubMed, arXiv and Europe PMC search, open-access full text, DOI lookup with open copies, citation walks, datasets by class, and `run_code` for R and Python in a container.
- Native Anthropic Messages and OpenAI Responses clients, and per-class model routing.
- The web door, the encrypted payload store and the hash-chained audit stream.

**Not built yet, roughly in order**

- Slack and Teams front doors.
- A router across several agents. Today a channel is bound to one agent.
- Agent CLI confinement on Linux.
- Tools a lab adds itself, each run behind an OS-level boundary.
- Skills, and scheduled runs.
- Studies: freeze an agent version, export an agent card, reviewer replay and PROV export. The types exist; the functions are stubs.
- Consent checks against knowledge base sources.
- Key rotation, per-class keys and a retention sweep.
- University sign-on, a production studio build with committed migrations, and container images.
- PDF sources. Today a source is Markdown, text or a page on a listed host.

**Known limits**

- The version hash covers what the run loop reads, but not yet the system prompt text the core builds around it.
- Detection of restricted text is pattern-based. A lab must give its own patterns in `lab.toml`, and text no pattern matches keeps its declared class.
- The studio runs unsealed, as described above.
- A lab cannot add its own tools. Aliquot runs only its eleven built-in tools. Contributed tools are planned, behind an OS-level boundary (a separate user, a container or a VM), because code in the worker's process shares its memory and its JavaScript realm with core.
- The seal stops a mistake in Aliquot's code or a dependency from reaching the network. It is not a sandbox for hostile code in the process.
- A built-in tool's version is the hash of its spec, not its code. A change to a tool's code alone moves no agent version.
- Under `dev_shared_login`, Claude Code reads its credential from the developer's keychain. That is why the mode is for a developer's machine only.
- The web door has no sign-in and does not check an agent's audience yet. It listens on `127.0.0.1` only. Do not expose it beyond the machine until sign-on lands.

## Repository layout

	packages/core      the harness: gate, run loop, record, gateway, knowledge bases, tools, agent CLIs, publish
	packages/studio    the authoring studio (Payload CMS on Next.js)
	sandbox/           the run_code container image
	scripts/           the check scripts and the boundary scanner
	fixtures/          synthetic agents, knowledge bases and the lab0 lab
	docs/design/       the design, the first slice, and the stack decisions

## For research IT and the IRB

[`docs/for-research-it-and-irb.md`](docs/for-research-it-and-irb.md) is for the people who decide whether a lab may run Aliquot: where each class of data may go, what runs where, what is stored and under which key, and what is not covered yet.

## Working with a coding agent

[`AGENTS.md`](AGENTS.md) tells a coding agent how to set up the repo, which checks to run and which boundaries the checks enforce. Point your agent at it.

## License

[Apache-2.0](LICENSE).
