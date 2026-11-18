import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { reflectionUniforms } from '../render/reflection';
import { wetness } from '../render/surfaces';
import { bakeGroundMask, isPuddleAt, puddleDepthAt } from './groundmask';
import { groundDetailTextures, groundPaintTexture, stencilText } from './textures';

// 港区的地面：一整块湿漉漉的路面。
//
// 几何上它只是一个大平面（两个三角形）。板缝、裂缝、修补块、油渍、标线、钢轨、积水、雨点涟漪、倒影，
// 全部是在一个片元着色器里画出来的。把这些都画在同一个着色器里（而不是贴一层层贴花）有个大好处：
// 它们互相知道对方 —— 漆会被水淹、水下还看得见漆，板缝里先存水，油渍会反光，补丁会把标线切断。
//
// 着色器吃四张自己生成的贴图：
//   掩码（groundmask.ts）  哪里低洼、哪里潮、哪里有油、哪里磨得狠 —— 全场只此一张，不平铺
//   细节 / 坡度（textures.ts）  石子、斑块的原料 —— 平铺
//   喷涂图（本文件下半部分）  模板字、箭头、轮胎擦痕 —— 只盖主干道和码头两条行车走廊
// 直线类的标线（车道线、斑马线、堆位边框……）不进贴图，直接用数学式子画，凑多近都是锐利的。

export { isPuddleAt, puddleDepthAt } from './groundmask';

/**
 * 和“亮度”有关的数都集中在这里，方便以后跟着全局光照一起调。
 * 颜色都是线性空间的反照率（0 = 全黑，1 = 把光全部漫反射回去）；干燥的沥青大约 0.12，水泥 0.22。
 */
const LOOK = {
  asphalt: [0.125, 0.125, 0.13],        // 沥青（堆场和主干道）
  concrete: [0.22, 0.215, 0.2],         // 水泥（码头前沿、车间门前）
  aggregate: [0.11, 0.105, 0.095],      // 露出来的浅色石子，加在底色上
  patch: [0.085, 0.085, 0.09],          // 后补的新沥青，比老路面黑
  tar: [0.018, 0.018, 0.02],            // 填缝的沥青胶、裂缝
  crackDarken: 0.7,                     // 发丝裂缝把路面压暗多少（1 = 全黑）。裂缝只有几毫米宽，画成纯黑反而像描上去的线
  sealAsphalt: 0.85,                    // 补缝胶盖住沥青路面的程度；水泥面是浅色的，黑胶太跳，所以盖得薄一些
  sealConcrete: 0.5,
  paintYellow: [0.52, 0.34, 0.035],
  paintWhite: [0.47, 0.47, 0.44],
  railBed: [0.05, 0.04, 0.035],         // 轨道槽里的锈和泥
  railHead: [0.5, 0.5, 0.52],           // 被车轮磨亮的轨头（按金属算）
  waterTint: [0.004, 0.006, 0.0065],    // 深水里那一点点浑浊的青色
  dampDarken: 0.54,                     // 路面受潮后反照率乘多少（水填进石子缝，光出不来，所以湿的地方更黑）
  soakDarken: 0.5,                      // 贴着水边、吸饱了水的那一圈再乘多少
  waterF0: 0.075,                       // 水面正对着看时反射多少光。真实的水约 0.02，这里故意取高，倒影才够明显
  sunSpecularMax: 40,                   // 太阳在水面上的高光封顶，不然一个像素能亮到把泛光炸成一团
  reflectionMax: 48,                    // 倒影贴图里单个像素的亮度封顶，理由同上
  // 没有积水、只是潮湿的路面，这两项要低得多。太阳只有 13° 高，迎着它看时潮湿路面上的高光是又宽又长的一条，
  // 物理上它确实比周围亮几十倍，但画面装不下：整条高光会烧成一片没有细节的白。所以给它一个“软封顶”——
  // 暗的部分基本不动，越亮压得越狠，最亮也只到 dampSpecularMax。亮度大约 1 就是画面上的白，取 1.6 时高光是亮金色、还看得见路面的纹理
  dampSpecularMax: 1.6,
  dampReflectionMax: 3.0,               // 倒影同理：糊掉的太阳圆盘映在潮湿路面上，不封顶的话又是一片白
  crestSkyGain: 0.12,                   // 涟漪波峰额外反射多少天光（乘在环境光上，所以会跟着天光一起变亮变暗）
  envMapIntensity: 1.0,                 // 没开平面反射时，地面反射天空的强度
};

/**
 * 路面“颗粒感”的旋钮。太阳的仰角只有 13°，光几乎是贴着地面扫过来的：
 * 这时候石子的凹凸只要稍微重一点，朝着太阳的那半边就亮一倍、背着的那半边全黑，整片路面看着像橘子皮。
 * 所以颗粒要“细而浅”——明暗的大关系留给成片的潮湿和干斑去做，不靠石子。
 */
const GRAIN = {
  tile: 2.1,            // 石子那一层每米铺几遍：2.1 → 0.48 米一铺，一颗石子大约 5–10 毫米
  toneAsphalt: 0.6,     // 石子在颜色上的深浅起伏，1 = 原样（±20%）。水泥比沥青匀净，所以更小
  toneConcrete: 0.3,
  slopeDry: 0.75,       // 石子把表面推斜多少（干燥时）。0.75 时一颗石子的坡度大约 ±0.1，也就是 ±6°
  slopeWet: 0.28,       // 浸透 / 水膜里：水把石子缝填平了大半
  slopeConcrete: 0.6,   // 水泥面再乘这个数
  lump: 0.14,           // 半米大小的鼓包。贴地的光下它比石子显眼得多，给多了路面像被揉过
};

/** 6 米一块的路面板：板缝的位置整体挪 3 米，让缝避开主干道中线（x = −18）和码头上每 20 米一道的横线。 */
const SLAB = { size: 6, offsetX: 3, offsetZ: 3 };

/**
 * 喷涂图的范围。全场 172×200 米，要是整个盖住，2048 像素的图一个像素得有 10 厘米，字都糊了；
 * 而模板字和轮胎印只出现在两条行车走廊上。所以只存这两条窄带，并排塞进一张 1024×4096 的图里（约 5 厘米一个像素）：
 * 左边三分之一是主干道，右边三分之二是码头前沿。
 */
const PAINT = {
  width: 1024, height: 4096,
  z0: -102, zLength: 204,
  road: { x0: -27, width: 18, u0: 0, uSpan: 1 / 3 },
  quay: { x0: 26, width: 36, u0: 1 / 3, uSpan: 2 / 3 },
};

const vec3 = (c: number[]) => `vec3(${c.map((n) => n.toFixed(4)).join(', ')})`;
const float = (n: number) => n.toFixed(4);

// ================================================================ 着色器：声明和工具函数
const SHADER_HEAD = /* glsl */ `
varying vec3 vWp;
uniform float uReflTime, uRain, uWet, uReflOn, uReflLod;
uniform sampler2D uMask, uDetail, uDetailSlope, uPaint, tRefl;
uniform vec4 uMaskRect, uPaintRoad, uPaintQuay;
uniform vec2 uMaskRes, uPaintRes, uPaintZ, uReflScale;
uniform mat4 uReflM;
// 主体算出来的结果，后面几个阶段（粗糙度、法线、倒影）还要用，所以放成全局变量
float gRough; float gMetal; vec2 gSlope; float gPuddle; float gFilm; float gSoak; float gCrest;

// 不带 sin 的哈希：sin 版本在不同显卡上精度不一样，世界坐标大了以后会出条纹
vec3 gHash3(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }
float gHash1(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash1(i), gHash1(i + vec2(1.0, 0.0)), f.x), mix(gHash1(i + vec2(0.0, 1.0)), gHash1(i + vec2(1.0, 1.0)), f.x), f.y); }

// 双三次插值（B 样条）。显卡自带的双线性插值在贴图被放得很大时会露出一格一格的菱形，
// 掩码一个像素有 20 厘米，直接用的话水洼的边就是锯齿。双三次本来要读 16 个像素，
// 这里借显卡的双线性把它们两两合并，4 次采样就够。分母 g0、g1 恒大于 1/6，不会除零。
vec4 gBicubic(sampler2D t, vec2 uv, vec2 res){
  vec2 p = uv * res - 0.5; vec2 i = floor(p); vec2 f = p - i; vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i + w1 / g0 - 0.5) / res, h1 = (i + w3 / g1 + 1.5) / res;
  return (textureLod(t, vec2(h0.x, h0.y), 0.0) * g0.x + textureLod(t, vec2(h1.x, h0.y), 0.0) * g1.x) * g0.y
       + (textureLod(t, vec2(h0.x, h1.y), 0.0) * g0.x + textureLod(t, vec2(h1.x, h1.y), 0.0) * g1.x) * g1.y;
}

// 一条带子的覆盖度：d 是到带子中线的距离，halfWidth 是半宽，px 是“一个屏幕像素在这个方向上盖住多少米”。
// 算的是这个像素有多大比例落在带子里（两条边各算一次相减），所以边缘自带抗锯齿，
// 而且带子比一个像素还细时会按比例变淡，而不是闪成一截一截的虚线。
float gBand(float d, float halfWidth, float px){ return clamp((d + halfWidth) / px + 0.5, 0.0, 1.0) - clamp((d - halfWidth) / px + 0.5, 0.0, 1.0); }

// 禁停区：一个矩形框，里面画 45 度斜线。c 是中心，h 是半边长。
float gHatchBox(vec2 p, vec2 c, vec2 h, float spacing, float lineWidth, float px){
  vec2 q = abs(p - c) - h; float sd = max(q.x, q.y);
  float inside = clamp(-sd / px + 0.5, 0.0, 1.0);
  float diag = (p.x + p.y) * 0.7071;
  return max(gBand(sd, 0.075, px), gBand(mod(diag, spacing) - spacing * 0.5, lineWidth * 0.5, px) * inside);
}

// 一维的值噪声，同时返回它的导数：x = 值（0..1），y = x 每往前走 1、值变多少。seed 不同，取出来的就是互不相关的另一条曲线。
vec2 gNoise1(float x, float seed){
  float i = floor(x), f = x - i;
  float a = gHash1(vec2(i, seed)), b = gHash1(vec2(i + 1.0, seed));
  return vec2(mix(a, b, f * f * (3.0 - 2.0 * f)), (b - a) * 6.0 * f * (1.0 - f));
}

// 一块板上的一条裂缝。
// 以前裂缝是从一张平铺的噪声图里取“等高线”：画出来是一圈圈又粗又圆滑的闭合曲线，像地图上的边界线，而且每块板的花样都差不多。
// 真的裂缝是“一条线”：从板边裂进来，歪歪扭扭地走一段，要么一直裂到对边，要么越走越细、半路消失，偶尔分一个叉；它不会自己绕回来。
// 所以这里直接用式子画这条线：先把坐标转一个随机的角度，s 是顺着裂缝走的方向，t 是横着的方向；
// 裂缝的中线是 t = 三层噪声叠起来的一条曲线（大弯 2 米一个、小弯半米一个、毛刺 10 厘米一个），像素离这条曲线多远就是 |t − 曲线|。
// 曲线斜着走的地方，这个竖直量出来的距离比真正的垂直距离大，所以除以 sqrt(1 + 斜率²) 换算回来，裂缝的粗细才不随走向变。
//
// 线宽只有几毫米，离远了比一个像素还细，要按“像素有多大比例落在缝里”来淡化（gBand）。这里的“像素有多大”得顺着裂缝的垂直方向量：
// 贴着地面看过去，一个像素盖住的是一条前后很长、左右很窄的地面——迎面朝你延伸过来的裂缝其实看得很清楚，横在面前的才会被压扁。
// 一律按最长的那个方向算的话，站着看时所有裂缝都淡得看不见。
//
// q 是板内坐标（板心为原点，±3 米）；ra、rb 是这块板的六个随机数；stepX、stepY 是屏幕上往右、往下挪一个像素时地面上挪多少米。
// 返回 x = 发丝裂缝的覆盖度，y = 沿着裂缝灌的一道补缝胶的覆盖度（这条缝补没补过，由调用的地方决定），z = 裂缝两侧渗水的湿印。
vec3 gSlabCrack(vec2 q, vec3 ra, vec3 rb, vec2 stepX, vec2 stepY){
  float angle = ra.x * 6.28318;
  vec2 dir = vec2(cos(angle), sin(angle)), across = vec2(-dir.y, dir.x);
  float s = dot(q, dir);
  float t = dot(q, across) - (ra.y - 0.5) * 3.0;                    // 整条线横向挪开一点：裂缝不一定过板心
  float seed = floor(ra.z * 64.0) * 7.0;
  vec2 n1 = gNoise1(s * 0.45 + seed, 1.0), n2 = gNoise1(s * 1.9 + seed, 2.0), n3 = gNoise1(s * 9.0 + seed, 3.0);
  float off = t - (n1.x - 0.5) * 1.2 - (n2.x - 0.5) * 0.3 - (n3.x - 0.5) * 0.045;
  float lean = n1.y * 0.54 + n2.y * 0.57 + n3.y * 0.405;            // 中线的斜率 = 每层的 幅度 × 频率 × 导数
  float norm = inversesqrt(1.0 + lean * lean);                      // 1 + 斜率² 不小于 1，开方、取倒数都安全
  float d = abs(off) * norm;
  vec2 normal = (across - lean * dir) * norm;                       // 垂直于裂缝的单位向量
  float px = abs(dot(normal, stepX)) + abs(dot(normal, stepY)) + 1e-5;
  // 六成的裂缝只裂到半路：从板的一边进来，走到 stop 之前的 1.8 米里越来越细，直到消失
  float stop = rb.x < 0.6 ? mix(-1.0, 2.4, rb.y) : 9.0;
  float thick = (1.0 - smoothstep(stop - 1.8, stop, s)) * (0.5 + n2.x);  // 粗细沿途也在变（0.5–1.5 倍）
  // 四成半的裂缝在半路分一个叉：从 fork 那一点起，以斜率 k 离开主干，走 len 米后消失
  float fork = min(mix(-2.2, 0.6, rb.z), stop - 1.2);
  float along = s - fork;
  float k = (ra.z < 0.5 ? -1.0 : 1.0) * mix(0.35, 0.8, rb.y);
  float len = mix(0.7, 2.0, fract(rb.x * 7.7));
  float thickB = step(fract(rb.z * 5.3), 0.45) * step(0.0, along) * (1.0 - smoothstep(len * 0.3, len, along)) * 0.8;
  float normB = inversesqrt(1.0 + (lean + k) * (lean + k));
  float dB = abs(off - k * along) * normB;
  vec2 normalB = (across - (lean + k) * dir) * normB;
  float pxB = abs(dot(normalB, stepX)) + abs(dot(normalB, stepY)) + 1e-5;
  // 裂缝本体最宽处 7 毫米（半宽 3.5 毫米）
  float hair = max(gBand(d, 0.0035 * thick, px), gBand(dB, 0.0035 * thickB, pxB));
  // 补缝胶：顺着裂缝浇的一道沥青胶，半宽 1–2.5 厘米，宽窄不匀；裂缝的尖梢太细，不补
  float sealW = 0.010 + 0.015 * n2.x;
  float seal = max(gBand(d, sealW, px) * smoothstep(0.1, 0.5, thick), gBand(dB, sealW * 0.8, pxB) * smoothstep(0.1, 0.5, thickB));
  // 湿印：水顺着裂缝渗进去，两侧三四厘米的路面颜色更深。离远了裂缝本体看不见，靠它还能认出这里有一道缝
  float seep = max(exp(-d * d / 0.0012) * min(thick, 1.0), exp(-dB * dB / 0.0012) * min(thickB, 1.0));
  return vec3(hair, seal, seep);
}

// 所有“直线类”的标线。返回 (黄漆, 白漆) 的覆盖度。p 是世界坐标 xz，px 是 x、z 两个方向上一个像素盖住多少米。
// 这里的数字对应 port.ts 的布局：主干道中线 x=−18、边线 −25.7 / −10.3；四个路口和出生点前各一条斑马线；
// 堆位 14 米一列、31.7 米一排；岸桥轨道 x=34 / 58。
vec2 gPaintLines(vec2 p, vec2 px){
  float apx = max(px.x, px.y);
  float yellow = 0.0, white = 0.0;
  // 离哪条斑马线最近：四个路口（z = ±15.85、±47.55）加出生点前面那条（z = 86）
  float az = abs(p.y);
  float crossing = (abs(az - 15.85) < abs(az - 47.55) ? 15.85 : 47.55) * (p.y < 0.0 ? -1.0 : 1.0);
  float toJunction = abs(p.y - crossing);                 // 到最近路口中心的距离（不含 z=86 那条）
  if (abs(p.y - 86.0) < toJunction) crossing = 86.0;
  float along = p.y - crossing;                           // 带符号：正 = 在斑马线南边
  // 主干道边线（黄）：到了路口断开，给横向通道让出口子
  yellow += (gBand(p.x + 25.7, 0.08, px.x) + gBand(p.x + 10.3, 0.08, px.x)) * smoothstep(3.5, 3.7, toJunction);
  // 中线（白，实 3 米空 3 米）：斑马线前后不画
  white += gBand(p.x + 18.0, 0.09, px.x) * gBand(mod(p.y + 99.0, 6.0) - 3.0, 1.5, px.y) * smoothstep(3.3, 3.5, abs(along));
  // 斑马线：13 条 0.55 米宽的白条，每条长 4 米
  float onRoad = step(-24.9, p.x) * step(p.x, -11.1);
  white += gBand(mod(p.x + 25.15, 1.1) - 0.55, 0.275, px.x) * onRoad * gBand(along, 2.0, px.y);
  // 停车线：靠右行驶，往北开的车走东侧车道，停在斑马线南边；往南开的走西侧，停在北边
  white += gBand(along - 3.0, 0.2, px.y) * gBand(p.x + 14.15, 3.55, px.x) + gBand(along + 3.0, 0.2, px.y) * gBand(p.x + 21.85, 3.55, px.x);
  // 堆位边框（黄）：把 x、z 折叠到“离最近的堆位中心多远”，一个式子画出三十个框。朝主干道的那条边不画（那里已经有边线了）
  float colX = p.x < -18.0 ? mod(p.x + 65.0, 14.0) - 7.0 : mod(p.x + 13.0, 14.0) - 7.0;
  float inCols = (step(-65.0, p.x) * step(p.x, -26.3) + step(-9.7, p.x) * step(p.x, 29.0)) * step(az, 79.0);
  vec2 q = abs(vec2(colX, mod(p.y + 79.25, 31.7) - 15.85)) - vec2(4.15, 12.65);
  float forecourt = step(abs(p.x + 58.0), 7.0) * step(az, 15.85);   // 车间东门外的门前空场：这个格子不堆箱子，也就没有框
  yellow += gBand(max(q.x, q.y), 0.05, apx) * inCols * (1.0 - forecourt);
  // 码头：前沿警戒线、堆场边界线、每 20 米一道的横线、轨道两侧的虚线（实 1 米空 1 米）
  yellow += gBand(p.x - 60.2, 0.15, px.x) + gBand(p.x - 27.4, 0.1, px.x);
  yellow += gBand(mod(p.y + 100.0, 20.0) - 10.0, 0.08, px.y) * step(35.3, p.x) * step(p.x, 56.7);
  yellow += (gBand(abs(p.x - 34.0) - 1.3, 0.05, px.x) + gBand(abs(p.x - 58.0) - 1.3, 0.05, px.x)) * gBand(mod(p.y, 2.0) - 1.0, 0.5, px.y);
  // 禁停区：车间东门外（门在 x = −76、z ±2.5）、南卷帘门外（门在 z = 8.5、x −94…−89）、两个露天中继跟前、撤离艇的登船口
  yellow = max(yellow, gHatchBox(p, vec2(-73.7, 0.0), vec2(2.1, 3.2), 1.0, 0.12, apx));
  yellow = max(yellow, gHatchBox(p, vec2(-91.5, 10.9), vec2(3.2, 2.2), 1.0, 0.12, apx));
  yellow = max(yellow, gHatchBox(p, vec2(48.0, -8.0), vec2(3.2, 2.6), 1.1, 0.14, apx));
  yellow = max(yellow, gHatchBox(p, vec2(8.0, 0.0), vec2(2.6, 2.2), 1.0, 0.12, apx));
  yellow = max(yellow, gHatchBox(p, vec2(57.4, 90.0), vec2(2.2, 5.6), 1.2, 0.16, apx));
  float inYard = step(az, 98.6);                            // 围墙以外不画
  return clamp(vec2(yellow, white), 0.0, 1.0) * inYard;
}

// 一层雨点涟漪。把水面分成 cell 米见方的格子，每格每个周期最多落一滴雨：位置、大小、强弱每一滴都重新随机
// （哈希里带着“第几滴”），而且有相当一部分周期干脆不落——所以看上去是稀稀拉拉、此起彼伏的，不是一张规则的点阵。
// 返回 xy = 水面被推斜的方向和程度（坡度），z = 波峰的高度（给波峰描亮边用）。
// footprint 是一个屏幕像素盖住多少米：波峰最细只有 5 毫米，远一点就比一个像素还窄，硬画会闪成噪点，
// 所以把波峰至少撑到一个像素宽，同时按比例压低，远处的涟漪是慢慢糊掉而不是乱闪。
vec3 gRipple(vec2 p, float t, float cell, float seed, float footprint){
  vec2 q = p / cell + seed * 17.3; vec2 id = floor(q); vec2 f = fract(q);
  vec3 h0 = gHash3(id + seed);
  float tt = t * (0.5 + 0.55 * h0.x) + h0.y * 9.0;         // 每格自己的节奏：周期 0.95–2 秒，起始时刻各不相同
  float drop = floor(tt), life = fract(tt);                // 第几滴、这一滴扩散到什么程度了（0 刚落下，1 消失）
  vec3 h = gHash3(id + seed + drop * 7.31);
  vec3 hc = gHash3(id.yx + drop * 3.71 + seed * 5.0);
  float on = step(h.z, 0.16 + 0.5 * uRain);                // 这个周期落不落雨：雨量 0.6 时不到一半的周期有
  float rmax = mix(0.1, 0.36, h.x * h.x);                  // 这一圈最后扩到多大（以格子为单位），多数是小圈
  vec2 c = mix(vec2(rmax + 0.05), vec2(0.95 - rmax), hc.xy); // 落点。保证整圈都在格子里，就不用去查相邻的格子
  vec2 dv = (f - c) * cell; float d = length(dv);
  float r = life * rmax * cell;
  float w0 = 0.005 + 0.02 * life;                          // 波峰的宽度：5 毫米 → 25 毫米，越扩越宽越软
  float w = max(w0, footprint * 0.8);
  float x = (d - r) / w;
  float e = exp(-x * x);
  float amp = 1.0 - life; amp = amp * amp * on * mix(0.3, 1.0, h.y) * smoothstep(0.0, 0.06, life) * (w0 / w);
  // 波峰的截面是一个鼓包 e；它的坡度是 x·e（鼓包一侧朝外斜、一侧朝里斜），方向沿着半径
  return vec3((dv / max(d, 1e-4)) * x * e * 2.3 * amp, e * amp);
}
`;

// ================================================================ 着色器：主体（替换 three.js 取贴图颜色的那一段）
const SHADER_BODY = /* glsl */ `
{
  vec2 xz = vWp.xz;
  float dist = length(cameraPosition - vWp);
  vec2 stepX = dFdx(xz), stepY = dFdy(xz);                 // 屏幕上往右、往下挪一个像素，地面上的位置各挪多少米
  vec2 px = abs(stepX) + abs(stepY) + 1e-5;                // 一个屏幕像素在 x、z 方向各盖住多少米
  float apx = max(px.x, px.y);
  // 斜着看地面时，一个像素盖住的是一条细长的地面：长边 major、短边 minor（面积 ÷ 长边）。
  // footprint 取两者的几何平均，当作“这个像素大概有多大”，下面判断石子还分不分得清时用
  float major = max(length(stepX), length(stepY)) + 1e-6;
  float minor = abs(stepX.x * stepY.y - stepX.y * stepY.x) / major;
  float footprint = sqrt(major * minor);

  // ---- 掩码：R 路面高度  G 潮湿度  B 油渍  A 磨损 ----
  vec2 muv = (xz - uMaskRect.xy) * uMaskRect.zw;
  vec2 toEdge = min(muv, 1.0 - muv) / uMaskRect.zw;        // 离掩码边缘还有几米
  float inMask = smoothstep(0.0, 3.0, min(toEdge.x, toEdge.y));
  vec4 mk = vec4(0.66, 0.5, 0.0, 0.5);                     // 掩码以外的默认值：潮湿，但没有水
  if (inMask > 0.0) mk = mix(mk, gBicubic(uMask, muv, uMaskRes), inMask);

  // ---- 平铺细节：同一张图铺两种大小 ----
  vec4 d1 = texture2D(uDetail, xz * 0.21);                 // 4.76 米一铺：斑块(g) 杂点(a)
  vec2 grainUv = xz * ${float(GRAIN.tile)} + 0.37;
  vec4 d2 = texture2D(uDetail, grainUv);                   // 0.48 米一铺：石子(r) 浅色骨料(a)
  vec4 n1 = texture2D(uDetailSlope, grainUv);              // 石子的坡度
  vec4 n0 = texture2D(uDetailSlope, xz * 0.21);            // 大鼓包的坡度
  float grain = d2.r;

  // ---- 路面板：6 米一块，板缝里灌了沥青胶 ----
  vec2 sj = (xz + vec2(${float(SLAB.offsetX)}, ${float(SLAB.offsetZ)})) / ${float(SLAB.size)};
  vec2 toJoint = (0.5 - abs(fract(sj) - 0.5)) * ${float(SLAB.size)};
  float jd = min(toJoint.x, toJoint.y) + (d1.a - 0.5) * 0.035;   // 到最近板缝的距离（米），加一点抖动，缝才不是死直的
  float jaa = fwidth(jd) + 1e-5;
  float tarW = 0.022 + 0.03 * d1.g;                        // 填缝的半宽 2–5 厘米，沿缝宽窄不一
  // 后面乘的 clamp(宽度 / 像素)：缝比一个像素还窄的时候按比例淡掉，远处就不会闪
  float tar = (1.0 - smoothstep(tarW - jaa, tarW + jaa, jd)) * clamp(tarW / jaa, 0.0, 1.0);
  float groove = (1.0 - smoothstep(0.004, 0.012 + jaa, jd)) * clamp(0.02 / jaa, 0.0, 1.0);  // 填缝中间那道细槽，最先存水
  vec2 slabId = floor(sj);
  vec3 slabRand = gHash3(slabId);                          // 每块板三个随机数：x 裂不裂，y 偏亮偏暗，z 补没补过

  // ---- 沥青还是水泥：码头前沿（x > 27）和车间门前（x < −63）是水泥，中间的堆场和主干道是沥青；分界线被斑块抖得不那么直 ----
  float wobble = (d1.g - 0.5) * 0.6;
  float conc = max(smoothstep(26.6, 27.3, xz.x + wobble), 1.0 - smoothstep(-63.3, -62.6, xz.x + wobble));

  // ---- 裂缝：磨得狠的地方 + 运气不好的板才裂，一块板最多一条（外加一个分叉）；其中一部分用沥青胶补过 ----
  // “这块板裂不裂”要整块板说了算，所以磨损不能用这个像素的，得到掩码上取板心那一点的
  // （用 textureLod 指定取第 0 级：板心的坐标在板缝处是突变的，让显卡自己挑级别的话会沿着板缝出一圈杂点）
  vec2 slabCenter = (slabId + 0.5) * ${float(SLAB.size)} - vec2(${float(SLAB.offsetX)}, ${float(SLAB.offsetZ)});
  float slabWear = textureLod(uMask, (slabCenter - uMaskRect.xy) * uMaskRect.zw, 0.0).a;
  float crack = 0.0, seal = 0.0, seep = 0.0;
  if (slabWear * 0.7 + slabRand.x * 0.45 > 0.66) {
    vec3 line = gSlabCrack((fract(sj) - 0.5) * ${float(SLAB.size)}, gHash3(slabId * 1.3 + 71.0), gHash3(slabId.yx * 2.1 + 19.0), stepX, stepY);
    float sealed = step(0.72, fract(slabRand.x * 13.7));   // 裂了的板里大约三成补过
    seal = line.y * sealed;
    crack = line.x * (1.0 - seal);                         // 补过的地方裂缝被胶盖住了
    seep = line.z * (1.0 - sealed);
  }

  // ---- 修补块：沥青路面上大约七块板里有一块被挖开重铺过，留下一个矩形的补丁 ----
  // 补丁要是个个一样大、一样黑，从高处看就是一排复制出来的方块。所以让它们各不相同：
  //   形状  三成是横穿整块板的窄条（埋管线时开的沟），其余是 1–3 米见方的块；
  //   新旧  mendAge 0 = 刚补的，又黑又毛、四周一圈封边的沥青胶；1 = 补了好些年，颜色已经快和老路面一样、封边也磨没了
  vec3 mendRand = gHash3(slabId * 1.7 + 11.0);
  vec3 mendRand2 = gHash3(slabId.yx * 2.9 + 37.0);
  bool trench = mendRand2.x < 0.3;
  vec2 mendHalf = trench ? vec2(0.3 + 0.35 * mendRand.z, 4.5) : 0.5 + vec2(mendRand.z, mendRand2.y);
  if (trench && mendRand2.y < 0.5) mendHalf = mendHalf.yx; // 沟有横着开的，也有竖着开的
  vec2 pq = abs(fract(sj) * ${float(SLAB.size)} - (1.6 + mendRand.xy * 2.8)) - mendHalf;
  float mendSd = max(pq.x, pq.y) + (d1.a - 0.5) * 0.03;   // 到补丁边缘的距离：负 = 在补丁里
  float hasMend = step(0.86, slabRand.z) * (1.0 - conc);
  float mendAge = mendRand2.z;
  float mend = (1.0 - smoothstep(-apx, apx, mendSd)) * hasMend;
  tar = max(tar, gBand(mendSd, 0.018, apx) * hasMend * (1.0 - smoothstep(0.35, 0.8, mendAge)));
  crack *= 1.0 - mend; seal *= 1.0 - mend; seep *= 1.0 - mend;    // 重铺的时候裂缝一起挖掉了

  // ---- 岸桥轨道：嵌在地面里的钢轨。槽宽 ±19 厘米，中间是 ±3.7 厘米、被车轮磨亮的轨头 ----
  float inYard = step(abs(xz.y), 98.6);
  float railBed = (gBand(xz.x - 34.0, 0.19, px.x) + gBand(xz.x - 58.0, 0.19, px.x)) * inYard;
  float railHead = (gBand(xz.x - 34.0, 0.037, px.x) + gBand(xz.x - 58.0, 0.037, px.x)) * inYard;

  // ---- 底色 ----
  vec3 alb = mix(${vec3(LOOK.asphalt)}, ${vec3(LOOK.concrete)}, conc);
  float grainTone = mix(${float(GRAIN.toneAsphalt)}, ${float(GRAIN.toneConcrete)}, conc);
  alb *= (0.8 + 0.4 * slabRand.y) * (0.8 + 0.4 * d1.g) * (1.0 + (grain - 0.5) * 0.76 * grainTone);   // 三层明暗：板与板之间、斑块、石子
  alb += ${vec3(LOOK.aggregate)} * smoothstep(0.58, 0.78, d2.a) * (1.0 - conc * 0.6);
  float polish = smoothstep(0.38, 0.72, mk.a);             // 被车流磨光的车道：颜色深一点，也更亮
  alb *= mix(1.0, 0.78, polish);
  alb = mix(alb, ${vec3(LOOK.patch)} * (0.75 + 0.5 * grain), mend * mix(0.85, 0.3, mendAge));
  alb *= 1.0 - 0.18 * seep;
  alb = mix(alb, ${vec3(LOOK.tar)}, max(max(tar * 0.94, seal * mix(${float(LOOK.sealAsphalt)}, ${float(LOOK.sealConcrete)}, conc)), crack * ${float(LOOK.crackDarken)}));
  alb *= 1.0 - 0.62 * mk.b;                                // 油渍

  // ---- 喷涂图：模板字和箭头（r 黄 g 白）、轮胎橡胶（b）。两条走廊并排存在一张图里 ----
  vec4 lane = xz.x < 8.0 ? uPaintRoad : uPaintQuay;        // (走廊西边界 x, 1/宽度, 在图里的起始 u, 占多宽的 u)
  float ku = (xz.x - lane.x) * lane.y;
  vec2 kuv = vec2(lane.z + clamp(ku, 0.0, 1.0) * lane.w, (xz.y - uPaintZ.x) * uPaintZ.y);
  float kIn = step(0.0, ku) * step(ku, 1.0) * step(0.0, kuv.y) * step(kuv.y, 1.0);
  vec3 mp = texture2D(uPaint, kuv).rgb;
  float kpx = max(px.x * lane.y * lane.w * uPaintRes.x, px.y * uPaintZ.y * uPaintRes.y);   // 一个屏幕像素跨几个贴图像素
  if (kpx < 1.0) mp = mix(gBicubic(uPaint, kuv, uPaintRes).rgb, mp, smoothstep(0.5, 1.0, kpx)); // 贴图被放大时改用双三次，消掉像素格
  mp *= kIn;
  float kw = clamp(kpx * 0.5, 0.16, 0.5);                  // 漆边的软硬：凑近了看是一道利落的边

  // ---- 漆：直线用式子画，字和箭头查图；然后统一做磨损和崩口 ----
  vec2 lines = gPaintLines(xz, px);
  // 崩口用世界坐标的噪声现算（17 / 57 / 181 圈每米三层，细的两层离远了就淡掉），不依赖任何贴图的像素，凑多近都有细节
  float chipN = 0.5;
  if (max(max(mp.r, mp.g), max(lines.x, lines.y)) > 0.02) {
    float cf2 = 1.0 - smoothstep(6.0, 18.0, dist), cf3 = 1.0 - smoothstep(2.5, 7.0, dist);
    chipN = gNoise(xz * 17.0) * 0.45 + mix(0.5, gNoise(xz * 57.0 + 11.0), cf2) * 0.33 + mix(0.5, gNoise(xz * 181.0 + 5.0), cf3) * 0.22;
  }
  float chip = chipN * 0.62 + d1.a * 0.38;
  float wear = clamp(mk.a * 1.25 - 0.22 + mp.b * 0.6, 0.0, 1.0);        // 磨损掩码，被轮胎擦过的地方更狠
  float wearT = mix(0.24, 0.55, wear);                                   // 噪声低于这个值的地方漆已经掉了
  float keep = smoothstep(wearT - 0.045, wearT + 0.045, chip) * (1.0 - max(max(tar, max(crack, seal)), max(mend * mix(0.9, 0.3, mendAge), railBed)));
  float edgeN = (chipN - 0.5) * 0.55 * (1.0 - kw * 2.0);                 // 把模板字的边缘推得毛一点
  float paintY = max(lines.x, smoothstep(0.5 - kw, 0.5 + kw, mp.r + edgeN)) * keep;
  float paintW = max(lines.y, smoothstep(0.5 - kw, 0.5 + kw, mp.g + edgeN)) * keep;
  alb *= 1.0 - 0.6 * mp.b * (1.0 - 0.5 * conc);            // 轮胎橡胶印：先压暗路面，漆刷在它上面
  float fade = 0.72 + 0.28 * d1.g;
  alb = mix(alb, ${vec3(LOOK.paintYellow)} * fade, paintY * 0.94);
  alb = mix(alb, ${vec3(LOOK.paintWhite)} * fade, paintW * 0.94);
  float paint = max(paintY, paintW);
  alb = mix(alb, ${vec3(LOOK.railBed)} * (0.6 + 0.8 * grain), railBed);

  // ---- 水：一个连续的量 depth（正 = 水下，负 = 岸上）派生出全部状态 ----
  // 积水、浸透带、水膜、潮湿晕、干斑都是 depth 的不同区间，所以从镜面到干地面是一条连续的渐变，不会有“抠出来的一块”。
  // 岸线的细节：在水位比较上叠三层世界坐标的噪声（40 / 15 / 5 厘米），细的两层离远了淡掉。和掩码的分辨率无关。
  float sf2 = 1.0 - smoothstep(25.0, 60.0, dist), sf3 = 1.0 - smoothstep(8.0, 22.0, dist);
  float sn1 = gNoise(xz * 2.5 + 3.0), sn2 = mix(0.5, gNoise(xz * 6.7 + 17.0), sf2), sn3 = mix(0.5, gNoise(xz * 20.0 + 9.0), sf3);
  float sn = sn1 * 0.5 + sn2 * 0.3 + sn3 * 0.2;
  float depth = 0.5 - mk.r                                 // 掩码里的“水位 − 路面高度”，决定大形
    + (sn - 0.5) * 0.11                                    // 岸线噪声
    + (d1.g - 0.5) * 0.03 + (grain - 0.5) * 0.012          // 斑块、石子：水边一颗颗石子露头
    + groove * 0.04 + crack * 0.02 - paint * 0.01          // 板缝和裂缝里先存水；漆面略高，后淹
    + mend * (mendRand.x - 0.4) * 0.09                     // 补丁有的沉下去（存水），有的鼓起来
    + (railBed - railHead * 2.0) * 0.07;                   // 轨道槽里存水，轨头露在水面上
  float puddle = smoothstep(0.0, 0.035, depth) * uWet;     // 镜面的权重
  float deep = smoothstep(0.0, 0.22, depth);               // 水有多深：0 = 水边（看得见湿路面），1 = 一掌深
  float bandW = 0.05 + 0.15 * sn1 * sn1 + 0.05 * d1.g;     // 浸透带的宽度，沿岸线宽窄不一
  float soak = smoothstep(-bandW, 0.0, depth) * uWet;      // 浸透带：紧贴水边、吸饱水的那一圈
  float fringe = smoothstep(-0.65, -0.02, depth);          // 潮湿晕：再往外约一米
  float dryPatch = 1.0 - smoothstep(0.2, 0.42, mk.g + fringe * 0.55 + (d1.g - 0.5) * 0.25 + (sn - 0.5) * 0.12);  // 干斑：潮湿度低、又远离水的地方
  float damp = (1.0 - dryPatch) * uWet;
  // 水膜：浸透带里，石子之间的低处先连成一层薄薄的水（石子尖还露着）；板缝的细槽里也有
  float film = clamp(soak * (1.0 - smoothstep(0.35, 0.95, grain + (1.0 - soak) * 0.6)) + groove * 0.5, 0.0, 1.0) * (1.0 - paint * 0.4);
  alb *= mix(0.95, mix(0.7, ${float(LOOK.dampDarken)}, 1.0 - paint), damp);   // 受潮变深；漆面吸水少，压得轻一些
  alb *= mix(1.0, ${float(LOOK.soakDarken)}, soak);
  // 积水本身：浅处还看得见水下的路面和标线，越深越浑、越暗，并带一点点青色
  alb = mix(alb, alb * mix(0.85, 0.4, deep) + ${vec3(LOOK.waterTint)} * deep, puddle);
  alb = mix(alb, ${vec3(LOOK.railHead)}, railHead);
  diffuseColor.rgb *= max(alb, vec3(0.0));

  // ---- 粗糙度：干 0.74 → 潮 0.42 → 浸透 0.2 → 水膜 0.13 → 水 0.055，每一段都是平滑过渡 ----
  float rough = mix(0.74, 0.42, damp) + (grain - 0.5) * 0.24 + (d1.g - 0.5) * 0.16 + conc * 0.03 - paint * 0.05;
  rough -= polish * 0.07 + mk.b * 0.16 + max(tar, seal) * 0.1 - mend * 0.05 * (1.0 - mendAge);   // 磨光的车道、油渍、沥青胶更亮；新补的沥青更毛
  rough = mix(rough, 0.2 + (grain - 0.5) * 0.14, soak * 0.9);
  rough = mix(rough, 0.13, film * 0.8);
  rough += smoothstep(10.0, 80.0, dist) * 0.04;            // 远处略糙一点，压住闪烁
  rough = mix(clamp(rough, 0.1, 1.0), 0.055, puddle);
  rough = mix(rough, 0.3, railHead);

  // ---- 法线（用世界坐标的坡度表示）：水外是石子和鼓包，水里抹平、换成涟漪和微波 ----
  // 石子的坡度只在“分得清石子”的距离内用：一个像素比石子还大以后（约 3 米外开始，10 米外完全），
  // 硬用只会让每个像素随机朝一个方向反光，太阳和路灯的高光就碎成一片乱闪的亮点。
  // 淡掉的那部分凹凸并没有消失——它在现实里的效果是“这块表面更毛”，所以折算成粗糙度加回去（见下面的 sparkle）
  float grainKeep = 1.0 - smoothstep(0.004, 0.03, footprint);
  float grainAmount = mix(${float(GRAIN.slopeDry)}, ${float(GRAIN.slopeWet)}, max(film, soak * 0.6)) * mix(1.0, ${float(GRAIN.slopeConcrete)}, conc);
  vec2 slope = (n1.rg - 0.5) * grainAmount * grainKeep + (n0.ba - 0.5) * ${float(GRAIN.lump)};
  // 高光抗闪烁：相邻两个像素的朝向差得越多，说明这个像素内部的朝向越乱，它反射的就不是一个方向而是一小片 ——
  // 这等价于更粗糙。把“朝向差的平方”加到粗糙度（的四次方，three.js 的粗糙度要平方两次才是物理上的那个量）上，封顶 0.18
  vec2 slopeDx = dFdx(slope), slopeDy = dFdy(slope);
  float sparkle = min(0.5 * (dot(slopeDx, slopeDx) + dot(slopeDy, slopeDy)), 0.18);
  float lostSlope = grainAmount * 0.16;                    // 石子坡度的典型大小（坡度图的均方根约 0.16）
  sparkle += (1.0 - grainKeep) * 2.0 * lostSlope * lostSlope;
  sparkle *= 1.0 - puddle;                                 // 水面是平的，涟漪另有自己的处理
  slope *= 1.0 - puddle;
  float water = puddle + film * 0.2;                       // 水膜上也有两成涟漪
  float crest = 0.0;
  // 微波：把大鼓包的坡度图朝两个方向慢慢滚动，水面永远有一点起伏。
  // 这两次取贴图要放在下面的 if 外面：显卡靠“和相邻像素比一比”来决定用贴图的哪一级，
  // 放进 if 里，水洼边上那些“邻居没进 if”的像素就比不出来，会沿着岸线出一圈杂点
  vec2 wv = texture2D(uDetailSlope, xz * 0.13 + uReflTime * vec2(0.031, 0.017)).ba - 0.5;
  vec2 wv2 = texture2D(uDetailSlope, xz.yx * 0.31 - uReflTime * vec2(0.043, 0.027)).ba - 0.5;
  if (water > 0.004) {
    // 雨点涟漪：10 米内全强度，34 米外没有。三层格子大小互不成倍数（0.83 / 1.31 / 0.57 米），
    // 第二层把坐标转了 37 度、第三层把 x 和 z 对调，叠在一起就看不出格子
    float nearFade = 1.0 - smoothstep(10.0, 34.0, dist);
    vec3 rip = vec3(0.0);
    if (nearFade > 0.0) {
      vec2 turned = vec2(0.8 * xz.x - 0.6 * xz.y, 0.6 * xz.x + 0.8 * xz.y);
      vec3 r1 = gRipple(xz, uReflTime, 0.83, 1.0, apx);
      vec3 r2 = gRipple(turned, uReflTime * 0.87, 1.31, 2.0, apx);
      vec3 r3 = gRipple(xz.yx, uReflTime * 1.13, 0.57, 3.0, apx);
      rip = r1 + vec3(0.8 * r2.x + 0.6 * r2.y, -0.6 * r2.x + 0.8 * r2.y, r2.z) * 0.9 + vec3(r3.yx, r3.z) * 0.6;
      rip *= nearFade * (0.3 + 0.7 * uRain) * smoothstep(0.0, 0.08, depth);     // 岸边水太浅，涟漪起不来
    }
    slope += (rip.xy * 0.3 + (wv * 0.03 + wv2 * 0.018) * (0.4 + 0.6 * deep)) * water;
    crest = rip.z * water;
    rough += (1.0 - nearFade) * 0.03 * puddle * uRain;     // 远处画不出涟漪，就让水面略糊一点来代替：远处的水洼不是一面死镜子
  }
  float rough2 = rough * rough;
  rough = sqrt(sqrt(rough2 * rough2 + sparkle));           // 四次方里加，再开回来；两个量都不小于 0
  gRough = rough; gMetal = railHead; gSlope = slope; gPuddle = puddle; gFilm = film; gSoak = soak; gCrest = crest;
}
`;

// ================================================================ 着色器：倒影（接在 three.js 取完环境反射之后）
// three.js 这时刚把“朝反射方向看到的天空”存进变量 radiance。我们用平面反射的画面把它替换掉，
// 之后 three.js 自己的光照公式（菲涅耳：越斜着看反射越强；粗糙度：越糙反射越弱）照常作用在上面。
// 以前的做法是等光照全算完再直接改最终结果、自己乘一个菲涅耳，等于绕开了粗糙度，潮湿的沥青也亮得像镜子。
const SHADER_REFLECT = /* glsl */ `
if (uReflOn > 0.5) {
  vec3 toEye = normalize(cameraPosition - vWp);
  vec4 rc = uReflM * vec4(vWp.x, 0.0, vWp.z, 1.0);         // 这个像素在倒影画面里的位置
  vec2 ruv = rc.xy / max(rc.w, 1e-4);
  // 水面不平，倒影就跟着晃：把坡度拆成“顺着视线”和“横着视线”两个分量去推采样位置。
  // 水里推得最多，干地面只有 3%；离得越远推得越少；斜着看时横向的晃动本来就小（sinE）；最后限幅，免得推出画面
  vec2 fwd = normalize(-toEye.xz + vec2(1e-5)); vec2 side = vec2(-fwd.y, fwd.x);
  float sinE = clamp(toEye.y, 0.03, 1.0);
  float push = (gPuddle + gFilm * 0.15 + 0.03) / (1.0 + length(cameraPosition - vWp) * 0.07);
  vec2 tilt = clamp(vec2(dot(gSlope, side) * sinE, dot(gSlope, fwd)) * push, vec2(-0.12), vec2(0.12));
  ruv += tilt * uReflScale;
  float r = material.roughness;
  // 取倒影贴图的哪一级模糊：
  //   水洼 —— 清晰，但留一点点软，不要锐利得像刀切
  //   潮湿路面 —— 很糊，只在贴着地面看时收紧一点：看上去是一层光泽，而不是第二面镜子
  //   浸透带 —— 介于两者之间
  // uReflLod 把模糊程度折算到“倒影贴图 270 行高”：换画质档位、贴图变大变小，看到的模糊程度不变
  float graze = pow(1.0 - clamp(toEye.y, 0.0, 1.0), 5.0);
  float lodPuddle = clamp(r * 9.5 - 0.45, 0.0, 6.5) + 0.9;
  float lodDamp = clamp(3.0 + r * 6.5 - 3.4 * graze, 2.0, 7.5);
  float lod = max(mix(mix(lodDamp, min(lodDamp, 2.6 + r * 5.0), gSoak), lodPuddle, gPuddle) + uReflLod, 0.0);
  // 粗糙表面上的倒影是竖着拖长的（想想湿马路上的车灯）：上下错开再采两次
  vec2 stretch = vec2(0.0, r * 0.11 + (1.0 - gPuddle) * 0.05);
  vec2 lo = vec2(0.002), hi = vec2(0.998);
  vec3 mirror = textureLod(tRefl, clamp(ruv, lo, hi), lod).rgb * 0.5
              + textureLod(tRefl, clamp(ruv + stretch, lo, hi), lod + 0.6).rgb * 0.25
              + textureLod(tRefl, clamp(ruv - stretch * 0.6, lo, hi), lod + 0.6).rgb * 0.25;
  mirror = clamp(mirror, vec3(0.0), vec3(mix(${float(LOOK.dampReflectionMax)}, ${float(LOOK.reflectionMax)}, gPuddle)));
  // 水和浸透带全用倒影；其余按粗糙度：0.55 以下全用，0.9 以上不用（太糙的表面映不出东西）
  float weight = mix(1.0 - smoothstep(0.55, 0.9, r), 1.0, max(gPuddle, gSoak));
  radiance = mix(radiance, mirror, weight);
}
`;

// ================================================================ 喷涂图：模板字、箭头、轮胎印
function buildPaintTexture() {
  const { width, height, z0, zLength, road, quay } = PAINT;
  const YELLOW = '#ff0000', WHITE = '#00ff00';             // 红通道存黄漆，绿通道存白漆（见 groundPaintTexture）
  return groundPaintTexture(width, height, (g) => {
    const rng = mulberry32(90210), rand = (a: number, b: number) => a + rng() * (b - a);
    /** 把画布坐标换成“世界米”，并把画的范围限制在这条走廊自己的那一块里。 */
    const enter = (strip: typeof road) => {
      const sx = (width * strip.uSpan) / strip.width, sz = height / zLength;
      g.save();
      g.beginPath(); g.rect(width * strip.u0, 0, width * strip.uSpan, height); g.clip();
      g.transform(sx, 0, 0, sz, width * strip.u0 - strip.x0 * sx, -z0 * sz);
    };
    /** 行车箭头。dir = −1 指北（−z），+1 指南。 */
    const arrow = (x: number, z: number, dir: number) => {
      g.save(); g.translate(x, z); g.scale(1.5, 1.5 * dir); g.fillStyle = WHITE;
      g.beginPath(); g.moveTo(-0.14, -1.6); g.lineTo(-0.14, 0.5); g.lineTo(-0.5, 0.5); g.lineTo(0, 1.7); g.lineTo(0.5, 0.5); g.lineTo(0.14, 0.5); g.lineTo(0.14, -1.6); g.closePath(); g.fill();
      g.restore();
    };
    /** 一辆车留下的一组轮胎印：左右两排轮子，每排是并在一起的双胎，所以是四条线。从 (x, z) 到 (x2, z2)，中间略带弧度。 */
    const tyres = (x: number, z: number, x2: number, z2: number, bend: number, alpha: number) => {
      g.strokeStyle = `rgba(0,0,255,${alpha})`; g.lineWidth = 0.26; g.lineCap = 'round';
      for (const wheel of [-0.95, 0.95]) for (const twin of [-0.16, 0.16]) {
        g.beginPath(); g.moveTo(x + wheel + twin, z); g.quadraticCurveTo((x + x2) / 2 + bend + wheel + twin, (z + z2) / 2, x2 + wheel + twin, z2); g.stroke();
      }
    };
    /** 一条轮胎擦痕（急刹、原地打方向留下的）。 */
    const scuff = (x: number, z: number, x2: number, z2: number, widthM: number, alpha: number, cx?: number, cz?: number) => {
      g.strokeStyle = `rgba(0,0,255,${alpha})`; g.lineWidth = widthM; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, z);
      if (cx === undefined || cz === undefined) g.lineTo(x2, z2); else g.quadraticCurveTo(cx, cz, x2, z2);
      g.stroke();
    };

    // ---------------- 主干道（x −27…−9）。靠右行驶：东侧车道（x = −14.15）往北，西侧（−21.85）往南
    enter(road);
    for (const z of [74, 37, -27, -76]) arrow(-14.15, z, -1);
    for (const z of [61, 8, -22, -61]) arrow(-21.85, z, 1);
    // 路口前的“慢”和限速圈。字头朝着车来的方向的远端，司机开过来看是正的
    stencilText(g, '慢', -14.15, 56.6, 2.6, 0, WHITE);
    stencilText(g, '慢', -21.85, -56.6, 2.6, Math.PI, WHITE);
    for (const [x, z, rot] of [[-14.15, 25, 0], [-21.85, -8.2, Math.PI], [-14.15, -38.5, 0], [-21.85, 40.2, Math.PI]] as const) {
      stencilText(g, '10', x, z, 1.9, rot, WHITE);
      g.strokeStyle = WHITE; g.lineWidth = 0.16; g.beginPath(); g.ellipse(x, z, 1.45, 1.95, 0, 0, Math.PI * 2); g.stroke();
    }
    // 轮胎印：顺着车道的长拖痕
    for (let i = 0; i < 64; i++) {
      const lane = rng() < 0.55 ? -21.85 : -14.15, x = lane + rand(-1.3, 1.3), z = rand(-94, 70), len = rand(8, 34);
      tyres(x, z, Math.max(-24.4, Math.min(-11.6, x + rand(-0.8, 0.8))), Math.min(z + len, 95), rand(-0.7, 0.7), rand(0.1, 0.32));
    }
    // 路口：拐进横向通道的弧形擦痕
    for (const cz of [-47.55, -15.85, 15.85, 47.55]) for (let i = 0; i < 4; i++) {
      const lane = rng() < 0.5 ? -21.85 : -14.15, out = rng() < 0.5 ? -26.2 : -9.8, from = cz + (rng() < 0.5 ? -1 : 1) * rand(5, 11);
      scuff(lane + rand(-1, 1), from, out, cz + rand(-2, 2), 0.3, rand(0.12, 0.32), lane + rand(-0.5, 0.5), cz + rand(-1, 1));
    }
    for (let i = 0; i < 46; i++) {
      const x = rand(-25, -11), z = rand(-95, 95), len = rand(0.6, 3.1), a = Math.PI / 2 + rand(-0.25, 0.25);
      scuff(x, z, x + Math.cos(a) * len, z + Math.sin(a) * len, rand(0.12, 0.32), rand(0.15, 0.45));
    }
    g.restore();

    // ---------------- 码头前沿（x 26…62）
    enter(quay);
    // 泊位号：字的底边朝西，从堆场那边走过来看是正的
    stencilText(g, 'B4', 46, 50, 3.6, Math.PI / 2, YELLOW);
    stencilText(g, 'B4', 46, -60, 3.6, Math.PI / 2, YELLOW);
    stencilText(g, '四号泊位', 44.5, 81, 2.0, Math.PI / 2, WHITE);
    stencilText(g, '四号泊位', 44.5, -81, 2.0, Math.PI / 2, WHITE);
    for (const cz of [-42, 20]) stencilText(g, '请勿靠近', 36.3, cz, 0.95, Math.PI / 2, YELLOW);   // 两台岸桥的门腿之间
    // 泊位里程：每 20 米一个数，喷在前沿警戒线内侧
    for (let z = -80, n = 0; z <= 80; z += 20, n++) stencilText(g, String(400 + n * 5), 56, z + 2.2, 0.9, Math.PI / 2, WHITE);
    for (let i = 0; i < 44; i++) {
      const lane = rng() < 0.5 ? 41 : 51, x = lane + rand(-1.6, 1.6), z = rand(-94, 70), len = rand(8, 30);
      tyres(x, z, x + rand(-1, 1), Math.min(z + len, 95), rand(-0.8, 0.8), rand(0.1, 0.3));
    }
    // 从堆场的横向通道拐上码头的弧形擦痕
    for (const cz of [-47.55, -15.85, 15.85, 47.55]) for (let i = 0; i < 3; i++) {
      const lane = rng() < 0.5 ? 41 : 51, dir = rng() < 0.5 ? -1 : 1;
      scuff(27, cz + rand(-2, 2), lane + rand(-1, 1), cz + dir * rand(8, 16), 0.3, rand(0.12, 0.3), lane - rand(2, 5), cz + rand(-1, 1));
    }
    for (let i = 0; i < 50; i++) {
      const x = rand(29, 59), z = rand(-95, 95), len = rand(0.6, 3.1), a = Math.PI / 2 + rand(-0.4, 0.4);
      scuff(x, z, x + Math.cos(a) * len, z + Math.sin(a) * len, rand(0.12, 0.32), rand(0.15, 0.45));
    }
    g.restore();
  });
}

// ================================================================ 组装
export function buildGround(quayX: number) {
  const group = new THREE.Group();

  const mask = bakeGroundMask(quayX);
  const detail = groundDetailTextures();
  const paint = buildPaintTexture();
  const reflection = reflectionUniforms();
  const uniforms = {
    uMask: { value: mask.texture },
    uMaskRect: { value: new THREE.Vector4(mask.rect.x0, mask.rect.z0, 1 / mask.rect.w, 1 / mask.rect.h) },
    uMaskRes: { value: new THREE.Vector2(mask.res, mask.res) },
    uDetail: { value: detail.detail },
    uDetailSlope: { value: detail.slope },
    uPaint: { value: paint },
    uPaintRes: { value: new THREE.Vector2(PAINT.width, PAINT.height) },
    uPaintRoad: { value: new THREE.Vector4(PAINT.road.x0, 1 / PAINT.road.width, PAINT.road.u0, PAINT.road.uSpan) },
    uPaintQuay: { value: new THREE.Vector4(PAINT.quay.x0, 1 / PAINT.quay.width, PAINT.quay.u0, PAINT.quay.uSpan) },
    uPaintZ: { value: new THREE.Vector2(PAINT.z0, 1 / PAINT.zLength) },
    /** 雨量 0..1：决定涟漪有多密、多强。 */
    uRain: { value: 0.6 },
    /** 全局湿度 0..1：1 是正在下雨的样子，往 0 调地面逐渐变干、水洼消失。和材质库共用同一个对象，全场的湿度一起变。 */
    uWet: wetness,
    /** 把“水面斜了多少”换算成倒影贴图上挪多远；跟相机的视角有关，每帧更新。 */
    uReflScale: { value: new THREE.Vector2(0.5, 0.5) },
    /** 倒影贴图的行数相对 270 行的对数：让模糊程度不随贴图分辨率变。 */
    uReflLod: { value: 0 },
  };

  // 底子是一个纯白、全粗糙的标准材质：颜色、粗糙度、法线都由下面注入的着色器按世界坐标现算
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: LOOK.envMapIntensity });
  groundMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, reflection, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SHADER_HEAD)
      .replace('#include <map_fragment>', SHADER_BODY)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      // 法线直接由世界坐标的坡度拼出来：地面是水平的，“朝上”再往坡度的反方向歪一点就是了，用不着切线空间
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mat3(viewMatrix) * normalize(vec3(-gSlope.x, 1.0, -gSlope.y)));')
      // 水面比沥青更“反光”：正对着看时的反射率从默认的 4% 提上去
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\nmaterial.specularColor = mix(material.specularColor, vec3(${float(LOOK.waterF0)}), max(gPuddle, gSoak * 0.5) * (1.0 - gMetal));`)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n' + SHADER_REFLECT)
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
        // 高光的软封顶：cap / (cap + 亮度) 在亮度远小于 cap 时约等于 1（不动），亮度很大时把结果压到接近 cap。
        // 三个通道乘同一个数，所以只压亮度、不改颜色：太阳的高光压完还是金色的。分母不小于 cap，不会除零
        float specCap = mix(${float(LOOK.dampSpecularMax)}, ${float(LOOK.sunSpecularMax)}, gPuddle);
        vec3 spec = max(reflectedLight.directSpecular, vec3(0.0));
        reflectedLight.directSpecular = spec * (specCap / (specCap + max(spec.r, max(spec.g, spec.b))));
        // 涟漪波峰映着天光的一道亮边。必须放在这里——倒影已经替换完、光照也结算完之后——再加：
        // 加早了会被倒影整个盖掉，那样涟漪只有在灯的倒影里才看得出来，暗处的水塘就像没在下雨
        reflectedLight.indirectSpecular += gCrest * (irradiance + iblIrradiance) * ${float(LOOK.crestSkyGain)};`);
  };
  groundMat.customProgramCacheKey = () => 'wet-ground-6';

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(462, 600), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(quayX - 231, 0, 0);
  ground.receiveShadow = true;
  // 每次画地面之前，按当前相机更新两个和倒影有关的数（reflection.ts 不提供它们，所以在这里自己算）
  ground.onBeforeRender = (_renderer, _scene, camera) => {
    const p = camera.projectionMatrix.elements;
    uniforms.uReflScale.value.set(p[0] * 0.5, p[5] * 0.5);
    const image = reflection.tRefl.value?.image as { height?: number } | undefined;
    uniforms.uReflLod.value = Math.log2(Math.max(image?.height ?? 270, 1) / 270);
  };
  group.add(ground);

  return { mesh: ground, group, reflection, uniforms, mask, puddleDepthAt, isPuddleAt };
}
