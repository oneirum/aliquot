/**
 * Who a run answers, as retrieval needs it: a member id and the groups that
 * member is in.
 *
 * SEAM. Member identity and sign-on belong to the identity unit (aliquot-depth,
 * unit 11). Until it lands, MemberDirectory is read from lab.toml's
 * [directory] table: groups by member id, and the email addresses a Drive
 * permission names, mapped to a member or a group. The identity unit
 * replaces directoryFromConfig with its own MemberDirectory; nothing else here
 * changes.
 */

import { NO_MEMBER, type Viewer } from "./kb.ts";
import type { RunEvent, StoredEvent, Trigger } from "./record.ts";

export interface MemberDirectory {
  groupsOf(memberId: string): readonly string[];
  /** The member a Drive user permission's email names, or null when it names no lab member. */
  memberForEmail(email: string): string | null;
  /** The group a Drive group permission's email names, or null. */
  groupForEmail(email: string): string | null;
}

export interface DirectoryConfig {
  /** Group name -> member ids. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
  /** Email -> member id, or "group:<name>" for a group's address. */
  readonly emails: Readonly<Record<string, string>>;
}

export const EMPTY_DIRECTORY: MemberDirectory = { groupsOf: () => [], memberForEmail: () => null, groupForEmail: () => null };

export function directoryFromConfig(c: DirectoryConfig): MemberDirectory {
  const byEmail = new Map(Object.entries(c.emails).map(([e, v]) => [e.toLowerCase(), v]));
  return {
    groupsOf: (id) => Object.entries(c.groups).filter(([, members]) => members.includes(id)).map(([g]) => g).sort(),
    memberForEmail: (email) => {
      const v = byEmail.get(email.toLowerCase());
      return v && !v.startsWith("group:") ? v : null;
    },
    groupForEmail: (email) => {
      const v = byEmail.get(email.toLowerCase());
      return v?.startsWith("group:") ? v.slice("group:".length) : null;
    },
  };
}

/** A message or a test has a member. A schedule, an eval or a replay has none, and sees lab-wide entries only. */
export function viewerFor(trigger: Trigger | undefined, directory: MemberDirectory): Viewer {
  if (!trigger || (trigger.t !== "message" && trigger.t !== "test")) return NO_MEMBER;
  return { memberId: trigger.memberId, groups: directory.groupsOf(trigger.memberId) };
}

/** The viewer of the run whose events these are, from its run.started. */
export function runViewer(events: readonly (StoredEvent | { readonly event: RunEvent })[], directory: MemberDirectory): Viewer {
  const started = events.find((e) => e.event.t === "run.started")?.event;
  return viewerFor(started?.t === "run.started" ? started.trigger : undefined, directory);
}
