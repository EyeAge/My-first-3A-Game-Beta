import { cableReel, cardboardBoxes, crateStack, crateWood, ibcTote, jerryCan, pallet, palletStack, sandbags, tireStack } from '../props/cargo';
import { dumpster, gasCylinders, pipeStack, rebarBundle, rebarCage, scrapBin } from '../props/equipment';
import { gatePost, laneSign, slidingGate } from '../props/site';
import { barrels, barrierRow, bollards, cones, crates, fenceRun, mast, type Stage } from './stage';

// 地图西侧：维修车间四周。
//
// 车间占 x −104…−76、z −8.5…8.5（见 port.ts）。它东山墙上的推拉门（z −2.5…2.5）正对堆场，门外是一片不堆箱子的门前空场；
// 南墙上的卷帘门（x −94…−89）开向一块水泥场院 —— 这里用铁丝网把场院围起来，当成车间的露天料场。
// 车间北边隔一条夹道是进不去的三号库房，它朝东有三樘卷帘门。

const H = Math.PI / 2;
/**
 * 场院的围栏：西、南、东三面，北面就是车间的南墙。西边线和东边线各比车间的山墙往里收 20–60 厘米，围栏正好顶在墙上。
 * 这几个数是凑过的：西边、南边都是 3.4 米的整数倍，每一跨一样长。
 */
const YARD = { x0: -103.8, x1: -76.6, z0: 8.65, z1: 35.85 };
/**
 * 东边围栏上的车辆入口（6.8 米宽）。朝东开：从堆场、码头过来的车都走车间东边那条路。
 * 这两个数是照寻路网格凑的：网格 2 米一格，围栏的碰撞盒算进网格时还要往外垫半米多；
 * 门洞开在 14.65…21.45，垫完以后中间正好剩下 z 16…20 这两格能走，地面敌人才进得来。
 */
const YARD_GATE = { z0: 14.65, z1: 21.45 };

/** 车间东南角外那根高杆灯的位置。屋外那根架空电缆的一头拴在它的杆顶（12.4 米高处）。 */
export const MAST = { x: -71.6, z: 10.6, cableY: 12.4 };

export function layWest(s: Stage) {
  s.reseed(404);
  layYard(s);

  // ---------------------------------------------------------------- 车间东门外的空场（x −76…−50，z ±12）
  // 只放矮的东西：太阳只有 13° 高，一人高的东西就能拖出八九米长的影子，把照进门的晨光挡掉
  bollards(s, -75.4, 0, [[0, -2.9], [0, 2.95]]);                    // 门洞两侧各一根防撞柱
  cones(s, -73, -4.2, -68.2, -4.2, 3);
  cones(s, -73, 4.2, -68.2, 4.2, 3);
  s.place(sandbags({ courses: 3 }), -66.5, -5.2, H + 0.06);
  s.place(sandbags({ courses: 3, seed: 1 }), -58.8, 6.4, 0.1);
  s.place(pallet({ seed: 2 }), -70.2, 6.6, 0.25);
  s.place(cardboardBoxes({ seed: 1 }), -70.2, 6.6, 0.3, 0.144);    // 纸箱码在托盘上（托盘高 14.4 厘米）
  s.place(crateWood({ seed: 1 }), -61.5, -8.6, 0.4);
  s.place(crateWood({ seed: 3 }), -59.9, -9.1, -0.2);
  barrels(s, -55.6, -3.5, 3);
  s.place(jerryCan({ color: 'red' }), -60.7, -7.5, 0.8);
  s.place(jerryCan({ color: 'olive' }), -60.9, -7.1, 2.2);
  // 空场东南角的通道牌：从二号通道走过来的人在拐角看到它，就知道前面是车间
  s.place(laneSign({ text: '维修车间', double: true }), -62.5, 12.9, H);
  // 车间东南角外的高杆灯。屋外那根架空电缆就是从它的杆顶拉到檐角的（电缆本身是车间外壳的一部分，见 port.ts）
  mast(s, MAST.x, MAST.z, 0, [[0.85, -0.3], [0.3, 0.85]]);

  // ---------------------------------------------------------------- 车间东边那条南北向的路（x −74…−62）
  // 路东侧是集装箱：箱子前面各摆一排隔离墩，再立一根灯
  barrierRow(s, -62.7, 27.0, H, 2);
  barrels(s, -65.4, 31.0, 3);
  barrierRow(s, -62.7, -24.0, H, 2);
  mast(s, -62.6, -43.2, 0, [[-0.85, 0]]);
  s.place(crateStack({ seed: 2 }), -68.3, -40.6, 0.1);
  s.place(crateWood({ seed: 0 }), -66.6, -40.2, 0.3);

  // ---------------------------------------------------------------- 三号库房的东墙（x = −76）：三樘卷帘门
  // 每樘门两侧的导轨前各一根防撞柱；头两樘门之间的墙垛前放一只垃圾箱
  for (const z of [-30.5, -23.5, -16.5]) bollards(s, -75.5, z, [[0, -2.45], [0, 2.45]]);
  s.place(dumpster({ color: 'green', seed: 2 }), -74.6, -27.0, H + 0.03);
}

/**
 * 车间南面的水泥场院。卷帘门正前方（斜线禁停框）和从东边入口拐进来的那条车道留空，东西都靠边：
 * 北边贴着车间的墙，西边、南边贴着围栏。
 */
function layYard(s: Stage) {
  // ---- 围栏。刺丝支臂朝"前进方向的左手边"，所以三面都是按"外面在左手边"的方向拉的
  fenceRun(s, YARD.x0, YARD.z1, YARD.x0, YARD.z0);                  // 西边：往北拉，左手是西
  fenceRun(s, YARD.x1, YARD.z1, YARD.x0 + 3.4, YARD.z1);            // 南边：往西拉，左手是南。西南角空一跨不装，当人走的小门
  fenceRun(s, YARD.x1, YARD.z0, YARD.x1, YARD_GATE.z0);             // 东边北段：往南拉，左手是东
  fenceRun(s, YARD.x1, YARD_GATE.z1, YARD.x1, YARD.z1);             // 东边南段
  // 车辆入口：两根门柱，一扇推拉门拉开了停在南段围栏的里侧。门扇模型的 −x 那头是门洞，转 −90° 以后门洞在它的北边
  for (const z of [YARD_GATE.z0, YARD_GATE.z1]) s.place(gatePost({ seed: 1 }), YARD.x1, z);
  s.place(slidingGate(), YARD.x1 - 0.35, YARD_GATE.z1 + 0.15 + 3.03, -H);
  bollards(s, YARD.x1 + 0.7, 0, [[0, YARD_GATE.z0 - 0.3], [0, YARD_GATE.z1 + 0.3]]);   // 门柱外侧各一根防撞柱
  bollards(s, YARD.x0, YARD.z1, [[1.1, 0], [2.3, 0]]);              // 小门中间两根：人能过，车过不来

  // ---- 北边：卷帘门两侧（门在 x −94…−89）
  bollards(s, -91.5, 9.05, [[-2.95, 0], [2.95, 0]]);
  cones(s, -94.6, 11, -94.6, 17, 3);
  cones(s, -88.4, 11, -88.4, 17, 3);
  crates(s, -100.6, 10.6, 0.03, 1);
  s.place(gasCylinders({ seed: 2 }), -86.9, 9.2, 0);
  s.place(tireStack({ count: 5 }), -85.6, 9.6, 0.2);
  s.place(tireStack({ count: 3, seed: 2 }), -84.5, 9.9, 2.6);
  s.place(ibcTote({ seed: 2 }), -79.6, 10.2, H);
  // ---- 西边：贴着围栏一溜。两垛钢管并排，角度差一点点
  s.place(dumpster({ color: 'blue', seed: 1 }), -102.3, 16.4, H);
  s.place(pipeStack({ seed: 1 }), -102.5, 24.4, H + 0.03);
  s.place(pipeStack({ seed: 3 }), -100.95, 24.7, H - 0.02);
  s.place(rebarBundle({ seed: 1 }), -101.6, 30.2, H + 0.06);
  mast(s, -99.3, 34.7);                                             // 场院西南角的高杆灯：灯头朝东西，东边那两只照着整个场院
  // ---- 场院中间：两只隔离墩把车道和南边的料场隔开，从入口进来的车顺着它拐向卷帘门
  barrierRow(s, -86.2, 24.8, 0, 2);
  // ---- 南边：贴着围栏
  s.place(rebarCage({ color: 'orange', seed: 1 }), -96.2, 34.2, -0.04);
  s.place(rebarCage({ color: 'blue', seed: 2 }), -93.6, 34.3, 0.03);
  s.place(scrapBin({ color: 'red', seed: 2 }), -90.6, 34.6, 0.05);
  s.place(palletStack({ count: 6 }), -88.2, 34.5, 0.1);
  s.place(palletStack({ count: 4, seed: 1 }), -86.7, 34.6, -0.08);
  s.place(pallet({ seed: 3 }), -86.5, 33.0, 0.5);
  barrels(s, -82.4, 33.6, 3);
  s.place(cableReel({ seed: 2 }), -79.3, 30.4, 0.2);
}
