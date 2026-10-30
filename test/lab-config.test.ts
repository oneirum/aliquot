import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contactFromEnv, parseConfig } from "../packages/core/src/config.ts";

const base = '[endpoints.local]\nbase_url = "http://127.0.0.1:11434/v1"\nplacement = "lab"\n';
const digest = "a".repeat(64);

test("lab.toml declares datasets, the sandbox and the contact env var", () => {
  const c = parseConfig(
    `${base}[datasets.cohort-2024]\npath = "/srv/lab/data/cohort-2024/"\nclass = "D2"\ndescription = "Synthetic cohort"\n[sandbox]\nimage = "aliquot-sandbox@sha256:${digest}"\nmemory_mb = 512\n[research]\ncontact_email_env = "LABH_CONTACT_EMAIL"\n`,
    "/l/lab.toml",
  );
  assert.deepEqual(
    { datasets: c.datasets, sandbox: c.sandbox, contactEmailEnv: c.contactEmailEnv },
    {
      datasets: [{ id: "cohort-2024", path: "/srv/lab/data/cohort-2024", cls: "D2", description: "Synthetic cohort" }],
      sandbox: { image: `aliquot-sandbox@sha256:${digest}`, digest, cpus: 1, memoryMb: 512, timeoutMs: 60000, socket: "/var/run/docker.sock" },
      contactEmailEnv: "LABH_CONTACT_EMAIL",
    },
  );
  assert.equal(contactFromEnv(c, { LABH_CONTACT_EMAIL: "lab@example.edu" }), "lab@example.edu");
  assert.equal(contactFromEnv(c, {}), null);
});

test("without those tables nothing mounts and no contact is sent", () => {
  const c = parseConfig(base, "/l/lab.toml");
  assert.deepEqual({ datasets: c.datasets, sandbox: c.sandbox, contact: contactFromEnv(c, { LABH_CONTACT_EMAIL: "x@y" }) }, { datasets: [], sandbox: null, contact: null });
});

test("a [tools] table is refused, with or without a dir, because Aliquot loads no contributed tool folder", () => {
  const message = "lab.toml has a [tools] table, but Aliquot does not load contributed tools yet. Remove [tools]: Aliquot runs only its built-in tools.";
  assert.throws(() => parseConfig(`${base}[tools]\ndir = "tools"\n`, "/l/lab.toml"), { message });
  assert.throws(() => parseConfig(`${base}[tools]\n`, "/l/lab.toml"), { message });
});

test("the sandbox image must be pinned by digest, and a dataset path must be absolute", () => {
  assert.throws(() => parseConfig(`${base}[sandbox]\nimage = "aliquot-sandbox:latest"\n`, "/l/lab.toml"), /pinned by digest/);
  assert.equal(parseConfig(`${base}[sandbox]\nimage = "sha256:${digest}"\n`, "/l/lab.toml").sandbox?.digest, digest);
  assert.throws(() => parseConfig(`${base}[datasets.x]\npath = "data/x"\nclass = "D1"\ndescription = "x"\n`, "/l/lab.toml"), /absolute/);
  assert.throws(() => parseConfig(`${base}[datasets."../x"]\npath = "/d"\nclass = "D1"\ndescription = "x"\n`, "/l/lab.toml"), /dataset id/);
});

test("lab.example.toml names the literature hosts and the contact env var, and its commented datasets and sandbox parse once uncommented", () => {
  const path = fileURLToPath(new URL("../lab.example.toml", import.meta.url));
  const text = readFileSync(path, "utf8");
  const asIs = parseConfig(text, path);
  assert.deepEqual({ hosts: asIs.hosts, contactEmailEnv: asIs.contactEmailEnv, datasets: asIs.datasets, sandbox: asIs.sandbox }, { hosts: { "api.openalex.org": "public", "eutils.ncbi.nlm.nih.gov": "public", "export.arxiv.org": "public", "www.ebi.ac.uk": "public", "api.crossref.org": "public", "api.unpaywall.org": "public" }, contactEmailEnv: "LABH_CONTACT_EMAIL", datasets: [], sandbox: null });
  const block = text.slice(text.indexOf("# [datasets."));
  const uncommented = block.replace(/^# ((?:\[|[a-z_]+ = ).*)$/gm, "$1").replace("<64 hex>", digest);
  const c = parseConfig(`${text.slice(0, text.indexOf("# [datasets."))}${uncommented}`, path);
  assert.deepEqual(c.datasets, [{ id: "cohort-2024", path: "/srv/lab/data/cohort-2024", cls: "D2", description: "Wave 1 survey export, one row per participant" }]);
  assert.deepEqual(c.sandbox, { image: `aliquot-sandbox@sha256:${digest}`, digest, cpus: 1, memoryMb: 1024, timeoutMs: 60000, socket: "/var/run/docker.sock" });
});
