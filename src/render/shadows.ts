import * as THREE from 'three';

// 太阳的影子。
//
// 太阳只有 13° 高，影子拖得很长（10 米高的箱垛，影子有 40 多米）。影子好不好看，取决于两件事：
//   1. 阴影图够不够细 —— 一张图要盖住多大的范围；
//   2. 影子的边缘 —— 真实的影子，贴着物体根部是硬的，拖得越远越虚（因为太阳不是一个点）。
//      three 自带的滤波是"全场一样虚"，所以这里把它换成自己写的一段（PCSS：按遮挡物的远近决定虚化的宽度）。

/** 阴影图在世界里盖住的范围（米）：横向宽、纵向高、深度方向的长度。 */
export const SHADOW_RANGE = { width: 116, height: 68, near: 40, far: 460 };

/**
 * 把 three 的"查影子"函数换成软阴影版本。只需要在创建渲染器之后调一次。
 * taps 是滤波的采样次数：多了影子边缘更干净，也更慢。
 */
export function installSoftShadows(taps = 16) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const a = chunk.indexOf('float getShadow(');
  let b = chunk.indexOf('// cubeToUV()');
  if (b < 0) b = chunk.indexOf('vec2 cubeToUV');
  if (a < 0 || b < a || chunk.includes('slVogel')) return; // 版本对不上或者已经装过：保持原样，用 three 自带的
  const SEARCH = 8;
  const depth = SHADOW_RANGE.far - SHADOW_RANGE.near;
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.slice(0, a) + /* glsl */ `
  const vec2 SL_FRUSTUM = vec2( ${SHADOW_RANGE.width.toFixed(3)}, ${SHADOW_RANGE.height.toFixed(3)} );   // 阴影图横竖各盖住多少米
  const float SL_DEPTH = ${depth.toFixed(3)};                                                             // 深度方向 0..1 对应多少米
  // 每个像素一个不同的随机角度：把采样点转一转，条带状的瑕疵就变成细碎的噪点，看不出来
  float slIGN( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
  // 在圆盘里均匀撒 n 个点（向日葵籽的排法）
  vec2 slVogel( int i, int n, float phi ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
    float th = float( i ) * 2.39996323 + phi;
    return r * vec2( cos( th ), sin( th ) );
  }
  float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
    shadowCoord.xyz /= shadowCoord.w;
    vec3 sc = shadowCoord.xyz;
    vec3 dx = dFdx( sc ), dy = dFdy( sc );
    bool inFrustum = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0;
    if ( ! ( inFrustum && sc.z <= 1.0 ) ) return 1.0;
    // 受光面本身是斜的：在阴影图里往旁边挪一点，它的深度也跟着变。把这个斜率解出来，
    // 比较深度时按斜率修正，就不用靠一个很大的固定偏移来避免"自己挡自己"的条纹
    float det = dx.x * dy.y - dx.y * dy.x;
    vec2 dz = vec2( 0.0 );
    if ( abs( det ) > 1e-12 ) dz = vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
    vec2 texel = 1.0 / shadowMapSize;
    float maxSlope = 0.0030 / max( texel.x, texel.y );
    dz = clamp( dz, vec2( - maxSlope ), vec2( maxSlope ) );
    float zr = sc.z + shadowBias - ( abs( dz.x ) * texel.x + abs( dz.y ) * texel.y ) * 0.35;
    float phi = slIGN( gl_FragCoord.xy ) * 6.2831853;
    // 第一步：在周围找一找有没有东西挡着太阳，挡着的话平均离多远
    vec2 searchR = ( 0.55 * shadowRadius ) / SL_FRUSTUM;
    float blk = 0.0, nb = 0.0;
    for ( int i = 0; i < ${SEARCH}; i ++ ) {
      vec2 o = slVogel( i, ${SEARCH}, phi ) * searchR;
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      float z = zr + dot( o, dz );
      if ( d < z ) { blk += d; nb += 1.0; }
    }
    if ( nb < 0.5 ) return 1.0;
    float avg = blk / nb;
    // 第二步：遮挡物离得越远，影子的边缘越宽（1.2 厘米到 60 厘米之间）
    float distM = max( zr - avg, 0.0 ) * SL_DEPTH;
    float penM = clamp( distM * 0.022 * shadowRadius, 0.012 * shadowRadius, 0.60 * shadowRadius );
    vec2 filtR = max( vec2( penM ) / SL_FRUSTUM, texel * 1.25 );
    float lit = 0.0;
    for ( int i = 0; i < ${taps}; i ++ ) {
      vec2 o = slVogel( i, ${taps}, phi + 1.7 ) * filtR;
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
      lit += step( zr + dot( o, dz ), d );
    }
    lit /= float( ${taps} );
    // 阴影图的边缘渐渐过渡到"没有影子"，这样就看不到阴影范围的边界线
    vec2 e = min( sc.xy, 1.0 - sc.xy );
    lit = mix( 1.0, lit, smoothstep( 0.0, 0.02, min( e.x, e.y ) ) );
    return mix( 1.0, lit, shadowIntensity );
  }

  ` + chunk.slice(b);
}

/** 按固定的范围设置太阳的阴影相机。 */
export function setupSunShadow(sun: THREE.DirectionalLight) {
  const c = sun.shadow.camera;
  c.left = -SHADOW_RANGE.width / 2; c.right = SHADOW_RANGE.width / 2;
  c.bottom = -SHADOW_RANGE.height / 2; c.top = SHADOW_RANGE.height / 2;
  c.near = SHADOW_RANGE.near; c.far = SHADOW_RANGE.far;
  c.updateProjectionMatrix();
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 1; // 在上面的软阴影里，它的意思是"虚化宽度的倍数"
}

const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _c = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
/**
 * 让阴影范围跟着玩家走。
 * 每次移动都对齐到"整数个阴影像素"，否则阴影图的像素格子相对世界一滑动，影子的边缘就会跟着抖。
 */
export function followSunShadow(sun: THREE.DirectionalLight, sunDir: THREE.Vector3, focus: THREE.Vector3) {
  _right.crossVectors(UP, sunDir).normalize();      // 从太阳看过去的"右"
  _up.crossVectors(sunDir, _right).normalize();     // 从太阳看过去的"上"
  const size = sun.shadow.mapSize.x || 2048;
  const tx = SHADOW_RANGE.width / size, ty = SHADOW_RANGE.height / size;
  // 范围的中心放在玩家头顶上方一点：地面以上的东西（箱垛、起重机腿）比地面以下的多
  _c.set(focus.x, 11, focus.z);
  const u = Math.round(_c.dot(_right) / tx) * tx, v = Math.round(_c.dot(_up) / ty) * ty, w = _c.dot(sunDir);
  _c.set(0, 0, 0).addScaledVector(_right, u).addScaledVector(_up, v).addScaledVector(sunDir, w);
  sun.target.position.copy(_c);
  sun.position.copy(_c).addScaledVector(sunDir, 250);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
}
