import type { ReactNode } from "react";

/** One line of panel state. Busy and done are announced politely; an error is an alert. */
export function Status({ kind, testId, children }: { kind: "busy" | "ok" | "warn" | "error" | "info"; testId?: string; children: ReactNode }) {
  return (
    <div className="aq-status" data-kind={kind} role={kind === "error" ? "alert" : "status"} data-testid={testId}>
      <div>{children}</div>
    </div>
  );
}
