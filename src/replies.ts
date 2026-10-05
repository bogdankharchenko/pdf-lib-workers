import { z } from "zod";

// Response bodies. Tests parse real responses with these and compare, so a
// field the API returns but this file doesn't document fails a test.

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const storedFile = {
  key: z.string().describe("R2 key of the saved file."),
  url: z.string().describe("Signed download link; works without the API key until expiresAt."),
  expiresAt: z.string().describe("When the link stops working (ISO 8601)."),
};
const inlineFile = { base64: z.string().describe("The file's bytes, base64-encoded.") };

/** An object plus either storedFile or inlineFile fields, as a union of the two. */
function withFile<T extends z.ZodRawShape>(shape: T) {
  return z.union([z.object({ ...shape, ...storedFile }), z.object({ ...shape, ...inlineFile })]);
}

const pdfFacts = {
  size: z.number().int().describe("File size in bytes."),
  pageCount: z.number().int(),
};
export const StoredPdf = z.object({ ...storedFile, ...pdfFacts }).meta({ id: "StoredPdf", description: "The PDF was saved to R2." });
export const InlinePdf = z.object({ ...inlineFile, ...pdfFacts }).meta({ id: "InlinePdf", description: 'The PDF itself, for output.store: false.' });
export const PdfResult = z.union([StoredPdf, InlinePdf]).meta({ id: "PdfResult", description: "Result of create, edit or merge as JSON (the default; see the Accept header)." });

const PageInfo = z
  .object({
    page: z.number().int().describe("1-based page number."),
    width: z.number().describe("Width in points."),
    height: z.number().describe("Height in points."),
    rotation: z.number().int().describe("Clockwise rotation: 0, 90, 180 or 270."),
    boxes: z.object({ mediaBox: rect, cropBox: rect, bleedBox: rect, trimBox: rect, artBox: rect }),
  })
  .meta({ id: "PageInfo" });

export const FieldSettings = z
  .object({
    readOnly: z.boolean(),
    required: z.boolean(),
    exported: z.boolean(),
    multiline: z.boolean().optional(),
    maxLength: z.number().int().nullable().optional(),
    alignment: z.enum(["left", "center", "right"]).optional(),
    password: z.boolean().optional(),
    comb: z.boolean().optional(),
    multiselect: z.boolean().optional(),
    sort: z.boolean().optional(),
    editable: z.boolean().optional(),
    offToggle: z.boolean().optional(),
    mutuallyExclusive: z.boolean().optional(),
    checked: z.boolean().optional(),
  })
  .meta({ id: "FieldSettings", description: "A field's settings; which ones appear depends on the field type." });

const FormField = z
  .object({
    name: z.string(),
    type: z.enum(["text", "checkbox", "dropdown", "optionList", "radio", "button", "signature", "unknown"]),
    value: z
      .union([z.string(), z.boolean(), z.array(z.string()), z.null()])
      .describe("text: string or null; checkbox: boolean; dropdown/optionList: selected options; radio: selected option or null; others: null."),
    options: z.array(z.string()).optional().describe("Choices, for dropdowns, option lists and radio groups."),
    settings: FieldSettings,
  })
  .meta({ id: "FormField" });

const ViewerPreferences = z
  .object({
    pageMode: z.string().nullable(),
    pageLayout: z.string().nullable(),
    hideToolbar: z.boolean().optional(),
    hideMenubar: z.boolean().optional(),
    hideWindowUI: z.boolean().optional(),
    fitWindow: z.boolean().optional(),
    centerWindow: z.boolean().optional(),
    displayDocTitle: z.boolean().optional(),
    nonFullScreenPageMode: z.string().optional(),
    readingDirection: z.string().optional(),
    printScaling: z.string().optional(),
    duplex: z.string().nullable().optional(),
    pickTrayByPDFSize: z.boolean().nullable().optional(),
    printPageRange: z.array(z.object({ start: z.number().int(), end: z.number().int() })).optional().describe("1-based, inclusive."),
    numCopies: z.number().int().optional(),
  })
  .meta({ id: "ViewerPreferences", description: "pageMode and pageLayout are always present; the rest only when the PDF sets viewer preferences." });

export const InfoResponse = z
  .object({
    pageCount: z.number().int(),
    encrypted: z.boolean(),
    pdfA: z.string().nullable().describe('PDF/A part and level, e.g. "3B", or null.'),
    metadata: z.object({
      title: z.string().nullable(),
      author: z.string().nullable(),
      subject: z.string().nullable(),
      keywords: z.string().nullable(),
      creator: z.string().nullable(),
      producer: z.string().nullable(),
      language: z.string().nullable(),
      creationDate: z.string().nullable(),
      modificationDate: z.string().nullable(),
      copyright: z.string().nullable(),
      copyrightUrl: z.string().nullable(),
      custom: z.record(z.string(), z.string()).describe("Custom fields set with setMetadata (or by other tools)."),
    }),
    pages: z.array(PageInfo),
    form: z.object({
      hasXFA: z.boolean(),
      fields: z.array(FormField),
      signatureFields: z.array(z.object({ name: z.string(), source: z.enum(["acroform", "xfa"]) })),
    }),
    layers: z.array(z.object({ name: z.string(), visible: z.boolean() })),
    viewerPreferences: ViewerPreferences,
    attachments: z.array(
      z.object({
        name: z.string(),
        size: z.number().int(),
        mimeType: z.string().nullable(),
        description: z.string().nullable(),
        relationship: z.string().nullable(),
      }),
    ),
    hasJavaScript: z.boolean().describe("Whether the PDF has document-level JavaScript; see /pdf/scripts."),
  })
  .meta({ id: "InfoResponse" });

export const LockedInfoResponse = z
  .object({
    pageCount: z.number().int(),
    encrypted: z.literal(true),
    needsPassword: z.literal(true),
    pages: z.array(PageInfo),
  })
  .meta({ id: "LockedInfoResponse", description: "An encrypted PDF sent without its password: only its structure is readable." });

const TextItem = z.object({ text: z.string(), x: z.number(), y: z.number(), fontSize: z.number(), fontFamily: z.string() }).meta({ id: "TextItem" });

export const TextResponse = z
  .object({
    pages: z.array(
      z.object({
        page: z.number().int(),
        text: z.string().describe("Text in drawing order, with a new line where the baseline moves. Scanned pages have none (no OCR)."),
        items: z.array(TextItem).optional().describe('Only with "items": true.'),
      }),
    ),
  })
  .meta({ id: "TextResponse" });

const ExtractedImage = withFile({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().describe("Pixels."),
  height: z.number().int().describe("Pixels."),
  x: z.number(),
  y: z.number(),
  drawWidth: z.number().describe("Size drawn on the page, in points."),
  drawHeight: z.number(),
}).meta({ id: "ExtractedImage" });

const ExtractedAttachment = withFile({
  name: z.string(),
  mimeType: z.string().nullable(),
  description: z.string().nullable(),
  size: z.number().int(),
}).meta({ id: "ExtractedAttachment" });

export const ExtractResponse = z
  .object({
    pages: z.array(
      z.object({
        page: z.number().int(),
        text: z.string().optional().describe('With include "text".'),
        images: z.array(ExtractedImage).optional().describe('With include "images".'),
        graphics: z
          .array(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), svg: z.string().describe("Vector graphics, approximated as SVG.") }))
          .optional()
          .describe('With include "graphics".'),
      }),
    ),
    attachments: z.array(ExtractedAttachment).optional().describe('With include "attachments".'),
  })
  .meta({ id: "ExtractResponse" });

const Script = z.object({ event: z.string(), script: z.string() });
export const ScriptsResponse = z
  .object({
    document: z.array(z.object({ name: z.string(), script: z.string() })),
    fields: z.array(Script.extend({ field: z.string() })),
    pages: z.array(Script.extend({ page: z.number().int() })),
    xfa: z.array(Script.extend({ field: z.string() })),
  })
  .meta({ id: "ScriptsResponse" });

export const MeasureResponse = z
  .object({
    width: z.number().describe("Width of the widest line, in points."),
    height: z.number().describe("Height of one line of text, including descenders."),
    ascent: z.number().describe("Height above the baseline."),
    lines: z.array(z.object({ text: z.string(), width: z.number() })),
    blockHeight: z.number().describe("Height of all lines, using lineHeight between baselines."),
    sizeForHeight: z.number().optional().describe("With fitHeight: the font size whose text height equals it."),
  })
  .meta({ id: "MeasureResponse" });

export const SplitResponse = z
  .object({
    parts: z.array(
      z.object({
        ...storedFile,
        pages: z.array(z.number().int()).describe("1-based source pages in this part."),
        size: z.number().int(),
      }),
    ),
  })
  .meta({ id: "SplitResponse" });

export const ErrorResponse = z
  .object({
    error: z.string().describe("What went wrong. Names the failing input, e.g. sources[1] or operations[2] (removePages)."),
    details: z
      .union([z.array(z.object({ path: z.string(), message: z.string() })), z.string()])
      .optional()
      .describe("For 400 validation errors: each invalid field."),
  })
  .meta({ id: "ErrorResponse" });

export type InfoResponse = z.infer<typeof InfoResponse>;
export type LockedInfoResponse = z.infer<typeof LockedInfoResponse>;
export type TextResponse = z.infer<typeof TextResponse>;
export type ExtractResponse = z.infer<typeof ExtractResponse>;
export type ScriptsResponse = z.infer<typeof ScriptsResponse>;
export type MeasureResponse = z.infer<typeof MeasureResponse>;
export type SplitResponse = z.infer<typeof SplitResponse>;
export type PdfResult = z.infer<typeof PdfResult>;
export type FieldSettings = z.infer<typeof FieldSettings>;
