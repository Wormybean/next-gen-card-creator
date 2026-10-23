import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildApkg, mediaName, stableGuid } from "./apkg";
import { NOTETYPE_ID } from "./notetype";

async function readBack(apkg: Uint8Array) {
  const zip = await JSZip.loadAsync(apkg);
  const dir = await mkdtemp(path.join(tmpdir(), "cardmaker-test-"));
  const dbPath = path.join(dir, "c.anki2");
  await writeFile(dbPath, await zip.file("collection.anki2")!.async("uint8array"));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const notes = db.prepare("SELECT guid, mid, flds, tags FROM notes ORDER BY id").all();
  const cards = db.prepare("SELECT nid, ord, did FROM cards ORDER BY id").all();
  const col = db.prepare("SELECT ver, models, decks FROM col").get() as { ver: number; models: string; decks: string };
  db.close();
  const media = JSON.parse(await zip.file("media")!.async("string"));
  const mediaBytes = await zip.file("0")?.async("uint8array");
  await rm(dir, { recursive: true, force: true });
  return { notes, cards, col, media, mediaBytes };
}

describe("buildApkg", () => {
  it("round-trips notes, one card per cloze number, and media", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const img = mediaName(png);
    const apkg = await buildApkg({
      deckName: "Medicine::Test",
      notes: [
        {
          guid: stableGuid("lecture", 1, 0),
          text: "<b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance}}.",
          backExtra: `<img src="${img}">`,
          tags: ["CardMaker", "Week 31"],
        },
        {
          guid: stableGuid("lecture", 2, 0),
          text: "<b>Semaglutide</b> is a {{c1::GLP-1 receptor agonist::MOA}} → weight loss via {{c2::↓ appetite}}.",
          backExtra: "",
        },
      ],
      media: [{ name: img, data: png }],
    });

    const { notes, cards, col, media, mediaBytes } = await readBack(apkg);
    expect(col.ver).toBe(11);
    expect(Object.keys(JSON.parse(col.models))).toEqual([String(NOTETYPE_ID)]);
    expect(Object.values(JSON.parse(col.decks)).map((d) => (d as { name: string }).name)).toContain(
      "Medicine::Test",
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ mid: NOTETYPE_ID, tags: " CardMaker Week_31 " });
    expect((notes[0] as { flds: string }).flds.split("\x1f")).toEqual([
      "<b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance}}.",
      `<img src="${img}">`,
    ]);
    expect(cards.map((c) => (c as { ord: number }).ord)).toEqual([0, 0, 1]);
    expect(media).toEqual({ 0: img });
    expect(mediaBytes).toEqual(png);
  });

  it("gives the same guid for the same parts", () => {
    expect(stableGuid("a", 1)).toBe(stableGuid("a", 1));
    expect(stableGuid("a", 1)).not.toBe(stableGuid("a", 2));
  });

  it("refuses a card with no blanks", async () => {
    await expect(
      buildApkg({ deckName: "X", notes: [{ guid: "g", text: "no blanks", backExtra: "" }], media: [] }),
    ).rejects.toThrow(/no blanks/);
  });
});
