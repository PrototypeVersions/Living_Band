// Living Band — recording your riff: input device, channel choice, level meter, capture.

export class Recorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 2048;
    this.input.connect(this.meter);
    this.meterData = new Float32Array(2048);
    this.channel = 0; this.channelCount = 0;
  }

  async init() {
    if (this.node) return;
    await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'living-band-recorder', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    this.input.connect(this.node);
    this.chunks = [];
    this.node.port.onmessage = (e) => { if (this.recording) this.chunks.push(e.data); };
  }

  static async inputs() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  }

  async open(deviceId) {
    await this.init();
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { ideal: 8 },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const track = this.stream.getAudioTracks()[0];
    this.label = track.label;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.channelCount = (track.getSettings && track.getSettings().channelCount) || this.source.channelCount || 2;
    this.splitter = this.ctx.createChannelSplitter(Math.max(2, this.channelCount));
    this.source.connect(this.splitter);
    this.selectChannel(Math.min(this.channel, this.channelCount - 1));
    return this.channelCount;
  }

  selectChannel(ch) {
    if (!this.splitter) return;
    try { this.splitter.disconnect(); } catch (e) { /* not connected */ }
    this.channel = ch;
    this.splitter.connect(this.input, ch);
  }

  close() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    try { this.source && this.source.disconnect(); } catch (e) { /* ignore */ }
    this.stream = this.source = this.splitter = null;
  }

  levelDb() {
    this.meter.getFloatTimeDomainData(this.meterData);
    let s = 0;
    for (const v of this.meterData) s += v * v;
    return 20 * Math.log10(Math.sqrt(s / this.meterData.length) + 1e-9);
  }

  start() { this.chunks = []; this.recording = true; this.node.port.postMessage('start'); this.startedAt = this.ctx.currentTime; }

  /** Stop and return the recording as one Float32Array (mono, at the context's sample rate). */
  stop() {
    this.recording = false;
    this.node.port.postMessage('stop');
    const n = this.chunks.reduce((a, c) => a + c.length, 0), out = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    return out;
  }
}
