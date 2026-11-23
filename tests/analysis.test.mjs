import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRiff, chordFamily } from '../js/analysis.js';
import { strumRecording } from '../js/demo-riff.js';

const fam = (label) => label; // labels in expectations are already plain
const progLabels = (res) => res.progression.map((bar) => bar.chords.map((c) => c.chord.label).join('|'));
const famLabels = (res) => res.progression.map((bar) => bar.chords.map((c) => {
  const f = chordFamily(c.chord), names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const root = parseInt(f, 10);
  return names[root] + (f.endsWith('m') ? 'm' : '');
}).join('|'));

const CASES = [
  { name: 'Em C G D, one bar each, 96 bpm, twice', bars: ['Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D'], opts: { bpm: 96 },
    want: ['Em', 'C', 'G', 'D'], loop: 4 },
  { name: 'A D, two bars each, 120 bpm, twice', bars: ['A', 'A', 'D', 'D', 'A', 'A', 'D', 'D'], opts: { bpm: 120 },
    want: ['A', 'A', 'D', 'D'], loop: 4 },
  { name: 'Am F C G at 84 bpm, three times, sloppy timing', bars: Array(3).fill(['Am', 'F', 'C', 'G']).flat(), opts: { bpm: 84, jitter: 0.03 },
    want: ['Am', 'F', 'C', 'G'], loop: 4 },
  { name: 'half-bar changes C G | Am F at 100 bpm', bars: [['C', 'G'], ['Am', 'F'], ['C', 'G'], ['Am', 'F'], ['C', 'G'], ['Am', 'F']], opts: { bpm: 100 },
    want: ['C|G', 'Am|F'], loop: 2 },
  { name: 'waltz G C D C at 132 bpm', bars: ['G', 'C', 'D', 'C', 'G', 'C', 'D', 'C'], opts: { bpm: 132, beatsPerBar: 3, upstrums: false },
    want: ['G', 'C', 'D', 'C'], loop: 4, bpb: 3 },
  { name: 'power chords E5 G5 A5 A5 at 140 bpm, slowing down slightly', bars: Array(2).fill(['E5', 'G5', 'A5', 'A5']).flat(), opts: { bpm: 140, drift: 0.008 }, expectBpm: 140 / Math.pow(1.008, 5.5),
    want: ['E', 'G', 'A', 'A'], loop: 4 },
];

for (const c of CASES) {
  test(`analyses: ${c.name}`, () => {
    const { x, sr } = strumRecording(c.bars, c.opts);
    const res = analyzeRiff(x, sr);
    assert.ok(!res.error, res.error);
    const bpm = c.expectBpm || c.opts.bpm; // the tempo of the take we reuse
    assert.ok(Math.abs(res.bpm - bpm) / bpm < 0.04, `bpm ${res.bpm.toFixed(1)} vs ${bpm}`);
    assert.equal(res.beatsPerBar, c.bpb || 4, `beats per bar`);
    assert.equal(res.loopBars, c.loop, `loop of ${res.loopBars}: ${progLabels(res)}`);
    assert.deepEqual(famLabels(res), c.want, `heard ${progLabels(res)}`);
    assert.ok(res.riff, 'riff take found');
  });
}

test('silence is reported, not analysed', () => {
  const res = analyzeRiff(new Float32Array(44100 * 3), 44100);
  assert.ok(res.error);
});

test('one ringing strum per bar still gives the right chords and loop (tempo may be a multiple)', () => {
  const bars = ['Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D'];
  const { x, sr } = strumRecording(bars, { bpm: 80, onePerBar: true });
  const res = analyzeRiff(x, sr);
  assert.ok(!res.error, res.error);
  assert.deepEqual(famLabels(res).slice(0, 4), ['Em', 'C', 'G', 'D'].slice(0, res.loopBars), progLabels(res));
  const ratios = [0.5, 1, 2, 4].map((k) => Math.abs(res.bpm / (80 * k) - 1));
  assert.ok(Math.min(...ratios) < 0.05, `bpm ${res.bpm.toFixed(1)}`);
});

test('a progression played only once is taken whole', () => {
  const { x, sr } = strumRecording(['Am', 'F', 'C', 'G'], { bpm: 100 });
  const res = analyzeRiff(x, sr);
  assert.ok(!res.error, res.error);
  assert.deepEqual(famLabels(res), ['Am', 'F', 'C', 'G']);
});
