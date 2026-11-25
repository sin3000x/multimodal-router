import { decimateCoords, haversineKm, normalizeLon } from './geo.mjs';
import { borderPenalty } from './cost-model.mjs';
import { crossesOpenSea } from './land-mask.mjs';

class MinHeap {
  constructor() {
    this.heap = [];
  }
  get size() {
    return this.heap.length;
  }
  clear() {
    this.heap.length = 0;
  }
  push(item) {
    this.heap.push(item);
    let idx = this.heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.heap[parent].f <= this.heap[idx].f) break;
      [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
      idx = parent;
    }
  }
  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let idx = 0;
      const len = this.heap.length;
      while (true) {
        let smallest = idx;
        const left = idx * 2 + 1;
        const right = idx * 2 + 2;
        if (left < len && this.heap[left].f < this.heap[smallest].f) smallest = left;
        if (right < len && this.heap[right].f < this.heap[smallest].f) smallest = right;
        if (smallest === idx) break;
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      }
    }
    return top;
  }
}

export function createRoadRouter(graph) {
  const vertices = graph?.roadnet?.vertices ?? [];
  const edges = graph?.roadnet?.edges ?? [];
  if (!vertices.length || !edges.length) {
    return { findRoadPath: () => null };
  }

  const V = vertices.length;
  const adjacency = Array.from({ length: V }, () => []);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    adjacency[edge.u].push({ to: edge.v, edgeId: i, reverse: false });
    adjacency[edge.v].push({ to: edge.u, edgeId: i, reverse: true });
  }

  // Spatial grid for on-the-fly snapping of custom coords or unsnapped nodes
  const cellDeg = 1.5;
  const numCols = Math.ceil(360 / cellDeg);
  const buckets = new Map();
  for (const v of vertices) {
    const cx = Math.floor((v.lon + 180) / cellDeg);
    const cy = Math.floor((v.lat + 90) / cellDeg);
    const key = `${cx},${cy}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }

  function snapPoint(lon, lat, maxKm = 90) {
    const nLon = normalizeLon(lon);
    const cx = Math.floor((nLon + 180) / cellDeg);
    const cy = Math.floor((lat + 90) / cellDeg);
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
      const wx = ((cx + dx) % numCols + numCols) % numCols;
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${wx},${cy + dy}`);
        if (!list) continue;
        for (const v of list) {
          const d = haversineKm(nLon, lat, v.lon, v.lat);
          if (d <= maxKm) candidates.push({ v, d });
        }
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const { v, d } of candidates) {
      if (!crossesOpenSea([nLon, lat], [v.lon, v.lat])) {
        return { id: v.id, snapKm: +d.toFixed(2) };
      }
    }
    return null;
  }

  // Reusable typed arrays for zero-allocation A*
  const gScore = new Float64Array(V);
  const prevVertex = new Int32Array(V);
  const prevEdge = new Int32Array(V);
  const prevDir = new Uint8Array(V);
  const closedStamp = new Uint32Array(V);
  const seenStamp = new Uint32Array(V);
  let currentStamp = 0;
  const heap = new MinHeap();

  function findRoadPath(fromNode, toNode, { maxRoadKm = 6500, includeGeometry = false } = {}) {
    if (!fromNode || !toNode) return null;
    const startSnap =
      fromNode.roadVertexId != null
        ? { id: fromNode.roadVertexId, snapKm: fromNode.roadSnapKm ?? 0 }
        : snapPoint(fromNode.lon, fromNode.lat, 90);
    const endSnap =
      toNode.roadVertexId != null
        ? { id: toNode.roadVertexId, snapKm: toNode.roadSnapKm ?? 0 }
        : snapPoint(toNode.lon, toNode.lat, 90);

    if (!startSnap || !endSnap) return null;
    const u0 = startSnap.id;
    const v0 = endSnap.id;

    if (vertices[u0]?.comp !== vertices[v0]?.comp) return null;

    if (u0 === v0) {
      const dist = +(startSnap.snapKm * 1.2 + endSnap.snapKm * 1.2).toFixed(1);
      if (dist > maxRoadKm) return null;
      const border = borderPenalty(fromNode.country, toNode.country);
      return {
        distanceKm: dist,
        border,
        coords: includeGeometry
          ? [[fromNode.lon, fromNode.lat], [vertices[u0].lon, vertices[u0].lat], [toNode.lon, toNode.lat]]
          : null,
      };
    }

    currentStamp++;
    if (currentStamp >= 0xffffffff) {
      closedStamp.fill(0);
      seenStamp.fill(0);
      currentStamp = 1;
    }
    const stamp = currentStamp;
    const endVert = vertices[v0];

    heap.clear();
    seenStamp[u0] = stamp;
    gScore[u0] = 0;
    prevVertex[u0] = -1;
    prevEdge[u0] = -1;
    heap.push({ v: u0, f: haversineKm(vertices[u0].lon, vertices[u0].lat, endVert.lon, endVert.lat) });

    let found = false;
    while (heap.size > 0) {
      const { v: u } = heap.pop();
      if (closedStamp[u] === stamp) continue;
      closedStamp[u] = stamp;
      if (u === v0) {
        found = true;
        break;
      }

      const gU = gScore[u];
      if (gU > maxRoadKm) continue;

      for (const adj of adjacency[u]) {
        if (closedStamp[adj.to] === stamp) continue;
        const edge = edges[adj.edgeId];
        const nextG = gU + edge.distanceKm;
        if (nextG > maxRoadKm) continue;

        if (seenStamp[adj.to] !== stamp || nextG < gScore[adj.to]) {
          seenStamp[adj.to] = stamp;
          gScore[adj.to] = nextG;
          prevVertex[adj.to] = u;
          prevEdge[adj.to] = adj.edgeId;
          prevDir[adj.to] = adj.reverse ? 1 : 0;
          const tv = vertices[adj.to];
          heap.push({
            v: adj.to,
            f: nextG + haversineKm(tv.lon, tv.lat, endVert.lon, endVert.lat),
          });
        }
      }
    }

    if (!found) return null;

    const steps = [];
    let curr = v0;
    while (curr !== u0) {
      const eId = prevEdge[curr];
      if (eId === -1) return null;
      steps.push({ edgeId: eId, reverse: prevDir[curr] === 1 });
      curr = prevVertex[curr];
    }
    steps.reverse();

    let roadDistanceKm = 0;
    const roadCoords = [];
    const border = { days: 0, cost: 0, reliabilityDrop: 0 };
    let prevCc = fromNode.country || '';

    for (const step of steps) {
      const edge = edges[step.edgeId];
      roadDistanceKm += edge.distanceKm;
      const edgeCc = edge.cc || '';
      if (edgeCc && prevCc && edgeCc !== prevCc) {
        const bp = borderPenalty(prevCc, edgeCc);
        border.days += bp.days;
        border.cost += bp.cost;
        border.reliabilityDrop += bp.reliabilityDrop;
      }
      if (edgeCc) prevCc = edgeCc;

      if (includeGeometry) {
        const seg = step.reverse ? [...edge.coords].reverse() : edge.coords;
        for (let i = 0; i < seg.length; i++) {
          if (roadCoords.length > 0 && i === 0) continue;
          roadCoords.push(seg[i]);
        }
      }
    }

    if (toNode.country && prevCc && toNode.country !== prevCc) {
      const bp = borderPenalty(prevCc, toNode.country);
      border.days += bp.days;
      border.cost += bp.cost;
      border.reliabilityDrop += bp.reliabilityDrop;
    }

    const totalKm = +(roadDistanceKm + startSnap.snapKm * 1.2 + endSnap.snapKm * 1.2).toFixed(1);
    if (totalKm > maxRoadKm) return null;

    let coords = null;
    if (includeGeometry) {
      const full = [[fromNode.lon, fromNode.lat], ...roadCoords, [toNode.lon, toNode.lat]];
      coords = decimateCoords(full, 90);
    }

    return { distanceKm: totalKm, border, coords };
  }

  return { findRoadPath };
}
