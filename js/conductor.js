// Living Band — the band's musical decisions. Pure logic: takes what was heard, returns what to play.

export const PERSONALITIES = {
  heavenly: {
    name: 'Heavenly',
    blurb: 'Ambient and spacious: bright pads, soft bass, bell-like sparkles.',
    rampIn: 6, pad: 0.55, bass: 0.35, sparkle: 0.3, brightness: 0.9, reverb: 0.6,
    developAfter: 5, chordSeconds: 7, restAfter: 45,
  },
  minimalist: {
    name: 'Minimalist',
    blurb: 'Listens more than it plays. Quiet pad, very little movement.',
    rampIn: 10, pad: 0.35, bass: 0.15, sparkle: 0.06, brightness: 0.45, reverb: 0.4,
    developAfter: 9, chordSeconds: 12, restAfter: 30,
  },
  deep: {
    name: 'Deep',
    blurb: 'Dark and warm: low pad, fuller bass, no sparkles.',
    rampIn: 5, pad: 0.5, bass: 0.6, sparkle: 0, brightness: 0.3, reverb: 0.45,
    developAfter: 6, chordSeconds: 8, restAfter: 45,
  },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export class Conductor {
  constructor(personality = 'heavenly') {
    this.setPersonality(personality);
    this.engagement = 0;     // 0..1, how far the band has "come in"
    this.lastPlaying = -Infinity;
    this.lastTime = null;
    this.history = [];       // distinct chords the player held for a while
    this.devIndex = -1;
    this.devNextAt = 0;
    this.lastHeard = null;
    this.heardSince = 0;
    this.hold = false;
    this.enabled = true;
    this.out = { mode: 'waiting', chord: null, pad: 0, bass: 0, sparkle: 0, brightness: 0.5 };
  }

  setPersonality(key) {
    this.key = PERSONALITIES[key] ? key : 'heavenly';
    this.p = PERSONALITIES[this.key];
  }

  /**
   * input: { now (s), playing (bool), chord (tracked chord or null), density (attacks/s) }
   * returns: { mode, chord, pad, bass, sparkle, brightness } with levels 0..1
   */
  update({ now, playing, chord, density = 0 }) {
    const dt = this.lastTime === null ? 0 : Math.min(0.25, now - this.lastTime);
    this.lastTime = now;
    const p = this.p;

    if (!this.enabled) {
      this.engagement = 0;
      return (this.out = { mode: 'off', chord: null, pad: 0, bass: 0, sparkle: 0, brightness: p.brightness });
    }
    if (this.hold) return (this.out = { ...this.out, mode: 'holding' });

    if (playing) this.lastPlaying = now;
    const silentFor = now - this.lastPlaying;

    // Remember chords the player actually stayed on (≥1.5 s) for later development.
    if (chord && (!this.lastHeard || chord.label !== this.lastHeard.label)) {
      this.lastHeard = chord; this.heardSince = now;
    }
    if (this.lastHeard && now - this.heardSince >= 1.5) {
      const last = this.history[this.history.length - 1];
      if (!last || last.label !== this.lastHeard.label) {
        this.history.push(this.lastHeard);
        if (this.history.length > 6) this.history.shift();
      }
    }

    let mode, playChord = this.out.chord, pad = p.pad, bass = p.bass, sparkle = p.sparkle, brightness = p.brightness;

    if (playing && chord) {
      this.engagement = clamp01(this.engagement + dt / p.rampIn);
      playChord = chord;
      this.devIndex = -1;
      if (density > 3.5) {
        mode = 'making room';          // busy lead playing: back off
        pad *= 0.45; bass *= 0.7; sparkle = 0; brightness *= 0.6;
      } else {
        mode = 'following';
        if (density > 1.8) sparkle *= 0.3;
      }
    } else if (playing) {
      mode = this.out.chord ? 'following' : 'listening';
      this.engagement = clamp01(this.engagement + dt / (p.rampIn * 3));
    } else if (!this.out.chord) {
      mode = 'waiting';
      this.engagement = clamp01(this.engagement - dt / 10);
    } else if (silentFor < p.developAfter) {
      mode = 'sustaining';
    } else if (silentFor < p.developAfter + p.restAfter) {
      mode = 'developing';
      sparkle *= 1.5;
      // Walk through the player's recent chords, as an echo of their own progression.
      if (this.devIndex === -1) {
        // Just started developing: the last chord heard is current; loop round from there.
        this.devIndex = this.history.length - 1;
        this.devNextAt = now + p.chordSeconds * 0.5;
      }
      if (this.history.length > 1 && now >= this.devNextAt) {
        this.devIndex = (this.devIndex + 1) % this.history.length;
        playChord = this.history[this.devIndex];
        this.devNextAt = now + p.chordSeconds;
      }
    } else {
      mode = 'resting';
      this.engagement = clamp01(this.engagement - dt / 10);
      sparkle *= 0.3;
    }

    const e = this.engagement;
    pad *= e;
    // Bass waits until the band is halfway in.
    bass *= clamp01((e - 0.5) * 2);
    sparkle *= e;
    return (this.out = { mode, chord: playChord, pad, bass, sparkle, brightness });
  }
}
