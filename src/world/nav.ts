import type { Colliders } from './colliders';

// 寻路网格：把整个港区切成半米见方的小格子，每格只记一件事——地面上的敌人能不能站在这里。
// 机器狗和守卫找路时就在这张格子图上跑 A*（一种"从起点一圈圈往外找、优先试离终点近的方向"的搜索）。
//
// 为什么是半米一格：以前是 2 米一格，够绕开集装箱，但车间的门洞只有 5 米宽，墙两边各让出半米之后，
// 对到 2 米的格子上恰好只剩一格能过（换个位置可能一格都不剩），货架之间 2 米多的通道更是进不去。
// 半米一格时门洞有 8 格宽、货架通道有 3 格宽，都走得通。代价是格子数变成 16 倍（344 × 400），
// 所以搜索要换成带"堆"的写法，并且把结果拉直成几个拐点（见 findPath）。

/** 格子边长（米）。 */
const CELL = 0.5;
/** 障碍物往外"长胖"多少（米）。敌人被当成一个点来找路，所以要把障碍加粗，身子才不会蹭着墙走。 */
const PAD = 0.5;
/** 顶面比这还低的盒子可以直接迈上去（门槛、托盘、最下面两级楼梯），不算障碍。 */
const STEP_OVER = 0.47;
/** 底面比这还高的盒子在头顶上（门楣、夹层楼板），人从下面走过去，也不算障碍。 */
const HEADROOM = 1.5;
/** 地图最外面留几圈格子不让走（2 圈 = 1 米）。 */
const EDGE = 2;
/** 起点 / 终点落在障碍里时，最多往外找几圈（12 圈 = 6 米）。 */
const SNAP_RINGS = 12;
/**
 * 一次搜索最多展开多少个格子。实测横穿整个港区的最长一条路大约展开两万多格；
 * 到了上限还没走到，就先走到"已经探过的格子里离终点最近的那个"，下一次重新找路时再接着走。
 */
const MAX_EXPAND = 60000;
const SQRT2 = Math.SQRT2;

export class NavGrid {
  readonly cell = CELL;
  readonly w: number; readonly h: number;
  /** 1 = 不能站。障碍物（加粗后）盖到的格子、最外一圈、以及四面被堵死的"死腔"都是 1。 */
  readonly blockedCells: Uint8Array;
  /** 最近一次 findPath 展开了多少个格子（给体检脚本看的）。 */
  lastExpanded = 0;
  // 下面几个数组是搜索用的草稿纸，每格一个数，反复使用，省得每次找路都重新申请内存
  private cost: Float32Array;   // 从起点走到这一格的最短路程（目前已知的）
  private from: Int32Array;     // 这一格是从哪一格走过来的（最后顺着它倒推出整条路）
  private state: Uint8Array;    // 0 没碰过 / 1 在待办堆里 / 2 已经确定
  // 待办堆（二叉堆）：永远能很快拿出"估计总路程最短"的那一格。两个数组并排存：估计值、格子编号
  private heapF: number[] = []; private heapI: number[] = [];

  constructor(public minX: number, public minZ: number, maxX: number, maxZ: number, col: Colliders) {
    const w = this.w = Math.ceil((maxX - minX) / CELL), h = this.h = Math.ceil((maxZ - minZ) / CELL);
    const n = w * h;
    const blocked = this.blockedCells = new Uint8Array(n);
    this.cost = new Float32Array(n); this.from = new Int32Array(n); this.state = new Uint8Array(n);

    // ---- 第一步：把每个碰撞盒"压"到格子上
    for (const b of col.boxes) {
      if (b.noNav || b.maxY < STEP_OVER || b.minY > HEADROOM) continue;
      // 减去的那一丁点是为了：盒子的边正好落在格线上时，不把只是"挨着"的那一排格子也算进去
      const x0 = Math.max(0, Math.floor((b.minX - PAD - minX) / CELL + 1e-6)), x1 = Math.min(w - 1, Math.floor((b.maxX + PAD - minX) / CELL - 1e-6));
      const z0 = Math.max(0, Math.floor((b.minZ - PAD - minZ) / CELL + 1e-6)), z1 = Math.min(h - 1, Math.floor((b.maxZ + PAD - minZ) / CELL - 1e-6));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) blocked[z * w + x] = 1;
    }
    // 最外面 1 米（两圈格子）也封上：一来敌人不会贴着地图边缘走、不会从码头沿掉进海里，
    // 二来搜索时不用每一步都检查"有没有走出地图"
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) if (x < EDGE || z < EDGE || x >= w - EDGE || z >= h - EDGE) blocked[z * w + x] = 1;

    // ---- 第二步：找出"连成一片"的最大区域，其余的空格子一律当成障碍
    // 箱垛之间偶尔会围出一小块空地，四面都过不去。敌人要是刷在里面就出不来，往里面找路则会把整张图搜一遍才发现走不通。
    // 所以用"灌水"的办法给每片连通的空地编号（从一格出发，把所有走得到的格子都标上同一个号），只留最大的那片。
    const label = new Int32Array(n), stack: number[] = [];
    let best = 0, bestSize = 0;
    for (let i = 0, id = 0; i < n; i++) {
      if (blocked[i] || label[i]) continue;
      id++; let size = 0;
      label[i] = id; stack.push(i);
      while (stack.length) {
        const c = stack.pop()!; size++;
        // 只看上下左右四个邻居：斜着走要求两侧都通，四连通的区域划分对它同样成立
        for (const nb of [c - 1, c + 1, c - w, c + w]) if (!blocked[nb] && !label[nb]) { label[nb] = id; stack.push(nb); }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    for (let i = 0; i < n; i++) if (!blocked[i] && label[i] !== best) blocked[i] = 1;
  }

  cellOf(x: number, z: number) {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const cz = Math.min(this.h - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
    return cz * this.w + cx;
  }
  centerX(i: number) { return this.minX + ((i % this.w) + 0.5) * CELL; }
  centerZ(i: number) { return this.minZ + (Math.floor(i / this.w) + 0.5) * CELL; }
  /** 这个位置能不能站（而且从别处走得到）。 */
  isFree(x: number, z: number) { return !this.blockedCells[this.cellOf(x, z)]; }

  /** 格子 i 被占的话，一圈一圈往外找最近的空格；找不到返回 -1。 */
  private nearestFree(i: number): number {
    if (!this.blockedCells[i]) return i;
    const { w, h } = this, cx = i % w, cz = Math.floor(i / w);
    for (let r = 1; r <= SNAP_RINGS; r++) {
      let best = -1, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;          // 只看这一圈的边，里面的上几轮已经看过了
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= w || z >= h || this.blockedCells[z * w + x]) continue;
        const d = dx * dx + dz * dz;                                        // 同一圈里挑直线距离最近的（圈是方的，四个角比四条边的中点远）
        if (d < bd) { bd = d; best = z * w + x; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * 离 (x, z) 最近的可站位置（最多找 maxDist 米远）。本来就能站就原样返回；实在找不到返回 null。
   * 关卡里手写的出生点、掩体点用它来"落地"：道具挪过位置之后，原来的点可能正好被压住。
   */
  snap(x: number, z: number, maxDist = 2): [number, number] | null {
    if (this.isFree(x, z)) return [x, z];
    const c = this.nearestFree(this.cellOf(x, z));
    if (c < 0) return null;
    const sx = this.centerX(c), sz = this.centerZ(c);
    return Math.hypot(sx - x, sz - z) <= maxDist + CELL ? [sx, sz] : null;
  }

  /**
   * 两格之间能不能走直线。沿着连线一格一格地数过去（画直线的经典办法：哪个方向落后得多就补哪个方向），
   * 每一格都得是空的；斜着跨一步时，被"抄近路"的那两格也得是空的——不然就是从两个箱角之间挤过去。
   */
  private lineFree(a: number, b: number): boolean {
    const { w, blockedCells } = this;
    let x = a % w, z = Math.floor(a / w);
    const x1 = b % w, z1 = Math.floor(b / w);
    const dx = Math.abs(x1 - x), dz = Math.abs(z1 - z), sx = x < x1 ? 1 : -1, sz = z < z1 ? 1 : -1;
    let err = dx - dz;
    while (x !== x1 || z !== z1) {
      const e2 = err * 2, stepX = e2 > -dz, stepZ = e2 < dx;
      if (stepX && stepZ && (blockedCells[z * w + x + sx] || blockedCells[(z + sz) * w + x])) return false;
      if (stepX) { err -= dz; x += sx; }
      if (stepZ) { err += dx; z += sz; }
      if (blockedCells[z * w + x]) return false;
    }
    return true;
  }

  /** 世界坐标版的"能不能走直线"。 */
  clearLine(ax: number, az: number, bx: number, bz: number) {
    const a = this.cellOf(ax, az), b = this.cellOf(bx, bz);
    return !this.blockedCells[a] && this.lineFree(a, b);
  }

  // ---- 二叉堆：一棵"父亲总比孩子小"的树，摊平存在数组里（第 k 个的孩子是第 2k+1、2k+2 个）。最小的永远在最前面
  private push(f: number, i: number) {
    const F = this.heapF, I = this.heapI;
    let k = F.length; F.push(f); I.push(i);
    while (k > 0) {                                       // 新来的往上冒，直到父亲比它小
      const p = (k - 1) >> 1;
      if (F[p] <= f) break;
      F[k] = F[p]; I[k] = I[p]; k = p;
    }
    F[k] = f; I[k] = i;
  }
  private pop(): number {
    const F = this.heapF, I = this.heapI, top = I[0];
    const f = F.pop()!, i = I.pop()!, n = F.length;
    if (n > 0) {                                          // 把最后一个放到最前面，再让它往下沉到合适的位置
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        F[k] = F[c]; I[k] = I[c]; k = c;
      }
      F[k] = f; I[k] = i;
    }
    return top;
  }

  /**
   * 找路。返回一串拐点的世界坐标 [x0, z0, x1, z1, …]（不含起点），沿着它们一段段走直线就行；完全没路返回 null。
   *   · 终点能站：最后一个点就是 (tx, tz) 本身；
   *   · 终点在障碍里（比如玩家站在箱顶）：最后一个点是离它最近的可站格子。
   */
  findPath(sx: number, sz: number, tx: number, tz: number): number[] | null {
    const { w, cost, from, state, blockedCells } = this;
    const start = this.nearestFree(this.cellOf(sx, sz)), goalRaw = this.cellOf(tx, tz), goal = this.nearestFree(goalRaw);
    this.lastExpanded = 0;
    if (start < 0 || goal < 0) return null;
    const exact = goal === goalRaw;
    if (start === goal) return exact ? [tx, tz] : [this.centerX(goal), this.centerZ(goal)];

    state.fill(0);
    this.heapF.length = 0; this.heapI.length = 0;
    const gx = goal % w, gz = Math.floor(goal / w);
    /** 估计"从这一格到终点还要走多远"：假设中间没有障碍，先斜着走、再直着走。估计值不能高估，搜出来的才是最短路 */
    const guess = (x: number, z: number) => { const ax = Math.abs(x - gx), az = Math.abs(z - gz); return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az); };
    cost[start] = 0; from[start] = -1; state[start] = 1;
    this.push(guess(start % w, Math.floor(start / w)), start);
    let nearest = start, nearestGuess = Infinity, expanded = 0, found = false;
    while (this.heapF.length) {
      const cur = this.pop();
      if (state[cur] === 2) continue;                     // 同一格可能进过好几次堆（后来找到了更短的走法）：只认第一次拿出来的
      if (cur === goal) { found = true; break; }
      state[cur] = 2;
      const cx = cur % w, cz = Math.floor(cur / w), hc = guess(cx, cz);
      if (hc < nearestGuess) { nearestGuess = hc; nearest = cur; }
      if (++expanded >= MAX_EXPAND) break;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const ni = cur + dz * w + dx;                     // 最外一圈是封死的，所以邻居一定还在地图里
        if (blockedCells[ni] || state[ni] === 2) continue;
        if (dx && dz && (blockedCells[cur + dx] || blockedCells[cur + dz * w])) continue;   // 斜着走不许擦过障碍的角
        const ng = cost[cur] + (dx && dz ? SQRT2 : 1);
        if (state[ni] === 1 && ng >= cost[ni]) continue;
        cost[ni] = ng; from[ni] = cur; state[ni] = 1;
        // 估计值乘 1.001：两条路一样长时优先试离终点更近的那条，空旷的地方能少展开很多格子
        this.push(ng + guess(cx + dx, cz + dz) * 1.001, ni);
      }
    }
    this.lastExpanded = expanded;
    const end = found ? goal : nearest;
    if (end === start) return null;

    // ---- 顺着 from 倒推出整条路（一格挨一格），再"拉直"
    const cells: number[] = [];
    for (let c = end; c !== -1; c = from[c]) cells.push(c);
    cells.reverse();
    // 拉直：站在当前拐点上，沿着路往后看，能直着走到的最远一格就是下一个拐点，中间的全部丢掉。
    // 一格一格的路是锯齿形的（只有八个方向），拉直之后一条横穿堆场的路通常只剩三五个拐点。
    // 偶尔会被小障碍挡一下视线、再往后又能看见，所以看不见之后再多试 8 格才放弃。
    const path: number[] = [];
    for (let i = 0; i < cells.length - 1;) {
      let j = i + 1;
      for (let k = j + 1, miss = 0; k < cells.length && miss < 8; k++) {
        if (this.lineFree(cells[i], cells[k])) { j = k; miss = 0; } else miss++;
      }
      path.push(this.centerX(cells[j]), this.centerZ(cells[j]));
      i = j;
    }
    if (found && exact) { path[path.length - 2] = tx; path[path.length - 1] = tz; }
    return path;
  }
}
