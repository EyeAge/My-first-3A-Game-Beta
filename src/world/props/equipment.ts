import * as THREE from 'three';
import { emissive, surface, type SurfaceName } from '../../render/surfaces';
import { Kit, noise3, type PropModel, type Rgb, type V3 } from '../kit';

// 设备与杂物类道具：发电机、三脚投光灯、垃圾箱、工具车。
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

// ================================================================ 名字 → 建模函数
/** 按参考道具表里的名字取建模函数。每个函数都只接受一个参数对象，都可以不给。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EQUIPMENT: Record<string, (o?: any) => PropModel> = {
  generator, floodlight_stand: floodlightStand, dumpster, toolbox_cart: toolboxCart,
};
