import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 粒子的"图集"：启动时用代码算出来的两张小贴图，烟团、火焰、火星、光晕的形状全在里面。
//
// 为什么不在着色器里现算形状？以前就是那么做的：每个粒子是一个方形的点，片元里现算两层噪声去啃它的边。
// 结果有两个毛病 —— 噪声的格子看得出来；方形的四条边上亮度不保证为零，大火球能看到笔直的切边（"像素方块"）。
//
// 现在把形状提前烘进贴图，运行时每个像素只采样一次。烘的时候用三招保证"看不出是一张方片"：
//   1. 四边归零：每一格最后都乘一个方形边框的淡出，四条边上的值必为 0，方片的直边上永远没有可见像素。
//   2. 域扭曲：先用一层低频噪声把采样坐标推歪，再去算形状。噪声本身的格子结构被扭掉了，烟团的轮廓是歪歪扭扭的一团。
//   3. 带 mipmap：粒子缩得很小时采样到的是提前缩小好的版本，不会闪。
//
// 两张图集都是 4 列 × 2 行共 8 格，每格 128 像素。

export const ATLAS_COLS = 4, ATLAS_ROWS = 2;

/** 受光图集（烟、尘、水柱、火球）的格子编号。0–5 是六种普通烟团，发射时随机挑一种。 */
export const LIT_FRAME = { PUFF_VARIANTS: 6, WATER: 6, DENSE: 7 } as const;
/** 叠加图集（发光的东西）的格子编号。 */
export const ADD_FRAME = { GLOW: 0, STREAK: 1, STAR_A: 2, STAR_B: 3, RING: 4, FIRE: 5, DOT: 6, JET: 7 } as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 平滑阶跃：x 从 a 到 b，输出从 0 平滑地升到 1。 */
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * 噪声发生器。一张 64×64 的随机数表，取值时在格点之间平滑插值（"值噪声"）。
 * fbm 把几层不同粗细的噪声叠起来：第一层定大轮廓，后面每层频率翻倍、幅度减半，添细节。
 * 每层的倍率用 2.03 而不是 2，再加一个偏移：不然各层的格点会对齐，格子感反而被加强。
 */
function makeNoise(seed: number) {
  const rnd = mulberry32(seed), table = new Float32Array(64 * 64);
  for (let i = 0; i < table.length; i++) table[i] = rnd();
  const at = (x: number, y: number) => table[((y & 63) << 6) | (x & 63)];
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u, bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
    return top + (bottom - top) * v;
  };
  const fbm = (x: number, y: number, octaves = 4) => {
    let amp = 0.5, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) { sum += amp * noise(x, y); norm += amp; x = x * 2.03 + 17.1; y = y * 2.03 + 9.7; amp *= 0.5; }
    return sum / norm;
  };
  return { noise, fbm, rnd };
}

/**
 * 受光图集的像素。四个通道各存一样东西：
 *   R、G  鼓包的法线（表面朝哪边歪），着色器用它算"这一小块朝不朝太阳"，烟团才有一鼓一鼓的立体感
 *   B     厚度：中间厚、边上薄。厚的地方更暗（光透不进去），薄的边在逆光时会透亮
 *   A     不透明度
 * 第 0–5 格是普通烟团，第 6 格是一片往上喷的水柱，第 7 格是更实、更圆的一团（碎屑、浓烟、火球的芯）。
 */
export function bakeLitAtlas(cell = 128): Uint8Array {
  const N = makeNoise(9173), W = cell * ATLAS_COLS, pixels = new Uint8Array(W * cell * ATLAS_ROWS * 4);
  const alpha = new Float32Array(cell * cell), thick = new Float32Array(cell * cell), height = new Float32Array(cell * cell);
  for (let frame = 0; frame < 8; frame++) {
    const ox = (frame % ATLAS_COLS) * cell, oy = Math.floor(frame / ATLAS_COLS) * cell;
    const f = frame * 13.37 + 3.1, p = frame * 7.77 + 1.3;   // 每一格在噪声里取不同的位置，所以八格各不相同
    for (let row = 0; row < cell; row++) for (let col = 0; col < cell; col++) {
      const gx = ((col + 0.5) / cell) * 2 - 1, gy = ((row + 0.5) / cell) * 2 - 1;   // 格内坐标 -1..1，gy=+1 是方片的顶边
      const edge = 1 - smooth(0.78, 0.98, Math.max(Math.abs(gx), Math.abs(gy)));    // 方形边框淡出：四条边上必为 0
      let a: number, t: number, h: number;
      if (frame === LIT_FRAME.WATER) {
        const up = gy * 0.5 + 0.5;                                        // 0 是水柱根部，1 是顶
        const halfWidth = 0.16 + 0.5 * up * up;                           // 越往上越宽，像个喇叭口
        const sway = (N.fbm(gx * 2 + f, up * 2 + p, 3) - 0.5) * 0.25;     // 整体左右摆一点
        const body = 1 - smooth(halfWidth * 0.3, halfWidth, Math.abs(gx + sway * up));
        const streaks = N.fbm(gx * 9 + f, up * 2.2 + p, 4);               // 横向频率高、纵向频率低 = 竖着的水丝
        const top = 1 - smooth(0.55, 0.95, up - (N.noise(gx * 6 + f, 3.3) - 0.5) * 0.35);   // 顶部参差不齐
        const bottom = smooth(0, 0.12, up);
        a = body * top * bottom * smooth(0.22, 0.7, streaks + 0.25 * (1 - up));
        t = body * top;
        h = a * 0.5;
      } else {
        const dense = frame === LIT_FRAME.DENSE, warp = dense ? 0.3 : 0.6;
        // 域扭曲：把要采样的位置先推歪。推多远、往哪推，由另一层低频噪声决定
        const wx = (N.fbm(gx * 1.4 + f, gy * 1.4 + p, 3) - 0.5) * warp, wy = (N.fbm(gx * 1.4 + p + 5.2, gy * 1.4 + f + 1.7, 3) - 0.5) * warp;
        const zx = gx + wx, zy = gy + wy, r = Math.hypot(zx, zy);
        const bite = (N.fbm(zx * 2.2 + f, zy * 2.2 + p, 3) - 0.5) * 0.6;
        const falloff = 1 - smooth(0, dense ? 0.84 : 0.8, r + bite);      // 从中心往外变淡，边界被噪声啃得不圆
        const detail = N.fbm(zx * 4.2 + f * 2, zy * 4.2 + p * 2, 5);
        const density = falloff * (dense ? 0.8 + 0.7 * detail : 0.25 + 1.5 * detail);
        a = smooth(dense ? 0.02 : 0.06, dense ? 0.7 : 0.95, density);
        t = falloff;
        h = falloff * 0.55 + falloff * N.fbm(zx * 3.1 + f * 3, zy * 3.1 + p * 3, 3) * 0.9;
      }
      const i = row * cell + col;
      alpha[i] = a * edge; thick[i] = t; height[i] = h * edge;
    }
    // 法线：把 height 当成一张地形高度图，隔两个像素取高度差，坡越陡法线越歪
    for (let row = 0; row < cell; row++) for (let col = 0; col < cell; col++) {
      const l = Math.max(0, col - 2), r = Math.min(cell - 1, col + 2), d = Math.max(0, row - 2), u = Math.min(cell - 1, row + 2);
      const nx = -(height[row * cell + r] - height[row * cell + l]) * (cell / 8) * 0.55, ny = -(height[u * cell + col] - height[d * cell + col]) * (cell / 8) * 0.55;
      const len = Math.hypot(nx, ny, 1), i = row * cell + col, o = ((oy + row) * W + ox + col) * 4;
      pixels[o] = Math.round(((nx / len) * 0.5 + 0.5) * 255); pixels[o + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      pixels[o + 2] = Math.min(255, thick[i] * 255); pixels[o + 3] = Math.min(255, alpha[i] * 255);
    }
  }
  return pixels;
}

/**
 * 叠加图集的像素：只有亮度（灰度写进 RGB），颜色由粒子自己带。八格分别是：
 *   0 光晕  1 火星条（两头软的短条）  2、3 两种星芒（中心一点 + 几根长短不一的刺）
 *   4 冲击环  5 火团  6 实心圆点（水滴、玻璃渣）  7 喷焰（一头亮一头尖，曳光和枪口喷焰用）
 */
export function bakeAddAtlas(cell = 128): Uint8Array {
  const N = makeNoise(4441), W = cell * ATLAS_COLS, pixels = new Uint8Array(W * cell * ATLAS_ROWS * 4);
  // 星芒的刺：每种星芒 7–10 根，角度大致均分再抖一点，长度、粗细、亮度各自随机
  const spikeSets = [0, 1].map(() => {
    const n = 7 + Math.floor(N.rnd() * 4);
    return Array.from({ length: n }, (_, k) => ({ angle: (k / n + (N.rnd() - 0.5) * 0.12) * Math.PI * 2, length: 0.35 + N.rnd() * 0.6, width: 0.018 + N.rnd() * 0.05, gain: 0.5 + N.rnd() * 0.5 }));
  });
  for (let frame = 0; frame < 8; frame++) {
    const ox = (frame % ATLAS_COLS) * cell, oy = Math.floor(frame / ATLAS_COLS) * cell;
    for (let row = 0; row < cell; row++) for (let col = 0; col < cell; col++) {
      const x = ((col + 0.5) / cell) * 2 - 1, y = ((row + 0.5) / cell) * 2 - 1, d = Math.hypot(x, y);
      let g = 0;
      if (frame === ADD_FRAME.GLOW) {
        const k = Math.max(0, 1 - d);
        g = k * k * k * 0.75 + Math.exp(-d * d * 22) * 0.5;               // 一个宽的柔光 + 中心一个更亮的小核
      } else if (frame === ADD_FRAME.STREAK) {
        g = Math.exp(-(y * y) / (0.42 * 0.42)) * Math.pow(Math.max(0, 1 - x * x), 1.5);
      } else if (frame === ADD_FRAME.STAR_A || frame === ADD_FRAME.STAR_B) {
        const theta = Math.atan2(y, x);
        for (const s of spikeSets[frame - ADD_FRAME.STAR_A]) {
          let off = Math.abs(theta - s.angle) % (Math.PI * 2);            // 这个像素的方向和这根刺差多少角度
          if (off > Math.PI) off = Math.PI * 2 - off;
          if (off >= 1.5) continue;
          const across = Math.sin(off) * d;                               // 到这根刺中轴线的垂直距离
          g += s.gain * Math.exp(-(across * across) / (s.width * s.width * (0.4 + d))) * Math.pow(Math.max(0, 1 - d / s.length), 1.4);
        }
        g = g * (0.7 + 0.6 * N.fbm(x * 5 + frame * 9, y * 5, 3)) + Math.exp(-d * d * 70) * 1.2 + Math.max(0, 1 - d * 2.2) * 0.06;
      } else if (frame === ADD_FRAME.RING) {
        const theta = Math.atan2(y, x), cs = Math.cos(theta), sn = Math.sin(theta);
        const radius = 0.78 + (N.noise(cs * 2 + 5, sn * 2 + 5) - 0.5) * 0.04;   // 环不是正圆，半径沿圆周有一点起伏
        g = Math.exp(-((d - radius) * (d - radius)) / (0.03 * 0.03)) * (0.6 + 0.4 * N.noise(cs * 5 + 9, sn * 5 + 9)) + 0.05 * smooth(0.2, 0.78, d) * (1 - smooth(0.78, 0.8, d));
      } else if (frame === ADD_FRAME.FIRE) {
        const wx = (N.fbm(x * 1.6 + 3.3, y * 1.6 + 8.1, 3) - 0.5) * 0.5, wy = (N.fbm(x * 1.6 + 7.7, y * 1.6 + 2.2, 3) - 0.5) * 0.5;
        const zx = x + wx, zy = y + wy, falloff = 1 - smooth(0, 0.84, Math.hypot(zx, zy));
        g = smooth(0.04, 0.9, falloff * (0.3 + 1.4 * N.fbm(zx * 4 + 1.1, zy * 4 + 6.6, 5))) * (0.45 + 0.75 * falloff);
      } else if (frame === ADD_FRAME.DOT) {
        g = 1 - smooth(0.3, 0.62, d);
      } else {
        const along = x * 0.5 + 0.5, halfWidth = 0.22 + 0.3 * along;      // along：0 是尖尾，1 是亮头（在 +x 一侧）
        g = Math.exp(-(y * y) / (halfWidth * halfWidth)) * Math.pow(along, 1.8) * 1.15;
        if (x > 0.8) { const k = (x - 0.8) / 0.16; g *= Math.max(0, 1 - k * k); }   // 亮的那一头收成圆的，不是齐头切断
      }
      g *= 1 - smooth(0.86, 0.99, Math.max(Math.abs(x), Math.abs(y)));    // 四边归零
      const o = ((oy + row) * W + ox + col) * 4, v = Math.round(clamp01(g) * 255);
      pixels[o] = pixels[o + 1] = pixels[o + 2] = v; pixels[o + 3] = 255;
    }
  }
  return pixels;
}

/** 把烘好的像素包成贴图。不是颜色数据（是法线、厚度、亮度），所以不做 sRGB 解码。 */
export function atlasTexture(pixels: Uint8Array, cell = 128): THREE.DataTexture {
  const tex = new THREE.DataTexture(pixels, cell * ATLAS_COLS, cell * ATLAS_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
