import { haversineKm } from './geo.mjs';
import { borderPenalty, scoreRoute } from './cost-model.mjs';
import { crossesOpenSea } from './land-mask.mjs';
import { createRoadRouter } from './road-router.mjs';

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

const ROAD_CIRCUITY = 1.25;

export function createSeaRouter(graph, landConnectionsByNode = new Map(), portGroups = {}) {
  const { findRoadPath } = createRoadRouter(graph);
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

  function portTierOf(port) {
    return port.portTier ?? (port.isHub ? 2 : 3);
  }

  function gatewayRankScore(straightKm, port, isHomePort) {
    const tier = portTierOf(port);
    const tierBonus = tier === 1 ? 170 : tier === 2 ? 105 : port.isMajor ? 60 : 0;
    return (
      straightKm -
      (isHomePort ? 220 : 0) -
      tierBonus -
      (port.isCuratedPort ? 35 : 0) -
      (port.type === 'port' ? 20 : 0)
    );
  }

  function findCorridorPorts(startNode, maxCorridorKm = 2400) {
    const dist = new Map([[startNode.id, 0]]);
    const prev = new Map();
    const visited = new Set();
    const heap = new MinHeap();
    heap.push({ v: startNode.id, dist: 0 });
    const reached = [];

    while (heap.size > 0) {
      const { v: u, dist: d } = heap.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      const uNode = nodeById.get(u);
      if (
        u !== startNode.id &&
        (uNode?.type === 'port' || (uNode?.type === 'city' && uNode?.isCuratedPort)) &&
        uNode.marnetVertexId != null
      ) {
        reached.push({ port: uNode, totalKm: +d.toFixed(1) });
        continue;
      }
      if (d >= maxCorridorKm) continue;

      for (const edge of landConnectionsByNode.get(u) ?? []) {
        if (visited.has(edge.to)) continue;
        const nd = d + edge.distanceKm;
        if (nd <= maxCorridorKm && nd < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, { from: u, edge });
          heap.push({ v: edge.to, dist: nd });
        }
      }
    }

    return reached.map(({ port, totalKm }) => {
      const edgesPath = [];
      let curr = port.id;
      while (curr !== startNode.id) {
        const step = prev.get(curr);
        if (!step) break;
        edgesPath.push(step.edge);
        curr = step.from;
      }
      edgesPath.reverse();

      let railKm = 0;
      const drayageCoords = [];
      const border = { days: 0, cost: 0, reliabilityDrop: 0 };
      for (const edge of edgesPath) {
        if (edge.mode === 'rail') railKm += edge.distanceKm;
        const fn = nodeById.get(edge.from);
        const tn = nodeById.get(edge.to);
        if (edge.mode === 'road' && fn?.country && tn?.country && fn.country !== tn.country) {
          const bp = borderPenalty(fn.country, tn.country);
          border.days += bp.days;
          border.cost += bp.cost;
          border.reliabilityDrop += bp.reliabilityDrop;
        }
        const pts = edge.coords
          ? edge.coords
          : fn && tn
            ? [[fn.lon, fn.lat], [tn.lon, tn.lat]]
            : [];
        for (let i = 0; i < pts.length; i++) {
          if (drayageCoords.length > 0 && i === 0) continue;
          drayageCoords.push(pts[i]);
        }
      }

      const drayageMode = railKm >= totalKm * 0.5 ? 'rail' : 'road';
      return {
        port,
        drayageKm: totalKm,
        drayageMode,
        viaCorridor: edgesPath.map((e) => e.corridor).filter(Boolean).join(' / ') || null,
        drayageCoords: drayageCoords.length >= 2 ? drayageCoords : null,
        border,
        preferred: true,
        isHomePort: false,
        isRemoteAlternate: drayageMode !== 'rail' && totalKm > 60,
        score: gatewayRankScore(totalKm, port, false) - (drayageMode === 'rail' ? 60 : 0),
      };
    });
  }

  function selectGatewayPorts(node, { maxDistanceKm = 260, limit = 4 } = {}) {
    if (node.type === 'port' && node.marnetVertexId != null) {
      return [
        {
          port: node,
          drayageKm: 0,
          viaCorridor: null,
          preferred: true,
          isHomePort: true,
          isRemoteAlternate: false,
        },
      ];
    }

    const homePortIds = new Set(portGroups[node.id]?.ports ?? []);
    const candidates = new Map();

    // 1. Explicitly modeled inland-to-port corridors (can exceed 260 km, e.g. Riyadh <-> Jeddah/Dammam)
    for (const edge of landConnectionsByNode.get(node.id) ?? []) {
      const target = nodeById.get(edge.to);
      if (
        (target?.type === 'port' || (target?.type === 'city' && target?.isCuratedPort)) &&
        target.marnetVertexId != null
      ) {
        const isHomePort =
          homePortIds.has(target.id) ||
          (target.id === node.id && Boolean(target.isCuratedPort || target.isHub));
        const straightKm = haversineKm(node.lon, node.lat, target.lon, target.lat);
        candidates.set(target.id, {
          port: target,
          drayageKm: edge.distanceKm,
          drayageMode: edge.mode,
          viaCorridor: edge.corridor,
          drayageCoords: edge.coords ?? null,
          border: borderPenalty(node.country, target.country),
          preferred: true,
          isHomePort,
          isRemoteAlternate: !isHomePort && edge.mode !== 'rail' && edge.distanceKm > 60,
          isQualified: true,
          score: gatewayRankScore(straightKm, target, isHomePort) - (edge.mode === 'rail' ? 40 : 0),
        });
      }
    }

    // 2. Nearby snapped maritime ports deduplicated by MARNET vertex
    const pool = [...candidates.values()];
    for (const port of ports) {
      if (candidates.has(port.id)) continue;
      const d = haversineKm(node.lon, node.lat, port.lon, port.lat);
      if (d <= maxDistanceKm) {
        const isHomePort =
          homePortIds.has(port.id) ||
          (port.id === node.id && Boolean(port.isCuratedPort || port.isHub));
        const isQualified = Boolean(
          isHomePort || port.isCuratedPort || port.isHub || port.isMajor
        );
        const crossCountryPenalty =
          node.country && port.country && node.country !== port.country ? 45 : 0;
        const score = gatewayRankScore(d, port, isHomePort) + crossCountryPenalty;
        pool.push({
          port,
          straightKm: +d.toFixed(1),
          drayageKm: port.id === node.id ? 0 : +(d * ROAD_CIRCUITY).toFixed(1),
          drayageMode: 'road',
          viaCorridor: null,
          drayageCoords: null,
          border: borderPenalty(node.country, port.country),
          preferred: isQualified,
          isHomePort,
          isRemoteAlternate: !isHomePort && d > 60,
          isQualified,
          score,
        });
      }
    }
    pool.sort((a, b) => a.score - b.score);

    const seenVertices = new Set();
    const out = [];

    for (const item of pool) {
      if (out.length >= limit) break;
      const vId = item.port.marnetVertexId;
      if (seenVertices.has(vId)) continue;
      // Skip specialized offshore petroleum platforms unless nothing else exists
      if (/petroleum|lpg|terminal/i.test(item.port.name_en) && !item.port.curated && out.length > 0) {
        continue;
      }
      // Skip non-qualified minor bulk/fishing ports when major/curated/hub gateways already exist
      if (out.some((c) => c.preferred) && !item.isQualified) {
        continue;
      }
      // Skip ports separated from the city by open sea (prevents over-water road drayage)
      if (!item.drayageCoords && !item.isHomePort && crossesOpenSea([node.lon, node.lat], [item.port.lon, item.port.lat])) {
        continue;
      }
      if (!item.drayageCoords && !item.isHomePort && item.straightKm >= 25 && graph.roadnet?.vertices?.length) {
        if (node.roadVertexId != null && item.port.roadVertexId != null) {
          if (graph.roadnet.vertices[node.roadVertexId].comp !== graph.roadnet.vertices[item.port.roadVertexId].comp) {
            continue;
          }
          const rp = findRoadPath(node, item.port, { maxRoadKm: maxDistanceKm * 2.6, includeGeometry: true });
          if (!rp) continue;
          item.drayageKm = rp.distanceKm;
          item.drayageCoords = rp.coords;
          item.border = rp.border;
        }
      }
      seenVertices.add(vId);
      out.push(item);
    }

    // 3. Multi-hop corridor fallback for landlocked inland cities/hubs (e.g. Kampala -> Mombasa)
    if (out.length === 0) {
      const corridorPorts = findCorridorPorts(node, 2400).sort((a, b) => a.score - b.score);
      for (const item of corridorPorts) {
        if (out.length >= 2) break;
        if (seenVertices.has(item.port.marnetVertexId)) continue;
        seenVertices.add(item.port.marnetVertexId);
        out.push(item);
      }
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
      const overland = fallback.filter(
        (item) => !crossesOpenSea([node.lon, node.lat], [item.port.lon, item.port.lat])
      );
      const chosenFallback = overland.length ? overland : fallback;
      for (const item of chosenFallback.slice(0, 2)) {
        out.push({
          port: item.port,
          drayageKm: +(item.drayageKm * ROAD_CIRCUITY).toFixed(1),
          drayageMode: 'road',
          viaCorridor: null,
          drayageCoords: null,
          border: borderPenalty(node.country, item.port.country),
          preferred: false,
          isHomePort: false,
          isRemoteAlternate: true,
        });
      }
    }

    return out;
  }

  function buildSeaCandidate(originNode, destNode, og, dg, pathResult, { includeGeometry, isPrimary }) {
    const legs = [];
    const legOptions = [];
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
          geometry: og.drayageCoords
            ? [...og.drayageCoords]
            : [
                [originNode.lon, originNode.lat],
                [og.port.lon, og.port.lat],
              ],
        }),
      });
      legOptions.push({
        isRemoteAlternate: Boolean(og.isRemoteAlternate),
        borderDays: og.border?.days ?? 0,
        borderCost: og.border?.cost ?? 0,
        reliabilityDrop: og.border?.reliabilityDrop ?? 0,
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
    legOptions.push({
      isSecondaryPort: portTierOf(dg.port) >= 3 && !dg.isHomePort && dg.port.id !== destNode.id,
      originPortTier: portTierOf(og.port),
      destPortTier: portTierOf(dg.port),
      isOriginHomePort: Boolean(og.isHomePort || og.port.id === originNode.id),
      isDestHomePort: Boolean(dg.isHomePort || dg.port.id === destNode.id),
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
          geometry: dg.drayageCoords
            ? [...dg.drayageCoords].reverse()
            : [
                [dg.port.lon, dg.port.lat],
                [destNode.lon, destNode.lat],
              ],
        }),
      });
      legOptions.push({
        isRemoteAlternate: Boolean(dg.isRemoteAlternate),
        borderDays: dg.border?.days ?? 0,
        borderCost: dg.border?.cost ?? 0,
        reliabilityDrop: dg.border?.reliabilityDrop ?? 0,
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

    const metrics = scoreRoute('sea', legs, {
      chokepointCount: chokepoints.length,
      legOptions,
    });
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
        a.candidate.metrics.costIndex - b.candidate.metrics.costIndex ||
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
