import { PDFDocument, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { readXmp } from "../src/metadata";
import { PNG, b64, bucket, download, formPdf, json, pageTexts, post, samplePdf } from "./helpers";

const pdf = async (n = 1, label = "Page") => ({ base64: b64(await samplePdf(n, label)) });
const edit = (source: unknown, operations: unknown[], extra: Record<string, unknown> = {}) => json(post("/pdf/edit", { source, operations, ...extra }));
const info = async (source: unknown) => json(post("/pdf/info", { source }));
const fail = async (path: string, body: unknown) => {
  const r = await post(path, body);
  return { status: r.status, error: JSON.stringify(await r.json()) };
};
const load = async (key: string) => PDFDocument.load(await (await bucket.get(key))!.arrayBuffer());

describe("passwords", () => {
  it("removes a password by opening with it", async () => {
    const locked = await edit(await pdf(1), [
      { op: "setMetadata", title: "Secret plan" },
      { op: "encrypt", ownerPassword: "o", userPassword: "u" },
    ]);
    const open = await edit({ key: locked.key, password: "u" }, [{ op: "setMetadata", author: "Me" }]);
    const i = await info(open.key);
    expect(i).toMatchObject({ encrypted: false, metadata: { title: "Secret plan", author: "Me" } });
    expect(await pageTexts(open.key)).toEqual(["Page 1"]);
  });

  it("refuses broken RC4 unless asked", async () => {
    expect((await fail("/pdf/edit", { source: await pdf(), operations: [{ op: "encrypt", ownerPassword: "o", algorithm: "RC4-40" }] })).status).toBe(422);
    const ok = await edit(await pdf(), [{ op: "encrypt", ownerPassword: "o", algorithm: "RC4-128", allowWeakCryptography: true }]);
    expect(await info({ key: ok.key, password: "" })).toMatchObject({ pageCount: 1 });
  });
});

describe("saving", () => {
  it("appends changes incrementally, keeping the original bytes", async () => {
    const original = await samplePdf(1);
    const out = await edit({ base64: b64(original) }, [{ op: "drawText", text: "Added", x: 50, y: 50 }], { incremental: true });
    const saved = new Uint8Array(await (await bucket.get(out.key))!.arrayBuffer());
    expect(saved.length).toBeGreaterThan(original.length);
    expect(saved.subarray(0, original.length)).toEqual(original);
    expect((await pageTexts(out.key))[0]).toContain("Added");
  });

  it("can write a classic cross-reference table", async () => {
    const out = await edit(await pdf(), [{ op: "setMetadata", title: "x" }], { output: { useObjectStreams: false } });
    const text = new TextDecoder("latin1").decode(new Uint8Array(await (await bucket.get(out.key))!.arrayBuffer()));
    expect(text).toMatch(/\nxref\n/);
    expect(text).not.toContain("/ObjStm");
  });
});

describe("pages", () => {
  it("sets page boxes, scales pages and moves content", async () => {
    const out = await edit(await pdf(2), [
      { op: "setPageBoxes", pages: [1], trimBox: { x: 10, y: 10, width: 500, height: 700 }, bleedBox: { x: 5, y: 5, width: 510, height: 710 } },
      { op: "scalePages", pages: [2], factor: 0.5 },
      { op: "translateContent", pages: [1], x: 20, y: -20 },
    ]);
    const { pages } = await info(out.key);
    expect(pages[0].boxes.trimBox).toEqual({ x: 10, y: 10, width: 500, height: 700 });
    expect(pages[0].boxes.bleedBox).toEqual({ x: 5, y: 5, width: 510, height: 710 });
    expect([pages[1].width, pages[1].height]).toEqual([306, 396]);
  });
});

describe("drawing", () => {
  it("draws every shape and style", async () => {
    const out = await json(
      post("/pdf/create", {
        operations: [
          { op: "drawEllipse", x: 300, y: 400, xRadius: 80, yRadius: 40, color: "#ffcc00", borderColor: "#000", borderDashArray: [4, 2] },
          { op: "drawEllipse", x: 100, y: 100, xRadius: 30, borderColor: "#f00", borderWidth: 2 },
          { op: "drawSvgPath", path: "M 0 0 L 100 0 L 50 80 Z", x: 50, y: 300, color: "#00f", fillRule: "evenodd" },
          { op: "drawRectangle", x: 50, y: 500, width: 200, height: 80, rx: 12, ry: 12, borderColor: "#333", borderDashArray: [6, 3], borderLineCap: "round", blendMode: "Multiply" },
          { op: "drawLine", start: { x: 0, y: 0 }, end: { x: 500, y: 500 }, dashArray: [10, 5], lineCap: "round" },
          {
            op: "drawText",
            text: "Outlined, spaced and skewed",
            x: 50,
            y: 700,
            size: 20,
            renderMode: "fillAndOutline",
            strokeColor: "#f00",
            strokeWidth: 0.5,
            characterSpacing: 2,
            xSkew: 10,
            blendMode: "Multiply",
          },
          { op: "drawText", text: "alpha-beta-gamma-delta", x: 50, y: 650, maxWidth: 60, wordBreaks: ["-"] },
          { op: "drawImage", image: { base64: PNG }, x: 400, y: 600, width: 50, xSkew: 15, blendMode: "Screen" },
          { op: "drawSvg", svg: '<svg width="100" height="40"><text x="0" y="20" font-family="Mono">SVG text</text></svg>', x: 300, y: 100, fonts: { Mono: "Courier" }, fontSize: 14 },
        ],
      }),
    );
    const ex = await json(post("/pdf/extract", { source: out.key, include: ["graphics", "text", "images"], store: false }));
    expect(ex.pages[0].graphics.length).toBeGreaterThanOrEqual(5);
    expect(ex.pages[0].text).toContain("Outlined, spaced and skewed");
    expect(ex.pages[0].text).toContain("delta");
    expect(ex.pages[0].images).toHaveLength(1);
  });

  it("draws a page of another PDF on top of or behind content", async () => {
    const letterhead = await pdf(1, "LETTERHEAD");
    const top = await edit(await pdf(2), [{ op: "drawPdfPage", source: letterhead, scale: 0.5, x: 0, y: 0 }]);
    expect(await pageTexts(top.key)).toEqual(["Page 1\nLETTERHEAD 1", "Page 2\nLETTERHEAD 1"]);

    const behind = await edit(await pdf(2), [
      { op: "drawText", text: "Before", x: 300, y: 300 },
      { op: "drawPdfPage", source: letterhead, behind: true },
      { op: "drawText", text: "After", x: 300, y: 200 },
    ]);
    // Text comes out in paint order: the letterhead first, although it was drawn second.
    expect((await pageTexts(behind.key))[0].replace(/\n+/g, " ")).toBe("LETTERHEAD 1 Page 1 Before After");
  });
});

describe("forms", () => {
  it("creates every field type, then fills them", async () => {
    const created = await json(
      post("/pdf/create", {
        operations: [
          { op: "addFormField", type: "text", name: "fullName", x: 50, y: 100, width: 200, height: 24, origin: "top-left", maxLength: 40, value: "Ada", required: true },
          { op: "addFormField", type: "text", name: "notes", x: 50, y: 140, width: 300, height: 80, origin: "top-left", multiline: true, alignment: "center", fontSize: 10 },
          { op: "addFormField", type: "checkbox", name: "agree", x: 50, y: 240, width: 16, height: 16, origin: "top-left", value: true },
          { op: "addFormField", type: "dropdown", name: "country", x: 50, y: 280, width: 150, height: 24, origin: "top-left", options: ["FR", "UK", "US"], value: "UK", editable: true },
          { op: "addFormField", type: "optionList", name: "tags", x: 50, y: 320, width: 150, height: 60, origin: "top-left", options: ["a", "b", "c"], multiselect: true, value: ["a", "c"] },
          {
            op: "addFormField",
            type: "radio",
            name: "size",
            origin: "top-left",
            choices: [
              { value: "S", x: 50, y: 400, width: 14, height: 14 },
              { value: "M", x: 80, y: 400, width: 14, height: 14 },
            ],
            value: "M",
          },
          { op: "addFormField", type: "button", name: "submit", x: 50, y: 440, width: 80, height: 24, origin: "top-left", label: "Send", backgroundColor: "#ddeeff" },
        ],
      }),
    );
    const before = await info(created.key);
    const byName = Object.fromEntries(before.form.fields.map((f: any) => [f.name, f]));
    expect(byName.fullName).toMatchObject({ type: "text", value: "Ada", settings: { maxLength: 40, required: true } });
    expect(byName.notes.settings).toMatchObject({ multiline: true, alignment: "center" });
    expect(byName.agree.value).toBe(true);
    expect(byName.country).toMatchObject({ value: ["UK"], settings: { editable: true } });
    expect(byName.tags).toMatchObject({ value: ["a", "c"], settings: { multiselect: true } });
    expect(byName.size).toMatchObject({ type: "radio", value: "M", options: ["S", "M"] });
    expect(byName.submit.type).toBe("button");

    const filled = await edit(created.key, [{ op: "fillForm", fields: { fullName: "Grace", size: "S", agree: false } }]);
    expect((await info(filled.key)).form.fields.find((f: any) => f.name === "fullName").value).toBe("Grace");
  });

  it("changes, removes and images fields", async () => {
    const out = await edit({ base64: b64(await formPdf()) }, [
      { op: "setFieldProperties", name: "name", readOnly: true, alignment: "right", maxLength: 10, fontSize: 9 },
      { op: "removeFormFields", names: ["color"] },
      { op: "fillForm", fields: {}, images: { name: { base64: PNG } } },
    ]);
    const { form } = await info(out.key);
    expect(form.fields.map((f: any) => f.name)).toEqual(["name", "agree"]);
    expect(form.fields[0].settings).toMatchObject({ readOnly: true, alignment: "right", maxLength: 10 });

    expect((await fail("/pdf/edit", { source: out.key, operations: [{ op: "setFieldProperties", name: "agree", multiline: true }] })).error).toContain(
      '\\"multiline\\" does not apply to CheckBox field \\"agree\\"',
    );
    expect((await fail("/pdf/edit", { source: out.key, operations: [{ op: "addFormField", type: "text", name: "agree", x: 1, y: 1, width: 9, height: 9 }] })).error).toContain(
      "already exists",
    );
    expect((await fail("/pdf/edit", { source: out.key, operations: [{ op: "setFieldScript", name: "agree", event: "mouseUp", script: "x" }] })).status).toBe(400);
  });
});

describe("scripts, layers, viewer preferences", () => {
  it("adds and lists document JavaScript", async () => {
    const out = await edit(await pdf(), [{ op: "addJavaScript", name: "hello", script: "app.alert('hi');" }]);
    expect(await json(post("/pdf/scripts", { source: out.key }))).toMatchObject({ document: [{ name: "hello", script: "app.alert('hi');" }], xfa: [], fields: [], pages: [] });
    expect((await info(out.key)).hasJavaScript).toBe(true);
    expect((await fail("/pdf/edit", { source: out.key, operations: [{ op: "setXFAJavaScript", field: "f", event: "click", script: "x" }] })).status).toBe(422);
    expect((await edit(out.key, [{ op: "deleteXFA" }])).pageCount).toBe(1);
  });

  it("shows and hides layers", async () => {
    const doc = await PDFDocument.load(await samplePdf(1));
    const ocg = doc.context.register(doc.context.obj({ Type: "OCG", Name: PDFString.of("Draft marks") }));
    doc.catalog.set(PDFName.of("OCProperties"), doc.context.obj({ OCGs: [ocg], D: { ON: [ocg], OFF: [], Order: [ocg] } }));
    const src = { base64: b64(await doc.save()) };
    expect((await info(src)).layers).toEqual([{ name: "Draft marks", visible: true }]);
    const out = await edit(src, [{ op: "setLayerVisibility", layers: [{ name: "Draft marks", visible: false }] }]);
    expect((await info(out.key)).layers).toEqual([{ name: "Draft marks", visible: false }]);
    expect((await fail("/pdf/edit", { source: src, operations: [{ op: "setLayerVisibility", layers: [{ name: "Nope", visible: true }] }] })).error).toContain(
      'No layer named \\"Nope\\"',
    );
  });

  it("sets viewer preferences", async () => {
    const out = await edit(await pdf(5), [
      {
        op: "setViewerPreferences",
        hideToolbar: true,
        fitWindow: true,
        displayDocTitle: true,
        pageMode: "UseOutlines",
        pageLayout: "TwoColumnLeft",
        readingDirection: "R2L",
        printScaling: "None",
        duplex: "DuplexFlipLongEdge",
        printPageRange: "1-2,4",
        numCopies: 2,
      },
    ]);
    expect((await info(out.key)).viewerPreferences).toMatchObject({
      pageMode: "UseOutlines",
      pageLayout: "TwoColumnLeft",
      hideToolbar: true,
      fitWindow: true,
      displayDocTitle: true,
      readingDirection: "R2L",
      printScaling: "None",
      duplex: "DuplexFlipLongEdge",
      printPageRange: [
        { start: 1, end: 2 },
        { start: 4, end: 4 },
      ],
      numCopies: 2,
    });
  });
});

describe("metadata, attachments, extraction, standards", () => {
  it("sets dates and the window title", async () => {
    const out = await edit(await pdf(), [{ op: "setMetadata", title: "Report", showTitleInWindow: true, creationDate: "2020-01-02T03:04:05Z", modificationDate: "2021-01-01T00:00:00Z" }]);
    const i = await info(out.key);
    expect(i.metadata).toMatchObject({ title: "Report", creationDate: "2020-01-02T03:04:05.000Z", modificationDate: "2021-01-01T00:00:00.000Z" });
    expect(i.viewerPreferences.displayDocTitle).toBe(true);
  });

  it("attaches, extracts and detaches files", async () => {
    const out = await edit(await pdf(), [
      { op: "attachFile", file: { base64: btoa("a,b\n1,2") }, name: "data.csv", mimeType: "text/csv", relationship: "Data", creationDate: "2026-01-01T00:00:00Z" },
      { op: "attachFile", file: { base64: btoa("<x/>") }, name: "meta.xml", mimeType: "application/xml" },
    ]);
    expect((await info(out.key)).attachments).toEqual([
      { name: "data.csv", size: 7, mimeType: "text/csv", description: null, relationship: "Data" },
      { name: "meta.xml", size: 4, mimeType: "application/xml", description: null, relationship: null },
    ]);
    const stored = await json(post("/pdf/extract", { source: out.key, include: ["attachments"] }));
    expect(new TextDecoder().decode(await download(stored.attachments[0].url))).toBe("a,b\n1,2");
    const inline = await json(post("/pdf/extract", { source: out.key, include: ["attachments"], store: false }));
    expect(atob(inline.attachments[1].base64)).toBe("<x/>");

    const detached = await edit(out.key, [{ op: "detachFile", name: "data.csv" }]);
    expect((await info(detached.key)).attachments.map((a: any) => a.name)).toEqual(["meta.xml"]);
    expect((await fail("/pdf/edit", { source: out.key, operations: [{ op: "detachFile", name: "nope" }] })).status).toBe(400);
  });

  it("extracts images to R2", async () => {
    const src = await json(post("/pdf/create", { operations: [{ op: "drawImage", image: { base64: PNG }, x: 10, y: 10, width: 100 }] }));
    const ex = await json(post("/pdf/extract", { source: src.key, prefix: "tests/ex/" }));
    expect(ex.pages[0].images[0]).toMatchObject({ mimeType: "image/png", width: 1, height: 1, drawWidth: 100, key: "tests/ex/page-1-image-1.png" });
    expect((await download(ex.pages[0].images[0].url)).subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("converts to PDF/A and keeps copyright", async () => {
    const out = await edit(await pdf(), [
      { op: "setMetadata", title: "Archive", copyright: "© Acme", custom: { MadeFor: "Client X" } },
      { op: "convertToPDFA", conformance: "2B" },
    ]);
    const i = await info(out.key);
    expect(i).toMatchObject({ pdfA: "2B", metadata: { title: "Archive", copyright: "© Acme", custom: { MadeFor: "Client X" } } });
    const xmp = readXmp(await load(out.key))!;
    expect(xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(xmp).toContain("<xmpRights:Marked>True</xmpRights:Marked>");
    expect(xmp).toContain("<pdfx:MadeFor>Client X</pdfx:MadeFor>");
  });

  it("makes a Factur-X e-invoice", async () => {
    const xml = '<?xml version="1.0"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>';
    const out = await edit(await pdf(), [{ op: "embedFacturX", xml: { base64: btoa(xml) }, conformanceLevel: "EN 16931" }]);
    const i = await info(out.key);
    expect(i.pdfA).toBe("3B");
    expect(i.attachments[0]).toMatchObject({ name: "factur-x.xml", mimeType: "text/xml", relationship: "Alternative" });
  });
});

describe("/text/measure", () => {
  it("measures and wraps text", async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const m = await json(post("/text/measure", { text: "Hello world, this is a long line", size: 12, maxWidth: 80 }));
    expect(m.lines.length).toBeGreaterThan(1);
    expect(m.lines.every((l: any) => l.width <= 80)).toBe(true);
    expect(m.lines[0].width).toBeCloseTo(helv.widthOfTextAtSize(m.lines[0].text, 12));
    expect(m.height).toBeCloseTo(helv.heightAtSize(12));

    const fit = await json(post("/text/measure", { text: "A", font: "Times-Bold", fitHeight: 20 }));
    expect(fit.sizeForHeight).toBeGreaterThan(0);
    expect((await fail("/text/measure", { text: "Привет" })).error).toContain("cannot draw");
    expect((await fail("/text/measure", { text: "x", font: "Comic" })).status).toBe(400);
  });
});
