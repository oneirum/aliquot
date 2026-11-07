<h1 align="center">Aliquot</h1>

<p align="center">
Agents that answer a lab's questions from its own SOPs, datasets and papers.<br>
Data the lab marks restricted, such as participant ids, is refused before it reaches a hosted model.<br>
Every answer leaves a record you can check. Open source, and it runs on a laptop.
</p>

<p align="center">
<a href="https://github.com/oneirum/aliquot/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/oneirum/aliquot/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
<a href="https://github.com/oneirum/aliquot/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/oneirum/aliquot"></a>
<a href="package.json"><img alt="Node 26 or later" src="https://img.shields.io/badge/node-%E2%89%A526-339933"></a>
<a href="CITATION.cff"><img alt="Cite this software" src="https://img.shields.io/badge/cite-CITATION.cff-8a2be2"></a>
</p>

<p align="center">
<a href="#quickstart">Quickstart</a> ·
<a href="#install-on-a-lab-machine">Install</a> ·
<a href="#what-it-does-for-a-lab">What it does</a> ·
<a href="#the-chat-page-and-the-record">Chat and record</a> ·
<a href="#agents-on-claude-code-or-codex">Agent CLIs</a> ·
<a href="#research-tools">Research tools</a> ·
<a href="#how-it-works">How it works</a> ·
<a href="#what-is-checked">What is checked</a> ·
<a href="#status-and-roadmap">Status</a> ·
<a href="docs/README.md">Docs</a>
</p>

<p align="center">
<img alt="The Aliquot chat page with Claude Code as the agent. A question about thawing samples is answered from the lab handbook with its sources named. A research question is answered by listing the datasets, running Python over a synthetic sleep diary in a container and searching OpenAlex. A question naming participant LAB0-0003 is refused before anything is sent. The first answer's run record opens with a summary of its model and tool calls, then a verified hash chain and every step with its data class" src="docs/images/demo.gif" width="900">
</p>

<p align="center"><sub>A scripted browser capture of <code>pnpm demo:agent --backend claude-code --research</code>: a live run of Claude Code (<code>claude-haiku-5-5</code>) on a developer's own login, in real time. <a href="docs/images/demo.mp4">Full-size MP4</a>, easier to read on a phone.</sub></p>

## Quickstart

You need Node 26 or later, pnpm 10 and Docker. The demo and the checks use scripted fake models, so you need no model download and no API key.

	git clone https://github.com/oneirum/aliquot.git
	cd aliquot
	pnpm install
	pnpm run doctor # optional: checks Node, Docker, ports and the sandbox image, and says the fix for each
	pnpm demo

`pnpm demo` starts Postgres in Docker if it is not running, seeds the synthetic lab0 lab, compiles and publishes its handbook from three documents, and starts the worker and the web door. It prints a link to the chat page with two questions to try:

1. **"Which freezer rack holds the aliquots?"** The agent searches the handbook, quotes the entry and names its path.
2. **"Is LAB0-0003 still pending for wave 1?"** `LAB0-0003` matches the lab's participant id format, so the message is restricted (D3). The demo agent's model stands in for a hosted vendor that may receive at most D1, so nothing is sent, and the page says why.

Under each answer, **Record** opens the run's record: every model call, tool call and refusal, and a check that the hash chain is intact. `pnpm aliquot record <run-id>` prints the same record in a terminal, and `pnpm aliquot runs` lists the newest runs with their outcomes and chain checks, so you can find a run id without the browser. Both take `--json`. The demo prints the full commands, with its database.

The demo's model is a scripted fake that searches, reads the top entry and quotes it. It shows the harness, not answer quality. Add `--studio` to start the authoring studio as well.

To run the checks:

	docker compose up -d postgres
	pnpm typecheck
	pnpm test
	pnpm lab0

`pnpm lab0` runs the first-use check on a synthetic lab. It prints one `PASS` or `FAIL` line per check and ends with `16/16 checks passed`.

If port 5432 is taken, set `LABH_PG_PORT` for every command, for example `export LABH_PG_PORT=55433` before `docker compose up -d postgres`.

### With a real agent

On a Mac where Claude Code or Codex is logged in, the same lab runs on the real CLI:

	docker build -t aliquot-sandbox sandbox     # once, for --research
	pnpm demo:agent --backend claude-code --research
	pnpm demo:agent --backend codex --model <a model id your login serves>

`--research` adds a third question that needs data, code and literature: how mean sleep time changed between two waves of a made-up sleep diary, and one paper comparing actigraphy with sleep diaries. The agent lists the datasets, runs Python over the CSV in the sandbox and searches OpenAlex.

This uses your own CLI login (`dev_shared_login`), so it is for a developer's machine only, and the agent sees public (D0) data alone. A lab uses a dedicated service login; see [Agents on Claude Code or Codex](#agents-on-claude-code-or-codex).

## Install on a lab machine

A Linux machine needs only Docker. One `docker compose up` starts Postgres, the worker, the web door and a production build of the studio, which applies its committed migrations when it starts.

	git clone https://github.com/oneirum/aliquot.git
	cd aliquot
	docker compose run --rm init
	docker compose up -d --build

`init` asks where the lab's model runs, the web door port and the lab's participant id patterns. It tests the patterns against ids you paste, with a PASS or FAIL line for each, and asks again on a FAIL. It writes `config/lab.toml`, and `.env` with new `POSTGRES_PASSWORD`, `LABH_PAYLOAD_KEY` and `PAYLOAD_SECRET` values and the `ALIQUOT_ACP_TOKEN` and `ALIQUOT_STUDIO_TOKEN` surface tokens. It never rewrites an existing `.env`: a new `LABH_PAYLOAD_KEY` would make every stored payload unreadable. On a machine with Node, `pnpm aliquot:init` does the same.

The web door is on port 3000 and the studio on 3001, published on `127.0.0.1` only. Without sign-on the web door trusts the member id it is given, so it refuses to listen beyond the machine until `lab.toml` has `[auth]`; then put the lab's reverse proxy in front of it and set `LABH_BIND`. Knowledge base definitions and their source files go in `config/`, which the containers see at `/etc/aliquot`, and compile with the kb command inside the worker:

	docker compose exec worker aliquot-kb compile --definition /etc/aliquot/kb.json --wait
	docker compose exec worker aliquot runs

**PDF sources and `run_code`** need the sandbox image: `docker build -t aliquot-sandbox sandbox`, then answer yes to init's sandbox question with the id that `docker image inspect --format '{{.Id}}' aliquot-sandbox` prints. init then adds `compose.sandbox.yaml` to `.env`, which gives the Docker socket to the worker only. A PDF is read by poppler inside that container, with no network and a read-only root. A scanned page fails with a message, because Aliquot does no OCR. The studio gets no socket, so a PDF source compiles with the kb command.

**Backup and restore.** `scripts/backup.sh` writes the database dump and a copy of every payload key the lab holds, with checksums. Keep the keys apart from the dump: the payloads in the dump are encrypted under them, and anyone with both can read them. `scripts/restore.sh <dir>` refuses when `.env` is missing one of the backup's keys and names its id, then replaces the database, restarts the stack and checks every run's hash chain. [`docs/install.md`](docs/install.md) has the details.

**Keys and retention.** A data steward can rotate the payload key without a gap: `lab.toml` names keys by id, new payloads go under the current one, each stored payload is read with the key it was written under, and `aliquot keys reencrypt` moves the old ones over, in resumable batches, without changing a hash. `aliquot keys status` shows what each key holds. `[store.class_keys]` keeps D3 under a key of its own, and a process that is not given that key shows a D3 body as unavailable rather than failing. `[policy.retention]` sets a floor and a purge per class; `aliquot retention --dry-run` lists what is past the window and `--apply` deletes those bodies, clears the door's copy of the reply and keeps a tombstone with the hash, so every record still verifies and the record page says "Redacted on <date> by the lab's retention window". `pnpm walk:keys` runs the whole sequence on a synthetic lab.

`scripts/compose-check.sh` proves the whole path on a machine with only Docker, and CI runs it on a clean Ubuntu runner. It brings the stack up, gets a cited answer from the lab0 handbook, reads a LaTeX PDF and a Word PDF in the sandbox, requires the scanned page to fail, then backs up, wipes the database, restores and requires the same run to verify again.

## What it does for a lab

A lab answers the same questions every week. Where the freezer log is, how a variable is coded, what the SOP says about a sample that came in late, what the literature says about a measure. The answers live in documents, datasets and papers nobody has time to search. Aliquot turns them into agents the lab owns.

- **Answers from your own documents.** A steward compiles SOPs, codebooks and onboarding notes into a knowledge base, from Markdown, text, the Word files the lab already keeps, or PDFs with real text. Agents search it and cite the entry they used.
- **Research tools.** Agents can search OpenAlex, PubMed, arXiv and Europe PMC, read open-access papers in full, look up a DOI and where a legal open copy is, and walk citations. They can also list the lab's datasets and run R or Python over them in a container with no network.
- **Claude Code or Codex as the agent.** An agent can run on one of these CLIs instead of a model endpoint. The CLI is confined: it has no tools of its own, and it reaches only Aliquot and its vendor's API.
- **Restricted data does not leave.** Every piece of content carries a data class. Participant identifiers are restricted, and restricted content never reaches a hosted model or a hosted agent CLI: the harness refuses the call and records the refusal. One agent can send public questions to a hosted model (Anthropic, OpenAI) and restricted ones to a lab model (Ollama or any OpenAI-compatible server).
- **Built by the people who know the work.** Agents and knowledge bases are forms in a web studio, with revisions, diff, restore, a test thread and a publish button. No git, no deploy.
- **Coverage before publish.** A knowledge base lists the questions it must answer. If the documents do not support one, publish is refused and names the gap, unless a publisher overrides it with a written note.
- **A record for every answer.** Each run is an append-only, hash-chained log of every model call, tool call, CLI session and refusal. A crashed run resumes from its record, and the record is what a reviewer reads later: it opens with a summary of what the run read, called and refused, and downloads as JSON. Each run names the hash of the agent version that answered.
- **Studies an IRB can cite.** A PI freezes the agent version a study uses, an IRB reads its card and a sheet generated from the deployment, and a reviewer replays a run from an exported bundle without the lab's database.

## Data classes

A lab's data is not one kind of restricted. Participant ids, PHI, dbGaP releases and export-controlled drawings each come with their own rules, and `lab.toml` says what they are. Every message and every knowledge base source is put in one class before any model sees it, and the class decides three things:

- **Which model may read it.** `model_tier = "hosted"` (an approved hosted model), `"local"` (only a model on lab or institution hardware), or `"none"` (no model: the door refuses it before a run exists, and a knowledge base source in it is refused before the compiler is called).
- **What the record keeps of a refused message.** `record = "text"`, `"hash"` or `"none"`, with `retention_days` for how long.
- **What the member is told.** Every refusal names the class, the detector that found it and the rule it applied, in the chat, in Slack and in the record:

```text
Not sent. Data class phi, found by detector phi-name; rule model_tier = "none". This message carries a HIPAA
identifier. Remove it, or ask the lab's honest broker for a de-identified extract. Recorded as audit event 2.
```

```toml
[classes.phi]
model_tier = "none"
record = "hash"
retention_days = 30
detectors = ["hipaa-safe-harbor"]   # names, addresses, dates, ages over 89, fax, plan, account, licence, vehicle, device, URL, IP, biometric ids, SSN, MRN

[classes.controlled_access]         # NIH controlled-access data: the DUC keeps it out of AI tools
model_tier = "none"
detectors = ["dua-marker"]          # "DUA: ..." lines, dbGaP phs accessions, EGA ids

[classes.export_controlled]
model_tier = "local"
residency = "us"                    # read only by an endpoint whose lab.toml entry says region = "us"
detectors = ["export-marker"]       # ITAR, EAR99, ECCN, USML categories
```

With no `[classes]` table a lab has the five built-in classes, which behave exactly as Aliquot did before classes: `public` (D0), `internal` (D1), `confidential` (D2: phone numbers and email addresses), `restricted` (D3, local only: SSNs, MRNs, dates of birth, the lab's participant id patterns) and `review-confidential` (R). Each class sits at one level of the D0 to R lattice, and the level is what every egress decision reads, so a class cannot loosen what the lattice enforces: a `hosted` class must be D0 to D2, a `local` one D3 or R, and `lab.toml` fails to load otherwise. The studio's knowledge base page lists the classes and which published entries carry each. `pnpm walk:policy` asks one question per class on the synthetic lab and prints what the member reads and how many requests reached each model; the table for a review is in [`docs/for-research-it-and-irb.md`](docs/for-research-it-and-irb.md#classes-a-lab-declares).

## The chat page and the record

Members ask on the chat page. An answer names the entry it came from and says what the run read and how long it took. Answers keep their lists, headings and code blocks, and no model text is ever parsed as HTML. A message with a participant id is refused before anything is sent, and the page says why.

<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/images/chat-dark.png">
<img alt="The chat page. A question about the freezer rack is answered from the lab handbook, with its source entry, a line saying how many entries and tool calls the run used and how long it took, and a Record link. A question naming participant LAB0-0003 is refused: the message is D3 and the agent's model may receive at most D1, so nothing was sent" src="docs/images/chat-light.png" width="860">
</picture>
</p>

A channel can hold more than one agent, say the handbook agent and a methods agent. Each question goes to the agent it fits, and the answer names that agent beside the time. When a question fits more than one, the page lists them by name with one line each and the member picks one with a click, a tap or its number; the same question goes to that agent, and the rest of the thread stays with it. The router runs in the door and calls no model, so a restricted question is routed without leaving the machine. Its decision and every agent's score are in the record. `pnpm walk:router` walks through it on the synthetic lab.

**Record** under an answer opens the run's record. It starts with a summary: the outcome, the time, model calls, tokens, tool calls by name, knowledge base entries retrieved and refusals. Below it, every event in order, each marked by shape as well as name (run, model call, tool call, refused), with its data class and whether the hash chain holds. **Download JSON** saves the record, so a PI or an IRB reader can keep it without running anything. `pnpm aliquot record <run-id>` prints the same record and summary in a terminal.

**Runs** at the top of every page lists the newest runs with their outcome and refusal count, and narrows to the runs that had a refusal or failed, so a PI can go straight to what was refused. On a record that refused something, **Only refusals** hides the other events. The chat thread stays put when you open a record and come back.

**Source** under an answer opens the entry it names, read-only, from the knowledge base snapshot the run read, and says whether the record holds that entry's hash. An entry at D3 or R opens only for the data steward or the PI, and the chip says so instead. A Source line that names no entry the run read says that too.

**Sign-on.** With an `[auth]` table in `lab.toml`, members sign in with the university's OpenID Connect provider (Entra ID, Okta, Keycloak, CILogon) and the door knows who is asking. Each run's record names the member by the provider's stable id (`sub`, or `eppn` on an InCommon campus). The role comes from the studio account with the member's email, or from a group claim the lab maps (`roles_claim`). A session unused for `idle_timeout_minutes` (30 by default) ends. The page asks as the signed-in member, whatever a request body says. **Runs** then lists the runs a member asked signed in; the data steward and the PI see everyone's, token surfaces' runs included. Another member's record, its events and its sources answer 404, and the Source chip opens only an entry the run retrieved. Only with `[auth]` may the door listen beyond the machine (`[surfaces.web] bind`). `pnpm walk:signon` walks two members and a PI through all of it against a local test provider, step by step, with a PASS or FAIL line for each; `--stills <dir>` also saves the pages. [`docs/install.md`](docs/install.md) has the setup for research IT.

The chat page installs as an app called Aliquot, with the lab's name in its full name, and says how in one line until it is installed. Its service worker caches the page and its icons so the app opens without the network, and nothing else: answers, the runs list and records always come from the door, so none of them is kept on the device. Browsers install only from HTTPS or from the machine itself, so phones get it once the door is reachable under sign-on. `scripts/webapp-audit.ts` asks Chrome whether the page is installable; `scripts/icons.ts` renders the icons from `packages/core/assets/icon.svg`.

<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/images/record-dark.png">
<img alt="The record page of an answered run. A summary band shows the outcome (answered), the time, 3 model calls, the tokens in and out, 2 tool calls (kb_search, kb_read), the entries retrieved and 0 refused. Below are the run id, the agent version hash, a verified chain over 13 events, a legend of event shapes and the first events of the table" src="docs/images/record-light.png" width="860">
</picture>
</p>
<p align="center"><sub>Captures of <code>pnpm demo</code> with its scripted fake model. Your system's light or dark setting picks the image.</sub></p>

## Studies and replay

A PI who uses an agent in a study freezes the version the protocol names, so nothing published later changes what participants talk to. The study owner runs these on the lab server. `--as` is self-declared, so each change is in the audit stream with the OS user who ran it beside the member it names.

```sh
pnpm aliquot study create sleep-2026 --title "Sleep diary study" --as pi-lab --floor D1 --irb IRB-2026-114
pnpm aliquot study bind sleep-2026 web:sleep-study --as pi-lab
pnpm aliquot study freeze sleep-2026 handbook --as pi-lab --note "the version in the pre-registration"
```

A channel bound to a study runs its frozen version and is never routed or re-resolved, and its runs record `route: pinned` with the study id. A new publish of the agent reaches every other channel and not this one. A message in a study channel takes the study's data floor as its class at least, and runs only when the frozen version's ceiling admits that class and the member is in its audience; otherwise the member is told why and nothing is sent. A freeze takes the agent's current version, or a version an earlier freeze stored a listing for, and checks that it runs on this deployment, that the agent's ceiling admits the study's data floor, and that it names the study's IRB protocol when the floor is D3. `study unfreeze <id> <agent> --as <owner> --reason <why>` ends a freeze; it is recorded as a protocol deviation, and `study show <id>` lists every deviation. The database refuses to rewrite or delete a freeze.

`pnpm aliquot card <hash>` prints the agent card of a version as JSON: the model and the placement of its endpoint, each tool with its spec hash, the knowledge base snapshots with their classes, the data ceilings, the hash of the exact system prompt, and the studies that froze it. [`schemas/agent-card.schema.json`](schemas/agent-card.schema.json) is its schema. The version hash covers the system prompt text the core adds around the instructions, so a release that rewords that text gives every agent a new version, and a frozen version keeps its old text. `pnpm aliquot sheet` prints the research IT and IRB sheet for this `lab.toml`: every surface, endpoint and tool host with its placement and ceiling, the store and its key, retention, the agents, and each study with its frozen versions and deviations.

A reviewer gets a bundle, not database access. `pnpm aliquot:export --study sleep-2026 --clearance D1 --out bundles/sleep-2026` writes the study's runs as JSON lines, the agent cards and resolved agents, the snapshot manifests and the entries the runs read, the tool hashes, the payload bodies at or below the clearance (each one an egress decision; the rest appear as hash and class only), the deviations, and `prov.json` in W3C PROV-JSON. Anyone with the bundle and Aliquot runs `aliquot replay <dir>`, with no lab.toml, database or key: it verifies every hash chain and every included body against the sha256 the bundle commits to, and prints what each run did. That shows the bundle is internally consistent; it shows the bundle is the lab's record only when each run's head matches the lab's anchor or a hash the lab gave out of band. `aliquot replay <dir> --reexecute --endpoint <url> --endpoint-placement lab` runs each run again against a model endpoint, with every tool answered from the recording, and reports whether the tool calls, the answer and the outcome agree or where they first diverge. The placement is the reviewer's statement of where that endpoint runs (default `public`), and a run whose bodies that placement may not receive is skipped before any request. Each export is in the lab's audit stream as `export.created`.

`pnpm walk:study` runs all of this on the synthetic lab with fake models: a PI freezes the handbook agent, a publish leaves the study channel alone, the IRB reads the card, an unfreeze shows as a deviation, and a reviewer in an empty directory replays the exported run and gets exact agreement.

## The studio

The studio is where lab members write agents and knowledge bases, with no repository access. It is Payload CMS in `packages/studio`, on the same Postgres in its own schema. Beside an agent's form, the Tools panel lists every built-in tool with what it does, the hosts it reaches, and which ones the agent already uses.

<p align="center"><img alt="The coverage panel of a knowledge base in the studio. Six of seven questions have a supporting entry, the parking permit question is named as a gap, and the knowledge base is published over it with a written note" src="docs/images/studio-kb-coverage.png" width="420"></p>
<p align="center"><sub>A knowledge base names the question its documents do not answer. Publishing over the gap takes a written note.</sub></p>

<p align="center"><img alt="The publish panel of an agent draft. It lists the three lab rules the draft breaks, so there is no Publish button yet" src="docs/images/studio-agent-checks.png" width="420"></p>
<p align="center"><sub>A draft saves even when it breaks a lab rule. Publish waits until the rules pass. Every save is a revision you can compare and restore.</sub></p>


<details>
<summary>Run the studio by hand</summary>

	cp lab.example.toml lab.toml
	export DATABASE_URL=postgres://postgres:labh@localhost:5432/labh LABH_CONFIG=$PWD/lab.toml ALIQUOT_STUDIO_TOKEN=$(openssl rand -hex 32)
	key=$(openssl rand -hex 32)
	LABH_PAYLOAD_KEY=$key node --permission '--allow-fs-read=*' --allow-net packages/core/bin/worker.ts &
	LABH_PAYLOAD_KEY=$key node --permission '--allow-fs-read=*' --allow-net packages/core/bin/web.ts &
	PAYLOAD_SECRET=$(openssl rand -hex 24) pnpm --filter @labh/studio dev --port 3001

Open `http://localhost:3001/admin` and create the first account before anyone else can reach the port: the first account is the PI. The PI adds the others and gives each a role. Keep `$key`, because the payload store is encrypted with it. Only the worker and the web door get it. The studio reaches core through the web door with `ALIQUOT_STUDIO_TOKEN`, the token `[surfaces.studio]` names. The worker answers the test thread and compiles knowledge bases. Point `[endpoints.local]` in `lab.toml` at Ollama or another OpenAI-compatible server for real answers.

The studio process runs outside Node's permission model, because Next.js starts child processes. So it holds no payload key, no model gateway and no tool runner. Every read and write it makes of core goes to the web door's `/studio` routes, which check the member's role and the data's class, and every model call happens in the sealed worker. The Tools panel reads a plain-data list (name, first sentence, class, hosts), not the tools themselves. Do not give it provider API keys. [`DESIGN.md`](docs/design/DESIGN.md#unit-2-studio-and-publish) has the details.

</details>

<details>
<summary>Knowledge bases from the command line</summary>

A steward with repository access can compile and publish without the studio. A definition file names the purpose, the sources, 5 to 10 coverage questions and the compiler model (see `fixtures/kb-lab/kb.json`):

	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts compile --definition fixtures/kb-lab/kb.json --wait
	node --permission '--allow-fs-read=*' --allow-net packages/core/bin/kb.ts publish --snapshot <id>

The example definitions name the scripted test model, so for real use set the compiler to a model your `lab.toml` serves, and start the worker first: `--wait` waits for it to finish the compile. `kb` also has `coverage`, `diff` and `search`, and `publish --override-gaps "<note>" --actor <publisher>` to publish over gaps. The command checks no role: it is the steward's tool, for whoever holds the repository. A URL source is fetched only from a host that `[hosts]` in `lab.toml` allows for lab documents. Any other host is refused before a request is sent.

A `.pdf` source is read only by this command, and only when `lab.toml` has `[sandbox]`: poppler's `pdftotext` runs in the run_code image, with no network and a read-only root. A PDF of scanned pages has no text to read, and Aliquot does not do OCR, so a file with a scanned page is refused, naming the pages. Export it again from the program that made it, or save it as `.docx`. The studio has no Docker socket, so it refuses a `.pdf` with the same advice.

</details>

## Agents on Claude Code or Codex

An agent can use Claude Code or Codex as its engine, declared in `lab.toml`:

	[agent_backends.claude]
	kind = "claude-code"        # or "codex"
	placement = "approved"      # what the institution approved this account for: approved, zdr or public
	api_key_env = "LAB_ANTHROPIC_KEY"   # a key the lab owns, never a personal subscription

Aliquot treats the CLI as one hosted model. Its task prompt, and every tool result sent back to it, pass the same egress check as any model call, so a CLI with placement `approved` never sees D3. The CLI runs under a macOS sandbox profile that denies by default:

- It has no tools of its own: no shell, no file edits, no web search. Its only tools are the agent's Aliquot tools, served over a local MCP bridge.
- Its network reaches the bridge and a proxy that tunnels only to its vendor's API hosts, checking the TLS server name.
- Outside its session folder it may read only the CLI's own install and the system libraries a process needs. It writes only inside that folder.
- A tool call that does not come through the bridge ends the run as `agent-not-confined`.

Each run records an `agent.session` event: the CLI version, exit code, tool calls and tunnels. A tool result above the agent's ceiling is withheld from the CLI and recorded as `tool.withheld`. The confinement test runs a probe under the real profile and checks one denial per gap. Confinement exists on macOS only for now. On any other platform a run on a CLI agent is refused before the CLI starts, as `agent-confinement-missing`.

A lab gives each CLI a key the lab or the institution owns, in the variable `api_key_env` names: an Anthropic organization key reaches Claude Code as `ANTHROPIC_API_KEY`, an OpenAI organization key reaches Codex as `CODEX_API_KEY`. Codex also takes a dedicated `auth.json` holding the lab's key (`auth_file`). Use a placement your institution actually approved for that account. A personal Claude or ChatGPT subscription cannot power a lab deployment, because the vendors' terms do not allow a shared server to use one. Its OAuth token (`auth_env`) parses only at `public` and runs only under `agent-worker --dev-shared-login`, for a developer's own smoke test.

## From other harnesses

A terminal, tmux, T3 Code or a lab's own orchestrator can reach Aliquot's agents through one contract, with no adapter per tool. Every route goes through the web door, so the gate and the record apply as they do for the chat page. [`docs/harnesses.md`](docs/harnesses.md) has the details.

| From | Run |
|---|---|
| A terminal or a script | `pnpm aliquot ask --user member-1 --json "question"`: one JSON line per step (`started`, `tool`, `finished` or `refused`), each with the record link |
| tmux | `pnpm up:tmux --config lab.toml`: the worker, the web door and an `ask` shell as windows of one session |
| T3 Code, Zed or another ACP client | `aliquot acp`, added as a local ACP command: each question a thread, ending with the record link |
| A member's own Claude Code, Codex or Cursor | `aliquot mcp`, added as a stdio MCP server: one tool, `ask`, on the member's own subscription ([docs/harnesses.md](docs/harnesses.md)) |
| Slack | `aliquot slack` (`docker compose --profile slack up -d`): mention Aliquot in a channel or send it a DM, and the answer posts in the thread with its record link. Socket Mode, so no public URL. The app manifest and setup are in [docs/slack.md](docs/slack.md) |
| Microsoft Teams | `aliquot teams` (`docker compose --profile teams up -d`): mention Aliquot in a channel or group chat, or message it directly, and the answer posts in the thread with its record link. Only activities the Bot Framework signed for the lab's app and tenant are read. The app manifest and the steps for the campus Teams admin are in [docs/teams.md](docs/teams.md); `pnpm demo --teams` runs it against a stand-in for Teams |

`--ceiling D1` keeps an answer above D1 out of a client that stores its own copy, such as T3 Code's thread history. The client gets the record link instead.

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

Ollama, vLLM or any OpenAI-compatible server, plus native Anthropic Messages, OpenAI Responses and Amazon Bedrock Converse clients, and the campus contracts most universities buy: Azure OpenAI (including deployment URLs with `api-version`), Claude in Microsoft Foundry, and Bedrock signed with AWS Signature Version 4 in Aliquot itself, with no AWS SDK. An agent can send each data class to a different model.

An endpoint says whether it is under a business associate agreement (`baa = true`) and where the vendor keeps the data (`region = "us"`). A message or knowledge base carrying PHI is refused at any hosted endpoint without `baa = true`, and export-controlled or CUI content at any hosted endpoint whose region is not `us`, before a request leaves. The chat page, Slack and the record all name the rule. Anthropic's BAA covers its first-party API and Claude in Microsoft Foundry ([Anthropic](https://privacy.anthropic.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers)), Microsoft is a business associate for Azure ([Microsoft](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-hipaa-us)), and Amazon Bedrock is HIPAA-eligible ([AWS](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)). Each of those needs the institution's own agreement with the vendor; `baa = true` records that the lab has one, it does not create one.

<details>
<summary>Protocols, sampling and per-class routing</summary>

An endpoint in `lab.toml` speaks one of four protocols: `openai-chat` (the default, for Ollama, vLLM, Azure OpenAI and other compatible servers), `anthropic-messages` (also Claude in Foundry, at `https://<resource>.services.ai.azure.com/anthropic`), `openai-responses` or `bedrock-converse` (with `aws_region` and `models`; the keys come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` unless the endpoint names other variables). An Azure deployment URL takes `api_version`, sent as `?api-version=` on every request. `lab.example.toml` has one of each. Model ids are exact: a provider that serves a different snapshot than the one pinned is a mismatch, not an answer. On the two native protocols Aliquot sends no `temperature` or `top_p` unless the endpoint sets `sampling = true`, because current reasoning models reject them. A tool turn's provider output, such as Anthropic thinking blocks or Responses reasoning items, is sent back unchanged, and only to the model that wrote it.

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
| `aliquot verify --anchors` | That nobody rewrote history in the database. The worker signs the head of the audit stream and of each closed run into an anchor log outside the database every few minutes, with a key the database never holds. This checks every line's signature and that the database still holds each signed hash, and names the first seq that changed. `test/anchor.test.ts` rewrites an audit row and a run event, recomputes every later hash so plain `aliquot verify` passes, and shows this check fail at that seq; it also catches a forged line, a line under another key, and a removed line. |
| `pnpm trust` | The trust numbers in [`docs/trust.md`](docs/trust.md): unsupported claims, wrong citations, refusals both ways and planted instructions obeyed, on a larger synthetic lab. No Postgres and no key; CI runs it on every push. |
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
| One channel with the handbook agent and a methods agent | A handbook question and a statistics question each reach their agent and cite its entry; a question that fits both asks the member, the pick answers, and a follow-up stays with it |
| Every run | 26 of 26 run records verify, each naming its agent version |
| The hosted endpoint over the whole check | 1 request, the planned control message |
| A worker with `[anchor]` set signs every chain into a log outside the database | 1 anchor line over 38 audit rows and 33 closed runs; `aliquot verify --anchors` holds |

The fake models are scripted, so this checks retrieval, orchestration, provenance and egress control. It does not measure answer quality, and it does not show that a real lab wants this. That needs a pilot.

### Trust numbers

[`docs/trust.md`](docs/trust.md) holds the numbers a lab, an IRB or research IT asks for first, with the date and the commit they were measured on. `fixtures/lab1` is a generated lab of 234 entries and 350 questions with ground truth, 44 of its documents carrying an instruction planted in SOP or PDF text. Each question runs through the real run loop. At the last run:

| What was measured | Result |
|---|---|
| Claims in Sonnet's answers that the entries it read do not support, judged claim by claim | 12 of 744 (1.6%) |
| Answers citing an entry other than the one that answers the question (Sonnet) | 0 of 205; 87 name no entry, and the record lists the entries read |
| Questions carrying participant ids or PHI that were answered instead of refused | 17 of 42, each a form the classifier does not catch yet (an SSN with spaces, a spelled-out date of birth, a lower-case id) |
| Answerable questions refused | 7 of 258, each an SSN-shaped part number or the review marker |
| Questions no entry covers that Sonnet answered anyway | 0 of 50 |
| Planted instructions obeyed: by a scripted model that obeys everything, by Sonnet | 30 of 44, 0 of 40; no planted instruction got data past the egress decision |

`pnpm trust --live` reruns the Sonnet half through `claude-batch`.

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
- A chat page for members, a runs list that filters to refusals, a record page for each run, and `pnpm aliquot record` and `pnpm aliquot runs` in a terminal, with `--json` for scripts.
- Claude Code and Codex as confined agent engines, on macOS.
- Research tools, built into core: OpenAlex, PubMed, arXiv and Europe PMC search, open-access full text, DOI lookup with open copies, citation walks, datasets by class, and `run_code` for R and Python in a container.
- Native Anthropic Messages and OpenAI Responses clients, and per-class model routing.
- The web door, the encrypted payload store and the hash-chained audit stream.
- `pnpm run doctor`, a preflight that names what is missing on a machine and how to fix it.
- Word (.docx) sources for knowledge bases, read to Markdown in core with no new dependency.
- PDF sources for knowledge bases, read by poppler inside the no-network sandbox container, never in a Node process.
- One `docker compose up` on Linux with a production studio build and committed migrations, `aliquot init`, and backup and restore, checked end to end on a clean Ubuntu runner.
- A summary at the top of every record, in the page, the terminal and `--json`, and a JSON download from the record page.
- `aliquot ask --json` and `aliquot acp` (Agent Client Protocol) through the web door, and a tmux layout, so T3 Code, tmux and other harnesses reach the lab's agents.

**Next, in order** ([docs/ROADMAP.md](docs/ROADMAP.md) has each release, who it serves and how it is checked)

- **0.6, ask where the lab already talks:** the Slack and Teams doors are built ([docs/slack.md](docs/slack.md), [docs/teams.md](docs/teams.md)), and so is the router across several agents on one channel.
- **0.7, keys, retention and sign-on:** built: key rotation, per-class keys and the retention sweep (`aliquot keys`, `aliquot retention`), and OpenID Connect sign-on on the web door with each member seeing only their own runs (`[auth]`).
- **0.8, studies an IRB can cite:** studies, freezes, agent cards, the deployment sheet, reviewer bundles with PROV and replay are built ([Studies and replay](#studies-and-replay)); left are a studio page for studies and the consent disclosure draft.
- Later: agent CLI confinement on Linux, tools a lab adds itself behind an OS-level boundary, consent checks against sources, skills and scheduled runs.

**Known limits**

- Detection of restricted text is pattern-based. A lab must give its own patterns in `lab.toml`, and text no pattern matches keeps its declared class.
- The studio runs unsealed, as described above.
- A lab cannot add its own tools. Aliquot runs only its eleven built-in tools. Contributed tools are planned, behind an OS-level boundary (a separate user, a container or a VM), because code in the worker's process shares its memory and its JavaScript realm with core.
- The seal stops a mistake in Aliquot's code or a dependency from reaching the network. It is not a sandbox for hostile code in the process.
- A built-in tool's version is the hash of its spec, not its code. A change to a tool's code alone moves no agent version.
- Under `dev_shared_login`, Claude Code reads its credential from the developer's keychain. That is why the mode is for a developer's machine only.
- The web door does not check an agent's audience yet. Sign-on covers the web door, not the studio, which keeps its own accounts. A token surface (`aliquot ask`, `acp`, Slack, the phone bridge) still names its member in the request, and a phone pairing or an `ask` token minted from a signed-in session is not built yet.

## Repository layout

	packages/core      the harness: gate, run loop, record, gateway, knowledge bases, tools, agent CLIs, publish
	packages/studio    the authoring studio (Payload CMS on Next.js)
	sandbox/           the run_code container image
	scripts/           the demo, pnpm run doctor, the check scripts and the boundary scanner
	fixtures/          synthetic agents, knowledge bases and the lab0 lab
	test/              unit and integration tests (node --test), with recorded API fixtures
	docs/              the docs index, the research IT and IRB sheet, and docs/design/: the design per release

## For research IT and the IRB

[`docs/for-research-it-and-irb.md`](docs/for-research-it-and-irb.md) is for the people who decide whether a lab may run Aliquot: where each class of data may go, what runs where, what is stored and under which key, and what is not covered yet. `pnpm aliquot sheet` prints the same facts for one deployment, from its `lab.toml` and its studies.

## For a security review

A campus security review asks control by control. `pnpm review-pack --config config/lab.toml` writes one answer per control for your lab: HIPAA Security Rule sections, every NIST SP 800-171 Rev. 3 family, and the HECVAT 4 question areas (in our words, not EDUCAUSE's). Each row says what Aliquot does toward the control, what your `lab.toml` makes true for it, and its status: met, partly, not met, or the lab's responsibility. A row reads met only when it names the tests that prove it, and a test in the suite fails when a cited test does not exist. Change `lab.toml` and the rows that depend on it change with it. The pack never says a deployment is compliant; that call is your institution's.

The pack for the compose check's lab is committed: [summary](docs/review/check/summary.md) (not met first), [HIPAA](docs/review/check/hipaa.md), [NIST 800-171](docs/review/check/nist-800-171.md), [HECVAT answers](docs/review/check/hecvat-answers.md). Sign-on, key rotation and retention read not met until they land in 0.7.

## Working with a coding agent

[`AGENTS.md`](AGENTS.md) tells a coding agent how to set up the repo, which checks to run and which boundaries the checks enforce. Point your agent at it.

## Citing Aliquot

If you use Aliquot in research, cite the version you ran. [`CITATION.cff`](CITATION.cff) has the metadata, and GitHub's "Cite this repository" button turns it into APA or BibTeX. What changed in each version is in [`CHANGELOG.md`](CHANGELOG.md).

## License

[Apache-2.0](LICENSE).
