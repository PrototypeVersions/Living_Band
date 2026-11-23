// Living Band — the sound: pad, bass and sparkle layers built from Web Audio oscillators.
import { midiToFreq, voiceLead } from './dsp.js';

function makeImpulse(ctx, seconds = 4.5, decay = 2.8) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export class Band {
  constructor(ctx, destination) {
    this.ctx = ctx;
    const t = ctx.currentTime;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.3;
    this.master.connect(comp).connect(destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.reverb.connect(this.wet).connect(this.master);

    // --- Pad: 4 voices x 2 detuned saws, through a slowly breathing low-pass filter.
    this.padBus = ctx.createGain(); this.padBus.gain.value = 0;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 1200; this.padFilter.Q.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 250;
    lfo.connect(lfoAmt).connect(this.padFilter.frequency); lfo.start(t);
    this.padBus.connect(this.padFilter);
    this.padFilter.connect(this.master);
    this.padFilter.connect(this.reverb);

    this.voiceNotes = [52, 55, 59, 64];
    this.voices = this.voiceNotes.map((m, i) => {
      const g = ctx.createGain(); g.gain.value = 0.18;
      const oscs = [-7, 7].map((cents) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = midiToFreq(m); o.detune.value = cents + (i - 1.5) * 2;
        o.connect(g); o.start(t); return o;
      });
      g.connect(this.padBus);
      return { g, oscs };
    });

    // --- Bass: sine + soft triangle, low-passed.
    this.bassBus = ctx.createGain(); this.bassBus.gain.value = 0;
    const bassLp = ctx.createBiquadFilter(); bassLp.type = 'lowpass'; bassLp.frequency.value = 380;
    this.bassEnv = ctx.createGain(); this.bassEnv.gain.value = 0;
    this.bassOscs = ['sine', 'triangle'].map((type, i) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = 55;
      const g = ctx.createGain(); g.gain.value = i === 0 ? 0.8 : 0.35;
      o.connect(g).connect(this.bassEnv); o.start(t); return o;
    });
    this.bassEnv.connect(bassLp).connect(this.bassBus);
    this.bassBus.connect(this.master);
    const bassSend = ctx.createGain(); bassSend.gain.value = 0.15;
    this.bassBus.connect(bassSend).connect(this.reverb);
    this.bassMidi = null;

    // --- Sparkle bus: short bell notes, mostly reverb.
    this.sparkleBus = ctx.createGain(); this.sparkleBus.gain.value = 0.5;
    const sparkleDry = ctx.createGain(); sparkleDry.gain.value = 0.35;
    this.sparkleBus.connect(sparkleDry).connect(this.master);
    this.sparkleBus.connect(this.reverb);

    this.chordLabel = null;
    this.pcs = null;
    this.levels = { pad: 0, bass: 0 };
  }

  setVolume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  /** Move the pad (and bass, unless the groove is driving it) to a chord, now or at time `at`. */
  setChord(chord, at = null, { bass = true } = {}) {
    if (!chord || chord.label === this.chordLabel) return;
    const t = Math.max(at ?? 0, this.ctx.currentTime);
    this.chordLabel = chord.label;
    this.pcs = chord.pcs;
    this.voiceNotes = voiceLead(this.voiceNotes, chord.pcs, 48, 76);
    this.voiceNotes.forEach((m, i) => {
      for (const o of this.voices[i].oscs) o.frequency.setTargetAtTime(midiToFreq(m), t, 0.035);
    });
    this.root = chord.root;
    if (bass) this.bassNote(Band.bassMidiFor(chord.root), t, 1.0, null);
  }

  /** Root placed between A1 and G#2. */
  static bassMidiFor(pc, offset = 0) { return 33 + ((pc + offset - 33) % 12 + 12) % 12; }

  /** Bass note at time t. sustain = seconds before it fades a little, or null to hold. */
  bassNote(midi, t, vel = 1, sustain = null) {
    this.bassMidi = midi;
    for (const o of this.bassOscs) o.frequency.setTargetAtTime(midiToFreq(midi), t, 0.012);
    const env = this.bassEnv.gain;
    env.cancelScheduledValues(t);
    env.setTargetAtTime(0.15, t, 0.008);
    env.setTargetAtTime(vel, t + 0.02, 0.02);
    if (sustain !== null) env.setTargetAtTime(vel * 0.45, t + sustain, 0.15);
  }

  // ---------- Drums (synthesized) ----------
  initDrums() {
    if (this.drumBus) return;
    const ctx = this.ctx;
    this.drumBus = ctx.createGain(); this.drumBus.gain.value = 0;
    this.drumBus.connect(this.master);
    const send = ctx.createGain(); send.gain.value = 0.12;
    this.drumBus.connect(send).connect(this.reverb);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setDrumLevel(v) { this.initDrums(); this.drumBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.3); }

  kick(t, v = 1) {
    this.initDrums();
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(this.drumBus); o.start(t); o.stop(t + 0.5);
  }

  noiseHit(t, v, { type = 'highpass', freq = 7000, q = 0.7, decay = 0.05, gain = 0.3 } = {}) {
    this.initDrums();
    const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay * 5);
    src.connect(f).connect(g).connect(this.drumBus);
    src.start(t, Math.random() * 0.5); src.stop(t + decay * 5 + 0.05);
  }

  snare(t, v = 1, soft = false) {
    this.noiseHit(t, v, soft
      ? { type: 'bandpass', freq: 2500, q: 0.6, decay: 0.06, gain: 0.25 }
      : { type: 'bandpass', freq: 1900, q: 0.8, decay: 0.045, gain: 0.55 });
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 190;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime((soft ? 0.12 : 0.3) * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.drumBus); o.start(t); o.stop(t + 0.15);
  }

  hat(t, v = 1) { this.noiseHit(t, v, { type: 'highpass', freq: 8000, decay: 0.018, gain: 0.22 }); }
  shaker(t, v = 1) { this.noiseHit(t, v, { type: 'bandpass', freq: 6500, q: 1.2, decay: 0.03, gain: 0.16 }); }
  swell(t, dur = 1.5, v = 1) {
    // soft cymbal swell into the downbeat when the band locks in
    this.initDrums();
    const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; src.loop = true;
    f.type = 'highpass'; f.frequency.value = 5000;
    g.gain.setValueAtTime(0.0001, t - dur);
    g.gain.exponentialRampToValueAtTime(0.12 * v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
    src.connect(f).connect(g).connect(this.drumBus);
    src.start(Math.max(ctx.currentTime, t - dur)); src.stop(t + 1.6);
  }

  sparkleNote() {
    if (!this.pcs) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.01;
    const pc = this.pcs[Math.floor(Math.random() * this.pcs.length)];
    const m = 72 + ((pc - 72) % 12 + 12) % 12 + (Math.random() < 0.35 ? 12 : 0);
    const f = midiToFreq(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 3);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.4 - 0.7; g.connect(pan).connect(this.sparkleBus); }
    else g.connect(this.sparkleBus);
    [[1, 1], [2.76, 0.25], [5.4, 0.08]].forEach(([ratio, amp]) => {
      const o = ctx.createOscillator(); o.frequency.value = f * ratio;
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og).connect(g); o.start(t); o.stop(t + 3.1);
    });
  }

  /** Apply one conductor decision. dt = seconds since the last call. */
  apply(decision, personality, dt, { chords = true } = {}) {
    const t = this.ctx.currentTime;
    if (chords && decision.chord) this.setChord(decision.chord);
    this.padBus.gain.setTargetAtTime(decision.pad * 0.9, t, 0.8);
    this.bassBus.gain.setTargetAtTime(decision.bass * 0.9, t, 0.6);
    this.padFilter.frequency.setTargetAtTime(500 + decision.brightness * 2600, t, 1.0);
    this.wet.gain.setTargetAtTime(personality.reverb, t, 0.5);
    if (decision.sparkle > 0 && Math.random() < decision.sparkle * dt) this.sparkleNote();
    this.levels = { pad: decision.pad, bass: decision.bass };
  }
}
