import * as THREE from 'three';
import { clamp } from '../../core/math';
import { decal as decalPatch, label as labelPatch, labelMaterial, type LabelOpts, type Patch } from '../../render/labels';
import { surface, type SurfaceName } from '../../render/surfaces';
import { chamferBox, hex, Kit, noise3, type Mat, type PropModel, type Rgb, type Tint, type V3 } from '../kit';

// 货物类道具：油桶、托盘、木箱、吨桶、纸箱堆、盖防水布的货、沙袋墙、轮胎堆、电缆盘、油壶、路锥。
//
// 每种道具一个函数，返回零件箱（Kit）搭好的 PropModel：底面在 y=0，原点在占地中心，自带碰撞盒。
// 这些东西在场上会被摆几十次，所以有三条规矩：
//   · 同一组参数只搭一次，之后都返回缓存里的同一个模型 —— 交给 PropField 用 InstancedMesh 一次画完；
//   · seed 只取有限的几个"个体"（比如油桶 4 个）：凹坑的位置、木板的深浅各不相同，摆在一起不像复制粘贴，
//     又不至于每摆一只就多出一份几何体；
//   · 一件道具尽量只用两三种材质 —— 每多一种材质，这件道具就多一次绘制调用。
//
// 尺寸和做法照参考实现的道具表。读的时候可以从最简单的托盘（addPallet）看起，再看油桶（车削 + 捏凹坑 + 按位置上色）。

/** 所有货物道具都认的两个选项。 */
export interface CargoOpts {
  /** 个体编号：换一个数，凹坑的位置、木板的深浅、歪的角度就不一样。每种道具只有有限的几个个体，超出就绕回来。 */
  seed?: number;
  /** 摆在室内（淋不到雨）。 */
  interior?: boolean;
}

const HALF_PI = Math.PI / 2, TAU = Math.PI * 2;
type PartOpts = NonNullable<Parameters<Kit['add']>[2]>;
type Axis = 'x' | 'y' | 'z';

// ====================================================================== 缓存

const models = new Map<string, PropModel>();
/** 同一个 key 只搭一次。 */
function cached(key: string, build: () => PropModel): PropModel {
  let m = models.get(key);
  if (!m) models.set(key, (m = build()));
  return m;
}
/** 把任意 seed 归到 0…count-1：一种道具只准备 count 个不同的个体。 */
const variantOf = (seed: number | undefined, count: number) => Math.abs((seed ?? 0) | 0) % count;
const tag = (o: CargoOpts) => (o.interior ? '|in' : '');

// ====================================================================== 小工具

const smoothstep = (lo: number, hi: number, v: number) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

/** 先按 rot 转、再挪到 pos 的变换矩阵（和 Kit.push 的约定一样）。 */
function matrixOf(pos: V3, rot: V3 = [0, 0, 0]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));
}

/**
 * 零件箱的染色函数拿到的是"整件道具的坐标"。可是放倒的油桶、歪着的纸箱，花纹应该跟着零件自己走
 * （流痕顺着桶身，而不是永远竖直朝下）。这里把点先变回零件自己的坐标，再交给 fn 算颜色。
 */
function inLocal(pose: THREE.Matrix4, fn: (x: number, y: number, z: number) => number | Rgb): Tint {
  const inv = pose.clone().invert(), p = new THREE.Vector3();
  return (x, y, z) => { p.set(x, y, z).applyMatrix4(inv); return fn(p.x, p.y, p.z); };
}

/** 换了颜色的具名材质（比如把灰塑料换成吨桶的乳白色）。质感不变，只是底色不同。 */
function recolored(name: SurfaceName, color: number, o: CargoOpts & { doubleSide?: boolean } = {}) {
  return surface(name, { vertexColors: true, color, interior: o.interior, doubleSide: o.doubleSide });
}

/**
 * 材质的底色是 base，想让某个零件显示成 target，顶点色该乘多少。
 * 用它可以让"橙色锥身和白色反光带""乳白桶身和红色旋盖"共用同一个材质：少一种材质就少一次绘制调用。
 * base 要选两者里更亮的那个，这样倍数都不超过 1。
 */
function toward(target: number, base: number, mul = 1): Rgb {
  const t = hex(target), b = hex(base);
  return [(t[0] / Math.max(b[0], 1e-4)) * mul, (t[1] / Math.max(b[1], 1e-4)) * mul, (t[2] / Math.max(b[2], 1e-4)) * mul];
}

/** 逐顶点改位置。 */
function deform(g: THREE.BufferGeometry, fn: (p: THREE.Vector3) => void) {
  const pos = g.getAttribute('position'), p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i); fn(p); pos.setXYZ(i, p.x, p.y, p.z); }
  return g;
}

/**
 * 重算平滑的法线：位置相同的顶点（哪怕属于不同的面）共用同一个法线。
 * 盒子的每个面有自己的一套顶点，直接 computeVertexNormals 会在棱上留下一道折痕；
 * 捏过形状的沙袋、压瘪的纸箱要的是圆滚滚的过渡，所以按位置把法线加到一起再归一。
 */
function smoothNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position'), index = g.getIndex(), n = pos.count;
  const keys: string[] = new Array(n), sums = new Map<string, [number, number, number]>();
  for (let i = 0; i < n; i++) keys[i] = `${Math.round(pos.getX(i) * 2000)},${Math.round(pos.getY(i) * 2000)},${Math.round(pos.getZ(i) * 2000)}`;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const count = index ? index.count : n;
  for (let f = 0; f < count; f += 3) {
    const tri = [0, 1, 2].map((j) => (index ? index.getX(f + j) : f + j));
    a.fromBufferAttribute(pos, tri[0]); b.fromBufferAttribute(pos, tri[1]).sub(a); c.fromBufferAttribute(pos, tri[2]).sub(a);
    b.cross(c); // 叉积的长度正比于三角形面积：大三角形说话更有分量
    for (const v of tri) {
      let s = sums.get(keys[v]);
      if (!s) sums.set(keys[v], (s = [0, 0, 0]));
      s[0] += b.x; s[1] += b.y; s[2] += b.z;
    }
  }
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = sums.get(keys[i]) ?? [0, 1, 0], len = Math.hypot(s[0], s[1], s[2]) || 1;
    nor[i * 3] = s[0] / len; nor[i * 3 + 1] = s[1] / len; nor[i * 3 + 2] = s[2] / len;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/**
 * 车削：侧面轮廓 [半径, 高度] 绕 y 轴转一圈。和 Kit.lathe 是同一件事，区别是这里把几何体交回来，
 * 好在放进零件箱之前再捏一捏（油桶的凹坑）。
 *   · 轮廓要"从下往上走外侧"地写（底面圆心 → 外壁 → 顶面圆心），这样面才朝外；
 *   · 连着写两个相同的点 = 那里是一道硬棱；
 *   · 半径为 0 的那一圈其实是一个点，那里每格只出一个三角形。
 */
function latheGeo(profile: [number, number][], seg: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (const [r, y] of profile) for (let s = 0; s < seg; s++) {
    const a = (s / seg) * TAU;
    pos.push(r * Math.sin(a), y, r * Math.cos(a));
  }
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    if (r0 === r1 && y0 === y1) continue; // 硬棱：两圈顶点位置相同但不连面，各算各的法线
    for (let s = 0; s < seg; s++) {
      // 一圈的最后一格接回第一列（取余数）：没有接缝，法线绕一圈都是平滑的
      const a = i * seg + s, b = i * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
      if (r0 > 1e-6) idx.push(a, b, c);
      if (r1 > 1e-6) idx.push(b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * 带细分的圆角盒，中心在原点。和 Kit.rbox 的区别：平的面上也有网格（sx × sy × sz 格），
 * 所以之后可以把面中间鼓起来、把上半截压瘪 —— Kit.rbox 的顶点全挤在圆角上，面中间没有顶点可捏。
 * 做法：普通的细分盒子，把最靠边的一圈网格线挪到离棱 r 的地方，再把棱上的顶点收到圆弧上。
 * drop 可以去掉顶面或底面（敞口的纸箱）。
 */
function softBox(w: number, h: number, d: number, r: number, sx = 3, sy = 3, sz = 3, drop?: 'top' | 'bottom'): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
  if (drop) {
    // BoxGeometry 的六个面按 +x、-x、+y、-y、+z、-z 的顺序排在索引里，每个面是一个 group
    const face = g.groups[drop === 'top' ? 2 : 3], index = Array.from(g.getIndex()!.array);
    index.splice(face.start, face.count);
    g.setIndex(index);
  }
  g.clearGroups();
  const hx = w / 2, hy = h / 2, hz = d / 2;
  r = Math.min(r, hx * 0.95, hy * 0.95, hz * 0.95);
  // 面内部的网格线按比例往外撑，让最靠边的那一条正好落在"离棱 r"的位置
  const spread = (v: number, half: number, segs: number) => {
    if (Math.abs(v) > half - 1e-6 || segs < 3) return v;
    return (v * (half - r)) / (half - (2 * half) / segs);
  };
  const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    let x = spread(pos.getX(i), hx, sx), y = spread(pos.getY(i), hy, sy), z = spread(pos.getZ(i), hz, sz);
    // (cx, cy, cz) 是"往里缩了 r 的小盒子"上离它最近的点；顶点到它的方向就是圆角的法线方向
    const cx = clamp(x, -(hx - r), hx - r), cy = clamp(y, -(hy - r), hy - r), cz = clamp(z, -(hz - r), hz - r);
    const onFaces = (Math.abs(x) > hx - 1e-5 ? 1 : 0) + (Math.abs(y) > hy - 1e-5 ? 1 : 0) + (Math.abs(z) > hz - 1e-5 ? 1 : 0);
    const len = Math.hypot(x - cx, y - cy, z - cz);
    if (onFaces >= 2 && len > 1e-6) { // 在棱或角上：收到半径 r 的圆弧上
      const nx = (x - cx) / len, ny = (y - cy) / len, nz = (z - cz) / len;
      x = cx + nx * r; y = cy + ny * r; z = cz + nz * r;
      nor.setXYZ(i, nx, ny, nz);
    }
    pos.setXYZ(i, x, y, z);
  }
  g.deleteAttribute('uv');
  return g;
}

/**
 * 放一个几何体，并把它的贴图坐标随机错开一段。
 * 零件箱的贴图坐标就是零件自己的坐标（单位米），所以十块同样大小的木板会取到贴图上同一块木纹，一眼就看出是复制的。
 * 办法：先把几何体整体挪开一段（贴图坐标跟着变），摆放的时候再挪回来。
 */
function addShifted(k: Kit, mat: Mat, g: THREE.BufferGeometry, pos: V3, rot: V3 | undefined, o: PartOpts) {
  const sx = k.range(0, 3), sy = k.range(0, 3), sz = k.range(0, 3);
  g.translate(sx, sy, sz);
  k.add(mat, g, o, matrixOf(pos, rot).multiply(new THREE.Matrix4().makeTranslation(-sx, -sy, -sz)));
}

/** 一行字，保持字形不被压扁：宽不超过 maxW、高不超过 maxH，哪个先到就按哪个缩。贴片法线朝 +z，用 rot 转向。 */
function text(k: Kit, str: string, o: LabelOpts, maxW: number, maxH: number, pos: V3, rot?: V3) {
  const aspect = labelPatch(str, o).aspect, w = Math.min(maxW, maxH * aspect);
  k.label(str, o, w, w / aspect, pos, rot);
}

/**
 * 贴在圆柱面上的弯贴片（油桶上的标签）：绕 y 轴、半径 radius，弧长 arc、高 height，中心在高度 y、朝向 yaw。
 * 平的贴片贴在桶上，两边会翘出去一厘米；这里把它切成 4 小条，每条贴着弧面。
 */
function wrapPatch(k: Kit, p: Patch, radius: number, arc: number, height: number, y: number, yaw: number, cols = 4) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const t = i / cols, a = ((t - 0.5) * arc) / radius, s = Math.sin(a), c = Math.cos(a), u = p.uv[0] + (p.uv[2] - p.uv[0]) * t;
    pos.push(radius * s, -height / 2, radius * c, radius * s, height / 2, radius * c);
    nor.push(s, 0, c, s, 0, c);
    uv.push(u, p.uv[1], u, p.uv[3]);
  }
  for (let i = 0; i < cols; i++) { const a = i * 2; idx.push(a, a + 2, a + 3, a, a + 3, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  k.add(labelMaterial(), g, { raw: true, cast: false }, matrixOf([0, y, 0], [0, yaw, 0]));
}

// 每块木板自己的颜色：一个深浅 × 一点点偏黄 / 偏红。同一堆木头里没有两块是同一个色的。
const palletTone = (k: Kit, mul = 1): Rgb => { const u = k.range(0.62, 1) * mul, h = k.range(0.9, 1); return [u, u * (0.93 + 0.07 * h), u * (0.82 + 0.18 * h)]; };
const crateTone = (k: Kit, mul = 1): Rgb => { const u = k.range(0.7, 1) * mul; return [u, u * k.range(0.92, 1), u * k.range(0.82, 0.95)]; };
/**
 * 深色木头（材质表里的 wood_dark）= 同一种木纹乘上这个灰褐色。
 * 所以不必真的换材质：在 wood_pallet 上把顶点色乘上它，效果一样，而整件道具的木头就能并成一个网格。
 */
const DARK_WOOD = hex(0x8a786a);
const reelTone = (k: Kit, mul = 1): Rgb => { const u = k.range(0.7, 1) * mul; return [u * DARK_WOOD[0], u * k.range(0.93, 1) * DARK_WOOD[1], u * k.range(0.85, 0.97) * DARK_WOOD[2]]; };

// ====================================================================== 托盘

/** 托盘垫块的侧面：切掉四个竖棱的长方柱，不带上下盖（上下都被木板压着，看不见）。16 个三角形。底面在 y=0。 */
function blockSides(w: number, d: number, h: number, cut: number) {
  const x = w / 2, z = d / 2;
  const ring = [[-x + cut, -z], [x - cut, -z], [x, -z + cut], [x, z - cut], [x - cut, z], [-x + cut, z], [-x, z - cut], [-x, -z + cut]];
  const pos: number[] = [], nor: number[] = [];
  for (let i = 0; i < 8; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 8];
    const len = Math.hypot(bx - ax, bz - az) || 1, nx = (bz - az) / len, nz = -(bx - ax) / len; // 这一面朝外的法线
    pos.push(ax, 0, az, ax, h, az, bx, 0, bz, bx, 0, bz, ax, h, az, bx, h, bz);
    for (let j = 0; j < 6; j++) nor.push(nx, 0, nz);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * 往零件箱里放一只欧标托盘（1.2 × 0.144 × 1.0 米），放在当前坐标系的原点。
 * 从下到上四层：3 条底板 → 9 个垫块 → 3 条纵梁板 → 5 条面板。
 *   broken  面板缺一条；
 *   stamp   两个垫块侧面印 "EUR"；
 *   bevel   木板带倒角（单独摆的、摞在最上面的才值得；压在底下的用 12 个三角形的直角盒）。
 */
function addPallet(k: Kit, o: { broken?: boolean; stamp?: boolean; bevel?: boolean } = {}) {
  const jitter = (a = 0.003) => k.range(-a, a); // 每块板都钉歪了几毫米
  const board = (sx: number, sy: number, sz: number, pos: V3, rot: V3, grain: Axis) =>
    addShifted(k, 'wood_pallet', o.bevel ? chamferBox(sx, sy, sz, 0.004) : new THREE.BoxGeometry(sx, sy, sz), pos, rot, { tint: palletTone(k), grain });
  // 底板：两边窄（10 厘米）、中间宽（14.5 厘米）
  for (const [z, w] of [[-0.45, 0.1], [0, 0.145], [0.45, 0.1]]) board(1.2, 0.022, w, [jitter(), 0.011, z + jitter()], [0, jitter(0.006), 0], 'x');
  // 垫块：3 × 3 个，颜色比木板再深两成（端面的木头吸水更黑）
  for (const x of [-0.5275, 0, 0.5275]) for (const z of [-0.45, 0, 0.45]) {
    const wood = palletTone(k, 0.8);
    addShifted(k, 'wood_pallet', blockSides(0.145, z === 0 ? 0.145 : 0.1, 0.078, 0.012), [x + jitter(), 0.022, z + jitter()], [0, jitter(0.03), 0], { tint: wood, grain: 'x' });
  }
  // 纵梁板：压在垫块上，和面板垂直
  for (const x of [-0.5275, 0, 0.5275]) board(0.145, 0.022, 1, [x + jitter(), 0.111, jitter()], [0, jitter(0.006), 0], 'z');
  // 面板：宽窄相间的 5 条
  [[-0.4275, 0.145], [-0.215, 0.1], [0, 0.145], [0.215, 0.1], [0.4275, 0.145]].forEach(([z, w], i) => {
    if (o.broken && i === 3) return;
    board(1.2, 0.022, w, [jitter(), 0.133, z + jitter(0.006)], [jitter(0.004), jitter(0.008), 0], 'x');
  });
  if (o.stamp) {
    const ink: LabelOpts = { color: 'black', font: 'sans', distress: 0.6 };
    text(k, 'EUR', ink, 0.085, 0.05, [-0.5275, 0.062, 0.5015]);
    text(k, 'EUR', ink, 0.085, 0.05, [0.5275, 0.062, -0.5015], [0, Math.PI, 0]);
  }
}

export interface PalletOpts extends CargoOpts { /** 面板缺一条。 */ broken?: boolean }
/** 托盘。4 个个体。太矮，登记碰撞时会被 PropField 跳过（人直接踩过去）。 */
export function pallet(o: PalletOpts = {}): PropModel {
  const v = variantOf(o.seed, 4), broken = !!o.broken;
  return cached(`pallet|${broken}|${v}${tag(o)}`, () => {
    const k = new Kit('pallet', v, { interior: o.interior });
    addPallet(k, { broken, stamp: true, bevel: true });
    return k.finish({ size: [1.2, 0.144, 1], boxes: [{ min: [-0.6, 0, -0.5], max: [0.6, 0.144, 0.5] }], surface: 'wood' });
  });
}

export interface PalletStackOpts extends CargoOpts { /** 摞几只，1–12，默认 8。 */ count?: number }
/** 托盘堆：一只一只摞上去，每只都错开一点、转一点，偶尔调个头、缺块板。3 个个体。 */
export function palletStack(o: PalletStackOpts = {}): PropModel {
  const v = variantOf(o.seed, 3), count = clamp(Math.round(o.count ?? 8), 1, 12);
  return cached(`pallet_stack|${count}|${v}${tag(o)}`, () => {
    const k = new Kit('pallet_stack', v, { interior: o.interior });
    for (let i = 0; i < count; i++) {
      const top = i === count - 1;
      const x = i ? k.range(-0.028, 0.028) : 0, z = i ? k.range(-0.022, 0.022) : 0;
      // 偏航：小歪一点；三成的概率整只调头放；最上面那只是随手扔上去的，再多歪一点
      const yaw = k.range(-0.035, 0.035) + (k.rng() < 0.3 ? Math.PI : 0) + (top ? k.range(-0.06, 0.06) : 0);
      const broken = !top && k.rng() < 0.2;
      k.at([x, i * 0.144, z], [0, yaw, 0], () => addPallet(k, { broken, stamp: i % 3 === 0, bevel: top }));
    }
    const h = count * 0.144;
    return k.finish({ size: [1.2, h, 1], boxes: [{ min: [-0.6, 0, -0.5], max: [0.6, h, 0.5] }], surface: 'wood' });
  });
}

// ====================================================================== 油桶

/**
 * 油桶的侧面轮廓 [半径, 高度]：下卷边 → 桶身 → 两道外鼓的滚箍（y=0.305 和 0.595）→ 上卷边 → 下沉 16 毫米的桶盖。
 * 桶身的三段直筒中间各多切了两圈，凹坑才有顶点可以往里推。open 时没有盖，轮廓翻过桶口沿内壁走到桶底。
 */
function barrelProfile(open: boolean): [number, number][] {
  const p: [number, number][] = [[0, 0.016], [0.262, 0.016], [0.262, 0.016], [0.288, 0], [0.295, 0.008], [0.295, 0.022], [0.284, 0.034], [0.2835, 0.114], [0.283, 0.195]];
  for (const y of [0.305, 0.595]) {
    p.push([0.283, y - 0.03], [0.291, y - 0.018], [0.297, y], [0.291, y + 0.018], [0.283, y + 0.03]);
    p.push(y < 0.5 ? [0.283, 0.412] : [0.283, 0.705], y < 0.5 ? [0.283, 0.488] : [0.2835, 0.786]);
  }
  p.push([0.284, 0.866], [0.295, 0.878], [0.295, 0.892], [0.288, 0.9], [0.268, 0.898]);
  if (open) p.push([0.268, 0.898], [0.272, 0.888], [0.272, 0.03], [0.272, 0.03], [0, 0.03]);
  else p.push([0.262, 0.884], [0.262, 0.884], [0, 0.884]);
  return p;
}

const BARREL_PAINT = { blue: 'paint_blue', red: 'paint_red', green: 'paint_green', yellow: 'paint_yellow' } as const;
export interface BarrelOpts extends CargoOpts {
  color?: keyof typeof BARREL_PAINT;
  /** 放倒：桶轴沿 x，占地变成 0.9 × 0.6 × 0.6。 */
  lying?: boolean;
  /** 开盖：没有桶盖，能看到内壁。 */
  open?: boolean;
}
/** 200 升油桶，0.6 × 0.9 × 0.6 米。每只有 2–3 个随机的凹坑。4 个个体。 */
export function barrel(o: BarrelOpts = {}): PropModel {
  const color = o.color ?? 'blue', lying = !!o.lying, open = !!o.open, v = variantOf(o.seed, 4);
  return cached(`barrel|${color}|${lying}|${open}|${v}${tag(o)}`, () => {
    const k = new Kit('barrel', v, { interior: o.interior });
    const g = latheGeo(barrelProfile(open), 20);

    // 凹坑：[绕桶的角度, 高度, 半径, 深度]。开盖的桶壁只有 12 毫米厚，坑太深会把外壁推到内壁里面去，所以浅一点。
    const dents: number[][] = [];
    for (let i = 0; i < 2 + (v % 2); i++) dents.push([k.rng() * TAU, k.range(0.12, 0.78), k.range(0.07, 0.13), k.range(0.006, open ? 0.008 : 0.014)]);
    deform(g, (p) => {
      const rad = Math.hypot(p.x, p.z);
      if (rad < 0.27) return; // 桶盖和桶底不动
      const ang = Math.atan2(p.z, p.x);
      for (const [a0, y0, size, depth] of dents) {
        let da = Math.abs(ang - a0) % TAU;
        if (da > Math.PI) da = TAU - da; // 绕桶一圈的角度差，取近的那一边
        const dist = Math.hypot(da * 0.285, p.y - y0); // 在桶面上离坑心多远（弧长 = 角度 × 半径）
        if (dist >= size) continue;
        const pull = 1 - (depth * (0.5 + 0.5 * Math.cos((Math.PI * dist) / size))) / rad; // 坑心最深，按余弦曲线缓缓回到桶面
        p.x *= pull; p.z *= pull;
      }
    });
    g.computeVertexNormals();

    // 放倒：绕 z 轴转 -90°，桶轴从 +y 倒向 +x；抬高一个滚箍半径（0.297），让滚箍正好着地
    const pose = lying ? matrixOf([-0.45, 0.297, 0], [0, 0, -HALF_PI]) : new THREE.Matrix4();
    if (lying) k.push([-0.45, 0.297, 0], [0, 0, -HALF_PI]);

    const shift = v * 2.37; // 每个个体的花纹错开一段
    k.add(BARREL_PAINT[color], g, {
      tint: inLocal(pose, (x, y, z) => {
        const rad = Math.hypot(x, z), ang = Math.atan2(z, x);
        // 开盖的桶：内壁和桶底照不到光，越往下越黑
        if (open && rad < 0.2735 && y > 0.025 && y < 0.895) return 0.22 + 0.38 * clamp((y - 0.03) / 0.86, 0, 1);
        if (rad < 0.27) { // 桶盖、桶底：漆面发灰，盖子上有深浅不匀的水渍
          const lid = y > 0.5 ? 0.62 + 0.3 * noise3(x * 9 + shift, z * 9, 0) : 0.6;
          return [lid, lid, lid];
        }
        // 竖向流痕：亮度只跟"绕桶的角度"有关，所以是一道一道竖条。
        // 角度本身在桶背面会从 +π 跳到 -π，直接拿去取噪声会留一条接缝；换成圆周上的点 (cos, sin) 再取，绕一圈正好接上。
        const streak = Math.pow(noise3(Math.cos(ang) * 2.6 + shift, Math.sin(ang) * 2.6, 3.1), 2.2);
        // 桶身被两道滚箍分成三段。down 在每段的顶上是 0、往下走到 1：脏水从滚箍底下淌出来，越往下越淡
        const down = y > 0.6 ? (0.88 - y) / 0.28 : y > 0.31 ? (0.6 - y) / 0.29 : (0.31 - y) / 0.31;
        const body = 1 - 0.55 * streak * (1 - 0.6 * clamp(down, 0, 1));
        // 卷边和滚箍比桶身凸出来（半径 > 0.289），搬运时总是它们先磕到：掉漆见锈。锈色 = 红留得多、蓝留得少
        const rust = rad > 0.289 ? 0.35 + 0.65 * noise3(Math.cos(ang) * 7 + shift, Math.sin(ang) * 7, y * 20) : 0;
        return [body * (1 - 0.25 * rust), body * (1 - 0.42 * rust), body * (1 - 0.55 * rust)];
      }),
    });
    if (!open) { // 桶盖上的两个镀锌灌口：一大一小
      k.cyl('steel_galv', 0.038, 0.016, 0.17, 0.891, 0.02, { r2: 0.036, seg: 8, tint: 0.8 });
      k.cyl('steel_galv', 0.018, 0.014, -0.16, 0.89, -0.08, { r2: 0.017, seg: 8, tint: 0.8 });
    }
    // 贴标：两道滚箍之间一张易燃标（每三个个体里有一个没贴）；偶数个体在上段喷了危险品编号
    if (v % 3 !== 2) wrapPatch(k, decalPatch('flammable'), 0.2855, 0.15, 0.15, 0.455, 0.9 + v);
    if (v % 2 === 0) {
      const un = labelPatch('UN 1202', { color: color === 'yellow' ? 'black' : 'white', font: 'stencil', distress: 0.5 });
      wrapPatch(k, un, 0.2855, 0.2, 0.2 / un.aspect, 0.74, 2.6 + v);
    }
    if (lying) k.pop();
    return lying
      ? k.finish({ size: [0.9, 0.6, 0.6], boxes: [{ min: [-0.45, 0, -0.3], max: [0.45, 0.6, 0.3] }], surface: 'metal' })
      : k.finish({ size: [0.6, 0.9, 0.6], boxes: [{ min: [-0.3, 0, -0.3], max: [0.3, 0.9, 0.3] }], surface: 'metal' });
  });
}

// ====================================================================== 木箱

interface CrateSpec {
  /** 细节：木条带倒角、长侧面有斜撑、上下 8 个角都有包角。叠在上面的小箱子不需要。 */
  detail?: boolean;
  /** 垫木（箱底 3 根，叉车从这里叉进去）。 */
  skids?: boolean;
  /** 正反两面的喷字；空字符串表示不喷。 */
  label?: string;
  /** 侧面的编号。 */
  code?: string;
}
/**
 * 往零件箱里放一只木箱，长 L（x）× 高 H × 宽 W（z），底面在当前坐标系的 y=0。
 * 结构：垫木 → 一个深色的"内胆"（木板缝里露出来的黑）→ 四个侧面和顶面各由一条条独立的木板拼成
 * → 外面钉一圈 7 厘米宽的边框和斜撑 → 角上包镀锌铁皮 → 喷字。
 */
function addCrate(k: Kit, L: number, H: number, W: number, s: CrateSpec = {}) {
  const detail = s.detail ?? true, skids = s.skids ?? true;
  const T = 0.022, F = 0.07;                // 边框木条的厚度、宽度
  const base = skids ? 0.07 : 0;            // 垫木高度：箱体从这里往上
  const bodyH = H - base, midY = base + bodyH / 2;
  const batten = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mul: number, grain: Axis, rot?: V3) =>
    addShifted(k, 'wood_pallet', detail ? chamferBox(sx, sy, sz, 0.004) : new THREE.BoxGeometry(sx, sy, sz), [x, y, z], rot, { tint: crateTone(k, mul), grain });

  if (skids) for (const x of [-(L / 2 - 0.13), 0, L / 2 - 0.13]) k.box('wood_pallet', 0.09, base, W - 0.02, x, base / 2, 0, { c: 0.006, tint: crateTone(k, 0.6), grain: 'z' });
  k.box('wood_pallet', L - 2 * T - 0.012, bodyH - T - 0.012, W - 2 * T - 0.012, 0, base + (bodyH - T - 0.012) / 2 + 0.002, 0, { plain: true, tint: [0.25 * DARK_WOOD[0], 0.25 * DARK_WOOD[1], 0.25 * DARK_WOOD[2]] });

  // 侧面的木板：每条只是一张平面（2 个三角形），上下留 5 毫米的缝。
  // 每条往里缩的深度随机差 0–4 毫米，板面就不是一个平整的大面，侧光下每条板的亮度都不一样。
  const plank = (w: number, h: number, pos: V3, rot: V3) => addShifted(k, 'wood_pallet', new THREE.PlaneGeometry(w, h), pos, rot, { tint: crateTone(k) });
  const rows = Math.max(3, Math.round(bodyH / 0.125)), rowH = bodyH / rows;
  for (let i = 0; i < rows; i++) {
    const y = base + rowH * (i + 0.5);
    plank(L - 0.03, rowH - 0.005, [0, y, W / 2 - T - k.range(0, 0.004)], [0, 0, 0]);
    plank(L - 0.03, rowH - 0.005, [0, y, -(W / 2 - T - k.range(0, 0.004))], [0, Math.PI, 0]);
    plank(W - 0.03, rowH - 0.005, [L / 2 - T - k.range(0, 0.004), y, 0], [0, HALF_PI, 0]);
    plank(W - 0.03, rowH - 0.005, [-(L / 2 - T - k.range(0, 0.004)), y, 0], [0, -HALF_PI, 0]);
  }
  const lids = Math.max(3, Math.round(W / 0.13)), lidW = (W - 0.02) / lids;
  for (let i = 0; i < lids; i++) plank(L - 0.03, lidW - 0.005, [0, H - T - k.range(0, 0.003), -W / 2 + 0.01 + lidW * (i + 0.5)], [-HALF_PI, 0, 0]);

  // 边框。长侧面（±z）：上下两条横的 + 左右两条竖的 + 一根对角斜撑；短侧面（±x）：同样一圈；顶面四周一圈
  const braceAngle = Math.atan2(bodyH - 2 * F, L - 2 * F), braceLen = Math.hypot(L - 2 * F, bodyH - 2 * F);
  for (const side of [1, -1]) {
    const z = side * (W / 2 - T / 2);
    batten(L, F, T, 0, base + F / 2, z, 0.85, 'x');
    batten(L, F, T, 0, H - F / 2, z, 0.85, 'x');
    for (const e of [1, -1]) batten(F, bodyH - 2 * F, T, e * (L / 2 - F / 2), midY, z, 0.85, 'y');
    // 斜撑比边框薄一点、往里收一点；前后两面斜的方向相反（从外面看都是"左下到右上"）
    if (detail) batten(braceLen, F * 0.85, T * 0.8, 0, midY, side * (W / 2 - T * 0.6), 0.8, 'x', [0, 0, side * braceAngle]);
    const x = side * (L / 2 - T / 2), span = W - 2 * T;
    for (const e of [1, -1]) batten(T, bodyH, F, x, midY, e * (span / 2 - F / 2), 0.85, 'y');
    batten(T, F, span - 2 * F, x, base + F / 2, 0, 0.85, 'z');
    batten(T, F, span - 2 * F, x, H - F / 2, 0, 0.85, 'z');
    batten(L, T, F, 0, H - T / 2, side * (W / 2 - F / 2), 0.85, 'x');
    batten(F, T, W - 2 * F, side * (L / 2 - F / 2), H - T / 2, 0, 0.85, 'z');
  }
  if (detail) batten(F, T, W - 2 * F, 0, H - T / 2, 0, 0.85, 'z'); // 顶面中间再压一根

  // 镀锌包角：每个角两三片 8.5 厘米见方、3 毫米厚的薄铁皮，各贴在一个面上。镀锌皮旧了会发黄，所以绿、蓝两个分量压低一点
  const P = 0.085;
  for (const sx of [1, -1]) for (const sz of [1, -1]) for (const upper of detail ? [true, false] : [true]) {
    const y = upper ? H - P / 2 : base + P / 2, shade = k.range(0.55, 0.9), zinc: Rgb = [shade, shade * 0.9, shade * 0.8];
    k.box('steel_galv', P, P, 0.003, sx * (L / 2 - P / 2), y, sz * (W / 2 + 0.0015), { plain: true, tint: zinc });
    k.box('steel_galv', 0.003, P, P, sx * (L / 2 + 0.0015), y, sz * (W / 2 - P / 2), { plain: true, tint: zinc });
    if (upper) k.box('steel_galv', P, 0.003, P, sx * (L / 2 - P / 2), H + 0.0015, sz * (W / 2 - P / 2), { plain: true, tint: zinc });
  }

  // 喷字：贴在木板面上（比木板高出 3 毫米），在边框围出的凹槽里
  const face = W / 2 - T + 0.003, textH = Math.min(0.11, bodyH * 0.15);
  if (s.label) {
    const ink: LabelOpts = { color: 'black', font: 'stencil', distress: 0.25 };
    text(k, s.label, ink, L * 0.4, textH, [-L * 0.2, H - F - textH * 0.95, face]);
    text(k, s.label, ink, L * 0.4, textH, [L * 0.2, H - F - textH * 0.95, -face], [0, Math.PI, 0]);
    const arrowH = Math.min(0.14, bodyH * 0.2); // "此面向上"的箭头，在右下角
    k.decal('arrow_up', arrowH * 0.62, [L * 0.27, base + F + bodyH * 0.16, face], undefined, arrowH);
  }
  if (s.code) text(k, s.code, { color: 'black', font: 'stencil', distress: 0.3 }, W * 0.5, textH * 0.9, [L / 2 - T + 0.003, midY + bodyH * 0.12, 0], [0, HALF_PI, 0]);
  if (detail) text(k, '激战远洋', { color: 'white', font: 'sans', distress: 0.45 }, Math.min(0.2, bodyH * 0.25), 0.06, [-(L / 2 - T + 0.003), midY - bodyH * 0.05, 0], [0, -HALF_PI, 0]);
}

const CRATE_LABELS = ['易碎物品', '此面向上', '保持干燥', '机械零件'], CRATE_CODES = [117, 204, 318];
/** 木箱，1.1 × 1.0 × 0.9 米。喷字 4 种 × 编号 3 种，一共 12 个个体。 */
export function crateWood(o: CargoOpts = {}): PropModel {
  const v = variantOf(o.seed, 12);
  return cached(`crate_wood|${v}${tag(o)}`, () => {
    const k = new Kit('crate_wood', v, { interior: o.interior });
    addCrate(k, 1.1, 1, 0.9, { label: CRATE_LABELS[v % 4], code: `B4-${CRATE_CODES[v % 3]}` });
    return k.finish({ size: [1.1, 1, 0.9], boxes: [{ min: [-0.55, 0, -0.45], max: [0.55, 1, 0.45] }], surface: 'wood' });
  });
}

/** 木箱堆：大中小三只叠成塔，两条橙色捆扎带从上面勒过去。占地 1.2 × 1.9 × 1.0 米。4 个个体。 */
export function crateStack(o: CargoOpts = {}): PropModel {
  const v = variantOf(o.seed, 4);
  return cached(`crate_stack|${v}${tag(o)}`, () => {
    const k = new Kit('crate_stack', v, { interior: o.interior });
    addCrate(k, 1.2, 0.95, 1, { label: '重物', code: `激战04${v % 2}` });
    // 中间那只：比底下的小一圈，偏着放、转一个角度
    const mid = { x: k.range(-0.1, 0.02), z: k.range(-0.05, 0.05), yaw: (k.rng() < 0.5 ? -1 : 1) * k.range(0.1, 0.16), L: 0.86, W: 0.72 };
    k.at([mid.x, 0.95, mid.z], [0, mid.yaw, 0], () => addCrate(k, mid.L, 0.6, mid.W, { detail: false, skids: false, label: '易碎物品', code: 'B4-204' }));
    const top = { x: mid.x + k.range(-0.05, 0.05), z: mid.z + k.range(-0.04, 0.04), yaw: k.range(-0.12, 0.12), L: 0.55, W: 0.45 };
    k.at([top.x, 1.55, top.z], [0, top.yaw, 0], () => addCrate(k, top.L, 0.35, top.W, { detail: false, skids: false }));

    // 捆扎带在 x 处要绕过一只转了 yaw 的箱子：算出箱子 ±z 那个侧面在这个 x 上的 z 坐标。
    // （箱子自己坐标里侧面是 z = side × halfW 的一条直线；转过 yaw 以后，解出它和"x = 定值"的交点。）
    const sideZ = (x: number, box: { x: number; z: number; yaw: number }, halfW: number, side: number) => {
      const along = (x - box.x - side * halfW * Math.sin(box.yaw)) / Math.cos(box.yaw);
      return box.z - along * Math.sin(box.yaw) + side * halfW * Math.cos(box.yaw);
    };
    for (const x of [-0.2, 0.17]) {
      // 一侧的走法：贴着底箱侧面上去 → 斜拉到中箱的上沿 → 再斜拉到顶箱的上沿；另一侧倒着走回地面
      const up = (side: number): V3[] => [
        [x, 0.09, side * 0.506], [x, 0.956, side * 0.506],
        [x, 1.556, sideZ(x, mid, mid.W / 2, side) + side * 0.006],
        [x, 1.906, sideZ(x, top, top.W / 2, side) + side * 0.006],
      ];
      k.strip('paint_orange', [...up(1), ...up(-1).reverse()], [0.02, 0, 0], { tint: [1, 0.8, 0.5], cast: true });
      // 棘轮扣和它的轴：用包角的那种镀锌钢（省一种材质），轴染深一点
      k.box('steel_galv', 0.06, 0.09, 0.025, x, 0.62, 0.516, { c: 0.006, tint: 0.8 });
      k.tube('steel_galv', [x - 0.035, 0.66, 0.53], [x + 0.035, 0.66, 0.53], 0.008, { seg: 6, cap: true, tint: 0.35 });
    }
    // 碰撞盒一只箱子一个：塔是上小下大的，用一个 1.9 米高的整盒的话，子弹会被顶上小箱子两边的空气挡住。
    // 上面两只是转过角度的，盒子按"转完以后的外包"略放大一点。
    const around = (b: { x: number; z: number; yaw: number; L: number; W: number }, y0: number, y1: number) => {
      const c = Math.abs(Math.cos(b.yaw)), s = Math.abs(Math.sin(b.yaw)), hx = (b.L * c + b.W * s) / 2, hz = (b.L * s + b.W * c) / 2;
      return { min: [b.x - hx, y0, b.z - hz] as V3, max: [b.x + hx, y1, b.z + hz] as V3 };
    };
    return k.finish({
      size: [1.2, 1.9, 1], surface: 'wood',
      boxes: [{ min: [-0.6, 0, -0.5], max: [0.6, 0.95, 0.5] }, around(mid, 0.95, 1.55), around(top, 1.55, 1.9)],
    });
  });
}

// ====================================================================== 吨桶

/** 吨桶（1000 升的方形塑料桶 + 镀锌钢管笼 + 托盘底座），1.2 × 1.16 × 1.0 米。4 个个体，液位各不相同。 */
export function ibcTote(o: CargoOpts = {}): PropModel {
  const v = variantOf(o.seed, 4);
  return cached(`ibc_tote|${v}${tag(o)}`, () => {
    const k = new Kit('ibc_tote', v, { interior: o.interior });
    const zinc = () => k.range(0.75, 1); // 每根钢管、每块垫脚的深浅都不一样

    // ---- 镀锌底座：3 条滑橇、9 个垫脚、一圈边梁、一张托板
    for (const z of [-0.44, 0, 0.44]) k.box('steel_galv', 1.2, 0.028, 0.1, 0, 0.014, z, { plain: true, tint: zinc() });
    for (const x of [-0.54, 0, 0.54]) for (const z of [-0.44, 0, 0.44]) k.box('steel_galv', 0.12, 0.074, 0.1, x, 0.065, z, { c: 0.008, tint: zinc() * 0.85 });
    for (const z of [-0.48, 0.48]) k.box('steel_galv', 1.2, 0.03, 0.04, 0, 0.115, z, { c: 0.006, tint: zinc() });
    for (const x of [-0.58, 0.58]) k.box('steel_galv', 0.04, 0.03, 0.92, x, 0.115, 0, { c: 0.006, tint: zinc() });
    k.box('steel_galv', 1.12, 0.012, 0.92, 0, 0.124, 0, { plain: true, tint: 0.6 });

    // ---- 塑料内胆：1.1 × 0.95 × 0.9 的圆角盒，底面在 y=0.13
    const BW = 1.1, BH = 0.95, BD = 0.9, bottleY = 0.13 + BH / 2;
    const level = 0.13 + BH * k.range(0.45, 0.8); // 液位（世界高度）：桶是半透明的，从外面看得见装了多少
    const bottle = softBox(BW, BH, BD, 0.07, 8, 6, 8);
    {
      // 液位线要清楚，那里就得有顶点。把侧面上离液位最近的两圈网格线挪到液位上下各 3.5 厘米处。
      const pos = bottle.getAttribute('position'), local = level - bottleY, flat = BH / 2 - 0.07 - 1e-4;
      const ys = [...new Set(Array.from({ length: pos.count }, (_, i) => Math.round(pos.getY(i) * 1e4) / 1e4))].filter((y) => Math.abs(y) < flat);
      const [lo, hi] = ys.sort((a, b) => Math.abs(a - local) - Math.abs(b - local)).slice(0, 2).sort((a, b) => a - b);
      for (let i = 0; i < pos.count; i++) {
        const y = Math.round(pos.getY(i) * 1e4) / 1e4;
        if (y === lo) pos.setY(i, local - 0.035); else if (y === hi) pos.setY(i, local + 0.035);
      }
    }
    deform(bottle, (p) => {
      const u = p.x / (BW / 2), t = p.y / (BH / 2), w = p.z / (BD / 2);
      // 四个侧面被里面的液体撑得中间外鼓 16 毫米（越靠近棱越少），顶面中间微鼓、盖子周围又陷下去一点
      if (Math.abs(u) > 0.9) p.x += Math.sign(u) * 0.016 * Math.cos(HALF_PI * t) * Math.cos(HALF_PI * w);
      if (Math.abs(w) > 0.9) p.z += Math.sign(w) * 0.016 * Math.cos(HALF_PI * u) * Math.cos(HALF_PI * t);
      if (t > 0.9) p.y += 0.012 * Math.cos(HALF_PI * u) * Math.cos(HALF_PI * w) - 0.01 * Math.max(0, 1 - Math.hypot(p.x, p.z) / 0.3);
    });
    smoothNormals(bottle);
    const WHITE = 0xd9ddd0, plastic = recolored('plastic_grey', WHITE, o), wob = v * 1.3;
    const red = (mul: number) => toward(0x8e1f1a, WHITE, mul), black = toward(0x17181a, WHITE);
    k.add(plastic, bottle, {
      tint: (x, y, z) => {
        const above = smoothstep(level - 0.03, level + 0.03, y + 0.02 * noise3(x * 3 + wob, z * 3, 0)); // 0 = 液面以下，1 = 以上
        const mottle = 0.9 + 0.1 * noise3(x * 6, y * 6 + wob, z * 6);
        return [mottle * (0.52 + 0.48 * above), mottle * (0.6 + 0.4 * above), mottle * (0.66 + 0.34 * above)]; // 有液体的部分发暗、偏蓝灰
      },
    }, matrixOf([0, bottleY, 0]));
    // 顶盖：盖座 + 红色旋盖 + 一圈 8 个防滑齿
    const topY = 0.13 + BH;
    k.cyl(plastic, 0.125, 0.03, 0, topY + 0.005, 0, { r2: 0.12, seg: 14, tint: 0.9 });
    k.lathe(plastic, [[0.105, 0], [0.105, 0.042], [0.105, 0.042], [0.09, 0.05], [0, 0.05]], 0, topY + 0.015, 0, { seg: 14, tint: red(0.9) });
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      k.box(plastic, 0.012, 0.04, 0.02, Math.cos(a) * 0.108, topY + 0.036, Math.sin(a) * 0.108, { rot: [0, -a, 0], plain: true, tint: red(0.8) });
    }

    // ---- 钢管笼。横管 4 圈 + 顶圈（粗一点），竖管前后每 18.4 厘米一根、两侧每 18 厘米一根，顶上两根横担
    const CX = 0.575, CZ = 0.475, cageBottom = 0.13, cageTop = 1.1, R = 0.011;
    for (const y of [0.2, 0.42, 0.64, 0.86, cageTop]) {
      const r = y === cageTop ? 0.014 : R;
      for (const s of [1, -1]) { // 每根两头各伸出一个半径并封口：转角处两根管子咬在一起，不会露出空心的管口
        k.tube('steel_galv', [-CX - r, y, s * CZ], [CX + r, y, s * CZ], r, { seg: 5, cap: true, tint: zinc() });
        k.tube('steel_galv', [s * CX, y, -CZ - r], [s * CX, y, CZ + r], r, { seg: 5, cap: true, tint: zinc() });
      }
    }
    for (const s of [1, -1]) {
      for (let x = -0.46; x <= 0.461; x += 0.184) k.tube('steel_galv', [x, cageBottom, s * (CZ - 0.012)], [x, cageTop, s * (CZ - 0.012)], R, { seg: 5, tint: zinc() });
      for (let z = -0.36; z <= 0.361; z += 0.18) k.tube('steel_galv', [s * (CX - 0.012), cageBottom, z], [s * (CX - 0.012), cageTop, z], R, { seg: 5, tint: zinc() });
      k.tube('steel_galv', [s * 0.28, cageTop + 0.01, -CZ], [s * 0.28, cageTop + 0.01, CZ], 0.013, { seg: 5, tint: zinc() });
    }

    // ---- 正面的铝标牌，和上面的字
    k.box('aluminium', 0.42, 0.3, 0.004, -0.1, 0.72, CZ + 0.014, { c: 0.0015, tint: 0.85, cast: false });
    const plateZ = CZ + 0.0175, ink: LabelOpts = { color: 'black', font: 'sans', distress: 0.2 };
    text(k, '储液箱 1000 升', ink, 0.36, 0.06, [-0.1, 0.8, plateZ]);
    k.decal(v % 2 ? 'warning' : 'flammable', 0.15, [-0.19, 0.67, plateZ]);
    text(k, 'UN 31HA1/Y', ink, 0.2, 0.04, [0.02, 0.66, plateZ]);

    // ---- 底部出液阀：从 +x 面伸出笼子。黑阀体 + 红盖 + 红把手
    k.tube(plastic, [0.52, 0.2, 0], [0.575, 0.2, 0], 0.05, { seg: 10, cap: true, tint: black });
    k.tube(plastic, [0.575, 0.2, 0], [0.598, 0.2, 0], 0.045, { seg: 10, cap: true, tint: red(0.9) });
    k.box(plastic, 0.02, 0.022, 0.13, 0.55, 0.262, 0.02, { rot: [0, 0.4, 0], c: 0.005, tint: red(0.9) });
    k.cyl(plastic, 0.012, 0.03, 0.55, 0.245, 0, { seg: 6, tint: black });

    return k.finish({ size: [1.2, 1.16, 1], boxes: [{ min: [-0.6, 0, -0.5], max: [0.6, 1.16, 0.5] }], surface: 'metal' });
  });
}

// ====================================================================== 轮胎堆

/**
 * 轮胎的截面轮廓 [半径, 高度]：内孔下沿 → 下胎壁 → 胎面 → 上胎壁 → 回到内孔。
 * R 外半径，W 胎宽，bore 内孔半径。连写两次的点是硬棱（胎肩、内孔边）。最低点正好在高度 0。
 * grooved：胎面中间刻一道沟（多 2 圈三角形）；不刻的话胎面只是中间微微隆起，花纹留给贴图。
 */
function tireProfile(R: number, W: number, bore: number, grooved: boolean): [number, number][] {
  const s = R - bore, groove = Math.min(0.011, s * 0.08);
  const tread: [number, number][] = grooved
    ? [[R, W * 0.14], [R, W * 0.44], [R - groove, W * 0.5], [R, W * 0.56], [R, W * 0.86]]
    : [[R - 0.005, W * 0.14], [R, W * 0.5], [R - 0.005, W * 0.86]];
  const first = tread[0], last = tread[tread.length - 1];
  return [
    [bore, W * 0.15], [bore + s * 0.45, 0], [R - s * 0.1, 0.001], first,
    ...tread,
    last, [R - s * 0.1, W - 0.001], [bore + s * 0.45, W], [bore, W * 0.85],
    [bore, W * 0.85], [bore, W * 0.15],
  ];
}

export interface TireStackOpts extends CargoOpts { /** 摞几只，1–5，默认 4。 */ count?: number }
/** 轮胎堆：外径 0.78 米、宽 0.25 米的轮胎平着摞起来，每只错开一两厘米、转一个随机角度。3 个个体。 */
export function tireStack(o: TireStackOpts = {}): PropModel {
  const v = variantOf(o.seed, 3), count = clamp(Math.round(o.count ?? 4), 1, 5);
  return cached(`tire_stack|${count}|${v}${tag(o)}`, () => {
    const k = new Kit('tire_stack', v, { interior: o.interior });
    // 三角形预算：一两只的时候刻胎面沟；摞得多了就不刻，5 只再把一圈的段数从 16 减到 14，整摞保持在一千二左右
    const seg = count > 4 ? 14 : 16, profile = tireProfile(0.39, 0.25, 0.215, count <= 2);
    for (let i = 0; i < count; i++) {
      const x = i ? k.range(-0.022, 0.022) : 0, z = i ? k.range(-0.022, 0.022) : 0;
      // 转角取"整数个段"：上下两只轮胎的多边形棱角对齐，中间的缝才是一条干净的线，不会出锯齿
      const yaw = (Math.floor(k.rng() * seg) * TAU) / seg;
      const shade = k.range(0.75, 1), wob = i * 3.1;
      k.lathe('tire', profile, x, i * 0.25, z, { // 胎壁贴着胎壁，不互相压进去：压进去的话，错开的那一圈会露出对方的棱角
        seg, rot: [0, yaw, 0],
        tint: (px, _py, pz) => {
          const d = Math.hypot(px - x, pz - z), a = Math.atan2(pz - z, px - x); // 离这只轮胎的轴多远、在哪个方向
          if (d < 0.23) return shade * 0.5; // 内孔一圈照不到光，压暗一半
          return shade * (0.8 + 0.2 * noise3(Math.cos(a) * 3 + wob, Math.sin(a) * 3, d * 30));
        },
      });
    }
    const h = count * 0.25;
    return k.finish({ size: [0.8, h, 0.8], boxes: [{ min: [-0.4, 0, -0.4], max: [0.4, h, 0.4] }], surface: 'rubber' });
  });
}

// ====================================================================== 电缆盘

/**
 * 把一个圆盘切成 n 条竖着的木板（弦向的板条），画在 xy 平面里、朝 +z。
 * 每条板的左、中、右各取一个 x，上下两端落在圆周上 —— 6 个顶点、4 个三角形，板与板之间留 6 毫米的缝。
 */
function chordBoards(R: number, n: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [], w = (2 * R) / n;
  const halfChord = (x: number) => Math.sqrt(Math.max(0, R * R - x * x)); // 圆在 x 处的半弦长；钳到 ≥0 再开方
  for (let i = 0; i < n; i++) {
    const x0 = -R + i * w + 0.003, x1 = -R + (i + 1) * w - 0.003, pos: number[] = [];
    for (const x of [x0, (x0 + x1) / 2, x1]) pos.push(x, -halfChord(x), 0, x, halfChord(x), 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(6).fill([0, 0, 1]).flat(), 3));
    g.setIndex([0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3]);
    out.push(g);
  }
  return out;
}

/** 电缆盘：直径 1.3 米的木盘立着放（轴沿 z），盘芯上绕满黑电缆，一截松开的电缆头甩在地上，两侧板下垫着木楔。3 个个体。 */
export function cableReel(o: CargoOpts = {}): PropModel {
  const v = variantOf(o.seed, 3);
  return cached(`cable_reel|${v}${tag(o)}`, () => {
    const k = new Kit('cable_reel', v, { interior: o.interior });
    const R = 0.65, HALF = 0.4, PLATE = 0.045; // 侧板半径、盘的半宽、侧板厚
    const roll = k.range(-0.5, 0.5);           // 整只盘随机滚过一个角度：木板的缝和喷字不会每只都横平竖直
    k.push([0, R, 0], [0, 0, roll]);
    for (const side of [1, -1]) {
      // 侧板外面：9 条竖板；里面：9 条横板（两层木板十字交叉钉在一起，真的电缆盘就是这么做的）
      for (const g of chordBoards(R - 0.004, 9)) addShifted(k, 'wood_pallet', g, [0, 0, side * (HALF + k.range(0, 0.003))], [0, side > 0 ? 0 : Math.PI, 0], { tint: reelTone(k), grain: 'y' });
      for (const g of chordBoards(R - 0.004, 9)) addShifted(k, 'wood_pallet', g, [0, 0, side * (HALF - PLATE)], [0, side > 0 ? Math.PI : 0, HALF_PI], { tint: reelTone(k, 0.8), grain: 'y' });
      k.cyl('wood_pallet', R, PLATE, 0, 0, side * (HALF - PLATE / 2), { axis: 'z', seg: 24, open: true, tint: reelTone(k, 0.75) }); // 侧板的外缘
      // 两层木板之间垫一块近黑的实心圆盘：木板都是单面的薄片，没有它，从板缝里会直接看穿到盘的另一边
      k.cyl('wood_pallet', R - 0.006, PLATE - 0.005, 0, 0, side * (HALF - PLATE / 2), { axis: 'z', seg: 24, tint: 0.05 });
      k.cyl('steel_galv', 0.105, 0.008, 0, 0, side * (HALF + 0.006), { axis: 'z', seg: 12, tint: 0.5 });   // 中心钢板
      k.cyl('steel_galv', 0.04, 0.004, 0, 0, side * (HALF + 0.0105), { axis: 'z', seg: 10, tint: 0.06 });  // 轴孔：同一种钢染成近黑
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 + 0.3;
        k.cyl('steel_galv', 0.017, 0.014, Math.cos(a) * 0.3, Math.sin(a) * 0.3, side * (HALF + 0.006), { axis: 'z', seg: 6, tint: k.range(0.5, 0.9) });
      }
      text(k, side > 0 ? 'NYY-J 4x95 mm2  500 m' : '激战港区', { color: 'white', font: 'stencil', distress: 0.45 }, 0.7, 0.085, [0, 0.4, side * (HALF + 0.006)], [0, side > 0 ? 0 : Math.PI, 0]);
    }
    k.decal('arrow_up', 0.11, [0.36, -0.2, HALF + 0.006], [0, 0, -1.2 - HALF_PI], 0.2); // 滚动方向的箭头

    // 盘芯上的电缆：16 圈，车削轮廓一高一低地起伏，每圈就是一道凸棱。每圈的亮度用噪声错开，看得出是一圈一圈绕的
    const TURNS = 16, inner = HALF - PLATE, pitch = (2 * inner) / TURNS, coilR = 0.47, coil: [number, number][] = [];
    for (let i = 0; i <= TURNS; i++) {
      coil.push([coilR - 0.017, -inner + i * pitch]);
      if (i < TURNS) coil.push([coilR, -inner + (i + 0.5) * pitch]);
    }
    const wob = v * 0.7;
    k.lathe('rubber', coil, 0, 0, 0, {
      axis: 'z', seg: 20,
      tint: (x, y, z) => { const a = Math.atan2(y - R, x); return 0.7 + 0.5 * noise3(Math.cos(a) * 2 + wob, Math.sin(a) * 2, z * 30); },
    });
    k.pop();

    // 松开的电缆头：贴着盘芯从顶上绕下来，垂到地上，在盘底下拐两个弯，末端一个黄铜接头
    const cz = 0.2, loose: V3[] = [];
    for (let a = 1.9; a >= -0.25; a -= 0.36) loose.push([Math.cos(a) * (coilR + 0.012), R + Math.sin(a) * (coilR + 0.012), cz + (1.9 - a) * 0.02]);
    // 贴地的几个点放在 y=0.028：曲线在两点之间会略微下探，留 8 毫米的余量才不会钻进地面
    loose.push([0.53, 0.3, cz + 0.05], [0.56, 0.09, cz + 0.06], [0.5, 0.03, cz + 0.02], [0.3, 0.028, cz - 0.1], [0.05, 0.028, cz - 0.02], [-0.2, 0.028, cz + 0.06], [-0.38, 0.028, cz - 0.05]);
    k.hose('rubber', loose, 0.02, { seg: 6, steps: 40, tint: 0.9 });
    k.tube('steel_galv', [-0.38, 0.028, cz - 0.05], [-0.41, 0.028, cz - 0.07], 0.014, { seg: 6, cap: true, tint: [0.95, 0.72, 0.3] }); // 黄铜接头：镀锌钢染成铜黄，省一种材质

    // 木楔：每块侧板底下前后各塞一个三角木块，盘才不会滚走
    for (const z of [HALF - PLATE / 2, -(HALF - PLATE / 2)]) {
      k.extrude('wood_pallet', [[0.14, 0], [0.37, 0], [0.37, 0.1]], 0.1, { pos: [0, 0, z], soft: 0, tint: reelTone(k, 0.8) });
      k.extrude('wood_pallet', [[-0.37, 0], [-0.14, 0], [-0.37, 0.1]], 0.1, { pos: [0, 0, z], soft: 0, tint: reelTone(k, 0.8) });
    }
    return k.finish({ size: [1.3, 1.3, 0.8], boxes: [{ min: [-0.65, 0, -0.4], max: [0.65, 1.3, 0.4] }], surface: 'wood' });
  });
}

// ====================================================================== 油壶

// 颜色名 → [材质, 染色]。军绿 = 绿漆压暗并偏黄。
const CAN_PAINT: Record<string, [SurfaceName, Rgb]> = {
  olive: ['paint_green', [0.75, 0.8, 0.45]], red: ['paint_red', [1, 1, 1]], green: ['paint_green', [1, 1, 1]], yellow: ['paint_yellow', [1, 1, 1]], blue: ['paint_blue', [1, 1, 1]],
};
export interface JerryCanOpts extends CargoOpts { color?: 'olive' | 'red' | 'green' | 'yellow' | 'blue' }
/** 20 升扁油壶，0.35 × 0.47 × 0.17 米。太小，没有碰撞。2 个个体。 */
export function jerryCan(o: JerryCanOpts = {}): PropModel {
  const color = o.color ?? 'olive', v = variantOf(o.seed, 2);
  return cached(`jerry_can|${color}|${v}${tag(o)}`, () => {
    const k = new Kit('jerry_can', v, { interior: o.interior });
    const [paint, hue] = CAN_PAINT[color] ?? CAN_PAINT.olive;
    const shade = (mul: number): Rgb => [hue[0] * mul, hue[1] * mul, hue[2] * mul];

    // 壶身：圆角盒，底面在 y=0。靠壶嘴那一侧（x > 0.04）的肩膀削成斜的；两个大面中间微微鼓出 2%
    const body = softBox(0.336, 0.36, 0.156, 0.022, 3, 3, 3).translate(0, 0.18, 0);
    deform(body, (p) => {
      if (p.y > 0.3 && p.x > 0.04) p.y -= (p.x - 0.04) * 0.5;
      if (Math.abs(p.z) > 0.07 && Math.abs(p.x) < 0.14 && p.y > 0.04 && p.y < 0.3) p.z *= 1.02;
    });
    k.add(paint, smoothNormals(body), { tint: shade(1) });
    // 合模缝：壶是两片冲压钢板对焊的，中间留着一圈 7 毫米厚的凸缘。画成壶的侧影再挤出一点厚度
    k.extrude(paint, [[-0.172, 0], [0.172, 0], [0.172, 0.297], [0.045, 0.364], [-0.172, 0.364]], 0.007, { soft: 0, tint: shade(0.8) });
    // 两个大面上的压筋：一个 24 × 20 厘米的方框加两条对角线（薄钢板靠它才不会瘪）
    const RW = 0.24, RH = 0.2, RX = -0.025, RY = 0.165, diag = Math.hypot(RW, RH) - 0.02, slope = Math.atan2(RH, RW);
    for (const side of [1, -1]) {
      const z = side * 0.079;
      for (const e of [1, -1]) {
        k.box(paint, RW, 0.016, 0.007, RX, RY + (e * RH) / 2, z, { plain: true, tint: shade(1) });
        k.box(paint, 0.016, RH, 0.007, RX + (e * RW) / 2, RY, z, { plain: true, tint: shade(1) });
        k.box(paint, diag, 0.018, 0.008, RX, RY, z, { rot: [0, 0, e * slope], plain: true, tint: shade(1) });
      }
    }
    // 三根并排的提手（一个人拎中间那根，两个人抬两边）
    for (const z of [-0.042, 0, 0.042]) k.hose(paint, [[-0.135, 0.35, z], [-0.125, 0.42, z], [-0.09, 0.44, z], [-0.02, 0.44, z], [0.01, 0.42, z], [0.02, 0.35, z]], 0.0105, { seg: 5, steps: 10, tint: shade(1) });
    // 斜出的壶嘴 + 钢盖 + 卡扣。along(t) 是沿壶嘴方向走 t 的点
    const along = (t: number): V3 => [0.1 + 0.42 * t, 0.33 + 0.9 * t, 0];
    k.tube(paint, along(-0.02), along(0.07), 0.03, { seg: 8, cap: true, tint: shade(1) });
    k.tube('steel_dark', along(0.07), along(0.1), 0.036, { seg: 8, cap: true, tint: 0.9 });
    k.box('steel_dark', 0.07, 0.008, 0.02, ...along(0.108), { rot: [0, 0, -0.44], c: 0.002, tint: 1.6 });
    k.decal('flammable', 0.055, [0.125, 0.25, 0.0805]);
    k.decal('flammable', 0.055, [0.125, 0.25, -0.0805], [0, Math.PI, 0]); // 背面也贴在壶嘴这一侧：另一侧被压筋占着
    return k.finish({ size: [0.35, 0.47, 0.17], boxes: [] });
  });
}

// ====================================================================== 路锥

export interface TrafficConeOpts extends CargoOpts { /** 躺倒：锥尖朝 +x，底座的一条边和锥尖着地。 */ lying?: boolean }
/** 路锥：黑橡胶方底座 + 5 段橙白相间的锥身，高 0.7 米。没有碰撞（人和子弹都直接穿过去）。3 个个体。 */
export function trafficCone(o: TrafficConeOpts = {}): PropModel {
  const lying = !!o.lying, v = variantOf(o.seed, 3);
  return cached(`traffic_cone|${lying}|${v}${tag(o)}`, () => {
    const k = new Kit('traffic_cone', v, { interior: o.interior }), wob = v * 4.1;
    // 躺倒的姿势：锥轴倒向 +x，再让锥尖往下栽 0.224 弧度 —— 这个角度正好让"底座的边"和"锥尖"同时碰到地面；
    // 抬高 0.182 米是底座那条边转下去以后离轴心的高度。
    const pose = lying ? matrixOf([-0.33, 0.182, 0], [0, 0, -HALF_PI - 0.224]) : new THREE.Matrix4();
    if (lying) k.push([-0.33, 0.182, 0], [0, 0, -HALF_PI - 0.224]);

    k.box('rubber', 0.36, 0.03, 0.36, 0, 0.015, 0, { c: 0.008, tint: 0.9 });
    // 锥身半径：从 y=0.05 的 0.128 线性收到 y=0.685 的 0.031
    const radius = (y: number) => 0.128 + ((0.031 - 0.128) * (y - 0.05)) / (0.685 - 0.05);
    // 橙色和白色共用一种塑料材质（底色取白），橙色靠顶点色染出来
    const WHITE = 0xc9c9c2, plastic = recolored('plastic_grey', WHITE, o), orange = toward(0xc24f1a, WHITE);
    // 蹭黑的道子：噪声超过 0.68 的地方压到 0.45，其余 0.85–1.0
    // （绕锥身的方向用圆周上的点 (cos, sin) 去取噪声，绕一圈正好接上，不留接缝）
    const scuff = (x: number, y: number, z: number) => {
      const a = Math.atan2(z, x), n = noise3(Math.cos(a) * 3 + wob, Math.sin(a) * 3, y * 14);
      return n > 0.68 ? 0.45 : 0.85 + 0.15 * n;
    };
    const band = (y0: number, y1: number, white: boolean, before: [number, number][] = [], after: [number, number][] = []) =>
      k.add(plastic, latheGeo([...before, [radius(y0), y0], [radius(y1), y1], ...after], 16), {
        tint: inLocal(pose, (x, y, z) => { const s = scuff(x, y, z); return white ? 0.85 * s : [orange[0] * s, orange[1] * s, orange[2] * s]; }),
      });
    band(0.05, 0.36, false, [[0.165, 0.03], [0.15, 0.04], [0.136, 0.05]]); // 最下面一段带一圈裙边
    band(0.36, 0.5, true);
    band(0.5, 0.56, false);
    band(0.56, 0.61, true);
    band(0.61, 0.685, false, [], [[0.028, 0.696], [0.018, 0.7], [0.018, 0.7], [0, 0.7]]); // 顶上收一个小圆头
    if (lying) k.pop();
    return k.finish({ size: lying ? [0.74, 0.36, 0.36] : [0.36, 0.7, 0.36], boxes: [] });
  });
}

// ====================================================================== 登记表

/** 所有货物道具，按参考道具表里的名字登记。摆放的代码可以用名字取：CARGO.barrel({ color: 'red' })。 */
export const CARGO: Record<string, (o?: any) => PropModel> = {
  barrel, pallet, pallet_stack: palletStack, crate_wood: crateWood, crate_stack: crateStack, ibc_tote: ibcTote,
  tire_stack: tireStack, cable_reel: cableReel, jerry_can: jerryCan, traffic_cone: trafficCone,
};
