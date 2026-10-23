// A "job" is one upload: its slide pictures and text, plus the latest draft cards so a
// page refresh doesn't lose work. Stored on disk under config.jobsDir().

import { IMAGE_FILE, migrateCard, setOwnSlide, type CardImage } from "./extras";
import { pdfLinks, readPdf } from "./pdf";
import { readingFromText } from "./readings";
import { guessLectureType, isQuestionSheet, questionCount, type DraftCard, type LectureType } from "./rules";
import { deleteFolder, getFile, getText, putFile } from "./store";

export type Job = {
  id: string;
  name: string;
  mode: "lecture" | "csbl";
  guessedType: LectureType;
  createdAt: string;
  /** Lecture mode: one entry per slide. */
  slides: { index: number; text: string; pictures?: StoredPicture[] }[];
  /** The files the user chose, by name. */
  sources?: string[];
  /** Question-set ("csbl") mode: the question sheet's text, and links found in any of the files. */
  sessionPlanText?: string;
  links?: string[];
  /** Question-set mode: the other files the user chose, as reading material. */
  readingFiles?: { name: string; text: string; truncated: boolean }[];
};

/**
 * A picture cut out of a slide without the labels drawn over it (lib/pdf.ts), stored as its own
 * file ("pic-<slide>-<n>.jpg") so an image card can show it on the front.
 */
export type StoredPicture = {
  file: string;
  /** Where it sits on the slide, as fractions of the slide: [left, top, right, bottom]. */
  box: [number, number, number, number];
  /** Text laid over it on the slide, left out of the stored picture. */
  labels?: string[];
};

/** How to read an upload; normally it is worked out from the files. */
export type UploadMode = "lecture" | "csbl";

export type SavedDraft = {
  type: LectureType;
  deck: string;
  tags: string;
  cards: (DraftCard & { include: boolean })[];
  /** Set once every lecture card has had its own slide added by default (drafts saved before that get it on loading). */
  slidesOnBack?: boolean;
  /** Key points of the whole lecture or case, shown at the top of the review. */
  summary?: string[];
  /** Question sets: which reading material could be used. */
  readings?: {
    url: string;
    title: string;
    ok: boolean;
    problem?: string;
    truncated: boolean;
    /** One of the files the user chose, not a link. */
    file?: boolean;
    /** The user uploaded this one themselves. */
    uploaded?: boolean;
    /** Its cards have been made (so "add cards from uploads" skips it). */
    carded?: boolean;
  }[];
};

const jobFolder = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Bad job id");
  return `jobs/${id}`;
};

const keyOf = (id: string, name: string) => `${jobFolder(id)}/${name}`;

const slideKey = (id: string, index: number) => keyOf(id, `slide-${Math.trunc(Number(index))}.png`);

/**
 * Reads an upload. One file being a question sheet (a UQ CSBL session plan, or any document of
 * questions) makes it a question set, with the other files as reading material. Otherwise every
 * file is lecture slides, one after another. `mode` overrides the guess.
 */
export async function createJob(files: { name: string; data: Uint8Array }[], mode?: UploadMode): Promise<Job> {
  if (!files.length) throw new Error("No PDF uploaded");
  const id = crypto.randomUUID();

  const read = files.map((f) => {
    const pages = readPdf(f.data, { images: false });
    const text = pages.map((p) => p.text).join("\n\n");
    return { ...f, text, pages: pages.length, type: guessLectureType(f.name, text), questions: questionCount(text) };
  });
  const byQuestions = [...read].sort((a, b) => b.questions - a.questions);
  const sheet =
    mode === "lecture"
      ? undefined
      : (read.find((f) => f.type === "csbl") ??
        byQuestions.find((f) => isQuestionSheet(f.text, f.pages)) ??
        (mode === "csbl" ? byQuestions[0] : undefined));
  const baseName = (name: string) => name.replace(/\.pdf$/i, "").trim();
  const sources = files.map((f) => f.name);

  let job: Job;
  if (sheet) {
    job = {
      id,
      name: baseName(sheet.name).replace(/\s*session plan\s*$/i, ""),
      mode: "csbl",
      guessedType: "csbl",
      createdAt: new Date().toISOString(),
      slides: [],
      sources,
      sessionPlanText: sheet.text,
      links: [...new Set(read.flatMap((f) => pdfLinks(f.data)))],
      // A file that is little more than a list of links (UQ's pre-reading list) adds nothing as text.
      readingFiles: read
        .filter((f) => f !== sheet && f.text.replace(/https?:\/\/\S+/g, "").split(/\s+/).filter(Boolean).length >= 150)
        .map((f) => ({ name: f.name, ...readingFromText(f.name, f.text.trim()) })),
    };
  } else {
    // Several files are one lecture in several parts: their slides follow on.
    const slides: Job["slides"] = [];
    for (const f of read) {
      const pages = readPdf(f.data);
      const stored = await Promise.all(
        pages.map(async (p) => {
          const index = slides.length + p.index;
          await putFile(slideKey(id, index), p.png, "image/png");
          return Promise.all(
            p.pictures.map(async (pic, n): Promise<StoredPicture> => {
              const file = `pic-${index}-${n}.jpg`;
              await putFile(keyOf(id, file), pic.jpeg, "image/jpeg");
              return { file, box: pic.box, ...(pic.labels.length && { labels: pic.labels }) };
            }),
          );
        }),
      );
      slides.push(
        ...pages.map((p, i) => ({
          index: slides.length + p.index,
          text: p.text,
          ...(stored[i].length && { pictures: stored[i] }),
        })),
      );
    }
    const names = read.map((f) => baseName(f.name));
    job = {
      id,
      name: names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names[0]} & ${names.length - 1} more`,
      mode: "lecture",
      guessedType: read.length === 1 ? read[0].type : guessLectureType(names.join(" "), read.map((f) => f.text).join("\n\n")),
      createdAt: new Date().toISOString(),
      sources,
      slides,
    };
  }
  await putFile(keyOf(id, "job.json"), JSON.stringify(job, null, 2), "application/json");
  return job;
}

export async function getJob(id: string): Promise<Job> {
  const text = await getText(keyOf(id, "job.json"));
  if (!text) throw new Error("Job not found");
  return JSON.parse(text);
}

export async function slidePng(id: string, index: number): Promise<Uint8Array> {
  const png = await getFile(slideKey(id, index));
  if (!png) throw new Error("Slide not found");
  return png;
}

export async function saveDraft(id: string, draft: SavedDraft): Promise<void> {
  await putFile(keyOf(id, "draft.json"), JSON.stringify(draft), "application/json");
}

export async function loadDraft(id: string): Promise<SavedDraft | null> {
  const text = await getText(keyOf(id, "draft.json"));
  if (!text) return null;
  const draft = JSON.parse(text) as SavedDraft;
  const cards = draft.cards.map(migrateCard);
  // Drafts from before slides went on the back by default get them now, once.
  return { ...draft, slidesOnBack: true, cards: draft.slidesOnBack ? cards : cards.map((c) => setOwnSlide(c, true)) };
}

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const imageContentType = (file: string) =>
  Object.keys(IMAGE_TYPES).find((t) => file.endsWith(`.${IMAGE_TYPES[t]}`)) ?? "application/octet-stream";

/** Saves a picture the user added to a card (a slide crop or a paste); returns its file name. */
export async function saveImage(id: string, data: Uint8Array, contentType: string): Promise<string> {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw new Error("Only PNG, JPEG, WebP or GIF pictures can be added");
  const file = `img-${crypto.randomUUID()}.${ext}`;
  await putFile(keyOf(id, file), data, contentType);
  return file;
}

export async function imageFile(id: string, file: string): Promise<Uint8Array> {
  if (!IMAGE_FILE.test(file)) throw new Error("Bad picture name");
  const data = await getFile(keyOf(id, file));
  if (!data) throw new Error("Picture not found");
  return data;
}

/** Where a card's picture is stored: one of the lecture's slides, or a crop or paste. */
export function pictureKey(id: string, img: CardImage): string {
  if (img.file === undefined) return slideKey(id, img.slide);
  if (!IMAGE_FILE.test(img.file)) throw new Error("Bad picture name");
  return keyOf(id, img.file);
}

export const pictureFile = (id: string, img: CardImage) =>
  img.file !== undefined ? imageFile(id, img.file) : slidePng(id, img.slide);

/** All slide text in one block, numbered, for context in every request. */
export function allSlidesText(job: Job): string {
  return job.slides.map((s) => `--- Slide ${s.index + 1} ---\n${s.text || "(no text)"}`).join("\n\n");
}

/** Readings the user uploaded for links that wouldn't open, keyed by the link's URL. */
export type UploadedReadings = Record<string, { title: string; text: string; truncated: boolean }>;

export async function loadUploads(id: string): Promise<UploadedReadings> {
  const text = await getText(keyOf(id, "uploads.json"));
  return text ? JSON.parse(text) : {};
}

export async function saveUpload(id: string, url: string, reading: UploadedReadings[string]): Promise<void> {
  const all = await loadUploads(id);
  all[url] = reading;
  await putFile(keyOf(id, "uploads.json"), JSON.stringify(all), "application/json");
}

/**
 * Deletes everything stored for a job: its slides, draft, uploaded readings and card pictures,
 * including pictures that were added and then taken off a card.
 */
export async function deleteJob(id: string): Promise<void> {
  await deleteFolder(jobFolder(id));
}
