import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha1, stableGuid } from "./guid";

describe("sha1", () => {
  it("matches Node's for empty, short, block-edge and long input", () => {
    for (const length of [0, 3, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
      expect(Buffer.from(sha1(data)).toString("hex")).toBe(createHash("sha1").update(data).digest("hex"));
    }
  });
});

describe("stableGuid", () => {
  it("is the guid earlier .apkg exports gave, so those cards are updated rather than duplicated", () => {
    const old = (...parts: (string | number)[]) =>
      createHash("sha1").update(parts.join("\x1f")).digest("base64").slice(0, 16);
    expect(stableGuid("Cartilage — Week 3", "slide 4", 0)).toBe(old("Cartilage — Week 3", "slide 4", 0));
    expect(stableGuid("Case 2", "q Why?", 1)).toBe(old("Case 2", "q Why?", 1));
  });
});
