/* ==========================================================================
   diagnostics.js
   ----------------------------------------------------------------------
   Turns a finished test's mistake data into readable diagnostic tips —
   which keys the candidate confuses, which letter combinations trip
   them up, how many words got skipped, etc. No heatmaps or charts, just
   text-based analysis, in the spirit of AZ Typing's diagnostic cards.

   This is a pure function: generateDiagnostics(result) -> diagnostics
   object. It reads result.diffRows (already computed by the evaluation
   engine in script.js) and does not touch the DOM or any app state, so
   it can be tested or reused independently.
   ========================================================================== */

function generateDiagnostics(result){
  const rows = result.diffRows || [];

  const wrongWordRows = rows.filter(row =>
    row.type && row.type.toLowerCase().includes("wrong word") &&
    row.expected !== "—" && row.typed !== "—"
  );

  // ---- Confused keys + weak letter combinations ----
  // Only meaningful when the expected and typed word are the same length
  // (a pure substitution) — a length mismatch is more about a dropped/
  // added letter than a "confused key", so those are left out of this
  // specific analysis rather than guessed at.
  const confusedKeyCounts = {};   // "B→D" -> count
  const bigramCounts = {};        // "TI" -> count

  wrongWordRows.forEach(row => {
    const exp = row.expected;
    const typ = row.typed;
    if(exp.length !== typ.length) return;

    for(let i = 0; i < exp.length; i++){
      const expCh = exp[i];
      const typCh = typ[i];
      if(expCh.toLowerCase() === typCh.toLowerCase()) continue;

      const keyPair = `${expCh.toUpperCase()}→${typCh.toUpperCase()}`;
      confusedKeyCounts[keyPair] = (confusedKeyCounts[keyPair] || 0) + 1;

      const start = Math.max(i - 1, 0);
      const bigram = exp.slice(start, start + 2).toUpperCase();
      if(bigram.length === 2){
        bigramCounts[bigram] = (bigramCounts[bigram] || 0) + 1;
      }
    }
  });

  const topEntries = (obj, n) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([label, count]) => ({ label, count }));

  // ---- Longest incorrect words ----
  const longestIncorrectWords = Array.from(new Set(wrongWordRows.map(r => r.expected)))
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);

  // ---- Category counts (already classified by the evaluator) ----
  const capitalizationCount = rows.filter(r => r.type.toLowerCase().includes("capitalization")).length;
  const transpositionCount = rows.filter(r => r.type.toLowerCase().includes("transposition")).length;
  const omissionCount = result.omissionWords || 0;
  const backspaceUsed = result.backspaceUsed || 0;

  return {
    confusedKeys: topEntries(confusedKeyCounts, 5),
    weakBigrams: topEntries(bigramCounts, 5),
    longestIncorrectWords,
    capitalizationCount,
    transpositionCount,
    omissionCount,
    backspaceUsed,
    totalWrongWords: wrongWordRows.length
  };
}

/* ---------------------------------------------------------------------
   Turns the raw diagnostics numbers into short, readable tip cards
   ({ title, icon, body, aiTip }). Only cards with real data are
   returned — script.js renders whatever comes back, nothing more.
   --------------------------------------------------------------------- */
function buildDiagnosticTips(diag){
  const tips = [];

  if(diag.confusedKeys.length > 0){
    const list = diag.confusedKeys.map(k => `${k.label} ×${k.count}`).join("  ");
    tips.push({
      icon: "🔁",
      title: "Most Confused Keys",
      body: `Aap inhi keys ko aapas me ulat rahe hain: ${list}`,
      aiTip: "In specific pairs ki drill karein — pehle slow, fir gradually fast."
    });
  }

  if(diag.weakBigrams.length > 0){
    const list = diag.weakBigrams.map(b => b.label).join("  ");
    tips.push({
      icon: "🔗",
      title: "Weak Letter Combinations",
      body: `Aap in jodon par atak rahe hain: ${list}`,
      aiTip: "In combos ko practice me daal kar flow banayein."
    });
  }

  if(diag.omissionCount > 0){
    tips.push({
      icon: "✂️",
      title: "Word Skipping",
      body: `${diag.omissionCount} word${diag.omissionCount > 1 ? "s" : ""} skip hue.`,
      aiTip: "Eyes original text par fix rakhein aur silently bol-bol kar type karein."
    });
  }

  if(diag.backspaceUsed > 30){
    tips.push({
      icon: "🔙",
      title: "High Backspace Usage",
      body: `${diag.backspaceUsed} baar backspace use kiya — real exam me time waste hoga.`,
      aiTip: "Speed 5% kam karo, accuracy zyada banao. Backspace temporarily bhool jao."
    });
  }

  if(diag.longestIncorrectWords.length > 0){
    const longOnes = diag.longestIncorrectWords.filter(w => w.replace(/[^\w]/g, "").length > 6);
    if(longOnes.length > 0){
      tips.push({
        icon: "📏",
        title: "Long Word Panic",
        body: `${longOnes.length} lambe word${longOnes.length > 1 ? "s" : ""} (>6 letters) me mistake: ${longOnes.join(", ")}`,
        aiTip: "Lambe words ko syllables me todo aur practice karo."
      });
    }
  }

  if(diag.capitalizationCount > 0){
    tips.push({
      icon: "🔤",
      title: "Capitalization Slips",
      body: `${diag.capitalizationCount} jagah letter case galat tha (jaise "the" ki jagah "The").`,
      aiTip: "Shift key ka timing practice karo — jaldi me case miss ho jata hai."
    });
  }

  if(diag.transpositionCount > 0){
    tips.push({
      icon: "🔀",
      title: "Word Order Swaps",
      body: `${diag.transpositionCount} jagah do adjacent words ulat gaye.`,
      aiTip: "Thoda dheere padho, ek time pe ek hi word par focus karo."
    });
  }

  return tips;
}
