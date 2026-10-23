// The student's blind comparison of two speed-test runs of the same lecture (scripts/bench.ts):
// a local page, never published, with each slide beside both runs' cards, labelled A and B at
// random. The student picks a side per slide; Finish shows the tally and which run was which.
//
//   npx tsx scripts/compare-page.ts <run folder> <run folder>
//
// Opens from bench/compare/ in any browser, with no network: pictures are linked from bench/jobs.

import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DraftCard } from "../lib/rules";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "bench", "compare");

type Run = { label: string; lecture: string; jobId: string; slides: number; cards: DraftCard[] };

const dirs = process.argv.slice(2).map((d) => path.resolve(d));
if (dirs.length !== 2) {
  console.error("Usage: compare-page.ts <run folder> <run folder>");
  process.exit(1);
}
const runs = dirs.map((d) => JSON.parse(readFileSync(path.join(d, "run.json"), "utf8")) as Run);
if (runs[0].lecture !== runs[1].lecture) throw new Error("The two runs are of different lectures");
// A coin toss decides which run is shown as A.
const [a, b] = randomInt(2) ? [0, 1] : [1, 0];

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const picture = (run: Run, file: string) =>
  path.relative(out, path.join(root, "bench", "jobs", "jobs", run.jobId, file)).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");

/** Card text is the generator's HTML (bold subjects); blanks become highlighted answers. */
const cardHtml = (run: Run, c: DraftCard) => {
  const text = c.text.replace(
    /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g,
    (_m, n, answer) => `<span class="blank"><sup>${n}</sup>${answer}</span>`,
  );
  const front = c.images.filter((i) => i.front && i.file).map((i) => `<img class="front" src="${picture(run, i.file!)}" alt="">`);
  const tags = [c.imageCard && "image card", c.maybe && "beyond target", c.duplicateOf && "already have this?"].filter(Boolean);
  return `<div class="card${c.maybe ? " maybe" : ""}">${front.join("")}<p>${text}</p>${
    c.why ? `<p class="extra">${escapeHtml(c.why)}</p>` : ""
  }${tags.length ? `<p class="tags">${tags.join(" · ")}</p>` : ""}</div>`;
};

const rows: string[] = [];
for (let s = 0; s < runs[0].slides; s++) {
  const left = runs[a].cards.filter((c) => c.slide === s);
  const right = runs[b].cards.filter((c) => c.slide === s);
  if (!left.length && !right.length) continue;
  const column = (run: Run, cards: DraftCard[]) => (cards.length ? cards.map((c) => cardHtml(run, c)).join("") : `<p class="none">No cards</p>`);
  rows.push(`<section class="row" data-slide="${s + 1}">
  <div class="slide"><img src="${picture(runs[0], `slide-${s}.png`)}" alt="Slide ${s + 1}"><span>Slide ${s + 1}</span></div>
  <div class="side">${column(runs[a], left)}</div>
  <div class="side">${column(runs[b], right)}</div>
  <fieldset class="pick"><legend>Better for slide ${s + 1}</legend>
    <label><input type="radio" name="s${s + 1}" value="A"> A</label>
    <label><input type="radio" name="s${s + 1}" value="same"> Same</label>
    <label><input type="radio" name="s${s + 1}" value="B"> B</label>
  </fieldset>
</section>`);
}

const key = Buffer.from(
  JSON.stringify({ A: { label: runs[a].label, folder: path.relative(root, dirs[a]) }, B: { label: runs[b].label, folder: path.relative(root, dirs[b]) } }),
).toString("base64");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind Card Comparison</title>
<style>
:root { --bg: #f6f6f4; --panel: #fff; --ink: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --accent: #2456d6; --blank: #e8efff; }
@media (prefers-color-scheme: dark) { :root { --bg: #18181a; --panel: #232326; --ink: #ececea; --muted: #a3a39e; --line: #38383c; --accent: #8fb0ff; --blank: #273556; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--ink); font: 15px/1.45 Arial, Helvetica, sans-serif; }
header { position: sticky; top: 0; background: var(--bg); padding: 8px 0 12px; border-bottom: 1px solid var(--line); z-index: 2; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
h1 { font-size: 18px; margin: 0; flex: 1 1 260px; }
.heads { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 120px; gap: 12px; font-weight: bold; margin: 12px 0 4px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 120px; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); align-items: start; }
.slide img { width: 100%; border: 1px solid var(--line); border-radius: 6px; }
.slide span, .none, .tags, .extra { color: var(--muted); font-size: 13px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.card p { margin: 4px 0; }
.card.maybe { opacity: 0.6; }
.front { max-width: 100%; max-height: 220px; display: block; border-radius: 4px; }
.blank { background: var(--blank); border-radius: 4px; padding: 0 3px; }
.blank sup { color: var(--accent); margin-right: 2px; }
.pick { border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
.pick legend { font-size: 12px; color: var(--muted); }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.ghost { background: none; color: var(--accent); }
#result { white-space: pre-wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-top: 16px; display: none; }
@media (max-width: 760px) {
  .heads { display: none; }
  .row { grid-template-columns: 1fr 1fr; }
  .slide { grid-column: 1 / -1; }
  .pick { grid-column: 1 / -1; flex-direction: row; }
  .side::before { content: attr(data-side); font-weight: bold; display: block; margin-bottom: 4px; }
}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(runs[0].lecture)}: which cards are better?</h1>
  <span id="count"></span>
  <button id="finish">Finish</button>
</header>
<div class="heads"><span>Slide</span><span>A</span><span>B</span><span>Pick</span></div>
${rows.join("\n")}
<pre id="result"></pre>
<p><button class="ghost" id="copy" hidden>Copy result</button></p>
<script>
const KEY = JSON.parse(atob("${key}"));
const rows = [...document.querySelectorAll(".row")];
rows.forEach((r) => r.querySelectorAll(".side").forEach((s, i) => s.setAttribute("data-side", i ? "B" : "A")));
const picks = () => Object.fromEntries(rows.map((r) => [r.dataset.slide, r.querySelector("input:checked")?.value ?? null]));
const update = () => {
  const done = Object.values(picks()).filter(Boolean).length;
  document.getElementById("count").textContent = done + " of " + rows.length + " slides picked";
};
document.addEventListener("change", update);
update();
document.getElementById("finish").addEventListener("click", () => {
  const p = picks();
  const tally = { A: 0, B: 0, same: 0, skipped: 0 };
  for (const v of Object.values(p)) tally[v ?? "skipped"]++;
  const result = { lecture: ${JSON.stringify(runs[0].lecture)}, A: KEY.A, B: KEY.B, tally, picks: p };
  const box = document.getElementById("result");
  box.textContent = "A was " + KEY.A.label + ", B was " + KEY.B.label + "\\n" + JSON.stringify(result, null, 2);
  box.style.display = "block";
  const copy = document.getElementById("copy");
  copy.hidden = false;
  copy.onclick = () => navigator.clipboard?.writeText(JSON.stringify(result));
  box.scrollIntoView({ behavior: "smooth" });
});
</script>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
const slug = runs[0].lecture.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
const file = path.join(out, `${slug}-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.html`);
writeFileSync(file, html);
console.log(`Comparison page: ${path.relative(root, file)} (${rows.length} slides with cards)`);
