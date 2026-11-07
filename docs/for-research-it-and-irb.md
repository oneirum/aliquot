# Aliquot for research IT, the IRB and the data steward

This sheet is for the people who decide whether a lab may run Aliquot. It covers the following:

- where each class of data may go;
- what runs where;
- what is stored, and under which key;
- what is not covered yet.

Aliquot is self-hosted open source, so no vendor questionnaire exists. This sheet stands in for one. Every rule below
is enforced in code. The file that enforces each rule is named, so a reviewer can check it.

For a control-by-control answer (HIPAA Security Rule, NIST SP 800-171 Rev. 3, HECVAT 4 areas), run
`pnpm review-pack --config config/lab.toml`. It writes the review pack for your lab under `docs/review/<lab>/`, with
each row's status computed from your `lab.toml` and the tests that prove each met row. The pack for the compose check's
lab is in [`review/check/summary.md`](review/check/summary.md).

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

### Classes a lab declares

The five levels above are what every egress decision reads. On top of them a lab declares data classes in `lab.toml`
(`[classes.<id>]`, `packages/core/src/policy.ts`). Each class sits at one level, and `lab.toml` fails to load when a
class asks for less protection than its level enforces, so a class can only add rules. The five built-in classes are
always there and, with no `[classes]` table, behave exactly as Aliquot did before classes existed.

| Class | Level | Model tier | Record of a refused message | Detectors | Where it comes from |
|---|---|---|---|---|---|
| `public` | D0 | hosted | text | none (a channel's floor) | built in |
| `internal` | D1 | hosted | text | none (the default floor) | built in |
| `confidential` | D2 | hosted (approved placement) | text | phone, email | built in |
| `restricted` | D3 | local (lab or institution) | text | SSN, MRN, date of birth, the lab's participant ids | built in |
| `review-confidential` | R | none under `refuse`, local under `lab-only` | keyed hash | REVIEW-CONFIDENTIAL marker | built in |
| `phi` | D3 | none | keyed hash, 30 days | HIPAA Safe Harbor identifiers (45 CFR 164.514(b)(2)) | example in `fixtures/policy/classes.toml` |
| `controlled_access` | D3 | none | keyed hash, 365 days | DUA marker: `DUA:` lines, dbGaP `phs` accessions, EGA ids | example; NIH NOT-OD-25-081 |
| `export_controlled` | D3 | local, residency `us` | text | ITAR, EAR99, ECCN, USML markings | example |

What each tier means, and where it is enforced:

- **hosted**: the level's ceiling decides which placements may read it (the table above).
- **local**: the level is D3 or R, which the ceilings admit only at lab and institution placements. A run on a hosted
  model is refused at the gateway before the request, and its notice names the class.
- **none**: the door refuses the message before a run exists, so no model at any placement receives it. The refusal is
  an audit event (`gate.refused`) holding the class, the rule, the detectors, the retention, and the text, its keyed
  hash or nothing, as the class's `record` says. A knowledge base source in such a class is refused before its compile
  job exists (`kb.source-refused`), because the compiler is a model too.
- **residency**: a class with `residency = "us"` is read only by an endpoint whose `[endpoints.<id>]` says
  `region = "us"`. An endpoint with no region is in none. Checked at the door against the agent's model and at
  knowledge base compile against the compiler.

Safe Harbor identifiers covered by a pattern: names after a label (patient, name), street addresses and ZIP codes,
dates tied to an admission, discharge, death, service or birth, ages over 89, phone and fax numbers, email addresses,
SSNs, MRNs, health plan, account, certificate and licence numbers, VINs and licence plates, device serials, URLs (not
scholarly hosts such as doi.org or PubMed), IP addresses and labelled biometric ids. Full-face photographs are not
text and are not checked. "Any other unique identifying number" is the lab's own participant id patterns. Patterns
miss what they do not match: see "Not covered yet".

### Your campus's tiers

`preset = "uw-madison"`, `"umich"` or `"harvard"` in `lab.toml` maps that campus's tiers (UW-504's Public, Internal,
Sensitive and Restricted; Michigan's Low, Moderate, High and Restricted; Harvard's data security levels 1 to 5) onto the
classes above, and every refusal and the studio's class list then name the tier beside the class, for example
`Data class phi (UW-Madison Restricted)`. Each mapping line in `presets/<id>.toml` cites the campus page it rests on;
the README's "Your campus's tiers" tables list them. A preset is a starting point for the data steward, not the
campus's own interpretation: the lab's `[classes]` keys override it key by key, and a class the lab adds must name its
campus tier or `lab.toml` does not load.

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
| Studio (authoring) | lab server, holding no payload key | Postgres for its own tables, and the web door's `/studio` routes for everything in core; it never calls a model. The studio runs outside the seal, so this is not enforced in its process. |
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
| `studio` | the studio's reads and writes of core and its test threads, on the `/studio` routes only, with the surface's bearer token | `lab`, as `aliquot init` writes it | D3 |
| `slack` | `aliquot slack`, over Socket Mode to Slack and over HTTP to the door with the surface's bearer token ([slack.md](slack.md)) | `approved` at most; `lab.toml` refuses `lab` and `institution` because Slack keeps a copy of every answer and every question | D2 |
| `phone` (planned) | the phone bridge, with its own bearer token | set by the lab | that placement's |

A surface's token comes from an environment variable that `lab.toml` names, never from the file. The door keeps only
its hash. A request with an unknown bearer token, or `Bearer` with no token, is refused with a 401 and is never treated
as web. A request with no bearer token is the web surface. A surface reads and stops only its own runs, which keeps
each client on its own surface. While the web surface has no sign-in this is not access control, because anyone who
reaches the door can ask as web.

The studio's token is the one credential from which the door takes a member and a role, because the studio's accounts
hold the lab's roles until sign-on. The door makes every role and class check on the studio's requests, and never
sends the studio the text of a D3 knowledge base entry.

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
| Can we audit what an agent did? | Yes. Each run has a hash-chained record of every call, and each answer names the hash of the agent version that gave it. With `[anchor]` set, the worker also signs the head of the audit stream and of each closed run every few minutes, with a key the database never holds, into an append-only log; `aliquot verify --anchors` then shows whether anyone with database access rewrote a row after it was anchored, and names the seq. Keep the log, and the key, off the database host: see [Anchors](#anchors). |
| Can an agent be changed silently? | Mostly no. A change to an agent's instructions, model, knowledge bases, tools or limits changes its version hash, and a run pins the hash it ran. Two changes do not move the hash: the system prompt text the core adds around the instructions, and a built-in tool's code. Both ship only with a new Aliquot release. |
| Single sign-on? | Not yet. The web door has no member sign-in and listens on 127.0.0.1 only. A bearer token says which surface a request comes from, not which member sent it. |
| Key rotation and retention? | Not yet. |

## Anchors

The hash chains show a row that changed, unless whoever changed it also recomputed every later hash, which anyone
with write access to Postgres can do. Anchors move the proof out of the database.

1. `aliquot init --anchor-key /secure/aliquot/anchor.key` writes the key (mode 600) and an `[anchor]` table. It needs
   write access to that file too, and prints the exact `node --permission ...` command when it lacks it. An existing
   lab can instead add `[anchor]` from `lab.example.toml` and any Ed25519 PKCS#8 PEM key
   (`openssl genpkey -algorithm ed25519 -out anchor.key`). Set `LABH_ANCHOR_KEY_FILE` to the key's path for the
   worker, and start the worker with `--allow-fs-write=<the [anchor] path>`; without either it refuses to start.
2. The worker appends one signed line every `every_minutes` (default 15) and logs it as `anchor {...}`. `aliquot anchor`
   appends one by hand and prints it on stdout.
3. `aliquot verify --anchors` checks every line. Research IT can run it with only the public half of the key
   (`--public-key`), so the private key need never leave the worker's host.

Where to keep the log: somewhere the database administrator cannot rewrite. The best is write-once storage (an S3
bucket with Object Lock, a WORM volume) or the institution's SIEM, fed by forwarding each line from the worker's log
or from `aliquot anchor` on a timer. A copy on another host also works, because every line names the one before it,
so a line removed from any copy shows. Keep an offline copy of the key, and of its public half with the IRB file: an
anchor verifies only against the key that signed it. Aliquot makes no network call for any of this, and uses no
public timestamping service.

What anchors do not cover: a change made before the next anchor is written (at most `every_minutes`), a run that is
still open, and lines cut from the end of the only copy of the log, which leaves an older log that still verifies. That
last one is why the lines belong somewhere the database administrator cannot write as well. Redaction and retention delete payload bodies but keep their hashes, so anchored runs still verify
after either.

## Not covered yet

- **Detection is pattern-based.** Restricted text that no pattern matches keeps its declared class. A name without a
  label ("John Smith was admitted") is not found by `phi-name`; a lab with free-text PHI should set its PHI channels'
  floor to D3 rather than rely on detectors. Detector accuracy at scale is measured by the trust harness, not here. A lab must add its
  own participant id formats to `lab.toml`. `pnpm aliquot:init` asks for them and tests them against sample ids,
  and refuses a pattern that matches ordinary text or no sample id.
- **No sign-on.** Keep the web door on the machine until sign-on lands.
- **No key rotation, no per-class keys, no retention sweep.**
- **The version hash does not yet cover the system prompt text that the core builds around an agent's instructions.**
- **The studio runs outside the network seal and still holds the database password.** It holds no payload key, so it
  cannot read a stored payload. But it connects to Postgres as the same user as the worker, for its own tables, and
  the web door's reply table (`web_messages`) holds answers as text. A separate database user for the studio is planned.
- **A lab cannot add its own tools yet.** Contributed tools are planned, behind an operating-system boundary (a
  separate user, a container or a VM).
- **Hosted agent CLIs are confined on macOS only.** On other platforms an agent backend refuses to run.
- **IRB and consent checks against knowledge base sources are not built.**

Aliquot has been tested on a synthetic lab with synthetic data. It has not yet been used by a real lab.
