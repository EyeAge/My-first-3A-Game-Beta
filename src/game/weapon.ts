import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Input } from '../core/input';
import type { Colliders, RayHit } from '../world/colliders';
import type { Enemies, World } from './enemies';
import type { Player } from './player';

const MAG = 30, RPM = 660, RELOAD = 2.0;
const HIP = new THREE.Vector3(0.19, -0.2, -0.78), ADS = new THREE.Vector3(0, -0.1215, -0.5);

export interface Stats { shots: number; hits: number; kills: number }

/** 几猫九式突击步枪：第一人称枪模、开火、换弹、近战。 */
export class Weapon {
  readonly view = new THREE.Group();   // 挂在相机上
  ammo = MAG; reserve = 120;
  reloading = 0;                        // 剩余换弹时间
  ads = 0;                              // 0 腰射 .. 1 开镜
  spread = 0;
  hitMarker = 0; hitWeak = false;
  private cooldown = 0; private meleeT = 0;
  private kickZ = 0; private kickR = 0; private bloom = 0;
  private swayX = 0; private swayY = 0;
  private flash: THREE.Mesh; private flashT = 0;
  private muzzle = new THREE.Object3D();
  private mag: THREE.Mesh;
  private gun = new THREE.Group();
  private hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };

  constructor() {
    const poly = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6, metalness: 0.25 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4c5258, roughness: 0.38, metalness: 0.7 });
    const tan = new THREE.MeshStandardMaterial({ color: 0x4a4436, roughness: 0.7, metalness: 0.1 });
    const g = this.gun;
    const B = new THREE.BoxGeometry(1, 1, 1), C = new THREE.CylinderGeometry(1, 1, 1, 12);
    const box = (m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0) => {
      const mesh = new THREE.Mesh(B, m); mesh.scale.set(sx, sy, sz); mesh.position.set(x, y, z); mesh.rotation.x = rx; g.add(mesh); return mesh;
    };
    const cyl = (m: THREE.Material, r: number, len: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(C, m); mesh.scale.set(r, len, r); mesh.rotation.x = Math.PI / 2; mesh.position.set(x, y, z); g.add(mesh); return mesh;
    };
    box(steel, 0.05, 0.078, 0.34, 0, 0, 0);                 // 机匣
    box(poly, 0.052, 0.06, 0.27, 0, 0.004, -0.3);           // 护木
    box(tan, 0.056, 0.03, 0.2, 0, -0.022, -0.3);
    box(steel, 0.03, 0.014, 0.52, 0, 0.046, -0.16);         // 导轨
    cyl(steel, 0.0105, 0.22, 0, 0.008, -0.52);              // 枪管
    cyl(steel, 0.016, 0.07, 0, 0.008, -0.65);               // 制退器
    this.mag = box(poly, 0.034, 0.17, 0.062, 0, -0.115, -0.07, 0.2);
    box(poly, 0.036, 0.1, 0.046, 0, -0.082, 0.11, -0.32);   // 握把
    box(steel, 0.008, 0.03, 0.05, 0, -0.045, 0.04);         // 扳机护圈
    box(poly, 0.042, 0.062, 0.2, 0, -0.008, 0.27);          // 枪托
    box(poly, 0.046, 0.11, 0.03, 0, -0.03, 0.38);
    box(steel, 0.012, 0.03, 0.012, 0, 0.066, -0.4);         // 准星座
    // HX-2 反射瞄具：一个框 + 一个红点
    box(steel, 0.04, 0.012, 0.06, 0, 0.058, -0.02);
    for (const s of [-1, 1]) box(steel, 0.004, 0.05, 0.035, s * 0.02, 0.088, -0.03);
    box(steel, 0.044, 0.004, 0.035, 0, 0.114, -0.03);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.048), new THREE.MeshBasicMaterial({ color: 0x224455, transparent: true, opacity: 0.16, depthWrite: false }));
    lens.position.set(0, 0.088, -0.03); g.add(lens);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0013, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 0.6, 0.3), depthTest: false, fog: false }));
    dot.position.set(0, 0.1215, -0.031); dot.renderOrder = 20; g.add(dot);

    this.muzzle.position.set(0, 0.008, -0.7); g.add(this.muzzle);
    // 枪口焰：两片交叉的发光面片，只显示一两帧
    const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.3), flashMat); f2.rotation.y = Math.PI / 2; f2.position.z = -0.08;
    this.flash.add(f2);
    this.flash.position.set(0, 0.008, -0.74); this.flash.visible = false; g.add(this.flash);

    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
    // 把枪沿前后方向压扁一些：等效于给枪模单独用一个更窄的视野，避免近大远小被夸张得变形
    this.view.scale.set(1, 1, 0.6);
    this.view.add(g);
  }

  reset() { this.ammo = MAG; this.reserve = 120; this.reloading = 0; this.cooldown = 0; this.ads = 0; this.bloom = 0; this.hitMarker = 0; }
  addReserve(n: number, cap = 180) { this.reserve = Math.min(cap, this.reserve + n); }
  get reloadProgress() { return this.reloading > 0 ? 1 - this.reloading / RELOAD : 0; }

  update(dt: number, t: number, input: Input, player: Player, colliders: Colliders, enemies: Enemies, world: World, stats: Stats, wantAds: boolean) {
    const { effects, audio, camera } = world;
    this.cooldown -= dt; this.meleeT -= dt;
    this.hitMarker = Math.max(0, this.hitMarker - dt * 4);
    this.ads = damp(this.ads, wantAds && this.reloading <= 0 && !player.sprinting ? 1 : 0, 14, dt);
    this.bloom = Math.max(0, this.bloom - dt * 2.2);
    const moveK = clamp(player.horizSpeed / 5, 0, 1.4);
    this.spread = (0.018 + moveK * 0.016 + (player.onGround ? 0 : 0.03)) * (1 - this.ads * 0.9) + this.bloom * 0.012 * (1 - this.ads * 0.6);

    // ---- 换弹
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) { const n = Math.min(MAG - this.ammo, this.reserve); this.ammo += n; this.reserve -= n; }
    } else if ((input.pressed('KeyR') || (this.ammo === 0 && input.fire)) && this.ammo < MAG && this.reserve > 0) {
      this.reloading = RELOAD; audio.reload();
    }

    // ---- 近战
    if (input.pressed('KeyV') && this.meleeT <= 0 && this.reloading <= 0) {
      this.meleeT = 0.55; audio.melee();
      const o = player.eyePos, d = player.forward(_d);
      const h = enemies.raycast(o, d, 2.6);
      if (h) { this.hitMarker = 1; this.hitWeak = false; audio.hit(); effects.sparks(_p.copy(o).addScaledVector(d, h.t), -d.x, 0.4, -d.z, 8); enemies.damage(h.enemy, 70, false); }
    }

    // ---- 开火
    if (input.fire && this.cooldown <= 0 && this.reloading <= 0 && this.meleeT <= 0.2 && !player.sprinting) {
      if (this.ammo > 0) {
        this.cooldown = 60 / RPM;
        this.ammo--; stats.shots++;
        const o = player.eyePos, d = player.forward(_d);
        // 散布：在准星周围的一个小圆锥里随机偏一点
        const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * this.spread;
        _r.set(1, 0, 0).applyQuaternion(camera.quaternion); _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
        d.addScaledVector(_r, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r).normalize();
        const wallT = colliders.raycast(o.x, o.y, o.z, d.x || 1e-9, d.y || 1e-9, d.z || 1e-9, 300, this.hit);
        const eh = enemies.raycast(o, d, wallT);
        const endT = eh ? eh.t : wallT;
        _p.copy(o).addScaledVector(d, endT);
        this.muzzle.getWorldPosition(_m);
        effects.tracer(_m, _p);
        if (eh) {
          stats.hits++;
          this.hitMarker = 1; this.hitWeak = eh.weak;
          if (eh.weak) audio.weak(); else audio.hit();
          effects.sparks(_p, -d.x, 0.3, -d.z, eh.weak ? 12 : 6);
          enemies.damage(eh.enemy, eh.weak ? 58 : 24, eh.weak);
        } else if (wallT < 300) {
          effects.sparks(_p, this.hit.nx, this.hit.ny, this.hit.nz, 7);
          const [vol, pan] = enemies.spatial(_p);
          if (vol > 0.55) audio.impact(vol * 0.6, pan);
        }
        audio.shot();
        effects.flash(_m, 260, 0.05);
        this.flash.visible = true; this.flashT = 0.035;
        this.flash.rotation.z = Math.random() * 6.283; this.flash.scale.setScalar(0.8 + Math.random() * 0.6);
        const k = 1 - this.ads * 0.45;
        player.kick((0.011 + Math.random() * 0.006) * k, (Math.random() - 0.5) * 0.012 * k);
        this.kickZ += 0.028; this.kickR += 0.035; this.bloom = Math.min(3, this.bloom + 0.55);
      } else if (input.pressed('MouseFire') || this.cooldown < -0.25) { this.cooldown = 0.25; audio.empty(); }
    }
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.flash.visible = false; }

    // ---- 枪模动画：开镜位移、惯性晃动、后坐、换弹、冲刺放低
    this.kickZ = damp(this.kickZ, 0, 16, dt); this.kickR = damp(this.kickR, 0, 14, dt);
    this.swayX = damp(this.swayX, clamp(-input.lookDX * 0.0006, -0.03, 0.03), 8, dt);
    this.swayY = damp(this.swayY, clamp(input.lookDY * 0.0006, -0.03, 0.03), 8, dt);
    const g = this.gun, hipK = 1 - this.ads;
    g.position.lerpVectors(HIP, ADS, this.ads);
    const bob = Math.sin(player.stepPhase * Math.PI * 2) * 0.006 * moveK * hipK, bobX = Math.cos(player.stepPhase * Math.PI) * 0.007 * moveK * hipK;
    g.position.x += this.swayX * hipK + bobX; g.position.y += this.swayY * hipK + bob + Math.sin(t * 1.7) * 0.0015 * hipK; g.position.z += this.kickZ;
    let rx = this.kickR * (1 - this.ads * 0.6), ry = this.swayX * 2 * hipK, rz = -this.swayX * 3 * hipK;
    if (this.reloading > 0) {
      const p = 1 - this.reloading / RELOAD, k = Math.sin(Math.min(1, p * 4) * Math.PI / 2) * (p > 0.8 ? (1 - p) / 0.2 : 1);
      rx -= 0.5 * k; rz += 0.5 * k; g.position.y -= 0.07 * k;
      this.mag.position.y = -0.115 - (p > 0.15 && p < 0.6 ? Math.sin(((p - 0.15) / 0.45) * Math.PI) * 0.22 : 0);
    } else this.mag.position.y = -0.115;
    if (player.sprinting) { rx -= 0.35; ry += 0.55; g.position.x -= 0.05; g.position.y -= 0.03; }
    if (this.meleeT > 0) { const k = Math.sin((this.meleeT / 0.55) * Math.PI); g.position.z -= 0.22 * k; rz += 0.9 * k; rx += 0.2 * k; }
    _e.set(rx, ry, rz);
    g.quaternion.slerp(_q.setFromEuler(_e), Math.min(1, dt * 18));
  }
}
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
