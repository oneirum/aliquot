/**
 * The lab's datasets as run_code and dataset_list see them: which ones an
 * agent may mount, and the host directory each mount reads. A mount is the
 * declared path itself, never where a symlink leads, so a link planted in a
 * dataset directory cannot widen what the container sees.
 */

import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { atMost, type DataClass } from "./dataclass.ts";
import type { Dataset } from "./config.ts";

export interface MountPolicy {
  readonly mountCeiling: DataClass;
  readonly mounts: readonly string[];
}

/** The datasets the agent names in its mounts that lab.toml declares at or below its mount ceiling, in the agent's order. */
export function mountable(policy: MountPolicy | null, datasets: readonly Dataset[]): Dataset[] {
  if (!policy) return [];
  return policy.mounts.flatMap((id) => datasets.filter((d) => d.id === id && atMost(d.cls, policy.mountCeiling)));
}

export type MountCheck = { readonly ok: true; readonly hostPath: string } | { readonly ok: false; readonly reason: string };

const within = (root: string, p: string) => p === root || p.startsWith(root + sep);

/**
 * The directory to bind for one dataset, checked now rather than at boot because its contents change. Refused when the
 * declared path resolves elsewhere, when anything inside it resolves outside it, or when a file in it has another hard
 * link.
 */
export async function checkMount(d: Dataset): Promise<MountCheck> {
  let root: string;
  try {
    root = await realpath(d.path);
  } catch {
    return { ok: false, reason: `dataset ${d.id}: ${d.path} does not exist` };
  }
  if (root !== d.path) return { ok: false, reason: `dataset ${d.id}: ${d.path} resolves to ${root}; declare the real path` };
  for (const p of await walk(root)) {
    const real = await realpath(p).catch(() => null);
    if (real === null || !within(root, real)) return { ok: false, reason: `dataset ${d.id}: ${relative(root, p)} points outside the dataset directory` };
    // A hard link passes realpath but can be the same inode as a file of a higher class elsewhere on the filesystem.
    const st = await lstat(p);
    if (st.isFile() && st.nlink > 1) return { ok: false, reason: `dataset ${d.id}: ${relative(root, p)} has ${st.nlink} hard links; copy the file into the dataset instead` };
  }
  return { ok: true, hostPath: root };
}

export async function listFiles(d: Dataset, max: number): Promise<{ readonly files: readonly string[]; readonly more: boolean }> {
  const all = (await walk(d.path, false).catch(() => [])).map((p) => relative(d.path, p)).sort();
  return { files: all.slice(0, max), more: all.length > max };
}

/** Every entry under dir, without following links. With dirs false, only non-directories. */
async function walk(dir: string, dirs = true): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (dirs) out.push(p);
      out.push(...(await walk(p, dirs)));
    } else out.push(p);
  }
  return out;
}
