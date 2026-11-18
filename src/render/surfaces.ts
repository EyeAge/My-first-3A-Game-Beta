import * as THREE from 'three';
import { loadSettings } from '../core/settings';
import { patchSurfaceShader, type SurfaceUniforms } from './surfpatch';
import { initTexGen, SETS, texGenStats, textureSet, type SetName } from './texgen';

// 统一材质库。
//
// 以前每做一样东西就现写一个材质：木箱一个、油桶一个、隔离墩一个……东西一多，质感就各说各话，
// 想让"所有铁的东西淋了雨都更亮"得改十几处。这里换一个思路，分两层：
//
//   · 质感（贴图集）—— 一共二十来种："漆面""镀锌钢""橡胶""木头"……决定表面粗不粗、像不像金属、有什么纹理。
//     每种质感是三张在显卡上算出来的贴图（texgen.ts）。
//   · 具名材质（SURFACES）—— 四十来个：每个只是"用哪种质感 + 染什么色 + 淋了雨怎么变 + 大面积上怎么不均匀"几个数。
//     八种颜色的漆共用同一种"漆面"质感。
//
// 建模的代码只写名字：surface('paint_yellow')。同名同选项永远拿到同一个材质实例，
// 这样合并网格时"同一种材质的零件"才能真的并成一次绘制。
//
// 所有材质都套同一段着色器补丁（surfpatch.ts）：染色、大面积的深浅不均、按朝向现算的雨湿。
// 模型的贴图坐标单位是"米"—— 贴图自己知道一张铺多少米，所以同一种材质在大箱子和小零件上，划痕和锈点一样大。

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
  /** 提前几级换用小贴图（见 surfpatch.ts 里 SURF_LOD 的说明）。只给花纹很规则、远看会出摩尔纹的质感用。 */
  lodBias?: number;
  /** 一张贴图里有几道竖条纹（波纹板是 8 道波）。给了这个数，远处会把条纹状的凹凸平滑地抹掉，不出摩尔纹。 */
  stripes?: number;
}

/**
 * 每种质感的"替身"：贴图还没生成（或者生成失败）时，先用一个纯色材质顶着，这里是它的 [粗糙度, 金属度]。
 * 正常情况下只在 initSurfaces() 之前的一小会儿用得到。
 */
const FLAT_LOOK: Record<SetName, readonly [number, number]> = {
  asphalt: [0.9, 0], concrete: [0.85, 0], brick: [0.9, 0], epoxy: [0.45, 0],
  paint: [0.5, 0.05], hazard: [0.5, 0.05], hull: [0.55, 0.05],
  galv: [0.42, 0.9], metal: [0.5, 0.85], brushed: [0.34, 1], rust: [0.9, 0.25], diamond: [0.45, 0.9], corrugated: [0.45, 0.85],
  chainlink: [0.5, 0.9], gunmetal: [0.42, 0.9], anodized: [0.4, 0.8], polymer: [0.6, 0], carbon: [0.4, 0.2],
  fabric: [0.95, 0], armor: [0.45, 0.35], wood: [0.85, 0], plastic: [0.45, 0], tarp: [0.6, 0], cardboard: [0.9, 0],
  rope: [0.95, 0], tire: [0.85, 0], glass: [0.08, 0], glass_dirty: [0.3, 0], water: [0.05, 0],
};
export type { SetName };

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
  corrugated_roof: def('corrugated', { wet: W_METAL, lodBias: 1, stripes: 8 }),
  chainlink: def('chainlink', { tint: 3, wet: W_NONE, macro: M_OFF, alphaCut: true, doubleSide: true }),
  aluminium: def('brushed', { tint: 1, color: 0xc4c8cb, rough: 1.15, wet: W_METAL, macro: M_SMALL }),
  brass: def('brushed', { tint: 1, color: 0xc29a45, rough: 0.9, wet: W_METAL, macro: [0.1, 0.08, 20, 0] }),
  hazard_stripes: def('hazard', { wet: W_PAINT }),
  gunmetal: def('gunmetal', { tint: 1, color: 0x2a2d31, wet: [0, 0.75, 0.6, 0.5], macro: [0.08, 0.06, 6, 0] }),
  anodized_black: def('anodized', { tint: 1, color: 0x121416, rough: 0.72, metal: 0.9, wet: [0, 0.75, 0.6, 0.5], macro: [0.06, 0.05, 6, 0] }),
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
  water_dark: def('water', { wet: W_NONE, macro: M_OFF }),
} as const satisfies Record<string, SurfaceDef>;
export type SurfaceName = keyof typeof SURFACES;

/** 质感自带的颜色（贴图还没生成时的替身）：不染色的材质（tint 为 0 且颜色是白）就用它。 */
const FLAT_COLOR: Partial<Record<SetName, number>> = {
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
  /**
   * 按世界坐标做三平面投影：给"没有米制贴图坐标、而且不会动"的东西用 ——
   * 比如同一个盒子按实例拉成长短不一的钢梁，或者直接用 BoxGeometry 搭的墙和地。纹理密度处处一样，但物体一动纹理就会滑。
   */
  world?: boolean;
}

/** 全场共用的"有多湿"：1 是正在下雨。所有材质的着色器都指向这一个对象，改它的 value 全场一起变。 */
export const wetness = { value: 1 };

/** 地址栏带 ?surfdebug=1 时，所有材质改成直接显示湿度（见 surfpatch.ts 末尾）。 */
const DEBUG_VIEW = new URLSearchParams(location.search).has('surfdebug');
/** 室内物体的淋雨系数：屋顶挡着，只有门口飘进来的一点潮气。 */
const INTERIOR_WET = 0.12;
/** 表里没有的名字退回到它：一块中性的灰钢。 */
const FALLBACK: SurfaceDef = def('metal', { tint: 1, color: 0x7a7d80, wet: W_METAL });

/** 材质上记着"我是照哪条定义、哪些选项做的"，补贴图和克隆的时候要用。 */
interface Recipe { name: string; def: SurfaceDef; opts: SurfaceOpts; dressed: boolean }
const recipeOf = (m: THREE.Material) => m.userData.recipe as Recipe | undefined;

const cache = new Map<string, THREE.MeshStandardMaterial>();
/** 渲染器就绪之前做出来的替身，等 initSurfaces() 时统一补贴图。 */
const waiting: THREE.MeshStandardMaterial[] = [];
const warned = new Set<string>();
let ready = false;

/** 取一个具名材质。同名同选项返回同一个实例。 */
export function surface(name: SurfaceName, o: SurfaceOpts = {}): THREE.Material {
  const key = `${name}|${o.vertexColors ? 'v' : ''}|${o.world ? 'w' + (o.scale ?? 1) : o.triplanar ? 't' + (o.scale ?? 1) : ''}|${o.doubleSide ? 'd' : ''}|${o.interior ? 'i' : ''}|${o.color !== undefined ? 'c' + o.color : ''}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = make(name, o)));
  return m;
}

function make(name: SurfaceName, o: SurfaceOpts): THREE.MeshStandardMaterial {
  let d: SurfaceDef | undefined = (SURFACES as Record<string, SurfaceDef>)[name];
  if (!d) {
    if (!warned.has(name)) { warned.add(name); console.warn(`[surfaces] 没有叫 "${name}" 的材质，先用灰钢代替`); }
    d = FALLBACK;
  }
  // 先做成纯色的"替身"：贴图要等渲染器就绪才能生成
  const [r0, m0] = FLAT_LOOK[d.set];
  const mat = new THREE.MeshStandardMaterial({
    color: o.color ?? (d.tint === 0 && d.color === 0xffffff ? FLAT_COLOR[d.set] ?? 0xffffff : d.color),
    roughness: Math.min(1, r0 * d.rough), metalness: Math.min(1, m0 * d.metal),
    vertexColors: !!o.vertexColors,
    side: o.doubleSide || d.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: !!d.transparent, opacity: d.transparent ? 0.35 : 1,
  });
  mat.name = name;
  mat.userData.recipe = { name, def: d, opts: o, dressed: false } satisfies Recipe;
  if (ready) dress(mat); else waiting.push(mat);
  return mat;
}

/**
 * 给替身"穿上"真正的贴图和着色器补丁。
 * 贴图集在这里才第一次被要到，于是只有场景里真正用到的质感会被生成。
 */
function dress(mat: THREE.MeshStandardMaterial) {
  const recipe = recipeOf(mat);
  if (!recipe || recipe.dressed) return;
  const { def: d, opts: o } = recipe;
  const set = textureSet(d.set);
  if (!set) return; // 生成不了：保持纯色
  recipe.dressed = true;

  mat.map = set.albedo; mat.normalMap = set.normal;
  mat.roughnessMap = mat.metalnessMap = mat.aoMap = set.orm; // 一张图三个通道，各取各的
  mat.color.setHex(o.color ?? d.color);
  mat.roughness = d.rough; mat.metalness = d.metal; // 现在它们是乘在贴图上的倍数，可以大于 1（橡胶 1.4）
  mat.normalScale.set(d.nrm, d.nrm);
  mat.opacity = 1; // 透明度交给贴图的 alpha
  if (d.transparent) { mat.depthWrite = false; mat.envMapIntensity = 1.4; } // 玻璃：不挡住后面的东西；反光加强一点才看得出是玻璃
  if (d.alphaCut) mat.alphaTest = 0.5;

  // 透明的和镂空的材质不做雨湿和不均匀（玻璃上的雨滴已经画在贴图里了）
  const world = !!o.world, tri = !!o.triplanar || world, fx = !d.transparent && !d.alphaCut, cut = !!d.alphaCut && !tri;
  // 宏（define）决定着色器里走哪条分支。宏相同的材质会共用同一个编译好的着色器程序
  const defines: Record<string, string | number> = { STANDARD: '', SURF_TINT: d.tint };
  if (tri) defines.SURF_TRIPLANAR = '';
  if (world) defines.SURF_WORLD = '';
  if (fx) defines.SURF_FX = '';
  if (cut) defines.SURF_ACUT = '';
  if (d.lodBias) defines.SURF_LOD = d.lodBias.toFixed(2);
  if (d.stripes) defines.SURF_STRIPES = d.stripes.toFixed(1);
  if (DEBUG_VIEW) defines.SURF_DEBUG = '';
  (mat as THREE.MeshStandardMaterial & { defines: typeof defines }).defines = defines; // three.js 的类型声明里漏了这个字段
  const uniforms: SurfaceUniforms = {
    uSurfWet: wetness,
    uSurfWetParams: { value: new THREE.Vector4(...d.wet) },
    uSurfMacro: { value: new THREE.Vector4(...d.macro) },
    uSurfMisc: { value: new THREE.Vector3(o.interior ? INTERIOR_WET : 1, (o.scale ?? 1) / set.tile[0], set.size) },
  };
  mat.onBeforeCompile = (shader) => patchSurfaceShader(shader, uniforms);
  // three.js 靠这个字符串判断"两个材质能不能共用一个程序"。颜色、湿度这些都是 uniform，不影响程序本身
  mat.customProgramCacheKey = () => `surf1|${d.tint}${tri ? 't' : ''}${world ? 'w' : ''}${fx ? 'f' : ''}${cut ? 'a' : ''}${d.lodBias ? 'l' + d.lodBias : ''}${d.stripes ? 's' + d.stripes : ''}${DEBUG_VIEW ? 'd' : ''}`;
  mat.userData.set = set.key; mat.userData.tile = set.tile; mat.userData.interior = !!o.interior;
  mat.needsUpdate = true;
}

/**
 * 启动时调用一次，把渲染器交给材质库（生成贴图要用它）。
 * 在这之前创建的材质是纯色的替身，这里会给它们补上贴图。
 * texSize 是贴图的基准边长：不给就按画质定（低 512、极高 2048、其余 1024）；地址栏 ?tex=512 可以临时覆盖。
 */
export function initSurfaces(gl: THREE.WebGLRenderer, texSize?: number) {
  if (ready) return;
  const quality = loadSettings().settings.quality;
  initTexGen(gl, texSize ?? (quality === 'low' ? 512 : quality === 'ultra' ? 2048 : 1024));
  ready = true;
  for (const m of waiting) dress(m);
  waiting.length = 0;
}

/**
 * 克隆一个材质库的材质（比如敌人受击闪白：每只敌人要一份可以单独改颜色的）。
 * 不能直接 material.clone()：three.js 的克隆不会带上着色器补丁和宏，克隆出来的会变成没有贴图逻辑的普通材质。
 * 克隆品和原件共用贴图和着色器程序，不多占显存。
 */
export function cloneSurface(src: THREE.Material): THREE.Material {
  const copy = src.clone();
  const recipe = recipeOf(src);
  if (recipe && copy instanceof THREE.MeshStandardMaterial) {
    copy.userData.recipe = { ...recipe, dressed: false } satisfies Recipe;
    if (ready) {
      dress(copy);
      copy.color.copy((src as THREE.MeshStandardMaterial).color); // 保留原件当前的颜色（可能被改过）
    } else waiting.push(copy);
  }
  return copy;
}

/** 这种材质的贴图一张铺多少米 [横, 纵]。 */
export function tileOf(name: SurfaceName): [number, number] {
  const t = SETS[(SURFACES[name] as SurfaceDef).set].tile;
  return typeof t === 'number' ? [t, t] : [t[0], t[1]];
}

/** 已经生成了几个贴图集、估算占多少显存（MB）、生成一共花了多久（毫秒）。 */
export const surfaceStats = texGenStats;

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
