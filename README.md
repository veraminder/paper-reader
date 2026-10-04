# Paper Reader (web)

Reads academic PDFs aloud sentence by sentence — headings announced, footnotes
and references kept out of the way — with **Claudette**, an optional AI helper
for summaries, citations, comments and explanations.

It runs entirely in your browser: works on iPad, Mac, Windows, Android and
Chromebook. Open the page, enter your name, choose a PDF.

## Your data stays in your browser

Notes, folders, the PDFs they belong to, your name and your Gemini key are
stored in the browser on your own device (IndexedDB). Nothing is uploaded to
this site or to GitHub. Use **Library → Back up** to save everything as a file,
and **Restore** to load it on another device. The **i** button in the library
explains where data lives on each device and how it could be lost.

On an iPad, add the page to your Home Screen (Share → Add to Home Screen) and
always open it from there — Safari otherwise deletes a website's data after 7
days without a visit.

## Claudette (optional)

Claudette uses Google's free Gemini API with your own key (create one at
aistudio.google.com/apikey and paste it into Settings). When you use her, the
paper's text is sent to Google.

## Voices

Speech uses [Piper](https://github.com/rhasspy/piper) voices, run in the
browser with onnxruntime-web. Each voice downloads once (about 60 MB) from the
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) collection
the first time it's used, then stays cached.

## Built with

[pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
[onnxruntime-web](https://onnxruntime.ai/) (MIT),
[piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm)
phonemizer (espeak-ng, GPL-3.0), all loaded from public CDNs; Piper voice
models under their own licences (see each voice's model card).

## Running it locally

Any static file server works, e.g. `python3 -m http.server` in this folder,
then open http://localhost:8000.
