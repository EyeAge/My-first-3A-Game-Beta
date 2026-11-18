import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/math';
import type { Input } from '../core/input';
import { MuzzleFlash } from '../render/muzzleflash';
import type { Colliders, RayHit } from '../world/colliders';
import { isPuddleAt } from '../world/groundmask';
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
  private flash = new MuzzleFlash();
  // 枪管的热度：每开一枪 +0.05，每秒散掉 0.2。连射一秒多以后枪口开始发红；停手时如果还很热，枪口会冒一阵细烟
  private heat = 0; private sinceShot = 9; private smokeLeft = 0; private smokeTick = 0;
  private muzzle = new THREE.Object3D();
  private dot: THREE.Object3D;
  private mag: THREE.Object3D; private bolt: THREE.Object3D; private handle: THREE.Object3D; private left: THREE.Object3D;
  private boltK = 0;
  private torch: THREE.SpotLight; lightOn = false;
  private gun: THREE.Group;
  private hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };

  constructor() {
    const built = buildGun();
    const g = this.gun = built.gun;
    this.mag = built.mag; this.bolt = built.bolt; this.handle = built.handle; this.left = built.left; this.dot = built.dot;
    this.muzzle.position.set(0, 0, built.muzzleZ - 0.01); g.add(this.muzzle);
    // 战术手电：一盏跟着枪口转的聚光灯。不投影子，开销很小
    const torch = this.torch = new THREE.SpotLight(0xdfeaff, 0, 60, 0.34, 0.75, 1.5);
    torch.position.copy(built.lightPos); torch.target.position.copy(built.lightPos).add(new THREE.Vector3(0.004, 0.002, -1));
    g.add(torch, torch.target);
    // 夜里枪身是黑的，只靠环境光看不出细节：在枪的左上方挂一盏只照得到一米多远的小灯，专门给枪打轮廓光
    const fill = new THREE.PointLight(0xfff0dc, 2.2, 2, 2); fill.position.set(-0.25, 0.35, -0.15); this.view.add(fill);
    // 枪口焰：挂在枪口上的一个专用小网格，形状由着色器现算，每一枪都不一样（见 render/muzzleflash.ts）
    this.flash.mesh.position.set(0, 0, built.muzzleZ); g.add(this.flash.mesh);

    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
    // 把枪沿前后方向压扁一些：等效于给枪模单独用一个更窄的视野，避免近大远小被夸张得变形
    this.view.scale.set(1, 1, 0.6);
    this.view.add(g);
  }

  reset() { this.lightOn = false; this.torch.intensity = 0; this.ammo = MAG; this.reserve = 120; this.reloading = 0; this.cooldown = 0; this.ads = 0; this.bloom = 0; this.hitMarker = 0; this.heat = 0; this.smokeLeft = 0; }
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

    if (input.pressed('KeyF')) { this.lightOn = !this.lightOn; audio.empty(); }
    this.torch.intensity = damp(this.torch.intensity, this.lightOn ? 130 : 0, 30, dt);

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
        const sea = !eh && wallT < 300 && this.hit.ny > 0.5 && _p.y < 0.05 && _p.x > QUAY_X + 0.8;
        if (sea) _p.copy(o).addScaledVector(d, (-1.7 - o.y) / d.y);
        // 打在露天地面的水洼里：和打进海里一样只出水花，不崩碎屑、不留弹孔（水面上留不下坑）。
        // 积水图只管平面位置，所以先确认打中的是朝上的、贴着地面的那个面，而不是箱顶
        const water = sea || (!eh && wallT < 300 && this.hit.ny > 0.7 && _p.y < 0.08 && isPuddleAt(_p.x, _p.z));
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
          effects.impact(_p, -d.x, -d.y, -d.z, 'enemy', d);     // 敌人身上没有现成的法线，就当被打的那一面正对着子弹
          enemies.damage(eh.enemy, eh.weak ? 58 : 24, eh.weak);
        } else if (water) {
          effects.impact(_p, 0, 1, 0, 'water');
          const [vol, pan] = enemies.spatial(_p);
          if (vol > 0.3) audio.impactWater(vol * 0.7, pan);
        } else if (wallT < 300) {
          // 打到的是什么材质，由碰撞盒上的标记说了算。没标记的：地面当水泥，其余的当金属（港区里没标记的大多是集装箱和钢架）
          const ground = this.hit.ny > 0.5 && _p.y < 0.05;
          const surface = this.hit.surface ?? (ground ? 'concrete' : 'metal');
          effects.impact(_p, this.hit.nx, this.hit.ny, this.hit.nz, surface, d);
          // 弹孔：金属是翻着卷边、露出铁皮的孔，水泥是崩坑，木头是带木刺的新茬，沙袋、轮胎只留一小块发黑的印子
          if (surface === 'dirt' || surface === 'rubber') decals.add(_p, this.hit.nx, this.hit.ny, this.hit.nz, 'soot', 0.2, 0.8);
          else decals.add(_p, this.hit.nx, this.hit.ny, this.hit.nz, surface);
          const [vol, pan] = enemies.spatial(_p);
          if (vol > 0.55) audio.impact(vol * 0.6, pan);
        }
        audio.shot();
        input.rumble(0.12, 0.45, 45);
        // 枪口的闪光照亮周围：亮度 45，照 9 米，0.05 秒熄灭。
        // 灯不放在枪口上，而是沿弹道往前挪一点（最多 0.9 米；前面有墙就停在墙前 0.3 米）：
        // 点光照到的亮度和距离的平方成反比，放在枪口上离枪身只有十几厘米，枪身上每一颗水珠都会被照成一个刺眼的亮点。
        // 往前挪了，离前面的墙也近了，墙会比"灯在枪口"时亮；所以亮度按（灯到落点 ÷ 枪口到落点）的平方调低，落点处受到的光不变
        const reach = Math.max(endT - 0.6, 0.35), ahead = clamp(reach - 0.3, 0.05, 0.9), near = (reach - ahead) / reach;
        effects.flash(_f.copy(_m).addScaledVector(d, ahead), 45 * near * near, 0.05, 0xffb060, 9);
        this.flash.fire(this.ads);
        this.heat = Math.min(1.3, this.heat + 0.05); this.sinceShot = 0;
        const k = 1 - this.ads * 0.45;
        player.kick((0.011 + Math.random() * 0.006) * k, (Math.random() - 0.5) * 0.012 * k);
        player.addShake(0.12 * lerp(1, 0.55, this.ads) * (player.crouching ? 0.85 : 1));   // 每一枪镜头都抖一下：开镜、蹲着时轻一些
        this.kickZ += 0.028; this.kickR += 0.035; this.boltK = 1; this.bloom = Math.min(3, this.bloom + 0.55);
      } else if (input.pressed('MouseFire') || this.cooldown < -0.25) { this.cooldown = 0.25; audio.empty(); }
    }
    this.flash.update(dt, this.heat);
    // 枪口余烟：连射之后刚停手（0.11 秒没再开枪）而枪管还热，就冒一阵细烟，越热冒得越久
    const wasFiring = this.sinceShot <= 0.11;
    this.sinceShot += dt;
    if (wasFiring && this.sinceShot > 0.11 && this.heat > 0.4) this.smokeLeft = Math.min(1.6, this.heat * 1.3);
    if (this.smokeLeft > 0) {
      this.smokeLeft -= dt; this.smokeTick -= dt;
      if (this.smokeTick <= 0) {
        this.smokeTick = 0.085;
        this.muzzle.getWorldPosition(_m);
        effects.puff(_m, { size: 0.1 + this.smokeLeft * 0.06, life: 1.3, rise: 0.5, count: 1, alpha: 0.22 });
      }
    }
    this.heat = Math.max(0, this.heat - dt * 0.2);

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
      this.left.position.set(toMag * 20 - toHandle * 5, -toMag * (40 + out * 190) + toHandle * 106, toMag * 152 + toHandle * (318 + pull * 32));
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
const _sh = new THREE.Vector3(), _f = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _m = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
