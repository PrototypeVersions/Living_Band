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

  setChord(chord) {
    if (!chord || chord.label === this.chordLabel) return;
    const t = this.ctx.currentTime;
    this.chordLabel = chord.label;
    this.pcs = chord.pcs;
    this.voiceNotes = voiceLead(this.voiceNotes, chord.pcs, 48, 76);
    this.voiceNotes.forEach((m, i) => {
      for (const o of this.voices[i].oscs) o.frequency.setTargetAtTime(midiToFreq(m), t, 0.035);
    });
    // Bass: root, placed between A1 and G#2, with a soft re-attack.
    let b = 33 + ((chord.root - 33) % 12 + 12) % 12;
    this.bassMidi = b;
    for (const o of this.bassOscs) o.frequency.setTargetAtTime(midiToFreq(b), t, 0.03);
    const env = this.bassEnv.gain;
    env.cancelScheduledValues(t);
    env.setTargetAtTime(0.25, t, 0.03);
    env.setTargetAtTime(1.0, t + 0.12, 0.15);
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
  apply(decision, personality, dt) {
    const t = this.ctx.currentTime;
    if (decision.chord) this.setChord(decision.chord);
    this.padBus.gain.setTargetAtTime(decision.pad * 0.9, t, 0.8);
    this.bassBus.gain.setTargetAtTime(decision.bass * 0.9, t, 0.6);
    this.padFilter.frequency.setTargetAtTime(500 + decision.brightness * 2600, t, 1.0);
    this.wet.gain.setTargetAtTime(personality.reverb, t, 0.5);
    if (decision.sparkle > 0 && Math.random() < decision.sparkle * dt) this.sparkleNote();
    this.levels = { pad: decision.pad, bass: decision.bass };
  }
}
