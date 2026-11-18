import * as THREE from 'three';
import type { Colliders } from './colliders';
import { placeOnce } from './propfield';
import { RELAY_COLORS, relayCabinet, relayParts } from './props/site';

// 中继柜：任务目标。玩家要走到三只柜子跟前，按住交互键把它们一只一只切断。
//
// 柜子的造型在 props/site.ts（relayCabinet）：它特意把指示灯、左门、抛物面天线留成了可以单独操纵的零件。
// 这个文件管剩下的两件事：
//   1. 把柜子摆到地图上、登记碰撞盒（buildRelay）；
//   2. 柜子的"状态机" —— 它有三种状态，每种状态下灯、天线、柜门各有各的动法（数值全部照参考）：
//
//        正常（live）       琥珀色的灯慢慢地一呼一吸；天线匀速转
//        切断中（cutting）  玩家正按着交互键：灯每秒急闪五六下，亮的那半拍颜色发白；天线忽快忽慢地乱转
//        已切断（cut）      灯变红，先猛亮一下，然后抽搐着暗下去直到全灭；天线慢慢停住；左门"砰"地弹开，晃两下
//
// 玩家不用看 HUD，光看柜子就知道"我按对了""它断了"。任务逻辑（game/mission.ts）只管告诉柜子现在该是哪种状态。

/** 一处中继摆在哪、叫什么。 */
export interface RelaySpec {
  /** 全名，切断时显示在消息栏里。 */
  name: string;
  /** 简称（甲 / 乙 / 丙）：HUD 标记和提示用，也喷在柜门上。 */
  short: string;
  x: number; z: number;
  /** 柜子脚下的地面有多高。车间里的地坪比外面高 3 厘米；不写就是 0。 */
  y?: number;
  /** 绕竖轴转多少弧度。柜门原本朝 +z（南）；转了 yaw 以后朝 (sin yaw, cos yaw)。 */
  yaw: number;
  /** 摆在屋里（淋不到雨，反射的是屋里的环境）。 */
  interior?: boolean;
}

export interface Relay {
  id: number; name: string; short: string;
  /** 柜子脚下的位置。HUD 标记、"玩家够不够得着"、开局的巡逻兵守在哪，都以它为准。 */
  pos: THREE.Vector3;
  cut: boolean;
  /** 玩家开始按着交互键切它（true），或者松手、走开了（false）。已经切断的柜子不理会。 */
  setCutting(on: boolean): void;
  /** 切断：灯变红熄灭、天线停转、左门弹开。 */
  setCut(): void;
  /** 重新开局：恢复成正常状态，门关好。 */
  reset(): void;
  /** 每帧调一次。t 是游戏的绝对时间（秒）；两次调用之间隔了多久由它自己算。 */
  update(t: number): void;
}

type State = 'live' | 'cutting' | 'cut';

// ---- 灯的亮度。指示灯是"发光体"（见 site.ts 的 relayLampMaterial）：颜色 × 亮度直接写进材质，
//      超过 1 的部分由后处理的泛光晕开，所以亮度越大，灯周围那圈光晕越大
const LIVE = { glow: 5.5, swing: 3, rate: 2.2, spin: 0.7 };          // 亮度 = 5.5 ± 3，每 2.9 秒呼吸一次（2π / 2.2）；天线每秒转 0.7 弧度
const CUTTING = { hz: 5.5, on: 9, off: 0.5, spin: 2.6, spinSwing: 1.5, spinRate: 9 }; // 每秒闪 5.5 下：亮 9 / 暗 0.5；天线转速在 1.1~4.1 之间来回甩
const DYING = { flash: 0.3, fade: 2.3, peak: 9, glow: 7, dim: 0.08 }; // 切断后：先满亮 0.3 秒，再用 2.3 秒抽搐着暗到 0
// ---- 左门是一根"带阻尼的弹簧"：切断的一瞬间给它一个往外的初速度，目标是开到 1.32 弧度（约 76°）。
//      弹簧把它拉向目标，阻尼让它晃两下就停；最多开到 1.9 弧度，撞到头会弹回来一点
const DOOR = { open: 1.32, kick: 2.5, stiffness: 30, damping: 3.2, max: 1.9, bounceShut: 0.3, bounceOpen: 0.4 };

/**
 * 摆一只中继柜，登记它的碰撞盒，返回它的"遥控器"（Relay）和要加进场景的模型。
 * id 是 0 / 1 / 2：决定柜子是哪个个体（脏污、灯的呼吸从哪一拍开始），三只柜子不会同步地一起呼吸。
 */
export function buildRelay(id: number, spec: RelaySpec, colliders: Colliders): { relay: Relay; group: THREE.Group } {
  const seed = id + 1, floor = spec.y ?? 0;
  // 柜子带活动的子组，不能交给 PropField 做实例化，所以用 placeOnce 直接摆。
  // 登记进去的碰撞盒是：柜体（挡人也挡子弹）和桅杆（只挡子弹）；16 厘米高的水泥基座又矮又贴地，placeOnce 会自动跳过它
  const group = placeOnce(relayCabinet({ seed, id: spec.short, interior: spec.interior }), spec.x, spec.z, spec.yaw, colliders, floor);
  const parts = relayParts(group);
  const lamps = parts.lamps.map((mesh) => (mesh.material as THREE.MeshBasicMaterial).color); // 三组灯各有自己的材质，这里只要它们的颜色

  let state: State = 'live';
  let clock = (seed % 7) * 0.9;   // 这只柜子自己的时钟。起点各不相同，呼吸就错开了
  let sinceCut = 0;               // 切断以后过了多久
  let last = -1;                  // 上一次 update 的时刻；-1 表示还没调过
  let spin = LIVE.spin;           // 天线现在的转速（弧度 / 秒）
  let door = 0, doorSpeed = 0, doorTarget = 0; // 左门：现在开了多少弧度、角速度、想开到多少

  const relay: Relay = {
    id, name: spec.name, short: spec.short, pos: new THREE.Vector3(spec.x, floor, spec.z), cut: false,
    setCutting(on) { if (state !== 'cut') state = on ? 'cutting' : 'live'; },
    setCut() {
      if (state === 'cut') return;
      state = 'cut'; this.cut = true;
      sinceCut = 0; doorTarget = DOOR.open; doorSpeed = DOOR.kick;
    },
    reset() {
      state = 'live'; this.cut = false;
      door = doorSpeed = doorTarget = 0;
      parts.door.rotation.y = 0;
    },
    update(t) {
      // 两帧之间隔了多久。限制在 0.1 秒以内：卡顿之后的一大步会把弹簧算飞
      const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, t - last));
      last = t;
      clock += dt;

      // ---- 灯：颜色 × 亮度；同时定下天线"想转多快"
      let color: number = RELAY_COLORS.live, gain: number, spinTarget: number;
      if (state === 'live') {
        gain = LIVE.glow + LIVE.swing * Math.sin(clock * LIVE.rate);
        spinTarget = LIVE.spin;
      } else if (state === 'cutting') {
        const on = Math.sin(clock * Math.PI * 2 * CUTTING.hz) > 0; // 方波：正弦大于 0 的那半拍算"亮"
        gain = on ? CUTTING.on : CUTTING.off;
        if (on) color = RELAY_COLORS.cutting;
        spinTarget = CUTTING.spin + CUTTING.spinSwing * Math.sin(clock * CUTTING.spinRate);
      } else {
        sinceCut += dt;
        color = RELAY_COLORS.cut;
        spinTarget = 0;
        if (sinceCut < DYING.flash) gain = DYING.peak;
        else if (sinceCut < DYING.flash + DYING.fade) {
          const k = 1 - (sinceCut - DYING.flash) / DYING.fade; // 从 1 线性降到 0，平方以后先快后慢
          // 两个频率凑不成整数倍的正弦相乘，结果忽正忽负、没有规律：大约三分之一的时间落在 −0.2 以下，那时灯几乎全灭 —— 看起来就是接触不良的抽搐
          const flicker = Math.sin(sinceCut * 37) * Math.sin(sinceCut * 13.3) > -0.2 ? 1 : DYING.dim;
          gain = DYING.glow * k * k * flicker;
        } else gain = 0;
      }
      for (const c of lamps) c.setHex(color).multiplyScalar(gain);

      // ---- 天线：转速不是一下子变过去，而是每帧向目标靠一截（切断以后靠得慢，像断了电靠惯性慢慢停）
      spin += (spinTarget - spin) * Math.min(1, dt * (state === 'cut' ? 1.6 : 3));
      parts.dish.rotation.y = (parts.dish.rotation.y + spin * dt) % (Math.PI * 2);

      // ---- 左门：弹簧。只在门还没停稳的时候算
      if (Math.abs(doorTarget - door) > 1e-4 || Math.abs(doorSpeed) > 1e-3) {
        doorSpeed += (-(door - doorTarget) * DOOR.stiffness - doorSpeed * DOOR.damping) * dt;
        door += doorSpeed * dt;
        if (door < 0) { door = 0; doorSpeed = Math.abs(doorSpeed) * DOOR.bounceShut; }
        if (door > DOOR.max) { door = DOOR.max; doorSpeed = -Math.abs(doorSpeed) * DOOR.bounceOpen; }
        parts.door.rotation.y = -door; // 门轴在门的左边，往外开是绕竖轴转负角
      }
    },
  };
  relay.update(0); // 先算一次，让灯从一开始就是这只柜子自己的亮度
  return { relay, group };
}
