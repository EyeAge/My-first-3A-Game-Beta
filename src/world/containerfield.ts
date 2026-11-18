import * as THREE from 'three';
import { mulberry32, type Rng } from '../core/math';
import type { Colliders } from './colliders';
import { CONTAINER_SIZES, CONTAINER_WIDTH, containerBoxes, containerDetail, containerLod, containerLodLogo, containerMarks, containerMaterials, containerMeshes, containerMid, containerMidRods, containerVariant, prepareContainerMarks, SEED_VARIANTS, SHIPPING_LINES, tintedMesh, type ContainerSize, type ContainerVariant } from './container';

// 堆场里的几百只集装箱：怎么摆、怎么画得动。
//
// container.ts 能搭出一只很细的箱子（六七千个三角形）。场上有八百多只，如果每只都这么画，就是五百多万个三角形，
// 而其中绝大多数离玩家几十上百米，在屏幕上只有指甲盖大。所以这里做两件事：
//
//   1. 实例化。同一种变体（规格 × 花样 × 做旧）的箱子共用一份几何，用 InstancedMesh 一次画完；
//      每只箱子只是一个"摆放矩阵"加一个"颜色"。八种箱体色不需要八个材质 —— 颜色是乘在白漆上的实例颜色。
//
//   2. 三档精度。每只箱子按离镜头的远近归到三档里的一档，每隔 0.3 秒重新分一次：
//        精模  最近的几十只（默认 24 米以内、最多 40 只）：凹坑、锁杆、铰链、门上的小字，什么都有；
//        中模  再往外的一两百只（默认 80 米以内、最多 200 只）：波纹和框架还在，小零件和小字没了，侧面只留一块船公司标；
//        简模  其余的：一个带颜色的平板盒子，侧面也有那块标。
//      中间这一档是后来加的。只有精模和简模两档的时候，二十多米外的箱子就成了光板，走着走着能看见前面的箱子一只只"变平"；
//      波纹板在斜阳底下一道亮一道暗，其实隔着五六十米还看得出来，所以单独给它留了一档便宜的。
//
// 另外有一个省钱的办法：影子和地面上的倒影一律用简模。箱子的影子就是一个长方块的影子，波纹的起伏在影子里根本看不出来；
// 湿地面上的倒影是一张缩小了、又被水纹搅过的图，也看不出来。没必要为了这两样把几千个三角形再各画一遍。

export interface ContainerPlacement {
  size: ContainerSize;
  /** 箱子占地中心的位置。y 是箱底的高度（放在地上就是 0）。 */
  x: number; y: number; z: number;
  /** 绕竖轴转多少弧度。0 时长边沿 x、箱门朝 +x；转 90°（π/2）后箱门朝 -z。 */
  yaw: number;
  /** 箱体颜色 0xRRGGBB，一般从 CONTAINER_COLORS 里挑。 */
  color: number;
  /** 凹坑、锈条、箱号用哪一套花样（只看除以 6 的余数）。不给就随机。 */
  seed?: number;
  /** 做旧程度 0–1，会归到 0 / 0.5 / 1 三档。不给是 0.5。 */
  wear?: number;
  /** 开门程度 0–1。大于 0 的箱子有内部，人可以走进去。 */
  doors?: number;
  /** 哪家船公司 0–3（SHIPPING_LINES 的下标）。不给就跟着 seed 走。 */
  brand?: number;
  /** 永远只用简模：船上、吊具上那些玩家走不到跟前的箱子。 */
  lodOnly?: boolean;
  /** 要不要登记碰撞，默认要。够不着也打不着的箱子可以不登记：碰撞盒少一个，每次射线检测就少算一个。 */
  solid?: boolean;
}
/** 一摞里的一只。dx / dz 是手工错位：dx 沿这一摞的长边方向，dz 沿宽度方向（比如 40 尺箱顶上压一只偏到一头的 20 尺箱）。flip 是掉头，箱门朝另一边。 */
export interface StackItem { size: ContainerSize; color: number; dx?: number; dz?: number; flip?: boolean; doors?: number; wear?: number; seed?: number; brand?: number }
export interface ContainerFieldOpts {
  /** 多少米以内用精模。默认 24。 */
  detailDistance?: number;
  /** 多少米以内用中模。默认 80。 */
  midDistance?: number;
  /** 开着门的箱子多少米以内用精模。默认 60：门板支出去很显眼，而中模、简模都是关着门的样子，所以它比关着门的箱子晚得多才换。 */
  openDistance?: number;
  /** 回差：已经升了档的箱子，要退到"距离 + hysteresis"以外才降回去。不然站在那条线上晃一晃，箱子就来回跳。默认 4。 */
  hysteresis?: number;
  /** 同时最多多少只箱子用精模（按远近排，近的优先）。站在箱堆正中间时，24 米以内可能有六七十只，得有个上限。默认 40。 */
  maxDetail?: number;
  /** 同时最多多少只箱子用中模。默认 200。 */
  maxMid?: number;
  /** 随机数种子：决定没指定 seed / wear 的箱子长什么样，以及每一摞怎么错位。 */
  seed?: number;
  /**
   * 在 build() 里就把所有用得到的精模几何搭好（每种十几到几十毫秒），开门箱的那几组网格也一起。
   * 默认不预搭：哪种变体第一次走近才搭哪种，开场快、内存省，代价是走动时偶尔有一帧稍慢。
   * （中模便宜，总是在 build() 里一次搭完。）
   */
  prebuild?: boolean;
}

/** 三档精度。数字越大越细。 */
const FAR = 0, MID = 1, DETAIL = 2;
type Tier = typeof FAR | typeof MID | typeof DETAIL;

interface Item {
  v: ContainerVariant;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  x: number; y: number; z: number; yaw: number;
  /** 世界坐标里的外包盒，用来量它离镜头多远。 */
  bounds: THREE.Box3;
  dist: number;
  lodOnly: boolean;
  solid: boolean;
  /** 现在归哪一档画。 */
  tier: Tier;
  /** 开着门的箱子不走实例化，自己有一组网格；第一次走近的时候才搭。 */
  own: THREE.Group | null;
}
/** 一个批次：共用同一份几何的一群箱子，和画它们的实例化网格。dirty 表示成员变了、要重新排一遍。 */
interface Batch { items: Item[]; meshes: THREE.InstancedMesh[]; dirty: boolean }

const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
/** 一个颜色有多亮（0–1，线性空间；人眼对绿最敏感、对蓝最不敏感，所以三个通道的权重不一样）。 */
const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
/**
 * 这一遍是不是在画"地面的倒影"。倒影的画法是把镜头沿地面翻到地下再拍一遍（见 render/reflection.ts），
 * 所以镜头在地面以下就说明是它。
 */
const isMirror = (camera: THREE.Camera) => camera.matrixWorld.elements[13] < 0;
/**
 * 简模的实例排成两段：[ 平时就归它画的箱子 …… | 平时归更细的那几档画的箱子 …… ]。
 * 平时只画前一段（far 只）；画阴影图和画倒影的时候两段都画（all 只）—— 近处的箱子在那两遍里也用简模顶替。
 * three 在每个物体"画阴影之前 / 之后""画之前 / 之后"各留了一个回调，正好用来临时改实例的数量。
 */
function twoSegments(mesh: THREE.InstancedMesh) {
  mesh.userData.far = mesh.userData.all = 0;
  mesh.onBeforeShadow = () => { mesh.count = mesh.userData.all; };
  mesh.onAfterShadow = () => { mesh.count = mesh.userData.far; };
  mesh.onBeforeRender = (_gl, _scene, camera) => { if (isMirror(camera)) mesh.count = mesh.userData.all; };
  mesh.onAfterRender = () => { mesh.count = mesh.userData.far; };
}
/** 精模、中模的网格：画倒影的那一遍不画（数量临时改成 0），由简模顶替。 */
function hideInMirror(mesh: THREE.InstancedMesh) {
  mesh.userData.near = 0;
  mesh.onBeforeRender = (_gl, _scene, camera) => { if (isMirror(camera)) mesh.count = 0; };
  mesh.onAfterRender = () => { mesh.count = mesh.userData.near; };
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _lo = new THREE.Vector3(), _hi = new THREE.Vector3(), _b = new THREE.Box3();
const isOpen = (it: Item) => it.v.doors > 0;


export class ContainerField {
  private items: Item[] = [];
  private rng: Rng;
  private root = new THREE.Group();
  // 六种批次。一只关着门的箱子同时登记在六种里，哪一档该它画，它就出现在那一档的实例里：
  private lods = new Map<string, Batch>();   // 简模的箱体：按 规格|花样|做旧 分
  private logos = new Map<string, Batch>();  // 侧面那块平的船公司标（简模、中模都用它）：按 规格|船公司 分
  private mids = new Map<string, Batch>();   // 中模的箱体：按 规格|花样|做旧 分
  private rods = new Map<string, Batch>();   // 中模门上的四根锁杆：只按 规格 分（三个批次就管了全场）
  private cores = new Map<string, Batch>();  // 精模的箱体和镀锌件：按 规格|花样|做旧 分
  private marks = new Map<string, Batch>();  // 精模身上的喷字和污迹：按 规格|花样|做旧|船公司 分（标不一样，所以比箱体多分一层）
  private built = false;
  private lastEye = new THREE.Vector3();
  private lastTime = -Infinity;

  constructor(private opt: ContainerFieldOpts = {}) {
    this.rng = mulberry32(opt.seed ?? 4207);
    this.root.name = 'containers';
  }
  private range(lo: number, hi: number) { return lo + (hi - lo) * this.rng(); }

  /** 摆一只箱子。要在 build() 之前摆完。 */
  add(o: ContainerPlacement): void {
    if (this.built) { console.warn('[ContainerField] build() 之后不能再 add()：这只箱子不会出现'); return; }
    const seed = o.seed ?? Math.floor(this.range(1, 99999)), color = new THREE.Color(o.color); // Color 会把 0xRRGGBB 换算到线性空间
    let brand = o.brand ?? seed % SEED_VARIANTS;
    // 有一家船公司的标是藏青色的，喷在深色的箱子上根本看不见。没有指定船公司的箱子如果抽到它、箱体又偏暗，就换成下一家（白字）。
    // 0.14 这条线：白、黄、橙三种箱体在它上面，其余五种在它下面
    if (o.brand === undefined && SHIPPING_LINES[brand % SHIPPING_LINES.length].darkInk && luminance(color) < 0.14) brand++;
    const v = containerVariant({ size: o.size, seed, wear: o.wear, doors: o.doors, brand });
    const spec = CONTAINER_SIZES[v.size];
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(o.x, o.y, o.z), new THREE.Quaternion().setFromAxisAngle(UP, o.yaw), ONE);
    const bounds = new THREE.Box3(new THREE.Vector3(-spec.length / 2, 0, -CONTAINER_WIDTH / 2), new THREE.Vector3(spec.length / 2, spec.height, CONTAINER_WIDTH / 2)).applyMatrix4(matrix);
    this.items.push({ v, matrix, color, x: o.x, y: o.y, z: o.z, yaw: o.yaw, bounds, dist: Infinity, lodOnly: !!o.lodOnly, solid: o.solid ?? true, tier: FAR, own: null });
  }

  /**
   * 码一摞箱子。list 从下往上写；(x, z) 是这一摞的中心，yaw 是整摞的朝向。返回这一摞的顶面高度。
   *
   * 真的堆场里没有哪一摞是严丝合缝的：吊车放箱子总有几厘米的误差。所以这里每一层都故意错开一点 ——
   * 第二层起沿长边错 ±5 厘米、沿宽度错 ±4 厘米，每只再转一个很小的角度。jitter 是这些误差的倍数，0 就是完全对齐
   * （要让玩家站上去打枪的那种箱顶，对齐了碰撞才准）。
   *
   * baseY 是这一摞从多高开始码，默认从地面。两只 20 尺箱并排、上面再横跨一只 40 尺箱的时候，
   * 那只 40 尺箱就是"从 20 尺箱的顶面开始码的一摞"。
   */
  stack(x: number, z: number, list: StackItem[], yaw = 0, jitter = 1, baseY = 0): number {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    let y = baseY;
    list.forEach((it, index) => {
      const spec = CONTAINER_SIZES[it.size];
      const layer = index + (baseY > 0 ? 1 : 0); // 0 = 落在地上的那一只：它只转不挪；压在别的箱子上的才会错位
      const dx = (it.dx ?? 0) + (layer ? this.range(-0.05, 0.05) * jitter : 0);
      const dz = (it.dz ?? 0) + (layer ? this.range(-0.04, 0.04) * jitter : 0);
      // 转角：箱子两头最多歪出去 6–7 厘米。同样的角度，12 米的箱子两头歪出去的距离是 6 米箱子的两倍，
      // 而碰撞盒是不跟着这个小角度转的（见 collide），歪太多子弹打上去的位置就对不上了，所以长箱子的角度减半
      const twist = this.range(-1, 1) * 0.022 * jitter * (layer ? 0.6 : 1) * (spec.length > 7 ? 0.5 : 1);
      this.add({
        size: it.size, color: it.color, y, yaw: yaw + twist + (it.flip ? Math.PI : 0),
        x: x + dx * cos + dz * sin, z: z - dx * sin + dz * cos, // 把"沿长边 / 沿宽度"的错位换算成世界坐标
        seed: it.seed, brand: it.brand, doors: it.doors, wear: it.wear ?? this.range(0.2, 0.85),
      });
      y += spec.height;
    });
    return y;
  }

  /** 生成网格并登记碰撞。之后每帧调用 update()，它会按镜头位置给近处的箱子升档。 */
  build(colliders: Colliders): THREE.Group {
    if (this.built) return this.root;
    this.built = true;
    prepareContainerMarks();
    const mats = containerMaterials();
    const join = (map: Map<string, Batch>, key: string, it: Item) => {
      let b = map.get(key);
      if (!b) map.set(key, (b = { items: [], meshes: [], dirty: true }));
      b.items.push(it);
    };
    for (const it of this.items) {
      if (it.solid) this.collide(it, colliders);
      join(this.lods, coreKey(it.v), it);
      join(this.logos, `${it.v.size}|${it.v.brand}`, it);
      // 开着门的箱子不进后三种批次：它用自己的一组网格。永远用简模的也不进
      if (isOpen(it) || it.lodOnly) continue;
      join(this.mids, coreKey(it.v), it);
      join(this.rods, `${it.v.size}`, it);
      join(this.cores, coreKey(it.v), it);
      join(this.marks, markKey(it.v), it);
    }
    // ---- 简模和它上面的标：每只箱子都有，现在就建
    for (const b of this.lods.values()) {
      const mesh = tintedMesh(containerLod(b.items[0].v), mats.body, 0xffffff, b.items.length);
      mesh.castShadow = true;
      mesh.name = 'container-lod';
      twoSegments(mesh);
      b.meshes.push(mesh);
      this.refillFar(b, FAR);
      // 包围球按"全部成员"算一次就不再变：成员只是在两段之间换位置，而阴影那一遍需要它罩住所有箱子
      mesh.count = b.items.length; mesh.computeBoundingSphere(); mesh.count = mesh.userData.far;
      this.root.add(mesh);
    }
    for (const b of this.logos.values()) {
      const v = b.items[0].v, mesh = new THREE.InstancedMesh(containerLodLogo(v.size, v.brand), mats.marks, b.items.length);
      mesh.receiveShadow = true;
      mesh.name = 'container-lod-logo';
      twoSegments(mesh);
      b.meshes.push(mesh);
      this.refillFar(b, MID);
      mesh.count = b.items.length; mesh.computeBoundingSphere(); mesh.count = mesh.userData.far;
      this.root.add(mesh);
    }
    // ---- 中模：几何便宜，也现在就建，游戏中途不用再为它停顿
    for (const b of this.mids.values()) {
      const mesh = tintedMesh(containerMid(b.items[0].v), mats.body, 0xffffff, b.items.length); // 不投影：影子交给简模了
      mesh.name = 'container-mid';
      this.adopt(b, [mesh]);
    }
    for (const b of this.rods.values()) {
      const mesh = new THREE.InstancedMesh(containerMidRods(b.items[0].v.size), mats.metal, b.items.length);
      mesh.receiveShadow = true;
      mesh.name = 'container-mid-rods';
      this.adopt(b, [mesh]);
    }
    if (this.opt.prebuild) {
      for (const key of this.cores.keys()) this.makeDetail(key);
      for (const it of this.items) if (isOpen(it)) this.makeOwn(it);
    }
    return this.root;
  }

  /**
   * 按镜头位置重新决定每只箱子用哪一档。每帧都可以调，它自己会控制节奏：
   * 离上次重排不到 0.3 秒、镜头也没挪出 3 米，就什么都不做。
   */
  update(cameraPos: THREE.Vector3): void {
    if (!this.built) return;
    const now = performance.now(), moved = cameraPos.distanceTo(this.lastEye);
    const jumped = this.lastTime === -Infinity || moved > 20; // 第一次，或者镜头瞬间挪了很远（出生、传送）
    if (!jumped && moved < 3 && now - this.lastTime < 300) return;
    this.lastTime = now; this.lastEye.copy(cameraPos);

    const o = this.opt, H = o.hysteresis ?? 4;
    const detailDistance = o.detailDistance ?? 24, midDistance = o.midDistance ?? 80, openDistance = o.openDistance ?? 60;
    // 1. 量距离，挑出"够近、有资格升档"的箱子。已经升了档的放宽 H 米（回差）
    const want = new Map<Item, Tier>();
    const candidates: Item[] = [];
    for (const it of this.items) {
      it.dist = it.bounds.distanceToPoint(cameraPos);
      if (it.lodOnly) continue;
      // 开着门的只有精模和简模两档，而且不占名额：中模、简模都是关着门的，它要是被名额挤下去，看上去就是门自己"砰"地关上了。
      // 全场只有几只，不设上限也无妨
      if (isOpen(it)) { if (it.dist < openDistance + (it.tier ? H : 0)) want.set(it, DETAIL); }
      else if (it.dist < midDistance + (it.tier ? H : 0)) candidates.push(it);
    }
    // 2. 先分精模的名额：够近的里面最近的 maxDetail 只。已经在用精模的算近 H 米，免得名额边上的两只箱子来回抢
    const rank = (tier: Tier) => (a: Item, b: Item) => (a.dist - (a.tier >= tier ? H : 0)) - (b.dist - (b.tier >= tier ? H : 0));
    const close = candidates.filter((it) => it.dist < detailDistance + (it.tier === DETAIL ? H : 0)).sort(rank(DETAIL)).slice(0, o.maxDetail ?? 40);
    for (const it of close) want.set(it, DETAIL);
    //    剩下的再分中模的名额
    for (const it of candidates.filter((c) => !want.has(c)).sort(rank(MID)).slice(0, o.maxMid ?? 200)) want.set(it, MID);
    // 3. 换。一种变体第一次用到精模时要现搭几何（十几毫秒），平时每轮最多搭一种，免得走着走着卡一下；
    //    镜头是跳过来的就一次搭完 —— 那一刻本来就在切画面
    let builds = jumped ? Infinity : 1;
    for (const it of this.items) {
      let tier = want.get(it) ?? FAR;
      if (tier === DETAIL) {
        const core = isOpen(it) ? null : this.cores.get(coreKey(it.v))!;
        if (core ? !core.meshes.length : !it.own) {
          if (builds > 0) { builds--; if (core) this.makeDetail(coreKey(it.v)); else this.makeOwn(it); }
          else tier = isOpen(it) ? it.tier : MID; // 这一轮的名额用完了：关着门的先用中模顶着，开着门的保持原样，下一轮再说
        }
      }
      if (tier !== it.tier) this.retier(it, tier);
    }
    // 4. 成员变了的批次，把实例重新排一遍
    for (const b of this.lods.values()) if (b.dirty) this.refillFar(b, FAR);
    for (const b of this.logos.values()) if (b.dirty) this.refillFar(b, MID);
    for (const b of this.mids.values()) if (b.dirty) this.refill(b, MID);
    for (const b of this.rods.values()) if (b.dirty) this.refill(b, MID);
    for (const b of this.cores.values()) if (b.dirty) this.refill(b, DETAIL);
    for (const b of this.marks.values()) if (b.dirty) this.refill(b, DETAIL);
  }

  /** 现在有多少只箱子在用精模、多少只在用中模（调试用）。 */
  get detailCount() { return this.items.reduce((n, it) => n + (it.tier === DETAIL ? 1 : 0), 0); }
  get midCount() { return this.items.reduce((n, it) => n + (it.tier === MID ? 1 : 0), 0); }
  get count() { return this.items.length; }

  // ------------------------------------------------------------------ 换档和批次的重排
  /** 把一只箱子换到另一档，并且给受影响的批次打上"要重排"的记号。 */
  private retier(it: Item, tier: Tier) {
    const was = it.tier, mark = (map: Map<string, Batch>, key: string) => { map.get(key)!.dirty = true; };
    it.tier = tier;
    if ((was === FAR) !== (tier === FAR)) mark(this.lods, coreKey(it.v));                           // 简模的箱体：只画简模那一档
    if ((was === DETAIL) !== (tier === DETAIL)) mark(this.logos, `${it.v.size}|${it.v.brand}`);     // 平的标：简模、中模都画，只有精模不画（它有自己的喷字）
    if (isOpen(it)) { if (it.own) it.own.visible = tier === DETAIL; return; }
    if (was === MID || tier === MID) { mark(this.mids, coreKey(it.v)); mark(this.rods, `${it.v.size}`); }
    if (was === DETAIL || tier === DETAIL) { mark(this.cores, coreKey(it.v)); mark(this.marks, markKey(it.v)); }
  }
  /**
   * 重排一个"两段"的批次（简模的箱体，或者那块平的标）。upTo 是平时归它画的最高一档：
   * 第一段排档位不超过 upTo 的箱子，第二段排其余的 —— 第二段只在画阴影和倒影的时候才画。
   */
  private refillFar(b: Batch, upTo: Tier) {
    const mesh = b.meshes[0];
    let n = 0;
    const put = (it: Item) => { mesh.setMatrixAt(n, it.matrix); if (mesh.instanceColor) mesh.setColorAt(n, it.color); n++; };
    for (const it of b.items) if (it.tier <= upTo) put(it);
    mesh.count = mesh.userData.far = n;
    // 第二段里不收开着门的箱子：简模是关着门的，用它投影会把敞开的门洞整个堵黑，
    // 所以开门箱的影子和倒影都由它自己的精模负责
    for (const it of b.items) if (it.tier > upTo && !isOpen(it)) put(it);
    mesh.userData.all = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    b.dirty = false;
  }
  /** 重排一个中模 / 精模批次：只收正好在 tier 这一档的成员。网格还没建的批次什么都不用做。 */
  private refill(b: Batch, tier: Tier) {
    b.dirty = false;
    const first = b.meshes[0];
    if (!first) return;
    let n = 0;
    for (const it of b.items) if (it.tier === tier) { first.setMatrixAt(n, it.matrix); if (first.instanceColor) first.setColorAt(n, it.color); n++; }
    first.instanceMatrix.needsUpdate = true;
    if (first.instanceColor) first.instanceColor.needsUpdate = true;
    // 包围球只罩住当前的成员：成员都在镜头背后的时候，整个批次可以直接不画
    first.count = n;
    if (n) first.computeBoundingSphere();
    for (const m of b.meshes) { m.count = m.userData.near = n; m.visible = n > 0; m.boundingSphere = first.boundingSphere; }
  }

  // ------------------------------------------------------------------ 网格
  /** 把一组网格交给一个批次：它们是同一群箱子的不同零件，摆放矩阵完全一样，共用第一个网格的那份缓冲就行。 */
  private adopt(b: Batch, meshes: THREE.InstancedMesh[]) {
    for (const mesh of meshes) {
      if (mesh !== meshes[0]) mesh.instanceMatrix = meshes[0].instanceMatrix;
      mesh.count = 0; mesh.visible = false;
      hideInMirror(mesh);
    }
    b.meshes = meshes;
    b.dirty = true;
    this.root.add(...meshes);
  }
  /** 一种箱体的精模：箱体、镀锌件，外加用到这种箱体的每家船公司各一层喷字（用到的时候才建）。 */
  private makeDetail(key: string) {
    const b = this.cores.get(key)!, d = containerDetail(b.items[0].v), mats = containerMaterials(), cap = b.items.length;
    const body = tintedMesh(d.body, mats.body, 0xffffff, cap); // 不投影：影子交给简模了
    body.name = 'container-body';
    const meshes = [body];
    if (d.metal) {
      const metal = new THREE.InstancedMesh(d.metal, mats.metal, cap);
      metal.receiveShadow = true;
      metal.name = 'container-metal';
      meshes.push(metal);
    }
    this.adopt(b, meshes);
    for (const [markKeyOf, mb] of this.marks) {
      if (!markKeyOf.startsWith(key + '|')) continue;
      const geometry = containerMarks(mb.items[0].v);
      if (!geometry) continue;
      const mesh = new THREE.InstancedMesh(geometry, mats.marks, mb.items.length);
      mesh.receiveShadow = true;
      mesh.name = 'container-marks';
      this.adopt(mb, [mesh]);
    }
  }
  private makeOwn(it: Item) {
    const g = containerMeshes(containerDetail(it.v), it.color);
    g.position.set(it.x, it.y, it.z); g.rotation.y = it.yaw;
    g.name = 'container-open';
    g.visible = false;
    it.own = g;
    this.root.add(g);
  }

  // ------------------------------------------------------------------ 碰撞
  /**
   * 登记一只箱子的碰撞盒。碰撞系统只认横平竖直的盒子，所以：
   *   · 基本摆正的箱子（码垛时故意歪的那一两度）按"摆正了"登记 —— 两头会差几厘米，但盒子不会平白胖出一圈；
   *   · 真的斜放的箱子，沿长边切成几段，每段各取自己的外包盒，一串小盒子沿着斜线排开。
   * 箱顶踩上去是金属声（surface: 'metal'）；开门箱的木地板是 'wood'。
   */
  private collide(it: Item, colliders: Colliders) {
    const skew = Math.abs(Math.sin(2 * it.yaw)) > 0.2;
    const yaw = skew ? it.yaw : Math.round(it.yaw / (Math.PI / 2)) * (Math.PI / 2);
    _m.compose(_p.set(it.x, it.y, it.z), _q.setFromAxisAngle(UP, yaw), ONE);
    for (const b of containerBoxes(it.v.size, it.v.doors)) {
      const sx = b.max[0] - b.min[0], sz = b.max[2] - b.min[2], alongX = sx >= sz;
      const n = skew ? Math.min(10, Math.max(1, Math.round(Math.max(sx, sz) / Math.max(0.25, Math.min(sx, sz))))) : 1;
      for (let i = 0; i < n; i++) {
        _lo.set(b.min[0], b.min[1], b.min[2]); _hi.set(b.max[0], b.max[1], b.max[2]);
        if (alongX) { _lo.x = b.min[0] + (sx * i) / n; _hi.x = b.min[0] + (sx * (i + 1)) / n; }
        else { _lo.z = b.min[2] + (sz * i) / n; _hi.z = b.min[2] + (sz * (i + 1)) / n; }
        _b.set(_lo, _hi).applyMatrix4(_m);
        const shrink = skew ? 0.93 : 1; // 斜着的小段外包盒偏大，收一点
        colliders.add((_b.min.x + _b.max.x) / 2, (_b.min.y + _b.max.y) / 2, (_b.min.z + _b.max.z) / 2, (_b.max.x - _b.min.x) * shrink, _b.max.y - _b.min.y, (_b.max.z - _b.min.z) * shrink, { surface: b.surface });
      }
    }
  }
}

/** 共用同一份箱体几何的条件：规格、花样、做旧都一样。 */
const coreKey = (v: ContainerVariant) => `${v.size}|${v.seed}|${v.wear}`;
/** 喷字还要再分船公司：标不一样。 */
const markKey = (v: ContainerVariant) => `${coreKey(v)}|${v.brand}`;
