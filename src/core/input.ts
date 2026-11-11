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
    if (this.touchMode) return;
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
    return clamp(k + this.stickX, -1, 1);
  }
  get moveY() {
    const k = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    return clamp(k + this.stickY, -1, 1);
  }
  /** 方向键转视角（给捕获不了鼠标的环境用） */
  get keyLookX() { return (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0); }
  get keyLookY() { return (this.down('ArrowDown') ? 1 : 0) - (this.down('ArrowUp') ? 1 : 0); }

  endFrame() { this.pressedNow.clear(); this.lookDX = 0; this.lookDY = 0; }
}
