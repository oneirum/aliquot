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

test("[lab] name is what the pages show as the lab; without it the web door shows the hostname", () => {
  assert.equal(parseConfig(`${base}[lab]\nname = " Mettu Lab "\n`, "/l/lab.toml").labName, "Mettu Lab");
  assert.equal(parseConfig(base, "/l/lab.toml").labName, null);
  assert.throws(() => parseConfig(`${base}[lab]\nname = ""\n`, "/l/lab.toml"));
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

const acp = '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "ALIQUOT_ACP_TOKEN"\n';
const web = { id: "web", kind: "web", placement: "lab", port: 3000, baseUrl: "http://localhost:3000", channel: null };

test("[surfaces.<id>] lists every surface, web included; without [surfaces.web] web is lab on port 3000", () => {
  assert.deepEqual(parseConfig(base, "/l/lab.toml").surfaces, [web]);
  const c = parseConfig(`${base}${acp}`, "/l/lab.toml");
  assert.deepEqual(c.surfaces, [web, { id: "acp", kind: "acp", placement: "zdr", tokenEnv: "ALIQUOT_ACP_TOKEN" }]);
  assert.equal(c.surfaces[0], c.web);
  const own = parseConfig(`${base}[surfaces.web]\nplacement = "institution"\nport = 8080\nbase_url = "https://aliquot.lab.edu"\nchannel = "flow"\n`, "/l/lab.toml");
  assert.deepEqual(own.web, { id: "web", kind: "web", placement: "institution", port: 8080, baseUrl: "https://aliquot.lab.edu", channel: "flow" });
  assert.equal(parseConfig(`${base}[surfaces.web]\nkind = "web"\n`, "/l/lab.toml").web.kind, "web");
});

test("each surface rule refuses its entry with one line naming the surface", () => {
  const refused: [string, string, RegExp][] = [
    ["an id with a capital", '[surfaces.Acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.Acp\] .*lowercase/],
    ["an id with a colon, which would split the run key", '[surfaces."a:b"]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.a:b\] /],
    ["a non-web surface without kind", '[surfaces.acp]\nplacement = "zdr"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.acp\] .*kind/],
    ["a kind Aliquot does not know", '[surfaces.teams]\nkind = "teams"\nplacement = "zdr"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.teams\] .*kind/],
    ["kind web at another id", '[surfaces.door2]\nkind = "web"\nplacement = "lab"\n', /^lab\.toml: \[surfaces\.door2\] .*web/],
    ["another kind at id web", '[surfaces.web]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.web\] .*web/],
    ["token_env on web, which the door would ignore", '[surfaces.web]\nplacement = "lab"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.web\] .*token_env/],
    ["an unknown key on web", "[surfaces.web]\nports = 3000\n", /^lab\.toml: \[surfaces\.web\] .*ports/],
    ["a non-web surface without token_env", '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\n', /^lab\.toml: \[surfaces\.acp\] .*token_env/],
    ["a non-web surface without placement", '[surfaces.acp]\nkind = "acp"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.acp\] .*placement/],
    ["a web-only key on a non-web surface", '[surfaces.acp]\nkind = "acp"\nplacement = "zdr"\ntoken_env = "T"\nport = 3001\n', /^lab\.toml: \[surfaces\.acp\] .*port/],
    ["slack in lab", '[surfaces.slack]\nkind = "slack"\nplacement = "lab"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.slack\] .*Slack/],
    ["slack at institution", '[surfaces.slack]\nkind = "slack"\nplacement = "institution"\ntoken_env = "T"\n', /^lab\.toml: \[surfaces\.slack\] .*Slack/],
    ["two surfaces naming one token_env", `${acp}[surfaces.phone]\nkind = "phone"\nplacement = "zdr"\ntoken_env = "ALIQUOT_ACP_TOKEN"\n`, /^lab\.toml: \[surfaces\.phone\] .*ALIQUOT_ACP_TOKEN.*acp/],
  ];
  for (const [what, toml, message] of refused) {
    assert.throws(() => parseConfig(`${base}${toml}`, "/l/lab.toml"), (err: Error) => message.test(err.message) && !err.message.includes("\n"), what);
  }
  const slack = parseConfig(`${base}[surfaces.slack]\nkind = "slack"\nplacement = "approved"\ntoken_env = "SLACK_TOKEN"\n`, "/l/lab.toml");
  assert.deepEqual(slack.surfaces.at(-1), { id: "slack", kind: "slack", placement: "approved", tokenEnv: "SLACK_TOKEN" });
});

test("a channel floor may name any surface id, digits and dashes included", () => {
  assert.deepEqual(parseConfig(`${base}[channel_floors]\n"acp-2:lab" = "D2"\n`, "/l/lab.toml").channelFloors, { "acp-2:lab": "D2" });
});

test("lab.example.toml serves acp at zdr, and its commented slack surface parses once uncommented", () => {
  const path = fileURLToPath(new URL("../lab.example.toml", import.meta.url));
  const text = readFileSync(path, "utf8");
  assert.deepEqual(parseConfig(text, path).surfaces.find((s) => s.id === "acp"), { id: "acp", kind: "acp", placement: "zdr", tokenEnv: "ALIQUOT_ACP_TOKEN" });
  const at = text.indexOf("# [surfaces.slack]");
  const end = text.indexOf("\n\n", at);
  const slack = `${text.slice(0, at)}${text.slice(at, end).replace(/^# ((?:\[|[a-z_]+ = ).*)$/gm, "$1")}${text.slice(end)}`;
  assert.deepEqual(parseConfig(slack, path).surfaces.find((s) => s.id === "slack"), { id: "slack", kind: "slack", placement: "approved", tokenEnv: "ALIQUOT_SLACK_TOKEN" });
});

test("lab.example.toml's OpenRouter block parses once uncommented and routes Claude only to the providers with zero-retention Claude endpoints", () => {
  const path = fileURLToPath(new URL("../lab.example.toml", import.meta.url));
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("# [endpoints.openrouter]");
  const end = text.indexOf("\n\n", start);
  const block = text.slice(start, end).replace(/^# ((?:\[|[a-z_]+ = ).*)$/gm, "$1");
  const openrouter = parseConfig(`${text.slice(0, start)}${block}${text.slice(end)}`, path).endpoints.find((e) => e.id === "openrouter");
  assert.equal(openrouter?.placement, "zdr");
  assert.deepEqual(openrouter?.providerRouting, { zdr: true, data_collection: "deny", allow_fallbacks: false, only: ["amazon-bedrock", "google-vertex"] });
});

test("[store] key_env is the one-key form: key k1, current; without it the key is LABH_PAYLOAD_KEY", () => {
  const keys = (toml: string) => {
    const { keyEnvs, current, classKeys } = parseConfig(`${base}${toml}`, "/l/lab.toml").store;
    return { keyEnvs, current, classKeys };
  };
  assert.deepEqual(keys(""), { keyEnvs: { k1: "LABH_PAYLOAD_KEY" }, current: "k1", classKeys: {} });
  assert.deepEqual(keys('[store]\nkey_env = "LAB_KEY"\n'), { keyEnvs: { k1: "LAB_KEY" }, current: "k1", classKeys: {} });
  assert.deepEqual(keys('[store]\ncurrent = "k2"\n[store.keys]\nk1 = "LABH_PAYLOAD_KEY"\nk2 = "LABH_PAYLOAD_KEY_2"\nk3 = "LABH_PAYLOAD_KEY_3"\n[store.class_keys]\nD3 = "k3"\n'), {
    keyEnvs: { k1: "LABH_PAYLOAD_KEY", k2: "LABH_PAYLOAD_KEY_2", k3: "LABH_PAYLOAD_KEY_3" },
    current: "k2",
    classKeys: { D3: "k3" },
  });
});

test("each [store] key rule refuses with one line", () => {
  const refuse = (toml: string, why: RegExp) => assert.throws(() => parseConfig(`${base}[store]\n${toml}`, "/l/lab.toml"), why);
  refuse('key_env = "A"\n[store.keys]\nk1 = "A"\n', /names both key_env and \[store.keys\]/);
  refuse('[store.keys]\nk1 = "A"\nk2 = "B"\n', /current is missing: name which of k1, k2 new payloads go under/);
  refuse('current = "k9"\n[store.keys]\nk1 = "A"\n', /current = "k9" is not a key in \[store.keys\]/);
  refuse('[store.keys]\nk1 = "A"\n[store.class_keys]\nD3 = "k3"\n', /class_keys D3 = "k3" is not a key/);
  refuse('current = "k1"\n[store.keys]\nk1 = "A"\nk2 = "A"\n', /keys k1 and k2 both read A/);
  refuse('[store.keys]\n"K 1" = "A"\n', /a key id is lowercase letters/);
  refuse('currrent = "k1"\n', /currrent/);
});

test("[policy] retention_days is one number for every class or days per class; without it nothing is redacted", () => {
  const days = (toml: string) => parseConfig(`${base}[policy]\n${toml}`, "/l/lab.toml").retentionDays;
  assert.deepEqual(days(""), {});
  assert.deepEqual(days("retention_days = 365\n"), { D0: 365, D1: 365, D2: 365, D3: 365, R: 365 });
  assert.deepEqual(days("retention_days = { D3 = 90, D2 = 365 }\n"), { D3: 90, D2: 365 });
  assert.throws(() => days("retention_days = 0\n"));
  assert.throws(() => days("retention_days = { D9 = 1 }\n"));
});

test("lab.example.toml's commented key and retention tables parse once uncommented", () => {
  const path = fileURLToPath(new URL("../lab.example.toml", import.meta.url));
  const text = readFileSync(path, "utf8");
  const at = text.indexOf('# current = "k2"');
  const end = text.indexOf("\n\n", at);
  const keyed = `${text.slice(0, at)}${text.slice(at, end).replace(/^# ((?:\[|[A-Za-z_0-9]+ = ).*)$/gm, "$1")}${text.slice(end)}`.replace(/^key_env = .*$/m, "");
  assert.deepEqual(parseConfig(keyed, path).store, { placement: "lab", keyEnvs: { k1: "LABH_PAYLOAD_KEY", k2: "LABH_PAYLOAD_KEY_2", k3: "LABH_PAYLOAD_KEY_3" }, current: "k2", classKeys: { D3: "k3" } });
  assert.equal(parseConfig(text.replace("# retention_days = 365\n", "retention_days = 365\n"), path).retentionDays.D1, 365);
  assert.deepEqual(parseConfig(text.replace("# retention_days = 365\n", "retention_days = { D3 = 90, D2 = 365 }\n"), path).retentionDays, { D3: 90, D2: 365 });
});
