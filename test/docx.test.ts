import { test } from "node:test";
import assert from "node:assert/strict";
import { docxToMarkdown } from "../packages/core/src/docx.ts";
import { FREEZER_SOP_MARKDOWN, freezerSop, zip } from "./docx-fixture.ts";

test("a Word document reads to Markdown: headings by style name, list items, a table, tabs and breaks, and no deleted text", () => {
  assert.equal(docxToMarkdown(freezerSop(), "sop-freezer.docx"), FREEZER_SOP_MARKDOWN);
});

test("a file that is not a .docx says so and names the file", () => {
  assert.throws(() => docxToMarkdown(new TextEncoder().encode("# just markdown"), "notes.docx"), /notes\.docx: not a readable \.docx \(no zip directory\)/);
  assert.throws(() => docxToMarkdown(zip({ "xl/workbook.xml": "<workbook/>" }), "budget.docx"), /budget\.docx: not a Word document \(no word\/document\.xml\)/);
});

test("a part that claims to inflate past the limit is refused before it is inflated", () => {
  const bytes = zip({ "word/document.xml": "<w:document/>" }, ["word/document.xml"]);
  const v = new DataView(bytes.buffer);
  for (let i = bytes.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x02014b50) { v.setUint32(i + 24, 65 * 1024 * 1024, true); break; }
  assert.throws(() => docxToMarkdown(bytes, "big.docx"), /big\.docx: a part inflates to 68157440 bytes/);
});
