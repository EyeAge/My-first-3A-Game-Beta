import * as THREE from 'three';

// 玩家那支枪的枪口焰。
//
// 它是每一枪都贴在眼前看到的东西，所以不走通用的粒子，而是枪模上一个专用的小网格：八张方片摆成固定的造型，
// 火焰的形状完全由片元着色器现算 —— 每开一枪换一个随机种子，花瓣的数量、角度、喷焰的长短都跟着变，连射时不会看到同一张图在闪。
//
// 八张方片分五种（顶点上的 aType 告诉着色器自己是哪种）：
//   0  两张正对镜头的方片（一大一小、一前一后）：星形的花瓣 —— 从枪口正后方看到的火焰截面
//   1  两张沿枪管方向的片，摆成十字：向前喷出去的火舌
//   2  两张横着的片，摆成十字：从制退器两侧的开孔喷出来的侧焰
//   3  一张小方片：白热的芯
//   4  一张更小的：连射久了枪口发红（和开不开火无关，只跟"热度"走）
//
// 网格的原点放在枪口，-z 是枪口朝前的方向，单位是米。

const VERTEX = /* glsl */ `attribute float aType; varying vec2 vUv; varying float vType;
void main(){ vUv = uv; vType = aType; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAGMENT = /* glsl */ `
uniform float uSeed, uInt, uHeat, uJet; varying vec2 vUv; varying float vType;
// 从"第几号"和这一枪的种子算一个 0..1 的随机数：同一枪里每次问同一个号得到同一个数
float rnd(float n){ return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;                          // 方片内的坐标 -1..1
  float r = length(p), angle = atan(p.y, p.x + 1e-6);
  float I = 0.0; vec3 tint = vec3(1.0, 0.50, 0.16);
  if (vType < 0.5) {
    // 花瓣：|cos(角度 × 瓣数 / 2)| 沿圆周一圈正好有"瓣数"个峰，取高次幂把峰削尖。一组粗的（3–5 瓣）+ 一组细的（5–8 瓣）
    float wide = 3.0 + floor(rnd(1.0) * 3.0), fine = 5.0 + floor(rnd(2.0) * 4.0);
    float petal = pow(abs(cos(angle * wide * 0.5 + rnd(3.0) * 6.283)), 5.0) * (0.55 + 0.45 * rnd(4.0));
    petal += pow(abs(cos(angle * fine * 0.5 + rnd(5.0) * 6.283)), 14.0) * 0.55;
    float reach = 0.35 + 0.65 * petal;               // 花瓣所在的方向伸得远，瓣与瓣之间伸得近
    I = (0.25 + petal) * (1.0 - smoothstep(reach * 0.15, reach, r)) * (0.75 + 0.25 * sin(r * 26.0 + rnd(6.0) * 20.0));
  } else if (vType < 1.5) {
    // 向前的火舌：vUv.y = 0 在枪口，1 在最前端。先胀开再收窄，越往前越暗，边缘左右扭一扭
    float y = clamp(vUv.y, 0.0, 1.0), x = p.x * (1.0 + 0.5 * sin(y * 17.0 + rnd(7.0) * 30.0) * y);
    float width = mix(0.20, 0.75, smoothstep(0.0, 0.35, y)) * (1.0 - y * 0.75);
    I = exp(-x * x / max(width * width * 0.35, 1e-4)) * pow(1.0 - y, 1.4) * (0.7 + 0.3 * sin(y * 31.0 + rnd(8.0) * 9.0)) * 0.9;
  } else if (vType < 2.5) {
    // 侧焰：左右各一股，长短各自随机；离枪口越远越细，中心（枪管本身的位置）是空的
    float u = abs(p.x), len = 0.55 + 0.45 * rnd(9.0 + step(0.0, p.x));
    float across = p.y * (1.0 + u * 3.0) + 0.12 * sin(u * 14.0 + rnd(10.0) * 20.0) * u;
    I = exp(-across * across * 22.0) * (1.0 - smoothstep(0.06, len, u)) * smoothstep(0.02, 0.10, u) * 0.85 * uJet;
  } else if (vType < 3.5) {
    I = exp(-r * r * 5.0) * 2.4 * (1.0 - smoothstep(0.6, 1.0, r)); tint = vec3(1.0, 0.82, 0.58);
  } else {
    gl_FragColor = vec4(vec3(1.0, 0.28, 0.06) * exp(-r * r * 4.0) * (1.0 - smoothstep(0.5, 1.0, r)) * max(uHeat, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  // 越亮的地方越偏白黄（烧得最热），暗的地方是橙色
  vec3 col = mix(tint, vec3(1.0, 0.90, 0.70), clamp(I * I * 0.7, 0.0, 1.0)) * max(I, 0.0) * uInt;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class MuzzleFlash {
  readonly mesh: THREE.Mesh;
  private uniforms = { uSeed: { value: 0 }, uInt: { value: 0 }, uHeat: { value: 0 }, uJet: { value: 1 } };
  private left = 0; private total = 1;

  constructor() {
    const position: number[] = [], uv: number[] = [], type: number[] = [], index: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], kind: number) => {
      const base = position.length / 3;
      position.push(...a, ...b, ...c, ...d); uv.push(0, 0, 1, 0, 1, 1, 0, 1); type.push(kind, kind, kind, kind);
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const square = (half: number, z: number, kind: number) => quad([-half, -half, z], [half, -half, z], [half, half, z], [-half, half, z], kind);
    square(0.13, -0.03, 0); square(0.091, -0.09, 0);                                        // 花瓣：26 厘米和 18 厘米见方
    const w = 0.065, reach = 0.34;                                                         // 火舌：13 厘米宽，往前伸 34 厘米
    quad([-w, 0, 0.01], [w, 0, 0.01], [w, 0, -reach], [-w, 0, -reach], 1);
    quad([0, -w, 0.01], [0, w, 0.01], [0, w, -reach], [0, -w, -reach], 1);
    const side = 0.17, thick = 0.05, back = 0.035;                                         // 侧焰：左右各伸 17 厘米，在枪口后面 3.5 厘米（制退器开孔的位置）
    quad([-side, -thick, back], [side, -thick, back], [side, thick, back], [-side, thick, back], 2);
    quad([-side, 0, back + thick], [side, 0, back + thick], [side, 0, back - thick], [-side, 0, back - thick], 2);
    square(0.05, -0.01, 3); square(0.03, 0.02, 4);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aType', new THREE.Float32BufferAttribute(type, 1));
    geo.setIndex(index);
    // 叠加混合：火焰的颜色直接加到画面上。forceSinglePass：双面的透明物体默认会被拆成背面、正面画两遍，这里没必要
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 30; this.mesh.visible = false;
  }

  /** 开了一枪。ads 是开镜程度 0..1：开镜时枪口就在视线正前方，火焰缩小一些，免得挡住目标。 */
  fire(ads: number) {
    this.left = this.total = 0.036 + Math.random() * 0.02;                                  // 只亮 36–56 毫秒，两三帧
    this.uniforms.uSeed.value = Math.random() * 100;
    this.uniforms.uJet.value = 0.6 + Math.random() * 0.6;
    this.mesh.rotation.z = (Math.random() - 0.5) * 0.4;
    const s = (0.8 + Math.random() * 0.5) * (1 - 0.38 * ads);
    this.mesh.scale.set(s, s, s * (0.8 + Math.random() * 0.5));                             // 前后方向再单独随机：火舌有长有短
  }

  /** 每帧调用。heat 是枪管的热度（每开一枪加一点，随时间散掉）。 */
  update(dt: number, heat: number) {
    // 亮度按剩余时间的平方根往下掉：一开始最亮，掉得先慢后快。
    // 先算亮度再扣时间：帧率很低的时候（一帧就超过了整个闪光的时长），这一枪至少也能亮一帧
    this.uniforms.uInt.value = this.left > 0 ? 9.5 * Math.sqrt(Math.max(0, this.left / this.total)) : 0;
    this.left -= dt;
    this.uniforms.uHeat.value = Math.min(1, Math.max(0, (heat - 0.45) / 0.8)) * 2.2;
    this.mesh.visible = this.uniforms.uInt.value > 0 || this.uniforms.uHeat.value > 0.02;
  }
}
