# pdf-lib-workers

A Cloudflare Worker that edits PDFs with [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib) and stores the results in R2.

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

## Auth

Send `Authorization: Bearer <API_KEY>` (or `X-API-Key: <API_KEY>`) on every call.
Download links returned by the API carry their own signature (`?expires=…&sig=…`) and work without the key until they expire (default 1 hour, set `SIGNED_URL_TTL`).

## Sources: URLs or file data

Anywhere the API takes a file (PDF, image, font, attachment), give it one of:

| Shape | Meaning |
| --- | --- |
| `"https://…"` or `{ "url": "https://…" }` | The Worker downloads it. Add `"headers": { "authorization": "…" }` for private URLs. |
| `"uploads/a.pdf"` or `{ "key": "uploads/a.pdf" }` | An object in the R2 bucket |
| `"data:application/pdf;base64,…"` or `{ "base64": "JVBERi0…" }` | The bytes inline |
| `{ "upload": "a" }` | A file sent in the same multipart request, by field name or file name |

- PDF sources also take `"password"` for encrypted files; merge sources take `"pages"`.
- Font fields need the object form, since a bare string there is a font name.
- URL downloads stop after 30 s (`FETCH_TIMEOUT_MS`) or 50 MB (`MAX_FETCH_BYTES`). Errors name the bad input, e.g. `sources[1]: https://… returned HTTP 404` or `Not a PDF (starts with "<!DOCTYPE html>…")`.
- Links this API returned are read straight from R2, so outputs can feed later calls.

Send file data in any of three ways:

- **Multipart** — files as fields, plus an `options` field holding the JSON body. Field names may repeat (`files`, `files`, …); refer to those as `files[0]`, `files[1]`, or by file name.
- **Raw body** — the PDF itself (`Content-Type: application/pdf`, or none), with the JSON body URL-encoded in `?options=`.
- **JSON** — with `base64` sources.

If you leave out `source`, the single uploaded file (or the one in field `file`) is used. If `/pdf/merge` gets no `sources`, it merges every uploaded PDF in the order sent.

## Output

Endpoints that make a PDF take an optional `output`:

```json
{ "key": "invoices/42.pdf", "filename": "invoice.pdf", "return": "json", "store": true, "linkTtl": 3600 }
```

- Default: saves to `outputs/<uuid>.pdf` and returns `{ key, url, expiresAt, size, pageCount }`.
- `"return": "pdf"` returns the bytes; if stored, `X-File-Key` and `X-File-Url` headers point at the R2 copy.
- `"store": false` skips R2; with `"return": "json"` you get `{ base64 }`.

## Endpoints

| Method & path | Body | Does |
| --- | --- | --- |
| `GET /` | | Lists endpoints and operations (no auth) |
| `POST /files?key=` | raw bytes or multipart `file` | Upload to R2 |
| `GET /files?prefix=&cursor=&limit=` | | List |
| `GET /files/<key>` | | Download (key or signed link; supports `Range`; `?download` forces save) |
| `POST /files/sign` | `{ key, ttl? }` | New signed link |
| `DELETE /files/<key>` | | Delete |
| `POST /pdf/info` | `{ source }` | Page sizes, rotation, metadata, form fields, attachments |
| `POST /pdf/text` | `{ source, pages?, items? }` | Text per page (`items: true` adds positions and fonts) |
| `POST /pdf/create` | `{ size?, pageCount?, operations?, output? }` | New PDF |
| `POST /pdf/edit` | `{ source, operations, output? }` | Run operations on a PDF |
| `POST /pdf/merge` | `{ sources: [{ …source, pages? }], operations?, output? }` | Join PDFs |
| `POST /pdf/split` | `{ source, ranges? \| every?, prefix?, linkTtl? }` | One R2 file per part |

**Pages** are 1-based. `pages` takes an array (`[1, 3, -1]`, negatives count from the end) or a string: `"1-3,5"`, `"last"`, `"odd"`, `"even"`, `"all"`, `"5-1"` (reversed). Leaving it out means every page.

**Sizes** are `"A4"`, `"Letter"`, `"Legal"`, … (any `PageSizes` name) or `[width, height]` in points (72 pt = 1 inch).

**Colours** are hex: `"#ff0000"` or `"#f00"`.

**Coordinates** are PDF points from the bottom-left corner. Add `"origin": "top-left"` to measure `y` down from the top.

## Operations

Run in order, each `{ "op": "<name>", … }`. Errors name the failing step, e.g. `operations[2] (removePages): Page 9 is out of range`.

| op | Fields (defaults) |
| --- | --- |
| `addPage` | `size` (A4), `at`, `count` (1) |
| `removePages` | `pages` |
| `selectPages` | `pages` — keep only these, in this order (extract, reorder, reverse, repeat) |
| `duplicatePage` | `page`, `at` (right after) |
| `rotatePages` | `pages`, `degrees` (multiple of 90), `relative` (true) |
| `resizePages` | `pages`, `size`, `scaleContent` (true: fit and centre) |
| `cropPages` | `pages`, `x`, `y`, `width`, `height` |
| `insertPdf` | `source`, `pages`, `at` (end) |
| `drawText` | `pages`, `text`, `x`, `y`, `origin`, `size` (12), `font` (Helvetica), `color`, `opacity`, `rotate`, `maxWidth` (wraps), `lineHeight` |
| `drawImage` | `pages`, `image` (PNG/JPEG source), `x`, `y`, `origin`, `width`/`height` (keeps aspect if one given), `opacity`, `rotate` |
| `drawRectangle` | `pages`, `x`, `y`, `origin`, `width`, `height`, `color`, `borderColor`, `borderWidth`, `opacity`, `rotate` |
| `drawLine` | `pages`, `start {x,y}`, `end {x,y}`, `origin`, `thickness` (1), `color`, `opacity` |
| `drawSvg` | `pages`, `svg` (markup), `x`, `y` (top-left of the SVG), `origin`, `width`, `height` |
| `watermark` | `pages`, `text`, `size` (60), `font`, `color` (#888888), `opacity` (0.25), `rotate` (45) — centred |
| `pageNumbers` | `pages`, `format` ("{page} / {total}"), `position` (bottom-center), `margin` (24), `size` (10), `font`, `color`, `startAt` (1) |
| `fillForm` | `fields { name: string \| boolean \| string[] }`, `flatten` (false), `strict` (true: unknown names fail) |
| `flattenForm` | |
| `setMetadata` | `title`, `author`, `subject`, `keywords[]`, `creator`, `producer`, `language` |
| `attachFile` | `file` (source), `name`, `mimeType`, `description` |
| `encrypt` | `ownerPassword`, `userPassword`, `algorithm` (AES-256), `permissions { printing, modifying, copying, annotating, fillingForms, contentAccessibility, documentAssembly }` |

`font` is a standard font name (`Helvetica`, `Helvetica-Bold`, `Times-Roman`, `Courier`, …) or a TTF/OTF source. Standard fonts only cover Latin text; use a font file for anything else. Font files are subset, so only used glyphs are embedded.

## Examples

```sh
API=https://pdf-lib-workers.<you>.workers.dev
H='Authorization: Bearer YOUR_KEY'

# Stitch PDFs from URLs, then watermark the result
curl -s -H "$H" -H 'Content-Type: application/json' "$API/pdf/merge" -d '{
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

# Watermark a local file
curl -s -H "$H" "$API/pdf/edit" -F file=@in.pdf -F 'options={"operations":[{"op":"watermark","text":"DRAFT"}]}'

# Watermark a URL, add page numbers, lock it
curl -s -H "$H" -H 'Content-Type: application/json' "$API/pdf/edit" -d '{
  "source": "https://example.com/in.pdf",
  "operations": [
    { "op": "watermark", "text": "CONFIDENTIAL" },
    { "op": "pageNumbers", "format": "Page {page} of {total}" },
    { "op": "encrypt", "ownerPassword": "s3cret", "permissions": { "copying": false } }
  ],
  "output": { "key": "outputs/in-stamped.pdf" }
}'

# Fill a form and flatten it
curl -s -H "$H" -H 'Content-Type: application/json' "$API/pdf/edit" -o filled.pdf -d '{
  "source": "https://example.com/form.pdf",
  "operations": [{ "op": "fillForm", "fields": { "name": "Ada", "agree": true }, "flatten": true }],
  "output": { "return": "pdf" }
}'

# Text of a local file (raw body)
curl -s -H "$H" -H 'Content-Type: application/pdf' --data-binary @in.pdf "$API/pdf/text"
```

## Limits

- `limits.cpu_ms` is 300000 (5 min, paid plan) in `wrangler.jsonc`.
- Workers have 128 MB memory; the whole PDF is held in memory, so stay well under ~50 MB per file.
- Request bodies are capped by your Cloudflare plan (100 MB on Free/Pro). For large files, upload to R2 first and pass `{ "key": … }`.
