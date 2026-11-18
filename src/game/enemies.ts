import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { GameAudio } from '../audio/audio';
import type { Effects } from '../render/effects';
import type { Colliders, RayHit } from '../world/colliders';
import type { NavGrid } from '../world/nav';
import type { Decals } from '../render/decals';
import { BOUNDS, QUAY_X } from '../world/port';
import type { Player } from './player';
import { plating } from './plating';
import { instantiate, rigDef } from './rig';

// 敌人的 AI、动作和死亡。
//
// 这个文件比较长，按下面的顺序读：
//   1. 参数表      —— 所有"多快、多准、多疼"的数字都集中在这里，想调难度先看这里
//   2. Enemies 类  —— 对外的接口：生成、命中检测、受伤、每帧更新
//   3. 感知        —— 敌人不是全知的：要亲眼看见玩家一小会儿才会开打，看不见了会去最后见到的地方找
//   4. 攻击令牌    —— 全场同一时间只允许很少的敌人开火，而且两次开火之间必须隔一段时间
//   5. 无人机      —— 飞行、避障、预警 + 三连发
//   6. 地面单位    —— 机器狗和守卫共用：找路、选射击位、预警 + 连发；机器狗还会扑人
//   7. 死亡动画    —— 敌人被击毁后不是立刻消失，而是进入"垂死"阶段：无人机打着转坠落，机器狗和守卫瘫倒冒烟、留下残骸
//   8. 弹丸与爆炸
//   9. 姿势函数    —— 每帧把上面算出来的状态变成一根根骨骼的角度
//
// 难度的总体思路（照参考）：单个敌人的伤害很低、而且开火前一定有半秒左右的预警（镜头变亮 + 充能声）；
// 敌人盯着玩家越久打得越准，玩家只要在移动、或者隔几秒回一次掩体，就很难被打中。

export type Kind = 'gull' | 'hound' | 'guard';
export const KIND_NAME: Record<Kind, string> = { gull: '机械飞鸥', hound: '机械猎犬', guard: '机械守卫' };
/** 警戒状态：巡逻（还不知道玩家在哪）→ 调查（听到动静，过去看看）→ 交战（看见了）→ 搜索（跟丢了，在最后见到的地方找）→ 巡逻 */
export type Mode = 'patrol' | 'investigate' | 'engage' | 'search';

// ---------------------------------------------------------------------------
// 1. 参数表

/**
 * 我们的玩家比参考跑得快（走 5.2 / 冲刺 8.4 米每秒，参考是 3.8 / 6.4），因为我们的港区比参考大得多。
 * 凡是"和玩家比快慢"的数字（机器狗的速度、"玩家移动越快越难打中"的系数）都按这个比例换算，
 * 这样"狗比你走路快一点、比你冲刺慢"的关系和参考保持一致。
 */
const SPEED_SCALE = 5.2 / 3.8;

/** 感知：所有敌人共用。 */
const SENSE = {
  sightRange: 45,                                 // 最远能看多远（米）
  coneCos: Math.cos((100 * Math.PI) / 180),       // 视野 200°：玩家在正前方左右各 100° 以内才看得见
  nearSense: 3.5,                                 // 这么近的话，背对着也能察觉
  loseSight: 4,                                   // 交战中连续这么多秒看不见玩家就算跟丢
  searchTime: 8,                                  // 跟丢后搜索 8~11 秒，然后回去巡逻
  hearRadius: 45,                                 // 枪声传多远
  exposureUp: 0.1,                                // "盯住"的程度每秒涨多少：从 0 涨到 1 要连续看见 10 秒
  exposureDown: 0.45,                             // 看不见时每秒掉多少：躲 2.2 秒就清零
};

/** 攻击令牌：同时最多几个敌人在开火，以及两次开火的开始时间至少隔多久。 */
const TOKEN = { max: 2, maxCrowd: 3, crowd: 5, gap: 1.25 };

/** 无人机。 */
const GULL = {
  hp: 45,
  boltDamage: 7, boltSpeed: 70,                   // 弹丸每发 7 点，每秒飞 70 米
  burst: 3, burstGap: 0.12,                       // 一轮三连发，每发间隔 0.12 秒
  telegraph: 0.55,                                // 开火前预警多久
  cooldown: [1.9, 3.3] as const,                  // 两轮之间歇多久（在这个范围里随机）
  rangeMin: 12, rangeMax: 25,                     // 绕着玩家飞的半径范围
  altMin: 4, altMax: 8,                           // 比玩家脚底高多少
  maxSpeed: 8, searchSpeed: 5.5, patrolSpeed: 3, accel: 11,
  spreadFar: 0.065, spreadNear: 0.018,            // 散布（弧度）：刚看见时很散，盯满 10 秒后收紧
  fireRange: 42,
  explodeRadius: 3, explodeDamage: 30,            // 坠地爆炸：3 米内有伤害，贴脸 30（对玩家减半）
  react: 0.4,                                     // 巡逻时要连续看见玩家这么久才反应过来
  // 以下几项是配合我们的模型和场地加的（参考的无人机只有我们的六成大，箱垛也矮得多）
  feel: 2.8,                                      // 前向"触须"的基础长度
  marginXZ: 0.95, marginY: 0.45,                  // 机身离墙、离顶至少留多远
  clearance: 2.6,                                 // 飞过箱垛上方时离箱顶多高
  climbMax: 9,                                    // 被墙挡住时最多临时拔高多少
  smoke: 1.4,                                     // 烟团大小的倍率
  // 进了屋（车间）之后的飞法：屋顶下面挂着一排吊灯（灯盘离地 6 米），所以最高飞到 5.2 米；
  // 目标点离墙至少 1.6 米；穿门洞时压到 2.6 米（门洞净高 4.5 米）
  indoorAltMin: 3.2, indoorAltMax: 5.2, indoorWall: 1.6, indoorClearance: 1.2, doorAlt: 2.6,
};
/** 云台相机（"眼睛"）和炮口在机身坐标里的位置：[上下, 前后]。 */
const GULL_CAM = { y: -0.25, z: 0.44 }, GULL_MUZZLE = { y: -0.195, z: 0.28 };

interface WalkerSpec {
  hp: number;
  shotDamage: number; burst: number; burstGap: number; telegraph: number; cooldown: readonly [number, number];
  runSpeed: number; stalkSpeed: number; patrolSpeed: number; accel: number; decel: number; turnRate: number;
  rangeMin: number; rangeMax: number;             // 选射击位时离玩家的距离范围
  spreadFar: number; spreadNear: number;
  lungeRange: number; lungeHit: number; lungeDamage: number; lungeCooldown: number; lungeSpeed: number;
  react: number;
  body: number;                                   // 身体半径：同类之间靠得比两者半径之和还近就互相推开
  keepOff: number;                                // 离玩家至少多远（免得把头伸进镜头里）
  probe: number;                                  // 前方探测射线的基础长度（从身体中心算，要比头伸出去的距离长）
  eyeY: number; eyeZ: number;                     // "眼睛"的位置：视线检测从这里出发
  smokeBelow: number;                             // 血量低于这个比例开始冒烟
}
/**
 * 机器狗：保持 8~18 米的距离开火的远程敌人，只有玩家贴到跟前才扑。
 * 速度那几项是参考值乘了 SPEED_SCALE（参考：跑 4.5、潜行 2、巡逻 1.5、扑击 9.5，加速 7、减速 9.8）。
 */
const HOUND: WalkerSpec = {
  hp: 140,
  shotDamage: 5, burst: 4, burstGap: 0.11, telegraph: 0.5, cooldown: [1.8, 3],
  runSpeed: 6.1, stalkSpeed: 2.7, patrolSpeed: 2.0, accel: 9.6, decel: 13.4, turnRate: 2.5,
  rangeMin: 8, rangeMax: 18,
  spreadFar: 0.12, spreadNear: 0.045,
  // 扑击：参考是 3 米内触发、1.35 米内算咬中。我们的狗身子长，头比身体中心靠前 1.2 米，所以两个距离都往外放了 0.6 米
  lungeRange: 3.6, lungeHit: 1.9, lungeDamage: 15, lungeCooldown: 3.5, lungeSpeed: 13,
  react: 0.55, body: 0.85, keepOff: 1.7, probe: 1.35, eyeY: 0.95, eyeZ: 0.5, smokeBelow: 0.4,
};
/**
 * 守卫（参考里没有的第三种敌人）：走得慢、血厚，站在 12~24 米外用右臂的炮打三连发。
 * 它和机器狗共用同一套"找路 → 选位 → 预警 → 连发"的流程，只是不会扑人、打出来的是会飞的弹丸。
 */
const GUARD: WalkerSpec = {
  hp: 240,
  shotDamage: 8, burst: 3, burstGap: 0.16, telegraph: 0.55, cooldown: [2.8, 4],
  runSpeed: 2.7, stalkSpeed: 1.8, patrolSpeed: 1.3, accel: 5, decel: 8, turnRate: 2,
  rangeMin: 12, rangeMax: 24,
  spreadFar: 0.06, spreadNear: 0.02,
  lungeRange: 0, lungeHit: 0, lungeDamage: 0, lungeCooldown: 0, lungeSpeed: 0,
  react: 0.55, body: 1.1, keepOff: 1.8, probe: 1.1, eyeY: 2.5, eyeZ: 0.2, smokeBelow: 0.4,
};

/** 机器狗身体姿态用到的几个数。 */
const HOUND_POSE = {
  // 我们这副骨架的腿站直时几乎是伸满的，脚钉在地上不动的话身体往前走不了几厘米腿就不够长了。
  // 所以走得越快身体压得越低，给腿留出前后迈步的余量：下沉量 = dropBase + 速度 × dropPerSpeed，不超过 dropMax
  dropBase: 0.03, dropPerSpeed: 0.02, dropMax: 0.15,
  collapse: -0.47,     // 瘫倒时身体中心比站立时低多少：正好是肚皮贴地
  muzzleY: 1.085, muzzleZ: 0.47,   // 背上那门炮的炮口
  headY: 0.95, headZ: 0.98,        // 头（弱点）的中心
  headDroop: 0.4,                  // 瘫倒后头垂下多少（弧度）：我们的狗头长，再多嘴就戳进地里了
};

/**
 * 镜头（所有"眼睛"材质的零件）的颜色：平时是琥珀色，交战时变红。
 * 数值远大于 1：屏幕能显示的最亮就是 1，多出来的部分由后处理的泛光晕成一圈光。预警时还要再乘四倍多（见 updateLens），
 * 十几米外也是一个扎眼的红点 —— 游戏里没有任何"敌人要开火了"的图标，玩家只靠这个光点和充能声来判断。
 * 这两组数就是参考的原值。（暂停前用的是它的三成，那是按旧的后处理调的；换成新的曝光和泛光之后，三成的亮度在十米外几乎看不出变化。）
 */
const LENS_CALM: [number, number, number] = [8, 4, 0.7], LENS_HOT: [number, number, number] = [14, 1, 0.35];

// ---------------------------------------------------------------------------
// 类型

interface Spring { x: number; v: number }

/** 三种敌人共有的状态。 */
interface Base {
  group: THREE.Group; pos: THREE.Vector3;          // pos 就是 group.position：地面单位是脚下的点，无人机是机身中心
  mesh: THREE.SkinnedMesh; bones: Record<string, THREE.Bone>;
  bodyMat: THREE.MeshStandardMaterial;             // 每个敌人自己的一份外壳材质：中弹时单独闪一下
  eyeMat: THREE.MeshBasicMaterial;                 // 每个敌人自己的一份镜头材质：单独变色、变亮、熄灭
  glow: THREE.MeshBasicMaterial | null;            // 守卫炮口的充能光
  hp: number; alive: boolean; yaw: number; flash: number; phase: number;
  // ---- 感知
  mode: Mode; modeT: number;                       // modeT：调查 / 搜索还剩多少秒
  los: boolean;                                    // 此刻能不能看见玩家（line of sight）
  seeT: number; noSeeT: number;                    // 连续看见了多久 / 连续多久没看见
  senseT: number;                                  // 距离下一次视线检测还有多久（不用每帧都测）
  exposure: number;                                // 0..1，盯住玩家的程度，越高打得越准
  lastKnown: THREE.Vector3;                        // 玩家最后一次被看见（或被听见）的位置
  home: THREE.Vector3;                             // 巡逻的中心
  sensor: THREE.Vector3;                           // "眼睛"的世界坐标
  // ---- 攻击
  hasToken: boolean; cool: number;                 // cool：还要歇多久才能再开火
  flare: number;                                   // 0..1，预警时镜头的额外亮度
  lens: [number, number, number];
  // ---- 垂死
  smokeT: number; dieT: number;                    // dieT：死了多久
  wreck: boolean;                                  // 已经烧完，成了静止的残骸
  sink: number;                                    // >0 表示残骸正在沉入地面（场上残骸太多时回收最老的）
}

export interface Gull extends Base {
  kind: 'gull';
  vel: THREE.Vector3; pitch: number; roll: number;
  orbitDir: number; orbitR: number; orbitA: number;   // 绕飞的方向（±1）、半径、当前角度
  alt: number; patrolR: number; flipT: number;
  atk: 'idle' | 'tele' | 'burst'; atkT: number; shots: number; lead: number;
  thrust: number;                                  // 油门：决定旋翼转多快
  lostRotor: number;                               // 被击毁时掉的是第几只旋翼（-1 = 还没掉）
  feeler: number; avoid: THREE.Vector3;            // 三根"触须"轮流探测；avoid 是避障产生的额外加速度
  ceil: number; ceilT: number;                     // 头顶有东西时的最高可飞高度
  top: number; topT: number; climb: number;        // 目标点下方的箱顶高度；被墙挡住时临时拔高多少
  sweep: number; gimbalYaw: number; gimbalPitch: number;
  spin: number;                                    // 坠落时的自旋角速度
  indoor: boolean;                                 // 现在是不是在屋顶底下（车间里）
  door: number;                                    // 正要穿过哪个门洞（-1 = 没有）
}

type EngageState = 'move' | 'aim' | 'cool' | 'tele' | 'burst' | 'wind' | 'lunge' | 'recover';
/** 地面单位共有的状态。 */
interface Walker extends Base {
  spec: WalkerSpec;
  es: EngageState; esT: number; moveT: number;     // 交战时的子状态、它的计时器、已经跑了多久
  lungeCd: number; waitT: number; shots: number; bursts: number; lead: number;
  speed: number; prevSpeed: number; maxSpeed: number; wantYaw: number; yawRate: number;
  pushX: number; pushZ: number;                    // 被同伴和玩家"挤开"的速度
  goalX: number; goalZ: number; hasGoal: boolean;
  path: number[] | null; pathI: number; planT: number; stuckT: number;
  doneX: number; doneZ: number;                    // 已经去看过（或确认走不到）的那个可疑位置
  fireX: number; fireZ: number; hasFire: boolean;  // 选好的射击位
  firePX: number; firePZ: number;                  // 选位那一刻玩家在哪：玩家走远了要重选
  scan: number; blocked: boolean; probeT: number;
  crouch: number;                                  // 预警、扑击前身体下蹲多少（米）
}

/** 一条腿做反向运动学（IK）要用到的东西，生成时算好。 */
interface Leg {
  hip: THREE.Bone; knee: THREE.Bone; ankle: THREE.Bone;
  thighLen: number; shinLen: number;
  thighRest: number; shinRest: number;             // 绑定姿势下大腿、小腿在侧视图里的倾角
  footY: number; footZ: number;                    // 踝关节到脚底的向量（侧视图）
  bend: number;                                    // 膝盖朝哪边弯：+1 朝后，-1 朝前
  homeX: number; homeZ: number;                    // 站立时脚底相对身体中心的位置
  side: number; fore: number;                      // 左右（±1）、前后（±1）
}
/** 一只脚：位置是世界坐标。不迈步的时候它一动不动，所以不会"滑步"。 */
interface Foot { x: number; y: number; z: number; fromX: number; fromZ: number; toX: number; toZ: number; slideX: number; slideZ: number }

export interface Hound extends Walker {
  kind: 'hound';
  legs: Leg[]; feet: Foot[];
  swing: number; swingT: number; swingDur: number; lift: number; lastPair: number; idleT: number;
  // 身体的四个弹簧：上下、俯仰、侧倾、横移。中弹、开火、落脚都只是"踢"它们一脚，剩下的晃动由弹簧自己完成
  sY: Spring; sP: Spring; sR: Spring; sL: Spring;
  sA: Spring; sA2: Spring;                         // 天线
  headYaw: number; headPitch: number; jaw: number;
  vy: number; dieRoll: number; diePitch: number;   // 瘫倒：下落速度、最终歪向哪边、最终的俯仰
}

export interface Guard extends Walker {
  kind: 'guard';
  move: number; anim: number;                      // 步态的权重和相位
  aimYaw: number; aimPitch: number; guardK: number; recoil: number;
  hitK: number; hitSide: number;
  anchor: number; anchorZ: number;                 // 倒地时"钉"在原地的是哪组关节（0 脚尖、1 膝盖），以及它的前后位置
  fallSide: number; knelt: boolean; fell: boolean;
}

export type Enemy = Gull | Hound | Guard;
export interface HitResult { enemy: Enemy; t: number; weak: boolean }
export interface World { colliders: Colliders; nav: NavGrid; effects: Effects; decals: Decals; audio: GameAudio; camera: THREE.Camera }
/** 一个能让无人机飞进飞出的门洞。 */
export interface Door {
  x: number; z: number;                            // 门洞中心（在墙面上）
  nx: number; nz: number;                          // 朝屋外的方向（单位向量）
  half: number;                                    // 门洞宽度的一半
  top: number;                                     // 门楣的高度
}
/**
 * 关卡交给敌人模块的"场地信息"：哪里是屋里、门在哪、哪些位置适合出怪和站位。
 * 敌人模块自己不认识地图，这些都由任务那边（mission.ts）在开局前告诉它。
 */
export interface Site {
  interior: THREE.Box3 | null;                     // 室内范围（没有就是全露天）
  doors: Door[];
  spawnGround: [number, number][];                 // 手摆的地面出生点 (x, z)
  spawnAir: [number, number, number][];            // 手摆的空中出生点 (x, y, z)
  cover: [number, number][];                       // 掩体点：紧挨着某件道具的位置，机器狗选射击位时优先考虑
}
export interface SpawnOpts {
  y?: number; yaw?: number;
  /** 给了就以"调查"状态出生，直奔这个位置；不给就是原地巡逻 */
  alert?: THREE.Vector3 | null;
}

// ---------------------------------------------------------------------------
// 材质

// 机体材质：三种都用同一套装甲板贴图（板缝、铆钉、掉漆），只是底色和金属感不同
const PLATE = plating();
const BODY = new THREE.MeshStandardMaterial({ color: 0xc9cbc8, map: PLATE.map, roughness: 1, metalness: 0.5, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap, normalScale: new THREE.Vector2(1.1, 1.1) });
const ACCENT = new THREE.MeshStandardMaterial({ color: 0xa8501c, map: PLATE.map, roughness: 1.1, metalness: 0.75, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap });
const DARK = new THREE.MeshStandardMaterial({ color: 0x24282c, map: PLATE.map, roughness: 0.9, metalness: 0.9, roughnessMap: PLATE.roughnessMap, metalnessMap: PLATE.roughnessMap, normalMap: PLATE.normalMap, normalScale: new THREE.Vector2(0.7, 0.7) });
const BLUR = new THREE.MeshBasicMaterial({ color: 0x0b0d0f, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }); // 旋翼转起来的残影
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.22, metalness: 1 }); // 液压杆的活塞杆：磨得发亮的镀铬钢
// 敌方弹丸：一根很亮的橙红色细条。颜色是 0xff6a2a 再乘 14（参考的原值）—— 远大于 1 的部分会被泛光晕成一道光
const BOLT = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a2a).multiplyScalar(14) });

const MAX_BOLTS = 32, MAX_WRECKS = 5;
/**
 * 音量低于这个数就干脆不播。不只是省事：spatial() 给八十多米外的声源算出来的音量正好是 0，
 * 而合成音效用的"指数渐变"不接受 0（浏览器会直接抛异常）。异常从 update() 里冒出去，这一帧后面的事就都不做了 ——
 * 比如远处一架无人机坠地爆炸：声音一抛异常，它就来不及被移除，于是下一帧接着炸、接着抛，画面看着像卡死。
 * 后加的音效方法自己会拦，老的几个（enemyShot / explode / bark）不拦，所以在调用的地方拦。
 */
const MIN_VOL = 0.02;
interface Bolt { live: boolean; x: number; y: number; z: number; dx: number; dy: number; dz: number; fromX: number; fromY: number; fromZ: number; speed: number; dmg: number; life: number; len: number; whizzed: boolean }

// ---------------------------------------------------------------------------
// 2. Enemies 类

export class Enemies {
  readonly group = new THREE.Group();
  /** 场上所有敌人，包括正在垂死的和已经成了残骸的（它们的 alive 是 false）。 */
  list: Enemy[] = [];
  /** 敌人被击毁的那一刻调用一次（这时它才刚开始坠落 / 瘫倒）。 */
  onKill: (e: Enemy, weak: boolean) => void = () => {};
  onPlayerHit: (dmg: number, from: THREE.Vector3) => void = () => {};
  /** 有敌人警觉了。noise=true 是听到动静过来看看；false 是亲眼看见玩家、进入交战。 */
  onAlert: (e: Enemy, noise: boolean) => void = () => {};

  private bolts: Bolt[] = [];
  private boltMesh: THREE.InstancedMesh;
  private wrecks: Enemy[] = [];
  private clock = 0;                                   // 敌人模块自己的时钟（秒），令牌和出生点冷却用它
  private tokens = 0; private tokenT = -99; private lastTokenAir = false;
  private wantAirT = -99; private wantGroundT = -99;   // 空中 / 地面单位最近一次"想开火但没拿到令牌"的时刻
  private playerSpeed = 0;                             // 玩家水平速度的平滑值
  private player: Player | null = null;
  private lastRayDir = new THREE.Vector3(); private lastHitPoint = new THREE.Vector3(); private hasLastRay = false;
  private recentSpawns: { x: number; z: number; t: number }[] = [];
  private site: Site = { interior: null, doors: [], spawnGround: [], spawnAir: [], cover: [] };

  constructor(private world: World) {
    // 弹丸：一个头粗尾细的小圆台，沿 +z 方向躺着、头在原点。32 发共用一个实例化网格，一次绘制调用画完
    const geo = new THREE.CylinderGeometry(0.04, 0.02, 1, 6);
    geo.rotateX(Math.PI / 2); geo.translate(0, 0, -0.5);
    this.boltMesh = new THREE.InstancedMesh(geo, BOLT, MAX_BOLTS);
    this.boltMesh.frustumCulled = false;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_BOLTS; i++) {
      this.boltMesh.setMatrixAt(i, _m);
      this.bolts.push({ live: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, fromX: 0, fromY: 0, fromZ: 0, speed: 0, dmg: 0, life: 0, len: 0, whizzed: false });
    }
    this.group.add(this.boltMesh);
  }

  /**
   * 接收关卡的场地信息。地面出生点和掩体点是照着图纸手写的坐标，道具一挪位置就可能正好被压住，
   * 所以这里先在寻路网格上"落地"：能站就原样用，不能站就挪到 2 米内最近的可站位置，再不行就丢掉。
   */
  setSite(site: Site) {
    const nav = this.world.nav;
    const land = (pts: [number, number][]) => pts.map(([x, z]) => nav.snap(x, z)).filter((p): p is [number, number] => !!p);
    this.site = { ...site, spawnGround: land(site.spawnGround), cover: land(site.cover) };
  }

  /** 还活着的敌人数。垂死的和残骸不算：任务推进、刷怪上限、令牌上限都看这个数。 */
  get aliveCount() { let n = 0; for (const e of this.list) if (e.alive) n++; return n; }
  /** 有没有敌人正在和玩家交战。 */
  get engaged() { for (const e of this.list) if (e.alive && e.mode === 'engage') return true; return false; }

  clear() {
    for (const e of this.list) this.dispose(e);
    this.list.length = 0; this.wrecks.length = 0; this.recentSpawns.length = 0;
    this.tokens = 0; this.tokenT = -99; this.wantAirT = this.wantGroundT = -99;
    _m.makeScale(0, 0, 0);
    this.bolts.forEach((b, i) => { b.live = false; this.boltMesh.setMatrixAt(i, _m); });
    this.boltMesh.instanceMatrix.needsUpdate = true;
  }
  private dispose(e: Enemy) {
    this.group.remove(e.group);
    e.bodyMat.dispose(); e.eyeMat.dispose(); e.glow?.dispose(); e.mesh.skeleton.dispose();
  }
  private remove(e: Enemy) {
    this.dispose(e);
    const i = this.list.indexOf(e); if (i >= 0) this.list.splice(i, 1);
    const w = this.wrecks.indexOf(e); if (w >= 0) this.wrecks.splice(w, 1);
  }

  // ------------------------------------------------------------------ 生成

  spawn(kind: Kind, x: number, z: number, opts: SpawnOpts = {}): Enemy {
    const bodyMat = BODY.clone();
    const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(LENS_CALM[0], LENS_CALM[1], LENS_CALM[2]) });
    const glow = kind === 'guard' ? new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.08, 0.03) }) : null;
    const rig = instantiate(rigDef(kind), { body: bodyMat, accent: ACCENT, dark: DARK, steel: STEEL, eye: eyeMat, glow: glow ?? eyeMat, blur: BLUR });
    const group = new THREE.Group();
    group.add(rig.mesh);
    const y = kind === 'gull' ? opts.y ?? 9 : 0;
    group.position.set(x, y, z);
    this.group.add(group);
    const alert = opts.alert ?? null;
    const yaw = opts.yaw ?? (alert ? Math.atan2(alert.x - x, alert.z - z) : rnd() * 6.283);
    const base: Base = {
      group, pos: group.position, mesh: rig.mesh, bones: rig.bones, bodyMat, eyeMat, glow,
      hp: 0, alive: true, yaw, flash: 0, phase: rnd() * 6.283,
      mode: alert ? 'investigate' : 'patrol', modeT: 0, los: false, seeT: 0, noSeeT: 0, senseT: rnd() * 0.15, exposure: 0,
      lastKnown: new THREE.Vector3(x, 0, z), home: new THREE.Vector3(x, y, z), sensor: new THREE.Vector3(x, y, z),
      hasToken: false, cool: 0, flare: 0, lens: [LENS_CALM[0], LENS_CALM[1], LENS_CALM[2]],
      smokeT: 0, dieT: 0, wreck: false, sink: 0,
    };
    if (alert) base.lastKnown.set(alert.x, Math.max(0, alert.y), alert.z);
    let e: Enemy;
    if (kind === 'gull') {
      group.rotation.order = 'YXZ';                    // 先转朝向，再俯仰，最后侧倾 —— 飞行器的姿态习惯这么表示
      rig.bones.head.rotation.order = 'YXZ';
      e = {
        ...base, kind, hp: GULL.hp, cool: 1 + rnd() * 1.5,
        vel: new THREE.Vector3(), pitch: 0, roll: 0,
        orbitDir: rnd() < 0.5 ? -1 : 1, orbitR: GULL.rangeMin + 2 + rnd() * (GULL.rangeMax - GULL.rangeMin - 5), orbitA: rnd() * 6.283,
        alt: GULL.altMin + 0.8 + rnd() * (GULL.altMax - GULL.altMin - 1.6), patrolR: 4 + rnd() * 5, flipT: 3 + rnd() * 4,
        atk: 'idle', atkT: 0, shots: 0, lead: 0.5, thrust: 1, lostRotor: -1,
        feeler: Math.floor(rnd() * 3), avoid: new THREE.Vector3(), ceil: 1e9, ceilT: 0, top: 0, topT: 0, climb: 0,
        sweep: rnd() * 6, gimbalYaw: 0, gimbalPitch: 0.4, spin: 0,
        indoor: false, door: -1,
      };
      e.indoor = this.underRoof(e.pos);
    } else {
      const spec = kind === 'hound' ? HOUND : GUARD;
      const walker: Walker = {
        ...base, spec, hp: spec.hp, cool: 0.6 + rnd(),
        es: 'move', esT: 0, moveT: 0, lungeCd: 0.3, waitT: rnd() * 1.5, shots: 0, bursts: 0, lead: 0.5,
        speed: 0, prevSpeed: 0, maxSpeed: 0, wantYaw: yaw, yawRate: 0, pushX: 0, pushZ: 0,
        goalX: x, goalZ: z, hasGoal: false, path: null, pathI: 0, planT: 0, stuckT: 0, doneX: 1e9, doneZ: 1e9,
        fireX: x, fireZ: z, hasFire: false, firePX: x, firePZ: z, scan: rnd() * 6, blocked: false, probeT: 0, crouch: 0,
      };
      if (kind === 'hound') {
        const legs = houndLegs(rig.bones), sin = Math.sin(yaw), cos = Math.cos(yaw);
        e = {
          ...walker, kind, legs,
          // 四只脚一开始就放在各自的"标准落脚点"上
          feet: legs.map((l) => { const fx = x + l.homeX * cos + l.homeZ * sin, fz = z - l.homeX * sin + l.homeZ * cos; return { x: fx, y: 0, z: fz, fromX: fx, fromZ: fz, toX: fx, toZ: fz, slideX: 0, slideZ: 0 }; }),
          swing: -1, swingT: 0, swingDur: 0.2, lift: 0.07, lastPair: 1, idleT: 0,
          sY: { x: 0, v: 0 }, sP: { x: 0, v: 0 }, sR: { x: 0, v: 0 }, sL: { x: 0, v: 0 }, sA: { x: 0, v: 0 }, sA2: { x: 0, v: 0 },
          headYaw: 0, headPitch: 0, jaw: 0.02, vy: 0, dieRoll: 0, diePitch: 0,
        };
      } else {
        e = { ...walker, kind, move: 0, anim: rnd() * 6, aimYaw: 0, aimPitch: -0.25, guardK: 0, recoil: 0, hitK: 0, hitSide: 1, anchor: 0, anchorZ: 0, fallSide: 1, knelt: false, fell: false };
      }
    }
    // 调查的时限：路上要花多久就多给多久（参考的地图小，固定给 8~10 秒就够走到；我们的地图大，得按距离算）
    e.modeT = (kind === 'gull' ? 8 : 10) + (alert ? this.travelTime(e, alert) : 0);
    this.list.push(e);
    return e;
  }

  /** 从敌人现在的位置走（飞）到 p 大概要几秒。地面单位要绕着箱垛走，实际路程按直线距离的 1.8 倍估。 */
  private travelTime(e: Enemy, p: THREE.Vector3) {
    const d = Math.hypot(p.x - e.pos.x, p.z - e.pos.z);
    return e.kind === 'gull' ? d / GULL.searchSpeed : (d * 1.8) / e.spec.runSpeed;
  }

  /**
   * 在 (cx, cz) 周围 rMin~rMax 米的一圈里挑一个出生点。
   * 随机撒一批候选点，每个打分，取分最高的：够远的加分，玩家看不见的加分，刚用过的位置附近扣分（免得一波敌人从同一个点冒出来）。
   */
  private pickSpot(kind: Kind, cx: number, cz: number, rMin: number, rMax: number, viewer: Player | null) {
    const { colliders } = this.world;
    const eye = viewer ? viewer.eyePos : null, ex = eye ? eye.x : 0, ey = eye ? eye.y : 0, ez = eye ? eye.z : 0;
    let best = -Infinity, bx = 0, by = 0, bz = 0;
    /** 给一个候选点打分，比现有的好就记下来。bonus 是额外加分。 */
    const consider = (x: number, y: number, z: number, bonus: number) => {
      const dist = Math.hypot(x - cx, z - cz);        // 被边界夹回来之后，实际距离可能比 rMin 近
      let score = bonus + rnd() * 1.5 + (dist >= rMin ? 2 + Math.min(1, (dist - rMin) / 30) * 0.5 : -(rMin - dist) / 4);
      if (eye && colliders.blocked(x, y, z, ex, ey, ez)) score += 2.5;
      for (const s of this.recentSpawns) if (this.clock - s.t < 6 && Math.hypot(x - s.x, z - s.z) < 5) score -= 3;
      if (score > best) { best = score; bx = x; by = y; bz = z; }
    };
    for (let i = 0; i < 30; i++) {
      const a = rnd() * 6.283, r = rMin + rnd() * (rMax - rMin);
      const x = clamp(cx + Math.cos(a) * r, BOUNDS.minX + 3, QUAY_X - 3), z = clamp(cz + Math.sin(a) * r, BOUNDS.minZ + 3, BOUNDS.maxZ - 3);
      let y = 1;
      if (kind === 'gull') {
        // 无人机出生在半空：比正下方的箱顶高 4~7 米，至少离地 7 米；正下方是起重机之类很高的东西就换一个点
        const top = this.surfaceBelow(x, 40, z);
        if (top > 14) continue;
        y = Math.max(7, top + 4) + rnd() * 3;
      } else if (!this.walkable(x, z)) continue;
      consider(x, y, z, 0);
    }
    // 关卡里手摆的出生点（车间里外）：落在这一圈距离里的也参加评选，并且多给 0.75 分 —— 它们藏在门里、墙后、道具旁，比随机撒的点讲究。
    // 因为"玩家看不见"有加分，玩家在屋外时，屋里的点自然就成了优先的出怪位置；反过来也一样。
    if (kind === 'gull') {
      for (const [x, y, z] of this.site.spawnAir) { const d = Math.hypot(x - cx, z - cz); if (d >= rMin && d <= rMax) consider(x, y, z, 0.75); }
    } else {
      for (const [sx, sz] of this.site.spawnGround) {
        const d = Math.hypot(sx - cx, sz - cz);
        if (d < rMin || d > rMax) continue;
        // 每次用的时候在 ±1.2 米内挪一挪，免得同一个点刷出来的敌人总站在同一块砖上；挪完站不住就用原位
        const jx = sx + (rnd() - 0.5) * 2.4, jz = sz + (rnd() - 0.5) * 2.4, ok = this.walkable(jx, jz);
        consider(ok ? jx : sx, 1, ok ? jz : sz, 0.75);
      }
    }
    if (best === -Infinity) return null;
    this.recentSpawns.push({ x: bx, z: bz, t: this.clock });
    if (this.recentSpawns.length > 12) this.recentSpawns.shift();
    return { x: bx, y: by, z: bz };
  }

  /**
   * 在离玩家 minDist~maxDist 米、最好还看不见的地方刷一个敌人。
   * alert=true（默认）时它一出生就知道玩家大概在哪，直奔过来"调查"；false 则原地巡逻。
   */
  spawnAround(kind: Kind, player: Player, opts: { minDist?: number; maxDist?: number; alert?: boolean } = {}) {
    const min = opts.minDist ?? 26, max = opts.maxDist ?? 44;
    const s = this.pickSpot(kind, player.pos.x, player.pos.z, min, max, player);
    if (!s) return null;
    return this.spawn(kind, s.x, s.z, { y: s.y, alert: opts.alert === false ? null : player.pos });
  }

  /** 在某个地点（比如一处中继）附近放一个巡逻的敌人。它不知道玩家在哪。 */
  spawnNear(kind: Kind, cx: number, cz: number, rMin: number, rMax: number, player: Player | null = null) {
    const s = this.pickSpot(kind, cx, cz, rMin, rMax, player);
    if (!s) return null;
    return this.spawn(kind, s.x, s.z, { y: s.y });
  }

  // ------------------------------------------------------------------ 命中检测与受伤

  /**
   * 子弹命中检测：把每个敌人看成几个球（无人机是一个压扁的球）。返回最近的命中；weak 表示打中的是弱点。
   * 垂死的敌人和残骸不挡子弹。
   */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxT: number): HitResult | null {
    let best: HitResult | null = null;
    for (const e of this.list) {
      if (!e.alive) continue;
      const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw), p = e.pos;
      // 把"机身坐标里的一个点"当成球心求交。机身坐标：x 朝左、y 朝上、z 朝前
      const ball = (lx: number, ly: number, lz: number, r: number) => raySphere(o, d, p.x + lx * cos + lz * sin, p.y + ly, p.z - lx * sin + lz * cos, r);
      let body: number, weak: number;
      if (e.kind === 'gull') {
        body = rayEllipsoid(o, d, p.x, p.y - 0.03, p.z, 0.82, 0.36);        // 四个涵道围成的扁盘
        weak = ball(0, -0.25, 0.46, 0.2);                                     // 机头下面的相机球
      } else if (e.kind === 'hound') {
        const dy = e.sY.x - e.crouch, dx = e.sL.x;
        weak = ball(dx, HOUND_POSE.headY + dy, HOUND_POSE.headZ, 0.22);
        body = Math.min(ball(dx, 0.8 + dy, -0.45, 0.33), ball(dx, 0.8 + dy, 0.05, 0.33), ball(dx, 0.8 + dy, 0.5, 0.33),        // 机身：沿脊背排三个球
          ball(0.3, 0.33, 0.37, 0.2), ball(-0.3, 0.33, 0.37, 0.2), ball(0.28, 0.33, -0.47, 0.2), ball(-0.28, 0.33, -0.47, 0.2)); // 四条腿
      } else {
        weak = ball(0, 2.48, 0.06, 0.3);
        body = Math.min(ball(0, 1.45, 0, 0.85), ball(0, 0.6, 0, 0.55), ball(0, 2.2, 0, 0.42));
      }
      const isWeak = weak < Infinity && weak <= body + 0.25;                // 弱点要比身体先（或几乎同时）被碰到才算
      const t = isWeak ? weak : body;
      if (t < maxT && (!best || t < best.t)) best = { enemy: e, t, weak: isWeak };
    }
    // 记住这条射线：紧接着的 damage() 要用它的方向来决定敌人往哪边晃、往哪边飞
    this.lastRayDir.copy(d); this.hasLastRay = true;
    if (best) this.lastHitPoint.copy(o).addScaledVector(d, best.t);
    return best;
  }

  /**
   * 让敌人受伤。返回 true 表示这一下把它击毁了。
   * dir 是子弹（或爆炸冲击）飞来的方向；不传的话用最近一次 raycast() 的射线方向 —— 开枪的代码总是先 raycast 再 damage。
   * 没有"硬直"：敌人挨打不会停下手里的事，只是身体被推一下、晃一下。
   */
  damage(e: Enemy, amount: number, weak: boolean, dir?: THREE.Vector3) {
    if (!e.alive) return false;
    const d = dir ?? (this.hasLastRay ? this.lastRayDir : null);
    e.hp -= amount; e.flash = 1;
    const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
    const along = d ? d.x * sin + d.z * cos : 0, across = d ? d.x * cos - d.z * sin : 0;   // 冲击方向在敌人"前后""左右"上的分量
    if (e.kind === 'gull') {
      if (d) e.vel.addScaledVector(d, Math.min(3, amount * 0.09));          // 顺着子弹方向被推开
      e.roll += (rnd() - 0.5) * 0.5; e.pitch += (rnd() - 0.5) * 0.4;        // 机身猛地一歪，之后自己回正
    } else if (e.kind === 'hound') {
      const k = Math.min(1.6, amount / 28);
      e.sL.v += across * 1.4 * k;                                            // 身体被横着推一下
      e.sR.v -= across * 3.2 * k;                                            // 歪一下
      e.sP.v += along * 2.4 * k * (weak ? 1.6 : 1);                          // 前后点一下头，打头更猛
      e.sY.v -= 0.5 * k;                                                     // 往下一沉
    } else {
      e.hitK = Math.min(1, e.hitK + (weak ? 1 : 0.6));
      e.hitSide = across > 0 ? 1 : across < 0 ? -1 : rnd() < 0.5 ? -1 : 1;
    }
    // 每一发命中都崩掉一两块漆皮零件
    if (!dir && this.hasLastRay) this.world.effects.debris(this.lastHitPoint, 0.3, weak ? 3 : 2);
    this.provoke(e);
    if (e.hp <= 0) { this.kill(e, weak, d); return true; }
    return false;
  }

  /** 按声源相对相机的距离和左右位置，算出音量和声像。 */
  spatial(p: THREE.Vector3): [number, number] {
    const cam = this.world.camera;
    const dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
    const dist = Math.hypot(dx, dy, dz);
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    return [clamp(1.15 - dist / 75, 0, 1), dist > 0.1 ? (dx * _right.x + dy * _right.y + dz * _right.z) / dist * 0.8 : 0];
  }

  // ------------------------------------------------------------------ 场景查询的小工具

  /** 对场景打一条射线，返回打到的距离（没打到返回 max）。方向分量是 0 时换成一个极小的数，免得除以零。 */
  private ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, out?: RayHit) {
    return this.world.colliders.raycast(ox, oy, oz, dx || 1e-9, dy || 1e-9, dz || 1e-9, max, out);
  }
  /** 从 (x, y, z) 往正下方看，最先碰到的表面有多高（地面是 0）。 */
  private surfaceBelow(x: number, y: number, z: number) { return y - this.ray(x, y, z, 0, -1, 0, y); }
  /**
   * 这个点是不是在车间的屋顶底下：水平位置在室内范围里，而且往上看得到屋面（屋顶上方的无人机往上看是天）。
   * was 是上一次的结论：已经在屋里的，只要还没出室内范围就一直算在屋里 —— 屋面上有几个破洞，
   * 飞到破洞正下方时往上看也是天，不能因此就当它"出屋了"（那样它会想从破洞里钻出去）。
   */
  private underRoof(p: THREE.Vector3, was = false) {
    const box = this.site.interior;
    if (!box || p.x <= box.min.x || p.x >= box.max.x || p.z <= box.min.z || p.z >= box.max.z || p.y >= box.max.y) return false;
    if (was) return true;
    const reach = box.max.y + 1 - p.y;
    return this.ray(p.x, p.y, p.z, 0, 1, 0, reach) < reach;
  }
  /** 地面单位能不能站在这里：寻路网格上这一格是空的（港区最外面 1 米和码头沿在网格里本来就是封死的）。 */
  private walkable(x: number, z: number) { return this.world.nav.isFree(x, z); }

  // ------------------------------------------------------------------ 3. 感知

  /**
   * 每帧更新一个敌人"知道多少"：看不看得见玩家、盯了多久、该不该换状态。
   * react 是反应时间：巡逻中要连续看见玩家这么久才开打；已经在调查 / 搜索的更警觉，只要 45% 的时间。
   */
  private think(e: Enemy, dt: number, react: number, player: Player) {
    // 视线检测要打射线，比较贵，所以每 0.11~0.19 秒才做一次（每个敌人的节奏还错开）
    e.senseT -= dt;
    if (e.senseT <= 0) {
      e.senseT = 0.11 + rnd() * 0.08;
      e.los = false;
      if (player.alive) {
        const eye = player.eyePos, ex = eye.x, ey = eye.y, ez = eye.z;
        const dx = ex - e.sensor.x, dy = ey - e.sensor.y, dz = ez - e.sensor.z, dist = Math.hypot(dx, dy, dz);
        if (dist < SENSE.sightRange) {
          const facing = (dx * Math.sin(e.yaw) + dz * Math.cos(e.yaw)) / (Math.hypot(dx, dz) + 1e-6);   // 玩家方向和自己朝向的夹角余弦
          // 交战中已经盯上了，不再受视野角度限制；否则玩家得在视野里，或者近到贴身
          if (e.mode === 'engage' || facing > SENSE.coneCos || dist < SENSE.nearSense)
            e.los = !this.world.colliders.blocked(e.sensor.x, e.sensor.y, e.sensor.z, ex, ey, ez);
        }
      }
    }
    if (e.los) {
      e.seeT += dt; e.noSeeT = 0; e.lastKnown.copy(player.pos);
      e.exposure = Math.min(1, e.exposure + dt * SENSE.exposureUp);
    } else {
      e.noSeeT += dt; e.seeT = Math.max(0, e.seeT - dt * 0.6);
      e.exposure = Math.max(0, e.exposure - dt * SENSE.exposureDown);
    }

    if (e.mode === 'engage') {
      if (e.noSeeT > SENSE.loseSight || !player.alive) { e.mode = 'search'; e.modeT = SENSE.searchTime + rnd() * 3; this.releaseToken(e); }
    } else if (e.los && e.seeT > (e.mode === 'patrol' ? react : react * 0.45)) {
      e.mode = 'engage'; e.noSeeT = 0;
      this.announce(e, false);
      this.rally(e.pos, 18, player.pos, e);            // 喊上 18 米内的同伴
    } else if (e.mode !== 'patrol') {
      e.modeT -= dt;
      if (e.modeT <= 0) { e.mode = 'patrol'; e.home.copy(e.pos); }   // 没找到：就地开始巡逻（无人机连高度一起记：在屋里放弃的就留在屋里转）
    }
  }

  private announce(e: Enemy, noise: boolean) {
    const [vol, pan] = this.spatial(e.pos);
    this.world.audio.alertChirp(e.kind === 'gull', vol * (noise ? 0.6 : 1), pan);
    this.onAlert(e, noise);
  }

  /** 把 pos 周围 radius 米内还没进入交战的敌人都叫去 target 看看。 */
  private rally(pos: THREE.Vector3, radius: number, target: THREE.Vector3, except: Enemy | null) {
    for (const o of this.list) {
      if (o === except || !o.alive || o.mode === 'engage' || o.pos.distanceTo(pos) > radius) continue;
      o.lastKnown.set(target.x, Math.max(0, target.y), target.z);
      o.mode = 'investigate'; o.modeT = 9 + rnd() * 4 + this.travelTime(o, target);
    }
  }

  /** 被打中了：立刻知道玩家在哪，下一次视线检测只要看得见就马上还击，并叫上 20 米内的同伴。 */
  private provoke(e: Enemy) {
    const p = this.player;
    if (!p) return;
    if (e.mode !== 'engage') {
      e.lastKnown.copy(p.pos); e.mode = 'investigate'; e.modeT = 10 + this.travelTime(e, p.pos);
      e.seeT = 1; e.senseT = 0;
    }
    this.rally(e.pos, 20, p.pos, e);
  }

  /**
   * 听觉：pos 处发出了声响（枪声、爆炸、刷怪时的"通报"），radius 米内还没在交战的敌人都过去调查。
   * 不给 radius 就按枪声算（45 米）。
   * 调查的时限里加上了赶路的时间 —— 我们的地图大，固定给十来秒的话远处的敌人走到一半就放弃了。
   */
  alert(pos: THREE.Vector3, radius = SENSE.hearRadius) {
    for (const e of this.list) {
      if (!e.alive || e.mode === 'engage' || e.pos.distanceTo(pos) > radius) continue;
      e.lastKnown.set(pos.x, Math.max(0, pos.y), pos.z);
      if (e.mode === 'patrol') this.announce(e, true);
      e.mode = 'investigate'; e.modeT = 9 + rnd() * 4 + this.travelTime(e, pos);
    }
  }

  /**
   * 召集：把离 pos 超过 minDist 米、还在巡逻的敌人叫到 pos 来看看。
   * 和 alert() 的区别：alert 是"附近有动静，听得见的都过去"；这个反过来，专门叫远处什么都没听见的，
   * 而且只动巡逻中的 —— 已经在调查 / 搜索的不打扰，不然它们会一次次拿到玩家的最新位置，变成全知。
   * 任务导演在"场上满员、增援进不来"时用它（见 mission.ts 的 direct()）。
   */
  regroup(pos: THREE.Vector3, minDist: number) {
    for (const e of this.list) {
      if (!e.alive || e.mode !== 'patrol' || e.pos.distanceTo(pos) < minDist) continue;
      e.lastKnown.set(pos.x, Math.max(0, pos.y), pos.z);
      e.mode = 'investigate'; e.modeT = 9 + rnd() * 4 + this.travelTime(e, pos);
    }
  }

  // ------------------------------------------------------------------ 4. 攻击令牌

  /**
   * 敌人想开火之前要先来"领令牌"，领不到就再等等。三条限制：
   *   1. 同时持有令牌的不超过 2 个（场上超过 5 个敌人时放宽到 3 个）；
   *   2. 任意两次发放之间至少隔 1.25 秒 —— 一轮"预警 + 连发"不到 0.9 秒，所以实际上全场同一时刻只有一个敌人在打，两轮之间还有空档；
   *   3. 空中和地面单位轮流：上一次是空中拿的、地面的又刚申请过，那 2.75 秒内空中的要让一让（反过来也一样），免得一种敌人霸占火力。
   */
  private requestToken(e: Enemy) {
    if (e.hasToken) return true;
    const air = e.kind === 'gull';
    const cap = this.aliveCount > TOKEN.crowd ? TOKEN.maxCrowd : TOKEN.max;
    const since = this.clock - this.tokenT;
    const otherWants = this.clock - (air ? this.wantGroundT : this.wantAirT) < 0.5;
    const yieldTurn = this.lastTokenAir === air && otherWants && since < TOKEN.gap * 2.2;
    if (this.tokens >= cap || since < TOKEN.gap || yieldTurn) {
      if (air) this.wantAirT = this.clock; else this.wantGroundT = this.clock;
      return false;
    }
    this.tokens++; this.tokenT = this.clock; this.lastTokenAir = air; e.hasToken = true;
    return true;
  }
  private releaseToken(e: Enemy) { if (e.hasToken) { e.hasToken = false; this.tokens = Math.max(0, this.tokens - 1); } }

  /** 这一发的散布（弧度）：盯得越久越准，玩家跑得越快越散。moveK 是"玩家每快 1 米每秒，散布放大多少"。 */
  private spread(e: Enemy, far: number, near: number, moveK: number) {
    return (far + (near - far) * e.exposure) * (1 + (this.playerSpeed / SPEED_SCALE) * moveK);
  }

  // ------------------------------------------------------------------ 每帧更新

  update(dt: number, t: number, player: Player) {
    dt = Math.min(dt, 0.05);
    this.clock += dt; this.player = player;
    this.playerSpeed = damp(this.playerSpeed, player.horizSpeed, 6, dt);

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      e.flash = Math.max(0, e.flash - dt * 6);
      e.bodyMat.emissive.setScalar(e.flash * 0.25);      // 中弹时外壳亮一下（给太亮的话整只敌人会被泛光糊成一团白）
      if (!e.alive) this.updateDying(e, dt, t);
      else if (e.kind === 'gull') this.updateGull(e, dt, t, player);
      else this.updateWalker(e, dt, t, player);
    }

    // 无人机之间互相推开一点，免得叠在一起。推的是速度而不是位置：直接挪位置的话，挤在屋里时会把同伴按进墙里
    // （每架自己的"逐轴碰撞"只管自己的速度方向上有没有墙，管不了被别人硬挪过去的那一下）
    for (let i = 0; i < this.list.length; i++) for (let j = i + 1; j < this.list.length; j++) {
      const a = this.list[i], b = this.list[j];
      if (a.kind !== 'gull' || b.kind !== 'gull' || !a.alive || !b.alive) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz);
      if (d < 3 && d > 1e-3) { const k = ((3 - d) / d) * 9 * dt; a.vel.x -= dx * k; a.vel.z -= dz * k; b.vel.x += dx * k; b.vel.z += dz * k; }
    }

    this.updateBolts(dt, player);
  }

  /** 镜头颜色：平时琥珀色，交战变红；预警时猛地变亮（flare），这是玩家判断"它要开火了"的主要依据。 */
  private updateLens(e: Enemy, dt: number, t: number, flareGain: number) {
    const engage = e.mode === 'engage', target = engage ? LENS_HOT : LENS_CALM, k = 1 - Math.exp(-8 * dt);
    for (let i = 0; i < 3; i++) e.lens[i] += (target[i] - e.lens[i]) * k;
    const gain = 1 + e.flare * flareGain + (engage ? 0 : Math.sin(t * 3 + e.phase) * 0.15);   // 没发现玩家时有缓慢的"呼吸"
    e.eyeMat.color.setRGB(e.lens[0] * gain, e.lens[1] * gain, e.lens[2] * gain);
  }

  // ------------------------------------------------------------------ 5. 无人机

  private updateGull(e: Gull, dt: number, t: number, player: Player) {
    const { effects, audio } = this.world;
    const pos = e.pos, px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    let sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
    e.sensor.set(pos.x + GULL_CAM.z * sin, pos.y + GULL_CAM.y, pos.z + GULL_CAM.z * cos);
    this.think(e, dt, GULL.react, player);
    const engage = e.mode === 'engage', firing = e.atk !== 'idle', lk = e.lastKnown;

    // ---- 想去哪：先定一个目标点 (tx, ty, tz) 和这种状态下的速度上限
    let tx: number, ty: number, tz: number, maxSpeed: number;
    if (engage) {
      maxSpeed = GULL.maxSpeed;
      e.flipT -= dt;
      if (e.flipT <= 0) {                               // 每隔几秒换一换绕飞的方向和半径，别让玩家摸出规律
        e.flipT = 3 + rnd() * 5;
        if (rnd() < 0.6) e.orbitDir = -e.orbitDir;
        e.orbitR = clamp(e.orbitR + (rnd() - 0.5) * 6, GULL.rangeMin + 1, GULL.rangeMax - 2);
      }
      if (e.noSeeT > 1.5) {
        // 看不见玩家超过 1.5 秒：别傻绕了，直接飞到最后见到他的位置上空去找
        tx = lk.x; ty = lk.y + e.alt + 1; tz = lk.z;
        e.orbitA = Math.atan2(pos.z - lk.z, pos.x - lk.x);
      } else {
        // 绕着玩家转圈。平时切线速度 3.6 米每秒；一开始预警就降到 0.9，几乎悬停 —— 这是留给玩家打它的窗口
        e.orbitA += (e.orbitDir * (firing ? 0.9 : 3.6) / e.orbitR) * dt;
        tx = px + Math.cos(e.orbitA) * e.orbitR; ty = py + e.alt; tz = pz + Math.sin(e.orbitA) * e.orbitR;
      }
    } else if (e.mode !== 'patrol') {
      maxSpeed = GULL.searchSpeed;
      e.orbitA += 0.5 * dt;                             // 在可疑位置上空绕小圈
      tx = lk.x + Math.cos(e.orbitA) * 4.5; ty = lk.y + Math.min(e.alt, 5.5); tz = lk.z + Math.sin(e.orbitA) * 4.5;
    } else {
      maxSpeed = GULL.patrolSpeed;
      e.orbitA += 0.28 * dt * e.orbitDir;               // 绕着出生点慢慢转
      tx = e.home.x + Math.cos(e.orbitA) * e.patrolR; ty = e.home.y; tz = e.home.z + Math.sin(e.orbitA) * e.patrolR;
    }
    tx = clamp(tx, BOUNDS.minX + 2, QUAY_X + 20); tz = clamp(tz, BOUNDS.minZ + 2, BOUNDS.maxZ - 2);

    // ---- 屋里屋外：它要找的对象和自己不在屋顶的同一侧，就得先穿过一个门洞
    const box = this.site.interior;
    let door: Door | null = null;
    if (box) {
      // "对象"：交战时是玩家（跟丢超过 1.5 秒就是最后见到他的位置），调查 / 搜索时是可疑位置，巡逻时是自己的巡逻中心
      const subj = e.mode === 'patrol' ? e.home : engage && e.noSeeT <= 1.5 ? player.pos : lk;
      const subjIn = subj.x > box.min.x && subj.x < box.max.x && subj.z > box.min.z && subj.z < box.max.z && subj.y < box.max.y;
      if (e.indoor !== subjIn && this.site.doors.length) {
        door = this.throughDoor(e, subj, _v);
        tx = _v.x; ty = _v.y; tz = _v.z;
      } else {
        e.door = -1;
        // 都在屋里：目标点夹在四面墙以内（绕飞半径比屋子大，夹住之后它就贴着墙根一圈圈转）
        if (e.indoor) { tx = clamp(tx, box.min.x + GULL.indoorWall, box.max.x - GULL.indoorWall); tz = clamp(tz, box.min.z + GULL.indoorWall, box.max.z - GULL.indoorWall); }
      }
    }
    // 目标点正下方有东西（箱垛、货架）就把目标抬到它上面。屋外从高处往下看：我们的堆场比参考的高（最高四层箱，十一米多），
    // 得提前知道前面的箱顶有多高；屋里和穿门时只看自己这个高度以下的 —— 从高处看下来只会看到屋顶
    e.topT -= dt;
    if (e.topT <= 0) {
      e.topT = 0.2 + rnd() * 0.1;
      e.indoor = this.underRoof(pos, e.indoor);
      e.top = e.indoor || door ? this.surfaceBelow(tx, pos.y + 0.3, tz) : this.surfaceBelow(tx, Math.max(pos.y, ty) + 6, tz);
    }
    if (door) {
      // 穿门：压在门楣以下。离门口还远（6 米以外）时允许临时拔高，好翻过挡在路上的箱垛和屋顶；到了门口就不许了
      ty = Math.min(Math.max(ty, e.top + GULL.indoorClearance), door.top - 1) + (Math.hypot(tx - pos.x, tz - pos.z) > 6 ? e.climb : 0);
    } else if (e.indoor) ty = clamp(Math.max(ty, e.top + GULL.indoorClearance), GULL.indoorAltMin, GULL.indoorAltMax);
    else ty = Math.max(ty, e.top + GULL.clearance) + e.climb;   // 屋外被墙挡住时临时拔高（climb）
    ty = Math.max(2.2, Math.min(ty, e.ceil));           // 头顶有东西就别往上顶；再低也不低于 2.2 米

    // ---- 加速度：像一根带阻尼的弹簧把它往目标点拉（离得越远拉得越狠，速度越大阻力越大）
    let ax = (tx - pos.x) * 2.2 - e.vel.x * 2.4, ay = (ty - pos.y) * 5 - e.vel.y * 3.6, az = (tz - pos.z) * 2.2 - e.vel.z * 2.4;

    // ---- 三根触须轮流探测，一帧只打一条射线：前方 / 脚下 / 头顶
    const flat = Math.hypot(e.vel.x, e.vel.z), frames = dt * 60;   // frames：把"每次加多少"换算成和帧率无关
    e.feeler = (e.feeler + 1) % 3;
    if (e.feeler === 0) {
      if (flat > 0.6) {
        const reach = GULL.feel + flat * 0.5;
        const d = this.ray(pos.x, pos.y, pos.z, e.vel.x / flat, 0, e.vel.z / flat, reach, _hit);
        if (d < reach) {
          const k = 1 - d / reach;                      // 离墙越近 k 越大
          e.avoid.set(_hit.nx * 26 * k, _hit.ny * 26 * k + 9 * k, _hit.nz * 26 * k);   // 顺着墙面的法线把自己推开，再往上抬一点
          if (k > 0.5) { e.orbitDir = -e.orbitDir; e.flipT = 2.5; }                    // 快撞上了：掉头往回绕
          e.climb = Math.min(GULL.climbMax, e.climb + 1.5 * frames);
        }
      }
    } else if (e.feeler === 1) {
      const d = this.ray(pos.x, pos.y, pos.z, 0, -1, 0, 2.4);
      if (d < 2.4) e.avoid.y += (2.4 - d) * 10 * frames;                                // 离下面的东西不到 2.4 米：往上顶
    } else {
      e.ceilT -= dt * 3;
      if (e.ceilT <= 0) { e.ceilT = 0.35; const d = this.ray(pos.x, pos.y, pos.z, 0, 1, 0, 4); e.ceil = d < 4 ? pos.y + d - 1.3 : 1e9; }
    }
    ax += e.avoid.x; ay += e.avoid.y; az += e.avoid.z;
    e.avoid.multiplyScalar(Math.exp(-6 * dt));
    e.climb *= Math.exp(-0.6 * dt);

    const hurt = e.hp < GULL.hp * 0.5;                  // 半血以下（也就是挨过一枪）：飞得摇摇晃晃
    if (hurt) { ax += Math.sin(t * 7.3 + e.phase) * 5; az += Math.cos(t * 6.1 + e.phase) * 5; ay += Math.sin(t * 9.7) * 3; }
    const al = Math.hypot(ax, ay, az);
    if (al > GULL.accel) { const k = GULL.accel / al; ax *= k; ay *= k; az *= k; }
    e.vel.x += ax * dt; e.vel.y += ay * dt; e.vel.z += az * dt;
    const sp = e.vel.length();
    if (sp > maxSpeed) e.vel.multiplyScalar(maxSpeed / sp);

    // ---- 逐轴碰撞：三个轴各打一条短射线，撞上了就在那个轴上反弹一点，并把位置推出去
    for (let axis = 0; axis < 3; axis++) {
      const v = e.vel.getComponent(axis);
      if (Math.abs(v) <= 0.02) continue;
      const s = Math.sign(v), margin = axis === 1 ? GULL.marginY : GULL.marginXZ, reach = Math.abs(v) * dt + margin;
      const d = this.ray(pos.x, pos.y, pos.z, axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0, reach);
      if (d < reach) {
        e.vel.setComponent(axis, -v * 0.25);
        e.avoid.setComponent(axis, e.avoid.getComponent(axis) - s * 8);
        if (d < margin) pos.setComponent(axis, pos.getComponent(axis) - s * (margin - d));
      }
    }
    pos.addScaledVector(e.vel, dt);
    pos.y = Math.max(pos.y, this.surfaceBelow(pos.x, pos.y + 0.5, pos.z) + 1.1);

    // ---- 朝向：有目标就盯着目标，巡逻时朝飞行方向；每秒最多转 3.2 弧度
    let wantYaw = e.yaw;
    if (engage) wantYaw = e.noSeeT < 1.5 ? Math.atan2(px - pos.x, pz - pos.z) : Math.atan2(lk.x - pos.x, lk.z - pos.z);
    else if (e.mode !== 'patrol') wantYaw = Math.atan2(lk.x - pos.x, lk.z - pos.z);
    else if (flat > 0.4) wantYaw = Math.atan2(e.vel.x, e.vel.z);
    e.yaw += clamp(wrap(wantYaw - e.yaw), -3.2 * dt, 3.2 * dt);
    sin = Math.sin(e.yaw); cos = Math.cos(e.yaw);

    // ---- 机身姿态：四旋翼靠倾斜机身来加速，所以"往哪加速就往哪倾"（最多 0.42 弧度，约 24°）
    let wantPitch = clamp((ax * sin + az * cos) * 0.04, -0.42, 0.42), wantRoll = clamp(-(ax * cos - az * sin) * 0.04, -0.42, 0.42);
    if (hurt) { wantPitch += Math.sin(t * 11 + e.phase) * 0.1; wantRoll += Math.cos(t * 8.7 + e.phase * 2) * 0.13; }
    const q = 1 - Math.exp(-7 * dt);
    e.pitch += (wantPitch - e.pitch) * q; e.roll += (wantRoll - e.roll) * q;
    e.group.rotation.set(e.pitch, e.yaw, e.roll);
    const b = e.bones;
    b.root.position.y = Math.sin(t * 2.1 + e.phase) * 0.045 + Math.sin(t * 3.7 + e.phase * 1.7) * 0.018;   // 悬停时轻微的上下浮动
    // 油门跟着"要往上加速多少、飞得多快"变，旋翼转速跟着油门变。对角的两只同向、相邻的反向，转速略有差别
    e.thrust += (1 + clamp(ay * 0.03, -0.25, 0.4) + flat * 0.02 - e.thrust) * q;
    const turn = 41 * e.thrust * dt;
    b.rotor0.rotation.y += turn; b.rotor1.rotation.y -= turn * 1.03; b.rotor2.rotation.y -= turn * 0.98; b.rotor3.rotation.y += turn * 1.01;

    // ---- 云台：交战时盯着玩家；调查时在可疑位置周围扫；巡逻时朝前下方左右扫
    let lx: number, ly: number, lz: number;
    e.sweep += dt;
    if (engage) { lx = px; ly = py + 1.1; lz = pz; }
    else if (e.mode !== 'patrol') { lx = lk.x + Math.sin(e.sweep * 0.9) * 3; ly = lk.y; lz = lk.z + Math.cos(e.sweep * 0.7) * 3; }
    else { const a = e.yaw + Math.sin(e.sweep * 0.5 + e.phase) * 0.9; lx = pos.x + Math.sin(a) * 5; ly = pos.y - 5; lz = pos.z + Math.cos(a) * 5; }
    const gx = lx - e.sensor.x, gy = ly - e.sensor.y, gz = lz - e.sensor.z;
    const localX = gx * cos - gz * sin, localZ = gx * sin + gz * cos;                  // 换到机身坐标里
    const gk = 1 - Math.exp(-9 * dt);
    e.gimbalYaw += wrap(Math.atan2(localX, localZ) - e.gimbalYaw) * gk;
    e.gimbalPitch += (clamp(Math.atan2(-gy, Math.hypot(localX, localZ)), -0.5, 1.5) - e.gimbalPitch) * gk;
    b.head.rotation.set(e.gimbalPitch - e.pitch, e.gimbalYaw, 0);

    this.updateLens(e, dt, t, 3.2);
    e.flare = Math.max(0, e.flare - dt * 1.5);

    // ---- 攻击：待机 → 预警（0.55 秒）→ 三连发 → 待机
    e.cool -= dt;
    const mx = pos.x + GULL_MUZZLE.z * sin, my = pos.y + GULL_MUZZLE.y, mz = pos.z + GULL_MUZZLE.z * cos;
    if (e.atk === 'idle') {
      // 开火条件：在交战、看得见、歇够了、机头大致对着玩家、够近，最后还要领得到令牌
      if (engage && e.los && e.cool <= 0 && player.alive && Math.abs(wrap(Math.atan2(px - pos.x, pz - pos.z) - e.yaw)) < 0.35
        && Math.hypot(px - pos.x, py - pos.y, pz - pos.z) < GULL.fireRange && this.requestToken(e)) {
        e.atk = 'tele'; e.atkT = GULL.telegraph;
        const [vol, pan] = this.spatial(pos);
        audio.telegraph('gull', GULL.telegraph, vol, pan);
      }
    } else if (e.atk === 'tele') {
      e.atkT -= dt; e.flare = Math.min(1, e.flare + dt * 4.5);
      if (!engage) { e.atk = 'idle'; this.releaseToken(e); }                            // 预警到一半跟丢了：算了
      else if (e.atkT <= 0) { e.atk = 'burst'; e.shots = GULL.burst; e.atkT = 0; e.lead = 0.2 + rnd() * 0.65; }
    } else {
      e.atkT -= dt; e.flare = 1;
      if (e.atkT <= 0) {
        e.atkT = GULL.burstGap; e.shots--;
        // 瞄玩家胸口，并按玩家的速度打一点提前量。lead 每轮随机取 20%~85%：故意不给足，所以横着跑总能躲掉一部分
        const fly = Math.hypot(px - mx, py - my, pz - mz) / GULL.boltSpeed;
        let dx = px + player.vel.x * fly * e.lead - mx, dy = py + player.height * 0.6 - my, dz = pz + player.vel.z * fly * e.lead - mz;
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        // 散布是个角度，离得越近落点越集中。绕飞半径本来保证它在 14 米以外开火；进了屋只有七八米，
        // 不折算的话一照面就百发百中。所以近于 14 米时把角度按比例放大，落点的散开程度和 14 米处一样
        const near = Math.max(1, GULL.rangeMin + 2) / Math.max(4, Math.hypot(px - mx, pz - mz));
        const s = this.spread(e, GULL.spreadFar, GULL.spreadNear, 0.45) * (hurt ? 1.5 : 1) * Math.max(1, near);
        dx += (rnd() - 0.5) * 2 * s; dy += (rnd() - 0.5) * 2 * s; dz += (rnd() - 0.5) * 2 * s;
        const nl = Math.hypot(dx, dy, dz) || 1; dx /= nl; dy /= nl; dz /= nl;
        this.fireBolt(mx, my, mz, dx, dy, dz, GULL.boltSpeed, GULL.boltDamage);
        e.vel.x -= dx * 0.35; e.vel.y -= dy * 0.35; e.vel.z -= dz * 0.35;               // 后坐：机身被往后顶一下
        if (e.shots <= 0) { e.atk = 'idle'; e.cool = GULL.cooldown[0] + rnd() * (GULL.cooldown[1] - GULL.cooldown[0]); this.releaseToken(e); }
      }
    }

    // ---- 受伤冒烟
    if (hurt) {
      e.smokeT -= dt;
      if (e.smokeT <= 0) {
        e.smokeT = 0.16;
        effects.puff(pos, { size: 0.3 * GULL.smoke, life: 1.1, color: 0x26282c, rise: 0.8 });
        if (rnd() < 0.15) effects.sparks(pos, 0, -1, 0, 2);
      }
    }
  }

  /**
   * 无人机要进屋（或者出屋）：挑一个门洞，算出这一刻该朝哪飞，写进 out，并返回选中的门。
   * 分两步走：先飞到自己这一侧、正对门洞中线 3.5 米远的地方把高度压下来；对准了再朝门另一侧 3.5 米处飞，直着穿过去。
   * 这里不记"第几步"，每帧都重新看一眼自己对准了没有 —— 被撞歪了、被挤开了，自然就会回去重新对准。
   */
  private throughDoor(e: Gull, subj: THREE.Vector3, out: THREE.Vector3): Door {
    const doors = this.site.doors, pos = e.pos;
    // 挑门：自己到门口的距离 + 门口到对象的距离，取最短的。已经选定的门算便宜 4 米，免得在两个门之间来回改主意
    let best = Infinity;
    doors.forEach((d, i) => {
      const cost = Math.hypot(d.x - pos.x, d.z - pos.z) + Math.hypot(d.x - subj.x, d.z - subj.z) - (i === e.door ? 4 : 0);
      if (cost < best) { best = cost; e.door = i; }
    });
    const d = doors[e.door], side = e.indoor ? -1 : 1;                       // 自己在门的哪一边：+1 屋外，-1 屋里
    const ahead = ((pos.x - d.x) * d.nx + (pos.z - d.z) * d.nz) * side;      // 离墙面还有多远（已经穿过去了就是负数）
    const off = Math.abs((pos.x - d.x) * d.nz - (pos.z - d.z) * d.nx);       // 偏离门洞中线多远
    // 对准了 = 在中线附近（离门框至少 1.2 米）、比门楣低、离墙不到 6 米。刚穿过墙面的那几米也算，不然会在门洞里掉头
    const lined = off < d.half - 1.2 && pos.y < d.top - 0.8 && ahead < 6 && ahead > -4;
    const k = (lined ? -3.5 : 3.5) * side;
    out.set(d.x + d.nx * k, GULL.doorAlt, d.z + d.nz * k);
    return d;
  }

  // ------------------------------------------------------------------ 6. 地面单位（机器狗、守卫）

  private setGoal(e: Walker, x: number, z: number, force: boolean) {
    if (!force && e.hasGoal && Math.hypot(e.goalX - x, e.goalZ - z) < 0.5) return;
    e.goalX = x; e.goalZ = z; e.hasGoal = true; e.planT = 0; e.stuckT = 0;
  }

  /**
   * 沿着寻路的结果往目标走。它不直接挪位置，只算出"想朝哪转"（wantYaw）和"这一刻最快能走多快"（maxSpeed），
   * 真正的转向、加减速、碰撞在 steer() 里统一做。返回 true 表示到了（或者确认走不到）。
   */
  private follow(e: Walker, dt: number, cap: number) {
    if (!e.hasGoal) { e.maxSpeed = 0; return true; }
    const x = e.pos.x, z = e.pos.z;
    e.planT -= dt;
    if (e.planT <= 0 || !e.path) {
      // 每 0.6 秒左右重新找一次路：目标可能动了，自己也可能被挤偏了
      e.planT = 0.6 + rnd() * 0.15;
      // 寻路返回的是几个拐点；终点落在走不到的地方（比如玩家站在箱顶上）时，最后一个拐点是离它最近的可走位置
      e.path = this.world.nav.findPath(x, z, e.goalX, e.goalZ);
      e.pathI = 0;
    }
    const p = e.path;
    if (!p) { e.hasGoal = false; e.maxSpeed = 0; return true; }
    // 已经走到的拐点跳过（半米一格，离拐点 0.55 米以内就算到了）；已经能直着走到下一个拐点的，也不必先去踩当前这个
    const nav = this.world.nav;
    while (e.pathI < p.length - 2 && (Math.hypot(p[e.pathI] - x, p[e.pathI + 1] - z) < 0.55 || nav.clearLine(x, z, p[e.pathI + 2], p[e.pathI + 3]))) e.pathI += 2;
    const remain = Math.hypot(p[p.length - 2] - x, p[p.length - 1] - z);
    if (remain < 0.45) { e.hasGoal = false; e.maxSpeed = 0; return true; }
    e.wantYaw = Math.atan2(p[e.pathI] - x, p[e.pathI + 1] - z);
    const off = Math.abs(wrap(e.wantYaw - e.yaw));
    // 还没转过来（偏了 1.1 弧度以上）就先原地转；偏得越多走得越慢；快到了也要减速，免得冲过头
    e.maxSpeed = off > 1.1 ? 0 : Math.min(cap * (1 - off * 0.5), 0.4 + remain * 2.6);
    return false;
  }

  /**
   * 选一个射击位：撒一批候选点，各自打分，取分最低的。
   * 好位置 = 离玩家不远不近（rangeMin~rangeMax）、看得见玩家、离自己近、不和别的同伴站在同一个方向。
   * 效果是它们会保持距离、从不同方向包抄，而不是排着队冲脸。
   */
  private pickFirePos(e: Hound | Guard, player: Player) {
    const S = e.spec, px = player.pos.x, pz = player.pos.z;
    const eye = player.eyePos, ex = eye.x, ey = eye.y, ez = eye.z;
    const toMe = Math.atan2(e.pos.z - pz, e.pos.x - px);
    let best = Infinity, bx = e.pos.x, bz = e.pos.z;
    const cover = this.site.cover;
    for (let i = 0; i < 16 + cover.length; i++) {
      let qx: number, qz: number, r: number, bonus: number;
      if (i < 16) {
        let a: number;
        if (i < 10) { a = rnd() * 6.283; r = Math.sqrt(rnd()) * S.rangeMax; bonus = 0; }                         // 玩家周围随便撒的点
        else { a = toMe + (rnd() - 0.5) * 2.6; r = S.rangeMin + 1 + rnd() * (S.rangeMax - S.rangeMin - 2); bonus = 1; } // 自己这一侧的一圈点（保底）
        qx = px + Math.cos(a) * r; qz = pz + Math.sin(a) * r;
      } else {
        // 关卡里手摆的掩体点（木箱、吨桶、货架旁边）：减 2 分，同等条件下优先站过去 —— 看上去像是它"知道找掩体"
        [qx, qz] = cover[i - 16]; r = Math.hypot(qx - px, qz - pz); bonus = -2;
      }
      if (r < S.rangeMin || r > S.rangeMax || !this.walkable(qx, qz)) continue;
      let score = Math.hypot(qx - e.pos.x, qz - e.pos.z) * 0.9 + bonus + rnd() * 3;
      for (const o of this.list) {
        if (o === e || !o.alive || o.kind === 'gull' || o.mode !== 'engage') continue;
        const ox = o.hasFire ? o.fireX : o.pos.x, oz = o.hasFire ? o.fireZ : o.pos.z;
        // 从玩家看过去，这个点和同伴的夹角太小（余弦 > 0.86，约 30° 以内）就扣分：别站在同一个方向
        const c = ((qx - px) * (ox - px) + (qz - pz) * (oz - pz)) / (r * (Math.hypot(ox - px, oz - pz) + 1e-6));
        if (c > 0.86) score += (14 * (c - 0.86)) / 0.14;
        if (Math.hypot(qx - ox, qz - oz) < 3) score += 16;                                                     // 别挤在一起
      }
      if (score >= best) continue;
      if (this.world.colliders.blocked(qx, S.eyeY, qz, ex, ey, ez)) score += 22;                               // 看不见玩家的位置：重罚
      if (score < best) { best = score; bx = qx; bz = qz; }
    }
    e.fireX = bx; e.fireZ = bz; e.hasFire = true; e.firePX = px; e.firePZ = pz;
    this.setGoal(e, bx, bz, true);
    e.es = 'move'; e.esT = 0; e.moveT = 0; e.bursts = 0;
  }

  private updateWalker(e: Hound | Guard, dt: number, t: number, player: Player) {
    const S = e.spec, pos = e.pos, audio = this.world.audio;
    e.sensor.set(pos.x + Math.sin(e.yaw) * S.eyeZ, pos.y + S.eyeY, pos.z + Math.cos(e.yaw) * S.eyeZ);
    const before = e.mode;
    this.think(e, dt, S.react, player);
    if (e.mode !== before) {
      // 状态变了：手头的路线作废。刚进入交战就先选一个射击位；从交战退出来时如果正在预警 / 连发，把令牌还掉
      e.hasGoal = false; e.path = null; e.waitT = 0; e.doneX = e.doneZ = 1e9;
      if (e.es === 'tele' || e.es === 'burst') this.releaseToken(e);
      e.es = 'move';
      if (e.mode === 'engage') this.pickFirePos(e, player);
    }
    e.wantYaw = e.yaw; e.maxSpeed = 0; e.crouch = 0;
    e.cool -= dt; e.lungeCd -= dt;
    e.flare = Math.max(0, e.flare - dt * 2);
    const dx = player.pos.x - pos.x, dz = player.pos.z - pos.z, dist = Math.hypot(dx, dz);
    const lk = e.lastKnown;
    let lookX = 0, lookY = 0, lookZ = 0, looking = false;

    if (e.mode === 'patrol') {
      // ---- 巡逻：在出生点周围 7 米内随便找个点走过去，站一会儿，再找下一个
      if (e.hasGoal) { if (this.follow(e, dt, S.patrolSpeed)) e.waitT = 1.5 + rnd() * 3; }
      else if ((e.waitT -= dt) <= 0) {
        e.waitT = 1;
        for (let i = 0; i < 6; i++) {
          const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 7, x = e.home.x + Math.cos(a) * r, z = e.home.z + Math.sin(a) * r;
          // 要求能直着走过去：隔着一堵墙的点虽然离得近，真要走过去得出门绕一大圈，不像是在"随便转转"
          if (this.world.nav.clearLine(pos.x, pos.z, x, z)) { this.setGoal(e, x, z, true); break; }
        }
      }
    } else if (e.mode !== 'engage') {
      // ---- 调查 / 搜索：走到可疑位置（最后 8 米放慢、潜行），到了就原地左右张望
      looking = true; lookX = lk.x; lookY = lk.y + 1.2; lookZ = lk.z;
      const d = Math.hypot(lk.x - pos.x, lk.z - pos.z);
      const visited = Math.hypot(lk.x - e.doneX, lk.z - e.doneZ) < 1;
      if (d > 2.2 && !visited) {
        this.setGoal(e, lk.x, lk.z, false);
        if (this.follow(e, dt, d < 8 ? S.stalkSpeed : S.runSpeed)) { e.doneX = lk.x; e.doneZ = lk.z; }
      } else { e.hasGoal = false; e.scan += dt; e.wantYaw = e.yaw + Math.sin(e.scan * 0.8) * 0.9; }
    } else {
      // ---- 交战
      looking = true; lookX = player.pos.x; lookY = player.pos.y + 1; lookZ = player.pos.z;
      const face = Math.atan2(dx, dz), level = Math.abs(player.pos.y - pos.y) < 1.6;
      // 玩家贴到跟前了：不管手头在干什么（除了正在预警 / 连发），先蹲 0.28 秒，然后扑上去
      if (S.lungeRange > 0 && (e.es === 'move' || e.es === 'aim' || e.es === 'cool') && dist < S.lungeRange && e.lungeCd <= 0 && player.alive && level) {
        e.es = 'wind'; e.esT = 0.28; e.hasGoal = false;
        this.releaseToken(e);
        const [vol, pan] = this.spatial(pos);
        audio.telegraph('lunge', 0.28, vol, pan);
      }
      switch (e.es) {
        case 'move': {                                  // 跑向选好的射击位
          e.moveT += dt;
          const arrived = this.follow(e, dt, S.runSpeed);
          // 到位了就开始瞄；跑了一阵、已经看得见玩家、距离也合适的话，也可能半路就停下来打；跑太久（7 秒）也停
          if (arrived || (e.moveT > 1.4 && e.los && dist > S.rangeMin - 1 && dist < S.rangeMax + 2 && rnd() < dt * 0.7) || e.moveT > 7) { e.es = 'aim'; e.esT = 0; e.hasGoal = false; }
          else if (Math.hypot(player.pos.x - e.firePX, player.pos.z - e.firePZ) > 7) this.pickFirePos(e, player);   // 玩家已经走远，原来选的位置不作数了
          break;
        }
        case 'aim': case 'cool': {                      // 站定、转向玩家，等冷却、等令牌
          e.wantYaw = face; e.esT += dt;
          const aimOff = e.kind === 'guard' ? e.aimYaw : 0;            // 守卫的上身能自己转，炮口朝向 = 身体朝向 + 上身转角
          if (e.los) {
            if (dist < S.rangeMin * 0.62 && e.esT > 0.8) this.pickFirePos(e, player);                             // 太近了：拉开距离
            else if (e.cool <= 0 && player.alive && Math.abs(wrap(face - e.yaw - aimOff)) < 0.14 && this.requestToken(e)) {
              e.es = 'tele'; e.esT = S.telegraph;
              const [vol, pan] = this.spatial(pos);
              audio.telegraph('hound', S.telegraph, vol, pan);
            }
          } else if (e.noSeeT > 1.1 || e.esT > 3) this.pickFirePos(e, player);                                   // 看不见了：换个位置
          break;
        }
        case 'tele':                                    // 预警：镜头变亮、身体微蹲
          e.wantYaw = face; e.esT -= dt; e.flare = Math.min(1, e.flare + dt * 5); e.crouch = 0.05;
          if (e.esT <= 0) { e.es = 'burst'; e.shots = S.burst; e.esT = 0; e.lead = 0.2 + rnd() * 0.65; }
          break;
        case 'burst':                                   // 连发
          e.wantYaw = face; e.flare = 1; e.crouch = 0.05; e.esT -= dt;
          if (e.esT <= 0) {
            e.esT = S.burstGap; e.shots--;
            if (e.kind === 'hound') this.houndShot(e, player); else this.guardShot(e, player);
            if (e.shots <= 0) {
              this.releaseToken(e);
              e.cool = S.cooldown[0] + rnd() * (S.cooldown[1] - S.cooldown[0]); e.bursts++;
              // 打完一轮（六成）或两轮（四成）就换位置，否则原地等下一轮
              if (e.bursts >= 1 + (rnd() < 0.4 ? 1 : 0)) this.pickFirePos(e, player); else { e.es = 'cool'; e.esT = 0; }
            }
          }
          break;
        case 'wind':                                    // 扑击前摇：压低身体、前俯蓄力
          e.wantYaw = face; e.crouch = 0.16; e.esT -= dt;
          if (e.kind === 'hound') { e.sP.v += 3 * dt; e.jaw = damp(e.jaw, 0.5, 20, dt); }
          if (e.esT <= 0) { e.es = 'lunge'; e.esT = 0.36; e.speed = S.lungeSpeed; e.yaw = face; e.yawRate = 0; }
          break;
        case 'lunge':                                   // 扑：直线猛冲 0.36 秒，途中碰到玩家就算咬中
          e.wantYaw = face; e.maxSpeed = S.lungeSpeed; e.esT -= dt;
          if (dist < S.lungeHit && player.alive && level) {
            this.onPlayerHit(S.lungeDamage, pos);
            const [vol, pan] = this.spatial(pos);
            if (vol > MIN_VOL) audio.bark(vol, pan);
            audio.crash(vol * 0.6, pan, 0.8);
            if (e.kind === 'hound') e.sP.v -= 4;
            e.esT = 0;
          }
          if (e.esT <= 0) { e.es = 'recover'; e.esT = 0.55; e.lungeCd = S.lungeCooldown; e.speed *= 0.3; }
          break;
        case 'recover':                                 // 扑完喘 0.55 秒：这是玩家反击的机会
          e.wantYaw = face; e.esT -= dt;
          if (e.esT <= 0) this.pickFirePos(e, player);
          break;
      }
    }

    this.steer(e, dt, player, dx, dz, dist);
    this.updateLens(e, dt, t, 3.5);

    // ---- 血量低于四成：背上冒烟，偶尔迸火星
    if (e.hp < S.hp * S.smokeBelow) {
      e.smokeT -= dt;
      if (e.smokeT <= 0) {
        e.smokeT = 0.2;
        const up = e.kind === 'hound' ? 0.95 : 2.2;
        _a.set(pos.x - Math.sin(e.yaw) * 0.3, pos.y + up, pos.z - Math.cos(e.yaw) * 0.3);
        this.world.effects.puff(_a, { size: 0.35 * (e.kind === 'hound' ? 1.3 : 1.8), life: 1.3, color: 0x232528, rise: 0.9 });
        if (rnd() < 0.2) this.world.effects.sparks(_a, 0, 1, 0, 3);
      }
    }

    // ---- 姿势
    if (e.kind === 'hound') {
      if (e.es !== 'wind' && e.es !== 'lunge') e.jaw = damp(e.jaw, e.mode === 'engage' ? 0.14 : 0.02, 8, dt);
      this.animateHound(e, dt, t, looking, lookX, lookY, lookZ);
    } else {
      e.group.rotation.y = e.yaw;
      e.move = damp(e.move, clamp(e.speed / S.runSpeed, 0, 1), 7, dt);
      e.anim += dt * e.speed * 2.4;                     // 步态的相位跟着实际走过的距离走，脚才不会在地上打滑
      e.hitK = Math.max(0, e.hitK - dt * 5); e.recoil = Math.max(0, e.recoil - dt * 6);
      const rel = looking ? wrap(Math.atan2(lookX - pos.x, lookZ - pos.z) - e.yaw) : 0;
      const charge = e.es === 'tele' ? 1 - e.esT / S.telegraph : e.es === 'burst' ? 1 : 0;
      e.glow!.color.setRGB(0.4 + charge * 9, 0.08 + charge * 1.6, 0.03 + charge * 0.4);   // 炮口随着预警越来越亮
      poseGuard(e, dt, t, rel, Math.hypot(lookX - pos.x, lookZ - pos.z), lookY + 0.1, e.mode === 'engage' && e.los, charge);
    }
  }

  /**
   * 把 follow() 和状态机给出的"想朝哪转、想走多快"变成真正的位移：
   * 转向有角速度上限，速度有加减速，会被同伴和玩家挤开，走不通会换个方向试。
   */
  private steer(e: Hound | Guard, dt: number, player: Player, dx: number, dz: number, dist: number) {
    const S = e.spec, pos = e.pos, lunging = e.es === 'lunge' && e.mode === 'engage';
    const want = clamp(wrap(e.wantYaw - e.yaw) * 6, -S.turnRate, S.turnRate) * (lunging ? 2 : 1);
    e.yawRate += (want - e.yawRate) * (1 - Math.exp(-10 * dt));
    e.yaw += e.yawRate * dt;
    e.prevSpeed = e.speed;
    if (!lunging) e.speed = e.maxSpeed > e.speed ? Math.min(e.maxSpeed, e.speed + S.accel * dt) : Math.max(e.maxSpeed, e.speed - S.decel * dt);

    // 互相避让：和别的地面单位（残骸也算）靠得太近，就各自往外挤
    for (const o of this.list) {
      if (o === e || o.kind === 'gull') continue;
      const ox = pos.x - o.pos.x, oz = pos.z - o.pos.z, d = Math.hypot(ox, oz), min = S.body + o.spec.body;
      if (d < min && d > 1e-3) { const k = (((min - d) * 2.2) / d) * dt * 6; e.pushX += ox * k; e.pushZ += oz * k; }
    }
    if (!lunging && dist < S.keepOff && dist > 1e-3) { const k = (((S.keepOff - dist) * 3) / dist) * dt * 6; e.pushX -= dx * k; e.pushZ -= dz * k; }
    const decay = Math.exp(-5 * dt); e.pushX *= decay; e.pushZ *= decay;

    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
    const nx = pos.x + (fx * e.speed + e.pushX) * dt, nz = pos.z + (fz * e.speed + e.pushZ) * dt;
    // 每 0.12 秒往正前方打一条短射线，看有没有寻路网格上没有的障碍（小物件、同一格里的墙角）
    e.probeT -= dt;
    if (e.speed <= 0.3) e.blocked = false;
    else if (e.probeT <= 0) { e.probeT = 0.12; const reach = S.probe + e.speed * 0.12; e.blocked = this.ray(pos.x, pos.y + 0.55, pos.z, fx, 0, fz, reach) < reach; }
    const stuckInside = !this.walkable(pos.x, pos.z);   // 万一被挤进了不可走的格子：放它自己走出来
    if ((!this.walkable(nx, nz) && !stuckInside) || (e.blocked && (!lunging || e.esT < 0.3))) {
      if (e.blocked) {
        // 正前方有东西：只保留被挤开的那点位移，并固定往一侧拐（每个敌人拐的方向由它的随机相位决定）
        const sx = pos.x + e.pushX * dt, sz = pos.z + e.pushZ * dt;
        if (this.walkable(sx, sz)) { pos.x = sx; pos.z = sz; }
        e.yawRate += (e.phase > Math.PI ? 1 : -1) * 4 * dt;
      } else if (this.walkable(nx, pos.z)) pos.x = nx;   // 贴着障碍滑过去：只走 x 或只走 z
      else if (this.walkable(pos.x, nz)) pos.z = nz;
      e.speed *= Math.pow(0.6, dt * 60);
      e.stuckT += dt;
      if (e.stuckT > 0.5) {
        e.stuckT = 0; e.planT = 0;
        if (e.mode === 'engage' && e.es === 'move') this.pickFirePos(e, player);
        else if (e.mode === 'patrol') e.hasGoal = false;
      }
    } else { pos.x = nx; pos.z = nz; }
  }

  /** 机器狗开一枪：即时命中（没有飞行时间），打没打中当场就算。 */
  private houndShot(e: Hound, player: Player) {
    const { effects, audio, decals } = this.world, S = e.spec;
    const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
    const mx = e.pos.x + sin * HOUND_POSE.muzzleZ + cos * e.sL.x, my = e.pos.y + HOUND_POSE.muzzleY + e.sY.x - e.crouch, mz = e.pos.z + cos * HOUND_POSE.muzzleZ - sin * e.sL.x;
    let dx = player.pos.x - mx, dy = player.pos.y + player.height * 0.56 - my, dz = player.pos.z - mz;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const s = this.spread(e, S.spreadFar, S.spreadNear, 0.3);
    dx += (rnd() - 0.5) * 2 * s; dy += (rnd() - 0.5) * 2 * s; dz += (rnd() - 0.5) * 2 * s;
    const nl = Math.hypot(dx, dy, dz) || 1; dx /= nl; dy /= nl; dz /= nl;

    // 命中判定：先看这条线多远会撞墙；再求线上离玩家最近的那个点，它落在玩家的"圆柱"里、而且在墙之前，就算打中
    const wall = this.ray(mx, my, mz, dx, dy, dz, 200, _hit);
    const half = player.height / 2, cx = player.pos.x, cy = player.pos.y + half, cz = player.pos.z;
    const along = (cx - mx) * dx + (cy - my) * dy + (cz - mz) * dz;
    let end = wall, hitPlayer = false;
    if (player.alive && along > 0 && along < wall) {
      const qx = mx + dx * along, qy = my + dy * along, qz = mz + dz * along;
      if (Math.hypot(qx - cx, qz - cz) < 0.38 && Math.abs(qy - cy) < half) { hitPlayer = true; end = along; }
    }
    _a.set(mx, my, mz); _b.set(mx + dx * end, my + dy * end, mz + dz * end);
    // 曳光只画到"离镜头还有 3 米"的地方。这一枪要是擦着镜头过去（或者干脆打中了玩家），亮条离镜头只有几十厘米，
    // 透视会把它放大成一根横贯半个画面的光柱（实际截图里就是这样）。子弹该打到哪还是打到哪，下面的弹着火星照常放在真正的落点上。
    const cam = this.world.camera.position;
    const nearest = clamp((cam.x - mx) * dx + (cam.y - my) * dy + (cam.z - mz) * dz, 0, end);   // 弹道上离镜头最近的那个点，离炮口多远
    const miss = Math.hypot(mx + dx * nearest - cam.x, my + dy * nearest - cam.y, mz + dz * nearest - cam.z);
    const shown = miss < 1.5 ? Math.max(0.5, nearest - 3) : end;
    effects.tracerThin(_a, _v.set(mx + dx * shown, my + dy * shown, mz + dz * shown));
    effects.muzzleFlash(_a, dx, dy, dz, 0.9);           // 枪口焰（星芒、喷焰、几颗火星，自带一盏小灯）
    effects.flash(_a, 22, 0.05, 0xffb060, 7);           // 机器狗的炮更响：再补一盏亮度 22、照 7 米的闪光
    const [vol, pan] = this.spatial(_a);
    audio.houndShot(vol, pan);
    if (hitPlayer) this.onPlayerHit(S.shotDamage, _a);
    else if (wall < 200) {
      // 和玩家的子弹一样：打到什么材质就崩出什么（没标材质的，地面当水泥，其余当金属），并留下对应的弹孔
      const ground = _hit.ny > 0.5 && _b.y < 0.05;
      if (ground && _b.x > QUAY_X + 0.8) effects.splash(_v.set(_b.x, -1.7, _b.z), 0.8);   // 码头外的"地面"其实是海面上空：落海
      else {
        const surface = _hit.surface ?? (ground ? 'concrete' : 'metal');
        effects.impact(_b, _hit.nx, _hit.ny, _hit.nz, surface, _v.set(dx, dy, dz));
        if (surface === 'dirt' || surface === 'rubber') decals.add(_b, _hit.nx, _hit.ny, _hit.nz, 'soot', 0.2, 0.8);
        else decals.add(_b, _hit.nx, _hit.ny, _hit.nz, surface);
      }
      const [v2, p2] = this.spatial(_b);
      if (v2 > 0.55) audio.impact(v2 * 0.6, p2);
    }
    e.sP.v += 1.1; e.sY.v -= 0.25;                      // 后坐：身体点一下头、往下一坐
  }

  /** 守卫开一炮：打出一发会飞的弹丸，和无人机的一样可以躲。 */
  private guardShot(e: Guard, player: Player) {
    const S = e.spec;
    // 上身会转向玩家，炮口位置要跟着上身的朝向和俯仰算
    const ay = e.yaw + e.aimYaw, cp = Math.cos(e.aimPitch), sp = Math.sin(e.aimPitch);
    const fz = 1.24 * cp + 0.38 * sp, sa = Math.sin(ay), ca = Math.cos(ay);
    const mx = e.pos.x + 0.76 * ca + fz * sa, my = e.pos.y + 2.0 - 0.38 * cp + 1.24 * sp, mz = e.pos.z - 0.76 * sa + fz * ca;
    const fly = Math.hypot(player.pos.x - mx, player.pos.y - my, player.pos.z - mz) / GULL.boltSpeed;
    let dx = player.pos.x + player.vel.x * fly * e.lead - mx, dy = player.pos.y + player.height * 0.6 - my, dz = player.pos.z + player.vel.z * fly * e.lead - mz;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const s = this.spread(e, S.spreadFar, S.spreadNear, 0.45);
    dx += (rnd() - 0.5) * 2 * s; dy += (rnd() - 0.5) * 2 * s; dz += (rnd() - 0.5) * 2 * s;
    const nl = Math.hypot(dx, dy, dz) || 1;
    this.fireBolt(mx, my, mz, dx / nl, dy / nl, dz / nl, GULL.boltSpeed, S.shotDamage);
    e.recoil = 1;
  }

  // ------------------------------------------------------------------ 机器狗的步态

  /**
   * 对角小跑：左前 + 右后一组，右前 + 左后一组，两组轮流迈。
   * 关键在于脚的位置存的是世界坐标 —— 不迈步的脚完全不动，身体在它上面往前走，腿用 IK 跟过去，所以脚不会在地上滑。
   * 什么时候迈步？看"再过一步的时间，身体会走到哪"，脚离那时的标准落脚点偏得太多了就迈。
   */
  private gait(e: Hound, dt: number) {
    const pos = e.pos;
    const vx = Math.sin(e.yaw) * e.speed + e.pushX, vz = Math.cos(e.yaw) * e.speed + e.pushZ;
    /** 身体在 (cx, cz)、朝向 yaw 时，第 i 只脚的标准落脚点。结果写进 _home。 */
    const home = (i: number, cx: number, cz: number, yaw: number) => {
      const l = e.legs[i], s = Math.sin(yaw), c = Math.cos(yaw);
      _home.x = cx + l.homeX * c + l.homeZ * s; _home.z = cz - l.homeX * s + l.homeZ * c;
    };
    if (e.swing >= 0) {
      // ---- 有一组脚正在迈：从起点滑到落点，中途抬起来
      e.swingT += dt / e.swingDur;
      const k = Math.min(1, e.swingT), s = k * k * (3 - 2 * k);
      for (const i of TROT_PAIRS[e.swing]) {
        const f = e.feet[i];
        f.x = f.fromX + (f.toX - f.fromX) * s; f.z = f.fromZ + (f.toZ - f.fromZ) * s;
        f.y = Math.sin(Math.PI * k) * e.lift;                        // 脚走一条弧线：中途最高
      }
      if (e.swingT >= 1) {
        e.sY.v -= 0.12 + e.speed * 0.02;                             // 落脚：身体往下一顿
        if (e.speed > 0.6) { const [vol, pan] = this.spatial(pos); this.world.audio.houndStep(vol, pan, e.speed); }
        e.lastPair = e.swing; e.swing = -1;
      }
    }
    if (e.swing < 0) {
      // ---- 四脚都在地上：看要不要迈下一步（上面那组刚落地的话，这一帧就接着判断，另一组可以无缝跟上）
      const moving = e.speed > 0.15 || Math.abs(e.yawRate) > 0.25;
      e.idleT = moving ? 0 : e.idleT + dt;
      const pace = e.speed + Math.abs(e.yawRate) * 0.5;
      const dur = clamp(0.27 - pace * 0.03, 0.1, 0.27);             // 一步的时长：慢走 0.27 秒，全速 0.1 秒
      let pair = -1, worst = 0;
      for (let p = 0; p < 2; p++) {
        let err = 0;
        for (const i of TROT_PAIRS[p]) { home(i, pos.x + vx * dur, pos.z + vz * dur, e.yaw + e.yawRate * dur); err = Math.max(err, Math.hypot(e.feet[i].x - _home.x, e.feet[i].z - _home.z)); }
        if (p !== e.lastPair) err *= 1.25;                           // 偏向"上一次没迈的那组"：两组才会交替
        if (err > worst) { worst = err; pair = p; }
      }
      // 走动时偏 9 厘米就迈；站定 0.25 秒后把脚收拢到 3.5 厘米以内；刚停下的那一瞬间不动
      const threshold = moving ? 0.09 : e.idleT > 0.25 ? 0.035 : Infinity;
      if (pair >= 0 && worst > threshold) {
        e.swing = pair; e.swingT = 0; e.swingDur = dur; e.lift = 0.065 + Math.min(0.09, pace * 0.015);   // 走得越快抬脚越高
        for (const i of TROT_PAIRS[pair]) {
          const f = e.feet[i];
          f.fromX = f.x; f.fromZ = f.z;
          home(i, pos.x + vx * dur * 1.5, pos.z + vz * dur * 1.5, e.yaw + e.yawRate * dur * 1.5);         // 落点多往前探半步：落地时脚在身体前面，才有得蹬
          f.toX = _home.x; f.toZ = _home.z;
        }
      }
    }
  }

  private animateHound(e: Hound, dt: number, t: number, looking: boolean, lookX: number, lookY: number, lookZ: number) {
    this.gait(e, dt);
    // ---- 身体的弹簧：目标值很朴素（加速时点头、拐弯时侧倾、跑起来压低），有意思的晃动都来自别处给它们的"一脚"
    const accel = (e.speed - e.prevSpeed) / Math.max(dt, 1e-3);
    const lifted = (e.feet[0].y + e.feet[1].y + e.feet[2].y + e.feet[3].y) / 4;
    const drop = Math.min(HOUND_POSE.dropMax, HOUND_POSE.dropBase + e.speed * HOUND_POSE.dropPerSpeed);
    spring(e.sY, lifted * 0.45 - drop, 160, 17, dt);
    spring(e.sP, clamp(accel * 0.006, -0.07, 0.07), 130, 15, dt);
    spring(e.sR, clamp(e.yawRate * e.speed * 0.02, -0.12, 0.12), 130, 15, dt);
    spring(e.sL, 0, 110, 13, dt);
    // 天线：比身体软得多的弹簧，急停急转时甩得很夸张
    spring(e.sA, clamp(-accel * 0.03 - e.sP.x, -0.6, 0.6), 60, 5, dt);
    spring(e.sA2, clamp(e.yawRate * 0.12 - e.sR.x, -0.6, 0.6), 60, 5, dt);
    // ---- 头：有注视目标就盯着它，没有就慢慢左右张望（拐弯时先看向要拐的那边）
    let wantYaw: number, wantPitch: number;
    if (looking) {
      const hx = lookX - e.pos.x, hz = lookZ - e.pos.z;
      wantYaw = clamp(wrap(Math.atan2(hx, hz) - e.yaw), -1.2, 1.2);
      wantPitch = clamp(Math.atan2(-(lookY - (e.pos.y + HOUND_POSE.headY)), Math.hypot(hx, hz)), -0.6, 0.5);
    } else { wantYaw = Math.sin(t * 0.7 + e.phase) * 0.5 + clamp(e.yawRate * 0.25, -0.6, 0.6); wantPitch = 0.05; }
    e.headYaw = damp(e.headYaw, wantYaw, 7, dt); e.headPitch = damp(e.headPitch, wantPitch, 7, dt);
    this.poseHound(e, Math.sin(t * 1.7 + e.phase) * 0.004);
  }

  /** 把机器狗的状态（弹簧、头的角度、四只脚的位置）落实到骨骼上。活着和瘫倒共用。 */
  private poseHound(e: Hound, breath: number) {
    const b = e.bones, r = rest(b.root);
    e.group.rotation.y = e.yaw;
    // 根骨骼在后胯上，直接转它的话整条狗会绕着屁股转。我们要的是绕身体中心转，所以转完再把根骨骼挪到对应的位置
    b.root.rotation.set(e.sP.x, 0, e.sR.x);
    _v.set(0, 0, r.z).applyEuler(b.root.rotation);
    b.root.position.set(e.sL.x + _v.x, r.y + e.sY.x - e.crouch + breath + _v.y, _v.z);
    b.neck.rotation.set(e.headPitch * 0.4, e.headYaw * 0.5, 0);
    b.head.rotation.set(e.headPitch * 0.6, e.headYaw * 0.5, 0);
    b.jaw.rotation.x = e.jaw;
    b.tail1.rotation.set(e.sA.x, 0, e.sA2.x); b.tail2.rotation.set(e.sA.x * 0.6, 0, e.sA2.x * 0.6);
    for (let i = 0; i < 4; i++) solveLeg(e.legs[i], e.feet[i]);
  }

  // ------------------------------------------------------------------ 7. 死亡

  /**
   * 击毁：从这一刻起它不再算"活着"（不挡子弹、不占名额、不再攻击），击杀统计和提示也在这里触发，只触发一次。
   * 但它还留在场上，由 updateDying() 接着演完坠落 / 瘫倒。
   */
  private kill(e: Enemy, weak: boolean, dir: THREE.Vector3 | null) {
    const { effects, audio } = this.world;
    e.alive = false; e.dieT = 0; e.smokeT = 0; e.flare = 0;
    this.releaseToken(e);
    const [vol, pan] = this.spatial(e.pos);
    const sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
    if (e.kind === 'gull') {
      // 掉一只旋翼：把那根骨骼缩到几乎为零，桨叶、桨毂和转动的残影就一起"没了"（涵道环在机身上，还在）
      e.lostRotor = Math.floor(rnd() * 4);
      const rotor = e.bones['rotor' + e.lostRotor], rp = rest(rotor);
      rotor.scale.setScalar(1e-4);
      _a.set(e.pos.x + rp.x * cos + rp.z * sin, e.pos.y + 0.05, e.pos.z - rp.x * sin + rp.z * cos);
      effects.sparks(_a, 0, 1, 0, 14); effects.debris(_a, 0.5, 3); effects.puff(_a, { size: 0.5 * GULL.smoke, life: 1 });
      e.spin = (rnd() < 0.5 ? -1 : 1) * (5 + rnd() * 3);            // 自旋：每秒 5~8 弧度，方向随机
      e.vel.y += 1.5;                                                // 先被打得往上一蹿
      if (dir) e.vel.addScaledVector(dir, 2.5);                      // 再顺着子弹的方向飞出去
      e.eyeMat.color.setRGB(0.3, 0.05, 0.02);                        // 探照灯、航行灯全灭，镜头只剩一点暗红
      audio.gullDie(vol, pan);
    } else if (e.kind === 'hound') {
      e.vy = 0; e.es = 'move'; e.crouch = 0;
      e.dieRoll = (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.3);     // 最后歪向哪一侧、歪多少（14°~31°）
      e.diePitch = (rnd() - 0.5) * 0.25;
      e.sR.v += e.dieRoll * 3; e.sP.v += (rnd() - 0.5) * 2;          // 给弹簧一脚：倒下时会先晃过头再回来
      // 四只脚各自往外滑开：左右 16~36 厘米、前后 5~27 厘米。身体落下去的同时腿被这样"劈"开
      e.feet.forEach((f, i) => {
        const l = e.legs[i], out = l.side * (0.16 + rnd() * 0.2), along = l.fore * (0.05 + rnd() * 0.22) + (rnd() - 0.5) * 0.1;
        f.y = 0;                                                     // 正抬着的脚直接落地
        f.slideX = out * cos + along * sin; f.slideZ = -out * sin + along * cos;
      });
      e.swing = -1; e.speed *= 0.3;
      _a.set(e.pos.x + sin * HOUND_POSE.headZ, e.pos.y + HOUND_POSE.headY + e.sY.x, e.pos.z + cos * HOUND_POSE.headZ);
      effects.sparks(_a, 0, 1, 0, 16); effects.debris(_a, 0.55, 4);
      audio.houndDie(vol, pan);
      this.addWreck(e);
    } else {
      e.es = 'move'; e.speed = 0; e.anchor = -1; e.knelt = e.fell = false;
      e.fallSide = e.hitSide || 1;
      _a.set(e.pos.x + sin * 0.4, e.pos.y + 1.96, e.pos.z + cos * 0.4);   // 胸口的核心炸出一把火星
      effects.sparks(_a, sin, 0.6, cos, 20); effects.debris(_a, 0.7, 6);
      e.glow!.color.setRGB(0.05, 0.01, 0);
      audio.guardDie(vol, pan);
      this.addWreck(e);
    }
    this.onKill(e, weak);
  }

  /** 登记一具残骸。场上最多留 5 具，多了就让最老的那具慢慢沉进地面再回收。 */
  private addWreck(e: Enemy) {
    this.wrecks.push(e);
    if (this.wrecks.length > MAX_WRECKS) this.wrecks.shift()!.sink = 0.001;
  }

  private updateDying(e: Enemy, dt: number, t: number) {
    if (e.sink > 0) {                                   // 正在被回收：每秒下沉 0.22 米，3.2 秒后移除
      e.sink += dt; e.pos.y -= 0.22 * dt;
      if (e.sink > 3.2) this.remove(e);
      return;
    }
    e.dieT += dt;
    if (e.kind === 'gull') this.dieGull(e, dt);
    else if (e.kind === 'hound') this.dieHound(e, dt);
    else this.dieGuard(e, dt);
  }

  /** 无人机：掉了一只旋翼，一边打转一边侧翻下栽，拖着黑烟，撞到东西或落地就爆炸。没有残骸。 */
  private dieGull(e: Gull, dt: number) {
    const { effects } = this.world, pos = e.pos;
    e.vel.y -= 9.5 * dt;                                // 重力
    e.vel.x *= 1 - 0.4 * dt; e.vel.z *= 1 - 0.4 * dt;   // 一点空气阻力
    e.spin += Math.sign(e.spin) * 7 * dt;               // 越转越快：1 秒后每秒两圈左右
    e.yaw += e.spin * dt; e.roll += e.spin * 0.35 * dt; e.pitch += 0.9 * dt;
    e.group.rotation.set(e.pitch, e.yaw, e.roll);

    // 落地判定：沿速度方向打一条比"这一帧要飞的距离"略长的射线，打到东西就算撞上
    const speed = e.vel.length();
    const overSea = pos.x > QUAY_X + 0.8;               // 码头以外是海：海面比地面低 1.6 米，射线打到的"地面"不算数
    let done = e.dieT > 5 || pos.y < -1.6;
    if (!done && speed > 0.01) {
      const reach = speed * dt + 0.5;
      const d = this.ray(pos.x, pos.y, pos.z, e.vel.x / speed, e.vel.y / speed, e.vel.z / speed, reach, _hit);
      if (d < reach && !(overSea && _hit.ny > 0.5 && pos.y + (e.vel.y / speed) * d < 0.05)) {
        pos.addScaledVector(e.vel, d / speed);
        pos.x += _hit.nx * 0.2; pos.y += _hit.ny * 0.2; pos.z += _hit.nz * 0.2;
        done = true;
      }
    }
    if (!done) pos.addScaledVector(e.vel, dt);

    // 剩下的三只旋翼越转越慢
    const slow = 30 * Math.max(0.2, 1 - e.dieT * 0.5) * dt;
    for (let i = 0; i < 4; i++) if (i !== e.lostRotor) e.bones['rotor' + i].rotation.y += (i % 3 === 0 ? 1 : -1) * slow;

    // 拖烟：每 0.045 秒一团，连成一条黑烟尾迹；一半的时候再迸几颗火星
    e.smokeT -= dt;
    if (e.smokeT <= 0) {
      e.smokeT = 0.045;
      effects.puff(pos, { size: 0.45 * GULL.smoke, life: 1.3, color: 0x15161a, rise: 0.6 });
      if (rnd() < 0.5) effects.sparks(pos, rnd() - 0.5, rnd(), rnd() - 0.5, 3);
    }

    if (done) {
      if (pos.y < -1 && overSea) effects.splash(_a.set(pos.x, -1.7, pos.z), 2.2);
      this.explode(pos, GULL.explodeRadius, GULL.explodeDamage, 1.2);
      this.remove(e);
    }
  }

  /**
   * 机器狗：腿一软、身体砸在地上、四腿劈开、歪向一侧，镜头闪几下熄灭；然后冒烟打火花 6.5 秒，成为静止的残骸。
   * 时间线：0 秒迸火星 → 约 0.4 秒身体砸地 → 0.8 秒歪倒到位 → 1.2 秒镜头熄灭 → 2.2 秒姿势定格 → 6.5 秒烟停。
   */
  private dieHound(e: Hound, dt: number) {
    const { effects, audio } = this.world, pos = e.pos, D = e.dieT;
    if (D < 2.2) {
      // ---- 身体下落：前 0.12 秒只有三成重力（腿"软"一下），然后自由落体，砸到地上弹一小下
      e.vy -= 9.8 * dt * (D < 0.12 ? 0.3 : 1);
      e.sY.x += e.vy * dt;
      if (e.sY.x < HOUND_POSE.collapse) {
        e.sY.x = HOUND_POSE.collapse;
        if (e.vy < -1.2) {
          const [vol, pan] = this.spatial(pos);
          audio.crash(vol, pan);
          for (let i = 0; i < 8; i++) { const a = (i + rnd()) * 0.785; effects.puff(_a.set(pos.x + Math.cos(a) * 0.3, 0.1, pos.z + Math.sin(a) * 0.3), { size: 0.6, life: 0.8, color: 0x7f7a73, rise: 0.15, count: 1, alpha: 0.3, vx: Math.cos(a) * 2.5, vz: Math.sin(a) * 2.5 }); }
        }
        e.vy = -e.vy * 0.22;
      }
      // ---- 歪向一侧（弹簧比活着时软，会晃过头一点再回来）
      spring(e.sP, e.diePitch, 60, 9, dt); spring(e.sR, e.dieRoll, 60, 9, dt); spring(e.sL, 0, 40, 8, dt);
      spring(e.sA, 0, 60, 5, dt); spring(e.sA2, 0, 60, 5, dt);
      // ---- 脚往外滑开：每帧走掉剩余距离的一部分，先快后慢
      const g = Math.exp(-3.2 * dt);
      for (const f of e.feet) { f.x += f.slideX * (1 - g); f.z += f.slideZ * (1 - g); f.slideX *= g; f.slideZ *= g; }
      // 带着原来三成的速度往前蹭一小段
      pos.x += Math.sin(e.yaw) * e.speed * dt; pos.z += Math.cos(e.yaw) * e.speed * dt; e.speed *= Math.exp(-5 * dt);
      // 头垂下去、歪向倒下的那一侧，下巴松开
      e.headPitch += (HOUND_POSE.headDroop - e.headPitch) * (1 - Math.exp(-5 * dt));
      e.headYaw += (e.dieRoll - e.headYaw) * (1 - Math.exp(-3 * dt));
      e.jaw = damp(e.jaw, 0.06, 4, dt);
      // 镜头：约每秒 9.5 次的红光闪烁，1.2 秒内越闪越暗，最后几乎全灭
      const k = D < 1.2 ? (Math.sin(D * 60) > 0.2 ? 1 - D / 1.2 : 0.05) : 0.02;
      e.eyeMat.color.setRGB(6 * k + 0.05, 0.6 * k + 0.01, 0.2 * k);
      // 外壳慢慢熏黑
      e.bodyMat.color.lerp(_scorched, 1 - Math.exp(-0.9 * dt));
      this.poseHound(e, 0);
    }
    if (D < 6.5) {
      // ---- 冒烟、打火花：前 2 秒很浓，之后稀下来；前 3.5 秒偶尔窜一下小火苗
      e.smokeT -= dt;
      if (e.smokeT <= 0) {
        e.smokeT = D < 2 ? 0.09 : 0.2;
        _a.set(pos.x + (rnd() - 0.5) * 0.5, pos.y + 0.5, pos.z + (rnd() - 0.5) * 0.5);
        effects.puff(_a, { size: (0.5 + rnd() * 0.3) * 1.3, life: 1.8, color: 0x17181b, rise: 1.1 });
        if (D < 4 && rnd() < 0.55) effects.sparks(_a, rnd() - 0.5, 1, rnd() - 0.5, D < 1 ? 8 : 3);
        if (D < 3.5 && rnd() < 0.4) effects.puff(_a, { size: 0.3, life: 0.45, color: 0xff7a22, rise: 1.6, count: 1, fire: true });
      }
    } else e.wreck = true;
  }

  /**
   * 守卫（参考里没有，照同样的风格自己编的）：膝盖一软跪下去 → 停一下 → 整个上身往前扑倒 → 冒烟 → 残骸。
   * 做法是"摆姿势 + 落地"两步：先按时间把各个关节转到该在的角度，再用 settle() 找出全身最低的接触点、把整副骨架放到地面上。
   * 这样不用自己算"跪下去屁股该多高、趴下去胸口该多高"，哪儿先着地它就自然地搁在哪儿。
   */
  private dieGuard(e: Guard, dt: number) {
    const { effects, audio } = this.world, pos = e.pos, D = e.dieT, b = e.bones;
    if (D < 2.4) {
      const kneel = Math.min(1, D / 0.45) ** 2;                      // 跪下的进度：平方 = 越落越快，像被重力拉下去
      const u = clamp((D - 0.75) / 0.8, 0, 1), fall = Math.pow(u, 2.4);   // 扑倒的进度：开头很慢（晃了一下），然后加速
      // 砸地之后的一小下回弹
      const bounce = D > 1.55 ? Math.sin(Math.min(1, (D - 1.55) / 0.3) * Math.PI) * 0.05 * Math.exp(-(D - 1.55) * 3) : 0;
      // 下面的角度都是"这一段肢体在侧视图里朝哪"：0 = 竖直向下，正 = 往后摆
      const thigh = THIGH_REST + kneel * (-0.25 - THIGH_REST) + fall * 1.5;     // 大腿：站直 → 略微前伸（跪直，胯在膝盖正上方）→ 上身扑倒时被带到身后
      const shinTurn = kneel * 1.9;                                             // 小腿从竖直一路转到"膝盖着地、脚踝翘在后上方"
      const lean = 0.22 * kneel + fall * 1.2 - bounce;                          // 胯（根骨骼）往前倾多少：跪下时就有点前倾，重心在膝盖前面，所以接着会往前扑
      // 骨骼的转角是"相对父骨骼"的，所以每一级都要减去上一级已经转过的量
      for (const id of ['legL', 'legR']) {
        const skew = (id === 'legL' ? 0.09 : -0.09) * e.fallSide * kneel;       // 两条腿错开一点，别像阅兵一样整齐
        b[id + '1'].rotation.x = thigh + skew - THIGH_REST - lean;
        b[id + '2'].rotation.x = shinTurn - (thigh + skew - THIGH_REST);
        // 脚踝先是软的：小腿往前倒的头 0.6 弧度里脚掌还平踩在地上；再往后就僵住了，脚跟被带起来，最后只剩脚尖点地
        b[id + '3'].rotation.x = -Math.min(shinTurn, 0.6);
      }
      b.root.rotation.set(lean, 0, 0.1 * fall * e.fallSide);
      b.torso.rotation.set(0.25 * kneel * (1 - fall), e.aimYaw * (1 - kneel), 0);
      b.torso.position.y = rest(b.torso).y;
      b.head.rotation.set(0.5 * kneel - 0.6 * fall, 0.8 * fall * e.fallSide, 0);   // 先垂头；趴下后脸偏向一侧
      b.armR1.rotation.x = -e.aimPitch * (1 - kneel) + 0.15 * kneel;                // 炮臂垂下
      b.gun.rotation.x = -1.3 * fall;                                                // 扑倒时炮管甩到头的方向，贴着地面
      b.gun.position.z = rest(b.gun).z;
      b.armL1.rotation.set(-0.5 * e.guardK * (1 - kneel) + 0.1 * kneel, 0, -0.5 * kneel - 0.5 * fall);   // 护盾臂往外摊开
      // 护盾有一米多高，跪下去时它的下沿会先杵到地上把整个身子撑住。所以跪的时候前臂把盾往前上方托平，扑倒时再放下来、压在身侧
      b.armL2.rotation.set(-0.25 * e.guardK * (1 - kneel) - 1.2 * kneel * (1 - fall), 0.45 * e.guardK * (1 - kneel), 0);
      const r = rest(b.root);
      b.root.position.set(r.x, r.y, r.z);
      // 跪的时候脚尖钉在原地（胯往前下方落）；扑倒的时候膝盖钉在原地（上身以膝盖为轴翻过去）
      this.settle(e, D < 0.75 ? 0 : 1);

      if (!e.knelt && D >= 0.45) {
        e.knelt = true;
        const [vol, pan] = this.spatial(pos);
        audio.crash(vol, pan, 1.3);
        effects.dust(_a.set(pos.x + Math.sin(e.yaw) * 0.5, 0.05, pos.z + Math.cos(e.yaw) * 0.5), 0, 1, 0, 3);
      }
      if (!e.fell && D >= 1.55) {
        e.fell = true;
        const [vol, pan] = this.spatial(pos);
        audio.crash(vol, pan, 1.7);
        const fx = pos.x + Math.sin(e.yaw) * 1.4, fz = pos.z + Math.cos(e.yaw) * 1.4;
        for (let i = 0; i < 10; i++) { const a = (i + rnd()) * 0.628; effects.puff(_a.set(fx + Math.cos(a) * 0.5, 0.12, fz + Math.sin(a) * 0.5), { size: 0.9, life: 1, color: 0x7f7a73, rise: 0.15, count: 1, alpha: 0.3, vx: Math.cos(a) * 3.2, vz: Math.sin(a) * 3.2 }); }
        effects.sparks(_a.set(fx, 0.3, fz), 0, 1, 0, 14);
        const p = this.player;
        if (p) p.addShake(clamp(1 - p.pos.distanceTo(pos) / 14, 0, 1) * 0.3);       // 两百多公斤的铁疙瘩砸在地上，近处能感到一震
      }
      const k = D < 1.4 ? (Math.sin(D * 60) > 0.2 ? 1 - D / 1.4 : 0.05) : 0.02;
      e.eyeMat.color.setRGB(6 * k + 0.05, 0.6 * k + 0.01, 0.2 * k);
      e.bodyMat.color.lerp(_scorched, 1 - Math.exp(-0.9 * dt));
    }
    if (D < 7.5) {
      e.smokeT -= dt;
      if (e.smokeT <= 0) {
        e.smokeT = D < 2.5 ? 0.09 : 0.2;
        // 烟从背包那儿冒出来：背包跟着上身一起倒下去了，所以取上身骨骼此刻的世界位置
        _a.set(0, 0.45, -0.35).applyMatrix4(b.torso.matrixWorld);
        _a.x += (rnd() - 0.5) * 0.5; _a.z += (rnd() - 0.5) * 0.5;
        effects.puff(_a, { size: (0.5 + rnd() * 0.3) * 1.8, life: 2, color: 0x17181b, rise: 1.2 });
        if (D < 4.5 && rnd() < 0.55) effects.sparks(_a, rnd() - 0.5, 1, rnd() - 0.5, D < 1 ? 8 : 3);
        if (D < 4 && rnd() < 0.4) effects.puff(_a, { size: 0.4, life: 0.5, color: 0xff7a22, rise: 1.6, count: 1, fire: true });
      }
    } else e.wreck = true;
  }

  /**
   * 把守卫的骨架"放到地上"：在全身挑一批可能着地的点（脚、膝盖、胸口、头、炮口、护盾四角……），
   * 找出此刻最低的那个，整体上下挪到它正好贴地。anchor 指定哪组关节在前后方向上钉住不动（0 = 脚尖，1 = 膝盖）。
   */
  private settle(e: Guard, anchor: number) {
    const b = e.bones, sin = Math.sin(e.yaw), cos = Math.cos(e.yaw);
    e.group.rotation.y = e.yaw;
    e.group.updateMatrixWorld(true);
    let low = Infinity;
    for (const [bone, x, y, z, r] of GUARD_CONTACTS) low = Math.min(low, _v.set(x, y, z).applyMatrix4(b[bone].matrixWorld).y - r);
    b.root.position.y += e.pos.y - low;
    // 钉住的那组关节现在在身体前后方向上的位置（两条腿取平均）
    let along = 0;
    for (const name of anchor === 0 ? GUARD_TOES : GUARD_KNEES) { _v.setFromMatrixPosition(b[name].matrixWorld); along += ((_v.x - e.pos.x) * sin + (_v.z - e.pos.z) * cos) / 2; }
    if (e.anchor !== anchor) { e.anchor = anchor; e.anchorZ = along; }   // 刚换成钉这一组：记下它此刻的位置
    b.root.position.z += e.anchorZ - along;
    e.group.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ 8. 弹丸与爆炸

  private fireBolt(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, dmg: number) {
    const b = this.bolts.find((k) => !k.live);
    if (!b) return;
    b.live = true; b.x = b.fromX = x; b.y = b.fromY = y; b.z = b.fromZ = z; b.dx = dx; b.dy = dy; b.dz = dz;
    b.speed = speed; b.dmg = dmg; b.life = 1.3; b.len = 0; b.whizzed = false;
    _a.set(x, y, z);
    const [vol, pan] = this.spatial(_a);
    if (vol > MIN_VOL) this.world.audio.enemyShot(vol, pan);
    this.world.effects.muzzleFlash(_a, dx, dy, dz, 0.55);   // 炮口焰，比机器狗的小一号（自带的灯也按比例小：亮度 8.8，照 3.85 米）
  }

  private updateBolts(dt: number, player: Player) {
    const { effects, audio, decals } = this.world;
    // 玩家的身体当成一根竖着的线段：脚底往上 0.35 米到胸口（蹲着就矮一截）
    const px = player.pos.x, pz = player.pos.z, py0 = player.pos.y + 0.35, py1 = player.pos.y + (player.crouching ? 1.0 : 1.5);
    for (let i = 0; i < MAX_BOLTS; i++) {
      const b = this.bolts[i];
      if (!b.live) continue;
      const step = b.speed * dt;
      // 这一帧要飞过的这一小段：先看会不会撞到场景，travel 是实际能飞的距离
      const travel = this.ray(b.x, b.y, b.z, b.dx, b.dy, b.dz, step, _hit);
      const ex = b.x + b.dx * travel, ey = b.y + b.dy * travel, ez = b.z + b.dz * travel;
      // 弹丸一帧能飞一米多，只看"此刻离玩家多远"会直接穿过去。所以判的是这一小段线段到玩家身体线段的最近距离
      const d2 = segSegDist2(b.x, b.y, b.z, ex, ey, ez, px, py0, pz, px, py1, pz);
      b.life -= dt;
      if (player.alive && d2 < 0.36 * 0.36) {
        this.onPlayerHit(b.dmg, _a.set(b.fromX, b.fromY, b.fromZ));
        b.live = false;
      } else if (travel < step) {
        _a.set(ex, ey, ez);
        const sea = _hit.ny > 0.5 && ey < 0.05 && ex > QUAY_X + 0.8;   // 打到码头外的"地面" = 其实是落海
        if (sea) effects.splash(_b.set(ex, -1.7, ez), 0.8);
        else {
          effects.sparks(_a, _hit.nx, _hit.ny, _hit.nz, 5);
          decals.add(_a, _hit.nx, _hit.ny, _hit.nz, 'soot', 0.45);   // 能量弹不打洞，只烧出一块发黑的印子
          const [vol, pan] = this.spatial(_a);
          if (vol > 0.5) audio.impact(vol, pan);
        }
        b.live = false;
      } else if (b.life <= 0) b.live = false;
      else {
        b.x = ex; b.y = ey; b.z = ez; b.len = Math.min(1.5, b.len + step);
        // 擦身而过（离玩家头部 3.2 米以内、而且已经开始远离）：响一声呼啸
        if (!b.whizzed) {
          const hx = px - b.x, hy = py1 - b.y, hz = pz - b.z;
          if (hx * b.dx + hy * b.dy + hz * b.dz < 0 && Math.hypot(hx, hy, hz) < 3.2) { b.whizzed = true; audio.whiz(this.spatial(_a.set(b.x, b.y, b.z))[1]); }
        }
      }
      if (b.live) {
        // 画成一根沿飞行方向拉长的亮条：刚出膛时很短，飞起来以后最长 1.5 米
        _q.setFromUnitVectors(_z, _v.set(b.dx, b.dy, b.dz));
        this.boltMesh.setMatrixAt(i, _m.compose(_a.set(b.x, b.y, b.z), _q, _s.set(1, 1, Math.max(0.2, b.len))));
      } else this.boltMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.boltMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 爆炸：特效 + 范围伤害。离爆心越远伤害越低（线性降到 radius 处为 0），被墙挡住的不受伤。
   * 敌人吃全额，玩家吃一半。爆炸声会把 30 米内的敌人都引过来。
   */
  private explode(at: THREE.Vector3, radius: number, damage: number, size: number) {
    const { effects, audio, decals, colliders } = this.world;
    const c = _boom.copy(at);                           // 复制一份：at 可能是马上要被回收的敌人的位置
    effects.explosion(c, size);
    const [vol, pan] = this.spatial(c);
    if (vol > MIN_VOL) audio.explode(vol, pan);
    const ground = this.surfaceBelow(c.x, c.y + 0.3, c.z);
    if (c.y - ground < 1.4 * size && c.x < QUAY_X + 0.8) decals.add(_a.set(c.x, ground, c.z), 0, 1, 0, 'scorch', 2.3 * size, 0.92);   // 离地近：地上留一块焦痕，直径是爆炸规模的 2.3 倍
    for (const o of this.list) {
      if (!o.alive) continue;
      const oy = o.pos.y + (o.kind === 'gull' ? 0 : o.spec.eyeY * 0.6);
      const d = Math.hypot(o.pos.x - c.x, oy - c.y, o.pos.z - c.z);
      if (d >= radius || colliders.blocked(c.x, c.y, c.z, o.pos.x, oy, o.pos.z)) continue;
      _dir.set(o.pos.x - c.x, oy - c.y, o.pos.z - c.z).multiplyScalar(1 / Math.max(d, 1e-3));
      this.damage(o, damage * (1 - d / radius), false, _dir);
    }
    const p = this.player;
    if (p && p.alive) {
      const d = Math.hypot(p.pos.x - c.x, p.pos.y + 1 - c.y, p.pos.z - c.z);
      if (d < radius && !colliders.blocked(c.x, c.y, c.z, p.pos.x, p.pos.y + 1, p.pos.z)) this.onPlayerHit(damage * 0.5 * (1 - d / radius), c);
      p.addShake(clamp(1 - d / (14 + size * 10), 0, 1) * (0.35 + 0.35 * size));   // 离得越近震得越厉害
    }
    this.alert(c, 30);
  }
}

// ---------------------------------------------------------------------------
// 小工具

const rnd = Math.random;
/** 把角度折回 (-π, π]。两个朝向相减之后用它，得到"最短要转多少、往哪边转"。 */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const rest = (b: THREE.Bone) => b.userData.rest as THREE.Vector3;

/**
 * 弹簧：s.x 被拉向 target，k 是劲度（越大回得越快），c 是阻尼（越大晃得越少）。
 * 想让身体"挨一下"只要给 s.v 加一个冲量，之后它会自己晃几下停下来 —— 机器狗所有的受击、后坐、落脚反应都是这么来的。
 */
function spring(s: Spring, target: number, k: number, c: number, dt: number) {
  s.v += ((target - s.x) * k - s.v * c) * dt;
  s.x += s.v * dt;
}

/** 射线和球求交，返回射线上的距离；没交到返回 Infinity。d 必须是单位向量。 */
function raySphere(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, r: number) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

/**
 * 射线和"压扁的球"求交：水平半径 rh、竖直半径 rv。
 * 做法：把空间在竖直方向上拉伸 rh / rv 倍，椭球就变回了正球，再按球来解。拉伸不改变射线参数 t 的含义，所以解出来的 t 可以直接用。
 */
function rayEllipsoid(o: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, rh: number, rv: number) {
  const k = rh / rv;
  const ox = o.x - cx, oy = (o.y - cy) * k, oz = o.z - cz, dy = d.y * k;
  const a = d.x * d.x + dy * dy + d.z * d.z;            // 拉伸之后方向不再是单位向量，所以要解完整的二次方程
  const b = ox * d.x + oy * dy + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - rh * rh;
  const disc = b * b - a * c;
  if (disc < 0 || a < 1e-9) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t > 0 ? t : Infinity;
}

/** 两条线段（p1→q1 和 p2→q2）之间最近距离的平方。 */
function segSegDist2(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number, p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z, d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;                                     // s、t：最近点分别在两条线段上的位置（0 = 起点，1 = 终点）
  if (a > 1e-9 && e > 1e-9) {
    const b = d1x * d2x + d1y * d2y + d1z * d2z, c = d1x * rx + d1y * ry + d1z * rz, den = a * e - b * b;
    s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
  } else if (a > 1e-9) s = clamp(-(d1x * rx + d1y * ry + d1z * rz) / a, 0, 1);
  else if (e > 1e-9) t = clamp(f / e, 0, 1);
  const x = p1x + d1x * s - p2x - d2x * t, y = p1y + d1y * s - p2y - d2y * t, z = p1z + d1z * s - p2z - d2z * t;
  return x * x + y * y + z * z;
}

// ---------------------------------------------------------------------------
// 9. 姿势函数：每帧根据敌人的状态算出每根骨骼该转多少。
// 约定：rotation.x 为正 = 向下的肢体往后摆 / 朝前的部件往下低头。

// ---- 机器狗的腿

const HOUND_LEG_IDS = ['fl', 'fr', 'bl', 'br'];
/** 对角的两条腿一组：左前 + 右后、右前 + 左后（数字是 HOUND_LEG_IDS 的下标）。 */
const TROT_PAIRS = [[0, 3], [1, 2]];
/** 一段肢体在侧视图里的倾角：0 = 竖直向下，正 = 往后（-z）偏。 */
const slant = (y: number, z: number) => Math.atan2(-z, -y);

/** 生成时把四条腿的尺寸量好：以后每帧做 IK 只用这些数，不用再去翻骨骼。 */
function houndLegs(bones: Record<string, THREE.Bone>): Leg[] {
  return HOUND_LEG_IDS.map((id) => {
    const hip = bones[id + '1'], knee = bones[id + '2'], ankle = bones[id + '3'];
    // 每根骨骼的 rest 是它相对父骨骼的偏移，也就是上一段肢体的向量：膝的 rest = 大腿，踝的 rest = 小腿，脚尖的 rest = 脚
    const thigh = rest(knee), shin = rest(ankle), foot = rest(bones[id + 'T']);
    hip.rotation.order = 'ZXY';                         // 先前后摆（x），再绕身体的前后轴往外撇（z）
    // 髋关节在模型里的位置：从它一路加到根骨骼
    let hx = 0, hz = 0;
    for (let b: THREE.Object3D | null = hip; b && (b as THREE.Bone).isBone; b = b.parent) { hx += rest(b as THREE.Bone).x; hz += rest(b as THREE.Bone).z; }
    const homeX = hx + thigh.x + shin.x + foot.x, homeZ = hz + thigh.z + shin.z + foot.z;
    const thighRest = slant(thigh.y, thigh.z);
    return {
      hip, knee, ankle,
      thighLen: Math.hypot(thigh.y, thigh.z), shinLen: Math.hypot(shin.y, shin.z),
      thighRest, shinRest: slant(shin.y, shin.z),
      footY: foot.y, footZ: foot.z,
      // 大腿比"髋 → 踝"的连线更往后斜，说明膝盖是朝后顶的（前腿）；反过来就是朝前顶的（后腿）
      bend: thighRest > slant(thigh.y + shin.y, thigh.z + shin.z) ? 1 : -1,
      homeX, homeZ, side: Math.sign(homeX), fore: Math.sign(homeZ),
    };
  });
}

/**
 * 腿的反向运动学（IK）：已知脚要踩在世界里的哪个点，反过来求髋、膝、踝各转多少。
 *   1. 把脚的目标点换算到髋关节所在的坐标系里（身体怎么歪、怎么蹲都已经算在里面了）；
 *   2. 从正面看，脚偏在髋的外侧多少，就让整条腿往外撇多少（abduct）—— 撇完之后，腿就在一个竖着的平面里；
 *   3. 在这个平面里，大腿、小腿和"髋到踝的连线"组成一个三角形，三条边都知道，用余弦定理解出两个角；
 *   4. 踝关节反着转回来，让脚保持原来的朝向。
 * 够不着就伸到 99.5%，太近就夹到最紧，所以怎么都有解。
 */
function solveLeg(leg: Leg, foot: Foot) {
  const p = leg.hip.parent!.worldToLocal(_v.set(foot.x, foot.y, foot.z));
  const tx = p.x - leg.hip.position.x, ty = p.y - leg.hip.position.y, tz = p.z - leg.hip.position.z;
  const abduct = clamp(Math.atan2(tx, -ty), -1.45, 1.45);
  const down = Math.hypot(tx, ty);                      // 在腿的平面里，脚在髋下方多远
  const ay = -down - leg.footY, az = tz - leg.footZ;    // 踝关节的目标 = 脚底的目标减去"踝 → 脚底"这一小段
  const reach = clamp(Math.hypot(ay, az), Math.abs(leg.thighLen - leg.shinLen) + 0.03, (leg.thighLen + leg.shinLen) * 0.995);
  const line = slant(ay, az);                           // "髋 → 踝"连线的倾角
  const a = leg.thighLen, c = leg.shinLen;
  const atHip = Math.acos(clamp((a * a + reach * reach - c * c) / (2 * a * reach), -1, 1));   // 三角形在髋处的内角
  const atKnee = Math.acos(clamp((a * a + c * c - reach * reach) / (2 * a * c), -1, 1));       // 在膝处的内角（伸直时是 π）
  const thigh = line + leg.bend * atHip, shin = thigh - leg.bend * (Math.PI - atKnee);
  const r1 = thigh - leg.thighRest, r2 = shin - leg.shinRest - r1;
  leg.hip.rotation.set(r1, 0, abduct);
  leg.knee.rotation.x = r2;
  leg.ankle.rotation.x = -(r1 + r2);
}

// ---- 守卫

const GUARD_TIPS = ['legLT', 'legRT'], GUARD_TOES = ['legLT', 'legRT'], GUARD_KNEES = ['legL2', 'legR2'];
/** 守卫大腿、小腿在绑定姿势下的倾角（由骨架里髋、膝、踝的位置算出来）。 */
const THIGH_REST = slant(-0.54, 0.07), SHIN_REST = slant(-0.53, -0.1);
/**
 * 守卫倒地时可能着地的点：[骨骼, 相对这根骨骼关节的 x, y, z, 这个点周围零件的半径]。
 * 坐标是照着 rig.ts 里守卫的零件位置抄的（零件位置减去骨骼关节的位置）。
 */
const GUARD_CONTACTS: [string, number, number, number, number][] = [
  ['legL3', 0, -0.15, 0.42, 0], ['legL3', 0, -0.15, -0.27, 0], ['legR3', 0, -0.15, 0.42, 0], ['legR3', 0, -0.15, -0.27, 0],   // 脚掌的前后两端
  ['legL3', 0, 0, 0, 0.11], ['legR3', 0, 0, 0, 0.11],                                                                         // 脚踝
  ['legL2', 0, 0, 0.1, 0.17], ['legR2', 0, 0, 0.1, 0.17],                                                                     // 膝盖（带护膝）
  ['root', 0, 0, 0, 0.2],                                                                                                     // 胯
  ['torso', 0, 0.5, 0.37, 0.03], ['torso', 0.3, 0.56, 0.28, 0.05], ['torso', -0.3, 0.56, 0.28, 0.05], ['torso', 0, 0.2, 0.2, 0.03],   // 胸甲、腹部
  ['head', 0, 0.22, 0.28, 0.03], ['head', 0, 0.4, 0, 0.05],                                                                   // 脸、头顶
  ['armL1', 0, 0.04, 0, 0.25], ['armR1', 0, 0.04, 0, 0.25],                                                                   // 两个肩甲
  ['gun', 0, -0.02, 1.12, 0.1], ['gun', 0, -0.16, 0.3, 0.02], ['gun', 0, 0.14, 0.3, 0.05],                                    // 炮口、炮身
  ['armL2', 0.28, 0.42, 0.44, 0.04], ['armL2', -0.32, 0.42, 0.44, 0.04], ['armL2', 0.28, -0.62, 0.44, 0.04], ['armL2', -0.32, -0.62, 0.44, 0.04],   // 护盾四角
];

/** 摆完姿势后把身体整体上下挪一下，让最低的那只脚正好踩在地面上。 */
function plant(e: Guard, tips: string[]) {
  e.group.updateMatrixWorld(true);
  let min = Infinity;
  for (const k of tips) min = Math.min(min, e.bones[k].matrixWorld.elements[13]);
  e.bones.root.position.y += e.pos.y - min;
}

/**
 * 守卫活着时的姿势。rel 是注视目标相对它正前方的偏角，dist / targetY 是目标的水平距离和高度；
 * aiming = 正盯着玩家（上身转过去、举盾）；brace = 0..1，预警和连发时压低重心。
 */
function poseGuard(e: Guard, dt: number, t: number, rel: number, dist: number, targetY: number, aiming: boolean, brace: number) {
  const b = e.bones, m = e.move, ph = e.anim;
  e.aimYaw = damp(e.aimYaw, aiming ? clamp(rel, -0.8, 0.8) : 0, 6, dt);
  e.aimPitch = damp(e.aimPitch, aiming ? clamp(Math.atan2(targetY - (e.pos.y + 2.0), Math.max(dist, 0.5)), -0.5, 0.6) : -0.25, 6, dt);
  e.guardK = damp(e.guardK, aiming ? 1 : 0, 4, dt);
  for (const [id, off] of [['legL', 0], ['legR', Math.PI]] as [string, number][]) {
    const p = ph + off, th = m * 0.5 * Math.sin(p) - brace * 0.1, kn = m * Math.max(0, -Math.cos(p)) * 0.95 + brace * 0.22;
    b[id + '1'].rotation.x = th; b[id + '2'].rotation.x = kn; b[id + '3'].rotation.x = -(th + kn) * 0.8;
  }
  b.root.rotation.set(0, m * Math.sin(ph) * 0.07, m * Math.sin(ph) * 0.035);
  b.torso.rotation.y = e.aimYaw - b.root.rotation.y;
  b.torso.rotation.x = m * 0.05 + brace * 0.1 - e.hitK * 0.12 - e.recoil * 0.03;
  b.torso.rotation.z = e.hitK * 0.09 * e.hitSide - b.root.rotation.z;
  b.torso.position.y = rest(b.torso).y + Math.sin(t * 1.7 + e.phase) * 0.008;
  b.head.rotation.y = clamp(rel - e.aimYaw, -0.7, 0.7);
  b.head.rotation.x = -e.aimPitch * 0.6 + e.hitK * 0.15;
  b.armR1.rotation.x = -e.aimPitch - e.recoil * 0.07;
  b.gun.position.z = rest(b.gun).z - e.recoil * 0.16;
  // 左臂：盯着玩家时把护盾举到身前，否则随步伐摆动
  b.armL1.rotation.x = -0.5 * e.guardK + (1 - e.guardK) * m * Math.sin(ph + Math.PI) * 0.3;
  b.armL2.rotation.x = -0.25 * e.guardK; b.armL2.rotation.y = 0.45 * e.guardK;
  const r = rest(b.root);
  b.root.position.set(r.x + m * Math.sin(ph) * 0.04, r.y, r.z);
  plant(e, GUARD_TIPS);
}

const _hit: RayHit = { t: 0, nx: 0, ny: 0, nz: 0 };
const _home = { x: 0, z: 0 };
const _scorched = new THREE.Color(0x4a4744);
const _z = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _right = new THREE.Vector3();
const _boom = new THREE.Vector3(), _dir = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
