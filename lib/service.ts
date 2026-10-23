// What the page asks for, beyond plain storage: card writing, definitions, uploaded readings
// and pictures. The web version runs this behind its API routes; the add-on runs it in the
// page itself, with storage, the collection and page fetching swapped for Anki's.

import { plainText } from "./cloze";
import { collection } from "./collection";
import { DuplicateIndex } from "./dedupe";
import { defineTerm, generateCsblCards, generateLectureCards, type OnProgress, type Usage } from "./generate";
import { allSlidesText, getJob, loadUploads, saveImage, saveUpload, slidePng, type SavedDraft } from "./jobs";
import { makeImageCards } from "./image-cards";
import { cardSettings, type CardSettings } from "./lecture-run";
import { fetchReading, readUpload, type Reading } from "./readings";
import { LECTURE_TYPES, type DraftCard, type LectureType } from "./rules";

export type ReadingStatus = NonNullable<SavedDraft["readings"]>[number];

export type { OnProgress, Progress } from "./generate";

export type GenerateRequest = {
  type: LectureType;
  /** How the cards are written; anything left out is the default (lib/lecture-run.ts). */
  settings?: Partial<CardSettings>;
  /** Lecture: which slides to write cards for. */
  slides?: number[];
  /** CSBL: uploaded readings to make extra cards from, skipping the rest. */
  supplement?: string[];
};

export type GenerateResult = {
  cards: DraftCard[];
  usage: Usage;
  keyPoints: string[];
  /** CSBL only. */
  knowledgeQuestions?: number;
  readings?: ReadingStatus[];
};

export type DefineRequest = { term: string; card: string; slide?: number; question?: string };

let dupIndex: { source: unknown; index: DuplicateIndex } | null = null;

function flagDuplicates(cards: DraftCard[]): DraftCard[] {
  try {
    const notes = collection.clozeNotes();
    if (dupIndex?.source !== notes) dupIndex = { source: notes, index: new DuplicateIndex(notes) };
    // An image card tests recognising a picture, which a text card on the same condition doesn't.
    return cards.map((c) => (c.imageCard ? c : { ...c, duplicateOf: dupIndex!.index.find(c.text) }));
  } catch {
    return cards; // collection unreadable: skip the check rather than fail the run
  }
}

/** Draft cards for some of a lecture's slides, or for a whole question set. */
export async function generateForJob(id: string, req: GenerateRequest, onProgress?: OnProgress): Promise<GenerateResult> {
  if (!LECTURE_TYPES.includes(req.type)) throw new Error("Unknown lecture type");
  const settings = cardSettings(req.settings);
  const job = await getJob(id);
  if (job.mode === "csbl") {
    const uploads = await loadUploads(id);
    // A link the user uploaded a file for isn't fetched again; the file stands in for it.
    const links = req.supplement ?? job.links ?? [];
    let opened = 0;
    if (links.length) onProgress?.({ stage: "readings", done: 0, total: links.length });
    const linked: (Reading & { uploaded?: boolean })[] = await Promise.all(
      links.map(async (url) => {
        const reading = uploads[url] ? { url, ok: true, uploaded: true, ...uploads[url] } : await fetchReading(url);
        onProgress?.({ stage: "readings", done: ++opened, total: links.length });
        return reading;
      }),
    );
    // The files chosen alongside the questions; adding cards from uploads later leaves them out.
    const files: (Reading & { file: true })[] = req.supplement
      ? []
      : (job.readingFiles ?? []).map((f) => ({
          url: `file:${f.name}`,
          title: f.name.replace(/\.pdf$/i, ""),
          ok: true,
          text: f.text,
          truncated: f.truncated,
          file: true,
        }));
    const readings: (Reading & { uploaded?: boolean; file?: boolean })[] = [...files, ...linked];
    const { cards, usage, knowledgeQuestions, keyPoints } = await generateCsblCards(
      job.sessionPlanText ?? "",
      readings,
      !!req.supplement,
      settings,
      onProgress,
    );
    return {
      cards: flagDuplicates(cards),
      usage,
      knowledgeQuestions,
      keyPoints,
      readings: readings.map(({ url, title, ok, problem, truncated, uploaded, file }) => ({ url, title, ok, problem, truncated, uploaded, file })),
    };
  }
  const indices = (req.slides ?? []).filter((i) => job.slides[i]);
  const batch = await Promise.all(
    indices.map(async (i) => ({ index: i, text: job.slides[i].text, png: await slidePng(id, i) })),
  );
  const { cards, usage, keyPoints, imageCards } = await generateLectureCards(
    req.type,
    job.name,
    allSlidesText(job),
    batch,
    settings,
    onProgress,
  );
  return { cards: flagDuplicates([...cards, ...(await makeImageCards(job, imageCards))]), usage, keyPoints };
}

/** A short definition of a term the user highlighted on a card, for its back. */
export async function defineForJob(id: string, req: DefineRequest): Promise<{ definition: string; usage: Usage }> {
  const term = req.term?.trim();
  if (!term || term.length > 120) throw new Error("Select a term of a few words to define");
  const job = await getJob(id);
  const slideText = req.slide !== undefined ? job.slides[req.slide]?.text : undefined;
  return defineTerm(term, { card: plainText(req.card ?? ""), lecture: job.name, slideText, question: req.question });
}

/** The user's own copy of a pre-reading whose link wouldn't open (PDF or Word). */
export async function addReadingUpload(id: string, url: string, name: string, data: Uint8Array): Promise<ReadingStatus> {
  const job = await getJob(id);
  if (!job.links?.includes(url)) throw new Error("That isn't one of this case's readings");
  const reading = await readUpload(name, data);
  await saveUpload(id, url, reading);
  return { url, title: reading.title, ok: true, truncated: reading.truncated, uploaded: true };
}

/** Pictures arrive already cropped and scaled down in the browser, so this is generous. */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** A picture for a card (a slide crop or a pasted / dropped image); returns its file name. */
export async function addPicture(id: string, data: Uint8Array, contentType: string): Promise<string> {
  await getJob(id);
  if (!data.length) throw new Error("No picture sent");
  if (data.length > MAX_PICTURE_BYTES) throw new Error("That picture is too big (over 8 MB)");
  return saveImage(id, data, contentType);
}
