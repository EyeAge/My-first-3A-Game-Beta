import * as THREE from 'three';
import { clamp, vnoise } from '../../core/math';
import { decal as decalPatch, label as labelPatch, type LabelOpts } from '../../render/labels';
import { emissive, SURFACES, type SurfaceName } from '../../render/surfaces';
import { chamferBox, hex, Kit, type Mat, type PropModel, type Rgb, type Tint, type V3 } from '../kit';

// 场地设施类道具：隔离墩、防撞柱、系缆桩、标志牌、通道牌、高杆灯、铁丝网围栏、大门、岗亭、道闸、冷藏机组、中继柜。
//
// 和货物道具（cargo.ts）是同一套做法：每种一个函数，用零件箱（Kit）搭好，返回 PropModel ——
// 底面在 y=0，原点在占地中心，自带碰撞盒。同一组参数只搭一次，之后都返回缓存里的同一个模型，
// 交给 PropField 用 InstancedMesh 一次画完。只有中继柜例外：它每次新建，因为每只柜子的灯要各自变色。
//
// 这一类东西有两个共同点，读代码时留意：
//   · 颜色的故事写在顶点色里。隔离墩底下的泥水线、防撞柱的两道黑环、系缆桩被缆绳磨亮的一圈，
//     都不是贴图，而是"按顶点的位置算一个明暗倍数"（零件箱的 tint 可以是函数）。
//   · 会发光的零件（灯面、屏幕、指示灯）用 emissive()：它不受光照影响，颜色直接乘一个大于 1 的倍数，
//     超出 1 的部分由后处理的泛光晕开。场上的"灯亮着"全靠这个，灯本身并不照亮地面。
//
// 尺寸和做法照参考实现的道具表。建议从最简单的防撞柱（bollardPost）看起。

/** 所有场地道具都认的两个选项。 */
export interface SiteOpts {
  /** 个体编号：换一个数，脏污的花纹、磕掉的角、歪的角度就不一样。每种道具只有有限的几个个体，超出就绕回来。 */
  seed?: number;
  /** 摆在室内（淋不到雨）。 */
  interior?: boolean;
}

const HALF_PI = Math.PI / 2, TAU = Math.PI * 2;

// ====================================================================== 缓存

const models = new Map<string, PropModel>();
/** 同一个 key 只搭一次。 */
function cached(key: string, build: () => PropModel): PropModel {
  let m = models.get(key);
  if (!m) models.set(key, (m = build()));
  return m;
}
/** 把任意 seed 归到 0…count-1：一种道具只准备 count 个不同的个体。 */
const variantOf = (seed: number | undefined, count: number) => Math.abs((seed ?? 0) | 0) % count;
const tag = (o: SiteOpts) => (o.interior ? '|in' : '');

// ====================================================================== 小工具

/** 平滑的 0→1 过渡：v 在 lo 时是 0，在 hi 时是 1。lo 可以比 hi 大（那就是反过来，从 1 降到 0）。 */
const sstep = (lo: number, hi: number, v: number) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };
/** 两个颜色倍数之间按 t 混合。 */
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 先按 rot 转、再挪到 pos 的变换矩阵（和 Kit.push 的约定一样）。 */
function matrixOf(pos: V3, rot: V3 = [0, 0, 0]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(1, 1, 1));
}

const paintColor = (name: SurfaceName) => (SURFACES[name] as { color: number }).color;
/**
 * 材质的底色是 base，想让某个零件显示成 target，顶点色该乘多少。
 * 用它可以让道闸的橙色机箱、红白相间的栏杆、黄色托柱共用同一个"白漆"材质：少一种材质就少一次绘制调用。
 * base 要选最亮的那个颜色，这样倍数都不超过 1。
 */
function toward(target: number, base: number, mul = 1): Rgb {
  const t = hex(target), b = hex(base);
  return [(t[0] / Math.max(b[0], 1e-4)) * mul, (t[1] / Math.max(b[1], 1e-4)) * mul, (t[2] / Math.max(b[2], 1e-4)) * mul];
}

interface PrismOpt { sides?: number; rows?: number; open?: boolean; turn?: number; tint?: Tint; cast?: boolean }
/**
 * 棱柱（或者棱台）：侧面是一块块平的，棱是硬的。八角灯杆、六角螺母用它。
 * 做法：先要一个普通圆柱，再把它自带的"圆滑"法线删掉 —— 零件箱发现没有法线，会按每个三角形自己的朝向重算，
 * 于是每个侧面各有各的朝向，高光在棱上断开，看起来就是棱柱而不是圆柱。
 * (x, y, z) 是中心；turn 是绕竖轴转的角度；rows 是沿高度分几段（长杆多分几段，烤脏时才有深浅变化）。
 */
function prism(k: Kit, mat: Mat, rBottom: number, rTop: number, len: number, x: number, y: number, z: number, o: PrismOpt = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, o.sides ?? 8, o.rows ?? 1, o.open ?? false);
  g.deleteAttribute('normal');
  k.add(mat, g, { tint: o.tint, cast: o.cast }, matrixOf([x, y, z], [0, o.turn ?? 0, 0]));
}

/** 螺栓朝哪边伸出来 → 把"立着的圆柱"转到那个方向要用的旋转。 */
const STUD_ROT: Record<string, V3> = { y: [0, 0, 0], x: [0, 0, -HALF_PI], '-x': [0, 0, HALF_PI], z: [HALF_PI, 0, 0], '-z': [-HALF_PI, 0, 0] };
interface StudOpt { sides?: number; hex?: boolean; dir?: 'y' | 'x' | '-x' | 'z' | '-z'; tint?: Tint; raw?: boolean }
/**
 * 螺栓头 / 螺母 / 销子：一截短圆柱，只有侧面和朝外的那个端面。
 * 另一个端面压在别的零件上，永远看不见，就不画了 —— 一件道具上常有十几颗螺栓，每颗省 6 个三角形。
 * pos 是圆柱的中心；dir 是它伸出来的方向；hex 为真时做成棱是硬的六角螺母。
 */
function stud(k: Kit, mat: Mat, r: number, len: number, pos: V3, o: StudOpt = {}) {
  const g = new THREE.CylinderGeometry(r, r, len, o.sides ?? 6);
  // 圆柱的三角形分三组：侧面、顶面、底面（按这个顺序排）。把最后一组（底面）从索引里去掉
  const bottom = g.groups[2], index = Array.from(g.getIndex()!.array);
  index.splice(bottom.start, bottom.count);
  g.setIndex(index);
  if (o.hex) g.deleteAttribute('normal');
  k.add(mat, g, { tint: o.tint, raw: o.raw }, matrixOf(pos, STUD_ROT[o.dir ?? 'y']));
}

/**
 * 按"高度"贴一张具名贴纸，宽度不给就按贴纸自己的长宽比算。
 * （零件箱的 decal 是按宽度给的；参考里的数字都是高度，这里换算一下，免得每处都要自己算。）
 */
function sticker(k: Kit, name: string, h: number, pos: V3, rot?: V3, w?: number) {
  k.decal(name, w ?? h * decalPatch(name).aspect, pos, rot, h);
}

/** 字最多可以被横向压窄到原来的几成。喷在牌子上的字常常是瘦高的，压到七成还很自然，再窄就难认了。 */
const MAX_SQUEEZE = 0.7;
/**
 * 把一行字放进宽 maxW 的地方，字高尽量取 h。
 * 零件箱的 label 在字太长时只压宽度、不动高度，长一点的字会被压成一条条细线。
 * 这里先算一下：如果压到七成还放不下，就把字高也按比例缩小。
 */
function fitLabel(k: Kit, text: string, opts: LabelOpts, maxW: number, h: number, pos: V3, rot?: V3) {
  const aspect = Math.max(labelPatch(text, opts).aspect, 1e-3);
  k.label(text, opts, maxW, Math.min(h, maxW / (aspect * MAX_SQUEEZE)), pos, rot);
}

/** 水泥贴图一张铺 3 米；离板缝 30 厘米以内有顺着缝渗出来的污渍，要躲开。 */
const CONCRETE_TILE = 3, JOINT_MARGIN = 0.3;
/**
 * 在一张水泥贴图的"中间地带"里挑一个点，让大小为 size 的零件放在那里不会碰到四边的板缝。
 * spot 换一个数就换一个地方，这样两个墩子不会取到贴图上完全相同的一块。
 */
function tileSpot(spot: number, size: number): V3 {
  const room = Math.max(0, CONCRETE_TILE - 2 * JOINT_MARGIN - size);
  // 一个凑合用的"伪随机"：正弦值乘一个大数，取小数部分
  const pick = (salt: number) => { const v = Math.sin((spot + 1) * 12.9898 * salt) * 43758.5453; return JOINT_MARGIN + size / 2 + room * (v - Math.floor(v)); };
  return [pick(1), pick(2.3), pick(3.7)];
}
interface BlockOpt { c?: number; tint?: Tint; spot?: number }
/**
 * 水泥块（倒角盒）。和 k.box('concrete', …) 只差一点：贴图取哪一块由这里定，不是随机的。
 *
 * 水泥贴图是照"一块 3 米见方的地坪板"画的，四边有一圈板缝。零件箱默认把每个零件的贴图随机挪开几米，
 * 一个小小的灯杆墩子就有可能正好压在板缝上 —— 墩子中间凭空多出一道黑线。
 * 零件箱是按零件"自己的坐标"铺贴图的，所以这里先把盒子挪到板的中间地带、让它在那里铺好贴图，再用变换矩阵挪回原位。
 */
function concreteBlock(k: Kit, sx: number, sy: number, sz: number, x: number, y: number, z: number, o: BlockOpt = {}) {
  const at = tileSpot(o.spot ?? 0, Math.max(sx, sy, sz)), g = chamferBox(sx, sy, sz, o.c ?? 0.015);
  g.translate(at[0], at[1], at[2]);
  k.add('concrete', g, { tint: o.tint, shift: false }, matrixOf([x - at[0], y - at[1], z - at[2]]));
}

/**
 * 放样：把一个截面沿 x 方向一站一站地摆过去，相邻两站之间连成面，两头封口。隔离墩就是这么做的。
 *   profile   截面，画在"宽–高"平面里的闭合多边形 [宽度方向的坐标, 高度]，按逆时针写；
 *   stations  每一站的 x；
 *   place     (宽, 高, 站) → 这个点最后的位置。可以在这里让两头收窄一点；
 *   soft      截面上相邻两条边的夹角小于它（弧度）就做圆滑过渡，大于它就是硬棱。
 */
function loft(profile: [number, number][], stations: number[], place: (w: number, y: number, x: number) => V3, soft = 0.7): THREE.BufferGeometry {
  const n = profile.length, pos: number[] = [], nor: number[] = [];
  // 每条边朝外的方向：截面是逆时针的，所以把边的方向 (dw, dy) 顺时针转 90°，得到 (dy, -dw)
  const edgeNormal = profile.map((p, i) => {
    const q = profile[(i + 1) % n], dw = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dw, dy) || 1;
    return [dy / len, -dw / len];
  });
  // 一条边在它某一头的法线：和邻边夹角小，就取两条边的平均（看起来是圆角），否则用自己的（硬棱）
  const cornerNormal = (edge: number, atEnd: boolean): V3 => {
    const other = atEnd ? (edge + 1) % n : (edge + n - 1) % n, a = edgeNormal[edge], b = edgeNormal[other];
    if (Math.acos(clamp(a[0] * b[0] + a[1] * b[1], -1, 1)) > soft) return [0, a[1], a[0]];
    const w = a[0] + b[0], y = a[1] + b[1], len = Math.hypot(w, y) || 1;
    return [0, y / len, w / len]; // 截面的"宽"对应模型的 z，"高"对应 y
  };
  // 加一个三角形。三个顶点的先后顺序决定哪一面是正面；这里按法线自动调，保证正面朝外
  const tri = (a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const facing = (uy * vz - uz * vy) * (na[0] + nb[0] + nc[0]) + (uz * vx - ux * vz) * (na[1] + nb[1] + nc[1]) + (ux * vy - uy * vx) * (na[2] + nb[2] + nc[2]);
    const order: [V3, V3][] = facing >= 0 ? [[a, na], [b, nb], [c, nc]] : [[a, na], [c, nc], [b, nb]];
    for (const [p, normal] of order) { pos.push(p[0], p[1], p[2]); nor.push(normal[0], normal[1], normal[2]); }
  };
  for (let s = 0; s + 1 < stations.length; s++) for (let i = 0; i < n; i++) {
    const p = profile[i], q = profile[(i + 1) % n], np = cornerNormal(i, false), nq = cornerNormal(i, true);
    const a = place(p[0], p[1], stations[s]), b = place(p[0], p[1], stations[s + 1]);
    const c = place(q[0], q[1], stations[s + 1]), d = place(q[0], q[1], stations[s]);
    tri(a, b, c, np, np, nq); tri(a, c, d, np, nq, nq);
  }
  // 两头的封口：把截面这个多边形切成三角形
  const faces = THREE.ShapeUtils.triangulateShape(profile.map(([w, y]) => new THREE.Vector2(w, y)), []);
  for (const [x, sign] of [[stations[0], -1], [stations[stations.length - 1], 1]]) {
    const normal: V3 = [sign, 0, 0], at = (i: number) => place(profile[i][0], profile[i][1], x);
    for (const f of faces) tri(at(f[0]), at(f[1]), at(f[2]), normal, normal, normal);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// ====================================================================== 水泥隔离墩

export interface JerseyBarrierOpts extends SiteOpts { /** 顶面和上部两个斜面贴黄黑警示条。 */ stripe?: boolean }

/**
 * 新泽西护栏的半边截面 [离中线多远, 高度]，从墙脚往上：
 * 底下一小段直壁 → 一段大斜坡（车轮压上去会被推回路面，这是这种护栏的设计）→ 上面近乎直立的墙身 → 顶上一个小倒角。
 * 每段斜面中间多加了一个点：墩子的脏污是写在顶点色里的，点密一些，泥水线和水渍才画得出来。
 */
const JERSEY_HALF: [number, number][] = [[0.3, 0], [0.3, 0.076], [0.2135, 0.203], [0.127, 0.33], [0.1135, 0.45], [0.1, 0.57], [0.0885, 0.68], [0.077, 0.79], [0.06, 0.81]];

/**
 * 水泥隔离墩，3.0 × 0.81 × 0.6 米，长边沿 x。4 个个体。
 * 碰撞盒分两级（宽的底座 + 窄的墙身），所以人可以贴着墙身站在底座的斜坡边上，子弹也能擦着墙身飞过去。
 */
export function jerseyBarrier(o: JerseyBarrierOpts = {}): PropModel {
  const stripe = !!o.stripe, v = variantOf(o.seed, 4);
  return cached(`jersey_barrier|${stripe}|${v}${tag(o)}`, () => {
    const k = new Kit('jersey_barrier', v, { interior: o.interior }), wob = v * 3.7;
    // 整圈截面 = 右半边（从下往上）+ 左半边（镜像过去，从上往下）
    const profile: [number, number][] = [...JERSEY_HALF, ...JERSEY_HALF.map(([w, y]): [number, number] => [-w, y]).reverse()];
    // 沿长度每 25 厘米一站；两头最后 3 厘米单独一站，在那里收窄 9%、压矮一点，做出端头的倒角
    const stations = [-1.5, -1.47];
    for (let x = -1.25; x <= 1.26; x += 0.25) stations.push(x);
    stations.push(1.47, 1.5);
    // 7 处磕掉了表皮、露出浅色新茬的斑：位置、大小、在哪一侧都是随机的
    const chips = Array.from({ length: 7 }, () => ({ x: k.range(-1.5, 1.5), y: k.range(0, 0.8), r: k.range(0.08, 0.22), side: k.rng() < 0.5 ? 1 : -1 }));

    // 贴图怎么铺：墩子长 3 米，正好是一张水泥贴图的宽度。让墩子的两头对齐贴图的左右两边，
    // 贴图上的板缝就落在墩子的端头（那里本来就该有接缝），而不是从墩子中间穿过去。
    // 做法和 concreteBlock 一样：在"挪过的坐标"里放样、铺贴图，再用矩阵挪回来。高度方向每个个体取贴图上不同的一段
    const uvShift: V3 = [1.5, 0.3 + v * 0.55, 1.5];
    const body = loft(profile, stations, (w, y, x) => {
      const end = Math.abs(x) > 1.49 ? 1 : 0;
      return [x + uvShift[0], y - end * 0.022 * (y / 0.81) + uvShift[1], w * (1 - end * 0.09) + uvShift[2]];
    });
    k.add('concrete', body, {
      shift: false,
      tint: (x, y, z) => {
        const base = 0.86 + 0.2 * vnoise(x * 1.3 + wob, y * 3 + z * 2) + 0.08 * vnoise(x * 7, y * 9 + wob);
        let c: Rgb = [base, base * 0.99, base * 0.97];
        c = mix3(c, [base * 0.5, base * 0.48, base * 0.44], sstep(0.3, 0, y) * 0.8);                                  // 离地 30 厘米以下：溅上来的泥水
        const streak = sstep(0.55, 0.8, vnoise(x * 4.5 + wob, 3.3)) * sstep(0.25, 0.8, y);                             // 从顶上流下来的水渍（只看 x，所以是竖条）
        c = mix3(c, [base * 0.62, base * 0.6, base * 0.56], streak * 0.6);
        const scuff = sstep(0.6, 0.85, vnoise(x * 2.1 + wob * 2, z * 3)) * sstep(0.2, 0.33, y) * sstep(0.62, 0.4, y);  // 腰上一条被车蹭黑的带子
        c = mix3(c, [0.22, 0.22, 0.22], scuff * 0.65);
        for (const chip of chips) if (Math.sign(z || 1) === chip.side) {
          const d = Math.hypot(x - chip.x, y - chip.y) / chip.r;
          if (d < 1) c = mix3(c, [1.12, 1.1, 1.05], (1 - d) * 0.7);
        }
        if (Math.abs(x) > 1.4) c = mix3(c, [1.08, 1.06, 1.02], 0.4 * vnoise(y * 9, z * 9 + wob));                      // 两端搬运时磨得发白
        return c;
      },
    }, matrixOf([-uvShift[0], -uvShift[1], -uvShift[2]]));
    // 每侧底下两个叉车槽：一片近乎全黑的面片假装是凹进去的洞，上沿加一道小檐
    for (const side of [-1, 1]) for (const x of [-0.85, 0.85]) {
      k.plane('concrete', 0.3, 0.058, [x, 0.03, side * 0.3015], { rot: [0, side > 0 ? 0 : Math.PI, 0], tint: 0.05 });
      k.box('concrete', 0.34, 0.012, 0.012, x, 0.064, side * 0.3, { plain: true, tint: 0.7 });
    }
    // 顶上两只生锈的吊环（吊车就是钩着它们把墩子吊起来的）
    for (const x of [-0.9, 0.9]) k.hose('steel_rust', [[x - 0.05, 0.8, 0], [x - 0.04, 0.85, 0], [x + 0.04, 0.85, 0], [x + 0.05, 0.8, 0]], 0.008, { steps: 6, seg: 4, cast: false });
    if (stripe) {
      k.plane('hazard_stripes', 2.9, 0.118, [0, 0.814, 0], { rot: [-HALF_PI, 0, 0], cast: false });
      // 上部墙身不是直立的，每升高 1 米往里收 10 厘米（0.108 弧度）；警示条要跟着这个坡度贴
      for (const side of [-1, 1]) k.plane('hazard_stripes', 2.9, 0.2, [0, 0.68, side * 0.0925], { rot: [side > 0 ? -0.108 : 0.108, side > 0 ? 0 : Math.PI, 0], cast: false });
    }
    // 泥水线已经在上面的顶点色里画过了，零件箱统一烤的那层脏只要一半，免得墙脚黑成一片
    return k.finish({
      size: [3, 0.81, 0.6], grime: 0.5,
      boxes: [
        { min: [-1.5, 0, -0.3], max: [1.5, 0.33, 0.3], surface: 'concrete' },      // 底座
        { min: [-1.5, 0.33, -0.13], max: [1.5, 0.81, 0.13], surface: 'concrete' }, // 墙身
      ],
    });
  });
}

// ====================================================================== 防撞柱

/** 防撞柱：黄色钢管，半径 8.3 厘米、高 1 米，两道黑色反光带。4 个个体。 */
export function bollardPost(o: SiteOpts = {}): PropModel {
  const v = variantOf(o.seed, 4);
  return cached(`bollard_post|${v}${tag(o)}`, () => {
    const k = new Kit('bollard_post', v, { interior: o.interior }), wob = v * 1.7, R = 0.083;
    // 柱身切成 6 段，每段一个圆筒。黑环不是另一种材质，只是那两段的顶点色压到近乎全黑 ——
    // 顶点色只能在顶点之间渐变，要得到一条干脆的黑黄分界线，就得在分界处把圆筒切开，让两边各有各的顶点。
    const cuts = [0.012, 0.3, 0.6, 0.69, 0.78, 0.87, 0.955];
    const isBand = (y: number) => (y > 0.6 && y < 0.69) || (y > 0.78 && y < 0.87);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const y0 = cuts[i], y1 = cuts[i + 1], band = isBand((y0 + y1) / 2);
      k.cyl('paint_yellow', R, y1 - y0, 0, (y0 + y1) / 2, 0, {
        seg: 12, open: true, shift: false, // shift: false —— 六段是同一根管子，贴图要接得上
        tint: band ? 0.05 : (x, y, z) => {
          const s = (0.55 + 0.45 * sstep(0, 0.35, y)) * (0.9 + 0.2 * vnoise(x * 30 + wob, y * 6 + z * 30)); // 越往下越暗（泥水、鞋印）
          return [s, s * 0.97, s * 0.9];
        },
      });
    }
    // 压扁的半球顶：只要球的上半个，再把高度压到 55%
    const dome = new THREE.SphereGeometry(R, 12, 4, 0, TAU, 0, HALF_PI);
    dome.scale(1, 0.55, 1);
    k.add('paint_yellow', dome, { tint: [0.95, 0.93, 0.88] }, matrixOf([0, 0.955, 0]));
    // 镀锌底板 + 四角的螺栓；根部一圈深色套环
    k.box('steel_galv', 0.17, 0.012, 0.17, 0, 0.006, 0, { c: 0.004 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) stud(k, 'steel_galv', 0.011, 0.012, [sx * 0.066, 0.017, sz * 0.066]);
    k.cyl('paint_yellow', R + 0.006, 0.02, 0, 0.022, 0, { seg: 12, open: true, tint: [0.5, 0.48, 0.42] });
    // 这么细的柱子不该把寻路网格里整整一格（2 米见方）都标成"不能走"，所以 noNav
    return k.finish({ size: [0.17, 1, 0.17], grime: 0.6, boxes: [{ min: [-0.085, 0, -0.085], max: [0.085, 1, 0.085], surface: 'metal', noNav: true }] });
  });
}

// ====================================================================== 系缆桩

/** 系缆桩：码头沿上拴船缆的铸钢桩，0.7 × 0.6 × 0.7 米，羊角沿 x。3 个个体。 */
export function bollardMooring(o: SiteOpts = {}): PropModel {
  const v = variantOf(o.seed, 3);
  return cached(`bollard_mooring|${v}${tag(o)}`, () => {
    const k = new Kit('bollard_mooring', v, { interior: o.interior }), wob = v * 2.1;
    // 桩腰（高 0.3–0.47 米）一圈被缆绳常年磨得发亮：在那个高度把明暗加上 0.9
    const worn: Tint = (x, y, z) => {
      const rope = sstep(0.3, 0.4, y) * sstep(0.47, 0.4, y);
      const s = 0.75 + 0.4 * vnoise(x * 6 + wob, z * 6 + y * 4) + rope * 0.9;
      return [s, s * 0.97, s * 0.93];
    };
    k.cyl('steel_dark', 0.35, 0.045, 0, 0.0225, 0, { r2: 0.34, seg: 16, tint: worn });  // 底法兰
    stud(k, 'steel_rust', 0.37, 0.006, [0, 0.003, 0], { sides: 12 });                   // 法兰底下渗出来的一圈锈
    for (let i = 0; i < 6; i++) {                                                       // 6 颗地脚螺栓：六角螺母 + 露出来的一截螺杆
      const a = (i * Math.PI) / 3 + 0.3, x = Math.cos(a) * 0.285, z = Math.sin(a) * 0.285;
      stud(k, 'steel_rust', 0.026, 0.03, [x, 0.058, z], { hex: true });
      stud(k, 'steel_rust', 0.013, 0.022, [x, 0.08, z], { sides: 4 });
    }
    // 桩身：腰细头大的车削件 —— 缆绳套上去以后往上滑会被大头卡住
    k.lathe('steel_dark', [[0.25, 0.045], [0.21, 0.08], [0.165, 0.16], [0.145, 0.27], [0.15, 0.36], [0.17, 0.43], [0.19, 0.5], [0.17, 0.57], [0.1, 0.6], [0, 0.602]], 0, 0, 0, { seg: 16, tint: worn });
    // 横穿桩头的羊角：一根圆柱，两头各一个压扁的半球 + 一圈挡盘
    k.cyl('steel_dark', 0.11, 0.5, 0, 0.485, 0, { axis: 'x', seg: 12, open: true, tint: worn });
    for (const side of [-1, 1]) {
      const cap = new THREE.SphereGeometry(0.108, 12, 3, 0, TAU, 0, HALF_PI);
      cap.scale(1, 0.55, 1);
      k.add('steel_dark', cap, { tint: worn }, matrixOf([side * 0.25, 0.485, 0], [0, 0, -side * HALF_PI])); // 半球本来朝上，转到朝 ±x
      k.cyl('steel_dark', 0.125, 0.03, side * 0.235, 0.485, 0, { axis: 'x', seg: 10, tint: worn });
    }
    return k.finish({ size: [0.7, 0.6, 0.7], boxes: [{ min: [-0.3, 0, -0.22], max: [0.3, 0.6, 0.22], surface: 'metal' }] });
  });
}

// ====================================================================== 标志牌

/** 主牌上可以贴的 6 种图标（贴纸名）。 */
export const SIGN_ICONS = ['hazard_general', 'no_entry', 'hazard_voltage', 'berth4', 'arrow', 'hazard_flammable'] as const;
/** 副牌上的默认文字，按 seed 轮着取。 */
export const SIGN_TEXTS = ['仅限授权人员', '禁止行人通行', '请穿反光服并佩戴安全帽', '自动作业车辆', '请勿靠近'] as const;

export interface SignPostOpts extends SiteOpts {
  /** 主牌的图标，不给就按 seed 从 SIGN_ICONS 里轮着取。 */
  sign?: (typeof SIGN_ICONS)[number];
  /** 副牌上的一行字，不给就按 seed 从 SIGN_TEXTS 里轮着取。 */
  text?: string;
}

/**
 * 标志牌，高 2.4 米：方管立柱上一块 0.6 米见方的主牌（图标）和一块 0.6 × 0.22 的副牌（一行字），牌面朝 +z。
 * 警告类图标配黄底，"四号泊位"和箭头配深蓝底，其余配白底。整块牌子按 seed 歪一点点（最多 0.7°），一排牌子就不会齐得像尺子画的。
 */
export function signPost(o: SignPostOpts = {}): PropModel {
  const seed = Math.abs((o.seed ?? 0) | 0), lean = ((seed % 5) - 2) * 0.006;
  const sign = o.sign && SIGN_ICONS.includes(o.sign) ? o.sign : SIGN_ICONS[seed % SIGN_ICONS.length];
  const text = o.text || SIGN_TEXTS[seed % SIGN_TEXTS.length];
  return cached(`sign_post|${sign}|${text}|${seed % 5}${tag(o)}`, () => {
    const k = new Kit('sign_post', seed % 5, { interior: o.interior });
    concreteBlock(k, 0.3, 0.07, 0.3, 0, 0.03, 0, { tint: 0.8, spot: seed });
    k.box('steel_galv', 0.05, 2.38, 0.05, 0, 1.2, 0, { c: 0.006 });
    k.box('steel_galv', 0.058, 0.012, 0.058, 0, 2.395, 0, { plain: true });  // 管帽
    k.box('steel_galv', 0.13, 0.012, 0.13, 0, 0.07, 0, { plain: true });     // 底板
    k.push([0, 0, 0], [0, 0, lean]);
    // 每块牌 = 一张铝板 + 贴在上面的一层漆膜（比铝板小一圈，四周露出一道铝边）
    // 底色不另用别的漆材质，而是把白漆的顶点色染过去（见 toward）：整件道具少一次绘制调用
    const board = (w: number, h: number, y: number, color: SurfaceName) => {
      k.box('aluminium', w, h, 0.004, 0, y, 0.031, { plain: true });
      k.box('paint_white', w - 0.02, h - 0.02, 0.002, 0, y, 0.034, { plain: true, tint: toward(paintColor(color), paintColor('paint_white')) });
    };
    // 警告类配黄底；"四号泊位"是黄字、箭头是白的，印在白底上看不见，给它们配深蓝底；其余白底
    board(0.6, 0.6, 2.02, sign.startsWith('hazard') ? 'paint_yellow' : sign === 'berth4' || sign === 'arrow' ? 'paint_blue' : 'paint_white');
    // 图标放进 0.5 米见方的框里，保持它自己的长宽比（"四号泊位"和箭头是横长的，硬拉成方的会变形）
    const aspect = decalPatch(sign).aspect, iconW = aspect >= 1 ? 0.5 : 0.5 * aspect;
    k.decal(sign, iconW, [0, 2.02, 0.0362]);
    board(0.6, 0.22, 1.56, 'paint_white');
    fitLabel(k, text, { color: 'black', font: 'sans', distress: 0.15 }, 0.52, 0.07, [0, 1.56, 0.0362]);
    for (const y of [1.85, 2.2, 1.56]) {                                       // 背后三道抱箍：一条扁铁 + 卡在立柱上的夹块
      k.box('steel_galv', 0.5, 0.03, 0.012, 0, y, 0.024, { plain: true });
      k.box('steel_galv', 0.09, 0.04, 0.07, 0, y, -0.002, { c: 0.004 });
    }
    for (const [x, y] of [[-0.26, 2.28], [0.26, 2.28], [-0.26, 1.76], [0.26, 1.76]]) stud(k, 'steel_galv', 0.008, 0.004, [x, y, 0.0365], { dir: 'z' }); // 主牌四角的铆钉
    k.pop();
    return k.finish({
      size: [0.6, 2.4, 0.08],
      boxes: [
        { min: [-0.03, 0, -0.03], max: [0.03, 2.4, 0.03], surface: 'metal', noNav: true },            // 立柱
        { min: [-0.3, 1.44, 0.02], max: [0.3, 2.33, 0.04], surface: 'metal', bulletOnly: true },      // 牌面：只挡子弹，人蹭过去不会被一块铁皮卡住
      ],
    });
  });
}

// ====================================================================== 通道指示牌

export interface LaneSignOpts extends SiteOpts {
  /** 牌子上的字，默认"一号通道"。 */
  text?: string;
  /** 两面都喷字（默认只有朝 +z 的一面有）。 */
  double?: boolean;
}

/** 通道指示牌：3.2 米高的镀锌圆杆顶着一块 1.1 × 0.62 米的黄牌，黑色喷字。牌面朝 +z。 */
export function laneSign(o: LaneSignOpts = {}): PropModel {
  const text = o.text || '一号通道', double = !!o.double, v = variantOf(o.seed, 2);
  return cached(`lane_sign|${text}|${double}|${v}${tag(o)}`, () => {
    const k = new Kit('lane_sign', v, { interior: o.interior });
    const HEIGHT = 3.2, BOARD_W = 1.1, BOARD_H = 0.62, THICK = 0.03, boardY = HEIGHT - BOARD_H / 2 - 0.05;
    k.cyl('steel_galv', 0.045, HEIGHT, 0, HEIGHT / 2, 0, { seg: 8 });
    k.box('steel_dark', 0.3, 0.02, 0.3, 0, 0.01, 0, { c: 0.004 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) stud(k, 'steel_galv', 0.012, 0.012, [sx * 0.11, 0.026, sz * 0.11]);
    // 牌子挂在杆子前面（而不是让杆子从牌子中间穿过去 —— 那样杆子会把字从中间劈开）。两面都要字，就前后各挂一块
    const ink: LabelOpts = { color: 'black', font: 'stencil', distress: 0.35 }, boardZ = 0.045 + THICK / 2 + 0.004;
    for (const side of double ? [1, -1] : [1]) {
      k.box('paint_yellow', BOARD_W, BOARD_H, THICK, 0, boardY, side * boardZ, { c: 0.01 });
      fitLabel(k, text, ink, BOARD_W - 0.1, 0.4, [0, boardY, side * (boardZ + THICK / 2 + 0.002)], [0, side > 0 ? 0 : Math.PI, 0]);
    }
    for (const dy of [-0.2, 0.2]) k.box('steel_galv', 0.16, 0.04, 0.1, 0, boardY + dy, 0, { c: 0.004 }); // 两道抱箍，把牌子夹在杆上
    const back = double ? -boardZ - THICK / 2 : boardZ - THICK / 2; // 牌面碰撞盒的背面：单面时只包住前面那一块
    return k.finish({
      size: [BOARD_W, HEIGHT, 0.3],
      boxes: [
        { min: [-0.06, 0, -0.06], max: [0.06, HEIGHT, 0.06], surface: 'metal', noNav: true },
        { min: [-BOARD_W / 2, boardY - BOARD_H / 2, back], max: [BOARD_W / 2, boardY + BOARD_H / 2, boardZ + THICK / 2], surface: 'metal', bulletOnly: true },
      ],
    });
  });
}

// ====================================================================== 高杆灯

/** 投光灯的颜色：偏暖的白。 */
export const LIGHT_MAST_COLOR = 0xffe3bd;
/**
 * 高杆灯 4 个灯头的位置和朝向（模型自己的坐标）：横担两端（z = ±0.55）各两盏，背靠背朝 ±x，往下俯 0.62 弧度（约 36°）。
 * 灯面本身只是一块发光的面片，不会照亮地面；想要光晕、光锥或者真的点光，按这张表去放。
 */
export const LIGHT_MAST_LAMPS: readonly { pos: V3; dir: V3 }[] = [-0.55, 0.55].flatMap((z) => [-1, 1].map((sx) => ({ pos: [sx * 0.34, 13.2, z] as V3, dir: [sx * 0.81, -0.58, 0] as V3 })));

export interface LightMastOpts extends SiteOpts { /** false = 灯灭着（灯面只剩一点点余晖）。默认亮。 */ on?: boolean }

/**
 * 14 米高杆灯。占地是 0.8 米见方的水泥墩；杆顶的横担沿 z 方向，长 1.9 米。
 * 杆子是八棱的锥杆，分三节套接：上面一节比下面一节粗一圈、套住 15 厘米，接头处看得出一道台阶。
 */
export function lightMast(o: LightMastOpts = {}): PropModel {
  const on = o.on !== false, v = variantOf(o.seed, 2);
  return cached(`light_mast|${on}|${v}${tag(o)}`, () => {
    const k = new Kit('light_mast', v, { interior: o.interior });
    const lens = emissive(LIGHT_MAST_COLOR, on ? 8 : 0.02);
    const BASE_Y = 0.35, TOP_Y = 13.3, ARM_Y = TOP_Y + 0.12;
    /** 杆子在高度 y 处的半径：从底部的 0.168 线性收到顶部的 0.07。 */
    const radiusAt = (y: number) => 0.168 + ((0.07 - 0.168) * (y - BASE_Y)) / (TOP_Y - BASE_Y);

    // ---- 水泥墩、底法兰、8 颗地脚螺栓、4 片三角加劲板
    concreteBlock(k, 0.8, 0.32, 0.8, 0, 0.16, 0, { c: 0.03, spot: v, tint: (x, y, z) => { const s = 0.62 + 0.36 * sstep(0, 0.3, y) + 0.1 * vnoise(x * 5, z * 5); return [s, s, s * 0.97]; } });
    k.box('steel_galv', 0.5, 0.03, 0.5, 0, 0.335, 0, { c: 0.006 });
    prism(k, 'steel_galv', 0.2, 0.2, 0.02, 0, 0.36, 0, { turn: Math.PI / 8 });
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) * Math.PI) / 4, x = Math.cos(a) * 0.215, z = Math.sin(a) * 0.215;
      stud(k, 'steel_galv', 0.027, 0.024, [x, 0.362, z], { hex: true });
      stud(k, 'steel_galv', 0.014, 0.07, [x, 0.395, z], { sides: 5 });
    }
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      k.box('steel_galv', 0.012, 0.2, 0.12, Math.cos(a) * 0.2, 0.45, -Math.sin(a) * 0.2, { plain: true, rot: [0, a + HALF_PI, 0] });
    }

    // ---- 八棱锥杆，三节。转 22.5° 是为了让一个平面（而不是一条棱）正对 ±x 和 ±z，检修门才有地方贴
    const sections: [number, number, number, number][] = [[BASE_Y, 4.75, 0, 0.96], [4.6, 9.15, 0.007, 1], [9, TOP_Y, 0.014, 0.92]];
    for (const [y0, y1, sleeve, shade] of sections) prism(k, 'steel_galv', radiusAt(y0) + sleeve, radiusAt(y1) + sleeve, y1 - y0, 0, (y0 + y1) / 2, 0, { rows: 4, open: true, turn: Math.PI / 8, tint: shade });
    prism(k, 'steel_galv', 0.09, 0.09, 0.03, 0, TOP_Y, 0, { turn: Math.PI / 8 });
    // 检修门（离地 1.05 米）+ 门闩 + 高压警示贴。0.924 = cos 22.5°：八边形的"面"到中心的距离是"棱"到中心距离的 0.924 倍
    const face = radiusAt(1.05) * 0.924;
    k.box('steel_galv', 0.13, 0.52, 0.012, 0, 1.05, face + 0.005, { c: 0.004, tint: 0.88 });
    k.box('steel_dark', 0.03, 0.045, 0.012, 0.04, 1.05, face + 0.013, { plain: true });
    sticker(k, 'hazard_voltage', 0.09, [-0.01, 1.2, face + 0.0125]);
    // 穿线管：从墩子上钻出来，拐个弯进杆身
    k.hose('steel_dark', [[-0.3, 0.3, 0.28], [-0.3, 0.52, 0.28], [-0.24, 0.72, 0.2], [-0.1, 0.8, 0.1]], 0.024, { steps: 10, seg: 6 });
    k.cyl('steel_dark', 0.034, 0.03, -0.3, 0.335, 0.28, { seg: 8 });
    // 离地 3 米处一圈套箍 + 朝 +x 伸出去的小支架框（歇脚 / 挂梯子用）
    prism(k, 'steel_galv', radiusAt(3) + 0.012, radiusAt(3) + 0.012, 0.05, 0, 3, 0, { open: true, turn: Math.PI / 8 });
    const rod = { seg: 5, cap: true };
    for (const z of [-0.13, 0.13]) { k.tube('steel_galv', [0.1, 3, z], [0.42, 3, z], 0.012, rod); k.tube('steel_galv', [0.42, 3, z], [0.42, 3.09, z], 0.012, rod); }
    k.tube('steel_galv', [0.42, 3, -0.16], [0.42, 3, 0.16], 0.012, rod);
    // 脚钉：从 3.45 米到 12.9 米，每 38 厘米一根，左右交替。在十米高的地方，没人看得清它是圆是方，用最省的直角方杆
    for (let y = 3.45, i = 0; y < 12.9; y += 0.38, i++) {
      const side = i % 2 ? 1 : -1;
      k.bar('steel_galv', [0, y, side * radiusAt(y) * 0.8], [0, y, side * (radiusAt(y) + 0.15)], 0.016, 0.016, { plain: true });
    }

    // ---- 灯架：一根横担（沿 z）、两根灯臂（沿 x）、两根斜撑
    k.box('steel_galv', 0.1, 0.1, 1.9, 0, ARM_Y, 0, { c: 0.012 });
    for (const z of [-0.55, 0.55]) k.box('steel_galv', 0.5, 0.07, 0.07, 0, ARM_Y + 0.085, z, { c: 0.01 });
    for (const side of [-1, 1]) k.bar('steel_galv', [0, TOP_Y - 0.5, side * 0.08], [0, ARM_Y - 0.03, side * 0.7], 0.04, 0.04, { plain: true });

    // ---- 4 只投光灯头
    const addHead = (x: number, y: number, z: number, yaw: number) => {
      k.push([x, y, z], [0, yaw, 0]);
      k.push([0, 0, 0], [0, 0, -0.62]); // 灯头往下俯 0.62 弧度
      k.box('steel_dark', 0.08, 0.34, 0.46, 0.08, 0, 0, { c: 0.014 });                                // 灯壳
      // 发光面比灯壳的正面靠前 3 厘米，四周用窄框把这道缝挡住。
      // 不能让发光面紧贴着灯壳：两个面离得太近时，远处看显卡分不清谁在前面，亮面和黑壳会一闪一闪地打架。
      k.plane(lens, 0.4, 0.28, [0.15, 0, 0], { rot: [0, HALF_PI, 0], raw: true });
      for (const s of [-1, 1]) {
        k.box('steel_dark', 0.032, 0.018, 0.47, 0.136, s * 0.156, 0, { plain: true });
        k.box('steel_dark', 0.032, 0.33, 0.018, 0.136, 0, s * 0.222, { plain: true });
      }
      k.box('steel_dark', 0.09, 0.008, 0.48, 0.17, 0.175, 0, { plain: true, rot: [0, 0, -0.12] });    // 遮光檐
      for (let i = -3; i <= 3; i++) k.box('steel_dark', 0.045, 0.3, 0.008, 0.02, 0, i * 0.062, { plain: true }); // 背后的散热鳍
      k.pop();
      k.box('steel_galv', 0.03, 0.05, 0.56, 0.02, -0.02, 0, { plain: true });                         // U 形支架：一根横梁 + 两片夹板
      for (const s of [-1, 1]) k.box('steel_galv', 0.1, 0.05, 0.012, 0.05, -0.02, s * 0.275, { plain: true, rot: [0, 0, -0.31] });
      k.pop();
    };
    for (const z of [-0.55, 0.55]) { addHead(0.22, ARM_Y - 0.14, z, 0); addHead(-0.22, ARM_Y - 0.14, z, Math.PI); }

    k.box('steel_dark', 0.16, 0.2, 0.12, 0, TOP_Y - 0.25, -0.14, { c: 0.01 });                         // 镇流器盒
    k.tube('steel_galv', [0, ARM_Y, 0], [0, 14, 0], 0.012, { r2: 0.003, seg: 5, cap: true }); // 避雷针

    const model = k.finish({
      size: [0.8, 14, 0.8],
      boxes: [
        { min: [-0.4, 0, -0.4], max: [0.4, 0.32, 0.4], surface: 'concrete' },
        { min: [-0.17, 0.32, -0.17], max: [0.17, 14, 0.17], surface: 'metal', noNav: true },
      ],
    });
    model.group.userData.lamps = LIGHT_MAST_LAMPS.map((l) => ({ pos: [...l.pos], dir: [...l.dir], color: LIGHT_MAST_COLOR }));
    return model;
  });
}

// ====================================================================== 登记表

/**
 * 所有场地道具，按参考道具表里的名字登记。摆放的代码可以用名字取：SITE.jersey_barrier({ seed: 2 })。
 */
export const SITE: Record<string, (o?: any) => PropModel> = {
  jersey_barrier: jerseyBarrier, bollard_post: bollardPost, bollard_mooring: bollardMooring,
  sign_post: signPost, lane_sign: laneSign,
  light_mast: lightMast,
};
