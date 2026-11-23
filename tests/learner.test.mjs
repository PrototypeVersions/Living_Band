import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressionLearner, estimateGrid, chordIndexAtBeat } from '../js/learner.js';

const ch = (label) => ({ label, root: label.replace(/m$/, ''), quality: { suffix: label.endsWith('m') ? 'm' : '' } });

/** Simulate playing `prog` (labels) with `beats` per chord at `bpm`, strumming every beat. */
function play(prog, beatsPer, bpm, passes, jitter = 0.012, seed = 3) {
  let s = seed; const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const B = 60 / bpm; const changes = [], onsets = [];
  let t = 1;
  for (let p = 0; p < passes; p++) {
    prog.forEach((label, i) => {
      const n = Array.isArray(beatsPer) ? beatsPer[i] : beatsPer;
      changes.push({ label, t: t + rand() * jitter * 2 });
      for (let b = 0; b < n; b++) onsets.push(t + b * B + rand() * jitter * 2);
      t += n * B;
    });
  }
  return { changes, onsets, B };
}

function learn(changes) {
  const L = new ProgressionLearner();
  for (const c of changes) { const r = L.add(ch(c.label), c.t); if (r) return { r, learner: L }; }
  return null;
}

test('locks onto a 4-chord progression at the second chord of the second pass', () => {
  const { changes } = play(['Em', 'C', 'G', 'D'], 4, 96, 2);
  const res = learn(changes);
  assert.ok(res);
  assert.equal(res.r.len, 4);
  assert.equal(res.learner.changes.length, 6);
});

test('does not mistake A B A C for a 2-chord loop', () => {
  const { changes } = play(['Am', 'F', 'Am', 'G'], 4, 100, 2);
  const res = learn(changes);
  assert.equal(res.r.len, 4);
});

test('locks a two-chord vamp', () => {
  const { changes } = play(['Dm', 'G'], 8, 110, 2);
  assert.equal(learn(changes).r.len, 2);
});

for (const [name, prog, beats, bpm] of [
  ['one bar per chord at 96 bpm', ['Em', 'C', 'G', 'D'], 4, 96],
  ['two bars per chord at 120 bpm', ['A', 'D'], 8, 120],
  ['mixed lengths at 84 bpm', ['C', 'Am', 'F', 'G'], [4, 4, 4, 2], 84],
  ['waltz at 140 bpm', ['G', 'C', 'D', 'C'], 3, 140],
]) {
  test(`estimates timing: ${name}`, () => {
    const { changes, onsets, B } = play(prog, beats, bpm, 2);
    const { learner } = learn(changes);
    const g = estimateGrid(learner.changes, onsets);
    const want = Array.isArray(beats) ? beats : prog.map(() => beats);
    assert.ok(Math.abs(g.beat - B) / B < 0.03, `beat ${g.beat.toFixed(3)} vs ${B.toFixed(3)}`);
    assert.deepEqual(g.chordBeats, want);
    if (beats === 3) assert.equal(g.beatsPerBar, 3);
    // Prediction: the chord at each downbeat of the next pass
    for (let i = 0; i < prog.length; i++) {
      const startBeat = want.slice(0, i).reduce((a, b) => a + b, 0);
      assert.equal(g.chords[chordIndexAtBeat(g, startBeat)].label, prog[i]);
    }
  });
}

test('trusts the second pass when the first chord of the first pass was cut short or stretched', () => {
  const { changes, onsets, B } = play(['Am', 'F', 'C', 'G'], 4, 104, 2);
  changes[0].t -= B; // we heard the first chord a beat "early" (e.g. joined mid-song)
  const { learner } = learn(changes);
  const g = estimateGrid(learner.changes, onsets);
  assert.deepEqual(g.chordBeats, [4, 4, 4, 4]);
  assert.ok(Math.abs(g.beat - B) / B < 0.03);
});

test('a chord change heard a beat late is snapped back to the bar line', () => {
  const { changes, onsets, B } = play(['Em', 'C', 'G', 'D'], 4, 96, 2);
  changes[2].t += B; // G heard one beat late in the first pass
  const { learner } = learn(changes);
  const g = estimateGrid(learner.changes, onsets);
  assert.deepEqual(g.chordBeats, [4, 4, 4, 4]);
});
