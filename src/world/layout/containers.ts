import { clamp } from '../../core/math';
import { CONTAINER_COLORS, CONTAINER_SIZES, CONTAINER_WIDTH, type ContainerSize } from '../container';
import type { ContainerField, StackItem } from '../containerfield';
import { reeferUnit } from '../props/site';
import type { Stage } from './stage';

// 全场的集装箱放在哪：堆场里的四五百只、路上和码头上零散的十几只、货轮甲板上的两三百只。
//
// 这个文件只管"哪里放什么箱子"。一只箱子长什么样在 container.ts；几百只怎么画得动、碰撞盒怎么登记，在 containerfield.ts。
//
// 堆场的骨架和地面上喷的黄框是一一对应的（ground.ts）：堆位 6 列 × 5 排；每个堆位里并排 3 行、南北各一个"箱位"；
// 一个箱位正好放下一只 40 尺箱，或者头尾相接的两只 20 尺箱。箱子的长边都是南北向。
// 因为每一摞都落在自己的箱位里，堆位之间的通道（见 road.ts 开头的说明）永远是通的，别的清单里贴着箱子摆的道具也不用跟着挪。
//
// 堆的时候照着真码头的样子，守这么几条规矩：
//   · 一家船公司的箱子只有一两种颜色，而且常常成片地放在一起 —— 每半个堆位有一家"主顾"，七成的箱子是它的；
//   · 高低错落：相邻两摞尽量不一样高，偶尔空一个箱位；
//   · 20 尺箱、40 尺箱、高箱混着来：两只 20 尺箱顶一只 40 尺箱的位置，上面还可以再横跨一只 40 尺箱；
//   · 每一层都错开几厘米、歪一两度（ContainerField.stack 自己会做）；新旧程度每只不同。

const H = Math.PI / 2;
/** 想让箱门朝哪边，箱子就转多少。ContainerField 的约定：不转的时候长边沿东西向，箱门朝东。 */
const DOOR = { east: 0, north: H, west: Math.PI, south: -H } as const;

type ColorName = keyof typeof CONTAINER_COLORS;
/**
 * 四家船公司各自的"涂装"。
 *   brand   它的标是哪一个（container.ts 里 SHIPPING_LINES 的下标）
 *   colors  它的箱子刷什么颜色；写了两遍的是主色，抽到的机会多一倍
 *   seeds   它的箱子用哪几套"花样"（凹坑和锈迹的位置、喷在门上的箱主代号；一共 6 套，见 container.ts）
 * 颜色、标、花样绑在一起有两个好处：一是像真的 —— 红箱子永远是"激战远洋"的；
 * 二是省：同一种 规格 × 花样 × 做旧 × 标 的箱子共用一份几何、一次画完，组合越少，绘制调用越少。
 * "激战太平洋"的标是藏青色的，只有喷在浅色箱子上才看得见，所以白和黄归它。
 */
const LINES: readonly { brand: number; colors: readonly ColorName[]; seeds: readonly number[] }[] = [
  { brand: 0, colors: ['blue', 'blue', 'grey'], seeds: [0, 4] },   // 激战北航
  { brand: 1, colors: ['red', 'red', 'green'], seeds: [1, 5] },    // 激战远洋
  { brand: 2, colors: ['white', 'yellow'], seeds: [2, 0] },        // 激战太平洋
  { brand: 3, colors: ['teal', 'orange'], seeds: [3, 5] },         // 激战联运
];
type Line = (typeof LINES)[number];

/** 从某家公司的箱子里抽一只。wear 是做旧程度（0 新 … 1 很旧）。 */
function boxOf(s: Stage, line: Line, size: ContainerSize, wear?: number): StackItem {
  return { size, color: CONTAINER_COLORS[s.pick(line.colors)], brand: line.brand, seed: s.pick(line.seeds), wear: wear === undefined ? undefined : clamp(wear, 0, 1) };
}
/** 手摆的箱子用这个：点名要什么颜色，船公司跟着颜色走。extra 里可以再写开门（doors）、掉头（flip）、错位（dx / dz）。 */
function paint(s: Stage, size: ContainerSize, color: ColorName, extra: Partial<StackItem> = {}): StackItem {
  const line = LINES.find((l) => l.colors.includes(color))!;
  return { size, color: CONTAINER_COLORS[color], brand: line.brand, seed: s.pick(line.seeds), ...extra };
}

// ====================================================================== 堆场

const BLOCK_X = [-58, -44, -30, -6, 8, 22];        // 六列堆位的中线
const BLOCK_Z = [-63.4, -31.7, 0, 31.7, 63.4];     // 五排堆位的中线
/** 堆位里相邻两行箱子的间距：箱宽加 20 厘米的缝。 */
const ROW_PITCH = CONTAINER_WIDTH + 0.2;
/** 南北两个箱位的中心各离堆位中心多远：两只 40 尺箱背靠背，中间留 30 厘米。 */
const BAY_OFFSET = CONTAINER_SIZES[40].length / 2 + 0.15;
/** 20 尺箱在 40 尺箱位里靠到一头时，中心偏出去多少（3.065 米）。两只各靠一头，中间正好剩 7 厘米的缝。 */
const HALF_20 = (CONTAINER_SIZES[40].length - CONTAINER_SIZES[20].length) / 2;
const LAYER = CONTAINER_SIZES[20].height;          // 普通箱一层 2.59 米（高箱 2.9）

/**
 * 这个堆位最多码几层；0 = 整个空着。
 * 太阳只有 13° 高，一层箱子（2.6 米）就拖出 11 米长的影子，四层是 45 米。所以越靠近车间东门的堆位压得越低：
 *   · (−58, 0) 正对着东门，空出来当门前的场地；(8, 0) 是甲号中继的空场；
 *   · (−44, 0) 离门 28 米，两层的影子（22 米）够不到门；
 *   · −30 那一列离门 42 米，三层够不到、四层就悬了；−6 那一列在主干道东边，矮一点路上才有几块阳光；−58 那一列挨着车间；
 *   · 其余的可以码到四层。
 */
function maxLayers(bx: number, bz: number) {
  if (bz === 0 && (bx === -58 || bx === 8)) return 0;
  if (bz === 0 && bx === -44) return 2;
  return bx === -58 || bx === -30 || bx === -6 ? 3 : 4;
}
/** 冷藏箱区：这个堆位的南半边全是冷藏箱，机组冲着二号通道（见 layReeferBay）。 */
const REEFER_BLOCK = { bx: 22, bz: 0 };
/**
 * 大门口的开门箱：(−6, 63.4) 堆位朝南那一面、正中间的箱位。出生点就在它南边十几米，一进场抬头就能看见这只敞着门的箱子。
 * row 是堆位里的第几行（−1 西、0 中、1 东），bay 是南北哪半边（1 = 南）。
 */
const GATE_BOX = { bx: -6, bz: 63.4, bay: 1, row: 0 };

function layYard(f: ContainerField, s: Stage) {
  for (const bx of BLOCK_X) for (const bz of BLOCK_Z) {
    const max = maxLayers(bx, bz);
    if (!max) continue;
    const reefers = bx === REEFER_BLOCK.bx && bz === REEFER_BLOCK.bz;
    // 这个堆位的"脾气"：平均码多高、多少箱位放的是 20 尺箱、箱子大致多旧。每个堆位不一样，放眼望去才不是一个模子刻出来的
    const level = Math.min(max - 0.4, 1.3 + s.rand() * 1.4);
    const twenty = s.pick([0.15, 0.3, 0.3, 0.6]);
    const age = 0.3 + s.rand() * 0.4;
    for (const bay of [-1, 1]) {                    // −1 是北半边，+1 是南半边
      const z = bz + bay * BAY_OFFSET;
      if (reefers && bay > 0) { layReeferBay(f, s, bx, z); continue; }
      // 箱门朝外：北半边的朝北、南半边的朝南，都冲着横向通道 —— 走在通道里看到的是一排排箱门，而不是光板
      const yaw = bay < 0 ? DOOR.north : DOOR.south;
      const tenant = s.pick(LINES);                 // 这半个堆位的主顾
      let last = -1;
      for (let row = -1; row <= 1; row++) {
        const x = bx + row * ROW_PITCH;
        if (bx === GATE_BOX.bx && bz === GATE_BOX.bz && bay === GATE_BOX.bay && row === GATE_BOX.row) {
          // 南半个箱位是那只敞着门的 20 尺箱（门口朝南，对着大门）；北半个箱位是两只摞起来的，给它挡住背后
          f.stack(x, z + HALF_20, [paint(s, 20, 'grey', { doors: 0.6, wear: 0.7 })], DOOR.south, 0);
          f.stack(x, z - HALF_20, [paint(s, 20, 'red'), paint(s, 20, 'teal')], DOOR.south);
          last = 1;
          continue;
        }
        // 层数在平均值上下浮动；和左边那一摞一样高的话就加一层或减一层，一排三摞不会齐平
        let layers = clamp(Math.round(level + s.jit(1.1)), 0, max);
        if (layers === last) layers += layers === 0 || (layers < max && s.rand() < 0.5) ? 1 : -1;
        last = layers;
        if (layers <= 0) continue;
        const owner = s.rand() < 0.7 ? tenant : s.pick(LINES);  // 这一摞是谁家的；摞里偶尔也混进一只别家的
        const box = (size: ContainerSize): StackItem => ({ ...boxOf(s, s.rand() < 0.8 ? owner : s.pick(LINES), size, age + s.jit(0.4)), flip: s.rand() < 0.15 });
        if (s.rand() < twenty) {
          // 两只 20 尺箱头尾相接，各码各的：一头可以比另一头高一层或矮一层
          const other = clamp(layers + s.pick([-1, 0, 0, 1]), 0, max), swap = s.rand() < 0.5;
          const north = swap ? other : layers, south = swap ? layers : other;
          if (north) f.stack(x, z - HALF_20, Array.from({ length: north }, () => box(20)), yaw);
          if (south) f.stack(x, z + HALF_20, Array.from({ length: south }, () => box(20)), yaw);
          // 两头一样高、上面还有空的话，偶尔再横跨着压一只 40 尺箱
          if (north === south && north < max && s.rand() < 0.3) f.stack(x, z, [box(s.rand() < 0.25 ? 'hc' : 40)], yaw, 1, north * LAYER);
        } else {
          const list = Array.from({ length: layers }, () => box(s.rand() < 0.25 ? 'hc' : 40));
          // 偶尔在最上面再压一只 20 尺箱，靠到一头
          if (layers < max && s.rand() < 0.1) list.push({ ...box(20), dx: s.rand() < 0.5 ? HALF_20 : -HALF_20 });
          f.stack(x, z, list, yaw);
        }
      }
    }
  }
}

/**
 * 给一只箱子挂上冷藏机组（道具 reefer_unit）。(x, z, yaw) 是箱子的位置和朝向，y 是箱底的高度。
 * 机组挂在"前端" —— 箱门对面的那一头。它的中心放在端板外 0.2 米；机组厚 0.5 米，于是背面正好嵌进端板波纹的凹槽里 5 厘米。
 */
function reefer(s: Stage, size: ContainerSize, x: number, z: number, yaw: number, y = 0, seed = 0) {
  const out = -(CONTAINER_SIZES[size].length / 2 + 0.2);   // 沿箱子自己的长边往"前端"那头走这么远
  s.place(reeferUnit({ seed }), x + out * Math.cos(yaw), z - out * Math.sin(yaw), yaw, y + 0.14);
}

/**
 * 冷藏箱区：一排三摞白色的冷藏箱。冷藏箱要插电、要有人巡检，所以真的码头上它们总是把机组那一头齐刷刷地冲着通道。
 * (bx, z) 是这半个堆位的中心。箱门朝北（朝堆位里面），机组朝南，冲着二号通道。
 * 这几摞不做错位（jitter = 0）：机组是另外摆上去的道具，箱子要是歪了，它就对不上端板了。
 */
function layReeferBay(f: ContainerField, s: Stage, bx: number, z: number) {
  const columns: ContainerSize[][] = [[40, 40], ['hc', 40, 40], [40]];
  columns.forEach((sizes, i) => {
    const x = bx + (i - 1) * ROW_PITCH;
    let y = 0;
    f.stack(x, z, sizes.map((size) => paint(s, size, 'white', { wear: 0.25 + s.rand() * 0.35 })), DOOR.north, 0);
    sizes.forEach((size, layer) => { reefer(s, size, x, z, DOOR.north, y, i + layer); y += CONTAINER_SIZES[size].height; });
  });
}

// ====================================================================== 零散的箱子

/**
 * 堆位以外的箱子：停在主干道上的、码头前沿的、车间东边那条路上的。它们是手摆的 —— 每一处旁边都有别的清单里
 * 配着它摆的道具（road.ts 的隔离墩和路锥、quay.ts 的防撞柱），所以位置不能随便动。
 *
 * 其中四只开着门、能走进去（doors 是开门的程度）：进去以后三面是铁皮，只有门口一面要防，是现成的掩体。
 * 开门箱一律放在最底层，门口朝着开阔的地方，不对着墙。（全场一共五只，还有一只在堆场里，见 GATE_BOX。）
 */
function layLoose(f: ContainerField, s: Stage) {
  const p = (size: ContainerSize, color: ColorName, extra?: Partial<StackItem>) => paint(s, size, color, extra);

  // ---------------------------------------------------------------- 主干道（从南往北）
  f.stack(-22.5, 30, [p('hc', 'teal')], DOOR.south);                                   // 西车道上一只落地的高箱
  f.stack(-13.5, 2, [p(40, 'red'), p(20, 'white', { dx: HALF_20 })], DOOR.south);      // 东车道：40 尺箱顶上压着一只偏到南头的 20 尺箱
  // 西车道：两只 20 尺箱头尾相接。北边那只上面还压着一只；南边那只敞着门，门口朝南 —— 沿着路往北走的人老远就看得见里面是空的
  f.stack(-22.5, -34 - HALF_20, [p(20, 'grey'), p(20, 'orange')], DOOR.north);
  f.stack(-22.5, -34 + HALF_20, [p(20, 'blue', { doors: 0.7 })], DOOR.south, 0);
  f.stack(-13.5, -62, [p(40, 'green')], DOOR.north);

  // ---------------------------------------------------------------- 车间东边
  // 门前空场的东南角：一只空的 20 尺箱，门口朝西，正对着车间的山墙和东南角那根灯杆。
  // 它只有一层高、离东门 16 米，影子（11 米）够不到门，贴地的晨光照样照得进车间
  f.stack(-57.2, 10, [p(20, 'yellow', { doors: 0.75, wear: 0.8 })], DOOR.west, 0);
  f.stack(-68, 52, [p('hc', 'green')], DOOR.south);                                    // 南北向那条路上的两处
  f.stack(-68, -58, [p(40, 'blue'), p(40, 'white')], DOOR.north);

  // ---------------------------------------------------------------- 码头前沿（从北往南）
  // 北端：三只冷藏箱并排，机组朝西（冲着堆场）。南边那摞两层。和冷藏箱区一样不做错位
  f.stack(46, -72, [p(20, 'white', { wear: 0.3 }), p(20, 'white', { wear: 0.5 })], DOOR.east, 0);
  f.stack(45.8, -72 - ROW_PITCH, [p(20, 'grey', { wear: 0.6 })], DOOR.east, 0);
  reefer(s, 20, 46, -72, DOOR.east, 0, 0);
  reefer(s, 20, 46, -72, DOOR.east, LAYER, 1);
  reefer(s, 20, 45.8, -72 - ROW_PITCH, DOOR.east, 0, 2);
  f.stack(31, -44, [p(40, 'green'), p('hc', 'orange')], DOOR.north);                   // 一号岸桥陆侧门腿旁
  // 往东挪了 1.2 米（原来在 x = 41）：西头原来压着岸桥门腿脚下的一根防撞柱
  f.stack(42.2, -30, [p(40, 'red')], DOOR.east);
  // 堆场边线上：两只 20 尺箱头尾相接，南边那只敞着门、门口朝南
  f.stack(31, 10 - HALF_20, [p(20, 'teal')], DOOR.north);
  f.stack(31, 10 + HALF_20, [p(20, 'orange', { doors: 0.5 })], DOOR.south, 0);
  // 二号岸桥底下：东边那只敞着门，门口朝东 —— 钻进去以后背对着堆场，面前只有岸壁和货轮
  f.stack(47 - HALF_20, 24, [p(20, 'red'), p(20, 'grey')], DOOR.west);
  f.stack(47 + HALF_20, 24, [p(20, 'green', { doors: 0.8 })], DOOR.east, 0);
  // 去撤离艇的路上。往东挪了 1.6 米（原来在 x = 40）：西头原来骑在岸桥的轨道上
  f.stack(41.6, 62, [p(40, 'yellow'), p(40, 'blue')], DOOR.east);
}

/** 摆好堆场和零散的箱子。冷藏箱的机组是道具，报到 stage 上。 */
export function layContainers(f: ContainerField, s: Stage) {
  s.reseed(505);
  layYard(f, s);
  layLoose(f, s);
}

// ====================================================================== 货轮甲板

/** 正在卸货的那几列，从靠码头的一侧数起，每一行已经被吊走了几层。 */
const UNLOADED = [3, 3, 2, 2, 1];

/** 甲板上的箱格：第一摞的位置（x、z）、甲板面的高度 y、有几行几列、行距列距。由 port.ts 按船身的尺寸给。 */
export interface DeckGrid { x: number; y: number; z: number; rows: number; bays: number; rowPitch: number; bayPitch: number }

/**
 * 货轮甲板上的箱子。玩家上不了船，最近也在三十米开外，所以这些箱子永远只用简模（lodOnly），也不登记碰撞。
 *
 * 船上的箱子和堆场里的不一样：有锁扣锁着，码得整整齐齐、不错位；一"列"（船员叫贝位）里要么全是 20 尺箱、要么全是 40 尺箱；
 * 同一列差不多一样高。unloading 是正在卸货的那几列（岸桥底下）：岸桥是从靠码头的这一侧开始吊的，
 * 所以最外面两行已经吊空了大半，越往里剩得越多 —— 从码头上看过去，整齐的箱墙在这里缺了一个台阶状的口子。
 * 花样只用每家公司的第一套、做旧只用中间一档 —— 隔这么远看不出差别，而种类少了，这几百只箱子就能并进堆场箱子的那几个批次里一起画。
 */
export function layShipCargo(f: ContainerField, s: Stage, deck: DeckGrid, unloading: readonly number[] = []) {
  s.reseed(606);
  for (let bay = 0; bay < deck.bays; bay++) {
    const z = deck.z + bay * deck.bayPitch;
    const twenty = bay % 3 === 1;                           // 每三列里有一列是 20 尺箱
    const full = s.pick([2, 3, 3, 4]);                      // 这一列码几层
    const tenant = s.pick(LINES);
    for (let row = 0; row < deck.rows; row++) {
      let layers = clamp(full + s.pick([-1, 0, 0, 0]), 1, 4);
      if (unloading.includes(bay)) layers = Math.max(0, layers - (UNLOADED[row] ?? 0));
      const x = deck.x + row * deck.rowPitch;
      let y = deck.y;
      for (let k = 0; k < layers; k++) {
        const size: ContainerSize = twenty ? 20 : s.rand() < 0.25 ? 'hc' : 40;
        for (const end of twenty ? [-1, 1] : [0]) {         // 20 尺箱一层两只，一头一只
          const line = s.rand() < 0.6 ? tenant : s.pick(LINES);
          f.add({ size, x, y, z: z + end * HALF_20, yaw: DOOR.south, color: CONTAINER_COLORS[s.pick(line.colors)], brand: line.brand, seed: line.seeds[0], wear: 0.5, lodOnly: true, solid: false });
        }
        y += CONTAINER_SIZES[size].height;
      }
    }
  }
}
