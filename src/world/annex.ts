import { emissive } from '../render/surfaces';
import { Kit, type PropModel, type Rgb } from './kit';

// 车间北边的附属库房（三号库）。
//
// 它是"布景"：进不去，碰撞就是一个大盒子。但它离玩家很近，不能只是一个刷了颜色的方块，
// 所以照车间的思路给它几样"建筑该有的东西"：水泥墙裙、一张张深浅不同的波纹板、三樘卷帘门、
// 门边的防撞条、落水管、屋顶上的风机。这些东西加起来不到一千个三角形。

const W = 28, D = 22, H = 8.2;      // 沿 x 28 米、沿 z 22 米、檐口高 8.2 米
const SKIRT = 1.1;                  // 水泥墙裙的高度：叉车撞的是它，不是薄铁皮
const BLUE: Rgb = [0.5, 0.6, 0.72]; // 墙板的颜色：偏蓝的灰，和车间的本色镀锌板区分开

export function buildAnnex(): PropModel {
  const k = new Kit('annex', 3);
  const x1 = W / 2, z1 = D / 2;

  k.box('concrete_dirty', W + 0.1, SKIRT, D + 0.1, 0, SKIRT / 2, 0, { c: 0.03 });
  // 墙板：每面墙切成 4 米左右一张，每张的深浅随机差一点 —— 真的铁皮房就是一张张钉上去的，不会是一整块
  const sheets = (along: 'x' | 'z', len: number, fixed: number) => {
    const n = Math.round(len / 4), w = len / n;
    for (let i = 0; i < n; i++) {
      const p = -len / 2 + (i + 0.5) * w, shade = k.range(0.82, 1.05);
      const tint: Rgb = [BLUE[0] * shade, BLUE[1] * shade, BLUE[2] * shade];
      if (along === 'x') k.box('corrugated_roof', w - 0.01, H - SKIRT, 0.06, p, (H + SKIRT) / 2, fixed, { tint, plain: true });
      else k.box('corrugated_roof', 0.06, H - SKIRT, w - 0.01, fixed, (H + SKIRT) / 2, p, { tint, plain: true });
    }
  };
  sheets('z', D, x1); sheets('z', D, -x1); sheets('x', W, z1); sheets('x', W, -z1);
  // 四个墙角的包角板和檐口的收边：把板与板的接缝盖住
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box('steel_dark', 0.16, H - SKIRT, 0.16, sx * x1, (H + SKIRT) / 2, sz * z1, { tint: 0.8 });
  k.box('steel_dark', W + 0.3, 0.22, D + 0.3, 0, H + 0.02, 0, { tint: 0.7 });
  // 屋面：比檐口略低的一块平板（从地面看不到，无人机飞过时能看到）
  k.box('corrugated_roof', W - 0.2, 0.08, D - 0.2, 0, H - 0.1, 0, { tint: 0.6, plain: true });

  // 东墙（朝堆场）：三樘卷帘门
  const DOOR_W = 4.2, DOOR_H = 4.6;
  [-7, 0, 7].forEach((z, i) => {
    // grain: 'y' 把波纹转成横的 —— 卷帘门的帘片是一条条横着的
    k.box('corrugated_roof', 0.05, DOOR_H, DOOR_W, x1 + 0.035, DOOR_H / 2, z, { tint: [0.62, 0.6, 0.55], grain: 'y', plain: true });
    k.box('steel_dark', 0.14, 0.34, DOOR_W + 0.5, x1 + 0.07, DOOR_H + 0.17, z, { tint: 0.75 });            // 卷帘盒
    for (const s of [-1, 1]) {
      k.box('steel_dark', 0.12, DOOR_H, 0.14, x1 + 0.06, DOOR_H / 2, z + s * (DOOR_W / 2 + 0.07), { tint: 0.85 });   // 门框导轨
      k.box('hazard_stripes', 0.03, 1.2, 0.14, x1 + 0.13, 0.6, z + s * (DOOR_W / 2 + 0.07), { plain: true });       // 贴在导轨下半截的防撞条
    }
    k.box('paint_yellow', 0.3, 0.16, DOOR_W, x1 + 0.18, 0.08, z, { c: 0.03 });                                // 门槛前的护坎
    k.label(String(i + 1), { color: 'white', font: 'stencil' }, 1.2, 1.1, [x1 + 0.04, DOOR_H + 1.25, z], [0, Math.PI / 2, 0]);
    // 门头灯：一只朝下的壁灯
    k.box('steel_dark', 0.3, 0.1, 0.36, x1 + 0.18, DOOR_H + 0.62, z, { tint: 0.6 });
    k.box(emissive(0xffe3bd, 5), 0.2, 0.02, 0.26, x1 + 0.18, DOOR_H + 0.56, z, { raw: true, cast: false, plain: true });
  });
  k.label('三号库房', { color: 'white', font: 'stencil', distress: 0.5 }, 9, 1.3, [x1 + 0.04, 7.0, 0], [0, Math.PI / 2, 0]);
  // 南墙（对着车间的夹道）：一扇小门，一盏灯
  k.box('paint_grey', 1.0, 2.1, 0.05, 8, 1.05, z1 + 0.035, { c: 0.01 });
  k.box('steel_dark', 1.14, 2.2, 0.03, 8, 1.1, z1 + 0.02, { tint: 0.7, plain: true });
  k.box('steel_bare', 0.04, 0.14, 0.05, 8.38, 1.05, z1 + 0.07, { plain: true });
  k.box(emissive(0xffe3bd, 4), 0.3, 0.1, 0.03, 8, 2.5, z1 + 0.06, { raw: true, cast: false, plain: true });
  // 落水管：从檐口顺着墙角下来，底下一个弯头
  for (const [x, z] of [[x1 + 0.1, z1 - 0.5], [x1 + 0.1, -z1 + 0.5], [-x1 - 0.1, z1 - 0.5]] as const) {
    k.cyl('steel_galv', 0.06, H - 0.3, x, (H + 0.3) / 2, z, { seg: 8, tint: 0.85 });
    for (const y of [1.6, 4.2, 6.8]) k.box('steel_dark', 0.18, 0.05, 0.18, x, y, z, { plain: true });
  }
  // 屋顶的两台风机和一根排气管：给屋顶的轮廓线加一点起伏
  for (const [x, z] of [[-6, -4], [5, 3]] as const) {
    k.box('steel_galv', 2.2, 1.1, 1.6, x, H + 0.68, z, { c: 0.03, tint: 0.8 });
    k.cyl('steel_dark', 0.5, 0.12, x, H + 1.28, z, { seg: 14, tint: 0.6 });
  }
  k.cyl('steel_galv', 0.16, 1.8, 10, H + 0.9, -7, { seg: 10, tint: 0.7 });

  return k.finish({ size: [W, H, D], boxes: [{ min: [-x1 - 0.05, 0, -z1 - 0.05], max: [x1 + 0.05, H + 0.2, z1 + 0.05], surface: 'metal' }] });
}
