import * as THREE from 'three';
import { mulberry32 } from '../core/math';

export type DecalKind = 'metal' | 'ground' | 'scorch';

const MAX = 320, LIFE = 75, FADE = 8;
// 图集是 2×2 四格：两种金属弹孔、一种地面崩坑、一种焦痕
const CELLS: Record<DecalKind, [number, number][]> = { metal: [[0, 0.5], [0.5, 0.5]], ground: [[0, 0]], scorch: [[0.5, 0]] };
const SIZE: Record<DecalKind, [number, number]> = { metal: [0.2, 0.3], ground: [0.3, 0.42], scorch: [0.5, 0.75] };

/** 画一个不规则的圆：半径在每个方向上随机抖一点。 */
function blob(g: CanvasRenderingContext2D, rnd: () => number, cx: number, cy: number, r: number, jag: number, n = 18) {
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, k = r * (1 + (rnd() - 0.5) * jag);
    if (i === 0) g.moveTo(cx + Math.cos(a) * k, cy + Math.sin(a) * k); else g.lineTo(cx + Math.cos(a) * k, cy + Math.sin(a) * k);
  }
  g.closePath();
}
function halo(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, alpha: number) {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, `rgba(${color},${alpha})`); grad.addColorStop(0.5, `rgba(${color},${alpha * 0.45})`); grad.addColorStop(1, `rgba(${color},0)`);
  g.fillStyle = grad; g.fillRect(cx - r, cy - r, r * 2, r * 2);
}

function atlas() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(77);
  // 金属弹孔：一圈烟熏 → 崩掉漆露出的亮金属 → 中间的黑洞，边上带一道受光的卷边
  for (let v = 0; v < 2; v++) {
    const cx = S * v + S / 2, cy = S / 2;
    halo(g, cx, cy, S * 0.46, '8,8,9', 0.5);
    g.fillStyle = '#8f969b'; blob(g, rnd, cx, cy, S * (0.17 + v * 0.03), 0.5); g.fill();
    g.fillStyle = '#5d6368'; blob(g, rnd, cx + 2, cy + 3, S * 0.125, 0.4); g.fill();
    g.strokeStyle = 'rgba(210,216,220,0.9)'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, S * 0.085, Math.PI * 1.05, Math.PI * 1.75); g.stroke();
    g.fillStyle = '#050505'; blob(g, rnd, cx, cy, S * 0.07, 0.3); g.fill();
    g.strokeStyle = 'rgba(20,20,20,0.6)'; g.lineWidth = 1.2;
    for (let i = 0; i < 7 + v * 3; i++) {
      const a = rnd() * 6.283, r0 = S * 0.12, r1 = S * (0.2 + rnd() * 0.16);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a + 0.05) * r1, cy + Math.sin(a + 0.05) * r1); g.stroke();
    }
  }
  // 地面崩坑：灰白的粉尘圈 + 深色的坑 + 周围溅出的碎屑
  {
    const cx = S / 2, cy = S + S / 2;
    halo(g, cx, cy, S * 0.46, '165,160,150', 0.42);
    g.fillStyle = '#3a3835'; blob(g, rnd, cx, cy, S * 0.2, 0.7, 14); g.fill();
    g.fillStyle = '#0c0c0c'; blob(g, rnd, cx + 2, cy + 2, S * 0.1, 0.6, 12); g.fill();
    for (let i = 0; i < 46; i++) {
      const a = rnd() * 6.283, r = S * (0.16 + rnd() * 0.26), k = 1 + rnd() * 3.5;
      g.fillStyle = rnd() < 0.5 ? 'rgba(190,186,176,0.75)' : 'rgba(25,25,25,0.7)';
      g.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, k, k);
    }
  }
  // 焦痕：能量弹留下的一大片放射状烧灼
  {
    const cx = S + S / 2, cy = S + S / 2;
    halo(g, cx, cy, S * 0.48, '6,5,5', 0.85);
    g.strokeStyle = 'rgba(8,7,7,0.5)';
    for (let i = 0; i < 34; i++) {
      const a = rnd() * 6.283, r1 = S * (0.24 + rnd() * 0.22);
      g.lineWidth = 1 + rnd() * 4;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,0.9)'; blob(g, rnd, cx, cy, S * 0.13, 0.5); g.fill();
    halo(g, cx, cy, S * 0.09, '120,60,30', 0.5); // 中心残留一点暗红
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/**
 * 贴花材质：一张图集里放多种图案，每个实例用 aDecal 属性（u 偏移、v 偏移、透明度）选其中一格。
 * polygonOffset 让贴花在深度上比墙面"靠前"一点点，避免和墙面抢像素而闪烁。
 */
export function decalMaterial(map: THREE.Texture, cols: number, rows: number, offset: number, roughness = 0.85) {
  const mat = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness, metalness: 0.15, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aDecal;\nvarying float vFade;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvMapUv = vMapUv * vec2(${(1 / cols).toFixed(6)}, ${(1 / rows).toFixed(6)}) + aDecal.xy;\nvFade = aDecal.z;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
  };
  mat.customProgramCacheKey = () => `decal-atlas-${cols}x${rows}`;
  return mat;
}

/**
 * 弹孔贴花。所有贴花共用一个实例化网格（一次绘制调用），循环复用：
 * 满了就覆盖最旧的；每个贴花存在一段时间后淡出。
 */
export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private attr: THREE.InstancedBufferAttribute; // 每个实例：图集偏移 u、v，透明度
  private born = new Float32Array(MAX).fill(-1e9);
  private cursor = 0; private time = 0;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDecal', this.attr);
    const mat = decalMaterial(atlas(), 2, 2, -4);
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    this.clear();
  }

  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) { this.mesh.setMatrixAt(i, _m); this.attr.setZ(i, 0); this.born[i] = -1e9; }
    this.mesh.instanceMatrix.needsUpdate = true; this.attr.needsUpdate = true;
  }

  /** 在 pos 处、法线为 n 的表面上贴一个。 */
  add(pos: THREE.Vector3, nx: number, ny: number, nz: number, kind: DecalKind) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % MAX;
    const cells = CELLS[kind], cell = cells[(Math.random() * cells.length) | 0];
    const [s0, s1] = SIZE[kind], s = s0 + Math.random() * (s1 - s0);
    _n.set(nx, ny, nz);
    _q.setFromUnitVectors(_z, _n).multiply(_r.setFromAxisAngle(_z, Math.random() * 6.283)); // 贴到表面上，再绕法线随机转个角度
    // 沿法线抬起一点；每个贴花抬的高度略有不同，叠在一起时也不会互相闪烁
    _p.copy(pos).addScaledVector(_n, 0.008 + i * 0.00003);
    this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s.set(s, s, 1)));
    this.attr.setXYZ(i, cell[0], cell[1], 1);
    this.born[i] = this.time;
    this.mesh.instanceMatrix.needsUpdate = true; this.attr.needsUpdate = true;
  }

  update(dt: number) {
    this.time += dt;
    let dirty = false;
    for (let i = 0; i < MAX; i++) {
      const cur = this.attr.getZ(i);
      if (cur <= 0) continue;
      const a = Math.min(1, Math.max(0, (LIFE - (this.time - this.born[i])) / FADE));
      if (a !== cur) { this.attr.setZ(i, a); dirty = true; }
    }
    if (dirty) this.attr.needsUpdate = true;
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _s = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);
