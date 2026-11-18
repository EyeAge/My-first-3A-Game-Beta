import * as THREE from 'three';
import { clamp, vnoise } from '../../core/math';
import { Kit, type Mat, type PropModel, type Rgb, type Tint, type V3 } from '../kit';

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

// ====================================================================== 登记表

/**
 * 所有场地道具，按参考道具表里的名字登记。摆放的代码可以用名字取：SITE.jersey_barrier({ seed: 2 })。
 */
export const SITE: Record<string, (o?: any) => PropModel> = {
  jersey_barrier: jerseyBarrier, bollard_post: bollardPost, bollard_mooring: bollardMooring,
};
