// Living Band — wiring: audio start-up, the listen → decide → play loop, and the page controls.
import { analyzeSpectrum, newEnergy, ChordTracker, OnsetDetector, NOTE_NAMES, midiName } from './dsp.js';
import { Conductor, PERSONALITIES } from './conductor.js';
import { Band } from './band.js';
import { Listener, PITCH_FFT } from './listener.js';
import { MidiControl } from './midi.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'livingband.settings';
let settings = { gate: -52, volume: 0.7, personality: 'heavenly', inputId: '', channel: 0, outputId: '' };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch (e) { /* fresh start */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } };

let ctx, listener, band, conductor, tracker, onsets, midi;
let playing = false, belowSince = 0, lastTick = 0, lastFrame = null;
let prevPitch = null, strikeBefore = null;
const state = { chord: null, decision: null, levelDb: -100, density: 0, playing: false };
window.livingBand = state; // handy for debugging in the console
state.changes = []; // {t, heard, band} each time the heard or played chord changes

// ---------- Personality select ----------
for (const [key, p] of Object.entries(PERSONALITIES)) {
  const o = document.createElement('option'); o.value = key; o.textContent = p.name;
  $('personality').appendChild(o);
}
$('personality').value = settings.personality;
$('personalityBlurb').textContent = PERSONALITIES[settings.personality].blurb;
$('gate').value = settings.gate; $('gateVal').textContent = settings.gate + ' dB';
$('volume').value = settings.volume;

// ---------- Start-up ----------
let running = false, loopTimer = null;
$('startBtn').addEventListener('click', () => (running ? stop() : start()));

function setRunning(on) {
  running = on;
  $('startBtn').textContent = on ? 'Stop audio' : 'Start audio';
  $('startBtn').classList.toggle('primary', !on);
}

/** Stop everything: release the input (mic light goes off), stop the demo, silence the band. */
async function stop() {
  clearInterval(loopTimer); loopTimer = null;
  listener.stopDemo();
  listener.close();
  $('demoBtn').textContent = 'Try the demo guitar';
  await ctx.suspend();
  setRunning(false);
  $('mode').textContent = 'stopped';
  $('channelInfo').textContent = 'Audio stopped. Press “Start audio” to listen again.';
}

async function start() {
  if (ctx) {
    await ctx.resume();
    try { await openInput(settings.inputId); } catch (e) { $('channelInfo').textContent = 'Could not open an input (' + e.message + ').'; }
    lastTick = 0;
    loopTimer = setInterval(tick, 30);
    setRunning(true);
    return;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  await ctx.resume();
  listener = new Listener(ctx);
  band = new Band(ctx, ctx.destination);
  band.setVolume(settings.volume);
  conductor = new Conductor(settings.personality);
  tracker = new ChordTracker();
  onsets = new OnsetDetector();

  setRunning(true);
  for (const el of document.querySelectorAll('button:disabled, select:disabled')) {
    if (el.id !== 'startBtn' && el.id !== 'channelSelect') el.disabled = false;
  }

  try {
    await openInput(settings.inputId); // also unlocks device names
    await fillDevices();
  } catch (e) {
    $('channelInfo').textContent = 'Could not open an input (' + e.message + '). You can still try the demo guitar.';
  }
  showLatency();
  setupMidi();
  loopTimer = setInterval(tick, 30);
}

async function fillDevices() {
  const inputs = await Listener.listInputs();
  const sel = $('inputSelect');
  sel.innerHTML = '';
  for (const d of inputs) {
    const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Input ' + (sel.length + 1);
    sel.appendChild(o);
  }
  if (settings.inputId && inputs.some((d) => d.deviceId === settings.inputId)) sel.value = settings.inputId;

  const outSel = $('outputSelect');
  outSel.innerHTML = '';
  if (typeof ctx.setSinkId !== 'function') {
    outSel.innerHTML = '<option>System default (this browser cannot choose)</option>';
    outSel.disabled = true;
    return;
  }
  const outs = await Listener.listOutputs();
  for (const d of outs) {
    const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Output';
    outSel.appendChild(o);
  }
  if (settings.outputId && outs.some((d) => d.deviceId === settings.outputId)) {
    outSel.value = settings.outputId;
    try { await ctx.setSinkId(settings.outputId); } catch (e) { /* fall back to default */ }
  }
}

async function openInput(deviceId) {
  const n = await listener.open(deviceId);
  const chSel = $('channelSelect');
  chSel.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const o = document.createElement('option'); o.value = String(i); o.textContent = 'Channel ' + (i + 1);
    chSel.appendChild(o);
  }
  const mix = document.createElement('option'); mix.value = 'mix'; mix.textContent = 'All channels mixed';
  chSel.appendChild(mix);
  const ch = settings.channel === 'mix' ? 'mix' : Math.min(Number(settings.channel) || 0, n - 1);
  chSel.value = String(ch);
  listener.selectChannel(ch);
  chSel.disabled = false;
  $('channelInfo').textContent = `“${listener.trackLabel}”: the browser exposes ${n} channel${n === 1 ? '' : 's'}.` +
    (n < 3 ? ' (A Tone Master Pro dry signal on channel 3 is not reachable from the browser on this setup.)' : '');
}

function showLatency() {
  const base = (ctx.baseLatency || 0) * 1000, out = (ctx.outputLatency || 0) * 1000;
  $('latencyInfo').textContent = `Band output latency ≈ ${Math.round(base + out)} ms (sample rate ${ctx.sampleRate} Hz).`;
}

// ---------- Controls ----------
$('inputSelect').addEventListener('change', async (e) => {
  settings.inputId = e.target.value; saveSettings();
  try { await openInput(settings.inputId); } catch (err) { $('channelInfo').textContent = 'Could not open: ' + err.message; }
});
$('channelSelect').addEventListener('change', (e) => {
  const v = e.target.value === 'mix' ? 'mix' : Number(e.target.value);
  settings.channel = v; saveSettings();
  listener.selectChannel(v);
});
$('outputSelect').addEventListener('change', async (e) => {
  settings.outputId = e.target.value; saveSettings();
  try { await ctx.setSinkId(e.target.value); showLatency(); } catch (err) { $('latencyInfo').textContent = 'Could not switch output: ' + err.message; }
});
$('gate').addEventListener('input', (e) => {
  settings.gate = Number(e.target.value); $('gateVal').textContent = settings.gate + ' dB'; saveSettings();
});
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value); saveSettings();
  band && band.setVolume(settings.volume);
});
$('personality').addEventListener('change', (e) => setPersonality(e.target.value));
$('enableBtn').addEventListener('click', () => doAction('toggleBand'));
$('holdBtn').addEventListener('click', () => doAction('toggleHold'));
$('demoBtn').addEventListener('click', async () => {
  if (listener.demo) {
    listener.stopDemo();
    $('demoBtn').textContent = 'Try the demo guitar';
    try { await openInput(settings.inputId); } catch (e) { /* no input available */ }
  } else {
    listener.startDemo(ctx.destination);
    $('demoBtn').textContent = 'Stop demo, back to my guitar';
    $('channelInfo').textContent = 'Listening to the demo guitar.';
    $('channelSelect').disabled = true;
  }
});

function setPersonality(key) {
  settings.personality = key; saveSettings();
  $('personality').value = key;
  $('personalityBlurb').textContent = PERSONALITIES[key].blurb;
  conductor && conductor.setPersonality(key);
}

function doAction(action) {
  if (!conductor) return;
  if (action === 'toggleBand') {
    conductor.enabled = !conductor.enabled;
    $('enableBtn').textContent = 'Band: ' + (conductor.enabled ? 'on' : 'off');
    $('enableBtn').classList.toggle('active', !conductor.enabled);
  } else if (action === 'toggleHold') {
    conductor.hold = !conductor.hold;
    $('holdBtn').textContent = 'Hold: ' + (conductor.hold ? 'on' : 'off');
    $('holdBtn').classList.toggle('active', conductor.hold);
  } else if (action === 'nextPersonality') {
    const keys = Object.keys(PERSONALITIES);
    setPersonality(keys[(keys.indexOf(settings.personality) + 1) % keys.length]);
  } else if (action.startsWith('learned:')) {
    refreshBindings();
    for (const b of document.querySelectorAll('[data-learn]')) b.textContent = 'Learn';
  }
}

async function setupMidi() {
  midi = new MidiControl(doAction, (txt) => { $('midiLast').textContent = txt; });
  $('midiStatus').textContent = await midi.init();
  refreshBindings();
  for (const b of document.querySelectorAll('[data-learn]')) {
    b.addEventListener('click', () => {
      midi.learn(b.dataset.learn);
      b.textContent = 'Press a switch…';
    });
  }
}

function refreshBindings() {
  for (const c of document.querySelectorAll('[data-bind]')) c.textContent = (midi && midi.bindingFor(c.dataset.bind)) || '—';
}

// ---------- The loop: listen → decide → play ----------
function tick() {
  const now = ctx.currentTime;
  const dt = lastTick ? now - lastTick : 0.03;
  lastTick = now;

  const { pitchMag, onsetMag, levelDb } = listener.read();
  const gateOpen = levelDb > settings.gate;
  const isOnset = onsets.update(onsetMag, now, gateOpen);

  // Playing, with a little hysteresis so sustained notes don't flicker in and out.
  if (gateOpen) { playing = true; belowSince = 0; }
  else if (playing) {
    if (levelDb < settings.gate - 4) { belowSince = belowSince || now; if (now - belowSince > 0.4) playing = false; }
  }

  const frame = analyzeSpectrum(pitchMag, ctx.sampleRate, PITCH_FFT);
  lastFrame = frame;
  // On a strum, remember what the spectrum looked like just before it, so we can hear only what's new.
  if (isOnset && prevPitch) { strikeBefore = prevPitch.slice(); tracker.strike(now); }
  const fresh = strikeBefore && tracker.strikeAt !== null
    ? analyzeSpectrum(newEnergy(pitchMag, strikeBefore), ctx.sampleRate, PITCH_FFT) : null;
  if (tracker.strikeAt === null) strikeBefore = null;
  const chord = tracker.update(frame, playing, now, fresh);
  if (!prevPitch) prevPitch = new Float32Array(pitchMag.length);
  prevPitch.set(pitchMag);
  const decision = conductor.update({ now, playing, chord, density: onsets.density() });
  band.apply(decision, conductor.p, dt);

  const heardLabel = chord && chord.label, bandLabel = band.chordLabel;
  if (heardLabel !== state.lastHeard || bandLabel !== state.lastBand) {
    state.changes.push({ t: now, heard: heardLabel, band: bandLabel });
    if (state.changes.length > 200) state.changes.shift();
    state.lastHeard = heardLabel; state.lastBand = bandLabel;
  }
  state.demoEvents = listener.demoEvents; state.tracker = tracker;
  Object.assign(state, { chord, decision, levelDb, density: onsets.density(), playing, engagement: conductor.engagement });
  render(frame, chord, decision, levelDb);
}

// ---------- Display ----------
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
const wheel = $('wheel');
const g = wheel.getContext('2d');
let shownChroma = new Float32Array(12);
let lastDomUpdate = 0;

function render(frame, chord, decision, levelDb) {
  const max = Math.max(...frame.chroma, 1e-9);
  for (let i = 0; i < 12; i++) shownChroma[i] = 0.7 * shownChroma[i] + 0.3 * (state.playing ? frame.chroma[i] / max : 0);

  const W = wheel.width, c = W / 2, R = W * 0.33;
  g.clearRect(0, 0, W, W);
  g.strokeStyle = '#263041'; g.lineWidth = 2;
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
  const bandPcs = decision.chord && decision.pad > 0.02 ? decision.chord.pcs : [];
  const heardPcs = chord ? chord.pcs : [];
  FIFTHS.forEach((pc, k) => {
    const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
    const x = c + R * Math.cos(a), y = c + R * Math.sin(a);
    const v = shownChroma[pc];
    g.fillStyle = `rgba(143,184,255,${0.15 + 0.85 * v})`;
    g.beginPath(); g.arc(x, y, 10 + 26 * v, 0, Math.PI * 2); g.fill();
    if (bandPcs.includes(pc)) {
      g.strokeStyle = '#ffc98f'; g.lineWidth = 4;
      g.beginPath(); g.arc(x, y, 40, 0, Math.PI * 2); g.stroke();
    } else if (heardPcs.includes(pc)) {
      g.strokeStyle = '#8fb8ff'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 40, 0, Math.PI * 2); g.stroke();
    }
    g.fillStyle = '#e6e9ef'; g.font = '600 22px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lx = c + (R + 58) * Math.cos(a), ly = c + (R + 58) * Math.sin(a);
    g.fillText(NOTE_NAMES[pc], lx, ly);
  });

  const t = performance.now();
  if (t - lastDomUpdate < 100) return;
  lastDomUpdate = t;
  $('chordName').textContent = chord ? chord.label : '—';
  $('chordConf').textContent = chord ? `match ${(chord.score * 100).toFixed(0)}%` : (state.playing ? 'listening…' : 'play something');
  $('mode').textContent = decision.mode + (decision.chord && decision.pad > 0.02 ? ` · playing ${decision.chord.label}` : '');
  $('notes').textContent = state.playing && frame.notes.length ? frame.notes.map((n) => midiName(n.midi)).join('  ') : '—';
  $('bassNote').textContent = state.playing && frame.bassMidi >= 0 ? midiName(frame.bassMidi) : '—';
  $('density').textContent = state.density.toFixed(1);
  $('padMeter').value = decision.pad;
  $('bassMeter').value = decision.bass;
  $('engMeter').value = conductor.engagement;
  $('levelMeter').value = Math.max(-80, levelDb);
}
