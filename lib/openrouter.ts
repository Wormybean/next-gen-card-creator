// One streamed request to a model on OpenRouter (https://openrouter.ai), shaped like the Gemini
// request in lib/generate.ts so either can write the cards. Models are named "openrouter:<id>",
// e.g. "openrouter:anthropic/claude-haiku-5.5". Also what is left of the user's credit.

import type { Part } from "@google/genai";

export const OPENROUTER_PREFIX = "openrouter:";
export const isOpenRouter = (model: string) => model.startsWith(OPENROUTER_PREFIX);

/** An error answer from OpenRouter, with its HTTP status (429 busy or limit reached, 5xx down…). */
export class OpenRouterError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The free models' daily cap (50 requests, or 1000 once the account has bought credits). */
export const isDailyLimit = (e: OpenRouterError) => e.status === 429 && /per-day|per day|daily/i.test(e.message);

/** `cost` is what OpenRouter charged for the request, in US dollars. */
type Answer = { text: string; inputTokens: number; outputTokens: number; cutOff: boolean; cost: number };

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** Gemini's request parts as OpenRouter (OpenAI-style) message content: text, and pictures as data URLs. */
const content = (parts: Part[]): ContentPart[] =>
  parts.flatMap((p): ContentPart[] =>
    p.text !== undefined
      ? [{ type: "text", text: p.text }]
      : p.inlineData
        ? [{ type: "image_url", image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }]
        : [],
  );

/**
 * Sends the request and streams the answer. Not every model can be held to a JSON schema, so the
 * schema also goes in the system prompt and the answer is only asked to be a JSON object.
 */
export async function openRouterRequest({
  apiKey,
  model,
  system,
  parts,
  schema,
  thinking,
  onThought,
  onText,
}: {
  apiKey: string;
  model: string;
  system: string;
  parts: Part[];
  schema: unknown;
  /** "none" | "minimal" | "low" | "medium" | "high". */
  thinking: string;
  onThought?: (text: string) => void;
  onText?: (soFar: string) => void;
}): Promise<Answer> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // App attribution on OpenRouter's side; optional.
      "HTTP-Referer": "https://github.com/Wormybean/next-gen-card-creator",
      "X-Title": "Next-gen Card Creator",
    },
    body: JSON.stringify({
      model: model.slice(OPENROUTER_PREFIX.length),
      stream: true,
      messages: [
        {
          role: "system",
          content: `${system}\n\nAnswer with one JSON object, and nothing else, matching this JSON Schema:\n${JSON.stringify(schema)}`,
        },
        { role: "user", content: content(parts) },
      ],
      response_format: { type: "json_object" },
      reasoning: { effort: thinking },
      usage: { include: true },
    }),
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    let message = body;
    try {
      // "Provider returned error" says little; the provider's own words are in metadata.raw.
      const error = JSON.parse(body).error;
      message = error?.metadata?.raw ?? error?.message ?? body;
    } catch {
      // Not JSON: keep the text.
    }
    throw new OpenRouterError(response.status, message || response.statusText);
  }

  // Server-sent events: "data: {json}" lines, ": comment" keep-alives, and "data: [DONE]" at the end.
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cutOff = false;
  let cost = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const chunk = JSON.parse(line.slice(6));
      // An error after the answer started arrives as a chunk.
      if (chunk.error) throw new OpenRouterError(Number(chunk.error.code) || 500, chunk.error.message ?? "OpenRouter error");
      const choice = chunk.choices?.[0];
      if (choice?.delta?.reasoning) onThought?.(choice.delta.reasoning);
      if (choice?.delta?.content) {
        text += choice.delta.content;
        onText?.(text);
      }
      if (choice?.finish_reason === "length") cutOff = true;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
        cost = chunk.usage.cost ?? 0;
      }
    }
  }
  return { text, inputTokens, outputTokens, cutOff, cost };
}

/** What is left to spend: the account's credit, and the key's own limit if it has one (US dollars). */
export type Credit = { left: number; keyLeft?: number; keyLimit?: number; keyResets?: string };

/** Asked from the page, which holds the key (OpenRouter allows this from any page). */
export async function openRouterCredit(apiKey: string): Promise<Credit> {
  const get = async (path: string) => {
    const res = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new OpenRouterError(res.status, body.error?.message ?? res.statusText);
    return body.data;
  };
  const [credits, key] = await Promise.all([get("credits"), get("key")]);
  return {
    left: credits.total_credits - credits.total_usage,
    ...(key.limit != null && { keyLeft: key.limit_remaining, keyLimit: key.limit, keyResets: key.limit_reset ?? undefined }),
  };
}

/** The JSON object in an answer, without the ```json fence or chatter some models add around it. */
export function jsonIn(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
