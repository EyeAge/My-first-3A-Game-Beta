export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export interface Settings {
  quality: Quality;
  sensitivity: number;
  invertY: boolean;
  volume: number;
  fov: number;
}
export const QUALITY_LABEL: Record<Quality, string> = { low: '低', medium: '中', high: '高', ultra: '极高' };

export interface QualityProfile { pixelRatio: number; shadow: number; bloom: boolean; rain: number; lamps: number }
export function profileOf(q: Quality): QualityProfile {
  const dpr = window.devicePixelRatio || 1;
  switch (q) {
    case 'low': return { pixelRatio: Math.min(dpr, 1) * 0.7, shadow: 0, bloom: false, rain: 500, lamps: 2 };
    case 'medium': return { pixelRatio: Math.min(dpr, 1), shadow: 1024, bloom: true, rain: 1200, lamps: 4 };
    case 'high': return { pixelRatio: Math.min(dpr, 1.5), shadow: 2048, bloom: true, rain: 2000, lamps: 6 };
    case 'ultra': return { pixelRatio: Math.min(dpr, 2), shadow: 4096, bloom: true, rain: 2600, lamps: 8 };
  }
}

const KEY = 'jimao-3a-settings-v1';
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
