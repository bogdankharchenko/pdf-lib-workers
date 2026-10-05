import {
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFName,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
} from "@cantoo/pdf-lib";
import { describeField } from "./forms";
import { COPYRIGHT, COPYRIGHT_URL, customInfo, readXmp } from "./metadata";
import { resolvePages } from "./pages";
import type { InfoResponse, LockedInfoResponse, ScriptsResponse, TextResponse } from "./replies";

const box = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, width: b.width, height: b.height });

function pageInfo(p: PDFPage, i: number) {
  const { width, height } = p.getSize();
  return {
    page: i + 1,
    width,
    height,
    rotation: p.getRotation().angle,
    boxes: { mediaBox: box(p.getMediaBox()), cropBox: box(p.getCropBox()), bleedBox: box(p.getBleedBox()), trimBox: box(p.getTrimBox()), artBox: box(p.getArtBox()) },
  };
}

function fieldType(f: unknown): InfoResponse["form"]["fields"][number]["type"] {
  if (f instanceof PDFTextField) return "text";
  if (f instanceof PDFCheckBox) return "checkbox";
  if (f instanceof PDFDropdown) return "dropdown";
  if (f instanceof PDFOptionList) return "optionList";
  if (f instanceof PDFRadioGroup) return "radio";
  if (f instanceof PDFButton) return "button";
  if (f instanceof PDFSignature) return "signature";
  return "unknown";
}

/** A field's current value, and its choices where it has them. */
function fieldValue(field: PDFField): Pick<InfoResponse["form"]["fields"][number], "value" | "options"> {
  if (field instanceof PDFTextField) return { value: field.getText() ?? null };
  if (field instanceof PDFCheckBox) return { value: field.isChecked() };
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return { value: field.getSelected(), options: field.getOptions() };
  if (field instanceof PDFRadioGroup) return { value: field.getSelected() ?? null, options: field.getOptions() };
  return { value: null };
}

/** PDF/A part and level from the XMP packet, e.g. "3B". */
function pdfAConformance(doc: PDFDocument): string | null {
  const xmp = readXmp(doc);
  const part = xmp?.match(/pdfaid:part(?:>|=")\s*(\d)/)?.[1];
  const level = xmp?.match(/pdfaid:conformance(?:>|=")\s*([ABU])/i)?.[1];
  return part ? `${part}${(level ?? "").toUpperCase()}` : null;
}

function viewerPreferences(doc: PDFDocument) {
  const vp = doc.catalog.getViewerPreferences();
  const name = (k: string) => {
    const v = doc.catalog.get(PDFName.of(k));
    return v instanceof PDFName ? v.decodeText() : null;
  };
  return {
    pageMode: name("PageMode"),
    pageLayout: name("PageLayout"),
    ...(vp
      ? {
          hideToolbar: vp.getHideToolbar(),
          hideMenubar: vp.getHideMenubar(),
          hideWindowUI: vp.getHideWindowUI(),
          fitWindow: vp.getFitWindow(),
          centerWindow: vp.getCenterWindow(),
          displayDocTitle: vp.getDisplayDocTitle(),
          nonFullScreenPageMode: vp.getNonFullScreenPageMode(),
          readingDirection: vp.getReadingDirection(),
          printScaling: vp.getPrintScaling(),
          duplex: vp.getDuplex() ?? null,
          pickTrayByPDFSize: vp.getPickTrayByPDFSize() ?? null,
          printPageRange: vp.getPrintPageRange().map((r) => ({ start: r.start + 1, end: r.end + 1 })),
          numCopies: vp.getNumCopies(),
        }
      : {}),
  };
}

/** Everything about a document except its content. Load with preserveXFA so XFA can be reported. */
export function documentInfo(doc: PDFDocument): InfoResponse {
  const custom = customInfo(doc);
  let form: InfoResponse["form"] = { hasXFA: false, fields: [], signatureFields: [] };
  try {
    const f = doc.getForm();
    form = {
      hasXFA: f.hasXFA(),
      fields: f.getFields().map((field) => ({ name: field.getName(), type: fieldType(field), ...fieldValue(field), settings: describeField(field) })),
      signatureFields: f.getSignatureFields().map((s) => ({ name: s.name, source: s.source })),
    };
  } catch {
    // Broken AcroForm dictionaries should not stop the rest of the report.
  }
  return {
    pageCount: doc.getPageCount(),
    encrypted: doc.isEncrypted,
    pdfA: pdfAConformance(doc),
    metadata: {
      title: doc.getTitle() ?? null,
      author: doc.getAuthor() ?? null,
      subject: doc.getSubject() ?? null,
      keywords: doc.getKeywords() ?? null,
      creator: doc.getCreator() ?? null,
      producer: doc.getProducer() ?? null,
      language: doc.getLanguage() ?? null,
      creationDate: doc.getCreationDate()?.toISOString() ?? null,
      modificationDate: doc.getModificationDate()?.toISOString() ?? null,
      copyright: custom[COPYRIGHT] ?? null,
      copyrightUrl: custom[COPYRIGHT_URL] ?? null,
      custom: Object.fromEntries(Object.entries(custom).filter(([k]) => k !== COPYRIGHT && k !== COPYRIGHT_URL)),
    },
    pages: doc.getPages().map(pageInfo),
    form,
    layers: doc.getOptionalContentGroups().map((g) => ({ name: g.name, visible: g.visible })),
    viewerPreferences: viewerPreferences(doc),
    attachments: doc.getAttachments().map((a) => ({
      name: a.name,
      size: a.data.byteLength,
      mimeType: a.mimeType ?? null,
      description: a.description ?? null,
      relationship: a.afRelationship ?? null,
    })),
    hasJavaScript: doc.getDocumentJavaScripts().length > 0,
  };
}

/** What can be read from an encrypted file without its password. */
export function lockedInfo(doc: PDFDocument): LockedInfoResponse {
  return { pageCount: doc.getPageCount(), encrypted: true, needsPassword: true, pages: doc.getPages().map(pageInfo) };
}

type TextItem = { text: string; x: number; y: number; fontSize: number; fontFamily: string };

export function extractText(doc: PDFDocument, pages: string | number[] | undefined, withItems: boolean): TextResponse["pages"] {
  const all = doc.getPages();
  return resolvePages(pages, all.length).map((i) => {
    const items: TextItem[] = [];
    for (const a of all[i].extractContents()) {
      if (a.kind === "text") items.push({ text: a.getText(), x: a.x, y: a.y, fontSize: a.fontSize, fontFamily: a.fontFamily });
    }
    return { page: i + 1, text: joinText(items), ...(withItems ? { items } : {}) };
  });
}

/** Joins text runs in paint order, starting a new line when the baseline moves. */
export function joinText(items: TextItem[]): string {
  let out = "";
  let lastY: number | undefined;
  for (const it of items) {
    if (lastY !== undefined) {
      if (Math.abs(it.y - lastY) > Math.max(2, it.fontSize * 0.5)) out += "\n";
      else if (!/\s$/.test(out) && !/^\s/.test(it.text)) out += " ";
    }
    out += it.text;
    lastY = it.y;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Document, XFA, field and page scripts. Load with preserveXFA to see XFA scripts. */
export function documentScripts(doc: PDFDocument): ScriptsResponse {
  const fields: { field: string; event: string; script: string }[] = [];
  try {
    for (const f of doc.getForm().getFields()) {
      for (const [event, action] of Object.entries(f.getJavaScriptActions() ?? {})) {
        const script = action?.getScript();
        if (script !== undefined) fields.push({ field: f.getName(), event, script });
      }
    }
  } catch {
    // No usable AcroForm.
  }
  const pages: { page: number; event: string; script: string }[] = [];
  doc.getPages().forEach((p, i) => {
    for (const [event, action] of Object.entries(p.getJavaScriptActions() ?? {})) {
      const script = action?.getScript();
      if (script !== undefined) pages.push({ page: i + 1, event, script });
    }
  });
  let xfa: { field: string; event: string; script: string }[] = [];
  try {
    xfa = doc.getXFAJavaScripts();
  } catch {
    // No XFA.
  }
  return { document: doc.getDocumentJavaScripts(), xfa, fields, pages };
}
