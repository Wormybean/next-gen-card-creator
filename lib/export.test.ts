import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DraftCard } from "./rules";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cardmaker-export-"));
  process.env.CARDMAKER_DATA = dir;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("exportCards", () => {
  it("puts front pictures in Text, and why, definitions and back pictures in Back Extra", async () => {
    const { putFile } = await import("./store");
    const { saveImage } = await import("./jobs");
    const { exportCards } = await import("./export");

    const id = "00000000-0000-0000-0000-000000000001";
    const job = { id, name: "Cartilage", mode: "lecture" as const, guessedType: "medical-science" as const, createdAt: "", slides: [{ index: 0, text: "" }] };
    await putFile(`jobs/${id}/slide-0.png`, new Uint8Array([1, 2, 3]));
    const crop = await saveImage(id, new Uint8Array([4, 5, 6]), "image/png");

    const card = (over: Partial<DraftCard>): DraftCard => ({
      id: "x",
      slide: 0,
      text: "<b>Hyaline cartilage</b> is made by {{c1::chondrocytes}}.",
      images: [],
      priority: 1,
      warnings: [],
      ...over,
    });
    const apkg = await exportCards(job, "Deck", ["CardMaker"], [
      card({
        why: "They secrete matrix",
        definitions: [{ term: "Chondrocyte", definition: "Cartilage cell." }],
        images: [
          { id: "a", file: crop, front: true },
          { id: "b", slide: 0, front: false, auto: true },
        ],
      }),
      card({ images: [{ id: "c", file: crop, front: false }] }),
    ]);

    const zip = await JSZip.loadAsync(apkg);
    const media = JSON.parse(await zip.file("media")!.async("string")) as Record<string, string>;
    const db = path.join(dir, "out.anki2");
    await writeFile(db, await zip.file("collection.anki2")!.async("uint8array"));
    const sql = new DatabaseSync(db, { readOnly: true });
    const rows = sql.prepare("SELECT flds FROM notes ORDER BY id").all() as { flds: string }[];
    sql.close();

    // The crop is used twice but stored once.
    expect(Object.values(media)).toHaveLength(2);
    const [text, back] = rows[0].flds.split("\x1f");
    expect(text).toMatch(/^<img src="cardmaker-[0-9a-f]+\.png" style="max-width:100%;max-height:55vh;margin:20px 0"><br><b>Hyaline/);
    expect(back).toMatch(/^They secrete matrix<br><b>Chondrocyte<\/b>: Cartilage cell\.<br><img src="cardmaker-/);
    expect(rows[1].flds.split("\x1f")[1]).toBe(`<img src="${text.match(/src="([^"]+)"/)![1]}" style="max-width:100%;max-height:55vh;margin:20px 0">`);
  });
});
