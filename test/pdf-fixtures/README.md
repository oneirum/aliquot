# PDF fixtures

`test/pdf.test.ts` reads each file through the sandbox container and asserts the exact text. The hand-written Type1 PDF with a `/Differences` encoding and no ToUnicode is not here: `test/pdf-fixture.ts` generates it in the test.

| File | What it covers | How it was made |
|---|---|---|
| `latex.tex`, `latex.pdf` | CID fonts with ToUnicode (Latin Modern through fontspec), a Type 1C math font for the Greek letter, accents (é, ü, ñ), the ff and ffi ligatures, an en dash, curly quotes, and a blank second page | `tectonic latex.tex` (Tectonic 0.17.0, Homebrew) |
| `nist-cswp-27.pdf` | A PDF written by Microsoft Word: TrueType WinAnsi subset fonts and Word's page layout | Downloaded unchanged, see below |
| `scanned.pdf` | An image-only page, which must fail with the no-OCR message | `gs -sDEVICE=pnggray -r100 -dFirstPage=1 -dLastPage=1 -sOutputFile=scan.png latex.pdf`, then `sips -s format pdf scan.png --out scanned.pdf` |
| `encrypted.pdf` | A PDF with a user password, which must fail with pdftotext's own reason | `gs -sDEVICE=pdfwrite -sOwnerPassword=owner -sUserPassword=reader -dEncryptionR=3 -dKeyLength=128 -sOutputFile=encrypted.pdf latex.pdf` |

## The Word PDF

- Source: <https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.27.pdf>, NIST Cybersecurity White Paper 27, "Cybersecurity Framework Profile for Hybrid Satellite Networks (HSN): Final Annotated Outline" (September 2022, withdrawn June 2023 with a notice page in front).
- `pdfinfo` reports `Creator: Microsoft Word`, no Producer, PDF 1.7, 11 pages.
- SHA-256 `5a809124e59aa6429e33cdcf798ce852d986409386fc24e76646baaa75fe4037`, 586 KB.
- Licence: a work of the US federal government, not subject to copyright in the United States (17 U.S.C. 105).

It is larger than the other fixtures because none of the smaller federal PDFs checked had metadata naming Microsoft Word itself; the smaller NIST papers were made with Acrobat PDFMaker.
