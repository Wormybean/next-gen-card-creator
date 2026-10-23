// Asks the AI for draft cards: lecture slides in batches, or a question set in one go. Cards are
// written through OpenRouter with the user's own key, or by Gemini directly when only a Gemini
// key was set up (lib/models.ts).

import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, GoogleGenAI, MediaResolution, ThinkingLevel, type GenerateContentResponse, type Part } from "@google/genai";
import { z } from "zod";
import { toBase64 } from "./base64";
import { collection } from "./collection";
import { config } from "./config";
import { ownSlide } from "./extras";
import type { CardSettings, Thinking } from "./lecture-run";
import type { Service } from "./models";
import type { Reading } from "./readings";
import { OpenRouterError, isDailyLimit, isOpenRouter, jsonIn, openRouterRequest } from "./openrouter";
import { RULEBOOK, checkCard, styleExamplesBlock, targetGuidance, type DraftCard, type LectureType } from "./rules";

const PRIORITY = z.enum(["must-know", "important", "nice-to-know"]);
const toPriority = (p: z.infer<typeof PRIORITY>) => ({ "must-know": 1, important: 2, "nice-to-know": 3 })[p] as 1 | 2 | 3;

const LectureCards = z.object({
  keyPoints: z.array(z.string()).describe("3 to 5 key points of what these slides teach, each 20 words or fewer, plain sentences with no blanks; empty if the slides hold no teaching"),
  cards: z.array(
    z.object({
      slide: z.number().int().describe("The slide number shown above the slide"),
      text: z.string().describe("The cloze text"),
      why: z.string().describe("Optional ≤15-word 'why' line for the back; empty string if not needed"),
      priority: PRIORITY,
    }),
  ),
  imageCards: z
    .array(
      z.object({
        slide: z.number().int().describe("The slide number shown above the slide"),
        condition: z.string().describe("The condition shown, as the lecture names it; this is the answer"),
        hint: z.string().describe('Organ and kind of picture, e.g. "pancreas, histology" or "kidney, CT"; never the answer'),
        features: z.string().describe("≤15 words: what in the picture gives the condition away"),
        headline: z
          .boolean()
          .describe("True if the condition heads a case or section of the lecture; false for a differential or side topic"),
        box: z
          .array(z.number().int())
          .min(4)
          .max(4)
          .describe("[ymin, xmin, ymax, xmax] on the slide picture, 0–1000, tightly around the medical image only"),
        answerShows: z
          .boolean()
          .describe("True if words naming or strongly hinting at the condition are still visible inside the box"),
      }),
    )
    .describe("Image cards, one per main condition that has a picture; empty if none"),
});

/** A picture of a main condition the AI picked for an image card (made into a card in lib/image-cards.ts). */
export type ImageCardIdea = {
  /** 0-based. */
  slide: number;
  condition: string;
  hint: string;
  features: string;
  /** The condition heads a case or section (kept first when a lecture has more image cards than allowed). */
  headline: boolean;
  /** Words giving the answer away are printed inside the picture and couldn't be boxed out. */
  answerShows: boolean;
  /** Where the medical image is on the slide, as fractions of it: [left, top, right, bottom]. */
  box: [number, number, number, number];
};

const IMAGE_CARDS = `IMAGE CARDS (separate from the cards above, and on top of the card target):
Some slides show a picture of a condition: histology, gross pathology, radiology (CT, MRI, X-ray, ultrasound), endoscopy or a clinical photo. The student must learn to recognise the MAIN conditions of this lecture by sight.
- Only a MAIN condition: one named in the lecture's title, a case or section heading or the learning objectives, or that recurs across several slides. Never one shown once in passing, never normal anatomy, and never diagrams, illustrations, charts, tables or cartoons.
- Only when the lecture names what the picture shows: in a caption, label or title on the slide, or in the heading of the case or section the slide belongs to.
- At most one image card per condition: pick its most classic, clearest picture. Give every main condition that has such a picture its card; a lecture without any gets none.
- "box" goes tightly around the medical image itself, leaving out the slide title, captions, labels, arrows' text and any words that would give the answer away. If the picture has the answer printed inside it, choose a box that leaves those words out; if that isn't possible, set answerShows to true.`;

const CsblCards = z.object({
  keyPoints: z.array(z.string()).describe("5 to 8 key take-home points from the questions and the readings, each 20 words or fewer, plain sentences with no blanks"),
  cards: z.array(
    z.object({
      question: z.string().describe("The question this card answers, as written in the question set"),
      text: z.string().describe("The cloze text"),
      priority: PRIORITY,
      source: z.string().describe("Title of the reading the answer came from, or \"own knowledge\""),
      fromReading: z.boolean().describe("True if the answer was taken from one of the readings provided"),
    }),
  ),
});

/** One request to a model: answered, or turned away because its daily allowance is used up. */
export type ModelCall = { model: string; usedUp?: boolean };

/**
 * Tokens, what OpenRouter charged in US dollars (nothing is counted for Gemini asked directly),
 * and each request made (the speed tests check which model answered).
 */
export type Usage = { inputTokens: number; outputTokens: number; cost?: number; calls?: ModelCall[] };

/**
 * What a card request is doing, so the page can show it's alive: the answer streams in, and a
 * long first stretch is the AI reading and thinking with nothing to show yet.
 */
export type Progress =
  /** CSBL: opening the pre-reading links. */
  | { stage: "readings"; done: number; total: number }
  /** Sent; the AI is reading and planning. */
  | { stage: "waiting" }
  /** Still planning: the heading of the AI's latest thought summary (free; thinking is billed in full anyway). */
  | { stage: "thinking"; note: string }
  /** The answer is arriving: cards so far, and the (1-based) slide of the latest one. */
  | { stage: "writing"; cards: number; slide?: number }
  /** Every model is busy; the next try is in `seconds`. */
  | { stage: "retrying"; seconds: number }
  /** Second pass on cards that broke a rule. */
  | { stage: "checking"; cards: number };

export type OnProgress = (p: Progress) => void;

export type SlideInput = { index: number; text: string; png: Uint8Array };

export class MissingKeyError extends Error {}

/** The user's OpenRouter key, and a Gemini key set up by hand (hidden: the add-on's config only). */
export type ApiKeys = { openRouter?: string | null; gemini?: string | null };

/**
 * The keys for the request being served. Online they are the visitor's own (sent from their
 * browser); OPENROUTER_API_KEY and GEMINI_API_KEY are used only on your own computer, never on
 * Vercel, so nobody can spend a key that isn't theirs.
 */
const keyContext = new AsyncLocalStorage<ApiKeys>();
export const withApiKeys = <T>(keys: ApiKeys, fn: () => Promise<T>): Promise<T> => keyContext.run(keys, fn);
function currentKeys(): { openRouter?: string; gemini?: string } {
  const given = keyContext.getStore() ?? {};
  const own = process.env.VERCEL ? {} : { openRouter: process.env.OPENROUTER_API_KEY, gemini: process.env.GEMINI_API_KEY };
  return { openRouter: given.openRouter || own.openRouter || undefined, gemini: given.gemini || own.gemini || undefined };
}

/** OpenRouter whenever there is a key for it; Gemini directly only without one. */
const serviceFor = (keys: { openRouter?: string; gemini?: string }): Service | undefined =>
  keys.openRouter ? "openrouter" : keys.gemini ? "gemini" : undefined;

export class DailyQuotaError extends Error {
  constructor() {
    super(
      "Today's free Gemini allowance is used up on every model (about 20 requests a day each). It resets overnight, or turn on billing for your key in Google AI Studio to remove the limit.",
    );
  }
}

function jsonSchema(schema: z.ZodType): unknown {
  const out = z.toJSONSchema(schema) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** Models that used up their daily free allowance, per key, and on which (Pacific-time) day. */
const exhausted = new Map<string, string>();
const today = () => new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
/** A short fingerprint of the key, so the key itself isn't kept in this list. */
const fingerprint = (apiKey: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i++) h = Math.imul(h ^ apiKey.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
};
const slot = (apiKey: string, model: string) => `${fingerprint(apiKey)}:${model}`;
const outOfAllowance = (apiKey: string, model: string) => exhausted.get(slot(apiKey, model)) === today();

/** Models answered 404 for (retired, or not offered to this key). */
const retired = new Set<string>();

/** "off": answer straight away. Gemini 3 can't stop thinking altogether, so it thinks minimally. */
type ThinkingSetting = Thinking | "off";

const THINKING_LEVEL: Record<ThinkingSetting, ThinkingLevel> = {
  off: ThinkingLevel.MINIMAL,
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

const PICTURE_DETAIL: Record<CardSettings["pictures"], MediaResolution | undefined> = {
  default: undefined,
  medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  low: MediaResolution.MEDIA_RESOLUTION_LOW,
};

/** An answer from either service, streamed in full. `cost` is OpenRouter's charge in US dollars. */
type Answer = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cutOff: boolean;
  cost?: number;
  blockReason?: string;
  finish?: string;
};

/**
 * One request; the answer is JSON matching `schema`. Card requests get the rulebook and
 * style examples as the system prompt; small requests can pass their own and think less.
 * The answer is streamed so `onProgress` can count the cards as they arrive. Models named
 * "openrouter:…" are asked through OpenRouter (lib/openrouter.ts), the rest through Gemini.
 */
async function run<T>(
  schema: z.ZodType<T>,
  parts: Part[],
  {
    system,
    thinking = "high",
    pictures,
    define = false,
    onProgress,
  }: {
    system?: string;
    thinking?: ThinkingSetting;
    /** How much detail Gemini takes from pictures; unset leaves it to Gemini. OpenRouter ignores it. */
    pictures?: MediaResolution;
    /** A term definition: the small, quick models first. */
    define?: boolean;
    onProgress?: OnProgress;
  } = {},
): Promise<{ output: T; usage: Usage }> {
  const keys = currentKeys();
  const service = serviceFor(keys);
  if (!service) throw new MissingKeyError();
  const modelList = define ? config.defineModels(service) : config.models(service);
  const keyFor = (model: string) => (isOpenRouter(model) ? keys.openRouter : keys.gemini);
  if (!modelList.some(keyFor)) throw new MissingKeyError();
  const systemInstruction = system ?? `${RULEBOOK}\n\n${styleExamplesBlock(collection.styleExamples())}`;

  // Summaries usually open with a bold heading ("**Planning the cards**"). Notes about its own
  // mechanics ("Refining the JSON Schema") mean nothing to the user.
  const reportThought = (thought: string) => {
    const note = (/\*\*(.+?)\*\*/.exec(thought)?.[1] ?? thought.trim().split("\n")[0]).replace(/\*/g, "").trim();
    if (note.length > 3 && !/json|schema|output|format|field/i.test(note)) onProgress?.({ stage: "thinking", note: note.slice(0, 90) });
  };
  let reported = "";
  const reportText = (text: string) => {
    if (!onProgress) return;
    // Every card has a "text" field; lecture cards also name their slide.
    const cards = text.match(/"text"\s*:/g)?.length ?? 0;
    const slide = [...text.matchAll(/"slide"\s*:\s*(\d+)/g)].pop()?.[1];
    const now = `${cards}:${slide}`;
    if (now !== reported) {
      reported = now;
      onProgress({ stage: "writing", cards, slide: slide ? Number(slide) : undefined });
    }
  };

  const askGemini = async (model: string): Promise<Answer> => {
    const ai = new GoogleGenAI({ apiKey: keys.gemini! });
    const stream = await ai.models.generateContentStream({
      model,
      contents: [{ role: "user", parts }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema(schema),
        thinkingConfig: { thinkingLevel: THINKING_LEVEL[thinking], includeThoughts: !!onProgress },
        ...(pictures && { mediaResolution: pictures }),
      },
    });
    let text = "";
    let last: GenerateContentResponse | undefined;
    let blockReason: string | undefined;
    for await (const chunk of stream) {
      last = chunk;
      blockReason ??= chunk.promptFeedback?.blockReason;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (part.thought && part.text) reportThought(part.text);
      const piece = chunk.text;
      if (!piece) continue;
      text += piece;
      reportText(text);
    }
    // The last piece of a streamed answer carries the totals and why it stopped.
    const meta = last?.usageMetadata;
    const finish = last?.candidates?.[0]?.finishReason;
    return {
      text,
      inputTokens: meta?.promptTokenCount ?? 0,
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      cutOff: finish === "MAX_TOKENS",
      blockReason,
      finish,
    };
  };

  const askOpenRouter = (model: string): Promise<Answer> => {
    // Its reasoning streams in small pieces; report the latest heading once it is complete.
    let reasoning = "";
    let lastHeading = "";
    return openRouterRequest({
      apiKey: keyFor(model)!,
      model,
      system: systemInstruction,
      parts,
      schema: jsonSchema(schema),
      thinking: thinking === "off" ? "none" : thinking,
      onThought: (piece) => {
        reasoning += piece;
        const heading = [...reasoning.matchAll(/\*\*(.+?)\*\*/g)].pop()?.[0];
        if (heading && heading !== lastHeading) reportThought((lastHeading = heading));
      },
      onText: reportText,
    });
  };

  // Models are often busy for a while (503 "high demand", or 429). Gemini's free tier also gives
  // each model its own daily allowance. So: try each model in turn, skip ones out of allowance
  // for today, and if every model is busy, wait and go round again.
  const waits = [10_000, 30_000, 60_000];
  let response: Answer | undefined;
  let answeredBy = "";
  let lastError: unknown;
  const calls: ModelCall[] = [];
  for (let round = 0; !response; round++) {
    const models = modelList.filter((m) => keyFor(m) && !outOfAllowance(keyFor(m)!, m) && !retired.has(m));
    if (!models.length) throw new DailyQuotaError();
    for (const model of models) {
      try {
        onProgress?.({ stage: "waiting" });
        response = await (isOpenRouter(model) ? askOpenRouter(model) : askGemini(model));
        answeredBy = model;
        calls.push({ model });
        break;
      } catch (e) {
        if (!(e instanceof ApiError || e instanceof OpenRouterError)) throw e;
        const usedUp = e instanceof OpenRouterError ? isDailyLimit(e) : e.status === 429 && /PerDay/.test(e.message);
        if (usedUp) {
          exhausted.set(slot(keyFor(model)!, model), today());
          calls.push({ model, usedUp: true });
          continue;
        }
        // Models get retired ("no longer available"): skip it from now on rather than fail.
        if (e.status === 404 && models.length > 1) {
          retired.add(model);
          continue;
        }
        if (![408, 429, 500, 502, 503].includes(e.status)) throw e;
        lastError = e;
      }
    }
    if (response) break;
    if (round >= waits.length) throw lastError;
    onProgress?.({ stage: "retrying", seconds: waits[round] / 1000 });
    await new Promise((r) => setTimeout(r, waits[round]));
  }

  const who = isOpenRouter(answeredBy) ? "The AI" : "Gemini";
  const usage: Usage = { inputTokens: response.inputTokens, outputTokens: response.outputTokens, cost: response.cost ?? 0, calls };
  if (response.cutOff) throw new Error(`${who}'s answer was cut off (too long). Try again.`);
  if (!response.text) {
    const blocked = response.blockReason;
    throw new Error(blocked ? `${who} declined this request (${blocked})` : `${who} returned nothing (${response.finish ?? "no reason given"})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonIn(response.text));
  } catch {
    throw new Error(`${who}'s answer couldn't be read as cards. Try again.`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${who}'s answer couldn't be read as cards. Try again.`);
  return { output: parsed.data, usage };
}

function finish(card: Omit<DraftCard, "id" | "warnings">): DraftCard {
  return { ...card, id: crypto.randomUUID(), warnings: checkCard(card.text) };
}

const Rewrites = z.object({
  rewrites: z.array(
    z.object({
      number: z.number().int().describe("The card's number in the list"),
      texts: z.array(z.string()).describe("The rewritten card, or two cards if it truly holds two separate ideas"),
    }),
  ),
});

/** Warnings the model can fix by rewriting (everything except "no blanks", which it never produces). */
const fixable = (c: DraftCard) => c.warnings.length > 0 && !c.warnings[0].startsWith("No blanks");

/** The tidy pass: sends back only the cards that break a measurable rule, to be rewritten. */
async function repair(
  cards: DraftCard[],
  thinking: CardSettings["tidyPass"],
  onProgress?: OnProgress,
): Promise<{ cards: DraftCard[]; usage: Usage }> {
  const broken = cards.filter(fixable);
  if (!broken.length || thinking === "off") return { cards, usage: { inputTokens: 0, outputTokens: 0 } };
  onProgress?.({ stage: "checking", cards: broken.length });
  const list = broken.map((c, i) => `${i + 1}. ${c.text}\n   Problems: ${c.warnings.join("; ")}`).join("\n");
  const { output, usage } = await run(Rewrites, [
    {
      text: `These draft cards break the rulebook. Rewrite each one so it passes: 20 words or fewer, no more than 3 items hidden behind one cloze number, no more than 3 cloze numbers, subject named in bold. Cut detail rather than splitting; split into two cards only when the card really holds two separate high-yield ideas. Keep the facts exactly as they are.

${list}`,
    },
  ], { thinking });
  const byCard = new Map<DraftCard, string[]>();
  for (const r of output.rewrites) {
    const card = broken[r.number - 1];
    const texts = r.texts.map((t) => t.trim()).filter((t) => /\{\{c\d+::/.test(t));
    if (card && texts.length) byCard.set(card, texts);
  }
  const fixed = cards.flatMap((c) => {
    const texts = byCard.get(c);
    if (!texts) return [c];
    return texts.map((text, i) => ({ ...c, id: i === 0 ? c.id : crypto.randomUUID(), text, warnings: checkCard(text) }));
  });
  return { cards: fixed, usage };
}

const clean = (points: string[]) => points.map((p) => p.trim()).filter(Boolean);

const sum = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cost: (a.cost ?? 0) + (b.cost ?? 0),
  calls: [...(a.calls ?? []), ...(b.calls ?? [])],
});

/** Cards for a batch of slides. `allSlidesText` gives the model the whole lecture for context. */
export async function generateLectureCards(
  type: LectureType,
  lectureName: string,
  allSlidesText: string,
  batch: SlideInput[],
  settings: CardSettings,
  onProgress?: OnProgress,
): Promise<{ cards: DraftCard[]; usage: Usage; keyPoints: string[]; imageCards: ImageCardIdea[] }> {
  const parts: Part[] = [
    {
      text:
        settings.context === "all"
          ? `Lecture: ${lectureName}\n\nThe text of EVERY slide, for context (learning objectives, what gets repeated):\n\n${allSlidesText}`
          : `Lecture: ${lectureName}`,
    },
  ];
  for (const slide of batch) {
    parts.push({ text: `Slide ${slide.index + 1}:` });
    parts.push({ inlineData: { mimeType: "image/png", data: toBase64(slide.png) } });
  }
  const numbers = batch.map((s) => s.index + 1);
  parts.push({
    text: `${targetGuidance(type)}

Write cards ONLY for slides ${numbers.join(", ")} (shown above as pictures). Put the slide number in each card's "slide" field. Return an empty list if none of these slides have anything worth a card.

${IMAGE_CARDS}`,
  });

  const { output, usage } = await run(LectureCards, parts, {
    thinking: settings.thinking,
    pictures: PICTURE_DETAIL[settings.pictures],
    onProgress,
  });
  const valid = new Set(numbers);
  const cards = output.cards
    .filter((c) => valid.has(c.slide))
    .map((c) =>
      finish({
        slide: c.slide - 1,
        text: c.text.trim(),
        why: c.why.trim() || undefined,
        images: [ownSlide(c.slide - 1)],
        priority: toPriority(c.priority),
      }),
    );
  const fraction = (v: number) => Math.min(Math.max(v / 1000, 0), 1);
  const imageCards: ImageCardIdea[] = output.imageCards
    .filter((c) => valid.has(c.slide) && c.condition.trim())
    .map(({ slide, condition, hint, features, headline, answerShows, box: [ymin, xmin, ymax, xmax] }) => ({
      slide: slide - 1,
      condition: condition.trim(),
      hint: hint.trim(),
      features: features.trim(),
      headline,
      answerShows,
      box: [fraction(xmin), fraction(ymin), fraction(xmax), fraction(ymax)],
    }));
  const repaired = await repair(cards, settings.tidyPass, onProgress);
  return { cards: repaired.cards, usage: sum(usage, repaired.usage), keyPoints: clean(output.keyPoints), imageCards };
}

/** Cards for a CSBL case: knowledge questions answered from the readings that opened. */
export async function generateCsblCards(
  sessionPlanText: string,
  readings: Reading[],
  /** Adding to cards already made: only cover what these readings answer. */
  supplement: boolean,
  settings: CardSettings,
  onProgress?: OnProgress,
): Promise<{ cards: DraftCard[]; usage: Usage; knowledgeQuestions: number; keyPoints: string[] }> {
  const opened = readings.filter((r) => r.ok);
  const readingBlocks = opened
    .map((r) => `<reading title="${r.title.replace(/"/g, "'")}" url="${r.url}">\n${r.text}\n</reading>`)
    .join("\n\n");

  const prompt = `Here is a question set (a case, tutorial or session plan):

<questions>
${sessionPlanText}
</questions>

Reading material that could be used (${opened.length} of ${readings.length}):
${readingBlocks || "(none could be used)"}

${targetGuidance("csbl")}

Steps:
1. Pick out the KNOWLEDGE questions only (e.g. "What is acanthosis nigricans?", "How does semaglutide work?", "What are the complications of bariatric surgery?"). Skip questions about one specific patient, communication/reflection questions, and health-systems/equity questions, except keep any clinically useful fact they contain (e.g. a surgery eligibility cut-off).
2. Answer each knowledge question from the readings above where they cover it, otherwise from your own best medical knowledge, following the guidelines the questions and readings use. What the questions themselves state wins over older knowledge.
3. Turn the answers into cards following the rulebook. Cards are general knowledge, never about the patient. Put the discussion question in "question". Put the reading's title in "source" and set fromReading true only when the answer really came from a reading; otherwise source "own knowledge" and fromReading false.${
    supplement
      ? "\n4. These readings were added AFTER a first set of cards was made from the other readings and your own knowledge. Write cards ONLY for facts these readings answer, in their own words and at the usual size. Skip every question they don't cover; return an empty list if none. Every card must have fromReading true."
      : ""
  }`;

  const { output, usage } = await run(CsblCards, [{ text: prompt }], { thinking: settings.thinking, onProgress });
  const cards = output.cards.map((c) =>
    finish({
      question: c.question.trim(),
      text: c.text.trim(),
      images: [],
      priority: toPriority(c.priority),
      source: c.fromReading ? c.source.trim() : undefined,
      fromKnowledge: !c.fromReading,
    }),
  );
  const repaired = await repair(cards, settings.tidyPass, onProgress);
  return {
    cards: repaired.cards,
    usage: sum(usage, repaired.usage),
    keyPoints: supplement ? [] : clean(output.keyPoints),
    knowledgeQuestions: new Set(cards.map((c) => c.question)).size,
  };
}

const TermDefinition = z.object({
  definition: z.string().describe("The definition: 15 words or fewer, one plain sentence, no blanks"),
});

const DEFINE_SYSTEM = `You define terms for a medical student making Anki flashcards.
- Define the term as it is used in the card and lecture you're given, not in general.
- 15 words or fewer: one plain sentence or phrase. Succinct beats complete.
- Don't repeat the term itself at the start ("Chondrocyte: a chondrocyte is…"); go straight to the meaning.
- Use the same spelling as the card (British or American). No HTML, no cloze blanks.`;

/** A short definition of a term the user highlighted, read in the context of its card and slide. */
export async function defineTerm(
  term: string,
  context: { card: string; lecture: string; slideText?: string; question?: string },
): Promise<{ definition: string; usage: Usage }> {
  const where = [
    `Lecture or case: ${context.lecture}`,
    context.question && `Discussion question: ${context.question}`,
    context.slideText && `Slide text:\n${context.slideText}`,
    `Card: ${context.card}`,
  ].filter(Boolean);
  const { output, usage } = await run(TermDefinition, [{ text: `${where.join("\n")}\n\nDefine: ${term}` }], {
    system: DEFINE_SYSTEM,
    thinking: "off",
    define: true,
  });
  return { definition: output.definition.trim(), usage };
}
