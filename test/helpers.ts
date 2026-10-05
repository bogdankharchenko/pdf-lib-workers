import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";

export const worker = (exports as unknown as { default: Fetcher }).default;
export const bucket = (env as unknown as { PDF_BUCKET: R2Bucket }).PDF_BUCKET;
export const AUTH = { authorization: "Bearer test-key" };
export const BASE = "https://pdf.test";

export function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(BASE + path, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string>) } }));
}
export async function post(path: string, body: unknown) {
  return call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`);
  return body as T;
}
export async function download(url: string) {
  const res = await worker.fetch(new Request(url));
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}
export function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

export const pageTexts = async (key: string) => (await json(post("/pdf/text", { source: key }))).pages.map((p: any) => p.text);

/** A PDF with `n` pages, each saying "<label> i". */
export async function samplePdf(n = 3, label = "Page", size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage(size).drawText(`${label} ${i}`, { x: 50, y: 700, size: 24, font });
  return doc.save();
}

export async function formPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("name").addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  form.createCheckBox("agree").addToPage(page, { x: 50, y: 650, width: 20, height: 20 });
  const dd = form.createDropdown("color");
  dd.addOptions(["red", "green"]);
  dd.addToPage(page, { x: 50, y: 600, width: 100, height: 24 });
  return doc.save();
}

// 1x1 red PNG
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
