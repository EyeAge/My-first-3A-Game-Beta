import * as THREE from 'three';
import { SKY, SUN_COLOR, SUN_DIR, SUN_INTENSITY } from '../world/atmosphere';
import { ADD_FRAME, ATLAS_COLS, ATLAS_ROWS } from './fxatlas';

// 粒子是怎么画出来的。
//
// 每个粒子是一张四边形（两个三角形），所有粒子共用同一份几何，一次绘制调用画完（"实例化"）：
// 显卡拿到的是"一张单位方片" + "每个粒子一行数据（在哪、多大、什么颜色、第几格贴图……）"，方片在顶点着色器里被摆到位。
//
// 粒子分两池，画法不同：
//   受光池  烟、尘、水柱、爆炸的火球。它们会挡住后面的东西（按不透明度盖上去），所以要从远到近排好序再画；
//           颜色不是定死的，而是"被太阳和天光照出来的"—— 朝太阳的一面亮，背面暗，在影子里就整体暗下去。
//   叠加池  火星、闪光、光晕、曳光。它们自己发光，颜色直接加到画面上，谁先谁后结果都一样，不用排序。
//
// 这个文件里有四样东西：FxView（镜头在哪 + 场景深度的副本）、ParticleRenderer（把数据交给显卡）、
// ParticlePool（每个粒子的运动和生老病死）、TracerPool（曳光弹）。

/** 粒子朝哪摆。BILLBOARD 正对镜头；STRETCH 沿运动方向拉成一条（火星、水滴、曳光）；FLAT 平贴在地上（冲击环、涟漪）。 */
export const MODE_BILLBOARD = 0, MODE_STRETCH = 1, MODE_FLAT = 2;
/** 碰到地面怎么办（可以按位组合）：弹起来 / 直接消失 / 粘住不动。 */
export const BOUNCE = 1, DIE_ON_GROUND = 2, STICK = 4;
/** 颜色随年龄怎么变：不变 / 火星冷却（白黄 → 橙 → 暗红）/ 火焰（亮黄 → 橙红 → 熄灭）/ 余烬（忽明忽暗地闪）。 */
export const RAMP_NONE = 0, RAMP_SPARK = 1, RAMP_FIRE = 2, RAMP_EMBER = 3;

/**
 * 主镜头的信息，两池粒子共用一份。
 *
 * 另外负责"软粒子"要用的场景深度。软粒子是说：烟团和地面、墙相交的地方，本来会被切出一条笔直的硬线；
 * 如果画烟的时候知道"这个像素上，场景里最近的东西离镜头多远"，就能让烟在快要碰到它的地方提前变淡，硬线就没了。
 * 可是画粒子的时候深度缓冲正在被使用，不能同时读。所以在画第一池粒子之前，先把深度拷一份出来（换算成"离镜头多少米"），粒子读这份副本。
 */
export class FxView {
  /** 主镜头的位置。排序、"太远就少画点"都用它。每次主画面渲染时更新，所以是上一帧的值，差一帧无所谓。 */
  readonly eye = new THREE.Vector3();
  /** 软粒子总开关。网址里加 ?fxsoft=0 可以关掉对比效果。 */
  soft = new URLSearchParams(globalThis.location?.search ?? '').get('fxsoft') !== '0';
  /** 渲染器如果自己有一张"离镜头多少米"的深度贴图（r 通道，单位米，和画面同分辨率），交到这里就不用再拷一次。 */
  externalDepth: THREE.Texture | null = null;
  /** 游戏每推进一帧加一。同一帧里两池粒子、多次渲染都只拷一次深度。 */
  tick = 0;
  /** 深度副本的分辨率。 */
  readonly resolution = new THREE.Vector2(1, 1);
  private copiedAt = -1; private copying = false;
  private target: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene(); private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { tDepth: { value: null }, uNear: { value: 0.05 }, uFar: { value: 1400 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    // 深度缓冲里存的不是距离，而是一个 0..1 的非线性的数（近处精度高、远处精度低）。这个公式把它换回"离镜头多少米"
    fragmentShader: /* glsl */ `uniform sampler2D tDepth; uniform float uNear, uFar; varying vec2 vUv;
      void main(){ float d = texture2D(tDepth, vUv).r; gl_FragColor = vec4((uNear * uFar) / max(uFar - d * (uFar - uNear), 1e-6), 0.0, 0.0, 1.0); }`,
  });

  constructor() {
    // 一个比屏幕大的三角形，正好盖住整个画面（比用两个三角形拼矩形少一条对角线接缝）
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mesh = new THREE.Mesh(tri, this.material); mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /**
   * 粒子每次被画之前调用。返回这一趟渲染能用的深度贴图；不该做软粒子的时候返回 null。
   *
   * 怎么知道现在是"主画面"而不是地面倒影那一趟？主画面是画进一张带深度贴图的渲染目标里的，倒影那张没有。
   * 倒影用的是另一台（翻到地下的）相机，拿主画面的深度去比没有意义，所以那一趟不做软粒子。
   */
  prepare(renderer: THREE.WebGLRenderer, camera: THREE.Camera): THREE.Texture | null {
    const rt = renderer.getRenderTarget(), source = rt?.depthTexture ?? null;
    if (rt && !source) return null;                                   // 倒影等其它渲染：既不更新镜头位置，也不做软粒子
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    const cam = camera as THREE.PerspectiveCamera;
    if (!rt || !source || !this.soft || this.copying || !cam.isPerspectiveCamera) return null;
    this.resolution.set(rt.width, rt.height);
    if (this.externalDepth) return this.externalDepth;
    if (!this.target || this.target.width !== rt.width || this.target.height !== rt.height) {
      this.target?.dispose();
      // 能用 32 位浮点就用：16 位浮点只有三位有效数字，五十米外的深度差几厘米就分不清了
      const float32 = renderer.extensions.has('EXT_color_buffer_float');
      this.target = new THREE.WebGLRenderTarget(rt.width, rt.height, {
        type: float32 ? THREE.FloatType : THREE.HalfFloatType, format: float32 ? THREE.RedFormat : THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      });
      this.copiedAt = -1;
    }
    if (this.copiedAt !== this.tick) {
      this.copiedAt = this.tick;
      const u = this.material.uniforms;
      u.tDepth.value = source; u.uNear.value = cam.near; u.uFar.value = cam.far;
      // 在一次渲染的半路上插进去另一次渲染（three 允许这么做，镜面反射的官方示例就是这个写法）：
      // 换到副本目标 → 画一个全屏三角形 → 换回来接着画粒子。统计数字先冻住，不然这一趟会把主画面的绘制调用数清零
      const info = renderer.info, autoReset = info.autoReset;
      info.autoReset = false; this.copying = true;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(rt);
      this.copying = false; info.autoReset = autoReset;
    }
    return this.target.texture;
  }
}

const VERTEX = /* glsl */ `
attribute vec4 aPos;    // xyz 粒子中心，w 尺寸（米）
attribute vec4 aAxis;   // 拉伸模式：xyz = 拉伸方向 × 长度；平贴模式：xyz = 表面法线。w = 自转角（弧度）
attribute vec4 aCol;    // rgb 颜色（可以大于 1，越大越亮），a 不透明度
attribute vec4 aMisc;   // x 图集第几格，y 摆放模式，z 年龄 0..1，w 受光池：太阳可见度（≥2 表示这是火）；叠加池：屏幕上最多几个像素宽
uniform vec2 uAtlas;    // 图集有几列几行
uniform float uPx;      // 离镜头 1 米处，一个像素有多少米宽
varying vec2 vUv; varying vec4 vCol;
varying vec3 vOff;      // 这个角相对粒子中心的偏移（以粒子尺寸为单位）
varying vec3 vToCam;
varying vec3 vInfo;     // x 视空间深度（负数，越小越远），y 年龄，z 就是 aMisc.w
varying float vSoftD;   // 软粒子在离表面多远以内开始变淡（米）
varying vec3 vT; varying vec3 vB;   // 方片自己的"右"和"上"在世界里的方向，片元里把贴图上的法线转到世界空间要用
void main() {
  vec2 corner = position.xy;                         // 方片的四个角：(±0.5, ±0.5)
  vec3 center = aPos.xyz; float size = aPos.w, mode = aMisc.y;
  // 视图矩阵的前两行就是镜头的"右"和"上"在世界里的方向
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = cameraPosition - center; float dist = length(toCam); toCam /= max(dist, 1e-4);
  float sn = sin(aAxis.w), cs = cos(aAxis.w);
  vec2 turned = vec2(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);
  vec3 off; float dim = 1.0;
  if (mode < 0.5) {
    // 正对镜头：沿镜头的右、上两个方向展开
    off = (camRight * turned.x + camUp * turned.y) * size;
    vT = camRight * cs + camUp * sn; vB = camUp * cs - camRight * sn;
  } else if (mode < 1.5) {
    // 沿运动方向拉成一条：长边顺着 aAxis，短边取"既垂直于它、又垂直于视线"的方向，这样从哪看都是一条有宽度的线
    float len = length(aAxis.xyz); vec3 along = aAxis.xyz / max(len, 1e-5);
    // 这个角落在条纹中轴上的哪一点、那一点离镜头多远。下面的宽度都按"这一头自己离镜头多远"来算，而不是按粒子中心：
    // 一条几米长的曳光冲着镜头飞来时，近的那头离镜头只有半米，按中心的距离算宽度的话，近的那头会被透视放大成一根光柱
    vec3 onAxis = center + along * (corner.x * len);
    vec3 toEye = cameraPosition - onAxis; float eyeDist = length(toEye); toEye /= max(eyeDist, 1e-4);
    vec3 side = cross(along, toEye); float sideLen = length(side); side = sideLen > 1e-3 ? side / sideLen : camRight;
    // 宽度下限：屏幕上至少 1.4 个像素宽。比一个像素还细的超亮点会时有时无地闪，泛光也跟着一跳一跳。
    // 被撑宽了多少倍，亮度就压暗多少倍（dim），总的发光量不变
    float width = max(size, eyeDist * uPx * 1.4); dim = size / width;
    #ifdef ADDITIVE
    // 宽度上限：贴着镜头飞过的曳光不许糊成一大片
    if (aMisc.w > 1.5) width = min(width, eyeDist * uPx * aMisc.w);
    #endif
    off = along * (corner.x * max(len, width)) + side * (corner.y * width);
    vT = along; vB = side;
  } else {
    // 平贴在表面上：在垂直于法线的平面里随便找两个互相垂直的方向展开
    vec3 n = aAxis.xyz / max(length(aAxis.xyz), 1e-5);
    vec3 t = abs(n.y) > 0.9 ? cross(n, vec3(1.0, 0.0, 0.0)) : cross(vec3(0.0, 1.0, 0.0), n);
    t /= max(length(t), 1e-5);
    vec3 b = cross(n, t);
    off = (t * turned.x + b * turned.y) * size;
    vT = t * cs + b * sn; vB = b * cs - t * sn;
  }
  vec4 mv = viewMatrix * vec4(center + off, 1.0);
  gl_Position = projectionMatrix * mv;
  float frame = floor(aMisc.x + 0.5);
  vUv = (vec2(mod(frame, uAtlas.x), floor(frame / uAtlas.x)) + corner + 0.5) / uAtlas;
  vCol = vec4(aCol.rgb * dim, aCol.a);
  vOff = off / max(size, 1e-4);
  vToCam = toCam;
  vInfo = vec3(mv.z, aMisc.z, aMisc.w);
  // 小粒子 4 厘米内淡出，大烟团 0.7 米内淡出。平贴在地上的环例外：它本来就该贴着地，离地只有一厘米多，
  // 按大烟团的标准去淡的话整圈都被淡没了；所以只留 6 毫米，真的插进地里才淡
  vSoftD = mode > 1.5 ? 0.006 : clamp(size * 0.4, 0.04, 0.7);
}`;

const SOFT_FADE = /* glsl */ `
uniform sampler2D uTex; uniform sampler2D uDepth; uniform vec2 uRes; uniform float uSoft;
varying vec2 vUv; varying vec4 vCol; varying vec3 vOff; varying vec3 vToCam; varying vec3 vInfo; varying float vSoftD; varying vec3 vT; varying vec3 vB;
// 软粒子：这个像素上，场景里最近的表面比粒子远多少米？远得多 = 1（照常画）；马上要碰到 = 接近 0（淡掉）
float softFade() {
  if (uSoft < 0.5) return 1.0;
  float sceneDepth = texture2D(uDepth, gl_FragCoord.xy / max(uRes, vec2(1.0))).r;
  return clamp((sceneDepth + vInfo.x) / max(vSoftD, 1e-3), 0.0, 1.0);
}`;

const FRAGMENT_LIT = /* glsl */ `${SOFT_FADE}
uniform vec3 uSun, uSunDir, uAmbLo, uAmbHi;
void main() {
  vec4 t = texture2D(uTex, vUv);                     // rg 鼓包法线，b 厚度，a 不透明度
  // 年龄侵蚀：烟不是整团均匀变淡，而是越老"门槛"越高 —— 薄的地方先消失，边缘先碎掉，最后只剩几缕
  float erode = vInfo.y * 0.45;
  float hot = step(1.5, vInfo.z);                    // 这一团是火（见下）还是烟
  float a = smoothstep(erode, erode + mix(0.6, 0.38, hot), t.a) * vCol.a;   // 火的身体更实、边缘更利落
  // 软粒子 + 贴近镜头时淡出：离镜头 0.9 米开始变淡，0.2 米完全消失，镜头穿过烟的时候不会被一整张方片糊住
  a *= softFade() * smoothstep(0.2, 0.9, -vInfo.x);
  if (a < 0.004) discard;
  vec3 V = normalize(vToCam);
  // 法线由两部分混出来：把整团当成一个球的法线（给出整体的明暗面）+ 贴图里一鼓一鼓的小法线（给出表面的起伏）
  vec3 q = vOff * 2.0; float r2 = min(dot(q, q), 1.0);
  vec3 ballN = q + V * (sqrt(1.0 - r2) * 0.9 + 0.05);
  vec2 tn = t.rg * 2.0 - 1.0;
  vec3 bumpN = vT * tn.x + vB * tn.y + V * sqrt(max(1.0 - dot(tn, tn), 0.0));
  vec3 N = normalize(ballN * 0.55 + bumpN);
  // 太阳：烟是半透明的一团，光能绕到背面一些，所以用"包裹"的漫反射（背光面不是全黑）
  float wrap = clamp((dot(N, uSunDir) + 0.45) / 1.45, 0.0, 1.0);
  // 逆光：迎着太阳看过去，薄的边缘会被光打透、发亮
  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 5.0);
  float thin = 1.0 - t.b * smoothstep(0.0, 0.5, a);
  float shade = vInfo.z - 2.0 * hot;                 // 太阳可见度：发射时查过一次这里晒不晒得到太阳（晒不到是 0.2）
  vec3 sun = uSun * (wrap * wrap * 0.85 + back * (0.15 + 1.3 * thin)) * shade;
  // 天光：法线朝上的地方受天空的光多，朝下的受地面反上来的光；厚的地方再暗一点
  vec3 amb = mix(uAmbLo, uAmbHi, N.y * 0.5 + 0.5) * (1.0 - 0.35 * t.b);
  vec3 col = vCol.rgb * (amb + sun);
  if (hot > 0.5) {
    // 火球。它和烟一样是"盖上去"的而不是"加上去"的 —— 十几团发光的方片加在一起会饱和成一整块纯色，轮廓只剩方片的外形；
    // 盖上去的话每一团只有芯是亮的，外皮是暗橙色，底下垫一层煤烟的黑，团与团互相遮挡，才有体积感。
    float lump = clamp(dot(tn, vec2(0.6, 0.8)) * 0.6 + 0.5, 0.0, 1.0);
    float core = t.b * t.b * smoothstep(0.15, 0.9, t.a);
    vec3 fire = vCol.rgb * (0.10 + 1.7 * core) * (0.45 + 1.1 * lump);
    col = vec3(0.045, 0.042, 0.04) * (amb + sun) + fire;
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;                // 预乘：颜色先乘上不透明度再交给混合（见材质的混合设置）
}`;

const FRAGMENT_ADD = /* glsl */ `${SOFT_FADE}
void main() {
  float k = texture2D(uTex, vUv).r * vCol.a * softFade();
  if (k < 0.002) discard;
  gl_FragColor = vec4(max(vCol.rgb, vec3(0.0)) * k, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * 把一池粒子交给显卡画出来。每帧：begin() → 若干次 push() → end()。
 * lit=true 是受光池，false 是叠加池。
 */
export class ParticleRenderer {
  readonly mesh: THREE.Mesh;
  count = 0;
  private pos: Float32Array; private axis: Float32Array; private col: Float32Array; private misc: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  private geo = new THREE.InstancedBufferGeometry();

  constructor(readonly capacity: number, lit: boolean, atlas: THREE.Texture, renderOrder: number, view: FxView) {
    const geo = this.geo;
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const make = (name: string) => {
      const data = new Float32Array(capacity * 4), attr = new THREE.InstancedBufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      return { data, attr };
    };
    const p = make('aPos'), x = make('aAxis'), c = make('aCol'), m = make('aMisc');
    this.pos = p.data; this.axis = x.data; this.col = c.data; this.misc = m.data;
    this.attrs = [p.attr, x.attr, c.attr, m.attr];
    geo.instanceCount = 0;

    const uniforms: Record<string, THREE.IUniform> = {
      uTex: { value: atlas }, uAtlas: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) }, uPx: { value: 0.001 },
      uDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uSoft: { value: 0 },
    };
    if (lit) {
      // 粒子自己算光照，所以太阳和天光的颜色要告诉它。数值和场景里那盏太阳、那片天是同一套：
      //   太阳：颜色 × 强度 ÷ π（漫反射的归一化）× 0.9
      //   天光：朝上的面主要受头顶的天空 + 一点地平线和雾气的光；朝下的面只有地平线和雾气反上来的那点光
      const zenith = new THREE.Color(0.055, 0.085, 0.13);
      const mix3 = (a: THREE.Color, ka: number, b: THREE.Color, kb: number, c2: THREE.Color, kc: number) => new THREE.Color(a.r * ka + b.r * kb + c2.r * kc, a.g * ka + b.g * kb + c2.g * kc, a.b * ka + b.b * kb + c2.b * kc);
      uniforms.uSun = { value: SUN_COLOR.clone().multiplyScalar((SUN_INTENSITY / Math.PI) * 0.9) };
      uniforms.uSunDir = { value: SUN_DIR };
      uniforms.uAmbHi = { value: mix3(zenith, 0.6, SKY.horizonAway, 0.5, SKY.fog, 0.25) };
      uniforms.uAmbLo = { value: mix3(zenith, 0, SKY.horizonAway, 0.3, SKY.fog, 0.14) };
    }
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERTEX, fragmentShader: lit ? FRAGMENT_LIT : FRAGMENT_ADD, defines: lit ? {} : { ADDITIVE: 1 },
      transparent: true, depthWrite: false, depthTest: true, fog: false,
      // 两面都画（拉伸的方片说不准哪面朝镜头）。forceSinglePass：three 默认会把双面的透明物体拆成背面、正面画两遍，粒子用不着
      side: THREE.DoubleSide, forceSinglePass: true,
      // 混合方式。受光池：新颜色 × 1 + 旧颜色 ×（1 − 新的不透明度）—— 颜色已经在着色器里乘过不透明度了（"预乘"），
      // 这样写在叠了很多层半透明烟的时候边缘不会发黑。叠加池：新颜色 × 1 + 旧颜色 × 1，纯加法。
      // 两池都不改画面的 alpha 通道（Zero / One）。
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: lit ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const mesh = this.mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.renderOrder = renderOrder; mesh.visible = false;
    const target = new THREE.Vector2();
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      const rt = renderer.getRenderTarget();
      const height = rt ? rt.height : renderer.getDrawingBufferSize(target).y;
      // 投影矩阵的 [5] 是 1 / tan(视野的一半)。离镜头 1 米处画面高 2·tan(视野/2) 米，除以像素行数就是一个像素有多少米
      uniforms.uPx.value = 2 / (Math.max(camera.projectionMatrix.elements[5], 0.001) * Math.max(height, 1));
      const depth = view.prepare(renderer, camera);
      uniforms.uSoft.value = depth ? 1 : 0; uniforms.uDepth.value = depth;
      if (depth) (uniforms.uRes.value as THREE.Vector2).copy(view.resolution);
    };
  }

  begin() { this.count = 0; }
  /** 写入一个粒子。参数和顶点着色器开头的四个 attribute 一一对应。 */
  push(x: number, y: number, z: number, size: number, ax: number, ay: number, az: number, roll: number, r: number, g: number, b: number, a: number, frame: number, mode: number, age: number, extra: number) {
    if (this.count >= this.capacity) return;
    const o = this.count++ * 4, { pos, axis, col, misc } = this;
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; pos[o + 3] = size;
    axis[o] = ax; axis[o + 1] = ay; axis[o + 2] = az; axis[o + 3] = roll;
    col[o] = r; col[o + 1] = g; col[o + 2] = b; col[o + 3] = a;
    misc[o] = frame; misc[o + 1] = mode; misc[o + 2] = age; misc[o + 3] = extra;
  }
  /** 只把用到的前 count 个粒子上传给显卡；一个都没有就干脆不画。 */
  end() {
    this.geo.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, this.count * 4); a.needsUpdate = true; }
  }
}

/**
 * 一池粒子的状态。每个属性一个数组（第 i 个粒子的位置是 px[i]、py[i]、pz[i]……），这样内存连续、更新快，也不产生垃圾对象。
 *
 * emit() 发射一个粒子并返回它的下标，池子满了返回 -1。emit 只填位置、速度、寿命、起止尺寸，
 * 其余属性先给默认值，调用的人拿着下标再改自己关心的那几个。
 */
export class ParticlePool {
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  /** 已经活了多久、总共能活多久（秒）。age = -1 表示"刚发射，还没画过"。 */
  readonly age: Float32Array; readonly life: Float32Array;
  /** 尺寸从 s0 长到 s1（米）；grow 越大，前期长得越快、后期越慢。 */
  readonly s0: Float32Array; readonly s1: Float32Array; readonly grow: Float32Array;
  /** 自转角和转速（弧度、弧度/秒）。 */
  readonly rot: Float32Array; readonly spin: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array; readonly a: Float32Array;
  /** drag 空气阻力（越大停得越快）；grav 重力加速度（负数 = 往上飘）；wind 跟不跟风（0 不跟，1 最后完全随风）；turb 乱流强度。 */
  readonly drag: Float32Array; readonly grav: Float32Array; readonly wind: Float32Array; readonly turb: Float32Array;
  readonly seed: Float32Array;
  /** 淡入、淡出：寿命的前 fadeIn 这一段从 0 升到全不透明，过了 fadeOut 这个比例以后降到 0。 */
  readonly fadeIn: Float32Array; readonly fadeOut: Float32Array;
  /** 拉伸模式下，条纹的长度 = 速度 × stretch 秒。 */
  readonly stretch: Float32Array;
  /** 受光池：太阳可见度（火是 2 + 可见度）。叠加池：屏幕上最多几个像素宽（1 = 不限）。 */
  readonly extra: Float32Array;
  /** 地面高度（只对设了碰地方式的粒子有用）。 */
  readonly groundY: Float32Array;
  readonly frame: Uint8Array; readonly mode: Uint8Array; readonly flags: Uint8Array; readonly ramp: Uint8Array;
  private order: Int32Array;        // 活着的粒子的下标，按画的先后排
  private free: Int32Array;         // 空闲下标的栈
  private key: Float32Array;        // 排序用：到镜头的距离平方
  private live = 0; private freeTop = 0;

  constructor(readonly capacity: number, private sorted: boolean) {
    const f = () => new Float32Array(capacity), u = () => new Uint8Array(capacity);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.s0 = f(); this.s1 = f(); this.grow = f(); this.rot = f(); this.spin = f();
    this.r = f(); this.g = f(); this.b = f(); this.a = f(); this.drag = f(); this.grav = f(); this.wind = f(); this.turb = f();
    this.seed = f(); this.fadeIn = f(); this.fadeOut = f(); this.stretch = f(); this.extra = f(); this.groundY = f();
    this.frame = u(); this.mode = u(); this.flags = u(); this.ramp = u();
    this.order = new Int32Array(capacity); this.free = new Int32Array(capacity); this.key = f();
    this.clear();
  }
  get count() { return this.live; }
  clear() { this.live = 0; this.freeTop = this.capacity; for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number): number {
    if (this.freeTop === 0) return -1;
    const i = this.free[--this.freeTop];
    this.order[this.live++] = i;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = -1; this.life[i] = Math.max(life, 1e-3); this.s0[i] = s0; this.s1[i] = s1; this.grow[i] = 2;
    this.rot[i] = 0; this.spin[i] = 0; this.r[i] = this.g[i] = this.b[i] = this.a[i] = 1;
    this.drag[i] = 0; this.grav[i] = 0; this.wind[i] = 0; this.turb[i] = 0; this.seed[i] = Math.random() * 100;
    this.fadeIn[i] = 0; this.fadeOut[i] = 0.5; this.stretch[i] = 0.02; this.extra[i] = 1; this.groundY[i] = 0;
    this.frame[i] = 0; this.mode[i] = MODE_BILLBOARD; this.flags[i] = 0; this.ramp[i] = RAMP_NONE;
    return i;
  }

  /** 推进 dt 秒：长大一岁、受力、移动、碰地、到寿的回收。 */
  update(dt: number, time: number, wind: THREE.Vector3) {
    const { order, px, py, pz, vx, vy, vz, age, life, drag, turb, seed, flags } = this;
    let kept = 0;
    for (let n = 0; n < this.live; n++) {
      const i = order[n];
      // 刚发射的粒子第一帧只把年龄归零、不移动：保证每个粒子都在出生的位置上至少被画一帧（只活两三帧的枪口闪光尤其需要）
      if (age[i] < 0) { age[i] = 0; order[kept++] = i; continue; }
      age[i] += dt;
      if (age[i] >= life[i]) { this.free[this.freeTop++] = i; continue; }
      // 阻力把速度拉向"风速 × 跟风系数"：不跟风的粒子就是慢慢停下来，跟风的最后随风飘
      const k = 1 - Math.exp(-drag[i] * dt), w = this.wind[i];
      vx[i] += (wind.x * w - vx[i]) * k; vy[i] += (wind.y * w - vy[i]) * k; vz[i] += (wind.z * w - vz[i]) * k;
      vy[i] -= this.grav[i] * dt;
      if (turb[i] > 0) {
        // 乱流：按位置和时间用几个正弦推一推，同一团烟里相邻的粒子受的力相近，看起来像在翻卷而不是各自乱抖
        const tb = turb[i] * dt, s = seed[i];
        vx[i] += Math.sin(py[i] * 2.3 + s + time * 1.7) * tb;
        vz[i] += Math.cos(px[i] * 1.9 + s * 1.3 + time * 1.3) * tb;
        vy[i] += Math.sin(pz[i] * 2.1 + s * 0.7 + time * 2.1) * tb * 0.4;
      }
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
      if (flags[i] !== 0 && py[i] < this.groundY[i] + 0.012) {
        if (flags[i] & DIE_ON_GROUND) { this.free[this.freeTop++] = i; continue; }
        py[i] = this.groundY[i] + 0.012;
        if (flags[i] & STICK) { vx[i] = vy[i] = vz[i] = 0; }
        else if (vy[i] < 0) { vy[i] = -vy[i] * (0.25 + fract(seed[i]) * 0.3); vx[i] *= 0.65; vz[i] *= 0.65; }   // 每颗弹起来的高度不一样
      }
      order[kept++] = i;
    }
    this.live = kept;
  }

  /** 把活着的粒子按现在的状态写进渲染器。eye 是镜头位置（要排序的池子按离它的远近排）。 */
  write(out: ParticleRenderer, time: number, eye: THREE.Vector3) {
    const { order, px, py, pz, key } = this, n = this.live;
    if (this.sorted) {
      // 从远到近画，近的才能正确地盖住远的。相邻两帧的顺序几乎不变，插入排序在"基本有序"的数据上几乎只扫一遍
      for (let k = 0; k < n; k++) { const i = order[k], dx = px[i] - eye.x, dy = py[i] - eye.y, dz = pz[i] - eye.z; key[i] = dx * dx + dy * dy + dz * dz; }
      for (let k = 1; k < n; k++) {
        const i = order[k], d = key[i]; let j = k - 1;
        while (j >= 0 && key[order[j]] < d) { order[j + 1] = order[j]; j--; }
        order[j + 1] = i;
      }
    }
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const t = Math.max(0, this.age[i]) / this.life[i], rest = 1 - t;             // t：已经过了寿命的几成
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - Math.pow(rest, this.grow[i]));
      let alpha = this.a[i];
      if (this.fadeIn[i] > 0 && t < this.fadeIn[i]) alpha *= t / this.fadeIn[i];
      if (t > this.fadeOut[i]) { const q = 1 - (t - this.fadeOut[i]) / Math.max(1 - this.fadeOut[i], 1e-4); alpha *= q * q * (3 - 2 * q); }
      let r = this.r[i], g = this.g[i], b = this.b[i];
      const ramp = this.ramp[i];
      if (ramp === RAMP_SPARK) { r *= Math.sqrt(rest); g *= Math.pow(rest, 1.4); b *= rest * rest * rest; }       // 蓝先没、绿次之、红最后：白黄 → 橙 → 暗红
      else if (ramp === RAMP_FIRE) { const q = 1 - Math.pow(t, 1.6), k2 = q * Math.sqrt(q); r *= k2; g *= (0.22 + 0.78 * Math.pow(q, 1.3)) * k2; b *= (0.04 + 0.96 * Math.pow(q, 3.5)) * k2; }
      else if (ramp === RAMP_EMBER) { const q = 0.55 + 0.45 * Math.sin(time * 17 + this.seed[i] * 9); r *= q; g *= q * (0.6 + 0.4 * rest); b *= q * rest; }
      const mode = this.mode[i];
      if (mode === MODE_STRETCH) { const s = this.stretch[i]; out.push(px[i], py[i], pz[i], size, this.vx[i] * s, this.vy[i] * s, this.vz[i] * s, 0, r, g, b, alpha, this.frame[i], mode, t, this.extra[i]); }
      else out.push(px[i], py[i], pz[i], size, 0, 1, 0, this.rot[i], r, g, b, alpha, this.frame[i], mode, t, this.extra[i]);
    }
  }
}
/** 取小数部分。粒子的随机种子是 0..100 的数，小数部分正好当一个 0..1 的随机数用。 */
const fract = (x: number) => x - Math.floor(x);

/**
 * 曳光弹。子弹本身是瞬间命中的，曳光只是让眼睛"看见它飞过去"：一小段亮条从枪口飞到落点。
 * 每条曳光往叠加池里写三张方片：很细很亮的芯、宽而淡的光晕、头上的一个小光点。
 */
export class TracerPool {
  private list: { fx: number; fy: number; fz: number; dx: number; dy: number; dz: number; dist: number; speed: number; flown: number; length: number; width: number; r: number; g: number; b: number; frames: number }[] = [];
  constructor(private capacity = 48) {}
  clear() { this.list.length = 0; }

  add(from: THREE.Vector3, to: THREE.Vector3, r: number, g: number, b: number, speed: number, width: number) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return;
    if (this.list.length >= this.capacity) this.list.shift();
    // 亮条的长度跟速度走（飞得快的拖得长），限制在 2–7 米
    this.list.push({ fx: from.x, fy: from.y, fz: from.z, dx: dx / dist, dy: dy / dist, dz: dz / dist, dist, speed, flown: 0, length: Math.min(Math.max(speed * 0.022, 2), 7), width, r, g, b, frames: 0 });
  }

  update(dt: number, out: ParticleRenderer) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      // 第一帧：头部先随机飞出零点几帧的距离。连发时每一发都从枪口同一个位置起步的话，看起来像一根不动的棍子
      if (t.frames === 0) t.flown = Math.min(t.dist, t.speed * Math.max(dt, 0.008) * (0.35 + Math.random() * 0.4));
      else t.flown += t.speed * dt;
      let head = Math.min(t.flown, t.dist), tail = Math.max(0, t.flown - t.length);
      if (tail >= t.dist) {
        // 尾巴也到终点了。至少要画够两帧（打很近的目标时一帧就飞到了，眼睛根本看不见）：不够就钉在终点前再画一帧
        if (t.frames >= 2) { list.splice(i--, 1); continue; }
        tail = Math.max(0, t.dist - t.length * 0.5); head = t.dist;
      }
      t.frames++;
      const mid = (head + tail) * 0.5, len = Math.max(head - tail, 0.05), w = t.width;
      const x = t.fx + t.dx * mid, y = t.fy + t.dy * mid, z = t.fz + t.dz * mid;
      // 最后一个参数是屏幕宽度上限（像素）：芯最多 5 个像素宽、光晕最多 28 个，擦着镜头飞过也不会糊成一片
      out.push(x, y, z, w, t.dx * len, t.dy * len, t.dz * len, 0, t.r, t.g, t.b, 1, ADD_FRAME.JET, MODE_STRETCH, 0, 5);
      out.push(x, y, z, w * 6, t.dx * len * 1.05, t.dy * len * 1.05, t.dz * len * 1.05, 0, t.r * 0.04, t.g * 0.032, t.b * 0.028, 1, ADD_FRAME.JET, MODE_STRETCH, 0, 28);
      out.push(t.fx + t.dx * head, t.fy + t.dy * head, t.fz + t.dz * head, w * 5, 0, 1, 0, 0, t.r * 0.2, t.g * 0.16, t.b * 0.12, 1, ADD_FRAME.GLOW, MODE_BILLBOARD, 0, 1);
    }
  }
}
