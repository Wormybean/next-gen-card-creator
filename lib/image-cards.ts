// Turns the AI's image card picks into cards (GLOSSARY.md: image card). The front shows the
// picture cut out of the slide without the labels drawn over it (lib/pdf.ts), cropped to the
// medical image the AI boxed; the whole slide goes on the back, as on every lecture card.

import { ownSlide } from "./extras";
import type { ImageCardIdea } from "./generate";
import { imageFile, saveImage, type Job, type StoredPicture } from "./jobs";
import { cropPicture } from "./pdf";
import { checkCard, type DraftCard } from "./rules";

type Box = [number, number, number, number];

const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** The slide's stored picture that most of the box falls in, if any. */
function pictureUnder(pictures: StoredPicture[], box: Box): StoredPicture | undefined {
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  const best = [...pictures].sort((a, b) => overlap(b.box, box) - overlap(a.box, box))[0];
  return best && area > 0 && overlap(best.box, box) / area >= 0.5 ? best : undefined;
}

/** The box (fractions of the slide) as fractions of the picture, or null when it is the whole picture anyway. */
function cropWithin(picture: Box, box: Box): Box | null {
  const w = picture[2] - picture[0];
  const h = picture[3] - picture[1];
  const rel: Box = [(box[0] - picture[0]) / w, (box[1] - picture[1]) / h, (box[2] - picture[0]) / w, (box[3] - picture[1]) / h];
  const clamped = rel.map((v) => Math.min(Math.max(v, 0), 1)) as Box;
  const whole = clamped[0] <= 0.03 && clamped[1] <= 0.03 && clamped[2] >= 0.97 && clamped[3] >= 0.97;
  return whole ? null : clamped;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One card per pick whose box lies on a real picture of the slide. A pick on something that
 * isn't a picture in the PDF (a chart drawn as shapes, say) is dropped.
 */
export async function makeImageCards(job: Job, ideas: ImageCardIdea[]): Promise<DraftCard[]> {
  const cards: DraftCard[] = [];
  for (const idea of ideas) {
    const picture = pictureUnder(job.slides[idea.slide]?.pictures ?? [], idea.box);
    if (!picture) continue;
    try {
      const crop = cropWithin(picture.box, idea.box);
      const original = await imageFile(job.id, picture.file);
      const file = crop ? await saveImage(job.id, cropPicture(original, crop), "image/jpeg") : picture.file;
      const text = `<b>Identify</b> (${escapeHtml(idea.hint)}): {{c1::${escapeHtml(idea.condition)}}}`;
      cards.push({
        id: crypto.randomUUID(),
        slide: idea.slide,
        text,
        why: idea.features || undefined,
        images: [{ id: crypto.randomUUID(), file, front: true }, ownSlide(idea.slide)],
        priority: 1,
        imageCard: { condition: idea.condition, headline: idea.headline, ...(idea.answerShows && { answerShows: true }) },
        warnings: checkCard(text),
      });
    } catch {
      // A picture that can't be cropped just doesn't get a card.
    }
  }
  return cards;
}
