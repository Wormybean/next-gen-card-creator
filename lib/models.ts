// Which models to try, in order: when one is busy the next is tried. Cards are written through
// OpenRouter with the user's own key. Gemini is asked directly only when a Gemini key was set up
// by hand instead (the add-on's config, or GEMINI_API_KEY on your own computer). On a server,
// OPENROUTER_MODEL and GEMINI_MODEL / GEMINI_DEFINE_MODEL override these (lib/config.ts).

/** Claude Haiku 5.5 covered the most of a lecture's must-know facts in the blind tests (2026-10-23). */
export const OPENROUTER_CARD_MODELS = ["openrouter:anthropic/claude-haiku-5.5", "openrouter:google/gemini-3.6-flash"];

/** Term definitions go to the card models, asked to answer without thinking (about 2 s). */
export const OPENROUTER_DEFINE_MODELS: string[] = [];

export const GEMINI_CARD_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
];

/** Small and fast models for term definitions (about 1.5 s, against 5 s or more for the card models). */
export const GEMINI_DEFINE_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

/** The define models, then the card models in case those are busy or used up. */
export const withFallback = (define: string[], cards: string[]) => [...new Set([...define, ...cards])];

/** Which service writes the cards: OpenRouter, or Gemini directly. */
export type Service = "openrouter" | "gemini";
