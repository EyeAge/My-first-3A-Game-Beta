import { barrel, tireStack, trafficCone } from '../props/cargo';
import { distributionBox, dumpster, pipeStack, rebarBundle, rebarCage, scrapBin } from '../props/equipment';
import { gateArm, gatePost, guardBooth, jerseyBarrier, laneSign, signPost, slidingGate } from '../props/site';
import { bollards, cable, cones, fenceRun, generatorSet, mast, type Stage } from './stage';

// 大门区：玩家出生的地方。
//
// 主干道（中线 x = −18，东车道往北进场、西车道往南出场）走到南围墙就是港区的大门。从南往北依次是：
//
//   z = 100   围墙上的门洞，13 米宽。两扇推拉门：西边那扇关着，东边那扇拉开停在墙后 —— 门只开了进场的那一半
//   z 83…100  "门厅"：两道铁丝网围栏从围墙往里拉 17 米，把进来的车和人拢在路上
//   z = 93    玩家出生点，在路中间，面朝北
//   z 84…88   斑马线（画在地面上，ground.ts）
//   z ≈ 80    卡口：路中间一座岗亭，两边各一道道闸。出场那道放着，进场那道抬着 —— 往北走的路在右手边
//   z < 76    两排集装箱夹着的主干道
//
// 所以开局第一眼：正前方十几米是亮着灯的岗亭和一起一落两根红白栏杆，脚边是把车道挤成 S 弯的隔离墩，
// 左右是高杆灯和标志牌，再往后才是箱子和岸桥。

/** 门洞在南围墙上的范围（两个门垛朝里的那一面）。port.ts 砌围墙时要在这里留出口子。 */
export const GATE = { x0: -24.6, x1: -11.4 };
const WALL_Z = 100;                 // 南围墙朝里的那一面
const ROAD_X = -18;                 // 主干道中线
const KERB_W = -25.7, KERB_E = -10.3; // 两条黄色边线
const POST_Z = 80.2;                // 卡口（岗亭、道闸）所在的那条线
const H = Math.PI / 2;

export function layGate(s: Stage) {
  s.reseed(101);

  // ---------------------------------------------------------------- 门洞：门柱、两扇推拉门
  // 门扇是 6 米长的铁丝网框，骑在一条贴着围墙里侧的地轨上。模型的原点在门扇正中，地轨朝 −x 伸出去（那一头是门洞）。
  const TRACK_Z = WALL_Z - 0.28;
  for (const x of [GATE.x0 + 0.13, GATE.x1 - 0.13]) s.place(gatePost(), x, WALL_Z + 0.25);
  s.place(slidingGate(), GATE.x0 + 0.1 + 3.03, TRACK_Z);   // 西扇：关着，挡住出场的车道
  s.place(slidingGate(), GATE.x1 + 0.15 + 3.03, TRACK_Z);  // 东扇：整扇拉到门垛后面，进场的半边敞着
  // 敞着的那一半外面拿两只带警示条的隔离墩一前一后堵住：人和车都别想直接开进来
  s.place(jerseyBarrier({ stripe: true, seed: 1 }), -16.4, WALL_Z + 3.6, 0.07);
  s.place(jerseyBarrier({ stripe: true, seed: 2 }), -13.1, WALL_Z + 4.6, -0.06);
  s.place(trafficCone({ seed: 1 }), -18.3, WALL_Z + 2.7, 0.2);
  s.place(trafficCone({ lying: true, seed: 2 }), -11.9, WALL_Z + 2.9, 2.2);
  // 门洞里侧两边各一根防撞柱，护住门柱和地轨的端头
  bollards(s, 0, WALL_Z - 1.1, [[GATE.x0 - 0.35, 0], [GATE.x1 + 0.35, 0]]);

  // ---------------------------------------------------------------- 门厅两侧的围栏
  // 17 米正好 5 跨。围栏要让开东扇门停靠的位置（它一直伸到 x = −5.2），所以两道围栏离路边各有 5 米多。
  // 刺丝支臂朝门厅里面斜：外人是从大门进来的，要防的是有人从门厅翻进两边的场地
  const FENCE_W = -31.4, FENCE_E = -4.6, FENCE_END = WALL_Z - 0.1 - 17;
  fenceRun(s, FENCE_W, FENCE_END, FENCE_W, WALL_Z - 0.1);
  fenceRun(s, FENCE_E, WALL_Z - 0.1, FENCE_E, FENCE_END);

  // ---------------------------------------------------------------- 卡口：岗亭和两道道闸
  // 车道有 7.7 米宽，道闸的栏杆只有 4.6 米。所以路中间用岗亭和两只竖放的隔离墩围出一个 6 米宽的"岛"，把两条车道各挤到 4.8 米。
  s.place(guardBooth(), ROAD_X, POST_Z, 0);                                 // 门朝南：正对着走进来的人
  for (const side of [-1, 1]) s.place(jerseyBarrier({ stripe: true, seed: side + 1 }), ROAD_X + side * 2.55, POST_Z, H + side * 0.03);
  bollards(s, ROAD_X, POST_Z, [[-0.9, 2.15], [0.9, 2.15], [-0.9, -2.15], [0.9, -2.15]]); // 岛的南北两头各两根
  // 道闸的机箱在模型的 −x 端（偏 2.31 米）。出场道：机箱靠西边线，栏杆放平横在路上；进场道：机箱贴着岛，栏杆抬到头
  s.place(gateArm({ open: 0 }), KERB_W - 0.35 + 2.31, POST_Z);
  s.place(gateArm({ open: 1 }), ROAD_X + 3.15 + 2.31, POST_Z);
  // 放下的那道栏杆前面再摆一排路锥：这条道今天不开
  cones(s, KERB_W + 0.9, POST_Z + 1.9, ROAD_X - 3.7, POST_Z + 1.7, 3);
  // 岗亭的门头灯：给它一个光晕（site.ts 里登记的灯位是亭子自己的坐标，亭子没转，加上摆放位置就是世界坐标）。
  // 它不进灯池：门头灯只照得亮门前一小块地，不值得占一盏真灯
  const lamp = guardBooth().group.userData.lamps[0].pos as [number, number, number];
  s.flares.push({ x: ROAD_X + lamp[0], y: lamp[1], z: POST_Z + lamp[2], r: 1.3, g: 1.0, b: 0.62, size: 0.7 });

  // ---------------------------------------------------------------- 门厅里：S 弯、标志牌、杂物
  // 进场车道上一左一右两只隔离墩，车得拧一个 S 弯才过得去，冲不了卡。玩家就出生在这两只墩子之间
  s.place(jerseyBarrier({ stripe: true, seed: 0 }), -15.5, 90.5, 0.06);
  s.place(jerseyBarrier({ stripe: true, seed: 3 }), -12.0, 95.5, -0.05);
  s.place(jerseyBarrier({ seed: 2 }), ROAD_X - 0.3, 96.7, H + 0.03);          // 进、出两条道之间的分隔
  s.place(trafficCone({ seed: 0 }), -17.6, 98.4, 0.3);
  s.place(trafficCone({ lying: true, seed: 1 }), -15.9, 86.6, 0.8);           // 被风刮倒在斑马线上的一只
  // 牌子都朝南，走进来的人正好看得见字
  s.place(signPost({ sign: 'berth4', text: '仅限授权人员' }), KERB_E + 1.0, POST_Z + 2.0, 0.04);
  s.place(signPost({ sign: 'no_entry', text: '禁止行人通行', seed: 1 }), KERB_W - 1.0, POST_Z + 1.3, -0.05);
  s.place(signPost({ sign: 'hazard_general', text: '请穿反光服并佩戴安全帽', seed: 2 }), KERB_W - 0.9, 97.3, H);
  s.place(laneSign({ text: '主干道', double: true }), KERB_W - 1.6, 77.1, 0.03);
  // 两根高杆灯一近一远：西边那根在门厅口，东边那根在卡口外侧。灯头朝东西两边，正好横着照亮整条路
  mast(s, -28.2, 83.4, 0, [[0.9, -0.55], [0.9, 0.55]]);
  mast(s, -8.0, 78.9, 0, [[-0.9, -0.55], [-0.9, 0.55]]);
  // 西侧：一台发电机拖着一盏投光灯照着卡口（转 0.38 弧度后，灯朝东北方照）；再往里是一只垃圾箱和一只油桶
  generatorSet(s, -29.3, 91.4, 0.38);
  s.place(dumpster({ color: 'green' }), -30.1, 95.6, H - 0.04);
  s.place(barrel({ color: 'yellow' }), -29.6, 98.2, 0.5);
  // 东侧：一只配电箱，电缆贴着围栏拖到高杆灯脚下；一摞轮胎
  s.place(distributionBox(), -5.3, 86.1, -H + 0.05);
  cable(s, [[-5.65, 86.0], [-6.5, 83.6], [-7.4, 81.2], [-7.9, 79.5]], 0.03);
  s.place(tireStack({ count: 4 }), -5.8, 92.3, 0.1);

  // ---------------------------------------------------------------- 门厅两边的场地：贴着南围墙的两处料场
  // 西边：钢管、钢筋、料笼
  s.place(pipeStack(), -46, 98.3, 0.03);
  s.place(rebarBundle(), -52.6, 98.6, 0.04);
  s.place(rebarCage({ color: 'blue' }), -40.4, 98.2, H + 0.03);
  // 东边：一对废料斗
  s.place(scrapBin({ color: 'red' }), 3.0, 98.9, 0.1);
  s.place(scrapBin({ color: 'blue' }), 4.3, 98.7, -0.15);
}
