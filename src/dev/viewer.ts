import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { surface } from '../render/surfaces';
import { bakeEnvironment } from '../world/atmosphere';

// 模型查看器（只在开发时用，不会打进游戏的单文件里）。
//
// 搭模型的时候，不想每改一处都进游戏跑到那个东西跟前去看。这个页面只加载一个模型，从几个角度同时画出来：
//
//   npm run dev  然后打开
//   /viewer.html?m=world/forklift&fn=buildForklift&args=[{"forksUp":0.3}]
//
//   m      模块路径（相对 src/，不带 .ts）
//   fn     模块里导出的函数名。它可以返回 Object3D、{ group }，或者零件箱 finish() 出来的 PropModel
//   args   传给函数的参数，JSON 数组
//   views  取景，"方位角,仰角,距离" 用分号隔开，角度是度。不给就自动摆四个：前左、右侧、后右、俯视
//   target 镜头看向哪里 "x,y,z"，不给就看模型的中心
//   orbit=1  只开一个可以用鼠标拖动旋转的视图
//   boxes=1  把碰撞盒画成线框
//   light=game  用接近游戏里的光（低角度的暖色太阳 + 阴天天光）；默认是均匀的棚拍光，看造型更清楚
//   ground=0    不要地面
//   exp=1.2     曝光

const q = new URLSearchParams(location.search);
const info = document.getElementById('info')!;
const modules = import.meta.glob('../**/*.ts');

interface ModelLike { group: THREE.Object3D; boxes?: { min: number[]; max: number[] }[]; size?: number[] }

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
  gl.setPixelRatio(1);
  gl.setSize(innerWidth, innerHeight, false);
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = Number(q.get('exp') ?? 1);
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const game = q.get('light') === 'game';
  scene.background = new THREE.Color(game ? 0x1a1c20 : 0x2a2d31);
  scene.environment = bakeEnvironment(gl);
  scene.environmentIntensity = game ? 2 : 3.2;
  const sun = new THREE.DirectionalLight(game ? new THREE.Color(1, 0.72, 0.42) : new THREE.Color(1, 0.97, 0.92), game ? 6 : 2.6);
  sun.position.set(game ? 9 : 5, game ? 2.4 : 9, game ? 3.4 : 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  if (!game) scene.add(new THREE.HemisphereLight(0xcfd8e2, 0x4a4640, 0.9));

  const m = q.get('m'), fn = q.get('fn') ?? 'default';
  if (!m) { info.textContent = '用法：/viewer.html?m=world/forklift&fn=buildForklift&args=[...]'; return; }
  const load = modules[`../${m}.ts`] ?? modules[`./${m.replace(/^dev\//, '')}.ts`]; // 同目录下的模块，键是 ./ 开头的
  if (!load) throw new Error(`找不到模块 src/${m}.ts`);
  const mod = (await load()) as Record<string, (...a: unknown[]) => unknown>;
  if (typeof mod[fn] !== 'function') throw new Error(`src/${m}.ts 里没有导出函数 ${fn}`);
  const args = JSON.parse(q.get('args') ?? '[]') as unknown[];
  const t0 = performance.now();
  const out = (await mod[fn](...args)) as THREE.Object3D | ModelLike;
  const buildMs = performance.now() - t0;
  const model: ModelLike = (out as THREE.Object3D).isObject3D ? { group: out as THREE.Object3D } : (out as ModelLike);
  scene.add(model.group);

  const box = new THREE.Box3().setFromObject(model.group);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(0.2, size.length() / 2);
  if (q.get('ground') !== '0') {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(radius * 30, radius * 30), surface('concrete'));
    g.rotation.x = -Math.PI / 2; g.position.y = Math.min(0, box.min.y) - 0.001; g.receiveShadow = true;
    scene.add(g);
  }
  if (q.get('boxes') === '1' && model.boxes) for (const b of model.boxes) {
    const h = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)), 0x35ff7a);
    model.group.add(h);
  }
  // 阴影相机刚好罩住模型
  const sc = sun.shadow.camera;
  sun.target.position.copy(center);
  sun.position.copy(center).add(sun.position.clone().normalize().multiplyScalar(radius * 4));
  sc.left = sc.bottom = -radius * 1.6; sc.right = sc.top = radius * 1.6; sc.near = 0.1; sc.far = radius * 10;
  sc.updateProjectionMatrix();

  let tris = 0, meshes = 0;
  model.group.traverse((o) => {
    const me = o as THREE.Mesh;
    if (!me.isMesh) return;
    meshes++;
    const g = me.geometry, n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    tris += n * ((me as unknown as THREE.InstancedMesh).isInstancedMesh ? (me as unknown as THREE.InstancedMesh).count : 1);
  });

  const target = q.get('target') ? new THREE.Vector3(...q.get('target')!.split(',').map(Number)) : center;
  const auto = radius * 2.7;
  const views = (q.get('views') ?? `35,18,${auto};-90,8,${auto};-145,24,${auto};20,62,${auto}`).split(';').map((s) => s.split(',').map(Number));
  const camera = new THREE.PerspectiveCamera(38, 1, Math.max(0.01, radius / 100), radius * 60);
  const place = (az: number, el: number, dist: number) => {
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    camera.position.set(target.x + Math.sin(a) * Math.cos(e) * dist, target.y + Math.sin(e) * dist, target.z + Math.cos(a) * Math.cos(e) * dist);
    camera.lookAt(target);
  };
  const text = `${m}.${fn}  ${Math.round(tris)} 三角形 / ${meshes} 个网格  尺寸 ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} 米  搭建 ${buildMs.toFixed(0)} ms`;
  info.textContent = text;
  const w = window as unknown as { __ready: boolean; __info: unknown };
  w.__info = { tris: Math.round(tris), meshes, size: size.toArray().map((v) => +v.toFixed(3)), min: box.min.toArray().map((v) => +v.toFixed(3)), buildMs: Math.round(buildMs), boxes: model.boxes?.length ?? 0 };

  if (q.get('orbit') === '1') {
    place(views[0][0], views[0][1], views[0][2]);
    const ctl = new OrbitControls(camera, canvas);
    ctl.target.copy(target);
    const loop = () => { requestAnimationFrame(loop); gl.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); ctl.update(); gl.render(scene, camera); };
    loop();
    w.__ready = true;
    return;
  }
  // 多个取景拼在一张画面里：每个取景只画画布的一格
  const cols = Math.ceil(Math.sqrt(views.length)), rows = Math.ceil(views.length / cols);
  const draw = () => {
    const W = innerWidth, H = innerHeight;
    gl.setSize(W, H, false);
    gl.setScissorTest(true);
    views.forEach((v, i) => {
      const cw = Math.floor(W / cols), ch = Math.floor(H / rows), x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
      gl.setViewport(x, y, cw, ch); gl.setScissor(x, y, cw, ch);
      camera.aspect = cw / ch; camera.updateProjectionMatrix();
      place(v[0], v[1], v[2]);
      gl.render(scene, camera);
    });
    gl.setScissorTest(false);
  };
  draw(); draw(); // 第一遍编译着色器、生成阴影，第二遍才是完整的画面
  addEventListener('resize', draw);
  w.__ready = true;
}

main().catch((err) => {
  console.error(err);
  info.textContent = `出错了：${err instanceof Error ? err.message : String(err)}`;
  (window as unknown as { __ready: boolean }).__ready = true;
});
