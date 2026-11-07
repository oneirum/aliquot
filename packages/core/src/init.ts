/**
 * aliquot init: the answers a lab gives, the checks its participant id patterns must pass, and the two files written
 * from them. Pure apart from the Prompt the binary passes in, so the flow reads the same on a TTY and from a pipe.
 */

import { randomBytes } from "node:crypto";
import { parseConfig } from "./config.ts";

export const OFFERED_PLACEMENTS = {
  lab: "lab hardware: up to D3",
  zdr: "a hosted vendor under zero data retention: up to D1",
  approved: "an organization contract the institution approved (a personal key is public): up to D2",
} as const;
export type OfferedPlacement = keyof typeof OFFERED_PLACEMENTS;

export interface InitAnswers {
  readonly lab: string;
  readonly baseUrl: string;
  readonly placement: OfferedPlacement;
  readonly port: number;
  readonly patterns: readonly string[];
  /** The digest docker image inspect reports, or null when run_code and PDF reading stay off. */
  readonly sandboxImage: string | null;
}

export const DEFAULTS = { lab: "our lab", baseUrl: "http://ollama:11434/v1", placement: "lab", port: 3000, patterns: ["\\bP-\\d{5}\\b"] } as const;

/** Text with no participant ids in it. A pattern that matches it would raise ordinary messages to D3. */
export const ORDINARY_TEXT = "On Tuesday 12 March the lab met in room 4 at 10:30 and agreed on the next visit.";

export const MAX_ATTEMPTS = 3;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The FAIL lines for patterns that cannot be used at all, before any sample is tried. Empty when all are usable. */
export function patternProblems(patterns: readonly string[]): string[] {
  if (!patterns.length) return ["FAIL  no pattern given"];
  const lines: string[] = [];
  patterns.forEach((p, i) => {
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch (err) {
      lines.push(`FAIL  pattern ${i + 1} does not compile: ${(err as Error).message}`);
      return;
    }
    const ordinary = ORDINARY_TEXT.match(re);
    if (re.test("")) lines.push(`FAIL  pattern ${i + 1} matches the empty string, so it would mark every message D3`);
    else if (ordinary) lines.push(`FAIL  pattern ${i + 1} matches ordinary text ("${ordinary[0]}" in "${ORDINARY_TEXT}"), so it would mark ordinary messages D3`);
  });
  return lines;
}

/** One PASS or FAIL line per sample id and a verdict. Assumes patternProblems found nothing. */
export function sampleReport(patterns: readonly string[], sample: readonly string[]): { readonly ok: boolean; readonly lines: string[] } {
  const res = patterns.map((p) => new RegExp(p));
  const width = Math.max(...sample.map((s) => s.length));
  const misses = sample.filter((s) => !res.some((re) => re.test(s))).length;
  const lines = sample.map((s) => {
    const n = res.findIndex((re) => re.test(s));
    return n < 0 ? `FAIL  ${s.padEnd(width)}  no pattern matches` : `PASS  ${s.padEnd(width)}  matched by pattern ${n + 1}`;
  });
  lines.push(misses ? `Verdict: FAIL, ${misses} of ${sample.length} sample ids matched no pattern.` : `Verdict: PASS, all ${sample.length} sample ids matched.`);
  return { ok: misses === 0, lines };
}

export function parsePort(text: string): number | null {
  const n = Number(text);
  return /^\d+$/.test(text) && n >= 1 && n <= 65535 ? n : null;
}

export function parseBaseUrl(text: string): string | null {
  try {
    return ["http:", "https:"].includes(new URL(text).protocol) ? text : null;
  } catch {
    return null;
  }
}

export function parseDigest(text: string): string | null {
  return DIGEST.test(text) ? text : null;
}

const s = (v: string) => JSON.stringify(v);

/** The env var init names as [surfaces.acp] token_env, and writes into a new .env. */
export const ACP_TOKEN_ENV = "ALIQUOT_ACP_TOKEN";
/** The env var init names as [surfaces.studio] token_env, and writes into a new .env. compose.yaml hands it to the door and the studio. */
export const STUDIO_TOKEN_ENV = "ALIQUOT_STUDIO_TOKEN";

/** Each surface token init writes into a new .env, and what a .env without it loses. */
const SURFACE_TOKENS = [
  { env: ACP_TOKEN_ENV, without: "the door takes no token for [surfaces.acp]" },
  { env: STUDIO_TOKEN_ENV, without: "the studio cannot reach the door" },
] as const;

/** lab.toml's [anchor] table, for an init that wrote an anchor key. The log path is relative to lab.toml unless absolute. */
export function anchorTable(logPath: string): string {
  return `
# Signed checkpoints of the audit stream and every run record, kept outside the database. The worker appends one line
# every every_minutes, signed with the key in the file LABH_ANCHOR_KEY_FILE names, and aliquot verify --anchors checks
# each line against the database. Ship this file to write-once storage or the SIEM as it grows.
[anchor]
path = ${s(logPath)}
every_minutes = 15
`;
}

export function renderLabToml(a: InitAnswers, anchorLog: string | null = null): string {
  // The default name is a placeholder, so it stays a comment and the pages show the hostname.
  const [labTable, labName] = a.lab === DEFAULTS.lab ? ["# [lab]", '# name = "Your Lab"'] : ["[lab]", `name = ${s(a.lab)}`];
  const text = `# lab.toml for ${a.lab.replace(/[\r\n]/g, " ")}, written by aliquot init.
# Every outbound destination has a placement, and the placement alone decides which data classes may go there.
# D0 is public, D1 internal, D2 confidential, D3 restricted (participant data). lab.example.toml lists every option.

[database]
url_env = "DATABASE_URL"            # docker compose builds this URL from POSTGRES_PASSWORD in .env

[store]
placement = "lab"                   # Postgres runs on lab hardware, so it may hold D3
key_env = "LABH_PAYLOAD_KEY"        # the key in .env that encrypts every stored payload; keep a copy offline

[endpoints.local]
base_url = ${s(a.baseUrl)}
placement = ${s(a.placement)}${" ".repeat(Math.max(1, 26 - a.placement.length))}# ${OFFERED_PLACEMENTS[a.placement]}
# Add api_key_env = "NAME" when this endpoint needs a key; the key itself goes in the environment, never here.

${labTable}
${`${labName} `.padEnd(36)}# shown at the top of the chat and record pages; unset shows the hostname

[surfaces.web]
placement = "lab"
port = ${a.port}                        # the web door, on this machine only until sign-on lands

# aliquot acp for T3 Code and other ACP clients. T3 Code keeps a copy of every thread, so the door shows this surface
# D1 at most and withholds anything above it with the record link only. The client sets ALIQUOT_SURFACE_TOKEN to this token.
[surfaces.acp]
kind = "acp"
placement = "zdr"
token_env = "${ACP_TOKEN_ENV}"      # the token is in .env, never here

# The studio holds no payload key: it sends every read and write of core to the door with this surface's token, and
# its test threads are answered here.
[surfaces.studio]
kind = "studio"
placement = "lab"
token_env = "${STUDIO_TOKEN_ENV}"

[hosts]
"api.openalex.org" = "public"        # the literature tools; each reaches only the hosts it names, and only with D0 text
"eutils.ncbi.nlm.nih.gov" = "public"
"export.arxiv.org" = "public"
"www.ebi.ac.uk" = "public"
"api.crossref.org" = "public"
"api.unpaywall.org" = "public"

[research]
contact_email_env = "LABH_CONTACT_EMAIL"   # the lab's contact email, sent to OpenAlex, Crossref and NCBI as their polite pool asks

[policy]
review_confidential = "refuse"
# Any text that matches one of these regular expressions is D3, whatever channel it came from. Checked by aliquot init
# against a sample of real ids and against ordinary text.
participant_id_patterns = [${a.patterns.map(s).join(", ")}]
${
  a.sandboxImage
    ? `
# The no-network container that runs run_code and reads PDF sources, pinned by the digest of the image built from
# sandbox/ (docker build -t aliquot-sandbox sandbox).
[sandbox]
image = ${s(a.sandboxImage)}
`
    : `
# run_code and PDF reading are off. To turn them on, build the container (docker build -t aliquot-sandbox sandbox) and
# add its digest (docker image inspect --format '{{.Id}}' aliquot-sandbox):
# [sandbox]
# image = "sha256:<64 hex>"
`
}${anchorLog === null ? "" : anchorTable(anchorLog)}`;
  parseConfig(text, "/lab.toml");
  return text;
}

export function renderEnv(sandbox: boolean, random: (n: number) => Buffer = randomBytes): string {
  const secrets = `# Secrets for docker compose, written by aliquot init. Never commit this file or rewrite it.
# LABH_PAYLOAD_KEY encrypts every stored payload: without it they cannot be read, so keep a copy offline.
POSTGRES_PASSWORD=${random(24).toString("hex")}
LABH_PAYLOAD_KEY=${random(32).toString("hex")}
PAYLOAD_SECRET=${random(32).toString("hex")}
# ${ACP_TOKEN_ENV} is the bearer token aliquot acp sends as ALIQUOT_SURFACE_TOKEN; the door serves [surfaces.acp] to it.
${ACP_TOKEN_ENV}=${random(32).toString("hex")}
# ${STUDIO_TOKEN_ENV} is the studio's token for the door's /studio routes, in place of the payload key.
${STUDIO_TOKEN_ENV}=${random(32).toString("hex")}
`;
  if (!sandbox) return secrets;
  return `${secrets}
# lab.toml turns the sandbox on, so the worker gets the Docker socket through compose.sandbox.yaml.
COMPOSE_FILE=compose.yaml:compose.sandbox.yaml
# The socket's group on this host. 0 suits Docker Desktop; on Linux set the number this prints:
#   docker run --rm -v /var/run/docker.sock:/s busybox stat -c %g /s
DOCKER_GID=0
`;
}

/** Asks one question and resolves to the answer line, or null when input has ended. */
export type Prompt = (question: string) => Promise<string | null>;

export class InitAborted extends Error {}

async function askValid<T>(ask: Prompt, out: (line: string) => void, question: string, fallback: string | null, parse: (text: string) => T | null, hint: string): Promise<T> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const raw = await ask(fallback === null ? `${question}: ` : `${question} [${fallback}]: `);
    const text = (raw ?? "").trim() || fallback;
    const value = text === null ? null : parse(text);
    if (value !== null) return value;
    if (raw === null) break;
    out(`${hint} Try again.`);
  }
  throw new InitAborted(`no valid answer to "${question}". Nothing was written.`);
}

async function askLines(ask: Prompt, question: string): Promise<string[] | null> {
  const lines: string[] = [];
  for (let line = await ask(question); line !== null && line.trim() !== ""; line = await ask("")) lines.push(line.trim());
  return lines;
}

/** The whole interactive flow. Throws InitAborted when an answer never becomes valid; then nothing is written. */
export async function askAnswers(ask: Prompt, out: (line: string) => void): Promise<InitAnswers> {
  const lab = await askValid(ask, out, "Lab name (shown at the top of the chat and record pages)", DEFAULTS.lab, (t) => t, "");
  const baseUrl = await askValid(ask, out, "Where the local model runs (Ollama, vLLM or any OpenAI-compatible URL)", DEFAULTS.baseUrl, parseBaseUrl, "That is not an http or https URL.");
  out("Where that endpoint is placed decides the highest data class it may receive:");
  for (const [p, line] of Object.entries(OFFERED_PLACEMENTS)) out(`  ${p.padEnd(8)} ${line}`);
  const placement = await askValid(ask, out, "Placement", DEFAULTS.placement, (t) => (t in OFFERED_PLACEMENTS ? (t as OfferedPlacement) : null), "Answer lab, zdr or approved.");
  const port = await askValid(ask, out, "Web door port", String(DEFAULTS.port), parsePort, "A port is a whole number from 1 to 65535.");

  let sample: string[] | null = null;
  let patterns: readonly string[] | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && patterns === null; attempt++) {
    const given = await askLines(ask, `Participant id patterns, one regular expression per line, then an empty line [${DEFAULTS.patterns.join(" ")}]: `);
    const tried = given?.length ? given : DEFAULTS.patterns;
    const problems = patternProblems(tried);
    if (problems.length) {
      problems.forEach(out);
      out("A pattern must match participant ids and nothing else.");
      continue;
    }
    while (!sample?.length) {
      sample = await askLines(ask, "Paste a few real participant ids, one per line, then an empty line: ");
      if (!sample?.length) {
        if (sample === null) throw new InitAborted("no sample ids were given. Nothing was written.");
        out("Paste at least one id to test the patterns against.");
      }
    }
    const report = sampleReport(tried, sample);
    report.lines.forEach(out);
    if (report.ok) patterns = tried;
    else out("Some ids would not be marked D3. Enter the patterns again.");
  }
  if (patterns === null) throw new InitAborted(`no pattern passed after ${MAX_ATTEMPTS} attempts. Nothing was written.`);

  const sandbox = await askValid(ask, out, "Turn on run_code and PDF reading in the sandbox container? (y/n)", "n", (t) => (/^y(es)?$/i.test(t) ? true : /^no?$/i.test(t) ? false : null), "Answer y or n.");
  let sandboxImage: string | null = null;
  if (sandbox) {
    out("Build it with: docker build -t aliquot-sandbox sandbox");
    out("Then paste what this prints: docker image inspect --format '{{.Id}}' aliquot-sandbox");
    sandboxImage = await askValid(ask, out, "Sandbox image id", null, parseDigest, "An image id is sha256: followed by 64 hex characters.");
  }
  return { lab, baseUrl, placement, port, patterns, sandboxImage };
}

/** --yes: every default, with the patterns and sample from the flags. Returns the report lines and the answers, or null answers on FAIL. */
export function defaultAnswers(patterns: readonly string[], sample: readonly string[]): { readonly lines: string[]; readonly answers: InitAnswers | null } {
  const tried = patterns.length ? patterns : DEFAULTS.patterns;
  const problems = patternProblems(tried);
  if (problems.length) return { lines: problems, answers: null };
  const report = sampleReport(tried, sample);
  return { lines: report.lines, answers: report.ok ? { ...DEFAULTS, patterns: tried, sandboxImage: null } : null };
}

/** For a .env init leaves as it is: a line for each surface token it lacks, saying how to add it. Never a secret. */
export function surfaceTokenHints(envText: string, envPath: string): string[] {
  return SURFACE_TOKENS.filter((t) => !new RegExp(`^${t.env}=.`, "m").test(envText)).map(
    (t) => `${envPath} has no ${t.env}, so ${t.without}. Add one: echo "${t.env}=$(openssl rand -hex 32)" >> ${envPath}`,
  );
}
