import * as THREE from 'three';

// 室内的"环境探针"。
//
// 室外的东西，阴影里的亮度来自天空的环境贴图。但屋里看不到天——如果屋里的物体还是被整片天空照亮，
// 它们就会和屋外一样亮，屋子就"关不上灯"。
// 办法：站在屋子中间，朝上下左右前后六个方向各拍一张（一个立方体贴图），把它当成屋里物体的"天空"。
// 屋子本身是暗的，只有门洞和屋顶破洞是亮的，于是屋里的物体自然就暗下来，并且只在朝着门的那一面带一点亮。

/**
 * 在 pos 处拍一张环境探针，返回可以直接赋给 material.envMap 的贴图。
 * prepare 在拍之前调用（比如把天空切到"不画太阳圆盘"的模式），返回一个拍完以后恢复原状的函数。
 */
export function captureProbe(gl: THREE.WebGLRenderer, scene: THREE.Scene, pos: THREE.Vector3, prepare?: () => () => void): THREE.Texture {
  const target = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  const cam = new THREE.CubeCamera(0.15, 300, target);
  cam.position.copy(pos);
  const restore = prepare?.();
  const prevTarget = gl.getRenderTarget();
  gl.shadowMap.needsUpdate = true; // 阴影图要是最新的：屋里暗不暗全靠它
  cam.update(gl, scene);
  gl.setRenderTarget(prevTarget);
  restore?.();
  // 再模糊成各个粗糙度都能用的版本（越粗糙的表面，反射越糊）
  const pmrem = new THREE.PMREMGenerator(gl);
  const env = pmrem.fromCubemap(target.texture).texture;
  pmrem.dispose();
  target.dispose();
  return env;
}
