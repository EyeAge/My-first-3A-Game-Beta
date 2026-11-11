import * as THREE from 'three';

const MAX = 900;

/** 粒子、曳光弹、爆炸闪光。全部用对象池：开局一次分配好，之后只是循环复用。 */
export class Effects {
  readonly group = new THREE.Group();
  private n = 0;
  private p = new Float32Array(MAX * 3); private v = new Float32Array(MAX * 3);
  private c = new Float32Array(MAX * 4); private size = new Float32Array(MAX);
  private life = new Float32Array(MAX); private maxLife = new Float32Array(MAX); private grav = new Float32Array(MAX);
  private base = new Float32Array(MAX * 3);
  private geo = new THREE.BufferGeometry();
  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private flashes: { light: THREE.PointLight; life: number; max: number; power: number }[] = [];
  private cursor = 0;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d); gl_FragColor = vec4(vC.rgb * a * vC.a, 1.0); }`,
    });
    const pts = new THREE.Points(this.geo, mat);
    pts.frustumCulled = false; pts.renderOrder = 6;
    this.group.add(pts);
    this.geo.setDrawRange(0, 0);

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
    ((this.group.children[0] as THREE.Points).material as THREE.ShaderMaterial).uniforms.uScale.value = viewportH / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number, grav: number) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % MAX;
    this.n = Math.max(this.n, i + 1);
    this.p.set([x, y, z], i * 3); this.v.set([vx, vy, vz], i * 3);
    this.base.set([r, g, b], i * 3);
    this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.grav[i] = grav;
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
    const { p, v, c, life, maxLife, grav, base } = this;
    let top = 0;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) { c[i * 4 + 3] = 0; continue; }
      life[i] -= dt;
      v[i * 3 + 1] -= grav[i] * dt;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (p[i * 3 + 1] < 0.02 && grav[i] > 0) { p[i * 3 + 1] = 0.02; v[i * 3 + 1] *= -0.35; v[i * 3] *= 0.6; v[i * 3 + 2] *= 0.6; }
      const k = Math.max(0, life[i] / maxLife[i]);
      c[i * 4] = base[i * 3]; c[i * 4 + 1] = base[i * 3 + 1]; c[i * 4 + 2] = base[i * 3 + 2]; c[i * 4 + 3] = k;
      top = i + 1;
    }
    this.n = top;
    this.geo.setDrawRange(0, top);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aColor.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true;
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
