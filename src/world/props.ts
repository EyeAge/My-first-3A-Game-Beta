import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import { compose, hazardTape, layers, rustPatch, rustRun, tintByAlpha } from './container';

// 港区里的小物件：路锥、油桶、水泥隔离墩、木箱。
// 每一种都是"一个带细节的几何体 + 一套现画的贴图"，再用实例化一次画出所有的。

const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function merge(parts: THREE.BufferGeometry[]) {
  // 把几块几何体拼成一个，每块是一个材质分组
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  parts.forEach((p, gi) => {
    const base = pos.length / 3, start = idx.length;
    pos.push(...(p.getAttribute('position').array as Float32Array)); nor.push(...(p.getAttribute('normal').array as Float32Array)); uv.push(...(p.getAttribute('uv').array as Float32Array));
    const index = p.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + base);
    else for (let i = 0; i < p.getAttribute('position').count; i++) idx.push(base + i);
    g.addGroup(start, idx.length - start, gi);
  });
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ 路锥
/** 路锥：黑色橡胶底座 + 橙色锥身 + 两道白色反光带。 */
export function coneMesh(list: { x: number; z: number; rot: number; tilt: number }[]) {
  const H = 0.7;
  // 锥身的侧面轮廓：底下有一圈裙边，顶上是圆头
  const prof: [number, number][] = [[0.165, 0.03], [0.15, 0.045], [0.138, 0.06], [0.036, H - 0.03], [0.03, H - 0.012], [0.018, H], [0, H]];
  const body = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 20);
  const uv = body.getAttribute('uv'), pos = body.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getY(i) / H);
  const base = new THREE.BoxGeometry(0.4, 0.035, 0.4).translate(0, 0.0175, 0);
  // 底座切掉四个角，变成八边形
  const geo = merge([body, base]);

  const S = 256, l = layers(S, S, 255), p = l.paint, o = l.over;
  const rng = mulberry32(31);
  p.fillStyle = '#d2551c'; p.fillRect(0, 0, S, S);
  // 画布的顶对应锥尖。反光带是带细密菱格的白色
  for (const [y0, h] of [[70, 34], [128, 40]] as const) {
    p.fillStyle = '#d8d8d2'; p.fillRect(0, y0, S, h);
    p.strokeStyle = 'rgba(120,120,120,0.35)'; p.lineWidth = 1;
    for (let k = -h; k < S + h; k += 7) { p.beginPath(); p.moveTo(k, y0); p.lineTo(k + h, y0 + h); p.stroke(); p.beginPath(); p.moveTo(k + h, y0); p.lineTo(k, y0 + h); p.stroke(); }
  }
  // 蹭脏的地方、底部溅上来的泥
  for (let i = 0; i < 40; i++) { o.fillStyle = `rgba(20,18,16,${0.15 + rng() * 0.3})`; o.fillRect(rng() * S, 20 + rng() * 230, 4 + rng() * 26, 1 + rng() * 3); }
  for (let i = 0; i < 90; i++) { o.fillStyle = `rgba(34,30,26,${0.2 + rng() * 0.4})`; o.beginPath(); o.arc(rng() * S, S - Math.pow(rng(), 2) * 70, 1 + rng() * 4, 0, 6.3); o.fill(); }
  const tex = compose(l, 4, 0.3, () => 0);
  const mats = [
    new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.rough, roughness: 0.9, metalness: 0 }),
    new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6, metalness: 0 }),
  ];
  const mesh = new THREE.InstancedMesh(geo, mats, list.length);
  list.forEach((c, i) => {
    q.setFromAxisAngle(UP, c.rot);
    if (c.tilt) q.premultiply(new THREE.Quaternion().setFromAxisAngle(v1.set(Math.cos(c.rot), 0, Math.sin(c.rot)), Math.PI / 2 - 0.22)); // 被撞倒的
    mesh.setMatrixAt(i, m4.compose(v1.set(c.x, c.tilt ? 0.16 : 0, c.z), q, v2.set(1, 1, 1)));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ 油桶
/** 200 升钢桶：上下卷边、桶身两道加强箍、桶盖上的灌口。颜色按实例染。 */
export function drumMesh(list: { x: number; z: number; c: number; rot: number }[]) {
  const H = 0.9, R = 0.29;
  const prof: [number, number][] = [[0, 0.012], [R - 0.012, 0.012], [R - 0.008, 0], [R + 0.006, 0.004], [R + 0.006, 0.02], [R, 0.03]];
  for (const y of [0.3, 0.6]) prof.push([R, y - 0.03], [R + 0.012, y - 0.012], [R + 0.012, y + 0.012], [R, y + 0.03]); // 加强箍
  prof.push([R, H - 0.03], [R + 0.006, H - 0.02], [R + 0.006, H - 0.004], [R - 0.008, H], [R - 0.014, H - 0.018], [0.11, H - 0.018], [0.1, H - 0.006], [0.06, H - 0.006], [0.05, H - 0.018], [0, H - 0.018]);
  const geo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 22);
  const uv = geo.getAttribute('uv'), pos = geo.getAttribute('position');
  for (let i = 0; i < uv.count; i++) uv.setY(i, pos.getY(i) / H);

  const W = 512, S = 256, l = layers(W, S, 205), o = l.over;
  const rng = mulberry32(88);
  o.textBaseline = 'middle'; o.textAlign = 'center';
  // 桶身的喷字和一张危险品标签
  o.fillStyle = 'rgba(230,228,220,0.85)'; o.font = `900 30px ${FONT}`; o.fillText('激战润滑', 128, 118); o.font = `700 15px ${FONT}`; o.fillText('液压油 46号 · 200升', 128, 146);
  o.save(); o.translate(380, 128); o.rotate(Math.PI / 4); o.fillStyle = '#d8d4c8'; o.fillRect(-30, -30, 60, 60); o.strokeStyle = '#1a1a1a'; o.lineWidth = 2.5; o.strokeRect(-25, -25, 50, 50); o.rotate(-Math.PI / 4);
  o.fillStyle = '#b8341d'; o.beginPath(); o.moveTo(0, -18); o.lineTo(-9, 2); o.lineTo(9, 2); o.fill(); o.fillStyle = '#1a1a1a'; o.font = `800 11px ${FONT}`; o.fillText('易燃液体', 0, 14); o.restore();
  // 箍和卷边上磨掉漆，桶底一圈生锈，桶身有几道淌下来的油污
  for (const y of [S * (1 - 0.3 / H), S * (1 - 0.6 / H), 6, S - 6]) for (let x = 0; x < W; x += 3) if (rng() < 0.5) { o.fillStyle = `rgba(150,146,140,${0.2 + rng() * 0.5})`; o.fillRect(x, y - 2 + rng() * 3, 2 + rng() * 6, 1.5); }
  for (let i = 0; i < 46; i++) rustPatch(o, rng, rng() * W, S - 16 + rng() * 12, 3 + rng() * 7);
  for (let i = 0; i < 14; i++) rustPatch(o, rng, rng() * W, 30 + rng() * 200, 2 + rng() * 6);
  for (let i = 0; i < 9; i++) rustRun(o, rng, rng() * W, 12 + rng() * 60, 60 + rng() * 150, 4 + rng() * 10, 0.4);
  for (let i = 0; i < 7; i++) { const x = rng() * W, len = 60 + rng() * 150, gr = o.createLinearGradient(0, 14, 0, 14 + len); gr.addColorStop(0, 'rgba(8,8,9,0.7)'); gr.addColorStop(1, 'rgba(8,8,9,0)'); o.fillStyle = gr; o.fillRect(x, 14, 5 + rng() * 12, len); }
  const tex = compose(l, 6, 0.45, () => 0);
  const mat = tintByAlpha(new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.rough, roughness: 0.85, metalness: 0.35 }));
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((d, i) => { mesh.setMatrixAt(i, m4.compose(v1.set(d.x, 0, d.z), q.setFromAxisAngle(UP, d.rot), v2.set(1, 1, 1))); mesh.setColorAt(i, col.setHex(d.c)); });
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ 水泥隔离墩
/** 新泽西护栏：下宽上窄的截面沿长度方向拉出来，两头有吊装用的凹槽感（靠贴图）。 */
export function barrierMesh(list: { x: number; z: number; alongX: boolean }[]) {
  const LEN = 2.4, HT = 0.9;
  const pts: [number, number][] = [[-0.3, 0], [-0.3, 0.09], [-0.15, 0.3], [-0.085, 0.86], [-0.06, HT], [0.06, HT], [0.085, 0.86], [0.15, 0.3], [0.3, 0.09], [0.3, 0]];
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: LEN, bevelEnabled: false }).translate(0, 0, -LEN / 2);
  geo.computeVertexNormals();
  // 贴图坐标：侧面按"长度 × 高度"展开，端面缩在贴图的一角
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getZ(i)) > 0.5) uv.setXY(i, 0.02 + (pos.getX(i) + 0.3) * 0.25, pos.getY(i) / HT);
    else uv.setXY(i, pos.getZ(i) / LEN + 0.5, nor.getY(i) > 0.9 ? 0.99 : pos.getY(i) / HT);
  }

  const W = 512, S = 256, l = layers(W, S, 96), p = l.paint, o = l.over;
  const rng = mulberry32(64);
  // 水泥：浇筑留下的横向模板缝、气孔
  for (const y of [70, 150]) { p.fillStyle = 'rgba(0,0,0,0.12)'; p.fillRect(0, y, W, 2); }
  for (let i = 0; i < 900; i++) { p.fillStyle = `rgba(0,0,0,${0.08 + rng() * 0.25})`; p.beginPath(); p.arc(rng() * W, rng() * S, 0.5 + rng() * 1.8, 0, 6.3); p.fill(); }
  // 两头刷着褪色的黄黑警示斜纹；中间喷着泊位号
  for (const x of [8, W - 8 - 70]) { o.globalAlpha = 0.7; hazardTape(o, x, 26, 70, 70); o.globalAlpha = 1; }
  o.fillStyle = 'rgba(28,28,28,0.6)'; o.font = `900 46px ${FONT}`; o.textAlign = 'center'; o.textBaseline = 'middle'; o.fillText('B4 · 禁止停放', W / 2, 74);
  // 顶上往下淌的水渍、磕掉的角、溅上来的泥
  for (let i = 0; i < 26; i++) { const x = rng() * W, len = 40 + rng() * 150, gr = o.createLinearGradient(0, 0, 0, len); gr.addColorStop(0, 'rgba(20,20,18,0.5)'); gr.addColorStop(1, 'rgba(20,20,18,0)'); o.fillStyle = gr; o.fillRect(x, 0, 3 + rng() * 14, len); }
  for (let i = 0; i < 30; i++) { o.fillStyle = `rgba(150,146,138,${0.25 + rng() * 0.3})`; o.beginPath(); o.ellipse(rng() * W, rng() < 0.5 ? rng() * 14 : 60 + rng() * 190, 3 + rng() * 7, 2 + rng() * 4, rng() * 3, 0, 6.3); o.fill(); }
  for (let i = 0; i < 160; i++) { o.fillStyle = `rgba(30,27,23,${0.2 + rng() * 0.4})`; o.beginPath(); o.arc(rng() * W, S - Math.pow(rng(), 2) * 60, 1 + rng() * 5, 0, 6.3); o.fill(); }
  for (let i = 0; i < 6; i++) rustRun(o, rng, rng() * W, 4, 40 + rng() * 80, 4 + rng() * 6, 0.35);
  const tex = compose(l, 12, 0.5, () => 0);
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.rough, roughness: 2.1, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((b, i) => mesh.setMatrixAt(i, m4.compose(v1.set(b.x, 0, b.z), q.setFromAxisAngle(UP, b.alongX ? Math.PI / 2 : 0), v2.set(1, 1, 1))));
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ 木箱
/** 木板钉的包装箱：横向的木板、四周和对角的加强条、喷码。 */
export function crateMesh(list: { x: number; y: number; z: number; s: number; h: number; c: number; rot: number }[]) {
  // 箱体本身 + 每个侧面凸出来的一圈边框和一根斜撑
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(0.94, 0.94, 0.94)];
  const board = (w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) => {
    const b = new THREE.BoxGeometry(w, h, d);
    const u = b.getAttribute('uv'); for (let i = 0; i < u.count; i++) u.setXY(i, 0.52 + u.getX(i) * 0.46 * Math.min(1, w), 0.02 + u.getY(i) * 0.1); // 边框用贴图上专门留出的一条木纹
    if (rz) b.rotateZ(rz);
    return b.translate(x, y, z);
  };
  const face: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) { face.push(board(1, 0.11, 0.035, 0, s * 0.445, 0.485)); face.push(board(0.11, 0.78, 0.035, s * 0.445, 0, 0.485)); }
  face.push(board(1.12, 0.1, 0.03, 0, 0, 0.482, Math.PI / 4));
  for (let k = 0; k < 4; k++) for (const f of face) parts.push(f.clone().rotateY((k * Math.PI) / 2));
  for (const s of [-1, 1]) for (const k of [0, 1]) parts.push(board(1, 0.035, 0.11, 0, 0.485, s * 0.445).rotateY((k * Math.PI) / 2));
  const all = merge(parts); all.clearGroups();

  const S = 512, l = layers(S, S, 255), p = l.paint, o = l.over;
  const rng = mulberry32(17);
  // 木板：一条一条横着排，每条的底色、木纹走向都不太一样
  const plank = (y0: number, h: number) => {
    const v = 150 + rng() * 50;
    p.fillStyle = `rgb(${v},${v * 0.8},${v * 0.56})`; p.fillRect(0, y0, S, h);
    for (let i = 0; i < 26; i++) { const yy = y0 + rng() * h; p.strokeStyle = `rgba(60,40,20,${0.08 + rng() * 0.2})`; p.lineWidth = 0.6 + rng() * 1.2; p.beginPath(); p.moveTo(0, yy); p.bezierCurveTo(S * 0.3, yy + (rng() - 0.5) * 8, S * 0.7, yy + (rng() - 0.5) * 8, S, yy + (rng() - 0.5) * 4); p.stroke(); }
    if (rng() < 0.5) { const kx = rng() * S, ky = y0 + h / 2; p.fillStyle = 'rgba(50,30,14,0.6)'; p.beginPath(); p.ellipse(kx, ky, 7, 4, 0, 0, 6.3); p.fill(); } // 木节
    p.fillStyle = 'rgba(10,6,2,0.75)'; p.fillRect(0, y0 + h - 2, S, 2.5);                                                                              // 板缝
    for (const x of [22, S - 22]) { p.fillStyle = 'rgba(30,30,30,0.8)'; p.beginPath(); p.arc(x, y0 + h / 2, 2.2, 0, 6.3); p.fill(); }                  // 钉子
  };
  for (let y = 0; y < S; y += 64) plank(y, 64);
  o.fillStyle = 'rgba(16,16,14,0.75)'; o.textAlign = 'center'; o.textBaseline = 'middle';
  o.font = `900 44px ${FONT}`; o.fillText('小心轻放', S / 2, 150); o.font = `800 26px ui-monospace, monospace`; o.fillText('JZ-PORT B4 / 0427', S / 2, 300);
  o.strokeStyle = 'rgba(16,16,14,0.75)'; o.lineWidth = 5; for (const dx of [-24, 24]) { o.beginPath(); o.moveTo(S / 2 + dx, 410); o.lineTo(S / 2 + dx, 360); o.lineTo(S / 2 + dx - 10, 374); o.moveTo(S / 2 + dx, 360); o.lineTo(S / 2 + dx + 10, 374); o.stroke(); } // 向上箭头
  for (let i = 0; i < 40; i++) { o.fillStyle = `rgba(24,20,14,${0.1 + rng() * 0.25})`; o.beginPath(); o.ellipse(rng() * S, rng() * S, 6 + rng() * 30, 4 + rng() * 16, rng() * 3, 0, 6.3); o.fill(); }
  const tex = compose(l, 21, 0.45, () => 0);
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.rough, roughness: 1.5, metalness: 0, bumpMap: tex.map, bumpScale: 1.2 });
  const mesh = new THREE.InstancedMesh(all, mat, list.length);
  list.forEach((c, i) => { mesh.setMatrixAt(i, m4.compose(v1.set(c.x, c.y, c.z), q.setFromAxisAngle(UP, c.rot), v2.set(c.s, c.h, c.s))); mesh.setColorAt(i, col.setHex(c.c)); });
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ 路灯的光柱
/**
 * 雨夜里的路灯，灯下能看到一个朦胧的光锥 —— 那是雨雾在散射灯光。
 * 这里不做真的体积光，而是在每盏灯下面放一个半透明的圆锥：正对着看的地方亮，擦着边看的地方淡，越往下越淡。
 */
export function lightCones(lamps: THREE.Vector3[]) {
  const HT = 9.86, R = 6.4;
  const geo = new THREE.ConeGeometry(R, HT, 28, 1, true).translate(0, -HT / 2, 0); // 锥尖在原点，朝下张开
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.55, 0.24) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vH; varying float vD;
      void main(){
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz); vH = -position.y / ${HT.toFixed(2)}; vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying float vH; varying float vD;
      void main(){
        // 注意：pow 的底数一旦是负数（插值误差就能让 1-vH 略小于 0），有的显卡会算出"非数"，
        // 再被泛光一扩散就是满屏的黑块。所以底数都先夹到 0 以上。
        float facing = pow(clamp(abs(dot(normalize(vN + 1e-5), normalize(vV))), 0.0, 1.0), 2.2); // 擦着锥面边缘看过去的地方淡出，轮廓才是软的
        float h = clamp(vH, 0.0, 1.0);
        float fall = pow(1.0 - h, 1.6) * smoothstep(0.0, 0.06, h);            // 离灯越远越淡
        float fog = exp(-vD * vD * 0.000034) * smoothstep(1.0, 5.0, vD);      // 远处融进雾里；贴到眼前也淡掉
        gl_FragColor = vec4(max(uColor * facing * fall * fog * 0.15, vec3(0.0)), 1.0);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, lamps.length);
  lamps.forEach((p, i) => mesh.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
  mesh.frustumCulled = false; mesh.renderOrder = 4;
  return mesh;
}
