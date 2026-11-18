import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 特效里"实心"的两样东西：碎片和弹壳。它们不是贴图方片，是真的小模型，会受光、会落地弹跳。
// 各用一个实例化网格：同一个模型画很多份，每份有自己的位置、朝向、大小（碎片还有自己的颜色），一次绘制调用画完。

const GRAVITY = 9.81;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _axis = new THREE.Vector3(), _col = new THREE.Color();

/**
 * 碎片的形状：一个被削过角、每个顶点都挪动过一点的方块，像一块崩下来的石头。
 * 三个方向的尺寸是分开给的，所以同一个模型压扁了是漆片，拉长了是木刺，不压不拉是碎石。
 */
function chunkGeometry() {
  const box = new THREE.BoxGeometry(1, 1, 1, 2, 1, 2), pos = box.getAttribute('position'), rnd = mulberry32(12345);
  // 方块的每个角在几何体里其实存了好几份（每个面各一份）。同一个位置的顶点必须挪到同一个地方，不然面和面之间会裂开
  const moved = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    let to = moved.get(key);
    if (!to) {
      const corner = Math.abs(x) > 0.49 && Math.abs(z) > 0.49, cut = corner ? 0.72 + rnd() * 0.2 : 1;   // 四条竖棱往里收：削角
      to = [x * cut + (rnd() - 0.5) * 0.14, y * (0.8 + rnd() * 0.3) + (rnd() - 0.5) * 0.1, z * cut + (rnd() - 0.5) * 0.14];
      moved.set(key, to);
    }
    pos.setXYZ(i, to[0], to[1], to[2]);
  }
  const flat = box.toNonIndexed();   // 每个三角形用自己的三个顶点，法线不在面之间平均：棱角分明
  flat.computeVertexNormals();
  box.dispose();
  return flat;
}

interface Chunk { x: number; y: number; z: number; vx: number; vy: number; vz: number; sx: number; sy: number; sz: number; ax: number; ay: number; az: number; angle: number; spin: number; life: number; floor: number; resting: boolean; hot: number }

/** 碎片池：子弹崩下来的碎屑、爆炸炸飞的零件。满了就覆盖最旧的。 */
export class DebrisPool {
  readonly mesh: THREE.InstancedMesh;
  private items: Chunk[];
  private cursor = 0;

  constructor(private capacity = 256) {
    // 粗糙、几乎不带金属感：大多数碎片是水泥渣、木屑、漆皮。颜色每块自己带
    this.mesh = new THREE.InstancedMesh(chunkGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 }), capacity);
    this.mesh.frustumCulled = false; this.mesh.castShadow = false; this.mesh.receiveShadow = true;
    this.items = Array.from({ length: capacity }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, ax: 1, ay: 0, az: 0, angle: 0, spin: 0, life: 0, floor: 0, resting: false, hot: 0 }));
    this.clear();
  }
  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) { this.items[i].life = 0; this.mesh.setMatrixAt(i, _m); this.mesh.setColorAt(i, _col.setRGB(1, 1, 1)); }
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = 0; this.mesh.visible = false; this.cursor = 0;
  }

  /**
   * 抛出一块。size 是三个方向的尺寸（米）；floor 是它脚下地面的高度；
   * hot > 0 表示这块是烧着飞出去的，这么多秒内会一路掉火星、拖黑烟（由 update 的回调去发射）。
   */
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, life: number, floor: number, hot = 0) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.capacity;
    const c = this.items[i];
    c.x = x; c.y = y; c.z = z; c.vx = vx; c.vy = vy; c.vz = vz; c.sx = sx; c.sy = sy; c.sz = sz; c.life = life; c.resting = false; c.hot = hot;
    c.floor = floor + Math.min(sx, sy, sz) * 0.5;                       // 最薄的那个方向的一半：停下来时大致是平躺着贴在地上
    _axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    c.ax = _axis.x; c.ay = _axis.y; c.az = _axis.z; c.angle = Math.random() * 6.28; c.spin = (Math.random() - 0.5) * 50;
    this.mesh.setColorAt(i, _col.setRGB(r, g, b)); this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1); this.mesh.visible = true;
  }

  update(dt: number, onHot?: (x: number, y: number, z: number) => void) {
    let dirty = false, alive = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const c = this.items[i];
      if (c.life <= 0) continue;
      c.life -= dt; alive = true;
      if (c.resting && c.life > 0.5) continue;                          // 已经躺平、离消失还早：矩阵不用动
      if (!c.resting) {
        c.vy -= GRAVITY * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.angle += c.spin * dt;
        if (c.y < c.floor && c.vy < 0) {
          c.y = c.floor;
          if (c.vy > -1.2) { c.resting = true; c.hot = 0; }             // 落得很慢了：停下
          else { c.vy = -c.vy * 0.32; c.vx *= 0.55; c.vz *= 0.55; c.spin *= 0.5; }   // 弹一下，损失大半速度
        }
        if (c.hot > 0) { c.hot -= dt; onHot?.(c.x, c.y, c.z); }
      }
      const k = c.life <= 0 ? 0 : Math.min(1, c.life / 0.5);            // 最后半秒缩小消失
      this.mesh.setMatrixAt(i, _m.compose(_p.set(c.x, c.y, c.z), _q.setFromAxisAngle(_axis.set(c.ax, c.ay, c.az), c.angle), _s.set(c.sx * k, c.sy * k, c.sz * k)));
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (!alive) { this.mesh.count = 0; this.mesh.visible = false; this.cursor = 0; }
  }
}

/**
 * 弹壳的形状：把一条轮廓线绕中轴转一圈（"车削"）。轮廓上依次是：底缘、抽壳槽、壳身、肩部、瓶颈、壳口。
 * 全长 52 毫米，最粗 12.4 毫米（比真的 5.56 弹壳大一圈，不然落在地上看不见）。
 */
function shellGeometry() {
  const profile: [number, number][] = [[0, 0], [0.006076, 0], [0.0062, 0.0012], [0.005084, 0.0022], [0.005084, 0.0034], [0.006014, 0.0046], [0.00589, 0.0364], [0.004092, 0.0416], [0.003968, 0.052], [0.003224, 0.052], [0.0031, 0.04472]];
  return new THREE.LatheGeometry(profile.map(([radius, h]) => new THREE.Vector2(radius, h - 0.026)), 10);
}

interface Shell { x: number; y: number; z: number; vx: number; vy: number; vz: number; wx: number; wy: number; wz: number; q: THREE.Quaternion; floor: number; bounces: number; flying: number; rest: number; live: boolean }

/** 弹壳池：抛出来、翻着跟头落地、弹几下、侧躺着停住，过几秒缩小消失。 */
export class ShellPool {
  readonly mesh: THREE.InstancedMesh;
  private items: Shell[];
  private cursor = 0;

  /** floorAt(x, y, z) 返回这个位置正下方的地面高度；onBounce 在头两次落地时被调用（给音效留的口子）。 */
  constructor(private floorAt: (x: number, y: number, z: number) => number, private capacity = 60, public onBounce: ((x: number, y: number, z: number) => void) | null = null) {
    this.mesh = new THREE.InstancedMesh(shellGeometry(), new THREE.MeshStandardMaterial({ color: 0xb08d3c, roughness: 0.3, metalness: 1 }), capacity);
    this.mesh.frustumCulled = false; this.mesh.castShadow = false; this.mesh.receiveShadow = true;
    this.items = Array.from({ length: capacity }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, q: new THREE.Quaternion(), floor: 0, bounces: 0, flying: 0, rest: 0, live: false }));
    this.clear();
  }
  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) { this.items[i].live = false; this.mesh.setMatrixAt(i, _m); }
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.count = 0; this.mesh.visible = false; this.cursor = 0;
  }

  add(x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.capacity;
    const s = this.items[i];
    s.x = x; s.y = y; s.z = z; s.vx = vx; s.vy = vy; s.vz = vz; s.live = true; s.bounces = 0; s.flying = 0; s.rest = 0;
    s.wx = (Math.random() - 0.5) * 40; s.wy = (Math.random() - 0.5) * 20; s.wz = (Math.random() - 0.5) * 40;   // 翻滚的角速度（弧度/秒）
    s.q.setFromAxisAngle(_axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * 6.28);
    s.floor = this.floorAt(x, y + 0.25, z) + 0.0065;                    // 0.0065 ≈ 弹壳的半径：侧躺时中轴离地这么高
    this.mesh.count = Math.max(this.mesh.count, i + 1); this.mesh.visible = true;
  }

  update(dt: number) {
    let dirty = false, alive = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const s = this.items[i];
      if (!s.live) continue;
      alive = true;
      let scale = 1;
      if (s.rest > 0) {
        // 已经停住：躺 4 秒，然后用 0.7 秒缩没
        s.rest += dt;
        if (s.rest < 4) continue;
        scale = Math.max(0, 1 - (s.rest - 4) / 0.7);
        if (scale <= 0) s.live = false;
      } else {
        s.flying += dt;
        s.vy -= GRAVITY * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        // 用角速度转动朝向：这一小段时间里绕 (wx, wy, wz) 这根轴转了 |w|·dt 弧度
        const w = Math.hypot(s.wx, s.wy, s.wz);
        if (w > 1e-4) s.q.premultiply(_dq.setFromAxisAngle(_axis.set(s.wx / w, s.wy / w, s.wz / w), w * dt));
        if ((s.y < s.floor && s.vy < 0) || s.flying > 8) {
          s.y = Math.max(s.y, s.floor);
          if (s.bounces < 2) this.onBounce?.(s.x, s.y, s.z);
          if (s.vy > -0.9 || s.bounces >= 4 || s.flying > 8) {
            // 弹不动了：摆成侧躺（中轴水平），朝向随机
            s.rest = 1e-3; s.y = s.floor;
            s.q.setFromAxisAngle(_axis.set(0, 1, 0), Math.random() * 6.28).multiply(_dq.setFromAxisAngle(_axis.set(1, 0, 0), Math.PI / 2));
          } else {
            s.bounces++;
            s.vy = -s.vy * (0.32 + Math.random() * 0.16);
            s.vx = s.vx * 0.6 + (Math.random() - 0.5) * 0.6; s.vz = s.vz * 0.6 + (Math.random() - 0.5) * 0.6;   // 每次落地都往旁边蹦一点
            s.wx = (Math.random() - 0.5) * 50; s.wy = (Math.random() - 0.5) * 30; s.wz = (Math.random() - 0.5) * 50;
            s.floor = this.floorAt(s.x, s.y + 0.25, s.z) + 0.0065;      // 可能蹦到了箱子边上：重新找一次脚下的地面
          }
        }
      }
      this.mesh.setMatrixAt(i, _m.compose(_p.set(s.x, s.y, s.z), s.q, _s.setScalar(scale)));
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (!alive && this.mesh.count > 0) { this.mesh.count = 0; this.mesh.visible = false; this.cursor = 0; }
  }
}
