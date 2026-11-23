// Living Band — "learn and lock": once your progression is learned, the band plays it on time,
// with drums and bass, follows your tempo, and re-learns when you change the song.
import { ProgressionLearner, estimateGrid, chordIndexAtBeat, sameChord } from './learner.js';
import { Band } from './band.js';

// How each personality plays once locked in. Per beat-in-bar arrays (4/4); 3/4 uses the first three.
export const GROOVES = {
  heavenly: { drums: 0.55, kick: [1, 0, 0.5, 0], snare: [0, 0, 1, 0], snareSoft: true, shaker8: 0.5, hat8: 0, bass: 'hold', swell: true },
  minimalist: { drums: 0.4, kick: [0.6, 0, 0, 0], snare: [0, 0, 0, 0], snareSoft: true, shaker8: 0, shaker4: 0.6, hat8: 0, bass: 'hold', swell: false },
  deep: { drums: 0.8, kick: [1, 0, 0.8, 0], kickAnd: [0, 0, 0, 0.5], snare: [0, 1, 0, 1], snareSoft: false, shaker8: 0, hat8: 0.7, bass: 'pulse', swell: true },
};

export class Groove {
  constructor(ctx, band, { onsetLatency = 0.03 } = {}) {
    this.ctx = ctx;
    this.band = band;
    this.learner = new ProgressionLearner();
    this.onsetLatency = onsetLatency; // how late our strum detection fires after the real strum
    this.onsets = [];                 // recent strum times (corrected)
    this.state = 'learning';          // learning | locked | ending
    this.grid = null;
    this.personality = 'heavenly';
    this.drumsOn = true;
    this.carryOnBeats = 64;           // how long to keep your song going after you stop
    this.scheduled = [];              // {t, label} chord changes actually scheduled (for display/tests)
    this.recentBeats = [];            // [{t, num}] scheduled beat times, for tempo following
    this.pendingMismatch = null;
  }

  note(t, msg) { (this.log ||= []).push({ t, msg }); if (this.log.length > 60) this.log.shift(); }

  setPersonality(key) { this.personality = GROOVES[key] ? key : 'heavenly'; this.applyDrumLevel(); }
  setDrums(on) { this.drumsOn = on; this.applyDrumLevel(); }
  applyDrumLevel() {
    const g = GROOVES[this.personality];
    this.band.setDrumLevel(this.state === 'locked' && this.drumsOn ? g.drums : 0);
  }

  get locked() { return this.state === 'locked' || this.state === 'ending'; }

  /** A strum was detected at time t (detector time). */
  onOnset(t, { lead = false } = {}) {
    const real = t - this.onsetLatency;
    this.onsets.push(real);
    while (this.onsets.length && this.onsets[0] < real - 60) this.onsets.shift();
    if (this.state !== 'locked' || lead) return;
    // Tempo following: nudge the grid toward strums that land near a beat.
    let nearest = null;
    for (const b of this.recentBeats) if (!nearest || Math.abs(b.t - real) < Math.abs(nearest.t - real)) nearest = b;
    if (!nearest) return;
    const err = real - nearest.t;
    if (Math.abs(err) > 0.18 * this.grid.beat) return;
    this.nextBeatTime += 0.35 * err;
    this.grid.beat = Math.min(this.grid.beat * 1.15, Math.max(this.grid.beat * 0.87, this.grid.beat + 0.06 * err));
  }

  /**
   * A chord change was confirmed by the tracker. chord.onsetAt = when the strum happened.
   * Returns 'locked' when this completes learning.
   */
  onChordChange(chord, now) {
    const at = (chord.onsetAt ?? now) - this.onsetLatency;
    if (this.state === 'learning') {
      const cyc = this.learner.add(chord, at);
      if (cyc) {
        const changes = this.learner.changes.slice(-(cyc.len + 2));
        const grid = estimateGrid(changes, this.onsets);
        this.note(now, 'changes: ' + changes.map((c) => `${c.chord.label}@${c.t.toFixed(2)}`).join(' '));
        this.note(now, grid ? `cycle of ${cyc.len}: ${Math.round(60 / grid.beat)} bpm, beats ${grid.chordBeats}, confidence ${grid.confidence.toFixed(2)}` : 'cycle found, no grid');
        if (grid && grid.confidence > 0.3) { this.lock(grid, now); return 'locked'; }
      }
      return null;
    }
    // Locked: only a freshly strummed chord can change the song (not a ringing chord's name flickering).
    if (chord.onsetAt === undefined || now - chord.onsetAt > 0.6) return null;
    // Is this what we expected? Allow for changing a little early or late.
    const ok = [-0.3, 0, 0.3].some((d) => sameChord(this.expectedAt(at + d * this.grid.beat), chord));
    if (ok) { this.pendingMismatch = null; return null; }
    if (chord.quality && chord.quality.iv.length === 2) return null; // power-chord readings from lead lines: ignore
    this.pendingMismatch = { chord, at, since: now, expected: this.expectedAt(at)?.label };
    return null;
  }

  /** Called every tick with the tracker's current chord, to confirm a real song change. */
  checkMismatch(current, now) {
    const m = this.pendingMismatch;
    if (!m || !this.locked) return false;
    if (!current || !sameChord(current, m.chord)) { this.pendingMismatch = null; return false; }
    if (now - m.since < 0.5 * this.grid.beat) return false;
    // You really are playing something new: keep the beat going, follow your chords, re-learn.
    this.note(now, `relearn: heard ${m.chord.label}, expected ${m.expected}`);
    this.relearn(m.chord, m.at);
    return true;
  }

  lock(grid, now) {
    this.grid = grid;
    this.state = 'locked';
    this.silentBeats = 0;
    // Beat numbers count from the anchor (a downbeat of the cycle). Start at the next beat from now.
    const k = Math.ceil((now + 0.05 - grid.anchor) / grid.beat);
    this.nextBeatNum = k;
    this.nextBeatTime = grid.anchor + k * grid.beat;
    this.lastChordIndex = chordIndexAtBeat(grid, k - 1);
    this.joinedAt = null;
    this.applyDrumLevel();
  }

  relearn(chord, at) {
    this.state = 'learning';
    this.grid = null;
    this.learner.reset();
    this.learner.add(chord, at);
    this.pendingMismatch = null;
    this.applyDrumLevel();
  }

  forget() {
    this.state = 'learning';
    this.grid = null;
    this.learner.reset();
    this.pendingMismatch = null;
    this.applyDrumLevel();
  }

  expectedAt(t) {
    if (!this.grid) return null;
    const beatNum = this.nextBeatNum + (t - this.nextBeatTime) / this.grid.beat;
    return this.grid.chords[chordIndexAtBeat(this.grid, Math.floor(beatNum + 1e-6))];
  }

  /**
   * Schedule everything due in the next `ahead` seconds. outLatency: the band is heard this much
   * after it is scheduled, so events go out early by that amount to land with your guitar.
   */
  schedule(now, { playing, density, outLatency = 0, ahead = 0.2 }) {
    if (!this.locked) return;
    const g = GROOVES[this.personality];
    const bpb = this.grid.beatsPerBar;
    while (this.nextBeatTime - outLatency < now + ahead) {
      const t = Math.max(now, this.nextBeatTime - outLatency);
      const num = this.nextBeatNum;
      const posInCycle = ((num % this.grid.cycleBeats) + this.grid.cycleBeats) % this.grid.cycleBeats;
      const ci = chordIndexAtBeat(this.grid, num);
      const chord = this.grid.chords[ci];
      // beat within the current chord's bars
      let startBeat = 0;
      for (let i = 0; i < ci; i++) startBeat += this.grid.chordBeats[i];
      const inBar = (posInCycle - startBeat) % bpb;
      const chordStart = posInCycle === startBeat;

      if (this.state === 'ending') {
        if (posInCycle === 0) { this.finish(t); return; }
      } else {
        if (!this.joinedAt && inBar === 0) {
          this.joinedAt = t;
          if (g.swell && this.drumsOn) this.band.swell(t, Math.min(1.5, this.grid.beat * 2));
        }
        if (chordStart || ci !== this.lastChordIndex) {
          this.band.setChord(chord, t, { bass: false });
          this.scheduled.push({ t: t + outLatency, label: chord.label });
          if (this.scheduled.length > 100) this.scheduled.shift();
          this.lastChordIndex = ci;
        }
        if (this.joinedAt) this.playBeat(g, t, inBar, bpb, chord, chordStart, density);
      }

      this.recentBeats.push({ t: this.nextBeatTime, num });
      if (this.recentBeats.length > 8) this.recentBeats.shift();
      this.silentBeats = playing ? 0 : this.silentBeats + 1;
      if (this.state === 'locked' && this.silentBeats >= this.carryOnBeats) this.state = 'ending';
      this.nextBeatNum++;
      this.nextBeatTime += this.grid.beat;
    }
  }

  playBeat(g, t, inBar, bpb, chord, chordStart, density) {
    const B = this.grid.beat, band = this.band;
    const i = bpb === 3 ? [0, 1, 2][inBar] : inBar;
    const busy = density > 3 ? 1.15 : 1; // a little more drive when you're playing busy
    if (this.drumsOn) {
      if (g.kick[i]) band.kick(t, g.kick[i]);
      if (g.kickAnd && g.kickAnd[i]) band.kick(t + B / 2, g.kickAnd[i]);
      const sn = bpb === 3 ? (inBar === 2 ? 1 : 0) * (g.snare.some(Boolean) ? 1 : 0) : g.snare[i];
      if (sn) band.snare(t, sn, g.snareSoft);
      if (g.hat8) { band.hat(t, g.hat8 * busy); band.hat(t + B / 2, g.hat8 * 0.6 * busy); }
      if (g.shaker8) { band.shaker(t, g.shaker8); band.shaker(t + B / 2, g.shaker8 * 0.7); }
      if (g.shaker4 && (inBar === 1 || inBar === 3)) band.shaker(t, g.shaker4);
    }
    const root = Band.bassMidiFor(chord.root);
    if (g.bass === 'hold') {
      if (chordStart) band.bassNote(root, t, 1, null);
    } else if (g.bass === 'pulse') {
      if (inBar === 0 || chordStart) band.bassNote(root, t, 1, B * 0.8);
      else if (inBar === 2) band.bassNote(root, t, 0.8, B * 0.8);
      else if (inBar === bpb - 1) band.bassNote(root + (Math.random() < 0.5 ? 7 : 12), t + B / 2, 0.6, B * 0.4);
    }
  }

  finish(t) {
    // End on the first chord of the cycle, let it ring, and stop the drums.
    const chord = this.grid.chords[0];
    this.band.setChord(chord, t, { bass: true });
    if (this.drumsOn) this.band.kick(t, 0.8);
    this.state = 'learning';
    this.grid = null;
    this.learner.reset();
    this.applyDrumLevel();
    this.justEnded = true;
  }

  status() {
    if (!this.locked) {
      const n = this.learner.changes.length;
      return { label: n ? `learning (${n} change${n === 1 ? '' : 's'} heard)` : 'learning', chords: [], pos: -1 };
    }
    const bpm = Math.round(60 / this.grid.beat);
    const pos = chordIndexAtBeat(this.grid, this.nextBeatNum - 1);
    return {
      label: (this.state === 'ending' ? 'finishing' : 'locked') + ` · ${bpm} bpm · ${this.grid.beatsPerBar}/4`,
      chords: this.grid.chords.map((c, i) => `${c.label}${this.grid.chordBeats[i] !== this.grid.beatsPerBar ? ` (${this.grid.chordBeats[i]})` : ''}`),
      pos, bpm,
    };
  }
}
