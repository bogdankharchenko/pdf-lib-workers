# pdf-lib-workers

A Cloudflare Worker that edits PDFs with [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib) and stores the results in a private R2 bucket. You send PDFs (and images, fonts) as URLs or file data; you get back a download link or the PDF itself.

- [What you can do](#what-you-can-do)
- [Setup](#setup) · [Auth and access](#auth-and-access) · [Configuration](#configuration)
- [Sending files](#sending-files) · [Getting results back](#getting-results-back)
- [Endpoints](#endpoints) · [Operations](#operations) · [Metadata](#metadata-who-where-copyright)
- [Errors](#errors) · [Examples](#examples) · [Limits and what it can't do](#limits-and-what-it-cant-do)

## What you can do

| Task | How |
| --- | --- |
| **Stitch** PDFs together, whole or chosen pages | `POST /pdf/merge` with `sources` (each may take `pages`) |
| Turn **photos/scans (JPG, PNG)** into PDF pages, or mix them with PDFs | `POST /pdf/merge` — images become pages, fitted to A4/Letter/any size, upright per EXIF |
| **Split** a PDF into parts (every N pages, or ranges) | `POST /pdf/split` |
| **Extract**, **reorder**, **reverse** or **repeat** pages | `selectPages` |
| **Delete**, **add** blank, **duplicate**, **insert** pages (from another PDF or an image) | `removePages`, `addPage`, `duplicatePage`, `insertPdf` |
| **Rotate**, **resize** (e.g. Letter → A4) or **crop** pages | `rotatePages`, `resizePages`, `cropPages` |
| **Watermark** with text ("DRAFT", "CONFIDENTIAL") or a **logo** | `watermark` — centred or in a corner, any angle and opacity |
| Add **page numbers** ("Page 3 of 10") | `pageNumbers` |
| **Stamp** text, images, signatures, boxes, lines, SVG anywhere | `drawText`, `drawImage`, `drawRectangle`, `drawLine`, `drawSvg` |
| **Fill a form** (text, checkboxes, dropdowns, radios), optionally **flatten** it | `fillForm`, `flattenForm`; list the fields first with `POST /pdf/info` |
| Fill a PDF **without form fields** (e.g. a scanned form) | `drawText` at coordinates |
| Write **non-Latin text** (Cyrillic, Greek, CJK, …) | pass a TTF/OTF `font` to any text step |
| Record **copyright**, **author**, **who it's for**, **where it came from**, any custom field | `setMetadata` (Info and XMP, read by Acrobat) |
| **Password-protect** and restrict printing/copying/editing | `encrypt` |
| **Open** password-protected PDFs | `"password"` on the source |
| **Attach** files inside the PDF (CSV, XML, …) | `attachFile` |
| **Create** a PDF from scratch | `POST /pdf/create` plus drawing steps |
| **Read** page count, sizes, metadata, form fields, attachments | `POST /pdf/info` |
| **Extract text** (per page, optionally with positions and fonts) | `POST /pdf/text` |
| **Chain** calls: feed one result into the next | pass the returned `key` or `url` as a source |
| Get the result as a **link**, the **raw PDF**, or **base64** | `output.return`, `output.store` |

Every PDF-producing endpoint (`create`, `edit`, `merge`) takes the same `operations` list, run in order, so one request can stitch, watermark, number, tag and lock a document.

## Setup

```sh
npm install
npx wrangler login
npx wrangler r2 bucket create pdf-lib-workers
npx wrangler secret put API_KEY        # any long random string
npx wrangler deploy
```

Optional:

- `npx wrangler secret put SIGNING_KEY` — a separate key for download links (defaults to `API_KEY`). Changing it voids all links already handed out.
- Expire old outputs: `npx wrangler r2 bucket lifecycle add pdf-lib-workers expire-outputs outputs/ --expire-days 7`

Local dev: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`. Tests: `npm test`.

## Auth and access

- Send `Authorization: Bearer <API_KEY>` (or `X-API-Key: <API_KEY>`) on every call except `GET /`.
- The key gives full access: anyone holding it can run every endpoint and download any file in the bucket by key. Keep it on servers, never in browser or app code.
- Download links returned by the API carry their own signature (`?expires=…&sig=…`). A link opens only its own file, only until it expires (default 1 hour via `SIGNED_URL_TTL`; up to 7 days per request with `output.linkTtl`). Editing the key or expiry in the link breaks it. Rotating `SIGNING_KEY` voids every link.
- The R2 bucket is private; files are only reachable through the Worker.
- CORS is open (`*`), so browsers can call the API, but only with the key, so do that only from trusted internal tools.

There are no upload, list or delete endpoints. Send inputs with each request. To keep reusable files in R2 (templates, fonts, logos) and refer to them by `key`, add them with the Cloudflare dashboard or `npx wrangler r2 object put pdf-lib-workers/<key> --file <path> --remote`. Remove old outputs with the lifecycle rule above.

## Configuration

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `API_KEY` | secret | — (required) | Bearer token for every call |
| `SIGNING_KEY` | secret | `API_KEY` | HMAC key for download links |
| `SIGNED_URL_TTL` | var | `3600` | Default link lifetime, seconds |
| `MAX_FETCH_BYTES` | var | `52428800` (50 MB) | Largest file fetched from a URL source |
| `FETCH_TIMEOUT_MS` | var | `30000` | Time limit per URL fetch |
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

- PDF sources also take `"password"` for encrypted files.
- Merge sources also take `"pages"`, and, for images, `"size"` and `"margin"`.
- **Images:** a PNG or JPEG works wherever a PDF source does in `/pdf/merge` and `insertPdf`, and becomes one page. It is fitted on A4 (turned landscape when wide), or set `"size": "Letter"`, `[w, h]` or `"image"` (page = image size, 1 px = 1 pt), plus `"margin"` in points. Phone photos are turned upright using their EXIF orientation.
- Font fields need the object form, since a bare string there is a font name.
- URL downloads follow redirects and stop after `FETCH_TIMEOUT_MS` or `MAX_FETCH_BYTES`. Errors name the bad input, e.g. `sources[1]: https://… returned HTTP 404` or `Not a PDF (starts with "<!DOCTYPE html>…")`.
- Links this API returned are read straight from R2, so outputs can feed later calls.

Send file data in any of three ways:

- **Multipart** — files as fields, plus an `options` field holding the JSON body. Field names may repeat (`files`, `files`, …); refer to those as `files[0]`, `files[1]`, or by file name.
- **Raw body** — the PDF itself (`Content-Type: application/pdf`, or none), with the JSON body URL-encoded in `?options=`.
- **JSON** — with `url`, `key` or `base64` sources.

If you leave out `source`, the single uploaded file (or the one in field `file`) is used. If `/pdf/merge` gets no `sources`, it merges every uploaded PDF and image in the order sent, skipping files the operations use (such as a watermark logo).

## Getting results back

`create`, `edit` and `merge` take an optional `output`:

```json
{ "key": "invoices/42.pdf", "filename": "invoice.pdf", "return": "json", "store": true, "linkTtl": 3600 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `key` | `outputs/<uuid>.pdf` | Where to save in R2 (overwrites an existing file) |
| `filename` | `document.pdf` | Name offered when the PDF is opened or saved |
| `return` | `json` | `json`: details and a link. `pdf`: the PDF bytes. |
| `store` | `true` | Save to R2. With `false` and `return: json`, the PDF comes back as `base64`. |
| `linkTtl` | `SIGNED_URL_TTL` | Link lifetime in seconds, up to 604800 (7 days) |

JSON reply:

```json
{ "key": "invoices/42.pdf", "url": "https://…/files/invoices/42.pdf?expires=…&sig=…",
  "expiresAt": "2026-10-05T02:00:00.000Z", "size": 25400, "pageCount": 6 }
```

With `return: pdf`, headers `X-Page-Count`, and when stored `X-File-Key` and `X-File-Url`, describe the result.

Download a stored result with `GET /files/<key>` (with the key) or its signed `url` (without). Supports `Range` requests (for PDF viewers) and `If-None-Match`; add `?download` to force a save dialog.

## Endpoints

| Method & path | Body | Does |
| --- | --- | --- |
| `GET /` | | Lists endpoints and operations (no auth) |
| `GET /files/<key>` | | Download a result |
| `POST /pdf/info` | `{ source }` | Page sizes, rotation, metadata, form fields, attachments |
| `POST /pdf/text` | `{ source, pages?, items? }` | Text per page |
| `POST /pdf/create` | `{ size? ("A4"), pageCount? (1, max 1000), operations?, output? }` | New PDF |
| `POST /pdf/edit` | `{ source, operations, output? }` | Run operations on a PDF |
| `POST /pdf/merge` | `{ sources (max 200), operations?, output? }` | Join PDFs and images, then run operations |
| `POST /pdf/split` | `{ source, ranges? \| every? (1), prefix?, linkTtl? }` | One R2 file per part |

`create` with `pageCount: 0` starts empty; add pages with `addPage`. A request may hold up to 500 operations.

### `/pdf/info` reply

```json
{ "pageCount": 2, "encrypted": false,
  "metadata": { "title": "Q3 report", "author": "Acme", "subject": null, "keywords": null,
                "creator": null, "producer": "…", "language": null,
                "creationDate": "…", "modificationDate": "…",
                "copyright": "© 2026 Acme", "copyrightUrl": null, "custom": { "MadeFor": "Client X" } },
  "pages": [{ "page": 1, "width": 612, "height": 792, "rotation": 0 }],
  "form": { "fields": [
    { "name": "name", "type": "text", "value": "Ada" },
    { "name": "agree", "type": "checkbox", "value": true },
    { "name": "color", "type": "dropdown", "value": ["green"], "options": ["red", "green"] } ] },
  "attachments": [{ "name": "data.csv", "size": 120, "mimeType": "text/csv", "description": null }] }
```

Field types: `text`, `checkbox`, `dropdown`, `optionList`, `radio`, plus `button` and `signature` (listed, not fillable).

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

### Drawing

| op | Fields (defaults) |
| --- | --- |
| `drawText` | `pages`, `text` (`\n` for new lines), `x`, `y`, `origin`, `size` (12), `font` (Helvetica), `color` (#000000), `opacity`, `rotate` (degrees), `maxWidth` (wraps), `lineHeight` (1.2 × size) |
| `drawImage` | `pages`, `image` (PNG/JPEG source), `x`, `y`, `origin`, `width`/`height` (one keeps the aspect ratio; neither = 1 px per pt), `opacity`, `rotate` |
| `drawRectangle` | `pages`, `x`, `y`, `origin`, `width`, `height`, `color` (fill), `borderColor`, `borderWidth`, `opacity`, `rotate` |
| `drawLine` | `pages`, `start {x,y}`, `end {x,y}`, `origin`, `thickness` (1), `color` (#000000), `opacity` |
| `drawSvg` | `pages`, `svg` (markup), `x`, `y` (top-left corner of the SVG), `origin`, `width`, `height` |
| `watermark` | `pages`, `text` **or** `image`, `position` (`center`, `top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`), `margin` (24), `opacity` (0.25), `rotate` (45 text, 0 image); text: `size` (60), `font` (Helvetica-Bold), `color` (#888888); image: `scale` (0.5 × page width) |
| `pageNumbers` | `pages`, `format` (`"{page} / {total}"`), `position` (bottom-center; same corners as watermark, no centre), `margin` (24), `size` (10), `font`, `color`, `startAt` (1) |

`font` is a standard font (`Helvetica`, `Helvetica-Bold`, `Helvetica-Oblique`, `Helvetica-BoldOblique`, `Times-Roman`, `Times-Bold`, `Times-Italic`, `Times-BoldItalic`, `Courier`, `Courier-Bold`, `Courier-Oblique`, `Courier-BoldOblique`, `Symbol`, `ZapfDingbats`) or a TTF/OTF source in object form. Standard fonts only cover Latin text; use a font file for anything else. If a font lacks a character, the request fails and names the characters, rather than printing `?`. Font files are subset, so only used glyphs are embedded.

### Forms

| op | Fields (defaults) |
| --- | --- |
| `fillForm` | `fields { name: value }`, `flatten` (false), `strict` (true: unknown names fail), `font` (Helvetica) |
| `flattenForm` | `font` |

Values: text fields take a string; checkboxes `true`/`false`; dropdowns and option lists an option or an array of options; radio groups an option. Buttons and signature fields can't be filled; stamp a signature image with `drawImage`. Flattening turns fields into plain page content so they can no longer be edited. Find field names with `/pdf/info`.

### Document

| op | Fields (defaults) |
| --- | --- |
| `setMetadata` | `title`, `author`, `subject`, `keywords[]`, `creator`, `producer`, `language`, `copyright`, `copyrightUrl`, `custom { Key: "value" \| null }` |
| `attachFile` | `file` (source), `name`, `mimeType`, `description` |
| `encrypt` | `ownerPassword`, `userPassword` (empty: opens without a password, permissions still apply), `algorithm` (`AES-256` or `AES-128`), `permissions` |

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

- `custom` keys are letters, digits and `_`, up to 64 characters. Set a key to `null` to remove it.
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
API=https://pdf-lib-workers.<you>.workers.dev
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
curl -s -H "$H" "$API/pdf/merge" -o out.pdf -F cover=@cover.pdf -F 'options={
  "sources": [{ "upload": "cover" }, { "url": "https://example.com/report.pdf", "pages": "2-last" }],
  "output": { "return": "pdf" }
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
  "output": { "key": "outputs/in-stamped.pdf" }
}'

# See a form's fields, then fill and flatten it (non-Latin names need a font)
curl -s -H "$H" -H "$J" "$API/pdf/info" -d '{ "source": "https://example.com/form.pdf" }'
curl -s -H "$H" -H "$J" "$API/pdf/edit" -o filled.pdf -d '{
  "source": "https://example.com/form.pdf",
  "operations": [{ "op": "fillForm", "fields": { "name": "Пётр", "agree": true },
                   "font": { "url": "https://example.com/NotoSans-Regular.ttf" }, "flatten": true }],
  "output": { "return": "pdf" }
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

Not supported:

- **Removing a password.** Editing a locked PDF keeps it locked.
- **Redaction.** `cropPages` and drawing a box over content only hide it; the original stays in the file.
- **Rendering pages to images**, **OCR** of scans, **compressing** or optimising PDFs.
- **Digital signatures** (cryptographic). A signature image can be stamped with `drawImage`.
- **XFA forms** (an older Adobe format) may not fill correctly.
- **Images** other than PNG and JPEG (convert WebP, HEIC, TIFF first).
