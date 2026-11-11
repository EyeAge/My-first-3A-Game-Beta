import * as THREE from 'three';
import { mulberry32 } from '../core/math';

// 天空、雨、海：气氛三件套。时间设定是 05:42，阴天，太阳刚从海面（东边）露头。

export const SUN_DIR = new THREE.Vector3(0.86, 0.2, -0.32).normalize();
export const FOG_COLOR = new THREE.Color().setRGB(0.15, 0.15, 0.16); // 线性空间的值，比地平线略暗，远处的东西会融成剪影

const SKY_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform float uTime;
varying vec3 vDir;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*noise(p); p = p*2.03 + 7.1; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  // 天顶是冷的石板灰蓝，地平线偏亮
  vec3 zenith = vec3(0.035, 0.045, 0.06);
  vec3 horizon = vec3(0.30, 0.29, 0.29);
  vec3 col = mix(horizon, zenith, pow(h, 0.45));
  // 太阳方向的暖色天光
  float az = max(dot(normalize(d.xz), normalize(uSun.xz)), 0.0);
  float glow = pow(az, 3.0) * exp(-h * 5.0);
  col += vec3(1.25, 0.62, 0.22) * glow * 0.9;
  col += vec3(1.6, 0.9, 0.4) * pow(max(dot(d, uSun), 0.0), 60.0) * 0.6;
  // 云层：把视线方向投到一个平面上取噪声
  vec2 uv = d.xz / (d.y + 0.22) * 1.3 + vec2(uTime * 0.006, 0.0);
  float c = fbm(uv * 1.4);
  float cloud = smoothstep(0.38, 0.75, c);
  vec3 cloudCol = mix(vec3(0.05, 0.055, 0.065), vec3(0.75, 0.42, 0.2) * (0.25 + glow), smoothstep(0.5, 0.2, c) * glow + 0.08);
  col = mix(col, cloudCol, cloud * smoothstep(-0.02, 0.25, d.y) * 0.85);
  if (d.y < 0.0) col = mix(col, vec3(0.05, 0.055, 0.06), smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

export function createSky() {
  const uniforms = { uSun: { value: SUN_DIR }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position, 0.0); gl_Position = projectionMatrix * vec4(p.xyz, 1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

/** 把天空烘成环境贴图：湿地面和海面反射的就是它。 */
export function bakeEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const sky = createSky();
  sky.mesh.scale.setScalar(50);
  // 烘焙时不能用"贴在远裁剪面"的写法，换一个普通材质版本
  (sky.mesh.material as THREE.ShaderMaterial).vertexShader = /* glsl */ `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  scene.add(sky.mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  sky.mesh.geometry.dispose();
  (sky.mesh.material as THREE.Material).dispose();
  return rt.texture;
}

export function createRain(count: number) {
  const BOX = new THREE.Vector3(36, 22, 36);
  const pos = new Float32Array(count * 2 * 3);
  const off = new Float32Array(count * 2 * 3);
  const end = new Float32Array(count * 2);
  const rng = mulberry32(7);
  for (let i = 0; i < count; i++) {
    const x = rng(), y = rng(), z = rng();
    for (let k = 0; k < 2; k++) {
      off.set([x, y, z], (i * 2 + k) * 3);
      end[i * 2 + k] = k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aOff', new THREE.BufferAttribute(off, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: BOX } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      attribute vec3 aOff; attribute float aEnd;
      uniform float uTime; uniform vec3 uCam; uniform vec3 uBox;
      varying float vA;
      void main(){
        vec3 fall = vec3(1.6, -19.0, 0.9);              // 雨带一点斜风
        vec3 p = aOff * uBox + fall * uTime * (0.8 + aOff.x * 0.4);
        p = mod(p - uCam, uBox) - uBox * 0.5 + uCam;     // 雨永远包在相机周围一个盒子里
        p += normalize(fall) * aEnd * (0.5 + aOff.z * 0.5);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vA = (1.0 - aEnd * 0.8) * smoothstep(18.0, 6.0, -mv.z) * smoothstep(0.3, 1.5, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `varying float vA; void main(){ gl_FragColor = vec4(0.72, 0.76, 0.8, vA * 0.38); }`,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  return { lines, uniforms };
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
