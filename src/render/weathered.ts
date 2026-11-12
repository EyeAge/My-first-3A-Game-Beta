import * as THREE from 'three';

// "风化"材质：给纯色的钢结构（起重机、灯杆、船壳、围墙）加上深浅不匀的旧漆、锈斑和雨痕。
//
// 这些东西全是一个个方盒子拼的，没法一个个去画贴图。办法是让着色器直接用"世界坐标"去取噪声：
// 空间里每个位置的脏污程度是固定的，不管那里摆的是哪根梁，所以不需要贴图坐标，接缝也天然对得上。

export function weathered<T extends THREE.MeshStandardMaterial>(mat: T) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vWn;')
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        vec4 wpI = vec4(transformed, 1.0); vec3 wnI = normal;
        #ifdef USE_INSTANCING
          wpI = instanceMatrix * wpI; wnI = mat3(instanceMatrix) * wnI;
        #endif
        vWp = (modelMatrix * wpI).xyz; vWn = normalize(mat3(modelMatrix) * wnI);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vWp; varying vec3 vWn;
        float wh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float wn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(wh(i), wh(i+vec3(1,0,0)), f.x), mix(wh(i+vec3(0,1,0)), wh(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(wh(i+vec3(0,0,1)), wh(i+vec3(1,0,1)), f.x), mix(wh(i+vec3(0,1,1)), wh(i+vec3(1,1,1)), f.x), f.y), f.z); }
        float wfbm(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*wn(p); p = p*2.07 + 3.1; a *= 0.5; } return s; }
        float gRust;`)
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        float wPatch = wfbm(vWp * 0.55);                                           // 大片的新旧不匀
        float wRun = wn(vec3(vWp.x * 5.0, vWp.y * 0.22, vWp.z * 5.0));             // 竖向的雨痕：横向变化快，纵向变化慢
        float wSide = 1.0 - abs(vWn.y);                                            // 雨痕只出现在立面上
        gRust = smoothstep(0.56, 0.74, wfbm(vWp * 1.7 + 9.0)) * 0.75 + smoothstep(0.5, 0.0, vWp.y) * 0.35 * wn(vWp * 6.0); // 锈斑，贴近地面的地方更多
        diffuseColor.rgb *= 0.62 + 0.62 * wPatch;
        diffuseColor.rgb *= 1.0 - wSide * smoothstep(0.55, 0.9, wRun) * 0.4;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.105, 0.045, 0.02) * (0.6 + wn(vWp * 14.0)), gRust);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `float roughnessFactor = roughness;
        roughnessFactor = clamp(mix(0.3, 0.7, wPatch) - wSide * smoothstep(0.55, 0.9, wRun) * 0.15 + gRust * 0.4, 0.05, 1.0);`);
  };
  mat.customProgramCacheKey = () => 'weathered';
  return mat;
}
