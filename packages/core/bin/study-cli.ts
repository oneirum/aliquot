// aliquot study, card and sheet: the PI's and the IRB's commands. They boot the shared core (lab.toml, Postgres and
// the payload key, which snapshot ids are checked with) and call no model and no network.
import { parseAgentDocument, resolveAgent, versionHash, type AgentId, type MemberId } from "../src/agent.ts";
import { bootShared, servedNow, type SharedCore } from "../src/boot-shared.ts";
import { cardFor, listingNow } from "../src/card.ts";
import { configProblem } from "../src/config.ts";
import { isDataClass } from "../src/door-client.ts";
import type { AgentVersionHash } from "../src/hash.ts";
import { labSheet } from "../src/sheet.ts";
import { activeFreezes, bindChannel, createStudy, deviations, freeze, getStudy, StudyRefused, unfreeze } from "../src/study.ts";

export interface StudyFlags {
  readonly config: string;
  readonly json: boolean;
  readonly as?: string;
  readonly title?: string;
  readonly floor?: string;
  readonly irb?: string;
  readonly prereg?: string;
  readonly note?: string;
  readonly reason?: string;
}

export const STUDY_USAGE = `  study create <id> --title <t> --as <owner> [--floor D0..D3] [--irb <protocol>] [--prereg <url>]
  study bind <id> <surface:channel> --as <owner>
  study freeze <id> <agent-id | version hash> --as <owner> --note <why this version>
  study unfreeze <id> <agent-id> --as <owner> --reason <why>     recorded as a protocol deviation
  study show <id>     the study, its channels, what is frozen in them, and every deviation
                      A study channel runs its frozen version and is never routed. --as names the member acting;
                      only the study's owner may change it. Every change is in the audit stream.
  card <hash>         the agent card of a version as JSON: model and placement, tools with their spec hashes,
                      knowledge base snapshots, data ceilings, the system prompt's hash. schemas/agent-card.schema.json
  sheet               the research IT and IRB sheet for this lab.toml and its studies, as Markdown`;

export async function studyCommands(command: "study" | "card" | "sheet", words: readonly string[], flags: StudyFlags): Promise<number> {
  const refused = await configProblem(flags.config);
  if (refused) {
    process.stderr.write(`${refused}\n`);
    return 2;
  }
  let core: SharedCore;
  try {
    core = await bootShared(flags.config);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const out = (human: string, json: unknown) => process.stdout.write(`${flags.json ? JSON.stringify(json, null, 2) : human}\n`);
  try {
    if (command === "card") {
      const [hash] = words;
      if (!hash || !/^[0-9a-f]{64}$/.test(hash) || words.length > 1) return usage();
      process.stdout.write(`${JSON.stringify(await cardFor(core, hash as AgentVersionHash), null, 2)}\n`);
      return 0;
    }
    if (command === "sheet") {
      if (words.length) return usage();
      process.stdout.write(await labSheet(core));
      return 0;
    }
    return await study(core, words, flags, out);
  } catch (err) {
    if (err instanceof StudyRefused || (err as { name?: string }).name === "AgentUnavailable") {
      process.stderr.write(`refused: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await core.close();
  }
}

function usage(): number {
  process.stderr.write(`usage:\n${STUDY_USAGE}\n`);
  return 2;
}

async function study(core: SharedCore, words: readonly string[], flags: StudyFlags, out: (human: string, json: unknown) => void): Promise<number> {
  const [verb, id, arg, ...rest] = words;
  if (!verb || !id || rest.length) return usage();
  const actor = flags.as as MemberId | undefined;
  if (verb === "show") {
    const s = await getStudy(core.db, id);
    if (!s) throw new StudyRefused(`no study ${id}`);
    const frozen = await activeFreezes(core.db, id);
    const devs = await deviations(core.db, id);
    out(
      [
        `study ${s.id}: ${s.title}`,
        `  owner ${s.owner}, floor ${s.dataFloor}${s.irbProtocol ? `, IRB protocol ${s.irbProtocol}` : ""}${s.preregUrl ? `, pre-registered at ${s.preregUrl}` : ""}`,
        `  channels: ${s.channels.map((c) => `${c.surface}:${c.channelId}`).join(", ") || "none"}`,
        ...frozen.map((f) => `  frozen: ${f.agentId} at ${f.hash} by ${f.frozenBy} (${f.at}): ${f.note}`),
        ...(frozen.length ? [] : ["  frozen: nothing"]),
        ...devs.map((d) => `  deviation: ${d.agentId} at ${d.hash.slice(0, 12)} unfrozen by ${d.by} (${d.at}): ${d.reason}`),
      ].join("\n"),
      { study: s, freezes: frozen, deviations: devs },
    );
    return 0;
  }
  if (!actor) return usage();
  if (verb === "create") {
    const floor = flags.floor ?? "D1";
    if (arg || !flags.title || !isDataClass(floor)) return usage();
    const s = await createStudy(core.db, { id, title: flags.title, owner: actor, dataFloor: floor, irbProtocol: flags.irb ?? null, preregUrl: flags.prereg ?? null });
    out(`study ${s.id} created: ${s.title}, owner ${s.owner}, floor ${s.dataFloor}`, s);
    return 0;
  }
  if (verb === "bind") {
    const m = arg ? /^([a-z][a-z0-9_-]*):([^:]+)$/.exec(arg) : null;
    if (!m) return usage();
    const s = await bindChannel(core.db, id, { surface: m[1]!, channelId: m[2]! }, actor);
    out(`channel ${arg} now runs study ${s.id}'s frozen version and is never routed`, s);
    return 0;
  }
  if (verb === "freeze") {
    if (!arg || !flags.note) return usage();
    const hash = /^[0-9a-f]{64}$/.test(arg) ? (arg as AgentVersionHash) : await currentVersion(core, arg as AgentId);
    const agentId = (await core.db.query<{ agent_id: AgentId }>("select agent_id from agent_versions where hash = $1", [hash])).rows[0]?.agent_id;
    const now = agentId ? await listingNow(core, agentId) : null;
    if (!now) throw new StudyRefused(`no published or fixture agent for version ${hash.slice(0, 12)}`);
    const f = await freeze(core.db, id, hash, actor, flags.note, { listing: now.listing, deployed: await servedNow(core) });
    out(`study ${id} froze ${f.agentId} at ${f.hash}`, f);
    return 0;
  }
  if (verb === "unfreeze") {
    if (!arg || !flags.reason) return usage();
    const d = await unfreeze(core.db, id, arg as AgentId, actor, flags.reason);
    out(`study ${id} unfroze ${d.agentId} (was ${d.hash.slice(0, 12)}). Protocol deviation recorded: ${d.reason}`, d);
    return 0;
  }
  return usage();
}

/** What an agent id resolves to now, as intake would resolve it (its published head, else the fixture), stored so a freeze can reference it. */
async function currentVersion(core: SharedCore, agentId: AgentId): Promise<AgentVersionHash> {
  const head = (await core.db.query<{ document: unknown }>("select document from agent_heads where agent_id = $1", [agentId])).rows[0];
  const parsed = head ? parseAgentDocument(head.document) : null;
  const doc = parsed?.ok ? parsed.doc : core.agents.find((a) => a.agentId === agentId);
  if (!doc) throw new StudyRefused(`no agent ${agentId} is published or in lab.toml`);
  const resolved = resolveAgent(doc, await core.catalog());
  if (!resolved.ok) throw new StudyRefused(`${agentId} does not resolve: ${resolved.issues.map((i) => i.message).join("; ")}`);
  const hash = versionHash(resolved.agent);
  await core.db.query("insert into agent_versions (hash, agent_id, body) values ($1, $2, $3) on conflict (hash) do nothing", [hash, agentId, JSON.stringify(resolved.agent)]);
  return hash;
}
