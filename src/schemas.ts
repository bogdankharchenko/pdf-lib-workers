import { PageSizes } from "@cantoo/pdf-lib";
import { z } from "zod";

/** A paper name ("A4", "Letter", …) or [width, height] in points. */
export const PageSize = z.union([
  z.enum(Object.keys(PageSizes) as [keyof typeof PageSizes, ...(keyof typeof PageSizes)[]]),
  z.tuple([z.number().positive(), z.number().positive()]),
]);

export function pageSize(size: z.infer<typeof PageSize>): [number, number] {
  return typeof size === "string" ? [...PageSizes[size]] : size;
}

/** How an image source becomes a page: fitted on paper of `size` ("image" = the image's own size). */
export const ImagePageOptions = {
  size: z.union([PageSize, z.literal("image")]).default("A4"),
  margin: z.number().nonnegative().default(0),
};

export const PageSpec = z.union([z.string(), z.array(z.number().int())]);

const KINDS = ["key", "url", "base64", "upload"] as const;

const sourceFields = {
  /** Object key in the R2 bucket. */
  key: z.string().min(1).optional(),
  /** http(s) URL the Worker downloads. */
  url: z.url({ protocol: /^https?$/ }).optional(),
  /** Extra request headers for `url`, e.g. Authorization. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Inline bytes as base64 or a data: URL. */
  base64: z.string().min(1).optional(),
  /** A file sent in the same multipart request, by field name or file name. */
  upload: z.string().min(1).optional(),
};

/** Where to read bytes from: an R2 object, a URL, inline base64, or a multipart upload. */
function source<T extends z.ZodRawShape>(extra: T) {
  return z
    .object({ ...sourceFields, ...extra })
    .refine((s) => KINDS.filter((k) => (s as Record<string, unknown>)[k] !== undefined).length === 1, "Give exactly one of key, url, base64 or upload")
    .refine((s) => !(s as { headers?: unknown }).headers || (s as { url?: unknown }).url !== undefined, "headers only apply to url sources");
}

/** Lets a plain string stand in for a source: a URL, a data: URL, or an R2 key. */
function shorthand(v: unknown) {
  if (typeof v !== "string") return v;
  if (/^https?:\/\//i.test(v)) return { url: v };
  if (/^data:/i.test(v)) return { base64: v };
  return { key: v };
}

/** Object form only, for fields where a bare string means something else (fonts). */
export const FileSource = source({});
/** A TTF/OTF/TTC font file; `postscriptName` picks a face from a .ttc/.dfont collection. */
export const FontSource = source({ postscriptName: z.string().optional() });
export const Source = z.preprocess(shorthand, FileSource);
export type Source = z.infer<typeof FileSource>;

/** A PDF source, optionally with the password needed to open it. */
const pdfOptions = {
  password: z.string().optional(),
  /** Keep XFA form data (dynamic Adobe forms); otherwise form operations remove it. */
  preserveXFA: z.boolean().optional(),
};
export const PdfSource = z.preprocess(shorthand, source(pdfOptions));
export type PdfSource = z.infer<typeof PdfSource>;

/** A PDF (optionally limited to some pages) or a PNG/JPEG image to merge. */
export const MergeSource = z.preprocess(shorthand, source({ ...pdfOptions, pages: PageSpec.optional(), ...ImagePageOptions }));

export const R2Key = z
  .string()
  .min(1)
  .max(1024)
  .refine((k) => !k.startsWith("/") && !k.split("/").includes(".."), "Key must not start with / or contain ..");

export const Output = z
  .object({
    /** R2 key to write to. Defaults to outputs/<uuid>.pdf */
    key: R2Key.optional(),
    /** File name offered when downloading. */
    filename: z.string().max(255).optional(),
    /** "json" returns metadata and a signed link; "pdf" returns the bytes. */
    return: z.enum(["json", "pdf"]).default("json"),
    /** Save to R2. With store=false and return=json, the PDF comes back as base64. */
    store: z.boolean().default(true),
    /** Lifetime of the signed link, in seconds. */
    linkTtl: z.number().int().positive().max(7 * 24 * 3600).optional(),
    /** Pack objects into compressed streams (smaller files). false = PDF 1.4-style output for old tools. */
    useObjectStreams: z.boolean().default(true),
  })
  .default({ return: "json", store: true, useObjectStreams: true });
export type Output = z.infer<typeof Output>;
