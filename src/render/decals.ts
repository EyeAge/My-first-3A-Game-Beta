import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 弹孔和焦痕。
//
// 子弹打在哪，就在那里贴一张小方片（"贴花"）。方片上画的不只是颜色，一共三张图：
//   颜色图      弹孔长什么样；透明的地方露出后面的墙
//   材质图      每个像素有多粗糙（绿色通道）、是不是金属（蓝色通道）。打在集装箱上崩掉漆露出来的铁皮是光滑的金属，
//               会反光；弹孔里面是又黑又糙的。有了它，同一张贴花上才能既有亮闪闪的铁皮、又有哑光的烟熏
//   法线图      表面朝哪边鼓、朝哪边凹。弹孔边缘翻起来的一圈铁皮会被太阳照出亮边，坑里是暗的 —— 贴花明明是平的，看着却有凹凸
// 法线图不是直接画的：先画一张"高度图"（越白越高），再由相邻像素的高度差算出坡度，换成法线。
//
// 五种贴花画在同一张 4×2 的图集里，所有贴花共用一个实例化网格，一次绘制调用画完。

export type DecalKind = 'metal' | 'concrete' | 'wood' | 'scorch' | 'soot';

/** 最多同时有多少个贴花。满了以后新的覆盖最旧的。 */
const MAX = 320;
/** 快要被覆盖的这么多个提前变淡：最旧的不是"啪"地消失，而是先淡下去再被换掉。 */
const FADING = 14;
const COLS = 4, ROWS = 2, CELL = 256;
/** 每种贴花在图集的第几格（多于一格的随机挑），和它默认的边长（米）。第 7 格空着。 */
const FRAMES: Record<DecalKind, number[]> = { metal: [0, 1], concrete: [2, 3], wood: [4], scorch: [5], soot: [6] };
const SIZE: Record<DecalKind, number> = { metal: 0.25, concrete: 0.34, wood: 0.24, scorch: 2.4, soot: 0.3 };
/** 屋里的贴花，天空的环境反射只留这么多：屋里看不到天，裸露的铁皮不该映出一片蓝。（数值是屋里屋外各摆一个白球量出来的亮度比） */
const INDOOR_SKY = 0.45;

type Ctx = CanvasRenderingContext2D;
type Rnd = () => number;

/** 一条不规则的闭合轮廓：半径在每个方向上随机抖一点，stretchY 把它竖向拉长或压扁。 */
function blob(g: Ctx, rnd: Rnd, radius: number, jitter: number, points: number, stretchY = 1) {
  g.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2, r = radius * (1 + (rnd() - 0.5) * jitter);
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r * stretchY); else g.lineTo(Math.cos(a) * r, Math.sin(a) * r * stretchY);
  }
  g.closePath();
}
/** 一条从半径 r0 走到 r1 的裂纹：分成 5–8 小段，每段的方向随机偏一点（wobble 越大越弯）。 */
function crack(g: Ctx, rnd: Rnd, angle: number, r0: number, r1: number, wobble: number, width: number, color: string) {
  const steps = 5 + Math.floor(rnd() * 4);
  let a = angle, x = Math.cos(a) * r0, y = Math.sin(a) * r0;
  g.beginPath(); g.moveTo(x, y);
  for (let i = 0; i < steps; i++) {
    a += (rnd() - 0.5) * wobble;
    x += Math.cos(a) * (r1 - r0) / steps; y += Math.sin(a) * (r1 - r0) / steps;
    g.lineTo(x, y);
  }
  g.strokeStyle = color; g.lineWidth = width; g.stroke();
}
/** 径向渐变：stops 是 [位置 0..1, 颜色] 的列表，从半径 r0 到 r1。 */
function radial(g: Ctx, r0: number, r1: number, stops: [number, string][]) {
  const grad = g.createRadialGradient(0, 0, r0, 0, 0, r1);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  return grad;
}
const grey = (v: number) => `rgb(${v},${v},${v})`;

/**
 * 画出三张图集。每一格的画法都是"以格子中心为原点"画的，M 是半格（128 像素）。
 * 材质图的底色是 rgb(0, 235, 0)：粗糙 0.92、不是金属；高度图的底色是 128：不高不低。
 */
function drawAtlas() {
  const make = () => { const c = document.createElement('canvas'); c.width = CELL * COLS; c.height = CELL * ROWS; return c; };
  const colorCanvas = make(), ormCanvas = make(), heightCanvas = make();
  const col = colorCanvas.getContext('2d')!, orm = ormCanvas.getContext('2d')!, hgt = heightCanvas.getContext('2d', { willReadFrequently: true })!;
  orm.fillStyle = 'rgb(0,235,0)'; orm.fillRect(0, 0, ormCanvas.width, ormCanvas.height);
  hgt.fillStyle = grey(128); hgt.fillRect(0, 0, heightCanvas.width, heightCanvas.height);
  const rnd = mulberry32(77123), M = CELL / 2;
  const range = (a: number, b: number) => a + rnd() * (b - a);
  /** 把三张画布的原点都挪到第 frame 格的中心，并裁掉格子以外的部分（画出格就会渗到隔壁的贴花里）。 */
  const cell = (frame: number, draw: () => void) => {
    const x0 = (frame % COLS) * CELL, y0 = Math.floor(frame / COLS) * CELL;
    for (const g of [col, orm, hgt]) { g.save(); g.beginPath(); g.rect(x0, y0, CELL, CELL); g.clip(); g.translate(x0 + M, y0 + M); }
    draw();
    for (const g of [col, orm, hgt]) g.restore();
  };

  // ---- 金属弹孔（两种）：烟熏 → 放射细纹 → 崩掉漆露出的铁皮（外面一圈锈色的底漆）→ 划痕 → 翻起来的卷边 → 黑洞
  for (const frame of FRAMES.metal) cell(frame, () => {
    col.fillStyle = radial(col, M * 0.1, M * 0.6, [[0, 'rgba(14,13,12,0.4)'], [0.5, 'rgba(18,17,16,0.14)'], [1, 'rgba(18,17,16,0)']]);
    col.fillRect(-M, -M, CELL, CELL);
    for (let i = 0, n = 6 + Math.floor(rnd() * 5); i < n; i++) crack(col, rnd, rnd() * 6.283, M * 0.2, M * range(0.38, 0.83), 0.3, range(0.8, 1.8), 'rgba(8,8,8,0.55)');
    // 裸露的铁皮：一块大的 + 几块小的。中间亮、边上暗一点，像被子弹擦亮了
    const chip = M * range(0.24, 0.32), tone = Math.round(range(150, 200));
    const bare = (cx: number, cy: number, radius: number) => {
      const turn = rnd() * 6.283, squash = range(0.7, 1.2), seed = Math.floor(rnd() * 1e9);
      // 同一个轮廓要在颜色图和材质图上各画一遍：用同一个种子重放，两边的形状才一样
      for (const g of [col, orm]) {
        const shape = mulberry32(seed);
        g.save(); g.translate(cx, cy); g.rotate(turn);
        blob(g, shape, radius, 0.75, 11, squash);
        if (g === col) {
          g.strokeStyle = 'rgba(92,54,36,0.95)'; g.lineWidth = Math.max(1.5, radius * 0.14); g.stroke();
          g.fillStyle = radial(g, 0, radius, [[0, `rgb(${tone - 30},${tone - 26},${tone - 20})`], [0.7, `rgb(${tone + 30},${tone + 33},${tone + 36})`], [1, `rgb(${tone},${tone + 3},${tone + 6})`]]);
        } else g.fillStyle = 'rgb(0,85,255)';                           // 粗糙 0.33、金属 1：会反光
        g.fill(); g.restore();
      }
    };
    bare(0, 0, chip);
    for (let i = 0, n = 2 + Math.floor(rnd() * 4); i < n; i++) { const a = rnd() * 6.283, d = chip * range(1, 1.7); bare(Math.cos(a) * d, Math.sin(a) * d, chip * range(0.15, 0.45)); }
    for (let i = 0; i < 9; i++) {
      const a = rnd() * 6.283, r1 = chip * range(0.6, 0.9);
      col.strokeStyle = i % 2 ? 'rgba(245,246,248,0.7)' : 'rgba(70,72,76,0.5)'; col.lineWidth = 0.8;
      col.beginPath(); col.moveTo(Math.cos(a) * chip * 0.3, Math.sin(a) * chip * 0.3); col.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); col.stroke();
    }
    // 卷边：子弹穿过铁皮，孔的边缘被顶得向外翻，裂成一片片尖角
    const hole = M * range(0.1, 0.125);
    orm.fillStyle = 'rgb(0,60,255)'; orm.beginPath(); orm.arc(0, 0, hole * 1.8, 0, 6.283); orm.fill();
    for (let i = 0, n = 8 + Math.floor(rnd() * 5); i < n; i++) {
      const a = (i / n) * 6.283 + range(-0.1, 0.1), half = range(0.16, 0.32), tip = hole * range(1.25, 2.15), shine = Math.round(range(205, 254));
      if (rnd() < 0.15) continue;                                       // 有几片崩掉了
      col.beginPath();
      col.moveTo(Math.cos(a - half) * hole * 0.9, Math.sin(a - half) * hole * 0.9);
      col.lineTo(Math.cos(a) * tip, Math.sin(a) * tip);
      col.lineTo(Math.cos(a + half) * hole * 0.9, Math.sin(a + half) * hole * 0.9);
      col.closePath();
      col.fillStyle = `rgb(${shine},${shine},${Math.min(255, shine + 4)})`; col.fill();
      col.strokeStyle = 'rgba(40,40,42,0.6)'; col.lineWidth = 1; col.stroke();
    }
    const seed = Math.floor(rnd() * 1e9);
    blob(col, mulberry32(seed), hole, 0.3, 11); col.fillStyle = radial(col, 0, hole, [[0, '#000000'], [0.8, '#040404'], [1, '#141414']]); col.fill();
    blob(orm, mulberry32(seed), hole, 0.3, 11); orm.fillStyle = 'rgb(0,250,0)'; orm.fill();   // 洞里：很糙、不反光
    // 高度：洞是深的（黑），卷边鼓起来（白），再往外有一圈浅浅的凹陷，然后回到平面
    hgt.fillStyle = radial(hgt, 0, hole * 3.4, [[0, grey(0)], [0.26, grey(10)], [0.36, grey(240)], [0.5, grey(200)], [0.62, grey(100)], [1, grey(128)]]);
    hgt.beginPath(); hgt.arc(0, 0, hole * 3.4, 0, 6.283); hgt.fill();
  });

  // ---- 水泥崩坑（两种）：粉尘 → 裂缝 → 崩掉一块露出里面浅色的新茬 → 中间的深坑 → 周围溅出的碎屑
  for (const frame of FRAMES.concrete) cell(frame, () => {
    col.fillStyle = radial(col, M * 0.2, M * 0.9, [[0, 'rgba(186,180,168,0.22)'], [0.6, 'rgba(180,175,165,0.07)'], [1, 'rgba(180,175,165,0)']]);
    col.fillRect(-M, -M, CELL, CELL);
    for (let i = 0, n = 4 + Math.floor(rnd() * 4); i < n; i++) {
      const a = rnd() * 6.283, reach = M * range(0.5, 0.92);
      crack(col, rnd, a, M * 0.25, reach, 0.35, range(1.3, 2.6), 'rgba(20,19,18,0.75)');
      if (rnd() < 0.5) crack(col, rnd, a + (rnd() < 0.5 ? 0.3 : -0.3), reach * 0.7, reach * 1.05, 0.6, 0.9, 'rgba(20,19,18,0.5)');   // 一半的裂缝带分叉
    }
    const pit = M * range(0.33, 0.42), seed = Math.floor(rnd() * 1e9);
    // 同一个轮廓画三遍：先往右下偏一点画一层阴影，再画坑本身，最后往左上偏一点描一道受光的亮边 —— 平面上就有了"坑沿"的感觉
    col.save(); col.translate(1.5, 1.5); col.scale(1.05, 1.05); blob(col, mulberry32(seed), pit, 0.6, 12); col.fillStyle = 'rgba(22,21,20,0.8)'; col.fill(); col.restore();
    blob(col, mulberry32(seed), pit, 0.6, 12); col.fillStyle = radial(col, 0, pit, [[0, '#35332f'], [0.4, '#6f6b63'], [0.8, '#8f8b82'], [1, '#9a968c']]); col.fill();
    col.save(); col.translate(-1, -1); blob(col, mulberry32(seed), pit, 0.6, 12); col.strokeStyle = 'rgba(206,201,190,0.55)'; col.lineWidth = 1.2; col.stroke(); col.restore();
    for (let i = 0; i < 6; i++) crack(col, rnd, rnd() * 6.283, pit * 0.2, pit * range(0.5, 0.9), 0.5, 0.8, 'rgba(30,28,26,0.5)');
    for (let i = 0; i < 60; i++) {
      const a = rnd() * 6.283, d = pit * Math.sqrt(rnd()) * 0.9;
      col.fillStyle = rnd() < 0.55 ? 'rgba(36,34,32,0.6)' : 'rgba(196,191,180,0.6)';
      col.beginPath(); col.arc(Math.cos(a) * d, Math.sin(a) * d, range(0.7, 2.7), 0, 6.283); col.fill();
    }
    blob(col, rnd, pit * 0.3, 0.45, 9); col.fillStyle = radial(col, 0, pit * 0.3, [[0, '#060606'], [0.7, '#161514'], [1, '#2c2a27']]); col.fill();
    hgt.fillStyle = radial(hgt, 0, pit * 1.15, [[0, grey(0)], [0.24, grey(20)], [0.3, grey(70)], [0.8, grey(112)], [0.88, grey(150)], [1, grey(128)]]);
    hgt.beginPath(); hgt.arc(0, 0, pit * 1.15, 0, 6.283); hgt.fill();
    for (let i = 0; i < 22; i++) {
      const a = rnd() * 6.283, d = pit * range(1.15, 2.45);
      col.fillStyle = rnd() < 0.5 ? 'rgba(196,191,180,0.45)' : 'rgba(30,28,26,0.45)';
      col.beginPath(); col.arc(Math.cos(a) * d, Math.sin(a) * d, range(0.6, 2.2), 0, 6.283); col.fill();
    }
  });

  // ---- 木头：一块浅色的新茬，竖着的一根根木刺（亮的是翘起来的，暗的是缝），中间一个洞。木刺顺着木纹，所以这种贴花贴的时候几乎不转
  cell(FRAMES.wood[0], () => {
    blob(col, rnd, M * 0.27, 0.7, 11, 1.45); col.fillStyle = 'rgba(206,182,140,0.85)'; col.fill();
    for (let i = 0; i < 46; i++) {
      const x = range(-1, 1) * M * 0.31, half = M * range(0.25, 0.85) * Math.max(0, 1 - Math.abs(x) / (M * 0.4)), y = range(-0.15, 0.15) * M;
      col.strokeStyle = rnd() < 0.5 ? 'rgba(236,216,172,0.85)' : 'rgba(88,62,38,0.7)'; col.lineWidth = range(0.8, 3);
      col.beginPath(); col.moveTo(x, y - half); col.lineTo(x + range(-1.5, 1.5), y + half); col.stroke();
    }
    blob(col, rnd, M * 0.1, 0.5, 9, 1.1); col.fillStyle = radial(col, 0, M * 0.11, [[0, '#050403'], [0.8, '#140f0a'], [1, '#3a2a1a']]); col.fill();
    hgt.fillStyle = radial(hgt, 0, M * 0.17, [[0, grey(0)], [0.5, grey(30)], [0.8, grey(140)], [1, grey(128)]]);
    hgt.beginPath(); hgt.arc(0, 0, M * 0.17, 0, 6.283); hgt.fill();
  });

  // ---- 焦痕（爆炸留在地上的）：中间焦黑、往外渐淡，一圈放射状的细条，撒一些灰烬的斑点
  cell(FRAMES.scorch[0], () => {
    col.fillStyle = radial(col, 0, M * 0.98, [[0, 'rgba(6,5,5,0.92)'], [0.3, 'rgba(10,9,8,0.85)'], [0.55, 'rgba(22,18,15,0.5)'], [0.8, 'rgba(30,24,20,0.16)'], [1, 'rgba(30,24,20,0)']]);
    col.fillRect(-M, -M, CELL, CELL);
    for (let i = 0; i < 90; i++) {
      const a = rnd() * 6.283, r0 = M * range(0.1, 0.4), r1 = M * range(0.5, 0.96);
      col.fillStyle = `rgba(8,7,6,${range(0.12, 0.42).toFixed(2)})`;
      col.beginPath(); col.moveTo(Math.cos(a - 0.03) * r0, Math.sin(a - 0.03) * r0); col.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); col.lineTo(Math.cos(a + 0.03) * r0, Math.sin(a + 0.03) * r0); col.closePath(); col.fill();
    }
    for (let i = 0; i < 60; i++) {
      const a = rnd() * 6.283, d = M * Math.sqrt(rnd()) * 0.8;
      col.fillStyle = rnd() < 0.3 ? 'rgba(150,140,128,0.25)' : 'rgba(0,0,0,0.4)';
      col.beginPath(); col.arc(Math.cos(a) * d, Math.sin(a) * d, range(1, 5), 0, 6.283); col.fill();
    }
  });

  // ---- 烟熏的印子（沙袋、轮胎被打中，能量弹打在墙上）：十几个柔和的黑斑叠在一起，中间一小块最黑
  cell(FRAMES.soot[0], () => {
    for (let i = 0; i < 14; i++) {
      const a = rnd() * 6.283, d = M * rnd() * 0.3, r = M * range(0.15, 0.45);
      col.save(); col.translate(Math.cos(a) * d, Math.sin(a) * d);
      col.fillStyle = radial(col, 0, r, [[0, 'rgba(8,8,8,0.4)'], [1, 'rgba(8,8,8,0)']]); col.fillRect(-r, -r, r * 2, r * 2);
      col.restore();
    }
    blob(col, rnd, M * 0.1, 0.4, 12); col.fillStyle = 'rgba(0,0,0,0.9)'; col.fill();
  });

  // 高度 → 法线。某个像素左右两边的高度差就是"横向的坡度"，上下两边的差是"纵向的坡度"；
  // 坡朝哪边，表面的法线就往反方向歪。乘 5 是把起伏夸张一些（贴花很小，凹凸不夸张就看不出来）。
  const W = heightCanvas.width, H = heightCanvas.height, src = hgt.getImageData(0, 0, W, H).data;
  const normalCanvas = make(), ng = normalCanvas.getContext('2d')!, out = ng.createImageData(W, H);
  const at = (x: number, y: number) => src[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = ((at(x + 1, y) - at(x - 1, y)) * 5) / 255, dy = ((at(x, y + 1) - at(x, y - 1)) * 5) / 255, k = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (y * W + x) * 4;
    out.data[o] = (-dx * k * 0.5 + 0.5) * 255; out.data[o + 1] = (dy * k * 0.5 + 0.5) * 255; out.data[o + 2] = (k * 0.5 + 0.5) * 255; out.data[o + 3] = 255;
  }
  ng.putImageData(out, 0, 0);

  const color = new THREE.CanvasTexture(colorCanvas); color.colorSpace = THREE.SRGBColorSpace; color.anisotropy = 4;
  // 材质图和法线图里存的是数据不是颜色，不能做"屏幕颜色 → 线性"的换算
  const material = new THREE.CanvasTexture(ormCanvas), normal = new THREE.CanvasTexture(normalCanvas);
  material.colorSpace = normal.colorSpace = THREE.NoColorSpace;
  return { color, material, normal };
}

export interface DecalMaps {
  /** 材质图：绿色通道 = 粗糙度，蓝色通道 = 金属度。 */
  material?: THREE.Texture;
  normal?: THREE.Texture;
  /** 每一格四周往里收多少（占一格的比例），防止取到隔壁格子的像素。 */
  inset?: number;
}

/**
 * 贴花材质：一张图集里放多种图案，每个实例用 aDecal 属性选其中一格 —— (u 偏移, v 偏移, 透明度, 天空反射的倍数)。
 * polygonOffset 让贴花在深度上比墙面"靠前"一点点，避免和墙面抢像素而闪烁。
 * 给了材质图 / 法线图，贴花就有自己的反光和凹凸（弹孔用）；不给就是一张平的贴纸（场景里的铭牌、水渍用）。
 */
export function decalMaterial(map: THREE.Texture, cols: number, rows: number, offset: number, roughness = 0.85, maps: DecalMaps = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness, metalness: 0.15, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
  if (maps.material) { mat.roughnessMap = mat.metalnessMap = maps.material; mat.roughness = mat.metalness = 1; }   // 有贴图时，这两个数是贴图的倍数，设成 1 就是"全听贴图的"
  if (maps.normal) mat.normalMap = maps.normal;
  const inset = maps.inset ?? 0, scale = `vec2(${((1 - 2 * inset) / cols).toFixed(6)}, ${((1 - 2 * inset) / rows).toFixed(6)})`, shift = `vec2(${(inset / cols).toFixed(6)}, ${(inset / rows).toFixed(6)})`;
  // three 给每张贴图各准备了一份纹理坐标，所以颜色、粗糙度、金属度、法线四份都要挪到自己那一格里
  const place = (name: string) => `${name} = ${name} * ${scale} + ${shift} + aDecal.xy;`;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aDecal;\nvarying vec2 vDecal;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
${place('vMapUv')}
#ifdef USE_ROUGHNESSMAP
${place('vRoughnessMapUv')}
#endif
#ifdef USE_METALNESSMAP
${place('vMetalnessMapUv')}
#endif
#ifdef USE_NORMALMAP
${place('vNormalMapUv')}
#endif
vDecal = aDecal.zw;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDecal;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecal.x;')
      // 环境反射（天空照出来的那部分光）按 vDecal.y 打折：屋里的贴花不该映出一片天。太阳和点光源的直接照明不受影响
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= vDecal.y; reflectedLight.indirectSpecular *= vDecal.y;');
  };
  mat.customProgramCacheKey = () => `decal-atlas-${cols}x${rows}-${inset}`;
  return mat;
}

/**
 * 弹孔贴花。所有贴花共用一个实例化网格（一次绘制调用），循环复用：满了就覆盖最旧的。
 * 贴花没有寿命 —— 打出来的弹孔一直留着，直到被新的顶掉（场上同时最多 320 个）。
 */
export class Decals {
  readonly mesh: THREE.InstancedMesh;
  /** 室内范围：落在这个盒子里的贴花，天空的环境反射打折。 */
  interior: THREE.Box3 | null = null;
  private attr: THREE.InstancedBufferAttribute;   // 每个实例：图集偏移 u、v，透明度，天空反射的倍数
  private alpha = new Float32Array(MAX);           // 每个贴花没开始变淡时的不透明度
  private cursor = 0; private full = false;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDecal', this.attr);
    const maps = drawAtlas();
    this.mesh = new THREE.InstancedMesh(geo, decalMaterial(maps.color, COLS, ROWS, -4, 1, { material: maps.material, normal: maps.normal, inset: 2 / CELL }), MAX);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = true;                // 影子里的弹孔也在影子里（不然阴影里的贴花会被太阳照得发亮）
    this.clear();
  }

  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) { this.mesh.setMatrixAt(i, _m); this.attr.setXYZW(i, 0, 0, 0, 1); }
    this.mesh.instanceMatrix.needsUpdate = true; this.attr.needsUpdate = true;
    this.cursor = 0; this.full = false;
  }

  /**
   * 在 pos 处、法线为 (nx, ny, nz) 的表面上贴一个。
   * size 是边长（米），不给就用这种贴花的默认大小；两种情况都会再随机放大缩小 15%，免得一排弹孔一模一样。
   * alpha 是不透明度（沙袋、轮胎上的印子要淡一些）。
   */
  add(pos: THREE.Vector3, nx: number, ny: number, nz: number, kind: DecalKind, size?: number, alpha = 1) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % MAX;
    if (this.cursor === 0) this.full = true;
    const frames = FRAMES[kind], frame = frames[(Math.random() * frames.length) | 0];
    const s = (size ?? SIZE[kind]) * (0.85 + Math.random() * 0.3);
    _n.set(nx, ny, nz);
    // 贴到表面上，再绕法线转一个随机的角度。木头例外：只歪一点点，木刺要顺着木纹
    const turn = kind === 'wood' ? (Math.random() - 0.5) * 0.3 : Math.random() * 6.283;
    _q.setFromUnitVectors(_z, _n).multiply(_r.setFromAxisAngle(_z, turn));
    // 沿法线抬起一点；每个贴花抬的高度略有不同，叠在一起时也不会互相闪烁
    _p.copy(pos).addScaledVector(_n, 0.008 + i * 0.00003);
    this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s.set(s, s, 1)));
    // 图集第 frame 格的左下角。画布的第 0 行在上面，贴图坐标的 v = 0 在下面，所以行号要倒过来
    this.attr.setXYZW(i, (frame % COLS) / COLS, 1 - (Math.floor(frame / COLS) + 1) / ROWS, alpha, this.interior?.containsPoint(pos) ? INDOOR_SKY : 1);
    this.alpha[i] = alpha;
    // 池子满了以后：接下来要被覆盖的 14 个提前变淡，越快轮到的越淡
    if (this.full) for (let k = 0; k < FADING; k++) { const j = (this.cursor + k) % MAX; this.attr.setZ(j, (this.alpha[j] * (k + 1)) / (FADING + 1)); }
    this.mesh.instanceMatrix.needsUpdate = true; this.attr.needsUpdate = true;
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _s = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);
