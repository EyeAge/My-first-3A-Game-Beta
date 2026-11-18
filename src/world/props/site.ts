import * as THREE from 'three';
import { clamp, vnoise } from '../../core/math';
import { decal as decalPatch, label as labelPatch, type LabelOpts } from '../../render/labels';
import { emissive, SURFACES, type SurfaceName } from '../../render/surfaces';
import { chamferBox, hex, Kit, type LocalBox, type Mat, type PropModel, type Rgb, type Tint, type V3 } from '../kit';

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

/**
 * "黑洞"：一种不受光照的近黑色。贴在凹进去的地方（风扇筒里面、百叶后面），假装那里深不见底。
 * 为什么不直接把漆染黑：漆面、塑料这些贴图里的锈迹和灰尘是不跟着染色的，染到最黑也还是一片灰褐色的花纹，不像洞。
 */
const voidBlack = () => emissive(0x0a0b0c, 1);

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

/**
 * 一片铁丝网：其实就是一张分了格的平面，贴上镂空的铁丝网贴图。
 * bulge(x, y) 给出每个顶点往前后鼓出多少 —— 真的网不是绷得平平的，鼓一点点，反光才有变化。
 */
function wireMesh(w: number, h: number, cols: number, rows: number, bulge: (x: number, y: number) => number) {
  const g = new THREE.PlaneGeometry(w, h, cols, rows), p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setZ(i, bulge(p.getX(i), p.getY(i)));
  g.computeVertexNormals();
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

// ====================================================================== 铁丝网围栏

export interface FencePanelOpts extends SiteOpts {
  /** 两头哪边有立柱。一长排围栏里，每片只带左柱，最后一片两头都带，立柱才不会重复。默认 both。 */
  posts?: 'both' | 'left' | 'right' | 'none';
  /** 柱顶挂刺丝的支臂朝哪边斜：-1（默认）朝 -z，1 朝 +z。应该朝"外面"。 */
  lean?: 1 | -1;
  /** 这一片有多长（米），默认 3。围栏段的总长不是 3 的整数倍时，用它把每片搭成正好的长度，而不是去拉伸模型。 */
  length?: number;
}

/**
 * 铁丝网围栏的一跨，长边沿 x，高 2.4 米。网面在立柱的 +z 一侧，刺丝支臂朝 -z 斜出去。
 * 碰撞盒只挡人：铁丝网挡不住子弹，也挡不住视线。
 */
export function fencePanel(o: FencePanelOpts = {}): PropModel {
  const posts = o.posts ?? 'both', lean = o.lean === 1 ? 1 : -1, v = variantOf(o.seed, 3);
  const length = Math.round(clamp(o.length ?? 3, 1, 6) * 100) / 100, half = length / 2;
  return cached(`fence_panel|${posts}|${lean}|${length}|${v}${tag(o)}`, () => {
    const k = new Kit('fence_panel', v, { interior: o.interior });
    const thin = { cast: false }; // 细铁丝在阴影贴图里连一个像素都占不到，投影只会带来闪烁
    const postXs = posts === 'both' ? [-half, half] : posts === 'left' ? [-half] : posts === 'right' ? [half] : [];
    for (const x of postXs) {
      concreteBlock(k, 0.32, 0.09, 0.32, x, 0.035, 0, { c: 0.02, spot: v * 2 + (x > 0 ? 1 : 0), tint: (_x, y) => 0.6 + 0.4 * sstep(0, 0.08, y) }); // 水泥脚
      k.cyl('steel_galv', 0.03, 2.0, x, 1.04, 0, { seg: 8, open: true });                                            // 立柱
      stud(k, 'steel_galv', 0.05, 0.012, [x, 0.086, 0], { sides: 8 });                                               // 底法兰
      stud(k, 'steel_galv', 0.034, 0.05, [x, 2.03, 0], { sides: 8 });                                                // 柱帽
      for (const y of [0.2, 1.05, 1.9]) k.cyl('steel_galv', 0.034, 0.03, x, y, 0, { seg: 8, open: true, cast: false }); // 3 道绑带箍
      k.tube('steel_galv', [x, 2.02, 0], [x, 2.38, lean * 0.36], 0.019, { seg: 5, cap: true });                      // 斜出去的刺丝支臂
    }
    k.tube('steel_galv', [-half, 2, 0.036], [half, 2, 0.036], 0.021, { seg: 6 });                                    // 顶横杆
    for (const y of [0.09, 1.02]) k.tube('steel_galv', [-half, y, 0.012], [half, y, 0.012], 0.0035, { seg: 3, ...thin }); // 两道张紧钢丝
    for (const s of [-1, 1]) k.box('steel_galv', 0.008, 1.9, 0.02, s * (half - 0.038), 1.03, 0.012, { plain: true }); // 两端压网的扁铁
    // 网面：每半米一格。越靠中间鼓得越多（两端被扁铁压住了），最多 ±1 厘米
    const meshW = length - 0.08;
    const mesh = wireMesh(meshW, 1.93, Math.max(2, Math.round(length * 2)), 3, (x, y) => 0.02 * (vnoise(x * 1.3 + v * 7.1, y * 1.5) - 0.5) * (1 - Math.abs(x) / (meshW / 2)));
    // 网面不投影：阴影贴图一个像素有好几厘米，分辨不出网眼，投出来要么是一整块实心的黑影，要么是乱闪的噪点
    k.add('chainlink', mesh, thin, matrixOf([0, 1.025, 0.012]));
    // 支臂上 3 道刺丝，每 18 厘米一个小刺。刺只有 3 厘米长，用一小片两面可见的薄片表示就够了
    for (let row = 0; row < 3; row++) {
      const along = 0.3 + row * 0.33, y = 2.02 + along * 0.36, z = lean * along * 0.36;
      k.tube('steel_galv', [-half, y, z], [half, y, z], 0.0032, { seg: 3, ...thin });
      for (let x = -half + 0.08 + (row % 2) * 0.09; x < half - 0.05; x += 0.18) {
        const a = k.rng() * Math.PI, dy = Math.cos(a) * 0.016, dz = Math.sin(a) * 0.016;
        k.strip('steel_galv', [[x, y - dy, z - dz], [x, y + dy, z + dz]], [0.003, 0, 0]);
      }
    }
    for (let i = 0; i < 5; i++) k.box('steel_galv', 0.012, 0.012, 0.03, -half * 0.8 + i * half * 0.4, 2, 0.02, { plain: true, ...thin }); // 把网扎在顶横杆上的扎丝卡
    return k.finish({ size: [length, 2.4, 0.08], boxes: [{ min: [-half, 0, -0.05], max: [half, 2.4, 0.05], surface: 'metal', playerOnly: true }] });
  });
}

// ====================================================================== 大门：门柱、推拉门扇

/** 大门门柱：0.22 米见方、3.4 米高的深色方钢柱，下面 1.2 米套一段黄黑警示套。 */
export function gatePost(o: SiteOpts = {}): PropModel {
  const v = variantOf(o.seed, 2);
  return cached(`gate_post|${v}${tag(o)}`, () => {
    const k = new Kit('gate_post', v, { interior: o.interior });
    k.box('steel_dark', 0.22, 3.4, 0.22, 0, 1.7, 0, { c: 0.02 });
    k.box('hazard_stripes', 0.26, 1.2, 0.26, 0, 0.6, 0, { c: 0.02 });
    k.box('steel_dark', 0.26, 0.02, 0.26, 0, 3.41, 0, { c: 0.006 }); // 柱帽：盖住方管的管口，雨水才不会灌进去
    return k.finish({ size: [0.26, 3.42, 0.26], boxes: [{ min: [-0.13, 0, -0.13], max: [0.13, 3.4, 0.13], surface: 'metal', noNav: true }] });
  });
}

export interface SlidingGateOpts extends SiteOpts { /** 带不带地上的轨道，默认带。 */ track?: boolean }

/**
 * 推拉大门的门扇：6 米长、2.2 米高的方管框 + 铁丝网，底下两只橡胶轮骑在地轨上。门扇沿 x，原点在门扇正中。
 * 这是"拉开以后停在一边"的样子：门洞在 -x 那一头。地轨从门扇这头一直铺过门洞，
 * 所以它不以原点为中心 —— 从 x = -9.6 到 +3.2。"禁止驶入"的牌子前后两面各挂一块。
 */
export function slidingGate(o: SlidingGateOpts = {}): PropModel {
  const track = o.track !== false;
  return cached(`sliding_gate|${track}${tag(o)}`, () => {
    const k = new Kit('sliding_gate', 0, { interior: o.interior });
    const MID_Y = 1.25;
    k.add('chainlink', wireMesh(6, 2.1, 12, 3, (x, y) => 0.012 * (vnoise(x * 1.1 + 3.3, y * 1.4) - 0.5)), { cast: false }, matrixOf([0, MID_Y, 0]));
    for (const x of [-3, 0, 3]) k.box('steel_galv', 0.06, 2.2, 0.06, x, MID_Y, 0, { c: 0.006 });        // 3 根竖框
    for (const y of [0.18, MID_Y, 2.32]) k.box('steel_galv', 6.06, 0.06, 0.06, 0, y, 0, { c: 0.006 });  // 3 根横框
    for (const x of [-3, 3]) k.tube('steel_galv', [x, 0.2, 0], [0, 2.3, 0], 0.018, { seg: 6 });         // 2 根斜撑：没有它们，6 米长的门扇会被自重拉成平行四边形
    for (const x of [-2.4, 2.4]) {
      k.cyl('rubber', 0.09, 0.05, x, 0.1, 0, { axis: 'z', seg: 10 });
      k.box('steel_galv', 0.04, 0.12, 0.075, x, 0.13, 0, { plain: true });                              // 轮叉
    }
    if (track) k.box('steel_dark', 12.8, 0.03, 0.1, -3.2, 0.015, 0, { plain: true, cast: false });
    // "禁止驶入"：铝牌挂在门扇正中，贴纸贴在牌子上。前后各一块 ——
    // 门扇的轨道只朝一头伸（朝门洞），不能靠"转 180°"来换牌子的朝向，所以干脆两面都挂，怎么摆都看得见
    for (const side of [1, -1]) {
      k.box('aluminium', 0.74, 0.74, 0.004, 0, 1.5, side * 0.034, { plain: true });
      sticker(k, 'no_entry', 0.7, [0, 1.5, side * 0.0375], [0, side > 0 ? 0 : Math.PI, 0]);
    }
    return k.finish({ size: [6.06, 2.35, 0.1], boxes: [{ min: [-3.03, 0, -0.05], max: [3.03, 2.35, 0.05], surface: 'metal', playerOnly: true }] });
  });
}

// ====================================================================== 岗亭

/** 岗亭门头灯的颜色。 */
export const GUARD_BOOTH_LAMP_COLOR = 0xffd9a6;

export interface GuardBoothOpts extends SiteOpts {
  color?: 'white' | 'grey' | 'teal';
  /** false = 门头灯灭着。默认亮。 */
  on?: boolean;
}

/**
 * 岗亭，2.6 × 2.7 × 2.2 米，门开在 +z 面（偏 +x 一侧）。
 * 人进不去（碰撞是一整块），但四面都是玻璃，所以里面的桌子、亮着的显示器、键盘、转椅都搭出来了 ——
 * 从窗外看进去有东西，比一个空壳可信得多。-x 墙外挂着一台空调外机。
 */
export function guardBooth(o: GuardBoothOpts = {}): PropModel {
  const color = o.color === 'grey' || o.color === 'teal' ? o.color : 'white', on = o.on !== false, v = variantOf(o.seed, 2);
  return cached(`guard_booth|${color}|${on}|${v}${tag(o)}`, () => {
    const k = new Kit('guard_booth', v, { interior: o.interior });
    // 屋里的东西另开一只零件箱，用"室内版"材质：它们淋不到雨，不该像外墙那样湿漉漉地反光
    const inside = new Kit('guard_booth_inside', v, { interior: true });
    const W = 2.6, D = 2.2, hx = W / 2, hz = D / 2, wob = v * 1.3;
    /** 几个关键高度：地板面、窗台、窗顶、墙顶。 */
    const FLOOR = 0.12, SILL = 1.0, HEAD = 2.08, TOP = 2.42;
    const paint: SurfaceName = `paint_${color}`;
    // 墙面的明暗：墙脚发暗（溅泥），檐口底下也发暗（常年晒不到、积灰）
    const wall: Tint = (x, y, z) => {
      const s = (0.9 + 0.14 * vnoise(x * 2 + wob, y * 2 + z)) * (0.6 + 0.4 * sstep(0.1, 0.7, y)) * (1 - 0.25 * sstep(2.25, 2.45, y));
      return [s, s * 0.985, s * 0.96];
    };
    const panel = { c: 0.006, tint: wall }, glass = { plain: true, cast: false }; // 玻璃不投影：透明的东西投出实心的影子就穿帮了

    // ---- 底座、两根滑橇、四根角柱
    k.box('steel_dark', W, 0.12, D, 0, 0.06, 0, { c: 0.015 });
    for (const z of [-0.7, 0.7]) k.box('steel_dark', W + 0.06, 0.06, 0.1, 0, 0.03, z, { c: 0.01 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(paint, 0.09, TOP - FLOOR, 0.09, sx * (hx - 0.045), (TOP + FLOOR) / 2, sz * (hz - 0.045), { c: 0.012, tint: wall });

    // ---- 前后两面墙（沿 x）。每面从下到上：墙裙 → 窗台 → 玻璃 + 窗梃 → 上墙板。+z 那面要给门让出位置
    const DOOR_L = 0.3, DOOR_R = 1.12;
    const longWall = (zc: number, out: number) => {
      const x0 = -hx + 0.09, x1 = out > 0 ? DOOR_L - 0.04 : hx - 0.09, len = x1 - x0, cx = (x0 + x1) / 2;
      k.box(paint, len, SILL - FLOOR, 0.05, cx, (SILL + FLOOR) / 2, zc, panel);
      k.box(paint, len, 0.05, 0.075, cx, SILL + 0.01, zc + out * 0.005, { c: 0.008, tint: wall });
      k.box('glass', len, HEAD - SILL - 0.03, 0.008, cx, (SILL + HEAD) / 2 + 0.01, zc, glass);
      const mullions = len > 1.6 ? 2 : 1;
      for (let i = 1; i <= mullions; i++) k.box(paint, 0.04, HEAD - SILL, 0.05, x0 + (len * i) / (mullions + 1), (SILL + HEAD) / 2, zc, panel);
      for (let i = 1; i < 3; i++) k.box(paint, 0.006, SILL - FLOOR - 0.04, 0.056, x0 + (len * i) / 3, (SILL + FLOOR) / 2, zc, { plain: true, tint: wall }); // 墙裙上两道竖向压痕
      k.box(paint, W - 0.18, TOP - HEAD, 0.05, 0, (TOP + HEAD) / 2, zc, panel);
    };
    longWall(hz - 0.03, 1);
    longWall(-hz + 0.03, -1);
    // ---- 左右两面墙（沿 z）
    for (const s of [-1, 1]) {
      const xc = s * (hx - 0.03), len = D - 0.18;
      k.box(paint, 0.05, SILL - FLOOR, len, xc, (SILL + FLOOR) / 2, 0, panel);
      k.box(paint, 0.075, 0.05, len, xc + s * 0.005, SILL + 0.01, 0, { c: 0.008, tint: wall });
      k.box('glass', 0.008, HEAD - SILL - 0.03, len, xc, (SILL + HEAD) / 2 + 0.01, 0, glass);
      k.box(paint, 0.05, HEAD - SILL, 0.04, xc, (SILL + HEAD) / 2, 0, panel);
      k.box(paint, 0.05, TOP - HEAD, len, xc, (TOP + HEAD) / 2, 0, panel);
    }

    // ---- 门（+z 面，x 从 0.30 到 1.12）：两根门框柱，门扇 = 下板 + 上冒头 + 两根边梃 + 玻璃
    const zd = hz - 0.03, doorW = DOOR_R - DOOR_L - 0.02, doorX = (DOOR_L + DOOR_R) / 2;
    for (const x of [DOOR_L - 0.015, DOOR_R + 0.015]) k.box(paint, 0.05, HEAD - FLOOR, 0.07, x, (HEAD + FLOOR) / 2, zd, panel);
    k.box(paint, hx - 0.09 - DOOR_R - 0.04, HEAD - FLOOR, 0.05, (hx - 0.09 + DOOR_R + 0.04) / 2, (HEAD + FLOOR) / 2, zd, panel); // 门和墙角之间剩下的一小条墙
    k.box(paint, doorW, SILL - FLOOR - 0.01, 0.04, doorX, (SILL + FLOOR) / 2, zd + 0.005, panel);
    k.box(paint, doorW, 0.07, 0.04, doorX, HEAD - 0.04, zd + 0.005, panel);
    for (const s of [-1, 1]) k.box(paint, 0.07, HEAD - SILL, 0.04, doorX + s * (doorW / 2 - 0.035), (SILL + HEAD) / 2, zd + 0.005, panel);
    k.box('glass', doorW - 0.12, HEAD - SILL - 0.08, 0.008, doorX, (SILL + HEAD) / 2 - 0.02, zd + 0.005, glass);
    k.box('steel_galv', doorW - 0.06, 0.22, 0.004, doorX, FLOOR + 0.14, zd + 0.027, { plain: true });                // 镀锌踢脚板
    k.box('steel_galv', 0.03, 0.14, 0.02, DOOR_L + 0.09, 1.05, zd + 0.035, { c: 0.004 });                             // 把手座
    k.tube('steel_galv', [DOOR_L + 0.09, 1, zd + 0.06], [DOOR_L + 0.2, 1, zd + 0.06], 0.009, { seg: 6, cap: true });  // 把手
    for (const y of [0.4, 1.75]) k.cyl('steel_galv', 0.012, 0.1, DOOR_R + 0.002, y, zd + 0.03, { seg: 6 });           // 两个合页
    k.box('steel_dark', 0.9, 0.03, 0.3, doorX, 0.105, hz + 0.15, { c: 0.006 });                                       // 门外的踏步板

    // ---- 屋顶：外挑的白漆顶板、深色盖板、前后檐的镀锌封边、一根落水管
    k.box(paint, W + 0.36, 0.1, D + 0.4, 0, TOP + 0.05, 0, { c: 0.02, tint: (x, _y, z) => { const s = 0.72 + 0.2 * vnoise(x * 1.5, z * 1.5 + wob); return [s, s, s * 0.97]; } });
    k.box('steel_dark', W + 0.3, 0.03, D + 0.34, 0, TOP + 0.112, 0, { c: 0.01 });
    for (const s of [-1, 1]) k.box('steel_galv', W + 0.36, 0.06, 0.08, 0, TOP - 0.005, s * (hz + 0.23), { c: 0.012 });
    k.hose('steel_galv', [[-hx - 0.16, TOP - 0.03, hz + 0.23], [-hx - 0.1, TOP - 0.2, hz + 0.1], [-hx - 0.03, TOP - 0.4, hz + 0.03], [-hx - 0.03, 0.2, hz + 0.03], [-hx - 0.1, 0.06, hz + 0.1]], 0.03, { steps: 26, seg: 6 });

    // ---- 空调外机（挂在 -x 墙外）：白箱 + 圆形风口（7 道横格栅、中心小圆盖）+ 两根托架 + 一根爬上墙的管线
    const acX = -hx - 0.17, fanX = acX - 0.15;
    k.box(paint, 0.3, 0.52, 0.78, acX, 0.62, -0.25, { c: 0.02, tint: wall });
    stud(k, voidBlack(), 0.22, 0.016, [fanX - 0.008, 0.62, -0.14], { sides: 16, dir: '-x', raw: true });              // 风口：一个涂黑的浅圆台
    for (let i = -3; i <= 3; i++) k.box('steel_dark', 0.006, 0.008, Math.sqrt(0.22 ** 2 - (i * 0.06) ** 2) * 2, fanX - 0.02, 0.62 + i * 0.06, -0.14, { plain: true });
    stud(k, 'steel_dark', 0.05, 0.012, [fanX - 0.022, 0.62, -0.14], { sides: 8, dir: '-x' });
    for (const z of [-0.55, 0.05]) k.bar('steel_dark', [-hx, 0.32, z], [acX - 0.1, 0.34, z], 0.03, 0.03, { plain: true });
    k.hose('rubber', [[acX + 0.05, 0.86, 0.14], [acX + 0.06, 1, 0.2], [-hx - 0.02, 1.25, 0.24], [-hx - 0.02, 2.2, 0.24]], 0.014, { steps: 12, seg: 5, cast: false });

    // ---- 门头灯：深色灯壳，底面一片朝下的发光面
    k.box('steel_dark', 0.2, 0.07, 0.1, doorX, HEAD + 0.19, hz + 0.03, { c: 0.012 });
    k.plane(emissive(GUARD_BOOTH_LAMP_COLOR, on ? 5 : 0.02), 0.17, 0.05, [doorX, HEAD + 0.149, hz + 0.035], { rot: [HALF_PI, 0, 0], raw: true });

    // ---- 屋里：环氧地坪、靠 -x 墙的木桌、斜放的显示器、键盘、转椅
    inside.box('floor_epoxy', W - 0.1, 0.016, D - 0.1, 0, FLOOR + 0.008, 0, { plain: true, cast: false });
    const deskX = -hx + 0.4;
    inside.box('wood_dark', 0.6, 0.04, D - 0.3, deskX, 0.76, 0, { c: 0.008, grain: 'z' });
    for (const z of [-0.85, 0.85]) inside.box('steel_dark', 0.5, 0.64, 0.03, deskX, 0.44, z, { c: 0.005 });           // 两块板式桌腿
    // 显示器朝屋里斜 0.25 弧度。屏幕是一片发光的面片，贴在黑壳正面往外 3 毫米
    const SCREEN_YAW = 0.25, monX = -hx + 0.3, monZ = -0.3;
    inside.box('polymer_black', 0.05, 0.32, 0.5, monX, 1.02, monZ, { c: 0.01, rot: [0, SCREEN_YAW, 0] });
    inside.plane(emissive(0x8fb8e8, 1.6), 0.45, 0.27, [monX + Math.cos(SCREEN_YAW) * 0.028, 1.02, monZ - Math.sin(SCREEN_YAW) * 0.028], { rot: [0, HALF_PI + SCREEN_YAW, 0], raw: true });
    inside.box('polymer_black', 0.05, 0.1, 0.06, monX - 0.02, 0.83, monZ, { c: 0.008 });                              // 支架
    inside.box('polymer_black', 0.18, 0.015, 0.22, monX - 0.02, 0.787, monZ, { plain: true });                        // 底座
    inside.box('polymer_black', 0.14, 0.02, 0.42, -hx + 0.52, 0.79, -0.25, { c: 0.004 });                             // 键盘
    const chairX = -hx + 1, chairZ = -0.2;
    inside.box('polymer_black', 0.46, 0.07, 0.46, chairX, 0.5, chairZ, { c: 0.02, rot: [0, 0.3, 0] });                // 座
    inside.box('polymer_black', 0.07, 0.55, 0.42, chairX + 0.22, 0.86, chairZ + 0.07, { c: 0.02, rot: [0, 0.3, -0.12] }); // 靠背
    inside.cyl('steel_dark', 0.025, 0.36, chairX, 0.3, chairZ, { seg: 6 });                                           // 气杆
    for (let i = 0; i < 5; i++) {                                                                                     // 五星脚
      const a = i * TAU / 5;
      inside.bar('steel_dark', [chairX, 0.16, chairZ], [chairX + Math.cos(a) * 0.26, 0.14, chairZ + Math.sin(a) * 0.26], 0.03, 0.025, { plain: true });
    }

    // ---- 字和贴纸
    fitLabel(k, '门禁控制', { color: 'black', font: 'stencil', distress: 0.2 }, 0.9, 0.1, [-0.45, (TOP + HEAD) / 2, hz - 0.003]);
    sticker(k, 'berth4', 0.34, [hx - 0.003, 0.56, 0.3], [0, HALF_PI, 0]);
    sticker(k, 'no_entry', 0.2, [doorX, 0.72, zd + 0.0265]);
    sticker(k, 'grime_streak', 0.7, [-0.6, 0.55, hz - 0.003], undefined, 0.3);
    sticker(k, 'rust_run', 0.6, [-hx + 0.003, 0.6, 0.55], [0, -HALF_PI, 0], 0.25);

    const model = k.finish({ size: [W, 2.7, D], grime: 0.6, boxes: [{ min: [-hx, 0, -hz], max: [hx, 2.54, hz], surface: 'metal' }] });
    model.group.add(...inside.finish({ boxes: [], grime: 0.5 }).group.children);
    // 门头灯的位置和朝向：灯本身不照亮地面，想在门口补一盏真灯就按这个放
    model.group.userData.lamps = [{ pos: [doorX, HEAD + 0.14, hz + 0.04], dir: [0, -1, 0.2], color: GUARD_BOOTH_LAMP_COLOR }];
    return model;
  });
}

// ====================================================================== 道闸

export interface GateArmOpts extends SiteOpts { /** 栏杆抬起多少：0 放平，1 抬到头（1.48 弧度，约 85°）。按 0.05 一档取整。 */ open?: number }

/**
 * 道闸：橙色机箱在 -x 端（x = -2.31），4.62 米长的红白栏杆伸向 +x，另一头搭在黄色托柱上（x = 2.4）。
 * 机箱顶上一盏琥珀色警示灯，杆头一颗红灯。栏杆放下（open < 0.5）时带一条横着的碰撞盒。
 */
export function gateArm(o: GateArmOpts = {}): PropModel {
  const open = Math.round(clamp(o.open ?? 0, 0, 1) * 20) / 20;
  return cached(`gate_arm|${open}${tag(o)}`, () => {
    const k = new Kit('gate_arm', 0, { interior: o.interior });
    const BOX_X = -2.31, PIVOT_Y = 0.92, REST_X = 2.4;
    // 橙、红、黄三种漆都从同一个白漆材质染出来（见 toward）
    const WHITE = paintColor('paint_white'), orange = toward(paintColor('paint_orange'), WHITE), red = toward(paintColor('paint_red'), WHITE), yellow = toward(paintColor('paint_yellow'), WHITE);
    const scaled = (c: Rgb, s: number): Rgb => [c[0] * s, c[1] * s, c[2] * s];

    // ---- 机箱：水泥垫、橙色箱体（下暗上亮）、深色顶盖、正面的检修门板和锁、警示贴
    concreteBlock(k, 0.5, 0.06, 0.46, BOX_X, 0.03, 0, { spot: 1 });
    k.box('paint_white', 0.36, 1, 0.3, BOX_X, 0.56, 0, { c: 0.02, tint: (_x, y) => scaled(orange, 0.6 + 0.4 * sstep(0.05, 0.5, y)) });
    k.box('steel_dark', 0.4, 0.04, 0.34, BOX_X, 1.075, 0, { c: 0.012 });
    k.box('paint_white', 0.3, 0.6, 0.012, BOX_X, 0.5, 0.151, { c: 0.004, tint: scaled(orange, 0.9) });
    stud(k, 'steel_galv', 0.012, 0.016, [BOX_X + 0.1, 0.5, 0.16], { dir: 'z' });
    sticker(k, 'hazard_general', 0.14, [BOX_X, 0.9, 0.153]);
    sticker(k, 'caution_stripes', 0.08, [BOX_X, 0.12, 0.153], undefined, 0.34);
    k.cyl('steel_dark', 0.03, 0.05, BOX_X, 1.12, 0, { seg: 8 });
    k.cyl(emissive(0xff5a1e, 2.2), 0.026, 0.045, BOX_X, 1.165, 0, { seg: 8, raw: true });                            // 琥珀色警示灯

    // ---- 栏杆：整组绕机箱上的转轴抬起
    k.push([BOX_X, PIVOT_Y, 0], [0, 0, open * 1.48]);
    k.cyl('steel_dark', 0.075, 0.36, 0, 0, 0, { axis: 'z', seg: 10 });                                               // 轴筒
    for (const s of [-1, 1]) k.box('steel_dark', 0.62, 0.11, 0.012, 0.05, 0, s * 0.175, { c: 0.004 });               // 两片夹板
    k.box('steel_dark', 0.3, 0.16, 0.3, -0.33, -0.02, 0, { c: 0.02 });                                               // 配重块：有它，电机只需要很小的力就能把杆子抬起来
    const LENGTH = 4.62, START = 0.12, SEGMENTS = 9, step = LENGTH / SEGMENTS;
    for (let i = 0; i < SEGMENTS; i++) {
      const h = 0.1 - i * 0.003; // 每节比前一节矮 3 毫米，杆子越往头越细
      k.box('paint_white', step + 0.001, h, 0.05, START + step * (i + 0.5), 0, 0, { c: 0.008, tint: i % 2 ? 1 : red, shift: false });
    }
    k.box('steel_dark', 0.03, 0.11, 0.06, START + LENGTH + 0.012, 0, 0, { c: 0.008 });                               // 杆头的堵头
    k.box(emissive(0xff2a12, 1.5), 0.05, 0.03, 0.054, START + LENGTH - 0.5, 0.053, 0, { plain: true, raw: true });   // 杆头的红灯
    k.pop();

    // ---- 托柱：水泥垫、黄色圆柱、顶上的 U 形托
    concreteBlock(k, 0.3, 0.05, 0.3, REST_X, 0.025, 0, { c: 0.012, spot: 2 });
    stud(k, 'steel_galv', 0.07, 0.01, [REST_X, 0.055, 0], { sides: 8 });
    k.cyl('paint_white', 0.04, 0.8, REST_X, 0.45, 0, { seg: 8, tint: yellow });
    k.box('paint_white', 0.14, 0.02, 0.16, REST_X, 0.855, 0, { c: 0.005, tint: yellow });
    for (const s of [-1, 1]) k.box('paint_white', 0.14, 0.14, 0.014, REST_X, 0.93, s * 0.073, { c: 0.004, tint: yellow });

    const boxes: LocalBox[] = [
      { min: [BOX_X - 0.2, 0, -0.17], max: [BOX_X + 0.2, 1.1, 0.17], surface: 'metal' },
      { min: [REST_X - 0.07, 0, -0.08], max: [REST_X + 0.07, 1, 0.08], surface: 'metal', noNav: true },
    ];
    if (open < 0.5) boxes.push({ min: [BOX_X, PIVOT_Y - 0.07, -0.04], max: [REST_X, PIVOT_Y + 0.07, 0.04], surface: 'metal' });
    return k.finish({ size: [5, 1.2, 0.46], boxes });
  });
}

// ====================================================================== 冷藏箱机组

export interface ReeferUnitOpts extends SiteOpts { /** 默认机组的正面朝 -x（挂在冷藏箱 -x 那一头）；flip 为真时朝 +x。 */ flip?: boolean }

/**
 * 冷藏箱机组，0.5 × 2.3 × 2.3 米：挂在冷藏集装箱端头的那一整面"空调"。
 * 上面两只冷凝风扇，中间两组百叶，下面是敞开的压缩机舱和一只灰色电控箱 —— 箱上有一块亮着的琥珀色小屏幕和一颗绿灯。
 * 3 个个体。压缩机和管线比外框再凸出去十来厘米，碰撞盒只算到外框。
 */
export function reeferUnit(o: ReeferUnitOpts = {}): PropModel {
  const flip = !!o.flip, v = variantOf(o.seed, 3);
  return cached(`reefer_unit|${flip}|${v}${tag(o)}`, () => {
    const k = new Kit('reefer_unit', v, { interior: o.interior }), wob = v * 2.3;
    const shell: Tint = (_x, y, z) => { const s = (0.86 + 0.18 * vnoise(z * 2 + wob, y * 2)) * (0.62 + 0.38 * sstep(0, 0.6, y)); return [s, s * 0.985, s * 0.955]; };
    // 风扇筒里面、百叶后面、压缩机舱的背景，都是一片"黑洞"面片（见 voidBlack）
    const hole = { rot: [0, HALF_PI, 0] as V3, raw: true };
    /** 机壳正面所在的 x。下面所有零件都从这个面往外量。 */
    const FACE = 0.13;
    // 电控箱的灰、阀帽和把手的红、插头的蓝，都从同一个白漆材质染出来（见 toward），不为几个小零件各开一种材质
    const WHITE = paintColor('paint_white');
    const grey = toward(paintColor('paint_grey'), WHITE), red = toward(paintColor('paint_red'), WHITE), blue = toward(paintColor('paint_blue'), WHITE);
    // 所有零件按"正面朝 +x"来搭；默认情况下再整体转 180°，让正面朝 -x
    if (!flip) k.push([0, 0, 0], [0, Math.PI, 0]);

    // ---- 机壳、一圈外框、两道横档、框上的螺栓
    k.box('paint_white', 0.38, 2.3, 2.3, -0.06, 1.15, 0, { c: 0.012, tint: shell });
    for (const s of [-1, 1]) k.box('paint_white', 0.12, 2.3, 0.09, 0.19, 1.15, s * 1.105, { c: 0.012, tint: shell });
    k.box('paint_white', 0.12, 0.09, 2.12, 0.19, 2.255, 0, { c: 0.012, tint: shell });
    k.box('paint_white', 0.12, 0.1, 2.12, 0.19, 0.05, 0, { c: 0.012, tint: shell });
    for (const y of [1.42, 0.9]) k.box('paint_white', 0.1, 0.06, 2.12, 0.18, y, 0, { c: 0.01, tint: shell });
    for (const y of [0.3, 0.9, 1.5, 2.1]) for (const s of [-1, 1]) stud(k, 'steel_galv', 0.014, 0.012, [0.255, y, s * 1.105], { dir: 'x' });
    for (const z of [-0.8, -0.3, 0.3, 0.8]) for (const y of [0.05, 2.255]) stud(k, 'steel_galv', 0.014, 0.012, [0.255, y, z], { dir: 'x' });

    // ---- 上部：两只冷凝风扇
    for (const s of [-1, 1]) {
      const z = s * 0.53, y = 1.83;
      k.add(voidBlack(), new THREE.CircleGeometry(0.33, 18), { raw: true }, matrixOf([FACE + 0.008, y, z], [0, HALF_PI, 0])); // 风筒里面：一片涂黑的圆
      // 风筒：一圈安装法兰 + 往外收的筒壁 + 筒口的唇边 + 内壁。车削轮廓里连写两个相同的点 = 硬棱
      k.lathe('paint_white', [[0.36, 0], [0.36, 0.014], [0.36, 0.014], [0.345, 0.014], [0.345, 0.014], [0.335, 0.1], [0.335, 0.1], [0.32, 0.1], [0.32, 0.1], [0.32, 0]], FACE, y, z, { axis: 'x', seg: 18, tint: shell });
      for (let i = 0; i < 3; i++) k.box('steel_dark', 0.012, 0.6, 0.12, FACE + 0.04, y, z, { plain: true, rot: [(i * Math.PI) / 3 + s * 0.4, 0.5, 0] }); // 3 根通长的扇叶 = 6 片
      k.cyl('steel_dark', 0.07, 0.06, FACE + 0.05, y, z, { axis: 'x', seg: 10 });                                                             // 轮毂
      for (let i = 0; i < 4; i++) k.box('steel_galv', 0.005, 0.66, 0.005, FACE + 0.098, y, z, { plain: true, rot: [(i * Math.PI) / 4, 0, 0] }); // 护网：辐条
      for (const r of [0.12, 0.22, 0.32]) k.torus('steel_galv', r, 0.003, FACE + 0.1, y, z, { axis: 'x', seg: 16, tubeSeg: 3 }); // 护网：3 圈同心圆
    }
    fitLabel(k, '激战船用制冷', { color: 'black', font: 'sans', distress: 0.2 }, 1.2, 0.05, [0.251, 2.255, 0], [0, HALF_PI, 0]);

    // ---- 中部：两组百叶，各 9 片斜叶 + 中间一根竖档
    for (const s of [-1, 1]) {
      k.plane(voidBlack(), 0.98, 0.44, [FACE + 0.008, 1.16, s * 0.53], hole);
      for (let i = 0; i < 9; i++) k.box('paint_white', 0.06, 0.006, 0.98, FACE + 0.035, 0.965 + i * 0.049, s * 0.53, { plain: true, rot: [0, 0, -0.75], tint: shell });
      k.box('paint_white', 0.05, 0.46, 0.03, FACE + 0.03, 1.16, s * 0.53, { c: 0.005, tint: shell });
    }

    // ---- 下部左边：敞开的压缩机舱。黑色卧式压缩机、铝储液罐、三根黄铜管、一只红色阀帽
    k.plane(voidBlack(), 1, 0.76, [FACE + 0.008, 0.49, -0.53], hole);
    k.cyl('steel_dark', 0.15, 0.46, FACE + 0.1, 0.36, -0.58, { axis: 'z', seg: 14, open: true });
    for (const s of [-1, 1]) k.sph('steel_dark', 0.15, FACE + 0.1, 0.36, -0.58 + s * 0.23, { scale: [1, 1, 0.45], seg: 10 });
    k.box('steel_dark', 0.26, 0.03, 0.5, FACE + 0.1, 0.19, -0.58, { c: 0.006 });
    k.cyl('aluminium', 0.07, 0.4, FACE + 0.07, 0.5, -0.17, { seg: 10 });
    const pipe = { seg: 5, cast: false };
    k.hose('brass', [[FACE + 0.1, 0.5, -0.5], [FACE + 0.1, 0.68, -0.5], [FACE + 0.08, 0.78, -0.4], [FACE + 0.08, 0.8, -0.2], [FACE + 0.07, 0.72, -0.17]], 0.012, { steps: 12, ...pipe });
    k.hose('brass', [[FACE + 0.12, 0.42, -0.36], [FACE + 0.14, 0.6, -0.33], [FACE + 0.1, 0.84, -0.34], [FACE + 0.06, 0.88, -0.6], [FACE + 0.03, 0.88, -0.9]], 0.009, { steps: 12, ...pipe });
    k.hose('brass', [[FACE + 0.1, 0.36, -0.82], [FACE + 0.1, 0.36, -0.93], [FACE + 0.06, 0.6, -0.96], [FACE + 0.04, 0.86, -0.96]], 0.012, { steps: 10, ...pipe });
    k.box('paint_white', 0.04, 0.05, 0.05, FACE + 0.12, 0.6, -0.33, { c: 0.008, tint: red });

    // ---- 下部右边：灰色电控箱。屏幕和指示灯都是发光面片
    const BOX_Z = 0.55, door = FACE + 0.12; // door = 电控箱门板正面所在的 x
    k.box('paint_white', 0.11, 0.56, 0.74, FACE + 0.055, 0.5, BOX_Z, { c: 0.012, tint: grey });
    k.box('paint_white', 0.012, 0.5, 0.68, FACE + 0.114, 0.5, BOX_Z, { c: 0.004, tint: [grey[0] * 1.1, grey[1] * 1.1, grey[2] * 1.1] });
    k.box('steel_dark', 0.006, 0.11, 0.26, door + 0.003, 0.66, BOX_Z - 0.1, { plain: true });                                   // 屏幕四周的黑色面板
    k.plane(emissive(0xffb45a, 2.4), 0.15, 0.05, [door + 0.011, 0.665, BOX_Z - 0.06], { rot: [0, HALF_PI, 0], raw: true });                  // 琥珀色显示屏
    k.plane(emissive(0x58ff7a, 3), 0.014, 0.014, [door + 0.011, 0.66, BOX_Z - 0.2], { rot: [0, HALF_PI, 0], raw: true });                    // 绿色运行灯
    for (let col = 0; col < 4; col++) for (let row = 0; row < 2; row++) k.box('steel_dark', 0.008, 0.03, 0.03, door + 0.002, 0.5 - row * 0.045, BOX_Z - 0.04 - col * 0.045, { plain: true }); // 8 个按键
    k.box('paint_white', 0.03, 0.09, 0.03, door + 0.01, 0.42, BOX_Z + 0.22, { c: 0.006, tint: red });                                                     // 红色把手
    k.cyl('steel_galv', 0.012, 0.1, door + 0.004, 0.5, BOX_Z + 0.325, { seg: 6 });                                                           // 合页销
    sticker(k, 'hazard_voltage', 0.11, [door + 0.0015, 0.64, BOX_Z + 0.2], [0, HALF_PI, 0]);
    // 电缆：两根从电控箱顶上爬出去，一根粗的电源线从箱底垂下来、盘一圈、接一只蓝色插头
    k.hose('rubber', [[FACE + 0.06, 0.78, BOX_Z + 0.2], [FACE + 0.06, 0.95, BOX_Z + 0.25], [FACE + 0.05, 1.4, BOX_Z + 0.5], [FACE + 0.05, 1.5, BOX_Z]], 0.012, { steps: 12, ...pipe });
    k.hose('rubber', [[FACE + 0.06, 0.78, BOX_Z - 0.2], [FACE + 0.06, 0.92, BOX_Z - 0.3], [FACE + 0.05, 0.93, -0.1]], 0.01, { steps: 8, ...pipe });
    k.cyl('steel_galv', 0.022, 0.04, FACE + 0.06, 0.2, BOX_Z + 0.2, { seg: 8 });
    k.hose('rubber', [[FACE + 0.06, 0.2, BOX_Z + 0.2], [FACE + 0.08, 0.12, BOX_Z + 0.1], [FACE + 0.1, 0.16, BOX_Z - 0.15], [FACE + 0.1, 0.2, BOX_Z - 0.3], [FACE + 0.1, 0.13, BOX_Z - 0.36], [FACE + 0.09, 0.12, BOX_Z - 0.1], [FACE + 0.09, 0.14, BOX_Z + 0.05]], 0.016, { steps: 20, seg: 6, cast: false });
    k.box('paint_white', 0.07, 0.07, 0.12, FACE + 0.09, 0.14, BOX_Z + 0.1, { c: 0.015, tint: blue });
    sticker(k, 'grime_streak', 0.8, [0.2512, 0.5, -1.105], [0, HALF_PI, 0], 0.08);

    if (!flip) k.pop();
    return k.finish({ size: [0.5, 2.3, 2.3], grime: 0.6, boxes: [{ min: [-0.25, 0, -1.15], max: [0.25, 2.3, 1.15], surface: 'metal' }] });
  });
}

// ====================================================================== 中继柜

/** 中继柜指示灯的三种状态色：正常（琥珀）、切断中闪亮的那半拍、已切断（红）。 */
export const RELAY_COLORS = { live: 0xffa028, cutting: 0xffd9a0, cut: 0xff2814 } as const;
/**
 * 中继柜里会动、会变色的零件叫什么名字。拿到柜子的 group 以后，用 group.getObjectByName(名字) 取。
 * （同样的内容也写在 group.userData 里；用 relayParts() 可以一次取齐。）
 */
export const RELAY_PART_NAMES = {
  /** 三组指示灯，各是一个独立的小网格、各有自己的材质：灯条、左仓里的 20 颗设备灯、顶上的信标灯。 */
  lamps: ['relay_lamp_strips', 'relay_lamp_rack', 'relay_lamp_beacon'],
  /** 左门（会弹开的那扇）。原点在门轴上，开门是 rotation.y = -角度。 */
  door: 'relay_door',
  /** 抛物面天线。原点在桅杆顶的转轴上，绕 y 轴转。 */
  dish: 'relay_dish',
} as const;

export interface RelayCabinetOpts extends SiteOpts { /** 门上喷的编号（"中继 X"里的 X）。不给就按 seed 取 甲 / 乙 / 丙。 */ id?: string }

/** 指示灯的材质：和 emissive() 一样是"不受光照、颜色直接超过 1"的发光体，但每只柜子、每组灯各有一份，好单独变色。 */
function relayLampMaterial() {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(RELAY_COLORS.live).multiplyScalar(4),
    // 灯条紧贴在深色底条上（只高出半毫米）。polygonOffset 让显卡在比较远近时把它往前挪一点点，贴得再近也不会和底下的面打架
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.name = 'relay_lamp';
  return m;
}

/**
 * 中继柜（任务目标），正面朝 +z。占地 1.36 × 0.96 米，柜顶 1.67 米，桅杆顶 2.5 米，鞭状天线到 3.15 米。
 *
 * 和别的道具不同，它每次调用都新建一个（不走缓存），并且不是"一坨合并好的静态网格"：
 * 左门、抛物面天线各是一个独立的小组（Group），三组指示灯各是一个独立的网格、各带自己的材质。
 * 这样游戏逻辑可以按状态让灯变色、让天线转、让门弹开 —— 状态机本身不在这里，这里只把"把手"留好：
 *   group.userData = { lamps: 三组灯的名字, door: 左门的名字, dish: 天线的名字,
 *                      beacon: 信标灯的位置（挂点光用）, interact: 交互点（柜前 0.75 米、1 米高） }
 * 因为带子组，它不能交给 PropField 做实例化，要用 placeOnce 摆。
 */
export function relayCabinet(o: RelayCabinetOpts = {}): PropModel {
  const seed = Math.abs((o.seed ?? 0) | 0), wob = seed * 1.9, id = o.id || '甲乙丙'[seed % 3];
  const kitOpt = { interior: o.interior };
  const k = new Kit('relay_cabinet', seed, kitOpt);        // 不动的部分
  const door = new Kit(RELAY_PART_NAMES.door, seed, kitOpt); // 左门：在"门自己的坐标"里搭，门轴是 x=0 那条竖线
  const dish = new Kit(RELAY_PART_NAMES.dish, seed, kitOpt); // 抛物面天线
  const strips = new Kit('relay_lamp_strips'), rack = new Kit('relay_lamp_rack'), beacon = new Kit('relay_lamp_beacon');
  const stripGlow = relayLampMaterial(), rackGlow = relayLampMaterial(), beaconGlow = relayLampMaterial();

  /** 柜体的范围：x ±0.5，y 从 BOTTOM 到 TOP，z 从 BACK 到 FRONT；SKIN 是钢板的厚度。 */
  const BOTTOM = 0.18, TOP = 1.62, BACK = -0.3, FRONT = 0.3, SKIN = 0.025, MID = (BOTTOM + TOP) / 2, HEIGHT = TOP - BOTTOM;
  const cabinet: Tint = (x, y, z) => { const s = (0.88 + 0.2 * vnoise(x * 3 + wob, y * 3 + z * 2)) * (0.6 + 0.4 * sstep(0.16, 0.7, y)); return [s, s, s * 0.98]; };
  const doorPaint: Tint = (x, y) => { const s = 0.9 + 0.14 * vnoise(x * 4 + wob, y * 3); return [s, s, s]; };
  const DARK: Rgb = [0.035, 0.035, 0.04], skin = { c: 0.006, tint: cabinet };

  // ---- 水泥基座：正面一条黄黑斜纹，四角地脚螺栓 + 垫片
  concreteBlock(k, 1.36, 0.16, 0.96, 0, 0.08, 0, { c: 0.025, spot: seed, tint: (x, y, z) => { const s = 0.6 + 0.38 * sstep(0, 0.15, y) + 0.1 * vnoise(x * 5, z * 5); return [s, s, s * 0.97]; } });
  sticker(k, 'caution_stripes', 0.1, [0, 0.085, 0.4815], undefined, 1.2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.box('steel_galv', 0.1, 0.012, 0.1, sx * 0.44, 0.166, sz * 0.36, { plain: true });
    stud(k, 'steel_galv', 0.016, 0.03, [sx * 0.44, 0.185, sz * 0.36]);
  }

  // ---- 柜体：背板、两侧板、顶底板、中间一片竖隔板（分成左右两仓）、正面上沿的眉板和下沿的踢脚
  k.box('paint_grey', 1, HEIGHT, SKIN, 0, MID, BACK + SKIN / 2, skin);
  for (const s of [-1, 1]) k.box('paint_grey', SKIN, HEIGHT, 0.6, s * (0.5 - SKIN / 2), MID, 0, skin);
  k.box('paint_grey', 1, SKIN, 0.6, 0, BOTTOM + SKIN / 2, 0, skin);
  k.box('paint_grey', 1, SKIN, 0.6, 0, TOP - SKIN / 2, 0, skin);
  k.box('paint_grey', SKIN, HEIGHT, 0.58, 0, MID, 0, { c: 0.004, tint: cabinet });
  k.box('paint_grey', 1, 0.12, SKIN, 0, TOP - 0.06, FRONT - SKIN / 2, skin);
  k.box('paint_grey', 1, 0.07, SKIN, 0, BOTTOM + 0.035, FRONT - SKIN / 2, skin);
  k.box('steel_dark', 1.04, 0.04, 0.64, 0, BOTTOM - 0.01, 0, { c: 0.008 });                      // 底下一圈深色底座
  k.box('paint_grey', 1.12, 0.05, 0.74, 0, TOP + 0.025, 0.01, { c: 0.012, tint: cabinet });      // 外挑的顶盖（挡雨）
  for (const s of [-1, 1]) k.hose('steel_galv', [[s * 0.4 - 0.04, TOP + 0.05, 0.2], [s * 0.4 - 0.03, TOP + 0.1, 0.2], [s * 0.4 + 0.03, TOP + 0.1, 0.2], [s * 0.4 + 0.04, TOP + 0.05, 0.2]], 0.008, { steps: 6, seg: 4 }); // 两只吊环

  // ---- 左仓（门弹开以后看得见）：内壁刷黑，5 层机架设备，层与层之间绕着跳线
  const liner = { tint: [0.16, 0.16, 0.17] as Rgb };
  k.plane('paint_grey', 0.45, HEIGHT - 0.06, [-0.25, MID, BACK + SKIN + 0.006], liner);
  k.plane('paint_grey', 0.55, HEIGHT - 0.06, [-0.5 + SKIN + 0.006, MID, 0], { rot: [0, HALF_PI, 0], ...liner });
  k.plane('paint_grey', 0.55, HEIGHT - 0.06, [-SKIN / 2 - 0.006, MID, 0], { rot: [0, -HALF_PI, 0], ...liner });
  for (let unit = 0; unit < 5; unit++) {
    const y = 0.42 + unit * 0.22;
    k.box('steel_dark', 0.42, 0.17, 0.4, -0.25, y, -0.05, { c: 0.008 });
    k.box('aluminium', 0.4, 0.02, 0.012, -0.25, y + 0.06, 0.152, { plain: true });                                   // 拉手
    for (let i = 0; i < 4; i++) rack.plane(rackGlow, 0.012, 0.012, [-0.41 + i * 0.035, y - 0.04, 0.1512], { raw: true });         // 4 颗指示灯
    for (let i = 0; i < 3; i++) k.box('steel_dark', 0.03, 0.022, 0.006, -0.2 + i * 0.06, y - 0.03, 0.151, { plain: true, tint: 0.2 }); // 3 个网口
  }
  for (let i = 0; i < 4; i++) {
    const y = i * 0.22;
    k.hose('rubber', [[-0.2 + (i % 3) * 0.06, 0.39 + y, 0.15], [-0.14 + (i % 3) * 0.05, 0.36 + y, 0.24], [-0.07, 0.55 + y, 0.22], [-0.2 + ((i + 1) % 3) * 0.06, 0.61 + y, 0.15]], 0.007, { steps: 9, seg: 4 });
  }

  // ---- 两扇门。长得一样，只是把手和合页左右对调，所以写成一个函数搭两次
  const DOOR_W = 0.474, DOOR_H = 1.3, DOOR_Y = 0.9;
  /** 在 kit 里搭一扇门：门板从 x0 到 x0 + DOOR_W，外表面朝 +z；hingeRight 为真时合页在右边、把手在左边。 */
  const addDoor = (kit: Kit, x0: number, hingeRight: boolean, tint: Tint) => {
    const cx = x0 + DOOR_W / 2;
    kit.box('paint_grey', DOOR_W, DOOR_H, 0.024, cx, DOOR_Y, 0, { c: 0.006, tint });
    kit.box('paint_grey', DOOR_W - 0.07, DOOR_H - 0.07, 0.006, cx, DOOR_Y, 0.013, { c: 0.003, tint });            // 门板上压出来的一圈凸台
    for (const y of [DOOR_Y + 0.36, DOOR_Y - 0.4]) {                                                              // 上下两组百叶
      kit.box('paint_grey', DOOR_W - 0.14, 0.3, 0.006, cx, y, 0.019, { plain: true, tint: DARK });   // 深色衬底
      for (let i = 0; i < 7; i++) kit.box('paint_grey', DOOR_W - 0.13, 0.034, 0.005, cx, y - 0.125 + i * 0.042, 0.029, { plain: true, rot: [0.75, 0, 0], tint });
      for (const s of [-1, 1]) kit.box('paint_grey', 0.02, 0.31, 0.02, cx + (s * (DOOR_W - 0.13)) / 2, y, 0.024, { c: 0.003, tint });
    }
    const handleX = hingeRight ? x0 + 0.07 : x0 + DOOR_W - 0.07;
    kit.box('steel_dark', 0.045, 0.2, 0.02, handleX, DOOR_Y - 0.02, 0.026, { c: 0.006 });
    kit.box('steel_galv', 0.028, 0.13, 0.018, handleX, DOOR_Y, 0.042, { c: 0.006 });
    stud(kit, 'steel_galv', 0.012, 0.012, [handleX, DOOR_Y - 0.09, 0.04], { sides: 8, dir: 'z' });                // 锁芯
    const hingeX = hingeRight ? x0 + DOOR_W : x0;
    for (const y of [DOOR_Y - 0.5, DOOR_Y, DOOR_Y + 0.5]) kit.cyl('steel_galv', 0.011, 0.09, hingeX, y, 0.016, { seg: 6 });
  };
  // 右门：固定不动，直接搭进柜体。上面喷编号和一行小字，贴高压警示
  k.push([0, 0, FRONT - 0.004]);
  addDoor(k, 0.013, true, cabinet);
  const rightX = 0.013 + DOOR_W / 2;
  fitLabel(k, `中继 ${id}`, { color: 'yellow', font: 'stencil', distress: 0.15 }, DOOR_W - 0.1, 0.12, [rightX, DOOR_Y + 0.02, 0.018]);
  fitLabel(k, '港区主控上行链路', { color: 'white', font: 'sans', distress: 0.15 }, DOOR_W - 0.1, 0.034, [rightX, DOOR_Y - 0.1, 0.018]);
  sticker(k, 'hazard_voltage', 0.13, [rightX + 0.1, DOOR_Y + 0.14, 0.018]);
  k.pop();
  // 左门：活动件。外面贴"注意安全"和"检修前请断电"；里面有加强筋和一只图纸袋（门开了才看得见）
  addDoor(door, 0, false, doorPaint);
  sticker(door, 'hazard_general', 0.13, [DOOR_W / 2, DOOR_Y + 0.1, 0.018]);
  fitLabel(door, '检修前请断电', { color: 'white', font: 'sans', distress: 0.15 }, DOOR_W - 0.1, 0.03, [DOOR_W / 2, DOOR_Y - 0.03, 0.018]);
  for (const y of [DOOR_Y + 0.55, DOOR_Y - 0.55]) door.box('paint_grey', DOOR_W - 0.1, 0.03, 0.014, DOOR_W / 2, y, -0.018, { c: 0.003, tint: doorPaint });
  for (const x of [0.07, DOOR_W - 0.07]) door.box('paint_grey', 0.03, 1.1, 0.014, x, DOOR_Y, -0.018, { c: 0.003, tint: doorPaint });
  door.box('steel_dark', 0.24, 0.3, 0.02, DOOR_W / 2, DOOR_Y - 0.05, -0.02, { c: 0.004 });
  door.label('接线图 SLT-R4', { color: 'white', font: 'sans', distress: 0.1 }, 0.2, 0.03, [DOOR_W / 2, DOOR_Y + 0.03, -0.0305], [0, Math.PI, 0]);
  for (const y of [DOOR_Y + 0.36, DOOR_Y - 0.4]) door.box('paint_grey', DOOR_W - 0.14, 0.3, 0.004, DOOR_W / 2, y, -0.014, { plain: true, tint: DARK }); // 百叶从里面看也是黑的

  // ---- 两侧的散热器：一块铝背板 + 13 片竖鳍片，顶上一条遮雨檐
  for (const s of [-1, 1]) {
    k.box('aluminium', 0.012, 0.98, 0.5, s * 0.506, 1.06, 0, { plain: true });
    for (let i = -6; i <= 6; i++) k.box('aluminium', 0.06, 0.94, 0.007, s * 0.54, 1.06, i * 0.038, { plain: true, tint: k.range(0.8, 1) });
    k.box('paint_grey', 0.075, 0.03, 0.52, s * 0.54, 1.56, 0, { c: 0.006, tint: cabinet });
  }

  // ---- 右侧三根粗电缆：从侧板上的格兰头出来，下弯，钻进地面（落点各有一个法兰）
  for (let i = 0; i < 3; i++) {
    const z = -0.17 + i * 0.17, y = 0.44 - i * 0.02, groundX = 0.86 + i * 0.07;
    k.hose('rubber', [[0.5, y, z], [0.6, y, z], [0.72 + i * 0.04, y - 0.06, z], [groundX - 0.02, 0.16, z + 0.02], [groundX, -0.03, z + 0.02]], 0.04, { steps: 12, seg: 7 });
    stud(k, 'steel_galv', 0.055, 0.05, [0.515, y, z], { sides: 8, hex: true, dir: 'x' });
    stud(k, 'steel_galv', 0.063, 0.03, [groundX, 0.015, z + 0.02], { sides: 8 });
  }
  // ---- 背后：一根贴地甩出去的电缆、一只小接线盒、一根爬上柜顶的细线
  k.hose('rubber', [[-0.3, 0.35, BACK], [-0.3, 0.33, BACK - 0.1], [-0.34, 0.2, BACK - 0.2], [-0.5, 0.165, BACK - 0.3], [-0.9, 0.02, BACK - 0.36], [-1.5, 0.018, BACK - 0.2]], 0.022, { steps: 18, seg: 5 });
  k.box('steel_dark', 0.3, 0.22, 0.1, 0.2, 0.75, BACK - 0.05, { c: 0.012 });
  k.hose('rubber', [[0.2, 0.86, BACK - 0.06], [0.2, 1.2, BACK - 0.04], [-0.1, 1.55, BACK - 0.03], [-0.3, 1.66, -0.16]], 0.012, { steps: 10, seg: 4 });

  // ---- 格构桅杆（柜顶左后角）：三根主肢围成一个三角，中间 5 层"斜缀条 + 横缀条"把它们拉在一起
  const MAST_X = -0.3, MAST_Z = -0.14, MAST_BASE = TOP + 0.05, MAST_TOP = 2.5;
  const legs = [0, 1, 2].map((i) => [MAST_X + Math.cos(i * 2.094 + 0.52) * 0.085, MAST_Z + Math.sin(i * 2.094 + 0.52) * 0.085]);
  k.box('steel_galv', 0.24, 0.012, 0.24, MAST_X, MAST_BASE + 0.006, MAST_Z, { plain: true });
  const TIERS = 5, tier = (MAST_TOP - MAST_BASE) / TIERS;
  for (let i = 0; i < 3; i++) {
    const a = legs[i], b = legs[(i + 1) % 3];
    k.tube('steel_galv', [a[0], MAST_BASE, a[1]], [a[0], MAST_TOP, a[1]], 0.011, { seg: 5 });
    for (let t = 0; t < TIERS; t++) {
      k.tube('steel_galv', [a[0], MAST_BASE + t * tier, a[1]], [b[0], MAST_BASE + (t + 1) * tier, b[1]], 0.005, { seg: 3 });
      k.tube('steel_galv', [a[0], MAST_BASE + (t + 1) * tier, a[1]], [b[0], MAST_BASE + (t + 1) * tier, b[1]], 0.005, { seg: 3 });
    }
  }
  k.cyl('steel_galv', 0.11, 0.014, MAST_X, MAST_TOP + 0.007, MAST_Z, { seg: 10 });               // 顶板
  k.cyl('steel_dark', 0.06, 0.1, MAST_X, MAST_TOP + 0.06, MAST_Z, { r2: 0.05, seg: 10 });        // 转台
  // ---- 两根鞭状天线（柜顶右后）：底座 + 弹簧节 + 一根由粗到细的鞭
  const addWhip = (x: number, z: number, tipY: number) => {
    k.cyl('steel_dark', 0.02, 0.07, x, TOP + 0.085, z, { r2: 0.016, seg: 8 });
    k.cyl('steel_galv', 0.011, 0.06, x, TOP + 0.15, z, { seg: 6 });
    k.tube('steel_dark', [x, TOP + 0.17, z], [x + 0.02, tipY, z - 0.015], 0.005, { r2: 0.0018, seg: 5, cap: true });
  };
  addWhip(0.4, -0.24, 3.15);
  addWhip(0.26, -0.24, 2.72);
  // ---- 蘑菇头天线（柜顶右前）
  k.cyl('steel_dark', 0.03, 0.26, 0.42, TOP + 0.18, 0.18, { seg: 8 });
  k.add('steel_dark', new THREE.SphereGeometry(0.03, 8, 4, 0, TAU, 0, HALF_PI), {}, matrixOf([0.42, TOP + 0.31, 0.18]));

  // ---- 抛物面天线（活动件）。先搭在它最终的位置上，最后再把原点挪到转轴上（见 rehome）
  const DISH: V3 = [MAST_X, MAST_TOP + 0.11, MAST_Z];
  dish.push(DISH);
  // 浅碟：车削轮廓先沿"碗的内面"从中心走到边缘，再沿"碗的背面"走回中心。车出来碗口朝上，再转到朝前、略微上仰
  dish.lathe('aluminium', [[0, 0], [0.06, 0.006], [0.12, 0.024], [0.18, 0.054], [0.215, 0.078], [0.222, 0.078], [0.185, 0.05], [0.12, 0.016], [0.06, -0.003], [0, -0.01]], 0, 0.3, 0.02, { seg: 18, rot: [HALF_PI - 0.12, 0, 0] });
  dish.cyl('aluminium', 0.03, 0.2, 0, 0.1, 0, { r2: 0.022, seg: 8 });                            // 支座
  dish.box('aluminium', 0.07, 0.1, 0.06, 0, 0.26, -0.02, { c: 0.01 });
  for (const a of [0.5, 2.6, 4.7]) dish.tube('aluminium', [Math.cos(a) * 0.2, 0.3 + Math.sin(a) * 0.2, 0.09], [0, 0.325, 0.25], 0.0045, { seg: 4 }); // 三根馈源支杆
  dish.cyl('aluminium', 0.016, 0.05, 0, 0.325, 0.25, { axis: 'z', r2: 0.022, seg: 8 });          // 馈源头
  dish.pop();

  // ---- 状态灯条：每条灯都是"一根深色底条 + 贴在上面的一片发光面"
  k.box('steel_dark', 0.9, 0.07, 0.03, 0, TOP - 0.06, FRONT + 0.012, { c: 0.008 });              // 正面眉板上的一条
  strips.plane(stripGlow, 0.84, 0.036, [0, TOP - 0.06, FRONT + 0.0275], { raw: true });
  for (let i = 1; i < 6; i++) k.box('steel_dark', 0.008, 0.05, 0.006, -0.42 + i * 0.14, TOP - 0.06, FRONT + 0.028, { plain: true }); // 5 道分隔，把它切成 6 格
  k.box('steel_dark', 0.6, 0.06, 0.03, 0, TOP - 0.06, BACK - 0.012, { c: 0.008 });               // 背面的一条
  strips.plane(stripGlow, 0.54, 0.03, [0, TOP - 0.06, BACK - 0.0275], { rot: [0, Math.PI, 0], raw: true });
  for (const s of [-1, 1]) {
    // 正面两条竖边：一根转了 45° 的方条卡在柜角上，灯贴在它朝外的那个斜面上（斜面离方条中心 1.5 厘米）
    k.box('steel_dark', 0.03, 1.2, 0.03, s * 0.5, 0.86, FRONT, { c: 0.008, rot: [0, Math.PI / 4, 0] });
    const out = (0.015 + 0.0015) * Math.SQRT1_2;
    strips.plane(stripGlow, 0.014, 1.14, [s * (0.5 + out), 0.86, FRONT + out], { rot: [0, (s * Math.PI) / 4, 0], raw: true });
    // 两侧各一条竖的（贴在侧板上，散热器和柜角之间）和柜顶边上一条横的
    strips.plane(stripGlow, 0.014, 0.9, [s * 0.5015, 1.06, 0.266], { rot: [0, s * HALF_PI, 0], raw: true });
    k.box('steel_dark', 0.03, 0.06, 0.46, s * 0.587, TOP - 0.01, 0, { c: 0.008 });
    strips.plane(stripGlow, 0.4, 0.032, [s * 0.6025, TOP - 0.01, 0], { rot: [0, s * HALF_PI, 0], raw: true });
  }
  // ---- 信标灯：桅杆旁一根细杆，顶上一只发光圆柱，上下各一片深色盖板
  const BEACON: V3 = [-0.1, 2.68, MAST_Z]; // 桅杆往 +x 20 厘米
  k.cyl('steel_dark', 0.028, 0.02, BEACON[0], TOP + 0.06, BEACON[2], { seg: 8 });
  k.tube('steel_galv', [BEACON[0], TOP + 0.06, BEACON[2]], [BEACON[0], 2.64, BEACON[2]], 0.009, { seg: 5 });
  beacon.cyl(beaconGlow, 0.045, 0.1, BEACON[0], 2.69, BEACON[2], { seg: 10, raw: true });
  for (const y of [2.747, 2.633]) k.cyl('steel_dark', 0.05, 0.014, BEACON[0], y, BEACON[2], { seg: 10 });

  // ---- 污迹
  sticker(k, 'rust_run', 0.5, [0.5135, 0.3, 0.2], [0, HALF_PI, 0], 0.14);
  sticker(k, 'grime_streak', 0.6, [-0.2, 1.2, BACK - 0.001], [0, Math.PI, 0], 0.2);

  const model = k.finish({
    size: [1.36, 3.15, 0.96], grime: 0.7,
    boxes: [
      { min: [-0.68, 0, -0.48], max: [0.68, 0.16, 0.48], surface: 'concrete' },                           // 基座
      { min: [-0.57, 0.16, -0.32], max: [0.57, 1.67, 0.33], surface: 'metal' },                           // 柜体
      { min: [-0.42, 1.67, -0.26], max: [-0.18, 2.5, -0.02], surface: 'metal', bulletOnly: true },        // 桅杆：只挡子弹
    ],
  });
  const root = model.group;
  // 活动件：各自收成一个小组，原点放在转轴上
  const doorGroup = door.finish({ boxes: [], grime: 0.6 }).group;
  doorGroup.position.set(-0.487, 0, FRONT - 0.004);
  const dishGroup = rehome(dish.finish({ boxes: [], grime: 0.6 }).group, DISH);
  root.add(doorGroup, dishGroup);
  // 三组灯：从各自的零件箱里取出那唯一的一个网格，起好名字，直接挂在柜子下面
  for (const lampKit of [strips, rack, beacon]) {
    const mesh = lampKit.finish({ boxes: [], grime: 0 }).group.children[0];
    mesh.name = lampKit.name;
    root.add(mesh);
  }
  // dynamic 标记：提醒调用方这些东西每帧可能在变，不要和静态网格合并
  for (const name of [...RELAY_PART_NAMES.lamps, RELAY_PART_NAMES.door, RELAY_PART_NAMES.dish]) root.getObjectByName(name)!.userData.dynamic = true;
  root.userData = { lamps: [...RELAY_PART_NAMES.lamps], door: RELAY_PART_NAMES.door, dish: RELAY_PART_NAMES.dish, beacon: BEACON, interact: [0, 1, 0.75], id };
  return model;
}

/** 把一组网格的原点挪到 pivot：几何体整体往回平移，再把这个组放到 pivot。画面上纹丝不动，但之后转这个组，就是绕 pivot 转了。 */
function rehome(group: THREE.Group, pivot: V3) {
  for (const child of group.children) (child as THREE.Mesh).geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
  group.position.set(pivot[0], pivot[1], pivot[2]);
  return group;
}

/** 中继柜上那些会动、会变色的零件，一次取齐。 */
export interface RelayParts {
  /** 三组指示灯：灯条、设备灯、信标灯。 */
  lamps: THREE.Mesh[];
  /** 左门：rotation.y = -开门角度（弧度，0 是关着）。 */
  door: THREE.Object3D;
  /** 抛物面天线：绕 y 轴转。 */
  dish: THREE.Object3D;
  /** 信标灯的位置（柜子自己的坐标）。 */
  beacon: V3;
  /** 交互点（柜子自己的坐标）：柜子正前方 0.75 米、1 米高。 */
  interact: V3;
}
/** 从一只中继柜（relayCabinet 返回的模型的 group）里取出活动零件。 */
export function relayParts(group: THREE.Object3D): RelayParts {
  return {
    lamps: RELAY_PART_NAMES.lamps.map((name) => group.getObjectByName(name) as THREE.Mesh),
    door: group.getObjectByName(RELAY_PART_NAMES.door)!,
    dish: group.getObjectByName(RELAY_PART_NAMES.dish)!,
    beacon: group.userData.beacon as V3,
    interact: group.userData.interact as V3,
  };
}
/**
 * 把一只中继柜的三组灯一起设成某个颜色和亮度。
 * gain 是亮度倍数：正常呼吸时在 2.5–8.5 之间，切断的一瞬间是 9，0 就是全灭。
 */
export function setRelayLamps(group: THREE.Object3D, color: number, gain: number) {
  for (const name of RELAY_PART_NAMES.lamps) {
    const mesh = group.getObjectByName(name) as THREE.Mesh | undefined;
    if (mesh) (mesh.material as THREE.MeshBasicMaterial).color.setHex(color).multiplyScalar(Math.max(0, gain));
  }
}

// ====================================================================== 登记表

/**
 * 所有场地道具，按参考道具表里的名字登记。摆放的代码可以用名字取：SITE.jersey_barrier({ seed: 2 })。
 * 门柱、推拉门、通道牌在参考里是关卡代码现搭的，没有道具名，这三个名字是我们起的。
 * relay_node 是 relay_cabinet 在参考里的旧名。
 */
export const SITE: Record<string, (o?: any) => PropModel> = {
  jersey_barrier: jerseyBarrier, bollard_post: bollardPost, bollard_mooring: bollardMooring,
  sign_post: signPost, lane_sign: laneSign,
  light_mast: lightMast,
  fence_panel: fencePanel, gate_post: gatePost, sliding_gate: slidingGate,
  guard_booth: guardBooth, gate_arm: gateArm,
  reefer_unit: reeferUnit,
  relay_cabinet: relayCabinet, relay_node: relayCabinet,
};
