import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, cardSettings, imageCardCeiling, lectureCards, limitImageCards, splitSlides, writeLecture } from "./lecture-run";
import type { DraftCard } from "./rules";
import type { GenerateResult } from "./service";

const result = (slides: number[]): GenerateResult => ({
  cards: slides.map((s) => ({ id: `c${s}`, slide: s, text: `{{c1::${s}}}`, images: [], priority: 2, warnings: [] })),
  usage: { inputTokens: 0, outputTokens: 0 },
  keyPoints: [],
});
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("splitSlides", () => {
  it("cuts the slides into requests of the given size, in order", () => {
    expect(splitSlides([0, 1, 2, 3, 4], 2)).toEqual([[0, 1], [2, 3], [4]]);
    expect(splitSlides([], 30)).toEqual([]);
  });
});

describe("writeLecture", () => {
  it("never has more than atOnce requests out, and keeps results in request order", async () => {
    let out = 0;
    let most = 0;
    const requests = splitSlides([...Array(10).keys()], 2);
    const run = await writeLecture(
      requests,
      async (slides) => {
        most = Math.max(most, ++out);
        await tick();
        out--;
        return result(slides);
      },
      3,
    );
    expect(most).toBe(3);
    expect(run.results.map((r) => r?.cards.map((c) => c.slide))).toEqual(requests);
    expect(run.failed).toEqual([]);
  });

  it("lists a failed request's slides for retrying without sinking the rest", async () => {
    const done: (number | null)[] = [];
    const run = await writeLecture(
      [[0, 1], [2, 3], [4]],
      async (slides) => {
        if (slides[0] === 2) throw new Error("The AI is busy");
        return result(slides);
      },
      4,
      { onDone: (i, r) => done.push(r ? i : null) },
    );
    expect(run.results[1]).toBeNull();
    expect(run.results[2]?.cards).toHaveLength(1);
    expect(run.failed).toEqual([2, 3]);
    expect(run.lastError).toBe("The AI is busy");
    expect(done).toContain(null);
  });

  it("passes each request's progress on, tagged with which request it is", async () => {
    const heard: [number, string][] = [];
    await writeLecture(
      [[0], [1]],
      async (slides, onProgress) => {
        onProgress({ stage: "waiting" });
        return result(slides);
      },
      2,
      { onProgress: (i, p) => heard.push([i, p.stage]) },
    );
    expect(heard.sort()).toEqual([
      [0, "waiting"],
      [1, "waiting"],
    ]);
  });
});

const textCard = (slide: number, text: string, priority: 1 | 2 | 3 = 2): DraftCard => ({
  id: `t${slide}-${text}`,
  slide,
  text,
  images: [],
  priority,
  warnings: [],
});
const imageCard = (slide: number, condition: string, headline = true): DraftCard => ({
  id: `i${slide}-${condition}`,
  slide,
  text: `<b>Identify</b> (pancreas, histology): {{c1::${condition}}}`,
  images: [],
  priority: 1,
  imageCard: { condition, headline },
  warnings: [],
});
const runOf = (...requests: DraftCard[][]) => ({
  results: requests.map((cards) => ({ cards, usage: { inputTokens: 0, outputTokens: 0 }, keyPoints: [] })),
  failed: [],
  lastError: "",
});

describe("image card limits", () => {
  it("allows about one image card per 10 slides", () => {
    expect([20, 45, 66, 100].map(imageCardCeiling)).toEqual([2, 5, 7, 10]);
  });

  it("keeps one card per condition when two requests offer the same one", () => {
    const kept = limitImageCards(
      [imageCard(5, "Benign prostatic hyperplasia (BPH)"), imageCard(40, "benign prostatic hyperplasia"), imageCard(41, "Prostate cancer")],
      45,
    );
    expect(kept.map((c) => c.slide)).toEqual([5, 41]);
  });

  it("keeps conditions that head a case first when there are more than the ceiling allows", () => {
    const kept = limitImageCards(
      [imageCard(1, "Renal tumour", false), imageCard(2, "Ureteric stone"), imageCard(3, "Torsion"), imageCard(4, "Bladder tumour")],
      30,
    );
    expect(kept.map((c) => c.imageCard!.condition)).toEqual(["Ureteric stone", "Torsion", "Bladder tumour"]);
  });

  it("puts image cards on top of the target and never marks them maybe or as repeats", () => {
    // 20 slides of 15+ words → a medical science target of 20; 25 text cards go over it.
    const slides = Array.from({ length: 20 }, () => ({ text: "word ".repeat(20) }));
    const text = Array.from({ length: 25 }, (_, i) => textCard(i % 20, `Fact number ${i} about {{c1::thing ${i}}}`, i < 20 ? 1 : 3));
    const cards = lectureCards(runOf(text, [imageCard(3, "PDAC"), imageCard(9, "Pancreatic NET")]), "medical-science", slides);
    expect(cards.filter((c) => c.maybe)).toHaveLength(5);
    expect(cards.filter((c) => c.imageCard).every((c) => !c.maybe && !c.duplicateOf)).toBe(true);
    expect(cards.filter((c) => c.imageCard)).toHaveLength(2);
  });
});

describe("cardSettings", () => {
  it("fills in today's defaults", () => {
    expect(cardSettings()).toEqual(DEFAULT_SETTINGS);
    expect(cardSettings({ thinking: "medium" })).toEqual({ ...DEFAULT_SETTINGS, thinking: "medium" });
  });

  it("refuses settings that aren't one of the choices", () => {
    expect(() => cardSettings({ thinking: "max" as never })).toThrow();
    expect(() => cardSettings({ atOnce: 0 })).toThrow();
    expect(() => cardSettings({ slidesPerRequest: 2.5 })).toThrow();
    expect(() => cardSettings({ context: "some" as never })).toThrow();
  });
});
