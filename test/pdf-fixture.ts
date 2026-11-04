/**
 * A hand-written PDF whose one font is the standard Type1 Helvetica with a /Differences encoding and no ToUnicode,
 * so text extraction has to map glyph names (/fi, /eacute, /endash) to Unicode. Pages are content streams of
 * PDF string bytes; page 2 is blank.
 */

const DIFFERENCES = "[128 /fi /eacute /ffi /endash /quotedblleft /quotedblright /udieresis]";

/** The text pdftotext should give for each page of differencesPdf(), after ligatures are spelled out. */
export const DIFFERENCES_TEXT = "The “first” café office, 2–8 degrees.\n\nMüller signs the second page.\n";

export function differencesPdf(): Uint8Array {
  const pages = ["(The \\204\\200rst\\205 caf\\201 o\\202ce, 2\\2038 degrees.) Tj", "", "(M\\206ller signs the second page.) Tj"];
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences ${DIFFERENCES} >> >>`,
  ];
  for (const [i, show] of pages.entries()) {
    const stream = show ? `BT /F1 12 Tf 72 720 Td ${show} ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
