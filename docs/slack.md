# Slack

Members ask Aliquot in Slack. They mention it in a channel it was invited to, or they send it a direct message. The answer posts in the thread, with a link to the run's record. The Slack door is `aliquot slack`, its own process. It reaches the web door over HTTP as the `[surfaces.slack]` surface, the same way `aliquot ask` does. The gate, the data-class checks and the record are the door's.

```
member in Slack ── Slack ── Socket Mode ── aliquot slack ── HTTP + slack surface token ── web door ── worker
```

With Socket Mode the lab machine opens the connection to Slack, so the lab's firewall can stay closed to the internet.

## What Slack holds

Slack's servers keep a copy of every message in a thread, so the slack surface's placement is `approved` at most. `lab.toml` refuses `lab` and `institution` for it. The door decides what Slack may get:

| The run ends | The thread shows |
|---|---|
| answered, at or below the surface's ceiling | the answer and a link to its record |
| answered, above the ceiling (D3 at `approved`) | the record link only, and nothing of the answer |
| refused by the egress check | the refusal and the record link; the model saw nothing |
| refused by the gate | the gate's message only |

What a member types in Slack is in Slack before Aliquot reads it. The gate keeps a participant id in a question away from a hosted model. It cannot take the question back out of Slack. Tell members which channels are for which data.

The Slack door holds three secrets: the two Slack tokens and the slack surface's token. The database and the payload key stay with the worker.

## Set it up

1. **Create the app from the manifest.** Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App**, then **From a manifest**. Pick the workspace and paste [`slack-app-manifest.json`](slack-app-manifest.json). It asks for three bot scopes and nothing else:

   | Scope | Why |
   |---|---|
   | `app_mentions:read` | read a message that mentions Aliquot in a channel it was invited to |
   | `chat:write` | post the answer in the thread, and edit the "looking" message into it |
   | `im:history` | read direct messages to Aliquot |

2. **Install it.** On **Install App**, choose **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-...`).
3. **Make the app-level token.** On **Basic Information**, under **App-Level Tokens**, choose **Generate Token and Scopes**, add `connections:write`, and copy the token (`xapp-...`).
4. **Name the surface in `lab.toml`:**

   ```toml
   [surfaces.slack]
   kind = "slack"
   placement = "approved"
   token_env = "ALIQUOT_SLACK_TOKEN"
   ```

5. **Add the secrets to `.env`:**

   ```sh
   echo "ALIQUOT_SLACK_TOKEN=$(openssl rand -hex 32)" >> .env
   echo "SLACK_BOT_TOKEN=xoxb-..." >> .env
   echo "SLACK_APP_TOKEN=xapp-..." >> .env
   echo "ALIQUOT_LINKS=https://aliquot.your-lab.example.edu" >> .env   # where members open record links
   ```

6. **Start it:** `docker compose --profile slack up -d`. Compose restarts the web door with `ALIQUOT_SLACK_TOKEN`, so the door knows the surface, and starts the `slack` service.
7. **Invite it** to a channel with `/invite @Aliquot`, and ask it something: `@Aliquot where do the -80 samples go?`

Without Docker, run the door yourself:

```sh
ALIQUOT_SURFACE_TOKEN=<value of ALIQUOT_SLACK_TOKEN> SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
  pnpm aliquot slack --door http://127.0.0.1:3000 --links https://aliquot.your-lab.example.edu
```

`aliquot slack` will not start without `ALIQUOT_SURFACE_TOKEN`. Without it the door would take Slack for the web surface, whose placement is the lab's own.

To try the app on the synthetic lab0 lab, `pnpm demo --slack` adds `[surfaces.slack]` and starts the Slack door beside the web door. It reads `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` from the environment, or from `~/.config/aliquot/slack.env` (`--slack-env` names another file), and prints "Slack door connected" once Socket Mode is up.

## In a thread

- A reply in the thread that mentions Aliquot is a new question in that thread. Each question is answered on its own; the earlier answers in the thread are not sent with it.
- `@Aliquot stop` in a thread with a run in progress stops that run at its next step.
- Messages from bots, edits, and messages from another workspace in a Slack Connect channel are ignored.

## Not in this release

- Direct messages from people outside the workspace, and file uploads from Slack.
- Sign-on: anyone in the workspace who can reach the app is a member. The web door's sign-on does not reach Slack; a lab that needs a narrower list invites Aliquot to fewer channels.
- A router across several agents. One Slack surface reaches the agent bound to its channel, else the deployment's agent.

## Checks

- `test/slack.test.ts` runs the real `aliquot slack` binary against a fake Slack (Web API and Socket Mode) and a fake door: the answer and its link, the link-only answer, the gate's refusal, stop, follow-ups in a thread, DMs, ignored bots, edits and other workspaces, a resent envelope, a reconnect, and the manifest's scopes.
- `pnpm lab0` check S runs it against the real door, worker and Postgres: a mention gets the cited answer in its thread with a record link that opens, and a question with a participant id is refused with zero requests to the hosted model.
