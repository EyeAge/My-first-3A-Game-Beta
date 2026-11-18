import { barrel, ibcTote, sandbags, tarpCargo, tireStack, trafficCone } from '../props/cargo';
import { distributionBox, rebarBundle, rebarCage, scrapBin, steelPlateStack, wheelChock } from '../props/equipment';
import { bollardMooring, jerseyBarrier, reeferUnit } from '../props/site';
import { barrelPair, barrels, barrierRow, bollards, cable, cones, crates, frame, generatorSet, mast, type Stage } from './stage';

// 码头前沿：堆场东边线（x ≈ 27）到岸壁（x = 62）之间的作业带。
//
// 两条岸桥轨道在 x = 34（陆侧）和 58（海侧），两台岸桥跨在上面；轨道之间 20 多米宽是集卡走的地方，丙号中继就在这中间。
// 这里的东西按"护"和"挡"来摆：
//   · 护：岸桥每条门腿的台车两头立防撞柱；堆场边线上，箱子前面摆两只隔离墩；灯杆脚下也有防撞柱；
//   · 挡：两垛十米长的钢板是码头上最大的掩体，分在丙号中继的南北两侧；
//   · 岸壁边一溜系缆桩，每 12 米一只。

const H = Math.PI / 2;
const RAIL_LAND = 34, RAIL_SEA = 58;   // 两条岸桥轨道（门腿就骑在轨道上）
const EDGE_X = 26.7;                   // 堆场边线上那排隔离墩的位置：箱子的东立面在 25.9，留半米不到，人钻不进去
const MAST_X = 28.4;                   // 堆场边线上的高杆灯

/** quayX 是岸壁的位置；craneZs 是每台岸桥在码头上的位置（它的四条门腿在 z ± 8）。 */
export function layQuay(s: Stage, quayX: number, craneZs: readonly number[]) {
  s.reseed(303);

  // ---------------------------------------------------------------- 岸壁边的系缆桩
  for (let z = -96, i = 0; z <= 96; z += 12, i++) s.place(bollardMooring({ seed: i }), quayX - 0.95, z, s.jit(0.08));

  // ---------------------------------------------------------------- 岸桥门腿的防撞柱
  // 每条腿脚下是一台 5.4 米长的行走台车（沿轨道方向）。车是顺着码头南北向开的，会撞上的是台车的两头。
  // 防撞柱立在轨道两旁、不能立在轨道上（岸桥还要沿着轨道走）：陆侧的腿两边都过车，两头各两根；
  // 海侧的腿只有朝陆地的一面过车，而且两条腿之间是岸桥自己的地盘，所以只在朝外的那一头立一根
  for (const cz of craneZs) for (const side of [-1, 1]) {
    const z = cz + side * 8;
    bollards(s, RAIL_LAND, z, [[-0.85, -3.1], [0.85, -3.1], [-0.85, 3.1], [0.85, 3.1]]);
    bollards(s, RAIL_SEA, z, [[-0.85, side * 3.1]]);
  }

  // ---------------------------------------------------------------- 高杆灯
  // 堆场边线上四根（都立在箱子前面，让开横向通道的出口），灯头朝东西：一面照码头、一面照堆场；岸壁边两根
  for (const z of [-62, -24, 36, 70]) mast(s, MAST_X, z, 0, [[0.2, -0.8], [0.2, 0.8]]);
  for (const z of [-10, 78]) mast(s, quayX - 1.7, z, 0, [[-0.85, 0]]);

  // ---------------------------------------------------------------- 堆场边线：箱子前面的隔离墩，一排两只
  barrierRow(s, EDGE_X, 62.0, H, 2);
  barrierRow(s, EDGE_X, 32.0, H, 2);
  barrierRow(s, EDGE_X, -29.0, H, 2);
  barrierRow(s, EDGE_X, -66.0, H, 2);
  cones(s, 31.5, -6, 31.5, -15, 4);
  cones(s, 31.5, 52, 31.5, 46, 3);

  // ---------------------------------------------------------------- 丙号中继（48, −8）：岸桥作业带正中
  // 和甲号一个路数：路锥、两只隔离墩（一竖一横）、配电箱和拖过来的电缆；周围再加沙袋、料笼、废料斗、一对油桶当掩体。
  // 相对位置照参考（它的丙号中继也在岸桥底下）
  const c = frame(48, -8, 0);
  s.place(jerseyBarrier({ seed: 1 }), ...c(-2.5, -4.7), H + 0.12);
  s.place(jerseyBarrier({ seed: 3 }), ...c(2.3, 3.1), -0.2);
  s.place(rebarCage({ color: 'blue', seed: 2 }), ...c(2.7, -3.3), 0.08);
  s.place(sandbags({ courses: 3, seed: 1 }), ...c(-2.4, 3.0), 1.25);
  s.place(barrel({ color: 'red', seed: 1 }), ...c(3.5, -1.7), 0);
  s.place(barrel({ color: 'blue', seed: 2 }), ...c(3.9, -1.05), 0.5);
  s.place(scrapBin({ color: 'red', seed: 3 }), ...c(-2.45, 1.35), 0.12);
  s.place(trafficCone({ seed: 0 }), ...c(-1, -1.9), 0.2);
  s.place(trafficCone({ seed: 1 }), ...c(1.2, 1.7), -0.3);
  s.place(distributionBox({ seed: 2 }), ...c(-2.6, -7.3), 0.2);
  cable(s, [c(-2.5, -7), c(-1.6, -4.9), c(-0.6, -2.6), c(-0.1, -0.7)], 0.03, 2);
  // 中继南北两侧各一垛钢板（每块 10.4 × 4.2 米，两层摞起来 1.2 米高，能站人），顺着码头方向摆
  s.place(steelPlateStack({ layers: 2 }), 50.6, -22.6, H + 0.02);
  s.place(steelPlateStack({ layers: 2, seed: 1 }), 45.7, 6.9, H - 0.03);
  s.place(tarpCargo({ seed: 2 }), 38.6, -14, 0.08);
  s.place(tireStack({ count: 4 }), 41.4, -15.2, 0.7);
  s.place(tireStack({ count: 2, seed: 1 }), 42.5, -14.3, 2.1);
  barrels(s, 54, 4, 2);
  s.place(ibcTote({ seed: 0 }), 56.4, 6.2, 0.04);
  s.place(ibcTote({ seed: 1 }), 56.5, 7.6, -0.03);

  // ---------------------------------------------------------------- 南段：去撤离艇的路上
  crates(s, 42, 40, 1.57, 1);
  barrels(s, 30, 30, 3);
  s.place(scrapBin({ color: 'red' }), 54.6, 33.5, 0.1);
  s.place(scrapBin({ color: 'blue', seed: 1 }), 54.7, 34.45, -0.15);
  s.place(wheelChock({ seed: 1 }), 37.6, 34.4, 0.4);                 // 两只没人收的轮挡：集卡开走了，垫轮子的东西留在原地
  s.place(wheelChock({ seed: 2 }), 38.5, 40.1, -2.6);
  s.place(rebarBundle(), 37.6, 45.6, H + 0.05);
  s.place(sandbags({ courses: 4 }), 47.5, 70.5, 0.02);
  s.place(sandbags({ courses: 3, seed: 1 }), 53.8, 82, H);
  crates(s, 50, 76, -0.2, 1);
  // 登船口（斜线禁停框在 x 55…60、z 84…96）：朝陆地的两个角各一只路锥，旁边一对料笼、一对油桶
  s.place(trafficCone({ seed: 2 }), 54.9, 84.2, 0.1);
  s.place(trafficCone({ seed: 0 }), 54.8, 95.8, -0.2);
  s.place(rebarCage({ color: 'blue' }), 51.6, 92.6, 0.04);
  s.place(rebarCage({ color: 'orange', seed: 1 }), 51.7, 94.4, -0.06);
  barrelPair(s, 53.2, 86.2, 'yellow');
  // 南围墙根：三台拆下来待修的冷藏箱机组靠墙立着（正面朝北），一台发电机给它们供电，投光灯照着干活的地方。
  // 发电机这一组转了差不多半圈（−3.05 弧度），灯于是朝西南照 —— 正对着那排机组
  for (let i = 0; i < 3; i++) s.place(reeferUnit({ seed: i }), 37.2 + i * 2.7, 99.6, -H + s.jit(0.03));
  generatorSet(s, 47.4, 95.0, -3.05, 'orange');
  cable(s, [[46.4, 95.6], [45.4, 97.6], [44.0, 98.8], [42.9, 99.2]], 0.028, 3);

  // ---------------------------------------------------------------- 北段
  crates(s, 52, -52, 0.1, 1);
  barrels(s, 44, -86, 3, false);
  s.place(rebarCage({ color: 'orange' }), 47.4, -98.5, 0.05);
}
