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
import { Effects } from './render/effects';
import { Renderer } from './render/renderer';
import { UI, type HudFrame, type Marker } from './ui/ui';
import { bakeEnvironment, createRain, createSea, createSky, FOG_COLOR } from './world/atmosphere';
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
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0058);
  scene.background = FOG_COLOR;

  await step('正在生成涂装、锈迹与雨水', 0.2);
  const sky = createSky();
  scene.add(sky.mesh);
  scene.environment = bakeEnvironment(renderer.gl);
  scene.environmentIntensity = 0.9;

  await step('正在布置集装箱', 0.38);
  const port = buildPort(() => {});
  scene.add(port.group);
  await step('正在架设起重机', 0.56);
  const sea = createSea(QUAY_X);
  scene.add(sea.mesh);
  let rain = createRain(profileOf(settings.quality).rain);
  scene.add(rain.lines);

  await step('正在加载弹道与烟雾', 0.68);
  const effects = new Effects();
  scene.add(effects.group);
  const audio = new GameAudio();
  audio.setVolume(settings.volume);

  await step('正在检查几猫制式步枪', 0.78);
  const input = new Input(canvas);
  const player = new Player();
  const weapon = new Weapon();
  camera.add(weapon.view);
  weapon.view.visible = false;

  await step('正在启动港区主控', 0.88);
  const enemies = new Enemies({ colliders: port.colliders, nav: port.nav, effects, audio, camera });
  scene.add(enemies.group);
  const ui = new UI(document.getElementById('ui')!, settings, input, auto);
  const mission = new Mission(port, enemies, ui, audio, weapon, player);
  enemies.onPlayerHit = (dmg, from) => { player.takeDamage(dmg, from, mission.time); audio.hurt(); };

  const applyQuality = () => {
    const p = profileOf(settings.quality);
    renderer.setQuality(p, port.sun);
    port.setLampCount(p.lamps);
    scene.remove(rain.lines); rain.lines.geometry.dispose();
    rain = createRain(p.rain); scene.add(rain.lines);
    effects.setScale(canvas.clientHeight * p.pixelRatio, camera.fov);
  };
  applyQuality();
  window.addEventListener('resize', () => { renderer.resize(); effects.setScale(canvas.clientHeight * profileOf(settings.quality).pixelRatio, camera.fov); });

  // ------------------------------------------------------------------ 状态切换
  let state: State = 'menu';
  const setState = (s: State) => {
    state = s;
    input.enabled = s === 'playing';
    weapon.view.visible = s === 'playing' || s === 'paused';
    audio.setAmbience(s === 'playing');
    if (s !== 'playing') { input.fire = false; input.ads = false; }
  };
  const startMission = (isRetry: boolean) => {
    audio.resume();
    enemies.clear();
    player.reset(port.playerStart);
    weapon.reset();
    mission.reset(isRetry);
    ui.resetHud();
    ui.show(null);
    ui.locCard();
    setState('playing');
    input.requestLock();
    if (!input.touchMode) setTimeout(() => { if (state === 'playing' && !input.locked) ui.hint(input.lockFailed ? '鼠标捕获不可用：按住鼠标拖动调整视角，方向键也可转向' : '点击游戏画面以捕获鼠标', 5); }, 900);
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
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ------------------------------------------------------------------ 主循环
  const clock = new THREE.Clock();
  let t = 0, hurt = 0;
  const fwd = new THREE.Vector3(), tmp = new THREE.Vector3();
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

    if (state === 'playing') {
      if (input.pressed('Escape') || input.pressed('KeyP')) pause();
      player.update(dt, mission.time, input, settings, port.colliders, weapon.ads);
      if (player.stepped) audio.step(player.sprinting);
      if (player.landed) audio.land();
      if (player.inWater) {
        // 掉进海里：捞回岸上，扣一点血
        player.pos.set(QUAY_X - 4, 0, clamp(player.pos.z, -94, 94)); player.vel.set(0, 0, 0);
        player.takeDamage(20, null, mission.time); audio.hurt();
        ui.hint('已从水中获救', 3);
      }
      player.applyCamera(camera, t);
      camera.updateMatrixWorld();
      weapon.update(dt, t, input, player, port.colliders, enemies, { colliders: port.colliders, nav: port.nav, effects, audio, camera }, mission.stats, input.ads);
      enemies.update(dt, t, player);
      mission.update(dt, input);
      const fov = lerp(settings.fov, settings.fov * 0.7, weapon.ads) + (player.sprinting ? 5 : 0);
      if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = damp(camera.fov, fov, 12, dt); camera.updateProjectionMatrix(); }

      if (!player.alive) { setState('dead'); input.releaseLock(); audio.fail(); ui.show('dead', mission.result()); }
      else if (mission.won) {
        setState('won'); input.releaseLock(); audio.win();
        ui.radio('几猫队员已登船，港区封锁解除。干得漂亮！', 8);
        ui.show('win', mission.result());
      }
    } else if (state === 'menu') {
      // 主菜单背后的镜头：站在入口处缓慢扫视港区
      camera.position.set(-18 + Math.sin(t * 0.07) * 2.5, 2.3 + Math.sin(t * 0.11) * 0.25, 95);
      camera.rotation.set(0.07 + Math.sin(t * 0.09) * 0.02, Math.sin(t * 0.05) * 0.22, 0);
      if (ui.panelOpen && input.pressed('Escape')) ui.closePanel();
    } else if (state === 'paused') {
      if (input.pressed('Escape') && !ui.panelOpen) resume();
      else if (input.pressed('Escape')) ui.closePanel();
    }

    effects.update(dt);
    port.update(t, state === 'menu' ? camera.position : player.pos);
    sea.update(t);
    sky.uniforms.uTime.value = t;
    rain.uniforms.uTime.value = t;
    rain.uniforms.uCam.value.copy(camera.position);

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
    renderer.render(hurt);
  };

  await step('正在准备首帧画面', 0.96);
  ui.show('main');
  setState('menu');
  tick();
  await step('准备就绪', 1);
  bootEl.classList.add('done');

  // 调试入口：在浏览器控制台里可以用 __game 直接操纵游戏状态
  (window as unknown as { __game: unknown }).__game = { scene, camera, player, weapon, enemies, mission, port, input, ui, start: () => startMission(false), get state() { return state; },
    /** 不渲染，直接快进若干秒 */
    sim: (sec: number) => { for (let i = 0; i < sec * 60; i++) update(1 / 60); } };
}

boot().catch((err) => {
  console.error(err);
  bootEl.classList.add('fatal');
  bootMsg.textContent = `几猫启动失败：${err instanceof Error ? err.message : String(err)}`;
});
