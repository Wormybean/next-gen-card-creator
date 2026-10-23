// Smoke test: builds sample.apkg from two hand-written cards and a real slide picture,
// so the export can be checked in real Anki before any AI is involved.
// Usage: npx tsx scripts/sample-apkg.ts <some.pdf> <out.apkg>

import { readFileSync, writeFileSync } from "node:fs";
import { buildApkg, mediaName, stableGuid } from "../lib/apkg";
import { readPdf } from "../lib/pdf";

const [pdfPath, outPath = "sample.apkg"] = process.argv.slice(2);
const slide = readPdf(new Uint8Array(readFileSync(pdfPath)))[0];
const img = mediaName(slide.png);

const apkg = await buildApkg({
  deckName: "Card Maker Test::Sample",
  notes: [
    {
      guid: stableGuid("sample", 1),
      text: "<b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance}}.",
      backExtra: `<img src="${img}">`,
      tags: ["CardMaker"],
    },
    {
      guid: stableGuid("sample", 2),
      text: "<b>Semaglutide</b> is a {{c1::GLP-1 receptor agonist::MOA}} → weight loss via {{c2::↓ appetite}} and {{c2::slowed gastric emptying}}.",
      backExtra: "<i>Q: What is semaglutide? How does it work?</i>",
      tags: ["CardMaker"],
    },
  ],
  media: [{ name: img, data: slide.png }],
});
writeFileSync(outPath, apkg);
console.log(`wrote ${outPath} (${apkg.length} bytes), image ${img}`);
