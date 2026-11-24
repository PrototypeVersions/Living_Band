import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange, detectKey, bridgeProgression, makeChord, STYLES } from '../js/arranger.js';

const bar = (...names) => ({ chords: names.map((n) => {
  const m = n.match(/^([A-G]#?)(m?)$/); const root = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].indexOf(m[1]);
  return { chord: makeChord(root, m[2]), beats: 4 / names.length };
}) });
const analysis = (bars, extra = {}) => ({ bpm: 96, beatsPerBar: 4, progression: bars,
  riff: { beatTimes: Array.from({ length: bars.length * 4 + 1 }, (_, i) => 1 + i * 0.625) }, ...extra });

test('finds the key of common progressions', () => {
  const k1 = detectKey([bar('Em'), bar('C'), bar('G'), bar('D')]);
  assert.ok(['4minor', '7major'].includes(k1.tonic + k1.mode), `${k1.tonic} ${k1.mode}`);
  const k2 = detectKey([bar('C'), bar('G'), bar('Am'), bar('F')]);
  assert.equal(k2.tonic + k2.mode, '0major');
  const k3 = detectKey([bar('Am'), bar('F'), bar('C'), bar('G')]);
  assert.ok(['9minor', '0major'].includes(k3.tonic + k3.mode));
});

test('bridge chords are in the key and as long as the loop', () => {
  const br = bridgeProgression({ tonic: 0, mode: 'major', scale: [0, 2, 4, 5, 7, 9, 11] }, 4, 4);
  assert.deepEqual(br.map((b) => b.chords[0].chord.label), ['F', 'G', 'Am', 'G']);
  assert.equal(bridgeProgression({ tonic: 9, mode: 'minor', scale: [9, 11, 0, 2, 4, 5, 7] }, 8, 4).length, 8);
});

for (const style of Object.keys(STYLES)) {
  test(`arranges a full song in ${style} style`, () => {
    const song = arrange(analysis([bar('Em'), bar('C'), bar('G'), bar('D')]), { style, length: 'full' });
    const names = song.sections.map((s) => s.name);
    assert.deepEqual(names, ['Intro', 'Verse', 'Build', 'Chorus', 'Verse 2', 'Breakdown', 'Bridge', 'Chorus', 'Outro']);
    const secs = song.lengthBeats * 60 / song.bpm;
    assert.ok(secs > 140 && secs < 260, `${secs.toFixed(0)} s`);
    const inSec = (name, track) => { const s = song.sections.find((x) => x.name === name);
      return song.events.filter((e) => e.track === track && e.beat >= s.startBeat && e.beat < s.startBeat + s.beats); };
    assert.equal(inSec('Intro', 'drums').filter((e) => !e.fill).length, 0, 'intro has no groove, only a lead-in fill');
    assert.ok(inSec('Chorus', 'drums').length > 20, 'chorus has drums');
    assert.ok(inSec('Intro', 'riff').length > 0, 'your riff opens the song');
    assert.equal(inSec('Bridge', 'riff').length, 0, 'riff sits out the bridge (different chords)');
    assert.ok(inSec('Chorus', 'bass').length > 0);
    // pad follows the chords: the chorus's first pad notes belong to Em
    const firstPad = inSec('Chorus', 'pad').filter((e) => e.beat === song.sections[3].startBeat).map((e) => e.midi % 12);
    assert.ok(firstPad.every((pc) => [4, 7, 11, 2].includes(pc)), String(firstPad));
    // nothing scheduled past the end
    assert.ok(song.events.every((e) => e.beat <= song.lengthBeats));
  });
}

test('riff slices line up with the loop', () => {
  const song = arrange(analysis([bar('Am'), bar('F'), bar('C'), bar('G')]), { length: 'short' });
  const verse = song.sections[1];
  const slices = song.events.filter((e) => e.track === 'riff' && e.beat >= verse.startBeat && e.beat < verse.startBeat + 16).map((e) => e.slice);
  assert.deepEqual(slices, Array.from({ length: 16 }, (_, i) => i));
});

test('two-bar loops get more repeats; eight-bar loops fewer', () => {
  const two = arrange(analysis([bar('A'), bar('D')]), { length: 'short' });
  const eight = arrange(analysis([bar('C'), bar('G'), bar('Am'), bar('F'), bar('C'), bar('G'), bar('F'), bar('C')]), { length: 'short' });
  assert.equal(two.sections[1].loops, 4);
  assert.equal(eight.sections[1].loops, 1);
});

test('without your recording, there are no riff slices and the intro gets keys and bass', () => {
  const song = arrange({ ...analysis([bar('Em'), bar('C'), bar('G'), bar('D')]), riff: null }, { style: 'heavenly', length: 'full' });
  assert.equal(song.events.filter((e) => e.track === 'riff').length, 0);
  const intro = song.sections[0];
  const inIntro = (track) => song.events.filter((e) => e.track === track && e.beat < intro.beats).length;
  assert.ok(inIntro('keys') > 0 && inIntro('bass') > 0);
});
