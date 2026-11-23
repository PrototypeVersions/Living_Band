# Living Band

An AI musical companion that listens to your guitar and plays along with *you*, instead of you playing along with a backing track.

**Prototype 0.1:** a responsive ambient companion. It listens, works out what chord you're on, and brings in a pad and then a bass that follow your harmony. It backs off when you play busy lead lines. When you stop, it carries on alone, holding your last chord and then cycling through the chords you just played, before it fades out.

## Try it

Open the GitHub Pages site in **Chrome or Edge**, press **Start audio**, and allow microphone access.

- **No guitar handy?** Press **Try the demo guitar**. It strums Em – C – G – D, then goes quiet so you can hear the band develop without you.
- **With your guitar:** keep monitoring your guitar through your amp or Tone Master Pro as normal (zero latency). Only the band comes from this page. Use headphones so the band isn't picked up by a mic.
  - Pick your interface under **Input → Device** and the right **Channel**. A clean or dry signal gives the most reliable chord detection.
  - The page reports how many channels the browser exposes. If a Tone Master Pro shows only 2, its dry channel 3 can't be reached from a browser. Use a clean preset on channels 1–2 for now (see *Roadmap*).
  - Adjust **Sensitivity** until the level meter crosses the gate only when you're actually playing.
- **Foot control:** any MIDI device that sends CC or Program Change can toggle the band, hold the current chord, or switch personality. Click **Learn**, then press the switch.

## How it works

```
guitar → [listen]  pitch spectrum (16k FFT) → note peaks → overtone suppression → chroma → chord templates + smoothing
                   small FFT → spectral flux → note attacks per second ("busyness")
       → [decide]  Conductor: engagement ramps in, bass waits until halfway, makes room for busy playing,
                   sustains → develops through your recent chords → rests when you stop
       → [play]    Web Audio: 4-voice detuned-saw pad with smooth voice leading, sine/triangle bass,
                   bell sparkles, convolution reverb
```

| File | Role |
|---|---|
| `js/dsp.js` | Pure listening maths: spectrum → notes → chord, chord tracker, onset detector, voice leading |
| `js/conductor.js` | Band personalities and the musical decisions |
| `js/band.js` | The synthesizers |
| `js/listener.js` | Audio input, channel selection, demo guitar |
| `js/midi.js` | MIDI foot control with learn |
| `js/main.js` | Wiring and display |

No build step and no dependencies. Run the tests with `node --test tests/`.

## Roadmap

1. **Responsive ambient companion** (this version). Next: tune it on real guitars and presets.
2. **Interactive rhythm section.** Phrase detection, tempo estimation, a band that gets more or less active as you play, then rhythm once it can find a steady pulse.
3. **Creative co-musician.** Call-and-response phrases, musical memory across sessions, adaptive arrangements, automatic recording and stem export.

If the browser can't see a multichannel interface's dry channel, or the latency feels too high for rhythm, the plan is to wrap the same engine in a small desktop app (Electron) or add a tiny audio-bridge helper. The music logic stays the same.
