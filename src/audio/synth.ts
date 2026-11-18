import { mulberry32, type Rng } from '../core/math';

// 离线合成：把一段声音直接"算"成一串数字（采样），之后像放录音一样反复播放。
//
// audio.ts 里原有的音效是现场搭的：一个振荡器或一段噪声，接一个滤波器，再接一个音量包络，响完就扔。
// 短促、简单的声音那样做最省事。但下面这几样不行：
//   · 混响的"脉冲响应"——它本来就必须是一段现成的采样（见 irShed / irOutdoor）；
//   · 要无缝循环的声音（屋里的雨声、旋翼声）；
//   · 由十几个成分叠起来的声音（枪声在屋里的尾音、踩铁板的"哐"）——每响一次都现搭十几个节点太浪费。
// 所以这里放一套最小的工具（噪声、滤波、包络、几种基本的"发声体"），再用它们按配方拼出各个声音。
// 配方里的数字（频率、时长、各成分的比例）照参考。
//
// 约定：一段声音就是一个 Float32Array，每个数在 −1…1 之间；sr 是采样率（每秒多少个数）。

/** 一段全是 0 的声音。 */
export const silence = (sr: number, seconds: number) => new Float32Array(Math.max(1, Math.round(sr * seconds)));

/** 白噪声：每个采样都是 −1…1 之间的随机数。"沙——"的声音，几乎所有不成调的音效都从它开始。 */
export function whiteNoise(sr: number, seconds: number, rng: Rng) {
  const out = silence(sr, seconds);
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

export type FilterKind = 'lp' | 'hp' | 'bp';   // 低通（只留低频）/ 高通（只留高频）/ 带通（只留某个频率附近）

/**
 * 双二阶滤波器（biquad）：音频里最常用的滤波器，输出 = 最近三个输入和最近两个输出的加权和。
 * 五个权重怎么从"截止频率 + Q 值"算出来是现成的公式（Robert Bristow-Johnson 的《Audio EQ Cookbook》）。
 * Q 越大，截止频率附近越"尖"：带通滤波器的 Q 很大时，敲它一下它会自己嗡嗡响一阵——下面用这个性质做铁皮的共振。
 */
function coefficients(kind: FilterKind, freq: number, q: number, sr: number): [number, number, number, number, number] {
  const f = Math.min(Math.max(freq, 10), sr * 0.45);            // 频率夹在合法范围里：太接近采样率的一半滤波器会发散
  const w = (2 * Math.PI * f) / sr, cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
  const a0 = 1 + alpha;
  let b0: number, b1: number, b2: number;
  if (kind === 'lp') { b1 = 1 - cos; b0 = b2 = b1 / 2; }
  else if (kind === 'hp') { b1 = -(1 + cos); b0 = b2 = (1 + cos) / 2; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/**
 * 就地滤波。freq 可以是一个数，也可以是一个函数：传入"进度"（0 = 开头，1 = 结尾），返回那一刻的截止频率，
 * 这样就能做出"越来越闷"的尾音（高频先散掉，低频拖得久）。
 * wrap = true 用于要循环播放的声音：先拿结尾的一小段"预热"滤波器，再从头滤，这样结尾和开头接得上，循环处听不到"咔"的一声。
 */
export function filter(buf: Float32Array, kind: FilterKind, freq: number | ((progress: number) => number), q: number, sr: number, wrap = false) {
  const n = buf.length, moving = typeof freq === 'function';
  let [b0, b1, b2, a1, a2] = coefficients(kind, moving ? freq(0) : freq, q, sr);
  let z1 = 0, z2 = 0;                                            // 滤波器的"记忆"
  if (wrap) {
    for (let i = Math.max(0, n - Math.round(sr * 0.25)); i < n; i++) { const x = buf[i], y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; }
  }
  for (let i = 0; i < n; i++) {
    if (moving && (i & 31) === 0) [b0, b1, b2, a1, a2] = coefficients(kind, freq(i / n), q, sr);   // 截止频率在变：每 32 个采样重算一次权重就够平滑了
    const x = buf[i], y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  return buf;
}

/** 从 f0 滑到 f1 的频率曲线（给 filter 的 freq 用）。k < 1 时前面滑得快、后面慢。 */
export const sweep = (f0: number, f1: number, k: number) => (progress: number) => f0 * Math.pow(f1 / f0, Math.pow(progress, k));

/**
 * 音量包络：声音响起来再消失的轮廓。decay 是衰减的快慢（每过 decay 秒音量降到原来的 37%），
 * attack 是起音时间（0 = 一上来就是最响，像敲击；大一点就是"涌"上来的）。就地乘到 buf 上。
 */
export function envelope(buf: Float32Array, sr: number, decay: number, attack = 0) {
  for (let i = 0; i < buf.length; i++) { const t = i / sr; buf[i] *= Math.exp(-t / decay) * (attack > 0 ? 1 - Math.exp(-t / attack) : 1); }
  return buf;
}

/** 把最响的地方调到 peak（就地）。几段声音要保持相对比例时一起传进来。 */
export function normalize(bufs: Float32Array[], peak: number) {
  let max = 0;
  for (const b of bufs) for (let i = 0; i < b.length; i++) { const a = Math.abs(b[i]); if (a > max) max = a; }
  if (max > 1e-9) for (const b of bufs) for (let i = 0; i < b.length; i++) b[i] *= peak / max;
  return bufs;
}

/** 把 src 叠加到 dst 上：从第 at 秒开始，音量乘 gain。 */
export function mix(dst: Float32Array, src: Float32Array, at: number, gain: number, sr: number) {
  const start = Math.round(at * sr), n = Math.min(src.length, dst.length - start);
  for (let i = Math.max(0, -start); i < n; i++) dst[start + i] += src[i] * gain;
  return dst;
}

/** 开头和结尾各做一小段淡入淡出，免得一段声音"咔"地开始、"咔"地结束。 */
function fadeEdges(buf: Float32Array, sr: number, fadeIn = 0.0003, fadeOut = 0.012) {
  const a = Math.min(buf.length >> 1, Math.round(fadeIn * sr)), b = Math.min(buf.length >> 1, Math.round(fadeOut * sr));
  for (let i = 0; i < a; i++) buf[i] *= i / a;
  for (let i = 0; i < b; i++) { const k = i / b; buf[buf.length - 1 - i] *= k * k; }
  return buf;
}

// ---------------------------------------------------------------------------
// 三种基本的"发声体"

/**
 * 一小团滤过的噪声：先滤波，再乘上衰减包络，最后把音量调到 1。
 * 回声、弹着、脚底的沙砾声都是它：滤波决定音色（低通 = 闷，高通 = 脆，带通 = 有点音高）。
 */
export function noiseBurst(sr: number, rng: Rng, seconds: number, decay: number, o: { lp?: number; hp?: number; bp?: number; q?: number; attack?: number } = {}) {
  const buf = whiteNoise(sr, seconds, rng);
  if (o.hp) filter(buf, 'hp', o.hp, 0.707, sr);
  if (o.lp) filter(buf, 'lp', o.lp, 0.707, sr);
  if (o.bp) filter(buf, 'bp', o.bp, o.q ?? 1, sr);
  envelope(buf, sr, decay, o.attack ?? 0);
  return normalize([buf], 1)[0];
}

/**
 * "咚"：一个音高迅速往下掉的正弦波，从 f0 掉到 f1。脚步、落地、撞击里那一下低沉的闷响都是它。
 * pitchDecay 是音高掉得多快，ampDecay 是音量消失得多快。
 */
export function thump(sr: number, seconds: number, f0: number, f1: number, pitchDecay: number, ampDecay: number, attack = 0.0006) {
  const buf = silence(sr, seconds);
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / pitchDecay))) / sr;   // 相位一点点累加：频率在变的时候不能直接写 sin(2πft)
    buf[i] = Math.sin(phase) * Math.exp(-t / ampDecay) * (1 - Math.exp(-t / attack));
  }
  return buf;
}

/**
 * 一组各自衰减的正弦波（"模态"）：敲一下铁板，它会同时发出好几个互不成整数倍的音，各自慢慢消失 —— 那就是"哐"的音色。
 * partials 的每一项是 [频率, 衰减时间, 音量]。频率之间不成整数倍，听起来才是金属而不是乐器。
 */
export function modes(sr: number, seconds: number, partials: [number, number, number][], rng: Rng) {
  const buf = silence(sr, seconds);
  for (const [freq, decay, gain] of partials) {
    if (freq > sr * 0.46) continue;                               // 高过采样率一半的频率没法表示，硬算会变成别的音
    const step = (2 * Math.PI * freq) / sr, phase = rng() * 2 * Math.PI, fall = Math.exp(-1 / (decay * sr));
    for (let i = 0, a = gain; i < buf.length && a > 1e-5; i++, a *= fall) buf[i] += Math.sin(step * i + phase) * a;
  }
  return fadeEdges(buf, sr, 0.0004, 0);
}

// ---------------------------------------------------------------------------
// 配方

type Stereo = [Float32Array, Float32Array];

/**
 * 车间里的混响（脉冲响应，2.2 秒）。
 * "脉冲响应"是什么：在屋里拍一下手，录下来的那一串回声就是这间屋子的脉冲响应。把任何声音和它做"卷积"
 * （浏览器的 ConvolverNode 干这个），就等于把那个声音搬到这间屋里去放。我们不去录，直接按"铁皮棚子该有的样子"算一段：
 *   · 五个很早的反射（声音从墙和屋顶弹回来的头几下，18~139 毫秒）；
 *   · 一条两秒多的扩散尾巴，而且越往后越闷（高频被吸收得快）；
 *   · 再垫一层 260 赫兹以下的低频轰鸣 —— 大铁皮屋子里低频拖得最久。
 * 左右声道用不同的随机数、反射时刻也略有不同，听起来才有"宽度"。
 */
export function irShed(sr: number, seed: number): Stereo {
  const channel = (rng: Rng, right: boolean) => {
    const out = silence(sr, 2.2);
    const tail = filter(whiteNoise(sr, 2.18, rng), 'lp', sweep(5200, 650, 0.5), 0.7, sr);
    mix(out, envelope(tail, sr, 0.33, 0.006), 0.012, 0.3, sr);
    const boom = filter(whiteNoise(sr, 2.1, rng), 'lp', 260, 0.7, sr);
    mix(out, envelope(boom, sr, 0.4, 0.01), 0.012, 0.5, sr);
    for (const [at, gain] of [[0.018, 0.7], [0.031, 0.55], [0.047, 0.45], [0.093, 0.3], [0.139, 0.2]])
      mix(out, noiseBurst(sr, rng, 0.008, 0.0015, { lp: 4500 }), at * (right ? 1.09 : 0.95), gain, sr);
    return fadeEdges(out, sr, 0, 0.05);
  };
  return normalize([channel(mulberry32(seed), false), channel(mulberry32(seed + 77), true)], 0.9) as Stereo;
}

/**
 * 室外的混响（1.4 秒）：集装箱之间的"拍击回声" —— 六下干脆的回声（62~243 毫秒），外加一条几乎听不见的尾巴。
 * 和车间那条正好相反：回声清楚、尾巴很短。
 */
export function irOutdoor(sr: number, seed: number): Stereo {
  const channel = (rng: Rng, right: boolean) => {
    const out = silence(sr, 1.4);
    for (const [at, gain] of [[0.062, 0.55], [0.089, 0.42], [0.118, 0.36], [0.151, 0.26], [0.178, 0.2], [0.243, 0.1]])
      mix(out, noiseBurst(sr, rng, 0.01, 0.0018, { hp: 700, lp: 5500 }), at * (right ? 1.07 : 0.96) + rng() * 0.006, gain * (0.6 + rng() * 0.55), sr);
    const tail = filter(filter(whiteNoise(sr, 1.3, rng), 'hp', 300, 0.7, sr), 'lp', sweep(6000, 900, 0.6), 0.7, sr);
    mix(out, envelope(tail, sr, 0.27, 0.04), 0.04, 0.045, sr);
    return fadeEdges(out, sr, 0, 0.05);
  };
  return normalize([channel(mulberry32(seed), false), channel(mulberry32(seed + 77), true)], 0.9) as Stereo;
}

/**
 * 屋里听到的雨声（6 秒，循环）。和屋外"沙沙"的雨完全不是一个声音：
 *   1. 一层闷闷的底噪（只留 110~1300 赫兹）：隔着屋顶传进来的雨；
 *   2. 雨点打铁皮：六秒里随机撒 1560 个"咔"（每个只有一个采样那么短），送进五个很尖的带通滤波器。
 *      每个滤波器被敲一下都会在自己的频率上嗡一小会儿，五个频率合起来就是铁皮屋顶"叮叮当当"的音色；
 *   3. 四声漏雨的滴水：很短的、往上滑的"嘀"。
 * 右声道是左声道错开半圈（3 秒）：两边听到的不是同一段，就有了立体感，又省掉一半的计算。
 */
export function rainInterior(sr: number, seed: number): Stereo {
  const rng = mulberry32(seed), seconds = 6;
  const out = whiteNoise(sr, seconds, rng), n = out.length;
  filter(out, 'lp', 1300, 0.6, sr, true); filter(out, 'hp', 110, 0.7, sr, true);
  for (let i = 0; i < n; i++) out[i] *= 0.8;
  const taps = silence(sr, seconds);
  for (let i = 0; i < 1560; i++) taps[Math.floor(rng() * n)] += (rng() < 0.5 ? -1 : 1) * (0.2 + Math.pow(rng(), 4) * 3);   // 四次方：绝大多数雨点很轻，偶尔一颗很重
  for (const [freq, q, gain] of [[1820, 14, 1], [2740, 16, 0.8], [4150, 18, 0.6], [6200, 14, 0.35], [940, 8, 0.7]]) {
    const ring = Float32Array.from(taps);
    filter(ring, 'bp', freq, q, sr, true); filter(ring, 'bp', freq, q, sr, true);   // 滤两遍：共振更干净
    for (let i = 0; i < n; i++) out[i] += ring[i] * gain * 5;
  }
  for (let d = 0; d < 4; d++) {
    const f0 = 900 + rng() * 700, len = Math.round(0.014 * sr), start = Math.floor(rng() * (n - len));
    let phase = 0;
    for (let i = 0; i < len; i++) { const k = i / len; phase += (2 * Math.PI * f0 * (1 + 0.8 * k)) / sr; out[start + i] += Math.sin(phase) * Math.sin(Math.PI * k) * 0.25; }
  }
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) right[i] = out[(i + (n >> 1)) % n];
  return normalize([out, right], 0.7) as Stereo;
}

/**
 * 枪声在车间里的尾音（2.3 秒）。枪响之后屋子"嗡——"的那一下，由三样东西叠成：
 *   1. 一条越来越闷的噪声尾巴（2400 → 260 赫兹）；
 *   2. 五个"房间共振"：屋子的长宽高决定了几个特别容易被激起来的低频（54~228 赫兹），枪声会让它们一起轰鸣；
 *   3. 八次越来越轻、越来越闷的"颤动回声"：声音在两面平行的铁皮墙之间来回弹，每 44 / 51 毫秒一次（左右声道不一样）。
 */
export function rifleTailIn(sr: number, seed: number): Stereo {
  const channel = (rng: Rng, right: boolean) => {
    const out = silence(sr, 2.3);
    const tail = filter(whiteNoise(sr, 2.25, rng), 'lp', sweep(2400, 260, 0.5), 0.7, sr);
    mix(out, envelope(tail, sr, 0.42, 0.012), 0.008, 0.6, sr);
    [54, 81, 117, 163, 228].forEach((freq, i) => {
      const room = filter(whiteNoise(sr, 2.2, rng), 'bp', freq * (right ? 1.06 : 1), 9, sr);
      mix(out, envelope(room, sr, 0.5, 0.02), 0.01, 2.4 * [1, 0.8, 0.6, 0.45, 0.3][i], sr);
    });
    for (let k = 0; k < 8; k++)
      mix(out, noiseBurst(sr, rng, 0.05, 0.009, { hp: 500, lp: 3800 / (1 + 0.35 * k) }), (k + 1) * (right ? 0.051 : 0.044) + (rng() - 0.5) * 0.006, 0.42 * Math.pow(0.74, k), sr);
    return fadeEdges(out, sr);
  };
  return normalize([channel(mulberry32(seed), false), channel(mulberry32(seed + 77), true)], 0.62) as Stereo;
}

/**
 * 枪声在露天的尾音（1.55 秒）：五下从箱垛上弹回来的回声（越晚越轻、越闷），一条 0.3 秒的短尾巴，再垫一下 150 赫兹以下的低频。
 */
export function rifleTailOut(sr: number, seed: number): Stereo {
  const channel = (rng: Rng) => {
    const out = silence(sr, 1.55);
    for (const [at, gain, lp] of [[0.066, 0.52, 4600], [0.088, 0.34, 3600], [0.124, 0.3, 2700], [0.169, 0.22, 2000], [0.231, 0.12, 1400]])
      mix(out, noiseBurst(sr, rng, 0.09, 0.016, { hp: 420, lp }), at + (rng() - 0.5) * 0.008, gain * (0.8 + rng() * 0.3), sr);
    const tail = filter(filter(whiteNoise(sr, 1.5, rng), 'lp', sweep(3400, 380, 0.6), 0.6, sr), 'hp', 130, 0.7, sr);
    mix(out, envelope(tail, sr, 0.3, 0.05), 0.03, 0.55, sr);
    const low = filter(whiteNoise(sr, 1.2, rng), 'lp', 150, 0.7, sr);
    mix(out, envelope(low, sr, 0.26, 0.03), 0.02, 0.9, sr);
    return fadeEdges(out, sr);
  };
  return normalize([channel(mulberry32(seed)), channel(mulberry32(seed + 77))], 0.5) as Stereo;
}

/**
 * 雷声（6.5 秒）。near = 打得近的那种：更亮，开头多一声"喀嚓"。
 *   · 主体是一条越来越闷的噪声；音量不是平滑地消失，而是叠了九个时刻随机的"鼓包" —— 雷声那种一阵一阵滚过来的感觉；
 *   · 底下垫一层 48 赫兹的隆隆声，涌上来得慢、拖得久。
 */
export function thunder(sr: number, seed: number, near: boolean) {
  const rng = mulberry32(seed), out = silence(sr, 6.5);
  const body = filter(whiteNoise(sr, 6.4, rng), 'lp', sweep(near ? 520 : 380, 70, 0.6), 0.7, sr);
  const rolls: [number, number, number][] = [];
  for (let i = 0; i < 9; i++) rolls.push([0.05 + rng() * 3.55, 0.12 + rng() * 0.38, 0.4 + rng() * 0.6]);   // [时刻, 宽度, 强度]
  // 音量的轮廓变化很慢（最窄的鼓包也有十分之一秒宽），所以每 32 个采样才重算一次，中间沿用上一次的值 —— 省掉九成多的指数运算
  for (let i = 0, k = 0; i < body.length; i++) {
    if ((i & 31) === 0) {
      const t = i / sr;
      k = 0.25;
      for (const [at, width, amp] of rolls) { const d = (t - at) / width; k += amp * Math.exp(-d * d); }
      k *= Math.exp(-t / 1.9) * (1 - Math.exp(-t / 0.05));
    }
    body[i] *= k;
  }
  mix(out, body, 0, 1, sr);
  const rumble = filter(whiteNoise(sr, 6, rng), 'bp', 48, 1.2, sr);
  mix(out, envelope(rumble, sr, 2, 0.2), 0.05, 3, sr);
  if (near) mix(out, noiseBurst(sr, rng, 0.3, 0.06, { hp: 300, lp: 2500 }), 0.02, 0.25, sr);
  return normalize([fadeEdges(out, sr, 0.0003, 0.3)], 0.8)[0];
}

/**
 * 脚步：水泥地（0.3 秒）。鞋跟的一声闷响（112 → 58 赫兹）+ 鞋底拍地的低频噪声 + 一点中频的"嚓" + 鞋底碾过沙砾的细碎高频。
 * variant 取 0~3：四个变体的音高略有不同，轮着放才不像复读机。
 */
export function stepConcrete(sr: number, seed: number, variant: number) {
  const rng = mulberry32(seed), out = silence(sr, 0.3), tune = [1, 1.07, 0.94, 1.03][variant & 3];
  mix(out, thump(sr, 0.06, 112 * tune, 58 * tune, 0.018, 0.02, 0.002), 0, 0.75, sr);
  mix(out, noiseBurst(sr, rng, 0.06, 0.016, { lp: 720 * tune }), 0, 0.9, sr);
  mix(out, noiseBurst(sr, rng, 0.1, 0.028, { bp: 2500 * tune, q: 0.7, attack: 0.004 }), 0.012, 0.22, sr);
  // 沙砾：高频噪声，音量每两毫秒随机跳一次，听起来是一粒一粒的
  const grit = noiseBurst(sr, rng, 0.2, 0.05, { hp: 3800, attack: 0.01 });
  for (let i = 0, a = 1; i < grit.length; i++) { if (i % 70 === 0) a = 0.3 + rng() * 0.7; grit[i] *= a; }
  mix(out, grit, 0.02, 0.16, sr);
  return normalize([fadeEdges(out, sr)], 0.45)[0];
}

/**
 * 脚步：钢板（钢梯、走道、箱顶，0.38 秒）。同样的一声闷响，上面叠六个不成整数倍的金属泛音（178~3130 赫兹）——
 * 低的几个响得久、高的转眼就没，这是薄钢板被踩了一脚的"哐"。
 */
export function stepMetal(sr: number, seed: number, variant: number) {
  const rng = mulberry32(seed), out = silence(sr, 0.38), tune = [1, 1.08, 0.92][variant % 3];
  mix(out, thump(sr, 0.06, 120, 62, 0.018, 0.02, 0.002), 0, 0.6, sr);
  mix(out, noiseBurst(sr, rng, 0.04, 0.008, { lp: 2400 }), 0, 0.6, sr);
  mix(out, modes(sr, 0.36, [[178 * tune, 0.09, 1], [412 * tune, 0.075, 0.8], [733 * tune, 0.06, 0.55], [1214 * tune, 0.045, 0.4], [1958 * tune, 0.03, 0.3], [3130 * tune, 0.016, 0.18]], rng), 0.001, 0.3, sr);
  mix(out, noiseBurst(sr, rng, 0.08, 0.02, { bp: 3000, q: 0.8, attack: 0.003 }), 0.01, 0.1, sr);
  return normalize([fadeEdges(out, sr)], 0.5)[0];
}

/**
 * 脚步：木头（木箱、托盘、工作台，0.3 秒）。参考没有单独的木头脚步（它把水泥的那一声调高一点凑合），这个是自己配的：
 * 木板是空的，踩上去是一声带点音高的"笃" —— 一个比水泥更高、更短的闷响，加两三个很快消失的低泛音（木头的共振比铁板钝得多），不带沙砾声。
 */
export function stepWood(sr: number, seed: number, variant: number) {
  const rng = mulberry32(seed), out = silence(sr, 0.3), tune = [1, 1.09, 0.93][variant % 3];
  mix(out, thump(sr, 0.07, 190 * tune, 96 * tune, 0.014, 0.024, 0.0015), 0, 0.8, sr);
  mix(out, noiseBurst(sr, rng, 0.05, 0.012, { lp: 1100 * tune }), 0, 0.7, sr);
  mix(out, modes(sr, 0.2, [[236 * tune, 0.05, 1], [548 * tune, 0.03, 0.5], [910 * tune, 0.018, 0.3]], rng), 0.001, 0.35, sr);
  mix(out, noiseBurst(sr, rng, 0.05, 0.012, { bp: 1900, q: 1.2, attack: 0.002 }), 0.008, 0.14, sr);
  return normalize([fadeEdges(out, sr)], 0.48)[0];
}

/** 整数个周期：循环的声音里每个成分都得在结尾正好转完整数圈，不然接缝处会"咔"一下。把频率挪到最近的"刚好转整数圈"的值上。 */
const whole = (freq: number, seconds: number) => Math.round(freq * seconds) / seconds;

/**
 * 无人机的旋翼声（2 秒，循环）。四只旋翼各有一个略微不同的音高（184~258 赫兹），每个带几层泛音、音量各自缓慢起伏，
 * 四个凑在一起互相"打架"，就是多旋翼那种嗡嗡的拍频；再加一层被桨叶切碎的气流声（每秒 46 下）。
 * 播放时再按飞行速度整体变调。
 */
export function rotorLoop(sr: number, seed: number) {
  const rng = mulberry32(seed), seconds = 2, out = silence(sr, seconds), n = out.length;
  for (const [freq, wobble] of [[184, 2.5], [207.5, 3.5], [233, 2], [258.5, 4.5]]) {
    const f = whole(freq, seconds), w = whole(wobble, seconds), p0 = rng() * 6.283, p1 = rng() * 6.283;
    for (let i = 0; i < n; i++) {
      const t = i / sr, a = 2 * Math.PI * f * t + p0;
      out[i] += (Math.sin(a) + 0.5 * Math.sin(2 * a + 1) + 0.3 * Math.sin(3 * a + 2) + 0.16 * Math.sin(4 * a) + 0.08 * Math.sin(6 * a)) * (0.72 + 0.28 * Math.sin(2 * Math.PI * w * t + p1)) * 0.25;
    }
  }
  const air = filter(filter(whiteNoise(sr, seconds, rng), 'hp', 1100, 0.7, sr, true), 'lp', 5200, 0.7, sr, true), chop = whole(46, seconds);
  for (let i = 0; i < n; i++) out[i] += air[i] * (0.55 + 0.45 * Math.sin((2 * Math.PI * chop * i) / sr)) * 0.5;
  return normalize([out], 0.6)[0];
}

/**
 * 机器狗的伺服电机声（2 秒，循环）：一个 310 赫兹上下颤动的"吱——"（电机的啸叫），底下是 62 赫兹的嗡嗡声（减速箱），再加一点高频的嘶嘶。
 * 播放时按它走得多快来调音量和音高：站着几乎听不见，跑起来才响。
 */
export function servoLoop(sr: number, seed: number) {
  const rng = mulberry32(seed), seconds = 2, out = silence(sr, seconds), n = out.length;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const vibrato = 1.1 * Math.sin(2 * Math.PI * 0.5 * t) + 0.5 * Math.sin(2 * Math.PI * 1.5 * t + 1);   // 音高的颤动
    const a = 2 * Math.PI * 310 * t + vibrato, swell = 0.7 + 0.3 * Math.sin(2 * Math.PI * 1.5 * t), b = 2 * Math.PI * 62 * t;
    out[i] = (Math.sin(a) + 0.45 * Math.sin(2 * a + vibrato) + 0.2 * Math.sin(4 * a + 0.5)) * 0.3 * swell
      + (Math.sin(b) + 0.5 * Math.sin(2 * b) + 0.33 * Math.sin(3 * b) + 0.2 * Math.sin(5 * b)) * 0.28;
  }
  const hiss = filter(filter(whiteNoise(sr, seconds, rng), 'hp', 2800, 0.7, sr, true), 'lp', 7000, 0.7, sr, true);
  for (let i = 0; i < n; i++) out[i] += hiss[i] * 0.12 * (0.6 + 0.4 * Math.sin((2 * Math.PI * 1.5 * i) / sr + 2));
  return normalize([out], 0.42)[0];
}
