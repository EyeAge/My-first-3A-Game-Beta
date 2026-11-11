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

const RIBS = 46;

/** 集装箱长侧面。底色是中灰，实例颜色会乘上来；白字因此变成"同色系的浅色喷字"。 */
export function containerSideTexture(brand: string, sub: string, seed: number) {
  const W = 1024, H = 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = '#9a9a9a';
  g.fillRect(0, 0, W, H);
  // 波纹板的明暗
  for (let x = 0; x < W; x++) {
    const p = ((x / W) * RIBS) % 1;
    const s = p < 0.25 ? 1.0 : p < 0.5 ? 0.86 : p < 0.75 ? 0.7 : 0.86;
    g.fillStyle = `rgba(0,0,0,${(1 - s) * 0.5})`;
    g.fillRect(x, 0, 1, H);
  }
  // 上下横梁
  g.fillStyle = 'rgba(0,0,0,.28)';
  g.fillRect(0, 0, W, 9); g.fillRect(0, H - 11, W, 11);
  // 喷字
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.textBaseline = 'middle';
  g.font = `900 92px ${FONT}`;
  g.fillText(brand, 560, 112);
  g.font = `600 24px ${FONT}`;
  g.fillText(sub, 564, 186);
  g.font = `700 22px ui-monospace, monospace`;
  g.fillText(`SLTU ${402719 + seed * 137} ${seed % 10}`, 40, 40);
  g.font = `500 15px ${FONT}`;
  g.fillText('最大总重 30 480 千克', 40, 68);
  g.fillText('皮重 3 750 千克  净重 26 730 千克', 40, 88);
  g.fillText('容积 67.7 立方米', 40, 108);
  // 锈迹：从顶部往下淌
  const rng = mulberry32(seed * 977 + 5);
  for (let i = 0; i < 26; i++) {
    const x = rng() * W, len = 30 + rng() * 170, wdt = 2 + rng() * 7;
    const gr = g.createLinearGradient(0, 0, 0, len);
    gr.addColorStop(0, 'rgba(40,18,6,.55)'); gr.addColorStop(1, 'rgba(40,18,6,0)');
    g.fillStyle = gr;
    g.fillRect(x, rng() < 0.7 ? 0 : rng() * 120, wdt, len);
  }
  grime(g, W, H, seed * 3.1, 0.45);
  return finish(c);
}

/** 波纹板法线贴图：直接由梯形波的斜率算出来，让灯光能勾出一道道棱。 */
export function corrugationNormal(ribs = RIBS) {
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

/** 集装箱门端：两扇门、四根锁杆、检验铭牌。 */
export function containerEndTexture(seed: number) {
  const S = 256;
  const { c, g } = canvas(S, S);
  g.fillStyle = '#959595';
  g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.fillRect(0, 0, S, 8); g.fillRect(0, S - 10, S, 10); g.fillRect(0, 0, 7, S); g.fillRect(S - 7, 0, 7, S);
  g.fillRect(S / 2 - 2, 0, 4, S);
  for (let k = 0; k < 5; k++) { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(8, 30 + k * 46, S - 16, 14); }
  for (const x of [40, 92, 164, 216]) {
    g.fillStyle = 'rgba(20,20,20,.75)'; g.fillRect(x - 3, 6, 6, S - 14);
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x - 3, 6, 2, S - 14);
    g.fillStyle = 'rgba(15,15,15,.9)'; g.fillRect(x - 9, 128, 18, 9);
  }
  g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(140, 150, 62, 44);
  g.fillStyle = '#222'; g.font = `700 9px ${FONT}`;
  g.fillText('安全检验铭牌', 144, 162);
  g.font = `500 7px ${FONT}`;
  g.fillText('检验编号 SL/PA-4207/19', 144, 173);
  g.fillText('下次检验 2027年09月', 144, 183);
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `700 16px ui-monospace, monospace`;
  g.fillText(`B4-0${271 + seed}`, 150, 40);
  grime(g, S, S, seed * 7.7 + 2, 0.4);
  return finish(c);
}

/** 沥青：深色底 + 细碎颗粒。积水是在着色器里做的，不在这张图上。 */
export function asphaltTexture() {
  const S = 512;
  const { c, g } = canvas(S, S);
  const img = g.createImageData(S, S);
  const rng = mulberry32(42);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x / 60, y / 60, 4) * 0.5 + rng() * 0.5;
    const v = 34 + n * 38;
    const i = (y * S + x) * 4;
    img.data[i] = v; img.data[i + 1] = v * 1.01; img.data[i + 2] = v * 1.04; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return finish(c, true, true);
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
