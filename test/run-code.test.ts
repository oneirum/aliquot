/**
 * run_code against the real Docker daemon and the image sandbox/Dockerfile builds. Skips, naming what is missing,
 * when no daemon answers or the image was not built: docker build -t aliquot-sandbox sandbox.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, Labelled, type DataClass } from "../packages/core/src/dataclass.ts";
import { createKbReader, memorySnapshots } from "../packages/core/src/kb.ts";
import { builtinTools, createHttpEgress, createToolRunner, registryOf, type ToolEnv } from "../packages/core/src/tools.ts";
import { createSandbox, readTar, TAR_ENTRIES_CAP } from "../packages/core/src/sandbox.ts";
import type { Dataset, SandboxConfig } from "../packages/core/src/config.ts";
import type { RunId } from "../packages/core/src/record.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";
import { memoryJournal } from "./recorder.ts";

const IMAGE_TAG = "aliquot-sandbox";

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

function candidateSockets(): string[] {
  const out: string[] = [];
  if (process.env.DOCKER_HOST?.startsWith("unix://")) out.push(process.env.DOCKER_HOST.slice(7));
  try {
    const host = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (host.startsWith("unix://")) out.push(host.slice(7));
  } catch {}
  out.push("/var/run/docker.sock");
  return out;
}

async function findDocker(): Promise<{ socket: string; image: string } | string> {
  for (const socket of candidateSockets()) {
    if ((await get(socket, "/_ping")).status !== 200) continue;
    const image = await get(socket, `/images/${IMAGE_TAG}/json`);
    if (image.status !== 200) return `the ${IMAGE_TAG} image is not built (docker build -t ${IMAGE_TAG} sandbox)`;
    return { socket, image: (JSON.parse(image.body) as { Id: string }).Id };
  }
  return "no Docker daemon answered on its unix socket";
}

const docker = await findDocker();
const skip = typeof docker === "string" ? docker : false;
const opts = { skip };

const root = await realpath(await mkdtemp(join(tmpdir(), "run-code-")));
after(() => rm(root, { recursive: true, force: true }));

/** A dataset directory the container's user 65534 can read, as a lab's must be. */
async function dataset(id: string, cls: DataClass, files: Record<string, string>): Promise<Dataset> {
  const path = join(root, id);
  await mkdir(path);
  for (const [name, body] of Object.entries(files)) await writeFile(join(path, name), body);
  await chmod(path, 0o755);
  for (const name of Object.keys(files)) await chmod(join(path, name), 0o644);
  return { id, path, cls, description: `${id} for the run_code tests` };
}

const visits = await dataset("visits", "D1", { "visits.csv": "participant,hours\n1,6.5\n2,7.5\n3,8\n4,5.5\n" });
const cohort = await dataset("cohort", "D2", { "cohort.csv": "id,score\n1,10\n2,20\n" });
const restricted = await dataset("restricted", "D3", { "notes.txt": "restricted\n" });
const linked = await dataset("linked", "D1", { "ok.csv": "a\n1\n" });
await writeFile(join(root, "secret.txt"), "outside the dataset\n");
await symlink(join(root, "secret.txt"), join(linked.path, "escape.txt"));

const config: SandboxConfig | null = typeof docker === "string" ? null : { image: docker.image, digest: docker.image.slice(7) as Sha256, cpus: 1, memoryMb: 512, timeoutMs: 20_000, socket: docker.socket };
const datasets = [visits, cohort, restricted, linked];

function runnerWith(timeoutMs?: number) {
  return createToolRunner(registryOf(builtinTools()), {
    http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {} }),
    kb: createKbReader(memorySnapshots([])),
    datasets,
    sandbox: config ? createSandbox({ ...config, ...(timeoutMs ? { timeoutMs } : {}) }) : null,
  });
}

const env: ToolEnv = {
  knowledgeBases: [],
  retrieval: { algorithm: "bm25-v1", readCapTokens: 1000 },
  sandbox: { mountCeiling: "D2", mounts: ["visits", "cohort", "restricted", "linked"] },
};

async function runCode(input: { language: "r" | "python"; code: string; datasets?: string[] }, inputClass: DataClass = "D0", runner = runnerWith()) {
  const j = memoryJournal("00000000-0000-4000-8000-0000000000cc" as RunId);
  const ref = await j.put(Labelled.stamp(input, inputClass, "test"));
  await runner.invoke(j, { callId: "c1", tool: "run_code", attempt: 1, input: ref }, env, new AbortController().signal);
  const last = j.log.at(-1)!;
  if (last.t === "tool.completed") return { cls: last.output.cls, out: j.body(last.output) as { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; files: { path: string; text: string }[] } };
  assert.equal(last.t, "tool.failed");
  if (last.t !== "tool.failed") throw new Error("unreachable");
  return { cls: last.failure.detail?.cls ?? null, failure: last.failure.code, detail: last.failure.detail ? j.body(last.failure.detail) : null };
}

async function leftoverContainers(): Promise<number> {
  if (typeof docker === "string") return 0;
  const filters = encodeURIComponent(JSON.stringify({ label: ["aliquot.run_code=1"] }));
  return (JSON.parse((await get(docker.socket, `/containers/json?all=true&filters=${filters}`)).body) as unknown[]).length;
}

test("R computes over a mounted CSV and returns stdout and a file written to /out", opts, async () => {
  const r = await runCode({ language: "r", code: 'd <- read.csv("/data/visits/visits.csv"); cat(mean(d$hours), "\\n"); writeLines(format(sd(d$hours), digits = 4), "/out/sd.txt")', datasets: ["visits"] });
  assert.deepEqual(r, { cls: "D1", out: { exitCode: 0, timedOut: false, stdout: "6.875 \n", stderr: "", files: [{ path: "sd.txt", text: "1.109\n" }], truncated: { stdout: false, stderr: false, filesOmitted: [], filesUnlisted: false } } });
});

test("Python with pandas and statsmodels computes over a mounted CSV", opts, async () => {
  const code = ["import pandas as pd, statsmodels.api as sm", 'd = pd.read_csv("/data/cohort/cohort.csv")', "fit = sm.OLS(d.score, sm.add_constant(d.id)).fit()", 'print(round(fit.params["id"], 6))'].join("\n");
  const r = await runCode({ language: "python", code, datasets: ["cohort"] });
  assert.deepEqual(r, { cls: "D2", out: { exitCode: 0, timedOut: false, stdout: "10.0\n", stderr: "", files: [], truncated: { stdout: false, stderr: false, filesOmitted: [], filesUnlisted: false } } });
});

test("the output class is the join of the question and every mounted dataset", opts, async () => {
  assert.equal((await runCode({ language: "python", code: "print(1)" })).cls, "D0");
  assert.equal((await runCode({ language: "python", code: "print(1)", datasets: ["visits"] })).cls, "D1");
  assert.equal((await runCode({ language: "python", code: "print(1)", datasets: ["visits", "cohort"] })).cls, "D2");
  assert.equal((await runCode({ language: "python", code: "print(1)", datasets: ["visits"] }, "D2")).cls, "D2");
});

test("the container has no network: a TCP connect fails", opts, async () => {
  const code = ["import socket", "try:", "    socket.create_connection(('1.1.1.1', 53), timeout=3)", "    print('connected')", "except OSError as e:", "    print('refused', type(e).__name__)"].join("\n");
  const r = await runCode({ language: "python", code });
  assert.ok("out" in r);
  assert.match(r.out!.stdout, /^refused (OSError|TimeoutError|ConnectionRefusedError)\n$/);
});

test("the dataset mount is read-only", opts, async () => {
  const r = await runCode({ language: "python", code: "open('/data/visits/visits.csv', 'a').write('x')", datasets: ["visits"] });
  assert.ok("out" in r);
  assert.equal(r.out!.exitCode, 1);
  assert.match(r.out!.stderr, /OSError: \[Errno 30\] Read-only file system/);
});

test("the root filesystem is read-only and the code runs as 65534", opts, async () => {
  const r = await runCode({ language: "python", code: "import os\nprint(os.getuid(), os.getgid())\nopen('/etc/x', 'w')" });
  assert.ok("out" in r);
  assert.equal(r.out!.stdout, "65534 65534\n");
  assert.match(r.out!.stderr, /Read-only file system: '\/etc\/x'/);
});

test("the code runs with no capabilities, no new privileges, and the CPU, memory and process limits", opts, async () => {
  const code = [
    "status = dict(l.split(':\\t', 1) for l in open('/proc/self/status').read().splitlines() if ':\\t' in l)",
    "print(status['CapBnd'].strip(), status['NoNewPrivs'].strip())",
    "for f in ('cpu.max', 'memory.max', 'pids.max'): print(f, open('/sys/fs/cgroup/' + f).read().strip())",
  ].join("\n");
  const r = await runCode({ language: "python", code });
  assert.ok("out" in r);
  assert.equal(r.out!.stdout, "0000000000000000 1\ncpu.max 100000 100000\nmemory.max 536870912\npids.max 256\n");
});

test("/work and /out are the only writable paths: there is no /dev/shm", opts, async () => {
  const r = await runCode({ language: "python", code: "import os\nprint(os.path.exists('/dev/shm'))\nopen('/dev/shm/x', 'w')" });
  assert.ok("out" in r);
  assert.equal(r.out!.stdout, "False\n");
  assert.match(r.out!.stderr, /No such file or directory: '\/dev\/shm\/x'/);
});

test("the timeout kills the container and the container is removed", opts, async () => {
  const started = Date.now();
  const r = await runCode({ language: "python", code: "import time\nprint('started', flush=True)\ntime.sleep(60)" }, "D0", runnerWith(3000));
  assert.ok("out" in r);
  assert.deepEqual({ exitCode: r.out!.exitCode, timedOut: r.out!.timedOut, stdout: r.out!.stdout }, { exitCode: null, timedOut: true, stdout: "started\n" });
  assert.ok(Date.now() - started < 20_000, "killed at the timeout, not at the end of the sleep");
  assert.equal(await leftoverContainers(), 0);
});

test("a dataset holding a symlink that points outside it is refused before any container starts", opts, async () => {
  const r = await runCode({ language: "python", code: "print(open('/data/linked/escape.txt').read())", datasets: ["linked"] });
  assert.deepEqual(r, { cls: "D1", failure: "invalid-input", detail: "dataset linked: escape.txt points outside the dataset directory" });
});

test("a dataset above the mount ceiling, or not in the agent's mounts, is refused", opts, async () => {
  assert.deepEqual(await runCode({ language: "r", code: "1", datasets: ["restricted"] }), { cls: "D0", failure: "invalid-input", detail: "dataset restricted is not one this agent may mount; dataset_list names those it may" });
  assert.deepEqual(await runCode({ language: "r", code: "1", datasets: ["nonesuch"] }), { cls: "D0", failure: "invalid-input", detail: "dataset nonesuch is not one this agent may mount; dataset_list names those it may" });
});

test("dataset_list names only the datasets the agent may mount, with their files, at the highest class it lists", async () => {
  const j = memoryJournal("00000000-0000-4000-8000-0000000000cd" as RunId);
  const ref = await j.put(Labelled.stamp({}, "D0", "test"));
  await runnerWith().invoke(j, { callId: "l1", tool: "dataset_list", attempt: 1, input: ref }, env, new AbortController().signal);
  const last = j.log.at(-1)!;
  assert.equal(last.t, "tool.completed");
  assert.deepEqual(last.t === "tool.completed" && j.body(last.output), {
    datasets: [
      { id: "visits", class: "D1", description: "visits for the run_code tests", files: ["visits.csv"] },
      { id: "cohort", class: "D2", description: "cohort for the run_code tests", files: ["cohort.csv"] },
      { id: "linked", class: "D1", description: "linked for the run_code tests", files: ["escape.txt", "ok.csv"] },
    ],
  });
  assert.equal(last.t === "tool.completed" && (await j.get(last.output)).cls, "D2");
});

test("a tool core does not own, such as a harness plant, cannot reach the sandbox through the built-in's code", async () => {
  const runCodeTool = builtinTools().find((t) => t.manifest.name === "run_code")!;
  const borrowed = { ...runCodeTool, owner: "test/plants/run_code.ts" };
  const runner = createToolRunner(registryOf([borrowed]), { http: createHttpEgress({ policy: DEFAULT_POLICY, hosts: {} }), kb: createKbReader(memorySnapshots([])), datasets, sandbox: config ? createSandbox(config) : null });
  const r = await runCode({ language: "python", code: "print(1)", datasets: ["visits"] }, "D0", runner);
  assert.deepEqual(r, { cls: "D0", failure: "thrown", detail: "only core's own tools may use the sandbox" });
});

test("the tar reader returns GNU long names and file bodies", () => {
  const block = (name: string, size: number, flag: string) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(size.toString(8).padStart(11, "0"), 124);
    h.write(flag, 156);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const long = `./${"d".repeat(120)}.txt`;
  const tar = Buffer.concat([block("./", 0, "5"), block("././@LongLink", long.length + 1, "L"), pad(Buffer.from(`${long}\0`)), block(long.slice(0, 100), 3, "0"), pad(Buffer.from("abc")), Buffer.alloc(1024)]);
  const read = readTar(tar);
  assert.deepEqual(
    [read.complete, read.entries.map((e) => [e.name, e.type, e.data.toString()])],
    [
      true,
      [
        ["./", "dir", ""],
        [long, "file", "abc"],
      ],
    ],
  );
  const cut = readTar(Buffer.concat([block("a.txt", 3, "0"), pad(Buffer.from("abc")), block("b.txt", 4096, "0"), Buffer.alloc(512)]));
  assert.deepEqual([cut.complete, cut.entries.map((e) => e.name)], [false, ["a.txt"]], "a stream that ends inside an entry is incomplete and the partial entry is dropped");
  const many = readTar(Buffer.concat([...Array.from({ length: TAR_ENTRIES_CAP + 1 }, (_, i) => block(`f${i}`, 0, "0")), Buffer.alloc(1024)]));
  assert.deepEqual([many.complete, many.entries.length], [false, TAR_ENTRIES_CAP]);
});

test("the tar reader refuses a size field that is not an octal count instead of looping", () => {
  const h = Buffer.alloc(512);
  h.write("a.txt", 0);
  h.write("-1000", 124);
  h.write("0", 156);
  assert.throws(() => readTar(Buffer.concat([h, Buffer.alloc(1024)])), { message: 'tar header at byte 0 has size "-1000", not an octal count' });
});

test("the daemon is asked for the pinned image, so a digest it does not hold is not deployed", opts, async () => {
  assert.equal(await createSandbox(config!).hasImage(), true);
  assert.equal(await createSandbox({ ...config!, image: `sha256:${"0".repeat(64)}` }).hasImage(), false);
});
