import { describe, expect, it } from "vitest";
import { addCloze, combineCloze, rawRange, removeCloze, setBlankNumber } from "./cloze";

describe("addCloze", () => {
  const t = "REDs is driven by energy intake and expenditure";
  const sel = (s: string) => [t.indexOf(s), t.indexOf(s) + s.length] as const;

  it("starts at c1 on a card with no blanks", () => {
    expect(addCloze(t, ...sel("energy intake"), "same").text).toBe("REDs is driven by {{c1::energy intake}} and expenditure");
  });

  it("'same' reuses the highest number, 'new' takes the next", () => {
    const one = addCloze(t, ...sel("energy intake"), "same").text;
    const at = one.indexOf("expenditure");
    expect(addCloze(one, at, at + 11, "same").text).toContain("{{c1::expenditure}}");
    expect(addCloze(one, at, at + 11, "new").text).toContain("{{c2::expenditure}}");
  });

  it("keeps spaces outside the blank", () => {
    const [s, e] = sel(" energy intake ");
    expect(addCloze(t, s, e, "same").text).toBe("REDs is driven by {{c1::energy intake}} and expenditure");
  });

  it("inserts an empty blank with the cursor inside when nothing is selected", () => {
    const r = addCloze("abc", 3, 3, "new");
    expect(r.text).toBe("abc{{c1::}}");
    expect(r.selStart).toBe(9);
  });
});

describe("removeCloze", () => {
  it("unwraps the blank under the cursor and drops its hint", () => {
    const text = "<b>Semaglutide</b> is a {{c1::GLP-1 RA::class}}.";
    expect(removeCloze(text, text.indexOf("GLP"))?.text).toBe("<b>Semaglutide</b> is a GLP-1 RA.");
    expect(removeCloze(text, 2)).toBeNull();
  });
});

describe("combineCloze", () => {
  it("renumbers each card after the one before, so numbers never overlap", () => {
    const out = combineCloze(["A {{c1::x}} and {{c2::y}}", "B {{c1::z}}", "C {{c1::p}} {{c1::q}}"]);
    expect(out).toBe("A {{c1::x}} and {{c2::y}}<br><br>B {{c3::z}}<br><br>C {{c4::p}} {{c4::q}}");
  });

  it("closes gaps and keeps hints and shared numbers", () => {
    expect(combineCloze(["{{c2::a::hint}} {{c5::b}}", "{{c5::c}} {{c5::d}}"])).toBe(
      "{{c1::a::hint}} {{c2::b}}<br><br>{{c3::c}} {{c3::d}}",
    );
  });
});

describe("rawRange", () => {
  // What the preview shows: "A sign of dysphagia is a wet & gurgly voice." (the c1 number is drawn separately)
  const t = "A sign of <b>dysphagia</b> is a {{c1::wet &amp; gurgly voice::sign}}.";
  const shown = "A sign of dysphagia is a wet & gurgly voice.";
  const pick = (s: string) => {
    const r = rawRange(t, shown.indexOf(s), shown.indexOf(s) + s.length);
    return t.slice(r.start, r.end);
  };

  it("maps a selection across bold text to the raw text inside the tags", () => {
    expect(pick("dysphagia")).toBe("dysphagia");
  });

  it("maps a selection inside a blank to its answer, skipping the markup", () => {
    expect(pick("gurgly")).toBe("gurgly");
    expect(pick("wet & gurgly voice")).toBe("wet &amp; gurgly voice");
  });

  it("puts a click (no selection) at that place in the raw text", () => {
    const at = rawRange(t, shown.indexOf("gurgly"), shown.indexOf("gurgly"));
    expect(at.start).toBe(at.end);
    expect(t.slice(at.start)).toMatch(/^gurgly voice::sign\}\}/);
  });

  it("adds a blank around a preview selection", () => {
    const r = rawRange(t, shown.indexOf("dysphagia"), shown.indexOf("dysphagia") + 9);
    expect(addCloze(t, r.start, r.end, "new").text).toContain("<b>{{c2::dysphagia}}</b>");
  });
});

describe("setBlankNumber", () => {
  const t = "<b>REDs</b>: {{c1::energy intake}} vs {{c2::expenditure::type}}; risk of {{c3::stress fractures}}.";

  it("joins a blank to another number, keeping its answer and hint", () => {
    expect(setBlankNumber(t, 1, 1)).toBe("<b>REDs</b>: {{c1::energy intake}} vs {{c1::expenditure::type}}; risk of {{c3::stress fractures}}.");
  });

  it("gives a blank a new number of its own", () => {
    expect(setBlankNumber(t, 0, 4)).toBe("<b>REDs</b>: {{c4::energy intake}} vs {{c2::expenditure::type}}; risk of {{c3::stress fractures}}.");
  });

  it("leaves the card alone for a blank that isn't there", () => {
    expect(setBlankNumber(t, 5, 1)).toBe(t);
  });
});
