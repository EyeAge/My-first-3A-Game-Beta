// 贴纸的"画法"：22 张具名贴纸各自怎么画，以及它们共用的三样工具 —— 写字、镂空断桥、做旧。
//
// 这里只管"往一块画布上画"，不管这块画布在图集的哪里（那是 labels.ts 的事）。
// 每个画法拿到的画布已经被平移、缩放好了：照着"设计尺寸"（比如 256 × 256）画就行。

export type Rng = () => number;
export type Rgb = readonly [number, number, number];

/** 调色板（屏幕颜色 0–255）。喷字和标识只用这几种颜色，全场才显得统一。 */
export const PALETTE = {
  white: [226, 223, 213], black: [24, 24, 26], yellow: [222, 172, 30],
  red: [168, 36, 28], navy: [24, 38, 58], orange: [206, 100, 30],
} as const satisfies Record<string, Rgb>;
export const css = (c: Rgb, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;

// 三类字体。项目不带字体文件，所以只列系统里常见的名字，浏览器会用第一个找得到的。
// 喷字用又窄又粗的 Impact（英文和数字）；汉字 Impact 里没有，会自动落到后面的黑体上。
const FONT_STENCIL = 'Impact, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Heiti SC", Arial, sans-serif';
const FONT_SANS = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Heiti SC", Arial, sans-serif';
const FONT_MONO = 'Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';

/** 这些字符太窄，或者中间本来就是空的，不抠断桥。 */
const NO_BRIDGE = new Set(['I', '1', ' ', '-', '.', '/', ':', ',', "'", '!', '·']);

export interface TextOpts {
  /** 不给就是镂空喷字（stencil）。 */
  font?: 'sans' | 'mono';
  weight?: number;
  /** 字间距（像素）。默认是字号的 6%。 */
  spacing?: number;
  /** false 表示镂空字体也不抠断桥（公司标的大字）。 */
  bridges?: boolean;
  /** 最多这么宽，超过就横向压扁。 */
  maxW?: number;
  align?: 'left' | 'center' | 'right';
}

let scratch: HTMLCanvasElement | null = null;

function familyOf(font: TextOpts['font']) { return font === 'sans' ? FONT_SANS : font === 'mono' ? FONT_MONO : FONT_STENCIL; }

/** 一行字逐字排开有多宽（含字间距）。 */
export function measureText(g: CanvasRenderingContext2D, text: string, size: number, o: TextOpts = {}) {
  const spacing = o.spacing ?? size * 0.06;
  g.font = `${o.weight ?? 700} ${size}px ${familyOf(o.font)}`;
  let w = 0;
  for (const ch of text) w += g.measureText(ch).width + spacing;
  return w - spacing;
}

/**
 * 写一行字。(x, baseline) 是基线上的起点（或者中点、终点，看 align）。返回实际画出来的宽度。
 *
 * 镂空喷字的"断桥"：真正的漏字板上，"口""O"这种封闭的笔画中间那块会掉下来，所以要留几根细条连着。
 * 喷出来的字于是每个都有断口。这里的做法很简单：每个字画完，在它正中间竖着抠掉一条。任何字体、汉字也一样适用。
 *
 * 字先画在一块临时画布上再贴过来 —— 因为"抠掉"用的是擦除模式，直接在目标上擦会把底下已经画好的东西（比如铭牌的金属底）一起擦穿。
 */
export function drawText(g: CanvasRenderingContext2D, text: string, x: number, baseline: number, size: number, color: string, o: TextOpts = {}) {
  const weight = o.weight ?? 700, spacing = o.spacing ?? size * 0.06;
  const bridges = o.font !== 'sans' && o.font !== 'mono' && o.bridges !== false;
  const natural = measureText(g, text, size, o);
  const squeeze = o.maxW && natural > o.maxW ? o.maxW / natural : 1;
  const w = Math.ceil(natural * squeeze) + 8, h = Math.ceil(size * 1.4);
  // 目标画布可能是缩小了画的（图集里的贴纸比设计尺寸小）。临时画布按同样的比例缩，字才是清晰的
  const zoom = Math.max(0.05, Math.hypot(g.getTransform().a, g.getTransform().b));
  scratch ??= document.createElement('canvas');
  scratch.width = Math.max(1, Math.ceil(w * zoom)); scratch.height = Math.max(1, Math.ceil(h * zoom)); // 改尺寸会顺便清空画布
  const t = scratch.getContext('2d')!;
  t.scale(zoom * squeeze, zoom);
  t.font = `${weight} ${size}px ${familyOf(o.font)}`;
  t.textBaseline = 'alphabetic';
  t.fillStyle = color;
  let pen = 4 / squeeze;
  const base = size * 1.08;
  for (const ch of text) {
    const cw = t.measureText(ch).width;
    t.fillText(ch, pen, base);
    if (bridges && !NO_BRIDGE.has(ch)) {
      t.save();
      t.globalCompositeOperation = 'destination-out'; // 擦除模式：画到哪，哪就变透明
      t.fillStyle = '#000';
      t.fillRect(pen + cw * 0.5 - size * 0.032, 0, size * 0.064, size * 1.4); // 断桥宽度 = 字号的 6.4%
      t.restore();
    }
    pen += cw + spacing;
  }
  const width = natural * squeeze;
  const left = o.align === 'center' ? x - width / 2 : o.align === 'right' ? x - width : x;
  g.drawImage(scratch, left - 4, baseline - base, w, h);
  return width;
}

/** 一个不规则的多边形（掉漆的斑、弹孔的边）：sides 个角，每个角到中心的距离在 r × (1 ± jitter) 里随机。只描路径，不填色。 */
export function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, rng: Rng, jitter = 0.35, sides = 9) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2, rr = r * (1 - jitter + rng() * jitter * 2);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath();
}

/**
 * 做旧：从已经画好的内容上"抠掉"一些东西（全部用擦除模式）。amount 是做旧程度 0–1。
 * 四层，都是硬边的 —— 喷漆和贴纸旧了是一块一块掉、一道一道被刮，而不是整体变淡：
 *   掉漆斑  大多数很小，偶尔一大块（半径用随机数的三次方：小的多、大的少）
 *   划痕    接近水平的长线
 *   麻点    一两个像素的小方块
 *   褪色    几团柔和的圆斑，这一层是软的
 */
export function distress(g: CanvasRenderingContext2D, w: number, h: number, amount: number, rng: Rng) {
  if (amount <= 0) return;
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000'; g.strokeStyle = '#000'; // 擦除的力度只看不透明度，这里明确给成全力
  const chips = Math.floor((amount * w * h) / 700);
  for (let i = 0; i < chips; i++) {
    const r = Math.pow(rng(), 3) * h * 0.09 + 0.6;
    g.globalAlpha = 0.45 + rng() * 0.55;
    const x = rng() * w, y = rng() * h;
    blob(g, x, y, r, rng, 0.5, 7);
    g.fill();
  }
  g.lineCap = 'round';
  for (let i = 0; i < amount * 16; i++) {
    const x = rng() * w, y = rng() * h, angle = (rng() - 0.5) * 0.7, len = (0.1 + rng() * 0.5) * w;
    g.globalAlpha = 0.5 + rng() * 0.5;
    g.lineWidth = 0.5 + rng() * rng() * 3;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len); g.stroke();
  }
  g.globalAlpha = 0.8;
  for (let i = 0; i < (amount * w * h) / 60; i++) { const x = rng() * w, y = rng() * h; g.fillRect(x, y, 1 + rng(), 1 + rng()); }
  g.globalAlpha = 1;
  for (let i = 0; i < amount * 6; i++) {
    const x = rng() * w, y = rng() * h, r = (0.1 + rng() * 0.25) * h;
    const fade = g.createRadialGradient(x, y, 0, x, y, r);
    fade.addColorStop(0, `rgba(0,0,0,${0.25 + rng() * 0.4})`); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
}

/** 一张贴纸的定义。 */
export interface DecalDef {
  /** 设计尺寸（像素）。画法里的坐标都按它来。 */
  w: number; h: number;
  /** 粗糙度、金属度。默认 0.7 / 0：一张哑光的贴纸。油渍给得很低（油是亮的），弹孔翻出来的金属给高金属度。 */
  rough?: number; metal?: number;
  /** 主色。透明的地方会先铺一层几乎看不见的它（见 labels.ts 的"防黑边"）。 */
  bleed?: Rgb;
  /** 画进图集时的缩放。默认 0.75；字很小的（铭牌）给大一些。 */
  scale?: number;
  draw: (g: CanvasRenderingContext2D, w: number, h: number, rng: Rng) => void;
}

const P = PALETTE;
const poly = (g: CanvasRenderingContext2D, pts: number[][]) => {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.closePath();
};

/** 黄底黑边的警告三角。粗黑边在外，里面再描一道细线。 */
function warningTriangle(g: CanvasRenderingContext2D, w: number, h: number) {
  g.lineJoin = 'round';
  poly(g, [[w / 2, h * 0.12], [w * 0.9, h * 0.84], [w * 0.1, h * 0.84]]);
  g.lineWidth = w * 0.11; g.strokeStyle = css(P.black); g.stroke();
  g.fillStyle = css(P.yellow); g.fill();
  g.lineWidth = w * 0.035; g.stroke();
}

/**
 * 公司标的版式：左边一个图形标，右边大字 + 一条细横线 + 一行小字。
 * mark 在以图形标中心为原点的坐标里画，m 是它的"半径"；accent 是点缀色（不给就和主色一样）。
 */
function logo(color: Rgb, title: string, subtitle: string, mark: (g: CanvasRenderingContext2D, m: number, accent: string) => void, accent?: Rgb): DecalDef {
  return {
    w: 640, h: 192, bleed: color,
    draw(g, w, h, rng) {
      const main = css(color), second = css(accent ?? color);
      g.fillStyle = g.strokeStyle = main;
      g.save(); g.translate(h * 0.5, h * 0.5); mark(g, h * 0.38, second); g.restore();
      drawText(g, title, h, h * 0.6, h * 0.42, main, { weight: 900, bridges: false, maxW: w - h * 1.05, spacing: h * 0.012 });
      g.fillStyle = second; g.fillRect(h, h * 0.67, w - h * 1.12, h * 0.022);
      drawText(g, subtitle, h, h * 0.84, h * 0.115, main, { font: 'sans', weight: 600, spacing: h * 0.035, maxW: w - h * 1.1 });
      distress(g, w, h, 0.35, rng);
    },
  };
}

/** 一条往下淌的痕迹：上端最浓，往下渐渐淡到没有。 */
function drip(g: CanvasRenderingContext2D, x: number, top: number, width: number, len: number, stops: [number, string][]) {
  const grad = g.createLinearGradient(0, top, 0, top + len);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(x, top, width, len);
}

/** 全部具名贴纸。往这里加一项，decal('名字') 就能用。 */
export const DECAL_ART: Record<string, DecalDef> = {
  // ---------------------------------------------------------------- 危险品和警示
  /** 易燃品：红色菱形，白色内框，火焰，底下一个"3"（易燃液体的类别号）。 */
  hazard_flammable: {
    w: 256, h: 256, bleed: P.red,
    draw(g, w, h, rng) {
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
      g.fillStyle = css(P.red); g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = css(P.white); g.lineWidth = 5; g.strokeRect(-76, -76, 152, 152);
      g.restore();
      g.save(); g.translate(w / 2, h / 2 - 8);
      g.fillStyle = css(P.white); // 火焰的外形
      g.beginPath(); g.moveTo(2, -64);
      g.bezierCurveTo(34, -28, 40, 6, 24, 28); g.bezierCurveTo(12, 44, -12, 44, -24, 28);
      g.bezierCurveTo(-40, 6, -20, -12, -15, -34); g.bezierCurveTo(-6, -28, 0, -44, 2, -64); g.fill();
      g.fillStyle = css(P.red); // 火焰里面挖一个小的焰心
      g.beginPath(); g.moveTo(1, -10); g.bezierCurveTo(15, 6, 15, 24, 0, 31); g.bezierCurveTo(-15, 24, -13, 8, 1, -10); g.fill();
      g.fillStyle = css(P.white); g.fillRect(-34, 50, 68, 6);
      g.restore();
      drawText(g, '3', w / 2, h * 0.9, 34, css(P.white), { align: 'center', weight: 900, bridges: false });
      distress(g, w, h, 0.3, rng);
    },
  },
  /** 高压：黄三角 + 黑闪电。 */
  hazard_voltage: {
    w: 256, h: 256, bleed: P.yellow,
    draw(g, w, h, rng) {
      warningTriangle(g, w, h);
      g.fillStyle = css(P.black);
      g.save(); g.translate(w / 2, h * 0.56);
      poly(g, [[12, -58], [-24, 4], [-3, 4], [-16, 50], [26, -14], [5, -14], [22, -58]]); g.fill();
      g.restore();
      distress(g, w, h, 0.3, rng);
    },
  },
  /** 一般警告：黄三角 + 感叹号。 */
  hazard_general: {
    w: 256, h: 256, bleed: P.yellow,
    draw(g, w, h, rng) {
      warningTriangle(g, w, h);
      g.fillStyle = css(P.black);
      poly(g, [[w / 2 - 13, h * 0.34], [w / 2 + 13, h * 0.34], [w / 2 + 7, h * 0.62], [w / 2 - 7, h * 0.62]]); g.fill();
      g.beginPath(); g.arc(w / 2, h * 0.715, 11, 0, 7); g.fill();
      distress(g, w, h, 0.3, rng);
    },
  },
  /** 腐蚀品：白色菱形黑框，中间一个"蚀"字。（参考里没有这一张，是我们原有的，保留。） */
  corrosive: {
    w: 256, h: 256, bleed: P.white,
    draw(g, w, h, rng) {
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
      g.fillStyle = css(P.white); g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = css(P.black); g.lineWidth = 5; g.strokeRect(-76, -76, 152, 152);
      g.restore();
      drawText(g, '蚀', w / 2, h * 0.62, 84, css(P.black), { align: 'center', weight: 900, bridges: false });
      distress(g, w, h, 0.3, rng);
    },
  },
  /** 喷在地上的方向箭头（朝右）。箭杆和箭头上各有一道模板的断桥。 */
  arrow: {
    w: 384, h: 192, bleed: P.white,
    draw(g, w, h, rng) {
      g.fillStyle = css(P.white);
      poly(g, [[20, 68], [226, 68], [226, 22], [364, 96], [226, 170], [226, 124], [20, 124]]); g.fill();
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
      g.fillRect(118, 0, 9, h); g.fillRect(232, 0, 7, h);
      g.globalCompositeOperation = 'source-over';
      distress(g, w, h, 0.5, rng);
    },
  },
  /** 朝上的箭头。（我们原有的名字，保留；和 arrow 是同一个箭头转了 90°。） */
  arrow_up: {
    w: 192, h: 384, bleed: P.white,
    draw(g, w, h, rng) {
      g.save(); g.translate(0, h); g.rotate(-Math.PI / 2); // 把"朝右"转成"朝上"
      g.fillStyle = css(P.white);
      poly(g, [[20, 68], [226, 68], [226, 22], [364, 96], [226, 170], [226, 124], [20, 124]]); g.fill();
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
      g.fillRect(118, 0, 9, w); g.fillRect(232, 0, 7, w);
      g.restore();
      distress(g, w, h, 0.5, rng);
    },
  },
  /** 禁止通行：红底白圈白横杠。 */
  no_entry: {
    w: 256, h: 256, bleed: P.red,
    draw(g, w, h, rng) {
      g.fillStyle = css(P.white); g.beginPath(); g.arc(128, 128, 112, 0, 7); g.fill();
      g.fillStyle = css(P.red); g.beginPath(); g.arc(128, 128, 102, 0, 7); g.fill();
      g.fillStyle = css(P.white); g.fillRect(52, 106, 152, 44);
      distress(g, w, h, 0.3, rng);
    },
  },

  // ---------------------------------------------------------------- 四家船公司的标（刷在集装箱上）
  /** 北航：缺口圆环 + 指北针。 */
  logo_a: logo(P.white, '激战北航', '北极 · 大西洋 · 支线运输', (g, m) => {
    g.lineWidth = m * 0.13;
    g.beginPath(); g.arc(0, 0, m * 0.92, 0.25 * Math.PI, 1.75 * Math.PI); g.stroke();
    poly(g, [[0, -m * 1.08], [m * 0.26, 0], [0, m * 0.62], [-m * 0.26, 0]]); g.fill();
    poly(g, [[m * 0.5, 0], [m * 1.12, -m * 0.1], [m * 1.12, m * 0.1]]); g.fill();
  }),
  /** 远洋：两道橙色的浪。 */
  logo_b: logo(P.white, '激战远洋', '集装箱运输', (g, m, accent) => {
    g.fillStyle = accent;
    for (let i = 0; i < 2; i++) {
      const y = -m * 0.35 + i * m * 0.55, thick = m * (0.3 - i * 0.06);
      g.beginPath(); g.moveTo(-m * 1.05, y - m * 0.25);
      g.quadraticCurveTo(-m * 0.3, y - m * 0.2, 0, y + m * 0.35);
      g.quadraticCurveTo(m * 0.3, y - m * 0.2, m * 1.05, y - m * 0.25);
      g.quadraticCurveTo(m * 0.35, y + thick * 0.2, 0, y + m * 0.35 + thick);
      g.quadraticCurveTo(-m * 0.35, y + thick * 0.2, -m * 1.05, y - m * 0.25);
      g.fill();
    }
  }, P.orange),
  /** 太平洋：海平线上的半个太阳，七道光芒。藏青色，刷在浅色的箱子上。 */
  logo_c: logo(P.navy, '激战太平洋', '远洋 · 冷链 · 散货', (g, m) => {
    g.beginPath(); g.arc(0, m * 0.25, m * 0.55, Math.PI, 0); g.closePath(); g.fill();
    g.lineWidth = m * 0.1; g.lineCap = 'butt';
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + ((i + 0.5) / 7) * Math.PI;
      g.beginPath(); g.moveTo(Math.cos(a) * m * 0.7, m * 0.25 + Math.sin(a) * m * 0.7); g.lineTo(Math.cos(a) * m * 1.05, m * 0.25 + Math.sin(a) * m * 1.05); g.stroke();
    }
    g.fillRect(-m * 1.05, m * 0.42, m * 2.1, m * 0.13);
    g.fillRect(-m * 0.8, m * 0.68, m * 1.6, m * 0.1);
  }),
  /** 联运：一个"H"形，上下各嵌一块黄色。 */
  logo_d: logo(P.white, '激战联运', '多式联运', (g, m, accent) => {
    g.fillRect(-m, -m, m * 0.5, m * 2); g.fillRect(m * 0.5, -m, m * 0.5, m * 2); g.fillRect(-m, -m * 0.2, m * 2, m * 0.4);
    g.fillStyle = accent;
    g.fillRect(-m * 0.32, -m, m * 0.64, m * 0.5); g.fillRect(-m * 0.32, m * 0.5, m * 0.64, m * 0.5);
  }, P.yellow),

  // ---------------------------------------------------------------- 地面和墙上的标识
  /** 刷在码头地面上的泊位号：黄框（四分之一和四分之三处是模板的断口）+ 大字。 */
  berth4: {
    w: 640, h: 224, bleed: P.yellow,
    draw(g, w, h, rng) {
      g.strokeStyle = css(P.yellow); g.lineWidth = 12; g.strokeRect(14, 14, w - 28, h - 28);
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
      for (const x of [w * 0.25, w * 0.75]) g.fillRect(x - 6, 0, 12, h);
      g.globalCompositeOperation = 'source-over';
      drawText(g, '四号泊位', w / 2, h * 0.76, h * 0.66, css(P.yellow), { align: 'center', weight: 900, maxW: w - 80 });
      distress(g, w, h, 0.55, rng);
    },
  },
  /** 黑底黄斜纹的警示带。 */
  caution_stripes: {
    w: 512, h: 128, bleed: P.black,
    draw(g, w, h, rng) {
      g.fillStyle = css(P.black); g.fillRect(0, 8, w, h - 16);
      g.save();
      g.beginPath(); g.rect(0, 8, w, h - 16); g.clip();
      g.fillStyle = css(P.yellow);
      for (let x = -h; x < w + h; x += 64) { poly(g, [[x, h], [x + 32, h], [x + 32 + h, 0], [x + h, 0]]); g.fill(); }
      g.restore();
      distress(g, w, h, 0.5, rng);
    },
  },
  /** 十个喷字数字排成一行，每个占 64 宽。用 labels.ts 的 digit(n) 取其中一个。 */
  numbers_0_9: {
    w: 640, h: 128, bleed: P.white,
    draw(g, w, h, rng) {
      for (let n = 0; n < 10; n++) drawText(g, String(n), n * 64 + 32, h * 0.86, h * 0.92, css(P.white), { align: 'center', weight: 900, maxW: 54 });
      distress(g, w, h, 0.3, rng);
    },
  },

  // ---------------------------------------------------------------- 污渍（半透明，叠在任何表面上）
  /** 从上往下淌的脏水痕：几十条宽窄不一的竖条，上浓下淡。贴在窗台、檐口、箱顶下面。 */
  grime_streak: {
    w: 128, h: 256, rough: 0.85, bleed: [26, 23, 19],
    draw(g, w, h, rng) {
      for (let i = 0; i < 46; i++) {
        const x = w * (0.12 + 0.76 * (rng() * 0.5 + rng() * 0.5)), len = h * (0.25 + rng() * 0.7), width = 1.5 + rng() * rng() * 12, a = 0.05 + rng() * 0.16;
        drip(g, x - width / 2 + (rng() - 0.5) * 2, 0, width, len, [[0, `rgba(26,23,19,${a})`], [0.15, `rgba(26,23,19,${a * 1.3})`], [1, 'rgba(26,23,19,0)']]);
      }
    },
  },
  /** 锈水：顶上几个锈斑，往下淌出橙褐色的流痕。贴在螺栓、焊缝、锈点下面。 */
  rust_run: {
    w: 128, h: 256, rough: 0.9, bleed: [118, 52, 18],
    draw(g, w, h, rng) {
      for (let i = 0; i < 40; i++) {
        const x = w * (0.2 + 0.6 * (rng() * 0.5 + rng() * 0.5)), len = h * (0.2 + rng() * 0.75), width = 1.2 + rng() * rng() * 9, a = 0.08 + rng() * 0.22;
        const c = rng() < 0.5 ? '118,52,18' : '150,78,26';
        // 渐变从 y = 8 画到 y = len（不是 8 + len），所以这里手工建渐变，不用 drip()
        const grad = g.createLinearGradient(0, 8, 0, len);
        grad.addColorStop(0, `rgba(${c},${a * 1.4})`); grad.addColorStop(0.3, `rgba(${c},${a})`); grad.addColorStop(1, `rgba(${c},0)`);
        g.fillStyle = grad; g.fillRect(x - width / 2, 8, width, len);
      }
      for (let i = 0; i < 9; i++) {
        const c = rng() < 0.5 ? '70,30,14' : '104,44,16';
        g.fillStyle = `rgba(${c},${0.5 + rng() * 0.4})`;
        const x = w * (0.3 + rng() * 0.4), y = 6 + rng() * 12, r = 3 + rng() * 8;
        blob(g, x, y, r, rng, 0.5, 7); g.fill();
      }
    },
  },
  /** 地上的油渍：一堆深色的圆斑叠在一起，外围溅了些小点。粗糙度给得很低 —— 油是亮的，雨天会反光。 */
  oil_stain: {
    w: 256, h: 256, rough: 0.12, bleed: [10, 10, 11],
    draw(g, w, h, rng) {
      for (let i = 0; i < 26; i++) {
        const a = rng() * 7, d = Math.pow(rng(), 1.5) * w * 0.26; // 越靠中心越密
        const x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d * 0.8, r = w * (0.06 + rng() * 0.16);
        const grad = g.createRadialGradient(x, y, r * 0.2, x, y, r);
        grad.addColorStop(0, `rgba(10,10,11,${0.35 + rng() * 0.3})`); grad.addColorStop(0.75, 'rgba(12,11,10,0.22)'); grad.addColorStop(1, 'rgba(12,11,10,0)');
        g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < 30; i++) {
        g.fillStyle = `rgba(10,10,11,${0.3 + rng() * 0.4})`;
        const a = rng() * 7, d = w * (0.25 + rng() * 0.2);
        g.beginPath(); g.arc(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, 1 + rng() * 4, 0, 7); g.fill();
      }
    },
  },
  /** 漏水留下的水垢：上面一圈圈发白的环，往下是淡淡的水痕。贴在管道接头、空调下面。 */
  leak_stain: {
    w: 192, h: 256, rough: 0.8, bleed: [160, 154, 132],
    draw(g, w, h, rng) {
      for (let i = 0; i < 18; i++) {
        const x = w * (0.3 + rng() * 0.4), y = h * (0.12 + rng() * 0.2), r = w * (0.1 + rng() * 0.2);
        const grad = g.createRadialGradient(x, y, r * 0.5, x, y, r); // 中间透明、靠边最浓：一个环
        grad.addColorStop(0, 'rgba(150,146,130,0.0)'); grad.addColorStop(0.8, `rgba(168,162,140,${0.18 + rng() * 0.2})`); grad.addColorStop(1, 'rgba(168,162,140,0)');
        g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      for (let i = 0; i < 22; i++) {
        const x = w * (0.25 + 0.5 * rng()), len = h * (0.3 + rng() * 0.6), width = 2 + rng() * 9, a = 0.08 + rng() * 0.16;
        const c = rng() < 0.6 ? '160,154,132' : '60,66,52'; // 多数是发白的水垢，少数是发绿的苔
        drip(g, x, h * 0.2, width, len, [[0, `rgba(${c},${a})`], [1, `rgba(${c},0)`]]);
      }
    },
  },
  /** 爆炸或起火留下的焦痕：一堆黑色的圆斑，加上向外放射的细线。 */
  scorch: {
    w: 256, h: 256, rough: 0.95, bleed: [8, 7, 6],
    draw(g, w, h, rng) {
      for (let i = 0; i < 40; i++) {
        const a = rng() * 7, d = Math.pow(rng(), 1.2) * w * 0.3;
        const x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d, r = w * (0.07 + rng() * 0.15) * (1.2 - d / (w * 0.4)); // 越靠外的斑越小
        const grad = g.createRadialGradient(x, y, 0, x, y, Math.max(4, r));
        grad.addColorStop(0, `rgba(8,7,6,${0.3 + rng() * 0.3})`); grad.addColorStop(1, 'rgba(8,7,6,0)');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
      }
      g.strokeStyle = 'rgba(8,7,6,0.25)';
      for (let i = 0; i < 50; i++) {
        const a = rng() * 7, r0 = w * 0.1, r1 = w * (0.25 + rng() * 0.22);
        g.lineWidth = 1 + rng() * 3;
        g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * r0, h / 2 + Math.sin(a) * r0); g.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1); g.stroke();
      }
    },
  },
  /**
   * 裂缝：从中心出发的三条主裂纹。每条是一小步一小步走出来的折线（每步 9 像素，方向随机偏一点）；
   * 每走一步有 22% 的可能分出一条更细更短的岔，岔上还能再分，最多三层。
   */
  crack: {
    w: 256, h: 256, rough: 0.95, bleed: [20, 19, 18],
    draw(g, w, h, rng) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      const pen = (width: number) => { g.strokeStyle = `rgba(20,19,18,${0.6 + 0.35 * Math.min(1, width / 2.5)})`; g.lineWidth = width; };
      const branch = (x: number, y: number, angle: number, len: number, width: number, depth: number) => {
        pen(width);
        g.beginPath(); g.moveTo(x, y);
        const steps = Math.floor(len / 9);
        for (let i = 0; i < steps; i++) {
          angle += (rng() - 0.5) * 0.8;
          x += Math.cos(angle) * 9; y += Math.sin(angle) * 9;
          g.lineTo(x, y);
          if (depth > 0 && rng() < 0.22) {
            g.stroke(); // 先把走到这里的一段画掉，再去画岔（岔的粗细不一样）
            const turn = (rng() < 0.5 ? 1 : -1) * (0.5 + rng() * 0.7), sub = len * (0.3 + rng() * 0.3);
            branch(x, y, angle + turn, sub, width * 0.6, depth - 1);
            pen(width);
            g.beginPath(); g.moveTo(x, y);
          }
        }
        g.stroke();
      };
      branch(w * 0.5, h * 0.5, rng() * 7, w * 0.42, 2.6, 3);
      branch(w * 0.5, h * 0.5, rng() * 7 + 2, w * 0.4, 2.2, 3);
      branch(w * 0.5, h * 0.5, rng() * 7 + 4, w * 0.36, 1.8, 2);
    },
  },

  // ---------------------------------------------------------------- 弹孔
  /** 打在钢板上：锈色的外圈、翻出来的亮金属、放射状的划痕、中间一个黑洞，洞沿上一道高光。 */
  bullet_metal: {
    w: 128, h: 128, rough: 0.4, metal: 0.8, bleed: [96, 52, 40], scale: 1,
    draw(g, _w, _h, rng) {
      g.fillStyle = 'rgba(96,52,40,0.9)'; blob(g, 64, 64, 30, rng, 0.4, 11); g.fill();
      g.fillStyle = 'rgba(150,152,156,0.95)'; blob(g, 64, 64, 22, rng, 0.3, 12); g.fill();
      g.strokeStyle = 'rgba(205,207,210,0.9)'; g.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const a = rng() * 7, rx = 16 + rng() * 10, ry = 16 + rng() * 10;
        g.beginPath(); g.moveTo(64 + Math.cos(a) * 9, 64 + Math.sin(a) * 9); g.lineTo(64 + Math.cos(a) * rx, 64 + Math.sin(a) * ry); g.stroke();
      }
      const hole = g.createRadialGradient(64, 64, 2, 64, 64, 12);
      hole.addColorStop(0, 'rgba(4,4,5,1)'); hole.addColorStop(0.75, 'rgba(10,10,12,1)'); hole.addColorStop(1, 'rgba(70,72,76,0.9)');
      g.fillStyle = hole; blob(g, 64, 64, 12, rng, 0.15, 12); g.fill();
      g.strokeStyle = 'rgba(230,232,235,0.85)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(64, 64, 12.5, 3.6, 5.6); g.stroke();
    },
  },
  /** 打在混凝土上：一圈粉尘晕、崩掉的浅坑、中间的深坑、几道裂纹、溅出来的碎屑。 */
  bullet_concrete: {
    w: 128, h: 128, rough: 0.95, bleed: [168, 164, 154], scale: 1,
    draw(g, w, h, rng) {
      const dust = g.createRadialGradient(64, 64, 20, 64, 64, 60);
      dust.addColorStop(0, 'rgba(176,172,162,0.5)'); dust.addColorStop(1, 'rgba(176,172,162,0)');
      g.fillStyle = dust; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(168,164,154,0.95)'; blob(g, 64, 64, 32, rng, 0.35, 13); g.fill();
      g.fillStyle = 'rgba(120,116,108,0.95)'; blob(g, 65, 66, 20, rng, 0.35, 11); g.fill();
      g.strokeStyle = 'rgba(40,38,36,0.8)'; g.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        let a = rng() * 7, x = 64 + Math.cos(a) * 14, y = 64 + Math.sin(a) * 14;
        g.beginPath(); g.moveTo(x, y);
        for (let s = 0; s < 5; s++) { a += (rng() - 0.5) * 0.9; x += Math.cos(a) * 8; y += Math.sin(a) * 8; g.lineTo(x, y); }
        g.stroke();
      }
      const pit = g.createRadialGradient(64, 64, 1, 64, 64, 11);
      pit.addColorStop(0, 'rgba(18,17,16,1)'); pit.addColorStop(1, 'rgba(60,58,54,0.95)');
      g.fillStyle = pit; blob(g, 64, 64, 10, rng, 0.3, 9); g.fill();
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(${rng() < 0.5 ? '90,86,80' : '190,186,176'},0.8)`;
        const a = rng() * 7, d = 10 + rng() * 24;
        const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d;
        g.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 2);
      }
    },
  },

  // ---------------------------------------------------------------- 其他
  /** 涂鸦签名：四组手写的弧线笔画（每组先描一遍粗而淡的"喷雾晕"，再描实线），下划线，往下流的漆，周围的喷点。 */
  graffiti_tag: {
    w: 384, h: 256, rough: 0.6, bleed: [206, 214, 208],
    draw(g, w, h, rng) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      const paint = 'rgba(206,214,208,0.92)';
      // 一笔：起点之后每两个点一组 —— 控制点、落点 —— 连成一串光滑的弧
      const stroke = (pts: number[][], width: number, color: string) => {
        g.strokeStyle = color; g.lineWidth = width;
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i += 2) g.quadraticCurveTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        g.stroke();
      };
      const letters = [
        [[40, 60], [36, 130], [48, 200], [70, 150], [44, 128], [80, 110], [104, 70]],
        [[104, 70], [76, 140], [108, 190], [150, 200], [150, 110], [140, 60], [112, 84]],
        [[168, 196], [172, 120], [186, 62], [200, 110], [226, 92], [214, 150], [236, 196]],
        [[250, 76], [300, 60], [318, 66], [282, 110], [262, 178], [300, 200], [334, 176]],
      ];
      for (const pts of letters) { stroke(pts, 12, 'rgba(206,214,208,0.25)'); stroke(pts, 7, paint); }
      stroke([[30, 222], [180, 236], [352, 206]], 5, paint);
      stroke([[330, 40], [344, 30], [356, 44]], 5, paint);
      for (let i = 0; i < 7; i++) { // 喷得太厚的地方，漆往下流
        const x = 50 + rng() * 290, y = 150 + rng() * 50, len = 12 + rng() * 46;
        drip(g, x, y, 2 + rng() * 2, len, [[0, paint], [1, 'rgba(206,214,208,0)']]);
      }
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `rgba(206,214,208,${rng() * 0.5})`;
        const x = 30 + rng() * 330, y = 40 + rng() * 190;
        g.fillRect(x, y, 1.2, 1.2);
      }
      distress(g, w, h, 0.25, rng);
    },
  },
  /** 集装箱门上的金属铭牌：拉丝的金属底、四角铆钉、一行标题和七行数据，表面有些锈点。字很小，所以画得比别的贴纸大。 */
  csc_plate: {
    w: 288, h: 200, rough: 0.45, metal: 0.75, scale: 1.25,
    draw(g, w, h, rng) {
      const metal = g.createLinearGradient(0, 0, w, h);
      metal.addColorStop(0, 'rgb(150,152,150)'); metal.addColorStop(0.5, 'rgb(176,178,176)'); metal.addColorStop(1, 'rgb(138,140,138)');
      g.fillStyle = metal;
      g.beginPath(); g.roundRect(3, 3, w - 6, h - 6, 8); g.fill();
      g.strokeStyle = 'rgba(40,42,44,0.8)'; g.lineWidth = 2; g.strokeRect(11, 11, w - 22, h - 22);
      for (const [x, y] of [[20, 20], [w - 20, 20], [20, h - 20], [w - 20, h - 20]]) {
        g.fillStyle = 'rgb(96,98,98)'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
        g.fillStyle = 'rgba(230,232,232,0.7)'; g.beginPath(); g.arc(x - 1.2, y - 1.2, 2, 0, 7); g.fill(); // 铆钉头上的一点高光
      }
      const ink = 'rgba(28,30,32,0.92)';
      drawText(g, '安全检验铭牌', w / 2, 46, 19, ink, { font: 'sans', weight: 600, align: 'center', spacing: 1.5, maxW: w - 60 });
      const rows = ['检验编号 JZ/PA-4207/19', '制造日期 2019年03月', '设备编号 JZTU 402719 6', '最大总重 30 480 千克', '堆码载荷 192 000 千克', '横向试验 150 千牛', '下次检验 2027年09月'];
      rows.forEach((row, i) => {
        drawText(g, row, 30, 70 + i * 16.5, 11, ink, { font: 'mono', weight: 500, spacing: 0, maxW: w - 60 });
        g.fillStyle = 'rgba(28,30,32,0.35)'; g.fillRect(30, 73 + i * 16.5, w - 60, 1);
      });
      g.fillStyle = 'rgba(60,40,24,0.25)';
      for (let i = 0; i < 30; i++) { const x = rng() * w, y = rng() * h, r = 2 + rng() * 9; blob(g, x, y, r, rng, 0.5, 7); g.fill(); }
    },
  },
};
