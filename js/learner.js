// Living Band — learning your song: spotting a repeating chord progression and its timing.
// Pure logic (no audio), so it is unit-tested in Node.

/**
 * Chord "family" for comparing progressions: root plus major/minor feel. C, Cmaj7, Cadd9, Csus2
 * and C5 are the same place in a song; C and Cm are not.
 */
export function chordFamily(chord) {
  if (!chord) return null;
  const root = chord.root ?? chord.label;
  const suf = chord.quality ? chord.quality.suffix : (chord.label || '').replace(/^[A-G]#?/, '');
  if (suf === 'm' || suf === 'm7') return root + 'm';
  if (suf === 'dim') return root + 'dim';
  return root + '';
}

export const sameChord = (a, b) => !!a && !!b && chordFamily(a) === chordFamily(b);

/**
 * Collects chord changes and notices when a progression starts repeating.
 * A cycle of L chords is accepted once the whole cycle has been played and the next two chords
 * repeat its start (for 2-chord progressions: A B A B).
 */
export class ProgressionLearner {
  constructor({ minLen = 2, maxLen = 8 } = {}) {
    this.minLen = minLen;
    this.maxLen = maxLen;
    this.changes = []; // {chord, t}
  }

  reset() { this.changes = []; }

  add(chord, t) {
    const last = this.changes[this.changes.length - 1];
    if (last && sameChord(last.chord, chord)) return null;
    this.changes.push({ chord, t });
    if (this.changes.length > 40) this.changes.shift();
    return this.findCycle();
  }

  /** Returns {len, startIndex} where startIndex is the change that began the second pass. */
  findCycle() {
    const c = this.changes, n = c.length;
    for (let L = this.minLen; L <= this.maxLen; L++) {
      if (n < L + 2) continue;
      let ok = true;
      for (let j = 0; j < 2; j++) if (!sameChord(c[n - 1 - j].chord, c[n - 1 - j - L].chord)) ok = false;
      if (!ok) continue;
      const cycle = c.slice(n - 2 - L, n - 2);
      if (new Set(cycle.map((x) => chordFamily(x.chord))).size < 2) continue;
      // A cycle that is itself two copies of a shorter cycle would have matched at the shorter length.
      return { len: L, startIndex: n - 2 };
    }
    return null;
  }
}

/**
 * Works out the beat, chord lengths and downbeat from the learned pass.
 *   changes: [{chord, t}] — the first full pass plus the start of the second (length L + 2)
 *   onsets:  strum times seen during that span (used to find the beat inside each chord)
 * Returns { beat, beatsPerBar, chordBeats: [..], cycleBeats, anchor, chords: [..], confidence }
 * where anchor is the time of the second pass's first chord (a downbeat).
 */
export function estimateGrid(changes, onsets, { minBeat = 0.3, maxBeat = 1.1, preferBeat = 0.65 } = {}) {
  const L = changes.length - 2;
  const durs = [];
  for (let i = 0; i < L; i++) durs.push(changes[i + 1].t - changes[i].t);
  const firstAgain = changes[L + 1].t - changes[L].t; // pass-2 duration of the first chord
  // The very first change of a pass is the least reliable (you may have eased in, or we joined late),
  // so if the two passes disagree, trust the second.
  durs[0] = Math.abs(durs[0] - firstAgain) / firstAgain > 0.15 ? firstAgain : (durs[0] + firstAgain) / 2;
  const unit = Math.min(...durs);
  const t0 = changes[0].t, tEnd = changes[L + 1].t;
  const span = onsets.filter((o) => o >= t0 - 0.05 && o <= tEnd + 0.05);

  let best = null;
  for (let k = 1; k <= 16; k++) {
    const B = unit / k;
    if (B < minBeat || B > maxBeat) continue;
    // How well do chord lengths come out as whole numbers of beats?
    let durErr = 0;
    for (const d of durs) { const r = d / B; durErr += Math.abs(r - Math.round(r)); }
    durErr /= durs.length;
    // How many strums land on this beat grid, measured from the most recent chord change?
    let aligned = 0;
    for (const o of span) {
      let ref = changes[0].t;
      for (const ch of changes) if (ch.t <= o + 0.05) ref = ch.t;
      const f = ((o - ref) / B) % 1;
      if (Math.min(Math.abs(f), 1 - Math.abs(f)) < 0.15) aligned++;
    }
    const align = span.length ? aligned / span.length : 0.5;
    const prior = Math.abs(Math.log2(B / preferBeat));
    const score = align - durErr * 1.5 - prior * 0.25;
    if (!best || score > best.score) best = { B, score, align, durErr };
  }
  if (!best) return null;

  let chordBeats = durs.map((d) => Math.max(1, Math.round(d / best.B)));
  // Chord changes usually fall on bar lines. A change heard within one beat of a bar line is snapped
  // to it (4-5-4-3 → 4-4-4-4); deliberate short chords two or more beats from a bar line are kept.
  const total0 = chordBeats.reduce((a, b) => a + b, 0);
  const barGuess = chordBeats.every((b) => b % 3 === 0) && !chordBeats.every((b) => b % 4 === 0) ? 3 : 4;
  if (total0 % barGuess === 0) {
    let acc = 0;
    const bounds = chordBeats.map((b) => (acc += b));
    const snapped = bounds.map((x) => {
      const near = Math.round(x / barGuess) * barGuess;
      return Math.abs(near - x) === 1 ? near : x;
    });
    const lens = snapped.map((x, i) => x - (i ? snapped[i - 1] : 0));
    if (lens.every((b) => b >= 1)) chordBeats = lens;
  }
  const cycleBeats = chordBeats.reduce((a, b) => a + b, 0);
  // Refine the beat from the total length of the first pass.
  const passLen = durs.reduce((a, b) => a + b, 0);
  const beat = passLen / cycleBeats;
  let beatsPerBar = 4;
  if (chordBeats.every((b) => b % 3 === 0) && !chordBeats.every((b) => b % 4 === 0)) beatsPerBar = 3;
  return {
    beat, beatsPerBar, chordBeats, cycleBeats,
    anchor: changes[L].t,
    chords: changes.slice(0, L).map((c) => c.chord),
    confidence: Math.max(0, Math.min(1, best.align - best.durErr)),
  };
}

/** Which chord of the cycle sounds at `beatNum` beats after the anchor. */
export function chordIndexAtBeat(grid, beatNum) {
  let pos = ((Math.floor(beatNum) % grid.cycleBeats) + grid.cycleBeats) % grid.cycleBeats;
  for (let i = 0; i < grid.chordBeats.length; i++) {
    if (pos < grid.chordBeats[i]) return i;
    pos -= grid.chordBeats[i];
  }
  return 0;
}

/** Beat number (within the cycle) on which chord i starts. */
export function chordStartBeat(grid, i) {
  let s = 0;
  for (let k = 0; k < i; k++) s += grid.chordBeats[k];
  return s;
}
