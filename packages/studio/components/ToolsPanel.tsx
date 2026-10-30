"use client";

import { useAllFormFields } from "@payloadcms/ui";
import { useEffect, useState } from "react";
import { PanelStyle } from "./styles.ts";
import { Status } from "./Status.tsx";

interface Tool {
  name: string;
  summary: string;
  reads: string;
  effects: string;
  egress: string[];
}

const GROUPS: readonly { title: string; has: (t: Tool) => boolean }[] = [
  { title: "Knowledge bases", has: (t) => t.name.startsWith("kb_") },
  { title: "Literature", has: (t) => t.egress.length > 0 },
  { title: "Lab data", has: () => true },
];

/**
 * The tools this lab's Aliquot runs, for the person filling in the Tools field. Read only: the list is plain data from
 * core (name, first sentence, class, hosts), and adding one to the agent is still the field above.
 */
const EFFECT: Record<string, string> = { read: ".", "lab-write": "; writes to lab data.", "external-send": "; sends outside the lab." };

export function ToolsPanel() {
  const [fields] = useAllFormFields();
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents/catalog/tools", { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json()) as { tools?: Tool[]; error?: string };
        if (!res.ok || !body.tools) throw new Error(body.error ?? `The studio answered ${res.status}.`);
        setTools(body.tools);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const chosen = new Set(Object.entries(fields).flatMap(([path, f]) => (/^tools\.\d+\.name$/.test(path) && typeof f.value === "string" ? [f.value] : [])));
  const placed = new Set<string>();

  return (
    <section className="aq-panel" data-testid="tools-panel">
      <PanelStyle />
      <h4>Tools</h4>
      <p className="aq-help">Every tool is built into Aliquot. Add one by name in the Tools field. A tool that reaches the internet is refused for any conversation above D0.</p>
      {error ? <Status kind="error">The tool list did not load: {error}</Status> : null}
      {!tools && !error ? <Status kind="busy">Loading the tool list…</Status> : null}
      {tools
        ? GROUPS.map((g) => {
            const mine = tools.filter((t) => !placed.has(t.name) && g.has(t));
            for (const t of mine) placed.add(t.name);
            return mine.length ? (
              <div className="aq-group" key={g.title}>
                <h5>{g.title}</h5>
                <ul className="aq-tools">
                  {mine.map((t) => (
                    <li className="aq-tool" key={t.name} data-testid="tool-row">
                      <code>{t.name}</code>
                      {chosen.has(t.name) ? <span className="aq-on">On this agent</span> : null}
                      <p>{t.summary}</p>
                      <div className="aq-where">{t.egress.length ? `Reaches ${t.egress.join(", ")}` : "No network"}. Reads {t.reads}{EFFECT[t.effects] ?? `; ${t.effects}.`}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null;
          })
        : null}
    </section>
  );
}
