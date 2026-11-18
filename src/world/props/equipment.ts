import * as THREE from 'three';
import { label as labelPatch, decal as decalPatch, labelMaterial, type Patch } from '../../render/labels';
import { emissive, surface, type SurfaceName } from '../../render/surfaces';
import { Kit, noise3, type PropModel, type Rgb, type V3 } from '../kit';

// 设备与杂物类道具：发电机、三脚投光灯、垃圾箱、工具车、气瓶架、钢管堆，
// 以及布置场地时顺手摆的小东西 —— 轮挡、钢筋料笼、废料斗、钢筋捆、大钢板垛、配电箱、地上的电缆。
//
// 这些东西不参与玩法，作用只有一个：让堆场看起来"有人在这里干过活"。
// 所以每一件都是成组出现的：发电机旁边立着投光灯，中间拖一根电缆；工具车的台面上丢着扳手和抹布。
//
// 写法上的约定（每个函数都一样，看懂一个就看懂了全部）：
//   · 用零件箱 Kit 一个零件一个零件地往里放，最后 finish() 合并。零件再多，一种材质也只有一个网格。
//   · 模型在自己的坐标里搭：底面在 y=0，原点在占地中心，单位是米。
//   · 每个零件带一个"明暗"（tint）。同样的黑钢，这根 0.6、那根 0.9，就不会是一整块死黑。
//   · 同样的参数只搭一次：第二次调用直接拿回上次搭好的那一个（见 cached）。
//     场上要摆很多个的时候，把同一个模型交给 PropField，它会用实例化一次画完。
//
// 尺寸和零件的位置照参考 demo 的道具表还原；参考里看着明显是笔误的几处做了修正，在各自的注释里写了原因。
// 想读懂写法，建议从零件最多、但每个零件都很直白的发电机（generator）看起。

const PI = Math.PI, HALF = Math.PI / 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 每种道具都接受的参数。 */
export interface EquipOpts {
  /** 换一个数就得到另一个"个体"：深浅、朝向、喷的编号都不一样。 */
  seed?: number;
  /** 摆在室内（淋不到雨）。 */
  interior?: boolean;
}

// ---------------------------------------------------------------- 缓存
const models = new Map<string, PropModel>();
/**
 * 同样的参数只搭一次。key 里要写全所有会影响外形的参数。
 * 注意：拿到的是同一个对象。要摆多个请用 PropField（实例化）；placeOnce 会直接挪动这个对象本身，只适合全场只摆一件的东西。
 */
function cached(name: string, key: unknown[], build: () => PropModel): PropModel {
  // 没给的参数（undefined）和 false 都记成 0：generator() 和 generator({ interior: false }) 是同一件东西，不该搭两次
  const id = `${name}|${JSON.stringify(key.map((v) => v || 0))}`;
  let m = models.get(id);
  if (!m) models.set(id, (m = build()));
  return m;
}

// ---------------------------------------------------------------- 漆色
export type PaintColor = 'red' | 'blue' | 'green' | 'yellow' | 'orange' | 'white' | 'grey' | 'teal' | 'rust' | 'black' | 'olive';
/** 颜色名 → [材质, 再乘一层的染色]。黑和橄榄绿没有专门的材质，是在灰漆、绿漆上压出来的。 */
const PAINTS: Record<PaintColor, [SurfaceName, Rgb]> = {
  red: ['paint_red', [1, 1, 1]], blue: ['paint_blue', [1, 1, 1]], green: ['paint_green', [1, 1, 1]], yellow: ['paint_yellow', [1, 1, 1]],
  orange: ['paint_orange', [1, 1, 1]], white: ['paint_white', [1, 1, 1]], grey: ['paint_grey', [1, 1, 1]], teal: ['paint_teal', [1, 1, 1]],
  rust: ['steel_rust', [1, 1, 1]], black: ['paint_grey', [0.2, 0.2, 0.22]], olive: ['paint_green', [0.75, 0.8, 0.45]],
};
/** 取一种漆：mat 是材质名，shade(k) 给出"这种漆、明暗为 k"的染色。 */
function paint(color: PaintColor | undefined, fallback: PaintColor) {
  const [mat, base] = PAINTS[color ?? fallback] ?? PAINTS[fallback];
  return { mat, shade: (k = 1): Rgb => [base[0] * k, base[1] * k, base[2] * k] };
}

// ================================================================ 发电机
/**
 * 柴油发电机组 2.2 × 1.4 × 1.0。
 * 从下到上：撬座（两根带叉车孔的纵梁）→ 底盘 → 黄色机罩（每侧三扇检修门，后两扇带百叶）→ 顶盖（吊环、排气管）。
 * -x 端是控制面板：一颗一直亮着的绿色运行灯，雨夜里远远就能看到；+x 端是散热格栅。
 */
export function generator(o: EquipOpts & { color?: PaintColor; label?: string } = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('generator', [seed, o.color, o.label, o.interior], () => {
    const k = new Kit('generator', seed, { interior: o.interior });
    const { mat: body, shade } = paint(o.color, 'yellow');
    const HX = 1.03, HZ = 0.46;                    // 机罩的半长、半宽
    const Y0 = 0.3, Y1 = 1.16, YM = (Y0 + Y1) / 2; // 机罩的底、顶、中线高度

    // 撬座：两根纵梁，外侧面上各有两个叉车孔（用一小片很暗的薄板假装是个洞）
    for (const s of [1, -1]) {
      k.box('steel_dark', 2.2, 0.14, 0.1, 0, 0.07, s * 0.4, { c: 0.012, tint: 0.6 });
      for (const x of [-0.45, 0.45]) k.box('steel_dark', 0.22, 0.075, 0.004, x, 0.075, s * 0.451, { plain: true, tint: 0.12 });
    }
    for (const x of [-0.85, 0, 0.85]) k.box('steel_dark', 0.1, 0.1, 0.72, x, 0.07, 0, { plain: true, tint: 0.55 });
    k.box('steel_dark', 2.1, 0.17, 0.94, 0, 0.215, 0, { c: 0.012, tint: 0.8 });
    // 机罩和顶盖。顶盖比机罩大一圈，像个帽檐；上面两道压筋
    k.box(body, 2.06, Y1 - Y0, HZ * 2, 0, YM, 0, { c: 0.025, tint: shade() });
    k.box(body, 2.13, 0.045, 0.99, 0, Y1 + 0.02, 0, { c: 0.014, tint: shade(0.9) });
    for (const x of [-0.52, 0.52]) k.box(body, 0.04, 0.012, 0.95, x, Y1 + 0.046, 0, { plain: true, tint: shade(0.85) });

    // 两个长侧面：各三扇门
    for (const s of [1, -1]) {
      const face: V3 = [0, s > 0 ? 0 : PI, 0]; // 贴片默认朝 +z；背面那一侧要转半圈
      [-0.66, 0, 0.66].forEach((x, i) => {
        k.box(body, 0.62, 0.72, 0.012, x, YM + 0.01, s * (HZ + 0.004), { c: 0.006, tint: shade(k.range(0.9, 1)) }); // 每扇门深浅略有不同
        k.box('steel_dark', 0.03, 0.11, 0.016, x + 0.27, YM, s * (HZ + 0.012), { plain: true, tint: 0.6 });         // 把手
        k.box('steel_galv', 0.012, 0.03, 0.006, x + 0.27, YM + 0.03, s * (HZ + 0.022), { plain: true, tint: 0.8 }); // 锁舌
        for (const dy of [-0.25, 0.25]) k.cyl('steel_galv', 0.009, 0.06, x - 0.305, YM + dy, s * (HZ + 0.012), { seg: 5, open: true, tint: 0.7 }); // 铰链
        if (i === 0) return;
        // 后两扇门带百叶：一块暗底板，前面斜着排几片叶片。中间那扇 5 片（靠下），最后一扇 8 片（靠上）
        const slats = i === 2 ? 8 : 5, w = 0.42, cy = i === 2 ? YM + 0.14 : YM - 0.16;
        k.box('steel_dark', w, slats * 0.05, 0.004, x - 0.03, cy, s * (HZ + 0.0105), { plain: true, tint: 0.12 });
        for (let j = 0; j < slats; j++) k.box(body, w, 0.04, 0.005, x - 0.03, cy + (j - (slats - 1) / 2) * 0.05, s * (HZ + 0.018), { plain: true, rot: [s * 0.6, 0, 0], tint: shade(0.82) });
        if (i === 2) k.decal('rust_run', 0.3, [x - 0.03, cy - 0.38, s * (HZ + 0.0112)], face, 0.42); // 百叶下沿淌下来的锈水
      });
      // 机号喷在没有百叶的那扇门上。（参考里背面的字喷在了百叶后面，被叶片挡住，这里两面都放到第一扇门）
      k.label(o.label ?? `GEN-0${1 + (seed % 2)}`, { color: 'black', font: 'stencil', distress: 0.35 }, 0.5, 0.13, [-0.66, YM + 0.17, s * (HZ + 0.0112)], face);
      k.decal('hazard_voltage', 0.15, [-0.66 - s * 0.18, YM - 0.17, s * (HZ + 0.0112)], face);
    }

    // +x 端：散热格栅。暗底板 + 11 片斜叶片 + 一圈框
    k.box('steel_dark', 0.004, 0.66, 0.74, HX + 0.001, YM, 0, { plain: true, tint: 0.1 });
    for (let i = 0; i < 11; i++) k.box(body, 0.006, 0.046, 0.74, HX + 0.012, YM - 0.3 + i * 0.06, 0, { plain: true, rot: [0, 0, -0.6], tint: shade(0.8) });
    for (const s of [1, -1]) {
      k.box(body, 0.03, 0.72, 0.03, HX + 0.012, YM, s * 0.385, { plain: true, tint: shade(0.9) });
      k.box(body, 0.03, 0.03, 0.8, HX + 0.012, YM + s * 0.345, 0, { plain: true, tint: shade(0.9) });
    }

    // -x 端：控制面板。一个凹进去的暗色面板，上面有遮雨檐、两侧有挡板
    const PX = -HX - 0.004, PZ = 0.14; // 面板所在的 x，和面板中心的 z
    k.box('steel_dark', 0.01, 0.44, 0.52, PX, 0.87, PZ, { c: 0.004, tint: 0.45 });
    k.box(body, 0.075, 0.014, 0.56, PX - 0.03, 1.1, PZ, { c: 0.004, rot: [0, 0, 0.12], tint: shade(0.9) });
    for (const s of [1, -1]) k.box(body, 0.06, 0.44, 0.012, PX - 0.025, 0.87, PZ + s * 0.268, { plain: true, tint: shade(0.9) });
    const FX = PX - 0.0055;            // 面板表面的 x，下面的仪表都贴在它上面
    const out: V3 = [0, -HALF, 0];     // 让贴片朝 -x
    // 屏幕：很暗的一小块绿（亮度 0.32，不会被泛光晕开）。比底下的边框再往外 1 毫米，免得两个面叠在一起闪
    k.box('steel_dark', 0.008, 0.09, 0.15, FX + 0.003, 0.99, PZ - 0.12, { c: 0.003, tint: 0.3 });
    k.plane(emissive(0x86e3a8, 0.32), 0.13, 0.07, [FX - 0.002, 0.99, PZ - 0.12], { rot: out, raw: true, cast: false });
    // 运行灯：亮度 3.2，超过 1 的部分会被泛光晕成一团绿光
    k.cyl('steel_galv', 0.02, 0.012, FX - 0.004, 1, PZ + 0.19, { axis: 'x', seg: 10, tint: 0.7 });
    k.cyl(emissive(0x3dff6a, 3.2), 0.013, 0.014, FX - 0.009, 1, PZ + 0.19, { axis: 'x', seg: 10, raw: true });
    // 急停按钮：黄色底座 + 红色蘑菇头（车削件默认沿 y 轴，绕 z 转 90° 后头朝 -x）
    k.cyl(body, 0.042, 0.006, FX - 0.003, 0.8, PZ + 0.17, { axis: 'x', seg: 12 });
    k.lathe('plastic_red', [[0, 0], [0.018, 0], [0.018, 0.018], [0.03, 0.02], [0.03, 0.034], [0.02, 0.042], [0, 0.044]], FX - 0.004, 0.8, PZ + 0.17, { seg: 10, rot: [0, 0, HALF], tint: 0.95 });
    // 三块圆表：表壳、表盘、一根指针（每根指的方向不一样）
    for (let i = 0; i < 3; i++) {
      const z = PZ - 0.2 + i * 0.105;
      k.cyl('steel_galv', 0.042, 0.012, FX - 0.004, 0.86, z, { r2: 0.04, seg: 10, rot: [0, 0, HALF], tint: 0.75 });
      k.cyl('steel_galv', 0.034, 0.002, FX - 0.0105, 0.86, z, { axis: 'x', seg: 10, tint: 1.25 }); // 表盘比表壳亮一档
      k.box('steel_dark', 0.002, 0.028, 0.004, FX - 0.0125, 0.868, z + 0.005, { plain: true, rot: [k.range(-1, 1), 0, 0], tint: 0.3 });
    }
    // 五个拨动开关，有的朝上有的朝下；第一个是红的
    // （参考里后四个是和面板一样的黑钢，贴在黑面板上完全看不出来；这里换成镀锌的银色扳柄）
    for (let i = 0; i < 5; i++) k.box(i === 0 ? 'plastic_red' : 'steel_galv', 0.014, 0.04, 0.022, FX - 0.006, 0.74, PZ - 0.2 + i * 0.03, { plain: true, rot: [0, 0, k.rng() < 0.5 ? 0.25 : -0.25], tint: 0.8 });
    k.decal('hazard_voltage', 0.13, [-HX - 0.002, 0.95, -0.28], out);
    k.label('危险', { color: 'red', font: 'stencil', distress: 0.3 }, 0.22, 0.05, [-HX - 0.002, 0.82, -0.28], out);
    // 三个电源插座（一红两蓝），斜着朝下，其中一个插着蓝插头，电缆垂到地上再顺着撬座拖出去
    const sockets: [SurfaceName, number][] = [['plastic_red', 0.02], ['plastic_blue', 0.2], ['plastic_blue', -0.25]];
    for (const [mat, z] of sockets) {
      k.box('steel_dark', 0.02, 0.12, 0.1, -HX - 0.008, 0.5, z, { c: 0.006, tint: 0.4 });
      k.tube(mat, [-HX - 0.01, 0.5, z], [-HX - 0.06, 0.47, z], 0.036, { seg: 10, cap: true, tint: 0.9 });
    }
    k.tube('plastic_blue', [-HX - 0.06, 0.47, 0.2], [-HX - 0.068, 0.39, 0.2], 0.03, { r2: 0.02, seg: 8, cap: true, tint: 0.85 });
    k.hose('rubber', [[-HX - 0.066, 0.4, 0.2], [-HX - 0.064, 0.25, 0.21], [-HX - 0.05, 0.06, 0.26], [-HX + 0.05, 0.016, 0.4], [-HX + 0.3, 0.016, 0.478], [-0.35, 0.016, 0.486]], 0.014, { seg: 5, steps: 30 });

    // 顶上：吊环、排气管
    const TOP = Y1 + 0.0425; // 顶盖的上表面
    k.box('steel_dark', 0.2, 0.012, 0.14, 0, TOP + 0.004, 0, { c: 0.004, tint: 0.6 });
    k.torus('steel_galv', 0.045, 0.014, 0, TOP + 0.058, 0, { axis: 'z', tubeSeg: 5, seg: 10, tint: 0.7 });
    const EX = 0.72, EZ = 0.24; // 排气管的位置
    k.cyl('steel_rust', 0.066, 0.025, EX, TOP + 0.012, EZ, { r2: 0.062, seg: 12, tint: 0.6 });
    k.cyl('steel_rust', 0.04, 0.17, EX, TOP + 0.085, EZ, { seg: 12, open: true, tint: (_x, y) => 0.45 + 0.55 * clamp01((TOP + 0.17 - y) / 0.17) }); // 越靠管口越黑
    k.cyl('steel_rust', 0.034, 0.002, EX, TOP + 0.15, EZ, { seg: 10, tint: 0.08 });                // 管口里面：一片黑
    k.cyl('steel_rust', 0.046, 0.005, EX - 0.012, TOP + 0.186, EZ, { seg: 12, rot: [0, 0, 0.5], tint: 0.6 }); // 防雨盖，被排气顶开一半
    k.decal('scorch', 0.3, [EX, TOP + 0.001, EZ], [-HALF, 0, 0]);

    // 侧下方：加油口（红盖）+ 易燃标 + "柴油"
    k.tube('steel_dark', [-0.72, 0.25, 0.46], [-0.72, 0.32, 0.5], 0.03, { seg: 8, cap: true, tint: 0.6 });
    k.tube('plastic_red', [-0.72, 0.32, 0.5], [-0.72, 0.338, 0.51], 0.037, { seg: 10, cap: true, tint: 0.9 });
    k.decal('hazard_flammable', 0.11, [-0.52, 0.215, 0.4712]);
    k.label('柴油', { color: 'white', font: 'stencil', distress: 0.4 }, 0.2, 0.05, [-0.34, 0.215, 0.4712]);

    return k.finish({ size: [2.2, 1.4, 1], boxes: [{ min: [-1.1, 0, -0.5], max: [1.1, 1.21, 0.5] }], surface: 'metal' });
  });
}

// ================================================================ 三脚投光灯
const FLOOD_COLOR = 0xfff1dc;
const HEAD_TOE = 0.12, HEAD_PITCH = 0.22;  // 两只灯头各往外撇、往下俯的角度（弧度）
const HEAD_ROOT: V3 = [0.03, 2.03, 0.2];    // 灯头在横担上的安装点（z 取正负两边）
const LENS: V3 = [0.0985, 0.02, 0];        // 灯面中心在灯头自己坐标里的位置

/**
 * 给"以后挂一盏真灯"用的数据，都在灯架自己的坐标里（灯架摆到场景里以后，要再乘上它的位置和朝向）。
 * pos 在两只灯头的正中间略靠前；dir 是照射方向（已经是单位向量）：朝 +x、下俯 0.22 弧度。
 */
export const FLOODLIGHT_LAMP: { pos: V3; dir: V3; color: number } = {
  pos: [0.14, 2.03, 0], dir: [Math.cos(HEAD_PITCH), -Math.sin(HEAD_PITCH), 0], color: FLOOD_COLOR,
};
/** 两只灯头各自的灯面中心和朝向：做光晕、或者想一只灯头挂一盏灯时用。 */
export const FLOODLIGHT_HEADS: { pos: V3; dir: V3 }[] = [-1, 1].map((side) => {
  const cp = Math.cos(HEAD_PITCH), sp = Math.sin(HEAD_PITCH), ct = Math.cos(HEAD_TOE), st = Math.sin(HEAD_TOE);
  // 灯面中心先跟着灯头下俯（绕 z 轴转），再跟着外撇（绕 y 轴转）
  const lx = LENS[0] * cp + LENS[1] * sp, ly = -LENS[0] * sp + LENS[1] * cp;
  return { pos: [HEAD_ROOT[0] + lx * ct, HEAD_ROOT[1] + ly, side * (HEAD_ROOT[2] + lx * st)], dir: [cp * ct, -sp, side * cp * st] };
});

/**
 * 工地上那种三脚架投光灯，高 2.2 米。铝管立杆分两节（细的套在粗的里，中间一个锁紧套），
 * 三条腿撑开到半径 0.5 米；顶上一根横担挂两只灯头，朝 +x 照。电缆顺着杆子绕下来，在地上甩出去 1.2 米接一个黄插头。
 * on: false 表示关着（灯面只剩一点点亮）。
 */
export function floodlightStand(o: EquipOpts & { on?: boolean } = {}): PropModel {
  const seed = o.seed ?? 0, on = o.on !== false;
  return cached('floodlight_stand', [seed, on, o.interior], () => {
    const k = new Kit('floodlight_stand', seed, { interior: o.interior });
    const lens = emissive(FLOOD_COLOR, on ? 10 : 0.02);
    // 立杆。杆子不落地，是被三条腿架起来的
    k.cyl('aluminium', 0.021, 1.1, 0, 0.75, 0, { seg: 8, open: true });
    k.cyl('aluminium', 0.016, 0.9, 0, 1.6, 0, { seg: 8, open: true, tint: 0.9 });
    k.cyl('steel_dark', 0.03, 0.06, 0, 1.3, 0, { seg: 8 });                         // 锁紧套
    k.tube('steel_dark', [0.03, 1.3, 0], [0.085, 1.3, 0], 0.008, { seg: 6, cap: true }); // 锁紧套上的拧手
    k.box('steel_dark', 0.02, 0.03, 0.05, 0.09, 1.3, 0, { c: 0.005 });
    k.cyl('steel_dark', 0.032, 0.07, 0, 0.82, 0, { seg: 8 });                       // 三条腿的上铰座
    k.cyl('steel_dark', 0.03, 0.05, 0, 0.36, 0, { seg: 8 });                        // 拉杆的下铰座
    for (let i = 0; i < 3; i++) {
      const a = (i * PI * 2) / 3 + 0.5, cx = Math.cos(a), cz = Math.sin(a);
      k.tube('aluminium', [cx * 0.035, 0.82, cz * 0.035], [cx * 0.5, 0.025, cz * 0.5], 0.013, { seg: 6, tint: k.range(0.8, 1) });
      k.tube('aluminium', [cx * 0.03, 0.36, cz * 0.03], [cx * 0.3, 0.37, cz * 0.3], 0.008, { seg: 5, tint: 0.85 }); // 防止腿劈开的拉杆
      k.sph('rubber', 0.028, cx * 0.5, 0.02, cz * 0.5, { seg: 8 });
    }
    k.box('steel_dark', 0.05, 0.04, 0.72, 0, HEAD_ROOT[1], 0, { c: 0.008 }); // 横担
    // 两只灯头：先在灯头自己的坐标里搭（+x 是照射方向），再外撇、下俯
    for (const side of [-1, 1]) {
      k.at([HEAD_ROOT[0], HEAD_ROOT[1], side * HEAD_ROOT[2]], [0, -side * HEAD_TOE, 0], () => k.at([0, 0, 0], [0, 0, -HEAD_PITCH], () => {
        k.box('paint_yellow', 0.075, 0.24, 0.32, 0.06, 0.02, 0, { c: 0.012 });
        k.plane(lens, 0.28, 0.2, LENS, { rot: [0, HALF, 0], raw: true, cast: false });
        // 灯面外面一圈护框
        for (const z of [0.157, -0.157]) k.box('steel_dark', 0.012, 0.25, 0.012, 0.1, 0.02, z, { plain: true });
        for (const y of [0.143, -0.103]) k.box('steel_dark', 0.012, 0.012, 0.33, 0.1, y, 0, { plain: true });
        // 背后的散热片：灯很烫，靠这几片薄铁把热散掉
        for (let i = -3; i <= 3; i++) k.box('steel_dark', 0.035, 0.2, 0.006, 0.008, 0.02, i * 0.043, { plain: true, tint: 0.8 });
        k.hose('paint_yellow', [[0.05, 0.14, -0.1], [0.05, 0.2, -0.06], [0.05, 0.2, 0.06], [0.05, 0.14, 0.1]], 0.008, { seg: 5, steps: 8 }); // 提手
      }));
    }
    // 电缆：绕着杆子下来，落地后朝一个随机方向甩出去
    const a = k.rng() * PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    k.hose('rubber', [
      [0, 2, 0.03], [-0.03, 1.7, 0.04], [0.035, 1.25, 0.02], [-0.03, 0.9, 0.03], [0.05, 0.5, 0.06], [0.12, 0.08, 0.1], [0.25, 0.012, 0.16],
      [0.3 + dx * 0.3, 0.012, 0.2 + dz * 0.3], [0.2 + dx * 0.75 - dz * 0.2, 0.012, 0.1 + dz * 0.75 + dx * 0.2], [dx * 1.2, 0.012, dz * 1.2],
    ], 0.011, { seg: 5, steps: 40 });
    k.box('paint_yellow', 0.09, 0.05, 0.06, dx * 1.24, 0.026, dz * 1.24, { c: 0.01, rot: [0, -a, 0] });
    // 碰撞只算中间的杆子：腿和电缆可以直接跨过去
    return k.finish({ size: [1, 2.2, 1], boxes: [{ min: [-0.12, 0, -0.12], max: [0.12, 2.2, 0.12] }], surface: 'metal' });
  });
}

// ================================================================ 垃圾箱
/** 零件自己的摆放矩阵：先按 rot 转，再挪到 pos。给 Kit.add 直接放几何体时用（零件箱没有现成基本体的形状：拱起的盖子、揉皱的袋子、弯贴片）。 */
const xf = (pos: V3, rot: V3 = [0, 0, 0]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));

/** 脚轮：顶上一块安装板，两片叉板夹着一只橡胶轮。r 是轮子半径；原点在安装板中心的正下方地面上。垃圾箱和工具车都用它。 */
function caster(k: Kit, r: number, mountY: number) {
  const s = r / 0.08; // 其余尺寸跟着轮子大小等比例缩放（0.08 是垃圾箱那只的半径）
  const off = 0.035 * s; // 轮轴比安装板靠后一点：推着走的时候轮子会自己转到身后，这就是"万向轮"
  k.box('steel_galv', 0.13 * s, 0.012 * s, 0.11 * s, 0, mountY, 0, { c: 0.003, tint: 0.7 });
  for (const side of [1, -1]) k.bar('steel_galv', [off, r, side * 0.034 * s], [0, mountY - 0.004, side * 0.034 * s], 0.05 * s, 0.006 * s, { plain: true, tint: 0.65 });
  k.cyl('rubber', r, 0.045 * s, off, r, 0, { axis: 'z', seg: 12, tint: 0.9 });
  k.cyl('steel_galv', r * 0.44, 0.05 * s, off, r, 0, { axis: 'z', seg: 8, tint: 0.6 });
}

/** 垃圾箱盖：一块薄板，顶面中间微微拱起（塑料盖都是这样，为了不积水）。只有顶面的顶点被抬高。 */
function lidGeometry(w: number, t: number, d: number, bulge: number) {
  const g = new THREE.BoxGeometry(w, t, d, 4, 1, 5);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setY(i, p.getY(i) + bulge * Math.cos((p.getZ(i) / d) * PI) * Math.cos((p.getX(i) / w) * PI));
  g.computeVertexNormals();
  return g;
}

/**
 * 一团软东西（垃圾袋）：从一个只有 120 个三角形的球出发，
 * 先把它往"方枕头"的形状上靠（坐标的绝对值开 0.6 次方 —— 越靠近 0 的分量被放大得越多，球就鼓成了圆角的方块），
 * 再按噪声把每个顶点推来推去，揉出褶子。最后重算法线。
 */
function blobGeometry(sx: number, sy: number, sz: number, seed: number) {
  const g = new THREE.SphereGeometry(1, 10, 7);
  const p = g.getAttribute('position');
  const boxy = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 0.6);
  for (let i = 0; i < p.count; i++) {
    let x = boxy(p.getX(i)) * sx / 2, y = boxy(p.getY(i)) * sy / 2, z = boxy(p.getZ(i)) * sz / 2;
    const n = noise3(x * 6 + seed, y * 6, z * 6) - 0.5;
    x += n * 0.06; z += n * 0.06; y += n * 0.04;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * 带轮子的大垃圾箱 1.9 × 1.35 × 1.1。箱体的横截面是个梯形：正面（+z）往外斜，背面几乎是直的。
 * 两片塑料盖一片盖着、一片向后掀开搭在背后，掀开的那半边能看到里面的垃圾袋。
 */
export function dumpster(o: EquipOpts & { color?: PaintColor; label?: string } = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('dumpster', [seed, o.color, o.label, o.interior], () => {
    const k = new Kit('dumpster', seed, { interior: o.interior });
    const { mat: body, shade } = paint(o.color, 'green');
    const HX = 0.89;                    // 箱体半长
    const Y0 = 0.2, Y1 = 1.12;          // 箱底、上口的高度
    const ZF0 = 0.3, ZF1 = 0.5;         // 正面：箱底处、上口处的 z
    const ZB0 = -0.44, ZB1 = -0.5;      // 背面：箱底处、上口处的 z
    const WALL = 0.022;                 // 壁厚
    // 箱体 = 一个"U"字形的截面沿 x 拉长。截面画在 (−z, y) 平面里，绕 y 转 90° 之后，挤出方向就成了 x
    const section: [number, number][] = [
      [-ZF1, Y1], [-ZF0, Y0], [-ZB0, Y0], [-ZB1, Y1],                                                          // 外轮廓：正面上口 → 箱底 → 背面上口
      [-ZB1 - WALL, Y1], [-ZB0 - WALL * 0.8, Y0 + WALL], [-ZF0 + WALL * 0.8, Y0 + WALL], [-ZF1 + WALL, Y1],  // 内轮廓，往回走
    ];
    k.extrude(body, section, HX * 2, { rot: [0, HALF, 0], soft: 0, tint: (x, y) => shade(0.9 + 0.1 * noise3(x * 3 + seed * 2.3, y * 3, 0)) });
    for (const s of [1, -1]) {
      k.extrude(body, [[-ZF1, Y1], [-ZF0, Y0], [-ZB0, Y0], [-ZB1, Y1]], WALL, { pos: [s * (HX - WALL / 2), 0, 0], rot: [0, HALF, 0], soft: 0, tint: shade(0.95) }); // 端板
      k.box(body, 0.05, 0.045, ZF1 - ZB1 + 0.04, s * HX, Y1, 0, { c: 0.008, tint: shade(0.9) });                // 端头的口沿
      for (const z of [-0.22, 0.14]) k.box(body, 0.03, 0.84, 0.05, s * (HX + 0.012), 0.66, z, { c: 0.006, tint: shade(0.9) }); // 两根竖筋
      k.box(body, 0.035, 0.1, 0.84, s * (HX + 0.014), 0.93, 0, { c: 0.008, tint: shade(0.85) });                // 一根横梁
      // 吊耳轴：垃圾车就是叉着这两根轴把箱子举起来倒的，所以磨得发亮
      k.tube('steel_worn', [s * (HX + 0.01), 0.93, 0.3], [s * (HX + 0.065), 0.93, 0.3], 0.03, { seg: 10, cap: true, tint: 0.7 });
      k.cyl('steel_worn', 0.042, 0.008, s * (HX + 0.064), 0.93, 0.3, { axis: 'x', seg: 10, tint: 0.6 });
    }
    k.box(body, HX * 2 + 0.04, 0.045, 0.05, 0, Y1, ZF1, { c: 0.008, tint: shade(0.9) }); // 前后口沿
    k.box(body, HX * 2 + 0.04, 0.045, 0.05, 0, Y1, ZB1, { c: 0.008, tint: shade(0.9) });
    // 前后斜面上各 4 根加强筋，顺着斜面走（方杆，两个端点落在斜面外侧）
    for (const x of [-0.6, -0.2, 0.2, 0.6]) {
      k.bar(body, [x, Y0 + 0.03, ZF0 + 0.022], [x, Y1 - 0.04, ZF1 + 0.012], 0.055, 0.03, { c: 0.006, tint: shade(0.9) });
      k.bar(body, [x, Y0 + 0.03, ZB0 - 0.016], [x, Y1 - 0.04, ZB1 - 0.012], 0.055, 0.03, { c: 0.006, tint: shade(0.9) });
    }
    const slope = (ZF1 - ZF0) / (Y1 - Y0);                    // 正面每升高 1 米往外斜多少
    const frontZ = (y: number) => ZF0 + (y - Y0) * slope;      // 正面在高度 y 处的 z
    k.bar(body, [-HX, Y0 + 0.5, frontZ(Y0 + 0.5) + 0.022], [HX, Y0 + 0.5, frontZ(Y0 + 0.5) + 0.022], 0.06, 0.03, { c: 0.006, tint: shade(0.88) }); // 腰上一道横筋
    // 正面的字和污渍。正面是往外斜的（上口比箱底靠外），贴片要跟着仰同样的角度才贴得平。
    // （参考里这个角度的正负号写反了，贴片会一半扎进箱壁里；这里按实际的斜面算）
    const tilt: V3 = [Math.atan(slope), 0, 0];
    const onFront = (x: number, y: number): V3 => [x, y, frontZ(y) + 0.003];
    k.decal('grime_streak', 0.36, onFront(0.4, 0.8), tilt, 0.6);
    k.decal('rust_run', 0.3, onFront(0, 0.455), tilt, 0.46); // 顶边正好在腰上那道横筋的下沿：锈是从筋的焊缝里淌出来的
    k.decal('leak_stain', 0.34, onFront(-0.4, 0.45), tilt, 0.45);
    k.label(o.label ?? `四号泊位废物 ${11 + (seed % 2)}`, { color: 'white', font: 'stencil', distress: 0.5 }, 0.36, 0.09, onFront(-0.4, 0.93), tilt);
    // 公司标是藏青色的，直接贴在深绿的箱体上看不清：先钉一块白铁皮牌子，再把标贴在牌子上
    k.box('paint_white', 0.33, 0.115, 0.004, ...onFront(0.4, 0.42), { plain: true, rot: tilt, tint: 0.92 });
    k.decal('logo_c', 0.3, [0.4, 0.42, frontZ(0.42) + 0.0065], tilt);

    // 盖子：后沿一根铰轴，两片盖各自绕着它转
    const HY = Y1 + 0.045, HZ = ZB1 - 0.02; // 铰轴的高度和 z
    k.tube('steel_galv', [-HX - 0.02, HY, HZ], [HX + 0.02, HY, HZ], 0.013, { seg: 6, cap: true, tint: 0.7 });
    const lid = (x: number, open: number) => k.at([x, HY, HZ], [open, 0, 0], () => {
      const D = 1.07, shadeLid = k.range(0.75, 0.95); // 盖子从铰轴往前伸 1.07 米
      k.add('plastic_grey', lidGeometry(0.885, 0.04, D, 0.018), { tint: shadeLid }, xf([0, 0.005, D / 2]));
      for (const rx of [-0.26, 0.26]) k.box('plastic_grey', 0.07, 0.016, D - 0.16, rx, 0.036, D / 2, { c: 0.006, tint: shadeLid * 0.9 }); // 两道筋
      k.box('plastic_grey', 0.3, 0.035, 0.05, 0, 0.02, D + 0.01, { c: 0.01, tint: shadeLid * 0.8 });                                      // 前沿的把手
      for (const rx of [-0.3, 0.3]) k.box('plastic_grey', 0.08, 0.03, 0.09, rx, 0.005, 0.03, { plain: true, tint: shadeLid * 0.8 });      // 铰链座
    });
    lid(-0.45, 0);
    // 另一片翻过去 270° 挂在背后：绕 x 轴转 90° 多一点，盖子就从"平着往前伸"变成"贴着后壁往下垂"
    lid(0.45, HALF + 0.07 + k.range(0, 0.05));
    // 掀开的那半边：三只黑垃圾袋，一片竖着插在里面的纸板
    const bags: [number, number, number, number][] = [[0.45, 0.93, 0.05, 1], [0.66, 0.9, -0.24, 0.8], [0.22, 0.86, -0.2, 0.85]];
    for (const [x, y, z, s] of bags) k.add('polymer_black', blobGeometry(0.46 * s, 0.4 * s, 0.42 * s, k.rng() * 20), { tint: 0.8 }, xf([x, y, z], [k.rng() * 0.5, k.rng() * 6, 0]));
    k.strip('cardboard', [[0.2, 0.9, 0.2], [0.24, 1.14, 0.26], [0.3, 1.2, 0.33]], [0.16, 0, -0.05], { tint: 0.7 });
    // 四只万向脚轮，各朝各的方向
    for (const x of [-0.7, 0.7]) for (const z of [-0.3, 0.17]) k.at([x, 0, z], [0, k.rng() * 6, 0], () => caster(k, 0.08, 0.194));

    return k.finish({ size: [1.9, 1.35, 1.1], boxes: [{ min: [-0.95, 0.05, -0.56], max: [0.95, 1.2, 0.55] }], surface: 'metal' });
  });
}

// ================================================================ 工具车
/**
 * 修理工的工具车 0.9 × 0.95 × 0.5：红色柜体、五层抽屉（其中一层没推到底）、一端有推手、四只脚轮。
 * 台面上摆着干活干到一半的东西：扳手、小锤、一排套筒、喷剂、螺丝刀、一块抹布。
 * （规格文档把小锤和螺丝刀写成了"木柄螺丝刀"和"记号笔"。按参考里实际的零件看 —— 木柄 + 横着的钢块、
 * 黄色粗柄 + 细钢杆 —— 是锤子和螺丝刀，这里按零件的样子做。）
 */
export function toolboxCart(o: EquipOpts & { color?: PaintColor; label?: string } = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('toolbox_cart', [seed, o.color, o.label, o.interior], () => {
    const k = new Kit('toolbox_cart', seed, { interior: o.interior });
    const { mat: body, shade } = paint(o.color, 'red');
    const CX = 0.04, LEN = 0.74, Y0 = 0.125, Y1 = 0.785, HZ = 0.23; // 柜体中心的 x（推手占了 -x 那头）、长、底、顶、半宽
    k.box(body, LEN, Y1 - Y0, HZ * 2, CX, (Y0 + Y1) / 2, 0, { c: 0.012, tint: shade() });
    k.box('steel_dark', LEN + 0.01, 0.02, HZ * 2 + 0.01, CX, Y0 + 0.004, 0, { c: 0.006, tint: 0.5 });
    // 抽屉：从上往下 5 层，越往下越高。其中一层拉出来 5 厘米，另有几层没关严（差 4 毫米）
    const pulled = 1 + (seed % 3);
    let top = Y1 - 0.03;
    [0.075, 0.075, 0.1, 0.13, 0.19].forEach((h, i) => {
      const out = i === pulled ? 0.05 : k.rng() < 0.3 ? 0.004 : 0, cy = top - h / 2;
      k.box(body, LEN - 0.05, h - 0.01, 0.014, CX, cy, HZ + 0.005 + out, { c: 0.004, tint: shade(k.range(0.9, 1)) });
      k.box('aluminium', LEN - 0.09, 0.016, 0.016, CX, cy + h / 2 - 0.02, HZ + 0.019 + out, { c: 0.004, tint: 0.85 }); // 通长的铝拉手
      if (out > 0.01) {
        // 拉出来的那层：露出抽屉的侧壁、垫在里面的黑胶垫，还有几根从缝里能看到的钢棒（批头、冲子之类）
        k.box('steel_dark', LEN - 0.07, h - 0.02, out, CX, cy, HZ + out / 2, { plain: true, tint: 0.4 });
        k.box('rubber', LEN - 0.08, 0.004, out, CX, cy + h / 2 - 0.012, HZ + out / 2, { plain: true, tint: 0.5 });
        for (let j = 0; j < 4; j++) k.tube('aluminium', [CX - 0.25 + j * 0.15, cy + h / 2 - 0.016, HZ + 0.008], [CX - 0.23 + j * 0.15, cy + h / 2 - 0.014, HZ + out - 0.012], 0.007, { seg: 5, cap: true, tint: 0.75 });
      }
      top -= h;
    });
    k.cyl('aluminium', 0.011, 0.008, CX + LEN / 2 - 0.06, Y1 - 0.016, HZ + 0.004, { axis: 'z', seg: 8, tint: 0.75 }); // 锁芯
    // 台面：一张橡胶垫，后面和两头有挡边，东西不会滚下去
    k.box('rubber', LEN - 0.04, 0.006, HZ * 2 - 0.04, CX, Y1 + 0.003, 0, { plain: true, tint: 0.9 });
    k.box(body, LEN, 0.03, 0.014, CX, Y1 + 0.013, -HZ + 0.007, { c: 0.004, tint: shade(0.95) });
    for (const s of [1, -1]) k.box(body, 0.014, 0.03, HZ * 2, CX + s * (LEN / 2 - 0.007), Y1 + 0.013, 0, { c: 0.004, tint: shade(0.95) });
    // 推手：一根弯成 U 形的铝管
    k.hose('aluminium', [[CX - LEN / 2, 0.56, -0.17], [-0.41, 0.6, -0.17], [-0.435, 0.73, -0.17], [-0.435, 0.73, 0.17], [-0.41, 0.6, 0.17], [CX - LEN / 2, 0.56, 0.17]], 0.012, { seg: 6, steps: 20, tint: 0.85 });
    // 脚轮：推手那头两只是定向的，另一头两只万向（随机朝向）
    for (const sx of [1, -1]) for (const sz of [1, -1]) k.at([CX + sx * (LEN / 2 - 0.07), 0, sz * (HZ - 0.06)], [0, sx > 0 ? k.rng() * 6 : 0, 0], () => caster(k, 0.05, 0.119));
    k.label(o.label ?? `检修 ${1 + (seed % 2)}`, { color: 'white', font: 'stencil', distress: 0.4 }, 0.3, 0.07, [CX + LEN / 2 + 0.002, 0.6, 0], [0, HALF, 0]);
    k.decal('logo_d', 0.3, [CX + LEN / 2 + 0.002, 0.42, 0], [0, HALF, 0]);
    k.decal('grime_streak', 0.3, [CX, 0.45, -HZ - 0.002], [0, PI, 0], 0.6);

    // ---- 台面上的东西
    // 工具都是亮钢。材质表里有专门的"拉丝钢"，但它和拉手用的铝是同一种质感、只差一点颜色，
    // 所以这里直接用铝、压暗一成：整辆车少一种材质，就少一次绘制调用。
    const TOOL = 'aluminium', DESK = Y1 + 0.006;
    k.at([CX - 0.18, DESK, 0.08], [0, 0.5, 0], () => { // 梅花开口两用扳手：一头是整圈，一头缺个口
      k.box(TOOL, 0.2, 0.006, 0.02, 0, 0.004, 0, { c: 0.002, tint: 0.9 });
      k.torus(TOOL, 0.016, 0.006, 0.11, 0.005, 0, { axis: 'y', tubeSeg: 4, seg: 10, tint: 0.9 });
      k.add(TOOL, new THREE.TorusGeometry(0.017, 0.006, 4, 7, PI * 1.4), { tint: 0.9 }, xf([-0.112, 0.005, 0], [HALF, 0, 2.2]));
    });
    k.at([CX + 0.02, DESK, -0.1], [0, -0.3, 0], () => { // 小锤：木柄 + 钢锤头
      k.tube('wood_pallet', [-0.14, 0.014, 0], [0.12, 0.016, 0], 0.012, { r2: 0.01, seg: 6, cap: true, tint: 0.9 });
      k.box('steel_dark', 0.032, 0.03, 0.1, 0.125, 0.017, 0.005, { c: 0.006, tint: 0.8 });
    });
    k.at([CX + 0.2, DESK, 0.1], [0, 0.12, 0], () => { // 一排 6 个套筒，从小到大插在黑色的卡条上
      k.box('rubber', 0.22, 0.014, 0.05, 0, 0.007, 0, { c: 0.004, tint: 1.6 });
      for (let i = 0; i < 6; i++) k.cyl(TOOL, 0.008 + i * 0.0014, 0.03, -0.085 + i * 0.034, 0.029, 0, { seg: 8, tint: 0.9 });
    });
    // 一罐蓝色喷剂：罐身、收口的肩、红色喷头
    k.cyl('plastic_blue', 0.032, 0.13, CX + 0.28, DESK + 0.065, -0.12, { seg: 12, tint: 0.9 });
    k.lathe(TOOL, [[0.032, 0], [0.028, 0.012], [0.014, 0.018], [0.014, 0.018], [0.014, 0.03], [0, 0.03]], CX + 0.28, DESK + 0.13, -0.12, { seg: 10, tint: 0.9 });
    k.cyl('paint_red', 0.012, 0.014, CX + 0.28, DESK + 0.165, -0.12, { seg: 8, tint: 0.95 }); // 喷头。默认的红柜体用的就是这种红漆，不为这一小粒多带一种材质
    // 黄柄螺丝刀
    k.tube('paint_yellow', [CX - 0.3, DESK + 0.012, -0.13], [CX - 0.2, DESK + 0.012, -0.16], 0.014, { seg: 7, cap: true, tint: 0.9 });
    k.tube(TOOL, [CX - 0.2, DESK + 0.012, -0.16], [CX - 0.08, DESK + 0.01, -0.196], 0.004, { seg: 5, cap: true, tint: 0.9 });
    // 一块揉皱的红抹布：一块分了格的薄板，顶面按噪声拱起褶子，边缘再左右扯歪一点
    const rag = new THREE.BoxGeometry(0.16, 0.012, 0.12, 6, 1, 5), rp = rag.getAttribute('position'), wrinkle = k.rng() * 9;
    for (let i = 0; i < rp.count; i++) {
      const x = rp.getX(i), y = rp.getY(i), z = rp.getZ(i);
      rp.setXYZ(i, x + 0.014 * (noise3(z * 20, wrinkle, 0) - 0.5), y + (y > 0 ? 0.03 * noise3(x * 26 + wrinkle, z * 26, 0) : 0), z + 0.01 * (noise3(x * 20, wrinkle + 3, 0) - 0.5));
    }
    rag.computeVertexNormals();
    // 抹布的颜色不在材质表里：借手套布的质感，把颜色换成暗红。多出一个材质，但全场只有这一小块
    k.add(surface('glove_fabric', { vertexColors: true, interior: o.interior, color: 0x7d2b24 }), rag, { tint: 0.9 }, xf([CX - 0.25, DESK + 0.006, 0.115], [0, 0.8, 0]));

    return k.finish({ size: [0.9, 0.95, 0.5], boxes: [{ min: [-0.45, 0, -0.25], max: [0.45, 0.95, 0.25] }], surface: 'metal' });
  });
}

// ================================================================ 气瓶架
/**
 * 弯贴片：把一块字或贴纸裹在圆柱面上（平的贴片贴在气瓶上会翘出去两个角）。
 * 在自己的坐标里，贴片的中心朝 +z，离轴线 radius 远；m 再把它摆到圆柱上。
 *   wrap = 'u'：圆柱竖着（轴是 y），贴片的"左右"方向绕着圆柱走。arc 是绕过去的弧长（贴片的宽），len 是贴片的高。气瓶上的字。
 *   wrap = 'v'：圆柱横着（轴是 x），贴片的"上下"方向绕着圆柱走。arc 是贴片的高，len 是贴片的宽。钢管上顺着管子喷的一长行字。
 */
function curvedPatch(k: Kit, p: Patch, radius: number, arc: number, len: number, m: THREE.Matrix4, wrap: 'u' | 'v' = 'u', seg = 4) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const [u0, v0, u1, v1] = p.uv;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, a = (t - 0.5) * (arc / radius), s = Math.sin(a), c = Math.cos(a);
    if (wrap === 'u') {
      pos.push(radius * s, -len / 2, radius * c, radius * s, len / 2, radius * c);
      nor.push(s, 0, c, s, 0, c);
      const u = u0 + (u1 - u0) * t;
      uv.push(u, v0, u, v1);
    } else {
      pos.push(-len / 2, radius * s, radius * c, len / 2, radius * s, radius * c);
      nor.push(0, s, c, 0, s, c);
      const v = v0 + (v1 - v0) * t;
      uv.push(u0, v, u1, v);
    }
  }
  // 每一小段是一个四边形，拆成两个三角形；顶点顺序保证从圆柱外面看是逆时针（正面朝外）
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    if (wrap === 'u') idx.push(a, a + 2, a + 3, a, a + 3, a + 1); else idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  k.add(labelMaterial(), g, { raw: true, cast: false }, m);
}

/**
 * 气瓶架 0.9 × 1.6 × 0.5：花纹钢板底座 + 背后的钢架，三只气瓶并排站着，前面拦一条防倒链。
 * 气瓶的瓶身和瓶肩是两种颜色（工业气瓶靠瓶肩的颜色区分里面是什么气）。
 */
export function gasCylinders(o: EquipOpts = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('gas_cylinders', [seed, o.interior], () => {
    const k = new Kit('gas_cylinders', seed, { interior: o.interior });
    const SEG = 12, R = 0.115, PITCH = 0.272; // 车削的段数、瓶身半径、相邻两只瓶的间距
    const frame = () => k.range(0.6, 0.9);    // 钢架每根杆的明暗都随机一点
    k.box('diamond_plate', 0.9, 0.016, 0.5, 0, 0.008, 0, { c: 0.004, tint: 0.8 });
    for (const x of [-0.43, 0.43]) {
      k.box('steel_dark', 0.04, 1.14, 0.04, x, 0.585, -0.225, { c: 0.005, tint: frame() });  // 后立柱
      k.box('steel_dark', 0.036, 0.036, 0.43, x, 1.06, -0.01, { c: 0.005, tint: frame() });  // 上扶手
      k.box('steel_dark', 0.036, 0.036, 0.43, x, 0.3, -0.01, { c: 0.005, tint: frame() });   // 下扶手
      k.box('steel_dark', 0.036, 0.32, 0.036, x, 0.16, 0.19, { c: 0.005, tint: frame() });   // 前面的短柱
      k.torus('steel_galv', 0.016, 0.004, x, 1.06, 0.215, { axis: 'x', tubeSeg: 4, seg: 8, tint: 0.8 }); // 挂链子的环
    }
    for (const y of [0.45, 1.06]) k.box('steel_dark', 0.9, 0.04, 0.036, 0, y, -0.225, { c: 0.005, tint: frame() });
    k.box('paint_yellow', 0.3, 0.2, 0.004, 0, 0.76, -0.245, { c: 0.001, tint: 0.9 });        // 背面一块黄牌
    k.decal('hazard_flammable', 0.15, [0, 0.76, -0.2475], [0, PI, 0]);

    const shoulders: [SurfaceName, number][] = [['paint_red', 1], ['paint_white', 1], ['paint_blue', 1], ['paint_yellow', 1], ['paint_grey', 0.5]];
    const bodies: [SurfaceName, Rgb][] = [['paint_grey', [0.75, 0.75, 0.75]], ['paint_grey', [0.55, 0.55, 0.55]], ['paint_red', [0.55, 0.4, 0.4]], ['paint_blue', [0.8, 0.8, 0.8]]];
    const gases = ['乙炔', '氧气', '氩气', '丙烷'];
    for (let i = 0; i < 3; i++) {
      const cx = (i - 1) * PITCH, cz = 0.015 + k.range(-0.01, 0.01), base = 0.016; // 瓶子站在底板上
      const tall = 1 - k.range(0, 0.05);                                           // 三只瓶高矮差一点点
      const [capMat, capShade] = shoulders[(seed + i * 2) % shoulders.length];
      const [bodyMat, bodyShade] = bodies[(seed + i) % bodies.length];
      const scratch = i * 5.3 + seed;
      const up = (prof: [number, number][]): [number, number][] => prof.map(([r, y]) => [r, y * tall]);
      // 瓶身。轮廓中间多写了两个点（0.4、0.8 米处），不是为了形状，是为了那里有顶点 —— 竖向的划痕是按顶点染色的
      k.lathe(bodyMat, up([[0, 0.012], [0.095, 0.012], [0.095, 0.012], [0.1, 0], [0.111, 0], [R, 0.008], [R, 0.4], [R, 0.8], [R, 1.22]]), cx, base, cz, {
        seg: SEG,
        tint: (x, y, z) => {
          // 绕着瓶子转一圈取噪声：噪声大的那几个方向是一道道竖着的划痕（搬运时瓶子互相蹭的），发暗发黄
          const worn = noise3(Math.atan2(z - cz, x - cx) * 3 + scratch, y * 5, 0) > 0.7;
          return worn ? [bodyShade[0] * 0.55, bodyShade[1] * 0.55 * 0.85, bodyShade[2] * 0.55 * 0.7] : bodyShade;
        },
      });
      k.lathe(capMat, up([[R, 1.22], [0.111, 1.285], [0.098, 1.34], [0.075, 1.385], [0.052, 1.41], [0.04, 1.42]]), cx, base, cz, { seg: SEG, tint: capShade }); // 瓶肩
      // 瓶帽：罩住阀门的钢帽，两侧各一个通气孔（画成两个小黑点）
      k.lathe('steel_dark', up([[0.04, 1.42], [0.057, 1.42], [0.057, 1.42], [0.057, 1.448], [0.057, 1.448], [0.05, 1.452], [0.053, 1.53], [0.046, 1.565], [0.026, 1.585], [0, 1.588]]), cx, base, cz, { seg: SEG, tint: 0.8 });
      const spin = k.rng() * 6;
      for (const a of [spin, spin + PI]) k.cyl('steel_dark', 0.016, 0.004, cx + Math.cos(a) * 0.052, base + 1.5 * tall, cz + Math.sin(a) * 0.052, { seg: 6, rot: [0, -a, HALF], tint: 0.12 });
      // 贴在瓶身上的危险品标和气体名，各自随机歪一点（没有人会把三只瓶子都摆成标签朝正前）
      if (i !== 1) curvedPatch(k, decalPatch(i ? 'hazard_general' : 'hazard_flammable'), R + 0.0015, 0.1, 0.1, xf([cx, base + 1.08 * tall, cz], [0, k.range(-0.5, 0.5), 0]));
      const name = labelPatch(gases[(seed + i) % 4], { color: 'white', font: 'stencil', distress: 0.4 });
      curvedPatch(k, name, R + 0.0015, 0.2, 0.2 / name.aspect, xf([cx, base + 0.86 * tall, cz], [0, k.range(-0.4, 0.4), 0]));
    }
    // 防倒链：19 个小环，一平一竖交替，横拦在瓶子前面。链子贴着瓶身的弧面走，两只瓶子之间往下垂一点
    const frontZ = (x: number) => {
      let z = 0.215; // 两头挂在架子的环上
      for (let i = -1; i <= 1; i++) {
        const d = x - i * PITCH;
        if (Math.abs(d) < R) z = Math.max(z, 0.015 + Math.sqrt(Math.max(0, 0.123 * 0.123 - d * d))); // 瓶身前表面（半径留 8 毫米余量）
      }
      return z;
    };
    const LINKS = 19;
    for (let i = 0; i < LINKS; i++) {
      const t = i / (LINKS - 1), x = -0.425 + 0.85 * t;
      const z = Math.max(frontZ(x), frontZ(x - 0.03), frontZ(x + 0.03)) + 0.004;
      const y = 1.05 - 0.035 * Math.sin(PI * ((t * 3) % 1)) - 0.01; // 分三段，每段中间垂下去 3.5 厘米
      const link = new THREE.TorusGeometry(0.017, 0.0045, 3, 6);
      link.scale(1.35, 1, 1); // 链环是长圆的
      k.add('steel_galv', link, { tint: k.range(0.6, 0.95) }, xf([x, y, z], [i % 2 ? HALF : 0.15, 0, 0]));
    }
    return k.finish({ size: [0.9, 1.6, 0.5], boxes: [{ min: [-0.45, 0, -0.25], max: [0.45, 1.6, 0.25] }], surface: 'metal' });
  });
}

// ================================================================ 钢管堆
/** 平滑的 0→1 过渡：v 从 a 走到 b 的过程中，结果从 0 缓缓升到 1。调用处保证 a ≠ b。 */
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** 空心管的内壁：一个法线朝里的圆筒（沿 x 轴）。两个管口各一圈顶点，往里 deep 米处再各一圈，好让颜色从管口到深处渐渐变黑。 */
function boreGeometry(r: number, len: number, seg: number, deep: number) {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 3, true);
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), idx = g.getIndex()!;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (Math.abs(y) < len / 2 - 1e-4) p.setY(i, Math.sign(y) * (len / 2 - deep)); // 中间两圈挪到离管口 deep 的地方
    n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));                               // 法线翻向里面
  }
  const arr = idx.array;
  for (let i = 0; i < arr.length; i += 3) { const t = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t; } // 三角形也翻个面，不然从管口看进去是透的
  return g.rotateZ(-HALF);
}

/**
 * 一垛钢管 6 × 0.9 × 1.2：三根枕木上，9 根外径 273 毫米的钢管按 4-3-2 码成金字塔，两道钢带箍住。
 * 管子是真的空心：从管口能看进去，越往里越黑。
 */
export function pipeStack(o: EquipOpts = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('pipe_stack', [seed, o.interior], () => {
    const k = new Kit('pipe_stack', seed, { interior: o.interior });
    const R = 0.1365, WALL = 0.012, SLEEPER = 0.08, SEG = 14; // 管子外半径、壁厚、枕木高、圆周段数
    const wood = (m = 1): Rgb => { const v = k.range(0.6, 0.95) * m; return [v, v * 0.95, v * 0.86]; }; // 每块木头深浅不同，略偏黄
    for (const x of [-2.2, 0, 2.2]) {
      k.box('wood_dark', 0.11, SLEEPER, 1.2, x + k.range(-0.1, 0.1), SLEEPER / 2, 0, { c: 0.008, rot: [0, k.range(-0.03, 0.03), 0], tint: wood(), grain: 'z' });
      // 两头各一个三角木楔，挡住最外面那根管子不让它滚下去。三角形画在 (z, y) 平面里，斜面朝着管子
      for (const s of [1, -1]) {
        const tri: [number, number][] = s > 0 ? [[0, 0], [0.158, 0], [0.158, 0.1]] : [[-0.158, 0], [0, 0], [-0.158, 0.1]];
        k.extrude('wood_pallet', tri, 0.1, { pos: [x, SLEEPER, s * 0.44], rot: [0, -HALF, 0], soft: 0, tint: wood(0.9) });
      }
    }
    // 圆管码垛：上一层的管子落在下一层两根管子之间的凹槽里，三个圆心正好是等边三角形，所以层高 = 直径 × sin60°
    const rise = 2 * R * Math.sin(PI / 3);
    [4, 3, 2].forEach((count, row) => {
      for (let i = 0; i < count; i++) {
        const z = (i - (count - 1) / 2) * 2 * R, y = SLEEPER + R + row * rise;
        const len = k.range(5.78, 5.92);
        const cx = Math.max(-3, Math.min(3 - len, k.range(-3, 3 - len))) + len / 2; // 长短不一、前后错开，但不超出 6 米
        const mat: SurfaceName = k.rng() < 0.7 ? 'steel_rust' : 'steel_dark';
        const patch = k.rng() * 50, shade = k.range(0.75, 1);
        const outer = new THREE.CylinderGeometry(R, R, len, SEG, 4, true).rotateZ(-HALF); // 沿长度分 4 段，颜色才能一段深一段浅
        k.add(mat, outer, { tint: (x, yy, zz) => shade * (0.75 + 0.35 * noise3(x * 1.3 + patch, zz * 9, yy * 9)) }, xf([cx, y, z]));
        // 内壁：管口处 0.66，往里 0.9 米就暗到 0.16
        k.add('steel_rust', boreGeometry(R - WALL, len - 0.002, SEG, 0.9), { tint: (x) => 0.16 + 0.5 * smooth(len / 2 - 0.9, len / 2, Math.abs(x - cx)) }, xf([cx, y, z]));
        // 两端的管口端面：一圈窄环，把外壁和内壁接起来
        k.lathe(mat, [[R, 0], [R - WALL, 0]], cx + len / 2, y, z, { axis: 'x', seg: SEG, tint: shade * 1.1 });
        k.lathe(mat, [[R - WALL, 0], [R, 0]], cx - len / 2, y, z, { axis: 'x', seg: SEG, tint: shade * 1.1 });
      }
    });
    // 两道钢带：沿着金字塔的外轮廓箍一圈（从最外侧管子的腰 → 顶层管子的肩 → 顶 → 另一边下来 → 从管子底下兜回去）
    const D = 2 * R, top = SLEEPER + R + 2 * rise + R + 0.004;
    const hoop: [number, number][] = [
      [-(1.5 * D + R + 0.004), SLEEPER + R], [-(0.5 * D + R * 0.5 + 0.004), SLEEPER + R + 2 * rise + R * 0.87], [-0.5 * D, top], [0.5 * D, top],
      [0.5 * D + R * 0.5 + 0.004, SLEEPER + R + 2 * rise + R * 0.87], [1.5 * D + R + 0.004, SLEEPER + R], [1.5 * D, SLEEPER - 0.004], [-1.5 * D, SLEEPER - 0.004], [-(1.5 * D + R + 0.004), SLEEPER + R],
    ];
    for (const x of [-1.35, 1.5]) {
      k.strip('steel_dark', hoop.map(([z, y]): V3 => [x, y, z]), [0.016, 0, 0], { tint: 0.7, cast: true });
      k.box('steel_galv', 0.04, 0.012, 0.05, x, top + 0.005, 0.03, { c: 0.003, tint: 0.8 }); // 钢带的锁扣
    }
    // 顶层靠 +z 的那根管子上喷着规格。字顺着管子走，1.6 米长；贴片沿"字高"的方向弯，裹在管壁上。
    // （参考里把这张贴片横竖弄反了，字被压成一条细线，这里按正常的喷法做）
    const spec = labelPatch('API 5L X52  273.1 x 12.5  HEAT 40719', { color: 'white', font: 'stencil', distress: 0.5 });
    curvedPatch(k, spec, R + 0.002, 1.6 / spec.aspect, 1.6, xf([0.9, SLEEPER + R + 2 * rise, R], [-0.75, 0, 0]), 'v');
    return k.finish({ size: [6, 0.9, 1.2], boxes: [{ min: [-3, 0, -0.6], max: [3, 0.9, 0.6] }], surface: 'metal' });
  });
}

// ================================================================ 现搭的小物件
/**
 * 轮挡：塞在车轮后面防溜车的橡胶楔子，0.32 × 0.19 × 0.2。斜面朝 +x（车轮在那一边），背面贴一片黄色反光板。
 * 没有碰撞：这么小的东西挡住人只会让人觉得"被空气绊了一下"。
 */
export function wheelChock(o: EquipOpts = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('wheel_chock', [seed, o.interior], () => {
    const k = new Kit('wheel_chock', seed, { interior: o.interior });
    k.extrude('rubber', [[-0.16, 0], [0.16, 0], [0.16, 0.05], [-0.1, 0.19], [-0.16, 0.19]], 0.2, { soft: 0, tint: k.range(0.85, 1) });
    k.box('paint_yellow', 0.012, 0.16, 0.18, -0.166, 0.1, 0, { plain: true });
    // 斜面上三道防滑棱（参考里没有，加上以后斜面不再是一块光板；一共多 36 个三角形）
    const tilt = Math.atan2(0.14, 0.26); // 斜面和地面的夹角
    for (const t of [0.25, 0.5, 0.75]) k.box('rubber', 0.014, 0.008, 0.2, -0.1 + 0.26 * t + 0.002, 0.19 - 0.14 * t + 0.003, 0, { plain: true, rot: [0, 0, -tilt], tint: 0.7 });
    return k.finish({ size: [0.33, 0.19, 0.2], boxes: [] });
  });
}

/**
 * 钢筋料笼（铁丝网周转箱）2.2 × 1.25 × 1.2：方管骨架 + 四面铁丝网，里面竖着斜插一把细钢筋（会高出笼子一大截），角上堆着几段短管。
 * color 是骨架的漆色，参考里用蓝和橙两种。
 */
export function rebarCage(o: EquipOpts & { color?: PaintColor } = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('rebar_cage', [seed, o.color, o.interior], () => {
    const k = new Kit('rebar_cage', seed, { interior: o.interior });
    const { mat: frame, shade } = paint(o.color, 'blue');
    const L = 2.2, W = 1.2, H = 1.25;
    k.box('steel_dark', L, 0.05, W, 0, 0.13, 0, { plain: true, tint: 0.8 });                                    // 底板
    for (const s of [-1, 1]) k.box(frame, 0.1, 0.1, W, s * (L / 2 - 0.25), 0.05, 0, { plain: true, tint: shade(0.8) }); // 两条底梁，叉车从这里叉
    // 四根角柱。比上圈矮 2 毫米：两个顶面要是一样高，重叠的地方会闪
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(frame, 0.07, H - 0.102, 0.07, sx * (L / 2 - 0.035), 0.1 + (H - 0.102) / 2, sz * (W / 2 - 0.035), { tint: shade(k.range(0.85, 1)) });
    const meshH = H - 0.25, meshY = 0.15 + meshH / 2; // 铁丝网的高和中心高度
    for (const s of [-1, 1]) {
      k.box(frame, L, 0.06, 0.06, 0, H - 0.03, s * (W / 2 - 0.03), { tint: shade(0.95) });   // 上圈（长边）
      k.box(frame, L, 0.05, 0.05, 0, 0.62, s * (W / 2 - 0.03), { plain: true, tint: shade(0.9) }); // 腰圈
      k.plane('chainlink', L - 0.14, meshH, [0, meshY, s * (W / 2 - 0.035)]);
      k.box(frame, 0.06, 0.06, W, s * (L / 2 - 0.03), H - 0.03, 0, { tint: shade(0.95) });   // 上圈（短边）
      k.plane('chainlink', W - 0.14, meshH, [s * (L / 2 - 0.035), meshY, 0], { rot: [0, HALF, 0] });
    }
    // 14 根细钢筋。位置用"乘一个无理数再取小数部分"来排：看起来乱，但不会扎堆，换个 seed 整体挪一挪
    for (let i = 0; i < 14; i++) {
      const u = (i * 0.618 + seed * 0.37) % 1, v = (i * 0.414 + seed * 0.11) % 1, len = 1.5 + v * 0.9;
      k.cyl(i % 3 ? 'steel_worn' : 'steel_rust', 0.014, len, -L / 2 + 0.25 + u * (L - 0.9), 0.16 + (len / 2) * 0.96, -W / 2 + 0.2 + v * (W - 0.4), { seg: 5, rot: [0.1 * (v - 0.5), 0, 0.28 * (u - 0.3)], tint: k.range(0.8, 1) });
    }
    for (let i = 0; i < 6; i++) { // 6 段短管，横七竖八堆在 +x 那头
      const u = (i * 0.37 + seed * 0.2) % 1;
      k.cyl('steel_rust', 0.035, 0.42, L / 2 - 0.45 + (u - 0.5) * 0.3, 0.22 + i * 0.05, (u - 0.5) * 0.7, { seg: 6, rot: [HALF + u, u * 3, 0.2], tint: k.range(0.7, 1) });
    }
    return k.finish({ size: [L, H, W], boxes: [{ min: [-L / 2, 0, -W / 2], max: [L / 2, H, W / 2] }], surface: 'metal' });
  });
}

/** 废料斗 1.1 × 0.75 × 0.8：敞口的铁箱子，装着半箱切下来的边角铁块。color 是箱体漆色，参考里用红和蓝。 */
export function scrapBin(o: EquipOpts & { color?: PaintColor } = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('scrap_bin', [seed, o.color, o.interior], () => {
    const k = new Kit('scrap_bin', seed, { interior: o.interior });
    const { mat: body, shade } = paint(o.color, 'red');
    const L = 1.1, W = 0.8, H = 0.75;
    for (const s of [-1, 1]) k.box(body, 0.09, 0.1, W, s * 0.36, 0.05, 0, { plain: true, tint: shade(0.8) });
    k.box(body, L, 0.04, W, 0, 0.12, 0, { plain: true, tint: shade(0.85) });
    for (const s of [-1, 1]) {
      k.box(body, L, H - 0.1, 0.03, 0, 0.1 + (H - 0.1) / 2, s * (W / 2 - 0.015), { c: 0.006, tint: shade(k.range(0.88, 1)) });
      k.box(body, 0.03, H - 0.1, W, s * (L / 2 - 0.015), 0.1 + (H - 0.1) / 2, 0, { c: 0.006, tint: shade(k.range(0.88, 1)) });
    }
    // 四根角柱比箱壁高出 4 毫米，免得顶面叠在一起闪
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(body, 0.06, H + 0.004, 0.06, sx * (L / 2 - 0.02), (H + 0.004) / 2, sz * (W / 2 - 0.02), { c: 0.01, tint: shade(0.9) });
    // 里面：一层很暗的"料面"封住箱口往下 0.2 米处，上面乱放 12 块铁疙瘩。这样不用真的装满一箱，从上面看也是满的
    k.box('steel_dark', L - 0.08, 0.04, W - 0.08, 0, H - 0.22, 0, { plain: true, tint: 0.5 });
    // 铁块的位置：第 i 块取 (i × 0.7549, i × 0.5698) 的小数部分。这两个数是专门挑的（"R2 序列"）——
    // 这样排出来的点在方形里铺得很匀，既不扎堆也不成行成列，比真随机好看，而且换个 seed 只是整体平移。
    // （参考用的是 0.618 和 0.37，12 块铁会排成一条斜线，一眼就看出是算出来的。）
    for (let i = 0; i < 12; i++) {
      const u = (i * 0.7549 + seed * 0.29) % 1, v = (i * 0.5698 + seed * 0.13) % 1;
      k.box('steel_worn', 0.16, 0.11, 0.1, (u - 0.5) * (L - 0.3), H - 0.16 + (i % 3) * 0.03, (v - 0.5) * (W - 0.25), { c: 0.012, rot: [v, u * 3, u], tint: k.range(0.6, 1) });
    }
    return k.finish({ size: [L, H, W], boxes: [{ min: [-L / 2, 0, -W / 2], max: [L / 2, H, W / 2] }], surface: 'metal' });
  });
}

/**
 * 地上的一捆钢筋：两根枕木上横着 count 根（默认 9 根）3.4 米多长的螺纹钢，码成两层，锈的和磨亮的相间。
 * 没有碰撞：只有十几厘米高，人直接踩过去。
 */
export function rebarBundle(o: EquipOpts & { count?: number } = {}): PropModel {
  const seed = o.seed ?? 0, count = Math.max(3, Math.min(14, Math.round(o.count ?? 9)));
  return cached('rebar_bundle', [seed, count, o.interior], () => {
    const k = new Kit('rebar_bundle', seed, { interior: o.interior });
    for (const x of [-1.1, 1.1]) k.box('wood_dark', 0.1, 0.08, 0.7, x, 0.04, 0, { c: 0.008, tint: k.range(0.7, 0.95), grain: 'z' });
    const lower = Math.ceil(count / 2); // 下层的根数；剩下的放上层，落在下层的缝里
    for (let i = 0; i < count; i++) {
      const up = i < lower ? 0 : 1, j = up ? i - lower : i, n = up ? count - lower : lower;
      // 每根长短差一点、头尾错开一点、还带一丝偏角 —— 一捆钢筋从来不是整整齐齐的
      k.cyl(i % 2 ? 'steel_worn' : 'steel_rust', 0.016, 3.4 + (i % 3) * 0.12, ((i % 3) - 1) * 0.06, 0.1 + up * 0.03, (j - (n - 1) / 2) * 0.045 + up * 0.02, { seg: 5, rot: [0, 0.01 * (i - 4), HALF], tint: k.range(0.75, 1) });
    }
    for (let i = 0; i < count; i += 3) k.box('steel_rust', 0.07, 0.05, 0.03, 1.72, 0.11, (i - 4) * 0.02, { plain: true, tint: 0.8 }); // 一端的几个锈疙瘩：扎丝头
    return k.finish({ size: [3.7, 0.15, 0.7], boxes: [] });
  });
}

/**
 * 码头上的大钢板垛（舱盖板）：每块 10.4 × 0.5 × 4.2 米，layers 层摞在一起（默认 2，最多 6），层与层之间垫着木方。
 * 长边沿 x。它是全场最大的"道具"，顶面可以站人，整垛一个碰撞盒。
 */
export function steelPlateStack(o: EquipOpts & { layers?: number } = {}): PropModel {
  const seed = o.seed ?? 0, layers = Math.max(1, Math.min(6, Math.round(o.layers ?? 2)));
  return cached('steel_plate_stack', [seed, layers, o.interior], () => {
    const k = new Kit('steel_plate_stack', seed, { interior: o.interior });
    const L = 10.4, W = 4.2, T = 0.5, GAP = 0.1; // 长、宽、每块的厚度、层间垫木的高度
    const coats: SurfaceName[] = ['paint_grey', 'paint_teal', 'paint_grey', 'steel_rust']; // 一层一个颜色，隔几层有一块没上漆的锈板
    for (let i = 0; i < layers; i++) {
      // 上面的每一层都错开一点、歪一点：吊车放下来的东西不可能对得严丝合缝
      const dx = i ? 0.18 * Math.cos(i * 1.7 + seed) : 0, dz = i ? 0.12 * Math.sin(i * 2.1 + seed) : 0;
      const yaw = 0.02 * (i % 2 ? -1 : 1.3);
      const y0 = GAP + i * (T + GAP); // 这一层钢箱体的底面
      const coat = coats[(i + seed) % coats.length];
      k.at([dx, 0, dz], [0, yaw, 0], () => {
        for (const x of [-3.6, 0, 3.6]) k.box('wood_dark', 0.14, GAP, W - 0.2, x, y0 - GAP / 2, 0, { c: 0.01, tint: k.range(0.7, 0.95), grain: 'z' });
        k.box(coat, L, T - 0.08, W, 0, y0 + (T - 0.08) / 2, 0, { c: 0.03, tint: k.range(0.9, 1) });           // 箱体
        k.box(coat, L - 0.5, 0.08, W - 0.5, 0, y0 + T - 0.04, 0, { c: 0.02, tint: k.range(0.85, 0.95) });      // 顶上收进去一圈的盖板
        for (const z of [-1.4, -0.7, 0, 0.7, 1.4]) k.box(coat, L - 0.9, 0.05, 0.09, 0, y0 + T + 0.02, z, { c: 0.01, tint: k.range(0.8, 0.95) }); // 5 道加强筋
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          k.box('steel_dark', 0.32, 0.12, 0.32, sx * (L / 2 - 0.35), y0 + T - 0.02, sz * (W / 2 - 0.35), { c: 0.02, tint: 0.8 }); // 四个角件（吊点）
          k.box('paint_yellow', 0.5, T - 0.1, 0.02, sx * (L / 2 - 0.5), y0 + (T - 0.08) / 2, sz * (W / 2 + 0.006), { plain: true }); // 侧面的黄色吊点标记
        }
        for (const sx of [-1, 1]) k.box('rubber', 0.04, 0.12, W - 0.4, sx * (L / 2 + 0.01), y0 + 0.1, 0, { plain: true }); // 两端的橡胶密封条
      });
    }
    // 碰撞盒的顶面 = 最上面那块板的板面（加强筋再高出 4.5 厘米，脚会陷进去一点，看不出来）。
    // 参考把顶面算到了"再往上一层垫木"的高度，人站上去会悬空 10 厘米，这里改掉了。
    const top = layers * (T + GAP);
    return k.finish({ size: [L, top + 0.045, W], boxes: [{ min: [-L / 2 - 0.05, 0, -W / 2 - 0.05], max: [L / 2 + 0.05, top, W / 2 + 0.05] }], surface: 'metal' });
  });
}

/**
 * 配电箱 0.7 × 1.05 × 0.5：水泥墩上一只灰铁箱，顶上一片挡雨檐，正面（+z）一条黄黑警示条。
 * 参考里只有这四个盒子。这里多加了箱门、把手、两个铰链、高压警示贴和一行编号（共约 130 个三角形），
 * 因为它总是摆在中继旁边，玩家会走到跟前看。
 */
export function distributionBox(o: EquipOpts = {}): PropModel {
  const seed = o.seed ?? 0;
  return cached('distribution_box', [seed, o.interior], () => {
    const k = new Kit('distribution_box', seed, { interior: o.interior });
    k.box('concrete', 0.7, 0.12, 0.5, 0, 0.06, 0, { c: 0.015 });
    k.box('paint_grey', 0.55, 0.9, 0.3, 0, 0.57, 0, { c: 0.015 });
    k.box('steel_dark', 0.5, 0.03, 0.34, 0, 1.03, 0, { c: 0.004 });
    k.box('paint_grey', 0.47, 0.8, 0.006, 0, 0.56, 0.152, { c: 0.003, tint: k.range(0.86, 0.96) });   // 箱门，比箱体凸出 5 毫米
    k.box('hazard_stripes', 0.3, 0.12, 0.01, 0, 0.8, 0.156, { plain: true });
    k.box('steel_dark', 0.02, 0.09, 0.016, 0.19, 0.55, 0.163, { plain: true, tint: 0.6 });            // 把手
    for (const y of [0.3, 0.84]) k.cyl('steel_dark', 0.008, 0.05, -0.243, y, 0.155, { seg: 6, tint: 1.3 }); // 铰链
    k.decal('hazard_voltage', 0.11, [0, 0.6, 0.1565]);
    k.label(`配电 P-0${1 + (seed % 4)}`, { color: 'white', font: 'stencil', distress: 0.4 }, 0.26, 0.05, [0, 0.42, 0.1565]);
    return k.finish({ size: [0.7, 1.05, 0.5], boxes: [{ min: [-0.35, 0, -0.25], max: [0.35, 1.05, 0.25] }], surface: 'metal' });
  });
}

/** 电缆路径上的一个点：[x, z] 表示贴在地上；[x, z, y] 表示这一点的高度是 y（比如从桌上垂下来的那一头）。 */
export type CablePoint = [number, number] | [number, number, number];
/**
 * 地上的电缆：沿着给定的点铺一根贴地的圆管。
 * 直着从 A 拉到 B 的电缆看起来像一根棍子，所以两点之间超过 2.2 米时，每隔 1.6 米左右自动加一个往左或往右摆的点，
 * 电缆就成了弯弯曲曲躺在地上的样子。摆多少由 sin 算出来：同一条路径每次得到同样的弯。
 *
 * 路径点就是模型自己的坐标，不会挪到"占地中心"。所以最省事的用法是把它摆在 (0, 0)、不转，路径点直接写世界坐标。
 * 没有碰撞，也不投影子。
 */
export function groundCable(o: EquipOpts & { points?: CablePoint[]; r?: number; surface?: SurfaceName } = {}): PropModel {
  const seed = o.seed ?? 0, r = o.r ?? 0.025, mat = o.surface ?? 'rubber';
  const points = o.points && o.points.length >= 2 ? o.points : ([[-1.6, -0.2], [0, 0.25], [1.6, -0.1]] as CablePoint[]);
  return cached('ground_cable', [seed, r, mat, points, o.interior], () => {
    const k = new Kit('ground_cable', seed, { interior: o.interior });
    const lay = r * 0.9; // 圆管中心离地的高度：比半径小一点，让它往地里陷一丝，不会看着像飘着
    const path: V3[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      path.push([a[0], a[2] ?? lay, a[1]]);
      const b = points[i + 1];
      if (!b || a.length > 2 || b.length > 2) continue; // 指定了高度的那一段不加弯：那是悬空的
      const dx = b[0] - a[0], dz = b[1] - a[1], dist = Math.hypot(dx, dz);
      if (dist <= 2.2) continue;
      const n = Math.floor(dist / 1.6);
      for (let j = 1; j < n; j++) {
        const t = j / n, sway = Math.sin((i * 3.1 + j + seed) * 2.3) * Math.min(0.28, dist * 0.04);
        path.push([a[0] + dx * t - (dz / dist) * sway, lay, a[1] + dz * t + (dx / dist) * sway]); // 沿垂直于走向的方向摆出去
      }
    }
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]);
    // 大约每 18 厘米一段；再长的电缆也不超过 380 段（每段 12 个三角形）
    k.hose(mat, path, r, { seg: 6, steps: Math.max(8, Math.min(380, Math.ceil(total / 0.18))), cast: false });
    for (const end of [path[0], path[path.length - 1]]) k.sph(mat, r, end[0], end[1], end[2], { seg: 6, cast: false }); // 两头各堵一个小球，不然能看到管子是空的
    return k.finish({ boxes: [] });
  });
}

// ================================================================ 名字 → 建模函数
/** 按参考道具表里的名字取建模函数。每个函数都只接受一个参数对象，都可以不给。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EQUIPMENT: Record<string, (o?: any) => PropModel> = {
  generator, floodlight_stand: floodlightStand, dumpster, toolbox_cart: toolboxCart, gas_cylinders: gasCylinders, pipe_stack: pipeStack,
  wheel_chock: wheelChock, rebar_cage: rebarCage, scrap_bin: scrapBin, rebar_bundle: rebarBundle, steel_plate_stack: steelPlateStack,
  distribution_box: distributionBox, ground_cable: groundCable,
};
