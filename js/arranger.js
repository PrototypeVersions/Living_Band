// Living Band — turning your progression into a song: structure, energy, and every instrument's part.
// Pure logic. Times are in beats; the player converts to seconds.
import { voiceLead, NOTE_NAMES, QUALITIES } from './dsp.js';

// ---------- Styles ----------
export const STYLES = {
  heavenly: {
    name: 'Heavenly', blurb: 'Spacious and shimmering: strings and warm pads, soft half-time drums, sparkling electric piano.',
    kit: 'acoustic-kit', keys: 'epiano', pad: ['pad', 'strings'], swing: 0, keysOctave: 12, levels: { keys: 1.3 },
  },
  drive: {
    name: 'Drive', blurb: 'Rock band: driving 8th-note bass, backbeat drums, piano chords. Big choruses.',
    kit: 'acoustic-kit', keys: 'piano', pad: ['strings'], swing: 0, keysOctave: 0, levels: { drums: 0.65, bass: 0.7, keys: 1.2, pad: 1.4 },
  },
  lofi: {
    name: 'Lo-fi', blurb: 'Laid-back swung beat, jazzy electric piano 7ths, round bass.',
    kit: 'breakbeat8', keys: 'epiano', pad: ['pad'], swing: 0.16, keysOctave: 0,
  },
  ballad: {
    name: 'Ballad', blurb: 'Flowing piano arpeggios, strings, gentle drums that open up in the chorus.',
    kit: 'acoustic-kit', keys: 'piano', pad: ['strings'], swing: 0, keysOctave: 0, levels: { drums: 0.85, bass: 0.85, keys: 1.9, pad: 1.4 },
  },
};

// ---------- Harmony helpers ----------
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const q = (suffix) => QUALITIES.find((x) => x.suffix === suffix);
export const makeChord = (root, suffix = '') => {
  const quality = q(suffix);
  return { root, quality, label: NOTE_NAMES[root] + suffix, pcs: quality.iv.map((iv) => (root + iv) % 12) };
};

/** Most likely key from the chords (weighted by how long each is played). */
export function detectKey(progression) {
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const scale = (mode === 'major' ? MAJOR : MINOR).map((iv) => (tonic + iv) % 12);
      let s = 0, total = 0;
      progression.forEach((bar, bi) => bar.chords.forEach((c) => {
        const w = c.beats * (bi === 0 ? 1.5 : 1); // the first chord is often home
        total += w;
        const inScale = c.chord.pcs.filter((pc) => scale.includes(pc)).length / c.chord.pcs.length;
        s += w * inScale;
        if (c.chord.root === tonic) s += w * 0.35 * ((mode === 'minor') === isMinor(c.chord) ? 1 : 0.3);
      }));
      const score = s / total;
      if (!best || score > best.score) best = { tonic, mode, score, scale };
    }
  }
  return best;
}
const isMinor = (ch) => ch.quality.suffix === 'm' || ch.quality.suffix === 'm7';

function degreeChord(key, degree) { // degree 1..7, diatonic triad
  const sc = key.mode === 'major' ? MAJOR : MINOR;
  const root = (key.tonic + sc[degree - 1]) % 12;
  const third = (sc[(degree + 1) % 7] - sc[degree - 1] + 12) % 12;
  const fifth = (sc[(degree + 3) % 7] - sc[degree - 1] + 12) % 12;
  return makeChord(root, third === 3 ? (fifth === 6 ? 'dim' : 'm') : '');
}

/** A contrasting progression for the bridge, in the song's key, the same number of bars as your loop. */
export function bridgeProgression(key, loopBars, bpb) {
  const degrees = key.mode === 'major' ? [4, 5, 6, 5] : [4, 6, 7, 5];
  const chords = degrees.map((d) => degreeChord(key, d));
  if (key.mode === 'minor') chords[3] = makeChord((key.tonic + 7) % 12, ''); // major V pulls home
  const bars = [];
  const per = Math.max(1, Math.round(loopBars / 4));
  for (let i = 0; bars.length < Math.max(loopBars, 2); i++) {
    for (let k = 0; k < per && bars.length < Math.max(loopBars, 2); k++) bars.push({ chords: [{ chord: chords[i % 4], beats: bpb }] });
  }
  return bars;
}

/** Add a colour tone (7th or 9th from the key) for jazzier styles. */
function colourTones(chord, key) {
  const scale = key.scale;
  const pcs = [...chord.pcs];
  const seventh = scale.find((pc) => ((pc - chord.root + 12) % 12 === 10 || (pc - chord.root + 12) % 12 === 11));
  if (seventh !== undefined && !pcs.includes(seventh)) pcs.push(seventh);
  return pcs;
}

// ---------- Structure ----------
const TEMPLATES = {
  short: [
    { name: 'Intro', loops: 1, energy: 0.25, prog: 'main', riff: true },
    { name: 'Verse', loops: 2, energy: 0.55, prog: 'main', riff: true },
    { name: 'Chorus', loops: 2, energy: 1.0, prog: 'main', riff: true },
    { name: 'Outro', loops: 1, energy: 0.35, prog: 'main', riff: true, ending: true },
  ],
  full: [
    { name: 'Intro', loops: 1, energy: 0.25, prog: 'main', riff: true },
    { name: 'Verse', loops: 2, energy: 0.5, prog: 'main', riff: true },
    { name: 'Build', loops: 1, energy: 0.7, prog: 'main', riff: true, build: true },
    { name: 'Chorus', loops: 2, energy: 1.0, prog: 'main', riff: true },
    { name: 'Verse 2', loops: 2, energy: 0.6, prog: 'main', riff: true },
    { name: 'Breakdown', loops: 1, energy: 0.2, prog: 'main', riff: true },
    { name: 'Bridge', loops: 2, energy: 0.65, prog: 'bridge', riff: false, build: true },
    { name: 'Chorus', loops: 3, energy: 1.0, prog: 'main', riff: true },
    { name: 'Outro', loops: 1, energy: 0.35, prog: 'main', riff: true, ending: true },
  ],
};

/**
 * analysis: output of analyzeRiff (or an edited copy). Returns a song:
 * { bpm, beatsPerBar, style, key, sections: [{name, startBeat, beats, energy, ...}], events, lengthBeats }
 */
export function arrange(analysis, { style = 'heavenly', length = 'full', seed = 1, bpm } = {}) {
  const st = STYLES[style] || STYLES.heavenly;
  const bpb = analysis.beatsPerBar;
  const main = analysis.progression;
  const loopBars = main.length;
  const key = detectKey(main);
  const bridge = bridgeProgression(key, loopBars, bpb);
  // Long loops (8 bars) need fewer repeats to make a song of reasonable length.
  const scale = loopBars >= 8 ? 0.5 : loopBars <= 2 ? 2 : 1;

  let rnd = seed * 9301 + 49297;
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);

  const sections = [];
  let beat = 0;
  for (const tpl of TEMPLATES[length] || TEMPLATES.full) {
    const loops = Math.max(1, Math.round(tpl.loops * scale));
    const prog = tpl.prog === 'bridge' ? bridge : main;
    const bars = [];
    for (let l = 0; l < loops; l++) bars.push(...prog);
    const beats = bars.length * bpb;
    sections.push({ ...tpl, loops, bars, startBeat: beat, beats, progName: tpl.prog });
    beat += beats;
  }
  const lengthBeats = beat + bpb * 2; // a ringing final chord after the outro

  const events = [];
  const levels = st.levels || {};
  const ev = (e) => { e.vel *= levels[e.track] ?? 1; events.push(e); };
  const sw = (b) => { // swing the off-beat 8ths
    const frac = b - Math.floor(b);
    return Math.abs(frac - 0.5) < 1e-6 ? b + st.swing * 0.5 : b;
  };
  let padVoices = [55, 59, 62, 67], keyVoices = [60, 64, 67, 72];

  sections.forEach((sec, si) => {
    const next = sections[si + 1];
    const E = sec.energy;
    let b0 = sec.startBeat;
    sec.bars.forEach((bar, bi) => {
      const lastBar = bi === sec.bars.length - 1;
      const barStart = b0;
      let cb = barStart;
      bar.chords.forEach((c) => {
        const ch = c.chord;
        const pcs = style === 'lofi' ? colourTones(ch, key) : ch.pcs;
        // Pad: sustained, voice-led
        padVoices = voiceLead(padVoices, pcs.slice(0, 4), 50, 74);
        const padVel = 0.25 + 0.45 * E;
        for (const m of padVoices) ev({ beat: cb, track: 'pad', inst: st.pad[0], midi: m, vel: padVel, dur: c.beats });
        if (st.pad[1] && E >= 0.6) for (const m of padVoices) ev({ beat: cb, track: 'pad', inst: st.pad[1], midi: m + 12, vel: padVel * 0.7, dur: c.beats });

        // Bass
        const root = 28 + ((ch.root - 28) % 12 + 12) % 12; // E1..D#2
        const fifth = root + 7;
        if (E >= 0.3 || sec.ending) {
          if (style === 'drive' && E >= 0.5) {
            for (let k = 0; k < c.beats * 2; k++) ev({ beat: cb + k / 2, track: 'bass', inst: 'bass', midi: root + (E >= 0.9 && k % 4 === 3 ? 12 : 0), vel: k % 2 ? 0.7 : 0.9, dur: 0.45 });
          } else if (style === 'lofi') {
            ev({ beat: cb, track: 'bass', inst: 'bass', midi: root, vel: 0.9, dur: 1.4 });
            if (c.beats >= 3) ev({ beat: sw(cb + 1.5), track: 'bass', inst: 'bass', midi: fifth, vel: 0.7, dur: 0.8 });
            if (c.beats >= 4) ev({ beat: cb + 3, track: 'bass', inst: 'bass', midi: root + 12, vel: 0.6, dur: 0.9 });
          } else if (style === 'ballad' || style === 'drive') {
            for (let k = 0; k < c.beats; k += 2) ev({ beat: cb + k, track: 'bass', inst: 'bass', midi: k ? fifth - 12 + (fifth - 12 < 26 ? 12 : 0) : root, vel: 0.85, dur: Math.min(2, c.beats - k) - 0.05 });
          } else { // heavenly: long roots
            ev({ beat: cb, track: 'bass', inst: 'bass', midi: root, vel: 0.8, dur: c.beats - 0.05 });
          }
        }

        // Keys
        keyVoices = voiceLead(keyVoices, pcs.slice(0, 4), 55, 79);
        const kv = keyVoices.map((m) => m + st.keysOctave);
        if (style === 'drive' && E >= 0.5) {
          for (let k = 0; k < c.beats; k++) for (const m of kv) ev({ beat: cb + k, track: 'keys', inst: st.keys, midi: m, vel: (k % 2 ? 0.45 : 0.6) * (0.6 + 0.4 * E), dur: 0.9 });
        } else if (style === 'lofi' && E >= 0.3) {
          for (const m of kv) ev({ beat: cb, track: 'keys', inst: st.keys, midi: m, vel: 0.55, dur: 1.3 });
          if (c.beats >= 3) for (const m of kv) ev({ beat: sw(cb + 1.5), track: 'keys', inst: st.keys, midi: m, vel: 0.4, dur: 0.8 });
        } else if (style === 'ballad' && E >= 0.25) {
          const arp = [kv[0] - 12, kv[1], kv[2], kv[3] ?? kv[0] + 12, kv[2], kv[1], kv[2], kv[3] ?? kv[0] + 12];
          for (let k = 0; k < c.beats * 2; k++) ev({ beat: cb + k / 2, track: 'keys', inst: st.keys, midi: arp[k % 8], vel: (k % 4 === 0 ? 0.6 : 0.42) * (0.7 + 0.3 * E), dur: 1.2 });
        } else if (style === 'heavenly' && E >= 0.45) {
          // sparkling broken chord, high up
          const notes = [kv[0], kv[2], kv[1] + 12, kv[3] ?? kv[2] + 12];
          for (let k = 0; k < c.beats; k++) if (k % 2 === 0 || E >= 0.9) ev({ beat: cb + k + (k % 2 ? 0.5 : 0), track: 'keys', inst: st.keys, midi: notes[(k + bi) % notes.length], vel: 0.35 + 0.15 * E, dur: 1.6 });
        }
        cb += c.beats;
      });

      // Drums for this bar
      if (E >= 0.45 || (sec.ending && bi === 0)) drumBar(ev, style, barStart, bpb, E, sw, rand);
      // Fill / build-up at the end of a section heading somewhere bigger
      if (lastBar && next && !sec.build && next.energy > E + 0.15 && E >= 0.2) drumFill(ev, barStart, bpb, sec.build || next.energy >= 0.9, E);
      if (lastBar && sec.build) {
        for (let k = 0; k < bpb * 2; k++) ev({ beat: barStart + k / 2, track: 'drums', inst: 'snare', vel: 0.25 + 0.6 * (k / (bpb * 2)), dur: 0.5 });
        ev({ beat: barStart, track: 'fx', inst: 'riser', vel: 0.6, dur: bpb });
      }
      b0 += bar.chords.reduce((a, c) => a + c.beats, 0);
    });
    // Crash into big sections
    if (E >= 0.9 || (si > 0 && E > sections[si - 1].energy + 0.3)) ev({ beat: sec.startBeat, track: 'drums', inst: 'crash', vel: 0.8, dur: 4 });

    // Your riff, beat-sliced onto the grid
    if (sec.riff && sec.progName === 'main' && analysisHasRiff(analysis)) {
      const riffBeats = analysis.riff.beatTimes.length - 1;
      for (let b = 0; b < sec.beats; b++) {
        ev({ beat: sec.startBeat + b, track: 'riff', inst: 'riff', slice: b % riffBeats, vel: sec.energy >= 0.9 ? 1 : 0.9, dur: 1 });
      }
    }
  });

  // The ending: first chord, everything rings.
  const endBeat = beat, first = main[0].chords[0].chord;
  padVoices = voiceLead(padVoices, first.pcs, 50, 74);
  for (const m of padVoices) ev({ beat: endBeat, track: 'pad', inst: st.pad[0], midi: m, vel: 0.5, dur: bpb * 2 });
  ev({ beat: endBeat, track: 'bass', inst: 'bass', midi: 28 + ((first.root - 28) % 12 + 12) % 12, vel: 0.9, dur: bpb * 2 });
  keyVoices = voiceLead(keyVoices, first.pcs, 55, 79);
  for (const m of keyVoices) ev({ beat: endBeat, track: 'keys', inst: st.keys, midi: m + st.keysOctave, vel: 0.5, dur: bpb * 2 });
  ev({ beat: endBeat, track: 'drums', inst: 'kick', vel: 0.9, dur: 1 });
  ev({ beat: endBeat, track: 'drums', inst: 'crash', vel: 0.7, dur: 6 });
  if (analysisHasRiff(analysis)) ev({ beat: endBeat, track: 'riff', inst: 'riff', slice: 0, vel: 0.9, dur: bpb * 2, ring: true });

  events.sort((a, b) => a.beat - b.beat);
  return {
    bpm: bpm || analysis.bpm, beatsPerBar: bpb, style, key, sections, events, lengthBeats,
    keyName: NOTE_NAMES[key.tonic] + (key.mode === 'minor' ? ' minor' : ' major'),
  };
}

const analysisHasRiff = (a) => !!(a.riff && a.riff.beatTimes && a.riff.beatTimes.length > 1 && a.riffBuffer !== false);

function drumBar(ev, style, b, bpb, E, sw, rand) {
  const d = (beat, inst, vel) => ev({ beat, track: 'drums', inst, vel, dur: 1 });
  if (bpb === 3) {
    d(b, 'kick', 0.9); d(b + 1, 'hihat', 0.4); d(b + 2, 'hihat', 0.4);
    if (E >= 0.7) d(b + 2, 'snare', 0.5);
    return;
  }
  if (style === 'heavenly') {
    d(b, 'kick', 0.75);
    if (E >= 0.7) { d(b + 2, 'snare', 0.45); d(b + 2.5, 'kick', 0.4); }
    for (let k = 0; k < 8; k++) if (E >= 0.6 || k % 2 === 0) d(b + k / 2, 'hihat', (k % 2 ? 0.16 : 0.24) * (0.6 + 0.4 * E));
  } else if (style === 'drive') {
    d(b, 'kick', 1); d(b + 2, 'kick', 0.9);
    if (E >= 0.9) d(b + 2.5, 'kick', 0.7);
    d(b + 1, 'snare', 0.85); d(b + 3, 'snare', 0.9);
    for (let k = 0; k < 8; k++) d(b + k / 2, 'hihat', (k % 2 ? 0.3 : 0.45) * (0.7 + 0.3 * E));
  } else if (style === 'lofi') {
    d(b, 'kick', 0.9); d(sw(b + 1.5), 'kick', 0.6); if (rand() < 0.4) d(b + 2.75, 'kick', 0.4);
    d(b + 1, 'snare', 0.7); d(b + 3, 'snare', 0.75);
    for (let k = 0; k < 8; k++) d(sw(b + k / 2), 'hihat', k % 2 ? 0.2 : 0.32);
  } else { // ballad
    d(b, 'kick', 0.8);
    if (E >= 0.9) { d(b + 1, 'snare', 0.6); d(b + 3, 'snare', 0.65); d(b + 2, 'kick', 0.6); }
    else d(b + 2, 'snare', 0.4);
    for (let k = 0; k < 4; k++) d(b + k, 'hihat', 0.25);
  }
}

function drumFill(ev, b, bpb, big, E) {
  const start = b + bpb - (big ? 2 : 1);
  const toms = ['tom1', 'tom1', 'tom2', 'tom2', 'tom3', 'tom3', 'tom3', 'kick'];
  const n = (b + bpb - start) * 4;
  for (let k = 0; k < n; k++) {
    const inst = big ? toms[Math.floor((k / n) * toms.length)] : (k % 2 ? 'snare' : 'tom2');
    ev({ beat: start + k / 4, track: 'drums', inst, vel: 0.35 + 0.5 * (k / n) * (0.6 + 0.4 * E), dur: 0.5, fill: true });
  }
}
