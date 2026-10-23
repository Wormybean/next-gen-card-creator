// The card rulebook, settled with the user on 2026-09-28. It is sent to the AI as the
// system prompt, and the measurable parts are re-checked in code on every draft card.

import { blanks, clozeNumbers, plainText, wordCount } from "./cloze";
import type { CardImage, Definition } from "./extras";

export const LECTURE_TYPES = ["medical-science", "clinical", "public-health", "csbl"] as const;
export type LectureType = (typeof LECTURE_TYPES)[number];

export const LECTURE_TYPE_LABELS: Record<LectureType, string> = {
  "medical-science": "Medical science",
  clinical: "Clinical",
  "public-health": "Public health",
  csbl: "Questions + reading material",
};

/** Questions in a document: sentences of three words or more that end in "?". */
export function questionCount(text: string): number {
  return (text.match(/[A-Z][^.?!\n]{8,}\?/g) ?? []).filter((q) => q.trim().split(/\s+/).length >= 3).length;
}

/**
 * A question sheet (a case, tutorial or session plan) rather than slides or a reading: at least
 * 3 questions, and at least one per page, so a slide deck with the odd "Why…?" slide isn't one.
 */
export const isQuestionSheet = (text: string, pages: number) => {
  const questions = questionCount(text);
  return questions >= 3 && questions >= pages;
};

export type DraftCard = {
  id: string;
  /** Lecture slide (0-based) the card came from; absent for CSBL. */
  slide?: number;
  /** CSBL discussion question the card answers; shown on the back. */
  question?: string;
  text: string;
  /** Lectures: optional short "why" line for the back. */
  why?: string;
  /** Pictures for the front or back, in the order they were added. */
  images: CardImage[];
  /** Terms on the card, defined for the back. */
  definitions?: Definition[];
  /** 1 = must know, 2 = important, 3 = nice to know. Used to flag cards over the target. */
  priority: 1 | 2 | 3;
  /** Where a CSBL answer came from: a reading's title. */
  source?: string;
  fromKnowledge?: boolean;
  /** An image card (GLOSSARY.md): its front shows a picture of this main condition, to be named. */
  imageCard?: {
    condition: string;
    /** The condition heads a case or section; these are kept first when there are too many. */
    headline?: boolean;
    /** Words giving the answer away are printed inside the picture: offered unticked, to check. */
    answerShows?: boolean;
  };
  warnings: string[];
  maybe?: boolean;
  duplicateOf?: string;
};

export const RULEBOOK = `You write Anki cloze flashcards for a medical student.

# Top priority: succinct
Information overload is the worst outcome. Every other rule gives way to this one.

# What gets a card
- High-yield only. Skip minor details entirely.
- Priority for deciding what is high-yield: (1) anything the learning objectives mention; (2) what the lecturer emphasises (bold/red text, "important", "remember", repeated across slides); (3) clinically decisive facts: first-line treatment, red flags, most common cause, contraindications, classic presentation. Use your own judgement only as a tie-breaker.
- Medical science outweighs public health.
- Test facts AND understanding, equally. Understanding cards are mostly:
  - "why" cards: "<b>Beta-blockers</b> are avoided in asthma because they {{c1::block β2 receptors → bronchoconstriction}}."
  - consequence cards: "Damage to the {{c1::recurrent laryngeal nerve}} → {{c2::hoarse voice}}."
  - cause→effect chains only for true step-by-step pathways (e.g. RAAS, clotting cascade), at most 5 steps, one link per card.
- Never make cards from: title, learning-objectives or reference slides; exact statistics and percentages; lecturer stories, history or fun facts; study names and years; anything marked not examinable. DO keep clinically useful rough numbers and cut-offs ("most common", "~1 in 3", a BP threshold).

# How each card is written
- Aim for about 15 words. HARD LIMIT: 20 words, counting the answers. Only a short labelled list may reach 25.
- Cut before you split. Drop definitions of the obvious, lists of examples in brackets, "In Australia," / "generally" / "clinically" and every other qualifier the exam wouldn't mark. Split into two cards only if two separate high-yield ideas remain.
- Never pack two facts into one card joined by "and"/<br> when they are really two cards (e.g. side effects AND contraindications).
- At most 3 cloze numbers per card, usually 1–2. Each cloze number becomes a separate review, so fewer is better.
- Lists: 3 items or fewer share ONE cloze number ({{c1::A}}, {{c1::B}}, {{c1::C}}). Longer lists are split across cards.
- Linked halves share ONE cloze number. When two blanks are two sides of one idea (intake vs expenditure, cause and its paired effect, the two ends of a balance), seeing one gives the other away, so hide them together:
  RIGHT: <b>REDs</b> is driven by an imbalance between {{c1::energy intake}} and {{c1::exercise energy expenditure}}.
  WRONG: … between {{c1::energy intake}} and {{c2::exercise energy expenditure}}.
  Use separate numbers only for facts that are genuinely separate and each worth recalling alone.
- Blank the key term, never filler words.
- Every card names its subject, in bold: "<b>Propofol</b> causes …", never "It causes …". Add a short topic prefix only when the subject name alone is ambiguous.
- "Why" lines (lectures only) are the exception, not the rule: at most about 1 card in 4, only when the reason is itself examinable. Leave it empty otherwise.
- Don't write the same fact twice, even when two slides repeat it.
- Style: plain sentences; labelled lines like "Aetiology: …" separated by <br>; <b>bold</b> the key term / subject.
- Hints: when a blank could be answered more than one way, add a hint naming the KIND of answer: {{c1::GLP-1 receptor agonist::MOA}}, {{c1::…::class}}, {{c1::…::organ}}, {{c1::…::sign}}. No hint when the answer is unambiguous.
- Follow the spelling, guidelines and drug names the source material uses (e.g. British or American spelling, the country's own guidelines). When the source material itself states something newer than your knowledge (e.g. a renamed condition), the source wins.
- Cards are general knowledge, never about a specific patient.
- Use HTML only for <b>, <i> and <br>. Arrows (→, ↑, ↓) are fine.

# Target examples (this is the style to match)
1. <b>Acanthosis nigricans</b> is a skin sign of {{c1::insulin resistance}}.
2. <b>Semaglutide</b> is a {{c1::GLP-1 receptor agonist::MOA}} → weight loss via {{c2::↓ appetite}} and {{c2::slowed gastric emptying}}.
3. <b>PCOS</b> has been renamed {{c1::polyendocrine metabolic ovarian syndrome (PMOS)}}.
4. <b>Hirsutism</b> in PMOS is caused by {{c1::excess androgens}}.   (why line: ↑ insulin → ovarian androgen production)
5. <b>Stopping semaglutide</b> commonly leads to {{c1::weight regain}}.

# Priority field
Give every card a priority: 1 = must know for the exam, 2 = important, 3 = nice to know. Be honest; it decides which cards get flagged as extras.`;

export function styleExamplesBlock(examples: { mine: string[]; ish: string[] }): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const sections = [];
  if (examples.mine.length) sections.push(`# The student's own cards (match this voice)\n${list(examples.mine)}`);
  if (examples.ish.length)
    sections.push(`# Cards from a deck the student studies heavily (borrow the bold key terms and ::hints)\n${list(examples.ish)}`);
  return sections.join("\n\n");
}

/** Soft target for the whole lecture; cards beyond it are flagged "maybe", not deleted. */
export function cardTarget(type: LectureType, contentUnits: number): number {
  switch (type) {
    case "medical-science":
    case "clinical":
      return contentUnits; // up to ~1 per content slide
    case "public-health":
      return 3;
    case "csbl":
      return contentUnits * 3; // ~1–3 per knowledge question
  }
}

export function targetGuidance(type: LectureType): string {
  switch (type) {
    case "medical-science":
      return "This is a MEDICAL SCIENCE lecture: at most about 1 card per content slide on average. Slides with nothing important get zero cards.";
    case "clinical":
      return "This is a CLINICAL lecture: at most about 1 card per content slide on average, favouring red flags, first-line treatment and classic presentations. Slides with nothing important get zero cards.";
    case "public-health":
      return "This is a PUBLIC HEALTH lecture: only about 2–3 cards for the WHOLE lecture. Most slides get zero cards.";
    case "csbl":
      return "This is a question set: about 1–3 cards per knowledge question.";
  }
}

/** Checks the measurable rules. Returns human-readable warnings for the review screen. */
export function checkCard(text: string): string[] {
  const warnings: string[] = [];
  const nums = clozeNumbers(text);
  if (!nums.length) return ["No blanks: this card can't be exported"];
  const words = wordCount(text);
  if (words > 25) warnings.push(`Long: ${words} words (aim ~15)`);
  if (nums.length > 3) warnings.push(`${nums.length} cloze numbers (max 3)`);
  const perNumber = new Map<number, number>();
  for (const b of blanks(text)) perNumber.set(b.num, (perNumber.get(b.num) ?? 0) + 1);
  for (const [num, count] of perNumber) {
    if (count > 3) warnings.push(`c${num} hides ${count} items at once (lists over 3 should be split)`);
  }
  if (/^(it|they|this|these)\b/i.test(plainText(text))) warnings.push("Starts with a pronoun: name the subject");
  return warnings;
}

/** Flags the lowest-priority cards beyond the target as "maybe". Keeps original order. */
export function applyTarget(cards: DraftCard[], target: number): DraftCard[] {
  const ranked = [...cards].sort((a, b) => a.priority - b.priority);
  const keep = new Set(ranked.slice(0, Math.max(target, 0)).map((c) => c.id));
  return cards.map((c) => ({ ...c, maybe: !keep.has(c.id) }));
}

/** Best guess at the lecture type from its file name and text; the user confirms it. */
export function guessLectureType(fileName: string, text: string): LectureType {
  const hay = `${fileName}\n${text.slice(0, 6000)}`.toLowerCase();
  if (/\bcsbl\b/.test(hay) && /discussion starters|trigger \d/.test(hay)) return "csbl";
  const count = (words: string[]) => words.reduce((n, w) => n + (hay.split(w).length - 1), 0);
  const ph = count(["public health", "population", "epidemiolog", "health promotion", "policy", "equity", "burden of disease", "prevalence", "screening program"]);
  const clin = count(["management", "presentation", "examination", "history taking", "plenary", "clinic", "diagnosis", "treatment", "red flag"]);
  const sci = count(["pathology", "physiology", "pharmacology", "anatomy", "histology", "embryology", "mechanism", "receptor", "cell"]);
  if (ph > clin && ph > sci) return "public-health";
  if (clin > sci) return "clinical";
  return "medical-science";
}
