import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "@cantoo/pdf-lib";
import { resolvePages } from "./pages";

export function documentInfo(doc: PDFDocument) {
  let fields: { name: string; type: string; value: unknown; options?: string[] }[] = [];
  try {
    fields = doc.getForm().getFields().map((f) => {
      const name = f.getName();
      if (f instanceof PDFTextField) return { name, type: "text", value: f.getText() ?? null };
      if (f instanceof PDFCheckBox) return { name, type: "checkbox", value: f.isChecked() };
      if (f instanceof PDFDropdown) return { name, type: "dropdown", value: f.getSelected(), options: f.getOptions() };
      if (f instanceof PDFOptionList) return { name, type: "optionList", value: f.getSelected(), options: f.getOptions() };
      if (f instanceof PDFRadioGroup) return { name, type: "radio", value: f.getSelected() ?? null, options: f.getOptions() };
      return { name, type: f.constructor.name.replace(/^PDF/, "").toLowerCase(), value: null };
    });
  } catch {
    // Broken AcroForm dictionaries should not stop the rest of the report.
  }
  return {
    pageCount: doc.getPageCount(),
    encrypted: doc.isEncrypted,
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
    },
    pages: doc.getPages().map((p, i) => {
      const { width, height } = p.getSize();
      return { page: i + 1, width, height, rotation: p.getRotation().angle };
    }),
    form: { fields },
    attachments: doc.getAttachments().map((a) => ({ name: a.name, size: a.data.byteLength, mimeType: a.mimeType ?? null, description: a.description ?? null })),
  };
}

type TextItem = { text: string; x: number; y: number; fontSize: number; fontFamily: string };

export function extractText(doc: PDFDocument, pages: string | number[] | undefined, withItems: boolean) {
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
function joinText(items: TextItem[]): string {
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
