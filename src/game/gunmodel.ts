import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/math';
import { clayMesh, type Cone, type Groove } from './clay';
import { buildLeftHand, buildRightHand } from './hands';

// 第一人称枪模：M4A1 卡宾枪（平顶机匣 + 四面导轨护木 + 筒式红点），加上握枪的双手。
//
// 建模时用的是"图纸坐标"，单位毫米：
//   u = 沿枪身往前的距离，机匣尾端是 0；y = 高度，枪管轴线是 0；x = 左右，右手边为正。
// 三种造型手段：
//   side  —— 画一个侧面轮廓（u, y），沿左右方向挤出厚度。机匣、握把、弹匣、枪托这类"板状"零件用它。
//   bar   —— 画一个横截面（x, y），沿枪身方向挤出长度。上机匣、护木、导轨用它。
//   lathe —— 画一条半径曲线，绕枪管轴线转一圈。枪管、消焰器、瞄具镜筒用它。
// 挤出时都带一圈倒角：倒角面会单独接住高光，这是"看起来像机加工零件"的主要来源；
// 金属件的倒角面再用顶点色调亮一点，模拟棱边掉漆露出的金属。

type MatKey = 'anod' | 'steel' | 'bright' | 'poly' | 'mag' | 'dark' | 'void' | 'fabric' | 'leather' | 'guard' | 'strap' | 'sleeve' | 'lume';
type P2 = [number, number, number?];       // 轮廓上的一个点；第三个数是这个拐角的圆角半径
export type V3 = [number, number, number]; // [x, y, u]
type Wear = 'x' | 'z' | 'box' | null;

const U0 = 100;                            // 图纸上 u=100 的位置（机匣中段）作为枪模原点
const TILE = 70;                           // 表面纹理每 70 毫米重复一次
/** 枪模在前后方向的拉伸。视图整体还会再压到 0.6，两者相乘是最终的纵深比例。 */
export const DEPTH = 1.4;
/** 红点瞄具光轴高出枪管轴线的距离（米）：开镜时相机对到这条线上。 */
export const SIGHT_Y = 0.066;

const rnd = mulberry32(4107);

function rounded<T extends THREE.Path>(pts: P2[], target: T): T {
  const n = pts.length; let first = true;
  const go = (x: number, y: number) => { if (first) { target.moveTo(x, y); first = false; } else target.lineTo(x, y); };
  for (let i = 0; i < n; i++) {
    const [x, y, r = 0] = pts[i];
    if (r <= 0) { go(x, y); continue; }
    const [px, py] = pts[(i + n - 1) % n], [nx, ny] = pts[(i + 1) % n];
    const l1 = Math.hypot(px - x, py - y), l2 = Math.hypot(nx - x, ny - y), d = Math.min(r, l1 * 0.5, l2 * 0.5);
    go(x + ((px - x) / l1) * d, y + ((py - y) / l1) * d);
    target.quadraticCurveTo(x, y, x + ((nx - x) / l2) * d, y + ((ny - y) / l2) * d);
  }
  target.closePath();
  return target;
}

interface SideOpt { x?: number; bevel?: number; round?: number; holes?: P2[][]; crease?: number }
interface BarOpt { bevel?: number; y?: number; roll?: number; dx?: number; dy?: number; crease?: number }

export class Parts {
  private map = new Map<MatKey, THREE.BufferGeometry[]>();

  /** 收尾：算磨损顶点色、按面朝向投影出贴图坐标、再把平滑的弧面法线抹顺。 */
  private add(mat: MatKey, g0: THREE.BufferGeometry, wear: Wear, crease = 0) {
    let g = g0.index ? g0.toNonIndexed() : g0;
    g.clearGroups();
    const pos = g.getAttribute('position'), n = pos.count;
    const col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3(), e = new THREE.Vector3();
    const worn = 2 + rnd() * 1.6;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
      fn.copy(c).sub(b).cross(e.copy(a).sub(b)).normalize();
      const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
      let k = 1;
      if (wear === 'x' && ax > 0.15 && ax < 0.9) k = worn;
      else if (wear === 'z' && az > 0.15 && az < 0.9) k = worn;
      else if (wear === 'box' && Math.max(ax, ay, az) < 0.9) k = worn;
      for (let j = 0; j < 3; j++) {
        const p = j === 0 ? a : j === 1 ? b : c, o = i + j;
        col[o * 3] = col[o * 3 + 1] = col[o * 3 + 2] = k;
        if (ax >= ay && ax >= az) { uv[o * 2] = p.z / TILE; uv[o * 2 + 1] = p.y / TILE; }
        else if (ay >= az) { uv[o * 2] = p.x / TILE; uv[o * 2 + 1] = p.z / TILE; }
        else { uv[o * 2] = p.x / TILE; uv[o * 2 + 1] = p.y / TILE; }
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (crease > 0) g = toCreasedNormals(g, crease);
    else if (!g.getAttribute('normal')) g.computeVertexNormals();
    let l = this.map.get(mat); if (!l) this.map.set(mat, (l = []));
    l.push(g);
  }

  /** 侧面轮廓（u, y）沿左右方向挤出 w 毫米厚。 */
  side(mat: MatKey, pts: P2[], w: number, o: SideOpt = {}) {
    const bv = Math.min(o.bevel ?? 0.8, w / 2 - 0.05);
    const sh = rounded(pts, new THREE.Shape());
    for (const h of o.holes ?? []) sh.holes.push(rounded(h, new THREE.Path()));
    const g = new THREE.ExtrudeGeometry(sh, { depth: w - bv * 2, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelOffset: -bv, bevelSegments: o.round ?? 1, curveSegments: 5 });
    g.translate(0, 0, -(w - bv * 2) / 2); g.rotateY(Math.PI / 2); g.translate(o.x ?? 0, 0, U0);
    this.add(mat, g, 'x', o.crease ?? 0.5);
  }

  /** 横截面（x, y）沿枪身方向从 u0 挤到 u1。roll 是绕枪管轴线转的角度：导轨装到侧面和底面时用。 */
  bar(mat: MatKey, sec: P2[], u0: number, u1: number, o: BarOpt = {}) {
    const bv = Math.min(o.bevel ?? 0.6, (u1 - u0) / 2 - 0.05);
    const sh = rounded(sec.map(([x, y, r]) => [-x, y, r] as P2), new THREE.Shape());
    const g = new THREE.ExtrudeGeometry(sh, { depth: u1 - u0 - bv * 2, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelOffset: -bv, bevelSegments: 1, curveSegments: 5 });
    g.rotateY(Math.PI); g.translate(0, o.y ?? 0, U0 - u0 - bv);
    if (o.roll) g.rotateZ(o.roll);
    if (o.dx || o.dy) g.translate(o.dx ?? 0, o.dy ?? 0, 0);
    this.add(mat, g, 'z', o.crease ?? 0.5);
  }

  /** 半径曲线 [u, r] 绕轴线转一圈。 */
  lathe(mat: MatKey, pts: [number, number][], y = 0, x = 0, seg = 28) {
    const g = new THREE.LatheGeometry(pts.map(([u, r]) => new THREE.Vector2(r, u)), seg);
    g.rotateX(-Math.PI / 2); g.translate(x, y, U0);
    this.add(mat, g, null, 0.6);
  }

  cyl(mat: MatKey, r: number, len: number, x: number, y: number, u: number, axis: 'x' | 'y' | 'u' = 'u', seg = 16) {
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2); else if (axis === 'u') g.rotateX(Math.PI / 2);
    g.translate(x, y, U0 - u);
    this.add(mat, g, null, 0.6);
  }

  box(mat: MatKey, sx: number, sy: number, su: number, x: number, y: number, u: number, rot?: V3, r?: number) {
    const g = new RoundedBoxGeometry(sx, sy, su, 2, r ?? Math.min(sx, sy, su) * 0.2);
    if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
    g.translate(x, y, U0 - u);
    this.add(mat, g, 'box');
  }

  /** 连接两点的一段圆头柱：手指、手臂。 */
  cap(mat: MatKey, a: V3, b: V3, r: number) {
    const va = new THREE.Vector3(a[0], a[1], U0 - a[2]), v = new THREE.Vector3(b[0], b[1], U0 - b[2]).sub(va), len = v.length();
    const g = new THREE.CapsuleGeometry(r, len, 5, 12);
    g.applyMatrix4(new THREE.Matrix4().compose(va.addScaledVector(v, 0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()), new THREE.Vector3(1, 1, 1)));
    this.add(mat, g, null, 0.9);
  }

  /** 一串关节连成的肢体：相邻关节之间是两头粗细不同的圆台，关节处补一个球。手指、手臂用它。 */
  limb(mat: MatKey, pts: V3[], radii: number[], seg = 12) {
    const w = pts.map(([x, y, u]) => new THREE.Vector3(x, y, U0 - u)), up = new THREE.Vector3(0, 1, 0);
    w.forEach((c, i) => { const g = new THREE.SphereGeometry(radii[i], seg, Math.max(6, seg >> 1)); g.translate(c.x, c.y, c.z); this.add(mat, g, null, 0.9); });
    for (let i = 0; i + 1 < w.length; i++) {
      const v = w[i + 1].clone().sub(w[i]), len = v.length();
      const g = new THREE.CylinderGeometry(radii[i + 1], radii[i], len, seg, 1, true);
      g.applyMatrix4(new THREE.Matrix4().compose(w[i].clone().addScaledVector(v, 0.5), new THREE.Quaternion().setFromUnitVectors(up, v.normalize()), new THREE.Vector3(1, 1, 1)));
      this.add(mat, g, null, 0.9);
    }
  }

  /** 把一组圆头锥融合成一整块连续的表面（见 clay.ts）。手用它。 */
  clay(mat: MatKey, cones: [V3, V3, number, number, number?][], grooves: [V3, V3, number, number][] = [], cell = 2) {
    const w = ([x, y, u]: V3) => new THREE.Vector3(x, y, U0 - u), dir = ([x, y, u]: V3) => new THREE.Vector3(x, y, -u).normalize();
    this.add(mat, clayMesh(cones.map(([a, b, r1, r2, k]) => [w(a), w(b), r1, r2, k] as Cone), grooves.map(([at, d, reach, depth]) => [w(at), dir(d), reach, depth] as Groove), 4.5, cell), null);
  }

  /** 任意朝向的圆角板：along 是长边方向，normal 是厚度方向。护指节、腕带搭扣这类贴在手上的小件用它。 */
  slab(mat: MatKey, c: V3, along: V3, normal: V3, len: number, thick: number, width: number, r: number) {
    const z = new THREE.Vector3(along[0], along[1], -along[2]).normalize(), y = new THREE.Vector3(normal[0], normal[1], -normal[2]);
    y.addScaledVector(z, -y.dot(z)).normalize();
    const g = new RoundedBoxGeometry(width, thick, len, 2, r);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z).setPosition(c[0], c[1], U0 - c[2]));
    this.add(mat, g, null, 0.6);
  }

  /** 任意朝向的短圆柱：axis 是轴线方向。 */
  puck(mat: MatKey, c: V3, axis: V3, r: number, h: number, seg = 16) {
    const g = new THREE.CylinderGeometry(r, r, h, seg);
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(c[0], c[1], U0 - c[2]), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(axis[0], axis[1], -axis[2]).normalize()), new THREE.Vector3(1, 1, 1)));
    this.add(mat, g, null, 0.6);
  }

  /** 一段皮卡汀尼导轨：一条燕尾底座，上面每 10 毫米一个卡齿。 */
  rail(mat: MatKey, u0: number, teeth: number, o: BarOpt, baseFrom = u0 - 2, baseTo = u0 + teeth * 10 - 3) {
    this.bar(mat, [[-7.8, 0], [-7.8, 3.2], [-10.6, 5.6], [-10.6, 6.4], [10.6, 6.4], [10.6, 5.6], [7.8, 3.2], [7.8, 0]], baseFrom, baseTo, { ...o, bevel: 0.4 });
    for (let i = 0; i < teeth; i++)
      this.bar(mat, [[-10.6, 5.6], [-10.6, 7.4], [-8.8, 9.4], [8.8, 9.4], [10.6, 7.4], [10.6, 5.6]], u0 + i * 10, u0 + i * 10 + 4.8, { ...o, bevel: 0.75 });
  }

  into(group: THREE.Object3D, mats: Record<MatKey, THREE.Material>) {
    for (const [k, list] of this.map) {
      const m = new THREE.Mesh(mergeGeometries(list, false), mats[k]);
      m.frustumCulled = false; // 枪贴着相机，包围球裁剪容易误判
      m.receiveShadow = true;  // 走进集装箱的影子里，枪和手也跟着暗下来
      group.add(m);
    }
    return group;
  }
}

/**
 * 表面细纹：返回一张粗糙度图和一张法线图，都能无缝平铺。
 * metal —— 阳极氧化铝：很细的颗粒 + 零星划痕（划痕处更光滑）+ 大块的手摸出来的油光。
 * poly  —— 工程塑料：密密的小凸点，像握把和护木盖板上的防滑纹。
 * weave —— 织物：斜纹布的经纬线。
 * leather —— 皮革：一小块一小块不规则的粒面，块与块之间是细细的纹沟。
 * drops —— 雨水：大小不一的水珠，只用它的法线图，叠在金属外面的那层"水膜"上。
 */
function surface(kind: 'metal' | 'poly' | 'weave' | 'drops' | 'leather') {
  const S = 256, r = mulberry32({ metal: 311, poly: 733, weave: 97, drops: 1543, leather: 409 }[kind]);
  const h = new Float32Array(S * S), rough = new Float32Array(S * S);
  // 低频斑块：8×8 的随机格子做双线性插值
  const G = 8, grid = new Float32Array(G * G).map(() => r());
  const low = (x: number, y: number) => {
    const fx = (x / S) * G, fy = (y / S) * G, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (i: number, j: number) => grid[(j % G) * G + (i % G)];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
  // 皮革的粒面：每个小格子里撒一个点，像素离最近的两个点差不多远的地方就是纹沟
  const GC = 40, cell = S / GC, seeds = kind === 'leather' ? new Float32Array(GC * GC * 2).map(() => r()) : null;
  const grainAt = (x: number, y: number) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell); let f1 = 1e9, f2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = cx + ox, gy = cy + oy, k = (((gy % GC) + GC) % GC * GC + ((gx % GC) + GC) % GC) * 2;
      const d = Math.hypot((gx + seeds![k]) * cell - x, (gy + seeds![k + 1]) * cell - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return Math.min(1, (f2 - f1) / 2.2);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, l = low(x, y);
    if (kind === 'leather') { const g = grainAt(x, y); h[i] = g * 0.8 + r() * 0.08; rough[i] = 0.74 - g * 0.12 + r() * 0.06 - Math.max(0, l - 0.5) * 0.4; }
    else if (kind === 'metal') { h[i] = r() * 0.5; rough[i] = 0.78 + r() * 0.12 - Math.max(0, l - 0.55) * 0.55; }
    else if (kind === 'poly') { h[i] = r() * 0.15; rough[i] = 0.86 + r() * 0.1 - Math.max(0, l - 0.6) * 0.3; }
    else if (kind === 'weave') { h[i] = 0.45 * Math.sin((x + y) * Math.PI / 2) + 0.35 * Math.sin((x - y) * Math.PI / 4) + r() * 0.25; rough[i] = 0.9 + r() * 0.1; }
    else rough[i] = 1;
  }
  if (kind === 'metal') {
    for (let k = 0; k < 46; k++) { // 划痕：沿着大致前后方向的短线
      let x = r() * S, y = r() * S; const ang = (r() - 0.5) * 0.9 + (r() < 0.2 ? 1.57 : 0), len = 12 + r() * 60, dx = Math.cos(ang), dy = Math.sin(ang), deep = 0.3 + r() * 0.5;
      for (let s = 0; s < len; s++) { const i = ((y | 0) & (S - 1)) * S + ((x | 0) & (S - 1)); h[i] -= deep; rough[i] -= 0.3 * deep; x += dx; y += dy; }
    }
  } else if (kind === 'drops') {
    for (let k = 0; k < 170; k++) { // 水珠：半球形的小鼓包，大的少、小的多
      const cx = r() * S, cy = r() * S, rad = 1.6 + r() * r() * 6.5;
      for (let oy = -8; oy <= 8; oy++) for (let ox = -8; ox <= 8; ox++) {
        const d = Math.hypot(ox, oy) / rad; if (d > 1) continue;
        const i = (((cy + oy) | 0) & (S - 1)) * S + (((cx + ox) | 0) & (S - 1));
        h[i] = Math.max(h[i], Math.sqrt(1 - d * d) * rad * 0.42);
      }
    }
  } else if (kind === 'poly') {
    for (let k = 0; k < 3400; k++) { // 防滑凸点
      const cx = r() * S, cy = r() * S, rad = 1.3 + r() * 1.3;
      for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
        const d = Math.hypot(ox, oy) / rad; if (d > 1) continue;
        h[(((cy + oy) | 0) & (S - 1)) * S + (((cx + ox) | 0) & (S - 1))] += (1 - d * d) * 0.9;
      }
    }
  }
  const mk = (fill: (i: number, x: number, y: number, d: Uint8ClampedArray) => void) => {
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d')!, img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) fill((y * S + x) * 4, x, y, img.data);
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  };
  const H = (x: number, y: number) => h[(y & (S - 1)) * S + (x & (S - 1))];
  const k = kind === 'metal' ? 1.2 : kind === 'weave' ? 1.3 : 1.6;
  const normalMap = mk((o, x, y, d) => {
    const nx = (H(x - 1, y) - H(x + 1, y)) * k, ny = (H(x, y - 1) - H(x, y + 1)) * k, l = Math.hypot(nx, ny, 1);
    d[o] = (nx / l * 0.5 + 0.5) * 255; d[o + 1] = (-ny / l * 0.5 + 0.5) * 255; d[o + 2] = (1 / l * 0.5 + 0.5) * 255; d[o + 3] = 255;
  });
  const roughnessMap = mk((o, x, y, d) => { d[o] = d[o + 1] = d[o + 2] = Math.min(1, Math.max(0.2, rough[y * S + x])) * 255; d[o + 3] = 255; });
  return { normalMap, roughnessMap };
}

/** 作战服的迷彩：土黄底色上叠几层不规则的色块。 */
function camo() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, r = mulberry32(5521);
  g.fillStyle = '#7d775a'; g.fillRect(0, 0, S, S);
  for (const [color, count, size] of [['#56603f', 26, 34], ['#6a563c', 20, 26], ['#a39a74', 18, 22], ['#3b4230', 16, 15]] as [string, number, number][]) {
    g.fillStyle = color;
    for (let k = 0; k < count; k++) {
      const cx = r() * S, cy = r() * S, rx = size * (0.5 + r()), ry = size * (0.25 + r() * 0.5), rot = r() * 3.14;
      // 每个色块在四周各画一份，保证贴图能无缝平铺
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        g.beginPath();
        for (let i = 0; i <= 14; i++) { const a = (i / 14) * 6.283, kk = 1 + Math.sin(a * 3 + k) * 0.28 + Math.sin(a * 5 + k * 2) * 0.16; const px = Math.cos(a) * rx * kk, py = Math.sin(a) * ry * kk; g.lineTo(cx + ox + px * Math.cos(rot) - py * Math.sin(rot), cy + oy + px * Math.sin(rot) + py * Math.cos(rot)); }
        g.closePath(); g.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  t.repeat.set(TILE / 190, TILE / 190);
  return t;
}

const FONT = '"Arial Narrow","Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
function label(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(196,198,196,0.82)'; g.textBaseline = 'middle';
  draw(g);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
/** 贴在机匣左侧的一块刻字。 */
function engraving(tex: THREE.Texture, w: number, h: number, x: number, y: number, u: number, roll = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.55, metalness: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  m.rotation.y = -Math.PI / 2; m.position.set(x, y, U0 - u); m.frustumCulled = false;
  if (roll) m.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll)); // 贴在斜面上时绕枪身轴线转一下
  return m;
}

export function buildGun() {
  const metal = surface('metal'), grain = surface('poly'), hide = surface('leather'), weave = surface('weave').normalMap, drops = surface('drops').normalMap;
  weave.repeat.set(2.5, 2.5); drops.repeat.set(1.5, 1.5);
  const ns = (k: number) => new THREE.Vector2(k, k);
  // 下着雨：枪身外面裹一层清漆层当"水膜"，水膜上用水珠法线图鼓出一颗颗雨滴，路灯照上去会有零星的亮点
  const wet = { clearcoat: 0.55, clearcoatRoughness: 0.18, clearcoatNormalMap: drops, clearcoatNormalScale: ns(1.4) };
  const mats: Record<MatKey, THREE.Material> = {
    // 机匣、护木：硬质阳极氧化铝，深灰偏黑，半哑光
    anod: new THREE.MeshPhysicalMaterial({ color: 0x3b3e43, roughness: 0.52, metalness: 0.82, vertexColors: true, ...metal, normalScale: ns(0.06), envMapIntensity: 1.6, ...wet }),
    // 枪管、准星座：磷化钢，更灰更糙
    steel: new THREE.MeshPhysicalMaterial({ color: 0x505356, roughness: 0.58, metalness: 0.88, vertexColors: true, ...metal, normalScale: ns(0.1), envMapIntensity: 1.5, ...wet }),
    bright: new THREE.MeshStandardMaterial({ color: 0x8b9095, roughness: 0.32, metalness: 0.95, envMapIntensity: 1.3 }),
    poly: new THREE.MeshPhysicalMaterial({ color: 0x1c1d1f, roughness: 0.74, metalness: 0, ...grain, normalScale: ns(0.32), envMapIntensity: 1.3, ...wet, clearcoat: 0.4 }),
    // 弹匣：铝制灰色涂层，磨损最重
    mag: new THREE.MeshPhysicalMaterial({ color: 0x64676a, roughness: 0.55, metalness: 0.8, vertexColors: true, ...metal, normalScale: ns(0.1), envMapIntensity: 1.5, ...wet }),
    dark: new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95, metalness: 0 }),
    void: new THREE.MeshBasicMaterial({ color: 0x020203, fog: false }), // 孔洞内部：不受任何灯光影响的纯黑
    // 手套：黑色皮革。细密的皮纹 + 中等粗糙度，路灯下会有一条柔和的高光；外面同样裹一层带水珠的水膜
    fabric: new THREE.MeshPhysicalMaterial({ color: 0x161617, roughness: 0.9, roughnessMap: hide.roughnessMap, metalness: 0, normalMap: hide.normalMap, normalScale: ns(0.55), envMapIntensity: 1.5, ...wet, clearcoat: 0.3 }),
    // 虎口和掌根的加厚补强：同样是黑皮，更哑一些
    leather: new THREE.MeshStandardMaterial({ color: 0x0e0e0f, roughness: 0.72, metalness: 0, normalMap: grain.normalMap, normalScale: ns(0.3), envMapIntensity: 1.1 }),
    guard: new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.42, metalness: 0.05, envMapIntensity: 1.3 }),
    strap: new THREE.MeshStandardMaterial({ color: 0x1d1e1d, roughness: 0.92, metalness: 0, normalMap: weave, normalScale: ns(0.7) }),
    sleeve: new THREE.MeshStandardMaterial({ map: camo(), roughness: 0.95, metalness: 0, normalMap: weave, normalScale: ns(0.5) }),
    lume: new THREE.MeshStandardMaterial({ color: 0x0a1814, emissive: 0x35d0a8, emissiveIntensity: 0.55, roughness: 0.4 }),
  };
  const gun = new THREE.Group();
  const inner = new THREE.Group(); inner.scale.set(0.001, 0.001, 0.001 * DEPTH); gun.add(inner);
  const p = new Parts();

  // ================= 上机匣（平顶）
  p.bar('anod', [[-13, -17], [-15, -14], [-15, 7], [-9.5, 19], [9.5, 19], [15, 7], [15, -14], [13, -17]], 0, 197, { bevel: 1 });
  p.rail('anod', 4, 19, { y: 19 }, 1, 196);
  p.box('anod', 1.6, 11, 74, -15.2, -5, 112, undefined, 0.7);                 // 左侧加强筋
  p.box('anod', 1.6, 9, 22, -15.2, -4, 20, undefined, 0.7);
  // 右侧：抛壳窗（打开的防尘盖垂在下面）、弹壳导向凸台、复进助推器
  p.box('void', 0.8, 17, 60, 15.1, 1, 110, undefined, 0.3);
  p.box('anod', 2.2, 17, 58, 18, -19, 110, [0, 0, 0.45], 0.8);
  p.side('anod', [[52, -9], [70, -9], [63, 9, 2], [52, 9]], 7, { x: 16, bevel: 1.5 });
  p.cyl('anod', 5.2, 18, 17.5, 3, 24, 'u');
  p.cyl('steel', 6.6, 3, 17.5, 3, 13.5, 'u');

  // ================= 下机匣
  p.side('anod', [[-12, -17], [197, -17], [197, -42, 2], [192, -82, 3], [130, -73, 3], [127, -48, 2], [58, -48], [42, -52, 3], [18, -50, 4], [-12, -36, 6]], 24, { bevel: 1 });
  p.side('anod', [[131, -21, 2], [196, -21, 2], [196, -42], [191.5, -81, 3], [131, -72.5, 3]], 27.5, { bevel: 1.2 }); // 弹匣井外壁略厚一圈
  p.side('anod', [[128, -70], [128, -73.2], [57, -72], [57, -68.8]], 11, { bevel: 0.6 });                              // 扳机护圈
  p.side('steel', [[100, -48], [106, -48], [103, -58, 3], [107, -67, 1], [103.5, -68.5, 1], [97.5, -58, 3]], 6, { bevel: 0.8 }); // 扳机
  for (const [u, y, r] of [[14, -26, 3.6], [187, -28, 3.6], [78, -30, 2.1], [99, -37, 2.1]]) p.cyl('bright', r, u > 150 ? 28.6 : 25, 0, y, u, 'x'); // 四根销
  // 左侧操作件：快慢机（拨在全自动）、空仓挂机、弹匣卡笋
  p.cyl('steel', 5.6, 3.4, -13, -28, 47, 'x');
  p.box('steel', 3.2, 4.6, 16, -15.4, -28, 38.5, undefined, 1.4);
  p.box('steel', 3, 15, 8, -14.6, -13, 139, undefined, 1);
  p.box('steel', 4.2, 10, 12, -15, -25, 139, undefined, 1.2);
  for (let i = 0; i < 4; i++) p.box('dark', 0.6, 0.9, 10, -17.1, -21.6 - i * 2.2, 139);
  p.box('steel', 2.6, 6, 22, -13.8, -36, 124, undefined, 1);
  // 右侧：弹匣释放钮
  p.cyl('steel', 4.6, 3.4, 13.6, -34, 122, 'x');
  // 缓冲管座、城堡螺母、缓冲管
  p.lathe('anod', [[-13, 0], [-13, 16.5], [-12, 17.2], [6, 17.2], [7, 16], [7, 14]]);
  p.lathe('steel', [[-25, 14.6], [-25, 17.6], [-13.6, 17.6], [-13.6, 14.6]]);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283 + 0.5; p.box('dark', 4.4, 1.2, 5, -Math.sin(a) * 17.5, Math.cos(a) * 17.5, -22.6, [0, 0, a], 0.3); }
  p.lathe('anod', [[-196, 0], [-196, 14.6], [-13, 14.6]]);

  // ================= 握把（A2 式，带指间凸起）
  p.side('poly', [[57, -46], [60, -53, 2], [50, -80, 4], [53, -90, 3], [28, -143, 5], [-4, -135, 6], [13, -76, 10], [9, -54, 6], [18, -46, 2]], 27, { bevel: 4, round: 3, crease: 0.9 });

  // ================= 枪托（伸缩托收到最短）
  p.side('poly', [[-24, 18, 3], [-186, 18, 4], [-193, 10, 3], [-191, -98, 4], [-176, -104, 4], [-74, -30, 6], [-24, -22, 4]], 36,
    { bevel: 3, round: 2, crease: 0.9, holes: [[[-176, -84, 3], [-176, -50, 3], [-128, -50, 3]]] });
  p.box('poly', 14, 8, 36, 0, -27, -50, undefined, 2.5);

  // ================= 护木：四面导轨（两侧和底面装了带横纹的导轨盖板）
  p.lathe('anod', [[197, 16], [199, 19], [204, 19], [206, 21.5], [221, 26.5], [225, 26.5], [226, 23]]);      // 护木箍
  p.bar('anod', [[-21, -13], [-21, 7], [-9, 19], [9, 19], [21, 7], [21, -13], [9, -25], [-9, -25]], 226, 395, { bevel: 1.2 });
  p.rail('anod', 234, 16, { y: 19 }, 228, 394);
  const sides: BarOpt[] = [{ y: 21, roll: Math.PI / 2, dy: -3 }, { y: 21, roll: -Math.PI / 2, dy: -3 }, { y: 25, roll: Math.PI }];
  for (const o of sides) {
    p.rail('anod', 354, 4, o, 228, 394);
    p.bar('poly', [[-12, 1.5], [-12, 9.5, 2.5], [12, 9.5, 2.5], [12, 1.5]], 236, 350, { ...o, bevel: 1.2 });
    for (let i = 0; i < 11; i++) p.bar('poly', [[-12, 9], [-12, 11.6, 1.2], [12, 11.6, 1.2], [12, 9]], 240 + i * 10, 245.5 + i * 10, { ...o, bevel: 0.9 });
  }
  // 四个斜面上的散热孔
  for (const [cx, cy, a] of [[-15, 13, 0.785], [15, 13, -0.785], [-15, -19, 2.356], [15, -19, -2.356]])
    for (let i = 0; i < 7; i++) p.box('dark', 5.6, 0.8, 13, cx - Math.sin(a) * 0.15, cy + Math.cos(a) * 0.15, 246 + i * 22, [0, 0, a], 0.3);

  // ================= 枪管、准星座、消焰器
  p.lathe('steel', [[393, 9.5], [452, 9.5], [454, 8], [492, 8], [494, 9.5], [549, 9.5], [549, 11.2], [552.5, 11.2], [552.5, 9]]);
  p.lathe('steel', [[552.5, 9], [555, 11], [592, 11], [597, 10], [597, 6.2], [588, 6.2]]);
  p.cyl('void', 6.2, 1, 0, 0, 588.5, 'u');
  for (const a of [-1.256, -0.628, 0, 0.628, 1.256]) p.box('dark', 3.4, 0.9, 22, -Math.sin(a) * 10.9, Math.cos(a) * 10.9, 575, [0, 0, a], 0.3);
  p.lathe('steel', [[400, 9], [400, 13.2], [410.5, 13.2], [410.5, 9]]);
  p.lathe('steel', [[419, 9], [419, 13.2], [429.5, 13.2], [429.5, 9]]);
  p.side('steel', [[400, 6], [429.5, 6], [427, 30], [424, 47, 1], [424, 58], [408, 58], [408, 47, 1], [402.5, 30]], 11, { bevel: 1, holes: [[[408, 14], [423, 14], [419.5, 36, 1], [411.5, 36, 1]]] });
  for (const s of [-1, 1]) p.box('steel', 2.6, 15, 14, s * 4.4, 64, 416, undefined, 1.1);                    // 护翼
  p.cyl('steel', 1.1, 9, 0, 61.5, 416, 'y', 8);                                                              // 准星柱
  p.box('steel', 8, 7, 16, 0, -14, 414, undefined, 1.5);                                                     // 刺刀座
  p.cyl('steel', 2.4, 40, 0, 15.5, 396, 'u', 8);                                                             // 导气管

  // ================= 红点瞄具（筒式）和它的座
  const SY = SIGHT_Y * 1000;
  p.lathe('anod', [[95, 19.5], [96.5, 22], [110, 22], [113, 19.2], [137, 19.2], [140, 22], [153.5, 22], [155, 19.5]], SY, 0, 36);
  p.lathe('void', [[155, 19.5], [155, 17.6], [153, 17], [97, 17], [95, 17.6], [95, 19.5]], SY, 0, 36);   // 镜筒内壁做成消光黑
  p.box('anod', 26, 10, 40, 0, 30, 125, undefined, 1.6);                       // 夹在导轨上的底座
  p.side('anod', [[112, 34], [138, 34], [134, 47, 2], [116, 47, 2]], 14, { bevel: 1.5 });
  p.lathe('anod', [[116, 19], [116, 22.6], [117.5, 23.6], [132.5, 23.6], [134, 22.6], [134, 19]], SY, 0, 36); // 抱箍
  p.cyl('steel', 7.6, 7, -16.5, 30, 125, 'x', 12);                             // 底座的锁紧旋钮
  p.cyl('anod', 6.6, 7, 0, SY + 26, 125, 'y');                                 // 上：高低调节
  p.cyl('bright', 2, 1, 0, SY + 29.6, 125, 'y', 10);
  p.cyl('anod', 6.6, 7, 26, SY, 125, 'x');                                     // 右：风偏调节
  p.cyl('anod', 8.5, 8, -24, SY - 6, 103, 'x', 20);                            // 左前：亮度旋钮
  p.cyl('steel', 9.4, 3, -29, SY - 6, 103, 'x', 12);
  // 折叠起来的机械照门
  p.box('anod', 25, 8.5, 22, 0, 29.5, 18, undefined, 1.4);
  p.box('anod', 12, 4.4, 22, 0, 35.6, 22, undefined, 1.2);
  for (const sx of [-1, 1]) p.box('anod', 3, 6, 9, sx * 8.5, 35.6, 12, undefined, 1);
  p.cyl('steel', 4.6, 5, 14.5, 30, 12, 'x', 12);

  // ================= 垂直前握把：夹在护木底面导轨上
  p.box('poly', 31, 13, 44, 0, -41, 313, undefined, 3);
  p.cyl('steel', 4, 34, 0, -41, 313, 'x', 10);
  p.cyl('poly', 15, 78, 0, -86, 313, 'y', 20);
  for (let i = 0; i < 5; i++) p.cyl('poly', 15.9, 3.2, 0, -62 - i * 12, 313, 'y', 20);
  p.cyl('poly', 17.2, 7, 0, -125, 313, 'y', 20);
  p.cyl('steel', 9, 1.2, 0, -129, 313, 'y', 14);

  // ================= 战术手电：装在护木左侧导轨的前端，按 F 开关
  const LX = -49, LY = -3;
  p.box('anod', 9, 22, 30, -36.5, LY, 368, undefined, 1.5);
  p.cyl('steel', 4.6, 5, -36.5, LY + 13, 368, 'y', 10);
  p.lathe('anod', [[338, 0], [338, 9.5], [341, 11.5], [352, 11.5], [353.5, 10.6], [356, 10.6], [357.5, 11.5], [378, 11.5], [381, 13.5], [384, 15.5], [402, 15.5], [404, 14.4], [404, 12.6], [400, 12.6]], LY, LX, 24);
  for (const u of [360, 364.5, 369, 373.5]) p.lathe('steel', [[u, 11.5], [u, 12.3], [u + 2.2, 12.3], [u + 2.2, 11.5]], LY, LX, 24);
  p.cyl('guard', 7, 3, LX, LY, 336.6, 'u');                                    // 尾部的橡胶开关
  p.cyl('bright', 12.6, 1, LX, LY, 400, 'u', 20);                              // 反光杯

  buildRightHand(p);
  p.into(inner, mats);

  // ---- 刻字：弹匣井左侧的型号，快慢机旁的三个挡位
  inner.add(engraving(label(320, 160, (g) => {
    g.font = `700 44px ${FONT}`; g.fillText('M4A1 CARBINE', 8, 30);
    g.font = `600 26px ${FONT}`; g.fillText('CAL 5.56 MM', 8, 76); g.fillText('激战兵工厂', 8, 112);
    g.font = `600 22px ${FONT}`; g.fillText('JZ 042719', 8, 142);
  }), 46, 23, -13.9, -46, 164));
  inner.add(engraving(label(256, 128, (g) => {
    g.font = `700 30px ${FONT}`; g.fillText('SAFE', 6, 92); g.fillText('SEMI', 92, 22); g.fillText('AUTO', 176, 92);
  }), 40, 20, -12.2, -27, 48));
  // 上机匣左侧斜面上的导轨槽位编号
  inner.add(engraving(label(1024, 28, (g) => {
    g.font = `700 22px ${FONT}`; g.textAlign = 'center';
    for (let i = 0; i < 9; i++) g.fillText(`T${18 - i * 2}`, 1024 * (i + 0.5) / 9, 15);
  }), 180, 4.6, -12.4, 13.1, 99, -0.43));

  // ---- 枪机：开火时在抛壳窗里往后一缩
  const bolt = new THREE.Group();
  const pb = new Parts(); pb.box('bright', 0.6, 13, 38, 15.6, 1, 119, undefined, 0.25); pb.into(bolt, mats);
  inner.add(bolt);
  // ---- 拉机柄：机匣尾部上方的 T 形手柄
  const handle = new THREE.Group();
  const ph = new Parts(); ph.box('anod', 46, 6.5, 8, 0, 20.8, -9, undefined, 1.6); ph.box('anod', 14, 6.5, 10, 0, 20.8, -4, undefined, 1.4); ph.box('steel', 9, 5, 9, -17.5, 20.8, -9.6, undefined, 1.2); ph.into(handle, mats);
  inner.add(handle);

  // ---- 弹匣：30 发铝弹匣，上半段直、下半段向前弯
  const mag = new THREE.Group();
  const pm = new Parts();
  pm.side('mag', [[188.5, -25], [187.5, -105, 6], [197, -176, 2], [136, -189, 2], [127.5, -105, 8], [129, -25]], 22, { bevel: 1.2 });
  for (const s of [-1, 1]) for (const du of [0, 21]) pm.side('mag', [[146 + du, -84], [150 + du, -84], [150 + du, -106, 3], [159.5 + du, -180], [155.5 + du, -181], [146 + du, -106, 3]], 1.4, { x: s * 11.3, bevel: 0.5 });
  pm.side('poly', [[133, -185.5], [199, -172.5], [200.5, -178, 1.5], [134, -192, 1.5]], 25, { bevel: 1 });
  pm.into(mag, mats);
  inner.add(mag);

  // ---- 左手：托住护木，换弹时会离开去拿弹匣
  const left = new THREE.Group();
  const pl = new Parts();
  buildLeftHand(pl);
  pl.into(left, mats);
  inner.add(left);

  // ---- 瞄具镜片和红点
  const lens = new THREE.Mesh(new THREE.CircleGeometry(17, 28), new THREE.MeshStandardMaterial({ color: 0x4a6a80, transparent: true, opacity: 0.14, metalness: 1, roughness: 0.05, depthWrite: false, envMapIntensity: 2 }));
  lens.position.set(0, SY, U0 - 98); inner.add(lens);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 0.6, 0.3), depthTest: false, fog: false }));
  dot.position.set(0, SY, U0 - 150); dot.renderOrder = 20; dot.visible = false; inner.add(dot);

  const muzzleZ = -(597 - U0) * 0.001 * DEPTH;
  const lightPos = new THREE.Vector3(LX * 0.001, LY * 0.001, -(404 - U0) * 0.001 * DEPTH);
  return { gun, mag, bolt, handle, left, dot, muzzleZ, lightPos };
}
