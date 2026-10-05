import { PDFDocument, EncryptedPDFError } from "@cantoo/pdf-lib";
import type { Env } from "./env";
import { HttpError, badRequest } from "./errors";
import type { PdfSource, Source } from "./schemas";

export type Uploads = Map<string, Uint8Array>;

export interface Ctx {
  env: Env;
  uploads: Uploads;
}

export async function readSource(ctx: Ctx, src: Source): Promise<Uint8Array> {
  if ("key" in src) {
    const obj = await ctx.env.PDF_BUCKET.get(src.key);
    if (!obj) throw new HttpError(404, `No file at key "${src.key}"`);
    return new Uint8Array(await obj.arrayBuffer());
  }
  if ("upload" in src) {
    const bytes = ctx.uploads.get(src.upload);
    if (!bytes) throw badRequest(`No uploaded file in form field "${src.upload}"`);
    return bytes;
  }
  if ("base64" in src) {
    try {
      const b64 = src.base64.replace(/^data:[^,]*,/, "");
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      throw badRequest("Invalid base64 data");
    }
  }
  return fetchUrl(ctx.env, src.url);
}

async function fetchUrl(env: Env, url: string): Promise<Uint8Array> {
  const max = Number(env.MAX_FETCH_BYTES || 50 * 1024 * 1024);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw new HttpError(502, `Could not fetch ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new HttpError(502, `Fetching ${url} returned HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > max) throw new HttpError(413, `${url} is larger than ${max} bytes`);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, `${url} is larger than ${max} bytes`);
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
}

export async function loadPdf(ctx: Ctx, src: PdfSource): Promise<PDFDocument> {
  const bytes = await readSource(ctx, src);
  return openPdf(bytes, src.password);
}

export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { password, updateMetadata: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError) {
      throw new HttpError(422, password ? "Wrong password for encrypted PDF" : "PDF is encrypted; pass \"password\" with the source");
    }
    throw new HttpError(422, `Could not parse PDF: ${(e as Error).message}`);
  }
}
