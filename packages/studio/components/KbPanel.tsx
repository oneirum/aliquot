"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useState } from "react";
import { box, hashStyle, heading, issueList, muted, short } from "./styles.ts";

type CompileResult = { t: "compiled"; snapshot: string; gaps: string[] } | { t: "failed"; reason: string } | null;
interface Compiled {
  snapshot: string;
  cls: string;
  gaps: string[];
  coverage: string;
}

/**
 * Compile and publish a knowledge base from its saved definition: attach the
 * file sources, compile, read the coverage report, publish, or publish over
 * the gaps with a note.
 */
export function KbPanel() {
  const { id } = useDocumentInfo();
  const modified = useFormModified();
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  if (!id) return <section style={box}><h4 style={heading}>Compile and publish</h4><p style={muted}>Save the definition to compile it.</p></section>;

  async function compile() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    setCompiled(null);
    setStatus("Compiling...");
    const attached = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
    const res = await fetch(`/api/knowledge-bases/${id}/compile`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: attached }) });
    const body = (await res.json()) as { jobId?: string; error?: string };
    if (!res.ok || !body.jobId) {
      setStatus(null);
      setError(body.error ?? "The compile could not start.");
      setBusy(false);
      return;
    }
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = (await (await fetch(`/api/knowledge-bases/compiles/${body.jobId}`, { credentials: "include" })).json()) as { result?: CompileResult; cls?: string; coverage?: string; error?: string };
      if (poll.error) {
        setStatus(null);
        setError(poll.error);
        setBusy(false);
        return;
      }
      if (poll.result?.t === "failed") {
        setStatus(null);
        setError(`The compile failed: ${poll.result.reason}`);
        setBusy(false);
        return;
      }
      if (poll.result?.t === "compiled") {
        setStatus(null);
        setCompiled({ snapshot: poll.result.snapshot, gaps: poll.result.gaps, cls: poll.cls ?? "", coverage: poll.coverage ?? "" });
        setBusy(false);
        return;
      }
    }
    setStatus(null);
    setError("No result after five minutes. Is a worker running?");
    setBusy(false);
  }

  async function publish() {
    if (!compiled) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/knowledge-bases/${id}/publish`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot: compiled.snapshot, note }),
    });
    const body = (await res.json()) as { ok?: boolean; overridden?: string[]; error?: string };
    setBusy(false);
    if (!res.ok || !body.ok) {
      setError(body.error ?? "Publish failed.");
      return;
    }
    setOutcome(`Published snapshot ${short(compiled.snapshot)}${body.overridden?.length ? ` over ${body.overridden.length} gap${body.overridden.length === 1 ? "" : "s"}, with your note` : ""}. Agents use it from their next message.`);
  }

  return (
    <section style={box} data-testid="kb-panel">
      <h4 style={heading}>Compile and publish</h4>
      {modified ? <p style={muted}>Save your changes first. Compile uses the saved definition.</p> : null}
      <label htmlFor="kb-files" style={{ display: "block" }}>
        Source files (.md or .txt), named as in Sources
      </label>
      <input id="kb-files" data-testid="kb-files" type="file" multiple accept=".md,.markdown,.txt" onChange={(e) => setFiles([...(e.target.files ?? [])])} style={{ margin: "4px 0 8px" }} />
      <Button buttonStyle="secondary" size="small" disabled={busy || modified} onClick={compile}>
        Compile
      </Button>
      {status ? <p style={muted}>{status}</p> : null}
      {compiled ? (
        <div data-testid="kb-compiled">
          <p>
            Snapshot <code style={hashStyle}>{short(compiled.snapshot)}</code>, class {compiled.cls}.{" "}
            {compiled.gaps.length ? `${compiled.gaps.length} coverage question${compiled.gaps.length === 1 ? " has" : "s have"} no supporting entry:` : "Every coverage question has a supporting entry."}
          </p>
          {compiled.gaps.length ? (
            <ul style={issueList} data-testid="kb-gaps">
              {compiled.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
          <details>
            <summary>Coverage report</summary>
            <pre data-testid="kb-coverage" style={{ whiteSpace: "pre-wrap", fontSize: "0.85em" }}>
              {compiled.coverage}
            </pre>
          </details>
          {compiled.gaps.length ? (
            <>
              <label htmlFor="kb-note" style={{ display: "block", marginTop: 12 }}>
                Note to publish over the gaps
              </label>
              <textarea
                id="kb-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why these gaps are acceptable"
                style={{ width: "100%", font: "inherit", padding: 8, borderRadius: 4, border: "1px solid var(--theme-elevation-150)", background: "var(--theme-input-bg)", color: "var(--theme-text)" }}
              />
            </>
          ) : null}
          <Button buttonStyle="primary" size="small" disabled={busy} onClick={publish}>
            {compiled.gaps.length && note.trim() ? "Publish over the gaps" : "Publish"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="kb-error" style={{ color: "var(--theme-error-500)" }}>
          {error}
        </p>
      ) : null}
      {outcome ? (
        <p data-testid="kb-outcome" style={{ color: "var(--theme-success-500)" }}>
          {outcome}
        </p>
      ) : null}
    </section>
  );
}
