// Everything the page asks of the outside world, in one place. This is the web version: each
// call goes to this app's API routes. The Anki add-on bundles addon/src/anki/backend.ts in
// its place, which does the same work inside Anki.

import { upload as uploadToBlob } from "@vercel/blob/client";
import type { Job, SavedDraft, UploadMode } from "@/lib/jobs";
import type { Usage } from "@/lib/generate";
import type { DraftCard } from "@/lib/rules";
import type { DefineRequest, GenerateRequest, GenerateResult, OnProgress, Progress, ReadingStatus } from "@/lib/service";

export type AppConfig = {
  online: boolean;
  /** Online, large files go straight to Vercel Blob (a request to the server is capped at 4.5 MB). */
  directUpload: boolean;
  /** An AI key is already set up (your own computer's .env.local, or a Gemini key in the add-on's config). */
  serverKey: boolean;
  hasCollection: boolean;
  /** Cards go straight into the open Anki collection instead of a downloaded .apkg. */
  inAnki?: boolean;
  /** The deck new lectures start with (in Anki, the deck selected there). */
  defaultDeck?: string;
};

const KEY_STORAGE = "ngcc.openRouterKey";

export type { Usage };

async function json<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({ error: `${fallback} (${res.status})` }));
  if (!res.ok) throw new Error(data.error);
  return data as T;
}

const keyHeaders = (key: string): Record<string, string> => (key ? { "x-openrouter-key": key } : {});

let directUpload = false;

/** Online a request to this server is capped at 4.5 MB, so files go straight to storage first. */
async function sendToStorage(file: File): Promise<{ name: string; key: string }> {
  const safe = file.name.replace(/[^\w.\- ]+/g, "_");
  const result = await uploadToBlob(`incoming/${crypto.randomUUID()}/${safe}`, file, {
    access: "private",
    handleUploadUrl: "/api/upload",
  });
  return { name: file.name, key: result.pathname };
}

export const backend = {
  async config(): Promise<AppConfig> {
    const c = await json<AppConfig>(await fetch("/api/config"), "Couldn't reach the server");
    directUpload = c.directUpload;
    return c;
  },

  async decks(): Promise<string[]> {
    const d = await fetch("/api/decks").then((r) => r.json());
    return d.decks ?? [];
  },

  /** An OpenRouter key saved earlier, or "". The website keeps it in this browser only; the server never stores it. */
  async storedKey(): Promise<string> {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  },

  /** Saves the key ("" removes it). */
  async saveKey(key: string): Promise<void> {
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      // Private browsing can refuse storage: the key then lasts until the page is closed.
    }
  },

  /** `mode` overrides the guess at whether the files are a lecture or a question set. */
  async createJob(files: File[], mode?: UploadMode): Promise<Job> {
    let res: Response;
    try {
      if (directUpload) {
        const refs = await Promise.all(files.map(sendToStorage));
        res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: refs, mode }),
        });
      } else {
        const form = new FormData();
        for (const f of files) form.append("files", f);
        if (mode) form.append("mode", mode);
        res = await fetch("/api/jobs", { method: "POST", body: form });
      }
    } catch (e) {
      throw new Error(`Couldn't send the file: ${(e as Error).message}`);
    }
    return (await json<{ job: Job }>(res, "The server could not read that file")).job;
  },

  /** A job and its saved draft, or null if it's gone. */
  async openJob(id: string): Promise<{ job: Job; draft: SavedDraft | null } | null> {
    const data = await fetch(`/api/jobs/${id}`).then((r) => r.json());
    return data.job ? data : null;
  },

  async saveDraft(id: string, draft: SavedDraft): Promise<void> {
    await fetch(`/api/jobs/${id}/draft`, { method: "PUT", body: JSON.stringify(draft) });
  },

  async deleteJob(id: string): Promise<void> {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
  },

  /** `onProgress` hears what the AI is doing while the cards are written (see the generate route). */
  async generate(id: string, req: GenerateRequest, key: string, onProgress?: OnProgress): Promise<GenerateResult> {
    const res = await fetch(`/api/jobs/${id}/generate`, { method: "POST", headers: keyHeaders(key), body: JSON.stringify(req) });
    if (!res.ok || !res.body) return json(res, "Something went wrong on the server. Try again");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffered += value ?? "";
      const lines = buffered.split("\n");
      buffered = done ? "" : lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const msg = JSON.parse(line) as { progress?: Progress; result?: GenerateResult; error?: string };
        if (msg.progress) onProgress?.(msg.progress);
        else if (msg.result) return msg.result;
        else if (msg.error) throw new Error(msg.error);
      }
      if (done) throw new Error("The server stopped before the cards were finished. Try again");
    }
  },

  async define(id: string, req: DefineRequest, key: string): Promise<{ definition: string; usage: Usage }> {
    const res = await fetch(`/api/jobs/${id}/define`, {
      method: "POST",
      headers: { ...keyHeaders(key), "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return json(res, "Something went wrong on the server");
  },

  /** A Word/PDF copy of a reading that wouldn't open; it's used from now on. */
  async uploadReading(id: string, url: string, file: File): Promise<ReadingStatus> {
    let res: Response;
    if (directUpload) {
      const ref = await sendToStorage(file);
      res = await fetch(`/api/jobs/${id}/readings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, ...ref }),
      });
    } else {
      const form = new FormData();
      form.append("url", url);
      form.append("file", file);
      res = await fetch(`/api/jobs/${id}/readings`, { method: "POST", body: form });
    }
    return (await json<{ reading: ReadingStatus }>(res, "The server couldn't read that file")).reading;
  },

  /** Stores a picture that is already cropped and scaled; returns its file name. */
  async addPicture(id: string, picture: Blob): Promise<string> {
    const form = new FormData();
    form.append("file", picture, picture.type === "image/png" ? "picture.png" : "picture.jpg");
    const res = await fetch(`/api/jobs/${id}/images`, { method: "POST", body: form });
    return (await json<{ file: string }>(res, "The server couldn't take that picture")).file;
  },

  /** Downloads the .apkg. Returns what to tell the user, if anything. */
  async exportCards(job: Job, deck: string, tags: string[], cards: DraftCard[]): Promise<string> {
    const res = await fetch(`/api/jobs/${job.id}/export`, { method: "POST", body: JSON.stringify({ deck, tags, cards }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: `Export failed (${res.status})` }))).error);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = /filename="(.+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "cards.apkg";
    a.click();
    URL.revokeObjectURL(a.href);
    return "";
  },

  slideUrl: (id: string, slide: number) => `/api/jobs/${id}/slides/${slide}`,
  imageUrl: (id: string, file: string) => `/api/jobs/${id}/images/${file}`,
};
