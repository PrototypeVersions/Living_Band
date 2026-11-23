import test from 'node:test';
import assert from 'node:assert/strict';
import { Groove } from '../js/groove.js';

// A stand-in band that just records what it was asked to play.
function mockBand() {
  const calls = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  return { calls, setChord: rec('chord'), bassNote: rec('bass'), kick: rec('kick'), snare: rec('snare'),
    hat: rec('hat'), shaker: rec('shaker'), swell: rec('swell'), setDrumLevel: rec('drumLevel') };
}
const C = (label, root, suffix = '') => ({ label, root, quality: { suffix, iv: suffix === 'm' ? [0, 3, 7] : [0, 4, 7] } });
const grid = { beat: 0.625, beatsPerBar: 4, chordBeats: [4, 4, 4, 4], cycleBeats: 16, anchor: 10,
  chords: [C('Em', 4, 'm'), C('C', 0), C('G', 7), C('D', 2)], confidence: 0.8 };

function run(g, from, to, opts) {
  for (let t = from; t < to; t += 0.03) g.schedule(t, { playing: false, density: 0, ...opts(t) });
}

test('plays chords on the downbeats, with drums, once locked', () => {
  const band = mockBand(), g = new Groove({}, band);
  g.setPersonality('deep');
  g.lock({ ...grid }, 10.1);
  run(g, 10.1, 20.1, () => ({ playing: true }));
  const chords = band.calls.filter((c) => c[0] === 'chord').map((c) => [c[1].label, +c[2].toFixed(3)]);
  assert.deepEqual(chords, [['C', 12.5], ['G', 15], ['D', 17.5], ['Em', 20]]);
  assert.ok(band.calls.some((c) => c[0] === 'kick' && Math.abs(c[1] - 12.5) < 1e-6));
  assert.ok(band.calls.some((c) => c[0] === 'snare'));
});

test('sends events early by the output latency so they are heard on the beat', () => {
  const band = mockBand(), g = new Groove({}, band);
  g.lock({ ...grid }, 10.1);
  run(g, 10.1, 13, () => ({ playing: true, outLatency: 0.04 }));
  const c = band.calls.find((x) => x[0] === 'chord');
  assert.ok(Math.abs(c[2] - 12.46) < 1e-6);
});

test('keeps your song going when you stop, then ends it on the first chord', () => {
  const band = mockBand(), g = new Groove({}, band);
  g.lock({ ...grid }, 10.1);
  run(g, 10.1, 12, () => ({ playing: true }));
  run(g, 12, 12 + 63 * 0.625, () => ({ playing: false }));
  assert.ok(g.locked, 'still playing after ~16 bars of silence');
  run(g, 12 + 63 * 0.625, 12 + 90 * 0.625, () => ({ playing: false }));
  assert.ok(!g.locked);
  assert.ok(g.justEnded);
  const last = band.calls.filter((c) => c[0] === 'chord').pop();
  assert.equal(last[1].label, 'Em');
});

test('a strummed chord that breaks the song triggers re-learning; a ringing one does not', () => {
  const band = mockBand(), g = new Groove({ }, band);
  g.lock({ ...grid }, 10.1);
  run(g, 10.1, 13, () => ({ playing: true }));
  const am = { ...C('Am', 9, 'm'), onsetAt: 13.0 };
  g.onChordChange({ ...am, onsetAt: 11 }, 13.2);          // stale: ringing, not strummed
  assert.equal(g.pendingMismatch, null);
  g.onChordChange(am, 13.2);
  assert.ok(g.pendingMismatch);
  assert.equal(g.checkMismatch(am, 13.3), false);          // not yet held long enough
  assert.equal(g.checkMismatch(am, 13.6), true);
  assert.equal(g.state, 'learning');
});
