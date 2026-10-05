import { PDFDocument, PDFImage, PDFPage, degrees } from "@cantoo/pdf-lib";

export type ImageKind = "png" | "jpeg";

export function imageKind(bytes: Uint8Array): ImageKind | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return undefined;
}

export async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<{ image: PDFImage; orientation: number }> {
  const kind = imageKind(bytes);
  if (kind === "png") return { image: await doc.embedPng(bytes), orientation: 1 };
  if (kind === "jpeg") return { image: await doc.embedJpg(bytes), orientation: jpegOrientation(bytes) };
  throw new Error("Image must be PNG or JPEG");
}

/** Reads the EXIF orientation tag (1-8) from a JPEG; 1 when absent. Phone photos often use 6. */
export function jpegOrientation(b: Uint8Array): number {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1];
    const len = view.getUint16(off + 2);
    if (marker === 0xda) break; // start of image data: no more metadata
    if (marker === 0xe1 && off + 10 + 8 <= b.length && view.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const le = view.getUint16(tiff) === 0x4949;
      const u16 = (p: number) => view.getUint16(p, le);
      const ifd = tiff + view.getUint32(tiff + 4, le);
      if (ifd + 2 > b.length) return 1;
      for (let i = 0, n = u16(ifd); i < n; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > b.length) return 1;
        if (u16(entry) === 0x0112) {
          const o = u16(entry + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

/** Turns of 90° clockwise needed to show the image upright (mirrored orientations are treated as their rotation). */
function quarterTurns(orientation: number): number {
  return { 3: 2, 4: 2, 5: 1, 6: 1, 7: 3, 8: 3 }[orientation] ?? 0;
}

/** The image's width and height once shown upright. */
export function uprightSize(image: PDFImage, orientation: number): [number, number] {
  return quarterTurns(orientation) % 2 ? [image.height, image.width] : [image.width, image.height];
}

/** Draws the image upright, scaled to fit inside the box and centred in it. */
export function drawImageInBox(
  page: PDFPage,
  image: PDFImage,
  orientation: number,
  box: { x: number; y: number; width: number; height: number },
  opacity?: number,
) {
  const [uw, uh] = uprightSize(image, orientation);
  const s = Math.min(box.width / uw, box.height / uh);
  const [w, h] = [uw * s, uh * s]; // upright size on the page
  const X = box.x + (box.width - w) / 2;
  const Y = box.y + (box.height - h) / 2;
  // pdf-lib rotates counter-clockwise around (x, y); pick the corner that lands the image on (X, Y, w, h).
  switch (quarterTurns(orientation)) {
    case 1: // 90° clockwise: stored width runs downwards
      return page.drawImage(image, { x: X, y: Y + h, width: h, height: w, rotate: degrees(-90), opacity });
    case 2:
      return page.drawImage(image, { x: X + w, y: Y + h, width: w, height: h, rotate: degrees(180), opacity });
    case 3: // 90° counter-clockwise
      return page.drawImage(image, { x: X + w, y: Y, width: h, height: w, rotate: degrees(90), opacity });
    default:
      return page.drawImage(image, { x: X, y: Y, width: w, height: h, opacity });
  }
}

/**
 * Adds a page holding the image. `size` "image" makes the page the image's size
 * (1 px = 1 pt); otherwise the image is fitted on that paper size, turned to
 * landscape when the image is wider than tall.
 */
export async function addImagePage(
  doc: PDFDocument,
  bytes: Uint8Array,
  size: [number, number] | "image",
  margin: number,
  at?: number,
): Promise<void> {
  const { image, orientation } = await embedImage(doc, bytes);
  const [uw, uh] = uprightSize(image, orientation);
  let [pw, ph] = size === "image" ? [uw + 2 * margin, uh + 2 * margin] : size;
  if (size !== "image" && uw > uh !== pw > ph) [pw, ph] = [ph, pw];
  const page = at === undefined ? doc.addPage([pw, ph]) : doc.insertPage(at, [pw, ph]);
  drawImageInBox(page, image, orientation, { x: margin, y: margin, width: pw - 2 * margin, height: ph - 2 * margin });
}
