// Small helpers for reading cloze text: {{c1::answer}} or {{c1::answer::hint}}.

const CLOZE_RE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g;

export type Blank = { num: number; answer: string; hint?: string };

export function blanks(text: string): Blank[] {
  return [...text.matchAll(CLOZE_RE)].map((m) => ({ num: Number(m[1]), answer: m[2], hint: m[3] }));
}

/** Distinct cloze numbers in a note; each one becomes a separate card in Anki. */
export function clozeNumbers(text: string): number[] {
  return [...new Set(blanks(text).map((b) => b.num))].sort((a, b) => a - b);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The card as plain words, with every blank filled in with its answer. */
export function plainText(text: string): string {
  return stripHtml(text.replace(CLOZE_RE, (_m, _n, answer) => answer));
}

export function wordCount(text: string): number {
  const plain = plainText(text);
  return plain ? plain.split(" ").length : 0;
}

export type TextEdit = { text: string; selStart: number; selEnd: number };

/**
 * Where each character you can see in the card's preview sits in its raw text, as
 * [start, end) pairs. Tags, cloze markup ("{{c1::", "::hint}}", "}}") aren't visible, and an
 * entity like "&amp;" is one visible character.
 */
function visibleChars(text: string): [number, number][] {
  const out: [number, number][] = [];
  let inBlank = false;
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i);
    const open = /^\{\{c\d+::/.exec(rest);
    if (open) {
      inBlank = true;
      i += open[0].length;
    } else if (inBlank && rest.startsWith("}}")) {
      inBlank = false;
      i += 2;
    } else if (inBlank && rest.startsWith("::")) {
      // A hint: hidden up to the blank's end.
      const close = text.indexOf("}}", i);
      inBlank = false;
      i = close === -1 ? text.length : close + 2;
    } else if (text[i] === "<" && text.indexOf(">", i) !== -1) {
      i = text.indexOf(">", i) + 1;
    } else {
      const entity = /^&(#\d+|#x[0-9a-f]+|\w+);/i.exec(rest);
      const len = entity ? entity[0].length : 1;
      out.push([i, i + len]);
      i += len;
    }
  }
  return out;
}

/** A selection made in the preview (counted in visible characters) as positions in the raw text. */
export function rawRange(text: string, start: number, end: number): { start: number; end: number } {
  const chars = visibleChars(text);
  const from = (v: number) => (v < chars.length ? chars[v][0] : text.length);
  if (end <= start || !chars.length) return { start: from(start), end: from(start) };
  const to = chars[Math.min(end, chars.length) - 1][1];
  return { start: from(start), end: to };
}

/**
 * Wraps the selected text in a blank, like Anki's cloze button. "same" reuses the highest
 * number already on the card (hidden together); "new" uses the next number (its own card).
 * With nothing selected, inserts an empty blank and leaves the cursor inside it.
 */
export function addCloze(text: string, start: number, end: number, mode: "same" | "new"): TextEdit {
  const nums = clozeNumbers(text);
  const highest = nums.length ? nums[nums.length - 1] : 0;
  const num = mode === "new" || highest === 0 ? highest + 1 : highest;
  // Keep surrounding spaces outside the blank.
  let s = start;
  let e = end;
  while (s < e && text[s] === " ") s++;
  while (e > s && text[e - 1] === " ") e--;
  const open = `{{c${num}::`;
  const selected = text.slice(s, e);
  const out = text.slice(0, s) + open + selected + "}}" + text.slice(e);
  return selected
    ? { text: out, selStart: s + open.length + selected.length + 2, selEnd: s + open.length + selected.length + 2 }
    : { text: out, selStart: s + open.length, selEnd: s + open.length };
}

/**
 * Gives the n-th blank on the card (counting from 0) another cloze number: a number already on
 * the card hides it together with those blanks; a new one makes it its own card.
 */
export function setBlankNumber(text: string, index: number, num: number): string {
  let k = 0;
  return text.replace(/\{\{c\d+::/g, (open) => (k++ === index ? `{{c${num}::` : open));
}

/** Removes the blank the cursor is in, keeping its answer text (drops any hint). */
export function removeCloze(text: string, cursor: number): TextEdit | null {
  for (const m of text.matchAll(CLOZE_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (cursor >= from && cursor <= to) {
      const answer = m[2];
      return { text: text.slice(0, from) + answer + text.slice(to), selStart: from, selEnd: from + answer.length };
    }
  }
  return null;
}

/**
 * Joins several cards' text into one, renumbering blanks so no two cards share a number:
 * each card's numbers are mapped in order onto the next free ones (c1,c3 then c1 → c1,c2,c3).
 * Blanks that shared a number inside one card still share one.
 */
export function combineCloze(texts: string[]): string {
  let next = 0;
  return texts
    .map((text) => {
      const map = new Map<number, number>();
      for (const n of clozeNumbers(text)) map.set(n, ++next);
      return text.replace(/\{\{c(\d+)::/g, (_m, n) => `{{c${map.get(Number(n))}::`);
    })
    .join("<br><br>");
}
