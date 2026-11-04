# Aliquot from other harnesses

Aliquot runs a lab's agents. Some people want to reach those agents from the tool they already work in: a terminal, tmux, T3 Code, an editor, or a lab's own orchestrator. Instead of one adapter per tool, Aliquot offers one small contract, and each harness uses it in its own way:

| From | How | What you get |
|---|---|---|
| A terminal or a script | `aliquot ask --json` | One JSON line per step, and a record link. Exit 0 means answered. |
| tmux | `scripts/tmux.sh` (`pnpm up:tmux`) | The worker, the web door and a shell for asking, as windows of one session you can attach to. |
| T3 Code, Zed, JetBrains or another ACP client | `aliquot acp` as a local ACP command | Each question is a thread, the tools the run used appear as steps, and the answer ends with the record link. |
| A lab's own orchestrator, Claude Code or Codex | `aliquot ask --json` from a shell step | The same JSON lines. Read `recordUrl` to cite the run. |

Every route goes through the web door's own routes (`POST /message`, `GET /runs/:id/events`, `GET /replies`, `POST /stop`), the same ones the chat page uses. The gate, the data-class checks and the run record apply unchanged. Nothing on this page decides egress. `packages/core/src/door-client.ts` is the only file involved that opens a socket, and `scripts/boundaries.ts` allows it HTTP and HTTPS only.

## The contract: `aliquot ask`

	pnpm aliquot ask --door http://127.0.0.1:3000 --user member-1 --json "Where do incoming samples go first?"

`--door` defaults to `$ALIQUOT_DOOR`, and then to `http://127.0.0.1:3000`. `--user` defaults to `$ALIQUOT_USER` and is required. The door checks it against the lab's members, as it does for the chat page. `-` in place of the question reads it from stdin. `--thread <id>` puts several questions in one thread, so the agent sees the earlier turns.

With `--json`, each line is one event:

| `t` | Fields | When |
|---|---|---|
| `started` | `runId`, `recordUrl` | The door took the message and queued a run. |
| `tool` | `runId`, `tool` | The run asked for a tool (`kb_search`, `pubmed_search`, ...). |
| `finished` | `runId`, `outcome`, `answer`, `cls`, `withheld`, `refusal`, `recordUrl` | The run ended. `answer` is null when the egress check refused the run (`refusal` says why) or when the answer is withheld (below). |
| `refused` | `runId: null`, `message` | The gate refused the message before any run, for example an unknown member or a participant id in the text. |

Exit codes: 0 answered, 1 refused or not answered, 2 a usage problem or a door that cannot be reached. Without `--json`, the answer goes to stdout followed by `record  <url>`, and the run id and tools go to stderr.

`ALIQUOT_SURFACE_TOKEN` names the surface the question comes from (see Surfaces below). Without it, `aliquot ask` and `aliquot acp` speak as the web surface. `withheld: true` with no text means the answer ranked above what the surface or the caller may keep, and the reader opens the record instead. A token the door does not know is one line on stderr naming `ALIQUOT_SURFACE_TOKEN`, and exit 2.

`--ceiling D0|D1|D2|D3` is a stricter promise on the caller's side, for a caller that keeps its own copy of the answer. The door already withholds anything above its surface's placement. An answer above the ceiling is withheld the same way.

The web door has no member sign-in yet. Until the sign-on release, it trusts the member id it is given, and it stays on `127.0.0.1` like the chat page. So `aliquot ask` and `aliquot acp` run on the lab machine itself, or reach the door through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 lab-server`).

## Surfaces

Each way into the door is a surface, `[surfaces.<id>]` in `lab.toml`, with a kind and a placement. The placement sets the surface's ceiling, the highest class the door shows it. Above that, the door posts the record link only. The run record names the surface each run came from.

| Surface | Kind | Placement | Ceiling | Reaches the door with |
|---|---|---|---|---|
| `web` | `web` | `lab` by default | D3 | No token. The chat page, and `aliquot ask` or `aliquot acp` without `ALIQUOT_SURFACE_TOKEN`. |
| `acp` | `acp` | `zdr`, as `aliquot init` writes it | D1 | `ALIQUOT_SURFACE_TOKEN` set to the value of `ALIQUOT_ACP_TOKEN`. |
| `slack` | `slack` | `approved` at most | D2 | Planned. Slack's servers keep a copy of every answer, so `lab.toml` refuses `lab` and `institution` for it. The door takes no Slack token. |
| `phone` | `phone` | set by the lab | that placement's | Planned. A bearer token, like `acp`. |

The chat ceilings by placement are `lab` D3, `institution` D2, `approved` D2, `zdr` D1 and `public` D0.

A surface other than `web` names an environment variable in `token_env`. The token itself is never in `lab.toml`. The door reads each token when it starts and keeps only its SHA-256 hash. A token must be at least 32 characters (`openssl rand -hex 32`). When the variable is unset or shorter, that surface accepts nothing, and the door prints one line that names the variable. When two surfaces hold the same token, the door does not start. `aliquot init` writes a new `ALIQUOT_ACP_TOKEN` into a new `.env`. For an existing `.env` without one, it prints the command that adds it. Neither the compose stack nor `scripts/tmux.sh` passes `ALIQUOT_ACP_TOKEN` to the web door yet, so there the `acp` surface accepts nothing. Start the web door with the variable in its environment to serve it.

A client sends the token as `Authorization: Bearer <token>`. A bearer token the door does not know is a 401, such as a Slack token or one whose variable is unset, and so is `Bearer` with no token. A 401 never falls back to web. A request with no bearer token is the web surface, including one that carries the Basic credentials a reverse proxy forwards. A surface reads replies and stops runs only for its own runs, which keeps each client on its own surface. That is not access control while the web surface has no sign-in, because anyone who reaches the door can send no token and read web runs as web.

## tmux

	scripts/tmux.sh --config lab.toml [--session aliquot] [--port 3000] [--studio] [--attach]
	tmux attach -t aliquot
	scripts/tmux.sh --stop

It reads `.env` when there is one and starts one session with a window per process: `worker`, `web`, `studio` (with `--studio`) and `ask`, a shell with `ALIQUOT_DOOR` set. Each window runs the same command the README gives, under Node's permission model. A window whose process exits stays open with its last lines, so a crash can be read in place. A second start with the session still running is refused, with the attach command.

The worker and the web door print one line per event, prefixed with their name (`[worker ...]`, `[web]`), so a pane reads well at any width.

## T3 Code and other ACP clients

`aliquot acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) (v1) on stdin and stdout. In T3 Code: **Settings**, then **Providers**, then **Add provider**, then **Show more**, then **Local ACP command**. Set the executable to `node` and add these arguments, one per row:

	--permission
	--allow-fs-read=*
	--allow-net
	/path/to/aliquot/packages/core/bin/aliquot.ts
	acp
	--door
	http://127.0.0.1:3000
	--user
	member-1
	--ceiling
	D1

Under the provider's environment variables, add `ALIQUOT_SURFACE_TOKEN` with the value of `ALIQUOT_ACP_TOKEN` from the lab's `.env`, and mark it sensitive. As an environment variable rather than an argument, the token stays out of the command line that `ps` shows.

Each T3 thread is one Aliquot thread, so a follow-up carries the earlier turns. T3 wraps a thread's first prompt in its own instructions, inside `<user_request>` tags. `aliquot acp` sends only the words inside those tags to the door. The tools the run used appear as completed steps, then the answer, then `Record: <url>`. A refusal ends the turn with the stop reason `refusal` and the door's message. Stopping the turn in T3 stops the run through the door.

T3 Code keeps every thread's text in its own database on the machine it runs on, and with T3 Connect turned on, it sends thread titles to `relay.t3.codes` for notifications. That is a copy outside Aliquot's record and its payload key, which is why `aliquot init` places the `acp` surface at `zdr`. With the token set, the door itself keeps any D2 or D3 answer out of T3, and the thread gets the record link only. `--ceiling D1` makes the same promise on the client's side, and still holds if the token is missing and the door takes T3 for the web surface.

T3 Code's phone app pairs straight to a T3 host over a LAN or Tailscale (`t3 serve --host <tailnet address>`, then `t3 pair`), with no T3 cloud in the path. Aliquot threads then show on the phone too. Push notifications are the exception, since they need T3 Connect. A T3 pairing grants a shell on the host (`terminal:operate`), so pair only your own devices to a T3 host, never a lab member's phone to the lab server. Members use the chat page.

`test/door-client.test.ts` drives `aliquot acp` with ACP messages over stdio. The official ACP TypeScript SDK (`@agentclientprotocol/sdk` 2.4.0) also parsed every message from it as a client: initialize, session/new, session/prompt, and the `tool_call` and `agent_message_chunk` updates.

## herdr and Orca

Neither needs its own adapter. Both run agents in terminals, so an Aliquot run from either one is `aliquot ask --json` in a pane, and a long-running stack is `scripts/tmux.sh`, since herdr sits on tmux.
