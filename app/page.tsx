// Next-gen Card Creator. Copyright (C) 2026 Wormybean.
// Licensed under the GNU Affero General Public License v3 or later, with the additional terms in NOTICE.
"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addCloze,
  blanks,
  clozeNumbers,
  combineCloze,
  rawRange,
  removeCloze,
  setBlankNumber,
  type TextEdit,
} from "@/lib/cloze";
import { flagRepeats } from "@/lib/dedupe";
import {
  handAdded,
  knownDefinition,
  mergeDefinitions,
  mergeImages,
  ownSlide,
  selectedTerm,
  type CardImage,
  type Definition,
} from "@/lib/extras";
import type { Job, SavedDraft, UploadMode } from "@/lib/jobs";
import { DEFAULT_SETTINGS, flagTextRepeats, lectureCards, limitImageCards, splitSlides, writeLecture } from "@/lib/lecture-run";
import { cropSlide, pictureFromFile } from "@/lib/picture";
import {
  LECTURE_TYPES,
  LECTURE_TYPE_LABELS,
  applyTarget,
  cardTarget,
  checkCard,
  type DraftCard,
  type LectureType,
} from "@/lib/rules";
import { openRouterCredit, type Credit } from "@/lib/openrouter";
import type { OnProgress, Progress, ReadingStatus } from "@/lib/service";
import { backend, type AppConfig, type Usage } from "./backend";

/**
 * One request on the "Writing cards" screen: its slides (none for a CSBL), when it was sent, and
 * how far it is. `work` is the share of it the AI has shown it has done, which only goes up.
 */
type BatchState = { slides: number[]; started?: number; progress?: Progress; work?: number; cards?: number; done?: boolean };
type Writing = { started: number; batches: BatchState[] };

/** The "Writing cards" screen at its start: one batch per list of slides ([[]] for a question set). */
const startWriting = (batches: number[][]): Writing => ({ started: Date.now(), batches: batches.map((slides) => ({ slides })) });
/** A batch's request has just been sent. */
const sentNow = (): Partial<BatchState> => ({ started: Date.now() });

type Card = DraftCard & { include: boolean };
type Stage = "upload" | "setup" | "generating" | "review";

/** How the app writes cards (lib/lecture-run.ts); the speed tests try other settings. */
const SETTINGS = DEFAULT_SETTINGS;
/** New lectures' deck, unless Anki's selected deck is known (the add-on); each lecture keeps the one chosen for it. */
const DEFAULT_DECK = "Next-gen Card Creator";
/** The public source code, which the AGPL says users of the app (and the website) must be offered. */
const SOURCE_URL = "https://github.com/Wormybean/next-gen-card-creator";
/** Donations; linked from the add-on's upload screen (and its AnkiWeb listing). */
const KOFI_URL = "https://ko-fi.com/nextgenankicreator";

/** Cloze text → preview HTML with the blanks highlighted. */
function preview(text: string): string {
  let k = 0;
  return text.replace(
    /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g,
    (_m, n, answer, hint) =>
      `<span class="blank" data-blank="${k++}" title="c${n}${hint ? ` · hint: ${hint}` : ""}"><sup>${n}</sup>${answer}</span>`,
  );
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [job, setJob] = useState<Job | null>(null);
  const [type, setType] = useState<LectureType>("medical-science");
  const [deck, setDeck] = useState(DEFAULT_DECK);
  const [tags, setTags] = useState("");
  const [decks, setDecks] = useState<string[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [usage, setUsage] = useState<Usage>({ inputTokens: 0, outputTokens: 0, cost: 0 });
  const [summary, setSummary] = useState<string[]>([]);
  const [readings, setReadings] = useState<ReadingStatus[]>([]);
  const [writing, setWriting] = useState<Writing | null>(null);
  /** What is left on the user's OpenRouter account, asked again after each request; null until known. */
  const [credit, setCredit] = useState<Credit | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** The result of Add to Anki / Export, popped up at the bottom of the window wherever the page is scrolled. */
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  /** Add to Anki says "Added ✓" for a moment after it has worked. */
  const [justAdded, setJustAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [bigSlide, setBigSlide] = useState<number | null>(null);
  const [failedSlides, setFailedSlides] = useState<number[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadingUrl, setUploadingUrl] = useState("");
  const [config, setConfig] = useState<AppConfig>({ online: false, directUpload: false, serverKey: true, hasCollection: true });
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  /** The card whose "+ Image" picker is open, and the slide it opens on. */
  const [picker, setPicker] = useState<{ cardId: string; slide: number } | null>(null);
  /** The cards already have their slides by default (fresh cards, or a draft the server has brought up to date). */
  const [slidesOnBack, setSlidesOnBack] = useState(false);

  // Every change to the cards goes through change(), which keeps the undo history.
  // cardsRef mirrors the latest cards so back-to-back changes build on each other.
  const cardsRef = useRef<Card[]>([]);
  const undoStack = useRef<Card[][]>([]);
  const lastEdit = useRef({ key: "", at: 0 });
  const [undoCount, setUndoCount] = useState(0);

  /** `key` joins quick successive edits (typing in one box) into a single undo step. */
  const change = useCallback((fn: (prev: Card[]) => Card[], key?: string) => {
    const prev = cardsRef.current;
    const next = fn(prev);
    if (next === prev) return;
    const now = Date.now();
    const joined = !!key && lastEdit.current.key === key && now - lastEdit.current.at < 1000;
    lastEdit.current = { key: key ?? "", at: now };
    if (!joined) {
      undoStack.current.push(prev);
      if (undoStack.current.length > 100) undoStack.current.shift();
      setUndoCount(undoStack.current.length);
    }
    cardsRef.current = next;
    setCards(next);
  }, []);

  /** Replaces all cards (a fresh run or a reopened draft) and forgets the undo history. */
  const loadCards = (list: Card[]) => {
    undoStack.current = [];
    setUndoCount(0);
    cardsRef.current = list;
    setCards(list);
  };

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    lastEdit.current = { key: "", at: 0 };
    cardsRef.current = prev;
    setCards(prev);
    setUndoCount(undoStack.current.length);
  }, []);

  // Ctrl+Z. A box's own undo is unreliable once React controls it, so take over everywhere
  // except the one-line boxes (deck, tags, why), which keep the browser's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type !== "checkbox") return;
      if (!undoStack.current.length) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  useEffect(() => {
    backend.config().then(async (c) => {
      setApiKey(await backend.storedKey());
      setConfig(c);
      if (c.defaultDeck) setDeck(c.defaultDeck);
    });
    backend.decks().then(setDecks);
    // Reopen the job named in the URL, with its saved draft.
    const id = new URLSearchParams(location.search).get("job");
    if (!id) return;
    backend.openJob(id).then((opened) => {
      if (!opened) return;
      const { job, draft } = opened;
      setJob(job);
      setType(draft?.type ?? job.guessedType);
      if (draft) {
        setDeck(draft.deck);
        setTags(draft.tags);
        setReadings(draft.readings ?? []);
        setSummary(draft.summary ?? []);
        setSlidesOnBack(!!draft.slidesOnBack);
        loadCards(draft.cards);
        setStage("review");
      } else setStage("setup");
    });
  }, []);

  // Autosave the draft while reviewing.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (stage !== "review" || !job) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const draft: SavedDraft = { type, deck, tags, cards, readings, summary, slidesOnBack };
      backend.saveDraft(job.id, draft);
    }, 600);
  }, [stage, job, type, deck, tags, cards, readings, summary, slidesOnBack]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.bad ? 12000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!justAdded) return;
    const timer = setTimeout(() => setJustAdded(false), 3000);
    return () => clearTimeout(timer);
  }, [justAdded]);

  // Closing now would lose work that lives only in this page (cards being written). The add-on
  // asks before its window closes (addon/__init__.py reads this flag); a browser tab asks its own way.
  const working = stage === "generating" || busy || exporting;
  useEffect(() => {
    (window as unknown as { __ngccWorking?: boolean }).__ngccWorking = working;
    if (!working || config.inAnki) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [working, config.inAnki]);

  function keyMissing(): boolean {
    if (apiKey || config.serverKey) return false;
    setKeyOpen(true);
    setError("Add your OpenRouter key first (the steps are at the top of the page).");
    return true;
  }

  /** The files of this upload, so the setup screen can read them again the other way. */
  const [uploaded, setUploaded] = useState<File[]>([]);

  async function upload(files: FileList | File[] | null, mode?: UploadMode) {
    if (!files?.length) return;
    const list = Array.from(files);
    setError("");
    setBusy(true);
    let j: Job;
    try {
      j = await backend.createJob(list, mode);
    } catch (e) {
      setBusy(false);
      return setError((e as Error).message);
    }
    setBusy(false);
    setUploaded(list);
    // Read the other way: the first reading of these files is no longer needed.
    if (mode && job) void backend.deleteJob(job.id);
    setJob(j);
    setType(j.guessedType);
    setTags(j.name.replace(/\s+/g, "_"));
    history.replaceState(null, "", `?job=${j.id}`);
    setStage("setup");
  }

  /** The credit left on the saved key's account (a failed ask leaves the last one shown). */
  const refreshCredit = useCallback(() => {
    if (apiKey) openRouterCredit(apiKey).then(setCredit, () => undefined);
  }, [apiKey]);
  useEffect(refreshCredit, [refreshCredit]);

  const addUsage = (u: Usage) => {
    setUsage((prev) => ({
      inputTokens: prev.inputTokens + u.inputTokens,
      outputTokens: prev.outputTokens + u.outputTokens,
      cost: (prev.cost ?? 0) + (u.cost ?? 0),
    }));
    refreshCredit();
  };

  async function callGenerate(slides?: number[], onProgress?: OnProgress) {
    const data = await backend.generate(job!.id, { type, slides, settings: SETTINGS }, apiKey, onProgress);
    addUsage(data.usage);
    return data;
  }

  /** Updates one batch on the "Writing cards" screen. */
  const updateBatch = (i: number, change: Partial<BatchState> | ((b: BatchState) => Partial<BatchState>)) =>
    setWriting(
      (w) =>
        w && {
          ...w,
          batches: w.batches.map((b, j) => (j === i ? { ...b, ...(typeof change === "function" ? change(b) : change) } : b)),
        },
    );
  const batchProgress = (i: number) => (p: Progress) =>
    updateBatch(i, (b) => ({
      progress: p,
      work: Math.max(b.work ?? 0, workDone(b, p)),
      ...(p.stage === "writing" && { cards: p.cards }),
    }));

  /** Cards over the target ("maybe"), probable repeats and image cards whose picture shows the answer start unticked. */
  const withTicks = (list: DraftCard[]): Card[] =>
    list.map((c) => ({ ...c, include: !c.maybe && !c.duplicateOf && !c.imageCard?.answerShows }));

  async function generateAll() {
    if (!job || keyMissing()) return;
    setError("");
    setStage("generating");
    setUsage({ inputTokens: 0, outputTokens: 0, cost: 0 });
    setSlidesOnBack(true);
    try {
      if (job.mode === "csbl") {
        setWriting(startWriting([[]]));
        updateBatch(0, sentNow());
        const data = await callGenerate(undefined, batchProgress(0));
        setSummary(data.keyPoints ?? []);
        setReadings((data.readings ?? []).map((r) => ({ ...r, carded: r.ok })));
        loadCards(withTicks(applyTarget(flagRepeats(data.cards), cardTarget("csbl", data.knowledgeQuestions ?? 1))));
      } else {
        const batches = splitSlides(
          job.slides.map((s) => s.index),
          SETTINGS.slidesPerRequest,
        );
        setWriting(startWriting(batches));
        const run = await writeLecture(batches, callGenerate, SETTINGS.atOnce, {
          onStart: (i) => updateBatch(i, sentNow()),
          onProgress: (i, p) => batchProgress(i)(p),
          onDone: (i, result) => updateBatch(i, { done: true, cards: result?.cards.length ?? 0 }),
        });
        if (run.failed.length === job.slides.length) throw new Error(run.lastError);
        setSummary(run.results.flatMap((r) => r?.keyPoints ?? []));
        loadCards(withTicks(lectureCards(run, type, job.slides)));
        setFailedSlides(run.failed);
        if (run.failed.length)
          setError(`${run.failed.length} slides couldn't be done (${run.lastError}). Use "Retry failed slides" above.`);
      }
      setStage("review");
    } catch (e) {
      setError((e as Error).message);
      setStage("setup");
    }
  }

  /** Re-asks for the given slides and swaps their cards in, keeping slide order. */
  async function regenerateSlides(slides: number[]): Promise<boolean> {
    const data = await callGenerate(slides);
    const redone = new Set(slides);
    const fresh: Card[] = data.cards.map((c) => ({ ...c, include: !c.duplicateOf }));
    const isFresh = new Set(fresh.map((c) => c.id));
    change((prev) =>
      limitImageCards(
        flagTextRepeats(
          [...prev.filter((c) => !redone.has(c.slide ?? -1)), ...fresh].sort((a, b) => (a.slide ?? 0) - (b.slide ?? 0)),
        ),
        job!.slides.length,
      ).map((c) => (c.duplicateOf && isFresh.has(c.id) ? { ...c, include: false } : c)),
    );
    return true;
  }

  /** Sends a Word/PDF copy of a reading that wouldn't open; it's used from now on. */
  async function uploadReading(url: string, file: File | undefined) {
    if (!file || !job) return;
    setError("");
    setUploadingUrl(url);
    try {
      const reading = await backend.uploadReading(job.id, url, file);
      setReadings((prev) => prev.map((r) => (r.url === url ? reading : r)));
    } catch (e) {
      setError(`Couldn't use that file: ${(e as Error).message}`);
    }
    setUploadingUrl("");
  }

  /** Makes extra cards from the uploaded readings only, adding them without touching the rest. */
  async function addFromUploads() {
    const urls = readings.filter((r) => r.uploaded && r.ok && !r.carded).map((r) => r.url);
    if (!urls.length || keyMissing()) return;
    setBusy(true);
    setError("");
    try {
      const data = await backend.generate(job!.id, { type, supplement: urls }, apiKey);
      addUsage(data.usage);
      const fresh: Card[] = data.cards.map((c) => ({ ...c, include: !c.duplicateOf }));
      const isNew = new Set(fresh.map((c) => c.id));
      change((prev) =>
        flagRepeats([...prev, ...fresh]).map((c) => (c.duplicateOf && isNew.has(c.id) ? { ...c, include: false } : c)),
      );
      setReadings((prev) => prev.map((r) => (urls.includes(r.url) ? { ...r, carded: true } : r)));
      if (!fresh.length) setError("The uploaded readings didn't answer any of the case's knowledge questions.");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function regenerateSlide(slide: number) {
    const lost = handAdded(cardsRef.current.filter((c) => c.slide === slide));
    const what = [plural(lost.images, "image"), plural(lost.definitions, "definition")].filter(Boolean).join(" and ");
    if (what && !confirm(`Regenerating replaces this slide's cards, so the ${what} you added will go. Continue? (Undo brings them back.)`))
      return;
    setBusy(true);
    setError("");
    try {
      await regenerateSlides([slide]);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function retryFailed() {
    setBusy(true);
    setError("");
    let still = [...failedSlides];
    for (const chunk of splitSlides(failedSlides, SETTINGS.slidesPerRequest)) {
      try {
        await regenerateSlides(chunk);
        still = still.filter((s) => !chunk.includes(s));
      } catch (e) {
        setError(`Still couldn't do ${still.length} slides: ${(e as Error).message}`);
      }
    }
    setFailedSlides(still);
    setBusy(false);
  }

  async function deleteMyFiles() {
    if (!job || !confirm("Delete this lecture's slides and cards from the server? You can't get them back.")) return;
    await backend.deleteJob(job.id);
    // A full page load on purpose: it resets every piece of state.
    location.search = "";
  }

  const update = useCallback(
    (id: string, patch: Partial<Card>, key?: string) => {
      change(
        (prev) =>
          prev.map((c) => {
            if (c.id !== id) return c;
            const next = { ...c, ...patch };
            if (patch.text !== undefined) next.warnings = checkCard(next.text);
            return next;
          }),
        key && `${id}:${key}`,
      );
    },
    [change],
  );

  const remove = useCallback((id: string) => change((prev) => prev.filter((c) => c.id !== id)), [change]);

  const toggleSelect = useCallback(
    (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  /** Merges the cards ticked "combine" into one, renumbering blanks so none overlap. */
  function combineSelected() {
    const picked = cardsRef.current.filter((c) => selected.has(c.id));
    if (picked.length < 2) return;
    const text = combineCloze(picked.map((c) => c.text));
    const merged: Card = {
      ...picked[0],
      text,
      warnings: checkCard(text),
      include: true,
      maybe: false,
      duplicateOf: undefined,
      why: picked.map((c) => c.why).filter(Boolean).join(" ") || undefined,
      images: mergeImages(picked.map((c) => c.images)),
      definitions: mergeDefinitions(picked.map((c) => c.definitions)),
      priority: Math.min(...picked.map((c) => c.priority)) as 1 | 2 | 3,
      fromKnowledge: picked.some((c) => c.fromKnowledge) || undefined,
      source: [...new Set(picked.map((c) => c.source).filter(Boolean))].join("; ") || undefined,
    };
    const gone = new Set(picked.map((c) => c.id));
    change((prev) => prev.flatMap((c) => (c.id === picked[0].id ? [merged] : gone.has(c.id) ? [] : [c])));
    setSelected(new Set());
  }

  const addCard = (slide?: number, question?: string) =>
    change((prev) => {
      const card: Card = {
        id: crypto.randomUUID(),
        slide,
        question,
        text: "<b>Subject</b> … {{c1::answer}}",
        images: slide !== undefined ? [ownSlide(slide)] : [],
        priority: 2,
        warnings: [],
        include: true,
      };
      const last = prev.findLastIndex((c) => (slide !== undefined ? c.slide === slide : c.question === question));
      return last === -1 ? [...prev, card] : [...prev.slice(0, last + 1), card, ...prev.slice(last + 1)];
    });

  /** A term defined on any card of this lecture is reused; otherwise the AI is asked (one request). */
  async function defineTerm(card: Card, term: string): Promise<string> {
    const known = knownDefinition(cardsRef.current, term);
    if (known) return known;
    if (keyMissing()) throw new Error("no OpenRouter key yet");
    const data = await backend.define(job!.id, { term, card: card.text, slide: card.slide, question: card.question }, apiKey);
    addUsage(data.usage);
    return data.definition;
  }

  // These two run after an await, so they build on the latest cards rather than the card as it was.
  const addDefinition = (cardId: string, d: Definition) =>
    change((prev) => prev.map((c) => (c.id === cardId ? { ...c, definitions: [...(c.definitions ?? []), d] } : c)));

  const addImage = (cardId: string, img: CardImage) =>
    change((prev) => prev.map((c) => (c.id === cardId ? { ...c, images: [...c.images, img] } : c)));

  /** Uploads a picture that is already cropped and scaled, and adds it to the back of the card. */
  async function addPicture(cardId: string, picture: Blob) {
    const file = await backend.addPicture(job!.id, picture);
    addImage(cardId, { id: crypto.randomUUID(), file, front: false });
  }

  async function exportApkg() {
    if (!job) return;
    const chosen = cards.filter((c) => c.include);
    const bad = chosen.find((c) => !/\{\{c\d+::/.test(c.text));
    if (bad) {
      const message = `A ticked card has no blanks: "${bad.text.slice(0, 60)}…"`;
      setError(message);
      return setToast({ text: message, bad: true });
    }
    setExporting(true);
    setError("");
    try {
      const message = await backend.exportCards(job, deck, ["CardMaker", ...tags.split(/[\s,]+/).filter(Boolean)], chosen);
      setNotice(message);
      setToast({ text: message });
      setJustAdded(true);
      // A new deck name is now one of the collection's decks.
      if (config.inAnki) backend.decks().then(setDecks);
    } catch (e) {
      setError((e as Error).message);
      setToast({ text: `Couldn't ${config.inAnki ? "add the cards" : "export"}: ${(e as Error).message}`, bad: true });
    }
    setExporting(false);
  }

  // Group cards under their slide (lectures) or discussion question (CSBL).
  const groups = useMemo(() => {
    if (!job) return [];
    if (job.mode === "csbl") {
      const order: string[] = [];
      const by = new Map<string, Card[]>();
      for (const c of cards) {
        const q = c.question ?? "";
        if (!by.has(q)) {
          by.set(q, []);
          order.push(q);
        }
        by.get(q)!.push(c);
      }
      return order.map((q) => ({ key: q, slide: undefined as number | undefined, question: q as string | undefined, cards: by.get(q)! }));
    }
    return job.slides
      .map((s) => ({
        key: `s${s.index}`,
        slide: s.index as number | undefined,
        question: undefined as string | undefined,
        cards: cards.filter((c) => c.slide === s.index),
      }))
      .filter((g) => showEmpty || g.cards.length);
  }, [job, cards, showEmpty]);

  const ticked = cards.filter((c) => c.include);
  const reviews = ticked.reduce((n, c) => n + new Set(c.text.match(/\{\{c\d+::/g) ?? []).size, 0);

  // Online every visitor brings a key; on your own computer only when .env.local has none.
  const needsKey = config.online || !config.serverKey;
  const keyPanel = (openWithoutKey: boolean) => (
    <KeyPanel
      apiKey={apiKey}
      setApiKey={setApiKey}
      open={keyOpen}
      setOpen={setKeyOpen}
      online={config.online}
      openWithoutKey={openWithoutKey}
    />
  );

  function showKey() {
    setKeyOpen(true);
    requestAnimationFrame(() => document.getElementById("key")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <main>
      <header className="top">
        <h1>Next-gen Card Creator</h1>
        {stage === "upload" && config.online && (
          <nav aria-label="Main" className="top-nav">
            <a href="#how">How it works</a>
            <a href="#addon">Anki add-on</a>
          </nav>
        )}
        {stage === "upload" && needsKey && !apiKey && (
          <a
            href="#key"
            className="key-pill"
            onClick={(e) => {
              e.preventDefault();
              showKey();
            }}
          >
            OpenRouter key needed
          </a>
        )}
        {job && <span className="job">{job.name}</span>}
        {apiKey && credit && <CreditLine credit={credit} lectureCost={usage.cost ?? 0} />}
        {job && config.online && (
          <button className="link" onClick={deleteMyFiles} title="Remove this lecture's slides and cards from the server now">
            Delete my files now
          </button>
        )}
        {job && (
          // A full page load on purpose: it resets every piece of state. "?" keeps the page's own
          // address, which in the add-on isn't the site root.
          <a className="link" href="?">
            New lecture
          </a>
        )}
      </header>

      {stage !== "upload" && needsKey && keyPanel(true)}

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {stage === "upload" && (
        <Landing
          busy={busy}
          upload={upload}
          online={config.online}
          inAnki={!!config.inAnki}
          keyLine={
            needsKey && (
              <>
                <p className="key-line">
                  {apiKey
                    ? "Your OpenRouter key is saved."
                    : "Uses your own OpenRouter account: the AI costs about 2–3 US cents a lecture, from credit you add yourself."}{" "}
                  <button className="link" onClick={showKey}>
                    {apiKey ? "Change it" : "Set up your key"}
                  </button>
                </p>
                {keyOpen && keyPanel(false)}
              </>
            )
          }
        />
      )}

      {stage === "setup" && job && (
        <section className="setup">
          <p>{uploadSummary(job)}</p>
          {uploaded.length > 0 && (
            <button
              className="link setup-switch"
              disabled={busy}
              onClick={() => upload(uploaded, job.mode === "csbl" ? "lecture" : "csbl")}
            >
              {busy
                ? "Reading the files again…"
                : job.mode === "csbl"
                  ? "These are lecture slides, not questions"
                  : "These are questions to answer, not lecture slides"}
            </button>
          )}
          <label>
            Lecture type <small>(my guess, change it if wrong)</small>
            <select value={type} onChange={(e) => setType(e.target.value as LectureType)} disabled={job.mode === "csbl"}>
              {LECTURE_TYPES.filter((t) => (job.mode === "csbl") === (t === "csbl")).map((t) => (
                <option key={t} value={t}>
                  {LECTURE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <DeckAndTags deck={deck} setDeck={setDeck} tags={tags} setTags={setTags} decks={decks} />
          <button className="primary" onClick={generateAll}>
            Make cards
          </button>
        </section>
      )}

      {stage === "generating" && job && writing && (
        <WritingProgress writing={writing} lecture={job.mode === "lecture"} slideCount={job.slides.length} inAnki={!!config.inAnki} />
      )}

      {stage === "review" && job && (
        <>
          <section className="bar">
            <DeckAndTags deck={deck} setDeck={setDeck} tags={tags} setTags={setTags} decks={decks} />
            <span>
              {ticked.length} of {cards.length} cards ticked · {count(reviews, "review")}
            </span>
            {failedSlides.length > 0 && (
              <button className="link danger-text" disabled={busy} onClick={retryFailed}>
                {busy ? "Retrying…" : `Retry failed slides (${failedSlides.map((s) => s + 1).join(", ")})`}
              </button>
            )}
            {job.mode === "lecture" && (
              <label className="inline">
                <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} /> show
                slides with no cards
              </label>
            )}
            <button className="link" disabled={!undoCount} onClick={undo} title="Undo the last change · Ctrl+Z">
              ↶ Undo{undoCount ? ` (${undoCount})` : ""}
            </button>
            {selected.size > 0 && (
              <>
                <button className="tool" disabled={selected.size < 2} onClick={combineSelected}>
                  Combine {selected.size} selected into one card
                </button>
                <button className="link" onClick={() => setSelected(new Set())}>
                  Clear selection
                </button>
              </>
            )}
            <button className="primary" onClick={exportApkg} disabled={busy || exporting || !ticked.length}>
              {exporting
                ? config.inAnki
                  ? "Adding…"
                  : "Exporting…"
                : justAdded
                  ? config.inAnki
                    ? "Added ✓"
                    : "Exported ✓"
                  : config.inAnki
                    ? "Add to Anki"
                    : "Export .apkg"}
            </button>
          </section>

          {summary.length > 0 && (
            <section className="summary">
              <h2>Key points</h2>
              <ul>
                {summary.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </section>
          )}

          {readings.length > 0 && (
            <details className="readings" open={readings.some((r) => !r.ok && !r.uploaded)}>
              <summary>
                Reading material: {readings.filter((r) => r.ok).length} of {readings.length} could be used
              </summary>
              <ul>
                {readings.map((r) => (
                  <li key={r.url}>
                    {r.ok ? "✓" : "✗"}{" "}
                    {r.file ? (
                      <span>{r.title}</span>
                    ) : (
                      <a href={r.url} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                    )}
                    {r.file && <span className="muted"> · your file</span>}
                    {r.problem && <span className="muted"> · {r.problem}</span>}
                    {r.truncated && <span className="muted"> · very long, only the first part was used</span>}
                    {r.uploaded && <span className="muted"> · your upload{r.carded ? "" : ": cards not made yet"}</span>}
                    {!r.ok && (
                      <label className="upload">
                        <input
                          type="file"
                          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                          disabled={!!uploadingUrl}
                          onChange={(e) => {
                            void uploadReading(r.url, e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        {uploadingUrl === r.url ? "Reading file…" : "Upload PDF or Word instead"}
                      </label>
                    )}
                  </li>
                ))}
              </ul>
              {readings.some((r) => r.uploaded && r.ok && !r.carded) && (
                <button className="primary" disabled={busy} onClick={addFromUploads}>
                  {busy
                    ? "Making cards…"
                    : `Add cards from ${readings.filter((r) => r.uploaded && r.ok && !r.carded).length} uploaded reading(s)`}
                </button>
              )}
            </details>
          )}

          {groups.map((g) => (
            <section key={g.key} className="group">
              <div className="source">
                {g.slide !== undefined ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local slide renders, no optimisation needed */}
                    <img
                      src={backend.slideUrl(job.id, g.slide)}
                      alt={`Slide ${g.slide + 1}`}
                      onClick={() => setBigSlide(g.slide!)}
                    />
                    <div className="source-actions">
                      <span>Slide {g.slide + 1}</span>
                      <button className="link" disabled={busy} onClick={() => regenerateSlide(g.slide!)}>
                        Regenerate
                      </button>
                      <button className="link" onClick={() => addCard(g.slide)}>
                        + Card
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="question">{g.question}</p>
                    <button className="link" onClick={() => addCard(undefined, g.question)}>
                      + Card
                    </button>
                  </>
                )}
              </div>
              <div className="cards">
                {g.cards.length === 0 && <p className="muted">No cards for this slide.</p>}
                {g.cards.map((c) => (
                  <CardEditor
                    key={c.id}
                    card={c}
                    jobId={job.id}
                    isLecture={job.mode === "lecture"}
                    canAddImages={!config.online}
                    update={update}
                    remove={remove}
                    combining={selected.has(c.id)}
                    toggleCombine={toggleSelect}
                    define={defineTerm}
                    addDefinition={addDefinition}
                    addPicture={addPicture}
                    openPicker={() => setPicker({ cardId: c.id, slide: c.slide ?? 0 })}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {bigSlide !== null && job && (
        <div className="lightbox" onClick={() => setBigSlide(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local slide render */}
          <img src={backend.slideUrl(job.id, bigSlide)} alt="" />
        </div>
      )}

      {picker && job && (
        <ImagePicker
          jobId={job.id}
          slideCount={job.slides.length}
          start={picker.slide}
          onWhole={(slide) => {
            addImage(picker.cardId, { id: crypto.randomUUID(), slide, front: false });
            setPicker(null);
          }}
          onCrop={async (picture) => {
            await addPicture(picker.cardId, picture);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {toast && (
        <div className={`toast ${toast.bad ? "bad" : ""}`} role={toast.bad ? "alert" : "status"}>
          <span>
            {!toast.bad && "✓ "}
            {toast.text}
          </span>
          <button className="link" aria-label="Dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </main>
  );
}

/** US dollars: "$4.74", and small amounts to a tenth of a cent ("$0.019"). */
const dollars = (n: number) => `$${n.toFixed(n > 0 && n < 0.1 ? 3 : 2)}`;

/**
 * What is left on the user's OpenRouter account, and what this lecture has cost so far. A line
 * in the header; click it for the key's own limit and where to add credit.
 */
function CreditLine({ credit, lectureCost }: { credit: Credit; lectureCost: number }) {
  const low = credit.left < 1;
  return (
    <details className={`allowance ${low ? "low" : ""}`}>
      <summary>OpenRouter credit: {dollars(credit.left)} left</summary>
      <div className="allowance-panel">
        <ul>
          <li>
            <strong>Credit left:</strong> {dollars(credit.left)}. A lecture usually costs about 2–3 US cents.
          </li>
          {lectureCost > 0 && (
            <li>
              <strong>This lecture so far:</strong> {dollars(lectureCost)}
            </li>
          )}
          {credit.keyLimit !== undefined && credit.keyLeft !== undefined && (
            <li>
              <strong>This key&apos;s limit:</strong> {dollars(credit.keyLeft)} of {dollars(credit.keyLimit)} left
              {credit.keyResets ? ` this ${credit.keyResets === "monthly" ? "month" : credit.keyResets.replace(/ly$/, "")}` : ""}.
            </li>
          )}
        </ul>
        <p>
          Add credit at{" "}
          <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">
            openrouter.ai/settings/credits
          </a>
          . With Auto Top-Up off, you never spend more than the credit you bought.
        </p>
      </div>
    </details>
  );
}

/** "24 slides from 2 files", or "Questions from Week 3 case · 2 reading files · 4 links". */
function uploadSummary(job: Job): string {
  const files = job.sources?.length ?? 1;
  if (job.mode === "lecture") return `${count(job.slides.length, "slide")}${files > 1 ? ` from ${files} files` : ""}`;
  const parts = [`Questions + reading material: questions from “${job.name}”`];
  if (job.readingFiles?.length) parts.push(count(job.readingFiles.length, "reading file"));
  parts.push(`${count(job.links?.length ?? 0, "link")} to readings`);
  return parts.join(" · ");
}

/**
 * Roughly how long one request takes, in seconds: the AI plans for a while, then writes slide by slide.
 * Claude Haiku at low thinking did 15 slides in about 25–80 s (2026-10-23).
 */
const expectedSeconds = (b: BatchState) => (b.slides.length ? 15 + 3 * b.slides.length : 180);

/**
 * The share of a request that its progress shows is done. Planning shows nothing, so the cards
 * arriving (slide by slide) count from halfway, and the check afterwards is nearly the end.
 */
function workDone(b: BatchState, p: Progress): number {
  if (p.stage === "checking") return 0.92;
  if (p.stage !== "writing" || p.slide === undefined || !b.slides.length) return 0;
  return 0.5 + 0.42 * Math.min(Math.max((p.slide - b.slides[0]) / b.slides.length, 0), 1);
}

/**
 * How much of a request is done: the larger of what the AI has shown and the clock, which moves
 * steadily up to the expected time and then slows, so the bar never stalls or reaches the end on its own.
 */
function batchShare(b: BatchState, now: number): number {
  if (b.done) return 1;
  if (!b.started) return 0;
  const t = (now - b.started) / 1000 / expectedSeconds(b);
  const byTime = t <= 1 ? 0.8 * t : 0.8 + 0.15 * (1 - Math.exp(1 - t));
  return Math.min(Math.max(byTime, b.work ?? 0), 0.97);
}

/** "about 3 minutes", "under a minute". */
const minutes = (seconds: number) => (seconds < 60 ? "under a minute" : `about ${count(Math.round(seconds / 60), "minute")}`);

/**
 * While the AI writes the cards, which can take minutes: how far along it is (a percentage and the
 * time left), the cards so far, and what is happening now, so it never looks frozen.
 */
function WritingProgress({
  writing,
  lecture,
  slideCount,
  inAnki,
}: {
  writing: Writing;
  lecture: boolean;
  slideCount: number;
  inAnki: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { batches } = writing;
  const active = batches.filter((b) => !b.done && b.progress);
  const stage = (s: Progress["stage"]) => active.map((b) => b.progress!).find((p) => p.stage === s);
  const cards = batches.reduce((n, b) => n + (b.cards ?? 0), 0);
  const fraction = batches.reduce((n, b) => n + batchShare(b, now), 0) / batches.length;

  const writingNow = stage("writing");
  const retrying = stage("retrying");
  const checking = stage("checking");
  const readings = stage("readings");
  const thought = stage("thinking");
  const latestSlide = Math.max(0, ...active.map((b) => (b.progress?.stage === "writing" ? (b.progress.slide ?? 0) : 0)));
  const message =
    retrying?.stage === "retrying"
      ? `The AI is busy right now, so this waits ${retrying.seconds} seconds and tries again.`
      : writingNow
        ? lecture && latestSlide
          ? `Writing cards… up to slide ${latestSlide} of ${slideCount}`
          : "Writing cards…"
        : checking?.stage === "checking"
          ? `Tidying ${count(checking.cards, "card")} that broke the card rules…`
          : readings?.stage === "readings"
            ? `Opening the readings (${readings.done} of ${readings.total})…`
            : lecture && cards > 0
              ? "The AI is planning the cards for the rest of the slides."
              : lecture
                ? `The AI is reading ${count(slideCount, "slide")} and planning the cards.`
                : "The AI is reading the questions and readings and planning the cards.";

  const seconds = Math.max(0, Math.floor((now - writing.started) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  // Time left from the pace so far; until there is some, the usual time for this many slides.
  const usual = Math.ceil(batches.length / SETTINGS.atOnce) * Math.max(...batches.map(expectedSeconds));
  const timeLeft =
    seconds >= 15 && fraction >= 0.05
      ? `${minutes((seconds * (1 - fraction)) / fraction)} left`
      : `usually ${minutes(usual)}${lecture ? ` for ${count(slideCount, "slide")}` : ""}`;

  return (
    <section className="setup writing" aria-live="polite">
      <p className="writing-now">
        <span className="spinner" aria-hidden="true" />
        {message}
      </p>
      {thought?.stage === "thinking" && !writingNow && !retrying && (
        <p className="writing-thought">Thinking: {thought.note}</p>
      )}
      <div className="writing-bar">
        <progress value={fraction} max={1} aria-label="Cards written" />
        <strong>{Math.floor(fraction * 100)}%</strong>
      </div>
      <p className="writing-meta">
        {elapsed} so far · {timeLeft}
        {cards > 0 && ` · ${count(cards, "card")} written`}
        {" · "}
        {inAnki
          ? "You can minimise this window and keep using Anki while this runs."
          : "Keep this page open while this runs."}
      </p>
    </section>
  );
}

/** A cartoon cup of coffee with steam and a heart, for the Ko-fi button. */
function CoffeeCup() {
  return (
    <svg className="kofi-cup" width="40" height="40" viewBox="0 0 48 48" aria-hidden="true">
      {/* steam */}
      <path className="kofi-steam" d="M17 13c-2-3 2-4 0-7M24 13c-2-3 2-4 0-7M31 13c-2-3 2-4 0-7" fill="none" stroke="#b9a99a" strokeWidth="2" strokeLinecap="round" />
      {/* saucer */}
      <ellipse cx="24" cy="42" rx="17" ry="3.5" fill="#e9d8c6" stroke="#6b4a33" strokeWidth="2" />
      {/* handle */}
      <path d="M36 21h3a5 5 0 0 1 0 10h-3" fill="none" stroke="#6b4a33" strokeWidth="2.5" />
      {/* cup */}
      <path d="M9 17h28v11a12 12 0 0 1-12 12h-4A12 12 0 0 1 9 28Z" fill="#ffffff" stroke="#6b4a33" strokeWidth="2.5" strokeLinejoin="round" />
      {/* coffee */}
      <path d="M11 17h24" stroke="#8a5a3b" strokeWidth="4" strokeLinecap="round" />
      {/* heart */}
      <path d="M23 34c-4-3-6-5-6-7.5a3 3 0 0 1 6-.5 3 3 0 0 1 6 .5c0 2.5-2 4.5-6 7.5Z" fill="#ff5e5b" />
    </svg>
  );
}

/** The upload screen. Online it is also the landing page, so it explains the app below the drop zone. */
function Landing({
  busy,
  upload,
  online,
  inAnki,
  keyLine,
}: {
  busy: boolean;
  upload: (files: FileList | null) => void;
  online: boolean;
  inAnki: boolean;
  keyLine: React.ReactNode;
}) {
  const [over, setOver] = useState(false);

  return (
    <div className="landing">
      <section className="hero">
        <h2>Turn a lecture PDF into Anki cloze cards</h2>
        <p className="lede">
          Next-gen Card Creator reads every slide and writes short, high-yield cloze cards. You check each one, then export
          straight into Anki.
        </p>
        <label
          className={`drop ${busy ? "busy" : ""} ${over ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) upload(e.dataTransfer.files);
          }}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
            <path d="M14 3v5h5" />
            <path d="M12 18v-6" />
            <path d="m9 15 3-3 3 3" />
          </svg>
          <strong>{busy ? "Reading PDF…" : "Choose a lecture PDF"}</strong>
          <span>
            or drop it here. Studying from a set of questions instead? Choose the questions together with any reading
            material.
          </span>
          <span className="drop-button">Choose PDF</span>
          <input type="file" accept="application/pdf" multiple onChange={(e) => upload(e.target.files)} disabled={busy} />
        </label>
        {keyLine}
        {inAnki && (
          <a className="kofi" href={KOFI_URL} target="_blank" rel="noreferrer">
            <CoffeeCup />
            <span>
              <strong>Support our development</strong> Treat us to a coffee on Ko-fi
            </span>
          </a>
        )}
        <p className="legal-line">
          Next-gen Card Creator by Wormybean · © 2026 · Free software with no warranty, under the{" "}
          <a href={`${SOURCE_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>{" "}
          ·{" "}
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code
          </a>
        </p>
      </section>

      {online && (
        <>
          <section id="how" className="how">
            <h2>How it works</h2>
            <ol>
              <li>
                <span>Step 1</span>
                <h3>Upload the lecture</h3>
                <p>Pick the lecture type, deck and tags. The AI costs about 2–3 US cents a lecture, from your own OpenRouter credit.</p>
              </li>
              <li>
                <span>Step 2</span>
                <h3>Review every card</h3>
                <p>Each card shows its front and back, with its slide. Highlight words to blank or define them.</p>
              </li>
              <li>
                <span>Step 3</span>
                <h3>Export to Anki</h3>
                <p>Download the .apkg and double-click it. Exporting again later updates the cards you already have.</p>
              </li>
            </ol>
          </section>

          <section className="example">
            <h2>From one slide</h2>
            <div className="example-row">
              <div className="example-slide" aria-label="Example lecture slide">
                <div>
                  <strong>Signs of dysphagia</strong>
                  <ul>
                    <li>Coughing/choking/throat clearing on oral intake</li>
                    <li>Recurrent chest infections</li>
                    <li>Wet, gurgly voice during/after oral intake</li>
                    <li>Poor saliva control</li>
                    <li>Poor oral intake</li>
                  </ul>
                </div>
                <div className="example-picture" />
              </div>
              <svg width="40" height="24" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="becomes" className="example-arrow">
                <path d="M2 12h34" />
                <path d="m28 4 8 8-8 8" />
              </svg>
              <div className="example-card">
                <div>
                  <span className="side-label">Front</span>
                  <p>
                    A classic bedside vocal sign of post-stroke <b>dysphagia</b> after oral intake is a{" "}
                    <span className="example-blank">[…]</span>.
                  </p>
                </div>
                <div>
                  <span className="side-label">Back</span>
                  <p className="example-answer">wet, gurgly voice</p>
                  <p className="example-def">
                    <b>dysphagia</b>: Difficulty or discomfort in swallowing, commonly seen following a stroke.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section id="addon" className="addon">
            <div>
              <h2>Rather make cards inside Anki?</h2>
              <p>
                The Anki add-on adds cards straight to your collection with no export, checks for cards you already have,
                lets you crop slides and paste pictures, and shows no ads.
              </p>
            </div>
            <span className="soon">Anki add-on coming soon</span>
          </section>

          <footer className="landing-foot">
            <span>Your files are deleted within 48 hours. Your key stays in this browser.</span>
            <span>Cards are written by AI and can be wrong. They are not medical advice.</span>
            <a href="https://openrouter.ai/terms" target="_blank" rel="noreferrer">
              OpenRouter terms
            </a>
          </footer>
        </>
      )}
    </div>
  );
}

/** Where the user pastes their own OpenRouter key, with the steps to get one. */
function KeyPanel({
  apiKey,
  setApiKey,
  open,
  setOpen,
  online,
  openWithoutKey,
}: {
  apiKey: string;
  setApiKey: (k: string) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  online: boolean;
  /** Stay open until a key is saved (after upload, when cards can't be made without one). */
  openWithoutKey: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [show, setShow] = useState(false);

  function save() {
    const key = draft.trim();
    void backend.saveKey(key);
    setApiKey(key);
    setDraft("");
    setOpen(false);
  }

  function remove() {
    void backend.saveKey("");
    setApiKey("");
  }

  const where = online ? "in this browser" : "on this computer";

  return (
    <details
      id="key"
      className="keybox"
      open={open || (openWithoutKey && !apiKey)}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{apiKey ? `Your OpenRouter key: saved ${where} ✓` : "Your OpenRouter key: needed before you can make cards"}</summary>

      {apiKey && (
        <p>
          A key ending in <strong>…{apiKey.slice(-4)}</strong> is saved {where} only.{" "}
          <button className="link danger-text" onClick={remove}>
            Remove it
          </button>
        </p>
      )}

      <p>
        Next-gen Card Creator writes cards with AI through <em>your</em> OpenRouter account. The add-on is free; the AI costs
        about 2–3 US cents a lecture, paid from credit you add yourself. Setting it up takes about three minutes the first time:
      </p>
      <ol className="key-steps">
        <li>
          Make a free OpenRouter account at{" "}
          <a href="https://openrouter.ai/sign-up" target="_blank" rel="noreferrer">
            openrouter.ai/sign-up
          </a>{" "}
          (Google, GitHub or email).
          <StepPicture n={1} alt="OpenRouter's Sign Up page, with the Google, GitHub and MetaMask buttons circled" />
        </li>
        <li>
          Open{" "}
          <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noreferrer">
            openrouter.ai/settings/credits
          </a>{" "}
          and press <strong>Add Credits</strong>. Leave <strong>Auto Top-Up</strong> off.
          <StepPicture n={2} alt="OpenRouter's Credits page, with Add Credits circled and Auto Top-Up marked Leave this off" />
        </li>
        <li>
          Add a payment card, type an amount and press <strong>Purchase</strong>. US$10 is plenty: that&apos;s hundreds of
          lectures. OpenRouter adds a US$0.80 fee plus tax, shown before you pay. Credit you don&apos;t use can expire after a
          year.
          <StepPicture n={3} alt="The Purchase Credits box, with the amount (10) and Purchase circled" />
        </li>
        <li>
          Open{" "}
          <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">
            openrouter.ai/settings/keys
          </a>{" "}
          and press <strong>New Key</strong>.
          <StepPicture n={4} alt="OpenRouter's API Keys page, with New Key circled" />
        </li>
        <li>
          Name it (for example &ldquo;Next-gen Card Creator&rdquo;), set <strong>Expiration</strong> to 1 year,{" "}
          <strong>Credit limit</strong> to Custom amount → 5, and <strong>Reset limit every…</strong> to Monthly. Press{" "}
          <strong>Create</strong>.
          <StepPicture n={5} alt="The Create API Key box: expiration 1 year, credit limit 5, reset monthly, and Create circled" />
        </li>
        <li>
          Press the copy button next to the key (it starts with <code>sk-or-v1-</code>). OpenRouter shows it only once.
          <StepPicture n={6} alt="The new key, with its copy button circled" />
        </li>
        <li>
          Paste it below, tick the box, and press <strong>Save key</strong>.
          <StepPicture n={7} alt="The key box with a key pasted, the box ticked, and Save key circled" />
        </li>
      </ol>

      <div className="keyrow">
        <input
          type={show ? "text" : "password"}
          value={draft}
          placeholder="Paste your key here"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <label className="inline">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> show
        </label>
        <button className="primary" disabled={draft.trim().length < 20 || !agreed} onClick={save}>
          Save key
        </button>
      </div>
      <label className="inline agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I am 18 or older, I&apos;ve
        read the notes below, and I agree to OpenRouter&apos;s terms.
      </label>

      <h3>Good to know</h3>
      <ul>
        <li>
          {online ? (
            <>
              <strong>Your key is kept in this browser.</strong> This site&apos;s server never stores or logs it; it is sent to
              OpenRouter only when you make cards. Like anything in your browser it can be read by scripts on this page, and the
              page shows Google ads, so don&apos;t save it on a shared computer. &ldquo;Remove it&rdquo; clears it.
            </>
          ) : (
            <>
              <strong>Your key stays on this computer.</strong> It is saved inside this app and sent only to OpenRouter when you
              make cards. &ldquo;Remove it&rdquo; clears it.
            </>
          )}
        </li>
        <li>
          <strong>With Auto Top-Up off, you can never spend more than the credit you bought.</strong> If your key leaks, delete
          it at openrouter.ai/settings/keys; a new one takes a minute.
        </li>
        <li>
          <strong>Your slides go to the AI.</strong> OpenRouter passes them to a company that runs the AI model. Upload only
          material you&apos;re allowed to share: nothing personal or confidential, and no slides your university says not to
          share.
        </li>
        <li>
          <strong>Check the cards.</strong> They are a study aid written by AI and can be wrong. They are not medical advice.
        </li>
        <li>
          <a href="https://openrouter.ai/terms" target="_blank" rel="noreferrer">
            OpenRouter&apos;s terms
          </a>{" "}
          apply to your account. Next-gen Card Creator isn&apos;t made or endorsed by OpenRouter.
        </li>
      </ul>
    </details>
  );
}

/**
 * A screenshot for the key steps (public/key-steps/openrouter; the add-on build copies them next
 * to its page, so the address is relative). Email, balance, card and key in them are placeholders.
 */
function StepPicture({ n, alt }: { n: number; alt: string }) {
  // Shown at about 60% of the screenshot's size, so the pages and the dialogs look the same scale.
  const width = { 1: 255, 2: 600, 3: 262, 4: 600, 5: 308, 6: 308, 7: 600 }[n];
  // eslint-disable-next-line @next/next/no-img-element -- a fixed local picture, the same in the website and the add-on
  return <img className="step-picture" src={`key-steps/openrouter/${n}.png`} alt={alt} loading="lazy" style={{ width }} />;
}

function DeckAndTags(props: {
  deck: string;
  setDeck: (s: string) => void;
  tags: string;
  setTags: (s: string) => void;
  decks: string[];
}) {
  return (
    <>
      <label>
        Deck
        <input list="decks" value={props.deck} onChange={(e) => props.setDeck(e.target.value)} size={48} className="deck-input" />
        <datalist id="decks">
          {props.decks.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </label>
      <label>
        Tags <small>(space-separated; CardMaker is always added)</small>
        <input value={props.tags} onChange={(e) => props.setTags(e.target.value)} size={28} className="tags-input" />
      </label>
    </>
  );
}

/** The floating toolbar: over selected words, or over a blank that was clicked. */
type FloatingTool = { kind: "selection" | "blank"; left: number; top: number; blank?: number };

/** Room the floating toolbar needs above the line it points at. */
const TOOLBAR_HEIGHT = 42;

/**
 * One card, laid out the way Anki shows it: the front (cloze text, edited by selecting words)
 * beside the back (Extra, definitions, pictures).
 */
function CardEditor({
  card,
  jobId,
  isLecture,
  canAddImages,
  update,
  remove,
  combining,
  toggleCombine,
  define,
  addDefinition,
  addPicture,
  openPicker,
}: {
  card: Card;
  jobId: string;
  isLecture: boolean;
  /** Desktop and local only; online the card still shows its own slide. */
  canAddImages: boolean;
  update: (id: string, patch: Partial<Card>, key?: string) => void;
  remove: (id: string) => void;
  combining: boolean;
  toggleCombine: (id: string) => void;
  define: (card: Card, term: string) => Promise<string>;
  addDefinition: (cardId: string, d: Definition) => void;
  addPicture: (cardId: string, picture: Blob) => Promise<void>;
  openPicker: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  // The same object until the text changes: React rewrites the HTML whenever it gets a new one,
  // and rewriting it wipes the user's selection (showing the toolbar is enough to cause that).
  const frontHtml = useMemo(() => ({ __html: preview(card.text) }), [card.text]);
  const frontArea = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<FloatingTool | null>(null);
  const [defining, setDefining] = useState("");
  const [editingDef, setEditingDef] = useState<number | null>(null);
  const [addingPicture, setAddingPicture] = useState(false);
  /** A short message on the card: why Define or a paste didn't work. */
  const [note, setNote] = useState("");
  const definitions = card.definitions ?? [];
  const blankCount = blanks(card.text).length;
  const reviewCount = clozeNumbers(card.text).length;

  /** Where the toolbar goes for something at `rect`: just above it, kept inside the front panel. */
  function placeTool(rect: DOMRect): { left: number; top: number } {
    const area = frontArea.current!.getBoundingClientRect();
    const width = toolbar.current?.offsetWidth ?? 280;
    return {
      left: Math.max(0, Math.min(rect.left - area.left, area.width - width)),
      top: Math.max(0, rect.top - area.top - TOOLBAR_HEIGHT),
    };
  }

  // Show the toolbar while words on the front are selected; a click elsewhere puts it away.
  useEffect(() => {
    const onSelection = () => {
      const root = shown.current;
      const sel = window.getSelection();
      if (root && sel?.rangeCount && !sel.isCollapsed && root.contains(sel.anchorNode) && root.contains(sel.focusNode)) {
        setTool({ kind: "selection", ...placeTool(sel.getRangeAt(0).getBoundingClientRect()) });
      } else {
        setTool((t) => (t?.kind === "selection" ? null : t));
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (toolbar.current?.contains(t) || shown.current?.contains(t)) return;
      setTool(null);
    };
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  // The toolbar's width depends on what it shows (a blank's numbers), so once it has drawn,
  // pull it back inside the front panel if it runs past the edge.
  useLayoutEffect(() => {
    const bar = toolbar.current;
    const area = frontArea.current;
    if (!tool || !bar || !area) return;
    const overflow = tool.left + bar.offsetWidth - area.clientWidth;
    if (overflow > 0) setTool({ ...tool, left: Math.max(0, tool.left - overflow) });
  }, [tool, card.text]);

  /** Clicking a blank on the front offers to change its number, remove it or define it. */
  function onFrontClick(e: React.MouseEvent) {
    const span = (e.target as HTMLElement).closest<HTMLElement>("[data-blank]");
    if (!span || !window.getSelection()?.isCollapsed) return;
    setTool({ kind: "blank", blank: Number(span.dataset.blank), ...placeTool(span.getBoundingClientRect()) });
  }

  /**
   * The selection the toolbar acts on, as positions in the raw text: on the front if that is
   * where you selected, otherwise in the cloze source box.
   */
  function selection(): { start: number; end: number; inBox: boolean } | null {
    const root = shown.current;
    const sel = window.getSelection();
    if (root && sel?.rangeCount && document.activeElement !== box.current && root.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      // Visible characters from the start of the front, not counting the little blank numbers.
      const upTo = (node: Node, offset: number) => {
        const r = document.createRange();
        r.setStart(root, 0);
        r.setEnd(node, offset);
        const part = r.cloneContents();
        part.querySelectorAll("sup").forEach((s) => s.remove());
        return part.textContent?.length ?? 0;
      };
      const start = root.contains(range.startContainer) ? upTo(range.startContainer, range.startOffset) : 0;
      const end = root.contains(range.endContainer) ? upTo(range.endContainer, range.endOffset) : upTo(root, root.childNodes.length);
      return { ...rawRange(card.text, start, end), inBox: false };
    }
    const el = box.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd, inBox: true } : null;
  }

  /** The raw text of the n-th blank on the card, e.g. "{{c1::wet, gurgly voice}}". */
  function blankAt(n: number): { from: number; to: number } | null {
    const m = [...card.text.matchAll(/\{\{c\d+::.*?\}\}/g)][n];
    return m ? { from: m.index, to: m.index + m[0].length } : null;
  }

  // Apply an edit to the text. From the source box, put its cursor back; from the front, clear the selection.
  function applyEdit(edit: TextEdit | null, inBox: boolean) {
    if (!edit) return;
    update(card.id, { text: edit.text });
    setTool(null);
    if (!inBox) {
      window.getSelection()?.removeAllRanges();
      return;
    }
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(edit.selStart, edit.selEnd);
    });
  }

  const cloze = (mode: "same" | "new") => {
    const sel = selection();
    if (sel) applyEdit(addCloze(card.text, sel.start, sel.end, mode), sel.inBox);
  };
  const removeBlank = () => {
    const at = tool?.blank !== undefined ? blankAt(tool.blank) : null;
    if (at) applyEdit(removeCloze(card.text, at.from), false);
  };

  // The clicked blank's number: one already on the card hides it together with those blanks
  // (same review); New gives it a review of its own. The toolbar stays open to show the result.
  const clicked = tool?.kind === "blank" && tool.blank !== undefined ? blanks(card.text)[tool.blank] : undefined;
  const numbersOnCard = clozeNumbers(card.text);
  const aloneInItsNumber = !!clicked && blanks(card.text).filter((b) => b.num === clicked.num).length === 1;
  /** The lowest number not on the card, so a new number fills a gap left by an earlier change. */
  let freeNumber = 1;
  while (numbersOnCard.includes(freeNumber)) freeNumber++;
  const renumber = (num: number) => {
    if (tool?.blank !== undefined) update(card.id, { text: setBlankNumber(card.text, tool.blank, num) });
  };

  async function defineTerm(term: string) {
    setTool(null);
    window.getSelection()?.removeAllRanges();
    if (!term) return setNote("Highlight a word or phrase on the front first, then press Define.");
    if (definitions.some((d) => d.term.trim().toLowerCase() === term.toLowerCase()))
      return setNote(`"${term}" is already defined on this card.`);
    setNote("");
    setDefining(term);
    let definition = "";
    try {
      definition = await define(card, term);
    } catch (e) {
      setNote(`Couldn't get a definition (${(e as Error).message}). Type your own in the box on the back.`);
    }
    setDefining("");
    addDefinition(card.id, { term, definition });
  }
  const defineSelection = () => {
    const sel = selection();
    if (sel && !defining) void defineTerm(selectedTerm(card.text, sel.start, sel.end));
  };
  const defineBlank = () => {
    const at = tool?.blank !== undefined ? blankAt(tool.blank) : null;
    if (at && !defining) void defineTerm(selectedTerm(card.text, at.from, at.to));
  };

  // Anki's own shortcuts work in the source box, and on the front while words there are selected:
  // Ctrl+Shift+C = new number, Ctrl+Shift+Alt+C = same number, Ctrl+Shift+D = define.
  function onShortcut(e: KeyboardEvent | React.KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === "c") cloze(e.altKey ? "same" : "new");
    else if (key === "d" && !e.altKey) defineSelection();
    else return;
    e.preventDefault();
  }
  // The document listener below is added once; this keeps it calling the latest handler.
  const shortcut = useRef(onShortcut);
  useEffect(() => {
    shortcut.current = onShortcut;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sel = window.getSelection();
      if (document.activeElement !== box.current && shown.current && sel && !sel.isCollapsed && shown.current.contains(sel.anchorNode))
        shortcut.current(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const setDefinitions = (list: Definition[]) => update(card.id, { definitions: list }, "definitions");
  const setImages = (list: CardImage[]) => update(card.id, { images: list });

  /** A definition row being edited: typed into, then closed with Done (an empty row is dropped). */
  function finishEditing(i: number) {
    const d = definitions[i];
    if (d && !d.term.trim() && !d.definition.trim()) setDefinitions(definitions.filter((_, j) => j !== i));
    setEditingDef(null);
  }

  // Pictures: the card's own slide always has a tile (ticked or not), then everything else.
  const ownListed = card.slide !== undefined && card.images.some((i) => i.slide === card.slide);
  const tiles: CardImage[] =
    isLecture && card.slide !== undefined && !ownListed
      ? [{ id: "own-slide", slide: card.slide, front: false, auto: true, off: true }, ...card.images]
      : card.images;
  function changeTile(img: CardImage, patch: Partial<CardImage>) {
    if (img.id === "own-slide") return setImages([...card.images, { ...ownSlide(img.slide!), off: false, ...patch } as CardImage]);
    setImages(card.images.map((x) => (x.id === img.id ? ({ ...x, ...patch } as CardImage) : x)));
  }
  const pictureSrc = (img: CardImage) =>
    img.file !== undefined ? backend.imageUrl(jobId, img.file) : backend.slideUrl(jobId, img.slide);
  const frontPictures = card.images.filter((i) => i.front && !i.off);

  async function takePictures(files: File[]) {
    const pictures = files.filter((f) => f.type.startsWith("image/"));
    if (!pictures.length) return;
    setNote("");
    setAddingPicture(true);
    try {
      for (const f of pictures) await addPicture(card.id, await pictureFromFile(f));
    } catch (e) {
      setNote(`Couldn't add that picture: ${(e as Error).message}`);
    }
    setAddingPicture(false);
  }

  // Ctrl+V of a copied picture, or a picture file dropped anywhere on the card. Pasting text is left alone.
  function onPaste(e: React.ClipboardEvent) {
    if (!canAddImages) return;
    const files = Array.from(e.clipboardData.files);
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void takePictures(files);
    }
  }
  function onDragOver(e: React.DragEvent) {
    if (canAddImages && e.dataTransfer.types.includes("Files")) e.preventDefault();
  }
  function onDrop(e: React.DragEvent) {
    if (!canAddImages) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      e.preventDefault();
      void takePictures(files);
    } else if (e.dataTransfer.types.includes("text/uri-list")) {
      e.preventDefault();
      setNote("Pictures dragged from a web page can't be added. Right-click it → Copy image, then click the card and press Ctrl+V.");
    }
  }

  return (
    <article
      className={`card ${card.include ? "" : "excluded"}`}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="card-head">
        <label className="inline strong">
          <input type="checkbox" checked={card.include} onChange={(e) => update(card.id, { include: e.target.checked })} />{" "}
          Include
        </label>
        <span className="muted">
          {count(blankCount, "blank")} · {count(reviewCount, "review")}
        </span>
        {card.maybe && <span className="badge maybe">maybe · over the target</span>}
        {card.duplicateOf && (
          <span className="badge dup" title={card.duplicateOf}>
            already have this?
          </span>
        )}
        {card.fromKnowledge && <span className="badge knowledge">from the AI&apos;s knowledge: check it</span>}
        {card.imageCard?.answerShows && (
          <span className="badge warn" title="Words in the picture may give the answer away. Crop it, or untick the card.">
            answer may show in the picture: check it
          </span>
        )}
        {card.source && !card.fromKnowledge && <span className="badge source">{card.source}</span>}
        {card.warnings.map((w) => (
          <span key={w} className="badge warn">
            {w}
          </span>
        ))}
        <button
          className={`small-button push ${combining ? "on" : ""}`}
          aria-pressed={combining}
          title="Pick two or more cards on the same topic, then press Combine at the top"
          onClick={() => toggleCombine(card.id)}
        >
          {combining ? "Combining ✓" : "Combine…"}
        </button>
        <button className="small-button danger" onClick={() => remove(card.id)}>
          Delete
        </button>
      </div>

      <div className="card-sides">
        <div className="side front">
          <div className="side-label">Front</div>
          <div className="front-area" ref={frontArea}>
            {tool && (
              <div
                ref={toolbar}
                role="toolbar"
                aria-label={tool.kind === "selection" ? "Selected text" : "Blank"}
                className="float-bar"
                style={{ left: tool.left, top: tool.top }}
              >
                {tool.kind === "selection" ? (
                  <>
                    <ToolButton className="strong" title="Hide the selected words as a new blank (its own card) · Ctrl+Shift+C" onPress={() => cloze("new")}>
                      […] Blank
                    </ToolButton>
                    <ToolButton title="Hide them together with the last blank (same card) · Ctrl+Shift+Alt+C" onPress={() => cloze("same")}>
                      Same number
                    </ToolButton>
                    <span className="sep" aria-hidden="true" />
                    <ToolButton title="Define the selected term for the back · Ctrl+Shift+D" onPress={defineSelection}>
                      Define
                    </ToolButton>
                  </>
                ) : (
                  <>
                    <span className="bar-label">Number</span>
                    {numbersOnCard.map((n) => (
                      <ToolButton
                        key={n}
                        className={n === clicked?.num ? "on" : undefined}
                        pressed={n === clicked?.num}
                        title={
                          n === clicked?.num
                            ? `This blank is number ${n}`
                            : `Hide it together with the number ${n} blanks (same review)`
                        }
                        onPress={() => renumber(n)}
                      >
                        {n}
                      </ToolButton>
                    ))}
                    <ToolButton
                      title={aloneInItsNumber ? "This blank already has a number of its own" : "Give it a new number (a review of its own)"}
                      disabled={aloneInItsNumber}
                      onPress={() => renumber(freeNumber)}
                    >
                      New
                    </ToolButton>
                    <span className="sep" aria-hidden="true" />
                    <ToolButton className="strong" title="Turn this blank back into plain text" onPress={removeBlank}>
                      Remove blank
                    </ToolButton>
                    <span className="sep" aria-hidden="true" />
                    <ToolButton title="Define this blank's answer for the back" onPress={defineBlank}>
                      Define
                    </ToolButton>
                  </>
                )}
              </div>
            )}
            {frontPictures.length > 0 && (
              <div className="front-pics">
                {frontPictures.map((img) => (
                  // eslint-disable-next-line @next/next/no-img-element -- local card picture
                  <img key={img.id} src={pictureSrc(img)} alt="" />
                ))}
              </div>
            )}
            <div ref={shown} className="front-text" onClick={onFrontClick} dangerouslySetInnerHTML={frontHtml} />
          </div>
          <p className="muted">Highlight words to blank or define them. Click a blank to change or remove it.</p>
          {card.duplicateOf && <p className="muted">Existing card: {card.duplicateOf}</p>}
          {note && <p className="note">{note}</p>}
          <details className="source">
            <summary>Edit cloze source</summary>
            <textarea
              ref={box}
              value={card.text}
              rows={3}
              aria-label="Cloze source"
              onKeyDown={onShortcut}
              onChange={(e) => update(card.id, { text: e.target.value }, "text")}
            />
          </details>
        </div>

        <div className="side back">
          <div className="side-label">Back</div>
          <label className="field">
            Extra
            <input
              placeholder="Optional line shown under the answer"
              value={card.why ?? ""}
              onChange={(e) => update(card.id, { why: e.target.value || undefined }, "why")}
            />
          </label>

          {(definitions.length > 0 || defining) && (
            <div className="back-group">
              <div className="group-label">Definitions</div>
              {definitions.map((d, i) =>
                editingDef === i || !d.definition.trim() ? (
                  <div className="def editing" key={i}>
                    <input
                      className="term"
                      aria-label="Term"
                      value={d.term}
                      placeholder="Term"
                      autoFocus={!d.term}
                      onChange={(e) => setDefinitions(definitions.map((x, j) => (j === i ? { ...x, term: e.target.value } : x)))}
                    />
                    <input
                      aria-label={`Definition of ${d.term || "the term"}`}
                      value={d.definition}
                      placeholder="Definition (≤15 words)"
                      autoFocus={!!d.term}
                      onChange={(e) =>
                        setDefinitions(definitions.map((x, j) => (j === i ? { ...x, definition: e.target.value } : x)))
                      }
                      onKeyDown={(e) => e.key === "Enter" && finishEditing(i)}
                    />
                    <button className="small-button" onClick={() => finishEditing(i)}>
                      Done
                    </button>
                  </div>
                ) : (
                  <div className="def" key={i}>
                    <p>
                      <b>{d.term}</b>: {d.definition}
                    </p>
                    <button className="icon" aria-label={`Edit definition of ${d.term}`} onClick={() => setEditingDef(i)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                    <button
                      className="icon danger"
                      aria-label={`Remove definition of ${d.term}`}
                      onClick={() => setDefinitions(definitions.filter((_, j) => j !== i))}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>
                ),
              )}
              {defining && <p className="muted">Defining &ldquo;{defining}&rdquo;…</p>}
            </div>
          )}

          {(tiles.length > 0 || canAddImages) && (
            <div className="back-group">
              <div className="group-label">Pictures</div>
              <div className="pics">
                {tiles.map((img) => (
                  <figure key={img.id} className={`pic ${img.off ? "off" : ""}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- local card picture */}
                    <img src={pictureSrc(img)} alt={img.slide !== undefined ? `Slide ${img.slide + 1}` : "Card picture"} />
                    <figcaption>
                      <label className="inline">
                        <input type="checkbox" checked={!img.off} onChange={(e) => changeTile(img, { off: !e.target.checked })} />{" "}
                        {img.front ? "On front" : "On back"}
                      </label>
                      <button
                        className="link"
                        aria-label={img.front ? "Show on the back instead" : "Show on the front instead"}
                        onClick={() => changeTile(img, { front: !img.front })}
                      >
                        {img.front ? "Move to back" : "Move to front"}
                      </button>
                    </figcaption>
                  </figure>
                ))}
                {canAddImages && isLecture && (
                  <button className="add-pic" onClick={openPicker} disabled={addingPicture}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                    {addingPicture ? "Adding picture…" : "Crop slide"}
                    <span>or paste / drop a picture</span>
                  </button>
                )}
                {canAddImages && !isLecture && (
                  <p className="add-pic hint">{addingPicture ? "Adding picture…" : "Paste or drop a picture on this card"}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * "Crop slide": pick a slide (the card's own first), then drag a box over the part
 * you want, or take the whole slide.
 */
function ImagePicker({
  jobId,
  slideCount,
  start,
  onWhole,
  onCrop,
  onClose,
}: {
  jobId: string;
  slideCount: number;
  start: number;
  onWhole: (slide: number) => void;
  onCrop: (picture: Blob) => Promise<void>;
  onClose: () => void;
}) {
  const [slide, setSlide] = useState(start);
  /** The dragged box, as fractions (0–1) of the slide picture. */
  const [area, setArea] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (n: number) => {
    setSlide(Math.min(Math.max(n, 0), slideCount - 1));
    setArea(null);
  };

  const at = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragFrom.current = at(e);
    setArea(null);
  }
  function onPointerMove(e: React.PointerEvent) {
    const from = dragFrom.current;
    if (!from) return;
    const to = at(e);
    setArea({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) });
  }
  const onPointerUp = () => {
    dragFrom.current = null;
  };

  // A click without a real drag leaves a tiny box: not worth a picture.
  const usable = !!area && area.w > 0.02 && area.h > 0.02;

  async function addCrop() {
    if (!usable || !img.current) return;
    setSaving(true);
    setProblem("");
    try {
      await onCrop(await cropSlide(img.current, area!));
    } catch (e) {
      setProblem((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-top">
          <button className="link" disabled={slide === 0} onClick={() => go(slide - 1)}>
            ‹ Previous
          </button>
          <select value={slide} onChange={(e) => go(Number(e.target.value))}>
            {Array.from({ length: slideCount }, (_, i) => (
              <option key={i} value={i}>
                Slide {i + 1}
                {i === start ? " (this card's)" : ""}
              </option>
            ))}
          </select>
          <button className="link" disabled={slide === slideCount - 1} onClick={() => go(slide + 1)}>
            Next ›
          </button>
          <span className="muted">Drag a box over the part you want.</span>
          <button className="link push" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="crop" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local slide render, drawn onto a canvas when cropped */}
          <img ref={img} src={backend.slideUrl(jobId, slide)} alt={`Slide ${slide + 1}`} draggable={false} />
          {area && (
            <div
              className="crop-box"
              style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.w * 100}%`, height: `${area.h * 100}%` }}
            />
          )}
        </div>
        <div className="picker-bottom">
          {problem && <span className="note">{problem}</span>}
          <button className="tool" disabled={saving} onClick={() => onWhole(slide)}>
            Add whole slide
          </button>
          <button className="primary" disabled={!usable || saving} onClick={addCrop}>
            {saving ? "Adding…" : "Add selected area"}
          </button>
        </div>
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");

/** "1 blank", "2 reviews". */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** onMouseDown + preventDefault keeps the selected words selected when the button is clicked. */
function ToolButton({
  title,
  onPress,
  className,
  pressed,
  disabled,
  children,
}: {
  title: string;
  onPress: () => void;
  className?: string;
  /** For a choice among several (a blank's number): this one is the current choice. */
  pressed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={className}
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onPress();
      }}
    >
      {children}
    </button>
  );
}
