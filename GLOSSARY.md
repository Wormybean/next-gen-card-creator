# Next-gen Card Creator

Turns lecture slides and question sets into Anki cloze flashcards that a student reviews before adding them to Anki.

## Cards

**Card**:
One cloze text, with its back (Extra, definitions, pictures). Becomes one Anki note.
_Avoid_: Note, flashcard (when counting)

**Review**:
One cloze number on a card; Anki shows each as a separate question. A card with c1 and c2 gives two reviews.
_Avoid_: Anki card, sibling

**Image card**:
A card whose front shows a picture cut from a slide (histology, gross pathology, radiology or a clinical photo) of a main condition, and asks the student to name what it shows.
_Avoid_: Picture card, spot diagnosis

**Main condition**:
A condition a lecture is built around: named in its title, a case or section heading or the learning objectives, or recurring across several slides. One shown once in passing is not a main condition.
_Avoid_: Key pathology, high-yield condition

**Must-know fact**:
A fact from a lecture that a good set of cards has to cover, agreed by the student before the lecture is used for testing.
_Avoid_: Key point (that is the summary the AI writes), high-yield point

## Making cards

**Lecture**:
One upload of slides, from one or more PDFs, made into cards together.
_Avoid_: Job (internal), deck

**Request**:
One ask to the AI to write cards for a set of slides, or for a whole question set. Each is billed to the user's OpenRouter credit.
_Avoid_: Batch, call

**Tidy pass**:
The second request after card writing that rewrites only the cards breaking the rulebook.
_Avoid_: Repair, checking

**Run time**:
Wall-clock time from pressing "Make cards" until the cards are ready to review.
_Avoid_: Latency, generation time
