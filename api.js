// The browser stand-in for the Mac app's Python backend (main.py's Api
// class): same method names and result shapes, so app.js barely changes.

import { openPdfDocument, extractPageWords, extractBlocks, orderedPageWords, stripCitations } from "./pdf-reader.js";
import * as db from "./storage.js";
import * as claudette from "./claudette.js";

const VOICES = {
  "en_GB-alba-medium": "en/en_GB/alba/medium/en_GB-alba-medium",
  "en_US-amy-medium": "en/en_US/amy/medium/en_US-amy-medium",
  "en_US-bryce-medium": "en/en_US/bryce/medium/en_US-bryce-medium",
};

const state = {
  path: null, filename: null, bytes: null,
  doc: null, blocks: [], pageWords: [], pageSizes: [],
  imageUrls: [],
};
// PDFs picked or dropped this session, keyed by content hash, until loaded.
const pickedFiles = new Map();

async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The "path" of a PDF is its content hash, so opening the same file again
// (even renamed, on another day) finds its saved notes.
async function registerFile(file) {
  const bytes = await file.arrayBuffer();
  const path = `pdf:${await hashBytes(bytes)}`;
  pickedFiles.set(path, { bytes, filename: file.name });
  return { path, filename: file.name };
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    const finish = (file) => { input.remove(); resolve(file); };
    input.addEventListener("change", () => finish(input.files[0] || null), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    input.click();
  });
}

const notFound = (what) => ({ error: `That ${what} no longer exists.` });

function folderNameError(name, folders, ignoreId = null) {
  if (!name) return "Give the folder a name.";
  if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase() && f.id !== ignoreId)) {
    return `There is already a folder called "${name}".`;
  }
  return null;
}

const cleanFolderName = (name) => (name || "").replace(/\s+/g, " ").trim().slice(0, 60);

function randomId(prefix) {
  return prefix + [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function revokeImages() {
  state.imageUrls.forEach((url) => URL.revokeObjectURL(url));
  state.imageUrls = [];
}

// ---------------------------------------------------------------- speech

const ttsWorker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
const ttsPending = new Map();
let ttsNextId = 1;
let ttsFailure = null;

// A worker that can't start (e.g. a component failed to download) never
// answers -- turn that into an error instead of a forever-spinning Play.
ttsWorker.onerror = (event) => {
  event.preventDefault();
  ttsFailure = `Speech synthesis failed: the speech engine couldn't start (${event.message || "check your internet connection and reload"}).`;
  for (const resolve of ttsPending.values()) resolve({ error: ttsFailure });
  ttsPending.clear();
};

ttsWorker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "progress") {
    window.dispatchEvent(new CustomEvent("voicedownload", { detail: message }));
    return;
  }
  const pending = ttsPending.get(message.id);
  if (!pending) return;
  ttsPending.delete(message.id);
  if (message.error) pending({ error: `Speech synthesis failed: ${message.error}` });
  else pending({ audio_url: URL.createObjectURL(new Blob([message.wav], { type: "audio/wav" })) });
};

// ---------------------------------------------------------------- backup

function bytesToBase64(bytes) {
  const u8 = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8.buffer;
}

// ---------------------------------------------------------------- API

export const backend = {
  register_file: registerFile,

  async pick_pdf_path() {
    const file = await pickFile("application/pdf,.pdf");
    if (!file) return null;
    return registerFile(file);
  },

  async load_pdf(path) {
    try {
      const source = pickedFiles.get(path) || await db.get("pdfs", path);
      if (!source) return { error: "That PDF isn't stored in this browser any more. Open it again from your files." };
      if (state.doc) await state.doc.destroy();
      revokeImages();
      const doc = await openPdfDocument(source.bytes);
      const pages = [];
      const pageSizes = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const { width, height } = page.getViewport({ scale: 1 });
        pageSizes.push({ width_pt: width, height_pt: height });
        pages.push({ words: await extractPageWords(page, n), width });
      }
      const blocks = extractBlocks(pages);
      Object.assign(state, {
        path, filename: source.filename, bytes: source.bytes, doc, blocks,
        pageWords: pages.map((p) => p.words), pageSizes,
      });
      pickedFiles.delete(path);
      const counts = (kind) => blocks.filter((b) => b.kind === kind).length;
      return {
        filename: source.filename,
        blocks,
        pages: pageSizes,
        stats: { headings: counts("heading"), paragraphs: counts("text"), footnotes: counts("footnote") },
      };
    } catch (err) {
      console.error(err);
      return { error: `Could not read that PDF: ${err.message || err}` };
    }
  },

  async render_page(pageNumber, dpi = 150) {
    try {
      if (!state.doc || pageNumber < 1 || pageNumber > state.doc.numPages) return { error: "That page does not exist." };
      const page = await state.doc.getPage(pageNumber);
      // iPads cap canvas memory, so stay at or below ~216 dpi.
      const viewport = page.getViewport({ scale: Math.min(dpi / 72, 3) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
      canvas.width = 0;
      canvas.height = 0;
      const url = URL.createObjectURL(blob);
      state.imageUrls.push(url);
      return { image_url: url, ...state.pageSizes[pageNumber - 1] };
    } catch (err) {
      return { error: `Could not render page ${pageNumber}: ${err.message || err}` };
    }
  },

  async get_page_words(pageNumber) {
    const words = state.pageWords[pageNumber - 1];
    if (!words) return { error: "That page does not exist." };
    return { words: orderedPageWords(words, state.pageSizes[pageNumber - 1].width_pt, pageNumber) };
  },

  // ---- settings

  async get_settings() {
    return { has_api_key: Boolean(await db.getSetting("gemini_api_key")), name: (await db.getSetting("name")) || "" };
  },

  async save_api_key(key) {
    const clean = (key || "").trim();
    await db.setSetting("gemini_api_key", clean);
    return { has_api_key: Boolean(clean) };
  },

  async save_name(name) {
    const clean = (name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    await db.setSetting("name", clean);
    return { name: clean };
  },

  // ---- Claudette

  async summarize_paper() {
    if (!state.blocks.length) return { error: "No paper loaded." };
    return claudette.summarizePaper(await db.getSetting("gemini_api_key"), state.blocks);
  },

  async ai_selection(kind, text) {
    if (!["summarize", "comment_gloss"].includes(kind)) return { error: "Unknown request." };
    if (!(text || "").trim()) return { error: "Nothing selected." };
    return claudette.selectionNote(await db.getSetting("gemini_api_key"), kind, text, state.blocks);
  },

  async explain_selection(text) {
    if (!(text || "").trim()) return { error: "Nothing selected." };
    return claudette.explainSelection(await db.getSetting("gemini_api_key"), text, state.blocks);
  },

  async ask_claudette(question, history) {
    if (!state.blocks.length) return { error: "No paper loaded." };
    return claudette.askClaudette(await db.getSetting("gemini_api_key"), question, history, state.blocks);
  },

  // ---- library

  async save_notes(payload) {
    try {
      const title = (payload.title || state.filename || "Untitled").trim();
      const existing = payload.id ? await db.get("entries", payload.id) : null;
      const id = existing ? existing.id
        : `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled"}-${randomId("")}`;
      if (state.path && state.bytes && !(await db.get("pdfs", state.path))) {
        await db.put("pdfs", { bytes: state.bytes, filename: state.filename }, state.path);
      }
      await db.put("entries", {
        id,
        source_path: state.path,
        source_filename: state.filename,
        title,
        authors: payload.authors || [],
        main_point: payload.main_point || [],
        method: payload.method || [],
        notes: payload.notes || [],
        citations: payload.citations || [],
        saved_at: Date.now() / 1000,
        // Re-saving must not drop the entry out of its folder.
        folder: existing ? existing.folder ?? null : null,
      });
      db.requestPersistence();
      return { id };
    } catch (err) {
      return { error: `Could not save notes: ${err.message || err}` };
    }
  },

  async list_library() {
    const folderIds = new Set((await db.getAll("folders")).map((f) => f.id));
    return (await db.getAll("entries"))
      .map((d) => ({
        id: d.id, title: d.title, authors: d.authors || [],
        source_filename: d.source_filename, source_path: d.source_path, saved_at: d.saved_at,
        folder: folderIds.has(d.folder) ? d.folder : null,
      }))
      .sort((a, b) => (b.saved_at || 0) - (a.saved_at || 0));
  },

  async list_folders() {
    return (await db.getAll("folders")).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  },

  async create_folder(name) {
    const clean = cleanFolderName(name);
    const error = folderNameError(clean, await db.getAll("folders"));
    if (error) return { error };
    const folder = { id: randomId("f"), name: clean };
    await db.put("folders", folder);
    return folder;
  },

  async rename_folder(folderId, name) {
    const clean = cleanFolderName(name);
    const folders = await db.getAll("folders");
    const folder = folders.find((f) => f.id === folderId);
    if (!folder) return notFound("folder");
    const error = folderNameError(clean, folders, folderId);
    if (error) return { error };
    folder.name = clean;
    await db.put("folders", folder);
    return folder;
  },

  // Removes the folder only -- its papers move back to the top level.
  async delete_folder(folderId) {
    if (!(await db.get("folders", folderId))) return notFound("folder");
    for (const entry of await db.getAll("entries")) {
      if (entry.folder === folderId) await db.put("entries", { ...entry, folder: null });
    }
    await db.remove("folders", folderId);
    return { deleted: true };
  },

  async move_library_entry(entryId, folderId) {
    const entry = await db.get("entries", entryId);
    if (!entry) return notFound("entry");
    if (folderId !== null && !(await db.get("folders", folderId))) return notFound("folder");
    await db.put("entries", { ...entry, folder: folderId });
    return { moved: true };
  },

  async load_library_entry(entryId) {
    return (await db.get("entries", entryId)) || notFound("entry");
  },

  async delete_library_entry(entryId) {
    const entry = await db.get("entries", entryId);
    if (!entry) return notFound("entry");
    await db.remove("entries", entryId);
    // Drop the stored PDF too, unless another entry still uses it.
    const stillUsed = (await db.getAll("entries")).some((e) => e.source_path === entry.source_path);
    if (entry.source_path && !stillUsed) await db.remove("pdfs", entry.source_path);
    return { deleted: true };
  },

  // ---- speech

  async list_voices() {
    return Object.keys(VOICES);
  },

  synthesize(blockIndex, sentenceIndex, voiceId, speed = 1.0, skipCitations = false) {
    const block = state.blocks[blockIndex];
    if (!block) return Promise.resolve({ error: "That paragraph does not exist." });
    const sentence = block.sentences[sentenceIndex];
    if (!sentence) return Promise.resolve({ error: "That sentence does not exist." });
    if (!VOICES[voiceId]) return Promise.resolve({ error: "No voice selected." });
    if (ttsFailure) return Promise.resolve({ error: ttsFailure });
    const text = skipCitations ? stripCitations(sentence.text) : sentence.text;
    return new Promise((resolve) => {
      const id = ttsNextId++;
      ttsPending.set(id, resolve);
      ttsWorker.postMessage({ id, text, voiceId, voicePath: VOICES[voiceId], speed });
    });
  },

  // ---- backup / restore

  async export_backup() {
    const entries = await db.getAll("entries");
    const pdfs = {};
    for (const path of new Set(entries.map((e) => e.source_path).filter(Boolean))) {
      const pdf = await db.get("pdfs", path);
      if (pdf) pdfs[path] = { filename: pdf.filename, data: bytesToBase64(pdf.bytes) };
    }
    const backup = {
      app: "paper-reader", version: 1, exported_at: new Date().toISOString(),
      folders: await db.getAll("folders"), entries, pdfs,
    };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Paper Reader backup ${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    return { papers: entries.length, folders: backup.folders.length };
  },

  // Adds what's in the file; never deletes anything already here. When the
  // same paper is in both, the more recently saved version wins.
  async import_backup() {
    const file = await pickFile("application/json,.json");
    if (!file) return null;
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { backup = null; }
    if (!backup || backup.app !== "paper-reader" || !Array.isArray(backup.entries)) {
      return { error: "That file isn't a Paper Reader backup." };
    }
    const existingFolders = await db.getAll("folders");
    const folderMap = new Map();
    let foldersAdded = 0;
    for (const folder of backup.folders || []) {
      const same = existingFolders.find((f) => f.id === folder.id)
        || existingFolders.find((f) => f.name.toLowerCase() === String(folder.name).toLowerCase());
      if (same) { folderMap.set(folder.id, same.id); continue; }
      await db.put("folders", { id: folder.id, name: cleanFolderName(folder.name) || "Untitled folder" });
      existingFolders.push(folder);
      folderMap.set(folder.id, folder.id);
      foldersAdded += 1;
    }
    let papersAdded = 0;
    let papersUpdated = 0;
    for (const entry of backup.entries) {
      if (!entry || !entry.id) continue;
      const current = await db.get("entries", entry.id);
      if (current && (current.saved_at || 0) >= (entry.saved_at || 0)) continue;
      await db.put("entries", { ...entry, folder: folderMap.get(entry.folder) ?? null });
      if (current) papersUpdated += 1; else papersAdded += 1;
    }
    for (const [path, pdf] of Object.entries(backup.pdfs || {})) {
      if (!(await db.get("pdfs", path))) await db.put("pdfs", { filename: pdf.filename, bytes: base64ToBytes(pdf.data) }, path);
    }
    db.requestPersistence();
    return { papersAdded, papersUpdated, foldersAdded };
  },

  storage_status: db.storageStatus,
};
