// Living Band — sound engine: sampled instruments, your riff, effects, live playback and offline rendering.
import { STYLES } from './arranger.js';

const NOTE_PCS = { C: 0, Eb: 3, Gb: 6, A: 9 };
const RANGES = { piano: [2, 6], epiano: [2, 6], bass: [1, 3], pad: [2, 5], strings: [3, 5] };
const SUSTAINED = new Set(['pad', 'strings']);
export const TRACKS = ['riff', 'drums', 'bass', 'keys', 'pad'];
const BASE = new URL('../assets/samples/', import.meta.url);

// ---------- Loading ----------
const bufferCache = new Map();
async function loadBuffer(ctx, url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error('Could not load ' + url);
    return r.arrayBuffer();
  }).then((ab) => ctx.decodeAudioData(ab));
  bufferCache.set(url, p);
  return p;
}

export async function loadStyle(ctx, styleKey, onProgress = () => {}) {
  const st = STYLES[styleKey];
  const insts = new Set([st.keys, 'bass', ...st.pad, 'piano']);
  const jobs = [];
  const bank = { notes: {}, drums: {} };
  for (const inst of insts) {
    const [lo, hi] = RANGES[inst];
    bank.notes[inst] = [];
    for (let o = lo; o <= hi; o++) {
      for (const [n, pc] of Object.entries(NOTE_PCS)) {
        if (inst === 'pad' && o === 5 && pc > 0) continue;
        const midi = 12 * (o + 1) + pc;
        jobs.push(loadBuffer(ctx, new URL(`${inst}/${n}${o}.mp3`, BASE)).then((buf) => bank.notes[inst].push({ midi, buf })).catch(() => {}));
      }
    }
  }
  for (const d of ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'tom3']) {
    jobs.push(loadBuffer(ctx, new URL(`drums-${st.kit}/${d}.mp3`, BASE)).then((buf) => { bank.drums[d] = buf; }));
  }
  let done = 0;
  jobs.forEach((j) => j.then(() => onProgress(++done / jobs.length)));
  await Promise.all(jobs);
  for (const list of Object.values(bank.notes)) list.sort((a, b) => a.midi - b.midi);
  return bank;
}

// ---------- Mixer graph (built per context: live or offline) ----------
function impulse(ctx, seconds = 3.2, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let s = 12345;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) { s = (s * 16807) % 2147483647; d[i] = ((s / 2147483647) * 2 - 1) * Math.pow(1 - i / len, decay); }
  }
  return buf;
}

export const DEFAULT_MIX = { riff: 0.9, drums: 0.8, bass: 0.85, keys: 0.7, pad: 0.55 };
const REVERB_SEND = { riff: 0.12, drums: 0.08, bass: 0.0, keys: 0.3, pad: 0.45 };

export function buildMixer(ctx, destination, mix = DEFAULT_MIX) {
  const master = ctx.createGain(); master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
  master.connect(comp).connect(destination);
  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx);
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.6;
  verbIn.connect(verb).connect(master);
  const buses = {};
  for (const t of TRACKS) {
    const g = ctx.createGain(); g.gain.value = mix[t] ?? 0.8;
    g.connect(master);
    const send = ctx.createGain(); send.gain.value = REVERB_SEND[t];
    g.connect(send).connect(verbIn);
    buses[t] = g;
  }
  buses.fx = buses.drums;
  let noise = null;
  const noiseBuf = () => {
    if (noise) return noise;
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0); let s = 777;
    for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1; }
    return noise;
  };
  return { ctx, master, buses, noiseBuf };
}

// ---------- Playing one event ----------
function nearestSample(list, midi) {
  let best = list[0];
  for (const s of list) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  return best;
}

function playNote(mixer, bus, sample, midi, t, vel, durSec, sustained, stopList) {
  const ctx = mixer.ctx;
  const rate = Math.pow(2, (midi - sample.midi) / 12);
  const len = sample.buf.duration / rate;
  const release = sustained ? 0.6 : 0.25;
  const voice = (start, offset, fadeIn, end) => {
    const src = ctx.createBufferSource(); src.buffer = sample.buf; src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vel, start + fadeIn);
    g.gain.setValueAtTime(vel, Math.max(start + fadeIn, end - 0.001));
    g.gain.linearRampToValueAtTime(0, end + release);
    src.connect(g).connect(bus);
    src.start(start, offset);
    src.stop(Math.min(start + len - offset / rate, end + release + 0.05));
    stopList && stopList.push(src);
  };
  if (!sustained || durSec < len * 0.8) {
    voice(t, 0, sustained ? 0.25 : 0.003, t + Math.min(durSec, len - release));
    return;
  }
  // Long pad notes: chain crossfaded copies from the sample's steady middle.
  const seg = Math.max(0.8, len * 0.6), off = 0.5 * rate;
  voice(t, 0, 0.25, t + seg);
  for (let s = t + seg - 0.4; s < t + durSec - 0.2; s += seg - 0.4) voice(s, off, 0.4, Math.min(t + durSec, s + seg));
}

function playDrum(mixer, bank, e, t, stopList) {
  const ctx = mixer.ctx, bus = mixer.buses.drums;
  if (e.inst === 'crash' || e.inst === 'riser') {
    const src = ctx.createBufferSource(); src.buffer = mixer.noiseBuf(); src.loop = true;
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    if (e.inst === 'crash') {
      f.type = 'highpass'; f.frequency.value = 5500;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32 * e.vel, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
      src.start(t); src.stop(t + 2.3);
    } else {
      const d = e.durSec;
      f.type = 'bandpass'; f.Q.value = 2; f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(7000, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22 * e.vel, t + d); g.gain.linearRampToValueAtTime(0, t + d + 0.05);
      src.start(t); src.stop(t + d + 0.1);
    }
    src.connect(f).connect(g).connect(bus);
    stopList && stopList.push(src);
    return;
  }
  const buf = bank.drums[e.inst];
  if (!buf) return;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const g = ctx.createGain(); g.gain.value = 0.5 * e.vel * (e.inst === 'hihat' ? 0.7 : 1);
  src.connect(g).connect(bus);
  src.start(t);
  stopList && stopList.push(src);
}

function playRiffSlice(mixer, riff, e, t, spb, stopList) {
  const ctx = mixer.ctx, bt = riff.beatTimes, j = e.slice;
  const pre = 0.012; // start just before the beat so the strum's attack is kept
  const actual = bt[j + 1] - bt[j];
  const dur = e.ring ? 4 : Math.min(actual, spb * (e.dur || 1));
  const src = ctx.createBufferSource(); src.buffer = riff.buffer;
  const g = ctx.createGain();
  const start = Math.max(0, t - pre);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(e.vel, start + 0.004);
  g.gain.setValueAtTime(e.vel, start + pre + dur - 0.002);
  g.gain.linearRampToValueAtTime(0, start + pre + dur + (e.ring ? 1.5 : 0.025));
  src.connect(g).connect(mixer.buses.riff);
  src.start(start, Math.max(0, bt[j] - pre));
  src.stop(start + pre + dur + (e.ring ? 1.6 : 0.04));
  stopList && stopList.push(src);
}

export function playEvent(mixer, bank, riff, e, t, spb, stopList) {
  if (e.track === 'drums' || e.track === 'fx') return playDrum(mixer, bank, { ...e, durSec: e.dur * spb }, t, stopList);
  if (e.track === 'riff') { if (riff && riff.buffer) playRiffSlice(mixer, riff, e, t, spb, stopList); return; }
  const list = bank.notes[e.inst];
  if (!list || !list.length) return;
  const vel = e.vel * (e.track === 'pad' ? 0.6 : e.track === 'bass' ? 1.8 : 1.5);
  playNote(mixer, mixer.buses[e.track], nearestSample(list, e.midi), e.midi, t, vel, e.dur * spb, SUSTAINED.has(e.inst), stopList);
}

// ---------- Live player ----------
export class Player {
  constructor(ctx) {
    this.ctx = ctx;
    this.mix = { ...DEFAULT_MIX };
    this.playing = false;
    this.loop = null; // {start, end} in beats
    this.onBeat = () => {};
  }

  setSong(song, bank, riff) {
    this.stop();
    this.song = song; this.bank = bank; this.riff = riff;
    this.spb = 60 / song.bpm;
    this.position = 0;
  }

  setMix(track, v) {
    this.mix[track] = v;
    if (this.mixer) this.mixer.buses[track].gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  play(fromBeat = this.position) {
    if (!this.song) return;
    this.stop(false);
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.mixer = buildMixer(this.ctx, this.out, this.mix);
    this.sources = [];
    this.anchorBeat = fromBeat;
    this.anchorTime = this.ctx.currentTime + 0.1;
    this.idx = this.song.events.findIndex((e) => e.beat >= fromBeat - 1e-6);
    if (this.idx < 0) this.idx = this.song.events.length;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 25);
    this.pump();
  }

  beatAt(time) { return this.anchorBeat + (time - this.anchorTime) / this.spb; }
  timeAt(beat) { return this.anchorTime + (beat - this.anchorBeat) * this.spb; }

  pump() {
    const now = this.ctx.currentTime, horizon = now + 0.25;
    const evs = this.song.events;
    for (;;) {
      if (this.loop) {
        const next = this.idx < evs.length ? evs[this.idx] : null;
        if (!next || next.beat >= this.loop.end) {
          // Everything in the looped section is scheduled; wrap once the loop end comes into view.
          const endT = this.timeAt(this.loop.end);
          if (endT > horizon) break;
          this.anchorBeat = this.loop.start; this.anchorTime = endT;
          this.idx = evs.findIndex((e) => e.beat >= this.loop.start - 1e-6);
          continue;
        }
      }
      if (this.idx >= evs.length) break;
      const e = evs[this.idx], t = this.timeAt(e.beat);
      if (t > horizon) break;
      if (t >= now - 0.05) playEvent(this.mixer, this.bank, this.riff, e, Math.max(t, now), this.spb, this.sources);
      this.idx++;
    }
    if (this.sources.length > 400) this.sources = this.sources.slice(-200);
    let pos = this.beatAt(now);
    if (this.loop && pos < this.loop.start) pos += this.loop.end - this.loop.start; // just after a wrap
    this.position = Math.max(0, pos);
    if (!this.loop && this.position >= this.song.lengthBeats) { this.stop(); this.position = 0; }
    this.onBeat(this.position);
  }

  stop(reset = false) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.out) {
      const out = this.out, t = this.ctx.currentTime;
      out.gain.setTargetAtTime(0, t, 0.03);
      setTimeout(() => { try { out.disconnect(); } catch (e) { /* gone */ } }, 300);
    }
    this.out = null;
    this.playing = false;
    if (reset) this.position = 0;
  }

  setLoop(section) {
    this.loop = section ? { start: section.startBeat, end: section.startBeat + section.beats } : null;
    if (this.playing && this.loop) this.play(Math.max(this.loop.start, Math.min(this.position, this.loop.end - 0.01)));
  }
}

// ---------- Offline render and WAV export ----------
export async function renderSong(song, bank, riff, { mix = DEFAULT_MIX, only = null, sampleRate = 44100 } = {}) {
  const spb = 60 / song.bpm;
  const len = Math.ceil((song.lengthBeats * spb + 3) * sampleRate);
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const m = only ? Object.fromEntries(TRACKS.map((t) => [t, t === only ? 1 : 0])) : mix;
  const mixer = buildMixer(ctx, ctx.destination, m);
  for (const e of song.events) {
    if (only && e.track !== only && !(only === 'drums' && e.track === 'fx')) continue;
    playEvent(mixer, bank, riff, e, 0.05 + e.beat * spb, spb, null);
  }
  return ctx.startRendering();
}

export function wavBlob(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([data], { type: 'audio/wav' });
}
