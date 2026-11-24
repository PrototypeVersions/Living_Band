# Living Band

**Play a few chords. Get a whole song to jam over.**

Record a chord progression on your guitar, and Living Band turns it into a complete arranged backing track, with drums, bass, keys and pads, built around *your own playing*. Then improvise over it, loop sections, and export it.

## How it works

1. **Play.** Hit record and play your progression two or three times round at a steady tempo. (Or try the demo riff.)
2. **Check.** It works out the tempo, time signature, key, the chord in each bar (including half-bar changes) and how long your loop is. Tap any chord to fix it; use ½ / ×2 if the tempo is off by a factor of two. *Hear my riff on the beat* plays your take back on a click.
3. **Vibe.** Pick a style (**Heavenly**, **Drive**, **Lo-fi**, **Ballad**) and a length.
4. **Jam.** You get a full song: intro → verse → build → chorus → verse 2 → breakdown → bridge (new chords in your key) → chorus → outro. The band plays without your recording by default, so you can play live over it. Switch on **Include my recorded riff** to add your take as the rhythm guitar (cut into single beats and re-laid on the grid). The page shows the current and next chord and suggests scales to solo with. Loop any section, adjust the mix, and download the song or separate parts (stems) for REAPER or GarageBand.

Everything runs in the browser (Chrome or Edge). No account, no upload.

## Under the hood

| File | Role |
|---|---|
| `js/analysis.js` | Offline riff analysis: onset envelope → tempo (autocorrelation) → beat tracking (dynamic programming) → per-beat chroma → bar lines and chords (tries 4/4 and 3/4 at every offset; splits half-bar changes) → loop length → strum-aligned cut points for your take |
| `js/dsp.js` | Pitch peaks, overtone suppression, chord templates, voice leading |
| `js/arranger.js` | Key detection, bridge progression, song structure and energy curve, every part per style (drums, fills, bass lines, piano/Rhodes voicings, pads, your riff) |
| `js/engine.js` | Sampled instruments (re-pitched, crossfaded sustain for pads), your riff's beat slices, reverb and bus compression, live player with section looping, offline rendering and WAV export |
| `js/recorder.js` | Input device and channel selection, level meter, AudioWorklet capture |
| `js/demo-riff.js` | Synthetic strummed guitar for the demo and the tests |
| `js/app.js` | The four-step interface |

Tests: `npm test` (riff analysis on synthetic recordings at different tempos, chord lengths, half-bar changes, waltz time, tempo drift, sparse strumming; key detection; arrangement structure).

Instrument samples: see `assets/samples/CREDITS.md`.

## Ideas for next

- An AI arranger (Claude) for richer song structures and chord substitutions, with your own API key
- AI-generated textures (Lyria RealTime / Magenta RealTime 2) locked to the song's key and tempo
- More styles and drum kits; humanised timing; count-in and click while recording
- Desktop helper for multichannel interfaces (e.g. the Tone Master Pro's dry channel)

The earlier live "follow me" prototype is in the git history (commit `f1cf7bd`).
