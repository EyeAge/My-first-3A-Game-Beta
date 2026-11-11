import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 第一人称枪模：激战九式突击步枪，加上握枪的双手。
// 坐标：枪口朝 -z，+x 是右，+y 是上，原点在机匣中心。
// 零件很多（一百多个），所以同一种材质的零件会合并成一个网格；只有要单独动的部件
// （弹匣、枪机、拉机柄、左手）各自成组。

type MatKey = 'steel' | 'poly' | 'tan' | 'dark' | 'glove' | 'sleeve' | 'bright';
type V3 = [number, number, number];

class Parts {
  private map = new Map<MatKey, THREE.BufferGeometry[]>();
  private add(mat: MatKey, g: THREE.BufferGeometry) {
    const n = g.index ? g.toNonIndexed() : g;
    let l = this.map.get(mat); if (!l) this.map.set(mat, (l = []));
    l.push(n);
  }
  box(mat: MatKey, sx: number, sy: number, sz: number, x: number, y: number, z: number, rot?: V3, r?: number) {
    const g = new RoundedBoxGeometry(sx, sy, sz, 2, r ?? Math.min(sx, sy, sz) * 0.22);
    if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
    g.translate(x, y, z); this.add(mat, g);
  }
  cyl(mat: MatKey, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'z', r2 = r, seg = 14) {
    const g = new THREE.CylinderGeometry(r2, r, len, seg);
    if (axis === 'x') g.rotateZ(-Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z); this.add(mat, g);
  }
  /** 连接两点的一段（手指、手臂）。 */
  seg(mat: MatKey, a: V3, b: V3, w: number, d = w) {
    const v = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = v.length();
    const g = new RoundedBoxGeometry(w, len + Math.min(w, d) * 0.5, d, 3, Math.min(w, d) * 0.45);
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()), new THREE.Vector3(1, 1, 1)));
    this.add(mat, g);
  }
  into(group: THREE.Object3D, mats: Record<MatKey, THREE.Material>) {
    for (const [k, list] of this.map) {
      const m = new THREE.Mesh(mergeGeometries(list, false), mats[k]);
      m.frustumCulled = false; // 枪贴着相机，包围球裁剪容易误判
      group.add(m);
    }
    return group;
  }
}

/** 机匣左侧的铭文。枪模在前后方向被压扁到 0.6，贴图面片相应做长，字看起来才不变形。 */
function markings() {
  const c = document.createElement('canvas'); c.width = 384; c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(214,214,206,0.9)'; g.textBaseline = 'middle';
  g.font = '800 30px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif'; g.fillText('激战九式 5.8毫米', 6, 24);
  g.font = '600 17px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif'; g.fillText('激战兵工厂 · 港区装备  JZ9-042719', 6, 56);
  g.fillStyle = 'rgba(214,150,60,0.9)'; g.fillText('警告：存放前必须清空弹膛', 6, 82);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export const SIGHT_Y = 0.092; // 红点瞄具光轴的高度：开镜时相机要对到这条线上

export function buildGun(worn: THREE.Texture) {
  const mats: Record<MatKey, THREE.Material> = {
    steel: new THREE.MeshStandardMaterial({ color: 0x5a6066, roughness: 0.48, metalness: 0.65, roughnessMap: worn, bumpMap: worn, bumpScale: 0.25 }),
    bright: new THREE.MeshStandardMaterial({ color: 0x9aa0a5, roughness: 0.3, metalness: 0.9 }),
    poly: new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.68, metalness: 0.1 }),
    tan: new THREE.MeshStandardMaterial({ color: 0x6a5d44, roughness: 0.78, metalness: 0.05, roughnessMap: worn }),
    dark: new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.9, metalness: 0.2 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.88, metalness: 0 }),
    sleeve: new THREE.MeshStandardMaterial({ color: 0x343a2b, roughness: 0.95, metalness: 0 }),
  };
  const gun = new THREE.Group();
  const p = new Parts();

  // ---- 机匣
  p.box('steel', 0.046, 0.05, 0.3, 0, 0.016, 0, undefined, 0.008);            // 上机匣
  p.box('poly', 0.042, 0.046, 0.2, 0, -0.028, 0.035, undefined, 0.008);       // 下机匣
  p.box('poly', 0.04, 0.062, 0.076, 0, -0.058, -0.068, [0.14, 0, 0], 0.006);  // 弹匣井
  p.box('dark', 0.004, 0.02, 0.066, 0.0222, 0.018, -0.03);                    // 抛壳窗
  p.box('steel', 0.006, 0.006, 0.07, 0.024, 0.031, -0.03);                    // 防尘盖铰链
  p.cyl('steel', 0.007, 0.022, 0.024, 0.012, 0.075, 'z');                     // 复进助推器
  p.cyl('bright', 0.0045, 0.05, 0, -0.012, -0.03, 'x');                       // 机匣销
  p.cyl('bright', 0.0045, 0.05, 0, -0.012, 0.11, 'x');
  p.cyl('steel', 0.007, 0.006, -0.0225, -0.02, 0.078, 'x');                   // 快慢机
  p.box('steel', 0.004, 0.006, 0.02, -0.0245, -0.02, 0.07);
  p.box('poly', 0.006, 0.02, 0.03, -0.0225, -0.03, -0.01);                    // 空仓挂机
  // ---- 导轨：一条底座 + 一排卡槽齿
  p.box('steel', 0.022, 0.008, 0.5, 0, 0.045, -0.15, undefined, 0.002);
  for (let i = 0; i < 26; i++) p.box('steel', 0.025, 0.005, 0.009, 0, 0.0515, 0.085 - i * 0.0188, undefined, 0.001);
  // ---- 护木：两侧有散热槽
  p.box('tan', 0.05, 0.056, 0.27, 0, 0.008, -0.3, undefined, 0.012);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
    p.box('dark', 0.004, 0.011, 0.04, s * 0.0238, 0.016, -0.2 - i * 0.058, undefined, 0.002);
    p.box('dark', 0.004, 0.011, 0.04, s * 0.0238, -0.004, -0.2 - i * 0.058, undefined, 0.002);
  }
  p.box('poly', 0.026, 0.008, 0.2, 0, -0.0225, -0.3, undefined, 0.002);        // 护木下导轨
  p.box('steel', 0.052, 0.058, 0.012, 0, 0.008, -0.168, undefined, 0.004);     // 护木箍
  // ---- 枪管、导气箍、制退器
  p.cyl('steel', 0.0095, 0.22, 0, 0.008, -0.53);
  p.box('steel', 0.022, 0.03, 0.03, 0, 0.014, -0.455, undefined, 0.004);
  p.cyl('steel', 0.0045, 0.11, 0, 0.026, -0.4);                                // 导气管
  p.cyl('steel', 0.014, 0.062, 0, 0.008, -0.645);
  p.cyl('steel', 0.0158, 0.008, 0, 0.008, -0.618);
  p.cyl('steel', 0.0158, 0.008, 0, 0.008, -0.674);
  for (let i = 0; i < 3; i++) for (const s of [-1, 1]) p.box('dark', 0.006, 0.012, 0.008, s * 0.0125, 0.008, -0.632 - i * 0.014, undefined, 0.001);
  p.cyl('dark', 0.0062, 0.003, 0, 0.008, -0.6772);                             // 枪口
  p.box('steel', 0.012, 0.012, 0.03, 0, 0.055, -0.41, undefined, 0.003);       // 折叠准星
  // ---- 红点瞄具
  p.box('steel', 0.036, 0.012, 0.062, 0, 0.056, -0.02, undefined, 0.003);
  for (const s of [-1, 1]) p.box('steel', 0.005, 0.056, 0.04, s * 0.0205, 0.09, -0.03, undefined, 0.002);
  p.box('steel', 0.046, 0.005, 0.042, 0, 0.12, -0.03, undefined, 0.002);
  p.box('steel', 0.014, 0.01, 0.016, 0, 0.066, 0.002, undefined, 0.002);       // 发光元件
  p.cyl('bright', 0.006, 0.008, 0.027, 0.068, -0.02, 'x');                     // 调节旋钮
  for (const s of [-1, 1]) p.cyl('bright', 0.004, 0.006, s * 0.02, 0.054, -0.04, 'x');
  // ---- 握把、扳机
  p.box('poly', 0.034, 0.1, 0.044, 0, -0.09, 0.115, [-0.33, 0, 0], 0.01);
  p.box('poly', 0.036, 0.012, 0.05, 0, -0.139, 0.132, [-0.33, 0, 0], 0.004);
  p.box('poly', 0.008, 0.004, 0.064, 0, -0.07, 0.045, undefined, 0.0015);
  p.box('poly', 0.008, 0.022, 0.004, 0, -0.06, 0.014, undefined, 0.0015);
  p.box('bright', 0.005, 0.022, 0.006, 0, -0.056, 0.05, [0.35, 0, 0], 0.002);
  // ---- 枪托
  p.cyl('poly', 0.013, 0.15, 0, 0.008, 0.225);
  p.box('poly', 0.034, 0.05, 0.11, 0, -0.012, 0.26, undefined, 0.01);
  p.box('poly', 0.026, 0.026, 0.09, 0, -0.045, 0.275, [0.25, 0, 0], 0.008);
  p.box('dark', 0.038, 0.1, 0.016, 0, -0.03, 0.322, undefined, 0.007);         // 托底胶垫
  p.cyl('bright', 0.006, 0.05, 0, -0.03, 0.22, 'x');                           // 背带环
  // ---- 右手：握住握把，食指搭在扳机护圈外
  p.box('glove', 0.05, 0.085, 0.056, 0.004, -0.098, 0.124, [-0.33, 0, 0], 0.016);
  for (let i = 0; i < 3; i++) p.seg('glove', [0.026, -0.078 - i * 0.021, 0.094 + i * 0.007], [-0.022, -0.074 - i * 0.021, 0.09 + i * 0.007], 0.018, 0.02);
  p.seg('glove', [0.022, -0.05, 0.1], [0.021, -0.047, 0.04], 0.015);
  p.seg('glove', [-0.024, -0.06, 0.13], [-0.025, -0.038, 0.085], 0.017);
  p.box('glove', 0.03, 0.02, 0.034, 0.012, -0.066, 0.152, [-0.33, 0, 0], 0.008); // 手背护甲
  p.seg('glove', [0.012, -0.125, 0.15], [0.03, -0.16, 0.2], 0.056, 0.05);
  p.seg('sleeve', [0.03, -0.16, 0.2], [0.16, -0.3, 0.62], 0.074, 0.068);
  p.box('dark', 0.078, 0.02, 0.07, 0.035, -0.165, 0.21, [-0.6, 0, -0.3], 0.008); // 袖口
  p.into(gun, mats);

  // ---- 铭文
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.024), new THREE.MeshStandardMaterial({ map: markings(), transparent: true, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mark.rotation.y = -Math.PI / 2; mark.position.set(-0.0232, 0.018, 0.02); mark.frustumCulled = false;
  gun.add(mark);

  // ---- 枪机：开火时在抛壳窗里往后一缩
  const bolt = new THREE.Group();
  const pb = new Parts(); pb.box('bright', 0.003, 0.015, 0.056, 0.0232, 0.018, -0.032, undefined, 0.001); pb.into(bolt, mats);
  gun.add(bolt);
  // ---- 拉机柄
  const handle = new THREE.Group();
  const ph = new Parts(); ph.box('steel', 0.034, 0.008, 0.02, 0, 0.036, 0.152, undefined, 0.002); ph.box('steel', 0.01, 0.008, 0.06, 0, 0.036, 0.12, undefined, 0.002); ph.into(handle, mats);
  gun.add(handle);

  // ---- 弹匣：略带弧度的两段
  const mag = new THREE.Group();
  const pm = new Parts();
  pm.box('poly', 0.03, 0.1, 0.058, 0, 0.0, -0.002, [0.16, 0, 0], 0.005);
  pm.box('poly', 0.03, 0.085, 0.058, 0, -0.078, 0.016, [0.3, 0, 0], 0.005);
  pm.box('dark', 0.034, 0.012, 0.064, 0, -0.122, 0.03, [0.3, 0, 0], 0.003);
  for (let i = 0; i < 4; i++) pm.box('dark', 0.032, 0.004, 0.05, 0, -0.02 - i * 0.026, 0.002 + i * 0.006, [0.2, 0, 0], 0.001);
  pm.into(mag, mats);
  mag.position.set(0, -0.115, -0.07);
  gun.add(mag);

  // ---- 左手：托住护木，换弹时会离开去拿弹匣
  const left = new THREE.Group();
  const pl = new Parts();
  pl.box('glove', 0.058, 0.03, 0.085, 0, -0.036, -0.29, undefined, 0.012);        // 手掌托在下面
  for (let i = 0; i < 4; i++) pl.seg('glove', [0.03, -0.034, -0.322 + i * 0.021], [0.031, 0.012, -0.322 + i * 0.021], 0.017); // 四指从右侧包上来
  pl.seg('glove', [-0.03, -0.03, -0.262], [-0.031, 0.014, -0.29], 0.018);          // 拇指在左侧
  pl.box('glove', 0.034, 0.012, 0.04, 0, -0.054, -0.28, undefined, 0.005);
  pl.seg('glove', [-0.004, -0.045, -0.25], [-0.03, -0.075, -0.19], 0.058, 0.05);
  pl.seg('sleeve', [-0.03, -0.075, -0.19], [-0.24, -0.28, 0.45], 0.074, 0.068);
  pl.box('dark', 0.078, 0.02, 0.07, -0.034, -0.08, -0.18, [-0.5, 0, 0.5], 0.008);
  pl.into(left, mats);
  gun.add(left);

  return { gun, mag, bolt, handle, left };
}
