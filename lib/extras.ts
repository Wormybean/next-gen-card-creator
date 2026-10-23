// What a card carries besides its cloze text: pictures and term definitions.
// Plain logic only (no Next.js, no storage), so it can move to an Anki add-on as is.

import { stripHtml } from "./cloze";

/** A picture on a card: a whole lecture slide, or a file saved with the job (a slide crop or a paste). */
export type CardImage = {
  id: string;
  /** Shown above the cloze text instead of on the back. */
  front: boolean;
  /** Added automatically (the card's own slide), not by the user. */
  auto?: boolean;
  /** Unticked: kept on the card's list but left out of the export. */
  off?: boolean;
} & ({ slide: number; file?: undefined } | { file: string; slide?: undefined });

export type Definition = { term: string; definition: string };

/** Pictures are stored at most this wide; wider ones are scaled down before upload. */
export const MAX_IMAGE_WIDTH = 1000;

/** Picture file names: uploaded ("img-<uuid>.<ext>"), or cut out of slide 3 ("pic-3-0.jpg"). */
export const IMAGE_FILE = /^(img-[0-9a-f-]{36}|pic-\d+-\d+)\.(png|jpg|webp|gif)$/;

/**
 * The term to define from a selection in the card's text box: cloze syntax, hints and HTML
 * are stripped, so selecting "{{c1::insulin resistance::MOA}}" gives "insulin resistance".
 */
export function selectedTerm(text: string, start: number, end: number): string {
  let s = text.slice(start, end);
  // Whole blanks → their answer.
  s = s.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1");
  // A selection that starts or ends partway through a blank: drop the leftover pieces.
  s = s
    .replace(/\{\{c\d*:*/g, "")
    .replace(/::[^:{}]*\}\}/g, "")
    .replace(/\}\}/g, "")
    .replace(/::[^:{}]*$/, "");
  return stripHtml(s)
    .replace(/^[\s.,;:!?()[\]"'“”‘’]+|[\s.,;:!?()[\]"'“”‘’]+$/g, "")
    .trim();
}

const sameTerm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A definition already written for this term on any of the cards (reused instead of asking the AI again). */
export function knownDefinition(cards: { definitions?: Definition[] }[], term: string): string | undefined {
  for (const c of cards) {
    const hit = c.definitions?.find((d) => sameTerm(d.term, term) && d.definition.trim());
    if (hit) return hit.definition;
  }
  return undefined;
}

/** Definitions from several cards, keeping the first of any repeated term. */
export function mergeDefinitions(lists: (Definition[] | undefined)[]): Definition[] {
  const out: Definition[] = [];
  for (const d of lists.flatMap((l) => l ?? [])) {
    if (!out.some((o) => sameTerm(o.term, d.term))) out.push(d);
  }
  return out;
}

const imageSource = (img: CardImage) => (img.file !== undefined ? `file:${img.file}` : `slide:${img.slide}`);

/** Pictures from several cards, keeping each picture once. */
export function mergeImages(lists: (CardImage[] | undefined)[]): CardImage[] {
  const out: CardImage[] = [];
  for (const img of lists.flatMap((l) => l ?? [])) {
    if (!out.some((o) => imageSource(o) === imageSource(img))) out.push(img);
  }
  return out;
}

/** What the user added by hand to some cards, which regenerating them would throw away. */
export function handAdded(cards: { images?: CardImage[]; definitions?: Definition[] }[]) {
  return {
    images: cards.reduce((n, c) => n + (c.images ?? []).filter((i) => !i.auto && !i.off).length, 0),
    definitions: cards.reduce((n, c) => n + (c.definitions ?? []).filter((d) => d.term.trim()).length, 0),
  };
}

/** A lecture card's own slide on the back: every lecture card starts with one. */
export const ownSlide = (slide: number): CardImage => ({ id: crypto.randomUUID(), slide, front: false, auto: true });

type SlideCard = { slide?: number; images: CardImage[] };

export const hasOwnSlide = (card: SlideCard) =>
  card.slide !== undefined && card.images.some((i) => i.slide === card.slide && !i.off);

/** Puts the card's own slide on (adding it if it isn't listed) or ticks it off. */
export function setOwnSlide<T extends SlideCard>(card: T, on: boolean): T {
  if (card.slide === undefined || on === hasOwnSlide(card)) return card;
  const listed = card.images.some((i) => i.slide === card.slide);
  return {
    ...card,
    images: listed
      ? card.images.map((i) => (i.slide === card.slide ? { ...i, off: !on } : i))
      : [...card.images, ownSlide(card.slide)],
  };
}

/** Drafts saved before pictures became a list had a single "slide image on back" tick. */
export function migrateCard<T extends { images?: CardImage[]; useImage?: boolean; slide?: number; id: string }>(
  card: T,
): Omit<T, "useImage"> & { images: CardImage[] } {
  const { useImage, ...rest } = card;
  if (card.images) return { ...rest, images: card.images };
  const images: CardImage[] =
    useImage && card.slide !== undefined ? [{ id: `${card.id}-slide`, slide: card.slide, front: false, auto: true }] : [];
  return { ...rest, images };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `<img>` for a picture already in Anki's media folder: fits a phone's width, takes at most about half
 * the card's height (a whole slide shouldn't swamp the answer), with a gap from the text. */
export const imgTag = (mediaName: string) =>
  `<img src="${mediaName}" style="max-width:100%;max-height:55vh;margin:20px 0">`;

/** The Text field: front pictures above the cloze text. */
export function frontField(text: string, frontImages: string[]): string {
  return frontImages.length ? `${frontImages.map(imgTag).join("<br>")}<br>${text}` : text;
}

/** The Back Extra field: CSBL question → why line → definitions → back pictures. */
export function backExtraField(parts: {
  question?: string;
  why?: string;
  definitions?: Definition[];
  backImages: string[];
}): string {
  const back: string[] = [];
  if (parts.question) back.push(`<i>Q: ${escapeHtml(parts.question)}</i>`);
  if (parts.why) back.push(escapeHtml(parts.why));
  for (const d of parts.definitions ?? []) {
    if (d.term.trim() && d.definition.trim()) back.push(`<b>${escapeHtml(d.term.trim())}</b>: ${escapeHtml(d.definition.trim())}`);
  }
  back.push(...parts.backImages.map(imgTag));
  return back.join("<br>");
}
