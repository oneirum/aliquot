"use client";

import { useAllFormFields } from "@payloadcms/ui";
import { useEffect, useState } from "react";
import { PanelStyle } from "./styles.ts";
import { Status } from "./Status.tsx";

interface DataClassInfo {
  id: string;
  level: string;
  modelTier: "hosted" | "local" | "none";
  record: "text" | "hash" | "none";
  retentionDays: number | null;
  residency: string | null;
  detectors: string[];
}
interface KbClasses {
  kbId: string;
  sources: { sourceId: string; class: string; detectors: string[] }[];
  entries: { path: string; class: string }[];
}

const TIER: Record<DataClassInfo["modelTier"], string> = { hosted: "an approved hosted model may read it", local: "only a lab or institution model reads it", none: "no model reads it; refused at the door" };
const RECORD: Record<DataClassInfo["record"], string> = { text: "keeps the text", hash: "keeps a hash", none: "keeps nothing" };

/**
 * The lab's data classes from lab.toml, and which of this knowledge base's sources and published entries carry each.
 * Read only: a class is changed in lab.toml, and a source's class by its text and its declared class.
 */
export function ClassesPanel() {
  const [fields] = useAllFormFields();
  const [data, setData] = useState<{ classes: DataClassInfo[]; knowledgeBases: KbClasses[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/knowledge-bases/catalog/classes", { credentials: "include" })
      .then(async (res) => {
        const body = (await res.json()) as { classes?: DataClassInfo[]; knowledgeBases?: KbClasses[]; error?: string };
        if (!res.ok || !body.classes || !body.knowledgeBases) throw new Error(body.error ?? `The studio answered ${res.status}.`);
        setData({ classes: body.classes, knowledgeBases: body.knowledgeBases });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const kbId = typeof fields.kbId?.value === "string" ? fields.kbId.value : null;
  const mine = data?.knowledgeBases.find((k) => k.kbId === kbId) ?? null;

  return (
    <section className="aq-panel" data-testid="classes-panel">
      <PanelStyle />
      <h4>Data classes</h4>
      <p className="aq-help">{mine ? "What this lab's policy does with each class, and which of this knowledge base's published sources and entries carry it." : "What this lab's policy does with each class. Publish this knowledge base to see which of its entries carry each."}</p>
      {error ? <Status kind="error">The classes did not load: {error}</Status> : null}
      {!data && !error ? <Status kind="busy">Loading the classes…</Status> : null}
      {data ? (
        <ul className="aq-tools">
          {data.classes.map((c) => {
            const sources = mine?.sources.filter((s) => s.class === c.id) ?? [];
            const entries = mine?.entries.filter((e) => e.class === c.id) ?? [];
            return (
              <li className="aq-tool" key={c.id} data-testid="class-row" data-class={c.id}>
                <code>{c.id}</code> <span className="aq-where">{c.level}</span>
                {sources.length || entries.length ? <span className="aq-on">{entries.length} {entries.length === 1 ? "entry" : "entries"} here</span> : null}
                <p>
                  {TIER[c.modelTier]}; the record {RECORD[c.record]}
                  {c.retentionDays === null ? "." : `, for ${c.retentionDays} days.`}
                  {c.residency ? ` Only an endpoint in region ${c.residency} reads it.` : null}
                </p>
                {c.detectors.length ? <div className="aq-where">Detectors: {c.detectors.join(", ")}</div> : null}
                {sources.length ? <div className="aq-where">Sources: {sources.map((s) => (s.detectors.length ? `${s.sourceId} (${s.detectors.join(", ")})` : s.sourceId)).join(", ")}</div> : null}
                {entries.length ? <div className="aq-where">Entries: {entries.map((e) => e.path).join(", ")}</div> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
