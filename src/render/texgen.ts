import * as THREE from 'three';
import { GEN_COPY_FRAGMENT, GEN_LIB, GEN_MAIN, GEN_NORMAL_FRAGMENT, GEN_VERTEX } from './texgen-lib';
import { GEN_SURF, type GenFn } from './texgen-sets';

// 贴图集的生成：在显卡上把每种质感"算"成三张图。
//
// 以前贴图是在 JavaScript 里一个像素一个像素算的，一张 1024 的图要算一百万次，启动时能卡好几秒。
// 这里换成让显卡算：画一个盖满整张贴图的方块，片元着色器对每个像素调一次 surf(uv)（见 texgen-sets.ts）。
// 一次绘制同时写出三张中间结果，再各加工一遍，得到材质要用的三张成品：
//
//   albedo  颜色。alpha 通道存"染色量"（这里还剩多少漆，见 surfaces.ts 的染色方式）
//   orm     一张图存三样：r 遮蔽、g 粗糙度、b 金属度
//   normal  法线（表面的细小凹凸），由高度图算出来
//
// 用到哪种质感才生成哪种（懒生成）：场景里没有砖，就永远不会去算砖的贴图。

interface SetDef {
  /** 用哪个 surf 函数。 */
  fn: GenFn;
  /** 分辨率系数：1 是基准边长（默认 1024），0.5 是它的一半。越细腻、铺得越大的质感给得越高。 */
  size: number;
  /** 一张图铺多少米。两个数时是横向、纵向各自的米数。 */
  tile: number | readonly [number, number];
  /** 高度图从 0 到 1 对应真实的多少毫米。决定法线图里凹凸的深浅。 */
  bump: number;
  /** 传给 surf 函数的参数（uParam）。 */
  param?: readonly number[];
  /** 随机种子的偏移：两个贴图集共用一个函数时，用它得到不同的图。 */
  seed?: number;
  /** 最高画质（基准 2048）时升到 2048。 */
  hero?: boolean;
}

/** 全部贴图集。像素密度 = 边长 ÷ tile：漆面 410 像素/米，镀锌钢 512，枪灰 2048。 */
export const SETS = {
  asphalt: { fn: 'asphalt', size: 1, tile: 2, bump: 1.6, hero: true },
  concrete: { fn: 'concrete', size: 1, tile: 3, bump: 2.5 },
  brick: { fn: 'brick', size: 0.5, tile: 1.8, bump: 6 },
  epoxy: { fn: 'epoxy', size: 0.5, tile: 4, bump: 3 },
  paint: { fn: 'paint', size: 1, tile: 2.5, bump: 2.5, param: [0.5] },
  hull: { fn: 'hull', size: 0.5, tile: 4, bump: 12 },
  galv: { fn: 'galv', size: 0.5, tile: 1, bump: 0.8 },
  metal: { fn: 'metal', size: 0.5, tile: 1, bump: 0.5, param: [1] },
  brushed: { fn: 'brushed', size: 0.5, tile: 0.5, bump: 0.4 },
  rust: { fn: 'rust', size: 0.5, tile: 1.2, bump: 3 },
  diamond: { fn: 'diamond', size: 0.5, tile: 0.5, bump: 2 },
  corrugated: { fn: 'corrugated', size: 0.5, tile: [0.762, 2.286], bump: 19 },
  chainlink: { fn: 'chainlink', size: 0.5, tile: 0.5, bump: 5 },
  hazard: { fn: 'hazard', size: 0.5, tile: 1, bump: 2.5 },
  gunmetal: { fn: 'gunmetal', size: 0.5, tile: 0.25, bump: 0.3, param: [0.6] },
  anodized: { fn: 'gunmetal', size: 0.5, tile: 0.25, bump: 0.25, param: [0.2], seed: 11 },
  polymer: { fn: 'polymer', size: 0.25, tile: 0.1, bump: 0.4 },
  carbon: { fn: 'carbon', size: 0.25, tile: 0.05, bump: 0.5 },
  fabric: { fn: 'fabric', size: 0.25, tile: 0.05, bump: 0.4 },
  armor: { fn: 'armor', size: 0.5, tile: 0.5, bump: 0.8 },
  wood: { fn: 'wood', size: 0.5, tile: 1.2, bump: 2.6 },
  plastic: { fn: 'plastic', size: 0.5, tile: 1, bump: 1 },
  tarp: { fn: 'tarp', size: 0.5, tile: 1.5, bump: 20 },
  cardboard: { fn: 'cardboard', size: 0.5, tile: 1, bump: 0.8 },
  rope: { fn: 'rope', size: 0.25, tile: 0.1, bump: 4 },
  tire: { fn: 'tire', size: 0.5, tile: [0.5, 0.3], bump: 7 },
  glass: { fn: 'glass', size: 0.5, tile: 1.5, bump: 1.5, param: [0.3] },
  glass_dirty: { fn: 'glass', size: 0.5, tile: 1.5, bump: 1.5, param: [1], seed: 40 },
  water: { fn: 'water', size: 0.25, tile: 4, bump: 30 },
} as const satisfies Record<string, SetDef>;
export type SetName = keyof typeof SETS;

/** 一个贴图集的成品。三张图的 repeat 都已经设成 1/tile，所以模型的贴图坐标直接用"米"就行。 */
export interface TexSet {
  key: SetName;
  albedo: THREE.Texture; orm: THREE.Texture; normal: THREE.Texture;
  /** 一张图铺多少米 [横, 纵]。 */
  tile: [number, number];
  /** 边长（像素）。 */
  size: number;
}

let renderer: THREE.WebGLRenderer | null = null;
let baseSize = 1024, anisotropy = 1;
/** 开发时每生成一张就等显卡真的算完再计时；正式运行不等（不然白白卡住主线程）。 */
let measureGpu = false;

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quad.frustumCulled = false;
const scene = new THREE.Scene().add(quad);

// 生成过程中的临时资源。同样尺寸的中间画布、同一个 surf 函数的着色器都可以复用；闲下来几秒后统一释放。
const scratchBySize = new Map<number, THREE.WebGLRenderTarget>();
const programByFn = new Map<GenFn, THREE.RawShaderMaterial>();
let post: { normal: THREE.RawShaderMaterial; copy: THREE.RawShaderMaterial } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const done = new Map<SetName, TexSet>();
const failed = new Set<SetName>();
let totalBytes = 0, totalMs = 0;

const rawShader = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: GEN_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });

/**
 * 交出渲染器，之后才能生成贴图。preferred 是基准边长（一般 1024）。
 * 地址栏 ?tex=512 可以临时覆盖；软件渲染的机器（没有显卡，CPU 硬算）最多用 512，不然光生成贴图就要等很久。
 */
export function initTexGen(gl: THREE.WebGLRenderer, preferred = 1024) {
  renderer = gl;
  anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy()); // 各向异性过滤：斜着看的表面不糊。8 倍以上基本看不出区别
  const asked = Number(new URLSearchParams(location.search).get('tex'));
  baseSize = asked > 0 ? asked : isSoftwareRenderer(gl) ? Math.min(preferred, 512) : preferred;
  measureGpu = import.meta.env.DEV;
}

/** 没有显卡、用 CPU 模拟出来的 WebGL：能跑，但每个像素都是 CPU 在算。 */
function isSoftwareRenderer(gl: THREE.WebGLRenderer) {
  const ctx = gl.getContext(), ext = ctx.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  return /swiftshader|llvmpipe|software/i.test(name);
}

function sizeOf(def: SetDef) {
  if (def.hero && baseSize >= 2048) return 2048;
  return Math.max(32, Math.round(Math.min(baseSize, 1024) * def.size));
}

/** 成品贴图：带多级缩小图（mipmap，远处不闪）、可以平铺、开各向异性过滤。颜色图用 sRGB 格式存，暗部更细。 */
function finalTarget(px: number, srgb: boolean) {
  return new THREE.WebGLRenderTarget(px, px, {
    depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
  });
}

function draw(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.Material) {
  quad.material = material;
  gl.setRenderTarget(target);
  gl.render(scene, camera);
}

/**
 * 取一个贴图集，没有就现场生成。生成不了（还没交出渲染器，或者出错）时返回 null，调用方用纯色顶着。
 */
export function textureSet(key: SetName): TexSet | null {
  const hit = done.get(key);
  if (hit) return hit;
  const gl = renderer;
  if (!gl || failed.has(key)) return null;
  const def: SetDef = SETS[key], px = sizeOf(def);
  const tile: [number, number] = typeof def.tile === 'number' ? [def.tile, def.tile] : [def.tile[0], def.tile[1]];
  const t0 = performance.now();

  // 我们是"插队"用渲染器的：先记下它现在的状态，画完原样还回去
  const saved = { target: gl.getRenderTarget(), face: gl.getActiveCubeFace(), mip: gl.getActiveMipmapLevel(), autoClear: gl.autoClear, xr: gl.xr.enabled, shadows: gl.shadowMap.autoUpdate };
  gl.autoClear = true; gl.xr.enabled = false; gl.shadowMap.autoUpdate = false;
  let set: TexSet;
  try {
    // 1) 中间画布：三张图一起写（颜色+染色量 / 遮蔽-粗糙-金属 / 高度）。不过滤、不要缩小图，原样存
    let scratch = scratchBySize.get(px);
    if (!scratch) {
      scratch = new THREE.WebGLRenderTarget(px, px, { count: 3, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
      scratchBySize.set(px, scratch);
    }
    // 2) 生成器着色器 = 公共库 + 这种质感的 surf() + 入口
    let program = programByFn.get(def.fn);
    if (!program) {
      program = rawShader(GEN_LIB + GEN_SURF[def.fn] + GEN_MAIN, { uParam: { value: new THREE.Vector4() }, uSeed: { value: 0 }, uTexel: { value: 0 } });
      programByFn.set(def.fn, program);
    }
    const p = def.param ?? [];
    program.uniforms.uParam.value.set(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0);
    program.uniforms.uSeed.value = def.seed ?? 0;
    program.uniforms.uTexel.value = 1 / px;
    draw(gl, scratch, program);

    // 3) 三张成品
    post ??= {
      normal: rawShader(GEN_NORMAL_FRAGMENT, { tHeight: { value: null }, uSlope: { value: new THREE.Vector2() }, uTexel: { value: 0 } }),
      copy: rawShader(GEN_COPY_FRAGMENT, { tSource: { value: null }, uSquare: { value: 0 } }),
    };
    const albedo = finalTarget(px, true), orm = finalTarget(px, false), normal = finalTarget(px, false);
    post.copy.uniforms.tSource.value = scratch.textures[0]; post.copy.uniforms.uSquare.value = 1; // 颜色是开平方存的，这里平方回来
    draw(gl, albedo, post.copy);
    post.copy.uniforms.tSource.value = scratch.textures[1]; post.copy.uniforms.uSquare.value = 0;
    draw(gl, orm, post.copy);
    post.normal.uniforms.tHeight.value = scratch.textures[2];
    post.normal.uniforms.uTexel.value = 1 / px;
    // 坡度 = 高度差（米）÷ 水平距离（米）。高度 0→1 是 bump 毫米；一个像素宽 tile/px 米
    post.normal.uniforms.uSlope.value.set((def.bump * 0.001 * px) / tile[0], (def.bump * 0.001 * px) / tile[1]);
    draw(gl, normal, post.normal);

    for (const rt of [albedo, orm, normal]) {
      rt.texture.repeat.set(1 / tile[0], 1 / tile[1]); // 贴图坐标的单位是米：走 tile 米正好铺完一张
      rt.texture.name = 'surf_' + key;
    }
    if (measureGpu) gl.readRenderTargetPixels(normal, 0, 0, 1, 1, new Uint8Array(4)); // 读回一个像素 = 等显卡把上面的活干完
    set = { key, albedo: albedo.texture, orm: orm.texture, normal: normal.texture, tile, size: px };
  } catch (err) {
    console.warn(`[surfaces] 贴图集 ${key} 生成失败，先用纯色`, err);
    failed.add(key);
    return null;
  } finally {
    gl.setRenderTarget(saved.target, saved.face, saved.mip);
    gl.autoClear = saved.autoClear; gl.xr.enabled = saved.xr; gl.shadowMap.autoUpdate = saved.shadows;
  }
  done.set(key, set);
  totalBytes += px * px * 4 * 1.34 * 3; // 每像素 4 字节；多级缩小图再多占三分之一；一共三张
  totalMs += performance.now() - t0;
  // 4 秒内没有新的贴图要生成，就把中间画布和生成器着色器释放掉（成品贴图留着）
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseScratch, 4000);
  return set;
}

function releaseScratch() {
  for (const rt of scratchBySize.values()) rt.dispose();
  for (const m of programByFn.values()) m.dispose();
  scratchBySize.clear(); programByFn.clear();
  post?.normal.dispose(); post?.copy.dispose(); post = null;
}

/** 到现在为止生成了几个贴图集、占多少显存（估算）、一共花了多久。 */
export function texGenStats() {
  return { sets: done.size, textureMB: +(totalBytes / 1048576).toFixed(1), genMs: Math.round(totalMs), baseSize, list: [...done.values()].map((s) => `${s.key}:${s.size}`) };
}
