import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, type Rng } from '../core/math';
import { decal, label, labelMaterial, type LabelOpts, type Patch } from '../render/labels';
import { surface, type SurfaceName } from '../render/surfaces';
import type { Surface } from './colliders';

// 静态模型的"零件箱"。
//
// 叉车、货架、发电机这类不会动的东西，都是由几十上百个基本体（倒角盒、圆柱、方杆、车削件、挤出件）拼成的。
// 如果每个零件都是一个独立的网格，一辆叉车就要上百次绘制调用。所以这里的做法是：
//   1. 搭的时候只是往"零件箱"里放几何体，并记下它用哪种材质、多深的颜色；
//   2. 搭完以后（finish），同一种材质的零件合并成一个网格 —— 一辆叉车最后只有五六个网格。
//
// 让模型"不像刚出厂"的三件事也在这里统一做掉：
//   · 倒角：盒子的每条棱都切掉几毫米。棱上有了一条窄窄的斜面，就能接住一道高光，东西才有"实心铁块"的分量。
//   · 明暗：每个零件带一个深浅系数，写进顶点色。同一种黑钢，这根杆 0.7、那根 0.9，就不再是一整块死黑。
//   · 烤脏：合并的时候按位置给所有顶点再压一层暗 —— 朝下的面暗一点，贴着地的一圈最暗并且偏褐（泥水溅上来的）。
//
// 贴图坐标按"面朝哪个方向，就从哪个方向把贴图投上去"来铺，单位是米。于是不管零件多大多小，
// 贴图上的划痕和锈点都是同样的真实大小。

export type V3 = [number, number, number];
export type Rgb = [number, number, number];
/** 零件的明暗 / 染色：一个倍数、一组 [r, g, b] 倍数，或者按顶点位置（模型自己的坐标）返回倍数的函数。乘在材质的颜色上。 */
export type Tint = number | Rgb | ((x: number, y: number, z: number) => number | Rgb);
/** 材质：材质库里的名字，或者一个现成的材质（发光体、玻璃之类）。 */
export type Mat = SurfaceName | THREE.Material;
type Axis = 'x' | 'y' | 'z';

/** 模型自带的碰撞盒，用模型自己的坐标表示。摆到场景里的时候再换算成世界坐标。 */
export interface LocalBox { min: V3; max: V3; surface?: Surface; bulletOnly?: boolean; playerOnly?: boolean; noNav?: boolean }
/** 搭好的一件东西：网格、碰撞盒、占地尺寸 [x, y, z]。底面在 y=0，原点在占地中心。 */
export interface PropModel { group: THREE.Group; boxes: LocalBox[]; size: V3; name: string }

interface PartOpt {
  tint?: Tint;
  /** 不烤脏、不写明暗、保留几何体自带的贴图坐标：发光体、文字贴片用。 */
  raw?: boolean;
  /** 投不投影子。细小的零件（螺栓、标签）不投，省一点。 */
  cast?: boolean;
  /** 贴图的纹理顺着哪个轴走（木纹、拉丝）。 */
  grain?: Axis;
}
interface XfOpt extends PartOpt { rot?: V3 }
interface BoxOpt extends XfOpt {
  /** 倒角宽度，默认 8 毫米。 */
  c?: number;
  /** true 表示不倒角的直角盒（12 个三角形），给看不清棱的小零件用。 */
  plain?: boolean;
}
interface RBoxOpt extends XfOpt { r?: number; seg?: number; deform?: (v: THREE.Vector3) => void }
interface CylOpt extends XfOpt { axis?: Axis; r2?: number; seg?: number; open?: boolean }
interface TubeOpt extends PartOpt { r2?: number; seg?: number; cap?: boolean }
interface SphOpt extends XfOpt { scale?: V3; seg?: number }
interface LatheOpt extends XfOpt { axis?: Axis; seg?: number }
interface ExtrudeOpt extends XfOpt { pos?: V3; soft?: number }

const _c = new THREE.Color(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);

/** 把 0xRRGGBB 颜色换成线性空间的 [r, g, b]，可以直接当 Tint 用（比如在白色材质上染出指定的颜色）。 */
export const hex = (c: number): Rgb => { _c.setHex(c); return [_c.r, _c.g, _c.b]; };

// ---- 三维值噪声：整数格点上的随机数，中间平滑插值。烤脏用它
function h3(x: number, y: number, z: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let u = x - xi, v = y - yi, w = z - zi;
  u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), l(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
           l(l(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), l(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v), w);
}

/** 把一个沿 y 轴的几何体转到指定的轴向。 */
function turn(g: THREE.BufferGeometry, axis: Axis) {
  if (axis === 'x') g.rotateZ(-Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}
const euler = (r: V3) => _q.setFromEuler(new THREE.Euler(r[0], r[1], r[2]));

/**
 * 倒角盒：每个角有 3 个顶点（各属于一个面，带那个面的法线），于是
 * 6 个面 + 12 条棱上的窄斜面 + 8 个角上的小三角 = 44 个三角形。
 * 斜面两侧的法线不同，光照会在斜面上从一个面渐变到另一个面，看起来像圆角，却只多了 32 个三角形。
 */
export function chamferBox(w: number, h: number, d: number, c = 0.008) {
  const half = [w / 2, h / 2, d / 2];
  c = Math.max(0, Math.min(c, half[0] * 0.9, half[1] * 0.9, half[2] * 0.9));
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let k = 0; k < 8; k++) for (let f = 0; f < 3; f++) {
    const s = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
    for (let a = 0; a < 3; a++) pos.push(s[a] * (half[a] - (a !== f ? c : 0)));
    nor.push(f === 0 ? s[0] : 0, f === 1 ? s[1] : 0, f === 2 ? s[2] : 0);
  }
  const vid = (corner: number, face: number) => corner * 3 + face;
  // 加一个三角形，并保证它朝外（法线和 out 同向），不用操心顶点顺序
  const tri = (a: number, b: number, cc: number, ox: number, oy: number, oz: number) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[cc * 3] - pos[a * 3], vy = pos[cc * 3 + 1] - pos[a * 3 + 1], vz = pos[cc * 3 + 2] - pos[a * 3 + 2];
    if ((uy * vz - uz * vy) * ox + (uz * vx - ux * vz) * oy + (ux * vy - uy * vx) * oz >= 0) idx.push(a, b, cc); else idx.push(a, cc, b);
  };
  for (let p = 0; p < 3; p++) {
    const q = (p + 1) % 3, r = (p + 2) % 3;
    for (const side of [0, 1]) { // 垂直于 p 轴的两个大面
      const k = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => (side << p) | (a << q) | (b << r));
      const o = [0, 0, 0]; o[p] = side ? 1 : -1;
      tri(vid(k[0], p), vid(k[1], p), vid(k[2], p), o[0], o[1], o[2]);
      tri(vid(k[0], p), vid(k[2], p), vid(k[3], p), o[0], o[1], o[2]);
    }
    for (const a of [0, 1]) for (const b of [0, 1]) { // 平行于 p 轴的四条棱
      const k0 = (a << q) | (b << r), k1 = k0 | (1 << p);
      const o = [0, 0, 0]; o[q] = a ? 1 : -1; o[r] = b ? 1 : -1;
      tri(vid(k0, q), vid(k1, q), vid(k1, r), o[0], o[1], o[2]);
      tri(vid(k0, q), vid(k1, r), vid(k0, r), o[0], o[1], o[2]);
    }
  }
  for (let k = 0; k < 8; k++) tri(vid(k, 0), vid(k, 1), vid(k, 2), k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

interface Bucket { mat: Mat; cast: boolean; raw: boolean; geos: THREE.BufferGeometry[] }
let matIds = 0;
const matId = new WeakMap<THREE.Material, number>();

export class Kit {
  private buckets = new Map<string, Bucket>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** 这件东西自己的随机数：同一个名字、同一个种子，每次搭出来都一样。 */
  readonly rng: Rng;

  /** name 是这件东西的名字；seed 换一个数就得到另一个"个体"（凹坑、深浅不同）；interior 表示它放在室内（淋不到雨）。 */
  constructor(readonly name = 'prop', readonly seed = 0, private opt: { interior?: boolean } = {}) {
    this.rng = mulberry32((seed + 1) * 7919 + name.length * 131);
  }
  /** lo 到 hi 之间的随机数。 */
  range(lo: number, hi: number) { return lo + (hi - lo) * this.rng(); }

  // ------------------------------------------------------------------ 坐标系
  /**
   * 在一个局部坐标系里搭一组零件：fn 里放进来的东西都会先按 rot 转、再挪到 pos。
   * 比如车轮在自己的坐标系里搭一次（轮心在原点），再用 at() 放到四个轮位上。可以嵌套。
   */
  at(pos: V3, rot: V3 | null, fn: () => void, scale = 1) {
    this.push(pos, rot, scale);
    fn();
    this.pop();
  }
  push(pos: V3, rot: V3 | null = null, scale = 1) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), rot ? euler(rot) : _q.identity(), new THREE.Vector3(scale, scale, scale));
    this.stack.push(this.stack[this.stack.length - 1].clone().multiply(m));
  }
  pop() { if (this.stack.length > 1) this.stack.pop(); }

  // ------------------------------------------------------------------ 所有零件最后都走这里
  /**
   * 放进一个几何体。g 用"零件自己的坐标"给出；xf 是它在当前坐标系里的摆放（可以不给）。
   * 贴图坐标在摆放之前铺，所以一根斜着放的木条，木纹还是顺着木条走的。
   */
  add(mat: Mat, g0: THREE.BufferGeometry, o: PartOpt = {}, xf?: THREE.Matrix4) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const raw = !!o.raw;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && !(raw && k === 'uv')) g.deleteAttribute(k);
    g.clearGroups();
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), n = pos.count;
    if (!raw || !g.getAttribute('uv')) {
      const uv = new Float32Array(n * 2), grain = o.grain;
      for (let i = 0; i < n; i += 3) {
        // 一个三角形的三个顶点用同一个投影方向（取三个法线的平均），不然三角形会被撕开
        _n.set(nor.getX(i) + nor.getX(i + 1) + nor.getX(i + 2), nor.getY(i) + nor.getY(i + 1) + nor.getY(i + 2), nor.getZ(i) + nor.getZ(i + 1) + nor.getZ(i + 2));
        const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
        const face: Axis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
        for (let j = i; j < i + 3; j++) {
          const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
          let u: number, v: number;
          if (face === 'x') { u = z; v = y; } else if (face === 'y') { u = x; v = z; } else { u = x; v = y; }
          // 纹理要顺着 grain 轴走：如果现在是 v 方向顺着它，就把 u、v 对调
          if (grain && grain !== face && ((face === 'x' && grain === 'y') || (face === 'y' && grain === 'z') || (face === 'z' && grain === 'y'))) { const t = u; u = v; v = t; }
          uv[j * 2] = u; uv[j * 2 + 1] = v;
        }
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (xf) g.applyMatrix4(xf);
    g.applyMatrix4(this.stack[this.stack.length - 1]);
    const col = new Float32Array(n * 3).fill(1), tint = raw ? 1 : o.tint ?? 1;
    if (tint !== 1) for (let j = 0; j < n; j++) {
      const t = typeof tint === 'function' ? tint(pos.getX(j), pos.getY(j), pos.getZ(j)) : tint;
      if (typeof t === 'number') { col[j * 3] = col[j * 3 + 1] = col[j * 3 + 2] = t; } else { col[j * 3] = t[0]; col[j * 3 + 1] = t[1]; col[j * 3 + 2] = t[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const cast = o.cast ?? !raw;
    let id: string;
    if (typeof mat === 'string') id = mat;
    else { if (!matId.has(mat)) matId.set(mat, ++matIds); id = '#' + matId.get(mat); }
    const key = `${id}|${cast ? 1 : 0}|${raw ? 1 : 0}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { mat, cast, raw, geos: [] }));
    b.geos.push(g);
  }
  private place(x: number, y: number, z: number, rot?: V3) {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rot ? euler(rot) : _q.identity(), ONE);
  }

  // ------------------------------------------------------------------ 基本体
  /** 盒子，中心在 (x, y, z)。默认带 8 毫米倒角。 */
  box(mat: Mat, sx: number, sy: number, sz: number, x: number, y: number, z: number, o: BoxOpt = {}) {
    this.add(mat, o.plain ? new THREE.BoxGeometry(sx, sy, sz) : chamferBox(sx, sy, sz, o.c ?? 0.008), o, this.place(x, y, z, o.rot));
  }
  /**
   * 圆角盒：棱和角是真的圆弧（比倒角盒费三角形，留给座椅、油箱这类"软"的东西）。
   * deform 可以逐顶点再捏一下形状（压扁、鼓起、拧歪），捏完会重新算平滑的法线。
   */
  rbox(mat: Mat, sx: number, sy: number, sz: number, x: number, y: number, z: number, o: RBoxOpt = {}) {
    const r = Math.min(o.r ?? Math.min(sx, sy, sz) * 0.2, Math.min(sx, sy, sz) / 2 - 1e-4);
    let g: THREE.BufferGeometry = new RoundedBoxGeometry(sx, sy, sz, o.seg ?? 3, r);
    if (o.deform) {
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i); o.deform(_v); p.setXYZ(i, _v.x, _v.y, _v.z); }
      g.deleteAttribute('normal'); g.deleteAttribute('uv');
      g = mergeVertices(g, 1e-4);
      g.computeVertexNormals();
    }
    this.add(mat, g, o, this.place(x, y, z, o.rot));
  }
  /** 圆柱，中心在 (x, y, z)。r 是底面半径，r2 是顶面半径（不给就和 r 一样）；axis 是轴向；open 表示不封两头。 */
  cyl(mat: Mat, r: number, len: number, x: number, y: number, z: number, o: CylOpt = {}) {
    const g = turn(new THREE.CylinderGeometry(o.r2 ?? r, r, len, o.seg ?? 16, 1, o.open ?? false), o.axis ?? 'y');
    this.add(mat, g, o, this.place(x, y, z, o.rot));
  }
  /** 连接 a、b 两点的圆管。r 是 a 端半径，r2 是 b 端半径。默认不封口。 */
  tube(mat: Mat, a: V3, b: V3, r: number, o: TubeOpt = {}) {
    _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _v.length();
    if (len < 1e-6) return;
    const g = new THREE.CylinderGeometry(o.r2 ?? r, r, len, o.seg ?? 8, 1, !o.cap);
    this.add(mat, g, o, new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q.setFromUnitVectors(UP, _v.normalize()), ONE));
  }
  /**
   * 连接 a、b 两点的方杆（倒角盒）。截面是 w × d。
   * 杆先沿 y 轴立着搭好（w 沿 x、d 沿 z），再用"把 y 轴转到 a→b 方向的最短旋转"转过去：
   *   · 竖着的杆：w 还是沿 x，d 沿 z；
   *   · 沿 x 方向的杆：w 变成上下方向的厚度，d 沿 z；
   *   · 沿 z 方向的杆：w 沿 x，d 变成上下方向的厚度。
   */
  bar(mat: Mat, a: V3, b: V3, w: number, d: number, o: BoxOpt = {}) {
    _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _v.length();
    if (len < 1e-6) return;
    const g = o.plain ? new THREE.BoxGeometry(w, len, d) : chamferBox(w, len, d, o.c ?? 0.006);
    this.add(mat, g, { grain: 'y', ...o }, new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q.setFromUnitVectors(UP, _v.normalize()), ONE));
  }
  /** 沿着一串点走的折线管（扶手、护栏）：一段段直圆管，拐弯处垫一个球把折角盖住。 */
  path(mat: Mat, pts: V3[], r: number, o: TubeOpt = {}) {
    for (let i = 0; i + 1 < pts.length; i++) {
      this.tube(mat, pts[i], pts[i + 1], r, o);
      if (i) this.sph(mat, r, ...pts[i], { tint: o.tint, cast: o.cast, seg: o.seg ?? 8 });
    }
  }
  /** 沿着一串点走的光滑弯管（软管、电缆）：点与点之间自动补成圆滑的曲线。 */
  hose(mat: Mat, pts: V3[], r: number, o: TubeOpt & { steps?: number } = {}) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    this.add(mat, new THREE.TubeGeometry(curve, o.steps ?? pts.length * 6, r, o.seg ?? 6, false), o);
  }
  /** 球，或者用 scale 压扁拉长成椭球。 */
  sph(mat: Mat, r: number, x: number, y: number, z: number, o: SphOpt = {}) {
    const s = o.seg ?? 12, g = new THREE.SphereGeometry(r, s, Math.max(6, Math.round(s * 0.7)));
    if (o.scale) g.scale(...o.scale);
    this.add(mat, g, o, this.place(x, y, z, o.rot));
  }
  /**
   * 车削件：侧面轮廓 [半径, 沿轴的位置] 绕轴转一圈。轮胎、轮毂、灯罩、桶都是它。
   * 轮廓里连着写两个相同的点 = 那里是一道硬棱（两边的面不做平滑过渡）。
   */
  lathe(mat: Mat, prof: [number, number][], x: number, y: number, z: number, o: LatheOpt = {}) {
    const seg = o.seg ?? 16, pos: number[] = [], nor: number[] = [], idx: number[] = [];
    // 先把轮廓按硬棱切成几段，每段内部的法线是平滑的
    const runs: [number, number][][] = [[]];
    for (let i = 0; i < prof.length; i++) {
      const p = prof[i], q = prof[i - 1];
      if (q && q[0] === p[0] && q[1] === p[1]) { runs.push([p]); continue; }
      runs[runs.length - 1].push(p);
    }
    // 轮廓可以从下往上写，也可以从上往下写。用轮廓和轴围成的面积的正负判断是哪一种，保证法线总是朝外
    let area = 0;
    for (let i = 0; i + 1 < prof.length; i++) area += prof[i][0] * prof[i + 1][1] - prof[i + 1][0] * prof[i][1];
    const sign = area < 0 ? -1 : 1;
    for (const run of runs) {
      if (run.length < 2) continue;
      const base = pos.length / 3;
      for (let i = 0; i < run.length; i++) {
        // 这一点的法线 = 前后两段轮廓线法线的平均；轮廓线方向 (dr, dh) 的外法线是 (dh, -dr)
        let nr = 0, nh = 0;
        for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
          if (a < 0 || b >= run.length) continue;
          const dr = run[b][0] - run[a][0], dh = run[b][1] - run[a][1], l = Math.hypot(dr, dh) || 1;
          nr += (dh / l) * sign; nh += (-dr / l) * sign;
        }
        const l = Math.hypot(nr, nh) || 1; nr /= l; nh /= l;
        for (let s = 0; s <= seg; s++) {
          const a = (s / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          pos.push(run[i][0] * sa, run[i][1], run[i][0] * ca);
          nor.push(nr * sa, nh, nr * ca);
        }
      }
      for (let i = 0; i + 1 < run.length; i++) for (let s = 0; s < seg; s++) {
        const a = base + i * (seg + 1) + s, b = a + seg + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    fixWinding(g); // 三角形的正反面要和法线一致
    this.add(mat, turn(g, o.axis ?? 'y'), o, this.place(x, y, z, o.rot));
  }
  /**
   * 挤出件：把一个画在 xy 平面里的多边形沿 z 拉出 depth 厚（前后各一半），再用 rot / pos 摆到位。
   * 车身的侧面轮廓、工字钢、货叉的 L 形，都是"画个侧影再拉厚"。
   * 侧面上相邻两段的夹角小于 soft（弧度，默认 0.6）就做平滑过渡，大于它就是硬棱。
   */
  extrude(mat: Mat, outline: [number, number][], depth: number, o: ExtrudeOpt = {}) {
    let pts = outline.map(([a, b]) => new THREE.Vector2(a, b));
    if (THREE.ShapeUtils.isClockWise(pts)) pts = pts.reverse();
    const n = pts.length, soft = o.soft ?? 0.6, hz = depth / 2;
    const pos: number[] = [], nor: number[] = [];
    for (const [z, s] of [[hz, 1], [-hz, -1]]) for (const f of THREE.ShapeUtils.triangulateShape(pts, [])) { // 前后两个盖子
      const order = s > 0 ? f : [f[0], f[2], f[1]];
      for (const k of order) { pos.push(pts[k].x, pts[k].y, z); nor.push(0, 0, s); }
    }
    // 侧面：每条边的外法线；顶点处如果和邻边夹角小，就取两条边法线的平均
    const en = pts.map((p, i) => { const q = pts[(i + 1) % n]; const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; });
    const vn = (edge: number, atEnd: boolean) => {
      const other = atEnd ? (edge + 1) % n : (edge + n - 1) % n, a = en[edge], b = en[other];
      if (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) > soft) return a;
      const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], n0 = vn(i, false), n1 = vn(i, true);
      const quad: [THREE.Vector2, number, number[]][] = [[p, hz, n0], [p, -hz, n0], [q, -hz, n1], [p, hz, n0], [q, -hz, n1], [q, hz, n1]];
      for (const [v, z, nn] of quad) { pos.push(v.x, v.y, z); nor.push(nn[0], nn[1], 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const p = o.pos ?? [0, 0, 0];
    this.add(mat, g, o, this.place(p[0], p[1], p[2], o.rot));
  }
  /** 圆环（吊环、把手、胎圈）。R 是环的半径，r 是管的粗细；axis 是环的轴向（环面垂直于它）。 */
  torus(mat: Mat, R: number, r: number, x: number, y: number, z: number, o: CylOpt & { tubeSeg?: number } = {}) {
    const g = new THREE.TorusGeometry(R, r, o.tubeSeg ?? 6, o.seg ?? 16);
    // 圆环默认躺在 xy 平面里（轴朝 z）
    if ((o.axis ?? 'y') === 'y') g.rotateX(Math.PI / 2); else if (o.axis === 'x') g.rotateY(Math.PI / 2);
    this.add(mat, g, o, this.place(x, y, z, o.rot));
  }
  /** 一张平面，法线朝 +z，中心在 pos；用 rot 转到别的朝向。 */
  plane(mat: Mat, w: number, h: number, pos: V3, o: XfOpt = {}) {
    this.add(mat, new THREE.PlaneGeometry(w, h), o, this.place(pos[0], pos[1], pos[2], o.rot));
  }
  /** 沿着一串点走的薄带子（捆扎带、铁皮箍）。half 是带子的半宽向量；两面都看得见。 */
  strip(mat: Mat, pts: V3[], half: V3, o: PartOpt = {}) {
    const pos: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const q = [[a, -1], [a, 1], [b, 1], [a, -1], [b, 1], [b, -1]] as const;
      for (const side of [0, 1]) for (let k = 0; k < 6; k++) {
        const [p, s] = q[side ? 5 - k : k];
        pos.push(p[0] + half[0] * s, p[1] + half[1] * s, p[2] + half[2] * s);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.add(mat, g, { cast: false, ...o });
  }

  // ------------------------------------------------------------------ 文字和贴纸
  private patch(p: Patch, w: number, h: number, pos: V3, rot?: V3) {
    const g = new THREE.PlaneGeometry(w, h), uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, p.uv[0] + (p.uv[2] - p.uv[0]) * uv.getX(i), p.uv[1] + (p.uv[3] - p.uv[1]) * uv.getY(i));
    this.add(labelMaterial(), g, { raw: true, cast: false }, this.place(pos[0], pos[1], pos[2], rot));
  }
  /**
   * 一行字，贴成一张面片（法线朝 +z，用 rot 转向）。高 h，宽按字数自动算，但不超过 maxW。
   * 位置要比底下的表面高出一两毫米，免得和表面打架。
   */
  label(text: string, opts: LabelOpts, maxW: number, h: number, pos: V3, rot?: V3) {
    const p = label(text, opts);
    this.patch(p, Math.min(maxW, h * p.aspect), h, pos, rot);
  }
  /** 一张具名贴纸（危险品标之类），宽 w，高默认等于宽。 */
  decal(name: string, w: number, pos: V3, rot?: V3, h = w) {
    this.patch(decal(name), w, h, pos, rot);
  }

  // ------------------------------------------------------------------ 收尾
  /**
   * 合并成网格，并烤上一层"脏"。
   *   size   占地尺寸 [x, y, z]，不给就量一下实际的外包盒；
   *   boxes  碰撞盒，不给就用整个外包盒；给空数组表示没有碰撞（路锥、油壶）；
   *   grime  脏的程度，0 是不烤，1 是默认。
   */
  finish(o: { size?: V3; boxes?: LocalBox[]; grime?: number; surface?: Surface; recv?: boolean } = {}): PropModel {
    const group = new THREE.Group(), grime = o.grime ?? 1, r = this.seed * 3.71;
    const bounds = new THREE.Box3();
    for (const b of this.buckets.values()) {
      const geo = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!b.raw && grime > 0) {
        const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), col = geo.getAttribute('color');
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          const big = noise3(x * 1.9 + r, y * 1.9, z * 1.9 + 5.3);  // 大块的深浅，半米左右一个起伏
          const fine = noise3(x * 9 + 2.1, y * 9 + r, z * 9);       // 细碎的深浅，十厘米左右
          let k = (0.82 + 0.18 * big) * (0.92 + 0.08 * fine) * (0.76 + 0.24 * Math.min(1, Math.max(0, nor.getY(i) * 0.6 + 0.62))); // 朝下的面压暗
          const low = Math.min(1, Math.max(0, 1 - y / 0.2));        // 离地 20 厘米以内
          k *= 1 - 0.42 * low * low * (0.55 + 0.45 * fine);         // 贴地的一圈最多再暗四成
          k = 1 + (k - 1) * grime;
          col.setXYZ(i, col.getX(i) * k, col.getY(i) * k * (1 - 0.05 * low * grime), col.getZ(i) * k * (1 - 0.12 * low * grime)); // 贴地处偏黄褐
        }
      }
      geo.computeBoundingBox(); geo.computeBoundingSphere();
      if (!b.raw) bounds.union(geo.boundingBox!);
      const material = typeof b.mat === 'string' ? surface(b.mat, { vertexColors: true, interior: this.opt.interior }) : b.mat;
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = b.cast; mesh.receiveShadow = o.recv ?? true;
      mesh.name = `${this.name}:${typeof b.mat === 'string' ? b.mat : b.mat.name || 'mat'}`;
      group.add(mesh);
    }
    this.buckets.clear();
    group.name = this.name;
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(), new THREE.Vector3());
    const size: V3 = o.size ?? [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z];
    const boxes: LocalBox[] = o.boxes ?? [{ min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] }];
    if (o.surface) for (const b of boxes) b.surface ??= o.surface;
    return { group, boxes, size, name: this.name };
  }

  /** 三角形总数：搭完看一眼，心里有数。 */
  get triangles() {
    let n = 0;
    for (const b of this.buckets.values()) for (const g of b.geos) n += g.getAttribute('position').count / 3;
    return n;
  }
}

/** 让三角形的正面和顶点法线朝同一边：把每个三角形的几何法线和它的顶点法线点乘再加起来，是负的就全部翻面。 */
function fixWinding(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position'), idx = g.getIndex()!;
  let vol = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const ux = p.getX(b) - p.getX(a), uy = p.getY(b) - p.getY(a), uz = p.getZ(b) - p.getZ(a);
    const vx = p.getX(c) - p.getX(a), vy = p.getY(c) - p.getY(a), vz = p.getZ(c) - p.getZ(a);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nor = g.getAttribute('normal');
    vol += nx * (nor.getX(a) + nor.getX(b) + nor.getX(c)) + ny * (nor.getY(a) + nor.getY(b) + nor.getY(c)) + nz * (nor.getZ(a) + nor.getZ(b) + nor.getZ(c));
  }
  if (vol < 0) { const arr = idx.array; for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; } idx.needsUpdate = true; }
}
