// Flags draft cards that closely match a card already in the collection.
// Word-overlap, not AI: a draft is a likely duplicate when most of its content words
// AND its answers already appear together in one existing card.

import { blanks, plainText } from "./cloze";
import type { ExistingNote } from "./style";

const STOP = new Set(
  "about above after again also among because been before being below between both caused causes cause does done down during each from have having into more most once only other over same should some such than that their them then there these they this those through under until very were what when where which while with would your include includes including used using".split(
    " ",
  ),
);

export function contentWords(text: string): Set<string> {
  return new Set(
    plainText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

export class DuplicateIndex {
  private words: Set<string>[] = [];
  private byWord = new Map<string, number[]>();

  constructor(private notes: ExistingNote[]) {
    notes.forEach((note, i) => {
      const ws = contentWords(note.text);
      this.words.push(ws);
      for (const w of ws) {
        const list = this.byWord.get(w);
        if (list) list.push(i);
        else this.byWord.set(w, [i]);
      }
    });
  }

  /** The best-matching existing card's plain text, or undefined when nothing is close. */
  find(draftText: string): string | undefined {
    const draft = contentWords(draftText);
    if (draft.size < 3) return undefined;
    const answerWords = new Set(blanks(draftText).flatMap((b) => [...contentWords(b.answer)]));

    const shared = new Map<number, number>();
    for (const w of draft) {
      const hits = this.byWord.get(w);
      // Very common words say little about a match; skip them for speed.
      if (!hits || hits.length > 3000) continue;
      for (const i of hits) shared.set(i, (shared.get(i) ?? 0) + 1);
    }

    let best: { i: number; score: number } | undefined;
    for (const [i, n] of shared) {
      if (n < 3) continue;
      const score = n / draft.size;
      if (score < 0.6) continue;
      const existing = this.words[i];
      const answersCovered = [...answerWords].every((w) => existing.has(w));
      if (!answersCovered) continue;
      if (!best || score > best.score) best = { i, score };
    }
    return best ? plainText(this.notes[best.i].text) : undefined;
  }
}

/** Flags cards that repeat an earlier card in the same run (e.g. two slides saying the same thing). */
export function flagRepeats<C extends { text: string; duplicateOf?: string }>(cards: C[]): C[] {
  return cards.map((card, i) => {
    if (card.duplicateOf || i === 0) return card;
    const earlier = new DuplicateIndex(cards.slice(0, i).map((c, id) => ({ id, text: c.text, notetype: "" })));
    const match = earlier.find(card.text);
    return match ? { ...card, duplicateOf: `Repeats an earlier card here: ${match}` } : card;
  });
}
