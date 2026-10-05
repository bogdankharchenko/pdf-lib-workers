import fontkit from "@cantoo/fontkit";
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PageSizes,
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
import { PageSpec, PdfSource, Source } from "./schemas";
import { type Ctx, loadPdf, readSource } from "./sources";

const Color = z.string().regex(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i, "Color must be hex, e.g. #ff0000");
const Opacity = z.number().min(0).max(1);
export const PageSize = z.union([
  z.enum(Object.keys(PageSizes) as [keyof typeof PageSizes, ...(keyof typeof PageSizes)[]]),
  z.tuple([z.number().positive(), z.number().positive()]),
]);
/** A standard PDF font name (e.g. "Helvetica-Bold") or a TTF/OTF font file. */
const Font = z.union([z.enum(Object.values(StandardFonts) as [string, ...string[]]), Source]);
/** "bottom-left" is native PDF coordinates; "top-left" measures y down from the top edge. */
const Origin = z.enum(["bottom-left", "top-left"]).default("bottom-left");
const Point = z.object({ x: z.number(), y: z.number() });

export const Operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addPage"), size: PageSize.default("A4"), at: z.number().int().positive().optional(), count: z.number().int().positive().max(1000).default(1) }),
  z.object({ op: z.literal("removePages"), pages: PageSpec }),
  /** Keep only these pages, in this order. Use it to extract, reorder or reverse. */
  z.object({ op: z.literal("selectPages"), pages: PageSpec }),
  z.object({ op: z.literal("duplicatePage"), page: z.number().int(), at: z.number().int().positive().optional() }),
  z.object({ op: z.literal("rotatePages"), pages: PageSpec.optional(), degrees: z.number().int().multipleOf(90), relative: z.boolean().default(true) }),
  z.object({ op: z.literal("resizePages"), pages: PageSpec.optional(), size: PageSize, scaleContent: z.boolean().default(true) }),
  z.object({ op: z.literal("cropPages"), pages: PageSpec.optional(), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
  z.object({ op: z.literal("insertPdf"), source: PdfSource, pages: PageSpec.optional(), at: z.number().int().positive().optional() }),
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
    text: z.string().min(1),
    size: z.number().positive().default(60),
    font: Font.default(StandardFonts.HelveticaBold),
    color: Color.default("#888888"),
    opacity: Opacity.default(0.25),
    rotate: z.number().default(45),
  }),
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
export const Operations = z.array(Operation).max(500);

export function pageSize(size: z.infer<typeof PageSize>): [number, number] {
  return typeof size === "string" ? [...PageSizes[size]] : size;
}

function color(hex: string) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Runs operations in order against one document, caching fonts and images. */
export class Editor {
  private fonts = new Map<string, PDFFont>();
  private images = new Map<string, PDFImage>();

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

  private async image(spec: Source): Promise<PDFImage> {
    const id = JSON.stringify(spec);
    let img = this.images.get(id);
    if (!img) {
      const bytes = await readSource(this.ctx, spec);
      if (bytes[0] === 0x89 && bytes[1] === 0x50) img = await this.doc.embedPng(bytes);
      else if (bytes[0] === 0xff && bytes[1] === 0xd8) img = await this.doc.embedJpg(bytes);
      else throw badRequest("Image must be PNG or JPEG");
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
        const src = await loadPdf(this.ctx, op.source);
        const copies = await doc.copyPages(src, resolvePages(op.pages, src.getPageCount()));
        let at = op.at === undefined ? doc.getPageCount() : Math.min(op.at - 1, doc.getPageCount());
        for (const p of copies) doc.insertPage(at++, p);
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
        const img = await this.image(op.image);
        const w = op.width ?? (op.height ? (img.width * op.height) / img.height : img.width);
        const h = op.height ?? (op.width ? (img.height * op.width) / img.width : img.height);
        for (const p of this.pages(op.pages)) {
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
        const font = await this.font(op.font);
        const tw = font.widthOfTextAtSize(op.text, op.size);
        const th = font.heightAtSize(op.size, { descender: false });
        const rad = (op.rotate * Math.PI) / 180;
        for (const p of this.pages(op.pages)) {
          const { width, height } = p.getSize();
          // Offset the start so the rotated text's middle lands on the page centre.
          const x = width / 2 - (Math.cos(rad) * tw - Math.sin(rad) * th) / 2;
          const y = height / 2 - (Math.sin(rad) * tw + Math.cos(rad) * th) / 2;
          p.drawText(op.text, { x, y, size: op.size, font, color: color(op.color), opacity: op.opacity, rotate: degrees(op.rotate) });
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
        doc.setModificationDate(new Date());
        break;
      case "attachFile":
        await doc.attach(await readSource(this.ctx, op.file), op.name, { mimeType: op.mimeType, description: op.description });
        break;
      case "encrypt":
        doc.encrypt({
          ownerPassword: op.ownerPassword,
          userPassword: op.userPassword ?? "",
          algorithm: op.algorithm,
          permissions: op.permissions,
        });
        break;
    }
  }
}
