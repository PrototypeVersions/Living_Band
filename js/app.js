// Living Band — the app: record → check → pick a vibe → jam.
import { Recorder } from './recorder.js';
import { strumRecording } from './demo-riff.js';
import { arrange, STYLES, detectKey, makeChord } from './arranger.js';
import { loadStyle, Player, renderSong, wavBlob, TRACKS, DEFAULT_MIX } from './engine.js';
import { NOTE_NAMES } from './dsp.js';

const $ = (id) => document.getElementById(id);
const S = { ctx: null, recorder: null, analysis: null, riff: null, song: null, bank: null, style: 'heavenly', length: 'full', includeRiff: false };
window.livingBand = S; // for debugging and tests

// ---------- views ----------
const VIEWS = ['record', 'review', 'style', 'jam'];
function show(view) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== view;
  const at = VIEWS.indexOf(view);
  document.querySelectorAll('#steps li').forEach((li, i) => { li.classList.toggle('on', i === at); li.classList.toggle('done', i < at); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function busy(text) {
  let el = document.querySelector('.busy');
  if (!text) { el && el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'busy'; el.innerHTML = '<div></div>'; document.body.appendChild(el); }
  el.firstChild.textContent = text;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function audio() {
  if (!S.ctx) {
    S.ctx = new AudioContext({ latencyHint: 'interactive' });
    S.player = new Player(S.ctx);
    S.player.onBeat = onBeat;
  }
  if (S.ctx.state !== 'running') await S.ctx.resume();
  return S.ctx;
}

// ---------- 1. record ----------
let recTimer = null, meterTimer = null;
$('recBtn').addEventListener('click', async () => {
  $('recError').hidden = true;
  try {
    await audio();
    if (!S.recorder) S.recorder = new Recorder(S.ctx);
    if (!S.recorder.recording) {
      if (!S.recorder.stream) await openInput();
      S.recorder.start();
      $('recBtn').classList.add('on');
      $('recHint').textContent = 'Recording… play your progression 2–3 times, then press stop.';
      const t0 = S.ctx.currentTime;
      recTimer = setInterval(() => { $('recTime').textContent = fmt(S.ctx.currentTime - t0); }, 200);
    } else {
      clearInterval(recTimer);
      $('recBtn').classList.remove('on');
      const x = S.recorder.stop();
      $('recHint').textContent = 'Press the red button to start recording.';
      if (x.length < S.ctx.sampleRate * 3) { showRecError('That was very short. Play the progression at least twice round.'); return; }
      await analyse(x, S.ctx.sampleRate);
    }
  } catch (e) {
    showRecError('Could not use the input: ' + e.message);
  }
});

function showRecError(msg) { $('recError').textContent = msg; $('recError').hidden = false; }

async function openInput(deviceId) {
  const n = await S.recorder.open(deviceId);
  const inputs = await Recorder.inputs();
  $('inputSelect').innerHTML = inputs.map((d) => `<option value="${d.deviceId}">${d.label || 'Input'}</option>`).join('');
  if (deviceId) $('inputSelect').value = deviceId;
  $('channelSelect').innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">Channel ${i + 1}</option>`).join('');
  $('channelSelect').value = String(S.recorder.channel);
  $('channelInfo').textContent = `“${S.recorder.label}”: the browser offers ${n} channel${n === 1 ? '' : 's'}. Pick the one your guitar is on; a clean sound works best.`;
  if (!meterTimer) meterTimer = setInterval(() => { $('level').style.width = `${Math.max(0, Math.min(100, (S.recorder.levelDb() + 70) / 70 * 100))}%`; }, 60);
}
$('inputSelect').addEventListener('change', (e) => openInput(e.target.value).catch((err) => showRecError(err.message)));
$('channelSelect').addEventListener('change', (e) => S.recorder.selectChannel(Number(e.target.value)));

$('demoBtn').addEventListener('click', async () => {
  await audio();
  busy('Strumming a demo riff…');
  await new Promise((r) => setTimeout(r, 30));
  const bars = ['Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D'];
  const { x, sr } = strumRecording(bars, { bpm: 92, sr: S.ctx.sampleRate, seed: 5 });
  S.demo = true;
  await analyse(x, sr);
});

// ---------- analysis ----------
function runAnalysis(x, sr) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { w.terminate(); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'analysis failed')); };
    w.postMessage({ x, sr });
  });
}

async function analyse(x, sr) {
  busy('Listening back…');
  try {
    const res = await runAnalysis(x, sr);
    if (res.error) { busy(); showRecError(res.error); show('record'); return; }
    // Rebuild chord objects (the worker sends plain data) so edits and the arranger work on them.
    for (const bar of res.progression) for (const c of bar.chords) c.chord = makeChord(c.chord.root, c.chord.quality.suffix);
    const buf = S.ctx.createBuffer(1, x.length, sr);
    buf.copyToChannel(x, 0);
    S.recording = x;
    S.analysis = res;
    S.riff = res.riff ? { buffer: buf, beatTimes: res.riff.beatTimes } : null;
    S.bpm = Math.round(res.bpm);
    busy();
    renderReview();
    show('review');
  } catch (e) {
    busy();
    showRecError('Something went wrong while listening back: ' + e.message);
  }
}

// ---------- 2. review ----------
const CHORD_CHOICES = [];
for (let r = 0; r < 12; r++) for (const sfx of ['', 'm']) CHORD_CHOICES.push(makeChord(r, sfx));
for (let r = 0; r < 12; r++) for (const sfx of ['7', 'maj7', 'm7', 'sus2', 'sus4', '5']) CHORD_CHOICES.push(makeChord(r, sfx));

function renderReview() {
  const a = S.analysis;
  $('bpmInput').value = S.bpm;
  $('timeSig').textContent = `${a.beatsPerBar}/4`;
  const key = detectKey(a.progression);
  $('keyName').textContent = NOTE_NAMES[key.tonic] + (key.mode === 'minor' ? ' minor' : ' major');
  $('loopInfo').textContent = `${a.progression.length} bar${a.progression.length === 1 ? '' : 's'}` + (a.passes > 1 ? `, heard ${a.passes}×` : '');
  const bars = $('bars');
  bars.innerHTML = '';
  a.progression.forEach((bar, bi) => {
    const el = document.createElement('div');
    el.className = 'bar';
    el.innerHTML = `<div class="n">Bar ${bi + 1}</div><div class="cs"></div>`;
    bar.chords.forEach((c, ci) => {
      const sel = document.createElement('select');
      const alts = (c.alts || []).map((x) => x.label);
      const labels = [...new Set([c.chord.label, ...alts, ...CHORD_CHOICES.map((x) => x.label)])];
      sel.innerHTML = labels.map((l) => `<option>${l}</option>`).join('');
      sel.value = c.chord.label;
      sel.addEventListener('change', () => {
        const pick = CHORD_CHOICES.find((x) => x.label === sel.value) || (c.alts || []).find((x) => x.label === sel.value);
        c.chord = makeChord(pick.root, pick.quality.suffix);
        renderReview();
      });
      el.querySelector('.cs').appendChild(sel);
    });
    bars.appendChild(el);
  });
}

$('bpmInput').addEventListener('change', (e) => { S.bpm = Math.max(40, Math.min(220, Number(e.target.value) || S.bpm)); e.target.value = S.bpm; });
$('bpmHalf').addEventListener('click', () => retime(0.5));
$('bpmDouble').addEventListener('click', () => retime(2));

/** "The beat is really twice as fast / half as fast": rescale chords and re-slice the riff. */
function retime(f) {
  const a = S.analysis, bpb = a.beatsPerBar;
  const spans = [];
  for (const bar of a.progression) for (const c of bar.chords) spans.push({ ...c, beats: c.beats * f });
  if (spans.some((s) => s.beats < 1 || s.beats % 1)) return; // can't halve this
  const bars = [];
  let cur = { chords: [] }, fill = 0;
  for (const s of spans) {
    let left = s.beats;
    while (left > 0) {
      const take = Math.min(left, bpb - fill);
      const last = cur.chords[cur.chords.length - 1];
      if (last && last.chord.label === s.chord.label && fill > 0) last.beats += take;
      else cur.chords.push({ chord: s.chord, beats: take, alts: s.alts });
      fill += take; left -= take;
      if (fill === bpb) { bars.push(cur); cur = { chords: [] }; fill = 0; }
    }
  }
  if (cur.chords.length) bars.push(cur);
  a.progression = bars;
  if (S.riff) {
    const bt = S.riff.beatTimes, out = [];
    if (f === 2) { for (let i = 0; i + 1 < bt.length; i++) out.push(bt[i], (bt[i] + bt[i + 1]) / 2); out.push(bt[bt.length - 1]); }
    else { for (let i = 0; i < bt.length; i += 2) out.push(bt[i]); }
    S.riff.beatTimes = out;
    a.riff = { beatTimes: out };
  }
  S.bpm = Math.round(S.bpm * f);
  renderReview();
}

$('hearBtn').addEventListener('click', async () => {
  await audio();
  if (S.player.playing) { S.player.stop(true); $('hearBtn').textContent = '▶ Hear my riff on the beat'; return; }
  busy('Loading sounds…');
  const bank = await loadStyle(S.ctx, 'drive');
  busy();
  // Your riff, beat-sliced onto a steady grid, with a click: the quickest check that the beat is right.
  const a = S.analysis, bpb = a.beatsPerBar, beats = a.progression.length * bpb, events = [];
  for (let rep = 0; rep < 2; rep++) for (let b = 0; b < beats; b++) {
    const beat = rep * beats + b;
    if (S.riff) events.push({ beat, track: 'riff', inst: 'riff', slice: b % (S.riff.beatTimes.length - 1), vel: 1, dur: 1 });
    events.push({ beat, track: 'drums', inst: b % bpb === 0 ? 'kick' : 'hihat', vel: b % bpb === 0 ? 0.7 : 0.5, dur: 1 });
  }
  S.player.setSong({ bpm: S.bpm, events, lengthBeats: beats * 2 + 1 }, bank, S.riff);
  S.player.play(0);
  $('hearBtn').textContent = '■ Stop';
});

$('redoBtn').addEventListener('click', () => { S.player && S.player.stop(true); show('record'); });
$('toStyleBtn').addEventListener('click', () => { S.player && S.player.stop(true); $('hearBtn').textContent = '▶ Hear my riff on the beat'; renderStyles(); show('style'); });

// ---------- 3. style ----------
function renderStyles() {
  const box = $('styles');
  box.innerHTML = '';
  for (const [k, st] of Object.entries(STYLES)) {
    const b = document.createElement('button');
    b.className = 'style' + (k === S.style ? ' on' : '');
    b.innerHTML = `<b>${st.name}</b><span>${st.blurb}</span>`;
    b.addEventListener('click', () => { S.style = k; renderStyles(); });
    box.appendChild(b);
  }
}
document.querySelectorAll('#lengthSeg button').forEach((b) => b.addEventListener('click', () => {
  S.length = b.dataset.len;
  document.querySelectorAll('#lengthSeg button').forEach((x) => x.classList.toggle('on', x === b));
}));

$('buildBtn').addEventListener('click', buildSong);
async function buildSong() {
  await audio();
  busy('Loading the band…');
  try {
    S.bank = await loadStyle(S.ctx, S.style, (p) => busy(`Loading the band… ${Math.round(p * 100)}%`));
  } catch (e) { busy(); $('loadInfo').textContent = 'Could not load sounds: ' + e.message; return; }
  arrangeSong();
  busy();
  renderJam();
  show('jam');
}

/** (Re)arrange with the current choices. Your recording is left out unless you switch it on. */
function arrangeSong() {
  const useRiff = S.includeRiff && S.riff;
  const analysis = { ...S.analysis, riff: useRiff ? { beatTimes: S.riff.beatTimes } : null };
  S.song = arrange(analysis, { style: S.style, length: S.length, bpm: S.bpm });
  S.player.setSong(S.song, S.bank, useRiff ? S.riff : null);
  S.chordTimeline = chordTimeline(S.song);
}

$('riffToggle').addEventListener('change', (e) => {
  S.includeRiff = e.target.checked;
  const wasPlaying = S.player.playing, pos = S.player.position;
  arrangeSong();
  renderJam();
  S.player.position = pos;
  if (wasPlaying) S.player.play(pos);
  onBeat(pos);
});

// ---------- 4. jam ----------
function chordTimeline(song) {
  const out = [];
  for (const sec of song.sections) {
    let b = sec.startBeat;
    for (const bar of sec.bars) for (const c of bar.chords) { out.push({ beat: b, label: c.chord.label }); b += c.beats; }
  }
  out.push({ beat: song.lengthBeats - song.beatsPerBar * 2, label: song.sections[0].bars[0].chords[0].chord.label });
  return out;
}

function scaleTip(key) {
  const t = key.tonic, name = NOTE_NAMES[t];
  const pent = key.mode === 'minor' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
  const notes = pent.map((i) => NOTE_NAMES[(t + i) % 12]).join(' ');
  if (key.mode === 'minor') {
    return `Your song is in <b>${name} minor</b>. Start with <b>${name} minor pentatonic</b> (${notes}). For more colour, add the 2nd and 6th: ${name} natural minor (Aeolian), or ${name} Dorian for a brighter, jazzier sound.`;
  }
  const rel = NOTE_NAMES[(t + 9) % 12];
  return `Your song is in <b>${name} major</b>. Try <b>${name} major pentatonic</b> (${notes}), which is the same notes as ${rel} minor pentatonic in a different spot. For a bluesier edge, bend into the minor 3rd.`;
}

function renderJam() {
  const song = S.song, spb = 60 / song.bpm;
  $('songTitle').textContent = `${STYLES[song.style].name} in ${song.keyName}`;
  $('songMeta').textContent = `${Math.round(song.bpm)} bpm · ${song.beatsPerBar}/4 · ${fmt(song.lengthBeats * spb)} · built from your ${S.analysis.progression.length}-bar riff`;
  $('riffToggle').checked = !!S.includeRiff;
  $('riffToggle').disabled = !S.riff;
  $('scaleTip').innerHTML = scaleTip(song.key);
  const tl = $('timeline');
  tl.innerHTML = '<div class="playhead" id="playhead"></div>';
  song.sections.forEach((sec, i) => {
    const b = document.createElement('button');
    b.className = 'sec';
    b.style.flex = String(sec.beats);
    b.style.background = `hsl(${28 + (1 - sec.energy) * 160}, ${30 + sec.energy * 40}%, ${18 + sec.energy * 10}%)`;
    b.innerHTML = `<div class="fill" style="height:${Math.round(sec.energy * 100)}%"></div><span>${sec.name}</span>`;
    b.title = `${sec.name}: click to jump here`;
    b.addEventListener('click', () => { S.player.position = sec.startBeat; if (S.player.loop) S.player.setLoop(sec); if (S.player.playing) S.player.play(sec.startBeat); onBeat(sec.startBeat); });
    b.dataset.i = i;
    tl.appendChild(b);
  });
  $('mixer').innerHTML = '';
  const names = { riff: 'Your riff', drums: 'Drums', bass: 'Bass', keys: 'Keys', pad: 'Pads' };
  for (const t of TRACKS) {
    if (t === 'riff' && !(S.includeRiff && S.riff)) continue;
    const l = document.createElement('label');
    l.innerHTML = `<span>${names[t]}</span><input type="range" min="0" max="1.2" step="0.01" value="${S.player.mix[t] ?? DEFAULT_MIX[t]}">`;
    l.querySelector('input').addEventListener('input', (e) => S.player.setMix(t, Number(e.target.value)));
    $('mixer').appendChild(l);
  }
  $('loopBtn').classList.remove('on');
  S.player.setLoop(null);
  onBeat(0);
}

function sectionAt(beat) {
  const secs = S.song.sections;
  for (let i = secs.length - 1; i >= 0; i--) if (beat >= secs[i].startBeat) return secs[i];
  return secs[0];
}

function onBeat(beat) {
  if (!S.song || $('view-jam').hidden) return;
  const song = S.song, spb = 60 / song.bpm;
  $('clock').textContent = `${fmt(beat * spb)} / ${fmt(song.lengthBeats * spb)}`;
  const sec = sectionAt(beat);
  $('sectionName').textContent = sec.name;
  document.querySelectorAll('.sec').forEach((el) => el.classList.toggle('current', song.sections[el.dataset.i] === sec));
  const ph = $('playhead');
  if (ph) ph.style.left = `${(beat / song.lengthBeats) * 100}%`;
  const tl = S.chordTimeline;
  let i = 0;
  while (i + 1 < tl.length && tl[i + 1].beat <= beat + 1e-6) i++;
  $('nowChord').textContent = tl[i].label;
  let j = i + 1;
  while (j < tl.length && tl[j].label === tl[i].label) j++;
  $('nextChord').textContent = j < tl.length ? tl[j].label : '—';
  $('playBtn').textContent = S.player.playing ? '❚❚' : '▶';
}

$('playBtn').addEventListener('click', async () => {
  await audio();
  if (S.player.playing) { S.player.stop(); onBeat(S.player.position); }
  else S.player.play(S.player.position >= S.song.lengthBeats - 0.5 ? 0 : S.player.position);
});
$('loopBtn').addEventListener('click', () => {
  const on = !S.player.loop;
  const sec = on ? sectionAt(S.player.position) : null;
  S.player.setLoop(sec);
  $('loopBtn').textContent = on ? `⟲ Looping ${sec.name}` : '⟲ Loop this section';
  document.querySelectorAll('.sec').forEach((el) => el.classList.toggle('looped', on && S.song.sections[el.dataset.i] === sec));
});
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('view-jam').hidden && e.target.tagName !== 'INPUT') { e.preventDefault(); $('playBtn').click(); }
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const fileBase = () => `living-band-${STYLES[S.song.style].name.toLowerCase()}-${S.song.keyName.replace(' ', '-').replace('#', 'sharp').toLowerCase()}-${Math.round(S.song.bpm)}bpm`;

$('exportBtn').addEventListener('click', async () => {
  busy('Rendering your song… (this can take a minute)');
  try { download(wavBlob(await renderSong(S.song, S.bank, S.includeRiff ? S.riff : null, { mix: S.player.mix })), fileBase() + '.wav'); }
  catch (e) { $('exportInfo').textContent = 'Export failed: ' + e.message; }
  busy();
});
$('stemsBtn').addEventListener('click', async () => {
  const names = { riff: 'your-riff', drums: 'drums', bass: 'bass', keys: 'keys', pad: 'pads' };
  try {
    for (const t of TRACKS) {
      if (t === 'riff' && !(S.includeRiff && S.riff)) continue;
      busy(`Rendering ${names[t]}…`);
      download(wavBlob(await renderSong(S.song, S.bank, S.includeRiff ? S.riff : null, { only: t })), `${fileBase()}-${names[t]}.wav`);
    }
    $('exportInfo').textContent = 'All parts start at the same moment: line them up at zero in your DAW.';
  } catch (e) { $('exportInfo').textContent = 'Export failed: ' + e.message; }
  busy();
});

$('restyleBtn').addEventListener('click', () => { S.player.stop(true); renderStyles(); show('style'); });
$('newRiffBtn').addEventListener('click', () => { S.player.stop(true); show('record'); });
