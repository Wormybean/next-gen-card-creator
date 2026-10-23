// app/backend.ts for the add-on: the same calls, done inside Anki. Card writing, Define and
// reading PDFs run right here in the page (the same lib/ code the web server runs); files,
// the collection and the keys go through Python.

import type { AppConfig, backend as webBackend, Usage } from "../../../app/backend";
import { aiError } from "../../../lib/ai-errors";
import { withApiKeys } from "../../../lib/generate";
import {
  createJob,
  deleteJob,
  getJob,
  loadDraft,
  pictureKey,
  saveDraft,
  type Job,
  type SavedDraft,
  type UploadMode,
} from "../../../lib/jobs";
import { draftToNotes } from "../../../lib/notes";
import { AFMT, CSS, FIELDS, NOTETYPE_ID, NOTETYPE_NAME, QFMT } from "../../../lib/notetype";
import type { DraftCard } from "../../../lib/rules";
import {
  addPicture,
  addReadingUpload,
  defineForJob,
  generateForJob,
  type DefineRequest,
  type GenerateRequest,
  type GenerateResult,
  type OnProgress,
  type ReadingStatus,
} from "../../../lib/service";
import { addonBase, py } from "./bridge";
import { collection, loadCollection } from "./collection";

const bytes = async (file: Blob) => new Uint8Array(await file.arrayBuffer());

/** The collection is read once when the window opens (it can be large); config() and decks() share that read. */
let collectionRead: Promise<void> | null = null;
const collectionReady = () => (collectionRead ??= loadCollection());

/**
 * A Gemini key put in the add-on's config by hand (not offered in the window): cards then go to
 * Gemini directly when there is no OpenRouter key.
 */
const geminiKey = () => py<string>("getGeminiKey").catch(() => "");

async function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withApiKeys({ openRouter: key || null, gemini: await geminiKey() }, fn);
  } catch (e) {
    throw new Error(aiError(e).error);
  }
}

const cardCount = (n: number) => `${n} card${n === 1 ? "" : "s"}`;

function addedMessage(deck: string, { added, updated, unchanged }: { added: number; updated: number; unchanged: number }) {
  const parts: string[] = [];
  if (added) parts.push(`Added ${cardCount(added)} to ${deck}.`);
  if (updated) parts.push(`Updated ${cardCount(updated)} already in Anki.`);
  if (unchanged) parts.push(`${cardCount(unchanged)} already in Anki ${unchanged === 1 ? "was" : "were"} unchanged.`);
  return parts.join(" ");
}

/** Must offer everything the web version does: the page is bundled with this one in its place. */
export const backend: typeof webBackend = {
  async config(): Promise<AppConfig> {
    await collectionReady();
    return {
      online: false,
      directUpload: false,
      // The OpenRouter key is the user's own, kept in the add-on's config (storedKey); a Gemini
      // key set up there by hand means none is needed.
      serverKey: !!(await geminiKey()),
      hasCollection: true,
      inAnki: true,
      defaultDeck: collection.currentDeck() || "Next-gen Card Creator",
    };
  },

  async decks(): Promise<string[]> {
    await collectionReady();
    return collection.decks();
  },

  /** The add-on's config holds the key, so it lasts across Anki restarts (Tools → Add-ons → Config shows it too). */
  storedKey: () => py<string>("getKey"),
  saveKey: (key: string) => py<void>("setKey", key),

  async createJob(files: File[], mode?: UploadMode): Promise<Job> {
    return createJob(await Promise.all(files.map(async (f) => ({ name: f.name, data: await bytes(f) }))), mode);
  },

  async openJob(id: string): Promise<{ job: Job; draft: SavedDraft | null } | null> {
    try {
      return { job: await getJob(id), draft: await loadDraft(id) };
    } catch {
      return null;
    }
  },

  saveDraft,
  deleteJob,

  generate: (id: string, req: GenerateRequest, key: string, onProgress?: OnProgress): Promise<GenerateResult> =>
    withKey(key, () => generateForJob(id, req, onProgress)),

  define: (id: string, req: DefineRequest, key: string): Promise<{ definition: string; usage: Usage }> =>
    withKey(key, () => defineForJob(id, req)),

  async uploadReading(id: string, url: string, file: File): Promise<ReadingStatus> {
    return addReadingUpload(id, url, file.name, await bytes(file));
  },

  async addPicture(id: string, picture: Blob): Promise<string> {
    return addPicture(id, await bytes(picture), picture.type);
  },

  /** Adds the cards straight to the open collection; cards added before (same guid) are updated instead. */
  async exportCards(job: Job, deck: string, tags: string[], cards: DraftCard[]): Promise<string> {
    const notes = await draftToNotes(job, tags, cards, (img) => py<string>("addMedia", pictureKey(job.id, img)));
    const deckName = deck.trim() || "Next-gen Card Creator";
    const done = await py<{ added: number; updated: number; unchanged: number }>("addNotes", {
      deck: deckName,
      notetype: { id: NOTETYPE_ID, name: NOTETYPE_NAME, fields: FIELDS, qfmt: QFMT, afmt: AFMT, css: CSS },
      notes,
    });
    // The duplicate check and deck list should see the new cards.
    collectionRead = loadCollection();
    return addedMessage(deckName, done);
  },

  slideUrl: (id: string, slide: number) => `${addonBase}user_files/jobs/${id}/slide-${slide}.png`,
  imageUrl: (id: string, file: string) => `${addonBase}user_files/jobs/${id}/${file}`,
};
