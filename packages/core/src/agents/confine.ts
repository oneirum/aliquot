/**
 * macOS confinement for an agent CLI: a seatbelt profile generated per
 * session. It denies by default and allows, by enumeration, only what the
 * CLIs were seen to need when probed under the sandbox. The profile is text;
 * agents/spawn.ts is what runs it.
 */

import { accessSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConfinePlan {
  /** Real path of the session workspace. The CLI's state dir, HOME and TMPDIR all live inside it. */
  readonly workspace: string;
  /** Real paths the CLI may execute: the node binary for a node script, the CLI binary, and anything under execRoots. */
  readonly exec: readonly string[];
  /** Real paths of directories whose files may be executed (a node CLI that starts a native binary from its package). */
  readonly execRoots: readonly string[];
  /** Real paths of the CLI's install directories, readable. */
  readonly readRoots: readonly string[];
  readonly ports: { readonly bridge: number; readonly proxy: number };
  /** Claude Code under dev_shared_login only: the operator's keychains directory, readable, which its login is in. */
  readonly devLogin?: { readonly keychainDir: string };
}

/**
 * Where a node CLI's code lives: its package directory, which the sandbox lets it read and execute from (Codex
 * starts a native binary from there), and node's own install, whose libraries it loads. A Homebrew node links
 * libraries from other kegs, so for one the readable roots are Cellar and opt, not etc or var. Any other node gets its
 * binary and its prefix's lib and include, never the prefix itself: /usr/local or /opt/local can hold var/postgres.
 */
export function installRoots(cli: { readonly binary: string; readonly node: string | null }): Pick<ConfinePlan, "exec" | "execRoots" | "readRoots"> {
  const exec = cli.node ? [cli.node, cli.binary] : [cli.binary];
  const pkg = packageDir(cli.binary);
  const readRoots = [cli.node ? pkg : cli.binary];
  if (cli.node) {
    const brew = /^(.*)\/Cellar\//.exec(cli.node);
    const prefix = dirname(dirname(cli.node));
    readRoots.push(...(brew ? [`${brew[1]}/Cellar`, `${brew[1]}/opt`] : [cli.node, join(prefix, "lib"), join(prefix, "include")]));
    const conf = brew ? `${brew[1]}/etc/openssl@3/openssl.cnf` : null;
    if (conf) readRoots.push(conf);
  }
  return { exec, execRoots: cli.node ? [pkg] : [], readRoots };
}

/** The nearest directory above a script that holds a package.json, else the script's own directory. */
function packageDir(script: string): string {
  for (let dir = dirname(script); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      accessSync(join(dir, "package.json"));
      return dir;
    } catch {
      // keep climbing
    }
  }
  return dirname(script);
}

/** Whether this platform has a confinement implementation. Running a CLI unconfined is never a fallback. */
export function confinementAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

const quote = (p: string): string => JSON.stringify(p);
const literals = (ps: readonly string[]): string => ps.map((p) => `(literal ${quote(p)})`).join(" ");
const subpaths = (ps: readonly string[]): string => ps.map((p) => `(subpath ${quote(p)})`).join(" ");

/**
 * What the CLIs were seen to need, probed one at a time under `(deny default)` with the environment spawn.ts
 * builds: claude 2.1.303 (Bun), codex-cli 0.155.1 (node starting its native binary), and plain node 26. Each
 * entry names who needed it. Everything else they tried stays denied and they still reached their vendor:
 * /usr/bin/security, git, /bin/sh, /bin/ps, /etc/passwd, a unix socket bind in the workspace, and the mach
 * services diagnosticd, logd, opendirectoryd.libinfo, SecurityServer, trustd, FSEvents, configd and coreservicesd.
 */
const NEED = {
  readTrees: [
    // all three: the dyld shared cache and system libraries
    "/usr/lib",
    "/System/Library",
    "/System/Volumes/Preboot/Cryptexes",
    // claude: ICU data and time zones
    "/usr/share/icu",
    "/private/var/db/timezone",
    // codex: its managed-config directory; absent here, and it must read as ENOENT, not EPERM, or codex exits
    "/private/etc/codex",
  ],
  readFiles: [
    // all three
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
    // all three abort at startup unless they can read the root directory's entries
    "/",
    // claude
    "/private/etc/localtime",
    // codex: the CA bundle SSL_CERT_FILE names, so it verifies TLS without trustd
    "/private/etc/ssl/cert.pem",
  ],
  // claude stats /var, codex stats /etc
  statLinks: ["/etc", "/var"],
  // all three abort at startup without these: libsystem's lockdown-mode check, and the OS and CPU identity
  sysctls: [
    "security.mac.lockdown_mode_state",
    "kern.bootargs",
    "kern.hostname",
    "kern.iossupportversion",
    "kern.osproductversion",
    "kern.osrelease",
    "kern.ostype",
    "kern.osvariant_status",
    "kern.version",
    "hw.activecpu",
    "hw.ephemeral_storage",
    "hw.machine",
    "hw.memsize",
    "hw.ncpu",
    "hw.pagesize_compat",
    "machdep.cpu.brand_string",
  ],
  // CPU feature flags, a different set per chip: claude's JIT and codex's crypto read them, claude sizes thread pools by perflevel
  sysctlPrefixes: ["hw.optional.", "hw.perflevel"],
} as const;

/** Every directory above a path, so that resolving the path can stat each step without listing any of them. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    out.push(dir);
    if (dir === dirname(dir)) return out;
  }
}

/** What a Claude Code login from the keychain needs, under dev_shared_login only: claude reads it by running security. */
const DEV_KEYCHAIN_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"];
const DEV_KEYCHAIN_EXEC = "/usr/bin/security";

export function seatbeltProfile(plan: ConfinePlan): string {
  const keychainDir = plan.devLogin?.keychainDir ?? null;
  const trees = [...NEED.readTrees, ...plan.readRoots, plan.workspace, ...(keychainDir ? [keychainDir] : [])];
  const stat = [...new Set([...NEED.statLinks, ...[...trees, ...NEED.readFiles, ...plan.exec].flatMap(ancestors)])].sort();
  const lines = [
    "(version 1)",
    "(deny default)",
    `(allow process-exec ${literals([...plan.exec, ...(keychainDir ? [DEV_KEYCHAIN_EXEC] : [])])} ${subpaths(plan.execRoots)})`,
    // codex: node starts the native binary, and forwards SIGTERM to it; without signal the binary outlives a stop
    "(allow process-fork)",
    "(allow signal (target children))",
    `(allow sysctl-read ${NEED.sysctls.map((n) => `(sysctl-name ${quote(n)})`).join(" ")} ${NEED.sysctlPrefixes.map((n) => `(sysctl-name-prefix ${quote(n)})`).join(" ")})`,
    `(allow file-read* ${subpaths(trees)} ${literals(NEED.readFiles)})`,
    `(allow file-read-metadata ${literals(stat)})`,
    `(allow file-write* (subpath ${quote(plan.workspace)}) (literal "/dev/null"))`,
    `(allow network-outbound (remote ip ${quote(`localhost:${plan.ports.bridge}`)}) (remote ip ${quote(`localhost:${plan.ports.proxy}`)}))`,
    ...(keychainDir ? [`(allow mach-lookup ${DEV_KEYCHAIN_SERVICES.map((n) => `(global-name ${quote(n)})`).join(" ")})`] : []),
  ];
  return `${lines.join("\n")}\n`;
}
