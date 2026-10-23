// What the collection lends to card writing: existing cloze notes, for the duplicate check
// and as style examples. The same in the web version (read from a copy of the collection)
// and the add-on (read from the open collection).

import { OWN_NOTETYPES } from "./notetype";

export type ExistingNote = { id: number; text: string; notetype: string };

export type StyleExamples = { mine: string[]; ish: string[] };

/** Up to 25 of your own cards (OWN_NOTETYPES) and 12 "Ish" ones, most recently changed first. */
export function styleExamplesFrom(clozeNotes: ExistingNote[]): StyleExamples {
  const usable = (n: ExistingNote) => n.text.length > 30 && n.text.length < 400;
  const mine = clozeNotes.filter((n) => OWN_NOTETYPES.includes(n.notetype) && usable(n)).slice(0, 25);
  const ish = clozeNotes.filter((n) => n.notetype.startsWith("Ish") && usable(n) && n.text.includes("::")).slice(0, 12);
  return { mine: mine.map((n) => n.text), ish: ish.map((n) => n.text) };
}
