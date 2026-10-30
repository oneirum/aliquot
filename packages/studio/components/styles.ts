import { createElement } from "react";

/** The first 12 hex characters: enough to tell versions apart on screen. The full hash is in the run record. */
export const short = (hash: string) => hash.slice(0, 12);

// One stylesheet for every sidebar panel, on Payload's theme variables so both themes follow the admin's setting.
// Inline styles cannot express focus, reduced motion or the busy dot, so the panels use these classes instead.
const CSS = `
[data-theme="dark"] .aq-panel { --aq-ok: #4cb36d; }
.aq-panel { --aq-ok: #2f8f4e; border-top: 1px solid var(--theme-elevation-100); padding-top: 20px; margin-bottom: 28px; }
.aq-panel h4 { font-size: 15px; font-weight: 600; line-height: 1.3; letter-spacing: -0.005em; margin: 0 0 4px; }
.aq-help { font-size: 13px; line-height: 1.45; color: var(--theme-elevation-650); margin: 0 0 12px; text-wrap: pretty; }
.aq-label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 6px; }
.aq-field { display: block; width: 100%; font: inherit; font-size: 14px; line-height: 1.45; padding: 8px 10px; border-radius: var(--style-radius-s, 4px); border: 1px solid var(--theme-elevation-150); background: var(--theme-input-bg); color: var(--theme-text); resize: vertical; transition: border-color 150ms ease, box-shadow 150ms ease; }
.aq-field:focus { border-color: var(--theme-elevation-400); }
.aq-field:focus-visible { outline: 2px solid var(--theme-elevation-800); outline-offset: 1px; }
.aq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.aq-actions .btn { margin: 0; }
.aq-status { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; line-height: 1.45; margin: 12px 0 0; padding: 9px 12px; border-radius: var(--style-radius-m, 6px); background: var(--theme-elevation-50); color: var(--theme-text); }
.aq-status::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; margin-top: 6px; background: var(--theme-elevation-400); }
.aq-status[data-kind="ok"] { background: color-mix(in srgb, var(--aq-ok) 10%, transparent); }
.aq-status[data-kind="ok"]::before { background: var(--aq-ok); }
.aq-status[data-kind="error"] { background: color-mix(in srgb, var(--theme-error-500) 10%, transparent); }
.aq-status[data-kind="error"]::before { background: var(--theme-error-500); }
.aq-status[data-kind="warn"] { background: color-mix(in srgb, var(--theme-warning-500) 12%, transparent); }
.aq-status[data-kind="warn"]::before { background: var(--theme-warning-500); }
.aq-status[data-kind="busy"]::before { animation: aq-pulse 1s ease-in-out infinite; }
.aq-status > div { min-width: 0; overflow-wrap: anywhere; }
.aq-issues { padding-left: 18px; margin: 6px 0 0; }
.aq-issues li { margin: 3px 0; }
.aq-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.aq-hash { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.9em; }
.aq-turns { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-direction: column; gap: 14px; }
.aq-turn { display: flex; flex-direction: column; gap: 6px; }
.aq-q { align-self: flex-end; max-width: 90%; background: var(--theme-elevation-100); border-radius: 12px 12px 4px 12px; padding: 7px 11px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.aq-a { font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; margin: 0; max-height: 12em; overflow: auto; padding: 8px 10px; border-radius: var(--style-radius-m, 6px); background: var(--theme-elevation-50); }
.aq-a[data-overflow] { mask-image: linear-gradient(to bottom, #000 calc(100% - 2em), transparent); }
.aq-turn .aq-status { margin: 0; }
.aq-ver { font-size: 12px; color: var(--theme-elevation-650); margin: 0; }
.aq-group { margin: 16px 0 0; }
.aq-group h5 { font-size: 12px; font-weight: 600; color: var(--theme-elevation-650); margin: 0 0 8px; }
.aq-tools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.aq-tool { font-size: 13px; line-height: 1.45; }
.aq-tool code { font: 600 12.5px var(--font-mono, ui-monospace, monospace); }
.aq-tool p { margin: 2px 0 0; color: var(--theme-elevation-800); text-wrap: pretty; }
.aq-tool .aq-where { margin-top: 2px; font-size: 12px; color: var(--theme-elevation-650); }
.aq-pre { font: 12px/1.6 var(--font-mono, ui-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
.aq-pre > span { display: block; padding-left: 7ch; text-indent: -7ch; }
.aq-pre > span:first-child { padding-left: 0; text-indent: 0; margin-bottom: 4px; }
.aq-on { margin-left: 6px; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--aq-ok) 18%, transparent); border: 1px solid color-mix(in srgb, var(--aq-ok) 40%, transparent); color: var(--theme-text); }
@media (max-width: 768px) { .aq-panel .btn { min-height: 40px; padding-inline: 14px; } .aq-a { max-height: none; } }
@keyframes aq-pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .aq-status[data-kind="warn"] { background: color-mix(in srgb, var(--theme-warning-500) 12%, transparent); }
.aq-status[data-kind="warn"]::before { background: var(--theme-warning-500); }
.aq-status[data-kind="busy"]::before { animation: none; } .aq-field { transition: none; } }
`;

/** React 19 hoists a <style> with href and precedence into <head> once, however many panels render it. */
export const PanelStyle = () => createElement("style", { href: "aliquot-panels", precedence: "default" }, CSS);
