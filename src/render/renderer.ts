import * as THREE from 'three';
import type { QualityProfile } from '../core/settings';
import { SUN_DIR } from '../world/atmosphere';
import { PostChain, type PostFrame } from './post';
import { captureProbe } from './probe';
import type { PlanarReflection } from './reflection';
import { followSunShadow, installSoftShadows, setupSunShadow } from './shadows';

// 每一帧画面是怎么出来的：
//   1. 镜像相机把场景画一遍 → 湿地面的倒影（reflection.ts）
//   2. 太阳的阴影图（隔一帧更新一次）
//   3. 场景画进一张 HDR 贴图：亮度不封顶，太阳照到的地方可以是阴影里的几十倍亮（粒子这一趟先不画）
//   4. 后处理链把这张贴图加工成最终画面（post.ts）；粒子在它中途——空气合成完、泛光之前——才盖上去
//
// 色调映射（把 HDR 压进屏幕能显示的范围）放在后处理的最后做，而不是让 three 在每个材质里做：
// 这样泛光、体积光、曝光都能在"真实的亮度"上计算。

/** 一帧最多画多少像素。高分屏上按这个上限把内部分辨率压下来，再放大到屏幕 —— 后处理的开销和像素数成正比。 */
const PIXEL_BUDGET = { 0: 1.0e6, 1: 1.5e6, 2: 2.3e6, 3: 3.7e6 } as const;

/**
 * 等场景画完才盖上去的一层：粒子（烟、火星、闪光）。为什么要后画，见 post.ts 的 sceneUniforms。
 * object 是要画的东西；active 为假的那些帧（场上一个粒子都没有）整层跳过。
 */
export interface OverlayLayer { readonly object: THREE.Object3D; readonly active: boolean }

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  post!: PostChain;
  private profile!: QualityProfile;
  private sun!: THREE.DirectionalLight;
  reflection: PlanarReflection | null = null;
  /** 室内范围（车间）：体积光在这个盒子里更浓。 */
  interior: THREE.Box3 | null = null;
  /** 粒子层。它仍然挂在场景里（地面倒影那一趟照常画它），只是主画面那一趟先藏起来，留到后处理中途再画。 */
  overlay: OverlayLayer | null = null;
  private frame = 0; private lastTime = -1;
  private shadowAt = new THREE.Vector3(1e9, 0, 0); private eye = new THREE.Vector3();
  private fx: PostFrame = { dt: 0.016, time: 0, damage: 0, lowHealth: 0, ads: 0, fade: 0, saturation: 1, flash: 0, interior: null };

  constructor(private canvas: HTMLCanvasElement, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.setClearColor(0x000000, 1);
    installSoftShadows(16);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap; // 查影子的函数已经换成自己的软阴影了，这里选哪种都只影响阴影图怎么生成
    this.gl.shadowMap.autoUpdate = false;        // 阴影图什么时候重画由我们决定（见 render）
  }

  setQuality(p: QualityProfile, sun: THREE.DirectionalLight) {
    this.profile = p;
    this.sun = sun;
    sun.castShadow = p.shadow > 0;
    setupSunShadow(sun);
    if (p.shadow > 0 && sun.shadow.mapSize.x !== p.shadow) {
      sun.shadow.mapSize.set(p.shadow, p.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    this.post ??= new PostChain(this.gl, this.camera, sun);
    this.shadowAt.set(1e9, 0, 0);
    this.resize();
  }

  /**
   * 在 pos 处拍一张室内环境探针（做法见 probe.ts）。
   * 拍之前先把太阳的阴影图挪过去罩住那里：屋里暗不暗全靠阴影，而阴影图平时只跟着玩家走。
   */
  captureProbe(pos: THREE.Vector3, prepare?: () => () => void) {
    if (this.sun.castShadow) followSunShadow(this.sun, SUN_DIR, pos);
    this.shadowAt.set(1e9, 0, 0); // 下一帧让阴影图重新对准玩家
    return captureProbe(this.gl, this.scene, pos, prepare);
  }

  resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1, p = this.profile;
    // 内部分辨率 = 屏幕尺寸 × 像素比，但不超过这一档画质的像素预算
    let pr = p.pixelRatio;
    const budget = PIXEL_BUDGET[p.tier];
    if (w * h * pr * pr > budget) pr = Math.sqrt(budget / (w * h));
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.post.configure(w * pr, h * pr, { msaa: p.msaa, ao: p.ao, volSteps: p.volSteps, bloom: p.bloom });
    this.reflection?.configure(p.reflect, w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 画一帧。hurt 是"血量低"的程度（0..1）；fx 里可以再给挨打闪红、开镜、淡出等量。
   * time 是游戏时间（秒）；如果它和上一帧差得很多，就当作镜头"切"了一下，曝光立刻重新测，不做慢慢适应。
   */
  render(hurt: number, time = 0, fx: Partial<PostFrame> = {}) {
    const { gl, camera, sun } = this;
    const gap = time - this.lastTime, cut = this.lastTime < 0 || gap < 0 || gap > 0.5;
    this.lastTime = time;
    if (cut) this.post.cut();
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);

    // 阴影图隔一帧画一次（影子晚一帧没人看得出来，省下一半的阴影开销）；镜头切换、或者走远了，就立刻重画
    if (sun.castShadow && (cut || !sun.shadow.map || (this.frame & 1) === 0 || this.eye.distanceToSquared(this.shadowAt) > 36)) {
      followSunShadow(sun, SUN_DIR, this.eye);
      this.shadowAt.copy(this.eye);
      gl.shadowMap.needsUpdate = true;
    }
    this.frame++;

    this.reflection?.render(time);
    const layer = this.overlay;
    if (layer) layer.object.visible = false;
    gl.setRenderTarget(this.post.hdr);
    gl.clear();
    gl.render(this.scene, camera);
    if (layer) layer.object.visible = true;

    Object.assign(this.fx, { damage: 0, ads: 0, fade: 0, saturation: 1, flash: 0 }, fx);
    this.fx.dt = cut ? 0.016 : Math.min(0.1, Math.max(0.001, gap));
    this.fx.time = time; this.fx.lowHealth = hurt; this.fx.interior = this.interior;
    this.post.render(this.fx, layer?.active ? this.drawOverlay : null);
  }

  /** 把粒子层盖到当前的渲染目标上。three 默认每次 render 之前先清空目标，这里要盖在已有的画面上，所以临时关掉。 */
  private drawOverlay = () => {
    const { gl } = this, autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.render(this.overlay!.object, this.camera);
    gl.autoClear = autoClear;
  };
}
