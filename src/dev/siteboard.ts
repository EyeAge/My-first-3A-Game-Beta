import * as THREE from 'three';
import { Kit, type PropModel } from '../world/kit';
import { RELAY_COLORS, relayCabinet, relayParts, setRelayLamps, SITE } from '../world/props/site';

// 场地设施道具的"陈列板"（只在开发时用）：把 site.ts 里的每种道具和主要变体排成三排，一眼看全。
//
//   /viewer.html?m=dev/siteboard&fn=siteBoard                                         整体看
//   /viewer.html?m=dev/siteboard&fn=siteBoard&target=-6,0.5,5&views=30,15,3;-140,20,3   凑近看某一件
//
// 前排（z = +5）是会摆很多的小件，中排（z = 0）是牌子、大门和中继柜，后排（z = -6）是围栏、岗亭这些大件。
// 每件脚下的地面上写着"名字 + 三角形数"。想知道某件摆在哪，看 siteBoard().userData.slots。
//
// 只看单独一件（并画出碰撞盒）不用经过这里，直接让查看器调那个函数：
//   /viewer.html?m=world/props/site&fn=guardBooth&boxes=1
//
// 中继柜的三种状态（正常 / 切断中 / 已切断）另有一排，见最下面的 relayStates：
//   /viewer.html?m=dev/siteboard&fn=relayStates

/** 陈列的清单：[登记表里的名字, 参数]。 */
const FRONT: [string, object][] = [
  ['jersey_barrier', { seed: 0 }],
  ['jersey_barrier', { seed: 1, stripe: true }],
  ['bollard_post', { seed: 0 }],
  ['bollard_post', { seed: 1 }],
  ['bollard_mooring', { seed: 0 }],
  ['gate_arm', { open: 0 }],
  ['gate_arm', { open: 1 }],
];
const MIDDLE: [string, object][] = [
  ['sign_post', { seed: 0 }],
  ['sign_post', { seed: 1 }],
  ['sign_post', { seed: 3, sign: 'berth4', text: '四号泊位' }],
  ['lane_sign', { text: '一号通道' }],
  ['lane_sign', { text: '二号通道', double: true }],
  ['gate_post', {}],
  ['relay_cabinet', { seed: 0 }],
  ['reefer_unit', { seed: 0, flip: true }],
];
const BACK: [string, object][] = [
  ['fence_panel', { seed: 0 }],
  ['fence_panel', { seed: 1, posts: 'left', length: 3.4 }],
  ['sliding_gate', {}],
  ['guard_booth', { seed: 0 }],
  ['light_mast', { seed: 0 }],
];

/** 一件道具有多少个三角形、多少个网格（= 多少次绘制调用）。子组里的也算。 */
export function countTriangles(model: PropModel) {
  let tris = 0, meshes = 0;
  model.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const g = mesh.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { tris: Math.round(tris), meshes };
}

export interface BoardSlot { name: string; args: object; x: number; z: number; tris: number; meshes: number; size: number[] }

/** 搭陈列板。相邻两件之间留 1.2 米以上的空，每排以 x=0 居中。 */
export function siteBoard(): THREE.Group {
  const board = new THREE.Group(), slots: BoardSlot[] = [];
  board.name = 'siteboard';
  const signs = new Kit('siteboard-signs'); // 地上的字：全部放进一个零件箱，最后合成一个网格
  for (const [items, z] of [[FRONT, 5], [MIDDLE, 0], [BACK, -6]] as const) {
    const models = items.map(([name, args]) => SITE[name](args));
    // 先排出每件的 x：按各自的宽度让出位置（道闸、推拉门都有好几米长）
    const xs: number[] = [];
    let x = 0;
    models.forEach((m, i) => {
      if (i) x += Math.max(1.6, models[i - 1].size[0] / 2 + m.size[0] / 2 + 1.2);
      xs.push(x);
    });
    models.forEach((model, i) => {
      const [name, args] = items[i], px = xs[i] - x / 2;
      // 模型是带缓存、可能被别处共用的，这里放一份克隆（几何体和材质还是共用的，不多占内存）
      const copy = model.group.clone();
      copy.position.set(px, 0, z);
      board.add(copy);
      const stat = countTriangles(model);
      slots.push({ name, args, x: px, z, ...stat, size: model.size });
      signs.label(`${name} ${stat.tris}`, { color: 'white', font: 'sans', distress: 0 }, 1.9, 0.1, [px, 0.004, z + model.size[2] / 2 + 0.45], [-Math.PI / 2, 0, 0]);
    });
  }
  board.add(signs.finish({ boxes: [], grime: 0 }).group);
  board.userData.slots = slots;
  return board;
}

/**
 * 三只中继柜并排，摆成任务里的三种状态。它同时是一段用法示例：site.ts 给中继柜留的"把手"（灯、左门、天线）怎么用。
 *   左：正常 —— 琥珀色；
 *   中：切断中、闪亮的那半拍 —— 颜色变浅、更亮，天线转过了一个角度；
 *   右：已切断 —— 红灯，左门弹开 1.32 弧度（约 76°），露出里面的 5 层设备。
 * 真正的状态机（呼吸、闪烁、门的弹簧）在游戏逻辑里，每帧调的也就是这几样。
 */
export function relayStates(): THREE.Group {
  const row = new THREE.Group();
  row.name = 'relay-states';
  const states = [
    { id: '甲', color: RELAY_COLORS.live, gain: 5.5, door: 0, dish: 0 },
    { id: '乙', color: RELAY_COLORS.cutting, gain: 9, door: 0, dish: 1.2 },
    { id: '丙', color: RELAY_COLORS.cut, gain: 7, door: 1.32, dish: 2.6 },
  ];
  states.forEach((state, i) => {
    const cabinet = relayCabinet({ seed: i, id: state.id }).group, parts = relayParts(cabinet);
    setRelayLamps(cabinet, state.color, state.gain);
    parts.door.rotation.y = -state.door; // 门轴在门的左边，往外开是绕 y 轴转负角
    parts.dish.rotation.y = state.dish;
    cabinet.position.x = (i - 1) * 2.4;
    row.add(cabinet);
  });
  return row;
}
