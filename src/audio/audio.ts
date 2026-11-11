/** 全部音效都是用振荡器和噪声现场合成的，没有任何音频文件。 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private rain: GainNode | null = null;
  private volume = 0.8;

  /** 浏览器要求必须在用户点击之后才能出声，所以第一次点击时再初始化。 */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
      this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.startRain();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }
  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }
  setAmbience(on: boolean) { if (this.ctx && this.rain) this.rain.gain.setTargetAtTime(on ? 0.11 : 0.04, this.ctx.currentTime, 0.4); }

  private out(pan: number) {
    const ctx = this.ctx!;
    if (!pan || !ctx.createStereoPanner) return this.master as AudioNode;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    return p;
  }

  /** 一段被滤波的噪声：枪声、爆炸、脚步都是它的变体 */
  private burst(o: { dur: number; freq: number; freqEnd?: number; q?: number; type?: BiquadFilterType; gain: number; attack?: number; pan?: number; delay?: number }) {
    const ctx = this.ctx; if (!ctx) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loopStart = Math.random(); src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'lowpass'; f.Q.value = o.q ?? 0.8;
    f.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f); f.connect(g); g.connect(this.out(o.pan ?? 0));
    src.start(t0); src.stop(t0 + o.dur + 0.05);
  }

  private tone(o: { freq: number; freqEnd?: number; dur: number; type?: OscillatorType; gain: number; pan?: number; delay?: number }) {
    const ctx = this.ctx; if (!ctx) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g); g.connect(this.out(o.pan ?? 0));
    osc.start(t0); osc.stop(t0 + o.dur + 0.05);
  }

  private startRain() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    this.rain = ctx.createGain(); this.rain.gain.value = 0.04;
    src.connect(hp); hp.connect(lp); lp.connect(this.rain); this.rain.connect(this.master);
    src.start();
    // 远处的低频隆隆声：海和港口机械
    const src2 = ctx.createBufferSource();
    src2.buffer = this.noise; src2.loop = true; src2.playbackRate.value = 0.5;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 140;
    const g2 = ctx.createGain(); g2.gain.value = 0.16;
    src2.connect(lp2); lp2.connect(g2); g2.connect(this.master);
    src2.start();
  }

  shot() {
    this.burst({ dur: 0.16, freq: 5200, freqEnd: 500, gain: 0.55 });
    this.burst({ dur: 0.34, freq: 900, freqEnd: 120, gain: 0.3, delay: 0.01 });
    this.tone({ freq: 170, freqEnd: 48, dur: 0.12, type: 'triangle', gain: 0.5 });
  }
  empty() { this.tone({ freq: 1400, dur: 0.03, type: 'square', gain: 0.08 }); }
  reload() {
    this.burst({ dur: 0.05, freq: 2400, type: 'bandpass', q: 3, gain: 0.25 });
    this.burst({ dur: 0.06, freq: 1500, type: 'bandpass', q: 3, gain: 0.3, delay: 0.75 });
    this.burst({ dur: 0.05, freq: 3200, type: 'bandpass', q: 4, gain: 0.3, delay: 1.45 });
    this.tone({ freq: 240, freqEnd: 120, dur: 0.06, type: 'square', gain: 0.12, delay: 1.47 });
  }
  melee() { this.burst({ dur: 0.14, freq: 600, freqEnd: 2600, type: 'bandpass', q: 1.5, gain: 0.25 }); }
  hit() { this.tone({ freq: 1900, dur: 0.045, type: 'square', gain: 0.07 }); }
  weak() { this.tone({ freq: 2500, dur: 0.05, type: 'square', gain: 0.09 }); this.tone({ freq: 3300, dur: 0.07, type: 'square', gain: 0.08, delay: 0.045 }); }
  impact(vol: number, pan: number) { this.burst({ dur: 0.05, freq: 3600, type: 'bandpass', q: 5, gain: 0.16 * vol, pan }); }
  enemyShot(vol: number, pan: number) {
    this.tone({ freq: 880, freqEnd: 180, dur: 0.2, type: 'sawtooth', gain: 0.16 * vol, pan });
    this.burst({ dur: 0.1, freq: 2600, freqEnd: 700, gain: 0.14 * vol, pan });
  }
  charge(vol: number, pan: number) { this.tone({ freq: 220, freqEnd: 760, dur: 0.5, type: 'sawtooth', gain: 0.06 * vol, pan }); }
  bark(vol: number, pan: number) { this.tone({ freq: 320, freqEnd: 90, dur: 0.18, type: 'sawtooth', gain: 0.2 * vol, pan }); this.burst({ dur: 0.12, freq: 1300, type: 'bandpass', q: 2, gain: 0.14 * vol, pan }); }
  explode(vol: number, pan: number) {
    this.burst({ dur: 0.7, freq: 2400, freqEnd: 70, gain: 0.7 * vol, pan });
    this.tone({ freq: 110, freqEnd: 32, dur: 0.5, type: 'sine', gain: 0.6 * vol, pan });
  }
  hurt() { this.burst({ dur: 0.16, freq: 500, freqEnd: 140, gain: 0.5 }); this.tone({ freq: 96, freqEnd: 60, dur: 0.2, type: 'sine', gain: 0.5 }); }
  step(sprint: boolean) { this.burst({ dur: 0.07, freq: 700 + Math.random() * 500, type: 'bandpass', q: 1.2, gain: sprint ? 0.11 : 0.07 }); this.burst({ dur: 0.05, freq: 4500, type: 'highpass', gain: 0.02 }); }
  land() { this.burst({ dur: 0.14, freq: 420, freqEnd: 110, gain: 0.3 }); }
  click() { this.tone({ freq: 660, dur: 0.05, type: 'square', gain: 0.05 }); }
  relayTick(k: number) { this.tone({ freq: 500 + k * 700, dur: 0.05, type: 'square', gain: 0.05 }); }
  relayDone() {
    this.tone({ freq: 523, dur: 0.14, type: 'triangle', gain: 0.2 });
    this.tone({ freq: 784, dur: 0.22, type: 'triangle', gain: 0.2, delay: 0.12 });
    this.burst({ dur: 0.5, freq: 1200, freqEnd: 90, gain: 0.3 });
  }
  radio() {
    this.burst({ dur: 0.09, freq: 2200, type: 'bandpass', q: 2, gain: 0.1 });
    this.tone({ freq: 1250, dur: 0.07, type: 'sine', gain: 0.08, delay: 0.05 });
  }
  alarm() { for (let i = 0; i < 3; i++) this.tone({ freq: 620, freqEnd: 940, dur: 0.3, type: 'sawtooth', gain: 0.07, delay: i * 0.36 }); }
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.16, delay: i * 0.16 })); }
  fail() { this.tone({ freq: 220, freqEnd: 55, dur: 1.2, type: 'sawtooth', gain: 0.2 }); }
}
