const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Normalize longitude into [-180, 180). */
export function normalizeLon(lon) {
  if (!Number.isFinite(lon)) return 0;
  let norm = ((lon + 180) % 360 + 360) % 360 - 180;
  if (Object.is(norm, -0) || norm >= 180) norm = -180;
  return norm;
}

/** Great-circle distance in kilometers between two WGS84 points. */
export function haversineKm(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLam = normalizeLon(lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_KM * c;
}

/** Generate intermediate great-circle [lon, lat] points from a to b. */
export function greatCirclePoints(a, b, steps = 16) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const p1 = lat1 * DEG_TO_RAD;
  const l1 = normalizeLon(lon1) * DEG_TO_RAD;
  const p2 = lat2 * DEG_TO_RAD;
  const l2 = normalizeLon(lon2) * DEG_TO_RAD;

  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((p2 - p1) / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2
        )
      )
    );
  if (d < 1e-7) {
    return [
      [+normalizeLon(lon1).toFixed(4), +lat1.toFixed(4)],
      [+normalizeLon(lon2).toFixed(4), +lat2.toFixed(4)],
    ];
  }
  const sinD = Math.sin(d);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / sinD;
    const B = Math.sin(f * d) / sinD;
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD_TO_DEG;
    const lon = normalizeLon(Math.atan2(y, x) * RAD_TO_DEG);
    out.push([+lon.toFixed(4), +lat.toFixed(4)]);
  }
  return out;
}

/** Check if a point [lon, lat] falls inside an axis-aligned lon/lat box. */
export function pointInBox(point, box) {
  const lon = normalizeLon(point[0]);
  const lat = point[1];
  return (
    lon >= box.minLon &&
    lon <= box.maxLon &&
    lat >= box.minLat &&
    lat <= box.maxLat
  );
}

/** Check if a great-circle flight leg between two coords crosses any bounding box. */
export function greatCircleIntersectsBoxes(a, b, boxes = []) {
  if (!boxes.length) return false;
  const pts = greatCirclePoints(a, b, 28);
  return pts.some((pt) => boxes.some((box) => pointInBox(pt, box)));
}

/** Unwrap consecutive longitudes in a polygon ring so antimeridian-crossing rings stay continuous. */
export function unwrapRingLons(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return [];
  const out = [[ring[0][0], ring[0][1]]];
  let prevLon = ring[0][0];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([lon, ring[i][1]]);
    prevLon = lon;
  }
  return out;
}

/** Ray-casting point-in-ring test on an unwrapped [lon, lat] ring. */
export function pointInRing(point, ring) {
  if (!ring || ring.length < 3) return false;
  const lat = point[1];
  const baseLon = normalizeLon(point[0]);
  for (const shift of [0, 360, -360]) {
    const lon = baseLon + shift;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat)) {
        const xIntersect = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (lon < xIntersect) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Precompile polygon rings with bounding boxes for fast point-in-polygon tests. */
export function compilePolygonRings(polygons = []) {
  const compiled = [];
  for (const rawRing of polygons) {
    const ring = unwrapRingLons(rawRing);
    if (ring.length < 3) continue;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    compiled.push({ ring, minLon, maxLon, minLat, maxLat });
  }
  return compiled;
}

/** Check if a [lon, lat] point lies inside any compiled polygon ring. */
export function pointInCompiledRings(point, compiledRings) {
  if (!compiledRings?.length) return false;
  const lat = point[1];
  const baseLon = normalizeLon(point[0]);
  for (const item of compiledRings) {
    if (lat < item.minLat || lat > item.maxLat) continue;
    const inLonBounds =
      (baseLon >= item.minLon && baseLon <= item.maxLon) ||
      (baseLon + 360 >= item.minLon && baseLon + 360 <= item.maxLon) ||
      (baseLon - 360 >= item.minLon && baseLon - 360 <= item.maxLon);
    if (!inLonBounds) continue;
    if (pointInRing(point, item.ring)) return true;
  }
  return false;
}

/** Reduce a polyline to at most maxPoints while keeping start and end exact. */
export function decimateCoords(coords, maxPoints = 6) {
  if (!Array.isArray(coords) || coords.length <= maxPoints) {
    return coords;
  }
  const out = [coords[0]];
  const step = (coords.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    out.push(coords[Math.round(i * step)]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}
