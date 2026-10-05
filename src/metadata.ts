import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";

/** Info keys with their own setters; anything else is a custom field. */
const STANDARD = new Set(["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate", "Trapped"]);
export const COPYRIGHT = "Copyright";
export const COPYRIGHT_URL = "CopyrightURL";

/** Custom keys must be plain names so they are also valid XMP element names. */
export const CUSTOM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function infoDict(doc: PDFDocument): PDFDict {
  // pdf-lib's own accessor; it creates the Info dictionary when missing.
  return (doc as unknown as { getInfoDict(): PDFDict }).getInfoDict();
}

function text(v: unknown): string | undefined {
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

/** Non-standard Info entries, including Copyright and CopyrightURL. */
export function customInfo(doc: PDFDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of infoDict(doc).entries()) {
    const name = key.decodeText();
    const t = text(value);
    if (!STANDARD.has(name) && t !== undefined) out[name] = t;
  }
  return out;
}

export function setInfo(doc: PDFDocument, key: string, value: string | null) {
  const dict = infoDict(doc);
  if (value === null) dict.delete(PDFName.of(key));
  else dict.set(PDFName.of(key), PDFHexString.fromText(value));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const alt = (s: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${esc(s)}</rdf:li></rdf:Alt>`;

/**
 * Rewrites the catalog's XMP packet from the Info dictionary. Acrobat and most
 * asset tools read copyright from XMP (dc:rights, xmpRights), not from Info.
 */
export function writeXmp(doc: PDFDocument) {
  const custom = customInfo(doc);
  const copyright = custom[COPYRIGHT];
  const url = custom[COPYRIGHT_URL];
  const fields: string[] = ["<dc:format>application/pdf</dc:format>"];
  const add = (v: string | undefined, f: (v: string) => string) => v && fields.push(f(v));
  add(doc.getTitle(), (v) => `<dc:title>${alt(v)}</dc:title>`);
  add(doc.getAuthor(), (v) => `<dc:creator><rdf:Seq><rdf:li>${esc(v)}</rdf:li></rdf:Seq></dc:creator>`);
  add(doc.getSubject(), (v) => `<dc:description>${alt(v)}</dc:description>`);
  add(doc.getKeywords(), (v) => `<pdf:Keywords>${esc(v)}</pdf:Keywords>`);
  add(doc.getProducer(), (v) => `<pdf:Producer>${esc(v)}</pdf:Producer>`);
  add(doc.getCreator(), (v) => `<xmp:CreatorTool>${esc(v)}</xmp:CreatorTool>`);
  add(doc.getCreationDate()?.toISOString(), (v) => `<xmp:CreateDate>${v}</xmp:CreateDate>`);
  add(doc.getModificationDate()?.toISOString(), (v) => `<xmp:ModifyDate>${v}</xmp:ModifyDate>`);
  fields.push(`<xmp:MetadataDate>${new Date().toISOString()}</xmp:MetadataDate>`);
  add(copyright, (v) => `<dc:rights>${alt(v)}</dc:rights>`);
  if (copyright || url) fields.push("<xmpRights:Marked>True</xmpRights:Marked>");
  add(url, (v) => `<xmpRights:WebStatement>${esc(v)}</xmpRights:WebStatement>`);
  for (const [k, v] of Object.entries(custom)) {
    // pdfx is where Acrobat mirrors custom Info keys.
    if (k !== COPYRIGHT && k !== COPYRIGHT_URL && CUSTOM_KEY.test(k)) fields.push(`<pdfx:${k}>${esc(v)}</pdfx:${k}>`);
  }
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">
${fields.join("\n")}
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = doc.context.stream(new TextEncoder().encode(xml), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
}

/**
 * Copyright and custom fields as a stand-alone rdf:Description, for PDF/A
 * conversion: the library rewrites PDF/A XMP on save and keeps only blocks in
 * namespaces it does not own (dc, xmp, pdf, pdfaid are its own).
 */
export function foreignXmp(doc: PDFDocument): string | undefined {
  const custom = customInfo(doc);
  const fields: string[] = [];
  if (custom[COPYRIGHT] || custom[COPYRIGHT_URL]) fields.push("<xmpRights:Marked>True</xmpRights:Marked>");
  if (custom[COPYRIGHT_URL]) fields.push(`<xmpRights:WebStatement>${esc(custom[COPYRIGHT_URL])}</xmpRights:WebStatement>`);
  for (const [k, v] of Object.entries(custom)) {
    if (k !== COPYRIGHT && k !== COPYRIGHT_URL && CUSTOM_KEY.test(k)) fields.push(`<pdfx:${k}>${esc(v)}</pdfx:${k}>`);
  }
  if (!fields.length) return undefined;
  return `<rdf:Description rdf:about="" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">
${fields.join("\n")}
</rdf:Description>`;
}

/** The catalog's XMP packet as text, if any. */
export function readXmp(doc: PDFDocument): string | undefined {
  const ref = doc.catalog.get(PDFName.of("Metadata"));
  if (!ref) return undefined;
  const stream = doc.context.lookup(ref) as { getContents?: () => Uint8Array } | undefined;
  const bytes = stream?.getContents?.();
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}
