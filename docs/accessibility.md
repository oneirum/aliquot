# Accessibility

This is what Aliquot tests for accessibility, what the result is, and what is not covered. The target is WCAG 2.1 level AA, the standard the US Department of Justice's ADA Title II web rule ([28 CFR 35.200](https://www.ecfr.gov/current/title-28/chapter-I/part-35/subpart-H)) sets for public universities' web content, including content a university provides through a vendor or another party. It is a test report, not a conformance claim or a VPAT: a VPAT needs a person to review it and sign it, and nobody has yet.

## What is tested, on every `pnpm unit2`

`pnpm unit2` runs the real web door and studio in headless Chromium (see [What is checked](../README.md#what-is-checked)). Two of its checks are about accessibility, and either one failing fails the run.

**Check 8, axe-core.** [axe-core](https://github.com/dequelabs/axe-core) 4.14.0, pinned in `package.json` as a test-only dependency, runs its WCAG 2.0 and 2.1 level A and AA rules (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) over five pages, each in the light and the dark theme:

| Page | State when scanned |
|---|---|
| The chat page (`/`) | A question asked and answered, with its source and its record block |
| A run record (`/runs/<id>`) | The answered run, with the summary, the chain and the event table |
| The runs list (`/runs`) | Every run the script made |
| The studio's agent form | A published agent, with the publish panel, tools panel and test thread |
| The studio's knowledge base form | The lab0 handbook, compiled and published, with the coverage report |

Any violation axe rates serious or critical fails the check, and the failure names the rule and the elements. Minor and moderate ones are counted in the check's line. The full result is written to `.unit2/axe.json`.

**Check 7, the keyboard walk.** With the keyboard alone, in both themes, a member:

1. lands in the question field (the page puts focus there),
2. types a question and presses Enter,
3. hears the answer: a live region (`role="status"`) that exists from page load announces "Answer:" and the answer's text once, or the refusal and why,
4. Shift+Tabs to **Check** and presses Enter; focus stays on Check through the check and after the verdict,
5. Tabs to **Open record** and presses Enter,
6. Tabs through the record page's header to **Download JSON** and presses Enter; the download is that run's record.

At every one of those stops, nine per theme, the check asserts that the focused element shows a focus ring at least 2 px wide and at least 3:1 against the page background. Screenshots of each stop land in `.unit2/focus-<theme>-<n>-<stop>.png`.

## Result

On 2026-11-07, at the commit that added these checks: no serious or critical violation on any of the ten scans, and no minor or moderate one either. The keyboard walk passes in both themes, with every focus ring between 5.5:1 and 16.5:1.

To see the check fail, remove `aria-label="Ask"` from the send button in `packages/core/src/surfaces/web-chat.ts`: check 8 fails with `critical button-name (Buttons must have discernible text): #send` on the chat page in both themes.

## What was fixed to get there

The web door's own pages (chat, record, runs) had no serious or critical violation in axe. Two things were fixed there anyway, because axe cannot see them:

- The whole message thread was an `aria-live` region, so a screen reader read out every node the page added, including "Reading the lab's documents" and the seconds counter. It is now one quiet live region that says each new answer, refusal or error once. Answers restored from the tab's history on reload are not announced again.
- The question field's focus ring was a 1 px border at 22 percent opacity, about 1.6:1. It is now the border and a 1 px outline in the muted ink, 5.5:1.

The studio is built on Payload 3.92, and Payload's own admin components failed seven axe rules on both forms. `packages/studio/components/A11yRepairs.tsx`, mounted as an admin provider, repairs each on Payload's markup by setting attributes only, never moving or adding an element:

| axe rule | What Payload rendered | Repair |
|---|---|---|
| `button-name` (critical) | Icon-only "..." menu buttons with no name | Named "More document actions", "Copy or paste rows", "Row actions" |
| `label` (critical) | Select and tag inputs not tied to their field's label | `aria-labelledby` the field's label |
| `aria-command-name` | Row drag handles with no name | Named "Drag to reorder" |
| `aria-hidden-focus` | A select's clear and open icons hidden from screen readers but in the tab order | Taken out of the tab order; the input already clears with Backspace and opens with the arrow keys |
| `nested-interactive` | Sortable tags that are buttons holding their own remove button | The tag is a group, so its remove button is reachable and it still sorts from the keyboard |
| `label-content-name-mismatch` | The Versions tab named "Versions" while showing "Versions" and a count | Named by its visible text |
| `list` | The document tabs list holding elements other than list items | Presented as plain links |
| `color-contrast` (light theme) | Field help text and "Add row" buttons at about 2.8:1 | Payload's darker grey token, the one the sidebar panels' help text already uses |

When a Payload upgrade changes this markup, check 8 fails and names what is new.

## Known exceptions and what is not covered

- **Automated rules find part of the problems.** axe checks what a machine can decide: names, roles, labels, contrast, structure. Whether a label makes sense, whether reading order matches meaning, and how an answer sounds in a screen reader need a person. No one has yet walked these pages with VoiceOver, NVDA or JAWS.
- **Five pages are scanned.** The studio's login, collection lists, revision diff and user admin pages are Payload's and are not scanned. Neither are the Slack door, which is Slack's interface, or the terminal tools.
- **Desktop width only.** The scans and the walk run at 1440 px wide. The chat page's phone layout, where the sidebar is a drawer with its own focus handling, is not scanned. Reflow at 400 percent zoom (WCAG 1.4.10) and text spacing (1.4.12) are not tested.
- **Payload's widgets work as Payload built them.** The repairs fix names and roles. How a select's menu or a drag-to-reorder behaves from the keyboard is Payload's and react-select's design, not tested beyond what the walk in check 1 to 6 does with them.
- **A long answer is announced in full.** The live region reads the whole answer as it arrives. A member who wants less can stop the screen reader and read the answer at their own pace.
- **Model text.** Answers are shown as the model writes them; the page renders Markdown to headings, lists and code without parsing HTML, but cannot make a model's prose plain.

## Reporting a problem

Open an issue on the repository with the page, what you were doing, and the browser and assistive technology you use.
