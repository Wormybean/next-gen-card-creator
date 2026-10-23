// Builds an .apkg Anki can import: a zip holding a schema-11 collection
// (`collection.anki2`), a `media` map, and the media files named "0", "1", ...
// Schema 11 is the older format genanki writes; current Anki still imports it.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { clozeNumbers, stripHtml } from "./cloze";
import { NOTETYPE_ID, legacyModel } from "./notetype";

export type MediaFile = { name: string; data: Uint8Array };

export type ExportNote = {
  /** Stable id: re-importing a note with the same guid updates it instead of duplicating. */
  guid: string;
  text: string;
  backExtra: string;
  tags?: string[];
};

export type ExportInput = {
  deckName: string;
  notes: ExportNote[];
  media: MediaFile[];
};

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
  odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const COL_CONF = {
  activeDecks: [1],
  curDeck: 1,
  newSpread: 0,
  collapseTime: 1200,
  timeLim: 0,
  estTimes: true,
  dueCounts: true,
  curModel: null,
  nextPos: 1,
  sortType: "noteFld",
  sortBackwards: false,
  addToCur: true,
};

const DECK_CONF = {
  1: {
    id: 1,
    name: "Default",
    replayq: true,
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 },
    timer: 0,
    maxTaken: 60,
    usn: 0,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, perDay: 20, bury: false },
    mod: 0,
    autoplay: true,
    dyn: false,
  },
};

function deck(id: number, name: string) {
  return {
    id,
    name,
    desc: "",
    mod: 0,
    usn: -1,
    collapsed: false,
    browserCollapsed: false,
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
  };
}

/** Anki's checksum: first 8 hex digits of sha1(sort field), as an integer. */
function checksum(sortField: string): number {
  return parseInt(createHash("sha1").update(sortField).digest("hex").slice(0, 8), 16);
}

/** Deck id derived from the name, so the same deck gets the same id every export. */
function deckIdFor(name: string): number {
  return parseInt(createHash("sha1").update(name).digest("hex").slice(0, 12), 16);
}

export async function buildApkg(input: ExportInput): Promise<Uint8Array> {
  if (!input.notes.length) throw new Error("No cards to export");
  for (const note of input.notes) {
    if (!clozeNumbers(note.text).length) throw new Error(`Card has no blanks: ${note.text.slice(0, 60)}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), "cardmaker-"));
  const dbPath = path.join(dir, "collection.anki2");
  try {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const deckId = deckIdFor(input.deckName);

    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    db.prepare(
      "INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
    ).run(
      nowSec,
      now,
      now,
      JSON.stringify(COL_CONF),
      JSON.stringify({ [NOTETYPE_ID]: legacyModel(deckId) }),
      JSON.stringify({ 1: deck(1, "Default"), [deckId]: deck(deckId, input.deckName) }),
      JSON.stringify(DECK_CONF),
    );

    const insertNote = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')");
    const insertCard = db.prepare(
      "INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')",
    );

    let id = now;
    input.notes.forEach((note, position) => {
      const nums = clozeNumbers(note.text);
      const noteId = id++;
      const sortField = stripHtml(note.text);
      const tags = note.tags?.length ? ` ${note.tags.map((t) => t.replace(/\s+/g, "_")).join(" ")} ` : "";
      insertNote.run(
        noteId,
        note.guid,
        NOTETYPE_ID,
        nowSec,
        tags,
        `${note.text}\x1f${note.backExtra}`,
        sortField,
        checksum(sortField),
      );
      for (const num of nums) insertCard.run(id++, noteId, deckId, num - 1, nowSec, position + 1);
    });
    db.close();

    const zip = new JSZip();
    zip.file("collection.anki2", await readFile(dbPath));
    const mediaMap: Record<string, string> = {};
    input.media.forEach((m, i) => {
      mediaMap[String(i)] = m.name;
      zip.file(String(i), m.data);
    });
    zip.file("media", JSON.stringify(mediaMap));
    return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export { stableGuid } from "./guid";

/** Content-addressed media name, so the same slide image is never stored twice in Anki. The add-on names them the same way (media_name in addon/__init__.py). */
export function mediaName(data: Uint8Array, ext = "png"): string {
  return `cardmaker-${createHash("sha1").update(data).digest("hex").slice(0, 20)}.${ext}`;
}
