import { haversineKm } from './geo.mjs';
import { scoreRoute } from './cost-model.mjs';

export function createLandRouter(graph) {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map();

  for (const edge of graph.landEdges ?? []) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from).push(edge);
    if (edge.bidirectional) {
      if (!adj.has(edge.to)) adj.set(edge.to, []);
      adj.get(edge.to).push({
        ...edge,
        id: `${edge.id}:rev`,
        baseId: edge.id,
        from: edge.to,
        to: edge.from,
      });
    }
  }

  function dijkstraLand(startId, endId, avoidSet, penalizedEdges = new Map()) {
    const dist = new Map([[startId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = [{ id: startId, d: 0 }];

    while (queue.length > 0) {
      queue.sort((a, b) => a.d - b.d);
      const { id: u, d } = queue.shift();
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === endId) break;

      for (const edge of adj.get(u) ?? []) {
        if (visited.has(edge.to)) continue;
        if (avoidSet.has(edge.to) || avoidSet.has(edge.id) || avoidSet.has(edge.baseId)) continue;
        const factor = penalizedEdges.get(edge.baseId ?? edge.id) ?? 1;
        const nd = d + edge.distanceKm * factor;
        if (nd < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, nd);
          prev.set(edge.to, { from: u, edge });
          queue.push({ id: edge.to, d: nd });
        }
      }
    }

    if (!dist.has(endId)) return null;
    const edgeList = [];
    let curr = endId;
    while (curr !== startId) {
      const step = prev.get(curr);
      if (!step) return null;
      edgeList.push(step.edge);
      curr = step.from;
    }
    edgeList.reverse();
    return edgeList;
  }

  function buildLandCandidate(originNode, destNode, edgeList, { includeGeometry, isPrimary }) {
    const hasRail = edgeList.some((e) => e.mode === 'rail');
    const hasFerry = edgeList.some((e) => e.mode === 'sea');
    const primaryMode = hasRail ? 'rail' : 'road';
    const modeLabel = hasRail ? '铁路' : '公路';

    // Compress consecutive edges of the same mode/corridor group into readable legs, or keep distinct corridor legs
    const legs = [];
    const nodeSequence = [originNode.id];
    const chokepoints = [];
    const seenCp = new Set();

    for (const edge of edgeList) {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      nodeSequence.push(edge.to);
      if (
        (toNode?.type === 'rail_border' || toNode?.type === 'border' || toNode?.type === 'sea_area') &&
        !seenCp.has(toNode.id)
      ) {
        seenCp.add(toNode.id);
        chokepoints.push({
          id: toNode.id,
          name_zh: toNode.name_zh || toNode.id,
          name_en: toNode.name_en || toNode.id,
          major: false,
        });
      }

      const prevLeg = legs[legs.length - 1];
      if (prevLeg && prevLeg.mode === edge.mode && prevLeg.corridor === edge.corridor) {
        prevLeg.to = edge.to;
        prevLeg.toName = toNode?.name_zh || toNode?.name_en || edge.to;
        prevLeg.distanceKm = +(prevLeg.distanceKm + edge.distanceKm).toFixed(1);
        if (includeGeometry && toNode) {
          prevLeg.geometry.push([toNode.lon, toNode.lat]);
        }
      } else {
        legs.push({
          kind: edge.mode === 'road' && hasRail ? 'drayage' : 'trunk',
          mode: edge.mode,
          from: edge.from,
          fromName: fromNode?.name_zh || fromNode?.name_en || edge.from,
          to: edge.to,
          toName: toNode?.name_zh || toNode?.name_en || edge.to,
          corridor: edge.corridor,
          hasFerry: edge.mode === 'sea',
          distanceKm: +edge.distanceKm.toFixed(1),
          ...(includeGeometry && fromNode && toNode && {
            geometry: [
              [fromNode.lon, fromNode.lat],
              [toNode.lon, toNode.lat],
            ],
          }),
        });
      }
    }

    const metrics = scoreRoute(primaryMode, legs, { chokepointCount: chokepoints.length });
    const borders = chokepoints.map((c) => c.id).sort().join(',');
    const signature = `${primaryMode}:${originNode.id}:${destNode.id}:${borders}`;

    return {
      mode: primaryMode,
      modeLabel,
      likelihood: isPrimary ? 'primary' : 'alternative',
      originGateway: { id: originNode.id, name: originNode.name_zh || originNode.name_en, code: originNode.code ?? null },
      destGateway: { id: destNode.id, name: destNode.name_zh || destNode.name_en, code: destNode.code ?? null },
      chokepoints,
      nodeSequence,
      legs,
      metrics,
      signature,
    };
  }

  return function routeLand(originNode, destNode, { avoidSet = new Set(), includeGeometry = false, maxAlternatives = 4 } = {}) {
    const results = new Map();

    // Local same-city / cross-border direct road shortcut if within 250 km
    if (originNode.id === destNode.id) {
      const legs = [
        {
          kind: 'trunk',
          mode: 'local',
          from: originNode.id,
          fromName: originNode.name_zh || originNode.name_en,
          to: destNode.id,
          toName: destNode.name_zh || destNode.name_en,
          corridor: '本地配送',
          distanceKm: 25,
          ...(includeGeometry && {
            geometry: [
              [originNode.lon, originNode.lat],
              [destNode.lon, destNode.lat],
            ],
          }),
        },
      ];
      const metrics = scoreRoute('local', legs);
      return [
        {
          mode: 'local',
          modeLabel: '本地',
          likelihood: 'primary',
          originGateway: { id: originNode.id, name: originNode.name_zh || originNode.name_en, code: null },
          destGateway: { id: destNode.id, name: destNode.name_zh || destNode.name_en, code: null },
          chokepoints: [],
          nodeSequence: [originNode.id],
          legs,
          metrics,
          signature: `local:${originNode.id}`,
        },
      ];
    }

    // 1. K-shortest search on curated rail/road corridor network via iterative edge penalties
    const penalties = new Map();
    for (let k = 0; k < maxAlternatives; k++) {
      const edgeList = dijkstraLand(originNode.id, destNode.id, avoidSet, penalties);
      if (!edgeList) break;

      const candidate = buildLandCandidate(originNode, destNode, edgeList, {
        includeGeometry,
        isPrimary: k === 0,
      });
      if (!results.has(candidate.signature)) {
        results.set(candidate.signature, candidate);
      }

      // Penalize trunk rail/border/ferry edges (skip short road drayage so origins don't loop between nearby cities)
      for (const edge of edgeList) {
        if (edge.mode === 'road') continue;
        const key = edge.baseId ?? edge.id;
        const toNode = nodeById.get(edge.to);
        const weight = toNode?.type === 'rail_border' || toNode?.type === 'sea_area' ? 2.6 : 1.35;
        penalties.set(key, (penalties.get(key) ?? 1) * weight);
      }
    }

    // 2. Direct short-haul regional road if within 350 km and not already covered
    const directKm = haversineKm(originNode.lon, originNode.lat, destNode.lon, destNode.lat);
    if (directKm <= 350 && results.size === 0) {
      const legs = [
        {
          kind: 'trunk',
          mode: 'road',
          from: originNode.id,
          fromName: originNode.name_zh || originNode.name_en,
          to: destNode.id,
          toName: destNode.name_zh || destNode.name_en,
          corridor: '区域公路直达',
          distanceKm: +directKm.toFixed(1),
          ...(includeGeometry && {
            geometry: [
              [originNode.lon, originNode.lat],
              [destNode.lon, destNode.lat],
            ],
          }),
        },
      ];
      const metrics = scoreRoute('road', legs);
      const sig = `road:${originNode.id}:${destNode.id}:direct`;
      results.set(sig, {
        mode: 'road',
        modeLabel: '公路',
        likelihood: 'primary',
        originGateway: { id: originNode.id, name: originNode.name_zh || originNode.name_en, code: null },
        destGateway: { id: destNode.id, name: destNode.name_zh || destNode.name_en, code: null },
        chokepoints: [],
        nodeSequence: [originNode.id, destNode.id],
        legs,
        metrics,
        signature: sig,
      });
    }

    const list = [...results.values()].sort((a, b) => a.metrics.transitDays - b.metrics.transitDays);
    if (list.length > 0) {
      const bestDays = list[0].metrics.transitDays;
      for (let i = 0; i < list.length; i++) {
        list[i].likelihood = i === 0 || list[i].metrics.transitDays <= bestDays + 2.5 ? 'primary' : 'alternative';
      }
    }
    return list;
  };
}
