import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { cropPicture, readPdf } from "./pdf";

/**
 * A one-page "slide" (400 × 300 points): a big striped picture with a label written over it, a
 * tiny icon, a plain grey panel (as slide designs place behind text boxes), and a title.
 */
function samplePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  /** A picture in red-and-white stripes, or one flat colour. */
  const picture = (w: number, h: number, striped: boolean) => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
    pix.clear(255);
    const samples = pix.getPixels();
    for (let i = 0; i < samples.length; i += 3) {
      const x = (i / 3) % w;
      samples.set(striped ? (Math.floor(x / 10) % 2 ? [255, 255, 255] : [200, 30, 30]) : [230, 230, 230], i);
    }
    return doc.addImage(new mupdf.Image(pix));
  };
  const resources = doc.addObject({
    XObject: { Big: picture(200, 100, true), Icon: picture(10, 10, true), Panel: picture(100, 50, false) },
    Font: { F1: doc.addSimpleFont(new mupdf.Font("Helvetica")) },
  });
  // PDF coordinates start at the bottom left: the picture spans x 100–300, y (from the top) 100–200.
  const contents = [
    "q 200 0 0 100 100 100 cm /Big Do Q",
    "q 10 0 0 10 5 5 cm /Icon Do Q",
    "q 100 0 0 50 290 10 cm /Panel Do Q",
    "BT /F1 14 Tf 110 150 Td (Vein with tumour) Tj ET",
    "BT /F1 18 Tf 100 250 Td (A slide title) Tj ET",
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, resources, contents));
  return doc.saveToBuffer("").asUint8Array();
}

describe("readPdf pictures", () => {
  const [page] = readPdf(samplePdf());

  it("finds the picture, not the tiny icon or the plain panel, and says where it sits on the slide", () => {
    expect(page.pictures).toHaveLength(1);
    expect(page.pictures[0].box).toEqual([0.25, 0.333, 0.75, 0.667]);
  });

  it("notes the label laid over the picture but not the title outside it", () => {
    expect(page.pictures[0].labels).toEqual(["Vein with tumour"]);
  });

  it("saves the picture on its own, without the label drawn over it", () => {
    const pix = new mupdf.Image(page.pictures[0].jpeg).toPixmap();
    const samples = pix.getPixels();
    // Every pixel is still the picture's red or white: no black label text came with it.
    let dark = 0;
    for (let i = 0; i < samples.length; i += 3) if (samples[i] < 120) dark++;
    expect([pix.getWidth(), pix.getHeight()]).toEqual([200, 100]);
    expect(dark).toBe(0);
  });

  it("crops part of a saved picture", () => {
    const crop = new mupdf.Image(cropPicture(page.pictures[0].jpeg, [0.5, 0, 1, 0.5]));
    expect([crop.getWidth(), crop.getHeight()]).toEqual([100, 50]);
    expect(() => cropPicture(page.pictures[0].jpeg, [0.5, 0.5, 0.51, 0.51])).toThrow();
  });

  it("finds no pictures when asked for text only", () => {
    expect(readPdf(samplePdf(), { images: false })[0].pictures).toEqual([]);
  });
});
