// lib/collection.ts for the add-on: read from the open collection through Python. The card
// code asks for it synchronously, so the page loads it once (loadCollection) and then again
// after cards are added.

import { styleExamplesFrom, type ExistingNote, type StyleExamples } from "../../../lib/style";
import { py } from "./bridge";

export type { ExistingNote };

type Snapshot = {
  decks: string[];
  /** The deck selected in Anki ("" when it's the Default deck). */
  currentDeck: string;
  clozeNotes: ExistingNote[];
  styleExamples: StyleExamples;
};

let snapshot: Snapshot = { decks: [], currentDeck: "", clozeNotes: [], styleExamples: { mine: [], ish: [] } };

export async function loadCollection(): Promise<void> {
  const read = await py<Omit<Snapshot, "styleExamples">>("collection");
  snapshot = { ...read, styleExamples: styleExamplesFrom(read.clozeNotes) };
}

export const hasCollection = () => true;

export const collection = {
  decks: () => snapshot.decks,
  currentDeck: () => snapshot.currentDeck,
  clozeNotes: () => snapshot.clozeNotes,
  styleExamples: () => snapshot.styleExamples,
};
