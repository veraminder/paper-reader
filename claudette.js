// Claudette: Gemini calls made straight from the browser with the user's
// own key. Mirrors main.py's _gemini_json / _gemini_text /
// _gemini_chat_with_notes, using the exact same prompts (prompts.js).

import {
  PROMPTS, SUMMARY_SCHEMA, MAX_CONTEXT_CHARS,
  CHAT_HISTORY_MESSAGES, CHAT_HISTORY_CHARS, GEMINI_MODEL,
} from "./prompts.js";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const NO_KEY = { error: "No Gemini API key set. Add one in Settings to use Claudette." };

const ADD_NOTE_TOOL = {
  functionDeclarations: [{
    name: "add_note",
    description:
      "Add one note to the user's reading notes. Call this only when "
      + "the user explicitly asks to note, save, add or remember "
      + "something -- never for an ordinary question. Condense the "
      + "source into note form without simplifying it; follow the "
      + "note-writing rules in your instructions.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The note: a condensed version of the source that "
            + "keeps its wording, key terms and logic. For a "
            + "definition, exactly 'term: definition'. Plain text, "
            + "no markdown.",
        },
      },
      required: ["text"],
    },
  }],
};

// Single pass, function replacer: paper text can contain "$&" etc., which
// a string replacement would misinterpret.
function fill(template, values) {
  return template.replace(/<<(PAPER|TEXT|CONTEXT|QUESTION|CONVERSATION)>>/g, (_, k) => values[k] ?? "");
}

export function paperContext(blocks) {
  return blocks
    .filter((b) => (b.kind === "text" || b.kind === "heading") && !b.in_references)
    .map((b) => b.text)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

// Strip markdown/bullet/quote wrapping a model sometimes adds anyway -- the
// notes panel renders plain text, so '* ...' would show literally.
export function cleanNote(text) {
  let t = (text || "").trim();
  t = t.replace(/^\s*(?:[-*•]\s+)+/, "");
  t = t.replaceAll("*", "");
  const closeQ = { '"': '"', "“": "”" }[t.slice(0, 1)];
  if (closeQ && t.length > 1 && t.endsWith(closeQ)) {
    const inner = t.slice(1, -1);
    if (!inner.includes(t[0]) && !inner.includes(closeQ)) t = inner.trim();
  }
  return t;
}

async function generate(apiKey, prompt, extra = {}) {
  if (!apiKey) return NO_KEY;
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], ...extra }),
    });
  } catch {
    return { error: "Claudette could not respond: no internet connection." };
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || data.error) {
    const message = (data.error && data.error.message) || `HTTP ${response.status}`;
    return { error: `Claudette could not respond: ${message}` };
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts) || [];
  return { parts };
}

const partsText = (parts) => parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("").trim();

export async function summarizePaper(apiKey, blocks) {
  const result = await generate(apiKey, fill(PROMPTS.summary, { PAPER: paperContext(blocks) }), {
    generationConfig: { responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA },
  });
  if (result.error) return result;
  try {
    return JSON.parse(partsText(result.parts));
  } catch {
    return { error: "Claudette could not respond: the summary came back malformed." };
  }
}

export async function selectionNote(apiKey, kind, text, blocks) {
  const context = paperContext(blocks);
  const key = context ? kind : `${kind}_nocontext`;
  const result = await generate(apiKey, fill(PROMPTS[key], { TEXT: text, CONTEXT: context }));
  if (result.error) return result;
  return { text: cleanNote(partsText(result.parts)) };
}

export async function explainSelection(apiKey, text, blocks) {
  const context = paperContext(blocks);
  const result = await generate(apiKey, fill(PROMPTS[context ? "explain" : "explain_nocontext"], { TEXT: text, CONTEXT: context }));
  if (result.error) return result;
  return { text: partsText(result.parts) };
}

function formatHistory(history) {
  return history.slice(-CHAT_HISTORY_MESSAGES)
    .map((m) => [m.role === "assistant" ? "Claudette" : "User", String(m.text || "").trim()])
    .filter(([, text]) => text)
    .map(([who, text]) => `${who}: ${text.slice(0, CHAT_HISTORY_CHARS)}`)
    .join("\n\n");
}

export async function askClaudette(apiKey, question, history, blocks) {
  const conversation = formatHistory(history || []);
  const prompt = fill(conversation ? PROMPTS.chat_history : PROMPTS.chat, {
    QUESTION: question, CONTEXT: paperContext(blocks), CONVERSATION: conversation,
  });
  const result = await generate(apiKey, prompt, { tools: [ADD_NOTE_TOOL] });
  if (result.error) return result;
  const call = result.parts.find((p) => p.functionCall && p.functionCall.name === "add_note");
  if (call) {
    const note = cleanNote((call.functionCall.args || {}).text || "");
    return { text: "Added to your notes.", note: note || null };
  }
  return { text: partsText(result.parts), note: null };
}
