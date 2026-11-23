// Living Band — MIDI foot control (e.g. Tone Master Pro footswitches sending CC or Program Change).

const STORE_KEY = 'livingband.midiMap';

export class MidiControl {
  constructor(onAction, onMessage) {
    this.onAction = onAction;   // (actionName) => void
    this.onMessage = onMessage; // (text) => void, for the activity display
    this.map = {};              // "cc:0:80:on" style key -> action
    this.learning = null;
    try { this.map = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { this.map = {}; }
  }

  async init() {
    if (!navigator.requestMIDIAccess) return 'This browser has no Web MIDI. Use Chrome or Edge.';
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (e) {
      return 'MIDI permission was refused.';
    }
    const attach = () => {
      for (const input of this.access.inputs.values()) input.onmidimessage = (ev) => this.handle(ev, input.name);
    };
    attach();
    this.access.onstatechange = attach;
    const names = [...this.access.inputs.values()].map((i) => i.name);
    return names.length ? 'MIDI inputs: ' + names.join(', ') : 'No MIDI inputs found yet (connect and they will appear).';
  }

  keyFor(data) {
    const [status, d1, d2] = data;
    const type = status & 0xf0, chan = (status & 0x0f) + 1;
    if (type === 0xb0) return { key: `cc:${chan}:${d1}:${d2 >= 64 ? 'on' : 'off'}`, text: `CC ${d1} = ${d2} (ch ${chan})` };
    if (type === 0xc0) return { key: `pc:${chan}:${d1}`, text: `Program Change ${d1} (ch ${chan})` };
    if (type === 0x90 && d2 > 0) return { key: `note:${chan}:${d1}`, text: `Note ${d1} (ch ${chan})` };
    return null;
  }

  handle(ev, from) {
    const k = this.keyFor(ev.data);
    if (!k) return;
    this.onMessage && this.onMessage(`${from}: ${k.text}`);
    if (this.learning) {
      // Learn on "on" messages only, so a momentary switch's release doesn't overwrite.
      if (k.key.endsWith(':off')) return;
      for (const existing of Object.keys(this.map)) if (this.map[existing] === this.learning) delete this.map[existing];
      this.map[k.key] = this.learning;
      const done = this.learning;
      this.learning = null;
      this.save();
      this.onAction('learned:' + done);
      return;
    }
    const action = this.map[k.key];
    if (action) this.onAction(action);
  }

  learn(action) { this.learning = action; }

  bindingFor(action) {
    return Object.keys(this.map).find((k) => this.map[k] === action) || null;
  }

  save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.map)); } catch (e) { /* storage unavailable */ } }
}
