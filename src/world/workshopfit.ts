import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/math';
import type { DecalDef } from '../render/decalart';
import { DECALS } from '../render/labels';
import { emissive } from '../render/surfaces';
import { hex, Kit, type LocalBox, type Mat, type Tint, type V3 } from './kit';
import { WORKSHOP, type Workshop } from './workshop';

// 四号泊位维修车间 —— 室内陈设（建筑本体在 workshop.ts）。
//
// 一栋空棚子再好看也只是个壳。让它像"有人在这里干过活"的是里面的东西：
//
//   · 西北角的夹层办公室：架在 2.6 米高的钢平台上，一圈脏玻璃窗，里面一根冷白的灯管和一块蓝色的屏幕。
//     整个车间的灯都是暖黄色的，只有这一角是冷的 —— 冷暖对比是故意安排的。办公室进不去，只能隔着玻璃看。
//   · 办公室门外的走道和钢梯：全场唯一能上去的高处，站在上面两个门都看得见。
//   · 南墙边的工作台：洞洞板上挂着工具，头顶一条暖色灯带。
//   · 西南角的龙门吊架，吊着一台拆下来的发动机。
//   · 北墙前一整排 4.2 米高的重型货架，再加第二排 3 组：每组 3 层 × 2 个货位，按种子随机摆货。
//   · 地上的零碎：油渍、屋面破洞正下方的水渍、门槛警示线、拖在地上的气管和电缆。
//
// 坐标和 workshop.ts 是同一套（参考关卡的世界坐标：+x 东，+z 南，车间占 x −16…12、z −28…−11，地坪 y = 0.03）。
// 放进我们自己的地图时用 placeWorkshopFit() 整体平移，和 placeWorkshop() 传一样的参数。
//
// 发光的东西（灯管、屏幕、灯带）都只是"很亮的面片"：它们自己不照亮任何东西，亮的感觉来自后处理的泛光。
//
// 油桶、托盘堆、轮胎、叉车这些通用道具不在这里搭（它们在 props/cargo.ts、forklift.ts），
// 这里只给出该摆在哪：见文件末尾的 WORKSHOP_PROPS。

export interface WorkshopFit {
  /** 全部陈设的网格（已经按材质合并）。 */
  group: THREE.Group;
  /** 陈设的碰撞盒。 */
  boxes: LocalBox[];
  /** 乙号中继该放的位置（中继柜本身不在这里搭）。 */
  relayPos: V3;
}

export interface WorkshopFitOptions {
  /**
   * 屋面破洞在地面上的投影，直接传 buildWorkshop().roofHoles（要没经过 placeWorkshop 换算的那一份）。
   * 每个洞的正下方会贴一块水渍。不传就用下面 DEFAULT_ROOF_HOLES 里记的 8 个洞。
   */
  roofHoles?: Workshop['roofHoles'];
}

// ------------------------------------------------------------------ 尺寸
const FLOOR = WORKSHOP.floor;   // 室内地坪的高度：0.03
/** 内衬波纹板朝屋里的那一面，离墙的外表面 13 厘米（墙的分层见 workshop.ts）。往墙上挂东西要贴到这个面上。 */
const LINING = 0.13;
/** 水泥墙裙朝屋里的那一面，离墙的外表面 25 厘米；墙裙只到 1.2 米高。 */
const SKIRT = 0.25;
const HALF_PI = Math.PI / 2;

// 每多用一种材质，整套陈设就多一个网格、多一次绘制调用。所以只出现一两回的质感不单独开材质，
// 而是借一种贴图相同的常用材质，把颜色乘到顶点色里。下面几个就是这样"借"来的颜色。
/** 深色木头（材质表里的 wood_dark）= 托盘木乘上这个灰褐色。 */
const DARK_WOOD = hex(0x8a786a);
/** 磨亮的旧钢（材质表里的 steel_worn）和黑钢（steel_dark）是同一张贴图，只是亮 2.2 倍。 */
const WORN = 2.2;
/** 排气管的锈色：黑钢染成红褐。 */
const RUSTY: Tint = [2.3, 1.1, 0.6];

/** 夹层的钢楼面。 */
const DECK = { x0: -15.73, x1: -10.25, z0: -27.73, z1: -23.75, top: 2.6 } as const;
/** 办公室：墙的外轮廓、窗台和窗顶的高度、屋顶的高度、墙厚。西、北两面直接借用车间的墙，所以只有南、东两面墙。 */
const ROOM = { x0: -15.68, x1: -10.3, z0: -27.68, z1: -23.8, sill: 3.5, head: 4.45, top: 5, wall: 0.07 } as const;
/** 走道：两节各 3 米长、1.2 米宽的格栅板首尾相接，板面和楼面一样高。 */
const WALK = { x0: -15.75, x1: -9.75, z: -23.15, top: 2.6 } as const;
/**
 * 钢梯：摆在 (x, z)，整体绕竖轴转了 180°（所以是从东头起步、朝西往上走）。
 * 12 级踏步，每级升 0.2 米、进 0.2 米；最后迈上 2.6 米高的顶平台，正好接走道的东端。
 */
const STAIR = { x: -8.25, z: -23.15, steps: 12, rise: 0.2, run: 0.2, start: -1.5 } as const;
/** 工作台：台面的左右两端、前沿和后沿（后沿离墙裙 5 厘米）。 */
const BENCH = { x0: 1.6, x1: 5, front: -12.05, back: -11.3, top: 0.94 } as const;
/** 龙门吊架：横梁沿 x 方向，两组 A 字腿相距 2.6 米。 */
const GANTRY = { x: -11.6, z: -17.6, half: 1.3, apex: 3.3 } as const;
/** 货架：总高、立柱离中心的距离（x 方向、z 方向）、两层横梁的高度。 */
const RACK = { h: 4.2, postX: 1.305, postZ: 0.5, levels: [1.45, 2.86] } as const;
/**
 * 北墙那一排货架的 z。参考里是 −27.13，但那样货架的后半截会和北墙的刚架柱（柱子朝屋里伸到 z = −27.28）插在一起，
 * 柱子从托盘上的货里穿出来。这里把整排往南挪 0.42 米，让货架的背面刚好站在柱子前面。
 */
const NORTH_ROW_Z = -26.71;
/** 9 组货架：[x, z, 种子]。种子决定货位号和每个货位上摆什么。 */
const RACKS: [number, number, number][] = [
  ...[-8.4, -5.6, -2.8, 2.8, 5.6, 8.4].map((x): [number, number, number] => [x, NORTH_ROW_Z, Math.round(x * 7 + 90)]),
  ...[2.8, 5.6, 8.4].map((x): [number, number, number] => [x, -23.45, Math.round(x * 5 + 40)]),
];

/**
 * 屋面上被掀掉的 8 块板在地面上的投影（和 workshop.ts 里的 ROOF_HOLES 一一对应：屋面板每列宽 1.43 米，每排的投影长 2.125 米）。
 * 只在调用方没有传 roofHoles 时用。
 */
const DEFAULT_ROOF_HOLES: Workshop['roofHoles'] = ([[4, 1, 1], [11, 1, 1], [5, 2, 1], [15, 2, 1], [8, 3, 1], [13, 1, -1], [7, 2, -1], [17, 3, -1]] as const)
  .map(([col, row, side]) => {
    const x = -16.3 + col * 1.43, za = WORKSHOP.ridgeZ + side * 8.5 * (1 - row * 0.25), zb = WORKSHOP.ridgeZ + side * 8.5 * (1 - (row + 1) * 0.25);
    return { minX: x, maxX: x + 1.43, minZ: Math.min(za, zb), maxZ: Math.max(za, zb) };
  });

// ------------------------------------------------------------------ 小工具
type BoxOpt = NonNullable<Parameters<Kit['box']>[7]>;
type PartOpt = NonNullable<Parameters<Kit['add']>[2]>;

const smoothstep = (lo: number, hi: number, v: number) => { const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
const moveTo = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

/** 按两个对角点放一个盒子（规格里的尺寸大多是"从哪到哪"，这样写不用心算中心和边长）。 */
function slab(k: Kit, mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: BoxOpt = {}) {
  k.box(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, o);
}

/** 登记一个碰撞盒。默认表面是金属；extra 里可以改表面，或者加 noNav / playerOnly 这些标记。 */
function collide(boxes: LocalBox[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, extra: Partial<LocalBox> = {}) {
  boxes.push({ min: [Math.min(x0, x1), y0, Math.min(z0, z1)], max: [Math.max(x0, x1), y1, Math.max(z0, z1)], surface: 'metal', ...extra });
}

/**
 * 立柱的几何体：一根四条竖棱都倒了角的方柱，底面在 y = 0，高 h。
 *
 * 为什么不直接用零件箱的倒角盒：零件箱"烤脏"时会把贴地 20 厘米以内的顶点压暗，立柱的染色也常常是"柱脚深、往上变浅"。
 * 这些都是写在顶点上的，顶点之间只能均匀过渡。一根 4 米高的柱子如果只有上下两圈顶点，柱脚的那点暗色就会一路渐变到柱顶，
 * 半根柱子都发乌。所以在离底 ring 米的地方多切一圈顶点：暗色到这一圈为止，再往上是干净的。
 *
 * 截面是切掉四个角的长方形（八边形）。斜面两头的法线分别取相邻两个大面的法线，光照在斜面上渐变，看起来像圆角。
 */
function postGeo(sx: number, h: number, sz: number, bevel: number, ring: number) {
  const hx = sx / 2, hz = sz / 2, c = Math.min(bevel, hx * 0.9, hz * 0.9);
  // 八个角点 [x, z, 法线 x, 法线 z]，从上往下看按逆时针排；相邻两点要么同属一个大面，要么夹着一条斜面
  const ring8 = [
    [hx, -hz + c, 1, 0], [hx, hz - c, 1, 0], [hx - c, hz, 0, 1], [-hx + c, hz, 0, 1],
    [-hx, hz - c, -1, 0], [-hx, -hz + c, -1, 0], [-hx + c, -hz, 0, -1], [hx - c, -hz, 0, -1],
  ];
  const levels = ring > 0 && ring < h ? [0, ring, h] : [0, h];
  const pos: number[] = [], nor: number[] = [];
  const side = (p: number[], y: number) => { pos.push(p[0], y, p[1]); nor.push(p[2], 0, p[3]); };
  for (let i = 0; i < 8; i++) {
    const a = ring8[i], b = ring8[(i + 1) % 8];
    for (let j = 0; j + 1 < levels.length; j++) {
      const y0 = levels[j], y1 = levels[j + 1];
      side(a, y0); side(b, y1); side(b, y0);
      side(a, y0); side(a, y1); side(b, y1);
    }
    // 顶盖：以中心为顶点的一圈三角形（底面压在地上，不用做）
    pos.push(0, h, 0, b[0], h, b[1], a[0], h, a[1]);
    nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
/** 放一根立柱：截面 sx × sz，中心在 (x, z)，从 y0 立到 y1。 */
function post(k: Kit, mat: Mat, sx: number, sz: number, x: number, y0: number, y1: number, z: number, o: PartOpt & { bevel?: number; ring?: number } = {}) {
  k.add(mat, postGeo(sx, y1 - y0, sz, o.bevel ?? 0.008, o.ring ?? 0.35), o, moveTo(x, y0, z));
}

/** 沿 x 方向的工字钢：上下两片翼缘夹一片腹板。depth 是截面的高，width 是翼缘的宽。 */
function ibeamX(k: Kit, mat: Mat, len: number, depth: number, width: number, x: number, y: number, z: number, tint?: Tint) {
  const flange = 0.016, web = 0.01;
  for (const s of [-1, 1]) k.box(mat, len, flange, width, x, y + s * (depth / 2 - flange / 2), z, { c: 0.003, tint });
  k.box(mat, len, depth - 2 * flange, web, x, y, z, { plain: true, tint });
}

/**
 * 木头的贴图是有纹路的，零件箱不会替它随机挪位置（挪了相邻的木板纹路就接不上）。
 * 但托盘上一条条的木板本来就各是各的料，纹路全一样反而假。这里先把盒子挪开一段再铺贴图，然后挪回原位：
 * 形状和位置不变，每块板采到的却是贴图上不同的一段。
 */
function board(k: Kit, sx: number, sy: number, sz: number, x: number, y: number, z: number, rng: Rng, o: BoxOpt = {}) {
  const du = rng() * 3, dv = rng() * 3, g = new THREE.BoxGeometry(sx, sy, sz).translate(du, 0, dv);
  k.add('wood_pallet', g, o, moveTo(x - du, y, z - dv));
}

// ------------------------------------------------------------------ 夹层办公室
function buildMezzanine(k: Kit, boxes: LocalBox[]) {
  // 楼面、屋顶和墙板的西、北两头要一直伸到车间内衬板的表面（还咬进去 1 厘米），不然靠墙会留一道十几厘米的缝
  const wallX = WORKSHOP.x0 + LINING - 0.01, wallZ = WORKSHOP.z0 + LINING - 0.01;

  // ---- 钢平台：花纹钢板的楼面，下面 3 根主梁（南北向）、4 根小梁（东西向），3 根立柱
  slab(k, 'diamond_plate', wallX, 2.5, wallZ, DECK.x1, DECK.top, DECK.z1, { c: 0.004 });
  for (const x of [DECK.x0 + 0.1, -13, DECK.x1 - 0.08]) slab(k, 'paint_grey', x - 0.07, 2.3, DECK.z0, x + 0.07, 2.5, DECK.z1, { c: 0.006 });
  for (const z of [-27.1, -26.1, -25.1, -24.3]) slab(k, 'steel_galv', DECK.x0, 2.4, z - 0.03, DECK.x1, 2.497, z + 0.03, { plain: true, tint: 0.8 });   // 从楼面底下抬头看，不至于是一块光板
  for (const [x, z] of [[DECK.x1 - 0.08, DECK.z1 - 0.08], [DECK.x1 - 0.08, DECK.z0 + 0.3], [-13, DECK.z1 - 0.08]]) {
    post(k, 'paint_grey', 0.14, 0.14, x, FLOOR, 2.3, z, { bevel: 0.01 });   // 只立到主梁底：柱子和梁一样宽，再往上两者的侧面会叠在同一个平面上闪
    k.box('steel_dark', 0.26, 0.012, 0.26, x, FLOOR + 0.006, z, { plain: true });
    k.box('steel_dark', 0.2, 0.012, 0.2, x, 2.294, z, { plain: true });
    collide(boxes, x - 0.08, 0, z - 0.08, x + 0.08, DECK.top, z + 0.08, { noNav: true });   // noNav：柱子太细，不值得让寻路为它绕道
  }

  // ---- 两面墙：下面一圈墙板、中间一圈窗、上面一圈墙板。南面是整段，东面到南墙的内皮为止（免得两块板在墙角叠在一起）
  const t = ROOM.wall;
  const ringOf = (mat: Mat, y0: number, y1: number, thick: number, inset: number, o: BoxOpt) => {
    slab(k, mat, wallX, y0, ROOM.z1 - inset - thick, ROOM.x1, y1, ROOM.z1 - inset, o);
    slab(k, mat, ROOM.x1 - inset - thick, y0, wallZ, ROOM.x1 - inset, y1, ROOM.z1 - t, o);
  };
  ringOf('paint_white', DECK.top, ROOM.sill, t, 0, { c: 0.004 });
  ringOf('paint_white', ROOM.head, ROOM.top, t, 0, { c: 0.004 });
  // 玻璃：厚 2 厘米，缩在墙厚的中间。参考里玻璃和窗梃的外表面在同一个平面上，会闪。
  // cast: false —— 玻璃是透明的，但阴影贴图不认透明，不关掉的话它会投出一块实心的影子。
  ringOf('glass_dirty', ROOM.sill, ROOM.head, 0.02, 0.025, { plain: true, cast: false });
  // 窗梃：把窗带分成几扇的竖条，8 厘米宽。墙角那一根两面墙合用
  for (const x of [ROOM.x0 + 0.04, -14.2, -12.9, -11.75, ROOM.x1 - 0.04]) slab(k, 'paint_white', x - 0.04, ROOM.sill, ROOM.z1 - t, x + 0.04, ROOM.head, ROOM.z1, { plain: true, tint: 0.9 });
  for (const z of [ROOM.z0 + 0.04, -26.3, -25]) slab(k, 'paint_white', ROOM.x1 - t, ROOM.sill, z - 0.04, ROOM.x1, ROOM.head, z + 0.04, { plain: true, tint: 0.9 });
  // 窗台和窗顶各一道压条，比墙面凸出 1 厘米多，盖住玻璃和墙板的接缝
  for (const y of [ROOM.sill, ROOM.head]) {
    slab(k, 'paint_white', wallX, y - 0.02, ROOM.z1 - t - 0.012, ROOM.x1 + 0.012, y + 0.02, ROOM.z1 + 0.012, { plain: true, tint: 0.8 });
    slab(k, 'paint_white', ROOM.x1 - t - 0.012, y - 0.02, wallZ, ROOM.x1 + 0.012, y + 0.02, ROOM.z1 - t, { plain: true, tint: 0.8 });
  }
  // 门：只是贴在南墙外面的一块板（开不了），加一个把手、一块门牌才看得出是门
  slab(k, 'paint_grey', -11.65, DECK.top, ROOM.z1 - 0.01, -10.75, 4.6, ROOM.z1 + 0.03, { c: 0.006 });
  k.box('steel_bare', 0.03, 0.13, 0.035, -11.55, 3.62, ROOM.z1 + 0.045, { c: 0.006 });
  k.label('办公室', { color: 'white', font: 'sans', distress: 0.25 }, 0.4, 0.09, [-11.2, 4.25, ROOM.z1 + 0.032]);
  // 屋顶：一块板，南、东两边各挑出 10 厘米
  slab(k, 'paint_white', wallX, ROOM.top, wallZ, ROOM.x1 + 0.1, ROOM.top + 0.08, ROOM.z1 + 0.1, { c: 0.006, tint: 0.9 });

  // ---- 屋里的东西。站在走道上隔着玻璃看得一清二楚，所以桌子有腿、椅子有靠背
  // 桌子：靠北的一长条台面。它不贴墙，离墙半米：墙前面有刚架柱和交叉拉杆（两根斜拉的圆钢，正好在桌面的高度交叉），
  // 桌子站在它们前面，才不会被拉杆从桌面中间穿过去
  const deskBack = ROOM.z0 + 0.3, deskFront = deskBack + 0.7;
  slab(k, 'wood_pallet', ROOM.x0 + 0.2, 3.3, deskBack, ROOM.x1 - 0.3, 3.36, deskFront, { c: 0.008, grain: 'x', tint: DARK_WOOD });
  for (const x of [-15.4, -13.9, -12.3, -10.7]) slab(k, 'steel_dark', x - 0.02, DECK.top, deskBack + 0.06, x + 0.02, 3.3, deskFront - 0.06, { plain: true });
  // 显示器：底座、立杆、机身，机身前面贴一块发光的屏幕（比机身表面只高 1 毫米）
  const screenZ = deskBack + 0.26;
  k.box('steel_dark', 0.26, 0.012, 0.18, -13.05, 3.366, screenZ - 0.05, { plain: true });
  k.box('steel_dark', 0.05, 0.1, 0.03, -13.05, 3.41, screenZ - 0.06, { plain: true });
  slab(k, 'steel_dark', -13.4, 3.4, screenZ - 0.06, -12.7, 3.8, screenZ, { c: 0.008 });
  k.plane(emissive(0x9fd0ff, 1.6), 0.6, 0.36, [-13.05, 3.6, screenZ + 0.001], { raw: true });
  k.box('polymer_black', 0.42, 0.02, 0.14, -13.05, 3.37, deskFront - 0.2, { c: 0.004 });                 // 键盘
  k.cyl('paint_white', 0.04, 0.09, -12.5, 3.405, deskFront - 0.24, { seg: 10, tint: 1.2 });                           // 杯子
  k.box('paint_white', 0.21, 0.014, 0.3, -13.85, 3.367, deskFront - 0.28, { plain: true, rot: [0, 0.25, 0], tint: 1.35 });   // 一沓纸
  k.box('polymer_black', 0.2, 0.07, 0.22, -14.6, 3.395, deskBack + 0.3, { c: 0.01 });                                 // 对讲机的座充
  k.tube('polymer_black', [-14.55, 3.43, deskBack + 0.28], [-14.55, 3.62, deskBack + 0.26], 0.022, { seg: 6, cap: true });
  // 椅子：转椅，稍微转开一点，像人刚站起来走了
  k.at([-13, DECK.top, deskFront + 0.42], [0, 0.4, 0], () => {
    for (const a of [0, HALF_PI]) k.box('polymer_black', 0.56, 0.03, 0.05, 0, 0.05, 0, { plain: true, rot: [0, a + 0.3, 0] });   // 两根交叉的脚（五星脚的简化）
    k.cyl('steel_bare', 0.025, 0.38, 0, 0.25, 0, { seg: 6 });
    k.box('polymer_black', 0.46, 0.07, 0.46, 0, 0.47, 0, { c: 0.02, tint: 1.7 });
    k.box('steel_dark', 0.05, 0.3, 0.02, 0, 0.6, 0.235, { plain: true });
    k.box('polymer_black', 0.42, 0.46, 0.05, 0, 0.86, 0.25, { c: 0.02, rot: [0.1, 0, 0], tint: 1.7 });
  });
  // 西南角的文件柜，北墙上的软木板和几张纸
  slab(k, 'paint_grey', -15.62, DECK.top, -24.55, -15.12, 3.92, -23.92, { c: 0.01, tint: 0.85 });
  for (const y of [2.95, 3.38, 3.8]) k.box('steel_bare', 0.02, 0.025, 0.18, -15.108, y, -24.23, { plain: true });
  slab(k, 'wood_pallet', -15, 3.7, wallZ + 0.01, -13.9, 4.4, wallZ + 0.03, { plain: true, tint: 0.8 });
  for (const [x, y, w] of [[-14.75, 4.12, 0.2], [-14.42, 4.05, 0.26], [-14.1, 4.15, 0.18]]) k.plane('paint_white', w, w * 1.4, [x, y, wallZ + 0.032], { tint: 1.3, rot: [0, 0, (x + 14.4) * 0.3] });
  // 顶灯：一个灯盒，下面一根冷白的灯管。整个车间只有这里是冷光
  slab(k, 'paint_white', -13.66, 4.97, -25.9, -12.34, ROOM.top, -25.7, { plain: true });
  k.box(emissive(0xcfe2ff, 2.4), 1.2, 0.04, 0.14, -13, 4.95, -25.8, { raw: true, plain: true });

  // ---- 碰撞：办公室是一整个实心盒（进不去）；楼面一块薄板，人可以从下面走
  collide(boxes, ROOM.x0, 2.48, ROOM.z0, ROOM.x1, ROOM.top + 0.08, ROOM.z1, { noNav: true });
  collide(boxes, DECK.x0, 2.48, DECK.z0, DECK.x1, DECK.top, DECK.z1, { noNav: true });
}

// ------------------------------------------------------------------ 走道
/**
 * 一节走道：3 × 1.2 米的钢格栅，放在当前坐标系的原点（板面在 y = 0.05）。
 * 格栅是真的一根根扁钢：31 根顺着走道的（立着放，4 毫米厚），30 根横着的细方钢压在上面。
 * 这些细条不投影子：它们比阴影贴图的一个像素还细，投出来只会是一片闪烁的噪点。
 */
function addCatwalk(k: Kit) {
  const top = 0.05;
  for (let i = 0; i <= 30; i++) k.box('steel_galv', 2.98, 0.03, 0.004, 0, top - 0.015, -0.51 + i * 0.034, { plain: true, cast: false, tint: 0.75 + 0.25 * ((i * 7) % 5) / 4 });
  for (let i = 0; i < 30; i++) k.box('steel_galv', 0.006, 0.006, 1.04, -1.45 + i * 0.1, top - 0.004, 0, { plain: true, cast: false });
  for (const s of [-1, 1]) {
    k.box('steel_galv', 2.99, 0.032, 0.005, 0, top - 0.016, s * 0.525, { plain: true });       // 格栅的包边
    k.box('steel_galv', 0.005, 0.032, 1.05, s * 1.493, top - 0.016, 0, { plain: true });
    k.box('steel_dark', 3, 0.18, 0.06, 0, top - 0.09, s * 0.565, { c: 0.008 });                // 两侧的槽钢边梁
  }
  for (const x of [-1.45, -0.5, 0.5, 1.45]) k.box('steel_dark', 0.05, 0.1, 1.08, x, top - 0.085, 0, { c: 0.006 });   // 横撑
  // 栏杆只装在南侧（+z）：北侧是办公室的墙
  const z = 0.565;
  k.box('steel_dark', 3, 0.1, 0.008, 0, top + 0.05, 0.535, { plain: true });                   // 踢脚板：挡住脚边的东西别滚下去
  for (const x of [-1.42, 0, 1.42]) {
    k.box('paint_yellow', 0.045, 1.07, 0.045, x, top + 0.52, z, { c: 0.006 });
    k.box('steel_dark', 0.09, 0.012, 0.09, x, top + 0.006, z, { plain: true });
  }
  k.tube('paint_yellow', [-1.5, top + 1.05, z], [1.5, top + 1.05, z], 0.021, { seg: 7, cap: true });
  k.tube('paint_yellow', [-1.5, top + 0.55, z], [1.5, top + 0.55, z], 0.016, { seg: 6, cap: true });
}

function buildCatwalk(k: Kit, boxes: LocalBox[]) {
  for (const x of [-14.25, -11.25]) k.at([x, WALK.top - 0.05, WALK.z], null, () => addCatwalk(k));
  // 南侧底下的三根立柱和一根通长的边梁（北侧搭在夹层楼面的梁上）
  const postZ = WALK.z + 0.5;
  for (const x of [-15.6, -12.75, -9.85]) {
    post(k, 'paint_grey', 0.1, 0.1, x, FLOOR, 2.34, postZ, { bevel: 0.01 });
    k.box('steel_dark', 0.2, 0.012, 0.2, x, FLOOR + 0.006, postZ, { plain: true });
    collide(boxes, x - 0.06, 0, postZ - 0.06, x + 0.06, 2.48, postZ + 0.06, { noNav: true });
  }
  slab(k, 'paint_grey', WALK.x0, 2.34, postZ - 0.06, WALK.x1, 2.48, postZ + 0.06, { c: 0.006 });

  // 走道东头北侧有半米的豁口（楼面只到 x = −10.25，再往东是空的），补一小段栏杆接到钢梯平台的栏杆上
  const gapZ = WALK.z - 0.565;
  k.box('paint_yellow', 0.045, 1.07, 0.045, -10.2, WALK.top + 0.52, gapZ, { c: 0.006 });
  for (const [h, r] of [[1.05, 0.021], [0.55, 0.016]]) k.tube('paint_yellow', [-10.2, WALK.top + h, gapZ], [-9.72, WALK.top + h - 0.05 + (h > 1 ? 0 : 0.02), STAIR.z - 0.485], r, { seg: 6, cap: true });

  // 碰撞：板是实的；栏杆只挡人（playerOnly）—— 参考里栏杆是一堵 1 米高的实心墙，站在走道上往下打，子弹会被看不见的墙挡住
  collide(boxes, WALK.x0, WALK.top - 0.08, WALK.z - 0.6, WALK.x1, WALK.top, WALK.z + 0.6, { noNav: true });
  collide(boxes, WALK.x0, WALK.top, WALK.z + 0.53, WALK.x1, WALK.top + 1.05, WALK.z + 0.6, { noNav: true, playerOnly: true });
  collide(boxes, -10.25, WALK.top, WALK.z - 0.6, WALK.x1, WALK.top + 1.05, WALK.z - 0.54, { noNav: true, playerOnly: true });
}

// ------------------------------------------------------------------ 钢梯
function buildStairs(k: Kit, boxes: LocalBox[]) {
  const { steps, rise, run, start } = STAIR;
  const flightEnd = start + steps * run;   // 最后一级踏步结束、顶平台开始的地方（钢梯自己的坐标里 x = 0.9）
  const top = (steps + 1) * rise;          // 顶平台的高度 2.6：12 级踏步之后再迈一步
  /** 踏步前缘连成的那条斜线在 x 处有多高。栏杆、斜梁都平行于它。 */
  const noseLine = (x: number) => ((x - start) / run) * rise + rise;

  // 钢梯在自己的坐标系里搭：原点在占地中心的地面上，从 x = −1.5 起步，朝 +x 往上走。整体转 180° 摆到位。
  // 它的 y = 0 是室外地面，不是地坪面：这样顶平台正好是 2.6 米，和走道齐平；第一级离地坪只有 17 厘米。
  k.at([STAIR.x, 0, STAIR.z], [0, Math.PI, 0], () => {
    for (let i = 0; i < steps; i++) {
      const x = start + i * run, y = (i + 1) * rise;
      k.box('diamond_plate', 0.25, 0.03, 0.9, x + 0.125, y - 0.015, 0, { c: 0.005 });                       // 踏板：比一级的进深多出 5 厘米，伸到上一级的下面
      k.box('paint_yellow', 0.035, 0.034, 0.9, x + 0.016, y - 0.015, 0, { c: 0.006 });         // 前缘的黄色防滑条
      for (const s of [-1, 1]) k.box('steel_dark', 0.2, 0.05, 0.01, x + 0.13, y - 0.05, s * 0.452, { plain: true });   // 托着踏板的角码
    }
    for (const s of [-1, 1]) {
      k.bar('steel_dark', [start + 0.07, 0.13, s * 0.465], [flightEnd + 0.04, 2.5, s * 0.465], 0.24, 0.014, { c: 0.004 });   // 斜梁：一条 24 厘米宽的扁钢
      k.box('steel_galv', 0.3, 0.012, 0.12, start + 0.06, FLOOR + 0.006, s * 0.465, { plain: true });
      for (const dx of [-0.08, 0.1]) k.cyl('steel_galv', 0.012, 0.02, start + 0.06 + dx, FLOOR + 0.02, s * 0.5, { seg: 6, cast: false });
    }
    // 顶平台：一块花纹板，四边的框梁，两条腿，腿之间一个 X 形的拉撑
    k.box('diamond_plate', 0.64, 0.035, 0.96, flightEnd + 0.3, top - 0.0175, 0, { c: 0.005 });
    k.box('paint_yellow', 0.035, 0.038, 0.96, flightEnd + 0.016, top - 0.0175, 0, { c: 0.006 });
    for (const s of [-1, 1]) k.box('steel_dark', 0.66, 0.16, 0.06, flightEnd + 0.3, top - 0.115, s * 0.47, { c: 0.008 });
    k.box('steel_dark', 0.06, 0.16, 0.96, 1.47, top - 0.115, 0, { c: 0.008 });
    k.box('steel_dark', 0.06, 0.12, 0.9, flightEnd + 0.02, top - 0.1, 0, { c: 0.008 });
    for (const s of [-1, 1]) {
      post(k, 'steel_dark', 0.08, 0.08, 1.44, FLOOR, top - 0.19, s * 0.45);
      k.box('steel_galv', 0.18, 0.012, 0.18, 1.44, FLOOR + 0.006, s * 0.45, { plain: true });
      k.bar('steel_dark', [1.44, 1.5, s * 0.45], [flightEnd + 0.1, top - 0.2, s * 0.45], 0.05, 0.05);     // 斜撑：从腿上顶住平台的前沿
      // X 形拉撑：两条扁钢，宽的一面在两条腿所在的平面里，前后错开 1 厘米免得在交叉点互相穿过
      k.bar('steel_dark', [1.44 + s * 0.005, 0.15, -s * 0.42], [1.44 + s * 0.005, 2.2, s * 0.42], 0.008, 0.045, { plain: true });
    }
    k.box('steel_dark', 0.06, 0.06, 0.82, 1.44, 1.2, 0, { c: 0.006 });

    // 栏杆：两侧各 5 根立柱、两道扶手。扶手先顺着楼梯斜上去，到平台拐成水平
    const x0 = start + 0.1, x3 = flightEnd + 0.03, x4 = 1.47, y0 = noseLine(x0);
    /** 扶手的基准线在 x 处的高度（两道扶手分别在它上面 1 米和 0.52 米）。 */
    const railLine = (x: number) => (x >= x3 ? top : y0 + ((top - y0) * (x - x0)) / (x3 - x0));
    for (const s of [-1, 1]) {
      const z = s * 0.485;
      for (const x of [x0, start + 0.9, start + 1.7, x3, x4]) {
        const foot = (x >= x3 ? top : noseLine(x) - (x > x0 ? 0.1 : 0)) - 0.12;   // 立柱的下端夹在斜梁（或平台框梁）的外侧
        k.tube('paint_yellow', [x, foot, z], [x, railLine(x) + 1, z], 0.019, { seg: 7 });   // 立柱一直顶到上扶手（参考里中间两根短了 9 厘米，扶手悬在柱顶上方）
        k.box('steel_dark', 0.07, 0.1, 0.012, x, foot + 0.02, z - s * 0.012, { plain: true });
      }
      for (const [h, r] of [[1, 0.021], [0.52, 0.016]]) {
        k.path('paint_yellow', [[x0, y0 + h, z], [x3, top + h, z], [x4, top + h, z]], r, { seg: 7 });
        for (const x of [x0, x4]) k.sph('paint_yellow', r * 1.05, x, railLine(x) + h, z, { seg: 7 });   // 两头的球节
      }
      k.box('steel_dark', 0.6, 0.1, 0.008, flightEnd + 0.3, top + 0.05, s * 0.476, { plain: true });        // 平台的踢脚板
    }
  });

  // ---- 碰撞：一级踏步一个盒子（从地面一直到这一级的顶面）。人走路时可以直接迈上不高的台阶，20 厘米一级就这样一级级走上去
  const wx = (x: number) => STAIR.x - x;   // 钢梯自己的 x → 世界 x（转了 180°，所以是减）
  for (let i = 0; i < steps; i++) collide(boxes, wx(start + i * run), 0, STAIR.z - 0.5, wx(start + (i + 1) * run), (i + 1) * rise, STAIR.z + 0.5);
  collide(boxes, wx(flightEnd), top - 0.2, STAIR.z - 0.5, wx(1.5), top, STAIR.z + 0.5);
  for (const s of [-1, 1]) {
    collide(boxes, wx(1.4), 0, STAIR.z + s * 0.45 - 0.04, wx(1.48), top - 0.2, STAIR.z + s * 0.45 + 0.04);
    // 栏杆只挡人。盒子贴在栏杆的外侧（内侧面离中线 0.5 米），给 0.72 米宽的人留出 1 米的通道，不然上楼梯要对得很准
    const z0 = STAIR.z + s * 0.5, z1 = STAIR.z + s * 0.56;
    collide(boxes, wx(flightEnd), top, z0, wx(1.5), top + 1.02, z1, { playerOnly: true });
    // 斜的那一段：每 3 级合用一个盒子，从这 3 级里最低一级的顶面，到最高一级的顶面再加 1 米。
    // （参考里这一段没有碰撞，人可以从楼梯侧面穿过栏杆走出去。）
    for (let i = 0; i < steps; i += 3) collide(boxes, wx(start + i * run), (i + 1) * rise, z0, wx(start + (i + 3) * run), (i + 3) * rise + 1, z1, { playerOnly: true });
  }
}

// ------------------------------------------------------------------ 工作台
function buildWorkbench(k: Kit, boxes: LocalBox[]) {
  const { x0, x1, front, back, top } = BENCH, mid = (x0 + x1) / 2;
  const wallZ = WORKSHOP.z1 - LINING;   // 南墙内衬板的表面

  // ---- 台子：厚木台面、6 条钢腿、一层搁板、一个抽屉柜
  slab(k, 'wood_pallet', x0, top - 0.06, front, x1, top, back, { c: 0.012, grain: 'x', tint: DARK_WOOD });
  for (const x of [x0 + 0.06, mid, x1 - 0.06]) for (const z of [front + 0.06, back - 0.06]) post(k, 'steel_dark', 0.05, 0.05, x, FLOOR, top - 0.06, z, { bevel: 0.006, ring: 0.25, tint: k.range(0.8, 1) });
  for (const z of [front + 0.06, back - 0.06]) slab(k, 'steel_dark', x0 + 0.06, top - 0.12, z - 0.02, x1 - 0.06, top - 0.06, z + 0.02, { plain: true });   // 台面下的横档
  slab(k, 'steel_dark', x0 + 0.04, 0.2, front + 0.06, x1 - 0.04, 0.23, back - 0.04, { c: 0.004 });
  slab(k, 'paint_grey', x0 + 0.1, 0.55, front + 0.04, x0 + 1.3, top - 0.08, back - 0.05, { c: 0.01 });
  for (const y of [0.63, 0.78]) {   // 两个抽屉：一道缝、一个拉手
    k.box('steel_dark', 1.16, 0.006, 0.004, x0 + 0.7, y - 0.075, front + 0.038, { plain: true, tint: 0.4 });
    k.box('steel_bare', 0.3, 0.018, 0.02, x0 + 0.7, y, front + 0.03, { c: 0.004 });
  }
  // 搁板上的东西
  k.box('cardboard', 0.45, 0.3, 0.36, 3.6, 0.38, -11.68, { c: 0.008, rot: [0, 0.1, 0] });
  k.box('plastic_blue', 0.4, 0.26, 0.5, 4.38, 0.36, -11.67, { c: 0.02, tint: 0.8 });
  k.box('paint_red', 0.17, 0.3, 0.3, 3.05, 0.38, -11.7, { c: 0.03, rot: [0, -0.2, 0] });
  k.cyl('polymer_black', 0.022, 0.04, 3.05, 0.55, -11.62, { seg: 6 });

  // ---- 洞洞板：挂在三根竖着的安装条上（墙裙以上的墙面比墙裙缩进去 12 厘米，板子直接贴"墙"会悬空，所以垫这三根条）
  slab(k, 'wood_pallet', x0, 1.25, back - 0.02, x1, 2.3, back + 0.01, { plain: true, tint: 0.92 });
  for (const x of [x0 + 0.3, mid, x1 - 0.3]) slab(k, 'steel_galv', x - 0.025, 1.2, back + 0.01, x + 0.025, 2.54, wallZ + 0.01, { plain: true, tint: 0.8 });
  // 板上挂的 7 件工具：一根长短粗细不一的钢杆，下半截套一个把手，交替着是螺丝刀（细杆）和扳手、锤子（粗杆加一个头）
  for (let i = 0; i < 7; i++) {
    const x = x0 + 0.3 + i * 0.42, z = back - 0.04, r = 0.012 + (i % 2) * 0.006;
    const y0 = 1.5 + (i % 3) * 0.12, y1 = 2.05 + (i % 2) * 0.1;
    k.tube('steel_galv', [x, y0, z], [x, y1, z], r, { cast: false, cap: true });
    k.tube(i % 2 ? 'polymer_black' : i % 3 ? 'paint_red' : 'paint_yellow', [x, y0 - 0.01, z], [x, y0 + 0.17, z], r + 0.009, { seg: 7, cap: true });
    if (i % 2) k.box('steel_dark', 0.11, 0.04, 0.035, x, y1 - 0.01, z, { c: 0.006 });       // 锤头 / 扳手头
    k.tube('steel_galv', [x - 0.03, y1 - 0.06, back - 0.02], [x - 0.03, y1 - 0.055, z - 0.03], 0.004, { seg: 4, cast: false });   // 挂钩
    k.tube('steel_galv', [x + 0.03, y1 - 0.06, back - 0.02], [x + 0.03, y1 - 0.055, z - 0.03], 0.004, { seg: 4, cast: false });
  }

  // ---- 台面上的零碎
  // 台钳：底座、固定钳口、活动钳口、丝杠，丝杠头上一根横着的手柄
  k.at([x1 - 0.5, top, front + 0.2], null, () => {
    k.box('steel_dark', 0.16, 0.05, 0.3, 0, 0.025, 0, { c: 0.01 });
    k.box('steel_dark', 0.14, 0.11, 0.07, 0, 0.1, 0.08, { c: 0.012 });
    k.box('steel_dark', 0.14, 0.11, 0.07, 0, 0.1, -0.04, { c: 0.012 });
    for (const z of [0.042, -0.002]) k.box('steel_bare', 0.13, 0.03, 0.006, 0, 0.14, z, { plain: true });   // 两片磨亮的钳口铁
    k.tube('steel_galv', [0, 0.08, -0.06], [0, 0.08, -0.2], 0.014, { seg: 7, cap: true });
    k.tube('steel_galv', [-0.1, 0.08, -0.19], [0.1, 0.08, -0.19], 0.007, { seg: 5, cap: true });
    for (const x of [-0.1, 0.1]) k.sph('steel_galv', 0.012, x, 0.08, -0.19, { seg: 6 });
  });
  // 红色工具箱：斜放着，顶上一个提手，正面两个搭扣
  k.at([x0 + 1.9, top, front + 0.35], [0, 0.3, 0], () => {
    k.box('paint_red', 0.45, 0.22, 0.24, 0, 0.11, 0, { c: 0.02 });
    k.box('steel_dark', 0.44, 0.006, 0.006, 0, 0.15, 0.121, { plain: true, tint: 0.4 });   // 箱盖的缝
    for (const x of [-0.13, 0.13]) k.box('steel_galv', 0.04, 0.05, 0.01, x, 0.15, 0.123, { plain: true, cast: false });
    k.path('steel_dark', [[-0.1, 0.22, 0], [-0.1, 0.25, 0], [0.1, 0.25, 0], [0.1, 0.22, 0]], 0.008, { seg: 5 });
  });
  // 两把扳手随手扔在台面上、一个零件盒（里面几颗螺栓）、一罐喷剂、一把油壶
  for (const [x, z, yaw, len] of [[2.25, -11.82, 0.5, 0.24], [2.48, -11.72, -0.35, 0.19]]) {
    k.box('steel_bare', len, 0.006, 0.022, x, top + 0.004, z, { plain: true, rot: [0, yaw, 0] });
    k.cyl('steel_bare', 0.02, 0.007, x + Math.cos(yaw) * len * 0.5, top + 0.0045, z - Math.sin(yaw) * len * 0.5, { seg: 8 });
  }
  k.at([3.0, top, -11.5], [0, -0.12, 0], () => {
    k.box('plastic_blue', 0.3, 0.008, 0.2, 0, 0.004, 0, { plain: true });
    for (const s of [-1, 1]) { k.box('plastic_blue', 0.3, 0.06, 0.008, 0, 0.03, s * 0.096, { plain: true }); k.box('plastic_blue', 0.008, 0.06, 0.2, s * 0.146, 0.03, 0, { plain: true }); }
    for (const [x, z] of [[-0.07, 0.02], [0.03, -0.04], [0.08, 0.05], [-0.02, -0.01]]) k.cyl('steel_galv', 0.012, 0.03, x, 0.02, z, { seg: 6, rot: [HALF_PI, 0, x * 9], cast: false });
  });
  k.cyl('paint_white', 0.032, 0.17, 4.05, top + 0.085, -11.52, { seg: 10, tint: 1.1 });
  k.cyl('paint_red', 0.014, 0.03, 4.05, top + 0.185, -11.52, { seg: 6 });
  k.lathe('paint_yellow', [[0.05, 0], [0.05, 0.1], [0.012, 0.15], [0.006, 0.26]], 3.75, top, -11.45, { seg: 10 });

  // ---- 灯：一块挑出来的灯檐（两头各一根斜撑），下面贴一条暖白的灯带
  slab(k, 'steel_dark', x0, 2.5, back - 0.3, x1, 2.53, back + 0.01, { c: 0.004 });
  slab(k, 'steel_dark', x0, 2.44, back - 0.3, x1, 2.5, back - 0.29, { plain: true });
  for (const x of [x0 + 0.3, x1 - 0.3]) k.bar('steel_dark', [x, 2.5, back - 0.28], [x, 2.22, back + 0.02], 0.02, 0.02, { plain: true });
  k.box(emissive(0xfff0d0, 3), x1 - x0 - 0.4, 0.03, 0.1, mid, 2.48, back - 0.18, { raw: true, plain: true });

  collide(boxes, x0, 0, front, x1, top, back, { surface: 'wood' });
}

// ------------------------------------------------------------------ 门边的配电箱
/**
 * 参考里有一张"高压危险"的贴纸悬在南门洞旁边的半空（坐标落在门洞里，看起来是写错了）。
 * 贴纸总得贴在什么东西上：这里在门东侧的墙上装一只配电箱，贴纸贴在箱门上；
 * 一根线管从箱顶上去，接到卷帘门的电机盒，另一根下到地里。
 */
function buildPowerBox(k: Kit) {
  const wallZ = WORKSHOP.z1 - LINING, face = wallZ - 0.16;
  slab(k, 'paint_grey', -0.6, 1.42, face, 0, 2.18, wallZ + 0.01, { c: 0.012 });
  k.box('steel_dark', 0.004, 0.7, 0.004, -0.57, 1.8, face - 0.001, { plain: true, tint: 0.4 });   // 箱门的合页缝
  k.box('steel_bare', 0.025, 0.09, 0.02, -0.05, 1.8, face - 0.01, { c: 0.004 });                  // 门把手
  k.decal('hazard_voltage', 0.5, [-0.3, 1.9, face - 0.002], [0, Math.PI, 0]);
  const pipeZ = wallZ - 0.09;
  k.path('steel_galv', [[-0.42, 2.18, pipeZ], [-0.42, 5.02, pipeZ], [-0.42, 5.22, pipeZ - 0.2]], 0.016, { seg: 6, cast: false });
  k.tube('steel_galv', [-0.15, 1.42, face + 0.03], [-0.15, FLOOR, face + 0.03], 0.016, { seg: 6, cast: false });
  for (const y of [2.9, 4.2]) k.box('steel_galv', 0.07, 0.02, 0.1, -0.42, y, pipeZ + 0.04, { plain: true, cast: false, tint: 0.8 });   // 管卡
}

// ------------------------------------------------------------------ 龙门吊架和发动机
function buildGantry(k: Kit, boxes: LocalBox[]) {
  const { x: cx, z: cz, half, apex } = GANTRY;
  // A 字腿的中心线从地面的 (cz ± 0.9) 汇到 3.3 米高的 (cz)。腿不直接戳到地上：下面是脚轮，所以从轮架的顶面（离地 14 厘米）开始
  const legLift = 0.14, legSpread = 0.9 * (1 - legLift / (apex - FLOOR));
  for (const side of [-1, 1]) {
    const x = cx + side * half, tint = k.range(0.88, 1);
    for (const s of [-1, 1]) {
      const footZ = cz + s * legSpread;
      k.tube('paint_yellow', [x, FLOOR + legLift, footZ], [x, apex, cz], 0.045, { seg: 10, cap: true, tint });
      // 脚轮：一块安装板、两片轮叉、一只胶轮
      k.box('steel_dark', 0.13, 0.016, 0.16, x, FLOOR + legLift - 0.008, footZ, { plain: true });
      for (const dx of [-0.04, 0.04]) k.box('steel_dark', 0.008, 0.1, 0.07, x + dx, FLOOR + 0.085, footZ, { plain: true });
      k.cyl('rubber', 0.07, 0.06, x, FLOOR + 0.07, footZ, { axis: 'x', seg: 12 });
      k.cyl('steel_galv', 0.03, 0.064, x, FLOOR + 0.07, footZ, { axis: 'x', seg: 8, cast: false });
    }
    k.tube('paint_yellow', [x, 1, cz - 0.62], [x, 1, cz + 0.62], 0.03, { seg: 8, tint });                 // 横拉杆：不让两条腿劈开
    k.box('paint_yellow', 0.012, 0.34, 0.3, x, apex - 0.1, cz, { c: 0.004, tint });                       // 腿顶和横梁之间的节点板
    // 碰撞：一组 A 字腿在碰撞上是一片只挡人的薄墙（腿和拉杆之间人本来也钻不过去），子弹可以从腿之间穿过
    collide(boxes, x - 0.06, 0, cz - 0.78, x + 0.06, 1.9, cz + 0.78, { playerOnly: true });
  }
  ibeamX(k, 'paint_yellow', 2 * half + 0.5, 0.22, 0.14, cx, apex + 0.1, cz);
  for (const s of [-1, 1]) k.box('steel_dark', 0.02, 0.1, 0.12, cx + s * (half + 0.22), apex + 0.045, cz, { plain: true });   // 梁端的挡块：葫芦滑到头会被它拦住

  // 手拉葫芦：挂在横梁的下翼缘上
  const hx = cx + 0.2;
  k.box('steel_dark', 0.3, 0.26, 0.24, hx, apex - 0.14, cz, { c: 0.02 });
  for (const s of [-1, 1]) k.box('steel_dark', 0.2, 0.1, 0.012, hx, apex + 0.03, cz + s * 0.085, { plain: true });   // 夹住下翼缘的两片吊板
  k.label('2T', { color: 'yellow', font: 'stencil', distress: 0.4 }, 0.2, 0.09, [hx, apex - 0.14, cz + 0.122]);
  k.tube('steel_galv', [hx + 0.12, apex - 0.26, cz], [hx + 0.14, 2.2, cz + 0.02], 0.008, { seg: 5, cast: false });   // 手拉链

  // 发动机：在自己的坐标系里搭（原点在缸体中心），整体歪一点 —— 吊着的东西不会是端正的
  const engine: V3 = [hx, 1.42, cz], tilt: V3 = [0, 0.2, 0.05];
  k.at(engine, tilt, () => {
    k.box('steel_dark', 0.85, 0.5, 0.55, 0, 0, 0, { c: 0.03 });                                           // 缸体
    k.box('steel_dark', 0.7, 0.16, 0.42, 0, 0.32, 0, { c: 0.02, tint: WORN });                            // 缸盖
    k.box('paint_blue', 0.62, 0.07, 0.3, 0, 0.43, 0, { c: 0.025 });                                       // 气门室盖
    for (const x of [-0.24, -0.08, 0.08, 0.24]) k.cyl('steel_dark', 0.016, 0.02, x, 0.47, 0, { seg: 6 });
    k.box('steel_dark', 0.62, 0.14, 0.4, 0, -0.31, 0, { c: 0.03, tint: 0.75 });                           // 油底壳
    k.cyl('steel_bare', 0.16, 0.12, -0.485, -0.02, 0, { axis: 'x', seg: 14 });                            // 飞轮
    k.cyl('steel_dark', 0.2, 0.05, -0.44, -0.02, 0, { axis: 'x', seg: 14 });                              // 飞轮壳的法兰
    k.cyl('steel_dark', 0.09, 0.05, 0.45, -0.1, 0, { axis: 'x', seg: 10 });                               // 曲轴皮带轮
    k.cyl('steel_dark', 0.05, 0.04, 0.445, 0.14, 0.16, { axis: 'x', seg: 8 });                            // 发电机皮带轮
    // 排气歧管：四根短管汇到一根总管上，锈的
    for (const x of [-0.27, -0.09, 0.09, 0.27]) k.tube('steel_dark', [x, 0.26, 0.2], [x, 0.14, 0.34], 0.028, { seg: 6, tint: RUSTY });
    k.tube('steel_dark', [-0.32, 0.14, 0.34], [0.32, 0.14, 0.34], 0.036, { seg: 7, cap: true, tint: RUSTY });
    k.box('steel_bare', 0.5, 0.1, 0.12, 0, 0.24, -0.3, { c: 0.02 });                                       // 进气歧管
    k.cyl('paint_orange', 0.04, 0.1, 0.2, -0.12, -0.31, { axis: 'z', seg: 8 });                           // 机油滤清器
    // 吊具：缸盖两头各一只吊耳，两根链子在上方汇到吊钩上
    for (const x of [-0.26, 0.26]) {
      k.box('steel_galv', 0.012, 0.06, 0.05, x, 0.49, 0, { plain: true });
      k.tube('steel_galv', [x, 0.5, 0], [0, 0.74, 0], 0.008, { seg: 5, cast: false });
    }
    k.torus('steel_galv', 0.035, 0.009, 0, 0.77, 0, { axis: 'z', seg: 10, tubeSeg: 5 });
    k.box('paint_yellow', 0.07, 0.1, 0.05, 0, 0.86, 0, { c: 0.01 });                                      // 吊钩的滑轮壳
  });
  // 起重链：从葫芦垂到吊钩。吊钩在发动机歪过去的那一侧，所以链子的下端也跟着偏一点
  k.tube('steel_galv', [hx, apex - 0.26, cz], [hx - 0.045, 1.42 + 0.9, cz], 0.012, { seg: 6 });

  // 碰撞：吊在半空的发动机是实的（挡人也挡子弹），它下面是空的
  collide(boxes, hx - 0.58, 1.1, cz - 0.38, hx + 0.5, 1.92, cz + 0.38);
}

// ------------------------------------------------------------------ 货架
/** 往贴纸表里补一张"立柱上的冲孔"。贴纸表里已经有同名的就不动它。 */
function registerDecals() {
  // 货架立柱的正面每隔 10 厘米有一对长圆孔（挂横梁用）。一组货架 4 根柱子、每根 40 对，要是每个孔都做成一张小面片，
  // 9 组货架就是一万多个三角形。这里把"8 对孔"画成一张 7 × 80 厘米的竖条贴纸，一根柱子贴 5 张就够了。
  const PX = 800;   // 每米画多少像素
  const def: DecalDef = {
    w: 0.07 * PX, h: 0.8 * PX, rough: 0.9, bleed: [10, 11, 13],
    draw(g) {
      for (let row = 0; row < 8; row++) for (const side of [-1, 1]) {
        const x = (0.035 + side * 0.022 - 0.007) * PX, y = (row * 0.1 + 0.05 - 0.017) * PX, w = 0.014 * PX, h = 0.034 * PX;
        g.fillStyle = 'rgba(9,10,12,0.96)';
        g.fillRect(x, y, w, h);
        g.fillStyle = 'rgba(120,140,170,0.45)';   // 孔的下沿露出一线钢板的厚度，稍微亮一点
        g.fillRect(x + 1.5, y + h - 2.5, w - 3, 1.5);
      }
    },
  };
  DECALS.rack_holes ??= def;
}

/** 货架上用的简化托盘（1.2 × 0.144 × 1.0 米），底面在 y。只用直角盒：一组货架上有六七只，压在货下面也看不清倒角。 */
function addShelfPallet(k: Kit, rng: Rng, y: number, dx = 0, dz = 0) {
  const wood = (mul = 1): Tint => { const u = (0.62 + 0.38 * rng()) * mul; return [u, u * 0.96, u * 0.87]; };
  for (let i = -2; i <= 2; i++) board(k, i === 0 ? 0.16 : 0.14, 0.022, 1, dx + i * 0.2525, y + 0.133, dz, rng, { tint: wood(), grain: 'z' });   // 面板 5 条
  for (const z of [-0.45, 0, 0.45]) {
    board(k, 1.15, 0.022, 0.1, dx, y + 0.111, dz + z, rng, { tint: wood(), grain: 'x' });   // 纵梁板
    board(k, 1.15, 0.022, 0.1, dx, y + 0.011, dz + z, rng, { tint: wood(), grain: 'x' });   // 底板
    for (const x of [-0.505, 0, 0.505]) if (x || z) board(k, 0.14, 0.078, 0.1, dx + x, y + 0.061, dz + z, rng, { tint: wood(0.8) });   // 垫块（正中间那块哪边都看不见，省掉）
  }
}

type LoadKind = 'cartons' | 'wrapped' | 'drums' | 'pallets';
/** 圆桶的侧面轮廓 [半径, 高度]：直筒上两道外鼓的滚箍、一圈桶口的卷边，桶盖比桶口低 1.4 厘米。 */
const DRUM_PROFILE: [number, number][] = [
  [0.225, 0], [0.225, 0.27], [0.233, 0.29], [0.225, 0.31], [0.225, 0.56], [0.233, 0.58], [0.225, 0.6], [0.225, 0.835], [0.232, 0.845], [0.232, 0.86],
  [0.232, 0.86], [0.212, 0.86], [0.212, 0.86], [0.212, 0.846], [0.212, 0.846], [0, 0.846],
];

/** 一个货位上的货：先垫一只托盘，上面按 kind 摆。放在当前坐标系的原点。 */
function addLoad(k: Kit, kind: LoadKind, rng: Rng) {
  addShelfPallet(k, rng, 0);
  const top = 0.144;   // 托盘的顶面
  if (kind === 'cartons') {
    // 纸箱垛：2–3 层，每层 2 × 2 只。最上面一层每只有四分之一的可能已经被拿走
    const layers = 2 + Math.floor(rng() * 2), h = 0.36;
    /** 四个角上各摞了几只箱子（打包带要顺着这个高度走）。 */
    const count = new Map<string, number>();
    for (let l = 0; l < layers; l++) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (l === layers - 1 && rng() < 0.25) continue;
      count.set(`${sx},${sz}`, l + 1);
      const shade = 0.82 + 0.18 * rng();
      k.at([sx * 0.272 + (rng() - 0.5) * 0.02, top + h * l, sz * 0.237 + (rng() - 0.5) * 0.02], [0, (rng() - 0.5) * 0.05, 0], () => {
        k.box('cardboard', 0.53, h - 0.006, 0.46, 0, h / 2, 0, { c: 0.008, tint: shade });
        // 封箱胶带：箱顶一条，朝外的那一头垂下来 7 厘米（朝里的那头贴着隔壁的箱子，看不见）
        k.plane('polymer_tan', 0.534, 0.05, [0, h - 0.002, 0], { rot: [-HALF_PI, 0, 0], cast: false });
        k.plane('polymer_tan', 0.05, 0.07, [sx * 0.2662, h - 0.038, 0], { rot: [0, sx * HALF_PI, 0], cast: false });
        k.plane('paint_white', 0.11, 0.075, [sx * 0.1, h * 0.42, sz * 0.2312], { rot: [0, sz > 0 ? 0 : Math.PI, 0], tint: 1.3 });   // 朝外那一面的运单标签
      });
    }
    // 两道黑色打包带：从前面兜上去、压过箱顶、从后面下来。前后两摞不一样高的话，带子在中间跟着落一级
    for (const sx of [-1, 1]) {
      const front = (count.get(`${sx},1`) ?? 0) * h, back = (count.get(`${sx},-1`) ?? 0) * h, lift = 0.004;
      k.strip('polymer_black', [[sx * 0.3, top - 0.03, 0.476], [sx * 0.3, top + front + lift, 0.476], [sx * 0.3, top + front + lift, 0], [sx * 0.3, top + back + lift, 0], [sx * 0.3, top + back + lift, -0.476], [sx * 0.3, top - 0.03, -0.476]], [0.008, 0, 0], { cast: true });
    }
  } else if (kind === 'wrapped') {
    // 缠膜垛：三层货摞成一整垛，外面裹一层半透明的缠绕膜，四个角各一根纸护角
    const H = 0.9 + rng() * 0.25, shade = 0.8 + 0.2 * rng();
    for (let i = 0; i < 3; i++) k.box('cardboard', 1.08 - (i % 2) * 0.012, H / 3 - 0.004, 0.92 - (i % 2) * 0.01, 0, top + (H / 3) * (i + 0.5), 0, { c: 0.01, tint: shade * (0.92 + 0.08 * rng()) });
    k.box('glass_dirty', 1.1, H + 0.012, 0.94, 0, top + H / 2 + 0.002, 0, { c: 0.03, cast: false });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('cardboard', 0.05, H * 0.96, 0.05, sx * 0.535, top + H / 2, sz * 0.455, { c: 0.004, tint: 1.12 });
    k.plane('paint_white', 0.34, 0.09, [0.2, top + H * 0.7, 0.4712], { tint: 1.3 });
    k.label(`批次 ${1000 + Math.floor(rng() * 8999)}`, { color: 'black', font: 'sans', distress: 0.1 }, 0.3, 0.06, [0.2, top + H * 0.7, 0.4728]);
  } else if (kind === 'drums') {
    // 四只塑料桶（三成是红的），拦腰一圈打包带
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * 0.285, z = sz * 0.24, red = rng() < 0.3, shade = 0.85 + 0.15 * rng();
      k.lathe(red ? 'paint_red' : 'plastic_blue', DRUM_PROFILE, x, top, z, { seg: 12, tint: shade });
      k.cyl('polymer_black', 0.03, 0.02, x + 0.13, top + 0.856, z, { seg: 6 });   // 桶盖上的注液口
    }
    // 带子绷在四只桶的外面：在每只桶上绕过四分之一圈（取 0°、45°、90° 三个点），桶和桶之间是直的
    const band: V3[] = [];
    for (const [sx, sz, from] of [[1, 1, 1], [1, -1, 0], [-1, -1, 3], [-1, 1, 2]]) for (let i = 0; i <= 2; i++) {
      const a = (from - i * 0.5) * HALF_PI;   // 从正上方看顺时针走：+z 侧 → +x 侧 → −z 侧 → −x 侧
      band.push([sx * 0.285 + Math.cos(a) * 0.2345, top + 0.44, sz * 0.24 + Math.sin(a) * 0.2345]);
    }
    band.push(band[0]);
    k.strip('polymer_black', band, [0, 0.015, 0], { cast: true });
  } else {
    // 一摞空托盘：再摞 2–5 只，每只都歪一点
    const more = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < more; i++) addShelfPallet(k, rng, top + i * 0.146, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.04);
  }
}

/** 一组货架，放在当前坐标系的原点（正面朝 +z）。 */
function addRack(k: Kit, seed: number) {
  const { h, postX, postZ, levels } = RACK, rng = mulberry32(seed + 21);
  /** 立柱的漆：柱脚被叉车、拖把、脏水折腾得最狠，所以脚下暗三成，到半米高恢复正常。 */
  const scuffed: Tint = (_x, y) => 0.7 + 0.3 * smoothstep(0, 0.5, y - FLOOR);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      post(k, 'paint_blue', 0.09, 0.07, sx * postX, 0, h, sz * postZ, { tint: scuffed, ring: 0.5 });
      k.box('steel_galv', 0.14, 0.01, 0.12, sx * postX, 0.005, sz * postZ, { plain: true, cast: false });                 // 柱脚板
      for (const dx of [-0.057, 0.057]) k.cyl('steel_galv', 0.01, 0.02, sx * postX + dx, 0.016, sz * postZ, { seg: 6, cast: false, tint: 0.8 });   // 两颗地脚螺栓
      // 冲孔：前排柱子贴在正面，后排柱子贴在背面
      for (let i = 0; i < 5; i++) k.decal('rack_holes', 0.07, [sx * postX, 0.47 + i * 0.8, sz * (postZ + 0.0356)], sz > 0 ? undefined : [0, Math.PI, 0], 0.8);
    }
    // 两头的缀条：前后两根柱子之间 5 道横杆，中间 4 道之字形的斜杆。有了它，一前一后两根柱子才是一片稳当的"梯子"
    const ys = [0.2, 1.1, 2, 2.9, 3.8];
    ys.forEach((y, i) => {
      k.box('paint_blue', 0.03, 0.03, 2 * postZ - 0.07, sx * postX, y, 0, { plain: true });
      if (i + 1 < ys.length) { const s = i % 2 ? 1 : -1; k.bar('paint_blue', [sx * postX, y, s * (postZ - 0.04)], [sx * postX, ys[i + 1], -s * (postZ - 0.04)], 0.03, 0.03, { plain: true }); }
    });
    k.box('paint_yellow', 0.14, 0.4, 0.02, sx * postX, 0.2, postZ + 0.06, { c: 0.006 });   // 正面柱脚的黄色防撞护板
  }

  for (const y of levels) {
    for (const sz of [-1, 1]) {
      k.box('paint_orange', 2 * postX - 0.09, 0.12, 0.05, 0, y, sz * (postZ + 0.01), { c: 0.008 });                       // 橙色横梁
      for (const sx of [-1, 1]) k.box('paint_orange', 0.012, 0.2, 0.065, sx * (postX - 0.051), y - 0.02, sz * (postZ + 0.005), { plain: true, tint: 0.85 });   // 梁端的挂钩片
    }
    // 层板：3 根托梁上铺一张钢丝网（10 根顺着货架的 + 13 根横着的）
    for (const x of [-0.85, 0, 0.85]) k.box('steel_galv', 0.04, 0.025, 2 * postZ, x, y + 0.045, 0, { plain: true });
    for (let i = 0; i < 10; i++) k.box('steel_galv', 2 * postX - 0.1, 0.006, 0.006, 0, y + 0.062, -0.45 + i * 0.1, { plain: true, cast: false });
    for (let i = 0; i < 13; i++) k.box('steel_galv', 0.006, 0.006, 2 * postZ + 0.04, -1.2 + i * 0.2, y + 0.066, 0, { plain: true, cast: false });
  }

  // 标签：下层梁上是货位号，上层梁上是限重。黑字印在一张白底的不干胶上
  const ink = { color: 'black', font: 'sans', distress: 0.1 } as const, face = postZ + 0.035;
  k.plane('paint_white', 0.38, 0.09, [0, levels[0], face + 0.0012], { tint: 1.3 });
  k.label(`货位 ${String.fromCharCode(65 + (seed % 6))}-${10 + (seed % 40)}`, ink, 0.34, 0.07, [0, levels[0], face + 0.0024]);
  k.plane('paint_white', 0.54, 0.062, [0.6, levels[1], face + 0.0012], { tint: 1.3 });
  k.label('每层限重2000千克', ink, 0.5, 0.045, [0.6, levels[1], face + 0.0024]);

  // 货：3 层（地面、两层层板）× 2 个货位，每个货位按种子抽一种。表里纸箱垛和缠膜垛各出现两次，所以它们最常见
  const kinds: (LoadKind | 'none')[] = ['cartons', 'wrapped', 'drums', 'cartons', 'wrapped', 'pallets', 'none'];
  [0, levels[0] + 0.069, levels[1] + 0.069].forEach((y, level) => {
    for (const side of [-1, 1]) {
      let kind = kinds[Math.floor(rng() * kinds.length)];
      if (level === 2 && kind === 'drums') kind = 'wrapped';   // 顶层不放桶：太重，也够不着
      if (kind === 'none') continue;
      const load = kind;
      k.at([side * 0.615 + (rng() - 0.5) * 0.03, y, (rng() - 0.5) * 0.05], null, () => addLoad(k, load, rng));
    }
  });
}

function buildRacks(k: Kit, boxes: LocalBox[]) {
  registerDecals();
  for (const [x, z, seed] of RACKS) {
    k.at([x, FLOOR, z], null, () => addRack(k, seed));
    // 整组货架是一个实心盒：层板之间的空当在碰撞上也是实的（和参考一样），货架就是一堵可以当掩体的墙
    collide(boxes, x - 1.35, 0, z - 0.55, x + 1.35, RACK.h, z + 0.55);
  }
}

// ------------------------------------------------------------------ 地面细节
function buildFloorDetails(k: Kit, roofHoles: Workshop['roofHoles']) {
  const flat = (yaw: number): V3 => [-HALF_PI, 0, yaw];   // 把一张竖着的贴纸放平（朝上），再在地上转 yaw
  const y = FLOOR + 0.004;                                 // 贴纸比地坪高 4 毫米

  // 叉车停车位上垫的一块钢板，和它旁边漏的一摊油
  slab(k, 'steel_dark', 7.2, FLOOR, -14.6, 8.4, FLOOR + 0.04, -13.6, { c: 0.006 });
  k.decal('oil_stain', 2.2, [7.6, y, -15.2], flat(0.6));
  k.decal('oil_stain', 1.6, [-3.8, y, -13.6], flat(2.1));
  // 南门内的门槛警示线。贴纸本身是 2.4 × 0.6 米的一条，两条接起来正好铺满 5 米宽的门洞
  for (const x of [-4.7, -2.3]) k.decal('caution_stripes', 2.4, [x, y, -11.9], flat(0));
  // 屋面每个破洞的正下方一块水渍。水渍贴纸是竖长的（3 : 4），宽 1.65 米时面积和参考里 1.9 米见方的那块一样大；
  // 转角用"洞在屋面的第几列 × 1.7 弧度"，每块朝向都不同，看不出是同一张图
  for (const hole of roofHoles) {
    const column = Math.round((hole.minX + 16.3) / Math.max(0.1, hole.maxX - hole.minX));
    k.decal('leak_stain', 1.65, [(hole.minX + hole.maxX) / 2 + 0.2, y, (hole.minZ + hole.maxZ) / 2], flat(column * 1.7));
  }

  // 工作台上拖下来的一根气管：从台面上的快速接头出来，翻过台沿垂到地上，弯弯曲曲拖到车间中间，另一头接着一把风炮
  const lay = FLOOR + 0.018;   // 管子的半径是 1.8 厘米，贴地时管心就在这个高度
  k.cyl('steel_galv', 0.014, 0.05, 1.78, BENCH.top + 0.016, -11.78, { axis: 'z', seg: 6, cast: false });
  k.hose('rubber', [[1.78, BENCH.top + 0.018, -11.8], [1.74, BENCH.top + 0.02, -11.95], [1.68, BENCH.top - 0.02, -12.09], [1.6, 0.6, -12.16], [1.48, 0.22, -12.3], [1.32, lay + 0.01, -12.7],
    [1.2, lay, -13.2], [2.4, lay, -14], [1, lay, -14.9], [-0.8, lay, -14.4], [-1.6, lay, -15.6]], 0.018, { steps: 72, seg: 6 });
  k.at([-1.66, FLOOR, -15.72], [0, 1.1, 0], () => {
    k.cyl('paint_orange', 0.038, 0.17, 0, 0.04, 0, { axis: 'x', seg: 8 });
    k.cyl('steel_dark', 0.022, 0.06, 0.11, 0.04, 0, { axis: 'x', seg: 6 });
    k.box('polymer_black', 0.045, 0.036, 0.13, -0.03, 0.02, 0.08, { c: 0.008 });
  });

  // 乙号中继的电缆：北墙墙裙上一只接线盒，电缆从盒底出来、顺着墙垂到地上，再贴地绕到中继柜跟前。
  // 参考里它从 x = −2 下来，会从一组货架的托盘中间穿过去；这里挪到两组货架之间的空当（x = −1.15）
  const skirtZ = WORKSHOP.z0 + SKIRT, r = 0.03, lie = FLOOR + r * 0.95;
  slab(k, 'steel_galv', -1.27, 0.84, skirtZ, -1.03, 1.16, skirtZ + 0.1, { c: 0.008, tint: 0.75 });
  k.hose('rubber', [[-1.15, 0.86, skirtZ + 0.05], [-1.15, 0.5, skirtZ + 0.045], [-1.15, 0.16, skirtZ + 0.06], [-1.15, lie + 0.01, skirtZ + 0.24], [-1.16, lie, -27], [-1.2, lie, -26.3],
    [-1.4, lie, -25.6], [-2.4, lie, -23], [-1.9, lie, -20.3]], r, { steps: 60, seg: 6 });
}

// ------------------------------------------------------------------ 组装
export function buildWorkshopFit(opts: WorkshopFitOptions = {}): WorkshopFit {
  // 全部放进同一只零件箱：同一种材质的零件（不管是办公室的还是货架的）最后合成一个网格，整套陈设只有二十来次绘制调用。
  // 用的是室内版材质（淋不到雨）。参考里货架用的是室外版，在屋里照样是湿的、照样反射天空，那是它的疏漏。
  const k = new Kit('workshopfit', 7, { interior: true });
  const boxes: LocalBox[] = [];

  buildMezzanine(k, boxes);
  buildCatwalk(k, boxes);
  buildStairs(k, boxes);
  buildWorkbench(k, boxes);
  buildPowerBox(k);
  buildGantry(k, boxes);
  buildRacks(k, boxes);
  buildFloorDetails(k, opts.roofHoles ?? DEFAULT_ROOF_HOLES);

  // 碰撞盒是上面手工登记的那一份，所以不要零件箱自动量的外包盒（boxes: []）
  const group = k.finish({ boxes: [], grime: 0.9 }).group;
  return { group, boxes, relayPos: [-2, FLOOR, -19.5] };
}

/**
 * 把搭好的陈设整体摆到地图上，参数和 placeWorkshop() 一样：先绕竖轴转 quarterTurns 个 90°，再平移 (dx, dz)。
 * 网格直接改 group 的位置和朝向；碰撞盒和中继的位置换算成地图坐标后返回。
 */
export function placeWorkshopFit(fit: WorkshopFit, dx: number, dz: number, quarterTurns = 0): WorkshopFit {
  const q = ((quarterTurns % 4) + 4) % 4, cos = [1, 0, -1, 0][q], sin = [0, 1, 0, -1][q];
  const point = (p: V3): V3 => [p[0] * cos + p[2] * sin + dx, p[1], -p[0] * sin + p[2] * cos + dz];
  fit.group.position.set(dx, 0, dz);
  fit.group.rotation.y = (q * Math.PI) / 2;
  fit.group.updateMatrixWorld(true);
  return {
    group: fit.group,
    boxes: fit.boxes.map((b) => {
      const a = point(b.min), c = point(b.max);   // 转完以后原来的"最小角"不一定还是最小角，两个角都换算再重新分大小
      return { ...b, min: [Math.min(a[0], c[0]), a[1], Math.min(a[2], c[2])], max: [Math.max(a[0], c[0]), c[1], Math.max(a[2], c[2])] };
    }),
    relayPos: point(fit.relayPos),
  };
}

// ------------------------------------------------------------------ 通用道具的摆放清单
/** 一件通用道具摆在哪。坐标是参考坐标（和上面的陈设同一套），摆的时候要和陈设做同样的平移。 */
export interface WorkshopProp {
  /** 道具名：CARGO 表里的名字（props/cargo.ts），或者 'forklift'（forklift.ts 的 buildForklift）。 */
  name: string;
  x: number; z: number;
  /** 绕竖轴的转角（弧度），和 PropField.place 的约定一样。 */
  yaw: number;
  /** 底面的高度，不写就是地坪面 0.03。 */
  y?: number;
  /** 传给道具函数的参数（都应该再加上 interior: true）。 */
  args?: Record<string, unknown>;
  /** 不登记碰撞（叠在别的道具顶上的那几件）。 */
  noCollide?: boolean;
  /** 还没有模型的道具（工具车、气瓶架）。 */
  missing?: boolean;
}

/**
 * 车间里的通用道具该摆在哪（照参考的摆法）。这些东西不归这个文件搭，这里只是一份清单，给摆放的代码照着用。
 * 和参考不一样的只有一处：夹层下面那只绿桶从 z = −27 挪到 −26.9，原位置会蹭到北墙的刚架柱。
 */
export const WORKSHOP_PROPS: WorkshopProp[] = [
  // 北墙两组货架之间的空当：一摞托盘，顶上叠一堆纸箱
  { name: 'pallet_stack', x: 0, z: -26.9, yaw: 0.1, args: { seed: 3 } },
  { name: 'cardboard_boxes', x: -0.05, z: -26.9, yaw: 0.5, y: 1.182, args: { seed: 4 }, noCollide: true },
  // 车间中部偏东
  { name: 'crate_stack', x: 2.9, z: -15.9, yaw: 0.12, args: { seed: 11 } },
  { name: 'crate_wood', x: 4.15, z: -16.3, yaw: -0.25, args: { seed: 12 } },
  { name: 'pallet_stack', x: 2, z: -17.3, yaw: 1.45, args: { seed: 13 } },
  { name: 'ibc_tote', x: 6.9, z: -19.6, yaw: 0.1, args: { seed: 14 } },
  { name: 'barrel', x: 7.9, z: -18.5, yaw: 0, args: { seed: 15, color: 'blue' } },
  { name: 'barrel', x: 6, z: -18.4, yaw: 0.6, args: { seed: 16, color: 'red' } },
  // 中部偏西
  { name: 'ibc_tote', x: -7.6, z: -16.4, yaw: -0.08, args: { seed: 17 } },
  { name: 'barrel', x: -8.6, z: -15.3, yaw: 0, args: { seed: 18 } },
  { name: 'barrel', x: -7.9, z: -15, yaw: 0.9, args: { seed: 19, color: 'yellow' } },
  // 东南角：沙袋、叉车、工具车、气瓶架、一只托盘上放着纸箱
  { name: 'sandbags', x: 10.2, z: -16.4, yaw: HALF_PI + 0.05, args: { seed: 20 } },
  { name: 'forklift', x: 8.3, z: -13.9, yaw: 2.75, args: { seed: 21 } },
  { name: 'toolbox_cart', x: 6, z: -12.2, yaw: 0.15, args: { seed: 22 }, missing: true },
  { name: 'gas_cylinders', x: 10.9, z: -11.9, yaw: 0, args: { seed: 23 }, missing: true },
  { name: 'pallet', x: 10.6, z: -13.6, yaw: 0.2, args: { seed: 33 } },
  { name: 'cardboard_boxes', x: 10.6, z: -13.6, yaw: 0.3, y: 0.174, args: { seed: 34 }, noCollide: true },
  // 西南角
  { name: 'tarp_cargo', x: -13.2, z: -13.2, yaw: 0.12, args: { seed: 24 } },
  { name: 'tire_stack', x: -15, z: -15.6, yaw: 0, args: { seed: 25 } },
  { name: 'tire_stack', x: -14.9, z: -16.6, yaw: 0.4, args: { seed: 26 } },
  { name: 'jerry_can', x: -9.3, z: -12, yaw: 0.4, args: { seed: 31 } },
  { name: 'jerry_can', x: -9.7, z: -12.1, yaw: 1.2, args: { seed: 32 } },
  // 夹层下面
  { name: 'cardboard_boxes', x: -14.6, z: -26.6, yaw: 0.2, args: { seed: 27 } },
  { name: 'crate_wood', x: -12.4, z: -26.9, yaw: -0.1, args: { seed: 28 } },
  { name: 'barrel', x: -10.9, z: -26.9, yaw: 0, args: { seed: 29, color: 'green' } },
  { name: 'crate_wood', x: -14.7, z: -24.6, yaw: 0.3, args: { seed: 30 } },
  // 南门内两侧的路锥
  { name: 'traffic_cone', x: -6.6, z: -12.2, yaw: 0, args: { seed: 35 } },
  { name: 'traffic_cone', x: -0.4, z: -12.3, yaw: 0, args: { seed: 36 } },
];
