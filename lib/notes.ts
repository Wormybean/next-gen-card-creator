// Reviewed draft cards → Anki notes (fields, guid, tags). The .apkg export (lib/export.ts) and
// the add-on, which adds them straight to the collection, both build their notes here.

import type { ExportNote } from "./apkg";
import { clozeNumbers } from "./cloze";
import { backExtraField, frontField, type CardImage } from "./extras";
import { stableGuid } from "./guid";
import type { Job } from "./jobs";
import type { DraftCard } from "./rules";

/**
 * `mediaFor` puts a picture into Anki (or the .apkg) and returns its media file name. It is
 * called once per picture, however many cards use it.
 */
export async function draftToNotes(
  job: Job,
  tags: string[],
  cards: DraftCard[],
  mediaFor: (img: CardImage) => Promise<string>,
): Promise<ExportNote[]> {
  if (!cards.length) throw new Error("No cards to export");
  // Keyed by "slide:3" or "file:img-….png".
  const names = new Map<string, Promise<string>>();
  const nameOf = (img: CardImage) => {
    const source = img.file !== undefined ? `file:${img.file}` : `slide:${img.slide}`;
    if (!names.has(source)) names.set(source, mediaFor(img));
    return names.get(source)!;
  };

  const ordinals = new Map<string, number>();
  const notes: ExportNote[] = [];
  for (const card of cards) {
    if (!clozeNumbers(card.text).length) throw new Error(`Card has no blanks: ${card.text.slice(0, 60)}`);
    // Guid = lecture + slide/question + position within it, so exporting an edited or
    // regenerated slide again updates the cards already in Anki instead of duplicating them.
    const group = card.slide !== undefined ? `slide ${card.slide}` : `q ${card.question ?? ""}`;
    const ordinal = ordinals.get(group) ?? 0;
    ordinals.set(group, ordinal + 1);

    const front: string[] = [];
    const back: string[] = [];
    for (const img of card.images ?? []) {
      if (!img.off) (img.front ? front : back).push(await nameOf(img));
    }

    notes.push({
      guid: stableGuid(job.name, group, ordinal),
      text: frontField(card.text, front),
      backExtra: backExtraField({ question: card.question, why: card.why, definitions: card.definitions, backImages: back }),
      tags,
    });
  }
  return notes;
}
