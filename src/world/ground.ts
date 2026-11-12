import * as THREE from 'three';
import { reflectionUniforms } from '../render/reflection';
import { asphaltTextures, paintWearTexture, stencilTexture } from './textures';

// 港区的地面：一整块湿漉漉的路面，加上刷在上面的标线。
//
// 地面只是一个大平面，"哪里有积水、哪里只是潮、雨点砸出的涟漪、映出来的倒影"全部是在片元着色器里算出来的。

export function buildGround(quayX: number) {
  const group = new THREE.Group();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), col = new THREE.Color();

  const asphalt = asphaltTextures();
  asphalt.map.repeat.set(185, 240); asphalt.normalMap.repeat.set(185, 240); // 一张图铺 2.5 米见方，石子大约一两厘米
  const groundMat = new THREE.MeshStandardMaterial({ map: asphalt.map, normalMap: asphalt.normalMap, normalScale: new THREE.Vector2(1.15, 1.15), roughness: 0.5, metalness: 0, envMapIntensity: 1.0 });
  // 往标准材质里注入一段着色器，按世界坐标的噪声把地面分成三种状态：
  //   · 积水：路面低洼的地方。水把石子全淹了，表面是平的，像镜子，雨点在上面砸出一圈圈涟漪
  //   · 潮湿：积水周围一圈。颜色更深，石子尖还露着，反光是碎的
  //   · 淋湿：其余的地方。粗糙，只有逆光看才有一层细碎的亮
  const reflection = reflectionUniforms();
  groundMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, reflection);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec4 vRefl;\nuniform mat4 uReflM;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRefl = uReflM * vec4(vWp, 1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vWp;
        float phash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float pnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(phash(i), phash(i+vec2(1,0)), f.x), mix(phash(i+vec2(0,1)), phash(i+vec2(1,1)), f.x), f.y); }
        float pfbm(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*pnoise(p); p = p*2.03 + 5.3; a *= 0.5; } return s; }
        float gPud; float gDamp; vec2 gRp; float gCrest;
        varying vec4 vRefl;
        uniform sampler2D tRefl; uniform float uReflOn; uniform float uReflTime;
        // 雨点打在积水上的涟漪：把水面分成格子，每格里有一圈按各自节奏不断扩散的环。
        // 返回 xy = 水面被推斜的方向（用来扭曲倒影和高光），z = 波峰有多高（用来给波峰描一道亮边）。
        // 波峰的截面是一条平滑的鼓包，而且到了格子边缘就衰减到零 —— 以前用的是一截截断的正弦波，远看全是锯齿。
        vec3 rip(vec2 p, float t){
          vec2 i = floor(p), f = fract(p) - 0.5;
          float h = phash(i), tt = fract(t * 0.75 + h);
          vec2 d = f - (vec2(phash(i + 7.3), phash(i + 3.1)) - 0.5) * 0.4;
          float r = length(d), x = (r - tt * 0.4) / 0.032;
          float amp = (1.0 - tt) * (1.0 - tt) * smoothstep(0.5, 0.36, r);
          float bump = exp(-x * x);
          float drop = smoothstep(0.035, 0.0, r) * smoothstep(0.14, 0.0, tt);     // 雨点刚砸下去溅起的那一小点
          return vec3(d / max(r, 1e-3) * (-x * bump) * amp * 2.0, bump * amp + drop);
        }`)
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
        float low = pfbm(vWp.xz * 0.085) + (pnoise(vWp.xz * 0.9) - 0.5) * 0.07;   // 路面的高低：大的起伏加一点小的坑洼，积水的边缘才不是光溜溜的弧线
        gPud = smoothstep(0.475, 0.535, low);
        gDamp = smoothstep(0.34, 0.475, low);
        // 离得远了，一圈涟漪还没有一个像素宽，硬画只会闪成噪点，所以按"一个像素盖住多大一块地面"把它淡掉
        float gFoot = max(fwidth(vWp.x), fwidth(vWp.z));
        vec3 r3 = rip(vWp.xz * 1.4, uReflTime) * (1.0 - smoothstep(0.03, 0.12, gFoot))
                + rip(vWp.xz * 2.3 + 7.0, uReflTime + 0.37) * (1.0 - smoothstep(0.02, 0.08, gFoot))
                + rip(vWp.xz * 3.7 + 3.0, uReflTime + 0.71) * 0.7 * (1.0 - smoothstep(0.012, 0.05, gFoot));
        gRp = r3.xy * gPud; gCrest = r3.z * gPud;
        diffuseColor.rgb *= mix(mix(1.0, 0.6, gDamp), 0.32, gPud);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `float roughnessFactor = roughness;
        float gWet = pfbm(vWp.xz * 0.7 + 3.0);
        roughnessFactor = mix(mix(mix(0.8, 0.55, gWet), 0.34, gDamp), 0.03, gPud);`)
      // 法线：积水里把石子的凹凸抹平（水面是平的），换成涟漪的起伏
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
        vec3 waterN = normalize((viewMatrix * vec4(normalize(vec3(-gRp.x * 0.45, 1.0, -gRp.y * 0.45)), 0.0)).xyz);
        normal = normalize(mix(normal, waterN, gPud));`)
      // 平面反射：用镜像相机拍到的画面替换掉"只有天空"的环境反射。越粗糙的地方采样越模糊的层级，占比也越低
      .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
        if (uReflOn > 0.5) {
          // 没积水的地方，倒影被石子打散：按石子的法线把采样位置推开，越粗糙推得越远、图像也越糊
          vec3 wn = (vec4(normal, 0.0) * viewMatrix).xyz;
          vec2 ruv = vRefl.xy / vRefl.w + gRp * 0.03 + wn.xz * 0.05 * (1.0 - gPud);
          vec3 refl = textureLod(tRefl, ruv, roughnessFactor * 5.0).rgb;
          float fres = 0.04 + 0.96 * pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 5.0);
          reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular, refl * fres, 1.0 - smoothstep(0.25, 0.8, roughnessFactor));
        }
        // 波峰和水花映着天光的一道亮边。要放在上面那段倒影替换之后再加，否则会被倒影整个盖掉——
        // 没有它的话，涟漪只有在灯的倒影里才看得出来，暗处的水塘就像没在下雨
        reflectedLight.indirectSpecular += gCrest * vec3(0.055, 0.06, 0.07);`);
  };
  groundMat.customProgramCacheKey = () => 'wet-ground-refl-2';
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(462, 600), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(quayX - 231, 0, 0);
  ground.receiveShadow = true;

  group.add(ground);

  // ---------------------------------------------------------------- 标线
  const marks: { x: number; z: number; w: number; l: number; c: number }[] = [];
  const WHITE = 0xb9b6ac, YEL = 0xb38d2c;
  for (let z = -96; z <= 96; z += 6) marks.push({ x: -18, z, w: 0.18, l: 3, c: WHITE });
  for (const x of [-25.7, -10.3]) marks.push({ x, z: 0, w: 0.16, l: 196, c: YEL });
  for (const z of [-47.55, -15.85, 15.85, 47.55]) for (let x = -24.6; x <= -11.2; x += 1.1) marks.push({ x, z, w: 0.55, l: 4, c: WHITE });
  for (let x = -24.6; x <= -11.2; x += 1.1) marks.push({ x, z: 86, w: 0.55, l: 4, c: WHITE });
  for (const x of [34, 58]) { marks.push({ x: x - 0.4, z: 0, w: 0.12, l: 198, c: 0x1c1e20 }); marks.push({ x: x + 0.4, z: 0, w: 0.12, l: 198, c: 0x1c1e20 }); }
  marks.push({ x: quayX - 1.8, z: 0, w: 0.3, l: 198, c: YEL }, { x: 27.4, z: 0, w: 0.2, l: 198, c: YEL });
  for (let z = -90; z <= 90; z += 20) marks.push({ x: 46, z, w: 22, l: 0.16, c: YEL });
  const markGeo = new THREE.PlaneGeometry(1, 1); markGeo.rotateX(-Math.PI / 2);
  // 标线的磨损按世界坐标取，而不是按每条线自己的贴图坐标：不然一条 200 米的长线会把磨损图拉成一道道"木纹"
  const markMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, transparent: true, opacity: 0.78, alphaMap: paintWearTexture(), depthWrite: false });
  markMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWxz = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWxz;')
      .replace('#include <alphamap_fragment>', 'diffuseColor.a *= texture2D(alphaMap, vWxz * 0.42).g;');
  };
  markMat.customProgramCacheKey = () => 'road-marks';
  const markMesh = new THREE.InstancedMesh(markGeo, markMat, marks.length);
  marks.forEach((mk, i) => { markMesh.setMatrixAt(i, m4.compose(v1.set(mk.x, 0.012, mk.z), q.identity(), v2.set(mk.w, 1, mk.l))); markMesh.setColorAt(i, col.setHex(mk.c)); });
  markMesh.receiveShadow = true;
  group.add(markMesh);
  for (const [x, z] of [[46, 50], [46, -60]]) {
    const st = new THREE.Mesh(new THREE.PlaneGeometry(9, 4.5), new THREE.MeshStandardMaterial({ map: stencilTexture('B4'), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    st.rotation.x = -Math.PI / 2; st.rotation.z = -Math.PI / 2; st.position.set(x, 0.014, z);
    group.add(st);
  }


  return { mesh: ground, group, reflection };
}
