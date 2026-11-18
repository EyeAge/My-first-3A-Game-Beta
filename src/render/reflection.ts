import * as THREE from 'three';

/** 地面材质要用到的几个共享 uniform：反射画面、把世界坐标换算成反射画面坐标的矩阵、开关、时间。 */
export interface ReflectionUniforms {
  tRefl: { value: THREE.Texture | null };
  uReflM: { value: THREE.Matrix4 };
  uReflOn: { value: number };
  uReflTime: { value: number };
  /** 把“水面斜了多少”换算成反射贴图上挪多远（水面不平，倒影跟着晃）。跟相机的视角有关，每帧更新。 */
  uReflScale: { value: THREE.Vector2 };
  /** 反射贴图的行数相对 270 行的对数。地面按粗糙度取贴图的第几级模糊时加上它，换画质档位、贴图变大变小，看到的模糊程度不变。 */
  uReflLod: { value: number };
}
export function reflectionUniforms(): ReflectionUniforms {
  return { tRefl: { value: null }, uReflM: { value: new THREE.Matrix4() }, uReflOn: { value: 0 }, uReflTime: { value: 0 }, uReflScale: { value: new THREE.Vector2(0.5, 0.5) }, uReflLod: { value: 0 } };
}

/**
 * 平面反射：湿地面像镜子，镜子里的世界就是把相机沿地面（y=0）翻到地下再拍一遍。
 *
 * 每帧多渲染一次场景到一张缩小的贴图上，地面着色器再按屏幕位置去采样它。
 * 这是整个游戏里最贵的一项效果（场景要画两遍），所以分辨率跟画质档位走，低画质直接关掉。
 */
export class PlanarReflection {
  private rt: THREE.WebGLRenderTarget | null = null;
  private cam = new THREE.PerspectiveCamera();
  private scale = 0;
  private frames = 0;

  constructor(private gl: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private uniforms: ReflectionUniforms, private hidden: () => THREE.Object3D[]) {}

  /** scale 是反射贴图相对屏幕的分辨率比例，0 表示关闭。 */
  configure(scale: number, w: number, h: number) {
    this.scale = scale;
    this.rt?.dispose(); this.rt = null;
    this.uniforms.uReflOn.value = 0; this.uniforms.tRefl.value = null;
    this.frames = 0;
    if (scale <= 0) return;
    // 带 mipmap：越粗糙的地面采样越模糊的那一级，潮湿但没积水的地方反射就是糊的。
    // 宽取 16 的整数倍、高取 8 的整数倍：每一级 mipmap 都是上一级对半缩，边长能多整除几次 2，前几级就不会因为取整丢掉一行一列
    const width = Math.max(64, Math.round((w * scale) / 16) * 16), height = Math.max(32, Math.round((h * scale) / 8) * 8);
    this.rt = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.uniforms.tRefl.value = this.rt.texture;
    this.uniforms.uReflLod.value = Math.log2(height / 270);
  }

  render(time: number) {
    const { gl, camera, cam, rt } = this;
    this.uniforms.uReflTime.value = time;
    if (!rt) return;
    // 头两帧先不画：阴影贴图还没生成
    if (this.frames++ < 2 || camera.position.y <= 0.05) { this.uniforms.uReflOn.value = 0; return; }

    // 镜像相机：位置、朝向、"上方向"都沿 y=0 翻转
    camera.updateMatrixWorld();
    _pos.setFromMatrixPosition(camera.matrixWorld);
    _rot.extractRotation(camera.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot).add(_pos);
    cam.position.set(_pos.x, -_pos.y, _pos.z);
    cam.up.set(0, 1, 0).applyMatrix4(_rot); cam.up.y *= -1;
    cam.lookAt(_look.x, -_look.y, _look.z);
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // 世界坐标 → 反射贴图 uv
    this.uniforms.uReflM.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // 投影矩阵的 [0]、[5] 两项就是“视野有多窄”（1 / tan(半视角)）：视野越窄，同样的倾斜在画面上挪得越远。开镜时视野会变，所以每帧取
    const proj = camera.projectionMatrix.elements;
    this.uniforms.uReflScale.value.set(proj[0] * 0.5, proj[5] * 0.5);

    // 斜裁剪：把近裁剪面换成地面本身，地面以下的东西（镜像相机其实在地下）就不会被画进来。
    // 裁剪面比地面低 1 厘米（y = −0.01）：正好卡在 y = 0 的话，贴着地面的箱脚、轮胎会被削掉最底下一线，倒影和实物之间漏一条缝
    _plane.set(_up, 0.01).applyMatrix4(cam.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const pm = cam.projectionMatrix.elements;
    _q.set((Math.sign(_clip.x) + pm[8]) / pm[0], (Math.sign(_clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    _clip.multiplyScalar(2 / _clip.dot(_q));
    pm[2] = _clip.x; pm[6] = _clip.y; pm[10] = _clip.z + 1; pm[14] = _clip.w;

    const hide = this.hidden().filter((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prevTarget = gl.getRenderTarget(), prevShadow = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false; // 阴影沿用上一帧的，不为反射重算
    gl.setRenderTarget(rt);
    gl.clear();
    gl.render(this.scene, cam);
    gl.setRenderTarget(prevTarget);
    gl.shadowMap.autoUpdate = prevShadow;
    for (const o of hide) o.visible = true;
    this.uniforms.uReflOn.value = 1;
  }
}
const _pos = new THREE.Vector3(), _look = new THREE.Vector3(), _rot = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q = new THREE.Vector4();
