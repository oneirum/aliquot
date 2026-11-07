/** Which code a trust run measured: HEAD's sha and any uncommitted change outside the files the run itself writes. */
import { execFileSync } from "node:child_process";

const OWN_OUTPUT = /^(docs\/trust\.(md|json)|docs\/trust-fix\.md|fixtures\/lab1\/live\/)/;

export function measuredCommit(root: string): { readonly sha: string; readonly dirty: readonly string[] } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    const sha = git("rev-parse", "HEAD").trim();
    const dirty = git("status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !OWN_OUTPUT.test(f));
    return { sha, dirty };
  } catch {
    return { sha: "unknown (not a git checkout)", dirty: [] };
  }
}
