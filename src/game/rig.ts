import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 骨骼蒙皮模型的搭建工具。
//
// 思路：先声明一棵骨骼树（每根骨骼给出它在"绑定姿势"下的关节位置），
// 再往骨骼上挂零件（圆角盒、圆柱、球）。所有零件最后合并成一个几何体，
// 每个顶点记下自己跟着哪根骨骼动（skinIndex / skinWeight）。
// 运行时只要转动骨骼，显卡就会把顶点带着一起动——这就是骨骼动画。

export type MatKey = 'body' | 'accent' | 'dark' | 'steel' | 'eye' | 'glow';
const MAT_ORDER: MatKey[] = ['body', 'accent', 'dark', 'steel', 'eye', 'glow'];

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
  const r = new RigBuilder();
  r.bone('root', null, 0, 0.72, -0.42);
  r.bone('spine', 'root', 0, 0.74, -0.12);
  r.bone('chest', 'spine', 0, 0.74, 0.22);
  r.bone('neck', 'chest', 0, 0.86, 0.56);
  r.bone('head', 'neck', 0, 0.9, 0.78);
  r.bone('jaw', 'head', 0, 0.8, 0.88);
  r.bone('tail1', 'root', 0, 0.84, -0.66);
  r.bone('tail2', 'tail1', 0, 0.9, -0.94);

  // 躯干
  r.box('root', 'body', 0.42, 0.38, 0.46, 0, 0.76, -0.44);
  r.cyl('root', 'dark', 0.1, 0.62, 0, 0.68, -0.44, 'x');            // 后轴
  r.box('root', 'accent', 0.3, 0.05, 0.3, 0, 0.965, -0.44);
  r.cyl('spine', 'dark', 0.13, 0.46, 0, 0.72, -0.05, 'z');           // 腰：一截细的传动轴
  for (let i = 0; i < 3; i++) r.box('spine', 'body', 0.32, 0.3, 0.07, 0, 0.74, -0.18 + i * 0.13); // 肋片
  r.box('chest', 'body', 0.54, 0.48, 0.56, 0, 0.77, 0.36);
  r.box('chest', 'accent', 0.36, 0.05, 0.42, 0, 1.02, 0.34);
  r.cyl('chest', 'dark', 0.11, 0.7, 0, 0.68, 0.36, 'x');             // 前轴
  r.box('chest', 'dark', 0.4, 0.2, 0.1, 0, 0.72, 0.66);              // 胸前进气格栅
  for (const s of [-1, 1]) r.box('chest', 'dark', 0.06, 0.3, 0.4, s * 0.29, 0.8, 0.36);
  r.cyl('neck', 'dark', 0.1, 0.3, 0, 0.88, 0.66, 'z');
  r.sph('neck', 'body', 0.12, 0, 0.86, 0.56);

  // 头：弱点在这里
  r.box('head', 'body', 0.34, 0.28, 0.38, 0, 0.92, 0.94);
  r.box('head', 'dark', 0.24, 0.13, 0.28, 0, 0.9, 1.2);              // 上颌
  r.box('head', 'eye', 0.3, 0.055, 0.04, 0, 0.975, 1.125);           // 目镜
  r.box('head', 'accent', 0.2, 0.04, 0.26, 0, 1.075, 0.92);
  for (const s of [-1, 1]) {
    r.box('head', 'dark', 0.05, 0.16, 0.12, s * 0.14, 1.12, 0.8, [-0.35, 0, s * 0.2]); // 耳朵（天线）
    r.box('head', 'body', 0.03, 0.05, 0.05, s * 0.09, 0.83, 1.3);    // 上牙
  }
  r.box('jaw', 'dark', 0.2, 0.06, 0.36, 0, 0.79, 1.08);
  for (const s of [-1, 1]) r.box('jaw', 'body', 0.03, 0.05, 0.05, s * 0.07, 0.83, 1.22);

  // 细节：背上的传感器、沿脊柱走的线缆、装甲板四角的螺栓、肩部的轴承盖、颈部的液压杆
  r.box('chest', 'dark', 0.16, 0.07, 0.2, 0, 1.075, 0.3); r.sph('chest', 'eye', 0.028, 0, 1.1, 0.4);
  r.cyl('chest', 'dark', 0.008, 0.26, 0.06, 1.2, 0.24); r.sph('chest', 'accent', 0.014, 0.06, 1.33, 0.24);
  for (const s of [-1, 1]) {
    r.cable('spine', [[s * 0.1, 0.94, -0.3], [s * 0.13, 0.9, -0.12], [s * 0.12, 0.92, 0.04], [s * 0.1, 0.99, 0.14]], 0.018);
    r.cyl('chest', 'body', 0.13, 0.05, s * 0.3, 0.7, 0.36, 'x'); r.cyl('root', 'body', 0.12, 0.05, s * 0.27, 0.7, -0.44, 'x');
    for (const dz of [-0.17, 0.17]) { r.bolt('chest', s * 0.16, 1.047, 0.34 + dz, 'y'); r.bolt('root', s * 0.13, 0.992, -0.44 + dz * 0.7, 'y'); }
    for (const dy of [-0.16, 0.16]) for (const dz of [-0.2, 0.2]) r.bolt('chest', s * 0.272, 0.78 + dy, 0.36 + dz, 'x');
    r.piston('neck', [s * 0.1, 0.72, 0.56], [s * 0.1, 0.82, 0.82], 0.022);
    r.box('head', 'body', 0.03, 0.2, 0.3, s * 0.185, 0.93, 0.94);        // 头两侧的护板
    r.bolt('head', s * 0.202, 0.93, 0.86, 'x'); r.bolt('head', s * 0.202, 0.93, 1.02, 'x');
  }
  for (let i = 0; i < 4; i++) r.box('chest', 'steel', 0.3, 0.012, 0.012, 0, 0.66 + i * 0.04, 0.712); // 进气格栅的栅条
  r.cyl('tail1', 'dark', 0.04, 0.3, 0, 0.87, -0.8, 'z', 0.03);
  r.cyl('tail2', 'dark', 0.03, 0.3, 0, 0.92, -1.08, 'z', 0.015);
  r.sph('tail2', 'accent', 0.035, 0, 0.93, -1.24);

  // 四条腿：每条三节（大腿、小腿、脚掌），绑定姿势就是站立时的弯曲形状
  const leg = (id: string, parent: string, s: number, hip: V3, knee: V3, ankle: V3, toe: V3) => {
    const X = (p: V3): V3 => [p[0] * s, p[1], p[2]];
    r.bone(id + '1', parent, ...X(hip)); r.bone(id + '2', id + '1', ...X(knee)); r.bone(id + '3', id + '2', ...X(ankle)); r.bone(id + 'T', id + '3', ...X(toe));
    r.seg(id + '1', 'body', X(hip), X(knee), 0.15, 0.2);
    r.sph(id + '1', 'dark', 0.1, ...X(hip));
    r.sph(id + '2', 'dark', 0.075, ...X(knee));
    r.seg(id + '2', 'dark', X(knee), X(ankle), 0.09, 0.11);
    r.box(id + '2', 'accent', 0.1, 0.12, 0.03, knee[0] * s, (knee[1] + ankle[1]) / 2, (knee[2] + ankle[2]) / 2 + 0.07);
    r.sph(id + '3', 'dark', 0.055, ...X(ankle));
    r.seg(id + '3', 'body', X(ankle), X([toe[0], toe[1] + 0.05, toe[2]]), 0.08, 0.09);
    r.box(id + '3', 'dark', 0.13, 0.06, 0.2, toe[0] * s, toe[1] + 0.03, toe[2] + 0.04);
    // 大腿外侧的护甲板、膝盖后面的液压杆、三根爪尖
    r.box(id + '1', 'accent', 0.03, 0.2, 0.16, (hip[0] + 0.085) * s, (hip[1] + knee[1]) / 2, (hip[2] + knee[2]) / 2);
    r.bolt(id + '1', (hip[0] + 0.105) * s, hip[1], hip[2], 'x', 0.03);
    r.piston(id + '1', X([hip[0] - 0.06, hip[1] - 0.04, hip[2] - 0.1]), X([knee[0] - 0.06, knee[1] + 0.03, knee[2] - 0.07]), 0.02);
    r.piston(id + '2', X([knee[0] + 0.05, knee[1] - 0.05, knee[2] - 0.06]), X([ankle[0] + 0.05, ankle[1] + 0.04, ankle[2] - 0.05]), 0.016);
    for (const c of [-0.045, 0, 0.045]) r.tube(id + '3', 'steel', [toe[0] * s + c, toe[1] + 0.035, toe[2] + 0.12], [toe[0] * s + c, toe[1] + 0.005, toe[2] + 0.19], 0.014, 0.003);
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

  r.box('root', 'dark', 0.7, 0.3, 0.44, 0, 1.3, 0);
  r.cyl('root', 'dark', 0.11, 0.86, 0, 1.22, 0, 'x');
  r.box('root', 'accent', 0.26, 0.26, 0.08, 0, 1.24, 0.22);
  r.cyl('torso', 'dark', 0.2, 0.2, 0, 1.5, 0);                        // 腰部转盘
  r.box('torso', 'body', 1.1, 0.8, 0.66, 0, 1.94, 0, undefined, 0.09);
  r.box('torso', 'accent', 0.56, 0.42, 0.08, 0, 1.96, 0.35);
  r.sph('torso', 'eye', 0.075, 0, 1.96, 0.39, 1, 1, 0.5);            // 胸口核心
  for (const s of [-1, 1]) r.box('torso', 'dark', 0.2, 0.5, 0.06, s * 0.41, 1.94, 0.33);
  r.box('torso', 'dark', 0.74, 0.62, 0.22, 0, 1.96, -0.42);           // 背包
  for (let i = 0; i < 4; i++) r.box('torso', 'body', 0.56, 0.05, 0.04, 0, 1.76 + i * 0.13, -0.54); // 散热片
  for (const s of [-1, 1]) r.cyl('torso', 'dark', 0.06, 0.34, s * 0.26, 2.42, -0.4); // 排气管
  r.cyl('torso', 'dark', 0.2, 0.1, 0, 2.36, 0.02);

  // 细节：胸甲和肩甲上的螺栓、背包到炮臂的弹链管、腰部的液压杆、背上的线缆、胸口的格栅和吊环
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) { r.bolt('torso', sx * 0.47, 1.94 + sy * 0.32, 0.332, 'z', 0.03); r.bolt('torso', sx * 0.23, 1.96 + sy * 0.17, 0.392, 'z', 0.02); }
    r.piston('root', [sx * 0.2, 1.34, -0.2], [sx * 0.3, 1.62, -0.26], 0.035);
    r.piston('root', [sx * 0.24, 1.36, 0.18], [sx * 0.36, 1.6, 0.26], 0.03);
    r.cable('torso', [[sx * 0.3, 2.2, -0.5], [sx * 0.44, 2.3, -0.36], [sx * 0.56, 2.26, -0.16], [sx * 0.62, 2.14, -0.04]], 0.028);
    r.box('torso', 'dark', 0.05, 0.62, 0.5, sx * 0.565, 1.94, 0);                 // 侧面的散热槽
    for (let i = 0; i < 5; i++) r.box('torso', 'steel', 0.012, 0.03, 0.42, sx * 0.594, 1.72 + i * 0.11, 0);
    r.tube('torso', 'steel', [sx * 0.3, 2.34, 0.2], [sx * 0.3, 2.4, 0.12], 0.014); r.tube('torso', 'steel', [sx * 0.3, 2.4, 0.12], [sx * 0.3, 2.34, 0.04], 0.014); // 吊环
  }
  r.cable('torso', [[0.3, 1.76, -0.5], [0.52, 1.66, -0.4], [0.7, 1.6, -0.16], [0.76, 1.56, 0.1]], 0.05);  // 弹链管
  for (let i = 0; i < 5; i++) r.box('torso', 'steel', 0.3, 0.014, 0.012, 0, 1.72 + i * 0.035, 0.345); // 胸口下方的进气栅
  r.box('torso', 'accent', 0.2, 0.12, 0.012, 0.24, 2.2, 0.334); r.box('torso', 'dark', 0.74, 0.1, 0.26, 0, 2.3, -0.42);
  r.box('head', 'body', 0.4, 0.3, 0.42, 0, 2.5, 0.04);
  for (const sx of [-1, 1]) { r.box('head', 'dark', 0.05, 0.2, 0.26, sx * 0.21, 2.5, 0.02); r.bolt('head', sx * 0.24, 2.5, 0.02, 'x', 0.035); r.sph('head', 'eye', 0.016, sx * 0.13, 2.6, 0.252); }
  r.box('head', 'dark', 0.18, 0.12, 0.16, 0, 2.5, -0.22);
  r.box('head', 'eye', 0.3, 0.065, 0.04, 0, 2.52, 0.255);
  r.box('head', 'dark', 0.3, 0.1, 0.1, 0, 2.4, 0.22);
  r.box('head', 'accent', 0.12, 0.04, 0.4, 0, 2.665, 0.04);
  r.cyl('head', 'dark', 0.012, 0.34, 0.17, 2.8, -0.12);
  r.sph('head', 'eye', 0.02, 0.17, 2.98, -0.12);

  for (const s of [-1, 1]) {
    const a = s < 0 ? 'armL1' : 'armR1';
    r.box(a, 'body', 0.4, 0.38, 0.48, s * 0.76, 2.04, 0);
    r.box(a, 'accent', 0.41, 0.07, 0.3, s * 0.76, 2.12, 0);
    for (const dz of [-0.18, 0.18]) { r.bolt(a, s * 0.76 - 0.13, 2.235, dz, 'y', 0.03); r.bolt(a, s * 0.76 + 0.13, 2.235, dz, 'y', 0.03); }
    r.cyl(a, 'dark', 0.15, 0.06, s * 0.975, 2.02, 0, 'x'); r.bolt(a, s * 1.01, 2.02, 0, 'x', 0.05);
  }
  // 护盾：四周一圈加强边、背面的握架、正面的铆钉和警示条
  for (const sy of [-1, 1]) r.box('armL2', 'dark', 0.62, 0.05, 0.09, -0.82, 1.42 + sy * 0.5, 0.44);
  for (const sx of [-1, 1]) { r.box('armL2', 'dark', 0.05, 1.04, 0.09, -0.82 + sx * 0.29, 1.42, 0.44); for (let i = 0; i < 5; i++) r.bolt('armL2', -0.82 + sx * 0.29, 0.98 + i * 0.22, 0.49, 'z', 0.022); }
  for (let i = 0; i < 4; i++) r.box('armL2', 'dark', 0.07, 0.1, 0.006, -1.0 + i * 0.12, 1.7, 0.484, [0, 0, 0.5]);
  r.piston('armL1', [-0.78, 1.96, -0.14], [-0.8, 1.56, -0.08], 0.03);
  // 左臂挂护盾
  r.seg('armL1', 'dark', [-0.78, 1.9, 0], [-0.8, 1.52, 0.04], 0.2);
  r.sph('armL2', 'dark', 0.12, -0.8, 1.52, 0.04);
  r.seg('armL2', 'body', [-0.8, 1.52, 0.04], [-0.8, 1.26, 0.3], 0.18);
  r.box('armL2', 'body', 0.6, 1.04, 0.07, -0.82, 1.42, 0.44, undefined, 0.03);
  r.box('armL2', 'accent', 0.6, 0.1, 0.075, -0.82, 1.7, 0.445);
  r.box('armL2', 'dark', 0.3, 0.16, 0.076, -0.82, 1.3, 0.445);        // 观察窗
  // 右臂是炮
  r.seg('armR1', 'dark', [0.76, 1.9, 0], [0.76, 1.66, 0.08], 0.22);
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
    r.seg(k + '1', 'body', hip, knee, 0.3, 0.36);
    r.box(k + '1', 'accent', 0.2, 0.3, 0.05, s * 0.32, 0.98, 0.21);
    r.sph(k + '2', 'dark', 0.15, ...knee);
    r.box(k + '2', 'body', 0.26, 0.18, 0.1, s * 0.33, 0.7, 0.2);      // 护膝
    r.seg(k + '2', 'dark', knee, ankle, 0.22, 0.26);
    r.box(k + '2', 'body', 0.26, 0.36, 0.08, s * 0.33, 0.4, 0.16);    // 胫甲
    r.cyl(k + '2', 'body', 0.035, 0.4, s * 0.33, 0.4, -0.14);         // 小腿后面的液压杆
    r.sph(k + '3', 'dark', 0.11, ...ankle);
    r.box(k + '3', 'body', 0.34, 0.14, 0.58, s * 0.33, 0.07, 0.1);
    r.box(k + '3', 'dark', 0.3, 0.1, 0.16, s * 0.33, 0.05, -0.22);
    r.piston(k + '1', [s * 0.33, 1.14, -0.2], [s * 0.34, 0.74, -0.14], 0.04);
    r.piston(k + '2', [s * 0.33 + s * 0.13, 0.6, 0.02], [s * 0.33 + s * 0.13, 0.2, -0.02], 0.028);
    r.cyl(k + '2', 'body', 0.17, 0.05, s * 0.33 + s * 0.14, 0.68, 0.07, 'x'); r.bolt(k + '2', s * 0.33 + s * 0.172, 0.68, 0.07, 'x', 0.05);
    for (const dy of [-0.1, 0.1]) for (const dx of [-0.08, 0.08]) r.bolt(k + '2', s * 0.33 + dx, 0.4 + dy, 0.202, 'z');
    for (const c of [-0.1, 0, 0.1]) r.box(k + '3', 'steel', 0.07, 0.06, 0.12, s * 0.33 + c, 0.04, 0.42);  // 脚趾
    r.cable(k + '1', [[s * 0.2, 1.2, 0.16], [s * 0.2, 0.96, 0.22], [s * 0.24, 0.76, 0.2]], 0.02);
  }
  return r.build();
}

function gull(): RigDef {
  const r = new RigBuilder();
  r.bone('root', null, 0, 0, 0);
  r.bone('head', 'root', 0, 0.04, 0.46);
  r.bone('tail', 'root', 0, 0.02, -0.5);
  r.sph('root', 'body', 0.26, 0, 0, 0, 0.9, 0.72, 2.1);
  r.box('root', 'accent', 0.26, 0.05, 0.5, 0, 0.175, -0.05);
  r.box('root', 'dark', 0.2, 0.1, 0.5, 0, -0.17, 0.05);               // 腹部挂架
  r.cyl('root', 'dark', 0.035, 0.5, 0, -0.24, 0.3, 'z');              // 机腹炮
  r.cyl('root', 'dark', 0.11, 0.18, 0, 0, -0.56, 'z', 0.08);          // 尾喷口
  r.sph('root', 'eye', 0.07, 0, 0, -0.6, 1, 1, 0.5);
  for (const s of [-1, 1]) r.box('root', 'dark', 0.08, 0.1, 0.3, s * 0.2, 0.02, 0.1); // 进气道

  // 细节：机背的检修盖螺栓、机腹的传感器球、天线、尾喷口的调节片
  for (const s of [-1, 1]) for (const dz of [-0.24, 0.14]) r.bolt('root', s * 0.1, 0.203, -0.05 + dz, 'y', 0.016);
  r.sph('root', 'dark', 0.07, 0, -0.2, -0.16); r.sph('root', 'eye', 0.03, 0, -0.255, -0.14);
  r.tube('root', 'dark', [0, 0.18, -0.24], [0, 0.4, -0.34], 0.008); r.sph('root', 'accent', 0.014, 0, 0.4, -0.34);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283; r.box('root', 'steel', 0.05, 0.012, 0.1, Math.cos(a) * 0.1, Math.sin(a) * 0.1, -0.67, [0, 0, a + 1.57]); }
  for (const s of [-1, 1]) { r.tube('root', 'steel', [s * 0.07, -0.2, 0.1], [s * 0.07, -0.2, 0.5], 0.012); for (let i = 0; i < 3; i++) r.box('root', 'steel', 0.012, 0.07, 0.012, s * 0.243, 0.02, 0.02 + i * 0.07); }
  r.box('head', 'body', 0.26, 0.22, 0.32, 0, 0.05, 0.62);
  r.cyl('head', 'accent', 0.085, 0.3, 0, 0.01, 0.92, 'z', 0.012);     // 喙
  for (const s of [-1, 1]) r.sph('head', 'eye', 0.045, s * 0.115, 0.09, 0.72, 0.6, 1, 1);
  r.box('head', 'dark', 0.2, 0.04, 0.2, 0, 0.17, 0.6);

  r.box('tail', 'body', 0.52, 0.035, 0.3, 0, 0.04, -0.7);
  r.box('tail', 'body', 0.04, 0.3, 0.26, 0, 0.2, -0.7, [-0.3, 0, 0]);
  r.box('tail', 'accent', 0.52, 0.036, 0.06, 0, 0.04, -0.84);

  for (const s of [-1, 1]) {
    const k = s < 0 ? 'wingL' : 'wingR';
    r.bone(k + '1', 'root', s * 0.2, 0.1, 0.04); r.bone(k + '2', k + '1', s * 0.98, 0.1, 0);
    r.sph(k + '1', 'dark', 0.08, s * 0.22, 0.1, 0.04);
    r.box(k + '1', 'body', 0.8, 0.045, 0.46, s * 0.6, 0.1, 0, undefined, 0.02);
    r.box(k + '1', 'dark', 0.74, 0.05, 0.06, s * 0.6, 0.1, 0.22);     // 前缘
    r.cyl(k + '1', 'dark', 0.035, 0.1, s * 0.98, 0.1, 0, 'z');        // 翼中段的折叠铰链
    r.box(k + '2', 'body', 0.72, 0.035, 0.36, s * 1.34, 0.1, -0.03, [0, s * 0.12, 0], 0.015);
    r.box(k + '2', 'accent', 0.14, 0.04, 0.3, s * 1.72, 0.1, -0.1, [0, s * 0.12, 0]);
    for (let i = 0; i < 4; i++) r.box(k + '1', 'dark', 0.014, 0.052, 0.4, s * (0.34 + i * 0.17), 0.1, 0);   // 翼肋
    r.piston(k + '1', [s * 0.2, 0.02, -0.12], [s * 0.56, 0.07, -0.14], 0.016);                             // 扇翅用的作动筒
    r.cyl(k + '1', 'dark', 0.05, 0.16, s * 0.62, 0.05, 0.04, 'z'); r.sph(k + '1', 'eye', 0.02, s * 0.62, 0.05, 0.13); // 翼下的小发动机
    r.sph(k + '2', 'eye', 0.014, s * 1.78, 0.125, -0.1);
    for (let i = 0; i < 3; i++) r.box(k + '2', 'dark', 0.18, 0.018, 0.2, s * (1.14 + i * 0.2), 0.1, -0.27 - i * 0.02, [0, s * 0.2, 0], 0.008); // 翼羽
  }
  return r.build();
}

const DEFS: Partial<Record<string, RigDef>> = {};
export function rigDef(kind: 'gull' | 'hound' | 'guard'): RigDef {
  return (DEFS[kind] ??= kind === 'gull' ? gull() : kind === 'hound' ? hound() : guard());
}
