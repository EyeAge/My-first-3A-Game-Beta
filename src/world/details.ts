import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { decalMaterial } from '../render/decals';
import type { Colliders } from './colliders';

// 场景贴花：围墙上的水渍和地上的井盖。
// 这些小东西单个都不起眼，但没有它们，场景就只是"一堆干净的方块"。
// 做法和弹孔一样：一张图集 + 一个实例化网格，几百个贴花只要一次绘制调用。
// （集装箱身上的喷字和锈水条不在这里，它们是每只箱子模型的一部分，见 container.ts。）
//
// 地面上的油渍、裂缝、轮胎印以前也是这里随机撒的贴花，现在改由地面着色器（ground.ts）来画：
// 贴花是浮在地面上的一张不透明的纸，盖在水洼上会把镜面遮出一个哑光的方块；画进着色器里，它们才会被水淹、会反光。

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
// 图集只有左右两格，每格 256 像素见方
const COLS = 2, ROWS = 1, S = 256;
type Cell = 'grime' | 'manhole';
const CELL: Record<Cell, [number, number]> = {
  grime: [0, 0], manhole: [1, 0],
};

function atlas() {
  const c = document.createElement('canvas'); c.width = S * COLS; c.height = S * ROWS;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(2027);
  const cell = (k: Cell, draw: () => void) => { g.save(); g.translate(CELL[k][0] * S, CELL[k][1] * S); g.beginPath(); g.rect(0, 0, S, S); g.clip(); draw(); g.restore(); };
  const text = (s: string, x: number, y: number, size: number, weight = 700, align: CanvasTextAlign = 'left') => { g.font = `${weight} ${size}px ${FONT}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };

  // 水渍：墙顶一条积灰的横线，往下淌出一道道深色的水痕
  cell('grime', () => {
    const color = '14,13,12', alpha = 0.6;
    for (let i = 0; i < 20; i++) {
      const x = 14 + rnd() * 228, len = 60 + rnd() * 190, w = 3 + rnd() * 14;
      const grad = g.createLinearGradient(0, 0, 0, len);
      grad.addColorStop(0, `rgba(${color},${alpha})`); grad.addColorStop(0.4, `rgba(${color},${alpha * 0.5})`); grad.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(x - w / 2, 0); g.lineTo(x + w / 2, 0); g.lineTo(x + w * 0.2 + (rnd() - 0.5) * 6, len); g.lineTo(x - w * 0.2, len); g.fill();
    }
    // 顶上那条横线两端淡出，免得贴花露出方形的边
    for (let x = 0; x < S; x += 4) { const e = Math.min(1, x / 40, (S - x) / 40), top = g.createLinearGradient(0, 0, 0, 20);
      top.addColorStop(0, `rgba(${color},${alpha * e})`); top.addColorStop(1, `rgba(${color},0)`); g.fillStyle = top; g.fillRect(x, 0, 4, 20); }
  });
  // 井盖
  cell('manhole', () => {
    g.fillStyle = '#17191a'; g.beginPath(); g.arc(128, 128, 118, 0, 6.3); g.fill();
    g.fillStyle = '#3a3d3e'; g.beginPath(); g.arc(128, 128, 108, 0, 6.3); g.fill();
    g.strokeStyle = '#1c1e1f'; g.lineWidth = 6;
    for (let i = -4; i <= 4; i++) { g.beginPath(); g.moveTo(128 + i * 22, 40); g.lineTo(128 + i * 22, 216); g.stroke(); g.beginPath(); g.moveTo(40, 128 + i * 22); g.lineTo(216, 128 + i * 22); g.stroke(); }
    g.lineWidth = 10; g.strokeStyle = '#17191a'; g.beginPath(); g.arc(128, 128, 104, 0, 6.3); g.stroke();
    g.fillStyle = '#3a3d3e'; g.fillRect(74, 110, 108, 36); g.fillStyle = '#121314'; text('雨水 · 四号泊位', 128, 129, 15, 800, 'center');
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/**
 * 给场景贴上细节：围墙上的水渍和地上的井盖。bounds 是可活动范围。
 * colliders 用来避开被东西压着的地方，所以要等集装箱、道具的碰撞盒都登记完了再调。
 * （集装箱身上的喷字、合格牌、锈水条不在这里：它们跟着每只箱子的模型走，见 container.ts。）
 */
export function buildDetails(colliders: Colliders, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const rng = mulberry32(9917);
  const list: { m: THREE.Matrix4; cell: Cell }[] = [];
  const q = new THREE.Quaternion(), qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2), Y = new THREE.Vector3(0, 1, 0);
  /** 竖直面上的贴花：(nx,nz) 是面的朝向。 */
  const wall = (cell: Cell, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number) => {
    q.setFromAxisAngle(Y, Math.atan2(nx, nz));
    list.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x + nx * 0.006, y, z + nz * 0.006), q, new THREE.Vector3(w, h, 1)), cell });
  };
  const floor = (cell: Cell, x: number, z: number, w: number, l: number, ang: number) => {
    q.setFromAxisAngle(Y, ang).multiply(qx);
    list.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, 0.006 + list.length * 0.000002, z), q, new THREE.Vector3(w, l, 1)), cell });
  };

  // ---- 围墙上的水渍（车间和库房的外墙有自己的做旧，不用这里的贴花）
  for (let x = bounds.minX + 3; x < bounds.maxX - 3; x += 3 + rng() * 6) {
    const h = 1.6 + rng() * 2.2;
    wall('grime', x, 4.4 - h / 2, bounds.minZ, 0, 1, 1.2 + rng() * 1.6, h);
    const w = 1.2 + rng() * 1.6;
    // 南围墙在大门那里断开了：先看看这个位置的墙后面是不是实心的，门洞里不贴（不然水渍会悬在半空）
    if (colliders.pointInside(x + 2, 2, bounds.maxZ + 0.6)) wall('grime', x + 2, 4.4 - h / 2, bounds.maxZ, 0, -1, w, h);
  }
  for (let z = bounds.minZ + 3; z < bounds.maxZ - 3; z += 3 + rng() * 6) { const h = 1.6 + rng() * 2.2; wall('grime', bounds.minX, 4.4 - h / 2, z, 1, 0, 1.2 + rng() * 1.6, h); }

  // ---- 地面：井盖。位置和 groundmask.ts 里的 MANHOLES 是同一张表——那边把井盖脚下的路面垫高了一点，保证井盖不会泡在水洼里
  const free = (x: number, z: number, r: number) => !colliders.pointInside(x, 0.3, z) && !colliders.pointInside(x + r, 0.3, z) && !colliders.pointInside(x - r, 0.3, z) && !colliders.pointInside(x, 0.3, z + r) && !colliders.pointInside(x, 0.3, z - r);
  for (const [x, z] of [[-21, 72], [-15, 30], [-21, -10], [-15, -52], [-21, -88], [30, 54], [30, -30], [52, 14], [52, -66], [-66, 8]]) if (free(x, z, 0.6)) floor('manhole', x, z, 0.95, 0.95, 0);

  const geo = new THREE.PlaneGeometry(1, 1);
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
  geo.setAttribute('aDecal', attr);
  const mesh = new THREE.InstancedMesh(geo, decalMaterial(atlas(), COLS, ROWS, -2, 0.6), list.length);
  list.forEach((d, i) => {
    mesh.setMatrixAt(i, d.m);
    attr.setXYZ(i, CELL[d.cell][0] / COLS, 1 - (CELL[d.cell][1] + 1) / ROWS, 1);
  });
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  return mesh;
}
