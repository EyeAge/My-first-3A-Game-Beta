import * as THREE from 'three';
import { Kit, type LocalBox, type PropModel } from '../world/kit';
import { countTriangles } from './cargoboard';
import {
  distributionBox, dumpster, FLOODLIGHT_HEADS, FLOODLIGHT_LAMP, floodlightStand, gasCylinders, generator, groundCable, pipeStack,
  rebarBundle, rebarCage, scrapBin, steelPlateStack, toolboxCart, wheelChock,
} from '../world/props/equipment';

// 设备与杂物类道具的"陈列板"（只在开发时用）：把每种道具间隔排开，用模型查看器一眼看全。
//
//   /viewer.html?m=dev/equipboard&fn=equipBoard                 整体看
//   /viewer.html?m=dev/equipboard&fn=equipBoardModel&boxes=1    连碰撞盒一起看
//   /viewer.html?m=world/props/equipment&fn=generator&args=[{"seed":1}]   单看一种
//
// 每件道具脚下的地面上写着它的名字和三角形数。同样的数字也放在 window.__equipStats 里。

interface Slot { name: string; model: PropModel; x: number; z: number; yaw?: number; lamp?: boolean }

function slots(): Slot[] {
  return [
    // 第一排：发电机组合（发电机 + 投光灯 + 中间一根电缆）、垃圾箱、气瓶架、工具车、配电箱、轮挡
    { name: 'generator', model: generator(), x: -9, z: 0 },
    { name: 'ground_cable', model: groundCable({ points: [[-7.8, 0.6], [-6.9, 1.2], [-6.0, 0.9]], r: 0.02 }), x: 0, z: 0 },
    { name: 'floodlight_stand', model: floodlightStand(), x: -5.6, z: 0.4, lamp: true },
    { name: 'dumpster', model: dumpster(), x: -2.8, z: 0 },
    { name: 'dumpster blue#1', model: dumpster({ color: 'blue', seed: 1 }), x: -0.4, z: 0 },
    { name: 'gas_cylinders', model: gasCylinders(), x: 1.6, z: 0 },
    { name: 'gas_cylinders#1', model: gasCylinders({ seed: 1 }), x: 2.9, z: 0 },
    { name: 'toolbox_cart', model: toolboxCart(), x: 4.4, z: 0 },
    { name: 'distribution_box', model: distributionBox(), x: 5.9, z: 0 },
    { name: 'wheel_chock', model: wheelChock(), x: 7, z: 0 },
    { name: 'scrap_bin', model: scrapBin(), x: 8.4, z: 0 },
    { name: 'scrap_bin blue#1', model: scrapBin({ color: 'blue', seed: 1 }), x: 10, z: 0 },
    // 第二排：长的东西
    { name: 'pipe_stack', model: pipeStack(), x: -6.5, z: -4 },
    { name: 'rebar_cage', model: rebarCage(), x: -1, z: -4 },
    { name: 'rebar_cage orange#1', model: rebarCage({ color: 'orange', seed: 1 }), x: 2, z: -4 },
    { name: 'rebar_bundle', model: rebarBundle(), x: 6, z: -4 },
    { name: 'generator#1 关灯的投光灯', model: generator({ seed: 1 }), x: 10, z: -4, yaw: Math.PI },
    { name: 'floodlight_stand#1 off', model: floodlightStand({ seed: 1, on: false }), x: 12.2, z: -4 },
    // 第三排：大钢板垛，和一条自动加弯的长电缆
    { name: 'steel_plate_stack', model: steelPlateStack(), x: -4, z: -10 },
    { name: 'steel_plate_stack 1层', model: steelPlateStack({ layers: 1, seed: 1 }), x: 7.5, z: -10 },
    { name: 'ground_cable 长', model: groundCable({ points: [[-9, 2.6], [-2, 3], [4, 2.4], [10, 3.1]], r: 0.03, seed: 2 }), x: 0, z: 0 },
  ];
}

function build() {
  const group = new THREE.Group();
  group.name = 'equipboard';
  const boxes: LocalBox[] = [];
  const stats: Record<string, { tris: number; meshes: number }> = {};
  const captions = new Kit('captions');
  for (const s of slots()) {
    // 用克隆体：道具模型是带缓存的共享对象，直接挪它会影响别处拿到的同一个模型
    const inst = s.model.group.clone();
    inst.position.set(s.x, 0, s.z);
    inst.rotation.y = s.yaw ?? 0;
    group.add(inst);
    const c = (stats[s.name] = countTriangles(s.model));
    // 名字和三角形数写在道具前面（+z 一侧）的地上。电缆的路径点就是世界坐标，说明文字放到路径起点旁边
    const bb = new THREE.Box3().setFromObject(inst);
    captions.label(`${s.name}  ${c.tris}`, { color: 'white', font: 'sans', distress: 0 }, 2.4, 0.13, [(bb.min.x + bb.max.x) / 2, 0.012, bb.max.z + 0.22], [-Math.PI / 2, 0, 0]);
    // 碰撞盒：转过朝向之后取外包盒
    inst.updateMatrixWorld(true);
    for (const b of s.model.boxes) {
      const w = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).applyMatrix4(inst.matrixWorld);
      boxes.push({ min: [w.min.x, w.min.y, w.min.z], max: [w.max.x, w.max.y, w.max.z], surface: b.surface });
    }
    if (s.lamp) {
      // 把导出的灯位数据画出来核对：红球是整盏灯的等效位置，红线是照射方向；两个小黄球是两只灯头的灯面中心
      const dot = (p: number[], color: number, r: number) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial({ color })); m.position.set(p[0], p[1], p[2]); inst.add(m); };
      dot(FLOODLIGHT_LAMP.pos, 0xff2020, 0.02);
      inst.add(new THREE.ArrowHelper(new THREE.Vector3(...FLOODLIGHT_LAMP.dir), new THREE.Vector3(...FLOODLIGHT_LAMP.pos), 0.8, 0xff2020));
      for (const h of FLOODLIGHT_HEADS) { dot(h.pos, 0xffd020, 0.012); inst.add(new THREE.ArrowHelper(new THREE.Vector3(...h.dir), new THREE.Vector3(...h.pos), 0.4, 0xffd020)); }
    }
  }
  group.add(captions.finish({ boxes: [], grime: 0 }).group);
  (globalThis as unknown as { __equipStats: unknown }).__equipStats = stats;
  return { group, boxes };
}

/** 所有设备类道具排成一板。 */
export function equipBoard(): THREE.Group {
  return build().group;
}

/** 同上，但带着换算到陈列板坐标里的碰撞盒：查看器加 boxes=1 就能把它们画成线框。 */
export function equipBoardModel(): PropModel {
  const { group, boxes } = build();
  return { group, boxes, size: [26, 3, 14], name: 'equipboard' };
}

/** 每种道具的三角形数和网格数（不建陈列板，只数数）。 */
export function equipStats() {
  const out: Record<string, { tris: number; meshes: number }> = {};
  for (const s of slots()) out[s.name] = countTriangles(s.model);
  return out;
}
