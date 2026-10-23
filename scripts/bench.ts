// Speed test: makes cards for a lecture PDF exactly as the app does (lib/lecture-run.ts), with
// chosen settings, and saves the cards and timings under bench/ (gitignored).
//
// Usage:
//   npx tsx --env-file=.env.local scripts/bench.ts --type clinical --label baseline lecture.pdf [part2.pdf]
// Settings (defaults are the app's): --thinking minimal|low|medium|high, --tidy off|minimal|low|medium|high,
//   --pictures default|medium|low, --context all|none, --per-request N, --at-once N, --model NAME
//   (default: the app's first OpenRouter model; another as --model openrouter:<id>, or Gemini
//   directly as --model gemini-3.6-flash with GEMINI_API_KEY)
//
// Only one model is offered, so a run never quietly falls back to another one. The Anki collection
// (style examples, the duplicate check) is a copy frozen on the first run, so every run sees the same one.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const bench = path.join(root, "bench");

const { values: opts, positionals: pdfs } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: "string" },
    label: { type: "string", default: "run" },
    thinking: { type: "string" },
    tidy: { type: "string" },
    pictures: { type: "string" },
    context: { type: "string" },
    "per-request": { type: "string" },
    "at-once": { type: "string" },
    model: { type: "string" },
  },
});
if (!opts.type || !pdfs.length) {
  console.error("Usage: scripts/bench.ts --type <lecture type> [--label name] [settings] lecture.pdf [more.pdf]");
  process.exit(1);
}

// Set before any lib code reads them: test jobs, a frozen collection, and one model only.
process.env.CARDMAKER_DATA = path.join(bench, "jobs");
const frozen = path.join(bench, "collection.anki2");
const { OPENROUTER_CARD_MODELS } = await import("../lib/models");
const { config } = await import("../lib/config");
if (!existsSync(frozen)) {
  mkdirSync(bench, { recursive: true });
  const live = config.collectionPath();
  copyFileSync(live, frozen);
  if (existsSync(`${live}-wal`) && statSync(`${live}-wal`).size > 0) copyFileSync(`${live}-wal`, `${frozen}-wal`);
  console.log(`Froze a copy of the Anki collection at ${frozen}`);
}
process.env.ANKI_COLLECTION = frozen;
const model = opts.model ?? OPENROUTER_CARD_MODELS[0];
const viaOpenRouter = model.startsWith("openrouter:");
// The model's own service and nothing else: an OpenRouter key would take a Gemini model's run.
if (viaOpenRouter) process.env.OPENROUTER_MODEL = model;
else {
  process.env.GEMINI_MODEL = model;
  delete process.env.OPENROUTER_API_KEY;
}

const { createJob } = await import("../lib/jobs");
const { withApiKeys } = await import("../lib/generate");
const { generateForJob } = await import("../lib/service");
const { cardSettings, contentSlides, lectureCards, splitSlides, writeLecture } = await import("../lib/lecture-run");
const { cardTarget, LECTURE_TYPES } = await import("../lib/rules");
type LectureType = import("../lib/rules").LectureType;
type Progress = import("../lib/service").Progress;

const type = opts.type as LectureType;
if (!LECTURE_TYPES.includes(type) || type === "csbl") throw new Error(`--type must be one of ${LECTURE_TYPES.filter((t) => t !== "csbl").join(", ")}`);
const settings = cardSettings({
  ...(opts.thinking && { thinking: opts.thinking as never }),
  ...(opts.tidy && { tidyPass: opts.tidy as never }),
  ...(opts.pictures && { pictures: opts.pictures as never }),
  ...(opts.context && { context: opts.context as never }),
  ...(opts["per-request"] && { slidesPerRequest: Number(opts["per-request"]) }),
  ...(opts["at-once"] && { atOnce: Number(opts["at-once"]) }),
});
const keyName = viaOpenRouter ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
if (!process.env[keyName]) throw new Error(`No ${keyName}: run with --env-file=.env.local`);

const job = await createJob(pdfs.map((f) => ({ name: path.basename(f), data: new Uint8Array(readFileSync(f)) })), "lecture");
const requests = splitSlides(
  job.slides.map((s) => s.index),
  settings.slidesPerRequest,
);
console.log(`${job.name}: ${job.slides.length} slides in ${requests.length} requests · ${model} · ${JSON.stringify(settings)}`);

/** When each request reached each stage (ms since the run started). */
type Timing = { start?: number; firstWriting?: number; checking?: number; done?: number; retries: number; stages: string[] };
const timings: Timing[] = requests.map(() => ({ retries: 0, stages: [] }));
const started = Date.now();
const now = () => Date.now() - started;

const run = await writeLecture(
  requests,
  (slides, onProgress) => withApiKeys({}, () => generateForJob(job.id, { type, slides, settings }, onProgress)),
  settings.atOnce,
  {
    onStart: (i) => (timings[i].start = now()),
    onProgress: (i, p: Progress) => {
      const t = timings[i];
      if (t.stages.at(-1) !== p.stage) t.stages.push(p.stage);
      if (p.stage === "writing") t.firstWriting ??= now();
      if (p.stage === "checking") t.checking ??= now();
      if (p.stage === "retrying") t.retries++;
    },
    onDone: (i, result, error) => {
      timings[i].done = now();
      const secs = ((timings[i].done! - timings[i].start!) / 1000).toFixed(0);
      console.log(`  request ${i + 1}/${requests.length}: ${error ? `FAILED (${error.message})` : `${result!.cards.length} cards`} in ${secs}s`);
    },
  },
);
const runTimeMs = now();
const cards = lectureCards(run, type, job.slides);

const span = (from?: number, to?: number) => (from !== undefined && to !== undefined ? to - from : null);
const perRequest = requests.map((slides, i) => {
  const t = timings[i];
  const result = run.results[i];
  const models = result?.usage.calls?.map((c) => c.model) ?? [];
  return {
    slides: [slides[0] + 1, slides.at(-1)! + 1],
    ms: span(t.start, t.done),
    // Planning: sent until the first card arrives; writing: until the tidy pass (or the end); tidy: the rest.
    planningMs: span(t.start, t.firstWriting),
    writingMs: span(t.firstWriting, t.checking ?? t.done),
    tidyMs: span(t.checking, t.done),
    retries: t.retries,
    models,
    cards: result?.cards.length ?? 0,
    failed: !result,
  };
});
const otherModel = perRequest.some((r) => r.models.some((m) => m !== model));
const usage = run.results.reduce(
  (u, r) => ({ inputTokens: u.inputTokens + (r?.usage.inputTokens ?? 0), outputTokens: u.outputTokens + (r?.usage.outputTokens ?? 0) }),
  { inputTokens: 0, outputTokens: 0 },
);

const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const out = path.join(bench, "runs", slug, `${stamp}-${opts.label}`);
mkdirSync(out, { recursive: true });
writeFileSync(
  path.join(out, "run.json"),
  JSON.stringify(
    {
      label: opts.label,
      lecture: job.name,
      pdfs: pdfs.map((f) => path.basename(f)),
      jobId: job.id,
      type,
      slides: job.slides.length,
      target: cardTarget(type, contentSlides(job.slides)),
      model,
      otherModel,
      settings,
      runTimeMs,
      failedSlides: run.failed.map((s) => s + 1),
      usage,
      requests: perRequest,
      keyPoints: run.results.flatMap((r) => r?.keyPoints ?? []),
      cards,
    },
    null,
    2,
  ),
);

// A readable copy, grouped by slide, with each card's flags.
const lines = [`# ${job.name} · ${opts.label}`, "", `${cards.length} cards · run time ${(runTimeMs / 1000).toFixed(0)}s · ${model}`, ""];
for (const s of job.slides) {
  const mine = cards.filter((c) => c.slide === s.index);
  if (!mine.length) continue;
  lines.push(`## Slide ${s.index + 1}`);
  for (const c of mine) {
    const flags = [
      c.imageCard && `IMAGE CARD${c.imageCard.headline ? ", headline" : ""}${c.imageCard.answerShows ? ", ANSWER SHOWS (unticked)" : ""}`,
      c.maybe && "maybe",
      c.duplicateOf && "repeat?",
      ...c.warnings,
    ].filter(Boolean);
    lines.push(`- ${c.text}${c.why ? `\n  - Extra: ${c.why}` : ""}${flags.length ? `\n  - (${flags.join("; ")})` : ""}`);
    // Image cards: the front picture, linked from where the job keeps it.
    for (const img of c.images.filter((i) => i.front && i.file))
      lines.push(`\n  ![front](${path.relative(out, path.join(bench, "jobs", "jobs", job.id, img.file!)).replaceAll("\\", "/").replaceAll(" ", "%20")})`);
  }
  lines.push("");
}
writeFileSync(path.join(out, "cards.md"), lines.join("\n"));

console.log(
  `Done in ${(runTimeMs / 1000).toFixed(0)}s: ${cards.length} cards (${cards.filter((c) => !c.maybe).length} within the target)` +
    `${run.failed.length ? ` · ${run.failed.length} slides FAILED` : ""}${otherModel ? " · ANOTHER MODEL ANSWERED: doesn't count" : ""}`,
);
console.log(`Saved to ${path.relative(root, out)}`);
