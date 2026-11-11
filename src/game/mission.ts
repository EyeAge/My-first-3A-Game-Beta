import type { GameAudio } from '../audio/audio';
import type { Input } from '../core/input';
import type { Port, Relay } from '../world/port';
import { dirName, type UI } from '../ui/ui';
import { KIND_NAME, type Enemies, type Kind } from './enemies';
import type { Player } from './player';
import type { Stats, Weapon } from './weapon';

const HOLD = 2.2; // 切断一处中继需要按住 E 的秒数
type Wave = [Kind, number][];
const WAVES: Wave[] = [
  [['gull', 3], ['hound', 2]],
  [['guard', 2], ['hound', 3], ['gull', 2]],
  [['guard', 3], ['hound', 4], ['gull', 3]],
  [['guard', 2], ['hound', 4], ['gull', 3]],
];
const RADIO_CUT = [
  '第一处中继已断开。敌方已察觉，机械守卫正在赶来。',
  '第二处中继已断开。敌方正全力围攻，小心应对。',
  '三处中继全部断开！撤离艇在码头南端的舷梯旁，快撤！',
];

/** 任务导演：管流程、无线电、刷怪节奏和通关判定。 */
export class Mission {
  time = 0; cut = 0; retries = 0;
  stats: Stats = { shots: 0, hits: 0, kills: 0 };
  won = false;
  prompt: { text: string; progress: number } | null = null;
  private hold = 0; private holdRelay: Relay | null = null; private lastTick = 0;
  private events: { t: number; fn: () => void }[] = [];
  private trickleT = 0; private lowHpT = 0; private evacHintT = 0;

  constructor(private port: Port, private enemies: Enemies, private ui: UI, private audio: GameAudio, private weapon: Weapon, private player: Player) {
    enemies.onKill = (e, weak) => {
      this.stats.kills++;
      this.weapon.addReserve(e.kind === 'guard' ? 20 : 8); // 击毁敌人回收一点弹药
      if (weak) this.ui.feed('弱点命中', true);
      this.ui.feed(`${KIND_NAME[e.kind]} 已摧毁`);
    };
  }

  get objective() {
    if (this.cut === 0) return '切断三处上行中继';
    if (this.cut === 1) return '切断剩余 2 处中继';
    if (this.cut === 2) return '切断最后一处中继';
    return '前往撤离艇';
  }

  reset(isRetry: boolean) {
    if (isRetry) this.retries++; else this.retries = 0;
    this.time = 0; this.cut = 0; this.won = false; this.hold = 0; this.holdRelay = null; this.prompt = null;
    this.stats = { shots: 0, hits: 0, kills: 0 };
    this.events = []; this.trickleT = 16; this.lowHpT = 0; this.evacHintT = 0;
    this.port.relays.forEach((r) => r.reset());
    this.at(1.6, () => this.radio('几猫队员，这里是指挥中心。港区主控已封锁泊位。切断堆场、仓库、码头的三处中继。'));
    this.at(10, () => { this.radio('你已被发现！空中有机械飞鸥，地面有机械猎犬。消灭它们。'); this.audio.alarm(); this.wave(0); });
  }

  private at(delay: number, fn: () => void) { this.events.push({ t: this.time + delay, fn }); }
  private radio(text: string) { this.ui.radio(text); this.audio.radio(); }

  private wave(i: number) {
    let k = 0, announced = false;
    for (const [kind, n] of WAVES[i]) for (let j = 0; j < n; j++) {
      this.at(k++ * 0.5, () => {
        if (this.enemies.aliveCount >= 18) return; // 场上敌人数量封顶
        const e = this.enemies.spawnAround(kind, this.player);
        if (e && !announced) {
          announced = true;
          const bearing = (Math.atan2(e.pos.x - this.player.pos.x, -(e.pos.z - this.player.pos.z)) * 180) / Math.PI;
          this.ui.hint(`发现敌情 · ${dirName(bearing)}`, 3.5);
        }
      });
    }
  }

  update(dt: number, input: Input) {
    this.time += dt;
    const { player, port } = this;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].t <= this.time) { const ev = this.events[i]; this.events.splice(i, 1); ev.fn(); }

    // ---- 切断中继：走近、按住 E
    let near: Relay | null = null;
    for (const r of port.relays) if (!r.cut && Math.hypot(r.pos.x - player.pos.x, r.pos.z - player.pos.z) < 3) near = r;
    if (near) {
      if (input.down('KeyE')) {
        if (this.holdRelay !== near) { this.holdRelay = near; this.hold = 0; }
        this.hold += dt;
        if (this.hold - this.lastTick > 0.22 || this.hold < this.lastTick) { this.lastTick = this.hold; this.audio.relayTick(this.hold / HOLD); }
        if (this.hold >= HOLD) this.cutRelay(near);
      } else { this.hold = Math.max(0, this.hold - dt * 2); this.lastTick = 0; }
      this.prompt = near.cut ? null : { text: `按住 · 切断中继 ${near.short}`, progress: this.hold / HOLD };
    } else { this.hold = 0; this.holdRelay = null; this.prompt = null; }

    // ---- 撤离
    const de = Math.hypot(port.evacPos.x - player.pos.x, port.evacPos.z - player.pos.z);
    if (de < 4.2) {
      if (this.cut >= 3) this.won = true;
      else if (this.time > this.evacHintT) { this.evacHintT = this.time + 6; this.ui.hint('中继尚未断开，撤离艇无法在火力下接应', 4); }
    }

    // ---- 持续施压：场上敌人太少时零星补充
    this.trickleT -= dt;
    if (this.trickleT <= 0 && this.time > 14) {
      this.trickleT = 9 - this.cut * 1.2;
      const target = 3 + this.cut * 2;
      if (this.enemies.aliveCount < target && this.enemies.aliveCount < 16) {
        const r = Math.random();
        this.enemies.spawnAround(r < 0.45 ? 'hound' : r < 0.8 || this.cut === 0 ? 'gull' : 'guard', player);
      }
    }
    if (player.hp < 30 && player.alive && this.time > this.lowHpT) { this.lowHpT = this.time + 25; this.radio('伤势严重！找掩体躲避，稍作恢复。'); }
  }

  private cutRelay(r: Relay) {
    r.setCut();
    this.cut++; this.hold = 0; this.holdRelay = null;
    this.audio.relayDone();
    this.ui.feed(`${r.name} 已断开`, true);
    this.weapon.addReserve(90, 180);
    this.radio(RADIO_CUT[this.cut - 1]);
    this.at(1.5, () => { this.audio.alarm(); this.wave(this.cut); });
  }

  rating() {
    const acc = this.stats.shots ? this.stats.hits / this.stats.shots : 0;
    const score = acc * 45 + Math.max(0, 35 - this.time / 14) + Math.max(0, 20 - this.retries * 10);
    return score >= 78 ? '完美突击' : score >= 62 ? '精准果断' : score >= 48 ? '火力全开' : score >= 34 ? '稳扎稳打' : '险象环生';
  }
  result() {
    return { time: this.time, accuracy: this.stats.shots ? this.stats.hits / this.stats.shots : 0, kills: this.stats.kills, retries: this.retries, cut: this.cut, rating: this.rating() };
  }
}
