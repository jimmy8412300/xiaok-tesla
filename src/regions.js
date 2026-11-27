import { readFileSync } from 'node:fs';

export function loadRegions(path) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of list) {
    if (!r.name || typeof r.lat !== 'number' || typeof r.lng !== 'number') {
      throw new Error(`regions 設定錯誤：${JSON.stringify(r)}`);
    }
  }
  return list;
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// 「R 萬里區港東路152號 ⬇️基隆」：箭頭／下車之前是上車地點，之後是目的地
const ROUTE_SPLIT = /⬇️|⬇|↓|→|➡️|➡|下車|送到|送往|目的地/;

/**
 * 找出訊息提到哪些區域（依 regions.json 的 places 地名）。
 * @returns {{name:string, where:'pickup'|'drop'}[]}  上車點在該區 = pickup，只有目的地在該區 = drop
 */
export function matchPlaces(regions, text) {
  const idx = text.search(ROUTE_SPLIT);
  const pickup = idx >= 0 ? text.slice(0, idx) : text;
  const drop = idx >= 0 ? text.slice(idx) : '';
  const out = [];
  for (const r of regions) {
    const places = r.places ?? [r.name];
    if (places.some((p) => pickup.includes(p))) out.push({ name: r.name, where: 'pickup' });
    else if (places.some((p) => drop.includes(p))) out.push({ name: r.name, where: 'drop' });
  }
  return out;
}

/** 回傳最近的區域與距離；inside 表示是否在該區 radiusKm 範圍內 */
export function nearestRegion(regions, lat, lng) {
  let best = null;
  for (const region of regions) {
    const d = distanceKm(lat, lng, region.lat, region.lng);
    if (!best || d < best.distanceKm) best = { region, distanceKm: d };
  }
  if (best) best.inside = best.region.radiusKm == null || best.distanceKm <= best.region.radiusKm;
  return best;
}
