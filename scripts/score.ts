// Blind scoring of speed-test runs (scripts/bench.ts) against a lecture's must-know list.
//
//   npx tsx scripts/score.ts prepare <run folder> <must-know list>
//       Packs the cards and the list into bench/scoring/<random id>/input.md, with nothing that
//       says which settings made them. A scoring agent reads only that file (and the front
//       pictures it links) and writes scores.json next to it.
//   npx tsx scripts/score.ts record <id>
//       Checks scores.json, files it with its run as score.json, and prints the summary.
//   npx tsx scripts/score.ts compare <baseline run>... --vs <candidate run>...
//       Medians of run time and scores, and whether the candidate passes the pass mark.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DraftCard } from "../lib/rules";

const root = path.resolve(import.meta.dirname, "..");
const scoring = path.join(root, "bench", "scoring");
const keysFile = path.join(scoring, "keys.json");

type Run = { runTimeMs: number; cards: DraftCard[]; jobId: string; lecture: string; slides: number; target: number; label: string };
type MustKnow = { facts: { n: number; text: string; optional: boolean }[]; images: string[] };
/** What the scoring agent writes. */
type Scores = {
  facts: { n: number; covered: boolean; by: string[] }[];
  cards: { card: string; verdict: "on-list" | "extra" | "filler"; facts?: number[] }[];
  images: { condition: string; card: string | null; rightAnswer: boolean; givesAway: boolean }[];
};
/** What gets filed with the run. */
type Summary = {
  mustKnow: number;
  covered: number;
  missed: number[];
  cards: number;
  withinTarget: number;
  filler: number;
  extras: number;
  ruleBreaks: number;
  repeats: number;
  imageCardsExpected: number;
  imageCardsRight: number;
  imageCardsGivingAway: number;
  imageCardsUnexpected: number;
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const keys = (): Record<string, string> => (existsSync(keysFile) ? readJson(keysFile) : {});

function parseMustKnow(file: string): MustKnow {
  const text = readFileSync(file, "utf8");
  const [factsPart, imagesPart = ""] = text.split(/^## Images.*$/m);
  const facts = [...factsPart.matchAll(/^(\d+)\.\s+(.*)$/gm)].map((m) => ({
    n: Number(m[1]),
    text: m[2].trim(),
    optional: /\*\(optional\)\*/.test(m[2]),
  }));
  const images = [...imagesPart.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  return { facts, images };
}

/** Cloze text as the student reads the answer side: blanks shown as [answer]. */
const readable = (text: string) =>
  text
    .replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "[$1]")
    .replace(/<\/?b>/g, "**")
    .replace(/<[^>]+>/g, "");

function prepare(runDir: string, listFile: string) {
  const run = readJson<Run>(path.join(runDir, "run.json"));
  const list = parseMustKnow(listFile);
  const id = randomBytes(4).toString("hex");
  const dir = path.join(scoring, id);
  mkdirSync(dir, { recursive: true });

  const lines = [
    "# Scoring task",
    "",
    "You are scoring a set of Anki cloze cards made from a lecture against the lecture's must-know list. Score only what is in this file and the pictures it links. Be strict and consistent.",
    "",
    "Write `scores.json` in this folder, in exactly this shape:",
    "",
    "```json",
    '{ "facts":  [{ "n": 1, "covered": true, "by": ["C4"] }],',
    '  "cards":  [{ "card": "C1", "verdict": "on-list", "facts": [1] }],',
    '  "images": [{ "condition": "…", "card": "C12", "rightAnswer": true, "givesAway": false }] }',
    "```",
    "",
    "- **facts**: one entry per numbered fact below. `covered` is true when the cards together let the student recall the fact's core point (minor details in the fact may be missing). `by` lists the cards that cover it.",
    "- **cards**: one entry per card. `on-list` = it covers a must-know fact (list them in `facts`); `extra` = not on the list but clearly useful from this lecture; `filler` = low-yield, trivial, vague or wrong.",
    "- **images**: one entry per expected image condition below. `card` is the IMAGE CARD naming that condition (or null). `rightAnswer` = its answer names that condition. `givesAway` = open its front picture and say whether words in it name or strongly hint at the answer. Then add an entry with `condition` set to the card's own answer for every IMAGE CARD not matching an expected condition (`rightAnswer` false).",
    "",
    "## Must-know facts",
    "",
    ...list.facts.map((f) => `${f.n}. ${f.text}`),
    "",
    "## Expected image conditions",
    "",
    ...(list.images.length ? list.images.map((c) => `- ${c}`) : ["(none)"]),
    "",
    "## Cards",
    "",
  ];
  run.cards.forEach((c, i) => {
    const front = c.images.find((img) => img.front && img.file);
    const tags = [c.imageCard && "IMAGE CARD", c.maybe && "beyond the card target"].filter(Boolean);
    lines.push(`**C${i + 1}** (slide ${(c.slide ?? 0) + 1}${tags.length ? `; ${tags.join("; ")}` : ""}): ${readable(c.text)}`);
    if (c.why) lines.push(`  Extra: ${c.why}`);
    if (front) lines.push(`  Front picture: ${path.join(root, "bench", "jobs", "jobs", run.jobId, front.file!)}`);
    lines.push("");
  });
  writeFileSync(path.join(dir, "input.md"), lines.join("\n"));
  writeFileSync(keysFile, JSON.stringify({ ...keys(), [id]: path.relative(root, runDir) }, null, 2));
  writeFileSync(path.join(dir, "list.json"), JSON.stringify({ file: path.relative(root, listFile) }));
  console.log(`Scoring task ${id}: ${path.relative(root, path.join(dir, "input.md"))}`);
}

function summarise(run: Run, list: MustKnow, scores: Scores): Summary {
  const required = list.facts.filter((f) => !f.optional);
  const coveredSet = new Set(scores.facts.filter((f) => f.covered).map((f) => f.n));
  const expected = scores.images.filter((i) => list.images.includes(i.condition));
  return {
    mustKnow: required.length,
    covered: required.filter((f) => coveredSet.has(f.n)).length,
    missed: required.filter((f) => !coveredSet.has(f.n)).map((f) => f.n),
    cards: run.cards.length,
    withinTarget: run.cards.filter((c) => !c.maybe).length,
    filler: scores.cards.filter((c) => c.verdict === "filler").length,
    extras: scores.cards.filter((c) => c.verdict === "extra").length,
    ruleBreaks: run.cards.filter((c) => c.warnings.length).length,
    repeats: run.cards.filter((c) => c.duplicateOf).length,
    imageCardsExpected: list.images.length,
    imageCardsRight: expected.filter((i) => i.card && i.rightAnswer && !i.givesAway).length,
    imageCardsGivingAway: scores.images.filter((i) => i.card && i.givesAway).length,
    imageCardsUnexpected: scores.images.filter((i) => !list.images.includes(i.condition) && i.card).length,
  };
}

function record(id: string) {
  const runRel = keys()[id];
  if (!runRel) throw new Error(`No scoring task ${id}`);
  const dir = path.join(scoring, id);
  const run = readJson<Run>(path.join(root, runRel, "run.json"));
  const list = parseMustKnow(path.join(root, readJson<{ file: string }>(path.join(dir, "list.json")).file));
  const scores = readJson<Scores>(path.join(dir, "scores.json"));
  if (scores.facts.length !== list.facts.length) throw new Error(`scores.json has ${scores.facts.length} facts, the list has ${list.facts.length}`);
  if (scores.cards.length !== run.cards.length) throw new Error(`scores.json has ${scores.cards.length} cards, the run has ${run.cards.length}`);
  const summary = summarise(run, list, scores);
  writeFileSync(path.join(root, runRel, "score.json"), JSON.stringify({ task: id, summary, scores }, null, 2));
  console.log(`${run.lecture} · ${run.label}:`, summary);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function compare(baseline: string[], candidate: string[]) {
  const load = (dirs: string[]) =>
    dirs.map((d) => {
      const run = readJson<Run>(path.join(d, "run.json"));
      const score = path.join(d, "score.json");
      if (!existsSync(score)) throw new Error(`${d} isn't scored yet`);
      return { run, summary: readJson<{ summary: Summary }>(score).summary };
    });
  const side = (runs: ReturnType<typeof load>) => ({
    runTimeS: Math.round(median(runs.map((r) => r.run.runTimeMs)) / 1000),
    covered: median(runs.map((r) => r.summary.covered)),
    ruleBreaks: median(runs.map((r) => r.summary.ruleBreaks)),
    filler: median(runs.map((r) => r.summary.filler)),
    imageCardsRight: median(runs.map((r) => r.summary.imageCardsRight)),
    imageCardsGivingAway: median(runs.map((r) => r.summary.imageCardsGivingAway)),
  });
  const a = side(load(baseline));
  const b = side(load(candidate));
  // The pass mark agreed for the speed tests: coverage within one fact, no more rule breaks,
  // image cards still recognisable, and actually faster.
  const checks = {
    coverage: b.covered >= a.covered - 1,
    ruleBreaks: b.ruleBreaks <= a.ruleBreaks,
    imageCards: b.imageCardsRight >= a.imageCardsRight && b.imageCardsGivingAway <= a.imageCardsGivingAway,
    faster: b.runTimeS < a.runTimeS,
  };
  console.log({ baseline: a, candidate: b, timeSaved: `${Math.round((1 - b.runTimeS / a.runTimeS) * 100)}%`, checks });
  console.log(Object.values(checks).every(Boolean) ? "PASSES the pass mark (the student's blind comparison still decides finalists)" : "DOES NOT PASS");
}

const [command, ...args] = process.argv.slice(2);
if (command === "prepare" && args.length === 2) prepare(path.resolve(args[0]), path.resolve(args[1]));
else if (command === "record" && args.length === 1) record(args[0]);
else if (command === "compare" && args.includes("--vs")) {
  const at = args.indexOf("--vs");
  compare(args.slice(0, at).map((d) => path.resolve(d)), args.slice(at + 1).map((d) => path.resolve(d)));
} else {
  console.error("Usage: score.ts prepare <run> <must-know list> | record <id> | compare <runs…> --vs <runs…>");
  process.exit(1);
}
