import * as THREE from 'three';
import { buildForklift } from '../world/forklift';
import type { LocalBox, PropModel } from '../world/kit';
import { CARGO } from '../world/props/cargo';
import { buildWorkshop } from '../world/workshop';
import { buildWorkshopFit, WORKSHOP_PROPS } from '../world/workshopfit';

// 维修车间室内陈设的"陈列板"（只在开发时用）：把陈设、建筑、通用道具按同一套坐标摆在一起，检查对不对得上。
//
//   /viewer.html?m=dev/fitboard&fn=fitBoard&views=0,89,36                         只看陈设，从正上方俯视
//   /viewer.html?m=dev/fitboard&fn=fitBoard&args=[{"props":true}]&boxes=1         加上通用道具，并画出碰撞盒
//   /viewer.html?m=dev/fitboard&fn=fitBoard&args=[{"shell":true}]&target=-13,3,-22&views=120,10,9
//                                                                                 连建筑一起，镜头放进屋里看夹层
//
// 镜头的方位角：0 是从南往北看，90 是从东往西看（见 viewer.ts 头部的说明）。
// 车间占 x −16…12、z −28…−11；带上建筑时屋顶会挡住俯视的镜头，所以俯视只看陈设，进屋的镜头再带建筑。

export interface FitBoardOptions {
  /** 把建筑本体也摆出来。 */
  shell?: boolean;
  /** 把通用道具（油桶、托盘、叉车……）也按清单摆出来。 */
  props?: boolean;
}

export function fitBoard(o: FitBoardOptions = {}): { group: THREE.Group; boxes: LocalBox[] } {
  const group = new THREE.Group();
  group.name = 'fitboard';
  // 屋面破洞的位置以建筑为准；不摆建筑时陈设用它自己记的那一份
  const shop = o.shell ? buildWorkshop({ mastCables: [], groundCable: false }) : null;
  const fit = buildWorkshopFit({ roofHoles: shop?.roofHoles });
  if (shop) group.add(shop.group);
  group.add(fit.group);

  if (o.props) for (const p of WORKSHOP_PROPS) {
    if (p.missing) continue;
    const args = { ...p.args, interior: true };
    const model: PropModel = p.name === 'forklift' ? buildForklift(args) : CARGO[p.name](args);
    // 道具模型是带缓存、会被共用的，所以放一份克隆（几何体和材质仍然共用）
    const copy = model.group.clone();
    copy.position.set(p.x, p.y ?? 0.03, p.z);
    copy.rotation.y = p.yaw;
    group.add(copy);
  }

  // 一根 1.75 米高的"人"，站在乙号中继的位置上当比例尺
  const person = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.31, 4, 10), new THREE.MeshStandardMaterial({ color: 0xc8432b, roughness: 0.8 }));
  person.position.set(fit.relayPos[0], fit.relayPos[1] + 0.875, fit.relayPos[2]);
  group.add(person);

  return { group, boxes: fit.boxes };
}
