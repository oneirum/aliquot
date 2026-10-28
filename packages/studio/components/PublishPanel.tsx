"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useState } from "react";
import { box, hashStyle, heading, issueList, muted, short } from "./styles.ts";

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

  if (!id) return <section style={box}><h4 style={heading}>Publish</h4><p style={muted}>Save the agent to publish it.</p></section>;

  async function runChecks() {
    setBusy(true);
    setOutcome(null);
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
    <section style={box} data-testid="publish-panel">
      <h4 style={heading}>Publish</h4>
      {modified ? <p style={muted}>Save your changes first. Checks and publish use the saved revision.</p> : null}
      <Button buttonStyle="secondary" size="small" disabled={busy || modified} onClick={runChecks}>
        Run checks
      </Button>
      {check || issues.length ? (
        <div data-testid="check-result">
          {passes ? (
            <p>
              All checks pass. This draft runs as version <code style={hashStyle}>{short(check!.version ?? "")}</code>
              {check!.head ? (
                <>
                  , replacing <code style={hashStyle}>{short(check!.head.version)}</code>.
                </>
              ) : (
                ". Nothing is live yet."
              )}
            </p>
          ) : (
            <>
              <p>Fix these before publishing:</p>
              <ul style={issueList}>
                {issues.map((i, n) => (
                  <li key={n}>
                    <strong>{i.field}</strong>: {i.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      {refusal ? (
        <p role="alert" data-testid="publish-refusal" style={{ color: "var(--theme-error-500)" }}>
          {refusal}
        </p>
      ) : null}
      {passes && !refusal ? (
        <>
          <label htmlFor="changelog" style={{ display: "block", marginTop: 12 }}>
            Changelog note (required)
          </label>
          <textarea
            id="changelog"
            name="changelog"
            rows={3}
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder="What changed and why"
            style={{ width: "100%", font: "inherit", padding: 8, borderRadius: 4, border: "1px solid var(--theme-elevation-150)", background: "var(--theme-input-bg)", color: "var(--theme-text)" }}
          />
          <Button buttonStyle="primary" size="small" disabled={!canPublish} onClick={publish}>
            Publish
          </Button>
        </>
      ) : null}
      {outcome ? (
        <p data-testid="publish-outcome" style={{ color: "var(--theme-success-500)" }}>
          {outcome}
        </p>
      ) : null}
    </section>
  );
}
