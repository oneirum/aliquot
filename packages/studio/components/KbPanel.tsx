"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useState } from "react";
import { PanelStyle, short } from "./styles.ts";
import { Status } from "./Status.tsx";

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

  if (!id)
    return (
      <section className="aq-panel">
        <PanelStyle />
        <h4>Compile and publish</h4>
        <p className="aq-help">Save the definition first. Compile uses the saved revision.</p>
      </section>
    );

  /** A failed request or a body that is not JSON ends the busy state with a message, not a pulse that never stops. */
  const guarded = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch {
      setStatus(null);
      setError("The studio could not reach the server, or it answered with something unexpected. Reload and try again.");
      setBusy(false);
    }
  };

  async function compile() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    setCompiled(null);
    setStatus("Compiling. The worker reads each source and checks coverage…");
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
    <section className="aq-panel" data-testid="kb-panel">
      <PanelStyle />
      <h4>Compile and publish</h4>
      <p className="aq-help">{modified ? "Save your changes first. Compile uses the saved definition." : "Attach the source files, compile, read the coverage report, then publish."}</p>
      <label htmlFor="kb-files" className="aq-label">
        Source files (.md or .txt), named as in Sources
      </label>
      <input id="kb-files" data-testid="kb-files" type="file" multiple accept=".md,.markdown,.txt" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      <div className="aq-actions">
        <Button buttonStyle="secondary" size="small" disabled={busy || modified} onClick={guarded(compile)}>
          Compile
        </Button>
      </div>
      {status ? <Status kind="busy">{status}</Status> : null}
      {compiled ? (
        <div data-testid="kb-compiled">
          <Status kind={outcome ? "info" : compiled.gaps.length ? "warn" : "ok"}>
            Snapshot <code className="aq-hash">{short(compiled.snapshot)}</code>, class {compiled.cls}.{" "}
            {compiled.gaps.length ? `${compiled.gaps.length} coverage question${compiled.gaps.length === 1 ? " has" : "s have"} no supporting entry:` : "Every coverage question has a supporting entry."}
            {compiled.gaps.length ? (
              <ul className="aq-issues" data-testid="kb-gaps">
                {compiled.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            ) : null}
          </Status>
          <details style={{ marginTop: 10 }}>
            <summary>Coverage report</summary>
            <pre data-testid="kb-coverage" className="aq-pre">
              {compiled.coverage.split("\n").map((line, n) => (
                <span key={n}>{line}</span>
              ))}
            </pre>
          </details>
          {compiled.gaps.length ? (
            <>
              <label htmlFor="kb-note" className="aq-label">
                Note to publish over the gaps
              </label>
              <textarea id="kb-note" className="aq-field" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why these gaps are acceptable" />
            </>
          ) : null}
          <div className="aq-actions">
            <Button buttonStyle="primary" size="small" disabled={busy} onClick={guarded(publish)}>
              {compiled.gaps.length && note.trim() ? "Publish over the gaps" : "Publish"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <Status kind="error" testId="kb-error">
          {error}
        </Status>
      ) : null}
      {outcome ? (
        <Status kind="ok" testId="kb-outcome">
          {outcome}
        </Status>
      ) : null}
    </section>
  );
}
