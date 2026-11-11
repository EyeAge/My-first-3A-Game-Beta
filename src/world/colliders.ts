/** 轴对齐包围盒。整个港区的碰撞都用它表示：集装箱、墙、起重机支腿。 */
export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
export interface RayHit { t: number; nx: number; ny: number; nz: number }

export class Colliders {
  boxes: Box[] = [];

  add(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Box {
    const b = { minX: cx - sx / 2, maxX: cx + sx / 2, minY: cy - sy / 2, maxY: cy + sy / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2 };
    this.boxes.push(b);
    return b;
  }

  /** 射线与所有盒子求最近交点（slab 算法）。子弹、视线判断都走这里。 */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out?: RayHit): number {
    let best = maxT, bn = 0, bs = 0;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      let t1 = (b.minX - ox) * ix, t2 = (b.maxX - ox) * ix;
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2), axis = 0;
      t1 = (b.minY - oy) * iy; t2 = (b.maxY - oy) * iy;
      let lo = Math.min(t1, t2), hi = Math.max(t1, t2);
      if (lo > tmin) { tmin = lo; axis = 1; }
      if (hi < tmax) tmax = hi;
      t1 = (b.minZ - oz) * iz; t2 = (b.maxZ - oz) * iz;
      lo = Math.min(t1, t2); hi = Math.max(t1, t2);
      if (lo > tmin) { tmin = lo; axis = 2; }
      if (hi < tmax) tmax = hi;
      if (tmax >= tmin && tmin > 0 && tmin < best) {
        best = tmin; bn = axis;
        bs = axis === 0 ? -Math.sign(dx) : axis === 1 ? -Math.sign(dy) : -Math.sign(dz);
      }
    }
    // 地面 y=0
    if (dy < 0) {
      const tg = -oy / dy;
      if (tg > 0 && tg < best) { best = tg; bn = 1; bs = 1; }
    }
    if (out) { out.t = best; out.nx = bn === 0 ? bs : 0; out.ny = bn === 1 ? bs : 0; out.nz = bn === 2 ? bs : 0; }
    return best;
  }

  /** 两点之间有没有遮挡。 */
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return false;
    const inv = 1 / len;
    return this.raycast(ax, ay, az, dx * inv || 1e-9, dy * inv || 1e-9, dz * inv || 1e-9, len) < len - 0.05;
  }

  pointInside(x: number, y: number, z: number): boolean {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ) return true;
    }
    return false;
  }
}
