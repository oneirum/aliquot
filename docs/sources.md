# Document sources

A lab's SOPs, protocols and onboarding notes live in Box, OneDrive, SharePoint or Google Drive, and they change.
A document source keeps a knowledge base in step with them: every document becomes an entry, each entry knows which
version of its document it holds and who may see it, and an answer that read an older version says so.

## Register a source

Sources go in `lab.toml`. Several sources can feed one knowledge base (`kb`).

```toml
# A Box, OneDrive or Google Drive desktop sync folder. The vendor's client keeps it current.
[sources.box-sops]
kind = "folder"
path = "/Users/labadmin/Library/CloudStorage/Box-Box/Lab SOPs"
kb = "lab-docs"
class = "D1"            # declared class: a floor, raised by participant-id patterns
scope = ["lab"]         # who may see these documents

# A folder only the cryo group may read: register it as its own source.
[sources.cryo-protocols]
kind = "folder"
path = "/Users/labadmin/Library/CloudStorage/Box-Box/Cryo"
kb = "lab-docs"
class = "D1"
scope = ["group:cryo"]

# A Google Drive folder through the Drive API. Scope comes from each file's permissions.
[sources.lab-drive]
kind = "gdrive"
folder_id = "1AbC..."   # the folder's id from its URL
token_env = "LAB_DRIVE_TOKEN"
kb = "lab-docs"
class = "D1"
poll_seconds = 60

# A SharePoint document library (or a OneDrive) through Microsoft Graph. Scope from each file's permissions.
[sources.lab-sharepoint]
kind = "graph"
drive_id = "b!3fK..."   # the library's drive id (below)
folder = "Lab SOPs"     # optional: only this folder of the library
token_env = "LAB_GRAPH_TOKEN"
kb = "lab-docs"
class = "D1"
poll_seconds = 60
[sources.lab-sharepoint.site_groups]
"Lab SOPs Members" = "lab"          # a SharePoint group: who it is in the lab
"Cryo Owners" = "group:cryo"

[hosts]
"www.googleapis.com" = "approved"   # the Drive request carries folder and file ids, which are D1
"graph.microsoft.com" = "approved"  # so does the Graph request
"contoso.sharepoint.com" = "approved"  # Graph redirects each download to the tenant's SharePoint host

# Until member sign-on lands, the directory says who is in which group,
# and which email a Drive permission names.
[directory.groups]
cryo = ["ana", "raj"]
[directory.emails]
"ana@lab.example.edu" = "ana"
"cryo-group@lab.example.edu" = "group:cryo"
```

Then run the sync, once or as a service:

```sh
pnpm sources --config config/lab.toml            # once
pnpm sources --config config/lab.toml --watch    # and keep watching
```

`--watch` syncs every knowledge base once, then again whenever a file in a synced folder changes (after 300 ms of
quiet, so a save that writes several times is one sync) and on each Drive or Graph poll. Each line it prints says what changed:

```
kb lab-docs: published 462f79beafb9 (was 01028611cd1b): changed box-sops/freezer-alarm.md
```

A sync that finds nothing new writes nothing: touching a file without changing its text keeps the snapshot.
A source that fails (Drive unreachable, a folder unmounted) fails the whole sync and the published snapshot stays as
it was, so a knowledge base never loses documents to an outage.

## What becomes an entry

One entry per document, at `<source id>/<path in the folder>.md`. Markdown, text, Word (`.docx`), Google Docs (as
text) and, when `[sandbox]` is set, PDFs with real text. Office lock files (`~$...`), dotfiles and the sync clients'
own files are skipped; other types are listed as skipped in the sync line. A Drive file whose permissions name no lab
member, group or the domain is not ingested at all.

Each entry carries its document's **version** (an HMAC of its text under the lab's key), when it was last modified,
which source and file it came from, and its **scope**.

## Versions in answers and records

`kb_search` and `kb_read` give the model each entry's version and modified time, and the run record names every
document version the run read. Open a record and the `tool.completed` row says, for example,
`citing box-sops:Freezer alarm.md version bfb60d263cee of 2026-11-07T03:18:56Z`.

When a cited document changes after the answer, the chat page says so under the answer: **Changed since this answer:
Freezer alarm.md was edited 21:52. Ask again to get an answer from the current version.** The record keeps the old
version: it is what the answer read. `GET /runs/<id>/sources` on the web door returns the same comparison as JSON.

## Scope

A scope entry is `lab` (every member), `member:<id>` or `group:<name>`. A member sees an entry when any one of its
scope entries names them. Drive permissions map like this:

| Drive permission | Scope |
|---|---|
| Anyone with the link, or the domain | `lab` |
| A user | `member:<id>` for the member `[directory.emails]` maps their email to |
| A group | `group:<name>` for the group `[directory.emails]` maps its address to |
| An email the directory does not know | nobody |

## SharePoint and OneDrive

A `graph` source reads one drive: a SharePoint document library, or a member's OneDrive. Find a library's drive id
with Graph Explorer or any Graph client: `GET /v1.0/sites/contoso.sharepoint.com:/sites/LabSOPs` gives the site id,
and `GET /v1.0/sites/<site id>/drives` lists its libraries with their ids. The permissions an admin consents to are in
[`install.md`](install.md#sharepoint-and-onedrive-what-the-tenant-admin-consents-to).

Each poll asks Graph only what changed:

- The first sync reads the library's root delta, page by page, and keeps the `deltaLink`. Every later sync reads that
  link, so a poll of an unchanged library is one request and downloads nothing. When Graph answers 410 Gone (the link
  expired), the next sync reads the whole library again.
- An edited file is downloaded again (its `cTag` moved); nothing else is. A file whose sharing changed has its
  permissions read again, and so does every file under a folder whose sharing changed, was renamed or was moved.
- A file deleted in SharePoint, or moved out of `folder`, leaves the knowledge base on the next sync. An answer that
  cited it says its source was removed.
- A folder rename moves every entry under it to its new path.
- Permissions are read before content, so a file no lab member may see is never downloaded.
- Word, Markdown and text files go through the same readers as a synced folder; a PDF needs `[sandbox]`, and without
  it is listed as skipped and never downloaded.

The download is a redirect to a short-lived URL on the tenant's SharePoint host. The egress decides that host on its
own, so `lab.toml` must place it, and the Graph token is never sent there. A `nextLink` or `deltaLink` naming any
origin other than `base_url` is refused before the token is sent.

| Graph permission on a file | Scope |
|---|---|
| A sharing link for anyone, or for people in the organization | `lab` |
| A user (Entra or SharePoint site user) | `member:<id>` for the member `[directory.emails]` maps their address to |
| An Entra group | `group:<name>` for the group `[directory.emails]` maps its address to |
| A SharePoint group | what `site_groups` maps its display name to (`lab`, `member:<id>` or `group:<name>`) |
| Anything else (a sharing link for named people outside the lab, an unmapped group) | nobody |

Graph returns a file's effective permissions, inherited ones included, so a library shared with "Lab SOPs Members"
and a Cryo folder with its own permissions for the cryo group give the folder's files `group:cryo` only.

Scope is enforced at retrieval, in one place (`packages/core/src/kb.ts`). For a member outside an entry's scope, the
outline in the model's prompt does not list it, `kb_search` never returns it and builds its ranking without it, and
`kb_read` reports it as missing, exactly like a path that does not exist. A run with no member (a schedule, an eval)
sees `lab` entries only. `test/sources.test.ts` checks this on the wire: the model's requests, the reply and the
record of an out-of-scope member's run hold neither the entry's path nor its text.

## Not built yet

- **LabArchives and Benchling.** `kind = "labarchives"` or `"benchling"` is refused with a message. Sync their exports
  to a folder and register the folder. A new kind implements `DocumentSource` in `packages/core/src/sources.ts`.
- **A live Drive or Graph OAuth flow.** `token_env` holds an access token the lab obtains and renews (a Graph app
  token lasts about an hour); Aliquot does not fetch or refresh one yet. The fake Drive in `scripts/fake-drive.ts`
  and the fake Graph in `scripts/fake-graph.ts` serve the same calls the real APIs do, and a real token takes the
  same path with only `base_url` and the token changed. The Graph source has not yet run against a live tenant.
- **Graph's delta link across restarts.** It is kept in memory, so the first sync after `kb sync --watch` starts reads
  the whole library once.
- **Member identity.** `[directory]` is a stand-in for the identity unit's member directory (`MemberDirectory` in
  `packages/core/src/members.ts` is the seam). The web door has no sign-in yet, so the member a chat message names is
  the member it is from.
