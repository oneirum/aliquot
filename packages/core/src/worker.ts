/**
 * Worker main: boots the core, listens for stops, claims run and kb-compile
 * jobs and executes them. The fault option is for durability checks only: it kills or pauses
 * this process at an exact point in the journal so a test can prove resume
 * and the lease fence against a real process.
 */

import { AgentUnavailable, LOOP_CONTRACT, versionHash, type Deployed, type ResolvedAgent } from "./agent.ts";
import { RETRIEVAL_ALGORITHM } from "./kb.ts";
import { boot, type Core } from "./boot.ts";
import { runCompileJob } from "./kb-compile.ts";
import { drive, type LoopDeps } from "./loop.ts";
import { runWorker, type Engine, type JobHandler, type JobKind, type JobResult, type LeasedJob } from "./queue.ts";
import { openJournal, parseStopNotification, RecordCorrupt, StoreRefused, type RunEvent, type RunId, type RunJournal, type StopNotice, type StoredEvent } from "./record.ts";
import type { AgentVersionHash } from "./hash.ts";
import type { ModelTarget } from "./gateway.ts";
import type { RegisteredTool } from "./tools.ts";

/**
 * kill-after and stop-before act on the process. throw-before makes the
 * append of one event type throw instead: pg-blip once (a reset socket, the
 * kind of error the loop must retry), store-refused every time (the kind it
 * must finish on). The pseudo-event journal-open throws while the journal is
 * being opened, before any append.
 */
export type FaultPoint = RunEvent["t"] | "journal-open";
export type Fault =
  | { readonly t: "kill-after"; readonly event: FaultPoint }
  | { readonly t: "stop-before"; readonly event: FaultPoint }
  | { readonly t: "throw-before"; readonly event: FaultPoint; readonly error: "pg-blip" | "store-refused" };

/** Only a test harness sets LABH_FAULTS=1, and production never honors it. The binary checks this before it reads any config. */
export function faultsAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.LABH_FAULTS === "1" && env.NODE_ENV !== "production";
}

export function parseFault(s: string): Fault {
  const m = /^(kill-after|stop-before|throw-before):([a-z.-]+)(?::(pg-blip|store-refused))?$/.exec(s);
  if (!m) throw new Error(`fault must be kill-after:<event>, stop-before:<event> or throw-before:<event>:<pg-blip|store-refused>, got ${s}`);
  const event = m[2] as FaultPoint;
  if (m[1] === "throw-before") {
    if (!m[3]) throw new Error(`throw-before needs an error kind, got ${s}`);
    return { t: "throw-before", event, error: m[3] as "pg-blip" | "store-refused" };
  }
  return { t: m[1] as "kill-after" | "stop-before", event };
}

export interface WorkerOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly fault?: Fault;
  /** Tools planted by the slice harness, replacing built-ins of the same name. */
  readonly tools?: readonly RegisteredTool[];
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  /** The agent worker sets these: it claims agent-cli runs only, and runs them through its session driver. */
  readonly engine?: Engine;
  readonly agentSession?: LoopDeps["agentSession"];
  readonly agentClis?: ReadonlyMap<string, string>;
  readonly confinement?: Deployed["confinement"];
}

const pgBlip = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });

/** Wraps a journal so the process dies (SIGKILL) right after, or pauses (SIGSTOP) right before, one event type is committed. */
function withFault(journal: RunJournal, fault: Fault, blips: { left: number }, log: (line: string) => void): RunJournal {
  const guarded = async (e: RunEvent, append: () => Promise<StoredEvent>): Promise<StoredEvent> => {
    if (fault.t === "stop-before" && e.t === fault.event) {
      log(`fault: SIGSTOP before ${e.t}`);
      process.kill(process.pid, "SIGSTOP");
      log(`fault: resumed, now appending ${e.t}`);
    }
    if (fault.t === "throw-before" && e.t === fault.event) {
      if (fault.error === "store-refused") {
        log(`fault: StoreRefused before ${e.t}`);
        throw new StoreRefused({ code: "class-above-ceiling", payload: "D3", ceiling: "D2" });
      }
      if (blips.left-- > 0) {
        log(`fault: pg blip before ${e.t}`);
        throw pgBlip();
      }
    }
    const stored = await append();
    if (fault.t === "kill-after" && e.t === fault.event) {
      log(`fault: SIGKILL after ${e.t} seq ${stored.seq}`);
      process.kill(process.pid, "SIGKILL");
    }
    return stored;
  };
  return {
    ...journal,
    append: (e) => guarded(e, () => journal.append(e)),
    record: async (e) => {
      await guarded(e, () => journal.append(e));
    },
    consumeInbox: (inboxId, item) => guarded({ t: "inbox.consumed", inboxId, item }, () => journal.consumeInbox(inboxId, item)),
  };
}

export async function startWorker(configPath: string, opts: WorkerOptions): Promise<void> {
  const core = await boot(configPath, process.env, { tools: opts.tools ?? [] });
  try {
    await workOn(core, opts);
  } finally {
    await core.close();
  }
}

export async function workOn(core: Core, opts: WorkerOptions): Promise<void> {
  // Stop notices fan out to whatever call is in flight for the run; each call decides whether that stop aborts it.
  const stopListeners = new Map<string, Set<(stop: StopNotice) => void>>();
  // One blip per process, not per claim: the retried claim must find the journal healthy again.
  const blips = { left: 1 };
  const listener = await core.db.connect();
  listener.on("notification", (n) => {
    const stop = n.channel === "run_stop" && n.payload ? parseStopNotification(n.payload) : null;
    if (stop) for (const l of stopListeners.get(stop.runId) ?? []) l(stop);
  });
  await listener.query("listen run_stop");

  const loadAgent = async (hash: AgentVersionHash): Promise<ResolvedAgent> => {
    const row = await core.db.query<{ body: ResolvedAgent }>("select body from agent_versions where hash = $1", [hash]);
    const body = row.rows[0]?.body;
    if (!body) throw new AgentUnavailable(hash, "missing");
    if (versionHash(body) !== hash) throw new AgentUnavailable(hash, "hash-mismatch");
    if (body.schema !== 2) throw new AgentUnavailable(hash, "schema");
    return body;
  };
  /** Endpoint id -> which of a band agent's targets (every band, and model above them) it serves now, for verifyRunnable. */
  const servedBands = async (targets: readonly ModelTarget[]): Promise<Map<string, Set<string>>> => {
    const served = new Map<string, Set<string>>();
    for (const t of targets) {
      const ids = served.get(t.endpointId) ?? new Set<string>();
      served.set(t.endpointId, ids);
      if (await core.gateway.serves(t)) ids.add(t.modelId);
    }
    return served;
  };
  // Snapshots are published while the worker runs, so which of the agent's pins this deployment serves is asked per run.
  const deployed = async (agent: ResolvedAgent): Promise<Deployed> => ({
    tools: core.tools.registry.deployed(),
    snapshots: new Set((await Promise.all(agent.knowledgeBases.map(async (b) => ((await core.kb.has(b.snapshot)) ? [b.snapshot] : [])))).flat()),
    sandboxImages: agent.sandbox && core.config.sandbox?.digest === agent.sandbox.imageDigest && (await core.sandbox?.hasImage()) ? new Set([agent.sandbox.imageDigest]) : new Set(),
    loopContract: LOOP_CONTRACT,
    retrieval: new Set([RETRIEVAL_ALGORITHM]),
    ...(opts.agentClis ? { agentClis: opts.agentClis } : {}),
    ...(agent.modelsByClass ? { served: await servedBands([...agent.modelsByClass.map((b) => b.target), agent.model]) } : {}),
    ...(opts.confinement ? { confinement: opts.confinement } : {}),
  });

  const run = async (job: LeasedJob, lease: { lost: AbortSignal }): Promise<JobResult> => {
    const runId = job.id as RunId;
    const listeners = new Set<(stop: StopNotice) => void>();
    stopListeners.set(runId, listeners);
    try {
      let base: RunJournal;
      try {
        if (opts.fault?.t === "throw-before" && opts.fault.event === "journal-open" && opts.fault.error === "pg-blip" && blips.left-- > 0) {
          opts.log("fault: pg blip before journal-open");
          throw pgBlip();
        }
        base = await openJournal(core.db, core.store, { runId, epoch: job.epoch, owner: opts.workerId });
      } catch (err) {
        // Without its journal no run can be finished: a corrupt record fails the job, anything else is a blip and the job is handed back.
        if (err instanceof RecordCorrupt) {
          opts.log(err.message);
          return "failed";
        }
        opts.log(`run ${runId}: the journal did not open: ${err instanceof Error ? err.message : String(err)}`);
        return "retry";
      }
      const journal = opts.fault ? withFault(base, opts.fault, blips, opts.log) : base;
      const deps: LoopDeps = {
        gateway: core.gateway,
        tools: core.tools,
        kb: core.kb,
        surfaces: core.surfaces,
        policy: core.config.policy,
        loadAgent,
        deployed,
        clock: { now: () => Date.now() },
        callSignal: (abortsOn) => {
          const ctl = new AbortController();
          const onStop = (stop: StopNotice) => {
            if (abortsOn(stop)) ctl.abort();
          };
          listeners.add(onStop);
          return { signal: AbortSignal.any([ctl.signal, lease.lost]), release: () => listeners.delete(onStop) };
        },
        log: opts.log,
        ...(opts.agentSession ? { agentSession: opts.agentSession } : {}),
      };
      const result = await drive(job, journal, deps);
      opts.log(`run ${runId}: ${result.t}${result.t === "finished" ? ` ${result.outcome}` : ""}${"error" in result ? ` (${result.error})` : ""}`);
      switch (result.t) {
        case "finished":
          return "done";
        case "parked":
          return "waiting";
        case "lease-lost":
          return "lease-lost";
        case "retry":
          return result.progressed ? "retry-after-progress" : "retry";
        case "unstartable":
          return "failed";
      }
    } finally {
      stopListeners.delete(runId);
    }
  };

  const compile = async (job: LeasedJob, lease: { lost: AbortSignal }): Promise<JobResult> => {
    const signal = AbortSignal.any([opts.signal, lease.lost]);
    const outcome = await runCompileJob(job.payload, { db: core.db, store: core.store, gateway: core.gateway, actor: `worker:${opts.workerId}`, jobId: job.id, signal, log: opts.log, labPatterns: core.config.participantIdPatterns });
    opts.log(`kb-compile ${job.id}: ${outcome.t}${outcome.t === "compiled" ? ` snapshot ${outcome.snapshot.snapshot.id}` : outcome.t === "failed" ? ` ${outcome.reason}` : ` snapshot class ${outcome.cls}`}`);
    if (outcome.t === "compiled") return "done";
    // An interrupted compile is not a failed one: its lease lapses and the next claim reuses every cached result.
    return outcome.t === "failed" && signal.aborted ? "lease-lost" : "failed";
  };

  try {
    const handlers: Partial<Record<JobKind, JobHandler>> = opts.engine === "agent-cli" ? { run } : { run, "kb-compile": compile };
    await runWorker(opts.workerId, core.db, core.queue, handlers, { engine: opts.engine ?? "chat", leaseMs: opts.leaseMs, pollMs: opts.pollMs, signal: opts.signal, log: opts.log });
  } finally {
    listener.release();
  }
}
