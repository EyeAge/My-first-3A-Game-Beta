import * as THREE from 'three';
import { fbm, mulberry32, vnoise } from '../core/math';

// 集装箱：真的波纹板几何 + 分层贴图。
//
// 以前的箱子是一个方盒子贴一张"画着波纹"的图，侧光一打就露馅。现在侧板、前端板、箱门都是按真实截面
// 折出来的梯形波纹，角柱、上下纵梁、角件也是立体的，所以灯光能在每一道棱上勾出明暗。
//
// 贴图分两层画，最后合成一张：
//   · 漆面层：灰度的"漆"，会被每个箱子自己的颜色染色（一张图就能出十种颜色的箱子）
//   · 覆盖层：不该被染色的东西 —— 白色喷字、黄黑警示贴、铁锈、刮掉漆露出的底材
// 合成后贴图的 alpha 通道记录"这里有多少是漆"，着色器按它决定染不染色。

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export const RIBS = 44;        // 侧板波纹数
const POST = 0.15;             // 角柱边长
const DEPTH = 0.036;           // 波纹深度

/** 一个波纹周期里的截面：t 是 0..1，返回凹进去的比例 0..1。左右对称，这样箱子两侧能共用一张贴图。 */
export function ribProfile(t: number) {
  t = t - Math.floor(t);
  if (t < 0.15 || t > 0.85) return 0;
  if (t < 0.3) return (t - 0.15) / 0.15;
  if (t > 0.7) return (0.85 - t) / 0.15;
  return 1;
}
const KNOTS = [0, 0.15, 0.3, 0.7, 0.85, 1];

// ------------------------------------------------------------------ 几何
/** 材质分组：0 侧板，1 框架和前端板，2 箱顶，3 箱门。 */
export function containerGeometry(W: number, H: number, L: number) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[][] = [[], [], [], []];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  type P = [number, number, number];
  /** 一个四边形。hint 是大致的朝外方向，绕序反了会自动翻过来。 */
  const quad = (p: P[], t: [number, number][], g: number, hint: P) => {
    a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]); b.set(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
    n.crossVectors(a, b).normalize();
    const flip = n.x * hint[0] + n.y * hint[1] + n.z * hint[2] < 0;
    if (flip) n.negate();
    const base = pos.length / 3;
    for (let i = 0; i < 4; i++) { pos.push(...p[i]); nor.push(n.x, n.y, n.z); uv.push(...t[i]); }
    idx[g].push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
  };
  /** 框架用的方钢。贴图按米平铺。 */
  const bar = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, g = 1) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2, k = 0.5;
    const face = (p: P[], hint: P, u: number, v: number) => quad(p, [[0, 0], [u * k, 0], [u * k, v * k], [0, v * k]], g, hint);
    face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], sz, sy);
    face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], sz, sy);
    face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], sx, sz);
    face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], sx, sz);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], sx, sy);
    face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], sx, sy);
  };

  const hw = W / 2, hh = H / 2, hl = L / 2;
  const yb = -hh + 0.16, yt = hh - 0.11;

  // 两块侧板
  for (const s of [-1, 1]) {
    const z0 = -hl + POST, len = L - POST * 2, per = len / RIBS;
    const u = (z: number) => (s > 0 ? (hl - z) / L : (z + hl) / L), v = (y: number) => (y + hh) / H;
    for (let r = 0; r < RIBS; r++) for (let k = 0; k < 5; k++) {
      const za = z0 + (r + KNOTS[k]) * per, zb = z0 + (r + KNOTS[k + 1]) * per;
      const da = k === 2 || k === 3 ? DEPTH : 0, db = k === 1 || k === 2 ? DEPTH : 0;
      const x0 = s * (hw - 0.012 - da), x1 = s * (hw - 0.012 - db);
      quad([[x0, yb, za], [x1, yb, zb], [x1, yt, zb], [x0, yt, za]], [[u(za), v(yb)], [u(zb), v(yb)], [u(zb), v(yt)], [u(za), v(yt)]], 0, [s, 0, 0]);
    }
    // 上下纵梁
    bar(s * (hw - 0.03), -hh + 0.08, 0, 0.06, 0.16, L - POST * 2);
    bar(s * (hw - 0.035), hh - 0.055, 0, 0.07, 0.11, L - POST * 2);
  }
  // 四根角柱、八个角件（角件比箱体略微凸出一点，轮廓上能看到）
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    bar(sx * (hw - POST / 2), 0, sz * (hl - POST / 2), POST, H - 0.24, POST);
    for (const sy of [-1, 1]) bar(sx * (hw - 0.084), sy * (hh - 0.059), sz * (hl - 0.079), 0.18, 0.118, 0.17);
  }
  // 前端板：竖向波纹
  {
    const x0 = -hw + POST, len = W - POST * 2, N = 8, per = len / N, z = -hl + 0.014;
    for (let r = 0; r < N; r++) for (let k = 0; k < 5; k++) {
      const xa = x0 + (r + KNOTS[k]) * per, xb = x0 + (r + KNOTS[k + 1]) * per;
      const da = k === 2 || k === 3 ? DEPTH : 0, db = k === 1 || k === 2 ? DEPTH : 0;
      quad([[xa, yb, z + da], [xb, yb, z + db], [xb, yt, z + db], [xa, yt, z + da]], [[xa * 0.5, yb * 0.5], [xb * 0.5, yb * 0.5], [xb * 0.5, yt * 0.5], [xa * 0.5, yt * 0.5]], 1, [0, 0, -1]);
    }
    bar(0, -hh + 0.08, -hl + 0.06, W - POST * 2, 0.16, 0.12);
    bar(0, hh - 0.055, -hl + 0.05, W - POST * 2, 0.11, 0.1);
  }
  // 箱门：两扇门，每扇是横向的浅波纹；门槛、门楣、中缝的压条、铰链
  {
    const z = hl - 0.03, d = 0.016, N = 5, y0 = -hh + 0.15, y1 = hh - 0.12, per = (y1 - y0) / N;
    const u = (x: number) => (x + hw) / W, v = (y: number) => (y + hh) / H;
    for (const s of [-1, 1]) {
      const xa = s * 0.012, xb = s * (hw - POST + 0.01);
      for (let r = 0; r < N; r++) for (let k = 0; k < 5; k++) {
        const ya = y0 + (r + KNOTS[k]) * per, yc = y0 + (r + KNOTS[k + 1]) * per;
        const da = k === 2 || k === 3 ? d : 0, db = k === 1 || k === 2 ? d : 0;
        quad([[xa, ya, z - da], [xb, ya, z - da], [xb, yc, z - db], [xa, yc, z - db]], [[u(xa), v(ya)], [u(xb), v(ya)], [u(xb), v(yc)], [u(xa), v(yc)]], 3, [0, 0, 1]);
      }
      for (const hy of [-0.92, -0.32, 0.32, 0.92]) bar(s * (hw - POST + 0.02), hy, hl - 0.02, 0.1, 0.07, 0.03); // 铰链
    }
    bar(0.014, 0, hl - 0.022, 0.05, y1 - y0, 0.02);          // 中缝压条
    bar(0, -hh + 0.075, hl - 0.06, W - POST * 2, 0.15, 0.12); // 门槛
    bar(0, hh - 0.06, hl - 0.06, W - POST * 2, 0.12, 0.12);   // 门楣
  }
  // 箱顶和箱底
  quad([[-hw + 0.02, hh - 0.012, hl - 0.02], [hw - 0.02, hh - 0.012, hl - 0.02], [hw - 0.02, hh - 0.012, -hl + 0.02], [-hw + 0.02, hh - 0.012, -hl + 0.02]], [[0, 0], [0, 1], [1, 1], [1, 0]], 2, [0, 1, 0]);
  quad([[-hw + 0.02, -hh + 0.03, hl - 0.02], [hw - 0.02, -hh + 0.03, hl - 0.02], [hw - 0.02, -hh + 0.03, -hl + 0.02], [-hw + 0.02, -hh + 0.03, -hl + 0.02]], [[0, 0], [1, 0], [1, 6], [0, 6]], 1, [0, -1, 0]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const all: number[] = [];
  idx.forEach((list, i) => { g.addGroup(all.length, list.length, i); all.push(...list); });
  g.setIndex(all);
  return g;
}

// ------------------------------------------------------------------ 贴图
export function canvas(w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return { c, g: c.getContext('2d', { willReadFrequently: true })! };
}
export function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export interface Layers { W: number; H: number; paint: CanvasRenderingContext2D; over: CanvasRenderingContext2D }
export function layers(W: number, H: number, base: number): Layers {
  const p = canvas(W, H), o = canvas(W, H);
  p.g.fillStyle = `rgb(${base},${base},${base})`; p.g.fillRect(0, 0, W, H);
  return { W, H, paint: p.g, over: o.g };
}

/**
 * 把两层合成一张颜色贴图和一张粗糙度贴图。
 * dirt 控制整体脏的程度；shade(x, y) 返回 0..1 的额外压暗（用来画波纹凹槽里的阴影）。
 */
export function compose(l: Layers, seed: number, dirt: number, shade: (x: number, y: number) => number, repeat = false) {
  const { W, H } = l;
  const P = l.paint.getImageData(0, 0, W, H).data, O = l.over.getImageData(0, 0, W, H).data;
  const map = new Uint8Array(W * H * 4), rough = new Uint8Array(W * H * 4);
  const rng = mulberry32(seed * 131 + 7);
  for (let y = 0; y < H; y++) {
    const fy = y / H, row = (H - 1 - y) * W; // 画布的第一行是顶，贴图的第一行是底
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, o = (row + x) * 4;
      const a = O[i + 3] / 255;
      const big = fbm(x / 170 + seed, y / 120 + seed * 1.7, 3);           // 大片的深浅不匀
      const run = vnoise(x / 5 + seed * 3, y / 260);                       // 竖向的雨痕
      const grit = rng();
      const sh = shade(x, y);
      // 越靠下越脏；凹槽里也更脏
      const k = (1 - dirt * (0.55 * big + 0.3 * run * (0.3 + fy) + 0.25 * fy * fy * fy)) * (1 - sh * 0.3) * (0.96 + grit * 0.08);
      map[o] = (P[i] * (1 - a) + O[i] * a) * k;
      map[o + 1] = (P[i + 1] * (1 - a) + O[i + 1] * a) * k;
      map[o + 2] = (P[i + 2] * (1 - a) + O[i + 2] * a) * k;
      map[o + 3] = (1 - a) * 255;
      // 粗糙度：漆面被雨打湿所以偏光滑，雨痕处更滑；锈是哑光的
      const rusty = a > 0.15 && O[i] > O[i + 2] * 1.7 && O[i] < 130 ? a : 0;
      let r = 0.4 + (big - 0.5) * 0.35 - (run > 0.62 ? 0.16 : 0) + sh * 0.1 + grit * 0.06;
      r = r * (1 - rusty) + 0.92 * rusty;
      rough[o] = rough[o + 1] = Math.max(20, Math.min(255, r * 255)); rough[o + 2] = 255; rough[o + 3] = 255; // R 通道顺便当凹凸贴图用
    }
  }
  return { map: dataTexture(map, W, H, true, repeat), rough: dataTexture(rough, W, H, false, repeat) };
}

const RUST = ['58,31,15', '74,41,19', '43,25,13'];
/** 从 (x, y) 往下淌的一道锈水。 */
export function rustRun(g: CanvasRenderingContext2D, rng: () => number, x: number, y: number, len: number, w: number, alpha: number) {
  const gr = g.createLinearGradient(0, y, 0, y + len), col = RUST[Math.floor(rng() * RUST.length)];
  gr.addColorStop(0, `rgba(${col},${alpha})`); gr.addColorStop(0.35, `rgba(${col},${alpha * 0.55})`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(x - w / 2, y); g.lineTo(x + w / 2, y); g.lineTo(x + w * 0.18 + (rng() - 0.5) * 3, y + len); g.lineTo(x - w * 0.18, y + len); g.fill();
}
/** 一块锈斑：一堆大小不一的小圆点聚在一起，边缘是碎的。 */
export function rustPatch(g: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, r: number) {
  for (let i = 0; i < 34; i++) {
    const a = rng() * 6.283, d = Math.pow(rng(), 0.6) * r, k = (1 - d / r) * r * 0.3 + 0.6;
    g.fillStyle = `rgba(${RUST[Math.floor(rng() * RUST.length)]},${0.3 + rng() * 0.45})`;
    g.beginPath(); g.ellipse(cx + Math.cos(a) * d * 1.4, cy + Math.sin(a) * d, k * 1.2, k, 0, 0, 6.283); g.fill();
  }
}
/** 黄黑斜纹警示贴。 */
export function hazardTape(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#d9a916'; g.fillRect(x, y, w, h);
  g.fillStyle = '#141414';
  for (let k = -h; k < w + h; k += h * 0.9) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h * 0.45, y + h); g.lineTo(x + k + h * 1.45, y); g.lineTo(x + k + h, y); g.fill(); }
  g.restore();
}

export interface Brand { name: string; sub: string; mark: number }

/** 侧板贴图。1 像素约 6 毫米，贴近了看喷字也是清楚的。 */
export function sideTextures(brand: Brand | null, seed: number, L: number) {
  const TW = 2048, TH = 512;
  const l = layers(TW, TH, 196), p = l.paint, o = l.over;
  const rng = mulberry32(seed * 977 + 5);
  // 补过漆的地方：颜色和周围略有出入的方块
  for (let i = 0; i < 7; i++) {
    const v = 196 + (rng() - 0.5) * 44;
    p.fillStyle = `rgba(${v},${v},${v},0.8)`;
    p.fillRect(rng() * TW, 40 + rng() * 380, 60 + rng() * 260, 50 + rng() * 200);
  }
  // 喷字
  const white = 'rgba(232,230,222,0.9)';
  o.textBaseline = 'middle';
  if (brand) {
    const x0 = 250 + (seed % 3) * 60, cy = 250;
    o.fillStyle = white; o.strokeStyle = white;
    // 公司标：一个环加几道斜杠，每家不一样
    o.lineWidth = 15; o.beginPath(); o.arc(x0, cy, 82, 0, 6.283); o.stroke();
    o.save(); o.beginPath(); o.arc(x0, cy, 70, 0, 6.283); o.clip();
    for (let k = 0; k < 2 + brand.mark; k++) { o.save(); o.translate(x0 - 60 + k * (110 / (1 + brand.mark)), cy); o.rotate(brand.mark % 2 ? -0.5 : 0.5); o.fillRect(-10, -100, 20, 200); o.restore(); }
    o.restore();
    o.font = `900 172px ${FONT}`; o.fillText(brand.name, x0 + 130, cy - 26);
    o.font = `600 40px ${FONT}`; o.fillText(brand.sub, x0 + 136, cy + 92);
  } else {
    o.fillStyle = white; o.font = `800 54px ${FONT}`; o.fillText('租箱 · 激战箱管', 150, 110);
  }
  // 右上角：箱号、箱型代码、重量数据
  o.fillStyle = white;
  o.font = `800 46px ${MONO}`; o.fillText(`JZNU ${317204 + seed * 1373}`, 1560, 62);
  o.lineWidth = 4; o.strokeStyle = white; o.strokeRect(1936, 38, 38, 48); o.font = `800 40px ${MONO}`; o.fillText(String(seed % 10), 1943, 64);
  o.font = `800 40px ${MONO}`; o.fillText('45G1', 1836, 116);
  o.font = `600 19px ${FONT}`;
  ['最大总重  30 480 千克', '箱体自重    3 750 千克', '最大载重  26 730 千克', '容　　积    67.7 立方米'].forEach((s, i) => o.fillText(s, 1562, 160 + i * 25));
  // 超高箱警示贴：两头的上角各一张
  for (const x of [34, TW - 34 - 112]) { hazardTape(o, x, 30, 112, 46); o.fillStyle = '#141414'; o.font = `900 19px ${FONT}`; o.textAlign = 'center'; o.fillStyle = '#d9a916'; o.fillRect(x + 12, 41, 88, 24); o.fillStyle = '#141414'; o.fillText('超高 2.9米', x + 56, 54); o.textAlign = 'left'; }
  if (seed % 3 === 0) { // 危险品菱形标
    o.save(); o.translate(1420, 330); o.rotate(Math.PI / 4); o.fillStyle = '#b8341d'; o.fillRect(-42, -42, 84, 84); o.strokeStyle = '#efe9dc'; o.lineWidth = 3; o.strokeRect(-36, -36, 72, 72); o.rotate(-Math.PI / 4);
    o.fillStyle = '#efe9dc'; o.textAlign = 'center'; o.font = `900 24px ${FONT}`; o.fillText('易燃', 0, -4); o.font = `900 18px ${FONT}`; o.fillText('3', 0, 34); o.restore();
  }
  // 磕碰刮擦：吊装和堆码时蹭掉漆的横向划痕，露出浅色底漆，边上很快就锈了
  for (let i = 0; i < 16; i++) {
    const x = rng() * TW, y = 60 + rng() * 400, len = 30 + rng() * 150;
    o.strokeStyle = `rgba(150,140,128,${0.25 + rng() * 0.35})`; o.lineWidth = 1 + rng() * 2.5;
    o.beginPath(); o.moveTo(x, y); o.lineTo(x + len, y + (rng() - 0.5) * 10); o.stroke();
    if (rng() < 0.6) { rustPatch(o, rng, x + len * rng(), y, 4 + rng() * 9); rustRun(o, rng, x + len * rng(), y, 30 + rng() * 120, 3 + rng() * 5, 0.5); }
  }
  // 锈水：从上纵梁往下淌；底边一圈因为积水锈得最重
  for (let i = 0; i < 44; i++) rustRun(o, rng, rng() * TW, 14 + rng() * 6, 40 + rng() * 240, 3 + rng() * 11, 0.3 + rng() * 0.45);
  for (let i = 0; i < 60; i++) rustPatch(o, rng, rng() * TW, TH - 28 + rng() * 14, 4 + rng() * 10);
  for (let i = 0; i < 9; i++) rustPatch(o, rng, rng() * TW, 40 + rng() * 420, 3 + rng() * 7);
  // 波纹凹槽里的阴影，和几何的波纹一一对应
  const z0 = POST / L, span = 1 - z0 * 2;
  const groove = new Float32Array(TW);
  for (let x = 0; x < TW; x++) { const t = (x / TW - z0) / span; groove[x] = t < 0 || t > 1 ? 0 : ribProfile(t * RIBS); }
  return compose(l, seed, 0.5, (x) => groove[x]);
}

/** 箱门贴图。 */
export function doorTextures(seed: number) {
  const S = 512;
  const l = layers(S, S, 190), o = l.over;
  const rng = mulberry32(seed * 311 + 3);
  const white = 'rgba(232,230,222,0.9)';
  o.fillStyle = white; o.textBaseline = 'middle';
  o.font = `800 30px ${MONO}`; o.fillText(`JZNU ${317204 + seed * 1373}`, 276, 76);
  o.font = `800 26px ${MONO}`; o.fillText(`45G1   ${seed % 10}`, 276, 110);
  for (let i = 0; i < 22; i++) rustRun(o, rng, rng() * S, 28 + rng() * 10, 40 + rng() * 200, 3 + rng() * 9, 0.3 + rng() * 0.4);
  for (let i = 0; i < 18; i++) rustPatch(o, rng, rng() * S, S - 40 + rng() * 14, 4 + rng() * 10);
  for (const x of [38, S - 38]) for (const y of [70, 190, 320, 440]) { rustPatch(o, rng, x, y, 6 + rng() * 6); rustRun(o, rng, x, y, 40 + rng() * 60, 6, 0.5); } // 铰链处
  for (let i = 0; i < 8; i++) rustPatch(o, rng, rng() * S, 60 + rng() * 380, 3 + rng() * 8);
  return compose(l, seed + 40, 0.5, () => 0);
}

/** 框架、角柱、端板用的漆面：可以平铺。框架是箱子上磕碰最多的地方，所以锈和掉漆也最多。 */
export function frameTextures() {
  const S = 256;
  const l = layers(S, S, 150), o = l.over;
  const rng = mulberry32(51);
  for (let i = 0; i < 26; i++) rustPatch(o, rng, rng() * S, rng() * S, 2 + rng() * 7);
  for (let i = 0; i < 30; i++) { o.fillStyle = `rgba(150,140,128,${0.2 + rng() * 0.4})`; o.fillRect(rng() * S, rng() * S, 2 + rng() * 14, 1 + rng() * 2); }
  return compose(l, 9, 0.35, () => 0, true);
}

/** 让材质按贴图的 alpha 通道决定"染不染箱体颜色"。 */
export function tintByAlpha<T extends THREE.Material>(mat: T) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', /* glsl */ `
      #ifdef USE_COLOR
        diffuseColor.rgb *= mix(vec3(1.0), vColor, diffuseColor.a);
      #endif
      diffuseColor.a = 1.0;`);
  };
  mat.customProgramCacheKey = () => 'tint-by-alpha';
  return mat;
}
