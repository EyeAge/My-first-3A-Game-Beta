import { GEN_PAINT_LAYERS } from './texgen-lib';

// 每种质感的贴图怎么"算"出来：一种质感一个 surf(uv) 函数。
// uv 是这个像素在贴图上的位置（0..1），函数的最后调 emit(颜色, 透明度/染色量, 高度, 遮蔽, 粗糙度, 金属度)。
// 噪声、Voronoi、划痕这些工具在 texgen-lib.ts 里。
//
// 读的时候记住几个到处都在用的名字：
//   big / mid / fine   三种尺度的噪声：大片的深浅、中等的斑驳、细碎的颗粒
//   col                颜色（不染色的质感用）
//   overlay / tintAmt  不染色的覆盖物 / 还剩多少"漆"（染色的质感用，见 texgen-lib.ts 里 COVER 的说明）
//   h / r / ao         高度 / 粗糙度 / 遮蔽
// 噪声的频率都是"一张图里起伏几次"；要换算成真实尺寸，用这张图铺多少米（texgen.ts 里的 tile）去除。
// fbm 的最后一个参数是随机种子：同一个函数里每处用不同的种子，各层噪声才互不相干。

export const GEN_SURF = {
  // 沥青路面。两层大小不同的石子嵌在黑色的沥青胶里；磨损大的地方石子露得更多更亮；
  // 另有弯弯曲曲的灌缝胶带和油渍。贴图 2 米一张：大石子约 18 毫米，小石子约 9 毫米。
  asphalt: /* glsl */ `
void surf(vec2 uv){
  // 两层石子：一张图横竖各 110 颗（大）和 230 颗（小）
  vec4 a = voronoi(uv * 110.0, vec2(110.0), 1.0);
  vec4 b = voronoi(uv * 230.0 + 3.0, vec2(230.0), 2.0);
  float big = fbm(uv, vec2(3.0), 4, 5.0), mid = fbm(uv, vec2(24.0), 4, 6.0), fine = fbm(uv, vec2(300.0), 2, 7.0);
  // 高频噪声，用来把石子的轮廓啃得不那么圆
  float jag = fbm(uv, vec2(420.0), 2, 8.0) - 0.5;
  // sa / sb：这个像素在不在大 / 小石子上。只有 62% / 85% 的格子里真有石子
  float sa = smoothstep(0.46, 0.3, a.x + jag * 0.3 - (a.y - a.x) * 0.2 + (1.0 - a.w) * 0.12) * step(a.z, 0.62);
  float sb = smoothstep(0.46, 0.3, b.x + jag * 0.2 + (1.0 - b.w) * 0.15) * step(b.z, 0.85);
  // 高度：石子凸出来，每颗凸得不一样高
  float h = max(sa * (0.45 + 0.55 * a.w), sb * 0.5 * (0.5 + 0.5 * b.w));
  h = h * 0.6 + fine * 0.3 + mid * 0.1;
  // 磨损大的区域（车常压的地方）：沥青胶被磨掉，石子露得更多
  float wearK = smoothstep(0.3, 0.7, big);
  float stone = sat(max(sa, sb * 0.8));
  // 石子的颜色：深灰到浅灰，少数偏褐
  vec3 stA = mix(srgb(0.28, 0.28, 0.29), srgb(0.45, 0.43, 0.41), a.w); stA = mix(stA, srgb(0.42, 0.35, 0.28), step(0.9, a.z * 0.5 + a.w * 0.6));
  vec3 stB = mix(srgb(0.26, 0.26, 0.28), srgb(0.44, 0.43, 0.42), b.w);
  // 沥青胶：接近黑色
  vec3 col = srgb(0.13, 0.13, 0.135) * (0.8 + 0.4 * mid);
  col = mix(col, stB, sb * 0.7 * (0.45 + 0.55 * wearK));
  col = mix(col, stA, sa * (0.5 + 0.45 * wearK));
  col *= 0.8 + 0.4 * big;
  // 灌缝胶带：取一条低频噪声的"等高线"当裂缝的走向，沿线涂一道又黑又亮的胶
  float cn = fbm(uv + vec2(0.13, 0.4), vec2(2.0), 3, 9.0);
  float band = smoothstep(0.016, 0.009, abs(cn - 0.5) + (fbm(uv, vec2(70.0), 2, 13.0) - 0.5) * 0.008) * smoothstep(0.4, 0.6, fbm(uv, vec2(2.0), 2, 12.0));
  col = mix(col, srgb(0.075, 0.075, 0.08), band * 0.93);
  h = mix(h, 0.74 + fine * 0.05 + sa * 0.04, band * 0.88);
  float r = mix(0.93, 0.74, stone * (0.4 + 0.6 * wearK)); r = mix(r, 0.36, band);
  // 油渍：颜色压暗，表面变亮
  float oil = smoothstep(0.72, 0.86, fbm(uv + 0.5, vec2(5.0), 4, 14.0)); col *= 1.0 - oil * 0.45; r = mix(r, 0.5, oil * 0.6);
  // 遮蔽：石子之间的凹处暗一些
  emit(col, 1.0, h, mix(0.55, 1.0, smoothstep(0.0, 0.6, h)), r, 0.0);
}
`,

  // 混凝土。3 米一块板（板缝画在贴图的四条边上），有气孔、裂缝、崩口（露出里面的骨料）、水渍和泛碱。
  // alpha 通道另有用处：存"如果刷了漆，这里漆还在不在"，给"刷漆混凝土"那种材质用。
  concrete: /* glsl */ `
void surf(vec2 uv){
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 5, 2.0), fine = fbm(uv, vec2(180.0), 3, 3.0);
  // 模板留下的横向条痕
  float form = fbm(uv, vec2(2.0, 7.0), 5, 4.0);
  // 气孔：大的（70 格，35% 有孔）和小的（260 格，一半有孔）
  vec4 po = voronoi(uv * 70.0, vec2(70.0), 5.0); float pore = step(po.z, 0.35) * smoothstep(0.16 * po.w + 0.03, 0.02, po.x);
  vec4 po2 = voronoi(uv * 260.0, vec2(260.0), 6.0); float pore2 = step(po2.z, 0.5) * smoothstep(0.3 * po2.w, 0.05, po2.x);
  // 裂缝：先把坐标用噪声扭一扭，再取 3×3 格 Voronoi 的边界（到最近两个点几乎一样远的地方）—— 扭过以后边界就不是直线了
  vec2 wu = uv + (vec2(fbm(uv, vec2(6.0), 3, 7.0), fbm(uv, vec2(6.0), 3, 8.0)) - 0.5) * 0.12 + (vec2(fbm(uv, vec2(48.0), 3, 17.0), fbm(uv, vec2(48.0), 3, 18.0)) - 0.5) * 0.022;
  vec4 cr = voronoi(wu * 3.0, vec2(3.0), 9.0);
  float crack = smoothstep(0.0045, 0.0012, cr.y - cr.x) * smoothstep(0.45, 0.6, fbm(uv, vec2(3.0), 2, 10.0));
  // 崩口：表皮掉了一块，露出里面的石子（骨料）
  float chip = smoothstep(0.83, 0.87, fbm(uv, vec2(7.0), 4, 11.0) + (fine - 0.5) * 0.08 + (mid - 0.5) * 0.06);
  vec4 ag = voronoi(uv * 140.0, vec2(140.0), 12.0); float stone = smoothstep(0.5, 0.3, ag.x) * step(ag.z, 0.6);
  // 板缝：离贴图四边的距离。缝本身 4–7 毫米宽，缝两边 20 厘米内有顺着缝渗出来的污渍
  vec2 dj = min(uv, 1.0 - uv); float jd = min(dj.x, dj.y);
  float joint = smoothstep(0.0022, 0.0012, jd), jstain = smoothstep(0.07, 0.0, jd + (mid - 0.5) * 0.04);
  // 高度：气孔、裂缝、崩口、板缝都是凹下去的
  float h = 0.6 + (mid - 0.5) * 0.25 + (fine - 0.5) * 0.12 + (form - 0.5) * 0.06;
  h -= pore * 0.35 + pore2 * 0.08 + crack * 0.2; h = mix(h, 0.42 + stone * 0.12 + fine * 0.08, chip); h = mix(h, 0.05, joint);
  // 底色：灰，带一点冷暖漂移
  vec3 col = srgb(0.53, 0.52, 0.49) * (0.72 + 0.4 * big + 0.22 * (mid - 0.5) + 0.08 * (form - 0.5));
  col *= mix(vec3(1.04, 1.0, 0.94), vec3(0.95, 1.0, 1.05), fbm(uv, vec2(3.0), 3, 13.0));
  // st 水渍（变暗），ef 泛碱（发白的盐霜）
  float st = smoothstep(0.55, 0.8, fbm(uv, vec2(4.0), 5, 14.0)); col *= 1.0 - st * 0.3;
  float ef = smoothstep(0.66, 0.85, fbm(uv, vec2(5.0), 4, 15.0)) * sat(fine * 1.6 - 0.2); col = mix(col, srgb(0.68, 0.67, 0.64), ef * 0.22);
  col *= 1.0 - pore * 0.5 - pore2 * 0.2 - crack * 0.6;
  // 骨料的颜色
  vec3 agc = mix(srgb(0.38, 0.37, 0.35), srgb(0.54, 0.52, 0.47), ag.w); agc = mix(agc, srgb(0.46, 0.41, 0.34), step(0.45, ag.z));
  col = mix(col, mix(srgb(0.4, 0.39, 0.37) * (0.8 + 0.4 * fine), agc, stone * 0.8), chip);
  col *= 1.0 - jstain * 0.25; col = mix(col, srgb(0.1, 0.1, 0.1), joint);
  float r = 0.82 + (mid - 0.5) * 0.2 - (form - 0.5) * 0.15; r = mix(r, 0.95, chip); r = mix(r, 0.62, st * 0.3);
  float ao = 1.0 - pore * 0.5 - crack * 0.5 - joint * 0.6 - chip * 0.15;
  // 刷漆覆盖率：漆在崩口、裂缝、气孔处是掉的
  float pa = smoothstep(0.40, 0.47, fbm(uv, vec2(9.0), 5, 16.0) + (mid - 0.5) * 0.2) * (1.0 - chip) * (1.0 - crack) * (1.0 - pore);
  emit(col, pa, h, ao, r, 0.0);
}
`,

  // 砖墙。一张图 24 行 × 8 列，砖 225 × 75 毫米，隔行错半块；灰缝约 1 厘米。每块砖颜色略有不同。
  brick: /* glsl */ `
void surf(vec2 uv){
  // 算出这个像素在第几行第几列的砖上；奇数行横向错开半块
  float rows = 24.0, cols = 8.0; float y = uv.y * rows; float row = floor(y); float x = uv.x * cols + 0.5 * mod(row, 2.0); float cl = floor(x);
  vec2 f = vec2(fract(x), fract(y)); vec3 id = hash3(vec2(cl, row), vec2(cols, rows), 1.0);
  float ed = fbm(uv, vec2(60.0), 3, 2.0);
  // 到砖边的距离（毫米）。灰缝的宽度用噪声抖一抖，砖的边就不是笔直的
  vec2 d = min(f, 1.0 - f) * vec2(225.0, 75.0);
  float mort = 5.0 + (ed - 0.5) * 5.0; float dm = min(d.x, d.y); float brick = smoothstep(mort, mort + 3.0, dm);
  float fine = fbm(uv, vec2(200.0), 3, 3.0), mid = fbm(uv, vec2(30.0), 4, 4.0);
  // 每块砖从几种红褐色里随机挑
  vec3 c = mix(srgb(0.52, 0.27, 0.2), srgb(0.42, 0.2, 0.15), id.x); c = mix(c, srgb(0.3, 0.17, 0.15), smoothstep(0.75, 1.0, id.y)); c = mix(c, srgb(0.58, 0.38, 0.26), smoothstep(0.85, 1.0, id.z));
  c *= (0.8 + 0.4 * mid) * (0.9 + 0.2 * fine);
  // 麻坑
  float pit = smoothstep(0.7, 0.8, fbm(uv, vec2(90.0), 3, 5.0)); c *= 1.0 - pit * 0.35;
  // mc 灰缝的颜色；soot 大片的烟熏；ef 泛碱
  vec3 mc = srgb(0.5, 0.48, 0.44) * (0.75 + 0.5 * fine);
  float soot = smoothstep(0.5, 0.8, fbm(uv, vec2(3.0), 4, 6.0));
  vec3 col = mix(mc, c, brick) * (1.0 - soot * 0.35);
  float ef = smoothstep(0.7, 0.85, fbm(uv, vec2(5.0), 4, 7.0)) * brick; col = mix(col, srgb(0.7, 0.68, 0.64), ef * 0.3);
  // 高度：缝 0.25，砖面 0.7 上下
  float h = mix(0.25 + fine * 0.1, 0.7 + (mid - 0.5) * 0.15 + (fine - 0.5) * 0.1 - pit * 0.2 + (id.x - 0.5) * 0.12, brick);
  emit(col, 1.0, h, mix(0.6, 1.0, brick) * (1.0 - pit * 0.3), mix(0.95, 0.86 + (mid - 0.5) * 0.15, brick), 0.0);
}
`,

  // 仓库的环氧地坪：灰绿色。封闭剂还在的地方亮得像镜子，车道上被磨哑了；
  // 有几道弯曲的轮胎印、各个方向的划痕和少量崩口。
  epoxy: /* glsl */ `
void surf(vec2 uv){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(20.0), 4, 2.0), fine = fbm(uv, vec2(250.0), 2, 3.0), mott = fbm(uv, vec2(9.0), 5, 11.0);
  vec3 col = srgb(0.41, 0.445, 0.435) * (0.78 + 0.3 * big + 0.22 * (mott - 0.5));
  col *= mix(vec3(1.03, 1.0, 0.97), vec3(0.95, 1.0, 1.03), fbm(uv, vec2(2.0), 3, 19.0));
  // 细骨料的斑点
  vec4 ag = voronoi(uv * 180.0, vec2(180.0), 12.0); col *= 1.0 + (ag.w - 0.5) * 0.14 * smoothstep(0.5, 0.2, ag.x);
  // gloss：封闭剂还在；lane：常走车的带子被磨哑。两者决定 worn（哑的程度）
  float gloss = smoothstep(0.35, 0.62, fbm(uv, vec2(5.0), 5, 4.0));          // sealer still intact
  float lane = smoothstep(0.35, 0.65, fbm(uv, vec2(1.0, 3.0), 3, 13.0));     // traffic lanes worn matt
  float worn = sat(1.0 - gloss * 0.85 + lane * 0.45 - 0.15);
  // 两层全方向的划痕
  float sc1 = scratches(uv, 14.0, 5.0, 0.012, 0.5, 6.3, 0.7), sc2 = scratches(uv, 40.0, 6.0, 0.02, 0.0, 6.3, 0.5);
  // 四道弯曲的轮胎印：到四条正弦曲线的距离
  float t1 = abs(uv.y - 0.31 - 0.06 * sin(uv.x * TAU)), t2 = abs(uv.x - 0.62 - 0.09 * sin(uv.y * TAU + 1.0));
  float t3 = abs(uv.y - 0.74 - 0.1 * sin(uv.x * TAU * 2.0 + 2.0)), t4 = abs(uv.x - 0.2 - 0.05 * sin(uv.y * TAU + 4.0));
  // 胎纹：斜向的细条
  float tread = 0.6 + 0.4 * sin((uv.x + uv.y) * TAU * 90.0);
  float tm = smoothstep(0.022, 0.016, t1) * smoothstep(0.35, 0.6, fbm(uv, vec2(8.0), 3, 7.0)) + smoothstep(0.02, 0.014, t2) * smoothstep(0.4, 0.65, fbm(uv, vec2(6.0), 3, 8.0))
           + smoothstep(0.026, 0.018, t3) * smoothstep(0.45, 0.7, fbm(uv, vec2(5.0), 3, 14.0)) + smoothstep(0.018, 0.012, t4) * smoothstep(0.4, 0.65, fbm(uv, vec2(7.0), 3, 15.0));
  tm = sat(tm * tread);
  // 胎印是黑的、哑的
  col = mix(col, srgb(0.1, 0.1, 0.105), tm * 0.75);
  col *= 1.0 - worn * 0.1; col = mix(col, col * 1.25, sc1 * 0.4);
  float dirt = smoothstep(0.55, 0.85, fbm(uv, vec2(2.0), 4, 9.0)); col = mix(col, srgb(0.3, 0.29, 0.26), dirt * 0.3);
  // 粗糙度从 0.1（镜面）到 0.52（磨哑）
  float r = mix(0.1, 0.52, worn) + sc1 * 0.2 + sc2 * 0.15 + tm * 0.3 + dirt * 0.2 + (mid - 0.5) * 0.12 + (mott - 0.5) * 0.1;
  float h = 0.5 + (fine - 0.5) * 0.05 + (mid - 0.5) * 0.06 - sc1 * 0.2 - sc2 * 0.08 + tm * 0.05 + (gloss - 0.5) * 0.03;
  // 崩口：露出底下的混凝土
  float chip = smoothstep(0.87, 0.9, fbm(uv, vec2(14.0), 5, 10.0) + (fine - 0.5) * 0.06); col = mix(col, srgb(0.44, 0.44, 0.43) * (0.75 + 0.5 * fine), chip); h -= chip * 0.3; r = mix(r, 0.85, chip);
  emit(col, 1.0, h, 1.0 - chip * 0.2, r, 0.0);
}
`,

  // 漆面。八种颜色的漆共用这一张：漆本身不带颜色（颜色来自材质），贴图里画的是掉漆、底漆、锈和灰尘。
  // uParam.x 是损伤量。
  paint: /* glsl */ `
void surf(vec2 uv){
  float chip, stain, run; paintDamage(uv, uParam.x, chip, stain, run);
  // shade：染色量的基数；baseR：干净漆面的粗糙度
  float shade = 0.8, baseR = 0.40;
  ${GEN_PAINT_LAYERS}
  emit(overlay, tintAmt, h, ao, r, m);
}
`,

  // 黄黑警示斜纹：和漆面同一套损伤，只是损伤更重（1.4），而且颜色直接画在贴图里（不染色）。
  // 1 米一张，条纹宽约 7 厘米。
  hazard: /* glsl */ `
void surf(vec2 uv){
  float chip, stain, run; paintDamage(uv, 1.4, chip, stain, run);
  float shade = 1.0, baseR = 0.5;
  ${GEN_PAINT_LAYERS}
  // 斜纹：沿 u+v 方向每张图 5 个周期，一半黄一半黑，边缘用噪声抖一点
  float s = fract((uv.x + uv.y) * 5.0);
  float yel = smoothstep(0.244, 0.256, abs(s - 0.5) + (fbm(uv, vec2(80.0), 2, 41.0) - 0.5) * 0.02);
  vec3 pc = mix(srgb(0.1, 0.1, 0.11), srgb(0.86, 0.66, 0.1), yel);
  // 颜色 = 覆盖物 + 条纹色 × 还剩的漆
  emit(overlay + pc * tintAmt, 1.0, h, ao, r, m);
}
`,

  // 船壳钢板。4 米一张：两排 4×2 米的钢板，竖缝隔行错开；焊缝隆起并带鱼鳞纹；
  // 肋骨之间的板微微凹陷；锈从焊缝和锈斑往下淌。
  hull: /* glsl */ `
void surf(vec2 uv){
  // 这个像素在第几排钢板；dseam 是到最近焊缝的距离（已换算成米）
  float ry = uv.y * 2.0; float row = floor(ry); float fy = fract(ry); float sx = fract(uv.x + 0.5 * mod(row, 2.0));
  float dh = min(fy, 1.0 - fy) * 2.0, dv = min(sx, 1.0 - sx) * 4.0; float dseam = min(dh, dv);
  float wn = fbm(uv, vec2(200.0), 2, 1.0);
  // 焊道：离缝 4–12 毫米内隆起，上面有细密的鱼鳞纹
  float bead = smoothstep(0.012, 0.004, dseam + (wn - 0.5) * 0.004);
  float ripple = 0.75 + 0.25 * sin((uv.x + uv.y) * TAU * 400.0);
  // 肋骨之间的凹陷：每 0.5 米一道
  float dish = cos(uv.x * TAU * 8.0) * 0.5 + 0.5;
  float big = fbm(uv, vec2(2.0), 4, 2.0), mid = fbm(uv, vec2(14.0), 4, 3.0), fine = fbm(uv, vec2(220.0), 2, 4.0);
  // 滚涂留下的细纹
  float roller = fbm(uv, vec2(120.0, 30.0), 3, 5.0);
  float seamK = smoothstep(0.12, 0.0, dseam);
  float pit = fbm(uv, vec2(70.0), 4, 7.0);
  // 锈斑：焊缝附近更容易出
  float rust = smoothstep(0.72, 0.79, fbm(uv, vec2(10.0), 5, 6.0) + seamK * 0.2);
  rust *= smoothstep(0.3, 0.5, pit + rust * 0.3);
  float streak = fbm(uv, vec2(110.0, 1.0), 3, 8.0);
  // 锈水：往上看四步（每步 12 厘米），上方有焊缝或锈斑，这里就有流痕
  float wp = 0.0;
  for (int i = 1; i <= 4; i++){
    vec2 q = uv + vec2(0.0, float(i) * 0.03); float qy = fract(q.y * 2.0);
    float qs = smoothstep(0.02, 0.0, min(qy, 1.0 - qy) * 2.0); float qr = smoothstep(0.72, 0.79, fbm(q, vec2(10.0), 5, 6.0));
    wp = max(wp, max(qs * 0.7, qr) * (1.0 - float(i) / 5.0));
  }
  float weep = wp * smoothstep(0.4, 0.75, streak);
  // 盐霜
  float salt = smoothstep(0.6, 0.85, fbm(uv, vec2(3.0, 9.0), 4, 9.0));
  vec3 overlay = vec3(0.0); float tintAmt = 0.82 * (0.88 + 0.2 * (big - 0.5) + 0.14 * (mid - 0.5) + 0.08 * (roller - 0.5));
  COVER(vec3(0.6), salt * 0.025 * (0.5 + roller));
  COVER(srgb(0.45, 0.27, 0.14), weep * 0.7);
  COVER(mix(srgb(0.25, 0.16, 0.11), srgb(0.5, 0.31, 0.17), pit), rust);
  // 高度
  float h = 0.5 + (roller - 0.5) * 0.05 + (fine - 0.5) * 0.03 + bead * 0.35 * ripple + (dish - 0.5) * 0.1 - rust * 0.08 * (1.0 - pit);
  float r = 0.5 + (mid - 0.5) * 0.15 + salt * 0.2; r = mix(r, 0.9, rust); r = mix(r, 0.7, weep * 0.5);
  emit(overlay, tintAmt, h, 1.0 - rust * 0.2 - smoothstep(0.03, 0.012, dseam) * (1.0 - bead) * 0.3, r, rust * 0.1);
}
`,

  // 镀锌钢。表面是一片片大小不一的锌花（结晶），每片亮度不同；有发白的"白锈"和少量红锈。
  galv: /* glsl */ `
void surf(vec2 uv){
  // 锌花：两层 Voronoi（22 格和 50 格），坐标先扭一下让晶界不那么规则
  vec2 wu = uv + (vec2(fbm(uv, vec2(8.0), 2, 1.0), fbm(uv, vec2(8.0), 2, 2.0)) - 0.5) * 0.03;
  vec4 a = voronoi(wu * 22.0, vec2(22.0), 3.0); vec4 b = voronoi(wu * 50.0 + 1.5, vec2(50.0), 4.0);
  // sp：每片晶体自己的亮度；edge：在晶界上为 0
  float sp = mix(a.w, b.w, 0.35);
  float edge = smoothstep(0.0, 0.08, a.y - a.x);
  float big = fbm(uv, vec2(2.0), 4, 5.0), fine = fbm(uv, vec2(200.0), 2, 6.0), mid = fbm(uv, vec2(20.0), 4, 7.0);
  vec3 col = vec3(0.56, 0.58, 0.6) * (0.72 + 0.4 * sp) * (0.92 + 0.16 * big);
  // 白锈：锌的氧化物，发白、不反光
  float wr = smoothstep(0.55, 0.85, fbm(uv, vec2(6.0), 5, 8.0)) * (0.4 + 0.6 * fbm(uv, vec2(90.0), 3, 10.0));
  col = mix(col, srgb(0.74, 0.74, 0.72), wr * 0.4);
  // 红锈：锌层破了，底下的铁锈出来
  float rs = rustMask(uv, vec2(9.0), 0.8, 9.0);
  col = mix(col, srgb(0.42, 0.27, 0.16) * (0.7 + 0.6 * fine), rs);
  float r = 0.3 + 0.28 * sp + (mid - 0.5) * 0.15 + wr * 0.3; r = mix(r, 0.9, rs);
  float h = 0.5 + (sp - 0.5) * 0.08 * edge + (fine - 0.5) * 0.04 + wr * 0.05 * fine - (1.0 - edge) * 0.03;
  // 金属度：白锈和红锈的地方不再是金属
  emit(col, 1.0, h, 1.0, r, 1.0 - wr * 0.45 - rs * 0.9);
}
`,

  // 通用钢（染色）：钢板、钢管、设备外壳。有三层全方向的划痕、手印似的光泽变化、氧化皮和锈斑。
  // uParam.x 是锈量。
  metal: /* glsl */ `
void surf(vec2 uv){
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(18.0), 4, 2.0), fine = fbm(uv, vec2(240.0), 2, 3.0);
  // 手印 / 油污：只影响光泽
  float smudge = fbm(uv, vec2(5.0, 7.0), 5, 4.0);
  // 三层划痕：粗而稀、中等、细而密
  float s1 = scratches(uv, 9.0, 5.0, 0.006, 0.2, 6.3, 0.6), s2 = scratches(uv, 30.0, 6.0, 0.012, 1.0, 6.3, 0.5), s3 = scratches(uv, 70.0, 7.0, 0.03, 2.0, 6.3, 0.4);
  float sc = sat(max(s1, max(s2 * 0.8, s3 * 0.5)));
  // 锈斑
  float rust = rustMask(uv, vec2(12.0), 0.74, 8.0) * uParam.x;
  // 氧化皮：略暗略涩的片区
  float scale_ = smoothstep(0.4, 0.7, fbm(uv, vec2(7.0), 4, 10.0));
  vec3 overlay = vec3(0.0); float tintAmt = 0.95 * (0.85 + 0.2 * (big - 0.5) + 0.16 * (mid - 0.5)) * (1.0 - scale_ * 0.18);
  // 划痕里露出亮钢；锈盖住一切
  COVER(vec3(0.55, 0.56, 0.58), sc * 0.3);
  COVER(mix(srgb(0.27, 0.17, 0.12), srgb(0.5, 0.31, 0.17), fbm(uv, vec2(90.0), 3, 11.0)), rust);
  float r = 0.42 + (smudge - 0.5) * 0.3 + (mid - 0.5) * 0.1 - sc * 0.15 + scale_ * 0.08; r = mix(r, 0.9, rust);
  float h = 0.5 + (fine - 0.5) * 0.04 + (mid - 0.5) * 0.04 - sc * 0.12 + rust * 0.08 * fine;
  emit(overlay, tintAmt, h, 1.0 - rust * 0.2, r, 1.0 - rust * 0.85);
}
`,

  // 拉丝金属（染色）：裸钢、铝、黄铜。丝纹是极度拉长的噪声 ——
  // 沿 U 方向一张图只变化几次，沿 V 方向变化几百次。
  brushed: /* glsl */ `
void surf(vec2 uv){
  // 三层丝纹
  float l1 = fbm(uv, vec2(2.0, 300.0), 3, 1.0), l2 = fbm(uv, vec2(6.0, 120.0), 3, 2.0), l3 = fbm(uv, vec2(1.0, 500.0), 2, 12.0);
  float big = fbm(uv, vec2(3.0), 4, 3.0), smudge = fbm(uv, vec2(6.0), 5, 4.0);
  float sc = scratches(uv, 12.0, 5.0, 0.008, 0.6, 6.3, 0.4);
  // 发乌的片区（轻微氧化）
  float tar = smoothstep(0.45, 0.9, fbm(uv, vec2(5.0), 5, 6.0));
  vec3 overlay = vec3(0.0); float tintAmt = 0.95 * (0.82 + 0.16 * (l1 - 0.5) + 0.14 * (l2 - 0.5) + 0.1 * (big - 0.5)) * (1.0 - tar * 0.13);
  COVER(vec3(0.7), sc * 0.2);
  float r = 0.3 + (l1 - 0.5) * 0.2 + (smudge - 0.5) * 0.2 + tar * 0.18 - sc * 0.08;
  float h = 0.5 + (l1 - 0.5) * 0.2 + (l3 - 0.5) * 0.2 + (l2 - 0.5) * 0.1 - sc * 0.2;
  emit(overlay, tintAmt, h, 1.0, r, 1.0);
}
`,

  // 全锈的钢。锈是一层层起皮的：把噪声切成 4 级台阶，台阶的边缘就是翘起的锈皮；
  // 另有锈坑、锈粒，和少量还没锈透的氧化皮。
  rust: /* glsl */ `
void surf(vec2 uv){
  // 先把坐标扭一扭，锈斑的形状更自然
  vec2 wu = uv + (vec2(fbm(uv, vec2(5.0), 3, 1.0), fbm(uv, vec2(5.0), 3, 2.0)) - 0.5) * 0.08;
  float n = fbm(wu, vec2(6.0), 7, 3.0);
  // 层状锈：噪声量化成 4 层。layer 是阶梯状的高度，flakeEdge 是台阶的边
  float fl = fbm(wu, vec2(11.0), 6, 4.0);
  float tf = fract(fl * 4.0); float layer = floor(fl * 4.0) / 4.0 + smoothstep(0.0, 0.45, tf) * 0.25;
  float flakeEdge = smoothstep(0.1, 0.0, tf) * smoothstep(0.4, 0.6, fbm(uv, vec2(9.0), 3, 14.0));
  // 锈坑（70 格）和锈粒（190 格）
  vec4 pv = voronoi(uv * 70.0, vec2(70.0), 5.0); float pit = step(pv.z, 0.5) * smoothstep(0.35 * pv.w + 0.05, 0.03, pv.x);
  vec4 pv2 = voronoi(uv * 190.0, vec2(190.0), 15.0); float speck = smoothstep(0.35, 0.1, pv2.x) * step(pv2.z, 0.4);
  float grain = fbm(uv, vec2(220.0), 3, 6.0);
  // 还没锈透的氧化皮：灰蓝色、较平、较亮
  float scaleI = smoothstep(0.75, 0.8, fbm(wu, vec2(4.0), 5, 7.0) + (grain - 0.5) * 0.1);
  float h = 0.25 + layer * 0.4 + (n - 0.5) * 0.3 + (grain - 0.5) * 0.14 - pit * 0.2 + speck * 0.04;
  h = mix(h, 0.8 + (grain - 0.5) * 0.04, scaleI);
  // 颜色：从深褐到橙到黄，越高（越新）的锈越亮
  float t = sat(layer * 0.5 + n * 0.55 + (grain - 0.5) * 0.35);
  vec3 c = mix(srgb(0.26, 0.17, 0.13), srgb(0.4, 0.25, 0.16), smoothstep(0.25, 0.6, t));
  float bloom = smoothstep(0.55, 0.85, fbm(uv, vec2(7.0), 5, 8.0));
  c = mix(c, srgb(0.55, 0.34, 0.17), bloom * (0.35 + 0.65 * smoothstep(0.4, 0.7, t)));
  c = mix(c, srgb(0.62, 0.45, 0.25), smoothstep(0.7, 0.95, fbm(uv, vec2(34.0), 4, 18.0)) * 0.4);
  c = mix(c, srgb(0.2, 0.14, 0.12), sat(flakeEdge * 0.6 + pit * 0.7));
  c *= (0.8 + 0.4 * grain) * (0.9 + 0.2 * speck);
  // 竖向的流锈
  float streak = fbm(uv, vec2(60.0, 2.0), 3, 9.0); c = mix(c, srgb(0.5, 0.31, 0.17), smoothstep(0.55, 0.8, streak) * 0.2);
  c = mix(c, srgb(0.3, 0.3, 0.33) * (0.8 + 0.4 * grain), scaleI);
  float r = 0.9 + (grain - 0.5) * 0.15 - bloom * 0.06; r = mix(r, 0.55, scaleI);
  emit(c, 1.0, h, 1.0 - pit * 0.4 - flakeEdge * 0.25, r, scaleI * 0.35);
}
`,

  // 花纹钢板（防滑板）。一张图 12×12 格，每格一个菱形凸起，相邻的格子一个朝 +45°、一个朝 −45°。
  // 凸起的顶面被踩亮，凹处积泥。
  diamond: /* glsl */ `
void surf(vec2 uv){
  // 把格子里的坐标转 ±45°，在转过的坐标里量一个细长的椭圆（半轴 0.46 × 0.13 格）
  vec2 p = uv * 12.0; vec2 i = floor(p); vec2 q = fract(p) - 0.5; float par = mod(i.x + i.y, 2.0);
  vec2 d = (par < 0.5 ? vec2(q.x + q.y, q.x - q.y) : vec2(q.x - q.y, q.x + q.y)) * 0.7071;
  float e = length(d * vec2(1.0 / 0.46, 1.0 / 0.13));
  // loz：凸起的范围；top：凸起的顶面
  float loz = smoothstep(1.0, 0.55, e), top = smoothstep(0.75, 0.4, e);
  float big = fbm(uv, vec2(2.0), 4, 1.0), mid = fbm(uv, vec2(16.0), 4, 2.0), fine = fbm(uv, vec2(200.0), 2, 3.0);
  // 常走的地方顶面更亮
  float wear = smoothstep(0.3, 0.7, big);
  // 凹处的泥
  float grime = (1.0 - loz) * smoothstep(0.3, 0.65, fbm(uv, vec2(8.0), 4, 4.0));
  float sc = scratches(uv, 20.0, 5.0, 0.02, 0.0, 6.3, 0.5);
  vec3 col = vec3(0.42, 0.43, 0.45) * (0.85 + 0.3 * (mid - 0.5));
  col = mix(col, vec3(0.68, 0.69, 0.7), top * (0.4 + 0.6 * wear));
  col = mix(col, srgb(0.22, 0.19, 0.16), grime * 0.8);
  float rust = smoothstep(0.7, 0.86, fbm(uv, vec2(10.0), 5, 6.0) + (fine - 0.5) * 0.12) * (1.0 - top) * (0.6 + 0.4 * fine); col = mix(col, srgb(0.42, 0.27, 0.16) * (0.7 + 0.6 * fine), rust);
  float r = 0.5 + (mid - 0.5) * 0.15; r = mix(r, 0.22, top * (0.4 + 0.6 * wear)); r = mix(r, 0.85, grime); r = mix(r, 0.9, rust); r -= sc * 0.1;
  // 高度
  float h = 0.2 + loz * 0.7 + (fine - 0.5) * 0.03 - sc * 0.03 * top;
  emit(col, 1.0, h, mix(1.0, 0.6, smoothstep(1.5, 1.0, e) * (1.0 - loz)), r, 1.0 - grime * 0.8 - rust * 0.9);
}
`,

  // 瓦楞屋面板。0.762 米宽里 10 个波；2.286 米长一张板，板与板搭接处往上是滴水端，容易锈；
  // 每 5 个波峰有一颗自攻钉。
  corrugated: /* glsl */ `
void surf(vec2 uv){
  // 波形：cz 在波峰是 1，波谷是 0
  float w = uv.x * 10.0; float cz = 0.5 + 0.5 * cos(w * TAU);
  float big = fbm(uv, vec2(2.0), 4, 1.0), fine = fbm(uv, vec2(160.0, 480.0), 2, 3.0);
  float streak = fbm(uv, vec2(40.0, 1.0), 3, 6.0), streak2 = fbm(uv, vec2(10.0, 1.0), 3, 16.0);
  // 搭接线，和它上方 32 厘米的锈区
  float lapV = smoothstep(0.004, 0.0015, abs(uv.y - 0.012) * 2.286);
  float lapZone = smoothstep(0.32, 0.0, (uv.y - 0.012) * 2.286) * step(0.012, uv.y);       // drip end of the upper sheet
  // 自攻钉：每 5 个波峰一颗，钉头 6–8 毫米，外面一圈垫圈
  float fi = floor(w + 0.5); float onC = step(mod(fi, 5.0), 0.5);
  float fd = length(vec2((w - fi) / 10.0 * 0.762, (uv.y - 0.5) * 2.286));
  float fast = onC * smoothstep(0.008, 0.006, fd), washer = onC * smoothstep(0.014, 0.011, fd) * (1.0 - fast);
  float rg = fbm(uv, vec2(90.0, 270.0), 3, 15.0);
  float which = smoothstep(0.45, 0.7, fbm(uv, vec2(3.0, 1.0), 3, 5.0));
  // 锈：只在滴水端的一部分区域，顺着竖向条纹
  float rust = smoothstep(0.5, 0.95, lapZone * which * (0.55 + 0.9 * streak) + (rg - 0.5) * 0.22) * (0.5 + 0.5 * rg);
  vec3 col = vec3(0.43, 0.47, 0.52) * (0.9 + 0.2 * (big - 0.5)) * (0.95 + 0.1 * (streak2 - 0.5));
  col = mix(col, vec3(0.6, 0.62, 0.64), smoothstep(0.6, 0.9, streak) * 0.12);
  // 波谷里积的灰
  float dirtV = (1.0 - cz) * smoothstep(0.4, 0.75, fbm(uv, vec2(3.0, 2.0), 4, 7.0)) * 0.5;
  col = mix(col, srgb(0.25, 0.24, 0.22), dirtV * 0.6);
  col = mix(col, mix(srgb(0.24, 0.16, 0.12), srgb(0.42, 0.28, 0.17), rg), rust);
  col = mix(col, vec3(0.5, 0.52, 0.54), fast); col *= 1.0 - washer * 0.4;
  col *= 1.0 - lapV * 0.5;
  // 高度几乎全是波形本身（贴图集的 bump 是 19 毫米，波深约 17 毫米）
  float h = cz * 0.9 + (fine - 0.5) * 0.008 + fast * 0.05 - lapV * 0.03;
  float r = 0.5 + (streak2 - 0.5) * 0.14 + (big - 0.5) * 0.12; r = mix(r, 0.8, dirtV); r = mix(r, 0.92, rust);
  emit(col, 1.0, h, mix(0.72, 1.0, smoothstep(0.0, 0.6, cz)) * (1.0 - lapV * 0.4), r, 0.72 * (1.0 - rust * 0.9) * (1.0 - dirtV * 0.6));
}
`,

  // 铁丝网（带透明）。两组斜线各 7 个周期，交叉处一上一下编在一起。alpha 是"这里有没有铁丝"。
  // 0.5 米一张：丝径约 4.4 毫米。
  chainlink: /* glsl */ `
void surf(vec2 uv){
  // 两组斜线的坐标，和到各自中心线的距离
  float n = 7.0; float a = (uv.x + uv.y) * n, b = (uv.x - uv.y) * n;
  float da = abs(fract(a) - 0.5), db = abs(fract(b) - 0.5);
  float rw = 0.044;
  // 编织：交叉点上按奇偶决定哪一根在上
  float over = mod(floor(a) + floor(b), 2.0) < 0.5 ? 1.0 : -1.0;
  // 铁丝是圆的：截面高度按圆弧算（根号里的数先夹到不小于 0）
  float pa = sqrt(max(0.0, 1.0 - (da / rw) * (da / rw))), pb = sqrt(max(0.0, 1.0 - (db / rw) * (db / rw)));
  float za = over * cos((fract(b) - 0.5) * 3.14159), zb = -over * cos((fract(a) - 0.5) * 3.14159);
  float ha = da < rw ? 0.45 + 0.2 * za + 0.3 * pa : 0.0, hb = db < rw ? 0.45 + 0.2 * zb + 0.3 * pb : 0.0;
  // alpha 的边缘按一个像素的宽度过渡（抗锯齿）
  float px = uTexel * n * 1.41421;
  float alpha = max(smoothstep(rw + px * 0.5, rw - px * 0.5, da), smoothstep(rw + px * 0.5, rw - px * 0.5, db));
  float fine = fbm(uv, vec2(120.0), 3, 1.0);
  vec3 col = vec3(0.6, 0.62, 0.64) * (0.8 + 0.3 * fine);
  float rust = smoothstep(0.62, 0.75, fbm(uv, vec2(9.0), 4, 3.0)); col = mix(col, srgb(0.42, 0.26, 0.15), rust * 0.8);
  emit(col, alpha, max(ha, hb), 1.0, mix(0.4 + 0.2 * fine, 0.9, rust), 1.0 - rust * 0.9);
}
`,

  // 枪灰（染色）：枪身、机械件。细密的颗粒感，磨损处和划痕里露出亮金属，有一层油光。
  // uParam.x 是磨损量。
  gunmetal: /* glsl */ `
void surf(vec2 uv){
  float fine = fbm(uv, vec2(160.0), 3, 1.0), mid = fbm(uv, vec2(12.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  // 细颗粒（磷化层的质感）
  vec4 g = voronoi(uv * 200.0, vec2(200.0), 4.0);
  // 大片的磨损
  float wear = smoothstep(0.66, 0.92, fbm(uv, vec2(4.0), 5, 5.0) + (fine - 0.5) * 0.1) * uParam.x;
  float s1 = scratches(uv, 8.0, 6.0, 0.005, 0.3, 6.3, 0.3), s2 = scratches(uv, 24.0, 7.0, 0.011, 1.2, 6.3, 0.32), s3 = scratches(uv, 60.0, 8.0, 0.03, 0.0, 6.3, 0.3);
  float sc = sat(max(s1 * uParam.x, max(s2 * 0.8, s3 * 0.6)));
  // 磨亮的程度 = 磨损 + 划痕
  float bright = sat(wear * 0.22 + sc * (0.3 + 0.4 * uParam.x));
  // 油光：让表面更亮
  float oil = smoothstep(0.4, 0.75, fbm(uv, vec2(3.0, 5.0), 4, 9.0));
  vec3 overlay = vec3(0.0); float tintAmt = 0.9 * (0.8 + 0.25 * (mid - 0.5) + 0.2 * (g.w - 0.5) + 0.15 * (big - 0.5));
  COVER(vec3(0.42, 0.42, 0.44), bright * 0.6);
  float r = 0.58 + (g.w - 0.5) * 0.12 + (mid - 0.5) * 0.1 - oil * 0.14 - wear * 0.14; r = mix(r, 0.3, bright * 0.8);
  float h = 0.5 + (g.x - 0.5) * 0.12 + (fine - 0.5) * 0.1 - sc * 0.25 - wear * 0.05;
  emit(overlay, tintAmt, h, 1.0 - sc * 0.1, r, mix(0.75, 1.0, bright));
}
`,

  // 工程塑料 / 橡胶（染色）。表面是两种大小的防滑凸点（0.1 米的贴图上约 2.5 毫米和 1.1 毫米）；
  // 常摸的地方凸点被磨平、发亮。
  polymer: /* glsl */ `
void surf(vec2 uv){
  // 两层凸点
  vec4 g = voronoi(uv * 40.0, vec2(40.0), 1.0); vec4 g2 = voronoi(uv * 90.0 + 0.5, vec2(90.0), 2.0);
  float fine = fbm(uv, vec2(120.0), 2, 3.0), big = fbm(uv, vec2(3.0), 4, 4.0);
  float stip = smoothstep(0.6, 0.1, g.x) * (0.5 + 0.5 * g.w) * 0.7 + smoothstep(0.6, 0.1, g2.x) * 0.3;
  // 蹭亮的地方
  float scuff = smoothstep(0.62, 0.8, fbm(uv, vec2(4.0), 5, 5.0));
  float sc = scratches(uv, 10.0, 6.0, 0.01, 0.5, 6.3, 0.4);
  vec3 overlay = vec3(0.0); float tintAmt = 0.92 * (0.9 + 0.12 * (big - 0.5) + 0.08 * (fine - 0.5));
  COVER(vec3(0.45), sc * 0.25 + scuff * 0.06);
  float h = 0.3 + stip * 0.6 * (1.0 - scuff * 0.6) + (fine - 0.5) * 0.05 - sc * 0.2;
  float r = 0.62 + (stip - 0.5) * 0.1 + (big - 0.5) * 0.1 - scuff * 0.22 + sc * 0.1;
  emit(overlay, tintAmt, h, 0.8 + 0.2 * stip, r, 0.0);
}
`,

  // 碳纤维：2×2 斜纹编织。每一格里要么经纱在上、要么纬纱在上，沿对角线排列。
  carbon: /* glsl */ `
void surf(vec2 uv){
  vec2 p = uv * 12.0; vec2 i = floor(p), q = fract(p);
  // 这一格是经纱在上还是纬纱在上
  float warpTop = step(mod(i.x - i.y + 400.0, 4.0), 1.5);
  // prof：纱束的截面是鼓起来的；fib：顺着纱束方向的细纤维
  float prof = warpTop > 0.5 ? sin(q.x * 3.14159) : sin(q.y * 3.14159);
  float fib = warpTop > 0.5 ? fbm(uv, vec2(240.0, 12.0), 2, 1.0) : fbm(uv, vec2(12.0, 240.0), 2, 5.0);
  float h = 0.35 + 0.5 * pow(max(prof, 0.0), 0.6) + (fib - 0.5) * 0.12;
  vec3 col = vec3(0.035, 0.036, 0.04) * (0.7 + 0.6 * fib) * (warpTop > 0.5 ? 1.0 : 0.8);
  float big = fbm(uv, vec2(2.0), 3, 2.0);
  emit(col, 1.0, h, 0.6 + 0.4 * prof, 0.32 + (fib - 0.5) * 0.2 + (big - 0.5) * 0.1, 0.0);
}
`,

  // 平纹织物（染色）：手套。一张图 36×36 根纱，经纬一上一下。
  // 颜色完全来自材质色和顶点色，贴图只管"哪里亮哪里暗"。
  fabric: /* glsl */ `
void surf(vec2 uv){
  float f = 36.0; vec2 p = uv * f; vec2 i = floor(p), q = fract(p);
  // 棋盘格：这一格是经纱在上还是纬纱在上
  float top = mod(i.x + i.y, 2.0);
  // 纱的截面
  float pw = sin(q.x * 3.14159), pf = sin(q.y * 3.14159);
  float h = top > 0.5 ? pw * (0.6 + 0.4 * pf) : pf * (0.6 + 0.4 * pw) * 0.85;
  float fz = fbm(uv, vec2(150.0), 3, 1.0), big = fbm(uv, vec2(2.0), 4, 2.0);
  // 每根纱的亮度略有不同
  float thr = hash3(vec2(top > 0.5 ? i.x : i.y, top), vec2(f), 3.0).x;
  float tintAmt = 0.9 * (0.55 + 0.45 * h) * (0.85 + 0.2 * (thr - 0.5) + 0.2 * (fz - 0.5) + 0.2 * (big - 0.5));
  emit(vec3(0.0), tintAmt, 0.2 + h * 0.7 + (fz - 0.5) * 0.15, 0.5 + 0.5 * h, 0.92, 0.0);
}
`,

  // 装甲漆面（染色）：敌人的外壳。掉漆后先露浅灰底漆，再深就露出带纤维走向的复合基材
  // （不是钢，所以不生锈）。
  armor: /* glsl */ `
void surf(vec2 uv){
  float chip, stain, run; paintDamage(uv, 0.5, chip, stain, run);
  float fine = fbm(uv, vec2(200.0), 2, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  // 污垢很少（最多 7%）；sc 是划痕
  float grime = smoothstep(0.45, 0.8, fbm(uv, vec2(3.0, 4.0), 5, 4.0)); float sc = scratches(uv, 14.0, 5.0, 0.008, 0.4, 6.3, 0.5);
  // sub：露出基材；prim：只露出底漆
  float sub = smoothstep(0.5, 0.75, chip), prim = smoothstep(0.15, 0.4, chip) * (1.0 - sub);
  vec3 overlay = vec3(0.0); float tintAmt = 0.85 * (0.92 + 0.14 * (mid - 0.5) + 0.1 * (big - 0.5));
  COVER(srgb(0.2, 0.18, 0.15), grime * 0.07 * (0.5 + fine));
  COVER(vec3(0.55), sc * 0.3);
  COVER(srgb(0.5, 0.5, 0.47), prim);
  // 基材的纤维纹路
  float wv = fbm(uv, vec2(160.0, 8.0), 2, 6.0);
  COVER(srgb(0.4, 0.38, 0.33) * (0.6 + 0.8 * wv), sub);
  float h = 0.6 + (fine - 0.5) * 0.04 + (mid - 0.5) * 0.03 - prim * 0.1 - sub * 0.25 - sc * 0.08;
  float r = 0.36 + (mid - 0.5) * 0.1 + grime * 0.1 + sc * 0.15; r = mix(r, 0.6, prim); r = mix(r, 0.75, sub);
  emit(overlay, tintAmt, h, 1.0 - sub * 0.2, r, 0.0);
}
`,

  // 锯材：托盘、木箱。年轮、节疤、顺纹的纤维、锯痕、风化发灰、顺纹的裂缝。纹理顺着 U 方向走。
  wood: /* glsl */ `
void surf(vec2 uv){
  // 节疤：2×4 格里 30% 有
  vec4 kv = voronoi(uv * vec2(2.0, 4.0), vec2(2.0, 4.0), 1.0); float isK = step(kv.z, 0.3);
  float knot = isK * smoothstep(0.2, 0.0, length((kv.x) * vec2(1.0))), core = isK * smoothstep(0.05, 0.03, kv.x);
  // 年轮：一张图 44 圈，被低频噪声和节疤扭弯
  float wob = fbm(uv, vec2(1.0, 3.0), 3, 2.0);
  float ring = fract(uv.y * 44.0 + (wob - 0.5) * 2.4 + knot * knot * 4.0 + (fbm(uv, vec2(4.0, 30.0), 2, 12.0) - 0.5) * 0.35);
  // 晚材带：每圈年轮里颜色深的那一段
  float late = smoothstep(0.5, 0.92, ring) * (1.0 - smoothstep(0.92, 1.0, ring));
  float fib = fbm(uv, vec2(3.0, 260.0), 3, 3.0), fib2 = fbm(uv, vec2(8.0, 90.0), 3, 4.0);
  // 锯痕：只在部分区域看得见
  float saw = 0.5 + 0.5 * sin((uv.x + 0.02 * sin(uv.y * TAU * 2.0)) * TAU * 240.0);
  float sawK = smoothstep(0.35, 0.7, fbm(uv, vec2(3.0), 3, 5.0));
  // 风化发灰
  float grey = smoothstep(0.2, 0.68, fbm(uv, vec2(2.0, 3.0), 5, 6.0));
  // 顺纹的裂缝
  float crack = smoothstep(0.84, 0.87, fbm(uv, vec2(2.0, 110.0), 3, 7.0)) * smoothstep(0.45, 0.65, fbm(uv, vec2(5.0, 3.0), 3, 8.0));
  vec3 early = srgb(0.58, 0.49, 0.38), lateC = srgb(0.36, 0.28, 0.2);
  float bigv = fbm(uv, vec2(1.0, 2.0), 3, 21.0);
  vec3 col = mix(early, lateC, late * 0.9) * (0.85 + 0.6 * (fib - 0.5) + 0.4 * (fib2 - 0.5)) * (0.78 + 0.44 * bigv);
  col = mix(col, lateC * 0.8, knot * 0.5); col = mix(col, srgb(0.28, 0.17, 0.09), core);
  col = mix(col, srgb(0.47, 0.465, 0.45) * (0.7 + 0.6 * fib) * (1.0 - late * 0.3), grey * 0.82);
  float dirt = smoothstep(0.55, 0.85, fbm(uv, vec2(4.0), 5, 9.0)); col *= 1.0 - dirt * 0.35;
  col *= 1.0 - crack * 0.55;
  float h = 0.5 + (fib - 0.5) * 0.4 + (late - 0.5) * 0.2 - (saw - 0.5) * 0.12 * sawK + (fib2 - 0.5) * 0.15 - crack * 0.3 + core * 0.05;
  emit(col, 1.0, h, 1.0 - crack * 0.5, 0.82 + (fib - 0.5) * 0.15 + grey * 0.08 - core * 0.15, 0.0);
}
`,

  // 注塑件（染色）：塑料桶、路锥、壳体。划痕泛白，有蹭痕和灰尘。
  plastic: /* glsl */ `
void surf(vec2 uv){
  float fine = fbm(uv, vec2(220.0), 3, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float scuff = smoothstep(0.55, 0.75, fbm(uv, vec2(5.0, 8.0), 5, 4.0));
  // 三层划痕
  float s1 = scratches(uv, 7.0, 5.0, 0.005, 0.2, 6.3, 0.35), s2 = scratches(uv, 22.0, 6.0, 0.012, 1.0, 6.3, 0.3), s3 = scratches(uv, 50.0, 7.0, 0.03, 2.0, 6.3, 0.25);
  float sc = sat(max(s1, max(s2 * 0.8, s3 * 0.5)));
  float dirt = smoothstep(0.5, 0.85, fbm(uv, vec2(3.0), 5, 8.0));
  vec3 overlay = vec3(0.0); float tintAmt = 0.9 * (0.92 + 0.1 * (mid - 0.5) + 0.1 * (big - 0.5));
  // 塑料的划痕是泛白的
  COVER(vec3(0.6), sc * 0.22 + scuff * 0.03 * fine);
  COVER(srgb(0.25, 0.22, 0.18), dirt * 0.4);
  float h = 0.5 + (fine - 0.5) * 0.12 + (mid - 0.5) * 0.04 - sc * 0.25;
  emit(overlay, tintAmt, h, 1.0, 0.42 + (fine - 0.5) * 0.08 + scuff * 0.2 + sc * 0.2 + dirt * 0.2, 0.0);
}
`,

  // 篷布（染色）。垂下来的褶子用"脊状"噪声：取绝对值再翻过来，得到一条条尖锐的脊；
  // 布面上有加强筋的细网格；褶谷里积灰。
  tarp: /* glsl */ `
void surf(vec2 uv){
  vec2 wu = uv + (vec2(fbm(uv, vec2(2.0), 3, 1.0), fbm(uv, vec2(2.0), 3, 2.0)) - 0.5) * 0.12;
  // f1：长的垂褶；f2：细的皱纹
  float f1 = 1.0 - abs(gradNoise(wu * vec2(2.0, 7.0), vec2(2.0, 7.0), 3.0)) * 2.4;        // long drape folds
  float f2 = 1.0 - abs(gradNoise(wu * vec2(5.0, 13.0) + 2.0, vec2(5.0, 13.0), 4.0)) * 2.4; // finer wrinkles
  f1 = smoothstep(0.0, 1.0, sat(f1)); f2 = smoothstep(0.2, 1.0, sat(f2));
  // 被风鼓起来的大起伏
  float bill = fbm(wu, vec2(2.0, 3.0), 3, 5.0);
  // 加强筋网格：每 7.5 毫米一根
  float scrim = max(smoothstep(0.42, 0.5, abs(fract(uv.x * 200.0) - 0.5)), smoothstep(0.42, 0.5, abs(fract(uv.y * 200.0) - 0.5)));
  float fine = fbm(uv, vec2(240.0), 2, 6.0), mid = fbm(uv, vec2(14.0), 4, 7.0);
  float h = 0.25 + bill * 0.35 + f1 * 0.22 + f2 * 0.07 + scrim * 0.02 + (fine - 0.5) * 0.012;
  float dirt = smoothstep(0.5, 0.85, fbm(uv, vec2(4.0), 5, 8.0) + (0.5 - f1) * 0.08);
  vec3 overlay = vec3(0.0); float tintAmt = 0.9 * (0.88 + 0.14 * (mid - 0.5)) * (1.0 - scrim * 0.06);
  COVER(vec3(0.5), smoothstep(0.85, 1.0, f1) * 0.03);
  COVER(srgb(0.3, 0.27, 0.22), dirt * 0.3);
  emit(overlay, tintAmt, h, 0.9 + 0.1 * smoothstep(0.1, 0.7, f1), 0.48 + (mid - 0.5) * 0.15 + dirt * 0.25, 0.0);
}
`,

  // 瓦楞纸箱。能隐约看到里面瓦楞的透印；有纤维、折痕，受潮的地方颜色深，边缘有一圈水渍线。
  cardboard: /* glsl */ `
void surf(vec2 uv){
  // 瓦楞透印：7 毫米一道
  float fl = 0.5 + 0.5 * cos(uv.y * TAU * 140.0);
  float fib = fbm(uv, vec2(40.0, 160.0), 3, 1.0), fine = fbm(uv, vec2(250.0), 2, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  // 受潮：damp 是受潮的范围，tide 是范围边缘的那一圈水渍线
  float sn = fbm(uv, vec2(3.0), 5, 4.0); float damp = smoothstep(0.62, 0.72, sn); float tide = smoothstep(0.61, 0.64, sn) * (1.0 - smoothstep(0.64, 0.7, sn));
  // 折痕
  float crease = smoothstep(0.012, 0.004, abs(fbm(uv, vec2(2.0), 2, 5.0) - 0.5)) * smoothstep(0.5, 0.7, fbm(uv, vec2(3.0), 2, 6.0));
  vec3 col = srgb(0.66, 0.52, 0.36) * (0.85 + 0.2 * (fib - 0.5) + 0.12 * (fine - 0.5) + 0.2 * (big - 0.5)) * (0.97 + 0.06 * fl);
  col *= (1.0 - damp * 0.3) * (1.0 - tide * 0.18); col = mix(col, col * 1.25, crease * 0.5);
  col *= 1.0 - smoothstep(0.8, 0.9, fbm(uv, vec2(120.0), 2, 7.0)) * 0.2;
  float h = 0.5 + (fl - 0.5) * 0.12 + (fib - 0.5) * 0.15 + (fine - 0.5) * 0.08 - crease * 0.3 + damp * 0.2 * (fbm(uv, vec2(20.0), 3, 8.0) - 0.5);
  emit(col, 1.0, h, 1.0 - crease * 0.3, 0.9 - damp * 0.2 + (fib - 0.5) * 0.1, 0.0);
}
`,

  // 缆绳。斜着的几股拧在一起，每股是鼓的，股上还有更细的纱。
  rope: /* glsl */ `
void surf(vec2 uv){
  // 沿斜向一张图 4 股；prof 是股的截面
  float a = (uv.x + uv.y) * 4.0; float prof = sin(fract(a) * 3.14159);
  float fib = fbm(uv, vec2(60.0), 3, 1.0);
  float yarn = 0.5 + 0.5 * sin((uv.x - uv.y) * 4.0 * TAU * 5.0 + 2.0 * sin(a * TAU));
  float h = pow(max(prof, 0.0), 0.7) * 0.8 + yarn * 0.1 + (fib - 0.5) * 0.15;
  vec3 col = srgb(0.66, 0.6, 0.46) * (0.6 + 0.4 * prof) * (0.85 + 0.3 * (fib - 0.5)) * (0.92 + 0.16 * yarn);
  float dirt = smoothstep(0.4, 0.8, fbm(uv, vec2(3.0), 4, 2.0)); col = mix(col, srgb(0.25, 0.22, 0.18), dirt * 0.5 * (1.0 - prof * 0.5));
  emit(col, 1.0, h, 0.45 + 0.55 * prof, 0.95, 0.0);
}
`,

  // 轮胎。U 沿周长，V 跨胎宽（花纹左右对称）：中央锯齿沟、胎肩沟、横向花纹块、细刀槽；
  // 两边是带同心棱的胎侧。
  tire: /* glsl */ `
void surf(vec2 uv){
  // v：离胎面中线的距离（0 中线 … 1 边缘）
  float sv = fract(uv.y + 0.5) - 0.5; float v = abs(sv) * 2.0; float u = uv.x;
  // 锯齿形的纵沟
  float zig = 0.03 * abs(fract(u * 10.0) - 0.5) * 2.0;
  float g1 = smoothstep(0.035, 0.02, abs(v - 0.36 - zig)), g0 = smoothstep(0.03, 0.018, abs(v - zig * 0.5));
  // 横向的花纹沟，和细刀槽
  float lat = smoothstep(0.06, 0.03, abs(fract(u * 10.0 + v * 1.2 * sign(sv)) - 0.5)) * step(0.4, v) * step(v, 0.8);
  float sipe = smoothstep(0.012, 0.005, abs(fract(u * 20.0 + v * 0.8) - 0.5)) * step(0.05, v) * step(v, 0.33);
  float groove = sat(max(max(g0, g1), max(lat, sipe * 0.6)));
  // 胎侧
  float side = smoothstep(0.84, 0.9, v);
  float rib = (0.5 + 0.5 * cos(v * TAU * 14.0)) * side;
  float fine = fbm(uv, vec2(200.0, 120.0), 3, 1.0), mid = fbm(uv, vec2(10.0, 6.0), 4, 2.0);
  float h = (1.0 - groove) * (1.0 - side) * 0.8 + side * (0.35 + rib * 0.1) + (fine - 0.5) * 0.04;
  // 沟里和表面沾的土
  float dust = smoothstep(0.4, 0.75, fbm(uv, vec2(4.0, 3.0), 5, 3.0));
  vec3 col = vec3(0.022) * (0.8 + 0.5 * (mid - 0.5)); col = mix(col, srgb(0.22, 0.2, 0.17), dust * 0.25 + groove * (1.0 - side) * 0.2);
  emit(col, 1.0, h, 1.0 - groove * 0.5 * (1.0 - side), 0.85 + (fine - 0.5) * 0.1 - side * 0.1, 0.0);
}
`,

  // 玻璃（带透明）。alpha 是不透明度：干净处很透，积灰处发白；上面挂着雨滴，雨水流过的地方把灰冲掉了。
  // uParam.x 是脏的程度。
  glass: /* glsl */ `
void surf(vec2 uv){
  float d = uParam.x;
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 4, 2.0), fine = fbm(uv, vec2(200.0), 2, 3.0);
  // 灰尘
  float dust = sat(smoothstep(0.75 - 0.45 * d, 0.95 - 0.3 * d, big * 0.7 + mid * 0.3) + fine * 0.15 * d);
  float st2 = fbm(uv, vec2(120.0, 3.0), 2, 5.0);
  // 雨水流过的轨迹
  float trail = smoothstep(0.62, 0.72, fbm(uv, vec2(50.0, 1.0), 2, 4.0)) * smoothstep(0.3, 0.6, fbm(uv, vec2(50.0, 2.0), 2, 6.0));
  // 雨滴：两种大小
  vec4 dv = voronoi(uv * 60.0, vec2(60.0), 7.0); float drop = step(dv.z, 0.45) * smoothstep(0.32 * dv.w + 0.06, 0.0, dv.x);
  vec4 dv2 = voronoi(uv * 150.0, vec2(150.0), 8.0); float drop2 = step(dv2.z, 0.5) * smoothstep(0.3 * dv2.w + 0.05, 0.0, dv2.x);
  dust *= 1.0 - trail * 0.7;
  vec3 col = mix(srgb(0.5, 0.6, 0.62) * 0.25, srgb(0.5, 0.47, 0.4), dust);
  float alpha = mix(0.16, 0.55 + 0.35 * d, dust) + drop * 0.08 + (st2 - 0.5) * 0.05 * d;
  float h = 0.3 + drop * 0.5 + drop2 * 0.15 + trail * 0.06 * st2;
  float r = mix(0.03, 0.55, dust); r = mix(r, 0.03, sat(drop * 2.0));
  emit(col, alpha, h, 1.0, r, 0.0);
}
`,

  // 水面（目前没有用到，留着备用）。
  water: /* glsl */ `
void surf(vec2 uv){
  float a = fbm(uv, vec2(6.0, 10.0), 4, 1.0), b = fbm(uv + 0.3, vec2(20.0, 30.0), 3, 2.0);
  emit(srgb(0.1, 0.16, 0.18) * 0.5, 1.0, 0.5 + (a - 0.5) * 0.6 + (b - 0.5) * 0.2, 1.0, 0.06, 0.0);
}
`,
} as const;

/** 生成函数的名字。几个贴图集可以共用一个函数（换参数和种子）。 */
export type GenFn = keyof typeof GEN_SURF;
