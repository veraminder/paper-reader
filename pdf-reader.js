// PDF loading and layout analysis -- a line-for-line port of the Mac app's
// pdfplumber pipeline (main.py) on top of pdf.js.

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs";

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/";

// Workers must be same-origin, so wrap the CDN worker in a tiny same-origin
// module worker that imports it (otherwise pdf.js silently falls back to
// parsing on the main thread).
const workerBlob = new Blob([`import "${PDFJS_BASE}build/pdf.worker.min.mjs";`], { type: "text/javascript" });
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(workerBlob), { type: "module" });

export async function openPdfDocument(bytes) {
  // pdf.js transfers the buffer it is given to its worker, so pass a copy.
  return pdfjsLib.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    cMapUrl: `${PDFJS_BASE}../cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}../standard_fonts/`,
  }).promise;
}

// --------------------------------------------------------------------------
// Words (emulates pdfplumber's extract_words(x_tolerance=1.5,
// extra_attrs=["size", "fontname"]) with only upright text kept)
// --------------------------------------------------------------------------

const X_TOLERANCE = 1.5;
const Y_TOLERANCE = 3;

function fontNameOf(page, fontId, style) {
  try {
    if (page.commonObjs.has(fontId)) {
      const font = page.commonObjs.get(fontId);
      if (font && font.name) return font.name;
    }
  } catch { /* font not resolved -- fall back below */ }
  return (style && style.fontFamily) || fontId;
}

export async function extractPageWords(page, pageNumber) {
  const viewport = page.getViewport({ scale: 1 });
  // Loads the page's fonts, so their real names (e.g. "Times-Bold") are
  // available -- heading detection relies on spotting bold fonts.
  await page.getOperatorList();
  const content = await page.getTextContent();

  const segments = [];
  content.items.forEach((item, itemIndex) => {
    const str = item.str;
    if (!str || !str.trim()) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    // Upright, left-to-right text only: sideways watermarks and rotated
    // figure labels have scrambled geometry for reading order.
    if (Math.abs(tx[1]) > 1e-3 || Math.abs(tx[2]) > 1e-3 || tx[0] <= 0) return;
    const size = Math.round(Math.abs(tx[3]) * 100) / 100;
    if (!size) return;
    const style = content.styles[item.fontName] || {};
    const descent = typeof style.descent === "number" ? style.descent : -0.2;
    // Same box pdfminer gives a glyph: exactly `size` tall, sitting on the
    // font's descent below the baseline.
    const bottom = tx[5] - descent * size;
    const top = bottom - size;
    const fontname = fontNameOf(page, item.fontName, style);
    const charWidth = item.width / str.length;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(str))) {
      segments.push({
        text: m[0],
        x0: tx[4] + m.index * charWidth,
        x1: tx[4] + (m.index + m[0].length) * charWidth,
        top, bottom, size, fontname,
        itemIndex, start: m.index, end: m.index + m[0].length,
      });
    }
  });

  // Cluster into lines by top (pdfplumber's cluster_objects), then join
  // touching runs of the same font into words.
  segments.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const clusters = [];
  let lastTop = null;
  for (const seg of segments) {
    if (lastTop === null || seg.top - lastTop > Y_TOLERANCE) clusters.push([]);
    clusters[clusters.length - 1].push(seg);
    lastTop = seg.top;
  }

  const words = [];
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x0 - b.x0);
    let word = null;
    for (const seg of cluster) {
      const separatedBySpace = word && seg.itemIndex === word.lastItem && seg.start > word.lastEnd;
      if (word && !separatedBySpace && seg.x0 - word.x1 <= X_TOLERANCE
          && seg.size === word.size && seg.fontname === word.fontname) {
        word.text += seg.text;
        word.x1 = Math.max(word.x1, seg.x1);
        word.top = Math.min(word.top, seg.top);
        word.bottom = Math.max(word.bottom, seg.bottom);
        word.lastItem = seg.itemIndex;
        word.lastEnd = seg.end;
      } else {
        word = {
          text: seg.text, x0: seg.x0, x1: seg.x1, top: seg.top, bottom: seg.bottom,
          size: seg.size, fontname: seg.fontname, page: pageNumber,
          lastItem: seg.itemIndex, lastEnd: seg.end,
        };
        words.push(word);
      }
    }
  }
  return words.map(({ lastItem, lastEnd, ...w }) => w);
}

// --------------------------------------------------------------------------
// Helpers mirroring Python semantics
// --------------------------------------------------------------------------

// Python's round() rounds halves to even; the bucketing below depends on it.
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Counter.most_common(1): highest count, earliest-inserted on ties.
function mostCommon(counter) {
  let best = null;
  for (const [key, count] of counter) {
    if (!best || count > best[1]) best = [key, count];
  }
  return best;
}

function count(counter, key, by = 1) {
  counter.set(key, (counter.get(key) || 0) + by);
}

// --------------------------------------------------------------------------
// Lines and rects
// --------------------------------------------------------------------------

const HEADING_WORDS = "(abstract|introduction|conclusions?|references|bibliography|works cited|acknowledge?ments?|appendix|methods?|methodology|results?|discussion|literature review|background|summary|keywords|zusammenfassung|einleitung|fazit|literatur)";
const HEADING_WORDS_RE = new RegExp(`^\\s*${HEADING_WORDS}\\s*$`, "i");
const TAIL_HEADING = /^\s*(references|bibliography|works cited|literatur(verzeichnis)?)\b/i;
const COVER_NOISE = new RegExp(
  "^\\s*("
  + "date downloaded|source:\\s*content downloaded|citations?:\\s*please note|"
  + "bluebook\\s|alwd\\s|apa\\s\\d|chicago\\s\\d|mcgill guide|oscola|aglc|"
  + "provided by|your use of this .* pdf|this content downloaded|"
  + "all use subject to|electronic copy available at|downloaded from"
  + ")", "i",
);

function groupWordsIntoLines(words, tolerance = 2.5) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines = [];
  let current = [sorted[0]];
  let currentTop = sorted[0].top;
  for (const word of sorted.slice(1)) {
    if (Math.abs(word.top - currentTop) <= tolerance) {
      current.push(word);
    } else {
      lines.push(current.sort((a, b) => a.x0 - b.x0));
      current = [word];
      currentTop = word.top;
    }
  }
  lines.push(current.sort((a, b) => a.x0 - b.x0));
  return lines;
}

function lineRecord(words, pageNumber) {
  const sizes = words.map((w) => w.size || 0).filter(Boolean);
  const fonts = words.map((w) => String(w.fontname || "").toLowerCase());
  const boldCount = fonts.filter((f) => f.includes("bold") || f.includes("black")).length;
  return {
    words,
    text: words.map((w) => w.text).join(" "),
    size: sizes.length ? median(sizes) : 0,
    bold: boldCount > fonts.length / 2,
    x0: Math.min(...words.map((w) => w.x0)),
    x1: Math.max(...words.map((w) => w.x1)),
    top: Math.min(...words.map((w) => w.top)),
    bottom: Math.max(...words.map((w) => w.bottom)),
    page: pageNumber,
  };
}

function groupWordsIntoRects(words, tolerance = 2.5) {
  if (!words.length) return [];
  const rects = [];
  const first = words[0];
  let current = { page: first.page, x0: first.x0, x1: first.x1, top: first.top, bottom: first.bottom };
  let lineTop = first.top;
  for (const w of words.slice(1)) {
    if (w.page === current.page && Math.abs(w.top - lineTop) <= tolerance) {
      current.x0 = Math.min(current.x0, w.x0);
      current.x1 = Math.max(current.x1, w.x1);
      current.top = Math.min(current.top, w.top);
      current.bottom = Math.max(current.bottom, w.bottom);
    } else {
      rects.push(current);
      current = { page: w.page, x0: w.x0, x1: w.x1, top: w.top, bottom: w.bottom };
      lineTop = w.top;
    }
  }
  rects.push(current);
  return rects;
}

// --------------------------------------------------------------------------
// Column detection
// --------------------------------------------------------------------------

const GUTTER_MIN_GAP = 8;

function detectGutter(lines, pageWidth) {
  const candidates = new Map();
  let multiWordLines = 0;
  for (const line of lines) {
    const words = [...line.words].sort((a, b) => a.x0 - b.x0);
    if (words.length < 2) continue;
    multiWordLines += 1;
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i];
      const b = words[i + 1];
      if (b.x0 - a.x1 < GUTTER_MIN_GAP) continue;
      const mid = (a.x1 + b.x0) / 2;
      if (mid >= pageWidth * 0.25 && mid <= pageWidth * 0.75) {
        count(candidates, roundHalfEven(mid / 4) * 4);
      }
    }
  }
  if (multiWordLines < 8 || !candidates.size) return null;
  const [gutterX, support] = mostCommon(candidates);
  if (support < Math.max(6, multiWordLines * 0.25)) return null;
  return gutterX;
}

function splitRow(line, gutterX) {
  const words = [...line.words].sort((a, b) => a.x0 - b.x0);
  const left = words.filter((w) => w.x1 <= gutterX);
  const right = words.filter((w) => w.x0 >= gutterX);
  if (left.length + right.length !== words.length) return null;
  if (left.length && right.length) {
    const gap = right[0].x0 - left[left.length - 1].x1;
    if (gap < GUTTER_MIN_GAP) return null;
  }
  return [left, right];
}

function resolveColumns(lines, pageWidth, pageNumber) {
  const gutterX = detectGutter(lines, pageWidth);
  if (gutterX === null) return lines;

  const splitRows = lines.map((line) => [splitRow(line, gutterX), line]);
  const leftX1s = splitRows.flatMap(([split]) => (split ? split[0].map((w) => w.x1) : []));
  const rightX1s = splitRows.flatMap(([split]) => (split ? split[1].map((w) => w.x1) : []));
  const leftEdge = leftX1s.length ? Math.max(...leftX1s) : gutterX;
  const rightEdge = rightX1s.length ? Math.max(...rightX1s) : pageWidth;

  const ordered = [];
  let leftBuf = [];
  let rightBuf = [];
  const flushColumns = () => {
    ordered.push(...leftBuf, ...rightBuf);
    leftBuf = [];
    rightBuf = [];
  };

  for (const [split, line] of splitRows) {
    if (split === null) {
      flushColumns();
      ordered.push(line);
      continue;
    }
    const [leftWords, rightWords] = split;
    if (leftWords.length) {
      const l = lineRecord(leftWords, pageNumber);
      l.col = "left";
      l.col_x1 = leftEdge;
      leftBuf.push(l);
    }
    if (rightWords.length) {
      const r = lineRecord(rightWords, pageNumber);
      r.col = "right";
      r.col_x1 = rightEdge;
      rightBuf.push(r);
    }
  }
  flushColumns();
  return ordered;
}

function normalizeForRepetition(text) {
  return text.trim().toLowerCase().replace(/\d+/g, "#");
}

function findRunningLines(pagesLines) {
  const counts = new Map();
  for (const lines of pagesLines) {
    const candidates = [...lines.slice(0, 2), ...lines.slice(-2)];
    for (const line of candidates) {
      const key = normalizeForRepetition(line.text);
      if (key.length > 3) count(counts, key);
    }
  }
  const threshold = Math.max(2, pagesLines.length * 0.35);
  return new Set([...counts].filter(([, c]) => c >= threshold).map(([k]) => k));
}

function isHeading(line, bodySize, maxX1) {
  const text = line.text.trim();
  if (!text || text.length > 110) return false;
  const words = text.split(/\s+/);
  if (words.length > 14) return false;

  const stripped = text.replace(/^[IVXLC]+[.)]?\s*|^\d+([.)]\d*)*[.)]?\s*/i, "");
  if (HEADING_WORDS_RE.test(stripped.trim().replace(/^[ .:]+|[ .:]+$/g, ""))) return true;

  const looksStyled = line.bold || line.size >= bodySize + 0.8;
  if (!looksStyled) return false;
  if (/[.;,]$/.test(text) && !/^\d+([.)]\d*)*[.)]?\s+\S/.test(text)) return false;
  const localX1 = line.col_x1 ?? maxX1;
  if (line.x1 > localX1 - 15 && words.length > 8) return false;
  return true;
}

function stripFootnoteMarkers(words, bodySize) {
  return words.filter((word) => {
    const size = word.size || bodySize;
    return !(size && size < bodySize - 1.0 && /^[\d,\-–]{1,4}$/.test(word.text));
  });
}

function stripInlineMarkers(text) {
  return text.replace(/([a-zA-Z.!?"'’”)])(\d{1,3})(?=[\s,;.]|$)/g, "$1");
}

function cleanText(text) {
  return text.replace(/\s+/g, " ").trim().replace(/\s+([.,;:!?])/g, "$1");
}

const CITATION_RE = /\([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*\)|\[\d+(?:\s*[,\-–]\s*\d+)*\]/g;

export function stripCitations(text) {
  return cleanText(text.replace(CITATION_RE, ""));
}

// --------------------------------------------------------------------------
// Sentence splitting
// --------------------------------------------------------------------------

const SENTENCE_GUARDS = [
  [/\b(cf|eg|ie|etc|v|vs|viz|al|ibid|Nr|No|pp|p|ed|eds|trans|Art|Abs|para|paras)\./g, "$1<DOT>"],
  [/\b(Dr|Prof|Mr|Mrs|Ms|St|vgl|bzw|ca|Hrsg)\./g, "$1<DOT>"],
  [/\b([A-Z])\.(?=\s*[A-Z])/g, "$1<DOT>"],
  [/(\d)\.(?=\s*\d)/g, "$1<DOT>"],
];

// Equivalent to Python's re.split(r"(?<=[.!?])[\"')\]]*\s+", text)
// without lookbehind (older Safari).
function splitSentences(text) {
  const pieces = [];
  const re = /[.!?](["')\]]*\s+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const cut = m.index + 1;
    pieces.push(text.slice(last, cut));
    last = cut + m[1].length;
  }
  pieces.push(text.slice(last));
  return pieces;
}

function splitWordsIntoSentences(words) {
  let protectedText = words.map((w) => w.text).join(" ");
  for (const [pattern, replacement] of SENTENCE_GUARDS) {
    protectedText = protectedText.replace(pattern, replacement);
  }
  const groupSizes = [];
  for (let piece of splitSentences(protectedText)) {
    piece = piece.replaceAll("<DOT>", ".").trim();
    if (!piece) continue;
    const n = piece.split(/\s+/).length;
    if (groupSizes.length && n < 2) groupSizes[groupSizes.length - 1] += n;
    else groupSizes.push(n);
  }
  if (groupSizes.reduce((a, b) => a + b, 0) !== words.length) return [words];
  const result = [];
  let idx = 0;
  for (const n of groupSizes) {
    result.push(words.slice(idx, idx + n));
    idx += n;
  }
  return result;
}

// --------------------------------------------------------------------------
// Blocks
// --------------------------------------------------------------------------

export function linesForPage(words, pageWidth, pageNumber) {
  const raw = groupWordsIntoLines(words).filter((g) => g.length).map((g) => lineRecord(g, pageNumber));
  return { raw, ordered: resolveColumns(raw, pageWidth, pageNumber) };
}

// pages: [{ words, width }] in page order.
export function extractBlocks(pages) {
  const pagesLines = [];
  const pagesRawLines = [];
  pages.forEach(({ words, width }, i) => {
    const { raw, ordered } = linesForPage(words, width, i + 1);
    pagesRawLines.push(raw);
    pagesLines.push(ordered);
  });

  const allLines = pagesLines.flat();
  if (!allLines.length) return [];

  const sizeWeight = new Map();
  for (const line of allLines) count(sizeWeight, roundHalfEven(line.size * 2) / 2, line.text.length);
  const bodySize = sizeWeight.size ? mostCommon(sizeWeight)[0] : 10.0;
  const maxX1 = Math.max(...allLines.map((l) => l.x1));
  const running = findRunningLines(pagesRawLines);

  const blocks = [];
  let bufferWords = [];
  let bufferLines = [];
  let inReferences = false;
  let currentSection = null;

  const sentenceText = (words, kind) => {
    let t = cleanText(words.map((w) => w.text).join(" "));
    t = t.replace(/([\p{L}\p{N}_])-\s+(?=[a-z])/gu, "$1");
    if (kind === "text") t = cleanText(stripInlineMarkers(t));
    return t;
  };

  const flush = (kind = "text") => {
    if (!bufferWords.length) return;
    const text = sentenceText(bufferWords, kind);
    if (text.length >= 40) {
      const groups = kind === "text" ? splitWordsIntoSentences(bufferWords) : [bufferWords];
      blocks.push({
        kind,
        text,
        sentences: groups.map((g) => ({ text: sentenceText(g, kind), rects: groupWordsIntoRects(g) })),
        rects: groupWordsIntoRects(bufferWords),
        section: currentSection,
        in_references: inReferences,
        page: bufferLines.length ? bufferLines[0].page : null,
      });
    }
    bufferWords = [];
    bufferLines = [];
  };

  for (const lines of pagesLines) {
    for (const line of lines) {
      const text = line.text.trim();
      if (!text) continue;

      if (COVER_NOISE.test(text)) continue;
      if (running.has(normalizeForRepetition(text))) continue;
      if (/^[[(]?\s*[\dIVXLCivxlc]{1,6}\s*[\])]?$/.test(text)) continue;

      if (line.size && line.size < bodySize - 1.0) {
        flush();
        const cleaned = cleanText(text);
        if (cleaned.length >= 40) {
          const rects = groupWordsIntoRects(line.words);
          blocks.push({
            kind: "footnote", text: cleaned, sentences: [{ text: cleaned, rects }], rects,
            section: currentSection, in_references: inReferences, page: line.page,
          });
        }
        continue;
      }

      if (isHeading(line, bodySize, maxX1)) {
        flush();
        const headingText = cleanText(text);
        currentSection = headingText;
        if (TAIL_HEADING.test(headingText)) inReferences = true;
        const rects = groupWordsIntoRects(line.words);
        blocks.push({
          kind: "heading", text: headingText, sentences: [{ text: headingText, rects }], rects,
          section: headingText, in_references: inReferences, page: line.page,
        });
        continue;
      }

      const words = stripFootnoteMarkers(line.words, bodySize);
      if (!words.length) continue;

      if (bufferLines.length) {
        const previous = bufferLines[bufferLines.length - 1];
        const endedSentence = /[.!?"']$/.test(previous.text.trimEnd());
        const shortLine = previous.x1 < (previous.col_x1 ?? maxX1) - 45;
        const columnChanged = previous.col !== line.col;
        const indented = !columnChanged && line.x0 > previous.x0 + 6;
        const pageChanged = line.page !== previous.page;
        if ((endedSentence && (shortLine || indented)) || (pageChanged && endedSentence)) flush();
      }

      bufferWords.push(...words);
      bufferLines.push(line);
    }
  }
  flush();
  return blocks;
}

// Words of one page in reading order, for the selectable text layer.
export function orderedPageWords(words, pageWidth, pageNumber) {
  const { ordered } = linesForPage(words, pageWidth, pageNumber);
  return ordered.flatMap((line) => line.words).map((w) => ({
    text: w.text, x0: w.x0, x1: w.x1, top: w.top, bottom: w.bottom,
  }));
}
