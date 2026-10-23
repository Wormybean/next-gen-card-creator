// Turns reviewed draft cards into an .apkg.

import { buildApkg, mediaName, type MediaFile } from "./apkg";
import { pictureFile, type Job } from "./jobs";
import { draftToNotes } from "./notes";
import type { DraftCard } from "./rules";

export async function exportCards(job: Job, deck: string, tags: string[], cards: DraftCard[]): Promise<Uint8Array> {
  const media = new Map<string, MediaFile>();
  const notes = await draftToNotes(job, tags, cards, async (img) => {
    const data = await pictureFile(job.id, img);
    const name = mediaName(data, img.file?.split(".").pop() ?? "png");
    media.set(name, { name, data });
    return name;
  });
  return buildApkg({ deckName: deck, notes, media: [...media.values()] });
}
