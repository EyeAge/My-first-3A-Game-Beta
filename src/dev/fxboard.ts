import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, atlasTexture, bakeAddAtlas, bakeLitAtlas } from '../render/fxatlas';

// 粒子图集陈列板（只在开发时用）：把两张图集的每个通道单独摊开，检查烟团的轮廓、法线、四边是不是都归零了。
//
//   /viewer.html?m=dev/fxboard&fn=fxAtlasBoard&ground=0&views=0,0,9.5
//
// 四块板子，每块是一张 4×2 的图集（编号从左下角开始往右数，下面一排是 0–3，上面一排是 4–7）：
//   左上  受光图集的不透明度（白 = 实，黑 = 透明）：0–5 是烟团，6 是水柱，7 是更实的一团
//   右上  受光图集的法线（红 = 朝右歪，绿 = 朝上歪，均匀的灰色 = 没歪）
//   左下  受光图集的厚度
//   右下  叠加图集的亮度：0 光晕、1 火星条、2 和 3 星芒、4 冲击环、5 火团、6 圆点、7 喷焰

/** 只显示贴图的某一部分通道的材质。pick 是一段把采样结果 t 变成颜色的 GLSL 表达式。 */
function channelMaterial(tex: THREE.Texture, pick: string) {
  return new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex } }, toneMapped: false,
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform sampler2D uTex; varying vec2 vUv; void main(){ vec4 t = texture2D(uTex, vUv); gl_FragColor = vec4(${pick}, 1.0); }`,
  });
}

export function fxAtlasBoard() {
  const group = new THREE.Group();
  const lit = atlasTexture(bakeLitAtlas()), add = atlasTexture(bakeAddAtlas());
  const rows: [THREE.Texture, string][] = [[lit, 'vec3(t.a)'], [lit, 'vec3(t.rg, 0.5)'], [lit, 'vec3(t.b)'], [add, 't.rgb']];
  const w = ATLAS_COLS * 1.2, h = ATLAS_ROWS * 1.2;
  rows.forEach(([tex, pick], i) => {
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, h), channelMaterial(tex, pick));
    sheet.position.set((i % 2 ? 0.5 : -0.5) * (w + 0.15), (i < 2 ? 0.5 : -0.5) * (h + 0.15), 0);
    group.add(sheet);
  });
  return group;
}
