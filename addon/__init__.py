# Next-gen Card Creator as an Anki add-on.
# Copyright (C) 2026 Wormybean. Licensed under the GNU Affero General Public License v3 or
# later, with the additional terms in NOTICE. Source: https://github.com/Wormybean/next-gen-card-creator
#
# The card maker itself is a web page (built into web/ by scripts/build-addon.mjs) shown in an
# Anki window. It writes cards, defines terms and reads PDFs on its own; this file opens the
# window and does what needs Anki or the computer: files, the collection (reading it and
# adding the cards), the OpenRouter key, fetching readings and opening links.
#
# The page sends pycmd('{"id": 1, "name": "getFile", "arg": ...}') and gets back
# {"ok": true, "value": ...} or {"ok": false, "error": "..."}. Slow requests answer
# {"pending": true} at once and the result later, through window.__ngccDone(id, reply).

import base64
import hashlib
import json
import os
import re
import shutil
import urllib.error
import urllib.request

from anki.consts import MODEL_CLOZE
import aqt
from aqt import gui_hooks, mw
from aqt.operations import CollectionOp
from aqt.qt import QDialog, QAction, Qt, QTimer, QUrl, QVBoxLayout
from aqt.utils import askUser, openLink
from aqt.webview import AnkiWebView

ADDON = mw.addonManager.addonFromModule(__name__)
USER_FILES = os.path.join(os.path.dirname(__file__), "user_files")

# Anki's media server only hands out add-on files that match this: the page, and the
# slide pictures and card pictures it shows.
mw.addonManager.setWebExports(
    __name__, r"(web/.*\.(html|js|css|wasm|png|svg)|user_files/jobs/[0-9a-f-]{36}/[\w.-]+\.(png|jpg|webp|gif))$"
)

# Storage keys look like "jobs/<id>/draft.json" (lib/jobs.ts).
STORE_KEY = re.compile(r"^jobs/[0-9a-f-]{36}(/[\w.-]+)?$")
MAX_FETCH = 30 * 1024 * 1024


def failure(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"


def config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


def store_path(key: str) -> str:
    if not isinstance(key, str) or not STORE_KEY.match(key) or ".." in key:
        raise ValueError("Bad storage key")
    return os.path.join(USER_FILES, *key.split("/"))


def put_file(arg):
    path = store_path(arg["key"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(base64.b64decode(arg["data"]))


def get_file(key):
    path = store_path(key)
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def delete_file(key):
    path = store_path(key)
    if os.path.isfile(path):
        os.remove(path)


def delete_folder(key):
    shutil.rmtree(store_path(key), ignore_errors=True)


def collection(_arg):
    """Deck names and existing cloze notes, for the deck list, duplicate check and style examples,
    and the deck selected in Anki, which new cards go to unless the user picks another."""
    names = {m.id: m.name for m in mw.col.models.all_names_and_ids()}
    notes = []
    for nid, mid, flds in mw.col.db.all("select id, mid, flds from notes order by mod desc"):
        text = flds.split("\x1f", 1)[0]
        if "{{c" in text:
            notes.append({"id": nid, "text": text, "notetype": names.get(mid, "")})
    decks = sorted(d.name for d in mw.col.decks.all_names_and_ids())
    current = mw.col.decks.current()
    # The Default deck (id 1) is where cards land when nobody chose; the page picks its own name instead.
    return {"decks": decks, "currentDeck": "" if current["id"] == 1 else current["name"], "clozeNotes": notes}


def media_name(data: bytes, ext: str) -> str:
    """Named by content, as lib/apkg.ts mediaName() names them, so a picture is in Anki only once."""
    return f"cardmaker-{hashlib.sha1(data).hexdigest()[:20]}.{ext}"


def add_media(key):
    """Copies a slide or card picture into Anki's media folder; returns the name it has there."""
    with open(store_path(key), "rb") as f:
        data = f.read()
    return mw.col.media.write_data(media_name(data, key.rsplit(".", 1)[-1]), data)


def usable(notetype) -> bool:
    return bool(notetype) and notetype["type"] == MODEL_CLOZE and {"Text", "Back Extra"} <= {
        f["name"] for f in notetype["flds"]
    }


def notetype_for(col, spec):
    """The note type the cards use: the one an .apkg export brings (same id) or one of the same
    name, if it has the fields; otherwise a new copy of it."""
    mm = col.models
    names = [spec["name"], f"{spec['name']} 2"]
    for notetype in [mm.get(spec["id"])] + [mm.by_name(n) for n in names]:
        if usable(notetype):
            return notetype
    notetype = mm.new(next(n for n in names if not mm.by_name(n)))
    notetype["type"] = MODEL_CLOZE
    notetype["css"] = spec["css"]
    for name in spec["fields"]:
        mm.add_field(notetype, mm.new_field(name))
    template = mm.new_template("Cloze")
    template["qfmt"], template["afmt"] = spec["qfmt"], spec["afmt"]
    mm.add_template(notetype, template)
    return mm.get(mm.add_dict(notetype).id)


def add_notes(col, arg):
    """Adds the reviewed cards (lib/notes.ts) as one undo step. A note with the same guid,
    from an earlier export, is updated in place and its cards stay where they are."""
    # Before the undo step: adding a note type clears Anki's undo history, so a new collection's
    # first add would otherwise fail to merge ("target undo op not found") after adding the notes.
    notetype = notetype_for(col, arg["notetype"])
    undo = col.add_custom_undo_entry("Add cards from Next-gen Card Creator")
    deck = arg["deck"]
    deck_id = col.decks.id_for_name(deck) or col.decks.add_normal_deck_with_name(deck).id
    added = updated = unchanged = 0
    for n in arg["notes"]:
        tags = [re.sub(r"\s+", "_", t) for t in n.get("tags") or []]
        note_id = col.db.scalar("select id from notes where guid = ?", n["guid"])
        if note_id:
            note = col.get_note(note_id)
            before = (list(note.fields), list(note.tags))
            if "Text" in note and "Back Extra" in note:
                note["Text"], note["Back Extra"] = n["text"], n["backExtra"]
            else:
                note.fields[0], note.fields[1] = n["text"], n["backExtra"]
            note.tags += [t for t in tags if t not in note.tags]
            if (list(note.fields), list(note.tags)) == before:
                unchanged += 1
            else:
                col.update_note(note)
                updated += 1
        else:
            note = col.new_note(notetype)
            note["Text"], note["Back Extra"] = n["text"], n["backExtra"]
            note.tags = tags
            note.guid = n["guid"]
            col.add_note(note, deck_id)
            added += 1
    return col.merge_undo_entries(undo), {"added": added, "updated": updated, "unchanged": unchanged}


LAST_JOB = os.path.join(USER_FILES, "last_job.txt")
JOB_ID = re.compile(r"^[0-9a-f-]{36}$")


def remember_job(url: QUrl) -> None:
    """The page keeps the open lecture in its address (?job=<id>); the window reopens on it, so
    closing the window by mistake loses nothing. "New lecture" clears it."""
    if not url.path().endswith("/web/index.html"):
        return  # the window emptying as it closes, not the page moving on
    found = re.search(r"(?:^|&)job=([0-9a-f-]{36})", url.query())
    try:
        if found:
            os.makedirs(USER_FILES, exist_ok=True)
            with open(LAST_JOB, "w", encoding="utf-8") as f:
                f.write(found.group(1))
        elif os.path.isfile(LAST_JOB):
            os.remove(LAST_JOB)
    except OSError:
        pass  # only a convenience


def last_job() -> str:
    try:
        with open(LAST_JOB, encoding="utf-8") as f:
            job = f.read().strip()
    except OSError:
        return ""
    return job if JOB_ID.match(job) and os.path.isdir(store_path(f"jobs/{job}")) else ""


def get_key(_arg):
    return config().get("openrouter_key", "")


def set_key(arg):
    conf = config()
    conf["openrouter_key"] = (arg or "").strip()
    mw.addonManager.writeConfig(__name__, conf)


def get_gemini_key(_arg):
    """A Gemini key added to the config by hand (not offered in the window or config.md): cards
    then go to Gemini directly when there is no OpenRouter key."""
    return config().get("gemini_key", "")


def fetch_url(url):
    """Runs in the background: a reading's page or PDF, as the page's fetchPage() expects it."""
    if not re.match(r"^https?://", url or ""):
        raise ValueError("Not a web address")
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/140.0 Safari/537.36",
            "Accept": "text/html,application/pdf;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as res:
            data = res.read(MAX_FETCH)
            status, content_type, final_url = res.status, res.headers.get("Content-Type", ""), res.geturl()
    except urllib.error.HTTPError as e:
        data, status, content_type, final_url = b"", e.code, "", url
    return {
        "status": status,
        "contentType": content_type,
        "url": final_url,
        "data": base64.b64encode(data).decode("ascii"),
    }


def open_link(url):
    if re.match(r"^https?://", url or ""):
        openLink(url)


HANDLERS = {
    "putFile": put_file,
    "getFile": get_file,
    "deleteFile": delete_file,
    "deleteFolder": delete_folder,
    "collection": collection,
    "addMedia": add_media,
    "getKey": get_key,
    "setKey": set_key,
    "getGeminiKey": get_gemini_key,
    "openLink": open_link,
}
BACKGROUND = {"fetchUrl": fetch_url}
# Collection changes: run as Anki operations, so they can be undone and Anki's screens refresh.
OPS = {"addNotes": add_notes}


DIALOG = "NextGenCardCreator"


class CreatorWindow(QDialog):
    def __init__(self) -> None:
        # A window of its own, like Anki's Browser: its own taskbar button, minimise and
        # maximise, and Anki's main window can come in front of it while cards are written.
        super().__init__(None, Qt.WindowType.Window)
        self.setWindowFlags(
            self.windowFlags() | Qt.WindowType.WindowMinMaxButtonsHint | Qt.WindowType.WindowCloseButtonHint
        )
        self.setWindowTitle("Next-gen Card Creator")
        self.resize(1280, 860)
        self.web = AnkiWebView(parent=self, title="next_gen_card_creator")
        self.web.set_bridge_command(self.on_bridge, self)
        # Otherwise Anki hands any page it didn't make itself to the system browser.
        self.web.set_open_links_externally(False)
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.web)
        self.setLayout(layout)
        self.closing = False
        port = mw.mediaServer.getPort()
        job = last_job()
        self.web.load(QUrl(f"http://127.0.0.1:{port}/_addons/{ADDON}/web/index.html" + (f"?job={job}" if job else "")))
        self.web.urlChanged.connect(remember_job)

    def on_bridge(self, message: str):
        try:
            request = json.loads(message)
        except ValueError:
            return None  # not one of ours
        name, arg, req_id = request.get("name"), request.get("arg"), request.get("id")
        if name in BACKGROUND:
            mw.taskman.run_in_background(
                lambda: BACKGROUND[name](arg), lambda future: self.answer_later(req_id, future)
            )
            return {"pending": True}
        if name in OPS:
            self.run_op(req_id, OPS[name], arg)
            return {"pending": True}
        handler = HANDLERS.get(name)
        if not handler:
            return {"ok": False, "error": f"Unknown request: {name}"}
        try:
            return {"ok": True, "value": handler(arg)}
        except Exception as e:
            return {"ok": False, "error": failure(e)}

    def run_op(self, req_id, fn, arg) -> None:
        result = {}

        def op(col):
            changes, result["value"] = fn(col, arg)
            return changes

        (
            CollectionOp(parent=self, op=op)
            .success(lambda _: self.answer(req_id, {"ok": True, "value": result["value"]}))
            .failure(lambda e: self.answer(req_id, {"ok": False, "error": failure(e)}))
            .run_in_background()
        )

    def answer_later(self, req_id, future) -> None:
        try:
            reply = {"ok": True, "value": future.result()}
        except Exception as e:
            reply = {"ok": False, "error": failure(e)}
        self.answer(req_id, reply)

    def answer(self, req_id, reply) -> None:
        self.web.eval(f"window.__ngccDone({json.dumps(req_id)}, {json.dumps(reply)})")

    def keyPressEvent(self, event) -> None:
        # Esc belongs to the page (it closes the crop box); it shouldn't close the whole window.
        if event.key() != Qt.Key.Key_Escape:
            super().keyPressEvent(event)

    def reject(self) -> None:
        """The window's X."""
        self.close_then(None)

    def closeWithCallback(self, callback) -> None:
        """Anki closing the profile (aqt.dialogs.closeAll)."""
        self.close_then(callback)

    def close_then(self, callback) -> None:
        """Cards being written live only in the page, so ask first then; a lecture under
        review is saved already and reopens next time."""
        if self.closing:
            return
        self.closing = True
        answered = []

        def decide(working) -> None:
            if answered:
                return
            answered.append(True)
            if working and not askUser(
                "Cards are still being written. Close anyway? The cards written so far will be lost.",
                parent=self,
                title="Next-gen Card Creator",
            ):
                self.closing = False
                return
            remember_job(self.web.url())
            self.web.cleanup()
            super(CreatorWindow, self).reject()
            aqt.dialogs.markClosed(DIALOG)
            if callback:
                callback()

        self.web.evalWithCallback("!!window.__ngccWorking", decide)
        # A page that never answers mustn't keep the window open.
        QTimer.singleShot(2000, lambda: decide(False))


def create_window() -> CreatorWindow:
    window = CreatorWindow()
    window.show()
    return window


# Registered with Anki, so opening it again brings the window back (even from minimised), and
# Anki closes it before closing the profile.
aqt.dialogs.register_dialog(DIALOG, create_window)


def open_window() -> None:
    aqt.dialogs.open(DIALOG)


action = QAction("Next-gen Card Creator", mw)
action.triggered.connect(open_window)
mw.form.menuTools.addAction(action)


def add_toolbar_link(links, toolbar) -> None:
    """A "Card Creator" link in Anki's top bar, next to Decks, Add, Browse…"""
    links.append(
        toolbar.create_link(
            "next_gen_card_creator",
            "Card Creator",
            open_window,
            tip="Open Next-gen Card Creator: lecture slides to cloze cards",
            id="next_gen_card_creator",
        )
    )


gui_hooks.top_toolbar_did_init_links.append(add_toolbar_link)

# For automated checks: open the window as soon as Anki has loaded the profile.
if os.environ.get("NGCC_OPEN_ON_START"):
    gui_hooks.profile_did_open.append(open_window)
