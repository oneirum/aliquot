"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useState } from "react";
import { PanelStyle, short } from "./styles.ts";
import { Status } from "./Status.tsx";

interface Issue {
  field: string;
  message: string;
}
interface Check {
  draftHash: string;
  version: string | null;
  head: { version: string; publishedAt: string; changelog: string } | null;
  validation: Issue[];
}
type Result = { t: "published" | "unchanged"; head: { version: string } };

/**
 * Publish: run the checks on the saved draft, read them, write a changelog
 * note, confirm. The server refuses anything the checks did not cover.
 */
export function PublishPanel() {
  const { id } = useDocumentInfo();
  const modified = useFormModified();
  const [check, setCheck] = useState<Check | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  if (!id)
    return (
      <section className="aq-panel">
        <PanelStyle />
        <h4>Publish</h4>
        <p className="aq-help">Save the agent first. Checks and publish use a saved revision.</p>
      </section>
    );

  /** A failed request or a body that is not JSON ends the busy state with a message, not a pulse that never stops. */
  const guarded = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch {
      setRefusal("The studio could not reach the server, or it answered with something unexpected. Reload and try again.");
      setBusy(false);
    }
  };

  async function runChecks() {
    setBusy(true);
    setOutcome(null);
    setCheck(null);
    setIssues([]);
    setRefusal(null);
    const res = await fetch(`/api/agents/${id}/check`, { method: "POST", credentials: "include" });
    const body = (await res.json()) as { check: Check | null; issues?: Issue[]; refusal?: string | null; error?: string };
    setCheck(body.check);
    setIssues(body.check?.validation ?? body.issues ?? []);
    setRefusal(body.error ?? body.refusal ?? null);
    setBusy(false);
  }

  async function publish() {
    if (!check) return;
    setBusy(true);
    const res = await fetch(`/api/agents/${id}/publish`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftHash: check.draftHash, changelog }),
    });
    const body = (await res.json()) as Result & { error?: string };
    setBusy(false);
    if (!res.ok) {
      setOutcome(null);
      setRefusal(body.error ?? "Publish failed.");
      return;
    }
    setOutcome(body.t === "published" ? `Published version ${short(body.head.version)}.` : `Already live as version ${short(body.head.version)}.`);
    setCheck(null);
    setChangelog("");
  }

  const passes = check !== null && issues.length === 0;
  const canPublish = passes && !refusal && changelog.trim().length > 0 && !modified && !busy;

  return (
    <section className="aq-panel" data-testid="publish-panel">
      <PanelStyle />
      <h4>Publish</h4>
      <p className="aq-help">{modified ? "Save your changes first. Checks and publish use the saved revision." : "Run the checks on the saved revision, then publish it with a note."}</p>
      <div className="aq-actions">
        <Button buttonStyle="secondary" size="small" disabled={busy || modified} onClick={guarded(runChecks)}>
          Run checks
        </Button>
      </div>
      {busy && !check && !issues.length ? <Status kind="busy">Checking the saved revision…</Status> : null}
      {busy && check ? <Status kind="busy">Publishing…</Status> : null}
      {check || issues.length ? (
        <div data-testid="check-result">
          {passes ? (
            <Status kind="ok">
              All checks pass. This draft runs as version <code className="aq-hash">{short(check!.version ?? "")}</code>
              {check!.head ? (
                <>
                  , replacing <code className="aq-hash">{short(check!.head.version)}</code>.
                </>
              ) : (
                ". Nothing is live yet."
              )}
            </Status>
          ) : (
            <Status kind="error">
              Fix these before publishing:
              <ul className="aq-issues">
                {issues.map((i, n) => (
                  <li key={n}>
                    <strong>{i.field}</strong>: {i.message}
                  </li>
                ))}
              </ul>
            </Status>
          )}
        </div>
      ) : null}
      {refusal ? (
        <Status kind="error" testId="publish-refusal">
          {refusal}
        </Status>
      ) : null}
      {passes && !refusal ? (
        <>
          <label htmlFor="changelog" className="aq-label">
            Changelog note (required)
          </label>
          <textarea id="changelog" name="changelog" className="aq-field" rows={3} value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="What changed and why" />
          <div className="aq-actions">
            <Button buttonStyle="primary" size="small" disabled={!canPublish} onClick={guarded(publish)} aria-describedby={changelog.trim() ? undefined : "publish-hint"}>
              Publish
            </Button>
            {changelog.trim() ? null : <span className="aq-ver" id="publish-hint">Write a note to publish.</span>}
          </div>
        </>
      ) : null}
      {outcome ? (
        <Status kind="ok" testId="publish-outcome">
          {outcome}
        </Status>
      ) : null}
    </section>
  );
}
