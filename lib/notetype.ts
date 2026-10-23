// The note type the cards use, "Next-gen Cloze". Its id, fields and template are those of the
// author's own "2. Cloze" (read-only look, 2026-09-28): Anki matches an imported note type by
// id, so there the cards keep going into "2. Cloze" under that name, and everyone else gets
// "Next-gen Cloze". `mod: 0` means Anki never treats our copy as newer, so it keeps the
// user's own styling untouched.

export const NOTETYPE_ID = 1649116901154;
export const NOTETYPE_NAME = "Next-gen Cloze";

/** Notes of these types are the user's own cards, used as style examples. */
export const OWN_NOTETYPES = [NOTETYPE_NAME, "2. Cloze"];

export const CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}

.cloze {
 font-weight: bold;
 color: blue;
}
.nightMode .cloze {
 color: lightblue;
}
`;

export const FIELDS = ["Text", "Back Extra"];
export const QFMT = "{{cloze:Text}}";
export const AFMT = "{{cloze:Text}}<br>\n\n{{Back Extra}}";

const LATEX_PRE = `\\documentclass[12pt]{article}
\\special{papersize=3in,5in}
\\usepackage[utf8]{inputenc}
\\usepackage{amssymb,amsmath}
\\pagestyle{empty}
\\setlength{\\parindent}{0in}
\\begin{document}
`;
const LATEX_POST = "\\end{document}";

/** Legacy (schema 11) JSON for the note type, as stored in `col.models`. */
export function legacyModel(deckId: number) {
  const field = (name: string, ord: number) => ({
    name,
    ord,
    sticky: false,
    rtl: false,
    font: "Arial",
    size: 20,
    media: [],
  });
  return {
    id: NOTETYPE_ID,
    name: NOTETYPE_NAME,
    type: 1,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [
      { name: "Cloze", ord: 0, qfmt: QFMT, afmt: AFMT, bqfmt: "", bafmt: "", did: null, bfont: "", bsize: 0 },
    ],
    flds: FIELDS.map(field),
    css: CSS,
    latexPre: LATEX_PRE,
    latexPost: LATEX_POST,
    latexsvg: false,
    req: [[0, "any", [0]]],
    tags: [],
    vers: [],
  };
}
