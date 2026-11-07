# Microsoft Teams

Members ask Aliquot in Teams. They mention it in a channel or group chat it was added to, or message it in a personal chat. The answer posts as a reply in the thread, with a link to the run's record. The Teams door is `aliquot teams`, its own process. It reaches the web door over HTTP as the `[surfaces.teams]` surface, the same way `aliquot ask` and `aliquot slack` do. The gate, the data-class checks and the record are the door's.

```
member in Teams ── Teams ── Bot Framework ── https POST /api/messages ── lab's TLS proxy ── aliquot teams ── HTTP + teams surface token ── web door ── worker
```

Teams has nothing like Slack's Socket Mode: the Bot Framework posts every message to the bot. So the Teams door needs one public HTTPS address, which the lab's TLS proxy forwards to `aliquot teams` on port 3978. Every request to it must carry a token the Bot Framework signed for the lab's app. A request without one, or signed for another app, or from another tenant, or naming a reply address that is not a Teams host, is refused with 401 and asks nothing.

## What Teams holds

Microsoft keeps every Teams message in the institution's Microsoft 365 tenant, under the institution's own agreement with Microsoft. That is what `institution` placement means, so the teams surface may be `institution` at most; `lab.toml` refuses `lab`. If your institution has not approved Teams for confidential (D2) data, use `approved` or lower. The door decides what Teams may get:

| The run ends | The thread shows |
|---|---|
| answered, at or below the surface's ceiling (D2 at `institution`) | the answer and a link to its record |
| answered, above the ceiling (D3 at `institution`) | the record link only, and nothing of the answer |
| refused by the egress check | the refusal and the record link; the model saw nothing |
| refused by the gate | the gate's message only |

What a member types in Teams is in Teams before Aliquot reads it. The gate keeps a participant id in a question away from a hosted model. It cannot take the question back out of Teams. Tell members which channels are for which data.

The Teams door holds four secrets: the app's id, its client secret, the tenant id and the teams surface's token. The database and the payload key stay with the worker.

## What the campus Teams admin does

These steps need two roles in the university's tenant: someone who can register an application in Microsoft Entra ID and create an Azure Bot resource, and a Teams administrator. In most universities that is central IT; send them this section.

### 1. Register the app (Microsoft Entra admin center)

1. Open [entra.microsoft.com](https://entra.microsoft.com), then **Applications**, **App registrations**, **New registration**.
2. Name it `Aliquot (<lab name>)`. Under **Supported account types** choose **Accounts in this organizational directory only (single tenant)**. Leave the redirect URI empty. Register.
3. Copy the **Application (client) ID** and the **Directory (tenant) ID** from the overview. These are `MICROSOFT_APP_ID` and `MICROSOFT_APP_TENANT_ID`.
4. Under **Certificates & secrets**, **New client secret**. Copy its **Value** (shown once). This is `MICROSOFT_APP_PASSWORD`. Note its expiry date: the door stops answering when it lapses, so put a renewal on the lab's calendar.
5. Under **API permissions**, remove the `User.Read` permission Entra adds by default.

**Admin consent: there is none to grant.** The app asks for no Microsoft Graph permissions and no resource-specific consent. It reads only the messages that mention it, or that a member sends it in a personal chat, because that is all the Bot Framework delivers to a bot without those permissions. It cannot read a channel's other messages, files, calendars or the directory.

### 2. Create the Azure Bot (Azure portal)

1. In [portal.azure.com](https://portal.azure.com), **Create a resource**, search **Azure Bot**, **Create**.
2. Pick the subscription and resource group the university uses for lab services. **Pricing tier**: Free (F0) is enough; Teams is a standard channel.
3. **Type of App**: **Single Tenant**. **Creation type**: **Use existing app registration**, with the client ID and tenant ID from step 1.
4. After it deploys, open the resource. Under **Settings**, **Configuration**, set **Messaging endpoint** to `https://<the lab's public name>/api/messages`.
5. Under **Channels**, add **Microsoft Teams**, accept the terms, and apply. Leave Web Chat as it is; Aliquot does not use it.

### 3. Upload the Teams app (Teams admin center)

1. Make the app package. In `docs/teams-app/`, copy `docs/teams-app-manifest.json` to `manifest.json`, replace both `REPLACE-WITH-MICROSOFT_APP_ID` with the client ID, and set `developer` to the lab's name and pages. Zip the three files at the top level of the archive:

   ```sh
   cd docs/teams-app && cp ../teams-app-manifest.json manifest.json
   sed -i.bak "s/REPLACE-WITH-MICROSOFT_APP_ID/$MICROSOFT_APP_ID/g" manifest.json && rm manifest.json.bak
   zip aliquot-teams.zip manifest.json color.png outline.png
   ```

2. In the [Teams admin center](https://admin.teams.microsoft.com), **Teams apps**, **Manage apps**, **Actions**, **Upload new app**, and upload the zip.
3. Open the app's page. Set it **Allowed**, and under **Users and groups** (or the permission policy the university uses) make it available to the lab's members only.
4. Optional: an app setup policy can pin Aliquot for the lab's members.

A team owner in the lab then adds Aliquot to the lab's team (**Apps**, **Get more apps**, **Built for your org**), and members can mention `@Aliquot` in its channels.

### 4. Network

- Inbound: the Bot Framework's HTTPS requests to `https://<public name>/api/messages`. The lab's TLS proxy forwards that one path to the Teams door on port 3978, and nothing else. Every request is checked by signature, so restricting source addresses is optional; if the campus firewall wants it, Azure's `AzureBotService` service tag lists the ranges.
- Outbound from the Teams door: `login.botframework.com` (signing keys), `login.microsoftonline.com` (the app's token), and the Teams connector (`smba.trafficmanager.net`, or `*.teams.microsoft.com` and `*.teams.microsoft.us` in government clouds).

## What the lab does

1. **Name the surface in `lab.toml`:**

   ```toml
   [surfaces.teams]
   kind = "teams"
   placement = "institution"
   token_env = "ALIQUOT_TEAMS_TOKEN"
   ```

2. **Add the secrets to `.env`:**

   ```sh
   echo "ALIQUOT_TEAMS_TOKEN=$(openssl rand -hex 32)" >> .env
   echo "MICROSOFT_APP_ID=<Application (client) ID>" >> .env
   echo "MICROSOFT_APP_PASSWORD=<client secret value>" >> .env
   echo "MICROSOFT_APP_TENANT_ID=<Directory (tenant) ID>" >> .env
   echo "ALIQUOT_LINKS=https://aliquot.your-lab.example.edu" >> .env   # where members open record links
   ```

3. **Start it:** `docker compose --profile teams up -d`. Compose restarts the web door with `ALIQUOT_TEAMS_TOKEN`, so the door knows the surface, and starts the `teams` service on `127.0.0.1:3978` (`LABH_TEAMS_BIND` and `LABH_TEAMS_PORT` change that). Point the TLS proxy's `/api/messages` at it.
4. **Ask it something** in the lab's team: `@Aliquot where do the -80 samples go?`

Without Docker, run the door yourself:

```sh
ALIQUOT_SURFACE_TOKEN=<value of ALIQUOT_TEAMS_TOKEN> MICROSOFT_APP_ID=... MICROSOFT_APP_PASSWORD=... MICROSOFT_APP_TENANT_ID=... \
  pnpm aliquot teams --door http://127.0.0.1:3000 --links https://aliquot.your-lab.example.edu --listen 127.0.0.1:3978
```

`aliquot teams` will not start without `ALIQUOT_SURFACE_TOKEN`. Without it the door would take Teams for the web surface, whose placement is the lab's own. `GET /healthz` answers `ok` for a proxy's health check.

To see it on the synthetic lab0 lab with no Microsoft account, `pnpm demo --teams` adds `[surfaces.teams]`, starts the Teams door against a stand-in for Teams and the Bot Framework (`scripts/fake-teams.ts`, which signs its own tokens), asks two questions in a channel thread, and prints what the thread shows: a cited answer with its record link, and a participant id refused.

## In a thread

- In a channel, a mention starts a thread, and the answer is a reply in it. A reply in that thread that mentions Aliquot is a new question in the same thread. Each question is answered on its own; the earlier answers in the thread are not sent with it.
- A personal chat or a group chat has no threads in Teams, so the whole chat is one thread.
- `@Aliquot stop` in a thread (or `stop` in a personal chat) with a run in progress stops that run at its next step.
- Messages from bots, edits, reactions, and messages from another tenant (a shared channel, or a guest's own organization) are ignored.

## Not in this release

- File uploads from Teams, adaptive cards, and single sign-on. The member's identity is their Entra object id, which is what the record names.
- Sign-on beyond Teams: anyone in the tenant who can reach the app is a member. Limit who can install it in step 3. The web door's sign-on does not reach Teams.
- A router across several agents. One Teams surface reaches the agent bound to its channel, else the deployment's agent.

## Checks

- `test/teams.test.ts` runs the real `aliquot teams` binary against the stand-in and a fake door: the answer and its link, the link-only answer, the gate's refusal, stop and follow-ups in a channel thread, a personal chat as one thread, ignored bots, edits and other tenants, a resent activity, and refusals of an unsigned, forged, wrong-audience, expired or wrong-serviceUrl activity. It also checks the manifest asks for no Graph or resource-specific permissions.
- `test/surfaces.test.ts` holds a teams surface at `institution` to its ceiling: a D3 answer leaves the door as the record link only, a D2 answer as its text.
- `pnpm lab0` check T runs it against the real door, worker and Postgres: a channel mention gets the cited answer in its thread with a record link that opens, a forged activity is refused, and a question with a participant id is refused with zero requests to the hosted model.
