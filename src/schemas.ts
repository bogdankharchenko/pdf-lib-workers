import { z } from "zod";

/** Where to read bytes from: an R2 object, a URL, inline base64, or a multipart upload field. */
export const Source = z.union([
  z.object({ key: z.string().min(1) }),
  z.object({ url: z.url({ protocol: /^https?$/ }) }),
  z.object({ base64: z.string().min(1) }),
  z.object({ upload: z.string().min(1) }),
]);
export type Source = z.infer<typeof Source>;

/** A PDF source, optionally with the password needed to open it. */
export const PdfSource = z.intersection(Source, z.object({ password: z.string().optional() }));
export type PdfSource = z.infer<typeof PdfSource>;

export const PageSpec = z.union([z.string(), z.array(z.number().int())]);

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
  })
  .default({ return: "json", store: true });
export type Output = z.infer<typeof Output>;
