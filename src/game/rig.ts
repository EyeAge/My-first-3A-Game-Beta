import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clayMesh, type Cone } from './clay';

// 骨骼蒙皮模型的搭建工具。
//
// 思路：先声明一棵骨骼树（每根骨骼给出它在"绑定姿势"下的关节位置），
// 再往骨骼上挂零件（圆角盒、圆柱、球）。所有零件最后合并成一个几何体，
// 每个顶点记下自己跟着哪根骨骼动（skinIndex / skinWeight）。
// 运行时只要转动骨骼，显卡就会把顶点带着一起动——这就是骨骼动画。

export type MatKey = 'body' | 'accent' | 'dark' | 'steel' | 'eye' | 'glow' | 'blur';
const MAT_ORDER: MatKey[] = ['body', 'accent', 'dark', 'steel', 'eye', 'glow', 'blur'];

interface BoneDef { name: string; parent: number; x: number; y: number; z: number }
export interface RigDef { geometry: THREE.BufferGeometry; bones: BoneDef[]; mats: MatKey[] }
export interface Rig { mesh: THREE.SkinnedMesh; bones: Record<string, THREE.Bone> }

type V3 = [number, number, number];
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _one = new THREE.Vector3(1, 1, 1);

export class RigBuilder {
  private bones: BoneDef[] = [];
  private parts = new Map<MatKey, THREE.BufferGeometry[]>();

  /** 声明一根骨骼。坐标是模型空间里的关节位置（不是相对父骨骼的偏移）。 */
  bone(name: string, parent: string | null, x: number, y: number, z: number) {
    const p = parent === null ? -1 : this.index(parent);
    this.bones.push({ name, parent: p, x, y, z });
  }
  private index(name: string) {
    const i = this.bones.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`未声明的骨骼：${name}`);
    return i;
  }

  private push(bone: string, mat: MatKey, geo: THREE.BufferGeometry) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    const n = g.attributes.position.count, idx = this.index(bone);
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = idx; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
  }

  /** 圆角盒。圆角让边缘能接住高光，比直角盒子"像个零件"。 */
  box(bone: string, mat: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, rot?: V3, radius?: number) {
    const g = new RoundedBoxGeometry(sx, sy, sz, 2, radius ?? Math.min(sx, sy, sz) * 0.2);
    if (rot) g.applyMatrix4(_m.makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
    g.translate(x, y, z);
    this.push(bone, mat, g);
  }
  /** 圆柱。axis 是它的轴向；r2 是另一端的半径（可以做成锥形）。 */
  cyl(bone: string, mat: MatKey, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', r2 = r) {
    const g = new THREE.CylinderGeometry(r2, r, len, 12);
    if (axis === 'x') g.rotateZ(-Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.push(bone, mat, g);
  }
  sph(bone: string, mat: MatKey, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) {
    const g = new THREE.SphereGeometry(r, 14, 10);
    g.scale(sx, sy, sz); g.translate(x, y, z);
    this.push(bone, mat, g);
  }
  /** 连接 a、b 两点的一段肢体（宽 w、厚 d 的圆角盒）。 */
  seg(bone: string, mat: MatKey, a: V3, b: V3, w: number, d = w) {
    _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _v.length();
    const g = new RoundedBoxGeometry(w, len + Math.min(w, d) * 0.4, d, 2, Math.min(w, d) * 0.25);
    _q.setFromUnitVectors(_up, _v.normalize());
    g.applyMatrix4(_m.compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _one));
    this.push(bone, mat, g);
  }

  /**
   * 融合外壳：把几段圆头锥"捏"成一整块连续的曲面（见 clay.ts）。机体的主要体块都用它，
   * 这样胸、肩、腹之间是顺着过渡的弧面，而不是几个盒子硬拼在一起。
   * 贴图坐标按"面朝哪个方向就从哪个方向投影"来铺，装甲板贴图每 0.45 米重复一次，重复的接缝正好当板缝。
   */
  clay(bone: string, mat: MatKey, cones: [V3, V3, number, number, number?][], blend = 0.035, cell = 0.022) {
    const g = clayMesh(cones.map(([a, b, r1, r2, k]) => [new THREE.Vector3(...a), new THREE.Vector3(...b), r1, r2, k] as Cone), [], blend, cell);
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = new Float32Array(pos.count * 2), T = 0.45;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
      if (ax >= ay && ax >= az) { uv[i * 2] = pos.getZ(i) / T; uv[i * 2 + 1] = pos.getY(i) / T; }
      else if (ay >= az) { uv[i * 2] = pos.getX(i) / T; uv[i * 2 + 1] = pos.getZ(i) / T; }
      else { uv[i * 2] = pos.getX(i) / T; uv[i * 2 + 1] = pos.getY(i) / T; }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.push(bone, mat, g);
  }
  /**
   * 薄板：俯视轮廓（[x, z] 一圈点）往下压出 thick 厚，上表面在高度 y。边缘带一点倒角。
   * 翅膀和尾羽用它 —— 轮廓可以剪出一根根羽毛的形状，比一块长方形的板像翅膀得多。
   */
  plate(bone: string, mat: MatKey, pts: [number, number][], y: number, thick: number) {
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
    const bv = thick * 0.3;
    const g = new THREE.ExtrudeGeometry(sh, { depth: thick - bv * 2, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelOffset: -bv, bevelSegments: 1 });
    g.rotateX(Math.PI / 2); g.translate(0, y - bv, 0);
    const uv = g.getAttribute('uv'); for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 0.45, uv.getY(i) / 0.45);
    this.push(bone, mat, g);
  }
  /** 车削件：侧面轮廓 [半径, 高度] 绕竖轴转一圈。旋翼的涵道环用它。 */
  lathe(bone: string, mat: MatKey, prof: [number, number][], x: number, y: number, z: number, seg = 24) {
    const g = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), seg);
    g.translate(x, y, z);
    this.push(bone, mat, g);
  }
  /** 连接 a、b 两点的一根圆管。 */
  tube(bone: string, mat: MatKey, a: V3, b: V3, r: number, r2 = r) {
    _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const g = new THREE.CylinderGeometry(r2, r, _v.length(), 8);
    _q.setFromUnitVectors(_up, _v.normalize());
    g.applyMatrix4(_m.compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _one));
    this.push(bone, mat, g);
  }
  /** 液压杆：粗的缸筒从 a 伸出一半，细的活塞杆一直顶到 b，两头各一个耳环。 */
  piston(bone: string, a: V3, b: V3, r: number) {
    const mid: V3 = [a[0] + (b[0] - a[0]) * 0.58, a[1] + (b[1] - a[1]) * 0.58, a[2] + (b[2] - a[2]) * 0.58];
    this.tube(bone, 'dark', a, mid, r); this.tube(bone, 'steel', mid, b, r * 0.55);
    this.sph(bone, 'dark', r * 1.25, ...a); this.sph(bone, 'dark', r * 1.1, ...b);
  }
  /** 线缆：沿着几个点一段一段接起来的细管，接头处垫个小球把折角盖住。 */
  cable(bone: string, pts: V3[], r: number) {
    for (let i = 0; i + 1 < pts.length; i++) { this.tube(bone, 'dark', pts[i], pts[i + 1], r); if (i) this.sph(bone, 'dark', r * 1.05, ...pts[i]); }
  }
  /** 螺栓头：一个扁的六角柱。axis 是它朝外的方向。 */
  bolt(bone: string, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', r = 0.022) {
    const g = new THREE.CylinderGeometry(r, r, r * 0.9, 6);
    if (axis === 'x') g.rotateZ(-Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.push(bone, 'steel', g);
  }

  build(): RigDef {
    const mats = MAT_ORDER.filter((k) => this.parts.has(k));
    // 同一种材质的零件先并成一块，再把几块并起来，每块是一个材质分组（一次绘制调用）
    const geometry = mergeGeometries(mats.map((k) => mergeGeometries(this.parts.get(k)!, false)), true);
    return { geometry, bones: this.bones, mats };
  }
}

/** 按定义实例化一副骨架和蒙皮网格。几何体共享，骨骼每个敌人各有一套。 */
export function instantiate(def: RigDef, materials: Record<MatKey, THREE.Material>): Rig {
  const list = def.bones.map((b) => { const bone = new THREE.Bone(); bone.name = b.name; return bone; });
  const bones: Record<string, THREE.Bone> = {};
  const mesh = new THREE.SkinnedMesh(def.geometry, def.mats.map((k) => materials[k]));
  def.bones.forEach((b, i) => {
    const p = b.parent >= 0 ? def.bones[b.parent] : null;
    list[i].position.set(b.x - (p ? p.x : 0), b.y - (p ? p.y : 0), b.z - (p ? p.z : 0));
    if (p) list[b.parent].add(list[i]); else mesh.add(list[i]);
    list[i].userData.rest = list[i].position.clone();
    bones[b.name] = list[i];
  });
  // 绑定姿势下骨骼都没有旋转，所以"逆绑定矩阵"就是把关节位置平移回原点
  const inverses = def.bones.map((b) => new THREE.Matrix4().makeTranslation(-b.x, -b.y, -b.z));
  mesh.bind(new THREE.Skeleton(list, inverses), new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.frustumCulled = false; // 包围球不会跟着动作更新，敌人数量又少，干脆不裁剪
  return { mesh, bones };
}

// ---------------------------------------------------------------------------
// 三种敌人。本地坐标 +z 是正前方；地面单位原点在脚下，飞鸥原点在机身中心。

function hound(): RigDef {
  // 机械猎犬：四足机器狗。板状的机身分前、中、后三段（跑起来腰能跟着弯），外面扣着一层浅色外壳和橙色警示条；
  // 腿根是圆盘形的大关节，腿是板状的大腿加细长的小腿，脚是橡胶球。背上驮着传感器塔，屁股后面一根鞭状天线。
  const r = new RigBuilder();
  r.bone('root', null, 0, 0.72, -0.42);
  r.bone('spine', 'root', 0, 0.74, -0.12);
  r.bone('chest', 'spine', 0, 0.74, 0.22);
  r.bone('neck', 'chest', 0, 0.86, 0.56);
  r.bone('head', 'neck', 0, 0.9, 0.78);
  r.bone('jaw', 'head', 0, 0.82, 0.9);
  r.bone('tail1', 'root', -0.15, 0.93, -0.58);   // 天线的根部和中段：原来摇尾巴的动作现在让天线晃
  r.bone('tail2', 'tail1', -0.15, 1.28, -0.6);

  // ---- 后段：底盘、散热格栅、尾板
  r.box('root', 'dark', 0.38, 0.25, 0.46, 0, 0.76, -0.44, undefined, 0.03);
  r.box('root', 'dark', 0.44, 0.04, 0.3, 0, 0.9, -0.46, undefined, 0.01);
  for (let i = 0; i < 10; i++) r.box('root', 'steel', 0.01, 0.07, 0.27, -0.171 + i * 0.038, 0.945, -0.46, undefined, 0.003); // 散热片
  for (const z of [-0.33, -0.59]) r.box('root', 'dark', 0.42, 0.016, 0.026, 0, 0.985, z, undefined, 0.004);
  r.box('root', 'body', 0.42, 0.22, 0.08, 0, 0.77, -0.69, undefined, 0.036);                                  // 尾板
  r.box('root', 'dark', 0.24, 0.07, 0.02, 0, 0.8, -0.726, undefined, 0.006);
  r.box('root', 'eye', 0.18, 0.016, 0.006, 0, 0.8, -0.738);                                                  // 尾灯
  r.cyl('root', 'steel', 0.03, 0.03, 0.12, 0.71, -0.73, 'z'); r.cyl('root', 'dark', 0.034, 0.012, -0.1, 0.69, -0.73, 'z');
  for (const sx of [-0.17, 0.17]) for (const sy of [-0.075, 0.075]) r.bolt('root', sx, 0.77 + sy, -0.727, 'z', 0.012);
  r.cyl('root', 'dark', 0.03, 0.07, 0.15, 0.955, -0.6); r.sph('root', 'eye', 0.028, 0.15, 1.0, -0.6);         // 警示灯
  // ---- 中段：底盘、顶壳、电池仓
  r.box('spine', 'dark', 0.36, 0.24, 0.34, 0, 0.76, -0.07, undefined, 0.03);
  r.box('spine', 'body', 0.48, 0.08, 0.36, 0, 0.9, -0.05, undefined, 0.036);
  r.box('spine', 'accent', 0.13, 0.074, 0.36, 0, 0.9, -0.05, undefined, 0.014);
  r.box('spine', 'dark', 0.33, 0.13, 0.76, 0, 0.59, -0.04, undefined, 0.03);                                  // 肚子下面的电池仓
  for (const z of [-0.2, 0.12]) r.box('spine', 'accent', 0.338, 0.04, 0.12, 0, 0.6, z, undefined, 0.008);
  // ---- 前段：底盘、顶壳、前保险杠和两只前灯
  r.box('chest', 'dark', 0.38, 0.25, 0.5, 0, 0.76, 0.37, undefined, 0.03);
  r.box('chest', 'body', 0.48, 0.08, 0.4, 0, 0.9, 0.37, undefined, 0.036);
  r.box('chest', 'dark', 0.3, 0.012, 0.24, 0, 0.943, 0.38, undefined, 0.004);                                 // 顶壳上嵌的一块防滑垫
  for (let i = 0; i < 5; i++) r.box('chest', 'steel', 0.26, 0.006, 0.01, 0, 0.951, 0.29 + i * 0.045);
  r.box('chest', 'accent', 0.42, 0.21, 0.1, 0, 0.765, 0.66, undefined, 0.045);
  r.box('chest', 'dark', 0.36, 0.035, 0.05, 0, 0.635, 0.69, undefined, 0.015);                                // 保险杠下面的橡胶防撞条
  r.box('chest', 'dark', 0.28, 0.1, 0.03, 0, 0.785, 0.708, undefined, 0.008);
  for (let i = 0; i < 6; i++) r.box('chest', i % 2 ? 'dark' : 'body', 0.07, 0.046, 0.02, -0.175 + i * 0.07, 0.63, 0.706, undefined, 0.004); // 保险杠下沿的警示块
  for (const s of [-1, 1]) { r.cyl('chest', 'steel', 0.03, 0.02, s * 0.16, 0.785, 0.716, 'z'); r.cyl('chest', 'eye', 0.021, 0.006, s * 0.16, 0.785, 0.729, 'z'); }
  for (const s of [-1, 1]) {
    // 两侧的外壳板、橙色腰线、侧面的检修窗、沿着背脊的提手杆
    r.box('root', 'body', 0.05, 0.2, 0.42, s * 0.212, 0.79, -0.44, undefined, 0.022);
    r.box('spine', 'body', 0.05, 0.2, 0.2, s * 0.212, 0.79, -0.1, undefined, 0.022);
    r.box('chest', 'body', 0.05, 0.2, 0.44, s * 0.212, 0.79, 0.36, undefined, 0.022);
    r.box('root', 'dark', 0.02, 0.1, 0.2, s * 0.232, 0.8, -0.46, undefined, 0.006);                             // 侧壳上凹进去的把手槽
    r.tube('root', 'steel', [s * 0.243, 0.8, -0.54], [s * 0.243, 0.8, -0.38], 0.008);
    r.box('root', 'accent', 0.048, 0.05, 0.42, s * 0.213, 0.655, -0.44, undefined, 0.01);
    r.box('chest', 'accent', 0.048, 0.05, 0.44, s * 0.213, 0.655, 0.36, undefined, 0.01);
    r.box('chest', 'dark', 0.04, 0.13, 0.15, s * 0.222, 0.79, 0.44, undefined, 0.01);
    for (let i = 0; i < 4; i++) r.box('chest', 'steel', 0.006, 0.016, 0.12, s * 0.243, 0.745 + i * 0.03, 0.44);
    r.cable('spine', [[s * 0.19, 0.93, -0.62], [s * 0.19, 1.0, -0.56], [s * 0.19, 1.01, 0.0], [s * 0.19, 1.0, 0.5], [s * 0.19, 0.93, 0.56]], 0.014);
    for (const z of [-0.3, 0.26]) r.cyl('spine', 'steel', 0.011, 0.08, s * 0.19, 0.965, z);
    for (const z of [-0.18, 0.08]) r.bolt('spine', s * 0.2, 0.938, z, 'y', 0.014);
    for (const z of [0.22, 0.52]) r.bolt('chest', s * 0.2, 0.938, z, 'y', 0.014);
    for (const [bn, z] of [['root', -0.6], ['root', -0.28], ['chest', 0.2], ['chest', 0.54]] as const) r.bolt(bn, s * 0.237, 0.85, z, 'x', 0.012);
    r.cable('spine', [[s * 0.15, 0.53, -0.4], [s * 0.172, 0.515, -0.2], [s * 0.172, 0.52, 0.12], [s * 0.15, 0.535, 0.32]], 0.012); // 肚子两侧的线束
  }
  // ---- 背上的传感器塔：转盘、两片耳板夹着一个带镜头的吊舱
  r.cyl('spine', 'dark', 0.15, 0.045, 0, 0.955, -0.05, 'y', 0.135);
  r.box('spine', 'dark', 0.23, 0.026, 0.21, 0, 0.99, -0.05, undefined, 0.006);
  for (const s of [-1, 1]) { r.box('spine', 'body', 0.036, 0.15, 0.2, s * 0.1, 1.07, -0.045, undefined, 0.014); r.cyl('spine', 'steel', 0.028, 0.012, s * 0.122, 1.08, -0.03, 'x'); }
  r.box('spine', 'body', 0.14, 0.11, 0.27, 0, 1.085, -0.04, undefined, 0.02);
  r.box('spine', 'accent', 0.143, 0.026, 0.272, 0, 1.057, -0.04, undefined, 0.008);
  r.cyl('spine', 'dark', 0.045, 0.14, 0, 1.085, 0.14, 'z');
  for (let i = 0; i < 4; i++) r.cyl('spine', 'steel', 0.05, 0.01, 0, 1.085, 0.09 + i * 0.033, 'z');
  r.cyl('spine', 'dark', 0.03, 0.22, 0, 1.085, 0.3, 'z', 0.028); r.cyl('spine', 'dark', 0.046, 0.07, 0, 1.085, 0.43, 'z');
  r.box('spine', 'dark', 0.046, 0.046, 0.12, -0.04, 1.165, -0.03, undefined, 0.01); r.cyl('spine', 'eye', 0.014, 0.004, -0.04, 1.165, 0.032, 'z'); // 塔顶的小瞄具
  r.cyl('spine', 'dark', 0.072, 0.076, 0.108, 1.08, -0.1, 'x'); r.cyl('spine', 'steel', 0.026, 0.084, 0.108, 1.08, -0.1, 'x');                // 侧面的弹鼓
  // ---- 脖子：一截粗管套着三道环；头：圆角盒，正面一条发光的目镜
  r.tube('neck', 'dark', [0, 0.83, 0.54], [0, 0.93, 0.8], 0.062, 0.05);
  for (let i = 0; i < 3; i++) { const k = 0.22 + i * 0.26, y = 0.83 + 0.1 * k, z = 0.54 + 0.26 * k; r.tube('neck', 'body', [0, y - 0.006, z - 0.015], [0, y + 0.006, z + 0.015], 0.074); }
  r.box('neck', 'body', 0.18, 0.07, 0.14, 0, 0.845, 0.59, undefined, 0.016);
  r.cable('neck', [[0.07, 0.83, 0.56], [0.095, 0.9, 0.66], [0.085, 0.96, 0.76], [0.065, 0.97, 0.82]], 0.011);
  r.box('head', 'body', 0.28, 0.175, 0.3, 0, 0.95, 0.94, undefined, 0.06);
  r.box('head', 'body', 0.25, 0.15, 0.14, 0, 0.945, 1.09, undefined, 0.05);                                   // 往前收窄的吻部
  for (const s of [-1, 1]) r.box('head', 'accent', 0.012, 0.05, 0.16, s * 0.141, 0.985, 0.98, undefined, 0.004);
  r.box('head', 'dark', 0.225, 0.105, 0.045, 0, 0.945, 1.15, undefined, 0.02);
  r.box('head', 'eye', 0.19, 0.036, 0.01, 0, 0.955, 1.176);                                                   // 目镜
  for (const s of [-1, 1]) { r.cyl('head', 'dark', 0.022, 0.018, s * 0.083, 0.912, 1.172, 'z'); r.cyl('head', 'steel', 0.013, 0.006, s * 0.083, 0.912, 1.183, 'z'); }
  r.box('head', 'accent', 0.09, 0.012, 0.3, 0, 1.04, 0.97, undefined, 0.004);
  r.cyl('head', 'dark', 0.048, 0.32, 0, 0.95, 0.895, 'x');                                                    // 贯穿头部的转轴，两头是"耳朵"
  for (const s of [-1, 1]) { r.cyl('head', 'accent', 0.034, 0.01, s * 0.164, 0.95, 0.895, 'x'); for (const z of [0.9, 1.07]) r.bolt('head', s * 0.118, 1.04, z, 'y', 0.012); }
  r.cyl('head', 'dark', 0.054, 0.04, 0, 1.057, 0.9); r.cyl('head', 'steel', 0.056, 0.01, 0, 1.068, 0.9);      // 头顶的激光雷达
  r.box('head', 'dark', 0.18, 0.045, 0.2, 0, 0.85, 1.0, undefined, 0.012);
  // 下颌：一块托板，前面伸出两根电击叉
  r.box('jaw', 'dark', 0.17, 0.03, 0.26, 0, 0.815, 1.02, undefined, 0.01);
  for (const s of [-1, 1]) { r.tube('jaw', 'steel', [s * 0.055, 0.818, 1.14], [s * 0.05, 0.822, 1.27], 0.012, 0.005); r.sph('jaw', 'eye', 0.011, s * 0.05, 0.823, 1.275); }
  // 天线
  r.cyl('root', 'dark', 0.02, 0.07, -0.15, 0.955, -0.58);
  r.tube('tail1', 'steel', [-0.15, 0.98, -0.58], [-0.15, 1.28, -0.6], 0.007, 0.005);
  r.tube('tail2', 'steel', [-0.15, 1.28, -0.6], [-0.15, 1.66, -0.64], 0.005, 0.003); r.sph('tail2', 'accent', 0.014, -0.15, 1.67, -0.64);

  // ---- 四条腿：髋部一个横着的作动筒、一个大圆盘关节；大腿是板，小腿是细管，脚是球
  const leg = (id: string, parent: string, s: number, hip: V3, knee: V3, ankle: V3, toe: V3) => {
    const X = (p: V3): V3 => [p[0] * s, p[1], p[2]];
    r.bone(id + '1', parent, ...X(hip)); r.bone(id + '2', id + '1', ...X(knee)); r.bone(id + '3', id + '2', ...X(ankle)); r.bone(id + 'T', id + '3', ...X(toe));
    const hx = hip[0] * s, kx = knee[0] * s;
    r.cyl(parent, 'dark', 0.082, 0.24, hx - s * 0.075, hip[1], hip[2], 'z');                                   // 外展作动筒，固定在机身上
    r.box(parent, 'body', 0.15, 0.05, 0.2, hx - s * 0.075, hip[1] + 0.082, hip[2], undefined, 0.016);
    r.cyl(parent, 'steel', 0.04, 0.26, hx - s * 0.075, hip[1], hip[2], 'z');
    r.cyl(id + '1', 'body', 0.112, 0.085, hx + s * 0.035, hip[1], hip[2], 'x');                                // 髋关节的大圆盘
    r.cyl(id + '1', 'accent', 0.117, 0.02, hx + s * 0.06, hip[1], hip[2], 'x');
    r.cyl(id + '1', 'body', 0.1, 0.02, hx + s * 0.082, hip[1], hip[2], 'x', 0.085);                            // 圆盘外沿收一道斜边
    r.cyl(id + '1', 'steel', 0.03, 0.012, hx + s * 0.094, hip[1], hip[2], 'x');
    r.cyl(id + '1', 'dark', 0.066, 0.105, hx + s * 0.035, hip[1], hip[2], 'x');
    for (let i = 0; i < 5; i++) r.bolt(id + '1', hx + s * 0.08, hip[1] + Math.cos(i * 1.2566) * 0.088, hip[2] + Math.sin(i * 1.2566) * 0.088, 'x', 0.011);
    const T = (p: V3, dx: number, dz: number): V3 => [p[0] * s + s * dx, p[1], p[2] + dz];
    r.seg(id + '1', 'body', T(hip, 0.035, 0), T(knee, 0.035, 0), 0.075, 0.135);                                // 大腿外壳
    r.seg(id + '1', 'dark', T(hip, 0.035, -0.045), T(knee, 0.035, -0.04), 0.055, 0.08);
    const mid = (k: number): V3 => [hip[0] + (knee[0] - hip[0]) * k, hip[1] + (knee[1] - hip[1]) * k, hip[2] + (knee[2] - hip[2]) * k];
    r.box(id + '1', 'accent', 0.08, 0.05, 0.14, mid(0.52)[0] * s + s * 0.035, mid(0.52)[1], mid(0.52)[2], undefined, 0.01);
    r.box(id + '1', 'dark', 0.079, 0.014, 0.139, mid(0.82)[0] * s + s * 0.035, mid(0.82)[1], mid(0.82)[2], undefined, 0.004);
    r.piston(id + '1', T(mid(0.12), 0.035, -0.1), T(mid(0.9), 0.035, -0.085), 0.02);
    r.cable(id + '1', [T(mid(0.05), 0.08, 0.05), T(mid(0.4), 0.088, 0.066), T(mid(0.9), 0.08, 0.05)], 0.008);
    r.cyl(id + '1', 'dark', 0.066, 0.11, kx + s * 0.035, knee[1], knee[2], 'x');                               // 膝关节
    r.cyl(id + '1', 'body', 0.046, 0.118, kx + s * 0.035, knee[1], knee[2], 'x');
    r.tube(id + '2', 'dark', T(knee, 0.035, 0), T(ankle, 0.035, 0), 0.04, 0.03);                               // 小腿
    const sm: V3 = [(knee[0] + ankle[0]) / 2, (knee[1] + ankle[1]) / 2, (knee[2] + ankle[2]) / 2];
    r.seg(id + '2', 'body', T([sm[0], sm[1] + 0.07, sm[2] - 0.02], 0.035, 0.03), T([sm[0], sm[1] - 0.08, sm[2] + 0.03], 0.035, 0.03), 0.07, 0.05);
    r.box(id + '2', 'accent', 0.073, 0.022, 0.054, sm[0] * s + s * 0.035, sm[1] - 0.06, sm[2] + 0.052, undefined, 0.005);
    r.sph(id + '3', 'dark', 0.045, ankle[0] * s + s * 0.035, ankle[1], ankle[2]);
    r.tube(id + '3', 'dark', T(ankle, 0.035, 0), T([toe[0], toe[1] + 0.08, toe[2]], 0.035, 0), 0.03, 0.026);
    r.cyl(id + '3', 'steel', 0.036, 0.03, toe[0] * s + s * 0.035, toe[1] + 0.105, toe[2]);
    r.sph(id + '3', 'dark', 0.064, toe[0] * s + s * 0.035, toe[1] + 0.055, toe[2] + 0.005, 1, 0.86, 1.08);     // 橡胶球脚
  };
  for (const s of [-1, 1]) {
    const k = s < 0 ? 'l' : 'r';
    leg('f' + k, 'chest', s, [0.3, 0.68, 0.36], [0.31, 0.42, 0.28], [0.31, 0.17, 0.36], [0.31, 0, 0.4]);
    leg('b' + k, 'root', s, [0.27, 0.68, -0.44], [0.28, 0.42, -0.34], [0.28, 0.2, -0.56], [0.28, 0, -0.5]);
  }
  return r.build();
}

function guard(): RigDef {
  const r = new RigBuilder();
  r.bone('root', null, 0, 1.28, 0);
  r.bone('torso', 'root', 0, 1.46, 0);
  r.bone('head', 'torso', 0, 2.3, 0.02);
  r.bone('armL1', 'torso', -0.76, 2.0, 0);
  r.bone('armL2', 'armL1', -0.8, 1.52, 0.04);
  r.bone('armR1', 'torso', 0.76, 2.0, 0);
  r.bone('gun', 'armR1', 0.76, 1.64, 0.1);

  r.clay('root', 'dark', [[[-0.2, 1.3, 0], [0.2, 1.3, 0], 0.19, 0.19]], 0.05, 0.03);
  r.cyl('root', 'dark', 0.11, 0.86, 0, 1.22, 0, 'x');
  r.box('root', 'accent', 0.26, 0.26, 0.08, 0, 1.24, 0.22);
  r.cyl('torso', 'dark', 0.2, 0.2, 0, 1.5, 0);                        // 腰部转盘
  // 躯干：横着的胸腔、往下收的腹部、背上隆起的一块、颈圈 —— 融成一个整体
  r.clay('torso', 'body', [[[-0.24, 2.02, 0], [0.24, 2.02, 0], 0.31, 0.31], [[0, 1.62, 0], [0, 1.86, 0], 0.2, 0.27], [[-0.2, 2.12, -0.14], [0.2, 2.12, -0.14], 0.26, 0.26], [[0, 2.3, 0], [0, 2.37, 0.02], 0.2, 0.16]], 0.06, 0.03);
  r.box('torso', 'accent', 0.56, 0.42, 0.08, 0, 1.96, 0.35);
  r.sph('torso', 'eye', 0.075, 0, 1.96, 0.39, 1, 1, 0.5);            // 胸口核心
  for (const s of [-1, 1]) r.box('torso', 'dark', 0.16, 0.4, 0.06, s * 0.39, 1.98, 0.26, [0, s * 0.5, 0]);
  r.box('torso', 'dark', 0.74, 0.62, 0.22, 0, 1.96, -0.42);           // 背包
  for (let i = 0; i < 4; i++) r.box('torso', 'body', 0.56, 0.05, 0.04, 0, 1.76 + i * 0.13, -0.54); // 散热片
  for (const s of [-1, 1]) r.cyl('torso', 'dark', 0.06, 0.34, s * 0.26, 2.42, -0.4); // 排气管
  r.cyl('torso', 'dark', 0.2, 0.1, 0, 2.36, 0.02);

  // 细节：胸甲和肩甲上的螺栓、背包到炮臂的弹链管、腰部的液压杆、背上的线缆、胸口的格栅和吊环
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) r.bolt('torso', sx * 0.23, 1.96 + sy * 0.17, 0.392, 'z', 0.02);
    r.piston('root', [sx * 0.2, 1.34, -0.2], [sx * 0.3, 1.62, -0.26], 0.035);
    r.piston('root', [sx * 0.24, 1.36, 0.18], [sx * 0.36, 1.6, 0.26], 0.03);
    r.cable('torso', [[sx * 0.3, 2.2, -0.5], [sx * 0.44, 2.3, -0.36], [sx * 0.56, 2.26, -0.16], [sx * 0.62, 2.14, -0.04]], 0.028);
    r.box('torso', 'dark', 0.06, 0.3, 0.36, sx * 0.545, 2.02, 0);                 // 侧面的散热槽
    for (let i = 0; i < 3; i++) r.box('torso', 'steel', 0.012, 0.03, 0.3, sx * 0.578, 1.93 + i * 0.09, 0);
    r.tube('torso', 'steel', [sx * 0.3, 2.34, 0.2], [sx * 0.3, 2.4, 0.12], 0.014); r.tube('torso', 'steel', [sx * 0.3, 2.4, 0.12], [sx * 0.3, 2.34, 0.04], 0.014); // 吊环
  }
  r.cable('torso', [[0.3, 1.76, -0.5], [0.52, 1.66, -0.4], [0.7, 1.6, -0.16], [0.76, 1.56, 0.1]], 0.05);  // 弹链管
  for (let i = 0; i < 4; i++) r.box('torso', 'steel', 0.24, 0.014, 0.012, 0, 1.62 + i * 0.04, 0.215 + i * 0.012); // 腹部的进气栅
  r.box('torso', 'accent', 0.16, 0.1, 0.012, 0.3, 2.2, 0.215, [0, 0.45, 0]); r.box('torso', 'dark', 0.74, 0.1, 0.26, 0, 2.3, -0.42);
  r.clay('head', 'body', [[[0, 2.5, -0.08], [0, 2.5, 0.12], 0.2, 0.17], [[0, 2.42, 0.02], [0, 2.4, 0.16], 0.14, 0.11]], 0.04, 0.022); // 头盔：后脑圆，下巴往前收
  for (const sx of [-1, 1]) { r.box('head', 'dark', 0.05, 0.2, 0.26, sx * 0.21, 2.5, 0.02); r.bolt('head', sx * 0.24, 2.5, 0.02, 'x', 0.035); r.sph('head', 'eye', 0.016, sx * 0.13, 2.6, 0.252); }
  r.box('head', 'dark', 0.18, 0.12, 0.16, 0, 2.5, -0.22);
  r.box('head', 'eye', 0.28, 0.06, 0.07, 0, 2.52, 0.272);
  r.box('head', 'dark', 0.2, 0.07, 0.08, 0, 2.38, 0.25);
  r.box('head', 'accent', 0.1, 0.04, 0.34, 0, 2.7, 0.0);
  r.cyl('head', 'dark', 0.012, 0.34, 0.17, 2.8, -0.12);
  r.sph('head', 'eye', 0.02, 0.17, 2.98, -0.12);

  for (const s of [-1, 1]) {
    const a = s < 0 ? 'armL1' : 'armR1';
    r.clay(a, 'body', [[[s * 0.72, 2.06, -0.08], [s * 0.8, 2.02, 0.08], 0.24, 0.23]], 0.05, 0.028);   // 肩甲：一整块圆鼓的护肩
    r.clay(a, 'accent', [[[s * 0.6, 2.27, 0], [s * 0.92, 2.2, 0], 0.075, 0.07]], 0.05, 0.022);          // 肩甲上的一道橙色棱
    r.cyl(a, 'dark', 0.15, 0.06, s * 1.02, 2.02, 0, 'x'); r.bolt(a, s * 1.055, 2.02, 0, 'x', 0.05);
  }
  // 护盾：四周一圈加强边、背面的握架、正面的铆钉和警示条
  for (const sy of [-1, 1]) r.box('armL2', 'dark', 0.62, 0.05, 0.09, -0.82, 1.42 + sy * 0.5, 0.44);
  for (const sx of [-1, 1]) { r.box('armL2', 'dark', 0.05, 1.04, 0.09, -0.82 + sx * 0.29, 1.42, 0.44); for (let i = 0; i < 5; i++) r.bolt('armL2', -0.82 + sx * 0.29, 0.98 + i * 0.22, 0.49, 'z', 0.022); }
  for (let i = 0; i < 4; i++) r.box('armL2', 'dark', 0.07, 0.1, 0.006, -1.0 + i * 0.12, 1.7, 0.484, [0, 0, 0.5]);
  r.piston('armL1', [-0.78, 1.96, -0.14], [-0.8, 1.56, -0.08], 0.03);
  // 左臂挂护盾
  r.clay('armL1', 'dark', [[[-0.78, 1.9, 0], [-0.8, 1.52, 0.04], 0.115, 0.09]], 0.04, 0.024);
  r.sph('armL2', 'dark', 0.12, -0.8, 1.52, 0.04);
  r.clay('armL2', 'body', [[[-0.8, 1.52, 0.04], [-0.8, 1.26, 0.3], 0.1, 0.085]], 0.04, 0.024);
  r.box('armL2', 'body', 0.6, 1.04, 0.07, -0.82, 1.42, 0.44, undefined, 0.03);
  r.box('armL2', 'accent', 0.6, 0.1, 0.075, -0.82, 1.7, 0.445);
  r.box('armL2', 'dark', 0.3, 0.16, 0.076, -0.82, 1.3, 0.445);        // 观察窗
  // 右臂是炮
  r.clay('armR1', 'dark', [[[0.76, 1.9, 0], [0.76, 1.66, 0.08], 0.125, 0.11]], 0.04, 0.024);
  r.box('gun', 'dark', 0.26, 0.28, 0.7, 0.76, 1.62, 0.42);
  r.box('gun', 'body', 0.28, 0.1, 0.4, 0.76, 1.78, 0.4);
  r.cyl('gun', 'accent', 0.13, 0.2, 0.76, 1.45, 0.3, 'x');            // 弹鼓
  r.cyl('gun', 'body', 0.07, 0.5, 0.76, 1.62, 0.96, 'z');
  for (let i = 0; i < 3; i++) r.cyl('gun', 'dark', 0.09, 0.04, 0.76, 1.62, 0.84 + i * 0.1, 'z'); // 散热环
  r.cyl('gun', 'dark', 0.095, 0.1, 0.76, 1.62, 1.2, 'z');
  r.sph('gun', 'glow', 0.065, 0.76, 1.62, 1.24, 1, 1, 0.5);
  r.box('gun', 'dark', 0.06, 0.07, 0.3, 0.76, 1.87, 0.36); r.sph('gun', 'eye', 0.02, 0.76, 1.87, 0.52);  // 炮上的瞄具
  r.tube('gun', 'steel', [0.9, 1.56, 0.5], [0.9, 1.56, 1.1], 0.018); r.tube('gun', 'steel', [0.62, 1.56, 0.5], [0.62, 1.56, 1.1], 0.018); // 炮管两侧的导杆
  for (const dz of [0.14, 0.42, 0.7]) { r.bolt('gun', 0.895, 1.66, dz, 'x', 0.026); r.bolt('gun', 0.625, 1.66, dz, 'x', 0.026); }

  for (const s of [-1, 1]) {
    const k = s < 0 ? 'legL' : 'legR';
    const hip: V3 = [s * 0.31, 1.22, 0], knee: V3 = [s * 0.33, 0.68, 0.07], ankle: V3 = [s * 0.33, 0.15, -0.03];
    r.bone(k + '1', 'root', ...hip); r.bone(k + '2', k + '1', ...knee); r.bone(k + '3', k + '2', ...ankle); r.bone(k + 'T', k + '3', s * 0.33, 0, 0.08);
    r.sph(k + '1', 'dark', 0.17, ...hip);
    r.clay(k + '1', 'body', [[hip, knee, 0.2, 0.15], [[hip[0], hip[1] - 0.12, 0.08], [knee[0], knee[1] + 0.16, 0.1], 0.14, 0.12]], 0.05, 0.028); // 大腿：前侧鼓出一块
    r.box(k + '1', 'accent', 0.18, 0.28, 0.05, s * 0.32, 0.98, 0.235);
    r.sph(k + '2', 'dark', 0.15, ...knee);
    r.box(k + '2', 'body', 0.26, 0.18, 0.1, s * 0.33, 0.7, 0.2);      // 护膝
    r.clay(k + '2', 'dark', [[knee, ankle, 0.13, 0.1], [[knee[0], 0.52, -0.06], [knee[0], 0.34, -0.08], 0.1, 0.07]], 0.05, 0.028); // 小腿：后面鼓出小腿肚
    r.box(k + '2', 'body', 0.26, 0.36, 0.08, s * 0.33, 0.4, 0.16);    // 胫甲
    r.sph(k + '3', 'dark', 0.11, ...ankle);
    r.box(k + '3', 'body', 0.34, 0.14, 0.58, s * 0.33, 0.07, 0.1);
    r.box(k + '3', 'dark', 0.3, 0.1, 0.16, s * 0.33, 0.05, -0.22);
    r.piston(k + '1', [s * 0.33, 1.14, -0.25], [s * 0.34, 0.74, -0.19], 0.04);
    r.piston(k + '2', [s * 0.33 + s * 0.155, 0.6, 0.02], [s * 0.33 + s * 0.14, 0.2, -0.02], 0.028);
    r.cyl(k + '2', 'body', 0.17, 0.05, s * 0.33 + s * 0.165, 0.68, 0.07, 'x'); r.bolt(k + '2', s * 0.33 + s * 0.197, 0.68, 0.07, 'x', 0.05);
    for (const dy of [-0.1, 0.1]) for (const dx of [-0.08, 0.08]) r.bolt(k + '2', s * 0.33 + dx, 0.4 + dy, 0.202, 'z');
    for (const c of [-0.1, 0, 0.1]) r.box(k + '3', 'steel', 0.07, 0.06, 0.12, s * 0.33 + c, 0.04, 0.42);  // 脚趾
    r.cable(k + '1', [[s * 0.2, 1.2, 0.16], [s * 0.2, 0.96, 0.22], [s * 0.24, 0.76, 0.2]], 0.02);
  }
  return r.build();
}

function gull(): RigDef {
  // 机械飞鸥：四旋翼无人机。水滴形的外壳扣在一块底盘上，四根机臂各带一个涵道旋翼；
  // 机头下方吊着云台相机球（弱点），机腹挂一门双管炮，底下是两根起落橇。
  const r = new RigBuilder();
  const ROTORS: [number, number][] = [[0.53, 0.48], [-0.53, 0.48], [0.53, -0.48], [-0.53, -0.48]], RY = 0.07;
  r.bone('root', null, 0, 0, 0);
  r.bone('head', 'root', 0, -0.25, 0.44);                    // 云台相机球
  ROTORS.forEach(([x, z], i) => r.bone('rotor' + i, 'root', x, RY, z));

  // ---- 机身
  r.sph('root', 'body', 1, 0, 0.03, 0, 0.19, 0.12, 0.43);
  r.sph('root', 'accent', 1, 0, 0.03, 0.3, 0.152, 0.086, 0.14);                                    // 机头的橙色整流罩
  r.sph('root', 'dark', 1, 0, 0.03, -0.03, 0.197, 0.03, 0.125);                                    // 腰上一圈深色的箍
  r.box('root', 'body', 0.19, 0.024, 0.32, 0, 0.143, -0.05, undefined, 0.008);                     // 背上的盖板
  r.box('root', 'accent', 0.05, 0.012, 0.32, 0, 0.158, -0.05, undefined, 0.003);
  for (const x of [-0.08, 0.08]) for (const z of [-0.19, 0.09]) r.bolt('root', x, 0.157, z, 'y', 0.012);
  r.box('root', 'dark', 0.28, 0.1, 0.6, 0, -0.056, -0.01, undefined, 0.026);                       // 底盘
  r.box('root', 'dark', 0.19, 0.12, 0.18, 0, 0.008, -0.42, undefined, 0.022);                      // 尾部的电调舱
  r.box('root', 'accent', 0.2, 0.032, 0.05, 0, 0.048, -0.48, undefined, 0.008);
  r.box('root', 'eye', 0.08, 0.01, 0.005, 0, 0.0, -0.512);
  r.tube('root', 'steel', [0.06, 0.07, -0.44], [0.08, 0.3, -0.52], 0.006, 0.003); r.tube('root', 'steel', [-0.06, 0.07, -0.44], [-0.08, 0.24, -0.5], 0.006, 0.003);
  r.sph('root', 'eye', 0.016, 0, 0.082, -0.5);                                                     // 尾部的防撞灯
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) r.box('root', 'steel', 0.006, 0.016, 0.1, s * 0.142, -0.095 + i * 0.026, -0.1); // 底盘两侧的散热缝
    r.box('root', 'accent', 0.006, 0.05, 0.16, s * 0.142, -0.056, 0.14, undefined, 0.002);
    // 起落橇
    r.tube('root', 'steel', [s * 0.11, -0.1, 0.18], [s * 0.21, -0.37, 0.22], 0.012); r.tube('root', 'steel', [s * 0.11, -0.1, -0.24], [s * 0.21, -0.37, -0.28], 0.012);
    r.tube('root', 'dark', [s * 0.21, -0.37, -0.36], [s * 0.21, -0.37, 0.3], 0.016);
    for (const z of [-0.36, 0.3]) r.sph('root', 'dark', 0.02, s * 0.21, -0.37, z);
  }
  // ---- 四根机臂和涵道
  const DUCT: [number, number][] = [[0.282, -0.058], [0.314, -0.051], [0.33, 0], [0.323, 0.048], [0.304, 0.064], [0.285, 0.051], [0.277, 0], [0.282, -0.058]];
  ROTORS.forEach(([x, z], i) => {
    const sx = Math.sign(x), sz = Math.sign(z), ang = Math.atan2(z, x);
    r.tube('root', 'dark', [sx * 0.1, -0.02, sz * 0.17], [x, RY - 0.05, z], 0.04, 0.03);            // 机臂
    r.seg('root', 'body', [sx * 0.15, 0.012, sz * 0.2], [x * 0.72, RY - 0.016, z * 0.74], 0.07, 0.04);
    r.cyl('root', 'dark', 0.055, 0.1, x, RY - 0.045, z);                                             // 电机
    r.cyl('root', 'steel', 0.058, 0.014, x, RY - 0.012, z);
    r.lathe('root', 'body', DUCT, x, RY, z, 28);                                                    // 涵道环
    for (let k = 0; k < 3; k++) { const a = k * 2.094 + 0.5 + i; r.box('root', 'dark', 0.235, 0.011, 0.026, x + Math.cos(a) * 0.168, RY - 0.036, z - Math.sin(a) * 0.168, [0, a, 0], 0.003); } // 支撑电机的三根撑杆
    for (let k = -1; k <= 1; k++) { const a = ang + k * 0.2; r.box('root', k ? 'accent' : 'dark', 0.02, 0.08, 0.058, x + Math.cos(a) * 0.328, RY, z + Math.sin(a) * 0.328, [0, -a, 0], 0.005); } // 涵道外沿的标识块
    r.sph('root', 'eye', 0.018, x + sx * 0.345, RY, z);                                              // 航行灯
    // 旋翼：桨毂 + 两片带一点扭角的桨叶；再加一张半透明的圆片，转起来像一圈残影
    r.cyl('rotor' + i, 'steel', 0.03, 0.05, x, RY, z);
    for (const d of [-1, 1]) { r.box('rotor' + i, 'dark', 0.25, 0.006, 0.048, x + d * 0.14, RY + 0.014, z, [d * 0.22, 0, 0], 0.002); r.box('rotor' + i, 'accent', 0.032, 0.007, 0.05, x + d * 0.252, RY + 0.014, z, [d * 0.22, 0, 0], 0.002); }
    r.cyl('rotor' + i, 'blur', 0.268, 0.002, x, RY + 0.014, z);
  });
  // ---- 云台：一个 U 形叉架夹着相机球
  r.cyl('root', 'dark', 0.058, 0.03, 0, -0.118, 0.44);
  r.box('root', 'dark', 0.26, 0.018, 0.05, 0, -0.14, 0.44, undefined, 0.005);
  for (const s of [-1, 1]) r.box('root', 'dark', 0.016, 0.13, 0.05, s * 0.122, -0.2, 0.44, undefined, 0.005);
  r.sph('head', 'dark', 0.098, 0, -0.25, 0.44);
  r.cyl('head', 'steel', 0.021, 0.232, 0, -0.25, 0.44, 'x');
  r.cyl('head', 'dark', 0.056, 0.06, 0, -0.244, 0.525, 'z', 0.05); r.cyl('head', 'steel', 0.058, 0.01, 0, -0.244, 0.552, 'z');
  r.cyl('head', 'eye', 0.04, 0.008, 0, -0.244, 0.558, 'z');                                         // 镜头
  r.cyl('head', 'dark', 0.02, 0.018, 0.048, -0.193, 0.505, 'z');
  r.cyl('head', 'dark', 0.034, 0.07, 0, -0.33, 0.47, 'z', 0.03); r.cyl('head', 'eye', 0.024, 0.006, 0, -0.33, 0.507, 'z'); // 球下面的探照灯
  r.box('head', 'accent', 0.11, 0.012, 0.07, 0, -0.158, 0.42, undefined, 0.004);
  // ---- 机腹的双管炮
  r.box('root', 'dark', 0.08, 0.05, 0.08, 0, -0.125, -0.16, undefined, 0.01);
  r.cyl('root', 'steel', 0.02, 0.11, 0, -0.15, -0.16, 'x');
  r.box('root', 'dark', 0.085, 0.075, 0.21, 0, -0.195, -0.16, undefined, 0.014);
  r.box('root', 'accent', 0.088, 0.02, 0.08, 0, -0.175, -0.21, undefined, 0.005);
  r.box('root', 'dark', 0.05, 0.08, 0.08, 0.066, -0.2, -0.19, undefined, 0.01);                     // 弹匣
  for (const x of [-0.023, 0.023]) { r.cyl('root', 'dark', 0.014, 0.32, x, -0.195, 0.1, 'z'); r.cyl('root', 'steel', 0.02, 0.05, x, -0.195, 0.25, 'z'); }
  r.box('root', 'steel', 0.072, 0.02, 0.02, 0, -0.195, 0.16, undefined, 0.004);
  return r.build();
}

const DEFS: Partial<Record<string, RigDef>> = {};
export function rigDef(kind: 'gull' | 'hound' | 'guard'): RigDef {
  return (DEFS[kind] ??= kind === 'gull' ? gull() : kind === 'hound' ? hound() : guard());
}
