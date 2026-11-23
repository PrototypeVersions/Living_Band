// Living Band — understanding a recorded riff: beats, tempo, bar lines, chords and loop length.
// Pure functions on a Float32Array, so they run in the browser and in Node tests alike.
import { analyzeSpectrum, matchChord, normalize, QUALITIES, scoreChord, chordLabel } from './dsp.js';

// ---------- FFT (radix-2, real input → magnitudes) ----------
const fftCache = new Map();
function fftSetup(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const rev = new Uint32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    rev[i] = j;
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j |= bit;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const s = { rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, s);
  return s;
}

/** Hann-windowed magnitude spectrum of x[start .. start+n), written into out (length n/2). */
export function magSpectrum(x, start, n, out) {
  const { rev, cos, sin, win, re, im } = fftSetup(n);
  for (let i = 0; i < n; i++) {
    const k = start + i;
    re[rev[i]] = (k >= 0 && k < x.length ? x[k] : 0) * win[i];
    im[rev[i]] = 0;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}

// ---------- Onsets and beats ----------

/** Spectral-flux onset strength, one value per hop. */
export function onsetEnvelope(x, sr, { n = 1024, hop = 256 } = {}) {
  const frames = Math.max(0, Math.floor((x.length - n) / hop) + 1);
  const env = new Float32Array(frames);
  let prev = new Float32Array(n / 2), cur = new Float32Array(n / 2);
  for (let f = 0; f < frames; f++) {
    magSpectrum(x, f * hop, n, cur);
    let flux = 0;
    for (let i = 1; i < n / 2; i++) {
      const a = Math.log1p(1000 * cur[i]), b = Math.log1p(1000 * prev[i]);
      if (a > b) flux += a - b;
    }
    env[f] = f === 0 ? 0 : flux;
    [prev, cur] = [cur, prev];
  }
  // Remove the slowly varying part and scale to unit spread.
  const w = Math.round(0.5 * sr / hop), out = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += env[f];
    if (f >= w) acc -= env[f - w];
    out[f] = Math.max(0, env[f] - acc / Math.min(f + 1, w));
  }
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / Math.max(1, frames)) || 1;
  for (let f = 0; f < frames; f++) out[f] /= sd;
  return { env: out, hopSec: hop / sr };
}

/** Beat period (in envelope frames) from autocorrelation, with a mild preference for ~110 bpm. */
export function estimatePeriod(env, hopSec, { minBpm = 55, maxBpm = 190, preferBpm = 105 } = {}) {
  const minLag = Math.floor(60 / maxBpm / hopSec), maxLag = Math.ceil(60 / minBpm / hopSec);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (env.length - lag);
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / preferBpm) / 0.9, 2));
    // A true beat also shows up at twice its period; this favours the real beat over a half-beat.
    const twice = 2 * lag <= maxLag + 1 ? ac[2 * lag] : ac[lag];
    const score = (ac[lag] + 0.5 * twice) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0) best = Math.round(60 / preferBpm / hopSec);
  const a = ac[best - 1], b = ac[best], c = ac[best + 1], den = a - 2 * b + c;
  return best + (den ? 0.5 * (a - c) / den : 0);
}

/** Dynamic-programming beat tracker (Ellis 2007): beats that follow onsets yet keep a steady pulse. */
export function trackBeats(env, period, { tightness = 120 } = {}) {
  const n = env.length, score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const r = Math.log((t - p) / period);
      const s = score[p] - tightness * r * r;
      if (arg < 0 || s > best) { best = s; arg = p; }
    }
    score[t] = env[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // End on the best-scoring frame within the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  return beats.reverse();
}

// ---------- Chords ----------

/** Average magnitude spectrum over [t0, t1) seconds, using long frames for pitch detail. */
function avgSpectrum(x, sr, t0, t1, n) {
  const out = new Float32Array(n / 2), tmp = new Float32Array(n / 2);
  const hop = n / 4;
  // Skip the first slice of each beat: the pick/strum attack is noisy and smears pitch.
  const s0 = Math.round((t0 + Math.min(0.06, (t1 - t0) * 0.2)) * sr) - n / 2, s1 = Math.round(t1 * sr) - n / 2;
  let count = 0;
  for (let s = s0; s <= Math.max(s0, s1); s += hop) {
    magSpectrum(x, s, n, tmp);
    for (let i = 0; i < out.length; i++) out[i] += tmp[i];
    count++;
  }
  for (let i = 0; i < out.length; i++) out[i] /= count;
  return out;
}

function bestChords(chroma, bassPc, k = 3) {
  const nrm = normalize(chroma), all = [];
  for (let root = 0; root < 12; root++) for (const q of QUALITIES) all.push({ root, quality: q, score: scoreChord(nrm, root, q, bassPc) });
  all.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of all) {
    c.label = chordLabel(c.root, c.quality);
    c.pcs = c.quality.iv.map((iv) => (c.root + iv) % 12);
    out.push(c);
    if (out.length >= k) break;
  }
  return out;
}

export function chordFamily(chord) {
  if (!chord) return null;
  const s = chord.quality.suffix;
  return chord.root + (s === 'm' || s === 'm7' ? 'm' : s === 'dim' ? 'd' : '');
}

const addChroma = (a, b) => { const o = new Float32Array(12); for (let i = 0; i < 12; i++) o[i] = a[i] + b[i]; return o; };

/** Group beats into bars at a given offset and pick a chord (or two, for half-bar changes) per bar. */
export function segmentBars(beatInfo, bpb, offset) {
  const bars = [];
  let total = 0;
  for (let i = offset; i + bpb <= beatInfo.length; i += bpb) {
    const span = beatInfo.slice(i, i + bpb);
    if (span.every((b) => b.silent)) { bars.push(null); continue; }
    const whole = span.reduce((acc, b) => addChroma(acc, b.chroma), new Float32Array(12));
    const bass = span[0].bassPc;
    const one = bestChords(whole, bass);
    let bar = { beat: i, chords: [{ chord: one[0], beats: bpb, alts: one }], score: one[0].score };
    if (bpb === 4) {
      const h1 = addChroma(span[0].chroma, span[1].chroma), h2 = addChroma(span[2].chroma, span[3].chroma);
      const c1 = bestChords(h1, span[0].bassPc), c2 = bestChords(h2, span[2].bassPc);
      const split = (c1[0].score + c2[0].score) / 2;
      // Two triads in one bar can add up to a plausible 7th chord (C + G ≈ Cmaj7). So also ask: does the
      // whole-bar chord actually fit each half? If a half is clearly something else, split the bar.
      const fit1 = scoreChord(normalize(h1), one[0].root, one[0].quality, span[0].bassPc);
      const fit2 = scoreChord(normalize(h2), one[0].root, one[0].quality, span[2].bassPc);
      const halvesDisagree = c1[0].score - fit1 > 0.08 && c2[0].score - fit2 > 0.08;
      const cleanHalves = c1[0].score > 0.9 && c2[0].score > 0.9 && split > one[0].score + 0.015;
      if (chordFamily(c1[0]) !== chordFamily(c2[0]) && (split > one[0].score + 0.06 || halvesDisagree || cleanHalves)) {
        bar = { beat: i, chords: [{ chord: c1[0], beats: 2, alts: c1 }, { chord: c2[0], beats: 2, alts: c2 }], score: split };
      }
    }
    bars.push(bar);
    total += bar.score;
  }
  const real = bars.filter(Boolean);
  return { bars, mean: real.length ? total / real.length : 0 };
}

const barKey = (bar) => (bar ? bar.chords.map((c) => chordFamily(c.chord)).join('|') : '-');

/** Shortest number of bars after which the chord sequence repeats. */
export function findLoop(keys) {
  const n = keys.length;
  for (let P = 1; P <= Math.min(8, Math.floor(n / 2)); P++) {
    let match = 0, total = 0;
    for (let i = 0; i + P < n; i++) { total++; if (keys[i] === keys[i + P]) match++; }
    if (total && match / total >= 0.8 && new Set(keys.slice(0, P)).size >= (P > 1 ? 2 : 1)) return P;
  }
  return Math.min(n, 8);
}

/**
 * Where the strum near time t actually starts. The beat tracker lands near the loudest point of a strum,
 * but a strum takes 30–60 ms to cross the strings; to cut your riff cleanly we want its very first attack.
 * Looks at fine (1.5 ms) energy steps in [t − 90 ms, t + 30 ms] and returns the earliest strong rise.
 */
export function attackStart(x, sr, t) {
  // Full-band energy in 12 ms windows (about one cycle of the low E string) every 1 ms.
  const win = Math.round(sr * 0.012), hop = Math.max(8, Math.round(sr * 0.001));
  const s0 = Math.round((t - 0.1) * sr), s1 = Math.round((t + 0.03) * sr);
  if (s0 < win + 25 * hop || s1 + win >= x.length) return null;
  const e = [];
  for (let s = s0 - 25 * hop; s <= s1; s += hop) {
    let v = 0;
    for (let i = s; i < s + win; i++) v += x[i] * x[i];
    e.push({ s, v: Math.log(v / win + 1e-12) });
  }
  const rise = [];
  for (let k = 25; k < e.length; k++) {
    let base = Infinity;
    for (let j = k - 25; j <= k - 12; j++) base = Math.min(base, e[j].v);
    rise.push({ s: e[k].s + win, r: e[k].v - base });
  }
  let max = 0;
  for (const p of rise) max = Math.max(max, p.r);
  if (max < 0.7) return null; // no clear attack here
  // The window registers an attack as soon as it enters, so the first clear rise marks the window's end.
  return rise.find((p) => p.r > max * 0.4).s / sr;
}

/**
 * The whole analysis.
 * Returns { bpm, beatsPerBar, beats, bars, loopBars, passes, progression, riff } or { error }.
 */
export function analyzeRiff(x, sr, opts = {}) {
  const { pitchN = 8192 } = opts;
  // Where is there actually sound?
  const rmsHop = Math.round(sr * 0.05);
  let peak = 0;
  const rms = [];
  for (let s = 0; s + rmsHop <= x.length; s += rmsHop) {
    let e = 0;
    for (let i = s; i < s + rmsHop; i++) e += x[i] * x[i];
    rms.push(Math.sqrt(e / rmsHop));
    peak = Math.max(peak, rms[rms.length - 1]);
  }
  if (peak < 1e-4) return { error: 'The recording is silent. Check the input and channel.' };
  const soundAt = (t) => (rms[Math.min(rms.length - 1, Math.floor(t / 0.05))] || 0) > peak * 0.03;

  const { env, hopSec } = onsetEnvelope(x, sr);
  let period = estimatePeriod(env, hopSec);
  // Sparse playing (one strum per bar or two, left to ring): the gap between strums is a bar or a
  // half bar, not a beat. Split it into beats near a comfortable tempo.
  const peaks = [];
  const wPk = Math.round(0.15 / hopSec);
  for (let f = 1; f + 1 < env.length; f++) {
    if (env[f] <= 1.5) continue;
    let isMax = true; // the strongest point of its strum (a strum's strings make a cluster of peaks)
    for (let g = Math.max(0, f - wPk); g <= Math.min(env.length - 1, f + wPk); g++) if (env[g] > env[f]) { isMax = false; break; }
    if (isMax && (!peaks.length || f - peaks[peaks.length - 1] > wPk)) peaks.push(f);
  }
  const iois = [];
  for (let i = 1; i < peaks.length; i++) iois.push((peaks[i] - peaks[i - 1]) * hopSec);
  iois.sort((a, b) => a - b);
  const medIoi = iois.length ? iois[iois.length >> 1] : 0;
  if (medIoi > 1.2) {
    let bestK = 4, bestErr = Infinity;
    for (const k of [2, 3, 4, 6, 8]) {
      const b = medIoi / k;
      if (b < 0.33 || b > 1.1) continue;
      const err = Math.abs(Math.log2(b / 0.65)) - (k === 4 || k === 8 ? 0.15 : 0);
      if (err < bestErr) { bestErr = err; bestK = k; }
    }
    period = medIoi / bestK / hopSec;
  }
  const beatFrames = trackBeats(env, period);
  let beats = beatFrames.map((f) => f * hopSec + 0.012); // centre of the analysis frame ≈ the attack
  // Keep beats from the first one with sound to the last one with sound (plus one, to close the bar).
  const first = beats.findIndex((t) => soundAt(t) || soundAt(t + 0.05));
  let last = beats.length - 1;
  while (last > first && !soundAt(beats[last] - 0.1)) last--;
  beats = beats.slice(Math.max(0, first), Math.min(beats.length, last + 2));
  if (beats.length < 5) return { error: 'Too short to find a beat. Play the idea at least twice round.' };

  const beatInfo = [];
  for (let i = 0; i + 1 < beats.length; i++) {
    const mags = avgSpectrum(x, sr, beats[i], beats[i + 1], pitchN);
    const a = analyzeSpectrum(mags, sr, pitchN);
    // Accent: strongest onset near the beat (players lean on the first beat of a bar).
    const f0 = Math.round(beats[i] / hopSec);
    let acc = 0;
    for (let f = f0 - 3; f <= f0 + 3; f++) if (f >= 0 && f < env.length) acc = Math.max(acc, env[f]);
    beatInfo.push({ t: beats[i], chroma: normalize(a.chroma), bassPc: a.bassPc, silent: !soundAt(beats[i] + 0.05), accent: acc });
  }
  const meanAccent = beatInfo.reduce((a, b) => a + b.accent, 0) / beatInfo.length || 1;
  const firstSounding = beatInfo.findIndex((b) => !b.silent);

  // Bar lines: try 4/4 and 3/4 at every offset; the right one gives the cleanest chords per bar.
  let best = null;
  for (const bpb of [4, 3]) {
    for (let off = 0; off < bpb; off++) {
      const seg = segmentBars(beatInfo, bpb, off);
      // Tie-breakers when chords alone can't tell (e.g. half-bar changes): downbeats are accented,
      // and people usually start a riff on beat 1. Slight preference for 4/4.
      let accent = 0, nb = 0;
      for (let i = off; i < beatInfo.length; i += bpb) { accent += beatInfo[i].accent; nb++; }
      accent = nb ? accent / nb / meanAccent : 1;
      const startsOnOne = ((firstSounding - off) % bpb + bpb) % bpb === 0;
      const score = seg.mean + 0.04 * Math.min(1, accent - 1) + (startsOnOne ? 0.02 : 0) - (bpb === 3 ? 0.03 : 0);
      if (opts.debug) opts.debug.push({ bpb, off, mean: +seg.mean.toFixed(3), accent: +accent.toFixed(2), startsOnOne, score: +score.toFixed(3), bars: seg.bars.map((b) => b && b.chords.map((c) => c.chord.label).join('|')).join(' ') });
      if (!best || score > best.score) best = { bpb, off, ...seg, score };
    }
  }
  const bars = best.bars;
  while (bars.length && !bars[bars.length - 1]) bars.pop();
  const keys = bars.map(barKey);
  const loopBars = findLoop(keys);
  const passes = Math.floor(bars.length / loopBars);

  // The progression: for each bar of the loop, vote across passes.
  const progressionBars = [];
  for (let b = 0; b < loopBars; b++) {
    const votes = new Map();
    for (let p = 0; p * loopBars + b < bars.length; p++) {
      const bar = bars[p * loopBars + b];
      if (!bar) continue;
      const k = barKey(bar);
      const v = votes.get(k) || { n: 0, bar };
      v.n += bar.score;
      votes.set(k, v);
    }
    const winner = [...votes.values()].sort((a, c) => c.n - a.n)[0];
    progressionBars.push(winner ? winner.bar : bars[b]);
  }

  // The take to reuse as your rhythm guitar: the second pass if there is one (the first is often a warm-up).
  const pass = passes >= 2 ? 1 : 0;
  const startBeat = best.off + pass * loopBars * best.bpb;
  // Cut points for reusing your riff: the beat tracker sits a little after each strum's start, by about the
  // same amount every time for a given player. Measure that gap across the take and shift every cut by it,
  // so the whole riff lines up evenly with the band (one consistent offset beats per-beat guesses).
  const takeBeats = beats.slice(startBeat, startBeat + loopBars * best.bpb + 1);
  const gaps = takeBeats.map((t) => { const a0 = attackStart(x, sr, t); return a0 === null ? null : a0 - t; }).filter((g) => g !== null).sort((a, b) => a - b);
  const offset = gaps.length >= 3 ? Math.max(-0.08, Math.min(0.01, gaps[gaps.length >> 1])) : 0;
  const riffBeats = takeBeats.map((t) => t + offset);
  const intervals = [];
  for (let i = 1; i < riffBeats.length; i++) intervals.push(riffBeats[i] - riffBeats[i - 1]);
  const beatSec = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : period * hopSec;

  return {
    bpm: 60 / beatSec,
    beatsPerBar: best.bpb,
    beats,
    bars,
    loopBars,
    passes,
    progression: progressionBars.map((bar) => ({ chords: bar.chords.map((c) => ({ chord: c.chord, beats: c.beats, alts: c.alts })) })),
    riff: riffBeats.length === loopBars * best.bpb + 1 ? { beatTimes: riffBeats } : null,
    confidence: best.mean,
  };
}
