import { readFileSync } from 'node:fs';
import { haversineKm, normalizeLon } from './geo.mjs';

const countriesGeo = JSON.parse(
  readFileSync(new URL('../../public/countries.geojson', import.meta.url), 'utf8')
);

const POLYGONS = [];
for (const feature of countriesGeo.features ?? []) {
  const geom = feature?.geometry;
  if (!geom) continue;
  const polyList =
    geom.type === 'Polygon'
      ? [geom.coordinates]
      : geom.type === 'MultiPolygon'
        ? geom.coordinates
        : [];
  for (const poly of polyList) {
    const outer = poly?.[0];
    if (!outer?.length) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    POLYGONS.push({
      outer,
      holes: poly.slice(1),
      minX,
      maxX,
      minY,
      maxY,
    });
  }
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegmentKm(lon, lat, a, b) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dx = (b[0] - a[0]) * cosLat;
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq
    ? Math.max(0, Math.min(1, (((lon - a[0]) * cosLat) * dx + (lat - a[1]) * dy) / lenSq))
    : 0;
  return haversineKm(lon, lat, a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
}

export function isOnLand(lon, lat) {
  const normLon = normalizeLon(lon);
  for (const p of POLYGONS) {
    if (normLon < p.minX || normLon > p.maxX || lat < p.minY || lat > p.maxY) continue;
    if (!pointInRing(normLon, lat, p.outer)) continue;
    let inHole = false;
    for (const hole of p.holes) {
      if (pointInRing(normLon, lat, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function distToLandKm(lon, lat) {
  const normLon = normalizeLon(lon);
  if (isOnLand(normLon, lat)) return 0;

  for (const padDeg of [1.5, 5]) {
    let best = Infinity;
    for (const p of POLYGONS) {
      if (
        normLon < p.minX - padDeg ||
        normLon > p.maxX + padDeg ||
        lat < p.minY - padDeg ||
        lat > p.maxY + padDeg
      ) {
        continue;
      }
      const ring = p.outer;
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distToSegmentKm(normLon, lat, ring[i], ring[i + 1]);
        if (d < best) best = d;
      }
    }
    if (Number.isFinite(best)) return best;
  }
  return Infinity;
}

export function crossesOpenSea(
  a,
  b,
  { minDirectKm = 45, maxOffshoreKm = 25, bayMinKm = 80, bayWaterRatio = 0.75, bayOffshoreKm = 15 } = {}
) {
  const distKm = haversineKm(a[0], a[1], b[0], b[1]);
  if (distKm <= minDirectKm) return false;

  let bLon = b[0];
  if (bLon - a[0] > 180) bLon -= 360;
  else if (bLon - a[0] < -180) bLon += 360;

  const samples = Math.min(15, Math.max(7, Math.ceil(distKm / 20)));
  let waterPts = 0;
  let maxOffshore = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / (samples + 1);
    const lon = normalizeLon(a[0] + (bLon - a[0]) * t);
    const lat = a[1] + (b[1] - a[1]) * t;
    const d = distToLandKm(lon, lat);
    if (d > maxOffshoreKm) return true;
    if (d > 0) waterPts++;
    if (d > maxOffshore) maxOffshore = d;
  }
  return distKm > bayMinKm && waterPts / samples >= bayWaterRatio && maxOffshore > bayOffshoreKm;
}
