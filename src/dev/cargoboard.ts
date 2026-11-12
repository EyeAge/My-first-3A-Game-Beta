import * as THREE from 'three';
import { Kit, type PropModel } from '../world/kit';
import { CARGO } from '../world/props/cargo';

// 货物道具的"陈列板"（只在开发时用）：把 cargo.ts 里的每种道具和主要变体排成两排，一眼看全。
//
//   /viewer.html?m=dev/cargoboard&fn=cargoBoard                      整体看
//   /viewer.html?m=dev/cargoboard&fn=cargoBoard&target=4,0.5,2&views=30,15,3;-140,20,3   凑近看某一件
//
// 前排（z = +2）是会摆很多的小件，后排（z = -2）是大件；每件脚下的地面上写着"名字 + 三角形数"。
// 想知道某件摆在哪，看 cargoBoard().userData.slots。
//
// 只看单独一件（并画出碰撞盒）不用经过这里，直接让查看器调那个函数：
//   /viewer.html?m=world/props/cargo&fn=barrel&args=[{"color":"red","lying":true}]&boxes=1

/** 陈列的清单：[登记表里的名字, 参数]。 */
const FRONT: [string, object][] = [
  ['barrel', { color: 'blue', seed: 0 }],
  ['barrel', { color: 'red', seed: 1 }],
  ['barrel', { color: 'green', seed: 2, open: true }],
  ['barrel', { color: 'yellow', seed: 3, lying: true }],
  ['traffic_cone', { seed: 0 }],
  ['traffic_cone', { seed: 1, lying: true }],
  ['jerry_can', {}],
  ['jerry_can', { color: 'red', seed: 1 }],
  ['tire_stack', { seed: 0 }],
  ['tire_stack', { count: 2, seed: 1 }],
  ['pallet', { seed: 0 }],
  ['pallet', { seed: 1, broken: true }],
  ['cardboard_boxes', { seed: 0 }],
];
const BACK: [string, object][] = [
  ['pallet_stack', { seed: 0 }],
  ['pallet_stack', { count: 3, seed: 1 }],
  ['crate_wood', { seed: 0 }],
  ['crate_wood', { seed: 5 }],
  ['crate_stack', { seed: 0 }],
  ['ibc_tote', { seed: 0 }],
  ['cable_reel', { seed: 0 }],
  ['sandbags', { seed: 0 }],
  ['tarp_cargo', { seed: 0 }],
];

/** 一件道具有多少个三角形、多少个网格（= 多少次绘制调用）。 */
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

/** 搭陈列板。相邻两件的中心相距 2–3 米，每排以 x=0 居中。 */
export function cargoBoard(): THREE.Group {
  const board = new THREE.Group(), slots: BoardSlot[] = [];
  board.name = 'cargoboard';
  const signs = new Kit('cargoboard-signs'); // 地上的字：全部放进一个零件箱，最后合成一个网格
  for (const [items, z] of [[FRONT, 2], [BACK, -2]] as const) {
    const models = items.map(([name, args]) => CARGO[name](args));
    // 先排出每件的 x：中心距至少 2 米，大件再按自己的宽度多让出一些
    const xs: number[] = [];
    let x = 0;
    models.forEach((m, i) => {
      if (i) x += Math.max(2, models[i - 1].size[0] / 2 + m.size[0] / 2 + 1.1);
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
      signs.label(`${name} ${stat.tris}`, { color: 'white', font: 'sans', distress: 0 }, 1.7, 0.1, [px, 0.004, z + model.size[2] / 2 + 0.3], [-Math.PI / 2, 0, 0]);
    });
  }
  board.add(signs.finish({ boxes: [], grime: 0 }).group);
  board.userData.slots = slots;
  return board;
}
