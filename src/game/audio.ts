import type { WeaponId } from "./types";

type Range = number | [number, number];

type ClipPlaybackOptions = {
  gain?: Range;
  rate?: Range;
  detune?: Range;
  delay?: number;
  highpass?: number;
  lowpass?: number;
  pan?: Range;
  attack?: number;
  release?: number;
  stopAfter?: number;
};

const SHOT_CORE: Record<WeaponId, string[]> = {
  assaultRifle: ["shot_rifle_01", "shot_heavy_01"],
  shotgun: ["shot_boom_01", "shot_heavy_01"],
  pistol: ["shot_pistol_01", "shot_rifle_01"],
};

const SHOT_TAIL = ["shot_tail_01", "shot_tail_02", "shot_tail_03", "shot_tail_04"];
const STEP_CLIPS = ["step_01", "step_02", "step_03"];
const BODY_HIT_CLIPS = ["body_hit_01", "body_hit_02"];
const IMPACT_CLIPS = ["bullet_impact_01", "bullet_impact_02"];

export class TacticalAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private loadingPromise: Promise<void> | null = null;

  private readonly clipPaths: Record<string, string> = {
    shot_boom_01: "/assets/audio/weapons/shot_boom_01.wav",
    shot_heavy_01: "/assets/audio/weapons/shot_heavy_01.wav",
    shot_pistol_01: "/assets/audio/weapons/shot_pistol_01.wav",
    shot_rifle_01: "/assets/audio/weapons/shot_rifle_01.wav",
    shot_tail_01: "/assets/audio/weapons/shot_tail_01.ogg",
    shot_tail_02: "/assets/audio/weapons/shot_tail_02.ogg",
    shot_tail_03: "/assets/audio/weapons/shot_tail_03.ogg",
    shot_tail_04: "/assets/audio/weapons/shot_tail_04.ogg",
    body_hit_01: "/assets/audio/impacts/body_hit_01.ogg",
    body_hit_02: "/assets/audio/impacts/body_hit_02.ogg",
    bullet_impact_01: "/assets/audio/impacts/bullet_impact_01.ogg",
    bullet_impact_02: "/assets/audio/impacts/bullet_impact_02.ogg",
    reload_01: "/assets/audio/foley/reload_01.ogg",
    reload_02: "/assets/audio/foley/reload_02.ogg",
    reload_03: "/assets/audio/foley/reload_03.ogg",
    step_01: "/assets/audio/foley/step_01.ogg",
    step_02: "/assets/audio/foley/step_02.ogg",
    step_03: "/assets/audio/foley/step_03.ogg",
    step_04: "/assets/audio/foley/step_04.ogg",
    death_01: "/assets/audio/ui/death_01.ogg",
    round_bell_01: "/assets/audio/ui/round_bell_01.ogg",
  };

  unlock(): void {
    if (typeof window === "undefined") {
      return;
    }

    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.24;

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 16;
      compressor.ratio.value = 3.2;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.22;

      this.bus = this.ctx.createGain();
      this.bus.gain.value = 1;

      this.bus.connect(compressor);
      compressor.connect(this.master);
      this.master.connect(this.ctx.destination);

      this.noiseBuffer = this.createNoiseBuffer(this.ctx);
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.loadClips();
    }
  }

  setMasterVolume(volume: number): void {
    if (!this.master) {
      return;
    }

    this.master.gain.value = clamp(volume, 0, 1);
  }

  playShot(weaponId: WeaponId): void {
    const core = SHOT_CORE[weaponId];
    const hasSamples = core.some((id) => this.buffers.has(id));

    if (!hasSamples) {
      this.playProceduralShot(weaponId);
      return;
    }

    this.playRandom(core, {
      gain:
        weaponId === "shotgun"
          ? [0.52, 0.65]
          : weaponId === "pistol"
            ? [0.36, 0.48]
            : [0.43, 0.58],
      rate:
        weaponId === "shotgun"
          ? [0.88, 0.98]
          : weaponId === "pistol"
            ? [1.06, 1.17]
            : [0.95, 1.06],
      detune: [-80, 80],
      lowpass: weaponId === "shotgun" ? 4200 : 5600,
      pan: [-0.08, 0.08],
      attack: 0.002,
      release: weaponId === "shotgun" ? 0.08 : 0.055,
      stopAfter:
        weaponId === "shotgun"
          ? 0.2
          : weaponId === "pistol"
            ? 0.13
            : 0.16,
    });

    this.playRandom(SHOT_TAIL, {
      delay: weaponId === "shotgun" ? 0.028 : 0.02,
      gain: weaponId === "shotgun" ? [0.17, 0.24] : [0.13, 0.19],
      rate: [0.92, 1.07],
      highpass: 360,
      pan: [-0.12, 0.12],
      attack: 0.004,
      release: 0.07,
      stopAfter: weaponId === "shotgun" ? 0.17 : 0.13,
    });
  }

  playFootstep(speedScale: number): void {
    const hasSamples = STEP_CLIPS.some((id) => this.buffers.has(id));
    if (!hasSamples) {
      this.playProceduralStep(speedScale);
      return;
    }

    const speed = clamp(speedScale, 0, 1.5);
    this.playRandom(STEP_CLIPS, {
      gain: [0.028 + speed * 0.02, 0.045 + speed * 0.03],
      rate: [0.8 + speed * 0.04, 0.9 + speed * 0.07],
      detune: [-60, 40],
      highpass: 28,
      lowpass: 980,
      pan: [-0.05, 0.05],
      attack: 0.003,
      release: 0.05,
      stopAfter: 0.1,
    });

    this.playFootstepThump(speedScale);
  }

  playHit(isHeadshot: boolean): void {
    const hasSamples =
      BODY_HIT_CLIPS.some((id) => this.buffers.has(id)) &&
      IMPACT_CLIPS.some((id) => this.buffers.has(id));

    if (!hasSamples) {
      this.playProceduralHit(isHeadshot);
      return;
    }

    this.playRandom(BODY_HIT_CLIPS, {
      gain: isHeadshot ? [0.23, 0.3] : [0.12, 0.2],
      rate: isHeadshot ? [1.03, 1.14] : [0.94, 1.04],
      lowpass: isHeadshot ? 5800 : 4600,
      pan: [-0.1, 0.1],
    });

    this.playRandom(IMPACT_CLIPS, {
      delay: 0.012,
      gain: isHeadshot ? [0.08, 0.12] : [0.06, 0.1],
      rate: isHeadshot ? [1.12, 1.2] : [0.96, 1.06],
      highpass: 900,
      pan: [-0.08, 0.08],
    });
  }

  playReload(): void {
    const hasSamples =
      this.buffers.has("reload_01") &&
      this.buffers.has("reload_02") &&
      this.buffers.has("reload_03");

    if (!hasSamples) {
      this.playProceduralReload();
      return;
    }

    this.playClip("reload_01", {
      gain: [0.09, 0.14],
      rate: [0.97, 1.06],
      pan: [-0.08, 0],
    });
    this.playClip("reload_02", {
      delay: 0.12,
      gain: [0.08, 0.13],
      rate: [0.94, 1.02],
      pan: [0, 0.08],
    });
    this.playClip("reload_03", {
      delay: 0.24,
      gain: [0.06, 0.1],
      rate: [1.02, 1.12],
      highpass: 700,
      pan: [-0.03, 0.03],
    });
  }

  playDeath(): void {
    if (!this.playClip("death_01", { gain: [0.16, 0.24], rate: [0.88, 0.98] })) {
      this.playProceduralDeath();
    }
  }

  playRoundBell(): void {
    if (
      !this.playClip("round_bell_01", {
        gain: [0.1, 0.15],
        rate: [0.97, 1.03],
        highpass: 220,
      })
    ) {
      this.playProceduralRoundBell();
    }
  }

  private async loadClips(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    const jobs = Object.entries(this.clipPaths).map(async ([id, path]) => {
      try {
        const response = await fetch(path, { cache: "force-cache" });
        if (!response.ok) {
          return;
        }

        const payload = await response.arrayBuffer();
        const decoded = await ctx.decodeAudioData(payload.slice(0));
        this.buffers.set(id, decoded);
      } catch {
        // Best effort: leave clip absent and fall back to procedural sound.
      }
    });

    await Promise.all(jobs);
  }

  private playRandom(ids: string[], options: ClipPlaybackOptions = {}): boolean {
    if (ids.length === 0) {
      return false;
    }

    const id = ids[Math.floor(Math.random() * ids.length)];
    return this.playClip(id, options);
  }

  private playClip(id: string, options: ClipPlaybackOptions = {}): boolean {
    const ctx = this.ctx;
    const bus = this.bus;
    const buffer = this.buffers.get(id);

    if (!ctx || !bus || !buffer) {
      return false;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = resolveRange(options.rate, 1);
    source.detune.value = resolveRange(options.detune, 0);

    let current: AudioNode = source;

    if (options.highpass !== undefined) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = options.highpass;
      current.connect(highpass);
      current = highpass;
    }

    if (options.lowpass !== undefined) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = options.lowpass;
      current.connect(lowpass);
      current = lowpass;
    }

    if (options.pan !== undefined) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = resolveRange(options.pan, 0);
      current.connect(panner);
      current = panner;
    }

    const gain = ctx.createGain();
    const targetGain = resolveRange(options.gain, 1);
    const now = ctx.currentTime;
    const startAt = now + (options.delay ?? 0);
    const attack = Math.max(0.001, options.attack ?? 0.003);
    const release = Math.max(0.008, options.release ?? 0.03);
    const stopAfter = options.stopAfter;

    if (stopAfter !== undefined && stopAfter > release + attack) {
      const fadeStart = startAt + stopAfter - release;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.00012, targetGain), startAt + attack);
      gain.gain.setValueAtTime(Math.max(0.00012, targetGain), fadeStart);
      gain.gain.exponentialRampToValueAtTime(0.0001, fadeStart + release);
    } else {
      gain.gain.value = targetGain;
    }

    current.connect(gain);
    gain.connect(bus);

    source.start(startAt);
    if (stopAfter !== undefined && stopAfter > 0.01) {
      source.stop(startAt + stopAfter + 0.01);
    }
    return true;
  }

  private playProceduralShot(weaponId: WeaponId): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus || !this.noiseBuffer) {
      return;
    }

    const now = ctx.currentTime;
    const tone = ctx.createOscillator();
    const toneGain = ctx.createGain();
    const noise = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    tone.type = "triangle";
    tone.frequency.value =
      weaponId === "shotgun" ? 95 : weaponId === "pistol" ? 165 : 122;
    tone.frequency.exponentialRampToValueAtTime(70, now + 0.1);

    toneGain.gain.setValueAtTime(0.0001, now);
    toneGain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

    noise.buffer = this.noiseBuffer;
    filter.type = "highpass";
    filter.frequency.value = weaponId === "shotgun" ? 760 : 1200;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.17, now + 0.005);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    tone.connect(toneGain);
    toneGain.connect(bus);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(bus);

    tone.start(now);
    tone.stop(now + 0.13);
    noise.start(now);
    noise.stop(now + 0.09);
  }

  private playProceduralStep(speedScale: number): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus || !this.noiseBuffer) {
      return;
    }

    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    const highpass = ctx.createBiquadFilter();
    const lowpass = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    noise.buffer = this.noiseBuffer;
    highpass.type = "highpass";
    highpass.frequency.value = 36;
    lowpass.type = "lowpass";
    lowpass.frequency.value = 760 + clamp(speedScale, 0, 1.5) * 120;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    noise.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(gain);
    gain.connect(bus);

    noise.start(now);
    noise.stop(now + 0.09);

    this.playFootstepThump(speedScale);
  }

  private playFootstepThump(speedScale: number): void {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) {
      return;
    }

    const speed = clamp(speedScale, 0, 1.5);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = 72 + speed * 18;
    osc.frequency.exponentialRampToValueAtTime(48 + speed * 10, now + 0.08);

    filter.type = "lowpass";
    filter.frequency.value = 220;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.022 + speed * 0.02, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(bus);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  private playProceduralHit(isHeadshot: boolean): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus) {
      return;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.value = isHeadshot ? 1100 : 790;
    osc.frequency.exponentialRampToValueAtTime(isHeadshot ? 760 : 600, now + 0.04);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(isHeadshot ? 0.14 : 0.09, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    osc.connect(gain);
    gain.connect(bus);

    osc.start(now);
    osc.stop(now + 0.07);
  }

  private playProceduralReload(): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus) {
      return;
    }

    this.playClick(ctx.currentTime, 320, 0.07);
    this.playClick(ctx.currentTime + 0.12, 240, 0.06);
    this.playClick(ctx.currentTime + 0.24, 410, 0.06);
  }

  private playProceduralDeath(): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus) {
      return;
    }

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.value = 200;
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.42);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);

    osc.connect(gain);
    gain.connect(bus);

    osc.start(now);
    osc.stop(now + 0.48);
  }

  private playProceduralRoundBell(): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus) {
      return;
    }

    const now = ctx.currentTime;
    const fundamental = ctx.createOscillator();
    const overtone = ctx.createOscillator();
    const gain = ctx.createGain();

    fundamental.type = "sine";
    overtone.type = "sine";
    fundamental.frequency.value = 430;
    overtone.frequency.value = 860;

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    fundamental.connect(gain);
    overtone.connect(gain);
    gain.connect(bus);

    fundamental.start(now);
    overtone.start(now);
    fundamental.stop(now + 0.45);
    overtone.stop(now + 0.32);
  }

  private playClick(time: number, frequency: number, intensity: number): void {
    const ctx = this.ctx;
    const bus = this.bus;

    if (!ctx || !bus) {
      return;
    }

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = frequency;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(intensity, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);

    osc.connect(gain);
    gain.connect(bus);

    osc.start(time);
    osc.stop(time + 0.05);
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const durationSeconds = 1;
    const frameCount = ctx.sampleRate * durationSeconds;
    const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
    const channel = buffer.getChannelData(0);

    for (let index = 0; index < frameCount; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }

    return buffer;
  }
}

function resolveRange(value: Range | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (Array.isArray(value)) {
    const [min, max] = value;
    return min + Math.random() * (max - min);
  }

  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}
