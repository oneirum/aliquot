/**
 * run_code's container, through the Docker Engine API on its unix socket.
 * No client library: node:http with socketPath, and a small tar reader.
 *
 * One container per call. Its settings are constants here, and only the
 * image, the caps and the dataset binds come from lab.toml. The container's
 * first process sleeps; the code runs as an exec, and the files under /out
 * are read by a second exec that tars them while the container still runs,
 * because the archive endpoint does not see tmpfs mounts (an archive of a
 * tmpfs /out comes back empty, running or stopped). The container is
 * removed in a finally, whatever happened.
 */

import { request } from "node:http";
import type { SandboxConfig } from "./config.ts";

export const OUTPUT_CAP_BYTES = 32 * 1024;
export const FILES_CAP_BYTES = 256 * 1024;
/** The /out tmpfs is 4 MB; the rest is tar's headers. */
const ARCHIVE_CAP_BYTES = 4 * 1024 * 1024 + 64 * 1024;
export const TAR_ENTRIES_CAP = 4096;
export const DOCKER_GRACE_MS = 2000;
const API = "/v1.41";
const PIDS_LIMIT = 256;

export interface RunSpec {
  readonly language: "r" | "python";
  readonly code: string;
  /** Each bound read-only at /data/<id>. hostPath is the checked directory. */
  readonly mounts: readonly { readonly id: string; readonly hostPath: string }[];
}

export interface RunOutput {
  /** Null when the process was killed before it reported one. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What was cut: output streams past 32 KB, files past the 256 KB total or not text, and whether /out held more entries than could be listed. */
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean; readonly filesOmitted: readonly string[]; readonly filesUnlisted: boolean };
}

export interface Sandbox {
  hasImage(): Promise<boolean>;
  run(spec: RunSpec, signal: AbortSignal): Promise<RunOutput>;
}

export function containerConfig(s: SandboxConfig, mounts: RunSpec["mounts"]): object {
  return {
    Image: s.image,
    Cmd: ["sleep", "infinity"],
    User: "65534:65534",
    WorkingDir: "/work",
    NetworkDisabled: true,
    Labels: { "aliquot.run_code": "1" },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      // No /dev/shm: Docker's default is a 64 MB writable tmpfs outside the /work and /out caps.
      IpcMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NanoCpus: Math.round(s.cpus * 1e9),
      Memory: s.memoryMb * 1024 * 1024,
      MemorySwap: s.memoryMb * 1024 * 1024,
      PidsLimit: PIDS_LIMIT,
      Tmpfs: { "/work": "rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700", "/out": "rw,nosuid,nodev,size=4m,uid=65534,gid=65534,mode=0700" },
      Binds: mounts.map((m) => `${m.hostPath}:/data/${m.id}:ro`),
    },
  };
}

const EXEC_ENV = ["HOME=/work", "TMPDIR=/work"];
const command = (spec: RunSpec): string[] => (spec.language === "r" ? ["Rscript", "-e", spec.code] : ["python3", "-c", spec.code]);

/** What the code printed before the kill, when its exec got that far. */
const killedByTimeout = (run?: ExecResult): RunOutput => ({
  exitCode: null,
  timedOut: true,
  stdout: run?.stdout.subarray(0, OUTPUT_CAP_BYTES).toString("utf8") ?? "",
  stderr: run?.stderr.subarray(0, OUTPUT_CAP_BYTES).toString("utf8") ?? "",
  files: [],
  truncated: { stdout: (run?.stdoutBytes ?? 0) > OUTPUT_CAP_BYTES, stderr: (run?.stderrBytes ?? 0) > OUTPUT_CAP_BYTES, filesOmitted: [], filesUnlisted: false },
});

export function createSandbox(s: SandboxConfig): Sandbox {
  // Idle time per Docker request. An exec stays silent while the code runs, so it is the run's timeout plus a grace.
  const docker = dockerClient(s.socket, s.timeoutMs + DOCKER_GRACE_MS);
  return {
    async hasImage() {
      return (await docker.call("GET", `/images/${encodeURIComponent(s.image)}/json`).catch(() => null))?.status === 200;
    },
    async run(spec, signal) {
      // A stop can land before the listener below exists, while the container is being created.
      const stopped = () => {
        if (signal.aborted) throw new DOMException("run_code was stopped", "AbortError");
      };
      stopped();
      const created = JSON.parse((await docker.ok("POST", "/containers/create", containerConfig(s, spec.mounts))).toString()) as { Id: string };
      const id = created.Id;
      let timedOut = false;
      const kill = () => void docker.call("POST", `/containers/${id}/kill`).catch(() => {});
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, s.timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      try {
        stopped();
        await docker.ok("POST", `/containers/${id}/start`);
        stopped();
        const run = await docker.exec(id, command(spec));
        stopped();
        if (timedOut) return killedByTimeout(run);
        const out = await docker.exec(id, ["tar", "-C", "/out", "-cf", "-", "."], ARCHIVE_CAP_BYTES);
        const archive = readTar(out.stdout);
        const { files, omitted } = textFiles(archive.entries);
        return {
          exitCode: run.exitCode,
          timedOut: false,
          stdout: run.stdout.subarray(0, OUTPUT_CAP_BYTES).toString("utf8"),
          stderr: run.stderr.subarray(0, OUTPUT_CAP_BYTES).toString("utf8"),
          files,
          truncated: { stdout: run.stdoutBytes > OUTPUT_CAP_BYTES, stderr: run.stderrBytes > OUTPUT_CAP_BYTES, filesOmitted: omitted, filesUnlisted: !archive.complete || out.stdoutBytes > ARCHIVE_CAP_BYTES },
        };
      } catch (err) {
        // A kill at any stage, during start or an exec create, is the timeout, not a crash to retry.
        if (timedOut && !signal.aborted) return killedByTimeout();
        throw err;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        await docker.call("DELETE", `/containers/${id}?force=true&v=true`).catch(() => {});
      }
    },
  };
}

/** Text files first come, first kept, until 256 KB. A file with a NUL byte or invalid UTF-8 is not text. */
function textFiles(entries: readonly TarEntry[]): { files: { path: string; text: string }[]; omitted: string[] } {
  const files: { path: string; text: string }[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const e of entries) {
    if (e.type !== "file") continue;
    const path = e.name.replace(/^\.\//, "");
    const text = decodeText(e.data);
    if (text === null || used + e.data.length > FILES_CAP_BYTES) {
      omitted.push(path);
      continue;
    }
    used += e.data.length;
    files.push({ path, text });
  }
  return { files, omitted };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeText(data: Buffer): string | null {
  if (data.includes(0)) return null;
  try {
    return utf8.decode(data);
  } catch {
    return null;
  }
}

export interface TarEntry {
  readonly name: string;
  readonly type: "file" | "dir" | "other";
  readonly data: Buffer;
}

/**
 * ustar and GNU long names, which is what GNU tar writes. Stops at the zero block, and reports incomplete when the
 * stream ends inside an entry or holds more than TAR_ENTRIES_CAP entries. Throws on a size that is not a count.
 */
export function readTar(buf: Buffer): { readonly entries: TarEntry[]; readonly complete: boolean } {
  const out: TarEntry[] = [];
  let longName: string | null = null;
  for (let at = 0; at + 512 <= buf.length; ) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) return { entries: out, complete: true };
    if (out.length === TAR_ENTRIES_CAP) return { entries: out, complete: false };
    const field = (start: number, len: number) => h.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const sizeField = field(124, 12).trim();
    if (!/^[0-7]*$/.test(sizeField)) throw new Error(`tar header at byte ${at} has size ${JSON.stringify(sizeField)}, not an octal count`);
    const size = parseInt(sizeField || "0", 8);
    const flag = String.fromCharCode(h[156]!);
    if (at + 512 + size > buf.length) return { entries: out, complete: false };
    const data = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (flag === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    out.push({ name, type: flag === "0" || flag === "\0" ? "file" : flag === "5" ? "dir" : "other", data });
  }
  return { entries: out, complete: false };
}

interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

function dockerClient(socketPath: string, idleMs: number) {
  const send = (method: string, path: string, body: unknown, onData: (chunk: Buffer) => void): Promise<number> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ socketPath, method, path: `${API}${path}`, headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} }, (res) => {
        res.on("data", onData);
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      });
      // A daemon that accepts the connection and then stalls would otherwise hold the tool call forever.
      req.setTimeout(idleMs, () => req.destroy(new Error(`docker ${method} ${path.split("?")[0]}: no answer within ${idleMs} ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  const call = async (method: string, path: string, body?: unknown) => {
    const chunks: Buffer[] = [];
    const status = await send(method, path, body, (c) => chunks.push(c));
    return { status, body: Buffer.concat(chunks) };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`docker ${method} ${path.split("?")[0]}: ${r.status} ${r.body.toString("utf8").slice(0, 300).trim()}`);
    return r.body;
  };
  /** Runs cmd in the container and demultiplexes its output, keeping at most `keep` bytes of each stream. */
  const exec = async (id: string, cmd: readonly string[], keep = OUTPUT_CAP_BYTES + 1): Promise<ExecResult> => {
    const created = JSON.parse((await ok("POST", `/containers/${id}/exec`, { Cmd: cmd, User: "65534:65534", Env: EXEC_ENV, WorkingDir: "/work", AttachStdout: true, AttachStderr: true })).toString()) as { Id: string };
    const streams = { 1: { parts: [] as Buffer[], kept: 0, bytes: 0 }, 2: { parts: [] as Buffer[], kept: 0, bytes: 0 } };
    let pending = Buffer.alloc(0);
    const status = await send("POST", `/exec/${created.Id}/start`, { Detach: false, Tty: false }, (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) break;
        const s = streams[pending[0] === 2 ? 2 : 1];
        const frame = pending.subarray(8, 8 + size);
        s.bytes += size;
        if (s.kept < keep) {
          const part = frame.subarray(0, keep - s.kept);
          s.parts.push(part);
          s.kept += part.length;
        }
        pending = pending.subarray(8 + size);
      }
    });
    if (status !== 200) throw new Error(`docker exec start: ${status}`);
    const inspect = JSON.parse((await ok("GET", `/exec/${created.Id}/json`)).toString()) as { ExitCode: number | null; Running: boolean };
    return { exitCode: inspect.Running ? null : inspect.ExitCode, stdout: Buffer.concat(streams[1].parts), stderr: Buffer.concat(streams[2].parts), stdoutBytes: streams[1].bytes, stderrBytes: streams[2].bytes };
  };
  return { call, ok, exec };
}
