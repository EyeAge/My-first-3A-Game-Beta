import type { Input } from '../core/input';
import { QUALITY_LABEL, type Quality, type Settings } from '../core/settings';

// HUD 和菜单都是普通的 DOM 元素，盖在 WebGL 画布上面。
// 文字、按钮这类东西用 HTML/CSS 做，比在 3D 里画省事得多，也更清晰。

export interface Marker { label: string; x: number; y: number; dist: number; on: boolean; edge: boolean }
export interface HudFrame {
  heading: number; hp: number; ammo: number; reserve: number; reloadP: number; spread: number; ads: number;
  hitMarker: number; hitWeak: boolean; objective: string; cut: number;
  prompt: { text: string; progress: number } | null;
  damageAngle: number; damageFlash: number; markers: Marker[]; sprinting: boolean;
}
export interface ResultData { time: number; accuracy: number; kills: number; retries: number; cut: number; rating: string }
export type Screen = 'main' | 'pause' | 'dead' | 'win' | null;

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
export const dirName = (deg: number) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8] + '方';

export class UI {
  onStart = () => {}; onResume = () => {}; onRestart = () => {}; onSettings = (_s: Settings) => {}; onClick = () => {};
  private root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private markerEls: HTMLElement[] = [];
  private radioT = 0; private hintT = 0; private locT = 0;
  private screen: Screen = null;
  private last: Record<string, string | number> = {};

  constructor(root: HTMLElement, private settings: Settings, private input: Input, autoQuality: boolean) {
    this.root = root;
    let strip = '';
    for (let rep = 0; rep < 3; rep++) for (let d = 0; d < 360; d += 15) strip += `<span class="${d % 45 === 0 ? 'major' : ''}">${d % 45 === 0 ? DIRS[d / 45] : String(d).padStart(3, '0')}</span>`;
    root.innerHTML = /* html */ `
    <div class="hud" data-f="hud">
      <div class="hurt" data-f="hurt"></div>
      <div class="compass"><div class="strip" data-f="strip">${strip}</div><i class="tick"></i><b data-f="bearing">000</b></div>
      <div class="objective"><div class="k">任务目标</div><div class="t" data-f="obj"></div>
        <div class="relays"><i></i><i></i><i></i><span data-f="relayN">中继 0/3</span></div></div>
      <div class="status"><div class="k">生命状态</div><div class="hp"><b data-f="hp">100</b><div class="bar"><i data-f="hpbar"></i></div></div></div>
      <div class="ammo"><div class="n"><b data-f="ammo">30</b><span data-f="reserve">120</span></div><div class="w">几猫九式突击步枪</div><div class="msg" data-f="ammomsg"></div></div>
      <div class="cross" data-f="cross"><i></i><i></i><i></i><i></i><u></u></div>
      <div class="hitmark" data-f="hitmark"><i></i><i></i><i></i><i></i></div>
      <div class="dmgdir" data-f="dmgdir"><i></i></div>
      <div class="prompt" data-f="prompt"><kbd>E</kbd><span data-f="prompttxt"></span><div class="bar"><i data-f="promptbar"></i></div></div>
      <div class="radio" data-f="radio"><div class="who">指挥中心</div><div class="txt" data-f="radiotxt"></div></div>
      <div class="feed" data-f="feed"></div>
      <div class="hint" data-f="hint"></div>
      <div class="loc" data-f="loc"><div class="a">B4</div><div><b>几猫突击小队</b><span>几猫港区 · 四号泊位 · 05:42</span></div></div>
      <div class="markers" data-f="markers"></div>
    </div>
    <div class="touch" data-f="touch">
      <div class="stick" data-f="stick"><i data-f="knob"></i></div>
      <button data-t="fire" class="tb fire">开火</button><button data-t="ads" class="tb ads">瞄准</button>
      <button data-t="reload" class="tb reload">换弹</button><button data-t="jump" class="tb jump">跳跃</button>
      <button data-t="use" class="tb use">交互</button><button data-t="pause" class="tb pause">暂停</button>
    </div>
    <div class="menu" data-f="menu">
      <section data-s="main">
        <div class="eyebrow">几猫突击小队 · 几猫港区 · 05:42</div>
        <h1>几猫<small>3A大作</small></h1>
        <p class="lead">港区防御系统失控。切断三处中继，突破封锁，登船撤离。</p>
        <nav><button class="primary" data-a="start">开始行动</button><button data-a="settings">设置</button><button data-a="controls">操作说明</button><button data-a="about">项目介绍</button></nav>
        <p class="foot">复刻练手版 · 国产第一人称射击游戏 · 开发体验版</p>
      </section>
      <section data-s="pause">
        <div class="eyebrow">行动暂时中止</div><h2>已暂停</h2>
        <nav><button class="primary" data-a="resume">继续游戏</button><button data-a="settings">设置</button><button data-a="controls">操作说明</button><button data-a="restart">重新开始任务</button></nav>
        <p class="foot" data-f="pausefoot">继续游戏后将重新捕获鼠标。</p>
      </section>
      <section data-s="dead">
        <div class="eyebrow alarm">信号中断</div><h2>突击队员倒下</h2>
        <dl><div><dt>生存时间</dt><dd data-f="d-time"></dd></div><div><dt>已切断中继</dt><dd data-f="d-cut"></dd></div><div><dt>摧毁机械</dt><dd data-f="d-kills"></dd></div></dl>
        <nav><button class="primary" data-a="restart">重试</button></nav>
      </section>
      <section data-s="win">
        <div class="eyebrow">四号泊位 · 行动简报</div><h2>几猫港区已解除封锁</h2>
        <div class="rating"><span>行动评级</span><b data-f="w-rating"></b></div>
        <dl><div><dt>用时</dt><dd data-f="w-time"></dd></div><div><dt>命中率</dt><dd data-f="w-acc"></dd></div><div><dt>摧毁机械</dt><dd data-f="w-kills"></dd></div><div><dt>重试次数</dt><dd data-f="w-retries"></dd></div></dl>
        <nav><button class="primary" data-a="restart">再次出击</button></nav>
      </section>
    </div>
    <div class="panel" data-f="panel"><div class="box">
      <header><h3 data-f="paneltitle"></h3><button data-a="close">关闭</button></header>
      <div data-p="settings">
        <label><span>画面质量</span><select data-o="quality">${(Object.keys(QUALITY_LABEL) as Quality[]).map((q) => `<option value="${q}">${QUALITY_LABEL[q]}</option>`).join('')}</select></label>
        <label><span>鼠标灵敏度</span><input type="range" data-o="sensitivity" min="0.3" max="2.5" step="0.05"><output></output></label>
        <label><span>视野范围</span><input type="range" data-o="fov" min="60" max="100" step="1"><output></output></label>
        <label><span>主音量</span><input type="range" data-o="volume" min="0" max="1" step="0.02"><output></output></label>
        <label><span>反转垂直视角</span><input type="checkbox" data-o="invertY"></label>
        <label><span>显示模式</span><button data-a="fullscreen" data-f="fsbtn">进入全屏</button></label>
        <p class="note" data-f="qnote"></p>
      </div>
      <div data-p="controls">
        <h4>键盘 · 鼠标</h4>
        <ul class="keys"><li><kbd>WASD</kbd>移动</li><li><kbd>鼠标</kbd>视角</li><li><kbd>左键</kbd>开火</li><li><kbd>右键</kbd>瞄准</li><li><kbd>R</kbd>换弹</li><li><kbd>E</kbd>按住切断中继</li><li><kbd>空格</kbd>跳跃</li><li><kbd>Shift</kbd>冲刺</li><li><kbd>C</kbd>蹲伏</li><li><kbd>V</kbd>近战</li><li><kbd>Esc</kbd>暂停</li></ul>
        <p class="note">若浏览器无法捕获鼠标，按住鼠标按钮并拖动以调整视角（左键同时开火，右键同时瞄准）。方向键也可以转向。</p>
        <h4>触屏操作</h4>
        <p class="note">左手拇指在左侧任意位置滑动来移动，右手在屏幕右侧拖动转动视角。屏幕按钮：开火 · 瞄准 · 换弹 · 跳跃 · 交互。</p>
      </div>
      <div data-p="about">
        <p>《几猫》是一款运行在浏览器里的第一人称射击游戏。这一版是对照原版 demo 的效果，用 Vite + TypeScript + three.js 从零重写的复刻练手版。</p>
        <p>和原版一样：没有任何图片、模型或音频文件。集装箱的涂装和锈迹、湿地面的反光、天空、雨、枪声，全部是代码在你打开页面时现场生成的。</p>
        <p>目前仍在持续开发中，欢迎体验并提出建议。</p>
      </div>
    </div></div>`;
    root.querySelectorAll<HTMLElement>('[data-f]').forEach((e) => (this.el[e.dataset.f!] = e));

    root.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]');
      if (!b) return;
      this.onClick();
      switch (b.dataset.a) {
        case 'start': this.onStart(); break;
        case 'resume': this.onResume(); break;
        case 'restart': this.onRestart(); break;
        case 'settings': this.openPanel('settings', '设置'); break;
        case 'controls': this.openPanel('controls', '操作说明'); break;
        case 'about': this.openPanel('about', '项目介绍'); break;
        case 'close': this.el.panel.classList.remove('on'); break;
        case 'fullscreen': this.toggleFullscreen(); break;
      }
    });
    // 设置项：改了就立刻生效并保存
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-o]').forEach((inp) => {
      const key = inp.dataset.o as keyof Settings;
      const show = () => { const o = inp.parentElement!.querySelector('output'); if (o) o.textContent = key === 'volume' ? `${Math.round(+inp.value * 100)}%` : key === 'fov' ? `${inp.value}°` : (+inp.value).toFixed(2); };
      if (inp instanceof HTMLInputElement && inp.type === 'checkbox') inp.checked = settings[key] as boolean; else inp.value = String(settings[key]);
      show();
      inp.addEventListener('input', () => {
        const s = this.settings as unknown as Record<string, unknown>;
        s[key] = inp instanceof HTMLInputElement && inp.type === 'checkbox' ? inp.checked : key === 'quality' ? inp.value : +inp.value;
        show(); this.onSettings(this.settings);
        if (key === 'quality') this.el.qnote.textContent = '画质设置立即生效；阴影需要片刻重新生成。';
      });
    });
    this.el.qnote.textContent = autoQuality ? `已根据设备自动选择画质（${QUALITY_LABEL[settings.quality]}），运行不流畅时可降低画质。` : '画质设置立即生效；阴影需要片刻重新生成。';
    document.addEventListener('fullscreenchange', () => (this.el.fsbtn.textContent = document.fullscreenElement ? '退出全屏' : '进入全屏'));

    for (let i = 0; i < 4; i++) {
      const m = document.createElement('div');
      m.className = 'marker'; m.innerHTML = '<i></i><b></b><span></span>';
      this.el.markers.appendChild(m); this.markerEls.push(m);
    }
    this.setupTouch();
  }

  private toggleFullscreen() {
    const app = document.getElementById('app')!;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (app.requestFullscreen) app.requestFullscreen().catch(() => (this.el.fsbtn.textContent = '当前环境不支持全屏'));
    else this.el.fsbtn.textContent = '当前环境不支持全屏';
  }

  private openPanel(name: string, title: string) {
    this.el.paneltitle.textContent = title;
    this.root.querySelectorAll<HTMLElement>('[data-p]').forEach((p) => (p.style.display = p.dataset.p === name ? '' : 'none'));
    this.el.panel.classList.add('on');
  }
  get panelOpen() { return this.el.panel.classList.contains('on'); }
  closePanel() { this.el.panel.classList.remove('on'); }

  show(screen: Screen, data?: ResultData) {
    this.screen = screen;
    this.el.menu.classList.toggle('on', !!screen);
    this.el.menu.dataset.screen = screen ?? '';
    this.root.querySelectorAll<HTMLElement>('[data-s]').forEach((s) => s.classList.toggle('on', s.dataset.s === screen));
    this.el.hud.classList.toggle('on', screen === null || screen === 'pause');
    this.el.touch.classList.toggle('on', screen === null && this.input.touchMode);
    if (screen !== null && screen !== 'pause' && screen !== 'main') this.closePanel();
    if (data && screen === 'dead') { this.el['d-time'].textContent = fmtTime(data.time); this.el['d-cut'].textContent = `${data.cut} / 3`; this.el['d-kills'].textContent = String(data.kills); }
    if (data && screen === 'win') {
      this.el['w-rating'].textContent = data.rating; this.el['w-time'].textContent = fmtTime(data.time);
      this.el['w-acc'].textContent = `${Math.round(data.accuracy * 100)}%`; this.el['w-kills'].textContent = String(data.kills); this.el['w-retries'].textContent = String(data.retries);
    }
    this.el.pausefoot.textContent = this.input.touchMode ? '' : '继续游戏后将重新捕获鼠标。';
  }

  radio(text: string, dur = 6.5) { this.el.radiotxt.textContent = text; this.el.radio.classList.add('on'); this.radioT = dur; }
  hint(text: string, dur = 3) { this.el.hint.textContent = text; this.el.hint.classList.add('on'); this.hintT = dur; }
  locCard() { this.el.loc.classList.add('on'); this.locT = 5; }
  feed(text: string, strong = false) {
    const d = document.createElement('div');
    d.textContent = text; if (strong) d.className = 'strong';
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 5) this.el.feed.lastElementChild!.remove();
    setTimeout(() => d.classList.add('out'), 2600);
    setTimeout(() => d.remove(), 3200);
  }
  resetHud() { this.el.feed.innerHTML = ''; this.el.radio.classList.remove('on'); this.el.hint.classList.remove('on'); this.radioT = this.hintT = 0; }

  /** 只在值真的变了的时候才写 DOM，避免每帧触发浏览器重排。 */
  private set(key: string, value: string | number) {
    if (this.last[key] === value) return false;
    this.last[key] = value; return true;
  }

  update(dt: number, f: HudFrame) {
    if (this.radioT > 0 && (this.radioT -= dt) <= 0) this.el.radio.classList.remove('on');
    if (this.hintT > 0 && (this.hintT -= dt) <= 0) this.el.hint.classList.remove('on');
    if (this.locT > 0 && (this.locT -= dt) <= 0) this.el.loc.classList.remove('on');

    const deg = ((f.heading % 360) + 360) % 360;
    this.el.strip.style.transform = `translateX(${(-(deg + 360) * 4 - 30).toFixed(1)}px)`;
    const b = String(Math.round(deg) % 360).padStart(3, '0');
    if (this.set('bearing', b)) this.el.bearing.textContent = b;

    const hp = Math.ceil(f.hp);
    if (this.set('hp', hp)) { this.el.hp.textContent = String(hp); this.el.hpbar.style.width = `${hp}%`; this.el.hud.classList.toggle('low', hp <= 30); }
    if (this.set('ammo', f.ammo)) { this.el.ammo.textContent = String(f.ammo); this.el.ammo.classList.toggle('low', f.ammo <= 8); }
    if (this.set('reserve', f.reserve)) this.el.reserve.textContent = String(f.reserve);
    const msg = f.reloadP > 0 ? '换弹中' : f.ammo === 0 && f.reserve === 0 ? '弹药耗尽' : f.ammo === 0 ? 'R · 换弹' : f.ammo <= 8 ? '弹药不足' : '';
    if (this.set('ammomsg', msg)) this.el.ammomsg.textContent = msg;
    if (this.set('obj', f.objective)) this.el.obj.textContent = f.objective;
    if (this.set('cut', f.cut)) {
      this.el.relayN.textContent = `中继 ${f.cut}/3`;
      this.root.querySelectorAll('.relays i').forEach((e, i) => e.classList.toggle('done', i < f.cut));
    }

    // 准星：四条短线，散布越大张得越开；开镜时淡出（改用红点瞄具）
    const gap = 5 + f.spread * 520;
    this.el.cross.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    this.el.cross.style.opacity = String(Math.max(0, 1 - f.ads * 1.6) * (f.sprinting ? 0.35 : 1));
    this.el.hitmark.style.opacity = String(f.hitMarker);
    if (this.set('weak', f.hitWeak ? 1 : 0)) this.el.hitmark.classList.toggle('weak', f.hitWeak);
    this.el.hurt.style.opacity = String(Math.min(1, f.damageFlash * 0.9 + Math.max(0, (35 - f.hp) / 35) * 0.7));
    this.el.dmgdir.style.opacity = String(f.damageFlash);
    if (f.damageFlash > 0) this.el.dmgdir.style.transform = `translate(-50%,-50%) rotate(${f.damageAngle.toFixed(2)}rad)`;

    const p = f.prompt;
    if (this.set('prompt', p ? p.text : '')) { this.el.prompt.classList.toggle('on', !!p); if (p) this.el.prompttxt.textContent = p.text; }
    if (p) this.el.promptbar.style.width = `${(p.progress * 100).toFixed(0)}%`;

    for (let i = 0; i < this.markerEls.length; i++) {
      const m = this.markerEls[i], d = f.markers[i];
      if (!d || !d.on) { if (this.set('mk' + i, 0)) m.style.display = 'none'; continue; }
      if (this.set('mk' + i, 1)) m.style.display = '';
      m.style.transform = `translate(${d.x.toFixed(0)}px, ${d.y.toFixed(0)}px)`;
      if (this.set('mkl' + i, d.label)) (m.children[1] as HTMLElement).textContent = d.label;
      const dist = `${Math.round(d.dist)} 米`;
      if (this.set('mkd' + i, dist)) (m.children[2] as HTMLElement).textContent = dist;
      if (this.set('mke' + i, d.edge ? 1 : 0)) m.classList.toggle('edge', d.edge);
    }
  }

  // ------------------------------------------------------------------ 触屏
  private setupTouch() {
    const { input } = this;
    const canvas = document.getElementById('view')!;
    let stickId = -1, lookId = -1, sx = 0, sy = 0, lx = 0, ly = 0;
    const enable = () => {
      if (input.touchMode) return;
      input.touchMode = true;
      this.hint('触屏操作已启用', 3);
      this.el.touch.classList.toggle('on', this.screen === null);
    };
    window.addEventListener('touchstart', enable, { passive: true, once: true });
    canvas.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth * 0.42 && stickId < 0) {
          stickId = t.identifier; sx = t.clientX; sy = t.clientY;
          this.el.stick.style.left = `${sx}px`; this.el.stick.style.top = `${sy}px`; this.el.stick.classList.add('on');
        } else if (lookId < 0) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickId) {
          let dx = (t.clientX - sx) / 56, dy = (t.clientY - sy) / 56;
          const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
          input.stickX = dx; input.stickY = -dy;
          input.setKey('ShiftLeft', -dy > 0.92); // 摇杆推到头就是冲刺
          this.el.knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
        } else if (t.identifier === lookId) {
          if (input.enabled) { input.lookDX += (t.clientX - lx) * 2.2; input.lookDY += (t.clientY - ly) * 2.2; }
          lx = t.clientX; ly = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickId) { stickId = -1; input.stickX = input.stickY = 0; input.setKey('ShiftLeft', false); this.el.stick.classList.remove('on'); this.el.knob.style.transform = ''; }
        if (t.identifier === lookId) lookId = -1;
      }
    };
    canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);

    this.root.querySelectorAll<HTMLElement>('[data-t]').forEach((b) => {
      const kind = b.dataset.t!;
      let id = -1, px = 0, py = 0;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault(); e.stopPropagation();
        const t = e.changedTouches[0]; id = t.identifier; px = t.clientX; py = t.clientY;
        if (kind === 'fire') input.fire = true;
        else if (kind === 'ads') { input.ads = !input.ads; b.classList.toggle('held', input.ads); }
        else if (kind === 'reload') input.virtualPress('KeyR');
        else if (kind === 'jump') input.virtualPress('Space');
        else if (kind === 'use') input.setKey('KeyE', true);
        else if (kind === 'pause') input.virtualPress('Escape');
      }, { passive: false });
      b.addEventListener('touchmove', (e) => {
        // 按住"开火"的同时拖动，可以边打边跟踪目标
        if (kind !== 'fire') return;
        for (const t of Array.from(e.changedTouches)) if (t.identifier === id) { input.lookDX += (t.clientX - px) * 2.2; input.lookDY += (t.clientY - py) * 2.2; px = t.clientX; py = t.clientY; }
        e.preventDefault();
      }, { passive: false });
      const up = (e: TouchEvent) => { e.preventDefault(); if (kind === 'fire') input.fire = false; if (kind === 'use') input.setKey('KeyE', false); };
      b.addEventListener('touchend', up); b.addEventListener('touchcancel', up);
    });
  }
}
