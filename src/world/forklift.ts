import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../core/math';
import { DECALS, decal, label, labelMaterial, type LabelOpts, type Patch } from '../render/labels';
import { emissive } from '../render/surfaces';
import { Kit, noise3, type LocalBox, type Mat, type PropModel, type Tint, type V3 } from './kit';

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
// 和参考不一样的地方（各处有注释）。前三处是参考里明显写错的：
//   1. 仪表板在参考里转错了 90°，成了竖插在斜面上的薄片，这里让它平贴在斜面上、正对司机；
//   2. 两块踏板在参考里埋在前围肚子里，这里往后挪到脚能踩到的地方；
//   3. 轮胎和轮辋的深浅本来想按"离轮心多远"来分，参考里拿错了坐标，结果整只轮子一个色，这里按原意算。
// 后四处是照原样搭出来以后，在查看器里看到悬空、看不见或者穿帮才改的：
//   4. 护顶架的前立柱站在前围侧面之外，脚板悬空 —— 在脚板下面补了一块支座；
//   5. "最大载重"那行字喷在门架下横梁的背面，紧贴着底盘前脸，哪个角度都看不见 —— 改喷到上横梁的背面；
//   6. 两根液压软管的下端悬在半空 —— 补了一个埋在前围里的起点；
//   7. 倾斜油缸的缸筒从前围侧面冒出 1 毫米 —— 往里收了 5 毫米。

const HALF_PI = Math.PI / 2;
const PAINT = 'paint_yellow'; // 车身漆
const STEEL = 'steel_dark';   // 结构件：底盘、门架、护顶架
/** 车号：换一个种子就换一个号。 */
const NUMBERS = ['04', '07', '12', '22'];
/** 护顶架的顶面高度。 */
const ROOF = 2.045;

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

const _euler = new THREE.Euler(), _quat = new THREE.Quaternion(), ONE = new THREE.Vector3(1, 1, 1);
/** "先按 rot 转、再挪到 pos"的矩阵。直接调用 kit.add() 放自己做的几何体时用。 */
function placed(pos: V3, rot: V3 = [0, 0, 0]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), _quat.setFromEuler(_euler.set(rot[0], rot[1], rot[2])), ONE);
}

/**
 * 软垫用的圆角盒。
 *
 * 做法：先要一个每面都打了格子的普通盒子，再把顶点往里收 ——
 *   · 每个顶点先"夹"到一个比盒子小一圈（每边缩 r）的内芯上，
 *   · 再沿着"内芯 → 顶点"的方向往外推 r。
 * 面中间的顶点推出来还在原来的面上；棱和角上的顶点被推到一段圆弧上，棱角就圆了。
 *
 * 和零件箱的 rbox 的区别：rbox 的平面中间没有顶点，想把坐垫中间压出一个窝是压不出来的。
 * 这里格子打在整个面上，deform 才有顶点可捏。捏完以后把重合的顶点并起来重算法线，整块就是光滑的。
 *
 * seg 是三个方向各分几格。
 */
function softBox(w: number, h: number, d: number, r: number, seg: V3, deform?: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const half = [w / 2, h / 2, d / 2];
  r = Math.min(r, half[0] * 0.95, half[1] * 0.95, half[2] * 0.95); // 圆角不能比盒子的一半还大
  const box = new THREE.BoxGeometry(w, h, d, seg[0], seg[1], seg[2]);
  const pos = box.getAttribute('position'), v = new THREE.Vector3(), core = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    for (let a = 0; a < 3; a++) {
      const c = v.getComponent(a), step = (2 * half[a]) / seg[a];
      // 面中间的格线按比例往外撑，让最靠边的一条正好落在圆角开始的地方（离边 r），格子就均匀地铺满平的那一段
      if (seg[a] >= 3 && Math.abs(c) < half[a] - 1e-6) v.setComponent(a, (c * (half[a] - r)) / (half[a] - step));
    }
    core.set(clamp(v.x, r - half[0], half[0] - r), clamp(v.y, r - half[1], half[1] - r), clamp(v.z, r - half[2], half[2] - r));
    v.sub(core);
    if (v.lengthSq() > 1e-12) v.setLength(r); // 长度是 0 的不能归一化（会除以 0）；盒子表面上的顶点不会遇到，保险起见还是判一下
    v.add(core);
    deform?.(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  box.deleteAttribute('normal'); box.deleteAttribute('uv');
  const merged = mergeVertices(box, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

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
 * 软管：穿过一串点的光滑弯管。
 * 和零件箱的 hose 是同一个东西，区别只在曲线的算法（这里用和参考一样的"均匀"样条，弯得更饱满一点），
 * 以及段数按管子的长度来定 —— 短的线束五六段就够，两米长的液压管才需要二十几段。
 */
function softHose(k: Kit, mat: Mat, pts: V3[], r: number, tint: Tint = 1) {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.5);
  const steps = Math.max(2, Math.ceil(curve.getLength() / Math.max(0.08, r * 3)));
  k.add(mat, new THREE.TubeGeometry(curve, steps, r, 5, false), { tint });
}

/**
 * 弯的贴片：贴在圆柱面上的字或贴纸。
 * 贴片绕 y 轴弯、正中朝 +z，沿弧线的宽度是 arc、高是 height；at 再把它转到、挪到圆柱上。
 * 平的贴片贴在圆罐上，两头会翘在外面，所以要切成几段顺着弧面走。
 */
function curvedPatch(k: Kit, p: Patch, radius: number, arc: number, height: number, at: THREE.Matrix4) {
  const steps = 4, pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const vertex = (i: number, top: number) => {
    const t = i / steps, a = ((t - 0.5) * arc) / radius;
    pos.push(radius * Math.sin(a), (top - 0.5) * height, radius * Math.cos(a));
    nor.push(Math.sin(a), 0, Math.cos(a));
    uv.push(p.uv[0] + (p.uv[2] - p.uv[0]) * t, p.uv[1] + (p.uv[3] - p.uv[1]) * top); // 贴片在图集里占的那一块
  };
  for (let i = 0; i < steps; i++) {
    vertex(i, 0); vertex(i + 1, 0); vertex(i + 1, 1);
    vertex(i, 0); vertex(i + 1, 1); vertex(i, 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  k.add(labelMaterial(), geo, { raw: true, cast: false }, at);
}

/**
 * 一行字。高 h，但宽度不超过 maxW —— 超了就整体等比例缩小，而不是把字压扁。
 */
function fitLabel(k: Kit, text: string, opts: LabelOpts, maxW: number, h: number, pos: V3, rot?: V3) {
  const aspect = label(text, opts).aspect;
  const w = Math.min(maxW, h * aspect);
  k.label(text, opts, w, w / aspect, pos, rot);
}

// ---- 叉车上的三张贴纸。
// 贴纸库（labels.ts 的 DECALS）是"按名字取图案"的表。这三个名字如果库里已经有人画了，就用库里的；
// 没有的话用下面这份（?? 的意思就是"左边没有才用右边"）。图案的坐标照参考的画法。
const INK = { red: 'rgb(168,36,28)', white: 'rgb(226,223,213)', yellow: 'rgb(222,172,30)', black: 'rgb(24,24,26)' };
const CJK_FONT = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 易燃品：红底菱形、白框、一团白色火焰，底角写着危险品类别"3"。 */
DECALS.hazard_flammable ??= (g, S) => {
  g.scale(S / 256, S / 256); // 下面的坐标都按 256×256 的画布写
  g.save();
  g.translate(128, 128); g.rotate(Math.PI / 4);
  g.fillStyle = INK.red; g.fillRect(-86, -86, 172, 172);
  g.strokeStyle = INK.white; g.lineWidth = 5; g.strokeRect(-76, -76, 152, 152);
  g.restore();
  g.save();
  g.translate(128, 120);
  g.fillStyle = INK.white; // 火焰的外形
  g.beginPath(); g.moveTo(2, -64);
  g.bezierCurveTo(34, -28, 40, 6, 24, 28); g.bezierCurveTo(12, 44, -12, 44, -24, 28);
  g.bezierCurveTo(-40, 6, -20, -12, -15, -34); g.bezierCurveTo(-6, -28, 0, -44, 2, -64);
  g.fill();
  g.fillStyle = INK.red; // 中间挖一个焰心
  g.beginPath(); g.moveTo(1, -10);
  g.bezierCurveTo(15, 6, 15, 24, 0, 31); g.bezierCurveTo(-15, 24, -13, 8, 1, -10);
  g.fill();
  g.fillStyle = INK.white; g.fillRect(-34, 50, 68, 6);
  g.restore();
  g.fillStyle = INK.white; g.font = '900 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillText('3', 128, 230);
};
/** 注意：黄底黑边三角形，里面一个感叹号。 */
DECALS.hazard_general ??= (g, S) => {
  g.scale(S / 256, S / 256);
  g.lineJoin = 'round';
  g.beginPath(); g.moveTo(128, 31); g.lineTo(230, 215); g.lineTo(26, 215); g.closePath();
  g.strokeStyle = INK.black; g.lineWidth = 28; g.stroke(); // 先描一圈粗黑边，圆角就有了
  g.fillStyle = INK.yellow; g.fill();
  g.lineWidth = 9; g.stroke();
  g.fillStyle = INK.black;
  g.beginPath(); g.moveTo(115, 87); g.lineTo(141, 87); g.lineTo(135, 159); g.lineTo(121, 159); g.closePath(); g.fill();
  g.beginPath(); g.arc(128, 183, 11, 0, Math.PI * 2); g.fill();
};
/** 铭牌的宽高比。贴纸在图集里是方的，画的时候横竖各自缩放把方格填满，贴出来再按这个比例还原。 */
const PLATE_ASPECT = 288 / 200;
/** 金属铭牌：灰色铝板、四角铆钉、一行标题、七行小字。九厘米宽，字是看不清的，只要"像一块铭牌"。 */
DECALS.csc_plate ??= (g, S) => {
  const W = 288, H = 200;
  g.scale(S / W, S / H);
  const metal = g.createLinearGradient(0, 0, W, H);
  metal.addColorStop(0, 'rgb(150,152,150)'); metal.addColorStop(0.5, 'rgb(176,178,176)'); metal.addColorStop(1, 'rgb(138,140,138)');
  g.fillStyle = metal; g.beginPath(); g.roundRect(3, 3, W - 6, H - 6, 8); g.fill();
  g.strokeStyle = 'rgba(40,42,44,0.8)'; g.lineWidth = 2; g.strokeRect(11, 11, W - 22, H - 22);
  for (const [x, y] of [[20, 20], [W - 20, 20], [20, H - 20], [W - 20, H - 20]]) {
    g.fillStyle = 'rgb(96,98,98)'; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(230,232,232,0.7)'; g.beginPath(); g.arc(x - 1.2, y - 1.2, 2, 0, Math.PI * 2); g.fill(); // 铆钉左上角的一点高光
  }
  const ink = 'rgba(28,30,32,0.92)';
  g.fillStyle = ink; g.textBaseline = 'alphabetic'; g.textAlign = 'center'; g.font = `600 19px ${CJK_FONT}`;
  g.fillText('安全检验铭牌', W / 2, 46, W - 60);
  g.textAlign = 'left'; g.font = `500 11px ${CJK_FONT}`;
  const rows = ['检验编号 SL/PA-4207/19', '制造日期 2019年03月', '设备编号 SLTU 402719 6', '最大总重 30 480 千克', '堆码载荷 192 000 千克', '横向试验 150 千牛', '下次检验 2027年09月'];
  rows.forEach((row, i) => {
    g.fillStyle = ink; g.fillText(row, 30, 70 + i * 16.5, W - 60);
    g.fillStyle = 'rgba(28,30,32,0.35)'; g.fillRect(30, 73 + i * 16.5, W - 60, 1); // 每行字下面一条细线
  });
};

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

/** 座椅：钢底座、坐垫、靠背、两根靠背支架。 */
function addSeat(k: Kit) {
  k.box(STEEL, 0.4, 0.05, 0.4, -0.54, 1.045, 0, { c: 0.01, tint: 0.5 });
  // 坐垫：上表面中间坐出一个浅窝（正中最深 1.8 厘米，往四周按余弦渐渐变浅）
  const cushion = softBox(0.46, 0.1, 0.46, 0.04, [6, 2, 6], (v) => { if (v.y > 0) v.y -= 0.018 * Math.cos(v.x * 5) * Math.cos(v.z * 5); });
  k.add('rubber', cushion, {}, placed([-0.53, 1.115, 0]));
  // 靠背：朝前的一面中间凹进去 2 厘米，两边鼓起来托住腰；整块上端向后仰 0.16 弧度（约 9°）
  const back = softBox(0.1, 0.5, 0.44, 0.04, [2, 4, 6], (v) => { if (v.x > 0) v.x -= 0.02 * Math.cos(v.z * 5.5); });
  k.add('rubber', back, {}, placed([-0.8, 1.39, 0], [0, 0, 0.16]));
  for (const side of [1, -1]) k.bar(STEEL, [-0.78, 1.08, side * 0.24], [-0.82, 1.3, side * 0.24], 0.03, 0.012, { c: 0.004, tint: 0.5 });
}

/** 前围（仪表台）、仪表板、方向盘、三根液压操纵杆和换向手柄。 */
function addDashboard(k: Kit) {
  // 前围：画一个侧面轮廓 (x, y) 再拉成 0.7 米宽。朝司机的那条斜边是从 (0.30, 1.14) 到 (0.21, 1.02)
  k.extrude(PAINT, [[0.2, 0.55], [0.54, 0.55], [0.54, 1.0], [0.46, 1.12], [0.3, 1.14], [0.21, 1.02]], 0.7, { soft: 0.5 });

  // 仪表板贴在那条斜边的正中。斜边往上走的方向和水平面夹 atan2(0.12, 0.09)；
  // 再减 90° 以后，这个局部坐标系的 −x 就是斜面的外法线（正对司机），y 顺着斜面往上，z 还是车宽方向。
  // （参考里少减了这 90°，面板成了竖插在斜面上的一块薄片，屏幕朝着地板。）
  const slope = Math.atan2(0.12, 0.09);
  k.at([0.253, 1.082, 0], [0, 0, slope - HALF_PI], () => {
    k.box(STEEL, 0.012, 0.13, 0.44, -0.006, 0, 0, { c: 0.004, tint: 0.45 });                                              // 面板
    k.plane(emissive(0x8fe0b0, 0.3), 0.09, 0.05, [-0.0135, 0.01, 0.1], { rot: [0, -HALF_PI, 0], raw: true, cast: false }); // 液晶屏：很暗的一块绿
    k.decal('csc_plate', 0.09, [-0.0135, 0, -0.12], [0, -HALF_PI, 0], 0.09 / PLATE_ASPECT);                               // 铭牌
    k.cyl('plastic_red', 0.016, 0.02, -0.02, 0, 0.19, { axis: 'x', seg: 8, tint: 0.9 });                                  // 急停按钮
    k.cyl('steel_bare', 0.009, 0.02, -0.018, -0.03, -0.01, { axis: 'x', seg: 6, tint: 0.9 });                             // 钥匙
  });

  // 转向柱从前围里斜着伸向司机，方向盘装在柱子的顶端
  const columnFoot: V3 = [0.3, 1.1, 0.04], columnTop: V3 = [0.1, 1.31, 0.04];
  k.tube(STEEL, columnFoot, columnTop, 0.024, { seg: 8, tint: 0.5 });
  // 方向盘的局部坐标系：x 轴顺着转向柱（指向司机），所以盘面就是垂直于 x 的那个平面
  k.at(columnTop, [0, 0, Math.atan2(columnTop[1] - columnFoot[1], columnTop[0] - columnFoot[0])], () => {
    k.torus('rubber', 0.165, 0.014, 0, 0, 0, { axis: 'x', tubeSeg: 6, seg: 18 }); // 盘圈
    for (let i = 0; i < 3; i++) { // 三根辐条，从盘毂伸到盘圈
      const a = (i * Math.PI * 2) / 3 + 0.5;
      k.tube(STEEL, [-0.01, 0, 0], [0, Math.cos(a) * 0.16, Math.sin(a) * 0.16], 0.009, { seg: 5, tint: 0.5 });
    }
    k.cyl(STEEL, 0.04, 0.03, -0.005, 0, 0, { r2: 0.035, seg: 10, rot: [0, 0, HALF_PI], tint: 0.5 });   // 盘毂
    k.cyl('rubber', 0.014, 0.045, 0.03, 0.16, 0.02, { r2: 0.016, seg: 8, rot: [0, 0, HALF_PI] });      // 助力球：叉车司机一只手握着它打方向，另一只手管操纵杆
  });

  // 三根液压操纵杆（起升、倾斜、侧移），一根比一根靠外、矮一点，杆头是橡胶球
  for (let i = 0; i < 3; i++) {
    const z = -0.2 - i * 0.055;
    const tip: V3 = [0.25 - i * 0.012, 1.3 - i * 0.01, z - 0.01];
    k.tube('steel_bare', [0.33, 1.12, z], tip, 0.007, { seg: 5, tint: 0.8 });
    k.sph('rubber', 0.02, ...tip, { seg: 7 });
  }
  // 换向手柄（前进 / 后退），在方向盘另一边，红色的把
  const gripAt: V3 = [0.2, 1.24, 0.29];
  k.tube('steel_bare', [0.3, 1.1, 0.27], gripAt, 0.008, { seg: 5, tint: 0.8 });
  k.cyl('plastic_red', 0.016, 0.07, ...gripAt, { seg: 7, rot: [0, 0, 0.6], tint: 0.9 });
}

/**
 * 护顶架（防止货物砸到司机的铁笼子）、前灯、后视镜、线束、顶上的警示灯。
 * shade() 每调一次给出一个 0.68–0.95 之间的随机深浅：同样是黑钢，一根杆一个样，整个架子才不是一块死黑。
 */
function addOverheadGuard(k: Kit, shade: () => number) {
  for (const side of [1, -1]) {
    k.bar(STEEL, [0.47, 1.08, side * 0.4], [0.27, ROOF, side * 0.46], 0.06, 0.05, { c: 0.01, tint: shade() });  // 前立柱：上端往后倒
    k.bar(STEEL, [-1.0, 1.0, side * 0.44], [-0.95, ROOF, side * 0.46], 0.06, 0.05, { c: 0.01, tint: shade() }); // 后立柱
    k.bar(STEEL, [0.3, ROOF, side * 0.46], [-0.98, ROOF, side * 0.46], 0.05, 0.06, { c: 0.01, tint: shade() }); // 顶棚纵梁
    k.box(STEEL, 0.09, 0.012, 0.08, 0.47, 1.085, side * 0.4, { c: 0.003, tint: 0.5 });  // 立柱脚板
    k.box(STEEL, 0.09, 0.012, 0.08, -1.0, 1.024, side * 0.44, { c: 0.003, tint: 0.5 });
    // 后立柱的脚板踩在机罩顶上；前立柱却站在前围的侧面之外（前围只有 0.7 米宽，立柱在 z=±0.40），
    // 照参考原样搭的话脚板是悬空的。这里在脚板下面补一块焊在前围侧面上的支座，把它托住
    k.box(STEEL, 0.08, 0.07, 0.08, 0.47, 1.044, side * 0.39, { c: 0.008, tint: 0.5 });

    // 前灯：挂在前立柱上的小方灯。灯面亮度 0.7，是"没开但看得出是灯"的奶白色
    k.rbox(STEEL, 0.085, 0.1, 0.13, 0.405, 1.66, side * 0.47, { r: 0.02, seg: 1, tint: 0.45 });
    k.box(emissive(0xfff0d2, 0.7), 0.006, 0.075, 0.105, 0.449, 1.66, side * 0.47, { c: 0.002, raw: true });

    // 后视镜：一根细支臂挑出去，镜壳向外偏 0.25 弧度，镜面是一片亮钢
    k.tube(STEEL, [0.385, 1.5, side * 0.42], [0.42, 1.52, side * 0.57], 0.008, { seg: 5, tint: 0.5 });
    k.box(STEEL, 0.022, 0.17, 0.1, 0.42, 1.52, side * 0.573, { c: 0.006, rot: [0, side * 0.25, 0], tint: 0.5 });
    k.box('steel_bare', 0.002, 0.15, 0.084, 0.408, 1.52, side * 0.57, { plain: true, rot: [0, side * 0.25, 0] });
  }
  for (const x of [0.28, -0.96]) k.box(STEEL, 0.05, 0.06, 0.92, x, ROOF, 0, { c: 0.01, tint: shade() });                       // 顶棚前后两根横梁
  for (let i = 0; i < 8; i++) k.box(STEEL, 0.03, 0.028, 0.9, -0.83 + i * 0.139, ROOF + 0.012, 0, { c: 0.006, tint: shade() }); // 顶棚的八根护条
  // 前灯的线束，只有一侧有：从前立柱脚下绕出来，顺着立柱爬到灯后面
  softHose(k, STEEL, [[0.44, 1.2, 0.44], [0.47, 1.25, 0.49], [0.41, 1.55, 0.5], [0.36, 1.6, 0.455]], 0.011, 0.5);
  // 警示灯：顶棚后部偏一侧的一只橙色灯罩。不闪，亮度 0.9
  k.cyl(STEEL, 0.05, 0.03, -0.86, ROOF + 0.045, 0.3, { r2: 0.045, seg: 10, tint: 0.5 });
  k.lathe(emissive(0xff8a12, 0.9), [[0.04, 0], [0.04, 0.06], [0.03, 0.082], [0, 0.09]], -0.86, ROOF + 0.06, 0.3, { seg: 10, raw: true });
}

/** 液化气罐：横放在配重顶上（罐轴沿 z），两个托架、两道抱箍，阀门在 +z 一头，一根软管通进机罩。 */
function addGasTank(k: Kit) {
  const x = -1.4, y = 1.435; // 罐心：配重顶面 1.23 + 托架 0.05 + 罐半径 0.155
  for (const z of [-0.2, 0.2]) {
    k.box(STEEL, 0.3, 0.07, 0.04, x, 1.262, z, { c: 0.008, tint: 0.5 });                 // 托架
    k.cyl(STEEL, 0.159, 0.035, x, y, z, { axis: 'z', seg: 16, open: true, tint: 0.35 }); // 抱箍：比罐体粗 4 毫米的一圈铁皮
  }
  // 罐体：两头圆鼓的钢瓶，半径 0.155、长 0.74。镀锌的表面按位置带一点深浅
  k.lathe('steel_galv', [[0, -0.37], [0.08, -0.36], [0.132, -0.33], [0.155, -0.27], [0.155, 0.27], [0.132, 0.33], [0.08, 0.36], [0, 0.37]], x, y, 0, {
    axis: 'z', seg: 16, tint: (px, py, pz) => 0.8 + 0.2 * noise3(px * 8, py * 8, pz * 8),
  });
  k.cyl('steel_galv', 0.09, 0.07, x, y, 0.39, { axis: 'z', seg: 12, open: true, tint: 0.7 }); // 阀门护圈
  k.cyl('steel_galv', 0.02, 0.05, x, y, 0.39, { axis: 'z', seg: 8, tint: 0.9 });              // 阀门
  // 供气软管：从阀门出来，翻过配重的肩膀，钻进机罩后上角
  softHose(k, 'rubber', [[x, y, 0.41], [x + 0.05, y - 0.02, 0.46], [x + 0.2, y - 0.15, 0.44], [-1.07, 1.1, 0.38], [-1.0, 0.98, 0.36]], 0.012);
  // 罐身上的两张标：易燃品菱形标和红字"液化气"。
  // 弯贴片本来绕 y 轴弯、正中朝 +z。先绕 x 轴转 −90°，变成绕罐轴（z）弯、正中朝正上方；
  // 外面再绕罐轴转 0.7 弧度，从正上方转到"后上方"—— 站在车后面正好看得到。
  k.at([x, y, 0], [0, 0, 0.7], () => {
    curvedPatch(k, decal('hazard_flammable'), 0.157, 0.12, 0.12, placed([0, 0, -0.05], [-HALF_PI, 0, 0]));
    const text = label('液化气', { color: 'red', font: 'stencil', distress: 0.3 });
    curvedPatch(k, text, 0.157, 0.16, 0.16 / text.aspect, placed([0, 0, 0.14], [-HALF_PI, 0, 0]));
  });
}

/**
 * 一条起升链条（板式链）：一节一节的小方块，一宽一窄交替。
 * 路线：从货叉架往上 → 绕过内门架顶上的链轮 → 从后面垂下来。
 */
function addChain(k: Kit, z: number, carriageLift: number, mastLift: number) {
  const top = 1.9 + mastLift, wheelRadius = 0.055; // 链轮中心的高度、链条绕链轮的半径
  const route: [number, number][] = [[0.725, 0.5 + carriageLift], [0.725, top]];
  for (let a = 0.5; a < Math.PI; a += 0.55) route.push([0.67 + Math.cos(a) * wheelRadius, top + Math.sin(a) * wheelRadius]);
  route.push([0.615, top], [0.615, 1.0]);
  let count = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const [ax, ay] = route[i], [bx, by] = route[i + 1];
    const links = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 0.058)); // 一节大约 5.8 厘米
    for (let j = 0; j < links; j++, count++) {
      const from = j / links, to = (j + 0.86) / links; // 每节只占 86%，节与节之间留一条缝
      const wide = count % 2 === 1;
      k.bar('steel_worn', [ax + (bx - ax) * from, ay + (by - ay) * from, z], [ax + (bx - ax) * to, ay + (by - ay) * to, z], 0.011, wide ? 0.034 : 0.022, { plain: true, tint: wide ? 0.55 : 0.75 });
    }
  }
  k.cyl(STEEL, wheelRadius - 0.006, 0.04, 0.67, top, z, { axis: 'z', seg: 12, tint: 0.7 }); // 链轮
}

/**
 * 门架。两级：外门架固定在车头，内门架套在外门架的槽钢里可以往上抽。
 * 货叉架每升高 1 米，内门架只升高半米 —— 链条绕过内门架顶上的链轮，一头拴在货叉架上，是个动滑轮。
 * carriageLift 是货叉架抬高了多少，mastLift 是内门架抬高了多少。
 */
function addMast(k: Kit, shade: () => number, carriageLift: number, mastLift: number) {
  const back = 0.6, front = 0.73, outside = 0.375; // 外门架槽钢：x 从 0.60 到 0.73，外侧面在 z = ±0.375
  const bottom = 0.08, top = 2.02;
  for (const side of [1, -1]) {
    // 外门架立柱：槽钢，开口朝车的中线。截面画在 (x, z) 平面里：腹板厚 14 毫米，两条翼缘各宽 65 毫米
    const zo = side * outside, zi = zo - side * 0.065, zw = zo - side * 0.014;
    const section: [number, number][] = [[back, zo], [front, zo], [front, zi], [front - 0.014, zi], [front - 0.014, zw], [back + 0.014, zw], [back + 0.014, zi], [back, zi]];
    // 挤出件是"在 xy 平面里画、沿 z 拉厚"。把截面的 z 取反当成 y 来画，再绕 x 轴转 −90°，拉厚的方向就立起来变成了高度
    k.extrude(STEEL, section.map(([x, z]) => [x, -z]), top - bottom, { soft: 0, rot: [-HALF_PI, 0, 0], pos: [0, (bottom + top) / 2, 0], tint: shade() });
    k.box(STEEL, 0.085, 1.86, 0.036, 0.665, 0.13 + mastLift + 0.93, side * 0.335, { c: 0.006, tint: shade() * 1.25 }); // 内门架立柱：嵌在槽里，被滚轮磨得比别处亮
    k.decal('hazard_general', 0.1, [0.665, 1.3, side * (outside + 0.002)], [0, side > 0 ? 0 : Math.PI, 0]);            // 外侧的黄三角警示贴

    // 倾斜油缸：从车身斜着顶住门架，让门架前后倾。粗的是缸筒（藏在前围里面），细的亮的是活塞杆（从前围的前脸伸出来）。
    // 缸筒的末端在参考里是 z=0.317，半径 0.034 的缸筒会从前围的侧面（z=0.35）冒出 1 毫米的一个黑点；这里往里收 5 毫米
    const rodStart: V3 = [0.5, 0.777, side * 0.312];
    k.tube(STEEL, [0.36, 0.66, side * 0.3], rodStart, 0.034, { seg: 8, cap: true, tint: 0.55 });
    k.tube('steel_bare', rodStart, [0.6, 0.86, side * 0.33], 0.018, { seg: 6 });

    addChain(k, side * 0.13, carriageLift, mastLift);
  }
  k.box(STEEL, 0.04, 0.09, 0.78, back - 0.012, 1.96, 0, { c: 0.008, tint: shade() });  // 外门架上横梁
  k.box(STEEL, 0.04, 0.12, 0.78, back - 0.012, 0.42, 0, { c: 0.008, tint: shade() });  // 外门架下横梁
  k.box(STEEL, 0.07, 0.09, 0.66, 0.665, 1.99 + mastLift, 0, { c: 0.008, tint: shade() }); // 内门架上横梁，跟着内门架升
  // 起升油缸：立在两根立柱正中。缸筒不动，镀铬的活塞杆顶着内门架的上横梁，内门架升多少它就伸出多少
  k.cyl(STEEL, 0.048, 1.15, 0.645, 0.72, 0, { seg: 10, tint: 0.6 });
  k.cyl(STEEL, 0.055, 0.05, 0.645, 1.3, 0, { seg: 10, tint: 0.5 }); // 缸口的压盖
  const rod = 0.64 + mastLift;
  k.cyl('steel_bare', 0.027, rod, 0.645, 1.31 + rod / 2, 0, { seg: 8, open: true });
  // 载重铭文：喷在外门架横梁朝司机的一面。
  // 参考把它喷在下横梁上（y=0.42），可那里离底盘的前脸只有不到两厘米，从哪个角度都看不见；这里改喷到上横梁，司机一抬头就能看到
  fitLabel(k, '最大载重2500千克', { color: 'yellow', font: 'stencil', distress: 0.3 }, 0.5, 0.05, [back - 0.033, 1.96, 0], [0, -HALF_PI, 0]);
  // 两根液压软管：从前围里钻出来，翻过内门架顶，垂到货叉架上。门架和货叉架升起来的时候，中间几个点跟着往上走。
  // 第一个点是这里补的：参考的软管从 (0.60, 1.25) 凭空开始，下端悬在前围上方；补一个埋在前围里的起点，管子就是从车身里出来的了
  for (const z of [0.21, 0.245]) {
    softHose(k, 'rubber', [[0.5, 1.03, z], [0.6, 1.25, z], [0.59, 1.65 + mastLift * 0.6, z], [0.655, 1.86 + mastLift, z + 0.005], [0.735, 1.6 + mastLift * 1.2, z], [0.74, 0.56 + carriageLift, z]], 0.011);
  }
}

/** 货叉架（在门架上上下滑的那个框）、挡货架（防止货往司机这边倒的栅栏）和两根 L 形货叉。整体抬高 carriageLift。 */
function addCarriage(k: Kit, shade: () => number, carriageLift: number) {
  k.at([0, carriageLift, 0], null, () => {
    for (const y of [0.18, 0.56]) k.box(STEEL, 0.04, 0.1, 1.02, 0.755, y, 0, { c: 0.008, tint: shade() }); // 上下两根横梁，货叉就挂在它们上面
    k.box('hazard_stripes', 0.003, 0.06, 0.4, 0.7765, 0.56, 0, { plain: true, tint: 0.9 });                // 上横梁正面的警示条
    for (const side of [1, -1]) {
      k.box(STEEL, 0.03, 0.5, 0.06, 0.745, 0.37, side * 0.3, { c: 0.006, tint: shade() });     // 侧板，把两根横梁连成一个框
      k.box(STEEL, 0.11, 0.36, 0.022, 0.685, 0.37, side * 0.305, { c: 0.005, tint: shade() }); // 滚轮座：往后伸进门架的槽里
      k.cyl('steel_worn', 0.04, 0.03, 0.67, 0.26, side * 0.325, { axis: 'z', seg: 10, tint: 0.7 }); // 滚轮
      k.box(STEEL, 0.03, 0.78, 0.04, 0.755, 1.0, side * 0.5, { c: 0.006, tint: shade() });     // 挡货架两边的立柱
    }
    k.box(STEEL, 0.03, 0.04, 1.04, 0.755, 1.39, 0, { c: 0.006, tint: shade() }); // 挡货架顶梁
    k.box(STEEL, 0.02, 0.03, 1.0, 0.755, 1.0, 0, { c: 0.004, tint: shade() });   // 挡货架中梁
    for (let i = -2; i <= 2; i++) k.box(STEEL, 0.02, 0.76, 0.02, 0.755, 1.0, i * 0.165, { c: 0.004, tint: shade() }); // 五根竖条

    for (const side of [1, -1]) {
      // 货叉：L 形的侧面轮廓拉成 10 厘米宽。水平的叉面长 0.92，根部厚 4.6 厘米、到叉尖只剩 1 厘米；竖着的叉背高 0.62
      k.extrude('steel_worn', [[0.777, 0.035], [1.45, 0.035], [1.7, 0.041], [1.7, 0.051], [0.87, 0.081], [0.826, 0.11], [0.822, 0.655], [0.777, 0.655]], 0.1, {
        soft: 0.45, pos: [0, 0, side * 0.26],
        // 根部暗，越到叉尖越亮：叉尖天天往托盘里插，磨得发亮。再乘一层细碎的深浅，像一道道划痕
        tint: (x, _y, z) => (0.5 + 0.5 * clamp((x - 0.8) / 0.9, 0, 1)) * (0.8 + 0.2 * noise3(x * 14, z * 30 + side, 0)),
      });
      k.box(STEEL, 0.075, 0.05, 0.112, 0.772, 0.635, side * 0.26, { c: 0.006, tint: 0.55 }); // 上挂钩：货叉靠它钩在上横梁上
      k.box(STEEL, 0.03, 0.04, 0.112, 0.79, 0.13, side * 0.26, { c: 0.006, tint: 0.55 });    // 下挂钩
    }
  });
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
  const shade = () => k.range(0.68, 0.95);

  const tireUvs: Float32Array[] = [];
  for (const side of [1, -1]) {
    addWheel(k, FRONT_WHEEL, side, tireUvs);
    addWheel(k, REAR_WHEEL, side, tireUvs);
  }
  addChassis(k);
  addCounterweight(k, number);
  addHood(k, number);
  addSeat(k);
  addDashboard(k);
  addOverheadGuard(k, shade);
  addGasTank(k);
  addMast(k, shade, carriageLift, mastLift);
  addCarriage(k, shade, carriageLift);

  // 碰撞盒。不是一个大方块，而是十一个小盒子：驾驶室是镂空的 —— 子弹能从立柱之间穿过去，人可以躲在配重后面。
  // 货叉落地的时候，货叉那个盒子只有 10 厘米高，摆放时会被当成"可以直接走过去"而跳过（见 propfield.ts）。
  const boxes: LocalBox[] = [
    { min: [-1.7, 0, -0.6], max: [0.58, 1.24, 0.6], surface: 'metal' },                                    // 车身：配重、机罩、前围
    { min: [-1.56, 1.24, -0.4], max: [-1.22, 1.6, 0.4], surface: 'metal' },                                // 气罐
    { min: [-0.88, 1.24, -0.24], max: [-0.7, 1.66, 0.24], surface: 'rubber' },                             // 座椅靠背
    { min: [0.56, 0, -0.42], max: [0.78, 2.04 + mastLift, 0.42], surface: 'metal' },                       // 门架
    { min: [0.72, carriageLift, -0.53], max: [0.8, carriageLift + 1.42, 0.53], surface: 'metal' },         // 货叉架和挡货架
    { min: [0.8, carriageLift, -0.33], max: [1.7, carriageLift + 0.1, 0.33], surface: 'metal' },           // 货叉
    { min: [-1.02, 2.0, -0.5], max: [0.32, 2.1, 0.5], surface: 'metal' },                                  // 顶棚
  ];
  for (const side of [1, -1]) {
    // 四根立柱各一个细长的盒子，在 z 方向从 inner 到 0.5。盒子的 min 必须比 max 小，所以 −z 那一侧要把两头对调
    const zRange = (inner: number) => (side > 0 ? [inner, 0.5] : [-0.5, -inner]);
    const [rear0, rear1] = zRange(0.41), [front0, front1] = zRange(0.37);
    boxes.push(
      { min: [-1.03, 1.0, rear0], max: [-0.92, ROOF, rear1], surface: 'metal' },  // 后立柱
      { min: [0.24, 1.08, front0], max: [0.5, ROOF, front1], surface: 'metal' },  // 前立柱（斜的，盒子把它整个包住）
    );
  }

  // 占地 3.4 × 1.25 米；高度随货叉抬升而变：平时是护顶架和警示灯（2.2），抬高以后是挡货架或者内门架的顶
  const height = Math.max(2.2, 0.06 + carriageLift + 1.36, 2.04 + mastLift);
  const model = k.finish({ size: [3.4, height, 1.25], boxes });
  applyTireUv(model.group, tireUvs);
  return model;
}
