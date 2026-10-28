"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useRef, useState } from "react";
import { box, hashStyle, heading, muted, short } from "./styles.ts";

interface Turn {
  question: string;
  runId: string | null;
  agent: string | null;
  answer: string | null;
  error: string | null;
}

/**
 * A chat beside the form. Each message runs the saved draft's resolved hash
 * through the same intake, queue and worker as a published agent, with
 * trigger "test", and shows which version answered.
 */
export function TestThread() {
  const { id } = useDocumentInfo();
  const modified = useFormModified();
  const thread = useRef(Math.random().toString(36).slice(2, 10));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");

  if (!id) return <section style={box}><h4 style={heading}>Test thread</h4><p style={muted}>Save the agent to test it.</p></section>;

  const update = (n: number, patch: Partial<Turn>) => setTurns((ts) => ts.map((t, i) => (i === n ? { ...t, ...patch } : t)));

  async function send() {
    const question = text.trim();
    if (!question) return;
    setText("");
    const n = turns.length;
    setTurns((ts) => [...ts, { question, runId: null, agent: null, answer: null, error: null }]);
    const res = await fetch(`/api/agents/${id}/test`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: question, thread: thread.current }),
    });
    const body = (await res.json()) as { t?: string; runId?: string; agent?: string; userFacing?: string; error?: string };
    if (body.t !== "enqueued" || !body.runId) {
      update(n, { error: body.userFacing ?? body.error ?? "The test could not start." });
      return;
    }
    update(n, { runId: body.runId, agent: body.agent ?? null });
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const run = (await (await fetch(`/api/agents/test-runs/${body.runId}`, { credentials: "include" })).json()) as { replies: { kind: string; text: string }[]; outcome: string | null };
      const reply = run.replies.find((r) => r.kind === "reply");
      if (reply) return update(n, { answer: reply.text });
      if (run.outcome) return update(n, { error: `The run ended ${run.outcome} without a reply.` });
    }
    update(n, { error: "No reply after two minutes. Is a worker running?" });
  }

  return (
    <section style={box} data-testid="test-thread">
      <h4 style={heading}>Test thread</h4>
      <p style={muted}>{modified ? "Unsaved changes are not tested. Save first." : "Runs the saved draft. Nothing is published."}</p>
      <ol style={{ listStyle: "none", padding: 0, margin: "0 0 12px" }}>
        {turns.map((t, n) => (
          <li key={n} data-testid="test-turn" style={{ marginBottom: 12 }}>
            <p style={{ margin: 0 }}>
              <strong>You:</strong> {t.question}
            </p>
            {t.answer ? (
              <p style={{ margin: "4px 0 0" }} data-testid="test-answer">
                <strong>Agent:</strong> {t.answer}
              </p>
            ) : t.error ? (
              <p role="alert" style={{ margin: "4px 0 0", color: "var(--theme-error-500)" }}>
                {t.error}
              </p>
            ) : (
              <p style={muted}>Running...</p>
            )}
            {t.agent ? (
              <p style={{ ...muted, fontSize: "0.85em" }} data-testid="test-version" data-version={t.agent}>
                version <code style={hashStyle}>{short(t.agent)}</code>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      <textarea
        aria-label="Test message"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask what a lab member would ask"
        style={{ width: "100%", font: "inherit", padding: 8, borderRadius: 4, border: "1px solid var(--theme-elevation-150)", background: "var(--theme-input-bg)", color: "var(--theme-text)" }}
      />
      <Button buttonStyle="secondary" size="small" disabled={!text.trim()} onClick={send}>
        Send
      </Button>
    </section>
  );
}
