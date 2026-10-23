// Turns a failed AI request into an error message the page can show as is.

import { ApiError } from "@google/genai";
import { DailyQuotaError, MissingKeyError } from "./generate";
import { OpenRouterError } from "./openrouter";

const KEYS_PAGE = "openrouter.ai/settings/keys";
const CREDITS_PAGE = "openrouter.ai/settings/credits";

const NO_KEY = process.env.VERCEL
  ? 'Your OpenRouter key is missing. Open "Your OpenRouter key" at the top of the page and paste it in.'
  : process.env.NGCC_ADDON
    ? 'Your OpenRouter key is missing. Open "Your OpenRouter key" at the top of the window and paste it in.'
    : 'No AI key. Put OPENROUTER_API_KEY=... in the .env.local file in the app\'s folder, then restart the app, or paste a key into "Your OpenRouter key" at the top of the page.';

function openRouterMessage(e: OpenRouterError): string {
  if (e.status === 401) return `OpenRouter didn't accept your key. Check it in "Your OpenRouter key", or make a new one at ${KEYS_PAGE}.`;
  if (e.status === 402) return `Your OpenRouter credit has run out. Add credit at ${CREDITS_PAGE}, then try again.`;
  // A key's own spending limit (and OpenRouter's other blocks) answer 403.
  if (e.status === 403)
    return /limit|budget/i.test(e.message)
      ? `Your OpenRouter key has reached its spending limit. It resets at the start of the next period, or you can raise it at ${KEYS_PAGE}.`
      : `OpenRouter turned this request away: ${e.message}`;
  if (e.status === 429) return "OpenRouter is busy right now. Wait a minute and try again.";
  return `OpenRouter error ${e.status}: ${e.message}`;
}

export function aiError(e: unknown): { error: string; status: number } {
  if (e instanceof MissingKeyError) return { error: NO_KEY, status: 500 };
  if (e instanceof DailyQuotaError) return { error: e.message, status: 429 };
  if (e instanceof OpenRouterError) return { error: openRouterMessage(e), status: e.status === 429 ? 429 : 500 };
  // Gemini asked directly, with a key set up by hand.
  if (e instanceof ApiError) {
    if (e.status === 429) return { error: "Gemini rate limit reached. Wait a minute and try again.", status: 429 };
    if (e.status === 401 || e.status === 403 || /API key/i.test(e.message))
      return { error: "Your Gemini key is missing or wasn't accepted. Check it in the add-on's config.", status: 500 };
    return { error: `Gemini error ${e.status}: ${e.message}`, status: 500 };
  }
  return { error: (e as Error).message, status: 500 };
}

export function aiErrorResponse(e: unknown): Response {
  const { error, status } = aiError(e);
  return Response.json({ error }, { status });
}
