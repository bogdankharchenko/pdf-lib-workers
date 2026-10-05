import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import app from "../src/index";
import { openApiDocument } from "../src/openapi";
import {
  ErrorResponse,
  ExtractResponse,
  InfoResponse,
  LockedInfoResponse,
  MeasureResponse,
  PdfResult,
  ScriptsResponse,
  SplitResponse,
  TextResponse,
} from "../src/replies";
import { BASE, PNG, b64, call, formPdf, json, post, samplePdf, worker } from "./helpers";

/**
 * Parsing strips fields a schema doesn't declare, so a response with an
 * undocumented field no longer equals its parsed self.
 */
function expectDocumented(schema: z.ZodType, body: unknown) {
  expect(schema.parse(body)).toEqual(body);
}

async function errorBody(res: Response | Promise<Response>, status: number): Promise<z.infer<typeof ErrorResponse>> {
  const r = await res;
  expect(r.status).toBe(status);
  const body = await r.json();
  expectDocumented(ErrorResponse, body);
  return body as z.infer<typeof ErrorResponse>;
}

describe("openapi.json", () => {
  it("matches the committed openapi.json", async () => {
    // After changing a schema or route, run `npm run openapi` to update the file.
    await expect(JSON.stringify(openApiDocument(), null, 2) + "\n").toMatchFileSnapshot("../openapi.json");
  });

  it("is served without a key, with this deployment's address", async () => {
    const res = await worker.fetch(new Request(BASE + "/openapi.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...openApiDocument(), servers: [{ url: BASE, description: "This deployment." }] });
  });

  it("documents every route, and only real ones", async () => {
    const spec = await json(worker.fetch(new Request(BASE + "/openapi.json")));
    const documented = Object.entries(spec.paths as Record<string, object>).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const served = app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace("/files/*", "/files/{key}")}`);
    expect([...new Set(served)].sort()).toEqual(documented.sort());
  });

  it("names every operation and maps each op value to it", async () => {
    const spec = await json(worker.fetch(new Request(BASE + "/openapi.json")));
    const { oneOf, discriminator } = spec.components.schemas.Operation;
    expect(Object.values(discriminator.mapping).sort()).toEqual(oneOf.map((o: { $ref: string }) => o.$ref).sort());
    for (const [op, target] of Object.entries(discriminator.mapping as Record<string, string>)) {
      const schema = spec.components.schemas[target.split("/").pop()!];
      expect(schema.properties.op.const).toBe(op);
      expect(schema.description).toBeTruthy();
    }
  });
});

describe("responses match their schemas", () => {
  it("info, including a locked PDF", async () => {
    const out = await json(
      post("/pdf/edit", {
        source: { base64: b64(await formPdf()) },
        operations: [
          { op: "setMetadata", title: "T", copyright: "© X", custom: { MadeFor: "Y" } },
          { op: "attachFile", file: { base64: btoa("a") }, name: "a.txt", relationship: "Data" },
          { op: "setViewerPreferences", printPageRange: "1", duplex: "Simplex" },
        ],
      }),
    );
    expectDocumented(InfoResponse, await json(post("/pdf/info", { source: out.key })));
    expectDocumented(InfoResponse, await json(post("/pdf/info", { source: { base64: b64(await samplePdf(1)) } })));

    const locked = await json(post("/pdf/edit", { source: out.key, operations: [{ op: "encrypt", ownerPassword: "o", userPassword: "u" }] }));
    expectDocumented(LockedInfoResponse, await json(post("/pdf/info", { source: locked.key })));
  });

  it("text, with and without items", async () => {
    const source = { base64: b64(await samplePdf(2)) };
    expectDocumented(TextResponse, await json(post("/pdf/text", { source })));
    expectDocumented(TextResponse, await json(post("/pdf/text", { source, items: true })));
  });

  it("extract, stored and inline", async () => {
    const src = await json(
      post("/pdf/create", {
        operations: [
          { op: "drawImage", image: { base64: PNG }, x: 10, y: 10, width: 50 },
          { op: "drawRectangle", x: 100, y: 100, width: 50, height: 50, color: "#f00" },
          { op: "drawText", text: "Hi", x: 10, y: 200 },
          { op: "attachFile", file: { base64: btoa("a") }, name: "a.txt" },
        ],
      }),
    );
    const include = ["images", "graphics", "text", "attachments"];
    expectDocumented(ExtractResponse, await json(post("/pdf/extract", { source: src.key, include })));
    expectDocumented(ExtractResponse, await json(post("/pdf/extract", { source: src.key, include, store: false })));
    expectDocumented(ExtractResponse, await json(post("/pdf/extract", { source: src.key, include: ["text"] })));
  });

  it("scripts, measure, split and PDF results", async () => {
    const withJs = await json(post("/pdf/edit", { source: { base64: b64(await samplePdf(3)) }, operations: [{ op: "addJavaScript", name: "a", script: "1;" }] }));
    expectDocumented(PdfResult, withJs);
    expectDocumented(ScriptsResponse, await json(post("/pdf/scripts", { source: withJs.key })));
    expectDocumented(SplitResponse, await json(post("/pdf/split", { source: withJs.key, every: 2 })));
    expectDocumented(PdfResult, await json(post("/pdf/create", { output: { store: false } })));
    expectDocumented(MeasureResponse, await json(post("/text/measure", { text: "a b c", maxWidth: 10 })));
    expectDocumented(MeasureResponse, await json(post("/text/measure", { text: "a", fitHeight: 20 })));
  });

  describe("errors", () => {
    afterEach(() => vi.restoreAllMocks());

    it("use ErrorResponse for every status", async () => {
      const invalid = await errorBody(post("/pdf/edit", { operations: [{ op: "nope" }] }), 400);
      expect(invalid.details?.length).toBeGreaterThan(0);
      await errorBody(post("/pdf/edit", { source: { base64: b64(await samplePdf(1)) }, operations: [{ op: "removePages", pages: [9] }] }), 400);
      await errorBody(worker.fetch(new Request(BASE + "/pdf/info", { method: "POST" })), 401);
      await errorBody(worker.fetch(new Request(BASE + "/files/x.pdf?expires=1&sig=x")), 403);
      await errorBody(post("/pdf/info", { source: "missing/key.pdf" }), 404);
      await errorBody(call("/no/such/route"), 404);
      await errorBody(post("/pdf/info", { source: { base64: btoa("not a pdf") } }), 422);

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new Request(input as RequestInfo).url;
        if (url.endsWith("/slow.pdf")) throw new DOMException("timed out", "TimeoutError");
        if (url.endsWith("/huge.pdf")) return new Response(new Uint8Array(1_500_000));
        return new Response("gone", { status: 410 });
      });
      await errorBody(post("/pdf/info", { source: "https://files.test/gone.pdf" }), 502);
      await errorBody(post("/pdf/info", { source: "https://files.test/slow.pdf" }), 504);
      await errorBody(post("/pdf/info", { source: "https://files.test/huge.pdf" }), 413);
    });
  });
});

describe("downloads by key", () => {
  it("accept %2F for the slashes in a key, as generated clients send it", async () => {
    const out = await json(post("/pdf/create", { output: { key: "tests/encoded/a.pdf" } }));
    const res = await call("/files/tests%2Fencoded%2Fa.pdf");
    expect(res.status).toBe(200);
    expect((await PDFDocument.load(await res.arrayBuffer())).getPageCount()).toBe(out.pageCount);
  });
});
