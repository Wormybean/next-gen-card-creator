import { describe, expect, it } from "vitest";
import {
  backExtraField,
  frontField,
  handAdded,
  hasOwnSlide,
  knownDefinition,
  mergeDefinitions,
  mergeImages,
  migrateCard,
  selectedTerm,
  setOwnSlide,
  type CardImage,
} from "./extras";

describe("selectedTerm", () => {
  const card = "<b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance::MOA}}.";
  const term = (selected: string) => {
    const start = card.indexOf(selected);
    return selectedTerm(card, start, start + selected.length);
  };

  it("strips a whole blank down to its answer, dropping the hint", () => {
    expect(term("{{c1::insulin resistance::MOA}}")).toBe("insulin resistance");
  });

  it("handles a selection that starts or ends partway through a blank", () => {
    expect(term("{{c1::insulin")).toBe("insulin");
    expect(term("resistance::MOA}}.")).toBe("resistance");
    expect(term("insulin resistance::MO")).toBe("insulin resistance");
  });

  it("strips HTML and surrounding punctuation", () => {
    expect(term("<b>Acanthosis nigricans</b>")).toBe("Acanthosis nigricans");
    expect(selectedTerm("(chondrocytes),", 0, 15)).toBe("chondrocytes");
  });
});

describe("definitions", () => {
  it("reuses a definition written on another card, ignoring case and empty rows", () => {
    const cards = [
      { definitions: [{ term: "Chondrocyte", definition: "" }] },
      { definitions: [{ term: "chondrocyte ", definition: "Cartilage-forming cell." }] },
    ];
    expect(knownDefinition(cards, "CHONDROCYTE")).toBe("Cartilage-forming cell.");
    expect(knownDefinition(cards, "osteocyte")).toBeUndefined();
  });

  it("merges lists keeping the first of a repeated term", () => {
    expect(
      mergeDefinitions([
        [{ term: "Lumen", definition: "a" }],
        undefined,
        [
          { term: "lumen", definition: "b" },
          { term: "Intima", definition: "c" },
        ],
      ]),
    ).toEqual([
      { term: "Lumen", definition: "a" },
      { term: "Intima", definition: "c" },
    ]);
  });
});

describe("images", () => {
  const slide: CardImage = { id: "1", slide: 3, front: false, auto: true };
  const file: CardImage = { id: "2", file: "img-x.png", front: true };

  it("merges lists keeping each picture once", () => {
    expect(mergeImages([[slide], [{ ...slide, id: "3" }, file]])).toEqual([slide, file]);
  });

  it("counts only what the user added", () => {
    expect(
      handAdded([
        { images: [slide, file], definitions: [{ term: "a", definition: "" }] },
        { definitions: [{ term: " ", definition: "" }] },
      ]),
    ).toEqual({ images: 1, definitions: 1 });
  });

  it("ticks the card's own slide off and on, keeping it listed", () => {
    const card = { slide: 2, images: [] as CardImage[] };
    const on = setOwnSlide(card, true);
    expect(hasOwnSlide(on)).toBe(true);
    const off = setOwnSlide(on, false);
    expect(off.images).toHaveLength(1);
    expect(off.images[0].off).toBe(true);
    expect(hasOwnSlide(off)).toBe(false);
    expect(setOwnSlide(off, true).images).toEqual([{ ...off.images[0], off: false }]);
  });

  it("doesn't count unticked pictures as hand-added", () => {
    expect(handAdded([{ images: [{ ...file, off: true }] }]).images).toBe(0);
  });

  it("turns an old 'slide image on back' tick into a picture", () => {
    expect(migrateCard({ id: "c", slide: 4, useImage: true })).toEqual({
      id: "c",
      slide: 4,
      images: [{ id: "c-slide", slide: 4, front: false, auto: true }],
    });
    expect(migrateCard({ id: "c", useImage: false })).toEqual({ id: "c", images: [] });
  });
});

describe("fields", () => {
  it("puts front pictures above the text", () => {
    expect(frontField("t", [])).toBe("t");
    expect(frontField("t", ["a.png"])).toBe('<img src="a.png" style="max-width:100%;max-height:55vh;margin:20px 0"><br>t');
  });

  it("orders the back: question, why, definitions, pictures", () => {
    expect(
      backExtraField({
        question: "Why <this>?",
        why: "Because",
        definitions: [
          { term: "Lumen", definition: "Inside space of a tube." },
          { term: "Empty", definition: " " },
        ],
        backImages: ["b.png"],
      }),
    ).toBe(
      '<i>Q: Why &lt;this&gt;?</i><br>Because<br><b>Lumen</b>: Inside space of a tube.<br><img src="b.png" style="max-width:100%;max-height:55vh;margin:20px 0">',
    );
  });
});
