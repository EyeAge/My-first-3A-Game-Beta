import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { GameAudio } from '../audio/audio';
import type { Effects } from '../render/effects';
import type { Colliders } from '../world/colliders';
import type { NavGrid } from '../world/nav';
import { BOUNDS } from '../world/port';
import type { Player } from './player';

export type Kind = 'gull' | 'hound' | 'guard';
export const KIND_NAME: Record<Kind, string> = { gull: '机械飞鸥', hound: '机械猎犬', guard: '机械守卫' };

interface Spec { hp: number; speed: number; bodyY: number; bodyR: number; weak: [number, number, number]; weakR: number }
const SPEC: Record<Kind, Spec> = {
  gull: { hp: 45, speed: 9, bodyY: 0, bodyR: 0.6, weak: [0, 0.02, 0.7], weakR: 0.2 },
  hound: { hp: 75, speed: 7.4, bodyY: 0.68, bodyR: 0.62, weak: [0, 0.82, 0.86], weakR: 0.26 },
  guard: { hp: 240, speed: 2.7, bodyY: 1.45, bodyR: 0.85, weak: [0, 2.3, 0.08], weakR: 0.3 },
};

export interface Enemy {
  kind: Kind; spec: Spec;
  group: THREE.Group; pos: THREE.Vector3;
  hp: number; alive: boolean;
  yaw: number; flash: number;
  bodyMat: THREE.MeshStandardMaterial;
  limbs: THREE.Object3D[]; glow: THREE.MeshBasicMaterial | null;
  path: number[] | null; pathI: number; pathT: number;
  attackT: number; burst: number; burstT: number; charge: number;
  losT: number; hasLos: boolean;
  phase: number; anim: number;
  orbit: number; alt: number; vel: THREE.Vector3;
}
export interface HitResult { enemy: Enemy; t: number; weak: boolean }
export interface World { colliders: Colliders; nav: NavGrid; effects: Effects; audio: GameAudio; camera: THREE.Camera }

const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPH = new THREE.SphereGeometry(1, 12, 8);
const BODY = new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.38, metalness: 0.75 });
const ACCENT = new THREE.MeshStandardMaterial({ color: 0xb85a1c, roughness: 0.45, metalness: 0.4 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x121416, roughness: 0.5, metalness: 0.6 });
const EYE = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.25, 0.12) });
const BOLT = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 1.6, 0.5) });

function part(parent: THREE.Object3D, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, geo: THREE.BufferGeometry = BOX) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}
function pivot(parent: THREE.Object3D, x: number, y: number, z: number) {
  const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g;
}

// 三种敌人的外形都是用方盒子拼出来的；本地坐标 +z 是它的正前方。
function buildGull(body: THREE.Material) {
  const g = new THREE.Group(); const limbs: THREE.Object3D[] = [];
  part(g, body, 0.46, 0.3, 1.0, 0, 0, 0);
  part(g, ACCENT, 0.3, 0.1, 0.5, 0, 0.18, -0.1);
  part(g, body, 0.28, 0.26, 0.34, 0, 0.02, 0.6);
  part(g, EYE, 0.1, 0.1, 0.06, 0, 0.02, 0.79, SPH);
  part(g, DARK, 0.08, 0.08, 0.5, 0, -0.2, 0.3);
  part(g, body, 0.5, 0.05, 0.3, 0, 0.05, -0.62);
  part(g, body, 0.05, 0.3, 0.26, 0, 0.2, -0.64);
  for (const s of [-1, 1]) {
    const w = pivot(g, s * 0.22, 0.08, 0);
    part(w, body, 1.2, 0.04, 0.5, s * 0.6, 0, 0);
    part(w, ACCENT, 0.5, 0.045, 0.3, s * 1.3, 0, -0.06);
    limbs.push(w);
  }
  return { g, limbs, glow: null as THREE.MeshBasicMaterial | null };
}
function buildHound(body: THREE.Material) {
  const g = new THREE.Group(); const limbs: THREE.Object3D[] = [];
  part(g, body, 0.52, 0.46, 1.25, 0, 0.7, 0);
  part(g, ACCENT, 0.3, 0.08, 0.9, 0, 0.96, -0.05);
  part(g, body, 0.38, 0.34, 0.5, 0, 0.84, 0.8);
  part(g, DARK, 0.3, 0.14, 0.3, 0, 0.72, 1.08);
  part(g, EYE, 0.32, 0.07, 0.04, 0, 0.9, 1.06);
  part(g, DARK, 0.1, 0.1, 0.4, 0, 0.82, -0.78);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const l = pivot(g, sx * 0.25, 0.62, sz * 0.46);
    part(l, DARK, 0.13, 0.36, 0.16, 0, -0.16, 0.05);
    part(l, body, 0.1, 0.34, 0.1, 0, -0.45, -0.03);
    limbs.push(l);
  }
  return { g, limbs, glow: null as THREE.MeshBasicMaterial | null };
}
function buildGuard(body: THREE.Material) {
  const g = new THREE.Group(); const limbs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const l = pivot(g, s * 0.32, 1.25, 0);
    part(l, body, 0.3, 0.62, 0.36, 0, -0.3, 0);
    part(l, DARK, 0.24, 0.62, 0.28, 0, -0.9, 0.04);
    part(l, body, 0.34, 0.12, 0.52, 0, -1.19, 0.08);
    limbs.push(l);
  }
  part(g, DARK, 0.7, 0.3, 0.42, 0, 1.3, 0);
  part(g, body, 1.08, 0.86, 0.66, 0, 1.78, 0);
  part(g, ACCENT, 0.5, 0.4, 0.1, 0, 1.82, 0.36);
  part(g, EYE, 0.12, 0.12, 0.05, 0, 1.82, 0.42, SPH);
  part(g, body, 0.4, 0.34, 0.4, 0, 2.38, 0.04);
  part(g, EYE, 0.3, 0.07, 0.04, 0, 2.4, 0.25);
  for (const s of [-1, 1]) part(g, body, 0.36, 0.34, 0.44, s * 0.72, 2.0, 0);
  part(g, DARK, 0.2, 0.7, 0.24, -0.74, 1.5, 0.05);
  part(g, body, 0.5, 0.9, 0.08, -0.82, 1.45, 0.3); // 左臂挂一块护盾
  part(g, DARK, 0.24, 0.26, 1.0, 0.74, 1.62, 0.32); // 右臂是炮管
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.08, 0.03) });
  part(g, glow, 0.14, 0.14, 0.06, 0.74, 1.62, 0.84, SPH);
  return { g, limbs, glow };
}

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
    for (const e of this.list) this.group.remove(e.group);
    this.list.length = 0;
    for (const b of this.bolts) { b.life = 0; b.mesh.visible = false; }
  }

  spawn(kind: Kind, x: number, z: number) {
    const bodyMat = BODY.clone();
    const built = kind === 'gull' ? buildGull(bodyMat) : kind === 'hound' ? buildHound(bodyMat) : buildGuard(bodyMat);
    const spec = SPEC[kind];
    built.g.position.set(x, kind === 'gull' ? 20 : 0, z);
    this.group.add(built.g);
    const e: Enemy = {
      kind, spec, group: built.g, pos: built.g.position, hp: spec.hp, alive: true, yaw: 0, flash: 0, bodyMat,
      limbs: built.limbs, glow: built.glow, path: null, pathI: 0, pathT: Math.random() * 0.6,
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
    e.attackT = Math.max(e.attackT, 0.25);
    if (e.hp <= 0) { this.kill(e, weak); return true; }
    return false;
  }

  private kill(e: Enemy, weak: boolean) {
    e.alive = false;
    const c = _a.set(e.pos.x, e.pos.y + e.spec.bodyY, e.pos.z);
    this.world.effects.explosion(c, e.kind === 'guard' ? 1.7 : e.kind === 'hound' ? 1 : 0.8);
    const [vol, pan] = this.spatial(c);
    this.world.audio.explode(vol, pan);
    this.group.remove(e.group);
    e.bodyMat.dispose();
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
        const flap = Math.sin(t * 13 + e.phase) * 0.5;
        e.limbs[0].rotation.z = flap; e.limbs[1].rotation.z = -flap;
        e.group.rotation.z = clamp(-e.vel.x * Math.cos(e.yaw) * 0.04 + e.vel.z * Math.sin(e.yaw) * 0.04, -0.5, 0.5);
        if (e.attackT <= 0 && e.hasLos && dist < 48) {
          e.attackT = 2.0 + Math.random() * 1.4;
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
        e.anim += dt * (moving ? (e.kind === 'hound' ? 15 : 5.5) : 0);
        const sw = moving ? Math.sin(e.anim) : 0;
        if (e.kind === 'hound') {
          e.limbs[0].rotation.x = sw * 0.8; e.limbs[3].rotation.x = sw * 0.8; e.limbs[1].rotation.x = -sw * 0.8; e.limbs[2].rotation.x = -sw * 0.8;
          e.group.position.y = Math.abs(Math.sin(e.anim)) * 0.06;
          if (dist < 2.1 && Math.abs(player.pos.y - e.pos.y) < 1.8 && e.attackT <= 0) {
            e.attackT = 1.2;
            this.onPlayerHit(11, e.pos);
            const [vol, pan] = this.spatial(e.pos);
            audio.bark(vol, pan);
          }
        } else {
          e.limbs[0].rotation.x = sw * 0.5; e.limbs[1].rotation.x = -sw * 0.5;
          const muzzle = _a.set(e.pos.x + 0.74 * Math.cos(e.yaw) + 0.9 * Math.sin(e.yaw), e.pos.y + 1.62, e.pos.z - 0.74 * Math.sin(e.yaw) + 0.9 * Math.cos(e.yaw));
          // 守卫开火前炮口会先充能发亮，给玩家留出找掩体的时间
          if (e.burst > 0) {
            e.burstT -= dt;
            if (e.burstT <= 0) { e.burst--; e.burstT = 0.16; this.fire(muzzle, chest, 52, 9, 0.03); }
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
      p.addScaledVector(b.vel, dt);
      if (p.distanceToSquared(chest) < 0.55 * 0.55 || (Math.hypot(p.x - px, p.z - pz) < 0.42 && p.y > player.pos.y && p.y < player.pos.y + player.height)) {
        this.onPlayerHit(b.dmg, _c.copy(p).addScaledVector(b.vel, -1));
        b.life = 0;
      } else if (p.y < 0.03 || colliders.pointInside(p.x, p.y, p.z)) {
        effects.sparks(p, -b.vel.x * 0.02, 0.5, -b.vel.z * 0.02, 5);
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
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _chest = new THREE.Vector3();
