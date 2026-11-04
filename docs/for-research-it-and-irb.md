# Aliquot for research IT, the IRB and the data steward

This sheet is for the people who decide whether a lab may run Aliquot. It covers the following:

- where each class of data may go;
- what runs where;
- what is stored, and under which key;
- what is not covered yet.

Aliquot is self-hosted open source, so no vendor questionnaire exists. This sheet stands in for one. Every rule below
is enforced in code. The file that enforces each rule is named, so a reviewer can check it.

## Data classes

Every piece of content carries one of five classes. A class only goes up: the class of anything derived from content
is at least the class of that content, and there is no declassify step.

| Class | Meaning | Example |
|---|---|---|
| D0 | Public | A published paper's abstract |
| D1 | Internal | Lab SOPs, agent instructions (default) |
| D2 | Confidential | Contact details, unpublished results |
| D3 | Restricted | Participant identifiers, MRNs, dates of birth |
| R | Review-confidential | Text marked REVIEW-CONFIDENTIAL |

A message gets its class at the gate (`packages/core/src/gate.ts`), which runs before any model sees the message. The
gate checks built-in patterns and the lab's own participant id patterns from `lab.toml`. A knowledge base's class is
declared by its steward. The compile step raises that class when its source text matches a pattern.

## Where each class may go

Each destination has a placement, which the lab declares in `lab.toml`. The table of ceilings is code, not
configuration (`CEILINGS` in `packages/core/src/dataclass.ts`). A config file therefore has no field in which to say
"hosted, D3".

| Destination | lab hardware | institution service | approved vendor | zero-retention vendor | anything else |
|---|---|---|---|---|---|
| Model | up to D3 | up to D3 | up to D2 | up to D1 | D0 only |
| HTTP host (tools) | up to D3 | up to D2 | up to D2 | up to D1 | D0 only |
| Chat surface | up to D3 | up to D2 | up to D2 | up to D1 | D0 only |
| Payload store | up to D3 | up to D2 | nothing | nothing | nothing |

R is refused everywhere by default. With `review_confidential = "lab-only"` it may go to lab-placed models, the store
and chat. A host not listed in `lab.toml` counts as "anything else".

One function, `decideEgress`, makes every one of these decisions. A test fails when any file outside the allowed set
calls it. A static scanner (`scripts/boundaries.ts`) fails on any file in Aliquot's source, outside the few allowed to, that
loads a network module or uses the global `fetch`, and a runtime seal (`packages/core/src/seal.ts`) makes those routes fail when they
run. The seal catches a mistake in Aliquot's code or in a dependency. It is not a sandbox for hostile code, and Aliquot
runs no tool code from outside Aliquot: every tool is built in. The one exception is for the test harnesses: under
`LABH_FAULTS=1`, and never under `NODE_ENV=production`, the worker binaries accept `--plant-tool`, which loads a test
tool that may stand in for a built-in under its name and version.

## What runs where

| Component | Where it runs | Network |
|---|---|---|
| Worker (runs agents) | lab server, under Node's permission model | Postgres, the model endpoints in `lab.toml`, and each built-in tool's declared host |
| Web door | lab server, bound to 127.0.0.1 | none outward |
| Studio (authoring) | lab server | Postgres only; it never calls a model. This is not enforced: the studio runs outside the seal. |
| Postgres | lab server (Docker in the quickstart) | local |
| Local model (optional) | lab hardware, for example Ollama | local |
| Agent worker (optional) | lab server; runs Claude Code or Codex in a macOS sandbox | the vendor's API hosts only, through a host-pinned proxy |
| Code sandbox (optional) | a Docker container per call | none: `--network none` |

### Surfaces

Each way into the web door is a surface, `[surfaces.<id>]` in `lab.toml`. The door holds each surface to the chat
ceiling of its placement. An answer above it is posted as the record link only, and the run record names the surface.

| Surface | What reaches the door | Placement | Ceiling |
|---|---|---|---|
| `web` | the chat page, and `aliquot ask` or `aliquot acp` with no token; no sign-in until the sign-on release | `lab` by default | D3 |
| `acp` | `aliquot acp` for T3 Code and other ACP clients, and `aliquot ask`, with the surface's bearer token | `zdr`, as `aliquot init` writes it | D1 |
| `slack` (planned) | Slack, through its own adapter, never the web door | `approved` at most; `lab.toml` refuses `lab` and `institution` because Slack keeps a copy of every answer | D2 |
| `phone` (planned) | the phone bridge, with its own bearer token | set by the lab | that placement's |

A surface's token comes from an environment variable that `lab.toml` names, never from the file. The door keeps only
its hash. A request with an unknown bearer token, or `Bearer` with no token, is refused with a 401 and is never treated
as web. A request with no bearer token is the web surface. A surface reads and stops only its own runs, which keeps
each client on its own surface. While the web surface has no sign-in this is not access control, because anyone who
reaches the door can ask as web.

### Hosted agent CLIs

A lab may run Claude Code or Codex as a research agent. Aliquot treats the whole CLI as one hosted model:

- Its placement must be approved, zero-retention or public. The config parser refuses lab or institution, so the
  most it can ever receive is D2.
- Its own tools (shell, file access, web) are switched off. It works only through the agent's Aliquot tools, and each
  tool result passes the egress decision before the CLI sees it. A result above the ceiling is withheld, and the
  refusal is recorded.
- It runs in an operating-system sandbox. It cannot read the lab's files or the repository. It cannot write outside an
  empty per-run folder. It cannot connect anywhere except the Aliquot bridge and a proxy that only reaches the vendor's
  API hosts.
- Publishing a hosted agent with a D3 knowledge base or a D3 dataset is an error, not a warning.
- `dev_shared_login` lets a developer try a CLI on their own logged-in account. It is a `public` placement, so the
  agent sees D0 only, and the agent worker refuses it unless started with `--dev-shared-login`. Under it, Claude Code
  reads its credential from the developer's keychain. It is not a deployment path. A lab uses a key it owns
  (`api_key_env`).

### Model accounts

Every model Aliquot calls is reached with a credential the lab or institution holds, named in `lab.toml` with a
placement. The placement alone sets the most sensitive data that may reach it. No personal or seat subscription is
used by the server: the config parser accepts a subscription's OAuth token (`auth_env`) only at a `public` placement,
and the agent worker refuses it unless started with `--dev-shared-login`. When a lab runs Claude Code or Codex, the
task prompt and every tool result pass Aliquot's gateway like any other call, and the CLI reaches only its vendor's
API hosts, with the lab's key. Routing each of the CLI's own model calls through the gateway, so that each one is
recorded, is planned. A member's own AI tool connected to Aliquot (`aliquot ask` or `aliquot acp`) gets answers only
up to the web door's placement, or a stricter `--ceiling`, and the rest is withheld behind a record link. D0 is the
ceiling for a personal subscription. What a member types into their own tool before it reaches Aliquot is under that
tool's terms, not Aliquot's. The lab's data-handling rules have to cover it. Aliquot cannot prevent a member from
copying text by hand from a page they are allowed to read.

### Tools

Aliquot runs eleven built-in tools, all part of its own code: knowledge base search and read, seven literature tools
(search in OpenAlex, PubMed, arXiv and Europe PMC; open-access full text from Europe PMC; DOI lookup through Crossref
and Unpaywall; citation walks through OpenAlex), a list of the lab's datasets, and `run_code`. A lab cannot add its
own tool. Every Aliquot binary refuses to start when `lab.toml` has a `[tools]` table, and the studio fails every request
that needs core with the same message. A built-in tool's version is the hash of its spec, not its code, so a change
to a tool's code alone moves no agent version.

- A literature search may reach only its own host. Those hosts are public (the "anything else" column) unless
  `lab.toml` says otherwise. While they are public, a search is refused when the conversation holds anything above D0. A redirect is followed only to a host the tool declares, and only
  when the egress decision allows it for that hop.
- `run_code` runs R or Python in a Docker container with no network, a read-only root filesystem, no Linux
  capabilities, CPU, memory and process limits, and a time limit, as an unprivileged user. Datasets are mounted
  read-only, and the output carries the class of every dataset mounted. A test checks each of these against the real
  container.
- The model gateway never follows a redirect, so a prompt and an API key go only to the endpoint in `lab.toml`.

## What is stored, and how

- **Payload store** (Postgres table `payloads`). Every prompt, answer, tool input and tool output is stored here. The
  cipher is AES-256-GCM. Each row is addressed by an HMAC-SHA256 of its class and content. Both the cipher key and the
  address key are derived by HKDF from one 32-byte master key, which the worker reads from an environment variable and
  never writes down (`packages/core/src/record.ts`). The store refuses content above its placement's ceiling.
- **Run record** (`run_events`). One append-only, hash-chained log per run. It holds every model call, tool call,
  refusal, stop and the final answer, with class labels and payload references, not plaintext.
- **Audit stream** (`audit_events`). One hash-chained log for publishes, role changes and calls made outside a run.
- **Studio tables.** Agent and knowledge base definitions, in plaintext. No detector runs when a definition is saved.

## Who can do what

The five roles are member, author, publisher, data steward and PI (`packages/core/src/roles.ts`). Members ask
questions. Authors write drafts. Publishers publish. Anything at D3 needs the data steward or the PI to publish it.

## Answers to the usual security review questions

| Question | Answer |
|---|---|
| Does participant data leave our hardware? | Not unless the lab declares a destination as lab or institution placement. A D3 item is refused for every other destination, and the refusal is recorded. |
| Which third parties receive data? | Only the endpoints and hosts listed in `lab.toml`, each at most at its ceiling. The quickstart lists none. |
| Is data encrypted at rest? | Payloads are encrypted with AES-256-GCM under a key held outside the database. Run records hold references, not text. |
| Can we audit what an agent did? | Yes. Each run has a hash-chained record of every call, and each answer names the hash of the agent version that gave it. |
| Can an agent be changed silently? | Mostly no. A change to an agent's instructions, model, knowledge bases, tools or limits changes its version hash, and a run pins the hash it ran. Two changes do not move the hash: the system prompt text the core adds around the instructions, and a built-in tool's code. Both ship only with a new Aliquot release. |
| Single sign-on? | Not yet. The web door has no member sign-in and listens on 127.0.0.1 only. A bearer token says which surface a request comes from, not which member sent it. |
| Key rotation and retention? | Not yet. |

## Not covered yet

- **Detection is pattern-based.** Restricted text that no pattern matches keeps its declared class. A lab must add its
  own participant id formats to `lab.toml`. `pnpm aliquot:init` asks for them and tests them against sample ids,
  and refuses a pattern that matches ordinary text or no sample id.
- **No sign-on.** Keep the web door on the machine until sign-on lands.
- **No key rotation, no per-class keys, no retention sweep.**
- **The version hash does not yet cover the system prompt text that the core builds around an agent's instructions.**
- **The studio runs outside the network seal and holds the payload key.** It never calls a model.
- **A lab cannot add its own tools yet.** Contributed tools are planned, behind an operating-system boundary (a
  separate user, a container or a VM).
- **Hosted agent CLIs are confined on macOS only.** On other platforms an agent backend refuses to run.
- **IRB and consent checks against knowledge base sources are not built.**

Aliquot has been tested on a synthetic lab with synthetic data. It has not yet been used by a real lab.
