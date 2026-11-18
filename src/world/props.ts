import * as THREE from 'three';

// 灯的两样"气氛"：灯下雨雾里的光锥，和远处看过去的那一点光晕。
// 灯具本身（灯杆、灯头、发光的灯面）是道具模型的事（props/site.ts、props/equipment.ts）；这里画的是灯光在空气里的样子。

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

// ------------------------------------------------------------------ 灯下的光锥
/**
 * 雨夜里的灯，灯下能看到一个朦胧的光锥 —— 那是雨雾在散射灯光。
 * 这里不做真的体积光，而是在每盏灯下面放一个半透明的圆锥：正对着看的地方亮，擦着边看的地方淡，离灯越远越淡。
 *
 * 每个光锥给四个数：锥尖在哪（pos，就是灯的位置）、朝哪照（dir，单位向量）、有多长（length）、底面多大（radius）。
 * 几何体只有一份 —— 一个尖朝上、高 1 米、底面半径 1 米的"单位圆锥"；每盏灯用自己的矩阵把它拉长、撑开、转到要照的方向。
 */
export function lightCones(lamps: { pos: THREE.Vector3; dir: THREE.Vector3; length: number; radius: number }[]) {
  const geo = new THREE.ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0); // 锥尖在原点，朝 -y 张开
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.66, 0.36) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vH; varying float vD;
      void main(){
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        // 圆锥被拉成了不等比例（长十几米、底面半径五六米），法线不能直接乘同一个矩阵 —— 那样会朝被拉长的方向歪。
        // 正确的做法是每个轴除以"拉伸倍数的平方"再乘矩阵：拉得越长的方向，法线在那个方向上的分量越小。
        mat3 im = mat3(instanceMatrix);
        vec3 stretch2 = max(vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])), vec3(1e-6)); // 拉伸倍数的平方，垫一个下限免得除以 0
        vN = normalMatrix * (im * (normal / stretch2));
        vV = -mv.xyz; vH = -position.y; vD = -mv.z;   // vH：0 在锥尖，1 在底面
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying float vH; varying float vD;
      void main(){
        // 注意：normalize 的输入一旦是零向量、pow 的底数一旦是负数（插值误差就能让 1-vH 略小于 0），有的显卡会算出"非数"，
        // 再被泛光一扩散就是满屏的黑块。所以向量都先加一点点再归一化，底数都先夹到 0 以上。
        float facing = pow(clamp(abs(dot(normalize(vN + 1e-5), normalize(vV + 1e-5))), 0.0, 1.0), 2.2); // 擦着锥面边缘看过去的地方淡出，轮廓才是软的
        float h = clamp(vH, 0.0, 1.0);
        float fall = pow(1.0 - h, 1.6) * smoothstep(0.0, 0.06, h);            // 离灯越远越淡
        float fog = exp(-vD * vD * 0.000034) * smoothstep(1.0, 5.0, vD);      // 远处融进雾里；贴到眼前也淡掉
        gl_FragColor = vec4(max(uColor * facing * fall * fog * 0.15, vec3(0.0)), 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, lamps.length);
  lamps.forEach((lamp, i) => {
    q.setFromUnitVectors(DOWN, lamp.dir);                       // 把"朝下"转到这盏灯照的方向
    mesh.setMatrixAt(i, m4.compose(lamp.pos, q, scale.set(lamp.radius, lamp.length, lamp.radius)));
  });
  mesh.frustumCulled = false; mesh.renderOrder = 4;
  return mesh;
}

// ------------------------------------------------------------------ 灯的光晕
/**
 * 远处的灯。灯具本身在远处只有一两个像素大，直接画就是一个生硬的亮方块，还会一闪一闪。
 * 所以每盏灯另外画一个始终朝向镜头的柔和光点：中间一个亮芯，外面一圈淡淡的晕；
 * 离得再远也不会小于几个像素，于是远看是"一点灯光"而不是"一个亮像素"。blink 大于 0 的会按这个周期闪（航空障碍灯）。
 */
export function flares(list: { x: number; y: number; z: number; r: number; g: number; b: number; size: number; blink?: number }[]) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(list.length * 3), colr = new Float32Array(list.length * 3), par = new Float32Array(list.length * 2);
  list.forEach((f, i) => { pos.set([f.x, f.y, f.z], i * 3); colr.set([f.r, f.g, f.b], i * 3); par.set([f.size, f.blink ?? 0], i * 2); });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
  geo.setAttribute('aPar', new THREE.BufferAttribute(par, 2));
  const uniforms = { uTime: { value: 0 }, uScale: { value: 800 } };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute vec2 aPar; uniform float uTime; uniform float uScale; varying vec3 vC;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(0.1, -mv.z);
        float px = aPar.x * uScale / d;
        gl_PointSize = clamp(px, 5.0, 260.0);
        float on = aPar.y > 0.0 ? smoothstep(0.0, 0.12, fract(uTime / aPar.y + position.x * 0.013)) * smoothstep(0.5, 0.3, fract(uTime / aPar.y + position.x * 0.013)) : 1.0;
        // 太远时点已经缩不动了，就改成把亮度降下来；再乘上雾
        vC = aColor * on * min(1.0, px / 5.0) * exp(-d * d * 0.000022);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `varying vec3 vC;
      void main(){ vec2 p = gl_PointCoord - 0.5; float d2 = dot(p, p) * 4.0; float a = exp(-d2 * 26.0) + 0.22 * exp(-d2 * 5.0) * (1.0 - smoothstep(0.7, 1.0, d2)); gl_FragColor = vec4(max(vC * a, vec3(0.0)), 1.0); }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.renderOrder = 5;
  return { points, uniforms };
}
