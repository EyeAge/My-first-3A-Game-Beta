import * as THREE from 'three';
import { SUN_DIR } from '../world/atmosphere';
import type { Colliders, Surface } from '../world/colliders';
import { ADD_FRAME, LIT_FRAME, atlasTexture, bakeAddAtlas, bakeLitAtlas } from './fxatlas';
import { BOUNCE, DIE_ON_GROUND, FxView, MODE_FLAT, MODE_STRETCH, ParticlePool, ParticleRenderer, RAMP_EMBER, RAMP_FIRE, RAMP_SPARK, TracerPool } from './fxparticles';
import { DebrisPool, ShellPool } from './fxsolids';

// 特效：爆炸、弹着、枪口焰、曳光、烟、水花、碎片、弹壳，还有一闪而过的灯光。
//
// 这个文件只管"配方"—— 一次爆炸由哪些层组成、每层多少个粒子、多大、多快、什么颜色。
// 粒子怎么画在 fxparticles.ts，粒子的贴图怎么来的在 fxatlas.ts，碎片和弹壳在 fxsolids.ts。
//
// 整个特效系统只有 4 个绘制调用（受光粒子、叠加粒子、碎片、弹壳），没有东西在飞的时候是 0 个。
// 其中两池粒子不和场景一起画，而是由渲染器留到后处理中途再盖上去（见下面的 overlay）。
// 所有粒子开局一次分配好，之后循环复用，游戏过程中不申请内存。
//
// 颜色的数值大多大于 1：画面是先按"真实的亮度"算，最后才压进屏幕能显示的范围（见 post.ts）。
// 火星写成 (40, 25, 10) 的意思是它比白墙亮几十倍 —— 所以它周围才会有一圈光晕，而且即使只有一两个像素大也看得见。

/** 受光粒子（烟、尘、水、火球）最多同时有多少个；叠加粒子（火星、闪光、曳光）最多多少个。 */
const LIT_MAX = 1400, ADD_MAX = 3200;
/** 叠加池里留给曳光的位置：48 条 × 每条 3 张方片 = 144，取整留 160。 */
const TRACER_MAX = 48, TRACER_RESERVE = 160;
const LIGHTS = 6, EMITTERS = 24;

/** 子弹打到的是什么。前五种来自碰撞盒上的标记，water 是海面和积水，enemy 是敌人的外壳。 */
export type ImpactSurface = Surface | 'water' | 'enemy';
export interface TracerOpts {
  /** 十六进制颜色，不给就是暖黄色。 */
  color?: number;
  /** 亮度倍数，默认 16。 */
  intensity?: number;
  /** 飞行速度（米/秒），默认 260：比真子弹慢得多，为的是眼睛跟得上。 */
  speed?: number;
  /** 亮芯的粗细（米），默认 0.024。 */
  width?: number;
  /** false = 不留弹道上那几团淡烟。 */
  trail?: boolean;
}
export interface PuffOpts { size?: number; life?: number; rise?: number; color?: number; count?: number; alpha?: number; vx?: number; vy?: number; vz?: number; fire?: boolean }
/** 持续冒东西的点：蒸汽、余烟、飘飞的余烬、一堆火。 */
export type EmitterKind = 'steam' | 'smolder' | 'embers' | 'fire';
interface Emitter { live: boolean; kind: EmitterKind; x: number; y: number; z: number; age: number; ttl: number; scale: number; shade: number; acc: number; acc2: number; lamp: Lamp | null }
interface Lamp { light: THREE.PointLight; left: number; total: number; peak: number; held: boolean }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const _dir = new THREE.Vector3(), _col = new THREE.Color(), _v = new THREE.Vector3();
/**
 * 在 (dx, dy, dz) 周围随机挑一个方向，结果写进 _dir。
 * 做法：方向向量加上一个"半径为 spread 的球里的随机点"再归一化。spread 0 = 正对着；1 ≈ 半球；1.5 以上接近朝四面八方。
 */
function scatter(dx: number, dy: number, dz: number, spread: number) {
  let x: number, y: number, z: number;
  do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; } while (x * x + y * y + z * z > 1);
  _dir.set(dx + x * spread, dy + y * spread, dz + z * spread);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
  return _dir.normalize();
}

export class Effects {
  readonly group = new THREE.Group();
  /** 全场的风（米/秒）：烟和尘最后都顺着它飘。 */
  readonly wind = new THREE.Vector3(-0.8, 0, 0.3);
  /**
   * 碰撞世界。有了它，特效才知道"这里晒不晒得到太阳"（影子里的烟不该被照亮）和"脚下的地面有多高"（碎片落在箱子顶上而不是穿下去）。
   * 不给也能用：一律当作晒得到、地面在 y=0。
   */
  colliders: Colliders | null = null;
  /**
   * 交给渲染器的"粒子层"（renderer.ts 的 OverlayLayer）：object 里是两池粒子的网格，active 是这一帧有没有粒子要画。
   * 它是 group 的子节点，所以地面倒影那一趟照常会画到它；主画面那一趟由渲染器先藏起来，等场景画完再单独画。
   */
  readonly overlay: { readonly object: THREE.Group; readonly active: boolean };
  private view = new FxView();
  private lit = new ParticlePool(LIT_MAX, true);
  private glow = new ParticlePool(ADD_MAX - TRACER_RESERVE, false);
  private litDraw: ParticleRenderer; private glowDraw: ParticleRenderer;
  private tracers = new TracerPool(TRACER_MAX);
  private debrisPool = new DebrisPool(256);
  private shells: ShellPool;
  private lamps: Lamp[] = [];
  private emitters: Emitter[] = Array.from({ length: EMITTERS }, () => ({ live: false, kind: 'steam' as EmitterKind, x: 0, y: 0, z: 0, age: 0, ttl: 0, scale: 1, shade: 1, acc: 0, acc2: 0, lamp: null }));
  private time = 0; private dt = 0.016;
  private lastImpactLight = -1; private lastTracerSmoke = -1;

  constructor() {
    this.litDraw = new ParticleRenderer(LIT_MAX, true, atlasTexture(bakeLitAtlas()), 10, this.view);
    this.glowDraw = new ParticleRenderer(ADD_MAX, false, atlasTexture(bakeAddAtlas()), 20, this.view);
    this.shells = new ShellPool((x, y, z) => this.groundBelow(x, y, z, 6));
    const layer = new THREE.Group(), lit = this.litDraw.mesh, glow = this.glowDraw.mesh;
    layer.add(lit, glow);
    this.overlay = { object: layer, get active() { return lit.visible || glow.visible; } };
    this.group.add(layer, this.debrisPool.mesh, this.shells.mesh);
    // 闪光用的灯：6 盏点光常驻在场景里，不用的时候亮度是 0。
    // 为什么不"要用时加一盏、用完删掉"：场景里灯的数量一变，所有材质的着色器都要重新编译，画面会卡一下。
    for (let i = 0; i < LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 12, 2);
      this.group.add(light);
      this.lamps.push({ light, left: 0, total: 1, peak: 0, held: false });
    }
  }

  /** 软粒子（烟和地面、墙相交处淡出）的开关。 */
  get softParticles() { return this.view.soft; }
  set softParticles(on: boolean) { this.view.soft = on; }
  stats() { return { lit: this.lit.count, additive: this.glowDraw.count, litMax: LIT_MAX, additiveMax: ADD_MAX, drawCalls: +this.litDraw.mesh.visible + +this.glowDraw.mesh.visible + +this.debrisPool.mesh.visible + +this.shells.mesh.visible }; }
  clear() {
    this.lit.clear(); this.glow.clear(); this.tracers.clear(); this.debrisPool.clear(); this.shells.clear();
    for (const e of this.emitters) this.stopEmitter(e);
    for (const l of this.lamps) { l.left = 0; l.held = false; l.light.intensity = 0; }
  }

  // ------------------------------------------------------------------ 查询世界

  /** 这个位置晒不晒得到太阳：朝太阳的方向看 90 米，被挡住返回 0.2（只剩一点漫射光），没挡住返回 1。 */
  private sunlit(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0) {
    const c = this.colliders;
    if (!c) return 1;
    return c.raycast(x + nx * 0.08, y + ny * 0.08 + 0.03, z + nz * 0.08, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z, 90) < 90 ? 0.2 : 1;
  }
  /** 正下方地面的高度：往下看 reach 米，什么都没有就返回 -50（当它掉进了无底洞）。 */
  private groundBelow(x: number, y: number, z: number, reach = 12) {
    const c = this.colliders;
    if (!c) return 0;
    const t = c.raycast(x, y + 0.1, z, 1e-9, -1, 1e-9, reach);
    return t < reach ? y + 0.1 - t : -50;
  }

  // ------------------------------------------------------------------ 积木：下面的配方都是用这几样拼出来的

  /** 一团受光的烟。rise 是浮力（每秒向上的加速度）；windK 是跟不跟风；frame 不给就在六种烟团里随机挑。 */
  private smokePuff(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, alpha: number, shade: number, drag: number, rise: number, windK: number, frame = -1) {
    const P = this.lit, i = P.emit(x, y, z, vx, vy, vz, life, s0, s1);
    if (i < 0) return -1;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.a[i] = alpha; P.extra[i] = shade; P.drag[i] = drag; P.grav[i] = -rise; P.wind[i] = windK;
    P.turb[i] = 0.5; P.rot[i] = Math.random() * 6.283; P.spin[i] = (Math.random() - 0.5) * 1.2;
    P.frame[i] = frame < 0 ? Math.floor(Math.random() * LIT_FRAME.PUFF_VARIANTS) : frame;
    P.fadeIn[i] = 0.06; P.fadeOut[i] = 0.3; P.grow[i] = 2.5;
    return i;
  }
  /** 一颗火星：沿飞行方向拉成一条短线，受重力，颜色随时间冷却。flags 决定落地是弹起来还是不管。 */
  private spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, flags: number, groundY: number) {
    const P = this.glow, i = P.emit(x, y, z, vx, vy, vz, life, size, size * 0.5);
    if (i < 0) return -1;
    P.mode[i] = MODE_STRETCH; P.frame[i] = ADD_FRAME.STREAK; P.stretch[i] = 0.03; P.grav[i] = 9.81; P.drag[i] = 0.9; P.ramp[i] = RAMP_SPARK;
    P.r[i] = r * 0.6; P.g[i] = g * 0.6; P.b[i] = b * 0.6; P.fadeOut[i] = 0.55; P.grow[i] = 1; P.flags[i] = flags; P.groundY[i] = groundY;
    return i;
  }
  /** 一簇火星：大致朝 (dx, dy, dz) 喷出去，速度有快有慢，每颗的色相再抖一点（不然像复制粘贴出来的）。 */
  private sparkBurst(x: number, y: number, z: number, dx: number, dy: number, dz: number, count: number, vMin: number, vMax: number, spread: number, lifeMin: number, lifeMax: number, r: number, g: number, b: number, flags = 0) {
    const groundY = flags ? this.groundBelow(x, y, z) : 0, len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    for (let i = 0; i < count; i++) {
      const d = scatter(dx, dy, dz, spread), speed = rand(vMin, vMax) * (0.35 + 0.65 * Math.random());
      this.spark(x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(lifeMin, lifeMax), rand(0.01, 0.02), r * rand(0.6, 1.2), g * rand(0.6, 1.2), b, flags, groundY);
    }
  }
  /** 一片原地不动的闪光（光晕或星芒），只活几十毫秒。 */
  private glint(x: number, y: number, z: number, life: number, s0: number, s1: number, r: number, g: number, b: number, frame: number) {
    const P = this.glow, i = P.emit(x, y, z, 0, 0, 0, life, s0, s1);
    if (i < 0) return -1;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.frame[i] = frame; P.fadeOut[i] = 0.2; P.rot[i] = Math.random() * 6.283; P.grow[i] = 1.5;
    return i;
  }
  /** 一圈平贴在地上、迅速扩开的环：爆炸的冲击波、水面的涟漪。 */
  private ring(x: number, y: number, z: number, life: number, s0: number, s1: number, r: number, g: number, b: number) {
    const P = this.glow, i = P.emit(x, y, z, 0, 0, 0, life, s0, s1);
    if (i < 0) return -1;
    P.r[i] = r; P.g[i] = g; P.b[i] = b; P.mode[i] = MODE_FLAT; P.frame[i] = ADD_FRAME.RING; P.fadeIn[i] = 0.08; P.fadeOut[i] = 0.15; P.grow[i] = 2.2; P.rot[i] = Math.random() * 6.283;
    return i;
  }
  /** 一把碎片。三个方向的尺寸各给一个范围：给得扁就是漆片，给得细长就是木刺。 */
  private chips(x: number, y: number, z: number, dx: number, dy: number, dz: number, count: number, vMin: number, vMax: number, sxMin: number, sxMax: number, syMin: number, syMax: number, szMin: number, szMax: number, r: number, g: number, b: number, spread: number, floorY: number) {
    for (let i = 0; i < count; i++) {
      const d = scatter(dx, dy, dz, spread), speed = rand(vMin, vMax), tint = rand(0.8, 1.15);
      this.debrisPool.add(x, y, z, d.x * speed, d.y * speed + 0.8, d.z * speed, rand(sxMin, sxMax), rand(syMin, syMax), rand(szMin, szMax), r * tint, g * tint, b * tint, rand(3.5, 6), floorY);
    }
  }

  // ------------------------------------------------------------------ 灯

  /**
   * 闪一下灯：在 pos 亮起一盏点光，life 秒内线性熄灭。power 是亮度，distance 是照多远（米）。
   * 六盏灯都在用的时候，抢剩余时间最短的那盏。
   * 参考值：玩家开枪 45 / 9 米 / 0.05 秒；敌人开枪 22 / 7 米；子弹打金属 10 / 5 米。
   */
  flash(pos: THREE.Vector3, power: number, life: number, color = 0xffb060, distance = 10) {
    let pick: Lamp | null = null;
    for (const l of this.lamps) if (!l.held && (!pick || l.left < pick.left)) pick = l;
    if (!pick) return;
    pick.light.position.copy(pos); pick.light.color.setHex(color); pick.light.distance = distance;
    pick.left = pick.total = Math.max(life, 1e-3); pick.peak = power; pick.light.intensity = power;
  }

  // ------------------------------------------------------------------ 弹着

  /**
   * 子弹打在东西上。打到什么材质，崩出来的东西就不一样：
   *   金属  一簇顺着反弹方向飞的火星 + 闪光 + 一点烟和漆片
   *   水泥  一团灰尘 + 碎石渣，偶尔蹦两颗火星
   *   木头  偏黄的木屑尘 + 几根细长的木刺
   *   沙土、橡胶  闷闷的一团尘，没有火星
   *   水    水花
   *   敌人  火星更多更散 + 黑烟 + 外壳的漆片
   * (nx, ny, nz) 是被打的那个面的法线；dir 是子弹飞来的方向，不给就当它垂直打上去。
   */
  impact(point: THREE.Vector3, nx: number, ny: number, nz: number, surface: ImpactSurface = 'concrete', dir: THREE.Vector3 | null = null) {
    const { x, y, z } = point;
    if (surface === 'water') { this.splash(point, 1); return; }
    // 反弹方向：入射方向关于法线做镜像。火星主要朝这边飞，斜着打就斜着溅
    const ix = dir ? dir.x : -nx, iy = dir ? dir.y : -ny, iz = dir ? dir.z : -nz, dot = ix * nx + iy * ny + iz * nz;
    const rx = ix - 2 * dot * nx, ry = iy - 2 * dot * ny, rz = iz - 2 * dot * nz;
    const far = this.view.eye.distanceToSquared(point) > 55 * 55;      // 55 米外：火星减半、碎片省掉，反正看不清
    const light = this.time - this.lastImpactLight > 0.09;             // 连射时每一发都闪灯太晃眼，两次闪光至少隔 0.09 秒
    const shade = this.sunlit(x, y, z, nx, ny, nz), floor = far ? 0 : this.groundBelow(x, y, z);
    const star = Math.random() < 0.5 ? ADD_FRAME.STAR_A : ADD_FRAME.STAR_B;

    if (surface === 'metal') {
      this.sparkBurst(x, y, z, rx + nx * 0.6, ry + ny * 0.6, rz + nz * 0.6, far ? 9 : 18, 6, 24, 0.55, 0.1, 0.38, 40, 25, 10.5);
      this.sparkBurst(x, y, z, rx + nx * 0.6, ry + ny * 0.6, rz + nz * 0.6, Math.random() < 0.5 ? 2 : 3, 9, 18, 0.9, 0.7, 1.3, 32, 18, 7, BOUNCE);   // 两三颗飞得远、落地还会弹的
      this.glint(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, 0.05, 0.25, 0.45, 16, 11, 5.5, ADD_FRAME.GLOW);
      this.glint(x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, 0.04, 0.35, 0.5, 9, 6, 2.6, star);
      if (light) { this.lastImpactLight = this.time; this.flash(_v.set(x + nx * 0.12, y + ny * 0.12, z + nz * 0.12), 10, 0.05, 0xffc070, 5); }
      for (let i = 0; i < 2; i++) this.smokePuff(x, y, z, nx * 0.8 + rand(-0.25, 0.25), ny * 0.8 + 0.2, nz * 0.8 + rand(-0.25, 0.25), rand(0.5, 0.9), 0.06, rand(0.3, 0.5), 0.4, 0.4, 0.41, 0.4, shade, 2.5, 0.3, 0.8);
      if (!far) this.chips(x, y, z, nx, ny, nz, 2, 1.5, 4, 0.012, 0.03, 0.003, 0.005, 0.01, 0.025, 0.2, 0.21, 0.23, 0.8, floor);
    } else if (surface === 'enemy') {
      this.sparkBurst(x, y, z, rx + nx * 0.8, ry + ny * 0.8, rz + nz * 0.8, far ? 7 : 13, 5, 20, 0.9, 0.12, 0.45, 42, 29, 14);
      this.sparkBurst(x, y, z, rx + nx * 0.8, ry + ny * 0.8, rz + nz * 0.8, 2, 6, 12, 1.0, 0.6, 1.1, 32, 18, 7, BOUNCE);
      this.glint(x, y, z, 0.06, 0.3, 0.55, 18, 12, 6, ADD_FRAME.GLOW);
      this.glint(x, y, z, 0.04, 0.3, 0.45, 8, 5, 2.4, star);
      if (light) { this.lastImpactLight = this.time; this.flash(point, 8, 0.05, 0xffb060, 4.5); }
      for (let i = 0; i < 2; i++) this.smokePuff(x, y, z, nx * 0.5 + rand(-0.2, 0.2), ny * 0.5 + 0.3, nz * 0.5 + rand(-0.2, 0.2), rand(0.6, 1.1), 0.06, rand(0.3, 0.5), 0.13, 0.13, 0.14, 0.65, shade, 2.2, 0.5, 0.9);
      if (!far) for (let i = 0; i < 3; i++) {
        const paint = Math.random() < 0.35;                            // 三成多是橙色的漆片，其余是灰色的外壳碎屑
        this.chips(x, y, z, nx, ny, nz, 1, 2, 6, 0.012, 0.035, 0.004, 0.008, 0.012, 0.03, 0.6, paint ? 0.2 : 0.62, paint ? 0.05 : 0.64, 0.8, floor);
      }
    } else if (surface === 'wood') {
      this.dust(point, nx, ny, nz, 0.75, 0.4, 0.33, 0.25);
      this.chips(x, y, z, nx, ny, nz, far ? 3 : 7, 2, 6, 0.004, 0.009, 0.03, 0.1, 0.004, 0.012, 0.62, 0.5, 0.33, 0.7, floor);   // 木刺：细长条
      if (shade > 0.5 && Math.random() < 0.3) this.glint(x, y, z, 0.04, 0.1, 0.2, 3, 2, 1, ADD_FRAME.GLOW);
    } else if (surface === 'dirt' || surface === 'rubber') {
      const r = surface === 'dirt' ? 0.3 : 0.14, g = surface === 'dirt' ? 0.25 : 0.14, b = surface === 'dirt' ? 0.19 : 0.14;
      for (let i = 0; i < 5; i++) {
        const d = scatter(nx, ny, nz, 0.6), speed = rand(0.6, 2.6);
        this.smokePuff(x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(0.5, 1), 0.07, rand(0.3, 0.55), r, g, b, 0.85, shade, 3.5, 0.1, 0.6, i < 2 ? LIT_FRAME.DENSE : -1);
      }
      if (!far) this.chips(x, y, z, nx, ny, nz, 3, 1.5, 4, 0.01, 0.03, 0.008, 0.02, 0.01, 0.03, r * 0.8, g * 0.8, b * 0.8, 0.7, floor);
    } else {
      this.dust(point, nx, ny, nz, 1, 0.4, 0.385, 0.36);
      this.chips(x, y, z, nx, ny, nz, far ? 2 : 4, 1.5, 5.5, 0.012, 0.035, 0.008, 0.02, 0.012, 0.035, 0.42, 0.41, 0.39, 0.7, floor);
      // 崩飞的碎屑：几小团很实的灰，飞得快、受重力往下掉（和上面慢慢飘散的尘不一样）
      const len = Math.hypot(rx + nx * 0.7, ry + ny * 0.7, rz + nz * 0.7) || 1;
      for (let i = 0; i < 4; i++) {
        const d = scatter((rx + nx * 0.7) / len, (ry + ny * 0.7) / len, (rz + nz * 0.7) / len, 0.5), speed = rand(3, 9);
        const k = this.smokePuff(x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(0.25, 0.45), 0.03, 0.09, 0.6, 0.58, 0.54, 0.7, shade, 2, -6, 0.2, LIT_FRAME.DENSE);
        if (k >= 0) this.lit.turb[k] = 0;
      }
      if (Math.random() < 0.3) this.sparkBurst(x, y, z, rx + nx, ry + ny, rz + nz, 3, 4, 10, 0.6, 0.08, 0.2, 26, 15, 6);   // 偶尔打到里面的石子，蹦两颗火星
    }
  }

  /** 一簇火星（敌人冒电火花、近战砸中的时候用）。(nx, ny, nz) 是大致朝哪边溅。hot=false 是偏白的冷色火花。 */
  sparks(pos: THREE.Vector3, nx: number, ny: number, nz: number, count = 12, hot = true) {
    if (hot) this.sparkBurst(pos.x, pos.y, pos.z, nx, ny, nz, count, 5, 18, 0.6, 0.15, 0.5, 36, 22, 9, BOUNCE);
    else this.sparkBurst(pos.x, pos.y, pos.z, nx, ny, nz, count, 5, 18, 0.6, 0.15, 0.5, 20, 22, 26, BOUNCE);
    this.glint(pos.x, pos.y, pos.z, 0.05, 0.2, 0.35, hot ? 10 : 6, 6.5, hot ? 3 : 8, ADD_FRAME.GLOW);
  }

  /**
   * 扬起的一团尘：八小团喷得快、散得快的，加两大团慢慢飘散的薄尘。
   * amount 是规模（1 = 一发子弹打在水泥上那么大）；后三个数是尘的颜色。
   * 颜色和浓度比参考的数值压低了两成多：这座港口的地面是湿的深色沥青，原值的尘在太阳底下白得像棉花。
   */
  dust(pos: THREE.Vector3, nx: number, ny: number, nz: number, amount = 1, r = 0.38, g = 0.365, b = 0.34) {
    const { x, y, z } = pos, shade = this.sunlit(x, y, z, nx, ny, nz), scale = amount <= 1 ? amount : Math.sqrt(amount);
    for (let i = 0; i < 8; i++) {
      const d = scatter(nx, ny, nz, 0.5), speed = rand(1, 4.5) * scale, tint = rand(0.85, 1.1);
      this.smokePuff(x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(0.5, 1.1), 0.08 * scale, rand(0.35, 0.7) * scale, r * tint, g * tint, b * tint, 0.75, shade, 3.5, 0.15, 0.6, i < 3 ? LIT_FRAME.DENSE : -1);
    }
    for (let i = 0; i < 2; i++)
      this.smokePuff(x + nx * 0.15, y + ny * 0.15, z + nz * 0.15, nx * 0.5 + rand(-0.15, 0.15), ny * 0.5 + 0.1, nz * 0.5 + rand(-0.15, 0.15), rand(2.2, 3.6), 0.25 * scale, rand(0.9, 1.5) * scale, r, g, b, 0.28, shade, 1.5, 0.1, 1);
  }

  /** 重重落地时脚边扬起的一圈尘。 */
  landDust(pos: THREE.Vector3) {
    const shade = this.sunlit(pos.x, pos.y + 0.1, pos.z);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * 6.283, cs = Math.cos(a), sn = Math.sin(a);
      this.smokePuff(pos.x + cs * 0.2, pos.y + 0.08, pos.z + sn * 0.2, cs * 1.6, 0.3, sn * 1.6, rand(0.7, 1.2), 0.15, rand(0.5, 0.8), 0.45, 0.44, 0.42, 0.22, shade, 3, 0.1, 0.8);
    }
  }

  /** 一大团往上翻的黑烟（老接口，留着兼容；新代码用 puff 可以调得更细）。 */
  smoke(pos: THREE.Vector3, scale = 1) {
    this.puff(pos, { size: 0.9 * scale, life: 2.4, rise: 0.7, color: 0x1c1c1e, count: Math.max(1, Math.round(5 * scale)), alpha: 0.6 });
  }

  /**
   * 一小团"可以调"的烟：敌人受伤冒的细烟、坠落拖的烟尾、残骸上的浓烟都是它。
   *   size   烟团最后长到多大（米）。刚冒出来时只有三成大，边飘边胀
   *   life   活多少秒（每团在 0.75~1.2 倍之间随机，免得一起消失）
   *   rise   浮力：每秒给多少向上的加速度
   *   color  十六进制颜色，比如 0x15161a 是接近纯黑的烟
   *   count  一次冒几团
   *   alpha  最浓时的不透明度
   *   vx/vy/vz 初速度（比如贴地往外推的尘土）
   *   fire   true = 这不是烟而是一小团火苗：自己发光，颜色从亮黄烧到暗红
   * 一个约定：fire 的寿命不到 0.1 秒、又给了初速度，就当它是"枪口焰"，朝初速度的方向喷一下（星芒 + 喷焰 + 几颗火星）。
   * 这是为了让敌人开火的老写法（见 enemies.ts）不用改就能得到像样的枪口焰；新代码请直接调 muzzleFlash。
   */
  puff(pos: THREE.Vector3, o: PuffOpts = {}) {
    const size = o.size ?? 1, life = o.life ?? 2.5, rise = o.rise ?? 0.6, count = o.count ?? 3, vx = o.vx ?? 0, vy = o.vy ?? 0, vz = o.vz ?? 0;
    if (o.color === undefined) _col.setRGB(0.32, 0.32, 0.33); else _col.setHex(o.color);
    if (o.fire) {
      const speed = Math.hypot(vx, vy, vz);
      if (life <= 0.1 && speed > 0.01) { this.muzzleFlash(pos, vx / speed, vy / speed, vz / speed, size * 1.8, false); return; }
      // 火苗：把给的颜色往"火焰色"上靠一半再乘成很亮的值。直接用原色的话，纯橙色经过冷却渐变会红得发紫
      const r = (_col.r + 1) * 4, g = (_col.g + 0.6) * 4, b = (_col.b + 0.25) * 4;
      for (let i = 0; i < count; i++) {
        const P = this.glow, k = P.emit(pos.x + rand(-0.1, 0.1) * size, pos.y + rand(-0.1, 0.1) * size, pos.z + rand(-0.1, 0.1) * size, vx + rand(-0.2, 0.2), vy + rise * 0.6 + rand(0, 0.3), vz + rand(-0.2, 0.2), life * rand(0.75, 1.2), size * 0.9, size * rand(0.4, 0.7));
        if (k < 0) return;
        P.frame[k] = ADD_FRAME.FIRE; P.ramp[k] = RAMP_FIRE; P.r[k] = r; P.g[k] = g; P.b[k] = b; P.a[k] = o.alpha ?? 1;
        P.drag[k] = 1; P.grav[k] = -rise; P.wind[k] = 1; P.turb[k] = 2; P.rot[k] = Math.random() * 6.283; P.spin[k] = (Math.random() - 0.5) * 4; P.fadeIn[k] = 0.12; P.fadeOut[k] = 0.4;
      }
      return;
    }
    const shade = this.sunlit(pos.x, pos.y, pos.z);
    for (let i = 0; i < count; i++)
      this.smokePuff(pos.x + rand(-0.1, 0.1) * size, pos.y + rand(-0.1, 0.1) * size, pos.z + rand(-0.1, 0.1) * size, vx + rand(-0.2, 0.2), vy + rand(0, 0.3), vz + rand(-0.2, 0.2),
        life * rand(0.75, 1.2), size * 0.3, size * rand(1, 1.5), _col.r, _col.g, _col.b, o.alpha ?? 0.4, shade, 1.2, rise, 1);
  }

  // ------------------------------------------------------------------ 水花

  /**
   * 水花：几片往上喷的水柱 + 一点水雾 + 四散的水滴 + 水面上两圈涟漪。
   * scale：子弹打水 1，走路踩水 0.4，跑步 0.55，跳进水里 0.9。pos.y 就是水面的高度。
   */
  splash(pos: THREE.Vector3, scale = 1) {
    const { x, y, z } = pos, sun = this.sunlit(x, y + 0.2, z), up = Math.sqrt(scale);
    for (let i = 0; i < 5; i++) {
      const size = rand(0.35, 0.6) * scale;
      const k = this.smokePuff(x + rand(-0.04, 0.04) * scale, y + 0.1 * scale, z + rand(-0.04, 0.04) * scale, rand(-0.25, 0.25), rand(1.6, 2.8) * up, rand(-0.25, 0.25), rand(0.4, 0.65), size * 0.3, size, 0.72, 0.78, 0.84, 0.95, sun, 0.5, -7, 0, LIT_FRAME.WATER);
      if (k >= 0) { const P = this.lit; P.rot[k] = (Math.random() - 0.5) * 0.3; P.spin[k] = 0; P.turb[k] = 0; P.grow[k] = 3; P.fadeOut[k] = 0.4; }   // 水柱要竖着，不能像烟团那样乱转
    }
    for (let i = 0; i < 2; i++) this.smokePuff(x, y + 0.15 * scale, z, rand(-0.3, 0.3), 0.5, rand(-0.3, 0.3), rand(0.7, 1.1), 0.2 * scale, 0.7 * scale, 0.7, 0.75, 0.8, 0.14, sun, 2, 0, 0.8);
    const drops = Math.round(14 * Math.min(scale, 1.6));
    for (let i = 0; i < drops; i++) {
      const d = scatter(0, 1, 0, 0.75), speed = rand(1.5, 4.8) * up, P = this.glow;
      const k = P.emit(x, y + 0.02, z, d.x * speed, Math.abs(d.y) * speed, d.z * speed, rand(0.5, 1), rand(0.012, 0.024), 0.01);
      if (k < 0) break;
      // 水滴自己不发光，但会反射天光和太阳：晒得到太阳的地方亮得多
      P.mode[k] = MODE_STRETCH; P.frame[k] = ADD_FRAME.DOT; P.stretch[k] = 0.012; P.grav[k] = 9.81; P.drag[k] = 0.4;
      P.r[k] = 1.9 * sun + 0.35; P.g[k] = 1.5 * sun + 0.45; P.b[k] = 1.05 * sun + 0.55; P.fadeOut[k] = 0.7; P.flags[k] = DIE_ON_GROUND; P.groundY[k] = y;
    }
    this.ring(x, y + 0.012, z, 0.9, 0.12 * scale, 1.5 * scale, 0.18 * sun + 0.05, 0.16 * sun + 0.055, 0.13 * sun + 0.06);
    const late = this.ring(x, y + 0.012, z, 1.3, 0.05 * scale, scale, 0.12 * sun + 0.03, 0.11 * sun + 0.036, 0.09 * sun + 0.042);
    if (late >= 0) this.glow.fadeIn[late] = 0.35;                       // 第二圈晚一拍才显出来
  }

  // ------------------------------------------------------------------ 爆炸

  /**
   * 爆炸。所有层在同一瞬间发射，先后顺序靠各层的寿命和淡入错开：
   *   0–0.08 秒  白闪：一盏很亮的灯 + 白热的芯 + 星芒，只有两三帧
   *   0–0.5 秒   橙色的余辉灯；一圈贴地扩开的冲击环
   *   0–1 秒     火球：十几瓣翻滚的火，芯亮、皮暗，边烧边被自己的烟盖住
   *   0–1.5 秒   四散的火星（落地会弹）；之后三秒还有忽明忽暗的余烬慢慢飘落
   *   0.1–5 秒   浓烟：外圈的快、立刻看得见；内圈的慢，要等火暗下去才显出来。再加一个持续一秒多的余烟
   *   贴地的一圈尘土、十几块炸飞的碎片
   * scale 是规模，1 ≈ 一架无人机坠毁。照亮周围靠的是那两盏真的灯，而不是一张巨大的发光贴图。
   */
  explosion(pos: THREE.Vector3, scale = 1) {
    const P = Math.min(4, Math.max(0.4, scale)), Z = Math.sqrt(P), { x, y, z } = pos;
    const floor = this.groundBelow(x, y, z), grounded = y - floor < 1.4 * P, sun = this.sunlit(x, y + 0.4, z), cy = y + 0.35 * P;
    const lit = this.lit, glow = this.glow;

    this.flash(_v.set(x, y + 0.4, z), 320 * P, 0.08, 0xffe2b0, 10 + 9 * P);
    this.flash(_v, 55 * P, 0.45, 0xff8a30, 8 + 6 * P);
    this.glint(x, cy, z, 0.055, 1.5 * P, 2.3 * P, 16, 13.5, 9.5, ADD_FRAME.GLOW);
    this.glint(x, cy, z, 0.05, 2.6 * P, 4.2 * P, 7, 5, 2.4, Math.random() < 0.5 ? ADD_FRAME.STAR_A : ADD_FRAME.STAR_B);
    this.glint(x, cy, z, 0.3, 3.5 * P, 5.5 * P, 0.35, 0.2, 0.08, ADD_FRAME.GLOW);

    // 火球：受光池里的粒子（盖上去的，不是加上去的），extra ≥ 2 告诉着色器"这是火"
    for (let i = 0, n = Math.round(13 + 5 * P); i < n; i++) {
      const d = scatter(0, 1, 0, 1.6);
      if (grounded && d.y < -0.1) d.y = -d.y * 0.5;                     // 贴着地炸：往下的那些被地面挡回来
      const speed = rand(2.2, 7.5) * Z, k = lit.emit(x + d.x * 0.3 * P, cy + d.y * 0.3 * P, z + d.z * 0.3 * P, d.x * speed, d.y * speed + 1.4, d.z * speed, rand(0.55, 1.05), 0.85 * P, rand(1.8, 2.7) * P);
      if (k < 0) break;
      const heat = rand(0.7, 1.15);
      lit.frame[k] = i % 4 === 0 ? LIT_FRAME.DENSE : Math.floor(Math.random() * LIT_FRAME.PUFF_VARIANTS); lit.ramp[k] = RAMP_FIRE;
      lit.r[k] = 5.8 * heat; lit.g[k] = 2.4 * heat; lit.b[k] = 0.5 * heat; lit.a[k] = 0.96; lit.extra[k] = 2 + sun;
      lit.drag[k] = 4; lit.grav[k] = -2.6; lit.wind[k] = 0.6; lit.turb[k] = 1.5; lit.rot[k] = Math.random() * 6.283; lit.spin[k] = (Math.random() - 0.5) * 2.5;
      lit.grow[k] = 3; lit.fadeIn[k] = 0; lit.fadeOut[k] = 0.6;
    }
    // 少量真正"加上去"的火团：给火球中心添一点通透的亮
    for (let i = 0; i < 5; i++) {
      const d = scatter(0, 1, 0, 1.4), speed = rand(2, 5) * Z, k = glow.emit(x, cy, z, d.x * speed, Math.abs(d.y) * speed + 1.2, d.z * speed, rand(0.3, 0.55), 0.6 * P, rand(1.2, 1.8) * P);
      if (k < 0) break;
      glow.frame[k] = ADD_FRAME.FIRE; glow.ramp[k] = RAMP_FIRE; glow.r[k] = 2.4; glow.g[k] = 1.1; glow.b[k] = 0.3;
      glow.drag[k] = 4; glow.grav[k] = -2.5; glow.grow[k] = 3; glow.fadeOut[k] = 0.4; glow.rot[k] = Math.random() * 6.283;
    }
    // 浓烟：单双数交替成两种
    for (let i = 0, n = Math.round(11 + 5 * P); i < n; i++) {
      const d = scatter(0, 1, 0, 1.4), outer = i % 2 === 0;
      if (grounded && d.y < 0) d.y = -d.y * 0.4;
      const off = (outer ? 0.75 : 0.3) * P, speed = (outer ? rand(4.5, 9) : rand(1.5, 5)) * Z, grey = rand(0.04, 0.1);
      const k = this.smokePuff(x + d.x * off, cy + d.y * off, z + d.z * off, d.x * speed, d.y * speed + 0.8, d.z * speed, rand(2.8, 4.8), (outer ? 0.8 : 1.2) * P, rand(2.6, 4.2) * P,
        grey, grey * 0.95, grey * 0.9, outer ? 0.7 : 0.8, sun, 3.4, rand(0.8, 1.7), 1, i % 3 === 0 ? LIT_FRAME.DENSE : -1);
      if (k >= 0) { lit.fadeIn[k] = outer ? 0.025 : 0.16; lit.fadeOut[k] = 0.35; lit.turb[k] = 1.2; }
    }
    this.startEmitter(x, y, z, 'smolder', 1.3 + 0.3 * P, P, sun);
    // 火星
    const sparkFloor = Math.max(floor, -50);
    for (let i = 0, n = Math.min(90, Math.round(34 * P)); i < n; i++) {
      const d = scatter(0, 1, 0, 1.5);
      if (grounded && d.y < 0) d.y = -d.y;
      const speed = rand(6, 26) * Z, k = this.spark(x, y + 0.05, z, d.x * speed, d.y * speed, d.z * speed, rand(0.5, 1.5), rand(0.014, 0.028), 40, 23, 8, BOUNCE, sparkFloor);
      if (k >= 0) { glow.drag[k] = 1.4; glow.stretch[k] = 0.035; }
    }
    // 余烬：小光点，慢慢往下飘，一闪一闪
    for (let i = 0, n = Math.round(10 * P); i < n; i++) {
      const d = scatter(0, 1, 0, 1.2), speed = rand(1, 5), k = glow.emit(x, y + 0.3, z, d.x * speed, Math.abs(d.y) * speed + 1, d.z * speed, rand(1.4, 3), 0.035, 0.02);
      if (k < 0) break;
      glow.frame[k] = ADD_FRAME.GLOW; glow.ramp[k] = RAMP_EMBER; glow.r[k] = 9; glow.g[k] = 4; glow.b[k] = 1;
      glow.drag[k] = 1.2; glow.grav[k] = 0.6; glow.turb[k] = 3; glow.wind[k] = 1; glow.fadeOut[k] = 0.5;
    }
    if (grounded) {
      this.ring(x, floor + 0.015, z, 0.32, 0.6 * P, 9 * P, 0.5, 0.38, 0.24);   // 冲击环：0.3 秒里从半米扩到九米，淡淡的一圈
      // 贴地的一圈尘土：沿圆周均匀地往外推
      for (let i = 0, n = Math.round(12 + 3 * P); i < n; i++) {
        const a = ((i + Math.random()) / n) * 6.283, cs = Math.cos(a), sn = Math.sin(a), speed = rand(5, 10) * Z, grey = rand(0.42, 0.55);
        const k = this.smokePuff(x + cs * 0.4 * P, floor + 0.215, z + sn * 0.4 * P, cs * speed, rand(0.2, 0.9), sn * speed, rand(1.2, 2.2), 0.4 * P, rand(1.2, 1.9) * P, grey, grey * 0.96, grey * 0.9, 0.26, sun, 3, 0.15, 0.7);
        if (k >= 0) lit.fadeIn[k] = 0.1;
      }
    }
    this.chips(x, Math.max(y, floor + 0.1), z, 0, 1, 0, Math.round(13 + 6 * P), 4, 13 * Z, 0.04, 0.13, 0.025, 0.08, 0.04, 0.13, 0.07, 0.066, 0.062, 1.1, floor);
  }

  /**
   * 敌人被击毁时飞散的零件。scale 是零件的大小规模，count 是几块。
   * 一半是烧着飞出去的，一路掉火星、拖黑烟；四分之一带着橙色的涂装。
   */
  debris(pos: THREE.Vector3, scale: number, count: number) {
    const floor = this.groundBelow(pos.x, pos.y, pos.z), base = 0.13 * scale;
    for (let i = 0; i < count; i++) {
      const d = scatter(0, 1, 0, 1), speed = rand(2, 6.5) * (0.5 + scale), paint = Math.random() < 0.25;
      this.debrisPool.add(pos.x, Math.max(pos.y, floor + 0.05), pos.z, d.x * speed, d.y * speed + 0.8, d.z * speed, base * rand(0.4, 1.2), base * rand(0.3, 0.9), base * rand(0.4, 1.2),
        paint ? 0.6 : 0.07, paint ? 0.2 : 0.066, paint ? 0.05 : 0.062, rand(3.5, 6), floor, Math.random() < 0.55 ? rand(0.5, 1.2) : 0);
    }
  }
  /** 烧着的碎片每帧调一次：按概率掉一颗火星、冒一小团烟（概率乘了帧时间，所以和帧率无关）。 */
  private hotTrail = (x: number, y: number, z: number) => {
    if (Math.random() < this.dt * 30) this.spark(x, y, z, rand(-0.4, 0.4), rand(0.3, 0.9), rand(-0.4, 0.4), rand(0.25, 0.5), 0.016, 30, 14, 4, 0, 0);
    if (Math.random() < this.dt * 14) this.smokePuff(x, y, z, 0, 0.4, 0, rand(0.6, 1.1), 0.06, rand(0.25, 0.4), 0.04, 0.04, 0.04, 0.4, 1, 1.5, 0.4, 0.8);
  };

  /** 抛出一枚弹壳。 */
  shell(pos: THREE.Vector3, vx: number, vy: number, vz: number) { this.shells.add(pos.x, pos.y, pos.z, vx, vy, vz); }

  // ------------------------------------------------------------------ 枪口焰和曳光

  /**
   * 世界里的枪口焰（敌人开火用；玩家自己那支枪的枪口焰是枪模上的专用网格，见 muzzleflash.ts）。
   * 两片星芒 + 白热的芯 + 一圈光晕 + 一道向前的喷焰 + 三颗火星 + 一小团烟，整个只活四五十毫秒。
   * (dx, dy, dz) 是枪口朝向（单位向量）；scale 是大小，机器狗 0.9，无人机 0.55。
   */
  muzzleFlash(pos: THREE.Vector3, dx: number, dy: number, dz: number, scale = 1, light = true, r = 1, g = 0.68, b = 0.32) {
    const { x, y, z } = pos, V = scale, glow = this.glow;
    this.glint(x + dx * 0.1 * V, y + dy * 0.1 * V, z + dz * 0.1 * V, 0.045, 0.75 * V, 1.15 * V, 34 * r, 34 * g, 34 * b, ADD_FRAME.STAR_A);
    this.glint(x + dx * 0.14 * V, y + dy * 0.14 * V, z + dz * 0.14 * V, 0.035, 0.5 * V, 0.85 * V, 22 * r, 22 * g, 22 * b, ADD_FRAME.STAR_B);
    this.glint(x + dx * 0.05 * V, y + dy * 0.05 * V, z + dz * 0.05 * V, 0.045, 0.13 * V, 0.2 * V, 22, 22 * (g + 0.25), 22 * (b + 0.3), ADD_FRAME.GLOW);
    this.glint(x, y, z, 0.05, 0.8 * V, 1.1 * V, 0.4 * r, 0.4 * g, 0.4 * b, ADD_FRAME.GLOW);
    // 喷焰：一张沿枪管方向拉长的方片。贴图亮的一头在"速度方向"上，所以速度给成朝后，亮头就贴着枪口、尖尾朝前
    const jet = glow.emit(x + dx * 0.4 * V, y + dy * 0.4 * V, z + dz * 0.4 * V, -dx, -dy, -dz, 0.04, 0.11 * V, 0.14 * V);
    if (jet >= 0) { glow.mode[jet] = MODE_STRETCH; glow.frame[jet] = ADD_FRAME.JET; glow.stretch[jet] = 0.9 * V; glow.r[jet] = 18 * r; glow.g[jet] = 18 * g; glow.b[jet] = 18 * b; glow.fadeOut[jet] = 0.3; }
    for (let i = 0; i < 3; i++) { const d = scatter(dx, dy, dz, 0.25), speed = rand(8, 22); this.spark(x, y, z, d.x * speed, d.y * speed, d.z * speed, rand(0.08, 0.22), 0.012, 30, 18, 7, 0, 0); }
    this.smokePuff(x + dx * 0.2, y + dy * 0.2, z + dz * 0.2, dx * 1.5, dy * 1.5 + 0.2, dz * 1.5, rand(0.5, 0.9), 0.08 * V, 0.45 * V, 0.5, 0.5, 0.52, 0.16, this.sunlit(x, y, z), 3, 0.3, 0.8);
    if (light) this.flash(_v.set(x + dx * 0.25, y + dy * 0.25, z + dz * 0.25), 16 * V, 0.05, 0xffb060, 7 * V);
  }

  /**
   * 发射一发曳光。第三个参数可以是一组选项；为了兼容老代码也接受 true / false（false = 偏红的敌方曳光）。
   * 连发时每隔 0.07 秒，沿弹道的头七米留五小团淡烟（枪口喷出来的火药烟被子弹带出去的样子）。
   */
  tracer(from: THREE.Vector3, to: THREE.Vector3, opts: TracerOpts | boolean = true) {
    const o: TracerOpts = typeof opts === 'boolean' ? (opts ? {} : { color: 0xff4a22 }) : opts;
    if (o.color === undefined) _col.setRGB(1, 0.8, 0.46); else _col.setHex(o.color);
    const k = o.intensity ?? 16;
    this.tracers.add(from, to, _col.r * k, _col.g * k, _col.b * k, o.speed ?? 260, o.width ?? 0.024);
    if (o.trail === false || this.time - this.lastTracerSmoke <= 0.07) return;
    const len = _dir.subVectors(to, from).length();
    if (len <= 2) return;
    this.lastTracerSmoke = this.time;
    _dir.multiplyScalar(1 / len);
    const reach = Math.min(len, 7), shade = this.sunlit(from.x, from.y, from.z);
    for (let i = 0; i < 5; i++) {
      const at = 0.6 + ((i + Math.random()) / 5) * (reach - 0.6);
      const p = this.smokePuff(from.x + _dir.x * at, from.y + _dir.y * at, from.z + _dir.z * at, _dir.x * 0.6, 0.05, _dir.z * 0.6, rand(0.45, 0.8), 0.04, rand(0.12, 0.2), 0.6, 0.6, 0.62, 0.1, shade, 2, 0.1, 0.7);
      if (p >= 0) this.lit.fadeIn[p] = 0.25;
    }
  }

  /**
   * 细曳光：敌人打过来的子弹用它。width 沿用老接口的含义（默认 0.05）。
   * 以前要单独开这个口子，是因为老的曳光有 20 厘米粗，冲着镜头飞过来会变成一根光柱。
   * 现在的曳光在屏幕上有宽度上限（芯 5 个像素、光晕 28 个像素），贴着镜头飞也不会糊成一片；这里只是换成敌方的颜色、稍微粗一点。
   */
  tracerThin(from: THREE.Vector3, to: THREE.Vector3, width = 0.05) {
    this.tracer(from, to, { color: 0xffc070, width: width * 0.7, trail: false });
  }

  /** 敌方能量弹飞行时掉下来的一粒余光，连起来就是它的尾迹。 */
  trail(pos: THREE.Vector3) {
    const P = this.glow, k = P.emit(pos.x, pos.y, pos.z, rand(-0.15, 0.15), rand(-0.15, 0.15), rand(-0.15, 0.15), rand(0.16, 0.26), 0.16, 0.05);
    if (k >= 0) { P.frame[k] = ADD_FRAME.GLOW; P.r[k] = 5; P.g[k] = 1.1; P.b[k] = 0.4; P.fadeOut[k] = 0; }
  }

  // ------------------------------------------------------------------ 持续发射器

  /**
   * 在 pos 放一个持续冒东西的点。kind：steam 蒸汽 / smolder 余烟（越冒越少）/ embers 飘飞的余烬 / fire 一堆火（带一盏闪烁的灯）。
   * ttl 是持续多少秒，不给就一直冒到调用返回值的 stop()。最多同时 24 个。
   */
  addEmitter(pos: THREE.Vector3, kind: EmitterKind = 'steam', opts: { ttl?: number; scale?: number } = {}) {
    const e = this.startEmitter(pos.x, pos.y, pos.z, kind, opts.ttl ?? Infinity, opts.scale ?? 1, this.sunlit(pos.x, pos.y + 0.3, pos.z));
    return { stop: () => { if (e) this.stopEmitter(e); }, setPos: (p: THREE.Vector3) => { if (e) { e.x = p.x; e.y = p.y; e.z = p.z; } } };
  }
  private startEmitter(x: number, y: number, z: number, kind: EmitterKind, ttl: number, scale: number, shade: number) {
    const e = this.emitters.find((k) => !k.live);
    if (!e) return null;
    e.live = true; e.kind = kind; e.x = x; e.y = y; e.z = z; e.age = 0; e.ttl = ttl; e.scale = scale; e.shade = shade; e.acc = e.acc2 = 0; e.lamp = null;
    if (kind === 'fire') {
      // 火要一盏常亮的灯：从闪光灯里长期借一盏，stop 的时候还回去
      const lamp = this.lamps.find((l) => !l.held && l.left <= 0);
      if (lamp) { lamp.held = true; lamp.light.color.setHex(0xff8a3a); lamp.light.distance = 9; e.lamp = lamp; }
    }
    return e;
  }
  private stopEmitter(e: Emitter) {
    e.live = false;
    if (e.lamp) { e.lamp.held = false; e.lamp.left = 0; e.lamp.light.intensity = 0; e.lamp = null; }
  }
  private updateEmitters(dt: number) {
    const lit = this.lit, glow = this.glow;
    for (const e of this.emitters) {
      if (!e.live) continue;
      e.age += dt;
      if (e.age >= e.ttl) { this.stopEmitter(e); continue; }
      const { x, y, z, scale: S } = e;
      // acc 是"攒了几个该发射的粒子"：每帧加上 速率 × 帧时间，攒够 1 就发一个。这样每秒发射的数量和帧率无关
      if (e.kind === 'steam') {
        for (e.acc += dt * 13; e.acc >= 1; e.acc--) {
          const k = this.smokePuff(x + rand(-0.04, 0.04), y, z + rand(-0.04, 0.04), rand(-0.2, 0.2), rand(1.4, 2.4), rand(-0.2, 0.2), rand(1.8, 3), 0.12 * S, rand(0.8, 1.3) * S, 0.8, 0.82, 0.85, 0.2, e.shade, 1.3, 0.5, 1);
          if (k >= 0) { lit.fadeIn[k] = 0.12; lit.turb[k] = 0.9; }
        }
      } else if (e.kind === 'smolder') {
        for (e.acc += dt * 9 * (1 - e.age / e.ttl); e.acc >= 1; e.acc--) {
          const grey = rand(0.05, 0.11);
          const k = this.smokePuff(x + rand(-0.25, 0.25) * S, y, z + rand(-0.25, 0.25) * S, rand(-0.3, 0.3), rand(1.2, 2.4), rand(-0.3, 0.3), rand(2.4, 3.8), 0.5 * S, rand(1.6, 2.6) * S, grey, grey, grey, 0.6, e.shade, 1, 0.9, 1);
          if (k >= 0) { lit.fadeIn[k] = 0.12; lit.turb[k] = 1; }
        }
      } else if (e.kind === 'embers') {
        for (e.acc += dt * 8; e.acc >= 1; e.acc--) this.ember(x + rand(-0.2, 0.2) * S, y, z + rand(-0.2, 0.2) * S, rand(-0.3, 0.3), rand(0.6, 1.8), rand(-0.3, 0.3), rand(1.5, 3.2), rand(0.02, 0.04), -0.5, 3.5);
      } else {
        for (e.acc += dt * 24; e.acc >= 1; e.acc--) {
          // 火舌：越烧越小（一般的烟是越飘越大）
          const k = glow.emit(x + rand(-0.15, 0.15) * S, y + 0.1 * S, z + rand(-0.15, 0.15) * S, rand(-0.25, 0.25), rand(1.2, 2.6) * S, rand(-0.25, 0.25), rand(0.35, 0.65), 0.45 * S, rand(0.2, 0.35) * S);
          if (k < 0) break;
          glow.frame[k] = ADD_FRAME.FIRE; glow.ramp[k] = RAMP_FIRE; glow.r[k] = 9; glow.g[k] = 5.5; glow.b[k] = 2.2;
          glow.drag[k] = 1; glow.rot[k] = Math.random() * 6.283; glow.spin[k] = (Math.random() - 0.5) * 4; glow.fadeIn[k] = 0.12; glow.fadeOut[k] = 0.4; glow.wind[k] = 1; glow.turb[k] = 2;
        }
        for (e.acc2 += dt * 4; e.acc2 >= 1; e.acc2--) {
          const grey = rand(0.05, 0.1);
          const k = this.smokePuff(x, y + 0.8 * S, z, rand(-0.2, 0.2), rand(1.2, 2), rand(-0.2, 0.2), rand(2.2, 3.4), 0.3 * S, rand(1.1, 1.8) * S, grey, grey, grey, 0.5, e.shade, 0.9, 0.8, 1);
          if (k >= 0) { lit.fadeIn[k] = 0.2; lit.turb[k] = 1; }
          this.ember(x + rand(-0.15, 0.15), y + 0.3, z + rand(-0.15, 0.15), rand(-0.5, 0.5), rand(1.5, 3), rand(-0.5, 0.5), rand(1, 2.2), 0.03, -0.6, 4);
        }
        if (e.lamp) {
          // 火光的闪烁：两个频率不成倍数的正弦叠在一起，看起来不规则
          e.lamp.light.position.set(x, y + 0.5, z);
          e.lamp.light.intensity = (14 + 6 * Math.sin(this.time * 23) + 4 * Math.sin(this.time * 37.7)) * S;
        }
      }
    }
  }
  /** 一粒余烬：一个忽明忽暗的小光点，被热气托着乱飘。 */
  private ember(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grav: number, turb: number) {
    const P = this.glow, k = P.emit(x, y, z, vx, vy, vz, life, size, 0.012);
    if (k < 0) return;
    P.frame[k] = ADD_FRAME.GLOW; P.ramp[k] = RAMP_EMBER; P.r[k] = 10; P.g[k] = 4.2; P.b[k] = 1; P.drag[k] = 0.8; P.grav[k] = grav; P.turb[k] = turb; P.wind[k] = 1; P.fadeOut[k] = 0.5;
  }

  // ------------------------------------------------------------------ 每帧

  /** 每帧调用。eye 是主镜头的位置：受光粒子要按离它的远近排序。不给就沿用上一次的。 */
  update(dt: number, eye?: THREE.Vector3) {
    this.time += dt; this.dt = dt;
    if (eye) this.view.eye.copy(eye);
    this.updateEmitters(dt);
    eye = this.view.eye;
    this.lit.update(dt, this.time, this.wind);
    this.litDraw.begin(); this.lit.write(this.litDraw, this.time, eye); this.litDraw.end();
    this.glow.update(dt, this.time, this.wind);
    this.glowDraw.begin(); this.glow.write(this.glowDraw, this.time, eye); this.tracers.update(dt, this.glowDraw); this.glowDraw.end();
    this.debrisPool.update(dt, this.hotTrail);
    this.shells.update(dt);
    for (const l of this.lamps) {
      if (l.held || l.left <= 0) continue;
      l.left -= dt;
      l.light.intensity = l.left > 0 ? l.peak * (l.left / l.total) : 0;   // 线性熄灭
    }
  }
}
