// Making cards for a lecture: its slides split into requests, several sent at once, each
// request's result kept in slide order. The page and the speed tests (scripts/bench.ts) both
// run lectures through here, so the tests time exactly what the app does.

import { flagRepeats } from "./dedupe";
import { applyTarget, cardTarget, type DraftCard, type LectureType } from "./rules";
import type { GenerateResult, OnProgress, Progress } from "./service";

export type Thinking = "minimal" | "low" | "medium" | "high";
const THINKING: Thinking[] = ["minimal", "low", "medium", "high"];

/** How cards are written. The app uses DEFAULT_SETTINGS; the speed tests try others. */
export type CardSettings = {
  /**
   * Slides per request. Smaller requests sent side by side finish sooner: 15 took a 45-slide
   * lecture from 77 s to 47 s on Claude Haiku, with the same coverage (speed tests, 2026-10-23).
   */
  slidesPerRequest: number;
  /**
   * Requests sent at once. Each takes a minute or more, so running them side by side is what
   * makes a long upload quick; four covers 60 slides in one go and stays under Gemini's free
   * tier's per-minute limits (a request turned away for those moves on to the next model).
   */
  atOnce: number;
  /**
   * How much the AI thinks while writing cards. "low" halved Claude Haiku's time and cost against
   * "high", with the same coverage (speed tests, 2026-10-23).
   */
  thinking: Thinking;
  /** The tidy pass, which rewrites only cards that break the rulebook: how much it thinks, or "off". */
  tidyPass: Thinking | "off";
  /** How much detail Gemini takes from each slide picture; "default" leaves it to Gemini. OpenRouter ignores it. */
  pictures: "default" | "medium" | "low";
  /** The text of every slide sent with each request for context, or only the request's own slides. */
  context: "all" | "none";
};

export const DEFAULT_SETTINGS: CardSettings = {
  slidesPerRequest: 15,
  atOnce: 4,
  thinking: "low",
  tidyPass: "low",
  pictures: "default",
  context: "all",
};

/** Settings from a request (the website's server gets them from the page), checked and completed with the defaults. */
export function cardSettings(input?: Partial<CardSettings>): CardSettings {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const whole = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  if (!whole(s.slidesPerRequest, 200) || !whole(s.atOnce, 10)) throw new Error("Bad request size settings");
  if (!THINKING.includes(s.thinking) || !(s.tidyPass === "off" || THINKING.includes(s.tidyPass)))
    throw new Error("Bad thinking setting");
  if (!["default", "medium", "low"].includes(s.pictures) || !["all", "none"].includes(s.context))
    throw new Error("Bad picture or context setting");
  return s;
}

/** The slides, in order, as one list per request. */
export function splitSlides(slides: number[], perRequest: number): number[][] {
  const requests: number[][] = [];
  for (let i = 0; i < slides.length; i += perRequest) requests.push(slides.slice(i, i + perRequest));
  return requests;
}

/** What happens to each request (by its place in the list), for progress screens and timing. */
export type RequestEvents = {
  onStart?: (request: number) => void;
  onProgress?: (request: number, progress: Progress) => void;
  /** `result` is null when the request failed. */
  onDone?: (request: number, result: GenerateResult | null, error?: Error) => void;
};

export type LectureRun = {
  /** Each request's result, in the order of the requests; null where it failed. */
  results: (GenerateResult | null)[];
  /** Slides whose request failed, to retry later. */
  failed: number[];
  lastError: string;
};

/**
 * Sends the requests, `atOnce` at a time. A failed request doesn't sink the run: its slides are
 * listed in `failed`, to be retried from the review screen.
 */
export async function writeLecture(
  requests: number[][],
  write: (slides: number[], onProgress: OnProgress) => Promise<GenerateResult>,
  atOnce: number,
  events: RequestEvents = {},
): Promise<LectureRun> {
  const results: (GenerateResult | null)[] = requests.map(() => null);
  const failed: number[] = [];
  let lastError = "";
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(atOnce, requests.length) }, async () => {
      while (next < requests.length) {
        const mine = next++;
        events.onStart?.(mine);
        try {
          results[mine] = await write(requests[mine], (p) => events.onProgress?.(mine, p));
          events.onDone?.(mine, results[mine]);
        } catch (e) {
          failed.push(...requests[mine]);
          lastError = (e as Error).message;
          events.onDone?.(mine, null, e as Error);
        }
      }
    }),
  );
  return { results, failed: failed.sort((a, b) => a - b), lastError };
}

/** Slides with real content (15 words or more): what the "about 1 card per content slide" target counts. */
export const contentSlides = (slides: { text: string }[]) =>
  slides.filter((s) => s.text.split(/\s+/).filter(Boolean).length >= 15).length;

/** "Benign prostatic hyperplasia (BPH)" and "benign prostatic hyperplasia" are the same condition. */
const conditionKey = (condition: string) =>
  condition
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The most image cards a lecture gets: about one per 10 slides (GLOSSARY.md: image card). */
export const imageCardCeiling = (slideCount: number) => Math.ceil(slideCount / 10);

/**
 * At most one image card per condition and no more than the ceiling, keeping conditions that
 * head a case or section first, then the earlier slide. Other cards pass through untouched.
 */
export function limitImageCards<C extends DraftCard>(cards: C[], slideCount: number): C[] {
  const seen = new Set<string>();
  const keep = new Set(
    cards
      .filter((c) => c.imageCard)
      .sort((a, b) => Number(!!b.imageCard!.headline) - Number(!!a.imageCard!.headline) || (a.slide ?? 0) - (b.slide ?? 0))
      .filter((c) => {
        const key = conditionKey(c.imageCard!.condition);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, imageCardCeiling(slideCount)),
  );
  return cards.filter((c) => !c.imageCard || keep.has(c));
}

/**
 * Flags cards that repeat an earlier one in the lecture. Image cards are left out: naming a
 * picture is a different skill from recalling a fact, even about the same condition.
 */
export function flagTextRepeats<C extends DraftCard>(cards: C[]): C[] {
  const flagged = flagRepeats(cards.filter((c) => !c.imageCard));
  let i = 0;
  return cards.map((c) => (c.imageCard ? c : flagged[i++]));
}

/**
 * The lecture's cards from all its requests, as the student first sees them: repeats within the
 * lecture flagged, the lowest-priority cards beyond the lecture type's target marked "maybe",
 * and image cards limited, on top of the target.
 */
export function lectureCards(run: LectureRun, type: LectureType, slides: { text: string }[]): DraftCard[] {
  const all = limitImageCards(flagTextRepeats(run.results.flatMap((r) => r?.cards ?? [])), slides.length);
  const marked = applyTarget(
    all.filter((c) => !c.imageCard),
    cardTarget(type, contentSlides(slides)),
  );
  let i = 0;
  return all.map((c) => (c.imageCard ? { ...c, maybe: false } : marked[i++]));
}
