// Living Band — pure listening functions (no Web Audio here, so they run in Node tests too).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/**
 * Turn one magnitude spectrum into pitch information.
 * mags: linear magnitudes, length fftSize/2.
 * Returns pitch-class energy (chroma), the strongest notes, and the lowest strong note (bass).
 */
export function analyzeSpectrum(mags, sampleRate, fftSize, opts = {}) {
  const { minHz = 70, maxHz = 2500, relDb = 40, absFloor = 1e-5 } = opts;
  const binHz = sampleRate / fftSize;
  const lo = Math.max(2, Math.floor(minHz / binHz));
  const hi = Math.min(mags.length - 2, Math.ceil(maxHz / binHz));
  const chroma = new Float32Array(12);

  let max = 0;
  for (let i = lo; i <= hi; i++) if (mags[i] > max) max = mags[i];
  if (max < absFloor) return { chroma, notes: [], bassPc: -1, bassMidi: -1, peak: max };

  const thresh = max * Math.pow(10, -relDb / 20);
  const peaks = [];
  for (let i = lo; i <= hi; i++) {
    const m = mags[i];
    if (m < thresh || m < mags[i - 1] || m <= mags[i + 1]) continue;
    // Parabolic interpolation on log magnitude for a sub-bin frequency estimate.
    const a = Math.log(mags[i - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mags[i + 1] + 1e-12);
    const den = a - 2 * b + c;
    const p = den !== 0 ? 0.5 * (a - c) / den : 0;
    const f = (i + p) * binHz;
    const amp = Math.exp(b - 0.25 * (a - c) * p);
    const midiF = freqToMidi(f);
    const midi = Math.round(midiF);
    if (Math.abs(midiF - midi) > 0.35) continue; // out of tune / noise
    peaks.push({ f, amp, midi, w: 1 });
  }

  // Overtone suppression: a peak sitting at an integer multiple (x3, x5, x6, x7) of a lower peak is
  // probably an overtone, so it counts for less. Octaves (x2, x4, x8) keep the same note name and are harmless.
  for (let j = 0; j < peaks.length; j++) {
    for (let i = 0; i < j; i++) {
      const r = peaks[j].f / peaks[i].f;
      const k = Math.round(r);
      if (k >= 3 && k <= 7 && k !== 4 && Math.abs(r - k) / k < 0.025) { peaks[j].w = 0.3; break; }
    }
  }

  const noteW = new Map();
  for (const pk of peaks) {
    const w = Math.sqrt(pk.amp) * pk.w;
    chroma[((pk.midi % 12) + 12) % 12] += w;
    noteW.set(pk.midi, (noteW.get(pk.midi) || 0) + w);
  }

  let bassMidi = -1;
  for (const pk of peaks) {
    if (pk.w === 1 && pk.amp >= 0.2 * max) { bassMidi = pk.midi; break; }
  }
  const notes = [...noteW.entries()].map(([midi, weight]) => ({ midi, weight }))
    .sort((x, y) => y.weight - x.weight).slice(0, 6);

  return { chroma, notes, bassPc: bassMidi >= 0 ? bassMidi % 12 : -1, bassMidi, peak: max };
}

export const QUALITIES = [
  { suffix: '', iv: [0, 4, 7], prior: 1.0 },
  { suffix: 'm', iv: [0, 3, 7], prior: 1.0 },
  { suffix: '5', iv: [0, 7], prior: 0.97 },
  { suffix: '7', iv: [0, 4, 7, 10], prior: 0.965 },
  { suffix: 'maj7', iv: [0, 4, 7, 11], prior: 0.965 },
  { suffix: 'm7', iv: [0, 3, 7, 10], prior: 0.965 },
  { suffix: 'sus2', iv: [0, 2, 7], prior: 0.95 },
  { suffix: 'sus4', iv: [0, 5, 7], prior: 0.95 },
  { suffix: 'add9', iv: [0, 2, 4, 7], prior: 0.95 },
  { suffix: 'dim', iv: [0, 3, 6], prior: 0.93 },
];

export function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s);
  const out = new Float32Array(v.length);
  if (s > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

export function scoreChord(chromaN, root, quality, bassPc = -1) {
  let dot = 0;
  for (const iv of quality.iv) dot += chromaN[(root + iv) % 12];
  let score = (dot / Math.sqrt(quality.iv.length)) * quality.prior;
  if (bassPc === root) score += 0.05;
  return score;
}

export const chordLabel = (root, quality) => NOTE_NAMES[root] + quality.suffix;

/** Best chord template for a chroma vector. Returns {root, quality, label, score, pcs}. */
export function matchChord(chroma, bassPc = -1) {
  const n = normalize(chroma);
  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const score = scoreChord(n, root, q, bassPc);
      if (!best || score > best.score) best = { root, quality: q, score };
    }
  }
  best.label = chordLabel(best.root, best.quality);
  best.pcs = best.quality.iv.map((iv) => (best.root + iv) % 12);
  return best;
}

/**
 * Spectrum of what is *new* since `before`: energy that rose. Old chords and reverb tails, which are
 * fading, drop out, leaving mostly the notes just struck.
 */
export function newEnergy(now, before, keep = 1.2) {
  const out = new Float32Array(now.length);
  for (let i = 0; i < now.length; i++) {
    const d = now[i] - keep * before[i];
    out[i] = d > 0 ? d : 0;
  }
  return out;
}

/**
 * Follows the chord being played.
 * Two paths: a fast one right after a strum (looks only at newly struck notes), and a slow smoothed
 * one for everything else (picks up gradual changes, single notes added over time, etc.).
 */
export class ChordTracker {
  constructor({ alpha = 0.4, holdFrames = 10, switchMargin = 0.05, minScore = 0.8, settleSec = 1.2,
    strikeWindow = [0.06, 0.45], freshFrames = 2, strikeMargin = 0.08 } = {}) {
    Object.assign(this, { alpha, holdFrames, switchMargin, minScore, settleSec, strikeWindow, freshFrames, strikeMargin });
    this.smooth = new Float32Array(12);
    this.current = null;
    this.candidate = null;
    this.candidateCount = 0;
    this.changedAt = 0;
    this.strikeAt = null;
  }

  /** Call on every detected note attack (strum or pick). */
  strike(now) {
    this.strikeAt = now;
    this.lastStrike = now;
    this.freshCand = null;
    this.freshCount = 0;
  }

  /**
   * frame: analysis of the full spectrum; fresh: analysis of newEnergy() since just before the
   * last strike (or null). Returns the current chord (or null).
   */
  update(frame, playing, now = 0, fresh = null) {
    if (!playing) {
      for (let i = 0; i < 12; i++) this.smooth[i] *= 0.9;
      this.candidate = null; this.candidateCount = 0; this.strikeAt = null;
      return this.current;
    }
    const n = normalize(frame.chroma);

    // ---- Fast path: just after a strike, judge from the newly struck notes.
    const since = this.strikeAt === null ? Infinity : now - this.strikeAt;
    if (fresh && since >= this.strikeWindow[0] && since <= this.strikeWindow[1]) {
      const fn = normalize(fresh.chroma);
      const mix = new Float32Array(12);
      for (let i = 0; i < 12; i++) mix[i] = n[i] + 0.5 * fn[i];
      const bass = frame.bassPc >= 0 ? frame.bassPc : fresh.bassPc;
      const fb = matchChord(mix, bass);
      // Re-strumming the same chord: if the current chord still explains the new notes nearly as well,
      // keep it. Only switch when the new chord is clearly better.
      if (this.current && fb.label !== this.current.label &&
          fb.score < scoreChord(normalize(mix), this.current.root, this.current.quality, bass) + this.strikeMargin) {
        this.strikeAt = null;
        return this.current;
      }
      if (fb.score >= this.minScore) {
        if (this.freshCand && this.freshCand.label === fb.label) this.freshCount++;
        else { this.freshCand = fb; this.freshCount = 1; }
        // Two-note "power chord" readings need more evidence: a half-heard strum often looks like one.
        const need = fb.quality.iv.length === 2 ? this.freshFrames + 2 : this.freshFrames;
        if (this.freshCount >= need) {
          if (!this.current || this.current.label !== fb.label) {
            this.current = fb; this.changedAt = now;
            (this.log ||= []).push({ now, path: 'fast', label: fb.label, mix: [...mix].map((x) => +x.toFixed(2)) });
          }
          else this.current.score = fb.score;
          this.smooth = normalize(mix);
          this.strikeAt = null; this.candidate = null; this.candidateCount = 0;
          return this.current;
        }
      }
    } else if (since > this.strikeWindow[1]) {
      this.strikeAt = null;
    }

    // ---- Slow path: smoothed chroma with hysteresis.
    for (let i = 0; i < 12; i++) this.smooth[i] = this.alpha * n[i] + (1 - this.alpha) * this.smooth[i];
    const best = matchChord(this.smooth, frame.bassPc);
    this.lastBest = best;
    if (best.score < this.minScore) { this.candidate = null; this.candidateCount = 0; return this.current; }

    if (this.current && best.label === this.current.label) {
      this.current.score = best.score;
      this.candidate = null; this.candidateCount = 0;
      return this.current;
    }
    const curScore = this.current
      ? scoreChord(normalize(this.smooth), this.current.root, this.current.quality, frame.bassPc) : -1;
    if (best.score < curScore + this.switchMargin) { this.candidate = null; this.candidateCount = 0; return this.current; }

    // Strums are the fast path's job. The slow path only handles changes with no clear strum
    // (arpeggios, swells, volume-knob fades), and lets ring-out fade after any change.
    if (this.current && (now - this.changedAt < this.settleSec || now - (this.lastStrike ?? -Infinity) < this.settleSec)) { this.candidate = null; this.candidateCount = 0; return this.current; }
    if (this.candidate && this.candidate.label === best.label) this.candidateCount++;
    else { this.candidate = best; this.candidateCount = 1; }
    if (this.candidateCount >= this.holdFrames) {
      this.current = best; this.changedAt = now;
      (this.log ||= []).push({ now, path: 'slow', label: best.label, mix: [...this.smooth].map((x) => +x.toFixed(2)) });
      if (this.log.length > 100) this.log.shift();
      this.candidate = null; this.candidateCount = 0;
    }
    return this.current;
  }
}

/** Note-attack detector using spectral flux on a small FFT. Tracks how busy the playing is. */
export class OnsetDetector {
  constructor({ minGapSec = 0.08, window = 3 } = {}) {
    this.prev = null;
    this.avg = 0;
    this.minGap = minGapSec;
    this.window = window;
    this.lastOnset = -1;
    this.onsets = [];
  }

  update(mags, now, gateOpen) {
    let flux = 0;
    if (this.prev) {
      for (let i = 2; i < mags.length; i++) {
        const d = Math.sqrt(mags[i]) - Math.sqrt(this.prev[i]);
        if (d > 0) flux += d;
      }
    }
    if (!this.prev || this.prev.length !== mags.length) this.prev = new Float32Array(mags.length);
    this.prev.set(mags);
    const isOnset = gateOpen && flux > this.avg * 1.8 + 1e-3 && now - this.lastOnset > this.minGap;
    this.avg = 0.9 * this.avg + 0.1 * flux;
    if (isOnset) { this.lastOnset = now; this.onsets.push(now); }
    while (this.onsets.length && this.onsets[0] < now - this.window) this.onsets.shift();
    return isOnset;
  }

  /** Note attacks per second over the recent window. */
  density() { return this.onsets.length / this.window; }
}

/**
 * Choose pad pitches for the given pitch classes, moving each voice as little as possible
 * from where it was (smooth voice leading). Returns MIDI notes, one per voice.
 */
export function voiceLead(prev, pcs, lo = 50, hi = 76) {
  const nVoices = prev.length;
  // Every way to fill the voices: all chord tones once, extra voices double any chord tone.
  const base = pcs.slice(0, nVoices); // drop extensions past the voice count
  const targetSets = [];
  const extend = (arr, from) => {
    if (arr.length === nVoices) { targetSets.push(arr); return; }
    for (let i = from; i < pcs.length; i++) extend([...arr, pcs[i]], i);
  };
  extend(base, 0);
  const nearest = (from, pc) => {
    let best = null;
    for (let m = lo; m <= hi; m++) {
      if (m % 12 !== pc) continue;
      if (best === null || Math.abs(m - from) < Math.abs(best - from)) best = m;
    }
    return best;
  };
  let bestCost = Infinity, bestAssign = null;
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      const notes = arr.map((pc, v) => nearest(prev[v], pc));
      let cost = 0;
      for (let v = 0; v < notes.length; v++) cost += Math.abs(notes[v] - prev[v]);
      // avoid two voices on the same note
      if (new Set(notes).size < notes.length) cost += 6;
      if (cost < bestCost) { bestCost = cost; bestAssign = notes; }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  for (const targets of targetSets) perm(targets);
  return bestAssign;
}
