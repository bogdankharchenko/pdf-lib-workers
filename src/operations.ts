import fontkit from "@cantoo/fontkit";
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  degrees,
  rgb,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "@cantoo/pdf-lib";
import { z } from "zod";
import { badRequest } from "./errors";
import { resolvePages } from "./pages";
import { FileSource, ImagePageOptions, PageSize, PageSpec, PdfSource, Source, pageSize } from "./schemas";
import { addImagePage, drawImageInBox, embedImage, imageKind, uprightSize } from "./images";
import { COPYRIGHT, COPYRIGHT_URL, CUSTOM_KEY, setInfo, writeXmp } from "./metadata";
import { type Ctx, openPdf, readSource } from "./sources";

const Color = z.string().regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, "Color must be hex, e.g. #ff0000");
const Opacity = z.number().min(0).max(1);
/** A standard PDF font name (e.g. "Helvetica-Bold") or a TTF/OTF font file. */
const Font = z.union([z.enum(Object.values(StandardFonts) as [string, ...string[]]), FileSource]);
/** "bottom-left" is native PDF coordinates; "top-left" measures y down from the top edge. */
const Origin = z.enum(["bottom-left", "top-left"]).default("bottom-left");
const Point = z.object({ x: z.number(), y: z.number() });
const Position = z.enum(["center", "top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]);

export const Operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addPage"), size: PageSize.default("A4"), at: z.number().int().positive().optional(), count: z.number().int().positive().max(1000).default(1) }),
  z.object({ op: z.literal("removePages"), pages: PageSpec }),
  /** Keep only these pages, in this order. Use it to extract, reorder or reverse. */
  z.object({ op: z.literal("selectPages"), pages: PageSpec }),
  z.object({ op: z.literal("duplicatePage"), page: z.number().int(), at: z.number().int().positive().optional() }),
  z.object({ op: z.literal("rotatePages"), pages: PageSpec.optional(), degrees: z.number().int().multipleOf(90), relative: z.boolean().default(true) }),
  z.object({ op: z.literal("resizePages"), pages: PageSpec.optional(), size: PageSize, scaleContent: z.boolean().default(true) }),
  z.object({ op: z.literal("cropPages"), pages: PageSpec.optional(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  /** Inserts PDF pages, or a PNG/JPEG image as a page. */
  z.object({ op: z.literal("insertPdf"), source: PdfSource, pages: PageSpec.optional(), at: z.number().int().positive().optional(), ...ImagePageOptions }),
  z.object({
    op: z.literal("drawText"),
    pages: PageSpec.optional(),
    text: z.string(),
    x: z.number(),
    y: z.number(),
    origin: Origin,
    size: z.number().positive().default(12),
    font: Font.default(StandardFonts.Helvetica),
    color: Color.default("#000000"),
    opacity: Opacity.optional(),
    rotate: z.number().optional(),
    maxWidth: z.number().positive().optional(),
    lineHeight: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("drawImage"),
    pages: PageSpec.optional(),
    image: Source,
    x: z.number(),
    y: z.number(),
    origin: Origin,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    opacity: Opacity.optional(),
    rotate: z.number().optional(),
  }),
  z.object({
    op: z.literal("drawRectangle"),
    pages: PageSpec.optional(),
    x: z.number(),
    y: z.number(),
    origin: Origin,
    width: z.number(),
    height: z.number(),
    color: Color.optional(),
    borderColor: Color.optional(),
    borderWidth: z.number().nonnegative().optional(),
    opacity: Opacity.optional(),
    rotate: z.number().optional(),
  }),
  z.object({
    op: z.literal("drawLine"),
    pages: PageSpec.optional(),
    start: Point,
    end: Point,
    origin: Origin,
    thickness: z.number().positive().default(1),
    color: Color.default("#000000"),
    opacity: Opacity.optional(),
  }),
  z.object({
    op: z.literal("drawSvg"),
    pages: PageSpec.optional(),
    svg: z.string().min(1),
    x: z.number(),
    y: z.number(),
    origin: Origin,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal("watermark"),
    pages: PageSpec.optional(),
    /** Text to stamp, or… */
    text: z.string().min(1).optional(),
    /** …a PNG/JPEG image, e.g. a logo. */
    image: Source.optional(),
    /** Image width as a share of the page width. */
    scale: z.number().positive().max(1).default(0.5),
    size: z.number().positive().default(60),
    font: Font.default(StandardFonts.HelveticaBold),
    color: Color.default("#888888"),
    opacity: Opacity.default(0.25),
    /** Degrees; defaults to 45 for text, 0 for images. */
    rotate: z.number().optional(),
    position: Position.default("center"),
    margin: z.number().nonnegative().default(24),
  }).refine((o) => !o.text !== !o.image, "Give text or image"),
  z.object({
    op: z.literal("pageNumbers"),
    pages: PageSpec.optional(),
    /** {page} and {total} are replaced. */
    format: z.string().default("{page} / {total}"),
    position: z.enum(["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]).default("bottom-center"),
    margin: z.number().nonnegative().default(24),
    size: z.number().positive().default(10),
    font: Font.default(StandardFonts.Helvetica),
    color: Color.default("#000000"),
    startAt: z.number().int().default(1),
  }),
  z.object({
    op: z.literal("fillForm"),
    /** Text fields take strings; checkboxes take booleans; dropdowns, option lists and radio groups take option values. */
    fields: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])),
    flatten: z.boolean().default(false),
    /** Fail on unknown field names instead of ignoring them. */
    strict: z.boolean().default(true),
  }),
  z.object({ op: z.literal("flattenForm") }),
  z.object({
    op: z.literal("setMetadata"),
    title: z.string().optional(),
    author: z.string().optional(),
    subject: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    creator: z.string().optional(),
    producer: z.string().optional(),
    language: z.string().optional(),
    /** e.g. "© 2026 Acme Inc. All rights reserved." */
    copyright: z.string().optional(),
    /** Page with licence or ownership details. */
    copyrightUrl: z.url().optional(),
    /** Your own fields, e.g. { "MadeFor": "Client X", "Origin": "billing-service" }. null removes one. */
    custom: z
      .record(z.string().regex(CUSTOM_KEY, "Custom keys are letters, digits and _, starting with a letter"), z.string().nullable())
      .optional(),
  }),
  z.object({
    op: z.literal("attachFile"),
    file: Source,
    name: z.string().min(1),
    mimeType: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    op: z.literal("encrypt"),
    ownerPassword: z.string().min(1),
    userPassword: z.string().optional(),
    algorithm: z.enum(["AES-256", "AES-128"]).default("AES-256"),
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
      .optional(),
  }),
]);
export type Operation = z.infer<typeof Operation>;

/**
 * Adds a PDF's pages (or some of them) or a PNG/JPEG image as a page, at
 * index `at` (default: the end). Used by merge and insertPdf.
 */
export async function addSource(
  doc: PDFDocument,
  bytes: Uint8Array,
  opts: { password?: string; pages?: z.infer<typeof PageSpec>; size: z.infer<typeof ImagePageOptions.size>; margin: number },
  at = doc.getPageCount(),
) {
  if (imageKind(bytes)) {
    if (opts.pages !== undefined) throw badRequest('"pages" does not apply to an image');
    return addImagePage(doc, bytes, opts.size === "image" ? "image" : pageSize(opts.size), opts.margin, at);
  }
  const src = await openPdf(bytes, opts.password);
  for (const p of await doc.copyPages(src, resolvePages(opts.pages, src.getPageCount()))) doc.insertPage(at++, p);
}
export const Operations = z.array(Operation).max(500);


function color(hex: string) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
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

  private async font(spec: z.infer<typeof Font>): Promise<PDFFont> {
    const id = typeof spec === "string" ? spec : JSON.stringify(spec);
    let f = this.fonts.get(id);
    if (!f) {
      if (typeof spec === "string") {
        f = await this.doc.embedFont(spec as StandardFonts);
      } else {
        this.doc.registerFontkit(fontkit);
        f = await this.doc.embedFont(await readSource(this.ctx, spec), { subset: true });
      }
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

  private async apply(op: Operation) {
    const doc = this.doc;
    // Converts a top-left y to PDF's bottom-left y for an item of height h.
    const flipY = (page: { getHeight(): number }, origin: string, y: number, h = 0) =>
      origin === "top-left" ? page.getHeight() - y - h : y;

    switch (op.op) {
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
      case "insertPdf": {
        const at = op.at === undefined ? doc.getPageCount() : Math.min(op.at - 1, doc.getPageCount());
        await addSource(doc, await readSource(this.ctx, op.source), op, at);
        break;
      }
      case "drawText": {
        const font = await this.font(op.font);
        for (const p of this.pages(op.pages)) {
          p.drawText(op.text, {
            x: op.x,
            y: flipY(p, op.origin, op.y, op.origin === "top-left" ? font.heightAtSize(op.size) : 0),
            size: op.size,
            font,
            color: color(op.color),
            opacity: op.opacity,
            rotate: op.rotate === undefined ? undefined : degrees(op.rotate),
            maxWidth: op.maxWidth,
            lineHeight: op.lineHeight ?? op.size * 1.2,
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
          // Unrotated images are drawn upright per their EXIF orientation.
          if (op.rotate === undefined) {
            drawImageInBox(p, img, orientation, { x: op.x, y, width: w, height: h }, op.opacity);
            continue;
          }
          p.drawImage(img, {
            x: op.x,
            y: flipY(p, op.origin, op.y, h),
            width: w,
            height: h,
            opacity: op.opacity,
            rotate: op.rotate === undefined ? undefined : degrees(op.rotate),
          });
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
            color: op.color ? color(op.color) : undefined,
            borderColor: op.borderColor ? color(op.borderColor) : undefined,
            borderWidth: op.borderWidth ?? (op.borderColor ? 1 : 0),
            opacity: op.opacity,
            borderOpacity: op.opacity,
            rotate: op.rotate === undefined ? undefined : degrees(op.rotate),
          });
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
          });
        }
        break;
      case "drawSvg": {
        const svg = await doc.embedSvg(op.svg);
        for (const p of this.pages(op.pages)) {
          // drawSvg places the SVG's top-left corner at (x, y).
          p.drawSvg(svg, { x: op.x, y: op.origin === "top-left" ? p.getHeight() - op.y : op.y, width: op.width, height: op.height });
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
          const tw = font.widthOfTextAtSize(op.text, op.size);
          const th = font.heightAtSize(op.size, { descender: false });
          sizeOn = () => [tw, th];
          draw = (p, _w, _h, x, y) => p.drawText(op.text!, { x, y, size: op.size, font, color: color(op.color), opacity: op.opacity, rotate: degrees(rotate) });
        } else {
          const { image, orientation } = await this.image(op.image!);
          const [uw, uh] = uprightSize(image, orientation);
          sizeOn = (p) => [p.getWidth() * op.scale, (p.getWidth() * op.scale * uh) / uw];
          draw = (p, w, h, x, y) => {
            if (rotate === 0) return drawImageInBox(p, image, orientation, { x, y, width: w, height: h }, op.opacity);
            p.drawImage(image, { x, y, width: w, height: h, opacity: op.opacity, rotate: degrees(rotate) });
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
        if (op.flatten) form.flatten();
        break;
      }
      case "flattenForm":
        doc.getForm().flatten();
        break;
      case "setMetadata":
        if (op.title !== undefined) doc.setTitle(op.title);
        if (op.author !== undefined) doc.setAuthor(op.author);
        if (op.subject !== undefined) doc.setSubject(op.subject);
        if (op.keywords !== undefined) doc.setKeywords(op.keywords);
        if (op.creator !== undefined) doc.setCreator(op.creator);
        if (op.producer !== undefined) doc.setProducer(op.producer);
        if (op.language !== undefined) doc.setLanguage(op.language);
        if (op.copyright !== undefined) setInfo(doc, COPYRIGHT, op.copyright);
        if (op.copyrightUrl !== undefined) setInfo(doc, COPYRIGHT_URL, op.copyrightUrl);
        for (const [k, v] of Object.entries(op.custom ?? {})) setInfo(doc, k, v);
        doc.setModificationDate(new Date());
        writeXmp(doc);
        break;
      case "attachFile":
        await doc.attach(await readSource(this.ctx, op.file), op.name, { mimeType: op.mimeType, description: op.description });
        break;
      case "encrypt":
        doc.encrypt({
          ownerPassword: op.ownerPassword,
          userPassword: op.userPassword ?? "",
          algorithm: op.algorithm,
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
