import * as THREE from 'three';
import { mulberry32, pick } from '../../core/math';
import type { Colliders } from '../colliders';
import type { PropModel } from '../kit';
import { placeOnce, PropField } from '../propfield';
import { barrel, crateStack, crateWood, jerryCan, palletStack, trafficCone } from '../props/cargo';
import { FLOODLIGHT_HEADS, FLOODLIGHT_LAMP, floodlightStand, generator, groundCable, type CablePoint } from '../props/equipment';
import { bollardPost, fencePanel, jerseyBarrier, lightMast, LIGHT_MAST_LAMPS } from '../props/site';

// 室外场地的"摆放台"。
//
// 港区里的道具有两百多件，分属大门、主干道、堆场通道、码头、车间外的场院几块地方。每块地方的清单各写在
// 本目录的一个文件里（gate.ts / road.ts / quay.ts / west.ts），它们都只做一件事：往这个 Stage 上"报"东西 ——
// 哪个模型摆在哪、朝哪；哪里有一盏灯。等全部报完，port.ts 调一次 build()，Stage 再决定这些东西怎么画最省。
//
// 为什么要绕这一道，而不是每个文件自己 new 一个 PropField？因为"怎么画最省"要看全场。
// 室外的道具种类多（四十来种模型，每种又分颜色、个体）、每种的件数少，而它们用到的材质翻来覆去就是那几十种。
// 这种情况下实例化帮不上忙（每种模型的每种材质各占一次绘制调用），划算的是 PropField.buildMerged：
// 把挨在一起的东西按材质焊成一个网格。所以这里把场地切成方格，每一格焊一次 ——
// 一格里不管摆了多少件，绘制调用数都只是"这一格用到了几种材质"；整格不在镜头里、或者离得太远时，一个三角形都不用画。

/** 一盏"能借到真灯"的灯位。真正发光的聚光灯全场只有几盏（见 port.ts 的灯池），谁离玩家近就借给谁。 */
export interface LampSpot {
  /** 灯在哪。 */
  pos: THREE.Vector3;
  /** 朝哪照：聚光灯对准的那一点。 */
  target: THREE.Vector3;
  /** 发光强度（坎德拉）。地面上的亮度 ≈ 强度 ÷ 距离的 1.5 次方，所以挂得越高的灯要给得越大。 */
  intensity: number;
  /** 光锥的半张角（弧度）。 */
  angle: number;
}
/** 一个光晕（props.ts 的 flares）：远处看灯具本身只有一两个像素，要靠它才是"一点灯光"。 */
export interface FlareSpot { x: number; y: number; z: number; r: number; g: number; b: number; size: number; blink?: number }
/** 灯下那个朦胧的光锥（props.ts 的 lightCones）：锥尖在灯上，沿 dir 张开 length 米，底面半径 radius。 */
export interface ConeSpot { pos: THREE.Vector3; dir: THREE.Vector3; length: number; radius: number }

/**
 * 把场地切成多大的方格（米）。格子小，镜头外的东西剔得干净（少画三角形），但每格都要把那几十种材质各画一遍（绘制调用多）；
 * 格子大则反过来。试过 50 / 70 / 100：70 米时两头都还过得去 —— 全场分成十格（比如大门区是一格，车间连同南面的场院是一格）。
 */
const CELL = 70;
/**
 * 离玩家多远以外的格子整格不画（米）。隔着 100 米，一只油桶在画面上只有五六个像素高，又隔着雨雾，画不画看不出来；
 * 而从地图一头望向另一头时，这一刀能省掉三分之一的道具。
 * 高杆灯例外（见 place 的 landmark）：它有 14 米高，隔着整张地图都看得见，所以一直画。
 */
const DRAW_RANGE = 100;

interface Placement { model: PropModel; x: number; z: number; yaw: number; y: number; landmark: boolean }

export class Stage {
  /** 灯池的候选灯位。 */
  readonly lamps: LampSpot[] = [];
  readonly flares: FlareSpot[] = [];
  readonly cones: ConeSpot[] = [];
  /** 不走 PropField 的东西（叉车这种自带十几种材质的大件）直接挂在这一组下面。 */
  readonly group = new THREE.Group();
  private placements: Placement[] = [];
  /** build() 之后：每一格里"离远了就不画"的那部分，和它们占的范围（给 cull 用）。 */
  private cells: { group: THREE.Group; box: THREE.Box3 }[] = [];
  private rng = mulberry32(1);

  constructor(readonly colliders: Colliders) { this.group.name = 'site'; }

  /**
   * 换一串随机数。每块场地开头调一次、各用各的种子：这样改了大门区的清单（多用或少用了几个随机数），
   * 码头上那些靠随机数决定的小偏差不会跟着全变。
   */
  reseed(seed: number) { this.rng = mulberry32(seed); }
  /** ±a 之间的随机数。东西都带一点偏差，才不会摆得横平竖直。 */
  jit(a: number) { return (this.rng() - 0.5) * 2 * a; }
  /** 0…1 的随机数。 */
  rand() { return this.rng(); }
  pick<T>(list: readonly T[]): T { return pick(this.rng, list); }

  /**
   * 把一件道具摆到 (x, z)，绕竖轴转 yaw（正的 yaw 让模型的 +x 从世界 +x 转向 -z，和 PropField 一致）；y 是离地高度。
   * landmark 为真的是"地标"：又高又显眼，离得再远也照画。
   */
  place(model: PropModel, x: number, z: number, yaw = 0, y = 0, landmark = false) {
    this.placements.push({ model, x, z, yaw, y, landmark });
    return this;
  }

  /** 只摆一件、又不适合拆开合并的大东西：直接把模型挪到位，马上登记碰撞盒。 */
  once(model: PropModel, x: number, z: number, yaw = 0) {
    this.group.add(placeOnce(model, x, z, yaw, this.colliders));
    return this;
  }

  /** 全部报完以后调一次：生成网格、登记碰撞盒。 */
  build(): THREE.Group {
    // 按方格分堆。每一格出两个网格组：普通道具（离远了整格藏起来）和地标（一直画）
    const cells = new Map<string, { near: PropField; far: PropField; box: THREE.Box3; hasFar: boolean }>();
    for (const p of this.placements) {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { near: new PropField(), far: new PropField(), box: new THREE.Box3(), hasFar: false }));
      (p.landmark ? cell.far : cell.near).place(p.model, p.x, p.z, p.yaw, p.y);
      if (p.landmark) { cell.hasFar = true; continue; }
      // 记下这一格的普通道具占了多大一块地方：cull 要算玩家离这块地方有多远
      const reach = Math.hypot(p.model.size[0], p.model.size[2]) / 2; // 这件东西从摆放点往四周最多伸出去多远
      cell.box.expandByPoint(_v.set(p.x - reach, 0, p.z - reach)).expandByPoint(_v.set(p.x + reach, p.y + p.model.size[1], p.z + reach));
    }
    for (const [key, cell] of cells) {
      if (!cell.box.isEmpty()) {
        const group = cell.near.buildMerged(this.colliders);
        group.name = `site:${key}`;   // 名字里带上格子的编号，调试时一眼看得出是哪一片
        this.group.add(group);
        this.cells.push({ group, box: cell.box });
      }
      if (cell.hasFar) {
        const group = cell.far.buildMerged(this.colliders);
        group.name = `site:${key}:landmarks`;
        this.group.add(group);
      }
    }
    this.placements = [];
    return this.group;
  }

  /** 每帧调一次：离 focus（玩家）太远的格子整格藏起来。 */
  cull(focus: THREE.Vector3) {
    for (const cell of this.cells) cell.group.visible = cell.box.distanceToPoint(focus) < DRAW_RANGE;
  }
}
const _v = new THREE.Vector3();

// ====================================================================== 小工具

/**
 * "摆在 (x, z)、转了 turn 的一组东西"里的相对位置 → 世界坐标。
 * 一组道具（比如发电机 + 灯架 + 油壶）先按"发电机在原点、不转"写好相对位置，再整组挪过去、转个角度，就不用每件都手算。
 */
export function frame(x: number, z: number, turn: number) {
  const c = Math.cos(turn), s = Math.sin(turn);
  return (dx: number, dz: number): [number, number] => [x + dx * c + dz * s, z - dx * s + dz * c];
}

// ====================================================================== 成组的摆法
// 道具不是均匀撒的，而是"一组一组"摆：每一组像是有人干活干到一半留下的。下面这些函数各摆一种常见的组合。

const BARREL_COLORS = ['blue', 'red', 'green', 'yellow'] as const;

/** 一小片油桶：n 只立着的三只一排挤在一起，外加一只倒在旁边的。 */
export function barrels(s: Stage, x: number, z: number, n: number, fallen = true) {
  for (let i = 0; i < n; i++) s.place(barrel({ color: s.pick(BARREL_COLORS), seed: i, open: s.rand() < 0.15 }), x + (i % 3) * 0.66 + s.jit(0.04), z + Math.floor(i / 3) * 0.66 + s.jit(0.04), s.rand() * 6.28);
  if (fallen) s.place(barrel({ color: s.pick(BARREL_COLORS), lying: true, seed: n }), x + 2.3 + s.jit(0.3), z + 0.4 + s.jit(0.4), s.rand() * 6.28);
}

/** 成对的油桶：两只挨着，一只正放、一只转个角度 —— 比孤零零一只可信得多。 */
export function barrelPair(s: Stage, x: number, z: number, color: (typeof BARREL_COLORS)[number], yaw = 0) {
  const at = frame(x, z, yaw);
  s.place(barrel({ color, seed: 1 }), ...at(0, 0), yaw);
  s.place(barrel({ color: s.pick(BARREL_COLORS), seed: 2 }), ...at(0.72, 0.1 + s.jit(0.06)), yaw + 0.4 + s.rand() * 0.5);
}

/** 木箱堆：一摞三只的塔，旁边一两只单的，再靠一摞托盘。整组朝 yaw 方向排开。 */
export function crates(s: Stage, x: number, z: number, yaw: number, extra = 2) {
  const at = frame(x, z, yaw);
  s.place(crateStack({ seed: Math.floor(s.rand() * 4) }), ...at(0, 0), yaw + s.jit(0.06));
  for (let i = 0; i < extra; i++) s.place(crateWood({ seed: i + Math.floor(s.rand() * 3) }), ...at(1.7 + i * 1.5, s.jit(0.25)), yaw + s.jit(0.2));
  s.place(palletStack({ count: 3 + Math.floor(s.rand() * 5), seed: Math.floor(s.rand() * 3) }), ...at(-1.8, 0.2), yaw + s.jit(0.15));
}

/** 一排路锥：从 (ax, az) 到 (bx, bz) 均匀摆 n 只，偶尔倒一只。 */
export function cones(s: Stage, ax: number, az: number, bx: number, bz: number, n: number) {
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0, lying = s.rand() < 0.14;
    s.place(trafficCone({ lying, seed: i }), ax + (bx - ax) * t + s.jit(0.1), az + (bz - az) * t + s.jit(0.1), lying ? s.rand() * 6.28 : s.jit(0.3));
  }
}

/**
 * 一排水泥隔离墩：从 (x, z) 起沿 yaw 方向首尾相接摆 n 只（每只 3 米，中间留 25 厘米的缝）。
 * 每只再往两边错开几厘米、歪一两度 —— 吊车放下来的东西不会对得那么齐。stripe 是带不带黄黑警示条。
 */
export function barrierRow(s: Stage, x: number, z: number, yaw: number, n: number, stripe = false) {
  const at = frame(x, z, yaw);
  for (let i = 0; i < n; i++) s.place(jerseyBarrier({ seed: Math.floor(s.rand() * 4), stripe }), ...at(i * 3.25, s.jit(0.07)), yaw + s.jit(0.04));
}

/** 在 (x, z) 周围立几根防撞柱。offsets 是每根相对这一点的位置。 */
export function bollards(s: Stage, x: number, z: number, offsets: readonly (readonly [number, number])[]) {
  for (const [dx, dz] of offsets) s.place(bollardPost({ seed: Math.floor(s.rand() * 4) }), x + dx, z + dz, s.rand() * 6.28);
}

/**
 * 一段铁丝网围栏，从 (ax, az) 拉到 (bx, bz)。
 * 按 3.35 米一跨算出要几片，再把每片搭成正好的长度（不是去拉伸模型）；除了最后一片两头都带立柱，其余只带起点那一侧的 —— 相邻两片共用一根柱子。
 * 柱顶挂刺丝的支臂朝"前进方向的左手边"斜出去：想让它朝哪边（应该朝外人来的那一边），就把起点和终点按那个方向给。
 */
export function fenceRun(s: Stage, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(len / 3.35)), length = len / n;
  const yaw = Math.atan2(-dz, dx); // 让围栏片的 +x（它的长边）指向前进方向
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    s.place(fencePanel({ length, posts: i === n - 1 ? 'both' : 'left', seed: i % 2 }), ax + dx * t, az + dz * t, yaw);
  }
}

/** 地上的一根电缆，路径点是世界坐标（[x, z] 贴地，[x, z, y] 指定高度）。r 是半径。 */
export function cable(s: Stage, points: CablePoint[], r = 0.025, seed = 0) {
  // 电缆模型的路径点是它自己的坐标。这里把原点挪到路径中间：摆放位置落在电缆所在的那一格里，分格才分得对
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length, cz = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const local = points.map((p) => (p.length > 2 ? [p[0] - cx, p[1] - cz, p[2]] : [p[0] - cx, p[1] - cz]) as CablePoint);
  s.place(groundCable({ points: local, r, seed }), cx, cz);
}

// ---------------------------------------------------------------------- 带灯的东西

/** 灯头的颜色（线性空间，给光晕用）：高杆灯是偏暖的白，投光灯更白一点。 */
const MAST_FLARE = { r: 1.5, g: 1.15, b: 0.75 }, FLOOD_FLARE = { r: 1.4, g: 1.3, b: 1.1 };
/** 灯池里那盏聚光灯挂在 9.86 米高时用 150 坎德拉（原来路灯的数）。别的高度按"地面一样亮"折算。 */
const spotIntensity = (height: number) => 150 * Math.pow(height / 9.86, 1.5);

/**
 * 立一根 14 米高杆灯。横担默认沿 z，4 只灯头背靠背朝 ±x；yaw 转 90° 就朝 ±z。
 * 除了模型，还登记：一个灯池灯位（从杆顶垂直往下照，一盏就能罩住杆子两边）、两个光晕、两个光锥。
 * guards 是杆脚要不要防撞柱、立在哪（相对杆子的位置）：贴着车道的灯杆都该有。
 */
export function mast(s: Stage, x: number, z: number, yaw = 0, guards: readonly (readonly [number, number])[] = []) {
  s.place(lightMast(), x, z, yaw, 0, true);   // 地标：离得再远也画
  const at = frame(x, z, yaw), y = LIGHT_MAST_LAMPS[0].pos[1];
  s.lamps.push({ pos: new THREE.Vector3(x, y - 0.1, z), target: new THREE.Vector3(x, 0, z), intensity: spotIntensity(y), angle: 1.08 });
  for (const side of [-1, 1]) {
    const [hx, hz] = at(side * 0.42, 0);                 // 这一侧两只灯头的正中间
    const [ox, oz] = at(side, 0);                        // 这一侧朝外的方向（世界坐标里的单位向量 = 这一点减去杆子的位置）
    s.flares.push({ x: hx, y: y - 0.08, z: hz, ...MAST_FLARE, size: 2.2 });
    // 灯头本身朝外下方 36° 照；光锥画得比它陡一些（约 63°）—— 雨雾里能看出来的主要是灯下那一团
    s.cones.push({ pos: new THREE.Vector3(hx, y, hz), dir: new THREE.Vector3((ox - x) * 0.45, -0.89, (oz - z) * 0.45).normalize(), length: 12.5, radius: 5.6 });
  }
  if (guards.length) bollards(s, x, z, guards);
}

/**
 * "临时照明"小场景：一台发电机、一只三脚投光灯、连着它俩的电缆、发电机旁边两只油壶。
 * 相对位置照参考：发电机在原点（自己再歪 0.15 弧度），灯架在它右前方 3 米、朝外照。
 * (x, z) 是发电机的位置，turn 把整组转一个角度：灯最后朝 (cos, −sin)(turn + 0.55) 那个方向照。
 */
export function generatorSet(s: Stage, x: number, z: number, turn: number, color: 'yellow' | 'orange' | 'blue' = 'yellow') {
  const at = frame(x, z, turn);
  s.place(generator({ color }), x, z, turn + 0.15);
  const [lx, lz] = at(2.8, -1.5), lampYaw = turn + 0.55;
  s.place(floodlightStand(), lx, lz, lampYaw);
  cable(s, [at(1.0, -0.2), at(1.8, -1.0), at(2.6, -1.3)], 0.02);
  s.place(jerryCan({ color: 'red' }), ...at(1.2, 1.0), turn + 0.4);
  s.place(jerryCan({ color: 'olive' }), ...at(0.9, 1.15), turn + 1.9);
  // 灯架的灯位数据是它自己坐标里的（equipment.ts），这里换算到世界坐标
  const lamp = frame(lx, lz, lampYaw);
  const [px, pz] = lamp(FLOODLIGHT_LAMP.pos[0], FLOODLIGHT_LAMP.pos[2]), py = FLOODLIGHT_LAMP.pos[1];
  const [ax, az] = lamp(FLOODLIGHT_LAMP.pos[0] + FLOODLIGHT_LAMP.dir[0], FLOODLIGHT_LAMP.pos[2] + FLOODLIGHT_LAMP.dir[2]);
  const dir = new THREE.Vector3(ax - px, FLOODLIGHT_LAMP.dir[1], az - pz).normalize();
  // 灯只有两米高、几乎平着照：强度给得小（不然灯架脚下那一小块地会亮得发白），照到 9 米外落地
  s.lamps.push({ pos: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(px, py, pz).addScaledVector(dir, 9), intensity: 60, angle: 0.8 });
  s.cones.push({ pos: new THREE.Vector3(px, py, pz), dir, length: 7, radius: 2.4 });
  for (const head of FLOODLIGHT_HEADS) { const [hx, hz] = lamp(head.pos[0], head.pos[2]); s.flares.push({ x: hx, y: head.pos[1], z: hz, ...FLOOD_FLARE, size: 1.1 }); }
}
