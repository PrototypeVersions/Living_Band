// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpectrum, matchChord, ChordTracker, voiceLead, midiToFreq } from '../js/dsp.js';
import { Conductor } from '../js/conductor.js';

const SR = 48000, N = Number(process.env.FFT_N || 16384);

function fftMag(x) {
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2];
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
      }
    }
  }
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}

/** A crude plucked-guitar chord: harmonic-rich notes with a little detune and noise, Hann-windowed. */
function guitarChord(midis, { seed = 1, noise = 0.002 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const x = new Float32Array(N);
  for (const m of midis) {
    const f0 = midiToFreq(m) * (1 + (rand() - 0.5) * 0.004);
    const amp = 0.7 + rand() * 0.6;
    for (let h = 1; h <= 12; h++) {
      const a = amp * (h === 1 ? 0.6 : 1) / Math.pow(h, 1.2), ph = rand() * 6.28;
      const f = f0 * h * Math.sqrt(1 + 0.00008 * h * h); // slight string inharmonicity
      for (let i = 0; i < N; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / SR + ph);
    }
  }
  for (let i = 0; i < N; i++) x[i] = (x[i] * 0.05 + (rand() - 0.5) * noise) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  return fftMag(x);
}

const CASES = [
  ['E minor (open)', [40, 47, 52, 55, 59, 64], 'Em'],
  ['E major (open)', [40, 47, 52, 56, 59, 64], 'E'],
  ['C major (open)', [48, 52, 55, 60, 64], 'C'],
  ['G major (open)', [43, 47, 50, 55, 59, 67], 'G'],
  ['D major (open)', [50, 57, 62, 66], 'D'],
  ['A minor (open)', [45, 52, 57, 60, 64], 'Am'],
  ['A major (open)', [45, 52, 57, 61, 64], 'A'],
  ['F major (barre)', [41, 48, 53, 57, 60, 65], 'F'],
  ['B minor (barre)', [47, 54, 59, 62, 66], 'Bm'],
  ['A7 (open)', [45, 52, 55, 61, 64], 'A7'],
  ['Cmaj7 (open)', [48, 52, 55, 59, 64], 'Cmaj7'],
  ['Dsus2 (open)', [50, 57, 62, 64], 'Dsus2'],
  ['E5 power chord', [40, 47, 52], 'E5'],
  ['A5 power chord', [45, 52, 57], 'A5'],
];

for (const [name, midis, expected] of CASES) {
  test(`recognises ${name}`, () => {
    const frame = analyzeSpectrum(guitarChord(midis), SR, N);
    const best = matchChord(frame.chroma, frame.bassPc);
    assert.equal(best.label, expected, `heard ${best.label} (score ${best.score.toFixed(3)})`);
  });
}

test('finds the bass note of an open E chord', () => {
  const frame = analyzeSpectrum(guitarChord([40, 47, 52, 56, 59, 64]), SR, N);
  assert.equal(frame.bassMidi, 40);
});

test('silence produces no notes', () => {
  const frame = analyzeSpectrum(new Float32Array(N / 2), SR, N);
  assert.equal(frame.notes.length, 0);
});

test('tracker waits a few frames before changing chord, then changes', () => {
  const tr = new ChordTracker();
  const em = analyzeSpectrum(guitarChord([40, 47, 52, 55, 59, 64]), SR, N);
  const c = analyzeSpectrum(guitarChord([48, 52, 55, 60, 64]), SR, N);
  for (let i = 0; i < 10; i++) tr.update(em, true, i * 0.03);
  assert.equal(tr.current.label, 'Em');
  tr.update(c, true, 0.4);
  assert.equal(tr.current.label, 'Em', 'should not jump on one frame');
  for (let i = 0; i < 80; i++) tr.update(c, true, 0.43 + i * 0.03);
  assert.equal(tr.current.label, 'C');
});

test('voice leading moves voices only a little', () => {
  const em = voiceLead([52, 55, 59, 64], [4, 7, 11]);
  const c = voiceLead(em, [0, 4, 7]);
  const moved = c.reduce((s, m, i) => s + Math.abs(m - em[i]), 0);
  assert.ok(moved <= 4, `moved ${moved} semitones: ${em} -> ${c}`);
  assert.deepEqual([...new Set(c.map((m) => m % 12))].sort(), [0, 4, 7]);
});

test('conductor comes in, makes room for busy playing, then develops and rests in silence', () => {
  const cd = new Conductor('heavenly');
  const em = { label: 'Em', root: 4, pcs: [4, 7, 11] }, c = { label: 'C', root: 0, pcs: [0, 4, 7] };
  let t = 0, out;
  for (; t < 10; t += 0.03) out = cd.update({ now: t, playing: true, chord: t < 5 ? em : c, density: 1 });
  assert.equal(out.mode, 'following');
  assert.ok(out.pad > 0.4, 'pad should be in after 10 s');
  assert.ok(out.bass > 0, 'bass should have entered');
  const calmPad = out.pad;
  for (let i = 0; i < 10; i++, t += 0.03) out = cd.update({ now: t, playing: true, chord: c, density: 5 });
  assert.equal(out.mode, 'making room');
  assert.ok(out.pad < calmPad * 0.6);
  const seen = new Set();
  for (const end = t + 40; t < end; t += 0.03) { out = cd.update({ now: t, playing: false, chord: c }); seen.add(out.mode + ':' + out.chord.label); }
  assert.ok(seen.has('developing:Em'), 'band should revisit Em while developing: ' + [...seen]);
  for (const end = t + 30; t < end; t += 0.03) out = cd.update({ now: t, playing: false, chord: c });
  assert.equal(out.mode, 'resting');
});
