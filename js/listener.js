// Living Band — audio input: device and channel selection, analysis taps, and a built-in demo guitar.
import { midiToFreq } from './dsp.js';

export const PITCH_FFT = 16384;  // fine frequency detail for chords (about a third of a second)
export const ONSET_FFT = 2048;   // fast detail for note attacks and level

export class Listener {
  constructor(ctx) {
    this.ctx = ctx;
    this.inputGain = ctx.createGain();
    this.pitchAnalyser = ctx.createAnalyser();
    this.pitchAnalyser.fftSize = PITCH_FFT;
    this.pitchAnalyser.smoothingTimeConstant = 0;
    this.onsetAnalyser = ctx.createAnalyser();
    this.onsetAnalyser.fftSize = ONSET_FFT;
    this.onsetAnalyser.smoothingTimeConstant = 0;
    this.inputGain.connect(this.pitchAnalyser);
    this.inputGain.connect(this.onsetAnalyser);

    this.pitchDb = new Float32Array(PITCH_FFT / 2);
    this.pitchMag = new Float32Array(PITCH_FFT / 2);
    this.onsetDb = new Float32Array(ONSET_FFT / 2);
    this.onsetMag = new Float32Array(ONSET_FFT / 2);
    this.timeData = new Float32Array(ONSET_FFT);

    this.stream = null;
    this.source = null;
    this.splitter = null;
    this.channelCount = 0;
    this.channel = 0;
    this.demo = null;
  }

  static async listInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  static async listOutputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput');
  }

  /** Open an input device and ask for as many channels as it offers. Returns the channel count the browser gave us. */
  async open(deviceId) {
    this.stopDemo();
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: 8 },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        latency: { ideal: 0.005 },
      },
    });
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.channelCount = settings.channelCount || this.source.channelCount || 2;
    this.trackLabel = track.label;
    this.splitter = this.ctx.createChannelSplitter(Math.max(this.channelCount, 2));
    this.source.connect(this.splitter);
    this.selectChannel(Math.min(this.channel, this.channelCount - 1));
    return this.channelCount;
  }

  /** ch = channel index (0-based), or 'mix' for all channels together. */
  selectChannel(ch) {
    if (!this.splitter) return;
    try { this.splitter.disconnect(); } catch (e) { /* not connected yet */ }
    this.channel = ch;
    if (ch === 'mix') {
      for (let i = 0; i < Math.max(this.channelCount, 2); i++) this.splitter.connect(this.inputGain, i);
    } else {
      this.splitter.connect(this.inputGain, ch);
    }
  }

  close() {
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    try { this.source && this.source.disconnect(); } catch (e) { /* ignore */ }
    try { this.splitter && this.splitter.disconnect(); } catch (e) { /* ignore */ }
    this.stream = this.source = this.splitter = null;
    this.channelCount = 0;
  }

  /** Read both analysers. Returns linear magnitudes and the input level (dBFS). */
  read() {
    this.pitchAnalyser.getFloatFrequencyData(this.pitchDb);
    for (let i = 0; i < this.pitchDb.length; i++) this.pitchMag[i] = Math.pow(10, this.pitchDb[i] / 20);
    this.onsetAnalyser.getFloatFrequencyData(this.onsetDb);
    for (let i = 0; i < this.onsetDb.length; i++) this.onsetMag[i] = Math.pow(10, this.onsetDb[i] / 20);
    this.onsetAnalyser.getFloatTimeDomainData(this.timeData);
    let s = 0;
    for (const x of this.timeData) s += x * x;
    const rms = Math.sqrt(s / this.timeData.length);
    return { pitchMag: this.pitchMag, onsetMag: this.onsetMag, levelDb: 20 * Math.log10(rms + 1e-9) };
  }

  // ---------- Demo guitar: lets you try everything without plugging in ----------

  /**
   * Plays a strummed chord loop into the analysis (and quietly to `audible`, if given),
   * then a long gap so you can hear the band carry on alone.
   */
  startDemo(audible) {
    this.close();
    this.stopDemo();
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.inputGain);
    let monitor = null;
    if (audible) { monitor = ctx.createGain(); monitor.gain.value = 0.35; bus.connect(monitor).connect(audible); }

    const real = new Float32Array(16), imag = new Float32Array(16);
    for (let n = 1; n < 16; n++) imag[n] = 1 / Math.pow(n, 1.3) * (n % 7 === 0 ? 0.3 : 1);
    const wave = ctx.createPeriodicWave(real, imag);

    // E minor, C, G, D — standard open voicings (MIDI notes, low to high)
    const chords = [
      [40, 47, 52, 55, 59, 64],
      [48, 52, 55, 60, 64],
      [43, 47, 50, 55, 59, 67],
      [50, 57, 62, 66],
    ];
    const strum = (notes, at) => {
      notes.forEach((m, i) => {
        const t = at + i * 0.018;
        const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = midiToFreq(m);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.09, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.002, t + 3.6);
        o.connect(g).connect(bus); o.start(t); o.stop(t + 3.7);
      });
    };
    const barSeconds = 4;
    let next = ctx.currentTime + 0.1;
    let step = 0;
    const cycle = chords.length * 2 + 4; // 2 bars per chord, then 4 bars of silence
    const schedule = () => {
      while (next < ctx.currentTime + 1.0) {
        const pos = step % cycle;
        if (pos < chords.length * 2) {
          const ch = chords[Math.floor(pos / 2)];
          strum(ch, next);
          strum(ch, next + barSeconds / 2);
        }
        next += barSeconds;
        step++;
      }
    };
    schedule();
    const timer = setInterval(schedule, 250);
    this.demo = { bus, monitor, timer };
    this.channelCount = 1;
    this.trackLabel = 'Demo guitar';
  }

  stopDemo() {
    if (!this.demo) return;
    clearInterval(this.demo.timer);
    try { this.demo.bus.disconnect(); } catch (e) { /* ignore */ }
    try { this.demo.monitor && this.demo.monitor.disconnect(); } catch (e) { /* ignore */ }
    this.demo = null;
  }
}
