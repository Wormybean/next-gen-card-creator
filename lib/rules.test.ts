import { describe, expect, it } from "vitest";
import { DuplicateIndex } from "./dedupe";
import { applyTarget, checkCard, guessLectureType, isQuestionSheet, questionCount, type DraftCard } from "./rules";

describe("isQuestionSheet", () => {
  const sheet = `Week 3 tutorial: cartilage
1. What are the three types of cartilage?
2. Which collagen type is found in hyaline cartilage?
3. Why does articular cartilage heal poorly after injury?
4. How does osteoarthritis change the joint surface?`;

  it("takes a page of questions as a question sheet", () => {
    expect(questionCount(sheet)).toBe(4);
    expect(isQuestionSheet(sheet, 1)).toBe(true);
  });

  it("doesn't take slides with the odd question for one", () => {
    const slides = Array.from({ length: 20 }, (_, i) => `Slide ${i + 1}: chondrocytes sit in lacunae`).join("\n");
    expect(isQuestionSheet(`${slides}\nWhy does cartilage heal slowly?\nWhat is a lacuna?\nWhere is elastic cartilage?`, 20)).toBe(false);
  });

  it("needs at least three questions, and ignores stray question marks", () => {
    expect(isQuestionSheet("What is cartilage made of?\nWhere is it found?", 1)).toBe(false);
    expect(questionCount("Questions? Ask me. ok?")).toBe(0);
  });
});

describe("checkCard", () => {
  it("passes a short, well-formed card", () => {
    expect(checkCard("<b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance}}.")).toEqual([]);
  });

  it("flags long cards, too many cloze numbers, long lists and pronoun starts", () => {
    const long = `It ${"word ".repeat(30)}{{c1::a}} {{c2::b}} {{c3::c}} {{c4::d}}`;
    const w = checkCard(long);
    expect(w.some((x) => x.startsWith("Long"))).toBe(true);
    expect(w).toContain("4 cloze numbers (max 3)");
    expect(w).toContain("Starts with a pronoun: name the subject");
    expect(checkCard("Causes: {{c1::a}}, {{c1::b}}, {{c1::c}}, {{c1::d}}")).toContain(
      "c1 hides 4 items at once (lists over 3 should be split)",
    );
  });

  it("refuses a card with no blanks", () => {
    expect(checkCard("plain text")).toEqual(["No blanks: this card can't be exported"]);
  });
});

describe("applyTarget", () => {
  const card = (id: string, priority: 1 | 2 | 3): DraftCard => ({ id, text: "", images: [], priority, warnings: [] });

  it("flags the lowest-priority extras as maybe, keeping order", () => {
    const out = applyTarget([card("a", 3), card("b", 1), card("c", 2)], 2);
    expect(out.map((c) => [c.id, c.maybe])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });
});

describe("DuplicateIndex", () => {
  const index = new DuplicateIndex([
    { id: 1, notetype: "2. Cloze", text: "Acanthosis nigricans is a cutaneous marker of {{c1::insulin resistance}}" },
    { id: 2, notetype: "2. Cloze", text: "Propofol commonly causes {{c1::hypotension}} on induction" },
  ]);

  it("finds a near-identical existing card", () => {
    expect(index.find("<b>Acanthosis nigricans</b> is a skin marker of {{c1::insulin resistance}}.")).toContain(
      "Acanthosis nigricans",
    );
  });

  it("ignores cards that share a topic but test a different answer", () => {
    expect(index.find("<b>Acanthosis nigricans</b> commonly appears in the {{c1::axilla}} and neck skin folds")).toBeUndefined();
  });
});

describe("guessLectureType", () => {
  it("spots a CSBL session plan", () => {
    expect(guessLectureType("x.pdf", "Year 2 CSBL Session Plan ... Trigger 1: Presentation ... Discussion Starters")).toBe("csbl");
  });
});

describe("flagRepeats", () => {
  it("flags a later card that repeats an earlier one", async () => {
    const { flagRepeats } = await import("./dedupe");
    const out = flagRepeats<{ text: string; duplicateOf?: string }>([
      { text: "In toddlers, <b>cow's milk</b> intake should be limited to {{c1::400 mL/day}}." },
      { text: "<b>Toddlers</b>: limit daily cow's milk intake to {{c1::400 mL/day}}." },
      { text: "<b>Iron-rich foods</b> should be offered first at {{c1::6 months}}." },
    ]);
    expect(out[0].duplicateOf).toBeUndefined();
    expect(out[1].duplicateOf).toMatch(/^Repeats an earlier card/);
    expect(out[2].duplicateOf).toBeUndefined();
  });
});
