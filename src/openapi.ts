import { z } from "zod";
import { license, version } from "../package.json";
import { SOURCE_KINDS, SOURCE_OBJECT_IDS } from "./schemas";
// Imported for their side effect: every schema with an `id` registers itself.
import "./requests";
import "./replies";

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
const json = (id: string) => ({ "application/json": { schema: ref(id) } });
const binary = { type: "string", format: "binary" } as const;

const DESCRIPTION = `Edit, merge, split, fill, stamp and inspect PDFs. Results are stored in R2 and returned as signed links.

**Workflow that works well:**
1. **Inspect first.** \`POST /pdf/info\` returns pages, sizes, form fields (names, types, choices), layers and attachments.
2. **Act.** \`/pdf/edit\`, \`/pdf/merge\` and \`/pdf/create\` all take an \`operations\` list, run in order, so one request can build, stamp and lock a document.
3. **Verify.** Run \`/pdf/info\` or \`/pdf/text\` on the result's \`key\`.

**Sending files.** Any field typed Source, PdfSource or MergeSource accepts a URL string, an R2 key string, or an object: \`{ "url" }\` (optionally with \`headers\`), \`{ "key" }\`, \`{ "base64" }\`, or \`{ "upload" }\` naming a multipart file. Send files as multipart/form-data with the JSON body in an \`options\` field, or POST a PDF as the raw body with the JSON body URL-encoded in \`?options=\`.

**Getting results.** By default a PDF result is saved to R2 and returned as a PdfResult with a signed \`url\` that works without the API key until \`expiresAt\`. \`output.return: "pdf"\` returns the bytes instead. The API's own result links can be passed back in as sources.

**Things that trip people up:**
- Coordinates are PDF points (72 per inch) from the **bottom-left** corner. Add \`"origin": "top-left"\` to measure y down from the top.
- Pages are **1-based**; negative numbers count from the end.
- Built-in fonts cover Latin text only. Pass a font file for other scripts; text a font cannot draw is rejected (400), never replaced with "?".
- Some sites block requests from Cloudflare Workers (403 from the source URL). Send those files as uploads or base64.
- Opening a PDF with \`password\` saves the result **without** a password; add an \`encrypt\` operation to lock it again.
- Run \`setMetadata\` before \`convertToPDFA\`.
- Errors are JSON (ErrorResponse) and name the failing input, e.g. \`operations[2] (removePages): Page 9 is out of range\`.`;

/** Request body accepted by endpoints that read uploaded files. */
function body(requestId: string, opts: { rawPdf: boolean }) {
  return {
    required: true,
    content: {
      ...json(requestId),
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { options: { type: "string", description: `The ${requestId} as JSON. Files in this request are used with { "upload": "<field or file name>" }.` } },
          additionalProperties: { ...binary, description: "A file. Field names may repeat; repeated ones are addressed as name[0], name[1], …" },
        },
        encoding: { options: { contentType: "application/json" } },
      },
      ...(opts.rawPdf ? { "application/pdf": { schema: { ...binary, description: "The PDF itself, used as the source. Put the rest of the request in ?options=." } } } : {}),
    },
  };
}

const optionsParam = {
  name: "options",
  in: "query",
  required: false,
  description: "With a raw PDF body: the rest of the request as JSON, URL-encoded.",
  schema: { type: "string" },
};

const error = (description: string) => ({ description, content: json("ErrorResponse") });
const errors = {
  "400": error("Invalid request: bad JSON or fields (see details), a page out of range, an unknown form field, a font missing characters."),
  "401": error("Missing or wrong API key."),
  "404": error("No file at an R2 key used as a source."),
  "413": error("A URL source is larger than the MAX_FETCH_BYTES setting."),
  "422": error("Not a PDF, a damaged PDF, a wrong or missing password, or an operation the PDF cannot support."),
  "500": error("API_KEY is not set, or an unexpected error."),
  "502": error("A URL source returned an error or could not be reached."),
  "504": error("A URL source timed out."),
};

const pdfReply = {
  "200": {
    description: 'The PDF: a PdfResult (JSON), or the bytes with output.return "pdf".',
    headers: {
      "X-Page-Count": { description: 'With output.return "pdf": number of pages.', schema: { type: "integer" } },
      "X-File-Key": { description: 'With output.return "pdf" and storing: the R2 key.', schema: { type: "string" } },
      "X-File-Url": { description: 'With output.return "pdf" and storing: the signed download link.', schema: { type: "string" } },
    },
    content: { ...json("PdfResult"), "application/pdf": { schema: binary } },
  },
};

function post(operationId: string, tag: string, summary: string, requestId: string, reply: object, opts: { rawPdf: boolean }) {
  return {
    post: {
      operationId,
      tags: [tag],
      summary,
      ...(opts.rawPdf ? { parameters: [optionsParam] } : {}),
      requestBody: body(requestId, opts),
      responses: { ...reply, ...errors },
    },
  };
}
const ok = (id: string, description = "Success.") => ({ "200": { description, content: json(id) } });

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

/**
 * Rewrites a source object ({ key?, url?, base64?, upload?, …options }) as one
 * variant per kind, so generated clients get a union that enforces "exactly one".
 */
function sourceVariants(schema: JsonSchema): JsonSchema {
  const { properties = {}, required = [], type: _type, ...rest } = schema;
  const kinds: readonly string[] = SOURCE_KINDS;
  const options = Object.fromEntries(Object.entries(properties).filter(([k]) => !kinds.includes(k) && k !== "headers"));
  return {
    ...rest,
    oneOf: SOURCE_KINDS.map((kind) => ({
      type: "object",
      properties: {
        [kind]: properties[kind],
        ...(kind === "url" ? { headers: properties.headers } : { headers: false }),
        // Name the other kinds as forbidden, so generated types reject mixing them (e.g. `url?: never`).
        ...Object.fromEntries(SOURCE_KINDS.filter((k) => k !== kind).map((k) => [k, false])),
        ...options,
      },
      required: [kind, ...required],
      additionalProperties: false,
    })),
  };
}

/** Component schemas from zod. Their $schema/$id lines are dropped; OpenAPI supplies the dialect. */
function components() {
  const { schemas } = z.toJSONSchema(z.globalRegistry, { io: "input", uri: (id) => `#/components/schemas/${id}` });
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _s, $id: _i, ...schema }]) => [id, SOURCE_OBJECT_IDS.has(id) ? sourceVariants(schema as JsonSchema) : schema]),
  );
}

const download = (method: "get" | "head") => ({
  operationId: method === "get" ? "downloadFile" : "checkFile",
  tags: ["Files"],
  summary: method === "get" ? "Download a stored result" : "Check a stored result without downloading it",
  description: "Use the signed `url` from a response (no API key needed until it expires), or send the API key with just the path.",
  security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
  parameters: [
    {
      name: "key",
      in: "path",
      required: true,
      description: 'The R2 key, slashes included (e.g. "outputs/abc.pdf"). "%2F" is accepted for "/".',
      schema: { type: "string" },
    },
    { name: "expires", in: "query", required: false, description: "Signed links: expiry, as Unix seconds.", schema: { type: "integer" } },
    { name: "sig", in: "query", required: false, description: "Signed links: signature.", schema: { type: "string" } },
    { name: "download", in: "query", required: false, allowEmptyValue: true, description: "Present: ask the browser to save the file.", schema: { type: "string" } },
    { name: "Range", in: "header", required: false, description: 'Part of the file, e.g. "bytes=0-1023".', schema: { type: "string" } },
  ],
  responses: {
    "200": { description: "The file.", content: { "application/octet-stream": { schema: binary } } },
    "206": { description: "Part of the file (Range request)." },
    "304": { description: "Not modified (If-None-Match / If-Modified-Since)." },
    "401": error("No signature and no valid API key."),
    "403": error("Signed link invalid or expired."),
    "404": error("No file at this key."),
  },
});

/**
 * The API's OpenAPI 3.1 document. `servers` is a placeholder for your own
 * deployment; GET /openapi.json replaces it with the address it was fetched from.
 */
export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "pdf-lib-workers", version, description: DESCRIPTION, license: { name: license, identifier: license } },
    servers: [
      {
        url: "https://pdf-lib-workers.{subdomain}.workers.dev",
        description: "Your deployment; a custom domain works the same way. GET /openapi.json on a deployment lists its real address here.",
        variables: { subdomain: { default: "your-subdomain", description: "Your workers.dev subdomain." } },
      },
    ],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "Build", description: "Make new PDFs or change existing ones." },
      { name: "Inspect", description: "Read what is inside a PDF." },
      { name: "Files", description: "Stored results." },
      { name: "Utilities", description: "Text measuring, the endpoint list and this document." },
    ],
    paths: {
      "/": {
        get: {
          operationId: "index",
          tags: ["Utilities"],
          summary: "List endpoints and operations",
          security: [{}],
          responses: { "200": { description: "A short overview, with a link to this document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "openapi",
          tags: ["Utilities"],
          summary: "This document",
          security: [{}],
          responses: { "200": { description: "The OpenAPI document.", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/files/{key}": { get: download("get"), head: download("head") },
      "/pdf/info": post("getInfo", "Inspect", "Pages, boxes, metadata, form fields, layers, viewer preferences, attachments", "InfoRequest", {
        "200": {
          description: "An InfoResponse, or a LockedInfoResponse for an encrypted PDF sent without its password.",
          content: { "application/json": { schema: { oneOf: [ref("InfoResponse"), ref("LockedInfoResponse")] } } },
        },
      }, { rawPdf: true }),
      "/pdf/text": post("getText", "Inspect", "Text per page", "TextRequest", ok("TextResponse"), { rawPdf: true }),
      "/pdf/extract": post("extract", "Inspect", "Images, vector graphics, text and attachments", "ExtractRequest", ok("ExtractResponse"), { rawPdf: true }),
      "/pdf/scripts": post("getScripts", "Inspect", "Document, form field, page and XFA JavaScript", "ScriptsRequest", ok("ScriptsResponse"), { rawPdf: true }),
      "/pdf/create": post("createPdf", "Build", "Make a new PDF", "CreateRequest", pdfReply, { rawPdf: false }),
      "/pdf/edit": post("editPdf", "Build", "Run operations on a PDF", "EditRequest", pdfReply, { rawPdf: true }),
      "/pdf/merge": post("mergePdfs", "Build", "Join PDFs and images, then run operations", "MergeRequest", pdfReply, { rawPdf: false }),
      "/pdf/split": post("splitPdf", "Build", "Split a PDF into parts saved in R2", "SplitRequest", ok("SplitResponse"), { rawPdf: true }),
      "/text/measure": post("measureText", "Utilities", "Width, height and line breaks of text in a font", "MeasureRequest", ok("MeasureResponse"), { rawPdf: false }),
    },
    components: {
      schemas: components(),
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Authorization: Bearer <API_KEY>" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
  };
}
