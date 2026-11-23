// Collects input audio in chunks and posts them to the page while recording.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = e.data === 'start'; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('living-band-recorder', RecorderProcessor);
