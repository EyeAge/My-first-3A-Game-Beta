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

  // ------------------------------------------------------------------ 敌人的预警、警觉、死亡
  // 下面几个声音都带 vol / pan：敌人离得越远越轻，在左边就偏左声道（由 Enemies.spatial 算出来）。

  /**
   * 渐强的音：音量从零一路涨到 gain，到点戛然而止 —— "蓄力"的感觉全靠这个包络。
   * 上面的 tone() 是"一敲就响、慢慢消失"，正好反过来，所以另写一个。
   * chop 给了的话，再用这个频率的方波把声音切成一段一段的（"突突突"的断续感）。
   */
  private swell(o: { freq: number; freqEnd: number; dur: number; type?: OscillatorType; gain: number; pan?: number; chop?: number; chopEnd?: number; fade?: boolean }) {
    const ctx = this.ctx; if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
    const g = ctx.createGain();
    if (o.fade) {           // 反过来用：从 gain 慢慢落到零（断电声）
      g.gain.setValueAtTime(o.gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    } else {
      // 音量曲线 = 进度的 1.4 次方：前半段几乎听不见，最后猛地冲上来
      const curve = new Float32Array(24);
      for (let i = 0; i < curve.length; i++) curve[i] = Math.pow(i / (curve.length - 1), 1.4) * o.gain;
      g.gain.setValueCurveAtTime(curve, t0, o.dur);
    }
    let tail: AudioNode = g;
    if (o.chop) {
      // 斩波：一个方波振荡器去推另一个增益节点的音量。方波在 -1..1 之间跳，乘 0.5 再加上基准值 0.5，就成了 0 / 1 的开关
      const lfo = ctx.createOscillator(); lfo.type = 'square';
      lfo.frequency.setValueAtTime(o.chop, t0);
      lfo.frequency.linearRampToValueAtTime(o.chopEnd ?? o.chop, t0 + o.dur);
      const depth = ctx.createGain(); depth.gain.value = 0.5;
      const gate = ctx.createGain(); gate.gain.value = 0.5;
      lfo.connect(depth); depth.connect(gate.gain);
      g.connect(gate); tail = gate;
      lfo.start(t0); lfo.stop(t0 + o.dur + 0.05);
    }
    osc.connect(g); tail.connect(this.out(o.pan ?? 0));
    osc.start(t0); osc.stop(t0 + o.dur + 0.02);
  }

  /**
   * 开火预警。kind：'gull' 无人机（尖细的上滑音）、'hound' 机器狗 / 守卫（低沉的"呜——"）、'lunge' 机器狗扑击前（更短更尖）。
   * dur 是预警时长：声音正好在开火那一刻结束，玩家听熟了就能掐着点躲。
   */
  telegraph(kind: 'gull' | 'hound' | 'lunge', dur: number, vol: number, pan: number) {
    if (vol <= 0.02) return;
    if (kind === 'gull') {
      this.swell({ freq: 620, freqEnd: 2520, dur, gain: 0.09 * vol, pan, chop: 20, chopEnd: 80 });
      this.swell({ freq: 310, freqEnd: 1260, dur, type: 'square', gain: 0.025 * vol, pan });
      // 五下越来越密的滴答：时刻按平方根排，所以越到后面挨得越近
      for (let i = 1; i <= 5; i++) this.tone({ freq: i % 2 ? 3800 : 6100, dur: 0.02, type: 'square', gain: 0.03 * vol, pan, delay: dur * Math.sqrt(i / 5) - 0.02 });
    } else {
      const k = kind === 'lunge' ? 1.96 : 1, v = vol * (kind === 'lunge' ? 0.7 : 1);
      this.swell({ freq: 170 * k, freqEnd: 550 * k, dur, type: 'sawtooth', gain: 0.1 * v, pan, chop: 38 * k });
      this.swell({ freq: 680 * k, freqEnd: 1580 * k, dur, gain: 0.05 * v, pan });
      for (let i = 1; i <= 7; i++) this.tone({ freq: (i % 2 ? 1500 : 2600) * k, dur: 0.02, type: 'square', gain: 0.025 * v, pan, delay: dur * Math.sqrt(i / 7) - 0.02 });
    }
  }

  /** 敌人发现玩家的那一刻：无人机是两声短促的"嘀嘀"，地面单位再垫一声上滑的低音。 */
  alertChirp(air: boolean, vol: number, pan: number) {
    if (vol <= 0.02) return;
    if (air) {
      this.tone({ freq: 1320, dur: 0.07, type: 'square', gain: 0.07 * vol, pan });
      this.tone({ freq: 1867, dur: 0.09, type: 'square', gain: 0.07 * vol, pan, delay: 0.09 });
    } else {
      this.tone({ freq: 622, dur: 0.08, type: 'square', gain: 0.07 * vol, pan });
      this.tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.07 * vol, pan, delay: 0.1 });
      this.tone({ freq: 220, freqEnd: 311, dur: 0.22, type: 'sawtooth', gain: 0.08 * vol, pan });
    }
  }

  /** 机器狗的炮：比无人机的"啾"沉得多 —— 一声低音加一把金属的回响。 */
  houndShot(vol: number, pan: number) {
    if (vol <= 0.02) return;
    this.tone({ freq: 112, freqEnd: 37, dur: 0.3, type: 'triangle', gain: 0.4 * vol, pan });
    this.burst({ dur: 0.2, freq: 1800, freqEnd: 300, gain: 0.3 * vol, pan });
    this.burst({ dur: 0.12, freq: 420, type: 'bandpass', q: 2, gain: 0.2 * vol, pan });
    for (const f of [310, 642, 985]) this.tone({ freq: f, dur: 0.16, gain: 0.03 * vol, pan });
  }

  /** 机器狗落脚：一声闷的"咚"带一点金属响。跑得越快越响。 */
  houndStep(vol: number, pan: number, speed: number) {
    if (vol <= 0.25) return;                        // 太远的脚步不出声，省得满场都是
    const g = Math.min(1, 0.6 + speed * 0.07) * vol * vol;
    this.tone({ freq: 84, freqEnd: 41, dur: 0.1, gain: 0.16 * g, pan });
    this.burst({ dur: 0.04, freq: 1133, type: 'bandpass', q: 4, gain: 0.07 * g, pan });
  }

  /** 沉重的金属砸地：机器狗瘫倒、守卫跪倒和扑倒时用。heavy 越大越沉。 */
  crash(vol: number, pan: number, heavy = 1) {
    if (vol <= 0.02) return;
    this.tone({ freq: 84 / heavy, freqEnd: 38 / heavy, dur: 0.28, gain: 0.5 * vol, pan });
    this.burst({ dur: 0.22, freq: 2200, freqEnd: 180, gain: 0.4 * vol, pan });
    // 金属板被砸响的几个泛音（不成整数倍，所以听起来是"哐"而不是一个音）
    for (const f of [388, 861, 1540, 2750]) this.tone({ freq: f * 0.72 / heavy, dur: 0.22, gain: 0.05 * vol, pan });
  }

  /**
   * 无人机被打掉：一声脆响之后，四个旋翼的和弦一路掉调、被切得断断续续，同时是越来越低的气流声。
   * 真正坠地的爆炸声不在这里 —— 它什么时候落地要看当时飞多高，由落地那一刻另外触发。
   */
  gullDie(vol: number, pan: number) {
    if (vol <= 0.02) return;
    this.burst({ dur: 0.03, freq: 2500, type: 'highpass', gain: 0.35 * vol, pan });
    for (const f of [184, 207, 233, 258]) this.swell({ freq: f * 1.25, freqEnd: f * 0.2, dur: 1.1, type: 'sawtooth', gain: 0.05 * vol, pan, chop: 26, chopEnd: 10, fade: true });
    this.burst({ dur: 1.0, freq: 3200, freqEnd: 500, type: 'bandpass', q: 1.5, gain: 0.12 * vol, pan });
  }

  /**
   * 机器狗被击毁：电机断电的下滑音，接着是身体和腿先后砸在地上的五下金属撞击（一下比一下轻），最后一阵零件散落的咔哒声。
   * 撞击的时间点和音量照参考：0.62 / 0.84 / 0.98 / 1.17 / 1.33 秒。
   */
  houndDie(vol: number, pan: number) {
    if (vol <= 0.02) return;
    this.burst({ dur: 0.02, freq: 4000, type: 'highpass', gain: 0.2 * vol, pan });
    this.swell({ freq: 142, freqEnd: 30, dur: 1.3, type: 'sawtooth', gain: 0.16 * vol, pan, fade: true });
    this.swell({ freq: 1230, freqEnd: 180, dur: 1.3, gain: 0.05 * vol, pan, fade: true });
    const hits: [number, number, number][] = [[0.62, 1, 1], [0.84, 0.75, 1.22], [0.98, 0.5, 0.86], [1.17, 0.42, 1.4], [1.33, 0.22, 1.1]];
    for (const [at, v, pitch] of hits) {
      for (const f of [388, 861, 1540, 2750]) this.tone({ freq: f * pitch, dur: 0.18, gain: 0.035 * v * vol, pan, delay: at });
      this.tone({ freq: 105, freqEnd: 48, dur: 0.16, gain: 0.25 * v * vol, pan, delay: at });
    }
    for (let i = 0; i < 22; i++) this.burst({ dur: 0.015, freq: 2500 + Math.random() * 3000, type: 'bandpass', q: 6, gain: 0.06 * vol * (1 - i / 26), pan, delay: 0.62 + Math.random() });
  }

  /** 守卫被击毁：更大的电机、更长的断电声；跪倒和扑倒的撞击由动作播到那一帧时另外触发 crash()。 */
  guardDie(vol: number, pan: number) {
    if (vol <= 0.02) return;
    this.burst({ dur: 0.03, freq: 3000, type: 'highpass', gain: 0.25 * vol, pan });
    this.swell({ freq: 96, freqEnd: 22, dur: 1.8, type: 'sawtooth', gain: 0.2 * vol, pan, fade: true });
    this.swell({ freq: 760, freqEnd: 120, dur: 1.6, gain: 0.05 * vol, pan, fade: true });
    this.burst({ dur: 1.2, freq: 900, freqEnd: 120, type: 'bandpass', q: 2, gain: 0.1 * vol, pan });
  }

  /** 敌方弹丸贴着身边飞过的呼啸声。 */
  whiz(pan: number) { this.burst({ dur: 0.16, freq: 2600, freqEnd: 800, type: 'bandpass', q: 3, gain: 0.16, pan }); }
}
