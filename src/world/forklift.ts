import * as THREE from 'three';
import { clamp } from '../core/math';
import { label, type LabelOpts } from '../render/labels';
import { emissive } from '../render/surfaces';
import { Kit, noise3, type PropModel, type V3 } from './kit';

// 内燃平衡重式叉车。
//
// "平衡重"是说：货压在车头的货叉上，车尾挂一大块铸铁把它压住，前轮就是跷跷板的支点。
// 所以这种车的长相是固定的，从前到后依次是：
//
//   货叉 → 门架（两级，带链条和油缸）→ 前轮和前围 → 驾驶位（头顶是护顶架）→ 机罩 → 配重（上面横着一只液化气罐）
//
// 坐标：货叉朝 +x，配重在 −x，车宽沿 z；底面在 y=0，原点在占地中心；单位是米。
// 下面每个零件的尺寸和位置都是这个坐标系里的数，照着参考实现的规格一件一件搭。
//
// 整台车三百来个零件，全部放进零件箱（Kit）：同一种材质的零件最后并成一个网格，所以画它只要十几次绘制调用。
// 它不会动 —— forksUp 决定的是"搭出来的时候货叉停在多高"，不是动画；车灯也只是几块很暗的发光面片，
// 看得出是灯，但不照亮周围。
//
// 和参考不一样的地方（各处有注释），都是参考里明显写错的：
//   · 两块踏板在参考里埋在前围肚子里，这里往后挪到脚能踩到的地方；
//   · 轮胎和轮辋的深浅本来想按"离轮心多远"来分，参考里拿错了坐标，结果整只轮子一个色，这里按原意算。
//
// 这个文件分三步搭：先是车身（车轮、底盘、配重、机罩），再是驾驶室，最后是门架和货叉。

const HALF_PI = Math.PI / 2;
const PAINT = 'paint_yellow'; // 车身漆
const STEEL = 'steel_dark';   // 结构件：底盘、门架、护顶架
/** 车号：换一个种子就换一个号。 */
const NUMBERS = ['04', '07', '12', '22'];

/** 车轮的规格。前轮是驱动轮，又大又宽（货的重量都压在它上面）；后轮是转向轮，小一圈。 */
interface Wheel {
  /** 轮心的前后位置。 */
  x: number;
  /** 轮心离车身中线多远（胎宽的正中间）。 */
  z: number;
  radius: number;
  /** 胎宽。 */
  width: number;
  /** 轮辋半径，也就是轮胎中间那个洞的半径。 */
  rim: number;
  /** 一圈分多少段。 */
  seg: number;
}
const FRONT_WHEEL: Wheel = { x: 0.22, z: 0.47, radius: 0.33, width: 0.23, rim: 0.195, seg: 24 };
const REAR_WHEEL: Wheel = { x: -1.1, z: 0.46, radius: 0.27, width: 0.18, rim: 0.155, seg: 20 };

// ====================================================================== 局部工具
// 下面几样是零件箱里暂时没有、叉车又用得上的东西。

/**
 * 轮胎：把一圈截面轮廓 [半径, 轴向位置] 绕车轴转一圈。
 *
 * 为什么不直接用零件箱的 lathe：零件箱给所有零件铺的是"按朝向投影"的贴图坐标，对盒子很合适，
 * 但轮胎的花纹要顺着圆周一圈一圈绕、并且胎面和胎壁各用贴图的一段。所以这里自己算一份贴图坐标：
 *   u 沿圆周走，单位是米，总长凑成 0.5 米的整数倍（轮胎贴图 0.5 米重复一次，这样接缝对得上）；
 *   v 以胎面正中为 0，到胎面边缘是 ±0.126，再往胎壁走到 ±0.148。
 * 返回的 uv 要等零件箱合并完网格以后再换上去（见 applyTireUv）。
 *
 * 轮廓里连写两个相同的点 = 那里是一道硬棱（胎肩、胎圈）。
 */
function tireGeometry(wheel: Wheel) {
  const { radius: R, width: W, rim, seg } = wheel;
  const wall = R - rim;                         // 胎壁有多高
  const groove = Math.min(0.011, wall * 0.08);  // 胎面上两道环向沟槽的深度
  const prof: [number, number][] = [
    [rim, 0.18 * W], [rim + 0.45 * wall, 0.035 * W], [R - 0.2 * wall, 0.02 * W], [R - 0.06 * wall, 0.07 * W], [R, 0.17 * W], [R, 0.17 * W], // 靠车身一侧的胎壁和胎肩
    [R, 0.355 * W], [R - groove, 0.385 * W], [R, 0.415 * W],  // 第一道沟槽
    [R, 0.585 * W], [R - groove, 0.615 * W], [R, 0.645 * W],  // 第二道沟槽
    [R, 0.83 * W], [R, 0.83 * W], [R - 0.06 * wall, 0.93 * W], [R - 0.2 * wall, 0.98 * W], [rim + 0.45 * wall, 0.965 * W], [rim, 0.82 * W], [rim, 0.82 * W], // 朝外一侧的胎肩和胎壁
    [rim, 0.18 * W], // 回到起点：贴着轮辋的那一圈
  ];
  const n = prof.length;
  // 沿轮廓走过的长度，用来定 v
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const mid = (along[8] + along[9]) / 2;  // 胎面正中
  const treadHalf = mid - along[4];       // 胎面半宽（从胎肩到正中）
  const sideLen = along[4] - along[0];    // 一侧胎壁的长度
  const vAt = (i: number) => {
    const s = i >= n - 2 ? -(treadHalf + sideLen) : along[i] - mid; // 最后贴轮辋的那一圈整个算作胎壁的尽头
    const a = Math.abs(s);
    return Math.sign(s) * (a <= treadHalf + 1e-6 ? (a / treadHalf) * 0.126 : 0.126 + Math.min(1, (a - treadHalf) / sideLen) * 0.022);
  };
  const uLength = Math.max(1, Math.round((2 * Math.PI * R) / 0.5)) * 0.5;
  // 每个轮廓点的法线 = 前后两段轮廓线法线的平均；长度为 0 的那一段（硬棱）不参与，所以硬棱两边各有各的法线
  const nr: number[] = [], nh: number[] = [];
  for (let i = 0; i < n; i++) {
    let dr = 0, dh = 0;
    for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
      if (a < 0 || b >= n) continue;
      const len = Math.hypot(prof[b][0] - prof[a][0], prof[b][1] - prof[a][1]);
      if (len > 1e-6) { dr += (prof[b][0] - prof[a][0]) / len; dh += (prof[b][1] - prof[a][1]) / len; }
    }
    const len = Math.hypot(dr, dh) || 1;
    nr.push(dh / len); nh.push(-dr / len); // 轮廓方向 (dr, dh) 转 90° 就是朝外的法线
  }
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const vertex = (i: number, j: number) => {
    const a = (j / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    pos.push(prof[i][0] * ca, prof[i][1], prof[i][0] * sa);
    nor.push(nr[i] * ca, nh[i], nr[i] * sa);
    uv.push((j / seg) * uLength, vAt(i));
  };
  for (let i = 0; i + 1 < n; i++) {
    if (Math.hypot(prof[i + 1][0] - prof[i][0], prof[i + 1][1] - prof[i][1]) < 1e-6) continue; // 硬棱：两个点重合，中间没有面
    for (let j = 0; j < seg; j++) {
      vertex(i, j); vertex(i + 1, j); vertex(i, j + 1);
      vertex(i + 1, j); vertex(i + 1, j + 1); vertex(i, j + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return { geo, uv: new Float32Array(uv) };
}

/**
 * 把轮胎自己的贴图坐标换到合并好的轮胎网格上。
 * 零件箱合并时不打乱顶点顺序：四只轮胎按放进去的先后首尾相接，所以把四份 uv 按同样的顺序接起来就对上了。
 * 万一顶点数对不上（比如以后零件箱改了合并方式），就什么都不做，保留零件箱铺的坐标。
 */
function applyTireUv(group: THREE.Group, uvs: Float32Array[]) {
  const mesh = group.children.find((c) => c.name === 'forklift:tire') as THREE.Mesh | undefined;
  const total = uvs.reduce((sum, a) => sum + a.length, 0);
  if (!mesh || mesh.geometry.getAttribute('uv').count * 2 !== total) return;
  const all = new Float32Array(total);
  let at = 0;
  for (const a of uvs) { all.set(a, at); at += a.length; }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(all, 2));
}

/**
 * 一行字。高 h，但宽度不超过 maxW —— 超了就整体等比例缩小，而不是把字压扁。
 */
function fitLabel(k: Kit, text: string, opts: LabelOpts, maxW: number, h: number, pos: V3, rot?: V3) {
  const aspect = label(text, opts).aspect;
  const w = Math.min(maxW, h * aspect);
  k.label(text, opts, w, w / aspect, pos, rot);
}

// ====================================================================== 各个部分

/**
 * 一只车轮。side 是 +1（车的 +z 一侧）或 −1。
 * 车轮在自己的坐标系里搭：车轴是 y 轴，y=0 是轮胎贴车身的一面，y=胎宽 是朝外的一面。
 * 所以先把坐标系挪到轮胎内侧面的圆心、把 y 轴扳到朝车外，再随便转一个角度（每只轮子停的位置不一样）。
 */
function addWheel(k: Kit, wheel: Wheel, side: number, tireUvs: Float32Array[]) {
  const { x: cx, radius: R, width: W, rim } = wheel;
  const spin = k.rng() * 6;    // 这只轮子转到了哪个角度
  const phase = k.rng() * 20;  // 胎面深浅花斑的相位
  const face = W * 0.8;        // 轮辋外沿在轴向上的位置：比轮胎外侧面缩进去一点
  // 明暗函数拿到的是叉车坐标里的顶点位置；轮心在 (cx, R)，车轴沿 z，所以"离车轴多远"这样算：
  const fromAxle = (x: number, y: number) => Math.hypot(x - cx, y - R);
  k.at([cx, R, side * (wheel.z - W / 2)], [side * HALF_PI, 0, 0], () => k.at([0, 0, 0], [0, spin, 0], () => {
    const tire = tireGeometry(wheel);
    tireUvs.push(tire.uv);
    k.add('tire', tire.geo, {
      tint: (x, y) => {
        const d = fromAxle(x, y);
        if (d < rim + 0.01) return 0.45; // 贴着轮辋的一圈最暗：常年晒不到、擦不到
        // 其余部分带一点花斑。角度用 cos / sin 喂给噪声，绕一圈回来首尾是接上的
        return 0.78 + 0.22 * noise3(((x - cx) / d) * 3 + phase, ((y - R) / d) * 3, d * 30);
      },
    });
    // 轮辋：碟形钢圈。外圈溅满了泥，偏暗偏褐；靠近轮心的部分干净一些
    k.lathe(PAINT, [[rim + 0.006, face + 0.012], [rim - 0.012, face + 0.016], [rim - 0.03, face - 0.02], [rim * 0.62, face - 0.05], [rim * 0.5, face - 0.02], [rim * 0.42, face - 0.012], [0, face - 0.012]], 0, 0, 0, {
      seg: 14, tint: (x, y) => (fromAxle(x, y) > rim * 0.7 ? [0.55, 0.5, 0.42] : [0.8, 0.78, 0.7]),
    });
    // 背板：一张朝车身那面的圆片。轮辋只有朝外的一面，没有它的话从车底下往外看，轮子是透的
    k.add(STEEL, new THREE.CircleGeometry(rim + 0.004, 10).rotateX(HALF_PI).translate(0, W * 0.2, 0), { tint: 0.4 });
    k.cyl(STEEL, rim * 0.24, 0.035, 0, face, 0, { r2: rim * 0.2, seg: 8, tint: 0.7 }); // 轮毂盖
    for (let i = 0; i < 6; i++) { // 六颗螺母
      const a = (i * Math.PI) / 3;
      k.cyl('steel_galv', 0.012, 0.016, Math.cos(a) * rim * 0.33, face - 0.006, Math.sin(a) * rim * 0.33, { r2: 0.011, seg: 6, tint: k.range(0.5, 0.8) });
    }
  }));
}

/** 车桥、底盘、两侧的台阶箱、前轮挡泥板、驾驶室地板和踏板。 */
function addChassis(k: Kit) {
  k.tube(STEEL, [FRONT_WHEEL.x, FRONT_WHEEL.radius, -0.4], [FRONT_WHEEL.x, FRONT_WHEEL.radius, 0.4], 0.07, { seg: 8, tint: 0.5 }); // 前桥
  k.box(STEEL, 0.12, 0.1, 0.78, REAR_WHEEL.x, REAR_WHEEL.radius, 0, { c: 0.01, tint: 0.5 });                                       // 后桥
  k.box(STEEL, 1.95, 0.34, 0.68, -0.425, 0.37, 0, { c: 0.02, tint: 0.55 });                                                         // 底盘：一个长铁箱
  for (const side of [1, -1]) {
    k.box(PAINT, 0.6, 0.3, 0.17, -0.47, 0.4, side * 0.42, { c: 0.02, tint: 0.92 });               // 侧箱，也是上车踩的台阶
    k.box('diamond_plate', 0.3, 0.012, 0.16, -0.32, 0.556, side * 0.42, { c: 0.003, tint: 0.7 }); // 台阶上的防滑花纹板
    k.cyl(STEEL, 0.03, 0.02, -0.62, 0.56, side * 0.42, { seg: 8, tint: 0.6 });                    // 加油口盖
    // 前轮挡泥板：罩在前轮上方的一段圆弧铁皮。截面是绕前轮心的一段圆环，从车头方向一直包到轮子后上方
    const outer = FRONT_WHEEL.radius + 0.06, inner = FRONT_WHEEL.radius + 0.035;
    const angle = (i: number) => 0.12 + ((Math.PI - 0.5) * i) / 7;
    const ring: [number, number][] = [];
    for (let i = 0; i <= 7; i++) ring.push([FRONT_WHEEL.x + Math.cos(angle(i)) * outer, FRONT_WHEEL.radius + Math.sin(angle(i)) * outer]);
    for (let i = 7; i >= 0; i--) ring.push([FRONT_WHEEL.x + Math.cos(angle(i)) * inner, FRONT_WHEEL.radius + Math.sin(angle(i)) * inner]);
    k.extrude(PAINT, ring, 0.27, { soft: 0.7, pos: [0, 0, side * 0.475], tint: 0.95 });
  }
  k.box('diamond_plate', 0.66, 0.016, 0.68, 0.2, 0.548, 0, { plain: true, tint: 0.6 }); // 驾驶室地板
  // 两块踏板（刹车、油门），前沿翘起。参考里它们在 x=0.33，整个埋在前围里面；这里挪到前围后面、脚够得着的地方
  for (const z of [-0.12, 0.1]) k.box('rubber', 0.1, 0.02, 0.07, 0.12, 0.6, z, { c: 0.006, rot: [0, 0, 0.5], tint: 0.8 });
}

/** 配重和车尾：铸铁大圆角块、下半截、警示条、车号、尾灯、品牌字、牵引销。 */
function addCounterweight(k: Kit, number: string) {
  // 上半截是一整块铸铁，棱角都是大圆角。车尾那一面的上沿再往前收一点（越往上收得越多），像真车的铸件那样带一点斜度
  k.rbox(PAINT, 0.62, 0.63, 1.12, -1.39, 0.915, 0, {
    r: 0.12, seg: 3, tint: 0.97,
    deform: (v) => { if (v.y > 0.1 && v.x < 0) v.x += (0.03 * (v.y - 0.1)) / 0.215; },
  });
  k.box(PAINT, 0.56, 0.37, 0.64, -1.4, 0.43, 0, { c: 0.05, tint: 0.85 });              // 下半截，夹在两只后轮中间
  k.box('hazard_stripes', 0.014, 0.085, 0.84, -1.702, 0.77, 0, { c: 0.004, tint: 0.95 }); // 车尾的黄黑警示条
  fitLabel(k, number, { color: 'black', font: 'stencil', distress: 0.35 }, 0.4, 0.2, [-1.703, 0.96, 0], [0, -HALF_PI, 0]); // 车尾的大号车号，朝后
  for (const side of [1, -1]) {
    // 尾灯：熄着的。亮度只有 0.16，是一块暗红色，不会被泛光晕开
    k.box(emissive(0xff2a12, 0.16), 0.012, 0.05, 0.11, -1.69, 1.1, side * 0.37, { c: 0.004, raw: true });
    k.box(STEEL, 0.016, 0.066, 0.126, -1.684, 1.1, side * 0.37, { c: 0.004, tint: 0.4 }); // 灯座，比灯大一圈，垫在后面
    // 配重两侧的品牌字。贴片本来朝 +z；另一侧绕竖轴转半圈朝 −z，字才不会是反的
    fitLabel(k, '激战', { color: 'black', font: 'sans', distress: 0.3 }, 0.42, 0.085, [-1.39, 0.99, side * 0.5625], [0, side > 0 ? 0 : Math.PI, 0]);
    k.box(STEEL, 0.06, 0.05, 0.02, -1.67, 0.44, side * 0.05, { c: 0.004, tint: 0.5 });   // 牵引销座的两片耳板
  }
  k.cyl('steel_worn', 0.02, 0.13, -1.68, 0.44, 0, { seg: 8, tint: 0.7 });                 // 牵引销：一根竖着的销子
}

/** 机罩：座椅下面盖着发动机的箱子，两侧有车号和散热格栅。 */
function addHood(k: Kit, number: string) {
  k.box(PAINT, 0.98, 0.46, 0.94, -0.59, 0.79, 0, { c: 0.04 });
  for (const side of [1, -1]) {
    fitLabel(k, number, { color: 'black', font: 'stencil', distress: 0.35 }, 0.3, 0.19, [-0.84, 0.8, side * 0.4715], [0, side > 0 ? 0 : Math.PI, 0]);
    // 散热格栅：一块几乎全黑的底板（看上去像个洞），外面五片向下斜的百叶
    k.box(STEEL, 0.34, 0.2, 0.004, -0.36, 0.8, side * 0.47, { plain: true, tint: 0.2 });
    for (let i = 0; i < 5; i++) k.box(PAINT, 0.34, 0.03, 0.006, -0.36, 0.72 + i * 0.04, side * 0.474, { plain: true, rot: [side * 0.5, 0, 0], tint: 0.85 });
  }
}

// ====================================================================== 整车

/**
 * 搭一台叉车。
 *   seed     换一个数就是另一台：车号（04 / 07 / 12 / 22 轮着来）、每根钢件的深浅、车轮停的角度、脏污的花纹都会变，尺寸不变。
 *   forksUp  货叉抬多高，0–1。1 是抬到头：货叉架升 1.5 米，内门架跟着升 0.75 米。
 *   interior 停在室内（淋不到雨）。
 */
export function buildForklift(o: { seed?: number; forksUp?: number; interior?: boolean } = {}): PropModel {
  const seed = Math.abs(Math.floor(o.seed ?? 0));
  const k = new Kit('forklift', seed, { interior: o.interior });
  const carriageLift = clamp(o.forksUp ?? 0, 0, 1) * 1.5;
  const mastLift = carriageLift / 2;
  const number = NUMBERS[seed % NUMBERS.length];

  const tireUvs: Float32Array[] = [];
  for (const side of [1, -1]) {
    addWheel(k, FRONT_WHEEL, side, tireUvs);
    addWheel(k, REAR_WHEEL, side, tireUvs);
  }
  addChassis(k);
  addCounterweight(k, number);
  addHood(k, number);

  // 占地 3.4 × 1.25 米；高度随货叉抬升而变：平时是护顶架和警示灯（2.2），抬高以后是挡货架或者内门架的顶
  const height = Math.max(2.2, 0.06 + carriageLift + 1.36, 2.04 + mastLift);
  // 碰撞盒先不给：零件箱会拿整个外包盒顶着。等整车搭完，再换成一组贴身的小盒子
  const model = k.finish({ size: [3.4, height, 1.25], surface: 'metal' });
  applyTireUv(model.group, tireUvs);
  return model;
}
