import * as THREE from 'three';
import './style.css';
import { GameAudio } from './audio/audio';
import { Input } from './core/input';
import { clamp, damp, lerp } from './core/math';
import { loadSettings, profileOf, saveSettings } from './core/settings';
import { Enemies } from './game/enemies';
import { Mission } from './game/mission';
import { Player } from './game/player';
import { Weapon } from './game/weapon';
import { Decals } from './render/decals';
import { Effects } from './render/effects';
import { PlanarReflection } from './render/reflection';
import { Renderer } from './render/renderer';
import { initSurfaces } from './render/surfaces';
import { UI, type HudFrame, type Marker } from './ui/ui';
import { bakeEnvironment, createSea, createSky } from './world/atmosphere';
import { createRain } from './world/rain';
import { bakedGroundMask, isPuddleAt, MASK_WATER_BELOW } from './world/groundmask';
import { buildPort, QUAY_X } from './world/port';

type State = 'menu' | 'playing' | 'paused' | 'dead' | 'won';

const bootEl = document.getElementById('boot')!, bootMsg = document.getElementById('boot-msg')!, bootFill = document.getElementById('boot-fill')!;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function step(msg: string, k: number) { bootMsg.textContent = msg; bootFill.style.width = `${k * 100}%`; await nextFrame(); await nextFrame(); }

async function boot() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const { settings, auto } = loadSettings();

  await step('正在启动渲染器', 0.08);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 1400);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  const renderer = new Renderer(canvas, scene, camera);
  initSurfaces(renderer.gl); // 材质库要用渲染器在显卡上生成贴图

  await step('正在生成涂装、锈迹与雨水', 0.2);
  const sky = createSky();
  scene.add(sky.mesh);
  scene.environment = bakeEnvironment(renderer.gl);
  scene.environmentIntensity = 2; // 没有单独的"环境光"：阴影里的亮度全部来自这张天空贴图

  await step('正在布置集装箱', 0.38);
  const port = buildPort(() => {});
  scene.add(port.group);
  await step('正在架设起重机', 0.56);
  const sea = createSea(QUAY_X);
  scene.add(sea.mesh);
  let rain = createRain(profileOf(settings.quality).rain, QUAY_X);
  rain.setShelter(port.shelter);
  // 雨点砸在地上的小水花优先落在水洼里：把地面烘好的那张积水掩码交给雨。切换画质会重建雨，所以包成函数，那边再调一次
  const givePuddles = (r: typeof rain) => { const m = bakedGroundMask(); if (m) r.setPuddleMask(m.texture, m.rect, MASK_WATER_BELOW); };
  givePuddles(rain);
  scene.add(rain.group);
  renderer.interior = port.interior; // 车间里的空气更"浑"：从门洞和屋顶破洞照进来的阳光会显出光柱

  await step('正在加载弹道与烟雾', 0.68);
  const effects = new Effects();
  scene.add(effects.group);
  effects.colliders = port.colliders;    // 特效要查"这里晒不晒得到太阳""脚下的地面多高"
  effects.setInterior(port.interior);    // 车间里的烟看不到天，不该被整片天空照亮
  renderer.overlay = effects.overlay;    // 粒子不和场景一起画：等场景和空气都合成完再盖上去，这样它能查到场景的深度（见 post.ts）
  const decals = new Decals();
  decals.interior = port.interior;       // 车间里的弹孔，露出来的铁皮不该映出一片天
  scene.add(decals.mesh);
  const audio = new GameAudio();
  audio.setVolume(settings.volume);

  await step('正在检查激战制式步枪', 0.78);
  const input = new Input(canvas);
  const player = new Player();
  const weapon = new Weapon();
  camera.add(weapon.view);
  weapon.view.visible = false;

  await step('正在启动港区主控', 0.88);
  const enemies = new Enemies({ colliders: port.colliders, nav: port.nav, effects, decals, audio, camera });
  scene.add(enemies.group);
  const ui = new UI(document.getElementById('ui')!, settings, input, auto);
  const mission = new Mission(port, enemies, ui, audio, weapon, player);
  enemies.onPlayerHit = (dmg, from) => { player.takeDamage(dmg, from, mission.time); audio.hurt(); input.rumble(0.8, 0.5, 160); };

  // 反射画面里不需要的东西：地面自己、雨（雨丝和地上的小水花都在 rain.group 里）、第一人称枪模、贴花，
  // 车间里面的东西（会反光的湿地面都在屋外，屋里的东西照不进去），
  // 还有海面——它比地面低，本来就会被反射的裁剪面整个裁掉，藏起来只是省掉白画的那一次
  renderer.reflection = new PlanarReflection(renderer.gl, scene, camera, port.reflection, () => [port.ground, sea.mesh, rain.group, weapon.view, decals.mesh, port.indoor]);
  const applyQuality = () => {
    const p = profileOf(settings.quality);
    renderer.setQuality(p, port.sun);
    port.setLampCount(p.lamps);
    scene.remove(rain.group); rain.dispose();
    rain = createRain(p.rain, QUAY_X); rain.setShelter(port.shelter); givePuddles(rain); scene.add(rain.group);
  };
  applyQuality();

  // ------------------------------------------------------------------ 车间里的环境光
  // 屋外的东西，背光面的亮度来自整片天空。屋里看不到天，所以站在屋子中间拍一张"环境探针"（probe.ts），
  // 让所有标了"室内"的材质改用它：屋顶和墙是暗的，只有门洞、破洞和吊灯是亮的，屋里的东西自然就暗下来。
  await step('正在测量车间里的光线', 0.9);
  const interiorEnv = renderer.captureProbe(port.probePos, () => {
    const hidden = [rain.group, effects.group, decals.mesh].filter((o) => o.visible);
    for (const o of hidden) o.visible = false;
    sky.uniforms.uEnv.value = 1; // 天空切到"只当光源"的模式：不画太阳圆盘，免得反射里出现一个刺眼的亮点
    return () => { for (const o of hidden) o.visible = true; sky.uniforms.uEnv.value = 0; };
  });
  scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (!mat.userData.interior || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      (mat as THREE.MeshStandardMaterial).envMap = interiorEnv;
      (mat as THREE.MeshStandardMaterial).envMapIntensity = 1; // 屋外是 2（scene.environmentIntensity）
    }
  });
  // 手里的枪也一样：人走进屋，枪身上映出来的就该是屋里而不是天空。每帧看一眼相机在不在室内范围里，变了才切换
  const gunMats: THREE.MeshStandardMaterial[] = [];
  weapon.view.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial && !gunMats.includes(mat as THREE.MeshStandardMaterial)) gunMats.push(mat as THREE.MeshStandardMaterial);
  });
  let indoors = false;
  const setIndoors = (v: boolean) => {
    indoors = v;
    for (const m of gunMats) { m.envMap = v ? interiorEnv : null; m.envMapIntensity = 1; } // 设回 null 就是重新用天空（强度由场景统一给）
  };

  window.addEventListener('resize', () => renderer.resize());

  // ------------------------------------------------------------------ 状态切换
  let state: State = 'menu';
  let stateAt = 0;
  const setState = (s: State) => {
    state = s; stateAt = performance.now();
    input.enabled = s === 'playing';
    weapon.view.visible = s === 'playing' || s === 'paused';
    audio.setAmbience(s === 'playing');
    if (s !== 'playing') { input.fire = false; input.ads = false; }
  };
  const startMission = (isRetry: boolean) => {
    audio.resume();
    enemies.clear();
    decals.clear();
    player.reset(port.playerStart);
    weapon.reset();
    mission.reset(isRetry);
    ui.resetHud();
    ui.show(null);
    ui.locCard();
    setState('playing');
    input.requestLock();
    if (!input.touchMode && !input.padActive) setTimeout(() => { if (state === 'playing' && !input.locked) ui.hint(input.lockFailed ? '鼠标捕获不可用：按住鼠标拖动调整视角，方向键也可转向' : '点击游戏画面以捕获鼠标', 5); }, 900);
  };
  const pause = () => { if (state !== 'playing') return; setState('paused'); ui.show('pause'); input.releaseLock(); };
  const resume = () => { if (state !== 'paused') return; ui.closePanel(); ui.show(null); setState('playing'); input.requestLock(); };

  let quality = settings.quality;
  ui.onStart = () => startMission(false);
  ui.onRestart = () => startMission(state === 'dead' || state === 'paused');
  ui.onResume = resume;
  ui.onClick = () => { audio.resume(); audio.click(); };
  ui.onSettings = (s) => {
    saveSettings(s);
    audio.setVolume(s.volume);
    if (s.quality !== quality) { quality = s.quality; applyQuality(); }
  };
  // 鼠标捕获被 Esc 解除时，浏览器不会把 Esc 按键交给页面，所以靠"捕获丢失"来触发暂停
  input.onLockChange = (locked) => { if (!locked && state === 'playing' && !input.lockFailed) pause(); };
  window.addEventListener('gamepadconnected', () => ui.hint('手柄已连接 · 按 A 开始 / 继续', 4));
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ------------------------------------------------------------------ 主循环
  const clock = new THREE.Clock();
  let t = 0, hurt = 0;
  // 闪电：隔半分钟到一分钟，云层里亮一下。它不是一盏灯——只是云自己发亮，再让空气整体亮一瞬
  const bolt = { wait: 22 + Math.random() * 25, t: 9, power: 0, value: 0 };
  const fwd = new THREE.Vector3(), tmp = new THREE.Vector3(), bufSize = new THREE.Vector2();
  const markers: Marker[] = Array.from({ length: 4 }, () => ({ label: '', x: 0, y: 0, dist: 0, on: false, edge: false }));
  const frame: HudFrame = { heading: 0, hp: 100, ammo: 30, reserve: 120, reloadP: 0, spread: 0, ads: 0, hitMarker: 0, hitWeak: false, objective: '', cut: 0, prompt: null, damageAngle: 0, damageFlash: 0, markers, sprinting: false };

  const placeMarker = (m: Marker, wx: number, wy: number, wz: number, label: string, on: boolean) => {
    m.on = on; if (!on) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    tmp.set(wx, wy, wz);
    m.dist = tmp.distanceTo(camera.position);
    tmp.project(camera);
    const behind = tmp.z > 1;
    let x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
    if (behind) { x = W - x; y = H - 70; }
    const cx = clamp(x, 44, W - 44), cy = clamp(y, 84, H - 120);
    m.edge = behind || cx !== x || cy !== y;
    m.x = cx; m.y = cy; m.label = label;
  };

  /** 推进一帧游戏逻辑（不含渲染）。拆出来是为了能脱离画面做快进测试。 */
  const update = (dt: number) => {
    t += dt;
    input.pollGamepad();
    const padA = input.pressed('PadA');

    if (state === 'playing') {
      if (input.pressed('Escape') || input.pressed('KeyP')) pause();
      player.update(dt, mission.time, input, settings, port.colliders, weapon.ads);
      // 脚下是不是水洼。积水图只管平面位置，所以要先确认人真的踩在露天的路面上：
      // 站在箱顶、台阶上（脚底高于地面）不算；车间里的地坪和室外一样高，但屋里没有积水，也不算
      const inPuddle = player.onGround && player.pos.y < 0.05 && !indoors && isPuddleAt(player.pos.x, player.pos.z);
      if (player.stepped) {
        audio.step(player.sprinting, inPuddle);
        if (inPuddle) effects.splash(player.pos, player.sprinting ? 0.55 : 0.4); // 踩进水里才溅水花：跑比走溅得高
      }
      if (player.landed) {
        audio.land(inPuddle);
        if (inPuddle) effects.splash(player.pos, 0.9); else effects.landDust(player.pos); // 跳进水洼是一大片水花，落在别处只扬起一圈尘
      }
      if (player.inWater) {
        // 掉进海里：捞回岸上，扣一点血
        effects.splash(tmp.set(player.pos.x, -1.7, player.pos.z), 2.2);
        player.pos.set(QUAY_X - 4, 0, clamp(player.pos.z, -94, 94)); player.vel.set(0, 0, 0);
        player.takeDamage(20, null, mission.time); audio.hurt();
        ui.hint('已从水中获救', 3);
      }
      player.applyCamera(camera, t);
      camera.updateMatrixWorld();
      weapon.update(dt, t, input, player, port.colliders, enemies, { colliders: port.colliders, nav: port.nav, effects, decals, audio, camera }, mission.stats, input.ads);
      enemies.update(dt, t, player);
      mission.update(dt, input);
      const fov = lerp(settings.fov, settings.fov * 0.7, weapon.ads) + (player.sprinting ? 5 : 0);
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = damp(camera.fov, fov, 12, dt); camera.updateProjectionMatrix(); }

      if (!player.alive) { setState('dead'); input.releaseLock(); audio.fail(); ui.show('dead', mission.result()); }
      else if (mission.won) {
        setState('won'); input.releaseLock(); audio.win();
        ui.radio('激战队员已登船，港区封锁解除。干得漂亮！', 8);
        ui.show('win', mission.result());
      }
    } else if (state === 'menu') {
      // 主菜单背后的镜头：站在入口处缓慢扫视港区
      camera.position.set(-18 + Math.sin(t * 0.07) * 2.5, 2.3 + Math.sin(t * 0.11) * 0.25, 95);
      camera.rotation.set(0.07 + Math.sin(t * 0.09) * 0.02, Math.sin(t * 0.05) * 0.22, 0);
      if (ui.panelOpen && (input.pressed('Escape') || input.pressed('PadB'))) ui.closePanel();
      else if (padA && !ui.panelOpen) startMission(false);
    } else if (state === 'paused') {
      if ((input.pressed('Escape') || padA) && !ui.panelOpen) resume();
      else if (input.pressed('Escape') || input.pressed('PadB')) ui.closePanel();
    } else if (padA && performance.now() - stateAt > 900) { // 留一点间隔，免得阵亡瞬间按着 A 就直接重开
      startMission(state === 'dead'); // 结算画面按 A 再来一局
    }

    effects.update(dt, camera.position);
    port.update(t, state === 'menu' ? camera.position : player.pos);
    sea.update(t);
    sky.uniforms.uTime.value = t;
    bolt.wait -= dt; bolt.t += dt;
    if (bolt.wait <= 0) {
      bolt.wait = 30 + Math.random() * 30; bolt.t = 0; bolt.power = 0.3 + 0.7 * Math.random();
      const a = Math.PI * (0.55 + Math.random() * 0.9);
      sky.uniforms.uFlashDir.value.set(Math.cos(a), 0.35 + Math.random() * 0.3, Math.sin(a) * (Math.random() < 0.5 ? -1 : 1)).normalize();
    }
    // 亮度：很快衰减，中间抖几下（两个不同频率的正弦相乘，看起来像不规则的闪烁）
    bolt.value = bolt.t < 0.9 ? Math.max(0, bolt.power * Math.exp(-5 * bolt.t) * (0.55 + 0.45 * Math.sin(47 * bolt.t) * Math.sin(13 * bolt.t + 1)) * 0.35) : 0;
    sky.uniforms.uFlash.value = bolt.value;
    rain.update(t, camera, renderer.gl.getDrawingBufferSize(bufSize).y);
    if (port.interior.containsPoint(camera.position) !== indoors) setIndoors(!indoors);

    if (state === 'playing' || state === 'paused') {
      camera.getWorldDirection(fwd);
      frame.heading = (Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI;
      frame.hp = player.hp; frame.ammo = weapon.ammo; frame.reserve = weapon.reserve; frame.reloadP = weapon.reloadProgress;
      frame.spread = weapon.spread; frame.ads = weapon.ads; frame.hitMarker = weapon.hitMarker; frame.hitWeak = weapon.hitWeak;
      frame.objective = mission.objective; frame.cut = mission.cut; frame.prompt = mission.prompt; frame.sprinting = player.sprinting;
      frame.damageFlash = player.damageFlash;
      const bearing = Math.atan2(player.damageFrom.x - player.pos.x, -(player.damageFrom.z - player.pos.z));
      frame.damageAngle = bearing - (frame.heading * Math.PI) / 180;
      port.relays.forEach((r, i) => placeMarker(markers[i], r.pos.x, 3.2, r.pos.z, `中继 ${r.short}`, !r.cut));
      placeMarker(markers[3], port.evacPos.x, 2.4, port.evacPos.z, '撤离艇', mission.cut >= 3);
      ui.update(dt, frame);
    }
    hurt = damp(hurt, state === 'dead' ? 1 : clamp((40 - player.hp) / 40, 0, 1) * 0.7, 4, dt);
    input.endFrame();
  };
  const tick = () => {
    requestAnimationFrame(tick);
    update(Math.min(0.05, clock.getDelta()));
    renderer.render(hurt, t, { ads: state === 'playing' ? weapon.ads : 0, damage: state === 'playing' ? player.damageFlash * 0.6 : 0, flash: bolt.value });
  };

  await step('正在准备首帧画面', 0.96);
  ui.show('main');
  setState('menu');
  tick();
  await step('准备就绪', 1);
  bootEl.classList.add('done');

  // 调试入口：在浏览器控制台里可以用 __game 直接操纵游戏状态
  (window as unknown as { __game: unknown }).__game = { scene, camera, player, weapon, enemies, mission, port, input, ui, decals, effects, renderer, start: () => startMission(false), get state() { return state; },
    /** 不渲染，直接快进若干秒 */
    sim: (sec: number) => { for (let i = 0; i < sec * 60; i++) update(1 / 60); } };
}

boot().catch((err) => {
  console.error(err);
  bootEl.classList.add('fatal');
  bootMsg.textContent = `《激战》启动失败：${err instanceof Error ? err.message : String(err)}`;
});
