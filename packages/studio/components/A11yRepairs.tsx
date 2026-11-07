"use client";

import { createElement, Fragment, useEffect, type ReactNode } from "react";

/**
 * Payload 3.92's admin ships markup that axe-core rates serious or critical under WCAG 2.1 AA (pnpm unit2, check 8):
 * icon-only popup buttons and drag handles with no name, react-select inputs not tied to their field's label, the
 * select's clear button focusable while aria-hidden, sortable tags that are buttons holding a remove button, a tab
 * list holding more than list items, and field help text below 4.5:1 in the light theme.
 *
 * Each repair sets an attribute on Payload's own elements, only when it differs, so React's later renders and this
 * observer never fight over it. None moves or adds an element, which React would undo or trip over. Mounted once as
 * an admin provider; docs/accessibility.md lists what each repair answers.
 */

// Payload's help text and its "Add row" buttons sit on --theme-elevation-400, 2.8:1 on white; 650 is what the
// sidebar panels' help text uses. Hover and disabled keep Payload's own colours.
const STYLE = `.field-description { color: var(--theme-elevation-650); } .array-field__add-row.btn { --btn-color: var(--theme-elevation-650); }`;

function set(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

const POPUP_NAMES: [string, string][] = [
  [".doc-controls__popup", "More document actions"],
  [".clipboard-action__popup", "Copy or paste rows"],
  [".array-actions", "Row actions"],
];

let labelIds = 0;
function repair(root: Document): void {
  for (const b of root.querySelectorAll(".popup-button")) {
    if (b.textContent?.trim() || b.hasAttribute("aria-label")) continue;
    set(b, "aria-label", POPUP_NAMES.find(([sel]) => b.closest(sel))?.[1] ?? "More actions");
  }
  for (const d of root.querySelectorAll(".collapsible__drag")) set(d, "aria-label", "Drag to reorder");
  // react-select's input carries keyboard clearing (Backspace) and opening (arrow down), so the icons leave the tab order.
  for (const i of root.querySelectorAll(".rs__indicators [aria-hidden='true']:is(button, [tabindex])")) set(i, "tabindex", "-1");
  for (const input of root.querySelectorAll<HTMLInputElement>(".react-select input[id^='react-select-']")) {
    const label = input.closest(".field-type")?.querySelector(".field-label");
    if (!label) continue;
    if (!label.id) label.id = `aq-label-${++labelIds}`;
    set(input, "aria-labelledby", label.id);
  }
  // A sortable tag is a dnd-kit button holding its own remove button; as a group it keeps its keyboard sorting.
  for (const s of root.querySelectorAll("[aria-roledescription='sortable'][role='button']")) {
    if (s.querySelector("button, [role='button'], a[href], input")) set(s, "role", "group");
  }
  // The Versions tab's name is its visible text, count included.
  for (const a of root.querySelectorAll(".doc-tab a[aria-label], a.doc-tab[aria-label]")) a.removeAttribute("aria-label");
  for (const ul of root.querySelectorAll(".doc-tabs__tabs")) {
    if ([...ul.children].some((c) => c.tagName !== "LI")) {
      set(ul, "role", "none");
      for (const li of ul.children) if (li.tagName === "LI") set(li, "role", "none");
    }
  }
}

export function A11yRepairs({ children }: { children?: ReactNode }) {
  useEffect(() => {
    let queued = 0;
    const run = () => {
      queued = 0;
      repair(document);
    };
    run();
    const observer = new MutationObserver(() => {
      if (!queued) queued = requestAnimationFrame(run);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(queued);
    };
  }, []);
  return createElement(Fragment, null, createElement("style", null, STYLE), children);
}
