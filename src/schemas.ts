import { PageSizes } from "@cantoo/pdf-lib";
import { z } from "zod";

// Every schema with an `id` becomes a named component in /openapi.json, so
// descriptions here are what client authors (and their agents) read.

const MAX_LINK_TTL = 7 * 24 * 3600;

export const PageSize = z
  .union([
    z.enum(Object.keys(PageSizes) as [keyof typeof PageSizes, ...(keyof typeof PageSizes)[]]),
    z.tuple([z.number().positive(), z.number().positive()]),
  ])
  .meta({
    id: "PageSize",
    description: 'A paper name ("A4", "Letter", "Legal", …) or [width, height] in points (72 pt = 1 inch; A4 is 595 × 842).',
    examples: ["A4", [612, 792]],
  });

export function pageSize(size: z.infer<typeof PageSize>): [number, number] {
  return typeof size === "string" ? [...PageSizes[size]] : size;
}

/** How an image source becomes a page. */
export const ImagePageOptions = {
  size: z
    .union([PageSize, z.literal("image")])
    .default("A4")
    .describe('Images only: paper to fit the image on (turned landscape for wide images), or "image" for a page the size of the image (1 px = 1 pt).'),
  margin: z.number().nonnegative().default(0).describe("Images only: space around the image, in points."),
};

export const PageSpec = z
  .union([z.string(), z.array(z.number().int())])
  .meta({
    id: "PageSpec",
    description:
      'Pages, 1-based. A string such as "1-3,5", "first", "last", "odd", "even", "all" or "5-1" (reversed), or an array of numbers where negatives count from the end (-1 = last page). Leaving it out means every page.',
    examples: ["1-3,5", "last", [1, -1]],
  });

export const LinkTtl = z.number().int().positive().max(MAX_LINK_TTL).describe("Lifetime of the signed download link, in seconds (max 604800 = 7 days). Default: the SIGNED_URL_TTL setting (3600).");

export const SOURCE_KINDS = ["key", "url", "base64", "upload"] as const;
/** Ids of the source object schemas; the OpenAPI document shows each as one variant per kind. */
export const SOURCE_OBJECT_IDS = new Set<string>();

const sourceFields = {
  key: z.string().min(1).optional().describe("Object key in the R2 bucket, e.g. a template or a previous result."),
  url: z.url({ protocol: /^https?$/ }).optional().describe("http(s) URL the Worker downloads. Some sites block requests from Cloudflare Workers; send those files as uploads instead."),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers for `url`, e.g. { \"authorization\": \"Bearer …\" } for private files."),
  base64: z.string().min(1).optional().describe("The file's bytes as base64, or a data: URL."),
  upload: z.string().min(1).optional().describe('A file sent in the same multipart request, by field name or file name. Files sharing a field name are "name[0]", "name[1]", ….'),
};

/**
 * Exactly one of key, url, base64 or upload. Validated as one object, for clear
 * error messages; documented as one variant per kind (see openapi.ts).
 */
function sourceObject<T extends z.ZodRawShape>(id: string, description: string, extra: T) {
  SOURCE_OBJECT_IDS.add(id);
  return z
    .object({ ...sourceFields, ...extra })
    .refine((s) => SOURCE_KINDS.filter((k) => (s as Record<string, unknown>)[k] !== undefined).length === 1, "Give exactly one of key, url, base64 or upload")
    .refine((s) => !(s as { headers?: unknown }).headers || (s as { url?: unknown }).url !== undefined, "headers only apply to url sources")
    .meta({ id, description });
}

/** A plain string stands in for a source: a URL, a data: URL, or an R2 key. */
function expandShorthand<T>(v: string | T): T | { url: string } | { base64: string } | { key: string } {
  if (typeof v !== "string") return v;
  if (/^https?:\/\//i.test(v)) return { url: v };
  if (/^data:/i.test(v)) return { base64: v };
  return { key: v };
}

const Shorthand = z
  .string()
  .min(1)
  .describe('Shortcut for a source object: a string starting with "http://" or "https://" is { url }, one starting with "data:" is { base64 }, anything else is { key }.');

/** Accepts the shorthand string or the object, and always yields the validated object. */
function withShorthand<O extends z.ZodType<Record<string, unknown>, any>>(object: O, id: string, description: string) {
  return z
    .union([Shorthand, object])
    .transform((v) => expandShorthand(v) as z.input<O>)
    .pipe(object)
    .meta({ id, description });
}

const pdfOptions = {
  password: z.string().optional().describe("Password for an encrypted PDF. The result is saved without a password unless you add an `encrypt` operation."),
  preserveXFA: z.boolean().optional().describe("Keep XFA form data (Adobe dynamic forms). Without it, operations that touch the form remove XFA."),
};

/** Object form only, for fields where a bare string means something else (fonts). */
export const FileSource = sourceObject("FileSource", "Where to read a file from: exactly one of key, url, base64 or upload.", {});
export type Source = z.infer<typeof FileSource>;
export const Source = withShorthand(FileSource, "Source", "A file (image, attachment, XML…): a FileSource object or a shortcut string.");

export const FontSource = sourceObject("FontSource", "A TTF, OTF, TTC or DFONT font file: exactly one of key, url, base64 or upload.", {
  postscriptName: z.string().optional().describe("Picks one face from a .ttc/.dfont collection, e.g. \"Helvetica-Bold\"."),
});

export const PdfSource = withShorthand(
  sourceObject("PdfSourceObject", "A PDF: exactly one of key, url, base64 or upload, plus options for opening it.", pdfOptions),
  "PdfSource",
  "A PDF: a PdfSourceObject or a shortcut string.",
);
export type PdfSource = z.infer<typeof PdfSource>;

export const MergeSource = withShorthand(
  sourceObject("MergeSourceObject", "A PDF (optionally only some pages) or a PNG/JPEG image, which becomes one page.", {
    ...pdfOptions,
    pages: PageSpec.optional().describe("PDFs only: which pages to take, in this order."),
    ...ImagePageOptions,
  }),
  "MergeSource",
  "A PDF or image to merge: a MergeSourceObject or a shortcut string.",
);

export const R2Key = z
  .string()
  .min(1)
  .max(1024)
  .refine((k) => !k.startsWith("/") && !k.split("/").includes(".."), "Key must not start with / or contain ..")
  .describe('An R2 object key, e.g. "invoices/42.pdf". Must not start with "/" or contain "..".');

export const Output = z
  .object({
    key: R2Key.optional().describe(
      'Where to save in R2; overwrites an existing file. Default: "outputs/<uuid>.pdf", which the recommended expiry rule deletes after 7 days. Keys outside outputs/ and extracted/ are kept.',
    ),
    filename: z.string().max(255).optional().describe('Name offered when the PDF is opened or saved. Default: "document.pdf".'),
    return: z
      .enum(["json", "pdf"])
      .default("json")
      .describe('"json": a PdfResult with a signed link. "pdf": the PDF bytes, with X-File-Key, X-File-Url and X-Page-Count headers.'),
    store: z.boolean().default(true).describe('Save to R2. With false and return "json", the PDF comes back as base64.'),
    linkTtl: LinkTtl.optional(),
    useObjectStreams: z.boolean().default(true).describe("Compress objects into streams (smaller files). false writes a classic cross-reference table for old tools."),
  })
  .default({ return: "json", store: true, useObjectStreams: true })
  .meta({ id: "Output", description: "What to do with the PDF this request produces." });
export type Output = z.infer<typeof Output>;
