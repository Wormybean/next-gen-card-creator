import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readUpload } from "./readings";

async function docx(paragraphs: string[]) {
  const z = new JSZip();
  const p = (t: string) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${t}</w:t></w:r><w:r><w:t>&amp; more</w:t></w:r></w:p>`;
  z.file("word/document.xml", `<w:document><w:body>${paragraphs.map(p).join("")}</w:body></w:document>`);
  return z.generateAsync({ type: "uint8array" });
}

describe("readUpload", () => {
  it("reads a .docx: runs join without stray spaces, paragraphs become lines", async () => {
    const line = "Heat stroke is a core temperature above 40C with confusion. ";
    const r = await readUpload("Heat Article.docx", await docx(Array(8).fill(line)));
    expect(r.title).toBe("Heat Article");
    expect(r.text.split("\n")).toHaveLength(8);
    expect(r.text).toContain("confusion. & more");
  });

  it("refuses a nearly empty file, an old .doc and other types", async () => {
    await expect(readUpload("x.docx", await docx(["hi"]))).rejects.toThrow(/Almost no text/);
    await expect(readUpload("x.doc", new Uint8Array())).rejects.toThrow(/\.docx/);
    await expect(readUpload("x.txt", new Uint8Array())).rejects.toThrow(/PDF or Word/);
  });
});
