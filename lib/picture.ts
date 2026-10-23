// Browser only: crops and scales pictures before they are uploaded, so every card picture
// is at most MAX_IMAGE_WIDTH wide and the server never has to decode images.

import { MAX_IMAGE_WIDTH } from "./extras";

type PictureType = "image/png" | "image/jpeg";

/** Draws a region of a picture, scaled down to MAX_IMAGE_WIDTH if wider, and encodes it. */
export function renderPicture(
  source: CanvasImageSource,
  region: { x: number; y: number; w: number; h: number },
  type: PictureType,
): Promise<Blob> {
  const scale = Math.min(1, MAX_IMAGE_WIDTH / region.w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.w * scale));
  canvas.height = Math.max(1, Math.round(region.h * scale));
  const ctx = canvas.getContext("2d")!;
  // JPEG has no transparency: put see-through parts on white, like a slide.
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that picture"))), type, 0.9),
  );
}

/** A pasted or dropped picture, scaled down. Screenshots and diagrams stay PNG; photos become JPEG. */
export async function pictureFromFile(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't a picture this app can read");
  });
  try {
    const type = file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg";
    return await renderPicture(bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, type);
  } finally {
    bitmap.close();
  }
}

/** A region of a slide already shown in an <img>, given as fractions of its size (0–1). */
export function cropSlide(img: HTMLImageElement, area: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  return renderPicture(img, { x: area.x * W, y: area.y * H, w: area.w * W, h: area.h * H }, "image/png");
}
