import { PDFDocument } from "@cantoo/pdf-lib";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Env } from "./env";
import { HttpError, badRequest } from "./errors";
import { documentInfo, extractText } from "./inspect";
import { Editor, Operation, Operations, addSource } from "./operations";
import { resolvePages } from "./pages";
import { MergeSource, Output, PageSize, PageSpec, PdfSource, R2Key, pageSize } from "./schemas";
import { signedUrl, timingSafeEqual, verifySignature } from "./signing";
import { imageKind } from "./images";
import { type Ctx, type Upload, assignRefs, findUpload, loadPdf, looksLikePdf, readAhead, readSource } from "./sources";

type App = { Bindings: Env };
type C = Context<App>;

const app = new Hono<App>();

app.use("*", cors({ origin: "*", exposeHeaders: ["X-File-Key", "X-File-Url", "X-Page-Count"] }));

// Every route needs the API key, except the index and signed download links.
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS" || c.req.path === "/") return next();
  const isDownload = (c.req.method === "GET" || c.req.method === "HEAD") && c.req.path.startsWith("/files/");
  if (isDownload && c.req.query("sig")) {
    const ok = await verifySignature(c.env, fileKey(c), c.req.query("expires"), c.req.query("sig"));
    if (!ok) throw new HttpError(403, "Link is invalid or has expired");
    return next();
  }
  if (!c.env.API_KEY) throw new HttpError(500, "API_KEY secret is not configured");
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1] ?? c.req.header("x-api-key");
  if (!token || !timingSafeEqual(token, c.env.API_KEY)) throw new HttpError(401, "Missing or invalid API key");
  return next();
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, details: err.details }, err.status);
  if (err instanceof z.ZodError) {
    return c.json({ error: "Invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  console.error(err);
  return c.json({ error: "Internal error", details: (err as Error).message }, 500);
});

app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));

// ---------- helpers ----------

function fileKey(c: C): string {
  const raw = c.req.path.slice("/files/".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw badRequest("Bad key encoding");
  }
}

/**
 * Reads the request in any of three shapes:
 * - JSON body.
 * - Multipart form: files as fields (a field name may repeat), plus an "options" JSON field.
 * - Raw file body (PDF, sniffed even without a content type), with options in ?options=.
 * When no source is given, the lone file, the "file" field, or the lone PDF becomes the source.
 */
async function readRequest(c: C): Promise<{ body: Record<string, unknown>; uploads: Upload[] }> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const files: Omit<Upload, "ref">[] = [];
  let body: Record<string, unknown> = {};
  const parse = (s: string, what: string) => {
    try {
      const v = JSON.parse(s);
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw badRequest(`${what} must be a JSON object`);
    }
  };
  if (type.startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    for (const [field, value] of form.entries()) {
      if (field === "options") {
        body = parse(typeof value === "string" ? value : await (value as File).text(), "options field");
      } else if (typeof value !== "string") {
        const bytes = new Uint8Array(await (value as File).arrayBuffer());
        // Browsers send an empty, nameless file for an unused file input.
        if (bytes.length) files.push({ field, filename: (value as File).name || undefined, bytes });
      }
    }
  } else {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (/^(application\/(pdf|x-pdf|octet-stream)|image\/)/.test(type) || looksLikePdf(bytes)) {
      if (bytes.length) files.push({ field: "file", bytes });
      const opts = c.req.query("options");
      if (opts) body = parse(opts, "options query parameter");
    } else {
      const text = new TextDecoder().decode(bytes);
      if (text.trim()) body = parse(text, "Body");
    }
  }
  const uploads = assignRefs(files);
  if (body.source === undefined && uploads.length) {
    const pdfs = uploads.filter((u) => looksLikePdf(u.bytes));
    const pick = uploads.length === 1 ? uploads[0] : (uploads.find((u) => u.ref === "file") ?? (pdfs.length === 1 ? pdfs[0] : undefined));
    if (pick) body.source = { upload: pick.ref };
  }
  return { body, uploads };
}

async function sendPdf(c: C, doc: PDFDocument, output: Output, extra: Record<string, unknown> = {}) {
  const bytes = await doc.save();
  const filename = output.filename ?? "document.pdf";
  const disposition = `inline; filename="${filename.replace(/["\\\r\n]/g, "_")}"`;
  let key: string | undefined;
  let link: { url: string; expiresAt: string } | undefined;
  if (output.store) {
    key = output.key ?? `outputs/${crypto.randomUUID()}.pdf`;
    await c.env.PDF_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf", contentDisposition: disposition } });
    link = await signedUrl(c.env, new URL(c.req.url).origin, key, output.linkTtl);
  }
  if (output.return === "pdf") {
    const headers = new Headers({ "content-type": "application/pdf", "content-disposition": disposition, "x-page-count": String(doc.getPageCount()) });
    if (key && link) {
      headers.set("x-file-key", key);
      headers.set("x-file-url", link.url);
    }
    return new Response(bytes, { headers });
  }
  return c.json({
    ...(key ? { key, url: link!.url, expiresAt: link!.expiresAt } : { base64: bytesToBase64(bytes) }),
    size: bytes.byteLength,
    pageCount: doc.getPageCount(),
    ...extra,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads that `value` (e.g. the operations list) refers to with { upload: … }. */
function usedUploads(value: unknown, uploads: Upload[], found = new Set<Upload>()): Set<Upload> {
  if (Array.isArray(value)) for (const v of value) usedUploads(v, uploads, found);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "upload" && typeof v === "string") {
        try {
          found.add(findUpload(uploads, v));
        } catch {
          // Unknown names fail later, with the full error.
        }
      } else usedUploads(v, uploads, found);
    }
  }
  return found;
}

const ctxOf = (c: C, uploads: Upload[]): Ctx => ({ env: c.env, uploads, origin: new URL(c.req.url).origin });

// ---------- index ----------

app.get("/", (c) =>
  c.json({
    name: "pdf-lib-workers",
    auth: "Authorization: Bearer <API_KEY>",
    sources:
      'A PDF, image, font or attachment can be a URL string, an R2 key string, { url, headers? }, { key }, { base64 }, or { upload } naming a multipart file by field or file name. Send files as multipart (plus an "options" JSON field) or as a raw body (plus ?options=).',
    endpoints: {
      "GET /files/:key": "Download a result (API key or the signed link it came with).",
      "POST /pdf/info": "Page count, sizes, metadata, form fields, attachments: { source }",
      "POST /pdf/text": "Extract text: { source, pages?, items? }",
      "POST /pdf/create": "New PDF: { size?, pageCount?, operations?, output? }",
      "POST /pdf/edit": "Run operations on a PDF: { source, operations, output? }",
      "POST /pdf/merge": "Join PDFs: { sources: [{ ...source, pages? }], operations?, output? }",
      "POST /pdf/split": "Split a PDF: { source, ranges? | every?, prefix? }",
    },
    operations: Operation.options.map((o) => o.shape.op.value),
  }),
);

// ---------- download ----------

app.on(["GET", "HEAD"], "/files/*", async (c) => {
  const key = fileKey(c);
  const obj = await c.env.PDF_BUCKET.get(key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!obj) throw new HttpError(404, `No file at key "${key}"`);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (c.req.query("download") !== undefined) headers.set("content-disposition", `attachment; filename="${key.split("/").pop()}"`);
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  let status = 200;
  if (obj.range && c.req.header("range")) {
    const r = obj.range as { offset: number; length: number };
    headers.set("content-range", `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`);
    headers.set("content-length", String(r.length));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(c.req.method === "HEAD" ? null : obj.body, { status, headers });
});

// ---------- pdf ----------

app.post("/pdf/info", async (c) => {
  const { body, uploads } = await readRequest(c);
  const { source } = z.object({ source: PdfSource }).parse(body);
  return c.json(documentInfo(await loadPdf(ctxOf(c, uploads), source)));
});

app.post("/pdf/text", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = z.object({ source: PdfSource, pages: PageSpec.optional(), items: z.boolean().default(false) }).parse(body);
  const doc = await loadPdf(ctxOf(c, uploads), req.source);
  return c.json({ pages: extractText(doc, req.pages, req.items) });
});

app.post("/pdf/create", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = z
    .object({
      size: PageSize.default("A4"),
      pageCount: z.number().int().min(0).max(1000).default(1),
      operations: Operations.default([]),
      output: Output,
    })
    .parse(body);
  const doc = await PDFDocument.create();
  const size = pageSize(req.size);
  for (let i = 0; i < req.pageCount; i++) doc.addPage(size);
  await runOps(c, doc, uploads, req.operations);
  if (!doc.getPageCount()) throw badRequest("The document has no pages");
  return sendPdf(c, doc, req.output);
});

app.post("/pdf/edit", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = z.object({ source: PdfSource, operations: Operations.min(1), output: Output }).parse(body);
  const doc = await loadPdf(ctxOf(c, uploads), req.source);
  await runOps(c, doc, uploads, req.operations);
  return sendPdf(c, doc, req.output);
});

app.post("/pdf/merge", async (c) => {
  const { body, uploads } = await readRequest(c);
  // With no sources listed, merge every uploaded PDF and image in the order
  // sent, except files the operations use (such as a watermark logo).
  if (body.sources === undefined && uploads.length) {
    const used = usedUploads(body.operations, uploads);
    const pages = uploads.filter((u) => !used.has(u) && (looksLikePdf(u.bytes) || imageKind(u.bytes)));
    body.sources = (pages.length ? pages : uploads).map((u) => ({ upload: u.ref }));
  }
  const req = z
    .object({
      sources: z.array(MergeSource).min(1).max(200),
      operations: Operations.default([]),
      output: Output,
    })
    .parse(body);
  const ctx = ctxOf(c, uploads);
  const read = readAhead(req.sources, (src) => readSource(ctx, src));
  const doc = await PDFDocument.create();
  for (const [i, src] of req.sources.entries()) {
    try {
      await addSource(doc, await read(i), src);
    } catch (e) {
      if (e instanceof HttpError) {
        e.message = `sources[${i}]: ${e.message}`;
        throw e;
      }
      throw new HttpError(422, `sources[${i}]: ${(e as Error).message}`);
    }
  }
  await runOps(c, doc, uploads, req.operations);
  return sendPdf(c, doc, req.output);
});

app.post("/pdf/split", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = z
    .object({
      source: PdfSource,
      /** One output per entry, e.g. ["1-3", "4-last"]. */
      ranges: z.array(PageSpec).min(1).max(1000).optional(),
      /** Pages per output when ranges is not given. */
      every: z.number().int().positive().default(1),
      /** R2 key prefix for the parts. Defaults to outputs/<uuid>/ */
      prefix: z.string().max(900).optional(),
      linkTtl: z.number().int().positive().max(7 * 24 * 3600).optional(),
    })
    .parse(body);
  const src = await loadPdf(ctxOf(c, uploads), req.source);
  const count = src.getPageCount();
  const groups = req.ranges
    ? req.ranges.map((r) => resolvePages(r, count))
    : Array.from({ length: Math.ceil(count / req.every) }, (_, g) => Array.from({ length: Math.min(req.every, count - g * req.every) }, (_, j) => g * req.every + j));
  if (groups.length > 1000) throw badRequest("Split would make more than 1000 files");
  const prefix = req.prefix ?? `outputs/${crypto.randomUUID()}/`;
  const origin = new URL(c.req.url).origin;
  const parts = [];
  for (const [n, idx] of groups.entries()) {
    if (!idx.length) throw badRequest(`ranges[${n}] selects no pages`);
    const part = await PDFDocument.create();
    for (const p of await part.copyPages(src, idx)) part.addPage(p);
    const bytes = await part.save();
    const key = R2Key.parse(`${prefix}part-${String(n + 1).padStart(3, "0")}.pdf`);
    await c.env.PDF_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    parts.push({ key, pages: idx.map((i) => i + 1), size: bytes.byteLength, ...(await signedUrl(c.env, origin, key, req.linkTtl)) });
  }
  return c.json({ parts });
});

async function runOps(c: C, doc: PDFDocument, uploads: Upload[], ops: Operation[]) {
  try {
    await new Editor(ctxOf(c, uploads), doc).run(ops);
  } catch (e) {
    if (e instanceof HttpError || e instanceof z.ZodError) throw e;
    throw new HttpError(422, (e as Error).message);
  }
}

export default app;
