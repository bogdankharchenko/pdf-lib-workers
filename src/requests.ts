import { z } from "zod";
import { Font, Operations } from "./operations";
import { LinkTtl, MergeSource, Output, PageSize, PageSpec, PdfSource } from "./schemas";

// Request bodies, one per endpoint. With multipart or a raw PDF body, the same
// object goes in the "options" field or ?options= query parameter.

const prefix = z.string().max(900).optional();

export const InfoRequest = z
  .object({ source: PdfSource })
  .meta({ id: "InfoRequest", description: "A locked PDF sent without its password returns a LockedInfoResponse." });

export const TextRequest = z
  .object({
    source: PdfSource,
    pages: PageSpec.optional(),
    items: z.boolean().default(false).describe("Also return each text run with its position, size and font."),
  })
  .meta({ id: "TextRequest" });

export const ExtractRequest = z
  .object({
    source: PdfSource,
    pages: PageSpec.optional(),
    include: z
      .array(z.enum(["images", "graphics", "text", "attachments"]))
      .min(1)
      .default(["images", "attachments"])
      .describe('What to extract. Each choice adds that field to the response ("attachments" at the top level, the rest per page).'),
    store: z.boolean().default(true).describe("Save images and attachments to R2 and return signed links; false returns them as base64."),
    prefix: prefix.describe('R2 key prefix for stored files. Default: "extracted/<uuid>/", which the recommended expiry rule deletes after 7 days.'),
    linkTtl: LinkTtl.optional(),
  })
  .meta({ id: "ExtractRequest" });

export const ScriptsRequest = z.object({ source: PdfSource }).meta({ id: "ScriptsRequest" });

export const MeasureRequest = z
  .object({
    text: z.string().describe('Text to measure. "\\n" always starts a new line.'),
    font: Font.default("Helvetica"),
    size: z.number().positive().default(12).describe("Font size in points."),
    maxWidth: z.number().positive().optional().describe("Wrap at this width, in points, and return the lines."),
    wordBreaks: z.array(z.string()).default([" "]).describe("Characters after which a line may wrap."),
    lineHeight: z.number().positive().optional().describe("Distance between baselines. Default: 1.2 × size."),
    fitHeight: z.number().positive().optional().describe("Also return the font size whose text height equals this."),
  })
  .meta({ id: "MeasureRequest", description: "Measures text before you lay it out. No PDF needed." });

export const CreateRequest = z
  .object({
    size: PageSize.default("A4"),
    pageCount: z.number().int().min(0).max(1000).default(1).describe("Blank pages to start with. With 0, add pages with addPage."),
    operations: Operations.default([]),
    output: Output,
  })
  .meta({ id: "CreateRequest" });

export const EditRequest = z
  .object({
    source: PdfSource,
    operations: Operations.min(1),
    incremental: z
      .boolean()
      .default(false)
      .describe("Keep the original bytes and append the changes, so existing digital signatures stay valid."),
    output: Output,
  })
  .meta({ id: "EditRequest" });

export const MergeRequest = z
  .object({
    sources: z
      .array(MergeSource)
      .min(1)
      .max(200)
      .describe("PDFs and images, in order. In a multipart request it may be left out: every uploaded PDF and image is merged in the order sent, except files the operations use."),
    operations: Operations.default([]).describe("Steps to run on the merged document."),
    output: Output,
  })
  .meta({ id: "MergeRequest" });

export const SplitRequest = z
  .object({
    source: PdfSource,
    ranges: z.array(PageSpec).min(1).max(1000).optional().describe('One part per entry, e.g. ["1-3", "4-last"].'),
    every: z.number().int().positive().default(1).describe("Pages per part, when ranges is not given."),
    prefix: prefix.describe('R2 key prefix for the parts. Default: "outputs/<uuid>/".'),
    linkTtl: LinkTtl.optional(),
  })
  .meta({ id: "SplitRequest", description: "Splits a PDF into parts saved in R2." });
