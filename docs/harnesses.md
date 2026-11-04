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

`--ceiling D0|D1|D2|D3` is for a caller that keeps its own copy of the answer. An answer whose class ranks above the ceiling comes back as `withheld: true` with no text, and the reader opens the record instead. The door has already applied its own surface's placement. The ceiling is a second, stricter limit, set by the caller.

The web door has no sign-in yet. Until the sign-on release (0.8), it trusts the member id it is given, and it stays on `127.0.0.1` like the chat page. So `aliquot ask` and `aliquot acp` run on the lab machine itself, or reach the door through an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 lab-server`).

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

Each T3 thread is one Aliquot thread, so a follow-up carries the earlier turns. The tools the run used appear as completed steps, then the answer, then `Record: <url>`. A refusal ends the turn with the stop reason `refusal` and the door's message. Stopping the turn in T3 stops the run through the door.

Set `--ceiling`. T3 Code keeps every thread's text in its own database on the machine it runs on, and with T3 Connect turned on, it sends thread titles to `relay.t3.codes` for notifications. That is a copy outside Aliquot's record and its payload key. With `--ceiling D1`, a D2 or D3 answer never enters T3: the thread gets the record link only.

T3 Code's phone app pairs straight to a T3 host over a LAN or Tailscale (`t3 serve --host <tailnet address>`, then `t3 pair`), with no T3 cloud in the path. Aliquot threads then show on the phone too. Push notifications are the exception, since they need T3 Connect. A T3 pairing grants a shell on the host (`terminal:operate`), so pair only your own devices to a T3 host, never a lab member's phone to the lab server. Members use the chat page.

`test/door-client.test.ts` drives `aliquot acp` with ACP messages over stdio. The official ACP TypeScript SDK (`@agentclientprotocol/sdk` 2.4.0) also parsed every message from it as a client: initialize, session/new, session/prompt, and the `tool_call` and `agent_message_chunk` updates.

## herdr and Orca

Neither needs its own adapter. Both run agents in terminals, so an Aliquot run from either one is `aliquot ask --json` in a pane, and a long-running stack is `scripts/tmux.sh`, since herdr sits on tmux.
