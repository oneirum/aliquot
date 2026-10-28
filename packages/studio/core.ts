/**
 * The studio's handle on core: one booted studio core per server process, and
 * the mapping from a signed-in studio user to core's Actor. The studio reaches
 * core only through @labh/core/studio, which holds no model gateway and no tool
 * runner. Core never imports this package.
 */

import { bootStudio, mayEdit, ROLES, type Actor, type MemberId, type Role, type StudioCore } from "@labh/core/studio";

const holder = globalThis as typeof globalThis & { labhCore?: Promise<StudioCore> };

export function core(): Promise<StudioCore> {
  // A failed boot (Postgres down at the first request) is not kept: the next request tries again.
  holder.labhCore ??= bootStudio(process.env.LABH_CONFIG ?? "lab.toml").catch((err: unknown) => {
    holder.labhCore = undefined;
    throw err;
  });
  return holder.labhCore;
}

export const roleOf = (user: unknown): Role | null => {
  const role = user && typeof user === "object" && "role" in user ? user.role : null;
  return (ROLES as readonly unknown[]).includes(role) ? (role as Role) : null;
};

export const isEditor = (user: unknown): boolean => {
  const role = roleOf(user);
  return role !== null && mayEdit(role);
};

/** The studio email is the member id until university sign-on links accounts (DESIGN.md, Identity). */
export function actorOf(user: unknown): Actor | null {
  const role = roleOf(user);
  if (!role || !user || typeof user !== "object" || !("email" in user) || typeof user.email !== "string") return null;
  return { id: user.email as MemberId, role };
}
