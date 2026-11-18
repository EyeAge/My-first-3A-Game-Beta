import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 地面掩码：决定“哪里有积水”的那张图。
//
// 以前积水是在着色器里对一层噪声取阈值，结果是全场均匀的一片片圆斑，和道路、箱位、码头毫无关系。
// 真实的积水有它的道理：水往低处流，而路面哪里低是被“用”出来的 ——
// 重车反复碾过的地方压出车辙，拐弯和掉头的地方磨出浅盆，路是中间高两边低的，屋檐滴水线下面被砸出一排小坑。
//
// 所以这里的做法是：加载时在 CPU 上算一张“路面高度图”，
//   高度 = 0.5 + 两层噪声（自然的高低不平）
//              − 手摆的椭圆洼地 − 沿行车线的车辙和排水沟
//              + 路拱、码头边沿、井盖这些“一定比周围高”的地方
// 高度低于水位线的地方就有水。噪声自己几乎凑不出水洼（不到 1%），所以水在哪儿基本是摆出来的；
// 噪声的作用是决定每个洼地“出不出水、出多大”——有的洼地正好赶上一块高地，就只剩一片湿印，这样才不呆板。
//
// 烘出来的图有四个通道，地面着色器（ground.ts）各取所需：
//   R 路面高度（已换算成“离水位线多远”）   G 潮湿度（哪里更潮、哪里是干斑）
//   B 油渍                                 A 磨损（车流把路面磨光、把漆磨掉的程度）
// CPU 这边留着这份数据，玩法代码（踩水声、水花、子弹打水洼）用 puddleDepthAt() 查同一张图。

// ---------------------------------------------------------------- 噪声
// 和 core/math.ts 里的噪声相比多两样东西：种子（同一处可以取出互不相关的好几层），
// 以及“周期”（格点坐标取模，生成的图上下左右能无缝拼接——平铺的细节贴图要用）。

/** 整数格点 → 0..1 的伪随机数。 */
function latticeHash(ix: number, iy: number, seed: number) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
/** 值噪声，返回 0..1。period 不为 0 时每隔 period 格重复一次。 */
export function valueNoise(x: number, y: number, seed: number, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  let x0 = xi, x1 = xi + 1, y0 = yi, y1 = yi + 1;
  if (period) { x0 = ((x0 % period) + period) % period; x1 = ((x1 % period) + period) % period; y0 = ((y0 % period) + period) % period; y1 = ((y1 % period) + period) % period; }
  const a = latticeHash(x0, y0, seed), b = latticeHash(x1, y0, seed), c = latticeHash(x0, y1, seed), d = latticeHash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** 分形噪声：每层频率翻倍、幅度减半，结果仍在 0..1。 */
export function fractalNoise(x: number, y: number, seed: number, octaves = 4, period = 0) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x, y, seed + i * 17, period);
    norm += amp; x *= 2; y *= 2; period *= 2; amp *= 0.5;
  }
  return sum / norm;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, t: number) => { const k = clamp01((t - a) / (b - a)); return k * k * (3 - 2 * k); };

// ---------------------------------------------------------------- 常量

/** 水位线：路面高度低于它就有积水。想让全场水多一点或少一点，只改这一个数（0.01 大约对应几个百分点的面积）。 */
export const WATER_LEVEL = 0.385;
/** 高度差换算成“水深”的倍率：掩码和着色器里的水深 = (水位 − 高度) × 这个数。水深是相对量，约 0.22 就算“一掌深”。 */
const DEPTH_GAIN = 2.5;
/** 每个洼地统一再挖深一点。和水位线一样是全局旋钮，但只影响手摆的洼地，不影响噪声自己形成的水。 */
const BASIN_EXTRA = 0.02;
/** 洼地轮廓被噪声推歪的幅度，相对于它较短的那个半径（0 就是正椭圆）。 */
const BASIN_WARP = 0.45;
/** 水深超过这个值才算“踩得到水”。比 0 略大，是因为着色器还会用噪声把水边咬碎，贴着岸线的那几厘米说不准。 */
export const PUDDLE_THRESHOLD = 0.015;
/** 掩码盖住的世界范围：比可玩区域（x −110…62，z −100…100）四周各多出几米，留给边缘的过渡。 */
export const MASK_RECT = { x0: -116, z0: -106, w: 184, h: 212 };

// 下面这些数描述的是 port.ts 里的布局。港区布局改了，洼地和车辙要跟着这里一起改。
const ROAD_X = -18;                                   // 主干道中线；两侧黄色边线在 −25.7 和 −10.3
const ROAD_HALF = 7.7;
const LANE_X = [-21.85, -14.15];                      // 两条车道的中线
const BLOCK_X = [-58, -44, -30, -6, 8, 22];           // 集装箱堆位的中心（每个堆位占地 ±3.86 × ±12.34 米）
const BLOCK_Z = [-63.4, -31.7, 0, 31.7, 63.4];
const BLOCK_HALF_X = 3.86, BLOCK_HALF_Z = 12.34;
const AISLE_X = [-51, -37, 1, 15];                    // 堆位之间南北向的通道（宽约 6.3 米）
const CROSS_Z = [-47.55, -15.85, 15.85, 47.55];       // 堆位之间东西向的横向通道（宽约 7 米），和主干道相交成四个路口
const RAIL_X = [34, 58];                              // 岸桥的两条轨道
const QUAY_LANE_X = [41, 51];                         // 码头前沿两条轨道之间，车沿着走的两条线
// 西侧的三块地：能走进去的维修车间（屋里有自己的地坪）、它北边进不去的三号库房、南边露天的水泥场院。
// 车间东山墙上的大门在 x = −76、z −2.5…2.5，正对堆场；南墙的卷帘门在 z = 8.5、x −94…−89，开向场院。
// 库房是 port.ts 里以 (−90, −23.5) 为中心摆的 28×22 米的盒子，和车间之间隔着一条 4 米宽的夹道（z −12.5…−8.5）。
const WORKSHOP = { minX: -104, maxX: -76, minZ: -8.5, maxZ: 8.5 };
const ANNEX = { minX: -104, maxX: -76, minZ: -34.5, maxZ: -12.5 };
const YARD = { minX: -106, maxX: -74, minZ: 8.5, maxZ: 36 };
/** 有屋顶的地方：淋不到雨，不积水、也不潮。 */
const ROOFED = [WORKSHOP, ANNEX];
/**
 * 不摆洼地的地方：这里要立别的东西（港区大门、场院的铁丝网围栏），水洼正好窝在门柱和围栏脚下会很怪。
 * 只是“不在这里挖坑”，并不把地面垫高——噪声自己偶尔形成的一小片湿印还是会有。
 */
const KEEP_CLEAR = [
  { minX: -32, maxX: -4, minZ: 85.5, maxZ: 100 },      // 出生点（−18, 93）和它正前方的大门线
  { minX: -75, maxX: -73, minZ: 8.5, maxZ: 37 },       // 场院东侧的围栏线
  { minX: -107, maxX: -73, minZ: 35, maxZ: 37 },       // 场院南侧的围栏线
  { minX: -107, maxX: -105, minZ: 8.5, maxZ: 37 },     // 场院西侧的围栏线
];
/** 主干道上的车辙和路缘积水往南只画到这里：再往南是大门区（见 KEEP_CLEAR）。 */
const ROAD_RUT_SOUTH = 84.5;
/** 没有堆箱子的两个堆位：甲号中继所在的空场，和车间东门外的门前空场。 */
const EMPTY_BLOCKS: [number, number][] = [[8, 0], [-58, 0]];
/** 井盖的位置（details.ts 里贴的贴花）。井盖比路面略高，不能泡在水里。 */
const MANHOLES: [number, number][] = [[-21, 72], [-15, 30], [-21, -10], [-15, -52], [-21, -88], [30, 54], [30, -30], [52, 14], [52, -66], [-66, 8]];

// ---------------------------------------------------------------- 洼地

/** 一个椭圆洼地：中心 x、中心 z、x 方向半径、z 方向半径、深度（高度单位，0.16 浅，0.27 深）。 */
type Basin = [cx: number, cz: number, rx: number, rz: number, depth: number];

// 手摆的“主角”洼地：都在玩家一定会经过或者一眼能看到的地方。每个位置都有个说法——
// 写在注释里，是想说明这张表不是随便撒的点。
const HERO_BASINS: Basin[] = [
  // 出生点（−18, 93）一带：南端的掉头区，车在这里调头，磨出几个大浅盆。
  // 出生点脚下到斑马线（z 84…88）之间要留给大门，所以正前方那个水洼摆在斑马线的北沿
  [-19.6, 82.6, 3.4, 1.7, 0.24],   // 正前方十米：压着斑马线的北半边和停车线，一进游戏就能看到水下的白漆
  [-13.6, 77.2, 2.2, 1.5, 0.2],
  [-36.5, 88.5, 3.6, 1.9, 0.2],    // 大门两侧的空地：离主干道远一点，给门柱和岗亭让出位置
  [1.5, 91, 4.2, 1.7, 0.2],
  [9, 84, 2.6, 2.0, 0.18],
  [21, 88.5, 3.4, 2.2, 0.2],
  [-46, 85.5, 3.6, 2.0, 0.18],
  // 主干道的四个路口：横向车流和纵向车流在这里交叉、刹车、拐弯，路面被磨得最低
  [-16.4, 48.4, 6.5, 1.6, 0.24],
  [-19.6, 15.2, 7.0, 1.5, 0.27],
  [-17.0, -16.7, 6.0, 1.4, 0.22],
  [-20.2, -46.8, 6.5, 1.6, 0.24],
  // 路口的拐角：车拐弯时内侧轮子压出来的
  [-11.6, 44.6, 1.6, 2.4, 0.2],
  [-24.6, 18.8, 1.5, 2.6, 0.2],
  [-11.8, -12.8, 1.7, 2.2, 0.18],
  [-24.4, -50.6, 1.6, 2.4, 0.2],
  // 主干道中段，靠路边
  [-12.0, 64.5, 1.5, 4.2, 0.2],
  [-23.9, 60, 1.3, 3.2, 0.18],
  [-12.2, 30.5, 1.4, 3.6, 0.18],
  [-24.0, -3.5, 1.4, 4.0, 0.2],
  [-12.4, -30, 1.5, 3.4, 0.2],
  [-23.6, -68, 1.5, 3.8, 0.2],
  [-13.0, -84, 2.6, 1.6, 0.2],
  [-21.5, -93.5, 3.2, 1.7, 0.22],  // 北端掉头区
  // 横向通道（去甲号、乙号中继的路）
  [-37, 47.9, 3.4, 1.6, 0.2],
  [-51, 15.4, 3.0, 1.5, 0.18],
  [-44.5, -15.5, 3.8, 1.4, 0.2],
  [-58, -47.9, 3.0, 1.5, 0.18],
  [1.2, -16.2, 3.6, 1.5, 0.2],
  [15, 47.2, 3.2, 1.4, 0.18],
  [1, 15.5, 2.6, 1.3, 0.2],
  [15.4, -47.9, 3.0, 1.6, 0.2],
  [-3.4, 47.9, 2.4, 1.5, 0.18],
  [21.5, 16.2, 2.8, 1.4, 0.18],
  // 南北向通道
  [-51, -30, 1.5, 3.6, 0.17],
  [-37, 1.5, 1.6, 3.4, 0.18],
  [1, 32, 1.5, 3.6, 0.17],
  [15, 0.5, 1.7, 3.2, 0.18],
  [-37.6, 30, 1.4, 3.2, 0.18],
  [-36.4, -44, 1.5, 3.0, 0.18],
  // 甲号中继所在的空场（8, 0）
  [6.4, 3.6, 2.6, 1.7, 0.22],
  [9.9, -4.2, 2.2, 1.4, 0.18],
  [5.6, -9.6, 1.5, 1.2, 0.16],
  // 码头前沿
  [40, 30, 3.2, 2.0, 0.22],
  [52, 12, 3.4, 1.8, 0.2],
  [46, -20, 3.0, 2.6, 0.2],
  [36.2, -52, 1.4, 3.6, 0.16],     // 竖着的：顺着岸桥轨道
  [50, 78, 3.0, 2.0, 0.2],
  [45.4, -5.4, 2.6, 1.6, 0.22],    // 丙号中继（48, −8）跟前
  [50.8, -11.2, 2.0, 1.5, 0.18],
  [56.2, 87, 2.2, 3.2, 0.2],       // 去撤离艇的最后几步
  [35.8, 13, 1.3, 3.0, 0.18],      // 岸桥门腿的台车旁边
  [56.3, -35, 1.3, 3.2, 0.18],
  [30.5, 2, 1.6, 3.4, 0.18],       // 堆场和码头交界的那条线
  [29.5, -62, 1.5, 3.0, 0.18],
  [44, 56, 4.0, 1.8, 0.2],
  [47, -78, 3.6, 2.2, 0.2],
  // 车间东门外的门前空场（x −76…−50，z −12…12）：叉车进进出出、原地打方向，磨出两个浅盆
  [-70.6, 3.4, 3.2, 2.0, 0.22],    // 贴着大门偏南一点：门槛正前方留一条干路，水在轮子拐弯的那一侧
  [-60.5, -5.2, 3.8, 2.2, 0.2],    // 空场中央
  [-55.2, 8.0, 2.4, 1.4, 0.18],    // 空场和横向通道交界
  [-66.5, -13.5, 2.6, 1.5, 0.18],
  // 南卷帘门外的水泥场院（x −106…−74，z 8.5…36）
  [-90.2, 13.7, 2.9, 1.7, 0.22],   // 卷帘门正前方：淹掉禁停框靠外的一半，贴着坡板的那一半留在水面上
  [-83.5, 20.5, 2.0, 3.0, 0.18],
  [-99, 28, 3.2, 2.0, 0.2],        // 场院西南角：离门最远、最没人管的角落
  [-79.6, 30.4, 2.2, 1.5, 0.18],   // 场院东南角，离两道围栏各留出三米多
  // 车间和库房之间那条四米宽的夹道（中线 z = −10.5）：两边屋檐的水都往这里排，又晒不到太阳
  [-88, -10.6, 5.5, 0.9, 0.2],
  [-100.5, -10.4, 2.2, 0.8, 0.18],
  // 车间背后（x −110…−104）贴着西围墙的那条窄带：没人走，也没人修
  [-107.2, 1.5, 1.3, 3.4, 0.18],
  [-107.4, -21, 1.2, 2.8, 0.17],
  // 车间以南、以北的场地
  [-67, 40, 2.4, 3.0, 0.18],
  [-68.5, -44, 3.0, 2.0, 0.18],
];

// 落水管的出口：屋面的雨水汇进天沟，再顺着落水管冲到墙根，日子久了每个出口前面都冲出一个小坑。
// 位置照 workshop.ts（每榀刚架一根，南墙跳过卷帘门两侧的两根）和 annex.ts（东墙两个角、西墙一个角）。
const DOWNPIPE_X = [-103.1, -98.7, -93.8, -88.4, -82, -76.1];
const DOWNPIPE_BASINS: Basin[] = [
  ...DOWNPIPE_X.map((x): Basin => [x + 0.1, WORKSHOP.minZ - 0.75, 0.6, 0.5, 0.2]),                               // 北墙六根，排进夹道
  ...DOWNPIPE_X.filter((x) => x < -95 || x > -88).map((x): Basin => [x + 0.1, WORKSHOP.maxZ + 0.75, 0.6, 0.5, 0.2]), // 南墙四根，排进场院
  [ANNEX.maxX + 0.8, ANNEX.maxZ - 0.5, 0.55, 0.6, 0.19], [ANNEX.maxX + 0.8, ANNEX.minZ + 0.5, 0.55, 0.6, 0.19], [ANNEX.minX - 0.8, ANNEX.maxZ - 0.5, 0.55, 0.6, 0.19],
];

const inRect = (r: typeof WORKSHOP, x: number, z: number, margin = 0) => x > r.minX - margin && x < r.maxX + margin && z > r.minZ - margin && z < r.maxZ + margin;
/** 这个点是不是被集装箱堆位或者房子压着（洼地的中心不往这些地方摆）。 */
function occupied(x: number, z: number, margin = 0) {
  if (ROOFED.some((r) => inRect(r, x, z, margin))) return true;
  for (const bx of BLOCK_X) {
    if (Math.abs(x - bx) > BLOCK_HALF_X + margin) continue;
    for (const bz of BLOCK_Z) if (Math.abs(z - bz) < BLOCK_HALF_Z + margin && !EMPTY_BLOCKS.some(([ex, ez]) => ex === bx && ez === bz)) return true;
  }
  return false;
}

/**
 * 按规则补出其余的洼地。不是全场均匀乱撒，而是每一类地方用各自的摆法：
 * 通道里的顺着通道拉长，贴着箱脚；码头上的顺着轨道；空场上的大而圆。
 * 用固定种子的随机数，所以每次生成的都是同一座港区。
 */
function scatterBasins(quayX: number): Basin[] {
  const rng = mulberry32(90210);
  const out: Basin[] = [];
  const range = (a: number, b: number) => a + rng() * (b - a);
  const depth = () => range(0.16, 0.24);
  // 南北向通道：每隔十来米一个，竖长，偏向通道的一侧（水是贴着箱脚积的）
  for (const ax of AISLE_X) for (let z = -72 + rng() * 6; z < 74; z += range(9, 15)) {
    if (rng() < 0.25) continue;
    const long = range(2.0, 4.6);
    out.push([ax + range(-1.9, 1.9), z, long * range(0.3, 0.5), long, depth()]);
  }
  // 东西向的横向通道：横长
  for (const cz of CROSS_Z) for (let x = -60 + rng() * 5; x < 25; x += range(9, 15)) {
    if (Math.abs(x - ROAD_X) < ROAD_HALF + 2 || rng() < 0.25) continue; // 路口另有手摆的
    const long = range(2.0, 4.4);
    out.push([x, cz + range(-2.0, 2.0), long, long * range(0.32, 0.55), depth()]);
  }
  // 主干道：除了车辙，路边再补几个不规则的
  for (let z = -90 + rng() * 6; z < 76; z += range(12, 20)) {
    const side = rng() < 0.5 ? -1 : 1, long = range(1.8, 3.6);
    out.push([ROAD_X + side * range(4.6, 6.6), z, long * range(0.35, 0.6), long, range(0.16, 0.22)]);
  }
  // 码头前沿：轨道之间的作业带，大而缓；靠近轨道的顺着轨道拉长
  for (let z = -94 + rng() * 6; z < 96; z += range(7, 12)) {
    const x = range(29, quayX - 3), nearRail = RAIL_X.some((r) => Math.abs(x - r) < 2.5), long = range(1.8, 4.2);
    if (nearRail || rng() < 0.4) out.push([x, z, long * range(0.3, 0.5), long, depth()]);
    else out.push([x, z, long, long * range(0.45, 0.8), depth()]);
  }
  // 车间东边的场地（x −73…−63）
  for (let z = -94 + rng() * 6; z < 96; z += range(10, 17)) {
    const long = range(1.6, 3.4);
    out.push([range(-72, -64), z, long * range(0.5, 0.9), long, depth()]);
  }
  // 水泥场院里再补几个小的（大的已经手摆了）
  for (let i = 0; i < 5; i++) {
    const long = range(1.2, 2.4);
    out.push([range(YARD.minX + 2, YARD.maxX - 2), range(YARD.minZ + 3, YARD.maxZ - 2), long, long * range(0.5, 0.9), range(0.15, 0.2)]);
  }
  // 南北两端的空场、车间南北两侧的空地：没有固定的行车线，洼地大而圆
  const open: [number, number, number, number, number][] = [
    [-106, 26, 78, 98, 12], [-106, 26, -98, -78, 12], [-106, -64, 38, 76, 8], [-106, -64, -76, -38, 8],
  ];
  for (const [x0, x1, z0, z1, n] of open) for (let i = 0; i < n; i++) {
    const long = range(1.8, 4.2), swap = rng() < 0.5, short = long * range(0.45, 0.9);
    out.push([range(x0, x1), range(z0, z1), swap ? short : long, swap ? long : short, depth()]);
  }
  // 围墙根：墙挡住了水的去路
  for (let i = 0; i < 10; i++) {
    const long = range(2.0, 4.0), south = rng() < 0.5;
    out.push([range(-104, 56), (south ? 1 : -1) * range(97.6, 98.8), long, long * range(0.3, 0.45), depth()]);
  }
  // 中心落在箱子或车间底下的不要；只是边缘伸到箱脚下面的留着（水本来就爱贴着箱脚积）。
  // 碰到留空区的也不要：拿洼地的外接矩形（缩到八成——最外面那一圈本来就浅得存不住水）去和留空区比
  return out.filter(([x, z, rx, rz]) => !occupied(x, z, -0.4)
    && !KEEP_CLEAR.some((r) => x + rx * 0.8 > r.minX && x - rx * 0.8 < r.maxX && z + rz * 0.8 > r.minZ && z - rz * 0.8 < r.maxZ));
}

// ---------------------------------------------------------------- 车辙与排水沟

/**
 * 一条沿着某个方向延伸的浅槽：车辙、路边的排水沟、轨道边的沉降带、屋檐下的滴水坑都是它。
 * 横截面是一条高斯曲线；沿程的深浅和“有没有”由噪声决定，所以它是断断续续的，不是一根从头到尾的直线。
 */
interface Rut {
  axis: 'x' | 'z';        // 沿哪个方向延伸
  at: number[];           // 横向位置。一辆车有左右两排轮子，所以车辙成对出现，两条共用同一套沿程变化
  from: number; to: number;
  halfWidth: number;      // 横截面降到 37% 处的半宽（米）
  wander: number;         // 中线左右摆动的幅度（米）
  depth: number;          // 最深处往下挖多少（高度单位）
  presence: number;       // 沿程大约有多大比例的长度“有”这条槽（0..1）
  patch: number;          // 一段“有/无”大约多长（米）。车辙取 9，滴水坑取 1.5 就成了一串小坑
  seed: number;
  skip?: [number, number][]; // 沿程要跳过的区间
}

function ruts(): Rut[] {
  const list: Rut[] = [];
  // 主干道：西侧车道是重车道，车辙深、几乎连着；东侧车道浅一些、断得多
  list.push({ axis: 'z', at: [LANE_X[0] - 1.1, LANE_X[0] + 1.1], from: -96, to: ROAD_RUT_SOUTH, halfWidth: 0.5, wander: 0.3, depth: 0.22, presence: 0.8, patch: 9, seed: 19 });
  list.push({ axis: 'z', at: [LANE_X[1] - 1.1, LANE_X[1] + 1.1], from: -96, to: ROAD_RUT_SOUTH, halfWidth: 0.5, wander: 0.3, depth: 0.17, presence: 0.6, patch: 9, seed: 29 });
  // 路缘：路面中间高两边低，雨水顺着路拱流到边线内侧，积成细长的一条
  list.push({ axis: 'z', at: [ROAD_X - 7.15], from: -97, to: ROAD_RUT_SOUTH, halfWidth: 0.42, wander: 0.18, depth: 0.15, presence: 0.42, patch: 7, seed: 37 });
  list.push({ axis: 'z', at: [ROAD_X + 7.15], from: -97, to: ROAD_RUT_SOUTH, halfWidth: 0.42, wander: 0.18, depth: 0.15, presence: 0.42, patch: 7, seed: 41 });
  // 横向通道里东西向的车辙，浅；遇到主干道就断开（路口另有洼地）
  CROSS_Z.forEach((cz, i) => list.push({ axis: 'x', at: [cz - 1.1, cz + 1.1], from: -61, to: 26, halfWidth: 0.45, wander: 0.35, depth: 0.14, presence: 0.45, patch: 8, seed: 53 + i * 7, skip: [[ROAD_X - ROAD_HALF - 1, ROAD_X + ROAD_HALF + 1]] }));
  // 码头前沿的两条行车线
  QUAY_LANE_X.forEach((lx, i) => list.push({ axis: 'z', at: [lx - 1.1, lx + 1.1], from: -96, to: 96, halfWidth: 0.5, wander: 0.4, depth: 0.16, presence: 0.55, patch: 10, seed: 83 + i * 11 }));
  // 轨道内侧：轨道梁和旁边的面层沉降不一样，贴着轨道有一道浅沟
  list.push({ axis: 'z', at: [RAIL_X[0] + 0.62], from: -97, to: 97, halfWidth: 0.34, wander: 0.05, depth: 0.14, presence: 0.5, patch: 6, seed: 101 });
  list.push({ axis: 'z', at: [RAIL_X[1] - 0.62], from: -97, to: 97, halfWidth: 0.34, wander: 0.05, depth: 0.14, presence: 0.5, patch: 6, seed: 107 });
  // 车间南檐的滴水线：天沟接不住的水从檐口成排滴下来，在地上砸出一串小坑。
  // 位置对着雨里那排屋檐水滴（port.ts 的 shelter.eave，落在南墙外 0.28 米）；卷帘门前是水泥坡板，跳过。北檐滴进夹道，那里另有手摆的洼地
  list.push({ axis: 'x', at: [WORKSHOP.maxZ + 0.32], from: WORKSHOP.minX, to: WORKSHOP.maxX, halfWidth: 0.26, wander: 0.05, depth: 0.16, presence: 0.55, patch: 1.6, seed: 113, skip: [[-94.5, -88.5]] });
  list.push({ axis: 'x', at: [ANNEX.minZ - 0.7], from: ANNEX.minX, to: ANNEX.maxX, halfWidth: 0.3, wander: 0.06, depth: 0.15, presence: 0.5, patch: 1.6, seed: 127 });
  return list;
}

// ---------------------------------------------------------------- 烘焙

export interface GroundMask {
  /** RGBA8，行 = z，列 = x。R 高度、G 潮湿度、B 油渍、A 磨损。 */
  data: Uint8Array;
  res: number;
  rect: typeof MASK_RECT;
  texture: THREE.DataTexture;
  quayX: number;
  /** 洼地总数和各类浅槽的数量，调试和写说明用。 */
  stats: { heroBasins: number; scatteredBasins: number; ruts: number };
}

let baked: GroundMask | null = null;

/**
 * 烘出地面掩码（只在加载时做一次，约一百万像素）。
 * res 是边长的像素数：1024 时一个像素约 18×21 厘米——看着粗，但水的岸线细节是着色器另外用噪声加的，
 * 这张图只管“大形”，而且着色器用双三次插值读它，凑多近都看不到像素格。
 */
export function bakeGroundMask(quayX: number, res = 1024): GroundMask {
  if (baked && baked.quayX === quayX && baked.res === res) return baked;
  const { x0, z0, w, h } = MASK_RECT, dx = w / res, dz = h / res;
  const px = (x: number) => (x - x0) / dx - 0.5, pz = (z: number) => (z - z0) / dz - 0.5; // 世界坐标 → 像素下标（像素中心采样）

  // 第一步：把所有“往下挖”的东西累加到一张图上
  const carve = new Float32Array(res * res);
  const hero = [...HERO_BASINS, ...DOWNPIPE_BASINS], scattered = scatterBasins(quayX);
  [...hero, ...scattered].forEach(([cx, cz, rx, rz, dep], index) => {
    // 只处理洼地周围的一小块：归一化距离 a 超过 3 以后 exp(−a²) 已经小到可以不管
    const reach = 1.74, warp = Math.min(0.9, Math.min(rx, rz) * BASIN_WARP), seed = 200 + index * 3;
    const i0 = Math.max(0, Math.floor(px(cx - rx * reach - warp))), i1 = Math.min(res - 1, Math.ceil(px(cx + rx * reach + warp)));
    const j0 = Math.max(0, Math.floor(pz(cz - rz * reach - warp))), j1 = Math.min(res - 1, Math.ceil(pz(cz + rz * reach + warp)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + (i + 0.5) * dx, z = z0 + (j + 0.5) * dz;
      // 先把坐标用噪声推歪一点再量距离：洼地的轮廓就从规整的椭圆变成有凸有凹的不规则形状（真的水洼没有哪个是正椭圆）
      const wx = (fractalNoise(x / 3.1, z / 3.1, seed, 2) - 0.5) * 2 * warp, wz = (fractalNoise(x / 3.1, z / 3.1, seed + 1, 2) - 0.5) * 2 * warp;
      const ex = (x + wx - cx) / rx, ez = (z + wz - cz) / rz, a = ex * ex + ez * ez;
      // exp(−距离⁴)：盆底是平的、边坡比较陡。用普通的高斯（exp(−距离²)）的话水洼会是个尖底的碗
      if (a < 9) carve[j * res + i] += (dep + BASIN_EXTRA) * Math.exp(-a * a);
    }
  });
  const rutList = ruts();
  for (const rut of rutList) {
    // “沿程”方向的像素一格一格走；alongZ 时沿程是 z、横向是 x，反之亦然
    const alongZ = rut.axis === 'z', step = alongZ ? dz : dx, origin = alongZ ? z0 : x0, cross = alongZ ? dx : dz, crossOrigin = alongZ ? x0 : z0;
    const coord = (k: number) => origin + (k + 0.5) * step;
    // 先算“有/无”的噪声，再按 presence 取分位数当阈值——这样“大约八成长度有车辙”就真的是八成，不用去猜噪声的分布
    const gate = new Float32Array(res), inRange: number[] = [];
    for (let k = 0; k < res; k++) {
      gate[k] = fractalNoise(coord(k) / rut.patch, rut.seed * 1.37, rut.seed, 2);
      if (coord(k) >= rut.from && coord(k) <= rut.to) inRange.push(gate[k]);
    }
    inRange.sort((p, q) => p - q);
    const threshold = inRange.length ? inRange[Math.min(inRange.length - 1, Math.floor((1 - rut.presence) * inRange.length))] : 2;
    for (let k = 0; k < res; k++) {
      const s = coord(k);
      if (s < rut.from - 3 || s > rut.to + 3) continue;
      let amount = smooth(threshold - 0.05, threshold + 0.05, gate[k]) * smooth(rut.from - 2, rut.from + 2, s) * (1 - smooth(rut.to - 2, rut.to + 2, s));
      for (const [a, b] of rut.skip ?? []) amount *= 1 - smooth(a - 1.5, a + 0.5, s) * (1 - smooth(b - 0.5, b + 1.5, s));
      if (amount <= 0) continue;
      const deep = rut.depth * (0.55 + 0.45 * valueNoise(s / 6, 3.1, rut.seed + 5)) * amount;   // 沿路每 6 米变一次的深浅
      const drift = (fractalNoise(s / 16, 9.3, rut.seed + 7, 2) - 0.5) * 2 * rut.wander;          // 车不会每次都压在同一条线上：槽的中线慢慢地左右摆
      const half = rut.halfWidth * (0.75 + 0.5 * valueNoise(s / 4.3, 5.7, rut.seed + 9));         // 宽窄也不一样
      for (const at of rut.at) {
        const center = at + drift, reach = half * 2.6;
        const t0 = Math.max(0, Math.floor((center - reach - crossOrigin) / cross - 0.5)), t1 = Math.min(res - 1, Math.ceil((center + reach - crossOrigin) / cross - 0.5));
        for (let t = t0; t <= t1; t++) {
          const d = (crossOrigin + (t + 0.5) * cross - center) / half;
          carve[alongZ ? k * res + t : t * res + k] += deep * Math.exp(-d * d);
        }
      }
    }
  }

  // 第二步：逐像素算高度和另外三个通道
  const data = new Uint8Array(res * res * 4);
  for (let j = 0; j < res; j++) {
    const z = z0 + (j + 0.5) * dz;
    // 这一行离哪条横向通道最近（磨损的条纹要顺着车走的方向）
    let crossLane = 0;
    for (const cz of CROSS_Z) crossLane = Math.max(crossLane, 1 - smooth(2.6, 4.4, Math.abs(z - cz)));
    for (let i = 0; i < res; i++) {
      const x = x0 + (i + 0.5) * dx, k = j * res + i;
      // 自然的高低不平：8.5 米的大起伏（约 ±0.15）加 2.4 米的小坑洼（约 ±0.07）
      let height = 0.5 + (fractalNoise(x / 8.5, z / 8.5, 11, 4) - 0.47) * 0.3 + (fractalNoise(x / 2.4, z / 2.4, 23, 3) - 0.5) * 0.14;
      height -= carve[k];
      // 路拱：主干道中线比两边高一点，水往两边走
      const across = (x - ROAD_X) / ROAD_HALF;
      if (across > -1 && across < 1 && z > -98 && z < 98) height += 0.04 * (1 - across * across);
      // 码头边沿最后一米多是抬高的压顶，岸边永远不积水
      height += 0.25 * smooth(quayX - 1.4, quayX - 0.2, x);
      // 屋顶底下：地面抬高到绝不会有水（屋里的地坪另有模型，这里主要是为了 puddleDepthAt 在室内查不到水）。
      // 从墙线往里 0.6 米过渡，门口就不会有一道齐刷刷的水线
      let roofed = 0;
      for (const r of ROOFED) roofed = Math.max(roofed, smooth(0, 0.6, Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z)));
      height += 0.3 * roofed;
      for (const [mx, mz] of MANHOLES) {
        const d2 = ((x - mx) * (x - mx) + (z - mz) * (z - mz)) / 0.49;
        if (d2 < 9) height += 0.12 * Math.exp(-d2 * d2);
      }
      data[k * 4] = Math.round(clamp01(0.5 + (height - WATER_LEVEL) * DEPTH_GAIN) * 255);

      // 潮湿度：5.5 米的斑块，低处更潮
      data[k * 4 + 1] = Math.round(clamp01(0.5 + (fractalNoise(x / 5.5, z / 5.5, 41, 3) - 0.5) * 1.5 + (0.5 - height) * 0.9) * (1 - roofed) * 255);

      // 油渍：1.4 米的小斑，只出现在 9 米尺度的“油区”里；再加上车道正中间一条断断续续的滴油带（车底的油滴在两排轮子之间）
      let oil = smooth(0.6, 0.78, fractalNoise(x / 1.4, z / 1.4, 77, 4)) * smooth(0.47, 0.62, fractalNoise(x / 9, z / 9, 91, 2));
      for (const lx of LANE_X) {
        const d = (x - lx) / 0.38;
        if (d > -3 && d < 3) oil = Math.max(oil, 0.55 * Math.exp(-d * d) * smooth(0.5, 0.72, fractalNoise(x / 0.7, z / 4.5, 83, 3)));
      }
      data[k * 4 + 2] = Math.round(clamp01(oil) * 255);

      // 磨损：顺着车流方向拉长的条纹（长 22 米、宽 0.9 米）加 13 米的斑块。
      // 主干道和码头的车是南北走的，横向通道里是东西走的，条纹方向跟着换
      const inCross = crossLane > 0 && x > -62 && x < 27 ? crossLane * smooth(ROAD_HALF - 1, ROAD_HALF + 1.5, Math.abs(x - ROAD_X)) : 0;
      let streak = fractalNoise(x / 0.9, z / 22, 57, 3);
      if (inCross > 0) streak += (fractalNoise(x / 22, z / 0.9, 58, 3) - streak) * inCross;
      let wear = streak * 0.6 + fractalNoise(x / 13, z / 13, 63, 3) * 0.4;
      // 轮子真正压过的那几条线磨得更狠
      for (const lx of LANE_X) for (const side of [-1.1, 1.1]) { const d = (x - lx - side) / 0.6; if (d > -2.5 && d < 2.5) wear += 0.12 * Math.exp(-d * d); }
      data[k * 4 + 3] = Math.round(clamp01(wear) * 255);
    }
  }

  const texture = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;                       // 当数据用，不是颜色
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;    // 着色器里自己做双三次插值，只需要硬件的双线性
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  baked = { data, res, rect: MASK_RECT, texture, quayX, stats: { heroBasins: hero.length, scatteredBasins: scattered.length, ruts: rutList.reduce((s, r) => s + r.at.length, 0) } };
  return baked;
}

/** 双线性读掩码的某个通道，返回 0..1。坐标超出范围时夹到边上。 */
function sampleMask(mask: GroundMask, x: number, z: number, channel: number) {
  const { data, res, rect } = mask;
  let u = ((x - rect.x0) / rect.w) * res - 0.5, v = ((z - rect.z0) / rect.h) * res - 0.5;
  u = u < 0 ? 0 : u > res - 1.001 ? res - 1.001 : u; v = v < 0 ? 0 : v > res - 1.001 ? res - 1.001 : v;
  const i = u | 0, j = v | 0, fu = u - i, fv = v - j, k = (j * res + i) * 4 + channel, row = res * 4;
  return ((data[k] * (1 - fu) + data[k + 4] * fu) * (1 - fv) + (data[k + row] * (1 - fu) + data[k + row + 4] * fu) * fv) / 255;
}

/**
 * 这个位置的水深（相对量）：大于 0 表示有积水，0.2 以上算深水；负数表示离水位线还差多少（越负越干）。
 * 掩码还没烘、或者在码头外、或者超出掩码范围时返回 −0.2（“潮湿但没有水”）。
 *
 * 注意两点：一，这里读的是烘好的大形，不含着色器里咬碎岸线的噪声，所以贴着水边的几厘米和画面可能对不上，
 * 判断“踩没踩到水”请用 isPuddleAt（留了一点余量）。二，它只管平面位置，不知道高度——站在集装箱顶上的人
 * 脚下也会查到水，调用的地方要自己先判断是不是站在地面上。
 */
export function puddleDepthAt(x: number, z: number): number {
  const m = baked;
  if (!m || x > m.quayX || x < m.rect.x0 || x > m.rect.x0 + m.rect.w || z < m.rect.z0 || z > m.rect.z0 + m.rect.h) return -0.2;
  return 0.5 - sampleMask(m, x, z, 0);
}
/** 这里是不是踩得到水的水洼。 */
export function isPuddleAt(x: number, z: number): boolean {
  return puddleDepthAt(x, z) > PUDDLE_THRESHOLD;
}
