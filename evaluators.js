/* ==========================================================================
   evaluators.js
   ----------------------------------------------------------------------
   Different exams score typing completely differently — not just
   different thresholds, but different FORMULAS:

     DSSSB/SSC   -> Net WPM = (Words − FullMistakes − HalfMistakes÷2) ÷ Time
                    capitalization & adjacent-word-swap count as HALF
                    mistakes. Pass/fail against one qualifying WPM.

     DP HCM      -> Net Speed = Gross WPM − Wrong Word Count (flat
                    subtraction, not time-divided). No half mistakes —
                    every wrong/omitted word is one full error. Scored
                    against a WPM→marks band table (0–25 marks), with a
                    minimum-keystroke rule that disqualifies short
                    attempts outright.

   Rather than hardcoding one formula everywhere, each exam CATEGORY
   (see categories.js) points at one entry in EVALUATORS by `type`. The
   test engine in script.js always goes through this file to compute
   net speed and decide pass/fail/marks — it never assumes DSSSB rules.

   HOW TO ADD A NEW EXAM'S SCORING (e.g. NTPC, AIIMS CRE)
   ----------------------------------------------------------------------
   1. Add a new key to EVALUATORS below, following the same shape:
        usesHalfMistakes  -> true/false
        computeNetSpeed(ctx)     -> returns the net WPM number
        describeCalculation(ctx) -> returns an array of strings, the
                                     step-by-step formula breakdown shown
                                     on the result screen
        evaluate(ctx)            -> returns { pass, marks, marksLabel, qualifyLabel }
   2. In categories.js, set that category's `evaluation.type` to your
      new key, plus whatever config fields your evaluate()/computeNetSpeed()
      read (qualifyWpm, marksTable, minKeystrokes, etc — anything you want).
   No other file needs to change — script.js reads whichever evaluator the
   current category points to.
   ========================================================================== */

const EVALUATORS = {

  /* ----------------------------------------------------------------------
     DSSSB / SSC (JSA, LDC, Grade-IV DASS, and similar) — the format this
     app started with. Continuous penalty formula, half mistakes exist,
     single qualifying-WPM threshold (overridable in Settings).
     ---------------------------------------------------------------------- */
  dsssb: {
    usesHalfMistakes: true,

    computeNetSpeed(ctx){
      const { totalWords, fullMistakes, halfMistakes, minutes } = ctx;
      // Official DSSSB formula (confirmed against a real DSSSB Tribunal
      // order: 395.6 words, 27 errors -> "27x2=54" penalty -> net words
      // 341.6 -> 34.16 wpm over 10 min). The error-unit penalty is
      // DOUBLED, not subtracted once.
      const errorUnits = fullMistakes + halfMistakes / 2;
      const netWords = Math.max(totalWords - errorUnits * 2, 0);
      return netWords / minutes;
    },

    describeCalculation(ctx){
      const { totalWords, fullMistakes, halfMistakes, minutes, netSpeed } = ctx;
      const errorUnits = fullMistakes + halfMistakes / 2;
      const netWords = Math.max(totalWords - errorUnits * 2, 0);
      return [
        `Gross Words = Typed Keystrokes ÷ 5 = ${totalWords.toFixed(2)}`,
        `Error Units = Full Mistakes (${fullMistakes}) + Half Mistakes (${halfMistakes} × 0.5) = ${errorUnits.toFixed(2)}`,
        `Penalty = Error Units × 2 = ${(errorUnits * 2).toFixed(2)}`,
        `Net Words = Gross Words − Penalty = ${totalWords.toFixed(2)} − ${(errorUnits * 2).toFixed(2)} = ${netWords.toFixed(2)}`,
        `Net Speed = Net Words ÷ Time (${minutes.toFixed(2)} min) = ${netSpeed.toFixed(2)} WPM`
      ];
    },

    evaluate(ctx){
      const { netSpeed, config, settings } = ctx;
      // A Settings-panel override always wins if the person has changed it;
      // otherwise fall back to the category's own default.
      const qualify = (settings && settings.qualifyWpm) || (config && config.qualifyWpm) || 35;
      const pass = netSpeed >= qualify;
      return {
        pass,
        marks: null,
        marksLabel: null,
        qualifyLabel: `Qualifying speed: ${qualify} WPM`
      };
    }
  },

  /* ----------------------------------------------------------------------
     Delhi Police HCM (Head Constable Ministerial) — word-to-word error
     counting only (no half mistakes), flat Net Speed formula, marks
     awarded from a WPM band table, and a minimum-keystroke rule that
     disqualifies attempts that are too short to grade fairly.
     ---------------------------------------------------------------------- */
  dp_hcm: {
    usesHalfMistakes: false,

    computeNetSpeed(ctx){
      const { grossWpm, fullMistakes } = ctx;
      // Official formula: Net Speed = Gross Speed − Wrong Words Count.
      // This is a flat subtraction of an error COUNT from the WPM value
      // (not divided by time again) — intentionally different in shape
      // from the DSSSB formula above.
      return Math.max(grossWpm - fullMistakes, 0);
    },

    describeCalculation(ctx){
      const { grossWpm, fullMistakes, minutes, netSpeed, totalWords } = ctx;
      return [
        `Gross Words = Typed Keystrokes ÷ 5 = ${totalWords.toFixed(2)}`,
        `Gross Speed = Gross Words ÷ Time (${minutes.toFixed(2)} min) = ${grossWpm.toFixed(2)} WPM`,
        `Wrong Words Count = ${fullMistakes}`,
        `Net Speed = Gross Speed − Wrong Words Count = ${grossWpm.toFixed(2)} − ${fullMistakes} = ${netSpeed.toFixed(2)} WPM`
      ];
    },

    evaluate(ctx){
      const { netSpeed, keystrokes, config } = ctx;
      const minKeystrokes = (config && config.minKeystrokes) || 0;

      if(keystrokes < minKeystrokes){
        return {
          pass: false,
          marks: 0,
          marksLabel: "Disqualified — below minimum keystroke count",
          qualifyLabel: `Minimum ${minKeystrokes} keystrokes required to be evaluated`
        };
      }

      const table = (config && config.marksTable) || [];
      const band = table.find(b => netSpeed >= b.min && netSpeed <= b.max);
      const marks = band ? band.marks : 0;
      const qualifyMarks = (config && config.qualifyMarks) || 0;

      return {
        pass: marks >= qualifyMarks && marks > 0,
        marks,
        marksLabel: marks > 0 ? `${marks} / 25 marks` : "Disqualified — below 30 WPM",
        qualifyLabel: `Minimum ${qualifyMarks} / 25 marks to qualify`
      };
    }
  }

  // Example shape for a future exam with its own rules (NTPC, AIIMS CRE, ...):
  //
  // ntpc: {
  //   usesHalfMistakes: false,
  //   computeNetSpeed(ctx){ ... },
  //   evaluate(ctx){ ... }
  // }
};
