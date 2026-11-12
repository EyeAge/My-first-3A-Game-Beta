import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { GameAudio } from '../audio/audio';
import type { Effects } from '../render/effects';
import type { Colliders } from '../world/colliders';
import type { NavGrid } from '../world/nav';
import type { Decals } from '../render/decals';
import { BOUNDS } from '../world/port';
import type { Player } from './player';
import { plating } from './plating';
import { instantiate, rigDef } from './rig';

export type Kind = 'gull' | 'hound' | 'guard';
export const KIND_NAME: Record<Kind, string> = { gull: '机械飞鸥', hound: '机械猎犬', guard: '机械守卫' };

interface Spec { hp: number; speed: number; bodyY: number; bodyR: number; weak: [number, number, number]; weakR: number }
const SPEC: Record<Kind, Spec> = {
  gull: { hp: 45, speed: 9, bodyY: 0, bodyR: 0.6, weak: [0, -0.25, 0.46], weakR: 0.2 },
  hound: { hp: 75, speed: 7.4, bodyY: 0.68, bodyR: 0.62, weak: [0, 0.92, 0.98], weakR: 0.27 },
  guard: { hp: 240, speed: 2.7, bodyY: 1.45, bodyR: 0.85, weak: [0, 2.48, 0.06], weakR: 0.3 },
};

export interface Enemy {
  kind: Kind; spec: Spec;
  group: THREE.Group; pos: THREE.Vector3;
  hp: number; alive: boolean;
  yaw: number; flash: number;
  bodyMat: THREE.MeshStandardMaterial;
  mesh: THREE.SkinnedMesh; bones: Record<string, THREE.Bone>; glow: THREE.MeshBasicMaterial | null;
  move: number;                 // 0 站立 .. 1 全速，步态动画的权重
  hitK: number; hitSide: number; // 中弹时的身体抖动
  act: number; recoil: number;   // 扑咬动作计时、开火后坐
  aimYaw: number; aimPitch: number; guardK: number;
  path: number[] | null; pathI: number; pathT: number;
  attackT: number; burst: number; burstT: number; charge: number;
  losT: number; hasLos: boolean;
  phase: number; anim: number;
  orbit: number; alt: number; vel: THREE.Vector3;
}
export interface HitResult { enemy: Enemy; t: number; weak: boolean }
export interface World { colliders: Colliders; nav: NavGrid; effects: Effects; decals: Decals; audio: GameAudio; camera: THREE.Camera }

const SPH = new THREE.SphereGeometry(1, 12, 8);

// 机体材质：三种都用同一套装甲板贴图（板缝、铆钉、掉漆），只是底色和金属感不同
const PLATE = plating();
const BODY = new THREE.MeshStandardMaterial({ color: 0xc9cbc8, map: PLATE.map, roughness: 1, metalness: 0.5, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap, normalScale: new THREE.Vector2(1.1, 1.1) });
const ACCENT = new THREE.MeshStandardMaterial({ color: 0xa8501c, map: PLATE.map, roughness: 1.1, metalness: 0.75, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap });
const DARK = new THREE.MeshStandardMaterial({ color: 0x24282c, map: PLATE.map, roughness: 0.9, metalness: 0.9, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap, normalScale: new THREE.Vector2(0.7, 0.7) });
const BLUR = new THREE.MeshBasicMaterial({ color: 0x0b0d0f, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }); // 旋翼转起来的残影
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.22, metalness: 1 }); // 液压杆的活塞杆：磨得发亮的镀铬钢
const EYE = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.25, 0.12) });
const BOLT = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 1.6, 0.5) });

interface Bolt { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; dmg: number }

export class Enemies {
  readonly group = new THREE.Group();
  list: Enemy[] = [];
  private bolts: Bolt[] = [];
  onKill: (e: Enemy, weak: boolean) => void = () => {};
  onPlayerHit: (dmg: number, from: THREE.Vector3) => void = () => {};

  constructor(private world: World) {
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(SPH, BOLT);
      mesh.scale.set(0.09, 0.09, 0.5); mesh.visible = false;
      this.group.add(mesh);
      this.bolts.push({ mesh, vel: new THREE.Vector3(), life: 0, dmg: 0 });
    }
  }

  get aliveCount() { return this.list.length; }

  clear() {
    for (const e of this.list) { this.group.remove(e.group); e.mesh.skeleton.dispose(); e.bodyMat.dispose(); }
    this.list.length = 0;
    for (const b of this.bolts) { b.life = 0; b.mesh.visible = false; }
  }

  spawn(kind: Kind, x: number, z: number) {
    const bodyMat = BODY.clone();
    const glow = kind === 'guard' ? new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.08, 0.03) }) : null;
    const rig = instantiate(rigDef(kind), { body: bodyMat, accent: ACCENT, dark: DARK, steel: STEEL, eye: EYE, glow: glow ?? EYE, blur: BLUR });
    const spec = SPEC[kind];
    const group = new THREE.Group();
    group.add(rig.mesh);
    group.position.set(x, kind === 'gull' ? 20 : 0, z);
    this.group.add(group);
    const e: Enemy = {
      kind, spec, group, pos: group.position, hp: spec.hp, alive: true, yaw: 0, flash: 0, bodyMat,
      mesh: rig.mesh, bones: rig.bones, glow, move: 0, hitK: 0, hitSide: 1, act: 0, recoil: 0, aimYaw: 0, aimPitch: 0, guardK: 0,
      path: null, pathI: 0, pathT: Math.random() * 0.6,
      attackT: 1.5 + Math.random() * 2, burst: 0, burstT: 0, charge: 0, losT: Math.random() * 0.3, hasLos: false,
      phase: Math.random() * 6.28, anim: 0, orbit: Math.random() * 6.28, alt: 11 + Math.random() * 4, vel: new THREE.Vector3(),
    };
    this.list.push(e);
    return e;
  }

  /** 在离玩家一段距离、最好还看不见的地方刷一个敌人。 */
  spawnAround(kind: Kind, player: Player) {
    const { nav, colliders } = this.world;
    let bx = 0, bz = 0, found = false;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.283, d = 34 + Math.random() * 46;
      const x = clamp(player.pos.x + Math.cos(a) * d, BOUNDS.minX + 3, BOUNDS.maxX - 3);
      const z = clamp(player.pos.z + Math.sin(a) * d, BOUNDS.minZ + 3, BOUNDS.maxZ - 3);
      if (Math.hypot(x - player.pos.x, z - player.pos.z) < 28) continue;
      if (kind !== 'gull' && !nav.isFree(x, z)) continue;
      bx = x; bz = z; found = true;
      if (colliders.blocked(x, 1.4, z, player.pos.x, player.pos.y + 1.5, player.pos.z)) break; // 看不见的位置更好
    }
    if (!found) return null;
    return this.spawn(kind, bx, bz);
  }

  /** 子弹命中检测：把每个敌人当成"身体球 + 弱点球"。 */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number): HitResult | null {
    let best: HitResult | null = null;
    for (const e of this.list) {
      const s = e.spec;
      const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
      const wx = e.pos.x + s.weak[0] * cos + s.weak[2] * sin, wy = e.pos.y + s.weak[1], wz = e.pos.z - s.weak[0] * sin + s.weak[2] * cos;
      const tw = raySphere(o, d, wx, wy, wz, s.weakR);
      let tb = raySphere(o, d, e.pos.x, e.pos.y + s.bodyY, e.pos.z, s.bodyR);
      if (e.kind === 'guard') tb = Math.min(tb, raySphere(o, d, e.pos.x, e.pos.y + 0.6, e.pos.z, 0.55), raySphere(o, d, e.pos.x, e.pos.y + 2.2, e.pos.z, 0.42));
      const weak = tw < Infinity && tw <= tb + 0.25;
      const t = weak ? tw : tb;
      if (t < maxT && (!best || t < best.t)) best = { enemy: e, t, weak };
    }
    return best;
  }

  damage(e: Enemy, amount: number, weak: boolean) {
    if (!e.alive) return false;
    e.hp -= amount; e.flash = 1;
    e.hitK = Math.min(1, e.hitK + (weak ? 1 : 0.6)); e.hitSide = Math.random() < 0.5 ? -1 : 1;
    e.attackT = Math.max(e.attackT, 0.25);
    if (e.hp <= 0) { this.kill(e, weak); return true; }
    return false;
  }

  private kill(e: Enemy, weak: boolean) {
    e.alive = false;
    const c = _a.set(e.pos.x, e.pos.y + e.spec.bodyY, e.pos.z);
    const big = e.kind === 'guard' ? 1.7 : e.kind === 'hound' ? 1 : 0.8;
    this.world.effects.explosion(c, big);
    this.world.effects.debris(c, big, e.kind === 'guard' ? 22 : 12);
    this.world.effects.smoke(c, big);
    if (e.pos.y < 2.5 && e.pos.x < BOUNDS.maxX) this.world.decals.add(_b.set(e.pos.x, 0, e.pos.z), 0, 1, 0, 'scorch'); // 地上留一块烧焦的痕迹
    const [vol, pan] = this.spatial(c);
    this.world.audio.explode(vol, pan);
    this.group.remove(e.group);
    e.bodyMat.dispose(); e.glow?.dispose(); e.mesh.skeleton.dispose();
    this.list.splice(this.list.indexOf(e), 1);
    this.onKill(e, weak);
  }

  /** 按声源相对相机的距离和左右位置，算出音量和声像。 */
  spatial(p: THREE.Vector3): [number, number] {
    const cam = this.world.camera;
    const dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
    const dist = Math.hypot(dx, dy, dz);
    _b.set(1, 0, 0).applyQuaternion(cam.quaternion);
    return [clamp(1.15 - dist / 75, 0, 1), dist > 0.1 ? (dx * _b.x + dy * _b.y + dz * _b.z) / dist * 0.8 : 0];
  }

  private fire(from: THREE.Vector3, target: THREE.Vector3, speed: number, dmg: number, spread: number) {
    const b = this.bolts.find((k) => k.life <= 0);
    if (!b) return;
    b.vel.copy(target).sub(from).normalize();
    b.vel.x += (Math.random() - 0.5) * spread; b.vel.y += (Math.random() - 0.5) * spread; b.vel.z += (Math.random() - 0.5) * spread;
    b.vel.normalize().multiplyScalar(speed);
    b.mesh.position.copy(from);
    b.mesh.lookAt(_c.copy(from).add(b.vel));
    b.mesh.visible = true; b.life = 3; b.dmg = dmg;
    const [vol, pan] = this.spatial(from);
    this.world.audio.enemyShot(vol, pan);
    this.world.effects.flash(from, 120, 0.08);
  }

  update(dt: number, t: number, player: Player) {
    const { colliders, nav, effects, audio } = this.world;
    const px = player.pos.x, pz = player.pos.z;
    const chest = _chest.set(px, player.pos.y + player.height * 0.62, pz);

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      const dx = px - e.pos.x, dz = pz - e.pos.z;
      const dist = Math.hypot(dx, dz);
      e.flash = Math.max(0, e.flash - dt * 6);
      e.bodyMat.emissive.setScalar(e.flash * 0.9);
      e.attackT -= dt; e.losT -= dt; e.pathT -= dt;
      e.hitK = Math.max(0, e.hitK - dt * 5); e.recoil = Math.max(0, e.recoil - dt * 6); e.act = Math.max(0, e.act - dt);
      const headY = e.kind === 'gull' ? e.pos.y : e.pos.y + (e.kind === 'guard' ? 2.2 : 0.9);
      if (e.losT <= 0) {
        e.losT = 0.22 + Math.random() * 0.1;
        e.hasLos = !colliders.blocked(e.pos.x, headY, e.pos.z, chest.x, chest.y, chest.z);
      }
      let wantYaw = Math.atan2(dx, dz);

      if (e.kind === 'gull') {
        // 飞鸥：绕着玩家盘旋，有视线时压低高度并开火
        e.orbit += dt * 0.5;
        const r = 13 + Math.sin(e.phase + t * 0.3) * 4;
        const tx = px + Math.cos(e.orbit) * r, tz = pz + Math.sin(e.orbit) * r;
        let ty = e.alt;
        const low = player.pos.y + 5.5 + Math.sin(t * 1.3 + e.phase) * 0.8;
        if (!colliders.pointInside(tx, low - 1, tz) && !colliders.pointInside(e.pos.x, low - 1, e.pos.z)) ty = low;
        _a.set(tx - e.pos.x, ty - e.pos.y, tz - e.pos.z);
        const l = _a.length();
        if (l > 0.01) _a.multiplyScalar(Math.min(e.spec.speed, l * 1.6) / l);
        e.vel.x = damp(e.vel.x, _a.x, 2.5, dt); e.vel.y = damp(e.vel.y, _a.y, 2.5, dt); e.vel.z = damp(e.vel.z, _a.z, 2.5, dt);
        e.pos.addScaledVector(e.vel, dt);
        e.pos.y = Math.max(2.2, e.pos.y);
        e.group.rotation.z = clamp(-e.vel.x * Math.cos(e.yaw) * 0.04 + e.vel.z * Math.sin(e.yaw) * 0.04, -0.5, 0.5);
        if (e.attackT <= 0 && e.hasLos && dist < 48) {
          e.attackT = 2.0 + Math.random() * 1.4; e.recoil = 1;
          this.fire(_a.set(e.pos.x, e.pos.y - 0.2, e.pos.z), _d.copy(chest).addScaledVector(player.vel, dist / 60), 36, 5, 0.035);
        }
      } else {
        // 地面单位：定期用 A* 重新规划去玩家那里的路
        const stopDist = e.kind === 'guard' ? 20 : 1.5;
        const holding = e.kind === 'guard' && e.hasLos && dist < stopDist;
        let moving = false;
        if (!holding && dist > stopDist * (e.kind === 'guard' ? 0.5 : 1)) {
          if (e.pathT <= 0) {
            e.pathT = 0.7 + Math.random() * 0.5;
            e.path = nav.findPath(e.pos.x, e.pos.z, px, pz);
            e.pathI = 0;
          }
          let gx = px, gz = pz;
          if (e.path) {
            while (e.pathI < e.path.length - 2 && Math.hypot(e.path[e.pathI] - e.pos.x, e.path[e.pathI + 1] - e.pos.z) < 1.3) e.pathI += 2;
            gx = e.path[e.pathI]; gz = e.path[e.pathI + 1];
          }
          const mx = gx - e.pos.x, mz = gz - e.pos.z, ml = Math.hypot(mx, mz);
          if (ml > 0.05) {
            const sp = e.spec.speed * (e.kind === 'hound' && dist < 9 ? 1.25 : 1);
            const nx = e.pos.x + (mx / ml) * sp * dt, nz = e.pos.z + (mz / ml) * sp * dt;
            if (nav.isFree(nx, nz) || !nav.isFree(e.pos.x, e.pos.z)) { e.pos.x = nx; e.pos.z = nz; moving = true; }
            else if (nav.isFree(nx, e.pos.z)) { e.pos.x = nx; moving = true; }
            else if (nav.isFree(e.pos.x, nz)) { e.pos.z = nz; moving = true; }
            if (!e.hasLos || dist > 14) wantYaw = Math.atan2(mx, mz);
          }
        }
        e.move = damp(e.move, moving ? 1 : 0, 7, dt);
        e.anim += dt * e.move * (e.kind === 'hound' ? 14 : 6.4);
        if (e.kind === 'hound') {
          if (dist < 2.1 && Math.abs(player.pos.y - e.pos.y) < 1.8 && e.attackT <= 0) {
            e.attackT = 1.2; e.act = 0.4;
            this.onPlayerHit(11, e.pos);
            const [vol, pan] = this.spatial(e.pos);
            audio.bark(vol, pan);
          }
        } else {
          // 上身会转向玩家，炮口位置要跟着上身的朝向和俯仰算
          const ay = e.yaw + e.aimYaw, cp = Math.cos(e.aimPitch), sp = Math.sin(e.aimPitch);
          const fz = 1.24 * cp + 0.38 * sp, sa = Math.sin(ay), ca = Math.cos(ay);
          const muzzle = _a.set(e.pos.x + 0.76 * ca + fz * sa, e.pos.y + 2.0 - 0.38 * cp + 1.24 * sp, e.pos.z - 0.76 * sa + fz * ca);
          // 守卫开火前炮口会先充能发亮，给玩家留出找掩体的时间
          if (e.burst > 0) {
            e.burstT -= dt;
            if (e.burstT <= 0) { e.burst--; e.burstT = 0.16; this.fire(muzzle, chest, 52, 9, 0.03); e.recoil = 1; }
          } else if (e.charge > 0) {
            e.charge -= dt;
            if (e.charge <= 0) { e.burst = 3; e.burstT = 0; }
          } else if (e.attackT <= 0 && e.hasLos && dist < 46) {
            e.attackT = 2.8 + Math.random() * 1.2; e.charge = 0.55;
            const [vol, pan] = this.spatial(muzzle);
            audio.charge(vol, pan);
          }
          const k = e.charge > 0 ? 1 - e.charge / 0.55 : e.burst > 0 ? 1 : 0;
          e.glow!.color.setRGB(0.4 + k * 9, 0.08 + k * 1.6, 0.03 + k * 0.4);
        }
      }
      // 地面单位不能站进玩家身体里
      if (e.kind !== 'gull' && dist < 1.15 && dist > 1e-3) { e.pos.x -= (dx / dist) * (1.15 - dist); e.pos.z -= (dz / dist) * (1.15 - dist); }
      // 平滑转向
      let dy = wantYaw - e.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      e.yaw += dy * Math.min(1, dt * (e.kind === 'guard' ? 4 : 8));
      e.group.rotation.y = e.yaw;

      // 骨骼动画：rel 是玩家相对它正前方的偏角，头和上身用它来盯人
      const rel = Math.atan2(Math.sin(Math.atan2(dx, dz) - e.yaw), Math.cos(Math.atan2(dx, dz) - e.yaw));
      if (e.kind === 'gull') poseGull(e, t, rel, dist, chest.y);
      else if (e.kind === 'hound') poseHound(e, t, rel, dist);
      else poseGuard(e, dt, t, rel, dist, chest.y);
    }

    // 同类之间互相推开一点，免得叠在一起
    for (let i = 0; i < this.list.length; i++) for (let j = i + 1; j < this.list.length; j++) {
      const a = this.list[i], b = this.list[j];
      if ((a.kind === 'gull') !== (b.kind === 'gull')) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz), min = a.kind === 'gull' ? 3 : 1.5;
      if (d < min && d > 1e-3) { const k = ((min - d) / d) * 0.5 * Math.min(1, dt * 8); a.pos.x -= dx * k; a.pos.z -= dz * k; b.pos.x += dx * k; b.pos.z += dz * k; }
    }

    // 敌方弹丸
    for (const b of this.bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const p = b.mesh.position;
      _c.copy(p);
      p.addScaledVector(b.vel, dt);
      effects.trail(_c); effects.trail(_d.copy(_c).lerp(p, 0.5));
      if (p.distanceToSquared(chest) < 0.55 * 0.55 || (Math.hypot(p.x - px, p.z - pz) < 0.42 && p.y > player.pos.y && p.y < player.pos.y + player.height)) {
        this.onPlayerHit(b.dmg, _d.copy(p).addScaledVector(b.vel, -1));
        b.life = 0;
      } else if (p.y < 0.03 || colliders.pointInside(p.x, p.y, p.z)) {
        effects.sparks(p, -b.vel.x * 0.02, 0.5, -b.vel.z * 0.02, 5);
        if (p.y < 0.03 && p.x > BOUNDS.maxX + 0.8) effects.splash(_d.set(p.x, -1.7, p.z), 0.8);
        // 从上一帧的位置补一条射线，求出打中的是哪个面，在那里留一块焦痕
        const sp = b.vel.length(), len = sp * dt + 0.2;
        if (colliders.raycast(_c.x, _c.y, _c.z, b.vel.x / sp || 1e-9, b.vel.y / sp || 1e-9, b.vel.z / sp || 1e-9, len, _hit) < len)
          this.world.decals.add(_d.copy(_c).addScaledVector(b.vel, _hit.t / sp), _hit.nx, _hit.ny, _hit.nz, 'scorch');
        const [vol, pan] = this.spatial(p);
        if (vol > 0.5) audio.impact(vol, pan);
        b.life = 0;
      }
      if (b.life <= 0) b.mesh.visible = false;
    }
  }
}

function raySphere(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, r: number) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

// ---------------------------------------------------------------------------
// 姿势函数：每帧根据敌人的状态算出每根骨骼该转多少。
// 约定：rotation.x 为正 = 向下的肢体往后摆 / 朝前的部件往下低头。

/** 摆完姿势后把身体整体上下挪一下，让最低的那只脚正好踩在地面上。 */
function plant(e: Enemy, tips: string[]) {
  e.group.updateMatrixWorld(true);
  let min = Infinity;
  for (const k of tips) min = Math.min(min, e.bones[k].matrixWorld.elements[13]);
  e.bones.root.position.y += e.pos.y - min;
}
const rest = (b: THREE.Bone) => b.userData.rest as THREE.Vector3;

// 奔跑步态：两条后腿先后蹬地，两条前腿再先后落地
const HOUND_LEGS: [string, number, number][] = [['bl', 0, 0.75], ['br', 0.8, 0.75], ['fl', 3.0, 0.62], ['fr', 3.8, 0.62]];
const HOUND_TIPS = ['blT', 'brT', 'flT', 'frT'];
function poseHound(e: Enemy, t: number, rel: number, dist: number) {
  const b = e.bones, m = e.move, ph = e.anim;
  const bite = e.act > 0 ? Math.sin((1 - e.act / 0.4) * Math.PI) : 0;
  for (const [id, off, amp] of HOUND_LEGS) {
    const p = ph + off, lift = Math.max(0, -Math.cos(p)); // 腿往前收的那半圈要抬脚
    b[id + '1'].rotation.x = m * amp * Math.sin(p) + bite * 0.2;
    b[id + '2'].rotation.x = m * lift * 1.0;
    b[id + '3'].rotation.x = -m * lift * 0.6;
  }
  const flex = Math.sin(ph + 0.4);
  b.root.rotation.x = m * Math.sin(ph + 1.2) * 0.07 - e.hitK * 0.08;
  b.spine.rotation.x = m * flex * 0.1;
  b.spine.rotation.z = e.hitK * 0.3 * e.hitSide;
  b.chest.rotation.x = -m * flex * 0.13 + bite * 0.22;
  const look = clamp(rel, -0.9, 0.9);
  b.neck.rotation.x = -(b.root.rotation.x + b.spine.rotation.x + b.chest.rotation.x) * 0.8 - bite * 0.4 + e.hitK * 0.2;
  b.neck.rotation.y = look * 0.5; b.head.rotation.y = look * 0.4;
  b.head.rotation.x = bite * 0.2;
  b.head.rotation.z = Math.sin(t * 2.3 + e.phase) * 0.05 * (1 - m);
  b.jaw.rotation.x = bite * 0.75 + (dist < 10 ? 0.14 + Math.sin(t * 13 + e.phase) * 0.07 : 0.02);
  b.tail1.rotation.y = Math.sin(t * 8 + e.phase) * (0.15 + m * 0.3); b.tail2.rotation.y = Math.sin(t * 8 + e.phase - 1) * (0.2 + m * 0.4);
  b.tail1.rotation.x = -0.25 * m + 0.2 * (1 - m);
  const r = rest(b.root);
  b.root.position.set(r.x, r.y, r.z + bite * 0.3);
  plant(e, HOUND_TIPS);
  b.root.position.y += m * Math.max(0, Math.sin(ph * 2 + 1)) * 0.06; // 奔跑时四脚有短暂的腾空
}

const GUARD_TIPS = ['legLT', 'legRT'];
function poseGuard(e: Enemy, dt: number, t: number, rel: number, dist: number, targetY: number) {
  const b = e.bones, m = e.move, ph = e.anim;
  e.aimYaw = damp(e.aimYaw, e.hasLos ? clamp(rel, -0.8, 0.8) : 0, 6, dt);
  e.aimPitch = damp(e.aimPitch, e.hasLos ? clamp(Math.atan2(targetY - (e.pos.y + 2.0), dist), -0.5, 0.6) : -0.25, 6, dt);
  e.guardK = damp(e.guardK, e.hasLos ? 1 : 0, 4, dt);
  const brace = e.charge > 0 ? 1 - e.charge / 0.55 : e.burst > 0 ? 1 : 0; // 充能和连射时压低重心
  for (const [id, off] of [['legL', 0], ['legR', Math.PI]] as [string, number][]) {
    const p = ph + off, th = m * 0.5 * Math.sin(p) - brace * 0.1, kn = m * Math.max(0, -Math.cos(p)) * 0.95 + brace * 0.22;
    b[id + '1'].rotation.x = th; b[id + '2'].rotation.x = kn; b[id + '3'].rotation.x = -(th + kn) * 0.8;
  }
  b.root.rotation.z = m * Math.sin(ph) * 0.035;
  b.root.rotation.y = m * Math.sin(ph) * 0.07;
  b.torso.rotation.y = e.aimYaw - b.root.rotation.y;
  b.torso.rotation.x = m * 0.05 + brace * 0.1 - e.hitK * 0.12 - e.recoil * 0.03;
  b.torso.rotation.z = e.hitK * 0.09 * e.hitSide - b.root.rotation.z;
  b.torso.position.y = rest(b.torso).y + Math.sin(t * 1.7 + e.phase) * 0.008;
  b.head.rotation.y = clamp(rel - e.aimYaw, -0.7, 0.7);
  b.head.rotation.x = -e.aimPitch * 0.6 + e.hitK * 0.15;
  b.armR1.rotation.x = -e.aimPitch - e.recoil * 0.07;
  b.gun.position.z = rest(b.gun).z - e.recoil * 0.16;
  // 左臂：看得见玩家时把护盾举到身前，否则随步伐摆动
  b.armL1.rotation.x = -0.5 * e.guardK + (1 - e.guardK) * m * Math.sin(ph + Math.PI) * 0.3;
  b.armL2.rotation.x = -0.25 * e.guardK; b.armL2.rotation.y = 0.45 * e.guardK;
  const r = rest(b.root);
  b.root.position.set(r.x + m * Math.sin(ph) * 0.04, r.y, r.z);
  plant(e, GUARD_TIPS);
}

function poseGull(e: Enemy, t: number, rel: number, dist: number, targetY: number) {
  const b = e.bones;
  for (let i = 0; i < 4; i++) b['rotor' + i].rotation.y = (i % 3 === 0 ? 1 : -1) * (t * 38 + e.phase); // 对角的两只旋翼同向，相邻的反向
  b.root.position.y = Math.sin(t * 2.1 + e.phase) * 0.04;                                                // 悬停时轻微的上下浮动
  // 四旋翼靠倾斜机身来加速：飞得越快，机头压得越低
  b.root.rotation.x = clamp(Math.hypot(e.vel.x, e.vel.z) * 0.028, 0, 0.26) + clamp(-e.vel.y * 0.04, -0.3, 0.3) - e.recoil * 0.22 + e.hitK * 0.25;
  b.root.rotation.z = e.hitK * 0.4 * e.hitSide + Math.sin(t * 1.3 + e.phase) * 0.035;
  b.head.rotation.y = clamp(rel, -1.2, 1.2);                                                              // 云台盯着玩家
  b.head.rotation.x = clamp(Math.atan2(e.pos.y - targetY, Math.max(1, dist)), -0.2, 1.1) - b.root.rotation.x;
}

const _hit = { t: 0, nx: 0, ny: 0, nz: 0 };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _chest = new THREE.Vector3();
