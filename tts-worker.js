// Piper text-to-speech in a background worker, so synthesis never freezes
// scrolling. Same pipeline as the Mac app: espeak-ng phonemes -> the Piper
// VITS model (via onnxruntime-web) -> 16-bit WAV.

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
// Multi-threading needs cross-origin isolation headers, which GitHub Pages
// can't send.
ort.env.wasm.numThreads = 1;

const PHONEMIZE_BASE = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/";
const CACHE_NAME = "paper-reader-voices-v1";

let createPiperPhonemize = null;
let phonemizer = null;
let loadedVoice = { id: null, session: null, config: null };

async function cachedFetch(url, onProgress) {
  const cache = self.caches ? await self.caches.open(CACHE_NAME) : null;
  const hit = cache && await cache.match(url);
  if (hit) return hit.arrayBuffer();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const blob = new Blob(chunks);
  if (cache) await cache.put(url, new Response(blob));
  return blob.arrayBuffer();
}

async function newPhonemizer() {
  if (!createPiperPhonemize) {
    // A classic Emscripten script (defines a global), not an ES module.
    const code = await (await fetch(`${PHONEMIZE_BASE}.js`)).text();
    createPiperPhonemize = new Function(`${code}\nreturn createPiperPhonemize;`)();
  }
  let output = null;
  const module = await createPiperPhonemize({
    print: (line) => {
      try { output = JSON.parse(line).phoneme_ids; } catch { /* not the result line */ }
    },
    printErr: () => {},
    locateFile: (file) => (file.endsWith(".wasm") ? `${PHONEMIZE_BASE}.wasm`
      : file.endsWith(".data") ? `${PHONEMIZE_BASE}.data` : file),
  });
  return {
    run(text, espeakVoice) {
      output = null;
      module.callMain(["-l", espeakVoice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
      return output;
    },
  };
}

async function phonemize(text, espeakVoice) {
  if (!phonemizer) phonemizer = await newPhonemizer();
  let ids = null;
  try { ids = phonemizer.run(text, espeakVoice); } catch { ids = null; }
  if (!ids) {
    // The module may not survive a second run; start a fresh one.
    phonemizer = await newPhonemizer();
    ids = phonemizer.run(text, espeakVoice);
  }
  if (!ids) throw new Error("Could not work out the pronunciation.");
  return ids;
}

async function loadVoice(voiceId, voicePath) {
  if (loadedVoice.id === voiceId) return loadedVoice;
  const report = (loaded, total) => postMessage({ type: "progress", voiceId, loaded, total });
  const config = JSON.parse(new TextDecoder().decode(await cachedFetch(`${VOICE_BASE}${voicePath}.onnx.json`)));
  const model = await cachedFetch(`${VOICE_BASE}${voicePath}.onnx`, report);
  if (loadedVoice.session) await loadedVoice.session.release();
  const session = await ort.InferenceSession.create(model);
  loadedVoice = { id: voiceId, session, config };
  return loadedVoice;
}

function encodeWav(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const writeStr = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return view.buffer;
}

async function synthesize({ text, voiceId, voicePath, speed }) {
  const { session, config } = await loadVoice(voiceId, voicePath);
  const ids = await phonemize(text, config.espeak.voice);
  // Same as the Mac app: speed replaces the voice's length scale.
  const lengthScale = 1 / Math.max(0.25, Math.min(Number(speed) || 1, 3));
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([
      config.inference.noise_scale, lengthScale, config.inference.noise_w,
    ]), [3]),
  };
  if (Object.keys(config.speaker_id_map || {}).length) {
    feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  }
  const { output } = await session.run(feeds);
  return encodeWav(output.data, config.audio.sample_rate);
}

// One synthesis at a time: a single model session isn't safe to run twice
// concurrently, and the playlist prefetches the next sentence.
let queue = Promise.resolve();

self.onmessage = (event) => {
  const { id, ...request } = event.data;
  queue = queue.then(async () => {
    try {
      const wav = await synthesize(request);
      postMessage({ id, wav }, [wav]);
    } catch (err) {
      postMessage({ id, error: String((err && err.message) || err) });
    }
  });
};
