# Aliquot v0.2 design: agent backends, research tools, native providers

Status: built in v0.2. Read `DESIGN.md` first; this file only describes what v0.2 adds and which existing rule each addition
leans on.

## What a lab gets

1. A lab can run Claude Code or Codex as a research agent. The agent works for many steps on one task, under the same
   rules as a chat agent. Every piece of content it sees passes the egress decision, every tool call is in the run
   record, and its version hash pins the CLI version and the model. A D3 or R knowledge base never reaches it.
2. Agents can search the literature (OpenAlex, PubMed, arXiv), list the lab's datasets by class, and run R or Python in
   a container that has no network.
3. The gateway speaks Anthropic Messages and OpenAI Responses as well as OpenAI-compatible chat. An agent can name one
   model per class band, so a public question goes to a hosted model and a D3 question goes to the lab's own model.

## The one rule everything below follows

An agent CLI is a hosted model with its own loop. Aliquot treats the whole CLI process as one `model` destination with
the placement the lab declared for it. That gives four consequences:

- **Everything the CLI learns is an egress.** The task prompt, and every tool result returned to it, pass
  `decideEgress(content, {kind: "model", endpointId: backend, placement})` before the CLI sees them. A refused result is
  replaced by a refusal message and recorded as `egress.refused`.
- **The CLI has no tools of its own.** Its built-in tools (shell, file edit, web fetch, web search, plugins, hooks,
  skills, MCP servers from user config) are switched off by flags that are code, not configuration. Its only tools are
  the agent's pinned Aliquot tools, served by a bridge that the run owns.
- **The CLI process cannot reach around the bridge.** It runs in an OS sandbox that denies reads of the user's files
  and the repository, denies writes outside its workspace, and denies all network except two loopback ports: the bridge
  and an egress proxy that only opens tunnels to the vendor's API hosts.
- **Hosted means hosted.** An agent backend's placement can only be `approved`, `zdr` or `public`. The config parser
  refuses `lab` and `institution`, so the model ceiling for any agent backend is at most D2, and R is always refused
  (R needs a lab placement). This is code: `CEILINGS` is unchanged, and the parser has no way to say "a hosted CLI on
  lab hardware".

So the class of anything the CLI could send anywhere is at most the class of what Aliquot already allowed to the
vendor.

## Data shapes

### lab.toml

```toml
[agent_backends.claude]
kind = "claude-code"            # or "codex"
placement = "approved"          # approved | zdr | public; lab and institution are refused
binary = "/usr/local/bin/claude" # optional; default is the first match on PATH at boot

[datasets.cohort-2024]
path = "/srv/lab/data/cohort-2024"  # a directory, mounted read-only into the sandbox
class = "D2"
description = "Synthetic cohort, one row per visit"

[sandbox]
image = "aliquot-sandbox@sha256:..." # pinned by digest; the worker refuses a tag
cpus = 1
memory_mb = 1024
timeout_ms = 60000

[research]
contact_email_env = "LABH_CONTACT_EMAIL" # sent as mailto/email to OpenAlex and NCBI polite pools; optional

[endpoints.anthropic]
base_url = "https://api.anthropic.com"
placement = "approved"
protocol = "anthropic-messages"   # openai-chat (default) | anthropic-messages | openai-responses
api_key_env = "ANTHROPIC_API_KEY"
# sampling = true                 # send temperature and top_p; see "Native providers"
```

Endpoint ids and agent backend ids share one namespace; the parser refuses a duplicate.

### Code tables (not config)

```ts
// agents/backends.ts
type AgentCliKind = "claude-code" | "codex";
type HostedPlacement = Extract<Placement, "approved" | "zdr" | "public">;

interface AgentBackend {
  readonly id: string;
  readonly kind: AgentCliKind;
  readonly placement: HostedPlacement;
  readonly binary: string; // absolute, resolved at boot
}

/** Per kind: the argv that switches off built-in tools, the vendor hosts the proxy may tunnel to, the output parser. */
const KINDS: Record<AgentCliKind, KindSpec>;
```

`KindSpec.vendorHosts` is fixed in code (`api.anthropic.com` plus the OAuth refresh host for Claude Code; the
ChatGPT and OpenAI API and auth hosts for Codex). The live smoke test finalizes the list and records every host each
CLI asked for.

### ResolvedAgent

The hash of every existing version must not change, because frozen studies pin it. `canonicalJson` omits absent keys,
so v0.2 adds two optional fields to schema 2 and sets them only when used:

```ts
interface ResolvedAgent {
  // ...existing fields, unchanged...
  readonly model: ModelTarget;
  /** Present iff model.endpointId names an agent backend. */
  readonly agentCli?: { readonly kind: AgentCliKind; readonly cliVersion: string; readonly maxTurns: number };
  /** Optional per-class model bands for the chat loop, lowest band first. Absent: model serves every class. */
  readonly modelsByClass?: readonly { readonly upTo: DataClass; readonly target: ModelTarget }[];
}
```

Rules that `resolveAgent` enforces (publish errors) and the worker checks again at load (`AgentUnavailable`):

- `agentCli` is present exactly when `model.endpointId` is an agent backend; `agentCli.kind` equals the backend's kind.
- An agent CLI agent has no `external-send` tool. The confirm-in-thread flow cannot pause a CLI mid-session.
- An agent CLI agent may not attach a knowledge base, or allow a sandbox mount, whose class is above the backend's
  model ceiling. A D3 knowledge base on a hosted agent is a publish error, not a runtime refusal. Runtime refusals
  still apply to anything that only becomes known during the run (a D3 pattern in a message, a D3 sandbox output).
- `modelsByClass` and `agentCli` are mutually exclusive. Bands are sorted by `upTo`, and each band's endpoint ceiling
  admits its `upTo`.

`verifyRunnable` adds one problem kind, `agent-cli-version`. It applies when the installed CLI's `--version` differs
from `agentCli.cliVersion`, in the same way that the gateway refuses a model id that the provider does not serve
exactly.

The alternative is a `schema: 3` with an `engine` union. That would change every reader of `agent.model` and every
stored hash, for no behavior gain. I rejected it.

### Run record

A session reuses the existing events, so the console, `fold()`, and replay of recorded tools keep working:

- `model.requested` once, at the start of the session, with the task prompt as its payload.
- `tool.requested` / `tool.completed` / `tool.failed` for every bridged call, written by the existing `ToolRunner`.
  The callIds are `s{attempt}-{n}`.
- `egress.refused` for a withheld tool result (`destination: model:<backend>`) and for every proxy tunnel the proxy
  refused (`destination: http:<host>`).
- `model.completed` once, at the end, with the final text as output, the provider model id reported by the CLI,
  token usage when the CLI reports it, and the duration.
- One new event, `agent.session`: `{ attempt, kind, cliVersion, argvHash, workspace, exit, turns, hostsTunneled }`. It
  is written once when the CLI exits. `argvHash` is the sha256 of the exact argv and environment names (not values)
  passed, so a reviewer can rebuild the confinement from the version.

`run.finished` is unchanged. The answer is the final text, labelled with the session class (see below), and it is
posted to the surface through the existing chat egress decision.

## Execution

### Process

The existing worker runs under `--permission` with child processes denied, and it stays that way. v0.2 adds a second
binary, `bin/agent-worker.ts`. It claims only jobs of kind `agent-run`, and the front door enqueues `agent-run` instead
of `run` when the resolved agent has `agentCli`. The agent worker starts under:

    node --permission --allow-fs-read=* --allow-fs-write=<workspaces root> --allow-net --allow-child-process

It checks those exact flags with a variant of `requireProcessPermission`. The seal adds three files to its allowance:

- `agents/spawn.ts` for `child_process`, the only spawn in core;
- `agents/bridge.ts` for `node:http`, the loopback MCP server;
- `agents/proxy.ts` for `node:net`, the CONNECT proxy.

`scripts/boundaries.ts` lists them as well. The agent worker holds the payload key and the database URL, as the worker
does. It passes neither to the child: the child environment is an allowlist.

### Session driver

`drive()` dispatches on `agent.agentCli` to `driveAgentSession(job, journal, deps)`. This is a straight-line executor,
not `next()`. The CLI owns its loop, so there is no per-step decision for the loop contract to pin, and the loop
contract version stays `loop-v2`.

1. Fold the journal. If it already holds `run.finished`, the job is done.
2. If an earlier attempt started and never wrote `agent.session`, the worker died mid-session. A CLI session cannot be
   resumed, because persistence is off. Start a fresh attempt, up to `RETRY.maxAttempts`. The earlier attempt's tool
   calls stay in the record. Bridged tools are read or lab-write only, so repeating them is safe.
3. Build the task prompt the same way the chat loop builds its first prompt: the instructions labelled at
   `instructionsClass`, then the thread messages. `Prompt.of` gives its class. Then call
   `decideEgress(prompt, {kind:"model", endpointId: backend.id, placement})`. A refusal finishes the run as `refused`
   with a notice, and no process starts.
4. `sessionClass = prompt.cls`. Record `model.requested`.
5. Start the bridge and the proxy on `127.0.0.1:0`. Create the workspace `<root>/<runId>/s<attempt>` with mode 0700.
6. Spawn the CLI through `confine(kind, argv, env, workspace, ports)` and write the prompt on its stdin.
7. Bridge `tools/call` handling:
   - Count a step. Above `limits.maxSteps`, return an error that tells the agent to finish now.
   - Store the arguments as a payload labelled at `sessionClass`. The arguments came from a model that had seen
     everything in the session.
   - Call `ToolRunner.invoke`, the same path the chat loop uses.
   - Read the output back from the journal. Then call `decideEgress(output, modelDest)`.
   - If the egress decision allows it, set `sessionClass = join(sessionClass, output.cls)` and return the output as text.
   - If it refuses, record `egress.refused` and return `isError: true` with the text
     `withheld: <describeRefusal>`.
8. Stop, wall limit and lease loss: SIGTERM the CLI's process group, then SIGKILL it after 5 s. The run finishes
   `stopped` or `failed` as the chat loop does.
9. On exit, parse the CLI's output (the KindSpec parser) and record `agent.session`, then `model.completed`. The answer
   is `Labelled.derive(text, [prompt, ...returned outputs], "agent:output", sessionClass)`. Remove the workspace.

Two self-checks make the run fail closed, as `agent-not-confined`:

- **Claude Code.** Its stream-json `system/init` line lists the tools it actually loaded, its model, and its version.
  The driver kills the session before it answers unless every tool is `mcp__aliquot__*`, the model equals
  `model.modelId`, and the version equals `cliVersion`.
- **Codex.** It prints no tool list and does not echo the model it served (probe, codex-cli 0.155.1). The record
  stores the requested id with `providerModelId` set to `unreported`, and the agent card says so. The driver fails the session if any JSONL item is a `command_execution`,
  `file_change`, `web_search` or other non-MCP tool item.

### Bridge

The bridge implements the MCP streamable HTTP transport in the subset both CLIs use: `POST /mcp` with JSON-RPC 2.0
`initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. It answers with
`application/json`, never SSE. `GET` returns 405. It needs no SDK and is about 150 lines. Each run has its own
32-byte bearer token. A request without the token gets 401, and a request on another path gets 404. `tools/list`
returns `ToolRunner.specs(agent.tools)`, so the agent sees exactly its pinned tools.

### Proxy

The proxy is an HTTP CONNECT proxy on loopback. It opens a tunnel only to `KindSpec.vendorHosts` on port 443, refuses
every other request with 403, and records each refusal. The CLI reaches it through `HTTPS_PROXY`. The sandbox
guarantees the CLI cannot reach anything else, so the host allowlist is enforced by the OS and not by the CLI's good
behavior.

### Confinement

The macOS implementation runs `/usr/bin/sandbox-exec -p <profile>`, with the profile generated per session:

- `(deny default)`, then allow reads of the workspace, the CLI's install directory and the system paths the CLI needs.
  The CLI's config and state live in the workspace, so the operator's own `~/.claude` and `CODEX_HOME` are not read.
  Under `dev_shared_login` only, the keychain directory, `/usr/bin/security` and the two keychain services are added.
  Writes are denied everywhere except the workspace and `/dev/null`.
- `(deny network*)`, then allow `network-outbound` to `localhost:<bridge>` and `localhost:<proxy>` only. DNS is not
  needed, because the proxy resolves names.
- The repository, the lab's dataset paths, `lab.toml`, and the Postgres socket and port are outside every allow rule.

Other platforms have no implementation yet, so an agent backend is unrunnable there with `agent-confinement-missing`.
Linux confinement through bubblewrap is on the roadmap. Running unconfined is never a fallback.

### The child's environment

The allowlist is `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR=<workspace>/tmp`, `HTTPS_PROXY`, `HTTP_PROXY`,
`NO_PROXY=127.0.0.1,localhost`, `ALIQUOT_BRIDGE_TOKEN`, and per kind `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
`DISABLE_AUTOUPDATER=1`, plus the CLI's own config-dir variable when the worker has it set (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`). `PATH` is rebuilt as `/usr/bin:/bin` plus the directory of the node binary when the CLI is a node script
(Codex is). Nothing else passes. In particular `DATABASE_URL`, the payload key and every `*_API_KEY` stay
behind. The CLI authenticates with the lab's own subscription login, which lives in its state directory.

### argv, per kind (code)

- **claude-code:** `-p --output-format stream-json --verbose --model <id> --tools "" --strict-mcp-config
  --mcp-config <json naming only the bridge> --setting-sources "" --disable-slash-commands
  --no-session-persistence --allowedTools mcp__aliquot --system-prompt <short Aliquot system text>`, with the prompt
  on stdin. `--bare` is not used, because it accepts only API-key auth.
- **codex:** `exec --json --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -C <workspace>
  -m <id> -s read-only --disable shell_tool --disable unified_exec --disable apps --disable plugins --disable hooks
  --disable browser_use --disable computer_use --disable image_generation --disable in_app_browser
  -c web_search="disabled" -c mcp_servers.aliquot.url=... -c mcp_servers.aliquot.bearer_token_env_var=ALIQUOT_BRIDGE_TOKEN -`.

The flag names are pinned to the CLI versions that the smoke test ran. A different version is unrunnable until an
agent is published against it, which is the `agent-cli-version` check above.

## Research tools

v0.2 runs seven built-in tools, all in core: `kb_search`, `kb_read`, `dataset_list`, `run_code` and the three
literature tools below, each a `defineTool` in `packages/core/src/tools.ts` with `owner: "core"`. Each tool's version
is the hash of its spec (`toolSpecHash`), not of its code, so a change to a tool's code alone moves no agent version.
A lab cannot add its own tool in v0.2. Every binary refuses a `lab.toml` with a `[tools]` table at startup, with one
message that says contributed tool folders are not supported in v0.2 and are planned for v0.3. The studio starts, and
fails every request that needs core with the same message. The test harnesses' `--plant-tool` is the one exception:
the worker binaries accept it only under `LABH_FAULTS=1` and never under `NODE_ENV=production`, and a planted tool may
stand in for a built-in under its name and version. Running a lab's own tool code needs an OS-level boundary (a separate user, a container or a VM),
and that is v0.3 work.

| Tool | Reads | Egress | Notes |
|---|---|---|---|
| `openalex_search` | D0 | api.openalex.org | adds `mailto` when a contact email is set |
| `pubmed_search` | D0 | eutils.ncbi.nlm.nih.gov | esearch then esummary; `email` and `tool` params; an eutils `ERROR` answer fails as final input |
| `arxiv_search` | D0 | export.arxiv.org | Atom feed parsed by `packages/core/src/atom.ts` |
| `dataset_list` (built-in) | join of listed datasets | none | ids, classes, descriptions and file names of the datasets this agent may mount; names and descriptions are dataset content, so the output carries each listed dataset's class |
| `run_code` (built-in) | join of mounts | none | R or Python in a container, see below |

The literature hosts are `public`, so `ctx.fetch` refuses a query from any conversation above D0. This is the
existing rule, and it is correct: the query text is as sensitive as the conversation that wrote it. A literature agent
therefore sets `instructionsClass` to D0, and the quickstart says so.

`ToolContext` gains `contact: string | null`, read from the env var that `[research]` names. It is lab config, not run
content.

`ctx.fetch` follows a redirect itself, at most 5 hops. Before each hop is sent, the hop's host must be in the tool's
`egress` list and `decideEgress` must allow it, at the class of everything the call has read. A refused hop is
journaled as `egress.refused` and fails the call. A followed hop is journaled as `egress.redirected`, which names the
hosts, not the ports. `ctx.retrieved` takes only a snapshot attached to the agent.

### run_code

`sandbox.ts` talks to the Docker Engine API over its unix socket with `node:http` and `socketPath`. That adds one file
to the seal allowance, and no client library. Each call creates one container with these settings:

- the image pinned by digest;
- `NetworkMode: none`, `ReadonlyRootfs`, `CapDrop: ALL`, `no-new-privileges`, and user 65534;
- CPU, memory and pids caps;
- a tmpfs `/work`, and `/out` as the only writable paths (`IpcMode: none`, so Docker mounts no `/dev/shm`).

The requested datasets are bind-mounted read-only at `/data/<id>`. A dataset must be in `agent.sandbox.mounts`, and
its class must be at most `mountCeiling`. A call that asks for anything else fails with `invalid-input`. The tool
returns the exit code, stdout and stderr (each truncated to 32 KB), and the text files under `/out` up to 256 KB in
total, read through the archive endpoint. The timeout kills the container, and the container is removed in a
`finally` block.

The output class is `join(inputClass, ...mounted dataset classes)`. So a hosted agent that runs code over a D3
dataset gets a withheld result at the bridge, and the computation never reaches the vendor. A hosted agent cannot even
name a D3 dataset in its sandbox mounts, because that is a publish error. An agent whose mount ceiling is D3 must name
its `irbProtocol`, the rule a D3 knowledge base already has, because the ceiling admits any dataset later raised to D3.

The image is `sandbox/Dockerfile`: Debian slim, R with base and recommended packages, and Python 3 with numpy, pandas,
scipy and statsmodels. The lab builds it once with `docker build` and pins the digest in `lab.toml`.
`Deployed.sandboxImages` becomes the configured digest when the daemon has that image.

## Native providers

`ModelEndpoint` gains `protocol`. `sendChat` becomes `send` and dispatches on it:

- **anthropic-messages:** `POST {base}/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`.
  - System parts are joined into `system`.
  - Tool calls map to `tool_use` blocks, and tool results to `tool_result` blocks in a user turn.
  - `stop_reason` maps to `finish` as follows: `tool_use` to `tool_calls`, `max_tokens` and
    `model_context_window_exceeded` to `length`, `end_turn`, `stop_sequence` and `pause_turn` to `stop`. `refusal`
    fails the call (see "How a turn ends").
  - `serves()` reads `GET /v1/models`.
- **openai-responses:** `POST {base}/responses`.
  - The request sends `store: false` always.
  - System parts go to `instructions`. Tool calls map to `function_call` items, and tool results to
    `function_call_output` items.
  - An `incomplete` status with reason `max_output_tokens` maps to `length`. A message with a `refusal` content part,
    or `incomplete` with reason `content_filter`, fails the call.
  - `serves()` reads `GET /models`.

**How a turn ends.** A refusal or a content filter is not an answer: Claude's `refusal` stop, a Responses `refusal`
content part, Responses `content_filter`, and on `openai-chat` a `message.refusal` or `finish_reason:
"content_filter"`. Tool calls cut off by the output cap may carry truncated input, on every protocol. Each of these
writes `model.failed`, not retryable, with the provider's reason as the detail payload at the prompt's class. The run
then ends `failed` with the failure notice, and the partial text is never posted. The record has no refusal code yet,
so the code is `unparseable` (the answer is not one the run can use); `refused` stays the outcome for egress refusals.

**Replay.** A model turn that calls tools is stored whole as opaque provider state, at the prompt's class: the
Anthropic `content` array, or the Responses `output` array. The next request sends it back byte for byte, in its
original order, with nothing merged, moved or dropped, and only to the endpoint and model that wrote it. Claude binds
thinking blocks to the turn and refuses an edited one, and the Responses guide replays every output item untouched,
`phase` included. Any other target gets the turn rebuilt from its text and calls, without thinking or reasoning. The
shared rule is `stateFor` in `gateway-wire.ts`, and both adapters go through it.

**Sampling.** An endpoint's `sampling` says whether `temperature` and `top_p` are sent. On `openai-chat` they are
sent unless it sets `sampling = false`. On the two native protocols they are sent only with `sampling = true`. The
`claude-api` model table lists sampling as removed (a 400) on Claude Opus 4.7 and later, Sonnet 5 and Sonnet 5.5, and
Fable, and OpenAI's reasoning models refuse it too, so a current model works with the default config. An older model
that takes sampling, such as Claude Sonnet 4.6, opts in. Anthropic then gets at most one of the two: an explicit `topP`
alone, otherwise `temperature`.

Both adapters are pure functions in `gateway-wire.ts`: prompt to body, and body to `Completion`. The adapter file
imports no network module. `gateway.ts` stays the only place that sends and the only place that reads a key. The
exact-model-id rule applies unchanged. The tests run against fake HTTP servers that serve fixture bodies written from
each provider's published API reference. No live call was made, because spend is $0.

**Redirects.** No provider request follows a redirect. Node's fetch replays the POST body and `x-api-key` across a
307 to another origin, so a redirect would send the prompt, cleared only for the endpoint's placement, and the key to
whatever host it names. The completion and the model list are fetched with `redirect: "manual"`. A 3xx completion
writes `model.failed` with code `http`, not retryable, and the detail says the gateway does not follow redirects. A
3xx model list means the endpoint does not serve the model.

**Per-class routing.** When `modelsByClass` is set, `buildPrompt` computes the prompt class and the loop sends to the
first band whose `upTo` is at least that class. `model` is the top band: it serves every class above the last band.
Publish refuses a band whose `upTo` reaches the agent's ceiling, so the bands stop below it, and the existing ceiling
rule on `model` already makes its endpoint admit the ceiling. The top band therefore always covers the ceiling, and
`model` is never dead config. A prompt above what `model`'s endpoint may receive is refused by the gateway's egress
check before any network call, as for an agent without bands. Run start checks that every band's target and `model`
are served. Each band's target is in the hash. The router profile already picks by placement, and it is unchanged.

## What is tested and how

- Unit tests for the bridge (JSON-RPC, token, withheld results), the proxy (allowed host tunnels, other host 403), the
  argv builders (pinned flags), the output parsers (fixture lines from each CLI), and the new config rules.
- A fake CLI, `test/fake-agent-cli.ts`, is a node script that speaks the bridge and prints Claude-style or Codex-style
  output. It runs the full agent-run path against Postgres: a D0 task with a literature tool on a fake host, a D3
  dataset whose output is withheld, a stop, and a crash mid-session followed by a new attempt.
- A confinement test (macOS) runs the fake CLI under the generated profile and asserts each of these is denied: reading
  a file in the repo, reading `~/`, connecting to the Postgres port, and connecting directly to an outside host. It
  also asserts that the bridge and the proxy work.
- Native providers are tested against fake servers: tool round trip, length, model mismatch, a 429 that is retryable,
  and per-class band choice. Byte-exact replay of a tool turn: Claude interleaved thinking with two parallel calls,
  and Responses reasoning, a `phase` message and two calls. Refusals, content filters and truncated calls on every
  protocol. A class that rises mid-run moves the next call to `model` on the lab endpoint with nothing restricted
  reaching the hosted band.
- `run_code` runs against the real Docker daemon: an R and a Python computation, no network inside (a connect attempt
  fails), a read-only mount, a read-only root filesystem and user 65534, no `/dev/shm`, an empty capability bounding
  set with `NoNewPrivs`, the CPU, memory and pids limits read from the container's cgroup, a timeout kill, and the
  output class. A fake daemon tests an early stop and a stalled daemon without Docker.
- Each built-in literature tool runs through the tool runner against a fake API that serves its recorded responses.
- Every binary refuses a `lab.toml` with a `[tools]` table, and the studio's core boot fails, with the one message.
- The live smoke was planned as one synthetic task per CLI through `agent-worker`, with `kb_search`, `kb_read` and
  `run_code` on a synthetic D1 dataset, plus one run whose dataset is D3 and must be withheld. What ran is in the
  README's "What ran live": every live run was at D0, because a personal login is a `public` placement. The withheld D3
  dataset is covered by the fake-CLI test above.
- `pnpm typecheck`, `pnpm test`, `slice1 --skip-ollama`, `unit3 --skip-ollama`, `lab0` and `unit2` stay green.

## Not in v0.2

- Contributed tools. v0.2 runs only its seven built-in tools; a lab's own tool code needs an OS-level boundary.
- Linux confinement for agent backends.
- Resuming a CLI session after a worker crash. The session restarts instead.
- `external-send` tools on agent CLI agents.
- A Claude Agent SDK dependency. v0.2 drives the installed `claude` binary in `-p` stream-json mode, the same protocol
  the SDK wraps, so both CLIs share one bridge and core gains no vendor package.
- Router, study layer, Slack and Teams front doors (unchanged from the v0.1 roadmap).

## Review resolution (independent design review, before building)

These decisions override the sections above where they conflict.

1. **Egress stays at five call sites.** The gateway gains `admit(content: Labelled<unknown>, backendId) ->
   EgressDecision<ModelDestination>`, and every agent-backend check goes through it. The task prompt and every bridge
   reply need the `AuthorizedRoute` that it returns. `confine()` takes the prompt's route, and the bridge's reply
   function takes the route for that one result, so a missing check does not compile.
2. **A withheld result is not a refused run.** New event `tool.withheld { callId, refusal, cls }`. `fold()` does not
   set `refused` for it. Proxy refusals are counted in `agent.session.hostsRefused`, with the targets as a payload
   at the session's class (agents rework), and are not written as `egress.refused`. The run is `refused` only when the
   task prompt itself is refused.
3. **The seatbelt profile denies by default.** It starts with `(deny default)` and allows, by enumeration, only the
   reads, writes, mach services, process and sysctl operations each CLI needs, found by probing each CLI under trace.
   The confinement test asserts one denial per gap:
   - `/Volumes`, `/srv`, `/private/var/folders` outside the session, the Postgres data directory, the repository and
     `~`;
   - reading the parent's environment through `ps`;
   - DNS through mDNSResponder;
   - a direct TCP connection to the Postgres port and to an outside host;
   - opening a URL through LaunchServices.
4. **A per-session CLI state directory.** Each session gets a fresh `CLAUDE_CONFIG_DIR` or `CODEX_HOME` inside its
   workspace, which is deleted with the workspace. Auth comes from a dedicated service login that the lab sets up once:
   - Claude Code: a token from `claude setup-token`, in the env var that `auth_env` names. The token is passed only
     to the child.
   - Codex: `auth_file`, the path of a dedicated `auth.json` that is copied into the session's `CODEX_HOME`.

   The operator's own `~/.claude` and `~/.codex` are never readable. A canary test puts a codeword in a fake user
   CLAUDE.md, memory and AGENTS.md under the worker's HOME, and asserts that the codeword never appears in what the
   fake CLI receives. It also asserts the real CLI does not load these files, which the live smoke checks.
5. **A personal subscription is `public`.** The example and the docs say so. Only an organization contract that the
   institution approved justifies `approved` or `zdr`. Placement remains the lab's declaration, so this rule is
   documented and not enforced, in the same way as for endpoints.
6. **Agent runs keep job kind `run`.** The payload carries `engine: "chat" | "agent-cli"`, and each worker claims runs
   only of its own engine (a claim filter on `payload->>'engine'`, defaulting to chat). `/stop`, `/replies`, the
   studio test thread and every `kind = 'run'` query keep working. Stop consumes the run inbox: a confirmed stop, or
   any stop past the first step as in `next()`, kills the CLI's process group.
7. **Every bridge reply passes the check.** This covers outputs, `tool.failed` error text and limit messages.
   Error text is labelled at the class of what the tool touched, as `ToolRunner` already does.
8. **Native provider mappings follow the review.**
   - Anthropic: always send `tools` when the history contains `tool_use`, including on the final call. That call sets
     `tool_choice: {type: "none"}`. All tool results of one turn are merged into one user message, results first.
   - Both, superseded by "Replay" under "Native providers": a tool turn's whole output is kept as opaque provider
     state at the prompt's class and replayed as is. Responses sends no `include`: under `store: false` the
     reasoning items carry `encrypted_content` already, and the guide's stateless example sends none.
   - Both: superseded by "Sampling" under "Native providers". The native protocols send no `temperature` or `top_p`
     unless the endpoint sets `sampling = true`.

   Each of these has its own fixture.

Minor items accepted:
- **Read-only tools.** An agent CLI agent may hold only tools whose `effects` is `read`. That makes re-running after a
  crash safe.
- **Lease.** The lease stays alive through the session, as for any long job.
- **Spawn module.** Code outside core, an npm package or a harness's planted tool, may not import `agents/*`. The
  seal's resolve hook refuses it at run time. (The static rule for tool folders went with the folders.)
- **Bridge token.** The bridge token travels only by env var or a 0600 file in the workspace, never in argv.
- **run_code mounts.** Mount paths are realpath'd and must lie under the dataset's declared path.

Cut, as redundant:
- `agentCli.maxTurns`. `limits.maxSteps` counts bridged calls.
- The separate hosted-KB publish rule. The existing listing-ceiling check against the KB class covers it. The run-time
  check is the guarantee.

Kept against the review's suggestion: `modelsByClass`, because per-class routing is a stated requirement for v0.2. It
stays a separate optional field from `agentCli`, and the two are mutually exclusive by a parse rule.

## Live smoke resolution (after building)

This is a narrow exception to item 4, for development only. The live smokes ran on the operator's own logins, because
no lab service login existed and v0.2 spends nothing.

- **`dev_shared_login = "<dir>"` on an agent backend.** It is allowed only with `placement = "public"`, so the agent
  may see D0 alone. It is never written. It runs only when the agent worker is started with `--dev-shared-login`,
  which the binary refuses when `NODE_ENV=production`, so `lab.toml` alone cannot turn it on in a lab deployment.
  Without the flag the backend is not installed and its runs are unrunnable. With it, the worker prints a
  development-mode banner at boot. `pnpm demo:agent` passes the flag.
  - Claude Code gets a fresh `CLAUDE_CONFIG_DIR` in its workspace, as under any other login. Its subscription
    credential is a keychain item, and claude 2.1.303 names that item after `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it
    is set, instead of `CLAUDE_CONFIG_DIR` (`function D1` in the binary). The session sets that variable to the
    operator's login dir, or to the empty string for the default `~/.claude`, whose item has no suffix. The profile
    therefore opens nothing of the operator's Claude state: no transcripts, history, file history or `CLAUDE.md`.
    It still allows the one exec of `/usr/bin/security`, the mach services SecurityServer and securityd.xpc, and
    reads of `~/Library/Keychains`, and the child gets the operator's HOME, because `security` finds the keychain
    search list there. That keychain access is the remaining cost of the dev login, and the reason it is gated.
    The canary test covers this mode: the operator's `CLAUDE.md`, memory, `.credentials.json` and `.claude.json`
    read as EPERM, and the config dir the CLI sees is empty.
  - Codex cannot start with a read-only `CODEX_HOME`. Its `auth.json` is copied into the session home instead. A
    refresh inside the session would rotate the operator's own login, so the copy is refused when the access token
    expires before the agent's wall limit plus ten minutes, or when `last_refresh` is due within that time. The
    refresh age, eight days, is inferred from codex-rs and not read from the 0.155.1 binary.
- **Rework after the agent backends review.** Measured live on claude 2.1.303 with `claude-haiku-5-5` and a
  dev login: a session with the fresh config dir and the keychain variable answered through the bridge (two calls),
  its init line reported its auto-memory path inside the workspace config dir, and the proxy now admits a tunnel
  only after the ClientHello's SNI matches the CONNECT host, which claude's did. Codex was not run live after these
  changes.
- **`[channel_floors]` and a KB `definitionClass`.** A public agent needs a channel and a knowledge base it may read.
  `lab.toml` may raise any channel's floor. It may lower one below D1 only for the channel `[surfaces.web] channel`
  binds, because the web page otherwise names its channel and the floor would be the sender's choice. A bound web
  surface puts every message in its channel and refuses a body that names another. The demo binds its web server to
  `public` and sets `"web:public" = "D0"`. A KB definition may declare its `definitionClass`. Both fields are absent
  unless set, so existing hashes and snapshot ids do not move.
- **Three CLI facts found only by live runs.**
  - claude creates `/tmp/claude-<uid>` unless `CLAUDE_CODE_TMPDIR` is set. Every claude session now sets it inside
    the workspace.
  - Under `approval_policy = "never"`, codex rejects every MCP call that would ask for approval. The bridge server
    is set to `default_tools_approval_mode = "approve"`. The bridge is the gate.
  - codex has its own MCP resource tools, `list_mcp_resources`, `list_mcp_resource_templates` and
    `read_mcp_resource`, and no feature flag turns them off. They reach only configured MCP servers, which is the
    bridge alone, and the bridge answers resources methods with -32601. The self-check allows these three names on
    codex's own server. Any other tool outside the bridge still ends the run as `agent-not-confined`.
