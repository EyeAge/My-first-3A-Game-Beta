import * as THREE from 'three';

const MAX = 1500, SOFT_MAX = 560, CHUNKS = 150;

/** 粒子颜色随寿命的变化方式：不变 / 火焰（白热 → 橙 → 暗红）/ 被火光映着的烟（橙褐 → 灰黑）。 */
const FIXED = 0, FIRE = 1, LIT_SMOKE = 2;

/**
 * 一池点状粒子。additive=true 是"发光"的（火星、火焰），颜色直接叠加到画面上；
 * additive=false 是"不发光"的（烟、尘、水花），按透明度盖在画面上。
 */
class Pool {
  readonly points: THREE.Points;
  private n = 0; private cursor = 0;
  private p: Float32Array; private v: Float32Array; private c: Float32Array; private size: Float32Array;
  private life: Float32Array; private maxLife: Float32Array; private grav: Float32Array; private base: Float32Array; private grow: Float32Array;
  private seed: Float32Array; private ramp: Uint8Array;
  private geo = new THREE.BufferGeometry();

  constructor(private max: number, private additive: boolean) {
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.c = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max); this.grav = new Float32Array(max); this.base = new Float32Array(max * 4); this.grow = new Float32Array(max);
    this.seed = new Float32Array(max); this.ramp = new Uint8Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
      uniforms: { uScale: { value: 600 } },
      // 大的粒子（火球、烟团）不是光滑的圆，而是边缘被噪声啃过的一团，每一颗转的角度都不一样；
      // 小的粒子（火星）屏幕上只有几个像素，保持干净的圆点。vPuff 就是"这颗有多大"。
      vertexShader: /* glsl */ `attribute vec4 aColor; attribute float aSize; attribute float aSeed; uniform float uScale; varying vec4 vC; varying float vSeed; varying float vPuff;
        void main(){ vC = aColor; vSeed = aSeed; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.1, -mv.z); vPuff = smoothstep(5.0, 30.0, gl_PointSize); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec4 vC; varying float vSeed; varying float vPuff;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main(){
          vec2 p = gl_PointCoord - 0.5; float d = length(p);
          float a = vSeed * 6.283; vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
          float cloud = n(q * 5.0 + vSeed * 31.0) * 0.6 + n(q * 11.0 + vSeed * 7.0) * 0.4;
          float edge = d + (cloud - 0.5) * 0.36 * vPuff;` + (additive
        ? /* glsl */ `
          float k = smoothstep(0.5, 0.05, edge);
          gl_FragColor = vec4(max(vC.rgb * k * vC.a * (1.0 + (cloud - 0.5) * 0.9 * vPuff), vec3(0.0)), 1.0); }`
        : /* glsl */ `
          float k = smoothstep(0.5, 0.12, edge);
          float lit = 1.0 + (0.5 - gl_PointCoord.y) * 0.7 * vPuff + (cloud - 0.5) * 0.5 * vPuff;   // 烟团上半边受天光，亮一点
          gl_FragColor = vec4(max(vC.rgb * lit, vec3(0.0)), k * vC.a); }`),
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false; this.points.renderOrder = additive ? 6 : 4;
    this.geo.setDrawRange(0, 0);
  }
  setScale(k: number) { (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = k; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, grav: number, alpha = 1, grow = 0, ramp = FIXED) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.n = Math.max(this.n, i + 1);
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3);
    this.base.set([r, g, b, alpha], i * 4);
    this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.grav[i] = grav; this.grow[i] = grow;
    this.seed[i] = Math.random(); this.ramp[i] = ramp;
  }


  update(dt: number) {
    const { p, v, c, life, maxLife, grav, base, size, grow } = this;
    let top = 0;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) { c[i * 4 + 3] = 0; continue; }
      life[i] -= dt;
      v[i * 3 + 1] -= grav[i] * dt;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (this.additive && p[i * 3 + 1] < 0.02 && grav[i] > 0) { p[i * 3 + 1] = 0.02; v[i * 3 + 1] *= -0.35; v[i * 3] *= 0.6; v[i * 3 + 2] *= 0.6; }
      if (!this.additive) { const drag = Math.max(0, 1 - dt * 1.6); v[i * 3] *= drag; v[i * 3 + 2] *= drag; if (grav[i] <= 0) v[i * 3 + 1] *= drag; } // 烟尘会被空气拖慢
      size[i] += grow[i] * dt;
      const k = Math.max(0, life[i] / maxLife[i]);
      const rp = this.ramp[i];
      if (rp === FIRE) {          // 火焰：刚炸开是白热的，很快变橙，最后暗成红褐色
        const hot = Math.max(0, (k - 0.55) / 0.45), warm = Math.min(1, k / 0.55);
        c[i * 4] = base[i * 4] * (0.25 + 0.75 * warm) + 0.5 * hot; c[i * 4 + 1] = base[i * 4 + 1] * warm * warm + 0.42 * hot; c[i * 4 + 2] = base[i * 4 + 2] * warm * warm * warm + 0.26 * hot;
      } else if (rp === LIT_SMOKE) { // 烟：开头被里面的火映成橙褐色，火灭了就是灰黑的
        const g = k * k * k;
        c[i * 4] = base[i * 4] + 0.7 * g; c[i * 4 + 1] = base[i * 4 + 1] + 0.26 * g; c[i * 4 + 2] = base[i * 4 + 2] + 0.05 * g;
      } else { c[i * 4] = base[i * 4]; c[i * 4 + 1] = base[i * 4 + 1]; c[i * 4 + 2] = base[i * 4 + 2]; }
      c[i * 4 + 3] = base[i * 4 + 3] * (this.additive ? (rp === FIRE ? Math.min(1, k * 1.6) : k) : Math.min(1, k * 2.2) * Math.min(1, (1 - k) * 8 + 0.25));
      top = i + 1;
    }
    this.n = top;
    this.geo.setDrawRange(0, top);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aColor.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true; this.geo.attributes.aSeed.needsUpdate = true;
  }
}

/** 粒子、曳光弹、爆炸闪光、弹壳和碎片。全部用对象池：开局一次分配好，之后只是循环复用。 */
export class Effects {
  readonly group = new THREE.Group();
  private glow = new Pool(MAX, true);
  private soft = new Pool(SOFT_MAX, false);
  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private flashes: { light: THREE.PointLight; life: number; max: number; power: number }[] = [];
  // 弹壳和碎片：一批会弹跳、会打转的小方块
  private chunks: THREE.InstancedMesh;
  private ck = Array.from({ length: CHUNKS }, () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), ang: 0, spin: 0, scale: new THREE.Vector3(), life: 0, hot: 0 }));
  // 冲击波：贴着地面迅速扩开的一圈
  private rings: { mesh: THREE.Mesh; life: number; max: number; size: number }[] = [];
  private ckCursor = 0;

  constructor() {
    this.group.add(this.glow.points, this.soft.points);

    this.chunks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.8 }), CHUNKS);
    this.chunks.frustumCulled = false; this.chunks.castShadow = true;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < CHUNKS; i++) { this.chunks.setMatrixAt(i, _m); this.chunks.setColorAt(i, _col.setRGB(1, 1, 1)); }
    this.group.add(this.chunks);

    const tGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.4, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      mesh.visible = false; mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    const ringGeo = new THREE.RingGeometry(0.72, 1, 48, 1); ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        uniforms: { uK: { value: 0 } },
        vertexShader: /* glsl */ `varying float vR; void main(){ vR = (length(position.xz) - 0.72) / 0.28; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `uniform float uK; varying float vR; void main(){ float r = clamp(vR, 0.0, 1.0); float a = pow(r, 5.0) * (1.0 - smoothstep(0.86, 1.0, r)); gl_FragColor = vec4(vec3(1.0, 0.72, 0.42) * a * uK, 1.0); }`,
      });
      const mesh = new THREE.Mesh(ringGeo, mat); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 6;
      this.group.add(mesh); this.rings.push({ mesh, life: 0, max: 1, size: 1 });
    }
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffb060, 0, 22, 1.8);
      this.group.add(light);
      this.flashes.push({ light, life: 0, max: 1, power: 0 });
    }
  }

  setScale(viewportH: number, fovDeg: number) {
    const k = viewportH / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.setScale(k); this.soft.setScale(k);
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, grav: number) {
    this.glow.emit(x, y, z, vx, vy, vz, r, g, b, size, life, grav);
  }

  private chunk(pos: THREE.Vector3, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, life: number, r: number, g: number, b: number, hot = 0) {
    const i = this.ckCursor; this.ckCursor = (this.ckCursor + 1) % CHUNKS;
    const c = this.ck[i];
    c.pos.copy(pos); c.vel.set(vx, vy, vz); c.scale.set(sx, sy, sz); c.life = life; c.hot = hot;
    c.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(); c.ang = Math.random() * 6.28; c.spin = 8 + Math.random() * 22;
    this.chunks.setColorAt(i, _col.setRGB(r, g, b));
    this.chunks.instanceColor!.needsUpdate = true;
  }

  /** 抛出一枚弹壳。 */
  shell(pos: THREE.Vector3, vx: number, vy: number, vz: number) {
    this.chunk(pos, vx, vy, vz, 0.012, 0.012, 0.042, 2.6, 0.95, 0.62, 0.22);
  }

  /** 敌人被击毁时飞散的零件。 */
  debris(pos: THREE.Vector3, scale: number, count: number) {
    for (let i = 0; i < count; i++) {
      const th = Math.random() * 6.283, s = (2 + Math.random() * 6) * scale, k = (0.05 + Math.random() * 0.11) * scale;
      const accent = Math.random() < 0.25;
      this.chunk(pos, Math.cos(th) * s, 2 + Math.random() * 6 * scale, Math.sin(th) * s, k * (0.5 + Math.random()), k * (0.4 + Math.random() * 0.6), k * (0.6 + Math.random() * 1.4), 2.2 + Math.random() * 1.6,
        accent ? 0.72 : 0.1, accent ? 0.3 : 0.11, accent ? 0.09 : 0.12, Math.random() < 0.55 ? 0.5 + Math.random() * 0.7 : 0); // 一半的碎片是烧着飞出去的，拖着火星和烟
    }
  }

  /** 子弹打在墙和地面上扬起的一小团灰。 */
  dust(pos: THREE.Vector3, nx: number, ny: number, nz: number, amount = 1) {
    for (let i = 0; i < 3 * amount; i++)
      this.soft.emit(pos.x + nx * 0.05, pos.y + ny * 0.05, pos.z + nz * 0.05, nx * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.8, ny * (0.6 + Math.random()) + Math.random() * 0.5, nz * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.8,
        0.2, 0.2, 0.2, 0.1 + Math.random() * 0.1, 0.5 + Math.random() * 0.5, -0.15, 0.3, 0.55);
  }

  /** 一团往上翻的黑烟。 */
  smoke(pos: THREE.Vector3, scale = 1) {
    for (let i = 0; i < 9 * scale; i++)
      this.soft.emit(pos.x + (Math.random() - 0.5) * 0.5 * scale, pos.y + Math.random() * 0.4, pos.z + (Math.random() - 0.5) * 0.5 * scale, (Math.random() - 0.5) * 1.6, 0.8 + Math.random() * 1.6, (Math.random() - 0.5) * 1.6,
        0.05, 0.05, 0.055, (0.4 + Math.random() * 0.4) * scale, 1.4 + Math.random() * 1.2, -0.3, 0.5, 0.9 * scale);
  }

  /** 水花：一圈向上的水柱 + 水面散开的白沫。踩水时 scale 给小一点。 */
  splash(pos: THREE.Vector3, scale = 1) {
    for (let i = 0; i < 16 * Math.min(2, scale + 0.4); i++) {
      const th = Math.random() * 6.283, s = (0.4 + Math.random() * 1.4) * scale;
      this.soft.emit(pos.x, pos.y + 0.03, pos.z, Math.cos(th) * s, (1.8 + Math.random() * 3.4) * Math.sqrt(scale), Math.sin(th) * s, 0.62, 0.68, 0.72, (0.04 + Math.random() * 0.06) * (0.6 + scale * 0.5), 0.45 + Math.random() * 0.5, 9, 0.5);
    }
    for (let i = 0; i < 5 * scale; i++) {
      const th = Math.random() * 6.283;
      this.soft.emit(pos.x, pos.y + 0.05, pos.z, Math.cos(th) * 1.2 * scale, 0.1, Math.sin(th) * 1.2 * scale, 0.55, 0.6, 0.64, 0.25 * scale, 0.7, 0, 0.22, 0.9 * scale);
    }
  }

  /** 子弹打在金属上溅出的火星 */
  sparks(pos: THREE.Vector3, nx: number, ny: number, nz: number, count: number, hot = true) {
    for (let i = 0; i < count; i++) {
      const s = 2 + Math.random() * 6;
      this.emit(pos.x, pos.y, pos.z, (nx + (Math.random() - 0.5) * 1.6) * s, (ny + (Math.random() - 0.3) * 1.6) * s, (nz + (Math.random() - 0.5) * 1.6) * s,
        hot ? 5 : 1.2, hot ? 2.6 : 1.2, hot ? 0.8 : 1.3, 0.03 + Math.random() * 0.03, 0.18 + Math.random() * 0.3, 14);
    }
    // 一小团灰尘
    for (let i = 0; i < 3; i++) this.emit(pos.x, pos.y, pos.z, nx * 1.2 + (Math.random() - 0.5), ny * 1.2 + Math.random() * 0.8, nz * 1.2 + (Math.random() - 0.5), 0.1, 0.1, 0.11, 0.3 + Math.random() * 0.3, 0.5, -0.5);
  }

  /**
   * 爆炸。一层一层叠出来：
   *   一瞬间的白色闪光 → 翻滚的火球（白热变橙再变暗）→ 四散的火星和慢慢落下的余烬
   *   → 被火光映红、往上翻的浓烟 → 贴地扩开的冲击波和被掀起的一圈尘土
   */
  explosion(pos: THREE.Vector3, scale = 1) {
    const { x, y, z } = pos, R = Math.random, ground = y < 3;
    this.glow.emit(x, y, z, 0, 0, 0, 0.9, 0.7, 0.45, 1.8 * scale, 0.07, 0);                           // 闪光
    for (let i = 0; i < 18 * scale; i++) {                                                      // 火球
      const th = R() * 6.283, ph = Math.acos(R() * 2 - 1), s = (0.8 + R() * 3.2) * scale;
      this.glow.emit(x + Math.sin(ph) * Math.cos(th) * 0.2 * scale, y + Math.cos(ph) * 0.2 * scale, z + Math.sin(ph) * Math.sin(th) * 0.2 * scale,
        Math.sin(ph) * Math.cos(th) * s, Math.abs(Math.cos(ph)) * s + 0.8, Math.sin(ph) * Math.sin(th) * s, 0.95, 0.34, 0.06, (0.55 + R() * 0.7) * scale, 0.3 + R() * 0.45, -2.2, 1, 1.6 * scale, FIRE);
    }
    for (let i = 0; i < 60 * scale; i++) {                                                      // 火星：飞得快、落得快，落地还会弹一下
      const th = R() * 6.283, ph = Math.acos(R() * 2 - 1), s = (4 + R() * 12) * scale;
      this.glow.emit(x, y, z, Math.sin(ph) * Math.cos(th) * s, Math.cos(ph) * s + 2.5, Math.sin(ph) * Math.sin(th) * s, 6, 2.4 + R() * 1.6, 0.5, 0.035 + R() * 0.05, 0.35 + R() * 0.8, 13);
    }
    for (let i = 0; i < 16 * scale; i++)                                                        // 余烬：飘得慢，亮得久
      this.glow.emit(x + (R() - 0.5) * scale, y + R() * scale, z + (R() - 0.5) * scale, (R() - 0.5) * 3, 1 + R() * 3, (R() - 0.5) * 3, 3.2, 0.9, 0.12, 0.03 + R() * 0.03, 1.2 + R() * 1.6, 2.2);
    for (let i = 0; i < 14 * scale; i++)                                                        // 浓烟
      this.soft.emit(x + (R() - 0.5) * 0.7 * scale, y + R() * 0.5 * scale, z + (R() - 0.5) * 0.7 * scale, (R() - 0.5) * 2.6, 1.2 + R() * 2.4, (R() - 0.5) * 2.6,
        0.045, 0.043, 0.045, (0.6 + R() * 0.6) * scale, 1.6 + R() * 1.6, -0.5, 0.62, 1.1 * scale, LIT_SMOKE);
    if (ground) {
      for (let i = 0; i < 18 * scale; i++) {                                                    // 贴地掀起的一圈尘土
        const th = (i / (18 * scale)) * 6.283 + R() * 0.3, s = (4.5 + R() * 3.5) * scale;
        this.soft.emit(x + Math.cos(th) * 0.4, 0.15, z + Math.sin(th) * 0.4, Math.cos(th) * s, 0.3 + R() * 0.6, Math.sin(th) * s, 0.2, 0.19, 0.18, (0.35 + R() * 0.3) * scale, 0.6 + R() * 0.5, -0.1, 0.3, 1.5 * scale);
      }
    }
    let ring = this.rings[0];
    for (const k of this.rings) if (k.life < ring.life) ring = k;
    ring.mesh.position.set(x, ground ? 0.07 : y, z); ring.life = ring.max = 0.34; ring.size = 5.5 * scale; ring.mesh.visible = true;
    this.flash(pos, 200 * scale, 0.3);
  }

  flash(pos: THREE.Vector3, power: number, life: number) {
    let f = this.flashes[0];
    for (const k of this.flashes) if (k.life < f.life) f = k;
    f.light.position.copy(pos); f.life = f.max = life; f.power = power;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, hot = true) {
    let tr = this.tracers[0];
    for (const k of this.tracers) if (k.life < tr.life) tr = k;
    const len = from.distanceTo(to);
    tr.mesh.position.copy(from).lerp(to, 0.5);
    tr.mesh.lookAt(to);
    tr.mesh.scale.set(0.018, 0.018, len);
    (tr.mesh.material as THREE.MeshBasicMaterial).color.setRGB(hot ? 6 : 6, hot ? 3.4 : 0.6, hot ? 1.2 : 0.3);
    tr.mesh.visible = true; tr.life = 0.06;
  }

  update(dt: number) {
    this.glow.update(dt); this.soft.update(dt);
    let dirty = false;
    for (let i = 0; i < CHUNKS; i++) {
      const c = this.ck[i];
      if (c.life <= 0) continue;
      c.life -= dt; dirty = true;
      c.vel.y -= 16 * dt;
      c.pos.addScaledVector(c.vel, dt);
      if (c.pos.y < 0.02 && c.vel.y < 0 && c.pos.x < 62) { // 落地：弹一下，每弹一次损失大半速度，转得也慢下来
        c.pos.y = 0.02; c.vel.y *= -0.38; c.vel.x *= 0.55; c.vel.z *= 0.55; c.spin *= 0.5;
        if (Math.abs(c.vel.y) < 0.6) { c.vel.set(0, 0, 0); c.spin = 0; }
      }
      if (c.hot > 0) {        // 烧着的碎片：一路掉火星、拖黑烟
        c.hot -= dt;
        if (Math.random() < dt * 34) this.glow.emit(c.pos.x, c.pos.y, c.pos.z, (Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8, 4.5, 1.6, 0.3, 0.04 + Math.random() * 0.05, 0.25 + Math.random() * 0.25, 3);
        if (Math.random() < dt * 16) this.soft.emit(c.pos.x, c.pos.y, c.pos.z, 0, 0.5, 0, 0.05, 0.05, 0.05, 0.1, 0.7 + Math.random() * 0.5, -0.3, 0.4, 0.5, LIT_SMOKE);
      }
      c.ang += c.spin * dt;
      const k = c.life <= 0 ? 0 : Math.min(1, c.life / 0.4); // 最后 0.4 秒缩小消失
      this.chunks.setMatrixAt(i, _m.compose(c.pos, _q.setFromAxisAngle(c.axis, c.ang), _s.copy(c.scale).multiplyScalar(k)));
    }
    if (dirty) this.chunks.instanceMatrix.needsUpdate = true;
    for (const tr of this.tracers) {
      if (tr.life <= 0) continue;
      tr.life -= dt;
      (tr.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, tr.life / 0.06);
      if (tr.life <= 0) tr.mesh.visible = false;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = Math.max(0, r.life / r.max), s = r.size * (1 - k * k * 0.92);          // 先快后慢地扩开
      r.mesh.scale.set(s, 1, s); (r.mesh.material as THREE.ShaderMaterial).uniforms.uK.value = k * 0.16;
      if (r.life <= 0) r.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life > 0) { f.life -= dt; f.light.intensity = f.power * Math.max(0, f.life / f.max); } else f.light.intensity = 0;
    }
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _col = new THREE.Color();
