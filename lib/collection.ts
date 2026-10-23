// Read-only access to the user's Anki collection, for deck names, style examples and
// the duplicate check. We never open the real file: it is copied to a temp folder first.
//
// Anki's schema uses a custom "unicase" text collation that plain SQLite doesn't know,
// which makes queries on some tables fail. On the temp copy only, we rewrite it to the
// built-in "nocase" collation.

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";
import { styleExamplesFrom, type ExistingNote, type StyleExamples } from "./style";

export type { ExistingNote };

type Snapshot = {
  mtimeMs: number;
  decks: string[];
  clozeNotes: ExistingNote[];
  styleExamples: StyleExamples;
};

let cached: Snapshot | null = null;

function openCopy(): DatabaseSync {
  const src = config.collectionPath();
  if (!existsSync(src)) throw new Error(`Anki collection not found at ${src} (set ANKI_COLLECTION in .env.local)`);
  const dir = path.join(tmpdir(), "cardmaker-collection");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "collection.anki2");
  copyFileSync(src, dest);
  // Recent changes may still sit in Anki's write-ahead log while Anki is open.
  const wal = `${src}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) copyFileSync(wal, `${dest}-wal`);
  else rmSync(`${dest}-wal`, { force: true });

  const patch = new DatabaseSync(dest, { defensive: false });
  patch.exec(
    "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'COLLATE unicase','COLLATE nocase') WHERE sql LIKE '%unicase%'; PRAGMA writable_schema=OFF;",
  );
  patch.close();
  return new DatabaseSync(dest, { readOnly: true });
}

function load(): Snapshot {
  const mtimeMs = statSync(config.collectionPath()).mtimeMs;
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  const db = openCopy();
  try {
    const decks = (db.prepare("SELECT name FROM decks").all() as { name: string }[])
      .map((d) => d.name.replaceAll("\x1f", "::"))
      .sort();

    const types = new Map(
      (db.prepare("SELECT id, name FROM notetypes").all() as { id: number; name: string }[]).map((t) => [
        t.id,
        t.name,
      ]),
    );
    const rows = db.prepare("SELECT id, mid, flds FROM notes ORDER BY mod DESC").all() as {
      id: number;
      mid: number;
      flds: string;
    }[];
    const clozeNotes: ExistingNote[] = [];
    for (const r of rows) {
      const text = r.flds.split("\x1f")[0];
      if (text.includes("{{c")) clozeNotes.push({ id: r.id, text, notetype: types.get(r.mid) ?? "" });
    }

    cached = { mtimeMs, decks, clozeNotes, styleExamples: styleExamplesFrom(clozeNotes) };
    return cached;
  } finally {
    db.close();
  }
}

/** Online there is no Anki collection: style examples are empty and the duplicate check is skipped. */
export const hasCollection = () => existsSync(config.collectionPath());

export const collection = {
  decks: () => load().decks,
  clozeNotes: () => load().clozeNotes,
  styleExamples: (): Snapshot["styleExamples"] => {
    try {
      return load().styleExamples;
    } catch {
      return { mine: [], ish: [] };
    }
  },
};
