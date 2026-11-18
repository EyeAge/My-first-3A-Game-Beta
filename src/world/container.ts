import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, fbm, mulberry32, vnoise } from '../core/math';
import { surface, type SurfaceName } from '../render/surfaces';
import { Kit, type LocalBox, type PropModel, type Rgb, type V3 } from './kit';

// 集装箱。
//
// 集装箱是这个游戏里占画面最多的东西，所以值得把它做细。这个文件只管"一只箱子长什么样"，
// 几百只箱子怎么摆、怎么画得动，在 containerfield.ts 里。
//
// 做法上有两个要点：
//
//   1. 波纹是真的几何。侧板、前端板、箱顶都按真实的梯形截面折出来，顶点只放在折线上（一个周期 4 个点），
//      平的地方不浪费三角形。斜阳一照，每道棱自己就有明暗。
//
//   2. 整只箱子的漆只用一种白色材质。箱子是红是蓝，由"实例颜色"乘上去（见 containerfield.ts）；
//      哪里脏、哪里锈、哪里被撞瘪掉了漆，全部写在顶点色里 —— 顶点色是一个乘数，1 是原色，0.5 是暗一半。
//      这样不需要任何一张"箱体贴图"，而每只箱子的锈迹位置都可以不一样（由 seed 决定）。
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
  /** 侧板的漆：在基础明暗上再加三样 —— 波纹槽里压暗、顶梁淌下来的锈条、凹坑里掉漆发锈。 */
  const sidePaint = (x: number, y: number, z: number): Rgb => {
    const side = z > 0 ? 1 : -1, c = shade(x, y, z);
    // 槽里照不到多少天光，压暗一点（假的"环境光遮蔽"）。凹进去 8 毫米开始暗，34 毫米暗到头
    const groove = sstep(0.008, 0.034, PANEL_Z - Math.abs(z));
    c[0] *= 1 - 0.17 * groove; c[1] *= 1 - 0.18 * groove; c[2] *= 1 - 0.18 * groove;
    const hang = sstep(H - 0.75, top, y); // 锈条只在离箱顶 0.75 米以内，越往上越浓
    if (hang > 0) for (const s of streaks) if (s.side === side) {
      const t = Math.abs(x - s.x) / s.halfWidth;
      if (t < 1) stain(c, RUST_TINT, hang * hang * s.strength * (1 - t * t) * (0.45 + 0.55 * wear));
    }
    const dent = dentAt(x, y, side);
    if (dent > 0.004) stain(c, BARE, Math.min(0.8, dent * 22));
    return c;
  };
  /** 箱顶：单独一套颜色，偏灰、褪色（常年日晒）。groove 是这一点凹进槽里的程度（0–1）：槽里积灰，更暗并且偏黄。 */
  const roofPaint = (x: number, z: number, groove: number): Rgb => {
    const fade = 0.78 + 0.3 * vnoise(x * 0.8 + shift, z * 1.1);
    return [fade * (1 - 0.25 * groove), fade * (1 - 0.3 * groove) * 0.97, fade * (1 - 0.32 * groove) * 0.94];
  };

  const sideKnots = ribKnots(sideFrom, sideTo, SIDE_RIB, sideFrom + 0.02);

  return { v, spec, L, H, half, top, wear, shift, dents, streaks, rows, dentAt, shade, sidePaint, roofPaint, sideFrom, sideTo, sideKnots };
}

// ====================================================================== 材质

/**
 * 箱子用到的几种材质。
 *   body   箱体漆：白色、开顶点色。箱子的颜色由实例颜色乘上去，所以几百只箱子、八种颜色只要这一个材质
 *   inside 开门箱的内壁：同一种漆，但标成"室内" —— 箱子里淋不到雨，不该有水珠和湿漉漉的反光
 *   metal  镀锌件（锁杆、铰链销、把手），深色的孔也借用它 —— 它们都不跟着箱体颜色变
 *   wood   箱内的木地板（同样是室内）
 */
export function containerMaterials() {
  return {
    body: surface(BODY, { vertexColors: true, color: 0xffffff }),
    inside: surface(BODY, { vertexColors: true, color: 0xffffff, interior: true }),
    metal: surface('steel_galv', { vertexColors: true }),
    wood: surface('wood_pallet', { vertexColors: true, interior: true }),
  };
}

// ====================================================================== 精模：箱体

interface Core { body: THREE.BufferGeometry; metal: THREE.BufferGeometry | null; inside: THREE.BufferGeometry | null; wood: THREE.BufferGeometry | null; boxes: LocalBox[] }

/** 零件箱的种子：规格、花样、做旧三样都算进去，于是每个变体的贴图挪位都不一样，摞在一起的箱子不会在同一个位置掉同一块漆。 */
const kitSeed = (v: ContainerVariant) => v.seed + Math.round(v.wear * 2) * 10 + (v.size === 20 ? 0 : v.size === 40 ? 100 : 200);
/** 零件箱搭完以后，取出某种材质合并成的那一块几何（零件箱给网格起的名字是"模型名:材质名"）。 */
function partOf(model: PropModel, name: SurfaceName) {
  const found = (model.group.children as THREE.Mesh[]).filter((c) => c.name.endsWith(`:${name}`)).map((c) => c.geometry);
  return found.length > 1 ? mergeGeometries(found) : found[0] ?? null; // 同一种材质里有的零件投影、有的不投影时，零件箱会分成两块，这里并回去
}

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

  // ---- 两块侧板：波纹截面 × 几排顶点。有坑的地方把顶点往里压。
  //      板的两头各多伸 2 厘米，插进角柱里面：角柱的棱是倒过角的，板如果刚好只到角柱的边，倒角那里会露出一条能看穿箱子的细缝
  const sideKnots = plan.sideKnots, sealed = embed(sideKnots, 0.02);
  for (const side of [-1, 1]) for (const sheet of sheets(sealed, 16)) { // 16 格 = 4 个波纹周期，1.1 米一张
    k.add(body, ribbedSheet(sheet, (x) => plan.rows(x, side), (x, rib, y) => [x, y, side * (PANEL_Z - rib - plan.dentAt(x, y, side))], [0, 0, side]), { tint: plan.sidePaint });
  }
  // ---- 通风器：侧板靠上的小盖板，上面三道细缝。20 尺箱每侧一个，40 尺箱每侧两个
  for (const sz of [-1, 1]) for (const e of L > 7 ? [-1, 1] : [1]) {
    const x = sz * e * (p - 0.62), y = H - 0.165;
    k.box(body, 0.24, 0.1, 0.03, x, y, sz * (PANEL_Z - 0.004), { c: 0.008, ...paint });
    for (let i = -1; i <= 1; i++) hole(0.18, 0.012, [x, y + i * 0.026, sz * (PANEL_Z + 0.011 + HOLE_GAP)], [0, sz > 0 ? 0 : Math.PI, 0], new THREE.PlaneGeometry(0.18, 0.012));
  }
  // ---- 前端板：竖棱沿 z 排开，比侧板的波纹深一点。两边同样插进角柱 2 厘米；
  //      下沿比侧板多往下伸 6 厘米，藏到前下梁的背后 —— 前下梁只有 5 厘米厚，挡不住波纹凹进去的那一半，不伸下去的话槽底会漏光
  const endX = -(p - 0.014); // 前端板外平面的 x
  k.add(body, ribbedSheet(embed(ribKnots(-1.064, 1.064, END_RIB, -1.034), 0.025), [PANEL_Y0 - 0.06, PANEL_Y0, 1.25, top], (z, rib, y) => [endX + rib, y, z], [-1, 0, 0]), {
    tint: (x, y, z) => { const c = shade(x, y, z), g = sstep(0.008, 0.038, x - endX); return [c[0] * (1 - 0.17 * g), c[1] * (1 - 0.18 * g), c[2] * (1 - 0.18 * g)]; },
  });
  // ---- 箱顶：横棱沿 x 排开。20 尺箱在中线多一排顶点并且抬高 6 毫米（顶板略微起拱，好排水）。
  //      两边压进上侧梁的倒角里 6 毫米，理由同上
  const roofY = H - 0.008, roofZ = HALF_W - 0.06;
  for (const sheet of sheets(ribKnots(-p + 0.062, p - 0.13, ROOF_RIB, -p + 0.1), 20)) { // 20 格 = 5 个波纹周期，一米一张
    k.add(body, ribbedSheet(sheet, L > 7 ? [-roofZ, roofZ] : [-roofZ, 0, roofZ], (x, rib, z) => [x, roofY - rib + (Math.abs(z) < 0.01 ? 0.006 : 0), z], [0, 1, 0]), {
      tint: (x, y, z) => plan.roofPaint(x, z, sstep(0.004, 0.018, roofY + (Math.abs(z) < 0.01 ? 0.006 : 0) - y)),
    });
  }
  // ---- 箱底：一块朝下的暗板。箱子摞起来、或者被吊在半空的时候，从下面往上看不能看穿
  k.plane(body, L - 0.06, CONTAINER_WIDTH - 0.06, [0, 0.02, 0], { rot: [Math.PI / 2, 0, 0], tint: 0.3 });

  // ---- 箱门：两扇，各自绕自己的铰链轴转
  const doorTop = H - 0.124, leafH = doorTop - DOOR_Y0, mid = (DOOR_Y0 + doorTop) / 2, hingeX = p - 0.066;
  for (const side of [1, -1]) {
    // 下面都在"门的坐标系"里搭：原点在铰链轴上，x 朝门外，门板从铰链往中缝方向伸出去。along(d) 是离铰链 d 米处的 z
    k.push([hingeX, 0, side * HINGE_Z], [0, -side * doorAngle(v.doors, side), 0]);
    const along = (d: number) => -side * d;
    k.box(body, 0.034, leafH, LEAF_W + 0.003, 0, mid, along(LEAF_W / 2 - 0.0045), { c: 0.008, ...paint }); // 门板。铰链那一侧多伸 6 毫米压进门角柱，不留缝
    // 门面的横向压型：6 道（高箱 7 道）凸起，每道从 19 毫米凸到 31 毫米，上下各留一段平边和一段斜边。
    // 左右两头收回到平的（最外面两排顶点不凸），像真的冲压件那样，凸起是封口的
    const ribs = hc ? 7 : 6, y0 = DOOR_Y0 + 0.085, y1 = doorTop - 0.085, pitch = (y1 - y0) / ribs, LOW = 0.019, HIGH = 0.031;
    const profile: [number, number][] = [];
    for (let i = 0; i < ribs; i++) { const y = y0 + i * pitch; profile.push([y, LOW], [y + 0.022, LOW], [y + 0.05, HIGH], [y + pitch - 0.05, HIGH], [y + pitch - 0.022, LOW]); }
    profile.push([y1, LOW]);
    k.add(body, ribbedSheet(profile, [0.06, 0.085, LEAF_W - 0.095, LEAF_W - 0.07], (y, bulge, d, row) => [row === 0 || row === 3 ? LOW : bulge, y, along(d)], [1, 0, 0]), paint);
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
    for (const d of [0.31, 0.83]) {
      k.cyl('steel_galv', 0.0155, leafH + 0.2, 0.052, mid, along(d), { seg: 7, open: true, ...zinc() });
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
  for (const side of [1, -1]) for (const d of [0.31, 0.83]) for (const y of [H - 0.07, 0.115]) {
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
  boxes: LocalBox[];
  triangles: number;
}
const plans = new Map<string, Plan>(), details = new Map<string, ContainerDetail>();
const coreKey = (v: ContainerVariant) => `${v.size}|${v.seed}|${v.wear}|${v.doors}`;
function planOf(v: ContainerVariant) {
  const key = coreKey(v);
  let plan = plans.get(key);
  if (!plan) plans.set(key, (plan = makePlan(v)));
  return plan;
}
const triangles = (g: THREE.BufferGeometry | null) => (g ? (g.index ? g.index.count : g.getAttribute('position').count) / 3 : 0);

/** 一个变体的精模。同样的参数只搭一次。 */
export function containerDetail(o: ContainerOpts): ContainerDetail {
  const v = containerVariant(o), key = coreKey(v);
  let d = details.get(key);
  if (!d) {
    const core = buildCore(planOf(v));
    d = { ...core, triangles: triangles(core.body) + triangles(core.metal) + triangles(core.inside) + triangles(core.wood) };
    details.set(key, d);
  }
  return d;
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
  for (const [geometry, material] of [[d.metal, mats.metal], [d.wood, mats.wood]] as const) {
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** 单独搭一只箱子（模型查看器用；游戏里成批的箱子走 ContainerField）。 */
export function buildContainer(o: ContainerOpts & { color?: number } = {}): PropModel {
  const v = containerVariant(o), spec = CONTAINER_SIZES[v.size];
  const group = containerMeshes(containerDetail(v), o.color ?? CONTAINER_COLORS.blue);
  group.name = `container${v.size}`;
  return { group, boxes: containerBoxes(v.size, v.doors), size: [spec.length, spec.height, CONTAINER_WIDTH], name: group.name };
}

// ======================================================================================================================
// 旧版，接入后删除。
//
// 下面是上一版集装箱的实现（40 尺一种规格、每家船公司一张大贴图）。port.ts 还在用 containerGeometry / sideTextures /
// doorTextures / frameTextures / tintByAlpha / RIBS / Brand，props.ts 还在用 layers / compose / rustRun / rustPatch /
// hazardTape / tintByAlpha，所以原样留着，保证能编译。等 port.ts 换成 ContainerField、props.ts 不再画这些贴图以后，
// 从这一行往下可以整段删掉。
// ======================================================================================================================

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const RIBS = 44;        // 侧板波纹数
const POST = 0.15;             // 角柱边长
const DEPTH = 0.036;           // 波纹深度

/** 一个波纹周期里的截面：t 是 0..1，返回凹进去的比例 0..1。左右对称，这样箱子两侧能共用一张贴图。 */
export function ribProfile(t: number) {
  t = t - Math.floor(t);
  if (t < 0.15 || t > 0.85) return 0;
  if (t < 0.3) return (t - 0.15) / 0.15;
  if (t > 0.7) return (0.85 - t) / 0.15;
  return 1;
}
const KNOTS = [0, 0.15, 0.3, 0.7, 0.85, 1];

// ------------------------------------------------------------------ 几何
/** 材质分组：0 侧板，1 框架和前端板，2 箱顶，3 箱门。 */
export function containerGeometry(W: number, H: number, L: number) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[][] = [[], [], [], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  type P = [number, number, number];
  /** 一个四边形。hint 是大致的朝外方向，绕序反了会自动翻过来。 */
  const quad = (p: P[], t: [number, number][], g: number, hint: P) => {
    a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]); b.set(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
    n.crossVectors(a, b).normalize();
    const flip = n.x * hint[0] + n.y * hint[1] + n.z * hint[2] < 0;
    if (flip) n.negate();
    const base = pos.length / 3;
    for (let i = 0; i < 4; i++) { pos.push(...p[i]); nor.push(n.x, n.y, n.z); uv.push(...t[i]); }
    idx[g].push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
  };
  /** 框架用的方钢。贴图按米平铺。 */
  const bar = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, g = 1) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2, k = 0.5;
    const face = (p: P[], hint: P, u: number, v: number) => quad(p, [[0, 0], [u * k, 0], [u * k, v * k], [0, v * k]], g, hint);
    face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], sz, sy);
    face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], sz, sy);
    face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], sx, sz);
    face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], sx, sz);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], sx, sy);
    face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], sx, sy);
  };

  const hw = W / 2, hh = H / 2, hl = L / 2;
  const yb = -hh + 0.16, yt = hh - 0.11;

  // 两块侧板
  for (const s of [-1, 1]) {
    const z0 = -hl + POST, len = L - POST * 2, per = len / RIBS;
    const u = (z: number) => (s > 0 ? (hl - z) / L : (z + hl) / L), v = (y: number) => (y + hh) / H;
    for (let r = 0; r < RIBS; r++) for (let k = 0; k < 5; k++) {
      const za = z0 + (r + KNOTS[k]) * per, zb = z0 + (r + KNOTS[k + 1]) * per;
      const da = k === 2 || k === 3 ? DEPTH : 0, db = k === 1 || k === 2 ? DEPTH : 0;
      const x0 = s * (hw - 0.012 - da), x1 = s * (hw - 0.012 - db);
      quad([[x0, yb, za], [x1, yb, zb], [x1, yt, zb], [x0, yt, za]], [[u(za), v(yb)], [u(zb), v(yb)], [u(zb), v(yt)], [u(za), v(yt)]], 0, [s, 0, 0]);
    }
    // 上下纵梁
    bar(s * (hw - 0.03), -hh + 0.08, 0, 0.06, 0.16, L - POST * 2);
    bar(s * (hw - 0.035), hh - 0.055, 0, 0.07, 0.11, L - POST * 2);
  }
  // 四根角柱、八个角件（角件比箱体略微凸出一点，轮廓上能看到）
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    bar(sx * (hw - POST / 2), 0, sz * (hl - POST / 2), POST, H - 0.24, POST);
    for (const sy of [-1, 1]) bar(sx * (hw - 0.084), sy * (hh - 0.059), sz * (hl - 0.079), 0.18, 0.118, 0.17);
  }
  // 前端板：竖向波纹
  {
    const x0 = -hw + POST, len = W - POST * 2, N = 8, per = len / N, z = -hl + 0.014;
    for (let r = 0; r < N; r++) for (let k = 0; k < 5; k++) {
      const xa = x0 + (r + KNOTS[k]) * per, xb = x0 + (r + KNOTS[k + 1]) * per;
      const da = k === 2 || k === 3 ? DEPTH : 0, db = k === 1 || k === 2 ? DEPTH : 0;
      quad([[xa, yb, z + da], [xb, yb, z + db], [xb, yt, z + db], [xa, yt, z + da]], [[xa * 0.5, yb * 0.5], [xb * 0.5, yb * 0.5], [xb * 0.5, yt * 0.5], [xa * 0.5, yt * 0.5]], 1, [0, 0, -1]);
    }
    bar(0, -hh + 0.08, -hl + 0.06, W - POST * 2, 0.16, 0.12);
    bar(0, hh - 0.055, -hl + 0.05, W - POST * 2, 0.11, 0.1);
  }
  // 箱门：两扇门，每扇是横向的浅波纹；门槛、门楣、中缝的压条、铰链
  {
    const z = hl - 0.03, d = 0.016, N = 5, y0 = -hh + 0.15, y1 = hh - 0.12, per = (y1 - y0) / N;
    const u = (x: number) => (x + hw) / W, v = (y: number) => (y + hh) / H;
    for (const s of [-1, 1]) {
      const xa = s * 0.012, xb = s * (hw - POST + 0.01);
      for (let r = 0; r < N; r++) for (let k = 0; k < 5; k++) {
        const ya = y0 + (r + KNOTS[k]) * per, yc = y0 + (r + KNOTS[k + 1]) * per;
        const da = k === 2 || k === 3 ? d : 0, db = k === 1 || k === 2 ? d : 0;
        quad([[xa, ya, z - da], [xb, ya, z - da], [xb, yc, z - db], [xa, yc, z - db]], [[u(xa), v(ya)], [u(xb), v(ya)], [u(xb), v(yc)], [u(xa), v(yc)]], 3, [0, 0, 1]);
      }
      for (const hy of [-0.92, -0.32, 0.32, 0.92]) bar(s * (hw - POST + 0.02), hy, hl - 0.02, 0.1, 0.07, 0.03); // 铰链
    }
    bar(0.014, 0, hl - 0.022, 0.05, y1 - y0, 0.02);          // 中缝压条
    bar(0, -hh + 0.075, hl - 0.06, W - POST * 2, 0.15, 0.12); // 门槛
    bar(0, hh - 0.06, hl - 0.06, W - POST * 2, 0.12, 0.12);   // 门楣
  }
  // 箱顶和箱底
  quad([[-hw + 0.02, hh - 0.012, hl - 0.02], [hw - 0.02, hh - 0.012, hl - 0.02], [hw - 0.02, hh - 0.012, -hl + 0.02], [-hw + 0.02, hh - 0.012, -hl + 0.02]], [[0, 0], [0, 1], [1, 1], [1, 0]], 2, [0, 1, 0]);
  quad([[-hw + 0.02, -hh + 0.03, hl - 0.02], [hw - 0.02, -hh + 0.03, hl - 0.02], [hw - 0.02, -hh + 0.03, -hl + 0.02], [-hw + 0.02, -hh + 0.03, -hl + 0.02]], [[0, 0], [1, 0], [1, 6], [0, 6]], 1, [0, -1, 0]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const all: number[] = [];
  idx.forEach((list, i) => { g.addGroup(all.length, list.length, i); all.push(...list); });
  g.setIndex(all);
  return g;
}

// ------------------------------------------------------------------ 贴图
export function canvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: true })! };
}
export function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export interface Layers { W: number; H: number; paint: CanvasRenderingContext2D; over: CanvasRenderingContext2D }
export function layers(W: number, H: number, base: number): Layers {
  const p = canvas(W, H), o = canvas(W, H);
  p.g.fillStyle = `rgb(${base},${base},${base})`; p.g.fillRect(0, 0, W, H);
  return { W, H, paint: p.g, over: o.g };
}

/**
 * 把两层合成一张颜色贴图和一张粗糙度贴图。
 * dirt 控制整体脏的程度；shade(x, y) 返回 0..1 的额外压暗（用来画波纹凹槽里的阴影）。
 */
export function compose(l: Layers, seed: number, dirt: number, shade: (x: number, y: number) => number, repeat = false) {
  const { W, H } = l;
  const P = l.paint.getImageData(0, 0, W, H).data, O = l.over.getImageData(0, 0, W, H).data;
  const map = new Uint8Array(W * H * 4), rough = new Uint8Array(W * H * 4);
  const rng = mulberry32(seed * 131 + 7);
  for (let y = 0; y < H; y++) {
    const fy = y / H, row = (H - 1 - y) * W; // 画布的第一行是顶，贴图的第一行是底
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, o = (row + x) * 4;
      const a = O[i + 3] / 255;
      const big = fbm(x / 170 + seed, y / 120 + seed * 1.7, 3);           // 大片的深浅不匀
      const run = vnoise(x / 5 + seed * 3, y / 260);                       // 竖向的雨痕
      const grit = rng();
      const sh = shade(x, y);
      // 越靠下越脏；凹槽里也更脏
      const k = (1 - dirt * (0.55 * big + 0.3 * run * (0.3 + fy) + 0.25 * fy * fy * fy)) * (1 - sh * 0.3) * (0.96 + grit * 0.08);
      map[o] = (P[i] * (1 - a) + O[i] * a) * k;
      map[o + 1] = (P[i + 1] * (1 - a) + O[i + 1] * a) * k;
      map[o + 2] = (P[i + 2] * (1 - a) + O[i + 2] * a) * k;
      map[o + 3] = (1 - a) * 255;
      // 粗糙度：漆面被雨打湿所以偏光滑，雨痕处更滑；锈是哑光的
      const rusty = a > 0.15 && O[i] > O[i + 2] * 1.7 && O[i] < 130 ? a : 0;
      let r = 0.4 + (big - 0.5) * 0.35 - (run > 0.62 ? 0.16 : 0) + sh * 0.1 + grit * 0.06;
      r = r * (1 - rusty) + 0.92 * rusty;
      rough[o] = rough[o + 1] = Math.max(20, Math.min(255, r * 255)); rough[o + 2] = 255; rough[o + 3] = 255; // R 通道顺便当凹凸贴图用
    }
  }
  return { map: dataTexture(map, W, H, true, repeat), rough: dataTexture(rough, W, H, false, repeat) };
}

const RUST = ['58,31,15', '74,41,19', '43,25,13'];
/** 从 (x, y) 往下淌的一道锈水。 */
export function rustRun(g: CanvasRenderingContext2D, rng: () => number, x: number, y: number, len: number, w: number, alpha: number) {
  const gr = g.createLinearGradient(0, y, 0, y + len), col = RUST[Math.floor(rng() * RUST.length)];
  gr.addColorStop(0, `rgba(${col},${alpha})`); gr.addColorStop(0.35, `rgba(${col},${alpha * 0.55})`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(x - w / 2, y); g.lineTo(x + w / 2, y); g.lineTo(x + w * 0.18 + (rng() - 0.5) * 3, y + len); g.lineTo(x - w * 0.18, y + len); g.fill();
}
/** 一块锈斑：一堆大小不一的小圆点聚在一起，边缘是碎的。 */
export function rustPatch(g: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, r: number) {
  for (let i = 0; i < 34; i++) {
    const a = rng() * 6.283, d = Math.pow(rng(), 0.6) * r, k = (1 - d / r) * r * 0.3 + 0.6;
    g.fillStyle = `rgba(${RUST[Math.floor(rng() * RUST.length)]},${0.3 + rng() * 0.45})`;
    g.beginPath(); g.ellipse(cx + Math.cos(a) * d * 1.4, cy + Math.sin(a) * d, k * 1.2, k, 0, 0, 6.283); g.fill();
  }
}
/** 黄黑斜纹警示贴。 */
export function hazardTape(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#d9a916'; g.fillRect(x, y, w, h);
  g.fillStyle = '#141414';
  for (let k = -h; k < w + h; k += h * 0.9) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h * 0.45, y + h); g.lineTo(x + k + h * 1.45, y); g.lineTo(x + k + h, y); g.fill(); }
  g.restore();
}

export interface Brand { name: string; sub: string; mark: number }

/** 侧板贴图。1 像素约 6 毫米，贴近了看喷字也是清楚的。 */
export function sideTextures(brand: Brand | null, seed: number, L: number) {
  const TW = 2048, TH = 512;
  const l = layers(TW, TH, 196), p = l.paint, o = l.over;
  const rng = mulberry32(seed * 977 + 5);
  // 补过漆的地方：颜色和周围略有出入的方块
  for (let i = 0; i < 7; i++) {
    const v = 196 + (rng() - 0.5) * 44;
    p.fillStyle = `rgba(${v},${v},${v},0.8)`;
    p.fillRect(rng() * TW, 40 + rng() * 380, 60 + rng() * 260, 50 + rng() * 200);
  }
  // 喷字
  const white = 'rgba(232,230,222,0.9)';
  o.textBaseline = 'middle';
  if (brand) {
    const x0 = 250 + (seed % 3) * 60, cy = 250;
    o.fillStyle = white; o.strokeStyle = white;
    // 公司标：一个环加几道斜杠，每家不一样
    o.lineWidth = 15; o.beginPath(); o.arc(x0, cy, 82, 0, 6.283); o.stroke();
    o.save(); o.beginPath(); o.arc(x0, cy, 70, 0, 6.283); o.clip();
    for (let k = 0; k < 2 + brand.mark; k++) { o.save(); o.translate(x0 - 60 + k * (110 / (1 + brand.mark)), cy); o.rotate(brand.mark % 2 ? -0.5 : 0.5); o.fillRect(-10, -100, 20, 200); o.restore(); }
    o.restore();
    o.font = `900 172px ${FONT}`; o.fillText(brand.name, x0 + 130, cy - 26);
    o.font = `600 40px ${FONT}`; o.fillText(brand.sub, x0 + 136, cy + 92);
  } else {
    o.fillStyle = white; o.font = `800 54px ${FONT}`; o.fillText('租箱 · 激战箱管', 150, 110);
  }
  // 右上角：箱号、箱型代码、重量数据
  o.fillStyle = white;
  o.font = `800 46px ${MONO}`; o.fillText(`JZNU ${317204 + seed * 1373}`, 1560, 62);
  o.lineWidth = 4; o.strokeStyle = white; o.strokeRect(1936, 38, 38, 48); o.font = `800 40px ${MONO}`; o.fillText(String(seed % 10), 1943, 64);
  o.font = `800 40px ${MONO}`; o.fillText('45G1', 1836, 116);
  o.font = `600 19px ${FONT}`;
  ['最大总重  30 480 千克', '箱体自重    3 750 千克', '最大载重  26 730 千克', '容　　积    67.7 立方米'].forEach((s, i) => o.fillText(s, 1562, 160 + i * 25));
  // 超高箱警示贴：两头的上角各一张
  for (const x of [34, TW - 34 - 112]) { hazardTape(o, x, 30, 112, 46); o.fillStyle = '#141414'; o.font = `900 19px ${FONT}`; o.textAlign = 'center'; o.fillStyle = '#d9a916'; o.fillRect(x + 12, 41, 88, 24); o.fillStyle = '#141414'; o.fillText('超高 2.9米', x + 56, 54); o.textAlign = 'left'; }
  if (seed % 3 === 0) { // 危险品菱形标
    o.save(); o.translate(1420, 330); o.rotate(Math.PI / 4); o.fillStyle = '#b8341d'; o.fillRect(-42, -42, 84, 84); o.strokeStyle = '#efe9dc'; o.lineWidth = 3; o.strokeRect(-36, -36, 72, 72); o.rotate(-Math.PI / 4);
    o.fillStyle = '#efe9dc'; o.textAlign = 'center'; o.font = `900 24px ${FONT}`; o.fillText('易燃', 0, -4); o.font = `900 18px ${FONT}`; o.fillText('3', 0, 34); o.restore();
  }
  // 磕碰刮擦：吊装和堆码时蹭掉漆的横向划痕，露出浅色底漆，边上很快就锈了
  for (let i = 0; i < 16; i++) {
    const x = rng() * TW, y = 60 + rng() * 400, len = 30 + rng() * 150;
    o.strokeStyle = `rgba(150,140,128,${0.25 + rng() * 0.35})`; o.lineWidth = 1 + rng() * 2.5;
    o.beginPath(); o.moveTo(x, y); o.lineTo(x + len, y + (rng() - 0.5) * 10); o.stroke();
    if (rng() < 0.6) { rustPatch(o, rng, x + len * rng(), y, 4 + rng() * 9); rustRun(o, rng, x + len * rng(), y, 30 + rng() * 120, 3 + rng() * 5, 0.5); }
  }
  // 锈水：从上纵梁往下淌；底边一圈因为积水锈得最重
  for (let i = 0; i < 44; i++) rustRun(o, rng, rng() * TW, 14 + rng() * 6, 40 + rng() * 240, 3 + rng() * 11, 0.3 + rng() * 0.45);
  for (let i = 0; i < 60; i++) rustPatch(o, rng, rng() * TW, TH - 28 + rng() * 14, 4 + rng() * 10);
  for (let i = 0; i < 9; i++) rustPatch(o, rng, rng() * TW, 40 + rng() * 420, 3 + rng() * 7);
  // 波纹凹槽里的阴影，和几何的波纹一一对应
  const z0 = POST / L, span = 1 - z0 * 2;
  const groove = new Float32Array(TW);
  for (let x = 0; x < TW; x++) { const t = (x / TW - z0) / span; groove[x] = t < 0 || t > 1 ? 0 : ribProfile(t * RIBS); }
  return compose(l, seed, 0.5, (x) => groove[x]);
}

/** 箱门贴图。 */
export function doorTextures(seed: number) {
  const S = 512;
  const l = layers(S, S, 190), o = l.over;
  const rng = mulberry32(seed * 311 + 3);
  const white = 'rgba(232,230,222,0.9)';
  o.fillStyle = white; o.textBaseline = 'middle';
  o.font = `800 30px ${MONO}`; o.fillText(`JZNU ${317204 + seed * 1373}`, 276, 76);
  o.font = `800 26px ${MONO}`; o.fillText(`45G1   ${seed % 10}`, 276, 110);
  for (let i = 0; i < 22; i++) rustRun(o, rng, rng() * S, 28 + rng() * 10, 40 + rng() * 200, 3 + rng() * 9, 0.3 + rng() * 0.4);
  for (let i = 0; i < 18; i++) rustPatch(o, rng, rng() * S, S - 40 + rng() * 14, 4 + rng() * 10);
  for (const x of [38, S - 38]) for (const y of [70, 190, 320, 440]) { rustPatch(o, rng, x, y, 6 + rng() * 6); rustRun(o, rng, x, y, 40 + rng() * 60, 6, 0.5); } // 铰链处
  for (let i = 0; i < 8; i++) rustPatch(o, rng, rng() * S, 60 + rng() * 380, 3 + rng() * 8);
  return compose(l, seed + 40, 0.5, () => 0);
}

/** 框架、角柱、端板用的漆面：可以平铺。框架是箱子上磕碰最多的地方，所以锈和掉漆也最多。 */
export function frameTextures() {
  const S = 256;
  const l = layers(S, S, 150), o = l.over;
  const rng = mulberry32(51);
  for (let i = 0; i < 26; i++) rustPatch(o, rng, rng() * S, rng() * S, 2 + rng() * 7);
  for (let i = 0; i < 30; i++) { o.fillStyle = `rgba(150,140,128,${0.2 + rng() * 0.4})`; o.fillRect(rng() * S, rng() * S, 2 + rng() * 14, 1 + rng() * 2); }
  return compose(l, 9, 0.35, () => 0, true);
}

/** 让材质按贴图的 alpha 通道决定"染不染箱体颜色"。 */
export function tintByAlpha<T extends THREE.Material>(mat: T) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', /* glsl */ `
      #ifdef USE_COLOR
        diffuseColor.rgb *= mix(vec3(1.0), vColor, diffuseColor.a);
      #endif
      diffuseColor.a = 1.0;`);
  };
  mat.customProgramCacheKey = () => 'tint-by-alpha';
  return mat;
}
