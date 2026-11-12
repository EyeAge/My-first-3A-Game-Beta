import * as THREE from 'three';

// 统一材质库。
//
// 以前每做一样东西就现写一个材质：木箱一个、油桶一个、隔离墩一个……东西一多，质感就各说各话，
// 想让"所有铁的东西淋了雨都更亮"得改十几处。这里换一个思路，分两层：
//
//   · 质感（SET）  —— 一共二十来种："漆面""镀锌钢""橡胶""木头"……决定表面粗不粗、像不像金属、有什么纹理。
//   · 具名材质（SURFACES）—— 四十来个：每个只是"用哪种质感 + 染什么色 + 淋了雨怎么变 + 大面积上怎么不均匀"几个数。
//     八种颜色的漆共用同一种"漆面"质感。
//
// 建模的代码只写名字：surface('paint_yellow')。同名同选项永远拿到同一个材质实例，
// 这样合并网格时"同一种材质的零件"才能真的并成一次绘制。

/** 淋雨的反应：[变暗多少, 湿了以后粗糙度乘多少, 立面有多湿, 挂不挂水珠]。 */
type Wet = [number, number, number, number];
/** 大面积上的不均匀：[颜色起伏, 光泽起伏, 每米起伏几次, 脏污多少]。 */
type Macro = [number, number, number, number];

/** 染色方式：0 贴图色直接乘颜色；1 只染"漆"的部分（掉漆露出的锈和底漆不跟着染）；2 混凝土上刷漆；3 连透明度一起乘（玻璃、铁丝网）。 */
type TintMode = 0 | 1 | 2 | 3;

export interface SurfaceDef {
  set: SetName; tint: TintMode; color: number;
  /** 乘在质感自带的粗糙度 / 金属度上的倍数。 */
  rough: number; metal: number;
  wet: Wet; macro: Macro;
  /** 凹凸的强弱倍数。 */
  nrm: number;
  transparent?: boolean; alphaCut?: boolean; doubleSide?: boolean;
}

/** 每种质感的"底子"：还没有贴图时先用这两个数顶着（粗糙度、金属度）。 */
const SETS = {
  asphalt: [0.9, 0], concrete: [0.85, 0], brick: [0.9, 0], epoxy: [0.45, 0],
  paint: [0.5, 0.05], hazard: [0.5, 0.05], hull: [0.55, 0.05],
  galv: [0.42, 0.9], metal: [0.5, 0.85], brushed: [0.34, 1], rust: [0.9, 0.25], diamond: [0.45, 0.9], corrugated: [0.45, 0.85],
  chainlink: [0.5, 0.9], gunmetal: [0.42, 0.9], anodized: [0.4, 0.8], polymer: [0.6, 0], carbon: [0.4, 0.2],
  fabric: [0.95, 0], armor: [0.45, 0.35], wood: [0.85, 0], plastic: [0.45, 0], tarp: [0.6, 0], cardboard: [0.9, 0],
  rope: [0.95, 0], tire: [0.85, 0], glass: [0.08, 0], glass_dirty: [0.3, 0], water: [0.05, 0],
} as const satisfies Record<string, readonly [number, number]>;
export type SetName = keyof typeof SETS;

// 几组常用的"淋雨反应"和"不均匀"预设
const W_SOAK: Wet = [0.42, 0.38, 0.5, 0];      // 吸水的：混凝土、砖、绳。变暗明显，不挂水珠
const W_PAINT: Wet = [0.05, 0.62, 0.65, 0.7];  // 漆面：几乎不变暗，挂很多水珠
const W_METAL: Wet = [0, 0.7, 0.55, 0.5];
const W_RUST: Wet = [0.3, 0.6, 0.55, 0];
const W_PLASTIC: Wet = [0.08, 0.62, 0.6, 0.5];
const W_WOOD: Wet = [0.4, 0.5, 0.6, 0];
const W_NONE: Wet = [0, 1, 0, 0];              // 不受雨影响：玻璃、铁丝网
const M_DEF: Macro = [0.14, 0.1, 0.8, 0.2];
const M_BIG: Macro = [0.22, 0.12, 0.35, 0.35]; // 大面积表面：起伏更大、尺度更大
const M_SMALL: Macro = [0.07, 0.06, 3, 0];     // 小零件
const M_OFF: Macro = [0, 0, 1, 0];
const M_FINE: Macro = [0.06, 0.06, 6, 0];

const def = (set: SetName, o: Partial<SurfaceDef> = {}): SurfaceDef => ({ set, tint: 0, color: 0xffffff, rough: 1, metal: 1, wet: W_SOAK, macro: M_DEF, nrm: 1, ...o });
const paint = (color: number) => def('paint', { tint: 1, color, wet: W_PAINT, macro: [0.2, 0.16, 0.4, 0.45] });

// 注意漆色都很暗：阴天清晨的光线下，颜色暗一点，高光才跳得出来，画面才不发灰。
export const SURFACES = {
  asphalt: def('asphalt', { wet: [0.45, 0.3, 0.5, 0], macro: M_BIG }),
  concrete: def('concrete', { macro: M_BIG }),
  concrete_dirty: def('concrete', { color: 0xcfc6b6, macro: [0.3, 0.15, 0.35, 0.9] }),
  concrete_painted: def('concrete', { tint: 2, color: 0x8e9296, rough: 0.9, wet: [0.15, 0.55, 0.6, 0.3], macro: [0.14, 0.1, 0.5, 0.3] }),
  brick: def('brick'),
  floor_epoxy: def('epoxy', { wet: [0.04, 0.75, 0.4, 0], macro: [0.12, 0.2, 0.45, 0.25] }),
  paint_red: paint(0x7d2219), paint_blue: paint(0x1f3f66), paint_green: paint(0x2c5a44), paint_yellow: paint(0xb98a1c),
  paint_orange: paint(0xb3521a), paint_white: paint(0xb9bbb6), paint_grey: paint(0x5a6068), paint_teal: paint(0x1f5d63),
  steel_galv: def('galv', { wet: W_METAL }),
  steel_dark: def('metal', { tint: 1, color: 0x3d4146, rough: 1.15, wet: W_METAL }),
  steel_worn: def('metal', { tint: 1, color: 0x8a8e92, rough: 0.9, wet: W_METAL }),
  steel_bare: def('brushed', { tint: 1, color: 0xb4b8bb, wet: W_METAL, macro: M_SMALL }),
  steel_rust: def('rust', { wet: W_RUST }),
  diamond_plate: def('diamond', { wet: W_METAL }),
  corrugated_roof: def('corrugated', { wet: W_METAL }),
  chainlink: def('chainlink', { tint: 3, wet: W_NONE, macro: M_OFF, alphaCut: true, doubleSide: true }),
  aluminium: def('brushed', { tint: 1, color: 0xc4c8cb, rough: 1.15, wet: W_METAL, macro: M_SMALL }),
  brass: def('brushed', { tint: 1, color: 0xc29a45, rough: 0.9, wet: W_METAL, macro: [0.1, 0.08, 20, 0] }),
  hazard_stripes: def('hazard', { wet: W_PAINT }),
  gunmetal: def('gunmetal', { tint: 1, color: 0x2a2d31, wet: [0, 0.75, 0.6, 0.5], macro: [0.08, 0.06, 6, 0] }),
  anodized_black: def('anodized', { tint: 1, color: 0x121416, rough: 0.72, metal: 0.9, wet: [0, 0.75, 0.6, 0.5], macro: M_FINE }),
  polymer_black: def('polymer', { tint: 1, color: 0x17181a, wet: [0, 0.7, 0.6, 0.5], macro: M_FINE }),
  polymer_tan: def('polymer', { tint: 1, color: 0x6f6048, wet: [0, 0.7, 0.6, 0.5], macro: M_FINE }),
  rubber: def('polymer', { tint: 1, color: 0x101010, rough: 1.4, wet: [0.05, 0.6, 0.6, 0.4], macro: M_FINE }),
  carbon: def('carbon', { wet: [0, 0.8, 0.6, 0.5], macro: [0.05, 0.05, 6, 0] }),
  glove_fabric: def('fabric', { tint: 1, color: 0x23262a, wet: [0.3, 0.7, 0.6, 0], macro: [0.08, 0.04, 8, 0] }),
  armor_white: def('armor', { tint: 1, color: 0xaeb4b8, wet: W_PAINT, macro: [0.08, 0.08, 2.5, 0.15] }),
  armor_orange: def('armor', { tint: 1, color: 0xc1551a, wet: W_PAINT, macro: [0.08, 0.08, 2.5, 0.15] }),
  wood_pallet: def('wood', { wet: W_WOOD, macro: [0.2, 0.1, 0.9, 0.4] }),
  wood_dark: def('wood', { color: 0x8a786a, wet: W_WOOD, macro: [0.2, 0.1, 0.9, 0.4] }),
  plastic_blue: def('plastic', { tint: 1, color: 0x1d4c86, wet: W_PLASTIC }),
  plastic_red: def('plastic', { tint: 1, color: 0x8e1f1a, wet: W_PLASTIC }),
  plastic_grey: def('plastic', { tint: 1, color: 0x4b4f54, wet: W_PLASTIC }),
  tarp: def('tarp', { tint: 1, color: 0x3b4a3a, wet: W_PLASTIC, macro: [0.1, 0.1, 1.2, 0.2] }),
  cardboard: def('cardboard', { wet: [0.4, 0.75, 0.6, 0] }),
  rope: def('rope', { macro: M_SMALL }),
  tire: def('tire', { wet: [0.1, 0.6, 0.6, 0.3], macro: M_SMALL }),
  glass: def('glass', { tint: 3, wet: W_NONE, macro: M_OFF, transparent: true }),
  glass_dirty: def('glass_dirty', { tint: 3, wet: W_NONE, macro: M_OFF, transparent: true }),
  hull_paint: def('hull', { tint: 1, color: 0x1b222b, wet: W_PAINT, macro: M_BIG }),
  hull_red: def('hull', { tint: 1, color: 0x5f1f18, wet: W_PAINT, macro: M_BIG }),
} as const satisfies Record<string, SurfaceDef>;
export type SurfaceName = keyof typeof SURFACES;

/** 质感自带的颜色（还没有贴图时的替身）：不染色的材质（tint 为 0 且颜色是白）就用它。 */
const SET_COLOR: Partial<Record<SetName, number>> = {
  asphalt: 0x2b2c2e, concrete: 0x8b8a84, brick: 0x6e3b2c, epoxy: 0x565d60, galv: 0x9da3a6, rust: 0x5a3220, diamond: 0x7e8387,
  corrugated: 0x8f9598, chainlink: 0x8a8f92, carbon: 0x18191b, wood: 0x8e7350, cardboard: 0x9b7b52, rope: 0x9a8a68, tire: 0x121212,
  glass: 0x9fb4bd, glass_dirty: 0x8a9488, hazard: 0xb98a1c, water: 0x0a1418,
};

export interface SurfaceOpts {
  /** 开顶点色：零件箱搭出来的模型都要开，每个零件的深浅、脏污都写在顶点色里。 */
  vertexColors?: boolean;
  /** 室内的东西：淋不到雨。 */
  interior?: boolean;
  doubleSide?: boolean;
  /** 覆盖材质表里的颜色。 */
  color?: number;
  /** 三平面投影：给没有贴图坐标的蒙皮模型用。scale 是纹理密度倍数。 */
  triplanar?: boolean; scale?: number;
}

/** 全场共用的"有多湿"：1 是正在下雨。 */
export const wetness = { value: 1 };

const cache = new Map<string, THREE.Material>();

/** 取一个具名材质。同名同选项返回同一个实例。 */
export function surface(name: SurfaceName, o: SurfaceOpts = {}): THREE.Material {
  const key = `${name}|${o.vertexColors ? 'v' : ''}|${o.triplanar ? 't' + (o.scale ?? 1) : ''}|${o.doubleSide ? 'd' : ''}|${o.interior ? 'i' : ''}|${o.color !== undefined ? 'c' + o.color : ''}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = make(name, o)));
  return m;
}

function make(name: SurfaceName, o: SurfaceOpts): THREE.Material {
  const d: SurfaceDef = SURFACES[name], [r0, m0] = SETS[d.set];
  const color = o.color ?? (d.tint === 0 && d.color === 0xffffff ? SET_COLOR[d.set] ?? 0xffffff : d.color);
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: Math.min(1, r0 * d.rough), metalness: Math.min(1, m0 * d.metal),
    vertexColors: !!o.vertexColors,
    side: o.doubleSide || d.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: !!d.transparent, opacity: d.transparent ? 0.35 : 1,
  });
  mat.name = name;
  return mat;
}

const glowCache = new Map<string, THREE.MeshBasicMaterial>();
/**
 * 发光体：灯罩、指示灯、屏幕。不受光照影响，颜色直接乘 gain；超过 1 的部分会被泛光晕开。
 * gain 就是"有多亮"：指示灯 3 左右，照明灯具 6–10。
 */
export function emissive(color = 0xffffff, gain = 4): THREE.MeshBasicMaterial {
  const key = `${color}|${gain}`;
  let m = glowCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain) });
    m.name = 'emissive';
    glowCache.set(key, m);
  }
  return m;
}
