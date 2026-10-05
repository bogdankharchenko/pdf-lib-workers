import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as { default: Fetcher }).default;
const AUTH = { authorization: "Bearer test-key" };
const BASE = "https://pdf.test";

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(BASE + path, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string>) } }));
}
async function post(path: string, body: unknown) {
  return call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`);
  return body as T;
}
async function download(url: string) {
  const res = await worker.fetch(new Request(url));
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}
function b64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

/** A PDF with `n` pages, each saying "Page i". */
async function samplePdf(n = 3, size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage(size).drawText(`Page ${i}`, { x: 50, y: 700, size: 24, font });
  return doc.save();
}

async function formPdf() {
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
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("auth", () => {
  it("serves the index without a key", async () => {
    const res = await worker.fetch(new Request(BASE + "/"));
    expect(res.status).toBe(200);
    expect((await res.json<any>()).operations).toContain("drawText");
  });
  it("rejects missing or wrong keys", async () => {
    expect((await worker.fetch(new Request(BASE + "/files"))).status).toBe(401);
    const bad = await worker.fetch(new Request(BASE + "/files", { headers: { authorization: "Bearer nope" } }));
    expect(bad.status).toBe(401);
  });
  it("accepts X-API-Key", async () => {
    const res = await worker.fetch(new Request(BASE + "/files", { headers: { "x-api-key": "test-key" } }));
    expect(res.status).toBe(200);
  });
});

describe("files", () => {
  it("uploads, lists, signs, downloads with range, deletes", async () => {
    const pdf = await samplePdf(1);
    const up = await json(call("/files?key=tests/a.pdf", { method: "POST", headers: { "content-type": "application/pdf" }, body: pdf }));
    expect(up.key).toBe("tests/a.pdf");
    expect(up.url).toContain("sig=");

    const list = await json(call("/files?prefix=tests/"));
    expect(list.files.map((f: any) => f.key)).toContain("tests/a.pdf");

    expect((await download(up.url)).byteLength).toBe(pdf.byteLength);

    const ranged = await worker.fetch(new Request(up.url, { headers: { range: "bytes=0-4" } }));
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("%PDF-");

    const tampered = up.url.replace("tests/a.pdf", "tests/b.pdf");
    expect((await worker.fetch(new Request(tampered))).status).toBe(403);

    const expired = new URL(up.url);
    expired.searchParams.set("expires", "1000");
    expect((await worker.fetch(new Request(expired))).status).toBe(403);

    const signed = await json(post("/files/sign", { key: "tests/a.pdf", ttl: 60 }));
    expect((await download(signed.url)).byteLength).toBe(pdf.byteLength);

    expect((await call("/files/tests/a.pdf", { method: "DELETE" })).status).toBe(200);
    expect((await call("/files/tests/a.pdf")).status).toBe(404);
  });

  it("accepts multipart uploads", async () => {
    const fd = new FormData();
    fd.set("file", new File([await samplePdf(1)], "x.pdf", { type: "application/pdf" }));
    const up = await json(call("/files", { method: "POST", body: fd }));
    expect(up.key).toMatch(/^uploads\/.+\.pdf$/);
  });
});

describe("pdf", () => {
  it("creates a PDF and reads it back", async () => {
    const out = await json(
      post("/pdf/create", {
        size: "Letter",
        pageCount: 2,
        operations: [
          { op: "drawText", text: "Hello Workers", x: 72, y: 72, origin: "top-left", size: 20 },
          { op: "drawRectangle", pages: [2], x: 50, y: 50, width: 100, height: 40, color: "#336699" },
          { op: "drawLine", start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
          { op: "drawSvg", svg: '<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>', x: 10, y: 10, origin: "top-left" },
          { op: "setMetadata", title: "Test doc", author: "API" },
        ],
      }),
    );
    expect(out.pageCount).toBe(2);
    const doc = await PDFDocument.load(await download(out.url));
    expect(doc.getTitle()).toBe("Test doc");
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });

    const text = await json(post("/pdf/text", { source: { key: out.key }, pages: "1" }));
    expect(text.pages[0].text).toContain("Hello Workers");
  });

  it("reports info for a raw PDF body", async () => {
    const info = await json(call("/pdf/info", { method: "POST", headers: { "content-type": "application/pdf" }, body: await samplePdf(3) }));
    expect(info.pageCount).toBe(3);
    expect(info.pages[2]).toEqual({ page: 3, width: 612, height: 792, rotation: 0 });
  });

  it("edits pages: select, remove, rotate, resize, watermark, numbers", async () => {
    const src = { base64: b64(await samplePdf(4)) };
    const out = await json(
      post("/pdf/edit", {
        source: src,
        operations: [
          { op: "selectPages", pages: "4,2,3,1,1" },
          { op: "removePages", pages: [-1] },
          { op: "rotatePages", pages: "1-2", degrees: 90 },
          { op: "resizePages", pages: [3], size: "A4" },
          { op: "duplicatePage", page: 1, at: 1 },
          { op: "addPage", size: [200, 200] },
          { op: "watermark", text: "DRAFT" },
          { op: "pageNumbers", format: "Page {page} of {total}" },
          { op: "cropPages", pages: "last", x: 10, y: 10, width: 100, height: 100 },
        ],
      }),
    );
    expect(out.pageCount).toBe(6);
    const text = await json(post("/pdf/text", { source: { key: out.key } }));
    expect(text.pages.map((p: any) => p.text.match(/Page \d(?! of)/)?.[0] ?? null)).toEqual(["Page 4", "Page 4", "Page 2", "Page 3", "Page 1", null]);
    expect(text.pages[5].text).toContain("Page 6 of 6");
    expect(text.pages[0].text).toContain("DRAFT");
    const info = await json(post("/pdf/info", { source: { key: out.key } }));
    expect(info.pages.map((p: any) => p.rotation)).toEqual([90, 90, 90, 0, 0, 0]);
    expect(info.pages[3].width).toBeCloseTo(595.28);
  });

  it("inserts another PDF and draws an image", async () => {
    const out = await json(
      post("/pdf/edit", {
        source: { base64: b64(await samplePdf(2)) },
        operations: [
          { op: "insertPdf", source: { base64: b64(await samplePdf(1, [300, 300])) }, at: 2 },
          { op: "drawImage", pages: [1], image: { base64: PNG }, x: 10, y: 10, width: 50 },
        ],
      }),
    );
    expect(out.pageCount).toBe(3);
    const info = await json(post("/pdf/info", { source: { key: out.key } }));
    expect(info.pages[1].width).toBe(300);
  });

  it("merges with page selection and multipart uploads", async () => {
    const fd = new FormData();
    fd.set("a", new File([await samplePdf(3)], "a.pdf"));
    fd.set("b", new File([await samplePdf(2)], "b.pdf"));
    fd.set("options", JSON.stringify({ sources: [{ upload: "a", pages: "2-3" }, { upload: "b" }], output: { filename: "merged.pdf" } }));
    const out = await json(call("/pdf/merge", { method: "POST", body: fd }));
    expect(out.pageCount).toBe(4);
    const text = await json(post("/pdf/text", { source: { key: out.key } }));
    expect(text.pages.map((p: any) => p.text)).toEqual(["Page 2", "Page 3", "Page 1", "Page 2"]);
  });

  it("splits by size and by range", async () => {
    const src = { base64: b64(await samplePdf(5)) };
    const every = await json(post("/pdf/split", { source: src, every: 2, prefix: "tests/split/" }));
    expect(every.parts.map((p: any) => p.pages)).toEqual([[1, 2], [3, 4], [5]]);
    expect(every.parts[0].key).toBe("tests/split/part-001.pdf");
    const ranged = await json(post("/pdf/split", { source: src, ranges: ["odd", "5-4"] }));
    expect(ranged.parts.map((p: any) => p.pages)).toEqual([[1, 3, 5], [5, 4]]);
    expect((await PDFDocument.load(await download(ranged.parts[1].url))).getPageCount()).toBe(2);
  });

  it("fills and flattens forms", async () => {
    const src = { base64: b64(await formPdf()) };
    const info = await json(post("/pdf/info", { source: src }));
    expect(info.form.fields.map((f: any) => f.name)).toEqual(["name", "agree", "color"]);

    const filled = await json(post("/pdf/edit", { source: src, operations: [{ op: "fillForm", fields: { name: "Ada", agree: true, color: "green" } }] }));
    const after = await json(post("/pdf/info", { source: { key: filled.key } }));
    expect(after.form.fields).toEqual([
      { name: "name", type: "text", value: "Ada" },
      { name: "agree", type: "checkbox", value: true },
      { name: "color", type: "dropdown", value: ["green"], options: ["red", "green"] },
    ]);

    const flat = await json(post("/pdf/edit", { source: src, operations: [{ op: "fillForm", fields: { name: "Ada" }, flatten: true }] }));
    expect((await json(post("/pdf/info", { source: { key: flat.key } }))).form.fields).toEqual([]);

    const res = await post("/pdf/edit", { source: src, operations: [{ op: "fillForm", fields: { nope: "x" } }] });
    expect(res.status).toBe(400);
  });

  it("encrypts, then needs the password to open", async () => {
    const enc = await json(
      post("/pdf/edit", {
        source: { base64: b64(await samplePdf(1)) },
        operations: [{ op: "encrypt", ownerPassword: "owner", userPassword: "user", permissions: { copying: false } }],
      }),
    );
    const locked = await post("/pdf/info", { source: { key: enc.key } });
    expect(locked.status).toBe(422);
    const info = await json(post("/pdf/info", { source: { key: enc.key, password: "user" } }));
    expect(info.pageCount).toBe(1);
    const text = await json(post("/pdf/text", { source: { key: enc.key, password: "owner" } }));
    expect(text.pages[0].text).toBe("Page 1");
  });

  it("attaches files", async () => {
    const out = await json(
      post("/pdf/edit", {
        source: { base64: b64(await samplePdf(1)) },
        operations: [{ op: "attachFile", file: { base64: btoa("hello") }, name: "note.txt", mimeType: "text/plain" }],
      }),
    );
    const info = await json(post("/pdf/info", { source: { key: out.key } }));
    expect(info.attachments).toEqual([{ name: "note.txt", size: 5, mimeType: "text/plain", description: null }]);
  });

  it("returns PDF bytes or base64 instead of a link", async () => {
    const res = await post("/pdf/create", { output: { return: "pdf", key: "tests/direct.pdf", filename: "x.pdf" } });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-file-key")).toBe("tests/direct.pdf");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    const unstored = await json(post("/pdf/create", { output: { store: false } }));
    expect(unstored.key).toBeUndefined();
    expect(atob(unstored.base64).startsWith("%PDF-")).toBe(true);
  });

  it("gives clear errors", async () => {
    const bad = await post("/pdf/edit", { source: { key: "missing.pdf" }, operations: [{ op: "explode" }] });
    expect(bad.status).toBe(400);
    expect((await bad.json<any>()).details[0].path).toContain("operations.0");

    const missing = await post("/pdf/info", { source: { key: "missing.pdf" } });
    expect(missing.status).toBe(404);

    const range = await post("/pdf/edit", { source: { base64: b64(await samplePdf(1)) }, operations: [{ op: "removePages", pages: [5] }] });
    expect(range.status).toBe(400);
    expect((await range.json<any>()).error).toContain("operations[0] (removePages)");

    const notPdf = await post("/pdf/info", { source: { base64: btoa("hello") } });
    expect(notPdf.status).toBe(422);
  });
});
