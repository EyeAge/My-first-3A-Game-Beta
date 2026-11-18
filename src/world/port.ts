import * as THREE from 'three';
import { Colliders } from './colliders';
import { buildDetails } from './details';
import { NavGrid } from './nav';
import { labelMaterial } from '../render/labels';
import { weathered } from '../render/weathered';
import { flares, lightCones } from './props';
import { buildAnnex } from './annex';
import { buildForklift } from './forklift';
import { layContainers, layShipCargo } from './layout/containers';
import { GATE, layGate } from './layout/gate';
import { layQuay } from './layout/quay';
import { layRoad } from './layout/road';
import { Stage } from './layout/stage';
import { layWest, MAST } from './layout/west';
import { placeOnce, PropField } from './propfield';
import { CARGO } from './props/cargo';
import { EQUIPMENT, wheelChock } from './props/equipment';
import type { RainShelter } from './rain';
import { buildRelay, type Relay, type RelaySpec } from './relay';
import { buildWorkshop, placeWorkshop, WORKSHOP } from './workshop';
import { buildWorkshopFit, placeWorkshopFit, WORKSHOP_PROPS } from './workshopfit';
import type { ReflectionUniforms } from '../render/reflection';
import { buildGround } from './ground';
import { SUN_COLOR, SUN_INTENSITY } from './atmosphere';
import { CONTAINER_COLORS, CONTAINER_SIZES } from './container';
import { ContainerField } from './containerfield';
import { signTexture, windowsTexture } from './textures';

// 激战港区 · 四号泊位。
// 坐标约定：+x 是东（海在东边），-z 是北。玩家从西南角进场，撤离艇在码头南端。

export const QUAY_X = 62;
export const BOUNDS = { minX: -110, maxX: QUAY_X, minZ: -100, maxZ: 100 };
const INDOOR_DRAW_RANGE = 100;          // 离车间多少米以内才画屋里的东西

export type { Relay }; // 中继柜的接口定义在 relay.ts；从这里再导出一次，用到它的地方（mission.ts）不用改
export interface Port {
  group: THREE.Group;
  colliders: Colliders;
  nav: NavGrid;
  /** 全场的集装箱。平时用不着直接碰它；调试时可以看 containers.count（一共多少只）、containers.detailCount（此刻多少只在用精模）。 */
  containers: ContainerField;
  relays: Relay[];
  playerStart: THREE.Vector3;
  evacPos: THREE.Vector3;
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh;
  reflection: ReflectionUniforms;
  /** 室内范围（维修车间）。体积光、枪身的环境光都要知道"哪里算屋里"。 */
  interior: THREE.Box3;
  /**
   * 车间里面的东西（陈设、道具、叉车、乙号中继）。它们只有隔着门洞才看得见，所以单独收成一组：
   * 画湿地面的倒影时可以整组跳过（main.ts），人离得很远时也整组不画（见 update）。
   */
  indoor: THREE.Group;
  /** 给雨用的：哪个盒子里不下雨、屋顶哪里有洞、哪条屋檐在滴水。 */
  shelter: RainShelter;
  /** 拍室内环境探针的位置（屋子正中、一人多高）。 */
  probePos: THREE.Vector3;
  setLampCount(n: number): void;
  update(t: number, focus: THREE.Vector3): void;
}

export function buildPort(progress: (msg: string) => void): Port {
  const group = new THREE.Group();
  const colliders = new Colliders();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const col = new THREE.Color();

  // ---------------------------------------------------------------- 地面（湿路面、积水、标线都在 ground.ts）
  progress('正在生成港区地面');
  const { mesh: ground, group: groundGroup, reflection } = buildGround(QUAY_X);
  group.add(groundGroup);

  // ---------------------------------------------------------------- 通用"盒子"批次
  // 起重机钢梁、灯杆、围墙、木箱……所有方盒子都塞进同一个 InstancedMesh，一次绘制调用画完。
  const beamList: { m: THREE.Matrix4; c: number }[] = [];
  const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number, solid = false) => {
    beamList.push({ m: new THREE.Matrix4().compose(v1.set(cx, cy, cz), q.identity(), v2.set(sx, sy, sz)), c });
    if (solid) colliders.add(cx, cy, cz, sx, sy, sz);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  /** 在两点之间架一根斜梁。 */
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, th: number, c: number, th2 = th) => {
    const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = d.length();
    q.setFromUnitVectors(UP, d.normalize());
    beamList.push({ m: new THREE.Matrix4().compose(v1.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), q.clone(), v2.set(th, len, th2)), c });
  };

  // ---------------------------------------------------------------- 集装箱
  // 全场的箱子都交给一个 ContainerField：它负责实例化绘制、按远近切换精模 / 简模、登记碰撞盒（containerfield.ts）。
  // 这里先把它建出来，岸桥、货轮、堆场各自往里"报"箱子（堆场和零散箱子的清单在 layout/containers.ts）；
  // 等全部报完，在下面"室外场地的陈设"那里统一 build()
  const containers = new ContainerField({ seed: 4207 });

  // ---------------------------------------------------------------- 起重机
  progress('正在架设起重机');
  const CRANE = 0x8a4a1c, CRANE_D = 0x2a2d30, RAIL = 0xb38d2c;
  const craneLights: THREE.Vector3[] = [];
  // 发光的小方块（灯具的透光罩、亮着灯的窗户）：不受光照影响，亮度超过 1 的部分会被泛光晕开
  const glows: { x: number; y: number; z: number; sx: number; sy: number; sz: number; r: number; g: number; b: number }[] = [];
  const glow = (x: number, y: number, z: number, sx: number, sy: number, sz: number, r: number, g: number, b: number) => glows.push({ x, y, z, sx, sy, sz, r, g, b });
  const flareList: Parameters<typeof flares>[0] = [];
  /** 一段带立柱的栏杆，从 a 到 b（两端高度可以不同，用在楼梯上）。 */
  const railing = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, posts: number) => {
    for (const h of [0.55, 1.1]) beam(ax, ay + h, az, bx, by + h, bz, 0.05, RAIL);
    for (let i = 0; i <= posts; i++) { const k = i / posts, x = ax + (bx - ax) * k, y = ay + (by - ay) * k, z = az + (bz - az) * k; beam(x, y, z, x, y + 1.1, z, 0.05, RAIL); }
  };
  /** 岸桥（岸边集装箱起重机）。cz 是它在码头上的位置，trolleyX 是小车停在大梁上的位置，cargo 是吊具下那只箱子的颜色。 */
  const crane = (cz: number, trolleyX: number, cargo: number) => {
    const X1 = 34, X2 = 58, Z = 8, TOP = 42, G0 = 21, G1 = 105, GB = TOP + 1.6, GT = TOP + 4.6; // 大梁的起止位置、下弦和上弦的高度
    // 四条门腿，脚下是行走台车：一根平衡梁压着四组车轮
    for (const x of [X1, X2]) for (const s of [-1, 1]) {
      box(x, TOP / 2 + 1, cz + s * Z, 1.3, TOP - 2, 1.1, CRANE, true);
      box(x, 1.55, cz + s * Z, 1.5, 0.9, 5.4, CRANE_D, true);
      for (const k of [-2, -0.7, 0.7, 2]) { box(x, 0.55, cz + s * Z + k, 1.0, 1.1, 1.05, 0x1c1e20); box(x, 0.4, cz + s * Z + k, 1.16, 0.5, 0.5, 0x3d4144); }
      box(x, 2.5, cz + s * Z, 1.9, 0.5, 1.7, CRANE);
    }
    // 门框：海陆两侧的横梁、沿轨道方向的联系梁，再加斜撑
    for (const x of [X1, X2]) box(x, 3.2, cz, 0.9, 1.1, Z * 2, CRANE);
    for (const y of [14, TOP]) {
      for (const x of [X1, X2]) box(x, y, cz, 1.0, 1.3, Z * 2, CRANE);
      for (const s of [-1, 1]) box((X1 + X2) / 2, y, cz + s * Z, X2 - X1, 1.3, 1.0, CRANE);
    }
    for (const s of [-1, 1]) {
      beam(X1, 14, cz + s * Z, X2, TOP, cz + s * Z, 0.55, CRANE);
      beam(X2, 14, cz + s * Z, X1, TOP, cz + s * Z, 0.55, CRANE);
    }
    for (const x of [X1, X2]) { beam(x, 14, cz - Z, x, 28, cz + Z, 0.5, CRANE); beam(x, 14, cz + Z, x, 28, cz - Z, 0.5, CRANE); beam(x, 28, cz - Z, x, TOP, cz + Z, 0.4, CRANE); beam(x, 28, cz + Z, x, TOP, cz - Z, 0.4, CRANE); box(x, 28, cz, 0.6, 0.7, Z * 2, CRANE); }
    // 大梁：两榀桁架（上弦、下弦、竖杆、斜杆），中间用横撑和交叉撑连起来
    for (const s of [-1, 1]) {
      const z = cz + s * 3;
      box((G0 + G1) / 2, GT, z, G1 - G0, 0.5, 0.6, CRANE);
      box((G0 + G1) / 2, GB, z, G1 - G0, 0.7, 0.9, CRANE);
      for (let x = G0, i = 0; x <= G1; x += 4, i++) {
        beam(x, GB, z, x, GT, z, 0.28, CRANE);
        if (x < G1) i % 2 ? beam(x, GT, z, x + 4, GB, z, 0.24, CRANE) : beam(x, GB, z, x + 4, GT, z, 0.24, CRANE);
      }
    }
    for (let x = G0, i = 0; x <= G1; x += 8, i++) {
      box(x, GT, cz, 0.3, 0.3, 6, CRANE);
      if (x < G1) i % 2 ? beam(x, GT, cz - 3, x + 8, GT, cz + 3, 0.2, CRANE) : beam(x, GT, cz + 3, x + 8, GT, cz - 3, 0.2, CRANE);
    }
    // 大梁外侧的检修走道和栏杆
    box((G0 + G1) / 2, GB - 0.3, cz + 4.1, G1 - G0, 0.08, 1.1, CRANE_D);
    railing(G0, GB - 0.26, cz + 4.6, G1, GB - 0.26, cz + 4.6, 21);
    // A 字架和拉索
    for (const s of [-1, 1]) {
      beam(42, GT, cz + s * 3, 54, 62, cz + s * 1.2, 0.8, CRANE);
      beam(64, GT, cz + s * 3, 54, 62, cz + s * 1.2, 0.8, CRANE);
      beam(54, 62, cz + s * 1.2, 102, GT + 0.3, cz + s * 3, 0.3, CRANE_D);
      beam(54, 62, cz + s * 1.2, 82, GT + 0.3, cz + s * 3, 0.26, CRANE_D);
      beam(54, 62, cz + s * 1.2, 23, GT + 0.3, cz + s * 3, 0.3, CRANE_D);
    }
    for (const y of [50, 56]) { const k = (y - GT) / (62 - GT), w = 3 - 1.8 * k; box(42 + 12 * k, y, cz, 0.4, 0.4, w * 2, CRANE); box(64 - 10 * k, y, cz, 0.4, 0.4, w * 2, CRANE); }
    box(54, 62, cz, 1.4, 1.2, 4, CRANE);
    // 机房：屋顶挑檐、百叶窗、门、亮着灯的窗
    const MY = GT + 0.25 + 2.5;
    box(38, MY, cz, 11, 5, 8.5, 0x3a4046);
    box(38, MY + 2.62, cz, 11.6, 0.24, 9.1, 0x24282c);
    for (const dx of [-3.4, 0, 3.4]) for (const s of [-1, 1]) box(38 + dx, MY + 0.9, cz + s * 4.27, 2, 1.3, 0.06, 0x1d2124);
    box(43.52, MY - 0.9, cz - 2, 0.06, 2.1, 1, 0x23282c);
    glow(43.53, MY + 0.6, cz + 1.6, 0.05, 0.9, 2.2, 0.13, 0.12, 0.1);
    railing(32.6, MY + 2.74, cz - 4.5, 43.4, MY + 2.74, cz - 4.5, 6); railing(32.6, MY + 2.74, cz + 4.5, 43.4, MY + 2.74, cz + 4.5, 6);
    // 小车、司机室、吊具
    box(trolleyX, GB - 1.0, cz, 5, 1.0, 7.4, CRANE_D);
    for (const s of [-1, 1]) for (const e of [-1, 1]) box(trolleyX + e * 1.8, GB - 0.42, cz + s * 3, 0.9, 0.5, 0.5, 0x1c1e20);
    box(trolleyX + 3.6, GB - 3.1, cz + 2.2, 2.6, 2.6, 2.8, 0x4a5258);
    box(trolleyX + 3.6, GB - 1.74, cz + 2.2, 3.0, 0.14, 3.2, 0x24282c);
    glow(trolleyX + 4.92, GB - 3.3, cz + 2.2, 0.04, 1.5, 2.3, 0.16, 0.18, 0.2);   // 司机室的落地玻璃
    glow(trolleyX + 3.6, GB - 3.9, cz + 3.62, 1.9, 0.9, 0.04, 0.16, 0.18, 0.2);
    for (const s of [-1, 1]) for (const e of [-1, 1]) beam(trolleyX + e * 1, GB - 1.5, cz + s * 2, trolleyX + e * 1, 27.4, cz + s * 4, 0.07, CRANE_D);
    box(trolleyX, 27.2, cz, 2.0, 0.7, 9, CRANE_D);                                 // 吊具上架
    box(trolleyX, 26.3, cz, 2.5, 0.45, 12.4, RAIL);                               // 吊具
    for (const s of [-1, 1]) box(trolleyX, 26.3, cz + s * 6.1, 2.6, 0.7, 0.3, CRANE_D);
    // 吊具下吊着一只 40 尺箱，箱顶贴着吊具的底面（y = 26）。它悬在二十多米高的地方，谁也走不到跟前：永远用简模，也不登记碰撞
    containers.add({ size: 40, x: trolleyX, y: 26 - CONTAINER_SIZES[40].height, z: cz, yaw: Math.PI / 2, color: cargo, lodOnly: true, solid: false });
    // 楼梯塔：贴着陆侧门腿，一段一段折返上到大梁
    const SZ = cz - Z - 1.5;
    for (const dx of [-2.2, 2.2]) for (const dz of [-0.7, 0.7]) beam(X1 + dx, 0, SZ + dz, X1 + dx, TOP + 1.2, SZ + dz, 0.14, CRANE);
    for (let y = 0, i = 0; y < TOP - 1; y += 3.5, i++) {
      const dir = i % 2 ? -1 : 1, xa = X1 - dir * 1.6, xb = X1 + dir * 1.6, z = SZ + (i % 2 ? 0.35 : -0.35);
      for (const dz of [-0.3, 0.3]) beam(xa, y, z + dz, xb, y + 3.5, z + dz, 0.09, CRANE_D);
      for (let k = 0; k < 12; k++) { const t = (k + 0.5) / 12; box(xa + (xb - xa) * t, y + 3.5 * t, z, 0.25, 0.03, 0.6, CRANE_D); }
      railing(xa, y, z + (i % 2 ? 0.34 : -0.34), xb, y + 3.5, z + (i % 2 ? 0.34 : -0.34), 3);
      box(xb + dir * 0.3, y + 3.5, SZ, 0.9, 0.06, 1.5, CRANE_D);                   // 休息平台
      box(X1, y + 3.5, SZ + 0.75, 4.4, 0.1, 0.1, CRANE); box(X1, y + 3.5, SZ - 0.75, 4.4, 0.1, 0.1, CRANE);
    }
    box(X1, TOP + 1.2, SZ + 2.4, 1.2, 0.08, 6.4, CRANE_D);                          // 通到大梁走道的栈桥
    // 作业照明：挂在大梁下面的一排投光灯
    for (const x of [28, 46, 70, 92]) for (const s of [-1, 1]) { box(x, GB - 0.5, cz + s * 3.9, 0.7, 0.3, 0.5, 0x1c1e20); glow(x, GB - 0.68, cz + s * 3.9, 0.56, 0.06, 0.36, 0.55, 0.5, 0.42); flareList.push({ x, y: GB - 0.75, z: cz + s * 3.9, r: 1.3, g: 1.1, b: 0.85, size: 1.5 }); }
    craneLights.push(new THREE.Vector3(54, 62.9, cz), new THREE.Vector3(104.5, GT + 0.8, cz), new THREE.Vector3(21.5, GT + 0.8, cz));
  };
  // 两台岸桥：[在码头上的位置 z, 小车停在大梁上的位置 x]。码头的摆放清单（layout/quay.ts）要知道门腿在哪，好在腿脚下立防撞柱
  const CRANES = [[-42, 78], [20, 86]] as const;
  CRANES.forEach(([cz, trolleyX], i) => crane(cz, trolleyX, i ? CONTAINER_COLORS.teal : CONTAINER_COLORS.orange));

  // ---------------------------------------------------------------- 货轮
  const HULL = 0x121c26;
  box(84, 3, -30, 36, 12, 130, HULL, true);
  box(84, 0.1, -30, 36.3, 2.2, 130.3, 0x6a1f18);
  box(84, 9.3, -30, 36.6, 0.9, 130.6, 0x1a2630);
  // 船楼：一层一层的甲板，每层挑出一圈带栏杆的走廊；顶上是带翼桥的驾驶台、桅杆和雷达
  const HOUSE = 0x80827e, DECK = 0x4c5052;
  box(84, 20, 20, 30, 21, 18, HOUSE);
  for (let k = 0; k < 5; k++) {
    const y = 13 + k * 3.5;
    box(84, y, 20, 31.6, 0.22, 19.6, DECK);
    for (const h of [0.55, 1.05]) { box(68.25, y + h, 20, 0.06, 0.06, 19.6, DECK); box(84, y + h, 10.25, 31.6, 0.06, 0.06, DECK); }
    for (let z = 10.3; z <= 29.8; z += 2.44) box(68.25, y + 0.55, z, 0.06, 1.1, 0.06, DECK);
    for (let x = 68.3; x <= 99.7; x += 2.62) box(x, y + 0.55, 10.25, 0.06, 1.1, 0.06, DECK);
  }
  box(84, 31.5, 20, 34, 2.4, 14, 0x757772);                                    // 驾驶台，两头伸出去的是翼桥
  box(84, 32.85, 20, 35, 0.3, 15, DECK);
  box(84, 36, 26, 5, 8, 6, 0x2a3138); // 烟囱
  box(84, 37.5, 26, 5.2, 1.4, 6.2, 0xb85a1c);
  box(84, 40.1, 26, 4.4, 0.3, 5.4, 0x16181a);
  beam(84, 33, 17, 84, 43, 17, 0.5, DECK); box(84, 39.5, 17, 7, 0.25, 0.25, DECK); box(84, 41.5, 17, 4, 0.2, 0.2, DECK); // 桅杆
  box(84, 43.2, 17, 3.2, 0.3, 0.5, 0x9a9d9a); box(81, 39.9, 17, 0.9, 0.6, 0.9, 0x9a9d9a);                               // 雷达天线
  for (const z of [13.5, 26]) { box(68.1, 14.6, z, 1.7, 1.7, 5.4, 0xb85a1c); box(68.1, 15.9, z, 0.2, 1.2, 0.2, DECK); } // 救生艇
  for (const [x, y, z, r, g, b, blink] of [[84, 43.6, 17, 1.6, 1.5, 1.3, 0], [67.2, 33.3, 20, 0.2, 1.4, 0.4, 0], [84, 40.5, 26, 1.8, 0.12, 0.08, 2.4]] as const) flareList.push({ x, y, z, r, g, b, size: 1.6, blink });
  const winMat = (cols: number, rows: number, seed: number, lit: number, k: number) => new THREE.MeshBasicMaterial({ map: windowsTexture(cols, rows, seed, lit), color: new THREE.Color(k, k, k), transparent: true, depthWrite: false, fog: true });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(18, 17.5), winMat(14, 5, 11, 0.3, 1.25));
  win.rotation.y = -Math.PI / 2; win.position.set(68.97, 21.75, 20);
  const win2 = new THREE.Mesh(new THREE.PlaneGeometry(28.6, 17.5), winMat(22, 5, 23, 0.26, 1.25));
  win2.rotation.y = Math.PI; win2.position.set(84, 21.75, 10.97);
  // 驾驶台是一整圈连着的大窗，里面只亮着仪表的冷光
  const br = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 1.5), winMat(11, 1, 5, 1, 0.45));
  br.rotation.y = -Math.PI / 2; br.position.set(66.97, 31.7, 20);
  const br2 = new THREE.Mesh(new THREE.PlaneGeometry(33.4, 1.5), winMat(27, 1, 9, 1, 0.45));
  br2.rotation.y = Math.PI; br2.position.set(84, 31.7, 12.97);
  group.add(win, win2, br, br2);

  // ---------------------------------------------------------------- 维修车间和附属库房
  progress('正在搭建维修车间');
  // 车间是按参考的坐标搭的（workshop.ts），这里整体平移 (−88, +19.5) 挪到地图西侧，占 x −104…−76、z −8.5…8.5。
  // 朝向不变：东门（z −2.5…2.5）正对堆场和太阳，贴着海面来的晨光能从门洞一直照到屋子深处；南面是卷帘门。
  // 屋外那根电缆从东南角外那根高杆灯的杆顶拉到东南檐角（坐标是车间自己的，所以要减去平移量）
  const SHOP_DX = -88, SHOP_DZ = 19.5;
  const shell = buildWorkshop({ mastCables: [[[MAST.x - SHOP_DX, MAST.cableY, MAST.z - SHOP_DZ], [12.3, 7.3, -11.3], 0.9]] });
  // 屋里的陈设（workshopfit.ts）：夹层办公室、走道和钢梯、工作台、龙门吊架、九组货架、地上的油渍和电缆。
  // 它要知道屋面的洞在哪（每个洞的正下方贴一块漏雨的水渍），认的是车间自己的坐标 —— 所以用还没平移过的那一份 roofHoles
  const fit = placeWorkshopFit(buildWorkshopFit({ roofHoles: shell.roofHoles }), SHOP_DX, SHOP_DZ);
  const shop = placeWorkshop(shell, SHOP_DX, SHOP_DZ);
  // 屋里的东西都收进 indoor 这一组（陈设在这里加，道具、叉车、乙号中继在后面加），方便整组开关
  const indoor = new THREE.Group();
  indoor.name = 'indoor';
  indoor.add(fit.group);
  group.add(shop.group, indoor);
  // 碰撞盒逐个登记（墙是薄的，门洞留着）。盒子上带的标记原样传进去：surface 决定弹着和脚步的声音，
  // noNav 是"寻路不用管它"（屋面、细柱子），playerOnly 是"只挡人不挡子弹"（栏杆、吊架的 A 字腿）。
  // 3 厘米厚的地坪也登记：人走进门会被它垫高 3 厘米（迈得上去），和摆在地坪上的道具、钢梯的第一级对得上；子弹打在屋里的地上，弹孔也才贴在地坪面上而不是埋在它下面
  for (const b of [...shop.boxes, ...fit.boxes]) colliders.add((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2, b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], b);
  // 屋里的 4 盏点光：太阳照不到的角落靠它们给一层暖色的底光。它们很弱（正下方地面的照度大约只有太阳的九分之一），不投影
  for (const l of shop.lights) {
    const lamp = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
    lamp.position.set(l.pos[0], l.pos[1], l.pos[2]);
    group.add(lamp);
  }
  const interior = new THREE.Box3(new THREE.Vector3(...shop.interior.min), new THREE.Vector3(...shop.interior.max));
  const shelter: RainShelter = { boxes: [interior], holes: shop.roofHoles, eave: { x0: interior.min.x, x1: interior.max.x, z: interior.max.z + 0.28, y: 7 } };
  // 北边隔一条 4 米的夹道是三号库房：进不去，当背景
  group.add(placeOnce(buildAnnex(), -90, -23.5, 0, colliders));
  const plane = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, emissive = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.1, emissiveMap: emissive ? tex : null, emissive: new THREE.Color(emissive ? 0xffffff : 0), emissiveIntensity: emissive }));
    m.position.set(x, y, z); m.rotation.y = ry;
    group.add(m);
    return m;
  };
  plane(signTexture(['危险', '请勿靠近 · 自动作业车辆'], { stripe: true }), 2.4, 1.2, -75.9, 2.6, -13.6, Math.PI / 2);
  plane(signTexture(['门禁控制', '仅限授权人员'], { bg: '#b53a24', fg: '#f3ece0' }), 2.0, 1.0, -75.9, 2.6, -33.2, Math.PI / 2);

  // ---------------------------------------------------------------- 围墙与岸壁
  const WALL = 0x4a4d4e, WALL_W = -112, WALL_E = 64;           // 南北两道围墙从 x −112 砌到 64
  box((WALL_W + WALL_E) / 2, 2.2, BOUNDS.minZ - 0.6, WALL_E - WALL_W, 4.4, 1.2, WALL, true);
  box(BOUNDS.minX - 0.6, 2.2, 0, 1.2, 4.4, 202, WALL, true);
  // 南围墙在主干道的尽头开一个门洞（门扇、门柱、岗亭在 layout/gate.ts 里摆），所以分成东西两段；
  // 洞口两边各砌一个比墙厚、比墙高的门垛，顶上压一块盖板。
  // 门洞不用另外封：玩家的位置本来就被夹在 BOUNDS 以内（player.ts），走到门口就停住了 —— 看得见外面，子弹也打得出去
  const PIER = 1.6, southZ = BOUNDS.maxZ + 0.6;
  for (const [from, to] of [[WALL_W, GATE.x0 - PIER], [GATE.x1 + PIER, WALL_E]]) box((from + to) / 2, 2.2, southZ, to - from, 4.4, 1.2, WALL, true);
  for (const x of [GATE.x0 - PIER / 2, GATE.x1 + PIER / 2]) {
    box(x, 2.5, southZ, PIER, 5, 1.5, 0x55585a, true);
    box(x, 5.1, southZ, PIER + 0.24, 0.2, 1.74, 0x3c3f41);
  }
  plane(signTexture(['激战港区 · 南门', '出场车辆请停车交验'], { bg: '#1d3a5c', fg: '#f3ece0' }), 3.2, 1.6, GATE.x0 - PIER - 2.6, 2.9, BOUNDS.maxZ - 0.03, Math.PI);
  box(QUAY_X + 0.4, -1.6, 0, 0.8, 3.2, 600, 0x3c3f40); // 岸壁

  // ---------------------------------------------------------------- 撤离艇
  const evacPos = new THREE.Vector3(66, 0, 90);
  box(66.1, -0.8, 90, 7.8, 1.6, 16, 0x2b3238, true);
  box(66.1, 0.05, 90, 8.2, 0.25, 16.4, 0x9a3b26);
  box(66.6, 1.4, 84.6, 4.6, 2.8, 4.2, 0x8f9498, true);
  box(66.6, 2.95, 84.6, 5.2, 0.3, 4.8, 0x2b3238);
  for (const z of [82.2, 97.8]) box(66.1, 0.6, z, 7.6, 0.1, 0.1, 0xb38d2c);
  box(69.9, 0.6, 90, 0.1, 0.1, 15.6, 0xb38d2c);
  plane(signTexture(['激战撤离艇', '四号登船点'], { bg: '#1b2227', fg: '#ffb347' }), 3.2, 1.6, 64.25, 1.5, 84.6, -Math.PI / 2, 0.5);

  // ---------------------------------------------------------------- 中继
  // 三只中继柜（造型在 props/site.ts，摆放和状态机在 relay.ts）。柜门原本朝南，yaw 照参考各转一点，不会三只都横平竖直。
  // 乙号在车间正中：屋脊线的正下方、东门和南门两条通道的交点上，柜门转向东门，从两个门口都能一眼看到；东墙破口漏进来的那束光正好罩着它。
  // 它的位置由陈设给出（地上那根从北墙拖过来的电缆就是冲着它去的）
  const relaySpecs: RelaySpec[] = [
    { name: '甲号中继 · 堆场', short: '甲', x: 8, z: 0, yaw: 0.35 },
    { name: '乙号中继 · 车间', short: '乙', x: fit.relayPos[0], y: fit.relayPos[1], z: fit.relayPos[2], yaw: 0.9 * (Math.PI / 2), interior: true },
    { name: '丙号中继 · 码头', short: '丙', x: 48, z: -8, yaw: -0.2 },
  ];
  const relays = relaySpecs.map((spec, id) => {
    const { relay, group: cabinet } = buildRelay(id, spec, colliders);
    (spec.interior ? indoor : group).add(cabinet);
    return relay;
  });

  // ---------------------------------------------------------------- 室外场地的陈设
  // 道具不是均匀撒的，而是"一组一组"摆：每一组像是有人干活干到一半留下的 —— 叉车叉着货停在半路、
  // 发电机拖着电缆带一盏投光灯、中继柜脚下拖着从配电箱引来的粗电缆。这样既是掩体，也让场地像真的有人用过。
  // 清单按地方分成四个文件（layout/）；它们只管往 stage 上"报"东西，最后由 stage.build() 统一生成网格和碰撞盒
  progress('正在布置场地');
  const stage = new Stage(colliders);
  layGate(stage);
  layRoad(stage);
  layQuay(stage, QUAY_X, CRANES.map(([cz]) => cz));
  layWest(stage);
  // 集装箱也在这里摆：冷藏箱的机组是道具，要赶在 stage.build() 之前报上去。
  // 货轮甲板上的箱格：12 行 × 7 列，第一摞在船身的西北角，甲板面高 9.75 米（船身和甲板的尺寸见上面"货轮"一段）。
  // 第 3、4 列正好在一号岸桥（z = −42）的两边 —— 那里正在卸货
  progress('正在布置集装箱');
  layContainers(containers, stage);
  layShipCargo(containers, stage, { x: 69.6, y: 9.75, z: -86, rows: 12, bays: 7, rowPitch: 2.62, bayPitch: 12.6 }, [3, 4]);
  group.add(stage.build());
  group.add(containers.build(colliders)); // 碰撞盒在这一步登记（箱顶是金属面，开门箱是空壳）；必须排在下面建寻路网格之前

  // 车间里面的通用道具：清单在 workshopfit.ts（WORKSHOP_PROPS，车间自己的坐标，这里加上平移量）。
  // 全部用"室内版"材质 —— 淋不到雨，反射的是屋里而不是天空。二十几件几乎件件不同，实例化帮不上忙，
  // 所以单开一份清单、用 buildMerged 按材质焊成十几个网格（见 propfield.ts）。
  // 叉车例外：它自己就有十五种材质，单独摆（和甲号中继旁那台一样）—— 停在东南角，货叉落地，脚下垫着一块钢板
  const indoorProps = new PropField();
  const INDOOR_MODELS = { ...CARGO, ...EQUIPMENT };
  for (const p of WORKSHOP_PROPS) {
    const x = p.x + SHOP_DX, z = p.z + SHOP_DZ, y = p.y ?? WORKSHOP.floor, args = { ...p.args, interior: true }; // 不写高度的都站在地坪面上
    if (p.name === 'forklift') {
      indoor.add(placeOnce(buildForklift(args), x, z, p.yaw, colliders, y));
      // 停着的叉车，两只后轮后面各塞一只轮挡。后轮在车身后方 1.1 米、左右各 0.46 米（forklift.ts）；
      // 轮挡的斜面朝它自己的 +x，所以和车同向摆、再往后退 0.36 米，斜面正好顶住轮胎
      const c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      for (const side of [-1, 1]) indoorProps.place(wheelChock({ interior: true, seed: side + 1 }), x - 1.46 * c + side * 0.46 * sn, z + 1.46 * sn + side * 0.46 * c, p.yaw, y);
    } else indoorProps.place(INDOOR_MODELS[p.name](args), x, z, p.yaw, y);
  }
  indoor.add(indoorProps.buildMerged(colliders));
  // 贴纸和喷字全场共用一个材质（render/labels.ts）。它不分屋里屋外，映出来的永远是天空 —— 屋里地上那两摊发亮的油渍于是泛着一层天蓝色。
  // 所以给屋里的贴片换上它的一份副本，标成"室内"：main.ts 会让带这个标记的材质改映屋里的环境（副本和原件共用同一张图集）
  const outdoorLabels = labelMaterial(), indoorLabels = outdoorLabels.clone();
  indoorLabels.userData.interior = true;
  indoor.traverse((o) => { if ((o as THREE.Mesh).material === outdoorLabels) (o as THREE.Mesh).material = indoorLabels; });

  group.add(buildDetails(colliders, BOUNDS));

  // ---------------------------------------------------------------- 灯
  // 灯具有三样东西要画，都在这里汇总：
  //   glows   灯具上发光的小方块（岸桥的作业灯、障碍灯、亮着灯的窗）；高杆灯、投光灯的灯面是道具模型自带的
  //   flares  远处那一点柔和的光晕
  //   cones   灯下雨雾里那个朦胧的光锥
  craneLights.forEach((p) => { glow(p.x, p.y, p.z, 0.3, 0.3, 0.3, 1.2, 0.08, 0.06); flareList.push({ x: p.x, y: p.y, z: p.z, r: 2.2, g: 0.14, b: 0.1, size: 2.2, blink: 2.2 }); }); // 航空障碍灯：慢慢地一明一灭
  flareList.push(...stage.flares);
  const glowMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 6.1, 4.1) }), glows.length); // 灯罩的亮度是白纸的好几倍：泛光会把超出的部分晕开，湿地面里也会映出它
  glows.forEach((gl, i) => { glowMesh.setMatrixAt(i, m4.compose(v1.set(gl.x, gl.y, gl.z), q.identity(), v2.set(gl.sx, gl.sy, gl.sz))); glowMesh.setColorAt(i, col.setRGB(gl.r, gl.g, gl.b)); });
  group.add(glowMesh);
  const flare = flares(flareList);
  group.add(flare.points);
  group.add(lightCones(stage.cones));
  // 灯是往下照的：用聚光灯在地上打出一圈一圈的光斑，而不是朝四面八方发光的灯泡。
  // 真正发光的灯只有几盏（多了每个像素都要多算几盏灯），哪几个灯位离玩家最近就"借"给谁。
  // 候选灯位由摆放清单登记：每根高杆灯一个、每只投光灯架一个
  const lampSpots = stage.lamps;
  const lightPool: THREE.SpotLight[] = [];
  for (let i = 0; i < 8; i++) {
    const l = new THREE.SpotLight(0xffc48a, 0, 40, 1.08, 0.85, 1.5);
    lightPool.push(l); group.add(l, l.target);
  }
  let lampCount = 6;

  // ---------------------------------------------------------------- 把收集到的东西变成网格
  const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), weathered(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 })), beamList.length);
  beamList.forEach((b, i) => { beamMesh.setMatrixAt(i, b.m); beamMesh.setColorAt(i, col.setHex(b.c)); });
  beamMesh.castShadow = beamMesh.receiveShadow = true;
  group.add(beamMesh);

  // ---------------------------------------------------------------- 光照
  // 全场只有这一盏"真灯"：贴着海面照过来的太阳。没有环境光灯 —— 阴影里的亮度来自天空的环境贴图（main.ts）。
  // 阴影相机的范围和跟随玩家的逻辑在 render/shadows.ts
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  group.add(sun, sun.target);

  const nav = new NavGrid(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxX, BOUNDS.maxZ, colliders);

  const order = lampSpots.map((_, i) => i);
  let lastSort = -1;
  return {
    group, colliders, nav, containers, relays, evacPos, sun, ground, reflection, interior, indoor, shelter,
    probePos: new THREE.Vector3((interior.min.x + interior.max.x) / 2, 2.4, (interior.min.z + interior.max.z) / 2),
    playerStart: new THREE.Vector3(-18, 0, 93),
    setLampCount(n) { lampCount = n; lastSort = -1; },
    update(t, focus) {
      flare.uniforms.uTime.value = t;
      shop.update?.(t); // 排风扇
      for (const r of relays) r.update(t); // 中继柜的灯、天线、柜门
      // 屋里的东西有十几万个三角形、七十来个网格。隔着 100 米，门洞在画面上只剩指甲盖大，里面又暗，画了也看不出来 —— 干脆不画。
      // （地图上能直着看进门洞的最远的地方是南围墙根，离车间 92 米，所以这个距离上不会看到东西突然冒出来）
      indoor.visible = interior.distanceToPoint(focus) < INDOOR_DRAW_RANGE;
      stage.cull(focus); // 室外的道具也一样：离得远的整片不画（layout/stage.ts）。全场只有十来片，每帧算一遍不费事
      containers.update(focus); // 集装箱：近处的换成精模，远处的换回简模。它自己会控制节奏，每帧调没关系
      if (t - lastSort > 0.4) {
        lastSort = t;
        // 按水平距离排：高杆灯挂在 13 米高处，要是算直线距离，它永远排在两米高的投光灯后面
        const flat = (i: number) => (lampSpots[i].pos.x - focus.x) ** 2 + (lampSpots[i].pos.z - focus.z) ** 2;
        order.sort((a, b) => flat(a) - flat(b));
        lightPool.forEach((l, i) => {
          l.visible = i < lampCount && i < order.length;
          if (!l.visible) return;
          const spot = lampSpots[order[i]];
          l.position.copy(spot.pos); l.target.position.copy(spot.target); l.intensity = spot.intensity; l.angle = spot.angle;
        });
      }
    },
  };
}
