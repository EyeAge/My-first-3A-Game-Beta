import * as THREE from 'three';
import { mulberry32, pick } from '../core/math';
import { Colliders } from './colliders';
import { buildDetails, type BoxSpec } from './details';
import { NavGrid } from './nav';
import { reflectionUniforms, type ReflectionUniforms } from '../render/reflection';
import { SUN_DIR } from './atmosphere';
import { asphaltTexture, containerEndTexture, containerSideTexture, corrugationNormal, signTexture, stencilTexture, windowsTexture } from './textures';

// 激战港区 · 四号泊位。
// 坐标约定：+x 是东（海在东边），-z 是北。玩家从西南角进场，撤离艇在码头南端。

export const QUAY_X = 62;
export const BOUNDS = { minX: -110, maxX: QUAY_X, minZ: -100, maxZ: 100 };
const CW = 2.44, CH = 2.59, CL = 12.19; // 40 尺集装箱的宽、高、长

export interface Relay {
  id: number; name: string; short: string;
  pos: THREE.Vector3; cut: boolean;
  setCut(): void;
  reset(): void;
}
export interface Port {
  group: THREE.Group;
  colliders: Colliders;
  nav: NavGrid;
  relays: Relay[];
  playerStart: THREE.Vector3;
  evacPos: THREE.Vector3;
  sun: THREE.DirectionalLight;
  ground: THREE.Mesh;
  reflection: ReflectionUniforms;
  setLampCount(n: number): void;
  update(t: number, focus: THREE.Vector3): void;
}

const PALETTE = [0x9a3b26, 0x1f5488, 0x1d6f6c, 0xb85a1c, 0x70787c, 0x2f6240, 0xb38d2c, 0xb5b2a8, 0x24304a, 0x7a2430];
const BRANDS: [string, string][] = [['激战远洋', '集装箱运输'], ['激战北航', '北极 · 大西洋 · 支线运输'], ['激战太平洋', '远洋 · 冷链 · 散货'], ['激战联运', '多式联运']];

export function buildPort(progress: (msg: string) => void): Port {
  const rng = mulberry32(4207);
  const group = new THREE.Group();
  const colliders = new Colliders();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const col = new THREE.Color();

  // ---------------------------------------------------------------- 地面
  progress('正在生成港区地面');
  const asphalt = asphaltTexture();
  asphalt.repeat.set(70, 90);
  const groundMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.5, metalness: 0, envMapIntensity: 1.0 });
  // 往标准材质里注入一段着色器：按世界坐标的噪声决定哪里是积水。
  // 积水处粗糙度趋近 0，于是像镜子一样反射天空，这就是"湿地面"的全部秘密。
  const reflection = reflectionUniforms();
  groundMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, reflection);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec4 vRefl;\nuniform mat4 uReflM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRefl = uReflM * vec4(vWp, 1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vWp;
        float phash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(phash(i), phash(i+vec2(1,0)), f.x), mix(phash(i+vec2(0,1)), phash(i+vec2(1,1)), f.x), f.y); }
        float pfbm(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*pnoise(p); p = p*2.03 + 5.3; a *= 0.5; } return s; }
        float gPud;
        varying vec4 vRefl;
        uniform sampler2D tRefl; uniform float uReflOn; uniform float uReflTime;
        // 雨点打在积水上的涟漪：把水面分成格子，每格里有一圈按各自节奏不断扩散的环
        vec2 rip(vec2 p, float t){
          vec2 i = floor(p), f = fract(p) - 0.5;
          float h = phash(i), tt = fract(t * 0.8 + h);
          vec2 d = f - (vec2(phash(i + 7.3), phash(i + 3.1)) - 0.5) * 0.5;
          float r = length(d), ring = r - tt * 0.45;
          return d / max(r, 1e-3) * sin(ring * 42.0) * smoothstep(0.07, 0.0, abs(ring)) * (1.0 - tt);
        }`)
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
        gPud = smoothstep(0.47, 0.6, pfbm(vWp.xz * 0.085));
        diffuseColor.rgb *= mix(1.0, 0.4, gPud);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `float roughnessFactor = roughness;
        float gWet = pfbm(vWp.xz * 0.7 + 3.0);
        roughnessFactor = mix(mix(0.62, 0.3, gWet), 0.03, gPud);`)
      // 平面反射：用镜像相机拍到的画面替换掉"只有天空"的环境反射。越粗糙的地方采样越模糊的层级，占比也越低
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
        if (uReflOn > 0.5) {
          vec2 rp = (rip(vWp.xz * 1.4, uReflTime) + rip(vWp.xz * 2.3 + 7.0, uReflTime + 0.37)) * gPud;
          vec2 rough = (vec2(pnoise(vWp.xz * 9.0), pnoise(vWp.xz * 9.0 + 31.0)) - 0.5) * (1.0 - gPud);
          vec2 ruv = vRefl.xy / vRefl.w + rp * 0.02 + rough * 0.012;
          vec3 refl = textureLod(tRefl, ruv, roughnessFactor * 4.5).rgb;
          float fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
          reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, refl * fres, 1.0 - smoothstep(0.4, 0.9, roughnessFactor));
        }`);
  };
  groundMat.customProgramCacheKey = () => 'wet-ground-refl';
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(462, 600), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(QUAY_X - 231, 0, 0);
  ground.receiveShadow = true;
  group.add(ground);

  // ---------------------------------------------------------------- 通用"盒子"批次
  // 起重机钢梁、灯杆、围墙、木箱……所有方盒子都塞进同一个 InstancedMesh，一次绘制调用画完。
  const beamList: { m: THREE.Matrix4; c: number }[] = [];
  const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number, solid = false) => {
    beamList.push({ m: new THREE.Matrix4().compose(v1.set(cx, cy, cz), q.identity(), v2.set(sx, sy, sz)), c });
    if (solid) colliders.add(cx, cy, cz, sx, sy, sz);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  /** 在两点之间架一根斜梁。 */
  const beam = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, th: number, c: number, th2 = th) => {
    const d = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = d.length();
    q.setFromUnitVectors(UP, d.normalize());
    beamList.push({ m: new THREE.Matrix4().compose(v1.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), q.clone(), v2.set(th, len, th2)), c });
  };

  // ---------------------------------------------------------------- 集装箱
  progress('正在生成涂装、锈迹与雨水');
  const corr = corrugationNormal();
  const topMat = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.35, metalness: 0.3 });
  const variants = BRANDS.map(([brand, sub], i) => {
    const side = new THREE.MeshStandardMaterial({ map: containerSideTexture(brand, sub, i + 1), normalMap: corr, roughness: 0.48, metalness: 0.3 });
    const end = new THREE.MeshStandardMaterial({ map: containerEndTexture(i + 1), roughness: 0.5, metalness: 0.3 });
    return { mats: [side, side, topMat, topMat, end, end], items: [] as { x: number; y: number; z: number; rot: number; c: number }[] };
  });
  const addContainer = (x: number, y: number, z: number, rot: number, c: number) => {
    variants[Math.floor(rng() * variants.length)].items.push({ x, y, z, rot, c });
  };
  // 堆场里的箱子额外加上立体的角柱、上下纵梁和箱门锁杆：光靠贴图，侧光下看不出棱角
  const yard: BoxSpec[] = [];
  const hardware = (x: number, y: number, z: number, rot: number, c: number) => {
    const frame = col.setHex(c).multiplyScalar(0.62).getHex();
    const part = (lx: number, ly: number, lz: number, sx: number, sy: number, sz: number, color: number) =>
      rot ? box(x + lz, y + ly, z - lx, sz, sy, sx, color) : box(x + lx, y + ly, z + lz, sx, sy, sz, color);
    for (const a of [-1, 1]) {
      for (const b of [-1, 1]) {
        part(a * (CW / 2 - 0.05), 0, b * (CL / 2 - 0.05), 0.13, CH, 0.13, frame);
        part(a * (CW / 2 - 0.04), b * (CH / 2 - 0.07), 0, 0.1, 0.14, CL - 0.2, frame);
      }
      for (const lx of [0.34, 0.84]) part(a * lx, 0, CL / 2 + 0.025, 0.04, CH - 0.36, 0.04, 0x8a8f92);
      part(a * 0.59, -0.15, CL / 2 + 0.05, 0.36, 0.04, 0.03, 0x8a8f92); // 锁杆把手
    }
  };
  /** 码一摞箱子，并登记一个整摞的碰撞盒。 */
  const stack = (x: number, z: number, h: number, rot = 0, color?: number) => {
    for (let k = 0; k < h; k++) {
      const c = color ?? pick(rng, PALETTE), y = CH / 2 + k * CH;
      addContainer(x, y, z, rot, c);
      yard.push({ x, y, z, rot });
      hardware(x, y, z, rot, c);
    }
    if (h > 0) colliders.add(x, (h * CH) / 2, z, rot ? CL : CW, h * CH, rot ? CW : CL);
  };

  progress('正在布置集装箱');
  const blockXs = [-58, -44, -30, -6, 8, 22];
  const segZs = [-63.4, -31.7, 0, 31.7, 63.4];
  for (const bx of blockXs) for (const sz of segZs) {
    if (bx === 8 && sz === 0) continue; // 留出甲号中继所在的空场
    const blockColor = rng() < 0.35 ? pick(rng, PALETTE) : undefined; // 有些堆位是同一家船公司的货
    for (let row = -1; row <= 1; row++) for (const bay of [-1, 1]) {
      const h = rng() < 0.07 ? 0 : rng() < 0.12 ? 4 : 1 + Math.floor(rng() * 3);
      stack(bx + row * (CW + 0.2), sz + bay * (CL / 2 + 0.15), h, 0, blockColor);
    }
  }
  // 主干道和码头前沿的零散箱子，充当掩体
  stack(-22.5, 30, 1); stack(-13.5, 2, 2); stack(-22.5, -34, 1); stack(-13.5, -62, 1);
  stack(40, 62, 2, 1); stack(46, -72, 1, 1); stack(31, 10, 1); stack(31, -44, 2); stack(47, 24, 1, 1); stack(41, -30, 1, 1);
  stack(-68, 52, 1); stack(-68, -58, 2);

  // ---------------------------------------------------------------- 起重机
  progress('正在架设起重机');
  const CRANE = 0x8a4a1c, CRANE_D = 0x2a2d30;
  const craneLights: THREE.Vector3[] = [];
  const crane = (cz: number, trolleyX: number) => {
    const X1 = 34, X2 = 58, Z = 8, TOP = 42;
    for (const x of [X1, X2]) for (const s of [-1, 1]) {
      box(x, TOP / 2, cz + s * Z, 1.5, TOP, 1.5, CRANE, true);
      box(x, 0.5, cz + s * Z, 2.6, 1, 4.2, CRANE_D, true); // 行走台车
    }
    for (const y of [14, TOP]) {
      for (const x of [X1, X2]) box(x, y, cz, 1.2, 1.4, Z * 2, CRANE);
      for (const s of [-1, 1]) box((X1 + X2) / 2, y, cz + s * Z, X2 - X1, 1.4, 1.2, CRANE);
    }
    for (const s of [-1, 1]) {
      beam(X1, 14, cz + s * Z, X2, TOP, cz + s * Z, 0.7, CRANE);
      beam(X2, 14, cz + s * Z, X1, TOP, cz + s * Z, 0.7, CRANE);
    }
    for (const x of [X1, X2]) { beam(x, 14, cz - Z, x, 28, cz + Z, 0.6, CRANE); beam(x, 14, cz + Z, x, 28, cz - Z, 0.6, CRANE); }
    // 大梁和伸向海面的前臂
    for (const s of [-1, 1]) box(63, TOP + 2, cz + s * 3, 84, 2.4, 1.4, CRANE);
    for (let x = 24; x <= 104; x += 8) box(x, TOP + 2, cz, 0.6, 0.8, 6, CRANE);
    // A 字架和拉索
    for (const s of [-1, 1]) {
      beam(42, TOP + 3, cz + s * 3, 54, 62, cz + s * 1.2, 1.0, CRANE);
      beam(64, TOP + 3, cz + s * 3, 54, 62, cz + s * 1.2, 1.0, CRANE);
      beam(54, 62, cz + s * 1.2, 102, TOP + 3.4, cz + s * 3, 0.32, CRANE_D);
      beam(54, 62, cz + s * 1.2, 82, TOP + 3.4, cz + s * 3, 0.28, CRANE_D);
      beam(54, 62, cz + s * 1.2, 23, TOP + 3.4, cz + s * 3, 0.32, CRANE_D);
    }
    box(54, 62, cz, 1.4, 1.2, 4, CRANE);
    box(38, TOP + 6, cz, 11, 5.5, 8.5, 0x3a4046); // 机房
    // 小车、司机室、吊具
    box(trolleyX, TOP + 0.4, cz, 5, 1.2, 7, CRANE_D);
    box(trolleyX + 2, TOP - 2, cz + 2.4, 2.8, 2.8, 2.8, 0x4a5258);
    for (const s of [-1, 1]) for (const e of [-1, 1]) beam(trolleyX + e * 1, TOP, cz + s * 2, trolleyX + e * 1, 26.6, cz + s * 4, 0.1, CRANE_D);
    box(trolleyX, 26.3, cz, 2.6, 0.5, 12.4, 0xb38d2c);
    addContainer(trolleyX, 26 - CH / 2, cz, 0, pick(rng, PALETTE));
    craneLights.push(new THREE.Vector3(54, 62.9, cz), new THREE.Vector3(104.5, TOP + 3.6, cz), new THREE.Vector3(21.5, TOP + 3.6, cz));
  };
  crane(-42, 78);
  crane(20, 86);

  // ---------------------------------------------------------------- 货轮
  const HULL = 0x121c26;
  box(84, 3, -30, 36, 12, 130, HULL, true);
  box(84, 0.1, -30, 36.3, 2.2, 130.3, 0x6a1f18);
  box(84, 9.3, -30, 36.6, 0.9, 130.6, 0x1a2630);
  for (let r = 0; r < 12; r++) for (let b = 0; b < 7; b++) {
    const h = 1 + Math.floor(rng() * 4);
    for (let k = 0; k < h; k++) addContainer(69.6 + r * 2.62, 9.75 + CH / 2 + k * CH, -86 + b * 12.6, 0, pick(rng, PALETTE));
  }
  box(84, 20, 20, 30, 21, 18, 0xa9aaa4); // 船楼
  box(84, 31.5, 20, 34, 2.4, 14, 0x9c9d98);
  box(84, 36, 26, 5, 8, 6, 0x2a3138); // 烟囱
  box(84, 37.5, 26, 5.2, 1.4, 6.2, 0xb85a1c);
  const winTex = windowsTexture(18, 5, 11, 0.3);
  const winMat = new THREE.MeshBasicMaterial({ map: winTex, color: new THREE.Color(2.2, 2.2, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(18, 14), winMat);
  win.rotation.y = -Math.PI / 2; win.position.set(68.95, 22, 20);
  group.add(win);
  const win2 = new THREE.Mesh(new THREE.PlaneGeometry(26, 14), winMat);
  win2.rotation.y = Math.PI; win2.position.set(84, 22, 10.95);
  group.add(win2);

  // ---------------------------------------------------------------- 仓库
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x59636a, roughness: 0.55, metalness: 0.25, normalMap: corrugationNormal(110) });
  const wh = new THREE.Mesh(new THREE.BoxGeometry(32, 11, 72), wallMat);
  wh.position.set(-90, 5.5, 0); wh.castShadow = wh.receiveShadow = true;
  group.add(wh);
  colliders.add(-90, 5.5, 0, 32, 11, 72);
  box(-90, 11.3, 0, 33.4, 0.7, 73.4, 0x30363a);
  for (const z of [-22, 22]) { box(-73.9, 3.2, z, 0.25, 6.4, 8, 0x23282c); box(-73.8, 6.6, z, 0.4, 0.5, 8.6, 0xb38d2c); }
  const plane = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, emissive = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.1, emissiveMap: emissive ? tex : null, emissive: new THREE.Color(emissive ? 0xffffff : 0), emissiveIntensity: emissive }));
    m.position.set(x, y, z); m.rotation.y = ry;
    group.add(m);
    return m;
  };
  plane(signTexture(['四号泊位维修车间', '激战港区 · 港务局'], { w: 1024, h: 180, bg: '#1b2227', fg: '#e8e4da', size: 84 }), 17, 3, -73.85, 8.9, 0, Math.PI / 2, 0.25);
  plane(signTexture(['危险', '请勿靠近 · 自动作业车辆'], { stripe: true }), 2.4, 1.2, -73.85, 2.4, 11, Math.PI / 2);
  plane(signTexture(['门禁控制', '仅限授权人员'], { bg: '#b53a24', fg: '#f3ece0' }), 2.0, 1.0, -73.85, 2.4, -11, Math.PI / 2);

  // ---------------------------------------------------------------- 围墙与岸壁
  const WALL = 0x4a4d4e;
  box(-24, 2.2, BOUNDS.minZ - 0.6, 176, 4.4, 1.2, WALL, true);
  box(-24, 2.2, BOUNDS.maxZ + 0.6, 176, 4.4, 1.2, WALL, true);
  box(BOUNDS.minX - 0.6, 2.2, 0, 1.2, 4.4, 202, WALL, true);
  box(QUAY_X + 0.4, -1.6, 0, 0.8, 3.2, 600, 0x3c3f40); // 岸壁
  for (let z = -96; z <= 96; z += 12) box(QUAY_X - 0.9, 0.35, z, 0.7, 0.7, 0.7, 0x1e2022, true); // 系缆桩

  // ---------------------------------------------------------------- 撤离艇
  const evacPos = new THREE.Vector3(66, 0, 90);
  box(66.1, -0.8, 90, 7.8, 1.6, 16, 0x2b3238, true);
  box(66.1, 0.05, 90, 8.2, 0.25, 16.4, 0x9a3b26);
  box(66.6, 1.4, 84.6, 4.6, 2.8, 4.2, 0x8f9498, true);
  box(66.6, 2.95, 84.6, 5.2, 0.3, 4.8, 0x2b3238);
  for (const z of [82.2, 97.8]) box(66.1, 0.6, z, 7.6, 0.1, 0.1, 0xb38d2c);
  box(69.9, 0.6, 90, 0.1, 0.1, 15.6, 0xb38d2c);
  plane(signTexture(['激战撤离艇', '四号登船点'], { bg: '#1b2227', fg: '#ffb347' }), 3.2, 1.6, 64.25, 1.5, 84.6, -Math.PI / 2, 0.5);

  // ---------------------------------------------------------------- 中继
  const relays: Relay[] = [];
  const relayDefs: [string, string, number, number, number][] = [['甲号中继 · 堆场', '甲', 8, 0, 0], ['乙号中继 · 仓库', '乙', -72.4, 0, Math.PI / 2], ['丙号中继 · 码头', '丙', 48, -8, 0]];
  const beamGeo = new THREE.CylinderGeometry(0.16, 0.16, 70, 6, 1, true);
  relayDefs.forEach(([name, short, x, z, ry], id) => {
    colliders.add(x, 1.1, z, 1.5, 2.2, 1.5);
    box(x, 1.1, z, 1.4, 2.2, 1.0, 0x2c3338);
    box(x, 2.3, z, 1.6, 0.12, 1.2, 0x1b1f22);
    beam(x, 2.3, z, x, 8.5, z, 0.14, 0x565c60);
    box(x, 8.0, z, 1.6, 0.9, 0.2, 0x9a9d9a);
    const sign = plane(signTexture([name, '港区主控上行链路 · 检修前请断电'], { bg: '#1b2227', fg: '#ffb347', size: 70 }), 1.25, 0.62, x, 1.55, z, ry, 0.6);
    sign.position.x += Math.sin(ry) * 0.52; sign.position.z += Math.cos(ry) * 0.52;
    if (ry === 0) { const s2 = sign.clone(); s2.rotation.y = Math.PI; s2.position.z = z - 0.52; group.add(s2); }
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.5, 0.3) });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), lampMat);
    lamp.position.set(x, 8.75, z);
    group.add(lamp);
    // 一束直通天空的信号光柱，隔着几排集装箱也能看见中继在哪
    const shaftMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.5, 0.12), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const shaft = new THREE.Mesh(beamGeo, shaftMat);
    shaft.position.set(x, 8.5 + 35, z);
    group.add(shaft);
    const relay: Relay = {
      id, name, short, pos: new THREE.Vector3(x, 1.2, z), cut: false,
      setCut() { this.cut = true; lampMat.color.setRGB(0.3, 4, 1.2); shaft.visible = false; },
      reset() { this.cut = false; lampMat.color.setRGB(5, 0.5, 0.3); shaft.visible = true; },
    };
    relays.push(relay);
  });

  // ---------------------------------------------------------------- 路灯
  const lampPos: THREE.Vector3[] = [];
  const pole = (x: number, z: number, dir: number) => {
    box(x, 5, z, 0.26, 10, 0.26, 0x3a3f42, true);
    box(x + dir * 1.1, 9.9, z, 2.4, 0.16, 0.16, 0x3a3f42);
    lampPos.push(new THREE.Vector3(x + dir * 2.1, 9.7, z));
  };
  for (const z of [-79, -47.55, -15.85, 15.85, 47.55, 82]) { pole(-26.6, z, 1); pole(-9.4, z, -1); }
  for (const z of [-90, -62, -18, 2, 44, 72]) pole(28.6, z, 1);
  for (const z of [-48, 0, 48]) pole(-63.4, z, -1);
  pole(60.4, 78, -1); pole(60.4, -80, -1);
  const lampGeo = new THREE.BoxGeometry(0.9, 0.14, 0.36);
  const lampHeads = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 3.8, 1.5) }), lampPos.length + craneLights.length);
  lampPos.forEach((p, i) => lampHeads.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
  craneLights.forEach((p, i) => { lampHeads.setMatrixAt(lampPos.length + i, m4.compose(p, q.identity(), v2.set(0.5, 3, 1.2))); lampHeads.setColorAt(lampPos.length + i, col.setRGB(1, 0.06, 0.05)); });
  lampPos.forEach((_, i) => lampHeads.setColorAt(i, col.setRGB(1, 1, 1)));
  group.add(lampHeads);
  // 真正发光的点光源只有几盏，哪几盏路灯离玩家最近就"借"给谁
  const lightPool: THREE.PointLight[] = [];
  for (let i = 0; i < 8; i++) {
    const l = new THREE.PointLight(0xffa858, 0, 46, 1.6);
    lightPool.push(l); group.add(l);
  }
  let lampCount = 6;

  // ---------------------------------------------------------------- 杂物：护栏、油桶、木箱、路锥
  const drums: { x: number; z: number; c: number }[] = [];
  const cones: { x: number; z: number }[] = [];
  const barrier = (x: number, z: number, alongX: boolean) => box(x, 0.45, z, alongX ? 2.4 : 0.6, 0.9, alongX ? 0.6 : 2.4, 0x8d8f8c, true);
  const crates = (x: number, z: number, n: number) => {
    for (let i = 0; i < n; i++) { const s = 1.1 + rng() * 0.2; box(x + (i % 2) * 1.3, 0.55 + Math.floor(i / 2) * 1.12, z + (rng() - 0.5) * 0.2, s, 1.1, s, pick(rng, [0x6b5236, 0x5a4a34, 0x4b5a3c])); }
    colliders.add(x + 0.65, Math.ceil(n / 2) * 0.56, z, 2.6, Math.ceil(n / 2) * 1.12, 1.4);
  };
  const drumCluster = (x: number, z: number, n: number) => {
    for (let i = 0; i < n; i++) drums.push({ x: x + (i % 3) * 0.66, z: z + Math.floor(i / 3) * 0.66, c: pick(rng, [0x1f5488, 0x9a3b26, 0x2f6240, 0x70787c]) });
    colliders.add(x + 0.66, 0.46, z + (Math.ceil(n / 3) - 1) * 0.33, 2.0, 0.92, Math.ceil(n / 3) * 0.66 + 0.1);
  };
  for (const z of [70, 22, -24, -70]) { barrier(-21.5, z, true); barrier(-14.5, z - 9, true); }
  for (const z of [60, 34, -4, -56, -84]) { barrier(38 + rng() * 14, z, rng() < 0.5); barrier(34 + rng() * 20, z + 6, rng() < 0.5); }
  barrier(-66, 20, false); barrier(-70, -26, false); barrier(8, -8.5, true); barrier(8, 8.5, true);
  crates(-16.6, 54, 4); crates(-20.6, -48, 3); crates(42, 40, 4); crates(52, -52, 3); crates(-68, -8, 4); crates(38, -14, 2); crates(50, 76, 4);
  drumCluster(-24.4, 8, 6); drumCluster(-12.6, -40, 5); drumCluster(30, 30, 6); drumCluster(54, 4, 4); drumCluster(-64.5, 30, 6); drumCluster(44, -86, 5);
  for (let i = 0; i < 26; i++) cones.push({ x: -25 + rng() * 14, z: -95 + rng() * 190 });
  for (let i = 0; i < 16; i++) cones.push({ x: 30 + rng() * 28, z: -95 + rng() * 190 });

  // ---------------------------------------------------------------- 地面标线
  progress('正在刷地面标线');
  const marks: { x: number; z: number; w: number; l: number; c: number }[] = [];
  const WHITE = 0xb9b6ac, YEL = 0xb38d2c;
  for (let z = -96; z <= 96; z += 6) marks.push({ x: -18, z, w: 0.18, l: 3, c: WHITE });
  for (const x of [-25.7, -10.3]) marks.push({ x, z: 0, w: 0.16, l: 196, c: YEL });
  for (const z of [-47.55, -15.85, 15.85, 47.55]) for (let x = -24.6; x <= -11.2; x += 1.1) marks.push({ x, z, w: 0.55, l: 4, c: WHITE });
  for (let x = -24.6; x <= -11.2; x += 1.1) marks.push({ x, z: 86, w: 0.55, l: 4, c: WHITE });
  for (const x of [34, 58]) { marks.push({ x: x - 0.4, z: 0, w: 0.12, l: 198, c: 0x1c1e20 }); marks.push({ x: x + 0.4, z: 0, w: 0.12, l: 198, c: 0x1c1e20 }); }
  marks.push({ x: QUAY_X - 1.8, z: 0, w: 0.3, l: 198, c: YEL }, { x: 27.4, z: 0, w: 0.2, l: 198, c: YEL });
  for (let z = -90; z <= 90; z += 20) marks.push({ x: 46, z, w: 22, l: 0.16, c: YEL });
  const markGeo = new THREE.PlaneGeometry(1, 1); markGeo.rotateX(-Math.PI / 2);
  const markMesh = new THREE.InstancedMesh(markGeo, new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, transparent: true, opacity: 0.8 }), marks.length);
  marks.forEach((mk, i) => { markMesh.setMatrixAt(i, m4.compose(v1.set(mk.x, 0.012, mk.z), q.identity(), v2.set(mk.w, 1, mk.l))); markMesh.setColorAt(i, col.setHex(mk.c)); });
  markMesh.receiveShadow = true;
  group.add(markMesh);
  for (const [x, z] of [[46, 50], [46, -60]]) {
    const st = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), new THREE.MeshStandardMaterial({ map: stencilTexture('B4'), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    st.rotation.x = -Math.PI / 2; st.rotation.z = -Math.PI / 2; st.position.set(x, 0.014, z);
    group.add(st);
  }

  group.add(buildDetails(yard, CW, CH, CL, colliders, BOUNDS));

  // ---------------------------------------------------------------- 把收集到的东西变成网格
  const cGeo = new THREE.BoxGeometry(CW, CH, CL);
  for (const v of variants) {
    const mesh = new THREE.InstancedMesh(cGeo, v.mats, v.items.length);
    v.items.forEach((it, i) => {
      mesh.setMatrixAt(i, m4.compose(v1.set(it.x, it.y, it.z), q.setFromAxisAngle(UP, it.rot * Math.PI / 2), v2.set(1, 1, 1)));
      mesh.setColorAt(i, col.setHex(it.c).multiplyScalar(1.5));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }), beamList.length);
  beamList.forEach((b, i) => { beamMesh.setMatrixAt(i, b.m); beamMesh.setColorAt(i, col.setHex(b.c)); });
  beamMesh.castShadow = beamMesh.receiveShadow = true;
  group.add(beamMesh);
  const drumMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.3, 0.92, 14), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 }), drums.length);
  drums.forEach((d, i) => { drumMesh.setMatrixAt(i, m4.makeTranslation(d.x, 0.46, d.z)); drumMesh.setColorAt(i, col.setHex(d.c)); });
  drumMesh.castShadow = drumMesh.receiveShadow = true;
  group.add(drumMesh);
  const coneMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.2, 0.62, 10), new THREE.MeshStandardMaterial({ color: 0xd2622a, roughness: 0.5 }), cones.length);
  let nc = 0;
  cones.forEach((c) => { if (!colliders.pointInside(c.x, 0.3, c.z)) coneMesh.setMatrixAt(nc++, m4.makeTranslation(c.x, 0.31, c.z)); });
  coneMesh.count = nc;
  coneMesh.castShadow = true;
  group.add(coneMesh);

  // ---------------------------------------------------------------- 光照
  const hemi = new THREE.HemisphereLight(0x8fa6c0, 0x26241f, 0.5);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb888, 1.25);
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.06;
  group.add(sun, sun.target);

  const nav = new NavGrid(BOUNDS.minX, BOUNDS.minZ, BOUNDS.maxX, BOUNDS.maxZ, colliders);

  const order = lampPos.map((_, i) => i);
  let lastSort = -1;
  return {
    group, colliders, nav, relays, evacPos, sun, ground, reflection,
    playerStart: new THREE.Vector3(-18, 0, 93),
    setLampCount(n) { lampCount = n; lastSort = -1; },
    update(t, focus) {
      // 阴影相机跟着玩家走，并按整米对齐，避免阴影边缘抖动
      const fx = Math.round(focus.x / 4) * 4, fz = Math.round(focus.z / 4) * 4;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx, 0, fz).addScaledVector(SUN_DIR, 200);
      if (t - lastSort > 0.4) {
        lastSort = t;
        order.sort((a, b) => lampPos[a].distanceToSquared(focus) - lampPos[b].distanceToSquared(focus));
        lightPool.forEach((l, i) => {
          l.visible = i < lampCount && i < order.length;
          if (l.visible) { l.position.copy(lampPos[order[i]]); l.position.y -= 0.3; l.intensity = 75; }
        });
      }
    },
  };
}
