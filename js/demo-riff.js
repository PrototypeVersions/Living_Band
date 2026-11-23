// Synthetic strummed-guitar recordings: the demo riff, and test material for the analysis.
import { midiToFreq } from './dsp.js';

export const VOICINGS = {
  Em: [40, 47, 52, 55, 59, 64], E: [40, 47, 52, 56, 59, 64], C: [48, 52, 55, 60, 64], G: [43, 47, 50, 55, 59, 67],
  D: [50, 57, 62, 66], Am: [45, 52, 57, 60, 64], A: [45, 52, 57, 61, 64], F: [41, 48, 53, 57, 60, 65],
  Dm: [50, 57, 62, 65], Bm: [47, 54, 59, 62, 66], E5: [40, 47, 52], A5: [45, 52, 57], G5: [43, 50, 55],
};

/**
 * bars: array of bars; each bar is a chord name or [chordA, chordB] for half-bar changes.
 * pattern: beat strums per bar (downs on each beat, plus up-strums on the off-beats of 2 and 4).
 */
export function strumRecording(bars, { bpm = 96, beatsPerBar = 4, sr = 44100, leadIn = 0.7, jitter = 0.015,
  drift = 0, noise = 0.003, seed = 11, upstrums = true, onePerBar = false } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const strums = []; // {t, notes, vel, up}
  let t = leadIn, beat = 60 / bpm;
  const truth = [];
  for (const bar of bars) {
    truth.push(t);
    for (let b = 0; b < (onePerBar ? 1 : beatsPerBar); b++) {
      const name = Array.isArray(bar) ? bar[b < beatsPerBar / 2 ? 0 : 1] : bar;
      const tb = t + b * beat + rand() * jitter * 2;
      strums.push({ t: tb, notes: VOICINGS[name], vel: b === 0 ? 1 : 0.75, up: false });
      if (upstrums && !onePerBar && (b === 1 || b === 3)) strums.push({ t: tb + beat / 2 + rand() * jitter, notes: VOICINGS[name], vel: 0.45, up: true });
    }
    t += beatsPerBar * beat;
    beat *= 1 + drift;
  }
  const len = Math.ceil((t + 1.5) * sr);
  const x = new Float32Array(len);
  strums.sort((a, b) => a.t - b.t);
  strums.forEach((st, k) => {
    const end = k + 1 < strums.length ? strums[k + 1].t : st.t + 4; // next strum damps these strings
    const notes = st.up ? [...st.notes].reverse().slice(0, 4) : st.notes;
    notes.forEach((m, i) => {
      const t0 = st.t + i * 0.011, f0 = midiToFreq(m) * (1 + rand() * 0.003);
      const a0 = 0.06 * st.vel * (0.8 + rand() * 0.4);
      const i0 = Math.floor(t0 * sr), i1 = Math.min(len, Math.floor((end + 0.03) * sr));
      for (let h = 1; h <= 10; h++) {
        const f = f0 * h * Math.sqrt(1 + 0.0001 * h * h), amp = a0 / Math.pow(h, 1.1) * (h === 1 ? 0.6 : 1);
        if (f > sr / 2.2) break;
        const w = 2 * Math.PI * f / sr, ph = rand() * 6;
        for (let n = i0; n < i1; n++) {
          const dt = (n - i0) / sr;
          const envl = Math.exp(-dt * (1.2 + h * 0.4)) * Math.min(1, dt * 400) * (n / sr > end ? Math.max(0, 1 - (n / sr - end) / 0.03) : 1);
          x[n] += amp * envl * Math.sin(w * (n - i0) + ph);
        }
      }
    });
  });
  for (let n = 0; n < len; n++) x[n] += rand() * noise * 2;
  return { x, sr, truth, strums: strums.filter((st) => !st.up).map((st) => st.t) };
}
