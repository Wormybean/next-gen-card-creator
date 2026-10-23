# Next-gen Card Creator

Turns lecture PDFs and question sets (cases, tutorials, CSBL session plans) into Anki cloze cards on the "Next-gen Cloze" note type, written
to the card rulebook in [lib/rules.ts](lib/rules.ts). Runs on your own computer, or online on Vercel where each visitor uses their own OpenRouter key (see "Putting it online").

## First-time setup

1. Make an OpenRouter account at https://openrouter.ai, add some credit (leave Auto Top-Up off), and create a key
   at https://openrouter.ai/settings/keys (the app's key box shows each step with pictures).
2. In this folder, put it in the file `.env.local`:
   ```
   OPENROUTER_API_KEY=...
   ```
   Cards are written by Claude Haiku 5.5 (Gemini 3.6 Flash when Haiku is busy), about 2–3 US cents a lecture. A
   lecture is sent in requests of 15 slides, four at a time. **OpenRouter credit** at the top of the page shows what
   is left and what this lecture has cost.

## Using it

1. Double-click **Start Next-gen Card Creator.bat**. It opens http://localhost:3100 in your browser.
2. Choose a lecture PDF (several PDFs of one lecture become one lecture). To study from a set of questions instead
   (a case, tutorial or CSBL session plan), choose the questions **and** any reading material together: a file
   with at least 3 questions, and one per page or more, is taken as the questions, and the other files and any
   links in them are the readings. The setup screen can switch between the two if the guess is wrong.
3. Check the lecture type, deck and tags, then click **Make cards**.
4. Review. Each card shows its **Front** (the cloze text, as Anki shows it) beside its **Back**:
   - **Blanks:** highlight words on the front and a small toolbar appears: **[…] Blank** (its own card), **Same
     number** (hidden together with the last blank) or **Define**. Click a blank to change its number (a number already on the card hides it
     together with those blanks; **New** gives it a review of its own), remove it, or define it. Anki's
     shortcuts work too: Ctrl+Shift+C, Ctrl+Shift+Alt+C, and Ctrl+Shift+D to define. To type the cloze text by
     hand, open **Edit cloze source**.
   - **Definitions:** Define asks the AI for a ≤15-word definition for the way the card and slide use the term
     (about a second; a term already defined on another card of this lecture is reused for free). It appears on the
     back; the pencil edits it, ✕ removes it. If the AI can't answer, an empty row opens for you to type one.
   - **Pictures** (desktop app and your own computer only): every lecture card has its slide on the back; untick
     **On back** to leave a picture out, or **Move to front** to show it above the question. **Crop slide** opens the
     slides at this card's one: drag a box over the part you want, or add the whole slide. You can also paste a
     picture onto a card (Ctrl+V; for a web image, right-click → Copy image first) or drop a picture file on it.
     Pictures are scaled to at most 1000 px wide.
   - **Extra** is an optional line under the answer. **Include** decides whether the card is exported;
     **Combine…** on two or more cards, then **Combine** at the top, merges them.
   - Flags to look at:
     - **maybe · over the target**: extras beyond the card target, not included by default.
     - **already have this?**: a close match already exists in your collection (hover to see it).
     - **from the AI's knowledge**: an answer to a question that wasn't taken from a reading. Check it.
     - A list at the top shows which reading files and links could be used.
5. Click **Export .apkg** and double-click the downloaded file to import it into Anki.

Re-exporting the same lecture updates the cards already imported instead of duplicating them.
Work is saved as you go; the page address (`?job=…`) reopens it.

## Settings (optional, in `.env.local`)

- `OPENROUTER_MODEL`: comma-separated OpenRouter models to try in order, as `openrouter:<id>` (default:
  `openrouter:anthropic/claude-haiku-5.5,openrouter:google/gemini-3.6-flash`); the next is used when one is busy.
- `ANKI_COLLECTION`: path to `collection.anki2` if your profile isn't `User 1`.

The collection is only ever copied, never changed. Uploads and drafts are kept in
`%LOCALAPPDATA%\AnkiCardMaker\jobs`, outside OneDrive.

## Developing

- `npm test`: unit tests.
- `npx tsx --env-file=.env.local scripts/bench.ts --type clinical --label <name> <lecture.pdf>`: speed test of a
  lecture with the app's settings (or others), saved under `bench/`; `scripts/score.ts` scores runs blind.
- `npx tsx scripts/sample-apkg.ts <some.pdf> <out.apkg>`: builds a two-card test file.

## Putting it online (Vercel)

Online, each visitor pastes their **own** OpenRouter key (the page shows the steps). The key lives in their browser
and is sent with each request; the server never stores it, and ignores `OPENROUTER_API_KEY`
whenever it runs on Vercel (`VERCEL` is set), so nobody can spend your key. **Remove it from the Vercel project's
environment variables anyway.**

One-time setup in Vercel:

1. Storage → create a **Blob** store, set to **Private**, and connect it to this project. That adds `BLOB_READ_WRITE_TOKEN`.
   Vercel can't keep files between requests, so uploads, slide pictures and drafts live there.
2. Add an environment variable `CRON_SECRET` (any long random string). The daily job in `vercel.json` calls
   `/api/cleanup` with it and deletes every stored file older than 24 hours (so nothing lives longer than about 48 hours).
3. Redeploy.

How it behaves online: big PDFs go from the browser straight to Blob (a request to the server is capped at 4.5 MB); the
.apkg is streamed back; "Delete my files now" removes a lecture at once; there is no Anki collection, so the duplicate
check is off and the style examples are left out. The privacy line on the first page says files are deleted within 48
hours, which is only true while the cleanup job is running.

## Anki add-on

The same card maker inside Anki (26.9 or newer): **Tools → Next-gen Card Creator**. Everything works as on the
website, except that **Add to Anki** puts the ticked cards straight into the open collection instead of
downloading an .apkg. Adding the same lecture again updates the cards already there; one Undo in Anki takes a
whole batch back. Cards use the "Next-gen Cloze" note type, which is created the first time if missing.

- **Key:** paste your OpenRouter key in the window, or set `openrouter_key` under Tools → Add-ons → Config. It is
  kept in the add-on's `meta.json`, on that computer only.
- **Files:** uploads, slide pictures and drafts live in the add-on's `user_files` folder, which Anki keeps
  through add-on updates.
- **Build:** `npm run addon:build` bundles the page into `addon/web/` and makes
  `dist-addon/next-gen-card-creator.ankiaddon` (double-click it to install). `npm run addon:build -- --link`
  also links `addon/` into Anki's add-ons folder, so restarting Anki picks up each build.
- **Checking it by script:** start Anki with `QTWEBENGINE_REMOTE_DEBUGGING=9337` (the window can then be driven
  through the Chrome DevTools Protocol) and `NGCC_OPEN_ON_START=1` (opens the window once the profile loads).
- **Publishing:** upload the .ankiaddon at https://ankiweb.net/shared/addons (needs an AnkiWeb account). The
  listing text is in [docs/ankiweb-listing.html](docs/ankiweb-listing.html).

## Licence

Copyright (C) 2026 Wormybean. Free software under the GNU Affero General Public License, version 3 or later
([LICENSE](LICENSE)), the same as Anki; the PDF reader it uses, MuPDF, is AGPL too.

[NOTICE](NOTICE) adds two terms the licence allows: copies keep the credit "Next-gen Card Creator by Wormybean",
and a modified version you share needs its own name (it may say it's based on Next-gen Card Creator).

## Desktop app (Windows installer)

`npm run desktop:build` makes `dist-desktop/Next-gen Card Creator Setup <version>.exe`: an installer that carries its own copy of
the server and of Node, so the person installing needs nothing else. (`-- --dir` builds an unpacked folder only, for a
quick check.) The app uses their own Anki collection (any profile, on Windows, Mac or Linux) for style examples and the
duplicate check, keeps uploads in its own data folder, and shows no ads. Making cards still needs the internet, because
the AI is reached through OpenRouter, with their own key.

- The installer is **not code-signed**, so Windows SmartScreen says "Windows protected your PC" on first run
  (More info → Run anyway). Signing is the only real fix.
- A Mac build has to be made on a Mac (`npm run desktop:build` there gives a .dmg, unsigned unless you have an Apple
  Developer account).
- When running the app from a terminal inside VS Code or another Electron program, clear `ELECTRON_RUN_AS_NODE` first,
  or the app exits straight away.
