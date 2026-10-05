import fontkit from "@cantoo/fontkit";
import {
  AFRelationship,
  BlendMode,
  Duplex,
  FillRule,
  LineCapStyle,
  NonFullScreenPageMode,
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFImage,
  PDFName,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFTextField,
  PrintScaling,
  ReadingDirection,
  StandardFonts,
  TextRenderingMode,
  degrees,
  embedFacturX,
  rgb,
} from "@cantoo/pdf-lib";
import { z } from "zod";
import { badRequest } from "./errors";
import { Alignment, FIELD_EVENTS, applySettings, createField, fieldSettings, setFieldImage, setFieldScript, type Widget } from "./forms";
import { addImagePage, drawImageInBox, embedImage, imageKind, uprightSize } from "./images";
import { COPYRIGHT, COPYRIGHT_URL, CUSTOM_KEY, foreignXmp, setInfo, writeXmp } from "./metadata";
import { resolvePages } from "./pages";
import { FontSource, ImagePageOptions, Layer, PageSize, PageSpec, PdfSource, Source, pageSize } from "./schemas";
import { type Ctx, loadPdf, openPdf, readSource } from "./sources";

// ---------- shared field types ----------

const Color = z
  .string()
  .regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, "Color must be hex, e.g. #ff0000")
  .meta({ id: "Color", description: 'A hex colour: "#rrggbb" or "#rgb".', examples: ["#1d4e89", "#f00"] });
const Opacity = z.number().min(0).max(1).describe("0 (invisible) to 1 (opaque).");
const BuiltInFont = z
  .enum(Object.values(StandardFonts) as [string, ...string[]])
  .meta({ id: "BuiltInFont", description: "One of the 14 standard PDF fonts. They cover Latin text only; use a FontSource for anything else." });
export const Font = z
  .union([BuiltInFont, FontSource], {
    // A misspelled font name is the usual mistake; name it. Other inputs keep zod's detailed message.
    error: (issue) => (typeof issue.input === "string" ? `Unknown font "${issue.input}". Use a built-in font name, e.g. "Helvetica-Bold", or a font file object.` : undefined),
  })
  .meta({ id: "Font", description: "A built-in font name, or a font file. Text the font cannot draw is rejected with a 400 that names the characters." });
const OriginEnum = z.enum(["bottom-left", "top-left"]).meta({
  id: "Origin",
  description: 'How to read x/y. "bottom-left": PDF coordinates in points, y measured up from the bottom edge. "top-left": y measured down from the top edge, like screen coordinates.',
});
const Origin = OriginEnum.default("bottom-left");
const Point = z.object({ x: z.number(), y: z.number() }).meta({ id: "Point", description: "A position in points (72 pt = 1 inch)." });
const Position = z
  .enum(["center", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"])
  .meta({ id: "Position", description: "Where on the page an item is placed." });
const Blend = z.enum(Object.values(BlendMode) as [string, ...string[]]).meta({ id: "BlendMode", description: "How the drawing's colours mix with what is underneath." });
const LineCap = z.enum(["butt", "round", "projecting"]).meta({ id: "LineCap", description: "Shape of line ends." });
const Rect = z
  .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
  .meta({ id: "Rect", description: "A box in points: lower-left corner (x, y), width and height." });
const DateString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Expected a date, e.g. 2026-10-05T12:00:00Z")
  .meta({ id: "DateString", description: "A date, ideally ISO 8601.", examples: ["2026-10-05T12:00:00Z"] });

const pagesField = PageSpec.optional().describe("Pages to apply this to. Default: every page.");
const rotate = z.number().optional().describe("Rotation in degrees, counter-clockwise.");
const skew = { xSkew: z.number().optional().describe("Horizontal skew in degrees."), ySkew: z.number().optional().describe("Vertical skew in degrees.") };
const blendMode = Blend.optional();
const at = z.number().int().positive().optional().describe("1-based position to insert at. Default: after the last page.");

/** Fill and border styling shared by rectangles, ellipses and SVG paths. */
const shapeStyle = {
  color: Color.optional().describe("Fill colour. Default: no fill."),
  opacity: Opacity.optional(),
  borderColor: Color.optional().describe("Border colour. Default: no border."),
  borderWidth: z.number().nonnegative().optional().describe("Border width in points. Default: 1 when borderColor is set."),
  borderOpacity: Opacity.optional().describe("Border opacity. Default: same as opacity."),
  borderDashArray: z.array(z.number().nonnegative()).optional().describe("Dash pattern, e.g. [6, 3] = 6 pt dash, 3 pt gap."),
  borderDashPhase: z.number().optional().describe("Offset into the dash pattern."),
  borderLineCap: LineCap.optional(),
  blendMode,
};

const LINE_CAP = { butt: LineCapStyle.Butt, round: LineCapStyle.Round, projecting: LineCapStyle.Projecting } as const;
const RENDER_MODE = {
  fill: TextRenderingMode.Fill,
  outline: TextRenderingMode.Outline,
  fillAndOutline: TextRenderingMode.FillAndOutline,
  invisible: TextRenderingMode.Invisible,
} as const;

/** One operation: its `op` name, fields, and a named, described schema ("AddPageOperation", …). */
function op<N extends string, T extends z.ZodRawShape>(name: N, description: string, shape: T) {
  return z.object({ op: z.literal(name), ...shape }).meta({ id: `${name[0].toUpperCase()}${name.slice(1)}Operation`, description });
}

// ---------- operations ----------

const variants = [
  // pages
  op("addPage", "Adds blank pages.", {
    size: PageSize.default("A4"),
    at,
    count: z.number().int().positive().max(1000).default(1).describe("How many pages to add."),
  }),
  op("removePages", "Removes pages. At least one page must remain.", { pages: PageSpec.describe("Pages to remove.") }),
  op("selectPages", "Keeps only these pages, in this order: use it to extract, reorder, reverse or repeat pages.", {
    pages: PageSpec.describe('Pages to keep, in the new order. Repeats are allowed, e.g. "1,1,2".'),
  }),
  op("duplicatePage", "Copies one page.", {
    page: z.number().int().describe("1-based page to copy; negatives count from the end."),
    at: z.number().int().positive().optional().describe("1-based position for the copy. Default: right after the original."),
  }),
  op("rotatePages", "Rotates pages by a multiple of 90°.", {
    pages: pagesField,
    degrees: z.number().int().multipleOf(90).describe("Clockwise turn: 90, 180, 270 (or negative)."),
    relative: z.boolean().default(true).describe("true adds to the current rotation; false sets it outright."),
  }),
  op("resizePages", "Changes the paper size.", {
    pages: pagesField,
    size: PageSize,
    scaleContent: z.boolean().default(true).describe("true shrinks or grows the content to fit and centres it; false only changes the paper size."),
  }),
  op("cropPages", "Sets the visible area (crop box). Content outside it is hidden, not removed.", {
    pages: pagesField,
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  op("setPageBoxes", "Sets any of the five page boxes: media (paper), crop (visible area), bleed, trim and art (print production).", {
    pages: pagesField,
    mediaBox: Rect.optional(),
    cropBox: Rect.optional(),
    bleedBox: Rect.optional(),
    trimBox: Rect.optional(),
    artBox: Rect.optional(),
  }),
  op("scalePages", "Scales pages.", {
    pages: pagesField,
    factor: z
      .union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive()])])
      .describe("One factor for both directions, or [x, y]. 0.5 halves the size."),
    target: z
      .enum(["page", "content", "annotations"])
      .default("page")
      .describe('"page" scales the paper, content and form fields together; "content" or "annotations" scale only those.'),
  }),
  op("translateContent", "Moves everything drawn on the page by (x, y) points.", { pages: pagesField, x: z.number(), y: z.number() }),
  op("insertPdf", "Inserts pages from another PDF, or a PNG/JPEG image as a new page.", {
    source: PdfSource.describe("The PDF or image to insert."),
    pages: PageSpec.optional().describe("PDFs only: which pages to insert. Default: all."),
    at,
    ...ImagePageOptions,
  }),

  // drawing
  op("drawText", "Draws text.", {
    pages: pagesField,
    text: z.string().describe('The text. "\\n" starts a new line.'),
    x: z.number(),
    y: z.number().describe("Baseline of the first line (bottom-left origin), or top of the text (top-left origin)."),
    origin: Origin,
    size: z.number().positive().default(12).describe("Font size in points."),
    font: Font.default(StandardFonts.Helvetica),
    color: Color.default("#000000"),
    opacity: Opacity.optional(),
    rotate,
    ...skew,
    maxWidth: z.number().positive().optional().describe("Wrap lines at this width, in points."),
    lineHeight: z.number().positive().optional().describe("Distance between baselines. Default: 1.2 × size."),
    wordBreaks: z.array(z.string()).optional().describe('Characters after which a line may wrap (with maxWidth). Default: [" "].'),
    characterSpacing: z.number().optional().describe("Extra space between characters, in points."),
    renderMode: z.enum(["fill", "outline", "fillAndOutline", "invisible"]).optional().describe('"invisible" text can still be selected and searched.'),
    strokeColor: Color.optional().describe("Outline colour, for the outline render modes."),
    strokeWidth: z.number().nonnegative().optional().describe("Outline width in points."),
    blendMode,
  }),
  op("drawImage", "Draws a PNG or JPEG. JPEG photos are turned upright using their EXIF orientation.", {
    pages: pagesField,
    image: Source.describe("A PNG or JPEG."),
    x: z.number(),
    y: z.number().describe("Bottom edge (bottom-left origin) or top edge (top-left origin) of the image."),
    origin: Origin,
    width: z.number().positive().optional().describe("Width in points. Give one of width/height to keep the aspect ratio; neither draws 1 px per point."),
    height: z.number().positive().optional(),
    opacity: Opacity.optional(),
    rotate,
    ...skew,
    blendMode,
  }),
  op("drawRectangle", "Draws a rectangle, optionally with rounded corners.", {
    pages: pagesField,
    x: z.number(),
    y: z.number().describe("Bottom edge (bottom-left origin) or top edge (top-left origin)."),
    origin: Origin,
    width: z.number(),
    height: z.number(),
    rx: z.number().nonnegative().optional().describe("Horizontal corner radius."),
    ry: z.number().nonnegative().optional().describe("Vertical corner radius."),
    rotate,
    ...skew,
    ...shapeStyle,
  }),
  op("drawEllipse", "Draws an ellipse or circle centred on (x, y).", {
    pages: pagesField,
    x: z.number(),
    y: z.number(),
    origin: Origin,
    xRadius: z.number().positive(),
    yRadius: z.number().positive().optional().describe("Default: xRadius (a circle)."),
    rotate,
    ...shapeStyle,
  }),
  op("drawLine", "Draws a straight line.", {
    pages: pagesField,
    start: Point,
    end: Point,
    origin: Origin,
    thickness: z.number().positive().default(1),
    color: Color.default("#000000"),
    opacity: Opacity.optional(),
    lineCap: LineCap.optional(),
    dashArray: z.array(z.number().nonnegative()).optional().describe("Dash pattern, e.g. [6, 3]."),
    dashPhase: z.number().optional(),
    blendMode,
  }),
  op("drawSvgPath", "Draws an SVG path. Its y axis points down from (x, y). Fills black when neither colour nor border is given.", {
    pages: pagesField,
    path: z.string().min(1).describe('SVG path data, e.g. "M 0 0 L 100 0 L 50 80 Z".'),
    x: z.number(),
    y: z.number(),
    origin: Origin,
    scale: z.number().positive().optional(),
    rotate,
    fillRule: z.enum(["nonzero", "evenodd"]).optional(),
    ...shapeStyle,
  }),
  op("drawSvg", "Draws an SVG document (shapes, text, transforms).", {
    pages: pagesField,
    svg: z.string().min(1).describe("SVG markup."),
    x: z.number(),
    y: z.number().describe("Top-left corner of the SVG."),
    origin: Origin,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fontSize: z.number().positive().optional().describe("Default size for SVG text."),
    fonts: z.record(z.string(), Font).optional().describe("Fonts for SVG text, keyed by the font-family name used in the SVG."),
    blendMode,
  }),
  op("drawPdfPage", "Draws a page of another PDF onto pages: letterheads, backgrounds, stamps, several pages on one sheet.", {
    pages: pagesField,
    source: PdfSource.describe("The PDF to take the page from."),
    page: z.number().int().default(1).describe("1-based page of the source; negatives count from the end."),
    clip: z
      .object({ left: z.number(), bottom: z.number(), right: z.number(), top: z.number() })
      .meta({ id: "ClipBox", description: "A rectangle by its edges, in the source page's coordinates." })
      .optional()
      .describe("Part of the source page to use, in its own coordinates. Default: the whole page."),
    x: z.number().default(0),
    y: z.number().default(0).describe("Bottom edge (bottom-left origin) or top edge (top-left origin)."),
    origin: Origin,
    width: z.number().positive().optional().describe("Give one of width/height to keep the aspect ratio."),
    height: z.number().positive().optional(),
    scale: z.number().positive().optional().describe("Alternative to width/height: a factor of the source size."),
    opacity: Opacity.optional(),
    rotate,
    ...skew,
    blendMode,
    behind: z.boolean().default(false).describe("Draw under the page's existing content, e.g. a letterhead background."),
  }),
  z
    .object({
      op: z.literal("watermark"),
      pages: pagesField,
      text: z.string().min(1).optional().describe("Text to stamp. Give text or image."),
      image: Source.optional().describe("A PNG or JPEG to stamp, e.g. a logo. Give text or image."),
      scale: z.number().positive().max(1).default(0.5).describe("Images: width as a share of the page width."),
      size: z.number().positive().default(60).describe("Text: font size."),
      font: Font.default(StandardFonts.HelveticaBold),
      color: Color.default("#888888"),
      opacity: Opacity.default(0.25),
      rotate: z.number().optional().describe("Degrees, counter-clockwise. Default: 45 for text, 0 for images."),
      position: Position.default("center"),
      margin: z.number().nonnegative().default(24).describe("Distance from the page edge, for corner positions."),
      blendMode,
    })
    .refine((o) => !o.text !== !o.image, "Give text or image")
    .meta({
      id: "WatermarkOperation",
      description: "Stamps text or an image (give one) on each page, centred or in a corner, at any angle and opacity.",
    }),
  op("pageNumbers", "Writes page numbers.", {
    pages: pagesField,
    format: z.string().default("{page} / {total}").describe('Text to write; "{page}" and "{total}" are replaced.'),
    position: z
      .enum(["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"])
      .default("bottom-center"),
    margin: z.number().nonnegative().default(24),
    size: z.number().positive().default(10),
    font: Font.default(StandardFonts.Helvetica),
    color: Color.default("#000000"),
    startAt: z.number().int().default(1).describe("Number of the first page."),
  }),

  // forms
  op("fillForm", "Fills form fields by name (see /pdf/info for names and types).", {
    fields: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
      .default({})
      .describe("Text fields take a string; checkboxes true/false; dropdowns and option lists an option or array of options; radio groups an option."),
    images: z.record(z.string(), Source).optional().describe("Images for text fields or buttons, by field name (e.g. a signature box)."),
    imageAlignment: Alignment.optional(),
    flatten: z.boolean().default(false).describe("Turn the fields into plain page content afterwards, so they can no longer be edited."),
    strict: z.boolean().default(true).describe("Fail on unknown field names instead of ignoring them."),
    font: Font.optional().describe("Font for the filled-in values. Default: Helvetica. Use a font file for non-Latin text."),
  }),
  op("flattenForm", "Turns all form fields into plain page content.", { font: Font.optional().describe("Font used to draw the values. Default: Helvetica.") }),
  op("addFormField", "Creates a form field. Text, checkbox, dropdown, optionList and button need page, x, y, width and height; radio needs choices.", {
    type: z.enum(["text", "checkbox", "dropdown", "optionList", "radio", "button"]),
    name: z.string().min(1).describe("Unique field name."),
    page: z.number().int().default(1).describe("1-based page."),
    x: z.number().optional(),
    y: z.number().optional().describe("Bottom edge (bottom-left origin) or top edge (top-left origin)."),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    origin: Origin,
    value: z.union([z.string(), z.boolean(), z.array(z.string())]).optional().describe("Starting value: text, checkbox true/false, the selected option(s)."),
    choices: z
      .array(
        z.object({
          value: z.string().min(1),
          page: z.number().int().optional().describe("Default: the field's page."),
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .meta({ id: "RadioChoice", description: "One radio button: its value and its box." }),
      )
      .optional()
      .describe("Radio groups: one entry per choice, each with its own box."),
    label: z.string().optional().describe("Button caption."),
    font: Font.optional(),
    textColor: Color.optional(),
    backgroundColor: Color.optional(),
    borderColor: Color.optional(),
    borderWidth: z.number().nonnegative().optional().describe("Default: 1 when borderColor is set."),
    rotate,
    hidden: z.boolean().optional(),
    ...fieldSettings,
  }),
  op("setFieldProperties", "Changes a field's settings, or shows an image in it.", {
    name: z.string().min(1),
    ...fieldSettings,
    image: Source.optional().describe("Text fields and buttons: an image to show in the field."),
    imageAlignment: Alignment.optional(),
    font: Font.optional().describe("Font used to redraw the field. Default: Helvetica."),
  }),
  op("removeFormFields", "Removes form fields.", { names: z.array(z.string().min(1)).min(1) }),
  op("setFieldScript", "Replaces the script of a field's existing action (see /pdf/scripts). New actions cannot be added.", {
    name: z.string().min(1),
    event: z.enum(FIELD_EVENTS),
    script: z.string(),
  }),

  // scripts
  op("addJavaScript", "Adds document-level JavaScript, run when the PDF opens in viewers that allow it.", {
    name: z.string().min(1),
    script: z.string(),
  }),
  op("setXFAJavaScript", 'Replaces a script in an XFA form. The source needs "preserveXFA": true.', {
    field: z.string().min(1),
    event: z.string().min(1).describe('XFA event, e.g. "event__click" (see /pdf/scripts).'),
    script: z.string(),
  }),
  op("deleteXFA", "Removes XFA form data, leaving the regular form fields.", {}),

  // document
  op("setLayerVisibility", "Shows or hides layers (optional content groups). See /pdf/info for layer names.", {
    layers: z.array(Layer).min(1),
  }),
  op("setViewerPreferences", "Controls how viewers open the PDF.", {
    hideToolbar: z.boolean().optional(),
    hideMenubar: z.boolean().optional(),
    hideWindowUI: z.boolean().optional(),
    fitWindow: z.boolean().optional(),
    centerWindow: z.boolean().optional(),
    displayDocTitle: z.boolean().optional().describe("Show the title, not the file name, in the window bar."),
    pageMode: z.enum(["UseNone", "UseOutlines", "UseThumbs", "FullScreen", "UseOC", "UseAttachments"]).optional().describe("Which panel is open, or full screen."),
    pageLayout: z.enum(["SinglePage", "OneColumn", "TwoColumnLeft", "TwoColumnRight", "TwoPageLeft", "TwoPageRight"]).optional(),
    nonFullScreenPageMode: z.enum(Object.values(NonFullScreenPageMode) as [string, ...string[]]).optional().describe("Panel shown after leaving full screen."),
    readingDirection: z.enum(Object.values(ReadingDirection) as [string, ...string[]]).optional(),
    printScaling: z.enum(Object.values(PrintScaling) as [string, ...string[]]).optional().describe('Print dialog default; "None" prints at actual size.'),
    duplex: z.enum(Object.values(Duplex) as [string, ...string[]]).optional(),
    pickTrayByPDFSize: z.boolean().optional(),
    printPageRange: PageSpec.optional().describe("Print dialog's default page range."),
    numCopies: z.number().int().min(1).max(5).optional().describe("Print dialog's default number of copies."),
  }),
  op("setMetadata", "Sets document properties, copyright and custom fields, in both the Info dictionary and XMP. Run it before convertToPDFA.", {
    title: z.string().optional(),
    showTitleInWindow: z.boolean().optional().describe("Show the title instead of the file name in viewers' title bar."),
    author: z.string().optional(),
    subject: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    creator: z.string().optional().describe("The application that made the original content."),
    producer: z.string().optional().describe("The application that made the PDF."),
    language: z.string().optional().describe('Language tag, e.g. "en-GB".'),
    creationDate: DateString.optional(),
    modificationDate: DateString.optional().describe("Default: now."),
    copyright: z.string().optional().describe('e.g. "© 2026 Acme Inc. All rights reserved." Shown as Acrobat\'s copyright notice.'),
    copyrightUrl: z.url().optional().describe("Page with licence or ownership details."),
    custom: z
      .record(z.string().regex(CUSTOM_KEY, "Custom keys are letters, digits and _, starting with a letter"), z.string().nullable())
      .optional()
      .describe('Your own fields, e.g. { "MadeFor": "Client X" }. Keys are letters, digits and _ (max 64). null removes a field.'),
  }),
  op("attachFile", "Embeds a file inside the PDF.", {
    file: Source,
    name: z.string().min(1).describe("File name shown in viewers."),
    mimeType: z.string().optional(),
    description: z.string().optional(),
    creationDate: DateString.optional(),
    modificationDate: DateString.optional(),
    relationship: z
      .enum(["Source", "Data", "Alternative", "Supplement", "EncryptedPayload", "Schema", "Unspecified"])
      .optional()
      .describe("How the file relates to the PDF (PDF/A-3 associated files)."),
  }),
  op("detachFile", "Removes an embedded file.", { name: z.string().min(1) }),
  op("convertToPDFA", "Adds what PDF/A requires (sRGB output intent, file ID, XMP). Text must use an embedded font file, and the PDF must not be encrypted.", {
    conformance: z.enum(["1B", "2B", "2U", "3B", "3U"]).default("3B"),
    iccProfile: Source.optional().describe("ICC colour profile. Default: sRGB."),
    outputConditionIdentifier: z.string().optional(),
    colorComponents: z.union([z.literal(1), z.literal(3), z.literal(4)]).optional().describe("Components of the ICC profile: 1 gray, 3 RGB, 4 CMYK."),
  }),
  op("embedFacturX", "Makes a Factur-X / ZUGFeRD e-invoice: attaches your invoice XML and makes the PDF PDF/A-3. The XML is not generated or checked.", {
    xml: Source.describe("The complete Factur-X / ZUGFeRD XML."),
    conformanceLevel: z.enum(["MINIMUM", "BASIC WL", "BASIC", "EN 16931", "EXTENDED", "XRECHNUNG"]).optional(),
    fileName: z.string().optional(),
    version: z.string().optional(),
    documentType: z.string().optional(),
    description: z.string().optional(),
  }),
  op("encrypt", "Password-protects the PDF. Applied when the file is saved.", {
    ownerPassword: z.string().min(1).describe("Gives full access."),
    userPassword: z.string().optional().describe("Needed to open the file. Empty or omitted: opens without a password, permissions still apply."),
    algorithm: z.enum(["AES-256", "AES-128", "RC4-128", "RC4-40"]).default("AES-256"),
    allowWeakCryptography: z.boolean().optional().describe("Required for RC4, which is broken; only for viewers older than 2005."),
    permissions: z
      .object({
        printing: z.union([z.boolean(), z.enum(["lowResolution", "highResolution"])]).optional(),
        modifying: z.boolean().optional(),
        copying: z.boolean().optional(),
        annotating: z.boolean().optional(),
        fillingForms: z.boolean().optional(),
        contentAccessibility: z.boolean().optional(),
        documentAssembly: z.boolean().optional(),
      })
      .meta({ id: "Permissions", description: "What user-password holders may do. Everything is allowed unless set to false." })
      .optional(),
  }),
] as const;

export const Operation = z.discriminatedUnion("op", variants).meta({
  id: "Operation",
  description: "One step of an `operations` list. Steps run in order.",
  discriminator: {
    propertyName: "op",
    mapping: Object.fromEntries(variants.map((v) => [v.shape.op.value, `#/components/schemas/${z.globalRegistry.get(v)?.id}`])),
  },
});
export type Operation = z.infer<typeof Operation>;
export const Operations = z.array(Operation).max(500).describe("Steps to run, in order (max 500). A failing step is named in the error: operations[2] (removePages): …");

/**
 * Adds a PDF's pages (or some of them) or a PNG/JPEG image as a page, at
 * index `at` (default: the end). Used by merge and insertPdf.
 */
export async function addSource(
  doc: PDFDocument,
  bytes: Uint8Array,
  opts: { password?: string; preserveXFA?: boolean; pages?: z.infer<typeof PageSpec>; size: z.infer<typeof ImagePageOptions.size>; margin: number },
  at = doc.getPageCount(),
) {
  if (imageKind(bytes)) {
    if (opts.pages !== undefined) throw badRequest('"pages" does not apply to an image');
    return addImagePage(doc, bytes, opts.size === "image" ? "image" : pageSize(opts.size), opts.margin, at);
  }
  const src = await openPdf(bytes, opts.password, { preserveXFA: opts.preserveXFA });
  for (const p of await doc.copyPages(src, resolvePages(opts.pages, src.getPageCount()))) doc.insertPage(at++, p);
}

// ---------- helpers ----------

function color(hex: string) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
const col = (hex?: string) => (hex ? color(hex) : undefined);
const deg = (n?: number) => (n === undefined ? undefined : degrees(n));
const blend = (b?: string) => b as BlendMode | undefined;

/** Library options for the shared fill/border styling. */
function shape(op: { [K in keyof typeof shapeStyle]?: z.infer<(typeof shapeStyle)[K]> }) {
  return {
    color: col(op.color),
    opacity: op.opacity,
    borderColor: col(op.borderColor),
    borderWidth: op.borderWidth ?? (op.borderColor ? 1 : 0),
    borderOpacity: op.borderOpacity ?? op.opacity,
    borderDashArray: op.borderDashArray,
    borderDashPhase: op.borderDashPhase,
    borderLineCap: op.borderLineCap ? LINE_CAP[op.borderLineCap] : undefined,
    blendMode: blend(op.blendMode),
  };
}

const charSets = new WeakMap<PDFFont, Set<number>>();

/**
 * The library silently draws "?" for characters a font lacks (e.g. Cyrillic in
 * Helvetica). Refuse instead, so nobody ships a PDF full of question marks.
 */
export function checkText(font: PDFFont, text: string) {
  let set = charSets.get(font);
  if (!set) charSets.set(font, (set = new Set(font.getCharacterSet())));
  const missing = [...new Set([...text].filter((ch) => !/\s/.test(ch) && !set!.has(ch.codePointAt(0)!)))];
  if (missing.length) {
    throw badRequest(`Font ${font.name} cannot draw ${missing.slice(0, 10).map((c) => JSON.stringify(c)).join(", ")}. Pass a "font" file (TTF/OTF) that has these characters.`);
  }
}

/** Embeds a standard font or a font file. */
export async function embedFontSpec(doc: PDFDocument, ctx: Ctx, spec: z.infer<typeof Font>): Promise<PDFFont> {
  if (typeof spec === "string") return doc.embedFont(spec as StandardFonts);
  doc.registerFontkit(fontkit);
  return doc.embedFont(await readSource(ctx, spec), { subset: true, postscriptName: spec.postscriptName });
}

/** Groups 0-based page indices into the {start, end} ranges viewer preferences use. */
function toRanges(idx: number[]) {
  const sorted = [...new Set(idx)].sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else out.push({ start: i, end: i });
  }
  return out;
}

/** Makes the next drawing on `page` start a fresh content stream (pdf-lib reuses one per page). */
function freshContentStream(page: PDFPage) {
  const p = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  p.contentStream = undefined;
  p.contentStreamRef = undefined;
}

/** Runs operations in order against one document, caching fonts and images. */
export class Editor {
  private fonts = new Map<string, PDFFont>();
  private images = new Map<string, { image: PDFImage; orientation: number }>();

  constructor(
    private ctx: Ctx,
    public doc: PDFDocument,
  ) {}

  async run(ops: Operation[]) {
    for (const [i, op] of ops.entries()) {
      try {
        await this.apply(op);
      } catch (e) {
        if (e instanceof Error) e.message = `operations[${i}] (${op.op}): ${e.message}`;
        throw e;
      }
    }
  }

  private pages(spec: z.infer<typeof PageSpec> | undefined) {
    const all = this.doc.getPages();
    return resolvePages(spec, all.length).map((i) => all[i]);
  }

  private page(n: number) {
    const all = this.doc.getPages();
    return all[resolvePages([n], all.length)[0]];
  }

  private async font(spec: z.infer<typeof Font>): Promise<PDFFont> {
    const id = typeof spec === "string" ? spec : JSON.stringify(spec);
    let f = this.fonts.get(id);
    if (!f) {
      f = await embedFontSpec(this.doc, this.ctx, spec);
      this.fonts.set(id, f);
    }
    return f;
  }

  private async image(spec: Source) {
    const id = JSON.stringify(spec);
    let img = this.images.get(id);
    if (!img) {
      const bytes = await readSource(this.ctx, spec);
      if (!imageKind(bytes)) throw badRequest("Image must be PNG or JPEG");
      img = await embedImage(this.doc, bytes);
      this.images.set(id, img);
    }
    return img;
  }

  private field(name: string): PDFField {
    const f = this.doc.getForm().getFieldMaybe(name);
    if (!f) throw badRequest(`No form field named "${name}"`);
    return f;
  }

  /** Redraws one field's appearance in `font`, refusing characters the font lacks. */
  private redrawField(f: PDFField, font: PDFFont) {
    const check = (v: string) => {
      try {
        checkText(font, v);
      } catch (e) {
        (e as Error).message = `Field "${f.getName()}": ${(e as Error).message}`;
        throw e;
      }
    };
    if (f instanceof PDFTextField) {
      check(f.getText() ?? "");
      f.updateAppearances(font);
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
      f.getSelected().forEach(check);
      f.updateAppearances(font);
    } else if (f instanceof PDFButton) {
      f.updateAppearances(font);
    } else if (f instanceof PDFCheckBox || f instanceof PDFRadioGroup) {
      f.updateAppearances();
    }
  }

  /** Redraws every field's values in `font` (default Helvetica). */
  private async redrawFields(spec: z.infer<typeof Font> | undefined, skip = new Set<string>()) {
    const font = await this.font(spec ?? StandardFonts.Helvetica);
    for (const f of this.doc.getForm().getFields()) if (!skip.has(f.getName())) this.redrawField(f, font);
  }

  private async apply(op: Operation) {
    const doc = this.doc;
    // Converts a top-left y to PDF's bottom-left y for an item of height h.
    const flipY = (page: { getHeight(): number }, origin: string, y: number, h = 0) => (origin === "top-left" ? page.getHeight() - y - h : y);

    switch (op.op) {
      // ----- pages -----
      case "addPage": {
        const size = pageSize(op.size);
        for (let n = 0; n < op.count; n++) {
          if (op.at === undefined) doc.addPage(size);
          else doc.insertPage(Math.min(op.at - 1 + n, doc.getPageCount()), size);
        }
        break;
      }
      case "removePages": {
        const idx = [...new Set(resolvePages(op.pages, doc.getPageCount()))].sort((a, b) => b - a);
        if (idx.length >= doc.getPageCount()) throw badRequest("Cannot remove every page");
        for (const i of idx) doc.removePage(i);
        break;
      }
      case "selectPages": {
        const idx = resolvePages(op.pages, doc.getPageCount());
        if (!idx.length) throw badRequest("No pages selected");
        // Copy so the same page may appear twice; this also drops unused pages.
        const copies = await doc.copyPages(doc, idx);
        for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
        for (const p of copies) doc.addPage(p);
        break;
      }
      case "duplicatePage": {
        const [i] = resolvePages([op.page], doc.getPageCount());
        const [copy] = await doc.copyPages(doc, [i]);
        doc.insertPage(Math.min((op.at ?? i + 2) - 1, doc.getPageCount()), copy);
        break;
      }
      case "rotatePages":
        for (const p of this.pages(op.pages)) {
          const base = op.relative ? p.getRotation().angle : 0;
          p.setRotation(degrees((((base + op.degrees) % 360) + 360) % 360));
        }
        break;
      case "resizePages": {
        const [w, h] = pageSize(op.size);
        for (const p of this.pages(op.pages)) {
          if (op.scaleContent) {
            // Fit content inside the new size, keeping its aspect ratio, and centre it.
            const s = Math.min(w / p.getWidth(), h / p.getHeight());
            const [sw, sh] = [p.getWidth() * s, p.getHeight() * s];
            p.scale(s, s);
            p.setSize(w, h);
            p.translateContent((w - sw) / 2, (h - sh) / 2);
          } else {
            p.setSize(w, h);
          }
        }
        break;
      }
      case "cropPages":
        for (const p of this.pages(op.pages)) p.setCropBox(op.x, op.y, op.width, op.height);
        break;
      case "setPageBoxes":
        for (const p of this.pages(op.pages)) {
          const set = (r: z.infer<typeof Rect> | undefined, fn: (x: number, y: number, w: number, h: number) => void) => r && fn.call(p, r.x, r.y, r.width, r.height);
          set(op.mediaBox, p.setMediaBox);
          set(op.cropBox, p.setCropBox);
          set(op.bleedBox, p.setBleedBox);
          set(op.trimBox, p.setTrimBox);
          set(op.artBox, p.setArtBox);
        }
        break;
      case "scalePages": {
        const [sx, sy] = typeof op.factor === "number" ? [op.factor, op.factor] : op.factor;
        for (const p of this.pages(op.pages)) {
          if (op.target === "page") p.scale(sx, sy);
          else if (op.target === "content") p.scaleContent(sx, sy);
          else p.scaleAnnotations(sx, sy);
        }
        break;
      }
      case "translateContent":
        for (const p of this.pages(op.pages)) p.translateContent(op.x, op.y);
        break;
      case "insertPdf": {
        const at = op.at === undefined ? doc.getPageCount() : Math.min(op.at - 1, doc.getPageCount());
        await addSource(doc, await readSource(this.ctx, op.source), { ...op, password: op.source.password, preserveXFA: op.source.preserveXFA }, at);
        break;
      }

      // ----- drawing -----
      case "drawText": {
        const font = await this.font(op.font);
        checkText(font, op.text);
        for (const p of this.pages(op.pages)) {
          p.drawText(op.text, {
            x: op.x,
            y: flipY(p, op.origin, op.y, op.origin === "top-left" ? font.heightAtSize(op.size) : 0),
            size: op.size,
            font,
            color: color(op.color),
            opacity: op.opacity,
            rotate: deg(op.rotate),
            xSkew: deg(op.xSkew),
            ySkew: deg(op.ySkew),
            maxWidth: op.maxWidth,
            lineHeight: op.lineHeight ?? op.size * 1.2,
            wordBreaks: op.wordBreaks,
            characterSpacing: op.characterSpacing,
            renderMode: op.renderMode ? RENDER_MODE[op.renderMode] : undefined,
            strokeColor: col(op.strokeColor),
            strokeWidth: op.strokeWidth,
            blendMode: blend(op.blendMode),
          });
        }
        break;
      }
      case "drawImage": {
        const { image: img, orientation } = await this.image(op.image);
        const [uw, uh] = uprightSize(img, orientation);
        const w = op.width ?? (op.height ? (uw * op.height) / uh : uw);
        const h = op.height ?? (op.width ? (uh * op.width) / uw : uh);
        for (const p of this.pages(op.pages)) {
          const y = flipY(p, op.origin, op.y, h);
          // Plain placements are drawn upright per the image's EXIF orientation.
          if (op.rotate === undefined && op.xSkew === undefined && op.ySkew === undefined && op.blendMode === undefined) {
            drawImageInBox(p, img, orientation, { x: op.x, y, width: w, height: h }, op.opacity);
            continue;
          }
          p.drawImage(img, { x: op.x, y, width: w, height: h, opacity: op.opacity, rotate: deg(op.rotate), xSkew: deg(op.xSkew), ySkew: deg(op.ySkew), blendMode: blend(op.blendMode) });
        }
        break;
      }
      case "drawRectangle":
        for (const p of this.pages(op.pages)) {
          p.drawRectangle({
            x: op.x,
            y: flipY(p, op.origin, op.y, op.height),
            width: op.width,
            height: op.height,
            rx: op.rx,
            ry: op.ry,
            rotate: deg(op.rotate),
            xSkew: deg(op.xSkew),
            ySkew: deg(op.ySkew),
            ...shape(op),
          });
        }
        break;
      case "drawEllipse":
        for (const p of this.pages(op.pages)) {
          p.drawEllipse({ x: op.x, y: flipY(p, op.origin, op.y), xScale: op.xRadius, yScale: op.yRadius ?? op.xRadius, rotate: deg(op.rotate), ...shape(op) });
        }
        break;
      case "drawLine":
        for (const p of this.pages(op.pages)) {
          p.drawLine({
            start: { x: op.start.x, y: flipY(p, op.origin, op.start.y) },
            end: { x: op.end.x, y: flipY(p, op.origin, op.end.y) },
            thickness: op.thickness,
            color: color(op.color),
            opacity: op.opacity,
            lineCap: op.lineCap ? LINE_CAP[op.lineCap] : undefined,
            dashArray: op.dashArray,
            dashPhase: op.dashPhase,
            blendMode: blend(op.blendMode),
          });
        }
        break;
      case "drawSvgPath":
        for (const p of this.pages(op.pages)) {
          const style = shape(op);
          p.drawSvgPath(op.path, {
            x: op.x,
            y: flipY(p, op.origin, op.y),
            scale: op.scale,
            rotate: deg(op.rotate),
            fillRule: op.fillRule === "evenodd" ? FillRule.EvenOdd : op.fillRule === "nonzero" ? FillRule.NonZero : undefined,
            ...style,
            // A path with neither fill nor border would be invisible; default to a black fill like the library.
            color: style.color ?? (op.borderColor ? undefined : rgb(0, 0, 0)),
          });
        }
        break;
      case "drawSvg": {
        const svg = await doc.embedSvg(op.svg);
        const fonts: Record<string, PDFFont> = {};
        for (const [name, spec] of Object.entries(op.fonts ?? {})) fonts[name] = await this.font(spec);
        for (const p of this.pages(op.pages)) {
          // drawSvg places the SVG's top-left corner at (x, y).
          p.drawSvg(svg, {
            x: op.x,
            y: op.origin === "top-left" ? p.getHeight() - op.y : op.y,
            width: op.width,
            height: op.height,
            fontSize: op.fontSize,
            fonts: op.fonts ? fonts : undefined,
            blendMode: blend(op.blendMode),
          });
        }
        break;
      }
      case "drawPdfPage": {
        const src = await loadPdf(this.ctx, op.source);
        const srcPage = src.getPage(resolvePages([op.page], src.getPageCount())[0]);
        const embedded = await doc.embedPage(srcPage, op.clip);
        const natural = op.scale ? embedded.scale(op.scale) : embedded.size();
        const w = op.width ?? (op.height ? (natural.width * op.height) / natural.height : natural.width);
        const h = op.height ?? (op.width ? (natural.height * op.width) / natural.width : natural.height);
        for (const p of this.pages(op.pages)) {
          if (op.behind) freshContentStream(p);
          p.drawPage(embedded, {
            x: op.x,
            y: flipY(p, op.origin, op.y, h),
            width: w,
            height: h,
            opacity: op.opacity,
            rotate: deg(op.rotate),
            xSkew: deg(op.xSkew),
            ySkew: deg(op.ySkew),
            blendMode: blend(op.blendMode),
          });
          if (op.behind) {
            // Move the stream just drawn to the front, so existing content paints over it.
            const contents = p.node.Contents();
            if (contents instanceof PDFArray && contents.size() > 1) {
              const last = contents.get(contents.size() - 1);
              contents.remove(contents.size() - 1);
              contents.insert(0, last);
            }
            freshContentStream(p);
          }
        }
        break;
      }
      case "watermark": {
        const rotate = op.rotate ?? (op.text ? 45 : 0);
        const rad = (rotate * Math.PI) / 180;
        const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
        let draw: (page: PDFPage, w: number, h: number, x: number, y: number) => void;
        let sizeOn: (page: PDFPage) => [number, number];
        if (op.text) {
          const font = await this.font(op.font);
          checkText(font, op.text);
          const tw = font.widthOfTextAtSize(op.text, op.size);
          const th = font.heightAtSize(op.size, { descender: false });
          sizeOn = () => [tw, th];
          draw = (p, _w, _h, x, y) =>
            p.drawText(op.text!, { x, y, size: op.size, font, color: color(op.color), opacity: op.opacity, rotate: degrees(rotate), blendMode: blend(op.blendMode) });
        } else {
          const { image, orientation } = await this.image(op.image!);
          const [uw, uh] = uprightSize(image, orientation);
          sizeOn = (p) => [p.getWidth() * op.scale, (p.getWidth() * op.scale * uh) / uw];
          draw = (p, w, h, x, y) => {
            if (rotate === 0 && !op.blendMode) return drawImageInBox(p, image, orientation, { x, y, width: w, height: h }, op.opacity);
            p.drawImage(image, { x, y, width: w, height: h, opacity: op.opacity, rotate: degrees(rotate), blendMode: blend(op.blendMode) });
          };
        }
        const all = doc.getPages();
        for (const i of resolvePages(op.pages, all.length)) {
          const p = all[i];
          const [w, h] = sizeOn(p);
          // Bounding box of the rotated item, then the spot its centre should land on.
          const bw = Math.abs(cos) * w + Math.abs(sin) * h;
          const bh = Math.abs(sin) * w + Math.abs(cos) * h;
          const [v, hz] = op.position === "center" ? ["center", "center"] : op.position.split("-");
          const cx = hz === "left" ? op.margin + bw / 2 : hz === "right" ? p.getWidth() - op.margin - bw / 2 : p.getWidth() / 2;
          const cy = v === "bottom" ? op.margin + bh / 2 : v === "top" ? p.getHeight() - op.margin - bh / 2 : p.getHeight() / 2;
          // Items rotate around their bottom-left corner; shift so the centre lands on (cx, cy).
          draw(p, w, h, cx - (cos * w - sin * h) / 2, cy - (sin * w + cos * h) / 2);
        }
        break;
      }
      case "pageNumbers": {
        const font = await this.font(op.font);
        checkText(font, op.format);
        const all = doc.getPages();
        const total = all.length + op.startAt - 1;
        for (const i of resolvePages(op.pages, all.length)) {
          const p = all[i];
          const text = op.format.replaceAll("{page}", String(i + op.startAt)).replaceAll("{total}", String(total));
          const tw = font.widthOfTextAtSize(text, op.size);
          const { width, height } = p.getSize();
          const [v, hz] = op.position.split("-");
          const x = hz === "left" ? op.margin : hz === "right" ? width - op.margin - tw : (width - tw) / 2;
          const y = v === "top" ? height - op.margin - op.size : op.margin;
          p.drawText(text, { x, y, size: op.size, font, color: color(op.color) });
        }
        break;
      }

      // ----- forms -----
      case "fillForm": {
        const form = doc.getForm();
        for (const [name, value] of Object.entries(op.fields)) {
          const field = form.getFieldMaybe(name);
          if (!field) {
            if (op.strict) throw badRequest(`No form field named "${name}"`);
            continue;
          }
          if (field instanceof PDFTextField) field.setText(String(value));
          else if (field instanceof PDFCheckBox) (value === true || value === "true" ? field.check() : field.uncheck());
          else if (field instanceof PDFDropdown) field.select(value as string | string[]);
          else if (field instanceof PDFOptionList) field.select(value as string | string[]);
          else if (field instanceof PDFRadioGroup) field.select(String(value));
          else throw badRequest(`Field "${name}" (${field.constructor.name}) cannot be filled`);
        }
        const withImages = new Set(Object.keys(op.images ?? {}));
        await this.redrawFields(op.font, withImages);
        for (const [name, spec] of Object.entries(op.images ?? {})) {
          const field = form.getFieldMaybe(name);
          if (!field) {
            if (op.strict) throw badRequest(`No form field named "${name}"`);
            continue;
          }
          setFieldImage(field, (await this.image(spec)).image, op.imageAlignment);
        }
        if (op.flatten) form.flatten({ updateFieldAppearances: false });
        break;
      }
      case "flattenForm":
        await this.redrawFields(op.font);
        doc.getForm().flatten({ updateFieldAppearances: false });
        break;
      case "addFormField": {
        const toWidget = (page: number, x: number, y: number, width: number, height: number): Widget => {
          const pg = this.page(page);
          return {
            page: pg,
            x,
            y: flipY(pg, op.origin, y, height),
            width,
            height,
            textColor: col(op.textColor),
            backgroundColor: col(op.backgroundColor),
            borderColor: col(op.borderColor),
            // The library draws no border unless a width is given.
            borderWidth: op.borderWidth ?? (op.borderColor ? 1 : undefined),
            rotate: op.rotate,
            hidden: op.hidden,
          };
        };
        const widget =
          op.x !== undefined && op.y !== undefined && op.width !== undefined && op.height !== undefined ? toWidget(op.page, op.x, op.y, op.width, op.height) : undefined;
        const value = op.value;
        const field = createField(
          doc,
          op.name,
          op.type === "text"
            ? { type: "text", value: value === undefined ? undefined : String(value) }
            : op.type === "checkbox"
              ? { type: "checkbox", checked: value === true || value === "true" }
              : op.type === "radio"
                ? {
                    type: "radio",
                    options: (op.choices ?? []).map((c) => ({ value: c.value, widget: toWidget(c.page ?? op.page, c.x, c.y, c.width, c.height) })),
                    selected: value === undefined ? undefined : String(value),
                    mutuallyExclusive: op.mutuallyExclusive,
                  }
                : op.type === "button"
                  ? { type: "button", label: op.label ?? "" }
                  : { type: op.type, options: op.options ?? [], selected: value as string | string[] | undefined },
          widget,
        );
        applySettings(field, { ...op, options: undefined });
        this.redrawField(field, await this.font(op.font ?? StandardFonts.Helvetica));
        break;
      }
      case "setFieldProperties": {
        const field = this.field(op.name);
        if (op.mutuallyExclusive !== undefined) throw badRequest("mutuallyExclusive can only be set when creating a radio group (addFormField)");
        applySettings(field, op);
        if (op.image) setFieldImage(field, (await this.image(op.image)).image, op.imageAlignment);
        else this.redrawField(field, await this.font(op.font ?? StandardFonts.Helvetica));
        break;
      }
      case "removeFormFields": {
        const form = doc.getForm();
        for (const name of op.names) form.removeField(this.field(name));
        break;
      }
      case "setFieldScript":
        setFieldScript(this.field(op.name), op.event, op.script);
        break;

      // ----- scripts -----
      case "addJavaScript":
        doc.addJavaScript(op.name, op.script);
        break;
      case "setXFAJavaScript":
        doc.setXFAJavaScript(op.field, op.event, op.script);
        break;
      case "deleteXFA":
        doc.getForm().deleteXFA();
        break;

      // ----- document -----
      case "setLayerVisibility": {
        const known = new Set(doc.getOptionalContentGroups().map((g) => g.name));
        const unknown = op.layers.filter((l) => !known.has(l.name)).map((l) => l.name);
        if (unknown.length) throw badRequest(`No layer named ${unknown.map((n) => JSON.stringify(n)).join(", ")}. Layers: ${[...known].map((n) => JSON.stringify(n)).join(", ") || "none"}`);
        doc.setOptionalContentGroupVisibility(op.layers);
        break;
      }
      case "setViewerPreferences": {
        const vp = doc.catalog.getOrCreateViewerPreferences();
        if (op.hideToolbar !== undefined) vp.setHideToolbar(op.hideToolbar);
        if (op.hideMenubar !== undefined) vp.setHideMenubar(op.hideMenubar);
        if (op.hideWindowUI !== undefined) vp.setHideWindowUI(op.hideWindowUI);
        if (op.fitWindow !== undefined) vp.setFitWindow(op.fitWindow);
        if (op.centerWindow !== undefined) vp.setCenterWindow(op.centerWindow);
        if (op.displayDocTitle !== undefined) vp.setDisplayDocTitle(op.displayDocTitle);
        if (op.nonFullScreenPageMode) vp.setNonFullScreenPageMode(op.nonFullScreenPageMode as NonFullScreenPageMode);
        if (op.readingDirection) vp.setReadingDirection(op.readingDirection as ReadingDirection);
        if (op.printScaling) vp.setPrintScaling(op.printScaling as PrintScaling);
        if (op.duplex) vp.setDuplex(op.duplex as Duplex);
        if (op.pickTrayByPDFSize !== undefined) vp.setPickTrayByPDFSize(op.pickTrayByPDFSize);
        if (op.printPageRange !== undefined) vp.setPrintPageRange(toRanges(resolvePages(op.printPageRange, doc.getPageCount())));
        if (op.numCopies !== undefined) vp.setNumCopies(op.numCopies);
        if (op.pageMode) doc.catalog.set(PDFName.of("PageMode"), PDFName.of(op.pageMode));
        if (op.pageLayout) doc.catalog.set(PDFName.of("PageLayout"), PDFName.of(op.pageLayout));
        break;
      }
      case "setMetadata":
        if (op.title !== undefined) doc.setTitle(op.title, op.showTitleInWindow === undefined ? undefined : { showInWindowTitleBar: op.showTitleInWindow });
        else if (op.showTitleInWindow !== undefined) doc.catalog.getOrCreateViewerPreferences().setDisplayDocTitle(op.showTitleInWindow);
        if (op.author !== undefined) doc.setAuthor(op.author);
        if (op.subject !== undefined) doc.setSubject(op.subject);
        if (op.keywords !== undefined) doc.setKeywords(op.keywords);
        if (op.creator !== undefined) doc.setCreator(op.creator);
        if (op.producer !== undefined) doc.setProducer(op.producer);
        if (op.language !== undefined) doc.setLanguage(op.language);
        if (op.creationDate !== undefined) doc.setCreationDate(new Date(op.creationDate));
        if (op.copyright !== undefined) setInfo(doc, COPYRIGHT, op.copyright);
        if (op.copyrightUrl !== undefined) setInfo(doc, COPYRIGHT_URL, op.copyrightUrl);
        for (const [k, v] of Object.entries(op.custom ?? {})) setInfo(doc, k, v);
        doc.setModificationDate(op.modificationDate === undefined ? new Date() : new Date(op.modificationDate));
        writeXmp(doc);
        break;
      case "attachFile":
        await doc.attach(await readSource(this.ctx, op.file), op.name, {
          mimeType: op.mimeType,
          description: op.description,
          creationDate: op.creationDate === undefined ? undefined : new Date(op.creationDate),
          modificationDate: op.modificationDate === undefined ? undefined : new Date(op.modificationDate),
          afRelationship: op.relationship as AFRelationship | undefined,
        });
        break;
      case "detachFile": {
        const names = doc.getAttachments().map((a) => a.name);
        if (!names.includes(op.name)) throw badRequest(`No attachment named "${op.name}". Attachments: ${names.map((n) => JSON.stringify(n)).join(", ") || "none"}`);
        doc.detach(op.name);
        break;
      }
      case "convertToPDFA": {
        const extra = foreignXmp(doc);
        doc.convertToPDFA({
          conformance: op.conformance,
          iccProfile: op.iccProfile ? await readSource(this.ctx, op.iccProfile) : undefined,
          outputConditionIdentifier: op.outputConditionIdentifier,
          colorComponents: op.colorComponents,
          extensions: extra ? [extra] : undefined,
        });
        break;
      }
      case "embedFacturX":
        await embedFacturX(doc, await readSource(this.ctx, op.xml), {
          conformanceLevel: op.conformanceLevel,
          fileName: op.fileName,
          version: op.version,
          documentType: op.documentType,
          description: op.description,
        });
        break;
      case "encrypt":
        doc.encrypt({
          ownerPassword: op.ownerPassword,
          userPassword: op.userPassword ?? "",
          algorithm: op.algorithm,
          allowWeakCryptography: op.allowWeakCryptography,
          // Allow everything unless the request turns it off (the library's default is to deny all).
          permissions: {
            printing: "highResolution",
            modifying: true,
            copying: true,
            annotating: true,
            fillingForms: true,
            contentAccessibility: true,
            documentAssembly: true,
            ...op.permissions,
          },
        });
        break;
    }
  }
}
