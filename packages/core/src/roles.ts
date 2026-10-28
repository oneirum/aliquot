/**
 * Who may do what to lab documents (agents and KBs). One table, read by agent
 * publish and KB publish alike.
 *
 *   member     uses agents: reads documents and tests drafts below D3
 *   author     drafts documents
 *   publisher  publishes to the lab below D3
 *   steward    the data steward: also publishes D3 and R (restricted agents and KBs)
 *   pi         also publishes D3 and R, and manages accounts and roles
 *
 * The study owner role joins with the freeze unit.
 */

import type { MemberId } from "./agent.ts";
import { rank, type DataClass } from "./dataclass.ts";

export const ROLES = ["member", "author", "publisher", "steward", "pi"] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  readonly id: MemberId;
  readonly role: Role;
}

const RESTRICTED: DataClass = "D3";

/** May this role move a head for a document at this class (an agent's ceiling, a KB snapshot's class)? */
export function mayPublish(role: Role, cls: DataClass): boolean {
  if (role === "steward" || role === "pi") return true;
  return role === "publisher" && rank(cls) < rank(RESTRICTED);
}

/**
 * May this role see what an unpublished document at this class produces (a
 * test reply, a compile report)? Below D3 every member may. At D3 and R it
 * takes the people who could publish there: a draft must not be a way to read
 * restricted data that no steward or PI approved.
 */
export function mayPreview(role: Role, cls: DataClass): boolean {
  return rank(cls) < rank(RESTRICTED) || mayPublish(role, cls);
}

export function mayEdit(role: Role): boolean {
  return role !== "member";
}

export function mayManageAccounts(role: Role): boolean {
  return role === "pi";
}

export type RoleRefusal = { readonly t: "role"; readonly role: Role; readonly cls: DataClass };

export function roleRefusal(actor: Actor, cls: DataClass): RoleRefusal | null {
  return mayPublish(actor.role, cls) ? null : { t: "role", role: actor.role, cls };
}

export function describeRoleRefusal(r: RoleRefusal): string {
  if (r.role === "member" || r.role === "author") return `${r.role === "member" ? "Members" : "Authors"} cannot publish. Ask a publisher.`;
  return `Publishing at ${r.cls} needs the data steward or the PI.`;
}
