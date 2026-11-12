import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 机械敌人的装甲板贴图。
//
// 敌人是一块块圆角盒拼的，每个面的贴图坐标正好是 0..1 —— 于是只要画"一块装甲板"，
// 每个零件的每个面就都成了一块带压边、板缝、铆钉、散热格栅的钢板。
// 先画一张"高度图"（哪里凸、哪里凹），再由它算出法线贴图；颜色和粗糙度也参考高度：凹缝里积灰，凸起的棱边磨得发亮。

export function plating() {
  const S = 512, rng = mulberry32(2718);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return { c, g: c.getContext('2d', { willReadFrequently: true })! }; };
  const hc = mk(), h = hc.g;
  h.fillStyle = '#808080'; h.fillRect(0, 0, S, S);
  // 四周往下斜的压边，让每块板看起来是"鼓"出来的
  for (let i = 0; i < 14; i++) { const v = 60 + i * 5; h.strokeStyle = `rgb(${v},${v},${v})`; h.lineWidth = 1; h.strokeRect(i + 0.5, i + 0.5, S - i * 2 - 1, S - i * 2 - 1); }
  const groove = (x0: number, y0: number, x1: number, y1: number, w = 5) => { h.strokeStyle = '#2a2a2a'; h.lineWidth = w; h.lineCap = 'butt'; h.beginPath(); h.moveTo(x0, y0); h.lineTo(x1, y1); h.stroke(); h.strokeStyle = '#989898'; h.lineWidth = 1.5; h.beginPath(); h.moveTo(x0 + w * 0.8, y0 + w * 0.8); h.lineTo(x1 + w * 0.8, y1 + w * 0.8); h.stroke(); };
  const rivet = (x: number, y: number, r = 5) => { const gr = h.createRadialGradient(x - 1, y - 1, 0, x, y, r); gr.addColorStop(0, '#f0f0f0'); gr.addColorStop(0.7, '#b0b0b0'); gr.addColorStop(1, '#606060'); h.fillStyle = gr; h.beginPath(); h.arc(x, y, r, 0, 6.3); h.fill(); };
  // 板缝：一圈内框，一道横缝，一道只开到一半的竖缝，右上角切掉一个斜角
  h.strokeStyle = '#2a2a2a'; h.lineWidth = 4; h.strokeRect(34, 34, S - 68, S - 68);
  groove(34, 318, S - 34, 318); groove(196, 318, 196, S - 34); groove(S - 150, 34, S - 34, 150, 4);
  // 铆钉：沿内框一圈，横缝上下各一排
  for (let k = 0; k <= 8; k++) { const t = 54 + k * ((S - 108) / 8); rivet(t, 54); rivet(t, S - 54); if (k > 0 && k < 8) { rivet(54, t); rivet(S - 54, t); } }
  for (let k = 0; k < 5; k++) rivet(232 + k * 56, 340, 4);
  // 散热格栅、检修盖、一条凸筋
  for (let k = 0; k < 6; k++) { h.fillStyle = '#1c1c1c'; h.fillRect(70, 360 + k * 16, 100, 8); h.fillStyle = '#a8a8a8'; h.fillRect(70, 368 + k * 16, 100, 2); }
  h.strokeStyle = '#303030'; h.lineWidth = 4; h.beginPath(); h.arc(360, 180, 62, 0, 6.3); h.stroke();
  h.fillStyle = '#909090'; h.beginPath(); h.arc(360, 180, 58, 0, 6.3); h.fill();
  for (let k = 0; k < 6; k++) rivet(360 + Math.cos(k * 1.047) * 46, 180 + Math.sin(k * 1.047) * 46, 4);
  h.fillStyle = '#a4a4a4'; h.fillRect(70, 110, 190, 18); h.fillRect(70, 150, 190, 18); h.fillRect(70, 190, 190, 18);
  const H = h.getImageData(0, 0, S, S).data;
  const hAt = (x: number, y: number) => H[(((y + S) % S) * S + ((x + S) % S)) * 4];

  // 掉漆和划痕：单独记一层"磨损"
  const wc = mk(), w = wc.g;
  w.fillStyle = '#000'; w.fillRect(0, 0, S, S);
  w.strokeStyle = '#fff';
  for (let i = 0; i < 70; i++) { const x = rng() * S, y = rng() * S, a = rng() * 6.283, l = 8 + rng() * 60; w.globalAlpha = 0.25 + rng() * 0.6; w.lineWidth = 0.6 + rng() * 1.6; w.beginPath(); w.moveTo(x, y); w.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); w.stroke(); }
  w.fillStyle = '#fff';
  for (let i = 0; i < 260; i++) { // 棱边上磕掉的漆：集中在四周
    const e = Math.floor(rng() * 4), t = rng() * S, d = Math.pow(rng(), 2.2) * 40, x = e === 0 ? d : e === 1 ? S - d : t, y = e === 2 ? d : e === 3 ? S - d : t;
    w.globalAlpha = 0.5 + rng() * 0.5; w.beginPath(); w.ellipse(x, y, 1.5 + rng() * 6, 1 + rng() * 3.5, rng() * 3, 0, 6.3); w.fill();
  }
  const Wd = w.getImageData(0, 0, S, S).data;

  const nor = new Uint8Array(S * S * 4), col = new Uint8Array(S * S * 4), rgh = new Uint8Array(S * S * 4);
  // 手工叠几层噪声当污渍
  const G = 16, grid = new Float32Array(G * G).map(() => rng());
  const low = (x: number, y: number) => { const fx = (x / S) * G, fy = (y / S) * G, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, at = (i: number, j: number) => grid[(j % G) * G + (i % G)]; return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = ((S - 1 - y) * S + x) * 4;
    const dx = (hAt(x - 1, y) - hAt(x + 1, y)) / 255 * 2.4, dy = (hAt(x, y - 1) - hAt(x, y + 1)) / 255 * 2.4, l = Math.hypot(dx, dy, 1);
    nor[o] = (dx / l * 0.5 + 0.5) * 255; nor[o + 1] = (-dy / l * 0.5 + 0.5) * 255; nor[o + 2] = (1 / l * 0.5 + 0.5) * 255; nor[o + 3] = 255;
    const hv = hAt(x, y) / 255, wear = Wd[(y * S + x) * 4] / 255, dirt = low(x, y), pit = hv < 0.3 ? 1 : 0;
    // 颜色：漆面带一点深浅，凹缝发黑，掉漆处露出亮金属，底下三分之一溅着泥
    let v = (0.72 + dirt * 0.3) * (1 - pit * 0.6) * (1 - Math.pow(y / S, 4) * 0.35 * (0.5 + dirt));
    v = v * (1 - wear) + 1.5 * wear;
    const c8 = Math.min(255, v * 170 + rng() * 8);
    col[o] = c8; col[o + 1] = c8; col[o + 2] = c8; col[o + 3] = 255;
    const r = Math.min(1, Math.max(0.12, 0.62 + (dirt - 0.5) * 0.4 + pit * 0.25 - wear * 0.4));
    rgh[o] = rgh[o + 1] = r * 255; rgh[o + 2] = (0.55 + wear * 0.45) * 255; rgh[o + 3] = 255; // 蓝色通道是金属度：掉漆处是裸金属
  }
  const tex = (d: Uint8Array, srgb: boolean) => { const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8; t.needsUpdate = true; return t; };
  return { map: tex(col, true), normalMap: tex(nor, false), roughnessMap: tex(rgh, false) };
}
