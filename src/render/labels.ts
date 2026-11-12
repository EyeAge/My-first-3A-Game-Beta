import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { css, DECAL_ART, distress, drawText, measureText, PALETTE, type DecalDef, type Rgb } from './decalart';

// 文字和贴纸的"图集"。
//
// 叉车的车号、油桶上的"易燃"、木箱上的喷字……每一处都是一张贴在模型表面的小面片。
// 如果每张面片各用一张贴图，画一百处字就是一百次绘制调用。所以这里把所有的字和贴纸都画到同一张大图上，
// 每处只记住"我在大图的哪一块"。于是全场所有的字共用一张贴图、一个材质，可以合并成一次绘制。
//
// 每一块怎么画（写字、镂空断桥、做旧、22 张具名贴纸）在 decalart.ts 里；这个文件只管排版和材质。

export interface LabelOpts {
  /** 字的颜色：调色板里的名字（white / black / yellow / red / navy / orange），或者任意 CSS 颜色。 */
  color?: 'white' | 'black' | 'yellow' | 'red' | 'orange' | 'navy' | (string & {});
  /** stencil 是镂空喷字（每个字中间有一道断开的"桥"，像用漏字板喷的）；sans 是普通印刷字。 */
  font?: 'stencil' | 'sans';
  /** 做旧程度 0–1：掉漆的斑、划痕、麻点有多少。默认 0.35。 */
  distress?: number;
}
/** 一块字（或贴纸）在图集里的位置（贴图坐标 [u0, v0, u1, v1]）和它的宽高比。 */
export interface Patch { uv: [number, number, number, number]; aspect: number }

/** 贴纸的旧式写法：(画布, 边长) => void，画在 128 × 128 的方块里。新的贴纸请用 DecalDef（可以不是方的，可以指定粗糙度）。 */
type LegacyDraw = (g: CanvasRenderingContext2D, S: number) => void;

/**
 * 可以用名字取到的贴纸。往这里加一项，decal('名字') 就能用。
 * 22 张照参考画的：hazard_flammable / hazard_voltage / hazard_general / arrow / no_entry / logo_a…d / berth4 /
 * caution_stripes / grime_streak / rust_run / oil_stain / leak_stain / bullet_metal / bullet_concrete / scorch /
 * crack / graffiti_tag / csc_plate / numbers_0_9；另有我们自己的 corrosive / arrow_up，和几个旧名字的别名。
 */
export const DECALS: Record<string, DecalDef | LegacyDraw> = {
  ...DECAL_ART,
  flammable: DECAL_ART.hazard_flammable,
  warning: DECAL_ART.hazard_general,
};

const SIZE = 2048;
/** 相邻两块之间留的空隙（像素）。贴图缩小以后相邻的像素会混在一起，没有空隙的话隔壁的颜色会渗过来。 */
const PAD = 4;
/** 贴纸默认按设计尺寸的 0.75 倍画进图集；一行字按 0.5 倍（设计高度 128 → 图集里 64 像素高）。图集就这么大，要省着用。 */
const DECAL_SCALE = 0.75, LABEL_SCALE = 0.5;
/** 粗糙度 / 金属度的小图：每块贴纸内部是一个常数，不需要细节，所以只用四分之一的分辨率。 */
const ORM_DIV = 4;

let canvas: HTMLCanvasElement | null = null, ctx: CanvasRenderingContext2D, tex: THREE.CanvasTexture;
let ormCtx: CanvasRenderingContext2D, ormTex: THREE.CanvasTexture, mat: THREE.MeshStandardMaterial;
const cache = new Map<string, Patch>();
const warned = new Set<string>();

function ensure() {
  if (canvas) return;
  canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
  ctx = canvas.getContext('2d')!;
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;

  const orm = document.createElement('canvas'); orm.width = orm.height = SIZE / ORM_DIV;
  ormCtx = orm.getContext('2d')!;
  ormCtx.fillStyle = ormColor(0.7, 0); ormCtx.fillRect(0, 0, orm.width, orm.height);
  ormTex = new THREE.CanvasTexture(orm);
  ormTex.generateMipmaps = false; ormTex.minFilter = THREE.LinearFilter;

  // 贴片比底下的表面只高出一根头发丝，用 polygonOffset 让它稳稳地盖在上面而不闪烁。
  // roughness / metalness 设成 1：真正的数值在小图里，这两个只是乘数。
  mat = new THREE.MeshStandardMaterial({
    map: tex, roughnessMap: ormTex, metalnessMap: ormTex, roughness: 1, metalness: 1,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.name = 'labels';
}
/** three.js 从贴图的绿色通道读粗糙度、蓝色通道读金属度。 */
const ormColor = (rough: number, metal: number) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

// ---- 排版："货架式"。图集从上到下分成一层层的"货架"，每层的高度由第一个放进来的东西决定；
// 后来的东西找一层高度差不多、还有空位的放进去，找不到就在最下面另开一层。
// 一行行的字都是同样的高度，会整整齐齐地排满同一种货架；大贴纸有自己的货架，不会在矮货架里浪费一大截空白。
interface Shelf { y: number; h: number; x: number }
const shelves: Shelf[] = [];
let floorY = PAD;

/** 在图集里占一块 w×h 的地方，返回左上角。 */
function alloc(w: number, h: number): [number, number] {
  let best: Shelf | null = null;
  for (const s of shelves) {
    if (s.h < h || s.x + w + PAD > SIZE) continue;
    if (s.h > h * 1.25 && floorY + h + PAD <= SIZE) continue; // 这层太高了，放进去浪费；除非已经没地方开新层
    if (!best || s.h < best.h) best = s;
  }
  if (!best) {
    if (floorY + h + PAD > SIZE) {
      if (!warned.has('#full')) { warned.add('#full'); console.warn('[labels] 图集放满了，后面的字会和前面的叠在一起'); }
      floorY = PAD; shelves.length = 0;
    }
    best = { y: floorY, h, x: PAD };
    shelves.push(best);
    floorY += h + PAD;
  }
  const at: [number, number] = [best.x, best.y];
  best.x += w + PAD;
  return at;
}

/** 字符串 → 一个固定的整数（FNV-1a 哈希）。用它做随机种子：同一段文字每次做旧出来的样子都一样。 */
function hashOf(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 在图集里占一块地方并画上内容。
 *   w, h    设计尺寸；scale 是画进图集时的缩放
 *   bleed   主色（CSS 颜色），用来"防黑边"，见下
 *   draw    画法。拿到的画布已经平移、缩放好了，照设计尺寸画
 */
function place(key: string, w: number, h: number, scale: number, bleed: string | null, rough: number, metal: number, draw: (g: CanvasRenderingContext2D, rng: () => number) => void): Patch {
  const pw = Math.ceil(w * scale), ph = Math.ceil(h * scale);
  const [x, y] = alloc(pw, ph);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(x - PAD / 2, y - PAD / 2, pw + PAD, ph + PAD);
  if (bleed) {
    // 防黑边：完全透明的像素，颜色其实是黑的。贴图缩小、过滤时，字的边缘会和旁边这些"透明的黑"混在一起，结果字外面出现一圈黑边。
    // 办法是先用主色、以肉眼看不见的浓度（1.2%）把整块铺一遍 —— 透明的地方不再是黑色，混出来的边缘就是干净的。
    ctx.globalAlpha = 0.012; ctx.fillStyle = bleed;
    ctx.fillRect(x - PAD / 2, y - PAD / 2, pw + PAD, ph + PAD);
    ctx.globalAlpha = 1;
  }
  ctx.beginPath(); ctx.rect(x, y, pw, ph); ctx.clip(); // 只许画在自己这一块里（做旧用的是"擦除"，擦出界会伤到邻居）
  ctx.translate(x, y); ctx.scale(pw / w, ph / h);
  draw(ctx, mulberry32(hashOf(key) + 17));
  ctx.restore();
  tex.needsUpdate = true;

  // 这一块的粗糙度 / 金属度：在小图上对应的位置涂一个常数色（往外多涂一点，盖住边缘）
  const d = ORM_DIV, x0 = Math.floor((x - PAD / 2) / d), y0 = Math.floor((y - PAD / 2) / d);
  ormCtx.fillStyle = ormColor(rough, metal);
  ormCtx.fillRect(x0, y0, Math.ceil((x + pw + PAD / 2) / d) - x0, Math.ceil((y + ph + PAD / 2) / d) - y0);
  ormTex.needsUpdate = true;

  // 贴图坐标的原点在左下角，而画布的原点在左上角，所以 v 要倒过来
  const patch: Patch = { uv: [x / SIZE, 1 - (y + ph) / SIZE, (x + pw) / SIZE, 1 - y / SIZE], aspect: pw / ph };
  cache.set(key, patch);
  return patch;
}

/**
 * 一行字。同样的字、同样的选项只画一次。字母一律转成大写（喷字模板只有大写）。
 * 设计尺寸：高 128，字号 100；太长的（超过 2000）整体缩小。
 */
export function label(text: string, o: LabelOpts = {}): Patch {
  ensure();
  const str = String(text ?? '').toUpperCase() || ' ';
  const colorName = o.color ?? 'white', font = o.font === 'sans' ? 'sans' : 'stencil', amount = o.distress ?? 0.35;
  const key = `l:${str}|${colorName}|${font}|${amount}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rgb: Rgb | undefined = (PALETTE as Record<string, Rgb>)[colorName];
  const color = rgb ? css(rgb) : colorName;
  const H = 128, size = 100, opts = { font: font === 'sans' ? ('sans' as const) : undefined, weight: font === 'sans' ? 600 : 700, spacing: size * 0.06 };
  const textW = measureText(ctx, str, size, opts);
  const fit = Math.min(1, 2000 / (textW + 32));
  const w = Math.max(48, Math.ceil((textW + 32) * fit)), h = Math.ceil(H * fit);
  return place(key, w, h, LABEL_SCALE, color, 0.65, 0, (g, rng) => {
    g.save(); g.scale(fit, fit);
    drawText(g, str, 16, H * 0.84, size, color, opts);
    g.restore();
    distress(g, w, h, amount, rng);
  });
}

/**
 * 具名贴纸（危险品菱形、箭头、公司标、污渍、弹孔……）。
 * 认识的名字画成对应的图案；不认识的画成一块写着名字的黄牌子，一眼就能看出哪里写错了名字。
 * 贴纸不一定是方的：摆的时候高度 = 宽度 ÷ patch.aspect。
 */
export function decal(name: string): Patch {
  ensure();
  const key = `d:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = DECALS[name];
  if (typeof def === 'function') {
    return place(key, 128, 128, 1, null, 0.7, 0, (g, rng) => { def(g, 128); distress(g, 128, 128, 0.25, rng); });
  }
  if (!def) {
    if (!warned.has(name)) { warned.add(name); console.warn(`[labels] 没有叫 "${name}" 的贴纸`); }
    return place(key, 128, 128, 1, css(PALETTE.yellow), 0.7, 0, (g) => {
      g.fillStyle = css(PALETTE.yellow); g.fillRect(4, 4, 120, 120);
      g.strokeStyle = css(PALETTE.black); g.lineWidth = 5; g.strokeRect(8, 8, 112, 112);
      drawText(g, name, 64, 72, 22, css(PALETTE.black), { font: 'sans', align: 'center', maxW: 100 });
    });
  }
  return place(key, def.w, def.h, def.scale ?? DECAL_SCALE, def.bleed ? css(def.bleed) : null, def.rough ?? 0.7, def.metal ?? 0, (g, rng) => def.draw(g, def.w, def.h, rng));
}

/** 单个喷字数字（0–9）：从 numbers_0_9 那张贴纸里切出一格。宽高比是 0.5。 */
export function digit(n: number): Patch {
  const all = decal('numbers_0_9'), k = Math.abs(Math.trunc(n)) % 10, du = (all.uv[2] - all.uv[0]) / 10;
  return { uv: [all.uv[0] + du * k, all.uv[1], all.uv[0] + du * (k + 1), all.uv[3]], aspect: 0.5 };
}

/** 所有贴片共用的那一个材质。 */
export function labelMaterial(): THREE.Material { ensure(); return mat; }

/** 图集用掉了多少（0–1，按已经开出去的货架算）。开发时看一眼，快满了就该把贴纸画小一点。 */
export function labelAtlasUsage() { return floorY / SIZE; }
