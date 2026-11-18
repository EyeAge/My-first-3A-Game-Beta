import type { GameAudio } from '../audio/audio';
import type { Input } from '../core/input';
import type { Port, Relay } from '../world/port';
import { dirName, type UI } from '../ui/ui';
import { KIND_NAME, type Enemies, type Kind } from './enemies';
import type { Player } from './player';
import type { Stats, Weapon } from './weapon';

// 切断中继的手感（数值照参考）：
const HOLD = 2.4;        // 要按住交互键多少秒
const HOLD_DECAY = 1.6;  // 松手以后进度每秒退掉多少（进度是 0~1，所以最多 0.63 秒清零）
const REACH = 2.2;       // 离柜子多近才够得着（水平距离，米）
const REACH_UP = 2.5;    // 脚下和柜子脚下的高度差不能超过这么多：站在夹层走道上够不着底下的柜子
const REACH_FACE = 0.45; // 要大致面朝柜子：视线和"指向柜子的方向"夹角的余弦不小于它（约 63° 以内）
const REACH_CLOSE = 0.9; // 贴到这么近就不再看朝向

/**
 * 刷怪的全部参数（数量和节奏照参考）。一局的敌人只有这几个来源，没有"按时间自动刷"：
 *   开局      —— 3 只在三处中继附近巡逻，不知道玩家在哪；
 *   断一处中继 —— 来一波增援，直奔玩家；
 *   全断之后   —— 撤离路上的追兵：场上不到 4 只时才补，一共最多补 5 只。
 * 合计 3 + 4 + 5 + 7 + 5 = 24 只，同时活着的不超过 9 只。玩家不碰中继，场上就只有开局那 3 只。
 */
const DIRECTOR = {
  patrol: ['gull', 'gull', 'hound'] as Kind[],
  // 三波增援。参考的第三波是 4 飞鸥 + 3 猎犬；我们把其中一条猎犬换成了自己加的守卫，让它在最后一波压轴出场
  waves: [
    { gull: 3, ground: ['hound'] },
    { gull: 3, ground: ['hound', 'hound'] },
    { gull: 4, ground: ['hound', 'guard', 'hound'] },
  ] as { gull: number; ground: Kind[] }[],
  maxAlive: 9,          // 同时存活的上限：满了就让排队的等一等
  firstDelay: 1.6,      // 断开中继后多久来第一只
  stagger: 0.85,        // 之后每只间隔多久
  spawnMin: 26, spawnMax: 44,   // 增援刷在离玩家多远的地方（参考是 18 米起；我们的地图大、狗也更快，放远了一些）
  pursuitFirst: 12,     // 全断后多久开始追击
  pursuitEvery: 7,      // 每补一只之后至少隔多久
  pursuitMinAlive: 4,   // 场上少于这个数才补
  pursuitExtra: 5,      // 追击阶段一共最多补几只
  pursuitAlert: 4,      // 不补怪的时候，每隔这么久把全场的敌人往玩家这边叫一次
  // 场上满员、增援排着队进不来的时候：每隔 regroupEvery 秒，把离玩家 regroupBeyond 米以外还在闲逛的敌人叫过来（原因见 direct()）
  regroupEvery: 4, regroupBeyond: 50,
  // 刷出一只增援时，把多大范围内的敌人都叫过来。参考是 60 米（它的地图只有 80×60，等于全图）；我们的地图大约是它的两倍半见方
  spawnAlertRadius: 150, pursuitAlertRadius: 220,
  noiseEvery: 0.3,      // 枪声最多每 0.3 秒"通报"一次（传多远由敌人那边的 SENSE.hearRadius 定，45 米）
};
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
  /** 切断的进度（按住的秒数）、它属于哪只柜子、现在是不是正按着。松手后进度是慢慢退的，所以"属于谁"和"正按着"要分开记。 */
  private hold = 0; private holdRelay: Relay | null = null; private cutting = false; private lastTick = 0;
  private events: { t: number; fn: () => void }[] = [];
  private lowHpT = 0; private evacHintT = 0;
  /** 排队等着出场的增援：到了时间 t 就刷出来；刷不出来（场上满了、没找到位置）就往后推。 */
  private queue: { kind: Kind; t: number; tries: number }[] = [];
  private announce = false;                      // 这一波的"发现敌情"提示还没播
  private pursuitT = 0; private pursuitLeft = 0;
  private spotted = false;                       // "你已被发现"的无线电只说一次
  private heardShots = 0; private noiseT = 0;
  private regroupT = 0;                          // 下一次"满员时召集"最早在什么时候

  constructor(private port: Port, private enemies: Enemies, private ui: UI, private audio: GameAudio, private weapon: Weapon, private player: Player) {
    enemies.onKill = (e, weak) => {
      this.stats.kills++;
      this.weapon.addReserve(e.kind === 'guard' ? 20 : 8); // 击毁敌人回收一点弹药
      if (weak) this.ui.feed('弱点命中', true);
      this.ui.feed(`${KIND_NAME[e.kind]} 已摧毁`);
    };
    // 第一次有敌人亲眼看见玩家、进入交战时，指挥中心提醒一句
    enemies.onAlert = (_e, noise) => {
      if (noise || this.spotted) return;
      this.spotted = true;
      this.radio('你已被发现！空中有机械飞鸥，地面有机械猎犬。消灭它们。');
      this.audio.alarm();
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
    this.time = 0; this.cut = 0; this.won = false; this.hold = 0; this.holdRelay = null; this.cutting = false; this.prompt = null;
    this.stats = { shots: 0, hits: 0, kills: 0 };
    this.events = []; this.lowHpT = 0; this.evacHintT = 0;
    this.queue = []; this.announce = false; this.pursuitT = 0; this.pursuitLeft = 0; this.spotted = false; this.heardShots = 0; this.noiseT = 0; this.regroupT = 0;
    this.port.relays.forEach((r) => r.reset());
    this.at(1.6, () => this.radio('激战队员，这里是指挥中心。港区主控已封锁泊位。切断堆场、仓库、码头的三处中继。'));
    // 开局的三只巡逻兵：三处中继附近各放一只（哪只守哪处是随机的）。它们不知道玩家在哪，可以摸过去打个措手不及
    const posts = [...this.port.relays].sort(() => Math.random() - 0.5);
    DIRECTOR.patrol.forEach((kind, i) => {
      const r = posts[i % posts.length];
      this.enemies.spawnNear(kind, r.pos.x, r.pos.z, 6, 16, this.player);
    });
  }

  private at(delay: number, fn: () => void) { this.events.push({ t: this.time + delay, fn }); }
  private radio(text: string) { this.ui.radio(text); this.audio.radio(); }

  /** 把第 i 波增援排进出场队列。飞鸥和地面单位交错着来：飞、狗、飞、狗、飞…… */
  private wave(i: number) {
    const w = DIRECTOR.waves[i];
    const order: Kind[] = Array.from({ length: w.gull }, () => 'gull' as Kind);
    w.ground.forEach((kind, k) => order.splice(Math.min(order.length, 1 + k * 2), 0, kind));
    order.forEach((kind, k) => this.queue.push({ kind, t: this.time + DIRECTOR.firstDelay + k * DIRECTOR.stagger, tries: 0 }));
    this.announce = true;
  }

  /** 每帧处理出场队列和撤离阶段的追兵。 */
  private direct(dt: number) {
    const { player, enemies } = this;
    const alive = enemies.aliveCount;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.t > this.time) continue;
      if (alive >= DIRECTOR.maxAlive) {
        item.t += 1;                                                             // 场上满了：过 1 秒再看
        // 满员时把远处闲逛的敌人往玩家这边叫。不这么做的话有一种僵局：玩家从上一场战斗里跑开（我们的地图大，跑得掉），
        // 被甩掉的敌人找不到人就在原地巡逻，可它们还占着名额，新的增援进不来，场面就一直冷着。
        // 只叫 50 米以外、处于巡逻状态的：近处的敌人听得见枪声，不需要帮忙；正在调查 / 搜索的也不打扰，免得它们永远"知道"玩家在哪。
        // 参考的地图只有 80×60 米，谁也跑不出别人的视线，所以它没有这一步。
        if (this.time >= this.regroupT) { this.regroupT = this.time + DIRECTOR.regroupEvery; enemies.regroup(player.pos, DIRECTOR.regroupBeyond); }
        continue;
      }
      const e = enemies.spawnAround(item.kind, player, { minDist: DIRECTOR.spawnMin, maxDist: DIRECTOR.spawnMax });
      if (!e) { item.t += 1.5; if (++item.tries > 6) this.queue.splice(i, 1); break; }   // 没找到合适的位置：稍后重试，试太多次就算了
      this.queue.splice(i, 1);
      enemies.alert(player.pos, DIRECTOR.spawnAlertRadius);                      // 新来的一到，就把附近的同伴都叫向玩家
      if (this.announce) {
        this.announce = false;
        const bearing = (Math.atan2(e.pos.x - player.pos.x, -(e.pos.z - player.pos.z)) * 180) / Math.PI;
        this.ui.hint(`发现敌情 · ${dirName(bearing)}`, 3.4);
      }
      break;                                                                     // 一帧只放一只
    }

    if (this.cut >= 3) {
      this.pursuitT -= dt;
      if (this.pursuitT <= 0) {
        if (this.pursuitLeft > 0 && this.queue.length === 0 && alive < DIRECTOR.pursuitMinAlive) {
          // 清一点补一点：六成是飞鸥，四成是猎犬
          this.pursuitT = DIRECTOR.pursuitEvery; this.pursuitLeft--;
          this.queue.push({ kind: Math.random() < 0.6 ? 'gull' : 'hound', t: this.time + 0.5, tries: 0 });
        } else {
          this.pursuitT = DIRECTOR.pursuitAlert;
          enemies.alert(player.pos, DIRECTOR.pursuitAlertRadius);
        }
      }
    }

    // 枪声：开过枪（射击计数变了）就让听得见的敌人过来调查
    this.noiseT -= dt;
    if (this.stats.shots !== this.heardShots && this.noiseT <= 0) {
      this.heardShots = this.stats.shots; this.noiseT = DIRECTOR.noiseEvery;
      enemies.alert(player.pos);
    }
  }

  update(dt: number, input: Input) {
    this.time += dt;
    const { player, port } = this;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].t <= this.time) { const ev = this.events[i]; this.events.splice(i, 1); ev.fn(); }

    // ---- 切断中继：走到柜子跟前、面朝它、按住 E。柜子自己会演给玩家看（relay.ts）：按着的时候灯急闪、天线乱转，松手立刻恢复
    const near = player.alive ? this.relayInReach() : null;
    if (near && input.down('KeyE')) {
      if (this.holdRelay !== near) { this.stopCutting(); this.holdRelay = near; this.hold = 0; } // 换了一只柜子：进度从头来
      if (!this.cutting) { this.cutting = true; near.setCutting(true); }
      this.hold += dt;
      if (this.hold - this.lastTick > 0.22 || this.hold < this.lastTick) { this.lastTick = this.hold; this.audio.relayTick(this.hold / HOLD); }
      if (this.hold >= HOLD) this.cutRelay(near);
    } else {
      // 松手或者走开：柜子马上回到正常状态，进度很快退掉（退完之前再按，可以接着刚才的进度）
      this.stopCutting();
      this.hold = Math.max(0, this.hold - dt * HOLD_DECAY * HOLD); this.lastTick = 0;
    }
    this.prompt = near && !near.cut ? { text: `按住 · 切断中继 ${near.short}`, progress: near === this.holdRelay ? this.hold / HOLD : 0 } : null;

    // ---- 撤离
    const de = Math.hypot(port.evacPos.x - player.pos.x, port.evacPos.z - player.pos.z);
    if (de < 4.2) {
      if (this.cut >= 3) this.won = true;
      else if (this.time > this.evacHintT) { this.evacHintT = this.time + 6; this.ui.hint('中继尚未断开，撤离艇无法在火力下接应', 4); }
    }

    this.direct(dt);
    if (player.hp < 30 && player.alive && this.time > this.lowHpT) { this.lowHpT = this.time + 25; this.radio('伤势严重！找掩体躲避，稍作恢复。'); }
  }

  /** 玩家现在够得着哪只还没切断的中继柜（够得着几只就取最近的），都够不着返回 null。 */
  private relayInReach(): Relay | null {
    const { pos, yaw } = this.player;
    let best: Relay | null = null, bestDist = REACH;
    for (const r of this.port.relays) {
      if (r.cut) continue;
      const dx = r.pos.x - pos.x, dz = r.pos.z - pos.z, dist = Math.hypot(dx, dz);
      if (dist > bestDist || Math.abs(r.pos.y - pos.y) > REACH_UP) continue;
      // 玩家面朝的水平方向是 (−sin yaw, −cos yaw)；和"指向柜子"的单位向量点乘，就是两者夹角的余弦
      if (dist > REACH_CLOSE && (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / dist < REACH_FACE) continue;
      best = r; bestDist = dist;
    }
    return best;
  }

  /** 不再按着了：让正在被切的那只柜子回到正常状态。 */
  private stopCutting() {
    if (!this.cutting) return;
    this.cutting = false;
    this.holdRelay?.setCutting(false);
  }

  private cutRelay(r: Relay) {
    r.setCut();
    this.cut++; this.hold = 0; this.holdRelay = null; this.cutting = false;
    this.audio.relayDone();
    this.ui.feed(`${r.name} 已断开`, true);
    this.weapon.addReserve(90, 180);
    this.radio(RADIO_CUT[this.cut - 1]);
    this.audio.alarm();
    this.wave(this.cut - 1);
    if (this.cut >= 3) { this.pursuitT = DIRECTOR.pursuitFirst; this.pursuitLeft = DIRECTOR.pursuitExtra; }
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
