// Reading material for a question set: links in the questions are opened and their text pulled
// out, so the model answers from the readings themselves. Paywalled or script-only pages come
// back as "not opened".

import { fetchPage } from "./fetch-page";
import { readPdf } from "./pdf";

export type Reading = {
  url: string;
  title: string;
  ok: boolean;
  /** Why it couldn't be used, when ok is false. */
  problem?: string;
  text: string;
  truncated: boolean;
};

/** Per reading. Long enough for a full journal article; the model's context is far larger. */
const MAX_CHARS = 80_000;
/** Less text than this usually means a paywall, login or cookie page. */
const MIN_CHARS = 1_500;

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title: title.replace(/\s+/g, " "), text };
}

export async function fetchReading(url: string): Promise<Reading> {
  const fail = (problem: string): Reading => ({ url, title: url, ok: false, problem, text: "", truncated: false });
  try {
    const res = await fetchPage(url);
    if (res.status < 200 || res.status > 299) return fail(`HTTP ${res.status}`);
    let title: string;
    let text: string;
    if (res.contentType.includes("pdf") || /\.pdf($|\?)/i.test(res.url)) {
      const pages = readPdf(res.data, { images: false });
      text = pages.map((p) => p.text).join("\n\n");
      title = text.split("\n").find((l) => l.trim().length > 10)?.trim().slice(0, 120) ?? url;
    } else {
      ({ title, text } = htmlToText(new TextDecoder().decode(res.data)));
    }
    if (text.length < MIN_CHARS) return { ...fail("too little text (paywall or login page?)"), title: title || url };
    return {
      url,
      title: title || url,
      ok: true,
      text: text.slice(0, MAX_CHARS),
      truncated: text.length > MAX_CHARS,
    };
  } catch (e) {
    return fail((e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message);
  }
}

export async function fetchReadings(urls: string[]): Promise<Reading[]> {
  return Promise.all(urls.map(fetchReading));
}

/** Plain text of a .docx: its word/document.xml with paragraphs turned into line breaks. */
async function docxText(data: Uint8Array): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const xml = await (await JSZip.loadAsync(data)).file("word/document.xml")?.async("string");
  if (!xml) throw new Error("That doesn't look like a Word (.docx) file");
  const decode = (t: string) =>
    t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
    .map((p) => decode([...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((t) => t[1] ?? " ").join("")))
    .join("\n")
    .trim();
}

/** A reading the user uploaded themselves (PDF or Word) in place of a link that wouldn't open. */
export async function readUpload(name: string, data: Uint8Array): Promise<Pick<Reading, "title" | "text" | "truncated">> {
  const lower = name.toLowerCase();
  let text: string;
  if (lower.endsWith(".pdf")) text = readPdf(data, { images: false }).map((p) => p.text).join("\n\n");
  else if (lower.endsWith(".docx")) text = await docxText(data);
  else if (lower.endsWith(".doc")) throw new Error("Old .doc files can't be read: save it as .docx or PDF first");
  else throw new Error("Upload a PDF or Word (.docx) file");
  text = text.trim();
  if (text.length < 300) throw new Error("Almost no text in that file (a scanned PDF?)");
  return readingFromText(name, text);
}

/** A file's text as reading material, cut to the usual length. */
export function readingFromText(name: string, text: string): Pick<Reading, "title" | "text" | "truncated"> {
  return { title: name.replace(/\.(pdf|docx)$/i, ""), text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}
