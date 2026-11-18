import * as THREE from 'three';
import { mulberry32, pick } from '../core/math';
import { Colliders } from '../world/colliders';
import { buildContainer, CONTAINER_COLORS, CONTAINER_SIZES, type ContainerSize } from '../world/container';
import { ContainerField } from '../world/containerfield';

// 集装箱的样板（只在模型查看器里用）。
//
//   /viewer.html?m=dev/containerboard&fn=containerBoard          六样东西排成一排
//   /viewer.html?m=dev/containerboard&fn=containerYard&args=[0,0] 一小片堆场，检查"近处精模、远处简模"的切换
//   /viewer.html?m=world/container&fn=buildContainer&args=[{"size":20,"doors":0.8}]   单独看一只

const C = CONTAINER_COLORS;

/**
 * 六样东西沿 z 排开，每排隔 4.2 米：20 尺箱、40 尺箱、同一只 40 尺箱的简模、高箱、一只开着门的 20 尺箱、一摞三层。
 * 简模紧挨着它的精模，好对比远近切换时颜色接不接得上。箱门都朝 +x，并且门端都对齐在 x=0，方便从门那一头一眼看过去。
 */
export function containerBoard() {
  const root = new THREE.Group();
  const row = (z: number, size: ContainerSize, o: Parameters<typeof buildContainer>[0]) => {
    const model = buildContainer({ size, ...o });
    model.group.position.set(-CONTAINER_SIZES[size].length / 2, 0, z);
    root.add(model.group);
  };
  row(0, 20, { color: C.red, seed: 1, wear: 0.5 });
  row(4.2, 40, { color: C.blue, seed: 2, wear: 1 });
  row(8.4, 40, { color: C.blue, seed: 2, wear: 1, lod: true });
  row(12.6, 'hc', { color: C.green, seed: 3, wear: 0.5 });
  row(16.8, 20, { color: C.yellow, seed: 4, wear: 0.5, doors: 0.8 });
  // 一摞三层：走 ContainerField，顺便检查码垛的错位和实例颜色
  const field = new ContainerField({ seed: 7 });
  field.stack(-3.03, 21, [{ size: 20, color: C.orange }, { size: 20, color: C.grey }, { size: 20, color: C.teal }]);
  root.add(field.build(new Colliders()));
  field.update(new THREE.Vector3(0, 1.7, 21));
  return root;
}

/**
 * 一小片堆场：6 列 × 5 排，每摞 1–3 层，规格和颜色随机，外加一只斜放的和两只开门的。
 * (eyeX, eyeZ) 是假想的镜头位置：离它 detail 米以内的箱子是精模，其余是简模。返回值里带着碰撞盒，查看器加 boxes=1 可以看。
 */
export function containerYard(eyeX = 0, eyeZ = 0, detail = 45, maxDetail = 72) {
  const rng = mulberry32(11), colors = Object.values(C);
  const field = new ContainerField({ seed: 3, detailDistance: detail, maxDetail });
  for (let col = 0; col < 6; col++) for (let rowIndex = 0; rowIndex < 5; rowIndex++) {
    const size: ContainerSize = rng() < 0.6 ? 20 : rng() < 0.8 ? 40 : 'hc';
    const layers = 1 + Math.floor(rng() * 3);
    field.stack(col * 14 - 35, rowIndex * 5 - 10, Array.from({ length: layers }, () => ({ size, color: pick(rng, colors) })));
  }
  field.stack(-52, 4, [{ size: 20, color: C.yellow, doors: 0.5 }], 0.35, 0);
  field.stack(-52, -8, [{ size: 20, color: C.blue, doors: 0.8, flip: true }, { size: 20, color: C.white }]);
  field.add({ size: 40, x: 60, y: 0, z: 0, yaw: Math.PI / 2, color: C.red, lodOnly: true });
  const colliders = new Colliders();
  const group = field.build(colliders);
  field.update(new THREE.Vector3(eyeX, 1.7, eyeZ));
  // 在假想的镜头位置立一根杆子，截图里好认
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6), new THREE.MeshBasicMaterial({ color: 0xff3355 }));
  pole.position.set(eyeX, 3, eyeZ);
  group.add(pole);
  console.info(`[containerYard] ${field.count} 只箱子，其中 ${field.detailCount} 只用精模，碰撞盒 ${colliders.boxes.length} 个`);
  return { group, boxes: colliders.boxes.map((b) => ({ min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] })) };
}
