import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Input } from '../core/input';
import type { Colliders, RayHit } from '../world/colliders';
import { QUAY_X } from '../world/port';
import type { Enemies, World } from './enemies';
import { buildGun, DEPTH, SIGHT_Y } from './gunmodel';
import type { Player } from './player';

const MAG = 30, RPM = 660, RELOAD = 2.0;
// 枪模原点（机匣中段、枪管轴线上）相对相机的位置。开镜时眼睛在机匣尾端后面 6 厘米、正对瞄具光轴
const HIP = new THREE.Vector3(0.14, -0.13, -0.36), ADS = new THREE.Vector3(0, -SIGHT_Y, -0.16 * DEPTH);

const HIP_ROT = new THREE.Vector3(0, 0.1, 0.05);
export interface Stats { shots: number; hits: number; kills: number }

/** M4A1 卡宾枪：第一人称枪模、开火、换弹、近战。 */
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
  private dot: THREE.Object3D;
  private mag: THREE.Object3D; private bolt: THREE.Object3D; private handle: THREE.Object3D; private left: THREE.Object3D;
  private boltK = 0;
  private gun: THREE.Group;
  private hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };

  constructor() {
    const built = buildGun();
    const g = this.gun = built.gun;
    this.mag = built.mag; this.bolt = built.bolt; this.handle = built.handle; this.left = built.left; this.dot = built.dot;
    this.muzzle.position.set(0, 0, built.muzzleZ - 0.01); g.add(this.muzzle);
    // 夜里枪身是黑的，只靠环境光看不出细节：在枪的左上方挂一盏只照得到一米多远的小灯，专门给枪打轮廓光
    const fill = new THREE.PointLight(0xfff0dc, 2.2, 2, 2); fill.position.set(-0.25, 0.35, -0.15); this.view.add(fill);
    // 枪口焰：两片交叉的发光面片，只显示一两帧
    const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
    const f2 = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.3), flashMat); f2.rotation.y = Math.PI / 2; f2.position.z = -0.08;
    this.flash.add(f2);
    this.flash.position.set(0, 0, built.muzzleZ - 0.06); this.flash.visible = false; g.add(this.flash);

    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
    // 把枪沿前后方向压扁一些：等效于给枪模单独用一个更窄的视野，避免近大远小被夸张得变形
    this.view.scale.set(1, 1, 0.6);
    this.view.add(g);
  }

  reset() { this.ammo = MAG; this.reserve = 120; this.reloading = 0; this.cooldown = 0; this.ads = 0; this.bloom = 0; this.hitMarker = 0; }
  addReserve(n: number, cap = 180) { this.reserve = Math.min(cap, this.reserve + n); }
  get reloadProgress() { return this.reloading > 0 ? 1 - this.reloading / RELOAD : 0; }

  update(dt: number, t: number, input: Input, player: Player, colliders: Colliders, enemies: Enemies, world: World, stats: Stats, wantAds: boolean) {
    const { effects, decals, audio, camera } = world;
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
        // 打到岸壁以外的"地面"其实是海面上空：把落点沿弹道延长到海面
        const water = !eh && wallT < 300 && this.hit.ny > 0.5 && _p.y < 0.05 && _p.x > QUAY_X + 0.8;
        if (water) _p.copy(o).addScaledVector(d, (-1.7 - o.y) / d.y);
        this.muzzle.getWorldPosition(_m);
        effects.tracer(_m, _p);
        // 抛壳：从机匣右侧甩出去
        _sh.copy(o).addScaledVector(d, 0.4).addScaledVector(_r, 0.05 + 0.17 * (1 - this.ads)).addScaledVector(_u, -0.12);
        effects.shell(_sh, player.vel.x + _r.x * (2 + Math.random()) + _u.x * 1.8 + d.x * (Math.random() - 0.5),
          player.vel.y + _r.y * 2 + _u.y * (1.6 + Math.random()), player.vel.z + _r.z * (2 + Math.random()) + _u.z * 1.8 + d.z * (Math.random() - 0.5));
        if (eh) {
          stats.hits++;
          this.hitMarker = 1; this.hitWeak = eh.weak;
          if (eh.weak) audio.weak(); else audio.hit();
          effects.sparks(_p, -d.x, 0.3, -d.z, eh.weak ? 12 : 6);
          enemies.damage(eh.enemy, eh.weak ? 58 : 24, eh.weak);
        } else if (water) {
          effects.splash(_p, 0.8);
        } else if (wallT < 300) {
          effects.sparks(_p, this.hit.nx, this.hit.ny, this.hit.nz, 7);
          effects.dust(_p, this.hit.nx, this.hit.ny, this.hit.nz);
          decals.add(_p, this.hit.nx, this.hit.ny, this.hit.nz, this.hit.ny > 0.5 && _p.y < 0.05 ? 'ground' : 'metal');
          const [vol, pan] = enemies.spatial(_p);
          if (vol > 0.55) audio.impact(vol * 0.6, pan);
        }
        audio.shot();
        input.rumble(0.12, 0.45, 45);
        effects.flash(_m, 260, 0.05);
        this.flash.visible = true; this.flashT = 0.035;
        this.flash.rotation.z = Math.random() * 6.283; this.flash.scale.setScalar(0.8 + Math.random() * 0.6);
        const k = 1 - this.ads * 0.45;
        player.kick((0.011 + Math.random() * 0.006) * k, (Math.random() - 0.5) * 0.012 * k);
        this.kickZ += 0.028; this.kickR += 0.035; this.boltK = 1; this.bloom = Math.min(3, this.bloom + 0.55);
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
    // 腰射时枪口略微朝内、枪身略微侧倾：这样能看到枪的左侧面，而不是只看到一个枪屁股
    let rx = this.kickR * (1 - this.ads * 0.6), ry = this.swayX * 2 * hipK + HIP_ROT.y * hipK, rz = -this.swayX * 3 * hipK + HIP_ROT.z * hipK;
    if (this.reloading > 0) {
      const p = 1 - this.reloading / RELOAD, k = Math.sin(Math.min(1, p * 4) * Math.PI / 2) * (p > 0.8 ? (1 - p) / 0.2 : 1);
      // 枪口抬起、枪身向右侧倾，把弹匣井亮给自己看
      rx += 0.3 * k; rz -= 0.42 * k; g.position.x -= 0.035 * k; g.position.y += 0.01 * k;
      // 换弹分三段：左手离开护木去抓弹匣 → 弹匣拔出再插回 → 左手拉一下拉机柄后回到护木
      const out = p > 0.15 && p < 0.6 ? Math.sin(((p - 0.15) / 0.45) * Math.PI) : 0;
      this.mag.position.set(0, -out * 190, out * -14);
      const toMag = clamp(p / 0.14, 0, 1) * (1 - clamp((p - 0.62) / 0.1, 0, 1)), toHandle = clamp((p - 0.66) / 0.08, 0, 1) * (1 - clamp((p - 0.9) / 0.1, 0, 1));
      const pull = p > 0.76 && p < 0.9 ? Math.sin(((p - 0.76) / 0.14) * Math.PI) : 0;
      // 这几个部件的坐标单位是毫米（枪模内部的图纸坐标）
      this.left.position.set(-toHandle * 12, -toMag * (78 + out * 190) + toHandle * 52, toMag * 132 + toHandle * (292 + pull * 32));
      this.left.rotation.z = toHandle * 0.5;
      this.handle.position.z = pull * 32;
    } else { this.mag.position.set(0, 0, 0); this.left.position.set(0, 0, 0); this.left.rotation.z = 0; this.handle.position.z = 0; }
    this.boltK = Math.max(0, this.boltK - dt * 22);
    this.bolt.position.z = this.boltK * 14;
    this.dot.visible = this.ads > 0.7;
    if (player.sprinting) { rx -= 0.35; ry += 0.55; g.position.x -= 0.05; g.position.y -= 0.03; }
    if (this.meleeT > 0) { const k = Math.sin((this.meleeT / 0.55) * Math.PI); g.position.z -= 0.22 * k; rz += 0.9 * k; rx += 0.2 * k; }
    _e.set(rx, ry, rz);
    g.quaternion.slerp(_q.setFromEuler(_e), Math.min(1, dt * 18));
  }
}
const _sh = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
