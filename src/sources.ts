import { PDFDocument, EncryptedPDFError } from "@cantoo/pdf-lib";
import type { Env } from "./env";
import { HttpError, badRequest } from "./errors";
import type { PdfSource, Source } from "./schemas";
import { verifySignature } from "./signing";

export interface Upload {
  /** How sources refer to it: the field name, or name[i] when several files share a field. */
  ref: string;
  field: string;
  filename?: string;
  bytes: Uint8Array;
}

export interface Ctx {
  env: Env;
  uploads: Upload[];
  /** This API's origin, so its own download links are read straight from R2. */
  origin: string;
}

/** Gives files that share a field name the refs name[0], name[1], … */
export function assignRefs(files: Omit<Upload, "ref">[]): Upload[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.field, (counts.get(f.field) ?? 0) + 1);
  const seen = new Map<string, number>();
  return files.map((f) => {
    if (counts.get(f.field) === 1) return { ...f, ref: f.field };
    const i = seen.get(f.field) ?? 0;
    seen.set(f.field, i + 1);
    return { ...f, ref: `${f.field}[${i}]` };
  });
}

/** Finds an upload by ref, then field name, then file name. */
export function findUpload(uploads: Upload[], name: string): Upload {
  for (const match of [(u: Upload) => u.ref === name, (u: Upload) => u.field === name, (u: Upload) => u.filename === name]) {
    const found = uploads.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw badRequest(`"${name}" matches ${found.length} uploaded files; use one of: ${found.map((u) => u.ref).join(", ")}`);
  }
  throw badRequest(
    uploads.length ? `No uploaded file "${name}". Uploaded: ${uploads.map((u) => u.ref).join(", ")}` : `No uploaded file "${name}" (the request has no files)`,
  );
}

export async function readSource(ctx: Ctx, src: Source): Promise<Uint8Array> {
  if (src.key !== undefined) return readKey(ctx.env, src.key);
  if (src.upload !== undefined) return findUpload(ctx.uploads, src.upload).bytes;
  if (src.base64 !== undefined) {
    try {
      const b64 = src.base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      throw badRequest("Invalid base64 data");
    }
  }
  return fetchUrl(ctx, src.url!, src.headers);
}

async function readKey(env: Env, key: string): Promise<Uint8Array> {
  const obj = await env.PDF_BUCKET.get(key);
  if (!obj) throw new HttpError(404, `No file at key "${key}"`);
  return new Uint8Array(await obj.arrayBuffer());
}

/** Returns the R2 key if `url` is one of this API's own file links. */
async function ownKey(ctx: Ctx, url: string): Promise<string | undefined> {
  const u = new URL(url);
  if (!u.pathname.startsWith("/files/")) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(u.pathname.slice("/files/".length));
  } catch {
    return undefined;
  }
  if (u.origin === ctx.origin) return key;
  const signed = await verifySignature(ctx.env, key, u.searchParams.get("expires") ?? undefined, u.searchParams.get("sig") ?? undefined);
  return signed ? key : undefined;
}

async function fetchUrl(ctx: Ctx, url: string, headers?: Record<string, string>): Promise<Uint8Array> {
  const own = await ownKey(ctx, url);
  if (own !== undefined) return readKey(ctx.env, own);

  const max = Number(ctx.env.MAX_FETCH_BYTES || 50 * 1024 * 1024);
  const timeout = Number(ctx.env.FETCH_TIMEOUT_MS || 30000);
  const tooBig = () => new HttpError(413, `${url} is larger than ${max} bytes`);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "pdf-lib-workers", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new HttpError(502, `${url} returned HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") || 0) > max) throw tooBig();
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw tooBig();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as Error).name === "TimeoutError") throw new HttpError(504, `Timed out after ${timeout / 1000}s fetching ${url}`);
    throw new HttpError(502, `Could not fetch ${url}: ${(e as Error).message}`);
  }
}

/**
 * Returns a reader for items[i] that starts downloading the next few items
 * early, so slow URLs overlap without holding every file in memory.
 */
export function readAhead<T>(items: T[], read: (item: T) => Promise<Uint8Array>, ahead = 4) {
  const started: (Promise<Uint8Array> | undefined)[] = [];
  return (i: number): Promise<Uint8Array> => {
    for (let j = i; j < Math.min(items.length, i + ahead); j++) {
      if (started[j]) continue;
      const p = read(items[j]);
      p.catch(() => {}); // a failure surfaces when that item is awaited
      started[j] = p;
    }
    const p = started[i]!;
    started[i] = undefined;
    return p;
  };
}

/** True if the PDF header appears in the first 1 KB, as readers require. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

export async function loadPdf(ctx: Ctx, src: PdfSource): Promise<PDFDocument> {
  return openPdf(await readSource(ctx, src), src.password);
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { password, updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new HttpError(422, password ? "Wrong password for encrypted PDF" : 'PDF is encrypted; pass "password" with the source');
    }
    if (!looksLikePdf(bytes)) {
      const start = new TextDecoder().decode(bytes.subarray(0, 40)).replace(/[^\x20-\x7e]/g, "?");
      throw new HttpError(422, bytes.length ? `Not a PDF (starts with ${JSON.stringify(start)})` : "Not a PDF (empty file)");
    }
    throw new HttpError(422, `Could not parse PDF: ${(e as Error).message}`);
  }
}
