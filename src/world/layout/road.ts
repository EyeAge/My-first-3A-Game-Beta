import { buildForklift } from '../forklift';
import { barrel, cableReel, cardboardBoxes, crateStack, crateWood, ibcTote, pallet, palletStack, sandbags, tarpCargo, trafficCone } from '../props/cargo';
import { distributionBox, dumpster, gasCylinders, pipeStack, rebarBundle, rebarCage, scrapBin, wheelChock } from '../props/equipment';
import { jerseyBarrier, laneSign, signPost } from '../props/site';
import { barrelPair, barrels, barrierRow, cable, cones, crates, frame, mast, type Stage } from './stage';

// 主干道、堆场里的通道、甲号中继所在的空场。
//
// 堆场的骨架（见 port.ts）：集装箱堆位 6 列 × 5 排，列与列之间是南北向的通道（x = −51、−37、1、15），
// 排与排之间是东西向的横向通道（z = ±47.55、±15.85）。主干道从 x −26 到 −10，把堆场分成东西两半，
// 和四条横向通道交成四个路口。东车道（x ≈ −14）往北，西车道（x ≈ −22）往南。
//
// 摆放的规矩：
//   · 大件贴着箱子或路边放，车道中间留空 —— 每一处收窄，旁边那条车道一定是通的；
//   · 每个路口立一根高杆灯、一块通道牌；
//   · 隔离墩成排：要么沿中线一字排开当分隔带，要么两只横着封住一条车道，前面摆路锥。

const H = Math.PI / 2;
const ROAD_X = -18;
/** 主干道两侧灯杆、牌子站的位置：刚好在黄色边线外侧、箱子拐角的旁边。 */
const SIDE_W = -26.9, SIDE_E = -9.1;
/** 四条横向通道的中线，从南到北；名字喷在通道牌上。 */
const CROSSINGS: [z: number, name: string][] = [[47.55, '一号通道'], [15.85, '二号通道'], [-15.85, '三号通道'], [-47.55, '四号通道']];
/** 灯杆、牌子离横向通道中线多远：通道宽 7 米，这样正好贴着拐角的箱子，让出中间的车道。 */
const CORNER = 2.75;

export function layRoad(s: Stage) {
  s.reseed(202);

  // ---------------------------------------------------------------- 四个路口：灯和牌子
  // 每个路口一根高杆灯、一块通道牌，斜对着立在两个角上；一个路口灯在西、下一个路口灯在东，交错着来。
  // 灯杆转了 90°，灯头朝南北两头照：顺着主干道走，远远就能看到前面路口亮着的灯面
  CROSSINGS.forEach(([z, name], i) => {
    if (i % 2 === 0) {
      mast(s, SIDE_W, z + CORNER, H, [[0.8, 0], [0, -0.8]]);        // 灯在西侧、路口的南角；防撞柱护着朝路、朝通道的两面
      s.place(laneSign({ text: name, double: true }), SIDE_E - 0.2, z - CORNER - 0.1, -0.03);
    } else {
      mast(s, SIDE_E, z - CORNER, H, [[-0.8, 0], [0, 0.8]]);        // 灯在东侧、路口的北角
      s.place(laneSign({ text: name, double: true }), SIDE_W + 0.2, z + CORNER + 0.1, 0.03);
    }
  });

  // ---------------------------------------------------------------- 主干道，从南往北一段一段摆
  // 第一段（z 51…76）：西车道在修路面。两只隔离墩封住车道，后面堆着钢管、钢筋和料笼；东车道照常走
  barrierRow(s, -23.9, 71.7, 0, 2, true);
  cones(s, -19.4, 73.4, -24.8, 74.8, 3);
  s.place(pipeStack({ seed: 2 }), -24.5, 64.4, H + 0.02);
  s.place(rebarBundle({ seed: 1 }), -22.7, 65.2, H - 0.05);
  s.place(rebarCage({ color: 'orange' }), -24.3, 58.8, H + 0.04);
  s.place(scrapBin({ color: 'blue', seed: 1 }), -22.3, 59.2, 0.2);
  s.place(jerseyBarrier({ seed: 1 }), -23.6, 55.0, -0.07);
  cones(s, -21.6, 54.4, -19.6, 53.4, 2);
  crates(s, -11.3, 61.0, H, 1);                                      // 东侧路边：一摞木箱顺着路牙排开

  // 第二段（z 19…44）：西车道上停着一只落地的箱子。中线上三只隔离墩一字排开，把两条道隔开
  barrierRow(s, ROAD_X - 0.3, 33.6, H, 3);
  s.place(tarpCargo({ seed: 1 }), -11.6, 28, H + s.jit(0.05));
  barrelPair(s, -11.4, 24.4, 'blue', 0.3);
  s.place(dumpster({ color: 'green', seed: 1 }), -24.9, 21.8, H + 0.03);

  // 第三段（z −12…12）：东车道上那只两层的箱子前后各摆了警示 —— 南边一只隔离墩和一溜路锥，北边再一溜路锥
  s.place(jerseyBarrier({ stripe: true, seed: 3 }), -13.6, 10.6, 0.05);
  cones(s, -16.2, 11.6, -11.0, 11.9, 3);
  cones(s, -11.2, -6.2, -15.8, -9.0, 3);
  barrels(s, -24.9, 7.6, 3);
  s.place(pallet({ seed: 1 }), -24.7, -5.2, 0.4);
  s.place(cardboardBoxes({ seed: 2 }), -24.7, -5.2, 0.5, 0.144);     // 纸箱码在托盘上（托盘高 14.4 厘米）

  // 第四段（z −44…−19）：东车道被两只隔离墩封住；西车道上那只箱子旁边滚着两只电缆盘
  barrierRow(s, -15.3, -22.4, 0, 2);
  s.place(trafficCone({ seed: 1 }), -17.4, -21.4, 0.3);
  s.place(cableReel({ seed: 0 }), -24.6, -20.9, 0.4);
  s.place(cableReel({ seed: 1 }), -24.5, -23.4, 1.9);
  barrels(s, -13.0, -40, 2);

  // 第五段（z −76…−51）：中线上两只隔离墩；西车道北头封住
  barrierRow(s, ROAD_X - 0.2, -58.4, H, 2);
  barrierRow(s, -23.9, -72.9, 0, 2, true);
  cones(s, -25.0, -64.0, -25.1, -58.8, 3);

  // ---------------------------------------------------------------- 北端的空场：贴着北围墙留着几件东西
  s.place(crateStack({ seed: 1 }), -12.0, -98.7, 0.2);
  s.place(barrel({ color: 'green' }), -10.7, -98.5, 0.3);
  s.place(rebarCage({ color: 'blue', seed: 1 }), -6.4, -98.6, 0.03);

  // ---------------------------------------------------------------- 堆场里的通道：东西不多，都贴着箱子放
  s.place(dumpster({ color: 'blue', seed: 2 }), -1.3, 30.4, H);          // 一号纵向通道（x = 1）
  s.place(rebarCage({ color: 'orange', seed: 2 }), -1.2, -29.5, H - 0.03);
  s.place(crateStack({ seed: 3 }), -39.3, 27.8, H + 0.04);               // x = −37
  s.place(pallet({ broken: true, seed: 2 }), -39.2, 29.6, 0.9);
  s.place(gasCylinders({ seed: 1 }), -53.6, -27.6, H);                   // x = −51：气瓶架背靠箱子，链子朝通道
  s.place(scrapBin({ color: 'red' }), -48.6, 32.8, 0.1);
  s.place(scrapBin({ color: 'blue', seed: 2 }), -48.7, 33.9, -0.15);

  layRelayA(s);
}

/**
 * 甲号中继（8, 0）的空场：四面开阔，所以摆了一圈矮掩体。
 * 中继的戏是这么搭的：四只路锥圈住它脚下的斜线禁停框；东边一只配电箱，粗电缆弯弯曲曲拖到柜脚 —— 看得出它是临时接的电；
 * 北面两只隔离墩、南面一只把空场的两个口子收窄；西南角那台叉车叉着木箱停在半路，后轮下塞着轮挡。
 */
function layRelayA(s: Stage) {
  const X = 8, Z = 0;
  for (const [dx, dz] of [[-2.1, -1.7], [2.1, -1.7], [2.1, 1.7], [-2.1, 1.7]] as const) s.place(trafficCone({ seed: dx > 0 ? 1 : 2 }), X + dx + s.jit(0.1), Z + dz + s.jit(0.1), s.jit(0.3));
  s.place(distributionBox({ seed: 1 }), X + 3.35, Z - 3.2, -H + 0.12);
  cable(s, [[X + 3.0, Z - 3.15], [X + 2.2, Z - 2.3], [X + 1.3, Z - 1.0], [X + 0.6, Z - 0.4]], 0.03, 1);
  s.place(signPost({ sign: 'hazard_voltage', text: '请勿靠近', seed: 3 }), X - 3.5, Z - 2.0, -H);  // 牌面朝西：从主干道那边过来正好看见
  barrierRow(s, X - 1.5, Z - 9.1, 0, 2);
  s.place(jerseyBarrier({ seed: 2 }), X + 1.9, Z + 9.4, -0.1);
  s.place(sandbags({ courses: 3 }), X - 3.1, Z - 5.0, 1.25);
  s.place(scrapBin({ color: 'red', seed: 1 }), X - 3.2, Z - 7.5, 0.04);
  s.place(ibcTote({ seed: 1 }), X + 3.1, Z + 4.2, 0.1);
  s.place(barrel({ color: 'red', seed: 3 }), X + 2.1, Z + 4.8, 0.2);
  s.place(rebarBundle({ seed: 2 }), X - 2.6, Z + 10.9, 0.06);
  mast(s, X + 3.2, Z - 11.6, 0, [[-0.8, 0], [0, 0.8]]);              // 空场东北角的高杆灯

  // 叉车：货叉朝着 (cos yaw, −sin yaw)，托盘和木箱顺着这个方向放在叉面上（离车身中心 1.42 米）
  const fx = X - 2.1, fz = Z + 4.6, yaw = -0.22, truck = frame(fx, fz, yaw);
  s.once(buildForklift({ seed: 6, forksUp: 0.3 }), fx, fz, yaw);
  s.place(pallet({ seed: 1 }), ...truck(1.42, 0), yaw, 0.535);       // 0.535 米：托盘底面正好压在抬起的货叉上
  s.place(crateWood({ seed: 2 }), ...truck(1.42, 0), yaw + 0.05, 0.679);
  // 轮挡的斜面朝它自己的 +x，所以塞在后轮后面时和车同向。后轮在车身后方 1.1 米、左右各 0.46 米；再丢一只在车后的地上
  for (const side of [-1, 1]) s.place(wheelChock({ seed: side + 1 }), ...truck(-1.1 - 0.36, side * 0.46), yaw);
  s.place(wheelChock({ seed: 1 }), fx - 2.6, fz - 1.2, 2.4);
  s.place(palletStack({ count: 5 }), X - 4.6, Z + 7.6, 0.3);
  s.place(pallet({ broken: true }), X - 5.8, Z + 6.1, 1.1);
}
