/**
 * The Teams door: a mention in a channel or group chat the app was added to,
 * or a message in a personal chat with it, becomes a question to the lab's
 * door, and the answer posts as a reply with the run's record link. It is a
 * client of the door like `aliquot ask` and `aliquot slack`, speaking as the
 * [surfaces.teams] surface by its token, so the gate, the data-class checks
 * and the record are the door's, unchanged. The door withholds an answer
 * above the teams surface's placement, and then Teams gets the record link
 * and nothing of the answer.
 *
 * What each Teams activity becomes:
 *   a message with a question        -> a "looking" reply, edited to the answer, the refusal, or the link
 *   "stop" in a thread with a run    -> the door stops that run at its next step
 *   from a bot, or not a message     -> nothing (edits, reactions and joins are other activity types)
 *   from another tenant              -> nothing (a shared channel or a guest's federated chat)
 *
 * A channel post and its replies are one thread, keyed by the root message id
 * Teams appends to the conversation id. A personal or group chat has no
 * threads in Teams, so the whole chat is one thread, and "stop" reaches the
 * run in progress there.
 */

import type { AskInput, AskOptions, DoorEvent } from "../door-client.ts";
import type { Connector } from "./teams-wire.ts";

export interface TeamsDoorDeps {
  readonly ask: (input: AskInput, opts: AskOptions) => AsyncIterable<DoorEvent>;
  readonly stop: (runId: string, user: string) => Promise<void>;
  readonly connector: Connector;
  /** The lab's Microsoft Entra tenant id; an activity from any other tenant is ignored. */
  readonly tenant: string;
  readonly log: (line: string) => void;
  /** Rewrites the door's record URL into one members can open, when the door's address is internal to the lab's network. */
  readonly recordLink: (doorUrl: string) => string;
}

export const LOOKING = "Looking in the lab's sources.";

export interface TeamsActivity {
  readonly type?: string;
  readonly id?: string;
  readonly channelId?: string;
  readonly serviceUrl?: string;
  readonly text?: string;
  readonly from?: { readonly id?: string; readonly aadObjectId?: string; readonly role?: string };
  readonly conversation?: { readonly id?: string; readonly conversationType?: string; readonly tenantId?: string };
  readonly channelData?: { readonly tenant?: { readonly id?: string } };
}

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&amp;": "&" };

/** The question as the member typed it: mentions of the app taken out, Teams' markup and escaping undone. */
export function questionText(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:nbsp|lt|gt|quot|#39|apos|amp);/g, (e) => ENTITIES[e]!)
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Teams renders markdown and some HTML in a bot's message; the answer's own markup characters are shown as typed. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the thread shows for each way a door run ends. */
export function replyFor(e: Extract<DoorEvent, { t: "finished" | "refused" }>, link: string): string {
  if (e.t === "refused") return escape(e.message);
  const record = `[Record of this answer](${link})`;
  if (e.refusal) return `${escape(e.refusal)}\n\n${record}`;
  if (e.withheld) return `This answer holds data above what Teams may keep, so it stays in the lab. Read it in the record: [${link}](${link})`;
  return `${escape(e.answer ?? `No answer; the run ended ${e.outcome}.`)}\n\n${record}`;
}

/** The door's channel and thread for an activity: a channel's root post and its replies share a thread; a chat is one thread. */
export function threadOf(conversationId: string, activityId: string, conversationType: string | undefined): { readonly channel: string; readonly thread: string } {
  const at = conversationId.indexOf(";messageid=");
  if (at >= 0) return { channel: conversationId.slice(0, at), thread: conversationId.slice(at + ";messageid=".length) };
  if (conversationType === "channel") return { channel: conversationId, thread: activityId };
  return { channel: conversationId, thread: conversationId };
}

/** Returns handle(activity): one verified activity in. teams-wire.ts has answered the Bot Framework before this runs. */
export function teamsDoor(deps: TeamsDoorDeps): (activity: unknown) => Promise<void> {
  /** Thread to the run in it, so "stop" in the thread reaches that run. */
  const running = new Map<string, string>();
  /** The Bot Framework resends an activity it thinks was missed; a conversation:id seen here is not asked twice. */
  const seen = new Set<string>();

  async function answer(a: TeamsActivity & { id: string; serviceUrl: string; conversationId: string; user: string }): Promise<void> {
    const { channel, thread } = threadOf(a.conversationId, a.id, a.conversation?.conversationType);
    const text = questionText(a.text ?? "");
    const threadKey = `${channel}:${thread}`;
    const post = (text: string) => deps.connector.reply(a.serviceUrl, a.conversationId, a.id, { type: "message", text, textFormat: "markdown", replyToId: a.id });
    if (/^stop\.?$/i.test(text) && running.has(threadKey)) {
      await deps.stop(running.get(threadKey)!, a.user);
      await post("Stopping. The run ends at its next step.");
      return;
    }
    if (!text) {
      await post("Ask me a question about the lab's handbook, protocols or literature.");
      return;
    }
    const looking = await post(LOOKING);
    const update = (text: string) => deps.connector.update(a.serviceUrl, a.conversationId, looking, { type: "message", text, textFormat: "markdown" });
    const input: AskInput = { channel, thread, message: a.id, text, user: a.user };
    try {
      for await (const ev of deps.ask(input, {})) {
        if (ev.t === "started") running.set(threadKey, ev.runId);
        else if (ev.t === "refused") return void (await update(replyFor(ev, "")));
        else if (ev.t === "finished") return void (await update(replyFor(ev, deps.recordLink(ev.recordUrl))));
      }
    } catch (err) {
      deps.log(`[teams] ${channel} ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
      await update("Aliquot could not get an answer from the lab's door. The lab's admin can see why in the Teams door's log.");
    } finally {
      running.delete(threadKey);
    }
  }

  return async (raw) => {
    const a = raw as TeamsActivity;
    if (a.type !== "message" || a.channelId !== "msteams" || a.from?.role === "bot") return;
    const conversationId = a.conversation?.id;
    const user = a.from?.aadObjectId ?? a.from?.id;
    if (!a.id || !a.serviceUrl || !conversationId || !user) return;
    const tenant = a.channelData?.tenant?.id ?? a.conversation?.tenantId;
    if (tenant !== deps.tenant) return deps.log(`[teams] ignored a message from outside the tenant in ${conversationId.split(";")[0]}`);
    const key = `${conversationId}:${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    try {
      await answer({ ...a, id: a.id, serviceUrl: a.serviceUrl, conversationId, user });
    } catch (err) {
      deps.log(`[teams] ${conversationId.split(";")[0]} ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
