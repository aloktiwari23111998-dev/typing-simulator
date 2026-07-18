/* ==========================================================================
   script.js — Typing Test Simulator
   100% vanilla JS. No build step, no network calls.

   SECTIONS
   1. Settings & persistence
   2. App state
   3. Home screen (render, search, navigation)
   4. Test screen (timer, keystroke handling, live stats, diff engine)
   5. Result screen (final calculations, comparison, error table, export)
   6. Settings modal wiring
   7. Boot
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. SETTINGS & PERSISTENCE
   -------------------------------------------------------------------------- */
const STORAGE_KEYS = {
  settings: "ts_settings_v1",
  history:  "ts_history_v1",
  customPassage: "ts_custom_passage_v1",
  ambienceAudio: "ts_ambience_audio_v1"
};

const DEFAULT_SETTINGS = {
  theme: "dark",
  mode: "screen",          // "screen" | "paper"
  timerMinutes: 10,
  backspace: "enabled",    // "enabled" | "disabled"
  qualifyWpm: 35,
  passageFontSize: 18,
  typingFontSize: 18,
  fontFamily: "mono",      // "mono" | "notepad" | "sans" | "serif"
  autoHighlight: "on",     // "on" | "off" — live correct/incorrect coloring in passage pane
  trailingLeniency: "on",  // "on" | "off" — don't penalize the trailing stretch never reached before time ran out (mid-passage skips still always count)
  sound: "on",
  ambience: "off",         // "on" | "off" — play the user's own exam-hall recording during a test
  ambienceVolume: 30,      // 0-100
  examInterface: "off",    // "off" | "on" — visual-only NTA/TCS government CBT skin (Exam Interface setting)
  autoScrollPassage: "on"  // "on" | "off" — auto-scroll the passage pane to keep the current word visible while typing
};

function loadSettings(){
  try{
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if(!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  }catch(e){
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings){
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function loadHistory(){
  try{
    const raw = localStorage.getItem(STORAGE_KEYS.history);
    return raw ? JSON.parse(raw) : [];
  }catch(e){
    return [];
  }
}

function saveHistoryEntry(entry){
  const history = loadHistory();
  history.unshift(entry); // newest first
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history.slice(0, 500)));
}

function clearHistory(){
  localStorage.removeItem(STORAGE_KEYS.history);
}

/* ---------------------------------------------------------------------
   Custom passage text — just remembers whatever was last pasted into
   the Custom Passage modal, so it's not lost if the modal is closed.
   --------------------------------------------------------------------- */
function loadCustomPassageDraft(){
  try{
    const raw = localStorage.getItem(STORAGE_KEYS.customPassage);
    return raw ? JSON.parse(raw) : { title: "", text: "" };
  }catch(e){
    return { title: "", text: "" };
  }
}

function saveCustomPassageDraft(title, text){
  try{
    localStorage.setItem(STORAGE_KEYS.customPassage, JSON.stringify({ title, text }));
  }catch(e){ /* storage full or unavailable — draft just won't persist */ }
}

/* ---------------------------------------------------------------------
   Exam-hall ambience audio — the person's own recording, stored as a
   base64 data URL so it survives a page reload without re-uploading.
   Kept in its own localStorage key (not the settings blob) since audio
   can be sizeable.
   --------------------------------------------------------------------- */
function loadAmbienceAudio(){
  try{
    return localStorage.getItem(STORAGE_KEYS.ambienceAudio);
  }catch(e){
    return null;
  }
}

function saveAmbienceAudio(dataUrl){
  try{
    localStorage.setItem(STORAGE_KEYS.ambienceAudio, dataUrl);
    return true;
  }catch(e){
    return false; // likely over quota — caller should fall back to session-only playback
  }
}

function clearAmbienceAudio(){
  localStorage.removeItem(STORAGE_KEYS.ambienceAudio);
}

/* --------------------------------------------------------------------------
   2. APP STATE
   -------------------------------------------------------------------------- */
const state = {
  settings: loadSettings(),
  currentCategory: null,
  currentPassage: null,
  timerId: null,
  countdownId: null,
  remainingSeconds: 0,
  elapsedSeconds: 0,
  startTimestamp: null,
  hasStartedTyping: false,
  finished: false,
  backspaceCount: 0,
  lastResult: null,
  ambienceAudioEl: null,     // the <audio> element used during a running test
  ambienceStagedDataUrl: null // freshly-picked file, not yet confirmed/saved
};

// Returns the passage array for whichever exam category is currently open,
// falling back to the global PASSAGES if somehow none is selected yet.
function getCurrentPassages(){
  return state.currentCategory ? state.currentCategory.getPassages() : PASSAGES;
}

// Returns the scoring engine (from evaluators.js) for whichever exam
// category is currently open, falling back to the DSSSB formula if a
// category hasn't set one (keeps older/incomplete category configs safe).
function getCurrentEvaluator(){
  const type = state.currentCategory && state.currentCategory.evaluation
    ? state.currentCategory.evaluation.type
    : "dsssb";
  return EVALUATORS[type] || EVALUATORS.dsssb;
}

function getCurrentEvaluationConfig(){
  return (state.currentCategory && state.currentCategory.evaluation) || {};
}

/* --------------------------------------------------------------------------
   Utility helpers
   -------------------------------------------------------------------------- */
function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }

function formatTime(totalSeconds){
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// Splits a passage into words on any whitespace, dropping empty tokens.
function tokenize(text){
  return (text || "").trim().split(/\s+/).filter(w => w.length > 0);
}

function countCharacters(text){
  return (text || "").length;
}

function fontFamilyValue(key){
  if(key === "notepad") return "var(--font-notepad)";
  if(key === "sans") return "var(--font-sans)";
  if(key === "serif") return "var(--font-serif)";
  return "var(--font-mono)";
}

// Minimal offline beep using Web Audio API — no external sound files needed.
let audioCtx = null;
function beep(freq = 440, durationMs = 90){
  if(state.settings.sound !== "on") return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  }catch(e){ /* audio not available — fail silently */ }
}

// Short mechanical-key "click" played on every keystroke to simulate the
// ambient sound of an exam hall full of typists. Slight random pitch/decay
// variation per call keeps it from sounding like a repeated loop.
function keyClickSound(){
  if(state.settings.sound !== "on") return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    osc.type = "square";
    osc.frequency.value = 1600 + Math.random() * 500;
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.035);
  }catch(e){ /* audio not available — fail silently */ }
}

/* ---------------------------------------------------------------------
   Exam-hall ambience — loops the person's own uploaded recording quietly
   in the background for the duration of a test. Separate from the UI
   beep/click sounds above; obeys the master Sound toggle too (if sound
   is off entirely, ambience never plays regardless of its own setting).
   --------------------------------------------------------------------- */
function startAmbience(){
  if(state.settings.sound !== "on" || state.settings.ambience !== "on") return;
  // Prefer whatever's persisted in localStorage; if the file was too big
  // to save (or saving failed), fall back to the in-memory session URL
  // from this page load so it still plays even though it won't survive
  // a reload.
  const src = loadAmbienceAudio() || state.ambienceStagedDataUrl;
  if(!src) return;
  try{
    stopAmbience();
    const audio = new Audio(src);
    audio.loop = true;
    audio.volume = Math.max(0, Math.min(state.settings.ambienceVolume / 100, 1));
    audio.play().catch(() => { /* blocked by autoplay policy — ignore */ });
    state.ambienceAudioEl = audio;
  }catch(e){ /* ignore — ambience is a nice-to-have, never block the test */ }
}

function stopAmbience(){
  if(state.ambienceAudioEl){
    try{ state.ambienceAudioEl.pause(); }catch(e){ /* ignore */ }
    state.ambienceAudioEl = null;
  }
}

// Used only by the Settings-panel "Preview" button — plays a few seconds
// of whichever file is currently staged/saved, independent of test state.
let previewAudioEl = null;
function previewAmbience(dataUrl){
  try{
    if(previewAudioEl){ previewAudioEl.pause(); previewAudioEl = null; }
    if(!dataUrl) return;
    previewAudioEl = new Audio(dataUrl);
    previewAudioEl.volume = Math.max(0, Math.min(state.settings.ambienceVolume / 100, 1));
    previewAudioEl.play().catch(() => {});
  }catch(e){ /* ignore */ }
}

/* --------------------------------------------------------------------------
   3. CATEGORY CATALOGUE + HOME SCREEN
   -------------------------------------------------------------------------- */
function renderCategoryGrid(){
  const grid = $("#categoryGrid");
  grid.innerHTML = "";
  $("#categoryCount").textContent = `${CATEGORIES.length} categor${CATEGORIES.length !== 1 ? "ies" : "y"}`;

  CATEGORIES.forEach(cat => {
    const count = cat.getPassages().length;
    const card = document.createElement("div");
    card.className = "category-card";
    card.innerHTML = `
      <div class="cc-icon">${cat.icon || "📝"}</div>
      <div class="cc-subtitle">${escapeHtml(cat.subtitle || `${count} passages`)}</div>
      <h3 class="cc-title">${escapeHtml(cat.title)}</h3>
      <p class="cc-desc">${escapeHtml(cat.description || "")}</p>
      <button class="cc-start" data-id="${cat.id}">Start Practice →</button>
    `;
    grid.appendChild(card);
  });

  $all(".cc-start").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = CATEGORIES.find(c => c.id === btn.dataset.id);
      if(cat) openCategory(cat);
    });
  });
}

function openCategory(category){
  state.currentCategory = category;
  $("#categoryHeroTitle").textContent = category.title;
  $("#categoryHeroSub").textContent = category.description || "Offline practice — no timer tricks, no internet dependency.";
  $("#searchBox").value = "";

  $("#catalogueScreen").hidden = true;
  $("#homeScreen").hidden = false;

  renderDashboardStats();
  renderPassageGrid();
}

function goToCatalogue(){
  stopAllTimers();
  $("#testScreen").hidden = true;
  $("#resultScreen").hidden = true;
  $("#homeScreen").hidden = true;
  $("#topnav").hidden = false;
  $("#catalogueScreen").hidden = false;
  renderCategoryGrid();
}

function renderPassageGrid(filterText = ""){
  const grid = $("#passageGrid");
  grid.innerHTML = "";

  const passages = getCurrentPassages();
  const filtered = passages.filter(p => {
    const q = filterText.trim().toLowerCase();
    if(!q) return true;
    return p.title.toLowerCase().includes(q) || p.difficulty.toLowerCase().includes(q);
  });

  $("#passageCount").textContent = `${filtered.length} passage${filtered.length !== 1 ? "s" : ""}`;

  filtered.forEach(p => {
    const words = tokenize(p.text).length;
    const chars = countCharacters(p.text);

    const card = document.createElement("div");
    card.className = "passage-card";
    card.innerHTML = `
      <div class="pc-top">
        <span class="pc-num">#${p.id}</span>
        <span class="pc-diff ${p.difficulty}">${p.difficulty}</span>
      </div>
      <h3 class="pc-title">${p.title}</h3>
      <div class="pc-meta">
        <span>${words} words</span>
        <span>${chars} chars</span>
      </div>
      <button class="pc-start" data-id="${p.id}">Start ▶</button>
    `;
    grid.appendChild(card);
  });

  $all(".pc-start").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = parseInt(btn.dataset.id, 10);
      const passage = getCurrentPassages().find(p => p.id === id);
      if(passage) startTest(passage);
    });
  });
}

function renderDashboardStats(){
  const history = loadHistory();
  $("#statRecent").textContent = history.length;

  if(history.length === 0){
    $("#statBest").textContent = "0";
    $("#statAvgWpm").textContent = "0";
    $("#statAvgAcc").textContent = "0%";
    return;
  }

  const best = Math.max(...history.map(h => h.netWpm));
  const avgWpm = history.reduce((s, h) => s + h.netWpm, 0) / history.length;
  const avgAcc = history.reduce((s, h) => s + h.accuracy, 0) / history.length;

  $("#statBest").textContent = best.toFixed(0);
  $("#statAvgWpm").textContent = avgWpm.toFixed(1);
  $("#statAvgAcc").textContent = avgAcc.toFixed(1) + "%";
}

function goHome(){
  stopAllTimers();
  $("#testScreen").hidden = true;
  $("#resultScreen").hidden = true;
  $("#topnav").hidden = false;
  $("#homeScreen").hidden = false;
  renderDashboardStats();
  renderPassageGrid($("#searchBox").value);
}

/* --------------------------------------------------------------------------
   4. TEST SCREEN
   -------------------------------------------------------------------------- */
function applyTypographySettings(){
  const s = state.settings;
  $("#passageText").style.fontSize = s.passageFontSize + "px";
  $("#typingArea").style.fontSize = s.typingFontSize + "px";
  const ff = fontFamilyValue(s.fontFamily);
  $("#passageText").style.fontFamily = ff;
  $("#typingArea").style.fontFamily = ff;
}

function startTest(passage){
  state.currentPassage = passage;
  state.hasStartedTyping = false;
  state.finished = false;
  state.elapsedSeconds = 0;
  state.remainingSeconds = state.settings.timerMinutes * 60;
  state.backspaceCount = 0;
  startAmbience();

  $("#homeScreen").hidden = true;
  $("#resultScreen").hidden = true;
  $("#topnav").hidden = true;
  $("#testScreen").hidden = false;

  $("#testTitle").textContent = passage.title;
  $("#ntaGovTitle").textContent = passage.title;
  $("#typingArea").value = "";
  $("#typingArea").disabled = false;
  $("#liveTimer").textContent = formatTime(state.remainingSeconds);
  $("#ntaTimeLeft").textContent = formatTime(state.remainingSeconds);
  $("#liveGross").textContent = "0";
  $("#liveNet").textContent = "0";
  $("#liveAcc").textContent = "100%";
  $("#liveMistakes").textContent = "0";
  $("#progressFill").style.width = "0%";

  applyTypographySettings();
  if(state.settings.examInterface === "on"){
    $("#passageText").style.fontSize = "20px";
    $("#typingArea").style.fontSize = "18px";
  }
  resetPassageAutoScroll();
  buildPassageDom(passage.text);
  updateTypingProgress(passage.text, "");

  const isPaper = state.settings.mode === "paper";
  $("#paperScreenNotice").hidden = !isPaper;

  if(isPaper){
    $("#passagePane").hidden = false;
    $("#typingArea").disabled = true; // block early typing while passage is being read
    runCountdown(10, () => {
      $("#passagePane").hidden = true; // fully removed from layout, not just invisible
      $("#typingArea").disabled = false;
      focusTypingArea();
    });
  }else{
    $("#passagePane").hidden = false;
    focusTypingArea();
  }
}

function focusTypingArea(){
  setTimeout(() => $("#typingArea").focus(), 50);
}

function runCountdown(seconds, onDone){
  const overlay = $("#countdownOverlay");
  overlay.hidden = false;
  overlay.classList.add("countdown-mode");
  let remaining = seconds;
  $("#countdownNumber").textContent = remaining;
  state.countdownId = setInterval(() => {
    remaining -= 1;
    if(remaining <= 0){
      clearInterval(state.countdownId);
      overlay.hidden = true;
      overlay.classList.remove("countdown-mode");
      onDone();
    }else{
      $("#countdownNumber").textContent = remaining;
    }
  }, 1000);
}

// Builds the passage's word-span DOM exactly ONCE per test. Stable
// element references are kept in state.passageWordEls so every
// subsequent keystroke only toggles className on existing nodes —
// nothing is torn down and rebuilt, so an in-flight scroll animation or
// a Range-API measurement is never disrupted by a DOM replacement.
function buildPassageDom(originalText){
  const expectedWords = tokenize(originalText);
  const frag = document.createDocumentFragment();
  const els = [];
  expectedWords.forEach((word, i) => {
    if(i > 0) frag.appendChild(document.createTextNode(" "));
    const span = document.createElement("span");
    span.className = "word pending";
    span.textContent = word;
    frag.appendChild(span);
    els.push(span);
  });
  const passageTextEl = $("#passageText");
  passageTextEl.innerHTML = "";
  passageTextEl.appendChild(frag);
  state.passageWordEls = els;
  state.passageExpectedWords = expectedWords;
}

// Renders live typing progress by toggling className on the already-
// built word spans (see buildPassageDom) — never rebuilds the DOM.
function updateTypingProgress(originalText, typedText){
  // Auto Scroll needs a stable '.word.current' DOM anchor to measure the
  // active typing position via the Range API — that anchor must exist
  // regardless of the autoHighlight preference, otherwise turning off
  // live correct/incorrect coloring would silently disable auto-scroll
  // too (they are unrelated features and must not be coupled).
  const highlightOn = state.settings.autoHighlight !== "off";

  const expectedWords = state.passageExpectedWords || tokenize(originalText);
  const wordEls = state.passageWordEls;
  if(!wordEls || wordEls.length !== expectedWords.length){
    buildPassageDom(originalText); // safety net if called before build
  }

  const typedWords = typedText.length ? typedText.trim().split(/\s+/) : [];
  const currentIndex = typedText.endsWith(" ") || typedText.length === 0
    ? typedWords.length
    : Math.max(typedWords.length - 1, 0);

  for(let i = 0; i < state.passageWordEls.length; i++){
    const word = expectedWords[i];
    let cls;
    if(highlightOn){
      cls = "word pending";
      if(i < currentIndex){
        cls = (typedWords[i] === word) ? "word correct" : "word incorrect";
      }else if(i === currentIndex){
        cls = "word current";
      }
    } else {
      // No live feedback, matching a real exam sheet with no on-screen
      // assistance — every word stays visually neutral ("plain"), but
      // the current word is still tagged so Auto Scroll can find it.
      cls = (i === currentIndex) ? "word plain current" : "word plain";
    }
    const el = state.passageWordEls[i];
    if(el.className !== cls) el.className = cls; // skip no-op writes
  }

  // How many characters into the active word the caret currently sits —
  // needed to pinpoint the exact active CHARACTER (not just the word)
  // via the Range API below.
  const typedInCurrentWord = (typedText.endsWith(" ") || typedText.length === 0)
    ? 0
    : (typedWords[typedWords.length - 1] || "").length;

  updatePassageAutoScroll(typedInCurrentWord, currentIndex);
}

/* ---------------------------------------------------------------------
   Auto Scroll Passage — reverse-engineered frame-by-frame from the
   official DSSSB/NTA/TCS reference recording (30fps analysis):
     - A scroll event's motion profile measured from the video: 0 → 3 →
       20 → 31 → 39 → 45 → 47 → 49px over ~200ms — a decelerating
       (ease-out) curve, NOT an instant cut and NOT a linear scroll.
     - The jump size (~49px against a ~30px rendered line-height, i.e.
       ~1.6 lines) is not a clean single-line multiple — it behaves like
       the active line being brought to a comfortable resting position
       within the box, not a fixed one-line increment.
     - The passage stays completely still while the active character is
       comfortably inside the visible box; it animates only once the
       active character is no longer comfortably in view.
     - Only the passage container's own scrollTop is touched (native
       scrollTop, not a transform/virtual-viewport) — this preserves
       native wheel/scrollbar-drag manual scrolling for free, which a
       transform-based viewport would have to reimplement from scratch.
     - The animation is a short, bounded rAF loop (~220ms) — not a
       continuous/polling loop — triggered only on a genuine line
       transition, then it stops.
     - The active character's rendered line is read via the Range API
       against STABLE word-span DOM nodes (built once per test — see
       buildPassageDom) — never from character/word/newline counting,
       and never disrupted by a mid-animation DOM rebuild.
     - Manual scrolling (wheel / scrollbar drag) immediately pauses
       auto-scroll; it resumes once the typing position is back in view,
       resyncing so it doesn't jump.
     - If the setting is OFF, this never touches scrollTop at all.
   --------------------------------------------------------------------- */
let passageAutoScrollPaused = false;
let passageAutoScrollLastLine = -1;
let passageAutoScrollListenersBound = false;
let passageAutoScrollAnimId = null;

function getPassageScrollEl(){
  const textEl = $("#passageText");
  const overflowY = getComputedStyle(textEl).overflowY;
  if(overflowY === "auto" || overflowY === "scroll") return textEl;
  return $("#passagePane");
}

// Bound once — wheel/pointerdown on either candidate scroll element means
// the person is manually scrolling, regardless of which one is active in
// the current visual mode.
function bindPassageManualScrollPause(){
  if(passageAutoScrollListenersBound) return;
  passageAutoScrollListenersBound = true;
  ["#passageText", "#passagePane"].forEach(sel => {
    const el = $(sel);
    if(!el) return;
    el.addEventListener("wheel", () => { passageAutoScrollPaused = true; }, { passive: true });
    el.addEventListener("pointerdown", () => { passageAutoScrollPaused = true; }, { passive: true });
  });
}

function resetPassageAutoScroll(){
  bindPassageManualScrollPause();
  if(passageAutoScrollAnimId) cancelAnimationFrame(passageAutoScrollAnimId);
  passageAutoScrollAnimId = null;
  passageAutoScrollPaused = false;
  passageAutoScrollLastLine = -1;
  const el = getPassageScrollEl();
  if(el) el.scrollTop = 0;
}

// Pinpoints the exact rendered position of the ACTIVE CHARACTER (the
// next character the candidate is about to type) using the Range API,
// rather than inferring it from the whole current-word <span>. The
// current-word span's only child is a plain text node; a one-character
// Range placed at the caret's offset inside that text node, read via
// getClientRects(), gives the real on-screen position of that exact
// character — independent of word-level assumptions.
function getActiveCharRect(currentWordEl, typedInWord){
  const textNode = currentWordEl.firstChild;
  if(!textNode || textNode.nodeType !== Node.TEXT_NODE){
    return currentWordEl.getBoundingClientRect();
  }
  const len = textNode.textContent.length;
  if(len === 0) return currentWordEl.getBoundingClientRect();

  let start = Math.min(Math.max(typedInWord, 0), len);
  let end = Math.min(start + 1, len);
  if(start === end) start = Math.max(end - 1, 0); // caret sits right after the last character

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = range.getClientRects();
  return rects.length ? rects[0] : currentWordEl.getBoundingClientRect();
}

function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }

// Short, bounded rAF animation of scrollTop from wherever it currently
// is to `target`, over `duration` ms with an ease-out curve — matches
// the decelerating motion profile measured from the reference video.
// Not a continuous/polling loop: it runs only for `duration` ms per
// trigger, then stops itself.
function animateScrollTop(el, target, duration){
  if(passageAutoScrollAnimId) cancelAnimationFrame(passageAutoScrollAnimId);
  const start = el.scrollTop;
  const delta = target - start;
  if(Math.abs(delta) < 0.5){ el.scrollTop = target; return; }
  const startTime = performance.now();

  function step(now){
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    el.scrollTop = start + delta * easeOutCubic(t);
    if(t < 1){
      passageAutoScrollAnimId = requestAnimationFrame(step);
    } else {
      passageAutoScrollAnimId = null;
    }
  }
  passageAutoScrollAnimId = requestAnimationFrame(step);
}

function updatePassageAutoScroll(typedInCurrentWord, currentWordIndex){
  if(state.settings.autoScrollPassage !== "on") return;

  const scrollEl = getPassageScrollEl();
  const current = state.passageWordEls && state.passageWordEls[currentWordIndex];
  if(!scrollEl || !current) return;

  const textEl = $("#passageText");
  const lineHeight = parseFloat(getComputedStyle(textEl).lineHeight);
  if(!lineHeight || Number.isNaN(lineHeight)) return;

  const scrollElRect = scrollEl.getBoundingClientRect();
  const charRect = getActiveCharRect(current, typedInCurrentWord || 0);

  if(passageAutoScrollPaused){
    // Resume automatically once the typing position is back in view —
    // i.e. the person scrolled back to roughly where they're typing.
    const EPS = 1; // px tolerance — strict rect comparisons can fail to ever
                   // satisfy due to sub-pixel rounding, permanently stuck paused
    const backInView = charRect.top >= scrollElRect.top - EPS && charRect.bottom <= scrollElRect.bottom + EPS;
    if(!backInView) return;
    passageAutoScrollPaused = false;
  }

  // Which rendered line (0-based, as the browser actually laid it out)
  // the active character sits on — read purely from layout via Range API.
  const charTopInContent = (charRect.top - scrollElRect.top) + scrollEl.scrollTop;
  const currentLine = Math.round(charTopInContent / lineHeight);
  if(currentLine === passageAutoScrollLastLine) return; // still the same line — never scroll mid-line
  passageAutoScrollLastLine = currentLine;

  // Comfortable "safe zone": the active line only needs to scroll once
  // it gets within one line-height of the bottom edge (or above the top
  // entirely, e.g. after backspacing) — matching the reference, which
  // doesn't move on every single line, only when the line is about to
  // run out of room.
  const nearBottom = charRect.bottom > scrollElRect.bottom - lineHeight;
  const aboveTop = charRect.top < scrollElRect.top;
  if(!nearBottom && !aboveTop) return;

  // Target: bring the active line to a comfortable resting position —
  // roughly centered in the box, leaving room both above and below —
  // matching the reference's non-integer, "settles into place" jump
  // rather than a rigid one-line increment.
  const target = Math.max(0, charTopInContent - scrollEl.clientHeight / 2 + lineHeight / 2);
  animateScrollTop(scrollEl, target, 220);
}

function escapeHtml(str){
  return str.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function startMainTimer(){
  state.startTimestamp = Date.now();
  state.timerId = setInterval(() => {
    state.remainingSeconds -= 1;
    state.elapsedSeconds += 1;
    $("#liveTimer").textContent = formatTime(Math.max(state.remainingSeconds, 0));
    $("#ntaTimeLeft").textContent = formatTime(Math.max(state.remainingSeconds, 0));
    updateLiveStats();
    if(state.remainingSeconds <= 0){
      finishTest("timeout");
    }
  }, 1000);
}

function stopAllTimers(){
  if(state.timerId){ clearInterval(state.timerId); state.timerId = null; }
  if(state.countdownId){ clearInterval(state.countdownId); state.countdownId = null; }
  stopAmbience();
  // Guard against a paper-mode countdown being left on screen if the user
  // exits/restarts mid-countdown — without this it stays frozen forever.
  const overlay = $("#countdownOverlay");
  overlay.hidden = true;
  overlay.classList.remove("countdown-mode");
}

function updateLiveStats(){
  const passage = state.currentPassage;
  if(!passage) return;
  const typedText = $("#typingArea").value;
  const minutesElapsed = Math.max(state.elapsedSeconds / 60, 1/60);

  const strokes = countCharacters(typedText);
  const totalWords = strokes / 5;
  const grossWpm = totalWords / minutesElapsed;

  const evaluator = getCurrentEvaluator();
  const diff = computeDiff(passage.text, typedText, { liveMode: true, halfMistakesEnabled: evaluator.usesHalfMistakes });
  const netWpm = evaluator.computeNetSpeed({
    totalWords, grossWpm, minutes: minutesElapsed,
    fullMistakes: diff.fullMistakes, halfMistakes: diff.halfMistakes
  });
  const comparedCount = Math.max(diff.comparedCount, 1);
  const accuracy = Math.max(
    ((comparedCount - diff.fullMistakes - diff.halfMistakes) / comparedCount) * 100,
    0
  );

  $("#liveGross").textContent = grossWpm.toFixed(0);
  $("#liveNet").textContent = netWpm.toFixed(0);
  $("#liveAcc").textContent = accuracy.toFixed(0) + "%";
  $("#liveMistakes").textContent = (diff.fullMistakes + diff.halfMistakes).toString();

  const expectedWordCount = tokenize(passage.text).length;
  const typedWordCount = typedText.trim().length ? typedText.trim().split(/\s+/).length : 0;
  const progress = Math.min((typedWordCount / expectedWordCount) * 100, 100);
  $("#progressFill").style.width = progress + "%";

  if(state.settings.mode === "screen"){
    updateTypingProgress(passage.text, typedText);
  }
}

/* ---------------------------------------------------------------------
   WORD ALIGNMENT — Damerau-Levenshtein sequence alignment between the
   expected passage and what the candidate typed.

   Why: a naive index-by-index comparison (expected[i] vs typed[i]) falls
   apart the moment a single word is skipped, added, or mistyped-with-
   extra-letters — every following word shifts out of alignment and gets
   flagged wrong, even though the candidate typed the rest correctly.

   This resolves that by finding the minimum-cost edit path (match /
   substitute / insert / delete / adjacent-transpose) between the two
   word sequences, the same technique professional typing evaluators
   (and diff tools generally) use. A single omitted word costs exactly
   one operation and the alignment resynchronizes immediately after it —
   it does not cascade into the rest of the passage.

   Costs (chosen so the DP naturally prefers the "real" edit over noise):
     match                 -> 0
     capitalization-only   -> 0.5  (keeps them paired instead of split
                                     into a delete+insert)
     substitution (wrong)  -> 1
     insertion (extra word)-> 1
     deletion (missing word)-> 1
     adjacent transposition -> 1   (two neighbouring words swapped)
   --------------------------------------------------------------------- */
function wordCost(expWord, typWord){
  if(expWord === typWord) return 0;
  if(expWord.toLowerCase() === typWord.toLowerCase()) return 0.5;
  return 1;
}

function alignWords(expected, typed){
  const n = expected.length;
  const m = typed.length;

  const dp = new Array(n + 1);
  for(let i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
  for(let i = 0; i <= n; i++) dp[i][0] = i;
  for(let j = 0; j <= m; j++) dp[0][j] = j;

  for(let i = 1; i <= n; i++){
    const expWord = expected[i - 1];
    for(let j = 1; j <= m; j++){
      const typWord = typed[j - 1];
      let best = dp[i - 1][j - 1] + wordCost(expWord, typWord); // match/substitute
      const del = dp[i - 1][j] + 1;   // expected word not typed
      const ins = dp[i][j - 1] + 1;   // typed word not in passage
      if(del < best) best = del;
      if(ins < best) best = ins;

      // Adjacent transposition: the two previous words are swapped.
      if(i > 1 && j > 1 && expWord === typed[j - 2] && expected[i - 2] === typWord){
        const trans = dp[i - 2][j - 2] + 1;
        if(trans < best) best = trans;
      }
      dp[i][j] = best;
    }
  }

  // Traceback: walk the matrix from the end to reconstruct the actual
  // sequence of operations that produced the minimum cost.
  const ops = [];
  let i = n, j = m;
  const close = (a, b) => Math.abs(a - b) < 1e-9;

  while(i > 0 || j > 0){
    if(i > 1 && j > 1 &&
       expected[i - 1] === typed[j - 2] && expected[i - 2] === typed[j - 1] &&
       close(dp[i][j], dp[i - 2][j - 2] + 1)){
      ops.push({ type: "transpose", expIndex: i - 2, typIndex: j - 2 });
      i -= 2; j -= 2;
      continue;
    }
    if(i > 0 && j > 0 && close(dp[i][j], dp[i - 1][j - 1] + wordCost(expected[i - 1], typed[j - 1]))){
      const cost = wordCost(expected[i - 1], typed[j - 1]);
      const type = cost === 0 ? "match" : (cost === 0.5 ? "half-case" : "sub");
      ops.push({ type, expIndex: i - 1, typIndex: j - 1 });
      i -= 1; j -= 1;
      continue;
    }
    if(i > 0 && close(dp[i][j], dp[i - 1][j] + 1)){
      ops.push({ type: "del", expIndex: i - 1, typIndex: null });
      i -= 1;
      continue;
    }
    ops.push({ type: "ins", expIndex: null, typIndex: j - 1 });
    j -= 1;
  }

  ops.reverse();
  return ops;
}

/* ---------------------------------------------------------------------
   DIFF ENGINE — turns the word alignment into DSSSB / SSC "Revised
   Guidelines for Evaluation of Typing Test" penalty results:

     FULL MISTAKE (penalty 1.0): omission, addition, wrong/substituted
       word, repeated word, incomplete word.
     HALF MISTAKE (penalty 0.5): transposition of two adjacent words,
       capitalization-only difference.

   Live mode additionally never penalizes the word currently mid-
   keystroke, and never penalizes a trailing stretch of the passage the
   candidate simply hasn't reached yet (that's not a mistake, it's just
   "not typed yet"). Final scoring (liveMode=false) is intentionally
   different: an untyped trailing portion at time-up IS a real mistake
   per the DSSSB rule — a missed line is a missed line.
   --------------------------------------------------------------------- */
function computeDiff(originalText, typedText, options = {}){
  const liveMode = !!options.liveMode;
  // Some exams (DSSSB/SSC) grant half-penalty leniency for a swapped
  // letter case or two transposed adjacent words. Others (DP HCM and
  // similar "word to word" formats) do not — every deviation from the
  // expected word is a full error. Default true to preserve existing
  // DSSSB behavior when no evaluator context is supplied.
  const halfMistakesEnabled = options.halfMistakesEnabled !== false;

  // When the test ends because time ran out (or the candidate submits
  // early), the passage after their LAST typed word was never attempted
  // at all — that's fundamentally different from a word skipped in the
  // middle of the passage while they kept typing past it. This option
  // excludes only that genuinely-never-reached trailing stretch from
  // scoring; a mid-passage skip is a real mistake either way and is
  // never excluded by this flag.
  const excludeTrailingUntyped = !!options.excludeTrailingUntyped;

  const expected = tokenize(originalText);
  const typedAll = typedText.trim().length ? typedText.trim().split(/\s+/) : [];

  const endsWithBoundary = /\s$/.test(typedText);
  const completedCount = endsWithBoundary ? typedAll.length : Math.max(typedAll.length - 1, 0);
  const typed = liveMode ? typedAll.slice(0, completedCount) : typedAll;

  // The DP alignment always prefers matching a capitalization-only pair
  // or an adjacent swap together (better alignment quality either way) —
  // only how those pairs get SCORED differs below, per halfMistakesEnabled.
  const ops = alignWords(expected, typed);

  let fullMistakes = 0;
  let halfMistakes = 0;
  const rows = [];
  const expectedTags = new Array(expected.length); // per-expected-index tag
  const typedTags = new Array(typed.length);        // per-typed-index tag
  const untypedWords = []; // trailing words never attempted — informational only

  // Find the last operation that actually touched typed content — any
  // deletions after that point are "not reached yet", not mistakes.
  // Needed for live mode (always) and for final scoring when
  // excludeTrailingUntyped is on.
  let lastTypedTouch = -1;
  if(liveMode || excludeTrailingUntyped){
    ops.forEach((op, idx) => { if(op.type !== "del") lastTypedTouch = idx; });
  }

  let runningExpPos = 0; // for giving insertions a sensible "position" in the error table

  ops.forEach((op, idx) => {
    if(op.type === "match"){
      expectedTags[op.expIndex] = "correct";
      typedTags[op.typIndex] = "correct";
      runningExpPos = op.expIndex + 1;
      return;
    }

    if(op.type === "half-case"){
      if(halfMistakesEnabled){
        halfMistakes += 1;
        expectedTags[op.expIndex] = "half";
        typedTags[op.typIndex] = "half";
        rows.push({ expected: expected[op.expIndex], typed: typed[op.typIndex], type: "Capitalization (half)", position: op.expIndex + 1, penalty: 0.5 });
      }else{
        fullMistakes += 1;
        expectedTags[op.expIndex] = "incorrect";
        typedTags[op.typIndex] = "incorrect";
        rows.push({ expected: expected[op.expIndex], typed: typed[op.typIndex], type: "Wrong word (full)", position: op.expIndex + 1, penalty: 1 });
      }
      runningExpPos = op.expIndex + 1;
      return;
    }

    if(op.type === "transpose"){
      if(halfMistakesEnabled){
        halfMistakes += 1;
        expectedTags[op.expIndex] = "half";
        expectedTags[op.expIndex + 1] = "half";
        typedTags[op.typIndex] = "half";
        typedTags[op.typIndex + 1] = "half";
        rows.push({
          expected: `${expected[op.expIndex]} ${expected[op.expIndex + 1]}`,
          typed: `${typed[op.typIndex]} ${typed[op.typIndex + 1]}`,
          type: "Transposition (half)", position: op.expIndex + 1, penalty: 0.5
        });
      }else{
        // Word-to-word exams count each mispositioned word as its own
        // full error rather than a paired half-mistake.
        fullMistakes += 2;
        expectedTags[op.expIndex] = "incorrect";
        expectedTags[op.expIndex + 1] = "incorrect";
        typedTags[op.typIndex] = "incorrect";
        typedTags[op.typIndex + 1] = "incorrect";
        rows.push({ expected: expected[op.expIndex], typed: typed[op.typIndex], type: "Wrong word (full)", position: op.expIndex + 1, penalty: 1 });
        rows.push({ expected: expected[op.expIndex + 1], typed: typed[op.typIndex + 1], type: "Wrong word (full)", position: op.expIndex + 2, penalty: 1 });
      }
      runningExpPos = op.expIndex + 2;
      return;
    }

    if(op.type === "sub"){
      fullMistakes += 1;
      expectedTags[op.expIndex] = "incorrect";
      typedTags[op.typIndex] = "incorrect";
      rows.push({ expected: expected[op.expIndex], typed: typed[op.typIndex], type: "Wrong word (full)", position: op.expIndex + 1, penalty: 1 });
      runningExpPos = op.expIndex + 1;
      return;
    }

    if(op.type === "del"){
      // Only a TRAILING run (nothing typed after it) can ever be treated
      // as "not reached yet" — a deletion followed later by more typed
      // content is a genuine mid-passage skip and always counts.
      const isTrailingUnreached = (liveMode || excludeTrailingUntyped) && idx > lastTypedTouch;
      runningExpPos = op.expIndex + 1;

      if(isTrailingUnreached){
        if(liveMode){
          expectedTags[op.expIndex] = undefined; // live view: just blank, not even "untyped" styling
        }else{
          expectedTags[op.expIndex] = "untyped";
          untypedWords.push(expected[op.expIndex]);
        }
        return; // no penalty either way
      }

      expectedTags[op.expIndex] = "missing";
      fullMistakes += 1;
      rows.push({ expected: expected[op.expIndex], typed: "—", type: "Missing / omission (full)", position: op.expIndex + 1, penalty: 1 });
      return;
    }

    if(op.type === "ins"){
      fullMistakes += 1;
      typedTags[op.typIndex] = "extra";
      rows.push({ expected: "—", typed: typed[op.typIndex], type: "Extra / addition (full)", position: runningExpPos + 1, penalty: 1 });
    }
  });

  const comparedCount = liveMode
    ? typed.length
    : Math.max(expected.length - untypedWords.length, typed.length);

  return {
    fullMistakes,
    halfMistakes,
    rows,
    expectedTags,
    typedTags,
    comparedCount,
    untypedWords,
    untypedCount: untypedWords.length,
    expected,
    typed
  };
}

/* --------------------------------------------------------------------------
   Keystroke handling / input restrictions
   -------------------------------------------------------------------------- */
function wireTypingArea(){
  const area = $("#typingArea");

  // Visual-only: mirrors the reference's .input-box-wrapper.focused state
  // (4px orange border only while the textarea has focus). Has no effect
  // unless NTA mode is on ( .nta-focused only does anything under
  // body.nta-mode in style.css).
  area.addEventListener("focus", () => $("#typingPane").classList.add("nta-focused"));
  area.addEventListener("blur", () => $("#typingPane").classList.remove("nta-focused"));

  area.addEventListener("keydown", (e) => {
    if(state.finished) { e.preventDefault(); return; }

    if(!state.hasStartedTyping && e.key.length === 1){
      state.hasStartedTyping = true;
      startMainTimer();
    }

    if(state.settings.backspace === "disabled" && e.key === "Backspace"){
      e.preventDefault();
      beep(180, 120);
      return;
    }

    if(e.key === "Backspace"){
      state.backspaceCount += 1;
    }

    if(e.key.length === 1 || e.key === "Backspace" || e.key === "Enter"){
      keyClickSound();
    }
  });

  area.addEventListener("paste", (e) => e.preventDefault());
  area.addEventListener("copy", (e) => e.preventDefault());
  area.addEventListener("cut", (e) => e.preventDefault());
  area.addEventListener("drop", (e) => e.preventDefault());
  area.addEventListener("dragstart", (e) => e.preventDefault());
  area.addEventListener("contextmenu", (e) => e.preventDefault());

  area.addEventListener("input", () => {
    if(!state.hasStartedTyping){
      state.hasStartedTyping = true;
      startMainTimer();
    }
    updateLiveStats();
  });
}

/* --------------------------------------------------------------------------
   Finish test → move to result screen
   -------------------------------------------------------------------------- */
function finishTest(reason){
  if(state.finished) return;
  state.finished = true;
  stopAllTimers();
  $("#typingArea").disabled = true;

  const passage = state.currentPassage;
  const typedText = $("#typingArea").value;
  const minutesElapsed = Math.max(state.elapsedSeconds / 60, 1/60);

  const strokes = countCharacters(typedText);
  const totalWords = strokes / 5;
  const grossWpm = totalWords / minutesElapsed;

  const evaluator = getCurrentEvaluator();
  const evalConfig = getCurrentEvaluationConfig();

  const diff = computeDiff(passage.text, typedText, {
    halfMistakesEnabled: evaluator.usesHalfMistakes,
    excludeTrailingUntyped: state.settings.trailingLeniency === "on"
  });
  const penalty = diff.fullMistakes + diff.halfMistakes / 2;
  const netWpm = evaluator.computeNetSpeed({
    totalWords, grossWpm, minutes: minutesElapsed,
    fullMistakes: diff.fullMistakes, halfMistakes: diff.halfMistakes
  });
  const comparedCount = Math.max(diff.comparedCount, 1);
  const accuracy = Math.max(
    ((comparedCount - diff.fullMistakes - diff.halfMistakes) / comparedCount) * 100,
    0
  );

  const verdict = evaluator.evaluate({
    netSpeed: netWpm,
    keystrokes: strokes,
    config: evalConfig,
    settings: state.settings
  });

  // AZ-Typing-style breakdown metrics — computed here once so the result
  // screen, TXT export, and history all show identical numbers.
  const givenKeystrokes = countCharacters(passage.text);
  const errorUnits = Number(penalty.toFixed(2)); // fullMistakes + halfMistakes*0.5
  const errorPercent = totalWords > 0 ? Number(((errorUnits / totalWords) * 100).toFixed(2)) : 0;
  const omissionWords = diff.rows.filter(row => row.type.toLowerCase().includes("omission")).length;
  const untypedDueToTime = diff.untypedCount || 0;
  const untypedWordsList = diff.untypedWords || [];

  // Each evaluator explains its OWN formula chain — DSSSB's doubled-
  // penalty "Net Words" concept doesn't apply to DP HCM's flat
  // "Gross - Wrong Words" formula, so this must not be hardcoded here.
  const calculationSteps = typeof evaluator.describeCalculation === "function"
    ? evaluator.describeCalculation({
        totalWords, grossWpm, minutes: minutesElapsed, netSpeed: netWpm,
        fullMistakes: diff.fullMistakes, halfMistakes: diff.halfMistakes
      })
    : [];

  // Weak words: every distinct expected word involved in a wrong-word or
  // capitalization mistake — the words worth drilling.
  const weakWordsSet = new Set();
  diff.rows.forEach(row => {
    const type = row.type.toLowerCase();
    if((type.includes("wrong word") || type.includes("capitalization")) && row.expected && row.expected !== "—"){
      weakWordsSet.add(row.expected.replace(/[^\w'-]/g, ""));
    }
  });
  const weakWords = Array.from(weakWordsSet).filter(w => w.length > 0);

  const result = {
    date: new Date().toISOString(),
    passageId: passage.id,
    passageTitle: passage.title,
    categoryTitle: state.currentCategory ? state.currentCategory.title : "",
    netWpm: Number(netWpm.toFixed(2)),
    grossWpm: Number(grossWpm.toFixed(2)),
    accuracy: Number(accuracy.toFixed(2)),
    fullMistakes: diff.fullMistakes,
    halfMistakes: diff.halfMistakes,
    usesHalfMistakes: evaluator.usesHalfMistakes,
    penalty: Number(penalty.toFixed(2)),
    wordsTyped: totalWords.toFixed(1),
    charsTyped: strokes,
    givenKeystrokes,
    errorUnits,
    errorPercent,
    omissionWords,
    untypedDueToTime,
    untypedWordsList,
    calculationSteps,
    backspaceUsed: state.backspaceCount,
    weakWords,
    timeTakenSec: state.elapsedSeconds,
    pass: verdict.pass,
    marks: verdict.marks,
    marksLabel: verdict.marksLabel,
    qualifyLabel: verdict.qualifyLabel,
    originalText: passage.text,
    typedText,
    diffRows: diff.rows,
    expectedTags: diff.expectedTags,
    typedTags: diff.typedTags,
    expected: diff.expected,
    typed: diff.typed
  };

  result.diagnostics = generateDiagnostics(result);
  result.diagnosticTips = buildDiagnosticTips(result.diagnostics);

  state.lastResult = result;
  saveHistoryEntry(result);
  renderResultScreen(result);
}

/* --------------------------------------------------------------------------
   5. RESULT SCREEN
   -------------------------------------------------------------------------- */
function renderResultScreen(r){
  $("#testScreen").hidden = true;
  $("#resultScreen").hidden = false;

  const badge = $("#resultBadge");
  badge.textContent = r.pass ? "PASS" : "FAIL";
  badge.className = "result-badge " + (r.pass ? "pass" : "fail");

  $("#resultTitleText").textContent = r.pass ? "Well typed — you cleared the qualifying bar." : "Not qualified this time.";
  const categoryBit = r.categoryTitle ? `${r.categoryTitle} — ` : "";
  $("#resultSub").textContent = `${categoryBit}${r.passageTitle} · ${r.qualifyLabel || ""}`;

  $("#resNet").textContent = r.netWpm + " WPM";
  $("#resGross").textContent = r.grossWpm + " WPM";
  $("#resAcc").textContent = r.accuracy + "%";
  $("#resErrorPct").textContent = r.errorPercent + "%";
  $("#resFull").textContent = r.fullMistakes;
  $("#resHalf").textContent = r.halfMistakes;
  $("#resOmission").textContent = r.omissionWords;
  if(r.untypedDueToTime > 0){
    $("#resUntypedCard").hidden = false;
    $("#resUntyped").textContent = r.untypedDueToTime;
  }else{
    $("#resUntypedCard").hidden = true;
  }
  $("#resErrorUnits").textContent = r.errorUnits;
  $("#resPenalty").textContent = r.penalty;
  $("#resGivenKeys").textContent = r.givenKeystrokes;
  $("#resChars").textContent = r.charsTyped;
  $("#resWords").textContent = r.wordsTyped;
  $("#resBackspace").textContent = r.backspaceUsed;
  $("#resTime").textContent = formatTime(r.timeTakenSec);

  // Half Mistakes card only makes sense for exams that actually grant
  // half-penalty leniency (e.g. DSSSB). Word-to-word exams like DP HCM
  // don't have the concept, so hide it rather than always showing "0".
  $("#resHalfCard").hidden = !r.usesHalfMistakes;

  // Marks card only appears for marks-band evaluators (e.g. DP HCM's
  // 0-25 scale). DSSSB-style pass/fail exams have no marks to show.
  if(r.marks !== null && r.marks !== undefined){
    $("#resMarksCard").hidden = false;
    $("#resMarks").textContent = r.marksLabel || `${r.marks} / 25`;
  }else{
    $("#resMarksCard").hidden = true;
  }

  // Step-by-step formula breakdown, in the current exam's own words —
  // DSSSB's doubled-penalty chain looks nothing like DP HCM's flat one.
  const calcBox = $("#calcSteps");
  calcBox.innerHTML = (r.calculationSteps || [])
    .map(line => `<span class="calc-line">${escapeHtml(line)}</span>`)
    .join("");

  // Weak words drill — only show the section if there's actually
  // something to practice.
  const weakSection = $("#weakWordsSection");
  if(r.weakWords && r.weakWords.length > 0){
    weakSection.hidden = false;
    $("#weakWordsChips").innerHTML = r.weakWords
      .map(w => `<span class="weak-word-chip">${escapeHtml(w)}</span>`)
      .join("");
  }else{
    weakSection.hidden = true;
  }

  // Diagnostic Report — pattern-based tips pulled from this attempt's
  // actual mistakes (confused keys, weak letter combos, etc). Only
  // rendered when there's real signal, not generic filler.
  const diagSection = $("#diagnosticSection");
  const tips = r.diagnosticTips || [];
  if(tips.length > 0){
    diagSection.hidden = false;
    $("#diagnosticGrid").innerHTML = tips.map(tip => `
      <div class="diagnostic-card">
        <div class="dc-head">
          <span class="dc-icon">${tip.icon}</span>
          <h3 class="dc-title">${escapeHtml(tip.title)}</h3>
        </div>
        <div class="dc-body">${escapeHtml(tip.body)}</div>
        <div class="dc-tip"><b>Tip:</b> ${escapeHtml(tip.aiTip)}</div>
      </div>
    `).join("");
  }else{
    diagSection.hidden = true;
  }

  renderComparison(r);
  renderErrorTable(r);
}

function renderComparison(r){
  const originalHtml = r.expected.map((w, i) => {
    const tag = r.expectedTags[i];
    let cls = "w-correct";
    if(tag === "incorrect") cls = "w-incorrect";
    else if(tag === "missing") cls = "w-missing";
    else if(tag === "half") cls = "w-half";
    else if(tag === "untyped") cls = "w-untyped";
    else if(tag === undefined) cls = "";
    return `<span class="${cls}">${escapeHtml(w)}</span>`;
  }).join(" ");

  const typedHtml = r.typed.map((w, i) => {
    const tag = r.typedTags[i];
    let cls = "w-correct";
    if(tag === "incorrect") cls = "w-incorrect";
    else if(tag === "extra") cls = "w-extra";
    else if(tag === "half") cls = "w-half";
    else if(tag === undefined) cls = "";
    return `<span class="${cls}">${escapeHtml(w)}</span>`;
  }).join(" ");

  $("#cmpOriginal").innerHTML = originalHtml;
  $("#cmpTyped").innerHTML = typedHtml || "<em>(nothing typed)</em>";
}

function renderErrorTable(r){
  const tbody = $("#errorTableBody");
  tbody.innerHTML = "";

  if(r.diffRows.length === 0){
    $("#noErrorsNote").hidden = false;
  }else{
    $("#noErrorsNote").hidden = true;
    r.diffRows.forEach((row, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escapeHtml(row.expected)}</td>
        <td>${escapeHtml(row.typed)}</td>
        <td>${row.type}</td>
        <td>${row.position}</td>
        <td>${row.penalty}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

function exportTxt(r){
  const lines = [
    `TYPING TEST RESULT — ${r.categoryTitle ? r.categoryTitle + " — " : ""}${r.passageTitle}`,
    `Date: ${new Date(r.date).toLocaleString()}`,
    `Result: ${r.pass ? "PASS" : "FAIL"} (${r.qualifyLabel || ""})`,
    r.marksLabel ? `Marks: ${r.marksLabel}` : null,
    ``,
    `Net WPM: ${r.netWpm}`,
    `Gross WPM: ${r.grossWpm}`,
    `Accuracy: ${r.accuracy}%`,
    `Error %: ${r.errorPercent}%`,
    `Full Mistakes: ${r.fullMistakes}`,
    r.usesHalfMistakes ? `Half Mistakes: ${r.halfMistakes}` : null,
    `Omission Words: ${r.omissionWords}`,
    r.untypedDueToTime > 0 ? `Untyped (Time Over, not penalized): ${r.untypedDueToTime} — ${r.untypedWordsList.join(" ")}` : null,
    `Error Units: ${r.errorUnits}`,
    `Total Penalty: ${r.penalty}`,
    `Given Keystrokes: ${r.givenKeystrokes}`,
    `Typed Keystrokes: ${r.charsTyped}`,
    `Words Typed: ${r.wordsTyped}`,
    `Backspace Used: ${r.backspaceUsed}`,
    `Time Taken: ${formatTime(r.timeTakenSec)}`,
    ``,
    `--- CALCULATION ---`,
    ...(r.calculationSteps || []),
    ``,
    r.diagnosticTips && r.diagnosticTips.length ? `--- DIAGNOSTIC REPORT ---` : null,
    ...(r.diagnosticTips || []).map(t => `${t.title}: ${t.body} (Tip: ${t.aiTip})`),
    r.diagnosticTips && r.diagnosticTips.length ? `` : null,
    r.weakWords && r.weakWords.length ? `--- WEAK WORDS ---` : null,
    r.weakWords && r.weakWords.length ? r.weakWords.join(" ") : null,
    r.weakWords && r.weakWords.length ? `` : null,
    `--- ORIGINAL PASSAGE ---`,
    r.originalText,
    ``,
    `--- YOUR TYPING ---`,
    r.typedText,
    ``,
    `--- ERROR TABLE ---`,
    ...r.diffRows.map((row, i) => `${i+1}. Expected: "${row.expected}" | Typed: "${row.typed}" | ${row.type} | Position ${row.position} | Penalty ${row.penalty}`)
  ];

  const blob = new Blob([lines.filter(l => l !== null).join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `typing-result-${r.passageId}-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/* --------------------------------------------------------------------------
   6. SETTINGS MODAL WIRING
   -------------------------------------------------------------------------- */
function wireSegControl(id, settingKey, onChange){
  const control = $(id);
  control.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      control.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if(onChange) onChange(btn.dataset.value);
    });
  });
  // set initial active state
  const current = state.settings[settingKey];
  control.querySelectorAll(".seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.value == current);
  });
}

function openSettings(){
  $("#settingsOverlay").hidden = false;
}
function closeSettings(){
  $("#settingsOverlay").hidden = true;
}

/* ---------------------------------------------------------------------
   Custom Passage Practice — paste any text (weak words, your own
   material) and type it using the exact same test engine, timer, and
   scoring as the current category. Not saved into any passage array;
   it's a one-off, though the last draft is remembered so it isn't lost.
   --------------------------------------------------------------------- */
function openCustomPassageModal(){
  const draft = loadCustomPassageDraft();
  $("#customPassageTitle").value = draft.title || "";
  $("#customPassageText").value = draft.text || "";
  updateCustomPassageMeta();
  $("#customPassageOverlay").hidden = false;
  setTimeout(() => $("#customPassageText").focus(), 50);
}

function closeCustomPassageModal(){
  $("#customPassageOverlay").hidden = true;
}

function updateCustomPassageMeta(){
  const text = $("#customPassageText").value;
  const words = tokenize(text).length;
  const chars = countCharacters(text);
  $("#customPassageMeta").textContent = `${words} word${words !== 1 ? "s" : ""} · ${chars} character${chars !== 1 ? "s" : ""}`;
}

function wireCustomPassageModal(){
  $("#btnCloseCustomPassage").addEventListener("click", closeCustomPassageModal);

  $("#customPassageText").addEventListener("input", () => {
    updateCustomPassageMeta();
    saveCustomPassageDraft($("#customPassageTitle").value, $("#customPassageText").value);
  });
  $("#customPassageTitle").addEventListener("input", () => {
    saveCustomPassageDraft($("#customPassageTitle").value, $("#customPassageText").value);
  });

  $("#btnClearCustomPassage").addEventListener("click", () => {
    if($("#customPassageText").value.trim().length === 0) return;
    if(confirm("Clear this custom passage?")){
      $("#customPassageTitle").value = "";
      $("#customPassageText").value = "";
      updateCustomPassageMeta();
      saveCustomPassageDraft("", "");
    }
  });

  $("#btnStartCustomPassage").addEventListener("click", () => {
    const text = $("#customPassageText").value.trim();
    if(text.length === 0){
      alert("Paste or type something to practice first.");
      return;
    }
    const title = $("#customPassageTitle").value.trim() || "Custom Passage";
    const passage = { id: "custom", title, difficulty: "Custom", text };
    closeCustomPassageModal();
    startTest(passage);
  });
}

function populateSettingsForm(){
  const s = state.settings;
  wireSegControl("#themeControl", "theme", v => s.theme = v);
  wireSegControl("#modeControl", "mode", v => s.mode = v);
  wireSegControl("#timerControl", "timerMinutes", v => s.timerMinutes = parseInt(v, 10));
  wireSegControl("#backspaceControl", "backspace", v => s.backspace = v);
  wireSegControl("#autoHighlightControl", "autoHighlight", v => s.autoHighlight = v);
  wireSegControl("#trailingLeniencyControl", "trailingLeniency", v => s.trailingLeniency = v);
  wireSegControl("#soundControl", "sound", v => s.sound = v);
  wireSegControl("#ambienceControl", "ambience", v => s.ambience = v);
  wireSegControl("#ntaInterfaceControl", "examInterface", v => { s.examInterface = v; applyExamInterfaceMode(); });
  wireSegControl("#autoScrollControl", "autoScrollPassage", v => s.autoScrollPassage = v);

  $("#customTimer").value = "";
  $("#customTimer").addEventListener("change", () => {
    const val = parseInt($("#customTimer").value, 10);
    if(val && val > 0){
      s.timerMinutes = val;
      $("#timerControl .seg-btn").forEach(b => b.classList.remove("active"));
    }
  });

  $("#qualifyWpm").value = s.qualifyWpm;
  $("#passageFontSize").value = s.passageFontSize;
  $("#typingFontSize").value = s.typingFontSize;
  $("#fontFamily").value = s.fontFamily;
  $("#ambienceVolume").value = s.ambienceVolume;

  refreshAmbienceFileStatus();
}

function applyTheme(){
  document.documentElement.setAttribute("data-theme", state.settings.theme);
}

// Purely visual: toggles the "nta-mode" class that style.css uses to skin
// the test screen like the official DSSSB/NTA/TCS CBT portal. Does not
// touch typing, timer, WPM/CPM/accuracy, mistake detection, or results —
// those all keep reading/writing the exact same elements either way.
function applyExamInterfaceMode(){
  const on = state.settings.examInterface === "on";
  document.body.classList.toggle("nta-mode", on);
  if(on && state.currentPassage){
    $("#ntaGovTitle").textContent = state.currentPassage.title;
  }
  // applyTypographySettings() sets font-size as an inline style, which
  // beats any CSS class rule — so the reference's exact 20px passage /
  // 18px typing sizes have to be applied the same way here, and undone
  // (by re-running the user's own typography setting) when switching off.
  if(on){
    $("#passageText").style.fontSize = "20px";
    $("#typingArea").style.fontSize = "18px";
  } else {
    applyTypographySettings();
  }
}

function wireSettingsModal(){
  $("#btnSettingsNav").addEventListener("click", openSettings);
  $("#btnCloseSettings").addEventListener("click", closeSettings);

  $("#btnSaveSettings").addEventListener("click", () => {
    state.settings.qualifyWpm = parseInt($("#qualifyWpm").value, 10) || DEFAULT_SETTINGS.qualifyWpm;
    state.settings.passageFontSize = parseInt($("#passageFontSize").value, 10) || DEFAULT_SETTINGS.passageFontSize;
    state.settings.typingFontSize = parseInt($("#typingFontSize").value, 10) || DEFAULT_SETTINGS.typingFontSize;
    state.settings.fontFamily = $("#fontFamily").value;
    state.settings.ambienceVolume = parseInt($("#ambienceVolume").value, 10) || DEFAULT_SETTINGS.ambienceVolume;

    saveSettings(state.settings);
    applyTheme();
    closeSettings();
  });

  $("#btnClearHistory").addEventListener("click", () => {
    if(confirm("This will permanently delete all saved test history. Continue?")){
      clearHistory();
      renderDashboardStats();
    }
  });

  wireAmbienceControls();
}

/* ---------------------------------------------------------------------
   Exam Hall Ambience controls (Settings modal) — upload, preview,
   remove, and live volume for the person's own recording.
   --------------------------------------------------------------------- */
function refreshAmbienceFileStatus(){
  const persisted = !!loadAmbienceAudio();
  const sessionOnly = !persisted && !!state.ambienceStagedDataUrl;

  if(persisted){
    $("#ambienceFileStatus").textContent = "Custom recording saved — plays in a loop, quietly, during a test.";
  }else if(sessionOnly){
    $("#ambienceFileStatus").textContent = "Recording loaded for this session only (too large to save for next time) — plays in a loop during a test.";
  }else{
    $("#ambienceFileStatus").textContent = "No file selected — plays in a loop, quietly, during a test.";
  }
  $("#btnPreviewAmbience").disabled = !persisted && !sessionOnly;
  $("#btnRemoveAmbience").disabled = !persisted && !sessionOnly;
}

function wireAmbienceControls(){
  $("#ambienceFileInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;

    // Always make the file playable THIS session immediately via an
    // object URL — this works instantly for any file size and doesn't
    // depend on localStorage at all. This is the fallback that was
    // previously promised but never actually wired up.
    if(state.ambienceStagedDataUrl){
      try{ URL.revokeObjectURL(state.ambienceStagedDataUrl); }catch(err){ /* ignore */ }
    }
    state.ambienceStagedDataUrl = URL.createObjectURL(file);

    const MAX_PERSIST_BYTES = 4 * 1024 * 1024; // ~4MB — keeps base64 well within typical localStorage quota
    if(file.size > MAX_PERSIST_BYTES){
      // Too big to persist — skip the expensive base64 conversion
      // entirely and just use the session-only object URL.
      alert(`That file is ${(file.size / (1024*1024)).toFixed(1)}MB — too large to remember for next time (limit ~4MB), but it'll play fine for this session. For it to persist across reloads, use a shorter clip or a lower-bitrate export.`);
      refreshAmbienceFileStatus();
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const saved = saveAmbienceAudio(reader.result);
      if(!saved){
        alert("Couldn't save this recording for reuse (storage full) — it'll still work for this session.");
      }
      refreshAmbienceFileStatus();
    };
    reader.onerror = () => {
      // Object URL is already staged, so playback still works even if
      // this fails — just can't persist it.
      alert("Couldn't prepare that file for saving — it'll still work for this session.");
    };
    reader.readAsDataURL(file);

    refreshAmbienceFileStatus();
  });

  $("#btnPreviewAmbience").addEventListener("click", () => {
    previewAmbience(loadAmbienceAudio() || state.ambienceStagedDataUrl);
  });

  $("#btnRemoveAmbience").addEventListener("click", () => {
    clearAmbienceAudio();
    if(state.ambienceStagedDataUrl){
      try{ URL.revokeObjectURL(state.ambienceStagedDataUrl); }catch(err){ /* ignore */ }
      state.ambienceStagedDataUrl = null;
    }
    $("#ambienceFileInput").value = "";
    refreshAmbienceFileStatus();
  });

  $("#ambienceVolume").addEventListener("input", () => {
    state.settings.ambienceVolume = parseInt($("#ambienceVolume").value, 10);
    if(previewAudioEl) previewAudioEl.volume = state.settings.ambienceVolume / 100;
  });
}

/* --------------------------------------------------------------------------
   Test screen buttons
   -------------------------------------------------------------------------- */
function wireTestScreenButtons(){
  $("#btnExit").addEventListener("click", () => {
    if(confirm("Exit the test? Your progress will not be saved.")){
      goHome();
    }
  });

  $("#btnRestart").addEventListener("click", () => {
    if(confirm("Restart this test from the beginning?")){
      startTest(state.currentPassage);
    }
  });

  $("#btnSubmitEarly").addEventListener("click", () => {
    if(!state.hasStartedTyping){
      alert("Start typing before submitting.");
      return;
    }
    finishTest("manual");
  });

  $("#btnFullscreen").addEventListener("click", () => {
    if(!document.fullscreenElement){
      document.documentElement.requestFullscreen().catch(() => {});
    }else{
      document.exitFullscreen().catch(() => {});
    }
  });

  $("#btnSound").addEventListener("click", () => {
    state.settings.sound = state.settings.sound === "on" ? "off" : "on";
    saveSettings(state.settings);
    $("#btnSound").textContent = state.settings.sound === "on" ? "🔊" : "🔇";
    beep(520, 80);
  });

  // NTA-skin header controls — reuse the exact same Settings modal, and a
  // simple informational note for Instructions (no new test logic).
  $("#ntaBtnSettings").addEventListener("click", openSettings);
  $("#ntaBtnInstructions").addEventListener("click", () => {
    alert("Type the passage exactly as shown. The timer starts on your first keystroke. Submit before time runs out, or the test auto-submits.");
  });
}

/* --------------------------------------------------------------------------
   Result screen buttons
   -------------------------------------------------------------------------- */
function wireResultScreenButtons(){
  $("#btnBackHome").addEventListener("click", goHome);

  $("#btnRetryTest").addEventListener("click", () => {
    startTest(state.currentPassage);
  });

  $("#btnExportTxt").addEventListener("click", () => {
    if(state.lastResult) exportTxt(state.lastResult);
  });

  $("#btnExportPdf").addEventListener("click", () => {
    window.print();
  });

  $("#btnCopyWeakWords").addEventListener("click", () => {
    const r = state.lastResult;
    if(!r || !r.weakWords || r.weakWords.length === 0) return;
    const text = r.weakWords.join(" ");
    const btn = $("#btnCopyWeakWords");
    const original = btn.textContent;

    const showCopied = () => {
      btn.textContent = "✅ Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    };

    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(showCopied).catch(() => fallbackCopy(text, showCopied));
    }else{
      fallbackCopy(text, showCopied);
    }
  });
}

// Clipboard API needs a secure context; this covers plain file:// usage
// where it may be unavailable.
function fallbackCopy(text, onDone){
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try{ document.execCommand("copy"); }catch(e){ /* ignore */ }
  document.body.removeChild(ta);
  if(onDone) onDone();
}

/* --------------------------------------------------------------------------
   Home screen search / random test
   -------------------------------------------------------------------------- */
function wireHomeScreen(){
  $("#searchBox").addEventListener("input", (e) => {
    renderPassageGrid(e.target.value);
  });

  $("#btnBackToCatalogue").addEventListener("click", goToCatalogue);

  $("#btnRandomTest").addEventListener("click", () => {
    const passages = getCurrentPassages();
    if(passages.length === 0) return;
    const random = passages[Math.floor(Math.random() * passages.length)];
    startTest(random);
  });

  $("#btnDownloadAllPdf").addEventListener("click", downloadAllPassagesPdf);

  $("#btnCustomPassage").addEventListener("click", openCustomPassageModal);
}

/* ---------------------------------------------------------------------
   Combines every passage in the current category into one long,
   A4-paginated view (one passage per printed page) and hands it to the
   browser's native print dialog. Choosing "Save as PDF" there produces
   an offline PDF — no PDF library needed. Intended for Paper‑to‑Screen
   practice: print it, then type from the paper.
   --------------------------------------------------------------------- */
function downloadAllPassagesPdf(){
  const passages = getCurrentPassages();
  const categoryTitle = state.currentCategory ? state.currentCategory.title : "Typing Practice";

  if(passages.length === 0){
    alert("No passages found to export.");
    return;
  }

  const btn = $("#btnDownloadAllPdf");
  const originalLabel = btn.textContent;
  btn.textContent = "Preparing PDF…";
  btn.disabled = true;

  const container = $("#printAllContainer");
  const pagesHtml = passages.map(p => {
    const words = tokenize(p.text).length;
    return `
      <div class="print-page">
        <div class="print-head">
          <h2>${escapeHtml(p.title)}</h2>
          <span>${escapeHtml(p.difficulty)} · ${words} words</span>
        </div>
        <div class="print-body">${escapeHtml(p.text)}</div>
        <div class="print-footer">${escapeHtml(categoryTitle)} — Passage #${p.id} of ${passages.length}</div>
      </div>
    `;
  }).join("");

  container.innerHTML = pagesHtml;
  container.hidden = false;
  document.body.classList.add("printing-all");

  const originalTitle = document.title;
  document.title = `${categoryTitle} - All Passages`;

  const cleanup = () => {
    document.body.classList.remove("printing-all");
    container.hidden = true;
    container.innerHTML = "";
    document.title = originalTitle;
    btn.textContent = originalLabel;
    btn.disabled = false;
    window.removeEventListener("afterprint", cleanup);
  };

  window.addEventListener("afterprint", cleanup);

  // Give the browser a moment to lay out all pages before opening the
  // print dialog, otherwise some browsers print a blank first page.
  setTimeout(() => {
    window.print();
    // Fallback cleanup in case the browser doesn't fire "afterprint"
    // (some browsers/print-to-PDF flows skip it).
    setTimeout(cleanup, 2000);
  }, 150);
}

/* --------------------------------------------------------------------------
   7. BOOT
   -------------------------------------------------------------------------- */
function boot(){
  applyTheme();
  applyExamInterfaceMode();
  populateSettingsForm();
  wireSettingsModal();
  wireHomeScreen();
  wireCustomPassageModal();
  wireTypingArea();
  wireTestScreenButtons();
  wireResultScreenButtons();
  renderCategoryGrid();
}

document.addEventListener("DOMContentLoaded", boot);
