import * as THREE from 'three';
import { fbm, mulberry32, vnoise } from '../core/math';

// 所有贴图都在这里用 canvas 现画，没有任何图片文件。
// 思路：先画底色，再叠噪声做脏污，最后写字。

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d')! };
}

function finish(c: HTMLCanvasElement, srgb = true, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** 给整张画布乘上一层噪声，做出雨水冲刷后的脏污感。 */
function grime(g: CanvasRenderingContext2D, w: number, h: number, seed: number, strength: number, bottomDark = 0.25) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = fbm(x / 90 + seed, y / 40 + seed * 1.7, 4);
      const streak = vnoise(x / 6 + seed * 3, y / 160);
      const bottom = Math.pow(y / h, 3) * bottomDark;
      const k = 1 - strength * (0.6 * n + 0.4 * streak * (y / h)) - bottom;
      const i = (y * w + x) * 4;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
  }
  g.putImageData(img, 0, 0);
}

/** 波纹板法线贴图：直接由梯形波的斜率算出来，让灯光能勾出一道道棱。 */
export function corrugationNormal(ribs = 46) {
  const W = 1024, H = 4;
  const { c, g } = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let x = 0; x < W; x++) {
    const p = ((x / W) * ribs) % 1;
    // 梯形波：平-下坡-平-上坡
    const slope = p > 0.2 && p < 0.3 ? -1 : p > 0.7 && p < 0.8 ? 1 : 0;
    const nx = -slope * 0.75, nz = Math.sqrt(1 - nx * nx);
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = 128; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, false, true);
}

/**
 * 沥青路面：颜色图 + 法线图。
 *
 * 沥青是"黑色的胶 + 一粒粒碎石子"压出来的，表面其实坑坑洼洼。下雨之后它并不会变成镜子：
 * 石子的尖还露在水膜外面，所以远看是一片细碎的闪光，只有真正积了水的坑才是平的镜面。
 * 这张法线图画的就是那些石子；积水在哪里、有多平，是着色器按世界坐标另算的。
 */
export function asphaltTextures() {
  const S = 512, rng = mulberry32(42);
  // 高度：每颗石子是一个小鼓包，大小不一，密密地铺满
  const h = new Float32Array(S * S);
  for (let k = 0; k < 15000; k++) {
    const cx = rng() * S, cy = rng() * S, rad = 1.2 + rng() * rng() * 4.2, top = 0.4 + rng() * 0.6, R = Math.ceil(rad);
    for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
      const d = Math.hypot(ox, oy) / rad; if (d >= 1) continue;
      const i = ((((cy + oy) | 0) + S) % S) * S + ((((cx + ox) | 0) + S) % S);
      h[i] = Math.max(h[i], top * (1 - d * d));
    }
  }
  const H = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  const col = canvas(S, S), nor = canvas(S, S);
  const ci = col.g.createImageData(S, S), ni = nor.g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, hv = h[y * S + x];
    // 颜色：胶是近黑的，石子磨出来的顶是灰的，偶尔有一颗偏浅或偏褐
    const patch = fbm(x / 70, y / 70, 3), stone = hv * hv, tint = vnoise(x / 3.1 + 40, y / 3.1);
    const v = 26 + patch * 8 + stone * (20 + tint * 26);
    ci.data[i] = v * (1 + (tint - 0.5) * 0.14); ci.data[i + 1] = v; ci.data[i + 2] = v * (1.03 - (tint - 0.5) * 0.1); ci.data[i + 3] = 255;
    const dx = (H(x - 1, y) - H(x + 1, y)) * 1.5, dy = (H(x, y - 1) - H(x, y + 1)) * 1.5, l = Math.hypot(dx, dy, 1);
    ni.data[i] = (dx / l * 0.5 + 0.5) * 255; ni.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255; ni.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; ni.data[i + 3] = 255;
  }
  col.g.putImageData(ci, 0, 0); nor.g.putImageData(ni, 0, 0);
  return { map: finish(col.c, true, true), normalMap: finish(nor.c, false, true) };
}

/** 标线的磨损：一张灰度图当透明度用。车轮碾过的地方漆掉得多，露出下面的沥青。 */
export function paintWearTexture() {
  const S = 256, { c, g } = canvas(S, S), img = g.createImageData(S, S), rng = mulberry32(5);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x / 26, y / 26, 4), fine = rng();
    const v = Math.max(0.12, Math.min(1, (n - 0.4) * 4.5)) * (0.75 + fine * 0.25) * (fine < 0.06 ? 0.3 : 1); // 大片的剥落 + 石子尖上磨掉的小点
    const i = (y * S + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = finish(c, false, true); t.repeat.set(1, 1);
  return t;
}

/** 通用标牌：港区里所有的告示、铭牌都用它生成。 */
export function signTexture(lines: string[], opt: { w?: number; h?: number; bg?: string; fg?: string; stripe?: boolean; size?: number } = {}) {
  const W = opt.w ?? 512, H = opt.h ?? 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = opt.bg ?? '#d9a520';
  g.fillRect(0, 0, W, H);
  if (opt.stripe) {
    g.fillStyle = '#111';
    for (let x = -H; x < W + H; x += 44) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + 22, H); g.lineTo(x + 22 + 26, H - 26); g.lineTo(x + 26, H - 26); g.fill(); }
  }
  g.strokeStyle = opt.fg ?? '#111'; g.lineWidth = 6; g.strokeRect(8, 8, W - 16, H - 16);
  g.fillStyle = opt.fg ?? '#111';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const size = opt.size ?? Math.min(72, (H - 60) / lines.length);
  lines.forEach((ln, i) => {
    g.font = `${i === 0 ? 900 : 600} ${i === 0 ? size : size * 0.6}px ${FONT}`;
    g.fillText(ln, W / 2, H / 2 + (i - (lines.length - 1) / 2) * size * 0.95 - (opt.stripe ? 10 : 0));
  });
  grime(g, W, H, lines[0].length * 3.3, 0.3, 0.1);
  return finish(c);
}

/** 地面喷字（如 B4），透明底。 */
export function stencilTexture(text: string) {
  const { c, g } = canvas(512, 256);
  g.clearRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(232,210,120,.85)';
  g.font = `900 210px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 138);
  const img = g.getImageData(0, 0, 512, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const x = (i / 4) % 512, y = Math.floor(i / 4 / 512);
    img.data[i + 3] *= 0.45 + 0.55 * fbm(x / 20, y / 20, 3);
  }
  g.putImageData(img, 0, 0);
  return finish(c);
}

/** 船楼和仓库的窗户：大部分黑着，零星几扇亮着灯。 */
export function windowsTexture(cols: number, rows: number, seed: number, lit = 0.25) {
  const cw = 32, ch = 32;
  const { c, g } = canvas(cols * cw, rows * ch);
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  const rng = mulberry32(seed);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (rng() < lit) {
      g.fillStyle = rng() < 0.7 ? '#ffc070' : '#bcd8ff';
      g.fillRect(x * cw + 6, y * ch + 8, cw - 12, ch - 16);
    }
  }
  return finish(c);
}
