import type { Colliders } from './colliders';

/** 2 米一格的寻路网格。地面敌人用 A* 在上面找路，绕开集装箱。 */
export class NavGrid {
  readonly cell = 2;
  readonly w: number; readonly h: number;
  readonly blockedCells: Uint8Array;
  private g: Float32Array; private from: Int32Array; private state: Uint8Array;

  constructor(public minX: number, public minZ: number, maxX: number, maxZ: number, col: Colliders) {
    this.w = Math.ceil((maxX - minX) / this.cell);
    this.h = Math.ceil((maxZ - minZ) / this.cell);
    const n = this.w * this.h;
    this.blockedCells = new Uint8Array(n);
    this.g = new Float32Array(n); this.from = new Int32Array(n); this.state = new Uint8Array(n);
    const pad = 0.55;
    for (const b of col.boxes) {
      if (b.minY > 1.9 || b.maxY < 0.5) continue;
      const x0 = Math.max(0, Math.floor((b.minX - pad - minX) / this.cell));
      const x1 = Math.min(this.w - 1, Math.floor((b.maxX + pad - minX) / this.cell));
      const z0 = Math.max(0, Math.floor((b.minZ - pad - minZ) / this.cell));
      const z1 = Math.min(this.h - 1, Math.floor((b.maxZ + pad - minZ) / this.cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.blockedCells[z * this.w + x] = 1;
    }
  }

  cellOf(x: number, z: number) {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cz = Math.min(this.h - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell)));
    return cz * this.w + cx;
  }
  centerX(i: number) { return this.minX + ((i % this.w) + 0.5) * this.cell; }
  centerZ(i: number) { return this.minZ + (Math.floor(i / this.w) + 0.5) * this.cell; }
  isFree(x: number, z: number) { return !this.blockedCells[this.cellOf(x, z)]; }

  /** 如果目标格被占，向外找最近的空格。 */
  private nearestFree(i: number): number {
    if (!this.blockedCells[i]) return i;
    const cx = i % this.w, cz = Math.floor(i / this.w);
    for (let r = 1; r < 6; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= this.w || z >= this.h) continue;
        if (!this.blockedCells[z * this.w + x]) return z * this.w + x;
      }
    }
    return i;
  }

  /** A* 寻路，返回一串世界坐标 [x0,z0,x1,z1,...]；找不到返回 null。 */
  findPath(sx: number, sz: number, tx: number, tz: number): number[] | null {
    const start = this.nearestFree(this.cellOf(sx, sz));
    const goal = this.nearestFree(this.cellOf(tx, tz));
    if (start === goal) return [tx, tz];
    const { w, h, g, from, state } = this;
    state.fill(0);
    const open: number[] = [start];
    const f: number[] = [0];
    g[start] = 0; from[start] = -1; state[start] = 1;
    const gx = goal % w, gz = Math.floor(goal / w);
    let iter = 0;
    while (open.length && iter++ < 6000) {
      // 线性找最小 f：open 表很小，比维护堆更简单
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[i] < f[bi]) bi = i;
      const cur = open[bi];
      open[bi] = open[open.length - 1]; f[bi] = f[f.length - 1]; open.pop(); f.pop();
      if (cur === goal) break;
      state[cur] = 2;
      const cx = cur % w, cz = Math.floor(cur / w);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= w || z >= h) continue;
        const ni = z * w + x;
        if (this.blockedCells[ni] || state[ni] === 2) continue;
        // 斜着走时不允许擦过障碍的角
        if (dx && dz && (this.blockedCells[cz * w + x] || this.blockedCells[z * w + cx])) continue;
        const ng = g[cur] + (dx && dz ? 1.4142 : 1);
        if (state[ni] === 1 && ng >= g[ni]) continue;
        g[ni] = ng; from[ni] = cur;
        const ax = Math.abs(x - gx), az = Math.abs(z - gz);
        const hcost = Math.max(ax, az) + 0.4142 * Math.min(ax, az);
        if (state[ni] !== 1) { state[ni] = 1; open.push(ni); f.push(ng + hcost); }
        else { const k = open.indexOf(ni); if (k >= 0) f[k] = ng + hcost; }
      }
    }
    if (state[goal] === 0) return null;
    const cells: number[] = [];
    for (let c = goal; c !== -1 && c !== start; c = from[c]) cells.push(c);
    cells.reverse();
    const path: number[] = [];
    for (const c of cells) path.push(this.centerX(c), this.centerZ(c));
    path.push(tx, tz);
    return path;
  }
}
