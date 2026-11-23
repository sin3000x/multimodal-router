import { haversineKm } from './geo.mjs';
import { scoreRoute } from './cost-model.mjs';

class MinHeap {
  constructor() {
    this.heap = [];
  }
  get size() {
    return this.heap.length;
  }
  push(item) {
    this.heap.push(item);
    let idx = this.heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.heap[parent].dist <= this.heap[idx].dist) break;
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
        if (left < len && this.heap[left].dist < this.heap[smallest].dist) smallest = left;
        if (right < len && this.heap[right].dist < this.heap[smallest].dist) smallest = right;
        if (smallest === idx) break;
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      }
    }
    return top;
  }
}

export function createSeaRouter(graph, landConnectionsByNode = new Map()) {
  const vertices = graph.marnet.vertices;
  const edges = graph.marnet.edges;
  const adjacency = Array.from({ length: vertices.length }, () => []);
  for (const edge of edges) {
    adjacency[edge.u].push({ to: edge.v, edgeId: edge.id, reverse: false });
    adjacency[edge.v].push({ to: edge.u, edgeId: edge.id, reverse: true });
  }

  const chokepointById = new Map(
    (graph.chokepoints?.passages ?? []).map((cp) => [cp.id, cp])
  );
  const coupledPassages = graph.chokepoints?.coupledPassages ?? {};
  const majorPassageIds = new Set(
    (graph.chokepoints?.passages ?? []).filter((cp) => cp.major).map((cp) => cp.id)
  );
  const ARCTIC_PASSAGES = new Set(['CP_NORTHWEST', 'CP_BERING']);
  const ports = graph.nodes.filter(
    (n) =>
      (n.type === 'port' || (n.type === 'city' && n.functions?.includes('port'))) &&
      n.marnetVertexId != null
  );
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  function shortestVertexPath(startV, endV, blockedPassages = new Set(), penaltyEdges = null) {
    if (startV === endV) {
      const v = vertices[startV];
      return { distanceKm: 0, edgeIds: [], passages: [], coords: [[v.lon, v.lat]] };
    }

    const n = vertices.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevVertex = new Int32Array(n).fill(-1);
    const prevEdge = new Int32Array(n).fill(-1);
    const prevDir = new Uint8Array(n); // 0 = forward (u->v), 1 = reverse (v->u)
    const visited = new Uint8Array(n);

    dist[startV] = 0;
    const heap = new MinHeap();
    heap.push({ v: startV, dist: 0 });

    while (heap.size > 0) {
      const { v: u, dist: d } = heap.pop();
      if (visited[u]) continue;
      visited[u] = 1;
      if (u === endV) break;

      for (const adj of adjacency[u]) {
        if (visited[adj.to]) continue;
        const edge = edges[adj.edgeId];
        if (edge.passage && blockedPassages.has(edge.passage)) continue;

        const penalty = penaltyEdges?.get(edge.id) ?? 1;
        const nextDist = d + edge.distanceKm * penalty;
        if (nextDist < dist[adj.to]) {
          dist[adj.to] = nextDist;
          prevVertex[adj.to] = u;
          prevEdge[adj.to] = adj.edgeId;
          prevDir[adj.to] = adj.reverse ? 1 : 0;
          heap.push({ v: adj.to, dist: nextDist });
        }
      }
    }

    if (!Number.isFinite(dist[endV])) return null;

    const edgeSteps = [];
    let curr = endV;
    while (curr !== startV) {
      const eId = prevEdge[curr];
      if (eId === -1) return null;
      edgeSteps.push({ edgeId: eId, reverse: prevDir[curr] === 1 });
      curr = prevVertex[curr];
    }
    edgeSteps.reverse();

    let trueDistanceKm = 0;
    const passages = [];
    const seenPassages = new Set();
    const coords = [];

    for (const step of edgeSteps) {
      const edge = edges[step.edgeId];
      trueDistanceKm += edge.distanceKm;
      if (edge.passage && !seenPassages.has(edge.passage)) {
        seenPassages.add(edge.passage);
        passages.push(edge.passage);
      }
      const segCoords = step.reverse ? [...edge.coords].reverse() : edge.coords;
      for (let i = 0; i < segCoords.length; i++) {
        if (coords.length > 0 && i === 0) continue;
        coords.push(segCoords[i]);
      }
    }

    return {
      distanceKm: +trueDistanceKm.toFixed(1),
      edgeIds: edgeSteps.map((s) => s.edgeId),
      passages,
      coords,
    };
  }

  function selectGatewayPorts(node, { maxDistanceKm = 260, limit = 4 } = {}) {
    if (node.type === 'port' && node.marnetVertexId != null) {
      return [{ port: node, drayageKm: 0, viaCorridor: null, preferred: true }];
    }

    const candidates = new Map();

    // 1. Explicitly modeled inland-to-port corridors (can exceed 260 km, e.g. Riyadh <-> Jeddah/Dammam)
    for (const edge of landConnectionsByNode.get(node.id) ?? []) {
      const target = nodeById.get(edge.to);
      if (
        (target?.type === 'port' || (target?.type === 'city' && target?.isCuratedPort)) &&
        target.marnetVertexId != null
      ) {
        candidates.set(target.id, {
          port: target,
          drayageKm: edge.distanceKm,
          drayageMode: edge.mode,
          viaCorridor: edge.corridor,
          preferred: true,
        });
      }
    }

    // 2. Nearby snapped maritime ports deduplicated by MARNET vertex
    const nearby = [];
    for (const port of ports) {
      if (candidates.has(port.id)) continue;
      const d = haversineKm(node.lon, node.lat, port.lon, port.lat);
      if (d <= maxDistanceKm) {
        const isContainerPort = port.isCuratedPort || port.isHub;
        const score =
          d -
          (isContainerPort ? 160 : 0) -
          (port.isMajor ? 80 : 0) -
          (port.type === 'port' ? 20 : 0);
        nearby.push({ port, drayageKm: +d.toFixed(1), score });
      }
    }
    nearby.sort((a, b) => a.score - b.score);

    const seenVertices = new Set(
      [...candidates.values()].map((c) => c.port.marnetVertexId)
    );
    const out = [...candidates.values()];

    for (const item of nearby) {
      if (out.length >= limit) break;
      const vId = item.port.marnetVertexId;
      if (seenVertices.has(vId)) continue;
      // Skip specialized offshore petroleum platforms unless nothing else exists
      if (/petroleum|lpg|terminal/i.test(item.port.name_en) && !item.port.curated && out.length > 0) {
        continue;
      }
      seenVertices.add(vId);
      out.push({
        port: item.port,
        drayageKm: item.drayageKm,
        drayageMode: 'road',
        viaCorridor: null,
        preferred: Boolean(item.port.curated || item.port.isMajor),
      });
    }

    // Fallback: if landlocked and no corridor/nearby port, widen search to 900 km major ports
    if (out.length === 0) {
      const fallback = [];
      for (const port of ports) {
        if (!port.isMajor && !port.curated) continue;
        const d = haversineKm(node.lon, node.lat, port.lon, port.lat);
        if (d <= 900) fallback.push({ port, drayageKm: +d.toFixed(1) });
      }
      fallback.sort((a, b) => a.drayageKm - b.drayageKm);
      for (const item of fallback.slice(0, 2)) {
        out.push({
          port: item.port,
          drayageKm: item.drayageKm,
          drayageMode: 'road',
          viaCorridor: null,
          preferred: false,
        });
      }
    }

    return out;
  }

  function buildSeaCandidate(originNode, destNode, og, dg, pathResult, { includeGeometry, isPrimary }) {
    const legs = [];
    if (og.port.id !== originNode.id) {
      legs.push({
        kind: 'drayage',
        mode: og.drayageMode || 'road',
        from: originNode.id,
        fromName: originNode.name_zh || originNode.name_en,
        to: og.port.id,
        toName: og.port.name_zh || og.port.name_en,
        corridor: og.viaCorridor || '集港短驳',
        distanceKm: og.drayageKm,
        ...(includeGeometry && {
          geometry: [
            [originNode.lon, originNode.lat],
            [og.port.lon, og.port.lat],
          ],
        }),
      });
    }

    legs.push({
      kind: 'trunk',
      mode: 'sea',
      from: og.port.id,
      fromName: og.port.name_zh || og.port.name_en,
      to: dg.port.id,
      toName: dg.port.name_zh || dg.port.name_en,
      distanceKm: pathResult.distanceKm,
      passages: pathResult.passages,
      ...(includeGeometry && {
        geometry: [
          [og.port.lon, og.port.lat],
          ...pathResult.coords,
          [dg.port.lon, dg.port.lat],
        ],
      }),
    });

    if (dg.port.id !== destNode.id) {
      legs.push({
        kind: 'drayage',
        mode: dg.drayageMode || 'road',
        from: dg.port.id,
        fromName: dg.port.name_zh || dg.port.name_en,
        to: destNode.id,
        toName: destNode.name_zh || destNode.name_en,
        corridor: dg.viaCorridor || '疏港短驳',
        distanceKm: dg.drayageKm,
        ...(includeGeometry && {
          geometry: [
            [dg.port.lon, dg.port.lat],
            [destNode.lon, destNode.lat],
          ],
        }),
      });
    }

    const chokepoints = pathResult.passages.map((cpId) => {
      const cp = chokepointById.get(cpId);
      return {
        id: cpId,
        name_zh: cp?.name_zh ?? cpId,
        name_en: cp?.name_en ?? cpId,
        major: Boolean(cp?.major),
      };
    });

    const nodeSequence = [];
    for (const leg of legs) {
      if (!nodeSequence.length) nodeSequence.push(leg.from);
      if (leg.kind === 'trunk' && leg.passages?.length) {
        for (const cp of leg.passages) nodeSequence.push(cp);
      }
      nodeSequence.push(leg.to);
    }

    const metrics = scoreRoute('sea', legs, { chokepointCount: chokepoints.length });
    const sigPassages = [...pathResult.passages].sort().join(',');
    const signature = `sea:${og.port.id}:${dg.port.id}:${sigPassages}`;

    return {
      mode: 'sea',
      modeLabel: '海运',
      likelihood: isPrimary ? 'primary' : 'alternative',
      originGateway: { id: og.port.id, name: og.port.name_zh || og.port.name_en, code: og.port.code ?? null },
      destGateway: { id: dg.port.id, name: dg.port.name_zh || dg.port.name_en, code: dg.port.code ?? null },
      chokepoints,
      nodeSequence,
      legs,
      metrics,
      signature,
    };
  }

  return function routeSea(
    originNode,
    destNode,
    { avoidSet = new Set(), includeGeometry = false, allowArctic = false } = {}
  ) {
    const originGateways = selectGatewayPorts(originNode, { maxDistanceKm: 180, limit: 2 });
    const destGateways = selectGatewayPorts(destNode, { maxDistanceKm: 220, limit: 4 });
    if (!originGateways.length || !destGateways.length) return [];

    // Expand coupled chokepoints if user blocked Suez or Bab-el-Mandeb
    const expandedBlocked = new Set(avoidSet);
    if (!allowArctic) {
      for (const arctic of ARCTIC_PASSAGES) expandedBlocked.add(arctic);
    }
    for (const id of avoidSet) {
      for (const c of coupledPassages[id] ?? []) expandedBlocked.add(c);
    }

    const candidates = [];

    // 1. Evaluate primary & secondary gateway combinations
    const primaryOg = originGateways[0];
    let bestBaselineDist = Infinity;

    for (let oi = 0; oi < originGateways.length; oi++) {
      const og = originGateways[oi];
      for (let di = 0; di < destGateways.length; di++) {
        const dg = destGateways[di];
        // Limit cross-product to primary origin x all dest gateways, plus secondary origin x primary dest gateway
        if (oi > 0 && di > 0) continue;

        const basePath = shortestVertexPath(
          og.port.marnetVertexId,
          dg.port.marnetVertexId,
          expandedBlocked
        );
        if (!basePath) continue;

        const totalSeaPlusDray = basePath.distanceKm + og.drayageKm + dg.drayageKm;
        if (totalSeaPlusDray < bestBaselineDist) bestBaselineDist = totalSeaPlusDray;

        const isPrimary = oi === 0 && totalSeaPlusDray <= bestBaselineDist * 1.15;
        candidates.push({
          ogPort: og.port,
          dgPort: dg.port,
          cpSig: [...basePath.passages].sort().join(','),
          candidate: buildSeaCandidate(originNode, destNode, og, dg, basePath, {
            includeGeometry,
            isPrimary,
          }),
        });

        // 2. Chokepoint ablation on primary origin/dest corridor to generate real strategic detours
        if (oi === 0 && di === 0) {
          const majorCrossed = basePath.passages.filter((cp) => majorPassageIds.has(cp));
          for (const cp of majorCrossed) {
            if (cp === 'CP_CAPE' && expandedBlocked.has('CP_SUEZ')) continue;
            const ablated = new Set(expandedBlocked);
            ablated.add(cp);
            for (const c of coupledPassages[cp] ?? []) ablated.add(c);

            const detourPath = shortestVertexPath(
              og.port.marnetVertexId,
              dg.port.marnetVertexId,
              ablated
            );
            if (!detourPath) continue;
            // Ignore pointless detours that double back excessively (> 2.4x baseline)
            if (detourPath.distanceKm > basePath.distanceKm * 2.4) continue;

            const detourCandidate = buildSeaCandidate(originNode, destNode, og, dg, detourPath, {
              includeGeometry,
              isPrimary: false,
            });
            detourCandidate.detourReason = `绕避${chokepointById.get(cp)?.name_zh ?? cp}`;
            candidates.push({
              ogPort: og.port,
              dgPort: dg.port,
              cpSig: [...detourPath.passages].sort().join(','),
              candidate: detourCandidate,
            });
          }
        }
      }
    }

    // Sort fastest first, then deduplicate routes that share the exact same chokepoints AND same metro port clusters (< 150 km)
    candidates.sort(
      (a, b) =>
        a.candidate.metrics.transitDays - b.candidate.metrics.transitDays ||
        a.candidate.metrics.distanceKm - b.candidate.metrics.distanceKm
    );

    const kept = [];
    for (const item of candidates) {
      const duplicateMetro = kept.some(
        (k) =>
          k.cpSig === item.cpSig &&
          haversineKm(k.ogPort.lon, k.ogPort.lat, item.ogPort.lon, item.ogPort.lat) < 150 &&
          haversineKm(k.dgPort.lon, k.dgPort.lat, item.dgPort.lon, item.dgPort.lat) < 150
      );
      if (!duplicateMetro) kept.push(item);
    }

    const list = kept.map((k) => k.candidate);
    if (list.length > 0) {
      const minDays = list[0].metrics.transitDays;
      for (let i = 0; i < list.length; i++) {
        list[i].likelihood = i === 0 || list[i].metrics.transitDays <= minDays + 1.5 ? 'primary' : 'alternative';
      }
    }

    return list;
  };
}
