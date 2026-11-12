import * as THREE from 'three';
import type { Colliders } from './colliders';
import type { PropModel } from './kit';

// 道具的"摆放清单"。
//
// 一种道具（比如托盘）只搭一次模型，但场上要摆几十个。这里先把"哪种模型摆在哪、朝哪"都记下来，
// 最后一起生成：同一种模型的所有个体共用一份几何体，用 InstancedMesh 一次画完。
// 碰撞盒也在这里从模型自己的坐标换算到世界坐标。

interface Placement { m: THREE.Matrix4; yaw: number; tint: number | null }

export class PropField {
  private items = new Map<PropModel, Placement[]>();

  /**
   * 把一件道具摆到 (x, y, z)，绕竖轴转 yaw 弧度。yaw 为正时，模型的 +x 方向从世界 +x 转向 -z。
   * tint（0xRRGGBB）只对模型里标了 userData.tintable 的网格生效：同一份几何，每个个体可以刷成不同的颜色。
   */
  place(model: PropModel, x: number, z: number, yaw = 0, y = 0, tint: number | null = null) {
    let list = this.items.get(model);
    if (!list) this.items.set(model, (list = []));
    list.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), ONE), yaw, tint });
    return this;
  }

  /** 生成网格，并把所有碰撞盒登记进去。 */
  build(colliders: Colliders): THREE.Group {
    const group = new THREE.Group();
    group.name = 'props';
    for (const [model, list] of this.items) {
      for (const child of model.group.children) {
        const src = child as THREE.Mesh;
        const inst = new THREE.InstancedMesh(src.geometry, src.material, list.length);
        list.forEach((p, i) => inst.setMatrixAt(i, p.m));
        if (src.userData.tintable && list.some((p) => p.tint !== null)) list.forEach((p, i) => inst.setColorAt(i, _col.setHex(p.tint ?? 0xffffff)));
        inst.castShadow = src.castShadow; inst.receiveShadow = src.receiveShadow;
        inst.name = src.name;
        inst.computeBoundingSphere();
        group.add(inst);
      }
      for (const p of list) addBoxes(model, p.m, p.yaw, colliders);
    }
    return group;
  }
}

const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
const _b = new THREE.Box3(), _lo = new THREE.Vector3(), _hi = new THREE.Vector3(), _col = new THREE.Color();

/**
 * 把一件道具的局部碰撞盒登记到世界里。
 * 碰撞系统只认"轴对齐"的盒子，所以斜着摆的东西要特别处理：
 * 一根斜放的 3 米长杆如果直接取外包盒，会变成一个 2 米见方的大方块。办法是先沿长边把它切成几小段，
 * 每一小段各取自己的外包盒 —— 一串小方块沿着斜线排开，就贴合多了。
 */
export function addBoxes(model: PropModel, m: THREE.Matrix4, yaw: number, colliders: Colliders) {
  const skew = Math.abs(Math.sin(2 * yaw)) > 0.2;
  for (const b of model.boxes) {
    const sx = b.max[0] - b.min[0], sz = b.max[2] - b.min[2];
    const alongX = sx >= sz, long = alongX ? sx : sz, short = alongX ? sz : sx;
    const n = skew ? Math.min(10, Math.max(1, Math.round(long / Math.max(0.25, short)))) : 1;
    for (let i = 0; i < n; i++) {
      _lo.set(b.min[0], b.min[1], b.min[2]); _hi.set(b.max[0], b.max[1], b.max[2]);
      if (alongX) { _lo.x = b.min[0] + (sx * i) / n; _hi.x = b.min[0] + (sx * (i + 1)) / n; }
      else { _lo.z = b.min[2] + (sz * i) / n; _hi.z = b.min[2] + (sz * (i + 1)) / n; }
      _b.set(_lo, _hi).applyMatrix4(m);
      let wx = _b.max.x - _b.min.x, wz = _b.max.z - _b.min.z;
      if (skew) { wx *= 0.93; wz *= 0.93; }
      const h = _b.max.y - _b.min.y;
      if (h < 0.2 && _b.max.y < 0.3) continue; // 又矮又贴地的（落地的货叉、垫板）：直接走过去就行，不登记
      colliders.add((_b.min.x + _b.max.x) / 2, (_b.min.y + _b.max.y) / 2, (_b.min.z + _b.max.z) / 2, wx, h, wz, b);
    }
  }
}

/** 只摆一件的大东西（叉车、建筑）不走实例化：直接把模型的网格挪到位，再登记碰撞盒。 */
export function placeOnce(model: PropModel, x: number, z: number, yaw: number, colliders: Colliders, y = 0): THREE.Group {
  model.group.position.set(x, y, z);
  model.group.rotation.y = yaw;
  model.group.updateMatrixWorld(true);
  addBoxes(model, model.group.matrixWorld, yaw, colliders);
  return model.group;
}
