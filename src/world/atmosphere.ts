import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 天空和海。（雨在 rain.ts）
//
// 时间设定是日出：头顶压着一整片石板灰的雨云，只有东边海平线上方留着一道没被云盖住的缝，
// 太阳就从那道缝里贴着海面照进来（仰角只有 13°）。于是整个港区是冷色的，
// 只有被这束低角度的光扫到的地方是金色的 —— 画面的冷暖对比全靠它。

/** 指向太阳的方向：东偏南 20°，仰角 13°。 */
export const SUN_DIR = new THREE.Vector3(0.916, 0.225, 0.331).normalize();
/** 太阳光的颜色（线性空间）和强度。强度很高，靠后处理里的自动曝光把画面亮度拉回来。 */
export const SUN_COLOR = new THREE.Color(1, 0.72, 0.42);
export const SUN_INTENSITY = 9;
/** 天空的几个基准色（线性空间）：地平线朝太阳一侧、背对太阳一侧，以及空气散射进来的环境光。 */
export const SKY = {
  horizon: new THREE.Color(0.95, 0.55, 0.28),
  horizonAway: new THREE.Color(0.16, 0.22, 0.30),
  fog: new THREE.Color(0.42, 0.47, 0.52),
};

/** 一张 256×256 的随机数贴图：着色器里的噪声都从它取，比现算哈希便宜，也不会在不同显卡上长得不一样。 */
let noiseTex: THREE.DataTexture | null = null;
export function skyNoiseTexture() {
  if (noiseTex) return noiseTex;
  const rng = mulberry32(2654435769), data = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng() * 256);
  noiseTex = new THREE.DataTexture(data, 256, 256, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

/** 噪声：平滑的值噪声，和把几层叠起来的分形噪声。天空和体积雾共用。 */
export const NOISE_GLSL = /* glsl */ `
uniform sampler2D tNoise;
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return texture2D(tNoise, (i + f + 0.5) / 256.0).r; }
float fbm5(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.96875; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.875; }`;

/** "朝这个方向看过去，地平线是什么颜色"。天空用它画地平线，体积雾用它把远处的东西融进天色里。 */
export const HORIZON_GLSL = /* glsl */ `
uniform vec3 uSunDir, uHor, uHorAway, uSunCol;
// 这个方向和太阳的水平夹角：正对太阳是 1，背对是 0
float skyToSun(vec3 d){ return clamp(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0); }
vec3 horizonColor(vec3 d){
  float ts = skyToSun(d);
  vec3 c = mix(uHorAway, uHorAway * 1.25 + vec3(0.05, 0.03, 0.02), smoothstep(0.2, 0.75, ts));
  c = mix(c, uHor * vec3(1.9, 1.55, 1.2), pow(ts, 6.0));
  c = mix(c, vec3(1.0, 0.60, 0.24) * 3.4, pow(ts, 34.0));
  return c;
}`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform float uTime, uEnv, uFlash;
uniform vec3 uFlashDir;
${NOISE_GLSL}
${HORIZON_GLSL}

void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float mu = dot(d, uSunDir);
  float s = max(mu, 0.0);
  float ts = skyToSun(d);

  // ---- 云盖后面 / 下面的晴空 ----
  vec3 hc = horizonColor(d);
  vec3 midC = mix(vec3(0.15, 0.24, 0.36), vec3(0.72, 0.50, 0.34), pow(ts, 3.0));   // 火烧云上面那条发白的光带
  vec3 clearC = mix(hc, midC, smoothstep(0.0, 0.17, h));
  clearC = mix(clearC, vec3(0.085, 0.145, 0.24), smoothstep(0.10, 0.5, h));
  // 太阳周围的光晕：越靠近太阳越亮，叠四层由宽到窄
  clearC += uSunCol * vec3(1.0, 0.86, 0.68) * (pow(s, 8.0) * 0.14 + pow(s, 64.0) * 0.55 + pow(s, 600.0) * 2.2 + pow(s, 6000.0) * 14.0);

  // ---- 云盖 ----
  vec2 cuv = d.xz / (h + 0.10) * vec2(0.62, 0.95);          // 把视线投到头顶的一个平面上；云卷大致东西走向
  vec2 wind = vec2(-0.012, 0.004) * uTime;
  vec2 q = cuv + wind;
  float warp = fbm3(q * 0.45 + 7.1);
  vec2 qq = q + (warp - 0.5) * 1.3;                         // 先把坐标扭一扭再取噪声，云的边缘才不是一团团的圆
  float dens = fbm5(qq);
  // 云底的波纹（脊状细节），越靠近地平线越淡，免得远处闪烁
  float ridg = 1.0 - abs(2.0 * fbm3(qq * 3.1 + 5.0) - 1.0);
  dens = dens * 0.86 + (ridg - 0.6) * 0.16 * smoothstep(0.03, 0.25, h);
  float big = n2(q * 0.19 + 3.7);
  float body = dens * 0.74 + big * 0.36;
  float cov = smoothstep(0.31, 0.50, body);
  // 云盖在东边地平线上方就结束了：朝太阳的方向留出一道晴朗的、烧红的缝；别的方向几乎压到海面
  float edge = mix(0.030, 0.285, pow(ts, 1.7));
  float rag = (n2(q * 0.9 + 11.0) - 0.5) * 0.16 + (dens - 0.5) * 0.10;
  float deck = smoothstep(edge - 0.035, edge + 0.11, h + rag * (0.35 + ts));
  cov *= deck;
  // 太阳永远从缝里一个不规则的破洞露出来，不会躲在实心的云后面
  float hole = smoothstep(0.972, 0.9985, mu + (dens - 0.5) * 0.012);
  cov *= 1.0 - 0.93 * hole;
  // 缝里飘着的薄碎云（稍微遮一点太阳，自己被烧红）
  float scud = smoothstep(0.55, 0.85, fbm3(q * vec2(0.55, 1.9) + 31.0)) * (1.0 - deck) * smoothstep(0.02, 0.10, h) * 0.55 * (1.0 - 0.8 * hole);

  // 受光：朝太阳方向挪一点再取一次密度，两次的差就是"云底这一块有没有被旁边的云挡住"
  vec2 sd = normalize(uSunDir.xz);
  float densS = fbm5(qq + sd * 0.22);
  float relief = clamp((dens - densS) * 4.5 + 0.5, 0.0, 1.0);
  float thick = smoothstep(0.40, 0.72, body);
  vec3 cool = mix(vec3(0.155, 0.195, 0.255), vec3(0.030, 0.042, 0.064), thick);       // 石板灰，云厚的地方更暗
  cool *= 0.55 + 0.9 * relief * relief;
  cool += vec3(0.07, 0.10, 0.15) * pow(1.0 - thick, 3.0);                             // 薄的地方透进一点冷光
  // 暖光从缝里斜着扫到云底：离太阳近、离云盖边缘近的地方最强
  float nearSun = pow(ts, 5.0) * exp(-max(h - edge, 0.0) * 4.5) * 0.9 + pow(s, 7.0) * 0.9;
  vec3 warm = (uHor * vec3(1.30, 0.66, 0.40)) * nearSun * (0.05 + 2.2 * relief * relief * relief) * 1.15;
  // 云在缝的边缘变薄的地方，镶一道烧红的边
  float rim = cov * (1.0 - cov) * 4.0;
  warm += uSunCol * rim * pow(ts, 4.0) * (0.5 + 1.6 * pow(s, 6.0)) * (1.0 - 0.85 * hole);
  vec3 cloudC = cool + warm;
  // 云层里的片状闪电
  float fl = uFlash * pow(max(dot(d, uFlashDir), 0.0), 5.0);
  cloudC += vec3(0.55, 0.68, 1.0) * fl * (0.4 + 2.2 * dens * dens);
  // 大气透视：远处的云融进地平线的颜色
  cloudC = mix(cloudC, hc * 0.55 + cloudC * 0.45, exp(-h * 11.0));

  vec3 col = mix(clearC, cloudC, cov * 0.985);
  vec3 scudC = mix(vec3(0.10, 0.11, 0.14), uHor * 1.5, pow(ts, 3.0)) + uSunCol * pow(s, 24.0) * 2.0;
  col = mix(col, scudC, scud);

  // 太阳圆盘。烘环境贴图时不画它：那时"太阳"由方向光负责，画进去就照了两遍
  float veil = (1.0 - cov * 0.92) * (1.0 - scud * 0.7);
  float disk = smoothstep(0.999905, 0.999955, mu);
  col += vec3(1.0, 0.80, 0.52) * disk * 110.0 * veil * (1.0 - uEnv);

  // 地平线以下：海上的雾气 / 地面的反光（基本被场景挡住）
  if (d.y < 0.0) {
    float t = clamp(-d.y * 5.0, 0.0, 1.0);
    vec3 low = mix(uHorAway * 0.42, vec3(0.060, 0.064, 0.070), uEnv);
    low += uHor * 0.55 * pow(ts, 6.0) * exp(d.y * 7.0);
    col = mix(hc + uSunCol * pow(s, 48.0) * 1.5, low, smoothstep(0.0, 1.0, t));
  }
  // 烘环境贴图时把过亮的值压住，不然模糊以后会出现一颗颗亮斑
  col = mix(col, min(col, vec3(6.0)), uEnv);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

function skyMaterial(env: number) {
  const uniforms = {
    tNoise: { value: skyNoiseTexture() }, uTime: { value: 0 }, uEnv: { value: env }, uFlash: { value: 0 },
    uFlashDir: { value: new THREE.Vector3(-0.5, 0.5, -0.7).normalize() },
    uSunDir: { value: SUN_DIR }, uHor: { value: SKY.horizon }, uHorAway: { value: SKY.horizonAway }, uSunCol: { value: SUN_COLOR },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    // 只取相机的旋转、不取平移，再把深度钉在最远处：天空永远在所有东西后面，也不会随着走动而靠近
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
  });
  return { mat, uniforms };
}

export function createSky() {
  const { mat, uniforms } = skyMaterial(0);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  return { mesh, uniforms };
}

/**
 * 把天空烘成环境贴图。场景里没有"环境光"这盏灯：所有不被太阳直射的地方，
 * 都是被这张贴图（也就是天空本身）照亮的 —— 朝东的面带一点暖色，朝西和朝上的面是冷的。
 */
export function bakeEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const { mat } = skyMaterial(1);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0, 0.1, 100);
  pmrem.dispose();
  mesh.geometry.dispose();
  mat.dispose();
  return rt.texture;
}

/** 海面的法线贴图：用整数频率的正弦波叠出来，天然可以无缝平铺。 */
function waterNormal() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const rng = mulberry32(99);
  const waves = Array.from({ length: 10 }, () => ({ fx: Math.round((rng() - 0.5) * 14), fy: Math.round((rng() - 0.5) * 14), ph: rng() * 6.28, a: 0.4 + rng() }));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let dx = 0, dy = 0;
    for (const w of waves) {
      const k = Math.cos(((w.fx * x + w.fy * y) / S) * 6.2832 + w.ph) * w.a;
      dx += k * w.fx; dy += k * w.fy;
    }
    const nx = -dx * 0.035, ny = -dy * 0.035, inv = 1 / Math.hypot(nx, ny, 1);
    const i = (y * S + x) * 4;
    img.data[i] = (nx * inv * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255; img.data[i + 2] = (inv * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function createSea(quayX: number) {
  const normal = waterNormal();
  normal.repeat.set(60, 60);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0a1418, roughness: 0.14, metalness: 0.0, normalMap: normal, normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 1.6 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(quayX + 448, -1.7, 0);
  mesh.receiveShadow = true;
  return { mesh, update(t: number) { normal.offset.set(t * 0.012, t * 0.007); } };
}
