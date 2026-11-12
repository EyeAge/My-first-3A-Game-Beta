import * as THREE from 'three';

// "捏泥巴"式建模：先用一堆圆头锥（两头粗细不同的胶囊）描述形状，再把它们融合成一整块，最后在外面包一层连续的表面。
//
// 和"一节一节拼零件"的区别在于融合：两个靠近的锥体之间不是硬生生相交，而是像两滴水碰到一起那样长出一段过渡，
// 所以指根之间会有蹼、虎口是连着的、手背到手指是顺下来的 —— 手这类有机形状需要的正是这个。
//
// 做法分两步：
//   1. 距离场：空间里每个点到"这团泥"表面的距离，里面为负、外面为正。多个锥体用"平滑取最小值"合并。
//   2. 表面网（surface nets）：把空间切成小格子，凡是有的角在里面、有的角在外面的格子，表面一定穿过它，
//      在里面放一个顶点；相邻的这种格子连成四边形，就得到了表面。

export type Cone = [THREE.Vector3, THREE.Vector3, number, number, number?]; // 两个端点和各自的半径；第五项是这一段自己的"粘度"
/** 一道褶子：在 at 这个位置、垂直于 dir 方向，往里压一条细沟（指关节弯曲处的皱褶）。只影响 at 周围 reach 以内。 */
export type Groove = [at: THREE.Vector3, dir: THREE.Vector3, reach: number, depth: number];

/** 点到圆头锥表面的距离（Inigo Quilez 的 sdRoundCone）。 */
function coneDist(px: number, py: number, pz: number, c: Cone) {
  const a = c[0], b = c[1], r1 = c[2], r2 = c[3];
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z, l2 = bax * bax + bay * bay + baz * baz;
  const pax = px - a.x, pay = py - a.y, paz = pz - a.z;
  if (l2 < 1e-6) return Math.hypot(pax, pay, paz) - Math.max(r1, r2);
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y, qz = paz * l2 - baz * y, x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2, z2 = z * z * l2, k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

/**
 * 把一组圆头锥融合成一个网格。
 * blend 是融合的"粘度"（毫米）：越大，相邻的锥体之间长出来的过渡越宽。每一段也可以自带粘度 ——
 * 手掌要粘得宽（指根之间才有蹼），手指要粘得窄（不然并拢的四根手指会糊成一整块）。
 * cell 是格子的边长，越小越精细也越慢。
 */
export function clayMesh(cones: Cone[], grooves: Groove[] = [], blend = 4.5, cell = 2.2) {
  const W = blend / 3; // 褶子的半宽
  const FAR = blend * 2; // 离表面这么远就不用细算了（单位跟着 blend 走：手用毫米，敌人用米）
  // 每段锥体先算一个包围球：离它很远的采样点根本不用算这一段，建模时间能省掉一大半
  const bound = cones.map(([a, b, r1, r2]) => { const R = a.distanceTo(b) / 2 + Math.max(r1, r2) + FAR; return [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, R * R]; });
  const field = (x: number, y: number, z: number) => {
    let d = FAR;
    for (let i = 0; i < cones.length; i++) {
      const bd = bound[i], bx = x - bd[0], by = y - bd[1], bz = z - bd[2];
      if (bx * bx + by * by + bz * bz > bd[3]) continue;
      const c = cones[i], k = c[4] ?? blend, e = coneDist(x, y, z, c), h = Math.max(k - Math.abs(d - e), 0) / k;
      d = Math.min(d, e) - h * h * k * 0.25; // 平滑取最小值：两个距离接近时再往里收一点，接缝处就鼓出一段过渡
    }
    if (d < FAR * 0.45 && d > -FAR * 0.45) for (const [at, dir, reach, depth] of grooves) {
      const px = x - at.x, py = y - at.y, pz = z - at.z, r2 = px * px + py * py + pz * pz;
      if (r2 > reach * reach) continue;
      const t = (px * dir.x + py * dir.y + pz * dir.z) / W, fade = 1 - Math.sqrt(r2) / reach;
      d += depth * Math.exp(-t * t) * Math.min(1, fade * 3); // 距离变大 = 表面往里退，于是压出一条沟
    }
    return d;
  };
  // 采样范围：包住所有锥体，再留一点余量
  const box = new THREE.Box3();
  for (const [a, b, r1, r2] of cones) { const r = Math.max(r1, r2) + cell * 3; for (const p of [a, b]) { box.expandByPoint(_v.copy(p).addScalar(r)); box.expandByPoint(_v.copy(p).addScalar(-r)); } }
  const nx = Math.ceil((box.max.x - box.min.x) / cell) + 1, ny = Math.ceil((box.max.y - box.min.y) / cell) + 1, nz = Math.ceil((box.max.z - box.min.z) / cell) + 1;
  const ox = box.min.x, oy = box.min.y, oz = box.min.z;
  const val = new Float32Array(nx * ny * nz), at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) val[at(i, j, k)] = field(ox + i * cell, oy + j * cell, oz + k * cell);

  // 第一遍：每个被表面穿过的格子放一个顶点，位置取各条穿越边上交点的平均
  const cx = nx - 1, cy = ny - 1, cz = nz - 1, cellAt = (i: number, j: number, k: number) => (k * cy + j) * cx + i;
  const vert = new Int32Array(cx * cy * cz).fill(-1), pos: number[] = [];
  const corner = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { corner[c] = val[at(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2))]; if (corner[c] < 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let c = 0; c < 8; c++) for (let axis = 0; axis < 3; axis++) {
      if (c & (1 << axis)) continue;
      const d = c | (1 << axis), v0 = corner[c], v1 = corner[d];
      if ((v0 < 0) === (v1 < 0)) continue;
      const t = v0 / (v0 - v1);
      sx += (c & 1) + (axis === 0 ? t : 0); sy += ((c >> 1) & 1) + (axis === 1 ? t : 0); sz += (c >> 2) + (axis === 2 ? t : 0); n++;
    }
    vert[cellAt(i, j, k)] = pos.length / 3;
    pos.push(ox + (i + sx / n) * cell, oy + (j + sy / n) * cell, oz + (k + sz / n) * cell);
  }

  // 法线：距离场增长最快的方向就是"朝外"
  const count = pos.length / 3, nor = new Float32Array(count * 3), e = cell * 0.5;
  for (let v = 0; v < count; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    _v.set(field(x + e, y, z) - field(x - e, y, z), field(x, y + e, z) - field(x, y - e, z), field(x, y, z + e) - field(x, y, z - e)).normalize();
    nor[v * 3] = _v.x; nor[v * 3 + 1] = _v.y; nor[v * 3 + 2] = _v.z;
  }

  // 第二遍：每条被表面穿过的格边，周围的四个格子各出一个顶点，连成一个四边形
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 1; i < cx; i++) {
    const v0 = val[at(i, j, k)], in0 = v0 < 0;
    if (in0 !== (val[at(i + 1, j, k)] < 0)) quad(vert[cellAt(i, j - 1, k - 1)], vert[cellAt(i, j, k - 1)], vert[cellAt(i, j, k)], vert[cellAt(i, j - 1, k)], !in0);
    if (in0 !== (val[at(i, j + 1, k)] < 0)) quad(vert[cellAt(i - 1, j, k - 1)], vert[cellAt(i - 1, j, k)], vert[cellAt(i, j, k)], vert[cellAt(i, j, k - 1)], !in0);
    if (in0 !== (val[at(i, j, k + 1)] < 0)) quad(vert[cellAt(i - 1, j - 1, k)], vert[cellAt(i, j - 1, k)], vert[cellAt(i, j, k)], vert[cellAt(i - 1, j, k)], !in0);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(index);
  return g;
}
const _v = new THREE.Vector3();
