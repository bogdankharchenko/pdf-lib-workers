import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

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

/** A PDF with `n` pages, each saying "<label> i". */
async function samplePdf(n = 3, label = "Page", size: [number, number] = [612, 792]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) doc.addPage(size).drawText(`${label} ${i}`, { x: 50, y: 700, size: 24, font });
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
          { op: "insertPdf", source: { base64: b64(await samplePdf(1, "Page", [300, 300])) }, at: 2 },
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

describe("inputs: URLs and file data", () => {
  // Stand-in for the internet: URL -> handler. The Worker shares this isolate, so it sees the mock.
  const remote = new Map<string, (req: Request) => Response | Promise<Response>>();
  let fetchSpy: MockInstance;
  const serve = (url: string, bytes: Uint8Array, init?: ResponseInit) => remote.set(url, () => new Response(bytes, init));

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      const handler = remote.get(req.url);
      return handler ? handler(req) : new Response("not found", { status: 404 });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    remote.clear();
  });

  const pageTexts = async (key: string) => (await json(post("/pdf/text", { source: key }))).pages.map((p: any) => p.text);

  it("stitches URLs, R2 keys, base64 and uploads in one call, then watermarks", async () => {
    serve("https://files.test/a.pdf", await samplePdf(2, "A"));
    serve("https://files.test/b.pdf", await samplePdf(1, "B"));
    await json(call("/files?key=tests/c.pdf", { method: "POST", headers: { "content-type": "application/pdf" }, body: await samplePdf(1, "C") }));
    const fd = new FormData();
    fd.set("e", new File([await samplePdf(3, "E")], "e.pdf"));
    fd.set(
      "options",
      JSON.stringify({
        sources: ["https://files.test/a.pdf", { url: "https://files.test/b.pdf" }, "tests/c.pdf", { base64: b64(await samplePdf(1, "D")) }, { upload: "e", pages: "3" }],
        operations: [{ op: "watermark", text: "COPY" }],
      }),
    );
    const out = await json(call("/pdf/merge", { method: "POST", body: fd }));
    const texts = await pageTexts(out.key);
    expect(texts.map((t: string) => t.replace("COPY", "").trim())).toEqual(["A 1", "A 2", "B 1", "C 1", "D 1", "E 3"]);
    expect(texts.every((t: string) => t.includes("COPY"))).toBe(true);
  });

  it("stitches every uploaded PDF in order, even when field names repeat", async () => {
    const png = Uint8Array.from(atob(PNG), (ch) => ch.charCodeAt(0));
    const form = async () => {
      const fd = new FormData();
      fd.append("files", new File([await samplePdf(1, "A")], "a.pdf"));
      fd.append("files", new File([await samplePdf(1, "B")], "b.pdf"));
      fd.append("files", new File([await samplePdf(1, "C")], "c.pdf"));
      fd.append("logo", new File([png], "logo.png", { type: "image/png" }));
      return fd;
    };
    // No options: every PDF, in the order sent; the image is left out.
    const all = await json(call("/pdf/merge", { method: "POST", body: await form() }));
    expect(await pageTexts(all.key)).toEqual(["A 1", "B 1", "C 1"]);

    // Pick files by file name or by files[i]; use the image in an operation.
    const fd = await form();
    fd.set("options", JSON.stringify({ sources: [{ upload: "c.pdf" }, { upload: "files[0]" }], operations: [{ op: "drawImage", image: { upload: "logo" }, x: 0, y: 0 }] }));
    const picked = await json(call("/pdf/merge", { method: "POST", body: fd }));
    expect(await pageTexts(picked.key)).toEqual(["C 1", "A 1"]);

    const ambiguous = await form();
    ambiguous.set("options", JSON.stringify({ sources: [{ upload: "files" }] }));
    const res = await call("/pdf/merge", { method: "POST", body: ambiguous });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error).toContain("files[0], files[1], files[2]");
  });

  it("watermarks a PDF sent as a URL, base64, multipart or raw body", async () => {
    const pdf = await samplePdf(1);
    serve("https://files.test/w.pdf", pdf);
    const operations = [{ op: "watermark", text: "SECRET" }];
    const opts = encodeURIComponent(JSON.stringify({ operations }));
    const fd = new FormData();
    fd.set("file", new File([pdf], "w.pdf"));
    fd.set("options", JSON.stringify({ operations }));
    const outs = [
      await json(post("/pdf/edit", { source: "https://files.test/w.pdf", operations })),
      await json(post("/pdf/edit", { source: { base64: b64(pdf) }, operations })),
      await json(post("/pdf/edit", { source: "data:application/pdf;base64," + b64(pdf), operations })),
      await json(call("/pdf/edit", { method: "POST", body: fd })),
      await json(call(`/pdf/edit?options=${opts}`, { method: "POST", headers: { "content-type": "application/pdf" }, body: pdf })),
      // No content type at all: the PDF header is enough.
      await json(call(`/pdf/edit?options=${opts}`, { method: "POST", body: pdf })),
    ];
    for (const out of outs) expect((await pageTexts(out.key))[0]).toContain("SECRET");
  });

  it("reads its own download links from R2, not the network", async () => {
    const a = await json(post("/pdf/create", { operations: [{ op: "drawText", text: "First", x: 50, y: 50 }] }));
    const b = await json(post("/pdf/create", { operations: [{ op: "drawText", text: "Second", x: 50, y: 50 }] }));
    // A signed link still works if the API is reached through another hostname.
    const elsewhere = b.url.replace("https://pdf.test", "https://pdf.example.com");
    const out = await json(post("/pdf/merge", { sources: [a.url, elsewhere] }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await pageTexts(out.key)).toEqual(["First", "Second"]);
  });

  it("sends custom headers with URL requests", async () => {
    remote.set("https://files.test/private.pdf", async (req) =>
      req.headers.get("authorization") === "Bearer abc" ? new Response(await samplePdf(2)) : new Response("denied", { status: 401 }),
    );
    const denied = await post("/pdf/info", { source: "https://files.test/private.pdf" });
    expect(denied.status).toBe(502);
    expect((await denied.json<any>()).error).toContain("HTTP 401");
    const info = await json(post("/pdf/info", { source: { url: "https://files.test/private.pdf", headers: { authorization: "Bearer abc" } } }));
    expect(info.pageCount).toBe(2);
  });

  it("explains bad URL sources", async () => {
    const pdf = { base64: b64(await samplePdf(1)) };
    const error = async (res: Response | Promise<Response>) => {
      const r = await res;
      return { status: r.status, error: (await r.json<any>()).error as string };
    };

    remote.set("https://files.test/page.html", () => new Response("<!DOCTYPE html><html>Sign in</html>", { headers: { "content-type": "text/html" } }));
    const html = await error(post("/pdf/merge", { sources: [pdf, "https://files.test/page.html"] }));
    expect(html).toEqual({ status: 422, error: 'sources[1]: Not a PDF (starts with "<!DOCTYPE html><html>Sign in</html>")' });

    const missing = await error(post("/pdf/merge", { sources: [pdf, "https://files.test/nope.pdf"] }));
    expect(missing).toEqual({ status: 502, error: "sources[1]: https://files.test/nope.pdf returned HTTP 404" });

    remote.set("https://files.test/slow.pdf", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    expect((await error(post("/pdf/info", { source: "https://files.test/slow.pdf" }))).status).toBe(504);

    serve("https://files.test/huge.pdf", new Uint8Array(1_500_000));
    expect((await error(post("/pdf/info", { source: "https://files.test/huge.pdf" }))).status).toBe(413);

    const watermarkImage = await error(post("/pdf/edit", { source: pdf, operations: [{ op: "drawImage", image: "https://files.test/nope.png", x: 0, y: 0 }] }));
    expect(watermarkImage).toEqual({ status: 502, error: "operations[0] (drawImage): https://files.test/nope.png returned HTTP 404" });

    const both = await post("/pdf/info", { source: { url: "https://files.test/a.pdf", key: "a.pdf" } });
    expect(both.status).toBe(400);
    expect(JSON.stringify(await both.json())).toContain("exactly one of key, url, base64 or upload");

    expect((await post("/pdf/info", { source: { url: "ftp://files.test/a.pdf" } })).status).toBe(400);
  });
});
