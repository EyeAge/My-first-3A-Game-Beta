import { clamp } from './math';

/** 统一收集键盘、鼠标、触屏输入。游戏逻辑只读这里的状态，不直接碰 DOM 事件。 */
export class Input {
  private keys = new Set<string>();
  private pressedNow = new Set<string>();
  lookDX = 0; lookDY = 0;
  fire = false; ads = false;
  locked = false;
  lockFailed = false;
  private lastUnlock = -1e9;
  touchMode = false;
  // 触屏虚拟摇杆
  stickX = 0; stickY = 0;
  touchInteract = false;
  // 手柄：左摇杆移动、右摇杆视角（已做死区和曲线处理）
  padX = 0; padY = 0; padLookX = 0; padLookY = 0;
  /** 最近一次操作来自手柄。此时不需要捕获鼠标。 */
  padActive = false;
  private padPrev: boolean[] = [];
  private padSprint = false; private padCrouch = false;
  onLockChange: (locked: boolean) => void = () => {};
  /** 只有在"游戏进行中"才吃输入 */
  enabled = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code); this.pressedNow.add(e.code);
      if (this.enabled && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.ads = false; });

    canvas.addEventListener('mousedown', (e) => {
      this.padActive = false;
      if (!this.enabled || this.touchMode) return;
      if (!this.locked && !this.lockFailed) this.requestLock();
      if (e.button === 0) this.fire = true;
      if (e.button === 2) this.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      // 捕获不到鼠标时的退路：按住鼠标键拖动来转视角
      if (this.locked || (this.lockFailed && e.buttons)) { this.lookDX += e.movementX; this.lookDY += e.movementY; }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.lastUnlock = performance.now();
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.lockError());
  }

  requestLock() {
    if (this.touchMode || this.padActive) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => this.lockError());
    } catch { this.lockError(); }
  }
  /** 浏览器在按 Esc 退出后的一小段时间内会拒绝再次捕获，这种不算"环境不支持"，下次点击再试即可。 */
  private lockError() {
    if (performance.now() - this.lastUnlock > 2000) this.lockFailed = true;
  }
  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code: string) { return this.keys.has(code); }
  /** 这一帧刚按下（只触发一次） */
  pressed(code: string) { return this.pressedNow.has(code); }
  virtualPress(code: string) { this.pressedNow.add(code); }
  setKey(code: string, on: boolean) { if (on) this.keys.add(code); else this.keys.delete(code); }

  get moveX() {
    const k = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    return clamp(k + this.stickX + this.padX, -1, 1);
  }
  get moveY() {
    const k = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    return clamp(k + this.stickY + this.padY, -1, 1);
  }
  /** 方向键转视角（给捕获不了鼠标的环境用） */
  get keyLookX() { return (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0) + this.padLookX; }
  get keyLookY() { return (this.down('ArrowDown') ? 1 : 0) - (this.down('ArrowUp') ? 1 : 0) + this.padLookY; }

  /**
   * 读取手柄。浏览器不会为手柄派发按键事件，只能每帧主动查询一次状态，
   * 再和上一帧比较，自己判断"刚按下"和"刚松开"。
   * 按键按标准布局（Xbox 叫法）：A 跳跃、B 蹲伏、X 换弹、Y 切断中继、RB 近战、
   * LT 瞄准、RT 开火、L3 冲刺、Start 暂停。
   */
  pollGamepad() {
    let pad: Gamepad | null = null;
    try { for (const p of navigator.getGamepads()) if (p && p.connected && p.mapping === 'standard') { pad = p; break; } } catch { /* 有些内嵌环境不允许访问手柄 */ }
    if (!pad) { this.padX = this.padY = this.padLookX = this.padLookY = 0; return; }
    const btn = (i: number) => { const b = pad!.buttons[i]; return !!b && (b.pressed || b.value > 0.35); };
    const stick = (ix: number, iy: number, curve: number): [number, number] => {
      // 径向死区：摇杆回中时总会有一点漂移，小于阈值的一律当作 0
      const x = pad!.axes[ix] ?? 0, y = pad!.axes[iy] ?? 0, m = Math.hypot(x, y);
      if (m < 0.16) return [0, 0];
      const k = Math.pow(Math.min(1, (m - 0.16) / 0.84), curve) / m;
      return [x * k, y * k];
    };
    const [mx, my] = stick(0, 1, 1), [lx, ly] = stick(2, 3, 1.7); // 视角用更陡的曲线：轻推微调，推满快转
    this.padX = mx; this.padY = -my;
    this.padLookX = lx * 1.5 * (this.ads ? 0.55 : 1); this.padLookY = ly * 1.5 * (this.ads ? 0.55 : 1);

    const now = pad.buttons.map((_, i) => btn(i));
    const edge = (i: number) => (now[i] && !this.padPrev[i] ? 1 : !now[i] && this.padPrev[i] ? -1 : 0);
    if (now.some(Boolean) || mx || my || lx || ly) this.padActive = true;
    const tap = (i: number, ...codes: string[]) => { if (edge(i) === 1) for (const c of codes) this.pressedNow.add(c); };
    tap(0, 'Space', 'PadA'); tap(1, 'PadB'); tap(2, 'KeyR'); tap(5, 'KeyV'); tap(9, 'Escape');
    if (edge(3)) this.setKey('KeyE', now[3]);
    if (edge(7)) this.fire = now[7] && this.enabled;
    if (edge(6)) this.ads = now[6] && this.enabled;
    if (edge(1) === 1) { this.padCrouch = !this.padCrouch; this.setKey('KeyC', this.padCrouch); this.padSprint = false; }
    // L3 按一下开始冲刺，摇杆不再往前推时自动结束
    if (edge(10) === 1) { this.padSprint = !this.padSprint; if (this.padSprint && this.padCrouch) { this.padCrouch = false; this.setKey('KeyC', false); } this.setKey('ShiftLeft', this.padSprint); }
    else if (this.padSprint && this.padY < 0.5) { this.padSprint = false; this.setKey('ShiftLeft', false); }
    this.padPrev = now;
  }

  /** 手柄震动（不支持的手柄和浏览器会直接忽略）。 */
  rumble(strong: number, weak: number, ms: number) {
    if (!this.padActive) return;
    try {
      for (const p of navigator.getGamepads()) {
        const act = p && (p as unknown as { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }).vibrationActuator;
        if (act?.playEffect) void act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
      }
    } catch { /* 忽略 */ }
  }

  endFrame() { this.pressedNow.clear(); this.lookDX = 0; this.lookDY = 0; }
}
