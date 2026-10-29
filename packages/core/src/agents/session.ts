/**
 * The session driver: one agent CLI run, straight-line, not next(). The CLI
 * owns its loop, so there is no per-step decision for the loop contract to
 * pin. What the driver writes is the record a chat run would have for one
 * model call: model.requested with the task prompt, the bridged tool.*
 * events, then model.completed with the final text, so the chat loop's tail
 * (fold, the reply, the finish) is unchanged.
 *
 * The driver returns once the run has an answer, a confirmed stop, a fault or
 * a refused prompt. Anything else is a session attempt: a crashed worker's
 * attempt is never resumed (persistence is off), a new one starts, up to
 * MAX_ATTEMPTS. Every agent CLI tool is read-only, so repeating a call is safe.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { ResolvedAgent } from "../agent.ts";
import { describeRefusal, join, Labelled, type DataClass } from "../dataclass.ts";
import type { ChatPart, ModelGateway, Prompt } from "../gateway.ts";
import type { KbReader } from "../kb.ts";
import { buildPrompt, type LoopDeps } from "../loop.ts";
import { describeFailure, fold, MAX_ATTEMPTS, type ConfinementCheck, type RunEvent, type RunJournal, type RunState, type StoredEvent } from "../record.ts";
import type { ToolRunner } from "../tools.ts";
import { KINDS, UNREPORTED_MODEL, type CliLine } from "./backends.ts";
import { startBridge, type BridgeReply } from "./bridge.ts";
import { startProxy } from "./proxy.ts";
import { confine, killRecorded, recordProcess, spawnConfined, type InstalledCli, type RunningCli } from "./spawn.ts";

export interface SessionDeps {
  readonly gateway: ModelGateway;
  readonly tools: ToolRunner;
  readonly kb: KbReader;
  /** Backend id -> the CLI this worker found installed for it. */
  readonly clis: ReadonlyMap<string, InstalledCli>;
  /** Real path of the directory every session workspace is created under. */
  readonly workspaces: string;
  readonly env: NodeJS.ProcessEnv;
  /** How often the inbox is read during a session, besides the stop notice that wakes it at once. */
  readonly inboxPollMs?: number;
}

const LIMIT_TEXT = "You have reached this run's limit on tool calls. Answer now with what you have, without calling tools.";
const LIMIT_NOTICE = { wall: "The agent session reached its time limit before it finished.", tokens: "The agent session reached its token limit before it finished." } as const;
const MAX_CLI_TEXT = 500;

function sessionDone(s: RunState): boolean {
  return s.answer !== null || s.stop === "confirmed" || s.fault !== null || s.refused !== null || s.finished !== null;
}

/** The bridge handler and the inbox watcher append concurrently, and the journal's seq is taken from its length, so appends go one at a time. */
function serialized(journal: RunJournal): RunJournal {
  let tail: Promise<unknown> = Promise.resolve();
  const one = <T>(f: () => Promise<T>): Promise<T> => {
    const run = tail.then(f, f);
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    ...journal,
    events: () => journal.events(),
    append: (e) => one(() => journal.append(e)),
    record: (e) => one(() => journal.record(e)),
    consumeInbox: (id, item) => one(() => journal.consumeInbox(id, item)),
  };
}

const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The task prompt the CLI reads on stdin: the chat loop's first prompt, rendered as text, at the join of its parts. */
function render(prompt: Prompt): Labelled<string> {
  const labels = prompt.parts.map((p: ChatPart) => ("content" in p ? p.content : p.toolCalls));
  const text = prompt.parts.map((p) => ("content" in p ? p.content.value : asText(p.toolCalls.value))).join("\n\n");
  return Labelled.derive(text, labels, "agent:prompt", prompt.cls);
}

function terminal(events: readonly StoredEvent[], callId: string): Extract<RunEvent, { t: "tool.completed" | "tool.failed" }> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!.event;
    if ((e.t === "tool.completed" || e.t === "tool.failed") && e.callId === callId) return e;
  }
  return null;
}

/** Attempts start with model.requested; one without an agent.session after it was cut off by a dead worker. */
function attempts(events: readonly StoredEvent[]): { readonly started: number; readonly orphans: readonly string[] } {
  let started = 0;
  const open = new Set<string>();
  for (const { event: e } of events) {
    if (e.t === "model.requested") started = e.attempt;
    if (e.t === "tool.requested") open.add(e.callId);
    if (e.t === "tool.completed" || e.t === "tool.failed" || e.t === "tool.outcome-unknown") open.delete(e.callId);
  }
  return { started, orphans: [...open] };
}

/** Kills a CLI a dead worker left running and removes its workspace. Idempotent. */
export async function clearRun(root: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) if (/^s\d+\.pid$/.test(name)) await killRecorded(joinPath(root, name));
  rmSync(root, { recursive: true, force: true });
}

export function agentSession(sd: SessionDeps): NonNullable<LoopDeps["agentSession"]> {
  return async (agent, base, deps) => {
    const journal = serialized(base);
    const cli = sd.clis.get(agent.model.endpointId);
    const pin = agent.agentCli;
    if (!cli || !pin) throw new Error(`agent backend ${agent.model.endpointId} is not installed in this worker`);
    const runRoot = joinPath(sd.workspaces, journal.runId);
    // Publish refuses this too; checked again here because a restarted session repeats its calls.
    const writer = agent.tools.find((t) => sd.tools.registry.get(t.name)?.manifest.effects !== "read");
    if (writer && !sessionDone(fold(journal.events()))) {
      const why = await journal.put(Labelled.stamp(`tool ${writer.name} is not read-only`, "D0", "agent:self-check"));
      await journal.append({ t: "run.faulted", reason: { t: "agent-not-confined", check: "writer-tool", why } });
      return;
    }
    const consumeInbox = async (stopsOnly = false) => {
      for (const { id, item } of await journal.pendingInbox()) if (!stopsOnly || item.t === "stop") await journal.consumeInbox(id, item);
    };
    for (;;) {
      await consumeInbox();
      if (sessionDone(fold(journal.events()))) {
        await clearRun(runRoot);
        return;
      }
      const { started, orphans } = attempts(journal.events());
      for (const callId of orphans) await journal.append({ t: "tool.outcome-unknown", callId });
      await clearRun(runRoot);
      if (started >= MAX_ATTEMPTS) {
        await journal.append({ t: "run.faulted", reason: { t: "model-exhausted", attempts: started } });
        return;
      }
      await runAttempt(started + 1, agent, cli, pin, journal, deps, sd, runRoot, consumeInbox);
    }
  };
}

async function runAttempt(
  attempt: number,
  agent: ResolvedAgent,
  cli: InstalledCli,
  pin: NonNullable<ResolvedAgent["agentCli"]>,
  journal: RunJournal,
  deps: LoopDeps,
  sd: SessionDeps,
  runRoot: string,
  consumeInbox: (stopsOnly?: boolean) => Promise<void>,
): Promise<void> {
  const backend = cli.backend.id;
  const kind = KINDS[cli.backend.kind];
  const state = fold(journal.events());
  const prompt = render(await buildPrompt(state, agent, journal, { kb: sd.kb, tools: sd.tools }, false));
  const admitted = sd.gateway.admit(prompt, backend);
  if (!admitted.allow) {
    await journal.append({ t: "egress.refused", destination: `model:${backend}`, payload: prompt.cls, refusal: admitted.refusal });
    return;
  }
  const promptRef = await journal.put(prompt);
  await journal.append({ t: "model.requested", step: 1, attempt, target: agent.model, prompt: promptRef, final: false });
  const startedAt = deps.clock.now();

  let sessionClass: DataClass = prompt.cls;
  const returned: Labelled<unknown>[] = [];
  const reply = (content: Labelled<string>, isError: boolean): BridgeReply => {
    const d = sd.gateway.admit(content, backend);
    if (!d.allow) throw new Error(`a bridge reply at ${content.cls} was refused for ${backend}`);
    return { to: d.to, content, isError };
  };
  const notice = (text: string) => reply(Labelled.stamp(text, "D0", "agent:notice"), true);

  let calls = 0;
  let stepLimited = false;
  let fatal: unknown = null;
  let notConfined: { readonly check: ConfinementCheck; readonly why: string } | null = null;
  let initModel: string | null = null;
  let gateOpen: (ok: boolean) => void = () => undefined;
  const gate = kind.initGated ? new Promise<boolean>((resolve) => (gateOpen = resolve)) : Promise.resolve(true);
  const inFlight = new Set<Promise<unknown>>();
  let kill: () => void = () => undefined;
  let running: RunningCli | null = null;
  let exited = false;

  const signal = deps.callSignal(() => true);
  const call = async (name: string, args: unknown): Promise<BridgeReply> => {
    if (!(await gate)) return notice("The session failed its confinement check.");
    calls += 1;
    if (calls > agent.limits.maxSteps) {
      if (!stepLimited) {
        stepLimited = true;
        await journal.append({ t: "limit.hit", which: "steps" });
      }
      return notice(LIMIT_TEXT);
    }
    if (!agent.tools.some((t) => t.name === name)) return notice(`No tool named ${name} is available.`);
    const callId = `s${attempt}-${calls}`;
    const input = await journal.put(Labelled.derive(args, [], "agent:tool-args", sessionClass));
    await sd.tools.invoke(journal, { callId, tool: name, attempt: 1, input }, { knowledgeBases: agent.knowledgeBases, retrieval: agent.retrieval, sandbox: agent.sandbox }, signal.signal);
    const done = terminal(journal.events(), callId);
    let content: Labelled<string>;
    if (done?.t === "tool.completed") {
      const body = await journal.get(done.output);
      content = Labelled.derive(asText(body.value), [body], `agent:tool:${name}`);
    } else if (done?.failure.detail) {
      const detail = await journal.get(done.failure.detail);
      content = Labelled.derive(`Error: ${describeFailure(done.failure)}: ${asText(detail.value)}`, [detail], `agent:tool:${name}:error`);
    } else content = Labelled.stamp(`Error: ${done ? describeFailure(done.failure) : "the call left no result"}`, "D0", `agent:tool:${name}:error`);
    const d = sd.gateway.admit(content, backend);
    if (!d.allow) {
      await journal.append({ t: "tool.withheld", callId, refusal: d.refusal, cls: content.cls });
      return notice(`withheld: ${describeRefusal(d.refusal)}`);
    }
    sessionClass = join(sessionClass, content.cls);
    returned.push(content);
    return { to: d.to, content, isError: done?.t !== "tool.completed" };
  };

  const workspace = joinPath(runRoot, `s${attempt}`);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const bridge = await startBridge(token, {
    tools: sd.tools.specs(agent.tools.map((t) => t.name)),
    call: (name, args) => {
      const p = call(name, args).catch((err: unknown) => {
        fatal ??= err;
        kill();
        throw err;
      });
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p)).catch(() => undefined);
      return p;
    },
  });
  const proxy = await startProxy(kind.vendorHosts);
  let stopped = false;
  let limited: keyof typeof LIMIT_NOTICE | null = null;
  const turnTokens = new Map<string, number>();
  let lastText: string | null = null;
  let result: Extract<CliLine, { t: "result" }> | null = null;
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  let argvHash = "" as Extract<RunEvent, { t: "agent.session" }>["argvHash"];
  let stderr = "";
  const timers: NodeJS.Timeout[] = [];
  try {
    const confined = confine(admitted.to, prompt, { cli, model: agent.model.modelId, workspace: realpathSync(workspace), bridge, proxyPort: proxy.port, token, env: sd.env, maxWallMs: agent.limits.maxWallMs });
    argvHash = confined.argvHash;
    const proc = spawnConfined(confined);
    running = proc;
    kill = () => proc.kill();
    proc.onLine((line) => {
      const turn = kind.turnTokens(line);
      if (turn) {
        // claude repeats a turn's usage on every block of it, so turns are keyed by message id
        turnTokens.set(turn.id, turn.tokens);
        if (limited === null && [...turnTokens.values()].reduce((a, b) => a + b, 0) > agent.limits.maxTokens) {
          limited = "tokens";
          proc.kill();
        }
      }
      const parsed = kind.parse(line);
      const check = kind.check(parsed, { model: agent.model.modelId, cliVersion: pin.cliVersion });
      if (!check.ok) {
        notConfined ??= check;
        gateOpen(false);
        proc.kill();
        return;
      }
      if (parsed.t === "init") {
        initModel = parsed.model;
        gateOpen(true);
      } else if (parsed.t === "text") lastText = parsed.text;
      else if (parsed.t === "result") result = parsed;
    });
    const watchInbox = async () => {
      try {
        // A running CLI cannot take a steer, so only a stop is consumed mid-session; the rest wait for the tail.
        await consumeInbox(true);
        if (fold(journal.events()).stop === "confirmed") {
          stopped = true;
          proc.kill();
        }
      } catch (err) {
        fatal ??= err;
        proc.kill();
      }
    };
    signal.signal.addEventListener("abort", () => {
      void watchInbox();
      // The lease is gone when no stop explains the abort; the next append would fail, so the CLI goes now.
      setTimeout(() => {
        if (!stopped) proc.kill();
      }, 2_000);
    });
    timers.push(setInterval(() => void watchInbox(), sd.inboxPollMs ?? 1_000));
    const wallLeft = state.startedAt + agent.limits.maxWallMs - deps.clock.now();
    timers.push(
      setTimeout(
        () => {
          limited ??= "wall";
          proc.kill();
        },
        Math.max(0, wallLeft),
      ),
    );
    await recordProcess(`${workspace}.pid`, proc.pid);
    exit = await proc.exit;
    exited = true;
    stderr = proc.stderrTail();
    gateOpen(false);
  } finally {
    for (const t of timers) clearTimeout(t);
    signal.release();
    if (running && !exited) {
      running.kill(0);
      await running.exit;
    }
    await Promise.allSettled([...inFlight]);
    await bridge.close();
    await proxy.close();
    // The workspace can hold a copy of the backend's login; it goes with the session, however the session ended.
    rmSync(workspace, { recursive: true, force: true });
    rmSync(`${workspace}.pid`, { force: true });
  }
  if (fatal) throw fatal;
  // Everything the CLI wrote is labelled at what it had seen, and capped, because it can encode that content.
  const cliText = (text: string, origin: string) => journal.put(Labelled.derive(text.slice(0, MAX_CLI_TEXT), [prompt, ...returned], origin, sessionClass));
  const refused = proxy.refused();
  await journal.append({
    t: "agent.session",
    attempt,
    kind: cli.backend.kind,
    cliVersion: cli.cliVersion,
    argvHash,
    workspace,
    exit,
    turns: calls,
    hostsTunneled: proxy.tunneled(),
    hostsRefused: refused.count,
    refusedTargets: refused.count ? await cliText(JSON.stringify(refused.targets), "agent:proxy-refused") : null,
  });
  const res = result as Extract<CliLine, { t: "result" }> | null;
  if (notConfined === null && kind.initGated && initModel === null && !stopped && (res !== null || exit.code === 0)) notConfined = { check: "no-init", why: "the CLI answered without reporting the tools and model it loaded" };
  if (notConfined !== null) {
    await journal.append({ t: "run.faulted", reason: { t: "agent-not-confined", check: notConfined.check, why: await cliText(notConfined.why, "agent:self-check") } });
    return;
  }
  if (stopped) return;
  const ms = deps.clock.now() - startedAt;
  const providerModelId = cli.backend.kind === "codex" ? UNREPORTED_MODEL : (initModel ?? agent.model.modelId);
  const answer = async (text: string) => journal.put(Labelled.derive(text, [prompt, ...returned], "agent:output", sessionClass));
  const usage = res?.usage ?? { input: 0, output: 0 };
  // What the CLI said before a limit cut it off is narration, not an answer, so only the notice is posted.
  if (limited !== null) {
    await journal.append({ t: "limit.hit", which: limited });
    await journal.append({ t: "model.completed", step: 1, attempt, providerModelId, output: await answer(LIMIT_NOTICE[limited]), toolCalls: [], usage, ms });
    return;
  }
  const text = res?.text ?? lastText;
  if (exit.code === 0 && res !== null && !res.error && text !== null) {
    if (!stepLimited && usage.input + usage.output > agent.limits.maxTokens) await journal.append({ t: "limit.hit", which: "tokens" });
    await journal.append({ t: "model.completed", step: 1, attempt, providerModelId, output: await answer(text), toolCalls: [], usage, ms });
    return;
  }
  // stderr can quote what the CLI saw, so it is stored at the session's class and never logged.
  const detail = stderr ? await cliText(stderr.slice(-MAX_CLI_TEXT), "agent:error") : null;
  await journal.append({ t: "model.failed", step: 1, attempt, failure: { code: "thrown", detail }, retryable: true });
}
