/**
 * PDF sources. The page rule is pure and runs everywhere; the fixtures in test/pdf-fixtures/ (README.md there says how
 * each was made) run through the real sandbox container and skip, naming what is missing, without it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pdfText } from "../packages/core/src/pdf.ts";
import { createSandbox, oneFileTar, PDF_CAP_BYTES, readTar } from "../packages/core/src/sandbox.ts";
import type { SandboxConfig } from "../packages/core/src/config.ts";
import type { Sha256 } from "../packages/core/src/hash.ts";
import { DIFFERENCES_TEXT, differencesPdf } from "./pdf-fixture.ts";
import { findDocker, get } from "./sandbox-docker.ts";

const IMAGES_HEADER = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n" + "-".repeat(92) + "\n";
const imageRow = (page: number) => `${String(page).padStart(4)}     0 image     850  1100  icc     1   8  jpeg   yes        5  0   100   100 27.4K 3.0%\n`;
const NO_OCR = "Aliquot does not do OCR. Export the PDF again from the program that made it, or save the document as .docx.";

test("pages become paragraphs: blank pages are skipped, ligatures spelled out, trailing spaces dropped", () => {
  assert.equal(pdfText("Intro ﬁne ﬃce  \nnext line\n\n\n\nafter\n\f\n\f \fﬀﬂ last\n\f", IMAGES_HEADER, "a.pdf"), "Intro fine ffice\nnext line\n\nafter\n\nfffl last\n");
});

test("a page with an image and no text is scanned, and any scanned page fails the file naming every one", () => {
  assert.throws(() => pdfText("text\n\f\f\f", IMAGES_HEADER + imageRow(1) + imageRow(2) + imageRow(3), "mixed.pdf"), { message: `mixed.pdf: pages 2, 3 are scanned images with no text. ${NO_OCR}` });
  assert.throws(() => pdfText("\f", IMAGES_HEADER + imageRow(1), "scan.pdf"), { message: `scan.pdf: page 1 is a scanned image with no text. ${NO_OCR}` });
  assert.equal(pdfText("a figure with a caption\n\f", IMAGES_HEADER + imageRow(1), "figure.pdf"), "a figure with a caption\n");
});

test("a PDF with no text at all fails", () => {
  assert.throws(() => pdfText("\f\n\f", IMAGES_HEADER, "blank.pdf"), { message: `blank.pdf: the PDF has no text. ${NO_OCR}` });
});

test("the upload archive holds one read-only file owned by the container's user", () => {
  const bytes = new TextEncoder().encode("%PDF-1.4\n".repeat(100));
  const archive = oneFileTar("source.pdf", bytes);
  const [entry, ...rest] = readTar(archive).entries;
  assert.deepEqual({ name: entry!.name, type: entry!.type, data: Buffer.from(entry!.data).toString(), rest: rest.length }, { name: "source.pdf", type: "file", data: "%PDF-1.4\n".repeat(100), rest: 0 });
  assert.equal(archive.subarray(100, 124).toString("ascii"), "0000444\u00000177776\u00000177776\u0000");
});

test("a PDF over the size limit is refused before any container is made", async () => {
  const sandbox = createSandbox({ image: `sha256:${"0".repeat(64)}`, digest: "0".repeat(64) as Sha256, cpus: 1, memoryMb: 256, timeoutMs: 1000, socket: "/nonexistent/docker.sock" });
  await assert.rejects(sandbox.readPdf(new Uint8Array(PDF_CAP_BYTES + 1), "huge.pdf"), { message: "huge.pdf: 50.0 MB is over the 50 MB limit for a PDF source; split it into smaller files" });
});

const docker = await findDocker();
const opts = { skip: typeof docker === "string" ? docker : false };
const config: SandboxConfig | null = typeof docker === "string" ? null : { image: docker.image, digest: docker.image.slice(7) as Sha256, cpus: 1, memoryMb: 512, timeoutMs: 20_000, socket: docker.socket };
const fixture = (name: string) => readFile(new URL(`./pdf-fixtures/${name}`, import.meta.url));
const readPdf = async (bytes: Uint8Array, name: string) => createSandbox(config!).readPdf(bytes, name);

test("a LaTeX PDF (CID fonts with ToUnicode) reads with its accents, ligatures, dashes, quotes and Greek, and its blank page skipped", opts, async () => {
  assert.equal(
    await readPdf(await fixture("latex.pdf"), "latex.pdf"),
    "Freezer log, café edition.\nThe müller office runs the señor’s efficient offline buffer.\nStore samples at 2–8 degrees, read the “first” label, and check the α value.\n\nSecond page: fine affinity.\n",
  );
});

test("a Type1 font with a Differences encoding and no ToUnicode reads by glyph name", opts, async () => {
  assert.equal(await readPdf(differencesPdf(), "differences.pdf"), DIFFERENCES_TEXT);
});

test("a PDF that Microsoft Word wrote reads page by page", opts, async () => {
  const text = await readPdf(await fixture("nist-cswp-27.pdf"), "nist-cswp-27.pdf");
  const opening = "Withdrawn White Paper\nWarning Notice\nThe attached white paper has been withdrawn, and is provided solely for historical purposes.";
  assert.equal(text.slice(0, opening.length), opening);
  assert.ok(text.includes("\n\nNIST CSWP 27\nSeptember 2022\n\nHSN Cybersecurity Framework Profile\nFinal Annotated Outline\n\nAbstract\nThe objective of this Cybersecurity Profile is to identify an approach to assess the cybersecurity\n"));
});

test("a scanned page fails with the no-OCR message, and no read_pdf container is left behind", opts, async () => {
  await assert.rejects(readPdf(await fixture("scanned.pdf"), "scanned.pdf"), { message: `scanned.pdf: page 1 is a scanned image with no text. ${NO_OCR}` });
  const filters = encodeURIComponent(JSON.stringify({ label: ["aliquot.read_pdf"] }));
  assert.deepEqual(JSON.parse((await get(config!.socket, `/v1.44/containers/json?all=true&filters=${filters}`)).body), []);
});

test("an encrypted or corrupt PDF fails with pdftotext's own reason", opts, async () => {
  await assert.rejects(readPdf(await fixture("encrypted.pdf"), "encrypted.pdf"), { message: "encrypted.pdf: pdftotext could not read it: Command Line Error: Incorrect password" });
  await assert.rejects(readPdf(new TextEncoder().encode("not a pdf at all\n"), "corrupt.pdf"), { message: "corrupt.pdf: pdftotext could not read it: Syntax Error: Couldn't read xref table" });
});
