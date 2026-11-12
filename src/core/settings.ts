export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export interface Settings {
  quality: Quality;
  sensitivity: number;
  invertY: boolean;
  volume: number;
  fov: number;
}
export const QUALITY_LABEL: Record<Quality, string> = { low: '低', medium: '中', high: '高', ultra: '极高' };

/**
 * 一档画质都开了什么：
 *   tier       0..3，对应低 / 中 / 高 / 极高（内部分辨率的像素预算按它取）
 *   shadow     阴影图边长；msaa 多重采样数
 *   ao         环境光遮蔽的采样数，0 关；volSteps 体积光每条视线走几步，0 关
 *   reflect    地面反射贴图相对屏幕的分辨率比例，0 关
 */
export interface QualityProfile { tier: 0 | 1 | 2 | 3; pixelRatio: number; shadow: number; msaa: number; ao: number; volSteps: number; bloom: boolean; rain: number; lamps: number; reflect: number }
export function profileOf(q: Quality): QualityProfile {
  const dpr = window.devicePixelRatio || 1;
  switch (q) {
    case 'low': return { tier: 0, pixelRatio: Math.min(dpr, 1) * 0.7, shadow: 1024, msaa: 0, ao: 0, volSteps: 8, bloom: true, rain: 3000, lamps: 2, reflect: 0 };
    case 'medium': return { tier: 1, pixelRatio: Math.min(dpr, 1), shadow: 2048, msaa: 2, ao: 8, volSteps: 12, bloom: true, rain: 5500, lamps: 4, reflect: 0.35 };
    case 'high': return { tier: 2, pixelRatio: Math.min(dpr, 1.5), shadow: 2048, msaa: 4, ao: 12, volSteps: 16, bloom: true, rain: 8000, lamps: 6, reflect: 0.5 };
    case 'ultra': return { tier: 3, pixelRatio: Math.min(dpr, 2), shadow: 4096, msaa: 4, ao: 16, volSteps: 24, bloom: true, rain: 9000, lamps: 8, reflect: 0.75 };
  }
}

const KEY = 'jizhan-settings-v1';
export function autoQuality(): Quality {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile) return cores >= 8 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}
export function loadSettings(): { settings: Settings; auto: boolean } {
  const def: Settings = { quality: autoQuality(), sensitivity: 1, invertY: false, volume: 0.8, fov: 75 };
  const forced = new URLSearchParams(location.search).get('q') as Quality | null;
  let auto = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { Object.assign(def, JSON.parse(raw)); auto = false; }
  } catch { /* 隐私模式下 localStorage 可能不可用，用默认值即可 */ }
  if (forced && forced in QUALITY_LABEL) { def.quality = forced; auto = false; }
  return { settings: def, auto };
}
export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 同上 */ }
}
