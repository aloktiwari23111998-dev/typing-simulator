# Typing Test Simulator (Offline)

A fully offline DSSSB/SSC-style typing test simulator. No internet, no backend,
no build tools — just open `index.html` in Google Chrome.

## How to run
1. Keep all files (`index.html`, `style.css`, `script.js`, `passages.js`, `passages-dp-hcm.js`, `passages-dsssb-mitra.js`, `evaluators.js`, `categories.js`, `diagnostics.js`) in the same folder.
2. Double-click `index.html`, or right-click → Open with → Google Chrome.

## Exam categories (scalable — add new exams anytime)
The app opens on an **exam catalogue** screen. Currently three categories:
- **DSSSB JSA Typing Test** — 240 real passages, DSSSB's own penalty formula.
- **Delhi Police HCM Typing Test** — sample passages (replace with the real
  ~2000-keystroke ones), DP HCM's own word-to-word marking scheme.
- **Typing Mitra DSSSB** — 358 passages sourced from typingmitra.in, cleaned
  of scraping artifacts (see `passages-dsssb-mitra.js` header for exactly
  what was cleaned), scored with the same DSSSB formula as the main set.

Clicking a category opens its own passage library, search, random test,
and "Download All Passages (PDF)" — all scoped to that exam only, **and
scored using that exam's own rules** (see below).

To add a new exam later (e.g. NTPC, AIIMS CRE):
1. Create a new file, e.g. `passages-ntpc.js`, with the same structure as
   `passages.js`: `const PASSAGES_NTPC = [ { id, title, difficulty, text }, ... ];`
2. Add `<script src="passages-ntpc.js"></script>` in `index.html`, right
   after the existing passages `<script>` lines (before `evaluators.js`).
3. If the exam's marking scheme is genuinely different (not just a
   different WPM cutoff), add a new entry to `EVALUATORS` in
   `evaluators.js` — see the DP HCM entry there for a full example of a
   non-DSSSB formula.
4. Add one entry to the `CATEGORIES` array in `categories.js`:
   ```js
   {
     id: "ntpc",
     title: "RRB NTPC Typing Test",
     subtitle: "...",
     description: "...",
     icon: "🚆",
     getPassages: () => PASSAGES_NTPC,
     evaluation: { type: "ntpc" /* + whatever fields your evaluator reads */ }
   }
   ```
That's it — no other file changes needed. A new card appears on the catalogue automatically, and every test taken inside it is graded with your new formula.

## Adding more passages to an existing category
Open that category's passages file (e.g. `passages.js` for DSSSB JSA,
`passages-dp-hcm.js` for DP HCM) and add more objects to its array,
following the existing format (`id`, `title`, `difficulty`, `text`).

## Per-exam scoring (evaluators.js)
Each category's `evaluation.type` points at an entry in `EVALUATORS`
(`evaluators.js`). An evaluator controls three things:
- Whether the exam grants half-mistake leniency (capitalization-only
  differences, adjacent-word transpositions) or scores every deviation
  as a full word-to-word error.
- The exact Net Speed formula (these are NOT all the same shape — see below).
- How pass/fail (and marks, if the exam uses a marks table) are decided.

**DSSSB / SSC** (`type: "dsssb"`):
- Half mistakes: yes (capitalization, transposition = 0.5 penalty each).
- **Net WPM** = (Total Words − (Error Units × 2)) ÷ Time, where Error Units = Full Mistakes + Half Mistakes × 0.5.
  (Confirmed against a real DSSSB Tribunal order: 395.6 words, 27 errors → 27×2=54 penalty → 341.6 net words → 34.16 wpm over 10 min — the penalty is doubled, not subtracted once.)
- Pass/fail against one qualifying WPM (default 35, overridable in Settings).

**Delhi Police HCM** (`type: "dp_hcm"`):
- Half mistakes: no — every wrong or omitted word is a full error, "word to word".
- **Net Speed** = Gross Speed (WPM) − Wrong Words Count (a flat subtraction,
  not divided by time again — deliberately different in shape from DSSSB).
- Attempts below the minimum keystroke count (1500 English / 1250 Hindi
  per the official notice) are disqualified outright.
- Marks come from the official WPM→marks band table (0/10/12/15/18/21/25),
  qualifying at 10+ of 25 marks — not a simple speed cutoff.

The comparison/diff engine itself (word alignment, resync after a
skip/insert/substitute) is shared by every exam — only how the resulting
mistakes get turned into a score differs, via `evaluators.js`.

## Speed & mistake formula (DSSSB-style, as an example)
- **Strokes** = total characters typed (including spaces) in the final submission.
- **Total Words** = Strokes ÷ 5
- **Full Mistake** (penalty 1.0): missing word, extra word, wrong/substituted word, repeated word.
- **Half Mistake** (penalty 0.5): capitalization-only difference, transposition of two adjacent words.
- **Net WPM** = (Total Words − Full Mistakes − Half Mistakes ÷ 2) ÷ Time (minutes)
- **Pass/Fail** is decided against the "Qualifying Net Speed" set in Settings (default 35 WPM).

The comparison engine uses **word-level sequence alignment** (Damerau-Levenshtein
edit distance — the same technique used by professional diff/typing tools). If a
candidate skips, adds, or mistypes a single word, only that one word is counted as
a mistake and the comparison automatically resynchronizes with the rest of the
passage — it does not cascade into flagging every subsequent word as wrong.

## Result dashboard
The result screen now shows an AZ-Typing-style breakdown: Net/Gross Speed,
Error %, Accuracy, Full/Half Mistakes, Omission Words, Error Units, Total
Penalty, Given vs Typed Keystrokes, Backspace Used, and a full step-by-step
"Show Complete Calculation" box using the current exam's own formula.

A **Weak Words Drill** section auto-extracts every word you got wrong
(wrong-word and capitalization mistakes) with a one-click "Copy Weak Words"
button, ready to paste into any custom-practice tool.

## Diagnostic Report
After a test, a **Diagnostic Report** section shows text-based tip cards
generated purely from that attempt's own mistakes (`diagnostics.js`) — no
heatmaps, no fake filler:
- **Most Confused Keys** — letter pairs you swap (e.g. B→D), from same-length wrong-word substitutions.
- **Weak Letter Combinations** — the 2-letter windows around those swaps.
- **Word Skipping**, **Capitalization Slips**, **Word Order Swaps** — counts pulled straight from the evaluator's own mistake classification.
- **Long Word Panic** — which >6-letter words tripped you up.
- **High Backspace Usage** — only shown when it's actually high (30+).

Cards only appear when there's real signal — a clean run shows no
Diagnostic Report section at all.

## Trailing Time-Over Leniency
When the timer runs out (or the test is submitted early), the passage
after your **last actually-typed word** was never attempted at all — that's
different from a word skipped in the *middle* of the passage while you kept
typing past it. Settings → "Trailing Time-Over Leniency" (on by default)
excludes only that genuinely-never-reached trailing stretch from Full
Mistakes / Error Units / Net Speed, showing it as a separate, clearly
non-penalized "Untyped (Time Over)" stat instead.

**A mid-passage skip always counts as a real mistake either way** — this
setting only affects the tail end you never got to, not gaps you typed
past. Turn it off to simulate the stricter reading (every missing word
counts, matching how a real DSSSB Tribunal order in this app's own
reference material treated a missed line).

## Custom Passage Practice
Home screen → "✏️ Custom Passage" opens a notepad-style textarea — paste
or type anything (your weak words list, a paragraph from a book, whatever
you want) and hit "Start Typing Test". It runs through the exact same
timer, evaluator, diagnostics, and results screen as any real passage,
scored with whichever category you're currently in. Your last draft is
remembered automatically even if you close the modal without starting.

## Exam Hall Ambience Sound
Settings → "Exam Hall Ambience" lets you upload your own recording (any
audio file) to loop quietly in the background for the whole test —
useful if you have a real exam-hall typing-noise recording and want to
practice with that distraction present. It's saved locally (as long as
it's under ~4MB) so you don't need to re-upload it each time, and has its
own volume slider plus a Preview button. It respects the master Sound
toggle — if Sound is off, ambience won't play either.

## Notes
- Fonts use system font stacks only (Consolas / Courier New "Notepad" / Segoe UI / Georgia) — no font files or CDNs needed, so it stays 100% offline.
- "Download All Passages (PDF)" and the single-result "Export PDF" both use Chrome's built-in print dialog (Save as PDF) — no PDF library required.
- All history and settings are saved in your browser's LocalStorage — specific
  to this browser/profile, not synced anywhere.
