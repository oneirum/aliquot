"use client";

import { Button, useDocumentInfo, useFormModified } from "@payloadcms/ui";
import { useRef, useState } from "react";
import { PanelStyle, short } from "./styles.ts";
import { Status } from "./Status.tsx";

/** Marks an answer taller than its cap, so the panel shows an edge where the scrollable text continues. */
const markOverflow = (el: HTMLElement | null) => {
  el?.toggleAttribute("data-overflow", el.scrollHeight > el.clientHeight);
};

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

  if (!id)
    return (
      <section className="aq-panel">
        <PanelStyle />
        <h4>Test thread</h4>
        <p className="aq-help">Save the agent first. The test runs the saved revision.</p>
      </section>
    );

  const update = (n: number, patch: Partial<Turn>) => setTurns((ts) => ts.map((t, i) => (i === n ? { ...t, ...patch } : t)));

  async function send() {
    const question = text.trim();
    if (!question) return;
    setText("");
    const n = turns.length;
    setTurns((ts) => [...ts, { question, runId: null, agent: null, answer: null, error: null }]);
    try {
      await ask(n, question);
    } catch {
      update(n, { error: "The studio could not reach the server, or it answered with something unexpected. Reload and try again." });
    }
  }

  async function ask(n: number, question: string) {
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
      const poll = await fetch(`/api/agents/test-runs/${body.runId}`, { credentials: "include" });
      if (!poll.ok) return update(n, { error: `The studio answered ${poll.status} while waiting for the reply.` });
      const run = (await poll.json()) as { replies: { kind: string; text: string }[]; outcome: string | null };
      const reply = run.replies.find((r) => r.kind === "reply");
      if (reply) return update(n, { answer: reply.text });
      if (run.outcome) return update(n, { error: `The run ended ${run.outcome} without a reply.` });
    }
    update(n, { error: "No reply after two minutes. Is a worker running?" });
  }

  return (
    <section className="aq-panel" data-testid="test-thread">
      <PanelStyle />
      <h4>Test thread</h4>
      <p className="aq-help">{modified ? "Unsaved changes are not tested. Save first." : "Runs the saved draft through the real worker. Nothing is published."}</p>
      {turns.length ? (
        <ol className="aq-turns">
          {turns.map((t, n) => (
            <li key={n} className="aq-turn" data-testid="test-turn">
              <div className="aq-q">
                <span className="aq-sr">You: </span>
                {t.question}
              </div>
              {t.answer ? (
                <p className="aq-a" data-testid="test-answer" ref={markOverflow}>
                  <span className="aq-sr">Agent: </span>
                  {t.answer}
                </p>
              ) : t.error ? (
                <Status kind="error">{t.error}</Status>
              ) : (
                <Status kind="busy">{t.runId ? "The worker is running the draft…" : "Sending…"}</Status>
              )}
              {t.agent ? (
                <p className="aq-ver" data-testid="test-version" data-version={t.agent}>
                  Answered by version <code className="aq-hash">{short(t.agent)}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <textarea
        aria-label="Test message"
        className="aq-field"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Ask what a lab member would ask"
      />
      <div className="aq-actions">
        <Button buttonStyle="secondary" size="small" disabled={!text.trim()} onClick={send}>
          Send
        </Button>
        <span className="aq-ver">⌘ Enter sends</span>
      </div>
    </section>
  );
}
