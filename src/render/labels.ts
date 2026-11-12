import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 文字和贴纸的"图集"。
//
// 叉车的车号、油桶上的"易燃"、木箱上的喷字……每一处都是一张贴在模型表面的小面片。
// 如果每张面片各用一张贴图，画一百处字就是一百次绘制调用。所以这里把所有的字都画到同一张大图上，
// 每处只记住"我的字在大图的哪一块"。于是全场所有的字共用一张贴图、一个材质，可以合并成一次绘制。

export interface LabelOpts {
  /** 字的颜色：几个常用名，或者任意 CSS 颜色。 */
  color?: 'white' | 'black' | 'yellow' | 'red' | 'orange' | (string & {});
  /** stencil 是镂空喷字（笔画有断开的"桥"，像用漏字板喷的）；sans 是普通印刷字。 */
  font?: 'stencil' | 'sans';
  /** 做旧程度 0–1：被磨掉的斑块和划痕有多少。 */
  distress?: number;
}
/** 一块字在图集里的位置（贴图坐标）和它的宽高比。 */
export interface Patch { uv: [number, number, number, number]; aspect: number }

const SIZE = 2048, PAD = 4;
const COLORS: Record<string, string> = { white: '#d8d6cc', black: '#15171a', yellow: '#d2a021', red: '#a12a1e', orange: '#c2591c' };

let canvas: HTMLCanvasElement | null = null, ctx: CanvasRenderingContext2D, tex: THREE.CanvasTexture, mat: THREE.MeshStandardMaterial;
// "货架式"排版：从左到右摆，一行摆满了另起一行
let penX = PAD, penY = PAD, rowH = 0;
const cache = new Map<string, Patch>();

function ensure() {
  if (canvas) return;
  canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
  ctx = canvas.getContext('2d')!;
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  // 贴片比底下的表面只高出一根头发丝，用 polygonOffset 让它稳稳地盖在上面而不闪烁
  mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mat.name = 'labels';
}

/** 在图集里占一块 w×h 的地方，返回左上角。 */
function alloc(w: number, h: number): [number, number] {
  if (penX + w + PAD > SIZE) { penX = PAD; penY += rowH + PAD; rowH = 0; }
  if (penY + h + PAD > SIZE) { console.warn('[labels] 图集放满了，后面的字会叠在一起'); penX = PAD; penY = PAD; rowH = 0; }
  const at: [number, number] = [penX, penY];
  penX += w + PAD; rowH = Math.max(rowH, h);
  return at;
}
function patch(x: number, y: number, w: number, h: number): Patch {
  tex.needsUpdate = true;
  return { uv: [x / SIZE, 1 - (y + h) / SIZE, (x + w) / SIZE, 1 - y / SIZE], aspect: w / h };
}

/** 做旧：从画好的字上抠掉一些斑块、划痕和麻点。 */
function distress(x: number, y: number, w: number, h: number, n: number, rng: () => number) {
  if (n <= 0) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n * 26; i++) { // 斑块
    ctx.globalAlpha = 0.25 + rng() * 0.6;
    ctx.beginPath(); ctx.ellipse(x + rng() * w, y + rng() * h, 2 + rng() * h * 0.16, 1 + rng() * h * 0.09, rng() * 3.14, 0, 6.283); ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < n * 14; i++) { // 划痕
    ctx.globalAlpha = 0.3 + rng() * 0.5; ctx.lineWidth = 0.6 + rng() * 1.6;
    const sx = x + rng() * w, sy = y + rng() * h, a = rng() * 6.283, l = 6 + rng() * h * 0.7;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); ctx.stroke();
  }
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < n * 240; i++) ctx.fillRect(x + rng() * w, y + rng() * h, 1, 1); // 麻点
  ctx.restore();
}

/** 一行字。同样的字、同样的选项只画一次。 */
export function label(text: string, o: LabelOpts = {}): Patch {
  ensure();
  const key = `L|${text}|${o.color ?? 'white'}|${o.font ?? 'stencil'}|${o.distress ?? 0.35}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const H = 72, stencil = (o.font ?? 'stencil') === 'stencil';
  ctx.font = `${stencil ? 900 : 700} ${H * 0.82}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif`;
  const w = Math.min(SIZE - PAD * 2, Math.ceil(ctx.measureText(text).width + (stencil ? text.length * 4 : 0)) + 8);
  const [x, y] = alloc(w, H);
  ctx.save();
  ctx.fillStyle = COLORS[o.color ?? 'white'] ?? o.color!;
  ctx.textBaseline = 'middle';
  if (stencil) {
    // 逐字画，字距拉开一点；再横着抠掉两道细缝，就是漏字板的"断桥"
    let px = x + 4;
    for (const ch of text) { ctx.fillText(ch, px, y + H / 2 + 2); px += ctx.measureText(ch).width + 4; }
    ctx.globalCompositeOperation = 'destination-out';
    for (const k of [0.36, 0.66]) ctx.fillRect(x, y + H * k, w, 3);
  } else ctx.fillText(text, x + 4, y + H / 2 + 2, w - 8);
  ctx.restore();
  let seed = 7; for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  distress(x, y, w, H, o.distress ?? 0.35, mulberry32(seed));
  const p = patch(x, y, w, H);
  cache.set(key, p);
  return p;
}

/**
 * 具名贴纸（危险品菱形、禁烟、箭头……）。
 * 认识的名字画成对应的图案；不认识的先画成一块写着名字的牌子，不至于空着。
 */
export function decal(name: string): Patch {
  ensure();
  const key = `D|${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const S = 128, [x, y] = alloc(S, S);
  ctx.save();
  ctx.translate(x, y);
  const draw = DECALS[name];
  if (draw) draw(ctx, S);
  else {
    ctx.fillStyle = '#d2a021'; ctx.fillRect(4, 4, S - 8, S - 8);
    ctx.strokeStyle = '#15171a'; ctx.lineWidth = 5; ctx.strokeRect(8, 8, S - 16, S - 16);
    ctx.fillStyle = '#15171a'; ctx.font = '700 22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, S / 2, S / 2, S - 24);
  }
  ctx.restore();
  let seed = 3; for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  distress(x, y, S, S, 0.25, mulberry32(seed));
  const p = patch(x, y, S, S);
  cache.set(key, p);
  return p;
}

type Draw = (g: CanvasRenderingContext2D, S: number) => void;
/** 菱形危险品标：底色、图形色、中间一个字。 */
const diamond = (bg: string, fg: string, ch: string): Draw => (g, S) => {
  g.translate(S / 2, S / 2); g.rotate(Math.PI / 4);
  const r = S * 0.33;
  g.fillStyle = bg; g.fillRect(-r, -r, r * 2, r * 2);
  g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(-r + 5, -r + 5, r * 2 - 10, r * 2 - 10);
  g.rotate(-Math.PI / 4);
  g.fillStyle = fg; g.font = `900 ${S * 0.3}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, 0, 4);
};
/** 可以用名字取到的贴纸。往这里加一项，decal('名字') 就能用。 */
export const DECALS: Record<string, Draw> = {
  flammable: diamond('#a12a1e', '#e8e4da', '燃'),
  corrosive: diamond('#e8e4da', '#15171a', '蚀'),
  warning: diamond('#d2a021', '#15171a', '!'),
  arrow_up: (g, S) => {
    g.fillStyle = '#d8d6cc';
    g.beginPath(); g.moveTo(S / 2, 14); g.lineTo(S - 26, S * 0.5); g.lineTo(S * 0.62, S * 0.5); g.lineTo(S * 0.62, S - 14); g.lineTo(S * 0.38, S - 14); g.lineTo(S * 0.38, S * 0.5); g.lineTo(26, S * 0.5); g.closePath(); g.fill();
  },
};

/** 所有贴片共用的那一个材质。 */
export function labelMaterial(): THREE.Material { ensure(); return mat; }
