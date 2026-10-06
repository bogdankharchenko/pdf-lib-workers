import { PDFDocument, breakTextIntoLines } from "@cantoo/pdf-lib";
import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Env } from "./env";
import { HttpError, badRequest } from "./errors";
import { documentInfo, documentScripts, extractText, joinText, lockedInfo } from "./inspect";
import { openApiDocument } from "./openapi";
import { Editor, Operation, addSource, checkText, embedFontSpec } from "./operations";
import { resolvePages } from "./pages";
import type { ExtractResponse, MeasureResponse, PdfResult, SplitResponse } from "./replies";
import { CreateRequest, EditRequest, ExtractRequest, InfoRequest, MeasureRequest, MergeRequest, ScriptsRequest, SplitRequest, TextRequest } from "./requests";
import { type Output, type PutTarget, R2Key, pageSize } from "./schemas";
import { signedUrl, timingSafeEqual, verifySignature } from "./signing";
import { imageKind } from "./images";
import { type Ctx, type Upload, assignRefs, findUpload, loadPdf, looksLikePdf, openPdf, readAhead, readSource } from "./sources";

type App = { Bindings: Env };
type C = Context<App>;

const app = new Hono<App>();

app.use("*", cors({ origin: "*", exposeHeaders: ["X-File-Key", "X-File-Url", "X-Page-Count"] }));

const PUBLIC_PATHS = new Set(["/", "/openapi.json"]);

// Every route needs the API key, except the index, the spec and signed download links.
app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS" || (c.req.method === "GET" && PUBLIC_PATHS.has(c.req.path))) return next();
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
    return c.json({ error: "Invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: issueMessage(i) })) }, 400);
  }
  console.error(err);
  return c.json({ error: "Internal error", details: (err as Error).message }, 500);
});

app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));

// ---------- helpers ----------

/** A bad record key's own message (e.g. the key's pattern) rather than zod's generic "Invalid key in record". */
function issueMessage(issue: z.core.$ZodIssue): string {
  return issue.code === "invalid_key" ? (issue.issues[0]?.message ?? issue.message) : issue.message;
}

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

/**
 * Whether the client asked for the PDF itself. JSON wins unless the Accept
 * header ranks application/pdf higher; at equal quality the first listed wins.
 * No header, "*\/*" and browsers' Accept headers all get JSON.
 */
function wantsPdf(c: C): boolean {
  return accepts(c, { header: "Accept", supports: ["application/json", "application/pdf"], default: "application/json" }) === "application/pdf";
}

/**
 * Saves `doc` (or appends to it, for incremental edits), then uploads it to
 * output.put, or replies as JSON or PDF bytes, per the Accept header.
 */
async function sendPdf(c: C, doc: PDFDocument, output: Output, opts: { incremental?: boolean } = {}) {
  c.header("Vary", "Accept");
  if (output.put && wantsPdf(c)) throw badRequest("output.put uploads the PDF and replies with JSON; leave out Accept: application/pdf");
  const bytes = opts.incremental ? await doc.commit({ useObjectStreams: output.useObjectStreams }) : await doc.save({ useObjectStreams: output.useObjectStreams });
  const facts = { size: bytes.byteLength, pageCount: doc.getPageCount() };
  if (output.put) {
    await putPdf(c.env, output.put, bytes, output.filename);
    return c.json(facts satisfies PdfResult);
  }
  const disposition = contentDisposition("inline", output.filename ?? "document.pdf");
  let key: string | undefined;
  let link: { url: string; expiresAt: string } | undefined;
  if (output.store) {
    key = output.key ?? `outputs/${crypto.randomUUID()}.pdf`;
    await c.env.PDF_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf", contentDisposition: disposition } });
    link = await signedUrl(c.env, new URL(c.req.url).origin, key, output.linkTtl);
  }
  if (wantsPdf(c)) {
    const headers = new Headers({ "content-type": "application/pdf", "content-disposition": disposition, "x-page-count": String(doc.getPageCount()), vary: "Accept" });
    if (key && link) {
      headers.set("x-file-key", key);
      headers.set("x-file-url", link.url);
    }
    return new Response(bytes, { headers });
  }
  return c.json((key && link ? { key, ...link, ...facts } : { base64: bytesToBase64(bytes), ...facts }) satisfies PdfResult);
}

/**
 * PUTs the PDF to `put.url`, e.g. an S3 presigned upload URL. Errors name the
 * URL without its query string, which may carry a signature that allows writes.
 */
async function putPdf(env: Env, put: PutTarget, bytes: Uint8Array, filename?: string) {
  const { origin, pathname } = new URL(put.url);
  const url = origin + pathname;
  const timeout = Number(env.FETCH_TIMEOUT_MS || 30000);
  let res: Response;
  try {
    const headers = new Headers({ "content-type": "application/pdf" });
    if (filename) headers.set("content-disposition", contentDisposition("inline", filename));
    for (const [name, value] of Object.entries(put.headers ?? {})) {
      if (!/^(host|content-length)$/i.test(name)) headers.set(name, value);
    }
    // A signed upload URL is valid for its own address only, so a redirect is a failure, not somewhere to follow.
    res = await fetch(put.url, { method: "PUT", body: bytes, headers, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new HttpError(504, `output.put: Timed out after ${timeout / 1000}s uploading to ${url}`);
    throw new HttpError(502, `output.put: Could not upload to ${url}: ${(e as Error).message.replaceAll(put.url, url)}`);
  }
  await res.body?.cancel();
  if (!res.ok) throw new HttpError(502, `output.put: ${url} returned HTTP ${res.status}`);
}

/**
 * A Content-Disposition header value. Header values must be ASCII, so a name
 * with anything else gets an ASCII fallback plus the real name, percent-encoded,
 * in filename* (RFC 6266).
 */
function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  if (fallback === filename) return `${type}; filename="${filename}"`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
    name: "pdfmill",
    openapi: "/openapi.json",
    auth: "Authorization: Bearer <API_KEY>",
    sources:
      'A PDF, image, font or attachment can be a URL string, an R2 key string, { url, headers? }, { key }, { base64 }, or { upload } naming a multipart file by field or file name. Send files as multipart (plus an "options" JSON field) or as a raw body (plus ?options=).',
    endpoints: {
      "GET /files/:key": "Download a result (API key or the signed link it came with).",
      "POST /pdf/info": "Pages, boxes, metadata, form fields, layers, viewer preferences, attachments: { source }",
      "POST /pdf/text": "Extract text: { source, pages?, items? }",
      "POST /pdf/extract": "Extract images, vector graphics, text and attachments: { source, pages?, include?, store?, prefix? }",
      "POST /pdf/scripts": "Document, XFA, field and page JavaScript: { source }",
      "POST /pdf/create": "New PDF: { size?, pageCount?, operations?, output? }",
      "POST /pdf/edit": "Run operations on a PDF: { source, operations, incremental?, output? }",
      "POST /pdf/merge": "Join PDFs and images: { sources: [{ ...source, pages? }], operations?, output? }",
      "POST /pdf/split": "Split a PDF: { source, ranges? | every?, prefix? }",
      "POST /text/measure": "Width/height of text in a font: { text, font?, size?, maxWidth? }",
    },
    operations: Operation.options.map((o) => o.shape.op.value),
  }),
);

let spec: ReturnType<typeof openApiDocument> | undefined;

app.get("/openapi.json", (c) => {
  spec ??= openApiDocument();
  return c.json({ ...spec, servers: [{ url: new URL(c.req.url).origin, description: "This deployment." }] });
});

// ---------- download ----------

app.on(["GET", "HEAD"], "/files/*", async (c) => {
  const key = fileKey(c);
  const obj = await c.env.PDF_BUCKET.get(key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
  if (!obj) throw new HttpError(404, `No file at key "${key}"`);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (c.req.query("download") !== undefined) headers.set("content-disposition", contentDisposition("attachment", key.split("/").pop()!));
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
  const { source } = InfoRequest.parse(body);
  const ctx = ctxOf(c, uploads);
  const bytes = await readSource(ctx, source);
  // XFA is kept so it can be reported; nothing is saved.
  if (source.password === undefined) {
    const peek = await openPdf(bytes, undefined, { ignoreEncryption: true });
    if (peek.isEncrypted) return c.json(lockedInfo(peek));
  }
  return c.json(documentInfo(await openPdf(bytes, source.password, { preserveXFA: true })));
});

app.post("/pdf/scripts", async (c) => {
  const { body, uploads } = await readRequest(c);
  const { source } = ScriptsRequest.parse(body);
  return c.json(documentScripts(await loadPdf(ctxOf(c, uploads), source, { preserveXFA: true })));
});

app.post("/pdf/extract", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = ExtractRequest.parse(body);
  const doc = await loadPdf(ctxOf(c, uploads), req.source);
  const want = new Set(req.include);
  const prefix = req.prefix ?? `extracted/${crypto.randomUUID()}/`;
  const origin = new URL(c.req.url).origin;
  const file = async (name: string, bytes: Uint8Array, contentType: string) => {
    if (!req.store) return { base64: bytesToBase64(bytes) };
    const key = R2Key.parse(prefix + name);
    await c.env.PDF_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    return { key, ...(await signedUrl(c.env, origin, key, req.linkTtl)) };
  };
  const all = doc.getPages();
  const pages: ExtractResponse["pages"] = [];
  for (const i of resolvePages(req.pages, all.length)) {
    const assets = all[i].extractContents();
    const out: ExtractResponse["pages"][number] = { page: i + 1 };
    if (want.has("text")) {
      const items = assets.flatMap((a) => (a.kind === "text" ? [{ text: a.getText(), x: a.x, y: a.y, fontSize: a.fontSize, fontFamily: a.fontFamily }] : []));
      out.text = joinText(items);
    }
    if (want.has("images")) {
      const images: NonNullable<typeof out.images> = [];
      let n = 0;
      for (const a of assets) {
        if (a.kind !== "image") continue;
        const ext = a.mimeType === "image/png" ? "png" : "jpg";
        const stored = await file(`page-${i + 1}-image-${++n}.${ext}`, a.getBytes(), a.mimeType);
        images.push({ mimeType: a.mimeType, width: a.width, height: a.height, x: a.x, y: a.y, drawWidth: a.drawWidth, drawHeight: a.drawHeight, ...stored });
      }
      out.images = images;
    }
    if (want.has("graphics")) {
      out.graphics = assets.flatMap((a) => (a.kind === "graphics" ? [{ x: a.x, y: a.y, width: a.width, height: a.height, svg: a.getSvg() }] : []));
    }
    pages.push(out);
  }
  const result: ExtractResponse = { pages };
  if (want.has("attachments")) {
    const attachments: NonNullable<ExtractResponse["attachments"]> = [];
    for (const a of doc.getAttachments()) {
      const safe = a.name.replace(/[^\w.-]+/g, "_");
      attachments.push({ name: a.name, mimeType: a.mimeType ?? null, description: a.description ?? null, size: a.data.byteLength, ...(await file(`attachments/${safe}`, a.data, a.mimeType ?? "application/octet-stream")) });
    }
    result.attachments = attachments;
  }
  return c.json(result);
});

app.post("/text/measure", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = MeasureRequest.parse(body);
  const doc = await PDFDocument.create();
  const ctx = ctxOf(c, uploads);
  const font = await embedFontSpec(doc, ctx, req.font);
  checkText(font, req.text);
  const lineHeight = req.lineHeight ?? req.size * 1.2;
  const lines = req.text.split("\n").flatMap((l) => (req.maxWidth ? breakTextIntoLines(l, req.wordBreaks, req.maxWidth, (t) => font.widthOfTextAtSize(t, req.size)) : [l]));
  const widths = lines.map((l) => font.widthOfTextAtSize(l, req.size));
  return c.json({
    width: Math.max(0, ...widths),
    height: font.heightAtSize(req.size),
    ascent: font.heightAtSize(req.size, { descender: false }),
    lines: lines.map((text, i) => ({ text, width: widths[i] })),
    blockHeight: lines.length ? (lines.length - 1) * lineHeight + font.heightAtSize(req.size) : 0,
    ...(req.fitHeight ? { sizeForHeight: font.sizeAtHeight(req.fitHeight) } : {}),
  } satisfies MeasureResponse);
});

app.post("/pdf/text", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = TextRequest.parse(body);
  const doc = await loadPdf(ctxOf(c, uploads), req.source);
  return c.json({ pages: extractText(doc, req.pages, req.items) });
});

app.post("/pdf/create", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = CreateRequest.parse(body);
  const doc = await PDFDocument.create();
  const size = pageSize(req.size);
  for (let i = 0; i < req.pageCount; i++) doc.addPage(size);
  await runOps(c, doc, uploads, req.operations);
  if (!doc.getPageCount()) throw badRequest("The document has no pages");
  return sendPdf(c, doc, req.output);
});

app.post("/pdf/edit", async (c) => {
  const { body, uploads } = await readRequest(c);
  const req = EditRequest.parse(body);
  const doc = await loadPdf(ctxOf(c, uploads), req.source, { incremental: req.incremental });
  await runOps(c, doc, uploads, req.operations);
  return sendPdf(c, doc, req.output, { incremental: req.incremental });
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
  const req = MergeRequest.parse(body);
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
  const req = SplitRequest.parse(body);
  const src = await loadPdf(ctxOf(c, uploads), req.source);
  const count = src.getPageCount();
  const groups = req.ranges
    ? req.ranges.map((r) => resolvePages(r, count))
    : Array.from({ length: Math.ceil(count / req.every) }, (_, g) => Array.from({ length: Math.min(req.every, count - g * req.every) }, (_, j) => g * req.every + j));
  if (groups.length > 1000) throw badRequest("Split would make more than 1000 files");
  const prefix = req.prefix ?? `outputs/${crypto.randomUUID()}/`;
  const origin = new URL(c.req.url).origin;
  const parts: SplitResponse["parts"] = [];
  for (const [n, idx] of groups.entries()) {
    if (!idx.length) throw badRequest(`ranges[${n}] selects no pages`);
    const part = await PDFDocument.create();
    for (const p of await part.copyPages(src, idx)) part.addPage(p);
    const bytes = await part.save();
    const key = R2Key.parse(`${prefix}part-${String(n + 1).padStart(3, "0")}.pdf`);
    await c.env.PDF_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    parts.push({ key, pages: idx.map((i) => i + 1), size: bytes.byteLength, ...(await signedUrl(c.env, origin, key, req.linkTtl)) });
  }
  return c.json({ parts } satisfies SplitResponse);
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
