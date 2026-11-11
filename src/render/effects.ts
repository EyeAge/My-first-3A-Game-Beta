import * as THREE from 'three';

const MAX = 900, SOFT_MAX = 260, CHUNKS = 150;

/**
 * 一池点状粒子。additive=true 是"发光"的（火星、火焰），颜色直接叠加到画面上；
 * additive=false 是"不发光"的（烟、尘、水花），按透明度盖在画面上。
 */
class Pool {
  readonly points: THREE.Points;
  private n = 0; private cursor = 0;
  private p: Float32Array; private v: Float32Array; private c: Float32Array; private size: Float32Array;
  private life: Float32Array; private maxLife: Float32Array; private grav: Float32Array; private base: Float32Array; private grow: Float32Array;
  private geo = new THREE.BufferGeometry();

  constructor(private max: number, private additive: boolean) {
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.c = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max); this.grav = new Float32Array(max); this.base = new Float32Array(max * 4); this.grow = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: additive
        ? /* glsl */ `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d); gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0); }`
        : /* glsl */ `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d); gl_FragColor = vec4(vC.rgb, a * vC.a); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false; this.points.renderOrder = additive ? 6 : 4;
    this.geo.setDrawRange(0, 0);
  }
  setScale(k: number) { (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = k; }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, grav: number, alpha = 1, grow = 0) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.n = Math.max(this.n, i + 1);
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3);
    this.base.set([r, g, b, alpha], i * 4);
    this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.grav[i] = grav; this.grow[i] = grow;
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
      c[i * 4] = base[i * 4]; c[i * 4 + 1] = base[i * 4 + 1]; c[i * 4 + 2] = base[i * 4 + 2]; c[i * 4 + 3] = base[i * 4 + 3] * (this.additive ? k : Math.min(1, k * 2.2));
      top = i + 1;
    }
    this.n = top;
    this.geo.setDrawRange(0, top);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aColor.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true;
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
  private ck = Array.from({ length: CHUNKS }, () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), ang: 0, spin: 0, scale: new THREE.Vector3(), life: 0 }));
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

  private chunk(pos: THREE.Vector3, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, life: number, r: number, g: number, b: number) {
    const i = this.ckCursor; this.ckCursor = (this.ckCursor + 1) % CHUNKS;
    const c = this.ck[i];
    c.pos.copy(pos); c.vel.set(vx, vy, vz); c.scale.set(sx, sy, sz); c.life = life;
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
        accent ? 0.72 : 0.1, accent ? 0.3 : 0.11, accent ? 0.09 : 0.12);
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

  explosion(pos: THREE.Vector3, scale = 1) {
    for (let i = 0; i < 46 * scale; i++) {
      const th = Math.random() * 6.283, ph = Math.acos(Math.random() * 2 - 1), s = (3 + Math.random() * 9) * scale;
      this.emit(pos.x, pos.y, pos.z, Math.sin(ph) * Math.cos(th) * s, Math.cos(ph) * s + 2, Math.sin(ph) * Math.sin(th) * s, 6, 2.6 + Math.random() * 1.5, 0.6, 0.05 + Math.random() * 0.07, 0.4 + Math.random() * 0.7, 12);
    }
    for (let i = 0; i < 12; i++) this.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3, 1.6, 0.7, 0.25, (0.7 + Math.random() * 0.8) * scale, 0.35 + Math.random() * 0.3, -1.5);
    for (let i = 0; i < 10; i++) this.emit(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 2, 0.6 + Math.random() * 1.6, (Math.random() - 0.5) * 2, 0.06, 0.06, 0.065, (0.9 + Math.random()) * scale, 1.2 + Math.random(), -0.8);
    this.flash(pos, 900 * scale, 0.28);
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
    for (const f of this.flashes) {
      if (f.life > 0) { f.life -= dt; f.light.intensity = f.power * Math.max(0, f.life / f.max); } else f.light.intensity = 0;
    }
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _col = new THREE.Color();
