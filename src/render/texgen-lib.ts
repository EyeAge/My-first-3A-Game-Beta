// 贴图生成器的公共着色器代码。
//
// 每种质感（漆面、锈、木头……）的贴图都不是画出来的，而是"算"出来的：
// 给显卡一段函数 surf(uv)，它对贴图上的每个像素算出"这里是什么颜色、多粗糙、多高"。
// 这个文件是所有 surf() 共用的工具箱：随机数、噪声、裂片、划痕、掉漆模型。
//
// 最重要的一条约定：**所有噪声都按"一张图"为周期首尾相接**。
// 每个噪声函数都带一个 per（周期）参数，取格点随机数之前先对它取模，
// 所以贴图的左边缘和右边缘、上边缘和下边缘天然对得上，平铺起来没有接缝。

/** 顶点着色器：画一个盖满整个画面的方块，把 0..1 的贴图坐标传下去。 */
export const GEN_VERTEX = /* glsl */ `
in vec3 position; out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * 公共库。拼在每个生成器着色器的最前面。
 *
 * 三个输出（一次绘制同时写三张图）：
 *   outAlbedo  颜色（rgb）+ 染色量（a）
 *   outOrm     r = 遮蔽（凹处暗），g = 粗糙度，b = 金属度
 *   outHeight  高度。8 位精度不够（会出台阶），所以拆成"整数部分 + 小数部分"存进 r、g 两个通道，相当于 16 位
 */
export const GEN_LIB = /* glsl */ `
precision highp float; precision highp int;
uniform vec4 uParam;    // 这个贴图集自己的参数（比如"锈有多少""有多脏"）
uniform float uSeed;    // 随机种子的偏移：同一段函数换个种子，就是另一张不同的图
uniform float uTexel;   // 一个像素有多宽（= 1 / 贴图边长）
in vec2 vUv;
layout(location=0) out vec4 outAlbedo; layout(location=1) out vec4 outOrm; layout(location=2) out vec4 outHeight;
#define TAU 6.28318530718
#define sat(x) clamp(x, 0.0, 1.0)

// "染色模型"：很多材质的颜色不写死在贴图里，而是分成两部分 ——
//   tintAmt  这里还剩多少"漆"（以后乘上材质的颜色）
//   overlay  不跟着漆色走的东西：锈、底漆、灰尘、划痕里露出的金属（已经乘好了自己的浓度）
// 最后 颜色 = overlay + 材质色 × tintAmt。于是八种颜色的漆可以共用一张贴图，红漆上的锈不会变成红色。
// COVER(颜色, 浓度)：在上面再盖一层不染色的东西，盖住的地方漆就少了。
#define COVER(D, k) { float k_ = sat(k); overlay = mix(overlay, D, k_); tintAmt = mix(tintAmt, 0.0, k_); }

// 把"眼睛看到的"颜色值（屏幕上的 0..1）换成光照计算用的线性值。写成 srgb(...) 的颜色都是照着眼睛调的。
vec3 srgb(float r, float g, float b){ return pow(vec3(r, g, b), vec3(2.2)); }

// 整数哈希（PCG）：把三个整数搅成三个看起来毫无规律的整数。同样的输入永远得到同样的输出。
uvec3 pcg3(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
// 格点 cell 上的三个 0..1 随机数。先对 per 取模 —— 这就是"无缝"的来源：第 per 格和第 0 格是同一个格子。
vec3 hash3(vec2 cell, vec2 per, float seed){ cell = mod(cell, per); return vec3(pcg3(uvec3(uint(cell.x + 0.5), uint(cell.y + 0.5), uint(seed + uSeed)))) * (1.0 / 4294967296.0); }

// 梯度噪声：每个格点上放一个随机方向，格子内部平滑过渡。输出大约 -0.7..0.7，比"每格一个随机数"的噪声更自然。
float gradNoise(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = p - i; vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // 五次曲线：格子边界上一阶、二阶导数都连续
  float a = dot(hash3(i, per, seed).xy * 2.0 - 1.0, f);
  float b = dot(hash3(i + vec2(1.0, 0.0), per, seed).xy * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash3(i + vec2(0.0, 1.0), per, seed).xy * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash3(i + vec2(1.0, 1.0), per, seed).xy * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 分形噪声：把几层越来越细的梯度噪声叠起来（每层频率翻倍、强度减半）。
//   freq  最粗那层"一张图里起伏几次"。两个方向可以不同：(70, 1) 就是又细又长的竖条纹
//   输出 0..1，以 0.5 为中心，大部分值落在 0.3..0.7
float fbm(vec2 uv, vec2 freq, int octaves, float seed){
  float amp = 0.5, sum = 0.0, total = 0.0;
  for (int i = 0; i < octaves; i++){ sum += amp * gradNoise(uv * freq, freq, seed + float(i) * 7.0); total += amp; amp *= 0.5; freq *= 2.0; }
  return sat(sum / total * 1.8 + 0.5);
}
// 泰森多边形（Voronoi）：每个格子里随机放一个点，问"离我最近的点有多远"。石子、晶粒、气孔、碎片都从它来。
//   x = 到最近点的距离，y = 到第二近点的距离（y - x 很小的地方就是两块之间的缝）
//   z、w = 最近那个点自带的两个随机数（给每颗石子不同的颜色、大小）
vec4 voronoi(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = p - i; float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = hash3(i + o, per, seed); vec2 d = o + r.xy - f; float dd = dot(d, d);
    if (dd < d1){ d2 = d1; d1 = dd; id = vec2(r.z, fract(r.z * 37.0 + r.x * 11.0)); } else if (dd < d2) d2 = dd;
  }
  return vec4(sqrt(d1), sqrt(d2), id);
}
// 散布的直划痕：一张图分成 cells × cells 格，每格里可能有一道。
//   halfWidth 半宽（以格子为单位）；angle ± spread/2 是方向；density 是每格出现的概率
//   每道的长度、深浅各不相同
float scratches(vec2 uv, float cells, float seed, float halfWidth, float angle, float spread, float density){
  vec2 p = uv * cells; vec2 i = floor(p); vec2 fr = p - i; float m = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = hash3(i + o, vec2(cells), seed); vec3 r2 = hash3(i + o, vec2(cells), seed + 31.0);
    vec2 c = o + r.xy - fr; float a = angle + (r.z - 0.5) * spread; vec2 dir = vec2(cos(a), sin(a));
    float along = dot(c, dir), across = dot(c, vec2(-dir.y, dir.x)); float len = 0.15 + r2.x * 0.8;
    m = max(m, smoothstep(halfWidth, halfWidth * 0.3, abs(across)) * smoothstep(len, len * 0.7, abs(along)) * step(r2.y, density) * (0.35 + 0.65 * r2.z));
  }
  return m;
}
// 把结果写进三张图。颜色先开平方再存：8 位通道里暗部的台阶会细很多，后面复制的时候再平方回来。
void emit(vec3 color, float alpha, float height, float ao, float rough, float metal){
  outAlbedo = vec4(sqrt(clamp(color, 0.0, 1.0)), sat(alpha));
  outOrm = vec4(sat(ao), clamp(rough, 0.03, 1.0), sat(metal), 1.0);
  float hh = sat(height) * 255.0; float fl = floor(hh); outHeight = vec4(fl / 255.0, hh - fl, 0.0, 1.0);
}
// 一块块边缘发毛的锈斑：低频噪声超过阈值的地方是锈，再用高频噪声把边缘啃碎。threshold 越高锈越少。
float rustMask(vec2 uv, vec2 freq, float threshold, float seed){
  float n = fbm(uv, freq, 5, seed), g = fbm(uv, freq * 14.0, 3, seed + 50.0);
  return smoothstep(threshold, threshold + 0.14, n + (g - 0.5) * 0.3) * (0.5 + 0.5 * g);
}

// ---- 漆面损伤模型：漆、警示斜纹、装甲三种质感共用 ----
// 掉漆的碎片：Voronoi 格子里按概率 density 出一片，半径 maxR × (0.25..1)，边缘被噪声啃得不圆。
float chips(vec2 uv, vec2 cells, float seed, float density, float maxR){
  vec4 v = voronoi(uv * cells, cells, seed); float e = fbm(uv, cells * 3.0, 3, seed + 3.0) - 0.5; float r = maxR * (0.25 + 0.75 * v.w);
  return step(v.z, density) * smoothstep(r, r * 0.55, v.x + e * 0.6);
}
// 输入 amount：损伤的多少。三个输出：
//   chip   0 = 漆完好 … 1 = 磕到露出底材
//   stain  损伤周围一圈淡淡的氧化晕
//   run    锈水往下淌出来的痕迹（约定贴图的 -V 方向是"下"）
void paintDamage(vec2 uv, float amount, out float chip, out float stain, out float run){
  float wearN = fbm(uv, vec2(3.0), 6, 21.0);
  float zone = smoothstep(0.58, 0.82, fbm(uv, vec2(2.0), 3, 22.0));      // 损伤是成簇出现的：大部分面板干净，少数区域集中掉漆
  float dn = (0.012 + 0.085 * zone) * (0.5 + amount);                    // 这一带碎片出现的概率
  float c1 = chips(uv, vec2(20.0, 11.0), 23.0, dn, 0.24);                // 大碎片。格子高大于宽 → 竖向拉长的漆皮
  float c2 = chips(uv, vec2(64.0, 40.0), 24.0, dn * 1.6, 0.34);          // 小碎片，更密
  float th = 0.925 - 0.06 * amount;
  float c3 = smoothstep(th, th + 0.03, wearN + (fbm(uv, vec2(40.0), 3, 25.0) - 0.5) * 0.12);   // 大片磨穿
  float s1 = scratches(uv, 5.0, 26.0, 0.0035, 0.0, 0.4, 0.2 + 0.25 * amount);     // 长而细的横向刮痕
  float s2 = scratches(uv, 16.0, 27.0, 0.009, 1.57, 0.5, 0.12 + 0.2 * amount);    // 短的竖向刮痕
  float sbreak = smoothstep(0.4, 0.65, fbm(uv, vec2(50.0), 2, 28.0));             // 刮痕不是连续的，断断续续
  chip = sat(max(max(c1, c2), max(c3, max(s1, s2) * sbreak)));
  vec4 v = voronoi(uv * vec2(20.0, 11.0), vec2(20.0, 11.0), 23.0);
  float b1 = step(v.z, dn) * smoothstep(0.42, 0.14, v.x) * (0.3 + 0.7 * v.w);     // 比碎片本身大一圈的范围
  float bn = fbm(uv, vec2(36.0), 4, 29.0);
  stain = sat(max(b1 * smoothstep(0.4, 0.7, bn) * 0.8, smoothstep(th - 0.03, th + 0.02, wearN) * smoothstep(0.4, 0.7, bn) * 0.7));
  // 锈水：往上（+V）看四步，每步 0.034 张图（2.5 米的贴图上是 8.5 厘米）。上方有损伤，这里就有流痕；离得越远越淡。
  float streak = fbm(uv, vec2(120.0, 1.0), 3, 30.0);
  float rr = 0.0;
  for (int i = 1; i <= 4; i++){
    vec2 q = uv + vec2(0.0, float(i) * 0.034);
    float src = max(chips(q, vec2(20.0, 11.0), 23.0, dn, 0.24), smoothstep(th, th + 0.03, fbm(q, vec2(3.0), 6, 21.0)));
    rr = max(rr, src * (1.0 - float(i) / 5.0));
  }
  run = rr * smoothstep(0.5, 0.78, streak);   // 再乘竖向的细条纹：水是一道一道淌的，不是一整片
}
`;

/**
 * 漆面的各层，从下往上叠。它不是完整的函数，是插在"漆"和"警示斜纹"两个 surf() 中间的一段：
 * 进来之前要有 chip / stain / run（上面 paintDamage 的结果）、shade（染色量的基数）、baseR（干净漆面的粗糙度），
 * 出去以后有 overlay / tintAmt / h（高度）/ r（粗糙度）/ m（金属度）/ ao（遮蔽）。
 */
export const GEN_PAINT_LAYERS = /* glsl */ `
  float fine = fbm(uv, vec2(260.0), 2, 1.0), mid = fbm(uv, vec2(16.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float chalk = smoothstep(0.3, 0.8, fbm(uv, vec2(1.0, 2.0), 4, 4.0));                 // 粉化：晒久了的漆表面发白发涩
  float dirt = smoothstep(0.42, 0.85, fbm(uv, vec2(3.0, 2.0), 5, 5.0));
  // 三种粗细的竖向冲刷条纹（一张图里横向 70 / 22 / 9 道）
  float vs1 = fbm(uv, vec2(70.0, 1.0), 3, 6.0), vs2 = fbm(uv, vec2(22.0, 1.0), 3, 16.0), vs3 = fbm(uv, vec2(9.0, 2.0), 3, 17.0);
  float steel = smoothstep(0.55, 0.8, chip);                                           // 磕得深：露出钢板
  float primer = smoothstep(0.15, 0.4, chip) * (1.0 - steel);                          // 磕得浅：只露出底漆
  float rustN = fbm(uv, vec2(60.0), 4, 7.0);
  float fresh = steel * smoothstep(0.78, 0.86, fbm(uv, vec2(25.0), 3, 8.0));           // 少数是新磕的，钢还是亮的
  vec3 rustC = mix(srgb(0.2, 0.135, 0.105), srgb(0.36, 0.23, 0.15), rustN);
  rustC = mix(rustC, srgb(0.5, 0.33, 0.18), smoothstep(0.7, 0.95, fbm(uv, vec2(120.0), 2, 9.0)) * 0.5);
  vec3 overlay = vec3(0.0); float tintAmt = shade * (0.9 + 0.2 * (mid - 0.5) + 0.2 * (big - 0.5));
  // 灰尘膜：大片的脏 + 粗细不同的竖向冲刷条纹
  float df = sat(dirt * 0.3 + smoothstep(0.55, 0.85, vs1) * 0.3 * (0.4 + dirt) + smoothstep(0.55, 0.8, vs2) * 0.38 * (0.3 + dirt) + smoothstep(0.5, 0.8, vs3) * 0.2);
  float clean = smoothstep(0.6, 0.85, 1.0 - vs2) * 0.5;            // 被雨水冲干净的浅色条
  float rs = sat(stain * 0.7 + run * 0.85);                        // 锈渍 = 氧化晕 + 锈水
  tintAmt *= 1.0 + clean * 0.08 - chalk * 0.06;
  COVER(vec3(0.72), chalk * 0.075 + clean * 0.02);
  COVER(srgb(0.24, 0.22, 0.19), df * 0.42);
  COVER(mix(srgb(0.3, 0.2, 0.14), srgb(0.44, 0.28, 0.16), rustN), rs * 0.5);
  COVER(mix(srgb(0.5, 0.25, 0.2), srgb(0.55, 0.54, 0.5), 0.35), primer);       // 红丹底漆，偏灰
  COVER(rustC, steel);
  COVER(srgb(0.55, 0.55, 0.57), fresh);
  // 高度：漆面 0.62，底漆 0.5，钢 0.36 起。贴图集的 bump 是 2.5 毫米，所以掉漆的坑深约 0.65 毫米
  float h = 0.62 + (fine - 0.5) * 0.05 + (mid - 0.5) * 0.04;
  h = mix(h, 0.5, primer); h = mix(h, 0.36 + rustN * 0.14, steel); h += rs * 0.02 * rustN;
  // 粗糙度：粉化和灰尘让它变涩，冲干净的条更亮；底漆 0.75、锈 0.92、新磕的亮钢 0.35
  float r = baseR + chalk * 0.26 + df * 0.3 - clean * 0.06 + (mid - 0.5) * 0.14 + (big - 0.5) * 0.1; r = mix(r, 0.75, primer); r = mix(r, 0.92, steel); r = mix(r, 0.35, fresh); r = mix(r, 0.72, rs * 0.6);
  float m = fresh * 0.95 + (steel - fresh) * 0.15;                 // 只有新磕出来的钢才像金属；锈了的不反光
  float ao = 1.0 - steel * 0.25 - primer * 0.1;
`;

/** 每个生成器着色器的结尾：对当前像素调一次 surf。 */
export const GEN_MAIN = /* glsl */ `
void main(){ surf(vUv); }
`;

/**
 * 高度图 → 法线图。
 * 看周围 8 个像素的高度差：左右差得多，表面就朝左或朝右歪；上下同理。
 * uSlope 把"每像素的高度差"换算成真实的坡度（= 高度的毫米数 × 每米的像素数），所以凹凸的深浅是按真实尺寸来的。
 */
export const GEN_NORMAL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tHeight; uniform vec2 uSlope; uniform float uTexel; in vec2 vUv; out vec4 outColor;
float heightAt(vec2 uv){ vec4 t = texture(tHeight, uv); return t.r + t.g / 255.0; }   // 把拆开存的两个通道拼回去
void main(){
  vec2 e = vec2(uTexel, 0.0);
  float l = heightAt(vUv - e.xy), r = heightAt(vUv + e.xy), d = heightAt(vUv - e.yx), u = heightAt(vUv + e.yx);
  float ld = heightAt(vUv - e.xx), rd = heightAt(vUv + vec2(e.x, -e.x)), lu = heightAt(vUv + vec2(-e.x, e.x)), ru = heightAt(vUv + e.xx);
  float gx = (r - l) * 0.5 + (ru + rd - lu - ld) * 0.25, gy = (u - d) * 0.5 + (ru + lu - rd - ld) * 0.25;
  vec3 n = normalize(vec3(-gx * uSlope.x, -gy * uSlope.y, 1.0));   // z 恒为 1，长度不会是 0，可以放心归一化
  outColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

/** 复制一张图。uSquare 为 1 时顺便把开过平方的颜色平方回来。 */
export const GEN_COPY_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource; uniform float uSquare; in vec2 vUv; out vec4 outColor;
void main(){ vec4 t = texture(tSource, vUv); outColor = uSquare > 0.5 ? vec4(t.rgb * t.rgb, t.a) : t; }
`;
