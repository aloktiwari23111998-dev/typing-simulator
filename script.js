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
  ambienceStagedDataUrl: null, // freshly-picked file, not yet confirmed/saved

  // ---- Module 0: Keystroke Timing Logger (telemetry only — see section 4b) ----
  telemetry: [],              // flat array of per-event telemetry records, reset per test
  telemetryPrevValue: "",     // last-seen textarea value, used to diff() out what changed
  telemetryPendingKey: null   // { key, code, timestamp } for the most recent keydown,
                              // used both to label the next 'input' event and to pair
                              // with 'keyup' for keyDownDurationMs
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
  state.telemetry = [];
  state.telemetryPrevValue = "";
  state.telemetryPendingKey = null;
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

  // Tiny tie-breaking bias (far smaller than any real cost, which are
  // always in increments of 0.5 or 1) that favors alignments which stay
  // close to the diagonal — i.e. don't unnecessarily "jump ahead" to a
  // later coincidental repeat of the same word when an equally-cheap,
  // straightforward in-order match/deletion exists. Without this, a
  // repeated common word later in the passage can make a genuinely
  // untyped trailing stretch look like a real mid-passage skip.
  const BIAS = 1e-9;
  const bias = (i, j) => BIAS * Math.abs(i - j);

  const dp = new Array(n + 1);
  for(let i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
  dp[0][0] = 0;
  for(let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + 1 + bias(i, 0);
  for(let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + 1 + bias(0, j);

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
      dp[i][j] = best + bias(i, j);
    }
  }

  // Traceback: walk the matrix from the end to reconstruct the actual
  // sequence of operations that produced the minimum cost.
  const ops = [];
  let i = n, j = m;
  const close = (a, b) => Math.abs(a - b) < 1e-12;

  while(i > 0 || j > 0){
    if(i > 1 && j > 1 &&
       expected[i - 1] === typed[j - 2] && expected[i - 2] === typed[j - 1] &&
       close(dp[i][j], dp[i - 2][j - 2] + 1 + bias(i, j))){
      ops.push({ type: "transpose", expIndex: i - 2, typIndex: j - 2 });
      i -= 2; j -= 2;
      continue;
    }
    if(i > 0 && j > 0 && close(dp[i][j], dp[i - 1][j - 1] + wordCost(expected[i - 1], typed[j - 1]) + bias(i, j))){
      const cost = wordCost(expected[i - 1], typed[j - 1]);
      const type = cost === 0 ? "match" : (cost === 0.5 ? "half-case" : "sub");
      ops.push({ type, expIndex: i - 1, typIndex: j - 1 });
      i -= 1; j -= 1;
      continue;
    }
    if(i > 0 && close(dp[i][j], dp[i - 1][j] + 1 + bias(i, j))){
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
   4b. KEYSTROKE TIMING LOGGER (Module 0 — telemetry foundation only)
   --------------------------------------------------------------------------
   Pure data-capture layer for future result-analysis modules. Nothing in
   this section renders UI, computes scores, or feeds the existing scoring/
   diff engine — it only appends structured records to state.telemetry.

   Existing behaviour (typing engine, auto-scroll, mistake detection,
   scoring, timer) reads none of this and is completely unaffected; this
   section is additive-only.

   ---- Record shape (one object per logged event in state.telemetry) ----
   {
     seq:               number,        // 0-based order of this event in the test
     timestamp:          number,        // Date.now() when the event was captured
     elapsedTestMs:       number|null,   // timestamp - state.startTimestamp
                                        // (null if captured before the main timer
                                        // has started, e.g. a stray keydown)
     latencyMs:           number|null,   // gap from the previous telemetry event's
                                        // timestamp (null for the very first event).
                                        // This is the raw inter-keystroke gap;
                                        // consuming modules decide their own
                                        // "pause" threshold and "burst" runs from
                                        // this sequence — no threshold is applied
                                        // here.
     keyDownDurationMs:   number|null,   // keyup timestamp - keydown timestamp for
                                        // this physical key, filled in by the
                                        // keyup handler below; stays null if no
                                        // matching keyup was observed (e.g. focus
                                        // lost mid-press).
     key:                 string,        // raw e.key of the physical key pressed
     isCharacterEvent:    boolean,       // true if this came from an actual text
                                        // change (insert/delete in the textarea),
                                        // false for a pure navigation/modifier key
                                        // (Shift, Arrow*, Tab, Control, etc.)
     isBackspace:         boolean,
     isCorrection:        boolean,       // true for any deleting action (Backspace
                                        // or Delete) — same as isBackspace today,
                                        // kept as a distinct field since Delete
                                        // could be wired in later without this
                                        // shape changing
     insertedText:        string|null,   // text actually inserted this event
                                        // (normally 0-1 chars — paste is already
                                        // blocked elsewhere in the app)
     removedText:         string|null,   // text actually removed this event
     typedChar:           string|null,   // convenience: last character of
                                        // insertedText, or null on pure deletion
     expectedChar:        string|null,   // ⚠ PRELIMINARY / LIVE-ONLY. Best-effort
                                        // same-position character from the
                                        // ORIGINAL passage, looked up via
                                        // word-index + in-word offset (see
                                        // getExpectedCharForTelemetry) at the
                                        // instant the key was pressed. Purely a
                                        // live approximation — after a length-
                                        // changing mistake it can drift out of
                                        // alignment until the next space, and it
                                        // is NEVER retroactively corrected once
                                        // logged. computeDiff() itself is not
                                        // touched by this field or by anything
                                        // in this section. Once a test finishes,
                                        // result.finalDiff (see finishTest())
                                        // holds the actual, authoritative,
                                        // fully-realigned diff-engine output —
                                        // any module doing real analysis/
                                        // reporting must read from
                                        // result.finalDiff, not from this
                                        // per-keystroke field, whenever
                                        // result.finalDiff is available.
     charOutcome:          string|null,  // ⚠ PRELIMINARY / LIVE-ONLY, same caveat
                                        // as expectedChar above — a live,
                                        // uncorrected guess ("correct" |
                                        // "incorrect" | "deletion" | null),
                                        // superseded by result.finalDiff once
                                        // the test ends.
     cursorPosition:       number|null,   // textarea.selectionStart after the event
     wordIndex:            number|null,   // 0-based index into the passage's words
     charIndexInWord:      number|null,   // 0-based offset within that word
     visualLineIndex:      null           // Intentionally NOT computed live — doing
                                        // a layout read (getBoundingClientRect) on
                                        // every keystroke would add real per-key
                                        // overhead, which conflicts with the
                                        // "near-zero performance overhead"
                                        // requirement. The DOM anchors needed to
                                        // derive this after the fact already exist
                                        // (state.passageWordEls, reused read-only
                                        // by Auto Scroll) — a later module can
                                        // resolve this as a one-time post-test
                                        // pass instead of a per-keystroke cost.
   }

   ---------------------------------------------------------------------- */

// Keys that never change the textarea's text content — logged directly on
// keydown since no matching 'input' event will follow them.
const TELEMETRY_NON_CHARACTER_KEYS = new Set([
  "Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Tab", "Escape",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
  "PageUp", "PageDown", "Insert", "ContextMenu",
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"
]);

function isTelemetryContentKey(key){
  return key.length === 1 || key === "Backspace" || key === "Delete" || key === "Enter";
}

// Minimal common-prefix/suffix diff between the previous and current
// textarea value — robust regardless of where the caret is, so it works
// whether typing continues at the end or the person has moved the caret
// with the arrow keys. Paste/cut/drop are already prevented elsewhere in
// the app, so inserted/removed spans in normal use stay small.
function diffTelemetryValues(oldVal, newVal){
  let start = 0;
  const maxStart = Math.min(oldVal.length, newVal.length);
  while(start < maxStart && oldVal[start] === newVal[start]) start++;

  let oldEnd = oldVal.length;
  let newEnd = newVal.length;
  while(oldEnd > start && newEnd > start && oldVal[oldEnd - 1] === newVal[newEnd - 1]){
    oldEnd--; newEnd--;
  }

  return {
    removed: oldVal.slice(start, oldEnd),
    inserted: newVal.slice(start, newEnd)
  };
}

// Standalone word-position calculator for telemetry — deliberately NOT
// reusing updateTypingProgress()'s internals so that function stays
// completely untouched. Mirrors the same word-splitting rule it already
// uses (trim + split on whitespace) purely for consistency of results.
function computeTelemetryWordPosition(typedText){
  const typedWords = typedText.length ? typedText.trim().split(/\s+/) : [];
  const wordIndex = typedText.endsWith(" ") || typedText.length === 0
    ? typedWords.length
    : Math.max(typedWords.length - 1, 0);
  const charIndexInWord = (typedText.endsWith(" ") || typedText.length === 0)
    ? 0
    : (typedWords[typedWords.length - 1] || "").length;
  return { wordIndex, charIndexInWord };
}

// Best-effort expected character at the given word/offset, read from the
// already-tokenized passage words (state.passageExpectedWords, populated
// once per test by buildPassageDom() — read-only reuse, never written to
// here). Returns null once the position runs past a length-changing
// mistake for that word, rather than guessing.
function getExpectedCharForTelemetry(wordIndex, charIndexInWord){
  const words = state.passageExpectedWords;
  if(!words || !words[wordIndex]) return null;
  const word = words[wordIndex];
  if(charIndexInWord <= 0 || charIndexInWord > word.length) return null;
  return word[charIndexInWord - 1];
}

// Appends one record to state.telemetry, filling in the fields shared by
// every event (seq/timestamp/elapsedTestMs/latencyMs) so callers only need
// to supply what's specific to their event.
function pushTelemetryEvent(partial){
  const now = Date.now();
  const prev = state.telemetry[state.telemetry.length - 1];
  const entry = Object.assign({
    seq: state.telemetry.length,
    timestamp: now,
    elapsedTestMs: state.startTimestamp != null ? (now - state.startTimestamp) : null,
    latencyMs: prev ? (now - prev.timestamp) : null,
    keyDownDurationMs: null,
    visualLineIndex: null
  }, partial);
  state.telemetry.push(entry);
  return entry;
}

// Called from the existing keydown listener for keys that do NOT produce
// a text change (Shift, Arrow*, Tab, etc.) — logged immediately since no
// 'input' event will follow to log it instead.
function recordTelemetryNonCharacterKeydown(key){
  pushTelemetryEvent({
    key,
    isCharacterEvent: false,
    isBackspace: false,
    isCorrection: false,
    insertedText: null,
    removedText: null,
    typedChar: null,
    expectedChar: null,
    charOutcome: null,
    cursorPosition: null,
    wordIndex: null,
    charIndexInWord: null
  });
}

// Called from the existing 'input' listener for every actual text change.
// Reads the textarea directly rather than requiring the InputEvent object,
// so the existing listener only needs one extra line to call this.
function recordTelemetryCharacterEvent(){
  const area = $("#typingArea");
  const newValue = area.value;
  const oldValue = state.telemetryPrevValue;
  const { removed, inserted } = diffTelemetryValues(oldValue, newValue);
  state.telemetryPrevValue = newValue;

  const isCorrection = removed.length > 0 && inserted.length === 0;
  const { wordIndex, charIndexInWord } = computeTelemetryWordPosition(newValue);
  const expectedChar = isCorrection ? null : getExpectedCharForTelemetry(wordIndex, charIndexInWord);
  const typedChar = inserted.length ? inserted[inserted.length - 1] : null;

  let charOutcome = null;
  if(isCorrection){
    charOutcome = "deletion";
  } else if(typedChar != null){
    charOutcome = (expectedChar != null && typedChar === expectedChar) ? "correct" : "incorrect";
  }

  const pending = state.telemetryPendingKey;
  pushTelemetryEvent({
    key: pending ? pending.key : (typedChar || (isCorrection ? "Backspace" : "")),
    isCharacterEvent: true,
    isBackspace: isCorrection,
    isCorrection,
    insertedText: inserted.length ? inserted : null,
    removedText: removed.length ? removed : null,
    typedChar,
    expectedChar,
    charOutcome,
    cursorPosition: area.selectionStart,
    wordIndex,
    charIndexInWord
  });
}

// Pairs a keyup with the most recent still-open telemetry entry for the
// same key, to fill in keyDownDurationMs. Searches from the end since
// typing is effectively sequential; stops at the first match.
function recordTelemetryKeyUp(key){
  for(let i = state.telemetry.length - 1; i >= 0; i--){
    const entry = state.telemetry[i];
    if(entry.key === key && entry.keyDownDurationMs === null){
      const pending = state.telemetryPendingKey;
      if(pending && pending.key === key){
        entry.keyDownDurationMs = Date.now() - pending.timestamp;
      }
      break;
    }
  }
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

    // ---- Module 0 telemetry (additive only) ----
    // Stash this keydown so the matching 'input' event (for content keys)
    // or this same handler (for non-content keys) can use it, and so the
    // keyup handler can compute keyDownDurationMs.
    state.telemetryPendingKey = { key: e.key, timestamp: Date.now() };
    if(TELEMETRY_NON_CHARACTER_KEYS.has(e.key)){
      recordTelemetryNonCharacterKeydown(e.key);
    }
  });

  area.addEventListener("keyup", (e) => {
    // ---- Module 0 telemetry (additive only) ----
    recordTelemetryKeyUp(e.key);
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

    // ---- Module 0 telemetry (additive only) ----
    recordTelemetryCharacterEvent();
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
    typed: diff.typed,
    // Module 0: raw per-keystroke telemetry for future result-analysis
    // modules (heatmap, finger stats, pace trend, consistency, etc.).
    // Not read by any existing calculation above — purely additive.
    telemetry: state.telemetry.slice(),
    // ⚠ Authoritative diff reference. `diff` here is computeDiff()'s own,
    // completely untouched return value (the same object already used
    // above for diffRows/expected/typed/etc.) — nothing about computeDiff()
    // itself changed. This is just a single, clearly-named pointer so
    // future analytics modules have one obvious place to read the FINAL,
    // fully-realigned mistake data from, instead of the PRELIMINARY
    // per-keystroke expectedChar/charOutcome fields inside `telemetry`
    // above (which are live best-effort guesses only, see the field
    // comments in section 4b). Any module doing real analysis should
    // prefer result.finalDiff over telemetry[].expectedChar /
    // telemetry[].charOutcome whenever result.finalDiff is present.
    finalDiff: diff
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
  renderKeyPerformanceSummary(r);
  renderDetailedMistakeLog(r);
  renderMistakeBreakdown(r);
  lazyRenderOnVisible("paceSection", () => renderPaceAnalysis(r));
  renderCharacterPerformanceTable(r);
  lazyRenderOnVisible("keyboardHeatmapSection", () => renderKeyboardHeatmap(r));
  renderSpeedZones(r);
  renderConsistencyEfficiency(r);
  renderFingerPerformance(r);
  lazyRenderOnVisible("latencyHistogramSection", () => renderLatencyHistogram(r));
  renderStaminaQuarters(r);
  renderWastedTimeProductivity(r);
  renderOverallScore(r);
  renderAiCoach(r);
}

/* --------------------------------------------------------------------------
   MODULE 2 — Detailed Mistake Log (presentation layer over r.diffRows)
   --------------------------------------------------------------------------
   Source of truth: r.diffRows — computeDiff()'s own, untouched output,
   the exact same array already rendered by renderErrorTable() above. No
   new diff engine, no re-run of mistake classification.

     - Expected / Typed / Mistake Type / Position → row.expected /
       row.typed / row.type / row.position, read as-is (identical to
       renderErrorTable()).
     - Word # → also row.position. computeDiff() only ever tracks a
       word-level position (see its `position: op.expIndex + 1` — search
       script.js), so "Position" and "Word #" are necessarily the same
       existing number, just labeled for what it already is; no second
       position value exists to compute.
     - Char Index → findFirstCharDiffIndex(), a same-length, per-row
       character scan local to that one mistake's two words. This is the
       same, already-established pattern diagnostics.js uses for its
       "confused keys" analysis (see generateDiagnostics() in
       diagnostics.js) — not a new diff engine, and it only ever answers
       "which letter differs" for a single already-identified mistake
       word pair. Returns "—" when the two words differ in length (an
       insertion/omission has no single aligned character index).
     - Correction Status → always "Uncorrected at submission". Every row
       in r.diffRows is, by construction, a mistake found in the FINAL
       submitted text after every backspace/correction the candidate made
       was already applied — so anything still appearing here was, by
       definition, never corrected before submitting. No new state needs
       to be tracked to know this.
     - Timestamp → best-effort lookup into r.telemetry (Module 0),
       matching this mistake's word number to the last telemetry
       character-event recorded for that same word index. Telemetry's
       per-keystroke wordIndex is explicitly PRELIMINARY/live-tracked
       (see the Module 0 field comments) and can drift after a length-
       changing mistake — so this timestamp is an approximation, and is
       shown as "—" whenever no telemetry was captured or no matching
       event is found, never a guessed value.
   -------------------------------------------------------------------------- */
function findFirstCharDiffIndex(expected, typed){
  if(!expected || !typed || expected === "—" || typed === "—") return null;
  if(expected.length !== typed.length) return null; // no single aligned index
  for(let i = 0; i < expected.length; i++){
    if(expected[i].toLowerCase() !== typed[i].toLowerCase()) return i + 1; // 1-based
  }
  return null;
}

function findMistakeTelemetryElapsedMs(r, wordIndex){
  const events = r.telemetry;
  if(!events || !events.length) return null;
  for(let i = events.length - 1; i >= 0; i--){
    const ev = events[i];
    if(ev.isCharacterEvent && ev.wordIndex === wordIndex && ev.elapsedTestMs != null){
      return ev.elapsedTestMs;
    }
  }
  return null;
}

function renderDetailedMistakeLog(r){
  const tbody = $("#mistakeLogBody");
  tbody.innerHTML = "";

  if(!r.diffRows || r.diffRows.length === 0){
    $("#noMistakeLogNote").hidden = false;
    return;
  }
  $("#noMistakeLogNote").hidden = true;

  r.diffRows.forEach((row, idx) => {
    const wordNumber = row.position;               // existing value, see comment above
    const charIndex = findFirstCharDiffIndex(row.expected, row.typed);
    const elapsedMs = findMistakeTelemetryElapsedMs(r, wordNumber - 1);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(row.expected)}</td>
      <td>${escapeHtml(row.typed)}</td>
      <td>${row.type}</td>
      <td>${row.position}</td>
      <td>${wordNumber}</td>
      <td>${charIndex != null ? charIndex : "—"}</td>
      <td>Uncorrected at submission</td>
      <td>${elapsedMs != null ? (elapsedMs / 1000).toFixed(1) + "s" : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* --------------------------------------------------------------------------
   MODULE 4 — Mistake Calculation + Error Breakdown (presentation layer)
   --------------------------------------------------------------------------
   Source data, all already computed elsewhere:
     - r.fullMistakes / r.halfMistakes           → same fields Module 1 uses
     - r.diffRows                                → same rows Module 2/3 use
     - r.charsTyped                               → existing field
     - r.finalDiff.comparedCount                 → the authoritative diff
       reference added in the Module 0 improvement pass, read here for the
       first time by an actual module.

   "Accuracy Contribution" per category deliberately mirrors the SAME
   arithmetic shape the app's own accuracy% already uses — accuracy is
   ((comparedCount - fullMistakes - halfMistakes) / comparedCount) * 100,
   i.e. each mistake subtracts 1 unit from comparedCount regardless of
   full/half. So a category's contribution here is simply
   (that category's row count / comparedCount) * 100 — the same formula,
   applied per category instead of to the whole test. Nothing new is
   invented; row counts already equal the amount each op added to
   fullMistakes/halfMistakes (checked against computeDiff() above: every
   push to `rows` corresponds 1:1 with a +1 to one of those two counters).
   -------------------------------------------------------------------------- */
function mistakeCategoryLabel(rowType){
  return rowType.replace(/\s*\((full|half)\)\s*$/i, "").trim();
}

function renderMistakeBreakdown(r){
  const rows = r.diffRows || [];
  const totalMistakes = r.fullMistakes + r.halfMistakes;
  const comparedCount = r.finalDiff && typeof r.finalDiff.comparedCount === "number"
    ? r.finalDiff.comparedCount
    : null;

  $("#mbTotalMistakes").textContent = totalMistakes;
  $("#mbFullMistakes").textContent = r.fullMistakes;
  $("#mbHalfMistakes").textContent = r.halfMistakes;
  $("#mbErrorDensity").textContent = r.charsTyped > 0
    ? ((totalMistakes / r.charsTyped) * 100).toFixed(2)
    : "0.00";

  const tbody = $("#mbBreakdownBody");
  tbody.innerHTML = "";

  if(rows.length === 0){
    $("#mbNoMistakesNote").hidden = false;
    return;
  }
  $("#mbNoMistakesNote").hidden = true;

  const counts = {}; // label -> count, built purely by counting existing rows
  rows.forEach(row => {
    const label = mistakeCategoryLabel(row.type);
    counts[label] = (counts[label] || 0) + 1;
  });

  Object.keys(counts).forEach(label => {
    const count = counts[label];
    const pctOfMistakes = totalMistakes > 0 ? (count / totalMistakes) * 100 : 0;
    const accuracyContribution = comparedCount ? (count / comparedCount) * 100 : null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(label)}</td>
      <td>${count}</td>
      <td>
        <span class="mb-bar-track"><span class="mb-bar-fill" style="width:${pctOfMistakes.toFixed(0)}%"></span></span>
        ${pctOfMistakes.toFixed(1)}%
      </td>
      <td>${accuracyContribution != null ? "-" + accuracyContribution.toFixed(1) + "%" : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* --------------------------------------------------------------------------
   MODULE 5 — Pace Analysis (reads Module 0 telemetry only, read-only)
   --------------------------------------------------------------------------
   Instant WPM is bucketed from r.telemetry's existing elapsedTestMs
   field: characters actually inserted (isCharacterEvent && !isCorrection)
   are counted per fixed-size time bucket, then converted to WPM with the
   standard 5-chars-per-word convention. Bucket count is capped so a long
   passage still draws a bounded number of points (efficient for long
   passages, per the requirement) instead of one point per keystroke.

   Average WPM shown is r.netWpm — the SAME already-computed final speed
   used everywhere else in the app — not re-derived from telemetry, so
   this chart can never disagree with the score above it.

   Pauses reuse r.telemetry[].latencyMs (already captured by Module 0,
   untouched) — a pause is simply a latency above PACE_PAUSE_THRESHOLD_MS.
   This is the same "consuming modules decide their own pause threshold"
   design the Module 0 comments already called out.

   Rendering is a single native <canvas> 2D draw, once per result view —
   no animation loop, no external chart library — see the flag at the top
   of this response for why Chart.js specifically was not vendored in.
   -------------------------------------------------------------------------- */
const PACE_PAUSE_THRESHOLD_MS = 1000; // gaps above this are treated as a "pause" for the marker/count only

function computePaceBuckets(telemetry){
  const events = telemetry.filter(ev => ev.isCharacterEvent && !ev.isCorrection && ev.elapsedTestMs != null);
  if(events.length === 0) return null;

  const durationMs = Math.max.apply(null, events.map(ev => ev.elapsedTestMs));
  if(durationMs <= 0) return null;

  const bucketMs = Math.max(2000, Math.min(10000, durationMs / 40));
  const numBuckets = Math.max(1, Math.ceil(durationMs / bucketMs));
  const bucketCounts = new Array(numBuckets).fill(0);

  events.forEach(ev => {
    const idx = Math.min(numBuckets - 1, Math.floor(ev.elapsedTestMs / bucketMs));
    bucketCounts[idx] += 1;
  });

  const instantWpm = bucketCounts.map(count => (count / 5) / (bucketMs / 60000));

  return { instantWpm, bucketMs, numBuckets, durationMs };
}

function renderPaceAnalysis(r){
  const canvas = $("#paceChartCanvas");
  const telemetry = r.telemetry || [];
  const buckets = computePaceBuckets(telemetry);

  $("#paPauseThresholdNote").textContent = `gap over ${(PACE_PAUSE_THRESHOLD_MS / 1000).toFixed(1)}s`;

  if(!buckets){
    $("#paNoTelemetryNote").hidden = false;
    canvas.hidden = true;
    $("#paPeakWpm").textContent = "—";
    $("#paAvgWpm").textContent = r.netWpm + " WPM";
    $("#paPauseCount").textContent = "0";
    return;
  }
  $("#paNoTelemetryNote").hidden = true;
  canvas.hidden = false;

  const pausePositionsMs = telemetry
    .filter(ev => ev.latencyMs != null && ev.latencyMs > PACE_PAUSE_THRESHOLD_MS && ev.elapsedTestMs != null)
    .map(ev => ev.elapsedTestMs);

  const peakWpm = Math.max.apply(null, buckets.instantWpm);
  $("#paPeakWpm").textContent = Math.round(peakWpm);
  $("#paAvgWpm").textContent = r.netWpm + " WPM";
  $("#paPauseCount").textContent = pausePositionsMs.length;

  drawPaceChart(canvas, buckets, r.netWpm, pausePositionsMs);
}

function drawPaceChart(canvas, buckets, avgWpm, pausePositionsMs){
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssHeight = canvas.clientHeight || 220;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 16, right: 16, bottom: 24, left: 40 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const maxWpm = Math.max(avgWpm, Math.max.apply(null, buckets.instantWpm), 10) * 1.15;
  const styles = getComputedStyle(document.documentElement);
  const accentColor = (styles.getPropertyValue("--accent") || "#4C7EFF").trim() || "#4C7EFF";
  const gridColor = (styles.getPropertyValue("--surface-border") || "#333").trim() || "#333";
  const textColor = (styles.getPropertyValue("--text-secondary") || "#888").trim() || "#888";

  // Y axis grid + labels (0, mid, max)
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  [0, 0.5, 1].forEach(t => {
    const y = padding.top + plotH * (1 - t);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(Math.round(maxWpm * t) + "", 4, y + 4);
  });

  // Average WPM dashed reference line
  const avgY = padding.top + plotH * (1 - Math.min(avgWpm / maxWpm, 1));
  ctx.save();
  ctx.strokeStyle = textColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding.left, avgY);
  ctx.lineTo(padding.left + plotW, avgY);
  ctx.stroke();
  ctx.restore();

  // Instant WPM polyline
  const n = buckets.instantWpm.length;
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  buckets.instantWpm.forEach((wpm, i) => {
    const x = padding.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
    const y = padding.top + plotH * (1 - Math.min(wpm / maxWpm, 1));
    if(i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Pause markers along the x-axis
  ctx.fillStyle = "#FF8A5B";
  pausePositionsMs.forEach(ms => {
    const frac = buckets.durationMs > 0 ? Math.min(ms / buckets.durationMs, 1) : 0;
    const x = padding.left + plotW * frac;
    ctx.beginPath();
    ctx.arc(x, padding.top + plotH + 8, 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

/* --------------------------------------------------------------------------
   MODULE 6 — Character Performance Table (shared stats source)
   --------------------------------------------------------------------------
   buildCharacterPerformanceStats() is the ONE place per-character
   occurrence/correct/incorrect/latency numbers get aggregated from
   r.telemetry (Module 0, read-only). Module 7's heatmap reuses this
   exact function's output (see getMergedStatsForKey()) instead of
   re-aggregating telemetry itself — "no duplicate logic".

   charOutcome and latencyMs are the same PRELIMINARY, live, per-
   keystroke fields documented in Module 0 (see the field comments in
   section 4b) — correctness here is a live best-effort classification,
   not the final word-level diff engine. This is surfaced to the user
   via the hero-sub note above the table in index.html, not hidden.
   -------------------------------------------------------------------------- */
function buildCharacterPerformanceStats(telemetry){
  const stats = {}; // character -> { occurrences, correct, incorrect, latencies: number[] }
  (telemetry || []).forEach(ev => {
    if(!ev.isCharacterEvent || ev.isCorrection || ev.typedChar == null) return;
    const ch = ev.typedChar;
    if(!stats[ch]) stats[ch] = { occurrences: 0, correct: 0, incorrect: 0, latencies: [] };
    const s = stats[ch];
    s.occurrences += 1;
    if(ev.charOutcome === "correct") s.correct += 1;
    else if(ev.charOutcome === "incorrect") s.incorrect += 1;
    if(ev.latencyMs != null) s.latencies.push(ev.latencyMs);
  });
  return stats;
}

function summarizeLatencies(latencies){
  if(!latencies || latencies.length === 0) return { avg: null, fastest: null, slowest: null };
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    avg: sum / latencies.length,
    fastest: Math.min.apply(null, latencies),
    slowest: Math.max.apply(null, latencies)
  };
}

function renderCharacterPerformanceTable(r){
  const tbody = $("#charPerfBody");
  tbody.innerHTML = "";

  const stats = buildCharacterPerformanceStats(r.telemetry);
  const chars = Object.keys(stats);

  if(chars.length === 0){
    $("#charPerfNoDataNote").hidden = false;
    return;
  }
  $("#charPerfNoDataNote").hidden = true;

  // Slowest-first, matching the existing convention already used
  // elsewhere in the app's "confused keys" style diagnostics.
  chars.sort((a, b) => {
    const la = summarizeLatencies(stats[a].latencies).avg;
    const lb = summarizeLatencies(stats[b].latencies).avg;
    if(la == null && lb == null) return 0;
    if(la == null) return 1;
    if(lb == null) return -1;
    return lb - la;
  });

  chars.forEach(ch => {
    const s = stats[ch];
    const { avg, fastest, slowest } = summarizeLatencies(s.latencies);
    const accuracyPct = s.occurrences > 0 ? (s.correct / s.occurrences) * 100 : 0;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(ch === " " ? "Space" : ch)}</strong></td>
      <td>${s.occurrences}</td>
      <td>${s.correct}</td>
      <td>${s.incorrect}</td>
      <td>${accuracyPct.toFixed(0)}%</td>
      <td>${avg != null ? Math.round(avg) + "ms" : "—"}</td>
      <td>${fastest != null ? Math.round(fastest) + "ms" : "—"}</td>
      <td>${slowest != null ? Math.round(slowest) + "ms" : "—"}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* --------------------------------------------------------------------------
   MODULE 7 — Visual Keyboard Heatmap
   --------------------------------------------------------------------------
   Reuses buildCharacterPerformanceStats() (Module 6, above) as its only
   data source — no separate telemetry aggregation. Physical keys are
   case-insensitive (the "E" key produces both "e" and "E" depending on
   Shift), so getMergedStatsForKey() merges the lower/upper-case entries
   Module 6 already computed rather than re-scanning telemetry.
   Also reuses computeLatencyZoneThresholds() (below), shared with
   Module 8, so the two modules always agree on what "fast/slow" means
   for this attempt.
   Layout below is a static QWERTY key-position table (physical
   geometry, not performance data) — the same layout implied by the
   existing typing engine, which is QWERTY/English-only.
   -------------------------------------------------------------------------- */
const KEYBOARD_LAYOUT_ROWS = [
  ["1","2","3","4","5","6","7","8","9","0"],
  ["Q","W","E","R","T","Y","U","I","O","P"],
  ["A","S","D","F","G","H","J","K","L"],
  ["Z","X","C","V","B","N","M"]
];

function getMergedStatsForKey(charStats, keyLabel){
  const lower = charStats[keyLabel.toLowerCase()];
  const upper = charStats[keyLabel.toUpperCase()];
  if(!lower && !upper) return null;
  const merged = { occurrences: 0, correct: 0, incorrect: 0, latencies: [] };
  [lower, upper].forEach(s => {
    if(!s) return;
    merged.occurrences += s.occurrences;
    merged.correct += s.correct;
    merged.incorrect += s.incorrect;
    merged.latencies = merged.latencies.concat(s.latencies);
  });
  return merged;
}

// Tercile split of THIS attempt's own character-event latencies — an
// adaptive, data-derived boundary rather than a hardcoded speed
// assumption, so it's fair to both slow and fast typists. Shared by
// Module 7 (key color) and Module 8 (zone counts / bursts).
function computeLatencyZoneThresholds(telemetry){
  const latencies = (telemetry || [])
    .filter(ev => ev.isCharacterEvent && !ev.isCorrection && ev.latencyMs != null)
    .map(ev => ev.latencyMs)
    .sort((a, b) => a - b);
  if(latencies.length === 0) return null;
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  return { fastMax: pct(0.33), normalMax: pct(0.66) };
}

function latencyZoneColor(avgLatency, thresholds){
  if(avgLatency == null || !thresholds) return null;
  if(avgLatency <= thresholds.fastMax) return "#3DDC84";   // fast — green
  if(avgLatency <= thresholds.normalMax) return "#FFC24B"; // normal — amber
  return "#FF5A5A";                                         // slow — red
}

function renderKeyboardHeatmap(r){
  const host = $("#kbHeatmap");
  host.innerHTML = "";

  const charStats = buildCharacterPerformanceStats(r.telemetry);
  const thresholds = computeLatencyZoneThresholds(r.telemetry);
  const hasAnyData = Object.keys(charStats).length > 0;

  $("#kbHeatmapNoDataNote").hidden = hasAnyData;
  if(!hasAnyData){ return; }

  const maxOccurrences = Math.max.apply(null, Object.values(charStats).map(s => s.occurrences));

  const buildKeyEl = (label, isSpace) => {
    const stats = isSpace ? getMergedStatsForKey(charStats, " ") : getMergedStatsForKey(charStats, label);
    const el = document.createElement("div");
    el.className = "kb-key" + (isSpace ? " kb-space" : "");
    el.textContent = isSpace ? "SPACE" : label;

    if(!stats || stats.occurrences === 0){
      el.classList.add("kb-nodata");
      el.setAttribute("data-tooltip", "Not pressed");
      return el;
    }

    const { avg } = summarizeLatencies(stats.latencies);
    const accuracyPct = stats.occurrences > 0 ? (stats.correct / stats.occurrences) * 100 : 0;
    const color = latencyZoneColor(avg, thresholds);
    if(color){
      const intensity = 0.25 + 0.65 * (stats.occurrences / maxOccurrences); // frequency → opacity
      el.style.background = color;
      el.style.opacity = intensity.toFixed(2);
      el.style.color = "#111";
      el.style.borderColor = color;
    }
    el.setAttribute("data-tooltip",
      `Presses: ${stats.occurrences}\nAccuracy: ${accuracyPct.toFixed(0)}%\nAvg latency: ${avg != null ? Math.round(avg) + "ms" : "—"}`
    );
    return el;
  };

  KEYBOARD_LAYOUT_ROWS.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";
    row.forEach(label => rowEl.appendChild(buildKeyEl(label, false)));
    host.appendChild(rowEl);
  });

  const spaceRow = document.createElement("div");
  spaceRow.className = "kb-row";
  spaceRow.appendChild(buildKeyEl("SPACE", true));
  host.appendChild(spaceRow);
}

/* --------------------------------------------------------------------------
   MODULE 8 — Speed Zones & Fast Bursts
   --------------------------------------------------------------------------
   Zones reuse computeLatencyZoneThresholds() (Module 7, above) — same
   tercile boundaries, so Module 7's key colors and this module's zone
   percentages always describe the same "fast/normal/slow" for this
   attempt. A burst is MIN_BURST_LENGTH or more CONSECUTIVE character
   events that all land in the fast zone; this is genuinely new
   aggregation over Module 0's raw sequence (not a duplicate of
   anything computed elsewhere), but it never writes back to telemetry.
   Pause locations reuse Module 5's own PACE_PAUSE_THRESHOLD_MS constant
   (defined above, not redefined here) so pauses mean the same thing in
   both modules without touching Module 5's (locked) code.
   -------------------------------------------------------------------------- */
const MIN_BURST_LENGTH = 3; // fewer than this is just "a couple of fast keys", not a sustained burst

function findFastBursts(telemetry, thresholds){
  if(!thresholds) return [];
  const events = (telemetry || []).filter(ev => ev.isCharacterEvent && !ev.isCorrection && ev.latencyMs != null);
  const bursts = [];
  let run = [];

  const flushRun = () => {
    if(run.length >= MIN_BURST_LENGTH){
      const sum = run.reduce((a, b) => a + b.latencyMs, 0);
      bursts.push({
        length: run.length,
        avgLatency: sum / run.length,
        startMs: run[0].elapsedTestMs,
        endMs: run[run.length - 1].elapsedTestMs
      });
    }
    run = [];
  };

  events.forEach(ev => {
    if(ev.latencyMs <= thresholds.fastMax){
      run.push(ev);
    }else{
      flushRun();
    }
  });
  flushRun();

  return bursts;
}

function renderSpeedZones(r){
  const telemetry = r.telemetry || [];
  const thresholds = computeLatencyZoneThresholds(telemetry);
  const charEvents = telemetry.filter(ev => ev.isCharacterEvent && !ev.isCorrection && ev.latencyMs != null);

  if(!thresholds || charEvents.length === 0){
    $("#szNoDataNote").hidden = false;
    return;
  }
  $("#szNoDataNote").hidden = true;

  let slow = 0, normal = 0, fast = 0;
  charEvents.forEach(ev => {
    if(ev.latencyMs <= thresholds.fastMax) fast += 1;
    else if(ev.latencyMs <= thresholds.normalMax) normal += 1;
    else slow += 1;
  });
  const total = charEvents.length;

  $("#szSlowPct").textContent = ((slow / total) * 100).toFixed(0) + "%";
  $("#szSlowCount").textContent = `${slow} keys · above ${Math.round(thresholds.normalMax)}ms`;
  $("#szNormalPct").textContent = ((normal / total) * 100).toFixed(0) + "%";
  $("#szNormalCount").textContent = `${normal} keys · ${Math.round(thresholds.fastMax)}–${Math.round(thresholds.normalMax)}ms`;
  $("#szFastPct").textContent = ((fast / total) * 100).toFixed(0) + "%";
  $("#szFastCount").textContent = `${fast} keys · below ${Math.round(thresholds.fastMax)}ms`;

  const bursts = findFastBursts(telemetry, thresholds);
  if(bursts.length === 0){
    $("#szFastestBurst").textContent = "None detected";
    $("#szLongestBurst").textContent = "None detected";
    $("#szAvgBurst").textContent = "None detected";
  }else{
    const fastest = bursts.reduce((best, b) => (b.avgLatency < best.avgLatency ? b : best));
    const longest = bursts.reduce((best, b) => (b.length > best.length ? b : best));
    const avgLen = bursts.reduce((sum, b) => sum + b.length, 0) / bursts.length;
    $("#szFastestBurst").textContent = `${Math.round(fastest.avgLatency)}ms avg (${fastest.length} keys)`;
    $("#szLongestBurst").textContent = `${longest.length} keys`;
    $("#szAvgBurst").textContent = `${avgLen.toFixed(1)} keys`;
  }

  const pauseHost = $("#szPauseLocations");
  pauseHost.innerHTML = "";
  const pauses = telemetry.filter(ev => ev.latencyMs != null && ev.latencyMs > PACE_PAUSE_THRESHOLD_MS && ev.elapsedTestMs != null);
  const MAX_PAUSE_CHIPS = 20;
  pauses.slice(0, MAX_PAUSE_CHIPS).forEach(ev => {
    const chip = document.createElement("span");
    chip.className = "pause-chip";
    chip.textContent = `${(ev.elapsedTestMs / 1000).toFixed(1)}s`;
    pauseHost.appendChild(chip);
  });
  if(pauses.length > MAX_PAUSE_CHIPS){
    const more = document.createElement("span");
    more.className = "pause-chip";
    more.textContent = `+${pauses.length - MAX_PAUSE_CHIPS} more`;
    pauseHost.appendChild(more);
  }
}

/* --------------------------------------------------------------------------
   Small shared math utilities for Modules 9-12 (new in this batch, used by
   more than one of them — written once here rather than duplicated).
   -------------------------------------------------------------------------- */
function percentile(sortedAsc, p){
  if(!sortedAsc || sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

function coefficientOfVariationPct(values){
  if(!values || values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if(mean === 0) return null;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return (stdDev / mean) * 100;
}

// consistency% = 100 when there's zero variation, trending toward 0 as
// variation grows — used by Module 9 for WPM/accuracy/rhythm consistency.
function consistencyPctFromCV(cv){
  if(cv == null) return null;
  return Math.max(0, Math.min(100, 100 - cv));
}

// Shared by Module 9 (whole-test efficiency) and Module 12 (per-quarter
// productivity) — same definition, one implementation.
function productivityPct(activeMs, totalMs){
  if(!totalMs || totalMs <= 0) return null;
  return Math.max(0, Math.min(100, (activeMs / totalMs) * 100));
}

function getCharacterEventsWithLatency(telemetry){
  return (telemetry || []).filter(ev => ev.isCharacterEvent && !ev.isCorrection && ev.latencyMs != null);
}

/* --------------------------------------------------------------------------
   MODULE 9 — Consistency & Efficiency
   --------------------------------------------------------------------------
   - WPM Consistency   → CV of computePaceBuckets()'s own instantWpm series
                          (Module 5, locked function, called here — not
                          re-bucketed).
   - Rhythm Stability   → CV of every character event's latencyMs (Module 0,
                          read-only).
   - Accuracy Consistency → CV of per-bucket accuracy%, using the SAME
                          bucketMs/numBuckets computePaceBuckets() already
                          chose, so the time slicing matches WPM Consistency
                          exactly.
   - Avg/Longest Pause  → mean/max of latencyMs for events over Module 5's
                          own PACE_PAUSE_THRESHOLD_MS (not a new threshold).
   - Idle/Productive/Efficiency → idle = sum of those pause latencies;
                          productive = total duration - idle; efficiency%
                          via the shared productivityPct() above.
   -------------------------------------------------------------------------- */
function renderConsistencyEfficiency(r){
  const telemetry = r.telemetry || [];
  const buckets = computePaceBuckets(telemetry); // Module 5, reused as-is
  const charEvents = getCharacterEventsWithLatency(telemetry);

  if(!buckets || charEvents.length === 0){
    $("#ceNoDataNote").hidden = false;
    return;
  }
  $("#ceNoDataNote").hidden = true;

  const wpmConsistency = consistencyPctFromCV(coefficientOfVariationPct(buckets.instantWpm));
  const rhythmStability = consistencyPctFromCV(coefficientOfVariationPct(charEvents.map(ev => ev.latencyMs)));

  // Per-bucket accuracy, reusing computePaceBuckets()'s own bucketMs/numBuckets.
  const accBucketTotals = new Array(buckets.numBuckets).fill(0);
  const accBucketCorrect = new Array(buckets.numBuckets).fill(0);
  charEvents.forEach(ev => {
    if(ev.charOutcome !== "correct" && ev.charOutcome !== "incorrect") return;
    const idx = Math.min(buckets.numBuckets - 1, Math.floor(ev.elapsedTestMs / buckets.bucketMs));
    accBucketTotals[idx] += 1;
    if(ev.charOutcome === "correct") accBucketCorrect[idx] += 1;
  });
  const accBucketPcts = accBucketTotals
    .map((total, i) => (total > 0 ? (accBucketCorrect[i] / total) * 100 : null))
    .filter(v => v != null);
  const accuracyConsistency = consistencyPctFromCV(coefficientOfVariationPct(accBucketPcts));

  const pauseEvents = charEvents.filter(ev => ev.latencyMs > PACE_PAUSE_THRESHOLD_MS);
  const idleMs = pauseEvents.reduce((sum, ev) => sum + ev.latencyMs, 0);
  const productiveMs = Math.max(0, buckets.durationMs - idleMs);
  const avgPauseMs = pauseEvents.length ? idleMs / pauseEvents.length : null;
  const longestPauseMs = pauseEvents.length ? Math.max.apply(null, pauseEvents.map(ev => ev.latencyMs)) : null;
  const efficiency = productivityPct(productiveMs, buckets.durationMs);

  $("#ceWpmConsistency").textContent = wpmConsistency != null ? wpmConsistency.toFixed(0) + "%" : "—";
  $("#ceAccConsistency").textContent = accuracyConsistency != null ? accuracyConsistency.toFixed(0) + "%" : "—";
  $("#ceRhythmStability").textContent = rhythmStability != null ? rhythmStability.toFixed(0) + "%" : "—";
  $("#ceAvgPause").textContent = avgPauseMs != null ? (avgPauseMs / 1000).toFixed(2) + "s" : "None detected";
  $("#ceLongestPause").textContent = longestPauseMs != null ? (longestPauseMs / 1000).toFixed(2) + "s" : "None detected";
  $("#ceProductiveTime").textContent = (productiveMs / 1000).toFixed(1) + "s";
  $("#ceIdleTime").textContent = (idleMs / 1000).toFixed(1) + "s";
  $("#ceEfficiency").textContent = efficiency != null ? efficiency.toFixed(0) + "%" : "—";
}

/* --------------------------------------------------------------------------
   MODULE 10 — Finger Performance
   --------------------------------------------------------------------------
   FINGER_KEY_MAP is a static, standard touch-typing convention (physical
   assignment of keys to fingers) — same category as Module 7's
   KEYBOARD_LAYOUT_ROWS, not performance data. Every number below comes
   from Module 6/7's already-computed per-key stats via
   getMergedStatsForKey() — this module only groups those existing
   numbers by finger, it does not re-read telemetry itself.
   -------------------------------------------------------------------------- */
const FINGER_KEY_MAP = {
  "1":"L-Pinky","2":"L-Ring","3":"L-Middle","4":"L-Index","5":"L-Index",
  "Q":"L-Pinky","W":"L-Ring","E":"L-Middle","R":"L-Index","T":"L-Index",
  "A":"L-Pinky","S":"L-Ring","D":"L-Middle","F":"L-Index","G":"L-Index",
  "Z":"L-Pinky","X":"L-Ring","C":"L-Middle","V":"L-Index","B":"L-Index",
  "6":"R-Index","7":"R-Index","8":"R-Middle","9":"R-Ring","0":"R-Pinky",
  "Y":"R-Index","U":"R-Index","I":"R-Middle","O":"R-Ring","P":"R-Pinky",
  "H":"R-Index","J":"R-Index","K":"R-Middle","L":"R-Ring",
  "N":"R-Index","M":"R-Index",
  " ":"Thumb"
};
const FINGER_DISPLAY_ORDER = ["L-Pinky","L-Ring","L-Middle","L-Index","R-Index","R-Middle","R-Ring","R-Pinky","Thumb"];

function renderFingerPerformance(r){
  const tbody = $("#fingerPerfBody");
  tbody.innerHTML = "";

  const charStats = buildCharacterPerformanceStats(r.telemetry); // Module 6, reused
  if(Object.keys(charStats).length === 0){
    $("#fingerPerfNoDataNote").hidden = false;
    return;
  }
  $("#fingerPerfNoDataNote").hidden = true;

  // Group the map's keys by finger once.
  const keysByFinger = {};
  Object.keys(FINGER_KEY_MAP).forEach(key => {
    const finger = FINGER_KEY_MAP[key];
    (keysByFinger[finger] = keysByFinger[finger] || []).push(key);
  });

  const fingerTotals = {}; // finger -> { occurrences, correct, latencies:[], perKey: {key: stats} }
  let grandTotalOccurrences = 0;

  FINGER_DISPLAY_ORDER.forEach(finger => {
    const totals = { occurrences: 0, correct: 0, latencies: [], perKey: {} };
    (keysByFinger[finger] || []).forEach(key => {
      const stats = getMergedStatsForKey(charStats, key); // Module 7, reused
      if(!stats || stats.occurrences === 0) return;
      totals.occurrences += stats.occurrences;
      totals.correct += stats.correct;
      totals.latencies = totals.latencies.concat(stats.latencies);
      totals.perKey[key] = stats;
    });
    fingerTotals[finger] = totals;
    grandTotalOccurrences += totals.occurrences;
  });

  FINGER_DISPLAY_ORDER.forEach(finger => {
    const totals = fingerTotals[finger];
    if(totals.occurrences === 0) return; // nothing pressed with this finger — omit rather than show fake zeros

    const { avg } = summarizeLatencies(totals.latencies); // Module 6, reused
    const accuracyPct = (totals.correct / totals.occurrences) * 100;
    const contributionPct = grandTotalOccurrences > 0 ? (totals.occurrences / grandTotalOccurrences) * 100 : 0;

    const problemKeys = Object.keys(totals.perKey)
      .map(key => ({ key, incorrect: totals.perKey[key].incorrect, occurrences: totals.perKey[key].occurrences }))
      .filter(k => k.incorrect > 0)
      .sort((a, b) => b.incorrect - a.incorrect)
      .slice(0, 2)
      .map(k => `${k.key} (${k.incorrect}x)`)
      .join(", ") || "None";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${finger}</strong></td>
      <td>${totals.occurrences}</td>
      <td>${accuracyPct.toFixed(0)}%</td>
      <td>${avg != null ? Math.round(avg) + "ms" : "—"}</td>
      <td>${contributionPct.toFixed(1)}%</td>
      <td>${escapeHtml(problemKeys)}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* --------------------------------------------------------------------------
   MODULE 11 — Latency Histogram
   --------------------------------------------------------------------------
   Stats/bins computed purely from Module 0's r.telemetry latencyMs
   values. percentile() above is a fresh, generic helper (median = p50,
   95th = p95) — not a copy of Module 7's internal tercile closure, which
   is private to that (locked) function and only ever computes 33rd/66th.
   Rendered with one native <canvas> bar draw — see the Module 5-style
   offline-dependency note in index.html.
   -------------------------------------------------------------------------- */
const LATENCY_HISTOGRAM_BINS = [
  { label: "<100", min: 0, max: 100 },
  { label: "100-200", min: 100, max: 200 },
  { label: "200-300", min: 200, max: 300 },
  { label: "300-500", min: 300, max: 500 },
  { label: "500-1k", min: 500, max: 1000 },
  { label: "1k+", min: 1000, max: Infinity }
];

function renderLatencyHistogram(r){
  const canvas = $("#latencyHistogramCanvas");
  const latencies = getCharacterEventsWithLatency(r.telemetry).map(ev => ev.latencyMs).sort((a, b) => a - b);

  if(latencies.length === 0){
    $("#lhNoDataNote").hidden = false;
    canvas.hidden = true;
    ["lhAverage","lhMedian","lhP95","lhFastest","lhSlowest"].forEach(id => $("#" + id).textContent = "—");
    return;
  }
  $("#lhNoDataNote").hidden = true;
  canvas.hidden = false;

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const median = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const fastest = latencies[0];
  const slowest = latencies[latencies.length - 1];

  $("#lhAverage").textContent = Math.round(avg) + "ms";
  $("#lhMedian").textContent = Math.round(median) + "ms";
  $("#lhP95").textContent = Math.round(p95) + "ms";
  $("#lhFastest").textContent = Math.round(fastest) + "ms";
  $("#lhSlowest").textContent = Math.round(slowest) + "ms";

  const binCounts = LATENCY_HISTOGRAM_BINS.map(bin =>
    latencies.filter(ms => ms >= bin.min && ms < bin.max).length
  );

  drawLatencyHistogram(canvas, binCounts);
}

function drawLatencyHistogram(canvas, binCounts){
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const cssHeight = canvas.clientHeight || 220;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 16, right: 16, bottom: 28, left: 32 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;
  const maxCount = Math.max.apply(null, binCounts.concat([1]));

  const styles = getComputedStyle(document.documentElement);
  const accentColor = (styles.getPropertyValue("--accent") || "#4C7EFF").trim() || "#4C7EFF";
  const textColor = (styles.getPropertyValue("--text-secondary") || "#888").trim() || "#888";

  ctx.fillStyle = textColor;
  ctx.font = "11px sans-serif";

  const n = binCounts.length;
  const gap = 10;
  const barW = (plotW - gap * (n - 1)) / n;

  binCounts.forEach((count, i) => {
    const barH = maxCount > 0 ? (count / maxCount) * plotH : 0;
    const x = padding.left + i * (barW + gap);
    const y = padding.top + (plotH - barH);
    ctx.fillStyle = accentColor;
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.fillText(String(count), x + barW / 2, y - 4);
    ctx.fillText(LATENCY_HISTOGRAM_BINS[i].label, x + barW / 2, padding.top + plotH + 16);
  });
  ctx.textAlign = "start";
}

/* --------------------------------------------------------------------------
   MODULE 12 — Stamina / Quarter Analysis
   --------------------------------------------------------------------------
   Total duration is computePaceBuckets()'s own durationMs (Module 5,
   locked, reused). That span is split into 4 equal time windows. Net/
   Gross WPM and Accuracy per quarter are derived from telemetry's
   PRELIMINARY charOutcome (same live-classification caveat as Modules
   0/6/9/10 — not the final diff engine, which only scores the whole
   test, not quarters of it). Pause time reuses Module 5's
   PACE_PAUSE_THRESHOLD_MS; Productivity reuses Module 9's shared
   productivityPct() helper above.
   -------------------------------------------------------------------------- */
function renderStaminaQuarters(r){
  const tbody = $("#staminaBody");
  tbody.innerHTML = "";
  $("#staminaTrendNote").textContent = "";

  const telemetry = r.telemetry || [];
  const buckets = computePaceBuckets(telemetry); // Module 5, reused
  const charEvents = getCharacterEventsWithLatency(telemetry);

  if(!buckets || charEvents.length === 0){
    $("#staminaNoDataNote").hidden = false;
    return;
  }
  $("#staminaNoDataNote").hidden = true;

  const quarterMs = buckets.durationMs / 4;
  const quarters = [0, 1, 2, 3].map(q => ({
    startMs: q * quarterMs,
    endMs: (q + 1) * quarterMs,
    chars: 0, correct: 0, incorrect: 0, pauseMs: 0
  }));

  const quarterIndexFor = (ms) => Math.min(3, Math.floor(ms / quarterMs));

  charEvents.forEach(ev => {
    const q = quarters[quarterIndexFor(ev.elapsedTestMs)];
    q.chars += 1;
    if(ev.charOutcome === "correct") q.correct += 1;
    else if(ev.charOutcome === "incorrect") q.incorrect += 1;
    if(ev.latencyMs > PACE_PAUSE_THRESHOLD_MS) q.pauseMs += ev.latencyMs;
  });

  const netWpms = [];
  quarters.forEach((q, i) => {
    const minutes = quarterMs / 60000;
    const grossWpm = minutes > 0 ? (q.chars / 5) / minutes : 0;
    const netWpm = minutes > 0 ? (q.correct / 5) / minutes : 0;
    const accuracyPct = q.chars > 0 ? (q.correct / q.chars) * 100 : 0;
    const productivity = productivityPct(quarterMs - q.pauseMs, quarterMs);
    netWpms.push(netWpm);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>Q${i + 1}</td>
      <td>${Math.round(netWpm)}</td>
      <td>${Math.round(grossWpm)}</td>
      <td>${accuracyPct.toFixed(0)}%</td>
      <td>${q.incorrect}</td>
      <td>${(q.pauseMs / 1000).toFixed(1)}s</td>
      <td>${productivity != null ? productivity.toFixed(0) + "%" : "—"}</td>
    `;
    tbody.appendChild(tr);
  });

  const firstQ = netWpms[0];
  const lastQ = netWpms[netWpms.length - 1];
  if(firstQ > 0){
    const changePct = ((lastQ - firstQ) / firstQ) * 100;
    if(Math.abs(changePct) < 5){
      $("#staminaTrendNote").textContent = "Speed held roughly steady from Q1 to Q4.";
    }else if(changePct > 0){
      $("#staminaTrendNote").textContent = `Speed improved ${changePct.toFixed(0)}% from Q1 to Q4.`;
    }else{
      $("#staminaTrendNote").textContent = `Speed declined ${Math.abs(changePct).toFixed(0)}% from Q1 to Q4.`;
    }
  }
}

/* --------------------------------------------------------------------------
   MODULE 13 — Wasted Time & Productivity
   --------------------------------------------------------------------------
   computeIdlePauseStats() reuses Module 9's own shared building blocks
   (getCharacterEventsWithLatency, Module 5's PACE_PAUSE_THRESHOLD_MS,
   Module 9's productivityPct) rather than re-deriving idle/pause math.
   NOTE (documented plainly, not hidden): Module 9's Consistency &
   Efficiency dashboard already shows very similar figures. That overlap
   exists only because Module 9's render function never exposed its
   internal numbers for reuse and is locked — this is the closest this
   batch can get to "no duplicate calculations" given that constraint.
   -------------------------------------------------------------------------- */
function computeIdlePauseStats(telemetry, buckets){
  const charEvents = getCharacterEventsWithLatency(telemetry); // Module 9, reused
  const pauseEvents = charEvents.filter(ev => ev.latencyMs > PACE_PAUSE_THRESHOLD_MS); // Module 5's constant, reused
  const idleMs = pauseEvents.reduce((sum, ev) => sum + ev.latencyMs, 0);
  const durationMs = buckets ? buckets.durationMs : null;
  const activeMs = durationMs != null ? Math.max(0, durationMs - idleMs) : null;
  return {
    idleMs,
    activeMs,
    durationMs,
    pauseCount: pauseEvents.length,
    avgPauseMs: pauseEvents.length ? idleMs / pauseEvents.length : null,
    longestPauseMs: pauseEvents.length ? Math.max.apply(null, pauseEvents.map(ev => ev.latencyMs)) : null
  };
}

function renderWastedTimeProductivity(r){
  const telemetry = r.telemetry || [];
  const buckets = computePaceBuckets(telemetry); // Module 5, reused
  const stats = computeIdlePauseStats(telemetry, buckets);

  if(!buckets || stats.durationMs == null){
    $("#wtNoDataNote").hidden = false;
    return;
  }
  $("#wtNoDataNote").hidden = true;

  const productivePct = productivityPct(stats.activeMs, stats.durationMs); // Module 9, reused
  const wastedPct = productivePct != null ? 100 - productivePct : null;

  $("#wtIdleTime").textContent = (stats.idleMs / 1000).toFixed(1) + "s";
  $("#wtActiveTime").textContent = (stats.activeMs / 1000).toFixed(1) + "s";
  $("#wtLongestPause").textContent = stats.longestPauseMs != null ? (stats.longestPauseMs / 1000).toFixed(2) + "s" : "None detected";
  $("#wtPauseCount").textContent = stats.pauseCount;
  $("#wtAvgPause").textContent = stats.avgPauseMs != null ? (stats.avgPauseMs / 1000).toFixed(2) + "s" : "None detected";
  $("#wtWastedPct").textContent = wastedPct != null ? wastedPct.toFixed(0) + "%" : "—";
  $("#wtProductivePct").textContent = productivePct != null ? productivePct.toFixed(0) + "%" : "—";

  if(productivePct != null){
    $("#wtBarActive").style.width = productivePct.toFixed(1) + "%";
    $("#wtBarIdle").style.width = (100 - productivePct).toFixed(1) + "%";
  }
}

/* --------------------------------------------------------------------------
   MODULE 14 — Overall Typing Performance Score
   --------------------------------------------------------------------------
   Every component reuses an already-computed value — see the comment on
   the section in index.html for the full list. SCORE_WEIGHTS are the
   only fixed constants here (a scoring rubric, not typing data) and are
   visible/documented, not hidden inside a formula.
   -------------------------------------------------------------------------- */
const SCORE_WEIGHTS = { speed: 20, accuracy: 25, consistency: 15, stamina: 10, errorControl: 15, productivity: 15 };

function computeSpeedScore(r){
  const qualifyWpm = state.settings.qualifyWpm || DEFAULT_SETTINGS.qualifyWpm; // existing setting, reused
  if(!qualifyWpm) return null;
  // Reaching 1.5x the app's own qualifying speed maps to a full 100 —
  // qualifyWpm itself (a "just passing" speed) lands at ~67.
  return Math.max(0, Math.min(100, (r.netWpm / (qualifyWpm * 1.5)) * 100));
}

function computeConsistencyScore(telemetry, buckets){
  if(!buckets) return null;
  const wpmConsistency = consistencyPctFromCV(coefficientOfVariationPct(buckets.instantWpm)); // Module 9, reused
  const charEvents = getCharacterEventsWithLatency(telemetry);
  const rhythmStability = consistencyPctFromCV(coefficientOfVariationPct(charEvents.map(ev => ev.latencyMs))); // Module 9, reused
  const parts = [wpmConsistency, rhythmStability].filter(v => v != null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

// Only Q1 vs Q4 net-WPM-from-correct-chars — the same telemetry-based
// approximation Module 12 already uses per quarter, scoped down to just
// the two quarters needed for a stamina score.
function computeStaminaScore(telemetry, buckets){
  if(!buckets) return null;
  const quarterMs = buckets.durationMs / 4;
  if(quarterMs <= 0) return null;
  const charEvents = getCharacterEventsWithLatency(telemetry);
  const q1Correct = charEvents.filter(ev => ev.elapsedTestMs < quarterMs && ev.charOutcome === "correct").length;
  const q4Correct = charEvents.filter(ev => ev.elapsedTestMs >= quarterMs * 3 && ev.charOutcome === "correct").length;
  const minutes = quarterMs / 60000;
  if(minutes <= 0) return null;
  const q1Wpm = (q1Correct / 5) / minutes;
  const q4Wpm = (q4Correct / 5) / minutes;
  if(q1Wpm <= 0) return null;
  const changePct = ((q4Wpm - q1Wpm) / q1Wpm) * 100;
  return Math.max(0, Math.min(100, 100 + Math.min(0, changePct))); // only decline is penalized; flat/improved caps at 100
}

function computeErrorControlScore(r){
  if(!r.charsTyped) return null;
  const totalMistakes = r.fullMistakes + r.halfMistakes; // existing fields, reused
  const density = (totalMistakes / r.charsTyped) * 100;  // same "error density" concept as Module 4
  return Math.max(0, Math.min(100, 100 - density * 10));
}

function computeProductivityScore(telemetry, buckets){
  const stats = computeIdlePauseStats(telemetry, buckets); // Module 13, reused
  return productivityPct(stats.activeMs, stats.durationMs);
}

function computeOverallScore(r){
  const telemetry = r.telemetry || [];
  const buckets = computePaceBuckets(telemetry); // Module 5, reused

  const components = {
    speed: computeSpeedScore(r),
    accuracy: r.accuracy, // existing field, used as-is
    consistency: computeConsistencyScore(telemetry, buckets),
    stamina: computeStaminaScore(telemetry, buckets),
    errorControl: computeErrorControlScore(r),
    productivity: computeProductivityScore(telemetry, buckets)
  };

  let weightedSum = 0, weightTotal = 0;
  Object.keys(SCORE_WEIGHTS).forEach(key => {
    if(components[key] != null){
      weightedSum += components[key] * SCORE_WEIGHTS[key];
      weightTotal += SCORE_WEIGHTS[key];
    }
  });

  return { overall: weightTotal > 0 ? weightedSum / weightTotal : null, components };
}

function gradeForScore(score){
  if(score == null) return "—";
  if(score >= 90) return "A+";
  if(score >= 80) return "A";
  if(score >= 70) return "B";
  if(score >= 60) return "C";
  if(score >= 50) return "D";
  return "F";
}

function scoreComponentLabel(key){
  return ({ speed:"Speed", accuracy:"Accuracy", consistency:"Consistency",
            stamina:"Stamina", errorControl:"Error Control", productivity:"Productivity" })[key] || key;
}

// Compares this attempt's Net WPM against this SAME device's own past
// attempts, via the app's existing loadHistory() (localStorage) — the
// only "existing data" available for a percentile in a fully offline,
// single-user app. saveHistoryEntry(result) already ran before
// renderResultScreen() (see finishTest()), so history[0] is THIS
// attempt — excluded below so it isn't compared against itself.
function computeWpmPercentile(r){
  const past = loadHistory().slice(1).map(h => h.netWpm).filter(v => typeof v === "number");
  if(past.length === 0) return null;
  const beaten = past.filter(w => w <= r.netWpm).length;
  return (beaten / past.length) * 100;
}

function renderOverallScore(r){
  const { overall, components } = computeOverallScore(r);

  $("#ospScore").textContent = overall != null ? Math.round(overall) : "—";
  $("#ospGrade").textContent = gradeForScore(overall);

  const percentile = computeWpmPercentile(r);
  $("#ospPercentile").textContent = percentile != null
    ? `Net WPM faster than ${percentile.toFixed(0)}% of your past attempts on this device`
    : "Not enough attempt history on this device yet for a percentile";

  const tbody = $("#ospComponentBody");
  tbody.innerHTML = "";
  Object.keys(SCORE_WEIGHTS).forEach(key => {
    const value = components[key];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${scoreComponentLabel(key)}</td>
      <td>${value != null ? Math.round(value) + "/100" : "—"}</td>
      <td>${SCORE_WEIGHTS[key]}%</td>
    `;
    tbody.appendChild(tr);
  });
}

/* --------------------------------------------------------------------------
   MODULE 15 — Final Results Dashboard (integration layer)
   --------------------------------------------------------------------------
   Pure orchestration/UX glue over the modules already built above.
   Does not alter any locked module's internal implementation:
     - lazyRenderOnVisible() only changes WHEN Module 5/7/11's render
       functions get called (via IntersectionObserver), never what they
       do — their function bodies are untouched.
     - initDashboardSectionToggles() adds click-to-collapse behaviour by
       toggling a class on each .dashboard-section wrapper; it never
       touches a section's inner markup/content.
     - Smooth scrolling for the nav links is a single `scroll-behavior:
       smooth` CSS rule (style.css), not new JS.
   -------------------------------------------------------------------------- */
function lazyRenderOnVisible(sectionId, renderFn){
  const el = document.getElementById(sectionId);
  if(!el){ renderFn(); return; }

  if(typeof IntersectionObserver === "undefined"){
    renderFn(); // graceful fallback — still renders, just not lazily
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        renderFn();
        observer.disconnect();
      }
    });
  }, { rootMargin: "150px" });

  observer.observe(el);
}

function initDashboardSectionToggles(){
  document.querySelectorAll(".dashboard-section > h2").forEach(h2 => {
    if(h2.dataset.collapseWired) return; // avoid double-binding across re-renders
    h2.dataset.collapseWired = "1";
    h2.addEventListener("click", () => {
      h2.parentElement.classList.toggle("collapsed");
    });
  });
}

/* --------------------------------------------------------------------------
   MODULE 16 — AI Coach (deterministic rules only — no external AI API)
   --------------------------------------------------------------------------
   Every tip is a simple if/else rule over values already computed
   elsewhere: computeOverallScore() (Module 14) for strength/weakness/
   priority list; getMistakeCategoryCounts() (a small fresh grouping of
   the same r.diffRows Module 4 already groups — Module 4's own grouping
   is inline in its locked render function and not exported, so this is
   the same situation as Module 13 vs Module 9) for the most common
   mistake; buildCharacterPerformanceStats()/aggregateFingerStats() for
   the weakest character/finger; computeStaminaScore() (Module 14) for
   stamina advice. No network calls anywhere in this function.
   -------------------------------------------------------------------------- */
function getMistakeCategoryCounts(diffRows){
  const counts = {};
  (diffRows || []).forEach(row => {
    const label = mistakeCategoryLabel(row.type); // Module 4, reused
    counts[label] = (counts[label] || 0) + 1;
  });
  return counts;
}

// Same grouping Module 10 already does inline in its (locked) render
// function, re-exposed here as a small reusable function so Module 16
// doesn't have to re-read telemetry — it reuses charStats + the
// existing FINGER_KEY_MAP/getMergedStatsForKey from Module 10.
function aggregateFingerStats(charStats){
  const keysByFinger = {};
  Object.keys(FINGER_KEY_MAP).forEach(key => {
    const finger = FINGER_KEY_MAP[key];
    (keysByFinger[finger] = keysByFinger[finger] || []).push(key);
  });
  const totals = {};
  FINGER_DISPLAY_ORDER.forEach(finger => {
    const t = { occurrences: 0, correct: 0, latencies: [] };
    (keysByFinger[finger] || []).forEach(key => {
      const stats = getMergedStatsForKey(charStats, key);
      if(!stats || stats.occurrences === 0) return;
      t.occurrences += stats.occurrences;
      t.correct += stats.correct;
      t.latencies = t.latencies.concat(stats.latencies);
    });
    if(t.occurrences > 0) totals[finger] = t;
  });
  return totals;
}

function generateAiCoachTips(r){
  const tips = [];
  const telemetry = r.telemetry || [];
  const { components } = computeOverallScore(r); // Module 14, reused
  const charStats = buildCharacterPerformanceStats(telemetry); // Module 6, reused
  const fingerStats = aggregateFingerStats(charStats);
  const mistakeCounts = getMistakeCategoryCounts(r.diffRows);
  const compEntries = Object.keys(components).filter(k => components[k] != null).map(k => ({ key: k, value: components[k] }));

  if(compEntries.length){
    const strongest = compEntries.reduce((a, b) => (b.value > a.value ? b : a));
    const weakest = compEntries.reduce((a, b) => (b.value < a.value ? b : a));
    tips.push({ icon: "💪", title: "Biggest Strength",
      body: `${scoreComponentLabel(strongest.key)} is your strongest area this attempt.`,
      aiTip: `Scored ${Math.round(strongest.value)}/100 — keep doing whatever you're doing here.` });
    tips.push({ icon: "🎯", title: "Biggest Weakness",
      body: `${scoreComponentLabel(weakest.key)} is your weakest area this attempt.`,
      aiTip: `Scored ${Math.round(weakest.value)}/100 — the highest-leverage place to focus next.` });
  }

  const mistakeKeys = Object.keys(mistakeCounts);
  if(mistakeKeys.length){
    const top = mistakeKeys.reduce((a, b) => (mistakeCounts[b] > mistakeCounts[a] ? b : a));
    tips.push({ icon: "🔁", title: "Most Common Mistake",
      body: `"${top}" was your most frequent mistake type this attempt.`,
      aiTip: `Happened ${mistakeCounts[top]} time(s) — review the Detailed Mistake Log above for the exact words.` });
  }

  const qualifyWpm = state.settings.qualifyWpm || DEFAULT_SETTINGS.qualifyWpm;
  if(r.netWpm < qualifyWpm){
    tips.push({ icon: "🐢", title: "Speed Advice",
      body: `Net WPM (${r.netWpm}) is below your qualifying speed (${qualifyWpm}).`,
      aiTip: "Run a few short, focused speed drills before your next full passage attempt." });
  }else{
    tips.push({ icon: "⚡", title: "Speed Advice",
      body: `Net WPM (${r.netWpm}) already clears your qualifying speed (${qualifyWpm}).`,
      aiTip: `Next target: ${Math.round(qualifyWpm * 1.5)} WPM for a comfortable buffer.` });
  }

  const worstChar = Object.keys(charStats)
    .map(ch => ({ ch, s: charStats[ch] }))
    .filter(c => c.s.occurrences >= 2)
    .sort((a, b) => (a.s.correct / a.s.occurrences) - (b.s.correct / b.s.occurrences))[0];
  if(r.accuracy < 95 && worstChar){
    const pct = ((worstChar.s.correct / worstChar.s.occurrences) * 100).toFixed(0);
    tips.push({ icon: "🎯", title: "Accuracy Advice",
      body: `"${worstChar.ch === " " ? "Space" : worstChar.ch}" was your least accurate key this attempt (${pct}% correct).`,
      aiTip: "Slow down slightly whenever this key comes up rather than rushing through it." });
  }else{
    tips.push({ icon: "✅", title: "Accuracy Advice",
      body: `Accuracy (${r.accuracy}%) looks solid this attempt.`,
      aiTip: "Hold your current pace rather than pushing faster right away." });
  }

  const fingerEntries = Object.keys(fingerStats).map(f => ({ finger: f, acc: (fingerStats[f].correct / fingerStats[f].occurrences) * 100 }));
  if(fingerEntries.length){
    const weakestFinger = fingerEntries.reduce((a, b) => (b.acc < a.acc ? b : a));
    tips.push({ icon: "🖐️", title: "Finger Practice Recommendation",
      body: `Your ${weakestFinger.finger} finger had the lowest accuracy among fingers used this attempt.`,
      aiTip: `${weakestFinger.acc.toFixed(0)}% correct — a few minutes of targeted drills for its keys (see Finger Performance above) should help.` });
  }

  const buckets = computePaceBuckets(telemetry);
  const staminaScore = computeStaminaScore(telemetry, buckets);
  if(staminaScore != null){
    tips.push(staminaScore < 70
      ? { icon: "🔋", title: "Stamina Advice",
          body: "Speed dropped off in the later part of this attempt.",
          aiTip: "Practice full-length passages instead of only short bursts, so pace holds to the end." }
      : { icon: "🔋", title: "Stamina Advice",
          body: "Pace held steady from start to finish this attempt.",
          aiTip: "Stamina isn't your limiting factor right now — keep passages full-length anyway to maintain it." });
  }

  if(compEntries.length){
    const weakest = compEntries.reduce((a, b) => (b.value < a.value ? b : a));
    tips.push({ icon: "📅", title: "Daily Practice Suggestion",
      body: `${scoreComponentLabel(weakest.key)} is this attempt's bottleneck.`,
      aiTip: `Spend most of tomorrow's session on drills that target ${scoreComponentLabel(weakest.key).toLowerCase()} specifically, not full random passages.` });

    const ranked = compEntries.slice().sort((a, b) => a.value - b.value).slice(0, 3);
    tips.push({ icon: "📋", title: "Priority Improvement List",
      body: ranked.map((c, i) => `${i + 1}. ${scoreComponentLabel(c.key)}`).join("  →  "),
      aiTip: "Work these in order — the earlier ones have the biggest effect on your Overall Score above." });
  }

  return tips;
}

function renderAiCoach(r){
  const host = $("#aiCoachGrid");
  const tips = generateAiCoachTips(r);

  if(tips.length === 0){
    host.innerHTML = "";
    $("#aiCoachNoDataNote").hidden = false;
    return;
  }
  $("#aiCoachNoDataNote").hidden = true;

  host.innerHTML = tips.map(tip => `
    <div class="diagnostic-card">
      <div class="dc-head">
        <span class="dc-icon">${tip.icon}</span>
        <h3 class="dc-title">${escapeHtml(tip.title)}</h3>
      </div>
      <div class="dc-body">${escapeHtml(tip.body)}</div>
      <div class="dc-tip"><b>Tip:</b> ${escapeHtml(tip.aiTip)}</div>
    </div>
  `).join("");
}

/* --------------------------------------------------------------------------
   MODULE 1 — Key Performance Summary (pure presentation layer)
   --------------------------------------------------------------------------
   Every value here comes from the existing result object `r` (already
   computed in finishTest() above) or from a trivial arithmetic derivation
   of two existing values — nothing here re-runs or duplicates scoring,
   mistake detection, or telemetry logic:

     - Net/Gross WPM, Accuracy, Total Characters, Backspaces, Duration
       → read directly from r.netWpm / r.grossWpm / r.accuracy /
         r.charsTyped / r.backspaceUsed / r.timeTakenSec (all already
         computed by finishTest()).
     - Error Count → r.fullMistakes + r.halfMistakes (existing counts,
       simple sum, no new classification).
     - Correct/Incorrect Characters → r.charsTyped split by r.accuracy%.
       This is a character-count APPROXIMATION derived from the already-
       computed word-level accuracy percentage, not a new character-level
       diff — true character-exact correct/incorrect counts would require
       a new comparison pass, which is out of scope for this module.
     - Completion % → r.charsTyped ÷ r.givenKeystrokes (both existing
       fields), capped at 100.
     - Time Remaining → state.settings.timerMinutes (existing setting)
       minus r.timeTakenSec (existing field); card is hidden when the
       result isn't meaningful (timed out / no time left), since "Time
       Remaining" only applies to an early submission.
   -------------------------------------------------------------------------- */
function renderKeyPerformanceSummary(r){
  $("#kpsNetWpm").textContent = r.netWpm + " WPM";
  $("#kpsGrossWpm").textContent = r.grossWpm + " WPM";
  $("#kpsAccuracy").textContent = r.accuracy + "%";

  const correctChars = Math.round(r.charsTyped * (r.accuracy / 100));
  const incorrectChars = Math.max(r.charsTyped - correctChars, 0);
  $("#kpsCorrectChars").textContent = correctChars;
  $("#kpsIncorrectChars").textContent = incorrectChars;

  $("#kpsTotalChars").textContent = r.charsTyped;
  $("#kpsBackspaces").textContent = r.backspaceUsed;
  $("#kpsErrorCount").textContent = r.fullMistakes + r.halfMistakes;
  $("#kpsDuration").textContent = formatTime(r.timeTakenSec);

  const completionPct = r.givenKeystrokes > 0
    ? Math.min(100, (r.charsTyped / r.givenKeystrokes) * 100)
    : 0;
  $("#kpsCompletion").textContent = completionPct.toFixed(1) + "%";

  const plannedSeconds = state.settings.timerMinutes * 60;
  const remainingSeconds = plannedSeconds - r.timeTakenSec;
  if(remainingSeconds > 0){
    $("#kpsTimeRemainingCard").hidden = false;
    $("#kpsTimeRemaining").textContent = formatTime(remainingSeconds);
  }else{
    $("#kpsTimeRemainingCard").hidden = true;
  }
}

/* --------------------------------------------------------------------------
   MODULE 3 — Passage Comparison (enrichment over the existing comparison)
   --------------------------------------------------------------------------
   The word-level correct/incorrect/missing/extra/half/untyped coloring
   below already existed (r.expectedTags / r.typedTags, produced by
   computeDiff() — untouched). The only addition here is
   buildHalfMistakeSubtypeMap(), which reads the SAME r.diffRows already
   used elsewhere (see renderErrorTable / renderDetailedMistakeLog) to
   tell apart the two kinds of "half" mistake computeDiff() already
   distinguishes internally (row.type "Capitalization (half)" vs
   "Transposition (half)") so they can get distinct colors here. No new
   mistake detection — just reading a field that was already there.
   -------------------------------------------------------------------------- */
function buildHalfMistakeSubtypeMap(diffRows){
  const map = {};
  (diffRows || []).forEach(row => {
    if(row.type === "Capitalization (half)"){
      map[row.position - 1] = "cap";
    }else if(row.type === "Transposition (half)"){
      map[row.position - 1] = "transpose";
      map[row.position] = "transpose"; // transposition spans two words
    }
  });
  return map;
}

function renderComparison(r){
  const halfSubtype = buildHalfMistakeSubtypeMap(r.diffRows);

  const originalHtml = r.expected.map((w, i) => {
    const tag = r.expectedTags[i];
    let cls = "w-correct";
    if(tag === "incorrect") cls = "w-incorrect";
    else if(tag === "missing") cls = "w-missing";
    else if(tag === "half") cls = halfSubtype[i] === "transpose" ? "w-half-transpose" : halfSubtype[i] === "cap" ? "w-half-cap" : "w-half";
    else if(tag === "untyped") cls = "w-untyped";
    else if(tag === undefined) cls = "";
    return `<span class="${cls}">${escapeHtml(w)}</span>`;
  }).join(" ");

  const typedHtml = r.typed.map((w, i) => {
    const tag = r.typedTags[i];
    let cls = "w-correct";
    if(tag === "incorrect") cls = "w-incorrect";
    else if(tag === "extra") cls = "w-extra";
    else if(tag === "half") cls = halfSubtype[i] === "transpose" ? "w-half-transpose" : halfSubtype[i] === "cap" ? "w-half-cap" : "w-half";
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
  initDashboardSectionToggles();
}

document.addEventListener("DOMContentLoaded", boot);
