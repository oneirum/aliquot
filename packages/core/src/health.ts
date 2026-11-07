/**
 * What a monitor asks of a running lab: does the database answer, and has a worker beaten lately. Every worker beats
 * a worker_heartbeats row (runWorker in queue.ts) and deletes it when it stops cleanly, so a stopped worker is gone at
 * once and a killed one goes stale after maxAgeMs. The web door serves the answer as GET /healthz.
 */

import type { Db } from "./db.ts";
import type { Engine } from "./queue.ts";

/** How often a worker beats. */
export const HEARTBEAT_MS = 5_000;
/** How old the newest chat worker's beat may be before /healthz answers 503: a few missed beats, not one. */
export const WORKER_STALE_MS = 30_000;
/** How long /healthz waits for Postgres before it calls the database unreachable. */
const DB_ANSWER_MS = 5_000;

/** Beats now and every everyMs until the returned stop, which deletes the row. A failed beat is logged and retried on the next tick. */
export async function startHeartbeat(db: Db, workerId: string, engine: Engine, log: (line: string) => void, everyMs = HEARTBEAT_MS): Promise<() => Promise<void>> {
  const beat = () =>
    db.query("insert into worker_heartbeats (worker_id, engine) values ($1, $2) on conflict (worker_id) do update set engine = excluded.engine, beat_at = now()", [workerId, engine]);
  await beat();
  const timer = setInterval(() => beat().catch((err: unknown) => log(`worker heartbeat failed: ${err instanceof Error ? err.message : String(err)}`)), everyMs);
  return async () => {
    clearInterval(timer);
    await db.query("delete from worker_heartbeats where worker_id = $1", [workerId]).catch((err: unknown) => log(`worker heartbeat row not removed: ${err instanceof Error ? err.message : String(err)}`));
  };
}

export interface Health {
  readonly ok: boolean;
  readonly database: "ok" | "unreachable";
  /** Milliseconds since the newest chat worker's beat, or null when no chat worker has a row. */
  readonly workerBeatAgeMs: number | null;
  readonly workerStaleAfterMs: number;
}

/** Healthy when the database answers and a chat worker (the engine that runs chat runs and KB compiles) beat within maxAgeMs. */
export async function checkHealth(db: Db, maxAgeMs = WORKER_STALE_MS): Promise<Health> {
  let age: number | null;
  try {
    const query = db.query<{ age_ms: number | null }>("select (extract(epoch from now() - max(beat_at)) * 1000)::float8 as age_ms from worker_heartbeats where engine = 'chat'");
    // A database that accepts the connection and never answers is unreachable too, not a monitor left hanging.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), DB_ANSWER_MS)));
    const row = await Promise.race([query, late]).finally(() => clearTimeout(timer));
    age = row.rows[0]?.age_ms ?? null;
  } catch {
    return { ok: false, database: "unreachable", workerBeatAgeMs: null, workerStaleAfterMs: maxAgeMs };
  }
  const workerBeatAgeMs = age === null ? null : Math.max(0, Math.round(age));
  return { ok: workerBeatAgeMs !== null && workerBeatAgeMs <= maxAgeMs, database: "ok", workerBeatAgeMs, workerStaleAfterMs: maxAgeMs };
}
