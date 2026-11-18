import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, mulberry32, vnoise } from '../core/math';
import { decal, label, labelMaterial, type Patch } from '../render/labels';
import { surface, type SurfaceName } from '../render/surfaces';
import { Kit, type LocalBox, type PropModel, type Rgb, type Tint, type V3 } from './kit';

// 集装箱。
//
// 集装箱是这个游戏里占画面最多的东西，所以值得把它做细。这个文件只管"一只箱子长什么样"，
// 几百只箱子怎么摆、怎么画得动，在 containerfield.ts 里。
//
// 做法上有四个要点：
//
//   1. 波纹是真的几何。侧板、前端板、箱顶都按真实的梯形截面折出来，顶点只放在折线上（一个周期 4 个点），
//      平的地方不浪费三角形。斜阳一照，每道棱自己就有明暗。
//
//   2. 整只箱子的漆只用一种白色材质。箱子是红是蓝，由"实例颜色"乘上去（见 containerfield.ts）；
//      哪里脏、哪里锈、哪里被撞瘪掉了漆，全部写在顶点色里 —— 顶点色是一个乘数，1 是原色，0.5 是暗一半。
//      这样不需要任何一张"箱体贴图"，而每只箱子的锈迹位置都可以不一样（由 seed 决定）。
//
//   3. 喷字和污迹是贴在表面外 3 毫米的小面片。侧板上的字不是一张平板，而是沿着波纹截面折出来的带子，
//      斜着看的时候字会跟着棱起伏。
//
//   4. 同一只箱子有三份几何，由近到远换着用：
//        精模（detail）  20 尺箱六千、40 尺箱七千多个三角形，什么都有；
//        中模（mid）     一千五到两千七百个三角形：波纹和框架还在，凹坑、门上的小零件和小字没了；
//        简模（lod）     两百个三角形上下的平板盒子，颜色和脏污照样有，只是没有起伏。
//      三份几何的漆面贴图是对齐的（见 addPanel），切换的时候斑驳不会跳。
//
// 坐标约定：长边沿 x，箱门在 +x 端，前端板在 -x 端；宽沿 z；底面在 y=0，原点在占地中心。

// ====================================================================== 规格和常量

/** 三种规格：20 尺、40 尺、40 尺高箱。 */
export type ContainerSize = 20 | 40 | 'hc';
export interface ContainerSpec {
  /** 长、高（米）。宽三种规格都一样。 */
  length: number; height: number;
  /** 喷在箱门上的箱型代码和重量数据。 */
  typeCode: string; gross: string; tare: string; net: string; cube: string;
}
export const CONTAINER_WIDTH = 2.438;
export const CONTAINER_SIZES: Record<ContainerSize, ContainerSpec> = {
  20: { length: 6.06, height: 2.59, typeCode: '22G1', gross: '30,480', tare: '2,230', net: '28,250', cube: '33.2' },
  40: { length: 12.19, height: 2.59, typeCode: '42G1', gross: '32,500', tare: '3,750', net: '28,750', cube: '67.7' },
  hc: { length: 12.19, height: 2.9, typeCode: '45G1', gross: '32,500', tare: '3,940', net: '28,560', cube: '76.3' },
};

/** 八种箱体颜色（sRGB 十六进制）。交给 THREE.Color.setHex 时会自动换算到线性空间。 */
export const CONTAINER_COLORS = {
  red: 0x7d2219, blue: 0x1f3f66, green: 0x2c5a44, yellow: 0xb98a1c,
  orange: 0xb3521a, white: 0xb9bbb6, grey: 0x5a6068, teal: 0x1f5d63,
} as const;

/**
 * 四家船公司，和它们的标在贴纸图集（render/labels.ts）里的名字。brand 参数就是这个数组的下标。
 * darkInk：这家的标是藏青色的，只有喷在浅色的箱子上才看得见（摆箱子的时候要避开深色箱体，见 containerfield.ts）。
 */
export const SHIPPING_LINES: readonly { name: string; decal: string; darkInk?: boolean }[] = [
  { name: '激战北航', decal: 'logo_a' },
  { name: '激战远洋', decal: 'logo_b' },
  { name: '激战太平洋', decal: 'logo_c', darkInk: true },
  { name: '激战联运', decal: 'logo_d' },
];

/** 箱主代号（四个字母 + 六位箱号 + 一位校验码）。每个 seed 固定用其中一个。 */
const OWNER_CODES = ['SLTU 482915 7', 'HBMU 307144 2', 'NRDU 665201 9', 'OKTU 119873 4', 'VSLU 850362 1', 'TQLU 274590 6'];
/** seed 只取除以 6 的余数：凹坑和锈条一共 6 套花样。花样太多的话每一套都要单独存一份几何，内存不划算。 */
export const SEED_VARIANTS = 6;

const HALF_W = CONTAINER_WIDTH / 2;  // 1.219，半个箱宽
const PANEL_Z = HALF_W - 0.012;      // 侧板"外平面"（波纹凸出来的那一面）离中线多远
const PANEL_Y0 = 0.16;               // 侧板和端板的下沿：比下侧梁的顶面（0.17）低 1 厘米，插在梁里，接缝才不漏光
const FLOOR_Y = 0.172;               // 箱内木地板的高度
const DOOR_Y0 = 0.175;               // 门板下沿。门板上沿是 箱高 - 0.124
const HINGE_Z = HALF_W - 0.058;      // 铰链轴离中线多远
const LEAF_W = HINGE_Z - 0.004;      // 一扇门的宽度：从铰链到中缝，两扇之间留 8 毫米给胶条
/** 两扇门开得不一样大：+z 那扇最多开到 112°，-z 那扇最多 88°。doors 是开门程度（0–1），返回这扇门转过的弧度。 */
const doorAngle = (doors: number, side: number) => doors * (side > 0 ? 112 : 88) * (Math.PI / 180);
const HOLE_GAP = 0.004;              // 深色孔的面片浮在表面外 4 毫米。再近的话，四十米外深度缓冲分不清谁在前，两个面会闪烁打架

/**
 * 箱体漆在材质库里的名字。搭的时候箱体色的零件都按这个名字交给零件箱（零件箱只对"按名字给的"材质做贴图随机挪位）；
 * 最后真正拿来画的是 containerMaterials().body —— 同一种漆，颜色设成纯白，好让实例颜色原样乘上去。
 */
const BODY: SurfaceName = 'paint_white';

// 顶点色用的几个"乘数"。把漆的颜色乘上它，就得到那种脏法的颜色
const MUD: Rgb = [0.5, 0.44, 0.38];        // 泥：暗一半，并且偏黄褐
const RUST_TINT: Rgb = [0.62, 0.38, 0.24]; // 淌下来的锈水：红留得多，蓝留得少，所以发红褐
const BARE: Rgb = [0.66, 0.46, 0.36];      // 撞掉漆以后生的锈
const HOLE: Rgb = [0.035, 0.035, 0.04];    // 孔洞：几乎全黑
const RUBBER = 0.05;                       // 门缝的橡胶条

/** 平滑的 0→1 过渡：t 从 a 走到 b 的时候，结果从 0 平滑地升到 1（a 可以比 b 大，那就是反过来）。 */
const sstep = (a: number, b: number, t: number) => { const u = clamp((t - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
/** 把颜色 c 往 "c 乘以 m" 的方向混合 t 这么多（就地修改）。 */
const stain = (c: Rgb, m: Rgb, t: number) => { c[0] *= 1 + (m[0] - 1) * t; c[1] *= 1 + (m[1] - 1) * t; c[2] *= 1 + (m[2] - 1) * t; };
const xform = (pos: V3, rot: V3 = [0, 0, 0]) => new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));

// ====================================================================== 波纹截面

/**
 * 梯形波纹的一个周期（单位：米）：
 *
 *     外平面 flat      内平面
 *   ‾‾‾‾‾‾‾‾‾‾\      /‾‾ … 下一个周期
 *              \____/        ↕ depth
 *          slope    slope
 *
 * 先是宽 flat 的外平面，用宽 slope 的斜面降下去 depth 深，走一段内平面，再用同样宽的斜面升回来。
 */
interface Corrugation { period: number; depth: number; flat: number; slope: number }
const SIDE_RIB: Corrugation = { period: 0.278, depth: 0.036, flat: 0.072, slope: 0.068 }; // 侧板：四段差不多一样宽，棱是缓的
const END_RIB: Corrugation = { period: 0.25, depth: 0.042, flat: 0.07, slope: 0.06 };     // 前端板：更深一点
const ROOF_RIB: Corrugation = { period: 0.209, depth: 0.02, flat: 0.09, slope: 0.03 };    // 箱顶：浅而密

/** 沿板面走了 t 米（从波纹的起点量起）的地方，板面凹进去多深：0 到 depth。 */
function ribDepth(t: number, c: Corrugation) {
  let u = t % c.period;
  if (u < 0) u += c.period;
  const inner = c.period - c.flat - 2 * c.slope;
  if (u <= c.flat) return 0;
  if (u < c.flat + c.slope) return (c.depth * (u - c.flat)) / c.slope;
  if (u <= c.flat + c.slope + inner) return c.depth;
  return c.depth * (1 - (u - c.flat - c.slope - inner) / c.slope);
}
/**
 * from 到 to 这一段板面上所有的"折点"：[位置, 凹深]。
 * 波纹只在折点处拐弯，折点之间是直的，所以网格的顶点只需要放在折点上。origin 是波纹的起点（第一个外平面从这里开始）。
 */
function ribKnots(from: number, to: number, c: Corrugation, origin: number): [number, number][] {
  const inner = c.period - c.flat - 2 * c.slope;
  const xs = [from];
  for (let n = Math.floor((from - origin) / c.period) - 1; n <= Math.ceil((to - origin) / c.period) + 1; n++) {
    for (const o of [0, c.flat, c.flat + c.slope, c.flat + c.slope + inner]) {
      const x = origin + n * c.period + o;
      if (x > from + 1e-4 && x < to - 1e-4) xs.push(x);
    }
  }
  xs.push(to);
  return xs.map((x) => [x, ribDepth(x - origin, c)]);
}
/**
 * 把一串折点切成几张"板"，每张 n 格（相邻两张共用交界处的那一列折点，所以拼起来没有缝）。
 * 真的集装箱侧板就是一米来宽的压型钢板一张张焊起来的。这里切开是为了贴图：零件箱会给每个零件的贴图随机挪一个位置，
 * 一整块 12 米的侧板只算一个零件，2.5 米一铺的漆面贴图就会原样重复五遍 —— 同一块掉漆每隔 2.5 米出现一次；
 * 切成十来张以后，每张各挪各的，就看不出重复了。接缝落在波纹的折线上，本来就是一道棱，看不出来。
 */
function sheets<T>(knots: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i + 1 < knots.length; i += n) out.push(knots.slice(i, i + n + 1));
  return out;
}
/** 把一条截面的两头各接长 extra 米（深度照抄端点的）：让板的边插进旁边的梁柱里，接缝处才不漏光。 */
const embed = (knots: [number, number][], extra: number): [number, number][] => [[knots[0][0] - extra, knots[0][1]], ...knots, [knots[knots.length - 1][0] + extra, knots[knots.length - 1][1]]];
/** 没有波纹的"截面"：from 到 to 平均分成 n 段。简模和箱内的平板用它，好让同一个铺网格的函数两头通用。 */
const flatKnots = (from: number, to: number, n: number): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [from + ((to - from) * i) / n, 0]);

/**
 * 把"截面折线 × 若干排"铺成一张网格。
 *   knots  截面上的折点 [位置, 凹深]，每个折点是网格的一"列"
 *   rows   垂直于截面方向的各排位置。可以是一个固定的列表；也可以是函数，给每一列各自的列表
 *          （都要从小到大，并且各列的头尾两排相同）—— 侧板上只有凹坑经过的那几列需要多几排顶点
 *   place  (位置, 凹深, 排的位置, 这一列的第几排) → 顶点坐标
 *   out    这张板大致朝哪边。三角形的正反面按它统一，调用的人不用操心顶点顺序
 *   uvOf   可选：按顶点坐标给贴图坐标（文字带子用）
 *
 * 相邻两列的排数可以不一样，所以两列之间不是简单地"一格两个三角形"，而是像拉拉链：
 * 左右两列各有一根手指从下往上爬，每次让下一个点比较低的那一边往上走一步，走一步就连出一个三角形。
 * 两列排数相同的时候，结果和普通的方格网完全一样。这样连出来的网格没有"丁字缝"（一条长边对着两条短边），不会漏光。
 */
function ribbedSheet(knots: [number, number][], rows: number[] | ((u: number) => number[]), place: (u: number, depth: number, v: number, row: number) => V3, out: V3, uvOf?: (p: V3) => [number, number]) {
  const columns = knots.map(([u, depth]) => {
    const vs = typeof rows === 'function' ? rows(u) : rows;
    return { vs, pts: vs.map((v, j) => place(u, depth, v, j)) };
  });
  const pos: number[] = [], uv: number[] = [];
  let facing = 0;
  const tri = (a: V3, b: V3, c: V3) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    facing += (uy * vz - uz * vy) * out[0] + (uz * vx - ux * vz) * out[1] + (ux * vy - uy * vx) * out[2]; // 这个三角形的朝向和 out 一不一致
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      if (uvOf) uv.push(...uvOf(p));
    }
  };
  for (let k = 0; k + 1 < columns.length; k++) {
    const L = columns[k], R = columns[k + 1], m = L.vs.length - 1, n = R.vs.length - 1;
    for (let i = 0, j = 0; i < m || j < n;) {
      if (j >= n || (i < m && L.vs[i + 1] <= R.vs[j + 1])) { tri(L.pts[i], R.pts[j], L.pts[i + 1]); i++; }
      else { tri(L.pts[i], R.pts[j], R.pts[j + 1]); j++; }
    }
  }
  if (facing < 0) { // 朝反了：把每个三角形的后两个顶点对调
    for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
    for (let i = 0; i < uv.length; i += 6) for (let k = 0; k < 2; k++) { const t = uv[i + 2 + k]; uv[i + 2 + k] = uv[i + 4 + k]; uv[i + 4 + k] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uvOf) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g; // 不给法线：零件箱会按三角形自己的朝向算，于是每个折面是平的、折线是硬的
}

/** 长圆孔（两头是半圆的长条）：画在 xy 平面里，朝 +z。角件上的孔、通风口都是它。 */
function slotShape(w: number, h: number, seg = 2) {
  const r = Math.min(w, h) / 2, ox = w / 2 - r, oy = h / 2 - r, ring: [number, number][] = [];
  for (let q = 0; q < 4; q++) for (let s = 0; s <= seg; s++) {
    const a = ((q + s / seg) * Math.PI) / 2;
    ring.push([Math.cos(a) * r + (q === 0 || q === 3 ? ox : -ox), Math.sin(a) * r + (q < 2 ? oy : -oy)]);
  }
  const pos: number[] = [];
  ring.forEach((p, i) => { const n = ring[(i + 1) % ring.length]; pos.push(0, 0, 0, p[0], p[1], 0, n[0], n[1], 0); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// ====================================================================== 一只箱子的"方案"

/** 一个变体：规格、第几套花样（0–5）、做旧程度（0 / 0.5 / 1）、开门程度（0–1，一格 0.1）、哪家船公司（0–3）。 */
export interface ContainerVariant { size: ContainerSize; seed: number; wear: number; doors: number; brand: number }
export interface ContainerOpts { size?: ContainerSize; seed?: number; wear?: number; doors?: number; brand?: number }

/** 把随手给的参数规整成有限的几档。档数有限，同一档的箱子才能共用同一份几何。 */
export function containerVariant(o: ContainerOpts): ContainerVariant {
  const seed = Math.abs(Math.floor(o.seed ?? 0)) % SEED_VARIANTS;
  const doors = Math.round(clamp(o.doors ?? 0, 0, 1) * 10) / 10;
  const brand = Math.abs(Math.floor(o.brand ?? seed)) % SHIPPING_LINES.length;
  return { size: o.size ?? 40, seed, wear: Math.round(clamp(o.wear ?? 0.5, 0, 1) * 2) / 2, doors, brand };
}

/** 撞出来的凹坑。 */
interface Dent { side: number; x: number; y: number; radius: number; depth: number }
/** 从顶梁淌下来的一道锈（写进顶点色的那种）。 */
interface RustStreak { side: number; x: number; halfWidth: number; strength: number }
/** 一条锈水或者污水的贴片。 */
interface Stain { side: number; x: number; height: number; width: number; rust: boolean }
type Plan = ReturnType<typeof makePlan>;

/**
 * 动手搭之前先把"方案"定下来：这只箱子哪里有坑、哪里淌锈、每个位置的漆是什么颜色。
 * 箱体、喷字、远处的简模都要照着同一套数据来做（比如字要跟着坑一起凹进去），所以单独拎出来算一次。
 */
function makePlan(v: ContainerVariant) {
  const spec = CONTAINER_SIZES[v.size], L = spec.length, H = spec.height, half = L / 2, wear = v.wear;
  const rng = mulberry32(1000 + v.seed * 77 + (v.size === 20 ? 143 : v.size === 40 ? 299 : 481));
  const shift = v.seed * 9.7;   // 噪声的偏移：每套花样在噪声图上取不同的一块
  const top = H - 0.06;         // 侧板的上沿

  // ---- 凹坑：做旧越重越多，一般 0–3 个。位置尽量避开喷船公司标的那一段和靠门的那一段
  const dents: Dent[] = [];
  const keepOut = [[-half * 0.75, -half * 0.05], [half - 2.2, half]];
  for (let i = 0, n = Math.round((1 + rng() * 2.4) * (0.4 + wear)); i < n; i++) {
    const side = rng() < 0.5 ? 1 : -1;
    let along = 0, tries = 0;
    do { along = (rng() * 2 - 1) * (half - 0.9); tries++; }
    while (tries < 8 && keepOut.some(([a, b]) => along > a - 0.4 && along < b + 0.4 && rng() < 0.9));
    // 两侧的喷字是镜像着排的（从外面看，标都在左边、箱号都在右上角），所以避让的位置也要按侧镜像
    dents.push({ side, x: side * along, y: 0.45 + rng() * 1.3, radius: 0.22 + rng() * 0.3, depth: 0.025 + rng() * 0.04 });
  }
  /**
   * (x, y) 处被压进去多深。坑的截面是 (1 - q²)²：中间最深，到边缘平滑地归零。竖直方向乘 0.9，坑略微偏高。
   * 侧板的上下两条边是焊死在侧梁上的，压不动：离边 0.2 米以内，坑深逐渐收到 0。
   * （不收的话，坑要是靠近底边，侧板的下沿会被整条推进去，和下侧梁之间裂开一道能看穿箱子的缝。）
   */
  const dentAt = (x: number, y: number, side: number) => {
    let d = 0;
    for (const t of dents) if (t.side === side) {
      const q = Math.hypot(x - t.x, (y - t.y) * 0.9) / t.radius;
      if (q < 1) { const k = 1 - q * q; d += t.depth * k * k; }
    }
    return d > 0 ? d * sstep(PANEL_Y0, PANEL_Y0 + 0.2, y) * sstep(top, top - 0.2, y) : 0;
  };

  // ---- 侧板竖向分成哪几排。波纹板本身只要上下两排顶点就够了，中间多出来的三排是给泥污、锈条的渐变留的落脚点。
  //      凹坑需要更密的顶点才压得圆，但只有坑经过的那几列需要 —— 所以排是"按列"给的：
  //      某一列如果落在某个坑的范围里，就在坑的高度上下再加七排
  const sideFrom = -half + 0.085, sideTo = half - 0.135; // 侧板波纹的起止（两头被角柱盖住）
  const baseRows = [PANEL_Y0, 0.44, 1.25, H - 0.5, top];
  const rowCache = [new Map<number, number[]>(), new Map<number, number[]>()]; // 两侧各记一张表：同一列会被问很多次
  const rows = (x: number, side: number) => {
    const cache = rowCache[side > 0 ? 1 : 0], hit = cache.get(x);
    if (hit) return hit;
    const list = baseRows.slice();
    for (const t of dents) if (t.side === side && Math.abs(x - t.x) < t.radius) {
      const reach = t.radius / 0.9; // 坑在竖直方向的半径（公式里高度差乘了 0.9）
      for (const k of [-1, -0.7, -0.35, 0, 0.35, 0.7, 1]) {
        const y = t.y + reach * k;
        if (y > PANEL_Y0 + 0.03 && y < top - 0.03 && list.every((r) => Math.abs(r - y) > 0.03)) list.push(y);
      }
    }
    list.sort((a, b) => a - b);
    cache.set(x, list);
    return list;
  };

  // ---- 锈条：从顶梁往下淌，每一道有自己的位置、宽度、浓淡
  const streaks: RustStreak[] = [];
  for (let i = 0, n = Math.round((L / 2.2) * (0.5 + wear) * (0.6 + rng())) * 2; i < n; i++) {
    streaks.push({ side: i % 2 ? 1 : -1, x: (rng() * 2 - 1) * (half - 0.3), halfWidth: 0.05 + rng() * 0.12, strength: 0.4 + rng() * 0.6 });
  }
  // ---- 锈水 / 污水的贴片：六成是锈，四成是黑灰色的污水
  const stains: Stain[] = [];
  for (const side of [-1, 1]) for (let i = 0, n = Math.round((1 + rng() * 2) * (0.4 + wear) * (L > 7 ? 1.6 : 1)); i < n; i++) {
    const rust = rng() < 0.6, height = 0.5 + rng() * 0.7;
    stains.push({ side, rust, height, width: clamp(height * 0.5, 0.16, 0.5), x: (rng() * 2 - 1) * (half - 0.6) });
  }

  /**
   * 漆面的基础明暗，箱体色的零件都用它：
   *   · 一层一米多宽的深浅起伏（旧箱子起伏更大）和一层十几厘米的细碎起伏；
   *   · 离地 0.62 米以下逐渐变成泥色 —— 地上溅起来的泥水。
   */
  const shade = (x: number, y: number, z: number): Rgb => {
    let k = 1 + (vnoise(x * 0.9 + shift, y * 1.7 + z * 0.4) - 0.5) * 0.16 * (0.5 + wear);
    k *= 0.94 + 0.06 * vnoise(x * 6.1 + z * 3.3, y * 5 + shift);
    const mud = Math.min(1, sstep(0.62, 0.02, y) * (0.45 + 0.5 * wear) * (0.75 + 0.5 * vnoise(x * 2.3 + z, shift)));
    const c: Rgb = [k, k, k];
    stain(c, MUD, mud);
    return c;
  };
  /**
   * 侧板的漆：在基础明暗上再加三样 —— 波纹槽里压暗、顶梁淌下来的锈条、凹坑里掉漆发锈。
   * pits 给 false 就不画坑里的锈：中模的侧板没有把坑压进去，顶点也稀，硬把锈色写上去会抹成一大片。
   */
  const sidePaint = (x: number, y: number, z: number, pits = true): Rgb => {
    const side = z > 0 ? 1 : -1, c = shade(x, y, z);
    // 槽里照不到多少天光，压暗一点（假的"环境光遮蔽"）。凹进去 8 毫米开始暗，34 毫米暗到头
    const groove = sstep(0.008, 0.034, PANEL_Z - Math.abs(z));
    c[0] *= 1 - 0.17 * groove; c[1] *= 1 - 0.18 * groove; c[2] *= 1 - 0.18 * groove;
    const hang = sstep(H - 0.75, top, y); // 锈条只在离箱顶 0.75 米以内，越往上越浓
    if (hang > 0) for (const s of streaks) if (s.side === side) {
      const t = Math.abs(x - s.x) / s.halfWidth;
      if (t < 1) stain(c, RUST_TINT, hang * hang * s.strength * (1 - t * t) * (0.45 + 0.55 * wear));
    }
    const dent = pits ? dentAt(x, y, side) : 0;
    if (dent > 0.004) stain(c, BARE, Math.min(0.8, dent * 22));
    return c;
  };
  /** 箱顶：单独一套颜色，偏灰、褪色（常年日晒）。groove 是这一点凹进槽里的程度（0–1）：槽里积灰，更暗并且偏黄。 */
  const roofPaint = (x: number, z: number, groove: number): Rgb => {
    const fade = 0.78 + 0.3 * vnoise(x * 0.8 + shift, z * 1.1);
    return [fade * (1 - 0.25 * groove), fade * (1 - 0.3 * groove) * 0.97, fade * (1 - 0.32 * groove) * 0.94];
  };

  const sideKnots = ribKnots(sideFrom, sideTo, SIDE_RIB, sideFrom + 0.02);
  /** 侧板上某一列（x 是一个折点）在高度 y 处离中线多远：沿着这一列的顶点，在相邻两排之间线性插值。 */
  const columnZ = (x: number, y: number, side: number) => {
    const rs = rows(x, side);
    let j = 0;
    while (j < rs.length - 2 && y > rs[j + 1]) j++;
    const t = clamp((y - rs[j]) / (rs[j + 1] - rs[j]), 0, 1);
    return PANEL_Z - ribDepth(x - (sideFrom + 0.02), SIDE_RIB) - lerp(dentAt(x, rs[j], side), dentAt(x, rs[j + 1], side), t);
  };
  /**
   * 侧板表面在 (x, y) 处离中线多远。贴字的带子要严丝合缝地浮在侧板外面，所以这里不是重新算一遍凹坑的公式，
   * 而是照着侧板网格的样子算：先找到 x 左右两个折点所在的列，各自沿列插值，再在两列之间插值 —— 侧板的三角形就是这么连的。
   */
  const surfaceAt = (x: number, y: number, side: number) => {
    let i = 0;
    while (i < sideKnots.length - 2 && x > sideKnots[i + 1][0]) i++;
    const xa = sideKnots[i][0], xb = sideKnots[i + 1][0], t = clamp((x - xa) / (xb - xa), 0, 1);
    if (t < 1e-6) return columnZ(xa, y, side);
    if (t > 1 - 1e-6) return columnZ(xb, y, side);
    return lerp(columnZ(xa, y, side), columnZ(xb, y, side), t);
  };

  return { v, spec, L, H, half, top, wear, shift, dents, streaks, stains, rows, dentAt, shade, sidePaint, roofPaint, surfaceAt, sideFrom, sideTo, sideKnots };
}

// ====================================================================== 材质

let marksMaterial: THREE.Material | null = null;
/**
 * 箱子用到的几种材质。
 *   body   箱体漆：白色、开顶点色。箱子的颜色由实例颜色乘上去，所以几百只箱子、八种颜色只要这一个材质
 *   inside 开门箱的内壁：同一种漆，但标成"室内" —— 箱子里淋不到雨，不该有水珠和湿漉漉的反光
 *   metal  镀锌件（锁杆、铰链销、把手），深色的孔也借用它 —— 它们都不跟着箱体颜色变
 *   wood   箱内的木地板（同样是室内）
 *   marks  喷字、船公司标、合格牌、锈水条：全场共用的那张文字 / 贴纸图集
 */
export function containerMaterials() {
  if (!marksMaterial) {
    // 图集的材质克隆一份（贴图还是同一张），只多加一条 alphaTest：不透明度低于 2% 的像素直接不画。
    // 图集里每块图案的透明处都垫着一层 1.2% 的主色（为了缩小时不出黑边）。贴在浅色的东西上看不出来；
    // 但深红、深蓝的箱子很暗，三米多宽的一块标叠上 1% 的白，会泛出一整块长方形的灰印子，所以把这层垫色丢掉
    const m = labelMaterial().clone();
    m.alphaTest = 0.02;
    m.name = 'container-marks';
    marksMaterial = m;
  }
  return {
    body: surface(BODY, { vertexColors: true, color: 0xffffff }),
    inside: surface(BODY, { vertexColors: true, color: 0xffffff, interior: true }),
    metal: surface('steel_galv', { vertexColors: true }),
    wood: surface('wood_pallet', { vertexColors: true, interior: true }),
    marks: marksMaterial,
  };
}

// ====================================================================== 精模：箱体

interface Core { body: THREE.BufferGeometry; metal: THREE.BufferGeometry | null; inside: THREE.BufferGeometry | null; wood: THREE.BufferGeometry | null; boxes: LocalBox[] }

/** 零件箱的种子：规格、花样、做旧三样都算进去，于是每个变体的贴图挪位都不一样，摞在一起的箱子不会在同一个位置掉同一块漆。 */
const kitSeed = (v: ContainerVariant) => v.seed + Math.round(v.wear * 2) * 10 + (v.size === 20 ? 0 : v.size === 40 ? 100 : 200);
/**
 * 几张大板的编号：两块侧板各切成十来张、箱顶十来张、前端板一张、门上的压型板一张。编号只是给 addPanel 算贴图位移用的，互相不重复就行。
 */
const SLOT = { side: (side: number, i: number) => (side > 0 ? 0 : 40) + i, roof: (i: number) => 80 + i, front: 120, door: 121 };
/** 侧板切成哪几张。两头各多伸 2 厘米，插进角柱里（角柱的棱是倒过角的，板如果刚好只到角柱的边，倒角那里会露出一条能看穿箱子的细缝）。 */
const sideSheets = (plan: Plan) => sheets(embed(plan.sideKnots, 0.02), 16); // 16 格 = 4 个波纹周期，1.1 米一张
/** 箱顶切成哪几张。 */
const roofSheets = (plan: Plan) => sheets(ribKnots(-plan.half + 0.062, plan.half - 0.13, ROOF_RIB, -plan.half + 0.1), 20); // 20 格 = 5 个波纹周期，一米一张
/** 一串板各自占哪一段 [起, 止]；第一张的起点和最后一张的终点换成 from / to（简模、中模的平板要一直铺到箱子的边上）。 */
const spans = (list: [number, number][][], from: number, to: number) => list.map((sheet, i): [number, number] => [i === 0 ? from : sheet[0][0], i === list.length - 1 ? to : sheet[sheet.length - 1][0]]);

/**
 * 把一张大板（侧板、箱顶、前端板）放进零件箱，并且自己指定它的漆面贴图挪到哪里。
 *
 * 平时这件事是零件箱替我们做的：它按"这是第几个零件"给每个零件的贴图随机挪一个位置（kit.ts），免得每块板在同一个地方掉同一块漆。
 * 可是同一只箱子有精模、中模、简模三份几何，零件的个数和顺序各不相同 —— 同一张板在三份几何里会被挪到三个不同的地方。
 * 于是箱子在远近之间切换的那一刻，整面漆的斑驳会"唰"地换一套，比波纹消失还显眼。
 *
 * 所以这几张大板不让零件箱挪（shift: false），改成按"哪个变体的第几张板"算一个固定的位移：
 * 三份几何里同一张板算出来的位移相同，漆面就严丝合缝地接得上。
 *
 * 位移怎么加上去：零件箱是按几何体"摆放之前"的位置铺贴图的。那就先把板平移 t，让它照这个位置铺，
 * 再用摆放矩阵把板挪回原处 —— 形状一点没动，贴图挪了 t。
 *
 * origin 给那些不是在箱子的坐标系里搭的板用：精模的门板是在"门的坐标系"里搭的（原点在铰链上），
 * 把铰链在箱子里的位置告诉它，算出来的贴图位置才和中模那张直接按箱子坐标搭的门板对得上。
 */
function addPanel(k: Kit, v: ContainerVariant, slot: number, g: THREE.BufferGeometry, tint: Tint, origin: V3 = [0, 0, 0]) {
  const rng = mulberry32(kitSeed(v) * 977 + slot * 131 + 7);
  const t: V3 = [rng() * 7.3 + origin[0], rng() * 7.3 + origin[1], rng() * 7.3 + origin[2]]; // 最多挪 7.3 米，和零件箱自己挪的幅度一样
  k.add(BODY, g.translate(t[0], t[1], t[2]), { tint, shift: false }, new THREE.Matrix4().makeTranslation(-t[0], -t[1], -t[2]));
}

/** 零件箱搭完以后，取出某种材质合并成的那一块几何（零件箱给网格起的名字是"模型名:材质名"）。 */
function partOf(model: PropModel, name: SurfaceName) {
  const found = (model.group.children as THREE.Mesh[]).filter((c) => c.name.endsWith(`:${name}`)).map((c) => c.geometry);
  return found.length > 1 ? mergeGeometries(found) : found[0] ?? null; // 同一种材质里有的零件投影、有的不投影时，零件箱会分成两块，这里并回去
}

/** 门板上横向压型的高度：平的地方离门板中面 19 毫米，凸起的地方 31 毫米。 */
const DOOR_RIB = { low: 0.019, high: 0.031 };
/**
 * 门板压型的竖向截面：一串 [高度, 凸出多少]。6 道（高箱 7 道）凸起，每一道上下各留一段平边和一段斜边。
 * 精模和中模的门都照它来折。
 */
function doorProfile(size: ContainerSize): [number, number][] {
  const doorTop = CONTAINER_SIZES[size].height - 0.124, ribs = size === 'hc' ? 7 : 6, y0 = DOOR_Y0 + 0.085, y1 = doorTop - 0.085, pitch = (y1 - y0) / ribs;
  const profile: [number, number][] = [];
  for (let i = 0; i < ribs; i++) { const y = y0 + i * pitch; profile.push([y, DOOR_RIB.low], [y + 0.022, DOOR_RIB.low], [y + 0.05, DOOR_RIB.high], [y + pitch - 0.05, DOOR_RIB.high], [y + pitch - 0.022, DOOR_RIB.low]); }
  profile.push([y1, DOOR_RIB.low]);
  return profile;
}
/** 四根锁杆离铰链多远（每扇门两根），和锁杆的半径、离门板中面多远。 */
const LOCK_RODS = { offsets: [0.31, 0.83], radius: 0.0155, out: 0.052 };

/** 前端板外平面的 x（p 是半个箱长）。 */
const frontX = (p: number) => -(p - 0.014);
/** 前端板的截面：竖棱沿 z 排开。两边各多伸 2.5 厘米插进角柱。 */
const frontKnots = () => embed(ribKnots(-1.064, 1.064, END_RIB, -1.034), 0.025);
/** 前端板的漆：基础明暗，槽里压暗。 */
const frontPaint = (plan: Plan) => (x: number, y: number, z: number): Rgb => {
  const c = plan.shade(x, y, z), g = sstep(0.008, 0.038, x - frontX(plan.half));
  return [c[0] * (1 - 0.17 * g), c[1] * (1 - 0.18 * g), c[2] * (1 - 0.18 * g)];
};

function buildCore(plan: Plan): Core {
  const { v, L, H, half: p, top, shade } = plan, hc = v.size === 'hc', open = v.doors > 0;
  const body = BODY;
  const k = new Kit('container', kitSeed(v));
  const rng = mulberry32(v.seed * 31 + 5);
  const paint = { tint: shade };
  /** 镀锌件：每个零件深浅略有不同；都不投影（太小了，影子看不出来）。 */
  const zinc = () => ({ tint: 0.8 + rng() * 0.2, cast: false });
  /** 贴一块深色的孔：w × h 的长圆形，贴在 pos，用 rot 转到朝外。 */
  const hole = (w: number, h: number, pos: V3, rot: V3, shape = slotShape(w, h)) => k.add('steel_galv', shape, { tint: HOLE, cast: false }, xform(pos, rot));

  // ---- 角件：八个角上的铸钢块，吊具和堆码都靠它。每个角件朝外的面上有长圆孔（吊具的转锁从这里插进去）
  for (const sx of [-1, 1]) for (const up of [0, 1]) for (const sz of [-1, 1]) {
    const cx = sx * (p - 0.089), cy = up ? H - 0.059 : 0.059, cz = sz * (HALF_W - 0.081);
    k.box(body, 0.178, 0.118, 0.162, cx, cy, cz, { c: 0.012, ...paint });
    hole(0.078, 0.052, [cx, cy, sz * (HALF_W + HOLE_GAP)], [0, sz > 0 ? 0 : Math.PI, 0]);
    hole(0.064, 0.05, [sx * (p + HOLE_GAP), cy, cz], [0, (sx * Math.PI) / 2, 0]);
    if (up) hole(0.124, 0.064, [cx, H + HOLE_GAP, cz], [-Math.PI / 2, 0, 0]);
  }
  // ---- 角柱、上下侧梁
  for (const sz of [-1, 1]) {
    k.box(body, 0.085, H - 0.226, 0.15, -p + 0.0465, H / 2, sz * (HALF_W - 0.079), { c: 0.014, ...paint }); // 前角柱：粗
    k.box(body, 0.14, H - 0.226, 0.056, p - 0.074, H / 2, sz * (HALF_W - 0.032), { c: 0.012, ...paint });   // 门角柱：扁，给门让地方
    k.box(body, L - 0.2, 0.062, 0.062, -0.02, H - 0.031, sz * (HALF_W - 0.035), { c: 0.008, ...paint });    // 上侧梁
    k.box(body, L - 0.2, 0.158, 0.05, -0.02, 0.091, sz * (HALF_W - 0.029), { c: 0.008, ...paint });         // 下侧梁
  }
  // ---- 前端的上下横梁；门端的门楣、门槛；门楣上那条斜着的挡雨檐
  k.box(body, 0.062, 0.062, CONTAINER_WIDTH - 0.2, -p + 0.035, H - 0.031, 0, { c: 0.008, ...paint });
  k.box(body, 0.05, 0.158, CONTAINER_WIDTH - 0.2, -p + 0.029, 0.091, 0, { c: 0.008, ...paint });
  k.box(body, 0.13, 0.12, CONTAINER_WIDTH - 0.12, p - 0.072, H - 0.06, 0, { c: 0.01, ...paint });
  k.box(body, 0.13, 0.158, CONTAINER_WIDTH - 0.12, p - 0.072, 0.091, 0, { c: 0.01, ...paint });
  k.box(body, 0.03, 0.012, CONTAINER_WIDTH - 0.4, p - 0.012, H - 0.125, 0, { c: 0.003, rot: [0, 0, -0.5], ...paint });
  // ---- 叉槽：只有 20 尺箱有，叉车的货叉从下侧梁上的这两个口子插进去
  if (v.size === 20) for (const sz of [-1, 1]) for (const x of [-1.025, 1.025]) {
    hole(0.36, 0.112, [x, 0.075, sz * HALF_W], [0, sz > 0 ? 0 : Math.PI, 0], new THREE.PlaneGeometry(0.36, 0.112)); // 贴在下侧梁外 4 毫米，三条边框比它再凸出一点
    k.box(body, 0.46, 0.018, 0.012, x, 0.142, sz * (HALF_W - 0.002), { plain: true, ...paint });
    for (const e of [-1, 1]) k.box(body, 0.018, 0.13, 0.01, x + e * 0.19, 0.078, sz * (HALF_W - 0.003), { plain: true, ...paint });
  }

  // ---- 两块侧板：波纹截面 × 几排顶点。有坑的地方把顶点往里压
  for (const side of [-1, 1]) sideSheets(plan).forEach((sheet, i) => {
    addPanel(k, v, SLOT.side(side, i), ribbedSheet(sheet, (x) => plan.rows(x, side), (x, rib, y) => [x, y, side * (PANEL_Z - rib - plan.dentAt(x, y, side))], [0, 0, side]), plan.sidePaint);
  });
  // ---- 通风器：侧板靠上的小盖板，上面三道细缝。20 尺箱每侧一个，40 尺箱每侧两个
  for (const sz of [-1, 1]) for (const e of L > 7 ? [-1, 1] : [1]) {
    const x = sz * e * (p - 0.62), y = H - 0.165;
    k.box(body, 0.24, 0.1, 0.03, x, y, sz * (PANEL_Z - 0.004), { c: 0.008, ...paint });
    for (let i = -1; i <= 1; i++) hole(0.18, 0.012, [x, y + i * 0.026, sz * (PANEL_Z + 0.011 + HOLE_GAP)], [0, sz > 0 ? 0 : Math.PI, 0], new THREE.PlaneGeometry(0.18, 0.012));
  }
  // ---- 前端板：竖棱沿 z 排开，比侧板的波纹深一点。两边同样插进角柱 2 厘米；
  //      下沿比侧板多往下伸 6 厘米，藏到前下梁的背后 —— 前下梁只有 5 厘米厚，挡不住波纹凹进去的那一半，不伸下去的话槽底会漏光
  addPanel(k, v, SLOT.front, ribbedSheet(frontKnots(), [PANEL_Y0 - 0.06, PANEL_Y0, 1.25, top], (z, rib, y) => [frontX(p) + rib, y, z], [-1, 0, 0]), frontPaint(plan));
  // ---- 箱顶：横棱沿 x 排开。20 尺箱在中线多一排顶点并且抬高 6 毫米（顶板略微起拱，好排水）。
  //      两边压进上侧梁的倒角里 6 毫米，理由同上
  const roofY = H - 0.008, roofZ = HALF_W - 0.06;
  roofSheets(plan).forEach((sheet, i) => {
    addPanel(k, v, SLOT.roof(i), ribbedSheet(sheet, L > 7 ? [-roofZ, roofZ] : [-roofZ, 0, roofZ], (x, rib, z) => [x, roofY - rib + (Math.abs(z) < 0.01 ? 0.006 : 0), z], [0, 1, 0]),
      (x, y, z) => plan.roofPaint(x, z, sstep(0.004, 0.018, roofY + (Math.abs(z) < 0.01 ? 0.006 : 0) - y)));
  });
  // ---- 箱底：一块朝下的暗板。箱子摞起来、或者被吊在半空的时候，从下面往上看不能看穿
  k.plane(body, L - 0.06, CONTAINER_WIDTH - 0.06, [0, 0.02, 0], { rot: [Math.PI / 2, 0, 0], tint: 0.3 });

  // ---- 箱门：两扇，各自绕自己的铰链轴转
  const doorTop = H - 0.124, leafH = doorTop - DOOR_Y0, mid = (DOOR_Y0 + doorTop) / 2, hingeX = p - 0.066;
  for (const side of [1, -1]) {
    // 下面都在"门的坐标系"里搭：原点在铰链轴上，x 朝门外，门板从铰链往中缝方向伸出去。along(d) 是离铰链 d 米处的 z
    k.push([hingeX, 0, side * HINGE_Z], [0, -side * doorAngle(v.doors, side), 0]);
    const along = (d: number) => -side * d;
    k.box(body, 0.034, leafH, LEAF_W + 0.003, 0, mid, along(LEAF_W / 2 - 0.0045), { c: 0.008, ...paint }); // 门板。铰链那一侧多伸 6 毫米压进门角柱，不留缝
    // 门面的横向压型（截面见 doorProfile）。左右两头收回到平的（最外面两排顶点不凸），像真的冲压件那样，凸起是封口的
    addPanel(k, v, SLOT.door, ribbedSheet(doorProfile(v.size), [0.06, 0.085, LEAF_W - 0.095, LEAF_W - 0.07], (y, bulge, d, row) => [row === 0 || row === 3 ? DOOR_RIB.low : bulge, y, along(d)], [1, 0, 0]), shade, [hingeX, 0, side * HINGE_Z]);
    // 胶条：中缝一条竖的，上下各一条横的
    k.box(body, 0.022, leafH + 0.012, 0.018, 0.004, mid, along(LEAF_W + 0.001), { plain: true, tint: RUBBER });
    for (const y of [doorTop + 0.004, DOOR_Y0 - 0.004]) k.box(body, 0.022, 0.016, LEAF_W, 0.004, y, along(LEAF_W / 2), { plain: true, tint: RUBBER });
    // 铰链：一片铰链板 + 一根镀锌销
    for (let i = 0, n = hc ? 5 : 4; i < n; i++) {
      const y = DOOR_Y0 + 0.16 + (i * (leafH - 0.32)) / (n - 1);
      k.box(body, 0.012, 0.062, 0.15, 0.021, y, along(0.085), { plain: true, ...paint });
      k.cyl('steel_galv', 0.013, 0.086, 0.026, y, along(-0.002), { seg: 6, open: true, ...zinc() });
    }
    // 锁杆：每扇两根竖的镀锌圆管，贯穿门的上下。转动把手，杆两头的凸轮就卡进门楣和门槛上的锁座
    for (const d of LOCK_RODS.offsets) {
      k.cyl('steel_galv', LOCK_RODS.radius, leafH + 0.2, LOCK_RODS.out, mid, along(d), { seg: 7, open: true, ...zinc() });
      for (const e of [-1, 1]) {
        k.box('steel_galv', 0.03, 0.045, 0.085, 0.048, mid + e * (leafH / 2 + 0.065), along(d), { plain: true, ...zinc() }); // 凸轮
        k.box(body, 0.03, 0.05, 0.075, 0.04, mid + e * (leafH / 2 - 0.035), along(d), { plain: true, ...paint });           // 把杆固定在门上的托架
      }
      for (const t of [0.3, 0.72]) k.box(body, 0.026, 0.04, 0.07, 0.04, DOOR_Y0 + leafH * t, along(d), { plain: true, ...paint }); // 导向卡
      // 把手：两根杆的把手一个朝左一个朝右、一高一低，这样才不打架
      const inner = d > 0.5, handleY = inner ? 1.02 : 1.15, dir = inner ? -1 : 1;
      k.box('steel_galv', 0.02, 0.05, 0.05, 0.06, handleY, along(d), { plain: true, ...zinc() });
      k.box('steel_galv', 0.011, 0.032, 0.36, 0.068, handleY, along(d + dir * 0.19), { c: 0.004, ...zinc() });
      k.box(body, 0.03, 0.07, 0.05, 0.044, handleY, along(d + dir * 0.33), { plain: true, ...paint });                      // 把手的卡座
      k.box('steel_galv', 0.012, 0.085, 0.012, 0.064, handleY + 0.005, along(d + dir * 0.33), { plain: true, ...zinc() }); // 卡扣
    }
    k.pop();
  }
  // 门楣和门槛上的锁座：对着四根锁杆各一个（它们长在门框上，不跟着门转）
  for (const side of [1, -1]) for (const d of LOCK_RODS.offsets) for (const y of [H - 0.07, 0.115]) {
    k.box(body, 0.035, 0.05, 0.11, p - 0.03, y, side * (HINGE_Z - d), { plain: true, ...paint });
  }

  // 开着门的箱子：门口的地板边上压着一条镀锌的门槛压条
  if (open) k.box('steel_galv', 0.05, 0.006, 2 * PANEL_Z - 0.2, p - 0.11, FLOOR_Y + 0.001, 0, { plain: true, ...zinc() });

  const model = k.finish({ grime: 0, size: [L, H, CONTAINER_WIDTH], boxes: containerBoxes(v.size, v.doors) });
  const interior = open ? buildInterior(plan) : null;
  return { body: partOf(model, BODY)!, metal: partOf(model, 'steel_galv'), inside: interior && partOf(interior, BODY), wood: interior && partOf(interior, 'wood_pallet'), boxes: model.boxes };
}

/**
 * 开着门的箱子：补上从门口能看到的内部 —— 两面内壁、顶板、后壁、木地板。
 * 它们单独搭成一组，因为要用"室内"版的材质（淋不到雨）。
 *
 * 内壁要投影，而且箱子里晒不晒得到太阳全靠它：外皮是一层没有厚度、只有朝外那一面的铁皮，而画阴影图时
 * 只画"背对太阳"的面（这是 three 的默认做法，可以避免物体自己给自己投出条纹）—— 迎着太阳的那块外皮正好不算数。
 * 内壁朝里，对太阳来说是背面，由它来把阳光挡在箱子外面。
 */
function buildInterior(plan: Plan): PropModel {
  const { half: p, top } = plan;
  const k = new Kit('container-inside', kitSeed(plan.v));
  // 越往里越黑：亮度从最里面的 0.16 升到门口的 0.78；贴近地板的一截再暗两成。这是画上去的"箱内阴影"：
  // 天空的环境光是不认遮挡的，箱子里和外面一样亮，只能靠顶点色把它压下去
  const dark = (x: number, y: number): Rgb => { const t = sstep(-p, p, x), b = (0.16 + 0.62 * t * t) * (0.8 + 0.2 * sstep(0.2, 1.4, y)); return [b, b, b]; };
  // 内壁比外皮往里收 5 厘米，而不是紧贴着。原因在外面的喷字：字的面片带着"深度偏移"（好稳稳盖在侧板上），
  // 从箱子里面贴着墙斜看过去时，这个偏移会被放大，紧贴的内壁挡不住，外面的字就透进来了。隔开 5 厘米就透不过来
  const wallTop = top - 0.02, inZ = PANEL_Z - 0.05, lengthwise = flatKnots(plan.sideFrom, plan.sideTo, 8), shell = { tint: dark };
  for (const side of [-1, 1]) for (const sheet of sheets(plan.sideKnots, 16)) {
    k.add(BODY, ribbedSheet(sheet, [FLOOR_Y, wallTop], (x, rib, y) => [x, y, side * (inZ - rib)], [0, 0, -side]), shell);            // 两面内壁：同样的波纹，朝里
  }
  for (const sheet of sheets(lengthwise, 2)) k.add(BODY, ribbedSheet(sheet, [-inZ, inZ], (x, _d, z) => [x, top - 0.03, z], [0, -1, 0]), shell); // 顶板
  k.add(BODY, ribbedSheet(flatKnots(-inZ, inZ, 1), [FLOOR_Y, wallTop], (z, _d, y) => [plan.sideFrom + 0.03, y, z], [1, 0, 0]), shell);       // 后壁
  // 木地板：两边各多伸 1 厘米插到内壁后面，免得墙根露出一条缝；门口那头伸到门槛上
  k.add('wood_pallet', ribbedSheet(flatKnots(plan.sideFrom, plan.sideTo + 0.1, 8), [-inZ - 0.01, inZ + 0.01], (x, _d, z) => [x, FLOOR_Y, z], [0, 1, 0]), {
    tint: (x) => { const b = 0.3 + 0.6 * sstep(-p, p, x) ** 2; return [b, b * 0.97, b * 0.93]; }, grain: 'x', cast: false,
  });
  return k.finish({ grime: 0 });
}

/**
 * 一只箱子的碰撞盒（箱子自己的坐标）。
 * 关着门的箱子就是一个整盒；开着门的换成空壳 —— 地板、顶板、两侧壁、后壁各一片薄盒，再沿每扇门板排三个小盒，
 * 人可以从门口走进去。
 */
export function containerBoxes(size: ContainerSize, doors = 0): LocalBox[] {
  const { length, height: H } = CONTAINER_SIZES[size], p = length / 2, f = HALF_W, v = containerVariant({ size, doors });
  if (v.doors <= 0) return [{ min: [-p, 0, -f], max: [p, H, f], surface: 'metal' }];
  const WALL = 0.07;
  const boxes: LocalBox[] = [
    { min: [-p, 0, -f], max: [p, FLOOR_Y, f], surface: 'wood' },
    { min: [-p, H - 0.09, -f], max: [p, H, f], surface: 'metal' },
    { min: [-p, 0, -f], max: [p, H, -f + WALL], surface: 'metal' },
    { min: [-p, 0, f - WALL], max: [p, H, f], surface: 'metal' },
    { min: [-p, 0, -f], max: [-p + WALL, H, f], surface: 'metal' },
  ];
  // 碰撞盒只能是横平竖直的，斜开着的门板用三个小盒子沿着它排开来近似
  for (const side of [1, -1]) {
    const a = doorAngle(v.doors, side), hx = p - 0.066, hz = side * HINGE_Z;
    for (let i = 0; i < 3; i++) {
      const d0 = (LEAF_W * i) / 3, d1 = (LEAF_W * (i + 1)) / 3;
      const x0 = hx + Math.sin(a) * d0, x1 = hx + Math.sin(a) * d1, z0 = hz - side * Math.cos(a) * d0, z1 = hz - side * Math.cos(a) * d1;
      boxes.push({ min: [Math.min(x0, x1) - 0.03, DOOR_Y0, Math.min(z0, z1) - 0.03], max: [Math.max(x0, x1) + 0.03, H - 0.124, Math.max(z0, z1) + 0.03], surface: 'metal' });
    }
  }
  return boxes;
}

// ====================================================================== 精模：喷字和污迹

/** 一只箱子身上的五行喷字（在全场共用的文字图集里）：箱主代号、箱型代码是镂空的喷字，三行重量是普通的小字。 */
function markLabels(v: { size: ContainerSize; seed: number }) {
  const spec = CONTAINER_SIZES[v.size];
  const stencil = { color: 'white', font: 'stencil', distress: 0.3 } as const, small = { color: 'white', font: 'sans', distress: 0.2 } as const;
  return {
    owner: label(OWNER_CODES[v.seed % OWNER_CODES.length], stencil),
    type: label(spec.typeCode, stencil),
    gross: label(`最大总重 ${spec.gross} 千克`, small),
    weights: label(`皮重 ${spec.tare} 千克  净重 ${spec.net} 千克`, small),
    cube: label(`容积 ${spec.cube} 立方米`, small),
  };
}
/** 贴纸图集里和箱子有关的几张：四家船公司的标、门上的安全合格牌、高箱门顶的警示条、锈水条、污水条。 */
function markDecals(brand: number) {
  return {
    logo: decal(SHIPPING_LINES[brand % SHIPPING_LINES.length].decal),
    plate: decal('csc_plate'), caution: decal('caution_stripes'), rust: decal('rust_run'), grime: decal('grime_streak'),
  };
}
/**
 * 把集装箱要用的字和贴纸一次画进图集（18 行字 + 8 张贴纸）。
 * 图集每添一块新东西，整张图（两千多像素见方）就要重新传给显卡一次；如果等到某种箱子第一次走近时才画它的字，
 * 游戏中途就会一下一下地卡。所以在开场搭场景的时候先全部画完。
 */
export function prepareContainerMarks() {
  for (let brand = 0; brand < SHIPPING_LINES.length; brand++) markDecals(brand);
  for (const size of [20, 40, 'hc'] as const) for (let seed = 0; seed < SEED_VARIANTS; seed++) markLabels({ size, seed });
}

/**
 * brand 要单独传进来，不能用 plan.v.brand：方案（Plan）是按 规格|花样|做旧 缓存的，几家船公司共用同一份，
 * 它里面记的 brand 只是"第一个用到这份方案的箱子"的那一家。
 */
function buildMarks(plan: Plan, brand: number): THREE.BufferGeometry | null {
  const { v, H, half: p, top } = plan, hc = v.size === 'hc';
  const mat = containerMaterials().marks, art = markDecals(brand);
  const k = new Kit('container-marks', v.seed);
  const text = markLabels(v), owner = text.owner, type = text.type, logo = art.logo;
  const remap = (g: THREE.BufferGeometry, patch: Patch) => {
    const uv = g.getAttribute('uv'), [u0, v0, u1, v1] = patch.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    return g;
  };

  const nearestKnot = (x: number) => plan.sideKnots.reduce((best, kn) => (Math.abs(kn[0] - x) < Math.abs(best - x) ? kn[0] : best), plan.sideKnots[0][0]);
  /**
   * 侧板上的一条"带子"：高 h，宽按图案的宽高比算（超过 maxW 就整体缩小）。中心在 (cx, cy)。
   * 带子沿着波纹截面折，浮在侧板表面外 3 毫米；侧板在哪几列为凹坑加了顶点，带子在那几列也跟着加，所以坑里的字是跟着凹进去的。
   * cx 按"从外面看"的习惯给：两侧是镜像的，-z 那一侧实际的 x 要反过来，贴图也要左右翻一下，字才是正的。
   */
  const strip = (patch: Patch, side: number, cx: number, cy: number, h: number, maxW = Infinity, w = h * patch.aspect) => {
    if (w > maxW) { h *= maxW / w; w = maxW; }
    const left = side > 0 ? cx - w / 2 : -(cx + w / 2), from = Math.max(plan.sideFrom, left), to = Math.min(plan.sideTo, left + w);
    if (to - from < 0.02) return;
    const y0 = cy - h / 2, y1 = cy + h / 2, [u0, v0, u1, v1] = patch.uv;
    // 带子两头的那一列不在折点上，它借用离它最近的折点的排
    const rows = (x: number) => [y0, ...plan.rows(nearestKnot(x), side).filter((y) => y > y0 + 0.01 && y < y1 - 0.01), y1];
    k.add(mat, ribbedSheet(ribKnots(from, to, SIDE_RIB, plan.sideFrom + 0.02), rows, (x, _rib, y) => [x, y, side * (plan.surfaceAt(x, y, side) + 0.003)], [0, 0, side], (q) => {
      const s = (q[0] - left) / w;
      return [u0 + (u1 - u0) * (side > 0 ? s : 1 - s), v0 + ((v1 - v0) * (q[1] - y0)) / h];
    }), { raw: true, cast: false });
  };
  for (const side of [-1, 1]) {
    const logoH = Math.min(H * 0.4, 1.05), logoW = Math.min(logoH * logo.aspect, v.size === 20 ? 2.2 : 3.4);
    strip(logo, side, v.size === 20 ? -0.75 : -p * 0.42, H * 0.52, logoW / logo.aspect);          // 船公司标：侧板中间偏前
    strip(owner, side, p - 0.3 - Math.min(0.14 * owner.aspect, 1.9) / 2, H - 0.32, 0.14, 1.9);   // 箱主代号：右上角，右边对齐到离门端 0.3 米
    strip(type, side, p - 0.3 - Math.min(0.11 * type.aspect, 0.6) / 2, H - 0.52, 0.11, 0.6);     // 箱型代码：在它下面
  }
  // 锈水 / 污水条：顶端贴着上侧梁，往下淌
  for (const s of plan.stains) strip(s.rust ? art.rust : art.grime, s.side, s.x, top - s.height / 2 - 0.005, s.height, Infinity, s.width);

  // ---- 门上的字：平的面片，贴在压型凸起的顶面外 2.5 毫米
  const doorTop = H - 0.124, ribs = hc ? 7 : 6, y0 = DOOR_Y0 + 0.085, pitch = (doorTop - 0.085 - y0) / ribs;
  const ribY = (i: number) => y0 + (i + 0.5) * pitch; // 第 i 道凸起的中心高度（从下往上数）
  for (const side of [1, -1]) {
    k.push([p - 0.066, 0, side * HINGE_Z], [0, -side * doorAngle(v.doors, side), 0]);
    const put = (patch: Patch, h: number, y: number, d: number, maxW: number) => {
      let w = h * patch.aspect;
      if (w > maxW) { h *= maxW / w; w = maxW; }
      k.add(mat, remap(new THREE.PlaneGeometry(w, h), patch), { raw: true, cast: false }, xform([0.0335, y, -side * d], [0, Math.PI / 2, 0]));
    };
    if (side < 0) { // -z 那扇（站在门外看是右门）：箱主代号、箱型代码、三行重量
      put(owner, 0.115, ribY(ribs - 1), LEAF_W / 2, LEAF_W - 0.24);
      put(type, 0.1, ribY(ribs - 2), LEAF_W / 2 + 0.2, 0.4);
      put(text.gross, 0.052, ribY(ribs - 3) + 0.062, LEAF_W / 2 - 0.01, 0.44);
      put(text.weights, 0.045, ribY(ribs - 3), LEAF_W / 2 - 0.01, 0.44);
      put(text.cube, 0.045, ribY(ribs - 3) - 0.062, LEAF_W / 2 - 0.01, 0.44);
    } else {        // +z 那扇（左门）：船公司标、安全合格牌；高箱的门顶再贴一条黄黑斜纹（提醒吊车司机这只箱子超高）
      put(logo, 0.2, ribY(ribs - 1), LEAF_W / 2, LEAF_W - 0.36);
      put(art.plate, 0.17, ribY(1), LEAF_W / 2 + 0.05, 0.36);
      if (hc) put(art.caution, 0.1, doorTop - 0.04, LEAF_W / 2, LEAF_W - 0.1);
    }
    k.pop();
  }
  return (k.finish({ grime: 0 }).group.children[0] as THREE.Mesh | undefined)?.geometry ?? null;
}

// ====================================================================== 中模和简模

/** 波纹槽里的压暗，精模是一道一道的；没有波纹的平板只能取平均：斜面和内平面合起来占一个周期的将近一半。 */
const grooveShare = (c: Corrugation) => (c.slope + (c.period - c.flat - 2 * c.slope)) / c.period;
/** 中模、简模共用的几排高度：泥污在 0.44 米以下最浓，锈条集中在离箱顶半米以内，中间一大段没什么变化。精模的侧板也有这几排。 */
const coarseRows = (lo: number, hi: number, H: number) => [lo, 0.44, H - 0.5, hi];

/**
 * 中等距离用的"中模"：40 尺箱两千六百多个三角形，20 尺箱一千五百多个，大约是精模的三分之一。
 *
 * 留下的：两块侧板和前端板的真波纹（和精模用同一套折点，所以棱的位置、明暗一模一样），上下侧梁和角柱那一圈框的轮廓，
 *         门板上那几道横向的压型，顶点色里的泥污和锈条。四根镀锌锁杆也留着，不过它们不是漆的颜色，另算一块（见 containerMidRods）。
 * 省掉的：凹坑（要很密的顶点才压得圆）、箱顶的波纹（从地面看不见）、角件、通风器，门上的铰链、把手、锁座、胶条 ——
 *         两扇门在这里是连成一片的一张压型板。
 *         喷字也不带：箱主代号那样的小字二十几米外已经认不出来了；只有侧面那块三米多宽的船公司标还看得清，
 *         它用简模的那张平面片（containerLodLogo）顶替。
 *
 * 为什么要有它：二十几米外已经看不清锁杆和铰链了，但波纹板在斜阳底下一道亮一道暗，隔着五六十米还看得出来。
 * 只有精模和简模两档的话，箱子一换成简模就从"波纹铁皮"变成"光板"，走着走着能看见前面的箱子一只只变平。
 */
function buildMid(plan: Plan) {
  const { v, L, H, half: p, shade } = plan;
  const k = new Kit('container-mid', kitSeed(v));
  const paint = { tint: shade };
  /** 一块朝 out 方向的平板：a 轴从 a0 到 a1 分 n 格，b 轴从 b0 到 b1 一格；at 把 (a, b) 换成顶点坐标。框上的各条边都用它。 */
  const flat = (a0: number, a1: number, n: number, b0: number, b1: number, at: (a: number, b: number) => V3, out: V3) => k.add(BODY, ribbedSheet(flatKnots(a0, a1, n), [b0, b1], (a, _d, b) => at(a, b), out), paint);
  const RAIL0 = 0.17, RAIL1 = H - 0.062, long = L > 7 ? 5 : 3; // 下侧梁的顶面、上侧梁的底面；长边上的梁分几格（格子多一点，顶点色的深浅才有变化）
  // 框在这里只是贴在外面的平条，没有厚度；波纹板在它后面几厘米。斜着看过去，视线会从平条的边上"钻"到板的后面，
  // 所以每块板都要往平条背后多伸出去一截（上下各伸到 LAP0 / LAP1），把这条缝堵上。精模的框是实心的方梁，没有这个问题
  const LAP0 = PANEL_Y0 - 0.06, LAP1 = H - 0.02;

  // ---- 两块侧板：真波纹，四排顶点；外面一圈框（上下侧梁、前后角柱）是比波纹凸出 8 毫米的平条
  const zf = HALF_W - 0.004;
  for (const side of [-1, 1]) {
    sideSheets(plan).forEach((sheet, i) => {
      addPanel(k, v, SLOT.side(side, i), ribbedSheet(sheet, coarseRows(LAP0, LAP1, H), (x, rib, y) => [x, y, side * (PANEL_Z - rib)], [0, 0, side]), (x, y, z) => plan.sidePaint(x, y, z, false));
    });
    const at = (x: number, y: number): V3 => [x, y, side * zf], out: V3 = [0, 0, side];
    flat(-p, p, long, 0, RAIL0, at, out);                    // 下侧梁
    flat(-p, p, long, RAIL1, H, at, out);                    // 上侧梁
    flat(-p, -p + 0.09, 1, RAIL0, RAIL1, at, out);           // 前角柱
    flat(p - 0.144, p, 1, RAIL0, RAIL1, at, out);            // 门角柱
  }
  // ---- 前端：波纹板 + 一圈框
  addPanel(k, v, SLOT.front, ribbedSheet(frontKnots(), [LAP0, 1.25, LAP1], (z, rib, y) => [frontX(p) + rib, y, z], [-1, 0, 0]), frontPaint(plan));
  {
    const at = (z: number, y: number): V3 => [-p + 0.004, y, z], out: V3 = [-1, 0, 0];
    flat(-HALF_W, HALF_W, 2, 0, RAIL0, at, out);
    flat(-HALF_W, HALF_W, 2, RAIL1, H, at, out);
    for (const s of [-1, 1]) flat(s * (HALF_W - 0.155), s * HALF_W, 1, RAIL0, RAIL1, at, out);
  }
  // ---- 门端：两扇门连成一张压型板，外面一圈门框。
  //      压型的截面和精模一样（见 doorProfile），只是横向省成 7 排顶点：门的两边、每扇门压型的两头、中缝。
  //      压型从每扇门的两头斜着鼓起来，到中缝又落回去，所以中间那条缝看上去还在
  {
    const doorTop = H - 0.124, edge = HINGE_Z, hingeX = p - 0.066;
    const wide = HALF_W - 0.03; // 板的四边都伸到门框的平条背后去
    const across = [-wide, -edge + 0.085, -0.099, 0, 0.099, edge - 0.085, wide], raised = [false, true, true, false, true, true, false];
    // doorProfile 里每道凸起是 5 个点，头一个点（凸起之间的平段上）中模用不着：平段两头已经各有一个点了
    const profile: [number, number][] = [[LAP0, DOOR_RIB.low], ...doorProfile(v.size).filter((_, i) => i % 5 !== 0), [LAP1, DOOR_RIB.low]];
    addPanel(k, v, SLOT.door, ribbedSheet(profile, across, (y, bulge, z, row) => [hingeX + (raised[row] ? bulge : DOOR_RIB.low), y, z], [1, 0, 0]), shade);
    const at = (z: number, y: number): V3 => [p - 0.006, y, z], out: V3 = [1, 0, 0];
    flat(-HALF_W, HALF_W, 2, 0, RAIL0, at, out);             // 门槛
    flat(-HALF_W, HALF_W, 2, doorTop, H, at, out);           // 门楣
    for (const s of [-1, 1]) flat(s * edge, s * HALF_W, 1, RAIL0, doorTop, at, out);
  }
  // ---- 箱顶：平板。和精模的箱顶切成同样的几张，贴图挪到同样的位置
  const roofGroove = grooveShare(ROOF_RIB);
  spans(roofSheets(plan), -p, p).forEach(([a, b], i) => {
    addPanel(k, v, SLOT.roof(i), ribbedSheet([[a, 0], [b, 0]], [-zf, zf], (x, _d, z) => [x, H, z], [0, 1, 0]), (x, _y, z) => plan.roofPaint(x, z, roofGroove));
  });
  // ---- 箱底：一块朝下的暗板
  k.plane(BODY, L - 0.06, CONTAINER_WIDTH - 0.06, [0, 0.02, 0], { rot: [Math.PI / 2, 0, 0], tint: 0.3 });
  return (k.finish({ grime: 0 }).group.children[0] as THREE.Mesh).geometry;
}

/**
 * 中模门上的四根锁杆（镀锌的，不跟着箱体颜色走，所以不能和箱体并成一块）。
 * 只留杆子本身，五棱的细管，一共 40 个三角形；凸轮、把手那些小件二十几米外看不见。
 * 隔着五六十米，箱门上最认得出来的就是这四道发亮的竖线，少了它，箱门就成了一块光板。
 */
function buildMidRods(size: ContainerSize) {
  const { length, height: H } = CONTAINER_SIZES[size], hingeX = length / 2 - 0.066, doorTop = H - 0.124, leafH = doorTop - DOOR_Y0;
  const k = new Kit('container-mid-rods', size === 20 ? 0 : size === 40 ? 1 : 2);
  for (const side of [1, -1]) LOCK_RODS.offsets.forEach((d, i) => {
    // 比精模的锁杆粗四分之一：五棱的细管本来就比圆管显瘦，隔得又远，不加粗的话在屏幕上会细到断断续续
    k.cyl('steel_galv', LOCK_RODS.radius * 1.25, leafH + 0.2, hingeX + LOCK_RODS.out, (DOOR_Y0 + doorTop) / 2, side * (HINGE_Z - d), { seg: 5, open: true, tint: 0.84 + 0.1 * i, cast: false });
  });
  return (k.finish({ grime: 0 }).group.children[0] as THREE.Mesh).geometry;
}

/**
 * 远处用的简模：一个平板盒子，两百个三角形上下。
 * 没有波纹、没有门上的小零件，但顶点色照样写（泥污、锈条、箱顶褪色），所以远看颜色和精模是接得上的。
 * 各个面都放在精模对应面的"波纹中线"上 —— 它同时还替近处的箱子投影子（见 containerfield.ts），不能比精模鼓出来太多。
 * 侧面、箱顶和精模切成同样的几张板，贴图也挪到同样的位置（见 addPanel）。
 */
function buildLod(plan: Plan) {
  const { v, H, half: p, shade, wear } = plan;
  const k = new Kit('container-lod', kitSeed(v)), body = BODY;
  const z = PANEL_Z - SIDE_RIB.depth / 2, x0 = -(p - 0.035), x1 = p - 0.049;
  const sides = spans(sideSheets(plan), x0, x1), sheetW = (x1 - x0) / sides.length;
  const sideGroove = grooveShare(SIDE_RIB);
  const sideTint = (x: number, y: number, zz: number): Rgb => {
    const side = zz > 0 ? 1 : -1, c = shade(x, y, zz);
    c[0] *= 1 - 0.17 * sideGroove; c[1] *= 1 - 0.18 * sideGroove; c[2] *= 1 - 0.18 * sideGroove;
    // 锈条比顶点的间距窄得多，会从两列顶点之间漏掉。所以把每一道摊宽到一张板的宽度，浓度按比例调淡，总量不变
    const hang = sstep(H - 0.75, H, y);
    if (hang > 0) for (const s of plan.streaks) if (s.side === side) {
      const wide = Math.max(s.halfWidth, sheetW), t = Math.abs(x - s.x) / wide;
      if (t < 1) stain(c, RUST_TINT, hang * hang * s.strength * (1 - t * t) * (0.45 + 0.55 * wear) * (s.halfWidth / wide));
    }
    return c;
  };
  for (const side of [-1, 1]) sides.forEach(([a, b], i) => {
    addPanel(k, v, SLOT.side(side, i), ribbedSheet([[a, 0], [b, 0]], coarseRows(0, H, H), (x, _d, y) => [x, y, side * z], [0, 0, side]), sideTint);
  });
  const roofGroove = grooveShare(ROOF_RIB), endGroove = grooveShare(END_RIB);
  spans(roofSheets(plan), x0, x1).forEach(([a, b], i) => {
    addPanel(k, v, SLOT.roof(i), ribbedSheet([[a, 0], [b, 0]], [-z, z], (x, _d, zz) => [x, H, zz], [0, 1, 0]), (x, _y, zz) => plan.roofPaint(x, zz, roofGroove));
  });
  addPanel(k, v, SLOT.front, ribbedSheet(flatKnots(-z, z, 2), [0, H / 2, H], (zz, _d, y) => [x0, y, zz], [-1, 0, 0]),
    (x, y, zz) => { const c = shade(x, y, zz); return [c[0] * (1 - 0.17 * endGroove), c[1] * (1 - 0.18 * endGroove), c[2] * (1 - 0.18 * endGroove)]; });
  k.add(body, ribbedSheet(flatKnots(-z, z, 2), [0, 0.3, 0.62, H], (zz, _d, y) => [x1, y, zz], [1, 0, 0]), { tint: (x, y, zz) => { const c = shade(x, y, zz); return [c[0] * 0.94, c[1] * 0.94, c[2] * 0.94]; } });
  k.plane(body, x1 - x0, 2 * z, [(x0 + x1) / 2, 0, 0], { rot: [Math.PI / 2, 0, 0], tint: 0.3 });
  return (k.finish({ grime: 0 }).group.children[0] as THREE.Mesh).geometry;
}

// ====================================================================== 对外：带缓存的几何

export interface ContainerDetail {
  /** 箱体漆：唯一要染上箱体颜色的一块。 */
  body: THREE.BufferGeometry;
  /** 镀锌件和深色的孔。 */
  metal: THREE.BufferGeometry | null;
  /** 内壁、顶板、后壁，只有开门的箱子有。也要染箱体颜色。 */
  inside: THREE.BufferGeometry | null;
  /** 木地板，只有开门的箱子有。 */
  wood: THREE.BufferGeometry | null;
  /** 喷字、船公司标、合格牌、锈水条（贴在表面外 3 毫米的面片）。 */
  marks: THREE.BufferGeometry | null;
  boxes: LocalBox[];
  triangles: number;
}
const plans = new Map<string, Plan>(), cores = new Map<string, Core>(), marks = new Map<string, THREE.BufferGeometry | null>(), mids = new Map<string, THREE.BufferGeometry>(), midRods = new Map<ContainerSize, THREE.BufferGeometry>(), lods = new Map<string, THREE.BufferGeometry>(), lodLogos = new Map<string, THREE.BufferGeometry>();
const coreKey = (v: ContainerVariant) => `${v.size}|${v.seed}|${v.wear}|${v.doors}`;
function planOf(v: ContainerVariant) {
  const key = coreKey(v);
  let plan = plans.get(key);
  if (!plan) plans.set(key, (plan = makePlan(v)));
  return plan;
}
const triangles = (g: THREE.BufferGeometry | null) => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

/** 一个变体的精模。同样的参数只搭一次；只是船公司不同的两个变体，箱体那部分几何是共用的。 */
export function containerDetail(o: ContainerOpts): ContainerDetail {
  const v = containerVariant(o), key = coreKey(v);
  let core = cores.get(key);
  if (!core) cores.set(key, (core = buildCore(planOf(v))));
  const text = containerMarks(v);
  return { ...core, marks: text, triangles: triangles(core.body) + triangles(core.metal) + triangles(core.inside) + triangles(core.wood) + triangles(text) };
}
/**
 * 一个变体身上的喷字和污迹（船公司标、箱主代号、合格牌、锈水条……贴在表面外 3 毫米的一层面片）。
 * 单独能取，是因为它比箱体多分一层：同一种箱体可以是几家船公司的，箱体的几何共用一份，喷字各家一份。
 */
export function containerMarks(o: ContainerOpts): THREE.BufferGeometry | null {
  const v = containerVariant(o), key = `${coreKey(v)}|${v.brand}`;
  if (!marks.has(key)) marks.set(key, buildMarks(planOf(v), v.brand));
  return marks.get(key)!;
}
/** 一个变体的中模（只有箱体漆一块，关着门）。和哪家船公司无关。 */
export function containerMid(o: ContainerOpts): THREE.BufferGeometry {
  const v = containerVariant({ ...o, doors: 0 }), key = coreKey(v);
  let g = mids.get(key);
  if (!g) mids.set(key, (g = buildMid(planOf(v))));
  return g;
}
/** 中模门上的四根锁杆。只和规格有关：同一种规格的箱子，不管新旧、哪家公司，锁杆都在同一个位置。 */
export function containerMidRods(size: ContainerSize): THREE.BufferGeometry {
  let g = midRods.get(size);
  if (!g) midRods.set(size, (g = buildMidRods(size)));
  return g;
}
/** 一个变体的简模（只有箱体漆一块）。和开不开门、哪家船公司无关。 */
export function containerLod(o: ContainerOpts): THREE.BufferGeometry {
  const v = containerVariant({ ...o, doors: 0 }), key = coreKey(v);
  let g = lods.get(key);
  if (!g) lods.set(key, (g = buildLod(planOf(v))));
  return g;
}
/**
 * 中模和简模用的船公司标：两侧各一张平的面片，大小、位置和精模上沿着波纹折出来的那块标一样。
 * 三米多宽的白色大字隔着一百米也看得见，如果一离开精模它就消失，会很扎眼；所以单独留着它。
 * 它只和规格、船公司有关，和 seed、做旧无关，于是全场所有同规格同公司的远处箱子可以一次画完。
 */
export function containerLodLogo(size: ContainerSize, brand: number): THREE.BufferGeometry {
  const key = `${size}|${brand}`;
  let g = lodLogos.get(key);
  if (!g) {
    const { length, height: H } = CONTAINER_SIZES[size], logo = markDecals(brand).logo;
    const w = Math.min(Math.min(H * 0.4, 1.05) * logo.aspect, size === 20 ? 2.2 : 3.4), h = w / logo.aspect, cx = size === 20 ? -0.75 : -(length / 2) * 0.42;
    const z = HALF_W, [u0, v0, u1, v1] = logo.uv; // 浮在简模侧面外 3 厘米：远处深度缓冲很粗，贴得太近会闪
    const quads = [1, -1].map((side) => {
      const q = new THREE.PlaneGeometry(w, h), uv = q.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
      if (side < 0) q.rotateY(Math.PI); // 转到背面去：位置和朝向一起镜像，字还是正的
      return q.translate(side * cx, H * 0.52, side * z);
    });
    lodLogos.set(key, (g = mergeGeometries(quads)));
  }
  return g;
}

/**
 * 给一块"要染箱体颜色"的几何配上网格。颜色是靠实例颜色乘上去的，所以哪怕只画一只，也用（只有一个实例的）InstancedMesh ——
 * 这样单只的箱子和成批的箱子始终共用同一个材质。userData.tintable 是给合并场景的代码看的记号：这个网格的颜色来自实例颜色。
 */
export function tintedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, color: THREE.ColorRepresentation, count = 1) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.setColorAt(0, new THREE.Color(color)); // 第一次 setColorAt 会把实例颜色的缓冲建出来
  mesh.receiveShadow = true;
  mesh.userData.tintable = true;
  return mesh;
}
/** 把一只精模箱子的几块几何各配上材质，装成一组网格。只有外皮和内壁投影：别的零件太小，影子看不出来。 */
export function containerMeshes(d: ContainerDetail, color: THREE.ColorRepresentation): THREE.Group {
  const mats = containerMaterials(), group = new THREE.Group();
  for (const [geometry, material] of [[d.body, mats.body], [d.inside, mats.inside]] as const) {
    if (!geometry) continue;
    const mesh = tintedMesh(geometry, material, color);
    mesh.castShadow = true;
    group.add(mesh);
  }
  for (const [geometry, material] of [[d.metal, mats.metal], [d.wood, mats.wood], [d.marks, mats.marks]] as const) {
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** 单独搭一只箱子（模型查看器用；游戏里成批的箱子走 ContainerField）。lod: true 是看它的简模，mid: true 是看中模。 */
export function buildContainer(o: ContainerOpts & { color?: number; lod?: boolean; mid?: boolean } = {}): PropModel {
  const v = containerVariant(o), spec = CONTAINER_SIZES[v.size], color = o.color ?? CONTAINER_COLORS.blue;
  let group: THREE.Group;
  if (o.lod || o.mid) {
    const body = tintedMesh(o.mid ? containerMid(v) : containerLod(v), containerMaterials().body, color);
    body.castShadow = true;
    group = new THREE.Group().add(body, new THREE.Mesh(containerLodLogo(v.size, v.brand), containerMaterials().marks)); // 中模、简模身上都只有两侧那块平的船公司标
    if (o.mid) group.add(new THREE.Mesh(containerMidRods(v.size), containerMaterials().metal));
  } else group = containerMeshes(containerDetail(v), color);
  group.name = `container${v.size}`;
  return { group, boxes: containerBoxes(v.size, v.doors), size: [spec.length, spec.height, CONTAINER_WIDTH], name: group.name };
}
