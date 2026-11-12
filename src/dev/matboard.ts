import * as THREE from 'three';
import { decal, DECALS, labelAtlasUsage, labelMaterial } from '../render/labels';
import { surface, SURFACES, surfaceStats, wetness, type SurfaceName } from '../render/surfaces';
import { Kit } from '../world/kit';

// 材质样板（只在开发时用）。
//
// 每种材质摆一组三样：一块立着的板、一个倒角盒、一个球，排成一排，方便在查看器里一眼对比：
//   /viewer.html?m=dev/matboard&fn=matBoard                         全部材质，每排 8 个
//   /viewer.html?m=dev/matboard&fn=matBoard&args=[["paint_red","steel_galv"]]   只看指定的几个
//   /viewer.html?m=dev/matboard&fn=matBoard&args=[["paint_red"],8,0]            第三个参数是湿度：0 是完全干的，用来和默认的 1 对比
//
// 三样东西各看一件事：
//   立板  —— 立面上的水痕、贴近地面的溅湿带、贴图平铺得有没有接缝（板宽 0.9 米，漆面的贴图 2.5 米一张）
//   盒子  —— 顶面朝天，应该比侧面更湿更亮；倒角上应该接得住一道高光
//   球    —— 高光的形状：漆面是一个柔和的亮斑，金属是清楚的环境倒影

/** 一组样品占多宽（米）。 */
const CELL = 1.15;

/**
 * names 不给就是材质表里的全部；perRow 是每排摆几个（一排摆不下就往后另起一排）；wet 是全场湿度（0 干 … 1 下雨）。
 * 返回一个 Group，原点在第一排的中间、地面上。
 */
export function matBoard(names?: string[] | null, perRow = 8, wet = 1): THREE.Group {
  wetness.value = wet;
  const list = (names && names.length ? names : Object.keys(SURFACES)) as SurfaceName[];
  const k = new Kit('matboard');
  const cols = Math.min(perRow, list.length);
  list.forEach((name, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * CELL, z = -row * 2.2;
    k.at([x, 0, z], null, () => {
      k.box(name, 0.9, 1.5, 0.04, 0, 0.75, -0.3, { c: 0.004 });          // 立板，立在地上
      k.box(name, 0.36, 0.36, 0.36, -0.22, 0.18, 0.12, { c: 0.02 });      // 倒角盒：2 厘米的大倒角，看棱上的高光
      k.sph(name, 0.19, 0.24, 0.19, 0.18, { seg: 32 });
      k.label(name, { color: 'white', font: 'sans', distress: 0 }, CELL * 0.95, 0.07, [0, 0.002, 0.52], [-Math.PI / 2, 0, 0]); // 名字贴在地上
    });
  });
  const group = k.finish({ grime: 0 }).group; // 不烤脏：这里要看的是材质本身
  // 生成贴图花了多久、占多少显存，放到 window 上，截图工具和控制台都能读到
  (window as unknown as { __surfaces: unknown }).__surfaces = surfaceStats();
  console.info('[matboard]', JSON.stringify(surfaceStats()));
  return group;
}

/**
 * 把贴图集的三张图摊开来看（不打光）：每种材质一排四格，每格铺 2×2 张，接缝有没有对上一眼就能看出来。
 *   /viewer.html?m=dev/matboard&fn=texSheet&args=[["paint_red","steel_galv"]]&ground=0&views=0,0,6
 * 四格从左到右：颜色（不跟着染色的部分）、染色量（alpha）、遮蔽-粗糙-金属（红绿蓝三个通道）、法线。
 */
export function texSheet(names: string[]): THREE.Group {
  const group = new THREE.Group();
  const size = 1.2; // 每格的边长（米）
  names.forEach((name, row) => {
    const mat = surface(name as SurfaceName) as THREE.MeshStandardMaterial;
    const maps: [THREE.Texture | null, number][] = [[mat.map, 0], [mat.map, 1], [mat.roughnessMap, 0], [mat.normalMap, 0]];
    maps.forEach(([tex, alphaOnly], col) => {
      if (!tex) return;
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShaderMaterial({
        uniforms: { tMap: { value: tex }, uAlphaOnly: { value: alphaOnly } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv * 2.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D tMap; uniform float uAlphaOnly; varying vec2 vUv;
          void main(){ vec4 t = texture2D(tMap, vUv); gl_FragColor = vec4(uAlphaOnly > 0.5 ? vec3(t.a) : t.rgb, 1.0);
            #include <colorspace_fragment>
          }`,
      }));
      quad.position.set((col - 1.5) * (size + 0.05), -row * (size + 0.05), 0);
      group.add(quad);
    });
  });
  (window as unknown as { __surfaces: unknown }).__surfaces = surfaceStats();
  return group;
}

/**
 * 实例化网格的检查：同一组样品用 InstancedMesh 摆三份 —— 原样、转 45°、整个放倒。
 * 配合 ?surfdebug=1 看：放倒的那份，现在朝天的面应该是最湿的（说明湿度是按"摆好以后"的朝向算的，而不是模型自己的朝向）。
 *   /viewer.html?m=dev/matboard&fn=instancedBoard&args=[["paint_red"]]&surfdebug=1
 */
export function instancedBoard(names: string[] = ['paint_red']): THREE.Group {
  const src = matBoard(names), group = new THREE.Group();
  const poses: [THREE.Vector3, THREE.Euler][] = [
    [new THREE.Vector3(-1.8, 0, 0), new THREE.Euler(0, 0, 0)],
    [new THREE.Vector3(0, 0, 0), new THREE.Euler(0, Math.PI / 4, 0)],
    [new THREE.Vector3(1.8, 0.5, 0.6), new THREE.Euler(-Math.PI / 2, 0, 0)], // 向后放倒：原来朝前的面现在朝天
  ];
  for (const child of src.children) {
    const mesh = child as THREE.Mesh;
    const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, poses.length);
    poses.forEach(([p, r], i) => inst.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(r), new THREE.Vector3(1, 1, 1))));
    inst.castShadow = inst.receiveShadow = true;
    inst.computeBoundingSphere(); inst.computeBoundingBox();
    group.add(inst);
  }
  return group;
}

/**
 * 三平面投影 + 骨骼蒙皮的检查：一根两节的"手臂"（没有贴图坐标），第二节弯 70°。
 * 要看的是：贴图有没有跟着弯过去的那一节走（不滑动、不拉伸），以及弯过去以后朝天的面是不是湿的。
 *   /viewer.html?m=dev/matboard&fn=triplanarArm&args=["armor_white"]
 */
export function triplanarArm(name = 'armor_white', bend = 1.2): THREE.Group {
  const len = 0.5, geo = new THREE.BoxGeometry(0.16, len * 2, 0.16, 4, 16, 4);
  geo.deleteAttribute('uv'); // 故意去掉贴图坐标：三平面投影不需要它
  const pos = geo.getAttribute('position'), n = pos.count;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), color = new Float32Array(n * 3).fill(1);
  for (let i = 0; i < n; i++) {
    // 靠近中间的顶点同时受两根骨头影响，弯起来才是圆滑的
    const t = Math.min(1, Math.max(0, pos.getY(i) / 0.12 + 0.5));
    skinIndex[i * 4] = 0; skinIndex[i * 4 + 1] = 1;
    skinWeight[i * 4] = 1 - t; skinWeight[i * 4 + 1] = t;
    if (pos.getY(i) > 0.3) { color[i * 3] = 1; color[i * 3 + 1] = 0.34; color[i * 3 + 2] = 0.08; } // 末端用顶点色染成橙色
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  const root = new THREE.Bone(), tip = new THREE.Bone();
  root.position.y = -len; tip.position.y = len; root.add(tip);
  const mesh = new THREE.SkinnedMesh(geo, surface(name as SurfaceName, { triplanar: true, vertexColors: true }));
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, tip]));
  tip.rotation.z = bend;
  mesh.position.y = len + 0.02;
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  // 旁边再放一个不带骨骼、歪着摆的三平面方块作对照
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3).deleteAttribute('uv'), surface(name as SurfaceName, { triplanar: true }));
  block.position.set(0.5, 0.25, 0); block.rotation.set(0.5, 0.6, 0.2); block.castShadow = true;
  group.add(block);
  group.updateMatrixWorld(true);
  return group;
}

/**
 * 文字和贴纸的样张：全部具名贴纸排成一面墙（深灰漆面打底，藏青色的那张垫一块白板），下面是几行不同颜色、不同做旧程度的喷字。
 *   /viewer.html?m=dev/matboard&fn=decalSheet&views=0,5,5.2&target=0,1.5,0
 * atlas 为 true 时不排版，直接把整张图集贴出来看（检查排得满不满、有没有互相压到）。
 */
export function decalSheet(atlas = false): THREE.Group {
  const k = new Kit('decalsheet');
  const names = Object.keys(DECALS).filter((n) => n !== 'flammable' && n !== 'warning'); // 这两个是别名，不重复摆
  const cols = 6, cell = 0.62, rows = Math.ceil(names.length / cols);
  const top = 0.9 + rows * cell;
  k.box('paint_grey', cols * cell + 0.2, top + 0.1, 0.04, 0, (top + 0.1) / 2, -0.02, { c: 0.004 });
  names.forEach((name, i) => {
    const x = ((i % cols) - (cols - 1) / 2) * cell, y = top - 0.35 - Math.floor(i / cols) * cell;
    const aspect = decal(name).aspect, w = aspect >= 1 ? 0.54 : 0.54 * aspect; // 放进 0.54 米见方的格子里，保持宽高比
    if (name === 'logo_c' || name === 'corrosive') k.box('paint_white', 0.58, 0.58 / Math.max(1, aspect) + 0.04, 0.004, x, y, 0.002, { plain: true });
    k.decal(name, w, [x, y, 0.006], undefined, w / aspect);
  });
  // 几行字：颜色、字体、做旧程度各不相同
  k.box('paint_white', cols * cell - 0.2, 0.16, 0.004, 0, 0.09, 0.002, { plain: true });
  k.label('激战港区  B4-0271', { color: 'white' }, 3.4, 0.14, [-0.9, 0.62, 0.004]);
  k.label('最大总重 30480 千克', { color: 'yellow', distress: 0.6 }, 3.4, 0.11, [-0.9, 0.44, 0.004]);
  k.label('危险', { color: 'red', distress: 0.2 }, 1, 0.16, [1.2, 0.62, 0.004]);
  k.label('Fragile 0123456789', { color: 'orange', distress: 0.9 }, 2, 0.11, [0.95, 0.44, 0.004]);
  k.label('请勿靠近', { color: 'black', font: 'sans' }, 1, 0.12, [-1.2, 0.09, 0.006]);
  k.label('JZTU 402719 6', { color: 'navy', distress: 0.5 }, 2, 0.12, [0.6, 0.09, 0.006]);
  const group = k.finish({ grime: 0 }).group;
  if (atlas) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: (labelMaterial() as THREE.MeshStandardMaterial).map, transparent: true }));
    quad.position.set(0, 1.6, 0.2);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 3.1), new THREE.MeshBasicMaterial({ color: 0x3a4048 }));
    back.position.set(0, 1.6, 0.19);
    const only = new THREE.Group();
    only.add(back, quad);
    console.info('[decalSheet] 图集用掉', (labelAtlasUsage() * 100).toFixed(0) + '%');
    (window as unknown as { __surfaces: unknown }).__surfaces = { atlasUsed: labelAtlasUsage() };
    return only;
  }
  return group;
}

/**
 * 世界坐标投影的检查：同一个 1 米的方块（贴图坐标是 0..1，不是米）拉成长短不一的几根梁，再用 InstancedMesh 摆几份。
 * 左边一组用 { world: true }：不管拉多长，纹理都一样密。右边一组不用：纹理被拉花了。
 *   /viewer.html?m=dev/matboard&fn=worldBeams&args=["paint_yellow"]
 */
export function worldBeams(name = 'paint_yellow'): THREE.Group {
  const group = new THREE.Group(), unit = new THREE.BoxGeometry(1, 1, 1);
  const beams: [number, number, number, number, number, number, number][] = [ // 尺寸 x、y、z，位置 x、y、z，绕竖轴转多少
    [3, 0.2, 0.2, 0, 0.1, 0, 0], [0.2, 2, 0.2, -1.4, 1, 0, 0], [0.2, 2, 0.2, 1.4, 1, 0, 0], [3, 0.3, 0.3, 0, 2.15, 0, 0], [2.4, 0.12, 0.12, 0, 1.1, 0, 0.5], [1, 1, 1, 0, 0.8, -1.2, 0.4],
  ];
  [surface(name as SurfaceName, { world: true }), surface(name as SurfaceName)].forEach((mat, side) => {
    const inst = new THREE.InstancedMesh(unit, mat, beams.length);
    beams.forEach(([sx, sy, sz, x, y, z, yaw], i) => inst.setMatrixAt(i, new THREE.Matrix4().compose(
      new THREE.Vector3(x + (side ? 2 : -2), y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(sx, sy, sz))));
    inst.castShadow = inst.receiveShadow = true;
    inst.computeBoundingSphere(); inst.computeBoundingBox();
    group.add(inst);
  });
  return group;
}
