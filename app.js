let readerName = "";          // asked for on first visit, kept in this browser

let blocks = [];
let pagesMeta = [];           // [{ width_pt, height_pt }, ...], from load_pdf
let flat = [];                // playable units, after the structure filters
let cursor = 0;
let isPlaying = false;
let audio = new Audio();
let prefetch = { key: null, promise: null };
let libraryReturnScreen = "welcome";  // where the Library's Back button goes
let currentLibraryEntryId = null;     // set when notes were loaded from a saved library entry
let libraryFolders = [];              // [{id, name}]
let libraryEntries = [];              // list_library() rows, each with a `folder` id or null
let libraryFolderId = null;           // folder being viewed; null = top level
let draggedEntryId = null;            // library entry currently being dragged onto a folder

// Page-view rendering state.
const pageImageCache = new Map();   // pageNumber -> data URL
let pageObserver = null;
let pageResizeObserver = null;      // keeps --page-h in sync for text-layer font sizing
let followPlayback = true;          // auto-scroll to the current sentence?
let programmaticScroll = false;     // suppress the scroll listener while we scroll it ourselves
let scrollFlagTimer = null;

let zoom = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;

// Find-in-paper state.
let searchMatches = [];             // [{blockIndex, sentenceIndex, rects}, ...] in reading order
let searchIndex = -1;
let searchHighlightEls = [];

// Claudette (Gemini notes) state.
const pageWordsCache = new Map();   // pageNumber -> words array
const textLayerBuilt = new Set();   // pageNumbers with a text layer already mounted
let activeTool = null;              // null | "cite" | "summarize" | "comment"
let paperMeta = { title: "", authors: [] };
let notes = { mainPoint: [], method: [], mixed: [], citations: [] };
let chatMessages = [];
let summaryStatus = "idle";         // idle | loading | error | done

const TOOL_HIGHLIGHT_CLASS = {
  cite: "note-highlight-cite",
  summarize: "note-highlight-summarize",
  comment: "note-highlight-comment",
};

// Speech-rate estimate, in characters per second at speed 1.0. Starts as a
// reasonable guess for Piper medium voices and is corrected from the real
// duration of every clip actually played.
let charsPerSecond = 14.5;
let calibrationSamples = 0;

const els = {};
[
  "welcome", "empty-error", "open-btn", "library-btn", "greeting-eyebrow", "voice-status",
  "loading", "loading-title", "loading-sub",
  "library", "library-list", "library-empty", "library-back-btn", "reader-library-btn",
  "library-new-folder-btn", "library-status", "confirm-modal-title",
  "welcome-main", "name-form", "name-input", "settings-name-input", "selection-chip",
  "library-backup-btn", "library-restore-btn", "library-info-btn",
  "storage-info-modal", "storage-info-close-btn", "storage-info-status",
  "reader", "sidebar-toggle", "new-doc-btn", "doc-title", "doc-stats", "outline", "ribbon-fill",
  "page-view", "follow-pill", "zoom-out-btn", "zoom-in-btn", "zoom-level",
  "search-bar", "search-input", "search-count", "search-prev-btn", "search-next-btn", "search-close-btn",
  "controls", "controls-toggle-btn",
  "tool-cite", "tool-summarize", "tool-comment", "tool-explain",
  "notes-toggle", "notes-panel", "notes-title-block", "notes-main-point", "notes-method",
  "notes-mixed", "notes-citations", "copy-notes-btn", "save-notes-btn",
  "existing-notes-banner", "existing-notes-text", "existing-notes-load-btn", "existing-notes-dismiss-btn",
  "claudette-chat", "chat-resize-handle", "chat-messages", "chat-form", "chat-input",
  "settings-btn", "settings-modal", "api-key-input", "settings-status",
  "confirm-modal", "confirm-modal-text", "confirm-modal-cancel-btn", "confirm-modal-delete-btn",
  "settings-save-btn", "settings-cancel-btn", "settings-clear-btn",
  "play-btn", "play-icon", "spinner",
  "prev-btn", "next-btn", "position-label", "time-label", "voice-select",
  "speed-range", "speed-value", "status",
  "progress-fill", "opt-headings", "opt-footnotes", "opt-references", "opt-citations",
].forEach((id) => {
  els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
});

/* ---------- Startup ---------- */

async function init() {
  readerName = (await backend.get_settings()).name || "";
  setGreeting();
  if (!readerName) els.nameInput.focus();
  els.nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim();
    if (!name) { els.nameInput.focus(); return; }
    await saveReaderName(name);
  });

  els.openBtn.addEventListener("click", openPdf);
  els.newDocBtn.addEventListener("click", openPdf);

  if (readSidebarCollapsed()) els.reader.classList.add("sidebar-collapsed");
  els.sidebarToggle.addEventListener("click", () => {
    const collapsed = els.reader.classList.toggle("sidebar-collapsed");
    writeSidebarCollapsed(collapsed);
  });

  let dragDepth = 0;
  els.welcome.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    els.welcome.classList.add("drag-over");
  });
  els.welcome.addEventListener("dragover", (e) => e.preventDefault());
  els.welcome.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.welcome.classList.remove("drag-over");
  });
  els.welcome.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.welcome.classList.remove("drag-over");
    if (!readerName) return;
    const file = [...(e.dataTransfer.files || [])].find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!file) return showError("Please drop a PDF file.");
    const { path, filename } = await backend.register_file(file);
    loadPdfFromPath(path, filename);
  });

  els.playBtn.addEventListener("click", togglePlay);
  els.prevBtn.addEventListener("click", () => jumpSentence(-1));
  els.nextBtn.addEventListener("click", () => jumpSentence(1));

  els.speedRange.addEventListener("input", () => {
    updateSpeedLabel();
    updateTimeLabel();
  });
  els.speedRange.addEventListener("change", () => {
    prefetch = { key: null, promise: null };
    if (isPlaying) play();
  });
  els.optCitations.addEventListener("change", () => {
    prefetch = { key: null, promise: null };
    if (isPlaying) play();
  });

  [els.optHeadings, els.optFootnotes, els.optReferences].forEach((box) =>
    box.addEventListener("change", rebuildPlaylist)
  );

  els.pageView.addEventListener("scroll", () => {
    if (programmaticScroll) return;
    setFollowPlayback(false);
  });
  els.followPill.addEventListener("click", () => {
    setFollowPlayback(true);
    scrollToCurrentSentence();
  });

  els.zoomInBtn.addEventListener("click", () => setZoom(zoom + ZOOM_STEP));
  els.zoomOutBtn.addEventListener("click", () => setZoom(zoom - ZOOM_STEP));
  // Trackpad pinch is delivered as a ctrl-flagged wheel event in WebKit.
  els.pageView.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom - e.deltaY * 0.01);
  }, { passive: false });

  audio.addEventListener("loadedmetadata", calibrateFromClip);
  audio.addEventListener("timeupdate", updateTimeLabel);
  audio.addEventListener("ended", () => {
    if (audio.src === silentClipUrl) return;   // the iPad audio-unlock clip, not a sentence
    if (cursor < flat.length - 1) {
      cursor += 1;
      render();
      play();
    } else {
      setPlaying(false);
      setStatus("That is the end of the paper.");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (els.reader.hidden) return;
    // Find-in-paper opens/refocuses regardless of what currently has focus,
    // same as a browser's Cmd+F -- checked before the input/textarea guard
    // below so it still works while e.g. the chat box has focus.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
      return;
    }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    if (e.code === "ArrowRight") jumpSentence(1);
    if (e.code === "ArrowLeft") jumpSentence(-1);
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(zoom + ZOOM_STEP); }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); setZoom(zoom - ZOOM_STEP); }
    if ((e.metaKey || e.ctrlKey) && e.key === "0") { e.preventDefault(); setZoom(1); }
  });

  els.searchInput.addEventListener("input", () => runSearch(els.searchInput.value));
  els.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(searchIndex + (e.shiftKey ? -1 : 1));
    }
  });
  els.searchPrevBtn.addEventListener("click", () => goToMatch(searchIndex - 1));
  els.searchNextBtn.addEventListener("click", () => goToMatch(searchIndex + 1));
  els.searchCloseBtn.addEventListener("click", closeSearch);

  els.libraryBtn.addEventListener("click", openLibrary);
  els.readerLibraryBtn.addEventListener("click", openLibrary);
  els.libraryBackBtn.addEventListener("click", () => showScreen(libraryReturnScreen));
  els.libraryNewFolderBtn.addEventListener("click", startNewFolder);

  els.existingNotesLoadBtn.addEventListener("click", loadPendingExistingNotes);
  els.existingNotesDismissBtn.addEventListener("click", () => {
    hideExistingNotesBanner();
    fetchPaperSummary();
  });

  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsCancelBtn.addEventListener("click", closeSettings);
  els.settingsClearBtn.addEventListener("click", async () => {
    await backend.save_api_key("");
    els.apiKeyInput.value = "";
    els.settingsStatus.textContent = "Key removed.";
    els.settingsStatus.classList.remove("status-error");
  });
  els.settingsSaveBtn.addEventListener("click", async () => {
    const name = els.settingsNameInput.value.trim();
    if (!name) {
      els.settingsStatus.textContent = "Please enter your name.";
      els.settingsStatus.classList.add("status-error");
      return;
    }
    if (name !== readerName) await saveReaderName(name);
    if (els.apiKeyInput.value.trim()) await backend.save_api_key(els.apiKeyInput.value);
    els.settingsStatus.textContent = "Saved.";
    els.settingsStatus.classList.remove("status-error");
    setTimeout(closeSettings, 500);
  });
  els.settingsModal.addEventListener("click", (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });

  els.confirmModalCancelBtn.addEventListener("click", () => closeConfirmModal(false));
  els.confirmModalDeleteBtn.addEventListener("click", () => closeConfirmModal(true));
  els.confirmModal.addEventListener("click", (e) => {
    if (e.target === els.confirmModal) closeConfirmModal(false);
  });

  if (readNotesCollapsed()) els.reader.classList.add("notes-collapsed");
  els.notesToggle.addEventListener("click", () => {
    const collapsed = els.reader.classList.toggle("notes-collapsed");
    writeNotesCollapsed(collapsed);
  });
  els.copyNotesBtn.addEventListener("click", copyNotesToClipboard);
  els.saveNotesBtn.addEventListener("click", saveNotesToLibrary);

  [els.toolCite, els.toolSummarize, els.toolComment, els.toolExplain].forEach((btn) => {
    btn.addEventListener("click", () => setActiveTool(
      activeTool === btn.dataset.tool ? null : btn.dataset.tool
    ));
  });
  els.pageView.addEventListener("mouseup", onPageViewMouseUp);

  els.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChatMessage();
  });

  setupResizeHandle(els.chatResizeHandle, els.claudetteChat, "chatHeight", 84);

  if (readControlsCollapsed()) els.controls.classList.add("collapsed");
  updateControlsToggleTitle();
  els.controlsToggleBtn.addEventListener("click", () => {
    const collapsed = els.controls.classList.toggle("collapsed");
    writeControlsCollapsed(collapsed);
    updateControlsToggleTitle();
  });

  window.addEventListener("voicedownload", (e) => {
    const { loaded, total } = e.detail;
    setStatus(total
      ? `Downloading the voice (first time only)… ${Math.round((loaded / total) * 100)}%`
      : "Downloading the voice (first time only)…");
  });

  els.libraryBackupBtn.addEventListener("click", backupLibrary);
  els.libraryRestoreBtn.addEventListener("click", restoreLibrary);
  els.libraryInfoBtn.addEventListener("click", openStorageInfo);
  els.storageInfoCloseBtn.addEventListener("click", () => { els.storageInfoModal.hidden = true; });
  els.storageInfoModal.addEventListener("click", (e) => {
    if (e.target === els.storageInfoModal) els.storageInfoModal.hidden = true;
  });

  setupTouchSelection();
  updateSpeedLabel();
  await loadVoices();
}

// With no saved choice yet, start the side panels closed on tablet-sized
// screens, where they cover the page.
const NARROW_SCREEN = window.matchMedia("(max-width: 1100px)").matches;

function readSidebarCollapsed() {
  try {
    const saved = localStorage.getItem("sidebarCollapsed");
    return saved === null ? NARROW_SCREEN : saved === "1";
  } catch { return NARROW_SCREEN; }
}

function writeSidebarCollapsed(collapsed) {
  try { localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0"); }
  catch { /* per-viewer convenience only; fine if it's unavailable */ }
}

function readNotesCollapsed() {
  try {
    const saved = localStorage.getItem("notesCollapsed");
    return saved === null ? NARROW_SCREEN : saved === "1";
  } catch { return NARROW_SCREEN; }
}

function writeNotesCollapsed(collapsed) {
  try { localStorage.setItem("notesCollapsed", collapsed ? "1" : "0"); }
  catch { /* per-viewer convenience only; fine if it's unavailable */ }
}

function readControlsCollapsed() {
  try { return localStorage.getItem("controlsCollapsed") === "1"; }
  catch { return false; }
}

function writeControlsCollapsed(collapsed) {
  try { localStorage.setItem("controlsCollapsed", collapsed ? "1" : "0"); }
  catch { /* per-viewer convenience only; fine if it's unavailable */ }
}

function updateControlsToggleTitle() {
  const collapsed = els.controls.classList.contains("collapsed");
  els.controlsToggleBtn.title = collapsed ? "Expand controls" : "Collapse controls";
}

function readStoredHeight(key) {
  try { return parseFloat(localStorage.getItem(key)) || null; }
  catch { return null; }
}

function writeStoredHeight(key, px) {
  try { localStorage.setItem(key, String(Math.round(px))); }
  catch { /* per-viewer convenience only; fine if it's unavailable */ }
}

// Shared drag-to-resize behavior for a panel with a handle at its top edge
// (dragging up grows it) -- used by both the Claudette chat box and the
// audio controls footer.
function setupResizeHandle(handleEl, panelEl, storageKey, minHeight) {
  const saved = readStoredHeight(storageKey);
  if (saved) panelEl.style.height = `${saved}px`;

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handleEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = panelEl.getBoundingClientRect().height;
    handleEl.classList.add("dragging");
    handleEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handleEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const maxHeight = window.innerHeight * 0.7;
    const newHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + delta));
    panelEl.style.height = `${newHeight}px`;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove("dragging");
    writeStoredHeight(storageKey, panelEl.getBoundingClientRect().height);
  };
  handleEl.addEventListener("pointerup", endDrag);
  handleEl.addEventListener("pointercancel", endDrag);
}

function setGreeting() {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Still up" : hour < 12 ? "Good morning"
    : hour < 18 ? "Good afternoon" : "Good evening";
  els.greetingEyebrow.textContent = part;
  document.querySelector(".welcome-title .name").textContent = readerName;
  els.welcomeMain.hidden = !readerName;
  els.nameForm.hidden = Boolean(readerName);
}

async function saveReaderName(name) {
  const result = await backend.save_name(name);
  readerName = result.name;
  setGreeting();
}

async function loadVoices() {
  els.voiceSelect.innerHTML = "";
  const voices = await backend.list_voices();
  for (const name of voices) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = formatVoiceName(name);
    els.voiceSelect.appendChild(opt);
  }
  els.voiceStatus.textContent =
    `${voices.length} voices · ${voices.map(formatVoiceName).join(", ")} · each downloads once (about 60 MB) the first time you use it`;
}

function formatVoiceName(raw) {
  const parts = raw.split("-");
  if (parts.length >= 2) {
    const [lang, name, quality] = parts;
    return `${name.charAt(0).toUpperCase() + name.slice(1)} (${lang}${quality ? ", " + quality : ""})`;
  }
  return raw;
}

function updateSpeedLabel() {
  els.speedValue.textContent = `${parseFloat(els.speedRange.value).toFixed(2)}×`;
}

/* ---------- Opening a paper ---------- */

async function openPdf() {
  els.openBtn.disabled = true;
  try {
    const picked = await backend.pick_pdf_path();
    if (!picked) return;
    if (picked.error) return showError(picked.error);
    await loadPdfFromPath(picked.path, picked.filename);
  } finally {
    els.openBtn.disabled = false;
  }
}

async function loadPdfFromPath(path, filename, skipLibraryCheck = false) {
  try {
    // Parsing is the slow part, so show the loading screen around it.
    showScreen("loading");
    els.loadingTitle.textContent = filename || "Reading…";
    els.loadingSub.textContent = "Working out headings, body text and footnotes…";

    const result = await backend.load_pdf(path);

    if (result.error) { showScreen("welcome"); return showError(result.error); }
    if (!result.blocks || result.blocks.length === 0) {
      showScreen("welcome");
      return showError("No readable text found — this may be a scanned PDF with no text layer.");
    }

    blocks = result.blocks;
    pagesMeta = result.pages || [];
    els.docTitle.textContent = result.filename;
    els.docStats.textContent =
      `${result.stats.paragraphs} paragraphs · ${result.stats.headings} headings · ${result.stats.footnotes} footnotes`;
    cursor = 0;
    followPlayback = true;
    setActiveTool(null);
    closeSearch();
    resetNotes();
    buildPageView();
    rebuildPlaylist();
    showScreen("reader");

    // Opening straight from a library entry already knows its notes and
    // sets them up itself right after this call -- don't second-guess it
    // with the "we found saved notes for this" banner.
    if (!skipLibraryCheck) {
      const existing = await findLibraryEntryForPath(path);
      if (existing) {
        showExistingNotesBanner(existing);
        return;
      }
    }
    fetchPaperSummary();
  } catch (err) {
    showScreen("welcome");
    showError("Could not open that file: " + err);
  }
}

function showScreen(name) {
  els.welcome.hidden = name !== "welcome";
  els.loading.hidden = name !== "loading";
  els.library.hidden = name !== "library";
  els.reader.hidden = name !== "reader";
}

/* ---------- Playlist and structure filters ---------- */

function blockIsPlayable(block) {
  if (block.in_references && els.optReferences.checked) return false;
  if (block.kind === "footnote") return els.optFootnotes.checked;
  if (block.kind === "heading") return els.optHeadings.checked;
  return true;
}

function rebuildPlaylist() {
  const previous = flat[cursor];
  flat = [];
  blocks.forEach((block, bi) => {
    if (!blockIsPlayable(block)) return;
    block.sentences.forEach((sentence, si) => {
      flat.push({ blockIndex: bi, sentenceIndex: si, text: sentence.text, kind: block.kind });
    });
  });

  if (flat.length === 0) {
    setStatus("Nothing to read with these settings — try enabling footnotes or references.");
    els.pageView.querySelectorAll(".sentence-highlight").forEach((el) => el.remove());
    buildOutline();
    buildOverlays();
    return;
  }

  // Stay as close as possible to where we were before the filters changed.
  if (previous) {
    const same = flat.findIndex(
      (f) => f.blockIndex === previous.blockIndex && f.sentenceIndex === previous.sentenceIndex
    );
    const near = flat.findIndex((f) => f.blockIndex >= previous.blockIndex);
    cursor = same >= 0 ? same : (near >= 0 ? near : 0);
  } else {
    cursor = 0;
  }

  buildOutline();
  buildOverlays();
  render();
}

function buildOutline() {
  els.outline.innerHTML = "";
  blocks.forEach((block, i) => {
    if (!blockIsPlayable(block)) return;
    const li = document.createElement("li");
    li.className = `outline-${block.kind}`;
    li.dataset.blockIndex = i;
    li.textContent = block.kind === "heading"
      ? block.text
      : `${block.text.slice(0, 52)}${block.text.length > 52 ? "…" : ""}`;
    li.addEventListener("click", () => {
      const target = flat.findIndex((f) => f.blockIndex === i);
      if (target < 0) return;
      cursor = target;
      setFollowPlayback(true);
      render();
      if (isPlaying) play();
    });
    els.outline.appendChild(li);
  });
}

/* ---------- Page view (the actual PDF pages) ---------- */

function setZoom(newZoom) {
  const old = zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  els.pageView.style.setProperty("--zoom", zoom);
  els.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  if (zoom !== old && els.pageView.scrollTop > 0) {
    // Keep roughly the same content under the viewport as the pages resize.
    els.pageView.scrollTop *= zoom / old;
  }
}

function buildPageView() {
  els.pageView.innerHTML = "";
  pageImageCache.clear();
  pageWordsCache.clear();
  textLayerBuilt.clear();
  pageFetchQueue.length = 0;   // drop not-yet-started fetches for the old document
  if (pageObserver) pageObserver.disconnect();
  if (pageResizeObserver) pageResizeObserver.disconnect();

  pageResizeObserver = new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      entry.target.style.setProperty("--page-h", `${entry.contentRect.height}px`);
    });
  });

  pagesMeta.forEach((meta, i) => {
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.dataset.page = String(i + 1);
    pageEl.style.aspectRatio = `${meta.width_pt} / ${meta.height_pt}`;

    const img = document.createElement("img");
    img.className = "page-img";
    img.alt = `Page ${i + 1}`;
    pageEl.appendChild(img);

    const overlay = document.createElement("div");
    overlay.className = "page-overlay";
    pageEl.appendChild(overlay);

    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    pageEl.appendChild(textLayer);

    els.pageView.appendChild(pageEl);
    pageResizeObserver.observe(pageEl);
  });

  pageObserver = new IntersectionObserver(onPageIntersect, {
    root: els.pageView,
    rootMargin: "400px 0px 400px 0px",
  });
  [...els.pageView.children].forEach((el) => pageObserver.observe(el));
}

function onPageIntersect(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    schedulePageFetch(() => loadPageImage(entry.target));
    schedulePageFetch(() => loadPageTextLayer(entry.target));
  });
}

// Rendering a page is real CPU work. Opening a paper can make several pages
// intersect the viewport margin at once; cap how many render at a time so
// pressing Play right then still responds promptly.
const MAX_CONCURRENT_PAGE_FETCHES = 2;
let activePageFetches = 0;
const pageFetchQueue = [];

function schedulePageFetch(task) {
  pageFetchQueue.push(task);
  drainPageFetchQueue();
}

function drainPageFetchQueue() {
  while (activePageFetches < MAX_CONCURRENT_PAGE_FETCHES && pageFetchQueue.length) {
    const task = pageFetchQueue.shift();
    activePageFetches += 1;
    task().finally(() => {
      activePageFetches -= 1;
      drainPageFetchQueue();
    });
  }
}

async function loadPageImage(pageEl) {
  const pageNum = Number(pageEl.dataset.page);
  const cached = pageImageCache.get(pageNum);
  if (cached) {
    applyPageImage(pageEl, cached);
    return;
  }
  if (pageEl.dataset.loading) return;
  pageEl.dataset.loading = "1";
  try {
    const dpi = Math.min(300, Math.round(150 * Math.max(1, window.devicePixelRatio || 1)));
    const result = await backend.render_page(pageNum, dpi);
    if (!result || result.error) return;
    const src = result.image_url;
    pageImageCache.set(pageNum, src);
    applyPageImage(pageEl, src);
  } finally {
    delete pageEl.dataset.loading;
  }
}

function applyPageImage(pageEl, src) {
  pageEl.querySelector(".page-img").src = src;
  pageEl.classList.add("loaded");
}

async function loadPageTextLayer(pageEl) {
  const pageNum = Number(pageEl.dataset.page);
  if (textLayerBuilt.has(pageNum)) return;
  textLayerBuilt.add(pageNum);
  try {
    let words = pageWordsCache.get(pageNum);
    if (!words) {
      const result = await backend.get_page_words(pageNum);
      if (!result || result.error) { textLayerBuilt.delete(pageNum); return; }
      words = result.words;
      pageWordsCache.set(pageNum, words);
    }
    const meta = pagesMeta[pageNum - 1];
    const layer = pageEl.querySelector(".text-layer");
    const fragment = document.createDocumentFragment();
    const spans = words.map((word) => {
      const span = document.createElement("span");
      span.className = "text-word";
      span.textContent = word.text;
      span.style.left = `${(word.x0 / meta.width_pt) * 100}%`;
      span.style.top = `${(word.top / meta.height_pt) * 100}%`;
      span.style.setProperty("--word-h", (word.bottom - word.top) / meta.height_pt);
      fragment.appendChild(span);
      return span;
    });
    layer.appendChild(fragment);
    // Stretch each invisible word to the printed word's width; otherwise
    // they overlap or leave gaps, and a finger's long-press on an iPad
    // selects the wrong text. Measured in ems, so it holds at any zoom.
    const naturalEms = spans.map((span) => {
      const fontPx = parseFloat(getComputedStyle(span).fontSize);
      return fontPx ? span.getBoundingClientRect().width / fontPx : 0;
    });
    spans.forEach((span, i) => {
      const word = words[i];
      const targetEms = (word.x1 - word.x0) / (word.bottom - word.top);
      if (naturalEms[i] > 0 && targetEms > 0) span.style.transform = `scaleX(${targetEms / naturalEms[i]})`;
      span.appendChild(document.createTextNode(" "));
    });
  } catch {
    textLayerBuilt.delete(pageNum);
  }
}

function pageOverlay(pageNumber) {
  const pageEl = els.pageView.children[pageNumber - 1];
  return pageEl ? pageEl.querySelector(".page-overlay") : null;
}

function positionRect(el, rect) {
  const meta = pagesMeta[rect.page - 1];
  if (!meta) return;
  el.style.left = `${(rect.x0 / meta.width_pt) * 100}%`;
  el.style.top = `${(rect.top / meta.height_pt) * 100}%`;
  el.style.width = `${((rect.x1 - rect.x0) / meta.width_pt) * 100}%`;
  el.style.height = `${((rect.bottom - rect.top) / meta.height_pt) * 100}%`;
}

function buildOverlays() {
  els.pageView.querySelectorAll(".sentence-hit").forEach((el) => el.remove());

  blocks.forEach((block, bi) => {
    if (!blockIsPlayable(block)) return;
    block.sentences.forEach((sentence, si) => {
      sentence.rects.forEach((rect) => {
        const overlay = pageOverlay(rect.page);
        if (!overlay) return;
        const hit = document.createElement("div");
        hit.className = "sentence-hit";
        hit.title = "Read from here";
        positionRect(hit, rect);
        hit.addEventListener("click", () => seekTo(bi, si));
        overlay.appendChild(hit);
      });
    });
  });
}

function seekTo(blockIndex, sentenceIndex) {
  const target = flat.findIndex(
    (f) => f.blockIndex === blockIndex && f.sentenceIndex === sentenceIndex
  );
  if (target < 0) return;
  cursor = target;
  setFollowPlayback(true);
  render();
  play();
}

/* ---------- Highlighter tools (Cite / Summarize / Comment) ---------- */

function setActiveTool(tool) {
  activeTool = tool;
  [els.toolCite, els.toolSummarize, els.toolComment, els.toolExplain].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  els.pageView.classList.remove(
    "tool-cite-active", "tool-summarize-active", "tool-comment-active", "tool-explain-active"
  );
  if (tool) els.pageView.classList.add(`tool-${tool}-active`);
  window.getSelection()?.removeAllRanges();
  removeCommentPopover();
  hideSelectionChip();
  clearTouchSelection();
  if (tool && lastPointerType !== "mouse") setStatus("Press and hold a word, then drag to the last word you want.");
}

function onPageViewMouseUp() {
  if (!activeTool || lastPointerType === "touch") return;
  const selection = readPageSelection();
  if (selection) applyTool(selection);
}

// The current text selection on the pages as {text, page, rects}, or null.
function readPageSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  if (!els.pageView.contains(range.commonAncestorContainer)) return null;
  const rawRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rawRects.length) return null;

  // A selection can span more than one .page element (dragging across a
  // page break), so every client rect is mapped to whichever page it
  // actually falls in, rather than assuming a single shared page -- the
  // old .closest(".page") lookup on the range's common ancestor returned
  // null for a genuine cross-page range and silently dropped it.
  const pageEls = [...els.pageView.children];
  const rects = [];
  rawRects.forEach((r) => {
    const centerY = r.top + r.height / 2;
    const owner = pageEls.find((el) => {
      const pr = el.getBoundingClientRect();
      return centerY >= pr.top && centerY <= pr.bottom;
    });
    if (!owner) return;
    const pageRect = owner.getBoundingClientRect();
    rects.push({
      page: Number(owner.dataset.page),
      leftPct: ((r.left - pageRect.left) / pageRect.width) * 100,
      topPct: ((r.top - pageRect.top) / pageRect.height) * 100,
      widthPct: (r.width / pageRect.width) * 100,
      heightPct: (r.height / pageRect.height) * 100,
    });
  });
  if (!rects.length) return null;

  // Reading order (earliest page, then top-most within it) so the "start"
  // of a cross-page selection is always its true start, not just whatever
  // rect the browser happened to list first.
  rects.sort((a, b) => a.page - b.page || a.topPct - b.topPct);

  const last = rawRects.reduce((a, b) => (b.bottom > a.bottom ? b : a));
  return { text, page: rects[0].page, rects, anchor: { x: last.left + last.width / 2, y: last.bottom } };
}

function applyTool(selection) {
  if (activeTool === "cite") {
    addCitation(selection);
    window.getSelection()?.removeAllRanges();
  } else if (activeTool === "summarize") {
    addSummaryNote(selection);
    window.getSelection()?.removeAllRanges();
  } else if (activeTool === "comment") {
    showCommentPopover(selection);
  } else if (activeTool === "explain") {
    explainSelection(selection);
    window.getSelection()?.removeAllRanges();
  }
}

/* ---------- Touch selection (iPad) ---------- */

// Safari's own long-press selection jumps across lines on the invisible
// word layer (it picks word boundaries from the DOM, not from where words
// are drawn), so touch selection is done here instead: press and hold a
// word, drag to the last word, let go -- then a button applies the tool.
// Mouse and trackpad keep using the browser's normal selection.
let lastPointerType = "mouse";
let pendingTouchSelection = null;
let touchSelection = null;   // { start, end } word spans while dragging

const TOOL_CHIP_LABELS = { cite: "Add citation", summarize: "Summarize", comment: "Add comment", explain: "Explain" };
const TOUCH_HOLD_MS = 300;

function wordSpanAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest(".text-word") : null;
}

function touchSelectedSpans() {
  if (!touchSelection) return [];
  const all = [...els.pageView.querySelectorAll(".text-word")];
  const a = all.indexOf(touchSelection.start);
  const b = all.indexOf(touchSelection.end);
  return a < 0 || b < 0 ? [] : all.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function paintTouchSelection() {
  els.pageView.querySelectorAll(".text-word.touch-selected").forEach((s) => s.classList.remove("touch-selected"));
  touchSelectedSpans().forEach((s) => s.classList.add("touch-selected"));
}

function clearTouchSelection() {
  touchSelection = null;
  paintTouchSelection();
}

// Same shape as readPageSelection(), built from word spans.
function selectionFromSpans(spans) {
  if (!spans.length) return null;
  const text = spans.map((s) => s.textContent).join("").replace(/\s+/g, " ").trim();
  const rects = spans.map((span) => {
    const pageEl = span.closest(".page");
    const r = span.getBoundingClientRect();
    const pr = pageEl.getBoundingClientRect();
    return {
      page: Number(pageEl.dataset.page),
      leftPct: ((r.left - pr.left) / pr.width) * 100,
      topPct: ((r.top - pr.top) / pr.height) * 100,
      widthPct: (r.width / pr.width) * 100,
      heightPct: (r.height / pr.height) * 100,
    };
  });
  const last = spans[spans.length - 1].getBoundingClientRect();
  return { text, page: rects[0].page, rects, anchor: { x: last.left + last.width / 2, y: last.bottom } };
}

function setupTouchSelection() {
  document.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType;
    els.pageView.classList.toggle("touch-mode", e.pointerType !== "mouse");
  }, true);

  let hold = null;
  const cancelHold = () => { if (hold) clearTimeout(hold.timer); hold = null; };

  els.pageView.addEventListener("touchstart", (e) => {
    cancelHold();
    if (!activeTool || e.touches.length !== 1) return;
    const t = e.touches[0];
    const span = wordSpanAt(t.clientX, t.clientY);
    hideSelectionChip();
    clearTouchSelection();
    if (!span) return;
    hold = {
      x: t.clientX,
      y: t.clientY,
      timer: setTimeout(() => {
        hold = null;
        touchSelection = { start: span, end: span };
        paintTouchSelection();
      }, TOUCH_HOLD_MS),
    };
  }, { passive: true });

  els.pageView.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (hold && Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 10) cancelHold();   // it's a scroll
    if (!touchSelection) return;
    e.preventDefault();   // dragging extends the selection instead of scrolling
    const span = wordSpanAt(t.clientX, t.clientY);
    if (span && span !== touchSelection.end) {
      touchSelection.end = span;
      paintTouchSelection();
    }
  }, { passive: false });

  const finish = () => {
    cancelHold();
    if (!touchSelection) return;
    const selection = selectionFromSpans(touchSelectedSpans());
    if (selection && activeTool) showSelectionChip(selection);
    else clearTouchSelection();
  };
  els.pageView.addEventListener("touchend", finish);
  els.pageView.addEventListener("touchcancel", () => { cancelHold(); clearTouchSelection(); });

  els.pageView.addEventListener("scroll", () => {
    if (!pendingTouchSelection) return;
    hideSelectionChip();
    clearTouchSelection();
  });
  els.selectionChip.addEventListener("click", () => {
    const selection = pendingTouchSelection;
    hideSelectionChip();
    clearTouchSelection();
    if (selection && activeTool) applyTool(selection);
  });
}

function showSelectionChip(selection) {
  pendingTouchSelection = selection;
  els.selectionChip.textContent = TOOL_CHIP_LABELS[activeTool];
  els.selectionChip.className = `selection-chip tool-${activeTool}`;
  els.selectionChip.hidden = false;
  const { width, height } = els.selectionChip.getBoundingClientRect();
  const left = Math.min(Math.max(8, selection.anchor.x - width / 2), window.innerWidth - width - 8);
  const top = Math.min(selection.anchor.y + 16, window.innerHeight - height - 8);
  els.selectionChip.style.left = `${left}px`;
  els.selectionChip.style.top = `${top}px`;
}

function hideSelectionChip() {
  pendingTouchSelection = null;
  els.selectionChip.hidden = true;
}

// Explain is deliberately the odd one out: it answers in the chat, not the
// notes list, and never adds a note on its own -- purely "tell me what this
// means" without committing anything to the paper's record.
async function explainSelection(selection) {
  if (els.reader.classList.contains("notes-collapsed")) {
    els.reader.classList.remove("notes-collapsed");
    writeNotesCollapsed(false);
  }
  const preview = selection.text.length > 80 ? `${selection.text.slice(0, 80)}…` : selection.text;
  chatMessages.push({ role: "user", text: `Explain (p. ${selection.page}): "${preview}"` });
  const answer = { role: "assistant", text: "…" };
  chatMessages.push(answer);
  renderChat();

  const result = await backend.explain_selection(selection.text);
  answer.text = (result && result.text) || (result && result.error) || "No response.";
  renderChat();
}

function drawNoteHighlight(selection, tool) {
  const boxes = [];
  selection.rects.forEach((r) => {
    const overlay = pageOverlay(r.page);
    if (!overlay) return;
    const box = document.createElement("div");
    box.className = `note-highlight ${TOOL_HIGHLIGHT_CLASS[tool]}`;
    box.style.left = `${r.leftPct}%`;
    box.style.top = `${r.topPct}%`;
    box.style.width = `${r.widthPct}%`;
    box.style.height = `${r.heightPct}%`;
    overlay.appendChild(box);
    boxes.push(box);
  });
  return boxes;
}

function removeNoteHighlights(entry) {
  // Notes restored from a saved library entry may carry a serialized (not
  // a real DOM node) `highlightEls` left over from an older save -- guard
  // against that so a stray non-element doesn't throw and abort the
  // delete before it reaches the splice() below.
  (entry.highlightEls || []).forEach((el) => {
    if (el && typeof el.remove === "function") el.remove();
  });
}

function addCitation(selection) {
  const highlightEls = drawNoteHighlight(selection, "cite");
  notes.citations.push({ text: selection.text, page: selection.page, highlightEls });
  renderNotesPanel();
}

async function addSummaryNote(selection) {
  const highlightEls = drawNoteHighlight(selection, "summarize");
  const entry = { type: "summarize", text: "Summarizing…", page: selection.page, pending: true, highlightEls };
  notes.mixed.push(entry);
  renderNotesPanel();
  const result = await backend.ai_selection("summarize", selection.text);
  entry.pending = false;
  entry.text = (result && result.text) || (result && result.error) || "Could not summarize that.";
  renderNotesPanel();
}

function removeCommentPopover() {
  document.querySelector(".comment-popover")?.remove();
}

function showCommentPopover(selection) {
  removeCommentPopover();
  // selection.rects is sorted into reading order, so the first rect is
  // always the top of the selection -- even one that starts on an earlier
  // page than it ends on -- and the popover anchors to that page/spot.
  const firstRect = selection.rects[0];
  const pageEl = els.pageView.children[firstRect.page - 1];
  if (!pageEl) return;
  const popover = document.createElement("div");
  popover.className = "comment-popover";
  popover.style.left = `${firstRect.leftPct}%`;
  popover.style.top = `${firstRect.topPct}%`;

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Your comment…";

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-ghost";
  cancelBtn.textContent = "Cancel";
  cancelBtn.type = "button";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.type = "button";
  actions.append(cancelBtn, saveBtn);
  popover.append(textarea, actions);
  pageEl.appendChild(popover);
  textarea.focus();

  cancelBtn.addEventListener("click", () => {
    removeCommentPopover();
    window.getSelection()?.removeAllRanges();
  });
  saveBtn.addEventListener("click", () => addCommentNote(selection, textarea.value, popover));
}

async function addCommentNote(selection, commentText, popover) {
  const comment = commentText.trim();
  if (!comment) { popover.remove(); window.getSelection()?.removeAllRanges(); return; }

  popover.remove();
  window.getSelection()?.removeAllRanges();
  const highlightEls = drawNoteHighlight(selection, "comment");
  const entry = { type: "comment", comment, gloss: "Claudette is reading…", page: selection.page, pending: true, highlightEls };
  notes.mixed.push(entry);
  renderNotesPanel();

  const result = await backend.ai_selection("comment_gloss", selection.text);
  entry.pending = false;
  entry.gloss = (result && result.text) || (result && result.error) || "";
  renderNotesPanel();
}

/* ---------- Sticky auto-scroll ---------- */

function setFollowPlayback(follow) {
  followPlayback = follow;
  els.followPill.hidden = followPlayback || !isPlaying;
}

function scrollToCurrentSentence() {
  const current = flat[cursor];
  if (!current) return;
  const block = blocks[current.blockIndex];
  const sentence = block.sentences[current.sentenceIndex];
  const firstRect = sentence.rects[0];
  if (!firstRect) return;
  const overlay = pageOverlay(firstRect.page);
  const highlight = overlay && overlay.querySelector(".sentence-highlight");
  const target = highlight || els.pageView.children[firstRect.page - 1];
  if (!target) return;

  programmaticScroll = true;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  clearTimeout(scrollFlagTimer);
  scrollFlagTimer = setTimeout(() => { programmaticScroll = false; }, 700);
}

/* ---------- Find in paper (Cmd/Ctrl+F) ---------- */

function openSearch() {
  els.searchBar.hidden = false;
  els.searchInput.focus();
  els.searchInput.select();
  if (els.searchInput.value) runSearch(els.searchInput.value);
}

function closeSearch() {
  els.searchBar.hidden = true;
  els.searchInput.value = "";
  searchMatches = [];
  searchIndex = -1;
  clearSearchHighlights();
  updateSearchCount();
}

function runSearch(query) {
  clearSearchHighlights();
  searchMatches = computeSearchMatches(query);
  searchIndex = searchMatches.length ? 0 : -1;
  renderSearchHighlights();
  updateSearchCount();
  if (searchIndex >= 0) scrollToSearchMatch();
}

// Matches at sentence granularity, reusing the same rects already used for
// playback seeking/highlighting -- avoids fetching per-word positions for
// every page just to support find.
function computeSearchMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = [];
  blocks.forEach((block, blockIndex) => {
    block.sentences.forEach((sentence, sentenceIndex) => {
      if (sentence.text.toLowerCase().includes(q)) {
        matches.push({ blockIndex, sentenceIndex, rects: sentence.rects });
      }
    });
  });
  return matches;
}

function clearSearchHighlights() {
  searchHighlightEls.forEach((el) => el.remove());
  searchHighlightEls = [];
}

function renderSearchHighlights() {
  clearSearchHighlights();
  searchMatches.forEach((match, i) => {
    match.rects.forEach((rect) => {
      const overlay = pageOverlay(rect.page);
      if (!overlay) return;
      const box = document.createElement("div");
      box.className = i === searchIndex ? "search-match search-match-current" : "search-match";
      positionRect(box, rect);
      overlay.appendChild(box);
      searchHighlightEls.push(box);
    });
  });
}

function updateSearchCount() {
  els.searchCount.textContent = searchMatches.length
    ? `${searchIndex + 1}/${searchMatches.length}`
    : "0/0";
}

function goToMatch(i) {
  if (!searchMatches.length) return;
  searchIndex = (i + searchMatches.length) % searchMatches.length;
  renderSearchHighlights();
  updateSearchCount();
  scrollToSearchMatch();
}

function scrollToSearchMatch() {
  const match = searchMatches[searchIndex];
  const firstRect = match && match.rects[0];
  if (!firstRect) return;
  const overlay = pageOverlay(firstRect.page);
  const target = (overlay && overlay.querySelector(".search-match-current")) || els.pageView.children[firstRect.page - 1];
  if (!target) return;

  programmaticScroll = true;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  clearTimeout(scrollFlagTimer);
  scrollFlagTimer = setTimeout(() => { programmaticScroll = false; }, 700);
}

/* ---------- Rendering ---------- */

function render() {
  const current = flat[cursor];
  if (!current) return;
  const block = blocks[current.blockIndex];
  const sentence = block.sentences[current.sentenceIndex];

  els.pageView.querySelectorAll(".sentence-highlight").forEach((el) => el.remove());
  sentence.rects.forEach((rect) => {
    const overlay = pageOverlay(rect.page);
    if (!overlay) return;
    const hi = document.createElement("div");
    hi.className = "sentence-highlight";
    positionRect(hi, rect);
    overlay.appendChild(hi);
  });

  if (followPlayback) scrollToCurrentSentence();

  [...els.outline.children].forEach((li) => {
    li.classList.toggle("active", Number(li.dataset.blockIndex) === current.blockIndex);
  });
  els.outline.querySelector("li.active")?.scrollIntoView({ block: "nearest" });

  const pct = ((cursor + 1) / flat.length) * 100;
  els.ribbonFill.style.height = `${pct}%`;
  els.progressFill.style.width = `${pct}%`;
  els.positionLabel.textContent =
    `${block.kind === "heading" ? "Heading" : "Paragraph"} ${current.blockIndex + 1}/${blocks.length}` +
    (block.sentences.length > 1 ? ` · sentence ${current.sentenceIndex + 1}/${block.sentences.length}` : "");

  updateTimeLabel();
}

/* ---------- Time estimates ---------- */

function charsBefore(index) {
  let n = 0;
  for (let i = 0; i < index && i < flat.length; i++) n += flat[i].text.length;
  return n;
}

function charsFrom(index) {
  let n = 0;
  for (let i = index; i < flat.length; i++) n += flat[i].text.length;
  return n;
}

function calibrateFromClip() {
  // Correct the speech-rate estimate from a clip we just loaded.
  const item = flat[cursor];
  if (audio.src === silentClipUrl) return;
  if (!item || !isFinite(audio.duration) || audio.duration <= 0) return;
  const speed = parseFloat(els.speedRange.value);
  const observed = item.text.length / (audio.duration * speed);
  const weight = Math.min(0.35, 1 / (calibrationSamples + 2));
  charsPerSecond = charsPerSecond * (1 - weight) + observed * weight;
  calibrationSamples += 1;
  updateTimeLabel();
}

function formatMinutes(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "–";
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  return `${h} h ${total % 60} min`;
}

function updateTimeLabel() {
  if (!flat.length) return;
  const speed = parseFloat(els.speedRange.value);
  const rate = charsPerSecond * speed;         // characters per second
  const played = isPlaying || audio.currentTime ? audio.currentTime || 0 : 0;
  const doneSeconds = charsBefore(cursor) / rate + played;
  const leftSeconds = Math.max(0, charsFrom(cursor) / rate - played);
  els.timeLabel.textContent = `${formatMinutes(doneSeconds)} listened · ${formatMinutes(leftSeconds)} left`;
}

/* ---------- Playback ---------- */

function jumpSentence(delta) {
  const next = cursor + delta;
  if (next < 0 || next >= flat.length) return;
  cursor = next;
  setFollowPlayback(true);
  render();
  if (isPlaying) play();
}

// iPad Safari only lets a page start audio from inside a tap, but the first
// sentence takes a while to synthesize. Playing a silent clip right in the
// tap unlocks this audio element for every later play() call.
let audioUnlocked = false;
let silentClipUrl = null;

function silentClip() {
  if (!silentClipUrl) {
    const samples = 2205;   // 0.1 s at 22.05 kHz
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const ascii = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE");
    ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 22050, true); view.setUint32(28, 44100, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, samples * 2, true);
    silentClipUrl = URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" }));
  }
  return silentClipUrl;
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audio.src = silentClip();
  audio.play().catch(() => { audioUnlocked = false; });
}

async function togglePlay() {
  if (isPlaying) { audio.pause(); setPlaying(false); }
  else {
    unlockAudio();
    await play();
  }
}

function synthKey(index, voice, speed, skipCitations) {
  return `${index}|${voice}|${speed}|${skipCitations}`;
}

function requestAudio(index, voice, speed, skipCitations) {
  const item = flat[index];
  return backend.synthesize(item.blockIndex, item.sentenceIndex, voice, speed, skipCitations);
}

async function play() {
  const voice = els.voiceSelect.value;
  if (!voice) return showError("Pick a voice first.");
  if (!flat.length) return;

  const speed = parseFloat(els.speedRange.value);
  const skipCitations = els.optCitations.checked;
  const key = synthKey(cursor, voice, speed, skipCitations);

  setLoading(true);
  try {
    const result = (prefetch.key === key && prefetch.promise)
      ? await prefetch.promise
      : await requestAudio(cursor, voice, speed, skipCitations);

    if (!result || result.error) {
      setPlaying(false);
      return showError((result && result.error) || "No audio came back.");
    }

    if (audio.src.startsWith("blob:") && audio.src !== silentClipUrl) URL.revokeObjectURL(audio.src);
    audio.src = result.audio_url;
    await audio.play();
    setPlaying(true);
    setStatus("");
    startPrefetch(voice, speed, skipCitations);
  } catch (err) {
    setPlaying(false);
    showError("Playback failed: " + err);
  } finally {
    setLoading(false);
  }
}

function startPrefetch(voice, speed, skipCitations) {
  const next = cursor + 1;
  if (next >= flat.length) { prefetch = { key: null, promise: null }; return; }
  const key = synthKey(next, voice, speed, skipCitations);
  if (prefetch.key === key) return;
  prefetch = { key, promise: requestAudio(next, voice, speed, skipCitations).catch(() => null) };
}

function setPlaying(playing) {
  isPlaying = playing;
  els.playIcon.innerHTML = playing ? "&#10074;&#10074;" : "&#9658;";
  els.playBtn.title = playing ? "Pause" : "Play";
  els.followPill.hidden = followPlayback || !playing;
}

function setLoading(loading) {
  els.spinner.hidden = !loading;
  els.playIcon.hidden = loading;
  els.playBtn.disabled = loading;
  if (loading) setStatus("Preparing audio…");
  else if (els.status.textContent === "Preparing audio…") setStatus("");
}

function setStatus(message) {
  els.status.textContent = message;
  els.status.classList.remove("status-error");
}

function showError(message) {
  if (els.reader.hidden) {
    els.emptyError.textContent = message;
    els.emptyError.hidden = false;
  } else {
    els.status.textContent = message;
    els.status.classList.add("status-error");
  }
  console.error(message);
}

/* ---------- Notes panel ---------- */

let summaryError = "";

function resetNotes() {
  paperMeta = { title: "", authors: [] };
  notes = { mainPoint: [], method: [], mixed: [], citations: [] };
  chatMessages = [];
  summaryStatus = "idle";
  summaryError = "";
  currentLibraryEntryId = null;
  hideExistingNotesBanner();
  renderNotesPanel();
  renderChat();
}

async function findLibraryEntryForPath(path) {
  try {
    const entries = await backend.list_library();
    return (entries || []).find((e) => e.source_path === path) || null;
  } catch {
    return null;
  }
}

let pendingExistingEntry = null;

function showExistingNotesBanner(entrySummary) {
  pendingExistingEntry = entrySummary;
  const date = entrySummary.saved_at ? new Date(entrySummary.saved_at * 1000).toLocaleDateString() : "";
  els.existingNotesText.textContent =
    `You already have saved notes for this paper${date ? ` (saved ${date})` : ""}.`;
  els.existingNotesBanner.hidden = false;
}

function hideExistingNotesBanner() {
  els.existingNotesBanner.hidden = true;
  pendingExistingEntry = null;
}

// Shared by "load the banner's suggested entry" and "Open this paper" from
// the library detail view -- both end up applying a saved entry's notes on
// top of a freshly loaded document the same way.
function applyLibraryEntryToState(entry) {
  currentLibraryEntryId = entry.id;
  paperMeta = { title: entry.title, authors: entry.authors || [] };
  notes = {
    mainPoint: entry.main_point || [],
    method: entry.method || [],
    mixed: entry.notes || [],
    citations: entry.citations || [],
  };
  summaryStatus = "done";
  renderNotesPanel();
}

async function loadPendingExistingNotes() {
  if (!pendingExistingEntry) return;
  const entryId = pendingExistingEntry.id;
  hideExistingNotesBanner();
  const entry = await backend.load_library_entry(entryId);
  if (!entry || entry.error) return showError((entry && entry.error) || "Could not load saved notes.");
  applyLibraryEntryToState(entry);
}

async function fetchPaperSummary() {
  summaryStatus = "loading";
  renderNotesPanel();
  const result = await backend.summarize_paper();
  if (!result || result.error) {
    summaryStatus = "error";
    summaryError = (result && result.error) || "Could not summarize this paper.";
    renderNotesPanel();
    return;
  }
  paperMeta = { title: result.title || "", authors: result.authors || [] };
  notes.mainPoint = result.main_point || [];
  notes.method = result.method || [];
  summaryStatus = "done";
  renderNotesPanel();
}

function renderNotesPanel() {
  els.notesTitleBlock.innerHTML = "";
  if (paperMeta.title) {
    const h = document.createElement("p");
    h.className = "notes-paper-title";
    h.textContent = paperMeta.title;
    els.notesTitleBlock.appendChild(h);
  }
  if (paperMeta.authors.length) {
    const a = document.createElement("p");
    a.className = "notes-paper-authors";
    a.textContent = paperMeta.authors.join(", ");
    els.notesTitleBlock.appendChild(a);
  }

  renderBulletList(els.notesMainPoint, notes.mainPoint);
  renderBulletList(els.notesMethod, notes.method);
  renderMixedList();
  renderCitationsList();
}

function renderBulletList(ul, items) {
  ul.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "notes-empty";
    li.textContent = summaryStatus === "loading" ? "Claudette is reading…"
      : summaryStatus === "error" ? summaryError
      : "Nothing yet.";
    ul.appendChild(li);
    return;
  }
  items.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = `• ${text}`;
    ul.appendChild(li);
  });
}

function renderMixedList() {
  const ul = els.notesMixed;
  ul.innerHTML = "";
  if (!notes.mixed.length) {
    const li = document.createElement("li");
    li.className = "notes-empty";
    li.textContent = "Select text with Summarize or Comment to add notes here.";
    ul.appendChild(li);
    return;
  }
  notes.mixed.forEach((entry, i) => {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "notes-page-tag";
    tag.textContent = entry.page != null ? `p. ${entry.page}` : "chat";
    li.appendChild(tag);

    if (entry.type !== "comment") {
      li.appendChild(document.createTextNode(`• ${entry.text}`));
    } else {
      const commentEl = document.createElement("span");
      commentEl.className = "notes-comment-text";
      commentEl.textContent = entry.comment;
      const glossEl = document.createElement("span");
      glossEl.className = "notes-comment-gloss";
      glossEl.textContent = entry.gloss;
      li.append(commentEl, glossEl);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "notes-remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      removeNoteHighlights(entry);
      notes.mixed.splice(i, 1);
      renderNotesPanel();
    });
    li.appendChild(removeBtn);
    ul.appendChild(li);
  });
}

function renderCitationsList() {
  const ul = els.notesCitations;
  ul.innerHTML = "";
  if (!notes.citations.length) {
    const li = document.createElement("li");
    li.className = "notes-empty";
    li.textContent = "Select text with Cite to quote it here.";
    ul.appendChild(li);
    return;
  }
  notes.citations.forEach((c, i) => {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.className = "notes-page-tag";
    tag.textContent = `p. ${c.page}`;
    const q = document.createElement("span");
    q.className = "notes-citation-text";
    q.textContent = `“${c.text}”`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "notes-remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      removeNoteHighlights(c);
      notes.citations.splice(i, 1);
      renderNotesPanel();
    });
    li.append(tag, q, removeBtn);
    ul.appendChild(li);
  });
}

function notesToMarkdown() {
  const lines = [];
  if (paperMeta.title) lines.push(`# ${paperMeta.title}`);
  if (paperMeta.authors.length) lines.push(paperMeta.authors.join(", "));
  lines.push("", "## Main point");
  (notes.mainPoint.length ? notes.mainPoint : ["(none)"]).forEach((t) => lines.push(`- ${t}`));
  lines.push("", "## Method");
  (notes.method.length ? notes.method : ["(none)"]).forEach((t) => lines.push(`- ${t}`));
  lines.push("", "## Notes");
  if (!notes.mixed.length) lines.push("(none)");
  notes.mixed.forEach((n) => {
    const tag = n.page != null ? `p. ${n.page}` : "chat";
    lines.push(n.type === "comment"
      ? `- (${tag}) ${n.comment} — ${n.gloss}`
      : `- (${tag}) ${n.text}`);
  });
  lines.push("", "## Citations");
  if (!notes.citations.length) lines.push("(none)");
  notes.citations.forEach((c) => lines.push(`- (p. ${c.page}) "${c.text}"`));
  return lines.join("\n");
}

async function copyNotesToClipboard() {
  try {
    await navigator.clipboard.writeText(notesToMarkdown());
    flashButton(els.copyNotesBtn, "Copied!");
  } catch (err) {
    showError("Could not copy: " + err);
  }
}

// highlightEls holds live DOM nodes, which can't be stored (IndexedDB
// refuses them outright). Never persist them.
function stripHighlightEls(list) {
  return (list || []).map((item) => {
    const { highlightEls, ...rest } = item;
    return rest;
  });
}

async function saveNotesToLibrary() {
  const payload = {
    id: currentLibraryEntryId || undefined,
    title: paperMeta.title || els.docTitle.textContent,
    authors: paperMeta.authors,
    main_point: notes.mainPoint,
    method: notes.method,
    notes: stripHighlightEls(notes.mixed),
    citations: stripHighlightEls(notes.citations),
  };
  const result = await backend.save_notes(payload);
  if (result && result.id) {
    currentLibraryEntryId = result.id;
    flashButton(els.saveNotesBtn, "Saved!");
  } else {
    showError((result && result.error) || "Could not save notes.");
  }
}

function flashButton(btn, message) {
  const original = btn.textContent;
  btn.textContent = message;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
}

/* ---------- Claudette chat (small, de-emphasized) ---------- */

function renderChat() {
  els.chatMessages.innerHTML = "";
  chatMessages.forEach((m) => {
    const div = document.createElement("div");
    div.className = `chat-msg chat-msg-${m.role === "user" ? "q" : "a"}${m.isNote ? " chat-msg-note" : ""}`;
    div.textContent = m.text;
    els.chatMessages.appendChild(div);
  });
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

async function sendChatMessage() {
  const question = els.chatInput.value.trim();
  if (!question) return;
  els.chatInput.value = "";
  // Sent so "add that to my notes" can condense what was actually said.
  const history = chatMessages
    .filter((m) => m.text && m.text !== "…")
    .map((m) => ({ role: m.role, text: m.text }));
  chatMessages.push({ role: "user", text: question });
  const answer = { role: "assistant", text: "…" };
  chatMessages.push(answer);
  renderChat();

  const result = await backend.ask_claudette(question, history);
  if (result && result.error) {
    answer.text = result.error;
  } else if (result && result.note) {
    answer.text = `✓ Added to notes: "${result.note}"`;
    answer.isNote = true;
    notes.mixed.push({ type: "chat", text: result.note, page: null });
    renderNotesPanel();
  } else {
    answer.text = (result && result.text) || "No response.";
  }
  renderChat();
}

/* ---------- Settings (Gemini API key) ---------- */

async function openSettings() {
  const settings = await backend.get_settings();
  els.settingsNameInput.value = readerName;
  els.apiKeyInput.value = "";
  els.apiKeyInput.placeholder = settings && settings.has_api_key
    ? "Key configured (paste to replace)" : "Gemini API key";
  els.settingsStatus.textContent = "";
  els.settingsStatus.classList.remove("status-error");
  els.settingsModal.hidden = false;
  els.apiKeyInput.focus();
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

/* ---------- Library ---------- */

async function openLibrary() {
  // Remember where to return to -- if a paper is currently open, "Back"
  // should go back to it (with playback/notes/scroll position intact)
  // rather than dumping the user at the welcome screen.
  libraryReturnScreen = els.reader.hidden ? "welcome" : "reader";
  if (isPlaying) { audio.pause(); setPlaying(false); }
  showScreen("library");
  await showLibraryFolder(null);
}

async function showLibraryFolder(folderId) {
  libraryFolderId = folderId;
  await refreshLibrary();
}

async function refreshLibrary() {
  const [folders, entries] = await Promise.all([
    backend.list_folders(),
    backend.list_library(),
  ]);
  libraryFolders = folders || [];
  libraryEntries = entries || [];
  if (!libraryFolders.some((f) => f.id === libraryFolderId)) libraryFolderId = null;
  renderLibraryList();
}

function showLibraryStatus(message, kind = "error") {
  els.libraryStatus.textContent = message || "";
  els.libraryStatus.hidden = !message;
  els.libraryStatus.classList.toggle("library-status-info", kind === "info");
}

async function backupLibrary() {
  const result = await backend.export_backup();
  showLibraryStatus(
    `Backup file created with ${result.papers} ${result.papers === 1 ? "paper" : "papers"}`
    + ` and ${result.folders} ${result.folders === 1 ? "folder" : "folders"}. Keep it somewhere safe, like iCloud Drive or Google Drive.`,
    "info",
  );
}

async function restoreLibrary() {
  const result = await backend.import_backup();
  if (!result) return;
  if (result.error) return showLibraryStatus(result.error);
  await showLibraryFolder(null);
  const parts = [];
  if (result.papersAdded) parts.push(`${result.papersAdded} ${result.papersAdded === 1 ? "paper" : "papers"} added`);
  if (result.papersUpdated) parts.push(`${result.papersUpdated} updated`);
  if (result.foldersAdded) parts.push(`${result.foldersAdded} ${result.foldersAdded === 1 ? "folder" : "folders"} added`);
  showLibraryStatus(parts.length ? `Restored: ${parts.join(", ")}.` : "Everything in that backup is already here.", "info");
}

async function openStorageInfo() {
  els.storageInfoModal.hidden = false;
  const { persisted, usageBytes } = await backend.storage_status();
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const lines = [];
  if (persisted === true) lines.push("This browser has agreed to keep Paper Reader's data even when the device runs low on space.");
  else if (persisted === false) lines.push("This browser hasn't yet agreed to keep Paper Reader's data permanently. It usually does after you've saved a few papers.");
  if (standalone) lines.push("You opened Paper Reader from its Home Screen icon, so the 7-day rule doesn't apply here.");
  if (usageBytes) lines.push(`Space used: about ${Math.max(1, Math.round(usageBytes / 1e6))} MB (including downloaded voices).`);
  els.storageInfoStatus.textContent = lines.join(" ");
  els.storageInfoStatus.hidden = !lines.length;
}

function renderLibraryList() {
  els.libraryList.innerHTML = "";
  showLibraryStatus("");
  const folder = libraryFolders.find((f) => f.id === libraryFolderId);
  els.libraryNewFolderBtn.hidden = Boolean(folder);

  if (folder) {
    els.libraryList.appendChild(libraryFolderHead(folder));
  } else {
    libraryFolders.forEach((f) => els.libraryList.appendChild(libraryFolderRow(f)));
  }

  const entries = libraryEntries.filter((e) => (e.folder || null) === libraryFolderId);
  entries.forEach((entry) => els.libraryList.appendChild(libraryEntryRow(entry)));

  els.libraryEmpty.hidden = entries.length > 0 || (!folder && libraryFolders.length > 0);
  els.libraryEmpty.textContent = folder
    ? "This folder is empty. Drag papers onto it in the library, or pick it from a paper's Folder menu."
    : "Nothing saved yet — open a paper, take some notes, and press Save.";
}

// Deliberately just an "open" row -- no inline delete here. Deleting an
// entry is only reachable by opening it and scrolling to the bottom of its
// detail view, so it's never a stray click away.
function libraryEntryRow(entry) {
  const btn = document.createElement("button");
  btn.className = "library-item";
  btn.draggable = true;
  const title = document.createElement("p");
  title.className = "library-item-title";
  title.textContent = entry.title || entry.source_filename || "Untitled";
  const meta = document.createElement("p");
  meta.className = "library-item-meta";
  const authors = (entry.authors || []).join(", ");
  const date = entry.saved_at ? new Date(entry.saved_at * 1000).toLocaleDateString() : "";
  meta.textContent = [authors, entry.source_filename, date].filter(Boolean).join(" · ");
  btn.append(title, meta);
  btn.addEventListener("click", () => openLibraryEntry(entry.id));
  btn.addEventListener("dragstart", (e) => {
    draggedEntryId = entry.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", entry.id);
    btn.classList.add("dragging");
  });
  btn.addEventListener("dragend", () => {
    draggedEntryId = null;
    btn.classList.remove("dragging");
  });
  return btn;
}

// Lets a dragged library entry be dropped onto `el` to move it into
// `folderId` (null = back to the top level).
function makeFolderDropTarget(el, folderId) {
  el.addEventListener("dragover", (e) => {
    if (!draggedEntryId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drop-target");
    const entryId = draggedEntryId;
    draggedEntryId = null;
    if (entryId && await moveEntryToFolder(entryId, folderId)) renderLibraryList();
  });
}

const FOLDER_ICON_SVG =
  '<svg class="library-folder-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>' +
  "</svg>";

function libraryFolderRow(folder) {
  const btn = document.createElement("button");
  btn.className = "library-item library-folder";
  btn.insertAdjacentHTML("afterbegin", FOLDER_ICON_SVG);
  const text = document.createElement("div");
  const title = document.createElement("p");
  title.className = "library-item-title";
  title.textContent = folder.name;
  const meta = document.createElement("p");
  meta.className = "library-item-meta";
  const count = libraryEntries.filter((e) => e.folder === folder.id).length;
  meta.textContent = count === 1 ? "1 paper" : `${count} papers`;
  text.append(title, meta);
  btn.appendChild(text);
  btn.addEventListener("click", () => showLibraryFolder(folder.id));
  makeFolderDropTarget(btn, folder.id);
  return btn;
}

function libraryFolderHead(folder) {
  const head = document.createElement("div");
  head.className = "library-folder-head";

  const back = document.createElement("button");
  back.className = "btn-ghost";
  back.textContent = "‹ Library";
  back.title = "Back to the library (drop a paper here to take it out of this folder)";
  back.addEventListener("click", () => showLibraryFolder(null));
  makeFolderDropTarget(back, null);

  const name = document.createElement("h3");
  name.className = "library-folder-name";
  name.textContent = folder.name;

  const actions = document.createElement("div");
  actions.className = "library-folder-actions";
  const renameBtn = document.createElement("button");
  renameBtn.className = "btn-ghost";
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("click", () => {
    const input = folderNameInput(folder.name, async (newName) => {
      const result = await backend.rename_folder(folder.id, newName);
      if (!result || result.error) return result || { error: "Could not rename that folder." };
      await refreshLibrary();
      return result;
    }, () => renderLibraryList());
    name.replaceWith(input);
    input.focus();
    input.select();
  });
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-ghost library-detail-delete";
  deleteBtn.textContent = "Delete folder";
  deleteBtn.addEventListener("click", () => deleteFolder(folder));
  actions.append(renameBtn, deleteBtn);

  head.append(back, name, actions);
  return head;
}

// Inline name field for creating/renaming a folder (no native prompt()).
// Enter or clicking away commits; Escape cancels. onCommit returns the API
// result, and an {error} keeps the field open with the message shown.
function folderNameInput(initial, onCommit, onCancel) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "library-folder-input";
  input.placeholder = "Folder name";
  input.maxLength = 60;
  input.value = initial;
  let busy = false;

  const finish = async (commit) => {
    if (busy) return;
    const name = input.value.trim();
    if (!commit || !name || name === initial) { busy = true; onCancel(); return; }
    busy = true;
    const result = await onCommit(name);
    if (result && result.error) {
      busy = false;
      showLibraryStatus(result.error);
      input.focus();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  return input;
}

function startNewFolder() {
  if (els.libraryList.querySelector(".library-folder-input")) return;
  const input = folderNameInput("", async (name) => {
    const result = await backend.create_folder(name);
    if (!result || result.error) return result || { error: "Could not create that folder." };
    await refreshLibrary();
    return result;
  }, () => renderLibraryList());
  els.libraryEmpty.hidden = true;
  els.libraryList.prepend(input);
  input.focus();
}

async function deleteFolder(folder) {
  const count = libraryEntries.filter((e) => e.folder === folder.id).length;
  const ok = await askConfirm(
    count
      ? `Delete the folder "${folder.name}"? The ${count === 1 ? "paper" : `${count} papers`} in it will move back to the main library — no notes are deleted.`
      : `Delete the empty folder "${folder.name}"?`,
    { title: "Delete this folder?", confirmLabel: "Delete folder" },
  );
  if (!ok) return;
  const result = await backend.delete_folder(folder.id);
  if (!result || result.error) return showLibraryStatus((result && result.error) || "Could not delete that folder.");
  await showLibraryFolder(null);
}

async function moveEntryToFolder(entryId, folderId) {
  const result = await backend.move_library_entry(entryId, folderId);
  if (!result || result.error) {
    showLibraryStatus((result && result.error) || "Could not move that paper.");
    return false;
  }
  const row = libraryEntries.find((e) => e.id === entryId);
  if (row) row.folder = folderId;
  return true;
}

// A real popup confirmation (not an inline "click again") for the places in
// the library that remove things. Resolves true/false.
let confirmModalResolve = null;

function askConfirm(message, { title = "Delete this entry?", confirmLabel = "Delete permanently" } = {}) {
  els.confirmModalTitle.textContent = title;
  els.confirmModalDeleteBtn.textContent = confirmLabel;
  els.confirmModalText.textContent = message;
  els.confirmModal.hidden = false;
  return new Promise((resolve) => { confirmModalResolve = resolve; });
}

function closeConfirmModal(result) {
  els.confirmModal.hidden = true;
  if (confirmModalResolve) {
    confirmModalResolve(result);
    confirmModalResolve = null;
  }
}

async function deleteLibraryEntry(entryId, onDeleted) {
  const result = await backend.delete_library_entry(entryId);
  if (result && result.deleted) {
    if (currentLibraryEntryId === entryId) currentLibraryEntryId = null;
    onDeleted();
  } else {
    showLibraryStatus((result && result.error) || "Could not delete that entry.");
  }
}

async function openLibraryEntry(entryId) {
  const entry = await backend.load_library_entry(entryId);
  if (!entry || entry.error) return showLibraryStatus((entry && entry.error) || "Could not open that entry.");
  renderLibraryDetail(entry);
}

function readonlySection(label, items, kind) {
  const section = document.createElement("div");
  section.className = "notes-section";
  const h = document.createElement("h4");
  h.textContent = label;
  section.appendChild(h);
  const ul = document.createElement("ul");
  ul.className = "notes-list";

  const rows = items || [];
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "notes-empty";
    li.textContent = "Nothing saved.";
    ul.appendChild(li);
  } else if (kind === "bullets") {
    rows.forEach((t) => {
      const li = document.createElement("li");
      li.textContent = `• ${t}`;
      ul.appendChild(li);
    });
  } else if (kind === "mixed") {
    rows.forEach((entry) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "notes-page-tag";
      tag.textContent = entry.page != null ? `p. ${entry.page}` : "chat";
      li.appendChild(tag);
      if (entry.type !== "comment") {
        li.appendChild(document.createTextNode(`• ${entry.text}`));
      } else {
        const c = document.createElement("span");
        c.className = "notes-comment-text";
        c.textContent = entry.comment;
        const g = document.createElement("span");
        g.className = "notes-comment-gloss";
        g.textContent = entry.gloss;
        li.append(c, g);
      }
      ul.appendChild(li);
    });
  } else if (kind === "citations") {
    rows.forEach((c) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "notes-page-tag";
      tag.textContent = `p. ${c.page}`;
      const q = document.createElement("span");
      q.className = "notes-citation-text";
      q.textContent = `“${c.text}”`;
      li.append(tag, q);
      ul.appendChild(li);
    });
  }
  section.appendChild(ul);
  return section;
}

function renderLibraryDetail(entry) {
  els.libraryList.innerHTML = "";
  els.libraryEmpty.hidden = true;
  els.libraryNewFolderBtn.hidden = true;
  showLibraryStatus("");

  const folderName = (id) => (libraryFolders.find((f) => f.id === id) || {}).name;
  if (!folderName(entry.folder)) entry.folder = null;

  const back = document.createElement("button");
  back.className = "btn-ghost";
  const updateBackLabel = () => {
    back.textContent = entry.folder ? `‹ ${folderName(entry.folder)}` : "‹ All saved papers";
  };
  updateBackLabel();
  back.addEventListener("click", () => showLibraryFolder(entry.folder));
  els.libraryList.appendChild(back);

  const wrap = document.createElement("div");
  wrap.className = "library-detail";

  const title = document.createElement("p");
  title.className = "notes-paper-title";
  title.textContent = entry.title || entry.source_filename || "Untitled";
  wrap.appendChild(title);

  if (entry.authors && entry.authors.length) {
    const authors = document.createElement("p");
    authors.className = "notes-paper-authors";
    authors.textContent = entry.authors.join(", ");
    wrap.appendChild(authors);
  }

  const folderField = document.createElement("label");
  folderField.className = "library-detail-folder";
  const folderLabel = document.createElement("span");
  folderLabel.className = "control-label";
  folderLabel.textContent = "Folder";
  const folderSelect = document.createElement("select");
  folderSelect.className = "select";
  folderSelect.add(new Option("No folder", ""));
  libraryFolders.forEach((f) => folderSelect.add(new Option(f.name, f.id)));
  folderSelect.value = entry.folder || "";
  folderSelect.addEventListener("change", async () => {
    const target = folderSelect.value || null;
    if (await moveEntryToFolder(entry.id, target)) {
      entry.folder = target;
      updateBackLabel();
    } else {
      folderSelect.value = entry.folder || "";
    }
  });
  folderField.append(folderLabel, folderSelect);
  wrap.appendChild(folderField);

  if (entry.source_path) {
    const openBtn = document.createElement("button");
    openBtn.className = "btn-primary";
    openBtn.textContent = "Open this paper";
    openBtn.style.margin = "14px 0";
    openBtn.addEventListener("click", async () => {
      // loadPdfFromPath resets notes for a fresh document; skip its own
      // "found saved notes" check since we already know exactly which
      // entry to restore, then apply it on top.
      await loadPdfFromPath(entry.source_path, entry.source_filename, true);
      applyLibraryEntryToState(entry);
    });
    wrap.appendChild(openBtn);
  }

  wrap.appendChild(readonlySection("Main point", entry.main_point, "bullets"));
  wrap.appendChild(readonlySection("Method", entry.method, "bullets"));
  wrap.appendChild(readonlySection("Notes", entry.notes, "mixed"));
  wrap.appendChild(readonlySection("Citations", entry.citations, "citations"));

  // Deliberately last, after every section -- deleting requires opening
  // the entry and scrolling all the way down to find this, then
  // confirming again in a popup. Never a click away by accident.
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-ghost library-detail-delete";
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete this entry";
  deleteBtn.addEventListener("click", async () => {
    const name = entry.title || entry.source_filename || "this entry";
    const ok = await askConfirm(`Permanently delete "${name}"? This can't be undone.`);
    if (!ok) return;
    deleteLibraryEntry(entry.id, () => showLibraryFolder(entry.folder));
  });
  wrap.appendChild(deleteBtn);

  els.libraryList.appendChild(wrap);
}

async function safeInit() {
  try { await init(); }
  catch (err) { showError("Startup failed: " + err); console.error(err); }
}

if (window.backend) safeInit();
else window.addEventListener("backendready", safeInit);
