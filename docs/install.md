# Install Aliquot on a lab machine

This page is for research IT. It covers one Linux machine running the whole stack under Docker Compose. Kubernetes and high availability are out of scope.

## What you need

- Linux with Docker Engine 25 or later and the Compose plugin 2.24 or later (`docker compose version`). Node is not needed on the machine. Ubuntu's `docker.io` package builds without buildx, which works but is slow; install `docker-buildx` as well.
- About 3 GB of disk for the images, plus the database. The sandbox image adds about 1 GB.
- A model the lab may use. See **Models** below.

**Models.** Aliquot calls models only with credentials the lab or the university owns: an Anthropic or OpenAI organization key, your cloud's Bedrock, Azure or Gemini account, your campus AI gateway or another OpenAI-compatible endpoint the institution approved, or a model on lab hardware (Ollama on the same machine with `docker compose --profile ollama up -d`, or a vLLM server). Give each one the placement your institution approved for it. `lab.example.toml` lists every kind. A personal ChatGPT or Claude subscription cannot power Aliquot. The vendors' terms do not allow a shared server to use one, and consumer plans may train on what they receive. Members who have their own subscriptions keep them in their own tools and reach Aliquot through `aliquot mcp`, `aliquot acp` or `aliquot ask` (see [harnesses](harnesses.md)). Aliquot then sends each tool only the answers its surface's placement allows. `lab.example.toml` has Bedrock, Azure, Foundry, Gemini and campus gateway endpoints. Claude Fable 5 and Mythos 5 are kept for 30 days on every route, so Aliquot refuses to start with one listed on a `zdr` endpoint. A `litellm` profile for Vertex, an Entra-only Azure resource and AWS SigV4 is planned.

## Install

	git clone https://github.com/oneirum/aliquot.git
	cd aliquot
	docker compose run --rm init
	docker compose up -d --build
	docker compose ps

`docker compose run --rm init` asks a few questions and writes two files in the checkout:

| File | Holds | Rules |
|---|---|---|
| `config/lab.toml` | Where the database, the models and the web door are, each with its placement, and the lab's participant id patterns | Mounted read-only into the containers at `/etc/aliquot`. Edit it and run `docker compose up -d` to apply. |
| `.env` | `POSTGRES_PASSWORD`, `LABH_PAYLOAD_KEY`, `PAYLOAD_SECRET` and the surface tokens `ALIQUOT_ACP_TOKEN` and `ALIQUOT_STUDIO_TOKEN`, mode 600 | Written once. init never rewrites it, because a new `LABH_PAYLOAD_KEY` makes every stored payload unreadable. |

The participant id question is the one that matters most. Every message, source and result that matches one of these patterns is restricted (D3) and never reaches a hosted model. init tests the patterns against ids you paste and prints PASS or FAIL for each. It also refuses a pattern that matches ordinary words.

`docker compose up` starts four services. Postgres holds core's tables and the studio's tables (in a `studio` schema). The worker runs agents and compiles knowledge bases. The web door is the members' chat page and record pages, on port 3000. The studio is the authoring app, a production build on port 3001. Only the worker and the web door get `LABH_PAYLOAD_KEY`. The studio holds no payload key: it sends every read and write of core's tables to the web door with `ALIQUOT_STUDIO_TOKEN`, and connects to Postgres itself only for its own tables, as the same database user. Core applies its migrations when the worker or the web door starts. The studio applies its own committed migrations when it starts.

Every port is published on `127.0.0.1`. The web door has no sign-in yet (planned for 0.7), so keep it on the machine, or behind a proxy that only lab members can reach. `LABH_BIND` in `.env` changes the address. `LABH_WEB_PORT`, `LABH_STUDIO_PORT` and `LABH_PG_PORT` change the ports.

## Knowledge bases

Put a knowledge base definition and its source files in `config/`, then compile and publish with the kb command inside the worker:

	docker compose exec worker aliquot-kb compile --definition /etc/aliquot/handbook.json --wait
	docker compose exec worker aliquot-kb publish --snapshot <id it printed>
	docker compose exec worker aliquot runs

A source may be Markdown, text, Word (.docx) or PDF. PDF needs the sandbox (next section).

## The sandbox: PDF sources and run_code

	docker build -t aliquot-sandbox sandbox
	docker image inspect --format '{{.Id}}' aliquot-sandbox

Give that id to init's sandbox question, or add it to `config/lab.toml` as `[sandbox] image = "sha256:..."`. poppler is inside that image, so its digest pins the PDF parser's version, and a rebuild means a new digest in `lab.toml`.

The sandbox needs the worker to reach the Docker socket. `compose.sandbox.yaml` gives the socket to the worker and to nothing else. init adds it to `.env` as `COMPOSE_FILE=compose.yaml:compose.sandbox.yaml` when you turn the sandbox on. On Linux, set `DOCKER_GID` in `.env` to the socket's group:

	docker run --rm -v /var/run/docker.sock:/s busybox stat -c %g /s

Each PDF is read in its own container. The container has no network, a read-only root and uid 65534, with all capabilities dropped. The file goes in through the Docker archive API and is removed with the container. A page that is only an image fails the whole file with a message naming the page, because Aliquot does not do OCR. The studio has no Docker socket, so a PDF source compiles with the kb command, not from the studio.

## Backup and restore

	scripts/backup.sh                 # writes backups/<UTC time>/
	scripts/restore.sh backups/<time>

`backup.sh` writes `labh.dump` (a `pg_dump` of the whole database: run records, knowledge bases, the studio), `payload-key` (one `ENV=value` line for each payload key the lab holds), `key-ids` (which key id each line is) and `SHA256SUMS`. It asks the worker which keys hold bodies (`aliquot keys env`) and refuses, naming the key id, when one of them is not in `.env`. Payloads in the dump are encrypted under those keys. Keep the keys apart from the dump: the dump alone cannot be read, and anyone with both can read every stored question and answer.

`restore.sh` checks the checksums. It refuses when `.env` lacks any key in the backup's `key-ids`, or holds a different value, and names the missing key id, because the restored payloads would not decrypt. It then stops the worker, the web door and the studio, replaces the `labh` database, starts them again and runs `aliquot runs`, which checks every run's hash chain. It exits nonzero if any chain is broken.

To restore on a new machine: clone, run `docker compose run --rm init`, copy every line of the backup's `payload-key` into the new `.env`, run `docker compose up -d --build`, then run `scripts/restore.sh`.

Both scripts honour `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and `ALIQUOT_ENV` (the env file, `.env` by default).

## Rotate the key

Rotate the payload key when someone who held it leaves, on the schedule your security office sets, or to move D3 under a key of its own. Old payloads stay readable the whole time: each stored payload carries the id of the key it was written under, and a process reads it with that key. Payload hashes never change, so run records, knowledge bases and published agents are unaffected.

1. Add the new key to `.env` beside the old one:

	echo "LABH_PAYLOAD_KEY_2=$(openssl rand -hex 32)" >> .env

2. In `config/lab.toml`, replace `key_env = "LABH_PAYLOAD_KEY"` with key ids, and make the new one current:

	[store]
	placement = "lab"
	current = "k2"
	[store.keys]
	k1 = "LABH_PAYLOAD_KEY"
	k2 = "LABH_PAYLOAD_KEY_2"

   `key_env = "X"` is the same as `k1 = "X"`, so every payload already stored is under `k1`. `compose.yaml` passes `LABH_PAYLOAD_KEY`, `LABH_PAYLOAD_KEY_2` and `LABH_PAYLOAD_KEY_3` to the worker and the web door.

3. Record the rotation and restart, so new payloads go under `k2`:

	docker compose run --rm worker aliquot keys rotate
	docker compose up -d worker web

4. Re-encrypt what is under `k1`. It works in batches and each batch commits on its own, so a stopped run picks up where it stopped and a second run finds nothing to do:

	docker compose exec worker aliquot keys reencrypt
	docker compose exec worker aliquot keys status

   `keys status` prints each key id, its env var, whether this process holds it, how many payloads it holds, and how many wait to move. When `k1` holds 0, remove `k1` from `[store.keys]`, delete `LABH_PAYLOAD_KEY` from `.env`, restart, and take a new backup.

What a rotation does not do. It does not re-key the address key, the keyed hash that stops anyone from confirming a guessed body (a participant id) against a payload's hash: whoever held the old key can still compute addresses, though not read bodies under the new key. And the old ciphertext is not gone at once: Postgres keeps it in dead rows until `VACUUM` reclaims them and in WAL segments until they are recycled, and every backup taken before the re-encrypt still holds it under the old key. If the old key is the reason for the rotation, run `docker compose exec postgres vacuumdb -U postgres -d labh --full` after the re-encrypt, and destroy or re-take older backups as the lab's policy allows.

To keep D3 under its own key, add `k3 = "LABH_PAYLOAD_KEY_3"` to `[store.keys]` and a `[store.class_keys]` table with `D3 = "k3"`, then run `keys reencrypt` to move D3 payloads already stored. A process that is not given `LABH_PAYLOAD_KEY_3` cannot read D3 bodies: its record pages list them as unavailable, encrypted under `k3`, and every chain still verifies. A process holding a key under an id the lab already knows, but with a different value, refuses to start.

## Retention

Set how long payload bodies are kept per data class in `[policy.retention]`. `keep_min_days` is the floor your records rules set (for example UW-Madison's seven years after close-out, HIPAA's six years for documentation, three years for IRB records). `purge_payload_after_days` is when a run's bodies are redacted. A class's own table overrides the lab-wide keys:

	[policy.retention]
	keep_min_days = 2555
	[policy.retention.D3]
	keep_min_days = 1095
	purge_payload_after_days = 1095

A class with no purge is kept. Aliquot refuses to start with a purge shorter than the same class's floor, and the sweep never redacts a body under the floor.

	docker compose exec worker aliquot retention --dry-run      # lists each run past the window; changes nothing
	docker compose exec worker aliquot retention --apply

`--apply` deletes each body whose newest run is past its class's window, and clears the web door's copy of that run's reply. Each body keeps a tombstone: its hash, class, size, when it was redacted and why. Events and their hashes stay, so every record still verifies, and `--apply` checks each chain it touched. The record page shows the body as "Redacted on <date> by the lab's retention window", with its hash. Each `--apply` writes an audit event, even when nothing was past the window, and running it twice redacts nothing the second time. `--dry-run --as-of YYYY-MM-DD` shows what a sweep on a later date would take; `--apply` refuses `--as-of` and always judges the window as of today. A question asked again after its body was redacted is stored again under the current key, and the record page then shows that body as stored. Run `--apply` from cron or a systemd timer at whatever cadence the lab's policy names.

## Upgrade

	git fetch --tags
	scripts/backup.sh
	git checkout v0.5.1
	docker compose up -d --build

Each release is a tag; this builds `aliquot-app:0.5.1`. New core and studio migrations apply on start, each once, under a lock.

## Check an install

`scripts/compose-check.sh` runs the whole path in a separate Compose project, `aliquot-check`, with scripted fake models in place of a real one. It brings the stack up and compiles the synthetic lab0 handbook. It asks a pre-registered question and requires an answer that cites the expected entry, an intact hash chain and a stored answer that decrypts. It reads a LaTeX PDF and a Word PDF in the sandbox and requires a scanned page to fail. Then it backs up, wipes the database volume, restores and requires the same run to verify again. It prints PASS or FAIL for each step and removes its project at the end (`--keep` leaves it running). CI runs it on a clean Ubuntu runner.
