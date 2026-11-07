/**
 * The Slack door: a mention in a channel the app was invited to, or a direct
 * message to it, becomes a question to the lab's door, and the answer posts
 * in the thread with the run's record link. It is a client of the door like
 * `aliquot ask`, speaking as the [surfaces.slack] surface by its token, so
 * the gate, the data-class checks and the record are the door's, unchanged.
 * The door withholds an answer above the slack surface's placement, and then
 * Slack gets the record link and nothing of the answer.
 *
 * What each Slack message becomes:
 *   mention or DM with a question -> a "looking" reply in the thread, edited to the answer, the refusal, or the link
 *   the router unsure             -> the choices as a numbered list; a mention in the thread with a number or a name asks that agent
 *   "stop" in a thread with a run  -> the door stops that run at its next step
 *   from a bot, an edit or a join  -> nothing
 *   from outside the workspace     -> nothing (a Slack Connect channel shares the app with other workspaces)
 */

import type { AgentChoice, AskInput, AskOptions, DoorEvent } from "../door-client.ts";
import type { SlackApi } from "./slack-wire.ts";

export interface SlackDoorDeps {
  readonly ask: (input: AskInput, opts: AskOptions) => AsyncIterable<DoorEvent>;
  readonly stop: (runId: string, user: string) => Promise<void>;
  readonly api: SlackApi;
  readonly log: (line: string) => void;
  /** Rewrites the door's record URL into one members can open, when the door's address is internal to the lab's network. */
  readonly recordLink: (doorUrl: string) => string;
}

export const LOOKING = "Looking in the lab's sources.";

interface SlackEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly user?: string;
  readonly user_team?: string;
  readonly team?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
}

interface Envelope {
  readonly envelope_id?: string;
  readonly type?: string;
  readonly payload?: { readonly team_id?: string; readonly is_ext_shared_channel?: boolean; readonly event?: SlackEvent };
}

/** Slack's escaping undone and mentions of the app taken out, so the door reads the question as the member typed it. */
export function questionText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, "")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Slack reads &, < and > as markup; the answer's own are shown as typed. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The choice a reply names: its number in the list, or its name or id. */
export function pickOf(text: string, choices: readonly AgentChoice[]): AgentChoice | undefined {
  const said = text.trim().replace(/[.!]$/, "").toLowerCase();
  const n = /^\d+$/.test(said) ? Number(said) : 0;
  return choices[n - 1] ?? choices.find((c) => said === c.name.toLowerCase() || said === c.agentId.toLowerCase());
}

/** What the thread shows for each way a door run ends. routedTo names the agent when the router chose it. */
export function replyFor(e: Extract<DoorEvent, { t: "finished" | "refused" }>, link: string, routedTo: string | null = null): string {
  if (e.t === "refused") return escape(e.message);
  const record = `${routedTo ? `${escape(routedTo)} answered. ` : ""}<${link}|Record of this answer>`;
  if (e.refusal) return `${escape(e.refusal)}\n${record}`;
  if (e.withheld) return `This answer holds data above what Slack may keep, so it stays in the lab. Read it in the record: <${link}>`;
  return `${escape(e.answer ?? `No answer; the run ended ${e.outcome}.`)}\n\n${record}`;
}

/** Returns handle(msg, ack): one Socket Mode message in. Events are acknowledged before any work, so Slack does not resend them. */
export function slackDoor(deps: SlackDoorDeps): (msg: unknown, ack: (obj: object) => void) => Promise<void> {
  /** Thread to the run in it, so "stop" in the thread reaches that run. */
  const running = new Map<string, string>();
  /** Slack resends an event it thinks was missed; a channel:ts seen here is not asked twice. */
  const seen = new Set<string>();

  /** Thread to the question the router asked the member about, until they reply with a number or a name. */
  const choosing = new Map<string, { readonly input: AskInput; readonly choices: readonly AgentChoice[] }>();

  async function answer(e: Required<Pick<SlackEvent, "channel" | "ts" | "user">> & SlackEvent): Promise<void> {
    const thread = e.thread_ts ?? e.ts;
    const text = questionText(e.text ?? "");
    const threadKey = `${e.channel}:${thread}`;
    if (/^stop\.?$/i.test(text) && running.has(threadKey)) {
      await deps.stop(running.get(threadKey)!, e.user);
      await deps.api("chat.postMessage", { channel: e.channel, thread_ts: thread, text: "Stopping. The run ends at its next step." });
      return;
    }
    if (!text) {
      await deps.api("chat.postMessage", { channel: e.channel, thread_ts: thread, text: "Ask me a question about the lab's handbook, protocols or literature." });
      return;
    }
    // A reply naming one of the choices sends the question it was about again, to that agent. Anything else is a new question.
    // Pending choices are per member: only the member who asked may pick, since the run replays their message as them.
    const choiceKey = `${threadKey}:${e.user}`;
    const asked = choosing.get(choiceKey);
    choosing.delete(choiceKey);
    const pick = asked && pickOf(text, asked.choices);
    const looking = await deps.api("chat.postMessage", { channel: e.channel, thread_ts: thread, text: LOOKING, unfurl_links: false });
    const update = (text: string) => deps.api("chat.update", { channel: e.channel, ts: looking.ts, text });
    const input: AskInput = asked && pick ? { ...asked.input, agent: pick.agentId } : { channel: e.channel, thread, message: e.ts, text, user: e.user };
    let routedTo: string | null = null;
    try {
      for await (const ev of deps.ask(input, {})) {
        if (ev.t === "started") {
          running.set(threadKey, ev.runId);
          routedTo = ev.routedTo ?? null;
        } else if (ev.t === "refused") return void (await update(replyFor(ev, "")));
        else if (ev.t === "choose") {
          choosing.set(choiceKey, { input, choices: ev.choices });
          return void (await update(`${escape(ev.message)}\nMention me in this thread with the number or the name.`));
        } else if (ev.t === "finished") return void (await update(replyFor(ev, deps.recordLink(ev.recordUrl), routedTo)));
      }
    } catch (err) {
      deps.log(`[slack] ${e.channel} ${e.ts}: ${err instanceof Error ? err.message : String(err)}`);
      await update("Aliquot could not get an answer from the lab's door. The lab's admin can see why in the Slack door's log.");
    } finally {
      running.delete(threadKey);
    }
  }

  return async (raw, ack) => {
    const env = raw as Envelope;
    if (env.envelope_id) ack({ envelope_id: env.envelope_id });
    if (env.type !== "events_api") return;
    const e = env.payload?.event;
    if (!e || !e.channel || !e.ts || !e.user || e.bot_id || e.subtype) return;
    const isMention = e.type === "app_mention";
    const isDm = e.type === "message" && e.channel_type === "im";
    if (!isMention && !isDm) return;
    const team = env.payload?.team_id;
    if (env.payload?.is_ext_shared_channel || (e.user_team ?? e.team ?? team) !== team) return deps.log(`[slack] ignored a message from outside the workspace in ${e.channel}`);
    const key = `${e.channel}:${e.ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    try {
      await answer({ ...e, channel: e.channel, ts: e.ts, user: e.user });
    } catch (err) {
      deps.log(`[slack] ${e.channel} ${e.ts}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
