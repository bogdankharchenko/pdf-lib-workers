# pdfmill

A Cloudflare Worker that edits PDFs with [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib) and stores the results in a private R2 bucket. You send PDFs (and images, fonts) as URLs or file data; you get back a download link or the PDF itself, or have it uploaded to your own storage.

- [What you can do](#what-you-can-do) · [AI agents and client code](#ai-agents-and-client-code)
- [Setup](#setup) · [Auth and access](#auth-and-access) · [Configuration](#configuration)
- [Sending files](#sending-files) · [Getting results back](#getting-results-back)
- [Endpoints](#endpoints) · [Operations](#operations) · [Metadata](#metadata-who-where-copyright)
- [Errors](#errors) · [Examples](#examples) · [Limits and what it can't do](#limits-and-what-it-cant-do) · [License](#license)

## What you can do

| Task | How |
| --- | --- |
| **Stitch** PDFs together, whole or chosen pages | `POST /pdf/merge` with `sources` (each may take `pages`) |
| Turn **photos/scans (JPG, PNG)** into PDF pages, or mix them with PDFs | `POST /pdf/merge` — images become pages, fitted to A4/Letter/any size, upright per EXIF |
| **Split** a PDF into parts (every N pages, or ranges) | `POST /pdf/split` |
| **Extract**, **reorder**, **reverse** or **repeat** pages | `selectPages` |
| **Delete**, **add** blank, **duplicate**, **insert** pages (from another PDF or an image) | `removePages`, `addPage`, `duplicatePage`, `insertPdf` |
| **Rotate**, **resize** (e.g. Letter → A4), **crop**, **scale** pages or **shift** their content | `rotatePages`, `resizePages`, `cropPages`, `scalePages`, `translateContent` |
| Set print-production **page boxes** (bleed, trim, art) | `setPageBoxes` |
| **Watermark** with text ("DRAFT", "CONFIDENTIAL") or a **logo** | `watermark` — centred or in a corner, any angle and opacity |
| Add **page numbers** ("Page 3 of 10") | `pageNumbers` |
| **Stamp** text, images, signatures, boxes, circles, lines, SVG anywhere | `drawText`, `drawImage`, `drawRectangle`, `drawEllipse`, `drawLine`, `drawSvgPath`, `drawSvg` |
| Styled text: **outlined**, **letter-spaced**, **skewed**, blend modes | `drawText` options |
| Put a **letterhead** or **background** behind every page, or place another PDF's page anywhere (stamps, several pages on one sheet) | `drawPdfPage` (`behind: true` for backgrounds) |
| **Fill a form** (text, checkboxes, dropdowns, radios), optionally **flatten** it | `fillForm`, `flattenForm`; list the fields first with `POST /pdf/info` |
| Fill a PDF **without form fields** (e.g. a scanned form) | `drawText` at coordinates |
| **Create forms**: text boxes, checkboxes, dropdowns, lists, radio buttons, buttons | `addFormField` |
| **Change fields** (read-only, required, max length, alignment, font size…), put an **image in a field**, **remove fields** | `setFieldProperties`, `fillForm` `images`, `removeFormFields` |
| Read and change **JavaScript** (document, form field, XFA), remove **XFA** | `POST /pdf/scripts`, `addJavaScript`, `setFieldScript`, `setXFAJavaScript`, `deleteXFA` |
| Write **non-Latin text** (Cyrillic, Greek, CJK, …) | pass a TTF/OTF `font` to any text step |
| Record **copyright**, **author**, **who it's for**, **where it came from**, any custom field | `setMetadata` (Info and XMP, read by Acrobat) |
| **Password-protect** and restrict printing/copying/editing | `encrypt` |
| **Open** password-protected PDFs, or **remove the password** | `"password"` on the source; the result is saved unlocked |
| **Attach**, **extract** or **remove** files inside the PDF (CSV, XML, …) | `attachFile`, `POST /pdf/extract`, `detachFile` |
| **Extract images** and **vector graphics** (as SVG) from pages | `POST /pdf/extract` |
| Show or hide **layers** (optional content) | `setLayerVisibility` |
| Control how viewers **open** the PDF (layout, full screen, title bar, print dialog defaults) | `setViewerPreferences` |
| Make **PDF/A** archive files (1B–3U) | `convertToPDFA` |
| Make **Factur-X / ZUGFeRD e-invoices** | `embedFacturX` |
| **Edit signed PDFs** without breaking signatures (append-only save) | `POST /pdf/edit` with `incremental: true` |
| **Measure text** (width, wrapping, size to fit) before laying it out | `POST /text/measure` |
| **Create** a PDF from scratch | `POST /pdf/create` plus drawing steps |
| **Read** page count, sizes, boxes, metadata, form fields, layers, viewer settings, attachments, PDF/A level | `POST /pdf/info` |
| **Extract text** (per page, optionally with positions and fonts) | `POST /pdf/text` |
| **Chain** calls: feed one result into the next | pass the returned `key` or `url` as a source |
| Get the result as a **link**, the **raw PDF**, or **base64** | JSON by default; `Accept: application/pdf` for the bytes; `output.store: false` for base64 |
| **Upload** the result to your own storage (e.g. an S3 presigned URL) | `output.put` |
| Write PDFs **old tools** can read (classic cross-reference table) | `output.useObjectStreams: false` |

Every PDF-producing endpoint (`create`, `edit`, `merge`) takes the same `operations` list, run in order, so one request can stitch, watermark, number, tag and lock a document.

## AI agents and client code

Write clients from the OpenAPI 3.1 spec rather than from this page. It covers every endpoint, request and response, with a description on each field.

- **Where:** `GET /openapi.json` on a deployment (no API key; `servers` lists that deployment's address), or [`openapi.json`](openapi.json) in this repo.
- **Always current:** it's generated from the same schemas that validate requests, and the tests fail if the committed file is out of date or if any response has a field the spec doesn't list.
- **Valid:** CI lints it with Spectral; it also passes Redocly and Swagger Editor's validator.
- **TypeScript types:** `npx openapi-typescript https://<your-deployment>/openapi.json --default-non-nullable false -o pdf-api.d.ts`. Without that flag, fields that have defaults come out as required.
- **Names to look for:** each request is `<Name>Request` (e.g. `MergeRequest`) and each operation is `<Op>Operation` (e.g. `WatermarkOperation`). `Operation` is a union keyed on `op`. Sources are `Source`, `PdfSource` or `MergeSource`: a shortcut string, or an object with exactly one of `key`, `url`, `base64` or `upload`.

A workflow that works well:

1. **Inspect** with `POST /pdf/info`: pages and sizes, form field names, types and choices, layers, attachments.
2. **Act** with `/pdf/edit`, `/pdf/merge` or `/pdf/create`. One `operations` list, run in order, can build, stamp, fill and lock a document.
3. **Verify** with `/pdf/info` or `/pdf/text` on the result's `key`.

Things that trip people (and agents) up:

- Coordinates are points (72 per inch) from the **bottom-left** corner, unless you add `"origin": "top-left"`.
- Pages are **1-based**; negative numbers count from the end.
- Built-in fonts cover Latin text only. Other scripts need a font file; text a font can't draw is rejected with a 400, never replaced with `?`.
- Some sites refuse requests from Cloudflare Workers (the source URL answers 403). Send those files as uploads or base64.
- Opening a PDF with `password` saves the result **without** one; add `encrypt` to lock it again.
- Run `setMetadata` before `convertToPDFA`.
- Errors name the failing input, e.g. `sources[1]: …` or `operations[2] (removePages): …`.

## Setup

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create pdfmill
npx wrangler secret put API_KEY        # any long random string
npx wrangler deploy

# Delete generated files after 7 days
npx wrangler r2 bucket lifecycle add pdfmill expire-outputs outputs/ --expire-days 7
npx wrangler r2 bucket lifecycle add pdfmill expire-extracted extracted/ --expire-days 7
```

The two expiry rules cover where the API saves results by default: `outputs/` (`create`, `edit`, `merge`, `split`) and `extracted/` (`/pdf/extract`). Seven days matches the longest download link (`linkTtl` max), so a link and its file go away together. Files saved under a key or prefix you choose (e.g. `output.key: "invoices/42.pdf"`) and files you put in R2 yourself (templates, fonts) are kept. Check the rules with `npx wrangler r2 bucket lifecycle list pdfmill`; R2 deletes expired files within about a day of their expiry.

Optional: `npx wrangler secret put SIGNING_KEY` — a separate key for download links (defaults to `API_KEY`). Changing it voids all links already handed out.

Local dev: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`. Tests: `npm test`. After changing a schema or route, run `npm run openapi` to regenerate `openapi.json`; `npm test` fails until you do. `npm run lint:openapi` checks the spec with Spectral. CI runs the typecheck, the tests, the spec check and a build of the Worker on every pull request and push to `main`.

## Auth and access

- Send `Authorization: Bearer <API_KEY>` (or `X-API-Key: <API_KEY>`) on every call except `GET /`.
- The key gives full access: anyone holding it can run every endpoint and download any file in the bucket by key. Keep it on servers, never in browser or app code.
- Download links returned by the API carry their own signature (`?expires=…&sig=…`). A link opens only its own file, only until it expires (default 1 hour via `SIGNED_URL_TTL`; up to 7 days per request with `output.linkTtl`). Editing the key or expiry in the link breaks it. Rotating `SIGNING_KEY` voids every link.
- The R2 bucket is private; files are only reachable through the Worker.
- CORS is open (`*`), so browsers can call the API, but only with the key, so do that only from trusted internal tools.

There are no upload, list or delete endpoints. Send inputs with each request. To keep reusable files in R2 (templates, fonts, logos) and refer to them by `key`, add them with the Cloudflare dashboard or `npx wrangler r2 object put pdfmill/<key> --file <path> --remote`. Generated results are removed by the expiry rules in [Setup](#setup).

## Configuration

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `API_KEY` | secret | — (required) | Bearer token for every call |
| `SIGNING_KEY` | secret | `API_KEY` | HMAC key for download links |
| `SIGNED_URL_TTL` | var | `3600` | Default link lifetime, seconds |
| `MAX_FETCH_BYTES` | var | `52428800` (50 MB) | Largest file fetched from a URL source |
| `FETCH_TIMEOUT_MS` | var | `30000` | Time limit per URL fetch, and for the `output.put` upload |
| `limits.cpu_ms` | wrangler | `300000` (5 min) | CPU time per request (paid plan) |

Vars live in `wrangler.jsonc`; secrets are set with `wrangler secret put`.

## Sending files

Anywhere the API takes a file (PDF, image, font, attachment), give it one of:

| Shape | Meaning |
| --- | --- |
| `"https://…"` or `{ "url": "https://…" }` | The Worker downloads it. Add `"headers": { "authorization": "…" }` for private URLs. |
| `"uploads/a.pdf"` or `{ "key": "uploads/a.pdf" }` | An object in the R2 bucket |
| `"data:application/pdf;base64,…"` or `{ "base64": "JVBERi0…" }` | The bytes inline |
| `{ "upload": "a" }` | A file sent in the same multipart request, by field name or file name |

- PDF sources also take `"password"` for encrypted files (the result is saved without a password unless you add `encrypt`), and `"preserveXFA": true` to keep XFA form data, which form operations otherwise drop.
- Merge sources also take `"pages"`, and, for images, `"size"` and `"margin"`.
- **Images:** a PNG or JPEG works wherever a PDF source does in `/pdf/merge` and `insertPdf`, and becomes one page. It is fitted on A4 (turned landscape when wide), or set `"size": "Letter"`, `[w, h]` or `"image"` (page = image size, 1 px = 1 pt), plus `"margin"` in points. Phone photos are turned upright using their EXIF orientation.
- Font fields need the object form, since a bare string there is a font name. Font files may be TTF, OTF, or a `.ttc`/`.dfont` collection with `"postscriptName"` naming the face.
- URL downloads follow redirects and stop after `FETCH_TIMEOUT_MS` or `MAX_FETCH_BYTES`. Errors name the bad input, e.g. `sources[1]: https://… returned HTTP 404` or `Not a PDF (starts with "<!DOCTYPE html>…")`.
- Links this API returned are read straight from R2, so outputs can feed later calls.

Send file data in any of three ways:

- **Multipart** — files as fields, plus an `options` field holding the JSON body. Field names may repeat (`files`, `files`, …); refer to those as `files[0]`, `files[1]`, or by file name.
- **Raw body** — the PDF itself (`Content-Type: application/pdf`, or none), with the JSON body URL-encoded in `?options=`.
- **JSON** — with `url`, `key` or `base64` sources.

If you leave out `source`, the single uploaded file (or the one in field `file`) is used. If `/pdf/merge` gets no `sources`, it merges every uploaded PDF and image in the order sent, skipping files the operations use (such as a watermark logo).

## Getting results back

`create`, `edit` and `merge` reply with JSON, or with the PDF itself when you send `Accept: application/pdf`. JSON is used when there's no Accept header, for `*/*` and for browsers' Accept headers; otherwise the type with the higher `q` wins, and at equal quality the first listed. Errors are always JSON. The replies carry `Vary: Accept`.

They also take an optional `output`:

```json
{ "key": "invoices/42.pdf", "filename": "invoice.pdf", "store": true, "linkTtl": 3600 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `key` | `outputs/<uuid>.pdf` | Where to save in R2 (overwrites an existing file). Files under `outputs/` and `extracted/` are deleted after 7 days; keys elsewhere are kept |
| `filename` | `document.pdf` | Name offered when the PDF is opened or saved |
| `store` | `true` | Save to R2. With `false`, a JSON reply carries the PDF as `base64`. |
| `linkTtl` | `SIGNED_URL_TTL` | Link lifetime in seconds, up to 604800 (7 days) |
| `put` | — | `{ "url", "headers"? }`: upload the PDF here instead of saving it to R2. See below |
| `useObjectStreams` | `true` | `false` writes a classic cross-reference table (larger file, readable by old tools) |

JSON reply:

```json
{ "key": "invoices/42.pdf", "url": "https://…/files/invoices/42.pdf?expires=…&sig=…",
  "expiresAt": "2026-10-05T02:00:00.000Z", "size": 25400, "pageCount": 6 }
```

With `Accept: application/pdf`, the headers `X-Page-Count`, and when stored `X-File-Key` and `X-File-Url`, describe the result:

```sh
curl -s -H "$H" -H 'Content-Type: application/json' -H 'Accept: application/pdf' "$API/pdf/create" -d '{}' -o new.pdf -D -
```

To have the result land in your own storage, never in R2 or in the response, give `output.put` a URL the Worker can `PUT` to, such as an S3 presigned upload URL:

```json
{ "sources": ["https://…/a.pdf", "https://…/b.pdf"],
  "output": { "put": { "url": "https://my-bucket.s3.amazonaws.com/reports/42.pdf?X-Amz-Signature=…" } } }
```

The upload is sent with `Content-Type: application/pdf`, plus `Content-Disposition` when `filename` is set, plus any `headers` you give (such as ones the URL was signed with; `Host` and `Content-Length` are ignored). Redirects are not followed. The reply is JSON with only `size` and `pageCount`, and `key`, `linkTtl` and `Accept: application/pdf` are rejected alongside `put`. If the upload fails (502) or times out (504), the error names the URL without its query string, so the signature is not repeated.

Download a stored result with `GET /files/<key>` (with the key) or its signed `url` (without). Supports `Range` requests (for PDF viewers) and `If-None-Match`; add `?download` to force a save dialog.

## Endpoints

| Method & path | Body | Does |
| --- | --- | --- |
| `GET /` | | Lists endpoints and operations (no auth) |
| `GET /openapi.json` | | The OpenAPI 3.1 spec (no auth) |
| `GET /files/<key>` | | Download a result |
| `POST /pdf/info` | `{ source }` | Everything about a PDF except its content |
| `POST /pdf/text` | `{ source, pages?, items? }` | Text per page |
| `POST /pdf/extract` | `{ source, pages?, include?, store? (true), prefix?, linkTtl? }` | Images, vector graphics, text, attachments |
| `POST /pdf/scripts` | `{ source }` | Document, form field, page and XFA JavaScript |
| `POST /pdf/create` | `{ size? ("A4"), pageCount? (1, max 1000), operations?, output? }` | New PDF |
| `POST /pdf/edit` | `{ source, operations, incremental? (false), output? }` | Run operations on a PDF |
| `POST /pdf/merge` | `{ sources (max 200), operations?, output? }` | Join PDFs and images, then run operations |
| `POST /pdf/split` | `{ source, ranges? \| every? (1), prefix?, linkTtl? }` | One R2 file per part |
| `POST /text/measure` | `{ text, font? ("Helvetica"), size? (12), maxWidth?, wordBreaks?, lineHeight?, fitHeight? }` | Text width, height, wrapped lines |

`incremental: true` keeps the original file byte-for-byte and appends the changes, so existing digital signatures stay valid (viewers then show the changes as made after signing).

`create` with `pageCount: 0` starts empty; add pages with `addPage`. A request may hold up to 500 operations.

### `/pdf/info` reply

```json
{ "pageCount": 2, "encrypted": false, "pdfA": "3B", "hasJavaScript": false,
  "metadata": { "title": "Q3 report", "author": "Acme", "subject": null, "keywords": null,
                "creator": null, "producer": "…", "language": null,
                "creationDate": "…", "modificationDate": "…",
                "copyright": "© 2026 Acme", "copyrightUrl": null, "custom": { "MadeFor": "Client X" } },
  "pages": [{ "page": 1, "width": 612, "height": 792, "rotation": 0,
              "boxes": { "mediaBox": { "x": 0, "y": 0, "width": 612, "height": 792 }, "cropBox": {…}, "bleedBox": {…}, "trimBox": {…}, "artBox": {…} } }],
  "form": {
    "hasXFA": false,
    "fields": [
      { "name": "name", "type": "text", "value": "Ada",
        "settings": { "readOnly": false, "required": true, "exported": true, "multiline": false, "maxLength": 40, "alignment": "left", "password": false, "comb": false } },
      { "name": "agree", "type": "checkbox", "value": true, "settings": { "checked": true, … } },
      { "name": "color", "type": "dropdown", "value": ["green"], "options": ["red", "green"], "settings": { "editable": false, "multiselect": false, "sort": false, … } } ],
    "signatureFields": [{ "name": "Signature1", "source": "acroform" }] },
  "layers": [{ "name": "Draft marks", "visible": true }],
  "viewerPreferences": { "pageMode": "UseOutlines", "pageLayout": null, "displayDocTitle": true, "duplex": null, "printPageRange": [], "numCopies": 1, … },
  "attachments": [{ "name": "data.csv", "size": 120, "mimeType": "text/csv", "description": null, "relationship": "Data" }] }
```

Field types: `text`, `checkbox`, `dropdown`, `optionList`, `radio`, `button`, `signature`. Signature fields are listed but can't be filled or signed.

A locked PDF sent without its password returns only `{ "pageCount", "encrypted": true, "needsPassword": true, "pages" }`.

### `/pdf/text` reply

```json
{ "pages": [{ "page": 1, "text": "Invoice 42\nTotal: $90",
              "items": [{ "text": "Invoice 42", "x": 50, "y": 700, "fontSize": 24, "fontFamily": "Helvetica" }] }] }
```

`items` appears only with `"items": true`. Text is joined in drawing order with a new line when the baseline moves, so complex layouts (columns, tables) may come out interleaved. Scanned pages have no text (no OCR).

### `/pdf/split` reply

```json
{ "parts": [{ "key": "outputs/<uuid>/part-001.pdf", "pages": [1, 2], "size": 1400, "url": "…", "expiresAt": "…" }] }
```

`ranges` gives one part per entry (`["1-3", "4-last"]`, `["odd", "even"]`); otherwise parts of `every` pages. Up to 1000 parts.

### `/pdf/extract` reply

```json
{ "pages": [{ "page": 1,
              "text": "…",
              "images": [{ "mimeType": "image/png", "width": 800, "height": 600, "x": 50, "y": 400, "drawWidth": 200, "drawHeight": 150,
                           "key": "extracted/<uuid>/page-1-image-1.png", "url": "…", "expiresAt": "…" }],
              "graphics": [{ "x": 40, "y": 300, "width": 200, "height": 80, "svg": "<svg …>…</svg>" }] }],
  "attachments": [{ "name": "data.csv", "mimeType": "text/csv", "description": null, "size": 120, "key": "…", "url": "…", "expiresAt": "…" }] }
```

`include` picks any of `images`, `graphics`, `text`, `attachments` (default: images and attachments). Files go to R2 under `prefix` (default `extracted/<uuid>/`), or come back as `base64` with `"store": false`. Images come out as PNG or JPEG; vector graphics are approximated as SVG.

### `/pdf/scripts` reply

```json
{ "document": [{ "name": "init", "script": "…" }],
  "fields": [{ "field": "total", "event": "calculate", "script": "…" }],
  "pages": [{ "page": 1, "event": "pageOpen", "script": "…" }],
  "xfa": [{ "field": "ImportButton", "event": "event__click", "script": "…" }] }
```

### `/text/measure` reply

```json
{ "width": 152.3, "height": 13.9, "ascent": 10.9, "blockHeight": 28.3,
  "lines": [{ "text": "Hello world, this", "width": 92.1 }, { "text": "is a long line", "width": 76.7 }],
  "sizeForHeight": 22.1 }
```

`font` is a standard font name or a font source. With `maxWidth`, text wraps at `wordBreaks` (default spaces); `\n` always breaks. `sizeForHeight` appears when `fitHeight` is given.

### Shared formats

**Pages** are 1-based. `pages` takes an array (`[1, 3, -1]`, negatives count from the end) or a string: `"1-3,5"`, `"first"`, `"last"`, `"odd"`, `"even"`, `"all"`, `"5-1"` (reversed). Leaving it out means every page.

**Sizes** are paper names (`"A4"`, `"A3"`, `"A5"`, `"Letter"`, `"Legal"`, `"Tabloid"`, and every other pdf-lib `PageSizes` name) or `[width, height]` in points (72 pt = 1 inch; A4 is 595 × 842).

**Colours** are hex: `"#ff0000"` or `"#f00"`. **Opacity** is 0–1.

**Coordinates** are PDF points from the bottom-left corner. Add `"origin": "top-left"` to measure `y` down from the top (handy when copying positions from a screen).

## Operations

Run in order, each `{ "op": "<name>", … }`. Errors name the failing step, e.g. `operations[2] (removePages): Page 9 is out of range`.

### Pages

| op | Fields (defaults) | Notes |
| --- | --- | --- |
| `addPage` | `size` (A4), `at` (end), `count` (1) | Blank pages |
| `removePages` | `pages` | Can't remove every page |
| `selectPages` | `pages` | Keep only these, in this order: extract, reorder, reverse, or repeat (`"1,1,2"`) |
| `duplicatePage` | `page`, `at` (right after) | |
| `rotatePages` | `pages`, `degrees` (multiple of 90), `relative` (true) | `relative: false` sets the angle outright |
| `resizePages` | `pages`, `size`, `scaleContent` (true) | `true` shrinks/grows content to fit and centres it; `false` only changes the paper size |
| `cropPages` | `pages`, `x`, `y`, `width`, `height` | Sets the visible area; hidden content is still in the file |
| `insertPdf` | `source` (PDF or image), `pages`, `at` (end), `size`/`margin` (images) | |
| `setPageBoxes` | `pages`, `mediaBox`, `cropBox`, `bleedBox`, `trimBox`, `artBox` (each `{ x, y, width, height }`) | Media = paper size; bleed/trim/art for print production |
| `scalePages` | `pages`, `factor` (number or `[x, y]`), `target` (`page`) | `page` scales size, content and fields; `content` or `annotations` scale only those |
| `translateContent` | `pages`, `x`, `y` | Shifts everything drawn on the page |

### Drawing

| op | Fields (defaults) |
| --- | --- |
| `drawText` | `pages`, `text` (`\n` for new lines), `x`, `y`, `origin`, `size` (12), `font` (Helvetica), `color` (#000000), `opacity`, `rotate`, `xSkew`, `ySkew`, `maxWidth` (wraps), `lineHeight` (1.2 × size), `wordBreaks` (spaces), `characterSpacing`, `renderMode` (`fill`, `outline`, `fillAndOutline`, `invisible`), `strokeColor`, `strokeWidth`, `blendMode` |
| `drawImage` | `pages`, `image` (PNG/JPEG source), `x`, `y`, `origin`, `width`/`height` (one keeps the aspect ratio; neither = 1 px per pt), `opacity`, `rotate`, `xSkew`, `ySkew`, `blendMode` |
| `drawRectangle` | `pages`, `x`, `y`, `origin`, `width`, `height`, `rx`/`ry` (rounded corners), `rotate`, `xSkew`, `ySkew`, + shape style |
| `drawEllipse` | `pages`, `x`, `y` (centre), `origin`, `xRadius`, `yRadius` (= xRadius: a circle), `rotate`, + shape style |
| `drawLine` | `pages`, `start {x,y}`, `end {x,y}`, `origin`, `thickness` (1), `color` (#000000), `opacity`, `lineCap` (`butt`, `round`, `projecting`), `dashArray`, `dashPhase`, `blendMode` |
| `drawSvgPath` | `pages`, `path` (SVG path data; its y axis points down from `x`,`y`), `x`, `y`, `origin`, `scale`, `rotate`, `fillRule` (`nonzero`, `evenodd`), + shape style (fills black if no colour or border is given) |
| `drawSvg` | `pages`, `svg` (markup), `x`, `y` (top-left corner of the SVG), `origin`, `width`, `height`, `fontSize`, `fonts` (`{ "family-name": font }` for SVG text), `blendMode` |
| `drawPdfPage` | `pages`, `source` (PDF), `page` (1), `clip` (`{ left, bottom, right, top }` of the source page), `x` (0), `y` (0), `origin`, `width`/`height`/`scale`, `opacity`, `rotate`, `xSkew`, `ySkew`, `blendMode`, `behind` (false: on top; true: under the existing content, e.g. a letterhead) |
| `watermark` | `pages`, `text` **or** `image`, `position` (`center`, `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`), `margin` (24), `opacity` (0.25), `rotate` (45 text, 0 image), `blendMode`; text: `size` (60), `font` (Helvetica-Bold), `color` (#888888); image: `scale` (0.5 × page width) |
| `pageNumbers` | `pages`, `format` (`"{page} / {total}"`), `position` (bottom-center; same corners as watermark, no centre), `margin` (24), `size` (10), `font`, `color`, `startAt` (1) |

**Shape style** (rectangles, ellipses, SVG paths): `color` (fill), `opacity`, `borderColor`, `borderWidth` (1 when a border colour is given), `borderOpacity`, `borderDashArray` (e.g. `[6, 3]`), `borderDashPhase`, `borderLineCap`, `blendMode`.

**Blend modes**: `Normal`, `Multiply`, `Screen`, `Overlay`, `Darken`, `Lighten`, `ColorDodge`, `ColorBurn`, `HardLight`, `SoftLight`, `Difference`, `Exclusion`. **Rotation and skew** are in degrees.

`font` is a standard font (`Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`, `Helvetica-BoldOblique`, `Times-Roman`, `Times-Bold`, `Times-Italic`, `Times-BoldItalic`, `Courier`, `Courier-Bold`, `Courier-Oblique`, `Courier-BoldOblique`, `Symbol`, `ZapfDingbats`) or a TTF/OTF source in object form. Standard fonts only cover Latin text; use a font file for anything else. If a font lacks a character, the request fails and names the characters, rather than printing `?`. Font files are subset, so only used glyphs are embedded.

### Forms

| op | Fields (defaults) |
| --- | --- |
| `fillForm` | `fields { name: value }`, `images { name: image source }` (text fields and buttons), `imageAlignment`, `flatten` (false), `strict` (true: unknown names fail), `font` (Helvetica) |
| `flattenForm` | `font` |
| `addFormField` | `type` (`text`, `checkbox`, `dropdown`, `optionList`, `radio`, `button`), `name`, `page` (1), `x`, `y`, `width`, `height`, `origin`, `value`, `options` (dropdown/list choices), `choices` (radio: `[{ value, page?, x, y, width, height }]`), `label` (button), `font`, `textColor`, `backgroundColor`, `borderColor`, `borderWidth`, `rotate`, `hidden`, + field settings |
| `setFieldProperties` | `name`, + field settings, `image` + `imageAlignment` (text fields and buttons), `font` (to redraw it) |
| `removeFormFields` | `names` |
| `setFieldScript` | `name`, `event` (`keystroke`, `format`, `validate`, `calculate`, `mouseUp`, `mouseDown`, `mouseEnter`, `mouseExit`, `focus`, `blur`), `script` — replaces an existing script (see `/pdf/scripts`); the library can't add new ones |

**Field settings**: `readOnly`, `required`, `exported` (false: left out of form submissions); text: `multiline`, `maxLength` (null removes), `alignment` (`left`, `center`, `right`), `fontSize` (0 = auto), `password`, `comb` (one character per box; needs `maxLength`), `spellCheck`, `scroll`, `richText`, `fileSelect`; dropdowns and lists: `options`, `editable` (dropdown), `sort`, `multiselect`, `selectOnClick`, `fontSize`; radios: `offToggle` (clicking the chosen option clears it), `mutuallyExclusive` (`addFormField` only; default `true` turns on one button at a time, `false` turns on every button sharing the chosen value); buttons: `fontSize`. A setting that doesn't fit the field's type is an error.

Values: text fields take a string; checkboxes `true`/`false`; dropdowns and option lists an option or an array of options; radio groups an option. Flattening turns fields into plain page content so they can no longer be edited. Find field names and settings with `/pdf/info`.

### Scripts

| op | Fields |
| --- | --- |
| `addJavaScript` | `name`, `script` — document-level, runs when the PDF opens (in viewers that allow it) |
| `setXFAJavaScript` | `field`, `event`, `script` — needs `"preserveXFA": true` on the source |
| `deleteXFA` | — removes XFA data, leaving the regular form fields |

XFA support targets static government/tax forms; dynamic XFA isn't regenerated.

### Document

| op | Fields (defaults) |
| --- | --- |
| `setMetadata` | `title`, `showTitleInWindow`, `author`, `subject`, `keywords[]`, `creator`, `producer`, `language`, `creationDate`, `modificationDate` (ISO dates; modification defaults to now), `copyright`, `copyrightUrl`, `custom { Key: "value" \| null }` |
| `setViewerPreferences` | `pageMode` (`UseNone`, `UseOutlines`, `UseThumbs`, `FullScreen`, `UseOC`, `UseAttachments`), `pageLayout` (`SinglePage`, `OneColumn`, `TwoColumnLeft`, `TwoColumnRight`, `TwoPageLeft`, `TwoPageRight`), `hideToolbar`, `hideMenubar`, `hideWindowUI`, `fitWindow`, `centerWindow`, `displayDocTitle`, `nonFullScreenPageMode`, `readingDirection` (`L2R`, `R2L`), `printScaling` (`None`, `AppDefault`), `duplex` (`Simplex`, `DuplexFlipShortEdge`, `DuplexFlipLongEdge`), `pickTrayByPDFSize`, `printPageRange` (pages), `numCopies` (1–5) |
| `setLayerVisibility` | `layers: [{ name, visible }]` |
| `attachFile` | `file` (source), `name`, `mimeType`, `description`, `creationDate`, `modificationDate`, `relationship` (`Source`, `Data`, `Alternative`, `Supplement`, `EncryptedPayload`, `Schema`, `Unspecified`) |
| `detachFile` | `name` |
| `convertToPDFA` | `conformance` (`1B`, `2B`, `2U`, `3B` default, `3U`), `iccProfile` (source; default sRGB), `outputConditionIdentifier`, `colorComponents` (1, 3, 4) |
| `embedFacturX` | `xml` (source: your Factur-X/ZUGFeRD invoice XML), `conformanceLevel` (`MINIMUM`, `BASIC WL`, `BASIC`, `EN 16931`, `EXTENDED`, `XRECHNUNG`), `fileName`, `version`, `documentType`, `description` |
| `encrypt` | `ownerPassword`, `userPassword` (empty: opens without a password, permissions still apply), `algorithm` (`AES-256`, `AES-128`, or `RC4-128`/`RC4-40` with `allowWeakCryptography: true`), `permissions` |

**PDF/A**: `convertToPDFA` adds what the standard requires around the content (colour profile, file ID, XMP). It doesn't rewrite content: text must use an embedded font file (the built-in fonts aren't allowed) and the PDF mustn't be encrypted. Check results with a validator such as veraPDF. Run `setMetadata` before `convertToPDFA` so copyright and custom fields are carried into the PDF/A metadata.

**Factur-X**: `embedFacturX` attaches the invoice XML and makes the file PDF/A-3. It doesn't create or check the XML; pass a complete one from your invoicing system.

`permissions`: `printing` (`true`, `false`, `"lowResolution"`, `"highResolution"`), `modifying`, `copying`, `annotating`, `fillingForms`, `contentAccessibility`, `documentAssembly`. Everything is allowed unless set to `false`. Put `encrypt` last; steps after it still apply, and encryption happens on save.

## Metadata: who, where, copyright

`setMetadata` writes to both places PDF tools look: the Info dictionary (shown in most viewers' document properties) and the XMP packet (where Acrobat shows **Copyright Status/Notice/Info URL**, and what asset tools index).

```json
{ "op": "setMetadata",
  "title": "Q3 report", "author": "Acme Inc.",
  "copyright": "© 2026 Acme Inc. All rights reserved.",
  "copyrightUrl": "https://acme.example/licence",
  "custom": { "MadeFor": "Client X", "Origin": "billing-service", "OrderId": "A-1001" } }
```

- `custom` keys start with a letter, then letters, digits or `_`, up to 64 characters. Set a key to `null` to remove it.
- `/pdf/info` returns them under `metadata.copyright`, `metadata.copyrightUrl` and `metadata.custom`.
- Metadata is invisible on the page. To print "Prepared for Client X" on every page, add a `drawText` or `watermark` step too.
- Anyone with the file can edit metadata, so treat it as a label, not proof. Encrypting with an owner password stops casual changes.

## Errors

Errors are JSON: `{ "error": "message", "details": … }`. `details` lists each invalid field (`{ "path": "operations.0.pages", "message": … }`) for 400s.

| Status | Meaning |
| --- | --- |
| 400 | Bad request: invalid JSON or fields, page out of range, unknown form field, font missing characters, unknown upload name |
| 401 | Missing or wrong API key |
| 403 | Download link invalid or expired |
| 404 | No file at that R2 key, or unknown route |
| 413 | URL source larger than `MAX_FETCH_BYTES` |
| 422 | Not a PDF, damaged PDF, encrypted without (or with the wrong) password, an operation the PDF can't support |
| 500 | `API_KEY` not set, or an unexpected error |
| 502 | URL source returned an error or couldn't be reached |
| 504 | URL source timed out |

## Examples

```sh
API=https://pdfmill.<you>.workers.dev
H='Authorization: Bearer YOUR_KEY'
J='Content-Type: application/json'

# Stitch PDFs from URLs, then watermark the result
curl -s -H "$H" -H "$J" "$API/pdf/merge" -d '{
  "sources": ["https://example.com/a.pdf", { "url": "https://example.com/b.pdf", "pages": "1-3" }],
  "operations": [{ "op": "watermark", "text": "COPY" }]
}'

# Stitch local files: every PDF, in the order sent
curl -s -H "$H" "$API/pdf/merge" -F files=@one.pdf -F files=@two.pdf -F files=@three.pdf

# Mix uploads and URLs, pick pages, get the PDF straight back
curl -s -H "$H" -H 'Accept: application/pdf' "$API/pdf/merge" -o out.pdf -F cover=@cover.pdf -F 'options={
  "sources": [{ "upload": "cover" }, { "url": "https://example.com/report.pdf", "pages": "2-last" }]
}'

# Scans and photos into one PDF, logo in the corner, copyright set
curl -s -H "$H" "$API/pdf/merge" -F files=@scan1.jpg -F files=@scan2.jpg -F files=@invoice.pdf -F logo=@logo.png -F 'options={
  "operations": [
    { "op": "watermark", "image": { "upload": "logo" }, "scale": 0.15, "position": "top-right", "opacity": 0.8 },
    { "op": "setMetadata", "copyright": "© 2026 Acme Inc.", "custom": { "MadeFor": "Client X" } }
  ]
}'

# Watermark a local file
curl -s -H "$H" "$API/pdf/edit" -F file=@in.pdf -F 'options={"operations":[{"op":"watermark","text":"DRAFT"}]}'

# Watermark a URL, add page numbers, lock it
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/in.pdf",
  "operations": [
    { "op": "watermark", "text": "CONFIDENTIAL" },
    { "op": "pageNumbers", "format": "Page {page} of {total}" },
    { "op": "encrypt", "ownerPassword": "s3cret", "permissions": { "copying": false } }
  ],
  "output": { "key": "stamped/in.pdf" }
}'

# See a form's fields, then fill and flatten it (non-Latin names need a font)
curl -s -H "$H" -H "$J" "$API/pdf/info" -d '{ "source": "https://example.com/form.pdf" }'
curl -s -H "$H" -H "$J" -H 'Accept: application/pdf' "$API/pdf/edit" -o filled.pdf -d '{
  "source": "https://example.com/form.pdf",
  "operations": [{ "op": "fillForm", "fields": { "name": "Пётр", "agree": true },
                   "font": { "url": "https://example.com/NotoSans-Regular.ttf" }, "flatten": true }]
}'

# Fill a scanned form (no fields) by writing at positions measured from the top
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/scan.pdf",
  "operations": [
    { "op": "drawText", "text": "Ada Lovelace", "x": 120, "y": 140, "origin": "top-left", "size": 11 },
    { "op": "drawImage", "image": "https://example.com/signature.png", "x": 120, "y": 640, "width": 150, "origin": "top-left" }
  ]
}'

# Reorder pages, drop the last one, rotate page 1, resize everything to A4
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/in.pdf",
  "operations": [
    { "op": "selectPages", "pages": "3,1,2,4-last" },
    { "op": "removePages", "pages": "last" },
    { "op": "rotatePages", "pages": [1], "degrees": 90 },
    { "op": "resizePages", "size": "A4" }
  ]
}'

# Build a PDF from scratch
curl -s -H "$H" -H "$J" "$API/pdf/create" -d '{
  "size": "Letter",
  "operations": [
    { "op": "drawText", "text": "Certificate of Completion", "x": 72, "y": 100, "origin": "top-left", "size": 28, "font": "Times-Bold" },
    { "op": "drawText", "text": "Awarded to Ada Lovelace\nOctober 2026", "x": 72, "y": 160, "origin": "top-left", "size": 16 },
    { "op": "drawRectangle", "x": 36, "y": 36, "width": 540, "height": 720, "borderColor": "#336699", "borderWidth": 3 }
  ],
  "output": { "filename": "certificate.pdf" }
}'

# Split into single pages, and into two halves
curl -s -H "$H" -H "$J" "$API/pdf/split" -d '{ "source": "https://example.com/in.pdf" }'
curl -s -H "$H" -H "$J" "$API/pdf/split" -d '{ "source": "https://example.com/in.pdf", "ranges": ["1-5", "6-last"] }'

# Attach the source data inside the PDF
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/invoice.pdf",
  "operations": [{ "op": "attachFile", "file": { "base64": "aWQsdG90YWwKNDIsOTA=" }, "name": "invoice.csv", "mimeType": "text/csv" }]
}'

# Open a locked PDF, read its text
curl -s -H "$H" -H "$J" "$API/pdf/text" -d '{ "source": { "url": "https://example.com/locked.pdf", "password": "s3cret" } }'

# Remove a password (any edit saves the result unlocked)
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": { "url": "https://example.com/locked.pdf", "password": "s3cret" },
  "operations": [{ "op": "setMetadata" }]
}'

# Letterhead behind every page of a report
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/report.pdf",
  "operations": [{ "op": "drawPdfPage", "source": "templates/letterhead.pdf", "behind": true }]
}'

# Two pages side by side on one landscape sheet (2-up)
curl -s -H "$H" -H "$J" "$API/pdf/create" -d '{
  "size": [842, 595], "operations": [
    { "op": "drawPdfPage", "source": "https://example.com/a.pdf", "page": 1, "x": 0,   "y": 0, "width": 421, "height": 595 },
    { "op": "drawPdfPage", "source": "https://example.com/a.pdf", "page": 2, "x": 421, "y": 0, "width": 421, "height": 595 }
  ]
}'

# Build a fillable form
curl -s -H "$H" -H "$J" "$API/pdf/create" -d '{
  "operations": [
    { "op": "drawText", "text": "Name", "x": 50, "y": 95, "origin": "top-left" },
    { "op": "addFormField", "type": "text", "name": "name", "x": 120, "y": 80, "width": 250, "height": 24, "origin": "top-left", "required": true, "borderColor": "#888888" },
    { "op": "addFormField", "type": "dropdown", "name": "country", "x": 120, "y": 120, "width": 150, "height": 24, "origin": "top-left", "options": ["FR", "UK", "US"], "borderColor": "#888888" },
    { "op": "addFormField", "type": "radio", "name": "plan", "origin": "top-left", "value": "basic",
      "choices": [{ "value": "basic", "x": 120, "y": 160, "width": 14, "height": 14 }, { "value": "pro", "x": 200, "y": 160, "width": 14, "height": 14 }] },
    { "op": "addFormField", "type": "checkbox", "name": "terms", "x": 120, "y": 200, "width": 14, "height": 14, "origin": "top-left" }
  ]
}'

# Pull every image and attachment out of a PDF
curl -s -H "$H" -H "$J" "$API/pdf/extract" -d '{ "source": "https://example.com/brochure.pdf", "include": ["images", "attachments"] }'

# Archive as PDF/A-2B with an embedded font
curl -s -H "$H" -H "$J" "$API/pdf/create" -d '{
  "operations": [
    { "op": "drawText", "text": "Board minutes", "x": 72, "y": 72, "origin": "top-left", "size": 20, "font": { "key": "fonts/NotoSans-Regular.ttf" } },
    { "op": "setMetadata", "title": "Board minutes", "copyright": "© 2026 Acme" },
    { "op": "convertToPDFA", "conformance": "2B" }
  ]
}'

# Factur-X e-invoice from your invoice PDF and XML
curl -s -H "$H" "$API/pdf/edit" -F file=@invoice.pdf -F xml=@factur-x.xml -F 'options={
  "operations": [{ "op": "embedFacturX", "xml": { "upload": "xml" }, "conformanceLevel": "EN 16931" }]
}'

# Add a stamp to a signed PDF without breaking the signature
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d '{
  "source": "https://example.com/signed.pdf", "incremental": true,
  "operations": [{ "op": "drawText", "text": "Received 2026-10-05", "x": 400, "y": 30 }]
}'

# How wide is this text, and where does it wrap?
curl -s -H "$H" -H "$J" "$API/text/measure" -d '{ "text": "Quarterly report for Acme Inc.", "font": "Helvetica-Bold", "size": 18, "maxWidth": 200 }'

# Text of a local file (raw body)
curl -s -H "$H" -H 'Content-Type: application/pdf' --data-binary @in.pdf "$API/pdf/text"

# Chain: use one result as the next input
KEY=$(curl -s -H "$H" -H "$J" "$API/pdf/merge" -d '{"sources":["https://example.com/a.pdf","https://example.com/b.pdf"]}' | jq -r .key)
curl -s -H "$H" -H "$J" "$API/pdf/edit" -d "{\"source\":\"$KEY\",\"operations\":[{\"op\":\"pageNumbers\"}]}"
```

## Limits and what it can't do

- Workers have 128 MB memory and the whole PDF is held in memory, so stay well under ~50 MB per file.
- Request bodies are capped by your Cloudflare plan (100 MB on Free/Pro). For large files, pass a URL, or put the file in R2 (dashboard or wrangler) and pass `{ "key": … }`.
- Custom fonts add a few seconds per request (subsetting).
- Some sites refuse requests from Cloudflare Workers, whatever the headers (w3.org, for example, returns 403 to the Worker but serves browsers). The error names the URL; send those files as uploads or base64 instead.
- Opening a locked PDF with its password always saves it unlocked; add `encrypt` to lock the result again.

Not supported (the library can't do these either):

- **Redaction.** `cropPages` and drawing a box over content only hide it; the original stays in the file.
- **Rendering pages to images**, **OCR** of scans, **compressing** or optimising PDFs.
- **Creating digital signatures** (cryptographic). `incremental: true` keeps existing ones valid; a signature image can be stamped with `drawImage`.
- **Bookmarks/outlines, links, comments and other annotations** (beyond form fields).
- **Dynamic XFA forms**; static XFA is supported as described above.
- **Images** other than PNG and JPEG (convert WebP, HEIC, TIFF first).

## License

[MIT](LICENSE)
