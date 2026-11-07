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

[hosts]
"www.googleapis.com" = "approved"   # the Drive request carries folder and file ids, which are D1

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
quiet, so a save that writes several times is one sync) and on each Drive poll. Each line it prints says what changed:

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

Scope is enforced at retrieval, in one place (`packages/core/src/kb.ts`). For a member outside an entry's scope, the
outline in the model's prompt does not list it, `kb_search` never returns it and builds its ranking without it, and
`kb_read` reports it as missing, exactly like a path that does not exist. A run with no member (a schedule, an eval)
sees `lab` entries only. `test/sources.test.ts` checks this on the wire: the model's requests, the reply and the
record of an out-of-scope member's run hold neither the entry's path nor its text.

## Not built yet

- **LabArchives and Benchling.** `kind = "labarchives"` or `"benchling"` is refused with a message. Sync their exports
  to a folder and register the folder. A new kind implements `DocumentSource` in `packages/core/src/sources.ts`.
- **SharePoint and OneDrive through the Graph API.** Use the OneDrive sync client's folder.
- **A live Drive OAuth flow.** `token_env` holds an access token the lab obtains; the fake Drive in
  `scripts/fake-drive.ts` serves the same three calls the real API does.
- **Member identity.** `[directory]` is a stand-in for the identity unit's member directory (`MemberDirectory` in
  `packages/core/src/members.ts` is the seam). The web door has no sign-in yet, so the member a chat message names is
  the member it is from.
