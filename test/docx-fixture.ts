import { crc32, deflateRawSync } from "node:zlib";

/** A minimal zip, as Word writes one: each part deflated unless `stored` names it. */
export function zip(parts: Record<string, string>, stored: readonly string[] = []): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const raw = Buffer.from(text, "utf8");
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(raw), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc32(raw), 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(head, n, data);
    central.push(dir, n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (body: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${body}</w:p>`;
const r = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

/** A freezer SOP as Word saves it, with a localized heading style id, a list, a table and a deleted tracked change. */
export function freezerSop(extra = ""): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>
${p(r("Freezer storage"), '<w:pStyle w:val="Ttulo1"/>')}
${p(r("Aliquots go in the minus eighty freezer, room 214, ") + r("rack C.") + '<w:del><w:r><w:delText>rack B.</w:delText></w:r></w:del>')}
${p(r("Before you thaw"), '<w:pStyle w:val="Heading2"/>')}
${p(r("Log the box &amp; slot"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')}
${p(r("Thaw on ice"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')}
<w:tbl><w:tblPr/><w:tr><w:tc>${p(r("Rack"))}</w:tc><w:tc>${p(r("Contents"))}</w:tc></w:tr><w:tr><w:tc>${p(r("C"))}</w:tc><w:tc>${p(r("Wave 1 &lt;aliquots&gt;"))}</w:tc></w:tr></w:tbl>
${p(r("Questions:") + "<w:r><w:tab/></w:r>" + r("ask the lab manager.") + "<w:r><w:br/></w:r>" + r("Room 210."))}
${extra ? p(r(extra)) : ""}
<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  return zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": document, "word/styles.xml": styles }, ["word/styles.xml"]);
}

export const FREEZER_SOP_MARKDOWN = `# Freezer storage

Aliquots go in the minus eighty freezer, room 214, rack C.

## Before you thaw

- Log the box & slot

- Thaw on ice

| Rack | Contents |
| --- | --- |
| C | Wave 1 <aliquots> |

Questions:\task the lab manager.
Room 210.
`;
