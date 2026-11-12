import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { SKY, SUN_COLOR, SUN_DIR } from './atmosphere';

// 雨。两样东西：空中的雨丝，和雨点砸在地上溅起的小水花。
//
// 雨丝好不好看，关键不在数量，在"受光"：雨滴是透明的小水珠，光从背后照过来时它最亮。
// 所以朝着太阳看，雨是一片金色的亮线；背对太阳看，雨几乎看不见。颜色不是固定的灰，而是按视线和太阳的夹角算的。
//
// 每根雨丝是一张窄长的小面片（几千张用"实例化"一次画完），位置全在顶点着色器里算：
// 所有雨丝包在相机周围的一个盒子里循环下落，相机走到哪，雨就跟到哪。

const BOX = new THREE.Vector3(26, 15, 26);           // 包着相机的那个盒子（米）
const VEL = new THREE.Vector3(-2.6, -9.4, 1.1);      // 雨的速度：每秒 9.8 米，被风吹得往西偏
const MAX_BOXES = 4, MAX_HOLES = 8;

/** 一张 1×1 的小面片，实例化 n 份；每份带四个随机数。 */
function quads(n: number, rng: () => number, mark = 0) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const seed = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) seed[i] = rng();
  for (let i = n - mark; i < n; i++) seed[i * 4 + 3] = -1; // 最后 mark 份留给屋檐滴水
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  g.instanceCount = n;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

const SHARED = /* glsl */ `
uniform vec3 uBoxMin[${MAX_BOXES}]; uniform vec3 uBoxMax[${MAX_BOXES}];
// 这一点在不在屋里（屋里不下雨）
bool wInside(vec3 p){
  for (int i = 0; i < ${MAX_BOXES}; i++) { if (all(greaterThan(p, uBoxMin[i])) && all(lessThan(p, uBoxMax[i]))) return true; }
  return false;
}
// 水珠把光主要往前散：视线越是迎着太阳（c 越接近 1），雨越亮
float wPhase(float c){ float g = 0.72; return (1.0 - g * g) / (12.566 * pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5)); }`;

const STREAK_VERT = /* glsl */ `
uniform float uTime, uRain, uPix, uDrip, uQuayX; uniform vec3 uVel, uBox, uSunDir, uSunCol, uAmb; uniform vec4 uEave;
attribute vec4 aSeed;
varying vec3 vCol; varying float vA; varying vec2 vUv;
${SHARED}
uniform vec4 uSky[${MAX_HOLES}];   // 屋顶的破洞 (x, z, 半宽, 半深)：雨从这里漏进屋
bool wSky(vec3 p){
  for (int i = 0; i < ${MAX_HOLES}; i++) { if (abs(p.x - uSky[i].x) < uSky[i].z && abs(p.z - uSky[i].y) < uSky[i].w) return true; }
  return false;
}
void main(){
  vUv = position.xy;
  float sp = 0.82 + 0.36 * aSeed.w;
  vec3 vel = uVel * sp;
  vec3 p; float len; float kill = 0.0;
  if (aSeed.w < 0.0) {
    // 屋檐滴水：沿檐口排成一线，从檐口高度自由落体，越落越快、拖得越长
    float h = uEave.w, T = sqrt(max(h, 0.1) / 4.9);
    float t = fract(uTime / T * (0.9 + 0.2 * aSeed.y) + aSeed.z) * T;
    p = vec3(mix(uEave.x, uEave.y, aSeed.x), h - 4.9 * t * t, uEave.z + 0.05 * sin(aSeed.x * 911.0));
    vel = vec3(0.0, -9.81 * t - 0.3, 0.0); len = 0.022 * length(vel) + 0.03;
    kill = 1.0 - uDrip;
    if (fract(aSeed.x * 37.7) > 0.55 + 0.45 * uRain) kill = 1.0;
  } else {
    p = aSeed.xyz * uBox + vel * uTime;
    p = mod(p - cameraPosition + 0.5 * uBox, uBox) - 0.5 * uBox + cameraPosition;   // 永远包在相机周围
    len = 0.03 * length(vel);                                                         // 长度 = 三十分之一秒里落下的距离
    if (fract(aSeed.w * 7.13 + aSeed.x) > uRain) kill = 1.0;
    if (wInside(p) && !wSky(p)) kill = 1.0;
  }
  if (p.y < (p.x > uQuayX ? -1.7 : 0.0)) kill = 1.0;
  vec3 dir = normalize(vel);
  vec3 toP = p - cameraPosition; float dist = length(toP);
  vec3 side = normalize(cross(dir, toP) + vec3(1e-6));
  // 雨丝只有几毫米粗，稍远一点就不足一个像素，会一闪一闪。所以宽度至少保持 0.75 像素，同时按比例调淡
  float w0 = 0.005 + 0.004 * fract(aSeed.w * 3.7);
  float w = max(w0, dist * uPix * 0.75);
  vec3 wp = p + dir * (len * (position.y - 0.5)) + side * (w * position.x);
  float a = (w0 / w) * smoothstep(0.7, 2.6, dist) * (1.0 - smoothstep(0.38, 0.5, dist / uBox.x));
  float c = dot(toP / max(dist, 1e-3), uSunDir);
  vCol = uAmb + uSunCol * wPhase(c);
  vA = a * (0.55 + 0.45 * fract(aSeed.w * 13.3));
  gl_Position = kill > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const STREAK_FRAG = /* glsl */ `
varying vec3 vCol; varying float vA; varying vec2 vUv;
void main(){
  float x = 1.0 - abs(vUv.x) * 2.0;                                           // 中间亮、两边淡
  float e = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.55, vUv.y);      // 头尾渐隐
  gl_FragColor = vec4(vCol, vA * x * e);
}`;

const SPLASH_VERT = /* glsl */ `
uniform float uTime, uRain, uQuayX, uHasMask; uniform vec3 uSunDir, uSunCol, uAmb, uMaskRect; uniform sampler2D uMask;
attribute vec4 aSeed;
varying vec3 vCol; varying float vA; varying vec2 vUv; varying float vLife;
${SHARED}
vec2 sHash(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
void main(){
  vUv = position.xy;
  // 每朵水花活零点几秒就换一个落点
  float period = 0.26 + 0.14 * aSeed.z;
  float tt = uTime / period + aSeed.w * 10.0; float cyc = floor(tt); float life = fract(tt);
  vec2 r = sHash(aSeed.xy * 91.7 + cyc * 0.371);
  vec2 rr = r - 0.5; rr *= 0.35 + 1.3 * abs(rr);                    // 落点往玩家脚下集中
  vec2 snap = floor(cameraPosition.xz / 4.0) * 4.0;
  vec3 p = vec3(snap.x + rr.x * 30.0, 0.0, snap.y + rr.y * 30.0);
  float kill = 0.0;
  // 水花优先落在水洼里：干一点的路面上只留三成
  vec2 muv = (p.xz - uMaskRect.xy) * uMaskRect.z;
  float inM = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
  float pud = step(0.5, textureLod(uMask, muv, 0.0).r) * inM * uHasMask;
  float k = fract(aSeed.w * 5.3 + cyc * 0.17);
  if (pud < 0.5 && k > 0.3) kill = 1.0;
  if (k > 0.2 + 0.8 * uRain) kill = 1.0;
  if (p.x > uQuayX - 0.3 || wInside(p + vec3(0.0, 0.2, 0.0))) kill = 1.0;
  float sz = mix(0.04, 0.08, aSeed.z) * mix(0.65, 1.0, pud);
  float wd = sz * (0.7 + 1.5 * life), ht = sz * (0.4 + 1.3 * sin(life * 3.14159));   // 越来越宽；先升后落
  vec3 toP = p - cameraPosition; float dist = length(toP);
  vec3 side = normalize(vec3(toP.z, 0.0, -toP.x) + vec3(1e-6, 0.0, 0.0));
  vec3 wp = p + side * (wd * position.x * 2.0) + vec3(0.0, ht * position.y + 0.004, 0.0);
  float c = dot(toP / max(dist, 1e-3), uSunDir);
  vCol = uAmb * 1.4 + uSunCol * wPhase(c) * 0.8;
  vA = (1.0 - life) * (1.0 - smoothstep(11.0, 15.0, dist)) * mix(0.5, 1.0, pud);
  vLife = life;
  gl_Position = kill > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const SPLASH_FRAG = /* glsl */ `
varying vec3 vCol; varying float vA; varying vec2 vUv; varying float vLife;
void main(){
  float x = vUv.x * 2.0, y = vUv.y;
  // 一顶小"皇冠"：一圈往外张开的水边，中间一个很快消失的亮点
  float dome = smoothstep(1.0, 0.25, length(vec2(x * 1.15, y * 1.5)));
  float crown = dome * (0.35 + 0.65 * smoothstep(0.25, 0.75, length(vec2(x, y * 1.4))));
  float core = smoothstep(0.5, 0.0, length(vec2(x * 1.6, (y - 0.25) * 1.6))) * (1.0 - vLife);
  float a = clamp(crown * 0.5 + core * 0.8, 0.0, 1.0) * vA * 0.6;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
}`;

export interface RainShelter {
  /** 室内范围（屋里不下雨）。 */
  boxes: THREE.Box3[];
  /** 屋顶的破洞在地面上的投影（雨从这里漏进屋）。 */
  holes: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  /** 屋檐滴水线：沿 x 从 x0 到 x1，位置 z，檐口高 y。 */
  eave?: { x0: number; x1: number; z: number; y: number };
}

/** count 是雨丝的根数；quayX 是码头边沿（往外是海，雨可以落到海面那么低）。 */
export function createRain(count: number, quayX: number) {
  const rng = mulberry32(7), DRIPS = 260;
  const boxMin = Array.from({ length: MAX_BOXES }, () => new THREE.Vector3()), boxMax = Array.from({ length: MAX_BOXES }, () => new THREE.Vector3());
  const sky = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(0, 0, -1, -1));
  const shared = {
    uTime: { value: 0 }, uRain: { value: 0.6 }, uBoxMin: { value: boxMin }, uBoxMax: { value: boxMax }, uQuayX: { value: quayX },
    uSunDir: { value: SUN_DIR }, uSunCol: { value: SUN_COLOR.clone().multiplyScalar(1.9) }, uAmb: { value: SKY.fog.clone().multiplyScalar(0.15) },
  };
  const streakU = { ...shared, uSky: { value: sky }, uPix: { value: 0.002 }, uDrip: { value: 0 }, uVel: { value: VEL }, uBox: { value: BOX }, uEave: { value: new THREE.Vector4(0, 0, 0, 7) } };
  const opts = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false } as const;
  const streaks = new THREE.Mesh(quads(count + DRIPS, rng, DRIPS), new THREE.ShaderMaterial({ uniforms: streakU, vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, ...opts }));
  const splashU = { ...shared, uMask: { value: null as THREE.Texture | null }, uMaskRect: { value: new THREE.Vector3(0, 0, 1) }, uHasMask: { value: 0 } };
  const splashes = new THREE.Mesh(quads(Math.round(count / 10), rng), new THREE.ShaderMaterial({ uniforms: splashU, vertexShader: SPLASH_VERT, fragmentShader: SPLASH_FRAG, ...opts }));
  const group = new THREE.Group();
  for (const [m, order] of [[streaks, 900], [splashes, 890]] as const) { m.frustumCulled = false; m.renderOrder = order; m.matrixAutoUpdate = false; group.add(m); }
  group.name = 'rain';

  return {
    group,
    /** pixelHeight 是画面的像素高度：用来算"一个像素在一米外有多宽"。 */
    update(t: number, camera: THREE.PerspectiveCamera, pixelHeight: number) {
      shared.uTime.value = t;
      streakU.uPix.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, pixelHeight);
    },
    /** 告诉雨哪里是屋里。 */
    setShelter(s: RainShelter) {
      for (let i = 0; i < MAX_BOXES; i++) {
        const b = s.boxes[i];
        if (b) { boxMin[i].set(b.min.x - 0.15, b.min.y - 1, b.min.z - 0.15); boxMax[i].set(b.max.x + 0.15, b.max.y + 0.3, b.max.z + 0.15); } else { boxMin[i].set(0, 0, 0); boxMax[i].set(0, 0, 0); }
      }
      for (let i = 0; i < MAX_HOLES; i++) {
        const h = s.holes[i];
        if (h) sky[i].set((h.minX + h.maxX) / 2, (h.minZ + h.maxZ) / 2, (h.maxX - h.minX) / 2, (h.maxZ - h.minZ) / 2); else sky[i].set(0, 0, -1, -1);
      }
      streakU.uDrip.value = s.eave ? 1 : 0;
      if (s.eave) streakU.uEave.value.set(s.eave.x0, s.eave.x1, s.eave.z, s.eave.y);
    },
    /** 积水掩码（r 通道 ≥ 0.5 表示那里有水）：水花优先落在水洼里。rect = (左下角 x, 左下角 z, 1/边长)。 */
    setPuddleMask(tex: THREE.Texture, x0: number, z0: number, invSize: number) {
      splashU.uMask.value = tex; splashU.uMaskRect.value.set(x0, z0, invSize); splashU.uHasMask.value = 1;
    },
    dispose() { streaks.geometry.dispose(); splashes.geometry.dispose(); (streaks.material as THREE.Material).dispose(); (splashes.material as THREE.Material).dispose(); },
  };
}
