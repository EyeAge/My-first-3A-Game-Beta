import * as THREE from 'three';
import { HORIZON_GLSL, NOISE_GLSL, SKY, skyNoiseTexture, SUN_COLOR, SUN_DIR, SUN_INTENSITY } from '../world/atmosphere';

// 后处理链：场景画完以后，对整张画面再做的一连串加工。
//
// 这个游戏的"环境光照"不是靠往场景里堆灯做出来的 —— 全场真正的灯只有一盏太阳。
// 空气感、明暗层次、灯的光晕，都是在这里对画面本身做出来的：
//
//   场景（线性 HDR，带深度）
//     → 半分辨率深度
//     → 环境光遮蔽：墙角、缝隙、物体挨着地面的地方压暗一点
//     → 体积光：沿着视线一步步走，每一步问"这里的空气被太阳照到了吗"，照到的发亮 —— 于是有了光柱和雾
//     → 合成
//     → 泛光：亮的东西往外晕开（不设门槛，按固定比例混，暗处不会发灰）
//     → 自动曝光：像眼睛一样，暗处久了画面提亮，看向太阳画面压暗
//     → 调色：色调映射（把 HDR 压进屏幕能显示的范围）、冷暖分离、暗角……
//     → 抗锯齿、锐化、胶片颗粒 → 屏幕
//
// 每一步是一个"全屏三角形 + 一段片元着色器"，结果写进一张贴图，交给下一步。

export interface PostQuality {
  /** 多重采样抗锯齿的采样数，0 是关。 */
  msaa: number;
  /** 环境光遮蔽的采样数，0 是关。 */
  ao: number;
  /** 体积光每条视线走几步，0 是关（关了就没有雾和光柱）。 */
  volSteps: number;
  bloom: boolean;
}
/** 每帧由游戏逻辑喂进来的量。 */
export interface PostFrame {
  dt: number; time: number;
  /** 刚挨打的一下：画面边缘泛红、色差变大。 */
  damage: number;
  /** 血量低：边缘压暗、褪色。 */
  lowHealth: number;
  /** 开镜程度 0..1：边缘虚化、暗角收紧。 */
  ads: number;
  /** 整体变黑的程度（开场、阵亡、通关）。 */
  fade: number;
  saturation: number;
  /** 闪电的亮度 0..1。 */
  flash: number;
  /** 室内范围：这个盒子里的空气更"脏"，光柱更实。没有就传 null。 */
  interior: THREE.Box3 | null;
}

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const COMMON = /* glsl */ `
varying vec2 vUv;
// 每个像素一个固定的"随机数"，相邻像素差别很大：用来把采样的条带瑕疵打散成细噪点
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;
// 曝光：tAdapt 是一张 1×1 的贴图，r 里存着"最近一段时间画面的平均亮度"。画面越亮，曝光越低
const EXPOSURE = /* glsl */ `
uniform sampler2D tAdapt; uniform float uExposure, uKey, uMinE, uMaxE, uAuto;
float slExposure(){ float a = texture2D(tAdapt, vec2(0.5)).r; return uExposure * mix(1.0, clamp(pow(uKey / max(a, 1e-4), 0.85), uMinE, uMaxE), uAuto); }`;

const DEPTH_HALF = /* glsl */ `${COMMON}
uniform sampler2D tDepth; uniform float uNear, uFar;
void main(){
  // 精确取某一个像素，而不是在四个像素中间采样：否则贴地看的时候会取到不确定的一行，遮蔽上出现条纹
  ivec2 p = min(ivec2(gl_FragCoord.xy) * 2, textureSize(tDepth, 0) - 1);
  float d = texelFetch(tDepth, p, 0).r;
  float z = (uNear * uFar) / (uFar - d * (uFar - uNear));     // 深度缓冲里的值 → 离相机多少米
  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}`;

const AO = /* glsl */ `${COMMON}
uniform sampler2D tDepthHalf; uniform vec2 uTanHalf, uTexel; uniform float uRadius, uIntensity, uAspect;
vec3 vpos(vec2 uv, float z){ return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }   // 屏幕位置 + 深度 → 相机空间里的位置
void main(){
  float z0 = texture2D(tDepthHalf, vUv).r;
  if (z0 < 0.02 || z0 > 140.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = vpos(vUv, z0);
  // 没有法线缓冲，就用相邻像素的位置差叉乘出法线；每个方向挑深度更接近的那一侧，免得跨过物体边缘
  vec2 ox = vec2(uTexel.x, 0.0), oy = vec2(0.0, uTexel.y);
  float zl = texture2D(tDepthHalf, vUv - ox).r, zr = texture2D(tDepthHalf, vUv + ox).r;
  float zd = texture2D(tDepthHalf, vUv - oy).r, zu = texture2D(tDepthHalf, vUv + oy).r;
  vec3 dx = abs(zl - z0) < abs(zr - z0) ? P - vpos(vUv - ox, zl) : vpos(vUv + ox, zr) - P;
  vec3 dy = abs(zd - z0) < abs(zu - z0) ? P - vpos(vUv - oy, zd) : vpos(vUv + oy, zu) - P;
  vec3 n = normalize(cross(dx, dy) + vec3(0.0, 0.0, 1e-9));
  float R = uRadius * (0.6 + 0.4 * clamp(z0 / 12.0, 0.0, 1.0));
  float rUv = clamp(R / (2.0 * z0 * uTanHalf.y), 3.0 * uTexel.y, 0.14);
  float R2 = R * R;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  float sum = 0.0;
  // 沿一条绕三圈的螺旋线取样：周围有东西高出这个点所在的平面、而且离得近，就算被遮住了一点
  for (int i = 0; i < AO_TAPS; i++) {
    float a = (float(i) + 0.5) / float(AO_TAPS);
    float th = a * 6.2831853 * 3.0 + rot;
    vec2 o = vec2(cos(th), sin(th)) * a * rUv; o.x /= uAspect;
    vec2 uv2 = vUv + o;
    float z2 = texture2D(tDepthHalf, uv2).r;
    vec3 v = vpos(uv2, z2) - P;
    float vv = dot(v, v), vn = dot(v, n);
    float f = max(R2 - vv, 0.0);
    sum += f * f * f * max((vn - (0.015 + 0.004 * z0)) / (vv + 0.004), 0.0);
  }
  float ao = max(0.0, 1.0 - uIntensity * sum * 5.0 / (R2 * R2 * R2 * float(AO_TAPS)));
  ao = mix(ao, 1.0, smoothstep(70.0, 140.0, z0));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

// 保边模糊：只和"深度差不多"的邻居平均，这样模糊不会越过物体的轮廓。遮蔽和体积光都要过它（横一趟、竖一趟）
const BLUR = /* glsl */ `${COMMON}
uniform sampler2D tSrc, tDepthHalf; uniform vec2 uDir;
void main(){
  float z0 = texture2D(tDepthHalf, vUv).r;
  float zc = min(z0, 300.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float z = min(texture2D(tDepthHalf, uv).r, 300.0);
    float w = (1.0 - abs(float(i)) * 0.22) * max(0.0, 1.0 - abs(z - zc) / (BLUR_TOL * zc + 0.02));
    acc += texture2D(tSrc, uv) * w; ws += w;
  }
  gl_FragColor = ws > 1e-4 ? acc / ws : texture2D(tSrc, vUv);
}`;

const VOL = /* glsl */ `${COMMON}
uniform sampler2D tDepthHalf, tShadow;
uniform mat4 uShadowMatrix, uCamWorld;
uniform vec3 uCamPos, uSunRad, uAmb;
uniform vec2 uTanHalf;
uniform float uHasShadow, uMaxDist, uSigma, uFarZ, uFarHaze, uBoxDust;
uniform vec3 uBoxMin, uBoxMax;
${HORIZON_GLSL}
// 空气的浓度随高度变化：贴地最浓，往上按 5.5 米的"标高"变稀，高空保留三成
float shape(float h){ return 0.30 + 0.70 * exp(-max(h, 0.0) / 5.5); }
// 相函数：光打在水汽上，朝各个方向散开多少。g 越大越"只往前散"（所以朝着太阳看最亮）
float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
// 空间里的这一点能不能看见太阳：去查太阳的阴影图
float sunVis(vec3 p){
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) return 1.0;
  float d = dot(texture2D(tShadow, sc.xy), vec4(0.99609375, 0.99609375 / 256.0, 0.99609375 / 65536.0, 1.0 / 16777216.0));
  return step(sc.z - 0.0006, d);
}
void main(){
  float z = texture2D(tDepthHalf, vUv).r;
  vec3 vd = vec3((vUv * 2.0 - 1.0) * uTanHalf, -1.0);
  float rl = length(vd);
  vec3 rd = normalize(mat3(uCamWorld) * vd);
  float dist = z * rl;
  bool isSky = z > uFarZ * 0.97;
  float maxD = min(dist, isSky ? uMaxDist * 0.55 : uMaxDist);
  float mu = dot(rd, uSunDir);
  // 两个叶瓣：一个很窄的往前散（朝太阳看时的金色辉光），一个宽的（侧着看光柱也还看得见）
  float ph = min(hg(mu, 0.78) * 0.55 + hg(mu, 0.25) * 0.45, 1.15);
  float j = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0); float T = 1.0; float tPrev = 0.0;
  for (int i = 0; i < VOL_STEPS; i++) {
    float f = (float(i) + 1.0) / float(VOL_STEPS);
    float t1 = maxD * f * (0.35 + 0.65 * f);              // 近处步子小、远处步子大
    float ds = t1 - tPrev;
    vec3 p = uCamPos + rd * (tPrev + ds * j);             // 每个像素的起点错开一点，层与层之间的台阶就变成噪点
    float sh = uHasShadow > 0.5 ? sunVis(p) : 1.0;
    // 室内（车间）：空气里灰尘多，所以从门、百叶、屋顶破洞射进来的阳光看得见形状；天光则几乎进不来
    vec3 bq = step(uBoxMin, p) * step(p, uBoxMax); float inb = bq.x * bq.y * bq.z;
    float ext = uSigma * shape(p.y) * (1.0 + uBoxDust * inb);
    float Ti = exp(-ext * ds);
    // 美术上的修正：离眼睛近的光柱更亮（箱垛之间的那几道），远处只是一层克制的薄纱
    float nearW = mix(2.3, 0.55, smoothstep(4.0, 85.0, tPrev + ds * j));
    vec3 src = uSunRad * (ph * sh * mix(nearW, 1.6, inb)) + uAmb * (0.40 + 0.60 * sh) * mix(1.0, 0.22, inb);
    acc += T * src * (1.0 - Ti);
    T *= Ti; tPrev = t1;
  }
  // 更远的东西（货轮、起重机）不再一步步走，直接按距离算一个总的雾化，融进那个方向的地平线颜色
  if (!isSky && dist > uMaxDist) {
    float h1 = uCamPos.y + rd.y * uMaxDist, h2 = uCamPos.y + rd.y * dist;
    float tau = uSigma * uFarHaze * (dist - uMaxDist) * 0.5 * (shape(h1) + shape(h2));
    float Tf = exp(-tau);
    vec3 hc = horizonColor(rd) * 0.50 + uAmb * 0.6;
    acc += T * hc * (1.0 - Tf);
    T *= Tf;
  }
  gl_FragColor = vec4(acc, T);   // rgb = 散射进视线的光，a = 背后的东西还剩多少透过来
}`;

const COMPOSITE = /* glsl */ `${COMMON}
uniform sampler2D tColor, tDepth, tDepthHalf, tAO, tVol;
uniform vec2 uHalfRes; uniform float uNear, uFar, uAoOn, uVolOn, uAoStrength;
${EXPOSURE}
void main(){
  vec3 col = texture2D(tColor, vUv).rgb;
  // 保险丝：任何一个着色器算出"非数"或负数，后面的泛光都会把它扩散成一大片黑块。在这里掐掉
  bvec3 bad = bvec3(!(col.r >= 0.0), !(col.g >= 0.0), !(col.b >= 0.0));
  col = min(mix(col, vec3(0.0), vec3(bad)), vec3(400.0));
  float d = texture2D(tDepth, vUv).r;
  float z = (uNear * uFar) / (uFar - d * (uFar - uNear));
  // 遮蔽和体积光是半分辨率算的。放大回来时，四个邻居里只相信"深度和我差不多"的，物体边缘才不会糊出一圈
  vec2 hp = vUv * uHalfRes - 0.5; vec2 f = fract(hp); vec2 base = (floor(hp) + 0.5) / uHalfRes; vec2 tx = 1.0 / uHalfRes;
  float ao = 0.0; vec4 vol = vec4(0.0); float ws = 0.0;
  float zc = min(z, 300.0);
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1));
    vec2 uv = base + o * tx;
    float zh = min(texture2D(tDepthHalf, uv).r, 300.0);
    float w = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
    w *= 1.0 / (0.015 + abs(zh - zc) / zc);
    w = max(w, 1e-5);
    ao += texture2D(tAO, uv).r * w; vol += texture2D(tVol, uv) * w; ws += w;
  }
  ao /= ws; vol /= ws;
  if (uAoOn > 0.5 && d < 0.99999) {
    // 遮蔽挡的是天光，不是太阳：被太阳照亮的地方几乎不压暗，不然亮面上会有一圈圈脏印
    float lit = smoothstep(0.16, 0.85, luma(col) * slExposure());
    float a = mix(1.0, ao, uAoStrength * (1.0 - 0.8 * lit));
    col *= mix(vec3(a), vec3(1.0), vec3(0.0, 0.03, 0.07));      // 被遮住的地方略微偏冷
  }
  if (uVolOn > 0.5) col = col * vol.a + vol.rgb;
  gl_FragColor = vec4(col, 1.0);
}`;

const DOWN = /* glsl */ `${COMMON}
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst;
vec3 s(vec2 o){ return min(max(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(0.0)), vec3(400.0)); }
float kw(vec3 c){ return 1.0 / (1.0 + luma(c) * 0.08); }
void main(){
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uFirst > 0.5) {
    // 第一次缩小时，特别亮的小点权重降低：一颗孤零零的亮像素不该被放大成一大团闪烁的光斑
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UP = /* glsl */ `${COMMON}
uniform sampler2D tLow, tHigh; uniform vec2 uTexel; uniform float uMix;
void main(){
  vec2 o = uTexel;
  vec3 t = texture2D(tLow, vUv).rgb * 4.0;
  t += (texture2D(tLow, vUv + vec2(o.x, 0.0)).rgb + texture2D(tLow, vUv - vec2(o.x, 0.0)).rgb + texture2D(tLow, vUv + vec2(0.0, o.y)).rgb + texture2D(tLow, vUv - vec2(0.0, o.y)).rgb) * 2.0;
  t += texture2D(tLow, vUv + o).rgb + texture2D(tLow, vUv - o).rgb + texture2D(tLow, vUv + vec2(o.x, -o.y)).rgb + texture2D(tLow, vUv + vec2(-o.x, o.y)).rgb;
  t *= 1.0 / 16.0;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, t, uMix), 1.0);
}`;

// 横向拉丝：很亮的光源左右拖出一道淡蓝色的细线，是变形宽银幕镜头的味道
const STREAK = /* glsl */ `${COMMON}
uniform sampler2D tSrc; uniform vec2 uDir; uniform float uThreshold;
${EXPOSURE}
void main(){
  float thr = uThreshold / max(slExposure(), 0.2);
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i); float w = exp(-x * x / 18.0);
    vec3 c = texture2D(tSrc, vUv + uDir * x).rgb;
    c = max(c - vec3(thr), vec3(0.0));
    acc += c * w; ws += w;
  }
  gl_FragColor = vec4(acc / ws, 1.0);
}`;

// 镜头上的脏：水渍圆斑、油污、竖向的细擦痕。只生成一次。强光透过它时才看得见
const DIRT = /* glsl */ `${COMMON}
${NOISE_GLSL}
uniform float uAspect;
void main(){
  vec2 p = vUv * vec2(uAspect, 1.0);
  float acc = 0.0;
  for (int i = 0; i < 70; i++) {
    float fi = float(i);
    vec2 c = vec2(hash12(vec2(fi, 1.7)), hash12(vec2(fi, 9.2))) * vec2(uAspect, 1.0);
    float sz = mix(0.012, 0.085, pow(hash12(vec2(fi, 4.4)), 3.0));
    float r = length(p - c) / sz;
    float disc = smoothstep(1.0, 0.86, r) * (0.35 + 0.65 * smoothstep(0.35, 0.98, r));
    acc += disc * mix(0.15, 0.7, hash12(vec2(fi, 6.1)));
  }
  float smudge = fbm5(vUv * vec2(5.0, 9.0) + 3.0) * fbm3(vUv * 2.3 + 9.0);
  float streaks = pow(n2(vec2(vUv.x * 90.0, vUv.y * 2.0)), 4.0) * 0.25;
  float v = acc * 0.55 + smudge * 0.9 + streaks;
  v *= 0.45 + 0.9 * smoothstep(0.15, 0.75, length(vUv - 0.5));
  gl_FragColor = vec4(vec3(v) * vec3(1.0, 0.96, 0.9), 1.0);
}`;

// 测光：算出画面的平均亮度（r），以及太阳有没有被挡住（g）。两个值都随时间慢慢变，写进一张 1×1 的贴图
const ADAPT = /* glsl */ `${COMMON}
uniform sampler2D tPrev, tLum, tDepth; uniform vec2 uSunUv; uniform float uSunOn, uRate, uVisRate, uAspect;
void main(){
  float ls = 0.0, ws = 0.0;
  for (int y = 0; y < 5; y++) for (int x = 0; x < 7; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(7.0, 5.0);
    vec2 c = uv - 0.5;
    float w = 1.0 - 0.75 * smoothstep(0.1, 0.55, length(c));       // 画面中间的权重大（中央重点测光）
    float l = luma(texture2D(tLum, uv).rgb);
    ls += log(max(l, 1e-4)) * w; ws += w;                          // 取对数再平均：一小块特别亮的地方不会把整体带偏
  }
  float avg = clamp(exp(ls / ws), 0.002, 40.0);
  float vis = 0.0;
  for (int i = 0; i < 12; i++) {
    float r = sqrt((float(i) + 0.5) / 12.0) * 0.011; float th = float(i) * 2.39996323;
    vec2 uv = uSunUv + vec2(cos(th) / uAspect, sin(th)) * r;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) vis += 1.0;
    else vis += step(0.99999, texture2D(tDepth, uv).r);            // 太阳那个位置的深度是"最远" = 那里是天空 = 没被挡
  }
  vis = vis / 12.0 * uSunOn;
  vec4 prev = texture2D(tPrev, vec2(0.5));
  float a = mix(prev.r, avg, uRate);
  if (!(a > 0.0) || a > 1e4) a = avg;
  float v = mix(prev.g, vis, uVisRate);
  if (!(v >= 0.0)) v = vis;
  gl_FragColor = vec4(a, v, 0.0, 1.0);
}`;

const GRADE = /* glsl */ `${COMMON}
uniform sampler2D tScene, tBloom, tBlur, tStreak, tDirt;
${EXPOSURE}
uniform vec3 uSunCol;
uniform vec2 uSunUv;
uniform float uTime, uAspect, uBloom, uDirt, uStreak, uFlare, uCA, uVignette;
uniform float uDamage, uLowHealth, uAds, uFade, uSaturation, uSunOn, uAgxMix;

// ---- 两条色调映射曲线 ----
// AgX：高光会柔和地褪成白色，不会烧成一块死色
const mat3 SL_REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 SL_SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
vec3 slAgxContrast(vec3 x){ vec3 x2 = x * x; vec3 x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 slAgx(vec3 color){
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (SL_SRGB_TO_REC2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = slAgxContrast(color);
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color, vec3(0.0)), vec3(1.18));       // 比标准的 AgX 再多一点对比和饱和
  color = l + (color - l) * 1.22;
  color = outset * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  return clamp(SL_REC2020_TO_SRGB * color, 0.0, 1.0);
}
// ACES：对比强，橙色烧得很浓
vec3 slRRTODT(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 slAces(vec3 c){
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return clamp(outM * slRRTODT(inM * (c * 1.3)), 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

// 直视太阳时镜头里的眩光：一团光晕、几道星芒、沿"太阳—画面中心"连线排开的几个鬼影
vec3 flare(vec2 uv, vec2 sun, float vis){
  vec2 asp = vec2(uAspect, 1.0);
  vec2 p = (uv - 0.5) * asp, s = (sun - 0.5) * asp;
  vec2 dv = p - s; float r = length(dv);
  vec3 c = vec3(0.0);
  float ang = atan(dv.y, dv.x + 1e-6);
  float spikes = pow(abs(cos(ang * 3.0 + 0.4)), 24.0) + 0.6 * pow(abs(cos(ang * 4.0 - 1.1)), 40.0);
  c += uSunCol * (0.020 / (r * r * 9.0 + 0.010) + 0.10 * exp(-r * 3.2));
  c += uSunCol * spikes * 0.30 * exp(-r * 5.5);
  vec3 g = vec3(0.0);
  float k0 = length(p + s * 0.38);  g += vec3(0.30, 0.75, 0.55) * smoothstep(0.085, 0.06, k0) * 0.050;
  float k1 = length(p + s * 0.82);  g += vec3(0.85, 0.45, 0.25) * smoothstep(0.045, 0.030, k1) * 0.075;
  float k2 = length(p + s * 1.35);  g += vec3(0.35, 0.50, 0.95) * smoothstep(0.17, 0.12, k2) * (0.4 + 0.6 * smoothstep(0.05, 0.16, k2)) * 0.040;
  float k3 = length(p - s * 0.45);  g += vec3(0.80, 0.70, 0.35) * smoothstep(0.030, 0.018, k3) * 0.060;
  float hr = length(p + s * 0.15);
  g += vec3(0.45, 0.55, 0.85) * exp(-pow((hr - 0.52) * 16.0, 2.0)) * 0.035 * smoothstep(0.1, 0.5, length(s));
  c += g * uSunCol * 2.4;
  return c * vis;
}

void main(){
  vec2 c = vUv - 0.5;
  float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0)) / (0.25 * (uAspect * uAspect + 1.0));   // 画面中心是 0，四个角是 1
  vec4 ad = texture2D(tAdapt, vec2(0.5));
  // 色差：越靠边，红蓝两色错开得越多（很轻微；挨打时加重）
  vec2 off = c * r2 * (uCA + uDamage * 0.006);
  vec3 col = vec3(texture2D(tScene, vUv + off).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - off).b);
  // 开镜时把画面四周虚掉
  vec3 soft = texture2D(tBlur, vUv).rgb;
  col = mix(col, soft, uAds * 0.75 * smoothstep(0.22, 0.85, r2));
  // 泛光：不是"加"上去，而是按比例"混"进来 —— 亮的地方自然溢出，暗的地方不会被抬灰
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 dirt = texture2D(tDirt, vUv).rgb;
  col = mix(col, bloom, uBloom);
  col += bloom * dirt * uDirt;
  col += texture2D(tStreak, vUv).rgb * vec3(0.45, 0.62, 1.0) * uStreak;
  float vis = ad.g * uSunOn;
  if (vis > 0.002) { vec3 fl = flare(vUv, uSunUv, vis) * uFlare; col += fl * (1.0 + dirt * 1.5); }
  col *= slExposure();
  // 色调映射：以 ACES 为主（有劲），掺四分之一 AgX（让最亮的地方褪成白而不是死橙色）
  col = mix(slAces(col), slAgx(col), uAgxMix);

  // ---- 调色（这时已经是屏幕上的亮度了）----
  float l = luma(col);
  vec3 sh = vec3(0.80, 1.01, 1.13), hi = vec3(1.07, 1.0, 0.90);     // 暗部偏青，亮部偏暖
  col *= mix(sh, hi, smoothstep(0.03, 0.55, l));
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);              // 一点点 S 曲线
  col = col * 0.988 + vec3(0.006, 0.0085, 0.011);                   // 最黑的地方抬起来一点，带一点青
  float sat = uSaturation * (1.0 - 0.65 * uLowHealth) * (1.0 - 0.5 * uDamage);
  l = luma(col);
  col = mix(vec3(l), col, sat);
  float vig = uVignette + uLowHealth * 0.55 + uAds * 0.22;          // 暗角
  float vr = smoothstep(0.15 - uAds * 0.08, 1.05, r2);
  col *= 1.0 - vig * vr * vr * (3.0 - 2.0 * vr);
  float edge = smoothstep(0.18, 1.0, r2);                           // 挨打：边缘一圈红
  col = mix(col, vec3(0.55, 0.02, 0.01) * (0.35 + l), clamp(uDamage * edge * 0.85 + uLowHealth * edge * edge * 0.25 * (0.75 + 0.25 * sin(uTime * 5.0)), 0.0, 1.0));
  col *= 1.0 - uFade;
  col = toSRGB(clamp(col, 0.0, 1.0));
  gl_FragColor = vec4(col, dot(col, vec3(0.299, 0.587, 0.114)));     // a 里顺手存亮度，下一步抗锯齿要用
}`;

const FINAL = /* glsl */ `${COMMON}
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uTime, uGrain, uSharpen;
void main(){
  vec4 M = texture2D(tSrc, vUv);
  vec3 col = M.rgb;
  vec4 NW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel), NE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel);
  vec4 SW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel), SE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel);
  float lMin = min(M.a, min(min(NW.a, NE.a), min(SW.a, SE.a)));
  float lMax = max(M.a, max(max(NW.a, NE.a), max(SW.a, SE.a)));
  float contrast = lMax - lMin;
  // 抗锯齿（FXAA）：在亮度突变的地方，顺着边的方向取几个点平均，把锯齿抹平
  if (contrast > max(0.0312, lMax * 0.10)) {
    vec2 dir = vec2(-((NW.a + NE.a) - (SW.a + SE.a)), (NW.a + SW.a) - (NE.a + SE.a));
    float dirReduce = max((NW.a + NE.a + SW.a + SE.a) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
    vec4 A = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)) + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)));
    vec4 B = A * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5) + texture2D(tSrc, vUv + dir * 0.5));
    col = (B.a < lMin || B.a > lMax) ? A.rgb : B.rgb;
  }
  // 轻微的锐化；强边缘上收手（那里归抗锯齿管）
  vec3 blur = (NW.rgb + NE.rgb + SW.rgb + SE.rgb) * 0.25;
  col += (M.rgb - blur) * uSharpen * (1.0 - smoothstep(0.04, 0.22, contrast));
  // 胶片颗粒：暗处明显，亮处收敛
  vec2 seed = gl_FragCoord.xy + fract(uTime * vec2(7.31, 3.17)) * vec2(311.7, 173.3);
  float g = hash12(seed) + hash12(seed + 57.3) - 1.0;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * mix(1.0, 0.30, smoothstep(0.25, 0.9, l)) * (0.35 + 0.65 * smoothstep(0.0, 0.08, l));
  // 加一点点随机数，打散天空渐变里一级一级的色带
  col += (hash12(gl_FragCoord.xy * 1.37 + 11.0) + hash12(gl_FragCoord.xy * 0.71 + 3.0) - 1.0) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

type U = Record<string, THREE.IUniform>;
const P = { // 几个可以调的总开关
  aoRadius: 0.9, aoIntensity: 1.6, aoStrength: 0.95,
  volSigma: 0.0034, volMaxDist: 170, volSunScale: 0.85, volAmbient: 0.2, volFarHaze: 0.42, volInteriorDust: 6,
  bloom: 0.065, bloomMix: 0.62, dirt: 0.1, streak: 0.03, streakThreshold: 2.2, flare: 0.16, agxMix: 0.25, ca: 0.0013, vignette: 0.3,
  key: 0.12, minExposure: 0.6, maxExposure: 2, adaptTau: 1.5, grain: 0.02, sharpen: 0.3,
};

export class PostChain {
  /** 场景就画进这张贴图：16 位浮点（亮度可以远超 1），带一张深度贴图。 */
  hdr!: THREE.WebGLRenderTarget;
  /** 曝光的手动倍数，调试用。 */
  exposure = 1;
  private q: PostQuality = { msaa: 0, ao: 0, volSteps: 0, bloom: true };
  private W = 2; private H = 2;
  private tri = new THREE.Mesh(new THREE.BufferGeometry(), undefined);
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.Camera();
  private mats: Record<string, THREE.ShaderMaterial> = {};
  private rt: Record<string, THREE.WebGLRenderTarget> = {};
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private adapt: THREE.WebGLRenderTarget[] = [];
  private dirt: THREE.WebGLRenderTarget;
  private adaptIdx = 0; private frames = 0;
  private sunView = new THREE.Vector3(); private fwd = new THREE.Vector3();
  private exposureU = { uExposure: { value: 1 }, uKey: { value: P.key }, uMinE: { value: P.minExposure }, uMaxE: { value: P.maxExposure }, uAuto: { value: 1 }, tAdapt: { value: null as THREE.Texture | null } };

  constructor(private gl: THREE.WebGLRenderer, private camera: THREE.PerspectiveCamera, private sun: THREE.DirectionalLight) {
    const g = this.tri.geometry;
    // 一个比屏幕大的三角形，刚好盖住整个画面：比两个三角形拼的矩形少一条对角线接缝
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.tri.frustumCulled = false;
    this.fsScene.add(this.tri);
    const half = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.adapt = [new THREE.WebGLRenderTarget(1, 1, half), new THREE.WebGLRenderTarget(1, 1, half)];
    this.dirt = new THREE.WebGLRenderTarget(512, 288, { depthBuffer: false });
    this.build();
    // 镜头污渍只画一次
    const dirtMat = this.mat('dirt', DIRT, { tNoise: { value: skyNoiseTexture() }, uAspect: { value: 16 / 9 } });
    this.run(dirtMat, this.dirt);
  }

  private mat(name: string, frag: string, uniforms: U, defines: Record<string, string | number> = {}) {
    this.mats[name]?.dispose();
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
    this.mats[name] = m;
    return m;
  }
  private run(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.tri.material = m;
    this.gl.setRenderTarget(target);
    this.gl.render(this.fsScene, this.fsCam);
  }

  /** 着色器里有些量是编进去的常量（采样数、步数），画质一变就要重建。 */
  private build() {
    const q = this.q, E = this.exposureU;
    const u = (o: Record<string, unknown>): U => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
    this.mat('depthHalf', DEPTH_HALF, u({ tDepth: null, uNear: 0.05, uFar: 1400 }));
    this.mat('ao', AO, u({ tDepthHalf: null, uTanHalf: new THREE.Vector2(), uTexel: new THREE.Vector2(), uRadius: P.aoRadius, uIntensity: P.aoIntensity, uAspect: 1 }), { AO_TAPS: Math.max(4, q.ao) });
    this.mat('blurAo', BLUR, u({ tSrc: null, tDepthHalf: null, uDir: new THREE.Vector2() }), { BLUR_TOL: '0.04' });
    this.mat('blurVol', BLUR, u({ tSrc: null, tDepthHalf: null, uDir: new THREE.Vector2() }), { BLUR_TOL: '0.30' });
    this.mat('vol', VOL, u({
      tDepthHalf: null, tShadow: null, uShadowMatrix: new THREE.Matrix4(), uCamWorld: new THREE.Matrix4(), uCamPos: new THREE.Vector3(),
      uSunRad: SUN_COLOR.clone().multiplyScalar(SUN_INTENSITY * P.volSunScale), uAmb: SKY.fog.clone().multiplyScalar(P.volAmbient), uTanHalf: new THREE.Vector2(),
      uHasShadow: 0, uMaxDist: P.volMaxDist, uSigma: P.volSigma, uFarZ: 1400, uFarHaze: P.volFarHaze, uBoxDust: 0, uBoxMin: new THREE.Vector3(), uBoxMax: new THREE.Vector3(),
      uSunDir: SUN_DIR, uHor: SKY.horizon, uHorAway: SKY.horizonAway, uSunCol: SUN_COLOR,
    }), { VOL_STEPS: Math.max(6, q.volSteps) });
    this.mat('composite', COMPOSITE, { ...u({ tColor: null, tDepth: null, tDepthHalf: null, tAO: null, tVol: null, uHalfRes: new THREE.Vector2(), uNear: 0.05, uFar: 1400, uAoOn: 0, uVolOn: 0, uAoStrength: P.aoStrength }), ...E });
    this.mat('down', DOWN, u({ tSrc: null, uTexel: new THREE.Vector2(), uFirst: 0 }));
    this.mat('up', UP, u({ tLow: null, tHigh: null, uTexel: new THREE.Vector2(), uMix: P.bloomMix }));
    this.mat('streak', STREAK, { ...u({ tSrc: null, uDir: new THREE.Vector2(), uThreshold: 0 }), ...E });
    this.mat('adapt', ADAPT, u({ tPrev: null, tLum: null, tDepth: null, uSunUv: new THREE.Vector2(), uSunOn: 0, uRate: 1, uVisRate: 1, uAspect: 1 }));
    this.mat('grade', GRADE, {
      ...u({ tScene: null, tBloom: null, tBlur: null, tStreak: null, tDirt: this.dirt.texture, uSunCol: SUN_COLOR, uSunUv: new THREE.Vector2(), uTime: 0, uAspect: 1,
        uBloom: P.bloom, uDirt: P.dirt, uStreak: P.streak, uFlare: P.flare, uCA: P.ca, uVignette: P.vignette,
        uDamage: 0, uLowHealth: 0, uAds: 0, uFade: 0, uSaturation: 1, uSunOn: 0, uAgxMix: P.agxMix }), ...E });
    this.mat('final', FINAL, u({ tSrc: null, uTexel: new THREE.Vector2(), uTime: 0, uGrain: P.grain, uSharpen: P.sharpen }));
  }

  /** w、h 是内部渲染分辨率（像素）。 */
  configure(w: number, h: number, q: PostQuality) {
    const rebuild = q.ao !== this.q.ao || q.volSteps !== this.q.volSteps;
    this.q = { ...q };
    if (rebuild) this.build();
    this.W = w = Math.max(2, Math.round(w)); this.H = h = Math.max(2, Math.round(h));
    for (const t of [...Object.values(this.rt), ...this.down, ...this.up]) t.dispose();
    this.hdr?.depthTexture?.dispose(); this.hdr?.dispose();
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: depth, samples: q.msaa });
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const f16 = (W: number, H: number, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, minFilter: filter, magFilter: filter, depthBuffer: false });
    const floatOk = this.gl.extensions.has('EXT_color_buffer_float');
    this.rt = {
      scene: f16(w, h),
      ldr: new THREE.WebGLRenderTarget(w, h, { depthBuffer: false }),
      // 半分辨率的线性深度。能用 32 位浮点就用：远处的深度差 16 位分不清
      depthHalf: new THREE.WebGLRenderTarget(hw, hh, { type: floatOk ? THREE.FloatType : THREE.HalfFloatType, format: floatOk ? THREE.RedFormat : THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }),
      aoA: new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }),
      aoB: new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false }),
      volA: f16(hw, hh, THREE.NearestFilter), volB: f16(hw, hh, THREE.NearestFilter),
    };
    this.down = []; this.up = [];
    for (let i = 0; i < 6; i++) this.down.push(f16(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    for (let i = 0; i < 5; i++) this.up.push(f16(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    this.rt.streakA = f16(Math.max(1, w >> 3), Math.max(1, h >> 3)); this.rt.streakB = f16(Math.max(1, w >> 3), Math.max(1, h >> 3));
    this.frames = 0;
  }

  /** 镜头切换了（重开、传送）：接下来两帧的曝光直接取当前画面，不做慢慢适应。 */
  cut() { this.frames = 0; }

  /** 场景已经画进 hdr 以后调用：跑完整条链，把结果画到屏幕上。 */
  render(f: PostFrame) {
    const { gl, camera, mats: m, rt, q, W, H } = this;
    const hw = rt.depthHalf.width, hh = rt.depthHalf.height;
    const proj = camera.projectionMatrix.elements, tanHalfX = 1 / proj[0], tanHalfY = 1 / proj[5];
    const E = this.exposureU;
    E.uExposure.value = this.exposure;
    E.tAdapt.value = this.adapt[this.adaptIdx].texture;
    const first = this.frames < 2;
    const depth = this.hdr.depthTexture!;

    // 1. 半分辨率线性深度
    let u = m.depthHalf.uniforms;
    u.tDepth.value = depth; u.uNear.value = camera.near; u.uFar.value = camera.far;
    this.run(m.depthHalf, rt.depthHalf);

    // 2. 环境光遮蔽，再横竖各模糊一趟
    if (q.ao > 0) {
      u = m.ao.uniforms;
      u.tDepthHalf.value = rt.depthHalf.texture; u.uTanHalf.value.set(tanHalfX, tanHalfY); u.uTexel.value.set(1 / hw, 1 / hh); u.uAspect.value = hw / hh;
      this.run(m.ao, rt.aoA);
      u = m.blurAo.uniforms; u.tDepthHalf.value = rt.depthHalf.texture;
      u.tSrc.value = rt.aoA.texture; u.uDir.value.set(1 / hw, 0); this.run(m.blurAo, rt.aoB);
      u.tSrc.value = rt.aoB.texture; u.uDir.value.set(0, 1 / hh); this.run(m.blurAo, rt.aoA);
    }

    // 3. 体积光
    if (q.volSteps > 0) {
      u = m.vol.uniforms;
      const shadowMap = this.sun.castShadow ? this.sun.shadow.map : null;
      u.tDepthHalf.value = rt.depthHalf.texture; u.tShadow.value = shadowMap ? shadowMap.texture : null; u.uHasShadow.value = shadowMap ? 1 : 0;
      u.uShadowMatrix.value.copy(this.sun.shadow.matrix); u.uCamWorld.value.copy(camera.matrixWorld); u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uTanHalf.value.set(tanHalfX, tanHalfY); u.uFarZ.value = camera.far;
      (u.uAmb.value as THREE.Color).copy(SKY.fog).multiplyScalar(P.volAmbient * (1 + f.flash * 1.5));
      if (f.interior) { u.uBoxDust.value = P.volInteriorDust; u.uBoxMin.value.copy(f.interior.min); u.uBoxMax.value.copy(f.interior.max); } else u.uBoxDust.value = 0;
      this.run(m.vol, rt.volA);
      u = m.blurVol.uniforms; u.tDepthHalf.value = rt.depthHalf.texture;
      u.tSrc.value = rt.volA.texture; u.uDir.value.set(1 / hw, 0); this.run(m.blurVol, rt.volB);
      u.tSrc.value = rt.volB.texture; u.uDir.value.set(0, 1 / hh); this.run(m.blurVol, rt.volA);
    }

    // 4. 合成
    u = m.composite.uniforms;
    u.tColor.value = this.hdr.texture; u.tDepth.value = depth; u.tDepthHalf.value = rt.depthHalf.texture; u.tAO.value = rt.aoA.texture; u.tVol.value = rt.volA.texture;
    u.uHalfRes.value.set(hw, hh); u.uNear.value = camera.near; u.uFar.value = camera.far; u.uAoOn.value = q.ao > 0 ? 1 : 0; u.uVolOn.value = q.volSteps > 0 ? 1 : 0;
    this.run(m.composite, rt.scene);

    // 5. 泛光：一级级缩小（每级模糊一点），再一级级放大叠回来
    let bloomTex = rt.scene.texture, lumTex = rt.scene.texture, blurTex = rt.scene.texture, streakTex: THREE.Texture | null = null;
    if (q.bloom) {
      u = m.down.uniforms;
      let src = rt.scene;
      for (let i = 0; i < 6; i++) { u.tSrc.value = src.texture; u.uTexel.value.set(1 / src.width, 1 / src.height); u.uFirst.value = i === 0 ? 1 : 0; this.run(m.down, this.down[i]); src = this.down[i]; }
      u = m.up.uniforms;
      let low = this.down[5];
      for (let i = 4; i >= 0; i--) { u.tLow.value = low.texture; u.tHigh.value = this.down[i].texture; u.uTexel.value.set(1 / low.width, 1 / low.height); this.run(m.up, this.up[i]); low = this.up[i]; }
      bloomTex = this.up[0].texture; lumTex = this.down[5].texture; blurTex = this.down[1].texture;
      u = m.streak.uniforms;
      const s = this.down[2];
      u.tSrc.value = s.texture; u.uDir.value.set(1.5 / s.width, 0); u.uThreshold.value = P.streakThreshold; this.run(m.streak, rt.streakA);
      u.tSrc.value = rt.streakA.texture; u.uDir.value.set(5 / s.width, 0); u.uThreshold.value = 0; this.run(m.streak, rt.streakB);
      streakTex = rt.streakB.texture;
    }

    // 6. 测光 + 太阳有没有被挡住
    camera.getWorldDirection(this.fwd);
    const facing = this.fwd.dot(SUN_DIR);
    let sunOn = 0;
    this.sunView.setFromMatrixPosition(camera.matrixWorld).addScaledVector(SUN_DIR, 500).project(camera);
    const sunU = this.sunView.x * 0.5 + 0.5, sunV = this.sunView.y * 0.5 + 0.5;
    if (facing > 0.05) {
      // 太阳在画面外 30% 以内时，眩光渐渐淡出
      const out = Math.max(0, -sunU, sunU - 1, -sunV, sunV - 1);
      sunOn = Math.max(0, 1 - out / 0.3);
    }
    u = m.adapt.uniforms;
    const prev = this.adapt[this.adaptIdx], next = this.adapt[1 - this.adaptIdx];
    u.tPrev.value = prev.texture; u.tLum.value = lumTex; u.tDepth.value = depth; u.uSunUv.value.set(sunU, sunV); u.uSunOn.value = sunOn; u.uAspect.value = W / H;
    u.uRate.value = first ? 1 : 1 - Math.exp(-f.dt / P.adaptTau); u.uVisRate.value = first ? 1 : 1 - Math.exp(-f.dt / 0.12);
    this.run(m.adapt, next);
    this.adaptIdx = 1 - this.adaptIdx;
    E.tAdapt.value = next.texture;

    // 7. 调色
    u = m.grade.uniforms;
    u.tScene.value = rt.scene.texture; u.tBloom.value = bloomTex; u.tBlur.value = blurTex; u.tStreak.value = streakTex ?? rt.scene.texture;
    u.uBloom.value = q.bloom ? P.bloom : 0; u.uDirt.value = q.bloom ? P.dirt : 0; u.uStreak.value = streakTex ? P.streak : 0;
    u.uSunUv.value.set(sunU, sunV); u.uSunOn.value = sunOn; u.uTime.value = f.time; u.uAspect.value = W / H;
    u.uDamage.value = f.damage; u.uLowHealth.value = f.lowHealth; u.uAds.value = f.ads; u.uFade.value = f.fade; u.uSaturation.value = f.saturation;
    this.run(m.grade, rt.ldr);

    // 8. 抗锯齿、锐化、颗粒 → 屏幕
    u = m.final.uniforms;
    u.tSrc.value = rt.ldr.texture; u.uTexel.value.set(1 / W, 1 / H); u.uTime.value = f.time;
    this.run(m.final, null);
    this.frames++;
  }
}
