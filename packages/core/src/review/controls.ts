/**
 * The security review pack: one row per control a campus reviewer asks about, with what Aliquot does toward it, its
 * status for one lab.toml, and the tests that prove a `met`. The status is a function of the parsed config, so a
 * deployment change moves the rows that depend on it and nobody edits prose. The pack says what Aliquot does toward
 * each control; it never says a deployment is compliant.
 *
 * HECVAT rows name a question area in our own words. The questionnaire's text is EDUCAUSE's and is not copied here.
 */

import type { LabConfig } from "../config.ts";
import type { Placement } from "../dataclass.ts";

export const STATUSES = ["not-met", "partly", "met", "lab-responsibility"] as const;
export type Status = (typeof STATUSES)[number];

export const FRAMEWORKS = ["hipaa", "800-171r3", "hecvat"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** `<file under test/>: <exact test name>`, as `node --test` reports it. test/review-pack.test.ts runs each one. */
export type TestId = `${string}.test.ts: ${string}`;

export type ReviewConfig = LabConfig;

/** Rotation is declared when [store.keys] names more than one key, or a class has its own. */
const keyRotation = (c: ReviewConfig) => Object.keys(c.store.keyEnvs).length > 1 || Object.keys(c.store.classKeys).length > 0;
/** Retention is declared when [policy.retention] sets a purge window for at least one class. */
const retention = (c: ReviewConfig) => Object.keys(c.retention.purgeDays).length > 0;

export interface Assessment {
  readonly status: Status;
  /** What this lab.toml makes true for the row, in one sentence. */
  readonly why: string;
}

export interface Control {
  readonly id: string;
  readonly framework: Framework;
  readonly title: string;
  /** What Aliquot does toward the control, whatever the deployment. */
  readonly does: string;
  readonly assess: (c: ReviewConfig) => Assessment;
  /** The tests that prove the mechanism. A row that assesses met must name at least one. */
  readonly tests: readonly TestId[];
}

const ON_PREMISES: readonly Placement[] = ["lab", "institution"];

interface Destination {
  readonly what: string;
  readonly placement: Placement;
}

/** Every model, agent CLI and chat surface that sits outside the lab and the institution. */
function hostedDestinations(c: LabConfig): readonly Destination[] {
  return [
    ...c.endpoints.map((e) => ({ what: `endpoint ${e.id}`, placement: e.placement })),
    ...c.agentBackends.map((b) => ({ what: `agent backend ${b.id}`, placement: b.placement })),
    ...c.surfaces.map((s) => ({ what: `surface ${s.id}`, placement: s.placement })),
  ].filter((d) => !ON_PREMISES.includes(d.placement));
}

function hostedModels(c: LabConfig): readonly Destination[] {
  return hostedDestinations(c).filter((d) => !d.what.startsWith("surface "));
}

function list(ds: readonly Destination[]): string {
  return ds.map((d) => `${d.what} (${d.placement})`).join(", ");
}

const fixed =
  (status: Status, why: string) =>
  (): Assessment => ({ status, why });

const lab = (why: string) => fixed("lab-responsibility", why);

function signOn(c: ReviewConfig, landed: Assessment, missing: Assessment): Assessment {
  return c.signOn ? landed : missing;
}

/** A trust-layer row reads met only once the tests that prove it are cited on the row. */
const UNPROVEN = "It reads met once the tests that prove it are cited here.";

const NO_SIGN_ON = "No [auth] in lab.toml, so the web door knows surfaces, not members, and listens on 127.0.0.1.";

const T = {
  egressTable: "dataclass.test.ts: decideEgress follows the placement table for every class, kind and placement",
  unlistedHost: "dataclass.test.ts: placementOfHost fails closed to public for unlisted hosts",
  forgedLabel: "dataclass.test.ts: a forged label is refused at the egress decision and by derive, however it was forged",
  rDefault: "dataclass.test.ts: R is refused everywhere by default and only reaches lab model, store and chat under lab-only",
  d3ToZdr: "gateway.test.ts: D3 to a zdr endpoint is refused before any request leaves",
  noRedirect: "gateway.test.ts: a provider request refuses a redirect, so neither the prompt nor the key reaches the other origin",
  hostList: "tools.test.ts: ctx.fetch refuses undeclared hosts and classes above the host placement, and reaches declared lab hosts",
  redirectHop: "tools.test.ts: each redirect hop is checked against the egress list and decideEgress, and journaled when followed",
  builtinTools: "tools.test.ts: core holds the twelve built-in tools, each with the hosts it may reach",
  toolsRefused: "lab-config.test.ts: a [tools] table is refused, with or without a dir, because Aliquot loads no contributed tool folder",
  boundaries: "boundaries.test.ts: the checked-out sources reach the network, load code, decide egress, brand and stamp only where allowed",
  seal: "seal.test.ts: a sealed process under the permission model refuses every runtime route and still reaches Postgres",
  studioNoKey: "boundaries.test.ts: the studio reads no payload key: nothing its entry loads calls or declares a key reader, and no studio file names the key",
  contentAddress: "record.test.ts: a content address is the HMAC of the class and the plaintext under an HKDF address subkey, so a hash alone confirms nothing",
  storeRoundTrip: "record.test.ts: payload store round-trips a body, dedupes by content within a class and refuses what the DB placement may not hold",
  storeForged: "record.test.ts: the store refuses a forged label, whether parsed from JSON or built on the prototype",
  verifyChain: "record.test.ts: verifyChain finds the first tampered, reordered or misclassed event",
  eventsAppendOnly: "record.test.ts: run_events refuses updates and deletes at the database level",
  payloadRowsFixed: "record.test.ts: payloads rows allow only a redaction, a key rewrap and a refill of a redacted row; the class and the address never change",
  versionsAppendOnly: "record.test.ts: agent_versions refuses updates and deletes at the database level",
  chainAnchoredOnJob: "record.test.ts: the chain head is anchored on the job and a resume refuses a record that does not match it",
  auditChain: "audit.test.ts: concurrent appends form one unbroken chain, and an edited row breaks it",
  auditRefusal: "audit.test.ts: a refused out-of-run gateway call lands in the audit stream, and no request leaves",
  recordView: "record-view.test.ts: the record view names the agent, the outcome, an intact chain and what each refusal refused",
  recordViewBroken: "record-view.test.ts: an edited event shows as a broken chain at that event, in the view and in the terminal text",
  runsPage: "web.test.ts: the runs page lists the newest runs, counts each filter on its tab, and shows only those with a refusal or only the failed ones when asked",
  verifyOnPage: "webapp.test.ts: Verify walks a run's chain to the door's verdict, and an edited or shortened record reads as broken in words and shape",
  publishRoles: "publish.test.ts: members and authors cannot publish, a publisher publishes below D3, and D3 needs the data steward or the PI",
  publishNoLowering: "publish.test.ts: a publisher cannot take a restricted head by lowering the ceiling, or bind a channel a restricted head serves",
  publishAudit: "publish.test.ts: publish moves the head and appends one audit row; republishing an edit makes a new version and leaves the old row as it was",
  toolVersion: "tools.test.ts: a builtin tool's version is the hash of its spec, so editing the description moves every agent that uses it",
  surfaceCeiling: "surfaces.test.ts: an answer above the acp surface's placement leaves the door as the record link only, on the wire and through aliquot ask",
  surface401: "surfaces.test.ts: a request that tries to authenticate and fails is a 401 on every route, and never falls back to web",
  surfaceOwnRuns: "surfaces.test.ts: a surface reads and stops only its own runs: an acp token on a web run, or no token on an acp run, is 404",
  surfaceTokenClash: "surfaces.test.ts: two surfaces given the same token value stop the door before it listens",
  studioRoutes: "studio-door.test.ts: only the studio's token reaches the /studio routes, and it reaches nothing else",
  studioPreview: "studio-door.test.ts: an entry preview is for authors and above and below D3 only: the studio is never shown a D3 entry",
  slackCeiling: "slack.test.ts: an answer above the slack surface's placement posts the record link and nothing of the answer",
  gateRefuses: "gate.test.ts: gate admits members with the message class and refuses strangers and review-confidential content",
  gateRaises: "gate.test.ts: classifyText raises to the highest detection and never below the floor",
  initPatterns: "aliquot-init.test.ts: a pattern that matches ordinary text, the empty string or does not compile is refused, and three refusals write nothing",
  initSecrets: "aliquot-init.test.ts: init on defaults writes a lab.toml that loads and a .env with four fresh secrets, mode 600",
  oauthPublicOnly: "agent-backends.test.ts: a subscription's OAuth token (auth_env) fails to parse at any placement but public",
  cliPlacement: "agent-backends.test.ts: the parser refuses lab and institution placements for an agent backend, a login of the wrong kind, and an id an endpoint already has",
  cliOwnToolsOff: "agent-backends.test.ts: the Claude Code argv switches off its own tools and settings and names only the bridge, with the token left to the environment",
  cliWithheld: "agent-worker.test.ts: a tool result above the backend's ceiling is withheld from the CLI and the run still answers",
  cliHome: "agent-worker.test.ts: nothing in the worker's HOME reaches the CLI: the canary codeword is not in its prompt and its reads are denied",
  coveredModel: "endpoint-fields.test.ts: a zdr endpoint pinned to a Covered Model refuses at startup, whatever the id's prefix",
  sandboxNoNetwork: "run-code.test.ts: the container has no network: a TCP connect fails",
  sandboxCaps: "run-code.test.ts: the code runs with no capabilities, no new privileges, and the CPU, memory and process limits",
  sandboxPinned: "run-code.test.ts: the daemon is asked for the pinned image, so a digest it does not hold is not deployed",
  sandboxMountClass: "run-code.test.ts: the output class is the join of the question and every mounted dataset",
  bodyCap: "web.test.ts: a body over the cap is refused with 413 before it is parsed",
  badInput: "web.test.ts: malformed JSON and a non-uuid run id are clean 400s",
  dbError: "web.test.ts: a database error is logged and answered with a generic 500 that carries no database text",
  selfContained: "web.test.ts: the chat page and the record page are self-contained HTML that loads nothing from another origin",
  deepmerge: "vendor-deepmerge.test.ts: the vendored deepmerge never takes a prototype from an own __proto__ key (GHSA-gcqx-w48m-w2h4)",
  anchorCatches: "anchor.test.ts: a run event rewritten with its chain and head recomputed passes verifyChain, and the anchor catches it",
  packFresh: "review-pack.test.ts: the committed pack for deploy/check/lab.toml is what review-pack writes today",
} as const satisfies Record<string, TestId>;

const HIPAA: readonly Control[] = [
  {
    id: "hipaa-164.308(a)(1)(ii)(A)",
    framework: "hipaa",
    title: "Risk analysis",
    does: "This pack and the research IT sheet state where each data class may go and what runs where, generated from the code and the lab's lab.toml, as an input to the lab's own risk analysis.",
    assess: lab("The risk analysis itself, and the decision to accept the risks this pack lists as not met, belong to the lab and its institution."),
    tests: [],
  },
  {
    id: "hipaa-164.308(a)(1)(ii)(D)",
    framework: "hipaa",
    title: "Information system activity review",
    does: "Every run keeps a hash-chained record of each model call, tool call and refusal; publishes and role changes go to a hash-chained audit stream. The runs page filters to runs with a refusal or a failure, and each record verifies its chain in the browser.",
    assess: fixed("met", "The run record, audit stream and runs page are on in every build; reviewing them on a schedule is the lab's procedure."),
    tests: [T.verifyChain, T.auditChain, T.recordView, T.runsPage, T.verifyOnPage],
  },
  {
    id: "hipaa-164.308(a)(5)(ii)(B)",
    framework: "hipaa",
    title: "Protection from malicious software",
    does: "Aliquot runs only its built-in tools and refuses a lab.toml that asks for contributed ones. A static scanner and a runtime seal keep network access to the few files allowed it. Model-written code runs in a container with no network, a read-only root and no capabilities.",
    assess: (c) =>
      c.sandbox
        ? { status: "met", why: `run_code is enabled on image ${c.sandbox.image.slice(-19)} pinned by digest; host anti-malware stays with research IT.` }
        : { status: "met", why: "run_code is not enabled in this lab.toml, so no model-written code runs; host anti-malware stays with research IT." },
    tests: [T.toolsRefused, T.boundaries, T.seal, T.sandboxNoNetwork, T.sandboxCaps],
  },
  {
    id: "hipaa-164.308(a)(5)(ii)(C)",
    framework: "hipaa",
    title: "Log-in monitoring",
    does: "A bearer token names a surface, and a request with a wrong token is refused with a 401 on every route. Member log-ins arrive with sign-on (roadmap 0.7).",
    assess: (c) => signOn(c, { status: "partly", why: "Sign-on is declared; the identity provider records each log-in, and the door records which member asked." }, { status: "not-met", why: NO_SIGN_ON }),
    tests: [T.surface401],
  },
  {
    id: "hipaa-164.308(a)(5)(ii)(D)",
    framework: "hipaa",
    title: "Password management",
    does: "Aliquot holds no member passwords. Surface tokens and the payload key come from environment variables; aliquot init writes them fresh to a mode 600 .env.",
    assess: lab("Rules for passwords, and for the identity provider sign-on will use, are the institution's."),
    tests: [T.initSecrets],
  },
  {
    id: "hipaa-164.308(a)(5)(i)",
    framework: "hipaa",
    title: "Security awareness and training",
    does: "The chat page and the record name what was withheld and why, so a member sees each refusal where it happens.",
    assess: lab("Training members on what they may type into Aliquot and their own AI tools is the lab's."),
    tests: [],
  },
  {
    id: "hipaa-164.310(d)(1)",
    framework: "hipaa",
    title: "Device and media controls",
    does: "Payload bodies are encrypted at rest under a key held outside the database, so a copied disk or dump holds ciphertext and hashes.",
    assess: (c) => ({ status: "lab-responsibility", why: `The payload store is placed ${c.store.placement}; the disks, backups and their disposal belong to whoever runs that database.` }),
    tests: [T.storeRoundTrip],
  },
  {
    id: "hipaa-164.312(a)(2)(i)",
    framework: "hipaa",
    title: "Unique user identification",
    does: "Each run names the surface it came from. Naming the member who asked, from the university's sign-on, arrives in roadmap 0.7.",
    assess: (c) => signOn(c, { status: "partly", why: "Sign-on is declared, so each run names the member the identity provider vouched for. " + UNPROVEN }, { status: "not-met", why: NO_SIGN_ON }),
    tests: [],
  },
  {
    id: "hipaa-164.312(a)(2)(ii)",
    framework: "hipaa",
    title: "Emergency access procedure",
    does: "Records and payloads live in the lab's Postgres, so the lab's database administrator can reach them without Aliquot running.",
    assess: lab("The procedure, and who holds the payload key in an emergency, are the lab's."),
    tests: [],
  },
  {
    id: "hipaa-164.312(a)(2)(iii)",
    framework: "hipaa",
    title: "Automatic logoff",
    does: "With [auth], a member session ends after the idle timeout or 12 hours; without it the web door has no member sessions.",
    assess: (c) => signOn(c, { status: "partly", why: "Sign-on is declared; session length follows the identity provider." }, { status: "not-met", why: NO_SIGN_ON }),
    tests: [],
  },
  {
    id: "hipaa-164.312(a)(2)(iv)",
    framework: "hipaa",
    title: "Encryption and decryption",
    does: "Every prompt, answer and tool body is stored under AES-256-GCM, addressed by an HMAC of its class and content, with both keys derived by HKDF from one master key the worker reads from the environment. The studio holds no payload key.",
    assess: fixed("met", "The payload store encrypts in every build; there is no plaintext mode."),
    tests: [T.contentAddress, T.storeRoundTrip, T.studioNoKey],
  },
  {
    id: "hipaa-164.312(b)",
    framework: "hipaa",
    title: "Audit controls",
    does: "Run records and the audit stream are append-only and hash-chained; Postgres refuses updates and deletes on them, and any edit shows as a broken chain at the event.",
    assess: fixed("met", "Recording is not configurable: every run and every publish is recorded."),
    tests: [T.verifyChain, T.eventsAppendOnly, T.auditChain, T.auditRefusal, T.recordViewBroken],
  },
  {
    id: "hipaa-164.312(c)(1)",
    framework: "hipaa",
    title: "Integrity",
    does: "Stored bodies carry a GCM tag and a content address, a payload row may change only by redaction or key rewrap, agent versions are immutable, and a resumed run refuses a record that does not match the chain head on its job.",
    assess: fixed("met", "Integrity checks run in every build."),
    tests: [T.payloadRowsFixed, T.versionsAppendOnly, T.chainAnchoredOnJob, T.storeForged],
  },
  {
    id: "hipaa-164.312(d)",
    framework: "hipaa",
    title: "Person or entity authentication",
    does: "Surfaces authenticate to the door with their own bearer tokens, kept only as hashes; the studio's token is the one credential that carries a member and a role. Members authenticate with sign-on from roadmap 0.7.",
    assess: (c) => signOn(c, { status: "partly", why: "Sign-on is declared for members, and surfaces keep their tokens. " + UNPROVEN }, { status: "partly", why: "Surfaces authenticate; members do not. " + NO_SIGN_ON }),
    tests: [T.surface401, T.surfaceOwnRuns, T.surfaceTokenClash, T.studioRoutes],
  },
  {
    id: "hipaa-164.312(e)(1)",
    framework: "hipaa",
    title: "Transmission security",
    does: "Each destination gets at most its placement's class, the gateway never follows a redirect, and the web door binds 127.0.0.1. Aliquot does not terminate TLS itself; a reverse proxy does.",
    assess: (c) => {
      const plain = hostedModels(c).filter((d) => {
        const e = c.endpoints.find((x) => `endpoint ${x.id}` === d.what);
        return e !== undefined && !e.baseUrl.startsWith("https://");
      });
      return plain.length
        ? { status: "not-met", why: `Hosted ${list(plain)} is reached over plain HTTP.` }
        : { status: "partly", why: "Every hosted endpoint is reached over HTTPS; TLS in front of the web door is the lab's reverse proxy." };
    },
    tests: [T.noRedirect, T.d3ToZdr, T.egressTable],
  },
  {
    id: "hipaa-164.316(b)(2)",
    framework: "hipaa",
    title: "Documentation: time limit, availability, updates",
    does: "This pack is generated from the code and lab.toml with `pnpm review-pack`, kept in the repository with its history, and a test fails when the committed pack no longer matches what the code says.",
    assess: fixed("partly", "Availability and updates follow the repository; keeping the lab's own policies for six years is the lab's."),
    tests: [T.packFresh],
  },
];

const NIST_TITLE = "NIST SP 800-171 Rev. 3";

const nist = (id: string, title: string, does: string, assess: Control["assess"], tests: readonly TestId[] = []): Control => ({
  id: `800-171r3-${id}`,
  framework: "800-171r3",
  title,
  does,
  assess,
  tests,
});

const NIST: readonly Control[] = [
  nist("03.01.01", "Account management", "Roles (member, author, publisher, data steward, PI) exist in the studio's accounts; door accounts arrive with sign-on.", (c) =>
    signOn(c, { status: "partly", why: "Sign-on is declared; account lifecycle follows the identity provider." }, { status: "not-met", why: NO_SIGN_ON }),
  ),
  nist("03.01.02", "Access enforcement", "Every publish and every studio route checks the member's role and the data's class in the door, and anything at D3 needs the data steward or the PI.", fixed("met", "Role and class checks run in every build."), [
    T.publishRoles,
    T.publishNoLowering,
    T.studioPreview,
  ]),
  nist(
    "03.01.03",
    "Information flow enforcement",
    "One function decides every egress against a ceiling table in code; lab.toml names a placement and nothing else, unlisted hosts count as public, and a forged label is refused.",
    fixed("met", "The ceiling table is code, so no lab.toml can raise it."),
    [T.egressTable, T.unlistedHost, T.forgedLabel, T.rDefault, T.hostList],
  ),
  nist("03.01.05", "Least privilege", "The worker runs under Node's permission model; the studio holds no payload key; a hosted agent CLI runs with its own tools off in an OS sandbox that reaches only the bridge and its vendor.", fixed("met", "These are not configurable."), [
    T.seal,
    T.studioNoKey,
    T.cliOwnToolsOff,
    T.cliHome,
  ]),
  nist("03.01.08", "Unsuccessful logon attempts", "A request with a bad token is refused with a 401 and never treated as web; lockout after repeated failures belongs to the identity provider once sign-on lands.", (c) =>
    signOn(c, { status: "lab-responsibility", why: "Sign-on is declared; lockout follows the identity provider." }, { status: "not-met", why: NO_SIGN_ON }),
  [T.surface401]),
  nist("03.01.11", "Session termination", "With [auth], a member session ends after the idle timeout or 12 hours; without it there are no member sessions.", (c) =>
    signOn(c, { status: "partly", why: "Session length follows the identity provider." }, { status: "not-met", why: NO_SIGN_ON }),
  ),
  nist("03.01.12", "Remote access", "The web door listens on 127.0.0.1; remote members reach it through whatever proxy or VPN the lab puts in front.", lab("Remote access paths are the lab's network.")),
  nist(
    "03.01.20",
    "Use of external systems",
    "Each model, host and chat surface outside the lab is held to its placement's ceiling, and a Slack surface may not claim lab or institution placement.",
    fixed("met", "Ceilings apply to every external system lab.toml names."),
    [T.egressTable, T.slackCeiling, T.surfaceCeiling],
  ),
  nist("03.02", `Awareness and training (family)`, "Refusals are shown where they happen, in the chat and the record.", lab("Training is the lab's.")),
  nist("03.03.01", "Event logging", "Every model call, tool call, refusal, stop and answer is an event in the run's record; publishes and role changes go to the audit stream.", fixed("met", "Logging is not configurable."), [T.verifyChain, T.auditRefusal]),
  nist("03.03.02", "Audit record content", "Each event carries its class label and payload references, and each answer names the hash of the agent version that gave it.", fixed("met", "Every event has the same fields."), [T.recordView]),
  nist("03.03.05", "Audit record review, analysis and reporting", "The runs page filters refused and failed runs; the record page prints for an IRB file and has Only refusals.", fixed("met", "Pages are on in every build."), [T.runsPage, T.recordView]),
  nist(
    "03.03.08",
    "Protection of audit information",
    "Postgres refuses updates and deletes on run events and agent versions, and any edit breaks the hash chain at that event. With [anchor], signed checkpoints of each chain head go to a log outside the database, so a rewrite with every later hash recomputed is caught too.",
    (c) =>
      c.anchor
        ? { status: "met", why: `Chain heads are anchored to ${c.anchor.path} every ${c.anchor.everyMinutes} minutes, under a key outside the database.` }
        : { status: "partly", why: "lab.toml declares no [anchor], so a database admin who recomputes every later hash can rewrite a record undetected." },
    [T.eventsAppendOnly, T.versionsAppendOnly, T.verifyChain, T.auditChain, T.anchorCatches],
  ),
  nist("03.04.01", "Baseline configuration", "lab.toml is the whole deployment description, parsed once at startup and refused whole on any error.", fixed("met", "This pack is computed from the lab.toml it names."), [T.toolsRefused]),
  nist("03.04.06", "Least functionality", "Eleven built-in tools, each with the hosts it may reach; no contributed tools.", fixed("met", "Tools are fixed per release."), [T.builtinTools, T.toolsRefused]),
  nist("03.04.11", "Information location", "Every destination's placement is declared in lab.toml and every data class's reach follows from it.", (c) => ({
    status: "met",
    why: `Payloads are stored at ${c.store.placement} placement; ${hostedDestinations(c).length} destination(s) sit outside the lab and institution.`,
  }), [T.egressTable]),
  nist("03.05.01", "User identification and authentication", "Surfaces are identified by token; members by sign-on from roadmap 0.7.", (c) =>
    signOn(c, { status: "partly", why: "Sign-on is declared. " + UNPROVEN }, { status: "not-met", why: NO_SIGN_ON }),
  ),
  nist("03.05.03", "Multi-factor authentication", "Aliquot will take MFA from the university's identity provider, not run its own.", (c) =>
    signOn(c, { status: "lab-responsibility", why: "MFA follows the identity provider." }, { status: "not-met", why: NO_SIGN_ON }),
  ),
  nist("03.05.12", "Authenticator management", "Surface tokens come from environment variables, the door keeps only their hashes, and two surfaces may not share one.", fixed("partly", "Rotating a token is a restart with a new value; there is no expiry."), [
    T.surfaceTokenClash,
    T.initSecrets,
  ]),
  nist("03.06", "Incident response (family)", "Each record answers what an agent saw, sent and was refused, by hash, for an incident review.", lab("The incident plan and its contacts are the lab's and the institution's.")),
  nist("03.07", "Maintenance (family)", "Aliquot is self-hosted; there is no vendor maintenance access.", lab("Maintenance of the server is research IT's.")),
  nist("03.08.01", "Media storage", "Bodies are encrypted at rest; records hold hashes and labels, not text.", (c) => ({ status: "lab-responsibility", why: `The database at ${c.store.placement} placement, its disks and backups are its operator's.` }), [T.storeRoundTrip]),
  nist("03.08.03", "Media sanitization", "Payload rows can be redacted in place without breaking the chain.", (c) =>
    retention(c) ? { status: "partly", why: "Retention is declared, so bodies past their window are redacted; disk sanitization stays with the operator." } : { status: "not-met", why: "lab.toml sets no purge window in [policy.retention], so aliquot retention redacts nothing." },
  ),
  nist("03.09", "Personnel security (family)", "Roles in the studio decide who may publish what.", lab("Screening and offboarding are the institution's.")),
  nist("03.10", "Physical protection (family)", "A lab placement means hardware the lab controls.", lab("Physical access to that hardware is the lab's.")),
  nist("03.11.02", "Vulnerability monitoring and scanning", "Dependabot opens weekly grouped dependency updates, and patched vendored code carries its advisory's test.", fixed("partly", "Dependency updates are watched; scanning the deployed host is research IT's."), [T.deepmerge]),
  nist("03.12", "Security assessment and monitoring (family)", "This pack, regenerated from the code, is the assessment input; a test fails when it drifts.", fixed("partly", "The lab's assessment and plan of action are its own."), [T.packFresh]),
  nist("03.13.01", "Boundary protection", "A static scanner and a runtime seal keep network access to the files allowed it; the gateway and tools reach only declared hosts.", fixed("met", "The seal runs in every worker."), [T.boundaries, T.seal, T.hostList, T.redirectHop]),
  nist("03.13.06", "Network communications: deny by default", "A host lab.toml does not list is public placement and gets D0 only; run_code containers have no network.", fixed("met", "Deny by default is code."), [T.unlistedHost, T.sandboxNoNetwork]),
  nist(
    "03.13.08",
    "Transmission and storage confidentiality",
    "Stored bodies are encrypted; content above a destination's ceiling is never sent to it.",
    (c) =>
      c.store.placement === "lab"
        ? { status: "met", why: "The payload store is on lab hardware, so restricted bodies are stored only there, encrypted." }
        : { status: "partly", why: `The payload store is at ${c.store.placement} placement, so encrypted bodies sit on a service the lab does not run, and D3 cannot be stored at all.` },
    [T.storeRoundTrip, T.egressTable],
  ),
  nist("03.13.10", "Cryptographic key establishment and management", "One master key from the environment, HKDF subkeys for cipher and address; payload rows already allow a key rewrap.", (c) =>
    keyRotation(c) ? { status: "partly", why: "Key rotation is declared; where the master key lives is the lab's." } : { status: "not-met", why: "lab.toml names one payload key in [store.keys], so nothing has rotated; aliquot keys rotate and reencrypt move payloads once a second key is named." },
  ),
  nist("03.13.11", "Cryptographic protection", "AES-256-GCM for bodies and HMAC-SHA256 for addresses, from Node's crypto module.", fixed("met", "Not configurable."), [T.contentAddress, T.storeRoundTrip]),
  nist("03.13.13", "Mobile code", "Pages are self-contained HTML that load nothing from another origin.", fixed("met", "Pages are built in."), [T.selfContained]),
  nist("03.14.01", "Flaw remediation", "Releases are tagged on main with a changelog naming each security fix.", lab("Applying a release on the lab's server is research IT's.")),
  nist("03.14.02", "Malicious code protection", "No contributed tools; model-written code runs in a container with no network and no capabilities, on an image pinned by digest.", (c) =>
    ({ status: "met", why: c.sandbox ? "run_code is enabled on a digest-pinned image." : "run_code is not enabled, so no model-written code runs." }),
  [T.toolsRefused, T.sandboxCaps, T.sandboxPinned]),
  nist("03.14.06", "System monitoring", "Every refusal is recorded with what it refused; refused out-of-run calls go to the audit stream.", fixed("met", "Refusals are always recorded."), [T.auditRefusal, T.recordView]),
  nist("03.14.08", "Information management and retention", "Payload rows allow redaction; records keep hashes after a body is gone.", (c) =>
    retention(c) ? { status: "partly", why: "Retention is declared; the windows themselves are the lab's policy." } : { status: "not-met", why: "lab.toml sets no purge window in [policy.retention], so every body is kept." },
  ),
  nist("03.15", "Planning (family)", "This pack and the research IT sheet feed the lab's system security plan.", lab("The plan and rules of behavior are the lab's.")),
  nist(
    "03.16.03",
    "External system services",
    "Each hosted service is named in lab.toml with a placement, and gets at most that placement's class.",
    (c) => {
      const hosted = hostedDestinations(c);
      return hosted.length ? { status: "lab-responsibility", why: `Agreements with ${list(hosted)} are the institution's.` } : { status: "met", why: "lab.toml names no model or surface outside the lab and institution." };
    },
    [T.egressTable],
  ),
  nist("03.17", "Supply chain risk management (family)", "Dependencies are pinned by lockfile, a vulnerable one is vendored with its fix, and the sandbox image is pinned by digest.", fixed("partly", "The institution's supply chain plan is its own."), [T.deepmerge, T.sandboxPinned]),
];

const hecvat = (section: string, title: string, does: string, assess: Control["assess"], tests: readonly TestId[] = []): Control => ({
  id: `hecvat-${section}`,
  framework: "hecvat",
  title,
  does,
  assess,
  tests,
});

const HECVAT: readonly Control[] = [
  hecvat("data-location", "Data: where institutional data is stored and processed", "Everything is self-hosted; lab.toml names the placement of the store and of every destination.", (c) =>
    c.store.placement === "lab"
      ? { status: "met", why: "The payload store is on lab hardware." }
      : { status: "partly", why: `The payload store is at ${c.store.placement} placement, a service outside the lab.` },
  [T.storeRoundTrip]),
  hecvat("data-classification", "Data: classification of institutional data", "Five classes (D0 to D3, and R), set at the gate before any model sees a message, only ever raised, never declassified.", (c) => ({
    status: c.participantIdPatterns.length ? "met" : "partly",
    why: c.participantIdPatterns.length ? `The lab declares ${c.participantIdPatterns.length} participant id pattern(s).` : "The lab declares no participant id patterns, so only built-in patterns raise a message to D3.",
  }), [T.gateRaises, T.gateRefuses, T.initPatterns]),
  hecvat("data-encryption", "Data: encryption at rest", "AES-256-GCM under a key held outside the database.", fixed("met", "No plaintext mode."), [T.storeRoundTrip, T.contentAddress]),
  hecvat("data-retention", "Data: retention and deletion", "Payload rows can be redacted while records keep their hashes.", (c) =>
    retention(c) ? { status: "partly", why: "Retention is declared." } : { status: "not-met", why: "lab.toml sets no purge window in [policy.retention], so every body is kept." },
  ),
  hecvat("appsec-input", "Application security: input handling and error disclosure", "Bodies over the cap are refused before parsing, malformed input is a clean 400, and a database error answers a generic 500.", fixed("met", "Built in."), [T.bodyCap, T.badInput, T.dbError]),
  hecvat("appsec-dependencies", "Application security: third-party components", "Lockfile pins, weekly dependency updates, vendored fixes with tests, and no code from another origin on the pages.", fixed("partly", "Watched, not independently audited."), [T.deepmerge, T.selfContained]),
  hecvat("appsec-testing", "Application security: security testing", "The suite plants network routes and forged labels and proves each is caught; this pack fails when it drifts from the code.", fixed("partly", "No third-party penetration test has been done."), [T.boundaries, T.forgedLabel, T.packFresh]),
  hecvat("auth-sso", "Authentication: institutional single sign-on", "Planned for roadmap 0.7; until then the door listens on 127.0.0.1.", (c) =>
    signOn(c, { status: "partly", why: "Sign-on is declared. " + UNPROVEN }, { status: "not-met", why: NO_SIGN_ON }),
  ),
  hecvat("auth-service-credentials", "Authentication: service credentials", "Every secret is named by environment variable, never in lab.toml; a personal subscription's token parses only at public placement.", fixed("met", "Enforced by the parser."), [T.oauthPublicOnly, T.initSecrets]),
  hecvat("ai-hosted-models", "AI: which models receive institutional data", "Each model is named with a placement; a hosted model gets at most D2, a zero-retention one D1, any other D0; Covered Models cannot be declared zero-retention.", (c) => {
    const hosted = hostedModels(c);
    return hosted.length
      ? { status: "partly", why: `Hosted ${list(hosted)} receive data up to their placement's ceiling under the vendor's terms.` }
      : { status: "met", why: "Every model in lab.toml runs on lab or institution hardware." };
  }, [T.egressTable, T.d3ToZdr, T.coveredModel]),
  hecvat("ai-agent-confinement", "AI: what an agent can do on its own", "Agents act only through built-in tools; a hosted CLI's own tools are switched off and its tool results pass the egress decision.", fixed("met", "Built in."), [T.cliOwnToolsOff, T.cliWithheld, T.cliPlacement]),
  hecvat("ai-traceability", "AI: traceability of AI output", "Each answer names the agent version hash and links its record; a reviewer can verify the chain from the page.", fixed("met", "Built in."), [T.recordView, T.verifyOnPage, T.toolVersion]),
  hecvat("ai-change-control", "AI: change control for models and prompts", "Publishing is role-gated and audited; a change to instructions, model, knowledge bases, tools or limits moves the version hash.", fixed("partly", "The system prompt text the core adds is not yet in the version hash (roadmap 0.8)."), [T.publishAudit, T.toolVersion]),
  hecvat("privacy-third-parties", "Privacy: disclosure to third parties", "Only destinations named in lab.toml receive data, each at most at its ceiling; review-confidential text goes nowhere by default.", (c) => ({
    status: c.policy.reviewConfidential === "refuse" ? "met" : "partly",
    why: c.policy.reviewConfidential === "refuse" ? "Review-confidential text is refused everywhere." : "review_confidential = \"lab-only\" lets R reach lab models, the store and chat.",
  }), [T.rDefault, T.egressTable]),
  hecvat("privacy-minimization", "Privacy: minimization in what leaves", "An answer above a surface's ceiling leaves as the record link only.", fixed("met", "Built in."), [T.surfaceCeiling, T.slackCeiling]),
  hecvat("accessibility", "Accessibility: conformance of the interface", "Chat, runs and record pages work from the keyboard with visible focus; status is marked by shape and words, not colour alone.", fixed("partly", "No WCAG audit or conformance report exists.")),
  hecvat("incident-response", "Incident response: evidence for an investigation", "Records answer what an agent saw, sent and was refused, by hash, and a broken chain shows at the edited event.", fixed("partly", "The incident plan and notification duties are the lab's and the institution's."), [T.recordViewBroken, T.verifyChain]),
];

export const CONTROLS: readonly Control[] = [...HIPAA, ...NIST, ...HECVAT];

export const FRAMEWORK_NAMES: Readonly<Record<Framework, string>> = {
  hipaa: "HIPAA Security Rule (45 CFR 164)",
  "800-171r3": NIST_TITLE,
  hecvat: "HECVAT 4 question areas (paraphrased)",
};

export interface Row {
  readonly control: Control;
  readonly assessment: Assessment;
}

export function assessAll(c: ReviewConfig): readonly Row[] {
  return CONTROLS.map((control) => ({ control, assessment: control.assess(c) }));
}
