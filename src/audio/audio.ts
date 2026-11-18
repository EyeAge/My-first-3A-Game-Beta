import type { Surface } from '../world/colliders';
import { irOutdoor, irShed, rainInterior, rifleTailIn, rifleTailOut, rotorLoop, servoLoop, stepConcrete, stepMetal, stepWood, thunder } from './synth';

/**
 * 一个声音走哪条"总线"（总线 = 一组声音共用的一根线，后面可以统一处理）：
 *   world —— 场景里的声音（敌人、爆炸、弹着）：大部分送去混响，所以进了车间会"嗡"起来。不写就是它；
 *   near  —— 玩家自己身上的声音（枪、脚步）：只送一小部分去混响，不然自己的枪声糊成一片；
 *   dry   —— 界面提示、无线电、雷声、枪声的尾音：不进混响（尾音本身就是"算好的混响"）。
 */
type Bus = 'world' | 'near' | 'dry';
/** 敌人的持续音（旋翼 / 伺服电机）。key 用来认"还是不是同一个敌人"；vol、pan、rate 每帧更新。 */
export interface LoopVoice { key: object; kind: 'rotor' | 'servo'; vol: number; pan: number; rate: number }
interface Voice { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode | null; seen: boolean; at: number }
type Stereo = [Float32Array, Float32Array];
/** 提前算好的采样（原始数据，还没交给浏览器）。 */
interface Samples {
  tailIn: Stereo; tailOut: Stereo; rainIn: Stereo;
  thunderNear: Float32Array; thunderFar: Float32Array;
  steps: Record<'concrete' | 'metal' | 'wood', Float32Array[]>;
  rotor: Float32Array; servo: Float32Array;
}
/** 上面这些采样统一用的采样率。32000 对脚步、尾音、循环音足够（人耳对它们一万赫兹以上的部分不敏感），比 48000 省三分之一的计算；播放时浏览器会自动换算。 */
const SAMPLE_RATE = 32000;

// 几条循环声的基准音量
const RAIN_OUT = 0.11, RAIN_IN = 0.3, RUMBLE = 0.16;
/** 不在游戏中（菜单、暂停、结算）时，雨声压到游戏中的多少。 */
const AMBIENT_IDLE = 0.36;
const TAIL = 0.55, THUNDER = 0.8, MAX_LOOPS = 6;

/** 音效：短促的声音用振荡器和噪声现场搭，复杂的（混响、尾音、脚步、循环音）在 synth.ts 里提前算成采样。没有任何音频文件。 */
export class GameAudio {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private volume = 0.8;
  private bus!: Record<Bus, GainNode>;
  // ---- 屋里屋外
  private sendOut!: GainNode; private sendIn!: GainNode;      // 送进室外混响 / 车间混响的量
  private rainOut!: GainNode; private rainIn!: GainNode; private rumble!: GainNode;
  private loopBus!: GainNode;
  private insideTarget = 0;                                   // 镜头现在在不在屋里（0 / 1）
  /** 室内系数 0…1：进出门时不是"啪"地切换，而是用三分之一秒左右滑过去。所有跟屋里屋外有关的音量都由它算。 */
  private inside = 0;
  private active = false; private ambient = AMBIENT_IDLE;     // 是否在游戏中；环境声的总音量（平滑过的）
  // ---- 提前算好的采样
  private samples: Samples | null = null;
  private tailIn!: AudioBuffer; private tailOut!: AudioBuffer;
  private thunderNear!: AudioBuffer; private thunderFar!: AudioBuffer;
  private steps!: Record<'concrete' | 'metal' | 'wood', AudioBuffer[]>;
  private loopBuf!: Record<LoopVoice['kind'], AudioBuffer>;
  private stepN = 0;
  private sinceShot = 9; private sinceTail = 9; private tailDue = false;
  private voices = new Map<object, Voice>();

  /**
   * 把采样算出来（十几段声音，一共要算一两百毫秒）。它只是纯计算，不需要音频设备，
   * 所以可以在加载画面里提前调一次，免得第一次点击"开始"时卡一下；没提前调的话，attach() 会自己补上。
   */
  prepare(): Samples {
    return this.samples ??= {
      tailIn: rifleTailIn(SAMPLE_RATE, 4111), tailOut: rifleTailOut(SAMPLE_RATE, 4112), rainIn: rainInterior(SAMPLE_RATE, 4171),
      thunderNear: thunder(SAMPLE_RATE, 4121, true), thunderFar: thunder(SAMPLE_RATE, 4122, false),
      steps: {
        concrete: [0, 1, 2, 3].map((v) => stepConcrete(SAMPLE_RATE, 4131 + v, v)),
        metal: [0, 1, 2].map((v) => stepMetal(SAMPLE_RATE, 4141 + v, v)),
        wood: [0, 1, 2].map((v) => stepWood(SAMPLE_RATE, 4151 + v, v)),
      },
      rotor: rotorLoop(SAMPLE_RATE, 4161), servo: servoLoop(SAMPLE_RATE, 4162),
    };
  }

  /** 浏览器要求必须在用户点击之后才能出声，所以第一次点击时再初始化。 */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.attach(new AC());
    }
    const ctx = this.ctx as AudioContext;
    if (ctx.state === 'suspended') void ctx.resume();
  }

  /**
   * 在给定的音频上下文上把整张"接线图"搭起来。平时由 resume() 传入真正出声的上下文；
   * 体检脚本会传一个离线上下文（OfflineAudioContext）进来 —— 它不出声，而是把结果渲染成一串数字，
   * 这样在没有喇叭的机器上也能检查"到底有没有声音、有多响、有没有坏数"。
   *
   * 接线图：
   *   world ─┬────────────────────────────────→ master → 压限器 → 喇叭
   *   near  ─┤                                    ↑
   *   dry   ─┘                                    │
   *   world ×0.9 ┐                                │
   *   near ×0.32 ┴→ 发送 ─→ sendOut → 卷积(室外) ─┤
   *                     └→ sendIn  → 卷积(车间) ─┘
   * sendOut / sendIn 两个音量由室内系数决定：在屋外只有室外混响，进屋后换成车间的（见 update）。
   */
  attach(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const sr = ctx.sampleRate, gain = (v: number, to: AudioNode) => { const g = ctx.createGain(); g.gain.value = v; g.connect(to); return g; };
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(ctx.destination);
    this.bus = { world: gain(1, this.master), near: gain(1, this.master), dry: gain(1, this.master) };

    // ---- 两路混响。脉冲响应必须按上下文自己的采样率来算（卷积节点不会替我们换算），所以只有它俩没法提前准备
    const stereo = (ch: Stereo, rate = SAMPLE_RATE) => { const b = ctx.createBuffer(2, ch[0].length, rate); b.getChannelData(0).set(ch[0]); b.getChannelData(1).set(ch[1]); return b; };
    const mono = (data: Float32Array, rate = SAMPLE_RATE) => { const b = ctx.createBuffer(1, data.length, rate); b.getChannelData(0).set(data); return b; };
    const reverb = (ir: Stereo, wet: number) => {
      const send = ctx.createGain(), conv = ctx.createConvolver();
      conv.buffer = stereo(ir, sr);
      send.connect(conv); conv.connect(gain(wet, this.master));
      return send;
    };
    const send = ctx.createGain();
    this.bus.world.connect(gain(0.9, send)); this.bus.near.connect(gain(0.32, send));
    this.sendOut = reverb(irOutdoor(sr, 4101), 0.75); this.sendIn = reverb(irShed(sr, 4102), 0.95);
    send.connect(this.sendOut); send.connect(this.sendIn);
    this.sendIn.gain.value = 0;

    // ---- 把提前算好的采样交给浏览器（包成 AudioBuffer）
    const S = this.prepare();
    this.noise = mono(Float32Array.from({ length: sr * 2 }, () => Math.random() * 2 - 1), sr);
    this.tailIn = stereo(S.tailIn); this.tailOut = stereo(S.tailOut);
    this.thunderNear = mono(S.thunderNear); this.thunderFar = mono(S.thunderFar);
    this.steps = { concrete: S.steps.concrete.map((d) => mono(d)), metal: S.steps.metal.map((d) => mono(d)), wood: S.steps.wood.map((d) => mono(d)) };
    this.loopBuf = { rotor: mono(S.rotor), servo: mono(S.servo) };
    this.loopBus = gain(0, this.bus.world);

    // ---- 三条一直响着的环境声
    const loop = (buffer: AudioBuffer, rate = 1) => { const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true; src.playbackRate.value = rate; src.start(); return src; };
    // 屋外的雨：白噪声只留 900~7000 赫兹，"沙沙"的宽带声
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    this.rainOut = gain(RAIN_OUT * AMBIENT_IDLE, this.master);
    loop(this.noise).connect(hp); hp.connect(lp); lp.connect(this.rainOut);
    // 屋里的雨：闷的底噪 + 雨点打铁皮屋顶（synth.ts 的 rainInterior）
    this.rainIn = gain(0, this.master);
    loop(stereo(S.rainIn)).connect(this.rainIn);
    // 远处的低频隆隆声：海和港口机械
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 140;
    this.rumble = gain(RUMBLE, this.master);
    loop(this.noise, 0.5).connect(lp2); lp2.connect(this.rumble);
  }

  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }
  /** 是否在游戏中。不在的时候雨声压低、敌人的持续音关掉。 */
  setAmbience(on: boolean) { this.active = on; }
  /** 镜头是不是在屋里（车间的室内范围盒里）。每帧调用；真正的过渡在 update() 里。 */
  setInterior(inside: boolean) { this.insideTarget = inside ? 1 : 0; }

  /**
   * 每帧调用：推进"室内系数"，并据此调各路音量（数值照参考）：
   *   室外混响的发送量 1 → 0.1，车间混响 0 → 1；
   *   屋外的雨声 ×(1 − 0.93 × 系数)，屋里的雨声 × 系数 —— 两条雨声此消彼长；
   *   远处的隆隆声压到一半。
   * 另外管枪声的尾音：停火 0.1 秒后补一声（见 shot）。
   */
  update(dt: number) {
    if (!this.ctx) return;
    this.inside += (this.insideTarget - this.inside) * (1 - Math.exp(-3 * dt));       // 时间常数 1/3 秒
    this.ambient += ((this.active ? 1 : AMBIENT_IDLE) - this.ambient) * (1 - Math.exp(-2.5 * dt));
    const P = this.inside, set = (g: GainNode, v: number) => { if (Math.abs(g.gain.value - v) > 0.0015) g.gain.value = v; };   // 变化太小就不去动它
    set(this.sendOut, 1 - 0.9 * P); set(this.sendIn, P);
    set(this.rainOut, RAIN_OUT * this.ambient * (1 - 0.93 * P)); set(this.rainIn, RAIN_IN * this.ambient * P);
    set(this.rumble, RUMBLE * (1 - 0.5 * P));
    set(this.loopBus, this.active ? 1 : 0);
    this.sinceShot += dt; this.sinceTail += dt;
    if (this.tailDue && this.sinceShot > 0.1) this.tail(0.9);
  }

  private out(pan: number, to: Bus = 'world') {
    const ctx = this.ctx!, bus = this.bus[to];
    if (!pan || !ctx.createStereoPanner) return bus as AudioNode;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(bus);
    return p;
  }

  /** 放一段提前算好的采样。rate 是播放速度（同时也改变音高）：每次略微变一变，同一段采样听起来就不那么重复。 */
  private play(buffer: AudioBuffer, o: { gain: number; pan?: number; rate?: number; delay?: number; to?: Bus }) {
    const ctx = this.ctx; if (!ctx || o.gain <= 0.0005) return;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffer; src.playbackRate.value = o.rate ?? 1;
    g.gain.value = o.gain;
    src.connect(g); g.connect(this.out(o.pan ?? 0, o.to));
    src.start(ctx.currentTime + (o.delay ?? 0));
  }

  /** 一段被滤波的噪声：枪声、爆炸、脚步都是它的变体 */
  private burst(o: { dur: number; freq: number; freqEnd?: number; q?: number; type?: BiquadFilterType; gain: number; attack?: number; pan?: number; delay?: number; to?: Bus }) {
    // 音量几乎为 0 就不播了。不只是省事：下面用的"指数渐变"不接受 0 —— 很远的声源算出来的音量正好是 0，浏览器会直接抛异常
    const ctx = this.ctx; if (!ctx || o.gain <= 0.0005) return;
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
    src.connect(f); f.connect(g); g.connect(this.out(o.pan ?? 0, o.to));
    src.start(t0); src.stop(t0 + o.dur + 0.05);
  }

  private tone(o: { freq: number; freqEnd?: number; dur: number; type?: OscillatorType; gain: number; pan?: number; delay?: number; to?: Bus }) {
    const ctx = this.ctx; if (!ctx || o.gain <= 0.0005) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g); g.connect(this.out(o.pan ?? 0, o.to));
    osc.start(t0); osc.stop(t0 + o.dur + 0.05);
  }

  /**
   * 玩家开一枪。枪声本身只有"砰"的那一下（走 near 总线）；枪声在环境里拖出来的尾音另外放：
   *   · 连发的第一枪立刻带一声尾音；
   *   · 之后扣着扳机不放的话，每隔 0.28 秒以上才再补一声（每一发都带尾音会糊成一片）；
   *   · 停火 0.1 秒后再补最后一声（在 update 里）—— 一梭子打完，回声才真正"散开"。
   */
  shot() {
    this.burst({ dur: 0.16, freq: 5200, freqEnd: 500, gain: 0.55, to: 'near' });
    this.burst({ dur: 0.2, freq: 900, freqEnd: 120, gain: 0.3, delay: 0.01, to: 'near' });
    this.tone({ freq: 170, freqEnd: 48, dur: 0.12, type: 'triangle', gain: 0.5, to: 'near' });
    if (this.sinceTail > 0.28) this.tail(1); else this.tailDue = true;
    this.sinceShot = 0;
  }
  /**
   * 枪声的尾音：屋外的版本是箱垛之间弹回来的几下回声，屋里的版本是铁皮棚子的轰鸣。
   * 两个版本按室内系数此消彼长，所以站在门口开枪时两种都能听到一点。
   */
  private tail(strength: number) {
    const P = this.inside, rate = 0.97 + Math.random() * 0.06;
    if (P < 0.95) this.play(this.tailOut, { gain: TAIL * strength * (1 - P), rate, to: 'dry' });
    if (P > 0.05) this.play(this.tailIn, { gain: TAIL * strength * P, rate, to: 'dry' });
    this.sinceTail = 0; this.tailDue = false;
  }
  empty() { this.tone({ freq: 1400, dur: 0.03, type: 'square', gain: 0.08, to: 'near' }); }
  reload() {
    this.burst({ dur: 0.05, freq: 2400, type: 'bandpass', q: 3, gain: 0.25, to: 'near' });
    this.burst({ dur: 0.06, freq: 1500, type: 'bandpass', q: 3, gain: 0.3, delay: 0.75, to: 'near' });
    this.burst({ dur: 0.05, freq: 3200, type: 'bandpass', q: 4, gain: 0.3, delay: 1.45, to: 'near' });
    this.tone({ freq: 240, freqEnd: 120, dur: 0.06, type: 'square', gain: 0.12, delay: 1.47, to: 'near' });
  }
  melee() { this.burst({ dur: 0.14, freq: 600, freqEnd: 2600, type: 'bandpass', q: 1.5, gain: 0.25, to: 'near' }); }
  hit() { this.tone({ freq: 1900, dur: 0.045, type: 'square', gain: 0.07, to: 'dry' }); }
  weak() { this.tone({ freq: 2500, dur: 0.05, type: 'square', gain: 0.09, to: 'dry' }); this.tone({ freq: 3300, dur: 0.07, type: 'square', gain: 0.08, delay: 0.045, to: 'dry' }); }
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
  hurt() { this.burst({ dur: 0.16, freq: 500, freqEnd: 140, gain: 0.5, to: 'dry' }); this.tone({ freq: 96, freqEnd: 60, dur: 0.2, type: 'sine', gain: 0.5, to: 'dry' }); }
  /**
   * 泼水声，踩水和子弹打进水洼共用。三样东西叠在一起：
   *   · 一段音调往下滑的噪声（1500 → 520 赫兹）：水被推开的“哗”
   *   · 一小段只留高频的噪声：溅起来的碎水珠的“嘶”
   *   · 几个音调往上滑的短音，时刻随机：气泡破掉的“咕嘟”。strength 越大越多
   */
  private slosh(dur: number, strength: number, vol: number, pan = 0, to: Bus = 'world') {
    this.burst({ dur, freq: 1500, freqEnd: 520, type: 'bandpass', q: 0.9, gain: 0.2 * vol, pan, to });
    this.burst({ dur: dur * 0.55, freq: 3000, type: 'highpass', gain: 0.05 * vol, pan, to });
    for (let i = 0, n = Math.round(5 * strength); i < n; i++) {
      const f = 500 + Math.random() * 1200;
      this.tone({ freq: f, freqEnd: f * 1.7, dur: 0.03 + Math.random() * 0.03, gain: 0.035 * vol, pan, delay: Math.random() * dur * 0.6, to });
    }
  }
  /**
   * 脚步。wet = 踩在水洼里：换成泼水声，底下垫一声闷的落脚。
   * 否则看脚下是什么：钢板（钢梯、走道、箱顶）是"哐"，木头（木箱、托盘、工作台）是"笃"，其余都按水泥地算。
   * 每种表面有三四个音高略有不同的变体，轮着放；跑起来更响、音调略高。
   */
  step(sprint: boolean, wet = false, surface: Surface = 'concrete') {
    if (wet) {
      this.slosh(0.46, 1, sprint ? 0.72 : 0.5, 0, 'near');
      this.tone({ freq: 100, freqEnd: 55, dur: 0.09, gain: sprint ? 0.12 : 0.08, to: 'near' });
      return;
    }
    const set = this.ctx ? this.steps[surface === 'metal' || surface === 'wood' ? surface : 'concrete'] : null;
    if (set) this.play(set[this.stepN++ % set.length], { gain: sprint ? 0.5 : 0.36, rate: (sprint ? 1.05 : 1) * (0.97 + Math.random() * 0.06), to: 'near' });
  }
  /** 落地。wet = 跳进了水洼：在落地的闷响上再加一声压低了的泼水；落在钢板上则再加一声调低了的"哐"。 */
  land(wet = false, surface: Surface = 'concrete') {
    this.burst({ dur: 0.14, freq: 420, freqEnd: 110, gain: 0.3, to: 'near' });
    if (wet) this.slosh(0.5, 1.2, 0.8, 0, 'near');
    else if (surface === 'metal' && this.ctx) this.play(this.steps.metal[this.stepN++ % 3], { gain: 0.5, rate: 0.9, to: 'near' });
  }
  /**
   * 打雷。power 是这道闪电有多亮（0.3~1）：越亮说明打得越近 —— 光一瞬间就到，声音每秒才走 340 米，
   * 所以近的雷 0.5 秒后就响（约 170 米外），远的要等两三秒（约一公里外），而且更轻、更闷，没有开头那声"喀嚓"。
   */
  thunder(power: number) {
    if (!this.ctx) return;
    const k = Math.max(0.1, Math.min(1, power));
    this.play(k > 0.6 ? this.thunderNear : this.thunderFar, { gain: (0.35 + 0.65 * k) * THUNDER, delay: 0.5 + (1 - k) * 2 + Math.random() * 0.6, rate: 0.95 + Math.random() * 0.1, to: 'dry' });
  }
  /** 子弹打进水里（水洼或者海面）：泼水声加一个往上滑的“啾”。vol / pan 和别的弹着声一样，由距离和方位算出来。 */
  impactWater(vol: number, pan: number) {
    if (vol <= 0.02) return;
    this.slosh(0.5, 0.9, vol, pan);
    this.tone({ freq: 420, freqEnd: 1150, dur: 0.12, gain: 0.05 * vol, pan });
  }
  click() { this.tone({ freq: 660, dur: 0.05, type: 'square', gain: 0.05, to: 'dry' }); }
  relayTick(k: number) { this.tone({ freq: 500 + k * 700, dur: 0.05, type: 'square', gain: 0.05, to: 'dry' }); }
  relayDone() {
    this.tone({ freq: 523, dur: 0.14, type: 'triangle', gain: 0.2, to: 'dry' });
    this.tone({ freq: 784, dur: 0.22, type: 'triangle', gain: 0.2, delay: 0.12, to: 'dry' });
    this.burst({ dur: 0.5, freq: 1200, freqEnd: 90, gain: 0.3 });      // 设备断电的那一声在场景里，带混响
  }
  radio() {
    this.burst({ dur: 0.09, freq: 2200, type: 'bandpass', q: 2, gain: 0.1, to: 'dry' });
    this.tone({ freq: 1250, dur: 0.07, type: 'sine', gain: 0.08, delay: 0.05, to: 'dry' });
  }
  alarm() { for (let i = 0; i < 3; i++) this.tone({ freq: 620, freqEnd: 940, dur: 0.3, type: 'sawtooth', gain: 0.07, delay: i * 0.36, to: 'dry' }); }
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.5, type: 'triangle', gain: 0.16, delay: i * 0.16, to: 'dry' })); }
  fail() { this.tone({ freq: 220, freqEnd: 55, dur: 1.2, type: 'sawtooth', gain: 0.2, to: 'dry' }); }

  // ------------------------------------------------------------------ 敌人的预警、警觉、死亡
  // 下面几个声音都带 vol / pan：敌人离得越远越轻，在左边就偏左声道（由 Enemies.spatial 算出来）。

  /**
   * 渐强的音：音量从零一路涨到 gain，到点戛然而止 —— "蓄力"的感觉全靠这个包络。
   * 上面的 tone() 是"一敲就响、慢慢消失"，正好反过来，所以另写一个。
   * chop 给了的话，再用这个频率的方波把声音切成一段一段的（"突突突"的断续感）。
   */
  private swell(o: { freq: number; freqEnd: number; dur: number; type?: OscillatorType; gain: number; pan?: number; chop?: number; chopEnd?: number; fade?: boolean }) {
    const ctx = this.ctx; if (!ctx || o.gain <= 0.0005) return;
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

  // ------------------------------------------------------------------ 敌人的持续音

  /**
   * 敌人身上一直响着的声音：无人机的旋翼、机器狗和守卫的伺服电机。靠它，敌人还没露面就能听出"上面有东西""墙后有东西"。
   * 敌人模块每帧把"离镜头最近的几个"报上来（最多 6 个：再多耳朵也分不清，白占资源）。
   * 这里按 key 对账：新出现的开一条循环声，还在的更新音量 / 方位 / 音高，不在名单里的淡出后关掉。
   */
  loops(list: readonly LoopVoice[]) {
    const ctx = this.ctx; if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of this.voices.values()) v.seen = false;
    for (let i = 0; i < list.length && i < MAX_LOOPS; i++) {
      const l = list[i];
      let v = this.voices.get(l.key);
      if (!v) {
        const src = ctx.createBufferSource(), gain = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        src.buffer = this.loopBuf[l.kind]; src.loop = true;
        gain.gain.value = 0;
        src.connect(gain);
        if (pan) { gain.connect(pan); pan.connect(this.loopBus); } else gain.connect(this.loopBus);
        src.start(now, Math.random() * 2);              // 从循环里随机一处开始放：几架无人机才不会整齐得像一架
        v = { src, gain, pan, seen: true, at: -1 };
        this.voices.set(l.key, v);
      }
      v.seen = true;
      if (v.at === now) continue;                       // 音频时钟没走（比如脱离画面快进测试时）就不重复下指令
      v.at = now;
      // 不直接改数值，而是"用 0.08 秒滑过去"：音量、音高一帧一跳会有细碎的杂音
      v.gain.gain.setTargetAtTime(Math.max(0, l.vol), now, 0.08);
      v.src.playbackRate.setTargetAtTime(Math.max(0.2, l.rate), now, 0.08);
      v.pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, l.pan)), now, 0.08);
    }
    for (const [key, v] of this.voices) {
      if (v.seen) continue;
      v.gain.gain.setTargetAtTime(0, now, 0.06);
      v.src.stop(now + 0.4);
      this.voices.delete(key);
    }
  }
}
