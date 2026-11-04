/**
 * PDF sources: what poppler printed inside the sandbox container, turned into
 * a source's text. The parsing itself happens in the container (sandbox.ts
 * readPdf), never in a Node process; this only reads its two outputs.
 *
 * `pdftotext -enc UTF-8 file -` ends every page with a form feed, and
 * `pdfimages -list file` prints one row per image with its page number first.
 * A page with an image and no text is a scanned page. Aliquot does not do OCR,
 * so one scanned page fails the whole file rather than leaving a silent gap.
 */

/** Typographic ligatures pdftotext passes through as single code points; search and the compiler want the letters. */
const LIGATURES: Readonly<Record<string, string>> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

const NO_OCR = "Aliquot does not do OCR. Export the PDF again from the program that made it, or save the document as .docx";

export function pdfText(pagesText: string, imageList: string, name: string): string {
  const pages = pagesText.split("\f");
  // The last form feed ends the last page; what follows it is not a page.
  if (pages.at(-1) === "") pages.pop();
  const texts = pages.map(cleanPage);
  const withImages = imagePages(imageList);
  const scanned = texts.flatMap((t, i) => (t === "" && withImages.has(i + 1) ? [i + 1] : []));
  if (scanned.length > 0) {
    const which = scanned.length === 1 ? `page ${scanned[0]} is a scanned image` : `pages ${scanned.join(", ")} are scanned images`;
    throw new Error(`${name}: ${which} with no text. ${NO_OCR}.`);
  }
  const kept = texts.filter((t) => t !== "");
  if (kept.length === 0) throw new Error(`${name}: the PDF has no text. ${NO_OCR}.`);
  return `${kept.join("\n\n")}\n`;
}

function cleanPage(page: string): string {
  return page
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c]!)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The page numbers in pdfimages -list's table: the rows below the dashed rule, first column. */
function imagePages(list: string): Set<number> {
  const rows = list.split("\n");
  const rule = rows.findIndex((r) => /^-{10,}$/.test(r.trim()));
  const pages = new Set<number>();
  for (const row of rows.slice(rule + 1)) {
    const page = /^\s*(\d+)\s/.exec(row)?.[1];
    if (page !== undefined) pages.add(Number(page));
  }
  return pages;
}
