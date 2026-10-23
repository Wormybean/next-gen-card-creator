// Turns a PDF into one picture + the text for each page, and lists its web links.

import * as mupdf from "mupdf";

/** A picture on a slide (a photo, scan or screenshot), saved on its own without the text drawn over it. */
export type SlidePicture = {
  /** Where it sits on the slide, as fractions of the slide: [left, top, right, bottom]. */
  box: [number, number, number, number];
  jpeg: Uint8Array;
  /** Slide text drawn over the picture (labels, captions), which the saved picture leaves out. */
  labels: string[];
};

export type PdfPage = { index: number; text: string; png: Uint8Array; pictures: SlidePicture[] };

/** Slides render at ~1280px wide: sharp enough to read, small enough for the AI and Anki. */
const TARGET_WIDTH = 1280;
/** Pictures smaller than this share of the slide are logos and icons, not worth a card of their own. */
const MIN_PICTURE_AREA = 0.04;
/** A saved picture is at most this many pixels on its longer side. */
const MAX_PICTURE_SIDE = 1280;
/**
 * Below this spread of brightness (0–255) a picture is close to one colour: a panel behind a text
 * box, or its drop shadow, which slide designs often place as images. Photos, scans and
 * histology are far above it.
 */
const MIN_PICTURE_CONTRAST = 12;

/** The spread (standard deviation) of brightness over a sample of the pixmap's pixels. */
function contrast(pix: mupdf.Pixmap): number {
  const samples = pix.getPixels();
  const n = pix.getNumberOfComponents();
  const step = Math.max(1, Math.floor(samples.length / n / 4000)) * n;
  let count = 0;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i + 2 < samples.length; i += step) {
    const y = 0.299 * samples[i] + 0.587 * samples[i + 1] + 0.114 * samples[i + 2];
    count++;
    sum += y;
    squares += y * y;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, squares / count - mean * mean));
}

/**
 * The slide's pictures, each drawn on its own from the image embedded in the PDF, so labels and
 * captions laid over it on the slide are left out. Text printed inside the image itself (a
 * screenshot of another slide, say) can't be told apart from the picture and stays in it.
 */
function slidePictures(page: mupdf.Page): SlidePicture[] {
  const [px0, py0, px1, py1] = page.getBounds();
  const width = px1 - px0;
  const height = py1 - py0;
  const found: { bbox: mupdf.Rect; transform: mupdf.Matrix; image: mupdf.Image }[] = [];
  const lines: { bbox: mupdf.Rect; text: string }[] = [];
  let line: { bbox: mupdf.Rect; text: string } | null = null;
  const text = page.toStructuredText("preserve-images");
  text.walk({
    onImageBlock: (bbox, transform, image) => found.push({ bbox, transform, image }),
    beginLine: (bbox) => (line = { bbox, text: "" }),
    onChar: (c) => {
      if (line) line.text += c;
    },
    endLine: () => {
      if (line?.text.trim()) lines.push({ bbox: line.bbox, text: line.text.trim() });
      line = null;
    },
  });
  text.destroy();

  const pictures: SlidePicture[] = [];
  for (const { bbox, transform, image } of found) {
    const [x0, y0, x1, y1] = [Math.max(bbox[0], px0), Math.max(bbox[1], py0), Math.min(bbox[2], px1), Math.min(bbox[3], py1)];
    const [a, b, c, d] = transform;
    // Rotated pictures are rare on slides and can't be drawn upright this simply.
    if (b !== 0 || c !== 0 || x1 <= x0 || y1 <= y0) continue;
    if (((x1 - x0) * (y1 - y0)) / (width * height) < MIN_PICTURE_AREA) continue;
    const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(image.getWidth(), image.getHeight()));
    const w = Math.max(1, Math.round(image.getWidth() * scale));
    const h = Math.max(1, Math.round(image.getHeight() * scale));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    pix.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    // Drawn onto white, so see-through pictures don't turn black; a flipped placement stays flipped.
    device.fillImage(image, [a < 0 ? -w : w, 0, 0, d < 0 ? -h : h, a < 0 ? w : 0, d < 0 ? h : 0], 1);
    device.close();
    device.destroy();
    const flat = contrast(pix) < MIN_PICTURE_CONTRAST;
    const jpeg = flat ? null : pix.asJPEG(85);
    pix.destroy();
    if (!jpeg) continue;
    const inside = (r: mupdf.Rect) => {
      const cx = (r[0] + r[2]) / 2;
      const cy = (r[1] + r[3]) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    };
    const round = (v: number) => Math.round(v * 1000) / 1000;
    pictures.push({
      box: [round((x0 - px0) / width), round((y0 - py0) / height), round((x1 - px0) / width), round((y1 - py0) / height)],
      jpeg,
      labels: lines.filter((l) => inside(l.bbox)).map((l) => l.text),
    });
  }
  return pictures;
}

/** Part of a saved picture, `box` given as fractions of it ([left, top, right, bottom]), as a JPEG. */
export function cropPicture(jpeg: Uint8Array, box: [number, number, number, number]): Uint8Array {
  const image = new mupdf.Image(jpeg);
  const w = image.getWidth();
  const h = image.getHeight();
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  const [x0, y0, x1, y1] = [Math.round(clamp(box[0]) * w), Math.round(clamp(box[1]) * h), Math.round(clamp(box[2]) * w), Math.round(clamp(box[3]) * h)];
  if (x1 - x0 < 8 || y1 - y0 < 8) throw new Error("Crop too small");
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, x1 - x0, y1 - y0], false);
  pix.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  device.fillImage(image, [w, 0, 0, h, -x0, -y0], 1);
  device.close();
  device.destroy();
  const out = pix.asJPEG(88);
  pix.destroy();
  image.destroy();
  return out;
}

export function readPdf(data: Uint8Array, { images = true } = {}): PdfPage[] {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  try {
    const pages: PdfPage[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const text = page.toStructuredText("preserve-whitespace").asText().trim();
      let png: Uint8Array = new Uint8Array();
      let pictures: SlidePicture[] = [];
      if (images) {
        const [x0, , x1] = page.getBounds();
        const scale = TARGET_WIDTH / (x1 - x0);
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        png = pix.asPNG();
        pix.destroy();
        pictures = slidePictures(page);
      }
      pages.push({ index: i, text, png, pictures });
      page.destroy();
    }
    return pages;
  } finally {
    doc.destroy();
  }
}

/** Every external link in the PDF: clickable links plus bare URLs written in the text. */
export function pdfLinks(data: Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const urls = new Set<string>();
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      for (const link of page.getLinks()) {
        if (link.isExternal()) urls.add(link.getURI());
      }
      const text = page.toStructuredText("preserve-whitespace").asText();
      for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) urls.add(m[0].replace(/[.,;]$/, ""));
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
  // URLs wrapped across lines come out cut short; drop any that is a prefix of a full one.
  const all = [...urls].filter((u) => u.startsWith("http"));
  return all.filter((u) => !all.some((other) => other !== u && other.startsWith(u)));
}
