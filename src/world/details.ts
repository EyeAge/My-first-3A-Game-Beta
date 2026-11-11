import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { decalMaterial } from '../render/decals';
import type { Colliders } from './colliders';

// 场景贴花：铭牌、喷码、警示贴、锈迹、油渍、裂缝……
// 这些小东西单个都不起眼，但没有它们，场景就只是"一堆干净的方块"。
// 做法和弹孔一样：一张图集 + 一个实例化网格，上千个贴花只要一次绘制调用。

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const COLS = 4, ROWS = 3, S = 256;
type Cell = 'plate' | 'data' | 'code' | 'tall' | 'rust' | 'grime' | 'check' | 'hazard' | 'oil' | 'crack' | 'manhole' | 'tire';
const CELL: Record<Cell, [number, number]> = {
  plate: [0, 0], data: [1, 0], code: [2, 0], tall: [3, 0],
  rust: [0, 1], grime: [1, 1], check: [2, 1], hazard: [3, 1],
  oil: [0, 2], crack: [1, 2], manhole: [2, 2], tire: [3, 2],
};

function atlas() {
  const c = document.createElement('canvas'); c.width = S * COLS; c.height = S * ROWS;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(2027);
  const cell = (k: Cell, draw: () => void) => { g.save(); g.translate(CELL[k][0] * S, CELL[k][1] * S); g.beginPath(); g.rect(0, 0, S, S); g.clip(); draw(); g.restore(); };
  const text = (s: string, x: number, y: number, size: number, weight = 700, align: CanvasTextAlign = 'left') => { g.font = `${weight} ${size}px ${FONT}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };

  // 安全检验铭牌：一块铆在门上的金属牌
  cell('plate', () => {
    g.fillStyle = '#b9bcbb'; g.fillRect(14, 30, 228, 196);
    g.strokeStyle = '#5c6062'; g.lineWidth = 3; g.strokeRect(20, 36, 216, 184);
    g.fillStyle = '#4a4d4f'; for (const [x, y] of [[28, 44], [228, 44], [28, 212], [228, 212]]) { g.beginPath(); g.arc(x, y, 4, 0, 6.3); g.fill(); }
    g.fillStyle = '#1d1f20';
    text('集装箱安全合格牌照', 128, 62, 19, 800, 'center');
    g.fillRect(30, 78, 196, 2);
    const rows = [['批准编号', 'CN/BL-3172/21'], ['制造日期', '2021年06月'], ['箱体编号', 'JZNU 317204 5'], ['最大总重', '30 480 千克'], ['堆码载荷', '192 000 千克'], ['横向试验', '150 千牛'], ['下次检验', '2028年03月']];
    rows.forEach(([a, b], i) => { text(a, 34, 96 + i * 17.5, 12, 600); text(b, 222, 96 + i * 17.5, 12, 700, 'right'); });
  });
  // 箱门上的重量数据：白色喷字
  cell('data', () => {
    g.fillStyle = 'rgba(236,234,226,0.9)';
    const rows = [['最大总重', '30 480 千克'], ['', '67 200 磅'], ['自重', '3 750 千克'], ['', '8 270 磅'], ['净重', '26 730 千克'], ['', '58 930 磅'], ['容积', '67.7 立方米']];
    rows.forEach(([a, b], i) => { text(a, 16, 34 + i * 31, 22, 700); text(b, 244, 34 + i * 31, 22, 700, 'right'); });
  });
  // 箱号
  cell('code', () => {
    g.fillStyle = 'rgba(236,234,226,0.92)';
    text('JZNU', 10, 92, 62, 900); text('317204', 10, 158, 62, 900);
    g.strokeStyle = 'rgba(236,234,226,0.92)'; g.lineWidth = 5; g.strokeRect(206, 128, 42, 60); text('5', 227, 160, 44, 900, 'center');
    text('45G1', 246, 92, 34, 800, 'right');
  });
  // 超高箱警示贴：黄底黑斜纹
  cell('tall', () => {
    g.fillStyle = '#e2b21c'; g.fillRect(8, 70, 240, 116);
    g.fillStyle = '#161616';
    for (let x = -40; x < 280; x += 36) { g.beginPath(); g.moveTo(x, 186); g.lineTo(x + 18, 186); g.lineTo(x + 46, 158); g.lineTo(x + 28, 158); g.fill(); g.beginPath(); g.moveTo(x, 98); g.lineTo(x + 18, 98); g.lineTo(x + 46, 70); g.lineTo(x + 28, 70); g.fill(); }
    text('超高箱 2.9米', 128, 129, 34, 900, 'center');
  });
  // 锈迹：从顶上一条锈线往下淌
  const streaks = (k: Cell, color: string, n: number, alpha: number) => cell(k, () => {
    for (let i = 0; i < n; i++) {
      const x = 14 + rnd() * 228, len = 60 + rnd() * 190, w = 3 + rnd() * 14;
      const grad = g.createLinearGradient(0, 0, 0, len);
      grad.addColorStop(0, `rgba(${color},${alpha})`); grad.addColorStop(0.4, `rgba(${color},${alpha * 0.5})`); grad.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(x - w / 2, 0); g.lineTo(x + w / 2, 0); g.lineTo(x + w * 0.2 + (rnd() - 0.5) * 6, len); g.lineTo(x - w * 0.2, len); g.fill();
    }
    // 顶上一条积锈的横线，两端淡出，免得贴花露出方形的边
    for (let x = 0; x < S; x += 4) { const e = Math.min(1, x / 40, (S - x) / 40), top = g.createLinearGradient(0, 0, 0, 20);
      top.addColorStop(0, `rgba(${color},${alpha * e})`); top.addColorStop(1, `rgba(${color},0)`); g.fillStyle = top; g.fillRect(x, 0, 4, 20); }
  });
  streaks('rust', '122,58,22', 16, 0.8);
  streaks('grime', '14,13,12', 20, 0.6);
  // 检验合格贴
  cell('check', () => {
    g.fillStyle = '#e9e6dc'; g.fillRect(24, 56, 208, 144);
    g.fillStyle = '#2c6b3f'; g.fillRect(24, 56, 208, 34);
    g.fillStyle = '#e9e6dc'; text('港务安全检验', 128, 74, 20, 800, 'center');
    g.fillStyle = '#1b1b1b'; text('已检验 · 准予作业', 128, 116, 20, 700, 'center'); text('四号泊位 2026年09月', 128, 146, 16, 500, 'center'); text('NO. 0042719', 128, 176, 18, 700, 'center');
  });
  // 危险品菱形标
  cell('hazard', () => {
    g.translate(128, 128); g.rotate(Math.PI / 4);
    g.fillStyle = '#c8371f'; g.fillRect(-78, -78, 156, 156);
    g.strokeStyle = '#f2ece0'; g.lineWidth = 5; g.strokeRect(-68, -68, 136, 136);
    g.rotate(-Math.PI / 4);
    g.fillStyle = '#f2ece0'; text('易燃', 0, -8, 40, 900, 'center'); text('3', 0, 62, 30, 900, 'center');
  });
  const blob = (cx: number, cy: number, r: number, jag: number) => { g.beginPath(); for (let i = 0; i <= 20; i++) { const a = (i / 20) * 6.283, k = r * (1 + (rnd() - 0.5) * jag); g.lineTo(cx + Math.cos(a) * k, cy + Math.sin(a) * k); } g.closePath(); g.fill(); };
  // 油渍
  cell('oil', () => {
    for (let i = 0; i < 9; i++) { g.fillStyle = `rgba(6,6,7,${0.22 + rnd() * 0.25})`; blob(128 + (rnd() - 0.5) * 90, 128 + (rnd() - 0.5) * 90, 26 + rnd() * 50, 0.5); }
    g.fillStyle = 'rgba(40,34,50,0.25)'; blob(120, 132, 44, 0.4);
  });
  // 路面裂缝：随机游走的折线，带几条分叉
  cell('crack', () => {
    g.strokeStyle = 'rgba(4,4,4,0.85)'; g.lineCap = 'round';
    const walk = (x: number, y: number, a: number, n: number, w: number) => {
      for (let i = 0; i < n; i++) {
        const nx = x + Math.cos(a) * 16, ny = y + Math.sin(a) * 16;
        g.lineWidth = w * (1 - i / n) + 0.6; g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
        if (rnd() < 0.22 && w > 1.5) walk(nx, ny, a + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), 5, w * 0.6);
        x = nx; y = ny; a += (rnd() - 0.5) * 0.9;
      }
    };
    walk(20, 40, 0.5, 15, 3.2); walk(60, 230, -0.9, 12, 2.6);
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
  // 轮胎印：两道平行的拖痕
  cell('tire', () => {
    for (const x of [70, 186]) for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(5,5,5,${0.1 + rnd() * 0.3})`;
      g.fillRect(x - 20 + rnd() * 6, i * 6.4, 34 + rnd() * 6, 4.5);
    }
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export interface BoxSpec { x: number; y: number; z: number; rot: number }

/**
 * 给场景贴上细节。containers 是堆场里的集装箱，W/H/L 是箱体尺寸，bounds 是可活动范围。
 * 用单独的随机数种子，不会打乱集装箱本身的布局。
 */
export function buildDetails(containers: BoxSpec[], W: number, H: number, L: number, colliders: Colliders, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
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

  // ---- 集装箱
  for (const c of containers) {
    const ax = c.rot ? 1 : 0, az = c.rot ? 0 : 1; // 箱子长轴方向
    for (const s of [-1, 1]) {
      // 长侧面
      const nx = az * s, nz = ax * s;
      const fx = c.x + nx * W / 2, fz = c.z + nz * W / 2;
      if (!colliders.pointInside(fx + nx * 0.4, c.y, fz + nz * 0.4)) { // 被隔壁箱子挡住的面就不贴了
        const along = (d: number): [number, number] => [fx + ax * d, fz + az * d];
        let [x, z] = along(s * (L / 2 - 1.3) * (ax ? -1 : 1));
        wall('code', x, c.y + 0.72, z, nx, nz, 1.25, 1.25);
        if (rng() < 0.3) { [x, z] = along(-s * (L / 2 - 1.2) * (ax ? -1 : 1)); wall('tall', x, c.y + 0.95, z, nx, nz, 0.75, 0.75); }
        if (rng() < 0.12) { [x, z] = along((rng() - 0.5) * 3 + L / 2 - 3.2); wall('hazard', x, c.y - 0.2, z, nx, nz, 0.5, 0.5); }
        for (let k = 0, n = Math.floor(rng() * 3); k < n; k++) {
          const h = 1.0 + rng() * 1.4, w = 0.7 + rng() * 1.1;
          [x, z] = along((rng() - 0.5) * (L - 1.4));
          wall(rng() < 0.6 ? 'rust' : 'grime', x, c.y + H / 2 - h / 2 - 0.02, z, nx, nz, w, h);
        }
      }
      // 端面：+端是箱门
      const ex = c.x + ax * s * L / 2, ez = c.z + az * s * L / 2, enx = ax * s, enz = az * s;
      if (!colliders.pointInside(ex + enx * 0.4, c.y, ez + enz * 0.4)) {
        const side = (d: number): [number, number] => [ex + az * d, ez + ax * d];
        if (s > 0) {
          let [x, z] = side(0.62 * (ax ? -1 : 1)); wall('plate', x, c.y - 0.35, z, enx, enz, 0.42, 0.42);
          [x, z] = side(-0.6 * (ax ? -1 : 1)); wall('data', x, c.y - 0.1, z, enx, enz, 0.8, 0.8);
          if (rng() < 0.45) { [x, z] = side(0.6 * (ax ? -1 : 1)); wall('check', x, c.y + 0.5, z, enx, enz, 0.36, 0.36); }
        }
        if (rng() < 0.5) { const h = 1 + rng() * 1.2; const [x, z] = side((rng() - 0.5) * 1.2); wall(rng() < 0.6 ? 'rust' : 'grime', x, c.y + H / 2 - h / 2 - 0.02, z, enx, enz, 0.8 + rng() * 0.8, h); }
      }
    }
  }

  // ---- 围墙和仓库外墙上的水渍
  for (let x = bounds.minX + 3; x < bounds.maxX - 3; x += 3 + rng() * 6) {
    const h = 1.6 + rng() * 2.2;
    wall('grime', x, 4.4 - h / 2, bounds.minZ, 0, 1, 1.2 + rng() * 1.6, h);
    wall('grime', x + 2, 4.4 - h / 2, bounds.maxZ, 0, -1, 1.2 + rng() * 1.6, h);
  }
  for (let z = bounds.minZ + 3; z < bounds.maxZ - 3; z += 3 + rng() * 6) { const h = 1.6 + rng() * 2.2; wall('grime', bounds.minX, 4.4 - h / 2, z, 1, 0, 1.2 + rng() * 1.6, h); }
  for (let z = -34; z < 34; z += 2.5 + rng() * 4) { const h = 2.5 + rng() * 4; wall(rng() < 0.5 ? 'rust' : 'grime', -74, 11 - h / 2, z, 1, 0, 1.4 + rng() * 2, h); }

  // ---- 地面：油渍、裂缝、井盖、轮胎印
  const free = (x: number, z: number, r: number) => !colliders.pointInside(x, 0.3, z) && !colliders.pointInside(x + r, 0.3, z) && !colliders.pointInside(x - r, 0.3, z) && !colliders.pointInside(x, 0.3, z + r) && !colliders.pointInside(x, 0.3, z - r);
  for (let i = 0; i < 260; i++) {
    const x = bounds.minX + 4 + rng() * (bounds.maxX - bounds.minX - 8), z = bounds.minZ + 4 + rng() * (bounds.maxZ - bounds.minZ - 8), k = rng();
    const s = k < 0.5 ? 1.4 + rng() * 2.6 : 2.2 + rng() * 3;
    if (free(x, z, s * 0.4)) floor(k < 0.5 ? 'oil' : 'crack', x, z, s, s, rng() * 6.283);
  }
  for (let i = 0; i < 44; i++) { // 轮胎印集中在主干道和码头前沿
    const road = rng() < 0.6, x = road ? -24 + rng() * 12 : 30 + rng() * 28, z = bounds.minZ + 8 + rng() * (bounds.maxZ - bounds.minZ - 16);
    if (free(x, z, 1.2)) floor('tire', x, z, 2.4, 5 + rng() * 5, (rng() - 0.5) * 0.25);
  }
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
