import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chamferBox, Kit, type LocalBox, type Mat, type Tint, type V3 } from './kit';

// 四号泊位维修车间 —— 建筑本体（不含里面的陈设，陈设在 workshopfit.ts）。
//
// 这是全场唯一能走进去的房子：28 × 17 米的钢结构棚子，檐口高 7 米，屋脊高 9.5 米。
// 它好看靠的不是贴图，而是"它真的是一栋棚子"：
//
//   · 墙和屋面都是有厚度、会投影的实体，所以屋里本来是黑的。
//     太阳只能从这些地方进来：南卷帘门、东推拉门、东墙掉了一块板的破口、檐下一圈百叶、
//     东山墙上的排风扇洞、屋面上被掀掉的 8 块板。清晨的太阳很低，照进来的是一条条几乎水平的长光带。
//   · 墙是三层：外皮波纹板、内衬波纹板，下面 1.2 米是水泥墙裙。两层板中间空着 12 厘米。
//   · 骨架是露明的：6 榀门式刚架（工字钢柱 + 斜梁 + 加腋）、每坡 7 根檩条、3 道墙梁、交叉拉杆。
//
// 坐标：直接用参考关卡的世界坐标，+x 是东（太阳的方向），+z 是南（堆场的方向）。
// 建筑占 x −16…12、z −28…−11；屋脊沿 x 方向走，在 z = −19.5；室内地坪比室外高 3 厘米。
// 放进我们自己的地图时，由调用方把整个 group 平移 / 旋转，这里一律不动坐标。
//
// 室内、室外两套材质：同样叫"波纹板"，屋里的那一面淋不到雨、也不该反射天空。
// 所以这里开两只零件箱，朝屋里的零件放进 inn（室内版材质），朝外的放进 out，最后把两边的网格收进同一个 group。

export interface Workshop {
  /** 建筑的全部网格。 */
  group: THREE.Group;
  /** 碰撞盒：墙很薄，门洞、破口、屋面的洞都留着。 */
  boxes: LocalBox[];
  /** 需要放真点光的位置（4 盏，在吊灯正下方）。这里只给数据，不往场景里加灯。 */
  lights: { pos: V3; color: number; intensity: number; distance: number }[];
  /** 室内范围盒：挡雨、体积雾加浓、声音切换都用它。 */
  interior: { min: V3; max: V3 };
  /** 屋面破洞在水平面上的投影：雨从这些地方漏下来。 */
  roofHoles: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  /** 每帧调用，t 是游戏开始以来的秒数。目前只有排风扇的扇叶在转。 */
  update?(t: number): void;
}

// ------------------------------------------------------------------ 尺寸
const X0 = -16, X1 = 12;            // 西墙、东墙的外表面
const Z0 = -28, Z1 = -11;           // 北墙、南墙的外表面
const EAVE = 7, RIDGE = 9.5;        // 檐口高、屋脊高
const RIDGE_Z = -19.5;              // 屋脊所在的 z
const FLOOR = 0.03;                 // 室内地坪的高度
const WALL_T = 0.25;                // 墙的总厚度（墙裙的厚度）
const SKIRT_H = 1.2;                // 水泥墙裙的高度
const HALF_SPAN = (Z1 - Z0) / 2;    // 半跨 8.5 米：从檐口到屋脊的水平距离
const RISE = RIDGE - EAVE;          // 矢高 2.5 米：屋脊比檐口高多少
const PITCH = Math.atan2(RISE, HALF_SPAN);      // 坡角，约 16.4°
const SLOPE_LEN = Math.hypot(HALF_SPAN, RISE);  // 顺着坡面量，从檐口到屋脊 8.86 米
const COS = Math.cos(PITCH), SIN = Math.sin(PITCH);
/** z 处的屋面高度。 */
const roofY = (z: number) => EAVE + RISE * (1 - Math.abs(z - RIDGE_Z) / HALF_SPAN);

/** 开间线：6 榀刚架把 28 米的长边分成 5 个开间。 */
const BAYS = [-16, -11.1, -6.2, -0.8, 5.6, 12];
const SOUTH_DOOR = { x0: -6, x1: -1, h: 5 };          // 南卷帘门洞：开在 z = −11 的墙上
const EAST_DOOR = { z0: -22, z1: -17, h: 4.5 };       // 东推拉门洞：开在 x = 12 的墙上
const BREACH = { z0: -15.55, z1: -13.35, y0: 3.3, y1: 5.4 };  // 东墙掉了一块板的破口
const LOUVRE_Y0 = 5.45, LOUVRE_Y1 = 6.8;              // 百叶带的下沿、上沿
const FAN = { y: 8.02, r: 0.56, speed: 1.7 };         // 排风扇洞的圆心高度、半径，扇叶转速（弧度每秒，约每分钟 16 转）

// 屋面板：沿屋脊方向分 20 列（两头各挑出山墙 0.3 米），每坡顺着坡分 4 排。
const ROOF_X0 = X0 - 0.3, ROOF_COLS = 20, COL_W = (X1 - X0 + 0.6) / ROOF_COLS;   // 每列 1.43 米
/** 每排板在坡面上的起止位置：0 是檐口，1 是屋脊。第一排从 −0.04 开始，多出来的那一截是挑檐。 */
const ROOF_ROWS = [-0.04, 0.25, 0.5, 0.75, 1];
/** 被掀掉的 8 块板：[哪一坡（S 朝南 / N 朝北）, 第几排, 第几列]。 */
const ROOF_HOLES: ['S' | 'N', number, number][] = [['S', 1, 4], ['S', 2, 5], ['S', 1, 11], ['S', 2, 15], ['S', 3, 8], ['N', 2, 7], ['N', 1, 13], ['N', 3, 17]];

/** 主要尺寸，给摆陈设、布置出生点、铺寻路网格的代码用。 */
export const WORKSHOP = {
  x0: X0, x1: X1, z0: Z0, z1: Z1, eave: EAVE, ridge: RIDGE, ridgeZ: RIDGE_Z, floor: FLOOR,
  southDoor: SOUTH_DOOR, eastDoor: EAST_DOOR, breach: BREACH,
} as const;

type Axis = 'x' | 'y' | 'z';
/** 搭的过程中到处要用的三样东西：室外零件箱、室内零件箱、碰撞盒清单。 */
interface Ctx { out: Kit; inn: Kit; boxes: LocalBox[] }

// ------------------------------------------------------------------ 小工具
/** 0…1 的伪随机数，同一个 n 永远得到同一个值。用来给每张板定一个固定的深浅。 */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 一个直角盒子的几何体：lo、hi 是两个对角点 [x, y, z]。
 * 顶点坐标直接取传进来的数，不走"中心 ± 半宽"。两块并排的板共用的那条边，两边算出来的坐标就一位不差；
 * 只要差上百万分之一米，显卡画这条缝的时候就可能漏掉几个像素。
 * omit 里写上不要的面（'x-' 是朝 −x 的那一面，'x+' 朝 +x，以此类推），可以写多个。
 */
function boxGeo(lo: number[], hi: number[], omit = '') {
  const pos: number[] = [], nor: number[] = [];
  for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
    if (omit.includes('xyz'[a] + (s > 0 ? '+' : '-'))) continue;
    const b = (a + 1) % 3, c = (a + 2) % 3;
    // 这一面的四个角：a 轴上的坐标固定，另外两个轴各取小 / 大
    const corner = (ub: number, uc: number) => { const v = [0, 0, 0]; v[a] = s > 0 ? hi[a] : lo[a]; v[b] = ub ? hi[b] : lo[b]; v[c] = uc ? hi[c] : lo[c]; return v; };
    const q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    // 两个三角形；朝负方向的面要把顶点顺序反过来，正面才朝外
    for (const i of s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) { pos.push(q[i][0], q[i][1], q[i][2]); nor.push(a === 0 ? s : 0, a === 1 ? s : 0, a === 2 ? s : 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * 按两个对角点放一个盒子。
 * 和 Kit.box 的区别：几何体直接建在最终的位置上，于是零件箱给它铺的贴图坐标就是"建筑里的米数"。
 * 大面积的墙板、屋面板用它，相邻两块板上的波纹、搭接缝才能对得上，不会各铺各的。
 * c 是倒角宽度，不给就是直角盒；omit 见 boxGeo。
 */
function slab(k: Kit, mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: { c?: number; tint?: Tint; omit?: string } = {}) {
  const lo = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], hi = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
  let g: THREE.BufferGeometry;
  if (o.c) {
    g = chamferBox(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], o.c);
    g.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  } else g = boxGeo(lo, hi, o.omit);
  k.add(mat, g, { tint: o.tint });
}

/**
 * 贴在坡屋面上的一块东西（屋面板、檩条）。
 *   xa、xb  沿屋脊方向从哪到哪；
 *   sy      厚度；sz 顺着坡的长度；
 *   t       在坡面上的位置：0 是檐口，1 是屋脊；
 *   lift    沿屋面法线抬起多少（正的朝天，负的朝屋里）；
 *   side    +1 是南坡，−1 是北坡。
 * 先建一个躺平的盒子，绕 x 轴转到坡面的角度，再挪到位。绕 x 轴转不会动 x 坐标，所以 xa、xb 仍然原样落在顶点上。
 */
function onSlope(k: Kit, mat: Mat, xa: number, xb: number, sy: number, sz: number, t: number, lift: number, side: number, o: { tint?: Tint; omit?: string } = {}) {
  const g = boxGeo([xa, -sy / 2, -sz / 2], [xb, sy / 2, sz / 2], o.omit);
  g.rotateX(side * PITCH);
  g.translate(0, EAVE + RISE * t + COS * lift, RIDGE_Z + side * (HALF_SPAN * (1 - t) + SIN * lift));
  k.add(mat, g, { tint: o.tint });
}

/**
 * 一张真的有起伏的波纹板（只给掉下来的、挂着的散板用）。
 * 墙和屋面上的大板是平的盒子，波纹靠贴图的法线表现 —— 76 毫米一道的细波纹如果做成真的几何体，
 * 28 米长的墙远看每道波不到一个像素，会闪成一片；法线贴图在远处会自动糊成平的，就没有这个问题。
 * 但散板就在眼前，边缘是一条波浪线才像铁皮，所以这两张做成真的。
 *
 * 板躺在 xz 平面里，法线朝 +y，波纹的棱沿 z 走；waves 是波的个数（每道 76.2 毫米，和贴图里的波对齐）。
 * warp 可以把板再捏一下（翘角、扭曲）。板是没有厚度的薄壳，所以正反两面各做一层面片。
 */
function looseSheet(waves: number, length: number, warp?: (p: THREE.Vector3) => void) {
  const WAVE = 0.0762, AMP = 0.009;   // 波距 76.2 毫米，波峰到波谷 18 毫米
  const top = new THREE.PlaneGeometry(waves * WAVE, length, waves * 4, warp ? 6 : 1);   // 每道波 4 段：峰、腰、谷、腰
  top.rotateX(-Math.PI / 2);
  const p = top.getAttribute('position'), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.y = AMP * Math.cos((v.x / WAVE) * Math.PI * 2);
    warp?.(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  top.computeVertexNormals();
  // 背面：同样的顶点，三角形的绕向反过来、法线取反，并沿法线退 2 毫米，免得和正面叠在一起
  const back = top.clone(), bp = back.getAttribute('position'), bn = back.getAttribute('normal'), idx = back.getIndex()!;
  for (let i = 0; i < bp.count; i++) {
    bp.setXYZ(i, bp.getX(i) - bn.getX(i) * 0.002, bp.getY(i) - bn.getY(i) * 0.002, bp.getZ(i) - bn.getZ(i) * 0.002);
    bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
  }
  for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
  return mergeGeometries([top, back]);
}

// ------------------------------------------------------------------ 墙
// 一面墙从外到里是这样的（face 是墙的"外表面"坐标，朝外为正）：
//
//      +6 cm ┐ 外皮波纹板，厚 4 厘米（室外版材质）
//      +2 cm ┘
//       0    ┐ 墙裙外半层：水泥（室外版），只到 1.2 米高
//   −12.5 cm ┤ 墙裙内半层：刷了灰漆的水泥（室内版）
//     −25 cm ┘
//     −10 cm ┐ 内衬波纹板，厚 3 厘米（室内版），从墙裙顶上开始
//     −13 cm ┘
//
// 墙裙比上面的板厚，所以屋里 1.2 米高的地方有一道 12 厘米宽的台阶；墙梁就贴在内衬朝屋里的一面。

/** 沿墙方向 s0…s1、厚度方向 n0…n1、高度 y0…y1 的一个盒子。along 是墙的走向：'x' 是南北墙，'z' 是东西墙。 */
function span(k: Kit, mat: Mat, along: 'x' | 'z', s0: number, s1: number, n0: number, n1: number, y0: number, y1: number, o?: { c?: number; tint?: Tint; omit?: string }) {
  if (along === 'x') slab(k, mat, s0, y0, n0, s1, y1, n1, o);
  else slab(k, mat, n0, y0, s0, n1, y1, s1, o);
}

/**
 * 一段水泥墙裙：外半层、内半层各一个带倒角的盒子。
 * trim0 / trim1：这一段的头 / 尾是不是顶到了建筑的转角。是的话内半层要缩回半个墙厚 ——
 * 不然它的端面会和另一面墙的外表面落在同一个平面上，两种材质抢同一块像素，画面上就是一片闪烁的条纹（z-fighting）。
 */
function skirt(c: Ctx, along: 'x' | 'z', face: number, out: number, s0: number, s1: number, trim0 = false, trim1 = false) {
  const mid = face - (out * WALL_T) / 2, back = face - out * WALL_T, half = WALL_T / 2;
  // 每段两头各多伸 1 毫米，和邻段咬在一起。两段的倒角在接缝处交成一道 V 形的浅槽，正好像浇筑时留的施工缝
  const a = s0 - 0.001, b = s1 + 0.001;
  span(c.out, 'concrete', along, a, b, face, mid, FLOOR - 0.2, SKIRT_H, { c: 0.015 });
  span(c.inn, 'concrete_painted', along, trim0 ? s0 + half : a, trim1 ? s1 - half : b, mid, back, FLOOR - 0.2, SKIRT_H, { c: 0.015 });
}

const SHEET_W = 0.762;   // 一张波纹板的宽度：正好是贴图的一格，里面有 10 道波
const BITE = 0.0015;     // 两个零件相接的地方互相咬进去这么多，免得接缝漏像素
/** 每张板自己的深浅。大多数只差几个百分点；偶尔一张锈得发褐，偶尔一张是后来换的新板，比别的亮。 */
function sheetTint(key: number, index: number): Tint {
  const v = 0.9 + 0.12 * hash(key * 53.3 + index), odd = hash(key * 17.7 + index * 3.1 + 0.5);
  if (odd > 0.93) return [v * 0.88, v * 0.78, v * 0.7];
  if (odd < 0.05) return v * 1.1;
  return v;
}

/**
 * 一段波纹板墙面：外皮 + 内衬，沿墙的方向按板宽切成一张张的，每张的深浅略有不同。
 *   lap   外皮往下多搭出来的一截（盖住墙裙顶、门楣的边）；
 *   open  这一段的哪一头是紧挨着别的东西的（'-' 是起点那头，'+' 是终点那头，可以都写）。
 *         紧挨着的那一头不做端面：夹在两个零件之间的面谁也看不见，可它的边正好落在墙的表面上，
 *         和表面的深度一模一样，画出来会在接缝上闪出一串杂点。同一段里板和板之间的端面也是这个道理，一律不做。
 * 同一面墙、同一个位置的板永远是同一个深浅（由 key 和第几张决定），所以上下两段墙板看起来是同一张板接下来的。
 * 每段的下沿都比给的 y0 再低 1.5 毫米，咬进下面那一段里：上下两段切板的位置不一定一样，光靠"边对边"会漏像素。
 */
function cladding(c: Ctx, along: 'x' | 'z', face: number, out: number, s0: number, s1: number, y0: number, y1: number, o: { lap?: number; open?: string } = {}) {
  if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return;
  const key = along === 'x' ? (out > 0 ? 1 : 2) : out > 0 ? 3 : 4, open = o.open ?? '';
  const first = Math.floor(s0 / SHEET_W + 1e-6), last = Math.ceil(s1 / SHEET_W - 1e-6);
  for (let i = first; i < last; i++) {
    const a = Math.max(s0, i * SHEET_W), b = Math.min(s1, (i + 1) * SHEET_W);
    const omit = (i > first || open.includes('-') ? along + '-' : '') + (i < last - 1 || open.includes('+') ? along + '+' : '');
    span(c.out, 'corrugated_roof', along, a, b, face + out * 0.02, face + out * 0.06, y0 - Math.max(o.lap ?? 0, BITE), y1, { tint: sheetTint(key, i), omit });
    span(c.inn, 'corrugated_roof', along, a, b, face - out * 0.13, face - out * 0.1, y0 - BITE, y1, { tint: sheetTint(key + 10, i), omit });
  }
}

/**
 * 一樘百叶：3 片外沿朝下斜的叶片、3 根竖框、上下两道横框。
 * 叶片隔 0.6 米一片、只有 0.26 米深，基本是敞开的 —— 它的用处就是让低角度的太阳一条一条地照进来。
 * tilt 是叶片的倾角（弧度）。
 */
function louvre(c: Ctx, along: 'x' | 'z', face: number, out: number, s0: number, s1: number, tilt: number) {
  const k = c.out, y0 = LOUVRE_Y0, y1 = LOUVRE_Y1, mid = (s0 + s1) / 2;
  const gaps = Math.max(1, Math.floor((y1 - y0 - 0.1) / 0.45));
  for (let i = 0; i <= gaps; i++) {
    const y = y0 + 0.08 + ((y1 - y0 - 0.16) * i) / gaps;
    if (along === 'x') k.box('steel_galv', s1 - s0, 0.018, 0.26, mid, y, face - out * 0.06, { rot: [out * tilt, 0, 0], plain: true, tint: 0.92 });
    else k.box('steel_galv', 0.26, 0.018, s1 - s0, face - out * 0.06, y, mid, { rot: [0, 0, -out * tilt], plain: true, tint: 0.92 });
  }
  for (const s of [s0 + 0.03, s1 - 0.03, mid]) span(k, 'steel_galv', along, s - 0.03, s + 0.03, face - out * 0.2, face + out * 0.06, y0 - BITE, y1 + BITE);
  span(k, 'steel_galv', along, s0, s1, face - out * 0.2, face + out * 0.07, y0 - 0.05, y0);
  span(k, 'steel_galv', along, s0, s1, face - out * 0.2, face + out * 0.07, y1, y1 + 0.05);
}

/**
 * 山墙：檐口以上的那个三角形，也是外皮、内衬两层。东山墙上要挖一个装排风扇的圆洞。
 * 做法是在纸上画出三角形（带洞），再拉出厚度。画的时候横坐标用的是 −z，
 * 这样把它绕竖轴转 90° 立起来以后，正好落回原来的 z 上。
 */
function gable(c: Ctx, face: number, out: number, fanHole: boolean) {
  // 三角形的斜边比理论屋面线低一点点（檐口处低 2 厘米），顶进屋面内衬里，接缝就不漏光；
  // 底边从檐口高度起，不和下面的墙板重叠。
  const slope = (RIDGE - (EAVE - 0.02)) / (HALF_SPAN + 0.05), half = (RIDGE - EAVE) / slope;
  const make = (k: Kit, thick: number, x: number) => {
    const tri = new THREE.Shape();
    tri.moveTo(-RIDGE_Z - half, EAVE - BITE); tri.lineTo(-RIDGE_Z, RIDGE); tri.lineTo(-RIDGE_Z + half, EAVE - BITE); tri.closePath();
    if (fanHole) { const hole = new THREE.Path(); hole.absarc(-RIDGE_Z, FAN.y, FAN.r, 0, Math.PI * 2, true); tri.holes.push(hole); }
    const g = new THREE.ExtrudeGeometry(tri, { depth: thick, bevelEnabled: false, curveSegments: 14 });
    g.rotateY(Math.PI / 2);
    g.translate(x, 0, 0);
    k.add('corrugated_roof', g, { tint: 0.96 });
  };
  make(c.out, 0.04, face + (out > 0 ? 0.02 : -0.06));
  make(c.inn, 0.03, face + (out > 0 ? -0.13 : 0.1));
}

function buildWalls(c: Ctx) {
  const { out, inn } = c, bandLo = LOUVRE_Y0 - 0.05, bandHi = LOUVRE_Y1 + 0.05;   // 百叶带连框占 5.4…6.85 米
  // 门洞两边的墙都往门框里多缩 1 厘米：门框立柱的侧面本来和墙的端面在同一个平面上，会闪。
  const TUCK = 0.01;

  // 墙板一律按"横带"来铺：同一条带子里能连成一长段的就连成一长段，段和段只在门洞、百叶这些真的断开的地方分开。
  const LAP = { lap: 0.03 };

  // ---- 南墙（朝堆场）：5 个开间，中间那个开间是卷帘门，其余 4 个的檐下是百叶
  const d0 = SOUTH_DOOR.x0 - TUCK, d1 = SOUTH_DOOR.x1 + TUCK;
  for (let i = 0; i + 1 < BAYS.length; i++) {
    if (i === 2) { skirt(c, 'x', Z1, 1, BAYS[i], d0); skirt(c, 'x', Z1, 1, d1, BAYS[i + 1]); }   // 门洞所在的开间：墙裙只剩门两边各一小段
    else skirt(c, 'x', Z1, 1, BAYS[i], BAYS[i + 1], i === 0, i === BAYS.length - 2);
  }
  cladding(c, 'x', Z1, 1, X0, d0, SKIRT_H, bandLo, { lap: 0.03, open: '+' });               // 墙裙顶 → 百叶带下沿，门洞西边
  cladding(c, 'x', Z1, 1, d1, X1, SKIRT_H, bandLo, { lap: 0.03, open: '-' });               // 同上，门洞东边
  cladding(c, 'x', Z1, 1, d0, d1, SOUTH_DOOR.h + 0.01, bandLo, { lap: 0.03, open: '-+' });  // 门洞上方
  cladding(c, 'x', Z1, 1, X0, X1, bandHi, EAVE);                                            // 檐下一条
  // 百叶带这一层：每个开间里一樘百叶，两头离开间线各留 15 厘米。
  // 参考里这 15 厘米是空的，只靠后面的柱子半挡着，会漏出几厘米宽的光缝；这里补上板。门洞所在的开间没有百叶，整段是板。
  for (const i of [0, 1, 3, 4]) louvre(c, 'x', Z1, 1, BAYS[i] + 0.15, BAYS[i + 1] - 0.15, 0.25);
  const E = 0.15 + BITE;   // 补的板往百叶框里咬进一点
  cladding(c, 'x', Z1, 1, X0, X0 + E, bandLo, bandHi, { open: '+' });
  cladding(c, 'x', Z1, 1, BAYS[1] - E, BAYS[1] + E, bandLo, bandHi, { open: '-+' });
  cladding(c, 'x', Z1, 1, BAYS[2] - E, BAYS[3] + E, bandLo, bandHi, { open: '-+' });
  cladding(c, 'x', Z1, 1, BAYS[4] - E, BAYS[4] + E, bandLo, bandHi, { open: '-+' });
  cladding(c, 'x', Z1, 1, X1 - E, X1, bandLo, bandHi, { open: '-' });

  // ---- 北墙：整面实墙，上面有一扇人行门（只是个样子，打不开）
  for (let i = 0; i + 1 < BAYS.length; i++) skirt(c, 'x', Z0, -1, BAYS[i], BAYS[i + 1], i === 0, i === BAYS.length - 2);
  cladding(c, 'x', Z0, -1, X0, X1, SKIRT_H, EAVE, LAP);
  slab(inn, 'paint_grey', 6.2, FLOOR, Z0 + WALL_T, 7.2, 2.1, Z0 + WALL_T + 0.04, { tint: 0.8 });
  slab(out, 'paint_grey', 6.2, 0, Z0 - 0.09, 7.2, 2.1, Z0 - 0.05, { tint: 0.8 });
  // 门框和把手：参考里只有一块色板，加上这几根才看得出是一扇门
  for (const [k, z0, z1, handleZ] of [[inn, Z0 + WALL_T, Z0 + WALL_T + 0.06, Z0 + WALL_T + 0.08], [out, Z0 - 0.11, Z0, Z0 - 0.13]] as [Kit, number, number, number][]) {
    for (const x of [6.16, 7.24]) slab(k, 'steel_galv', x - 0.04, 0, z0, x + 0.04, 2.18, z1, { tint: 0.7 });
    slab(k, 'steel_galv', 6.12, 2.1, z0, 7.28, 2.18, z1, { tint: 0.7 });
    k.box('steel_galv', 0.03, 0.14, 0.03, 7.08, 1.05, handleZ, { tint: 0.6 });
  }

  // ---- 西墙：整面实墙 + 实心的山墙
  const westJoints = [Z0, -22.3, -16.7, Z1];   // 墙裙在抗风柱的位置分缝
  for (let i = 0; i < 3; i++) skirt(c, 'z', X0, -1, westJoints[i], westJoints[i + 1], i === 0, i === 2);
  cladding(c, 'z', X0, -1, Z0, Z1, SKIRT_H, EAVE, LAP);
  gable(c, X0, -1, false);

  // ---- 东墙（朝太阳）：推拉门洞、破口、三樘百叶、带排风扇洞的山墙
  const e0 = EAST_DOOR.z0 - TUCK, e1 = EAST_DOOR.z1 + TUCK;
  skirt(c, 'z', X1, 1, Z0, e0, true, false);
  skirt(c, 'z', X1, 1, e1, BREACH.z0);
  skirt(c, 'z', X1, 1, BREACH.z0, BREACH.z1);
  skirt(c, 'z', X1, 1, BREACH.z1, Z1, false, true);
  cladding(c, 'z', X1, 1, Z0, e0, SKIRT_H, bandLo, { lap: 0.03, open: '+' });                       // 门洞北边
  cladding(c, 'z', X1, 1, e1, Z1, SKIRT_H, BREACH.y0, { lap: 0.03, open: '-' });                    // 门洞南边，到破口下沿的高度为止
  cladding(c, 'z', X1, 1, e1, BREACH.z0, BREACH.y0, bandLo, { open: '-' });                         // 破口两边剩下的墙。朝破口的那一头留着端面：那是板被撕开的茬口
  cladding(c, 'z', X1, 1, BREACH.z1, Z1, BREACH.y0, bandLo);
  cladding(c, 'z', X1, 1, e0, e1, EAST_DOOR.h + 0.01, bandLo, { lap: 0.03, open: '-+' });           // 门洞上方
  cladding(c, 'z', X1, 1, Z0, Z1, bandHi, EAVE);                                                    // 檐下一条
  for (const [a, b] of [[Z0 + 0.3, -22.45], [-22.15, -16.85], [-16.55, Z1 - 0.3]]) louvre(c, 'z', X1, 1, a, b, 0.5);
  // 三樘百叶之间、两头的空当同样补上板
  cladding(c, 'z', X1, 1, Z0, Z0 + 0.3 + BITE, bandLo, bandHi, { open: '+' });
  cladding(c, 'z', X1, 1, -22.45 - BITE, -22.15 + BITE, bandLo, bandHi, { open: '-+' });
  cladding(c, 'z', X1, 1, -16.85 - BITE, -16.55 + BITE, bandLo, bandHi, { open: '-+' });
  cladding(c, 'z', X1, 1, Z1 - 0.3 - BITE, Z1, bandLo, bandHi, { open: '-' });
  gable(c, X1, 1, true);

  // ---- 破口：板掉了以后露出来的两根竖龙骨，一块还挂在墙上的板，一块掉在地上的板
  for (const z of [BREACH.z0, BREACH.z1]) slab(inn, 'steel_galv', X1 - 0.16, BREACH.y0, z - 0.03, X1 - 0.09, bandLo, z + 0.03);
  const place = (pos: V3, rot: V3, pre?: THREE.Matrix4) => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));
    return pre ? m.multiply(pre) : m;
  };
  // 挂着的那块：先把躺平的板立起来（法线朝东、波纹竖着走），再按它斜吊着的姿态摆上去；板被扯得有点扭
  const upright = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
  out.add('corrugated_roof', looseSheet(14, 1.5, (p) => { p.y += 0.25 * p.x * p.z; }), { tint: [0.8, 0.74, 0.68] }, place([X1 + 0.2, BREACH.y0 - 0.55, BREACH.z0 + 0.5], [0.25, 0.1, -0.22], upright));
  // 掉在地上的那块：一个角摔得翘了起来
  out.add('corrugated_roof', looseSheet(13, 2, (p) => { const lift = Math.max(0, p.x / 0.99 + p.z / 2 - 0.35); p.y += 0.33 * lift * lift; }), { tint: [0.84, 0.76, 0.68] }, place([X1 + 1.3, 0.05, BREACH.z0 + 1.6], [0.02, 0.5, 0.03]));

  // ---- 四个墙角的包角板。两面墙的外皮在转角处并不相接，会留下一道 6 厘米见方的豁口，用一根方条盖住
  for (const x of [X0, X1]) for (const z of [Z0, Z1]) {
    const ox = x === X0 ? -1 : 1, oz = z === Z0 ? -1 : 1;
    slab(out, 'steel_galv', x - ox * 0.03, SKIRT_H - 0.03, z - oz * 0.03, x + ox * 0.075, EAVE, z + oz * 0.075, { tint: 0.85 });
  }
}

// ------------------------------------------------------------------ 屋面
function buildRoof(c: Ctx): Workshop['roofHoles'] {
  const { out, inn, boxes } = c, roofHoles: Workshop['roofHoles'] = [];
  const isHole = (slope: string, row: number, col: number) => ROOF_HOLES.some((h) => h[0] === slope && h[1] === row && h[2] === col);

  for (const side of [1, -1]) {
    const slope = side > 0 ? 'S' : 'N';
    for (let row = 0; row < 4; row++) {
      const t0 = ROOF_ROWS[row], t1 = ROOF_ROWS[row + 1], mid = (t0 + t1) / 2, len = (t1 - t0) * SLOPE_LEN;
      const zA = RIDGE_Z + side * HALF_SPAN * (1 - t0), zB = RIDGE_Z + side * HALF_SPAN * (1 - t1);   // 这一排在地面上的投影：靠檐口的边、靠屋脊的边
      let runStart = -1;
      for (let col = 0; col <= ROOF_COLS; col++) {
        const open = col === ROOF_COLS || isHole(slope, row, col), x0 = ROOF_X0 + col * COL_W, x1 = ROOF_X0 + (col + 1) * COL_W;
        if (!open) {
          // 一块板 = 朝天的外皮 + 朝屋里的内衬。越靠屋脊的一排抬得越高一点（每排 4 毫米）、并且比理论长度长 2 厘米：
          // 上一排压在下一排上面，像真的搭接；两排的面也就不会叠在同一个平面上闪。
          const lap = 0.004 * row, n = (side > 0 ? 100 : 200) + row * ROOF_COLS + col;
          // 和墙板一样：左右紧挨着别的板的那个端面不要
          const omit = (col > 0 && !isHole(slope, row, col - 1) ? 'x-' : '') + (col < ROOF_COLS - 1 && !isHole(slope, row, col + 1) ? 'x+' : '');
          onSlope(out, 'corrugated_roof', x0, x1, 0.04, len + 0.02, mid, 0.03 + lap, side, { tint: sheetTint(5, n), omit });
          onSlope(inn, 'corrugated_roof', x0, x1, 0.02, len + 0.02, mid, -0.02 + lap, side, { tint: sheetTint(6, n), omit });
          if (runStart < 0) runStart = col;
          continue;
        }
        if (runStart >= 0) {
          // 一段连着的板合用一个碰撞盒。碰撞盒只能是横平竖直的，所以斜屋面在碰撞上是 4 级台阶。
          // noNav：它在头顶上，不该挡住地面上的寻路。
          boxes.push({ min: [ROOF_X0 + runStart * COL_W, EAVE + RISE * Math.max(0, t0) - 0.05, Math.min(zA, zB)], max: [x0, EAVE + RISE * t1 + 0.08, Math.max(zA, zB)], surface: 'metal', noNav: true });
          runStart = -1;
        }
        if (col < ROOF_COLS) {
          roofHoles.push({ minX: x0, maxX: x1, minZ: Math.min(zA, zB), maxZ: Math.max(zA, zB) });
          // 板被掀掉以后，洞的两条顺坡的边上各露出一根镀锌方条（檩托）
          for (const x of [x0 + 0.02, x1 - 0.02]) onSlope(inn, 'steel_galv', x - 0.025, x + 0.025, 0.05, len, mid, -0.06, side);
        }
      }
    }

    // 檩条：横在刚架上、托着屋面板的 7 根长条。它们是整根通长的，所以从屋面的破洞里能看见檩条横在天上
    for (const t of [0.03, 0.2, 0.37, 0.54, 0.71, 0.88, 0.985]) onSlope(inn, 'steel_galv', X0 + 0.15, X1 - 0.15, 0.17, 0.06, t, -0.13, side, { tint: 0.9 });

    // 天沟：檐口外面一条接水的槽
    const gutterZ = RIDGE_Z + side * (HALF_SPAN + 0.38);
    slab(out, 'steel_galv', ROOF_X0, EAVE - 0.22, gutterZ, X1 + 0.3, EAVE - 0.08, gutterZ + side * 0.16, { tint: 0.85 });
    slab(out, 'steel_galv', ROOF_X0, EAVE - 0.22, gutterZ - side * 0.05, X1 + 0.3, EAVE - 0.19, gutterZ + side * 0.21, { tint: 0.85 });
    // 落水管：每榀刚架的位置一根；南坡要跳过卷帘门两边的那两榀
    const pipeZ = RIDGE_Z + side * (HALF_SPAN + 0.13);
    for (let i = 0; i < BAYS.length; i++) {
      if (side > 0 && (i === 2 || i === 3)) continue;
      const x = clamp(BAYS[i], X0 + 0.5, X1 - 0.5) + 0.42;
      out.cyl('steel_galv', 0.055, EAVE - 0.4, x, (EAVE - 0.4) / 2 + 0.2, pipeZ, { seg: 8 });
      out.tube('steel_galv', [x, EAVE - 0.2, pipeZ], [x, EAVE - 0.12, gutterZ + side * 0.08], 0.05, { seg: 8 });   // 顶上接到天沟的一段斜管
      for (const y of [1.6, 3.6, 5.6]) out.box('steel_galv', 0.16, 0.04, 0.14, x, y, pipeZ - side * 0.02, { plain: true, tint: 0.8 });   // 管卡
      out.tube('steel_galv', [x, 0.2, pipeZ], [x + 0.02, 0.06, pipeZ + side * 0.22], 0.055, { seg: 8, cap: true });   // 底下朝外踢出去的弯头
    }
    // 山墙封檐板：盖住屋面板在山墙外的端头
    for (const x of [X0 - 0.31, X1 + 0.31]) out.box('steel_galv', 0.04, 0.22, SLOPE_LEN + 0.4, x, (EAVE + RIDGE) / 2 - 0.05, RIDGE_Z + side * (HALF_SPAN / 2 + 0.1), { rot: [side * PITCH, 0, 0], plain: true, tint: 0.85 });
    // 屋脊盖板：两片，各随本坡的角度
    out.box('steel_galv', X1 - X0 + 0.7, 0.03, 0.34, (X0 + X1) / 2, RIDGE + 0.03, RIDGE_Z + side * 0.15, { rot: [side * PITCH, 0, 0], plain: true, tint: 0.85 });
  }
  return roofHoles;
}

// ------------------------------------------------------------------ 墙的碰撞盒
/**
 * 碰撞盒和看得见的网格是两套东西，各管各的。墙在碰撞上就是几块薄板：
 *   · 两个门洞、东墙的破口留空 —— 人能走，子弹和视线能穿；
 *   · 百叶带和排风扇洞在碰撞上是实的 —— 透光，但子弹打不过去；
 *   · 东、西墙的盒子一直到屋脊高度，把山墙也算进去了。
 */
function wallColliders(boxes: LocalBox[]) {
  const metal = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], surface: 'metal' });
  const s0 = Z1 - WALL_T, s1 = Z1 + 0.06, e0 = X1 - WALL_T, e1 = X1 + 0.06;
  boxes.push({ min: [X0, -0.5, Z0], max: [X1, FLOOR, Z1], surface: 'concrete' });                    // 地坪：脚步声、弹孔按水泥算
  metal(X0, 0, s0, SOUTH_DOOR.x0, EAVE, s1);                                                         // 南墙，门洞西边
  metal(SOUTH_DOOR.x1, 0, s0, X1, EAVE, s1);                                                         // 南墙，门洞东边
  metal(SOUTH_DOOR.x0, SOUTH_DOOR.h - 0.5, Z1 - 0.6, SOUTH_DOOR.x1, EAVE, s1);                       // 门洞上方：连卷起来的门帘一起，从 4.5 米开始
  metal(X0, 0, Z0 - 0.06, X1, EAVE, Z0 + WALL_T);                                                    // 北墙
  metal(X0 - 0.06, 0, Z0, X0 + WALL_T, RIDGE, Z1);                                                   // 西墙
  metal(e0, 0, Z0, e1, RIDGE, EAST_DOOR.z0);                                                         // 东墙，门洞北边
  metal(e0, 0, EAST_DOOR.z1, e1, RIDGE, BREACH.z0);                                                  // 东墙，门洞和破口之间
  metal(e0, 0, BREACH.z1, e1, RIDGE, Z1);                                                            // 东墙，破口南边
  metal(e0, 0, BREACH.z0, e1, BREACH.y0, BREACH.z1);                                                 // 破口下面
  metal(e0, BREACH.y1, BREACH.z0, e1, RIDGE, BREACH.z1);                                             // 破口上面
  metal(e0, EAST_DOOR.h, EAST_DOOR.z0, e1, RIDGE, EAST_DOOR.z1);                                     // 东门上方
}

// ------------------------------------------------------------------ 组装
export function buildWorkshop(): Workshop {
  const out = new Kit('workshop', 4);
  const inn = new Kit('workshop-in', 4, { interior: true });
  const boxes: LocalBox[] = [];
  const c: Ctx = { out, inn, boxes };

  // 地坪：一整块环氧地坪，比室外高 3 厘米。单独用一只不烤脏的零件箱 ——
  // 烤脏会把贴地的面压暗，而地坪整个就在地上，会被整片压暗四分之一。
  // 四边比墙的外表面各缩 1 厘米：不然地坪的侧面会和墙裙的外表面叠在同一个平面上闪。
  const floor = new Kit('workshop-floor', 4, { interior: true });
  slab(floor, 'floor_epoxy', X0 + 0.01, -0.25, Z0 + 0.01, X1 - 0.01, FLOOR, Z1 - 0.01);
  // 两个门口的水泥坡板：把 3 厘米的高差接到室外地面上
  slab(out, 'concrete', SOUTH_DOOR.x0 - 0.4, -0.2, Z1 - 0.01, SOUTH_DOOR.x1 + 0.4, 0.02, Z1 + 1.4);
  slab(out, 'concrete', X1 - 0.01, -0.2, EAST_DOOR.z0 - 0.4, X1 + 1.4, 0.02, EAST_DOOR.z1 + 0.4);

  wallColliders(boxes);
  buildWalls(c);
  const roofHoles = buildRoof(c);

  // 三只零件箱各自把同材质的零件合并成一个网格，再一起收进同一个 group
  const group = new THREE.Group();
  group.name = 'workshop';
  for (const part of [floor.finish({ boxes: [], grime: 0 }), out.finish({ boxes: [] }), inn.finish({ boxes: [], grime: 0.8 })])
    for (const mesh of [...part.group.children]) group.add(mesh);

  return {
    group, boxes, roofHoles,
    lights: [],   // 吊灯还没装
    interior: { min: [X0, 0, Z0], max: [X1, RIDGE, Z1] },
  };
}

