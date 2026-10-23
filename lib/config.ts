import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  GEMINI_CARD_MODELS,
  GEMINI_DEFINE_MODELS,
  OPENROUTER_CARD_MODELS,
  OPENROUTER_DEFINE_MODELS,
  withFallback,
  type Service,
} from "./models";

/** A comma-separated list from the environment, or undefined when it isn't set. */
const list = (value: string | undefined) => (value ? value.split(",").map((m) => m.trim()).filter(Boolean) : undefined);

const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");

/** Where Anki keeps its profiles on this computer. */
const ankiFolder = () =>
  process.platform === "win32"
    ? path.join(appData, "Anki2")
    : process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "Anki2")
      : path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "Anki2");

/** "User 1" if it exists, otherwise the first profile that has a collection. */
function ankiCollection(): string {
  const folder = ankiFolder();
  const preferred = path.join(folder, "User 1", "collection.anki2");
  if (existsSync(preferred)) return preferred;
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name, "collection.anki2");
      if (entry.isDirectory() && existsSync(file)) return file;
    }
  } catch {
    // No Anki folder here (online, or Anki isn't installed).
  }
  return preferred;
}

export const config = {
  /** The user's Anki collection. Only ever copied, never opened in place. */
  collectionPath: () => process.env.ANKI_COLLECTION ?? ankiCollection(),
  /** Uploaded PDFs, slide pictures and draft cards. Kept outside OneDrive so it isn't synced. */
  jobsDir: () => process.env.CARDMAKER_DATA ?? path.join(localAppData, "AnkiCardMaker", "jobs"),
  /**
   * Models to try for writing cards, in order; when one is busy the next is tried.
   * OPENROUTER_MODEL or GEMINI_MODEL (comma-separated) overrides the service's list.
   */
  models: (service: Service) =>
    service === "openrouter"
      ? (list(process.env.OPENROUTER_MODEL) ?? OPENROUTER_CARD_MODELS)
      : (list(process.env.GEMINI_MODEL) ?? GEMINI_CARD_MODELS),
  /**
   * Models for term definitions, then the card models if those are busy. Gemini's are small and
   * fast (about 1.5 s, against 5 s or more for its card models). GEMINI_DEFINE_MODEL overrides them.
   */
  defineModels: (service: Service) =>
    withFallback(
      service === "openrouter" ? OPENROUTER_DEFINE_MODELS : (list(process.env.GEMINI_DEFINE_MODEL) ?? GEMINI_DEFINE_MODELS),
      config.models(service),
    ),
};
