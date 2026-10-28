import type { CSSProperties } from "react";

export const box: CSSProperties = { borderTop: "1px solid var(--theme-elevation-100)", paddingTop: 16, marginBottom: 24 };
export const heading: CSSProperties = { margin: "0 0 8px" };
export const muted: CSSProperties = { color: "var(--theme-elevation-500)", margin: "0 0 8px" };
export const issueList: CSSProperties = { paddingLeft: 18, margin: "4px 0" };
export const hashStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "0.9em" };

/** The first 12 hex characters: enough to tell versions apart on screen. The full hash is in the run record. */
export const short = (hash: string) => hash.slice(0, 12);
