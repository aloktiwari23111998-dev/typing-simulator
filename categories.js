/* ==========================================================================
   categories.js
   ----------------------------------------------------------------------
   The top-level "exam catalogue" shown on first load. Each entry is one
   exam, with its own passage set AND its own scoring rules. Clicking a
   category opens the normal passage-library screen scoped to just that
   exam's passages, and every test taken inside it is graded using the
   `evaluation` block below — see evaluators.js for what each
   `evaluation.type` actually computes (net speed formula, half-mistake
   rules, pass/fail vs. marks bands, minimum keystroke requirements, etc).

   HOW TO ADD A NEW EXAM CATEGORY LATER
   ----------------------------------------------------------------------
   1. Create a new passages file, e.g. passages-ntpc.js, following the
      exact same format as passages.js:
        const PASSAGES_NTPC = [ { id, title, difficulty, text }, ... ];
   2. Add a <script src="passages-ntpc.js"></script> tag in index.html,
      right after the existing passages.js / passages-dp-hcm.js tags.
   3. If the exam's marking scheme is new (not just a different
      threshold), add a matching entry to EVALUATORS in evaluators.js.
   4. Add one more object to the CATEGORIES array below, pointing
      getPassages() at that new array and evaluation.type at the right
      evaluator.

   That's it — no other file needs to change. The home screen, search,
   test engine, results, and "Download All Passages (PDF)" all read from
   whichever category is currently open, including how it's scored.
   ========================================================================== */

const CATEGORIES = [
  {
    id: "dsssb_jsa",
    title: "DSSSB JSA Typing Test",
    subtitle: "240 passages · Official DSSSB pattern",
    description: "Practice the exact passage format and DSSSB net-speed formula used in the real Grade-IV DASS / JSA / LDC skill test.",
    icon: "🏛️",
    getPassages: () => PASSAGES,
    evaluation: {
      type: "dsssb",
      qualifyWpm: 35   // overridable per-attempt via Settings -> Qualifying Net Speed
    }
  },

  {
    id: "dp_hcm",
    title: "Delhi Police HCM Typing Test",
    subtitle: "2000/2500 keystrokes · Word-to-word marking",
    description: "Attempt the Delhi Police Head Constable Ministerial (HCM) format — whole-word error counting and the official 0-25 marks band, not a simple pass/fail line.",
    icon: "🚓",
    getPassages: () => PASSAGES_DP_HCM,
    evaluation: {
      type: "dp_hcm",
      minKeystrokes: 1500,     // English minimum; below this the attempt is disqualified
      qualifyMarks: 10,        // must score at least 10 of 25 marks to qualify
      marksTable: [
        { min: 0,  max: 29.999,   marks: 0  },
        { min: 30, max: 30.999,   marks: 10 },
        { min: 31, max: 35.999,   marks: 12 },
        { min: 36, max: 40.999,   marks: 15 },
        { min: 41, max: 45.999,   marks: 18 },
        { min: 46, max: 50.999,   marks: 21 },
        { min: 51, max: Infinity, marks: 25 }
      ]
    }
  },

  {
    id: "dsssb_mitra",
    title: "Typing Mitra DSSSB",
    subtitle: "358 passages · Official DSSSB evaluation",
    description: "Typing Mitra DSSSB passages, scored with the same official DSSSB net-speed formula as the main JSA set — a second, larger passage pool for extra variety.",
    icon: "⌨️",
    getPassages: () => PASSAGES_DSSSB_MITRA,
    evaluation: {
      type: "dsssb",
      qualifyWpm: 35
    }
  },

  {
    id: "dsssb_new",
    title: "DSSSB New Typing",
    subtitle: "23 passages · Official DSSSB evaluation",
    description: "A fresh set of current-affairs passages in the official DSSSB pattern, scored with the same net-speed formula as the main JSA set.",
    icon: "🆕",
    getPassages: () => PASSAGES_DSSSB_NEW,
    evaluation: {
      type: "dsssb",
      qualifyWpm: 35
    }
  }

  // Example of a future category with its own scoring rules (NTPC, AIIMS
  // CRE, etc.) — add its evaluator to evaluators.js first, then point at
  // it here the same way DP HCM does above:
  //
  // {
  //   id: "ntpc",
  //   title: "RRB NTPC Typing Test",
  //   subtitle: "... passages",
  //   description: "...",
  //   icon: "🚆",
  //   getPassages: () => PASSAGES_NTPC,
  //   evaluation: { type: "ntpc", /* ...whatever fields your evaluator reads... */ }
  // }
];
