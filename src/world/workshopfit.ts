import * as THREE from 'three';
import { emissive } from '../render/surfaces';
import { hex, Kit, type LocalBox, type Mat, type V3 } from './kit';
import { WORKSHOP } from './workshop';

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

export interface WorkshopFit {
  /** 全部陈设的网格（已经按材质合并）。 */
  group: THREE.Group;
  /** 陈设的碰撞盒。 */
  boxes: LocalBox[];
  /** 乙号中继该放的位置（中继柜本身不在这里搭）。 */
  relayPos: V3;
}

// ------------------------------------------------------------------ 尺寸
const FLOOR = WORKSHOP.floor;   // 室内地坪的高度：0.03
/** 内衬波纹板朝屋里的那一面，离墙的外表面 13 厘米（墙的分层见 workshop.ts）。往墙上挂东西要贴到这个面上。 */
const LINING = 0.13;
const HALF_PI = Math.PI / 2;

// 每多用一种材质，整套陈设就多一个网格、多一次绘制调用。所以只出现一两回的质感不单独开材质，
// 而是借一种贴图相同的常用材质，把颜色乘到顶点色里。下面几个就是这样"借"来的颜色。
/** 深色木头（材质表里的 wood_dark）= 托盘木乘上这个灰褐色。 */
const DARK_WOOD = hex(0x8a786a);

/** 夹层的钢楼面。 */
const DECK = { x0: -15.73, x1: -10.25, z0: -27.73, z1: -23.75, top: 2.6 } as const;
/** 办公室：墙的外轮廓、窗台和窗顶的高度、屋顶的高度、墙厚。西、北两面直接借用车间的墙，所以只有南、东两面墙。 */
const ROOM = { x0: -15.68, x1: -10.3, z0: -27.68, z1: -23.8, sill: 3.5, head: 4.45, top: 5, wall: 0.07 } as const;

// ------------------------------------------------------------------ 小工具
type BoxOpt = NonNullable<Parameters<Kit['box']>[7]>;
type PartOpt = NonNullable<Parameters<Kit['add']>[2]>;
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

// ------------------------------------------------------------------ 组装
export function buildWorkshopFit(): WorkshopFit {
  // 全部放进同一只零件箱：同一种材质的零件（不管是办公室的还是货架的）最后合成一个网格，整套陈设只有二十来次绘制调用。
  // 用的是室内版材质（淋不到雨）。参考里货架用的是室外版，在屋里照样是湿的、照样反射天空，那是它的疏漏。
  const k = new Kit('workshopfit', 7, { interior: true });
  const boxes: LocalBox[] = [];

  buildMezzanine(k, boxes);

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