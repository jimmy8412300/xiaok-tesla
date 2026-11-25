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
