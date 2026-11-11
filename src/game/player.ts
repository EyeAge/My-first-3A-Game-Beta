import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Input } from '../core/input';
import type { Settings } from '../core/settings';
import type { Colliders } from '../world/colliders';
import { BOUNDS, QUAY_X } from '../world/port';

const HALF = 0.36;       // 玩家碰撞体的半宽
const STAND = 1.78, CROUCH = 1.15;
const GRAVITY = 19, JUMP = 6.3;

/** 第一人称角色：移动、跳跃、蹲伏、碰撞、受伤与回血。 */
export class Player {
  pos = new THREE.Vector3();   // 脚底位置
  vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  hp = 100; alive = true;
  onGround = true; crouching = false; sprinting = false;
  inWater = false;
  lastDamageT = -99;
  /** 最近一次受伤的来向（世界坐标），HUD 用它画受击方向 */
  damageFrom = new THREE.Vector3(); damageFlash = 0;
  horizSpeed = 0;
  stepPhase = 0; stepped = false; landed = false;
  private eye = STAND - 0.12;
  private recoilP = 0; private recoilY = 0;
  private shake = 0;
  private bob = 0;

  reset(start: THREE.Vector3) {
    this.pos.copy(start); this.vel.set(0, 0, 0);
    this.yaw = 0; this.pitch = 0; this.hp = 100; this.alive = true;
    this.onGround = true; this.inWater = false; this.lastDamageT = -99; this.damageFlash = 0;
    this.recoilP = this.recoilY = this.shake = 0;
  }

  get height() { return this.crouching ? CROUCH : STAND; }
  get eyePos() { return _eye.set(this.pos.x, this.pos.y + this.eye, this.pos.z); }
  forward(out: THREE.Vector3) {
    const cp = Math.cos(this.pitch + this.recoilP);
    return out.set(-Math.sin(this.yaw + this.recoilY) * cp, Math.sin(this.pitch + this.recoilP), -Math.cos(this.yaw + this.recoilY) * cp);
  }

  kick(up: number, side: number) {
    this.recoilP += up; this.recoilY += side;
    this.pitch = clamp(this.pitch + up * 0.25, -1.5, 1.5); // 一部分后坐力是"真的"抬枪口，需要玩家自己压
  }
  addShake(a: number) { this.shake = Math.min(1, this.shake + a); }

  takeDamage(n: number, from: THREE.Vector3 | null, t: number) {
    if (!this.alive) return;
    this.hp -= n; this.lastDamageT = t; this.damageFlash = 1;
    if (from) this.damageFrom.copy(from);
    this.addShake(0.25 + n * 0.012);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }

  update(dt: number, t: number, input: Input, s: Settings, col: Colliders, ads: number) {
    // ---- 视角
    const sens = 0.0022 * s.sensitivity * (1 - ads * 0.45);
    this.yaw -= input.lookDX * sens + input.keyLookX * 2.2 * dt;
    this.pitch -= (input.lookDY * sens + input.keyLookY * 1.6 * dt) * (s.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    this.recoilP = damp(this.recoilP, 0, 9, dt); this.recoilY = damp(this.recoilY, 0, 9, dt);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);

    // ---- 期望速度
    this.crouching = input.down('KeyC') || input.down('ControlLeft');
    const mx = input.moveX, my = input.moveY;
    this.sprinting = (input.down('ShiftLeft') || input.down('ShiftRight')) && my > 0.5 && !this.crouching && ads < 0.3;
    const max = this.crouching ? 2.6 : this.sprinting ? 8.4 : ads > 0.5 ? 3.2 : 5.2;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * my + cos * mx, wz = -cos * my - sin * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const rate = this.onGround ? 11 : 2.2; // 空中几乎不能转向
    this.vel.x = damp(this.vel.x, wx * max, rate, dt);
    this.vel.z = damp(this.vel.z, wz * max, rate, dt);
    if (this.onGround && input.pressed('Space')) { this.vel.y = JUMP; this.onGround = false; }

    // ---- 逐轴移动并解决碰撞：先 x，再 z，最后 y
    const step = this.onGround ? 0.5 : 0.12; // 走路时可以直接迈上矮台阶
    const h = this.height;
    const boxes = col.boxes;
    for (let axis = 0; axis < 2; axis++) {
      const d = (axis === 0 ? this.vel.x : this.vel.z) * dt;
      if (axis === 0) this.pos.x += d; else this.pos.z += d;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (this.pos.x + HALF <= b.minX || this.pos.x - HALF >= b.maxX || this.pos.z + HALF <= b.minZ || this.pos.z - HALF >= b.maxZ) continue;
        if (this.pos.y + step >= b.maxY || this.pos.y + h <= b.minY) continue;
        if (axis === 0) { this.pos.x = d > 0 ? b.minX - HALF - 1e-3 : b.maxX + HALF + 1e-3; this.vel.x = 0; }
        else { this.pos.z = d > 0 ? b.minZ - HALF - 1e-3 : b.maxZ + HALF + 1e-3; this.vel.z = 0; }
      }
    }
    this.pos.x = Math.max(BOUNDS.minX + HALF, this.pos.x);
    this.pos.z = clamp(this.pos.z, BOUNDS.minZ + HALF, BOUNDS.maxZ - HALF);

    this.vel.y -= GRAVITY * dt;
    let ny = this.pos.y + this.vel.y * dt;
    let ground = this.pos.x <= QUAY_X ? 0 : -Infinity; // 码头以东是海，没有地面
    const inset = HALF - 0.03;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (this.pos.x + inset <= b.minX || this.pos.x - inset >= b.maxX || this.pos.z + inset <= b.minZ || this.pos.z - inset >= b.maxZ) continue;
      if (b.maxY <= this.pos.y + step + 0.01 && b.maxY > ground) ground = b.maxY;
      if (this.vel.y > 0 && b.minY >= this.pos.y + h - 0.02 && ny + h > b.minY) { ny = b.minY - h; this.vel.y = 0; }
    }
    const wasAir = !this.onGround;
    if (ny <= ground) {
      this.landed = wasAir && this.vel.y < -4;
      if (this.landed) this.addShake(0.12);
      ny = ground; this.vel.y = 0; this.onGround = true;
    } else { this.onGround = false; this.landed = false; }
    this.pos.y = ny;
    this.inWater = this.pos.y < -2.4;

    // ---- 镜头细节：蹲起的过渡、脚步晃动
    this.eye = damp(this.eye, this.height - 0.12, 12, dt);
    this.horizSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.stepped = false;
    if (this.onGround && this.horizSpeed > 1) {
      const prev = this.stepPhase;
      this.stepPhase += this.horizSpeed * dt * 0.62;
      if (Math.floor(prev) !== Math.floor(this.stepPhase)) this.stepped = true;
      this.bob = damp(this.bob, 1, 8, dt);
    } else this.bob = damp(this.bob, 0, 8, dt);

    // ---- 回血：一段时间没挨打就慢慢恢复
    if (this.alive && t - this.lastDamageT > 5 && this.hp < 100) this.hp = Math.min(100, this.hp + 14 * dt);
  }

  applyCamera(cam: THREE.PerspectiveCamera, t: number) {
    const bobY = Math.sin(this.stepPhase * Math.PI * 2) * 0.035 * this.bob;
    const bobX = Math.cos(this.stepPhase * Math.PI) * 0.02 * this.bob;
    cam.position.set(this.pos.x, this.pos.y + this.eye + bobY, this.pos.z);
    const sh = this.shake * this.shake * 0.05;
    cam.rotation.set(
      this.pitch + this.recoilP + Math.sin(t * 71) * sh,
      this.yaw + this.recoilY + Math.sin(t * 53 + 1) * sh,
      bobX * 0.4 + Math.sin(t * 61 + 2) * sh * 0.6, 'YXZ');
  }
}
const _eye = new THREE.Vector3();
