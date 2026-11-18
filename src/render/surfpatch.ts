import * as THREE from 'three';

// 材质库的着色器补丁。
//
// three.js 的标准材质（MeshStandardMaterial）已经会算光照了，我们不重写它，只在它的着色器里"动几处手术"：
// three.js 的着色器是由一段段具名的代码块（#include <xxx>）拼起来的，把其中几块换成自己的就行。换掉的是：
//
//   取颜色（map_fragment）       —— 四种染色方式、大面积的深浅不均（macro）、被雨打湿
//   取粗糙度 / 金属度 / 法线 / 遮蔽 —— 都从同一张"遮蔽-粗糙-金属"图里读；湿的地方更光滑；水珠
//
// 雨湿是这里最要紧的一件事：它不是画在贴图里的，而是每个像素按"这块表面朝哪"现算的 ——
// 朝天的面最湿，立面上是一道道往下淌的水痕，朝下的面淋不到雨是干的，贴近地面的一圈被溅湿。
// 所以同一种漆，刷在箱顶和刷在箱底，湿的样子自动就不一样。

export interface SurfaceUniforms {
  /** 全场共用的湿度（0 干 … 1 正在下雨）。所有材质指向同一个对象，改一处全场都变。 */
  uSurfWet: { value: number };
  /** 这种材质淋雨的反应：x 变暗多少，y 湿了以后粗糙度乘多少，z 立面有多湿，w 挂不挂水珠。 */
  uSurfWetParams: { value: THREE.Vector4 };
  /** 大面积上的不均匀：x 颜色起伏，y 光泽起伏，z 每米起伏几次，w 脏污多少。 */
  uSurfMacro: { value: THREE.Vector4 };
  /** x 淋雨系数（室外 1，室内 0.12）；y 三平面投影时每米重复几次；z 贴图边长（像素）。 */
  uSurfMisc: { value: THREE.Vector3 };
}

// ---------------------------------------------------------------- 顶点着色器
// 多传一个量给片元：这个点在世界里的位置（噪声按它取，所以脏污的斑块在相邻的两个箱子之间是连续的）。
const VERT_DECL = /* glsl */ `
varying vec3 vSurfPos;
#ifdef SURF_TRIPLANAR
varying vec3 vSurfObjNormal; varying vec3 vSurfAxisX; varying vec3 vSurfAxisY;
#endif
`;
const VERT_BODY = /* glsl */ `
#if defined( SURF_TRIPLANAR ) && defined( SURF_WORLD )
  // 世界坐标版的三平面投影：直接拿"摆好以后"的世界位置去取贴图。
  // 给没有米制贴图坐标、而且不会动的东西用（按实例缩放的钢梁、直接用 BoxGeometry 搭的墙）：不管零件被拉多长，纹理密度都一样。
  // 代价是贴图不跟着物体走 —— 物体一动，纹理就在它表面上滑，所以会动的东西不能用。
  vec4 surfWorld = vec4(transformed, 1.0);
  mat3 surfTurn = mat3(modelMatrix);
  #ifdef USE_INSTANCING
    surfWorld = instanceMatrix * surfWorld; surfTurn = surfTurn * mat3(instanceMatrix);
  #endif
  vSurfPos = (modelMatrix * surfWorld).xyz;
  vSurfObjNormal = surfTurn * normal;            // 对盒子这类"面正对着轴"的几何体是准确的；拉伸过的曲面会略有偏差，只影响混合权重
  vSurfAxisX = mat3(viewMatrix) * vec3(1.0, 0.0, 0.0); vSurfAxisY = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);   // 世界的 x、y 轴在镜头坐标系里的方向
#elif defined( SURF_TRIPLANAR )
  // 三平面投影：用"骨骼还没动之前"的位置和法线去取贴图，于是不管四肢怎么摆，贴图都粘在零件上不会滑。
  vSurfPos = position; vSurfObjNormal = normal;
  // 贴图里的凹凸是在模型自己的坐标系里算的，要转到镜头的坐标系才能参与光照。
  // 所以把模型的 x、y 两根轴也跟着骨骼、实例一路变换过去，片元里用它们搭一个转换的架子。
  vec3 surfAxisX = vec3(1.0, 0.0, 0.0), surfAxisY = vec3(0.0, 1.0, 0.0);
  #ifdef USE_SKINNING
    surfAxisX = (skinMatrix * vec4(surfAxisX, 0.0)).xyz; surfAxisY = (skinMatrix * vec4(surfAxisY, 0.0)).xyz;
  #endif
  #ifdef USE_INSTANCING
    surfAxisX = mat3(instanceMatrix) * surfAxisX; surfAxisY = mat3(instanceMatrix) * surfAxisY;
  #endif
  surfAxisX = mat3(modelViewMatrix) * surfAxisX; surfAxisY = mat3(modelViewMatrix) * surfAxisY;
  vSurfAxisX = surfAxisX * inversesqrt(max(dot(surfAxisX, surfAxisX), 1e-12));   // 归一化；长度垫一个极小值，免得除以 0
  vSurfAxisY = surfAxisY * inversesqrt(max(dot(surfAxisY, surfAxisY), 1e-12));
#else
  // 世界坐标。实例化网格（同一个模型摆几十份）每一份有自己的 instanceMatrix，要先乘上它
  vec4 surfWorld = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    surfWorld = batchingMatrix * surfWorld;
  #endif
  #ifdef USE_INSTANCING
    surfWorld = instanceMatrix * surfWorld;
  #endif
  vSurfPos = (modelMatrix * surfWorld).xyz;
#endif
`;

// ---------------------------------------------------------------- 片元着色器：声明和工具函数
const FRAG_DECL = /* glsl */ `
uniform float uSurfWet; uniform vec4 uSurfWetParams; uniform vec4 uSurfMacro; uniform vec3 uSurfMisc;
varying vec3 vSurfPos;
#ifdef SURF_TRIPLANAR
varying vec3 vSurfObjNormal; varying vec3 vSurfAxisX; varying vec3 vSurfAxisY;
vec3 surfTriWeight; vec2 surfUvX; vec2 surfUvY; vec2 surfUvZ;
// 从 x、y、z 三个方向各取一次贴图，按表面朝向加权混合
vec4 surfTriSample(sampler2D t){ return texture2D(t, surfUvX) * surfTriWeight.x + texture2D(t, surfUvY) * surfTriWeight.y + texture2D(t, surfUvZ) * surfTriWeight.z; }
#endif
// 下面这些量在"取颜色"那一块里算好，后面取粗糙度、法线的几块还要用，所以放在函数外面
vec4 surfOrm;                                  // r 遮蔽，g 粗糙度，b 金属度
vec2 surfUv;
vec3 surfNormalTexel = vec3(0.5, 0.5, 1.0);    // 法线图上取到的原始值（默认是"平的"）
float surfWetK = 0.0;                          // 这个像素有多湿 0..1
float surfUp = 0.0;                            // 这个像素有多"朝天" 0..1
float surfMacroA = 0.5; float surfMacroB = 0.5; // 两层大尺度噪声
float surfBead = 0.0;                          // 这个像素是不是落在一颗水珠上
// 归一化，但零向量不会变成"非数"（一个非数像素会被泛光扩散成一大块黑斑）
vec3 surfSafeNormalize(vec3 v){ return v * inversesqrt(max(dot(v, v), 1e-12)); }
// 三维值噪声：整数格点上各有一个固定的随机数，格子内部平滑过渡。便宜（8 次哈希），输出 0..1
float surfHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float surfNoise(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(surfHash(i), surfHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(surfHash(i + vec3(0.0, 1.0, 0.0)), surfHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(surfHash(i + vec3(0.0, 0.0, 1.0)), surfHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(surfHash(i + vec3(0.0, 1.0, 1.0)), surfHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

// ---------------------------------------------------------------- 取颜色：采样 → 不均匀 → 雨湿 → 水珠 → 染色
const FRAG_MAP = /* glsl */ `
#ifdef SURF_TRIPLANAR
  { vec3 objN = surfSafeNormalize(vSurfObjNormal);
    // 权重 = 法线分量的 6 次方：只有接近 45° 的窄窄一条才是两个方向混合，其余地方只用一个方向，不糊
    vec3 w3 = pow(abs(objN), vec3(6.0)); surfTriWeight = w3 / max(w3.x + w3.y + w3.z, 1e-6);
    vec3 q = vSurfPos * uSurfMisc.y; surfUvX = q.zy; surfUvY = q.xz; surfUvZ = q.xy; }
  vec4 sampledDiffuseColor = surfTriSample(map);
  surfOrm = surfTriSample(roughnessMap);
#else
  surfUv = vMapUv;   // 模型的贴图坐标单位是米；three.js 已经替我们乘过贴图的 repeat（= 1 / 一张图铺多少米）
  // SURF_LOD：让显卡提前换用更小（更糊）的那级贴图。波纹板这种"一条亮一条暗"的规则花纹，缩到每个波只剩三四个像素时
  // 会和屏幕的像素格子"打架"，墙上出现斜着的摩尔纹；提前一级换小图，波纹在快要打架之前就已经化成均匀的灰
  #ifndef SURF_LOD
    #define SURF_LOD 0.0
  #endif
  vec4 sampledDiffuseColor = texture2D(map, surfUv, SURF_LOD);
  surfOrm = texture2D(roughnessMap, surfUv, SURF_LOD);
  #ifdef USE_NORMALMAP_TANGENTSPACE
    surfNormalTexel = texture2D(normalMap, surfUv, SURF_LOD).xyz;
    #ifdef SURF_STRIPES
      // 条纹状的凹凸（波纹板）还要单独处理：一个像素里装下的条纹超过 1/7 道，就开始把凹凸淡掉；到 1/3 道时完全抹平。
      // 光靠缩小图不够 —— 法线记的是坡度（左坡朝左、右坡朝右），缩小图里它一直保持着一左一右的强反差，直到小到和屏幕像素"打架"。
      // 抹平后的法线故意留短一点（0.8 而不是 1）：下面"远处防闪"那段会把它当成"这里原本有凹凸"，把高光摊开，墙面不会突然变成镜子
      { float stripesPerPixel = fwidth(surfUv.x) * SURF_STRIPES;
        surfNormalTexel = mix(surfNormalTexel, vec3(0.5, 0.5, 0.9), smoothstep(0.14, 0.34, stripesPerPixel)); }
    #endif
  #endif
#endif
#ifdef SURF_FX
  {
    // 这块表面在世界里朝哪。three.js 给的法线是"镜头坐标系"里的，用镜头的朝向把它转回世界
    #ifdef FLAT_SHADED
      vec3 viewN = surfSafeNormalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    #else
      vec3 viewN = surfSafeNormalize(vNormal);
      #ifdef DOUBLE_SIDED
        viewN *= gl_FrontFacing ? 1.0 : -1.0;
      #endif
    #endif
    vec3 worldN = surfSafeNormalize((vec4(viewN, 0.0) * viewMatrix).xyz);

    // ---- 大面积的不均匀：按世界坐标取两层噪声（第二层细 3.7 倍），让一整面墙不是一个颜色
    vec3 macroP = vSurfPos * uSurfMacro.z;
    surfMacroA = surfNoise(macroP); surfMacroB = surfNoise(macroP * 3.7 + 11.3);
    float shade = surfMacroA * 0.65 + surfMacroB * 0.35 - 0.5;                 // -0.5 .. 0.5
    sampledDiffuseColor.rgb *= 1.0 + uSurfMacro.x * shade * 2.0;               // 亮度最多 ± macro.x
    // 脏污：噪声高的地方脏；贴图里凹下去的地方（遮蔽值低）更容易积脏
    float grime = smoothstep(0.5, 0.85, surfMacroA * 0.6 + surfMacroB * 0.4 + (1.0 - surfOrm.r) * 0.3) * uSurfMacro.w;
    sampledDiffuseColor.rgb *= 1.0 - grime * 0.35;
    #if SURF_TINT == 1
      sampledDiffuseColor.a *= 1.0 - grime * 0.2;                              // 脏的地方漆色也淡一点
    #endif

    // ---- 雨湿
    surfUp = smoothstep(0.15, 0.85, worldN.y);                                 // 朝天的程度
    float exposed = smoothstep(-0.4, -0.05, worldN.y);                         // 淋不淋得到：明显朝下的面是 0
    float streak = 0.0;
    #if !defined( SURF_TRIPLANAR ) || defined( SURF_WORLD )
      // 立面上的水痕：横向变化快（每米 9 次和 29 次）、竖向变化慢（每米不到 1 次）的噪声 → 一道道竖条
      float across = vSurfPos.x + vSurfPos.z;
      streak = surfNoise(vec3(across * 9.0, vSurfPos.y * 0.55, across * 0.7 + 3.0)) * surfNoise(vec3(across * 29.0, vSurfPos.y * 1.1, 7.0));
      // 再乘一层米级的噪声：有的墙面水痕多，有的几乎没有
      streak = smoothstep(0.12, 0.42, streak) * smoothstep(0.3, 0.7, surfNoise(vec3(across * 1.1, vSurfPos.y * 0.25, 1.7)));
    #endif
    float rain = uSurfWet * uSurfMisc.x * exposed;                             // 全场湿度 × 室内外 × 淋不淋得到
    // 立面：材质自己的"立面湿度" × (0.55 .. 1.45，看有没有水痕)；朝天：0.75 .. 1.25。按朝天的程度在两者之间过渡
    surfWetK = rain * mix(uSurfWetParams.z * (0.55 + 0.9 * streak), 0.75 + 0.5 * surfMacroA, surfUp);
    #if !defined( SURF_TRIPLANAR ) || defined( SURF_WORLD )
      { // 溅湿带：离地半米以内的立面，被地上溅起来的水打湿，顺便溅上泥（最多暗 22%）。这里假定地面在 y = 0
        float low = smoothstep(0.5, 0.0, vSurfPos.y) * (1.0 - surfUp) * exposed;
        surfWetK += rain * low * 0.6;
        float mud = 1.0 - low * min(uSurfMacro.w, 0.5) * 0.45;
        sampledDiffuseColor.rgb *= mud;
        #if SURF_TINT == 1
          sampledDiffuseColor.a *= mud;
        #endif
      }
    #endif
    surfWetK = clamp(surfWetK, 0.0, 1.0);

    // ---- 水珠：只在近处有。一个像素盖住的范围超过 8 毫米就不画了，远处画了只会闪
    float nearK = clamp(1.0 - length(fwidth(vSurfPos)) * 120.0, 0.0, 1.0);
    if (uSurfWetParams.w > 0.0 && nearK > 0.0) {
      float n = surfNoise(vSurfPos * 170.0) * 0.6 + surfNoise(vSurfPos * 410.0 + 5.0) * 0.4;   // 约 6 毫米和 2.4 毫米两种大小
      surfBead = smoothstep(0.6, 0.68, n) * uSurfWetParams.w * rain * nearK * (0.4 + 0.6 * surfUp + 0.5 * streak);
    }
  }
#endif

// ---- 染色：贴图的颜色和材质的颜色怎么合在一起（diffuse 是材质色）
#if SURF_TINT == 1
  // 漆 / 金属 / 塑料：贴图 rgb 是不跟着染的覆盖物（锈、底漆、灰），alpha 是"还剩多少漆"
  diffuseColor.rgb = sampledDiffuseColor.rgb + diffuse * sampledDiffuseColor.a;
#elif SURF_TINT == 2
  // 混凝土上刷漆：漆色跟着混凝土的明暗起伏（0.19 是混凝土的平均亮度），alpha 是漆的覆盖率，掉了的地方露出混凝土
  { float lum = clamp(dot(sampledDiffuseColor.rgb, vec3(0.3333)) / 0.19, 0.55, 1.35);
    diffuseColor.rgb = mix(sampledDiffuseColor.rgb, diffuse * lum, sampledDiffuseColor.a * 0.96); }
#elif SURF_TINT == 3
  diffuseColor *= sampledDiffuseColor;        // 玻璃、铁丝网：连透明度一起乘
#else
  diffuseColor.rgb *= sampledDiffuseColor.rgb; // 贴图自带颜色，材质色只是整体压一个色调
#endif

#ifdef SURF_FX
  { // 湿了的东西颜色更深、更鲜艳（想想淋湿的水泥地）。吸水的材质变化大，漆面几乎不变
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(vec3(lum), diffuseColor.rgb, 1.0 + 0.5 * surfWetK * uSurfWetParams.x);   // 系数大于 1 = 提高饱和度
    diffuseColor.rgb = max(diffuseColor.rgb, vec3(0.0)) * (1.0 - uSurfWetParams.x * surfWetK);      // 提饱和可能把某个通道推成负数，夹回 0
  }
#endif

#ifdef SURF_ACUT
  // 铁丝网：靠"alpha 小于阈值就不画"镂空。问题是远处一根丝还不到一个像素宽，要么整根消失、要么一闪一闪。
  // 办法：先估计贴图被缩小了多少级（lod）。贴图缩小以后，每个像素的 alpha 其实是"这一小块里铁丝占了几成"；
  // 所以一旦开始缩小，就不再用固定的 0.5 当阈值，而是按屏幕位置的固定花纹给每个像素一个 0…1 的阈值 ——
  // 占了三成的像素有三成的机会留下。这样不管隔多远，留下来的像素占的比例都等于铁丝真正占的比例：
  // 近处是一根根丝，远一点是断断续续的丝，再远是一层稳定的"薄纱"。
  // （以前是"缩得越小阈值越低"，想让丝保持一个像素宽；结果 5–15 米这一段留下的像素比铁丝多出好几倍，整片网糊成了一堵白墙。）
  { vec2 texelsPerPixel = fwidth(surfUv) * uSurfMisc.z; float lod = log2(max(max(texelsPerPixel.x, texelsPerPixel.y), 1e-4));
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float cut = mix(0.5, 0.04 + dither * 0.92, smoothstep(0.5, 2.5, lod));
    diffuseColor.a = sampledDiffuseColor.a > cut ? 1.0 : 0.0;
    diffuseColor.rgb *= mix(1.0, 0.45, smoothstep(1.5, 4.5, lod)); }   // 远处留下来的像素其实代表更细的丝，压暗一些，免得阳光下变成一片白
#endif
`;

// ---------------------------------------------------------------- 粗糙度：贴图 → 不均匀 → 湿 → 水珠 → 远处防闪
const FRAG_ROUGHNESS = /* glsl */ `
float roughnessFactor = roughness * surfOrm.g;
#ifdef SURF_FX
  roughnessFactor += uSurfMacro.y * ((surfMacroB - 0.5) * 1.4 + (surfMacroA - 0.5) * 0.8);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * uSurfWetParams.y, surfWetK);   // 水膜把表面填平了：湿的地方更光滑
  roughnessFactor = mix(roughnessFactor, 0.05, surfBead);                                 // 水珠就是一小块极光滑的点，靠反光显出来
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( SURF_TRIPLANAR )
  // 远处防闪：法线图缩小以后，方向各异的法线被平均，平均出来的向量会变短。短了多少，就说明那里原本有多少凹凸 ——
  // 把这些"看不见了的凹凸"折算成粗糙度，高光就会散开而不是碎成一片闪烁的亮点
  { float normalLen = length(surfNormalTexel * 2.0 - 1.0);
    roughnessFactor = sqrt(max(roughnessFactor * roughnessFactor + clamp(1.0 - normalLen, 0.0, 1.0) * 0.6, 0.0)); }
#endif
roughnessFactor = clamp(roughnessFactor, 0.045, 1.0);
`;

const FRAG_METALNESS = /* glsl */ `
float metalnessFactor = clamp(metalness * surfOrm.b, 0.0, 1.0);
`;

// ---------------------------------------------------------------- 法线
const FRAG_NORMAL = /* glsl */ `
#ifdef SURF_TRIPLANAR
  { vec3 objN = surfSafeNormalize(vSurfObjNormal);
    vec3 tx = texture2D(normalMap, surfUvX).xyz * 2.0 - 1.0, ty = texture2D(normalMap, surfUvY).xyz * 2.0 - 1.0, tz = texture2D(normalMap, surfUvZ).xyz * 2.0 - 1.0;
    tx.xy *= normalScale; ty.xy *= normalScale; tz.xy *= normalScale;
    // 三个方向取到的凹凸各自叠到表面原本的法线上，再按权重混合，得到模型坐标系里的法线
    tx = vec3(tx.xy + objN.zy, abs(tx.z) * objN.x); ty = vec3(ty.xy + objN.xz, abs(ty.z) * objN.y); tz = vec3(tz.xy + objN.xy, abs(tz.z) * objN.z);
    vec3 objBumped = surfSafeNormalize(tx.zyx * surfTriWeight.x + ty.xzy * surfTriWeight.y + tz.xyz * surfTriWeight.z);
    // 用顶点着色器传来的两根轴（第三根是它们的叉积）把它转到镜头坐标系
    vec3 axisX = surfSafeNormalize(vSurfAxisX), axisY = surfSafeNormalize(vSurfAxisY); vec3 axisZ = cross(axisX, axisY);
    normal = surfSafeNormalize(axisX * objBumped.x + axisY * objBumped.y + axisZ * objBumped.z);
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  }
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  { vec3 mapN = surfNormalTexel * 2.0 - 1.0;
    mapN.xy *= normalScale * (1.0 - 0.45 * surfWetK * surfUp);   // 朝天的湿表面：水膜把细小的凹凸填平了，凹凸强度最多减 45%
    normal = surfSafeNormalize(tbn * mapN); }
#endif
`;

// ---------------------------------------------------------------- 调试：把"湿度"直接画出来
// 地址栏加 ?surfdebug=1 时生效：红 = 有多湿，绿 = 水珠，蓝 = 有多朝天。调雨湿参数的时候比盯着高光猜要直观得多。
const FRAG_DEBUG = /* glsl */ `
#ifdef SURF_DEBUG
  gl_FragColor.rgb = vec3(surfWetK, surfBead, surfUp * 0.5);
#endif
`;

/**
 * 给一个标准材质的着色器动手术。在 material.onBeforeCompile 里调用。
 * 材质上需要已经设好这几个宏：SURF_TINT（0–3），可选 SURF_FX（要不要不均匀和雨湿）、SURF_TRIPLANAR（三平面投影；
 * 再加 SURF_WORLD 就是按世界坐标投影）、SURF_ACUT（铁丝网镂空）。
 */
export function patchSurfaceShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: SurfaceUniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_DECL)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
  // 遮蔽：three.js 原本要另取一次贴图，改成直接用上面已经取到的那个值
  const ao = THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'surfOrm.r');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
    .replace('#include <map_fragment>', FRAG_MAP)
    .replace('#include <roughnessmap_fragment>', FRAG_ROUGHNESS)
    .replace('#include <metalnessmap_fragment>', FRAG_METALNESS)
    .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
    .replace('#include <aomap_fragment>', ao)
    .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + FRAG_DEBUG);
}
