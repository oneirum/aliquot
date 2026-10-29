/**
 * The one durable queue. Postgres only, no library.
 *
 *   jobs(id, kind, key UNIQUE, thread_key, status, not_before,
 *        lease_owner, lease_epoch, lease_until, payload jsonb, created_at)
 *
 * Kinds and how each survives a crash:
 *   run           journaled: resumes mid-run from run_events (loop.ts)
 *   publish-check idempotent by draft hash: restart from the top
 *   kb-compile    idempotent by (source hashes, compiler hash); per-entry results cached by the same key
 *   eval-batch    fans out one `run` job per eval case, keyed by (ticket, case)
 *   schedule-tick inserts run jobs keyed `sched:<id>:<fireAt>`
 *
 * Invariants:
 * - enqueue is idempotent by key (INSERT .. ON CONFLICT DO NOTHING). A
 *   duplicated Slack delivery or a double-fired schedule makes one job.
 *   Run keys: `msg:<surface>:<channel>:<thread>:<message>`, so a thread id plus
 *   message id is the idempotency key, as Sanity keys by Slack thread.
 * - claim uses FOR UPDATE SKIP LOCKED, increments lease_epoch, and skips a run
 *   job whose thread has a leased run job or an earlier job still queued,
 *   waiting or leased, so runs in a thread go in creation order and one at a
 *   time, retry backoffs and confirmations included. The unique index
 *   one_leased_run_per_thread holds the one-at-a-time rule when two claims
 *   race; the loser's update fails and its claim returns null.
 * - an expired lease is claimable; the old holder's next append fails (fence).
 * - status "waiting" holds no lease; an inbox write sets not_before = now().
 * - a handler that hits a transient error returns "retry": the job goes back
 *   to queued with a backoff and attempts + 1. JOB_RETRY bounds it.
 */

import type { Db } from "./db.ts";
import type { ThreadKey } from "./record.ts";

export type JobKind = "run" | "publish-check" | "kb-compile" | "eval-batch" | "schedule-tick";

/** Which worker binary executes a run job. A payload without one is a chat run. */
export const ENGINES = ["chat", "agent-cli"] as const;
export type Engine = (typeof ENGINES)[number];

export interface JobKey {
  readonly kind: JobKind;
  readonly key: string;
}

export interface LeasedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly key: string;
  readonly thread: ThreadKey | null;
  readonly owner: string;
  readonly epoch: number;
  /** Transient-error retries so far. The handler reads it to bound its own retrying. */
  readonly attempts: number;
  readonly payload: unknown;
}

/** retry-after-progress: the handler journaled something before the error, so the handback count starts over. */
export type JobResult = "done" | "failed" | "waiting" | "lease-lost" | "retry" | "retry-after-progress";

/**
 * Transient errors (a Postgres blip, a reset socket) outside a journaled call
 * get the job handed back maxAttempts times with this backoff, counted over
 * handbacks with no progress. hardCap is the last line: a job that keeps
 * failing while it settles its own failure is marked failed by the worker,
 * with a log line, rather than retried forever.
 */
export const JOB_RETRY = { maxAttempts: 3, backoffMs: [1_000, 4_000, 10_000], hardCap: 8 } as const;

export function retryBackoffMs(attempts: number): number {
  return JOB_RETRY.backoffMs[Math.min(attempts, JOB_RETRY.backoffMs.length - 1)] ?? 0;
}

export interface Queue {
  /** Returns the existing job id when the key already exists. */
  enqueue(key: JobKey, thread: ThreadKey | null, payload: unknown): Promise<{ readonly id: string; readonly created: boolean }>;
  /** Run jobs are claimed only by a worker of their engine; other kinds by any worker that handles them. */
  claim(workerId: string, kinds: readonly JobKind[], leaseMs: number, engine?: Engine): Promise<LeasedJob | null>;
  /** False when the lease moved: the caller must stop touching the job. */
  heartbeat(job: LeasedJob, leaseMs: number): Promise<boolean>;
  complete(job: LeasedJob, status: "done" | "failed"): Promise<boolean>;
  park(job: LeasedJob): Promise<boolean>;
  /** Back to queued after delayMs with attempts + 1, or attempts 1 when the run progressed under this claim. Fenced like complete. */
  retry(job: LeasedJob, delayMs: number, progressed?: boolean): Promise<boolean>;
  wake(jobId: string): Promise<void>;
  /** Queues a failed job again. For content-keyed kinds, where asking again for the same key means "try again". */
  retryFailed(jobId: string): Promise<void>;
}

const CLAIM = `
  with candidate as (
    select j.id from jobs j
    where j.kind = any($1::text[])
      and (j.kind <> 'run' or coalesce(j.payload->>'engine', 'chat') = $4)
      and j.status in ('queued', 'leased')
      and j.not_before <= now()
      and (j.status = 'queued' or j.lease_until < now())
      and not exists (
        select 1 from jobs o
        where o.thread_key = j.thread_key and o.id <> j.id
          and ((o.status = 'leased' and o.lease_until >= now())
            or (o.status in ('queued', 'waiting', 'leased') and (o.created_at, o.id) < (j.created_at, j.id)))
      )
    order by j.created_at, j.id
    for update of j skip locked
    limit 1
  )
  update jobs
     set status = 'leased', lease_owner = $2, lease_epoch = jobs.lease_epoch + 1,
         lease_until = now() + ($3::int * interval '1 millisecond')
    from candidate
   where jobs.id = candidate.id
  returning jobs.id, jobs.kind, jobs.key, jobs.thread_key, jobs.lease_epoch, jobs.attempts, jobs.payload`;

const FENCE = "where id = $1 and lease_epoch = $2 and lease_owner = $3 and status = 'leased'";

interface JobRow {
  id: string;
  kind: JobKind;
  key: string;
  thread_key: string | null;
  lease_epoch: number;
  attempts: number;
  payload: unknown;
}

export function createQueue(db: Db): Queue {
  const fenced = async (job: LeasedJob, set: string, extra: unknown[] = []): Promise<boolean> => {
    const res = await db.query(`update jobs set ${set} ${FENCE}`, [job.id, job.epoch, job.owner, ...extra]);
    return (res.rowCount ?? 0) > 0;
  };
  return {
    async enqueue(key, thread, payload) {
      const inserted = await db.query<{ id: string }>(
        "insert into jobs (kind, key, thread_key, payload) values ($1, $2, $3, $4) on conflict (key) do nothing returning id",
        [key.kind, key.key, thread, JSON.stringify(payload)],
      );
      const row = inserted.rows[0];
      if (row) {
        await db.query("select pg_notify('jobs_new', $1)", [key.kind]);
        return { id: row.id, created: true };
      }
      const existing = await db.query<{ id: string }>("select id from jobs where key = $1", [key.key]);
      return { id: existing.rows[0]!.id, created: false };
    },
    async claim(workerId, kinds, leaseMs, engine = "chat") {
      let res;
      try {
        res = await db.query<JobRow>(CLAIM, [kinds, workerId, leaseMs, engine]);
      } catch (err) {
        if ((err as { code?: string; constraint?: string }).code === "23505" && (err as { constraint?: string }).constraint === "one_leased_run_per_thread") return null;
        throw err;
      }
      const r = res.rows[0];
      if (!r) return null;
      return { id: r.id, kind: r.kind, key: r.key, thread: r.thread_key as ThreadKey | null, owner: workerId, epoch: r.lease_epoch, attempts: r.attempts, payload: r.payload };
    },
    heartbeat: (job, leaseMs) => fenced(job, "lease_until = now() + ($4::int * interval '1 millisecond')", [leaseMs]),
    complete: (job, status) => fenced(job, "status = $4, lease_owner = null, lease_until = null", [status]),
    park: (job) => fenced(job, "status = 'waiting', lease_owner = null, lease_until = null"),
    retry: (job, delayMs, progressed = false) =>
      fenced(job, "status = 'queued', attempts = case when $5 then 1 else attempts + 1 end, not_before = now() + ($4::int * interval '1 millisecond'), lease_owner = null, lease_until = null", [delayMs, progressed]),
    async wake(jobId) {
      await db.query("update jobs set status = 'queued', not_before = now() where id = $1 and status = 'waiting'", [jobId]);
    },
    async retryFailed(jobId) {
      const res = await db.query("update jobs set status = 'queued', not_before = now() where id = $1 and status = 'failed'", [jobId]);
      if (res.rowCount) await db.query("select pg_notify('jobs_new', 'retry')");
    },
  };
}

export interface WorkerOptions {
  readonly engine?: Engine;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

export type JobHandler = (job: LeasedJob, lease: { readonly lost: AbortSignal }) => Promise<JobResult>;

/**
 * Worker main: claim, dispatch by kind, heartbeat, complete. A failed
 * heartbeat aborts the handler's lease signal and the job is left alone; the
 * journal fence makes the stale handler's next write fail anyway. Returns when
 * the signal aborts and the current job (if any) has returned.
 */
export async function runWorker(workerId: string, db: Db, queue: Queue, handlers: Partial<Record<JobKind, JobHandler>>, opts: WorkerOptions): Promise<void> {
  const kinds = Object.keys(handlers) as JobKind[];
  const listener = await db.connect();
  let wake: (() => void) | null = null;
  listener.on("notification", () => wake?.());
  await listener.query("listen jobs_new");
  const idle = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.pollMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      opts.signal.addEventListener("abort", wake, { once: true });
    });
  try {
    while (!opts.signal.aborted) {
      const job = await queue.claim(workerId, kinds, opts.leaseMs, opts.engine);
      if (!job) {
        await idle();
        continue;
      }
      const lost = new AbortController();
      // A heartbeat that throws (a blip) is not a lost lease: the next tick tries again, and if the
      // lease does expire meanwhile the journal fence refuses the handler's next write anyway.
      const beat = setInterval(() => {
        queue.heartbeat(job, opts.leaseMs).then(
          (held) => {
            if (!held) {
              lost.abort();
              clearInterval(beat);
            }
          },
          (err: unknown) => opts.log(`job ${job.id} heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }, Math.max(50, Math.floor(opts.leaseMs / 3)));
      let result: JobResult;
      try {
        result = await handlers[job.kind]!(job, { lost: lost.signal });
      } catch (err) {
        opts.log(`job ${job.id} ${job.kind} threw: ${(err as Error).stack ?? err}`);
        result = "failed";
      } finally {
        clearInterval(beat);
      }
      if (result === "retry" && job.attempts + 1 >= JOB_RETRY.hardCap) {
        opts.log(`job ${job.id} ${job.kind} gave up after ${job.attempts + 1} attempts`);
        result = "failed";
      }
      const attempts = result === "retry-after-progress" ? 1 : job.attempts + 1;
      const delay = retryBackoffMs(attempts - 1);
      let applied: boolean;
      switch (result) {
        case "lease-lost":
          // A LeaseLost while the lease is still ours means the handler's copy of the record fell behind
          // (a commit that landed after its connection dropped); hand the job back so the next claim reloads it.
          applied = (await queue.heartbeat(job, opts.leaseMs)) ? await queue.retry(job, delay) : false;
          break;
        case "waiting":
          applied = await queue.park(job);
          break;
        case "retry":
        case "retry-after-progress":
          applied = await queue.retry(job, delay, result === "retry-after-progress");
          break;
        default:
          applied = await queue.complete(job, result);
      }
      opts.log(`job ${job.id} ${job.kind} ${result}${result.startsWith("retry") ? ` attempt ${attempts} in ${delay}ms` : ""}${applied ? "" : " (lease not held)"}`);
    }
  } finally {
    listener.release();
  }
}
